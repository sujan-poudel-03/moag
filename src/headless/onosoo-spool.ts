// ─── ONOSOO relay spool ───
//
// Every relayed event is appended here BEFORE the relay tries to send it, so a
// killed `moag run` loses nothing: the next relay-enabled run replays whatever
// the server never acknowledged, with the original run_id and seq.
//
// Layout (user-level, never under the workspace):
//
//   <stateDir>/onosoo-spool/<workspace hash>/
//     <run_id>.jsonl           first line {"meta":{v,run_id,pid,started_at[,proc_start]}}, then one event per line
//                              (proc_start: Linux only, the writer's /proc/<pid>/stat start time)
//     <run_id>.ack             {"acked":N} — highest seq the server acknowledged
//     <run_id>.rejected.jsonl  events the server refused (400 / single-event 413); never replayed
//
// A run's files are removed once every event is acked, and anything older than
// seven days is pruned. Directory 0700, files 0600. Imports nothing that loads
// `vscode`; never throws to its caller.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';
import { linuxProcStart } from './remote-lock';

/** One event as the relay sends it. */
export interface RelayEvent {
  run_id: string;
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface SpoolOptions {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  maxDirBytes?: number;
  /** Which ownership check applies (default process.platform). */
  platform?: NodeJS.Platform;
  /** A process's start marker (Linux: /proc/<pid>/stat starttime), null when unknown. */
  procStart?: (pid: number) => string | null;
}

export const SPOOL_VERSION = 1;
export const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SPOOL_MAX_DIR_BYTES = 100 * 1024 * 1024;
/**
 * Without a start-time match, a live pid owns a run file only while the file was written
 * within this long ago. A live relay touches it at most every minute (see touchRun).
 */
export const SPOOL_OWNER_MAX_IDLE_MS = 10 * 60 * 1000;

const RUN_FILE = /^(.+)\.jsonl$/;
const REJECTED_SUFFIX = '.rejected.jsonl';
/** How much of a run file is read at a time while replaying. */
const READ_BLOCK_BYTES = 1024 * 1024;

/**
 * How far replay has got through one earlier run's file. Owned by the caller of
 * {@link OnosooSpool.loadReplayable}, which advances it; pass the same map back for
 * the next chunk so nothing is read twice or skipped.
 */
export interface ReplayCursor {
  /** Highest seq returned so far (0 = none). */
  seq: number;
  /** Byte offset of the first line not yet considered. */
  offset: number;
  /** True once the whole file has been read: `seq` is the run's last unacked seq. */
  eof: boolean;
}

export interface ReplayOptions {
  /**
   * Stop before the events returned would exceed this many bytes (each counted as its
   * JSON text, as the relay counts its memory). Unlimited when absent.
   */
  budgetBytes?: number;
  /**
   * Per-run progress, advanced in place. A run with a cursor resumes at its offset and
   * only returns seq above its `seq`; a run whose cursor is not `eof` after the call
   * still has events on disk (the budget ran out, or the file could not be read to the
   * end). A cursor whose run file is gone (pruned, or removed by another process) is
   * deleted from the map.
   */
  cursors?: Map<string, ReplayCursor>;
  /**
   * An event larger than this can never be replayed: it is skipped (the cursor moves past
   * it) and handed to `onOversize`, instead of holding back every newer event.
   */
  maxEventBytes?: number;
  /** Told about each event skipped for `maxEventBytes`, with its size. Must not throw. */
  onOversize?: (ev: RelayEvent, bytes: number) => void;
}

/** One line of a file and the byte offset just past it (its newline included). */
interface FileLine {
  text: string;
  end: number;
}

/**
 * The lines of `file` from byte `offset`, read a block at a time so a large file is never
 * held whole. A last line with no newline is yielded too, ending at the file's size.
 */
function* readLinesFrom(file: string, offset: number): Generator<FileLine> {
  const fd = fs.openSync(file, 'r');
  try {
    const block = Buffer.alloc(READ_BLOCK_BYTES);
    let pending: Buffer = Buffer.alloc(0);
    let pos = offset;
    let lineStart = offset;
    for (;;) {
      const n = fs.readSync(fd, block, 0, block.length, pos);
      if (n <= 0) { break; }
      pos += n;
      let buf: Buffer = pending.length > 0 ? Buffer.concat([pending, block.subarray(0, n)]) : Buffer.from(block.subarray(0, n));
      let nl = buf.indexOf(0x0a);
      while (nl >= 0) {
        const end = lineStart + nl + 1;
        yield { text: buf.subarray(0, nl).toString('utf-8'), end };
        lineStart = end;
        buf = buf.subarray(nl + 1);
        nl = buf.indexOf(0x0a);
      }
      pending = buf;
    }
    if (pending.length > 0) { yield { text: pending.toString('utf-8'), end: lineStart + pending.length }; }
  } finally {
    fs.closeSync(fd);
  }
}

/** True when a process with `pid` exists (EPERM counts: it exists, it is just not ours). */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The spool directory name for a workspace: a hash of its real path, case-folded on Windows. */
export function workspaceKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  let real: string;
  try { real = fs.realpathSync(cwd); } catch { real = path.resolve(cwd); }
  if (platform === 'win32') { real = real.toLowerCase(); }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** Ordinal string comparison, for a stable sort. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A run id is used as a file name: allow only what a UUID or similar id contains. */
function safeRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(runId);
}

function isRelayEvent(v: unknown): v is RelayEvent {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { return false; }
  const e = v as Record<string, unknown>;
  return typeof e.run_id === 'string' && typeof e.seq === 'number' && Number.isInteger(e.seq) && e.seq > 0
    && typeof e.type === 'string' && typeof e.at === 'string'
    && !!e.data && typeof e.data === 'object' && !Array.isArray(e.data);
}

export class OnosooSpool {
  /** The workspace's spool directory. */
  readonly dir: string;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly maxDirBytes: number;
  private readonly platform: NodeJS.Platform;
  private readonly procStart: (pid: number) => string | null;
  private dirBytes: number | null = null;

  constructor(stateDir: string, cwd: string, opts: SpoolOptions = {}) {
    this.dir = path.join(stateDir, 'onosoo-spool', workspaceKey(cwd));
    this.now = opts.now ?? Date.now;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.maxDirBytes = opts.maxDirBytes ?? SPOOL_MAX_DIR_BYTES;
    this.platform = opts.platform ?? process.platform;
    this.procStart = opts.procStart ?? linuxProcStart;
  }

  private file(runId: string, suffix: string): string {
    return path.join(this.dir, `${runId}${suffix}`);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Bytes currently in the directory; computed once, then tracked. */
  private size(): number {
    if (this.dirBytes === null) {
      let total = 0;
      try {
        for (const name of fs.readdirSync(this.dir)) {
          try { total += fs.statSync(path.join(this.dir, name)).size; } catch { /* vanished */ }
        }
      } catch { /* no dir yet */ }
      this.dirBytes = total;
    }
    return this.dirBytes;
  }

  /** Append `text` to `file` unless the directory would exceed its cap. */
  private appendBounded(file: string, text: string): boolean {
    const bytes = Buffer.byteLength(text, 'utf-8');
    if (this.size() + bytes > this.maxDirBytes) { return false; }
    this.ensureDir();
    fs.appendFileSync(file, text, { encoding: 'utf-8', mode: 0o600 });
    this.dirBytes = this.size() + bytes;
    return true;
  }

  /** Start a run's file with its meta line. False when it could not be written. */
  openRun(runId: string): boolean {
    if (!safeRunId(runId)) { return false; }
    try {
      // proc_start tells this process from a later one that reuses its pid (Linux only;
      // elsewhere the file's mtime stands in — see ownedByLiveProcess).
      let procStart: string | null = null;
      if (this.platform === 'linux') { try { procStart = this.procStart(process.pid); } catch { procStart = null; } }
      const meta = {
        meta: {
          v: SPOOL_VERSION, run_id: runId, pid: process.pid, started_at: new Date(this.now()).toISOString(),
          ...(procStart !== null ? { proc_start: procStart } : {}),
        },
      };
      return this.appendBounded(this.file(runId, '.jsonl'), JSON.stringify(meta) + '\n');
    } catch {
      return false;
    }
  }

  /**
   * Mark a live run's file as written now, without changing it. The relay calls this
   * while a run is quiet, so another process can tell its owner is still alive. Never throws.
   */
  touchRun(runId: string): boolean {
    if (!safeRunId(runId)) { return false; }
    try {
      const t = new Date(this.now());
      fs.utimesSync(this.file(runId, '.jsonl'), t, t);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True when the process that wrote a run file's meta is still running it, so its events
   * must not be replayed by anyone else. A pid that is not alive, or is this process, never
   * owns. On Linux, when the meta has a proc_start and the pid's start time can be read,
   * they must match. Otherwise (other platforms, an older meta, an unreadable /proc) a
   * reused pid cannot be told apart, so ownership also needs a file written within
   * SPOOL_OWNER_MAX_IDLE_MS (however old the run is: a live relay keeps touching it).
   */
  private ownedByLiveProcess(meta: { pid?: unknown; proc_start?: unknown }, file: string): boolean {
    const pid = meta.pid;
    if (typeof pid !== 'number' || pid === process.pid || !this.isPidAlive(pid)) { return false; }
    if (this.platform === 'linux' && typeof meta.proc_start === 'string') {
      let now: string | null = null;
      try { now = this.procStart(pid); } catch { now = null; }
      if (now !== null) { return now === meta.proc_start; }
    }
    let mtime: number;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return false; }
    return this.now() - mtime <= SPOOL_OWNER_MAX_IDLE_MS;
  }

  /** Append one event to its run's file. False once the directory is over its cap, or on any error. */
  append(ev: RelayEvent): boolean {
    if (!safeRunId(ev.run_id)) { return false; }
    try {
      return this.appendBounded(this.file(ev.run_id, '.jsonl'), JSON.stringify(ev) + '\n');
    } catch {
      return false;
    }
  }

  /** The highest acked seq recorded for `runId` (0 when none). */
  readAck(runId: string): number {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file(runId, '.ack'), 'utf-8'));
      const n = (parsed as { acked?: unknown })?.acked;
      return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  /** Record that the server acked every seq ≤ `n` for `runId`. Never lowers the mark. */
  writeAck(runId: string, n: number): boolean {
    if (!safeRunId(runId) || !Number.isInteger(n) || n <= 0) { return false; }
    try {
      if (n <= this.readAck(runId)) { return true; }
      this.ensureDir();
      writeFileAtomicSync(this.file(runId, '.ack'), JSON.stringify({ acked: n }), 0o600);
      return true;
    } catch {
      return false;
    }
  }

  /** Path of a run's rejected-events file. */
  rejectedFile(runId: string): string {
    return this.file(runId, REJECTED_SUFFIX);
  }

  /** Keep events the server refused, for a human; they are never replayed. Never throws. */
  quarantine(events: readonly RelayEvent[], reason: string): boolean {
    let ok = true;
    for (const ev of events) {
      if (!safeRunId(ev.run_id)) { ok = false; continue; }
      try {
        const line = JSON.stringify({ rejected_at: new Date(this.now()).toISOString(), reason, event: ev }) + '\n';
        if (!this.appendBounded(this.rejectedFile(ev.run_id), line)) { ok = false; }
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /** Remove a run's event and ack files once everything up to `lastSeq` is acked. Keeps rejected events. */
  dropIfFullyAcked(runId: string, lastSeq: number): boolean {
    if (!safeRunId(runId)) { return false; }
    if (this.readAck(runId) < lastSeq) { return false; }
    try {
      fs.rmSync(this.file(runId, '.jsonl'), { force: true });
      fs.rmSync(this.file(runId, '.ack'), { force: true });
      this.dirBytes = null;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Unacked events of earlier runs, to resend: oldest run first (by its meta started_at),
   * each run in seq order, only seq > its ack. Prunes files older than seven days first;
   * skips `excludeRunId`, rejected files, runs still owned by another live process,
   * unknown spool versions and malformed lines. Runs with nothing left unacked are removed.
   *
   * With `budgetBytes` it stops before the events would exceed it, and `cursors` records
   * where each run stopped so the next call (same map) continues there — see ReplayOptions.
   * A run file is appended by one process in seq order, so a line whose seq is not above
   * the last one taken from that run is skipped (a duplicate, or out of order). An event
   * over `maxEventBytes` is skipped and reported through `onOversize`.
   */
  loadReplayable(excludeRunId: string | null, opts: ReplayOptions = {}): RelayEvent[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }

    const cutoff = this.now() - SPOOL_MAX_AGE_MS;
    const kept: string[] = [];
    for (const name of names) {
      const p = path.join(this.dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); continue; }
      } catch { continue; }
      kept.push(name);
    }
    this.dirBytes = null;

    const budget = opts.budgetBytes ?? Infinity;
    const maxEvent = opts.maxEventBytes ?? Infinity;
    const cursors = opts.cursors ?? new Map<string, ReplayCursor>();
    // A cursor whose run file is gone (pruned above, or removed by another process) is stale.
    const present = new Set(kept);
    for (const runId of [...cursors.keys()]) {
      if (!present.has(`${runId}.jsonl`)) { cursors.delete(runId); }
    }

    // The candidate runs, oldest first. A run this caller already started replaying keeps
    // its claim: its owner was judged gone when its first chunk was read.
    type Meta = { v?: unknown; run_id?: unknown; pid?: unknown; started_at?: unknown; proc_start?: unknown };
    const runs: Array<{ runId: string; file: string; started: string }> = [];
    for (const name of kept) {
      if (name.endsWith(REJECTED_SUFFIX)) { continue; }
      const m = RUN_FILE.exec(name);
      if (!m) { continue; }
      const runId = m[1];
      if (runId === excludeRunId || !safeRunId(runId)) { continue; }
      if (cursors.get(runId)?.eof) { continue; }
      const file = path.join(this.dir, name);
      let meta: Meta | null = null;
      try {
        for (const line of readLinesFrom(file, 0)) {
          try { meta = (JSON.parse(line.text) as { meta?: Meta } | null)?.meta ?? null; } catch { meta = null; }
          break;
        }
      } catch { continue; }
      if (!meta || meta.v !== SPOOL_VERSION || meta.run_id !== runId) { continue; }
      if (!cursors.has(runId) && this.ownedByLiveProcess(meta, file)) { continue; }
      runs.push({ runId, file, started: typeof meta.started_at === 'string' ? meta.started_at : '' });
    }
    runs.sort((a, b) => cmp(a.started, b.started) || cmp(a.runId, b.runId));

    const out: RelayEvent[] = [];
    let used = 0;
    for (const { runId, file } of runs) {
      const acked = this.readAck(runId);
      const known = cursors.get(runId);
      const cursor: ReplayCursor = known ? { ...known } : { seq: 0, offset: 0, eof: false };
      let lastSeq = cursor.seq;
      let full = false;
      let skipped = 0;
      let readFailed = false;
      try {
        let meta = cursor.offset === 0;
        for (const line of readLinesFrom(file, cursor.offset)) {
          if (meta) { meta = false; cursor.offset = line.end; continue; }
          let ev: unknown = null;
          if (line.text) { try { ev = JSON.parse(line.text); } catch { ev = null; } }
          if (!isRelayEvent(ev) || ev.run_id !== runId) { cursor.offset = line.end; continue; }
          lastSeq = Math.max(lastSeq, ev.seq);
          if (ev.seq <= acked || ev.seq <= cursor.seq) { cursor.offset = line.end; continue; }
          const bytes = Buffer.byteLength(JSON.stringify(ev), 'utf-8');
          if (bytes > maxEvent) {
            // Never replayable: move past it (its seq is not "taken", so the run's files can
            // still be dropped once the rest is acked) and let the caller say so.
            skipped++;
            cursor.offset = line.end;
            try { opts.onOversize?.(ev, bytes); } catch { /* the caller's problem */ }
            continue;
          }
          // Over budget: stop before this line, so the next call starts with it.
          if (used + bytes > budget) { full = true; break; }
          out.push(ev);
          used += bytes;
          cursor.seq = ev.seq;
          cursor.offset = line.end;
        }
      } catch {
        // A read error part-way: keep what was taken (the cursor stops after it, so nothing
        // is returned twice) and try the rest of this run on the next call.
        readFailed = true;
      }
      if (readFailed) {
        if (known || cursor.seq > 0 || skipped > 0) { cursors.set(runId, { ...cursor, eof: false }); }
        continue;
      }
      cursor.eof = !full;
      if (!known && cursor.seq === 0 && cursor.eof && skipped === 0) {
        // Nothing left unacked in this run: remove it rather than track it.
        this.dropIfFullyAcked(runId, lastSeq);
        continue;
      }
      cursors.set(runId, cursor);
      if (full) { break; }
    }
    return out;
  }
}
