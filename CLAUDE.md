# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`nvg2svg.py` decodes Nokia NVG files (the Symbian^3 binary vector format) back to SVG. It is a single Python 3 script that uses only the standard library and must stay cross-platform. There is no build, lint config or test suite.

- `SVG2Binary 1.1/` is the reference encoder, a Windows GUI around `libs/svgtbinencode.exe` from the Symbian^3 SDK. `-v 5` produces NVG. The NVG format was reverse-engineered from this binary.
- `examples/*.nvg` are real encoder output and serve as the regression corpus.

## Commands

```
python3 nvg2svg.py examples -d /tmp/out -v      # decode all examples; -v dumps header/offsets/commands to stderr
python3 nvg2svg.py examples/Python.nvg -o -     # single file to stdout
rsvg-convert -w 384 /tmp/out/Python.svg -o /tmp/py.png   # render to check visually
```

A correct decode prints no warnings and no "unused bytes" notes, which means every path block was consumed exactly.

## Architecture

The module docstring of `nvg2svg.py` is the authoritative format spec. Keep it in sync with code changes.

- `NvgFile` parses the header, the offset vector (u16 absolute file offsets to data blocks) and the command stream. It reads path and paint blocks on demand (`read_path`, `read_paint`).
- `SvgBuilder` replays the commands as a state machine. It tracks fill and stroke paint, opacity, ramp, transform and stroke properties, and emits one `<path>` per DRAW_PATH. Gradients go into `<defs>`, deduplicated by (paint block, ramp block).

Non-obvious format facts (all verified in the decompiled encoder):
- Commands are **variable length**: SET_TRANSFORM (0x08), stroke width (0x09) and miter limit (0x0b) are followed by f32 payloads, so the stream must be parsed sequentially.
- The header scale field is **stale**: the encoder writes the header before computing the scale. The scale therefore comes from the datatype via `PATH_DATATYPES`. Datatype 3 means s32 values ×65536 and is the only datatype the encoder emits in practice.
- SET_COLOR_RAMP (0x06) applies to whichever paint (fill or stroke) was set immediately before it.
- SET_TRANSFORM replaces the current transform; it does not concatenate.
- The gradient matrix is stored row-major (a c e b d f).
- The encoder stores opacity 1 (not 255) for gradient strokes. This is handled as fully opaque.

The encoder always names its output `.svgb`, even when the file is NVG. `examples/circles.svgb` and `examples/transform.svgb` are NVG, and `original/` holds their source SVGs. Rendering a source SVG and the decoded SVG with `rsvg-convert` should give identical output (`magick compare -metric AE`). These two files verify arcs (circles become relative SCCWARC segments, 0x13, plus two trailing junk coordinates) and full-matrix transforms (flags 0).

`examples/strokes.svgb` is real SVGB, because `stroke-dasharray` triggered the encoder's fallback, and the decoder rejects it. Strokes (opcodes 0x05, 0x09–0x0b), partial transforms (translate- or scale-only flags) and radial gradients are still inferred only from decompilation.

## Re-inspecting the encoder

Ghidra is installed at `/opt/ghidra/support/analyzeHeadless`. Wine is not installed, so the encoder cannot be run. These are the key functions in `svgtbinencode.exe`:
- `FUN_00415710`: write order (header → offsets → commands → paths → paints)
- `FUN_004179a0`: header
- `FUN_00411bc0`: commands
- `FUN_0041a780`: paths
- `FUN_00418920`: paints and ramps
- `FUN_00412f10`: transform flags
- `FUN_004166b0`: join/cap values
