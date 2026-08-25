// ─── Park queue — halts that survive until a human comes back ────────────────
//
// MOAG already halts correctly: it stops at a ship gate, at a cost ceiling, on
// a repeated failure. But a halt was only ever an EVENT, and events do not
// survive until morning. An operator returning after eight hours had no record
// of why the run stopped or what they were being asked to decide.
//
// Each park is one line of JSONL in `.moag/queue.jsonl`, appended and never
// rewritten, so a crash mid-write costs at most the line being written and a
// concurrent daemon cannot clobber the file.
//
// Dependency-injected and free of `vscode`, like evidence.ts and prd-loop.ts.

import * as path from 'path';

/**
 * Why the run stopped and is waiting on a person. Closed set — a new member
 * needs a decision line in `decisionFor` and an entry in `describeParkReason`.
 */
export type ParkReason =
  | 'manual-gate'
  | 'budget-exceeded'
  | 'repeated-failure'
  | 'missing-capability'
  | 'gate-failure';

export interface ParkedItem {
  id: string;
  /** ISO timestamp. */
  parkedAt: string;
  reason: ParkReason;
  planName: string;
  playlistName: string;
  taskId: string;
  taskName: string;
  /** What a human is actually being asked to decide. */
  decision: string;
  runId?: string;
  evidence?: {
    changedFiles?: string[];
    lastError?: string;
    attempts?: number;
    gate?: string;
    costUsd?: number;
    budgetUsd?: number;
  };
  /** ISO timestamp, set when a human clears the item. */
  resolvedAt?: string;
}

/** The minimum filesystem surface this module needs, so tests need no disk. */
export interface FsLike {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts: { recursive: boolean }): void;
  appendFileSync(p: string, data: string, enc: 'utf-8'): void;
  readFileSync(p: string, enc: 'utf-8'): string;
  writeFileSync(p: string, data: string, enc: 'utf-8'): void;
}

const QUEUE_FILE = 'queue.jsonl';
const MAX_ERROR_CHARS = 800;
const MAX_EVIDENCE_FILES = 50;

/** Absolute path of the park queue for a workspace. */
export function queuePath(cwd: string): string {
  return path.join(cwd, '.moag', QUEUE_FILE);
}

/** Cap the evidence so one pathological task cannot bloat the queue file. */
function trimEvidence(ev: ParkedItem['evidence']): ParkedItem['evidence'] {
  if (!ev) { return undefined; }
  return {
    ...ev,
    lastError: ev.lastError ? ev.lastError.slice(0, MAX_ERROR_CHARS) : undefined,
    changedFiles: ev.changedFiles ? ev.changedFiles.slice(0, MAX_EVIDENCE_FILES) : undefined,
  };
}

/**
 * Append one parked item.
 *
 * Never throws. A run that has already stopped must not also crash because the
 * queue file was unwritable — the halt still reached the operator through the
 * live event, and losing the record is strictly less bad than losing the run.
 */
export function park(cwd: string, item: ParkedItem, fs: FsLike): boolean {
  try {
    const dir = path.dirname(queuePath(cwd));
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const line = JSON.stringify({ ...item, evidence: trimEvidence(item.evidence) }) + '\n';
    fs.appendFileSync(queuePath(cwd), line, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the queue.
 *
 * A malformed line is skipped rather than failing the read: the file is
 * append-only from possibly-crashed writers, so a torn last line is expected
 * and must not hide the items written before it.
 */
export function readQueue(cwd: string, fs: FsLike): ParkedItem[] {
  try {
    const p = queuePath(cwd);
    if (!fs.existsSync(p)) { return []; }
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l): ParkedItem | null => {
        try { return JSON.parse(l) as ParkedItem; } catch { return null; }
      })
      .filter((x): x is ParkedItem => x !== null);
  } catch {
    return [];
  }
}

/** Items still waiting on a person, newest first. */
export function openItems(cwd: string, fs: FsLike): ParkedItem[] {
  return readQueue(cwd, fs)
    .filter((i) => !i.resolvedAt)
    .sort((a, b) => b.parkedAt.localeCompare(a.parkedAt));
}

/**
 * Mark an item resolved. Rewrites the file, which is safe because resolving is
 * an interactive act — it never races an unattended append the way parking does.
 */
export function resolveItem(cwd: string, id: string, at: string, fs: FsLike): boolean {
  const all = readQueue(cwd, fs);
  const target = all.find((i) => i.id === id && !i.resolvedAt);
  if (!target) { return false; }
  target.resolvedAt = at;
  try {
    fs.writeFileSync(queuePath(cwd), all.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Short label for a reason. */
export function describeParkReason(reason: ParkReason): string {
  switch (reason) {
    case 'manual-gate':        return 'Waiting for human approval at a ship gate';
    case 'budget-exceeded':    return 'Stopped at the cost ceiling';
    case 'repeated-failure':   return 'Failed repeatedly and stopped retrying';
    case 'missing-capability': return 'Needs a tool or credential that is not available';
    case 'gate-failure':       return 'A verification gate did not pass';
  }
}

/**
 * The question the operator is answering. This is the whole point of the
 * queue: a reason explains the past, a decision tells them what to do now.
 */
export function decisionFor(reason: ParkReason, ev?: ParkedItem['evidence']): string {
  switch (reason) {
    case 'manual-gate':
      return 'Review the change and approve it to ship, or send it back with a correction.';
    case 'budget-exceeded':
      return ev?.budgetUsd
        ? `Spend passed the $${ev.budgetUsd} ceiling. Raise the ceiling, reduce scope, or stop here.`
        : 'Spend passed the ceiling. Raise it, reduce scope, or stop here.';
    case 'repeated-failure':
      return `Failed ${ev?.attempts ?? 'several'} times. Decide whether the task is wrong, the code is wrong, or it needs a person.`;
    case 'missing-capability':
      return 'Install or configure what the task needs, then requeue it.';
    case 'gate-failure':
      return ev?.gate
        ? `The gate \`${ev.gate}\` did not pass. Fix the code, or change the gate if it is wrong.`
        : 'A gate did not pass. Fix the code, or change the gate if it is wrong.';
  }
}
