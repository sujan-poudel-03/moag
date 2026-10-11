// ─── ONOSOO relay spool ───
//
// Every relayed event is appended here BEFORE the relay tries to send it, so a
// killed `moag run` loses nothing: the next relay-enabled run replays whatever
// the server never acknowledged, with the original run_id and seq.
//
// Layout (user-level, never under the workspace):
//
//   <stateDir>/onosoo-spool/<workspace hash>/
//     <run_id>.jsonl           first line {"meta":{v,run_id,pid,started_at}}, then one event per line
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
}

export const SPOOL_VERSION = 1;
export const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SPOOL_MAX_DIR_BYTES = 100 * 1024 * 1024;

const RUN_FILE = /^(.+)\.jsonl$/;
const REJECTED_SUFFIX = '.rejected.jsonl';

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
  private dirBytes: number | null = null;

  constructor(stateDir: string, cwd: string, opts: SpoolOptions = {}) {
    this.dir = path.join(stateDir, 'onosoo-spool', workspaceKey(cwd));
    this.now = opts.now ?? Date.now;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.maxDirBytes = opts.maxDirBytes ?? SPOOL_MAX_DIR_BYTES;
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
      const meta = { meta: { v: SPOOL_VERSION, run_id: runId, pid: process.pid, started_at: new Date(this.now()).toISOString() } };
      return this.appendBounded(this.file(runId, '.jsonl'), JSON.stringify(meta) + '\n');
    } catch {
      return false;
    }
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
   * Unacked events of earlier runs, to resend: per run in seq order, only seq > its ack.
   * Prunes files older than seven days first; skips `excludeRunId`, rejected files, runs
   * still owned by another live process, unknown spool versions and malformed lines.
   * Runs with nothing left unacked are removed.
   */
  loadReplayable(excludeRunId: string | null): RelayEvent[] {
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

    const out: RelayEvent[] = [];
    for (const name of kept.sort()) {
      if (name.endsWith(REJECTED_SUFFIX)) { continue; }
      const m = RUN_FILE.exec(name);
      if (!m) { continue; }
      const runId = m[1];
      if (runId === excludeRunId || !safeRunId(runId)) { continue; }
      let text: string;
      try { text = fs.readFileSync(path.join(this.dir, name), 'utf-8'); } catch { continue; }
      const lines = text.split('\n');
      type Meta = { v?: unknown; run_id?: unknown; pid?: unknown };
      let meta: Meta | null;
      try { meta = (JSON.parse(lines[0]) as { meta?: Meta } | null)?.meta ?? null; } catch { meta = null; }
      if (!meta || meta.v !== SPOOL_VERSION || meta.run_id !== runId) { continue; }
      if (typeof meta.pid === 'number' && meta.pid !== process.pid && this.isPidAlive(meta.pid)) { continue; }

      const acked = this.readAck(runId);
      const bySeq = new Map<number, RelayEvent>();
      let lastSeq = 0;
      for (const line of lines.slice(1)) {
        if (!line) { continue; }
        let ev: unknown;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!isRelayEvent(ev) || ev.run_id !== runId) { continue; }
        lastSeq = Math.max(lastSeq, ev.seq);
        if (ev.seq > acked && !bySeq.has(ev.seq)) { bySeq.set(ev.seq, ev); }
      }
      if (bySeq.size === 0) {
        this.dropIfFullyAcked(runId, lastSeq);
        continue;
      }
      out.push(...[...bySeq.values()].sort((a, b) => a.seq - b.seq));
    }
    return out;
  }
}
