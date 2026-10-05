// ─── Stack recommendation (evidence only) ───
//
// Recommends a tech stack for a project from REAL recorded outcomes: terminal
// agent tasks that server runs stamped with the project's stack and the engine
// that ran them (`outcomes.jsonl`). Evidence is grouped engine × stack over the
// engines that are connected right now. A group is scored by the 95% Wilson
// lower bound of its completion rate — honest at small n — and only counts once
// it has at least {@link MIN_GROUP_N} tasks. A stack's score is its best
// eligible engine.
//
// With no eligible group the answer is the literal "Insufficient data — static
// default": a stack detected from repository marker files, or the static
// default, labelled as such, and the response carries NO numeric rate field.
// Records without a stack (anything recorded before stacks existed) are counted
// as excluded and never guessed into a group. Gate pass rate is a supporting
// figure with its own n, shown only from {@link MIN_GATE_RUNS} gate runs, and is
// never blended into the score.
//
// Measured data is only headlined as a RECOMMENDATION (state 'recommended')
// when all of these hold; otherwise the response says which one failed:
//   - the best group's completion is not poor (Wilson lower bound ≥
//     {@link MIN_RECOMMEND_LOWER}) — else 'poor-completion';
//   - repo detection found nothing, or found the same stack — a detected stack
//     stays primary and differing measurements are supporting evidence only
//     ('detected-differs');
//   - a second eligible stack exists to compare against — one stack measured
//     alone is 'single-stack', never medium/high confidence.
//
// Pure apart from `detectStackFromRepo`, which only lists one directory (`fs`).

import * as fs from 'fs';
import { EngineId } from '../models/types';
import { StackId, STACK_IDS, STATIC_DEFAULT_STACK, isStackId } from './stacks';

export const MIN_GROUP_N = 10;
export const MEDIUM_MIN_N = 50;
export const MIN_GATE_RUNS = 10;
/** z for a two-sided 95% interval. */
export const WILSON_Z = 1.959964;

export const INSUFFICIENT_LABEL = 'Insufficient data — static default';
export const DETECTED_LABEL = 'detected from repository files';
export const STATIC_LABEL = 'static default, not measured';
export const SINGLE_STACK_LABEL = 'Single stack measured — no comparison';
export const POOR_COMPLETION_LABEL = 'Measured completion too low to recommend';
export const DETECTED_DIFFERS_LABEL = 'Detected from repository files — measured data is supporting evidence';
/** A group whose 95% Wilson lower bound is below this is never recommended. */
export const MIN_RECOMMEND_LOWER = 0.5;

export type Confidence = 'low' | 'medium' | 'high';

/** What measured evidence amounts to. Only 'recommended' may be headlined as a recommendation. */
export type MeasuredState = 'recommended' | 'single-stack' | 'poor-completion' | 'detected-differs';

/** One line of `outcomes.jsonl` as read back (untrusted shape). */
export interface OutcomeLike {
  kind?: unknown;
  stack?: unknown;
  engine?: unknown;
  taskType?: unknown;
  status?: unknown;
  allGreen?: unknown;
}

export interface GroupStat {
  engine: EngineId;
  stack: StackId;
  /** Terminal agent tasks (completed + failed + blocked). */
  n: number;
  completed: number;
  rate: number;
  wilsonLower: number;
  wilsonUpper: number;
  eligible: boolean;
  gateRuns: number;
  /** Present only when `gateRuns >= MIN_GATE_RUNS`. */
  gatePassRate?: number;
}

export interface MeasuredRecommendation {
  source: 'measured';
  state: MeasuredState;
  /**
   * The stack the form offers: the detected stack whenever detection found one;
   * otherwise the measured best, or the static default when that is poor.
   */
  stack: StackId;
  stackSource: 'measured' | 'detected' | 'static';
  /** Stack found from repository marker files, if any. */
  detectedStack: StackId | null;
  /** Null unless `state === 'recommended'`. */
  confidence: Confidence | null;
  label: string;
  /** The top stack's best eligible group. */
  basis: GroupStat;
  /** Second-best stack's best eligible group, when one exists. */
  runnerUp: GroupStat | null;
  /** Every eligible group, best first. */
  groups: GroupStat[];
  /** Terminal agent tasks with a recorded stack on connected engines. */
  recordedTasks: number;
  excludedNoStack: number;
  minPerGroup: number;
}

/** The fallback. Deliberately has no rate, score or interval field. */
export interface StaticRecommendation {
  source: 'static-default';
  stack: StackId;
  label: typeof INSUFFICIENT_LABEL;
  defaultKind: 'detected' | 'static';
  defaultLabel: typeof DETECTED_LABEL | typeof STATIC_LABEL;
  recordedTasks: number;
  excludedNoStack: number;
  minPerGroup: number;
}

export type StackRecommendation = MeasuredRecommendation | StaticRecommendation;

/** 95% Wilson score interval for `successes` of `n`. `n = 0` gives [0, 1]. */
export function wilsonInterval(successes: number, n: number, z = WILSON_Z): { lower: number; upper: number } {
  if (n <= 0) { return { lower: 0, upper: 1 }; }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, (centre - margin) / denom), upper: Math.min(1, (centre + margin) / denom) };
}

const TERMINAL = new Set(['completed', 'failed', 'blocked']);

/**
 * Recommend a stack. `connected` = engines usable now (probe-available CLIs plus
 * API engines with a key). `detectedStack` = the repo-marker detection result,
 * if any; it stays the primary stack whatever was measured. `legacyExcluded` =
 * outcome records from other sources known to lack a stack (counted, never used).
 */
export function recommendStack(
  records: readonly OutcomeLike[],
  connected: readonly EngineId[],
  detectedStack: StackId | null,
  legacyExcluded = 0,
): StackRecommendation {
  const conn = new Set(connected);
  const tasks = new Map<string, { engine: EngineId; stack: StackId; n: number; completed: number }>();
  const gates = new Map<string, { runs: number; green: number }>();
  let excludedNoStack = Math.max(0, Math.floor(legacyExcluded));
  let recordedTasks = 0;

  for (const r of records) {
    if (!r || typeof r !== 'object') { continue; }
    const kind = r.kind ?? 'task';
    if (kind === 'task') {
      if (typeof r.status !== 'string' || !TERMINAL.has(r.status)) { continue; }
      if (r.taskType !== undefined && r.taskType !== 'agent') { continue; }
      if (!isStackId(r.stack)) { excludedNoStack++; continue; }
      if (typeof r.engine !== 'string' || !conn.has(r.engine as EngineId)) { continue; }
      recordedTasks++;
      const key = `${r.engine}\u0000${r.stack}`;
      const g = tasks.get(key) ?? { engine: r.engine as EngineId, stack: r.stack, n: 0, completed: 0 };
      g.n++;
      if (r.status === 'completed') { g.completed++; }
      tasks.set(key, g);
    } else if (kind === 'gate') {
      if (!isStackId(r.stack) || typeof r.engine !== 'string' || !conn.has(r.engine as EngineId) || typeof r.allGreen !== 'boolean') { continue; }
      const key = `${r.engine}\u0000${r.stack}`;
      const g = gates.get(key) ?? { runs: 0, green: 0 };
      g.runs++;
      if (r.allGreen) { g.green++; }
      gates.set(key, g);
    }
  }

  const stats: GroupStat[] = [...tasks.entries()].map(([key, g]) => {
    const w = wilsonInterval(g.completed, g.n);
    const gate = gates.get(key) ?? { runs: 0, green: 0 };
    return {
      engine: g.engine, stack: g.stack, n: g.n, completed: g.completed,
      rate: g.completed / g.n, wilsonLower: w.lower, wilsonUpper: w.upper,
      eligible: g.n >= MIN_GROUP_N,
      gateRuns: gate.runs,
      ...(gate.runs >= MIN_GATE_RUNS ? { gatePassRate: gate.green / gate.runs } : {}),
    };
  });
  const eligible = stats.filter((s) => s.eligible).sort(compareGroups);

  if (eligible.length === 0) {
    return {
      source: 'static-default',
      stack: detectedStack ?? STATIC_DEFAULT_STACK,
      label: INSUFFICIENT_LABEL,
      defaultKind: detectedStack ? 'detected' : 'static',
      defaultLabel: detectedStack ? DETECTED_LABEL : STATIC_LABEL,
      recordedTasks,
      excludedNoStack,
      minPerGroup: MIN_GROUP_N,
    };
  }

  // A stack's score is its best eligible engine (eligible is sorted best first).
  const bestPerStack: GroupStat[] = [];
  for (const g of eligible) {
    if (!bestPerStack.some((b) => b.stack === g.stack)) { bestPerStack.push(g); }
  }
  const basis = bestPerStack[0];
  const runnerUp = bestPerStack[1] ?? null;
  const poor = basis.wilsonLower < MIN_RECOMMEND_LOWER;

  let state: MeasuredState;
  if (poor) { state = 'poor-completion'; }
  else if (detectedStack !== null && basis.stack !== detectedStack) { state = 'detected-differs'; }
  else if (runnerUp === null) { state = 'single-stack'; }
  else { state = 'recommended'; }

  // Confidence only qualifies a real comparison: with no runner-up there is nothing to be confident against.
  let confidence: Confidence | null = null;
  if (state === 'recommended' && runnerUp) {
    if (basis.n < MEDIUM_MIN_N) { confidence = 'low'; }
    else if (basis.wilsonLower > runnerUp.wilsonUpper) { confidence = 'high'; }
    else { confidence = 'medium'; }
  }

  const stack: StackId = detectedStack ?? (poor ? STATIC_DEFAULT_STACK : basis.stack);
  const stackSource: MeasuredRecommendation['stackSource'] = detectedStack !== null ? 'detected' : poor ? 'static' : 'measured';
  const label = state === 'recommended' ? `${confidence!.toUpperCase()} CONFIDENCE`
    : state === 'single-stack' ? SINGLE_STACK_LABEL
      : state === 'poor-completion' ? POOR_COMPLETION_LABEL
        : DETECTED_DIFFERS_LABEL;
  return {
    source: 'measured',
    state,
    stack,
    stackSource,
    detectedStack,
    confidence,
    label,
    basis,
    runnerUp,
    groups: eligible,
    recordedTasks,
    excludedNoStack,
    minPerGroup: MIN_GROUP_N,
  };
}

/** Best first: higher Wilson lower bound, then larger n, then stable by stack/engine order. */
function compareGroups(a: GroupStat, b: GroupStat): number {
  return b.wilsonLower - a.wilsonLower
    || b.n - a.n
    || STACK_IDS.indexOf(a.stack) - STACK_IDS.indexOf(b.stack)
    || (a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0);
}

// ─── Repository markers ───

/**
 * Guess a stack from marker files at the top of `dir` (no recursion, no reads
 * of file contents). Null when nothing matches or the directory can't be listed.
 */
export function detectStackFromRepo(dir: string): StackId | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const has = (n: string): boolean => names.includes(n);
  if (has('tsconfig.json') || has('package.json')) { return 'node-ts'; }
  if (has('pyproject.toml') || has('requirements.txt')) { return 'python'; }
  if (has('go.mod')) { return 'go'; }
  if (has('pom.xml') || names.some((n) => n.startsWith('build.gradle'))) { return 'java'; }
  if (names.some((n) => n.endsWith('.csproj') || n.endsWith('.sln'))) { return 'dotnet'; }
  if (has('index.html')) { return 'static-web'; }
  return null;
}
