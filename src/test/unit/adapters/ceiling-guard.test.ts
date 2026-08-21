// ─── Cost ceiling guard ───
// The guard is consulted before every accounted engine call. A blocked call
// must return a synthetic failure (never throw), must not invoke the engine,
// and must not record any spend. A broken guard must fail open.

import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { withCostAccounting, setCeilingGuard, EngineAdapter, EngineRunOptions } from '../../../adapters/engine';
import { EngineId, EngineResult } from '../../../models/types';
import { costLedger } from '../../../utils/cost-ledger';

const USAGE = { inputTokens: 10, outputTokens: 5, estimatedCost: 0.25 };

function makeAdapter(
  id: EngineId,
  runTask: (o: EngineRunOptions) => Promise<EngineResult>
): EngineAdapter {
  return { id, displayName: 'Guarded ' + id, getCommand: () => id, runTask };
}

describe('cost ceiling guard', () => {
  const unsubs: Array<() => void> = [];

  // The ledger is a module singleton shared by the whole suite.
  beforeEach(() => {
    costLedger.reset();
  });

  afterEach(() => {
    setCeilingGuard(null);
    while (unsubs.length > 0) {
      unsubs.pop()!();
    }
    costLedger.reset();
    sinon.restore();
  });

  function collect(): Array<{ label: string }> {
    const seen: Array<{ label: string }> = [];
    unsubs.push(costLedger.onRecord((e) => seen.push({ label: e.label })));
    return seen;
  }

  it('an unset guard allows the call', async () => {
    const inner = sinon.stub().resolves({
      stdout: 'ran', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: USAGE,
    });
    const wrapped = withCostAccounting(makeAdapter('claude', inner));

    const result = await wrapped.runTask({ prompt: 'p', cwd: '.' });

    assert.equal(inner.callCount, 1);
    assert.equal(result.stdout, 'ran');
    assert.equal(costLedger.getLifetimeUsd(), 0.25);
  });

  it('a guard returning true is transparent', async () => {
    const guard = sinon.stub().returns(true);
    setCeilingGuard(guard);
    const inner = sinon.stub().resolves({
      stdout: 'ran', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: USAGE,
    });
    const wrapped = withCostAccounting(makeAdapter('codex', inner));

    const result = await wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'task' });

    assert.equal(guard.callCount, 1);
    assert.deepEqual(guard.firstCall.args[0], { engineId: 'codex', label: 'task' });
    assert.equal(inner.callCount, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(costLedger.getLifetimeUsd(), 0.25);
  });

  it('a guard returning false short-circuits without invoking the engine or recording', async () => {
    const seen = collect();
    setCeilingGuard(() => false);
    const inner = sinon.stub().resolves({
      stdout: 'must not run', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: USAGE,
    });
    const wrapped = withCostAccounting(makeAdapter('claude', inner));

    const result = await wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'prd-chat' });

    assert.equal(inner.callCount, 0, 'the engine is never invoked');
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.durationMs, 0);
    assert.match(result.stderr, /Cost ceiling reached/);
    assert.match(result.stderr, /agentTaskPlayer\.costBudgetUsd/);
    assert.equal(seen.length, 0, 'a blocked call records nothing');
    assert.equal(costLedger.getLifetimeUsd(), 0);
  });

  it('a blocked call resolves rather than throwing', async () => {
    setCeilingGuard(() => false);
    const wrapped = withCostAccounting(
      makeAdapter('gemini', async () => {
        throw new Error('should never reach the engine');
      })
    );

    await assert.doesNotReject(() => wrapped.runTask({ prompt: 'p', cwd: '.' }));
  });

  it('labels an unlabelled blocked call "unattributed" when consulting the guard', async () => {
    const guard = sinon.stub().returns(false);
    setCeilingGuard(guard);
    const wrapped = withCostAccounting(
      makeAdapter('ollama', async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }))
    );

    await wrapped.runTask({ prompt: 'p', cwd: '.' });

    assert.deepEqual(guard.firstCall.args[0], { engineId: 'ollama', label: 'unattributed' });
  });

  it('a throwing guard fails open — the call proceeds', async () => {
    setCeilingGuard(() => {
      throw new Error('broken guard');
    });
    const inner = sinon.stub().resolves({
      stdout: 'ran anyway', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: USAGE,
    });
    const wrapped = withCostAccounting(makeAdapter('claude', inner));

    const result = await wrapped.runTask({ prompt: 'p', cwd: '.' });

    assert.equal(inner.callCount, 1, 'a broken guard must not brick every engine call');
    assert.equal(result.stdout, 'ran anyway');
    assert.equal(costLedger.getLifetimeUsd(), 0.25);
  });

  it('setCeilingGuard(null) restores the allow-by-default behaviour', async () => {
    setCeilingGuard(() => false);
    const inner = sinon.stub().resolves({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 });
    const wrapped = withCostAccounting(makeAdapter('claude', inner));

    await wrapped.runTask({ prompt: 'p', cwd: '.' });
    assert.equal(inner.callCount, 0);

    setCeilingGuard(null);
    await wrapped.runTask({ prompt: 'p', cwd: '.' });
    assert.equal(inner.callCount, 1);
  });

  it('is consulted per call, so a latch flipped mid-session takes effect immediately', async () => {
    let blocked = false;
    setCeilingGuard(() => !blocked);
    const inner = sinon.stub().resolves({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: USAGE,
    });
    const wrapped = withCostAccounting(makeAdapter('claude', inner));

    await wrapped.runTask({ prompt: 'a', cwd: '.' });
    blocked = true;
    const second = await wrapped.runTask({ prompt: 'b', cwd: '.' });
    blocked = false;
    const third = await wrapped.runTask({ prompt: 'c', cwd: '.' });

    assert.equal(inner.callCount, 2, 'only the blocked call was skipped');
    assert.equal(second.exitCode, 1);
    assert.equal(third.exitCode, 0);
    assert.equal(costLedger.getLifetimeUsd(), 0.5, 'blocked calls cost nothing');
  });
});
