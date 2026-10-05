// ─── Ship-gate resume (pure) ───
//
// A run halted at a manual ship gate exits 3 with the gate task Failed (the
// runner aborted it). When an approver approves — or an admin skips — the
// server rewrites the run snapshot so a new segment can continue: the gate
// becomes Completed and every transitive dependent that the halt left Blocked,
// Skipped or Failed goes back to Pending. The runner's resume rule then skips
// completed tasks. Skip deliberately ALSO means Completed (not Skipped): a
// Skipped gate would cascade-skip the release task via dependency checks. The
// approve/skip distinction lives in the audit log and the run record.

import { Plan, TaskStatus } from '../models/types';
import { stampRelease } from '../models/requirement-trace';

const RESETTABLE = new Set<TaskStatus>([TaskStatus.Blocked, TaskStatus.Skipped, TaskStatus.Failed]);

export class GateResumeError extends Error {
  constructor(message: string) { super(message); this.name = 'GateResumeError'; }
}

/**
 * Mark `gateTaskId` Completed and reset its transitive dependents (via
 * `dependsOn`, across playlists). Throws when the task is missing or is not a
 * `manual` task. Returns the ids reset to Pending.
 */
export function prepareGateResume(plan: Plan, gateTaskId: string): string[] {
  const all = plan.playlists.flatMap((pl) => pl.tasks);
  const gate = all.find((t) => t.id === gateTaskId);
  if (!gate) { throw new GateResumeError(`Gate task "${gateTaskId}" not found in the plan.`); }
  if (gate.type !== 'manual') { throw new GateResumeError(`Task "${gateTaskId}" is not a manual ship gate.`); }
  gate.status = TaskStatus.Completed;

  const closure = new Set<string>([gate.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of all) {
      if (closure.has(t.id)) { continue; }
      if ((t.dependsOn ?? []).some((d) => closure.has(d))) {
        closure.add(t.id);
        grew = true;
      }
    }
  }

  const reset: string[] = [];
  for (const t of all) {
    if (t.id !== gate.id && closure.has(t.id) && RESETTABLE.has(t.status)) {
      t.status = TaskStatus.Pending;
      reset.push(t.id);
    }
  }
  return reset;
}

// ─── Ship stamp after an approved gate ───

/**
 * The release tag the server stamps for an approved ship gate. Server-generated
 * from the run id — never model-chosen, and NOT a git tag: generated plans may
 * not tag or push (`STRIPPED_GENERATED_FIELDS`), so the trace records the
 * approval instead.
 */
export function serverShipTag(runId: string): string {
  return `ship-${runId}`;
}

/**
 * Stamp the requirements of an approved run as shipped, on its snapshot. Call
 * only for a segment that resumed after an approver's `approve` and exited 0 —
 * i.e. the post-gate verify pass ran and passed. `stampRelease` then re-checks
 * the evidence itself: a requirement is stamped only when all its tagged tasks
 * (the gate included) are Completed and its latest recorded gates are non-empty
 * and all green. Returns the requirement ids stamped.
 */
export function stampApprovedShip(snapshot: Plan, runId: string, at: string): string[] {
  return stampRelease(snapshot, serverShipTag(runId), at).shipped;
}
