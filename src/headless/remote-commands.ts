// ─── Remote commands: decisions and resume transforms (pure) ───
//
// What the daemon decides about each ONOSOO command before anything runs. ONOSOO
// checks too, but its view can be stale: the machine is the authority (PROTOCOL.md
// §2), so every check here runs against the LOCAL projects.json, ledger and
// isolation state at the moment the command is handled.
//
// Every refusal is a sentence a manager can read; it becomes the command's
// `rejected` result. Nothing here does I/O.

import { Plan, PlanFile, TaskStatus } from '../models/types';
import { prepareGateResume, GateResumeKind, GateResumeResult } from '../shared/ship-gate';
import { PLANNER_LOCKED_ENGINES } from '../shared/worker-config';
import type { ApprovedProjects, ApprovedProject } from './onosoo-projects';
import type { RemoteRunRecord } from './remote-runs';

export const MAX_PRD_BYTES = 100 * 1024;
/** What a start-run without `budget_usd` asks for. */
export const DEFAULT_RUN_BUDGET_USD = 10;

export const REMOTE_START_OFF = 'Remote start is switched off on this PC';
export const NO_DAILY_BUDGET = 'Set daily_budget_usd in projects.json to allow remote starts';
export const BUSY = 'Another remote run is already in progress on this PC. Try again when it finishes.';
export const HAND_STARTED = 'This run was started by hand on this PC; it can only be controlled there.';
export const UNKNOWN_RUN = 'No run with this id is known to this PC.';

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** `$5.00` */
export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ─── Payloads ───

export interface StartRunPayload {
  project_id: string;
  goal?: string;
  prd?: string;
  prd_title?: string;
  engine?: string;
  budget_usd?: number;
  continue_branch?: string;
}
export interface RunPayload { run_id: string; task_id?: string }

export type ValidPayload =
  | { kind: 'start-run'; payload: StartRunPayload }
  | { kind: 'stop'; payload: RunPayload }
  | { kind: 'retry'; payload: RunPayload }
  | { kind: 'approve' | 'skip'; payload: Required<RunPayload> };

const optStr = (v: unknown): v is string | undefined => v === undefined || v === null || typeof v === 'string';

/** Shape-check a command payload. Never throws. */
export function validatePayload(kind: string, payload: unknown): { ok: true; value: ValidPayload } | { ok: false; message: string } {
  const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { return bad('The command has no payload.'); }
  const p = payload as Record<string, unknown>;
  switch (kind) {
    case 'stop':
    case 'retry':
    case 'approve':
    case 'skip': {
      if (typeof p.run_id !== 'string' || !RUN_ID_RE.test(p.run_id)) { return bad('The command does not name a valid run.'); }
      const needsTask = kind === 'approve' || kind === 'skip';
      if (p.task_id !== undefined && p.task_id !== null && (typeof p.task_id !== 'string' || !TASK_ID_RE.test(p.task_id))) {
        return bad('The command names an invalid task.');
      }
      if (needsTask && typeof p.task_id !== 'string') { return bad(`${kind === 'approve' ? 'Approve' : 'Skip'} needs the ship-gate task.`); }
      const value: RunPayload = { run_id: p.run_id, ...(typeof p.task_id === 'string' ? { task_id: p.task_id } : {}) };
      return { ok: true, value: { kind, payload: value } as ValidPayload };
    }
    case 'start-run': {
      if (typeof p.project_id !== 'string' || p.project_id.length === 0) { return bad('The run does not name a project.'); }
      for (const f of ['goal', 'prd', 'prd_title', 'engine', 'continue_branch'] as const) {
        if (!optStr(p[f])) { return bad(`The run's ${f} must be text.`); }
      }
      if (p.budget_usd !== undefined && p.budget_usd !== null && typeof p.budget_usd !== 'number') {
        return bad('The run\'s budget must be a number of dollars.');
      }
      const value: StartRunPayload = { project_id: p.project_id };
      if (typeof p.goal === 'string' && p.goal.trim()) { value.goal = p.goal; }
      if (typeof p.prd === 'string' && p.prd.trim()) { value.prd = p.prd; }
      if (typeof p.prd_title === 'string') { value.prd_title = p.prd_title.slice(0, 200); }
      if (typeof p.engine === 'string' && p.engine) { value.engine = p.engine; }
      if (typeof p.budget_usd === 'number') { value.budget_usd = p.budget_usd; }
      if (typeof p.continue_branch === 'string' && p.continue_branch) { value.continue_branch = p.continue_branch; }
      return { ok: true, value: { kind: 'start-run', payload: value } };
    }
    default:
      return bad(`MOAG does not handle "${String(kind).slice(0, 40)}" commands.`);
  }
}

// ─── start-run ───

export interface StartRunContext {
  projects: ApprovedProjects;
  /** What is left of today's remote budget. */
  ledgerRemaining: number;
  /** Engines the runner account can use here. */
  engines: string[];
  /** The project's own default engine (its .moag config), when known. */
  projectDefaultEngine?: string | null;
  /** A remote run is already active. */
  active: boolean;
  /** Why remote work is impossible on this machine (isolation), or null. */
  isolation: string | null;
  /** Delivery branch namespace (git.branchPrefix), e.g. `moag/`. */
  branchPrefix: string;
}

export type StartRunDecision =
  | { reject: string }
  | { engine: string; allotment: number; project: ApprovedProject };

/** Decide a start-run. The first failing check wins; the order is the order a person would fix things in. */
export function checkStartRun(payload: StartRunPayload, ctx: StartRunContext): StartRunDecision {
  if (ctx.isolation) { return { reject: ctx.isolation }; }
  if (!ctx.projects.remoteStart) { return { reject: REMOTE_START_OFF }; }
  const daily = ctx.projects.dailyBudgetUsd;
  if (daily === null) { return { reject: NO_DAILY_BUDGET }; }
  if (ctx.active) { return { reject: BUSY }; }

  const project = ctx.projects.projects.find((p) => p.id === payload.project_id);
  if (!project) { return { reject: `Project "${String(payload.project_id).slice(0, 64)}" is not on this PC's approved list.` }; }

  if (!payload.goal && !payload.prd) { return { reject: 'The run needs a goal or a PRD.' }; }
  if (payload.prd && Buffer.byteLength(payload.prd, 'utf-8') > MAX_PRD_BYTES) { return { reject: 'The PRD is larger than 100 KB.' }; }

  if (payload.budget_usd !== undefined && !(Number.isFinite(payload.budget_usd) && payload.budget_usd > 0)) {
    return { reject: 'The run\'s budget must be more than $0.' };
  }
  const remaining = Math.max(0, ctx.ledgerRemaining);
  let allotment: number;
  if (payload.budget_usd !== undefined) {
    if (payload.budget_usd > remaining + 1e-9) {
      return { reject: `This run asks for ${usd(payload.budget_usd)} but only ${usd(remaining)} of today's ${usd(daily)} remote budget is left.` };
    }
    allotment = payload.budget_usd;
  } else {
    allotment = Math.min(DEFAULT_RUN_BUDGET_USD, remaining);
    if (!(allotment > 0)) {
      return { reject: `This run asks for ${usd(DEFAULT_RUN_BUDGET_USD)} but only ${usd(remaining)} of today's ${usd(daily)} remote budget is left.` };
    }
  }

  if (ctx.engines.length === 0) { return { reject: 'No AI engine is set up for remote runs on this PC.' }; }
  let engine: string;
  if (payload.engine) {
    if (!ctx.engines.includes(payload.engine)) { return { reject: `The engine "${payload.engine.slice(0, 40)}" is not available for remote runs on this PC.` }; }
    engine = payload.engine;
  } else if (ctx.projectDefaultEngine && ctx.engines.includes(ctx.projectDefaultEngine)) {
    engine = ctx.projectDefaultEngine;
  } else {
    engine = ctx.engines[0];
  }
  if (payload.prd && !(PLANNER_LOCKED_ENGINES as readonly string[]).includes(engine)) {
    return { reject: `Planning from a PRD needs claude, codex or ollama; "${engine}" cannot plan with its file access locked down.` };
  }

  if (payload.continue_branch !== undefined) {
    const b = payload.continue_branch;
    if (!BRANCH_RE.test(b) || !b.startsWith(ctx.branchPrefix) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) {
      return { reject: `The branch to continue must be one of MOAG's own branches (${ctx.branchPrefix}…).` };
    }
  }
  return { engine, allotment, project };
}

// ─── stop / approve / skip / retry ───

type Lookup = { record: RemoteRunRecord | null; handStarted: boolean };

function missing(l: Lookup): string | null {
  if (l.record) { return null; }
  return l.handStarted ? HAND_STARTED : UNKNOWN_RUN;
}

/** Null when `stop` may proceed. */
export function checkStop(l: Lookup): string | null {
  const m = missing(l);
  if (m) { return m; }
  if (l.record!.outcome !== 'live') { return 'This run has already ended.'; }
  return null;
}

/** Null when `approve`/`skip` of `taskId` may proceed. */
export function checkGateDecision(kind: GateResumeKind, l: Lookup, taskId: string, active: boolean): string | null {
  const m = missing(l);
  if (m) { return m; }
  const r = l.record!;
  if (r.outcome === 'live') { return 'This run is still in progress; it can be approved or skipped once it halts at its ship gate.'; }
  if (r.decided) { return `This run has already been decided (${r.decided.kind}).`; }
  if (!r.gateTaskId) { return 'This run is not waiting at a ship gate.'; }
  if (r.gateTaskId !== taskId) { return 'That task is not the ship gate this run is waiting at.'; }
  if (active) { return BUSY; }
  void kind;
  return null;
}

const RETRYABLE = new Set<string>([TaskStatus.Failed, TaskStatus.Blocked, TaskStatus.Skipped]);

function snapshotTasks(snapshot: PlanFile): Array<{ id: string; status?: string }> {
  return (snapshot.playlists ?? []).flatMap((pl) => pl.tasks ?? []);
}

/** Null when `retry` (of `taskId`, or of every failed task) may proceed. */
export function checkRetry(l: Lookup, taskId: string | undefined, active: boolean): string | null {
  const m = missing(l);
  if (m) { return m; }
  const r = l.record!;
  if (r.outcome === 'live') { return 'This run is still in progress; it can be retried once it ends.'; }
  if (r.decided) { return `This run has already been decided (${r.decided.kind}).`; }
  if (r.gateTaskId) { return 'This run is waiting at its ship gate; use approve or skip.'; }
  const tasks = snapshotTasks(r.snapshot);
  if (taskId !== undefined) {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) { return 'That task is not in this run.'; }
    if (!RETRYABLE.has(String(t.status ?? TaskStatus.Pending))) { return 'That task has nothing to retry.'; }
  } else if (!tasks.some((t) => t.status === TaskStatus.Failed)) {
    return 'This run has no failed task to retry.';
  }
  if (active) { return BUSY; }
  return null;
}

// ─── Resume transforms ───

/** Every task id that depends on one in `seeds`, transitively (seeds not included). */
function dependents(plan: Plan, seeds: Set<string>): Set<string> {
  const all = plan.playlists.flatMap((pl) => pl.tasks);
  const closure = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of all) {
      if (closure.has(t.id)) { continue; }
      if ((t.dependsOn ?? []).some((d) => closure.has(d))) { closure.add(t.id); grew = true; }
    }
  }
  for (const s of seeds) { closure.delete(s); }
  return closure;
}

/**
 * Make a finished run's plan retryable: the target (or every Failed task) goes back to
 * Pending, and so does every transitive dependent the failure left Failed, Blocked or
 * Skipped. Returns the ids reset. Mutates `plan`.
 */
export function prepareRetry(plan: Plan, taskId?: string): string[] {
  const all = plan.playlists.flatMap((pl) => pl.tasks);
  const targets = taskId !== undefined
    ? all.filter((t) => t.id === taskId && RETRYABLE.has(t.status))
    : all.filter((t) => t.status === TaskStatus.Failed);
  const seeds = new Set(targets.map((t) => t.id));
  const reset: string[] = [];
  for (const t of targets) { t.status = TaskStatus.Pending; reset.push(t.id); }
  const down = dependents(plan, seeds);
  for (const t of all) {
    if (down.has(t.id) && RETRYABLE.has(t.status)) { t.status = TaskStatus.Pending; reset.push(t.id); }
  }
  return reset;
}

/** approve/skip: the server's own gate transform (a skip never ships). */
export function prepareGateDecision(plan: Plan, gateTaskId: string, kind: GateResumeKind): GateResumeResult {
  return prepareGateResume(plan, gateTaskId, kind);
}
