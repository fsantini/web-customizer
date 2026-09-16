// 2D→3D sweep tessellation: rotate_extrude (lathe) and linear_extrude.
// Profiles are CCW 2D point lists already evaluated from the node's children
// (circle/square + their multmatrix transforms), see eval.js.
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

import { MeshBuilder, orientOutward, triangulate2D } from './primitives.js';

// rotate_extrude(angle=360, start=0): sweep profile (x>0) around the z axis.
// Swept point: (x·cos a, x·sin a, y) with a = start + t·angle.
export function tessRotateExtrude(profile, angle, start, fn, fs = 2, fa = 12) {
  const maxX = Math.max(...profile.map((p) => Math.abs(p[0])));
  const segs = fn > 0 ? Math.floor(fn) : Math.ceil(Math.max((360 / fa) * maxX / (2 * Math.PI), 2 * Math.PI * maxX / fs, 5));
  const full = angle >= 360 - 1e-9;
  const steps = full ? segs : Math.max(1, Math.ceil(segs * angle / 360));
  const pt = (k, i) => {
    const a = (start + angle * i / steps) * Math.PI / 180;
    const x = profile[k][0], y = profile[k][1];
    return [x * Math.cos(a), x * Math.sin(a), y];
  };
  const mb = new MeshBuilder();
  const n = profile.length;
  for (let i = 0; i < steps; i++) {
    const i1 = full ? (i + 1) % steps : i + 1;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;   // profiles are closed contours — wrap the last edge
      const A = pt(k, i), B = pt(k1, i), C = pt(k1, i1), D = pt(k, i1);
      mb.p3(A, B, C);
      mb.p3(A, C, D);
    }
  }
  const pos = mb.finish();
  const closed = full;
  if (closed) return orientOutward(pos);

  // partial sweep: cap the two open ends (fan through profile centroid)
  const capAt = (i, flip) => {
    const c3 = [0, 0, 0];
    for (const p of profile) { c3[0] += p[0]; c3[1] += p[1]; }
    c3[0] /= n; c3[1] /= n;
    const c = [c3[0] * Math.cos((start + angle * i / steps) * Math.PI / 180),
      c3[0] * Math.sin((start + angle * i / steps) * Math.PI / 180),
      c3[1]];
    const out = new MeshBuilder();
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      if (flip) out.p3(c, pt(k1, i), pt(k, i));
      else out.p3(c, pt(k, i), pt(k1, i));
    }
    return out.finish();
  };
  const cap0 = capAt(0, false), cap1 = capAt(steps, true);
  const merged = new Float32Array(pos.length + cap0.length + cap1.length);
  merged.set(pos, 0);
  merged.set(cap0, pos.length);
  merged.set(cap1, pos.length + cap0.length);
  return merged;
}

// linear_extrude(height, scale, twist, center): layered prism.
export function tessLinearExtrude(profile, height, scale, twist, center, fn, fs = 2, fa = 12) {
  const z0 = center ? -height / 2 : 0;
  const sc = Array.isArray(scale) ? scale : [scale, scale];
  const slices = twist !== 0 ? Math.max(2, Math.ceil(Math.abs(twist) * Math.max(fn, 16) / 360)) : 1;
  const ring = (s) => {
    const t = s / slices;
    const z = z0 + height * t;
    const sx = 1 + (sc[0] - 1) * t, sy = 1 + (sc[1] - 1) * t;
    const a = twist * t * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    return profile.map((p) => {
      const x = p[0] * sx, y = p[1] * sy;
      return [x * ca - y * sa, x * sa + y * ca, z];
    });
  };
  const mb = new MeshBuilder();
  const n = profile.length;
  for (let s = 0; s < slices; s++) {
    const R0 = ring(s), R1 = ring(s + 1);
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      mb.p3(R0[k], R0[k1], R1[k1]);
      mb.p3(R0[k], R1[k1], R1[k]);
    }
  }
  // caps
  const capAt = (ringPts, flip) => {
    const c = [ringPts.reduce((s, p) => s + p[0], 0) / n, ringPts.reduce((s, p) => s + p[1], 0) / n, ringPts[0][2]];
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      if (flip) mb.p3(c, ringPts[k1], ringPts[k]);
      else mb.p3(c, ringPts[k], ringPts[k1]);
    }
  };
  capAt(ring(0), true);      // bottom, normal -z
  capAt(ring(slices), false); // top, normal +z
  return orientOutward(mb.finish());
}

// Convenience: 2D profile -> triangulated cap mesh (for debug/harness only)
export function profileCapMesh(profile) {
  const mb = new MeshBuilder();
  for (const t of triangulate2D(profile)) mb.tri(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]);
  return mb.finish();
}
