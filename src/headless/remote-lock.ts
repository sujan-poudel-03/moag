// ─── Remote runs: one command host per state directory ───
//
// Two daemons on one state dir would share the spend ledger, the single run slot and
// the at-most-once audit log, and each would treat the other's live run as left over
// from a crash (marking it interrupted, sweeping its processes). So the command host
// holds an exclusive lock: <stateDir>/remote/daemon.lock (0600)
//
//   { "pid": 1234, "token": "<random>", "started_at": "...", "proc_start": "<linux start time>",
//     "proc_image": "<windows program name>" }
//
// A lock whose process is gone — or whose pid now belongs to a different process
// (Linux: the recorded /proc start time no longer matches; Windows: the program name the pid
// belongs to is no longer the one that wrote the lock) — is stale and is taken over.
// The lock is released on close, only by the holder whose token it carries.
//
// Atomic, with no window where two takers both win:
//   - the lock is created by hard-linking a fully written temp file into place
//     (link fails when the lock exists, and the lock is never seen half-written);
//   - a stale lock is removed only under a short-lived takeover guard (itself created by
//     link, so one taker at a time), after re-reading it there; it is renamed to a unique
//     tombstone — only one rename finds the source — and the tombstone is checked to still
//     hold the stale content (a fresh lock moved by mistake is put back);
//   - after linking, the lock is read back and must carry our token.
// Imports nothing that loads `vscode`.

import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const LOCK_FILE = 'daemon.lock';
/** A takeover guard older than this belongs to a taker that died mid-takeover. */
const GUARD_STALE_MS = 10_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface LockBody {
  pid: number;
  token: string;
  started_at: string;
  proc_start: string | null;
  /** Windows: the program's file name (`node.exe`), so a pid reused by another program is seen as stale. */
  proc_image?: string | null;
}

export interface LockOptions {
  pid?: number;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  /** The process start time of `pid` (Linux: /proc/<pid>/stat field 22), or null when unknown. */
  procStart?: (pid: number) => string | null;
  /** The program file name running as `pid` (Windows: from `tasklist`), or null when unknown. */
  procImage?: (pid: number) => string | null;
  /** This process's own program file name, written to the lock; null where `procImage` cannot check it. */
  ownImage?: string | null;
}

export type LockOutcome = { ok: true } | { ok: false; holderPid: number };

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Linux process start time (clock ticks since boot), or null off Linux or when unreadable. */
export function linuxProcStart(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // The command name (field 2) is in parentheses and may contain spaces: count after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? null; // field 22 overall
  } catch {
    return null;
  }
}

/**
 * The program file name running as `pid` on Windows, or null off Windows or when it cannot be read.
 * `tasklist` needs no privileges and names every process, including protected system ones (a plain
 * `Get-Process` start time is refused for those), which is the case that matters: a pid left in the lock
 * is later reused by `svchost.exe`.
 */
export function windowsProcImage(pid: number): string | null {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) { return null; }
  try {
    // The system's own tasklist, by full path: nothing a PATH entry could shadow.
    const tasklist = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
    const out = execFileSync(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseTasklistImage(out);
  } catch {
    return null;
  }
}

/** The image name from one `tasklist /FO CSV /NH` line (`"node.exe","1234",...`), or null when there is none. */
export function parseTasklistImage(output: string): string | null {
  const line = output.split(/\r?\n/).find((l) => l.startsWith('"'));
  const match = line ? /^"([^"]+)"/.exec(line) : null;
  return match ? match[1] : null;
}

/** This process's program file name where `windowsProcImage` can check it later (Windows only). */
function defaultOwnImage(): string | null {
  return process.platform === 'win32' ? path.basename(process.execPath) : null;
}

export class DaemonLock {
  readonly file: string;
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly procStart: (pid: number) => string | null;
  private readonly procImage: (pid: number) => string | null;
  private readonly ownImage: string | null;
  private token: string | null = null;

  constructor(stateDir: string, opts: LockOptions = {}) {
    this.file = path.join(stateDir, 'remote', LOCK_FILE);
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? ((): Date => new Date());
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.procStart = opts.procStart ?? linuxProcStart;
    this.procImage = opts.procImage ?? windowsProcImage;
    this.ownImage = opts.ownImage === undefined ? defaultOwnImage() : opts.ownImage;
  }

  private readRaw(file: string = this.file): string | null {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
  }

  private parse(raw: string | null): LockBody | null {
    if (raw === null) { return null; }
    try {
      const v = JSON.parse(raw) as LockBody;
      return v && typeof v.pid === 'number' && typeof v.token === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  private read(): LockBody | null {
    return this.parse(this.readRaw());
  }

  /** True when `body`'s process is still the one that wrote it. */
  private holderAlive(body: LockBody): boolean {
    if (!this.isPidAlive(body.pid)) { return false; }
    if (body.proc_start) {
      const now = this.procStart(body.pid);
      if (now !== null && now !== body.proc_start) { return false; } // the pid was reused
    }
    if (body.proc_image) {
      const image = this.procImage(body.pid);
      // A different program now has the pid (Windows has no /proc start time): the holder is gone.
      if (image !== null && image.toLowerCase() !== body.proc_image.toLowerCase()) { return false; }
    }
    return true;
  }

  /** Take the lock, or report who holds it. A stale lock is taken over. Never throws for a held lock. */
  acquire(): LockOutcome {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const token = randomBytes(16).toString('hex');
    const body: LockBody = { pid: this.pid, token, started_at: this.now().toISOString(), proc_start: this.procStart(this.pid), proc_image: this.ownImage };
    const temp = `${this.file}.${this.pid}.${token}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          fs.linkSync(temp, this.file);
          const mine = this.read();
          if (mine && mine.token === token) {
            this.token = token;
            return { ok: true };
          }
          return { ok: false, holderPid: mine?.pid ?? -1 };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
        }
        const raw = this.readRaw();
        if (raw === null) { continue; } // released or moved meanwhile: try again
        const held = this.parse(raw);
        if (held && held.pid !== this.pid && this.holderAlive(held)) { return { ok: false, holderPid: held.pid }; }
        // Stale: remove it, one taker at a time.
        if (!this.takeOver(temp, raw, token, attempt)) { pause(5); }
      }
      const held = this.read();
      return { ok: false, holderPid: held?.pid ?? -1 };
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * Under the takeover guard, move the stale lock (still exactly `raw`) aside. False when
   * another taker holds the guard (the caller waits and retries).
   */
  private takeOver(temp: string, raw: string, token: string, attempt: number): boolean {
    const guard = `${this.file}.takeover`;
    try {
      fs.linkSync(temp, guard);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
      try {
        if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) { fs.rmSync(guard, { force: true }); }
      } catch { /* gone already */ }
      return false;
    }
    try {
      // Re-read under the guard: only a stale lock that is still the same one is removed.
      if (this.readRaw() !== raw) { return true; }
      const tomb = `${this.file}.stale.${token}.${attempt}`;
      try {
        fs.renameSync(this.file, tomb);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return true; }
        throw err;
      }
      if (this.readRaw(tomb) !== raw) {
        // Not the stale lock after all: put it back.
        try { fs.linkSync(tomb, this.file); } catch { /* someone holds it; the caller's loop sees them */ }
      }
      try { fs.rmSync(tomb, { force: true }); } catch { /* best effort */ }
      return true;
    } finally {
      // Remove the guard only while it is still ours (it is our temp file's other name).
      try { if (this.readRaw(guard) === this.readRaw(temp)) { fs.rmSync(guard, { force: true }); } } catch { /* best effort */ }
    }
  }

  /** Release the lock if this instance holds it. Never throws. */
  release(): void {
    if (!this.token) { return; }
    try {
      const held = this.read();
      if (held && held.token === this.token) { fs.rmSync(this.file, { force: true }); }
    } catch { /* best effort */ }
    this.token = null;
  }

  get held(): boolean {
    return this.token !== null;
  }
}
