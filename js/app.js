import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { parseCustomizer, buildSource } from './customizer-parser.js';
import { createFastPreview } from './fast-preview/index.js';
import { ortho, NEAR, FAR } from './fast-preview/camera.js';

// Live preview always pays the full CGAL/Manifold boolean-evaluation cost (the
// wasm build only exposes the file-export pipeline, not OpenCSG's GPU-composited
// live view that desktop OpenSCAD's F5 preview uses), so the only real lever we
// have is capping segment count. Kept aggressive since it directly bounds how
// much polygon data every boolean op has to chew through.
const PREVIEW_FN_CAP = 30;

const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('export-btn');
const sidebar = document.getElementById('controls');
const viewerEl = document.getElementById('viewer');
const overlayEl = document.getElementById('viewer-overlay');
const overlayTextEl = document.getElementById('viewer-overlay-text');
const logOutput = document.getElementById('log-output');
const fastToggle = document.getElementById('fast-toggle');
const fastBadge = document.getElementById('fast-badge');
const fastCanvas = document.getElementById('fast-canvas');
const aboutBtn = document.getElementById('about-btn');
const aboutModal = document.getElementById('about-modal');
const aboutModalClose = document.getElementById('about-modal-close');

// ---------------------------------------------------------------------------
// Fast preview (GPU CSG): state + context
// ---------------------------------------------------------------------------
// Functions that drive this state live below (after the viewer section, which
// they depend on); the state itself is declared up here because the animate()
// loop starts running before those sections and must not hit a TDZ.
//
// The fast path is THE preview: it renders OpenSCAD's post-parse `.csg` node
// tree (a cheap dump: no geometry evaluation) through the fast-preview
// module's GPU CSG renderer (OpenCSG-style SCS/Goldfeather, GPL-2.0+; see
// js/fast-preview/), so parameter changes never pay the full Manifold/CGAL
// boolean evaluation (tens of seconds on the spool even at $fn=16). It is
// approximate by design; the accurate mesh render runs only on "Render &
// Export STL" (which also feeds the exported file). When the dump can't be
// served (unsupported node types, WebGL2 missing, dump/render error) the app
// falls back to the pre-fast-preview behavior -- a full mesh render per
// parameter commit -- with the badge explaining why.
const fastGl = fastCanvas.getContext('webgl2', {
  antialias: false,
  alpha: true,
  premultipliedAlpha: false,
  stencil: true,
  preserveDrawingBuffer: true, // the canvas is not re-rendered every frame
});
const FAST_SUPPORTED = Boolean(fastGl);

let fastPreview = null;       // module instance, created on first usable dump
let fastScene = null;         // { bounds } of the last applied dump
let fastCanvasOn = false;     // fast image currently displayed
let fastDumpActive = false;   // dump request in flight
let fastDumpQueued = false;   // another arrived while in flight (newest wins)
let fastBroken = false;       // fast path failed: legacy renders until re-armed
let fastViewDirty = false;    // camera moved since the last fast render
let commitGen = 0;            // bumped per request; stale results ignored
let lastDumpBytes = null;     // last good dump, for resize re-renders

function fastEnabled() {
  return FAST_SUPPORTED && fastToggle.checked;
}

function showFastBadge(text) {
  if (!FAST_SUPPORTED) return;
  fastBadge.textContent = text;
  fastBadge.hidden = !text;
}

if (!FAST_SUPPORTED) {
  fastToggle.disabled = true;
  fastToggle.checked = false;
  fastBadge.textContent = 'Fast preview needs WebGL2';
  fastBadge.hidden = false;
}

function setStatus(text, busy) {
  statusEl.textContent = text;
  overlayEl.hidden = !busy;
  if (busy) overlayTextEl.textContent = text;
}

// There's no real percentage progress available (OpenSCAD's wasm CLI doesn't
// expose one), so "progress" is an elapsed-time counter plus the last stage
// message the tool itself printed (e.g. "Compiling design (CSG Tree
// generation)...") -- an honest substitute for a progress bar.
let progressTimer = null;
let progressStart = 0;
let progressBaseLabel = '';
let progressLastStage = '';

function beginProgress(label) {
  progressBaseLabel = label;
  progressLastStage = '';
  progressStart = performance.now();
  overlayEl.hidden = false;
  renderProgress();
  clearInterval(progressTimer);
  progressTimer = setInterval(renderProgress, 200);
}

function renderProgress() {
  const elapsed = ((performance.now() - progressStart) / 1000).toFixed(1);
  const stageSuffix = progressLastStage ? ` — ${progressLastStage}` : '';
  const text = `${progressBaseLabel} (${elapsed}s)${stageSuffix}`;
  statusEl.textContent = text;
  overlayTextEl.textContent = text;
}

function noteProgressStage(text) {
  // OpenSCAD prints many chatty lines; keep only the short "stage" ones as the
  // headline and stash everything in the log panel regardless.
  if (text.length <= 80) progressLastStage = text;
  renderProgress();
}

function endProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
  return (performance.now() - progressStart) / 1000;
}

function appendLog(text) {
  if (!text) return;
  logOutput.textContent += text + '\n';
  logOutput.scrollTop = logOutput.scrollHeight;
}

function humanize(name) {
  const clean = name.replace(/^\$/, '');
  const spaced = clean.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Parse the model (injected server-side by index.php from the `scad` param)
// ---------------------------------------------------------------------------

const sourceText = window.__SCAD_SOURCE__ || '';
if (window.__SCAD_LOAD_ERROR__) {
  appendLog(`[server] ${window.__SCAD_LOAD_ERROR__}`);
}
if (window.__STL_LOAD_ERROR__) {
  appendLog(`[server] ${window.__STL_LOAD_ERROR__}`);
}

const parsed = parseCustomizer(sourceText);

const values = {};
for (const p of parsed.params) {
  values[p.name] = p.type === 'vector' ? p.defaultValue.slice() : p.defaultValue;
}

// ---------------------------------------------------------------------------
// Build the parameter UI
// ---------------------------------------------------------------------------

function buildRangeControl(param, container, onCommit) {
  const isVector = param.type === 'vector';
  const items = isVector ? param.defaultValue.length : 1;
  const wrap = document.createElement('div');
  wrap.className = 'control-vector';

  for (let idx = 0; idx < items; idx++) {
    const row = document.createElement('div');
    row.className = 'range-row';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(param.spec.min);
    range.max = String(param.spec.max);
    range.step = String(param.spec.step);
    range.value = String(isVector ? values[param.name][idx] : values[param.name]);

    const readout = document.createElement('span');
    readout.className = 'range-readout';
    readout.textContent = range.value;

    range.addEventListener('input', () => {
      readout.textContent = range.value;
      if (isVector) values[param.name][idx] = Number(range.value);
      else values[param.name] = Number(range.value);
      requestFastDump(); // live GPU CSG preview while dragging (no-op if disabled/fallback)
    });
    range.addEventListener('change', () => onCommit());

    row.appendChild(range);
    row.appendChild(readout);
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

function buildOptionsControl(param, container, onCommit) {
  const select = document.createElement('select');
  for (const opt of param.spec.options) {
    const option = document.createElement('option');
    option.value = String(opt.value);
    option.textContent = opt.label;
    if (opt.value === values[param.name]) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const match = param.spec.options.find((o) => String(o.value) === select.value);
    values[param.name] = match ? match.value : select.value;
    onCommit();
  });
  container.appendChild(select);
}

function buildBooleanControl(param, container, onCommit) {
  const label = document.createElement('label');
  label.className = 'checkbox-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(values[param.name]);
  input.addEventListener('change', () => {
    values[param.name] = input.checked;
    onCommit();
  });
  label.appendChild(input);
  label.appendChild(document.createTextNode(' Enabled'));
  container.appendChild(label);
}

function buildPlainNumberControl(param, container, onCommit) {
  const isVector = param.type === 'vector';
  const items = isVector ? param.defaultValue.length : 1;
  const wrap = document.createElement('div');
  wrap.className = 'control-vector';
  for (let idx = 0; idx < items; idx++) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(isVector ? values[param.name][idx] : values[param.name]);
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (isVector) values[param.name][idx] = n;
      else values[param.name] = n;
      onCommit();
    });
    wrap.appendChild(input);
  }
  container.appendChild(wrap);
}

function buildTextControl(param, container, onCommit) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = String(values[param.name]);
  input.addEventListener('change', () => {
    values[param.name] = input.value;
    onCommit();
  });
  container.appendChild(input);
}

function buildControl(param, onCommit) {
  const row = document.createElement('div');
  row.className = 'param-row';

  const label = document.createElement('label');
  label.textContent = param.description || humanize(param.name);
  label.title = param.name;
  row.appendChild(label);

  if (param.type === 'boolean') {
    buildBooleanControl(param, row, onCommit);
  } else if (param.spec && param.spec.kind === 'range') {
    buildRangeControl(param, row, onCommit);
  } else if (param.spec && param.spec.kind === 'options') {
    buildOptionsControl(param, row, onCommit);
  } else if (param.type === 'number' || param.type === 'vector') {
    buildPlainNumberControl(param, row, onCommit);
  } else {
    buildTextControl(param, row, onCommit);
  }

  return row;
}

function buildUI(onCommit) {
  sidebar.innerHTML = '';
  const groups = new Map();
  for (const p of parsed.params) {
    if (p.hidden) continue;
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  if (groups.size === 0) {
    const hint = document.createElement('p');
    hint.className = 'sidebar-hint';
    hint.textContent = 'No customizable parameters were found in this model.';
    sidebar.appendChild(hint);
    return;
  }
  for (const [groupName, params] of groups) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = groupName;
    fieldset.appendChild(legend);
    for (const p of params) {
      fieldset.appendChild(buildControl(p, onCommit));
    }
    sidebar.appendChild(fieldset);
  }
}

// ---------------------------------------------------------------------------
// three.js viewer
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b2f36);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
camera.position.set(120, 120, 120);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewerEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const modelGroup = new THREE.Group();
modelGroup.rotation.x = -Math.PI / 2; // STL is Z-up; three.js is Y-up.
scene.add(modelGroup);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(1, 2, 1.5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
fillLight.position.set(-1, -0.5, -1);
scene.add(fillLight);

const gridHelper = new THREE.GridHelper(400, 40, 0x555a63, 0x3c4048);
scene.add(gridHelper);

const material = new THREE.MeshStandardMaterial({ color: 0xff8a3d, metalness: 0.1, roughness: 0.6 });
const stlLoader = new STLLoader();
let currentMesh = null;
let firstRenderDone = false;

function resizeRenderer() {
  const w = viewerEl.clientWidth;
  const h = viewerEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeRenderer).observe(viewerEl);
resizeRenderer();

// The fast-preview canvas tracks the same element; debounce so a continuous
// resize doesn't rebuild the module on every tick.
let fastResizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(fastResizeTimer);
  fastResizeTimer = setTimeout(resizeFastPreview, 200);
}).observe(viewerEl);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  if (fastViewDirty && fastCanvasOn) {
    fastViewDirty = false;
    renderFastView(); // keep the GPU CSG image glued to the orbit camera
  }
}
animate();

// Orbit/zoom/pan all land here; the actual re-render happens once per frame
// in animate() so damping bursts don't queue redundant GPU CSG renders.
controls.addEventListener('change', () => {
  fastViewDirty = true;
});

function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxDim * 2;
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  camera.position.set(center.x + distance, center.y + distance * 0.8, center.z + distance);
  controls.target.copy(center);
  controls.update();
}

function updateMesh(stlBytes) {
  const geometry = stlLoader.parse(stlBytes.buffer);
  const triangleCount = geometry.attributes.position ? geometry.attributes.position.count / 3 : 0;
  if (triangleCount === 0) {
    setStatus('Render produced empty geometry (check parameters)', false);
    return;
  }
  geometry.computeVertexNormals();
  if (currentMesh) {
    modelGroup.remove(currentMesh);
    currentMesh.geometry.dispose();
  }
  currentMesh = new THREE.Mesh(geometry, material);
  modelGroup.add(currentMesh);
  if (!firstRenderDone) {
    fitCameraToObject(modelGroup);
    firstRenderDone = true;
  }
  // Accurate geometry just landed: it replaces any fast-preview image. The
  // badge survives when the fast path is broken (it explains the fallback);
  // otherwise whatever it said is outdated.
  setFastVisible(false);
  if (!fastBroken) showFastBadge('');
}

// ---------------------------------------------------------------------------
// Fast preview (GPU CSG): rendering + coalescing (state declared up top)
// ---------------------------------------------------------------------------

function fastCanvasSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return [
    Math.max(1, Math.round(viewerEl.clientWidth * dpr)),
    Math.max(1, Math.round(viewerEl.clientHeight * dpr)),
  ];
}

function setFastVisible(on) {
  fastCanvasOn = on;
  fastCanvas.style.display = on ? 'block' : 'none';
  // The mesh underneath is the LAST committed geometry -- wrong while
  // dragging, so hide it while the fast image is up.
  if (currentMesh) currentMesh.visible = !on;
}

// Every parameter commit funnels here: a fast dump when the fast path is
// healthy, otherwise the legacy accurate mesh render.
function parameterChanged() {
  if (fastEnabled() && !fastBroken) requestFastDump();
  else requestPreview();
}

// The fast path failed for good (unsupported geometry, render error): stick
// to legacy accurate renders for the rest of the session -- cycling the fast
// toggle re-tests it -- and render the current values immediately so the user
// isn't left with nothing (or a stale image) on screen.
function fastUnavailable(reason) {
  fastBroken = true;
  setFastVisible(false);
  showFastBadge(`Fast preview unavailable (${reason}) -- accurate renders on change`);
  appendLog(`[fast-preview] falling back: ${reason}`);
  requestPreview();
}

// Coalesced like requestPreview: at most one dump in flight, and the newest
// request replaces whatever was queued. Dumps run on the same serialized
// worker as mesh renders, so a drag that starts mid-render waits it out.
function requestFastDump() {
  if (!fastEnabled() || fastBroken) return;
  commitGen++; // newest dump request wins; older in-flight results are dropped
  if (fastDumpActive) {
    fastDumpQueued = true;
    return;
  }
  fastDumpActive = true;
  const genAtSend = commitGen;
  send(previewSource(), 'csg')
    .then((bytes) => {
      // A newer commit landed since this dump was requested: a fresher render
      // already covers it, so don't paint the stale dump over it.
      if (genAtSend === commitGen && !fastBroken && fastEnabled()) {
        applyFastDump(bytes);
      }
    })
    .catch((err) => fastUnavailable(err.message || 'dump failed'))
    .finally(() => {
      fastDumpActive = false;
      if (fastDumpQueued) {
        fastDumpQueued = false;
        requestFastDump();
      }
    });
}

function applyFastDump(bytes) {
  lastDumpBytes = bytes;
  try {
    if (!fastPreview) {
      const [w, h] = fastCanvasSize();
      fastCanvas.width = w;
      fastCanvas.height = h;
      fastPreview = createFastPreview(fastGl, { width: w, height: h });
    }
    const result = fastPreview.update(new TextDecoder().decode(bytes));
    // unsupported/skipped must win over empty: a tree of only-unsupported
    // nodes (hull(), text(), …) has no leaves, but that's a fallback case,
    // not legitimately empty geometry.
    if (result.unsupported.length > 0 || result.skipped.length > 0) {
      fastUnavailable(result.unsupported.length > 0
        ? `needs ${result.unsupported.join(', ')}`
        : 'contains geometry the GPU path cannot composite');
      return;
    }
    if (result.empty) {
      // Legitimately empty geometry at these parameters -- not a fast-path
      // failure. Show nothing and stay in fast mode for the next commit.
      setFastVisible(false);
      setStatus('Ready (fast preview: empty geometry)', false);
      return;
    }
    fastScene = { bounds: result.bounds };
    showFastBadge('');
    if (!firstRenderDone) {
      firstRenderDone = true;
      fitCameraToFastBounds(result.bounds);
    }
    setFastVisible(true);
    renderFastView();
    setStatus('Ready (fast preview)', false);
  } catch (err) {
    fastUnavailable(err.message || 'render failed');
  }
}

// Re-render the fast scene under the current three.js camera. The module
// consumes geometry pre-transformed into its own frame (camera looking along
// -z, model inside a fixed depth slab [NEAR, FAR]), so the camera's rotation
// is baked into the leaf positions: the transform chains the modelGroup's
// Z-up rotation, the camera view, and a scale/translate S that centers the
// orbit target and matches the perspective frustum's half-height at the
// target distance (so orbit dolly/pan translate into zoom/pan). x/y and z
// are scaled independently (see below) -- the ortho window follows the
// module's fitTransform convention (half=2, margin=1.05).
function renderFastView() {
  if (!fastPreview || !fastScene) return;
  const v = camera.matrixWorldInverse.elements; // world -> view (camera -z)
  const d = camera.position.distanceTo(controls.target);
  const halfHWorld = Math.tan((camera.fov * Math.PI) / 360) * d;

  // model z-range in view space, to keep it inside the depth slab.
  // Bounds are in MODEL space; the group carries the Z-up->Y-up rotation,
  // so the corners must go through V o M, not V alone.
  const vm = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, modelGroup.matrixWorld).elements;
  const [x0, y0, z0, x1, y1, z1] = fastScene.bounds;
  let zmin = Infinity, zmax = -Infinity;
  for (const cx of [x0, x1]) {
    for (const cy of [y0, y1]) {
      for (const cz of [z0, z1]) {
        const z = vm[2] * cx + vm[6] * cy + vm[10] * cz + vm[14];
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
      }
    }
  }

  const xh = 2.0 * 1.05;
  const yh = (xh * fastCanvas.height) / fastCanvas.width;
  const t = controls.target;
  const tx = v[0] * t.x + v[4] * t.y + v[8] * t.z + v[12];
  const ty = v[1] * t.x + v[5] * t.y + v[9] * t.z + v[13];
  // x/y MUST track the perspective frustum unconditionally -- it's what
  // keeps the fast image glued to the real camera. z only needs to land
  // inside the [NEAR, FAR] slab for the renderer's depth precision, which is
  // an unrelated constraint: clamping x/y to it too (via a shared min-scale)
  // used to shrink the whole model around the orbit target once zoomed in
  // close enough for the depth range to bind first, which reads as the model
  // floating off the build plate. Scale z independently instead.
  const sZoom = yh / Math.max(halfHWorld, 1e-9);
  const sDepth = (FAR - NEAR - 1.0) / Math.max(zmax - zmin, 1e-6);

  // S: scale x/y by sZoom (orbit target centered), z by sDepth (mid-slab)
  const S = new THREE.Matrix4().set(
    sZoom, 0, 0, -sZoom * tx,
    0, sZoom, 0, -sZoom * ty,
    0, 0, sDepth, -sDepth * (zmin + zmax) / 2 - (NEAR + FAR) / 2,
    0, 0, 0, 1,
  );
  const full = new THREE.Matrix4().multiplyMatrices(S, camera.matrixWorldInverse)
    .multiply(modelGroup.matrixWorld);
  // Debug hooks for the fast-preview flicker investigation (docs/
  // fast-preview-chromium-flicker.md) — active only with ?fastdebug=1.
  const onProduct = window.__FAST_ONPRODUCT__ || undefined;
  fastPreview.renderTransformed(full.elements, ortho(-xh, xh, -yh, yh, NEAR, FAR), { onProduct });
}

// Initial camera framing from fast-preview bounds: the accurate mesh render
// that used to position the camera no longer runs at load. Bounds are in
// MODEL space, so the group's Z-up->Y-up rotation must be applied first.
function fitCameraToFastBounds(b) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const box = new THREE.Box3();
  for (const cx of [x0, x1]) {
    for (const cy of [y0, y1]) {
      for (const cz of [z0, z1]) {
        box.expandByPoint(new THREE.Vector3(cx, cy, cz).applyMatrix4(modelGroup.matrixWorld));
      }
    }
  }
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxDim * 2;
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  camera.position.set(center.x + distance, center.y + distance * 0.8, center.z + distance);
  controls.target.copy(center);
  controls.update();
  camera.updateMatrixWorld(); // renderFastView reads matrixWorldInverse synchronously
}

function resizeFastPreview() {
  if (!fastPreview) return;
  const [w, h] = fastCanvasSize();
  if (w === fastCanvas.width && h === fastCanvas.height) return;
  fastCanvas.width = w;
  fastCanvas.height = h;
  fastPreview = null; // rebuilt (and re-rendered) from the last good dump
  fastScene = null;
  if (lastDumpBytes && fastCanvasOn) applyFastDump(lastDumpBytes);
}

// ---------------------------------------------------------------------------
// Render worker plumbing
// ---------------------------------------------------------------------------

// A single worker/instance is kept alive for the whole session -- the wasm
// module takes seconds to compile, so tearing it down on every parameter
// tweak (to "cancel" a stale render) would make things far slower, not
// faster. Since a running callMain() can't actually be interrupted, we
// instead coalesce: at most one render is in flight, and at most one more is
// queued behind it (the newest one -- anything superseded while queued is
// simply dropped and replaced).
const worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
let idCounter = 0;
const pending = new Map();
let activeRender = null; // { id, mode }
let queuedPreview = null; // { source } -- always the newest, replaces itself

worker.onerror = (event) => {
  setStatus(`Worker error: ${event.message}`, false);
  appendLog(`[worker error] ${event.message} (${event.filename}:${event.lineno})`);
};
worker.onmessageerror = () => {
  setStatus('Worker message error', false);
};
worker.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'progress') {
    const entry = pending.get(msg.id);
    if (entry && entry.mode === 'csg') {
      return; // dump chatter during drags: keep it out of the log and progress UI
    }
    appendLog(`[${msg.kind}] ${msg.text}`);
    noteProgressStage(msg.text);
    return;
  }

  // msg.type === 'result'
  const { id, ok, stl, csg, error } = msg;
  const entry = pending.get(id);
  pending.delete(id);
  if (activeRender && activeRender.id === id) activeRender = null;

  if (entry) {
    // csg-mode requests resolve with the dump bytes instead of STL bytes;
    // consumers are keyed by the mode they sent.
    if (ok) entry.resolve(csg !== undefined ? csg : stl);
    else entry.reject(new Error(error));
  }

  if (queuedPreview !== null) {
    const next = queuedPreview;
    queuedPreview = null;
    runPreview(next.source);
  }
};

function send(source, mode) {
  const id = ++idCounter;
  activeRender = { id, mode };
  return new Promise((resolve, reject) => {
    pending.set(id, { mode, resolve, reject });
    worker.postMessage({ id, source, mode });
  });
}

function previewSource() {
  const overrides = {};
  if (Object.prototype.hasOwnProperty.call(values, '$fn')) {
    overrides['$fn'] = Math.min(Number(values['$fn']) || PREVIEW_FN_CAP, PREVIEW_FN_CAP);
  }
  // $preview mirrors OpenSCAD's own special variable: models that branch on it
  // (e.g. `if ($preview) simplify(); else full_detail();`) get cheaper geometry
  // for free during live preview, same as they would in the desktop app.
  return `$preview = true;\n${buildSource(parsed, values, overrides)}`;
}

function exportSource() {
  return `$preview = false;\n${buildSource(parsed, values)}`;
}

function runPreview(source) {
  beginProgress('Rendering preview…');
  send(source, 'preview')
    .then((stl) => {
      const elapsed = endProgress();
      setStatus(`Ready (rendered in ${elapsed.toFixed(1)}s)`, false);
      updateMesh(stl);
    })
    .catch((err) => {
      endProgress();
      setStatus(`Render error: ${err.message}`, false);
    });
}

// Legacy path (fast preview unavailable or toggled off): an accurate mesh
// render per parameter commit. We never interrupt a render already running
// against the shared instance -- only one render can be queued behind it,
// and a newer commit simply replaces whatever was queued (nothing piles up).
function requestPreview() {
  // A commit supersedes any queued fast dump: the mesh render covers it.
  commitGen++;
  fastDumpQueued = false;
  const source = previewSource();
  if (activeRender) {
    queuedPreview = { source };
    return;
  }
  runPreview(source);
}

async function handleExport() {
  exportBtn.disabled = true;
  commitGen++; // in-flight dumps are stale once the accurate render lands
  beginProgress('Rendering full-resolution STL for export…');
  try {
    const stl = await send(exportSource(), 'export');
    const elapsed = endProgress();
    updateMesh(stl);
    downloadSTL(stl);
    setStatus(`STL exported (rendered in ${elapsed.toFixed(1)}s)`, false);
  } catch (err) {
    endProgress();
    setStatus(`Export failed: ${err.message}`, false);
  } finally {
    exportBtn.disabled = false;
  }
}

function downloadSTL(stlBytes) {
  const blob = new Blob([stlBytes], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'model.stl';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------------------
// Wire it up
// ---------------------------------------------------------------------------

buildUI(parameterChanged);
exportBtn.addEventListener('click', handleExport);
exportBtn.disabled = false;

aboutBtn.addEventListener('click', () => {
  aboutModal.hidden = false;
});
aboutModalClose.addEventListener('click', () => {
  aboutModal.hidden = true;
});
aboutModal.addEventListener('click', (event) => {
  if (event.target === aboutModal) aboutModal.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !aboutModal.hidden) aboutModal.hidden = true;
});

fastToggle.addEventListener('change', () => {
  fastDumpQueued = false;
  fastBroken = false; // cycling the toggle re-tests the fast path
  if (!fastEnabled()) {
    setFastVisible(false);
    showFastBadge('');
    requestPreview(); // fast off: accurate mesh now, and legacy behavior onward
    return;
  }
  requestFastDump(); // toggled on: render the current values immediately
});

// A precomputed STL (the `stl` query param on index.php) shows instantly
// instead of a blank viewport, with no render triggered and no busy splash --
// it's shown as-is, which may not exactly match the current parameter values
// if it was computed for different ones. It just sits there as the starting
// point until the user actually changes something.
const precomputedStlBase64 = window.__PRECOMPUTED_STL_BASE64__;
let showedPrecomputed = false;
if (precomputedStlBase64) {
  try {
    updateMesh(base64ToUint8Array(precomputedStlBase64));
    setStatus('Precomputed STL preview', false);
    showedPrecomputed = true;
  } catch (err) {
    appendLog(`[client] Failed to load precomputed STL: ${err.message}`);
  }
}

if (!showedPrecomputed) {
  parameterChanged(); // fast dump when possible; legacy render otherwise
}

// Debug export for the fast-preview flicker investigation (docs/
// fast-preview-chromium-flicker.md) — active only with ?fastdebug=1.
if (new URLSearchParams(location.search).has('fastdebug')) {
  window.__FAST_ONPRODUCT__ = null; // assignable from the CDP harness
  window.__DEBUG__ = {
    camera, controls, modelGroup, renderFastView, fastGl,
    lastDumpBytes: () => lastDumpBytes,
    get fastPreview() { return fastPreview; },
    get fastScene() { return fastScene; },
    ortho, NEAR, FAR,
    THREE: (await import('three')),
  };
}
