// ─── Remote runs: code in, branches out ───

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BranchGit, BundleAssembler, exportInboundBundle, importRunBranch, IMPORT_FSCK_FLAGS, isRunBranch, projectBranchTip, projectHasBranch, SAFE_GIT_FLAGS,
  spawnBranchGit,
} from '../../../headless/remote-branch';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

function tmp(prefix = 'moag-branch-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function commit(cwd: string, file: string, text: string): string {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A recording fake git: every call's argv and cwd. */
function recording(reply: (args: string[]) => Buffer | null = () => Buffer.from('')) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const g: BranchGit = async (args, cwd) => { calls.push({ args, cwd }); return reply(args); };
  return { g, calls };
}

describe('remote branch — argv and policy (fake git)', () => {
  it('every call runs in the project with hooks and fsmonitor off; the import adds fsckObjects and has no +', async () => {
    const sha = 'c'.repeat(40);
    const { g, calls } = recording((args) => (args.includes('rev-parse') ? Buffer.from(`${sha}\n`) : Buffer.from('BUNDLE')));
    await exportInboundBundle('/projects/web', { continueBranch: 'moag/x', haveShas: [sha, 'junk'] }, g);
    await importRunBranch('/projects/web', '/state/remote/tmp/run.bundle', 'moag/x', 'moag/', g);
    assert.ok(calls.length >= 6);
    for (const c of calls) {
      assert.equal(c.cwd, '/projects/web', 'never a runner path');
      assert.deepEqual(c.args.slice(0, 4), [...SAFE_GIT_FLAGS]);
    }
    const fetch = calls.find((c) => c.args.includes('fetch'))!;
    assert.ok(fetch.args.includes(IMPORT_FSCK_FLAGS[1]));
    assert.ok(fetch.args.includes('core.fsmonitor=false'));
    assert.ok(fetch.args.includes('core.hooksPath=/dev/null'));
    assert.equal(fetch.args[fetch.args.length - 1], 'refs/heads/moag/x:refs/heads/moag/x');
    assert.ok(!fetch.args.some((a) => a.startsWith('+')), 'fast-forward only');
    assert.ok(fetch.args.includes('--no-write-fetch-head') && fetch.args.includes('--no-recurse-submodules'));
    const bundle = calls.find((c) => c.args.includes('bundle') && c.args.includes('create'))!;
    assert.deepEqual(bundle.args.slice(4), ['bundle', 'create', '-', 'HEAD', 'refs/heads/moag/x', '--not', sha]);
  });

  it('refuses a branch outside the prefix without running git', async () => {
    const { g, calls } = recording();
    for (const b of ['main', 'moag/../main', 'moagx/y', 'moag/a.lock', 'moag/']) {
      const out = await importRunBranch('/p', '/f', b, 'moag/', g);
      assert.equal(out.ok, false, b);
    }
    assert.equal(calls.length, 0);
    assert.ok(isRunBranch('moag/plan-x/run_1', 'moag/'));
  });

  it('a bundle that does not verify is refused', async () => {
    const { g } = recording((args) => (args.includes('verify') ? null : Buffer.from('')));
    const out = await importRunBranch('/p', '/f', 'moag/x', 'moag/', g);
    assert.ok(!out.ok && /did not verify/.test(out.reason));
  });

  it('export with a start sha (a parent whose branch never reached the project) bundles HEAD and keeps that start', async () => {
    const head = 'e'.repeat(40);
    const { g, calls } = recording((args) => (args.includes('rev-parse') ? Buffer.from(head) : Buffer.from('B')));
    const out = await exportInboundBundle('/p', { startSha: 'f'.repeat(40), haveShas: [] }, g);
    assert.ok(out.ok && out.startSha === 'f'.repeat(40) && out.baseSha === head);
    const bundle = calls.find((c) => c.args.includes('create'))!;
    assert.deepEqual(bundle.args.slice(4), ['bundle', 'create', '-', 'HEAD']);
    assert.equal((await exportInboundBundle('/p', { startSha: 'nope', haveShas: [] }, g)).ok, false);
  });

  it('export: no commits → refused; a missing continue branch → refused', async () => {
    assert.equal((await exportInboundBundle('/p', { haveShas: [] }, recording(() => null).g)).ok, false);
    const sha = 'd'.repeat(40);
    const out = await exportInboundBundle('/p', { continueBranch: 'moag/gone', haveShas: [] }, recording((a) => (a.includes('HEAD^{commit}') ? Buffer.from(sha) : null)).g);
    assert.ok(!out.ok && /does not exist/.test(out.reason));
  });
});

describe('remote branch — BundleAssembler', () => {
  const data = Buffer.from('some bundle bytes '.repeat(100));
  const sha = createHash('sha256').update(data).digest('hex');

  it('reassembles chunks and checks size and sha256', () => {
    const a = new BundleAssembler();
    a.addChunk(data.subarray(0, 700).toString('base64'));
    a.addChunk(data.subarray(700).toString('base64'));
    const out = a.finish({ bytes: data.length, sha256: sha });
    assert.ok(out.ok && out.data!.equals(data));
  });

  it('drops a sha mismatch, a size mismatch, an oversize bundle and a child-reported error', () => {
    const a = new BundleAssembler();
    a.addChunk(data.toString('base64'));
    assert.match((a.finish({ bytes: data.length, sha256: 'f'.repeat(64) }) as { reason: string }).reason, /damaged/);
    const b = new BundleAssembler();
    b.addChunk(data.toString('base64'));
    assert.match((b.finish({ bytes: data.length + 1, sha256: sha }) as { reason: string }).reason, /incomplete/);
    const c = new BundleAssembler(1000);
    assert.equal(c.addChunk(data.toString('base64')), false);
    assert.match((c.finish({ bytes: data.length, sha256: sha }) as { reason: string }).reason, /64 MB/);
    assert.equal(new BundleAssembler().finish({ error: 'too big' }).ok, false);
  });

  it('no commits is ok with no data', () => {
    assert.deepEqual(new BundleAssembler().finish({ bytes: 0, sha256: null }), { ok: true, data: null });
  });
});

describe('remote branch — real git round trip', function () {
  this.timeout(120_000);

  before(function () {
    try { execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }); } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); }
      throw err;
    }
  });

  it('a run resumed from the mirror imports into a project that never had the parent\'s commits', async () => {
    const project = tmp();
    git(project, 'init', '-q', '-b', 'main');
    const base = commit(project, 'a.txt', 'base\n');
    const inbound = await exportInboundBundle(project, { haveShas: [] }, spawnBranchGit);
    assert.ok(inbound.ok);
    const stage = tmp('moag-branch-stage-');
    fs.writeFileSync(path.join(stage, 'in.bundle'), inbound.bundle);
    const mirror = tmp('moag-branch-mirror-');
    git(mirror, 'init', '-q', '--bare');
    git(mirror, 'fetch', '-q', path.join(stage, 'in.bundle'), '+HEAD:refs/moag/base');

    // The parent commits on its branch in the mirror, and is interrupted: nothing is imported.
    const wt1 = path.join(tmp('moag-branch-wt-'), 'wt1');
    git(mirror, 'worktree', 'add', '-q', '-B', 'moag/run-1', wt1, base);
    const parentCommit = commit(wt1, 'parent.txt', 'parent work\n');
    git(mirror, 'worktree', 'remove', '--force', wt1);
    assert.equal(await projectHasBranch(project, 'moag/run-1', spawnBranchGit), false);

    // The resume continues from the mirror's own branch tip, commits more, and is cut from the
    // project-known base, so the parent's commit travels in the same bundle.
    const tip = git(mirror, 'rev-parse', 'refs/heads/moag/run-1');
    assert.equal(tip, parentCommit);
    const wt2 = path.join(tmp('moag-branch-wt-'), 'wt2');
    git(mirror, 'worktree', 'add', '-q', '-B', 'moag/run-1', wt2, tip);
    commit(wt2, 'resumed.txt', 'resumed work\n');
    const out = path.join(stage, 'out.bundle');
    git(mirror, 'bundle', 'create', out, 'refs/heads/moag/run-1', '--not', base);

    assert.deepEqual(await importRunBranch(project, out, 'moag/run-1', 'moag/', spawnBranchGit), { ok: true });
    assert.equal(await projectHasBranch(project, 'moag/run-1', spawnBranchGit), true);
    const files = git(project, 'ls-tree', '--name-only', 'refs/heads/moag/run-1').split('\n').sort();
    assert.deepEqual(files, ['a.txt', 'parent.txt', 'resumed.txt'], 'both the parent\'s and the resumed run\'s work arrived');
    assert.equal(git(project, 'rev-list', '--count', `${base}..refs/heads/moag/run-1`), '2');
  });

  it('a mirror resume fast-forwards a project branch that is behind (both unimported and new commits arrive)', async () => {
    const project = tmp();
    git(project, 'init', '-q', '-b', 'main');
    const base = commit(project, 'a.txt', 'base\n');
    // The project already has branch B at an older tip (an earlier run's import).
    git(project, 'branch', 'moag/run-1', base);
    git(project, 'checkout', '-q', 'moag/run-1');
    const older = commit(project, 'first.txt', 'first run\n');
    git(project, 'checkout', '-q', 'main');
    assert.equal(await projectBranchTip(project, 'moag/run-1', spawnBranchGit), older);

    // The mirror has B advanced past it: a continuation run committed, and was interrupted.
    const stage = tmp('moag-branch-stage-');
    const full = await exportInboundBundle(project, { continueBranch: 'moag/run-1', haveShas: [] }, spawnBranchGit);
    assert.ok(full.ok);
    fs.writeFileSync(path.join(stage, 'in.bundle'), full.bundle);
    const mirror = tmp('moag-branch-mirror-');
    git(mirror, 'init', '-q', '--bare');
    git(mirror, 'fetch', '-q', path.join(stage, 'in.bundle'), '+HEAD:refs/moag/base', '+refs/heads/moag/run-1:refs/heads/moag/run-1');
    const wt1 = path.join(tmp('moag-branch-wt-'), 'wt1');
    git(mirror, 'worktree', 'add', '-q', '-B', 'moag/run-1', wt1, older);
    const unimported = commit(wt1, 'second.txt', 'interrupted run\n');
    git(mirror, 'worktree', 'remove', '--force', wt1);

    // The resume continues from the mirror tip and is cut from the project-known start (older).
    const wt2 = path.join(tmp('moag-branch-wt-'), 'wt2');
    git(mirror, 'worktree', 'add', '-q', '-B', 'moag/run-1', wt2, git(mirror, 'rev-parse', 'refs/heads/moag/run-1'));
    const resumed = commit(wt2, 'third.txt', 'resumed run\n');
    const out = path.join(stage, 'out.bundle');
    git(mirror, 'bundle', 'create', out, 'refs/heads/moag/run-1', '--not', older);

    assert.deepEqual(await importRunBranch(project, out, 'moag/run-1', 'moag/', spawnBranchGit), { ok: true });
    assert.equal(git(project, 'rev-parse', 'refs/heads/moag/run-1'), resumed, 'fast-forwarded to the resumed tip');
    assert.equal(git(project, 'rev-list', '--count', `${older}..refs/heads/moag/run-1`), '2');
    assert.equal(git(project, 'merge-base', '--is-ancestor', unimported, 'refs/heads/moag/run-1'), '', 'the unimported commit is in the branch');
  });

  it('exports a thin bundle, imports a fast-forward, and refuses a non-fast-forward', async () => {
    const project = tmp();
    git(project, 'init', '-q', '-b', 'main');
    const base = commit(project, 'a.txt', 'one\n');

    // The runner's mirror: built from the first (full) bundle.
    const inbound = await exportInboundBundle(project, { haveShas: [] }, spawnBranchGit);
    assert.ok(inbound.ok && inbound.baseSha === base && inbound.bundle.length > 0);
    const stage = tmp('moag-branch-stage-');
    const inFile = path.join(stage, 'in.bundle');
    fs.writeFileSync(inFile, inbound.bundle);
    const mirror = tmp('moag-branch-mirror-');
    git(mirror, 'init', '-q', '--bare');
    git(mirror, 'fetch', '-q', inFile, '+HEAD:refs/moag/base');

    // A second export with the mirror's sha known is thin (or empty when nothing is new).
    const again = await exportInboundBundle(project, { haveShas: [base] }, spawnBranchGit);
    assert.ok(again.ok && again.bundle.length === 0, 'nothing new → empty bundle');

    // The run commits on its branch in a worktree of the mirror.
    const wt = path.join(tmp('moag-branch-wt-'), 'wt');
    git(mirror, 'worktree', 'add', '-q', '-B', 'moag/run-1', wt, base);
    commit(wt, 'b.txt', 'two\n');
    const outFile = path.join(stage, 'out.bundle');
    git(mirror, 'bundle', 'create', outFile, 'refs/heads/moag/run-1', '--not', base);

    const ok = await importRunBranch(project, outFile, 'moag/run-1', 'moag/', spawnBranchGit);
    assert.deepEqual(ok, { ok: true });
    assert.equal(git(project, 'rev-parse', 'refs/heads/moag/run-1'), git(wt, 'rev-parse', 'HEAD'));
    assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the user\'s checkout is untouched');

    // Someone moves the branch in the project; the run's bundle no longer fast-forwards it.
    git(project, 'checkout', '-q', '-B', 'tmp', 'refs/heads/moag/run-1');
    git(project, 'reset', '-q', '--hard', base);
    commit(project, 'c.txt', 'diverged\n');
    git(project, 'branch', '-f', 'moag/run-1', 'HEAD');
    git(project, 'checkout', '-q', 'main');
    const before = git(project, 'rev-parse', 'refs/heads/moag/run-1');
    const refused = await importRunBranch(project, outFile, 'moag/run-1', 'moag/', spawnBranchGit);
    assert.equal(refused.ok, false);
    assert.equal(git(project, 'rev-parse', 'refs/heads/moag/run-1'), before, 'never forced');
  });
});
