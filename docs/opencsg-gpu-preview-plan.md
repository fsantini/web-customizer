# Plan: real-time OpenCSG-style GPU preview

Not started. Saved here so it can be picked up in a future session without
re-deriving the research behind it.

## Background

Our current live preview always pays the full CGAL/Manifold boolean-mesh
cost (openscad-wasm-prebuilt only exposes the file-export CLI pipeline).
Desktop OpenSCAD's F5 preview is fast because it skips mesh computation
entirely and composites the CSG tree live on the GPU via OpenCSG
(stencil-buffer / depth-peeling multi-pass rendering, e.g. Goldfeather's or
SCS algorithm) -- no polygon boolean ever happens.

Investigated whether this exists anywhere for the browser already:

- `openscad-playground` (github.com/openscad/openscad-playground, the
  official web port) does **not** have it -- it uses the same headless
  WASM CLI export path we do, just with `$preview=true` and the Manifold
  backend for speed. No GPU compositing.
- OpenSCAD's lead developer Marius Kintel attempted a JS+WebGL OpenCSG port
  with three.js (~2021-2022) and abandoned it after hitting TTF font
  parsing and CGAL integration, plus WebGL1's limited extensions at the
  time. See
  https://lists.openscad.org/empathy/thread/RCVAXJVYHWQNHSBCSYQKX6JP477LCWTU
  No finished/surviving implementation is known.

Conclusion at the time: not worth pursuing given the scope, but the user
wanted the option written up as an agent-ready task in case it's picked up
later. Full prompt below.

## The task prompt (hand this to a coding agent to start)

```
# Task: Real-time OpenCSG-style CSG preview for a browser-based OpenSCAD customizer

## Context

We have a web app that runs OpenSCAD in-browser via a WASM build
(openscad-wasm-prebuilt, an Emscripten port of the OpenSCAD CLI). It only
exposes the file-export pipeline: write a .scad file to a virtual FS, call
main() with `-o output.stl`, read the result. Every render -- preview or
final -- goes through full CGAL/Manifold boolean evaluation of the CSG tree.
For moderately complex models this takes 5-30+ seconds per render, even at
reduced $fn.

Desktop OpenSCAD's F5 "Preview" is an order of magnitude faster because it
doesn't compute solid geometry at all. It uses the OpenCSG library
(https://github.com/floooh/opencsg or the original schwind/opencsg), which
renders the boolean result of a CSG tree directly via multi-pass stencil-
buffer / depth-peeling compositing on the GPU -- classic algorithms are
Goldfeather's or the SCS (Sequential Convex Subtraction) algorithm. No mesh
is ever produced; only individual convex primitives (already tessellated at
$fn/$fa/$fs) are rasterized, and the stencil buffer determines which
fragments survive the boolean tree, in multiple render passes per tree
depth.

We already investigated whether this exists anywhere for the browser:
- The official openscad-playground project (github.com/openscad/openscad-
  playground) does NOT have this -- it uses the same headless WASM CLI
  export path we do, just with $preview=true and the Manifold backend for
  speed. No GPU compositing.
- OpenSCAD's own lead developer (Marius Kintel) attempted a JS+WebGL port of
  the OpenCSG algorithm with three.js integration around 2021-2022 (see
  https://lists.openscad.org/empathy/thread/RCVAXJVYHWQNHSBCSYQKX6JP477LCWTU).
  He got as far as working shaders and multi-pass rendering but abandoned it
  when he hit TTF font parsing and CGAL integration. WebGL1's limited
  extensions were also a blocker at the time. As far as we know, nothing
  finished ever shipped.

## Goal

Determine whether a real-time, GPU-composited CSG preview (OpenCSG-
equivalent) is practically buildable for a modern browser (WebGL2 or WebGPU,
2026 baseline), and if so, build it -- as a standalone module we can later
wire into our existing three.js viewer as an alternative "fast preview" mode
that bypasses full boolean mesh computation entirely.

## Phase 0: Feasibility spike (do this first, report back before continuing)

1. Read the OpenCSG algorithm description (schwind/opencsg source, and
   Kintel's WebGL prototype if you can find surviving code/branches/gists
   linked from that mailing list thread or his GitHub). Understand exactly
   which passes are needed (primitive rendering, stencil counting per
   convex intersection/union/subtraction node, depth-complexity handling)
   and which parts assume desktop GL features that WebGL2 or WebGPU may or
   may not support (e.g. stencil buffer bit depth, MRT, occlusion queries,
   EXT_depth_clamp equivalents).
2. Establish where the CSG *tree* (not the boolean-evaluated mesh) comes
   from. OpenSCAD's CLI/WASM build only outputs final meshes. Investigate:
   - Can openscad-wasm (or the upstream OpenSCAD C++ source it's built
     from) be coaxed into dumping the post-parse, pre-boolean CSG tree in a
     structured, consumable format (nodes = primitive type + params +
     transform + boolean op), instead of / in addition to a final mesh?
     Look at OpenSCAD's own internal `CSGTreeNode`/`AbstractNode` structures
     and export/dump options (`--export-format=csg` produces a *textual*
     .csg tree dump today for the desktop app -- check whether the WASM CLI
     build supports this flag, and whether the format is stable/parseable).
   - If a tree dump is available: write a parser for it in JS/TS.
   - If not available from the prebuilt package: determine what it would
     take to build our own OpenSCAD-wasm variant that exposes tree
     extraction (this may mean building OpenSCAD from source with
     Emscripten ourselves, which is a much bigger undertaking -- flag this
     clearly as a separate, larger sub-task with its own feasibility
     estimate and licensing check, see below).
3. Prototype the *minimum* OpenCSG case in isolation, outside our app: two
   overlapping convex primitives (e.g. two spheres) with a single
   difference() or intersection(), rendered correctly via multi-pass
   stencil-buffer compositing in raw WebGL2 (or WebGPU) with no framework.
   This validates the core rendering algorithm works in-browser at all
   before investing in tree parsing, transforms, non-convex decomposition
   (concave primitives must be decomposed into convex sub-parts, same as
   OpenCSG does with `convexity`), nested boolean trees, and integration.
4. Write up findings: does the algorithm translate to WebGL2/WebGPU cleanly?
   What's missing? What's the realistic scope (days vs. weeks vs. months) to
   get from the two-sphere prototype to something that handles real models
   like nested difference()/union()/intersection() trees, rotate_extrude,
   linear_extrude, and text() (the exact feature that stalled Kintel's
   attempt)? Recommend whether to proceed, and if so with what scope cut
   (e.g. "support boolean trees up to depth N, no text(), no minkowski()").

Do not proceed past Phase 0 without explicit go-ahead on the findings --
this could easily balloon into a project bigger than the rest of the app.

## Phase 1 (only if Phase 0 gives a green light): Core renderer

- Target WebGL2 as the baseline (broadest support); note in the writeup
  whether WebGPU would meaningfully simplify anything (compute shaders for
  stencil-style counting, MRT) enough to justify a narrower browser target.
- Implement the CSG tree renderer as a standalone TS/JS module with no
  dependency on our existing three.js viewer internals -- it should take a
  parsed CSG tree + a WebGL2 context/canvas and draw the composited result
  each frame, independent of any mesh output.
- Support: cylinder, sphere, cube, polyhedron (from tessellated
  primitives), and the three boolean ops, with arbitrary nesting and
  affine transforms (translate/rotate/scale/matrix). Explicitly out of
  scope unless Phase 0 says otherwise: text(), minkowski(), hull(),
  rotate_extrude/linear_extrude of arbitrary 2D shapes (start with their
  already-tessellated 3D output if the tree dump provides it).
- Correctness matters more than speed at first: cross-check rendered
  silhouettes against the equivalent full-mesh render (from our existing
  pipeline) on a handful of test models, including the spool_custom.scad
  file already in this repo, which has real nested differences and unions.

## Phase 2 (only if Phase 1 succeeds): Integration

- Wire this in as an alternate "fast preview" path in our existing viewer
  (see js/app.js, js/render-worker.js, js/customizer-parser.js in this
  repo for the current architecture: a Web Worker running the mesh-export
  WASM pipeline, coalesced render requests, a three.js OrbitControls
  viewport). The fast preview should render live as sliders move (on
  `input`, not just `change`), with the existing mesh-based path still
  used for the accurate preview/export button.
- Handle the tree-extraction dependency from Phase 0 step 2 -- if it
  required a custom WASM build, document the build process and pin it the
  same way we pin the current CDN-hosted openscad-wasm-prebuilt package.

## Hard constraints for all phases

- Runs entirely client-side in a modern browser. No server-side rendering
  fallback.
- License check: OpenCSG is GPL-2.0, OpenSCAD is GPL-2.0-or-later. If you
  port/adapt algorithm code or data structures from either, our resulting
  module inherits GPL obligations -- confirm this is acceptable before
  writing code, and keep clear attribution/license headers either way.
- Don't touch the existing mesh-export pipeline (render-worker.js,
  customizer-parser.js) except to add the new fast-preview path alongside
  it -- the accurate render/export flow must keep working unmodified.
- Report honestly if at any point the evidence says this isn't practically
  buildable in reasonable scope (e.g. tree extraction turns out to require
  a from-scratch OpenSCAD-to-WASM build with no upstream support) -- a
  clear "not worth it, here's why" is a valid and useful outcome of this
  task.
```

## Also outstanding (unrelated, noted in passing, not part of this plan)

`index.php`'s `ALLOWED_ROOT` currently points at `<app>/scad/`, which
doesn't exist -- `spool_custom.scad` is still at the repo root, so the
default (no `scad=` param) page load currently fails over to a placeholder
cube. Needs either the directory created and the file moved in, or
`ALLOWED_ROOT` pointed back at the repo root.
