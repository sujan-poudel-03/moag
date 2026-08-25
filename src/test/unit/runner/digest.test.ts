import * as assert from 'assert';
import {
  buildDigest,
  collectCommits,
  parseCommitBody,
  renderDigest,
  DigestCommit,
  GitRunner,
} from '../../../runner/digest';
import { ParkedItem, ParkReason } from '../../../runner/park-queue';

const SEP = String.fromCharCode(31);
const REC = String.fromCharCode(30);

const parked = (reason: ParkReason, over: Partial<ParkedItem> = {}): ParkedItem => ({
  id: reason,
  parkedAt: '2026-08-25T01:00:00.000Z',
  reason,
  planName: 'Nightly',
  playlistName: 'Backend',
  taskId: 't',
  taskName: `task for ${reason}`,
  decision: `decide about ${reason}`,
  ...over,
});

const commit = (over: Partial<DigestCommit> = {}): DigestCommit => ({
  sha: 'abc12345',
  subject: 'Add login route',
  at: '2026-08-25T02:00:00.000Z',
  branch: 'moag/nightly-run1',
  costUsd: 0.5,
  ...over,
});

describe('digest — ordering is the product', () => {
  it('puts what needs a decision before everything else', () => {
    const d = buildDigest(
      [parked('gate-failure'), parked('manual-gate'), parked('repeated-failure')],
      [],
    );
    assert.deepStrictEqual(d.needsDecision.map((i) => i.reason),
      ['manual-gate', 'repeated-failure', 'gate-failure']);
  });

  it('ranks an approval above a diagnosis, because it unblocks more for less', () => {
    const d = buildDigest([parked('repeated-failure'), parked('manual-gate')], []);
    assert.strictEqual(d.needsDecision[0].reason, 'manual-gate');
  });

  it('breaks ties by recency', () => {
    const d = buildDigest([
      parked('manual-gate', { id: 'older', parkedAt: '2026-08-01T00:00:00.000Z' }),
      parked('manual-gate', { id: 'newer', parkedAt: '2026-08-25T00:00:00.000Z' }),
    ], []);
    assert.deepStrictEqual(d.needsDecision.map((i) => i.id), ['newer', 'older']);
  });

  it('omits work a human has already cleared', () => {
    const d = buildDigest([parked('manual-gate', { resolvedAt: '2026-08-25T09:00:00.000Z' })], []);
    assert.strictEqual(d.needsDecision.length, 0);
  });
});

describe('digest — cost comes back out of the commits', () => {
  it('reads the trailers git-delivery writes', () => {
    const parsed = parseCommitBody('Playlist: Auth\nEngine: claude\nCost: $0.1234\n\nFiles:\n  a.ts');
    assert.strictEqual(parsed.playlist, 'Auth');
    assert.strictEqual(parsed.engine, 'claude');
    assert.strictEqual(parsed.costUsd, 0.1234);
  });

  it('leaves cost undefined rather than guessing zero when absent', () => {
    assert.strictEqual(parseCommitBody('Playlist: Auth').costUsd, undefined);
  });

  it('ignores a malformed cost instead of producing NaN', () => {
    assert.strictEqual(parseCommitBody('Cost: $not-a-number').costUsd, undefined);
    const d = buildDigest([], [commit({ costUsd: undefined })]);
    assert.strictEqual(d.totalCostUsd, 0);
    assert.ok(!Number.isNaN(d.totalCostUsd));
  });

  it('totals spend across every commit', () => {
    const d = buildDigest([], [commit({ costUsd: 0.25 }), commit({ sha: 'b', costUsd: 0.75 })]);
    assert.strictEqual(d.totalCostUsd, 1);
  });
});

describe('digest — collecting commits', () => {
  const log = (rows: string[][]) => rows.map((r) => r.join(SEP)).join(REC) + REC;

  it('only looks at branches MOAG owns', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'branch') { return 'moag/a\n'; }
      return log([['sha1', 'Did a thing', '2026-08-25T01:00:00Z', 'Cost: $0.10']]);
    };
    await collectCommits('/r', 'moag/', undefined, git);
    const branchCall = calls.find((c) => c[0] === 'branch')!;
    assert.ok(branchCall.includes('moag/*'), 'must scope to the MOAG namespace');
  });

  it('reports a commit reachable from two branches only once', async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === 'branch') { return 'moag/a\nmoag/b\n'; }
      return log([['shared', 'Shared commit', '2026-08-25T01:00:00Z', '']]);
    };
    const commits = await collectCommits('/r', 'moag/', undefined, git);
    assert.strictEqual(commits.length, 1);
  });

  it('excludes history the run merely branched off, not just other namespaces', async () => {
    // Found by running this for real: a MOAG branch contains all the history
    // behind it, so scoping to the namespace alone reported the human's own
    // commits as agent output.
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return args[0] === 'branch' ? 'moag/a\n' : '';
    };
    await collectCommits('/r', 'moag/', undefined, git);
    const logCall = calls.find((c) => c[0] === 'log')!;
    assert.ok(logCall.includes('--not'), 'must exclude pre-existing history');
    assert.ok(logCall.includes('--exclude=moag/*'), 'must keep MOAG branches on the include side');
    assert.ok(logCall.includes('--branches'), 'must compare against the other branches');
  });

  it('returns nothing when git is unavailable rather than throwing', async () => {
    assert.deepStrictEqual(await collectCommits('/r', 'moag/', undefined, async () => null), []);
  });

  it('passes --since through when a window is given', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return args[0] === 'branch' ? 'moag/a\n' : '';
    };
    await collectCommits('/r', 'moag/', '2026-08-24', git);
    assert.ok(calls.some((c) => c.includes('--since=2026-08-24')));
  });

  it('survives a subject containing the characters it splits on', async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === 'branch') { return 'moag/a\n'; }
      return log([['sha1', 'Fix: a | b, c', '2026-08-25T01:00:00Z', 'Engine: codex']]);
    };
    const [c] = await collectCommits('/r', 'moag/', undefined, git);
    assert.strictEqual(c.subject, 'Fix: a | b, c');
    assert.strictEqual(c.engine, 'codex');
  });
});

describe('digest — rendering', () => {
  it('says plainly when nothing is waiting', () => {
    assert.ok(renderDigest(buildDigest([], [])).includes('Nothing is waiting on you.'));
  });

  it('leads with the decision, not the commit log', () => {
    const text = renderDigest(buildDigest([parked('manual-gate')], [commit()]));
    assert.ok(text.indexOf('need a decision') < text.indexOf('Shipped'));
  });

  it('shows each item id so it can be resolved', () => {
    const text = renderDigest(buildDigest([parked('manual-gate', { id: 'xyz' })], []));
    assert.ok(text.includes('[xyz]'));
    assert.ok(text.includes('decide about manual-gate'));
  });

  it('flags unknown cost rather than implying the night was free', () => {
    const text = renderDigest(buildDigest([], [commit({ costUsd: undefined })]));
    assert.ok(text.includes('no cost recorded'));
  });

  it('does not claim missing cost when nothing shipped at all', () => {
    assert.ok(!renderDigest(buildDigest([], [])).includes('no cost recorded'));
  });
});
