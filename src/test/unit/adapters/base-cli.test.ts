import { strict as assert } from 'assert';
import { runCli, CliConfig } from '../../../adapters/base-cli';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

describe('runCli', () => {
  it('should capture stdout', async function () {
    const config: CliConfig = {
      command: 'echo',
      buildArgs: () => ['hello world'],
    };
    let result;
    try {
      result = await runCli(config, {
        prompt: '',
        cwd: process.cwd(),
      });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.ok(result.stdout.includes('hello'));
    assert.equal(result.exitCode, 0);
    assert.ok(result.durationMs >= 0);
  });

  it('should capture stderr and non-zero exit code', async function () {
    const config: CliConfig = {
      command: process.platform === 'win32' ? 'cmd' : 'sh',
      buildArgs: () =>
        process.platform === 'win32'
          ? ['/c', 'echo error 1>&2 && exit 1']
          : ['-c', 'echo error >&2; exit 1'],
    };
    let result;
    try {
      result = await runCli(config, {
        prompt: '',
        cwd: process.cwd(),
      });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.ok(result.stderr.includes('error'));
    assert.equal(result.exitCode, 1);
  });

  it('should accumulate stdout from multiple chunks', async function () {
    const config: CliConfig = {
      command: process.platform === 'win32' ? 'cmd' : 'sh',
      buildArgs: () =>
        process.platform === 'win32'
          ? ['/c', 'echo line1 && echo line2']
          : ['-c', 'echo line1; echo line2'],
    };
    let result;
    try {
      result = await runCli(config, {
        prompt: '',
        cwd: process.cwd(),
      });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.ok(result.stdout.includes('line1'));
    assert.ok(result.stdout.includes('line2'));
  });

  it('should kill process on abort signal', async function () {
    const controller = new AbortController();
    const config: CliConfig = {
      command: process.platform === 'win32' ? 'cmd' : 'sh',
      buildArgs: () =>
        process.platform === 'win32'
          ? ['/c', 'timeout /t 30 /nobreak >nul']
          : ['-c', 'sleep 30'],
    };

    const promise = runCli(config, {
      prompt: '',
      cwd: process.cwd(),
      signal: controller.signal,
    });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 500);

    let result;
    try {
      result = await promise;
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    // Process should have been killed — verify it didn't run for the full 30s
    assert.ok(result.durationMs < 25000, `Process took ${result.durationMs}ms, expected < 25000ms`);
  }).timeout(15000);

  it('should include all args in the displayed command when using stdin', async function () {
    const config: CliConfig = {
      command: process.execPath,
      buildArgs: () => ['-e', 'process.stdout.write("ok")', '--model', 'gpt-5.4'],
      useStdin: true,
    };

    let result;
    try {
      result = await runCli(config, {
        prompt: 'ignored',
        cwd: process.cwd(),
      });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }

    assert.ok(result.command?.includes('--model gpt-5.4'));
  });

  it('should reject when command does not exist', async () => {
    const config: CliConfig = {
      command: 'nonexistent_command_xyz_12345',
      buildArgs: () => [],
    };

    // On Windows with shell:true, a missing command may not reject but instead
    // return a non-zero exit code. Handle both cases.
    try {
      const result = await runCli(config, {
        prompt: '',
        cwd: process.cwd(),
      });
      assert.ok(result.exitCode !== 0);
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });
});

// ─── Already-aborted signal: never spawn ───

describe('runCli with an already-aborted signal', () => {
  it('resolves an aborted result without spawning (a late abort listener would never fire)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const proxyquire = require('proxyquire').noCallThru();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sinon = require('sinon');
    const spawn = sinon.stub().throws(new Error('spawn must not be called'));
    const execSync = sinon.stub();
    const { runCli: isolatedRunCli } = proxyquire('../../../adapters/base-cli', {
      'child_process': { spawn, execSync },
      '../utils/process-kill': { killProcess: sinon.stub(), SPAWN_DETACHED: false },
    }) as { runCli: typeof runCli };
    const ac = new AbortController();
    ac.abort();
    const chunks: string[] = [];
    const result = await isolatedRunCli(
      { command: 'claude', buildArgs: () => ['-p'], useStdin: true },
      { prompt: 'secret prompt', cwd: process.cwd(), signal: ac.signal },
      (c) => chunks.push(c),
    );
    assert.equal(spawn.callCount, 0);
    assert.equal(result.exitCode, 130);
    assert.match(result.stderr, /aborted/i);
    assert.equal(chunks.length, 0, 'no command header for a run that never started');
  });
});
