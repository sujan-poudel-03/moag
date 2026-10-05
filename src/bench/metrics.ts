// ─── Benchmark metrics (pure) ───
//
// The harness records raw observations per PRD version (what the server said,
// which events streamed, which human decisions the bench had to make); this
// module turns them into the reported metrics. Definitions live in
// docs/benchmark.md and must match the code here.
//
// Cost is reported honestly: `costUsd` is a number only when EVERY engine call
// of the version reported its own cost. One estimated or unreported call makes
// it "unknown" — the reported part and the upper bound are still shown.

import { SHIP_GATE_NAME } from '../server/prd-ops';
import { BenchCostEvent, BudgetSnapshot } from './budget';
import { IntendedBump } from './scenario';

/** How a version ended. */
export type VersionOutcome =
  | 'shipped' | 'partially-shipped' | 'not-shipped' | 'no-delta' | 'plan-failed' | 'not run (budget)' | 'error';

/** One human decision the bench made on someone's behalf. */
export interface Intervention {
  kind: string;
  at: string;
  detail?: string;
}

/** A task as the final run detail shows it. */
export interface ObservedTask {
  id: string;
  name: string;
  type: string;
  status: string;
}

/** The bench's acceptance gates at the first ship-gate halt. */
export interface GateRunObservation {
  pass: boolean;
  results: Array<{ command: string; exitCode: number | null; timedOut: boolean; durationMs: number }>;
}

/** Everything the harness observed for one PRD version. */
export interface VersionObservation {
  id: string;
  intendedBump: IntendedBump;
  recommendedBump: string | null;
  bumpOverridden: boolean;
  /** Requirement ids this version added / changed (v1: every requirement, as added). */
  requirementsAdded: string[];
  requirementsChanged: string[];
  /** Tasks in the generated playlist, the server's ship gate excluded; null when no plan was generated. */
  tasksGenerated: number | null;
  /** Tasks of the final run detail (the ship gate is excluded when counting). */
  finalTasks: ObservedTask[];
  gateFirstRun: GateRunObservation | null;
  /** Every `verify-finished` event of the version's run, in order. */
  verifyFinished: Array<{ passed: boolean; failedGate: string | null; iterations: number }>;
  /** Every `task-started` id, in order (repeats included). */
  taskStarts: string[];
  /** Every `cost` event attributed to this version. */
  costEvents: BenchCostEvent[];
  /** ms timestamps: PRD saved, and the moment the run completed with every version id shipped. */
  savedAtMs: number | null;
  shippedAtMs: number | null;
  /** How the version ended when it did not ship (`plan-parse-failed`, `run-gaps`, `timeout`, ...). */
  endState: string | null;
  required: Intervention[];
  unplanned: Intervention[];
  /** Final trace status per id of this version. */
  trace: Record<string, string>;
  /** Terminal flags set by the harness. */
  notRunBudget?: boolean;
  noDelta?: boolean;
  planFailed?: boolean;
  error?: string;
  /** What the server's run record reports as spent for this version (reconciliation). */
  serverSpentUsd: number | null;
  notes: string[];
}

export interface VersionMetrics {
  id: string;
  intendedBump: IntendedBump;
  recommendedBump: string | null;
  bumpMatch: boolean | null;
  bumpOverridden: boolean;
  requirementsAdded: number;
  requirementsChanged: number;
  requirementIds: string[];
  tasksGenerated: number | null;
  tasksCompleted: number;
  tasksFailed: number;
  tasksBlocked: number;
  tasksSkipped: number;
  gateFirstRunPass: GateRunObservation | null;
  moagVerify: { passed: boolean; failedGate: string | null } | null;
  fixIterations: number;
  /** Labelled proxy for retries / auto-fix: extra `task-started` events for an already-started id. */
  taskRestarts: number;
  wallClockMs: number | null;
  endState: string | null;
  costUsd: number | 'unknown';
  reportedUsd: number;
  reportedCalls: number;
  estimatedCalls: number;
  unreportedCalls: number;
  upperBoundUsd: number;
  costPerRequirementShippedUsd: number | 'unknown' | null;
  requirementsShipped: number;
  interventions: { required: Intervention[]; unplanned: Intervention[] };
  trace: Record<string, string>;
  outcome: VersionOutcome;
  serverSpentUsd: number | null;
  notes: string[];
}

export interface BenchSummary {
  scenario: string;
  scenarioFile: string;
  mode: 'dry-run' | 'paid';
  startedAt: string;
  endedAt: string;
  aborted: boolean;
  stoppedForBudget: boolean;
  harnessError: string | null;
  exitCode: number;
  capUsd: number;
  budget: BudgetSnapshot;
  workspace: { dir: string; head: string | null } | null;
  engine: { id: string; version: string | null; probeVersion: string | null };
  versions: VersionMetrics[];
  totals: {
    requirementsShipped: number;
    requirementsInScope: number;
    interventionsRequired: number;
    interventionsUnplanned: number;
    costUsd: number | 'unknown';
    reportedUsd: number;
    upperBoundUsd: number;
  };
  /** True when the JSONL event log hit its size cap and later lines were dropped. */
  eventsTruncated: boolean;
  notes: string[];
}

/**
 * Cost per requirement shipped: 'unknown' when the cost is unknown, null when
 * nothing shipped, otherwise the cost divided by the shipped count.
 */
export function costPerRequirementShipped(costUsd: number | 'unknown', shipped: number): number | 'unknown' | null {
  if (costUsd === 'unknown') { return 'unknown'; }
  if (shipped <= 0) { return null; }
  return costUsd / shipped;
}

const isShipGate = (t: ObservedTask): boolean => t.type === 'manual' && t.name === SHIP_GATE_NAME;

/** Turn one version's observations into its metrics. `perCallCapUsd` sizes the unreported-call bound. */
export function buildVersionMetrics(o: VersionObservation, perCallCapUsd: number): VersionMetrics {
  const versionIds = [...new Set([...o.requirementsAdded, ...o.requirementsChanged])];
  const work = o.finalTasks.filter((t) => !isShipGate(t));
  const count = (status: string): number => work.filter((t) => t.status === status).length;

  let reportedUsd = 0;
  let estimatedUsd = 0;
  let reportedCalls = 0;
  let estimatedCalls = 0;
  let unreportedCalls = 0;
  for (const e of o.costEvents) {
    const usd = typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd >= 0 ? e.usd : null;
    if (e.source === 'none' || usd === null) { unreportedCalls++; }
    else if (e.source === 'reported') { reportedUsd += usd; reportedCalls++; }
    else { estimatedUsd += usd; estimatedCalls++; }
  }
  const costUsd: number | 'unknown' = estimatedCalls + unreportedCalls > 0 ? 'unknown' : reportedUsd;

  const shippedIds = versionIds.filter((id) => o.trace[id] === 'shipped');
  const starts = new Map<string, number>();
  for (const id of o.taskStarts) { starts.set(id, (starts.get(id) ?? 0) + 1); }
  const taskRestarts = [...starts.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);

  let outcome: VersionOutcome;
  if (o.notRunBudget) { outcome = 'not run (budget)'; }
  else if (o.error) { outcome = 'error'; }
  else if (o.noDelta) { outcome = 'no-delta'; }
  else if (o.planFailed) { outcome = 'plan-failed'; }
  else if (versionIds.length > 0 && shippedIds.length === versionIds.length) { outcome = 'shipped'; }
  else if (shippedIds.length > 0) { outcome = 'partially-shipped'; }
  else { outcome = 'not-shipped'; }

  const lastVerify = o.verifyFinished.length > 0 ? o.verifyFinished[o.verifyFinished.length - 1] : null;
  const wallClockMs = outcome === 'shipped' && o.savedAtMs !== null && o.shippedAtMs !== null
    ? Math.max(0, o.shippedAtMs - o.savedAtMs) : null;

  return {
    id: o.id,
    intendedBump: o.intendedBump,
    recommendedBump: o.recommendedBump,
    bumpMatch: o.intendedBump === 'initial' ? null : o.recommendedBump === o.intendedBump,
    bumpOverridden: o.bumpOverridden,
    requirementsAdded: o.requirementsAdded.length,
    requirementsChanged: o.requirementsChanged.length,
    requirementIds: versionIds,
    tasksGenerated: o.tasksGenerated,
    tasksCompleted: count('completed'),
    tasksFailed: count('failed'),
    tasksBlocked: count('blocked'),
    tasksSkipped: count('skipped'),
    gateFirstRunPass: o.gateFirstRun,
    moagVerify: lastVerify ? { passed: lastVerify.passed, failedGate: lastVerify.failedGate } : null,
    fixIterations: o.verifyFinished.reduce((n, v) => n + (Number.isFinite(v.iterations) ? v.iterations : 0), 0),
    taskRestarts,
    wallClockMs,
    endState: outcome === 'shipped' ? null : (o.endState ?? outcome),
    costUsd,
    reportedUsd,
    reportedCalls,
    estimatedCalls,
    unreportedCalls,
    upperBoundUsd: reportedUsd + estimatedUsd + unreportedCalls * perCallCapUsd,
    costPerRequirementShippedUsd: costPerRequirementShipped(costUsd, shippedIds.length),
    requirementsShipped: shippedIds.length,
    interventions: { required: [...o.required], unplanned: [...o.unplanned] },
    trace: { ...o.trace },
    outcome,
    serverSpentUsd: o.serverSpentUsd,
    notes: [...o.notes],
  };
}

/** Roll the per-version metrics up into the summary document. */
export function summarize(
  versions: VersionMetrics[],
  budget: BudgetSnapshot,
  meta: Omit<BenchSummary, 'versions' | 'totals' | 'budget' | 'capUsd'>,
): BenchSummary {
  const anyUnknown = versions.some((v) => v.costUsd === 'unknown');
  return {
    ...meta,
    capUsd: budget.capUsd,
    budget,
    versions,
    totals: {
      requirementsShipped: versions.reduce((n, v) => n + v.requirementsShipped, 0),
      requirementsInScope: versions.reduce((n, v) => n + v.requirementIds.length, 0),
      interventionsRequired: versions.reduce((n, v) => n + v.interventions.required.length, 0),
      interventionsUnplanned: versions.reduce((n, v) => n + v.interventions.unplanned.length, 0),
      costUsd: anyUnknown || budget.estimatedCalls + budget.unreportedCalls > 0 ? 'unknown' : budget.reportedUsd,
      reportedUsd: budget.reportedUsd,
      upperBoundUsd: budget.upperBoundUsd,
    },
  };
}

/** A blank observation for `id` (the harness fills it in as the version proceeds). */
export function emptyObservation(id: string, intendedBump: IntendedBump): VersionObservation {
  return {
    id, intendedBump, recommendedBump: null, bumpOverridden: false,
    requirementsAdded: [], requirementsChanged: [], tasksGenerated: null, finalTasks: [],
    gateFirstRun: null, verifyFinished: [], taskStarts: [], costEvents: [],
    savedAtMs: null, shippedAtMs: null, endState: null, required: [], unplanned: [], trace: {},
    serverSpentUsd: null, notes: [],
  };
}
