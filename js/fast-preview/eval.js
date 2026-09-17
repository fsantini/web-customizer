// Evaluate a parsed .csg tree into world-space leaf meshes + structure info.
// Leaves carry: { positions (Float32Array), convexity, color, source (type) }
// Unsupported node types are collected instead of guessed at, so callers can
// fall back to the mesh path cleanly (see ../PHASES.md scope cuts).
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

import { parseCsg } from './csg-parser.js';
import { identity, fromRows, multiply, transformPoint } from './tess/mat4.js';
import {
  tessCube, tessSphere, tessCylinder, tessPolyhedron,
  tessCircle2D, tessSquare2D, boundsOf,
} from './tess/primitives.js';
import { tessRotateExtrude, tessLinearExtrude } from './tess/extrude.js';

// node types the fast path understands structurally (pass-through)
const STRUCTURAL = new Set([
  'group', 'union', 'difference', 'intersection', 'multmatrix', 'color', 'render',
]);
// leaf primitives
const LEAF = new Set([
  'cube', 'sphere', 'cylinder', 'polyhedron', 'rotate_extrude', 'linear_extrude',
]);

export function evaluateCsg(text) {
  const root = parseCsg(text);
  const leaves = [];
  const unsupported = new Set();

  function num(v, dflt) { return typeof v === 'number' ? v : dflt; }
  function vec(v, dflt) { return Array.isArray(v) ? v : dflt; }
  // multmatrix carries its 4x4 rows positionally in the dump: multmatrix([[..],..]);
  function matrixOf(node) {
    const keyed = node.named.matrix;
    if (Array.isArray(keyed)) return keyed;
    const p = node.params[0];
    return p && Array.isArray(p.value) ? p.value : null;
  }

  function eval2DProfile(node, M) {
    // children of an extrude node: 2D geometry under 2D transforms
    const pts = [];
    (function walk(n, m) {
      if (n.type === 'multmatrix') {
        const rows = matrixOf(n);
        const m2 = rows ? multiply(m, fromRows(rows)) : m;
        for (const c of n.children) walk(c, m2);
      } else if (n.type === 'circle') {
        const r = num(n.named.r, 1);
        const fn = num(n.named.$fn, 0), fs = num(n.named.$fs, 2), fa = num(n.named.$fa, 12);
        for (const p of tessCircle2D(r, fn, fs, fa)) {
          const q = transformPoint(m, p[0], p[1], 0);
          pts.push([q[0], q[1]]);
        }
      } else if (n.type === 'square') {
        for (const p of tessSquare2D(vec(n.named.size, 10), !!n.named.center)) {
          const q = transformPoint(m, p[0], p[1], 0);
          pts.push([q[0], q[1]]);
        }
      } else {
        unsupported.add(n.type);   // polygon()/offset()/projection() etc.
      }
    })(node, M);
    return pts;
  }

  function addLeaf(node, positions, convexity, color, source) {
    if (positions.length === 0) return;
    leaves.push({ node, positions, convexity, color, source });
  }

  function walk(node, M, color) {
    switch (node.type) {
      case 'group':
      case 'render':
        for (const c of node.children) walk(c, M, color);
        return;
      case 'color': {
        const c = vec(node.named.color, null);
        for (const ch of node.children) walk(ch, M, c || color);
        return;
      }
      case 'multmatrix': {
        const rows = matrixOf(node);
        if (!rows) { unsupported.add('multmatrix'); return; }
        const m2 = multiply(M, fromRows(rows));
        for (const c of node.children) walk(c, m2, color);
        return;
      }
      case 'union':
      case 'difference':
      case 'intersection':
        // structural normalization happens in normalize.js; eval only recurses
        for (const c of node.children) walk(c, M, color);
        return;
      case 'cube': {
        const size = vec(node.named.size, 1);
        addLeaf(node, transform(M, tessCube(size, !!node.named.center)), 1, color, 'cube');
        return;
      }
      case 'sphere': {
        const r = num(node.named.r, 1);
        addLeaf(node, transform(M, tessSphere(r, num(node.named.$fn, 0))),
          1, color, 'sphere');
        return;
      }
      case 'cylinder': {
        const h = num(node.named.h, 1);
        const r1 = node.named.r !== undefined ? num(node.named.r, 1) : num(node.named.r1, 1);
        const r2 = node.named.r !== undefined ? num(node.named.r, 1) : num(node.named.r2, 1);
        addLeaf(node, transform(M, tessCylinder(h, r1, r2, !!node.named.center, num(node.named.$fn, 0))),
          1, color, 'cylinder');
        return;
      }
      case 'polyhedron': {
        const pts = vec(node.named.points, []);
        const faces = vec(node.named.faces, node.named.triangles || []);
        addLeaf(node, transform(M, tessPolyhedron(pts, faces)),
          Math.max(1, num(node.named.convexity, 1)), color, 'polyhedron');
        return;
      }
      case 'rotate_extrude': {
        const profile = eval2DProfileChildren(node);
        if (profile.length < 2) { unsupported.add('rotate_extrude'); return; }
        addLeaf(node, transform(M, tessRotateExtrude(profile,
          num(node.named.angle, 360), num(node.named.start, 0),
          num(node.named.$fn, 0), num(node.named.$fs, 2), num(node.named.$fa, 12))),
          Math.max(2, num(node.named.convexity, 2)), color, 'rotate_extrude');
        return;
      }
      case 'linear_extrude': {
        const profile = eval2DProfileChildren(node);
        if (profile.length < 3) { unsupported.add('linear_extrude'); return; }
        addLeaf(node, transform(M, tessLinearExtrude(profile,
          num(node.named.height, 10), node.named.scale === undefined ? 1 : node.named.scale,
          num(node.named.twist, 0), !!node.named.center,
          num(node.named.$fn, 0), num(node.named.$fs, 2), num(node.named.$fa, 12))),
          Math.max(2, num(node.named.convexity, 2)), color, 'linear_extrude');
        return;
      }
      default:
        // Unknown node (resize(), offset(), text(), import(), …): flagged so
        // the caller falls back to the mesh path, but still walked as a
        // transparent union of its children -- normalize.js's productsOf()
        // does the same for unrecognized types, and the two MUST agree on
        // which leaf nodes exist. Stopping here without recursing left any
        // leaf nested under the unknown node (e.g. resize()'s children)
        // referenced by normalize.js's products but absent from `leaves`,
        // which crashed visibleBounds()/renderTransformed() on an
        // undefined index instead of cleanly reporting "unsupported".
        unsupported.add(node.type);
        for (const c of node.children || []) walk(c, M, color);
        return;
      }
  }

  // 2D children of extrudes are evaluated in the extrude's own space (local
  // coordinates) — OpenSCAD applies the parent transform AFTER the sweep.
  function eval2DProfileChildren(node) {
    const pts = [];
    for (const c of node.children) pts.push(...eval2DProfile(c, identity()));
    return dedupProfile(pts);
  }

  function transform(M, positions) {
    if (isIdentity(M)) return positions;
    const out = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const p = transformPoint(M, positions[i], positions[i + 1], positions[i + 2]);
      out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
    }
    return out;
  }

  walk(root, identity(), null);
  return {
    leaves,
    unsupported: [...unsupported],
    nodeCount: countNodes(root),
    root,
  };
}

// Bounds of the leaves that actually contribute visible volume. Two things
// naive union-over-all-leaves gets wrong:
//  - a subtrahend never enlarges what it's cut from (A-B ⊆ A), so a leaf that
//    appears ONLY as a subtrahend (e.g. an oversized cutter cube reaching
//    well past the solid it trims) must be excluded, not unioned in;
//  - an intersection can be tighter than any one of its operands (A∩B's
//    z-range is the overlap of A's and B's, not the union), so intersectees
//    within the SAME product are combined by intersecting their boxes, not
//    unioning them, before that product's box is unioned into the result.
// Caller passes normalizeProducts() output, computed after this leaf list.
export function visibleBounds(leaves, products) {
  let acc = null;
  for (const p of products) {
    if (p.intersectees.length === 0) continue;
    let box = null;
    for (const idx of p.intersectees) {
      const b = boundsOf(leaves[idx].positions);
      box = box ? intersectBounds(box, b) : b;
    }
    if (!box || box[0] > box[3] || box[1] > box[4] || box[2] > box[5]) continue; // empty overlap
    acc = acc ? unionBounds(acc, box) : box;
  }
  return acc;
}

function intersectBounds(a, b) {
  return [
    Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]),
    Math.min(a[3], b[3]), Math.min(a[4], b[4]), Math.min(a[5], b[5]),
  ];
}

function isIdentity(m) {
  return m[0] === 1 && m[5] === 1 && m[10] === 1 && m[15] === 1 &&
    m[12] === 0 && m[13] === 0 && m[14] === 0 &&
    m[1] === 0 && m[2] === 0 && m[4] === 0 && m[6] === 0 &&
    m[8] === 0 && m[9] === 0;
}

function identity4Rows() {
  return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
}

function unionBounds(a, b) {
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5]),
  ];
}

// merge consecutive duplicate points (transformed circle segments can repeat)
function dedupProfile(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) out.push(p);
  }
  return out;
}

function countNodes(root) {
  let n = 0;
  (function walk(x) { n++; for (const c of x.children) walk(c); })(root);
  return n;
}
