// ─── Remote runs: single-instance lock ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DaemonLock, LOCK_FILE, parseTasklistImage, platformProcStart, WIN_START_PREFIX, windowsProcStart } from '../../../headless/remote-lock';

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

  it('Windows: a pid now running another program (svchost.exe for node.exe) is stale, whatever its start time', () => {
    const dir = tmp();
    new DaemonLock(dir, { pid: 3128, isPidAlive: () => true, procStart: () => null, ownImage: 'node.exe' }).acquire();
    const b = new DaemonLock(dir, {
      pid: 202, isPidAlive: () => true, procStart: () => null, ownImage: 'node.exe',
      procImage: (pid) => (pid === 3128 ? 'svchost.exe' : 'node.exe'),
    });
    assert.deepEqual(b.acquire(), { ok: true });
    assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf-8')).proc_image, 'node.exe');
  });

  it('Windows: the same program under that pid still holds the lock (names compare without case)', () => {
    const dir = tmp();
    new DaemonLock(dir, { pid: 101, isPidAlive: () => true, procStart: () => null, ownImage: 'node.exe' }).acquire();
    const b = new DaemonLock(dir, { pid: 202, isPidAlive: () => true, procStart: () => null, ownImage: 'node.exe', procImage: () => 'NODE.EXE' });
    assert.deepEqual(b.acquire(), { ok: false, holderPid: 101 });
  });

  it('Windows: when the program name cannot be read the holder is kept, never taken over on a guess', () => {
    const dir = tmp();
    new DaemonLock(dir, { pid: 101, isPidAlive: () => true, procStart: () => null, ownImage: 'node.exe' }).acquire();
    const b = new DaemonLock(dir, { pid: 202, isPidAlive: () => true, procStart: () => null, ownImage: 'node.exe', procImage: () => null });
    assert.deepEqual(b.acquire(), { ok: false, holderPid: 101 });
  });

  it('reads the program name from a tasklist line, and nothing from "no tasks"', () => {
    assert.equal(parseTasklistImage('"node.exe","1234","Console","1","50,000 K"\r\n'), 'node.exe');
    assert.equal(parseTasklistImage('INFO: No tasks are running which match the specified criteria.\r\n'), null);
    assert.equal(parseTasklistImage(''), null);
  });

  describe('Windows pid reuse', () => {
    const WROTE = new Date('2026-11-24T10:00:00.000Z');
    const at = (iso: string): string => `${WIN_START_PREFIX}${Date.parse(iso)}`;
    type Exec = typeof import('child_process').execFileSync;

    /** A lock written by pid 101 at WROTE, with the given proc_start (null: older MOAG on Windows). */
    function writtenLock(procStart: string | null): string {
      const dir = tmp();
      // ownImage null: these tests are about the start time, so no real tasklist lookup of pid 101.
      new DaemonLock(dir, { pid: 101, now: () => WROTE, procStart: () => procStart, ownImage: null }).acquire();
      return dir;
    }

    /** A second contender (pid 202) that sees pid 101 alive with start time `start101`. */
    function contender(dir: string, start101: string | null): DaemonLock {
      return new DaemonLock(dir, { pid: 202, isPidAlive: () => true, procStart: (pid) => (pid === 101 ? start101 : 'B') });
    }

    it('a recorded Windows start time that no longer matches is stale', () => {
      const dir = writtenLock(at('2026-11-24T09:59:59.000Z'));
      assert.deepEqual(contender(dir, at('2026-11-24T11:30:00.000Z')).acquire(), { ok: true });
    });

    it('a recorded Windows start time that matches is still held', () => {
      const start = at('2026-11-24T09:59:59.000Z');
      assert.deepEqual(contender(writtenLock(start), start).acquire(), { ok: false, holderPid: 101 });
    });

    it('a lock without a start time, whose pid now belongs to a process started later, is stale', () => {
      assert.deepEqual(contender(writtenLock(null), at('2026-11-24T10:05:00.000Z')).acquire(), { ok: true });
    });

    it('a lock without a start time, whose process started before it was written, is still held', () => {
      assert.deepEqual(contender(writtenLock(null), at('2026-11-24T09:58:00.000Z')).acquire(), { ok: false, holderPid: 101 });
    });

    it('a start time within the clock slack of the lock still counts as the writer', () => {
      assert.deepEqual(contender(writtenLock(null), at('2026-11-24T10:00:01.500Z')).acquire(), { ok: false, holderPid: 101 });
    });

    it('an unreadable start time trusts the pid, as before', () => {
      assert.deepEqual(contender(writtenLock(null), null).acquire(), { ok: false, holderPid: 101 });
    });

    it('windowsProcStart reads PowerShell\'s Unix ms and fails closed to null', () => {
      const calls: string[][] = [];
      const ok = ((_cmd: string, args: string[]) => { calls.push(args); return '1764000000123\r\n'; }) as unknown as Exec;
      assert.equal(windowsProcStart(4242, ok), `${WIN_START_PREFIX}1764000000123`);
      assert.match(calls[0][calls[0].length - 1], /Get-Process -Id 4242 /);
      const throws = (() => { throw new Error('Cannot find a process'); }) as unknown as Exec;
      assert.equal(windowsProcStart(4242, throws), null);
      assert.equal(windowsProcStart(4242, (() => 'not a number') as unknown as Exec), null);
      assert.equal(windowsProcStart(0, ok), null);
      assert.equal(windowsProcStart(1.5, ok), null);
      assert.equal(calls.length, 1, 'a bad pid never reaches PowerShell');
    });

    it('on Windows, this process\'s real start time is readable and in the past', function () {
      if (process.platform !== 'win32') { this.skip(); }
      this.timeout(30_000);
      const v = windowsProcStart(process.pid);
      if (v === null) { this.skip(); return; } // PowerShell unavailable on this machine
      const ms = Number(v.slice(WIN_START_PREFIX.length));
      assert.ok(ms <= Date.now() && ms > Date.now() - process.uptime() * 1000 - 60_000, v);
      assert.equal(platformProcStart(process.pid), v);
    });
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
    // Start times are left out (procStart null): this is about the file operations being atomic,
    // and on Windows each read would start PowerShell. Start-time logic has its own tests above.
    const scriptDir = tmp();
    const script = path.join(scriptDir, 'contender.js');
    const modulePath = path.join(__dirname, '..', '..', '..', 'headless', 'remote-lock.ts');
    fs.writeFileSync(script, [
      `require(${JSON.stringify(require.resolve('tsx/cjs/api'))}).register();`,
      `const { DaemonLock } = require(${JSON.stringify(modulePath)});`,
      'process.on("message", (m) => {',
      '  if (m && m.go) {',
      '    let r;',
      '    try { r = new DaemonLock(m.dir, { procStart: () => null }).acquire(); } catch (e) { r = { ok: false, error: String(e) }; }',
      '    process.send({ ok: r.ok, error: r.error || null });',
      '  }',
      '});',
      'process.send({ ready: true });',
    ].join('\n'));
    const N = 6;
    const TRIALS = 40;
    type Contender = {
      send(m: unknown): void; on(e: string, f: (m: unknown) => void): void; kill(): void;
      stderr: { on(e: string, f: (c: Buffer) => void): void } | null;
    };
    let kids: Contender[];
    try {
      kids = Array.from({ length: N }, () => fork(script, [], { execArgv: [], cwd: path.join(__dirname, '..', '..', '..', '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }) as Contender);
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
