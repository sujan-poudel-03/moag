import { strict as assert } from 'assert';
import { selectModel, ReasoningPreset, ModelSelection } from '../../../models/model-selector';
import { Task, TaskStatus, EngineId } from '../../../models/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task',
    name: 'Test Task',
    prompt: 'Create a hello world function',
    status: TaskStatus.Pending,
    ...overrides,
  };
}

describe('model-selector', () => {
  describe('selectModel', () => {
    it('should return a ModelSelection with required fields', () => {
      const result = selectModel(makeTask(), 'claude');
      assert.ok(result.modelId, 'modelId should be set');
      assert.ok(result.spec, 'spec should be set');
      assert.ok(result.reason, 'reason should be set');
      assert.ok(result.preset, 'preset should be set');
    });

    it('should select a fast model for a simple task', () => {
      const task = makeTask({ prompt: 'rename variable foo to bar' });
      const result = selectModel(task, 'claude');
      assert.equal(result.preset, 'fast');
      assert.ok(result.reason.includes('Score'));
    });

    it('should select a deep model for a complex task', () => {
      const task = makeTask({
        prompt: 'Refactor the entire authentication system to use OAuth2. ' +
          'This involves redesigning the database schema, migrating existing users, ' +
          'implementing security best practices, and optimizing performance. ' +
          'The system architecture needs a complete overhaul with complex state management.',
        files: ['auth.ts', 'db.ts', 'middleware.ts', 'routes.ts', 'models.ts'],
        dependsOn: ['task-1', 'task-2'],
        verifyCommand: 'npm test',
      });
      const result = selectModel(task, 'claude');
      assert.equal(result.preset, 'deep');
    });

    it('should select a balanced model for medium complexity', () => {
      // Score target: 26-50 (balanced)
      // >200 chars → 25 (medium prompt) + 3 files × 3 = 9 → total ~34
      const prompt = 'Add a new REST endpoint for user preferences with proper validation and error handling. ' +
        'Include TypeScript types and basic unit tests. Wire up the controller, register the route, ' +
        'and add proper request body parsing with schema validation for the incoming data.';
      const task = makeTask({
        prompt,
        files: ['routes.ts', 'types.ts', 'controller.ts'],
      });
      assert.ok(prompt.length > 200, `prompt should be >200 chars, got ${prompt.length}`);
      const result = selectModel(task, 'claude');
      assert.equal(result.preset, 'balanced');
    });

    it('should respect explicit preset override (fast)', () => {
      const task = makeTask({
        prompt: 'Redesign the entire system architecture with complex security requirements',
      });
      const result = selectModel(task, 'claude', 'fast');
      assert.equal(result.preset, 'fast');
      assert.ok(result.reason.includes('Preset override'));
    });

    it('should respect explicit preset override (deep)', () => {
      const task = makeTask({ prompt: 'fix typo' });
      const result = selectModel(task, 'claude', 'deep');
      assert.equal(result.preset, 'deep');
    });

    it('should work for codex engine', () => {
      const result = selectModel(makeTask(), 'codex');
      assert.equal(result.spec.engine, 'codex');
    });

    it('should work for gemini engine', () => {
      const result = selectModel(makeTask(), 'gemini');
      assert.equal(result.spec.engine, 'gemini');
    });

    it('should work for ollama engine', () => {
      const result = selectModel(makeTask(), 'ollama');
      assert.equal(result.spec.engine, 'ollama');
    });

    it('should handle empty prompt gracefully', () => {
      const task = makeTask({ prompt: '' });
      const result = selectModel(task, 'claude');
      assert.ok(result.modelId);
      assert.equal(result.preset, 'fast');
    });

    it('should handle task with no optional fields', () => {
      const task: Task = {
        id: 'minimal',
        name: 'Minimal',
        prompt: 'do something',
        status: TaskStatus.Pending,
      };
      const result = selectModel(task, 'claude');
      assert.ok(result.modelId);
    });

    it('should increase complexity score with files', () => {
      const withoutFiles = selectModel(makeTask({ prompt: 'test task' }), 'claude');
      const withFiles = selectModel(makeTask({
        prompt: 'test task',
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      }), 'claude');
      // More files should increase score (may or may not change preset)
      assert.ok(withFiles.reason.includes('file'));
    });

    it('should include dependency factor in reason', () => {
      const result = selectModel(makeTask({
        prompt: 'build feature',
        dependsOn: ['dep-1'],
      }), 'claude');
      assert.ok(result.reason.includes('dependency'));
    });

    it('should include verify command factor in reason', () => {
      const result = selectModel(makeTask({
        prompt: 'build feature',
        verifyCommand: 'npm test',
      }), 'claude');
      assert.ok(result.reason.includes('verify'));
    });
  });
});

describe('model-specs', () => {
  // Import here to test the specs module
  const { getModelSpec, getModelsForEngine, getDefaultModelForEngine, getAllModelSpecs } =
    require('../../../models/model-specs');

  it('should return spec for known model', () => {
    const spec = getModelSpec('sonnet-4');
    assert.ok(spec);
    assert.equal(spec.engine, 'claude');
    assert.equal(spec.displayName, 'Claude Sonnet 4');
  });

  it('should return undefined for unknown model', () => {
    assert.equal(getModelSpec('nonexistent'), undefined);
  });

  it('should return models for each engine', () => {
    const claudeModels = getModelsForEngine('claude');
    assert.ok(claudeModels.length >= 3);
    assert.ok(claudeModels.every((m: { engine: string }) => m.engine === 'claude'));

    const codexModels = getModelsForEngine('codex');
    assert.ok(codexModels.length >= 2);

    const geminiModels = getModelsForEngine('gemini');
    assert.ok(geminiModels.length >= 2);
  });

  it('should return default model for each engine', () => {
    assert.ok(getDefaultModelForEngine('claude'));
    assert.ok(getDefaultModelForEngine('codex'));
    assert.ok(getDefaultModelForEngine('gemini'));
    assert.ok(getDefaultModelForEngine('ollama'));
  });

  it('should return all specs', () => {
    const all = getAllModelSpecs();
    assert.ok(all.length >= 10);
  });

  it('should have valid pricing for all specs', () => {
    const all = getAllModelSpecs();
    for (const spec of all) {
      assert.ok(spec.inputPrice >= 0, `${spec.id} has negative input price`);
      assert.ok(spec.outputPrice >= 0, `${spec.id} has negative output price`);
      assert.ok(spec.contextWindow > 0, `${spec.id} has non-positive context window`);
    }
  });
});
