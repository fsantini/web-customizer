// SCS (Sequenced Convex Subtraction) renderer for WebGL2 — module form of
// the phase-0 prototype (phase0/csg-proto.html), itself a port of
// OpenCSG's renderSCS.cpp (© Florian Kirsch, HPI; GPL-2.0-or-later).
//
// Product dispatch (normalize.js):
//   'convex'      → renderProductSCS (below)
//   'plain'       → renderProductPlain (nearest surface, any closed mesh)
//   'goldfeather' → renderProductGoldfeather: multi-leaf products with
//                   non-convex leaves. Algorithmically derived from OpenCSG's
//                   Goldfeather path (renderGoldfeather.cpp, same authors/
//                   license), restructured around the parity principle: a
//                   candidate fragment (intersectee front faces, subtrahend
//                   back faces) is on the product surface iff the point just
//                   behind it is inside every intersectee (odd face crossing
//                   count) and outside every subtrahend (even count); the
//                   surface is the nearest valid candidate. Candidates are
//                   enumerated nearest-first by depth peeling, and the first
//                   valid layer claims the pixel. (The reference's
//                   draw-order stencil layers are replaced by depth peeling
//                   and its per-shape stencil parity bits by additive
//                   per-leaf counting — same predicate, shader-side, so it
//                   is immune to the SwiftShader depth-test quirks below.)
//
// All GL state flows through GLState (see gl-state.js).
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

import {
  GLState, DepthFunc, CullFace, StencilFunc, StencilOp,
} from './gl-state.js';

const VS_MESH = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform mat4 uMVP;
uniform mat3 uNrmMat;
out vec3 vNrm;
void main(){
  vNrm = uNrmMat * aNrm;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FS_MESH = `#version 300 es
precision highp float;
in vec3 vNrm;
uniform vec4 uColor;
layout(location=0) out vec4 fragColor;
layout(location=1) out float fragDepthOut;
void main(){
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(0.35, 0.5, 0.8));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float diff = abs(dot(n, L));
  vec3 c = uColor.rgb * (0.38 + 0.62 * diff);
  vec3 Hv = normalize(L + V);
  c += 0.22 * pow(abs(dot(n, Hv)), 40.0);
  fragColor = vec4(c, uColor.a);
  fragDepthOut = gl_FragCoord.z;
}`;

const FS_SOLIDMESH = `#version 300 es
precision highp float;
uniform vec4 uColor;
layout(location=0) out vec4 fragColor;
layout(location=1) out float fragDepthOut;
void main(){
  fragColor = uColor;
  fragDepthOut = gl_FragCoord.z;
}`;

// Through-hole invalidation (renderIntersectedBack): erase where the
// intersectee's back face is IN FRONT of the stored surface. The reference
// (renderSCS.cpp:681) expresses this as fixed-function GL_LESS with
// depthMask(false); this port evaluates the same predicate in the shader
// (discard unless gl_FragCoord.z < stored) because SwiftShader mis-evaluates
// the fixed-function depth test in this configuration early in a context's
// life (see test/diag-passes.html). The stored depth is read from the
// target's DEPTH24_STENCIL8 texture — the invalidation draw has the depth
// test disabled and writes no depth, so sampling it is loop-free.
// Through-hole invalidation fragment shader (renderIntersectedBack). The
// predicate runs shader-side because the fixed-function depth test
// mis-evaluates on SwiftShader early in a context's life; semantics are
// identical to the reference's GL_LESS + depthMask(false): erase where the
// intersectee's back face is in front of the stored surface, write color
// ONLY (depth is preserved, as in the reference). The stored surface depth
// is read from the R32F mirror (attachment1) — NOT from the DEPTH24_STENCIL8
// texture: SwiftShader returns zeros when sampling a DS texture, even
// unattached (verified by probe), so DS sampling is unusable.
const FS_INVAL = `#version 300 es
precision highp float;
// samplers default to lowp in GLSL ES fragment shaders; NVIDIA GLES drivers
// honor that (fp16), which corrupts exact depth comparisons (stripes)
precision highp sampler2D;
uniform sampler2D uDepthStore;
uniform vec4 uColor;
layout(location=0) out vec4 fragColor;
void main(){
  float stored = texelFetch(uDepthStore, ivec2(gl_FragCoord.xy), 0).r;
  if (!(gl_FragCoord.z < stored)) discard;
  fragColor = uColor;
}`;

const VS_QUAD = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_SOLID = `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform float uDepthOut;
layout(location=0) out vec4 fragColor;
layout(location=1) out float fragDepthOut;
void main(){
  fragColor = uColor;
  fragDepthOut = uDepthOut;
}`;

// nearest-wins accumulate step for the iterative composite: merges one more
// product into the running (color, depth) pair; scales to any product count.
// DNF normalization legitimately produces overlapping products for the same
// physical surface (e.g. a subtracted compound like halftorus() expands into
// several negation factors, each unioned back with the same outer branches),
// so many products can validly claim the exact same pixel at nearly the same
// depth. SCS and Goldfeather compute that depth via unrelated GPU
// algorithms, so their results agree to many digits but not bit-for-bit, and
// "nearest wins" resolves ties per pixel. ACCUM_EPS would make near-ties
// keep whichever product accumulated first; an epsilon here was tried
// against the Chromium banding and had no effect (see
// docs/fast-preview-chromium-flicker.md — the real cause was the GLSL ES
// lowp sampler default, which fp16-quantizes R32F reads on NVIDIA drivers;
// fixed with 'precision highp sampler2D' in every depth-sampling shader), so
// it stays 0.0.
const ACCUM_EPS = '0.0';
const FS_ACCUM = `#version 300 es
precision highp float;
precision highp sampler2D;  // lowp default would fp16-round R32F depths
uniform sampler2D uAccC;
uniform sampler2D uAccD;
uniform sampler2D uNewC;
uniform sampler2D uNewD;
layout(location=0) out vec4 fragC;
layout(location=1) out float fragD;
void main(){
  ivec2 uv = ivec2(gl_FragCoord.xy);
  vec4 acc = texelFetch(uAccC, uv, 0);
  float accD = texelFetch(uAccD, uv, 0).r;
  vec4 nc = texelFetch(uNewC, uv, 0);
  float nd = texelFetch(uNewD, uv, 0).r;
  bool hasAcc = acc.a > 0.75, hasNew = nc.a > 0.75;
  bool takeNew = hasNew && (!hasAcc || nd < accD - ${ACCUM_EPS});
  fragC = takeNew ? vec4(nc.rgb, 1.0) : vec4(acc.rgb, hasAcc ? 1.0 : 0.0);
  fragD = takeNew ? nd : accD;
}`;

// ---- Goldfeather path (non-convex leaves) --------------------------------
// Depth-peel candidate layer: candidates are intersectee FRONT faces and
// subtrahend BACK faces (set by the caller's cull mode). Fragments at or in
// front of the previous layer's winner are discarded; fixed-function LEQUAL
// picks the nearest survivor, whose z is mirrored to attachment1 for the
// count/peel chain. Shading matches FS_MESH so the composite looks uniform.
const FS_PEEL = `#version 300 es
precision highp float;
precision highp sampler2D;  // lowp default would fp16-round R32F depths
in vec3 vNrm;
uniform sampler2D uPrevZ;
uniform vec4 uColor;
layout(location=0) out vec4 fragColor;
layout(location=1) out float fragDepthOut;
void main(){
  float prevZ = texelFetch(uPrevZ, ivec2(gl_FragCoord.xy), 0).r;
  if (gl_FragCoord.z <= prevZ) discard;
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(0.35, 0.5, 0.8));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float diff = abs(dot(n, L));
  vec3 c = uColor.rgb * (0.38 + 0.62 * diff);
  vec3 Hv = normalize(L + V);
  c += 0.22 * pow(abs(dot(n, Hv)), 40.0);
  fragColor = vec4(c, uColor.a);
  fragDepthOut = gl_FragCoord.z;
}`;

// Parity counter: one additive unit per face strictly behind the current peel
// winner (uRefZ). Blended ONE/ONE into an RGBA16F channel — one leaf per
// channel, 4 leaves per texture (see renderProductGoldfeather).
//
// "Strictly behind" is a bare `> refZ` comparison (CNT_EPS left at 0.0). At
// hole-cutter rims a candidate and a near-tangent wall crossing of another
// leaf can land within float noise of each other (observed gaps of
// 4e-6..3e-5 window depth), so a small epsilon here was tried against the
// Chromium banding; a full epsilon matrix showed no effect on the artifact
// (docs/fast-preview-chromium-flicker.md — the cause was the GLSL ES lowp
// sampler default, fp16-quantizing the R32F reads). The ~0.2% residual
// knife-edge pixels where CPU and GPU parity
// disagree on coincident surfaces are documented there too.
const CNT_EPS = '0.0';
const FS_COUNT = `#version 300 es
precision highp float;
precision highp sampler2D;  // lowp default would fp16-round R32F depths
uniform sampler2D uRefZ;
layout(location=0) out vec4 fragCount;
void main(){
  float refZ = texelFetch(uRefZ, ivec2(gl_FragCoord.xy), 0).r;
  if (gl_FragCoord.z <= refZ + ${CNT_EPS}) discard;
  fragCount = vec4(1.0);
}`;

// Goldfeather merge (first-valid-wins), CHUNKED: the peel fragment is on the
// product surface iff every intersectee has an ODD face count strictly behind
// it (point just behind is inside) and every subtrahend an EVEN count
// (outside). mod(c,2) is exact — counts are small exact integers in fp16.
// A product may have far more leaves than one merge shader can sample
// (spool top plate: 55), so validity is computed per chunk of count textures
// and ANDed across passes through an R8 chain; only the last pass touches
// the accumulator and claims the pixel. Chunk size is chosen at runtime so
// sampler use stays within MAX_TEXTURE_IMAGE_UNITS.
function gfMergeSrc({ chunk, isFirst, isLast }) {
  // SwiftShader rejects sampler arrays indexed by loop variables ("array
  // index for samplers must be constant integral expressions"), so the
  // per-texture fetches and per-leaf parity checks are unrolled with literal
  // sampler names and swizzles at shader-compile time.
  const comp = ['x', 'y', 'z', 'w'];
  let fetches = '';
  let checks = '';
  for (let t = 0; t < chunk; t++) {
    fetches += `    vec4 c${t} = texelFetch(uCnt${t}, uv, 0);\n`;
    for (let c = 0; c < 4; c++) {
      const leaf = t * 4 + c;
      checks += `    if (valid && uBase + ${leaf} < uNLeaves) {
      bool wantOdd = uBase + ${leaf} < uNI;   // intersectees: inside → odd
      if (wantOdd != (mod(c${t}.${comp[c]}, 2.0) > 0.5)) valid = false;
    }
`;
    }
  }
  const cntDecls = Array.from({ length: chunk }, (_, t) => `uniform sampler2D uCnt${t};`).join('\n');
  return `#version 300 es
precision highp float;
precision highp sampler2D;  // lowp default would fp16-round R32F depths
uniform sampler2D uPeelD;
${cntDecls}
uniform int uBase;
uniform int uNI;
uniform int uNLeaves;
${isFirst ? '' : 'uniform sampler2D uValidIn;'}
${isLast
    ? `uniform sampler2D uAccC;
uniform sampler2D uAccD;
uniform sampler2D uPeelC;
layout(location=0) out vec4 fragC;
layout(location=1) out float fragD;`
    : 'layout(location=0) out float fragV;'}
void main(){
  ivec2 uv = ivec2(gl_FragCoord.xy);
  bool valid = ${isFirst ? 'true' : 'texelFetch(uValidIn, uv, 0).r > 0.5'};
  if (valid) {
${fetches}${checks}  }
${isLast
    ? `  vec4 acc = texelFetch(uAccC, uv, 0);
  float accD = texelFetch(uAccD, uv, 0).r;
  vec4 pc = texelFetch(uPeelC, uv, 0);
  bool hasAcc = acc.a > 0.75;
  bool take = valid && pc.a > 0.75 && !hasAcc;
  fragC = take ? vec4(pc.rgb, 1.0) : vec4(acc.rgb, hasAcc ? 1.0 : 0.0);
  fragD = take ? texelFetch(uPeelD, uv, 0).r : accD;`
    : '  fragV = valid ? 1.0 : 0.0;'}
}`;
}

// final Goldfeather copy: claimed acc → product target (color + depth)
const FS_GFCOPY = `#version 300 es
precision highp float;
precision highp sampler2D;  // lowp default would fp16-round R32F depths
uniform sampler2D uSrcC;
uniform sampler2D uSrcD;
layout(location=0) out vec4 fragC;
layout(location=1) out float fragD;
void main(){
  ivec2 uv = ivec2(gl_FragCoord.xy);
  fragC = texelFetch(uSrcC, uv, 0);
  fragD = texelFetch(uSrcD, uv, 0).r;
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function makeProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const o = { p, u: {} };
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    o.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return o;
}

// Schoenfield sequencer (OpenCSG sequencer.h): subtraction visit order.
// n=1 → [0]; n=2 → [0,1,0]; else n²−2n+4 visits.
export function schoenfield(n) {
  const size = n === 1 ? 1 : n === 2 ? 3 : n * n - 2 * n + 4;
  const seq = [];
  for (let pos = 0; pos < size; pos++) {
    let idx;
    if (n === 1) idx = 0;
    else if (n === 2) idx = pos & 1;
    else if (pos < n) idx = pos;
    else if ((pos - 1) % (n - 1) === 0) idx = 0;
    else idx = (Math.floor(pos * (n - 2) / (n - 1)) % (n - 1)) + 1;
    seq.push(idx);
  }
  return seq;
}

export class SCSRenderer {
  constructor(gl, { width, height }) {
    this.gl = gl;
    // The depth-mirror and intersection targets attach an R32F texture as a
    // color attachment, which is only renderable once this extension is
    // activated on the context (idempotent; null on WebGL1, which we reject
    // earlier anyway).
    gl.getExtension('EXT_color_buffer_float');
    this.W = width;
    this.H = height;
    this.st = new GLState(gl);
    this.progMesh = makeProgram(gl, VS_MESH, FS_MESH);
    this.progSolidMesh = makeProgram(gl, VS_MESH, FS_SOLIDMESH);
    this.progInval = makeProgram(gl, VS_MESH, FS_INVAL);
    this.progQuad = makeProgram(gl, VS_QUAD, FS_SOLID);
    this.progAccum = makeProgram(gl, VS_QUAD, FS_ACCUM);
    this.progPeel = makeProgram(gl, VS_MESH, FS_PEEL);
    this.progCount = makeProgram(gl, VS_MESH, FS_COUNT);
    this.progCopy2 = makeProgram(gl, VS_QUAD, FS_GFCOPY);
    this._vao = gl.createVertexArray();
    this._leafGPU = new Map(); // leaf index → {vao, count}
    this._leafXings = new Map(); // leaf index → {front, back} max ray-grid crossings
    this._leafCovs = new Map();  // leaf index → quarter-res coverage bitmask
    this._gf = null;           // lazy Goldfeather scratch (peel/acc targets, count FBOs)
    this._gfMergeProgs = new Map(); // 'chunk|isFirst|isLast' → program
    this._maxChunk = 0;        // count textures per merge pass (sampler budget)
    this.proj = null;          // set via setProjection
    this.bg = [0.055, 0.065, 0.08];
    this.alphaSolid = 1.0;
    this.alphaEmpty = 0.5;
    this.skipped = [];         // indices of products that could not be rendered
  }

  setProjection(m) { this.proj = m; }

  uploadLeaves(leaves) {
    const gl = this.gl;
    for (let i = 0; i < leaves.length; i++) {
      if (this._leafGPU.has(i)) continue;
      const pos = leaves[i].positions;
      const nTri = pos.length / 9;
      const nrm = new Float32Array(pos.length);
      for (let t = 0; t < nTri; t++) {
        const o = t * 9;
        const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
        const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (let v = 0; v < 3; v++) {
          nrm[o + v * 3] = nx; nrm[o + v * 3 + 1] = ny; nrm[o + v * 3 + 2] = nz;
        }
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pb);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const nb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, nb);
      gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this._leafGPU.set(i, { vao, pb, nb, count: pos.length / 3 });
    }
  }

  // Drop every per-leaf cache: GPU buffers, ray-crossing bounds, coverage
  // masks. All of these are keyed by leaf index ONLY, so a caller that
  // renders new geometry at the same indices (the interactive front-end
  // re-renders on every parameter change / camera move) must call this
  // first — stale entries would silently render the previous model.
  resetLeafCaches() {
    const gl = this.gl;
    for (const { vao, pb, nb } of this._leafGPU.values()) {
      gl.deleteBuffer(pb);
      gl.deleteBuffer(nb);
      gl.deleteVertexArray(vao);
    }
    this._leafGPU.clear();
    this._leafXings.clear();
    this._leafCovs.clear();
  }

  _makeTarget() {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    const depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, this.W, this.H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depthTex, 0);
    const ds = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, ds);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH24_STENCIL8, this.W, this.H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, ds, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete');
    // erase twin FBO (color attachment0 only): used for the through-hole
    // invalidation, which SAMPLES the R32F depth mirror (attachment1). The
    // erase must write color ONLY (reference preserves depth), so attachment1
    // is deliberately not attached here — writing into `fb` while sampling
    // its attachment1 would also be a feedback loop.
    const fbInval = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbInval);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete (inval)');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, fbInval, colorTex, depthTex, dsTex: ds };
  }

  _drawLeaf(prog, gpu, color, alpha) {
    const st = this.st, gl = this.gl;
    st.useProgram(prog.p);
    // leaves are pre-transformed to world space: model = identity
    gl.uniformMatrix4fv(prog.u.uMVP, false, this.proj || this._identity4());
    gl.uniformMatrix3fv(prog.u.uNrmMat, false, this._identity3());
    gl.uniform4f(prog.u.uColor, color[0], color[1], color[2], alpha);
    gl.bindVertexArray(gpu.vao);
    gl.drawArrays(gl.TRIANGLES, 0, gpu.count);
    gl.bindVertexArray(null);
  }

  _identity4() {
    if (!this._id4) {
      this._id4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }
    return this._id4;
  }
  _identity3() {
    if (!this._id3) {
      this._id3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
    return this._id3;
  }

  _clear() {
    const st = this.st, gl = this.gl;
    st.depthMask(true);
    st.colorMask(true, true, true, true);
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], this.alphaEmpty);
    gl.clearDepth(0.0);                    // "at the near plane" — SCS convention
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }

  _color(leaf) {
    return leaf.color ? [leaf.color[0], leaf.color[1], leaf.color[2]] : [0.68, 0.72, 0.78];
  }

  // ---- SCS product (all leaves convex) — port of renderSCS() -------------
  // onPass(name), if given, is invoked with the target still bound after each
  // algorithm stage ('cleared', 'front', 'sub<i>A/B', 'invalidated') — used by
  // the validation harness to bisect GPU-side divergences.
  renderProductSCS(target, product, leaves, onPass = null) {
    const st = this.st, gl = this.gl;
    const inter = product.intersectees;
    const sub = product.subtrahends;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    st.viewport(0, 0, this.W, this.H);
    st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    st.depthTest(true);
    st.depthFunc(DepthFunc.LESS);
    st.depthMask(true);
    gl.disable(gl.BLEND);
    this._clear();
    if (onPass) onPass('cleared');
    if (inter.length === 0) return;

    // renderIntersectedFront (renderSCS.cpp:420)
    if (inter.length === 1) {
      st.depthFunc(DepthFunc.GREATER);
      st.cull(CullFace.BACK);
      this._drawLeaf(this.progMesh, this._leafGPU.get(inter[0]),
        this._color(leaves[inter[0]]), this.alphaSolid);
      st.cull(null);
      st.depthFunc(DepthFunc.LESS);
    } else {
      st.depthFunc(DepthFunc.GREATER);
      st.cull(CullFace.BACK);
      for (const idx of inter) {
        this._drawLeaf(this.progMesh, this._leafGPU.get(idx),
          this._color(leaves[idx]), this.alphaSolid);
      }
      // counting pass: back faces beyond the front surface
      st.colorMask(false, false, false, false);
      st.stencilMask(0xff);
      st.stencilFunc(StencilFunc.ALWAYS, 0, 0xff);
      st.stencilOp(StencilOp.KEEP, StencilOp.KEEP, StencilOp.INCR);
      st.stencil(true);
      st.depthMask(false);
      st.cull(CullFace.FRONT);
      for (const idx of inter) {
        this._drawLeaf(this.progMesh, this._leafGPU.get(idx),
          this._color(leaves[idx]), this.alphaSolid);
      }
      // reset where count != k — color writes MUST be re-enabled FIRST
      // (the phase-0 bug: OpenCSG's renderToChannel(true) does this implicitly)
      st.colorMask(true, true, true, true);
      st.stencilFunc(StencilFunc.NOTEQUAL, inter.length, 0xff);
      st.stencilOp(StencilOp.ZERO, StencilOp.ZERO, StencilOp.ZERO);
      st.depthFunc(DepthFunc.ALWAYS);
      st.depthRange(0, 0);
      st.depthMask(true);
      st.cull(null);
      st.useProgram(this.progQuad.p);
      gl.uniform4f(this.progQuad.u.uColor, this.bg[0], this.bg[1], this.bg[2], this.alphaEmpty);
      gl.uniform1f(this.progQuad.u.uDepthOut, 0.0);
      gl.bindVertexArray(this._vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      st.depthRange(0, 1);
      st.depthFunc(DepthFunc.LESS);
      st.stencil(false);
    }
    if (onPass) onPass('front');

    // subtractPrimitives (renderSCS.cpp:490). Subtrahends are clustered by
    // screen coverage (see _subClusters): each cluster runs its own
    // Schoenfield sequence; the stencil ref keeps increasing across clusters
    // so refs stay unique and never alias.
    if (sub.length > 0) {
      let stencilref = 0;
      st.stencil(true);
      st.stencilMask(0xff);
      for (const cluster of this._subClusters(sub, leaves)) {
        const seq = schoenfield(cluster.length);
        for (const ci of seq) {
        const idx = sub[cluster[ci]];
        const gpu = this._leafGPU.get(idx);
        const col = this._color(leaves[idx]);
        ++stencilref;
        // pass A: mark where subtrahend's front face is nearer than surface
        st.colorMask(false, false, false, false);
        st.depthMask(false);
        st.stencilFunc(StencilFunc.ALWAYS, stencilref, 0xff);
        st.stencilOp(StencilOp.KEEP, StencilOp.KEEP, StencilOp.REPLACE);
        st.depthFunc(DepthFunc.LESS);
        st.cull(CullFace.BACK);
        this._drawLeaf(this.progMesh, gpu, col, this.alphaSolid);
        if (onPass) onPass(`sub${idx}a`);
        // pass B: marked pixels — cavity wall becomes the surface
        st.colorMask(true, true, true, true);
        st.depthFunc(DepthFunc.GREATER);
        st.depthMask(true);
        st.cull(CullFace.FRONT);
        st.stencilFunc(StencilFunc.EQUAL, stencilref, 0xff);
        st.stencilOp(StencilOp.ZERO, StencilOp.ZERO, StencilOp.ZERO);
        this._drawLeaf(this.progMesh, gpu, col, this.alphaSolid);
        if (onPass) onPass(`sub${idx}b`);
        }
      }
      st.stencil(false);
      st.cull(null);
      st.depthFunc(DepthFunc.LESS);
    }

    // renderIntersectedBack (renderSCS.cpp:681): through-hole invalidation —
    // reference: cull FRONT, GL_LESS, depthMask(false), erase color. Here the
    // predicate runs shader-side (see FS_INVAL): depth comes from the R32F
    // mirror (attachment1), and the draw goes to target.fbInval (attachment0
    // only) so the erase writes color ONLY and nothing is both sampled and
    // written.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbInval);
    st.drawBuffers([gl.COLOR_ATTACHMENT0]);
    st.depthMask(false);
    st.depthTest(false);
    st.useProgram(this.progInval.p);
    gl.uniformMatrix4fv(this.progInval.u.uMVP, false, this.proj || this._identity4());
    gl.uniformMatrix3fv(this.progInval.u.uNrmMat, false, this._identity3());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.depthTex);
    gl.uniform1i(this.progInval.u.uDepthStore, 0);
    st.cull(CullFace.FRONT);
    for (const idx of inter) {
      const gpu = this._leafGPU.get(idx);
      gl.uniform4f(this.progInval.u.uColor, this.bg[0], this.bg[1], this.bg[2], this.alphaEmpty);
      gl.bindVertexArray(gpu.vao);
      gl.drawArrays(gl.TRIANGLES, 0, gpu.count);
    }
    gl.bindVertexArray(null);
    st.depthTest(true);
    st.depthMask(true);
    st.cull(null);
    if (onPass) onPass('invalidated');
  }

  // lone product (single intersectee, no subtrahends): plain nearest-surface
  // render — correct for ANY closed mesh, including non-convex leaves.
  // NOTE: standard depth convention here (clear to 1.0, GL_LESS) — NOT the
  // SCS cleared-to-0 convention.
  renderProductPlain(target, product, leaves) {
    const st = this.st, gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    st.viewport(0, 0, this.W, this.H);
    st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    st.depthTest(true);
    st.depthFunc(DepthFunc.LESS);
    st.depthMask(true);
    gl.disable(gl.BLEND);
    st.colorMask(true, true, true, true);
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], this.alphaEmpty);
    gl.clearDepth(1.0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    const idx = product.intersectees[0];
    this._drawLeaf(this.progMesh, this._leafGPU.get(idx),
      this._color(leaves[idx]), this.alphaSolid);
    st.reset();
  }

  // ---- Goldfeather product (any leaf may be non-convex) -------------------
  // Derived from OpenCSG's renderGoldfeather.cpp (same authors and license),
  // restructured around the parity principle: candidate fragments are
  // intersectee FRONT faces and subtrahend BACK faces; a candidate is on the
  // product surface iff the point just behind it is inside every intersectee
  // (odd face-crossing count along the view ray) and outside every
  // subtrahend (even count). Candidates are enumerated nearest-first by depth
  // peeling and the first valid layer claims the pixel. The reference's
  // draw-order stencil layers become peel layers; its per-shape stencil
  // parity bits become additive per-leaf counting (RGBA16F, 4 leaves per
  // texture); its fixed-function depth tricks run shader-side, like FS_INVAL,
  // because SwiftShader mis-evaluates them in this context.
  // Returns false (target untouched; caller reports a skip) for products with
  // more leaves than the chunked merge can sample (MAX_TEXTURE_IMAGE_UNITS
  // budget; see gfMergeSrc) — the caller reports a skip for a fallback.
  renderProductGoldfeather(target, product, leaves, onPass = null) {
    const st = this.st, gl = this.gl;
    const inter = product.intersectees, sub = product.subtrahends;
    const nLeaves = inter.length + sub.length;
    if (nLeaves === 0) return false;
    const roles = [];
    for (const idx of inter) roles.push({ idx, isI: true });
    for (const idx of sub) roles.push({ idx, isI: false });
    // count channels: 4 leaves per RGBA16F texture; the merge ANDs parity
    // over chunked passes so sampler use stays within MAX_TEXTURE_IMAGE_UNITS
    const nTex = Math.ceil(nLeaves / 4);
    const chunk = this._maxChunkTex();
    if (chunk < 1) return false;
    const gf = this._gfScratch(nTex);
    const P = gf.peel, A = gf.acc, C = gf.cnt, V = gf.valid;

    // Layer cap: candidates along a view ray are bounded by the face
    // crossings of the leaves actually present at that pixel — sum each
    // leaf's max per-pixel crossings over its exact screen coverage and take
    // the worst pixel (see _gfLayerCap), plus one slack layer.
    const K = this._gfLayerCap(roles, leaves);

    // layer 1's peel must see prevZ = 0 everywhere; acc pair starts empty
    // (clearTexImage is GL 4.4/ES 3.1 — not WebGL2 core — so the R32F mirror
    // is cleared through a scratch FBO instead)
    this._clearTexR(P[0].depthTex, 0);
    this._clearTexR(P[1].depthTex, 0);
    this._clearTarget(A[0]);
    this._clearTarget(A[1]);

    let accFinal = A[0];
    for (let layer = 1, pi = 0, ai = 0; layer <= K; layer++, pi = 1 - pi, ai = 1 - ai) {
      // (a) peel: nearest surviving candidates beyond the previous winner
      gl.bindFramebuffer(gl.FRAMEBUFFER, P[pi].fb);
      st.viewport(0, 0, this.W, this.H);
      st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      st.depthTest(true);
      st.depthFunc(DepthFunc.LEQUAL);
      st.depthMask(true);
      st.colorMask(true, true, true, true);
      st.cull(null);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1.0);
      gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      // (CA1 therefore clears to 0.0: pixels whose enumeration exhausts get
      // re-enumerated by later layers — correct but redundant, since any
      // valid candidate was already claimed. SwiftShader rejects
      // clearBufferfv on drawbuffer 1, so the cheaper clear-to-1 is not
      // available here. Verified diag-gf T2, err 1281.)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, P[1 - pi].depthTex);
      st.useProgram(this.progPeel.p);
      gl.uniform1i(this.progPeel.u.uPrevZ, 0);
      for (const r of roles) {
        st.cull(r.isI ? CullFace.BACK : CullFace.FRONT);
        this._drawLeaf(this.progPeel, this._leafGPU.get(r.idx),
          this._color(leaves[r.idx]), this.alphaSolid);
      }
      st.cull(null);

      // (b) parity counts: faces STRICTLY BEHIND this layer's winner, per
      // leaf, accumulated additively into RGBA16F channels (4 per texture)
      st.depthTest(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.clearColor(0, 0, 0, 0);
      for (let t = 0; t < nTex; t++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, C[t].fb);
        st.drawBuffers([gl.COLOR_ATTACHMENT0]);
        st.colorMask(true, true, true, true);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, P[pi].depthTex);
      // progCount shares the mesh vertex stage, so it needs the projection
      // set explicitly — a default (zero) uMVP collapses every vertex into
      // the clip origin and the count pass rasterizes nothing (diag-gf).
      st.useProgram(this.progCount.p);
      gl.uniform1i(this.progCount.u.uRefZ, 0);
      gl.uniformMatrix4fv(this.progCount.u.uMVP, false, this.proj || this._identity4());
      gl.uniformMatrix3fv(this.progCount.u.uNrmMat, false, this._identity3());
      for (let j = 0; j < roles.length; j++) {
        const on = [false, false, false, false];
        on[j & 3] = true;
        st.colorMask(on[0], on[1], on[2], on[3]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, C[j >> 2].fb);
        st.drawBuffers([gl.COLOR_ATTACHMENT0]);
        st.cull(null);
        const gpu = this._leafGPU.get(roles[j].idx);
        gl.bindVertexArray(gpu.vao);
        gl.drawArrays(gl.TRIANGLES, 0, gpu.count);
      }
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      st.colorMask(true, true, true, true);

      // (c) merge: first valid layer claims the pixel (peeling is
      // nearest-first, so "first valid" is "nearest valid"). Chunked parity
      // passes ANDed through the R8 chain; the last pass claims.
      const dst = A[1 - ai];
      let vSrc = 0;
      for (let texFrom = 0; texFrom < nTex;) {
        const nHere = Math.min(chunk, nTex - texFrom);
        const isFirst = texFrom === 0;
        const isLast = texFrom + nHere >= nTex;
        const prog = this._gfMergeProg(nHere, isFirst, isLast);
        gl.bindFramebuffer(gl.FRAMEBUFFER,
          isLast ? dst.fb : V[1 - vSrc].fb);
        st.viewport(0, 0, this.W, this.H);
        st.drawBuffers(isLast
          ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]
          : [gl.COLOR_ATTACHMENT0]);
        st.depthTest(false);
        st.cull(null);
        st.colorMask(true, true, true, true);
        gl.disable(gl.BLEND);
        st.useProgram(prog.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, P[pi].depthTex);
        gl.uniform1i(prog.u.uPeelD, 0);
        for (let t = 0; t < nHere; t++) {
          gl.activeTexture(gl.TEXTURE1 + t);
          gl.bindTexture(gl.TEXTURE_2D, C[texFrom + t].tex);
          gl.uniform1i(prog.u[`uCnt${t}`], 1 + t);
        }
        let unit = 1 + nHere;
        if (!isFirst) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, V[vSrc].tex);
          gl.uniform1i(prog.u.uValidIn, unit);
          unit++;
        }
        if (isLast) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, A[ai].colorTex);
          gl.uniform1i(prog.u.uAccC, unit);
          unit++;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, A[ai].depthTex);
          gl.uniform1i(prog.u.uAccD, unit);
          unit++;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, P[pi].colorTex);
          gl.uniform1i(prog.u.uPeelC, unit);
        }
        gl.uniform1i(prog.u.uBase, texFrom * 4);
        gl.uniform1i(prog.u.uNI, inter.length);
        gl.uniform1i(prog.u.uNLeaves, nLeaves);
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        if (!isLast) vSrc = 1 - vSrc;
        texFrom += nHere;
      }
      accFinal = dst;
      if (onPass) onPass(`layer${layer}`);
    }

    // (d) copy the claimed surface into the product target
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    st.depthTest(false);
    st.cull(null);
    st.colorMask(true, true, true, true);
    st.useProgram(this.progCopy2.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accFinal.colorTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, accFinal.depthTex);
    gl.uniform1i(this.progCopy2.u.uSrcC, 0);
    gl.uniform1i(this.progCopy2.u.uSrcD, 1);
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    st.reset();
    return true;
  }

  // lazy shared Goldfeather scratch: two peel targets (ping-pong: read prev
  // layer's z while writing this layer's), two acc targets (ping-pong), a
  // growable array of RGBA16F count textures (4 parity channels each), and
  // two R8 validity targets for the chunked merge chain
  _gfScratch(nTex) {
    if (!this._gf) {
      this._gf = {
        peel: [this._makeTarget(), this._makeTarget()],
        acc: [this._makeTarget(), this._makeTarget()],
        cnt: [],
        valid: [this._makeValidTarget(), this._makeValidTarget()],
      };
    }
    while (this._gf.cnt.length < nTex) this._gf.cnt.push(this._makeCnt());
    return this._gf;
  }

  // count textures per merge pass: accC/accD/peelC/peelD + uValidIn + slack
  // must fit alongside the chunk in the fragment-shader sampler budget
  _maxChunkTex() {
    if (!this._maxChunk) {
      const gl = this.gl;
      this._maxChunk = Math.max(1,
        gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) - 6);
    }
    return this._maxChunk;
  }

  _gfMergeProg(nTex, isFirst, isLast) {
    const key = `${nTex}|${isFirst}|${isLast}`;
    let prog = this._gfMergeProgs.get(key);
    if (!prog) {
      prog = makeProgram(this.gl, VS_QUAD,
        gfMergeSrc({ chunk: nTex, isFirst, isLast }));
      this._gfMergeProgs.set(key, prog);
    }
    return prog;
  }

  // single-attachment R8 target for the chunked merge validity chain
  _makeValidTarget() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, this.W, this.H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete (valid)');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }

  // clear a single-channel R32F texture to 0 or 1 (WebGL2 has no
  // clearTexImage; route through a scratch FBO). drawbuffer 0 is
  // unambiguous: the scratch FBO has exactly one attachment.
  //
  // SwiftShader rejects gl.clearBufferfv on float attachments with
  // GL_INVALID_VALUE (1281) — the clear silently does nothing (verified:
  // FRAMEBUFFER_COMPLETE, error 1281, content unchanged; plain gl.clear
  // works). Clear through the fixed-function path instead. colorMask goes
  // through the tracker so its cache stays in sync.
  _clearTexR(tex, value) {
    const gl = this.gl, st = this.st;
    if (!this._texClearFb) this._texClearFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._texClearFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, tex, 0);
    st.colorMask(true, true, true, true);
    gl.clearColor(value ? 1 : 0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _makeCnt() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, this.W, this.H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete (cnt)');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }

  // Max face crossings of a leaf along axis-aligned view rays (camera looks
  // along -z; leaves are pre-transformed to camera space, so a ray is just a
  // fixed (x, y) with varying z). A 24×24 grid over the leaf's XY bbox bounds
  // the candidate count per pixel; parity is insensitive to ±2 grazing hits
  // at shared edges, and overcounting only wastes peel layers, never
  // correctness. Cached per leaf index.
  _leafCrossings(idx, leaves) {
    if (this._leafXings.has(idx)) return this._leafXings.get(idx);
    const pos = leaves[idx].positions;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const GX = 24, GY = 24;
    let maxFront = 0, maxBack = 0;
    const nTri = pos.length / 9;
    for (let gy = 0; gy < GY; gy++) {
      const y = minY + (gy + 0.5) * (maxY - minY) / GY;
      for (let gx = 0; gx < GX; gx++) {
        const x = minX + (gx + 0.5) * (maxX - minX) / GX;
        let f = 0, b = 0;
        for (let t = 0; t < nTri; t++) {
          const o = t * 9;
          const x1 = pos[o], y1 = pos[o + 1];
          const x2 = pos[o + 3], y2 = pos[o + 4];
          const x3 = pos[o + 6], y3 = pos[o + 7];
          const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
          if (d > -1e-12 && d < 1e-12) continue; // edge-on to the ray
          const a = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d;
          const b2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d;
          if (a < 0 || b2 < 0 || a + b2 > 1) continue;
          const nz = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
          if (nz > 0) f++; else b++;
        }
        if (f > maxFront) maxFront = f;
        if (b > maxBack) maxBack = b;
      }
    }
    const r = { front: maxFront, back: maxBack };
    this._leafXings.set(idx, r);
    return r;
  }

  // Goldfeather peel-layer cap. A pixel's candidate count is the crossings
  // of the leaves whose fragments actually cover it — so the cap is the
  // worst-pixel sum of each leaf's max per-pixel crossings (the 24×24
  // ray-grid bound) over that leaf's exact screen coverage, plus one slack
  // layer. The naive Σ-over-leaves bound is catastrophically loose (it adds
  // maxima that occur at mutually exclusive pixels: 165 layers for the
  // spool's plate product vs ~20 here).
  _gfLayerCap(roles, leaves) {
    const W = this.W;
    const sum = new Uint32Array(W * this.H);
    let best = 0;
    for (const r of roles) {
      const x = this._leafCrossings(r.idx, leaves)[r.isI ? 'front' : 'back'];
      if (!x) continue;
      const cov = this._leafCoverage(r.idx, leaves);
      for (let j = cov.j0; j <= cov.j1; j++) {
        const row = j * cov.words;
        for (let wi = 0; wi < cov.words; wi++) {
          let m = cov.bits[row + wi];
          while (m) {
            const b = 31 - Math.clz32(m & -m);
            sum[j * W + wi * 32 + b] += x;
            m &= m - 1;
          }
        }
      }
    }
    for (let px = 0; px < sum.length; px++) if (sum[px] > best) best = sum[px];
    return 1 + best;
  }

  // Screen-space coverage bitmask of a leaf, bit-packed at full res. A
  // fragment exists iff the GPU's sample point (the pixel center) lands
  // inside a triangle, so sampling each scanline's exact triangle
  // cross-section reproduces the fragment pixel set (up to fp noise at
  // shared edges) — tight enough to keep disjoint geometry disjoint, which
  // the clustering below relies on for correctness. Cached per leaf index
  // (leaves are fixed per index once uploaded; the projection per renderer).
  _leafCoverage(idx, leaves) {
    let cov = this._leafCovs.get(idx);
    if (cov) return cov;
    const W = this.W, H = this.H;
    const words = (W + 31) >> 5;
    const bits = new Uint32Array(words * H);
    const pos = leaves[idx].positions;
    const p = this.proj || this._identity4();
    const sx = new Float32Array(3), sy = new Float32Array(3);
    let bi0 = W, bi1 = -1, bj0 = H, bj1 = -1;
    for (let t = 0; t < pos.length; t += 9) {
      for (let v = 0; v < 3; v++) {
        const o = t + v * 3;
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        const cw = p[3] * x + p[7] * y + p[11] * z + p[15] || 1;
        sx[v] = ((p[0] * x + p[4] * y + p[8] * z + p[12]) / cw * 0.5 + 0.5) * W;
        sy[v] = ((p[1] * x + p[5] * y + p[9] * z + p[13]) / cw * 0.5 + 0.5) * H;
      }
      const j0 = Math.max(0, Math.ceil(Math.min(sy[0], sy[1], sy[2]) - 0.5));
      const j1 = Math.min(H - 1, Math.floor(Math.max(sy[0], sy[1], sy[2]) - 0.5));
      const tx0 = Math.max(0, Math.ceil(Math.min(sx[0], sx[1], sx[2]) - 0.5));
      const tx1 = Math.min(W - 1, Math.floor(Math.max(sx[0], sx[1], sx[2]) - 0.5));
      if (tx0 < bi0) bi0 = tx0; if (tx1 > bi1) bi1 = tx1;
      if (j0 < bj0) bj0 = j0; if (j1 > bj1) bj1 = j1;
      for (let j = j0; j <= j1; j++) {
        const y = j + 0.5;
        // cross-section of the triangle with the scanline: collect the x of
        // each edge that spans y (half-open to avoid vertex double-count)
        let xa = Infinity, xb = -Infinity;
        for (let e = 0; e < 3; e++) {
          const f = e, g = (e + 1) % 3;
          const y1 = sy[f], y2 = sy[g];
          if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
            const x = sx[f] + (y - y1) / (y2 - y1) * (sx[g] - sx[f]);
            if (x < xa) xa = x;
            if (x > xb) xb = x;
          }
        }
        if (xa > xb) continue;
        const iA = Math.max(0, Math.ceil(xa - 0.5));
        const iB = Math.min(W - 1, Math.floor(xb - 0.5));
        for (let i = iA; i <= iB; i++) bits[j * words + (i >> 5)] |= 1 << (i & 31);
      }
    }
    cov = { words, i0: bi0, i1: bi1, j0: bj0, j1: bj1, bits };
    this._leafCovs.set(idx, cov);
    return cov;
  }

  // Group subtrahends into clusters whose A/B passes may share pixels. An
  // SCS subtract visit touches pixels inside its subtrahend's projected
  // coverage only (pass A marks stencil there, pass B writes depth there);
  // two subtrahends with disjoint coverages therefore cannot interact —
  // neither through the depth test nor through the stencil buffer (refs are
  // unique and never compared across visits) — so each cluster can run its
  // own Schoenfield sequence independently. Clusters are grown conservatively
  // by coverage overlap, which only ever merges, never splits: soundness
  // needs "may interact ⊆ same cluster", and over-merging costs only passes.
  // This keeps the n² visit count local to interacting groups: the spool's
  // plate (50 vents + bore + torus + hole) drops from 2812 visits to ~60.
  _subClusters(sub, leaves) {
    const covs = sub.map((idx) => this._leafCoverage(idx, leaves));
    const parent = sub.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    for (let i = 0; i < sub.length; i++) {
      for (let j = i + 1; j < sub.length; j++) {
        if (find(i) === find(j)) continue;
        const a = covs[i], b = covs[j];
        if (a.i0 > b.i1 || b.i0 > a.i1 || a.j0 > b.j1 || b.j0 > a.j1) continue;
        let overlap = false;
        for (let jj = Math.max(a.j0, b.j0); jj <= Math.min(a.j1, b.j1) && !overlap; jj++) {
          const ra = a.bits, rb = b.bits;
          const c0 = Math.max(a.i0, b.i0), c1 = Math.min(a.i1, b.i1);
          const w0 = c0 >> 5, w1 = c1 >> 5;
          const rowA = jj * a.words, rowB = jj * b.words;
          for (let ww = w0; ww <= w1; ww++) {
            let m = ra[rowA + ww] & rb[rowB + ww];
            if (ww === w0) m &= ~((1 << (c0 & 31)) - 1);
            if (ww === w1) m &= (1 << ((c1 & 31) + 1)) - 1 || 0xffffffff;
            if (m) { overlap = true; break; }
          }
        }
        if (overlap) parent[find(j)] = find(i);
      }
    }
    const groups = new Map();
    for (let i = 0; i < sub.length; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i); // local index into sub
    }
    return [...groups.values()];
  }

  // product that could not be rendered (unsupported leaf count or class):
  // leave EMPTY, report.
  renderProductSkipped(target) {
    const st = this.st, gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    st.viewport(0, 0, this.W, this.H);
    st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    st.depthTest(true);
    st.depthFunc(DepthFunc.LESS);
    st.depthMask(true);
    this._clear();
    st.reset();
  }

  // ---- scene --------------------------------------------------------------
  // Products are rendered in bounded batches (each target ≈ 12 bytes/px, so
  // 265 spool products × 480×330 would need GBs if all targets stayed live);
  // after each batch every product is composited into a ping-pong accumulator
  // and its target freed. onProduct(product, target, index) is invoked before
  // the target is released — the validation harness uses it for readbacks.
  renderScene(leaves, products, outTarget = null, { onProduct = null, batchSize = 8 } = {}) {
    this.uploadLeaves(leaves);
    this.skipped = [];
    const acc = [this._makeTarget(), this._makeTarget()];
    let src = 0;
    this._clearTarget(acc[0]);
    for (let start = 0; start < products.length; start += batchSize) {
      const n = Math.min(batchSize, products.length - start);
      const targets = [];
      for (let k = 0; k < n; k++) targets.push(this._makeTarget());
      for (let k = 0; k < n; k++) {
        const i = start + k;
        const p = products[i];
        let done = false;
        if (p.cls === 'convex') { this.renderProductSCS(targets[k], p, leaves); done = true; }
        else if (p.cls === 'plain') { this.renderProductPlain(targets[k], p, leaves); done = true; }
        else if (p.cls === 'goldfeather') done = this.renderProductGoldfeather(targets[k], p, leaves);
        if (!done) { this.skipped.push(i); this.renderProductSkipped(targets[k]); }
      }
      if (onProduct) {
        for (let k = 0; k < n; k++) onProduct(products[start + k], targets[k], start + k);
      }
      for (let k = 0; k < n; k++) {
        this._accumulate(acc, src, targets[k]);
        src = 1 - src;
        this._freeTarget(targets[k]);
      }
    }
    if (outTarget) {
      this._copyResult(acc[src], outTarget);
    } else {
      // blit accumulated color straight to the (default) framebuffer
      const gl = this.gl;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, acc[src].fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.drawBuffers([gl.BACK]);
      gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H,
        gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    this._freeTarget(acc[0]);
    this._freeTarget(acc[1]);
    return { skipped: [...this.skipped] };
  }

  // one nearest-wins accumulate step: acc = merge(acc, productTarget)
  _accumulate(acc, src, target) {
    const gl = this.gl, st = this.st;
    const dst = acc[1 - src];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    st.viewport(0, 0, this.W, this.H);
    st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    st.depthTest(false);
    st.cull(null);
    st.useProgram(this.progAccum.p);
    this._bindAccumTextures(acc[src], target);
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _clearTarget(t) {
    const gl = this.gl, st = this.st;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    st.viewport(0, 0, this.W, this.H);
    st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    st.depthTest(true);
    st.depthFunc(DepthFunc.LESS);
    st.depthMask(true);
    st.colorMask(true, true, true, true);
    st.cull(null);
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], this.alphaEmpty);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  _bindAccumTextures(accT, newT) {
    const gl = this.gl, u = this.progAccum.u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accT.colorTex);
    gl.uniform1i(u.uAccC, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, accT.depthTex);
    gl.uniform1i(u.uAccD, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, newT.colorTex);
    gl.uniform1i(u.uNewC, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, newT.depthTex);
    gl.uniform1i(u.uNewD, 3);
  }

  _copyTarget(from, to) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fb);
    gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H,
      gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  // composite result (color AND depth attachments) into an owned target —
  // callers that want to read the composite back (validation, tests) pass
  // one. Implemented as a shader draw: SwiftShader garbles the two-blit
  // readBuffer/drawBuffers variant (err 1281, alpha=255 everywhere).
  _copyResult(from, to) {
    const gl = this.gl, st = this.st;
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb);
    st.viewport(0, 0, this.W, this.H);
    st.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    st.depthTest(false);
    st.cull(null);
    st.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
    st.useProgram(this.progCopy2.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.colorTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, from.depthTex);
    gl.uniform1i(this.progCopy2.u.uSrcC, 0);
    gl.uniform1i(this.progCopy2.u.uSrcD, 1);
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _freeTarget(t) {
    const gl = this.gl;
    gl.deleteFramebuffer(t.fb);
    gl.deleteFramebuffer(t.fbInval);
    gl.deleteTexture(t.colorTex);
    gl.deleteTexture(t.depthTex);
    gl.deleteTexture(t.dsTex);
  }
}
