// ─── Live Task Execution Tests: Claude & Codex ───
// Sends REAL prompts to actual CLI binaries and validates the response content.
// Requires CLIs to be installed and authenticated.
//
// Run separately (not part of npm test — these cost API credits):
//   npx mocha --require ts-node/register "src/test/unit/adapters/task-execution-live.test.ts" --timeout 180000
//
// Tests auto-skip when the CLI is not available.

import { strict as assert } from 'assert';
import { execSync } from 'child_process';
import { runCli, CliConfig } from '../../../adapters/base-cli';

// ─── Helpers ───

function cliExists(cmd: string): boolean {
  try {
    execSync(
      process.platform === 'win32'
        ? `where ${cmd} 2>nul`
        : `which ${cmd} 2>/dev/null`,
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

function isInsideClaudeSession(): boolean {
  return !!process.env.CLAUDECODE;
}

const hasCodex = cliExists('codex');
const hasClaude = cliExists('claude') && !isInsideClaudeSession();

// ───────────────────────────────────────
// Codex: real prompt → real answer
// ───────────────────────────────────────
describe('Codex Live Execution', function () {
  this.timeout(180000);

  before(function () {
    if (!hasCodex) {
      console.log('    Skipping Codex live tests: codex CLI not installed');
      this.skip();
    }
  });

  it('should send a prompt and receive the correct answer', async () => {
    const config: CliConfig = {
      command: 'codex',
      buildArgs: () => [
        'exec',
        '--full-auto',
        '--ephemeral',
        'What is the capital of France? Reply with ONLY the city name, one word, nothing else.',
      ],
    };

    const chunks: string[] = [];
    const result = await runCli(
      config,
      { prompt: '', cwd: process.cwd() },
      (chunk, stream) => { if (stream === 'stdout') { chunks.push(chunk); } },
    );

    // 1. Process exited successfully
    assert.equal(result.exitCode, 0, `Codex exited with code ${result.exitCode}.\nstderr: ${result.stderr}`);

    // 2. Got streaming output
    assert.ok(chunks.length > 0, 'Should have received streaming chunks');

    // 3. Answer is correct
    const output = result.stdout.toUpperCase();
    assert.ok(output.includes('PARIS'), `Expected "PARIS" in output but got:\n${result.stdout}`);

    // 4. Duration is sane
    assert.ok(result.durationMs > 0, 'Duration should be positive');
    assert.ok(result.durationMs < 180000, 'Should finish within timeout');
  });

  it('should solve a math problem correctly', async () => {
    const config: CliConfig = {
      command: 'codex',
      buildArgs: () => [
        'exec',
        '--full-auto',
        '--ephemeral',
        'What is 15 * 4? Reply with ONLY the number, nothing else.',
      ],
    };

    const result = await runCli(config, { prompt: '', cwd: process.cwd() });

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('60'), `Expected "60" in:\n${result.stdout}`);
  });

  it('should work with the full adapter pipeline (replicating CodexAdapter.buildArgs)', async () => {
    // Exact same logic as codex-adapter.ts buildArgs
    const extraArgs: string[] = [];
    const autoApprove = true;

    const config: CliConfig = {
      command: 'codex',
      buildArgs: (opts) => {
        const args = ['exec', ...extraArgs];
        if (autoApprove && !args.includes('--full-auto')) {
          args.push('--full-auto');
        }
        args.push('--ephemeral');
        args.push(opts.prompt);
        return args;
      },
    };

    const result = await runCli(
      config,
      { prompt: 'Reply with exactly: CODEX_PIPELINE_OK', cwd: process.cwd() },
    );

    assert.equal(result.exitCode, 0, `Pipeline failed. stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('CODEX_PIPELINE_OK'),
      `Expected CODEX_PIPELINE_OK in:\n${result.stdout}`,
    );
    assert.ok(result.command, 'Should have command string set');
  });

  it('should be cancellable via AbortSignal', async () => {
    const controller = new AbortController();
    const config: CliConfig = {
      command: 'codex',
      buildArgs: () => [
        'exec',
        '--full-auto',
        '--ephemeral',
        'Write a very long 5000 word essay about quantum physics.',
      ],
    };

    const start = Date.now();
    setTimeout(() => controller.abort(), 5000);

    const result = await runCli(
      config,
      { prompt: '', cwd: process.cwd(), signal: controller.signal },
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 60000, `Expected abort within 60s but took ${elapsed}ms`);
  });
});

// ───────────────────────────────────────
// Claude: real prompt → real answer
// ───────────────────────────────────────
describe('Claude Live Execution', function () {
  this.timeout(180000);

  before(function () {
    if (!hasClaude) {
      const reason = isInsideClaudeSession()
        ? 'Cannot run nested Claude sessions (CLAUDECODE env set)'
        : 'Claude CLI not installed';
      console.log(`    Skipping Claude live tests: ${reason}`);
      this.skip();
    }
  });

  it('should send a prompt and receive the correct answer', async () => {
    const config: CliConfig = {
      command: 'claude',
      buildArgs: () => [
        '-p',
        '--dangerously-skip-permissions',
        'What is the capital of France? Reply with ONLY the city name, one word, nothing else.',
      ],
    };

    const chunks: string[] = [];
    const result = await runCli(
      config,
      { prompt: '', cwd: process.cwd() },
      (chunk, stream) => { if (stream === 'stdout') { chunks.push(chunk); } },
    );

    assert.equal(result.exitCode, 0, `Claude exited with code ${result.exitCode}.\nstderr: ${result.stderr}`);
    assert.ok(chunks.length > 0, 'Should have received streaming chunks');

    const output = result.stdout.toUpperCase();
    assert.ok(output.includes('PARIS'), `Expected "PARIS" in output but got:\n${result.stdout}`);
    assert.ok(result.durationMs > 0);
  });

  it('should solve a math problem correctly', async () => {
    const config: CliConfig = {
      command: 'claude',
      buildArgs: () => [
        '-p',
        '--dangerously-skip-permissions',
        'What is 15 * 4? Reply with ONLY the number, nothing else.',
      ],
    };

    const result = await runCli(config, { prompt: '', cwd: process.cwd() });

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('60'), `Expected "60" in:\n${result.stdout}`);
  });

  it('should work with the full adapter pipeline (replicating ClaudeAdapter.buildArgs)', async () => {
    // Exact same logic as claude-adapter.ts buildArgs
    const extraArgs = ['-p'];
    const autoApprove = true;

    const config: CliConfig = {
      command: 'claude',
      buildArgs: (opts) => {
        const args = [...extraArgs];
        if (autoApprove && !args.includes('--dangerously-skip-permissions')) {
          args.push('--dangerously-skip-permissions');
        }
        args.push(opts.prompt);
        return args;
      },
    };

    const result = await runCli(
      config,
      { prompt: 'Reply with exactly: CLAUDE_PIPELINE_OK', cwd: process.cwd() },
    );

    assert.equal(result.exitCode, 0, `Pipeline failed. stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('CLAUDE_PIPELINE_OK'),
      `Expected CLAUDE_PIPELINE_OK in:\n${result.stdout}`,
    );
    assert.ok(result.command, 'Should have command string set');
  });

  it('should be cancellable via AbortSignal', async () => {
    const controller = new AbortController();
    const config: CliConfig = {
      command: 'claude',
      buildArgs: () => [
        '-p',
        '--dangerously-skip-permissions',
        'Write a very long 5000 word essay about quantum physics.',
      ],
    };

    const start = Date.now();
    setTimeout(() => controller.abort(), 5000);

    const result = await runCli(
      config,
      { prompt: '', cwd: process.cwd(), signal: controller.signal },
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 60000, `Expected abort within 60s but took ${elapsed}ms`);
  });
});

// ───────────────────────────────────────
// Side-by-side: same prompt to both
// ───────────────────────────────────────
describe('Claude vs Codex: same prompt, both validate', function () {
  this.timeout(180000);

  const prompt = 'What is 9 + 10? Reply with ONLY the number, nothing else.';

  (hasCodex ? it : it.skip)('Codex answers correctly', async () => {
    const config: CliConfig = {
      command: 'codex',
      buildArgs: () => ['exec', '--full-auto', '--ephemeral', prompt],
    };
    const result = await runCli(config, { prompt: '', cwd: process.cwd() });

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('19'), `Codex got wrong answer:\n${result.stdout}`);
  });

  (hasClaude ? it : it.skip)('Claude answers correctly', async () => {
    const config: CliConfig = {
      command: 'claude',
      buildArgs: () => ['-p', '--dangerously-skip-permissions', prompt],
    };
    const result = await runCli(config, { prompt: '', cwd: process.cwd() });

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('19'), `Claude got wrong answer:\n${result.stdout}`);
  });
});
