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
import { convexHull3D } from './tess/hull.js';

// node types the fast path understands structurally (pass-through)
const STRUCTURAL = new Set([
  'group', 'union', 'difference', 'intersection', 'multmatrix', 'color', 'render',
]);
// leaf primitives
const LEAF = new Set([
  'cube', 'sphere', 'cylinder', 'polyhedron', 'rotate_extrude', 'linear_extrude',
]);

// hull()'s brute-force O(n·h) construction gets slow when most input points
// sit on the hull surface (measured: ~2000 such points ~230ms, ~5000 ~1.4s --
// see tess/hull.js). Past this many input points, treat as unsupported
// rather than stall an interactive drag.
const HULL_POINT_CAP = 3000;
// Same idea for the scoped minkowski() case below, but budgeted over the
// *sum* of all pairwise vertex-cross-product sizes (each pair gets its own
// convexHull3D call): a handful of small pairs stay well under this even
// when the node total looks large.
const MINKOWSKI_POINT_BUDGET = 20000;

// Nodes minkowski() can handle exactly (see the "scoped minkowski" note on
// the 'minkowski' case below): pure unions of convex primitives, no
// difference()/intersection() anywhere -- Minkowski sum distributes over
// union exactly, but NOT over difference/intersection, so anything with a
// cut in it must fall back to the mesh path instead of rendering wrong.
const MINKOWSKI_SAFE_LEAF = new Set(['cube', 'sphere', 'cylinder']);
function isPureConvexUnion(node) {
  switch (node.type) {
    case 'group':
    case 'union':
    case 'color':
    case 'render':
    case 'multmatrix':
      return (node.children || []).every(isPureConvexUnion);
    default:
      return MINKOWSKI_SAFE_LEAF.has(node.type);
  }
}

function positionsToPoints(positions) {
  const pts = [];
  for (let i = 0; i < positions.length; i += 3) pts.push([positions[i], positions[i + 1], positions[i + 2]]);
  return pts;
}

// Triangle soups repeat every shared vertex once per adjoining triangle (a
// cube's 8 corners show up as 36 floats' worth of positions, a cylinder's
// ring vertices 2-3x over) -- hull()/minkowski()'s cost is driven by point
// COUNT, so dedup before costing or hulling, not after, or the budget below
// is checking a number 3-6x too pessimistic for no real reason.
function dedupPoints(pts) {
  const seen = new Set();
  const out = [];
  const SCALE = 1e4; // ~1e-4 absolute tolerance -- matches the Float32Array mesh precision
  for (const p of pts) {
    const key = `${Math.round(p[0] * SCALE)},${Math.round(p[1] * SCALE)},${Math.round(p[2] * SCALE)}`;
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

export function evaluateCsg(text) {
  const root = parseCsg(text);
  const leaves = [];
  const unsupported = new Set();
  // addLeaf() pushes to whichever sink is "current" -- normally `leaves`,
  // but resize()/hull()/minkowski() need their children evaluated in a LOCAL
  // frame (own bounding box / own vertices, unaffected by the ambient
  // transform) before their own geometry can be computed, so they swap in a
  // throwaway sink for the duration of that sub-evaluation (see evalLocal).
  let currentSink = leaves;
  function evalLocal(node, color) {
    const saved = currentSink;
    const sink = [];
    currentSink = sink;
    walk(node, identity(), color);
    currentSink = saved;
    return sink;
  }

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
    currentSink.push({ node, positions, convexity, color, source });
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
      case 'resize': {
        // The dump doesn't always wrap multiple children in a group() --
        // resize(){ a(); b(); } dumps both as direct children -- so gather
        // all of them, same as hull()/minkowski() below.
        const localLeaves = [];
        for (const c of node.children) localLeaves.push(...evalLocal(c, color));
        if (localLeaves.length === 0) return; // nothing to resize -> nothing to add
        let box = null;
        for (const l of localLeaves) {
          const b = boundsOf(l.positions);
          box = box ? unionBounds(box, b) : b;
        }
        const oldSize = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
        const newsize = vec(node.named.newsize, [0, 0, 0]);
        const autoRaw = node.named.auto;
        const auto = Array.isArray(autoRaw) ? autoRaw.map(Boolean) : [!!autoRaw, !!autoRaw, !!autoRaw];
        // OpenSCAD: explicit axes scale to hit newsize[i] exactly; axes left
        // at 0 with auto=true borrow the LARGEST scale factor among the
        // explicit axes (verified empirically against real OpenSCAD -- it's
        // max(), not the average one might guess from "preserve aspect
        // ratio"); axes left at 0 with auto=false don't scale at all.
        // Scaling is from the origin (0,0,0), not the bbox center -- same as
        // `scale()` with these computed factors.
        const scale = [1, 1, 1];
        let maxExplicit = 0, haveExplicit = false;
        for (let i = 0; i < 3; i++) {
          if (newsize[i] && oldSize[i] > 1e-6) {
            scale[i] = newsize[i] / oldSize[i];
            if (!haveExplicit || scale[i] > maxExplicit) maxExplicit = scale[i];
            haveExplicit = true;
          }
        }
        const autoScale = haveExplicit ? maxExplicit : 1;
        for (let i = 0; i < 3; i++) {
          if ((!newsize[i] || oldSize[i] <= 1e-6) && auto[i]) scale[i] = autoScale;
        }
        for (const l of localLeaves) {
          const scaled = new Float32Array(l.positions.length);
          for (let i = 0; i < l.positions.length; i += 3) {
            scaled[i] = l.positions[i] * scale[0];
            scaled[i + 1] = l.positions[i + 1] * scale[1];
            scaled[i + 2] = l.positions[i + 2] * scale[2];
          }
          addLeaf(l.node, transform(M, scaled), l.convexity, l.color, l.source);
        }
        return;
      }
      case 'hull': {
        const localLeaves = [];
        for (const c of node.children) localLeaves.push(...evalLocal(c, color));
        if (localLeaves.length === 0) return;
        const rawPts = [];
        for (const l of localLeaves) rawPts.push(...positionsToPoints(l.positions));
        const pts = dedupPoints(rawPts);
        if (pts.length > HULL_POINT_CAP) { unsupported.add('hull'); return; }
        const mesh = convexHull3D(pts);
        if (!mesh) return; // coplanar/degenerate -> legitimately no volume
        addLeaf(node, transform(M, mesh), 1, color, 'hull');
        return;
      }
      case 'minkowski': {
        const children = node.children;
        if (children.length === 2 && isPureConvexUnion(children[0]) && isPureConvexUnion(children[1])) {
          const aLeaves = evalLocal(children[0], color);
          const bLeaves = evalLocal(children[1], color);
          if (aLeaves.length === 0 || bLeaves.length === 0) return; // sum with nothing is nothing
          const aPtsList = aLeaves.map((l) => dedupPoints(positionsToPoints(l.positions)));
          const bPtsList = bLeaves.map((l) => dedupPoints(positionsToPoints(l.positions)));
          let cost = 0;
          for (const a of aPtsList) for (const b of bPtsList) cost += a.length * b.length;
          if (cost <= MINKOWSKI_POINT_BUDGET) {
            // Minkowski sum of convex sets = convex hull of pairwise vertex
            // sums, and it distributes over union -- see isPureConvexUnion's
            // comment for why this is exact only when neither operand has a
            // cut in it, and MINKOWSKI_POINT_BUDGET above for the cost bound.
            const pieceNodes = [];
            for (const aPts of aPtsList) {
              for (const bPts of bPtsList) {
                const sumPts = [];
                for (const pa of aPts) for (const pb of bPts) {
                  sumPts.push([pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]]);
                }
                const mesh = convexHull3D(sumPts);
                if (!mesh) continue;
                const pieceNode = { type: 'hull' }; // tagged so normalize.js's isConvexLeaf treats it like hull()'s own output
                addLeaf(pieceNode, transform(M, mesh), 1, color, 'minkowski');
                pieceNodes.push(pieceNode);
              }
            }
            // Read by normalize.js's productsOf(): a minkowski node maps to
            // several leaves (one per pair), not the usual one-node-one-leaf
            // relationship, so it can't just be added to LEAF_TYPES.
            node._mkLeaves = pieceNodes;
            return;
          }
        }
        // Unscoped (a cut somewhere in either operand) or over budget:
        // flagged unsupported so the caller falls back to the mesh path, but
        // still walked as a transparent union of the RAW operands so leaf
        // indices stay consistent with normalize.js's fallback for this node
        // (see the default case below for why that matters).
        unsupported.add('minkowski');
        for (const c of children) walk(c, M, color);
        return;
      }
      default:
        // Unknown node (offset(), text(), import(), …): flagged so
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
