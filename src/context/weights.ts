// ─── Outcome-Weighted Retrieval Scoring ──────────────────────────────────────
//
// Learns from task history: sections/task-types that correlate with success get
// boosted; those present on failed tasks get penalised. Weights are stored in
// .moag/weights.json and loaded lazily into scorePriorEntry.
//
// Starts neutral (all weights = 1.0) until enough data accumulates.

import * as fs from 'fs';
import * as path from 'path';
import type { HistoryEntry, TaskStatus } from '../models/types';

export interface ContextWeights {
  version: number;
  computedAt: string;
  /** Number of instrumented history entries used to compute these weights */
  sampleCount: number;
  /**
   * Multiplier per section name from sectionBreakdown (Plan, Code, Output, Progress…).
   * 1.0 = no effect. >1.0 = section correlates with success. <1.0 = correlates with failure.
   */
  sectionWeights: Record<string, number>;
  /**
   * Multiplier per task type (agent, command, visual-test, review…).
   * Adjusts scorePriorEntry for prior outputs of that task type.
   */
  taskTypeWeights: Record<string, number>;
}

export const DEFAULT_WEIGHTS: ContextWeights = {
  version: 1,
  computedAt: '',
  sampleCount: 0,
  sectionWeights: {},
  taskTypeWeights: {},
};

const WEIGHTS_FILE = 'weights.json';
/** Minimum instrumented entries before we trust the signal enough to deviate from 1.0 */
const MIN_SAMPLES_TOTAL = 20;
/** Minimum samples per section/type before applying a non-neutral weight */
const MIN_SAMPLES_PER_KEY = 5;
/** Maximum multiplier in either direction */
const WEIGHT_MAX = 2.0;
const WEIGHT_MIN = 0.5;

// ─── Persistence ─────────────────────────────────────────────────────────────

export function loadWeights(moagDir: string): ContextWeights {
  try {
    const filePath = path.join(moagDir, WEIGHTS_FILE);
    if (!fs.existsSync(filePath)) { return { ...DEFAULT_WEIGHTS }; }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as ContextWeights;
    if (typeof parsed.version !== 'number') { return { ...DEFAULT_WEIGHTS }; }
    return parsed;
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

export function saveWeights(moagDir: string, weights: ContextWeights): void {
  try {
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    fs.writeFileSync(
      path.join(moagDir, WEIGHTS_FILE),
      JSON.stringify(weights, null, 2),
      'utf-8',
    );
  } catch { /* best-effort */ }
}

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Compute outcome-correlated weights from instrumented history entries.
 * Only entries with `contextBudgetUsage.sectionBreakdown` contribute.
 */
export function analyzeWeights(entries: HistoryEntry[]): ContextWeights {
  const instrumented = entries.filter(
    e => e.contextBudgetUsage?.sectionBreakdown && e.status,
  );

  if (instrumented.length < MIN_SAMPLES_TOTAL) {
    return { ...DEFAULT_WEIGHTS, sampleCount: instrumented.length };
  }

  const totalCompleted = instrumented.filter(e => e.status === 'completed').length;
  const baselineSuccessRate = totalCompleted / instrumented.length;

  // ─── Section weights ───
  // For each section, compute success rate among tasks that had that section
  const sectionStats = new Map<string, { success: number; total: number }>();

  for (const entry of instrumented) {
    const bd = entry.contextBudgetUsage!.sectionBreakdown!;
    for (const sectionName of Object.keys(bd)) {
      if (!sectionStats.has(sectionName)) {
        sectionStats.set(sectionName, { success: 0, total: 0 });
      }
      const s = sectionStats.get(sectionName)!;
      s.total++;
      if (entry.status === 'completed') { s.success++; }
    }
  }

  const sectionWeights: Record<string, number> = {};
  for (const [name, stats] of sectionStats) {
    if (stats.total < MIN_SAMPLES_PER_KEY) { continue; }
    const sectionSuccessRate = stats.success / stats.total;
    const raw = baselineSuccessRate > 0 ? sectionSuccessRate / baselineSuccessRate : 1.0;
    sectionWeights[name] = clamp(raw, WEIGHT_MIN, WEIGHT_MAX);
  }

  // ─── Task-type weights ───
  const typeStats = new Map<string, { success: number; total: number }>();

  for (const entry of instrumented) {
    const t = entry.taskType ?? 'agent';
    if (!typeStats.has(t)) { typeStats.set(t, { success: 0, total: 0 }); }
    const s = typeStats.get(t)!;
    s.total++;
    if (entry.status === 'completed') { s.success++; }
  }

  const taskTypeWeights: Record<string, number> = {};
  for (const [typeName, stats] of typeStats) {
    if (stats.total < MIN_SAMPLES_PER_KEY) { continue; }
    const typeSuccessRate = stats.success / stats.total;
    const raw = baselineSuccessRate > 0 ? typeSuccessRate / baselineSuccessRate : 1.0;
    taskTypeWeights[typeName] = clamp(raw, WEIGHT_MIN, WEIGHT_MAX);
  }

  return {
    version: 1,
    computedAt: new Date().toISOString(),
    sampleCount: instrumented.length,
    sectionWeights,
    taskTypeWeights,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
