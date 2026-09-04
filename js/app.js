import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { parseCustomizer, buildSource } from './customizer-parser.js';

// Live preview always pays the full CGAL/Manifold boolean-evaluation cost (the
// wasm build only exposes the file-export pipeline, not OpenCSG's GPU-composited
// live view that desktop OpenSCAD's F5 preview uses), so the only real lever we
// have is capping segment count. Kept aggressive since it directly bounds how
// much polygon data every boolean op has to chew through.
const PREVIEW_FN_CAP = 16;

const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('export-btn');
const sidebar = document.getElementById('controls');
const viewerEl = document.getElementById('viewer');
const overlayEl = document.getElementById('viewer-overlay');
const overlayTextEl = document.getElementById('viewer-overlay-text');
const logOutput = document.getElementById('log-output');

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

// ---------------------------------------------------------------------------
// Parse the embedded model
// ---------------------------------------------------------------------------

const sourceEl = document.getElementById('scad-source');
const sourceText = sourceEl.textContent.replace(/^\n/, '');
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

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

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
    appendLog(`[${msg.kind}] ${msg.text}`);
    noteProgressStage(msg.text);
    return;
  }

  // msg.type === 'result'
  const { id, ok, stl, error } = msg;
  const entry = pending.get(id);
  pending.delete(id);
  if (activeRender && activeRender.id === id) activeRender = null;

  if (entry) {
    if (ok) entry.resolve(stl);
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
    worker.postMessage({ id, source });
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

// A new parameter commit always wants the latest values on screen, but we
// never interrupt a render already running against the shared instance --
// only one render can be queued behind it, and a newer commit simply
// replaces whatever was queued (nothing piles up).
function requestPreview() {
  const source = previewSource();
  if (activeRender) {
    queuedPreview = { source };
    return;
  }
  runPreview(source);
}

async function handleExport() {
  exportBtn.disabled = true;
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

buildUI(requestPreview);
exportBtn.addEventListener('click', handleExport);
exportBtn.disabled = false;
requestPreview();
