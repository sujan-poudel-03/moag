import * as assert from 'assert';
import * as os from 'os';
import {
  createWorktrees,
  describeIsolationFailure,
  isolationRequired,
  removeWorktrees,
  worktreeBranchFor,
  worktreePathFor,
  GitRunner,
  IsolationFailure,
} from '../../../runner/worktree';

function stubGit(routes: Record<string, string | null>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const k2 = args.slice(0, 2).join(' ');
    if (k2 in routes) { return routes[k2]; }
    if (args[0] in routes) { return routes[args[0]]; }
    return '';
  };
  return { git, calls };
}

const OK = {
  'rev-parse --is-inside-work-tree': 'true',
  'worktree list': '/repo  abc [main]',
  'worktree add': '',
  'worktree remove': '',
  'worktree prune': '',
};

const PLAYLISTS = [{ id: 'p1', name: 'Backend' }, { id: 'p2', name: 'Frontend' }];

describe('worktree — placement', () => {
  it('places checkouts outside the repository so they cannot dirty it', () => {
    const p = worktreePathFor('/home/me/myrepo', 'Backend', 'run-abcdef12');
    assert.ok(p.startsWith(os.tmpdir()), `must live under tmp, got ${p}`);
    assert.ok(!p.includes('myrepo/.moag'), 'must not live inside the repo');
  });

  it('gives two playlists of one run distinct paths and branches', () => {
    const a = worktreePathFor('/r', 'Backend', 'run-1');
    const b = worktreePathFor('/r', 'Frontend', 'run-1');
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(worktreeBranchFor('moag/', 'Backend', 'run-1'), worktreeBranchFor('moag/', 'Frontend', 'run-1'));
  });

  it('produces git-ref-safe branch names', () => {
    const b = worktreeBranchFor('moag/', 'Front End: v2!!', 'run-abcdef12');
    assert.ok(/^moag\/[a-z0-9-]+$/.test(b), `unsafe ref: ${b}`);
  });
});

describe('worktree — when isolation is needed', () => {
  it('is only required for concurrency above one across multiple playlists', () => {
    assert.strictEqual(isolationRequired(1, 5), false);
    assert.strictEqual(isolationRequired(4, 1), false);
    assert.strictEqual(isolationRequired(2, 2), true);
  });
});

describe('worktree — createWorktrees', () => {
  it('creates one checkout per playlist', async () => {
    const { git, calls } = stubGit(OK);
    const out = await createWorktrees('/repo', PLAYLISTS, 'run-1', 'moag/', git);
    assert.strictEqual(out.ok, true);
    assert.strictEqual((out as { worktrees: unknown[] }).worktrees.length, 2);
    assert.strictEqual(calls.filter((c) => c[0] === 'worktree' && c[1] === 'add').length, 2);
  });

  it('refuses outside a git repository', async () => {
    const { git } = stubGit({ ...OK, 'rev-parse --is-inside-work-tree': null });
    const out = await createWorktrees('/repo', PLAYLISTS, 'r', 'moag/', git);
    assert.strictEqual((out as { reason: IsolationFailure }).reason, 'not-a-repo');
  });

  it('refuses when git has no worktree support', async () => {
    const { git } = stubGit({ ...OK, 'worktree list': null });
    const out = await createWorktrees('/repo', PLAYLISTS, 'r', 'moag/', git);
    assert.strictEqual((out as { reason: IsolationFailure }).reason, 'unsupported');
  });

  it('rolls back the checkouts it already made rather than isolating partially', async () => {
    let adds = 0;
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') { return 'true'; }
      if (args[1] === 'list') { return ''; }
      if (args[1] === 'add') { adds++; return adds === 1 ? '' : null; }
      return '';
    };
    const out = await createWorktrees('/repo', PLAYLISTS, 'r', 'moag/', git);
    assert.strictEqual((out as { reason: IsolationFailure }).reason, 'create-failed');
    assert.strictEqual(
      calls.filter((c) => c[1] === 'remove').length, 1,
      'the successfully created worktree must be cleaned up',
    );
  });
});

describe('worktree — teardown never destroys uncommitted work', () => {
  it('removes without --force so git can refuse a dirty checkout', async () => {
    const { git, calls } = stubGit(OK);
    await removeWorktrees('/repo', [{ path: '/tmp/a', branch: 'b', playlistId: 'p' }], git);
    const remove = calls.find((c) => c[1] === 'remove')!;
    assert.ok(!remove.includes('--force'), '--force would silently delete uncommitted agent work');
  });

  it('reports the checkouts git refused to remove', async () => {
    const { git } = stubGit({ ...OK, 'worktree remove': null });
    const kept = await removeWorktrees('/repo', [
      { path: '/tmp/a', branch: 'b1', playlistId: 'p1' },
      { path: '/tmp/b', branch: 'b2', playlistId: 'p2' },
    ], git);
    assert.deepStrictEqual(kept, ['/tmp/a', '/tmp/b']);
  });

  it('prunes stale records and never deletes a branch', async () => {
    const { git, calls } = stubGit(OK);
    await removeWorktrees('/repo', [{ path: '/tmp/a', branch: 'b', playlistId: 'p' }], git);
    assert.ok(calls.some((c) => c[1] === 'prune'));
    assert.ok(!calls.some((c) => c[0] === 'branch' && c.includes('-D')), 'branches hold the commits');
  });
});

describe('worktree — reporting', () => {
  it('gives every isolation failure its own distinct explanation', () => {
    const seen = new Set<string>();
    for (const r of ['not-a-repo', 'unsupported', 'create-failed', 'delivery-off'] as const) {
      const text = describeIsolationFailure(r);
      assert.ok(text.length > 0);
      assert.ok(!seen.has(text), `${r} reuses another reason's text`);
      seen.add(text);
    }
  });

  it('every failure explains that the run falls back rather than stops', () => {
    for (const r of ['not-a-repo', 'unsupported', 'create-failed', 'delivery-off'] as const) {
      assert.ok(
        /one at a time/.test(describeIsolationFailure(r)),
        `${r} must say the run continues sequentially`,
      );
    }
  });
});
