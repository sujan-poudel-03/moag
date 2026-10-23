// ─── Ship gate and its resume (pure, shared) ───
//
// The ship gate the hosted server adds to every generated plan, and the
// task-status rewrite that resumes a run halted at it. A run halted at a manual
// ship gate exits 3 with the gate task Failed (the runner aborted it). When an
// approver approves — or an admin skips — the snapshot is rewritten so a new
// segment can continue: the gate becomes Completed and every transitive
// dependent that the halt left Blocked, Skipped or Failed goes back to Pending.
// A skip NEVER ships: every shipping task downstream of the gate is set to
// Skipped instead of Pending (see server/gate.ts for the full rationale).
//
// The server (`server/prd-ops.ts`, `server/gate.ts`, which re-export these) and
// the ONOSOO remote child both use them; the remote child ships in the
// extension and the server does not, so they live here.

import { Plan, PlanFilePlaylist, PlanFileTask, TaskStatus } from '../models/types';

// ─── Ship gate ───

export const SHIP_GATE_NAME = 'Ship approval';

const SHIP_GATE_PROMPT = 'Ship gate: an approver reviews the completed work for this PRD version and approves shipping it. '
  + 'Added by the server to every generated plan; the run halts here until a human decides.';

/** Task types that ship: they run only after the ship gate is approved. */
export const SHIPPING_TASK_TYPES: ReadonlySet<string> = new Set(['release', 'deploy']);

/**
 * Ids of every `release`/`deploy` task in `tasks` plus everything that
 * (transitively, via `dependsOn`) depends on one — the work that ships.
 */
export function shippingTaskIds(tasks: readonly PlanFileTask[]): Set<string> {
  const shipping = new Set(tasks.filter((t) => SHIPPING_TASK_TYPES.has(t.type ?? 'agent')).map((t) => t.id));
  let grew = shipping.size > 0;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (!shipping.has(t.id) && (t.dependsOn ?? []).some((d) => shipping.has(d))) {
        shipping.add(t.id);
        grew = true;
      }
    }
  }
  return shipping;
}

/**
 * Add the server-owned ship gate to a generated playlist: a `manual` task named
 * {@link SHIP_GATE_NAME} that carries every requirement id the playlist cites.
 * Generated plans never contain one on their own, so without this the "gated
 * at ship" policy would be unreachable.
 *
 * The gate gates SHIPPING: it depends on every leaf of the non-shipping work
 * (so, transitively, on every task that is not a release/deploy task or
 * downstream of one), and every release/deploy task — and everything that
 * depends on one — gains a `dependsOn` on the gate. The playlist is reordered
 * to non-shipping tasks, then the gate, then shipping tasks (a stable
 * partition: planner order within each group is preserved), because the sequential runner executes in array order
 * and would otherwise reach a release before its gate. With no release/deploy
 * task the gate is terminal and last. Mutates `pl`; returns the gate.
 */
export function appendShipGate(pl: PlanFilePlaylist, gateId: string): PlanFileTask {
  const tasks = pl.tasks ?? [];
  const taken = new Set(tasks.map((t) => t.id));
  let id = gateId;
  for (let n = 2; taken.has(id); n++) { id = `${gateId}-${n}`; }
  const shipping = shippingTaskIds(tasks);
  const before = tasks.filter((t) => !shipping.has(t.id));
  const after = tasks.filter((t) => shipping.has(t.id));
  // Leaves of the non-shipping work. A non-shipping task never depends on a
  // shipping one (shipping is closed over dependents), so no cycle can form.
  const dependedOnBefore = new Set(before.flatMap((t) => t.dependsOn ?? []));
  const leaves = before.filter((t) => !dependedOnBefore.has(t.id)).map((t) => t.id);
  const reqNum = (r: string): number => Number(r.replace(/^\D+/, '')) || 0;
  const requirementIds = [...new Set(tasks.flatMap((t) => t.requirementIds ?? []))].sort((a, b) => reqNum(a) - reqNum(b) || (a < b ? -1 : a > b ? 1 : 0));
  const gate: PlanFileTask = {
    id,
    name: SHIP_GATE_NAME,
    prompt: SHIP_GATE_PROMPT,
    type: 'manual',
    ...(leaves.length > 0 ? { dependsOn: leaves } : {}),
    ...(requirementIds.length > 0 ? { requirementIds } : {}),
  };
  for (const t of after) {
    const deps = t.dependsOn ?? [];
    if (!deps.includes(id)) { t.dependsOn = [...deps, id]; }
  }
  pl.tasks = [...before, gate, ...after];
  return gate;
}

// ─── Resume after the gate is decided ───

const RESETTABLE = new Set<TaskStatus>([TaskStatus.Blocked, TaskStatus.Skipped, TaskStatus.Failed]);

export class GateResumeError extends Error {
  constructor(message: string) { super(message); this.name = 'GateResumeError'; }
}

/** How a halted ship gate was decided — the two decisions that resume the run. */
export type GateResumeKind = 'approve' | 'skip';

/** The task-status rewrite `prepareGateResume` applied to the snapshot. */
export interface GateResumeResult {
  /** Ids reset to Pending — they run in the next segment. */
  reset: string[];
  /** Ids set to Skipped — shipping work a `skip` must never run. Empty on approve. */
  skipped: string[];
}

/**
 * Mark `gateTaskId` Completed and rewrite its transitive dependents (via
 * `dependsOn`, across playlists). On `approve` every halted dependent goes back
 * to Pending. On `skip` the shipping dependents (release/deploy tasks and
 * everything downstream of one) that are not already Completed become Skipped,
 * and only the non-shipping halted dependents go back to Pending. Throws when
 * the task is missing or is not a `manual` task.
 */
export function prepareGateResume(plan: Plan, gateTaskId: string, kind: GateResumeKind): GateResumeResult {
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

  const shipping = kind === 'skip'
    ? shippingTaskIds(all.map((t): PlanFileTask => ({ id: t.id, name: t.name, prompt: t.prompt, type: t.type, dependsOn: t.dependsOn })))
    : new Set<string>();
  const reset: string[] = [];
  const skipped: string[] = [];
  for (const t of all) {
    if (t.id === gate.id || !closure.has(t.id)) { continue; }
    if (shipping.has(t.id)) {
      if (t.status !== TaskStatus.Completed) {
        t.status = TaskStatus.Skipped;
        skipped.push(t.id);
      }
    } else if (RESETTABLE.has(t.status)) {
      t.status = TaskStatus.Pending;
      reset.push(t.id);
    }
  }
  return { reset, skipped };
}
