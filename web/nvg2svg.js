/* nvg2svg.js - decode Nokia NVG (Symbian^3 vector graphics) files back to SVG.
 *
 * JavaScript port of nvg2svg.py, for the browser version. The format spec
 * lives in the docstring of nvg2svg.py; this file mirrors that script
 * function by function and must produce byte-identical SVG and the same
 * warnings. `node web/check.js examples` compares the two.
 *
 * Works as a classic <script> (defines window.NVG2SVG) and as a CommonJS
 * module, so index.html also runs from file:// without a server.
 */
(function (root) {
  "use strict";

  var VERSION = "1.0";  // keep equal to __version__ in nvg2svg.py

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

  // Python's "%.4f" rounds exact ties half-to-even, toFixed() rounds them
  // away from zero. A double is an exact tie at the 5th decimal only when it
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
    // integers, so print them exactly like Python does.
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

  // Python's %g, for log messages only.
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

  // Python's round(): half to even.
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
            (cmd.matrix ? "[" + cmd.matrix.map(fmtG).join(", ") + "]" : "None"));
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

  SvgBuilder.prototype.render = function () {
    var vb = this.nvg.viewbox;
    var out = ['<?xml version="1.0" encoding="UTF-8"?>'];
    if (this.sourceName) {
      var name = this.sourceName;
      while (name.indexOf("--") !== -1) {  // "--" is not allowed inside an XML comment
        name = name.split("--").join("- -");
      }
      out.push("<!-- Decoded from " + name + " by nvg2svg " + VERSION + " -->");
    }
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

  // Decode NVG bytes (Uint8Array) and return {svg, warnings}.
  function decode(data, sourceName, log) {
    var nvg = new NvgFile(data, log);
    var svg = new SvgBuilder(nvg, sourceName).run();
    return {svg: svg, warnings: nvg.warnings};
  }

  var api = {decode: decode, NvgError: NvgError, VERSION: VERSION, fmt: fmt};
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.NVG2SVG = api;
  }
})(this);
