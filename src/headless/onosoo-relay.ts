// ─── ONOSOO relay ───
//
// Mirrors a `moag run`'s JSONL events to ONOSOO so a build can be followed from
// the ONOSOO dashboard. The run itself never depends on it:
//
//   - record() is synchronous and never throws; nothing on the event path awaits
//     the network.
//   - Every event is spooled to disk (onosoo-spool.ts) BEFORE it is sent, and is
//     resent until the server acknowledges its seq — also by the next run, if
//     this one is killed.
//   - close() is bounded (CLOSE_DEADLINE_MS) and never rejects; every timer is
//     unref'd and cleared, so a pending backoff can never keep the process alive.
//   - Failures go to stderr, at most once per kind. Never to the JSONL stream.
//
// Wire format (protocol 1): POST <endpoint> with `Authorization: Bearer <key>`,
//   { protocol: 1, device_id, moag_version, events: [{ run_id, seq, type, at, data }] }
// plus `heartbeat: { active_runs: [run_id] }` (and `events: []`) when a live run
// has sent nothing for HEARTBEAT_MS. The reply `{ acked: { <run_id>: n } }`
// acknowledges every seq ≤ n of that run.
//
// Imports nothing that loads `vscode`.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import type { Redactor } from '../utils/redact';
import type { OnosooConfig } from './onosoo-config';
import type { OnosooSpool, RelayEvent, ReplayCursor } from './onosoo-spool';
import { registerLiveRelayRun, releaseLiveRelayRun } from './onosoo-spool';

// ─── Constants ───

export const MAX_EVENTS = 100;
export const MAX_BODY_BYTES = 262_144;
// ONOSOO's ingest answers in about 5 s for a small batch, longer from a cold start (measured 2026-10-21).
// A request that times out has often been stored anyway (the resend comes back as duplicates), so
// these leave room for a slow reply instead of giving up and resending.
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEARTBEAT_MS = 60_000;
export const CLOSE_DEADLINE_MS = 20_000;
export const BACKOFF_START_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;
/** In-memory queue ceiling; beyond it new events go to the spool only (replayed by the next run). */
export const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
/** Most of that a replayed backlog may take, so the live run keeps the rest as headroom. */
export const REPLAY_MEMORY_BYTES = MAX_MEMORY_BYTES / 2;
/** Largest serialized `data` of one event (ONOSOO's per-event cap is 96 KB); larger becomes a dropped marker. */
export const MAX_EVENT_DATA_BYTES = 90_000;
/** Events that never leave the machine: process ids, and raw agent output. */
export const NEVER_RELAYED: ReadonlySet<string> = new Set(['task-pid', 'task-output']);

/** Printed once when the server refuses the device key. */
export const REVOKED_MESSAGE = 'ONOSOO device key was revoked or is wrong — re-pair this machine in ONOSOO (Builds → Pair machine).';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUN_META_TASKS = 1000;
/**
 * How often a live run's spool file is touched; far inside SPOOL_OWNER_MAX_IDLE_MS (10 min).
 * 30 s, not 60: off Linux, ownership rests on the file's mtime alone, and after a sleep/resume
 * the timer can fire up to one interval late. The callback touches as soon as it runs, so the
 * stale window after a resume is at most one interval; halving the interval halves it.
 */
export const SPOOL_TOUCH_MS = 30_000;

// ─── HTTP ───

export interface RelayHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/** POSTs `body`; resolves the status and response text, rejects on network failure. */
export type RelayHttpClient = (req: RelayHttpRequest) => Promise<{ status: number; body: string }>;

/** Node http(s) client. Never follows redirects (a 3xx is a transient failure). */
export const defaultHttpClient: RelayHttpClient = (req) => new Promise((resolve, reject) => {
  let settled = false;
  const url = new URL(req.url);
  const mod = url.protocol === 'https:' ? https : http;
  const onAbort = (): void => { r.destroy(new Error('aborted')); };
  const done = (fn: () => void): void => {
    if (settled) { return; }
    settled = true;
    req.signal.removeEventListener('abort', onAbort);
    fn();
  };
  const r = mod.request(url, {
    method: 'POST',
    headers: { ...req.headers, 'Content-Length': String(Buffer.byteLength(req.body, 'utf-8')) },
    timeout: req.timeoutMs,
  }, (res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      if (size < MAX_RESPONSE_BYTES) { chunks.push(c); size += c.length; }
    });
    res.on('end', () => done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })));
    res.on('error', (err) => done(() => reject(err)));
  });
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', (err) => done(() => reject(err)));
  if (req.signal.aborted) { r.destroy(new Error('aborted')); } else { req.signal.addEventListener('abort', onAbort); }
  r.end(req.body);
});

/** The package version, from package.json two directories up (src/ or out/); '0.0.0' if unreadable. */
export function readMoagVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const v = (pkg as { version?: unknown })?.version;
    return typeof v === 'string' && v.length > 0 ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── Response classification ───

export type RelayOutcome =
  | { kind: 'ok'; acked: Record<string, number> }
  | { kind: 'rejected'; code: string; error: string }
  | { kind: 'revoked' }
  | { kind: 'too-large' }
  | { kind: 'rate-limited'; retryAfterMs: number | null }
  | { kind: 'transient'; reason: string };

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Map a response onto what the relay does next. Pure. */
export function classify(status: number, body: string): RelayOutcome {
  if (status >= 200 && status < 300) {
    const o = parseJson(body);
    const acked = o?.acked;
    if (!acked || typeof acked !== 'object' || Array.isArray(acked)) { return { kind: 'transient', reason: 'unreadable reply' }; }
    const out: Record<string, number> = {};
    for (const [run, n] of Object.entries(acked as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) { out[run] = n; }
    }
    return { kind: 'ok', acked: out };
  }
  if (status === 400) {
    const o = parseJson(body);
    return {
      kind: 'rejected',
      code: typeof o?.code === 'string' ? o.code : 'bad_request',
      error: typeof o?.error === 'string' ? o.error : '',
    };
  }
  if (status === 401 || status === 403) { return { kind: 'revoked' }; }
  if (status === 413) { return { kind: 'too-large' }; }
  if (status === 429) {
    const ra = parseJson(body)?.retry_after;
    return { kind: 'rate-limited', retryAfterMs: typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null };
  }
  if (status >= 300 && status < 400) { return { kind: 'transient', reason: `redirect (HTTP ${status}), not followed` }; }
  if (status >= 500) { return { kind: 'transient', reason: 'server error (HTTP 5xx)' }; }
  return { kind: 'transient', reason: `HTTP ${status}` };
}

// ─── Task status ───

/**
 * ONOSOO's protocol spells a task's final status capitalized (PROTOCOL.md: "Skipped",
 * "Blocked") and matches it exactly, while MOAG's stdout and the hosted server use the
 * lowercase TaskStatus values. Only the relay copy is mapped.
 */
const PROTOCOL_STATUS: Readonly<Record<string, string>> = {
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  blocked: 'Blocked',
};

/** A TaskStatus value in ONOSOO's spelling; anything unknown is returned unchanged. */
export function protocolStatus(status: string): string {
  return Object.prototype.hasOwnProperty.call(PROTOCOL_STATUS, status) ? PROTOCOL_STATUS[status] : status;
}

/**
 * Put a task-completed / task-failed event's `data.status` in ONOSOO's spelling, in place.
 * Applied once where an event is built: a live one in buildEvent, a replayed one as it is
 * loaded from the spool (lines an older MOAG wrote still say "completed"). Idempotent, so an
 * already-mapped status is left as it is.
 */
function applyProtocolStatus(type: string, data: Record<string, unknown>): void {
  if ((type === 'task-completed' || type === 'task-failed') && typeof data.status === 'string') {
    data.status = protocolStatus(data.status);
  }
}

// ─── Run meta ───

/** What `moag run` knows about the plan, for the relay-only `run-meta` event (seq 1). */
export interface RunMeta {
  plan_name: string;
  project: string;
  tasks: Array<{ id: string; name: string }>;
  /** The branch a remote run delivers to; absent or null for a run started by hand. */
  branch?: string | null;
}

/** True when `s` looks like a file-system path rather than a project name. */
function looksLikePath(s: string): boolean {
  return path.isAbsolute(s) || /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
}

/** Last segment of a path in either separator style, without a drive prefix. */
function baseName(s: string): string {
  const last = s.split(/[\\/]/).filter((p) => p.length > 0).pop() ?? '';
  return last.replace(/^[A-Za-z]:/, '');
}

// ─── Path scrubbing ───

const WIN_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function isAbsoluteAny(s: string): boolean {
  return path.posix.isAbsolute(s) || WIN_PATH.test(s);
}

/** True when `s` is the root of its file system (`/`, `C:\`, `\\server\share\`). */
function isRoot(s: string): boolean {
  const P = WIN_PATH.test(s) ? path.win32 : path.posix;
  const n = P.normalize(s);
  return P.parse(n).root === n;
}

/** `p` relative to `root` with forward slashes, or null when `p` is outside it. */
function relativeInside(p: string, root: string): string | null {
  const win = WIN_PATH.test(p) || WIN_PATH.test(root);
  const P = win ? path.win32 : path.posix;
  // path.win32.relative compares case-insensitively, as Windows does.
  const rel = P.relative(P.normalize(root), P.normalize(p));
  if (rel === '') { return '.'; }
  if (rel.startsWith('..') || P.isAbsolute(rel)) { return null; }
  return rel.split(/[\\/]/).join('/');
}

/** Replace every occurrence of the `prefix` directory (either slash style) in `text` with `replacement`. */
function replacePrefix(text: string, prefix: string, replacement: string): string {
  const win = WIN_PATH.test(prefix);
  const trimmed = prefix.replace(/[\\/]+$/, '');
  const variants = new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')]);
  let out = text;
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only at a path boundary: `/home/al` must not eat the start of `/home/alice`.
    out = out.replace(new RegExp(`${escaped}(?=[\\\\/]|$|[^A-Za-z0-9._-])`, win ? 'gi' : 'g'), replacement);
  }
  return out;
}

/**
 * Keep the machine's file-system layout off the wire. A string that is a single
 * absolute path becomes cwd-relative (forward slashes) when it is inside `cwd`,
 * else its basename. In any other string, the `cwd` prefix becomes `.` and the
 * home directory prefix `~`; the rest of the text is left alone. Pure.
 */
export function scrubPaths(s: string, cwd: string | null, home: string | null, otherHomes: readonly string[] = []): string {
  const whole = s.length > 0 && s.length <= 4096 && !/[\r\n\t]/.test(s) && isAbsoluteAny(s)
    // A posix "path" with spaces is more likely a message that starts with one.
    && (WIN_PATH.test(s) || !/\s/.test(s));
  if (whole) {
    const rel = cwd ? relativeInside(s, cwd) : null;
    return rel ?? baseName(s);
  }
  let out = s;
  if (cwd && !isRoot(cwd)) { out = replacePrefix(out, cwd, '.'); }
  if (home && !isRoot(home)) { out = replacePrefix(out, home, '~'); }
  // Other accounts' homes (the remote runner's): longest first, so a nested one wins.
  for (const h of [...otherHomes].sort((a, b) => b.length - a.length)) {
    if (h && !isRoot(h)) { out = replacePrefix(out, h, '~'); }
  }
  return out;
}

// ─── Relay ───

export interface OnosooRelayOptions {
  config: OnosooConfig;
  spool: OnosooSpool;
  http?: RelayHttpClient;
  redactor: Redactor;
  stderr?: (s: string) => void;
  now?: () => number;
  closeDeadlineMs?: number;
  /** The run's workspace: absolute paths inside it are sent relative to it. */
  cwd?: string;
  /** The user's home directory, shown as `~`. Defaults to os.homedir(). */
  homedir?: string;
  /** Use this run id (a daemon-started run's) instead of a fresh one; ignored unless it is a safe id. */
  runId?: string;
  /** Send heartbeats while the run is live (default true). The daemon's leftover-spool drain turns them off. */
  heartbeat?: boolean;
  /** More home directories to show as `~` (a remote run's runner account). */
  otherHomes?: string[];
  /**
   * Continue an earlier relay of the same run id: the first event recorded gets
   * seqStart + 1. Ignored unless a non-negative safe integer.
   */
  seqStart?: number;
}

/** Run ids the relay accepts from a caller: the same set the spool accepts as a file name. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface Queued {
  ev: RelayEvent;
  bytes: number;
}

type Next = 'continue' | 'stop' | { waitMs: number };

export class OnosooRelay {
  /** This run's id on the wire; fresh per relay. */
  readonly runId: string;
  private readonly heartbeatOn: boolean;

  private readonly config: OnosooConfig;
  private readonly spool: OnosooSpool;
  private readonly http: RelayHttpClient;
  private readonly redactor: Redactor;
  private readonly stderr: (s: string) => void;
  private readonly now: () => number;
  private readonly closeDeadlineMs: number;
  private readonly cwd: string | null;
  private readonly home: string | null;
  private readonly otherHomes: string[];
  private readonly version: string = readMoagVersion();
  private readonly envelopeBytes: number;

  private seq = 0;
  private queue: Queued[] = [];
  private memBytes = 0;
  private spoolOnly = false;
  /**
   * Last seq per replayed (earlier) run, so its files can be dropped once acked. Set only
   * once the run has been read to the end, so a partly loaded run is never dropped early.
   */
  private replayedLast = new Map<string, number>();
  /** Where replay stands in each earlier run's spool file; advanced by the spool. */
  private replayCursors = new Map<string, ReplayCursor>();
  /** True while earlier runs still have events on disk that did not fit in memory yet. */
  private replayPending = false;
  /** Touches this run's spool file every SPOOL_TOUCH_MS until close (see armTouch). */
  private touchTimer: ReturnType<typeof setTimeout> | null = null;

  private batchCap = MAX_EVENTS;
  private backoffMs = BACKOFF_START_MS;
  private rateLimitedUntil = 0;
  private disabled = false;
  private closed = false;

  private draining: Promise<void> | null = null;
  private kickQueued = false;
  private inFlight: AbortController | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reported = new Set<string>();

  constructor(opts: OnosooRelayOptions) {
    this.runId = typeof opts.runId === 'string' && RUN_ID_RE.test(opts.runId) ? opts.runId : randomUUID();
    this.heartbeatOn = opts.heartbeat !== false;
    this.config = opts.config;
    this.spool = opts.spool;
    this.http = opts.http ?? defaultHttpClient;
    this.redactor = opts.redactor;
    this.stderr = opts.stderr ?? ((s: string): void => { process.stderr.write(s); });
    this.now = opts.now ?? Date.now;
    this.closeDeadlineMs = opts.closeDeadlineMs ?? CLOSE_DEADLINE_MS;
    this.cwd = opts.cwd ? path.resolve(opts.cwd) : null;
    let home: string | null = opts.homedir ?? null;
    if (home === null) { try { home = os.homedir(); } catch { home = null; } }
    this.home = home || null;
    this.otherHomes = (opts.otherHomes ?? []).filter((h) => typeof h === 'string' && h.length > 1);
    if (typeof opts.seqStart === 'number' && Number.isSafeInteger(opts.seqStart) && opts.seqStart >= 0) {
      this.seq = opts.seqStart;
    }
    this.envelopeBytes = Buffer.byteLength(JSON.stringify(this.envelope([])), 'utf-8');
  }

  // ─── Public API ───

  /** The seq of the last event this relay recorded (seqStart before any). */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Begin the run: queue what earlier runs left unacknowledged, open this run's
   * spool file, record `run-meta` as seq 1 when given, and arm the heartbeat.
   */
  start(meta?: RunMeta): void {
    // Until close() resolves, no other relay in this process replays this run's spool.
    registerLiveRelayRun(this.runId);
    this.loadReplayChunk();
    try { this.spool.openRun(this.runId); } catch { /* sent from memory only */ }
    this.armTouch();
    if (meta) {
      try { this.enqueue(this.buildEvent('run-meta', new Date(this.now()).toISOString(), this.runMetaData(meta))); } catch { /* skip */ }
    }
    this.armHeartbeat();
    this.scheduleKick();
  }

  /** Relay one emitted JSONL line. Synchronous; never throws. */
  record(line: Record<string, unknown>): void {
    try {
      if (this.closed) { return; }
      const type = line.event;
      if (typeof type !== 'string' || NEVER_RELAYED.has(type)) { return; }
      const { event: _e, ts, ...rest } = line;
      void _e;
      const at = typeof ts === 'string' ? ts : new Date(this.now()).toISOString();
      this.enqueue(this.buildEvent(type, at, this.redactData(rest)));
      this.scheduleKick();
    } catch {
      // The relay must never disturb the run.
    }
  }

  /**
   * Flush what is left within the close deadline (one final attempt that ignores
   * any remaining backoff), then stop every timer. Never rejects.
   */
  async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    this.clearTouch();
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      this.clearHeartbeat();
      if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
      const work = (async (): Promise<void> => {
        if (this.draining) { await this.draining; }
        const rateLimited = this.rateLimitedUntil > this.now();
        if (!this.disabled && !rateLimited && this.queue.length > 0) {
          const final = this.drain();
          this.draining = final;
          await final;
        }
      })().catch(() => undefined);
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, this.closeDeadlineMs);
          deadline.unref?.();
        }),
      ]);
    } catch {
      // close() never rejects.
    } finally {
      if (deadline) { clearTimeout(deadline); }
      try { this.inFlight?.abort(); } catch { /* ignore */ }
      this.clearHeartbeat();
      if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
      try {
        this.spool.dropIfFullyAcked(this.runId, this.seq);
        for (const [run, last] of this.replayedLast) { this.spool.dropIfFullyAcked(run, last); }
      } catch { /* best effort */ }
      releaseLiveRelayRun(this.runId);
    }
  }

  // ─── Building events ───

  private envelope(events: RelayEvent[], heartbeat?: { active_runs: string[] }): Record<string, unknown> {
    return {
      protocol: 1,
      device_id: this.config.deviceId,
      moag_version: this.version,
      events,
      ...(heartbeat ? { heartbeat } : {}),
    };
  }

  /** Room one event may take in a body that carries only it. */
  private maxEventBytes(): number {
    return MAX_BODY_BYTES - this.envelopeBytes - 1;
  }

  private buildEvent(type: string, at: string, data: Record<string, unknown>): RelayEvent {
    applyProtocolStatus(type, data);
    const ev: RelayEvent = { run_id: this.runId, seq: ++this.seq, type, at, data };
    const dataBytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
    const bytes = Buffer.byteLength(JSON.stringify(ev), 'utf-8');
    if (dataBytes > MAX_EVENT_DATA_BYTES || bytes > this.maxEventBytes()) {
      ev.data = { dropped: 'event-too-large', bytes: dataBytes };
    }
    return ev;
  }

  /** One string as it may leave the machine: redacted, then path-scrubbed. Throws when redaction does. */
  private scrubString(s: string): string {
    return scrubPaths(this.redactor.redact(s).text, this.cwd, this.home, this.otherHomes);
  }

  /** Every string in `data`, at any depth, redacted; `{ redaction_failed: true }` when that fails. */
  private redactData(data: Record<string, unknown>): Record<string, unknown> {
    try {
      const out: unknown = JSON.parse(JSON.stringify(data), (_k, v: unknown) =>
        (typeof v === 'string' ? this.scrubString(v) : v));
      return out && typeof out === 'object' && !Array.isArray(out) ? out as Record<string, unknown> : {};
    } catch {
      return { redaction_failed: true };
    }
  }

  private runMetaData(meta: RunMeta): Record<string, unknown> {
    try {
      const r = (s: unknown, max: number): string => this.scrubString(String(s ?? '')).slice(0, max);
      // A path-like project is its folder name (a cwd-relative "." would say nothing); then scrubbed like any string.
      const rawProject = this.redactor.redact(String(meta.project ?? '')).text;
      const project = r(looksLikePath(rawProject) ? baseName(rawProject) : rawProject, 200);
      const all = Array.isArray(meta.tasks) ? meta.tasks : [];
      const tasks = all.slice(0, RUN_META_TASKS).map((t) => ({ id: r(t?.id, 100), name: r(t?.name, 200) }));
      const data: Record<string, unknown> = { plan_name: r(meta.plan_name, 200), project, tasks };
      if (typeof meta.branch === 'string' && meta.branch.length > 0) { data.branch = r(meta.branch, 255); }
      if (all.length > RUN_META_TASKS) { data.tasks_truncated = true; }

      // Keep the data within the per-event cap: drop tasks from the end until it fits.
      if (Buffer.byteLength(JSON.stringify(data), 'utf-8') > MAX_EVENT_DATA_BYTES) {
        let size = Buffer.byteLength(JSON.stringify({ ...data, tasks: [], tasks_truncated: true }), 'utf-8');
        const kept: Array<{ id: string; name: string }> = [];
        for (const t of tasks) {
          const add = Buffer.byteLength(JSON.stringify(t), 'utf-8') + (kept.length > 0 ? 1 : 0);
          if (size + add > MAX_EVENT_DATA_BYTES) { break; }
          size += add;
          kept.push(t);
        }
        data.tasks = kept;
        data.tasks_truncated = true;
      }
      return data;
    } catch {
      return { redaction_failed: true };
    }
  }

  // ─── Queue ───

  /**
   * Queue the next chunk of what earlier runs left unacknowledged, within REPLAY_MEMORY_BYTES
   * less what is already in memory (all of it at start), so the live run always keeps the
   * other half of MAX_MEMORY_BYTES. The spool's cursors carry on where the last chunk
   * stopped, so no event is loaded twice or skipped. Never throws.
   */
  private loadReplayChunk(): void {
    try {
      const budget = REPLAY_MEMORY_BYTES - this.memBytes;
      const events = budget > 0
        ? this.spool.loadReplayable(this.runId, {
          budgetBytes: budget,
          cursors: this.replayCursors,
          maxEventBytes: REPLAY_MEMORY_BYTES,
          onOversize: (ev, bytes) => this.skipOversized(ev, bytes),
        })
        : [];
      for (const ev of events) {
        // Earlier runs only (loadReplayable excludes this run), so no live event is mapped twice.
        try { applyProtocolStatus(ev.type, ev.data); } catch { /* send it as spooled */ }
        this.pushMemory(ev);
      }
      // A run read to the end (seq 0: everything left in it was skipped as too large) can be
      // dropped once its last returned seq is acked. Stale cursors were removed by the spool.
      for (const [run, c] of this.replayCursors) {
        if (c.eof) { this.replayedLast.set(run, c.seq); }
      }
      this.replayPending = [...this.replayCursors.values()].some((c) => !c.eof);
      if (this.replayPending && events.length === 0 && this.memBytes === 0) {
        // With all of the replay budget free nothing came back: the file could not be read.
        this.replayPending = false;
        this.note('replay-unreadable', 'ONOSOO relay: an earlier run\'s spool file could not be read; the rest of that backlog stays on disk for the next run.');
      }
    } catch {
      // A bad spool never stops the run.
      this.replayPending = false;
    }
  }

  /**
   * A spooled event of an earlier run too large for the replay budget (never one this relay
   * would write): kept in the run's rejected file for a human, one stderr line, never sent.
   */
  private skipOversized(ev: RelayEvent, bytes: number): void {
    try { this.spool.quarantine([ev], 'too_large'); } catch { /* best effort */ }
    this.note('replay-too-large', `ONOSOO relay: an earlier run's spooled event (${bytes} bytes) is too large to resend; it was skipped and kept in the run's rejected file.`);
  }

  /** Once every replayed event in memory is delivered, load the next chunk from disk. */
  private continueReplay(): void {
    if (!this.replayPending || this.disabled) { return; }
    if (this.queue.some((q) => q.ev.run_id !== this.runId)) { return; }
    this.loadReplayChunk();
  }

  private pushMemory(ev: RelayEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(ev), 'utf-8');
    this.queue.push({ ev, bytes });
    this.memBytes += bytes;
  }

  /** Spool first, then queue in memory (unless over the memory ceiling). */
  private enqueue(ev: RelayEvent): void {
    try { this.spool.append(ev); } catch { /* memory still has it */ }
    if (this.spoolOnly) { return; }
    this.pushMemory(ev);
    if (this.memBytes > MAX_MEMORY_BYTES) {
      this.spoolOnly = true;
      this.note('spool-only', 'ONOSOO relay: too many unsent events — the rest of this run is kept on disk and sent by the next run.');
    }
  }

  private removeAcked(acked: Record<string, number>, runs: Set<string>): number {
    let removed = 0;
    this.queue = this.queue.filter((q) => {
      const n = acked[q.ev.run_id];
      if (runs.has(q.ev.run_id) && typeof n === 'number' && q.ev.seq <= n) {
        this.memBytes -= q.bytes;
        removed++;
        return false;
      }
      return true;
    });
    return removed;
  }

  /**
   * The next batch within the count cap and the body cap: this run's undelivered events
   * first, then earlier runs' — each run's events ascending and contiguous, so a replayed
   * backlog can never hold the live run back.
   */
  private nextBatch(): RelayEvent[] {
    const batch: RelayEvent[] = [];
    let size = this.envelopeBytes;
    const ordered = [
      ...this.queue.filter((q) => q.ev.run_id === this.runId),
      ...this.queue.filter((q) => q.ev.run_id !== this.runId),
    ];
    for (const q of ordered) {
      if (batch.length >= this.batchCap) { break; }
      const add = q.bytes + (batch.length > 0 ? 1 : 0);
      if (batch.length > 0 && size + add > MAX_BODY_BYTES) { break; }
      batch.push(q.ev);
      size += add;
    }
    return batch;
  }

  // ─── Sending ───

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.key}`,
      'Content-Type': 'application/json',
      'User-Agent': `moag/${this.version}`,
    };
  }

  /**
   * Touch this run's spool file every SPOOL_TOUCH_MS for as long as the relay is open —
   * disabled (a 401) included, since the run still appends to the file. Another process
   * treats a live pid's run file as owned only while it was written recently
   * (onosoo-spool.ts ownedByLiveProcess), and a quiet run appends nothing. Its own timer,
   * unref'd and cleared in close(), independent of the HTTP heartbeat. Never throws.
   */
  private armTouch(): void {
    this.clearTouch();
    if (this.closed) { return; }
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      if (this.closed) { return; }
      try { this.spool.touchRun(this.runId); } catch { /* best effort */ }
      this.armTouch();
    }, SPOOL_TOUCH_MS);
    this.touchTimer.unref?.();
  }

  private clearTouch(): void {
    if (this.touchTimer) { clearTimeout(this.touchTimer); this.touchTimer = null; }
  }

  /** One POST, bounded by REQUEST_TIMEOUT_MS even if the client ignores its own timeout. */
  private async send(body: string): Promise<RelayOutcome> {
    this.armHeartbeat();
    const ac = new AbortController();
    this.inFlight = ac;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => { ac.abort(); resolve('timeout'); }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
      });
      const res = await Promise.race([
        Promise.resolve().then(() => this.http({ url: this.config.endpoint, headers: this.headers(), body, signal: ac.signal, timeoutMs: REQUEST_TIMEOUT_MS })),
        timedOut,
      ]);
      if (res === 'timeout') { return { kind: 'transient', reason: 'request timed out' }; }
      return classify(res.status, String(res.body ?? ''));
    } catch {
      return { kind: 'transient', reason: ac.signal.aborted ? 'request aborted' : 'network error' };
    } finally {
      if (timer) { clearTimeout(timer); }
      if (this.inFlight === ac) { this.inFlight = null; }
    }
  }

  /** Apply an outcome for `batch`; says whether to send again now, stop, or wait. */
  private apply(outcome: RelayOutcome, batch: RelayEvent[]): Next {
    switch (outcome.kind) {
      case 'ok':
        // A 2xx means the server received every event in the batch. Its `acked` is the
        // highest CONTIGUOUS seq it holds, which a gap (a quarantined batch, a spool
        // overflow, a re-paired device) holds back forever: it is information only and
        // never keeps a delivered event queued.
        this.markDelivered(batch);
        this.batchCap = MAX_EVENTS;
        this.backoffMs = BACKOFF_START_MS;
        return 'continue';
      case 'rejected':
        this.quarantine(batch, 'bad_request');
        this.note('rejected', `ONOSOO rejected a batch (${this.clean(outcome.code)}): ${this.clean(outcome.error)}`);
        return 'continue';
      case 'revoked':
        this.disabled = true;
        this.clearHeartbeat();
        this.note('revoked', REVOKED_MESSAGE);
        return 'stop';
      case 'too-large':
        if (batch.length > 1) {
          this.batchCap = Math.ceil(batch.length / 2);
          return 'continue';
        }
        this.quarantine(batch, 'too_large');
        this.note('rejected', 'ONOSOO rejected a batch (too_large): a single event was too large');
        return 'continue';
      case 'rate-limited': {
        const waitMs = Math.min(outcome.retryAfterMs ?? this.backoffMs, BACKOFF_MAX_MS);
        this.rateLimitedUntil = this.now() + waitMs;
        return { waitMs };
      }
      case 'transient':
        return this.transient(outcome.reason);
    }
  }

  private transient(reason: string): Next {
    this.note(`transient:${reason}`, `ONOSOO relay: ${reason}; events are kept and will be retried.`);
    const waitMs = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    return { waitMs };
  }

  /** Never resend `batch`: keep it in the rejected file, mark it acked, drop it from memory. */
  private quarantine(batch: RelayEvent[], reason: string): void {
    try { this.spool.quarantine(batch, reason); } catch { /* best effort */ }
    this.markDelivered(batch);
  }

  /**
   * Done with `batch`: record each run's highest seq in it as acked on disk, drop the
   * events from memory, and remove a replayed run's files once it is fully delivered.
   * Batches hold each run's lowest undelivered events contiguously, so "≤ max" is exact.
   */
  private markDelivered(batch: RelayEvent[]): void {
    const maxByRun: Record<string, number> = {};
    for (const e of batch) { maxByRun[e.run_id] = Math.max(maxByRun[e.run_id] ?? 0, e.seq); }
    for (const [run, n] of Object.entries(maxByRun)) {
      this.spool.writeAck(run, n);
      const last = this.replayedLast.get(run);
      if (last !== undefined && n >= last) { this.spool.dropIfFullyAcked(run, last); }
    }
    this.removeAcked(maxByRun, new Set(Object.keys(maxByRun)));
    this.continueReplay();
  }

  /** Send batches until the queue is empty or an outcome says to wait or stop. */
  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.disabled) {
      const batch = this.nextBatch();
      if (batch.length === 0) { return; }
      const body = JSON.stringify(this.envelope(batch));
      const next = this.apply(await this.send(body), batch);
      if (next === 'continue') { continue; }
      if (next === 'stop') { return; }
      // Closing: this was the final attempt; never arm a timer that outlives close().
      if (!this.closed) { this.armWait(next.waitMs); }
      return;
    }
  }

  private scheduleKick(): void {
    if (this.kickQueued) { return; }
    this.kickQueued = true;
    // A microtask: record() returns before anything is sent.
    void Promise.resolve().then(() => {
      this.kickQueued = false;
      this.kick();
    });
  }

  private kick(): void {
    if (this.closed || this.disabled || this.draining || this.waitTimer || this.queue.length === 0) { return; }
    this.draining = this.drain()
      .catch(() => undefined)
      .finally(() => {
        this.draining = null;
        if (!this.closed && this.queue.length > 0 && !this.waitTimer) { this.scheduleKick(); }
      });
  }

  private armWait(ms: number): void {
    if (this.waitTimer) { clearTimeout(this.waitTimer); }
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      this.kick();
    }, ms);
    this.waitTimer.unref?.();
  }

  // ─── Heartbeat ───

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** (Re)start the quiet-period timer; called on start and on every request. */
  private armHeartbeat(): void {
    this.clearHeartbeat();
    if (this.closed || this.disabled || !this.heartbeatOn) { return; }
    this.heartbeatTimer = setTimeout(() => this.onHeartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private onHeartbeat(): void {
    this.heartbeatTimer = null;
    if (this.closed || this.disabled) { return; }
    // Skipped only inside a 429 window (or while a request is in flight, which is itself
    // a sign of life). A 5xx backoff still heartbeats: ONOSOO marks a machine offline
    // after 3 minutes without one, and backoff alone can reach 5.
    if (this.draining || this.rateLimitedUntil > this.now()) {
      this.armHeartbeat();
      return;
    }
    const body = JSON.stringify(this.envelope([], { active_runs: [this.runId] }));
    this.draining = this.send(body)
      .then((outcome) => {
        if (outcome.kind === 'revoked') {
          this.disabled = true;
          this.clearHeartbeat();
          this.note('revoked', REVOKED_MESSAGE);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.draining = null;
        if (!this.closed && this.queue.length > 0 && !this.waitTimer) { this.scheduleKick(); }
      });
  }

  // ─── stderr ───

  /** One stderr line per distinct `kind` for the life of this relay. */
  private note(kind: string, message: string): void {
    if (this.reported.has(kind)) { return; }
    this.reported.add(kind);
    try { this.stderr(`${message}\n`); } catch { /* ignore */ }
  }

  /** Server-supplied text, made safe for one stderr line. */
  private clean(s: string): string {
    let text = [...String(s ?? '')].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').slice(0, 200);
    try { text = this.redactor.redact(text).text; } catch { text = '[unavailable]'; }
    return text;
  }
}
