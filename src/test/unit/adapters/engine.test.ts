import { strict as assert } from 'assert';
import { registerEngine, getEngine, getAllEngines, EngineAdapter, EngineRunOptions } from '../../../adapters/engine';
import { EngineId, EngineResult } from '../../../models/types';

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
