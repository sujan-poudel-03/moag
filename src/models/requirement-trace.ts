// ─── Requirement trace — deterministic evidence per PRD requirement ───
//
// Pure functions over `plan.requirementTrace`. No `vscode`, no `fs`, no `path`: the PRD loop,
// the runner's release task, the headless `moag trace` verb and the unit tests all share it.
//
// Only deterministic facts are recorded: task IDs, commit SHAs, gate commands with their real
// exit codes, release tags and PRD version labels. Requirement text never enters the trace
// (it stays in `prdVersions`, which is redacted on share), and no model verdict is ever an
// input — a requirement is "shipped" only when its tasks completed, its latest gates all
// exited 0 and a release task stamped it.

import { Plan, RequirementTraceRecord, Task, TaskStatus } from './types';
import { Requirement, resolveRequirements } from './requirements';

// ─── Limits ───

/** Most recent commit SHAs kept per requirement. */
export const MAX_TRACE_COMMITS = 50;
/** Most recent releases kept per requirement. */
export const MAX_TRACE_RELEASES = 20;
/** Gate results kept per requirement (one run's worth). */
export const MAX_TRACE_GATES = 20;

// ─── Types ───

/** Derived status of one requirement. */
export type RequirementStatus = 'shipped' | 'in-progress' | 'not-shipped' | 'untracked' | 'removed';

/** One row of `requirementStatuses()` — what `moag trace` prints per requirement. */
export interface RequirementStatusRow {
  id: string;
  status: RequirementStatus;
  /** PRD version label of the last release that stamped this requirement */
  version: string | null;
  /** Tag of the last release that stamped this requirement */
  releaseTag: string | null;
  tasks: Array<{ id: string; status: TaskStatus }>;
  gates: Array<{ command: string; exitCode: number }>;
  /** ID of the Failed/Blocked/Skipped task that keeps the requirement from shipping */
  blockedBy?: string;
}

/** A gate command's outcome as the PRD loop observed it. */
export interface TraceGateInput {
  command: string;
  exitCode: number;
  timedOut: boolean;
}

// ─── Helpers ───

/** Numeric part of an `R-n` ID; unknown shapes sort last. */
function idNumber(id: string): number {
  const m = /^R-(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function byIdNumber(a: string, b: string): number {
  return idNumber(a) - idNumber(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function allTasks(plan: Plan): Task[] {
  const out: Task[] = [];
  for (const pl of plan.playlists) {
    for (const t of pl.tasks) { out.push(t); }
  }
  return out;
}

/** Every requirement ID cited by a non-release task. */
function taggedIds(plan: Plan): string[] {
  const ids = new Set<string>();
  for (const t of allTasks(plan)) {
    if (t.type === 'release') { continue; }
    for (const id of t.requirementIds ?? []) { ids.add(id); }
  }
  return [...ids].sort(byIdNumber);
}

/**
 * Get or create the trace record for `id`, keeping `plan.requirementTrace` sorted by ID
 * number, and union `taskIds` into it.
 */
function upsert(plan: Plan, id: string, taskIds: readonly string[]): RequirementTraceRecord {
  if (!plan.requirementTrace) { plan.requirementTrace = []; }
  let record = plan.requirementTrace.find(r => r.id === id);
  if (!record) {
    record = { id, taskIds: [], commits: [], gates: [], releases: [] };
    plan.requirementTrace.push(record);
    plan.requirementTrace.sort((a, b) => byIdNumber(a.id, b.id));
  }
  for (const taskId of taskIds) {
    if (!record.taskIds.includes(taskId)) { record.taskIds.push(taskId); }
  }
  return record;
}

// ─── Queries ───

/** Requirements of the latest saved PRD version; `[]` when the plan has no versions. */
export function latestRequirements(plan: Plan): Requirement[] {
  const versions = plan.prdVersions ?? [];
  if (versions.length === 0) { return []; }
  return resolveRequirements(versions[versions.length - 1].text);
}

/** Every task citing `id`, excluding release tasks (a release ships, it does not implement). */
export function taggedTasks(plan: Plan, id: string): Task[] {
  return allTasks(plan).filter(t => t.type !== 'release' && (t.requirementIds ?? []).includes(id));
}

// ─── Recording ───

/**
 * Record one PRD-loop run's gate results against every requirement whose tagged tasks are all
 * Completed; each such record's `gates` is replaced with this run's results (latest evidence
 * wins). A requirement with any tagged task not yet Completed gets no evidence from this run —
 * the gates did not exercise its implementation — and any gates it already had are cleared,
 * because they predate this run: kept, they would let a later release ship the requirement on
 * a green result that a newer run contradicted.
 *
 * A requirement that was RELEASED but no longer has any tagged task (its tasks were removed
 * from the plan) gets this run's results too: its shipped code is still in the tree the gates
 * just ran against, and without a refresh its last green gates would keep it `shipped` forever,
 * whatever later runs said. No-op when no gate ran, or when no task is tagged and nothing was
 * released. Returns the IDs whose record changed (recorded or cleared), so a caller knows to save.
 */
export function recordGateResults(plan: Plan, gates: readonly TraceGateInput[], at: string): string[] {
  if (gates.length === 0) { return []; }
  const touched: string[] = [];
  const results = (): RequirementTraceRecord['gates'] => gates.slice(0, MAX_TRACE_GATES).map(g => ({
    command: g.command,
    exitCode: g.exitCode,
    timedOut: g.timedOut,
    at,
  }));
  const tagged = taggedIds(plan);
  for (const record of plan.requirementTrace ?? []) {
    if (record.releases.length > 0 && !tagged.includes(record.id)) {
      record.gates = results();
      touched.push(record.id);
    }
  }
  for (const id of tagged) {
    const tasks = taggedTasks(plan, id);
    if (!tasks.every(t => t.status === TaskStatus.Completed)) {
      const stale = plan.requirementTrace?.find(r => r.id === id);
      if (stale && stale.gates.length > 0) {
        stale.gates = [];
        touched.push(id);
      }
      continue;
    }
    const record = upsert(plan, id, tasks.map(t => t.id));
    record.gates = results();
    touched.push(id);
  }
  return touched.sort(byIdNumber);
}

/**
 * Record a commit SHA against every requirement `task` cites. Deduped; a repeated SHA moves
 * to the newest position, and only the newest MAX_TRACE_COMMITS are kept.
 */
export function recordCommit(plan: Plan, task: Task, sha: string | undefined): void {
  if (!sha || !task.requirementIds?.length) { return; }
  for (const id of task.requirementIds) {
    const record = upsert(plan, id, [task.id]);
    const commits = record.commits.filter(c => c !== sha);
    commits.push(sha);
    record.commits = commits.slice(-MAX_TRACE_COMMITS);
  }
}

/**
 * Stamp a successful release onto every requirement of the latest PRD version that is ready
 * to ship: it has tagged tasks, all of them Completed, and its latest recorded gates are
 * non-empty and all exited 0 without timing out. Returns the IDs stamped and the PRD
 * version label used (`null` when the plan has no PRD versions).
 */
export function stampRelease(plan: Plan, releaseTag: string, at: string): { shipped: string[]; prdVersion: string | null } {
  const versions = plan.prdVersions ?? [];
  if (versions.length === 0) { return { shipped: [], prdVersion: null }; }
  const prdVersion = versions[versions.length - 1].version;
  const shipped: string[] = [];
  for (const req of latestRequirements(plan)) {
    const tasks = taggedTasks(plan, req.id);
    if (tasks.length === 0 || !tasks.every(t => t.status === TaskStatus.Completed)) { continue; }
    const existing = plan.requirementTrace?.find(r => r.id === req.id);
    if (!existing || existing.gates.length === 0) { continue; }
    if (!existing.gates.every(g => g.exitCode === 0 && !g.timedOut)) { continue; }
    const taskIds = tasks.map(t => t.id);
    const record = upsert(plan, req.id, taskIds);
    record.releases = [...record.releases, { releaseTag, prdVersion, at, taskIds }].slice(-MAX_TRACE_RELEASES);
    shipped.push(req.id);
  }
  return { shipped, prdVersion };
}

// ─── Status derivation ───

/**
 * Derive each requirement's status from the plan. Pure: the plan is not mutated.
 * The ID set is latest PRD version ∪ trace records ∪ task tags. Rules, in order:
 *   1. not in the latest PRD version → `removed`
 *   2. a tagged task is Failed, Blocked or Skipped → `not-shipped` (names the task)
 *   3. no tagged tasks → `untracked` without a release; with one, `shipped` only when the
 *      latest gates are green (below), else `in-progress` — `recordGateResults` keeps such a
 *      record's gates current, so a later failing run demotes it
 *   4. all tagged tasks Completed, all of them in the last release, and the latest gates
 *      green → `shipped`
 *   5. otherwise → `in-progress` (including a released requirement whose latest gates failed)
 * "Green" means the latest recorded gates are non-empty and every one exited 0 without
 * timing out — a release stamp never outlives a later failing gate run.
 */
export function requirementStatuses(plan: Plan): RequirementStatusRow[] {
  const latest = new Set(latestRequirements(plan).map(r => r.id));
  const ids = new Set<string>(latest);
  for (const r of plan.requirementTrace ?? []) { ids.add(r.id); }
  for (const id of taggedIds(plan)) { ids.add(id); }

  return [...ids].sort(byIdNumber).map((id): RequirementStatusRow => {
    const record = plan.requirementTrace?.find(r => r.id === id);
    const tasks = taggedTasks(plan, id);
    const lastRelease = record && record.releases.length > 0 ? record.releases[record.releases.length - 1] : undefined;
    const row: RequirementStatusRow = {
      id,
      status: 'in-progress',
      version: lastRelease ? lastRelease.prdVersion : null,
      releaseTag: lastRelease ? lastRelease.releaseTag : null,
      tasks: tasks.map(t => ({ id: t.id, status: t.status })),
      gates: (record?.gates ?? []).map(g => ({ command: g.command, exitCode: g.exitCode })),
    };
    const blocker = tasks.find(t =>
      t.status === TaskStatus.Failed || t.status === TaskStatus.Blocked || t.status === TaskStatus.Skipped);
    const latestGates = record?.gates ?? [];
    const gatesGreen = latestGates.length > 0 && latestGates.every(g => g.exitCode === 0 && !g.timedOut);
    if (!latest.has(id)) {
      row.status = 'removed';
    } else if (blocker) {
      row.status = 'not-shipped';
      row.blockedBy = blocker.id;
    } else if (tasks.length === 0) {
      row.status = !lastRelease ? 'untracked' : gatesGreen ? 'shipped' : 'in-progress';
    } else if (lastRelease
      && gatesGreen
      && tasks.every(t => t.status === TaskStatus.Completed)
      && tasks.every(t => lastRelease.taskIds.includes(t.id))) {
      row.status = 'shipped';
    } else {
      row.status = 'in-progress';
    }
    return row;
  });
}
