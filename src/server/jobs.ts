// ─── Job manager ───
//
// Owns every worker child process. One job per project (in memory + a `job.lock`
// file opened with `wx`), a server-wide concurrency cap, line-framed JSONL
// parsing with a per-line cap, an stderr tail, secret redaction in error tails,
// cooperative stop (IPC) with a hard-kill fallback, and SSE fan-out. Every
// listener and timer is released on both `close` and `error`.
//
// The lock file names the WORKER, not just the server: `{serverPid, workerPid,
// workerPgid?}`. A server crash leaves the worker (and the agent it supervises)
// running; while that worker — or, on POSIX, its process group — is alive the
// lock is held, so a restarted server cannot admit a second job into the same
// workspace. The worker notices the lost IPC channel, stops its runner (which
// tree-kills the running task) and exits; the lock is reclaimed after that.
// Workers are spawned detached on every platform (main.ts), so on Windows a
// server crash no longer hard-kills the worker out from under its agent. A lock
// may also list `taskPids` (agent processes); while any of them is alive the
// lock is held even if the worker itself is gone.
//
// The same rule holds while THIS server is up: when a job ends with recorded
// task pids still alive (a tree-kill that missed a grandchild, an agent that
// ignored its signal), the lock is NOT released. It is rewritten to name only
// the live task pids and re-checked every `TASK_PID_LINGER_POLL_MS`, and is
// released once they are all gone. After `TASK_PID_LINGER_MAX_MS` the watch
// gives up but KEEPS the lock: an admin can force-release it
// (`forceReleaseLock`, an audited route) after confirming or killing the
// processes, or `acquireLock` reclaims it lazily once they die.

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { writeFileAtomicSync } from '../utils/file-io';
import {
  WorkerEvent, WorkerJob, RunView, emptyRunView, foldRunEvent, parseWorkerLine, exitToRunStatus, ExitRunStatus,
} from './worker-protocol';
import { RunsDisabledReason } from './config';
import { TaskStatus } from '../models/types';

export const MAX_LINE_BYTES = 1024 * 1024;
export const STDERR_TAIL_BYTES = 64 * 1024;
export const STOP_KILL_AFTER_MS = 30_000;
export const LOCK_FILE = 'job.lock';
/** How often a boot-time watch re-checks a job.lock still held by a predecessor's worker. */
export const HELD_LOCK_POLL_MS = 5_000;
/** How often a finished job's lock is re-checked while its recorded task pids are alive. */
export const TASK_PID_LINGER_POLL_MS = 1_000;
/** How long that re-check runs before it stops and leaves the lock for an admin to force-release. */
export const TASK_PID_LINGER_MAX_MS = 5 * 60_000;

/** The slice of ChildProcess the manager uses (fakeable in tests). */
export interface WorkerProcess extends EventEmitter {
  pid?: number;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  send?(message: unknown): boolean;
  connected?: boolean;
}

export interface SpawnSpec {
  jobPath: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

export type JobKind = WorkerJob['kind'];
export type JobEndStatus = ExitRunStatus | 'stopped';

export interface JobEnd {
  jobId: string;
  projectId: string;
  kind: JobKind;
  exitCode: number | null;
  status: JobEndStatus;
  view: RunView;
  /** stderr tail with injected secrets redacted. */
  stderrTail: string;
  spawnError?: string;
}

export interface TaskOutcome {
  projectId: string;
  jobId: string;
  taskId: string;
  status: 'completed' | 'failed';
  engine: string | null;
}

export type JobNotice =
  | { type: 'event'; jobId: string; event: WorkerEvent }
  | { type: 'end'; end: JobEnd };

export interface StartJobInput {
  projectId: string;
  job: WorkerJob;
  /** Where the job document is written (inside the data dir). */
  jobPath: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  /** Secret values that must never appear in error tails / stderr. */
  redact?: string[];
  /** Spend bucket key (PRD version `createdAt`) for `cost` events. */
  spendKey?: string;
  onEvent?: (ev: WorkerEvent) => void;
  onEnd?: (end: JobEnd) => void;
}

export type StartResult =
  | { ok: true; jobId: string; workerPid?: number }
  | { ok: false; status: 409 | 429; reason: 'runs-disabled' | 'job-active' | 'project-locked' | 'too-many-jobs' | 'spawn-failed'; message: string };

export interface JobManagerOptions {
  dataDir: string;
  spawnWorker: (spec: SpawnSpec) => WorkerProcess;
  maxConcurrent: number;
  runsDisabledReason: RunsDisabledReason;
  killProcess: (proc: WorkerProcess) => void;
  now?: () => number;
  /** Add `usd` to the project's spend for `spendKey`. */
  recordSpend?: (projectId: string, spendKey: string, usd: number) => void;
  /** Consumed by the outcome store (stack evidence). */
  onTaskOutcome?: (o: TaskOutcome) => void;
  /**
   * Liveness probe for a pid found in a lock file. A NEGATIVE argument asks
   * about the process group `-pid` (the default uses `process.kill(pid, 0)`,
   * which means exactly that).
   */
  isPidAlive?: (pid: number) => boolean;
  /** Workers lead their own process group (POSIX `detached: true`); recorded in the lock as `workerPgid`. */
  workerLeadsProcessGroup?: boolean;
  /** Linger re-check interval (default {@link TASK_PID_LINGER_POLL_MS}; tests override). */
  lingerPollMs?: number;
  /** Linger give-up time (default {@link TASK_PID_LINGER_MAX_MS}; tests override). */
  lingerMaxMs?: number;
  log?: (message: string) => void;
}

/** What a project's job.lock records, for the API (`lockHeld`) and the force-release audit entry. */
export interface JobLockStatus {
  /** A live process other than this server holds it (see {@link JobManager.isLockHeld}). */
  held: boolean;
  taskPids: number[];
  workerPid: number | null;
  /** This server kept the lock after its job ended because recorded task pids were alive. */
  lingering: boolean;
  /** The linger watch gave up (max wait passed) and left the lock in place. */
  expired: boolean;
}

export type ForceReleaseResult =
  | { ok: true; before: JobLockStatus | null }
  | { ok: false; reason: 'job-active' | 'not-locked' };

interface LingeringLock {
  timer: NodeJS.Timeout | null;
  pids: number[];
  since: number;
  lockPath: string;
  expired: boolean;
}

interface ActiveJob {
  jobId: string;
  projectId: string;
  kind: JobKind;
  proc: WorkerProcess;
  view: RunView;
  stopRequested: boolean;
  killTimer: NodeJS.Timeout | null;
  lockPath: string;
  /** Live task child pids the worker reported (`task-pid`), mirrored into job.lock. */
  taskPids: Set<number>;
}

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Replace every occurrence of each secret in `text`. */
/** A JSON-safe copy of `value` with {@link redactSecrets} applied to every string value. */
function redactJsonStrings<T>(value: T, secrets: readonly string[]): T {
  try {
    return JSON.parse(JSON.stringify(value), (_key, v) => (typeof v === 'string' ? redactSecrets(v, secrets) : v)) as T;
  } catch {
    return value;
  }
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) { out = out.split(s).join('[REDACTED]'); }
  }
  return out;
}

export class JobManager {
  private readonly active = new Map<string, ActiveJob>();
  private readonly subscribers = new Map<string, Set<(n: JobNotice) => void>>();
  private readonly isPidAlive: (pid: number) => boolean;
  /** Locks kept after their job ended because recorded task pids were still alive. */
  private readonly lingering = new Map<string, LingeringLock>();

  constructor(private readonly opts: JobManagerOptions) {
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  }

  isActive(projectId: string): boolean { return this.active.has(projectId); }
  activeCount(): number { return this.active.size; }
  activeKind(projectId: string): JobKind | null { return this.active.get(projectId)?.kind ?? null; }
  view(projectId: string): RunView | null { return this.active.get(projectId)?.view ?? null; }
  /** True once {@link stop} was called for the project's current job (until that job ends). */
  isStopRequested(projectId: string): boolean { return this.active.get(projectId)?.stopRequested === true; }

  lockPath(projectId: string): string {
    return path.join(this.opts.dataDir, 'projects', projectId, LOCK_FILE);
  }

  /** Start a worker. Synchronous admission: a second call for the same project gets 409 at once. */
  start(input: StartJobInput): StartResult {
    const { projectId, job } = input;
    if (job.kind !== 'probe' && this.opts.runsDisabledReason !== null) {
      return { ok: false, status: 409, reason: 'runs-disabled', message: 'Runs are disabled: the server sets CI=true, which would auto-approve ship gates.' };
    }
    if (this.active.has(projectId)) {
      return { ok: false, status: 409, reason: 'job-active', message: 'This project already has a job running.' };
    }
    if (this.active.size >= this.opts.maxConcurrent) {
      return { ok: false, status: 429, reason: 'too-many-jobs', message: 'The server is at its concurrent job limit. Try again shortly.' };
    }
    const lockPath = this.lockPath(projectId);
    if (!this.acquireLock(lockPath)) {
      return { ok: false, status: 409, reason: 'project-locked', message: 'This project is locked by another process.' };
    }
    // The lock is ours now: a linger watch left by the previous job (whose
    // pids died before its next tick) must never delete it.
    this.cancelLinger(projectId);

    let proc: WorkerProcess;
    try {
      writeFileAtomicSync(input.jobPath, JSON.stringify(job, null, 2), 0o600);
      proc = this.opts.spawnWorker({ jobPath: input.jobPath, workspace: input.workspace, env: input.env });
    } catch (err) {
      this.releaseLock(lockPath);
      this.opts.log?.(`spawn failed for project ${projectId}: ${(err as Error).message}`);
      return { ok: false, status: 409, reason: 'spawn-failed', message: 'The worker process could not be started.' };
    }

    const jobId = randomUUID();
    const a: ActiveJob = { jobId, projectId, kind: job.kind, proc, view: emptyRunView(), stopRequested: false, killTimer: null, lockPath, taskPids: new Set() };
    // Name the worker in the lock so a successor server respects it while it lives.
    if (proc.pid) { this.writeLock(a); }
    this.active.set(projectId, a);
    this.wire(a, input);
    return { ok: true, jobId, ...(proc.pid ? { workerPid: proc.pid } : {}) };
  }

  /** Ask the project's worker to stop; hard-kill it after 30 s. Returns false when nothing is running. */
  stop(projectId: string): boolean {
    const a = this.active.get(projectId);
    if (!a) { return false; }
    if (a.stopRequested) { return true; }
    a.stopRequested = true;
    try { a.proc.send?.({ type: 'stop' }); } catch { /* channel closed; the kill timer covers it */ }
    a.killTimer = setTimeout(() => {
      a.killTimer = null;
      if (this.active.get(projectId) === a) {
        this.opts.log?.(`worker for project ${projectId} ignored stop; killing`);
        this.opts.killProcess(a.proc);
      }
    }, STOP_KILL_AFTER_MS);
    return true;
  }

  /** Stop every job (SIGTERM path). Resolves when all have ended or `timeoutMs` passes. */
  async stopAll(timeoutMs = STOP_KILL_AFTER_MS + 5000): Promise<void> {
    const ids = [...this.active.keys()];
    if (ids.length === 0) { return; }
    const done = new Promise<void>((resolve) => {
      const check = (): void => { if (this.active.size === 0) { resolve(); } };
      for (const id of ids) {
        const dispose = this.subscribe(id, (n) => { if (n.type === 'end') { dispose(); check(); } });
        this.stop(id);
      }
      check();
    });
    let t: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise<void>((r) => { t = setTimeout(r, timeoutMs); })]);
    if (t) { clearTimeout(t); }
  }

  /** Subscribe to a project's job notices (SSE). Returns a disposer. */
  subscribe(projectId: string, cb: (n: JobNotice) => void): () => void {
    let set = this.subscribers.get(projectId);
    if (!set) { set = new Set(); this.subscribers.set(projectId, set); }
    set.add(cb);
    return () => {
      const s = this.subscribers.get(projectId);
      if (!s) { return; }
      s.delete(cb);
      if (s.size === 0) { this.subscribers.delete(projectId); }
    };
  }

  subscriberCount(projectId: string): number { return this.subscribers.get(projectId)?.size ?? 0; }

  /**
   * What the project's job.lock records, or null when there is no lock file.
   * An unreadable lock reports `held: false` with no pids.
   */
  lockInfo(projectId: string): JobLockStatus | null {
    const info = readLock(this.lockPath(projectId));
    if (info === undefined) { return null; }
    const linger = this.lingering.get(projectId);
    return {
      held: info !== null && this.lockHeld(info),
      taskPids: info?.taskPids ?? [],
      workerPid: info?.workerPid ?? null,
      lingering: linger !== undefined,
      expired: linger?.expired === true,
    };
  }

  /**
   * Admin escape hatch: delete the project's job.lock and stop any linger
   * watch. Refused while this server runs a job there. Kills NOTHING — the
   * caller must have confirmed (or tree-killed) the recorded processes first.
   */
  forceReleaseLock(projectId: string): ForceReleaseResult {
    if (this.active.has(projectId)) { return { ok: false, reason: 'job-active' }; }
    const before = this.lockInfo(projectId);
    const wasLingering = this.lingering.has(projectId);
    this.cancelLinger(projectId);
    if (before === null && !wasLingering) { return { ok: false, reason: 'not-locked' }; }
    this.releaseLock(this.lockPath(projectId));
    this.opts.log?.(`project ${projectId}: job lock force-released (task pids ${before?.taskPids.join(',') || '-'})`);
    return { ok: true, before };
  }

  /**
   * Boot-time: remove lock files left by a crashed predecessor. A lock whose
   * worker (or worker process group, or — when the lock records them — any of
   * its task pids) is still alive is NOT reclaimed — an agent may still be
   * running in the workspace; it stays locked (409) until every recorded holder
   * has exited. Returns the project ids whose lock was reclaimed.
   */
  reclaimStaleLocks(projectIds: readonly string[]): string[] {
    const reclaimed: string[] = [];
    for (const id of projectIds) {
      const p = this.lockPath(id);
      const info = readLock(p);
      if (info === undefined) { continue; }
      if (info !== null && this.lockHeld(info)) {
        this.opts.log?.(`project ${id}: job lock still held (worker pid ${info.workerPid ?? '-'}, server pid ${info.serverPid ?? '-'}); keeping it until the holder exits`);
        continue;
      }
      this.releaseLock(p);
      reclaimed.push(id);
    }
    return reclaimed;
  }

  /**
   * Is the project's job.lock held by a live process other than this server
   * (a predecessor's worker, its process group, a recorded task pid, or another
   * live server)? False when there is no lock or every holder is gone.
   */
  isLockHeld(projectId: string): boolean {
    const info = readLock(this.lockPath(projectId));
    return info !== undefined && info !== null && this.lockHeld(info);
  }

  /**
   * Boot-time: watch locks that {@link reclaimStaleLocks} had to keep because a
   * predecessor's worker (or its agent) is still alive. Every `intervalMs` each
   * project is re-checked; once nothing holds its lock — and this server has no
   * job of its own running there — the stale lock is reclaimed and
   * `onReleased(projectId)` runs (the caller re-runs boot recovery then). The
   * timer is unref'd and stops by itself once every project was released.
   * Returns a disposer that stops watching. Never throws.
   */
  watchHeldLocks(
    projectIds: readonly string[],
    onReleased: (projectId: string) => void,
    opts: { intervalMs?: number; setInterval?: (fn: () => void, ms: number) => unknown; clearInterval?: (t: unknown) => void } = {},
  ): () => void {
    const pending = new Set(projectIds);
    const setTimer = opts.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); return t; });
    const clearTimer = opts.clearInterval ?? ((t: unknown) => clearInterval(t as NodeJS.Timeout));
    let timer: unknown = null;
    const stop = (): void => {
      if (timer !== null) { clearTimer(timer); timer = null; }
      pending.clear();
    };
    const tick = (): void => {
      for (const id of [...pending]) {
        try {
          // Our own job there means the predecessor is gone, but its records must
          // not be recovered under a live run of ours: wait for that to end too.
          if (this.active.has(id) || this.isLockHeld(id)) { continue; }
          this.reclaimStaleLocks([id]);
          pending.delete(id);
          onReleased(id);
        } catch (err) { this.opts.log?.(`held-lock watch ${id}: ${(err as Error).message}`); }
      }
      if (pending.size === 0) { stop(); }
    };
    if (pending.size > 0) { timer = setTimer(tick, opts.intervalMs ?? HELD_LOCK_POLL_MS); }
    return stop;
  }

  // ─── Internals ───

  private notify(projectId: string, n: JobNotice): void {
    for (const cb of [...(this.subscribers.get(projectId) ?? [])]) {
      try { cb(n); } catch (err) { this.opts.log?.(`subscriber threw: ${(err as Error).message}`); }
    }
  }

  private acquireLock(lockPath: string): boolean {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try { fs.writeSync(fd, JSON.stringify({ serverPid: process.pid })); } finally { fs.closeSync(fd); }
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
        const info = readLock(lockPath);
        // Respected: a live worker (whoever started it), a live OTHER server, or
        // us without an in-memory job (cannot happen). A dead holder is reclaimed once.
        if (info && (this.lockHeld(info) || (info.serverPid === process.pid && info.workerPid === null))) { return false; }
        this.releaseLock(lockPath);
      }
    }
    return false;
  }

  /**
   * Is a lock held by someone alive? Its worker (or the worker's process group)
   * still running — whichever server started it — or a live OTHER server.
   * Our own pid never counts as a live holder.
   */
  private lockHeld(info: LockInfo): boolean {
    if (info.workerPid !== null && info.workerPid !== process.pid && this.isPidAlive(info.workerPid)) { return true; }
    // An agent process outliving its worker still owns the workspace.
    if (info.taskPids.some((pid) => pid !== process.pid && this.isPidAlive(pid))) { return true; }
    if (info.workerPgid !== null && info.workerPgid !== process.pid && this.isPidAlive(-info.workerPgid)) { return true; }
    return info.serverPid !== null && info.serverPid !== process.pid && this.isPidAlive(info.serverPid);
  }

  /**
   * Rewrite a live job's lock: the worker (and its group) plus every task pid it
   * has reported alive. Best effort — a failed write leaves the previous lock,
   * which still names the worker.
   */
  private writeLock(a: ActiveJob): void {
    const workerPid = a.proc.pid;
    if (!workerPid) { return; }
    const taskPids = [...a.taskPids].slice(0, MAX_LOCK_TASK_PIDS);
    try {
      writeFileAtomicSync(a.lockPath, JSON.stringify({
        serverPid: process.pid, workerPid,
        ...(this.opts.workerLeadsProcessGroup ? { workerPgid: workerPid } : {}),
        ...(taskPids.length > 0 ? { taskPids } : {}),
      }), 0o600);
    } catch (err) { this.opts.log?.(`job.lock update for project ${a.projectId}: ${(err as Error).message}`); }
  }

  private releaseLock(lockPath: string): void {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }

  // ─── Lock linger (task pids outliving their job) ───

  /**
   * A job ended: release its lock now, or — when any recorded task pid is
   * still alive — keep it, rewritten to name only those pids, and re-check on
   * an unref'd interval until they die or the max wait passes.
   */
  private releaseWhenTasksExit(a: ActiveJob): void {
    const alive = [...a.taskPids].filter((p) => p !== process.pid && this.isPidAlive(p));
    if (alive.length === 0) {
      this.releaseLock(a.lockPath);
      return;
    }
    const workerPid = a.proc.pid ?? null;
    try {
      writeFileAtomicSync(a.lockPath, JSON.stringify({
        serverPid: process.pid,
        ...(workerPid ? { workerPid } : {}),
        ...(workerPid && this.opts.workerLeadsProcessGroup ? { workerPgid: workerPid } : {}),
        taskPids: alive,
      }), 0o600);
    } catch (err) { this.opts.log?.(`job.lock linger write for project ${a.projectId}: ${(err as Error).message}`); }
    this.opts.log?.(`project ${a.projectId}: job ended but task pid(s) ${alive.join(',')} are still alive; keeping job.lock until they exit`);
    this.cancelLinger(a.projectId);
    const now = this.opts.now ?? Date.now;
    const maxMs = this.opts.lingerMaxMs ?? TASK_PID_LINGER_MAX_MS;
    const entry: LingeringLock = { timer: null, pids: alive, since: now(), lockPath: a.lockPath, expired: false };
    const stopTimer = (): void => { if (entry.timer) { clearInterval(entry.timer); entry.timer = null; } };
    const tick = (): void => {
      if (this.lingering.get(a.projectId) !== entry) { stopTimer(); return; }
      try {
        if (this.active.has(a.projectId)) {
          // A new job owns the lock now; never touch it.
          stopTimer();
          this.lingering.delete(a.projectId);
          return;
        }
        entry.pids = entry.pids.filter((p) => this.isPidAlive(p));
        if (entry.pids.length === 0) {
          stopTimer();
          this.lingering.delete(a.projectId);
          this.releaseLock(entry.lockPath);
          this.opts.log?.(`project ${a.projectId}: lingering task pids exited; job.lock released`);
          return;
        }
        if (now() - entry.since >= maxMs) {
          stopTimer();
          entry.expired = true;
          this.opts.log?.(`project ${a.projectId}: job.lock still held by task pid(s) ${entry.pids.join(',')} after ${Math.round(maxMs / 1000)} s; an admin can force-release it`);
        }
      } catch (err) { this.opts.log?.(`lock linger ${a.projectId}: ${(err as Error).message}`); }
    };
    entry.timer = setInterval(tick, this.opts.lingerPollMs ?? TASK_PID_LINGER_POLL_MS);
    entry.timer.unref?.();
    this.lingering.set(a.projectId, entry);
  }

  /** Stop a project's linger watch (if any) without touching its lock file. */
  private cancelLinger(projectId: string): void {
    const entry = this.lingering.get(projectId);
    if (!entry) { return; }
    if (entry.timer) { clearInterval(entry.timer); entry.timer = null; }
    this.lingering.delete(projectId);
  }

  private wire(a: ActiveJob, input: StartJobInput): void {
    const { proc } = a;
    const redact = input.redact ?? [];
    const taskEngines = new Map<string, string>();
    let stdoutBuf = '';
    let discarding = false;
    let stderrTail = '';
    let ended = false;

    const handleEvent = (ev: WorkerEvent): void => {
      if (ev.event === 'task-pid') {
        // Lock bookkeeping only: pids are never folded into the view or fanned out to SSE.
        if (ended || this.active.get(a.projectId) !== a) { return; }
        const before = a.taskPids.size;
        if (ev.alive) {
          if (a.taskPids.size < MAX_LOCK_TASK_PIDS) { a.taskPids.add(ev.pid); }
        } else { a.taskPids.delete(ev.pid); }
        if (a.taskPids.size !== before) { this.writeLock(a); }
        return;
      }
      a.view = foldRunEvent(a.view, ev);
      if (ev.event === 'cost' && input.spendKey && this.opts.recordSpend) {
        try { this.opts.recordSpend(a.projectId, input.spendKey, ev.usd); } catch (err) { this.opts.log?.(`recordSpend: ${(err as Error).message}`); }
      }
      if (ev.event === 'task-engine') { taskEngines.set(ev.id, ev.engine); }
      const outcome = (ev.event === 'task-completed' || ev.event === 'task-failed') ? countableOutcome(ev, a) : null;
      if (outcome && (ev.event === 'task-completed' || ev.event === 'task-failed') && this.opts.onTaskOutcome) {
        try {
          this.opts.onTaskOutcome({
            projectId: a.projectId, jobId: a.jobId, taskId: ev.id, status: outcome,
            engine: taskEngines.get(ev.id) ?? null,
          });
        } catch (err) { this.opts.log?.(`onTaskOutcome: ${(err as Error).message}`); }
      }
      const safe: WorkerEvent = ev.event === 'task-error-tail' ? { ...ev, tail: redactSecrets(ev.tail, redact) }
        : ev.event === 'error' || ev.event === 'warning' ? { ...ev, message: redactSecrets(ev.message, redact) }
          // An install's output tail can echo a registry token or an env value.
          : ev.event === 'dependencies-installed' || ev.event === 'dependencies-install-failed' || ev.event === 'dependencies-not-installed'
            ? { ...ev, tail: redactSecrets(ev.tail, redact), note: ev.note === null ? null : redactSecrets(ev.note, redact) }
          // verify-* payloads carry command output (a standards report's command tails).
          : ev.event === 'verify' && redact.length > 0 ? { ...ev, data: redactJsonStrings(ev.data, redact) }
            : ev;
      try { input.onEvent?.(safe); } catch (err) { this.opts.log?.(`onEvent: ${(err as Error).message}`); }
      this.notify(a.projectId, { type: 'event', jobId: a.jobId, event: safe });
    };

    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (discarding) { discarding = false; continue; }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { continue; }
        const ev = parseWorkerLine(line);
        if (ev) { handleEvent(ev); }
      }
      if (Buffer.byteLength(stdoutBuf) > MAX_LINE_BYTES) {
        // An overlong line: drop what we have and skip to the next newline.
        stdoutBuf = '';
        discarding = true;
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    };

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (ended) { return; }
      ended = true;
      if (a.killTimer) { clearTimeout(a.killTimer); a.killTimer = null; }
      proc.stdout?.removeListener('data', onStdout);
      proc.stderr?.removeListener('data', onStderr);
      proc.removeListener('close', onClose);
      proc.removeListener('error', onError);
      if (this.active.get(a.projectId) === a) { this.active.delete(a.projectId); }
      this.releaseWhenTasksExit(a);
      const end: JobEnd = {
        jobId: a.jobId,
        projectId: a.projectId,
        kind: a.kind,
        exitCode,
        status: a.stopRequested && exitCode !== 3 ? 'stopped' : exitToRunStatus(spawnError ? null : exitCode),
        view: a.view,
        stderrTail: redactSecrets(stderrTail, redact),
        ...(spawnError ? { spawnError: redactSecrets(spawnError, redact) } : {}),
      };
      try { input.onEnd?.(end); } catch (err) { this.opts.log?.(`onEnd: ${(err as Error).message}`); }
      this.notify(a.projectId, { type: 'end', end });
    };
    const onClose = (code: number | null): void => finish(code);
    const onError = (err: Error): void => finish(null, err.message);

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('close', onClose);
    proc.on('error', onError);
  }
}

/**
 * The stack-evidence verdict of a terminal task event, or null when it is not
 * evidence. Only a task the engine ran to its own verdict counts: the runner
 * also emits task-completed for SKIPPED tasks and task-failed for BLOCKED ones
 * and for pre-flight halts, and a task that ends after a stop (user, ship gate,
 * cost ceiling) was aborted, not judged.
 */
function countableOutcome(
  ev: Extract<WorkerEvent, { event: 'task-completed' | 'task-failed' }>,
  a: Pick<ActiveJob, 'stopRequested' | 'view'>,
): 'completed' | 'failed' | null {
  if (ev.engineRan !== true || a.stopRequested || a.view.haltReason !== null) { return null; }
  if (ev.event === 'task-completed') { return ev.status === undefined || ev.status === TaskStatus.Completed ? 'completed' : null; }
  return ev.status === undefined || ev.status === TaskStatus.Failed ? 'failed' : null;
}

/** Who holds a project's job lock. `taskPids`: agent processes, when the lock records them. */
interface LockInfo { serverPid: number | null; workerPid: number | null; workerPgid: number | null; taskPids: number[]; }

/** Most task pids read from one lock file (a garbage lock cannot make boot probe forever). */
const MAX_LOCK_TASK_PIDS = 64;

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/**
 * A lock file's holders: null when unreadable/garbage, undefined when there is
 * no file. Accepts the JSON form and the older bare server pid.
 */
function readLock(lockPath: string): LockInfo | null | undefined {
  let raw: string;
  try { raw = fs.readFileSync(lockPath, 'utf-8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const n = posInt(Number(text));
    return n === null ? null : { serverPid: n, workerPid: null, workerPgid: null, taskPids: [] };
  }
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) { return null; }
  const rec = o as Record<string, unknown>;
  const taskPids = Array.isArray(rec.taskPids)
    ? rec.taskPids.slice(0, MAX_LOCK_TASK_PIDS).map(posInt).filter((n): n is number => n !== null)
    : [];
  const info: LockInfo = { serverPid: posInt(rec.serverPid), workerPid: posInt(rec.workerPid), workerPgid: posInt(rec.workerPgid), taskPids };
  return info.serverPid === null && info.workerPid === null && info.workerPgid === null && taskPids.length === 0 ? null : info;
}
