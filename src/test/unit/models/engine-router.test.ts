import { strict as assert } from 'assert';
import { resolveAutoRoutedEngine, AutoRoutingConfig } from '../../../models/engine-router';
import { Task, TaskStatus } from '../../../models/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task',
    name: 'Test Task',
    prompt: 'Create a hello world function',
    status: TaskStatus.Pending,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AutoRoutingConfig> = {}): AutoRoutingConfig {
  return {
    enabled: true,
    simpleEngine: 'ollama',
    complexEngine: 'claude',
    complexityThreshold: 50,
    ...overrides,
  };
}

const COMPLEX_PROMPT = 'Refactor the entire authentication system to use OAuth2. ' +
  'This involves redesigning the database schema, migrating existing users, ' +
  'implementing security best practices, and optimizing performance. ' +
  'The system architecture needs a complete overhaul with complex state management.';

describe('engine-router', () => {
  describe('resolveAutoRoutedEngine', () => {
    it('resolves a simple-prompt task to simpleEngine', () => {
      const task = makeTask({ prompt: 'rename variable foo to bar' });
      const result = resolveAutoRoutedEngine(task, makeConfig());
      assert.ok(result);
      assert.equal(result!.engineId, 'ollama');
      assert.ok(result!.reason.includes('Auto-routed to ollama'));
    });

    it('resolves a complex-prompt task to complexEngine', () => {
      const task = makeTask({
        prompt: COMPLEX_PROMPT,
        files: ['auth.ts', 'db.ts', 'middleware.ts', 'routes.ts', 'models.ts'],
        dependsOn: ['task-1', 'task-2'],
        verifyCommand: 'npm test',
      });
      const result = resolveAutoRoutedEngine(task, makeConfig());
      assert.ok(result);
      assert.equal(result!.engineId, 'claude');
      assert.ok(result!.reason.includes('Auto-routed to claude'));
    });

    it('returns null when disabled', () => {
      const task = makeTask({ prompt: 'rename variable foo to bar' });
      const result = resolveAutoRoutedEngine(task, makeConfig({ enabled: false }));
      assert.equal(result, null);
    });

    it('returns null (does not throw) for invalid simpleEngine', () => {
      const task = makeTask();
      const config = makeConfig({ simpleEngine: 'not-a-real-engine' as unknown as AutoRoutingConfig['simpleEngine'] });
      assert.doesNotThrow(() => resolveAutoRoutedEngine(task, config));
      assert.equal(resolveAutoRoutedEngine(task, config), null);
    });

    it('returns null (does not throw) for invalid complexEngine', () => {
      const task = makeTask();
      const config = makeConfig({ complexEngine: 'not-a-real-engine' as unknown as AutoRoutingConfig['complexEngine'] });
      assert.doesNotThrow(() => resolveAutoRoutedEngine(task, config));
      assert.equal(resolveAutoRoutedEngine(task, config), null);
    });

    it('resolves to simpleEngine when score is exactly at the threshold (inclusive-low <=)', () => {
      const task = makeTask({ prompt: 'rename variable foo to bar' });
      // The 'fast' fixture scores well below 50; pin the threshold to that
      // exact score so the boundary comparison (score <= threshold) is
      // exercised directly rather than approximated.
      const probe = resolveAutoRoutedEngine(task, makeConfig({ complexityThreshold: 100 }));
      assert.ok(probe);
      const scoreMatch = probe!.reason.match(/score (\d+)\/100/);
      assert.ok(scoreMatch, `expected reason to carry a score: ${probe!.reason}`);
      const score = Number(scoreMatch![1]);

      const result = resolveAutoRoutedEngine(task, makeConfig({ complexityThreshold: score }));
      assert.ok(result);
      assert.equal(result!.engineId, 'ollama');
    });
  });
});
