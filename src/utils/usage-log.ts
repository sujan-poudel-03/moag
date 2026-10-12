// ─── Usage log (.moag/usage-log.jsonl) ────────────────────────────────────────
//
// Append-only JSONL record of every engine-call usage event, for the
// Contribution Ledger. Structurally mirrors error-log.ts (fs/path only,
// best-effort, never throws) with one deliberate difference: this file is
// NOT rotated. Unbounded growth is an accepted v1 tradeoff — usage history
// must survive indefinitely so weekly/rolling rollups stay accurate across
// restarts.
//
// `prompt` is the short, human-written task prompt only (the same value the
// runner computes as `task.prompt?.trim() || task.name`) — NEVER the
// assembled context `buildContext()` produces (AI rules, retrieved code
// spans, prior outputs, full task prompt — potentially ~12,000 chars). This
// file is git-tracked by design (see workspace/moag-paths.ts), so anything
// written here is committed to git history forever, un-rotated. Do not widen
// this field to carry assembled context again.

import * as fs from 'fs';
import * as path from 'path';

/** Raw per-engine-call usage facts, independent of who made the call. */
export interface EngineCallUsage {
  ts: string;
  taskId: string;
  taskName: string;
  engine: string;
  /** The short, human-written task prompt — never the assembled context. */
  prompt: string;
  tokenUsageAvailable: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/** A usage event with the resolved developer identity attached. */
export interface UsageLogEntry extends EngineCallUsage {
  developerEmail: string | null;
}

export const USAGE_LOG_FILE = 'usage-log.jsonl';

/**
 * Append one usage entry to .moag/usage-log.jsonl.
 * Best-effort — never throws. Deliberately NOT rotated (unlike errors.jsonl).
 * @param moagDir Absolute path to the .moag workspace directory
 * @param entry   The usage entry to record
 */
export function appendUsageEntry(moagDir: string, entry: UsageLogEntry): void {
  try {
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const logPath = path.join(moagDir, USAGE_LOG_FILE);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* non-critical — never throw from the usage logger */ }
}

/**
 * Read every entry from .moag/usage-log.jsonl.
 * Returns [] if the file doesn't exist or any read error occurs.
 * Malformed lines are silently skipped.
 * @param moagDir Absolute path to the .moag workspace directory
 */
export function readAllUsageEntries(moagDir: string): UsageLogEntry[] {
  try {
    const logPath = path.join(moagDir, USAGE_LOG_FILE);
    if (!fs.existsSync(logPath)) { return []; }
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines
      .map(l => { try { return JSON.parse(l) as UsageLogEntry; } catch { return null; } })
      .filter((e): e is UsageLogEntry => e !== null);
  } catch { return []; }
}
