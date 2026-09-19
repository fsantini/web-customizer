// 3D convex hull (incremental / Beneath-Beyond construction) for hull() and
// the scoped minkowski() case in eval.js. Input is an array of [x, y, z]
// points (duplicates/degenerate input tolerated); output is a triangle soup
// (see primitives.js) of the hull's boundary, winding fixed up by the caller
// via orientOutward() -- face orientation is kept consistent DURING
// construction (needed for the visibility test below to work at all), but
// getting that consistently right by construction is exactly the kind of
// thing worth double-checking, hence the belt-and-suspenders orientOutward()
// call at the end.
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

import { MeshBuilder, orientOutward } from './primitives.js';

const EPS = 1e-7;

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { return Math.sqrt(dot(a, a)); }

// Signed distance-ish (unnormalized) of point p from the plane through
// (a, b, c) whose outward normal is (b-a) x (c-a). Positive => p is on the
// outward side ("can see" the face).
function planeSide(a, b, c, p) {
  const n = cross(sub(b, a), sub(c, a));
  return dot(n, sub(p, a));
}

// Pick 4 affinely-independent points to seed the initial tetrahedron.
// Returns null if all input points are coplanar (or fewer than 4 distinct
// points exist) -- callers treat that as "no volume", not an error.
function seedTetra(pts) {
  const n = pts.length;
  if (n < 4) return null;
  let i0 = 0;
  // furthest point from pts[0] -- avoids picking a near-duplicate as p1
  let i1 = -1, best = EPS;
  for (let i = 1; i < n; i++) {
    const d = norm(sub(pts[i], pts[i0]));
    if (d > best) { best = d; i1 = i; }
  }
  if (i1 < 0) return null; // all points coincide
  // furthest point from the line (p0, p1)
  let i2 = -1; best = EPS;
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1) continue;
    const c = cross(sub(pts[i1], pts[i0]), sub(pts[i], pts[i0]));
    const d = norm(c) / norm(sub(pts[i1], pts[i0]));
    if (d > best) { best = d; i2 = i; }
  }
  if (i2 < 0) return null; // all points collinear
  // furthest point from the plane (p0, p1, p2)
  let i3 = -1; best = EPS;
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1 || i === i2) continue;
    const d = Math.abs(planeSide(pts[i0], pts[i1], pts[i2], pts[i]));
    if (d > best) { best = d; i3 = i; }
  }
  if (i3 < 0) return null; // all points coplanar
  return [i0, i1, i2, i3];
}

// convexHull3D(points): points is [[x,y,z], ...]. Returns a Float32Array
// triangle soup, or null if the points don't span a volume (fewer than 4
// points, or all coplanar/collinear/coincident) -- callers treat that the
// same as "empty geometry", matching addLeaf's positions.length===0 skip.
export function convexHull3D(points) {
  const seed = seedTetra(points);
  if (!seed) return null;
  const [s0, s1, s2, s3] = seed;
  const P = points;

  // Faces as vertex-index triples, oriented so their outward normal (via
  // planeSide's (b-a)x(c-a) convention) points away from the hull interior.
  // Orient each tetrahedron face away from the 4th (excluded) vertex.
  function faceAwayFrom(a, b, c, awayIdx) {
    return planeSide(P[a], P[b], P[c], P[awayIdx]) > 0 ? [b, a, c] : [a, b, c];
  }
  let faces = [
    faceAwayFrom(s0, s1, s2, s3),
    faceAwayFrom(s0, s1, s3, s2),
    faceAwayFrom(s0, s2, s3, s1),
    faceAwayFrom(s1, s2, s3, s0),
  ];

  const used = new Set([s0, s1, s2, s3]);

  for (let i = 0; i < P.length; i++) {
    if (used.has(i)) continue;
    const p = P[i];

    const visible = [];
    for (let f = 0; f < faces.length; f++) {
      const [a, b, c] = faces[f];
      if (planeSide(P[a], P[b], P[c], p) > EPS) visible.push(f);
    }
    if (visible.length === 0) continue; // p is inside (or on) the current hull

    // Horizon: directed edges of visible faces not cancelled by a reverse
    // edge belonging to another visible face.
    const visibleSet = new Set(visible);
    const edgeCount = new Map(); // "a,b" -> occurrences among visible faces
    for (const f of visible) {
      const [a, b, c] = faces[f];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        edgeCount.set(`${u},${v}`, (edgeCount.get(`${u},${v}`) || 0) + 1);
      }
    }
    const horizon = [];
    for (const [key, count] of edgeCount) {
      if (count !== 1) continue;
      const [u, v] = key.split(',').map(Number);
      if (!edgeCount.has(`${v},${u}`)) horizon.push([u, v]);
    }

    faces = faces.filter((_, f) => !visibleSet.has(f));
    for (const [a, b] of horizon) faces.push([a, b, i]);
    used.add(i);
  }

  const mb = new MeshBuilder();
  for (const [a, b, c] of faces) mb.p3(P[a], P[b], P[c]);
  return orientOutward(mb.finish());
}
