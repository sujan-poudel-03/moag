// ─── Worker survives a server crash (real processes; skips on spawn EPERM) ───
//
// A stand-in "server" process spawns a stand-in "worker" with the REAL
// `workerSpawnOptions` from main.ts, then the server is killed hard (no
// cleanup, like a crash). The worker must outlive it and receive `disconnect`
// — the signal the real worker turns into `runner.stop()`, which tree-kills the
// agent. Without `detached` on Windows, libuv's kill-on-close job object takes
// the worker down with the server and no disconnect handler ever runs.

import { strict as assert } from 'assert';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workerSpawnOptions } from '../../../server/main';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && (/spawn EPERM/i.test(err.message) || (err as NodeJS.ErrnoException).code === 'EPERM');
}

const WORKER_JS = `
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
fs.writeFileSync(path.join(dir, 'worker.pid'), String(process.pid));
process.on('disconnect', () => {
  fs.writeFileSync(path.join(dir, 'disconnected'), 'yes');
  setTimeout(() => process.exit(0), 50);
});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(1), 20000);
`;

const SERVER_JS = `
const { spawn } = require('child_process');
const opts = JSON.parse(process.argv[2]);
const workerJs = process.argv[3];
const dir = process.argv[4];
const child = spawn(process.execPath, [workerJs, dir], { ...opts, cwd: dir, env: process.env });
child.on('error', (e) => { process.stdout.write('ERR ' + e.message + '\\n'); });
child.stdout && child.stdout.on('data', () => {});
child.stderr && child.stderr.on('data', () => {});
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) { return false; }
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

describe('run worker spawn (real processes)', function () {
  this.timeout(30000);
  let dir: string;
  let server: ChildProcess | null = null;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-detach-')); });
  afterEach(() => {
    try { if (server?.pid && isAlive(server.pid)) { server.kill('SIGKILL'); } } catch { /* gone */ }
    const pidFile = path.join(dir, 'worker.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
      try { if (pid > 0 && isAlive(pid)) { process.kill(pid, 'SIGKILL'); } } catch { /* gone */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the dir briefly */ }
  });

  it('a hard-killed server leaves its worker running, and the worker receives disconnect', async function () {
    const workerJs = path.join(dir, 'worker.js');
    const serverJs = path.join(dir, 'server.js');
    fs.writeFileSync(workerJs, WORKER_JS);
    fs.writeFileSync(serverJs, SERVER_JS);
    // Only the process-shape options travel to the stand-in server (cwd/env are its own).
    const { stdio, detached, windowsHide, shell } = workerSpawnOptions({ jobPath: 'x', workspace: dir, env: {} });
    const opts = JSON.stringify({ stdio, detached, windowsHide, shell });

    let spawnError: unknown = null;
    try {
      server = spawn(process.execPath, [serverJs, opts, workerJs, dir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      server.on('error', (e) => { spawnError = e; });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    let serverOut = '';
    server.stdout?.on('data', (c) => { serverOut += String(c); });

    const pidFile = path.join(dir, 'worker.pid');
    const started = await waitFor(() => spawnError !== null || /ERR /.test(serverOut) || fs.existsSync(pidFile), 10000);
    if (isSpawnEperm(spawnError) || /EPERM/.test(serverOut)) { this.skip(); return; }
    assert.equal(spawnError, null, String(spawnError));
    assert.ok(started && fs.existsSync(pidFile), `worker never started: ${serverOut}`);
    await waitFor(() => fs.readFileSync(pidFile, 'utf-8').length > 0, 2000);
    const workerPid = Number(fs.readFileSync(pidFile, 'utf-8'));
    assert.ok(workerPid > 0);

    // Crash the server: no handlers run (TerminateProcess on Windows, SIGKILL on POSIX).
    const exited = new Promise<void>((r) => server!.once('exit', () => r()));
    server.kill('SIGKILL');
    await exited;

    const disconnected = await waitFor(() => fs.existsSync(path.join(dir, 'disconnected')), 10000);
    assert.ok(disconnected, 'the worker outlived the server and its disconnect handler ran (it would stop the runner)');
    // Having handled disconnect, the worker exits on its own.
    assert.ok(await waitFor(() => !isAlive(workerPid), 10000), 'the worker exits after handling disconnect');
  });
});
