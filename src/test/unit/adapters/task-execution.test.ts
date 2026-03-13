// ─── Task Execution Tests: Claude & Codex ───
// Validates the full task execution flow for both primary coding agents
// before deployment. Covers: arg building, auto-approve flags, streaming output,
// error handling, abort/cancel, cwd propagation, long prompts, and engine switching.

import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { setMockConfig, clearMockConfig } from '../mocks/vscode';
import { EngineResult, TaskStatus, RunnerState, Plan } from '../../../models/types';
import { createEmptyPlan, createTask } from '../../../models/plan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

// ─── Helpers ───

/** Captures the CliConfig passed to runCli so we can inspect buildArgs */
function createCapturingRunCli() {
  const calls: Array<{
    config: { command: string; buildArgs: (opts: { prompt: string; cwd?: string; modelId?: string }) => string[]; useStdin?: boolean };
    options: { prompt: string; cwd: string; signal?: AbortSignal; modelId?: string };
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  }> = [];

  const runCli = (config: unknown, options: unknown, onOutput?: unknown) => {
    calls.push({ config: config as typeof calls[0]['config'], options: options as typeof calls[0]['options'], onOutput: onOutput as typeof calls[0]['onOutput'] });
    return Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100 });
  };

  return { runCli, calls };
}

function createFailingRunCli(exitCode = 1, stderr = 'something went wrong') {
  const runCli = () => Promise.resolve({ stdout: '', stderr, exitCode, durationMs: 50 });
  return { runCli };
}

function createStreamingRunCli(chunks: Array<{ text: string; stream: 'stdout' | 'stderr' }>) {
  const runCli = async (_config: unknown, _options: unknown, onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void) => {
    let stdout = '';
    let stderr = '';
    for (const chunk of chunks) {
      if (onOutput) { onOutput(chunk.text, chunk.stream); }
      if (chunk.stream === 'stdout') { stdout += chunk.text; }
      else { stderr += chunk.text; }
    }
    return { stdout, stderr, exitCode: 0, durationMs: 200 };
  };
  return { runCli };
}

function createMockHistoryStore() {
  return {
    add: sinon.stub(),
    getAll: sinon.stub().returns([]),
    clear: sinon.stub(),
    onDidChange: sinon.stub(),
  };
}

function makeSpawnStub() {
  return sinon.stub().callsFake(() => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const proc = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (!handlers[event]) { handlers[event] = []; }
        handlers[event].push(handler);
        return proc;
      },
      stdout: { on: sinon.stub() },
      stderr: { on: sinon.stub() },
      kill: sinon.stub(),
    };
    setTimeout(() => {
      if (handlers['close']) {
        handlers['close'].forEach(h => h(0));
      }
    }, 5);
    return proc;
  });
}

// ─────────────────────────────────────────────────────────
// SECTION 1: Codex Adapter — argument building & behavior
// ─────────────────────────────────────────────────────────
describe('Codex Task Execution', () => {
  afterEach(() => {
    clearMockConfig();
    sinon.restore();
  });

  it('should build args with "exec" subcommand and use stdin for prompt', async () => {
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'fix the login bug', cwd: '/project' });

    const args = calls[0].config.buildArgs({ prompt: 'fix the login bug' });
    assert.equal(args[0], 'exec', 'first arg should be "exec"');
    // Prompt should NOT be in args — piped via stdin
    assert.ok(!args.includes('fix the login bug'), 'prompt should not be in args when useStdin is true');
    assert.equal((calls[0].config as any).useStdin, true, 'useStdin should be true');
  });

  it('should include --full-auto when autoApprove is true (default)', async () => {
    clearMockConfig();
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    const args = calls[0].config.buildArgs({ prompt: 'test' });
    assert.ok(args.includes('--full-auto'), 'should include --full-auto');
  });

  it('should NOT include --full-auto when autoApprove is false', async () => {
    setMockConfig('agentTaskPlayer.engines.codex', { autoApprove: false, args: [] });
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    const args = calls[0].config.buildArgs({ prompt: 'test' });
    assert.ok(!args.includes('--full-auto'), 'should not include --full-auto');
  });

  it('should not duplicate --full-auto if already in extraArgs', async () => {
    setMockConfig('agentTaskPlayer.engines.codex', { autoApprove: true, args: ['--full-auto'] });
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    const args = calls[0].config.buildArgs({ prompt: 'test' });
    const count = args.filter(a => a === '--full-auto').length;
    assert.equal(count, 1, 'should have exactly one --full-auto');
  });

  it('should let Codex CLI auto-select when no explicit model arg is configured', async () => {
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp', modelId: 'gpt-5.1-codex-mini' });

    const args = calls[0].config.buildArgs({ prompt: 'test', modelId: 'gpt-5.1-codex-mini' });
    assert.deepEqual(args, ['exec', '--full-auto']);
    assert.ok(!args.includes('--model'), 'should not force a model when no override is configured');
  });

  it('should preserve an explicit supported model arg from settings', async () => {
    setMockConfig('agentTaskPlayer.engines.codex', { args: ['--model', 'gpt-5.3-codex'] });
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp', modelId: 'gpt-5.4' });

    const args = calls[0].config.buildArgs({ prompt: 'test', modelId: 'gpt-5.4' });
    assert.deepEqual(args.slice(0, 4), ['exec', '--model', 'gpt-5.3-codex', '--full-auto']);
    assert.equal(args.filter(a => a === '--model').length, 1, 'should not add a second model flag');
  });

  it('should replace a legacy GPT-4 model arg with the selected Codex model', async () => {
    setMockConfig('agentTaskPlayer.engines.codex', { args: ['--model', 'gpt-4.1-mini'] });
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp', modelId: 'gpt-5.1-codex-mini' });

    const args = calls[0].config.buildArgs({ prompt: 'test', modelId: 'gpt-5.1-codex-mini' });
    assert.deepEqual(args.slice(0, 4), ['exec', '--model', 'gpt-5.1-codex-mini', '--full-auto']);
    assert.ok(!args.includes('gpt-4.1-mini'), 'should not keep the unsupported GPT-4 model');
  });

  it('should include extra args from settings', async () => {
    setMockConfig('agentTaskPlayer.engines.codex', { args: ['-m', 'o3', '--ephemeral'] });
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'hello', cwd: '/tmp' });

    const args = calls[0].config.buildArgs({ prompt: 'hello' });
    assert.ok(args.includes('-m'), 'should include -m flag');
    assert.ok(args.includes('o3'), 'should include model name');
    assert.ok(args.includes('--ephemeral'), 'should include --ephemeral');
  });

  it('should use custom command path from settings', () => {
    setMockConfig('agentTaskPlayer.engines.codex', { command: '/opt/bin/codex' });
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) },
    });
    const adapter = new CodexAdapter();
    assert.equal(adapter.getCommand(), '/opt/bin/codex');
  });

  it('should propagate cwd to runCli options', async () => {
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/my/project' });

    assert.equal(calls[0].options.cwd, '/my/project');
  });

  it('should pass onOutput callback for streaming', async () => {
    const { runCli, calls } = createCapturingRunCli();
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    const outputFn = sinon.stub();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp', onOutput: outputFn });

    assert.equal(calls[0].onOutput, outputFn, 'should pass onOutput through');
  });

  it('should return result from runCli', async () => {
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli: () => Promise.resolve({ stdout: 'done', stderr: '', exitCode: 0, durationMs: 42 }) },
    });
    const adapter = new CodexAdapter();
    const result = await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    assert.equal(result.stdout, 'done');
    assert.equal(result.exitCode, 0);
    assert.equal(result.durationMs, 42);
  });

  it('should propagate failure exit code from codex', async () => {
    const { runCli } = createFailingRunCli(1, 'codex error');
    const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new CodexAdapter();
    const result = await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('codex error'));
  });
});

// ─────────────────────────────────────────────────────────
// SECTION 2: Claude Adapter — argument building & behavior
// ─────────────────────────────────────────────────────────
describe('Claude Task Execution', () => {
  afterEach(() => {
    clearMockConfig();
    sinon.restore();
  });

  it('should build args with -p flag and use stdin for prompt', async () => {
    setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'] });
    const { runCli, calls } = createCapturingRunCli();
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new ClaudeAdapter();
    await adapter.runTask({ prompt: 'refactor the auth module', cwd: '/project' });

    const args = calls[0].config.buildArgs({ prompt: 'refactor the auth module' });
    assert.ok(args.includes('-p'), 'should include -p flag');
    // Prompt should NOT be in args — piped via stdin
    assert.ok(!args.includes('refactor the auth module'), 'prompt should not be in args when useStdin is true');
    assert.equal((calls[0].config as any).useStdin, true, 'useStdin should be true');
  });

  it('should include --dangerously-skip-permissions when autoApprove is true (default)', async () => {
    setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'] });
    const { runCli, calls } = createCapturingRunCli();
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new ClaudeAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    const args = calls[0].config.buildArgs({ prompt: 'test' });
    assert.ok(args.includes('--dangerously-skip-permissions'), 'should include skip-permissions');
  });

  it('should NOT include --dangerously-skip-permissions when autoApprove is false', async () => {
    setMockConfig('agentTaskPlayer.engines.claude', { autoApprove: false, args: ['-p'] });
    const { runCli, calls } = createCapturingRunCli();
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new ClaudeAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    const args = calls[0].config.buildArgs({ prompt: 'test' });
    assert.ok(!args.includes('--dangerously-skip-permissions'), 'should not include skip-permissions');
  });

  it('should not duplicate --dangerously-skip-permissions if already in extraArgs', async () => {
    setMockConfig('agentTaskPlayer.engines.claude', { autoApprove: true, args: ['-p', '--dangerously-skip-permissions'] });
    const { runCli, calls } = createCapturingRunCli();
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new ClaudeAdapter();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    const args = calls[0].config.buildArgs({ prompt: 'test' });
    const count = args.filter(a => a === '--dangerously-skip-permissions').length;
    assert.equal(count, 1, 'should have exactly one --dangerously-skip-permissions');
  });

  it('should parse token usage from stderr', async () => {
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': {
        runCli: () => Promise.resolve({
          stdout: 'result',
          stderr: 'Total input tokens: 1500\nTotal output tokens: 800\nCost: $0.035',
          exitCode: 0,
          durationMs: 100,
        }),
      },
    });
    const adapter = new ClaudeAdapter();
    const result = await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    assert.ok(result.tokenUsage, 'should have tokenUsage');
    assert.equal(result.tokenUsage!.inputTokens, 1500);
    assert.equal(result.tokenUsage!.outputTokens, 800);
    assert.equal(result.tokenUsage!.totalTokens, 2300);
    assert.equal(result.tokenUsage!.estimatedCost, 0.035);
  });

  it('should return undefined tokenUsage when stderr has no token info', async () => {
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': {
        runCli: () => Promise.resolve({ stdout: 'ok', stderr: 'some warning', exitCode: 0, durationMs: 50 }),
      },
    });
    const adapter = new ClaudeAdapter();
    const result = await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    assert.equal(result.tokenUsage, undefined);
  });

  it('should use custom command path from settings', () => {
    setMockConfig('agentTaskPlayer.engines.claude', { command: '/usr/local/bin/claude' });
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) },
    });
    const adapter = new ClaudeAdapter();
    assert.equal(adapter.getCommand(), '/usr/local/bin/claude');
  });

  it('should propagate failure exit code from claude', async () => {
    const { runCli } = createFailingRunCli(1, 'API key invalid');
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new ClaudeAdapter();
    const result = await adapter.runTask({ prompt: 'test', cwd: '/tmp' });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('API key invalid'));
  });

  it('should pass onOutput callback for streaming', async () => {
    const { runCli, calls } = createCapturingRunCli();
    const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
      vscode: vscodeMock,
      './base-cli': { runCli },
    });
    const adapter = new ClaudeAdapter();
    const outputFn = sinon.stub();
    await adapter.runTask({ prompt: 'test', cwd: '/tmp', onOutput: outputFn });

    assert.equal(calls[0].onOutput, outputFn, 'should pass onOutput through');
  });
});

// ─────────────────────────────────────────────────────────
// SECTION 3: Runner → Engine integration (both engines)
// ─────────────────────────────────────────────────────────
describe('Runner Task Execution — engine integration', () => {
  afterEach(() => {
    clearMockConfig();
    sinon.restore();
  });

  function buildRunnerWithEngine(engineId: 'codex' | 'claude', engineStub: sinon.SinonStub) {
    const historyStore = createMockHistoryStore();
    const mockEngine = {
      id: engineId,
      displayName: engineId === 'codex' ? 'Codex CLI' : 'Claude Code',
      getCommand: () => engineId,
      runTask: engineStub,
    };
    const spawnStub = makeSpawnStub();

    const { TaskRunner } = proxyquire('../../../runner/runner', {
      'vscode': vscodeMock,
      '../adapters/index': { getEngine: () => mockEngine },
      '../context/context-builder': {
        buildContext: () => '',
        getContextSettings: () => ({ enabled: false }),
      },
      'child_process': { spawn: spawnStub, execSync: sinon.stub() },
    });

    const runner = new TaskRunner(historyStore);
    return { runner, historyStore, mockEngine, spawnStub };
  }

  function makeSingleTaskPlan(engineId: 'codex' | 'claude', prompt = 'do the thing'): Plan {
    const plan = createEmptyPlan('Test');
    plan.defaultEngine = engineId;
    const pl = plan.playlists[0];
    pl.name = 'Phase';
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    pl.tasks.push(createTask('Task A', prompt));
    return plan;
  }

  function makeMultiTaskPlan(engineId: 'codex' | 'claude'): Plan {
    const plan = createEmptyPlan('Multi');
    plan.defaultEngine = engineId;
    const pl = plan.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    pl.tasks.push(
      createTask('Setup', 'initialize the project'),
      createTask('Feature', 'build the login page'),
      createTask('Test', 'write unit tests'),
    );
    return plan;
  }

  // ─── Codex through runner ───

  describe('Codex through runner', () => {
    it('should execute a single task and mark it completed', async () => {
      const stub = sinon.stub().resolves({ stdout: 'done', stderr: '', exitCode: 0, durationMs: 100 });
      const { runner } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex');

      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
      assert.equal(stub.callCount, 1);
    });

    it('should pass prompt to codex engine', async () => {
      const stub = sinon.stub().resolves({ stdout: '', stderr: '', exitCode: 0, durationMs: 50 });
      const { runner } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex', 'fix the CSS layout');

      await runner.play(plan);

      const callArgs = stub.firstCall.args[0];
      assert.ok(callArgs.prompt.includes('fix the CSS layout'));
    });

    it('should mark task as failed on non-zero exit', async () => {
      const stub = sinon.stub().resolves({ stdout: '', stderr: 'error', exitCode: 1, durationMs: 50 });
      const { runner } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex');

      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    });

    it('should record the model reported by codex in history', async () => {
      const stub = sinon.stub().resolves({
        stdout: 'Reading prompt from stdin...\n--------\nmodel: gpt-5.4\n--------\nok',
        stderr: '',
        exitCode: 0,
        durationMs: 100,
      });
      const { runner, historyStore } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex');

      await runner.play(plan);

      assert.equal(historyStore.add.callCount, 1);
      const entry = historyStore.add.firstCall.args[0];
      assert.equal(entry.engine, 'codex');
      assert.equal(entry.status, TaskStatus.Completed);
      assert.equal(entry.modelId, 'gpt-5.4');
      assert.equal(entry.modelReason, undefined);
    });

    it('should execute multiple tasks sequentially', async () => {
      const order: string[] = [];
      const stub = sinon.stub().callsFake(async (opts: { prompt: string }) => {
        order.push(opts.prompt);
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 10 };
      });
      const { runner } = buildRunnerWithEngine('codex', stub);
      const plan = makeMultiTaskPlan('codex');

      await runner.play(plan);

      assert.equal(order.length, 3);
      assert.ok(order[0].includes('initialize the project'));
      assert.ok(order[1].includes('build the login page'));
      assert.ok(order[2].includes('write unit tests'));
    });

    it('should emit task-output events during codex execution', async () => {
      const stub = sinon.stub().callsFake(async (opts: { onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void }) => {
        if (opts.onOutput) {
          opts.onOutput('codex working...', 'stdout');
          opts.onOutput('codex done', 'stdout');
        }
        return { stdout: 'codex working...codex done', stderr: '', exitCode: 0, durationMs: 100 };
      });
      const { runner } = buildRunnerWithEngine('codex', stub);
      const outputs: string[] = [];
      runner.on('task-output', (_task: unknown, chunk: string) => outputs.push(chunk));

      const plan = makeSingleTaskPlan('codex');
      await runner.play(plan);

      assert.ok(outputs.some(o => o.includes('codex working')));
    });

    it('should handle codex engine throwing an error', async () => {
      const stub = sinon.stub().rejects(new Error('codex crashed'));
      const { runner } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex');

      const failedTasks: string[] = [];
      runner.on('task-failed', (task: { name: string }) => failedTasks.push(task.name));

      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
      assert.deepEqual(failedTasks, ['Task A']);
    });

    it('should retry codex task on failure', async function () {
      this.timeout(10000);
      let callCount = 0;
      const stub = sinon.stub().callsFake(async () => {
        callCount++;
        if (callCount === 1) {
          return { stdout: '', stderr: 'rate limited', exitCode: 1, durationMs: 50 };
        }
        return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 50 };
      });
      const { runner } = buildRunnerWithEngine('codex', stub);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sinon.stub(Object.getPrototypeOf(runner), 'sleep').resolves();

      const plan = makeSingleTaskPlan('codex');
      plan.playlists[0].tasks[0].retryCount = 1;

      await runner.play(plan);

      assert.equal(callCount, 2);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    });
  });

  // ─── Claude through runner ───

  describe('Claude through runner', () => {
    it('should execute a single task and mark it completed', async () => {
      const stub = sinon.stub().resolves({ stdout: 'done', stderr: '', exitCode: 0, durationMs: 100 });
      const { runner } = buildRunnerWithEngine('claude', stub);
      const plan = makeSingleTaskPlan('claude');

      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
      assert.equal(stub.callCount, 1);
    });

    it('should pass prompt to claude engine', async () => {
      const stub = sinon.stub().resolves({ stdout: '', stderr: '', exitCode: 0, durationMs: 50 });
      const { runner } = buildRunnerWithEngine('claude', stub);
      const plan = makeSingleTaskPlan('claude', 'add error handling');

      await runner.play(plan);

      const callArgs = stub.firstCall.args[0];
      assert.ok(callArgs.prompt.includes('add error handling'));
    });

    it('should mark task as failed on non-zero exit', async () => {
      const stub = sinon.stub().resolves({ stdout: '', stderr: 'failed', exitCode: 1, durationMs: 50 });
      const { runner } = buildRunnerWithEngine('claude', stub);
      const plan = makeSingleTaskPlan('claude');

      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    });

    it('should record history entry for claude execution', async () => {
      const stub = sinon.stub().resolves({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100 });
      const { runner, historyStore } = buildRunnerWithEngine('claude', stub);
      const plan = makeSingleTaskPlan('claude');

      await runner.play(plan);

      assert.equal(historyStore.add.callCount, 1);
      const entry = historyStore.add.firstCall.args[0];
      assert.equal(entry.engine, 'claude');
      assert.equal(entry.status, TaskStatus.Completed);
    });

    it('should execute multiple tasks sequentially', async () => {
      const order: string[] = [];
      const stub = sinon.stub().callsFake(async (opts: { prompt: string }) => {
        order.push(opts.prompt);
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 10 };
      });
      const { runner } = buildRunnerWithEngine('claude', stub);
      const plan = makeMultiTaskPlan('claude');

      await runner.play(plan);

      assert.equal(order.length, 3);
      assert.ok(order[0].includes('initialize the project'));
      assert.ok(order[1].includes('build the login page'));
      assert.ok(order[2].includes('write unit tests'));
    });

    it('should emit task-output events during claude execution', async () => {
      const stub = sinon.stub().callsFake(async (opts: { onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void }) => {
        if (opts.onOutput) {
          opts.onOutput('claude thinking...', 'stdout');
          opts.onOutput('claude done', 'stdout');
        }
        return { stdout: 'claude thinking...claude done', stderr: '', exitCode: 0, durationMs: 100 };
      });
      const { runner } = buildRunnerWithEngine('claude', stub);
      const outputs: string[] = [];
      runner.on('task-output', (_task: unknown, chunk: string) => outputs.push(chunk));

      const plan = makeSingleTaskPlan('claude');
      await runner.play(plan);

      assert.ok(outputs.some(o => o.includes('claude thinking')));
    });

    it('should handle claude engine throwing an error', async () => {
      const stub = sinon.stub().rejects(new Error('API key expired'));
      const { runner } = buildRunnerWithEngine('claude', stub);
      const plan = makeSingleTaskPlan('claude');

      const failedTasks: string[] = [];
      runner.on('task-failed', (task: { name: string }) => failedTasks.push(task.name));

      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
      assert.deepEqual(failedTasks, ['Task A']);
    });

    it('should retry claude task on failure', async function () {
      this.timeout(10000);
      let callCount = 0;
      const stub = sinon.stub().callsFake(async () => {
        callCount++;
        if (callCount === 1) {
          return { stdout: '', stderr: 'timeout', exitCode: 1, durationMs: 50 };
        }
        return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 50 };
      });
      const { runner } = buildRunnerWithEngine('claude', stub);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sinon.stub(Object.getPrototypeOf(runner), 'sleep').resolves();

      const plan = makeSingleTaskPlan('claude');
      plan.playlists[0].tasks[0].retryCount = 1;

      await runner.play(plan);

      assert.equal(callCount, 2);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    });
  });

  // ─── Cross-engine: switching between codex and claude ───

  describe('Engine switching within a plan', () => {
    it('should use task-level engine override', async () => {
      const enginesUsed: string[] = [];
      const codexStub = sinon.stub().callsFake(async () => {
        enginesUsed.push('codex');
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 10 };
      });
      const claudeStub = sinon.stub().callsFake(async () => {
        enginesUsed.push('claude');
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 10 };
      });

      const historyStore = createMockHistoryStore();
      let callIndex = 0;
      const { TaskRunner } = proxyquire('../../../runner/runner', {
        'vscode': vscodeMock,
        '../adapters/index': {
          getEngine: (id: string) => {
            if (id === 'codex') {
              return { id: 'codex', displayName: 'Codex', getCommand: () => 'codex', runTask: codexStub };
            }
            return { id: 'claude', displayName: 'Claude', getCommand: () => 'claude', runTask: claudeStub };
          },
        },
        '../context/context-builder': {
          buildContext: () => '',
          getContextSettings: () => ({ enabled: false }),
        },
        'child_process': { spawn: makeSpawnStub() },
      });

      const plan = createEmptyPlan('Mixed');
      plan.defaultEngine = 'claude';
      const pl = plan.playlists[0];
      pl.autoplay = true;
      pl.autoplayDelay = 0;

      const task1 = createTask('Claude Task', 'do with claude');
      const task2 = createTask('Codex Task', 'do with codex');
      task2.engine = 'codex';
      const task3 = createTask('Claude Again', 'back to claude');

      pl.tasks.push(task1, task2, task3);

      const runner = new TaskRunner(historyStore);
      await runner.play(plan);

      assert.deepEqual(enginesUsed, ['claude', 'codex', 'claude']);
      assert.equal(task1.status, TaskStatus.Completed);
      assert.equal(task2.status, TaskStatus.Completed);
      assert.equal(task3.status, TaskStatus.Completed);
    });

    it('should use playlist-level engine override', async () => {
      const enginesUsed: string[] = [];
      const historyStore = createMockHistoryStore();

      const { TaskRunner } = proxyquire('../../../runner/runner', {
        'vscode': vscodeMock,
        '../adapters/index': {
          getEngine: (id: string) => ({
            id,
            displayName: id,
            getCommand: () => id,
            runTask: async () => {
              enginesUsed.push(id);
              return { stdout: '', stderr: '', exitCode: 0, durationMs: 10 };
            },
          }),
        },
        '../context/context-builder': {
          buildContext: () => '',
          getContextSettings: () => ({ enabled: false }),
        },
        'child_process': { spawn: makeSpawnStub() },
      });

      const plan = createEmptyPlan('Multi-Playlist');
      plan.defaultEngine = 'claude';

      // Playlist 1: uses codex
      const pl1 = plan.playlists[0];
      pl1.name = 'Codex Phase';
      pl1.engine = 'codex';
      pl1.autoplay = true;
      pl1.autoplayDelay = 0;
      pl1.tasks.push(createTask('T1', 'task 1'));

      // Playlist 2: uses plan default (claude)
      const pl2 = { id: 'pl2', name: 'Claude Phase', autoplay: true, autoplayDelay: 0, tasks: [createTask('T2', 'task 2')] };
      plan.playlists.push(pl2 as any);

      const runner = new TaskRunner(historyStore);
      await runner.play(plan);

      assert.equal(enginesUsed[0], 'codex');
      assert.equal(enginesUsed[1], 'claude');
    });
  });

  // ─── Abort/Cancel ───

  describe('Abort and stop', () => {
    it('should pass abort signal to engine', async () => {
      let receivedSignal: AbortSignal | undefined;
      const stub = sinon.stub().callsFake(async (opts: { signal?: AbortSignal }) => {
        receivedSignal = opts.signal;
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 10 };
      });
      const { runner } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex');

      await runner.play(plan);

      assert.ok(receivedSignal, 'signal should be passed to engine');
      assert.ok(receivedSignal instanceof AbortSignal);
    });

    it('should stop mid-execution across multiple tasks', async () => {
      let taskCount = 0;
      const stub = sinon.stub().callsFake(async () => {
        taskCount++;
        await new Promise(r => setTimeout(r, 200));
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 200 };
      });
      const { runner } = buildRunnerWithEngine('claude', stub);
      const plan = makeMultiTaskPlan('claude');

      const playPromise = runner.play(plan);
      await new Promise(r => setTimeout(r, 100));
      runner.stop();
      await playPromise;

      // Should have started at most 1 task before stopping
      assert.ok(taskCount <= 2, `Expected <= 2 tasks started but got ${taskCount}`);
      assert.equal(runner.state, RunnerState.Idle);
    });
  });

  // ─── Error guidance ───

  describe('Error guidance messages', () => {
    it('should provide ENOENT guidance for codex', async () => {
      const stub = sinon.stub().rejects(new Error('spawn codex ENOENT'));
      const { runner, historyStore } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex');

      await runner.play(plan);

      const entry = historyStore.add.firstCall.args[0];
      assert.ok(entry.result.stderr.includes('ENOENT'));
      assert.ok(entry.result.stderr.includes('codex'));
    });

    it('should provide ENOENT guidance for claude', async () => {
      const stub = sinon.stub().rejects(new Error('spawn claude ENOENT'));
      const { runner, historyStore } = buildRunnerWithEngine('claude', stub);
      const plan = makeSingleTaskPlan('claude');

      await runner.play(plan);

      const entry = historyStore.add.firstCall.args[0];
      assert.ok(entry.result.stderr.includes('ENOENT'));
      assert.ok(entry.result.stderr.includes('claude'));
    });

    it('should provide auth guidance for API key errors', async () => {
      const stub = sinon.stub().rejects(new Error('unauthorized: invalid API key'));
      const { runner, historyStore } = buildRunnerWithEngine('codex', stub);
      const plan = makeSingleTaskPlan('codex');

      await runner.play(plan);

      const entry = historyStore.add.firstCall.args[0];
      assert.ok(entry.result.stderr.toLowerCase().includes('authentication') || entry.result.stderr.toLowerCase().includes('api key'));
    });
  });

  // ─── Dependency chain across engines ───

  describe('Dependency chains', () => {
    it('should skip codex task when claude dependency fails', async () => {
      const enginesUsed: string[] = [];
      const historyStore = createMockHistoryStore();

      const { TaskRunner } = proxyquire('../../../runner/runner', {
        'vscode': vscodeMock,
        '../adapters/index': {
          getEngine: (id: string) => ({
            id,
            displayName: id,
            getCommand: () => id,
            runTask: async () => {
              enginesUsed.push(id);
              // Claude task fails
              if (id === 'claude') {
                return { stdout: '', stderr: 'failed', exitCode: 1, durationMs: 10 };
              }
              return { stdout: '', stderr: '', exitCode: 0, durationMs: 10 };
            },
          }),
        },
        '../context/context-builder': {
          buildContext: () => '',
          getContextSettings: () => ({ enabled: false }),
        },
        'child_process': { spawn: makeSpawnStub() },
      });

      const plan = createEmptyPlan('Deps');
      plan.defaultEngine = 'claude';
      const pl = plan.playlists[0];
      pl.autoplay = true;
      pl.autoplayDelay = 0;

      const task1 = createTask('Claude Setup', 'setup');
      task1.id = 'setup-task';
      task1.engine = 'claude';

      const task2 = createTask('Codex Build', 'build');
      task2.engine = 'codex';
      task2.dependsOn = ['setup-task'];

      pl.tasks.push(task1, task2);

      const runner = new TaskRunner(historyStore);
      await runner.play(plan);

      assert.equal(task1.status, TaskStatus.Failed);
      assert.equal(task2.status, TaskStatus.Skipped);
      // Codex engine should never have been called
      assert.ok(!enginesUsed.includes('codex'));
    });

    it('should run codex task when claude dependency succeeds', async () => {
      const enginesUsed: string[] = [];
      const historyStore = createMockHistoryStore();

      const { TaskRunner } = proxyquire('../../../runner/runner', {
        'vscode': vscodeMock,
        '../adapters/index': {
          getEngine: (id: string) => ({
            id,
            displayName: id,
            getCommand: () => id,
            runTask: async () => {
              enginesUsed.push(id);
              return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 10 };
            },
          }),
        },
        '../context/context-builder': {
          buildContext: () => '',
          getContextSettings: () => ({ enabled: false }),
        },
        'child_process': { spawn: makeSpawnStub() },
      });

      const plan = createEmptyPlan('Deps');
      plan.defaultEngine = 'claude';
      const pl = plan.playlists[0];
      pl.autoplay = true;
      pl.autoplayDelay = 0;

      const task1 = createTask('Claude Setup', 'setup');
      task1.id = 'setup-task';
      task1.engine = 'claude';

      const task2 = createTask('Codex Build', 'build');
      task2.engine = 'codex';
      task2.dependsOn = ['setup-task'];

      pl.tasks.push(task1, task2);

      const runner = new TaskRunner(historyStore);
      await runner.play(plan);

      assert.equal(task1.status, TaskStatus.Completed);
      assert.equal(task2.status, TaskStatus.Completed);
      assert.deepEqual(enginesUsed, ['claude', 'codex']);
    });
  });

  // ─── Parallel execution with mixed engines ───

  describe('Parallel execution', () => {
    it('should run codex and claude tasks in parallel', async () => {
      const startTimes: Record<string, number> = {};
      const historyStore = createMockHistoryStore();

      const { TaskRunner } = proxyquire('../../../runner/runner', {
        'vscode': vscodeMock,
        '../adapters/index': {
          getEngine: (id: string) => ({
            id,
            displayName: id,
            getCommand: () => id,
            runTask: async () => {
              startTimes[id] = Date.now();
              await new Promise(r => setTimeout(r, 100));
              return { stdout: '', stderr: '', exitCode: 0, durationMs: 100 };
            },
          }),
        },
        '../context/context-builder': {
          buildContext: () => '',
          getContextSettings: () => ({ enabled: false }),
        },
        'child_process': { spawn: makeSpawnStub() },
      });

      const plan = createEmptyPlan('Parallel');
      plan.defaultEngine = 'claude';
      const pl = plan.playlists[0];
      pl.autoplay = true;
      pl.autoplayDelay = 0;
      pl.parallel = true;

      const task1 = createTask('Claude Work', 'do claude stuff');
      task1.engine = 'claude';
      const task2 = createTask('Codex Work', 'do codex stuff');
      task2.engine = 'codex';

      pl.tasks.push(task1, task2);

      const runner = new TaskRunner(historyStore);
      await runner.play(plan);

      assert.equal(task1.status, TaskStatus.Completed);
      assert.equal(task2.status, TaskStatus.Completed);

      // Both should have started within ~50ms of each other (parallel)
      const diff = Math.abs((startTimes['claude'] || 0) - (startTimes['codex'] || 0));
      assert.ok(diff < 50, `Expected parallel start, but diff was ${diff}ms`);
    });
  });
});
