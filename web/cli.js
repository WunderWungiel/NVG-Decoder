#!/usr/bin/env node
/* Command-line front end for nvg2svg.js. Needs only Node.js.
 *
 *   node web/cli.js icon.nvg               -> icon.svg next to the input
 *   node web/cli.js a.nvg b.nvg -d out/    -> out/a.svg, out/b.svg
 *   node web/cli.js icons/                 -> every *.nvg and *.svgb in the directory
 *   node web/cli.js icon.nvg -o -          -> SVG on stdout
 *   node web/cli.js icon.nvg -v            -> also dump the decoded structure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const NVG = require("./nvg2svg.js");

const USAGE = "usage: nvg2svg [-h] [-o FILE | -d DIR] [-v] [--version] INPUT [INPUT ...]";

const HELP = USAGE + `

Decode Nokia NVG vector graphics files (Symbian^3, svgtbinencode -v 5) back
to SVG.

positional arguments:
  INPUT                NVG file(s) or directories containing .nvg/.svgb files

options:
  -h, --help           show this help message and exit
  -o, --output FILE    output SVG file ('-' for stdout); single input only
  -d, --outdir DIR     directory to write the SVG files into
  -v, --verbose        print the decoded NVG structure to stderr
  --version            show program's version number and exit
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = {inputs: [], output: null, outdir: null, verbose: false};
  let onlyInputs = false;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i], value = null;
    if (onlyInputs || arg === "-" || !arg.startsWith("-")) {
      args.inputs.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyInputs = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const takeValue = () => {
      if (value !== null) return value;
      if (i + 1 >= argv.length) throw new UsageError("argument " + arg + ": expected one argument");
      return argv[++i];
    };
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--version") {
      console.log("nvg2svg " + NVG.VERSION);
      process.exit(0);
    } else if (arg === "-v" || arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "-o" || arg === "--output") {
      args.output = takeValue();
    } else if (arg === "-d" || arg === "--outdir") {
      args.outdir = takeValue();
    } else {
      throw new UsageError("unrecognized argument: " + argv[i]);
    }
  }
  if (!args.inputs.length) throw new UsageError("the following arguments are required: INPUT");
  if (args.output !== null && args.outdir !== null) {
    throw new UsageError("argument -d/--outdir: not allowed with argument -o/--output");
  }
  return args;
}

function collectInputs(paths) {
  const files = [];
  for (const p of paths) {
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch (exc) {
      // reported when the file is opened
    }
    if (!isDir) {
      files.push(p);
      continue;
    }
    const found = fs.readdirSync(p).sort()
      .map(f => path.join(p, f))
      .filter(f => /\.(nvg|svgb)$/i.test(f) && fs.statSync(f).isFile());
    if (!found.length) console.error("nvg2svg: no .nvg or .svgb files in " + p);
    files.push(...found);
  }
  return files;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    if (!(exc instanceof UsageError)) throw exc;
    console.error(USAGE + "\nnvg2svg: error: " + exc.message);
    return 2;
  }

  const files = collectInputs(args.inputs);
  if (args.output !== null && files.length !== 1) {
    console.error(USAGE + "\nnvg2svg: error: -o/--output needs exactly one input file");
    return 2;
  }
  if (args.outdir !== null) fs.mkdirSync(args.outdir, {recursive: true});

  let failures = 0;
  for (const file of files) {
    const log = args.verbose ? msg => console.error(file + ": " + msg) : null;
    let result;
    try {
      result = NVG.decode(fs.readFileSync(file), path.basename(file), log);
    } catch (exc) {
      if (!(exc instanceof NVG.NvgError) && !exc.code) throw exc;
      console.error("nvg2svg: " + file + ": " + exc.message);
      failures++;
      continue;
    }
    if (!args.verbose) {
      for (const w of result.warnings) console.error("nvg2svg: " + file + ": warning: " + w);
    }

    if (args.output === "-") {
      process.stdout.write(result.svg);
      continue;
    }
    const outPath = args.output !== null ? args.output :
      path.join(args.outdir !== null ? args.outdir : path.dirname(file),
                path.parse(file).name + ".svg");
    try {
      fs.writeFileSync(outPath, result.svg);
    } catch (exc) {
      console.error("nvg2svg: " + outPath + ": " + exc.message);
      failures++;
      continue;
    }
    console.error(file + " -> " + outPath);
  }
  return failures ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
