// ─── Per-project server state ───
//
// Layout under the data dir:
//   projects/<id>/plan.json    canonical plan — server-owned, OUTSIDE the workspace
//   projects/<id>/state.json   plans under review, runs, per-version spend, override locks
//   projects/<id>/runs/<runId>/ job.json, config.json, plan.json snapshot, events.jsonl
// Every write is atomic. Mutations for one project are serialized with
// `withProjectLock`, so read-modify-write sequences that span an `await` stay safe.

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';
import { createEmptyPlan, dehydratePlan, loadPlan } from '../models/plan';
import { EngineId, Plan, PlanFilePlaylist, TaskStatus } from '../models/types';
import { RunView } from './worker-protocol';
import { PendingPlaylistReview, mergeRunSnapshot } from './prd-ops';
import { StackId } from './stacks';

export const PLAN_REVIEW_STATUSES = [
  'generating', 'pending', 'approved', 'rejected', 'cancelled',
  'no-delta', 'engine-failed', 'parse-failed', 'all-rejected', 'ran', 'interrupted',
] as const;
export type PlanReviewStatus = typeof PLAN_REVIEW_STATUSES[number];

export const RUN_STATUSES = [
  'running', 'awaiting-approval', 'completed', 'gaps', 'error', 'budget', 'stopped', 'ship-rejected', 'interrupted',
] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export interface PlanReview {
  id: string;
  status: PlanReviewStatus;
  mode: 'delta' | 'initial';
  engine: EngineId;
  /** `createdAt` of the PRD version this plan was generated for (stable across relabels). */
  forVersionCreatedAt: string;
  forVersionLabel: string;
  requestedBy: string;
  requestedAt: string;
  /** Dehydrated playlist awaiting review (only for `pending`/`approved`/`ran`). */
  playlist?: PlanFilePlaylist;
  contentHash?: string;
  review?: PendingPlaylistReview;
  rejected?: Array<{ taskName: string; reason: string }>;
  error?: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  /** Index of the playlist in the canonical plan once approved. */
  playlistIndex?: number;
  /** The project's default engine when the reviewer approved: runs refuse to start on any other. */
  approvedEngine?: EngineId;
  /** The approved standards version the planner was given. Absent on plans generated before projects had standards. */
  standardsVersion?: number;
}

export interface GateDecision {
  action: 'approve' | 'reject' | 'skip';
  by: string;
  at: string;
  note?: string;
}

export interface RunRecord {
  id: string;
  planId: string;
  status: RunStatus;
  startedBy: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Spend bucket: the PRD version's `createdAt`. */
  versionCreatedAt: string;
  /** Project stack frozen at run start (stamped onto outcomes). */
  stack: StackId;
  segments: number;
  view?: RunView;
  gate?: { taskId: string; name: string };
  gateDecisions?: GateDecision[];
  stoppedBy?: string;
  errorTail?: string;
  /** Pid of the current segment's worker process (also in the project's job.lock). */
  workerPid?: number;
  /**
   * The standards version frozen at run start (the latest approved one then). Every
   * segment of the run uses it, whatever is approved later. Absent: the run had none.
   */
  standardsVersion?: number;
  /** `contentHash` of that version; a resumed segment refuses a store record that no longer matches. */
  standardsHash?: string;
  /**
   * What the standards check diffs against, across every segment: the ref the project
   * last SHIPPED at ({@link ProjectState.lastShipped}), else the base of its earliest run,
   * else HEAD at this run's start. Never simply "HEAD now" — work a previous run committed
   * without shipping must stay inside the diff. null = no commit to diff against, so every
   * file counts as added.
   */
  baseRef?: string | null;
  /** Totals of the latest standards report the worker sent (the full report is in the run dir). */
  standardsSummary?: RunStandardsSummary;
  /**
   * Design files this run's start reverted to the approved content (repository-relative).
   * Absent when it replaced none, and on runs recorded before this was kept.
   */
  designFilesReplaced?: string[];
  /** Where the replaced files were kept, relative to the project's data directory (`runs/<id>/design-replaced`). */
  designBackupDir?: string;
  /**
   * When `standardsVersion` was frozen onto the run: at its start, or when the ship of a run
   * that started before standards existed was approved. Absent on runs recorded before this
   * was kept — the gate.approve audit entry then tells (`standardsFrozenAtApproval`).
   */
  standardsFrozenAt?: 'start' | 'gate-approval';
  /**
   * sha256 of the run directory's `changed-files.json`, written by the server when the run
   * halted at its ship gate. The run directory is writable by the agent: a list whose hash
   * no longer matches is shown as not collected.
   */
  changedFilesSha256?: string;
  /** Why no changed-files list was collected at the gate. */
  changedFilesError?: string;
}

/** When in a run a standards report was produced. */
export type StandardsReportPhase = 'pre-gate' | 'verify';

export interface RunStandardsSummary {
  /** 'pre-gate' = the informational check at the ship gate; 'verify' = the authoritative one. */
  phase: StandardsReportPhase;
  version: number | null;
  /** Commands that passed. A rule MOAG decides itself is never counted here. */
  passed: number;
  /** Scanner rules that read something and found nothing — not a pass. Absent on older summaries. */
  noFindings?: number;
  /** BLOCKING rules and commands that failed or have findings: what stops a ship. */
  failed: number;
  /** Advisory rules with findings: reported, never blocking. Absent on summaries written before severities existed. */
  advisory?: number;
  /** Rules the profile configures that could not be decided. Never counted as passed. */
  notChecked: number;
  /** Rules the profile does not configure: no gap, never "not checked". Absent on older summaries. */
  notConfigured?: number;
  /** Blocking rules and commands that ended not checked: any above zero stops a ship. Absent on older summaries. */
  blockingNotChecked?: number;
  findings: number;
  /** How many of the findings are advisory. Absent on older summaries. */
  advisoryFindings?: number;
  /** Changed files no line rule read (vendored, generated, no lexer, unreadable). Absent on older summaries. */
  notCheckedFiles?: number;
  at: string;
}

export interface ProjectState {
  schemaVersion: 1;
  plans: PlanReview[];
  runs: RunRecord[];
  versionSpend: Record<string, number>;
  overrideLocked: Record<string, true>;
  /**
   * HEAD of the workspace when a run last stamped a release — the only moment work is
   * known to have passed every gate. Later runs diff their standards check against it.
   * Written only when `stampApprovedShip` stamps; absent until the project first ships.
   * Never written with a null `ref`: a ship whose HEAD could not be read leaves the previous
   * value in place. A null stored by an earlier build is ignored when the base is resolved.
   */
  lastShipped?: { ref: string | null; runId: string; at: string };
}

export function emptyProjectState(): ProjectState {
  return { schemaVersion: 1, plans: [], runs: [], versionSpend: {}, overrideLocked: {} };
}

/** File-backed state for every project, one directory per project. */
export class ProjectStateStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  projectDir(projectId: string): string { return path.join(this.dataDir, 'projects', projectId); }
  runDir(projectId: string, runId: string): string { return path.join(this.projectDir(projectId), 'runs', runId); }
  canonicalPlanPath(projectId: string): string { return path.join(this.projectDir(projectId), 'plan.json'); }
  private statePath(projectId: string): string { return path.join(this.projectDir(projectId), 'state.json'); }

  load(projectId: string): ProjectState {
    let raw: string;
    try { raw = fs.readFileSync(this.statePath(projectId), 'utf-8'); } catch { return emptyProjectState(); }
    const parsed = JSON.parse(raw) as Partial<ProjectState>;
    if (!parsed || parsed.schemaVersion !== 1) {
      throw new Error(`state.json for project ${projectId} has an unsupported format.`);
    }
    return { ...emptyProjectState(), ...parsed } as ProjectState;
  }

  save(projectId: string, state: ProjectState): void {
    writeFileAtomicSync(this.statePath(projectId), JSON.stringify(state, null, 2), 0o600);
  }

  /** Load, mutate and save in one step. */
  update<T>(projectId: string, fn: (s: ProjectState) => T): T {
    const s = this.load(projectId);
    const out = fn(s);
    this.save(projectId, s);
    return out;
  }

  /**
   * The canonical plan, or an empty one named after the project when none exists yet.
   *
   * `defaultEngine` is the PROJECT's engine and is stamped onto the plan: the
   * runner resolves task → playlist → `plan.defaultEngine`, so a plan left at
   * `createEmptyPlan`'s hard-coded `'claude'` would run every task on Claude
   * whatever engine the project chose. Every server caller passes it.
   */
  loadCanonicalPlan(projectId: string, nameIfMissing: string, defaultEngine?: EngineId): Plan {
    const p = this.canonicalPlanPath(projectId);
    const plan = fs.existsSync(p) ? loadPlan(p) : createEmptyPlan(nameIfMissing);
    if (defaultEngine) { plan.defaultEngine = defaultEngine; }
    return plan;
  }

  /** Save the canonical plan; `defaultEngine` (the project's engine) is stamped first, as in {@link loadCanonicalPlan}. */
  saveCanonicalPlan(projectId: string, plan: Plan, defaultEngine?: EngineId): void {
    if (defaultEngine) { plan.defaultEngine = defaultEngine; }
    writeFileAtomicSync(this.canonicalPlanPath(projectId), JSON.stringify(dehydratePlan(plan), null, 2), 0o600);
  }

  /**
   * Serialize async work per project: each call runs after the previous one
   * for the same id settles (success or failure).
   */
  withProjectLock<T>(projectId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    const tail = next.then(() => undefined, () => undefined);
    this.locks.set(projectId, tail);
    void tail.then(() => { if (this.locks.get(projectId) === tail) { this.locks.delete(projectId); } });
    return next;
  }

  /**
   * After a crash/restart nothing is running: mark in-flight runs and plan
   * generations `interrupted`. Each interrupted run's snapshot is merged into
   * the canonical plan, so tasks it already completed (and paid for) are not
   * rerun; a task caught mid-flight (`running`/`paused`) keeps its canonical
   * status. Returns how many records changed.
   */
  recoverOnBoot(projectIds: readonly string[], now: Date = new Date(), log?: (message: string) => void): number {
    let changed = 0;
    for (const id of projectIds) {
      let state: ProjectState;
      try { state = this.load(id); } catch { continue; }
      let dirty = false;
      const interrupted: string[] = [];
      for (const r of state.runs) {
        if (r.status === 'running') {
          r.status = 'interrupted'; r.endedAt = now.toISOString(); dirty = true; changed++;
          interrupted.push(r.id);
        }
      }
      for (const p of state.plans) {
        if (p.status === 'generating') { p.status = 'interrupted'; dirty = true; changed++; }
      }
      if (interrupted.length > 0) { this.mergeInterruptedRuns(id, interrupted, log); }
      if (dirty) { this.save(id, state); }
    }
    return changed;
  }

  /** Merge each interrupted run's snapshot (in record order) into the canonical plan. Never throws. */
  private mergeInterruptedRuns(projectId: string, runIds: readonly string[], log?: (message: string) => void): void {
    const canonicalPath = this.canonicalPlanPath(projectId);
    if (!fs.existsSync(canonicalPath)) { return; }
    let canonical: Plan;
    try { canonical = loadPlan(canonicalPath); } catch (err) {
      log?.(`boot recovery ${projectId}: canonical plan unreadable: ${(err as Error).message}`);
      return;
    }
    let merged = false;
    for (const runId of runIds) {
      const snapPath = path.join(this.runDir(projectId, runId), 'plan.json');
      if (!fs.existsSync(snapPath)) { continue; }
      try {
        const snap = loadPlan(snapPath);
        // A task the crash caught mid-flight did not finish: never carry `running`/`paused`.
        for (const pl of snap.playlists) {
          for (const t of pl.tasks) {
            if (t.status === TaskStatus.Running || t.status === TaskStatus.Paused) {
              (t as { status?: TaskStatus }).status = undefined;
            }
          }
        }
        mergeRunSnapshot(canonical, snap);
        merged = true;
      } catch (err) {
        log?.(`boot recovery ${projectId}/${runId}: snapshot merge failed: ${(err as Error).message}`);
      }
    }
    if (!merged) { return; }
    try { this.saveCanonicalPlan(projectId, canonical); } catch (err) {
      log?.(`boot recovery ${projectId}: canonical plan save failed: ${(err as Error).message}`);
    }
  }
}
