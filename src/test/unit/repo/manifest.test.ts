// ─── Extension manifest: the declared VS Code floor matches the API we compile against ───
//
// engines.vscode is the oldest VS Code the Marketplace will install MOAG into;
// @types/vscode is the API surface tsc lets the code use. If the types run ahead
// of the engine, code can call an API (vscode.lm, say) that the oldest supported
// VS Code does not have, and it compiles clean. Keeping the two on the same
// major.minor makes tsc the check.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

interface Manifest {
  engines?: { vscode?: string };
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as Manifest;

/** The `major.minor` of a semver range such as `^1.90.0` or `~1.90.0`, or null. */
function majorMinor(range: string | undefined): string | null {
  const m = /^\s*[~^]?(\d+)\.(\d+)\.\d+/.exec(range ?? '');
  return m ? `${m[1]}.${m[2]}` : null;
}

describe('extension manifest (package.json)', () => {
  it('majorMinor reads caret and tilde ranges, and refuses anything else', () => {
    assert.equal(majorMinor('^1.90.0'), '1.90');
    assert.equal(majorMinor('~1.90.3'), '1.90');
    assert.equal(majorMinor('1.85.0'), '1.85');
    assert.equal(majorMinor('*'), null);
    assert.equal(majorMinor(undefined), null);
  });

  it('engines.vscode and @types/vscode share one major.minor', () => {
    const engine = majorMinor(manifest.engines?.vscode);
    const types = majorMinor(manifest.devDependencies?.['@types/vscode']);
    assert.ok(engine, `engines.vscode is not a plain semver range: ${manifest.engines?.vscode}`);
    assert.ok(types, `@types/vscode is not a plain semver range: ${manifest.devDependencies?.['@types/vscode']}`);
    assert.equal(types, engine, `@types/vscode ${types} would let the code use APIs VS Code ${engine} lacks (or vice versa)`);
  });

  it('@types/vscode is pinned to patch releases (~), so the API surface cannot drift ahead', () => {
    assert.match(manifest.devDependencies?.['@types/vscode'] ?? '', /^~/);
  });

  it('the installed @types/vscode is the declared one', () => {
    const installed = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', '@types', 'vscode', 'package.json'), 'utf8')) as { version: string };
    assert.equal(majorMinor(installed.version), majorMinor(manifest.engines?.vscode));
  });
});
