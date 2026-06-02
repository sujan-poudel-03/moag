// ─── Internal error log (.moag/errors.jsonl) ─────────────────────────────────
//
// Collects extension-internal errors (uncaught exceptions, runner failures,
// GitHub CLI errors, KG rebuild failures) into a rolling JSONL file so they
// can be attached to bug reports automatically.

import * as fs from 'fs';
import * as path from 'path';

export type ErrorCategory =
  | 'uncaught'
  | 'unhandled-rejection'
  | 'runner'
  | 'github'
  | 'kg'
  | 'plan'
  | 'fs'
  | 'general';

export interface InternalError {
  ts: string;
  category: ErrorCategory;
  message: string;
  stack?: string;
  context?: string;
}

const ERROR_LOG_FILE = 'errors.jsonl';
const MAX_ENTRIES = 50;

/**
 * Append one error entry to .moag/errors.jsonl.
 * Best-effort — never throws. Rotates to keep last MAX_ENTRIES entries.
 * @param moagDir  Absolute path to the .moag workspace directory
 * @param err      The error to record
 * @param outputFn Optional sink for real-time display (e.g. VS Code OutputChannel.appendLine)
 */
export function appendErrorLog(
  moagDir: string,
  err: InternalError,
  outputFn?: (line: string) => void,
): void {
  try {
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const logPath = path.join(moagDir, ERROR_LOG_FILE);
    fs.appendFileSync(logPath, JSON.stringify(err) + '\n', 'utf-8');
    // Rotate: keep only the last MAX_ENTRIES lines
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length > MAX_ENTRIES) {
      fs.writeFileSync(logPath, lines.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf-8');
    }
    outputFn?.(`[${err.category}] ${err.message}${err.context ? ' | ' + err.context : ''}`);
  } catch { /* non-critical — never throw from error logger */ }
}

/**
 * Read the most recent `n` entries from .moag/errors.jsonl.
 * Returns [] if the file doesn't exist or any read/parse error occurs.
 * Malformed lines are silently skipped.
 * @param moagDir  Absolute path to the .moag workspace directory
 * @param n        Maximum number of entries to return (default 10)
 */
export function readRecentErrors(moagDir: string, n = 10): InternalError[] {
  try {
    const logPath = path.join(moagDir, ERROR_LOG_FILE);
    if (!fs.existsSync(logPath)) { return []; }
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map(l => { try { return JSON.parse(l) as InternalError; } catch { return null; } })
      .filter((e): e is InternalError => e !== null);
  } catch { return []; }
}
