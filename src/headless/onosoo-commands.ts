// ─── ONOSOO command host (the daemon's poller) ───
//
// Every 5 s: re-read projects.json, report capabilities when they changed, flush
// undelivered results, and poll for commands. Commands are handled one at a time:
//
//   1. audit `received` — BEFORE anything else; if that fails the command fails;
//   2. at-most-once: an id the audit log has seen is never executed again;
//   3. validate the payload, re-read projects.json, decide (remote-commands.ts);
//   4. act: stop a run, or start one (start-run / approve / skip / retry) on the
//      single remote slot, which is claimed synchronously before any await.
//
// A start reports `running` at once and `succeeded` (with the run id) when the
// child reports run-started; a run that ends before that reports `failed`.
// Polling never waits for a run. Results that cannot be delivered wait in the
// outbox and are retried each cycle (and after a restart).
//
// One host per state directory: it holds <stateDir>/remote/daemon.lock while it
// runs. A second daemon on the same state dir does not poll at all.
//
// At boot: audit ids with no final result are failed ("MOAG restarted…"), live run
// records become interrupted (charged in full), leftover spool is drained, and the
// runner account's processes are swept. Imports nothing that loads `vscode`.

import { createEmptyPlan, dehydratePlan } from '../models/plan';
import type { Plan, PlanFile } from '../models/types';
import { branchNameFor } from '../runner/git-delivery';
import type { Capabilities, CommandResult, PolledCommand, ResultOutcome } from './onosoo-control';
import type { ApprovedProject, ApprovedProjects } from './onosoo-projects';
import type { RemoteAudit } from './remote-audit';
import type { InboundBundle } from './remote-branch';
import { reviewRemotePlan, transformGeneratedPlan } from './remote-child';
import {
  BUSY, checkGateDecision, checkRetry, checkStartRun, checkStop, NO_DAILY_BUDGET, prepareGateDecision, prepareRetry, REMOTE_START_OFF,
  StartRunPayload, usd, validatePayload,
} from './remote-commands';
import type { ProbeOutcome } from './remote-isolation';
import { isolationRefusal, ISOLATION_RECHECK_MS } from './remote-isolation';
import type { RemoteLedger } from './remote-ledger';
import type { LockOutcome } from './remote-lock';
import { isHandStarted, RemoteRunRecord, RemoteRuns } from './remote-runs';
import type { RunExit } from './remote-supervisor';
import { FORCE_STOPPED_MESSAGE, STOP_GRACE_MS } from './remote-supervisor';

export const POLL_INTERVAL_MS = 5_000;
/** The bound on the shutdown capabilities request. */
export const HOST_CLOSE_DEADLINE_MS = 20_000; // ONOSOO can take several seconds to answer (see REQUEST_TIMEOUT_MS)
/** How long an import of a run's branch may take at shutdown. */
export const IMPORT_WAIT_MS = 120_000;
/** The bound on waiting for an active run to stop and finalize at shutdown. */
export const RUN_STOP_WAIT_MS = STOP_GRACE_MS + 10_000 + IMPORT_WAIT_MS;
export const RESTARTED_MESSAGE = 'MOAG restarted before finishing this command';
export const AUDIT_UNAVAILABLE = 'audit log unavailable';
/** How often a daemon that lost the lock tries again. */
export const LOCK_RETRY_MS = 60_000;

/** The control client, as far as the host needs it. */
export interface ControlLike {
  poll(): Promise<PolledCommand[] | 'stop' | { waitMs: number }>;
  postResult(id: string, result: CommandResult): Promise<ResultOutcome>;
  sendCapabilities(caps: Capabilities): Promise<boolean>;
  readonly revoked: boolean;
  /** Set when the last result post was rate-limited: how long ONOSOO asked to wait. */
  readonly lastRetryAfterMs?: number | null;
}

/** One supervised run, as far as the host needs it. */
export interface SupervisorLike {
  readonly runId: string;
  start(): void;
  stop(): Promise<RunExit>;
  readonly exit: Promise<RunExit>;
}

export interface SupervisorRequest {
  record: RemoteRunRecord;
  project: ApprovedProject;
  specLine: string;
  bundle: Buffer;
  onStarted(runId: string): void;
  onExit(exit: RunExit): void;
}

export interface HostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CommandHostOptions {
  control: ControlLike;
  stateDir: string;
  loadProjects(): ApprovedProjects;
  platform: NodeJS.Platform;
  /** Spawn the probe child; called only when the platform and runner user allow remote work. */
  probe(projects: ApprovedProjects): Promise<ProbeOutcome>;
  supervisorFactory(req: SupervisorRequest): SupervisorLike;
  exportBundle(projectPath: string, opts: { continueBranch?: string; startSha?: string; haveShas: readonly string[] }): Promise<InboundBundle>;
  /** Does `branch` exist in the project? (A run that never committed left none behind.) */
  branchExists?(projectPath: string, branch: string): Promise<boolean>;
  /** The project's tip of `branch`, or null when it is not there. Preferred over branchExists. */
  projectBranchTip?(projectPath: string, branch: string): Promise<string | null>;
  ledger: RemoteLedger;
  audit: RemoteAudit;
  runs: RemoteRuns;
  branchPrefix: string;
  engineEnv: Record<string, string>;
  newRunId(): string;
  projectDefaultEngine?(project: ApprovedProject): string | null;
  /** The single-instance lock (<stateDir>/remote/daemon.lock). */
  lock?: { acquire(): LockOutcome; release(): void };
  /** Boot: send whatever earlier runs left in the spool (a relay with no meta and no heartbeat). */
  drainLeftoverSpool?(): Promise<void>;
  /** Boot: kill every process the runner account owns (only when isolation is possible). */
  killSweep?(runnerUser: string): Promise<void>;
  /** Boot: owner-only permissions on the state directory (non-Windows). */
  tighten?(): void;
  timers?: HostTimers;
  now?: () => Date;
  stderr?: (s: string) => void;
}

const realTimers: HostTimers = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Isolation = { ok: true; engines: string[]; mirrors: Record<string, string[]> } | { ok: false; reason: string };

interface LaunchRequest {
  project: ApprovedProject;
  engine: string;
  allotment: number;
  goal?: string;
  prd?: string;
  snapshot?: PlanFile;
  /** Continue on this existing branch of the project. */
  continueBranch?: string;
  /** Continue on the runner mirror's own copy of this branch (its commits never reached the project). */
  resumeFromMirrorBranch?: string;
  /** The tip that mirror branch must have, when the parent reported one. */
  expectedTip?: string;
  /** How the plan is (or was) made: a goal-only plan never gets a ship gate. */
  planKind: 'goal' | 'prd';
  /** Start a fresh branch from this commit (a parent run whose branch never reached the project). */
  startSha?: string;
  parentRunId?: string;
  projects: ApprovedProjects;
  iso: Isolation;
  /** Called once the run has been handed to its supervisor (an approve/skip/retry decides its parent here). */
  onLaunched?(): void;
  /** Called when that run ended without ever starting: undo what onLaunched did. */
  onNotStarted?(): void;
}

export class CommandHost {
  private readonly o: CommandHostOptions;
  private readonly timers: HostTimers;
  private readonly now: () => Date;
  private seen = new Set<string>();
  private lastCaps: string | null = null;
  private isolation: Isolation | null = null;
  private isolationAt = 0;
  private active: SupervisorLike | null = null;
  /** Claimed synchronously by a start, before any await; released on failure or exit. */
  private slotClaimed = false;
  private pollTimer: unknown = null;
  private stopped = false;
  private pollingEnded = false;
  /** True when another daemon holds the lock: this host does nothing at all. */
  private lockedOut = false;
  private lockRetryTimer: unknown = null;
  /** A boot started by a lock retry, so close() can wait for it. */
  private booting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  constructor(opts: CommandHostOptions) {
    this.o = opts;
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? ((): Date => new Date());
  }

  private note(s: string): void {
    try { (this.o.stderr ?? ((x: string) => { process.stderr.write(x); }))(`${s}\n`); } catch { /* ignore */ }
  }

  // ─── Boot and loop ───

  /** Take the lock, reconcile what a previous process left, then start the loop. */
  async start(): Promise<void> {
    if (this.o.lock) {
      const got = this.o.lock.acquire();
      if (!got.ok) {
        this.lockedOut = true;
        this.note(`ONOSOO: another MOAG daemon (pid ${got.holderPid}) already handles remote commands for this machine; this one will not poll until it stops (checked every minute).`);
        this.scheduleLockRetry();
        return;
      }
    }
    // Tracked so close() during the initial boot waits for it before releasing the lock.
    this.booting = this.boot();
    await this.booting;
  }

  /** Try the lock again every LOCK_RETRY_MS; once it is ours, boot like a fresh start. */
  private scheduleLockRetry(): void {
    if (this.stopped) { return; }
    this.lockRetryTimer = this.timers.setTimeout(() => {
      this.lockRetryTimer = null;
      if (this.stopped || !this.o.lock) { return; }
      let got: LockOutcome;
      try { got = this.o.lock.acquire(); } catch { got = { ok: false, holderPid: -1 }; }
      if (!got.ok) { this.scheduleLockRetry(); return; }
      this.lockedOut = false;
      this.note('ONOSOO: the other MOAG daemon has stopped; this one now handles remote commands.');
      this.booting = this.boot().catch(() => undefined);
    }, LOCK_RETRY_MS);
  }

  /** Release the lock now, without waiting for anything (a forced exit). Never throws. */
  releaseLock(): void {
    try { this.o.lock?.release(); } catch { /* best effort */ }
  }

  private async boot(): Promise<void> {
    try { this.o.tighten?.(); } catch { /* reported by the caller */ }
    const { seen, unfinished } = this.o.audit.reconcileOnBoot();
    this.seen = seen;
    for (const u of unfinished) {
      await this.finalize(u.id, u.kind, { status: 'failed', message: RESTARTED_MESSAGE });
    }
    for (const runId of this.o.runs.markInterruptedOnBoot()) {
      try { this.o.ledger.chargeInFull(runId); } catch { /* fails closed */ }
    }
    try { this.o.runs.prune(); } catch { /* best effort */ }
    try { await this.o.drainLeftoverSpool?.(); } catch { /* best effort */ }
    const projects = this.o.loadProjects();
    if (!isolationRefusal(this.o.platform, projects.runnerUser) && projects.runnerUser) {
      try { await this.o.killSweep?.(projects.runnerUser); } catch { /* best effort */ }
    }
    this.schedule(0);
  }

  /** True when another daemon holds the lock and this host stood down. */
  get standingDown(): boolean {
    return this.lockedOut;
  }

  private schedule(ms: number): void {
    if (this.stopped) { return; }
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      void this.tick().catch(() => undefined).then((wait) => {
        if (!this.stopped && !this.o.control.revoked) { this.schedule(typeof wait === 'number' ? wait : POLL_INTERVAL_MS); }
      });
    }, ms);
  }

  /** One cycle: capabilities, outbox, poll, handle. Resolves the wait before the next cycle. */
  async tick(): Promise<number | void> {
    if (this.stopped || this.lockedOut) { return; }
    const projects = this.o.loadProjects();
    const iso = await this.checkIsolation(projects, false);
    await this.sendCapabilitiesIfChanged(projects, iso);
    const wait = await this.flushOutbox();
    if (wait !== null) { return wait; }
    if (this.pollingEnded || this.o.control.revoked) { return; }
    const polled = await this.o.control.poll();
    if (polled === 'stop') { this.pollingEnded = true; return; }
    if (!Array.isArray(polled)) { return polled.waitMs; }
    for (const cmd of polled) {
      if (this.stopped) { break; }
      await this.handle(cmd);
    }
  }

  /**
   * Shut down; every caller gets the same promise. First tell ONOSOO remote start is
   * off (bounded at HOST_CLOSE_DEADLINE_MS), then stop the active run and wait for it
   * to be finalized — ledger settled, branch imported, record written — bounded at
   * RUN_STOP_WAIT_MS. Then release the lock. Never rejects.
   */
  close(): Promise<void> {
    if (!this.closing) { this.closing = this.doClose(); }
    return this.closing;
  }

  private bounded<T>(work: Promise<T>, ms: number): Promise<void> {
    let handle: unknown = null;
    return Promise.race([
      work.then(() => undefined, () => undefined),
      new Promise<void>((r) => { handle = this.timers.setTimeout(r, ms); }),
    ]).finally(() => { if (handle !== null) { this.timers.clearTimeout(handle); } });
  }

  private async doClose(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer !== null) { this.timers.clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.lockRetryTimer !== null) { this.timers.clearTimeout(this.lockRetryTimer); this.lockRetryTimer = null; }
    if (this.lockedOut) { return; }
    try {
      // A boot that rejected must not make close() reject or keep the lock held.
      await this.booting?.catch(() => undefined);
      if (!this.o.control.revoked) {
        const projects = this.o.loadProjects();
        await this.bounded(this.o.control.sendCapabilities({ ...this.capabilities(projects, this.isolation), remote_start: false }), HOST_CLOSE_DEADLINE_MS);
      }
      const active = this.active;
      if (active) { await this.bounded(active.stop(), RUN_STOP_WAIT_MS); }
    } catch {
      // close() never rejects
    } finally {
      try { this.o.lock?.release(); } catch { /* best effort */ }
    }
  }

  // ─── Capabilities and isolation ───

  private async checkIsolation(projects: ApprovedProjects, force: boolean): Promise<Isolation> {
    const refusal = isolationRefusal(this.o.platform, projects.runnerUser);
    if (refusal) { this.isolation = { ok: false, reason: refusal }; return this.isolation; }
    const t = this.now().getTime();
    if (!force && this.isolation && t - this.isolationAt < ISOLATION_RECHECK_MS) { return this.isolation; }
    let out: ProbeOutcome;
    try { out = await this.o.probe(projects); } catch (err) { out = { ok: false, reason: `The isolation check failed: ${err instanceof Error ? err.message : String(err)}` }; }
    this.isolation = out.ok ? { ok: true, engines: out.engines, mirrors: out.mirrors } : { ok: false, reason: out.reason };
    this.isolationAt = t;
    return this.isolation;
  }

  private capabilities(projects: ApprovedProjects, iso: Isolation | null): Capabilities {
    const ok = iso?.ok === true;
    return {
      // Only what this machine would actually accept: switched on, isolated, and budgeted.
      remote_start: projects.remoteStart && ok && projects.dailyBudgetUsd !== null,
      // Never a path: ONOSOO only ever sees id, name and kinds.
      projects: projects.projects.map((p) => ({ id: p.id, name: p.name, kinds: [...p.kinds] })),
      engines: ok ? [...(iso as { engines: string[] }).engines] : [],
    };
  }

  private async sendCapabilitiesIfChanged(projects: ApprovedProjects, iso: Isolation): Promise<void> {
    const caps = this.capabilities(projects, iso);
    const json = JSON.stringify(caps);
    if (json === this.lastCaps) { return; }
    if (await this.o.control.sendCapabilities(caps)) { this.lastCaps = json; }
  }

  // ─── Results ───

  private async deliver(id: string, result: CommandResult): Promise<ResultOutcome> {
    const out = await this.o.control.postResult(id, result);
    if (out === 'delivered' || out === 'final' || out === 'drop') {
      this.o.audit.outboxRemove(id);
      if (out === 'delivered' && result.status !== 'running') {
        try { this.o.audit.appendOrThrow({ id, kind: '', phase: 'delivered', decision: result.status }); } catch { /* informational */ }
      }
    }
    return out;
  }

  /**
   * Retry undelivered results, oldest first. Stops at the first one that must be
   * retried; when ONOSOO rate-limited it, resolves the wait it asked for (and this
   * cycle does not poll), else null.
   */
  private async flushOutbox(): Promise<number | null> {
    for (const item of this.o.audit.outboxList()) {
      if (this.o.control.revoked) { return null; }
      const out = await this.deliver(item.id, item.result);
      if (out === 'retry') {
        const ra = this.o.control.lastRetryAfterMs;
        return typeof ra === 'number' ? ra : null;
      }
    }
    return null;
  }

  /** Record a result (final ones in the audit log), queue it, and try to deliver it now. */
  private async finalize(id: string, kind: string, result: CommandResult): Promise<void> {
    if (result.status !== 'running') {
      try {
        this.o.audit.appendOrThrow({ id, kind, phase: 'final', decision: result.status, message: result.message, runId: result.run_id ?? null });
      } catch { /* the outbox still carries it */ }
    }
    try { this.o.audit.outboxAdd(id, result); } catch { /* delivered directly below */ }
    await this.deliver(id, result);
  }

  // ─── Commands ───

  private lookup(runId: string): { record: RemoteRunRecord | null; handStarted: boolean } {
    const record = this.o.runs.get(runId);
    return { record, handStarted: record ? false : isHandStarted(this.o.stateDir, runId) };
  }

  /** Handle one polled command. Never throws. */
  async handle(cmd: PolledCommand): Promise<void> {
    if (this.seen.has(cmd.id) || this.lockedOut) { return; }
    const kind = 'invalid' in cmd ? 'invalid' : cmd.kind;
    const p = 'invalid' in cmd ? {} : cmd.payload;
    try {
      this.o.audit.appendOrThrow({
        id: cmd.id, kind, phase: 'received',
        requestedBy: 'invalid' in cmd ? null : cmd.requested_by ?? null,
        createdAt: 'invalid' in cmd ? null : cmd.created_at ?? null,
        projectId: typeof p.project_id === 'string' ? p.project_id : null,
        runId: typeof p.run_id === 'string' ? p.run_id : null,
        prd: typeof p.prd === 'string' ? p.prd : null,
      });
    } catch {
      this.seen.add(cmd.id);
      await this.o.control.postResult(cmd.id, { status: 'failed', message: AUDIT_UNAVAILABLE });
      return;
    }
    this.seen.add(cmd.id);
    try {
      await this.decideAndAct(cmd);
    } catch (err) {
      await this.finalize(cmd.id, kind, { status: 'failed', message: `MOAG could not handle this command: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async reject(id: string, kind: string, message: string): Promise<void> {
    try { this.o.audit.appendOrThrow({ id, kind, phase: 'decided', decision: 'rejected', message }); } catch { /* final below */ }
    await this.finalize(id, kind, { status: 'rejected', message });
  }

  private async decideAndAct(cmd: PolledCommand): Promise<void> {
    if ('invalid' in cmd) { await this.reject(cmd.id, 'invalid', cmd.invalid); return; }
    const v = validatePayload(cmd.kind, cmd.payload);
    if (!v.ok) { await this.reject(cmd.id, cmd.kind, v.message); return; }
    const projects = this.o.loadProjects();
    const value = v.value;

    if (value.kind === 'stop') {
      const msg = checkStop(this.lookup(value.payload.run_id));
      if (msg) { await this.reject(cmd.id, 'stop', msg); return; }
      const sup = this.active && this.active.runId === value.payload.run_id ? this.active : null;
      if (!sup) { await this.finalize(cmd.id, 'stop', { status: 'failed', message: 'This run is no longer running on this PC.' }); return; }
      this.o.audit.appendOrThrow({ id: cmd.id, kind: 'stop', phase: 'running', runId: sup.runId });
      // Do not hold up polling: the result follows the child's exit.
      void sup.stop().then((exit) => this.finalize(cmd.id, 'stop', exit.failure === FORCE_STOPPED_MESSAGE
        ? { status: 'failed', message: FORCE_STOPPED_MESSAGE, run_id: sup.runId }
        : { status: 'succeeded', message: 'The run was stopped.', run_id: sup.runId }));
      return;
    }

    // Everything else starts a run: claim the one slot before any await.
    if (this.slotClaimed || this.stopped) { await this.reject(cmd.id, value.kind, BUSY); return; }
    this.slotClaimed = true;
    let handedOff = false;
    try {
      const iso = await this.checkIsolation(projects, true);
      const isoReason = iso.ok ? null : iso.reason;
      if (value.kind === 'start-run') {
        handedOff = await this.startRunCommand(cmd.id, value.payload, projects, iso, isoReason);
      } else {
        handedOff = await this.resumeCommand(cmd.id, value.kind, value.payload, projects, iso, isoReason);
      }
    } finally {
      if (!handedOff) { this.slotClaimed = false; }
    }
  }

  private async startRunCommand(id: string, payload: StartRunPayload, projects: ApprovedProjects, iso: Isolation, isoReason: string | null): Promise<boolean> {
    const remaining = projects.dailyBudgetUsd === null ? 0 : this.o.ledger.remaining(projects.dailyBudgetUsd);
    const project = projects.projects.find((x) => x.id === payload.project_id);
    const decision = checkStartRun(payload, {
      projects, ledgerRemaining: remaining, engines: iso.ok ? iso.engines : [],
      projectDefaultEngine: project && this.o.projectDefaultEngine ? this.o.projectDefaultEngine(project) : null,
      active: false, isolation: isoReason, branchPrefix: this.o.branchPrefix,
    });
    if ('reject' in decision) { await this.reject(id, 'start-run', decision.reject); return false; }
    return this.launch(id, 'start-run', {
      project: decision.project, engine: decision.engine, allotment: decision.allotment,
      goal: payload.goal, prd: payload.prd, continueBranch: payload.continue_branch, projects, iso,
      planKind: payload.prd ? 'prd' : 'goal',
    });
  }

  private async resumeCommand(
    id: string, kind: 'approve' | 'skip' | 'retry', payload: { run_id: string; task_id?: string },
    projects: ApprovedProjects, iso: Isolation, isoReason: string | null,
  ): Promise<boolean> {
    const l = this.lookup(payload.run_id);
    const msg = kind === 'retry' ? checkRetry(l, payload.task_id, false) : checkGateDecision(kind, l, payload.task_id as string, false);
    if (msg) { await this.reject(id, kind, msg); return false; }
    const parent = l.record as RemoteRunRecord;
    if (isoReason) { await this.reject(id, kind, isoReason); return false; }
    if (!projects.remoteStart) { await this.reject(id, kind, REMOTE_START_OFF); return false; }
    if (projects.dailyBudgetUsd === null) { await this.reject(id, kind, NO_DAILY_BUDGET); return false; }
    const project = projects.projects.find((x) => x.id === parent.projectId);
    if (!project) { await this.reject(id, kind, `Project "${parent.projectId}" is no longer on this PC's approved list.`); return false; }
    const engines = iso.ok ? iso.engines : [];
    if (!engines.includes(parent.engine)) { await this.reject(id, kind, `The engine "${parent.engine}" is no longer available for remote runs on this PC.`); return false; }
    const remaining = this.o.ledger.remaining(projects.dailyBudgetUsd);
    if (parent.allotment > remaining + 1e-9) {
      await this.reject(id, kind, `This run asks for ${usd(parent.allotment)} but only ${usd(remaining)} of today's ${usd(projects.dailyBudgetUsd)} remote budget is left.`);
      return false;
    }
    const loaded = this.o.runs.load(parent.runId);
    if (!loaded) { await this.reject(id, kind, 'This run\'s record could not be read.'); return false; }
    const plan: Plan = loaded.plan;
    if (kind === 'retry') { prepareRetry(plan, payload.task_id); }
    else { prepareGateDecision(plan, payload.task_id as string, kind); }
    // The snapshot lives in a file: re-validate it like a freshly generated plan. A goal-only
    // run (planKind 'goal') never had a ship gate and does not get one now.
    const planKind: 'goal' | 'prd' = parent.planKind === 'goal' ? 'goal' : 'prd';
    const snapshot = transformGeneratedPlan(dehydratePlan(plan), { gates: planKind === 'prd' });
    const refusal = reviewRemotePlan(snapshot, engines);
    if (refusal) { await this.reject(id, kind, refusal); return false; }
    // Where the parent's work is:
    //   (a) the project's branch holds all of it — the parent finished and its import did not
    //       fail, or the project's tip IS the tip the parent reported → continue from it;
    //   (b) no branch in the project, and the parent finished cleanly saying it made no
    //       commits → a fresh branch from its start;
    //   (c) anything else → some of its commits exist only in the runner's mirror: continue
    //       from that copy. A project branch that exists but is behind is fine: the mirror's
    //       tip descends from it, so the import fast-forwards. Continuing from the project's
    //       branch here would reset the mirror's branch to it and drop that work.
    let projectTip: string | null = null;
    let exists: boolean;
    if (this.o.projectBranchTip) {
      projectTip = await this.o.projectBranchTip(project.path, parent.branch);
      exists = projectTip !== null;
    } else {
      exists = this.o.branchExists ? await this.o.branchExists(project.path, parent.branch) : true;
    }
    const delivered = parent.outcome === 'finished' && !parent.importError;
    const tipMatches = projectTip !== null && parent.branchTip !== undefined && projectTip === parent.branchTip;
    const cleanNoCommits = parent.outcome === 'finished' && parent.commitsSent === false && !parent.importError;
    const where = exists && (delivered || tipMatches)
      ? { continueBranch: parent.branch }
      : !exists && cleanNoCommits
        ? { startSha: parent.startSha }
        : { startSha: parent.startSha, resumeFromMirrorBranch: parent.branch, ...(parent.branchTip ? { expectedTip: parent.branchTip } : {}) };
    return this.launch(id, kind, {
      project, engine: parent.engine, allotment: parent.allotment, snapshot, planKind,
      ...where,
      parentRunId: parent.runId, projects, iso,
      // The parent is decided only once the new run is actually under way.
      onLaunched: () => {
        parent.decided = { kind, commandId: id, at: this.now().toISOString() };
        this.o.runs.save(parent);
      },
      onNotStarted: () => {
        const current = this.o.runs.get(parent.runId);
        if (current?.decided?.commandId === id) {
          delete current.decided;
          this.o.runs.save(current);
        }
      },
    });
  }

  /** Reserve, report running, bundle, record, spawn. Resolves true once the slot belongs to the run. */
  private async launch(id: string, kind: string, r: LaunchRequest): Promise<boolean> {
    const daily = r.projects.dailyBudgetUsd as number;
    const runId = this.o.newRunId();
    if (!this.o.ledger.reserve(runId, r.allotment, daily)) {
      const remaining = this.o.ledger.remaining(daily);
      await this.reject(id, kind, `This run asks for ${usd(r.allotment)} but only ${usd(remaining)} of today's ${usd(daily)} remote budget is left.`);
      return false;
    }
    this.o.audit.appendOrThrow({ id, kind, phase: 'decided', decision: 'accepted', projectId: r.project.id, runId });
    await this.finalize(id, kind, { status: 'running', message: 'Preparing the run on this PC.', run_id: runId });

    const branch = r.continueBranch ?? r.resumeFromMirrorBranch ?? branchNameFor(this.o.branchPrefix, r.project.id, runId);
    const inbound = await this.o.exportBundle(r.project.path, {
      ...(r.continueBranch ? { continueBranch: r.continueBranch } : {}),
      ...(r.startSha ? { startSha: r.startSha } : {}),
      haveShas: r.iso.ok ? r.iso.mirrors[r.project.id] ?? [] : [],
    });
    if (!inbound.ok || this.stopped) {
      this.o.ledger.settle(runId);
      await this.finalize(id, kind, { status: 'failed', message: inbound.ok ? 'MOAG is shutting down.' : inbound.reason, run_id: runId });
      return false;
    }
    const record: RemoteRunRecord = {
      runId, projectId: r.project.id, commandId: id, kind, ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}),
      branch, startSha: inbound.startSha, engine: r.engine, allotment: r.allotment, startedAt: this.now().toISOString(),
      exitCode: null, outcome: 'live', gateTaskId: null, planKind: r.planKind,
      snapshot: r.snapshot ?? dehydratePlan(createEmptyPlan(r.goal ? r.goal.slice(0, 80) : 'Remote run')),
    };
    this.o.runs.save(record);
    const engines = r.iso.ok ? r.iso.engines : [r.engine];
    const specLine = JSON.stringify({
      op: 'run', runId, projectId: r.project.id, branch, branchPrefix: this.o.branchPrefix, baseSha: inbound.baseSha, startSha: inbound.startSha,
      engine: r.engine, engines, allotment: r.allotment, bundleBytes: inbound.bundle.length, engineEnv: this.o.engineEnv, planKind: r.planKind,
      ...(r.resumeFromMirrorBranch ? { resumeFromMirrorBranch: r.resumeFromMirrorBranch } : {}),
      ...(r.expectedTip ? { expectedTip: r.expectedTip } : {}),
      ...(r.goal ? { goal: r.goal } : {}), ...(r.prd ? { prd: r.prd } : {}), ...(r.snapshot ? { snapshot: r.snapshot } : {}),
    });
    let startedReported = false;
    const sup = this.o.supervisorFactory({
      record, project: r.project, specLine, bundle: inbound.bundle,
      onStarted: (rid) => {
        startedReported = true;
        void this.finalize(id, kind, { status: 'succeeded', message: 'The run started on this PC.', run_id: rid });
      },
      onExit: (exit) => {
        if (this.active === sup) { this.active = null; }
        this.slotClaimed = false;
        if (!startedReported) {
          try { r.onNotStarted?.(); } catch { /* best effort */ }
          void this.finalize(id, kind, { status: 'failed', message: exit.failure ?? 'The run ended before it started.', run_id: runId });
        }
      },
    });
    this.active = sup;
    this.o.audit.appendOrThrow({ id, kind, phase: 'running', runId });
    sup.start();
    try { r.onLaunched?.(); } catch { /* the run is under way regardless */ }
    return true;
  }
}

/** Build a host. */
export function createCommandHost(opts: CommandHostOptions): CommandHost {
  return new CommandHost(opts);
}
