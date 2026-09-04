# web-customizer

An in-browser OpenSCAD Customizer. Parses the OpenSCAD Customizer convention
out of a `.scad` file, renders a parameter UI, shows a live navigable 3D
preview, and exports a full-resolution STL -- all computed client-side via
WebAssembly, no backend rendering.

## Architecture

- `index.php` -- PHP entry point (not static HTML). Reads a model server-side
  from the `scad` query param (default `spool_custom.scad`) and an optional
  `stl` query param (a precomputed STL shown instantly on load), injects both
  into the page as JS globals (`window.__SCAD_SOURCE__`,
  `window.__PRECOMPUTED_STL_BASE64__`), confined to `ALLOWED_ROOT` to prevent
  path traversal. **Known issue:** `ALLOWED_ROOT` is currently set to
  `<app>/scad/`, which doesn't exist yet -- `spool_custom.scad` is still at
  the repo root, so the default page load currently fails over to a
  placeholder cube. Needs the directory created + file moved, or
  `ALLOWED_ROOT` pointed back at the repo root.
- `js/customizer-parser.js` -- regex/line-based parser for the Customizer
  convention (`/* [Group] */` sections, `// [min:max]` / `// [min:step:max]`
  ranges, `// [opt1,opt2]` dropdowns, description comments, `/* [Hidden] */`,
  booleans, vectors). Also rewrites the source with new parameter values by
  recorded line index (`buildSource`).
- `js/render-worker.js` -- runs `openscad-wasm-prebuilt`
  (https://cdn.jsdelivr.net/npm/openscad-wasm-prebuilt, pinned to 1.2.0) in a
  Web Worker. **Important constraint, confirmed empirically:** a second
  `callMain()` call on the same OpenSCAD instance fails almost instantly with
  an opaque numeric exception -- reuse is not viable. Every render creates a
  fresh instance (~11MB wasm decode+compile, several seconds). To hide that
  cost, the worker pre-warms the *next* instance in the background as soon as
  the current one is consumed, so renders that are >~15-20s apart feel near-
  instant while back-to-back renders still pay the full cost.
- `js/app.js` -- builds the sidebar controls from parsed params, drives the
  three.js viewer (OrbitControls + STLLoader), and coordinates rendering:
  - Preview renders are capped at `$fn <= 16` (`PREVIEW_FN_CAP`) and inject
    `$preview = true`/`false` (OpenSCAD's own special variable, mirroring
    what `openscad-playground` and desktop OpenSCAD do) so scripts that
    branch on it get cheaper preview geometry for free.
    Export always uses the exact parameter values.
  - Rendering is coalesced, not queued or interrupted: at most one render is
    in flight and at most one more (the newest) is queued behind it -- a
    parameter commit never kills the in-flight worker/instance (that used to
    cause an effectively-infinite restart loop under rapid changes, since
    killing the worker discards the expensive-to-rebuild wasm instance).
  - No true percentage progress is available from OpenSCAD's wasm CLI, so
    "progress" is an elapsed-time counter + the last stage message OpenSCAD
    itself printed, plus an honest indeterminate (not fake 0-100%) progress
    bar.
  - A precomputed STL (`stl` query param) is shown as-is with no splash and
    no render triggered for it -- status just reads "Precomputed STL
    preview" until the user actually changes a parameter.
  - After "Render & Export STL" completes, the high-res mesh replaces the
    (lower-fidelity) preview mesh in the viewer, in addition to triggering
    the download.
- `css/style.css` -- note: `.viewer-overlay[hidden] { display: none }` is
  load-bearing, not decorative -- `.viewer-overlay { display: flex }` has the
  same specificity as the browser's built-in `[hidden]` rule, and author
  styles win ties, so without that override the `hidden` attribute would be
  silently ignored.

## Known constraints / non-goals

- **No true GPU/OpenCSG-style preview exists or is planned short-term.**
  Investigated this thoroughly (see `docs/opencsg-gpu-preview-plan.md`):
  neither the official `openscad-playground` nor any other known project has
  it working in a browser; OpenSCAD's own lead developer attempted a
  JS+WebGL port and abandoned it. The plan doc has a full phased, agent-ready
  task prompt if this is ever picked up -- treat it as unstarted R&D, not a
  near-term feature.
- Only the file-export WASM pipeline is used (`-o output.stl`), which always
  pays full CGAL/Manifold boolean-evaluation cost -- there's no cheaper
  headless preview mode exposed by the library.

## Running / testing locally

- Needs a real HTTP server (module worker + cross-origin ESM imports don't
  work from `file://`): `php -S 127.0.0.1:PORT -t .` (needed for `index.php`
  to actually execute) or, for pure static asset testing without the PHP
  layer, `python3 -m http.server`.
- No test suite. Verification so far has been manual, via a headless
  Chromium + Chrome DevTools Protocol harness (spawn chromium
  `--headless=new --remote-debugging-port=...`, drive it over the CDP
  WebSocket) since no interactive browser tool was available in-session --
  screenshots + polling `#status`/`#viewer-overlay` computed style were used
  to confirm rendering, overlay visibility, and the precomputed-STL/live-
  render handoff actually work end to end. Re-establish a harness like that
  (or use an interactive browser tool if available) before trusting UI
  changes.
- `spool_custom.scad` (the bundled demo model, a two-part spool with a
  lightweighting hole array) is a good stress test: it's slow enough at high
  `$fn` (full export commonly takes 1-2+ minutes) to make timing regressions
  obvious, and it exercises groups, ranges, a boolean, and derived
  (non-parameter) top-level variables that the parser must correctly exclude
  from the UI.

## Git

Repo was `git init`'d locally (no remote configured). Commit only when asked.
