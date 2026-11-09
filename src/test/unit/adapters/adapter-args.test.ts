import { strict as assert } from 'assert';
import { setMockConfig, clearMockConfig } from '../mocks/vscode';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const { CodexAdapter } = proxyquire('../../../adapters/codex-adapter', {
  vscode: vscodeMock,
  './base-cli': { runCli: (_config: unknown, _opts: unknown) => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) },
});

const { ClaudeAdapter } = proxyquire('../../../adapters/claude-adapter', {
  vscode: vscodeMock,
  './base-cli': { runCli: (_config: unknown, _opts: unknown) => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) },
});

const { GeminiAdapter } = proxyquire('../../../adapters/gemini-adapter', {
  vscode: vscodeMock,
  './base-cli': { runCli: (_config: unknown, _opts: unknown) => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) },
});

const { OllamaAdapter } = proxyquire('../../../adapters/ollama-adapter', {
  vscode: vscodeMock,
  './base-cli': { runCli: (_config: unknown, _opts: unknown) => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) },
});

const { CustomAdapter } = proxyquire('../../../adapters/custom-adapter', {
  vscode: vscodeMock,
  './base-cli': { runCli: (_config: unknown, _opts: unknown) => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) },
});

describe('adapter argument building', () => {
  afterEach(() => {
    clearMockConfig();
  });

  describe('CodexAdapter', () => {
    it('should have id "codex"', () => {
      const adapter = new CodexAdapter();
      assert.equal(adapter.id, 'codex');
    });

    it('should return default command from getCommand()', () => {
      clearMockConfig();
      const adapter = new CodexAdapter();
      assert.equal(adapter.getCommand(), 'codex');
    });

    it('should return configured command from getCommand()', () => {
      setMockConfig('agentTaskPlayer.engines.codex', { command: '/usr/local/bin/codex' });
      const adapter = new CodexAdapter();
      assert.equal(adapter.getCommand(), '/usr/local/bin/codex');
    });

    it('should use stdin for prompt (not in args)', async () => {
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean } | undefined;
      const { CodexAdapter: CA } = proxyquire('../../../adapters/codex-adapter', {
        vscode: vscodeMock,
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      const adapter = new CA();
      await adapter.runTask({ prompt: 'test prompt', cwd: '/tmp' });
      const args = capturedConfig!.buildArgs({ prompt: 'test prompt' });
      // Prompt should NOT be in args — it's piped via stdin
      assert.ok(!args.includes('test prompt'), 'prompt should not be in args when useStdin is true');
      assert.equal(capturedConfig!.useStdin, true, 'useStdin should be true');
    });
  });

  describe('CodexAdapter in a plan-generation job', () => {
    it('gets the plan-job args: runs outside a git repo, no shell tool, read-only sandbox, never --full-auto', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildPlanWorkerConfig } = require('../../../server/run-env') as typeof import('../../../server/run-env');
      const cfg = buildPlanWorkerConfig({ defaultEngine: 'codex', versionBudgetUsd: 0 }, 0).agentTaskPlayer;
      setMockConfig('agentTaskPlayer.engines.codex', { autoApprove: cfg['engines.codex.autoApprove'], args: cfg['engines.codex.args'] });
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[] } | undefined;
      const { CodexAdapter: CA } = proxyquire('../../../adapters/codex-adapter', {
        vscode: vscodeMock,
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[] }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      await new CA().runTask({ prompt: 'plan it', cwd: '/scratch' });
      const args = capturedConfig!.buildArgs({ prompt: 'plan it' });
      assert.equal(args[0], 'exec');
      assert.ok(args.includes('--skip-git-repo-check'), 'the scratch dir is not a git repo');
      const pairs = args.slice(0, -1).map((a, i) => `${a} ${args[i + 1]}`);
      assert.ok(pairs.includes('--disable shell_tool'), 'no shell tool');
      assert.ok(pairs.includes('--disable unified_exec'), 'no unified exec tool');
      assert.ok(pairs.includes('--sandbox read-only'));
      assert.ok(pairs.includes('-c shell_environment_policy.inherit=none'));
      assert.ok(!args.includes('--full-auto'), 'auto-approve stays off');
      assert.ok(!args.some((a) => /danger-full-access|dangerously|--yolo/.test(a)));
      assert.ok(!args.includes('plan it'), 'the prompt still goes through stdin');
    });

    it('a run job (no plan args configured) does not get --skip-git-repo-check or the disables', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildWorkerConfig } = require('../../../server/run-env') as typeof import('../../../server/run-env');
      const cfg = buildWorkerConfig({ defaultEngine: 'codex', versionBudgetUsd: 0 }, 0).agentTaskPlayer as Record<string, unknown>;
      assert.equal('engines.codex.args' in cfg, false);
    });
  });

  describe('ClaudeAdapter', () => {
    it('should have id "claude"', () => {
      const adapter = new ClaudeAdapter();
      assert.equal(adapter.id, 'claude');
    });

    it('should return default command from getCommand()', () => {
      clearMockConfig();
      const adapter = new ClaudeAdapter();
      assert.equal(adapter.getCommand(), 'claude');
    });

    it('should include -p flag and use stdin for prompt', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'] });
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean } | undefined;
      const { ClaudeAdapter: CA } = proxyquire('../../../adapters/claude-adapter', {
        vscode: vscodeMock,
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      const adapter = new CA();
      await adapter.runTask({ prompt: 'hello', cwd: '/tmp' });
      const args = capturedConfig!.buildArgs({ prompt: 'hello' });
      assert.ok(args.includes('-p'));
      // Prompt should NOT be in args — it's piped via stdin
      assert.ok(!args.includes('hello'), 'prompt should not be in args when useStdin is true');
      assert.equal(capturedConfig!.useStdin, true, 'useStdin should be true');
    });
  });

  describe('ClaudeAdapter JSON output mode and per-call budget', () => {
    type Captured = { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean };
    /** A ClaudeAdapter whose runCli returns `out` and captures its config. */
    function claudeWith(out: { stdout: string; stderr?: string; exitCode?: number }): { adapter: { runTask: (o: { prompt: string; cwd: string }) => Promise<import('../../../models/types').EngineResult> }; captured: () => Captured } {
      let captured: Captured | undefined;
      const { ClaudeAdapter: CA } = proxyquire('../../../adapters/claude-adapter', {
        vscode: vscodeMock,
        fs: { mkdirSync: () => undefined, writeFileSync: () => undefined, existsSync: () => false, readFileSync: () => '', unlinkSync: () => undefined },
        './base-cli': {
          runCli: (config: Captured) => {
            captured = config;
            return Promise.resolve({ stdout: out.stdout, stderr: out.stderr ?? '', exitCode: out.exitCode ?? 0, durationMs: 1 });
          },
        },
      });
      return { adapter: new CA(), captured: () => captured! };
    }
    const jsonLine = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 5 }, ...o });

    it('appends --output-format json and --max-budget-usd with two decimals', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false, outputFormat: 'json', maxBudgetUsdPerCall: 1.5 });
      const c = claudeWith({ stdout: jsonLine({}) });
      await c.adapter.runTask({ prompt: 'hello', cwd: '/tmp' });
      const args = c.captured().buildArgs({ prompt: 'hello' });
      assert.deepEqual(args, ['-p', '--output-format', 'json', '--max-budget-usd', '1.50']);
      assert.equal(c.captured().useStdin, true);
      assert.ok(!args.includes('hello'));
    });

    it('never duplicates flags the args already carry', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', {
        args: ['-p', '--output-format', 'json', '--max-budget-usd=0.25'], autoApprove: false, outputFormat: 'json', maxBudgetUsdPerCall: 1.5,
      });
      const c = claudeWith({ stdout: jsonLine({}) });
      await c.adapter.runTask({ prompt: 'p', cwd: '/tmp' });
      assert.deepEqual(c.captured().buildArgs({ prompt: 'p' }), ['-p', '--output-format', 'json', '--max-budget-usd=0.25']);
    });

    it('a zero or negative per-call cap adds no flag', async () => {
      for (const maxBudgetUsdPerCall of [0, -1]) {
        setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false, maxBudgetUsdPerCall });
        const c = claudeWith({ stdout: 'x' });
        await c.adapter.runTask({ prompt: 'p', cwd: '/tmp' });
        assert.deepEqual(c.captured().buildArgs({ prompt: 'p' }), ['-p']);
      }
    });

    it('a JSON success sets stdout to the result text and reports the CLI cost as reported', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false, outputFormat: 'json' });
      const c = claudeWith({ stdout: `some banner\n${jsonLine({ result: '{"tasks":[]}' })}\n` });
      const r = await c.adapter.runTask({ prompt: 'p', cwd: '/tmp' });
      assert.equal(r.stdout, '{"tasks":[]}');
      assert.equal(r.exitCode, 0);
      assert.deepEqual(r.tokenUsage, { inputTokens: 10, outputTokens: 5, estimatedCost: 0.42, costSource: 'reported' });
    });

    it('is_error with exit 0 fails the call with the subtype in stderr', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false, outputFormat: 'json' });
      const c = claudeWith({ stdout: jsonLine({ is_error: true, subtype: 'error_max_budget_usd', result: 'budget hit', total_cost_usd: 1.51 }), stderr: 'warn' });
      const r = await c.adapter.runTask({ prompt: 'p', cwd: '/tmp' });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /^warn\n\[claude\] error_max_budget_usd: budget hit$/);
      assert.equal(r.tokenUsage?.estimatedCost, 1.51, 'a failed call still reports what it spent');
    });

    it('a non-zero exit is kept as is when is_error is set', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false, outputFormat: 'json' });
      const c = claudeWith({ stdout: jsonLine({ is_error: true }), exitCode: 2 });
      assert.equal((await c.adapter.runTask({ prompt: 'p', cwd: '/tmp' })).exitCode, 2);
    });

    it('garbage stdout in JSON mode leaves stdout raw and gives no tokenUsage', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false, outputFormat: 'json' });
      const c = claudeWith({ stdout: 'not json {oops' });
      const r = await c.adapter.runTask({ prompt: 'p', cwd: '/tmp' });
      assert.equal(r.stdout, 'not json {oops');
      assert.equal(r.tokenUsage, undefined);
    });

    it('prose with a dollar figure is never scraped in JSON mode', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false, outputFormat: 'json' });
      const noCost = claudeWith({ stdout: 'This change will cost: $3.50 per month. input_tokens: 1200 output_tokens: 300' });
      assert.equal((await noCost.adapter.runTask({ prompt: 'p', cwd: '/tmp' })).tokenUsage, undefined);
      const badCost = claudeWith({ stdout: jsonLine({ result: 'Costs $3.50', total_cost_usd: 'n/a' }) });
      const r = await badCost.adapter.runTask({ prompt: 'p', cwd: '/tmp' });
      assert.equal(r.stdout, 'Costs $3.50');
      assert.equal(r.tokenUsage, undefined, 'a missing total_cost_usd is unreported, not estimated');
    });

    it('text mode adds no JSON flag and never scrapes a cost: the cost is unknown', async () => {
      setMockConfig('agentTaskPlayer.engines.claude', { args: ['-p'], autoApprove: false });
      const c = claudeWith({ stdout: 'All done. cost: $0.04' });
      const r = await c.adapter.runTask({ prompt: 'p', cwd: '/tmp' });
      assert.deepEqual(c.captured().buildArgs({ prompt: 'p' }), ['-p']);
      assert.equal(r.stdout, 'All done. cost: $0.04');
      assert.equal(r.tokenUsage?.estimatedCost, undefined);
      assert.equal(r.tokenUsage?.costSource, 'unknown');
    });
  });

  describe('ClaudeAdapter in a plan-generation job', () => {
    it('gets no tools and no MCP servers, never skips permissions, and writes no settings.local.json', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildPlanWorkerConfig } = require('../../../server/run-env') as typeof import('../../../server/run-env');
      const cfg = buildPlanWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0).agentTaskPlayer;
      setMockConfig('agentTaskPlayer.engines.claude', { autoApprove: cfg['engines.claude.autoApprove'], args: cfg['engines.claude.args'] });
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean } | undefined;
      const writes: string[] = [];
      const { ClaudeAdapter: CA } = proxyquire('../../../adapters/claude-adapter', {
        vscode: vscodeMock,
        fs: { mkdirSync: (p: string) => { writes.push(p); }, writeFileSync: (p: string) => { writes.push(p); }, existsSync: () => false, readFileSync: () => '', unlinkSync: () => undefined },
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      await new CA().runTask({ prompt: 'plan it', cwd: '/scratch' });
      const args = capturedConfig!.buildArgs({ prompt: 'plan it' });
      assert.deepEqual(args, ['-p', '--strict-mcp-config', '--tools', '']);
      const toolsAt = args.indexOf('--tools');
      assert.equal(args[toolsAt + 1], '', '--tools "" disables every built-in tool');
      assert.ok(!args.some((a) => /dangerously|bypassPermissions|--allowedTools|--add-dir/.test(a)));
      assert.ok(!args.includes('plan it'), 'the prompt still goes through stdin');
      assert.equal(capturedConfig!.useStdin, true);
      assert.deepEqual(writes, [], 'no permission allow-list is written for a plan job');
    });
  });

  describe('GeminiAdapter', () => {
    it('should have id "gemini"', () => {
      const adapter = new GeminiAdapter();
      assert.equal(adapter.id, 'gemini');
    });

    it('should return default command from getCommand()', () => {
      clearMockConfig();
      const adapter = new GeminiAdapter();
      assert.equal(adapter.getCommand(), 'gemini');
    });
  });

  describe('OllamaAdapter', () => {
    it('should have id "ollama"', () => {
      const adapter = new OllamaAdapter();
      assert.equal(adapter.id, 'ollama');
    });

    it('should return default command from getCommand()', () => {
      clearMockConfig();
      const adapter = new OllamaAdapter();
      assert.equal(adapter.getCommand(), 'ollama');
    });

    it('should build args with "run" and model (prompt via stdin)', async () => {
      setMockConfig('agentTaskPlayer.engines.ollama', { model: 'llama3' });
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean } | undefined;
      const { OllamaAdapter: OA } = proxyquire('../../../adapters/ollama-adapter', {
        vscode: vscodeMock,
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      const adapter = new OA();
      await adapter.runTask({ prompt: 'hello', cwd: '/tmp' });
      const args = capturedConfig!.buildArgs({ prompt: 'hello' });
      assert.deepEqual(args, ['run', 'llama3']);
      assert.equal(capturedConfig!.useStdin, true, 'useStdin should be true');
    });

    it('should pass OLLAMA_HOST env when host is configured', async () => {
      setMockConfig('agentTaskPlayer.engines.ollama', { model: 'llama3', host: '192.168.1.50:11434' });
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean; env?: Record<string, string> } | undefined;
      const { OllamaAdapter: OA } = proxyquire('../../../adapters/ollama-adapter', {
        vscode: vscodeMock,
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean; env?: Record<string, string> }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      const adapter = new OA();
      await adapter.runTask({ prompt: 'hello', cwd: '/tmp' });
      assert.deepEqual(capturedConfig!.env, { OLLAMA_HOST: '192.168.1.50:11434' });
    });

    it('should omit env entirely when host is not configured', async () => {
      setMockConfig('agentTaskPlayer.engines.ollama', { model: 'llama3' });
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean; env?: Record<string, string> } | undefined;
      const { OllamaAdapter: OA } = proxyquire('../../../adapters/ollama-adapter', {
        vscode: vscodeMock,
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[]; useStdin?: boolean; env?: Record<string, string> }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      const adapter = new OA();
      await adapter.runTask({ prompt: 'hello', cwd: '/tmp' });
      assert.equal(capturedConfig!.env, undefined);
    });
  });

  describe('CustomAdapter', () => {
    it('should have id "custom"', () => {
      const adapter = new CustomAdapter();
      assert.equal(adapter.id, 'custom');
    });

    it('should return empty string from getCommand() when not configured', () => {
      clearMockConfig();
      const adapter = new CustomAdapter();
      assert.equal(adapter.getCommand(), '');
    });

    it('should return error result when command is empty', async () => {
      setMockConfig('agentTaskPlayer.engines.custom', { command: '' });
      const adapter = new CustomAdapter();
      const result = await adapter.runTask({ prompt: 'test', cwd: '/tmp' });
      assert.equal(result.exitCode, 1);
      assert.ok(result.stderr.includes('not configured'));
    });

    it('should replace {prompt} placeholder in args', async () => {
      setMockConfig('agentTaskPlayer.engines.custom', { command: 'mycli', args: ['--input', '{prompt}'] });
      let capturedConfig: { buildArgs: (opts: { prompt: string }) => string[] } | undefined;
      const { CustomAdapter: CA } = proxyquire('../../../adapters/custom-adapter', {
        vscode: vscodeMock,
        './base-cli': {
          runCli: (config: { buildArgs: (opts: { prompt: string }) => string[] }) => {
            capturedConfig = config;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
          },
        },
      });
      const adapter = new CA();
      await adapter.runTask({ prompt: 'do stuff', cwd: '/tmp' });
      const args = capturedConfig!.buildArgs({ prompt: 'do stuff' });
      assert.deepEqual(args, ['--input', 'do stuff']);
    });
  });
});
