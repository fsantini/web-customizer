import { createOpenSCAD } from 'https://cdn.jsdelivr.net/npm/openscad-wasm-prebuilt@1.2.0/dist/openscad.js';

// Confirmed empirically: calling callMain() twice on the same OpenSCAD
// instance fails almost instantly on the second call (no output file is even
// produced), so every render needs a fresh instance. That instantiation
// (decoding + compiling an ~11MB wasm binary) costs several seconds on its
// own, on top of the actual geometry work.
//
// To hide that cost as much as possible, we don't wait until a render is
// requested to start it: as soon as one instance is *consumed*, we
// immediately start compiling the next one in the background. As long as the
// user's next parameter change comes in more than ~15-20s after the last
// render finished, the next instance is already warm and ready.
let currentOnProgress = () => {};
let nextInstancePromise = null;

function warmNextInstance() {
  nextInstancePromise = createOpenSCAD({
    print: (text) => currentOnProgress('out', text),
    printErr: (text) => currentOnProgress('err', text),
  })
    .then((api) => api.getInstance())
    .catch((err) => {
      nextInstancePromise = null;
      throw err;
    });
}
warmNextInstance();

function readOutputIfPresent(instance) {
  try {
    const stat = instance.FS.stat('/output.stl');
    if (!stat || stat.size === 0) return null;
    const stl = instance.FS.readFile('/output.stl');
    const copy = new Uint8Array(stl.length);
    copy.set(stl);
    return copy;
  } catch {
    return null;
  }
}

// Fast-preview dump mode: OpenSCAD's post-parse node tree (`-o /output.csg`)
// with all parameters resolved, returned as UTF-8 bytes. Writing the dump
// skips all geometry evaluation (~20 ms vs ~20 s of boolean evaluation for
// the STL at $fn=16), which is what makes the GPU CSG preview in js/fast-
// preview/ viable during slider drags.
function readOutputTextIfPresent(instance) {
  try {
    const stat = instance.FS.stat('/output.csg');
    if (!stat || stat.size === 0) return null;
    const csg = instance.FS.readFile('/output.csg');
    const copy = new Uint8Array(csg.length);
    copy.set(csg);
    return copy;
  } catch {
    return null;
  }
}

async function render(id, source, onProgress, mode) {
  currentOnProgress = onProgress;
  if (!nextInstancePromise) warmNextInstance();
  const instancePromise = nextInstancePromise;
  nextInstancePromise = null; // this instance is being claimed for this render

  let instance;
  try {
    instance = await instancePromise;
  } catch (err) {
    warmNextInstance();
    return { id, ok: false, error: `Failed to start OpenSCAD: ${err.message || err}` };
  }

  instance.FS.writeFile('/input.scad', source);

  // mode 'csg' (fast-preview dump): a dump-only call. The STL call below is
  // deliberately untouched -- adding a second `-o` flag there was probed and
  // measurably perturbs the STL bytes, which must stay identical.
  if (mode === 'csg') {
    let dumpError = null;
    try {
      const exitCode = instance.callMain(['/input.scad', '--enable=manifold', '-o', '/output.csg']);
      if (exitCode !== 0) dumpError = new Error(`OpenSCAD exited with code ${exitCode}`);
    } catch (err) {
      dumpError = err;
    }
    // This instance is spent regardless of outcome.
    warmNextInstance();
    const csg = readOutputTextIfPresent(instance);
    if (csg) return { id, ok: true, csg };
    return {
      id,
      ok: false,
      error: dumpError && dumpError.message
        ? dumpError.message
        : dumpError !== null
          ? `OpenSCAD failed (${dumpError})`
          : 'OpenSCAD produced no output file',
    };
  }

  let callMainError = null;
  try {
    const exitCode = instance.callMain(['/input.scad', '--enable=manifold', '-o', '/output.stl']);
    if (exitCode !== 0) callMainError = new Error(`OpenSCAD exited with code ${exitCode}`);
  } catch (err) {
    callMainError = err;
  }

  const stl = readOutputIfPresent(instance);

  // This instance is spent regardless of outcome -- start warming the next
  // one right away so it's ready before the next request arrives.
  warmNextInstance();

  if (stl) return { id, ok: true, stl };

  const message =
    callMainError && callMainError.message
      ? callMainError.message
      : callMainError !== null
        ? `OpenSCAD failed (${callMainError})`
        : 'OpenSCAD produced no output file';
  return { id, ok: false, error: message };
}

// Renders are serialized: only one render claims an instance at a time.
let queue = Promise.resolve();

self.onmessage = (event) => {
  const { id, source, mode } = event.data; // mode: 'stl' (default) | 'csg'
  const onProgress = (kind, text) => self.postMessage({ type: 'progress', id, kind, text });
  queue = queue.then(async () => {
    const result = await render(id, source, onProgress, mode);
    const transfer = [];
    if (result.stl) transfer.push(result.stl.buffer);
    if (result.csg) transfer.push(result.csg.buffer);
    self.postMessage({ type: 'result', ...result }, transfer);
  });
};
