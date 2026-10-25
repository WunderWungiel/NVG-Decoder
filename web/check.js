#!/usr/bin/env node
/* Check that web/nvg2svg.js decodes exactly like nvg2svg.py.
 *
 *   node web/check.js examples              compare on every file in examples/
 *   node web/check.js examples --fuzz 2000  also on 2000 mutated copies
 *
 * Both decoders get the same bytes; the SVG text, the warnings and the error
 * message (if any) must be identical. Needs python3 on PATH.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");
const NVG = require("./nvg2svg.js");

const REPO = path.resolve(__dirname, "..");

const PY_DECODE = `
import base64, json, sys
sys.path.insert(0, sys.argv[1])
import nvg2svg
out = []
for item in json.load(sys.stdin):
    data = base64.b64decode(item["b64"])
    try:
        svg, warnings = nvg2svg.decode(data, item["name"])
        out.append({"svg": svg, "warnings": warnings, "error": None})
    except nvg2svg.NvgError as exc:
        out.append({"svg": None, "warnings": [], "error": str(exc)})
    except Exception as exc:
        out.append({"svg": None, "warnings": [], "error": "crash: %s: %s" % (type(exc).__name__, exc)})
json.dump(out, sys.stdout)
`;

function jsDecode(data, name) {
  try {
    const r = NVG.decode(data, name);
    return {svg: r.svg, warnings: r.warnings, error: null};
  } catch (exc) {
    const msg = exc instanceof NVG.NvgError ? exc.message : "crash: " + exc.stack;
    return {svg: null, warnings: [], error: msg};
  }
}

function pyDecodeAll(cases) {
  const input = JSON.stringify(cases.map(c => ({name: c.name, b64: Buffer.from(c.data).toString("base64")})));
  const out = execFileSync("python3", ["-I", "-c", PY_DECODE, REPO],
                           {input, maxBuffer: 1 << 30, encoding: "utf8"});
  return JSON.parse(out);
}

function collect(inputs) {
  const files = [];
  for (const p of inputs) {
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) {
        const fp = path.join(p, f);
        if (fs.statSync(fp).isFile()) files.push(fp);
      }
    } else {
      files.push(p);
    }
  }
  return files;
}

// Small seeded PRNG so fuzz failures are reproducible.
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(base, rand) {
  const data = Uint8Array.from(base);
  const n = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const pos = Math.floor(rand() * data.length);
    const how = rand();
    if (how < 0.4) data[pos] ^= 1 << Math.floor(rand() * 8);
    else if (how < 0.8) data[pos] = Math.floor(rand() * 256);
    else data[pos] = [0, 1, 2, 3, 4, 0x10, 0xff][Math.floor(rand() * 7)];
  }
  if (rand() < 0.05) return data.slice(0, Math.floor(rand() * data.length));
  return data;
}

function main(argv) {
  let fuzz = 0, seed = 1;
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fuzz") fuzz = parseInt(argv[++i], 10);
    else if (argv[i] === "--seed") seed = parseInt(argv[++i], 10);
    else inputs.push(argv[i]);
  }
  if (!inputs.length) {
    console.error("usage: node web/check.js FILE|DIR... [--fuzz N] [--seed S]");
    return 2;
  }

  const cases = collect(inputs).map(f => ({name: path.basename(f), label: f, data: fs.readFileSync(f)}));
  const bases = cases.filter(c => c.data.length);
  const rand = mulberry32(seed);
  for (let i = 0; i < fuzz && bases.length; i++) {
    const base = bases[Math.floor(rand() * bases.length)];
    cases.push({name: base.name, label: base.label + " (fuzz #" + i + ", seed " + seed + ")",
                data: mutate(base.data, rand)});
  }

  const py = pyDecodeAll(cases);
  let failures = 0, decoded = 0, rejected = 0, pyCrashes = 0;
  cases.forEach((c, i) => {
    const js = jsDecode(c.data, c.name);
    const p = py[i];
    if (p.error && p.error.startsWith("crash:")) pyCrashes++;
    if (JSON.stringify(js) === JSON.stringify(p)) {
      if (p.error) rejected++; else decoded++;
      if (i < cases.length - fuzz) {
        console.log("ok   " + c.label + (p.error ? "  (rejected: " + p.error + ")" : ""));
      }
      return;
    }
    failures++;
    console.log("FAIL " + c.label);
    for (const key of ["error", "warnings", "svg"]) {
      const a = JSON.stringify(p[key]), b = JSON.stringify(js[key]);
      if (a !== b) {
        console.log("  python " + key + ": " + a.slice(0, 400));
        console.log("  js     " + key + ": " + b.slice(0, 400));
      }
    }
  });
  console.log("\n%d cases: %d decoded, %d rejected, %d mismatches%s", cases.length, decoded,
              rejected, failures, pyCrashes ? ", " + pyCrashes + " python crashes" : "");
  return failures ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
