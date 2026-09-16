// Top-level API for the fast-preview module.
//   const fp = createFastPreview(gl, { width, height });
//   fp.update(csgText);          // parse → eval → normalize → GPU
//   fp.renderTransformed(T, proj); // re-render the same scene, new view
//   fp.result                    // { skipped, bounds, timings }
// Caller supplies a WebGL2 context sized to the viewport. If any product
// needs the unported Goldfeather path, `result.skipped` is non-empty and the
// caller should fall back to the existing mesh path (see ../PHASES.md).
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module. The SCS /
// Goldfeather renderer is ported from OpenCSG (© Florian Kirsch, HPI).

import { evaluateCsg } from './eval.js';
import { normalizeProducts } from './normalize.js';
import { SCSRenderer } from './scs/scs-renderer.js';
import { fitTransform, transformPositionsMat4 } from './camera.js';

export function createFastPreview(gl, { width, height }) {
  const renderer = new SCSRenderer(gl, { width, height });

  // `onProduct(product, target, index)` is invoked while each product target
  // is still live (before it is composited and freed) — use it to read back
  // per-product results; the renderer streams products in bounded batches so
  // holding all targets is not an option.
  //
  // Scene state from the last update(): model-space leaves (NOT view
  // transformed), the normalized products, and the model bounds.
  // renderTransformed() re-renders them under a caller-supplied view
  // transform without re-evaluating the dump — the interactive front-end
  // uses this to follow the user's camera.
  let modelLeaves = null;
  let products = null;
  let bounds = null;

  // Render the current scene through an arbitrary affine view transform
  // `full` (column-major 4×4 mapping MODEL space into the module's frame —
  // camera looking along -z, depth slab [NEAR, FAR] from camera.js) with the
  // matching ortho `proj`. Any invertible affine works: per-leaf caches are
  // reset and every leaf re-uploaded, so no geometry, coverage, or
  // ray-crossing state from a previous view/model survives.
  function renderTransformed(full, proj, { onProduct } = {}) {
    if (!modelLeaves || !products) throw new Error('renderTransformed before update');
    const leaves = modelLeaves.map((l) => ({ ...l, positions: transformPositionsMat4(l.positions, full) }));
    renderer.resetLeafCaches();
    renderer.setProjection(proj);
    const { skipped } = renderer.renderScene(leaves, products, null, { onProduct });
    return { empty: false, leaves, products, skipped, bounds };
  }

  function update(csgText, { onProduct } = {}) {
    const t0 = performance.now();
    const ev = evaluateCsg(csgText);
    const t1 = performance.now();
    products = normalizeProducts(ev.root, ev.leaves);
    modelLeaves = ev.leaves;
    bounds = ev.bounds;
    const t2 = performance.now();

    if (!bounds || modelLeaves.length === 0) {
      return { empty: true, skipped: [], unsupported: ev.unsupported || [],
        leaves: modelLeaves, products, timings: { eval: t1 - t0, normalize: t2 - t1 } };
    }
    const { T, proj } = fitTransform(bounds, width, height);
    const r = renderTransformed(T, proj, { onProduct });
    const t3 = performance.now();
    return {
      empty: false,
      leaves: r.leaves,          // view-transformed leaves (for CPU validation)
      products: r.products,
      skipped: r.skipped,
      unsupported: ev.unsupported || [], // node types the module cannot render
      bounds,
      timings: { eval: t1 - t0, normalize: t2 - t1, render: t3 - t2 },
    };
  }

  return { update, renderTransformed, renderer };
}
