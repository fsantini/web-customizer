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

async function render(id, source, onProgress) {
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
  const { id, source } = event.data;
  const onProgress = (kind, text) => self.postMessage({ type: 'progress', id, kind, text });
  queue = queue.then(async () => {
    const result = await render(id, source, onProgress);
    if (result.ok) {
      self.postMessage({ type: 'result', ...result }, [result.stl.buffer]);
    } else {
      self.postMessage({ type: 'result', ...result });
    }
  });
};
