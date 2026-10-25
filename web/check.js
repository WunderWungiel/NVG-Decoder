#!/usr/bin/env node
/* Regression and fuzz test for web/nvg2svg.js.
 *
 *   node web/check.js examples test/svgb    compare with the outputs in test/expected/
 *   node web/check.js examples --fuzz 5000  also decode 5000 mutated copies
 *   node web/check.js examples --update     rewrite test/expected/ from the current decoder
 *
 * Directories contribute their .nvg and .svgb files. For an input "x.nvg",
 * test/expected/ holds "x.nvg.svg" (decoded) or "x.nvg.error" (rejected),
 * plus "x.nvg.warnings" if there were any. The SVG text, the warnings and the
 * error message must match exactly. Fuzzed inputs
 * have no expected output; they only have to decode or be rejected with an
 * NvgError, never crash.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const NVG = require("./nvg2svg.js");

const EXPECTED_DIR = path.resolve(__dirname, "..", "test", "expected");
const KINDS = ["svg", "error", "warnings"];

function decode(data, name) {
  try {
    const r = NVG.decode(data, name);
    return {svg: r.svg, warnings: r.warnings, error: null};
  } catch (exc) {
    const msg = exc instanceof NVG.NvgError ? exc.message : "crash: " + exc.stack;
    return {svg: null, warnings: [], error: msg};
  }
}

function expectedPath(name, kind) {
  return path.join(EXPECTED_DIR, name + "." + kind);
}

function readExpected(name) {
  const read = kind => {
    try {
      return fs.readFileSync(expectedPath(name, kind), "utf8");
    } catch (exc) {
      if (exc.code === "ENOENT") return null;
      throw exc;
    }
  };
  const svg = read("svg"), error = read("error"), warnings = read("warnings");
  if (svg === null && error === null) return null;
  return {svg: svg, warnings: warnings === null ? [] : warnings.replace(/\n$/, "").split("\n"),
          error: error === null ? null : error.replace(/\n$/, "")};
}

function writeExpected(name, result) {
  fs.mkdirSync(EXPECTED_DIR, {recursive: true});
  const content = {
    svg: result.svg,
    error: result.error === null ? null : result.error + "\n",
    warnings: result.warnings.length ? result.warnings.join("\n") + "\n" : null
  };
  for (const kind of KINDS) {
    const p = expectedPath(name, kind);
    if (content[kind] !== null) fs.writeFileSync(p, content[kind]);
    else fs.rmSync(p, {force: true});
  }
}

function collect(inputs) {
  const files = [];
  for (const p of inputs) {
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) {
        const fp = path.join(p, f);
        if (/\.(nvg|svgb)$/i.test(f) && fs.statSync(fp).isFile()) files.push(fp);
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
  let fuzz = 0, seed = 1, update = false;
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fuzz") fuzz = parseInt(argv[++i], 10);
    else if (argv[i] === "--seed") seed = parseInt(argv[++i], 10);
    else if (argv[i] === "--update") update = true;
    else inputs.push(argv[i]);
  }
  if (!inputs.length) {
    console.error("usage: node web/check.js FILE|DIR... [--fuzz N] [--seed S] [--update]");
    return 2;
  }

  const files = collect(inputs).map(f => ({name: path.basename(f), label: f, data: fs.readFileSync(f)}));
  let failures = 0, decoded = 0, rejected = 0;
  const count = r => { if (r.error) rejected++; else decoded++; };

  for (const f of files) {
    const got = decode(f.data, f.name);
    if (got.error && got.error.startsWith("crash:")) {
      failures++;
      console.log("FAIL " + f.label + "\n  " + got.error);
      continue;
    }
    count(got);
    if (update) {
      writeExpected(f.name, got);
      console.log("wrote " + f.label);
      continue;
    }
    const want = readExpected(f.name);
    if (want === null) {
      failures++;
      console.log("FAIL " + f.label + "  (no expected output; run with --update)");
      continue;
    }
    if (JSON.stringify(got) === JSON.stringify(want)) {
      console.log("ok   " + f.label + (got.error ? "  (rejected: " + got.error + ")" : ""));
      continue;
    }
    failures++;
    console.log("FAIL " + f.label);
    for (const key of ["error", "warnings", "svg"]) {
      const a = JSON.stringify(want[key]), b = JSON.stringify(got[key]);
      if (a !== b) {
        console.log("  expected " + key + ": " + a.slice(0, 400));
        console.log("  got      " + key + ": " + b.slice(0, 400));
      }
    }
  }

  const bases = files.filter(f => f.data.length);
  const rand = mulberry32(seed);
  for (let i = 0; i < fuzz && bases.length; i++) {
    const base = bases[Math.floor(rand() * bases.length)];
    const got = decode(mutate(base.data, rand), base.name);
    if (got.error && got.error.startsWith("crash:")) {
      failures++;
      console.log("FAIL " + base.label + " (fuzz #" + i + ", seed " + seed + ")\n  " + got.error);
    } else {
      count(got);
    }
  }

  console.log("\n%d cases: %d decoded, %d rejected, %d failures", files.length + fuzz,
              decoded, rejected, failures);
  return failures ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
