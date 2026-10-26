// ─── Usage log (.moag/usage-log.jsonl) ────────────────────────────────────────
//
// Append-only JSONL record of every engine-call usage event, for the
// Contribution Ledger. Structurally mirrors error-log.ts (fs/path only,
// best-effort, never throws). Rotated: once the file reaches 5 MB it becomes
// usage-log.1.jsonl (replacing the previous one) and a new file starts; reads
// cover both, so the ledger's rolling 7-day window survives a rotation.
//
// The log is local to this machine: MOAG no longer adds it to git (it asks
// before touching .gitignore at all, see ui/gitignore-consent.ts). The
// developer's git email is recorded only when
// agentTaskPlayer.contributionLedger.recordDeveloperEmail is on.
//
// `prompt` is the short, human-written task prompt only (the same value the
// runner computes as `task.prompt?.trim() || task.name`) — NEVER the
// assembled context `buildContext()` produces (AI rules, retrieved code
// spans, prior outputs, full task prompt — potentially ~12,000 chars). A
// workspace may still commit .moag/, so do not widen this field to carry
// assembled context again.

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
  /**
   * False when the engine reported no cost (estimatedCostUsd is then 0, not a
   * real zero). Absent in entries written before MOAG recorded it.
   */
  costKnown?: boolean;
}

/** A usage event with the resolved developer identity attached. */
export interface UsageLogEntry extends EngineCallUsage {
  developerEmail: string | null;
}

export const USAGE_LOG_FILE = 'usage-log.jsonl';
/** The previous log, kept after a rotation (one generation). */
export const USAGE_LOG_ROTATED_FILE = 'usage-log.1.jsonl';
/** The log rotates once it reaches this size. */
export const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Append one usage entry to .moag/usage-log.jsonl. When the file has reached
 * `maxBytes`, it first becomes usage-log.1.jsonl (overwriting the old one).
 * Best-effort — never throws.
 * @param moagDir  Absolute path to the .moag workspace directory
 * @param entry    The usage entry to record
 * @param maxBytes Rotation threshold (tests pass a small one)
 */
export function appendUsageEntry(moagDir: string, entry: UsageLogEntry, maxBytes: number = USAGE_LOG_MAX_BYTES): void {
  try {
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const logPath = path.join(moagDir, USAGE_LOG_FILE);
    try {
      if (fs.statSync(logPath).size >= maxBytes) {
        fs.renameSync(logPath, path.join(moagDir, USAGE_LOG_ROTATED_FILE));
      }
    } catch { /* no log yet, or the rename lost a race with another window: append anyway */ }
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* non-critical — never throw from the usage logger */ }
}

/** Where the usage recorder reads its settings and writes; injectable for tests. */
export interface UsageRecorderDeps {
  /** agentTaskPlayer.contributionLedger.enabled */
  enabled(): boolean;
  /** agentTaskPlayer.contributionLedger.recordDeveloperEmail */
  recordEmail(): boolean;
  moagDir(): string | null;
  cwd(): string;
  resolveEmail(cwd: string): string | null;
  append?(moagDir: string, entry: UsageLogEntry): void;
}

/**
 * The runner's usage recorder: nothing when the ledger is off or there is no
 * workspace, and the developer's email only when that setting is on.
 */
export function createUsageRecorder(d: UsageRecorderDeps): (record: EngineCallUsage) => void {
  return (record) => {
    if (!d.enabled()) { return; }
    const moagDir = d.moagDir();
    if (!moagDir) { return; }
    const developerEmail = d.recordEmail() ? d.resolveEmail(d.cwd()) : null;
    (d.append ?? appendUsageEntry)(moagDir, { ...record, developerEmail });
  };
}

/**
 * Read every entry: usage-log.1.jsonl (the rotated file) first, then
 * usage-log.jsonl. Returns [] if neither exists or any read error occurs.
 * Malformed lines are silently skipped.
 * @param moagDir Absolute path to the .moag workspace directory
 */
export function readAllUsageEntries(moagDir: string): UsageLogEntry[] {
  const out: UsageLogEntry[] = [];
  for (const name of [USAGE_LOG_ROTATED_FILE, USAGE_LOG_FILE]) {
    try {
      const logPath = path.join(moagDir, name);
      if (!fs.existsSync(logPath)) { continue; }
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        try { out.push(JSON.parse(l) as UsageLogEntry); } catch { /* malformed line */ }
      }
    } catch { /* unreadable: skip this file */ }
  }
  return out;
}
