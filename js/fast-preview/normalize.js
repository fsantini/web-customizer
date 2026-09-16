// Sum-of-products (DNF) normalization over the parsed .csg tree — the same
// transformation OpenSCAD's CSG normalizer performs before handing products
// to OpenCSG.
//
// Product = { intersectees: [leafNode...], subtrahends: [leafNode...] }
// representing (I₁∩…∩I_k) − S₁ − … − S_m. Union = sum of products.
//
// Key rule for a subtree X = ⋃_j (I_j − ∪S_j) in subtrahend position:
//   ¬X = ⋂_j ( (⋃_{l∈I_j} ¬l) ∪ (∪_{s∈S_j} s) )
// i.e. negation produces one FACTOR per product of X, each factor being a
// union of single-leaf alternatives (¬l → S += l, s → I += s). The
// difference node takes the cartesian product over a child's factors and
// MERGES each combination into one alternative — so a − union(b, c) is one
// product a − b − c, NOT (a−b) ∪ (a−c). (Getting this wrong silently drops
// holes: the spool's vent lattice went uncut, caught only by the STL
// cross-check — the CPU-truth harness validates GPU-vs-products, which are
// wrong in the same way and thus invisible to it.)
//
// Product classes drive renderer dispatch (../PHASES.md):
//   'plain'       single intersectee, no subtrahends → simple mesh render
//   'convex'      all leaves convexity 1 → SCS
//   'goldfeather' non-convex leaf in a non-trivial product
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

const LEAF_TYPES = new Set([
  'cube', 'sphere', 'cylinder', 'polyhedron', 'rotate_extrude', 'linear_extrude',
]);
const PASS_THROUGH = new Set(['group', 'color', 'render', 'multmatrix']);

function isLeafNode(node) { return LEAF_TYPES.has(node.type); }

// products(node): list of { I: [leafNode...], S: [leafNode...] }
function productsOf(node) {
  switch (node.type) {
    case 'union':
    case 'group':
    case 'color':
    case 'render':
    case 'multmatrix': {
      const out = [];
      for (const c of node.children) out.push(...productsOf(c));
      return out;
    }
    case 'intersection': {
      let acc = [{ I: [], S: [] }];
      for (const c of node.children) {
        const cps = productsOf(c);
        const next = [];
        for (const a of acc) for (const b of cps) {
          next.push({ I: a.I.concat(b.I), S: a.S.concat(b.S) });
        }
        acc = next;
      }
      return acc;
    }
    case 'difference': {
      if (node.children.length === 0) return [];
      let acc = productsOf(node.children[0]);
      for (let i = 1; i < node.children.length; i++) {
        const factors = negationFactors(node.children[i]);
        const next = [];
        for (const p of acc) {
          // cartesian over the child's factors: pick one alternative per
          // factor and merge — a − (b ∪ c) = a − b − c (one product), while
          // multi-alternative factors (nested differences) still distribute
          let combos = [{ I: [], S: [] }];
          for (const f of factors) {
            if (f.length === 0) continue; // ¬∅ = universe: no constraint
            const grown = [];
            for (const c of combos) for (const alt of f) {
              grown.push({ I: c.I.concat(alt.I), S: c.S.concat(alt.S) });
            }
            combos = grown;
          }
          for (const c of combos) {
            next.push({
              I: c.I.length ? p.I.concat(c.I) : p.I,
              S: c.S.length ? p.S.concat(c.S) : p.S,
            });
          }
        }
        acc = next;
      }
      return acc;
    }
    default:
      if (isLeafNode(node)) return [{ I: [node], S: [] }];
      // unknown structural node: union of children (eval.js flags the type)
      const out = [];
      for (const c of node.children || []) out.push(...productsOf(c));
      return out;
  }
}

// ¬X where X = ⋃ products (I−S):
//   ¬X = ⋂_j ( (⋃_{l∈I_j} ¬l) ∪ (∪_{s∈S_j} s) )
// → one FACTOR per product j of X; each factor lists that product's
// single-leaf alternatives: {I: [], S: [l]} for ¬l, {I: [s], S: []} for s.
// The difference node merges one alternative per factor (cartesian over
// factors), which makes union subtrahends accumulate conjunctively.
function negationFactors(node) {
  const factors = [];
  for (const prod of productsOf(node)) {
    const f = [];
    for (const l of prod.I) f.push({ I: [], S: [l] });
    for (const s of prod.S) f.push({ I: [s], S: [] });
    factors.push(f);
  }
  return factors;
}

export function normalizeProducts(root, leaves) {
  const leafIndexOf = new Map();
  leaves.forEach((l, i) => leafIndexOf.set(l.node, i));

  function isConvexLeaf(node) {
    const t = node.type;
    if (t === 'cube' || t === 'sphere' || t === 'cylinder') return true;
    if (t === 'polyhedron') return (node.named.convexity ?? 1) <= 1;
    if (t === 'linear_extrude') {
      return !node.named.twist && (node.named.convexity ?? 1) <= 1;
    }
    return false; // rotate_extrude swept solids are non-convex
  }

  const products = [];
  for (const prod of productsOf(root)) {
    if (prod.I.length === 0) continue; // empty child (e.g. empty group)
    const allConvex = prod.I.every(isConvexLeaf) && prod.S.every(isConvexLeaf);
    const cls = prod.I.length === 1 && prod.S.length === 0 ? 'plain'
      : allConvex ? 'convex' : 'goldfeather';
    products.push({
      intersectees: prod.I.map((n) => leafIndexOf.get(n)),
      subtrahends: prod.S.map((n) => leafIndexOf.get(n)),
      cls,
    });
  }
  return products;
}

export { PASS_THROUGH, LEAF_TYPES };
