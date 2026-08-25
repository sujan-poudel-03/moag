import * as assert from 'assert';
import * as path from 'path';
import {
  decisionFor,
  describeParkReason,
  openItems,
  park,
  queuePath,
  readQueue,
  resolveItem,
  FsLike,
  ParkedItem,
  ParkReason,
} from '../../../runner/park-queue';

/** In-memory filesystem so the queue can be exercised without touching disk. */
function memFs(seed: Record<string, string> = {}): FsLike & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  const dirs = new Set<string>();
  return {
    files,
    existsSync: (p) => p in files || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    appendFileSync: (p, d) => { files[p] = (files[p] ?? '') + d; },
    readFileSync: (p) => {
      if (!(p in files)) { throw new Error('ENOENT'); }
      return files[p];
    },
    writeFileSync: (p, d) => { files[p] = d; },
  };
}

const item = (over: Partial<ParkedItem> = {}): ParkedItem => ({
  id: 'i1',
  parkedAt: '2026-08-25T01:00:00.000Z',
  reason: 'manual-gate',
  planName: 'Nightly',
  playlistName: 'Backend',
  taskId: 't1',
  taskName: 'Ship the API',
  decision: 'Review and approve.',
  ...over,
});

describe('park-queue — location', () => {
  it('lives in .moag so it travels with the workspace', () => {
    assert.strictEqual(queuePath('/repo'), path.join('/repo', '.moag', 'queue.jsonl'));
  });
});

describe('park-queue — writing', () => {
  it('appends one JSON line per park and never rewrites earlier ones', () => {
    const fs = memFs();
    park('/repo', item({ id: 'a' }), fs);
    park('/repo', item({ id: 'b' }), fs);
    const raw = fs.files[queuePath('/repo')];
    assert.strictEqual(raw.trim().split('\n').length, 2);
    assert.ok(raw.indexOf('"a"') < raw.indexOf('"b"'), 'append order must be preserved');
  });

  it('creates .moag when it does not exist yet', () => {
    const fs = memFs();
    assert.strictEqual(park('/fresh', item(), fs), true);
    assert.strictEqual(readQueue('/fresh', fs).length, 1);
  });

  it('returns false instead of throwing when the queue cannot be written', () => {
    const fs = memFs();
    fs.appendFileSync = () => { throw new Error('EACCES'); };
    assert.strictEqual(park('/repo', item(), fs), false);
  });

  it('caps evidence so one task cannot bloat the file', () => {
    const fs = memFs();
    park('/repo', item({
      evidence: {
        lastError: 'x'.repeat(5000),
        changedFiles: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
      },
    }), fs);
    const [read] = readQueue('/repo', fs);
    assert.ok((read.evidence!.lastError ?? '').length <= 800);
    assert.ok((read.evidence!.changedFiles ?? []).length <= 50);
  });
});

describe('park-queue — reading', () => {
  it('returns nothing when no run has ever parked', () => {
    assert.deepStrictEqual(readQueue('/repo', memFs()), []);
  });

  it('skips a torn last line rather than losing the whole file', () => {
    const fs = memFs({
      [queuePath('/repo')]: JSON.stringify(item({ id: 'good' })) + '\n{"id":"tor',
    });
    const all = readQueue('/repo', fs);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].id, 'good');
  });

  it('lists only unresolved items, newest first', () => {
    const fs = memFs();
    park('/repo', item({ id: 'old', parkedAt: '2026-08-01T00:00:00.000Z' }), fs);
    park('/repo', item({ id: 'new', parkedAt: '2026-08-25T00:00:00.000Z' }), fs);
    park('/repo', item({ id: 'done', parkedAt: '2026-08-24T00:00:00.000Z', resolvedAt: '2026-08-24T09:00:00.000Z' }), fs);
    assert.deepStrictEqual(openItems('/repo', fs).map((i) => i.id), ['new', 'old']);
  });
});

describe('park-queue — resolving', () => {
  it('marks an item resolved and drops it from the open list', () => {
    const fs = memFs();
    park('/repo', item({ id: 'a' }), fs);
    assert.strictEqual(resolveItem('/repo', 'a', '2026-08-25T09:00:00.000Z', fs), true);
    assert.deepStrictEqual(openItems('/repo', fs), []);
  });

  it('keeps the resolved item in the file as a record', () => {
    const fs = memFs();
    park('/repo', item({ id: 'a' }), fs);
    resolveItem('/repo', 'a', '2026-08-25T09:00:00.000Z', fs);
    const all = readQueue('/repo', fs);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].resolvedAt, '2026-08-25T09:00:00.000Z');
  });

  it('reports false for an unknown or already-resolved id', () => {
    const fs = memFs();
    park('/repo', item({ id: 'a' }), fs);
    assert.strictEqual(resolveItem('/repo', 'nope', 'now', fs), false);
    resolveItem('/repo', 'a', 'now', fs);
    assert.strictEqual(resolveItem('/repo', 'a', 'now', fs), false, 'must not resolve twice');
  });
});

describe('park-queue — what the operator is asked', () => {
  const ALL: ParkReason[] = [
    'manual-gate', 'budget-exceeded', 'repeated-failure', 'missing-capability', 'gate-failure',
  ];

  it('gives every reason a distinct label and a distinct decision', () => {
    const labels = new Set<string>();
    const decisions = new Set<string>();
    for (const r of ALL) {
      const label = describeParkReason(r);
      const decision = decisionFor(r);
      assert.ok(label.length > 0 && decision.length > 0, `${r} is missing text`);
      assert.ok(!labels.has(label), `${r} reuses a label`);
      assert.ok(!decisions.has(decision), `${r} reuses a decision`);
      labels.add(label);
      decisions.add(decision);
    }
  });

  it('folds evidence into the decision when it is available', () => {
    assert.ok(decisionFor('budget-exceeded', { budgetUsd: 25 }).includes('$25'));
    assert.ok(decisionFor('gate-failure', { gate: 'npm test' }).includes('npm test'));
    assert.ok(decisionFor('repeated-failure', { attempts: 4 }).includes('4'));
  });

  it('still reads sensibly with no evidence at all', () => {
    for (const r of ALL) {
      assert.ok(!decisionFor(r).includes('undefined'), `${r} leaks undefined`);
    }
  });
});
