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
