// ─── Remote runs: supervising one child (daemon side) ───
//
// Owns one remote child from spawn to exit: writes its job spec and the inbound
// bundle to stdin, reads its stdout, and turns what it reads into
//
//   - relay events (every line except `remote-*`, through a per-run OnosooRelay
//     whose run id is this run's id — so ONOSOO's run id and MOAG's are the same);
//   - the run record (plan snapshot, statuses, the ship gate it halted at);
//   - ledger charges (`remote-cost`);
//   - the outbound bundle, imported into the project as the run's branch.
//
// Stop is a {"op":"stop"} line on stdin; if the child has not exited within
// STOP_GRACE_MS the runner account's processes are force-killed. No remote run
// lives longer than REMOTE_RUN_MAX_MS (4 h): it is then stopped the same way.
// Imports nothing that loads `vscode`.

import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { dehydratePlan, hydratePlan } from '../models/plan';
import { TaskStatus } from '../models/types';
import type { RemoteLedger } from './remote-ledger';
import type { RemoteRunRecord, RemoteRuns } from './remote-runs';
import { BundleAssembler, writeBundleFile } from './remote-branch';
import type { RunMeta } from './onosoo-relay';

export const STOP_GRACE_MS = 30_000;
export const REMOTE_RUN_MAX_MS = 4 * 60 * 60 * 1000;
export const MAX_CHILD_LINE_BYTES = 1024 * 1024;
/** After a force-kill, how long to wait for the child to close before finishing anyway. */
const FORCED_CLOSE_WAIT_MS = 10_000;

export const RUN_TIME_LIMIT_REASON = 'Stopped: the run exceeded the 4-hour limit for remote runs.';
export const FORCE_STOPPED_MESSAGE = 'The run did not stop within 30 s and was force-stopped.';

const TASK_STATUSES = new Set<string>(Object.values(TaskStatus));

/** The child process, as far as the supervisor needs it. */
export interface ChildLike {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

/** The per-run relay, as far as the supervisor needs it. */
export interface RunRelay {
  start(meta?: RunMeta): void;
  record(line: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface SupervisorTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RunExit {
  record: RemoteRunRecord;
  code: number | null;
  /** True once the child reported run-started. */
  started: boolean;
  /** Set when the run ended without starting, or was force-stopped: why, in words. */
  failure: string | null;
}

export interface SupervisorOptions {
  record: RemoteRunRecord;
  /** The project's display name (never its path), for run-meta. */
  projectName: string;
  /** The job spec line (JSON, without newline). Must not contain the device key. */
  specLine: string;
  bundle: Buffer;
  /** Start the child (sudo -n -u <runner> … remote-child). */
  spawnChild(): ChildLike;
  relayFactory(runId: string): RunRelay;
  ledger: RemoteLedger;
  runs: RemoteRuns;
  /** Where outbound bundles are staged: <stateDir>/remote/tmp. */
  tmpDir: string;
  importBranch(bundleFile: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  forceKill(): Promise<void>;
  /** After every run, once the child has exited: kill whatever the runner account still has running. */
  sweep?(): Promise<void>;
  stderr?: (s: string) => void;
  onStarted?(runId: string): void;
  onExit?(exit: RunExit): void;
  timers?: SupervisorTimers;
  now?: () => Date;
}

// Not unref'd: a daemon waiting for a run to finalize (shutdown included) must stay alive for it.
const realTimers: SupervisorTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class RemoteSupervisor {
  readonly runId: string;
  private readonly o: SupervisorOptions;
  private readonly timers: SupervisorTimers;
  private readonly now: () => Date;
  private child: ChildLike | null = null;
  private relay: RunRelay | null = null;
  private relayStarted = false;
  private started = false;
  private exited = false;
  private failure: string | null = null;
  private lastError: string | null = null;
  private stopRequested = false;
  private graceTimer: unknown = null;
  private wallTimer: unknown = null;
  private forcedTimer: unknown = null;
  private assembler = new BundleAssembler();
  private bundleEnd: Record<string, unknown> | null = null;
  /** The child said it failed before spending anything. */
  private noSpend = false;
  /** A ledger write failed during the run: what it spent is not fully on record. */
  private ledgerFailed = false;
  private exitPromise: Promise<RunExit>;
  private resolveExit!: (e: RunExit) => void;
  /** Lines over the 1 MB cap, dropped. */
  droppedLines = 0;

  constructor(opts: SupervisorOptions) {
    this.o = opts;
    this.runId = opts.record.runId;
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? ((): Date => new Date());
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
  }

  /** Resolves when the child has exited and the run is finalized. */
  get exit(): Promise<RunExit> {
    return this.exitPromise;
  }

  /** Spawn the child and hand it the job. Never throws: a failed spawn finalizes the run as failed. */
  start(): void {
    try {
      this.relay = this.o.relayFactory(this.runId);
      const child = this.o.spawnChild();
      this.child = child;
      child.on('error', (err) => { this.lastError = `The run could not be started: ${err.message}`; void this.finish(null); });
      child.on('close', (code) => { void this.finish(code); });
      (child.stdin as unknown as { on?: (e: string, f: () => void) => void } | null)?.on?.('error', () => undefined);
      this.readLines(child.stdout);
      child.stderr?.on('data', () => undefined);
      child.stdin?.write(`${this.o.specLine}\n`);
      if (this.o.bundle.length > 0) { child.stdin?.write(this.o.bundle); }
      // stdin stays open: it is the stop channel, and EOF means stop.
      this.wallTimer = this.timers.setTimeout(() => {
        this.o.record.stopReason = RUN_TIME_LIMIT_REASON;
        // Said on the run's own event stream, so ONOSOO shows why it stopped even if the child is hung.
        try { this.ensureRelay()?.record({ ts: this.now().toISOString(), event: 'warning', message: RUN_TIME_LIMIT_REASON }); } catch { /* never disturbs */ }
        this.save();
        void this.stop();
      }, REMOTE_RUN_MAX_MS);
    } catch (err) {
      this.lastError = `The run could not be started: ${err instanceof Error ? err.message : String(err)}`;
      void this.finish(null);
    }
  }

  /**
   * Ask the child to stop; force-kill the runner account's processes after STOP_GRACE_MS.
   * Resolves once the run has exited (forced or not).
   */
  stop(): Promise<RunExit> {
    if (!this.exited && !this.stopRequested) {
      this.stopRequested = true;
      try { this.child?.stdin?.write('{"op":"stop"}\n'); } catch { /* child gone */ }
      this.graceTimer = this.timers.setTimeout(() => {
        if (this.exited) { return; }
        this.failure = FORCE_STOPPED_MESSAGE;
        void this.o.forceKill().catch(() => undefined);
        this.forcedTimer = this.timers.setTimeout(() => { void this.finish(null); }, FORCED_CLOSE_WAIT_MS);
      }, STOP_GRACE_MS);
    }
    return this.exitPromise;
  }

  // ─── stdout ───

  private readLines(stdout: NodeJS.ReadableStream | null): void {
    if (!stdout) { return; }
    // A multi-byte character can be split across chunks: decode as a stream.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let dropping = false;
    stdout.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) { break; }
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (dropping) { dropping = false; continue; }
        if (Buffer.byteLength(line, 'utf-8') > MAX_CHILD_LINE_BYTES) { this.droppedLines++; continue; }
        this.onLine(line);
      }
      if (Buffer.byteLength(buf, 'utf-8') > MAX_CHILD_LINE_BYTES) {
        // An overlong line still being written: drop what we have and the rest of it.
        this.droppedLines++;
        buf = '';
        dropping = true;
      }
    });
  }

  private ensureRelay(meta?: RunMeta): RunRelay | null {
    if (this.relay && !this.relayStarted) {
      this.relayStarted = true;
      try { this.relay.start(meta); } catch { /* the relay never disturbs the run */ }
    }
    return this.relay;
  }

  private save(): void {
    try { this.o.runs.save(this.o.record); } catch { /* retried on the next save */ }
  }

  private onLine(text: string): void {
    let line: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) { return; }
      line = v as Record<string, unknown>;
    } catch {
      return;
    }
    const event = line.event;
    if (typeof event !== 'string') { return; }
    if (event.startsWith('remote-')) { this.onInternal(event, line); return; }

    if (event === 'manual-gate' && typeof line.id === 'string') { this.o.record.gateTaskId = line.id; this.save(); }
    if (event === 'error' && typeof line.message === 'string') { this.lastError = line.message.slice(0, 500); }
    const relay = this.ensureRelay();
    try { relay?.record(line); } catch { /* never disturbs the run */ }
    if (event === 'run-started' && !this.started) {
      this.started = true;
      try { this.o.onStarted?.(this.runId); } catch { /* the host's problem */ }
    }
  }

  private onInternal(event: string, line: Record<string, unknown>): void {
    const r = this.o.record;
    switch (event) {
      case 'remote-plan': {
        try {
          const plan = hydratePlan(line.plan as never, `run ${this.runId}`);
          r.snapshot = dehydratePlan(plan);
          this.save();
          this.ensureRelay({
            plan_name: plan.name,
            project: this.o.projectName,
            tasks: plan.playlists.flatMap((pl) => pl.tasks).map((t) => ({ id: t.id, name: t.name })),
            branch: r.branch,
          });
        } catch (err) {
          this.lastError = `The run's plan could not be read: ${err instanceof Error ? err.message : String(err)}`;
          this.failure = this.lastError;
          void this.stop();
        }
        return;
      }
      case 'remote-statuses': {
        const statuses = line.statuses;
        if (!statuses || typeof statuses !== 'object') { return; }
        for (const pl of r.snapshot.playlists ?? []) {
          for (const t of pl.tasks ?? []) {
            const s = (statuses as Record<string, unknown>)[t.id];
            if (typeof s === 'string' && TASK_STATUSES.has(s)) { t.status = s as TaskStatus; }
          }
        }
        this.save();
        return;
      }
      case 'remote-cost': {
        const engine = typeof line.engine === 'string' ? line.engine : '';
        try {
          if (line.unreported === true) { this.o.ledger.record(this.runId, { unreported: true }, engine); }
          else if (typeof line.usd === 'number') { this.o.ledger.record(this.runId, { usd: line.usd }, engine); }
        } catch (err) {
          // Never let a ledger error escape the stdout handler. The run is charged in full at the end.
          if (!this.ledgerFailed) {
            try { this.o.stderr?.(`ONOSOO: the spend ledger could not be updated (${err instanceof Error ? err.message : String(err)}); run ${this.runId} will be charged its full allotment.\n`); } catch { /* ignore */ }
          }
          this.ledgerFailed = true;
        }
        return;
      }
      case 'remote-no-spend':
        this.noSpend = true;
        return;
      case 'remote-bundle-chunk':
        this.assembler.addChunk(line.data);
        return;
      case 'remote-bundle-end': {
        this.bundleEnd = line;
        // What the parent actually sent: a resume needs it to find the work.
        r.commitsSent = typeof line.bytes === 'number' && line.bytes > 0;
        if (typeof line.tip === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line.tip)) { r.branchTip = line.tip; }
        this.save();
        return;
      }
      default:
        return;
    }
  }

  // ─── Exit ───

  private async importBundle(): Promise<void> {
    const r = this.o.record;
    if (!this.bundleEnd) {
      if (this.started) { r.importError = 'The run\'s commits did not arrive from the build account.'; }
      return;
    }
    const got = this.assembler.finish(this.bundleEnd);
    if (!got.ok) { r.importError = got.reason; return; }
    if (!got.data) { return; }
    const file = path.join(this.o.tmpDir, `${this.runId}.bundle`);
    try {
      fs.mkdirSync(this.o.tmpDir, { recursive: true, mode: 0o700 });
      writeBundleFile(file, got.data);
      const out = await this.o.importBranch(file);
      if (!out.ok) { r.importError = out.reason; }
    } catch (err) {
      r.importError = `The run's commits could not be imported: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
  }

  private async finish(code: number | null): Promise<void> {
    if (this.exited) { return; }
    this.exited = true;
    for (const t of [this.graceTimer, this.wallTimer, this.forcedTimer]) { if (t !== null) { this.timers.clearTimeout(t); } }
    const r = this.o.record;
    // The runner account keeps nothing running between runs.
    try { await this.o.sweep?.(); } catch { /* best effort */ }
    // What the run spent is known only when the child exited on its own AND either sent its
    // bundle-end (it got through its cleanup) or said it failed before spending anything.
    // An error line alone proves nothing: it may have crashed after. Otherwise charge it all.
    const costKnown = code !== null && (this.bundleEnd !== null || this.noSpend) && !this.ledgerFailed;
    try {
      if (costKnown) { this.o.ledger.settle(this.runId); } else { this.o.ledger.chargeInFull(this.runId); }
    } catch { /* the ledger fails closed on its own */ }
    await this.importBundle();
    r.outcome = 'finished';
    r.exitCode = code;
    r.endedAt = this.now().toISOString();
    if (!this.started && !this.failure) {
      this.failure = this.lastError ?? 'The run ended before it started.';
    }
    this.save();
    try { await this.relay?.close(); } catch { /* close never rejects */ }
    const exit: RunExit = { record: r, code, started: this.started, failure: this.failure };
    try { this.o.onExit?.(exit); } catch { /* the host's problem */ }
    this.resolveExit(exit);
  }
}
