// ─── Ship-gate resume (pure) ───
//
// A run halted at a manual ship gate exits 3 with the gate task Failed (the
// runner aborted it). When an approver approves — or an admin skips — the
// server rewrites the run snapshot so a new segment can continue: the gate
// becomes Completed and every transitive dependent that the halt left Blocked,
// Skipped or Failed goes back to Pending. The runner's resume rule then skips
// completed (and skipped) tasks.
//
// A skip NEVER ships. The gate still becomes Completed so the rest of the
// segment (non-shipping dependents, the verify pass) can run, but every
// shipping task downstream of the gate — each `release`/`deploy` task and
// everything that depends on one — is set to Skipped instead of Pending, so
// the runner never executes it and `stampApprovedShip` sees an uncompleted
// release or deploy task. Only an approver's `approve` resets the shipping
// work to Pending. The approve/skip distinction also lives in the audit log
// and the run record.

import { Plan, StandardsCheckCounts, TaskStatus } from '../models/types';
import { stampRelease } from '../models/requirement-trace';
import { SHIPPING_TASK_TYPES } from '../shared/ship-gate';

// The resume itself is in shared/ship-gate.ts: the ONOSOO remote child ships in the
// extension and resumes its own gates, and the server does not ship.
export { GateResumeError, prepareGateResume } from '../shared/ship-gate';
export type { GateResumeKind, GateResumeResult } from '../shared/ship-gate';

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
 *
 * Release and deploy tasks run only after the ship gate, so a run's ship also
 * needs them to have happened: when any `release` or `deploy` task in the
 * run's playlist (`playlistIndex`; every playlist when omitted) is not
 * Completed — failed, skipped, blocked or never reached — nothing is stamped.
 *
 * `standardsVersion` is the standards version frozen on the run at its start; it is
 * recorded on every stamp. A run that had none (a legacy plan) stamps no version, and
 * neither does one whose check did not evaluate the blocking set — the caller then passes
 * none. `standardsCounts` is what that check left open (advisory findings, rules and files
 * not checked); it is recorded beside the version and never without one.
 */
export function stampApprovedShip(
  snapshot: Plan, runId: string, at: string, playlistIndex?: number, standardsVersion?: number, standardsCounts?: StandardsCheckCounts,
): string[] {
  const playlists = playlistIndex === undefined ? snapshot.playlists : [snapshot.playlists[playlistIndex]].filter(Boolean);
  const shippingPending = playlists.some((pl) => pl.tasks.some((t) => SHIPPING_TASK_TYPES.has(t.type ?? 'agent') && t.status !== TaskStatus.Completed));
  if (shippingPending) { return []; }
  return stampRelease(snapshot, serverShipTag(runId), at, { standardsVersion, standardsCounts }).shipped;
}
