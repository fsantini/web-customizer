// Centralized WebGL2 state manager.
// Phase-0 lesson (see ../PHASES.md): the SCS algorithm's correctness depends
// on implicit state transitions (colorMask, depthFunc, stencil ops) that the
// C++ original performs through its channel manager. Every state change in
// this module MUST go through this class so transitions are explicit and
// debuggable.
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

const GL = {
  FALSE: 0, TRUE: 1,
  LESS: 0x0201, GREATER: 0x0204, ALWAYS: 0x0207, EQUAL: 0x0202,
  NOTEQUAL: 0x0205, LEQUAL: 0x0203, GEQUAL: 0x0206, NEVER: 0x0200,
  KEEP: 0x1E00, ZERO: 0, REPLACE: 0x1E01, INCR: 0x1E02, DECR: 0x1E03,
  BACK: 0x0405, FRONT: 0x0404,
};

export class GLState {
  constructor(gl) {
    this.gl = gl;
    // Sentinels, not GL defaults: GL state is CONTEXT-GLOBAL, but a GLState
    // instance may be constructed into a context that a previous renderer
    // left in arbitrary state (e.g. depthFunc GREATER from an SCS pass). The
    // trailing reset() issues every tracked call so the cache starts in sync
    // with reality instead of assuming GL defaults.
    this.cur = {
      program: -1,
      depthTest: null,
      depthFunc: -1,
      depthMask: null,
      depthRange: [-1, -1],
      colorMask: [-1, -1, -1, -1],
      cullFace: -1,             // -1 = "unknown", null = disabled
      stencilTest: null,
      stencilFunc: [-1, -1, -1],
      stencilOp: [-1, -1, -1],
      stencilMask: -1,
      viewport: [-1, -1, -1, -1],
      drawBuffers: null,
    };
    this.reset();
  }

  useProgram(p) {
    if (this.cur.program === p) return;
    this.gl.useProgram(p);
    this.cur.program = p;
  }
  depthTest(on) {
    if (this.cur.depthTest === on) return;
    this.cur.depthTest = on;
    if (on) this.gl.enable(this.gl.DEPTH_TEST); else this.gl.disable(this.gl.DEPTH_TEST);
  }
  depthFunc(v) {
    if (this.cur.depthFunc === v) return;
    this.cur.depthFunc = v;
    this.gl.depthFunc(v);
  }
  depthMask(v) {
    if (this.cur.depthMask === v) return;
    this.cur.depthMask = v;
    this.gl.depthMask(v);
  }
  depthRange(a, b) {
    if (this.cur.depthRange[0] === a && this.cur.depthRange[1] === b) return;
    this.cur.depthRange = [a, b];
    this.gl.depthRange(a, b);
  }
  colorMask(r, g, b, a) {
    const c = this.cur.colorMask;
    if (c[0] === r && c[1] === g && c[2] === b && c[3] === a) return;
    c[0] = r; c[1] = g; c[2] = b; c[3] = a;
    this.gl.colorMask(r, g, b, a);
  }
  cull(v) { // null | GL.BACK | GL.FRONT
    if (this.cur.cullFace === v) return;
    if (v === null) {
      if (this.cur.cullFace !== null) this.gl.disable(this.gl.CULL_FACE);
    } else {
      // -1 (unknown from a previous renderer) must re-enable: gl.enable is
      // idempotent, so err on the side of issuing it.
      if (this.cur.cullFace === null || this.cur.cullFace === -1) {
        this.gl.enable(this.gl.CULL_FACE);
      }
      this.gl.cullFace(v);
    }
    this.cur.cullFace = v;
  }
  stencil(on) {
    if (this.cur.stencilTest === on) return;
    this.cur.stencilTest = on;
    if (on) this.gl.enable(this.gl.STENCIL_TEST); else this.gl.disable(this.gl.STENCIL_TEST);
  }
  stencilFunc(fn, ref, mask) {
    const c = this.cur.stencilFunc;
    if (c[0] === fn && c[1] === ref && c[2] === mask) return;
    this.cur.stencilFunc = [fn, ref, mask];
    this.gl.stencilFunc(fn, ref, mask);
  }
  stencilOp(fail, zfail, zpass) {
    const c = this.cur.stencilOp;
    if (c[0] === fail && c[1] === zfail && c[2] === zpass) return;
    this.cur.stencilOp = [fail, zfail, zpass];
    this.gl.stencilOp(fail, zfail, zpass);
  }
  stencilMask(m) {
    if (this.cur.stencilMask === m) return;
    this.cur.stencilMask = m;
    this.gl.stencilMask(m);
  }
  viewport(x, y, w, h) {
    const c = this.cur.viewport;
    if (c[0] === x && c[1] === y && c[2] === w && c[3] === h) return;
    this.cur.viewport = [x, y, w, h];
    this.gl.viewport(x, y, w, h);
  }
  drawBuffers(bufs) {
    // NOTE: no change-detection — draw-buffer state is PER-FRAMEBUFFER in GL,
    // and this manager does not track framebuffer bindings, so a cached skip
    // would leave freshly-bound FBOs with the wrong draw list (attachment1
    // silently unwritten). Always issue.
    this.cur.drawBuffers = [...bufs];
    this.gl.drawBuffers(bufs);
  }

  // reset per-frame mutable state to sane defaults
  reset() {
    this.useProgram(null);
    this.depthTest(true);
    this.depthFunc(GL.LESS);
    this.depthMask(true);
    this.depthRange(0, 1);
    this.colorMask(true, true, true, true);
    this.cull(null);
    this.stencil(false);
    this.stencilFunc(GL.ALWAYS, 0, 0xff);
    this.stencilOp(GL.KEEP, GL.KEEP, GL.KEEP);
    this.stencilMask(0xff);
  }
}

export const DepthFunc = { LESS: GL.LESS, GREATER: GL.GREATER, ALWAYS: GL.ALWAYS, NOTEQUAL: GL.NOTEQUAL, EQUAL: GL.EQUAL, LEQUAL: GL.LEQUAL };
export const CullFace = { BACK: GL.BACK, FRONT: GL.FRONT };
export const StencilOp = { KEEP: GL.KEEP, ZERO: GL.ZERO, REPLACE: GL.REPLACE, INCR: GL.INCR, DECR: GL.DECR };
export const StencilFunc = { ALWAYS: GL.ALWAYS, EQUAL: GL.EQUAL, NOTEQUAL: GL.NOTEQUAL };
