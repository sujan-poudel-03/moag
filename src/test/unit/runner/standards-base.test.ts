// ─── The local standards base — captured when a run starts, kept until a verification passes ───

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectStandardsInput } from '../../../runner/evidence';
import {
  clearStandardsBase, readStandardsBase, rememberStandardsBase, resolveStandardsBase, standardsBasePath,
} from '../../../runner/standards-base';
import { builtInProfile } from '../../../standards/built-in-profiles';
import { checkStandards, standardsBlocked } from '../../../standards/checker';
import { writeLocalStandards } from '../../../standards/local-store';
import { sampleProvenance } from '../standards/fixtures';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

/** A repository with one commit and a standards file; resolves its HEAD. */
function seedRepo(dir: string, opts: { standards?: boolean } = {}): string {
  git(dir, 'init', '-q', '.');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.moag/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  if (opts.standards !== false) {
    writeLocalStandards(dir, { schemaVersion: 1, version: 1, profile: builtInProfile('other'), provenance: sampleProvenance() });
  }
  return git(dir, 'rev-parse', 'HEAD').trim();
}

async function withGit(ctx: Mocha.Context, body: () => Promise<void>): Promise<void> {
  ctx.timeout(60_000);
  try {
    await body();
  } catch (err) {
    if (isSpawnEperm(err)) { ctx.skip(); return; }
    throw err;
  }
}

describe('standards base — capture at run start', () => {
  it('records HEAD as it stands, once: a later run does not move it', async function () {
    await withGit(this, async () => {
      const dir = makeTempDir('moag-base-capture-');
      const first = seedRepo(dir);
      await rememberStandardsBase(dir, new Date('2026-10-06T10:00:00.000Z'));
      assert.deepEqual(readStandardsBase(dir), { ref: first, capturedAt: '2026-10-06T10:00:00.000Z' });

      // The run commits; a fix iteration then starts another run. The base must not follow HEAD.
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'agent work');
      await rememberStandardsBase(dir, new Date('2026-10-06T11:00:00.000Z'));
      assert.deepEqual(readStandardsBase(dir), { ref: first, capturedAt: '2026-10-06T10:00:00.000Z' });
    });
  });

  it('records null for a repository with no commit yet, and for a directory that is not a repository', async function () {
    await withGit(this, async () => {
      const empty = makeTempDir('moag-base-empty-');
      git(empty, 'init', '-q', '.');
      writeLocalStandards(empty, { schemaVersion: 1, version: 1, profile: builtInProfile('other'), provenance: sampleProvenance() });
      await rememberStandardsBase(empty);
      assert.equal(readStandardsBase(empty)?.ref, null);

      const plain = makeTempDir('moag-base-plain-');
      writeLocalStandards(plain, { schemaVersion: 1, version: 1, profile: builtInProfile('other'), provenance: sampleProvenance() });
      await rememberStandardsBase(plain);
      assert.equal(readStandardsBase(plain)?.ref, null);
    });
  });

  it('writes nothing in a workspace that has no standards file', async function () {
    await withGit(this, async () => {
      const dir = makeTempDir('moag-base-nostd-');
      seedRepo(dir, { standards: false });
      await rememberStandardsBase(dir);
      assert.equal(fs.existsSync(standardsBasePath(dir)), false);
      assert.equal(readStandardsBase(dir), null);
    });
  });

  it('never throws: an unwritable location is swallowed', async () => {
    const dir = makeTempDir('moag-base-blocked-');
    fs.mkdirSync(path.join(dir, '.moag'));
    fs.writeFileSync(path.join(dir, '.moag', 'standards.json'), '{}');
    // A directory where the file should go: the write cannot succeed.
    fs.mkdirSync(standardsBasePath(dir));
    await assert.doesNotReject(rememberStandardsBase(dir));
    assert.equal(readStandardsBase(dir), null);
  });
});

describe('standards base — reading', () => {
  const write = (dir: string, content: string): void => {
    fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
    fs.writeFileSync(standardsBasePath(dir), content);
  };

  it('returns null for a missing, malformed, oversize or wrong-shaped file — never a guess', () => {
    const dir = makeTempDir('moag-base-read-');
    assert.equal(readStandardsBase(dir), null);
    for (const bad of [
      '', '{', '[]', '"abc"', '{"schemaVersion":2,"ref":"abc1234"}', '{"schemaVersion":1}',
      '{"schemaVersion":1,"ref":"--upload-pack=x"}', '{"schemaVersion":1,"ref":"HEAD"}', '{"schemaVersion":1,"ref":7}',
      JSON.stringify({ schemaVersion: 1, ref: 'a'.repeat(40), pad: 'x'.repeat(8_000) }),
    ]) {
      write(dir, bad);
      assert.equal(readStandardsBase(dir), null, bad.slice(0, 60));
    }
    write(dir, JSON.stringify({ schemaVersion: 1, ref: 'a'.repeat(40), capturedAt: 'then' }));
    assert.deepEqual(readStandardsBase(dir), { ref: 'a'.repeat(40), capturedAt: 'then' });
    write(dir, JSON.stringify({ schemaVersion: 1, ref: null }));
    assert.deepEqual(readStandardsBase(dir), { ref: null, capturedAt: '' });
  });

  it('clear removes the file and is safe to call twice', () => {
    const dir = makeTempDir('moag-base-clear-');
    write(dir, JSON.stringify({ schemaVersion: 1, ref: 'a'.repeat(40) }));
    clearStandardsBase(dir);
    assert.equal(fs.existsSync(standardsBasePath(dir)), false);
    assert.doesNotThrow(() => clearStandardsBase(dir));
  });
});

describe('standards base — what a check diffs against', () => {
  it('an explicit base wins; then the captured one; then HEAD', async function () {
    await withGit(this, async () => {
      const dir = makeTempDir('moag-base-resolve-');
      const first = seedRepo(dir);
      assert.equal(await resolveStandardsBase(dir), first, 'nothing captured: HEAD');
      await rememberStandardsBase(dir);
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'agent work');
      const second = git(dir, 'rev-parse', 'HEAD').trim();
      assert.notEqual(second, first);
      assert.equal(await resolveStandardsBase(dir), first, 'the captured base, not the HEAD the run left behind');
      assert.equal(await resolveStandardsBase(dir, 'v1.0.0'), 'v1.0.0');
      clearStandardsBase(dir);
      assert.equal(await resolveStandardsBase(dir), second, 'verified: the next check starts from HEAD again');
    });
  });

  // The reason the base exists: work a run commits must still be inside the diff.
  it('work the run committed is still checked from the captured base, and invisible from HEAD', async function () {
    await withGit(this, async () => {
      const dir = makeTempDir('moag-base-autocommit-');
      seedRepo(dir);
      await rememberStandardsBase(dir);
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'cart.ts'), 'export function total() {\n  // ... rest of the code ...\n}\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'auto-commit: task 1');

      // The placeholder scan is promoted here, so that what the base brings back into the diff can stop a release.
      const profile = { ...builtInProfile('other'), severity: { 'comment-policy/banned-phrase': 'blocking' as const } };
      const fromHead = await collectStandardsInput(dir, git(dir, 'rev-parse', 'HEAD').trim());
      assert.deepEqual(fromHead.files, [], 'from HEAD the committed work is not in the diff at all');
      assert.equal(standardsBlocked(checkStandards(profile, fromHead)), false);

      const fromBase = await collectStandardsInput(dir, await resolveStandardsBase(dir));
      const report = checkStandards(profile, fromBase);
      assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [['src/cart.ts', 2, 'comment-policy/banned-phrase']]);
      assert.equal(standardsBlocked(report), true);
      // Under the defaults the same finding is reported from the base all the same — advisory, never invisible.
      const asDefault = checkStandards(builtInProfile('other'), fromBase);
      assert.deepEqual(asDefault.findings.map((f) => [f.file, f.line, f.rule, f.severity]), [['src/cart.ts', 2, 'comment-policy/banned-phrase', 'advisory']]);
      assert.equal(standardsBlocked(asDefault), false);
    });
  });
});
