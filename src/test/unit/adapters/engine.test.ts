import { strict as assert } from 'assert';
import {
  registerEngine,
  getEngine,
  getAllEngines,
  checkEngineAvailability,
  withCostAccounting,
  setCeilingGuard,
  EngineAdapter,
  EngineRunOptions,
} from '../../../adapters/engine';
import { EngineId, EngineResult } from '../../../models/types';
import { costLedger } from '../../../utils/cost-ledger';

// Helper to create a stub adapter
function makeAdapter(id: EngineId, displayName: string): EngineAdapter {
  return {
    id,
    displayName,
    getCommand(): string { return id; },
    async runTask(_options: EngineRunOptions): Promise<EngineResult> {
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
    },
  };
}

describe('engine registry', () => {
  // Note: the registry is a module-level singleton, so adapters persist across tests.
  // We register unique test adapters to avoid collision with the built-in ones.

  // The ledger is also a module singleton shared by the whole suite — reset it
  // so records from other test files cannot leak into these assertions.
  beforeEach(() => {
    costLedger.reset();
  });

  it('should register and retrieve an adapter', () => {
    const adapter = makeAdapter('codex', 'Test Codex');
    registerEngine(adapter);
    const retrieved = getEngine('codex');
    assert.equal(retrieved.id, 'codex');
    assert.equal(retrieved.displayName, 'Test Codex');
  });

  it('should throw for an unregistered engine', () => {
    assert.throws(
      // Use a cast to test with an invalid id
      () => getEngine('nonexistent' as EngineId),
      /No engine adapter registered for "nonexistent"/,
    );
  });

  it('should return all registered engines', () => {
    registerEngine(makeAdapter('claude', 'Test Claude'));
    registerEngine(makeAdapter('gemini', 'Test Gemini'));
    const all = getAllEngines();
    assert.ok(all.length >= 2);
    const ids = all.map(a => a.id);
    assert.ok(ids.includes('claude'));
    assert.ok(ids.includes('gemini'));
  });

  it('should overwrite an adapter with the same id', () => {
    registerEngine(makeAdapter('ollama', 'Original'));
    registerEngine(makeAdapter('ollama', 'Replaced'));
    assert.equal(getEngine('ollama').displayName, 'Replaced');
  });
});

describe('withCostAccounting', () => {
  /** Adapter whose runTask body is fully controlled by the test. */
  function makeCostAdapter(
    id: EngineId,
    impl: (options: EngineRunOptions) => Promise<EngineResult>
  ): EngineAdapter {
    return {
      id,
      displayName: 'Cost ' + id,
      getCommand(): string { return id + '-cmd'; },
      runTask: impl,
    };
  }

  const usage = { inputTokens: 100, outputTokens: 50, estimatedCost: 0.5 };
  const unsubs: Array<() => void> = [];

  beforeEach(() => {
    costLedger.reset();
  });

  afterEach(() => {
    while (unsubs.length > 0) {
      unsubs.pop()!();
    }
    costLedger.reset();
  });

  /** Subscribe a recording listener that is torn down after the test. */
  function collect(): Array<{ engineId: string; label: string; estimatedCostUsd: number }> {
    const seen: Array<{ engineId: string; label: string; estimatedCostUsd: number }> = [];
    unsubs.push(
      costLedger.onRecord((e) =>
        seen.push({ engineId: e.engineId, label: e.label, estimatedCostUsd: e.estimatedCostUsd })
      )
    );
    return seen;
  }

  it('records exactly once and forwards the costLabel', async () => {
    const seen = collect();
    const wrapped = withCostAccounting(
      makeCostAdapter('claude', async () => ({
        stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5, tokenUsage: usage,
      }))
    );

    await wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'prd-chat' });

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { engineId: 'claude', label: 'prd-chat', estimatedCostUsd: 0.5 });
    assert.equal(costLedger.getLifetimeUsd(), 0.5);
  });

  it('defaults the label to "unattributed" when no costLabel is given', async () => {
    const seen = collect();
    const wrapped = withCostAccounting(
      makeCostAdapter('codex', async () => ({
        stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: usage,
      }))
    );

    await wrapped.runTask({ prompt: 'p', cwd: '.' });

    assert.equal(seen[0].label, 'unattributed');
  });

  it('records on a non-zero exit — a failed task still burned tokens', async () => {
    const seen = collect();
    const wrapped = withCostAccounting(
      makeCostAdapter('claude', async () => ({
        stdout: '', stderr: 'boom', exitCode: 1, durationMs: 9, tokenUsage: usage,
      }))
    );

    const result = await wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'task' });

    assert.equal(result.exitCode, 1, 'the result passes through unchanged');
    assert.equal(result.stderr, 'boom');
    assert.equal(seen.length, 1);
    assert.equal(costLedger.getLifetimeUsd(), 0.5);
  });

  /** Count unreported-call events for the rest of the test. */
  function collectUnreported(): Array<{ engineId: string; label: string }> {
    const seen: Array<{ engineId: string; label: string }> = [];
    unsubs.push(costLedger.onUnreported((e) => seen.push(e)));
    return seen;
  }

  it('records nothing when the result carries no tokenUsage, and reports the call as unreported once', async () => {
    const seen = collect();
    const unreported = collectUnreported();
    const wrapped = withCostAccounting(
      makeCostAdapter('gemini', async () => ({
        stdout: '', stderr: '', exitCode: 0, durationMs: 1,
      }))
    );

    await wrapped.runTask({ prompt: 'p', cwd: '.' });

    assert.equal(seen.length, 0);
    assert.equal(costLedger.getLifetimeUsd(), 0);
    assert.deepEqual(unreported, [{ engineId: 'gemini', label: 'unattributed' }]);
  });

  it('a malformed cost (NaN, negative) is unreported, not recorded', async () => {
    const seen = collect();
    const unreported = collectUnreported();
    for (const estimatedCost of [NaN, -1]) {
      const wrapped = withCostAccounting(makeCostAdapter('claude', async () => ({
        stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: { estimatedCost },
      })));
      await wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'task' });
    }
    assert.equal(seen.length, 0);
    assert.equal(unreported.length, 2);
  });

  it('a cost tagged unknown is unreported once and never recorded, even with a number attached', async () => {
    const seen = collect();
    const unreported = collectUnreported();
    const wrapped = withCostAccounting(makeCostAdapter('claude', async () => ({
      stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: { costSource: 'unknown' },
    })));
    await wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'task' });
    const odd = withCostAccounting(makeCostAdapter('codex', async () => ({
      stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: { estimatedCost: 3, costSource: 'unknown' },
    })));
    await odd.runTask({ prompt: 'p', cwd: '.', costLabel: 'task' });
    assert.equal(seen.length, 0);
    assert.deepEqual(unreported, [{ engineId: 'claude', label: 'task' }, { engineId: 'codex', label: 'task' }]);
    assert.equal(costLedger.getLifetimeUsd(), 0);
  });

  it('a reported cost is recorded once and never also reported as unreported', async () => {
    const unreported = collectUnreported();
    const sources: string[] = [];
    unsubs.push(costLedger.onRecord((e) => sources.push(e.costSource)));
    const wrapped = withCostAccounting(makeCostAdapter('claude', async () => ({
      stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: { estimatedCost: 0.2, costSource: 'reported' },
    })));
    await wrapped.runTask({ prompt: 'p', cwd: '.' });
    assert.deepEqual(sources, ['reported']);
    assert.equal(unreported.length, 0);
  });

  it('a ceiling-blocked call fires neither onRecord nor onUnreported', async () => {
    const seen = collect();
    const unreported = collectUnreported();
    let invoked = 0;
    setCeilingGuard(() => false);
    try {
      const wrapped = withCostAccounting(makeCostAdapter('claude', async () => { invoked++; return { stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: usage }; }));
      const r = await wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'task' });
      assert.equal(r.exitCode, 1);
    } finally { setCeilingGuard(null); }
    assert.equal(invoked, 0);
    assert.equal(seen.length, 0);
    assert.equal(unreported.length, 0);
  });

  it('records no cost, reports the call as unreported, and re-throws when the inner runTask rejects', async () => {
    const seen = collect();
    const unreported = collectUnreported();
    const wrapped = withCostAccounting(
      makeCostAdapter('claude', async () => {
        throw new Error('aborted');
      })
    );

    await assert.rejects(
      () => wrapped.runTask({ prompt: 'p', cwd: '.', costLabel: 'task' }),
      /aborted/
    );
    assert.equal(seen.length, 0, 'a rejection has no cost figure to record');
    assert.equal(costLedger.getLifetimeUsd(), 0);
    assert.deepEqual(unreported, [{ engineId: 'claude', label: 'task' }], 'but it is counted as an unreported call');
  });

  it('does not double-count when wrapped twice', async () => {
    const seen = collect();
    const inner = makeCostAdapter('claude', async () => ({
      stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: usage,
    }));
    const once = withCostAccounting(inner);
    const twice = withCostAccounting(once);

    assert.equal(twice, once, 'wrapping is idempotent');
    await twice.runTask({ prompt: 'p', cwd: '.' });

    assert.equal(seen.length, 1);
    assert.equal(costLedger.getLifetimeUsd(), 0.5);
  });

  it('preserves id, displayName and getCommand(), and passes options through', async () => {
    let received: EngineRunOptions | null = null;
    const wrapped = withCostAccounting(
      makeCostAdapter('ollama', async (o) => {
        received = o;
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      })
    );

    assert.equal(wrapped.id, 'ollama');
    assert.equal(wrapped.displayName, 'Cost ollama');
    assert.equal(wrapped.getCommand(), 'ollama-cmd');

    const signal = new AbortController().signal;
    await wrapped.runTask({ prompt: 'hello', cwd: '/tmp', signal, costLabel: 'task' });

    const got = received as EngineRunOptions | null;
    assert.ok(got);
    assert.equal(got!.prompt, 'hello');
    assert.equal(got!.cwd, '/tmp');
    assert.equal(got!.signal, signal);
  });

  it('registerEngine stores a wrapped adapter, so getEngine() accounts automatically', async () => {
    const seen = collect();
    registerEngine(
      makeCostAdapter('custom', async () => ({
        stdout: '', stderr: '', exitCode: 0, durationMs: 1, tokenUsage: usage,
      }))
    );

    const fromRegistry = getEngine('custom');
    assert.equal(fromRegistry.id, 'custom');
    assert.equal(fromRegistry.displayName, 'Cost custom');
    assert.equal(fromRegistry.getCommand(), 'custom-cmd');

    await fromRegistry.runTask({ prompt: 'p', cwd: '.', costLabel: 'plan-generation' });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].label, 'plan-generation');
  });

  it('getAllEngines() still exposes correct ids and display names', () => {
    registerEngine(
      makeCostAdapter('copilot', async () => ({
        stdout: '', stderr: '', exitCode: 0, durationMs: 1,
      }))
    );
    const all = getAllEngines();
    const copilot = all.find((a) => a.id === 'copilot');
    assert.ok(copilot);
    assert.equal(copilot!.displayName, 'Cost copilot');
    assert.equal(copilot!.getCommand(), 'copilot-cmd');
  });

  it('checkEngineAvailability() reads getCommand()/displayName through the wrapper', async () => {
    registerEngine(
      makeCostAdapter('custom', async () => ({
        stdout: '', stderr: '', exitCode: 0, durationMs: 1,
      }))
    );
    const results = await checkEngineAvailability(['custom']);
    const entry = results.get('custom');
    assert.ok(entry);
    // The fake command is not on PATH, but the adapter metadata must survive.
    assert.equal(entry!.command, 'custom-cmd');
    assert.equal(entry!.displayName, 'Cost custom');
  });
});
