# NVG Decoder

NVG Decoder converts Nokia NVG files back to SVG. NVG is the binary vector format that Symbian^3 uses for icons and themes.

It runs in the browser, or from the command line with Node.js. It has no dependencies.

## In the browser

`web/index.html` converts files without installing anything. Drop in `.nvg` files or whole folders, preview the results, and download each SVG or all of them as a zip. Decoding runs locally in the browser, so files are never uploaded.

Open the page straight from disk, or serve it with the bundled nginx container:

```
docker compose up -d --build     # http://localhost:8080
```

To use another port, set `PORT` in `.env` (see `.env.example`).

## Command line

```
node web/cli.js icon.nvg                # writes icon.svg next to the input
node web/cli.js a.nvg b.nvg -d out/     # writes out/a.svg and out/b.svg
node web/cli.js icons/                  # converts every .nvg and .svgb in the directory
node web/cli.js icon.nvg -o -           # prints the SVG to stdout
node web/cli.js icon.nvg -v             # also dumps the decoded structure to stderr
```

From your own scripts, use the decoder as a module:

```js
const NVG = require("./web/nvg2svg.js");
const {svg, warnings} = NVG.decode(fs.readFileSync("icon.nvg"), "icon.nvg");
```

`decode` throws `NVG.NvgError` for files it cannot decode.

## Supported features

- Paths, including arcs
- Solid fills and strokes, with opacity
- Linear and radial gradients
- Transforms
- Stroke width, line joins, line caps and miter limit

Files that are actually SVGB (the older Symbian binary format) are rejected. The encoder falls back to SVGB for some inputs, such as SVGs that use `stroke-dasharray`, even when NVG output was requested.

## How it works

The format was reverse-engineered from `svgtbinencode.exe` (run with `-v 5`), the encoder in the Symbian^3 SDK. The comment at the top of `web/nvg2svg.js` documents the file layout, the command opcodes and the encoder's quirks.

Some features were verified against real encoder output: paths, fills, linear gradients, arcs and full-matrix transforms. Others are inferred only from the decompiled encoder: strokes, radial gradients, and translate-only or scale-only transforms. If one of these decodes incorrectly, please open an issue and attach the file.

`node web/check.js examples --fuzz 5000` checks the decoder against the expected outputs in `test/expected/`, and checks that randomly corrupted copies of the examples never crash it. After an intended output change, run it with `--update` and review the diff.