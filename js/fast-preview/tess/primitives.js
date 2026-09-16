// Leaf primitive tessellation for the fast-preview module.
// Meshes are triangle soups: Float32Array of xyz triples (9 floats per tri).
// Winding: outward (CCW seen from outside) — generated directly for analytic
// primitives, repaired via signed volume for polyhedron / swept meshes.
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module (see ../PHASES.md).

import { transformPoint } from './mat4.js';

export const EPS_FRAG = 1e-3; // OpenSCAD GRID_FINE

// Port of OpenSCAD get_fragments_from_r(r, fn, fs, fa):
//   r < GRID_FINE          -> 3
//   fn > 0                 -> max(fn, 3)
//   else                   -> ceil(max(min(2π/fa_rad, 2π·r/fs), 5))
export function fragmentsFromR(r, fn, fs, fa) {
  if (r < EPS_FRAG) return 3;
  if (fn > 0) return fn > 3 ? Math.floor(fn) : 3;
  const faRad = fa * Math.PI / 180;
  return Math.ceil(Math.max(Math.min(2 * Math.PI / faRad, 2 * Math.PI * r / fs), 5));
}

// ---------------------------------------------------------------------------
// mesh building

export class MeshBuilder {
  constructor() { this.tris = []; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    this.tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }
  // triangle from point arrays
  p3(a, b, c) { this.tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
  get count() { return this.tris.length / 9; }
  finish() {
    const positions = new Float32Array(this.tris);
    this.tris = null;
    return positions;
  }
}

export function boundsOf(positions) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  }
  return b;
}

// Signed volume of a closed triangle soup. Positive => overall CCW-from-
// outside winding; negative => flipped. OpenSCAD requires consistent winding,
// so the sign is meaningful for closed meshes.
export function signedVolume(positions) {
  let v6 = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    v6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v6 / 6;
}

export function flipMesh(positions) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      out[i + k] = positions[i + k];
      out[i + 3 + k] = positions[i + 6 + k];  // swap B and C
      out[i + 6 + k] = positions[i + 3 + k];
    }
  }
  return out;
}

// Guarantee outward winding for a (closed) mesh; returns input otherwise.
export function orientOutward(positions) {
  return signedVolume(positions) < 0 ? flipMesh(positions) : positions;
}

// ---------------------------------------------------------------------------
// primitives (local space)

export function tessCube(size, center) {
  const sx = size.length ? size[0] : size;
  const sy = size.length ? size[1] : size;
  const sz = size.length ? size[2] : size;
  const x0 = center ? -sx / 2 : 0, x1 = center ? sx / 2 : sx;
  const y0 = center ? -sy / 2 : 0, y1 = center ? sy / 2 : sy;
  const z0 = center ? -sz / 2 : 0, z1 = center ? sz / 2 : sz;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  // outward faces (CCW from outside)
  const f = [
    [0, 3, 2, 1], // bottom (-z)
    [4, 5, 6, 7], // top (+z)
    [0, 1, 5, 4], // front (-y)
    [1, 2, 6, 5], // right (+x)
    [2, 3, 7, 6], // back (+y)
    [3, 0, 4, 7], // left (-x)
  ];
  const mb = new MeshBuilder();
  for (const [a, b, c, d] of f) {
    mb.p3(v[a], v[b], v[c]);
    mb.p3(v[a], v[c], v[d]);
  }
  return mb.finish();
}

export function tessSphere(r, fn) {
  const segs = fragmentsFromR(r, fn, 2, 12);
  const rings = Math.max(2, Math.round(segs / 2));
  const mb = new MeshBuilder();
  const P = (i, j) => {
    const phi = -Math.PI / 2 + Math.PI * i / rings;       // -90..90
    const theta = 2 * Math.PI * j / segs;
    const cp = Math.cos(phi);
    return [r * cp * Math.cos(theta), r * cp * Math.sin(theta), r * Math.sin(phi)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      const a = P(i, j), b = P(i, j1), c = P(i + 1, j1), d = P(i + 1, j);
      if (i === 0) {
        // a and b are both the south pole (phi = -90 deg) — fan from the pole
        mb.p3(a, c, d);
      } else if (i === rings - 1) {
        mb.p3(a, b, d);                        // north pole triangle
      } else {
        mb.p3(a, b, c);
        mb.p3(a, c, d);
      }
    }
  }
  return orientOutward(mb.finish());
}

export function tessCylinder(h, r1, r2, center, fn) {
  const segs = fragmentsFromR(Math.max(r1, r2), fn, 2, 12);
  const z0 = center ? -h / 2 : 0;
  const z1 = center ? h / 2 : h;
  const mb = new MeshBuilder();
  const B = (j) => {
    const t = 2 * Math.PI * j / segs;
    return [r1 * Math.cos(t), r1 * Math.sin(t), z0];
  };
  const T = (j) => {
    const t = 2 * Math.PI * j / segs;
    return [r2 * Math.cos(t), r2 * Math.sin(t), z1];
  };
  const r1z = r1 < EPS_FRAG, r2z = r2 < EPS_FRAG;
  for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    const b = B(j), b1 = B(j1), t = T(j), t1 = T(j1);
    if (r1z && r2z) continue;                     // degenerate
    if (r1z) {                                    // cone from apex (bottom)
      mb.p3([0, 0, z0], b1, t1);
      mb.p3([0, 0, z0], t1, t);
    } else if (r2z) {                             // cone to apex (top)
      mb.p3(t, b, b1);
      mb.p3(t, b1, t1);
    } else {
      mb.p3(t, b, b1);
      mb.p3(t, b1, t1);
    }
  }
  if (!r1z) {                                     // bottom cap, normal -z
    const c = [0, 0, z0];
    for (let j = 0; j < segs; j++) mb.p3(c, B((j + 1) % segs), B(j));
  }
  if (!r2z) {                                     // top cap, normal +z
    const c = [0, 0, z1];
    for (let j = 0; j < segs; j++) mb.p3(c, T(j), T((j + 1) % segs));
  }
  return orientOutward(mb.finish());
}

// OpenSCAD polyhedron(points, faces): faces may be polygons (any vertex count).
// Uses signed volume to guarantee outward winding.
export function tessPolyhedron(points, faces) {
  const mb = new MeshBuilder();
  const P = (i) => points[i] || [0, 0, 0];
  for (const face of faces) {
    for (let k = 1; k + 1 < face.length; k++) mb.p3(P(face[0]), P(face[k]), P(face[k + 1]));
  }
  return orientOutward(mb.finish());
}

// ---------------------------------------------------------------------------
// 2D primitives (profiles for extrusion) — CCW polygons: [[x, y], ...]

export function tessCircle2D(r, fn, fs = 2, fa = 12) {
  const segs = fragmentsFromR(r, fn, fs, fa);
  const pts = [];
  for (let j = 0; j < segs; j++) {
    const t = 2 * Math.PI * j / segs;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

export function tessSquare2D(size, center) {
  const sx = size.length ? size[0] : size;
  const sy = size.length ? size[1] : size;
  if (center) return [[-sx / 2, -sy / 2], [sx / 2, -sy / 2], [sx / 2, sy / 2], [-sx / 2, sy / 2]];
  return [[0, 0], [sx, 0], [sx, sy], [0, sy]];
}

// Triangulate a polygon (fan through centroid — exact for convex profiles,
// which is all we generate; concave profiles would need ear clipping).
export function triangulate2D(pts) {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  const tris = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([cx, cy, 0], pts[i][0], pts[i][1], 0, pts[j][0], pts[j][1], 0);
  }
  return tris;
}

// helper used by extrude.js to place a transformed 3D tri
export function pushTri(mb, m, a, b, c) {
  const A = transformPoint(m, a[0], a[1], a[2]);
  const B = transformPoint(m, b[0], b[1], b[2]);
  const C = transformPoint(m, c[0], c[1], c[2]);
  mb.p3(A, B, C);
}
