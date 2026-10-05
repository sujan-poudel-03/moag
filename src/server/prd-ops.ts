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
  field: 'command' | 'verifyCommand' | 'cwd' | 'healthCheckUrl' | 'skipIf' | 'failurePolicy';
  /** Verbatim — the reviewer must see exactly what will run. */
  value: string;
}

/** Task fields a generated plan may never carry: removed before hashing and review. */
export const STRIPPED_GENERATED_FIELDS = ['env', 'inheritEnvFiles', 'githubRelease', 'releaseTag'] as const;
export type StrippedGeneratedField = typeof STRIPPED_GENERATED_FIELDS[number];

export interface PendingPlaylistReview {
  ok: boolean;
  /** Engine violations; non-empty means the playlist must not be approved. */
  errors: string[];
  /** Every command, cwd override and side-effect field in the playlist, verbatim. */
  commands: ReviewItem[];
  /** Side-effect fields the server removed from the generated tasks. */
  stripped?: Array<{ taskId: string; taskName: string; field: StrippedGeneratedField }>;
}

/**
 * Remove {@link STRIPPED_GENERATED_FIELDS} from every task of a generated
 * playlist: env injection, env-file inheritance and git tag/push are never
 * model-chosen. Mutates `pl`; returns what was removed.
 */
export function stripGeneratedSideEffects(pl: PlanFilePlaylist): NonNullable<PendingPlaylistReview['stripped']> {
  const stripped: NonNullable<PendingPlaylistReview['stripped']> = [];
  for (const t of (pl.tasks ?? []) as PlanFileTask[]) {
    for (const field of STRIPPED_GENERATED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(t, field)) {
        delete t[field];
        stripped.push({ taskId: t.id, taskName: t.name, field });
      }
    }
  }
  return stripped;
}

/**
 * Check a generated playlist before it can be approved: every engine it names
 * must be in `allowedEngines` and never `custom`/`copilot`; and list every shell
 * string it would run (any task type, deploy and release included) and every
 * side-effect field (`healthCheckUrl`, `skipIf`, `failurePolicy`) so the
 * reviewer sees them verbatim.
 */
export function validatePendingPlaylist(pl: PlanFilePlaylist, allowedEngines: readonly EngineId[]): PendingPlaylistReview {
  const allowed = new Set(allowedEngines.filter((e) => !SERVER_FORBIDDEN_ENGINES.includes(e)));
  const errors: string[] = [];
  const commands: ReviewItem[] = [];
  const checkEngine = (engine: unknown, where: string): void => {
    if (engine === undefined) { return; }
    if (typeof engine !== 'string' || !allowed.has(engine as EngineId)) {
      errors.push(`${where} uses engine "${String(engine)}", which is not allowed for server runs.`);
    }
  };
  checkEngine(pl.engine, `Playlist "${pl.name}"`);
  for (const t of (pl.tasks ?? []) as PlanFileTask[]) {
    const where = `Task "${t.name}"`;
    checkEngine(t.engine, where);
    for (const e of t.consensus?.engines ?? []) { checkEngine(e, where); }
    const base = { taskId: t.id, taskName: t.name, taskType: t.type ?? 'agent' };
    if (typeof t.command === 'string' && t.command.length > 0) { commands.push({ ...base, field: 'command', value: t.command }); }
    if (typeof t.verifyCommand === 'string' && t.verifyCommand.length > 0) { commands.push({ ...base, field: 'verifyCommand', value: t.verifyCommand }); }
    if (typeof t.cwd === 'string' && t.cwd.length > 0) { commands.push({ ...base, field: 'cwd', value: t.cwd }); }
    if (t.healthCheckUrl !== undefined) { commands.push({ ...base, field: 'healthCheckUrl', value: String(t.healthCheckUrl) }); }
    if (t.skipIf !== undefined) { commands.push({ ...base, field: 'skipIf', value: JSON.stringify(t.skipIf) }); }
    if (t.failurePolicy !== undefined) { commands.push({ ...base, field: 'failurePolicy', value: String(t.failurePolicy) }); }
  }
  return { ok: errors.length === 0, errors, commands };
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

// ─── Ship gate (server-owned) ───

export const SHIP_GATE_NAME = 'Ship approval';

const SHIP_GATE_PROMPT = 'Ship gate: an approver reviews the completed work for this PRD version and approves shipping it. '
  + 'Added by the server to every generated plan; the run halts here until a human decides.';

/**
 * Append the server-owned terminal ship gate to a generated playlist: a
 * `manual` task named {@link SHIP_GATE_NAME} that depends on every leaf task
 * (no other task depends on it) and carries every requirement id the playlist
 * cites. Generated plans never contain one on their own, so without this the
 * "gated at ship" policy would be unreachable. Mutates `pl`; returns the gate.
 */
export function appendShipGate(pl: PlanFilePlaylist, gateId: string): PlanFileTask {
  const tasks = pl.tasks ?? [];
  const taken = new Set(tasks.map((t) => t.id));
  let id = gateId;
  for (let n = 2; taken.has(id); n++) { id = `${gateId}-${n}`; }
  const dependedOn = new Set(tasks.flatMap((t) => t.dependsOn ?? []));
  const leaves = tasks.filter((t) => !dependedOn.has(t.id)).map((t) => t.id);
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
  pl.tasks = [...tasks, gate];
  return gate;
}

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
