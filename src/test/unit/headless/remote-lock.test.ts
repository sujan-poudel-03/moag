// ─── Remote runs: single-instance lock ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DaemonLock, LOCK_FILE } from '../../../headless/remote-lock';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-lock-')));
}

describe('remote daemon lock', () => {
  it('one holder at a time; the second learns who holds it', () => {
    const dir = tmp();
    const a = new DaemonLock(dir, { pid: 101, isPidAlive: () => true, procStart: () => 'T1' });
    const b = new DaemonLock(dir, { pid: 202, isPidAlive: () => true, procStart: () => 'T1' });
    assert.deepEqual(a.acquire(), { ok: true });
    assert.deepEqual(b.acquire(), { ok: false, holderPid: 101 });
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'remote', LOCK_FILE), 'utf-8'));
    assert.equal(body.pid, 101);
    assert.match(body.token, /^[0-9a-f]{32}$/);
    assert.equal(body.proc_start, 'T1');
    if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(dir, 'remote', LOCK_FILE)).mode & 0o777, 0o600); }
  });

  it('a dead holder\'s lock is stale and taken over', () => {
    const dir = tmp();
    new DaemonLock(dir, { pid: 101, procStart: () => null }).acquire();
    const b = new DaemonLock(dir, { pid: 202, isPidAlive: (pid) => pid !== 101, procStart: () => null });
    assert.deepEqual(b.acquire(), { ok: true });
    assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf-8')).pid, 202);
  });

  it('a reused pid (a different process start time) is stale too', () => {
    const dir = tmp();
    new DaemonLock(dir, { pid: 101, procStart: () => 'OLD' }).acquire();
    const b = new DaemonLock(dir, { pid: 202, isPidAlive: () => true, procStart: (pid) => (pid === 101 ? 'NEW' : 'B') });
    assert.deepEqual(b.acquire(), { ok: true });
  });

  it('an unreadable lock file is taken over', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'remote', LOCK_FILE), '{garbage');
    assert.deepEqual(new DaemonLock(dir, { pid: 5, isPidAlive: () => true, procStart: () => null }).acquire(), { ok: true });
  });

  it('racing processes over a stale lock: always exactly one holder', async function () {
    this.timeout(300_000);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fork } = require('child_process');
    const scriptDir = tmp();
    const script = path.join(scriptDir, 'contender.js');
    const modulePath = path.join(__dirname, '..', '..', '..', 'headless', 'remote-lock.ts');
    fs.writeFileSync(script, [
      `require(${JSON.stringify(require.resolve('ts-node'))}).register({ transpileOnly: true });`,
      `const { DaemonLock } = require(${JSON.stringify(modulePath)});`,
      'process.on("message", (m) => {',
      '  if (m && m.go) {',
      '    let r;',
      '    try { r = new DaemonLock(m.dir).acquire(); } catch (e) { r = { ok: false, error: String(e) }; }',
      '    process.send({ ok: r.ok, error: r.error || null });',
      '  }',
      '});',
      'process.send({ ready: true });',
    ].join('\n'));
    const execArgv = ['--no-experimental-strip-types', '--no-experimental-detect-module'].filter((f) => process.allowedNodeEnvironmentFlags.has(f));
    const N = 6;
    const TRIALS = 40;
    type Contender = {
      send(m: unknown): void; on(e: string, f: (m: unknown) => void): void; kill(): void;
      stderr: { on(e: string, f: (c: Buffer) => void): void } | null;
    };
    let kids: Contender[];
    try {
      kids = Array.from({ length: N }, () => fork(script, [], { execArgv, cwd: path.join(__dirname, '..', '..', '..', '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }) as Contender);
    } catch (err) {
      if (err instanceof Error && /spawn EPERM/i.test(err.message)) { this.skip(); }
      throw err;
    }
    try {
      await Promise.all(kids.map((k) => new Promise<void>((resolve, reject) => {
        let err = '';
        k.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
        k.on('exit', () => reject(new Error(`a contender exited early: ${err.slice(-500)}`)));
        k.on('message', (m) => { if ((m as { ready?: boolean }).ready) { resolve(); } });
      })));
      for (let trial = 0; trial < TRIALS; trial++) {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, 'remote'), { recursive: true });
        // A stale lock: its holder pid does not exist.
        fs.writeFileSync(path.join(dir, 'remote', LOCK_FILE), JSON.stringify({ pid: 2147483646, token: 'dead', started_at: 'x', proc_start: null }));
        const results = await Promise.all(kids.map((k) => new Promise<{ ok: boolean; error: string | null }>((resolve) => {
          const onMsg = (m: unknown): void => {
            const r = m as { ok?: boolean; error?: string | null };
            if (typeof r.ok === 'boolean') { resolve({ ok: r.ok, error: r.error ?? null }); }
          };
          k.on('message', onMsg);
          k.send({ go: true, dir });
        })));
        assert.deepEqual(results.filter((r) => r.error), [], 'no contender errored');
        assert.equal(results.filter((r) => r.ok).length, 1, `trial ${trial}: exactly one holder`);
        const left = fs.readdirSync(path.join(dir, 'remote')).filter((n) => n !== LOCK_FILE);
        assert.deepEqual(left, [], `trial ${trial}: no temp, guard or tombstone left behind`);
        for (const k of kids) { (k as unknown as { removeAllListeners(e: string): void }).removeAllListeners('message'); }
      }
    } finally {
      for (const k of kids) { k.kill(); }
    }
  });

  it('release removes only the holder\'s own lock', () => {
    const dir = tmp();
    const a = new DaemonLock(dir, { pid: 101, isPidAlive: () => false, procStart: () => null });
    a.acquire();
    const b = new DaemonLock(dir, { pid: 202, isPidAlive: () => false, procStart: () => null });
    b.acquire(); // takes over: a's process is "dead"
    a.release(); // a no longer holds it: nothing happens
    assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf-8')).pid, 202);
    b.release();
    assert.ok(!fs.existsSync(b.file));
    assert.equal(b.held, false);
  });
});
