// Ortho camera utilities for the fast-preview module.
// Validation convention (inherited from the phase-0 prototype, kept so the
// harness math is identical): camera looks along -z with a fixed slab
// [NEAR, FAR]; rays fire from z=0 along -z and t = -z_world; window depth
// z_win = (t-NEAR)/(FAR-NEAR). Models are centered/scaled into the slab by
// fitTransform() before upload; the CPU harness applies the same transform
// to the same triangles, so GPU and CPU see identical geometry.
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

export const NEAR = 0.5;
export const FAR = 20.5;

export function ortho(l, r, b, t, n, f) {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b);
  m[14] = -(f + n) / (f - n); m[15] = 1;
  return m;
}

// Similarity transform (center + uniform scale) mapping bounds into the ortho
// window, plus the ortho projection for a W×H viewport. Two invariants the
// validation convention depends on:
//   1. the model must sit INSIDE the ortho depth slab — rays fire from z=0
//      along -z, so t = -z_world must land in [NEAR, FAR]; the model center
//      goes midway down the slab (z_world = -(NEAR+FAR)/2);
//   2. the uniform scale fits the model within BOTH window half-extents
//      (x: half*margin, y: aspect-corrected), preserving x/y/z aspect.
export function fitTransform(bounds, width, height, half = 2.0, margin = 1.05) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const xh = half * margin;
  const yh = (xh * height) / width;
  const s = Math.min(
    xh / Math.max(x1 - x0, 1e-6),
    yh / Math.max(y1 - y0, 1e-6),
    xh / Math.max(z1 - z0, 1e-6),
  );
  const T = new Float32Array(16);
  T[0] = s; T[5] = s; T[10] = s; T[15] = 1;
  T[12] = -s * cx; T[13] = -s * cy;
  T[14] = -s * cz - (NEAR + FAR) / 2;
  const proj = ortho(-xh, xh, -yh, yh, NEAR, FAR);
  return { T, proj, scale: s, xhalf: xh, yhalf: yh };
}

// apply similarity transform to a positions array (returns new array)
export function transformPositions(pos, T) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = T[0] * x + T[12];
    out[i + 1] = T[5] * y + T[13];
    out[i + 2] = T[10] * z + T[14];
  }
  return out;
}

// apply a general affine 4×4 (column-major; last row must be [0,0,0,1]) to a
// positions array (returns new array). The interactive front-end uses this to
// bake an arbitrary view rotation into leaf geometry so the module's frame
// convention (camera looking along -z) keeps holding while the user orbits.
export function transformPositionsMat4(pos, m) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}
