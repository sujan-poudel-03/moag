// ─── Permissions: one predicate for guards AND for what the UI may render ───
//
// Every route guard calls `canPerform`, and every resource DTO carries
// `allowedActions` computed by the same function — so a control the UI shows
// is exactly a control the server will accept. Role rules first; when the
// caller passes resource state, state rules apply on top.

import { WebRole } from './web-roles';

export const SERVER_ACTIONS = [
  'project.create',
  'project.update',
  'prd.save',
  'prd.bump-override',
  'plan.generate',
  'plan.generate-initial',
  'plan.cancel',
  'plan.approve',
  'plan.reject',
  'run.start',
  'run.stop',
  'gate.approve',
  'gate.reject',
  'gate.skip',
  'standards.propose',
  'standards.approve',
  'standards.reject',
  'standards.accept-defaults',
  'users.manage',
  'audit.view',
  'engines.manage',
  'jobs.force-release',
] as const;
export type ServerAction = typeof SERVER_ACTIONS[number];

/** Which roles may attempt each action at all (before resource state). */
export const ROLE_MATRIX: Readonly<Record<ServerAction, readonly WebRole[]>> = Object.freeze({
  'project.create': ['product-owner', 'admin'],
  'project.update': ['product-owner', 'admin'],
  'prd.save': ['product-owner'],
  'prd.bump-override': ['product-owner'],
  'plan.generate': ['product-owner'],
  // The first PRD version's full plan (no previous version to diff against).
  'plan.generate-initial': ['product-owner'],
  // The requester (always a product owner) or an admin; requester is a state rule.
  'plan.cancel': ['product-owner', 'admin'],
  'plan.approve': ['reviewer'],
  'plan.reject': ['reviewer'],
  'run.start': ['reviewer', 'admin'],
  'run.stop': ['reviewer', 'admin'],
  'gate.approve': ['approver'],
  'gate.reject': ['approver'],
  'gate.skip': ['admin'],
  // Project standards: a product owner (or admin) proposes, a reviewer decides. Approving a
  // profile lets its commands run on the server every run — the same class of decision as
  // approving a plan, so it sits with the same role.
  'standards.propose': ['product-owner', 'admin'],
  'standards.approve': ['reviewer'],
  'standards.reject': ['reviewer'],
  // Only for a project that predates standards, while its automatic proposal is untouched.
  'standards.accept-defaults': ['admin'],
  'users.manage': ['admin'],
  'audit.view': ['admin'],
  // Engine status, re-check and API keys (S3).
  'engines.manage': ['admin'],
  // Delete a project's job.lock held by lingering task pids (audited; kills nothing).
  'jobs.force-release': ['admin'],
});

export interface Actor { id: string; roles: readonly WebRole[]; }

/** Resource state that narrows what an allowed role may do right now. All optional. */
export interface ActionState {
  /** plan.cancel: who requested the plan. */
  requestedBy?: string;
  /** plan.cancel / approve / reject: review status of the plan. */
  planStatus?: string;
  /** prd.bump-override: a plan was already requested for the latest version. */
  overrideLocked?: boolean;
  /** prd.bump-override: the latest version has a recommendation to override. */
  canOverride?: boolean;
  /** plan.generate: the latest PRD version adds or changes requirements (describeDeltaScope non-null). */
  hasDeltaScope?: boolean;
  /** plan.generate-initial: how many PRD versions exist (allowed only at exactly 1). */
  versionCount?: number;
  /** plan.generate*: a plan for the latest version is already generating, pending or approved. */
  openPlan?: boolean;
  /** plan.generate* / run.start: the server refuses jobs (CI lock). */
  runsDisabled?: boolean;
  /** run.start: the project already has a job (run or plan generation) in flight. */
  jobActive?: boolean;
  /** plan.generate* / run.start: the PRD version's cost cap is used up (cap > 0, nothing remaining). */
  budgetExhausted?: boolean;
  /** run.start: the project's engine is known to be missing on this server. */
  engineUnavailable?: boolean;
  /** run.start: the project's default engine changed after the plan was approved. */
  engineChanged?: boolean;
  /** plan.approve / run.start: false when the review rules, applied now, refuse the plan. */
  reviewPasses?: boolean;
  /** run.stop: the runner state of the active run. */
  runnerState?: string;
  /** gate.*: status of the run. */
  runStatus?: string;
  /** standards.approve / reject: status of the standards version being decided. */
  standardsStatus?: string;
  /** standards.accept-defaults: the project predates standards and its pending version is the untouched automatic proposal. */
  standardsAcceptable?: boolean;
  /**
   * plan.generate*: the project has an approved standards version.
   * run.start: false when the project has no approved standards version now (a legacy plan included).
   */
  standardsApproved?: boolean;
}

function hasRole(actor: Actor, action: ServerAction): boolean {
  const allowed = ROLE_MATRIX[action];
  return actor.roles.some((r) => allowed.includes(r));
}

/** May `actor` perform `action` given (optional) resource `state`? */
export function canPerform(actor: Actor, action: ServerAction, state: ActionState = {}): boolean {
  if (!hasRole(actor, action)) { return false; }
  switch (action) {
    case 'plan.cancel':
      if (state.requestedBy !== undefined && state.requestedBy !== actor.id && !actor.roles.includes('admin')) { return false; }
      if (state.planStatus !== undefined && state.planStatus !== 'generating' && state.planStatus !== 'pending') { return false; }
      return true;
    case 'plan.approve':
      // Never offered for a plan the approve route would refuse; rejecting it stays possible.
      if (state.reviewPasses === false) { return false; }
      return state.planStatus === undefined || state.planStatus === 'pending';
    case 'plan.reject':
      return state.planStatus === undefined || state.planStatus === 'pending';
    case 'plan.generate':
      if (state.runsDisabled === true || state.openPlan === true || state.budgetExhausted === true
        || state.standardsApproved === false) { return false; }
      return state.hasDeltaScope === undefined || state.hasDeltaScope;
    case 'plan.generate-initial':
      if (state.runsDisabled === true || state.openPlan === true || state.budgetExhausted === true
        || state.standardsApproved === false) { return false; }
      return state.versionCount === undefined || state.versionCount === 1;
    case 'prd.bump-override':
      if (state.overrideLocked === true) { return false; }
      return state.canOverride === undefined || state.canOverride;
    case 'run.start':
      if (state.runsDisabled === true || state.jobActive === true || state.budgetExhausted === true || state.engineUnavailable === true
        || state.engineChanged === true || state.standardsApproved === false || state.reviewPasses === false) { return false; }
      return state.planStatus === undefined || state.planStatus === 'approved' || state.planStatus === 'ran';
    case 'run.stop':
      return state.runnerState === undefined || state.runnerState === 'playing' || state.runnerState === 'paused';
    case 'gate.approve':
    case 'gate.reject':
    case 'gate.skip':
      return state.runStatus === undefined || state.runStatus === 'awaiting-approval';
    case 'standards.approve':
    case 'standards.reject':
      return state.standardsStatus === undefined || state.standardsStatus === 'pending';
    case 'standards.accept-defaults':
      return state.standardsAcceptable === undefined || state.standardsAcceptable;
    default:
      return true;
  }
}

/** The subset of `candidates` the actor may perform in this state — the DTO's `allowedActions`. */
export function allowedActions(actor: Actor, candidates: readonly ServerAction[], state: ActionState = {}): ServerAction[] {
  return candidates.filter((a) => canPerform(actor, a, state));
}
