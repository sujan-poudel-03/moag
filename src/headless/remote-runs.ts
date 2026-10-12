// ─── Remote runs: run records ───
//
// One file per run ONOSOO started on this machine, kept by the daemon (main user):
// <stateDir>/remote/runs/<runId>.json (0600). It is what `stop`, `approve`, `skip`
// and `retry` act on, and it never lives under a project.
//
// `snapshot` is the run's plan as a PlanFile (dehydratePlan), with the statuses the
// child last reported. A record still `live` at daemon start-up was cut short: it
// becomes `interrupted`, and its Running tasks become Failed.
//
// Imports nothing that loads `vscode`.

import * as fs from 'fs';
import * as path from 'path';
import { hydratePlan } from '../models/plan';
import { Plan, PlanFile, TaskStatus } from '../models/types';
import { writeFileAtomicSync } from '../utils/file-io';

export const RUN_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RUN_RECORD_MAX_COUNT = 200;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type RunOutcome = 'live' | 'finished' | 'interrupted';

export interface RemoteRunRecord {
  runId: string;
  projectId: string;
  commandId: string;
  /** The command that started it: start-run, approve, skip or retry. */
  kind: string;
  /** The run this one continues (approve/skip/retry). */
  parentRunId?: string;
  branch: string;
  startSha: string;
  engine: string;
  allotment: number;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  outcome: RunOutcome;
  /** The ship gate the run halted at, if any. */
  gateTaskId: string | null;
  /** Set once an approve/skip/retry has acted on this run: it can be decided once. */
  decided?: { kind: string; commandId: string; at: string };
  importError?: string;
  stopReason?: string;
  /** How the plan was made: a PRD plan carries ship gates, a goal-only plan does not. */
  planKind?: 'goal' | 'prd';
  /**
   * What the child sent back at its end: true when its bundle carried commits, false when it
   * reported none. Absent when it never said (crashed, interrupted).
   */
  commitsSent?: boolean;
  /** The run's branch tip in the runner's mirror, as the child reported it at the end. */
  branchTip?: string;
  snapshot: PlanFile;
}

export class RemoteRuns {
  readonly dir: string;
  private readonly now: () => Date;

  constructor(stateDir: string, opts: { now?: () => Date } = {}) {
    this.dir = path.join(stateDir, 'remote', 'runs');
    this.now = opts.now ?? ((): Date => new Date());
  }

  private file(runId: string): string {
    if (!RUN_ID_RE.test(runId)) { throw new Error(`Unsafe run id: ${JSON.stringify(runId)}`); }
    return path.join(this.dir, `${runId}.json`);
  }

  /** Write a record atomically (0600). Throws when it cannot. */
  save(record: RemoteRunRecord): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(this.file(record.runId), JSON.stringify(record, null, 2), 0o600);
  }

  /** The raw record, or null when there is none (or it is unreadable). */
  get(runId: string): RemoteRunRecord | null {
    if (!RUN_ID_RE.test(runId)) { return null; }
    try {
      const v = JSON.parse(fs.readFileSync(this.file(runId), 'utf-8')) as RemoteRunRecord;
      return v && v.runId === runId && v.snapshot && typeof v.snapshot === 'object' ? v : null;
    } catch {
      return null;
    }
  }

  /** The record with its snapshot hydrated into a Plan; null when missing or unreadable. */
  load(runId: string): { record: RemoteRunRecord; plan: Plan } | null {
    const record = this.get(runId);
    if (!record) { return null; }
    try {
      return { record, plan: hydratePlan(record.snapshot, `run ${runId}`) };
    } catch {
      return null;
    }
  }

  /** Every readable record. */
  list(): RemoteRunRecord[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const out: RemoteRunRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) { continue; }
      const r = this.get(n.slice(0, -'.json'.length));
      if (r) { out.push(r); }
    }
    return out;
  }

  /**
   * At daemon start-up: every record still `live` was cut short. It becomes
   * `interrupted` (no exit code) and its Running tasks Failed. Returns the run ids.
   */
  markInterruptedOnBoot(): string[] {
    const out: string[] = [];
    for (const r of this.list()) {
      if (r.outcome !== 'live') { continue; }
      r.outcome = 'interrupted';
      r.exitCode = null;
      r.endedAt = this.now().toISOString();
      for (const pl of r.snapshot.playlists ?? []) {
        for (const t of pl.tasks ?? []) {
          if (t.status === TaskStatus.Running) { t.status = TaskStatus.Failed; }
        }
      }
      try { this.save(r); out.push(r.runId); } catch { /* left live; the next boot tries again */ }
    }
    return out;
  }

  /** Remove ended records older than 30 days, then the oldest beyond 200. Live records are kept. */
  prune(): void {
    const cutoff = this.now().getTime() - RUN_RECORD_MAX_AGE_MS;
    const ended = this.list()
      .filter((r) => r.outcome !== 'live')
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    ended.forEach((r, i) => {
      const at = Date.parse(r.endedAt ?? r.startedAt);
      if (i >= RUN_RECORD_MAX_COUNT || (Number.isFinite(at) && at < cutoff)) {
        try { fs.rmSync(this.file(r.runId), { force: true }); } catch { /* best effort */ }
      }
    });
  }
}

/**
 * True when `runId` was relayed from this machine by a run started by hand: its spool
 * file exists under <stateDir>/onosoo-spool/<any workspace>/ but no remote record does.
 * (Call only after looking for a record.)
 */
export function isHandStarted(stateDir: string, runId: string): boolean {
  if (!RUN_ID_RE.test(runId)) { return false; }
  const root = path.join(stateDir, 'onosoo-spool');
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return false; }
  return dirs.some((d) => {
    try { return fs.existsSync(path.join(root, d, `${runId}.jsonl`)); } catch { return false; }
  });
}
