#!/usr/bin/env python3
"""nvg2svg - decode Nokia NVG (Symbian^3 vector graphics) files back to SVG.

Pure Python 3 (standard library only), runs on Windows, macOS and Linux.

Usage:
    nvg2svg.py icon.nvg                  -> icon.svg next to the input
    nvg2svg.py a.nvg b.nvg -d out/       -> out/a.svg, out/b.svg
    nvg2svg.py icons/                    -> every *.nvg in the directory
    nvg2svg.py icon.nvg -o -             -> SVG on stdout
    nvg2svg.py icon.nvg -v               -> also dump the decoded structure

NVG format (as written by svgtbinencode.exe -v 5, reverse-engineered)
=====================================================================
All values are little-endian. Offsets are absolute file positions.

Header (52 bytes)
    0x00  "nvg"
    0x03  u8   version (2)
    0x04  u16  header size (0x34)
    0x06  u16  reserved
    0x08  16 bytes reserved
    0x18  u16  reserved
    0x1a  u16  path datatype (always 3 in practice)
    0x1c  f32  scale  -- stale: the encoder writes the header before it
    0x20  f32  bias      computes the real scale, so we derive the scale
                         from the datatype instead (see PATH_DATATYPES)
    0x24  f32  viewBox x, y, width, height

Offset vector (at header size)
    u16 count, count x u16 offsets of data blocks (paints, ramps, paths),
    padded with a u16 so the command section is 4-byte aligned.

Command section
    u16 count, u16 reserved, then `count` commands. Each starts with a
    u32: opcode in bits 24-31, the rest depends on the opcode:
    0x04 SET_FILL_PAINT    bits 16-23 opacity (0-255), bits 0-15 block index
    0x05 SET_STROKE_PAINT  bits 16-23 opacity (0-255), bits 0-15 block index
    0x06 SET_COLOR_RAMP    bits 0-15 ramp block index; applies to the gradient
                           paint set by the preceding fill/stroke command
    0x07 DRAW_PATH         bits 16-23 paint mode (1 = stroke, 2 = fill),
                           bits 0-15 path block index
    0x08 SET_TRANSFORM     bits 16-23 flags, then f32 payload:
                           flags == 1: identity (no payload)
                           flags == 0: sx sy shx shy tx ty
                           otherwise:  0x08 -> 4 floats (never emitted),
                                       0x02 -> sx sy, 0x04 -> shx shy,
                                       0x10 -> tx ty (in that order)
                           The transform replaces the current one.
    0x09 SET_STROKE_WIDTH  followed by f32 width
    0x0a SET_LINE_JOIN_CAP bits 8-15 join (1 bevel, 2 miter, 3 round),
                           bits 0-7 cap (1 butt, 2 square, 3 round)
    0x0b SET_MITER_LIMIT   followed by f32 limit
    0x00                   no-op (written for a ramp command without ramp)

Path block (4-byte aligned)
    u16 segment count, segment bytes (OpenVG VGPathSegment|VGPathAbsRel:
    0 close, 2 move, 4 line, 6 hline, 8 vline, 10 quad, 12 cubic,
    14 smooth quad, 16 smooth cubic, 18/20/22/24 small-ccw/small-cw/
    large-ccw/large-cw arc; +1 = relative), then the coordinates.
    Datatype 3: aligned to 4, s32 values = coordinate * 65536.
    Circles/ellipses are written as move + two relative arcs + close.

Paint block (4-byte aligned), starts with u32 (flags << 16 | type)
    type 1 flat color: u32 0xRRGGBBAA
    type 2 linear gradient: f32 x1 y1 x2 y2
    type 3 radial gradient: f32 cx cy fx fy r
    For types 2/3 with flags & 1, a gradient matrix follows:
    f32 a c e b d f (row-major), i.e. SVG matrix(a b c d e f).
    Gradients are in user space (userSpaceOnUse).
    type 4 color ramp: stop count in bits 16-23, then per stop
    f32 offset, r, g, b, a (components 0..1).
"""

import argparse
import math
import os
import struct
import sys

__version__ = "1.0"

HEADER_SIZE_MIN = 0x34

# datatype -> (struct code, value size, alignment rule, scale)
# These mirror the encoder's path writer exactly, including its quirks
# (datatype 1 writes unaligned s32, datatype 4 "aligns" with whole s32 words).
PATH_DATATYPES = {
    1: ("i", 4, "none", 1.3),
    2: ("h", 2, "align2", 16.0),
    3: ("i", 4, "align4", 65536.0),
    4: ("i", 4, "words", 1.0),
}

# OpenVG segment index (seg >> 1) -> (SVG command, coordinate count)
SEGMENTS = {
    0: ("Z", 0),
    1: ("M", 2),
    2: ("L", 2),
    3: ("H", 1),
    4: ("V", 1),
    5: ("Q", 4),
    6: ("C", 6),
    7: ("T", 2),
    8: ("S", 4),
    9: ("A", 5),   # small, counter-clockwise
    10: ("A", 5),  # small, clockwise
    11: ("A", 5),  # large, counter-clockwise
    12: ("A", 5),  # large, clockwise
}
# arc segment index -> (large-arc-flag, sweep-flag)
ARC_FLAGS = {9: (0, 1), 10: (0, 0), 11: (1, 1), 12: (1, 0)}

LINE_JOINS = {1: "bevel", 2: "miter", 3: "round"}
LINE_CAPS = {1: "butt", 2: "square", 3: "round"}

PAINT_COLOR, PAINT_LINEAR, PAINT_RADIAL, PAINT_RAMP = 1, 2, 3, 4


class NvgError(Exception):
    pass


def fmt(v):
    """Format a number compactly for SVG output."""
    if not math.isfinite(v):
        return "0"
    s = ("%.4f" % v).rstrip("0").rstrip(".")
    if s in ("-0", ""):
        s = "0"
    return s


def color_hex(r, g, b):
    return "#%02x%02x%02x" % (r, g, b)


def unit_to_byte(v):
    return max(0, min(255, int(round(v * 255))))


class Reader:
    def __init__(self, data):
        self.data = data

    def unpack(self, fmt_, pos):
        size = struct.calcsize(fmt_)
        if pos < 0 or pos + size > len(self.data):
            raise NvgError("unexpected end of file at offset 0x%x" % pos)
        return struct.unpack_from("<" + fmt_, self.data, pos)

    def u8(self, pos):
        return self.unpack("B", pos)[0]

    def u16(self, pos):
        return self.unpack("H", pos)[0]

    def u32(self, pos):
        return self.unpack("I", pos)[0]

    def f32s(self, pos, n):
        return list(self.unpack("%df" % n, pos))


class NvgFile:
    """Parsed NVG file: header, offset vector, commands and data blocks."""

    def __init__(self, data, log=None):
        self.r = Reader(data)
        self.log = log or (lambda msg: None)
        self.warnings = []
        self._parse_header()
        self._parse_offsets()
        self._parse_commands()

    def warn(self, msg):
        self.warnings.append(msg)
        self.log("warning: " + msg)

    # ---- header -------------------------------------------------------

    def _parse_header(self):
        r = self.r
        data = r.data
        if len(data) < 3 or data[:3] != b"nvg":
            raise NvgError("not an NVG file (missing 'nvg' signature; the encoder "
                           "falls back to SVGB for unsupported content)")
        if len(data) < HEADER_SIZE_MIN:
            raise NvgError("file too short for an NVG header")
        self.version = r.u8(3)
        self.header_size = r.u16(4)
        if self.header_size < HEADER_SIZE_MIN:
            raise NvgError("invalid header size %d" % self.header_size)
        if self.version != 2:
            self.warn("NVG version %d is untested (expected 2)" % self.version)
        self.datatype = r.u16(0x1A)
        self.header_scale, self.header_bias = r.f32s(0x1C, 2)
        self.viewbox = r.f32s(0x24, 4)
        if self.datatype not in PATH_DATATYPES:
            raise NvgError("unsupported path datatype %d" % self.datatype)
        self.log("header: version=%d size=0x%x datatype=%d header-scale=%g "
                 "bias=%g viewBox=%s" % (self.version, self.header_size,
                                         self.datatype, self.header_scale,
                                         self.header_bias,
                                         " ".join(fmt(v) for v in self.viewbox)))

    # ---- offset vector ------------------------------------------------

    def _parse_offsets(self):
        pos = self.header_size
        n = self.r.u16(pos)
        self.offsets = list(self.r.unpack("%dH" % n, pos + 2)) if n else []
        pos += 2 + 2 * n
        if pos % 4:
            pos += 4 - pos % 4
        self.cmd_pos = pos
        self.log("offset vector: %d entries: %s" % (
            n, " ".join("%d:0x%x" % (i, o) for i, o in enumerate(self.offsets))))

    def block_offset(self, index):
        if index >= len(self.offsets):
            raise NvgError("data block index %d out of range" % index)
        off = self.offsets[index]
        if off == 0 or off >= len(self.r.data):
            raise NvgError("data block %d has invalid offset 0x%x" % (index, off))
        return off

    def block_end(self, off):
        """End of the block at `off`: the next block start or end of file."""
        later = [o for o in self.offsets if o > off]
        return min(later) if later else len(self.r.data)

    # ---- commands -----------------------------------------------------

    def _parse_commands(self):
        r = self.r
        pos = self.cmd_pos
        count = r.u16(pos)
        pos += 4
        self.commands = []
        for _ in range(count):
            word = r.u32(pos)
            pos += 4
            op = word >> 24
            cmd = {"op": op, "word": word}
            if op in (0x04, 0x05):
                cmd["opacity"] = (word >> 16) & 0xFF
                cmd["index"] = word & 0xFFFF
            elif op == 0x06:
                cmd["index"] = word & 0xFFFF
            elif op == 0x07:
                cmd["mode"] = (word >> 16) & 0xFF
                cmd["index"] = word & 0xFFFF
            elif op == 0x08:
                flags = (word >> 16) & 0xFF
                cmd["flags"] = flags
                cmd["matrix"], pos = self._read_transform(flags, pos)
            elif op in (0x09, 0x0B):
                cmd["value"] = r.f32s(pos, 1)[0]
                pos += 4
            elif op == 0x0A:
                cmd["join"] = (word >> 8) & 0xFF
                cmd["cap"] = word & 0xFF
            elif op != 0x00:
                self.warn("unknown command 0x%08x at 0x%x, ignored" % (word, pos - 4))
            self.commands.append(cmd)
        self.cmd_end = pos

    def _read_transform(self, flags, pos):
        """Return ([a, b, c, d, e, f] in SVG matrix order, new pos)."""
        sx, sy, shx, shy, tx, ty = 1.0, 1.0, 0.0, 0.0, 0.0, 0.0
        if flags == 1:
            return None, pos
        if flags == 0:
            sx, sy, shx, shy, tx, ty = self.r.f32s(pos, 6)
            pos += 24
        else:
            if flags & 0x08:
                sx, sy, shx, shy = self.r.f32s(pos, 4)
                pos += 16
            else:
                if flags & 0x02:
                    sx, sy = self.r.f32s(pos, 2)
                    pos += 8
                if flags & 0x04:
                    shx, shy = self.r.f32s(pos, 2)
                    pos += 8
            if flags & 0x10:
                tx, ty = self.r.f32s(pos, 2)
                pos += 8
        return [sx, shy, shx, sy, tx, ty], pos

    # ---- data blocks --------------------------------------------------

    def read_path(self, index):
        """Return the SVG path data string for path block `index`."""
        r = self.r
        off = self.block_offset(index)
        nseg = r.u16(off)
        segs = r.unpack("%dB" % nseg, off + 2) if nseg else ()
        pos = off + 2 + nseg
        code, size, align, scale = PATH_DATATYPES[self.datatype]
        if align == "align2":
            pos += pos % 2
        elif align == "align4":
            if pos % 4:
                pos += 4 - pos % 4
        elif align == "words":
            pos += 4 * (pos % 4)

        parts = []
        for seg in segs:
            kind = seg >> 1
            rel = seg & 1
            if kind not in SEGMENTS:
                raise NvgError("path %d: unknown segment type %d" % (index, seg))
            letter, ncoord = SEGMENTS[kind]
            vals = [v / scale for v in r.unpack("%d%s" % (ncoord, code), pos)] \
                if ncoord else []
            pos += ncoord * size
            if letter == "A":
                rx, ry, rot, x, y = vals
                large, sweep = ARC_FLAGS[kind]
                vals_s = [fmt(abs(rx)), fmt(abs(ry)), fmt(rot), str(large),
                          str(sweep), fmt(x), fmt(y)]
            else:
                vals_s = [fmt(v) for v in vals]
            if letter == "Z":
                parts.append("Z")
            else:
                parts.append((letter.lower() if rel else letter) + " ".join(vals_s))
        end = self.block_end(off)
        if pos > end:
            self.warn("path %d overruns its block (0x%x > 0x%x)" % (index, pos, end))
        elif end - pos >= 4 * size and index != self._last_path_index():
            self.log("note: path %d has %d unused bytes" % (index, end - pos))
        return " ".join(parts)

    def _last_path_index(self):
        return max(range(len(self.offsets)), key=lambda i: self.offsets[i])

    def read_paint(self, index):
        r = self.r
        off = self.block_offset(index)
        head = r.u32(off)
        ptype = head & 0xFFFF
        flags = head >> 16
        paint = {"type": ptype, "index": index}
        pos = off + 4
        if ptype == PAINT_COLOR:
            rgba = r.u32(pos)
            paint["rgb"] = ((rgba >> 24) & 0xFF, (rgba >> 16) & 0xFF, (rgba >> 8) & 0xFF)
            paint["alpha"] = rgba & 0xFF
        elif ptype in (PAINT_LINEAR, PAINT_RADIAL):
            n = 4 if ptype == PAINT_LINEAR else 5
            paint["coords"] = r.f32s(pos, n)
            pos += 4 * n
            paint["matrix"] = None
            if flags & 1:
                a, c, e, b, d, f = r.f32s(pos, 6)
                paint["matrix"] = [a, b, c, d, e, f]
        elif ptype == PAINT_RAMP:
            nstops = flags & 0xFF
            vals = r.f32s(pos, 5 * nstops) if nstops else []
            paint["stops"] = [vals[i:i + 5] for i in range(0, len(vals), 5)]
        else:
            raise NvgError("block %d: unknown paint type %d" % (index, ptype))
        return paint


class SvgBuilder:
    """Replays NVG commands and produces SVG markup."""

    def __init__(self, nvg, source_name=None):
        self.nvg = nvg
        self.source_name = source_name
        self.defs = []
        self.body = []
        self.gradient_ids = {}
        self.paint_cache = {}
        # graphics state (OpenVG defaults == SVG defaults)
        self.fill = None          # (paint, opacity byte, ramp index)
        self.stroke = None
        self.last_paint = None    # "fill" or "stroke", target of SET_COLOR_RAMP
        self.transform = None
        self.stroke_width = 1.0
        self.join = 2
        self.cap = 1
        self.miter = 4.0

    def paint(self, index):
        if index not in self.paint_cache:
            self.paint_cache[index] = self.nvg.read_paint(index)
        return self.paint_cache[index]

    def gradient_ref(self, paint, ramp_index):
        key = (paint["index"], ramp_index)
        if key in self.gradient_ids:
            return self.gradient_ids[key]
        gid = "g%d" % (len(self.gradient_ids) + 1)
        self.gradient_ids[key] = gid
        c = paint["coords"]
        if paint["type"] == PAINT_LINEAR:
            attrs = 'x1="%s" y1="%s" x2="%s" y2="%s"' % tuple(fmt(v) for v in c)
            tag = "linearGradient"
        else:
            cx, cy, fx, fy, r = c
            attrs = 'cx="%s" cy="%s" r="%s"' % (fmt(cx), fmt(cy), fmt(r))
            if (fmt(fx), fmt(fy)) != (fmt(cx), fmt(cy)):
                attrs += ' fx="%s" fy="%s"' % (fmt(fx), fmt(fy))
            tag = "radialGradient"
        attrs += ' gradientUnits="userSpaceOnUse"'
        if paint["matrix"]:
            attrs += ' gradientTransform="matrix(%s)"' % " ".join(fmt(v) for v in paint["matrix"])
        stops = []
        if ramp_index is not None:
            ramp = self.paint(ramp_index)
            if ramp["type"] != PAINT_RAMP:
                self.nvg.warn("block %d is not a color ramp" % ramp_index)
            else:
                for off, rr, gg, bb, aa in ramp["stops"]:
                    s = '<stop offset="%s" stop-color="%s"' % (
                        fmt(off), color_hex(unit_to_byte(rr), unit_to_byte(gg), unit_to_byte(bb)))
                    if aa < 1.0:
                        s += ' stop-opacity="%s"' % fmt(aa)
                    stops.append("      " + s + "/>")
        else:
            self.nvg.warn("gradient paint %d has no color ramp" % paint["index"])
        self.defs.append("    <%s id=\"%s\" %s>\n%s\n    </%s>" % (
            tag, gid, attrs, "\n".join(stops), tag) if stops else
            "    <%s id=\"%s\" %s/>" % (tag, gid, attrs))
        return gid

    def paint_attrs(self, which, state):
        """SVG attributes for fill or stroke given (paint, opacity, ramp)."""
        if state is None:
            # nothing set yet: OpenVG/SVG default paint is opaque black
            return ['%s="#000000"' % which]
        paint, opacity, ramp = state
        if paint["type"] == PAINT_COLOR:
            alpha = paint["alpha"] / 255.0 * opacity / 255.0
            attrs = ['%s="%s"' % (which, color_hex(*paint["rgb"]))]
        elif paint["type"] in (PAINT_LINEAR, PAINT_RADIAL):
            attrs = ['%s="url(#%s)"' % (which, self.gradient_ref(paint, ramp))]
            # The encoder stores 1 (not 255) as the opacity of gradient
            # strokes; treat it as fully opaque.
            alpha = 1.0 if opacity == 1 else opacity / 255.0
        else:
            self.nvg.warn("paint block %d is not a fill/stroke paint" % paint["index"])
            return ['%s="#000000"' % which]
        if alpha < 1.0:
            attrs.append('%s-opacity="%s"' % (which, fmt(alpha)))
        return attrs

    def draw(self, cmd):
        d = self.nvg.read_path(cmd["index"])
        mode = cmd["mode"]
        attrs = ['d="%s"' % d]
        if mode & 2:
            attrs += self.paint_attrs("fill", self.fill)
        else:
            attrs.append('fill="none"')
        if mode & 1:
            attrs += self.paint_attrs("stroke", self.stroke)
            if self.stroke_width != 1.0:
                attrs.append('stroke-width="%s"' % fmt(self.stroke_width))
            if self.join != 2:
                attrs.append('stroke-linejoin="%s"' % LINE_JOINS.get(self.join, "miter"))
            if self.cap != 1:
                attrs.append('stroke-linecap="%s"' % LINE_CAPS.get(self.cap, "butt"))
            if self.miter != 4.0:
                attrs.append('stroke-miterlimit="%s"' % fmt(self.miter))
        if self.transform:
            attrs.append('transform="matrix(%s)"' % " ".join(fmt(v) for v in self.transform))
        self.body.append("  <path %s/>" % " ".join(attrs))

    def run(self):
        log = self.nvg.log
        for cmd in self.nvg.commands:
            op = cmd["op"]
            if op in (0x04, 0x05):
                which = "fill" if op == 0x04 else "stroke"
                state = (self.paint(cmd["index"]), cmd["opacity"], None)
                setattr(self, which, state)
                self.last_paint = which
                log("cmd SET_%s_PAINT block=%d opacity=%d" % (
                    which.upper(), cmd["index"], cmd["opacity"]))
            elif op == 0x06:
                log("cmd SET_COLOR_RAMP block=%d" % cmd["index"])
                state = getattr(self, self.last_paint) if self.last_paint else None
                if state is None:
                    self.nvg.warn("color ramp without a preceding paint")
                else:
                    setattr(self, self.last_paint, (state[0], state[1], cmd["index"]))
            elif op == 0x07:
                log("cmd DRAW_PATH block=%d mode=%d" % (cmd["index"], cmd["mode"]))
                self.draw(cmd)
            elif op == 0x08:
                self.transform = cmd["matrix"]
                log("cmd SET_TRANSFORM flags=0x%x %s" % (cmd["flags"], cmd["matrix"]))
            elif op == 0x09:
                self.stroke_width = cmd["value"]
                log("cmd SET_STROKE_WIDTH %g" % cmd["value"])
            elif op == 0x0A:
                self.join, self.cap = cmd["join"], cmd["cap"]
                log("cmd SET_LINE_JOIN_CAP join=%d cap=%d" % (cmd["join"], cmd["cap"]))
            elif op == 0x0B:
                self.miter = cmd["value"]
                log("cmd SET_MITER_LIMIT %g" % cmd["value"])
        return self.render()

    def render(self):
        x, y, w, h = self.nvg.viewbox
        out = ['<?xml version="1.0" encoding="UTF-8"?>']
        if self.source_name:
            name = self.source_name.replace("--", "- -")
            out.append("<!-- Decoded from %s by nvg2svg %s -->" % (name, __version__))
        out.append('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
                   'width="%s" height="%s" viewBox="%s %s %s %s">'
                   % (fmt(w), fmt(h), fmt(x), fmt(y), fmt(w), fmt(h)))
        if self.defs:
            out.append("  <defs>")
            out.extend(self.defs)
            out.append("  </defs>")
        out.extend(self.body)
        out.append("</svg>")
        return "\n".join(out) + "\n"


def decode(data, source_name=None, log=None):
    """Decode NVG bytes and return (svg_text, warnings)."""
    nvg = NvgFile(data, log=log)
    svg = SvgBuilder(nvg, source_name).run()
    return svg, nvg.warnings


def collect_inputs(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            found = sorted(os.path.join(p, f) for f in os.listdir(p)
                           if f.lower().endswith(".nvg")
                           and os.path.isfile(os.path.join(p, f)))
            if not found:
                print("nvg2svg: no .nvg files in %s" % p, file=sys.stderr)
            files.extend(found)
        else:
            files.append(p)
    return files


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="nvg2svg",
        description="Decode Nokia NVG vector graphics files (Symbian^3, "
                    "svgtbinencode -v 5) back to SVG.")
    ap.add_argument("inputs", nargs="+", metavar="INPUT",
                    help="NVG file(s) or directories containing .nvg files")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("-o", "--output", metavar="FILE",
                       help="output SVG file ('-' for stdout); single input only")
    group.add_argument("-d", "--outdir", metavar="DIR",
                       help="directory to write the SVG files into")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="print the decoded NVG structure to stderr")
    ap.add_argument("--version", action="version", version="%(prog)s " + __version__)
    args = ap.parse_args(argv)

    files = collect_inputs(args.inputs)
    if args.output and len(files) != 1:
        ap.error("-o/--output needs exactly one input file")
    if args.outdir:
        os.makedirs(args.outdir, exist_ok=True)

    failures = 0
    for path in files:
        def log(msg, _p=path):
            if args.verbose:
                print("%s: %s" % (_p, msg), file=sys.stderr)
        try:
            with open(path, "rb") as fh:
                data = fh.read()
            svg, warnings = decode(data, os.path.basename(path), log)
        except (OSError, NvgError) as exc:
            print("nvg2svg: %s: %s" % (path, exc), file=sys.stderr)
            failures += 1
            continue
        if not args.verbose:
            for w in warnings:
                print("nvg2svg: %s: warning: %s" % (path, w), file=sys.stderr)

        if args.output == "-":
            sys.stdout.write(svg)
            continue
        if args.output:
            out_path = args.output
        else:
            base = os.path.splitext(os.path.basename(path))[0] + ".svg"
            out_path = os.path.join(args.outdir or os.path.dirname(path), base)
        try:
            with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(svg)
        except OSError as exc:
            print("nvg2svg: %s: %s" % (out_path, exc), file=sys.stderr)
            failures += 1
            continue
        print("%s -> %s" % (path, out_path), file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
