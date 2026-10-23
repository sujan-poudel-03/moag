#!/usr/bin/env node
// ─── Packaging smoke test: does the VSIX load? ───
//
// Unit and integration tests run against the repository's out/, which holds every
// compiled file; the VSIX holds only what .vscodeignore lets through. 0.9.13 and
// 0.9.14 shipped an extension that could not activate ("Cannot find module
// '../server/secrets'") while every test passed. This packages the extension (or
// takes a VSIX), unzips it, and loads the two shipped entry points from the
// unzipped copy:
//
//   1. require extension/out/extension.js with a stub `vscode` module (nothing is
//      called; loading the module graph is the check);
//   2. node extension/out/headless/cli.js --help: exit 0 or 2, never "Cannot find module".
//
// Usage:
//   node scripts/smoke-vsix.mjs                 package with vsce, then smoke it
//   node scripts/smoke-vsix.mjs --vsix <file>   smoke an existing VSIX
//
// Exit 0 when both checks pass, 1 otherwise.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

/**
 * A `vscode` stand-in: every property, call and construction yields the stub
 * again. `__esModule` is true so tsc's `__importStar` hands the proxy through
 * instead of copying its (few) own keys, which would leave `vscode.TreeItem`
 * undefined for `class X extends vscode.TreeItem`.
 */
const VSCODE_STUB = `'use strict';
const handler = {
  get(_t, p) {
    if (p === '__esModule') { return true; }
    if (p === 'then') { return undefined; }
    if (p === Symbol.toPrimitive) { return () => ''; }
    if (p === 'prototype') { return {}; }
    return stub;
  },
  apply() { return stub; },
  construct() { return stub; },
};
const stub = new Proxy(function vscode() { /* stub */ }, handler);
module.exports = stub;
`;

/** Loads extension.js with 'vscode' resolved to the stub; prints LOADED on success. */
const LOAD_EXTENSION = `
const Module = require('module');
const [stubPath, extPath] = process.argv.slice(1);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? stubPath : resolve.call(this, request, ...rest);
};
const ext = require(extPath);
if (typeof ext.activate !== 'function') { console.error('extension.js does not export activate()'); process.exit(1); }
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/smoke-vsix.mjs [--vsix <file>]');
    return 0;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-smoke-vsix-'));
  try {
    let vsix = args.vsix ? path.resolve(args.vsix) : path.join(work, 'moag.vsix');
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
    const stub = path.join(work, 'vscode-stub.js');
    fs.writeFileSync(stub, VSCODE_STUB);
    console.log(`Smoking ${vsix}`);

    let failed = false;

    const load = run(process.execPath, ['-e', LOAD_EXTENSION, stub, path.join(extDir, 'out', 'extension.js')], { cwd: work, timeout: 60_000 });
    if (load.status === 0 && /LOADED/.test(load.out) && !/Cannot find module/.test(load.out)) {
      console.log('PASS  extension.js loads with a stub vscode');
    } else {
      failed = true;
      console.error(`FAIL  extension.js did not load (exit ${load.status})\n${load.out.trim()}`);
    }

    const cli = run(process.execPath, [path.join(extDir, 'out', 'headless', 'cli.js'), '--help'], { cwd: work, timeout: 60_000 });
    if ((cli.status === 0 || cli.status === 2) && !/Cannot find module/.test(cli.out)) {
      console.log(`PASS  headless/cli.js --help (exit ${cli.status})`);
    } else {
      failed = true;
      console.error(`FAIL  headless/cli.js --help (exit ${cli.status})\n${cli.out.trim()}`);
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
