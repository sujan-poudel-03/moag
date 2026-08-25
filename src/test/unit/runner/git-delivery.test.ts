import * as assert from 'assert';
import {
  branchNameFor,
  buildCommitMessage,
  commitTask,
  describePrepareFailure,
  prepareBranch,
  slugify,
  GitRunner,
  PrepareFailure,
} from '../../../runner/git-delivery';

/**
 * A scriptable git. `routes` maps the first two argv words to a reply;
 * `null` means the command failed. Every invocation is recorded.
 */
function stubGit(routes: Record<string, string | null>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const k1 = args.slice(0, 2).join(' ');
    const k0 = args[0];
    if (k1 in routes) { return routes[k1]; }
    if (k0 in routes) { return routes[k0]; }
    return '';
  };
  return { git, calls };
}

const CLEAN = {
  'rev-parse --is-inside-work-tree': 'true',
  'status --porcelain': '',
  'symbolic-ref --quiet': 'refs/heads/main',
  'rev-parse --verify': '',
  checkout: 'Switched',
};

const CFG = { enabled: true, branchPrefix: 'moag/' };

describe('git-delivery — naming', () => {
  it('produces a git-ref-safe branch from an arbitrary plan name', () => {
    const b = branchNameFor('moag/', 'Auth Rewrite: Phase 2!!', 'run-abcdef123456');
    assert.ok(/^moag\/[a-z0-9-]+$/.test(b), `unsafe ref: ${b}`);
    assert.ok(b.startsWith('moag/auth-rewrite-phase-2'));
  });

  it('normalises a prefix given without a trailing slash', () => {
    assert.ok(branchNameFor('moag', 'p', 'r').startsWith('moag/'));
  });

  it('never yields an empty or dangling-hyphen slug', () => {
    assert.strictEqual(slugify('!!!'), 'run');
    assert.strictEqual(slugify(''), 'run');
    assert.ok(!slugify('a'.repeat(40) + ' tail').endsWith('-'));
  });

  it('separates two runs of the same plan', () => {
    const a = branchNameFor('moag/', 'Nightly', 'run-aaaaaaaa');
    const b = branchNameFor('moag/', 'Nightly', 'run-bbbbbbbb');
    assert.notStrictEqual(a, b);
  });
});

describe('git-delivery — prepareBranch guards', () => {
  it('refuses when the folder is not a git work tree', async () => {
    const { git } = stubGit({ 'rev-parse --is-inside-work-tree': null });
    const out = await prepareBranch('/x', 'p', 'r', CFG, git);
    assert.strictEqual(out.ok, false);
    assert.strictEqual((out as { reason: PrepareFailure }).reason, 'not-a-repo');
  });

  it('refuses on a dirty tree and never runs checkout', async () => {
    const { git, calls } = stubGit({ ...CLEAN, 'status --porcelain': ' M src/app.ts' });
    const out = await prepareBranch('/x', 'p', 'r', CFG, git);
    assert.strictEqual(out.ok, false);
    assert.strictEqual((out as { reason: PrepareFailure }).reason, 'dirty-tree');
    assert.ok(!calls.some((c) => c[0] === 'checkout'), 'must not touch the tree when dirty');
  });

  it('refuses on a detached HEAD so commits are not stranded', async () => {
    const { git } = stubGit({ ...CLEAN, 'symbolic-ref --quiet': '' });
    const out = await prepareBranch('/x', 'p', 'r', CFG, git);
    assert.strictEqual((out as { reason: PrepareFailure }).reason, 'detached-head');
  });

  it('creates the branch when it does not exist', async () => {
    const { git, calls } = stubGit(CLEAN);
    const out = await prepareBranch('/x', 'Nightly', 'run-1', CFG, git);
    assert.strictEqual(out.ok, true);
    assert.strictEqual((out as { created: boolean }).created, true);
    assert.ok(calls.some((c) => c[0] === 'checkout' && c[1] === '-b'));
  });

  it('reuses an existing branch on a resumed run rather than failing', async () => {
    const { git, calls } = stubGit({ ...CLEAN, 'rev-parse --verify': 'abc123' });
    const out = await prepareBranch('/x', 'Nightly', 'run-1', CFG, git);
    assert.strictEqual(out.ok, true);
    assert.strictEqual((out as { created: boolean }).created, false);
    assert.ok(!calls.some((c) => c[0] === 'checkout' && c[1] === '-b'));
  });

  it('never pushes', async () => {
    const { git, calls } = stubGit(CLEAN);
    await prepareBranch('/x', 'p', 'r', CFG, git);
    assert.ok(!calls.some((c) => c[0] === 'push'), 'delivery must never push');
  });
});

describe('git-delivery — commitTask', () => {
  const req = {
    cwd: '/x',
    taskName: 'Add login route',
    playlistName: 'Auth',
    engine: 'claude',
    changedFiles: ['src/auth.ts'],
  };

  it('commits when there are staged changes', async () => {
    const { git, calls } = stubGit({
      add: '',
      'diff --cached': 'src/auth.ts',
      commit: '[moag abc] Add login route',
      'rev-parse --short': 'abc1234',
    });
    const out = await commitTask(req, git);
    assert.strictEqual(out.committed, true);
    assert.strictEqual((out as { sha: string }).sha, 'abc1234');
    assert.ok(calls.some((c) => c[0] === 'commit' && c[1] === '-m'));
  });

  it('treats a no-op task as nothing-to-commit, not a failure', async () => {
    const { git, calls } = stubGit({ add: '', 'diff --cached': '' });
    const out = await commitTask(req, git);
    assert.strictEqual(out.committed, false);
    assert.strictEqual((out as { reason: string }).reason, 'nothing-to-commit');
    assert.ok(!calls.some((c) => c[0] === 'commit'), 'must not create an empty commit');
  });

  it('reports commit-failed when git commit fails', async () => {
    const { git } = stubGit({ add: '', 'diff --cached': 'a.ts', commit: null });
    const out = await commitTask(req, git);
    assert.strictEqual((out as { reason: string }).reason, 'commit-failed');
  });

  it('passes the message as one argument so a task name cannot reach a shell', async () => {
    const { git, calls } = stubGit({
      add: '', 'diff --cached': 'a.ts', commit: 'ok', 'rev-parse --short': 'aaa',
    });
    await commitTask({ ...req, taskName: 'fix"; rm -rf /' }, git);
    const commit = calls.find((c) => c[0] === 'commit')!;
    assert.strictEqual(commit.length, 3);
    assert.ok(commit[2].startsWith('fix"; rm -rf /'));
  });
});

describe('git-delivery — commit message', () => {
  it('carries playlist, engine and files', () => {
    const msg = buildCommitMessage({
      cwd: '/x', taskName: 'Add route', playlistName: 'Auth', engine: 'claude',
      changedFiles: ['a.ts', 'b.ts'], costUsd: 0.1234,
    });
    const [subject] = msg.split('\n');
    assert.strictEqual(subject, 'Add route');
    assert.ok(msg.includes('Playlist: Auth'));
    assert.ok(msg.includes('Engine: claude'));
    assert.ok(msg.includes('Cost: $0.1234'));
    assert.ok(msg.includes('  a.ts'));
  });

  it('keeps the subject on one line and within git conventions', () => {
    const msg = buildCommitMessage({
      cwd: '/x', taskName: 'A '.repeat(200), playlistName: 'p', engine: 'e', changedFiles: [],
    });
    const subject = msg.split('\n')[0];
    assert.ok(subject.length <= 68, `subject too long: ${subject.length}`);
    assert.strictEqual(msg.split('\n')[1], '', 'blank line must follow the subject');
  });

  it('truncates a huge file list instead of writing thousands of lines', () => {
    const files = Array.from({ length: 500 }, (_, i) => `f${i}.ts`);
    const msg = buildCommitMessage({
      cwd: '/x', taskName: 't', playlistName: 'p', engine: 'e', changedFiles: files,
    });
    assert.ok(msg.includes('...and 460 more'));
  });

  it('omits cost when there is none rather than printing $0', () => {
    const msg = buildCommitMessage({
      cwd: '/x', taskName: 't', playlistName: 'p', engine: 'e', changedFiles: [], costUsd: 0,
    });
    assert.ok(!msg.includes('Cost:'));
  });
});

describe('git-delivery — reporting', () => {
  it('gives every prepare failure its own distinct explanation', () => {
    const seen = new Set<string>();
    for (const r of ['not-a-repo', 'dirty-tree', 'detached-head', 'branch-failed'] as const) {
      const text = describePrepareFailure(r);
      assert.ok(text.length > 0);
      assert.ok(!seen.has(text), `${r} reuses another reason's text`);
      seen.add(text);
    }
  });
});
