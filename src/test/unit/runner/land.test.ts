import * as assert from 'assert';
import {
  assessAll,
  assessBranch,
  findRunBranches,
  landBranch,
  renderLandReport,
  resolveBase,
  GitRunner,
  LandReport,
} from '../../../runner/land';

const NL = String.fromCharCode(10);

/** A scriptable git. Keys are the first two argv words; value is [ok, stdout]. */
function stubGit(routes: Record<string, [boolean, string]>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const k2 = args.slice(0, 2).join(' ');
    if (k2 in routes) { return { ok: routes[k2][0], stdout: routes[k2][1] }; }
    if (args[0] in routes) { return { ok: routes[args[0]][0], stdout: routes[args[0]][1] }; }
    return { ok: true, stdout: '' };
  };
  return { git, calls };
}

describe('land — choosing what to land into', () => {
  it('uses an explicit --into without asking git', async () => {
    const { git, calls } = stubGit({});
    assert.strictEqual(await resolveBase('/r', 'develop', 'moag/', git), 'develop');
    assert.strictEqual(calls.length, 0, 'an explicit base needs no lookup');
  });

  it('uses the current branch when it is not one of ours', async () => {
    const { git } = stubGit({ 'rev-parse --abbrev-ref': [true, 'develop' + NL] });
    assert.strictEqual(await resolveBase('/r', undefined, 'moag/', git), 'develop');
  });

  it('never lands a MOAG branch into itself', async () => {
    // Standing on moag/x, the thing to land INTO is the trunk, not moag/x.
    const { git } = stubGit({
      'rev-parse --abbrev-ref': [true, 'moag/backend-run1' + NL],
      'rev-parse --verify': [true, 'abc123' + NL],
    });
    const base = await resolveBase('/r', undefined, 'moag/', git);
    assert.strictEqual(base, 'main');
  });

  it('returns null rather than guessing when there is no obvious base', async () => {
    const { git } = stubGit({
      'rev-parse --abbrev-ref': [true, 'HEAD' + NL],
      'rev-parse --verify': [false, ''],
    });
    assert.strictEqual(await resolveBase('/r', undefined, 'moag/', git), null);
  });
});

describe('land — finding branches', () => {
  it('looks only in the MOAG namespace', async () => {
    const { git, calls } = stubGit({ branch: [true, 'moag/a' + NL + 'moag/b' + NL] });
    const found = await findRunBranches('/r', 'moag/', git);
    assert.deepStrictEqual(found, ['moag/a', 'moag/b']);
    assert.ok(calls[0].includes('moag/*'), 'must scope to the namespace');
  });

  it('normalises a prefix given without a trailing slash', async () => {
    const { git, calls } = stubGit({ branch: [true, ''] });
    await findRunBranches('/r', 'moag', git);
    assert.ok(calls[0].includes('moag/*'));
  });

  it('returns nothing when git is unavailable rather than throwing', async () => {
    const { git } = stubGit({ branch: [false, ''] });
    assert.deepStrictEqual(await findRunBranches('/r', 'moag/', git), []);
  });
});

describe('land — assessing without touching the tree', () => {
  const CLEAN = {
    'rev-list --count': [true, '2' + NL] as [boolean, string],
    'diff --name-only': [true, 'a.ts' + NL + 'b.ts' + NL] as [boolean, string],
    'merge-tree --write-tree': [true, 'abc' + NL] as [boolean, string],
  };

  it('reports a branch that merges cleanly', async () => {
    const { git } = stubGit(CLEAN);
    const a = await assessBranch('/r', 'moag/x', 'main', git);
    assert.strictEqual(a.clean, true);
    assert.strictEqual(a.commits, 2);
    assert.deepStrictEqual(a.changedFiles, ['a.ts', 'b.ts']);
  });

  it('never checks out or merges while assessing', async () => {
    // Assessment runs unattended; leaving a half-merged tree would be unrecoverable.
    const { git, calls } = stubGit(CLEAN);
    await assessBranch('/r', 'moag/x', 'main', git);
    assert.ok(!calls.some((c) => c[0] === 'checkout'), 'assessment must not check out');
    assert.ok(!calls.some((c) => c[0] === 'merge'), 'assessment must not merge');
  });

  it('reads conflicted paths off the FAILING merge-tree, not a second call', async () => {
    // merge-tree exits non-zero and names the paths on stdout; discarding stdout
    // on failure would throw away the only useful part.
    const { git } = stubGit({
      ...CLEAN,
      'merge-tree --write-tree': [false, ['abc123', 'src/app.ts', 'src/other.ts'].join(NL)],
    });
    const a = await assessBranch('/r', 'moag/x', 'main', git);
    assert.strictEqual(a.clean, false);
    assert.deepStrictEqual(a.conflicts, ['src/app.ts', 'src/other.ts']);
  });

  it('stops at the blank line, so git commentary is not reported as filenames', async () => {
    const stdout = [
      'abc123', 'shared.txt', '',
      'Auto-merging shared.txt',
      'CONFLICT (content): Merge conflict in shared.txt',
    ].join(NL);
    const { git } = stubGit({ ...CLEAN, 'merge-tree --write-tree': [false, stdout] });
    const a = await assessBranch('/r', 'moag/x', 'main', git);
    assert.deepStrictEqual(a.conflicts, ['shared.txt']);
  });

  it('treats a branch with no new commits as already landed', async () => {
    const { git } = stubGit({ ...CLEAN, 'rev-list --count': [true, '0' + NL] });
    const a = await assessBranch('/r', 'moag/x', 'main', git);
    assert.strictEqual(a.commits, 0);
  });

  it('sorts branches into ready, blocked and already landed', async () => {
    let call = 0;
    const git: GitRunner = async (args) => {
      if (args[0] === 'branch') { return { ok: true, stdout: ['moag/a', 'moag/b', 'moag/c'].join(NL) }; }
      if (args[0] === 'rev-list') { return { ok: true, stdout: args[2].startsWith('main..moag/c') ? '0' : '1' }; }
      if (args[0] === 'diff') { return { ok: true, stdout: 'f.ts' }; }
      if (args[0] === 'merge-tree') {
        call++;
        // Second assessed branch conflicts.
        return call === 2 ? { ok: false, stdout: 'oid' + NL + 'x.ts' } : { ok: true, stdout: 'oid' };
      }
      return { ok: true, stdout: '' };
    };
    const r = await assessAll('/r', 'moag/', 'main', git);
    assert.deepStrictEqual(r.ready.map((b) => b.branch), ['moag/a']);
    assert.deepStrictEqual(r.blocked.map((b) => b.branch), ['moag/b']);
    assert.deepStrictEqual(r.alreadyLanded, ['moag/c']);
  });
});

describe('land — merging', () => {
  const OK = {
    'status --porcelain': [true, ''] as [boolean, string],
    checkout: [true, ''] as [boolean, string],
    merge: [true, 'Merge made'] as [boolean, string],
  };

  it('merges with --no-ff so a run stays identifiable as a unit', async () => {
    const { git, calls } = stubGit(OK);
    const out = await landBranch('/r', 'moag/x', 'main', git);
    assert.strictEqual(out.merged, true);
    const merge = calls.find((c) => c[0] === 'merge')!;
    assert.ok(merge.includes('--no-ff'));
  });

  it('refuses on a dirty tree and never checks out', async () => {
    const { git, calls } = stubGit({ ...OK, 'status --porcelain': [true, ' M src/app.ts'] });
    const out = await landBranch('/r', 'moag/x', 'main', git);
    assert.strictEqual(out.merged, false);
    assert.ok(!calls.some((c) => c[0] === 'checkout'), 'must not touch a dirty tree');
  });

  it('aborts rather than leaving a half-merged tree behind', async () => {
    const { git, calls } = stubGit({ ...OK, merge: [false, 'CONFLICT'] });
    const out = await landBranch('/r', 'moag/x', 'main', git);
    assert.strictEqual(out.merged, false);
    assert.strictEqual((out as { reason: string }).reason, 'conflict');
    assert.ok(calls.some((c) => c[0] === 'merge' && c[1] === '--abort'),
      'a failed merge must be aborted, not left for the next run to trip over');
  });

  it('never forces and never rewrites history', async () => {
    const { git, calls } = stubGit(OK);
    await landBranch('/r', 'moag/x', 'main', git);
    const flat = calls.flat();
    for (const forbidden of ['--force', '-f', 'rebase', 'reset', 'push']) {
      assert.ok(!flat.includes(forbidden), `landing must never run ${forbidden}`);
    }
  });
});

describe('land — reporting', () => {
  const report = (over: Partial<LandReport> = {}): LandReport =>
    ({ base: 'main', ready: [], blocked: [], alreadyLanded: [], ...over });

  const branch = (name: string, conflicts: string[] = []) => ({
    branch: name, commits: 1, changedFiles: ['a.ts'], clean: conflicts.length === 0, conflicts,
  });

  it('says plainly when there is nothing to do', () => {
    assert.ok(renderLandReport(report()).includes('Nothing to land.'));
  });

  it('names the conflicting paths, not just the branch', () => {
    const text = renderLandReport(report({ blocked: [branch('moag/x', ['src/app.ts'])] }));
    assert.ok(text.includes('moag/x'));
    assert.ok(text.includes('src/app.ts'), 'a branch name alone does not tell anyone what to fix');
  });

  it('truncates a huge conflict list rather than filling the screen', () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const text = renderLandReport(report({ blocked: [branch('moag/x', many)] }));
    assert.ok(text.includes('...and 32 more'));
  });

  it('separates what lands cleanly from what needs a person', () => {
    const text = renderLandReport(report({
      ready: [branch('moag/ok')],
      blocked: [branch('moag/bad', ['x.ts'])],
    }));
    assert.ok(text.indexOf('land cleanly') < text.indexOf('need a person'));
  });
});
