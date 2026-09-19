# web-customizer

An in-browser OpenSCAD Customizer. It parses the OpenSCAD Customizer
convention out of a `.scad` file, renders a parameter UI, shows a live
navigable 3D preview, and exports a full-resolution STL — all computed
client-side via WebAssembly, with no backend rendering.

This project is derived from and built around [OpenSCAD](https://openscad.org/),
using [`openscad-wasm-prebuilt`](https://cdn.jsdelivr.net/npm/openscad-wasm-prebuilt)
to run OpenSCAD itself in a Web Worker, and follows OpenSCAD's own
[Customizer](https://openscad.org/customizer/) comment conventions to build
the parameter UI.

## Running locally

A real HTTP server is required (module worker + cross-origin ESM imports
don't work from `file://`):

```sh
php -S 127.0.0.1:PORT -t .
```

This is needed for `index.php` to actually execute. For pure static asset
testing without the PHP layer, `python3 -m http.server` also works.

See `CLAUDE.md` for architecture notes and known issues.

## License

GPLv2. See [`LICENSE`](LICENSE).
