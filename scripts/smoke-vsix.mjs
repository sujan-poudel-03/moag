#!/usr/bin/env node
// ─── Packaging smoke test: does the VSIX load? ───
//
// Unit and integration tests run against the repository's out/, which holds every
// compiled file; the VSIX holds only what .vscodeignore lets through. 0.9.13 and
// 0.9.14 shipped an extension that could not activate ("Cannot find module
// '../server/secrets'") while every test passed. This packages the extension (or
// takes a VSIX), unzips it, and checks the unzipped copy:
//
//   1. the package is the bundle and nothing else: under MAX_ENTRIES files, no
//      node_modules, no source maps, and nothing under out/headless/ except the
//      CLI launcher that "Install Command-Line Tool" copies out;
//   2. package.json `main` loads with a stub `vscode` module whose exports are the
//      names @types/vscode declares, as own properties (esbuild's __toESM copies
//      only own keys, so a bare Proxy leaves `vscode.TreeItem` undefined);
//   3. package.json `bin.moag` --help: exit 0 or 2, never "Cannot find module";
//   4. `bin.moag verify does-not-exist.json`: exit 2, "Failed to load plan", never
//      "Cannot find module" — this loads the verify path's lazy modules after the
//      headless vscode shim is installed.
//
// Usage:
//   node scripts/smoke-vsix.mjs                 package with vsce, then smoke it
//   node scripts/smoke-vsix.mjs --vsix <file>   smoke an existing VSIX
//
// Exit 0 when every check passes, 1 otherwise.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

/** A VSIX with this many files or more is not the bundle (0.9.15 had 686). */
const MAX_ENTRIES = 60;
/** The one file under out/headless/ the package keeps: the CLI launcher. */
const HEADLESS_ALLOWED = new Set(['extension/out/headless/moag-launch.js']);

/** Every top-level name @types/vscode exports (class, namespace, enum, function, const). */
function vscodeExportNames() {
  const dts = fs.readFileSync(path.join(REPO, 'node_modules', '@types', 'vscode', 'index.d.ts'), 'utf-8');
  const names = new Set();
  for (const m of dts.matchAll(/^\t?export (class|namespace|enum|function|const|let|var) (\w+)/gm)) { names.add(m[2]); }
  return [...names].sort();
}

/**
 * A `vscode` stand-in. Every name @types/vscode exports is an OWN property, so
 * esbuild's __toESM (and tsc's __importStar) see it. Capitalised names (classes,
 * enums) are constructors; everything they return, and every property or call
 * on anything, yields the stub again.
 */
function vscodeStubSource(names) {
  return `'use strict';
const handler = {
  get(t, p) {
    if (p === '__esModule') { return true; }
    if (p === 'then') { return undefined; }
    if (p === Symbol.toPrimitive) { return () => ''; }
    if (p === 'prototype') { return t.prototype; }
    return stub;
  },
  apply() { return stub; },
  construct() { return stub; },
};
const stub = new Proxy(function vscode() { /* stub */ }, handler);
const ctor = (name) => new Proxy({ [name]: function () { return stub; } }[name], handler);
const names = ${JSON.stringify(names)};
const out = { __esModule: true };
for (const n of names) { out[n] = /^[A-Z]/.test(n) ? ctor(n) : stub; }
module.exports = out;
`;
}

/** Loads the extension's `main` with 'vscode' resolved to the stub; prints LOADED on success. */
const LOAD_EXTENSION = `
const Module = require('module');
const [stubPath, extPath] = process.argv.slice(1);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? stubPath : resolve.call(this, request, ...rest);
};
const ext = require(extPath);
if (typeof ext.activate !== 'function') { console.error('main does not export activate()'); process.exit(1); }
if (typeof ext.deactivate !== 'function') { console.error('main does not export deactivate()'); process.exit(1); }
console.log('LOADED ' + Object.keys(ext).join(','));
`;

function parseArgs(argv) {
  const out = { vsix: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vsix') { out.vsix = argv[++i]; }
    else if (argv[i] === '--help' || argv[i] === '-h') { out.help = true; }
    else { throw new Error(`Unknown argument: ${argv[i]}`); }
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', shell: opts.shell ?? false, cwd: opts.cwd, timeout: opts.timeout ?? 300_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
}

function unzip(vsix, dest) {
  // Windows ships bsdtar, which reads zip; Linux and macOS runners have unzip. On
  // Windows the System32 copy is named explicitly: Git Bash puts GNU tar first on
  // PATH, which reads "C:" as a remote host and cannot open zip files.
  const winTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const r = isWin
    ? run(fs.existsSync(winTar) ? winTar : 'tar', ['-xf', vsix, '-C', dest])
    : run('unzip', ['-q', '-o', vsix, '-d', dest]);
  if (r.status !== 0) { throw new Error(`Could not unzip ${vsix}: ${r.error?.message ?? r.out}`); }
}

/** Every file under `dir`, as POSIX paths relative to it. */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); } else { out.push(path.relative(dir, full).split(path.sep).join('/')); }
    }
  };
  walk(dir);
  return out.sort();
}

/** The `bin.moag` path from a package.json object, or null. */
function binPath(pkg) {
  const bin = pkg.bin;
  if (typeof bin === 'string') { return bin; }
  return bin && typeof bin.moag === 'string' ? bin.moag : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/smoke-vsix.mjs [--vsix <file>]');
    return 0;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-smoke-vsix-'));
  try {
    const vsix = args.vsix ? path.resolve(args.vsix) : path.join(work, 'moag.vsix');
    if (!args.vsix) {
      console.log('Packaging with vsce...');
      // npx is a .cmd on Windows and needs a shell; one command string avoids Node's DEP0190 warning.
      const p = isWin
        ? run(`npx --yes @vscode/vsce package -o "${vsix}"`, [], { cwd: REPO, shell: true, timeout: 600_000 })
        : run('npx', ['--yes', '@vscode/vsce', 'package', '-o', vsix], { cwd: REPO, timeout: 600_000 });
      if (p.status !== 0) { console.error(p.out); console.error('FAIL: vsce package failed'); return 1; }
    }
    if (!fs.existsSync(vsix)) { console.error(`FAIL: ${vsix} does not exist`); return 1; }
    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    unzip(vsix, unpacked);
    const extDir = path.join(unpacked, 'extension');
    const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf-8'));
    const mainRel = typeof pkg.main === 'string' ? pkg.main : null;
    const cliRel = binPath(pkg);
    const stub = path.join(work, 'vscode-stub.js');
    fs.writeFileSync(stub, vscodeStubSource(vscodeExportNames()));
    // The CLI writes nothing for these checks, but give it an empty folder of its own.
    const cwd = path.join(work, 'cwd');
    fs.mkdirSync(cwd);
    console.log(`Smoking ${vsix}`);

    let failed = false;
    const pass = (msg) => { console.log(`PASS  ${msg}`); };
    const fail = (msg) => { failed = true; console.error(`FAIL  ${msg}`); };

    // 1. Contents.
    const files = listFiles(unpacked);
    const contents = [
      [files.length < MAX_ENTRIES, `${files.length} files (under ${MAX_ENTRIES})`],
      [!files.some((f) => f.startsWith('extension/node_modules/')), 'no node_modules'],
      [!files.some((f) => f.endsWith('.map')), 'no source maps'],
      [!files.some((f) => f.startsWith('extension/out/headless/') && !HEADLESS_ALLOWED.has(f)), 'nothing under out/headless/ but the CLI launcher'],
    ];
    for (const [ok, what] of contents) { if (ok) { pass(what); } else { fail(what); } }
    if (failed) { console.error(files.map((f) => `      ${f}`).join('\n')); }

    // 2. The extension entry point.
    if (!mainRel) {
      fail('package.json has no main');
    } else {
      const load = run(process.execPath, ['-e', LOAD_EXTENSION, stub, path.join(extDir, mainRel)], { cwd: work, timeout: 60_000 });
      if (load.status === 0 && /LOADED/.test(load.out) && !/Cannot find module/.test(load.out)) {
        pass(`${mainRel} loads with a stub vscode`);
      } else {
        fail(`${mainRel} did not load (exit ${load.status})\n${load.out.trim()}`);
      }
    }

    // 3 and 4. The CLI entry point.
    if (!cliRel) {
      fail('package.json has no bin.moag');
    } else {
      const cliAbs = path.join(extDir, cliRel);
      const help = run(process.execPath, [cliAbs, '--help'], { cwd, timeout: 60_000 });
      if ((help.status === 0 || help.status === 2) && !/Cannot find module/.test(help.out)) {
        pass(`${cliRel} --help (exit ${help.status})`);
      } else {
        fail(`${cliRel} --help (exit ${help.status})\n${help.out.trim()}`);
      }
      const verify = run(process.execPath, [cliAbs, 'verify', 'does-not-exist.json', '--cwd', cwd], { cwd, timeout: 60_000 });
      if (verify.status === 2 && /Failed to load plan/.test(verify.out) && !/Cannot find module/.test(verify.out)) {
        pass(`${cliRel} verify does-not-exist.json (exit 2, "Failed to load plan")`);
      } else {
        fail(`${cliRel} verify does-not-exist.json (exit ${verify.status}; want 2 and "Failed to load plan")\n${verify.out.trim()}`);
      }
    }

    console.log(failed ? 'VSIX smoke: FAILED' : 'VSIX smoke: passed');
    return failed ? 1 : 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
