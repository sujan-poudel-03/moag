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

// ─── Abort when the child never closes ───

describe('runCli abort when close never fires', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxyquire = require('proxyquire').noCallThru();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sinon = require('sinon');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter } = require('events');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PassThrough } = require('stream');

  type FakeChild = NodeJS.EventEmitter & { stdout: NodeJS.ReadWriteStream; stderr: NodeJS.ReadWriteStream; stdin: NodeJS.ReadWriteStream; pid: number };

  function load(): { run: typeof runCli; grace: number; child: FakeChild; killProcess: { callCount: number } } {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 4242;
    const killProcess = sinon.spy();
    const mod = proxyquire('../../../adapters/base-cli', {
      'child_process': { spawn: sinon.stub().returns(child), execSync: sinon.stub() },
      '../utils/process-kill': { killProcess, SPAWN_DETACHED: false },
      '../utils/child-tracker': { trackChildProcess: () => undefined },
    }) as { runCli: typeof runCli; ABORT_CLOSE_GRACE_MS: number };
    return { run: mod.runCli, grace: mod.ABORT_CLOSE_GRACE_MS, child, killProcess };
  }

  let clock: { tick(ms: number): void; tickAsync(ms: number): Promise<void>; restore(): void };
  beforeEach(() => { clock = sinon.useFakeTimers(); });
  afterEach(() => { clock.restore(); });

  it('resolves an aborted result after the grace period, removes the listener and ignores a late close', async () => {
    const { run, grace, child, killProcess } = load();
    const ac = new AbortController();
    const removeSpy = sinon.spy(ac.signal, 'removeEventListener');
    let settledCount = 0;
    const pending = run(
      { command: 'claude', buildArgs: () => ['-p'], useStdin: true },
      { prompt: 'p', cwd: process.cwd(), signal: ac.signal },
    ).then((r) => { settledCount++; return r; });
    child.stdout.write('partial');
    ac.abort();
    child.emit('exit', null, 'SIGTERM'); // an orphan keeps the pipe: no 'close'
    await clock.tickAsync(grace - 1);
    assert.equal(settledCount, 0, 'still waiting inside the grace period');
    await clock.tickAsync(1);
    const result = await pending;
    assert.equal(result.exitCode, 130);
    assert.match(result.stderr, /\[Command aborted\]$/);
    assert.equal(result.stdout, 'partial');
    assert.equal(killProcess.callCount, 1);
    assert.equal(removeSpy.callCount, 1, 'the abort listener is removed');
    // A late close neither resolves twice nor throws.
    child.emit('close', 0);
    await clock.tickAsync(grace);
    assert.equal(settledCount, 1);
  });

  it('a close inside the grace period resolves with the real code; the timer then does nothing', async () => {
    const { run, grace, child, killProcess } = load();
    const ac = new AbortController();
    let settledCount = 0;
    const pending = run(
      { command: 'claude', buildArgs: () => ['-p'], useStdin: true },
      { prompt: 'p', cwd: process.cwd(), signal: ac.signal },
    ).then((r) => { settledCount++; return r; });
    ac.abort();
    child.emit('close', 143);
    const result = await pending;
    assert.equal(result.exitCode, 143);
    assert.doesNotMatch(result.stderr, /Command aborted/);
    await clock.tickAsync(grace * 2);
    assert.equal(settledCount, 1);
    assert.equal(killProcess.callCount, 1);
  });

  it('an error after the abort rejects once and cancels the grace timer', async () => {
    const { run, grace, child } = load();
    const ac = new AbortController();
    const pending = run(
      { command: 'claude', buildArgs: () => ['-p'], useStdin: true },
      { prompt: 'p', cwd: process.cwd(), signal: ac.signal },
    );
    ac.abort();
    child.emit('error', new Error('boom'));
    await assert.rejects(pending, /Failed to start "claude": boom/);
    await clock.tickAsync(grace * 2); // no resolve-after-reject, no throw
  });
});
