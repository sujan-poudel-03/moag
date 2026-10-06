// ─── Server ↔ worker protocol ───
//
// A worker is a child process that runs exactly one job and reports on stdout
// as JSONL — the headless CLI's vocabulary plus a few worker-only events. The
// server parses each line with `parseWorkerLine` (closed set; anything else is
// dropped) and folds run events into a `RunView` with the pure `foldRunEvent`.
// This module imports nothing that touches `vscode` or spawns processes.

import { ENGINE_IDS, EngineId, RunnerState, TaskStatus } from '../models/types';

// ─── Jobs ───

export interface RunJob {
  kind: 'run';
  runId: string;
  workspace: string;
  planPath: string;
  startPlaylistIndex: number;
  verify: true;
  allowedEngines: EngineId[];
  /**
   * Server-written standards job file: the version frozen at run start, its prompt text
   * and the base ref its check diffs against. Absent = the run has no standards (a plan
   * approved before the project had any); the worker then verifies with `--no-standards`.
   */
  standardsPath?: string;
}

export interface PlanJob {
  kind: 'plan';
  mode: 'delta' | 'initial';
  /** A server-owned EMPTY scratch dir — never the project repo, so no repo-shipped engine config loads. */
  workspace: string;
  planPath: string;
  outPath: string;
  engine: EngineId;
  /** Server-generated repository file listing (plain text) appended to the planning prompt. */
  repoListingPath?: string;
  /**
   * Server-written standards job file (the approved version, frozen). The planner prompt
   * carries its text; a standards file in the repository is never read.
   */
  standardsPath?: string;
}

export interface ProbeJob { kind: 'probe'; }

export type WorkerJob = RunJob | PlanJob | ProbeJob;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isEngine = (v: unknown): v is EngineId => typeof v === 'string' && (ENGINE_IDS as readonly string[]).includes(v);

/** Validate a job document read from disk. Returns null when malformed. */
export function parseJob(raw: unknown): WorkerJob | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const j = raw as Record<string, unknown>;
  if (j.kind === 'probe') { return { kind: 'probe' }; }
  if (j.kind === 'run') {
    if (!isStr(j.runId) || !isStr(j.workspace) || !isStr(j.planPath) || j.verify !== true) { return null; }
    if (typeof j.startPlaylistIndex !== 'number' || !Number.isInteger(j.startPlaylistIndex) || j.startPlaylistIndex < 0) { return null; }
    if (!Array.isArray(j.allowedEngines) || !j.allowedEngines.every(isEngine)) { return null; }
    if (j.standardsPath !== undefined && !isStr(j.standardsPath)) { return null; }
    return {
      kind: 'run', runId: j.runId, workspace: j.workspace, planPath: j.planPath,
      startPlaylistIndex: j.startPlaylistIndex, verify: true, allowedEngines: [...j.allowedEngines],
      ...(isStr(j.standardsPath) ? { standardsPath: j.standardsPath } : {}),
    };
  }
  if (j.kind === 'plan') {
    if ((j.mode !== 'delta' && j.mode !== 'initial') || !isStr(j.workspace) || !isStr(j.planPath)
      || !isStr(j.outPath) || !isEngine(j.engine)) { return null; }
    if (j.repoListingPath !== undefined && !isStr(j.repoListingPath)) { return null; }
    if (j.standardsPath !== undefined && !isStr(j.standardsPath)) { return null; }
    return {
      kind: 'plan', mode: j.mode, workspace: j.workspace, planPath: j.planPath, outPath: j.outPath, engine: j.engine,
      ...(isStr(j.repoListingPath) ? { repoListingPath: j.repoListingPath } : {}),
      ...(isStr(j.standardsPath) ? { standardsPath: j.standardsPath } : {}),
    };
  }
  return null;
}

// ─── Events ───

export const HEADLESS_EVENTS = [
  'state', 'task-started', 'task-completed', 'task-failed', 'task-escalate',
  'incident', 'error', 'budget-exceeded', 'manual-gate',
] as const;

export const WORKER_ONLY_EVENTS = [
  'cost', 'task-engine', 'task-error-tail', 'plan-outcome', 'probe-result', 'run-finished', 'warning', 'task-pid',
] as const;

export const DELTA_OUTCOME_KINDS = ['no-delta', 'engine-failed', 'parse-failed', 'all-rejected', 'appended'] as const;
export type DeltaOutcomeKind = typeof DELTA_OUTCOME_KINDS[number];

export interface ProbeRow { id: EngineId; available: boolean; version?: string; error?: string; }

export type WorkerEvent =
  | { event: 'state'; state: string }
  | { event: 'task-started'; id: string; name: string }
  | {
    event: 'task-completed' | 'task-failed'; id: string; name: string;
    /** The task's final status: task-completed also reports Skipped tasks, task-failed also Blocked ones. */
    status?: TaskStatus;
    /** True only when the engine ran the task to its own verdict (see run-worker); stack evidence needs it. */
    engineRan?: boolean;
  }
  | { event: 'task-escalate'; id: string; name: string; category: string }
  | { event: 'incident'; id: string; name: string; summary: string; issueUrl: string | null }
  | { event: 'error'; message: string }
  | { event: 'budget-exceeded'; totalCost: number; budget: number }
  | { event: 'manual-gate'; id: string; name: string }
  /**
   * Spend of one engine call. `source`: 'reported' = the engine's own figure,
   * 'estimated' = derived by MOAG, 'none' = the call reported no cost (usd 0;
   * its real spend is bounded only by the per-call cap). Absent on old lines.
   */
  | { event: 'cost'; usd: number; source?: CostSource }
  | { event: 'task-engine'; id: string; engine: EngineId }
  | { event: 'task-error-tail'; id: string; tail: string }
  | { event: 'plan-outcome'; kind: DeltaOutcomeKind }
  | { event: 'probe-result'; engines: ProbeRow[] }
  | { event: 'run-finished'; code: number }
  | { event: 'warning'; message: string }
  /** A task child process (engine CLI, shell/gate command) started or ended. Server-internal: recorded in job.lock, never fanned out. */
  | { event: 'task-pid'; pid: number; alive: boolean }
  | { event: 'verify'; name: string; data: Record<string, unknown> };

/** Closed set of `cost` event sources. */
export const COST_SOURCES = ['reported', 'estimated', 'none'] as const;
export type CostSource = typeof COST_SOURCES[number];

const RUNNER_STATES = new Set<string>(Object.values(RunnerState));
const TASK_STATUSES = new Set<string>(Object.values(TaskStatus));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Parse one stdout line from a worker. Returns null for non-JSON, for unknown
 * events and for known events missing required fields — a stray `console.log`
 * from an engine adapter can never be mistaken for protocol.
 */
export function parseWorkerLine(line: string): WorkerEvent | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
  const o = raw as Record<string, unknown>;
  const ev = o.event;
  if (typeof ev !== 'string') { return null; }

  switch (ev) {
    case 'state':
      return RUNNER_STATES.has(str(o.state)) ? { event: 'state', state: str(o.state) } : null;
    case 'task-started':
      return isStr(o.id) ? { event: ev, id: o.id, name: str(o.name) } : null;
    case 'task-completed':
    case 'task-failed':
      return isStr(o.id)
        ? {
          event: ev, id: o.id, name: str(o.name),
          ...(TASK_STATUSES.has(str(o.status)) ? { status: o.status as TaskStatus } : {}),
          ...(typeof o.engineRan === 'boolean' ? { engineRan: o.engineRan } : {}),
        }
        : null;
    case 'task-escalate':
      return isStr(o.id) ? { event: ev, id: o.id, name: str(o.name), category: str(o.category) } : null;
    case 'incident':
      return isStr(o.id)
        ? { event: ev, id: o.id, name: str(o.name), summary: str(o.summary), issueUrl: typeof o.issueUrl === 'string' ? o.issueUrl : null }
        : null;
    case 'error':
      return { event: 'error', message: str(o.message) };
    case 'budget-exceeded':
      return finite(o.totalCost) && finite(o.budget) ? { event: ev, totalCost: o.totalCost, budget: o.budget } : null;
    case 'manual-gate':
      return isStr(o.id) ? { event: ev, id: o.id, name: str(o.name) } : null;
    case 'cost':
      return finite(o.usd) && o.usd >= 0
        ? { event: 'cost', usd: o.usd, ...((COST_SOURCES as readonly unknown[]).includes(o.source) ? { source: o.source as CostSource } : {}) }
        : null;
    case 'task-engine':
      return isStr(o.id) && isEngine(o.engine) ? { event: ev, id: o.id, engine: o.engine } : null;
    case 'task-error-tail':
      return isStr(o.id) && typeof o.tail === 'string' ? { event: ev, id: o.id, tail: o.tail } : null;
    case 'plan-outcome':
      return (DELTA_OUTCOME_KINDS as readonly string[]).includes(str(o.kind))
        ? { event: ev, kind: o.kind as DeltaOutcomeKind }
        : null;
    case 'probe-result': {
      if (!Array.isArray(o.engines)) { return null; }
      const rows: ProbeRow[] = [];
      for (const r of o.engines as unknown[]) {
        const x = r as Record<string, unknown>;
        if (!x || !isEngine(x.id) || typeof x.available !== 'boolean') { return null; }
        rows.push({
          id: x.id, available: x.available,
          ...(typeof x.version === 'string' ? { version: x.version } : {}),
          ...(typeof x.error === 'string' ? { error: x.error } : {}),
        });
      }
      return { event: ev, engines: rows };
    }
    case 'run-finished':
      return finite(o.code) ? { event: ev, code: o.code } : null;
    case 'warning':
      return { event: 'warning', message: str(o.message) };
    case 'task-pid':
      return typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 0 && typeof o.alive === 'boolean'
        ? { event: ev, pid: o.pid, alive: o.alive }
        : null;
    default:
      if (/^verify-[a-z-]{1,32}$/.test(ev)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { event: _e, ts: _t, ...data } = o;
        return { event: 'verify', name: ev, data };
      }
      return null;
  }
}

// ─── Run view ───

export interface RunView {
  runnerState: string;
  tasks: Record<string, TaskStatus>;
  costUsd: number;
  gate?: { taskId: string; name: string };
  haltReason: 'manual-gate' | 'budget-exceeded' | null;
}

export function emptyRunView(): RunView {
  return { runnerState: RunnerState.Idle, tasks: {}, costUsd: 0, haltReason: null };
}

/** Fold one event into a new view. Pure; never mutates `view`. */
export function foldRunEvent(view: RunView, ev: WorkerEvent): RunView {
  switch (ev.event) {
    case 'state':
      return { ...view, runnerState: ev.state };
    case 'task-started':
      return { ...view, tasks: { ...view.tasks, [ev.id]: TaskStatus.Running } };
    // task-completed also reports a Skipped task, task-failed a Blocked one: the
    // event's status says which. Any other status falls back to the event's own.
    case 'task-completed':
      return { ...view, tasks: { ...view.tasks, [ev.id]: ev.status === TaskStatus.Skipped ? TaskStatus.Skipped : TaskStatus.Completed } };
    case 'task-failed':
      return { ...view, tasks: { ...view.tasks, [ev.id]: ev.status === TaskStatus.Blocked ? TaskStatus.Blocked : TaskStatus.Failed } };
    case 'cost':
      return { ...view, costUsd: view.costUsd + ev.usd };
    case 'manual-gate':
      return { ...view, gate: { taskId: ev.id, name: ev.name }, haltReason: 'manual-gate' };
    case 'budget-exceeded':
      return { ...view, haltReason: view.haltReason ?? 'budget-exceeded' };
    default:
      return view;
  }
}

/**
 * Combine a run's recorded view (earlier segments) with a later segment's view.
 * A resumed segment's worker only reports the tasks it touched, so per-task
 * statuses are layered (later wins) and cost is summed; runner state, gate and
 * halt reason come from the later segment. Pure.
 */
export function mergeRunViews(earlier: RunView | undefined | null, later: RunView): RunView {
  if (!earlier) { return later; }
  return {
    ...later,
    tasks: { ...earlier.tasks, ...later.tasks },
    costUsd: (earlier.costUsd ?? 0) + (later.costUsd ?? 0),
  };
}

/** Run statuses a worker exit code maps to. */
export type ExitRunStatus = 'completed' | 'gaps' | 'error' | 'awaiting-approval' | 'budget';

/** Headless exit-code contract: 0 ok · 1 gaps · 2 error · 3 ship gate · 4 cost ceiling. */
export function exitToRunStatus(code: number | null): ExitRunStatus {
  switch (code) {
    case 0: return 'completed';
    case 1: return 'gaps';
    case 3: return 'awaiting-approval';
    case 4: return 'budget';
    default: return 'error';
  }
}
