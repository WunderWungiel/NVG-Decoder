/* nvg2svg.js - decode Nokia NVG and SVGB (Symbian vector graphics) files back to SVG.
 *
 * Works as a classic <script> (defines window.NVG2SVG) and as a CommonJS
 * module, so index.html also runs from file:// without a server. cli.js is
 * the command-line front end, check.js the regression and fuzz test.
 *
 * This comment is the authoritative format spec; keep it in sync with the code.
 *
 * NVG format (as written by svgtbinencode.exe -v 5, reverse-engineered)
 * =====================================================================
 * All values are little-endian. Offsets are absolute file positions.
 *
 * Header (52 bytes)
 *     0x00  "nvg"
 *     0x03  u8   version (2)
 *     0x04  u16  header size (0x34)
 *     0x06  u16  reserved
 *     0x08  16 bytes reserved
 *     0x18  u16  reserved
 *     0x1a  u16  path datatype (always 3 in practice)
 *     0x1c  f32  scale  -- stale: the encoder writes the header before it
 *     0x20  f32  bias      computes the real scale, so we derive the scale
 *                          from the datatype instead (see PATH_DATATYPES)
 *     0x24  f32  viewBox x, y, width, height
 *
 * Offset vector (at header size)
 *     u16 count, count x u16 offsets of data blocks (paints, ramps, paths),
 *     padded with a u16 so the command section is 4-byte aligned.
 *
 * Command section
 *     u16 count, u16 reserved, then `count` commands. Each starts with a
 *     u32: opcode in bits 24-31, the rest depends on the opcode:
 *     0x04 SET_FILL_PAINT    bits 16-23 opacity (0-255), bits 0-15 block index
 *     0x05 SET_STROKE_PAINT  bits 16-23 opacity (0-255), bits 0-15 block index
 *     0x06 SET_COLOR_RAMP    bits 0-15 ramp block index; applies to the gradient
 *                            paint set by the preceding fill/stroke command
 *     0x07 DRAW_PATH         bits 16-23 paint mode (1 = stroke, 2 = fill),
 *                            bits 0-15 path block index
 *     0x08 SET_TRANSFORM     bits 16-23 flags, then f32 payload:
 *                            flags == 1: identity (no payload)
 *                            flags == 0: sx sy shx shy tx ty
 *                            otherwise:  0x08 -> 4 floats (never emitted),
 *                                        0x02 -> sx sy, 0x04 -> shx shy,
 *                                        0x10 -> tx ty (in that order)
 *                            The transform replaces the current one.
 *     0x09 SET_STROKE_WIDTH  followed by f32 width
 *     0x0a SET_LINE_JOIN_CAP bits 8-15 join (1 bevel, 2 miter, 3 round),
 *                            bits 0-7 cap (1 butt, 2 square, 3 round)
 *     0x0b SET_MITER_LIMIT   followed by f32 limit
 *     0x00                   no-op (written for a ramp command without ramp)
 *
 * Path block (4-byte aligned)
 *     u16 segment count, segment bytes (OpenVG VGPathSegment|VGPathAbsRel:
 *     0 close, 2 move, 4 line, 6 hline, 8 vline, 10 quad, 12 cubic,
 *     14 smooth quad, 16 smooth cubic, 18/20/22/24 small-ccw/small-cw/
 *     large-ccw/large-cw arc; +1 = relative), then the coordinates.
 *     Datatype 3: aligned to 4, s32 values = coordinate * 65536.
 *     Circles/ellipses are written as move + two relative arcs + close.
 *
 * Paint block (4-byte aligned), starts with u32 (flags << 16 | type)
 *     type 1 flat color: u32 0xRRGGBBAA
 *     type 2 linear gradient: f32 x1 y1 x2 y2
 *     type 3 radial gradient: f32 cx cy fx fy r
 *     For types 2/3 with flags & 1, a gradient matrix follows:
 *     f32 a c e b d f (row-major), i.e. SVG matrix(a b c d e f).
 *     Gradients are in user space (userSpaceOnUse).
 *     type 4 color ramp: stop count in bits 16-23, then per stop
 *     f32 offset, r, g, b, a (components 0..1).
 *
 * SVGB format (Symbian SVG-T binary, reverse-engineered from debug.exe of the
 * SVG/SVGB converter and svgtbinencode.exe)
 * ========================================================================
 * A serialized SVG element tree. All values are little-endian.
 *
 *     u32 magic 0x03FA56CC + format (0-3). Formats 1 and 2 store numbers as
 *         s32 / 65536, formats 0 and 3 as f32. Only format 2 has been seen.
 *     then a stream of tokens:
 *         0x00-0x30  element (SVGB_ELEMENTS), followed by its attributes:
 *                    u16 attribute id + value, until the u16 1000. If the next
 *                    byte is 0xfe the element is empty and the 0xfe is
 *                    consumed; otherwise its children follow.
 *         0xfd       text content: string
 *         0xfe       end of the current element
 *         0xff       end of file
 *
 * Attribute values (SVGB_ATTRS gives the type of each id):
 *     number   s32 / 65536 or f32, see above
 *     string   u8 byte length, UTF-16LE text. The encoder truncates the length
 *              to 8 bits, so longer text is cut short in the file itself.
 *     strings  (systemLanguage, requiredFeatures/Extensions) u8 count, strings
 *     color    u32 0x00RRGGBB (0x00BBGGRR in formats 0 and 1);
 *              0x01FFFFFF none, 0x02FFFFFF currentColor
 *     paint    (fill) u8 flag: 0 color, 1 string id of a gradient (url(#id)).
 *              stroke is a plain color: the encoder writes gradient strokes black.
 *     size     (width, height) on <svg> a u8 percentage flag, then a number;
 *              on other elements just a number
 *     coord    (x, y) a number; on <text> a u8 count and numbers
 *     enum     u32 index (u8 for spreadMethod, gradientUnits, zoomAndPan,
 *              restart, calcMode)
 *     list     (stroke-dasharray) u8 count, numbers
 *     floats   (rotate) u8 count, f32 values even in fixed-point files
 *     transform  6 numbers a c e b d f (row-major), then u32 transform type;
 *              gradientTransform has the 6 numbers only
 *     path     (d, points) u16 segment count, one u8 per segment
 *              (0 M, 1 L, 2 Q, 3 C, 4 Z; absolute), u16 coordinate count,
 *              numbers. points ignores the segment types. The encoder writes
 *              arcs as an empty path.
 *     href     (xlink:href, 109) string; a local reference "#id" is followed
 *              by a second string with the bare id
 *     data     (xlink:href, 136, used for data: URIs) u32 byte length, 8-bit text
 * Animation attributes:
 *     attributeName  u16 attribute id, then (except on animateTransform) a u8
 *              value type. 0xFFFF: an attribute the encoder cannot animate
 *              (opacity, stroke-dasharray, ...); its values are integers.
 *     from, to, by, values  u8 value type (SVGB_ANIM_TYPES: 0 integer,
 *              2 color, 3/0x62 number, 7 path, 0x35 display, 0x45 visibility),
 *              then the value; values has a u16 count before the values.
 *              On animateTransform there is no type: each value is 3 numbers
 *              (f32 for from, fixed/float as usual otherwise), values has a
 *              u16 count, and type (80) is a u8 code (0x1F translate,
 *              0x20 rotate, 0x21 scale, 0x22 skewX, 0x23 skewY) and a u8 count
 *              of the numbers that are used.
 *     begin    u8 1 for indefinite. Otherwise u8 count, then per value
 *              s32 time (ms), s32 offset (ms), 4 junk bytes, string element
 *              id ("unid" when none), 2 junk bytes, u8 event (SVGB_EVENTS,
 *              0xFF for a plain clock value); then u8 n, n s32 resolved
 *              times and 9 more bytes computed by the encoder.
 *     end      u8 0, u8 event, 4 junk bytes, string element id, s32 time
 *              (clock value) or offset (event)
 *     dur, repeatDur  s32 milliseconds, 0x7FFFFFFF indefinite; dur is
 *              followed by a u8 (always 0 so far)
 *     repeatCount  u32 whole count (the encoder drops fractions), 0xFFFF
 *              indefinite
 *     keyTimes u16 count, u16 values of time * 255
 *     calcMode, restart  u8 enums
 *     accumulate (116), additive (117), fill (135): no value; present means
 *              sum, sum and freeze
 *     animateMotion: the path (or from/to/values, which the encoder turns
 *              into a path) is attribute 122: a path, then a u8 (0x94 when
 *              an <mpath> child gives the path and the path is empty).
 *              rotate is an s16: degrees, -100 auto, -200 auto-reverse.
 *              <mpath> has a u8 1 between its href and the repeated id.
 *     keySplines is written as a precomputed curve table whose length is not
 *              understood yet.
 * Attribute ids whose value encoding is not known yet stop decoding with an
 * error, since their length is unknown.
 */
(function (root) {
  "use strict";

  var VERSION = "1.0";

  var HEADER_SIZE_MIN = 0x34;

  // datatype -> [value size, alignment rule, scale, signed reader]
  // These mirror the encoder's path writer exactly, including its quirks
  // (datatype 1 writes unaligned s32, datatype 4 "aligns" with whole s32 words).
  var PATH_DATATYPES = {
    1: [4, "none", 1.3, "s32"],
    2: [2, "align2", 16.0, "s16"],
    3: [4, "align4", 65536.0, "s32"],
    4: [4, "words", 1.0, "s32"]
  };

  // OpenVG segment index (seg >> 1) -> [SVG command, coordinate count]
  var SEGMENTS = {
    0: ["Z", 0],
    1: ["M", 2],
    2: ["L", 2],
    3: ["H", 1],
    4: ["V", 1],
    5: ["Q", 4],
    6: ["C", 6],
    7: ["T", 2],
    8: ["S", 4],
    9: ["A", 5],   // small, counter-clockwise
    10: ["A", 5],  // small, clockwise
    11: ["A", 5],  // large, counter-clockwise
    12: ["A", 5]   // large, clockwise
  };
  // arc segment index -> [large-arc-flag, sweep-flag]
  var ARC_FLAGS = {9: [0, 1], 10: [0, 0], 11: [1, 1], 12: [1, 0]};

  var LINE_JOINS = {1: "bevel", 2: "miter", 3: "round"};
  var LINE_CAPS = {1: "butt", 2: "square", 3: "round"};

  var PAINT_COLOR = 1, PAINT_LINEAR = 2, PAINT_RADIAL = 3, PAINT_RAMP = 4;

  function NvgError(message) {
    this.name = "NvgError";
    this.message = message;
  }
  NvgError.prototype = Object.create(Error.prototype);
  NvgError.prototype.constructor = NvgError;

  function hex(n) {
    return n.toString(16);
  }

  // "%.4f" with exact ties rounded half-to-even (as the original Python
  // decoder did, so outputs stay stable); toFixed() rounds them away from zero. A double is an exact tie at the 5th decimal only when it
  // is an odd multiple of 1/32, which datatype 3 coordinates (n / 65536)
  // easily are, so handle that case by hand.
  function fixed4(v) {
    var n = v * 32;
    if (Number.isInteger(n) && n % 2 !== 0 && Math.abs(n) < 2e12) {
      var t = Math.abs(n) * 625;  // |v| * 10^4 * 2, odd
      var q = (t - 1) / 2;
      if (q % 2) q += 1;
      var s = String(q);
      while (s.length < 5) s = "0" + s;
      return (v < 0 ? "-" : "") + s.slice(0, -4) + "." + s.slice(-4);
    }
    // toFixed() switches to exponent notation from 1e21; such doubles are
    // integers, so print them exactly.
    if (Math.abs(v) >= 1e21) return BigInt(v).toString() + ".0000";
    return v.toFixed(4);
  }

  // Format a number compactly for SVG output.
  function fmt(v) {
    if (!isFinite(v)) return "0";
    var s = fixed4(v).replace(/0+$/, "").replace(/\.+$/, "");
    if (s === "-0" || s === "") s = "0";
    return s;
  }

  // printf's %g, for log messages only.
  function fmtG(v) {
    if (!isFinite(v)) return String(v).toLowerCase();
    var s = Number(v.toPrecision(6)).toString();
    return s.replace(/e([+-])(\d)$/, "e$10$2");
  }

  function colorHex(r, g, b) {
    return "#" + [r, g, b].map(function (c) {
      return (c < 16 ? "0" : "") + c.toString(16);
    }).join("");
  }

  // Round half to even.
  function roundHalfEven(x) {
    var r = Math.round(x);
    if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
    return r;
  }

  function unitToByte(v) {
    if (!(v > 0)) return 0;  // also catches NaN
    if (v >= 1) return 255;
    return roundHalfEven(v * 255);
  }

  function Reader(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  Reader.prototype.check = function (pos, size) {
    if (pos < 0 || pos + size > this.data.length) {
      throw new NvgError("unexpected end of file at offset 0x" + hex(pos));
    }
  };
  Reader.prototype.u8 = function (pos) {
    this.check(pos, 1);
    return this.view.getUint8(pos);
  };
  Reader.prototype.u16 = function (pos) {
    this.check(pos, 2);
    return this.view.getUint16(pos, true);
  };
  Reader.prototype.u32 = function (pos) {
    this.check(pos, 4);
    return this.view.getUint32(pos, true);
  };
  Reader.prototype.u16s = function (pos, n) {
    this.check(pos, 2 * n);
    var out = [];
    for (var i = 0; i < n; i++) out.push(this.view.getUint16(pos + 2 * i, true));
    return out;
  };
  Reader.prototype.u8s = function (pos, n) {
    this.check(pos, n);
    return Array.prototype.slice.call(this.data, pos, pos + n);
  };
  Reader.prototype.f32s = function (pos, n) {
    this.check(pos, 4 * n);
    var out = [];
    for (var i = 0; i < n; i++) out.push(this.view.getFloat32(pos + 4 * i, true));
    return out;
  };
  Reader.prototype.ints = function (kind, pos, n) {
    var size = kind === "s16" ? 2 : 4;
    this.check(pos, size * n);
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(kind === "s16" ? this.view.getInt16(pos + 2 * i, true)
                              : this.view.getInt32(pos + 4 * i, true));
    }
    return out;
  };

  // Parsed NVG file: header, offset vector, commands and data blocks.
  function NvgFile(data, log) {
    this.r = new Reader(data);
    this.log = log || function () {};
    this.warnings = [];
    this.parseHeader();
    this.parseOffsets();
    this.parseCommands();
  }

  NvgFile.prototype.warn = function (msg) {
    this.warnings.push(msg);
    this.log("warning: " + msg);
  };

  // ---- header -------------------------------------------------------

  NvgFile.prototype.parseHeader = function () {
    var r = this.r, data = r.data;
    if (data.length < 3 || data[0] !== 0x6e || data[1] !== 0x76 || data[2] !== 0x67) {
      throw new NvgError("not an NVG file (missing 'nvg' signature; the encoder " +
                         "falls back to SVGB for unsupported content)");
    }
    if (data.length < HEADER_SIZE_MIN) {
      throw new NvgError("file too short for an NVG header");
    }
    this.version = r.u8(3);
    this.headerSize = r.u16(4);
    if (this.headerSize < HEADER_SIZE_MIN) {
      throw new NvgError("invalid header size " + this.headerSize);
    }
    if (this.version !== 2) {
      this.warn("NVG version " + this.version + " is untested (expected 2)");
    }
    this.datatype = r.u16(0x1A);
    var sb = r.f32s(0x1C, 2);
    this.headerScale = sb[0];
    this.headerBias = sb[1];
    this.viewbox = r.f32s(0x24, 4);
    if (!PATH_DATATYPES.hasOwnProperty(this.datatype)) {
      throw new NvgError("unsupported path datatype " + this.datatype);
    }
    this.log("header: version=" + this.version + " size=0x" + hex(this.headerSize) +
             " datatype=" + this.datatype + " header-scale=" + fmtG(this.headerScale) +
             " bias=" + fmtG(this.headerBias) + " viewBox=" + this.viewbox.map(fmt).join(" "));
  };

  // ---- offset vector ------------------------------------------------

  NvgFile.prototype.parseOffsets = function () {
    var pos = this.headerSize;
    var n = this.r.u16(pos);
    this.offsets = n ? this.r.u16s(pos + 2, n) : [];
    pos += 2 + 2 * n;
    if (pos % 4) pos += 4 - pos % 4;
    this.cmdPos = pos;
    this.log("offset vector: " + n + " entries: " + this.offsets.map(function (o, i) {
      return i + ":0x" + hex(o);
    }).join(" "));
  };

  NvgFile.prototype.blockOffset = function (index) {
    if (index >= this.offsets.length) {
      throw new NvgError("data block index " + index + " out of range");
    }
    var off = this.offsets[index];
    if (off === 0 || off >= this.r.data.length) {
      throw new NvgError("data block " + index + " has invalid offset 0x" + hex(off));
    }
    return off;
  };

  // End of the block at `off`: the next block start or end of file.
  NvgFile.prototype.blockEnd = function (off) {
    var end = null;
    this.offsets.forEach(function (o) {
      if (o > off && (end === null || o < end)) end = o;
    });
    return end === null ? this.r.data.length : end;
  };

  // ---- commands -----------------------------------------------------

  NvgFile.prototype.parseCommands = function () {
    var r = this.r;
    var pos = this.cmdPos;
    var count = r.u16(pos);
    pos += 4;
    this.commands = [];
    for (var i = 0; i < count; i++) {
      var word = r.u32(pos);
      pos += 4;
      var op = word >>> 24;
      var cmd = {op: op, word: word};
      if (op === 0x04 || op === 0x05) {
        cmd.opacity = (word >>> 16) & 0xFF;
        cmd.index = word & 0xFFFF;
      } else if (op === 0x06) {
        cmd.index = word & 0xFFFF;
      } else if (op === 0x07) {
        cmd.mode = (word >>> 16) & 0xFF;
        cmd.index = word & 0xFFFF;
      } else if (op === 0x08) {
        var flags = (word >>> 16) & 0xFF;
        cmd.flags = flags;
        var t = this.readTransform(flags, pos);
        cmd.matrix = t[0];
        pos = t[1];
      } else if (op === 0x09 || op === 0x0B) {
        cmd.value = r.f32s(pos, 1)[0];
        pos += 4;
      } else if (op === 0x0A) {
        cmd.join = (word >>> 8) & 0xFF;
        cmd.cap = word & 0xFF;
      } else if (op !== 0x00) {
        this.warn("unknown command 0x" + ("0000000" + hex(word)).slice(-8) +
                  " at 0x" + hex(pos - 4) + ", ignored");
      }
      this.commands.push(cmd);
    }
    this.cmdEnd = pos;
  };

  // Return [[a, b, c, d, e, f] in SVG matrix order, new pos].
  NvgFile.prototype.readTransform = function (flags, pos) {
    var sx = 1.0, sy = 1.0, shx = 0.0, shy = 0.0, tx = 0.0, ty = 0.0, v;
    if (flags === 1) return [null, pos];
    if (flags === 0) {
      v = this.r.f32s(pos, 6);
      sx = v[0]; sy = v[1]; shx = v[2]; shy = v[3]; tx = v[4]; ty = v[5];
      pos += 24;
    } else {
      if (flags & 0x08) {
        v = this.r.f32s(pos, 4);
        sx = v[0]; sy = v[1]; shx = v[2]; shy = v[3];
        pos += 16;
      } else {
        if (flags & 0x02) {
          v = this.r.f32s(pos, 2);
          sx = v[0]; sy = v[1];
          pos += 8;
        }
        if (flags & 0x04) {
          v = this.r.f32s(pos, 2);
          shx = v[0]; shy = v[1];
          pos += 8;
        }
      }
      if (flags & 0x10) {
        v = this.r.f32s(pos, 2);
        tx = v[0]; ty = v[1];
        pos += 8;
      }
    }
    return [[sx, shy, shx, sy, tx, ty], pos];
  };

  // ---- data blocks --------------------------------------------------

  // Return the SVG path data string for path block `index`.
  NvgFile.prototype.readPath = function (index) {
    var r = this.r;
    var off = this.blockOffset(index);
    var nseg = r.u16(off);
    var segs = nseg ? r.u8s(off + 2, nseg) : [];
    var pos = off + 2 + nseg;
    var dt = PATH_DATATYPES[this.datatype];
    var size = dt[0], align = dt[1], scale = dt[2], kind = dt[3];
    if (align === "align2") {
      pos += pos % 2;
    } else if (align === "align4") {
      if (pos % 4) pos += 4 - pos % 4;
    } else if (align === "words") {
      pos += 4 * (pos % 4);
    }

    var parts = [];
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var segKind = seg >> 1;
      var rel = seg & 1;
      if (!SEGMENTS.hasOwnProperty(segKind)) {
        throw new NvgError("path " + index + ": unknown segment type " + seg);
      }
      var letter = SEGMENTS[segKind][0], ncoord = SEGMENTS[segKind][1];
      var vals = ncoord ? r.ints(kind, pos, ncoord).map(function (v) { return v / scale; }) : [];
      pos += ncoord * size;
      var valsS;
      if (letter === "A") {
        var flags = ARC_FLAGS[segKind];
        valsS = [fmt(Math.abs(vals[0])), fmt(Math.abs(vals[1])), fmt(vals[2]),
                 String(flags[0]), String(flags[1]), fmt(vals[3]), fmt(vals[4])];
      } else {
        valsS = vals.map(fmt);
      }
      if (letter === "Z") {
        parts.push("Z");
      } else {
        parts.push((rel ? letter.toLowerCase() : letter) + valsS.join(" "));
      }
    }
    var end = this.blockEnd(off);
    if (pos > end) {
      this.warn("path " + index + " overruns its block (0x" + hex(pos) + " > 0x" + hex(end) + ")");
    } else if (end - pos >= 4 * size && index !== this.lastPathIndex()) {
      this.log("note: path " + index + " has " + (end - pos) + " unused bytes");
    }
    return parts.join(" ");
  };

  NvgFile.prototype.lastPathIndex = function () {
    var best = 0;
    for (var i = 1; i < this.offsets.length; i++) {
      if (this.offsets[i] > this.offsets[best]) best = i;
    }
    return best;
  };

  NvgFile.prototype.readPaint = function (index) {
    var r = this.r;
    var off = this.blockOffset(index);
    var head = r.u32(off);
    var ptype = head & 0xFFFF;
    var flags = head >>> 16;
    var paint = {type: ptype, index: index};
    var pos = off + 4;
    if (ptype === PAINT_COLOR) {
      var rgba = r.u32(pos);
      paint.rgb = [(rgba >>> 24) & 0xFF, (rgba >>> 16) & 0xFF, (rgba >>> 8) & 0xFF];
      paint.alpha = rgba & 0xFF;
    } else if (ptype === PAINT_LINEAR || ptype === PAINT_RADIAL) {
      var n = ptype === PAINT_LINEAR ? 4 : 5;
      paint.coords = r.f32s(pos, n);
      pos += 4 * n;
      paint.matrix = null;
      if (flags & 1) {
        var m = r.f32s(pos, 6);  // a c e b d f
        paint.matrix = [m[0], m[3], m[1], m[4], m[2], m[5]];
      }
    } else if (ptype === PAINT_RAMP) {
      var nstops = flags & 0xFF;
      var vals = nstops ? r.f32s(pos, 5 * nstops) : [];
      paint.stops = [];
      for (var i = 0; i < vals.length; i += 5) paint.stops.push(vals.slice(i, i + 5));
    } else {
      throw new NvgError("block " + index + ": unknown paint type " + ptype);
    }
    return paint;
  };

  // Replays NVG commands and produces SVG markup.
  function SvgBuilder(nvg, sourceName) {
    this.nvg = nvg;
    this.sourceName = sourceName;
    this.defs = [];
    this.body = [];
    this.gradientIds = new Map();
    this.paintCache = new Map();
    // graphics state (OpenVG defaults == SVG defaults)
    this.fill = null;          // [paint, opacity byte, ramp index]
    this.stroke = null;
    this.lastPaint = null;     // "fill" or "stroke", target of SET_COLOR_RAMP
    this.transform = null;
    this.strokeWidth = 1.0;
    this.join = 2;
    this.cap = 1;
    this.miter = 4.0;
  }

  SvgBuilder.prototype.paint = function (index) {
    if (!this.paintCache.has(index)) {
      this.paintCache.set(index, this.nvg.readPaint(index));
    }
    return this.paintCache.get(index);
  };

  SvgBuilder.prototype.gradientRef = function (paint, rampIndex) {
    var key = paint.index + "," + rampIndex;
    if (this.gradientIds.has(key)) return this.gradientIds.get(key);
    var gid = "g" + (this.gradientIds.size + 1);
    this.gradientIds.set(key, gid);
    var c = paint.coords, attrs, tag;
    if (paint.type === PAINT_LINEAR) {
      attrs = 'x1="' + fmt(c[0]) + '" y1="' + fmt(c[1]) + '" x2="' + fmt(c[2]) +
              '" y2="' + fmt(c[3]) + '"';
      tag = "linearGradient";
    } else {
      attrs = 'cx="' + fmt(c[0]) + '" cy="' + fmt(c[1]) + '" r="' + fmt(c[4]) + '"';
      if (fmt(c[2]) !== fmt(c[0]) || fmt(c[3]) !== fmt(c[1])) {
        attrs += ' fx="' + fmt(c[2]) + '" fy="' + fmt(c[3]) + '"';
      }
      tag = "radialGradient";
    }
    attrs += ' gradientUnits="userSpaceOnUse"';
    if (paint.matrix) {
      attrs += ' gradientTransform="matrix(' + paint.matrix.map(fmt).join(" ") + ')"';
    }
    var stops = [];
    if (rampIndex !== null) {
      var ramp = this.paint(rampIndex);
      if (ramp.type !== PAINT_RAMP) {
        this.nvg.warn("block " + rampIndex + " is not a color ramp");
      } else {
        ramp.stops.forEach(function (st) {
          var s = '<stop offset="' + fmt(st[0]) + '" stop-color="' +
                  colorHex(unitToByte(st[1]), unitToByte(st[2]), unitToByte(st[3])) + '"';
          if (st[4] < 1.0) s += ' stop-opacity="' + fmt(st[4]) + '"';
          stops.push("      " + s + "/>");
        });
      }
    } else {
      this.nvg.warn("gradient paint " + paint.index + " has no color ramp");
    }
    this.defs.push(stops.length
      ? "    <" + tag + ' id="' + gid + '" ' + attrs + ">\n" + stops.join("\n") + "\n    </" + tag + ">"
      : "    <" + tag + ' id="' + gid + '" ' + attrs + "/>");
    return gid;
  };

  // SVG attributes for fill or stroke given [paint, opacity, ramp].
  SvgBuilder.prototype.paintAttrs = function (which, state) {
    if (state === null) {
      // nothing set yet: OpenVG/SVG default paint is opaque black
      return [which + '="#000000"'];
    }
    var paint = state[0], opacity = state[1], ramp = state[2], alpha, attrs;
    if (paint.type === PAINT_COLOR) {
      alpha = paint.alpha / 255.0 * opacity / 255.0;
      attrs = [which + '="' + colorHex(paint.rgb[0], paint.rgb[1], paint.rgb[2]) + '"'];
    } else if (paint.type === PAINT_LINEAR || paint.type === PAINT_RADIAL) {
      attrs = [which + '="url(#' + this.gradientRef(paint, ramp) + ')"'];
      // The encoder stores 1 (not 255) as the opacity of gradient
      // strokes; treat it as fully opaque.
      alpha = opacity === 1 ? 1.0 : opacity / 255.0;
    } else {
      this.nvg.warn("paint block " + paint.index + " is not a fill/stroke paint");
      return [which + '="#000000"'];
    }
    if (alpha < 1.0) attrs.push(which + '-opacity="' + fmt(alpha) + '"');
    return attrs;
  };

  SvgBuilder.prototype.draw = function (cmd) {
    var d = this.nvg.readPath(cmd.index);
    var mode = cmd.mode;
    var attrs = ['d="' + d + '"'];
    if (mode & 2) {
      attrs = attrs.concat(this.paintAttrs("fill", this.fill));
    } else {
      attrs.push('fill="none"');
    }
    if (mode & 1) {
      attrs = attrs.concat(this.paintAttrs("stroke", this.stroke));
      if (this.strokeWidth !== 1.0) attrs.push('stroke-width="' + fmt(this.strokeWidth) + '"');
      if (this.join !== 2) attrs.push('stroke-linejoin="' + (LINE_JOINS[this.join] || "miter") + '"');
      if (this.cap !== 1) attrs.push('stroke-linecap="' + (LINE_CAPS[this.cap] || "butt") + '"');
      if (this.miter !== 4.0) attrs.push('stroke-miterlimit="' + fmt(this.miter) + '"');
    }
    if (this.transform) {
      attrs.push('transform="matrix(' + this.transform.map(fmt).join(" ") + ')"');
    }
    this.body.push("  <path " + attrs.join(" ") + "/>");
  };

  SvgBuilder.prototype.run = function () {
    var log = this.nvg.log;
    var cmds = this.nvg.commands;
    for (var i = 0; i < cmds.length; i++) {
      var cmd = cmds[i], op = cmd.op;
      if (op === 0x04 || op === 0x05) {
        var which = op === 0x04 ? "fill" : "stroke";
        this[which] = [this.paint(cmd.index), cmd.opacity, null];
        this.lastPaint = which;
        log("cmd SET_" + which.toUpperCase() + "_PAINT block=" + cmd.index +
            " opacity=" + cmd.opacity);
      } else if (op === 0x06) {
        log("cmd SET_COLOR_RAMP block=" + cmd.index);
        var state = this.lastPaint ? this[this.lastPaint] : null;
        if (state === null) {
          this.nvg.warn("color ramp without a preceding paint");
        } else {
          this[this.lastPaint] = [state[0], state[1], cmd.index];
        }
      } else if (op === 0x07) {
        log("cmd DRAW_PATH block=" + cmd.index + " mode=" + cmd.mode);
        this.draw(cmd);
      } else if (op === 0x08) {
        this.transform = cmd.matrix;
        log("cmd SET_TRANSFORM flags=0x" + hex(cmd.flags) + " " +
            (cmd.matrix ? "[" + cmd.matrix.map(fmtG).join(", ") + "]" : "identity"));
      } else if (op === 0x09) {
        this.strokeWidth = cmd.value;
        log("cmd SET_STROKE_WIDTH " + fmtG(cmd.value));
      } else if (op === 0x0A) {
        this.join = cmd.join;
        this.cap = cmd.cap;
        log("cmd SET_LINE_JOIN_CAP join=" + cmd.join + " cap=" + cmd.cap);
      } else if (op === 0x0B) {
        this.miter = cmd.value;
        log("cmd SET_MITER_LIMIT " + fmtG(cmd.value));
      }
    }
    return this.render();
  };

  // XML declaration and "decoded from" comment that start every output.
  function prologue(sourceName) {
    var out = ['<?xml version="1.0" encoding="UTF-8"?>'];
    if (sourceName) {
      var name = sourceName;
      while (name.indexOf("--") !== -1) {  // "--" is not allowed inside an XML comment
        name = name.split("--").join("- -");
      }
      out.push("<!-- Decoded from " + name + " by nvg2svg " + VERSION + " -->");
    }
    return out;
  }

  SvgBuilder.prototype.render = function () {
    var vb = this.nvg.viewbox;
    var out = prologue(this.sourceName);
    out.push('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="' + fmt(vb[2]) +
             '" height="' + fmt(vb[3]) + '" viewBox="' + fmt(vb[0]) + " " + fmt(vb[1]) +
             " " + fmt(vb[2]) + " " + fmt(vb[3]) + '">');
    if (this.defs.length) {
      out.push("  <defs>");
      out = out.concat(this.defs);
      out.push("  </defs>");
    }
    out = out.concat(this.body);
    out.push("</svg>");
    return out.join("\n") + "\n";
  };

  // ---- SVGB ---------------------------------------------------------

  // magic -> format number; formats 1 and 2 store numbers as 16.16 fixed point
  var SVGB_MAGIC = {0x03fa56cc: 0, 0x03fa56cd: 1, 0x03fa56ce: 2, 0x03fa56cf: 3};
  var SVGB_END_ATTRS = 1000, SVGB_TEXT = 0xfd, SVGB_END_ELEMENT = 0xfe, SVGB_END = 0xff;

  var SVGB_ELEMENTS = [
    "svg", "altGlyph", "altGlyphDef", "defs", "desc", "foreignObject", "metadata", "title",
    "font-face-name", "font-face-src", "font-face-uri", "g", "glyphRef", "vkern", "script",
    "switch", "view", "hkern", "a", "font", "font-face", "glyph", "image", "missing-glyph",
    "style", "text", "use", "circle", "ellipse", "line", "path", "polygon", "polyline", "rect",
    "animate", "animateColor", "animateMotion", "animateTransform", "set", "mpath",
    "linearGradient", "radialGradient", "stop", "script", null, "discard", "solidColor",
    "animation", "audio"
  ];

  var DISPLAY = [
    "inline", "block", "list-item", "run-in", "compact", "marker", "table", "inline-table",
    "table-row-group", "table-header-group", "table-footer-group", "table-row",
    "table-column-group", "table-column", "table-cell", "table-caption", "none"
  ];
  var FONT_WEIGHTS = ["normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500",
                      "600", "700", "800", "900", "inherit"];

  // attribute id -> [name, value type, enum values]; types are read by readSvgbValue.
  // Attributes without a type are known by name only: their encoding is not
  // known yet, so a file that uses one cannot be decoded past it.
  var SVGB_ATTRS = {
    0: ["fill", "paint"], 1: ["stroke", "color"], 2: ["stroke-width", "num"],
    3: ["visibility", "enum32", ["visible", "hidden"]],
    4: ["font-family", "str"], 5: ["font-size", "num"],
    6: ["font-style", "enum32", ["normal", "italic", "oblique", "inherit"]],
    7: ["font-weight", "enum32", FONT_WEIGHTS], 8: ["stroke-dasharray", "nums"],
    9: ["display", "enum32", DISPLAY], 10: ["fill-rule", "str"], 11: ["stroke-linecap", "str"],
    12: ["stroke-linejoin", "str"], 13: ["stroke-dashoffset", "num"],
    14: ["stroke-miterlimit", "num"], 15: ["color", "color"],
    16: ["text-anchor", "enum32", ["start", "middle", "end"]],
    17: ["text-decoration", "enum32", ["none", "underline", "overline", "line-through"]],
    18: ["color-interpolation"], 19: ["color-rendering"], 20: ["letter-spacing"],
    21: ["word-spacing"], 22: ["fill-opacity", "num"], 23: ["stroke-opacity", "num"],
    24: ["opacity", "num"], 25: ["textLength", "num"], 26: ["width", "size"], 27: ["height", "size"],
    28: ["r", "num"], 29: ["rx", "num"], 30: ["ry", "num"], 31: ["horiz-adv-x", "num"],
    32: ["horiz-origin-x", "num"], 33: ["horiz-origin-y", "num"], 34: ["ascent", "num"],
    35: ["descent", "num"], 36: ["alphabetic", "num"], 37: ["underline-position", "num"],
    38: ["underline-thickness", "num"], 39: ["overline-position", "num"],
    40: ["overline-thickness", "num"], 41: ["strikethrough-position", "num"],
    42: ["strikethrough-thickness", "num"], 43: ["units-per-em", "num"], 44: ["word-spacing"],
    45: ["letter-spacing"], 46: ["cx", "num"], 47: ["cy", "num"], 48: ["y", "coord"],
    49: ["x", "coord"], 50: ["y1", "num"], 51: ["y2", "num"], 52: ["x1", "num"],
    53: ["x2", "num"], 54: ["k", "num"], 55: ["g1", "str"], 56: ["g2", "str"], 57: ["u1", "str"],
    58: ["u2", "str"], 59: ["unicode", "str"], 60: ["glyph-name", "str"], 61: ["lang"], 62: ["text-decoration"],
    64: ["rotate", "floats"], 65: ["cdata"], 66: ["transform", "transform"], 67: ["style"],
    71: ["from", "animvalue"], 72: ["to", "animvalue"], 73: ["by", "animvalue"],
    74: ["attributeName", "attrname"], 75: ["pathLength"],
    76: ["version", "num"], 77: ["stroke-width"], 78: ["points", "points"], 79: ["d", "path"],
    80: ["type", "ttype"], 81: ["stop-color", "color"], 82: ["fx", "num"], 83: ["fy", "num"],
    84: ["offset", "num"], 85: ["spreadMethod", "enum8", ["pad", "reflect", "repeat"]],
    86: ["gradientUnits", "enum8", ["userSpaceOnUse", "objectBoundingBox"]],
    87: ["stop-opacity", "num"], 88: ["viewBox", "nums4"], 89: ["baseProfile", "str"],
    90: ["zoomAndPan", "enum8", ["disable", "magnify"]], 91: ["preserveAspectRatio", "str"], 92: ["id", "str"], 93: ["xml:base", "str"],
    94: ["xml:lang", "str"], 95: ["xml:space", "str"], 96: ["requiredExtensions", "strs", " "],
    97: ["requiredFeatures", "strs", " "], 98: ["systemLanguage", "strs", ","], 101: ["media"], 102: ["title"],
    103: ["xlink:actuate", "str"], 104: ["xlink:arcrole"], 105: ["xlink:role"],
    106: ["xlink:show", "str"], 107: ["xlink:title", "str"], 108: ["xlink:type", "str"],
    109: ["xlink:href", "href"], 110: ["begin", "begin"], 111: ["dur", "dur"], 112: ["repeatCount", "repeat"],
    113: ["repeatDur", "ms"], 114: ["end", "end"],
    115: ["restart", "enum8", ["always", "whenNotActive", "never"]],
    116: ["accumulate", "flag", "sum"], 117: ["additive", "flag", "sum"],
    118: ["keySplines"], 119: ["keyTimes", "keytimes"],
    120: ["calcMode", "enum8", ["discrete", "linear", "paced", "spline"]], 121: ["path"],
    122: ["path", "motionpath"],  // animateMotion path
    123: ["gradientTransform", "matrix"], 133: ["volume"], 134: ["audio-level"],
    135: ["fill", "flag", "freeze"],  // fill on animation elements
    136: ["xlink:href", "data"], 163: ["values", "values"]
  };

  // Value types of animation values (from, to, by, values), as written after
  // attributeName and before each value. The encoder also knows 0xd, 0xf and
  // 0x61, whose layout is not known yet; 0x49 and 99 are u32 of unknown meaning.
  var SVGB_ANIM_TYPES = {
    0: "int", 2: "color", 3: "num", 7: "path", 0x35: ["enum32", DISPLAY],
    0x45: ["enum32", ["visible", "hidden"]], 0x49: "int?", 0x62: "num", 99: "int?"
  };

  // animateTransform type codes
  var SVGB_TRANSFORMS = {0x1f: "translate", 0x20: "rotate", 0x21: "scale", 0x22: "skewX", 0x23: "skewY"};

  // Event codes of begin and end values
  var SVGB_EVENTS = [
    "focusin", "focusout", "activate", "click", "mousedown", "mouseup", "mouseover",
    "mousemove", "mouseout", "DOMSubtreeModified", "DOMNodeInserted", "DOMNodeRemoved",
    "DOMNodeRemovedFromDocument", "DOMNodeInsertedIntoDocument", "DOMAttrModified",
    "DOMCharacterDataModified", "SVGLoad", "SVGUnload", "SVGAbort", "SVGError", "SVGResize",
    "SVGScroll", "SVGZoom", "begin", "end", "repeat"
  ];
  var SVGB_INDEFINITE = 0x7fffffff;
  var SVGB_NO_EVENT = 0xff;

  // Path segment types -> [SVG command, coordinate count].
  var SVGB_SEGMENTS = [["M", 2], ["L", 2], ["Q", 4], ["C", 6], ["Z", 0]];

  function escapeXml(s, attr) {
    // Characters XML 1.0 does not allow become U+FFFD.
    s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g,
                  function (m, before) { return (before || "") + "�"; });
    s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return attr ? s.replace(/"/g, "&quot;") : s;
  }

  // Parsed SVGB file: the element tree with SVG attribute values.
  function SvgbFile(data, log) {
    this.r = new Reader(data);
    this.log = log || function () {};
    this.warnings = [];
    this.pos = 0;
    this.parseHeader();
    this.parseElements();
  }

  SvgbFile.prototype.warn = NvgFile.prototype.warn;

  SvgbFile.prototype.parseHeader = function () {
    var magic = this.r.u32(0);
    if (!SVGB_MAGIC.hasOwnProperty(magic)) {
      throw new NvgError("not an SVGB file (unknown magic 0x" + hex(magic) + ")");
    }
    this.format = SVGB_MAGIC[magic];
    this.fixed = this.format === 1 || this.format === 2;
    this.bgr = this.format < 2;  // formats 0 and 1 store colors as 0x00BBGGRR
    this.pos = 4;
    this.log("header: SVGB format " + this.format + " (" +
             (this.fixed ? "16.16 fixed point" : "float") + " numbers)");
  };

  SvgbFile.prototype.u8 = function () { return this.r.u8(this.pos++); };
  SvgbFile.prototype.u16 = function () { var v = this.r.u16(this.pos); this.pos += 2; return v; };
  SvgbFile.prototype.u32 = function () { var v = this.r.u32(this.pos); this.pos += 4; return v; };
  SvgbFile.prototype.s16 = function () { var v = this.r.ints("s16", this.pos, 1)[0]; this.pos += 2; return v; };
  SvgbFile.prototype.s32 = function () { var v = this.r.ints("s32", this.pos, 1)[0]; this.pos += 4; return v; };
  SvgbFile.prototype.bytes = function (n) { var v = this.r.u8s(this.pos, n); this.pos += n; return v; };

  SvgbFile.prototype.num = function () {
    var v = this.fixed ? this.r.ints("s32", this.pos, 1)[0] / 65536 : this.r.f32s(this.pos, 1)[0];
    this.pos += 4;
    return v;
  };

  SvgbFile.prototype.nums = function (n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(this.num());
    return out;
  };

  // u8 byte length, then UTF-16LE text
  SvgbFile.prototype.str = function () {
    var n = this.u8(), units = [];
    var b = this.bytes(n);
    for (var i = 0; i + 1 < n; i += 2) units.push(b[i] | b[i + 1] << 8);
    if (n % 2) this.warn("odd string length " + n + " at 0x" + hex(this.pos - n - 1));
    var s = "";
    for (var j = 0; j < units.length; j += 4096) {
      s += String.fromCharCode.apply(null, units.slice(j, j + 4096));
    }
    return s;
  };

  SvgbFile.prototype.color = function () {
    var v = this.u32();
    if (v === 0x01ffffff) return "none";
    if (v === 0x02ffffff) return "currentColor";
    if (v >>> 24) this.warn("color 0x" + hex(v) + " has unknown flags, using its RGB value");
    if (this.bgr) v = (v & 0xff) << 16 | v & 0xff00 | (v >> 16) & 0xff;
    return "#" + ("00000" + (v & 0xffffff).toString(16)).slice(-6);
  };

  function clock(ms) {
    return ms === SVGB_INDEFINITE ? "indefinite" : fmt(ms / 1000) + "s";
  }

  // One begin or end value: a clock value, or "id.event" with an offset
  SvgbFile.prototype.timing = function (time, offset, target, event) {
    if (event === SVGB_NO_EVENT) return clock(time);
    var name = SVGB_EVENTS[event];
    if (!name) throw new NvgError("unknown animation event " + event + " at 0x" + hex(this.pos));
    var out = (target && target !== "unid" ? target + "." : "") + name;
    if (offset) out += (offset < 0 ? "-" : "+") + clock(Math.abs(offset));
    return out;
  };

  SvgbFile.prototype.readValue = function (id, def, element) {
    var type = def[1], i, v;
    switch (type) {
      case "num":
        v = this.num();
        if (id === 25 && v === 0) {  // the encoder writes textLength as 0
          this.log("  textLength 0 dropped");
          return null;
        }
        return fmt(v);
      case "nums":  // u8 count, then numbers
        return this.nums(this.u8()).map(fmt).join(" ");
      case "nums4":
        return this.nums(4).map(fmt).join(" ");
      case "coord":  // on <text>, x and y are lists: u8 count, numbers
        if (element === "text") return this.nums(this.u8()).map(fmt).join(" ");
        return fmt(this.num());
      case "floats":  // u8 count, then f32 values even in fixed-point files
        if (element === "animateMotion") {  // s16 degrees, -100 auto, -200 auto-reverse
          v = this.s16();
          return v === -100 ? "auto" : v === -200 ? "auto-reverse" : String(v);
        }
        var f = this.r.f32s(this.pos + 1, this.u8());
        this.pos += 4 * f.length;
        return f.map(fmt).join(" ");
      case "size":  // the root <svg> has a percentage flag before the number
        var percent = element === "svg" ? this.u8() : 0;
        return fmt(this.num()) + (percent ? "%" : "");
      case "str":
        return this.str();
      case "strs":  // u8 count, then strings
        var list = [];
        for (i = this.u8(); i > 0; i--) list.push(this.str());
        return list.join(def[2]);
      case "color":
        return this.color();
      case "paint":  // u8 flag: 0 color, 1 id of a paint server
        var flag = this.u8();
        if (flag === 0) return this.color();
        if (flag === 1) return "url(#" + this.str() + ")";
        throw new NvgError("unknown paint flag " + flag + " at 0x" + hex(this.pos - 1));
      case "enum8":
      case "enum32":
        v = type === "enum8" ? this.u8() : this.u32();
        if (v < def[2].length) return def[2][v];
        this.warn("unknown value " + v + " for " + def[0] + ", attribute dropped");
        return null;
      case "transform":  // a c e b d f, then u32 transform type
      case "matrix":
        var m = this.nums(6);
        if (type === "transform") this.u32();
        return "matrix(" + [m[0], m[3], m[1], m[4], m[2], m[5]].map(fmt).join(" ") + ")";
      case "path":
      case "points":
        return this.readPath(type === "points");
      case "href":  // string; a local reference (#id) is followed by the id again
        var href = this.str();
        if (href.charAt(0) === "#") {
          if (element === "mpath") this.u8();  // a 1 before the id, seen only on mpath
          this.log("  xlink:href target id " + JSON.stringify(this.str()));
        }
        if (href === "") this.log("  empty xlink:href dropped");
        return href === "" ? null : href;
      case "flag":  // no value: the attribute's presence means def[2]
        return def[2];
      case "ms":  // u32 milliseconds, 0x7FFFFFFF indefinite
        return clock(this.s32());
      case "dur":  // u32 milliseconds, then a u8 that has been 0 in every sample
        v = clock(this.s32());
        i = this.u8();
        if (i) this.log("  dur flag byte " + i);
        return v;
      case "repeat":  // u32 count (the encoder drops fractions), 0xFFFF indefinite
        v = this.u32();
        return v === 0xffff ? "indefinite" : String(v);
      case "int":
        return String(this.s32());
      case "int?":
        this.warn("animation value of unknown meaning at 0x" + hex(this.pos) + ", written as a number");
        return String(this.s32());
      case "begin":  // u8 1 for indefinite; else a u8 count of values, then derived times
        if (this.u8() === 1) return "indefinite";
        var times = [];
        for (i = this.u8(); i > 0; i--) {
          var time = this.s32(), offset = this.s32();
          this.bytes(4);  // uninitialized
          var ref = this.str();
          this.bytes(2);  // uninitialized
          times.push(this.timing(time, offset, ref, this.u8()));
        }
        this.bytes(4 * this.u8() + 9);  // resolved begin times, computed by the encoder
        return times.join(";");
      case "end":  // u8 0, u8 event, 4 uninitialized bytes, element id, s32 time or offset
        i = this.u8();
        if (i) throw new NvgError("unknown end flag " + i + " at 0x" + hex(this.pos - 1));
        var event = this.u8();
        this.bytes(4);
        var endRef = this.str();
        v = this.s32();
        return event === SVGB_NO_EVENT ? clock(v) : this.timing(0, v, endRef, event);
      case "keytimes":  // u16 count, u16 values of time * 255
        var kt = [];
        for (i = this.u16(); i > 0; i--) kt.push(fmt(Math.round(this.u16() / 255 * 100) / 100));
        return kt.join(";");
      case "ttype":  // animateTransform type: u8 type code, u8 parameter count
        if (element !== "animateTransform") break;
        i = this.u8();
        this.anim.params = this.u8();
        if (!SVGB_TRANSFORMS[i]) throw new NvgError("unknown transform type " + i + " at 0x" + hex(this.pos - 2));
        return SVGB_TRANSFORMS[i];
      case "motionpath":  // path, then a u8: 0, or 0x94 (the encoder's "missing
                          // path" error code) when an <mpath> child gives the path
        v = this.readPath(false);
        i = this.u8();
        if (i) this.log("  byte after motion path: 0x" + hex(i));
        return v === "" ? null : v;
      case "attrname":  // u16 attribute id; except on animateTransform, then a u8 value type
        i = this.u16();
        if (element !== "animateTransform") this.log("  value type " + this.u8());
        if (i === 0xffff) {
          this.warn("the encoder did not record the attributeName of <" + element + "> at 0x" +
                    hex(this.pos) + " (it cannot animate that attribute)");
          return null;
        }
        var target = SVGB_ATTRS[i];
        if (!target) throw new NvgError("attributeName refers to unknown attribute " + i);
        this.anim.target = target[0];
        return target[0];
      case "animvalue":  // u8 value type, then the value
        if (element === "animateTransform") return this.transformValue(id === 71);
        return this.animValue(id, def[0], element);
      case "values":  // [u8 value type,] u16 count, values
        var vals = [];
        if (element === "animateTransform") {
          for (i = this.u16(); i > 0; i--) vals.push(this.transformValue(false));
        } else {
          var t = this.u8();
          for (i = this.u16(); i > 0; i--) vals.push(this.animValue(id, def[0], element, t));
        }
        return vals.join(";");
      case "data":  // u32 byte length, then 8-bit text (data: URIs of images)
        var n = this.u32();
        var b = this.bytes(n), s = "";
        for (i = 0; i < n; i += 4096) s += String.fromCharCode.apply(null, b.slice(i, i + 4096));
        return s;
    }
    throw new NvgError("cannot decode SVGB attribute " + id + " (" + def[0] + ") at 0x" +
                       hex(this.pos - 2) + ": its encoding is not known yet");
  };

  // One animation value: u8 value type (unless given), then the value
  SvgbFile.prototype.animValue = function (id, name, element, type) {
    if (type === undefined) type = this.u8();
    var vt = SVGB_ANIM_TYPES[type];
    if (!vt) {
      throw new NvgError("unknown animation value type " + type + " at 0x" + hex(this.pos - 1) +
                         ": its encoding is not known yet");
    }
    if (vt === "path") return this.readPath(this.anim.target === "points");
    return this.readValue(id, typeof vt === "string" ? [name, vt] : [name].concat(vt), element);
  };

  // animateTransform value: 3 numbers (f32 for from, as the encoder writes
  // them), of which the transform type uses the first few
  SvgbFile.prototype.transformValue = function (float) {
    var v = float ? this.r.f32s(this.pos, 3) : this.nums(3);
    if (float) this.pos += 12;
    return v.slice(0, this.anim.params).map(fmt).join(" ");
  };

  // u16 segment count, segment types (u8 each), u16 coordinate count, numbers
  SvgbFile.prototype.readPath = function (points) {
    var start = this.pos;
    var segs = this.bytes(this.u16());
    var coords = this.nums(this.u16());
    if (points) {
      if (coords.length % 2) this.warn("odd number of point coordinates at 0x" + hex(start));
      var pts = [];
      for (var k = 0; k + 1 < coords.length; k += 2) pts.push(fmt(coords[k]) + "," + fmt(coords[k + 1]));
      return pts.join(" ");
    }
    var parts = [], c = 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = SVGB_SEGMENTS[segs[i]];
      if (!seg) throw new NvgError("unknown path segment type " + segs[i] + " at 0x" + hex(start));
      if (c + seg[1] > coords.length) {
        throw new NvgError("path at 0x" + hex(start) + " has too few coordinates");
      }
      parts.push(seg[0] + coords.slice(c, c + seg[1]).map(fmt).join(" "));
      c += seg[1];
    }
    if (c < coords.length) this.warn("path at 0x" + hex(start) + " has " + (coords.length - c) +
                                     " unused coordinates");
    return parts.join(" ");
  };

  // Element tree: {name, attrs: [[name, value]], children: [element or {text}]}
  SvgbFile.prototype.parseElements = function () {
    var stack = [], roots = [];
    for (;;) {
      var at = this.pos, code = this.u8();
      if (code === SVGB_END) break;
      if (code === SVGB_END_ELEMENT) {
        if (!stack.length) throw new NvgError("element end without element at 0x" + hex(at));
        stack.pop();
        continue;
      }
      if (code === SVGB_TEXT) {
        if (!stack.length) throw new NvgError("text outside of any element at 0x" + hex(at));
        var text = this.str();
        this.log("0x" + hex(at) + " text " + JSON.stringify(text));
        stack[stack.length - 1].children.push({text: text});
        continue;
      }
      var name = SVGB_ELEMENTS[code];
      if (!name) throw new NvgError("unknown SVGB element " + code + " at 0x" + hex(at));
      if (!stack.length && roots.length) {
        throw new NvgError("second root element <" + name + "> at 0x" + hex(at));
      }
      this.log("0x" + hex(at) + " <" + name + ">");
      var el = {name: name, attrs: [], children: []};
      this.anim = {target: null, params: 3};
      for (;;) {
        var apos = this.pos, id = this.u16();
        if (id === SVGB_END_ATTRS) break;
        var def = SVGB_ATTRS[id];
        if (!def) throw new NvgError("unknown SVGB attribute " + id + " at 0x" + hex(apos));
        var value = this.readValue(id, def, name);
        this.log("0x" + hex(apos) + "   " + def[0] + " (" + id + ") = " +
                 JSON.stringify(value !== null && value.length > 80 ? value.slice(0, 80) + "..." : value));
        if (value === null) continue;
        var dup = el.attrs.filter(function (a) { return a[0] === def[0]; })[0];
        if (dup) {
          this.warn("<" + name + "> at 0x" + hex(at) + " sets " + def[0] + " twice, keeping the last value");
          dup[1] = value;
        } else {
          el.attrs.push([def[0], value]);
        }
      }
      (stack.length ? stack[stack.length - 1].children : roots).push(el);
      // An element without children is ended right after its attributes.
      if (this.r.u8(this.pos) === SVGB_END_ELEMENT) this.pos++;
      else stack.push(el);
    }
    if (stack.length) this.warn(stack.length + " element(s) not closed at end of file");
    if (this.pos < this.r.data.length) {
      this.warn((this.r.data.length - this.pos) + " bytes of trailing data ignored");
    }
    if (!roots.length) throw new NvgError("SVGB file contains no elements");
    this.root = roots[0];
    if (this.root.name !== "svg") this.warn("root element is <" + this.root.name + ">, not <svg>");
  };

  function renderSvgb(svgb, sourceName) {
    var out = prologue(sourceName);
    var root = svgb.root, xlink = false;
    (function scan(el) {
      el.attrs.forEach(function (a) { if (a[0].lastIndexOf("xlink:", 0) === 0) xlink = true; });
      el.children.forEach(function (c) { if (c.name) scan(c); });
    })(root);
    var ns = [["xmlns", "http://www.w3.org/2000/svg"]];
    if (xlink) ns.push(["xmlns:xlink", "http://www.w3.org/1999/xlink"]);

    function open(el, extra) {
      return "<" + el.name + extra.concat(el.attrs).map(function (a) {
        return " " + a[0] + '="' + escapeXml(a[1], true) + '"';
      }).join("");
    }
    function inline(el) {  // elements that only hold text stay on one line
      return el.children.map(function (c) {
        return c.name ? open(c, []) + (c.children.length ? ">" + inline(c) + "</" + c.name + ">" : "/>")
                      : escapeXml(c.text, false);
      }).join("");
    }
    (function write(el, indent, extra) {
      if (!el.children.length) {
        out.push(indent + open(el, extra) + "/>");
      } else if (el.children.some(function (c) { return !c.name; })) {
        out.push(indent + open(el, extra) + ">" + inline(el) + "</" + el.name + ">");
      } else {
        out.push(indent + open(el, extra) + ">");
        el.children.forEach(function (c) { write(c, indent + "  ", []); });
        out.push(indent + "</" + el.name + ">");
      }
    })(root, "", ns);
    return out.join("\n") + "\n";
  }

  // Decode NVG or SVGB bytes (Uint8Array) and return {svg, warnings}.
  function decode(data, sourceName, log) {
    if (data.length >= 3 && data[0] === 0x6e && data[1] === 0x76 && data[2] === 0x67) {
      var nvg = new NvgFile(data, log);
      var svg = new SvgBuilder(nvg, sourceName).run();
      return {svg: svg, warnings: nvg.warnings};
    }
    if (data.length >= 4 && SVGB_MAGIC.hasOwnProperty(new Reader(data).u32(0))) {
      var svgb = new SvgbFile(data, log);
      return {svg: renderSvgb(svgb, sourceName), warnings: svgb.warnings};
    }
    throw new NvgError("not an NVG or SVGB file (unknown signature)");
  }

  var api = {decode: decode, NvgError: NvgError, VERSION: VERSION, fmt: fmt};
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.NVG2SVG = api;
  }
})(this);
