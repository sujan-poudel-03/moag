// ─── PRD and plan operations for the hosted server (pure) ───
//
// The web equivalents of `ui/prd-authoring.ts`'s save/relabel flow, without
// vscode: each function takes a plan, mutates it (or a copy) and returns either
// a result or a refusal carrying the HTTP status the route should send. No I/O.

import { createHash } from 'crypto';
import {
  EngineId, Plan, PlanFilePlaylist, PlanFileTask, PrdVersion, SemverBump, TaskStatus,
} from '../models/types';
import {
  BumpRecommendation, RequirementDiff, RequirementParseError, collectReservedRequirementIds, formatVersionLabel, preparePrdVersion,
  relabelLastPrdVersion,
} from '../models/requirements';
import { appendPrdVersion } from '../models/plan';
import { StrippedGeneratedEntry, cwdEscapesWorkspace } from '../shared/generated-plan';

// The generated-plan checks and the ship gate are in shared/: the ONOSOO remote child
// ships in the extension and applies them too, and the server does not ship.
export type { StrippedGeneratedField, StrippedGeneratedEntry } from '../shared/generated-plan';
export { STRIPPED_GENERATED_FIELDS, stripGeneratedSideEffects, cwdEscapesWorkspace } from '../shared/generated-plan';
export { SHIP_GATE_NAME, SHIPPING_TASK_TYPES, shippingTaskIds, appendShipGate } from '../shared/ship-gate';

export const MAX_PRD_TEXT_CHARS = 200_000;
/** Engines a server run may never use: copilot needs a VS Code host, custom runs an arbitrary command. */
export const SERVER_FORBIDDEN_ENGINES: readonly EngineId[] = ['custom', 'copilot'];
/** The empty "version zero" prepended for initial-plan generation. */
export const SYNTHETIC_BASELINE: Readonly<PrdVersion> = Object.freeze({ version: '0.0.0', text: '', createdAt: '1970-01-01T00:00:00.000Z' });

export interface Refusal {
  ok: false;
  status: number;
  reason: string;
  message: string;
  errors?: RequirementParseError[];
}

// ─── PRD save ───

export interface PrdSaveSuccess {
  ok: true;
  entry: PrdVersion;
  diff: RequirementDiff | null;
  recommendation: BumpRecommendation;
  label: string;
  /** Oldest snapshots dropped by the retention cap. */
  dropped: number;
}

/**
 * Save `text` as a new PRD version on `plan` (mutated on success only).
 * `baseCreatedAt` is the `createdAt` of the version the editor started from
 * (null for "no versions yet"); a mismatch means someone else saved in between
 * and is refused as stale rather than silently diffed against their version.
 */
export function savePrdVersion(plan: Plan, input: { text: string; baseCreatedAt: string | null }): PrdSaveSuccess | Refusal {
  if (typeof input.text !== 'string' || input.text.length > MAX_PRD_TEXT_CHARS) {
    return { ok: false, status: 413, reason: 'too-long', message: `PRD text must be at most ${MAX_PRD_TEXT_CHARS} characters.` };
  }
  const versions = plan.prdVersions ?? [];
  const last = versions.length > 0 ? versions[versions.length - 1] : undefined;
  if ((last?.createdAt ?? null) !== input.baseCreatedAt) {
    return {
      ok: false, status: 409, reason: 'stale-base',
      message: last
        ? `${formatVersionLabel(last.version)} was saved while you were editing. Review it, then save again.`
        : 'The version you started from no longer exists.',
    };
  }
  const prep = preparePrdVersion({ text: input.text, versions, reservedIds: collectReservedRequirementIds(plan) });
  if (!prep.ok) {
    if (prep.reason === 'duplicate-ids') {
      return { ok: false, status: 422, reason: 'duplicate-ids', message: prep.message, errors: prep.errors };
    }
    return { ok: false, status: 409, reason: 'no-change', message: prep.message };
  }
  const { versions: next, dropped } = appendPrdVersion(plan.prdVersions, prep.entry);
  plan.prdVersions = next;
  plan.prdSource = prep.taggedText;
  return {
    ok: true,
    entry: prep.entry,
    diff: prep.diff,
    recommendation: prep.recommendation,
    label: formatVersionLabel(prep.entry.version),
    dropped,
  };
}

// ─── Bump override ───

export interface BumpOverrideSuccess {
  ok: true;
  before: { version: string; chosenBump?: SemverBump };
  after: { version: string; chosenBump?: SemverBump };
  recommended: SemverBump | undefined;
  entry: PrdVersion;
}

/**
 * Relabel the latest version with the owner's bump. Refused when locked (a plan
 * was already requested for it), when `expectedCreatedAt` is not the latest
 * version, or for the first version (nothing to override).
 */
export function overrideBump(
  plan: Plan,
  input: { bump: SemverBump; expectedCreatedAt: string; locked: boolean },
): BumpOverrideSuccess | Refusal {
  if (input.locked) {
    return { ok: false, status: 409, reason: 'locked', message: 'The bump is locked because a plan was already requested for this version.' };
  }
  const versions = plan.prdVersions ?? [];
  const last = versions.length > 0 ? versions[versions.length - 1] : undefined;
  if (!last || last.createdAt !== input.expectedCreatedAt) {
    return { ok: false, status: 409, reason: 'stale-version', message: 'Only the latest version can be relabelled.' };
  }
  const relabelled = relabelLastPrdVersion(versions, input.bump);
  if (!relabelled) {
    return { ok: false, status: 409, reason: 'first-version', message: 'The first PRD version has no bump to override.' };
  }
  const entry = relabelled[relabelled.length - 1];
  plan.prdVersions = relabelled;
  return {
    ok: true,
    before: { version: last.version, chosenBump: last.chosenBump },
    after: { version: entry.version, chosenBump: entry.chosenBump },
    recommended: last.recommendedBump,
    entry,
  };
}

// ─── Initial plan ───

/**
 * A deep copy of `plan` with an empty "0.0.0" PRD version prepended, so the
 * delta-plan core sees every requirement of the first real version as added.
 * The input is never mutated.
 */
export function withSyntheticBaseline<P extends Pick<Plan, 'prdVersions'>>(plan: P): P {
  const copy = JSON.parse(JSON.stringify(plan)) as P;
  copy.prdVersions = [{ ...SYNTHETIC_BASELINE }, ...(copy.prdVersions ?? [])];
  return copy;
}

// ─── Run snapshot merge ───

const TASK_STATUSES = new Set<string>(Object.values(TaskStatus));

/**
 * Copy task statuses (by id) and `requirementTrace` from a finished run's
 * snapshot into the canonical plan. Nothing else is taken from the snapshot —
 * notably never `prdVersions`/`prdSource`, so PRD saves made during the run
 * survive. The snapshot is agent-writable, so unknown statuses are ignored.
 * Returns the ids whose status changed.
 */
export function mergeRunSnapshot(canonical: Plan, snapshot: Pick<Plan, 'playlists' | 'requirementTrace'>): string[] {
  const statuses = new Map<string, string>();
  for (const pl of snapshot.playlists ?? []) {
    for (const t of pl.tasks ?? []) {
      if (t && typeof t.id === 'string' && TASK_STATUSES.has(t.status)) { statuses.set(t.id, t.status); }
    }
  }
  const changed: string[] = [];
  for (const pl of canonical.playlists) {
    for (const t of pl.tasks) {
      const s = statuses.get(t.id);
      if (s !== undefined && s !== t.status) {
        t.status = s as TaskStatus;
        changed.push(t.id);
      }
    }
  }
  if (snapshot.requirementTrace !== undefined) {
    canonical.requirementTrace = JSON.parse(JSON.stringify(snapshot.requirementTrace));
  }
  return changed;
}

// ─── Pending-plan review ───

export interface ReviewItem {
  taskId: string;
  taskName: string;
  taskType: string;
  field: 'command' | 'verifyCommand' | 'cwd' | 'healthCheckUrl' | 'skipIf' | 'failurePolicy' | 'incidentRepo' | 'incidentLabel';
  /** Verbatim — the reviewer must see exactly what will run. */
  value: string;
}

export interface PendingPlaylistReview {
  ok: boolean;
  /** Engine, `parallel` and `cwd` violations; non-empty means the playlist must not be approved. */
  errors: string[];
  /** Every command, cwd override and side-effect field in the playlist, verbatim. */
  commands: ReviewItem[];
  /** Side-effect fields the server removed from the generated tasks. */
  stripped?: StrippedGeneratedEntry[];
}

/**
 * Review error for a generated playlist marked `parallel`. Every server cost
 * limit (the per-call cap, the per-version budget) assumes one engine call in
 * flight at a time; a parallel playlist starts several at once.
 */
export const PARALLEL_PLAYLIST_ERROR = 'The generated plan runs its tasks in parallel. Server runs make one engine call at a time, because the cost limits depend on it, so this plan cannot be approved. Request a new plan.';

/**
 * Check a generated playlist before it can be approved: every engine it names
 * must be in `allowedEngines` and never `custom`/`copilot`; the playlist must
 * not be `parallel` ({@link PARALLEL_PLAYLIST_ERROR}); every task `cwd`
 * must stay inside the project workspace ({@link cwdEscapesWorkspace}); and list
 * every shell string it would run (any task type, deploy and release included)
 * and every side-effect field (`healthCheckUrl`, `skipIf`, `failurePolicy`, and
 * a monitor task's `incidentRepo`/`incidentLabel`, which file GitHub issues) so
 * the reviewer sees them verbatim.
 */
export function validatePendingPlaylist(pl: PlanFilePlaylist, allowedEngines: readonly EngineId[]): PendingPlaylistReview {
  return reviewPendingPlaylist(pl, allowedEngines).review;
}

/**
 * The subset of {@link validatePendingPlaylist}'s errors that are about an
 * engine the server does not allow (same strings, same order). Everything else
 * it reports (`parallel`, a `cwd` outside the workspace) is a review error of
 * another kind, so a caller can tell the two apart without parsing text.
 */
export function pendingPlaylistEngineErrors(pl: PlanFilePlaylist, allowedEngines: readonly EngineId[]): string[] {
  return reviewPendingPlaylist(pl, allowedEngines).engineErrors;
}

function reviewPendingPlaylist(pl: PlanFilePlaylist, allowedEngines: readonly EngineId[]): { review: PendingPlaylistReview; engineErrors: string[] } {
  const allowed = new Set(allowedEngines.filter((e) => !SERVER_FORBIDDEN_ENGINES.includes(e)));
  const errors: string[] = [];
  const engineErrors: string[] = [];
  const commands: ReviewItem[] = [];
  const checkEngine = (engine: unknown, where: string): void => {
    if (engine === undefined) { return; }
    if (typeof engine !== 'string' || !allowed.has(engine as EngineId)) {
      const error = `${where} uses engine "${String(engine)}", which is not allowed for server runs.`;
      errors.push(error);
      engineErrors.push(error);
    }
  };
  checkEngine(pl.engine, `Playlist "${pl.name}"`);
  // Truthiness, exactly as the runner decides it (`playlist.parallel && !failSafe`).
  if (pl.parallel) { errors.push(PARALLEL_PLAYLIST_ERROR); }
  for (const t of (pl.tasks ?? []) as PlanFileTask[]) {
    const where = `Task "${t.name}"`;
    checkEngine(t.engine, where);
    for (const e of t.consensus?.engines ?? []) { checkEngine(e, where); }
    const base = { taskId: t.id, taskName: t.name, taskType: t.type ?? 'agent' };
    if (typeof t.command === 'string' && t.command.length > 0) { commands.push({ ...base, field: 'command', value: t.command }); }
    if (typeof t.verifyCommand === 'string' && t.verifyCommand.length > 0) { commands.push({ ...base, field: 'verifyCommand', value: t.verifyCommand }); }
    if (typeof t.cwd === 'string' && t.cwd.length > 0) {
      commands.push({ ...base, field: 'cwd', value: t.cwd });
      if (cwdEscapesWorkspace(t.cwd)) { errors.push(`${where} sets cwd "${t.cwd}", which is outside the project workspace.`); }
    } else if (t.cwd !== undefined && typeof t.cwd !== 'string') {
      errors.push(`${where} sets a cwd that is not a path.`);
    }
    if (t.healthCheckUrl !== undefined) { commands.push({ ...base, field: 'healthCheckUrl', value: String(t.healthCheckUrl) }); }
    if (t.skipIf !== undefined) { commands.push({ ...base, field: 'skipIf', value: JSON.stringify(t.skipIf) }); }
    if (t.failurePolicy !== undefined) { commands.push({ ...base, field: 'failurePolicy', value: String(t.failurePolicy) }); }
    if (t.incidentRepo !== undefined) { commands.push({ ...base, field: 'incidentRepo', value: String(t.incidentRepo) }); }
    if (t.incidentLabel !== undefined) { commands.push({ ...base, field: 'incidentLabel', value: String(t.incidentLabel) }); }
  }
  return { review: { ok: errors.length === 0, errors, commands }, engineErrors };
}

// ─── Credential redaction of model output ───

/**
 * Run `redact` over every string in `value` (object keys included), in place.
 * A generated playlist is model output that every signed-in user can read, and
 * the planning engine ran with an engine credential in its environment, so a
 * PRD can try to make it echo that key into a task name or prompt. Returns how
 * many strings changed; non-zero means a credential was present.
 */
export function redactStringsDeep(value: unknown, redact: (text: string) => string): number {
  let changed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v);
      if (r !== v) { changed++; }
      return r;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { v[i] = walk(v[i]); }
      return v;
    }
    if (v !== null && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const next = walk(obj[key]);
        const k = redact(key);
        if (k !== key) {
          changed++;
          delete obj[key];
        }
        obj[k] = next;
      }
      return obj;
    }
    return v;
  };
  walk(value);
  return changed;
}

/** Review error shown when a generated playlist carried a server credential. */
export const CREDENTIAL_IN_PLAYLIST_ERROR = 'The generated plan contained a server credential. It was redacted, and this plan cannot be approved. Request a new plan.';

/** Deterministic JSON (sorted keys) so equal content always hashes equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') { return JSON.stringify(value) ?? 'null'; }
  if (Array.isArray(value)) { return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`; }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** SHA-256 (hex) of a dehydrated playlist — what an approval must echo. */
export function contentHash(dehydratedPlaylist: unknown): string {
  return createHash('sha256').update(stableStringify(dehydratedPlaylist), 'utf-8').digest('hex');
}
