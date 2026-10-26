// ─── scripts/bundle.js: what makes a bundle unshippable ───
//
// The VSIX carries the two esbuild bundles and no node_modules, so the build
// itself refuses a bundle that pulled in code that must never ship (the hosted
// server, the bench, tests, webview sources) or that still requires a package
// at run time. These drive checkBuild() with hand-made metafiles and outputs,
// and check the built bundles in out/bundle/ (they need `npm run compile`).

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundle = require('../../../../scripts/bundle') as {
  ENTRIES: Record<string, string>;
  OUTDIR: string;
  EXTERNAL: string[];
  checkBuild(metafile: { inputs: Record<string, unknown> }, outdirAbs: string): string[];
};

/** A temp out dir holding extension.js and cli.js with the given sources. */
function outputs(ext: string, cli: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-bundle-'));
  fs.writeFileSync(path.join(dir, 'extension.js'), ext);
  fs.writeFileSync(path.join(dir, 'cli.js'), cli);
  return dir;
}

const CLEAN_INPUTS = { 'src/extension.ts': {}, 'src/headless/cli.ts': {}, 'node_modules/@anthropic-ai/sdk/index.mjs': {} };

describe('scripts/bundle.js', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); } });
  const out = (ext: string, cli: string): string => { const d = outputs(ext, cli); made.push(d); return d; };

  it('exports the entries, the output folder and the externals the package.json paths rely on', () => {
    assert.deepEqual(bundle.ENTRIES, { extension: 'src/extension.ts', cli: 'src/headless/cli.ts' });
    assert.equal(bundle.OUTDIR, 'out/bundle');
    assert.deepEqual(bundle.EXTERNAL, ['vscode']);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')) as { main: string; bin: { moag: string } };
    assert.equal(pkg.main, './out/bundle/extension.js');
    assert.equal(pkg.bin.moag, './out/bundle/cli.js');
  });

  it('a clean build has no problems: built-ins (with and without node:), vscode, and the CLI\'s bench edge', () => {
    const dir = out(
      'const fs = require("fs"); const p = require("node:path"); const vscode = require("vscode");',
      'const os = require(\'os\'); let h; try { h = require("../bench/harness"); } catch { /* dev only */ }',
    );
    assert.deepEqual(bundle.checkBuild({ inputs: CLEAN_INPUTS }, dir), []);
  });

  it('refuses server, bench, test and webview sources among the inputs', () => {
    const dir = out('', '');
    const problems = bundle.checkBuild({ inputs: {
      ...CLEAN_INPUTS,
      'src/server/secrets.ts': {}, 'src/bench/harness.ts': {}, 'src/test/unit/x.test.ts': {}, 'src/webview/sidebar.ts': {},
      'src/shared/stacks.ts': {},
    } }, dir);
    assert.deepEqual(problems.sort(), [
      'a shipped bundle includes src/bench/harness.ts',
      'a shipped bundle includes src/server/secrets.ts',
      'a shipped bundle includes src/test/unit/x.test.ts',
      'a shipped bundle includes src/webview/sidebar.ts',
    ]);
  });

  it('refuses a bare require of a package, and the bench edge anywhere but the CLI', () => {
    const dir = out('require("@anthropic-ai/sdk"); require("../bench/harness");', 'require("encoding");');
    assert.deepEqual(bundle.checkBuild({ inputs: CLEAN_INPUTS }, dir).sort(), [
      'out/bundle/cli.js requires "encoding", which is neither a built-in nor external by design',
      'out/bundle/extension.js requires "../bench/harness", which is neither a built-in nor external by design',
      'out/bundle/extension.js requires "@anthropic-ai/sdk", which is neither a built-in nor external by design',
    ]);
  });

  it('the built bundles require nothing but built-ins, vscode and the bench edge', () => {
    const outdir = path.join(REPO, bundle.OUTDIR);
    if (!fs.existsSync(path.join(outdir, 'cli.js'))) { assert.fail('out/bundle/cli.js is missing; run `npm run compile` before the unit suite.'); }
    const inputs = Object.fromEntries(Object.values(bundle.ENTRIES).map((e) => [e, {}]));
    assert.deepEqual(bundle.checkBuild({ inputs }, outdir), []);
  });

  it('the built CLI exports main (the installed launcher calls require(cli).main(argv))', () => {
    const cli = path.join(REPO, bundle.OUTDIR, 'cli.js');
    if (!fs.existsSync(cli)) { assert.fail('out/bundle/cli.js is missing; run `npm run compile` before the unit suite.'); }
    const text = fs.readFileSync(cli, 'utf-8');
    assert.match(text, /^\s*main: \(\) => main,?$/m);
  });
});
