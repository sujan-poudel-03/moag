#!/usr/bin/env node
'use strict';
// ─── Bundle the shipped entry points with esbuild ───
//
// The VSIX ships two JavaScript entry points, each as one self-contained file:
//
//   out/bundle/extension.js   the VS Code extension (package.json `main`)
//   out/bundle/cli.js         the headless `moag` CLI (package.json `bin.moag`)
//
// Everything they import is inlined, including @anthropic-ai/sdk, so the VSIX
// carries no node_modules. Only Node built-ins and `vscode` stay external, plus
// the CLI's one guarded development edge, require('../bench/harness'), which
// resolves to out/bench/harness.js in a source checkout and is caught as
// MODULE_NOT_FOUND in the VSIX.
//
// The bundles live in out/bundle/ so the __dirname-relative paths the code
// uses keep working: ../webview (webview scripts), ../../package.json, and the
// CLI's sibling cli.js. tsc still compiles everything to out/ for the hosted
// server, Docker and source-checkout daemons; this is an extra output.
//
// The build fails when the bundle reaches code that must never ship
// (src/server, src/bench, src/test, src/webview), or when the output requires a
// package that is neither a built-in nor `vscode` (it would be missing at run
// time, because node_modules is not in the VSIX).
//
// Usage:
//   node scripts/bundle.js                 development build (linked source maps)
//   node scripts/bundle.js --production    no source maps (what the VSIX ships)
//   node scripts/bundle.js --watch         rebuild on change; prints
//                                          "[watch] build started" / "[watch] build finished"
//
// Dependency-free: esbuild is loaded only when building.

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.resolve(__dirname, '..');

/** Bundle name (out/bundle/<name>.js) → entry source, relative to the repo root. */
const ENTRIES = { extension: 'src/extension.ts', cli: 'src/headless/cli.ts' };
const OUTDIR = 'out/bundle';
/** Packages left as runtime `require`s. Built-ins are external by platform: 'node'. */
const EXTERNAL = ['vscode'];

/** Inputs that must never reach a shipped bundle. */
const FORBIDDEN_INPUT = /^src\/(server|bench|test|webview)\//;

/** The only non-built-in, non-vscode requires each bundle may keep. */
const ALLOWED_REQUIRES = { 'cli.js': ['../bench/harness'] };

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Keeps `../bench/...` out of the bundle: a development tool, guarded by MODULE_NOT_FOUND. */
const benchExternal = {
  name: 'bench-external',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/bench\// }, (args) => ({ path: args.path, external: true }));
  },
};

/**
 * Problems with a finished build: forbidden inputs, and bare requires the
 * runtime could not satisfy. Empty when the bundles are shippable.
 */
function checkBuild(metafile, outdirAbs) {
  const problems = [];
  for (const input of Object.keys(metafile.inputs)) {
    const rel = input.split(path.sep).join('/');
    if (FORBIDDEN_INPUT.test(rel)) { problems.push(`a shipped bundle includes ${rel}`); }
  }
  for (const name of Object.keys(ENTRIES)) {
    const file = `${name}.js`;
    const text = fs.readFileSync(path.join(outdirAbs, file), 'utf-8');
    const allowed = new Set([...EXTERNAL, ...(ALLOWED_REQUIRES[file] ?? [])]);
    for (const m of text.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      const spec = m[2];
      if (BUILTINS.has(spec) || allowed.has(spec)) { continue; }
      problems.push(`${OUTDIR}/${file} requires "${spec}", which is neither a built-in nor external by design`);
    }
  }
  return [...new Set(problems)];
}

function loadEsbuild() {
  try {
    return require('esbuild');
  } catch {
    console.error('esbuild missing; run npm install');
    process.exit(1);
  }
}

function options(production) {
  return {
    absWorkingDir: ROOT,
    entryPoints: ENTRIES,
    outdir: OUTDIR,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: false,
    sourcemap: production ? false : 'linked',
    metafile: true,
    external: EXTERNAL,
    plugins: [benchExternal],
    logLevel: 'warning',
  };
}

async function main(argv) {
  const esbuild = loadEsbuild();
  const production = argv.includes('--production');
  const outdirAbs = path.join(ROOT, OUTDIR);

  if (argv.includes('--watch')) {
    const ctx = await esbuild.context({
      ...options(false),
      plugins: [
        benchExternal,
        {
          name: 'watch-log',
          setup(build) {
            build.onStart(() => { console.log('[watch] build started'); });
            build.onEnd((result) => {
              if (result.metafile && result.errors.length === 0) {
                for (const p of checkBuild(result.metafile, outdirAbs)) { console.error(`✘ [ERROR] ${p}`); }
              }
              console.log('[watch] build finished');
            });
          },
        },
      ],
    });
    await ctx.watch();
    return 0;
  }

  // A stale map next to a production bundle would be shipped-adjacent noise.
  for (const name of Object.keys(ENTRIES)) { fs.rmSync(path.join(outdirAbs, `${name}.js.map`), { force: true }); }
  const result = await esbuild.build(options(production));
  const problems = checkBuild(result.metafile, outdirAbs);
  if (problems.length > 0) {
    for (const p of problems) { console.error(`bundle: ${p}`); }
    return 1;
  }
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(`bundle: ${Object.keys(ENTRIES).map((n) => `${OUTDIR}/${n}.js`).join(', ')} (${inputs} inputs${production ? ', production' : ''})`);
  return 0;
}

module.exports = { ENTRIES, OUTDIR, EXTERNAL, FORBIDDEN_INPUT, ALLOWED_REQUIRES, checkBuild };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== 0) { process.exitCode = code; } },
    (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; },
  );
}
