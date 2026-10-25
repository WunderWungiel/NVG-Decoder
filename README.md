# NVG Decoder

`nvg2svg.py` converts Nokia NVG files back to SVG. NVG is the binary vector format that Symbian^3 uses for icons and themes.

It is a single Python 3 script. It needs only the standard library and runs on Windows, macOS and Linux.

## In the browser

`web/index.html` converts files without installing anything. Drop in `.nvg` files or whole folders, preview the results, and download each SVG or all of them as a zip. Decoding runs locally in the browser, so files are never uploaded.

Open the page straight from disk, or serve it with the bundled nginx container:

```
docker compose up -d --build     # http://localhost:8080
```

To use another port, set `PORT` in `.env` (see `.env.example`).

## Command line

```
python3 nvg2svg.py icon.nvg                # writes icon.svg next to the input
python3 nvg2svg.py a.nvg b.nvg -d out/     # writes out/a.svg and out/b.svg
python3 nvg2svg.py icons/                  # converts every .nvg in the directory
python3 nvg2svg.py icon.nvg -o -           # prints the SVG to stdout
python3 nvg2svg.py icon.nvg -v             # also dumps the decoded structure to stderr
```

## Supported features

- Paths, including arcs
- Solid fills and strokes, with opacity
- Linear and radial gradients
- Transforms
- Stroke width, line joins, line caps and miter limit

Files that are actually SVGB (the older Symbian binary format) are rejected. The encoder falls back to SVGB for some inputs, such as SVGs that use `stroke-dasharray`, even when NVG output was requested.

## How it works

The format was reverse-engineered from `svgtbinencode.exe` (run with `-v 5`), the encoder in the Symbian^3 SDK. The module docstring at the top of `nvg2svg.py` documents the file layout, the command opcodes and the encoder's quirks.

Some features were verified against real encoder output: paths, fills, linear gradients, arcs and full-matrix transforms. Others are inferred only from the decompiled encoder: strokes, radial gradients, and translate-only or scale-only transforms. If one of these decodes incorrectly, please open an issue and attach the file.

`web/nvg2svg.js` is a JavaScript port of the decoder for the browser version. `node web/check.js examples --fuzz 5000` checks that it produces exactly the same SVG and warnings as `nvg2svg.py`, on the examples and on randomly corrupted copies of them.