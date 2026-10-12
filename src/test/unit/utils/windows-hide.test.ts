import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

// ─── windowsHide on every child process the server worker can reach ───
//
// The server spawns its run worker detached. A detached process has no console,
// so on Windows every child it starts WITHOUT `windowsHide: true` pops a fresh
// console window: one per engine call, per gate command, per git probe and per
// taskkill. These tests pin the option on the paths that matter (engine spawn,
// tree kill) behaviourally under a simulated win32, and sweep the source of the
// worker-reachable layers so a new spawn site cannot quietly omit it.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

/** Run `fn` with `process.platform` reporting `platform`. */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, 'platform', real); }
}

/** A fake child that exits 0 on the next tick. */
function fakeChild(): EventEmitter & { pid: number; killed: boolean; stdout: EventEmitter; stderr: EventEmitter; stdin: { write(): void; end(): void; on(): void }; kill(): boolean } {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: () => undefined, end: () => undefined, on: () => undefined },
    kill: () => true,
  });
  setImmediate(() => child.emit('close', 0));
  return child;
}

describe('windowsHide on worker-reachable child processes', () => {
  it('runCli spawns the engine CLI with windowsHide on win32', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const execSyncCalls: string[] = [];
    const childProcess = {
      spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => { seen.push(opts); return fakeChild(); },
      execSync: (cmd: string) => { execSyncCalls.push(cmd); return ''; },
    };
    await onPlatform('win32', async () => {
      const processKill = proxyquire('../../../utils/process-kill', { child_process: childProcess });
      const { runCli } = proxyquire('../../../adapters/base-cli', { child_process: childProcess, '../utils/process-kill': processKill });
      const result = await runCli({ command: 'claude', buildArgs: () => ['-p'], useStdin: true }, { prompt: 'hi', cwd: process.cwd() });
      assert.equal(result.exitCode, 0);
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].windowsHide, true);
    assert.equal(seen[0].shell, true, 'the win32 path (shell: true) is the one exercised');
  });

  it('runCli still hides the window when the spawn is aborted mid-run (taskkill path)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const execSyncOpts: Array<Record<string, unknown>> = [];
    let spawned: EventEmitter | null = null;
    const childProcess = {
      spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
        seen.push(opts);
        const child = Object.assign(new EventEmitter(), {
          pid: 777, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter(),
          stdin: { write: () => undefined, end: () => undefined, on: () => undefined },
          kill: () => true,
        });
        spawned = child;
        return child;
      },
      execSync: (_cmd: string, opts: Record<string, unknown>) => { execSyncOpts.push(opts); return ''; },
    };
    const controller = new AbortController();
    await onPlatform('win32', async () => {
      const processKill = proxyquire('../../../utils/process-kill', { child_process: childProcess });
      const { runCli } = proxyquire('../../../adapters/base-cli', { child_process: childProcess, '../utils/process-kill': processKill });
      const pending = runCli({ command: 'claude', buildArgs: () => [], useStdin: true }, { prompt: 'x', cwd: process.cwd(), signal: controller.signal });
      controller.abort();
      // The fake child never closes on its own: the kill path is what we assert,
      // then the child "dies" so the run settles instead of dangling.
      await new Promise((r) => setImmediate(r));
      assert.ok(execSyncOpts.length >= 1, 'abort ran taskkill');
      spawned!.emit('close', 1);
      await pending;
    });
    assert.equal(seen[0].windowsHide, true);
    for (const o of execSyncOpts) { assert.equal(o.windowsHide, true, 'taskkill is hidden too'); }
  });

  it('killProcess runs taskkill with windowsHide on win32', async () => {
    const calls: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
    await onPlatform('win32', () => {
      const { killProcess } = proxyquire('../../../utils/process-kill', {
        child_process: { execSync: (cmd: string, opts: Record<string, unknown>) => { calls.push({ cmd, opts }); return ''; }, spawn: () => { throw new Error('unused'); } },
      });
      killProcess({ pid: 99, killed: false, kill: () => true });
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].cmd, /^taskkill \/pid 99 \/T \/F$/);
    assert.equal(calls[0].opts.windowsHide, true);
  });

  it('killOwnProcessTree default runner hides its taskkill window', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await onPlatform('win32', () => {
      const { killOwnProcessTree } = proxyquire('../../../utils/process-kill', {
        child_process: { execSync: (_cmd: string, opts: Record<string, unknown>) => { calls.push(opts); return ''; }, spawn: () => { throw new Error('unused'); } },
      });
      killOwnProcessTree(12345);
    });
    assert.ok(calls.length >= 1);
    for (const o of calls) { assert.equal(o.windowsHide, true); }
  });

  it('commandExists probes with windowsHide', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await onPlatform('win32', async () => {
      const { commandExists } = proxyquire('../../../utils/command-exists', {
        child_process: {
          execFile: (_c: string, _a: string[], opts: Record<string, unknown>, cb: (e: Error | null) => void) => { seen.push(opts); cb(null); },
          execSync: () => '',
        },
      });
      assert.equal(await commandExists('git'), true);
    });
    assert.equal(seen[0].windowsHide, true);
  });

  // ─── Source sweep ───

  /** Directories whose code runs inside the server or its detached worker. */
  const WORKER_REACHABLE = ['adapters', 'runner', 'utils', 'headless', 'sandbox', 'server', 'context', 'history', 'routing'];
  const SPAWN_CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|execSync)\(/g;

  /** Return the text of the call starting at `start` up to its matching close paren. */
  function callText(src: string, start: number): string {
    let depth = 0;
    for (let i = src.indexOf('(', start); i < src.length; i++) {
      if (src[i] === '(') { depth++; }
      else if (src[i] === ')') { depth--; if (depth === 0) { return src.slice(start, i + 1); } }
    }
    return src.slice(start);
  }

  function listTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { out.push(...listTs(p)); }
      else if (e.name.endsWith('.ts')) { out.push(p); }
    }
    return out;
  }

  it('every spawn/exec call in worker-reachable layers passes windowsHide', () => {
    const srcRoot = path.resolve(__dirname, '../../..');
    const missing: string[] = [];
    let checked = 0;
    for (const sub of WORKER_REACHABLE) {
      const dir = path.join(srcRoot, sub);
      if (!fs.existsSync(dir)) { continue; }
      for (const file of listTs(dir)) {
        const src = fs.readFileSync(file, 'utf-8');
        for (const m of src.matchAll(SPAWN_CALL)) {
          const lineStart = src.lastIndexOf('\n', m.index!) + 1;
          const line = src.slice(lineStart, src.indexOf('\n', m.index!));
          if (/^\s*(\/\/|\*)/.test(line) || /\bfunction\s+$/.test(src.slice(lineStart, m.index!))) { continue; }
          const call = callText(src, m.index!);
          checked++;
          // workerSpawnOptions() builds the options in one place; pinned by worker-detach.test.ts.
          if (call.includes('windowsHide') || call.includes('workerSpawnOptions(')) { continue; }
          const lineNo = src.slice(0, m.index!).split('\n').length;
          missing.push(`${path.relative(srcRoot, file)}:${lineNo} ${line.trim()}`);
        }
      }
    }
    assert.ok(checked > 15, `the sweep found the spawn sites (${checked})`);
    assert.deepEqual(missing, [], `child processes without windowsHide:\n${missing.join('\n')}`);
  });
});
