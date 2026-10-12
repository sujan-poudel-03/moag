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

import { Plan, RequirementTraceRecord, StandardsCheckCounts, Task, TaskStatus } from './types';
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
  /** Project standards version that release was checked against; null when it had none (or nothing was released) */
  standardsVersion: number | null;
  /** What that check left open — advisory findings, rules and files not checked; null when none was recorded */
  standardsCounts: StandardsCheckCounts | null;
  tasks: Array<{ id: string; status: TaskStatus }>;
  /**
   * The latest gates. The synthetic standards row carries what its check left open
   * (`standardsCounts`, numbers only) when it was recorded with it, so a reader can tell
   * "no blocking rules configured" from "nothing blocking", and always says which in a word
   * (`standards`, see `StandardsGateWord`). No other row has either key.
   */
  gates: Array<{ command: string; exitCode: number; standards?: StandardsGateWord; standardsCounts?: StandardsCheckCounts }>;
  /** ID of the Failed/Blocked/Skipped task that keeps the requirement from shipping */
  blockedBy?: string;
}

/** A gate command's outcome as the PRD loop observed it. */
export interface TraceGateInput {
  command: string;
  exitCode: number;
  timedOut: boolean;
  /** Only on the standards row: what the check left open (see {@link StandardsCheckCounts}). */
  standardsCounts?: StandardsCheckCounts;
}

/** A fresh copy of `counts` holding its three numbers, `noBlockingRules` when set, and nothing else. */
function copyCounts(counts: StandardsCheckCounts): StandardsCheckCounts {
  return {
    advisoryFindings: counts.advisoryFindings, notCheckedRules: counts.notCheckedRules, notCheckedFiles: counts.notCheckedFiles,
    ...(counts.noBlockingRules === true ? { noBlockingRules: true as const } : {}),
  };
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
export function taggedIds(plan: Plan): string[] {
  const ids = new Set<string>();
  for (const t of allTasks(plan)) {
    if (t.type === 'release') { continue; }
    for (const id of t.requirementIds ?? []) { ids.add(id); }
  }
  return [...ids].sort(byIdNumber);
}

/**
 * The requirement IDs a verification of `plan` is about: every ID cited by a non-release
 * task, except one whose tagged tasks ALL went out in its last release. A shipped v1
 * requirement whose tasks the v2 work did not add to is not this check's subject, so a rule
 * that asks each verified requirement to be named in a test file this change touched must
 * not ask it of R-1 again. A task added for the ID since its release brings it back in.
 * With no release recorded this is {@link taggedIds}.
 */
export function verifiedRequirementIds(plan: Plan): string[] {
  return taggedIds(plan).filter((id) => {
    const record = plan.requirementTrace?.find(r => r.id === id);
    const last = record && record.releases.length > 0 ? record.releases[record.releases.length - 1] : undefined;
    if (!last) { return true; }
    return !taggedTasks(plan, id).every(t => last.taskIds.includes(t.id));
  });
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
    ...(g.standardsCounts ? { standardsCounts: copyCounts(g.standardsCounts) } : {}),
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
 * The name of the gate row that carries the standards result of one verification.
 * The PRD loop writes a PASSING row only when the blocking set was really evaluated — every
 * blocking rule the profile configures and every one of its commands came out decided, and
 * none stops the release — so its presence, exit 0, in a requirement's latest gates is the
 * evidence that the work was checked against that standards version. The row carries what
 * the check left open (`standardsCounts`): advisory findings, rules and files not checked.
 */
export function standardsGateCommand(version: number | null): string {
  return version === null ? 'moag:standards' : `moag:standards v${version}`;
}

/**
 * The one pattern that recognises the standards row. The hosted web app is plain browser
 * JavaScript and cannot import this module, so `web/js/screens/trace.js` holds the same
 * pattern under the same name; a unit test compares the two, source and behaviour.
 */
export const STANDARDS_GATE_COMMAND = /^moag:standards(?: v\d+)?$/;

/**
 * True for the synthetic standards row ({@link standardsGateCommand}), whatever its version.
 * A surface that words gate rows must ask this first: the row is not a command, so it is
 * never said to have passed — see {@link standardsGateWord}.
 */
export function isStandardsGateCommand(command: string): boolean {
  return STANDARDS_GATE_COMMAND.test(command);
}

/**
 * The three things the standards row can say, on every surface that words it — the VS Code
 * gate table, the hosted trace, the evidence handed to a model, the stored verification report:
 *
 *   - `stopped`: the row stopped the release (a blocking row failed or was not checked);
 *   - `no blocking rules configured`: the profile had no command and no promoted rule;
 *   - `nothing blocking`: there was a blocking set and nothing in it stops the release.
 *
 * Never "pass": most of what the row covers is a scan, and a scan that found nothing has
 * not proved that nothing is there.
 */
export type StandardsGateWord = 'stopped' | 'no blocking rules configured' | 'nothing blocking';

/** See {@link StandardsGateWord}. `passed` is the row's own result: exit 0, not timed out. */
export function standardsGateWord(passed: boolean, counts?: StandardsCheckCounts | null): StandardsGateWord {
  if (!passed) { return 'stopped'; }
  return counts?.noBlockingRules === true ? 'no blocking rules configured' : 'nothing blocking';
}

/**
 * What a check left open, in words: "2 advisory findings · 1 rule not checked · 3 files not
 * checked". Zero counts are left out; '' when nothing was left open or no counts were recorded.
 */
export function standardsOpenText(counts?: StandardsCheckCounts | null): string {
  if (!counts) { return ''; }
  const part = (n: number, one: string, many: string): string | null =>
    (Number.isInteger(n) && n > 0 ? `${n} ${n === 1 ? one : many}` : null);
  return [
    part(counts.advisoryFindings, 'advisory finding', 'advisory findings'),
    part(counts.notCheckedRules, 'rule not checked', 'rules not checked'),
    part(counts.notCheckedFiles, 'file not checked', 'files not checked'),
  ].filter((x): x is string => x !== null).join(' · ');
}

/**
 * Stamp a successful release onto every requirement of the latest PRD version that is ready
 * to ship: it has tagged tasks, all of them Completed, and its latest recorded gates are
 * non-empty and all exited 0 without timing out. Returns the IDs stamped and the PRD
 * version label used (`null` when the plan has no PRD versions).
 *
 * `opts.standardsVersion` is the project standards version the shipped work was checked
 * against; it is recorded on each stamp. Anything but an integer >= 1 records nothing.
 *
 * With `opts.standardsFromGates` the version is recorded on a requirement only when its
 * latest gates hold a passing standards row for exactly that version — that is, the last
 * verification really evaluated the blocking set of it. A requirement verified without the
 * standards gate, or whose blocking set was not evaluated, still ships, with no standards
 * version on its stamp: the trace never claims a check that did not happen.
 *
 * What the check left open is recorded beside the version: `opts.standardsCounts` when the
 * caller knows it (the hosted server, from the report its worker sent), else the counts on
 * the passing standards row. Never without a version.
 */
export function stampRelease(
  plan: Plan, releaseTag: string, at: string,
  opts: { standardsVersion?: number; standardsFromGates?: boolean; standardsCounts?: StandardsCheckCounts } = {},
): { shipped: string[]; prdVersion: string | null } {
  const standardsVersion = typeof opts.standardsVersion === 'number' && Number.isInteger(opts.standardsVersion) && opts.standardsVersion >= 1
    ? opts.standardsVersion
    : undefined;
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
    const row = standardsVersion === undefined ? undefined
      : existing.gates.find(g => g.command === standardsGateCommand(standardsVersion) && g.exitCode === 0 && !g.timedOut);
    const judged = standardsVersion !== undefined && (opts.standardsFromGates !== true || row !== undefined);
    const counts = !judged ? undefined : opts.standardsCounts ?? row?.standardsCounts;
    const record = upsert(plan, req.id, taskIds);
    record.releases = [
      ...record.releases,
      {
        releaseTag, prdVersion, at, taskIds,
        ...(judged ? { standardsVersion } : {}),
        ...(counts ? { standardsCounts: copyCounts(counts) } : {}),
      },
    ].slice(-MAX_TRACE_RELEASES);
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
      standardsVersion: lastRelease?.standardsVersion ?? null,
      standardsCounts: lastRelease?.standardsCounts ? copyCounts(lastRelease.standardsCounts) : null,
      tasks: tasks.map(t => ({ id: t.id, status: t.status })),
      gates: (record?.gates ?? []).map(g => {
        if (!isStandardsGateCommand(g.command)) { return { command: g.command, exitCode: g.exitCode }; }
        // The standards row is not a command: it is worded, never left to read as "exit 0 = pass".
        // Its counts are numbers only: never a file name or a finding.
        return {
          command: g.command,
          exitCode: g.exitCode,
          standards: standardsGateWord(g.exitCode === 0 && !g.timedOut, g.standardsCounts),
          ...(g.standardsCounts ? { standardsCounts: copyCounts(g.standardsCounts) } : {}),
        };
      }),
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
