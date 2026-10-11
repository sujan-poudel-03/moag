// ─── Per-project standards store ───
//
//   projects/<id>/standards.json   every proposed version of the project's standards
//
// Server-owned and OUTSIDE the workspace, like the canonical plan: an agent's
// edits can never reach it, and the server never reads a `.moag/standards.json`
// the repository shipped. Versions only ever move forward — proposing creates
// version N+1 as `pending`, a reviewer approves or rejects it, and an approved
// version is never changed again by any method here. "In effect" is derived:
// the latest approved version.
//
// The store itself is synchronous and does no locking. Callers serialize
// mutations per project with `ProjectStateStore.withProjectLock`.
//
// Reads are cached per project. The project list is polled, and every poll asks
// where each project stands; without a cache each of those re-read and re-parsed
// the whole version history. A cached history is reused only while the file on
// disk is the one it was read from (same size, same modification and change
// times), and every write through this store replaces it — so a file that was
// removed, restored or edited behind the store's back is read again, never trusted.

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';
import { ConventionDetection, detectConventions } from '../ai-rules/project-detector';
import { builtInProfile } from '../standards/built-in-profiles';
import { StandardsProposal, proposeProfile } from '../standards/propose';
import { DesignChanges, designChangesBetween } from '../standards/design';
import { StackId } from './stacks';
import type { AuditInput } from './audit';
import {
  PROVENANCE_FIELDS,
  EnforcementChanges,
  EnforcementField,
  SeverityChange,
  StandardsCommand,
  StandardsProfile,
  StandardsProvenance,
  StandardsVersionStatus,
  STANDARDS_VERSION_STATUSES,
  enforcementChangesBetween,
  enforcementFieldsChanged,
  profileHash,
  validateProfile,
  validateProvenance,
} from '../standards/profile';

export const STANDARDS_FILE = 'standards.json';
/** Most versions kept per project; a proposal past it is refused. */
export const MAX_STANDARDS_VERSIONS = 200;
/** `proposedBy` of a version the server proposed itself (project creation, boot migration). */
export const SYSTEM_ACTOR = 'system';

export const STANDARDS_ORIGINS = ['auto', 'user'] as const;
export type StandardsOrigin = typeof STANDARDS_ORIGINS[number];

export const STANDARDS_DECISIONS = ['approved', 'accepted-defaults'] as const;
export type StandardsDecision = typeof STANDARDS_DECISIONS[number];

export interface StandardsVersionRecord {
  version: number;
  status: StandardsVersionStatus;
  /** `auto` = proposed by the server from detection; `user` = proposed by a person. */
  origin: StandardsOrigin;
  profile: StandardsProfile;
  provenance: StandardsProvenance;
  /** sha256 of `profile`; what an approval echoes. */
  contentHash: string;
  /** The latest version when this one was proposed, or null for the first. */
  baseVersion: number | null;
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** How an approved version became approved. */
  decision?: StandardsDecision;
  /** Why a rejected version was rejected. */
  reason?: string;
}

interface StandardsFile {
  schemaVersion: 1;
  /** True when the first version was proposed for a project that predates project standards. */
  migrated: boolean;
  versions: StandardsVersionRecord[];
}

/** Stable refusal codes; the HTTP layer maps each to a status. */
export type StandardsStoreErrorCode =
  | 'invalid-standards' | 'stale' | 'too-many-versions' | 'not-found'
  | 'already-decided' | 'hash-mismatch' | 'not-acceptable' | 'acknowledgement-required';

/** A refused store operation. Nothing was written. */
export class StandardsStoreError extends Error {
  constructor(
    public readonly code: StandardsStoreErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StandardsStoreError';
  }
}

export interface ProposeInput {
  profile: unknown;
  provenance: unknown;
  origin: StandardsOrigin;
  proposedBy: string;
  /** The latest version the proposer saw (null when they saw none). */
  baseVersion: number | null;
  /** Mark the project as predating standards. Only honoured for the very first version. */
  migrated?: boolean;
}

/**
 * The version that is in effect while `v` waits for a decision — and that `v` replaces
 * once approved: the latest approved version with a lower number, or null when the project
 * has none.
 *
 * This, not `v.baseVersion`, is what a change must be measured against. The base is only
 * the latest version the proposer saw, and may be a proposal nobody approved: comparing
 * with it lets a demotion ride through a second proposal ("v2 demotes, v3 edits a word on
 * top of v2") and reach effect without ever being shown or audited as a change.
 */
export function inEffectBefore(
  versions: readonly StandardsVersionRecord[], v: Pick<StandardsVersionRecord, 'version'>,
): StandardsVersionRecord | null {
  const earlier = versions.filter((x) => x.status === 'approved' && x.version < v.version);
  return earlier.length > 0 ? earlier[earlier.length - 1] : null;
}

/**
 * What a version changes about enforcement — the commands, the severity of each rule, the
 * required directories — and what that was measured against.
 */
export interface EnforcementReview extends EnforcementChanges {
  /** The approved version the changes are measured against; null when nothing was in effect. */
  comparedTo: number | null;
  /** The fields that differ. Empty when the version changes nothing about enforcement. */
  fields: EnforcementField[];
  /** True when any field differs: approving the version then needs an explicit acknowledgement. */
  changed: boolean;
}

/**
 * What `v` changes about enforcement, measured against the version {@link inEffectBefore}
 * names: the currently approved one while `v` is pending, the one `v` replaced once it is
 * approved, and an empty baseline (no command, default severities, no required directory)
 * when the project had none.
 *
 * The ONE place this comparison is made. The review screen's diff, the acknowledgement an
 * approval must carry and the audit log's flag are all built from it, so none can show or
 * require something another missed, and none is ever measured against `v.baseVersion`.
 *
 * There is no "reduced" or "extended": any difference is a change a reviewer must see.
 */
export function enforcementReview(versions: readonly StandardsVersionRecord[], v: StandardsVersionRecord): EnforcementReview {
  const reference = inEffectBefore(versions, v);
  const changes = enforcementChangesBetween(reference ? reference.profile : null, v.profile);
  const fields = enforcementFieldsChanged(changes);
  return { comparedTo: reference ? reference.version : null, ...changes, fields, changed: fields.length > 0 };
}

/** What a version changes about the design system, and what that was measured against. */
export type DesignReview = DesignChanges & {
  /** The approved version the changes are measured against; null when nothing was in effect. */
  comparedTo: number | null;
};

/**
 * What `v` changes about the design system (DESIGN.md, the tokens, their paths), measured
 * against the same version {@link enforcementReview} uses. The one comparison the review
 * screen, the acknowledgement and the audit log all use. Any difference is a change.
 */
export function designReview(versions: readonly StandardsVersionRecord[], v: StandardsVersionRecord): DesignReview {
  const reference = inEffectBefore(versions, v);
  return {
    comparedTo: reference ? reference.version : null,
    ...designChangesBetween(reference?.profile.design ?? null, v.profile.design ?? null),
  };
}

/** The severity part of {@link enforcementReview}. */
export function severityReview(versions: readonly StandardsVersionRecord[], v: StandardsVersionRecord): SeverityReview {
  const review = enforcementReview(versions, v);
  return { comparedTo: review.comparedTo, changes: review.severity };
}

/** What a version changes about which rules can stop a release, and what that was measured against. */
export interface SeverityReview {
  /** The approved version `changes` are measured against; null when nothing was in effect (the defaults). */
  comparedTo: number | null;
  /** Every rule the version holds at another severity than the reference does, in rule order. */
  changes: SeverityChange[];
}

/**
 * Audit flag — THE invariant: the version differs from what is in force in a field that
 * decides what can stop a release (commands, severities, required directories).
 */
export const ENFORCEMENT_CHANGED_FLAG = 'enforcement-changed';
/** Audit flag, beside {@link ENFORCEMENT_CHANGED_FLAG}: a rule's severity is among the differences. */
export const SEVERITY_CHANGED_FLAG = 'severity-changed';
/** Audit flag, beside {@link ENFORCEMENT_CHANGED_FLAG}: the command list is among the differences. */
export const COMMANDS_CHANGED_FLAG = 'commands-changed';
/**
 * Audit flag: the version's design system differs from the one in force. Not an enforcement
 * change by itself — the design rule is advisory unless promoted, and a promoted rule's
 * configuration change shows up as `enforcement-changed` through `ruleConfig`.
 */
export const DESIGN_CHANGED_FLAG = 'design-changed';
/** Most token rows an audit entry records for a design change. */
const MAX_AUDIT_DESIGN_TOKENS = 100;
/** Audit flag: the approved version to compare with could not be read, so the change is recorded as unverified. */
export const ENFORCEMENT_UNVERIFIED_FLAG = 'enforcement-reference-unreadable';

/** The field-level diff an audit entry holds: for each field that differs, what it held before and after. */
export interface EnforcementAudit {
  comparedTo: number | null;
  commands?: { before: StandardsCommand[]; after: StandardsCommand[] };
  severity?: SeverityChange[];
  requiredDirs?: { before: string[]; after: string[] };
  /** The configuration of a blocking (promoted) rule that differs. */
  ruleConfig?: EnforcementChanges['ruleConfig'];
}

/**
 * The design-system change an audit entry holds: the two file paths and each token's value
 * before and after, and how much of DESIGN.md changed. Never any DESIGN.md text.
 *
 * Keys avoid `token` and `key`: the audit log refuses such keys as secret-shaped. `files`
 * holds `{ doc, values }` (DESIGN.md and the tokens file), `values` the token rows.
 */
export interface DesignAudit {
  comparedTo: number | null;
  files?: { before: { doc: string; values: string } | null; after: { doc: string; values: string } | null };
  values: Array<{ name: string; before: string | null; after: string | null }>;
  /** How many more token rows changed than are listed. */
  valuesTruncated?: number;
  docChanged: boolean;
  docSectionsChanged: number;
}

/** What {@link standardsChangeAudit} adds to an audit entry. */
export interface StandardsChangeAudit {
  /**
   * Merged into the entry's `after`: `enforcementChanged`, only when an enforcement field
   * differs, and `designChanged`, only when the design system differs.
   */
  after: { enforcementChanged?: EnforcementAudit; designChanged?: DesignAudit };
  flags: string[];
}

function designAuditOf(design: DesignReview): DesignAudit {
  const rows = design.tokens.map((t) => ({ name: t.name, before: t.before, after: t.after }));
  const filesOf = (x: { docPath: string; tokensPath: string } | null): { doc: string; values: string } | null =>
    (x ? { doc: x.docPath, values: x.tokensPath } : null);
  return {
    comparedTo: design.comparedTo,
    ...(design.paths ? { files: { before: filesOf(design.paths.before), after: filesOf(design.paths.after) } } : {}),
    values: rows.slice(0, MAX_AUDIT_DESIGN_TOKENS),
    ...(rows.length > MAX_AUDIT_DESIGN_TOKENS ? { valuesTruncated: rows.length - MAX_AUDIT_DESIGN_TOKENS } : {}),
    docChanged: design.docChanged,
    docSectionsChanged: design.sections.length,
  };
}

function auditOf(review: EnforcementReview, design: DesignReview): StandardsChangeAudit {
  const after: StandardsChangeAudit['after'] = {};
  const flags: string[] = [];
  if (review.changed) {
    flags.push(ENFORCEMENT_CHANGED_FLAG);
    if (review.severity.length > 0) { flags.push(SEVERITY_CHANGED_FLAG); }
    if (review.commands !== null) { flags.push(COMMANDS_CHANGED_FLAG); }
    after.enforcementChanged = {
      comparedTo: review.comparedTo,
      ...(review.commands !== null ? { commands: review.commands } : {}),
      ...(review.severity.length > 0 ? { severity: review.severity } : {}),
      ...(review.requiredDirs !== null ? { requiredDirs: review.requiredDirs } : {}),
      ...(review.ruleConfig.length > 0 ? { ruleConfig: review.ruleConfig } : {}),
    };
  }
  if (design.changed) {
    flags.push(DESIGN_CHANGED_FLAG);
    after.designChanged = designAuditOf(design);
  }
  return { after, flags };
}

/**
 * The enforcement part of the audit entry for a propose, an approve or an accept-defaults of
 * `v`: the `enforcement-changed` flag and, for each field that differs from what is in
 * force, what it held before and after.
 *
 * Fails CLOSED. When the store cannot be read, what is in force is unknown, and so is
 * whether `v` changes it. The entry is then flagged as an enforcement change that could not
 * be verified, with `v` measured against the empty baseline — a change can be over-reported,
 * never slip through unflagged.
 */
export function standardsChangeAudit(
  store: Pick<StandardsStore, 'load'>, projectId: string, v: StandardsVersionRecord,
): StandardsChangeAudit {
  try {
    const versions = store.load(projectId).versions;
    return auditOf(enforcementReview(versions, v), designReview(versions, v));
  } catch {
    const assumed = auditOf(enforcementReview([], v), designReview([], v));
    const flags = [ENFORCEMENT_CHANGED_FLAG, ENFORCEMENT_UNVERIFIED_FLAG];
    return {
      after: {
        enforcementChanged: assumed.after.enforcementChanged ?? { comparedTo: null },
        ...(assumed.after.designChanged ? { designChanged: assumed.after.designChanged } : {}),
      },
      flags: [...flags, ...assumed.flags.filter((flag) => !flags.includes(flag))],
    };
  }
}

/** The slice of a project record an automatic proposal needs. */
export interface StandardsProjectRef {
  id: string;
  workspacePath: string;
  stack: StackId;
}

/**
 * Propose version 1 for a project that has no standards yet: detection over the files git
 * tracks in its workspace (read as data; git is asked asynchronously, no model) laid over
 * the stack's built-in profile. Never fails because detection failed — a workspace
 * that cannot be read yields the built-in profile with every area `assumed`.
 *
 * Returns null when the project already has a standards file. Throws only when
 * the store itself cannot be read or written.
 */
export async function proposeAutomatic(
  store: StandardsStore,
  project: StandardsProjectRef,
  opts: { migrated: boolean; now?: Date; detect?: (cwd: string) => ConventionDetection | Promise<ConventionDetection> },
): Promise<StandardsVersionRecord | null> {
  if (store.exists(project.id)) { return null; }
  let proposal: StandardsProposal;
  try {
    proposal = proposeProfile(project.stack, await (opts.detect ?? detectConventions)(project.workspacePath));
  } catch {
    const provenance = {} as StandardsProvenance;
    for (const field of PROVENANCE_FIELDS) { provenance[field] = { tag: 'assumed', evidence: `${project.stack} default` }; }
    proposal = { profile: builtInProfile(project.stack), provenance };
  }
  return store.propose(project.id, {
    profile: proposal.profile, provenance: proposal.provenance, origin: 'auto', proposedBy: SYSTEM_ACTOR,
    baseVersion: null, migrated: opts.migrated,
  }, opts.now);
}

/**
 * Boot migration: give every project that has no standards file an automatic
 * proposal, marked `migrated` so an admin may accept the defaults instead of
 * waiting for a review. Run once at boot, before the server listens, so nothing
 * else is touching the store. A project that already has a file is skipped, so
 * a second boot proposes nothing.
 *
 * Never throws: a project whose proposal cannot be written is logged and left
 * for the next boot. Returns the ids of the projects proposed for.
 */
export async function migrateStandards(
  projects: { list(): StandardsProjectRef[] },
  store: StandardsStore,
  audit: { append(input: AuditInput): unknown },
  log: (message: string) => void,
  opts: { now?: Date; detect?: (cwd: string) => ConventionDetection | Promise<ConventionDetection> } = {},
): Promise<string[]> {
  const proposed: string[] = [];
  let all: StandardsProjectRef[];
  try { all = projects.list(); } catch (err) {
    log(`standards migration: projects could not be listed: ${(err as Error).message}`);
    return proposed;
  }
  for (const project of all) {
    try {
      const record = await proposeAutomatic(store, project, { migrated: true, now: opts.now, detect: opts.detect });
      if (!record) { continue; }
      proposed.push(project.id);
      // Nothing is in effect yet, so the proposal is measured against the empty baseline: every
      // command, promotion and required directory it brings is on record from the first version on.
      const change = standardsChangeAudit(store, project.id, record);
      audit.append({
        actorUserId: SYSTEM_ACTOR, actorUsername: SYSTEM_ACTOR, action: 'standards.propose', projectId: project.id,
        target: `standards v${record.version}`,
        after: {
          version: record.version, contentHash: record.contentHash, origin: record.origin, ...change.after,
        },
        flags: ['auto-proposed', 'migration', ...change.flags],
      });
    } catch (err) {
      log(`standards migration ${project.id}: ${(err as Error).message}`);
    }
  }
  return proposed;
}

/**
 * Refuse to put `v` into effect when it changes enforcement and the caller did not
 * acknowledge exactly this content. Throws `acknowledgement-required` with the fields that
 * differ; returns normally when nothing differs or the acknowledgement matches.
 */
function requireAcknowledgement(
  versions: readonly StandardsVersionRecord[], v: StandardsVersionRecord, acknowledged: string | undefined,
): void {
  const review = enforcementReview(versions, v);
  const design = designReview(versions, v);
  if ((!review.changed && !design.changed) || acknowledged === v.contentHash) { return; }
  const fields: string[] = [...review.fields, ...(design.changed ? ['design'] : [])];
  const message = review.changed
    ? `Standards v${v.version} changes what can stop a release (${review.fields.join(', ')}${design.changed ? ', and the design system' : ''}). `
    : `Standards v${v.version} changes the design system. `;
  throw new StandardsStoreError('acknowledgement-required',
    message + 'Review the changes and confirm you have seen them before approving.',
    { fields, comparedTo: review.comparedTo });
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** Freeze `v` and everything it holds, so a shared copy cannot be changed by whoever reads it. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) { deepFreeze(child); }
  }
  return v;
}

/** What `load` returns: shared with every other reader, so read-only all the way down. */
export interface StandardsHistory {
  readonly migrated: boolean;
  readonly versions: readonly StandardsVersionRecord[];
}

/** One project's parsed file, and what the file looked like on disk when it was parsed. */
interface CachedHistory {
  stamp: string;
  history: StandardsHistory;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** File-backed standards versions for every project, one file per project directory. */
export class StandardsStore {
  private readonly cache = new Map<string, CachedHistory>();
  /** How many times a standards file was read and parsed; a poll that hits the cache adds nothing. */
  private parses = 0;

  constructor(private readonly dataDir: string) {}

  /** Files read and parsed so far. For tests and diagnostics: a cached read does not count. */
  get parseCount(): number { return this.parses; }

  filePath(projectId: string): string {
    return path.join(this.dataDir, 'projects', projectId, STANDARDS_FILE);
  }

  /** True once the project has a standards file (even an empty one). */
  exists(projectId: string): boolean {
    try { return fs.statSync(this.filePath(projectId)).isFile(); } catch { return false; }
  }

  /**
   * Every version, oldest first, plus the migration flag. A missing file is an
   * empty history; a file this build cannot read THROWS, so a damaged store can
   * never be mistaken for "nothing approved yet, propose again".
   *
   * The result is the cached history itself — shared and frozen, not a copy. Read
   * it; use {@link get}, {@link effective} or {@link pending} for a record to keep or change.
   */
  load(projectId: string): StandardsHistory {
    return this.history(projectId);
  }

  /** The version in effect: the latest approved one, or null. */
  effective(projectId: string): StandardsVersionRecord | null {
    const approved = this.history(projectId).versions.filter((v) => v.status === 'approved');
    return approved.length > 0 ? clone(approved[approved.length - 1]) : null;
  }

  /** The version awaiting review, or null. At most one exists. */
  pending(projectId: string): StandardsVersionRecord | null {
    const found = this.history(projectId).versions.find((v) => v.status === 'pending');
    return found ? clone(found) : null;
  }

  /** One version by number, or null. */
  get(projectId: string, version: number): StandardsVersionRecord | null {
    const found = this.history(projectId).versions.find((v) => v.version === version);
    return found ? clone(found) : null;
  }

  /**
   * Add version N+1 as `pending`. Any version still pending becomes
   * `superseded`; approved versions are untouched, so the version in effect
   * does not change. Refused when the profile is invalid, when `baseVersion` is
   * not the latest version (someone proposed in between), or at the version cap.
   */
  propose(projectId: string, input: ProposeInput, now: Date = new Date()): StandardsVersionRecord {
    const profile = validateProfile(input.profile);
    if (!profile.ok) {
      throw new StandardsStoreError('invalid-standards', 'The proposed standards are not valid.', { errors: profile.errors });
    }
    const provenance = validateProvenance(input.provenance);
    if (!provenance.ok) {
      throw new StandardsStoreError('invalid-standards', 'The proposed standards have invalid provenance.', { errors: provenance.errors });
    }
    const file = this.read(projectId);
    const latest = file.versions.length > 0 ? file.versions[file.versions.length - 1].version : null;
    if (input.baseVersion !== latest) {
      throw new StandardsStoreError('stale', 'A newer version was proposed in the meantime. Review it, then submit again.', { latestVersion: latest });
    }
    if (file.versions.length >= MAX_STANDARDS_VERSIONS) {
      throw new StandardsStoreError('too-many-versions', `This project already has ${MAX_STANDARDS_VERSIONS} standards versions.`);
    }
    for (const v of file.versions) {
      if (v.status === 'pending') { v.status = 'superseded'; }
    }
    const record: StandardsVersionRecord = {
      version: (latest ?? 0) + 1,
      status: 'pending',
      origin: input.origin,
      profile: profile.profile,
      provenance: provenance.provenance,
      contentHash: profileHash(profile.profile),
      baseVersion: latest,
      proposedBy: input.proposedBy,
      proposedAt: now.toISOString(),
    };
    if (latest === null && input.migrated === true) { file.migrated = true; }
    file.versions.push(record);
    this.write(projectId, file);
    return clone(record);
  }

  /**
   * Approve the pending `version`. The caller echoes the hash of what they reviewed.
   *
   * A version that changes enforcement ({@link enforcementReview}) is approved only with an
   * acknowledgement: `acknowledgedEnforcementHash` must be the content hash of this very
   * version, which says the reviewer was shown its enforcement diff and ticked it. Without
   * one the approval is refused (`acknowledgement-required`) and nothing is written.
   */
  approve(
    projectId: string, version: number,
    input: { contentHash: string; by: string; acknowledgedEnforcementHash?: string }, now: Date = new Date(),
  ): StandardsVersionRecord {
    return this.decide(projectId, version, input.contentHash, input.acknowledgedEnforcementHash, (v) => {
      v.status = 'approved';
      v.decision = 'approved';
      v.decidedBy = input.by;
      v.decidedAt = now.toISOString();
    });
  }

  /** Reject the pending `version` with a reason. The version in effect is unchanged. */
  reject(projectId: string, version: number, input: { reason: string; by: string }, now: Date = new Date()): StandardsVersionRecord {
    return this.decide(projectId, version, null, null, (v) => {
      v.status = 'rejected';
      v.reason = input.reason;
      v.decidedBy = input.by;
      v.decidedAt = now.toISOString();
    });
  }

  /**
   * Put the auto-proposed defaults into effect without a review. Only for a
   * project that predates standards, and only while its pending version is
   * still the server's own untouched proposal. Like {@link approve}, it needs the
   * acknowledgement when the proposal changes enforcement.
   */
  acceptDefaults(
    projectId: string, input: { contentHash: string; by: string; acknowledgedEnforcementHash?: string }, now: Date = new Date(),
  ): StandardsVersionRecord {
    const file = this.read(projectId);
    const pending = file.versions.find((v) => v.status === 'pending');
    if (!file.migrated || !pending || pending.origin !== 'auto') {
      throw new StandardsStoreError('not-acceptable',
        'Defaults can only be accepted for a project that predates standards, while its automatic proposal is still pending.');
    }
    if (pending.contentHash !== input.contentHash) {
      throw new StandardsStoreError('hash-mismatch', 'These standards changed after you opened them. Review the current version.');
    }
    requireAcknowledgement(file.versions, pending, input.acknowledgedEnforcementHash);
    pending.status = 'approved';
    pending.decision = 'accepted-defaults';
    pending.decidedBy = input.by;
    pending.decidedAt = now.toISOString();
    this.write(projectId, file);
    return clone(pending);
  }

  // ─── Internals ───

  /** `acknowledged` null: the decision puts nothing into effect (a rejection), so none is asked for. */
  private decide(
    projectId: string, version: number, contentHash: string | null, acknowledged: string | undefined | null,
    apply: (v: StandardsVersionRecord) => void,
  ): StandardsVersionRecord {
    const file = this.read(projectId);
    const target = file.versions.find((v) => v.version === version);
    if (!target) { throw new StandardsStoreError('not-found', 'Standards version not found.'); }
    if (target.status !== 'pending') {
      throw new StandardsStoreError('already-decided', `Standards v${target.version} is ${target.status}.`,
        { status: target.status, decidedBy: target.decidedBy ?? null, decidedAt: target.decidedAt ?? null });
    }
    if (contentHash !== null && contentHash !== target.contentHash) {
      throw new StandardsStoreError('hash-mismatch', 'These standards changed after you opened them. Review the current version.');
    }
    if (acknowledged !== null) { requireAcknowledgement(file.versions, target, acknowledged); }
    apply(target);
    this.write(projectId, file);
    return clone(target);
  }

  /** What identifies the file as it stands on disk, or null when there is none. */
  private stamp(projectId: string): string | null {
    try {
      const st = fs.statSync(this.filePath(projectId));
      return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    } catch {
      return null;
    }
  }

  /**
   * The project's history, from the cache while the file on disk is still the one that
   * was parsed. One `stat` per call; a parse only when the file changed. A file that
   * cannot be read throws and is never cached.
   */
  private history(projectId: string): StandardsHistory {
    const stamp = this.stamp(projectId);
    const hit = this.cache.get(projectId);
    if (stamp !== null && hit && hit.stamp === stamp) { return hit.history; }
    this.cache.delete(projectId);
    const file = this.parse(projectId);
    const history = deepFreeze<StandardsHistory>({ migrated: file.migrated, versions: file.versions });
    // A file that vanished between the stat and the read is simply not cached.
    if (stamp !== null && this.stamp(projectId) === stamp) { this.cache.set(projectId, { stamp, history }); }
    return history;
  }

  /** A private, mutable copy of the file for a method that is about to change and rewrite it. */
  private read(projectId: string): StandardsFile {
    const history = this.history(projectId);
    return { schemaVersion: 1, migrated: history.migrated, versions: clone(history.versions) as StandardsVersionRecord[] };
  }

  private parse(projectId: string): StandardsFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath(projectId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return { schemaVersion: 1, migrated: false, versions: [] }; }
      throw new Error(`${STANDARDS_FILE} for project ${projectId} could not be read: ${(err as Error).message}`);
    }
    this.parses++;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error(`${STANDARDS_FILE} for project ${projectId} is not valid JSON.`);
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.versions)) {
      throw new Error(`${STANDARDS_FILE} for project ${projectId} has an unsupported format (expected schemaVersion 1).`);
    }
    const versions = parsed.versions as StandardsVersionRecord[];
    for (const v of versions) {
      if (!isRecord(v) || typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version < 1
        || !(STANDARDS_VERSION_STATUSES as readonly string[]).includes(String(v.status))
        || !(STANDARDS_ORIGINS as readonly string[]).includes(String(v.origin))
        || !isRecord(v.profile) || typeof v.contentHash !== 'string') {
        throw new Error(`${STANDARDS_FILE} for project ${projectId} holds a malformed version record.`);
      }
    }
    return { schemaVersion: 1, migrated: parsed.migrated === true, versions };
  }

  private write(projectId: string, file: StandardsFile): void {
    // Dropped first: if the write fails half-way, the next read goes to the disk.
    this.cache.delete(projectId);
    writeFileAtomicSync(this.filePath(projectId), JSON.stringify(file, null, 2), 0o600);
    const stamp = this.stamp(projectId);
    if (stamp !== null) {
      this.cache.set(projectId, { stamp, history: deepFreeze<StandardsHistory>({ migrated: file.migrated, versions: clone(file.versions) }) });
    }
  }
}
