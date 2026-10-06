// ─── Engine --version probe: resolves the same binary a run starts ───
//
// The probe used to call execFile without a shell. On Windows that finds only .exe/.com
// files, while runs spawn through cmd.exe, which resolves by PATH order and PATHEXT — so a
// claude.cmd shim earlier on PATH was what ran, and a claude.exe later on PATH was what
// the Engines screen, the engine-unavailable gate and the bench's fake-engine guard saw.

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { engineSpawnShape, isShellSafeCommand, probeVersion, runCli } from '../../../adapters/base-cli';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

/** Run `fn` with `process.platform` reading as `platform`. */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('engine spawn shape — the one rule runs and probes share', () => {
  it('goes through the shell on win32, with escaped arguments', () => {
    assert.deepEqual(engineSpawnShape(['-p', 'two words', '--x'], 'win32'), { args: ['-p', '"two words"', '--x'], shell: true });
    assert.deepEqual(engineSpawnShape(['--version'], 'win32'), { args: ['--version'], shell: true });
  });

  it('spawns directly elsewhere, arguments untouched', () => {
    for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
      assert.deepEqual(engineSpawnShape(['-p', 'two words'], platform), { args: ['-p', 'two words'], shell: false });
    }
  });

  it('only plain command names and paths may go on a shell line', () => {
    for (const ok of ['claude', 'claude.cmd', 'C:\\Users\\me\\.local\\bin\\claude.exe', '/usr/local/bin/codex', 'gemini-cli', 'my_tool.v2']) {
      assert.equal(isShellSafeCommand(ok), true, ok);
    }
    for (const bad of ['', 'claude & calc', 'claude|x', 'a>b', 'a<b', '%PATH%', 'a^b', '"claude"', 'C:\\Program Files\\x.exe', 'a(b)', 'a!b', 'x\ny', 'a;b', 'a'.repeat(261)]) {
      assert.equal(isShellSafeCommand(bad), false, JSON.stringify(bad));
    }
  });
});

// ─── probeVersion with a stubbed child_process ───

interface SpawnCall { command: string; args: string[]; opts: Record<string, unknown> }

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
}

function loadBaseCli(behave: (proc: FakeProc) => void): { mod: typeof import('../../../adapters/base-cli'); calls: SpawnCall[]; killed: FakeProc[] } {
  const calls: SpawnCall[] = [];
  const killed: FakeProc[] = [];
  const mod = proxyquire('../../../adapters/base-cli', {
    child_process: {
      spawn: (command: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ command, args, opts });
        const proc = new FakeProc();
        setImmediate(() => behave(proc));
        return proc;
      },
      execSync: () => '',
    },
    '../utils/process-kill': { killProcess: (p: FakeProc) => { killed.push(p); }, SPAWN_DETACHED: false },
    '../utils/child-tracker': { trackChildProcess: () => undefined },
  });
  return { mod, calls, killed };
}

describe('probeVersion — spawned exactly like a run', () => {
  const answer = (text: string, code = 0) => (proc: FakeProc): void => {
    proc.stdout.emit('data', Buffer.from(text));
    proc.emit('close', code);
  };

  it('on win32 it spawns through the shell, like runCli, and reports the first line', async () => {
    const probe = loadBaseCli(answer('2.1.0 (Claude Code)\r\nmore\r\n'));
    const version = await onPlatform('win32', () => probe.mod.probeVersion('claude'));
    assert.equal(version, '2.1.0 (Claude Code)');
    assert.equal(probe.calls.length, 1);
    assert.equal(probe.calls[0].command, 'claude');
    assert.deepEqual(probe.calls[0].args, ['--version']);
    assert.equal(probe.calls[0].opts.shell, true);
    assert.equal(probe.calls[0].opts.windowsHide, true);

    // A run of the same command on the same platform takes the same shape.
    const run = loadBaseCli(answer('ok'));
    await onPlatform('win32', () => run.mod.runCli({ command: 'claude', buildArgs: () => ['--version'] }, { prompt: '', cwd: '.' }));
    assert.equal(run.calls[0].command, probe.calls[0].command);
    assert.deepEqual(run.calls[0].args, probe.calls[0].args);
    assert.equal(run.calls[0].opts.shell, probe.calls[0].opts.shell);
  });

  it('elsewhere it spawns directly, like runCli', async () => {
    const probe = loadBaseCli(answer('0.9.1\n'));
    assert.equal(await onPlatform('linux', () => probe.mod.probeVersion('codex')), '0.9.1');
    assert.equal(probe.calls[0].opts.shell, false);
    const run = loadBaseCli(answer('ok'));
    await onPlatform('linux', () => run.mod.runCli({ command: 'codex', buildArgs: () => ['--version'] }, { prompt: '', cwd: '.' }));
    assert.equal(run.calls[0].opts.shell, false);
  });

  it('a command unfit for a shell line is never spawned on win32', async () => {
    const probe = loadBaseCli(answer('pwned'));
    assert.equal(await onPlatform('win32', () => probe.mod.probeVersion('claude & calc')), null);
    assert.equal(await onPlatform('win32', () => probe.mod.probeVersion('')), null);
    assert.equal(probe.calls.length, 0);
  });

  it('a non-zero exit reports no version', async () => {
    const probe = loadBaseCli(answer('Unknown option --version', 2));
    assert.equal(await onPlatform('linux', () => probe.mod.probeVersion('ollama')), null);
  });

  it('falls back to stderr when stdout is empty', async () => {
    const probe = loadBaseCli((proc) => { proc.stderr.emit('data', Buffer.from('gemini 1.2.3\n')); proc.emit('close', 0); });
    assert.equal(await onPlatform('linux', () => probe.mod.probeVersion('gemini')), 'gemini 1.2.3');
  });

  it('a spawn error reports no version', async () => {
    const probe = loadBaseCli((proc) => proc.emit('error', new Error('spawn ENOENT')));
    assert.equal(await onPlatform('linux', () => probe.mod.probeVersion('missing')), null);
  });

  it('a probe that hangs is killed at the timeout and reports no version', async () => {
    const probe = loadBaseCli(() => undefined);
    const started = Date.now();
    assert.equal(await onPlatform('linux', () => probe.mod.probeVersion('hangs', 50)), null);
    assert.ok(Date.now() - started < 2000);
    assert.equal(probe.killed.length, 1, 'the process tree is killed');
  });
});

// ─── Real resolution on Windows: a .cmd shim first on PATH, a .exe later ───

describe('probeVersion — Windows PATH resolution (real spawn)', function () {
  this.timeout(30_000);
  const NAME = 'moagprobeshim';
  let root = '';
  let savedPath: string | undefined;

  before(function () {
    if (process.platform !== 'win32') { this.skip(); }
  });

  afterEach(() => {
    if (savedPath !== undefined) { process.env.PATH = savedPath; savedPath = undefined; }
    if (root) { fs.rmSync(root, { recursive: true, force: true }); root = ''; }
  });

  it('reports the .cmd shim cmd.exe would run, not the .exe a shell-less lookup finds', async function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-probe-'));
    const shimDir = path.join(root, 'shim');
    const exeDir = path.join(root, 'exe');
    fs.mkdirSync(shimDir);
    fs.mkdirSync(exeDir);
    fs.writeFileSync(path.join(shimDir, `${NAME}.cmd`), '@echo off\r\necho 9.9.9-moag-shim\r\n');
    // Any .exe answers --version; node's own does, with its version.
    const exe = path.join(exeDir, `${NAME}.exe`);
    try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }

    savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${exeDir}${path.delimiter}${savedPath ?? ''}`;

    // The run: what cmd.exe actually starts for this command.
    let run;
    try {
      run = await runCli({ command: NAME, buildArgs: () => ['--version'] }, { prompt: '', cwd: root });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /9\.9\.9-moag-shim/, 'cmd.exe resolves the .cmd first on PATH');

    // The probe must agree with the run.
    const version = await probeVersion(NAME, 15_000);
    assert.equal(version, '9.9.9-moag-shim');
    assert.doesNotMatch(String(version), new RegExp(process.version.replace(/\./g, '\\.')), 'not the .exe later on PATH');
  });
});
