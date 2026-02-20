import { strict as assert } from 'assert';
import { runCli, CliConfig } from '../../../adapters/base-cli';

describe('runCli', () => {
  it('should capture stdout', async () => {
    const config: CliConfig = {
      command: 'echo',
      buildArgs: () => ['hello world'],
    };
    const result = await runCli(config, {
      prompt: '',
      cwd: process.cwd(),
    });
    assert.ok(result.stdout.includes('hello'));
    assert.equal(result.exitCode, 0);
    assert.ok(result.durationMs >= 0);
  });

  it('should capture stderr and non-zero exit code', async () => {
    const config: CliConfig = {
      command: process.platform === 'win32' ? 'cmd' : 'sh',
      buildArgs: () =>
        process.platform === 'win32'
          ? ['/c', 'echo error 1>&2 && exit 1']
          : ['-c', 'echo error >&2; exit 1'],
    };
    const result = await runCli(config, {
      prompt: '',
      cwd: process.cwd(),
    });
    assert.ok(result.stderr.includes('error'));
    assert.equal(result.exitCode, 1);
  });

  it('should accumulate stdout from multiple chunks', async () => {
    const config: CliConfig = {
      command: process.platform === 'win32' ? 'cmd' : 'sh',
      buildArgs: () =>
        process.platform === 'win32'
          ? ['/c', 'echo line1 && echo line2']
          : ['-c', 'echo line1; echo line2'],
    };
    const result = await runCli(config, {
      prompt: '',
      cwd: process.cwd(),
    });
    assert.ok(result.stdout.includes('line1'));
    assert.ok(result.stdout.includes('line2'));
  });

  it('should kill process on abort signal', async () => {
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

    const result = await promise;
    // Process should have been killed — verify it didn't run for the full 30s
    assert.ok(result.durationMs < 25000, `Process took ${result.durationMs}ms, expected < 25000ms`);
  }).timeout(15000);

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
