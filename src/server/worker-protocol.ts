// ─── Server ↔ worker protocol ───
//
// A worker is a child process that runs exactly one job and reports on stdout
// as JSONL — the headless CLI's vocabulary plus a few worker-only events. The
// server parses each line with `parseWorkerLine` (closed set; anything else is
// dropped) and folds run events into a `RunView` with the pure `foldRunEvent`.
// This module imports nothing that touches `vscode` or spawns processes.

import {
  DEPENDENCY_ECOSYSTEMS, DEPENDENCY_STAGES, DEPENDENCY_TRIGGERS, ENGINE_IDS,
  DependencyEcosystem, DependencyEvent, DependencyEventName, DependencyStage, DependencyTrigger,
  EngineId, RunnerState, TaskStatus,
} from '../models/types';

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
  'dependencies-installed', 'dependencies-install-failed', 'dependencies-not-installed',
] as const;

export const WORKER_ONLY_EVENTS = [
  'cost', 'task-engine', 'task-error-tail', 'plan-outcome', 'probe-result', 'run-finished', 'warning', 'task-pid',
  'task-changes',
] as const;

/** One file a task changed, as the `task-changes` line reports it. */
export interface TaskChangesFileLine {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  old_path?: string;
  binary: boolean;
  added: number | null;
  removed: number | null;
}

/**
 * The `task-changes` line (headless `moag run` only; the run worker does not emit it).
 * Defined here rather than imported so the protocol never depends on `runner/`.
 */
export interface TaskChangesLine {
  task_id: string;
  status: 'completed' | 'failed';
  source: 'commit' | 'worktree';
  base_sha: string;
  commit_sha: string | null;
  branch: string | null;
  files: TaskChangesFileLine[];
  diff: { text: string; truncated: boolean; bytes: number; redactions: number } | null;
  diff_error?: string;
}

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
  /** What one task changed in the repository (see {@link TaskChangesLine}). */
  | ({ event: 'task-changes' } & TaskChangesLine)
  | { event: 'verify'; name: string; data: Record<string, unknown> }
  /** An automatic dependency install (or the note that none was done) before a step that needed it. */
  | ({ event: DependencyEventName } & Omit<DependencyEvent, 'event'>);

/** Closed set of `cost` event sources. */
export const COST_SOURCES = ['reported', 'estimated', 'none'] as const;
export type CostSource = typeof COST_SOURCES[number];

const RUNNER_STATES = new Set<string>(Object.values(RunnerState));
const TASK_STATUSES = new Set<string>(Object.values(TaskStatus));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const DEPENDENCY_TAIL_CHARS = 2000;

/** Validate one dependency-install event line; null unless every field has its documented shape. */
function parseDependencyEvent(ev: DependencyEventName, o: Record<string, unknown>): WorkerEvent | null {
  if (!(DEPENDENCY_ECOSYSTEMS as readonly unknown[]).includes(o.ecosystem)) { return null; }
  if (!(DEPENDENCY_STAGES as readonly unknown[]).includes(o.stage)) { return null; }
  if (!(DEPENDENCY_TRIGGERS as readonly unknown[]).includes(o.trigger)) { return null; }
  if (typeof o.dir !== 'string') { return null; }
  if (!(typeof o.command === 'string' || o.command === null)) { return null; }
  if (ev !== 'dependencies-not-installed' && typeof o.command !== 'string') { return null; }
  if (!finite(o.durationMs) || o.durationMs < 0) { return null; }
  if (!(o.exitCode === null || (typeof o.exitCode === 'number' && Number.isInteger(o.exitCode)))) { return null; }
  if (typeof o.timedOut !== 'boolean') { return null; }
  if (typeof o.tail !== 'string') { return null; }
  if (!(typeof o.note === 'string' || o.note === null)) { return null; }
  if (o.taskId !== undefined && !isStr(o.taskId)) { return null; }
  return {
    event: ev,
    stage: o.stage as DependencyStage,
    ...(isStr(o.taskId) ? { taskId: o.taskId } : {}),
    ecosystem: o.ecosystem as DependencyEcosystem,
    dir: o.dir,
    trigger: o.trigger as DependencyTrigger,
    command: o.command as string | null,
    durationMs: o.durationMs,
    exitCode: o.exitCode as number | null,
    timedOut: o.timedOut,
    tail: o.tail.length > DEPENDENCY_TAIL_CHARS ? o.tail.slice(o.tail.length - DEPENDENCY_TAIL_CHARS) : o.tail,
    note: o.note as string | null,
  };
}

const FILE_STATUSES = new Set(['added', 'modified', 'deleted', 'renamed']);
const countOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Validate a `task-changes` line and rebuild it from known keys only; null when malformed. */
function parseTaskChanges(o: Record<string, unknown>): WorkerEvent | null {
  if (!isStr(o.task_id)) { return null; }
  if (o.status !== 'completed' && o.status !== 'failed') { return null; }
  if (o.source !== 'commit' && o.source !== 'worktree') { return null; }
  if (typeof o.base_sha !== 'string' || !strOrNull(o.commit_sha) || !strOrNull(o.branch)) { return null; }
  if (!Array.isArray(o.files)) { return null; }
  const files: TaskChangesFileLine[] = [];
  for (const f of o.files as unknown[]) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) { return null; }
    const x = f as Record<string, unknown>;
    if (typeof x.path !== 'string' || !FILE_STATUSES.has(str(x.status)) || typeof x.binary !== 'boolean') { return null; }
    if (!countOrNull(x.added) || !countOrNull(x.removed)) { return null; }
    if (x.old_path !== undefined && typeof x.old_path !== 'string') { return null; }
    files.push({
      path: x.path,
      status: x.status as TaskChangesFileLine['status'],
      ...(typeof x.old_path === 'string' ? { old_path: x.old_path } : {}),
      binary: x.binary,
      added: x.added,
      removed: x.removed,
    });
  }
  let diff: TaskChangesLine['diff'] = null;
  if (o.diff !== null) {
    if (!o.diff || typeof o.diff !== 'object' || Array.isArray(o.diff)) { return null; }
    const d = o.diff as Record<string, unknown>;
    if (typeof d.text !== 'string' || typeof d.truncated !== 'boolean') { return null; }
    if (!finite(d.bytes) || d.bytes < 0) { return null; }
    if (typeof d.redactions !== 'number' || !Number.isInteger(d.redactions) || d.redactions < 0) { return null; }
    diff = { text: d.text, truncated: d.truncated, bytes: d.bytes, redactions: d.redactions };
  }
  if (o.diff_error !== undefined && typeof o.diff_error !== 'string') { return null; }
  return {
    event: 'task-changes',
    task_id: o.task_id,
    status: o.status,
    source: o.source,
    base_sha: o.base_sha,
    commit_sha: o.commit_sha,
    branch: o.branch,
    files,
    diff,
    ...(typeof o.diff_error === 'string' ? { diff_error: o.diff_error } : {}),
  };
}

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
    case 'dependencies-installed':
    case 'dependencies-install-failed':
    case 'dependencies-not-installed':
      return parseDependencyEvent(ev, o);
    case 'task-pid':
      return typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 0 && typeof o.alive === 'boolean'
        ? { event: ev, pid: o.pid, alive: o.alive }
        : null;
    case 'task-changes':
      return parseTaskChanges(o);
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
