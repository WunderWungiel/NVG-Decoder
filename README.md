# NVG Decoder

NVG Decoder converts Nokia NVG and SVGB files back to SVG. These are the binary vector formats that Symbian uses for icons and themes: NVG on Symbian^3, SVGB on earlier S60 versions.

It runs in the browser, or from the command line with Node.js. It has no dependencies.

## In the browser

`web/index.html` converts files without installing anything. Drop in `.nvg` and `.svgb` files or whole folders, preview the results, and download each SVG or all of them as a zip. Decoding runs locally in the browser, so files are never uploaded.

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

NVG:

- Paths, including arcs
- Solid fills and strokes, with opacity
- Linear and radial gradients
- Transforms
- Stroke width, line joins, line caps and miter limit

SVGB (all four variants: S60v3 BGR float and fixed point, S60v3 FP2, Symbian^3 RGB float):

- Shapes, paths and groups
- Solid and gradient paint, with opacity
- Transforms
- Stroke properties, including dashes
- Text, including SVG fonts
- Links, `use`, `switch`, and embedded or linked images
- Basic animation (`attributeName`, `from`/`to`/`by`, `dur`, `repeatDur`, `calcMode`, `fill`, `additive`, `accumulate`, `restart`)

Files that use `begin`, `end`, `values`, `keyTimes`, `keySplines`, `repeatCount`, `animateTransform` or `animateMotion` stop with an error naming the attribute, because their encoding is not known yet.

Some SVG features are lost when the encoder writes SVGB, so they cannot come back: arcs (written as empty paths), gradient strokes (written black), `letter-spacing`, `word-spacing`, `dx`/`dy`, `textLength`, the text of `<title>` and `<desc>`, and text longer than 127 characters (cut short).

Both formats are recognised by their content, not their extension. The SDK encoder names NVG output `.svgb` too, and falls back to SVGB for some inputs, such as SVGs that use `stroke-dasharray`.

## How it works

NVG was reverse-engineered from `svgtbinencode.exe` (run with `-v 5`), the encoder in the Symbian^3 SDK. SVGB was reverse-engineered from the same encoder and from `debug.exe`, the decoder inside the community SVG/SVGB converter. The comment at the top of `web/nvg2svg.js` documents both file layouts and the encoder's quirks.

For NVG, some features were verified against real encoder output: paths, fills, linear gradients, arcs and full-matrix transforms. Others are inferred only from the decompiled encoder: strokes, radial gradients, and translate-only or scale-only transforms. For SVGB, the decoded examples render identically to reference SVGs, and `test/svgb/` holds SVGs for checking the remaining attributes. If anything decodes incorrectly, please open an issue and attach the file.

`node web/check.js examples test/svgb --fuzz 5000` checks the decoder against the expected outputs in `test/expected/`, and checks that randomly corrupted copies of the examples never crash it. After an intended output change, run it with `--update` and review the diff.