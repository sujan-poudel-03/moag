// ─── Orphaned task processes die with a hard-killed worker (Windows; real processes) ───
//
// The reproduction for the bench run whose workspace kept being written after the
// bench was killed. A stand-in server spawns a stand-in worker with the REAL
// `workerSpawnOptions`; the worker starts an "agent" the way `runCli` does
// (`shell: true`), and the agent starts a background process through an
// intermediate that exits (`cmd /c start /b …`) — so that process has no living
// parent. The server is then hard-killed; the worker gets `disconnect` and does
// what the disconnect watchdog does (`taskkill /pid <self> /T /F`).
//
// `taskkill /T` walks parent pids, so it cannot find the parentless process: in
// the control case it survives (the defect). With the worker bound to a
// kill-on-close job object (the REAL `JOB_KILL_ON_CLOSE_SCRIPT`), it dies with
// the worker. Skips off Windows, on spawn EPERM, and where PowerShell cannot run
// the helper at all (missing, Constrained Language Mode, AppLocker). A helper that
// runs but reports a failed Win32 step FAILS the test: that is a defect in
// JOB_KILL_ON_CLOSE_SCRIPT, not an environment limit.

import { strict as assert } from 'assert';
import { spawn, execSync, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workerSpawnOptions } from '../../../server/main';
import { helperFailureReason, helperStderrText, jobHelperArgs, JOB_KILL_ON_CLOSE_SCRIPT } from '../../../utils/process-job';

/** A pid no real process has here; the worker swaps in its own. */
const PID_PLACEHOLDER = 987654321;

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && (/spawn EPERM/i.test(err.message) || (err as NodeJS.ErrnoException).code === 'EPERM');
}

const BG_JS = `
const fs = require('fs');
fs.writeFileSync('bg.pid', String(process.pid));
setInterval(() => { try { fs.writeFileSync('bg.beat', String(Date.now())); } catch {} }, 200);
setTimeout(() => process.exit(0), 55000);
`;

const AGENT_JS = `
const fs = require('fs');
const { spawn } = require('child_process');
// The intermediate cmd exits at once; bg is left with no living parent.
spawn('cmd', ['/c', 'start', '/b', 'node', 'bg.js'], { stdio: 'inherit', windowsHide: true });
fs.writeFileSync('agent.pid', String(process.pid));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 55000);
`;

const WORKER_JS = `
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, execSync } = require('child_process');
const dir = process.argv[2];
const mode = process.argv[3];
process.chdir(dir);
fs.writeFileSync('worker.pid', String(process.pid));
if (mode === 'job') {
  const template = fs.readFileSync('job-script.ps1.txt', 'utf-8');
  const script = template.split('Make(${PID_PLACEHOLDER})').join('Make(' + process.pid + ')');
  const ps = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let out;
  try {
    out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf-8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // Never e.message: it carries the whole -EncodedCommand line. The test decides
    // from code / status / stderr whether this is an environment limit or a bug.
    out = 'THROW ' + JSON.stringify({ code: e.code, status: e.status, signal: e.signal, stderr: String(e.stderr || '').slice(0, 20000) });
  }
  fs.writeFileSync('helper.txt', out);
  if (out !== 'ok') { process.exit(0); }
}
// runCli's shape: shell:true, piped stdio.
const g = spawn('node agent.js', { shell: true, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
g.stdout.on('data', () => {}); g.stderr.on('data', () => {});
process.on('message', () => {});
process.once('disconnect', () => {
  // What killOwnProcessTree does on Windows.
  try { execSync('taskkill /pid ' + process.pid + ' /T /F', { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch {}
  process.exit(2);
});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(1), 55000);
`;

const SERVER_JS = `
const { spawn } = require('child_process');
const opts = JSON.parse(process.argv[2]);
const workerJs = process.argv[3];
const dir = process.argv[4];
const mode = process.argv[5];
const child = spawn(process.execPath, [workerJs, dir, mode], { ...opts, cwd: dir, env: process.env });
child.on('error', (e) => { process.stdout.write('ERR ' + e.message + '\\n'); });
child.stdout && child.stdout.on('data', () => {});
child.stderr && child.stderr.on('data', () => {});
setInterval(() => {}, 1000);
`;

/** Failures that mean "this host cannot run the helper", not "the helper is wrong". */
const ENV_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);
const ENV_STDERR = /not supported in this language mode|CannotDefineNewType|ConstrainedLanguage|AppLocker|blocked by (?:group policy|your system administrator)|Software Restriction/i;

/**
 * What the helper's outcome means for the test. `ok` binds; a recognised
 * environment limit (no PowerShell, Constrained Language Mode, AppLocker) skips;
 * anything else — above all `<step> <win32 error>` from the script itself — fails,
 * so a broken struct layout, flag or access mask cannot turn CI green by skipping.
 */
function classifyHelperOutcome(text: string): { ok: true } | { skip: string } | { fail: string } {
  const out = text.trim();
  if (out === 'ok') { return { ok: true }; }
  if (/^(?:create|limits|open|dup|assign) \d+$/.test(out)) {
    return { fail: `the job helper script failed at a Win32 step: ${out}` };
  }
  if (out.startsWith('THROW ')) {
    let info: { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown };
    try { info = JSON.parse(out.slice(6)) as typeof info; } catch { return { fail: `unreadable helper failure: ${out.slice(0, 300)}` }; }
    const stderr = helperStderrText(info.stderr);
    if (typeof info.code === 'string' && ENV_SPAWN_CODES.has(info.code)) { return { skip: `PowerShell cannot be started here (${info.code})` }; }
    if (ENV_STDERR.test(stderr)) { return { skip: `PowerShell is restricted here: ${stderr}` }; }
    return { fail: `the job helper failed: ${helperFailureReason(info)}` };
  }
  return { fail: `unexpected job helper output: ${out.slice(0, 300)}` };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) { return false; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPid(dir: string, name: string): number {
  try { return Number(fs.readFileSync(path.join(dir, name), 'utf-8')) || 0; } catch { return 0; }
}

function readText(dir: string, name: string): string {
  try { return fs.readFileSync(path.join(dir, name), 'utf-8'); } catch { return ''; }
}

describe('classifyHelperOutcome (which helper failures may skip the real-process test)', () => {
  const thrown = (o: Record<string, unknown>): string => `THROW ${JSON.stringify(o)}`;

  it('ok binds', () => {
    assert.deepEqual(classifyHelperOutcome('ok'), { ok: true });
  });

  for (const out of ['limits 87', 'dup 5', 'assign 5', 'open 87', 'create 1450']) {
    it(`a failed Win32 step (${out}) fails, never skips`, () => {
      const v = classifyHelperOutcome(out);
      assert.ok('fail' in v, JSON.stringify(v));
      assert.ok(v.fail.includes(out));
    });
  }

  it('PowerShell missing or not startable skips', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
      assert.ok('skip' in classifyHelperOutcome(thrown({ code })), code);
    }
  });

  it('Constrained Language Mode (plain or CLIXML stderr) and AppLocker skip', () => {
    const clm = '#< CLIXML\r\n<Objs><S S="Error">Add-Type : Cannot add type. Definition of new types is not supported in this language _x000D__x000A_</S><S S="Error">mode._x000D__x000A_</S></Objs>';
    assert.ok('skip' in classifyHelperOutcome(thrown({ status: 1, stderr: clm })));
    assert.ok('skip' in classifyHelperOutcome(thrown({ status: 1, stderr: 'This program is blocked by group policy.' })));
    assert.ok('skip' in classifyHelperOutcome(thrown({ status: 1, stderr: 'blocked by AppLocker' })));
  });

  it('any other throw fails (a compile error in the script, a timeout)', () => {
    const compile = '#< CLIXML\r\n<Objs><S S="Error">Add-Type : c:\\t.cs(3) : ; expected_x000D__x000A_</S></Objs>';
    const v = classifyHelperOutcome(thrown({ status: 1, stderr: compile }));
    assert.ok('fail' in v, JSON.stringify(v));
    assert.ok(v.fail.includes('; expected'));
    assert.ok('fail' in classifyHelperOutcome(thrown({ code: 'ETIMEDOUT', signal: 'SIGTERM' })));
  });

  it('unexpected output fails', () => {
    assert.ok('fail' in classifyHelperOutcome('something else'));
    assert.ok('fail' in classifyHelperOutcome('THROW {not json'));
  });
});

const describeWin = process.platform === 'win32' ? describe : describe.skip;

describeWin('run worker hard kill reaches orphaned task processes (real processes, Windows)', function () {
  this.timeout(60000);
  let dir: string;
  let server: ChildProcess | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-orphan-'));
    fs.writeFileSync(path.join(dir, 'worker.js'), WORKER_JS);
    fs.writeFileSync(path.join(dir, 'server.js'), SERVER_JS);
    fs.writeFileSync(path.join(dir, 'agent.js'), AGENT_JS);
    fs.writeFileSync(path.join(dir, 'bg.js'), BG_JS);
    fs.writeFileSync(path.join(dir, 'job-script.ps1.txt'), JOB_KILL_ON_CLOSE_SCRIPT(PID_PLACEHOLDER));
  });

  afterEach(() => {
    try { if (server?.pid && isAlive(server.pid)) { server.kill('SIGKILL'); } } catch { /* gone */ }
    server = null;
    // Every recorded pid, even after a failure: nothing may outlive the test.
    for (const name of ['worker.pid', 'agent.pid', 'bg.pid']) {
      const pid = readPid(dir, name);
      if (pid > 0 && isAlive(pid)) {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
      }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the dir briefly */ }
  });

  /**
   * Start server → worker → agent → orphaned bg, and wait until bg is beating.
   * Returns `{ skip }` when the test should skip; fails on a broken helper.
   */
  async function startTree(mode: 'job' | 'none'): Promise<{ skip: string } | { worker: number; agent: number; bg: number }> {
    const { stdio, detached, windowsHide, shell } = workerSpawnOptions({ jobPath: 'x', workspace: dir, env: {} });
    const opts = JSON.stringify({ stdio, detached, windowsHide, shell });
    let spawnError: unknown = null;
    try {
      server = spawn(process.execPath, [path.join(dir, 'server.js'), opts, path.join(dir, 'worker.js'), dir, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      server.on('error', (e) => { spawnError = e; });
    } catch (err) {
      if (isSpawnEperm(err)) { return { skip: 'spawn EPERM' }; }
      throw err;
    }
    let serverOut = '';
    server.stdout?.on('data', (c) => { serverOut += String(c); });

    const helperFailed = (): boolean => mode === 'job' && readText(dir, 'helper.txt') !== '' && readText(dir, 'helper.txt') !== 'ok';
    await waitFor(() => spawnError !== null || /ERR /.test(serverOut) || helperFailed() || readPid(dir, 'bg.pid') > 0 && readText(dir, 'bg.beat') !== '', 30000);
    if (isSpawnEperm(spawnError) || /EPERM/.test(serverOut)) { return { skip: 'spawn EPERM' }; }
    if (helperFailed()) {
      const verdict = classifyHelperOutcome(readText(dir, 'helper.txt'));
      if ('skip' in verdict) { return verdict; }
      assert.fail('fail' in verdict ? verdict.fail : 'unexpected helper outcome');
    }
    assert.equal(spawnError, null, String(spawnError));
    const worker = readPid(dir, 'worker.pid');
    const agent = readPid(dir, 'agent.pid');
    const bg = readPid(dir, 'bg.pid');
    assert.ok(worker > 0 && agent > 0 && bg > 0, `tree never started (worker ${worker}, agent ${agent}, bg ${bg}): ${serverOut}`);
    return { worker, agent, bg };
  }

  async function crashServer(): Promise<void> {
    const exited = new Promise<void>((r) => server!.once('exit', () => r()));
    server!.kill('SIGKILL');
    await exited;
  }

  it('with the job object: worker, agent and the orphaned grandchild are all gone after a server hard kill', async function () {
    const tree = await startTree('job');
    if ('skip' in tree) { this.skip(); return; }
    await crashServer();

    const allGone = await waitFor(() => !isAlive(tree.worker) && !isAlive(tree.agent) && !isAlive(tree.bg), 15000);
    assert.ok(allGone, `still alive: worker ${isAlive(tree.worker)}, agent ${isAlive(tree.agent)}, bg ${isAlive(tree.bg)}`);
    const beat = readText(dir, 'bg.beat');
    await sleep(1000);
    assert.equal(readText(dir, 'bg.beat'), beat, 'the orphan stopped writing');
  });

  it('the real helper reports a failed Win32 step for a pid that does not exist, and that outcome fails (never skips)', function () {
    const ps = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let text: string;
    try {
      text = execFileSync(ps, jobHelperArgs(PID_PLACEHOLDER), { encoding: 'utf-8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { status?: number; signal?: string; stderr?: unknown };
      text = `THROW ${JSON.stringify({ code: err.code, status: err.status, signal: err.signal, stderr: String(err.stderr ?? '') })}`;
    }
    const verdict = classifyHelperOutcome(text);
    if ('skip' in verdict) { this.skip(); return; }
    assert.match(text, /^open \d+$/, `the script ran and stopped at OpenProcess: ${text.slice(0, 300)}`);
    assert.ok('fail' in verdict, 'a Win32 step failure is a defect, not an environment limit');
  });

  it('control: without the job object the orphan survives the watchdog\'s tree kill (the defect)', async function () {
    const tree = await startTree('none');
    if ('skip' in tree) { this.skip(); return; }
    try {
      await crashServer();
      assert.ok(await waitFor(() => !isAlive(tree.worker), 15000), 'the worker exits after its self tree kill');
      await sleep(5000);
      assert.ok(isAlive(tree.bg), 'taskkill /T cannot reach a process whose parent already exited');
      const beat = readText(dir, 'bg.beat');
      await sleep(1000);
      assert.notEqual(readText(dir, 'bg.beat'), beat, 'the orphan keeps writing');
    } finally {
      try { execSync(`taskkill /pid ${tree.bg} /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
    }
  });
});
