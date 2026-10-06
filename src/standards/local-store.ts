// ─── Standards on disk: the local workspace file and the server job file ───
//
// Two readers, one rule: a file that exists but is wrong is an ERROR that names
// the file, never a silent "no standards". Dropping standards quietly would let
// a run proceed unchecked while everyone believes it was checked.
//
// `<cwd>/.moag/standards.json` is trusted because the workspace is the user's
// own (VS Code and the headless CLI). The hosted server never reads it: its
// worker is handed a server-written job file instead.

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';
import {
  MAX_STANDARDS_PLANNER_CHARS,
  MAX_STANDARDS_PROMPT_CHARS,
  StandardsDocument,
  StandardsProfile,
  profileHash,
  renderPlannerStandards,
  renderStandardsText,
  validateProfile,
  validateProvenance,
} from './profile';

/** Largest standards file read. A valid one is far smaller; anything bigger is not ours. */
const MAX_STANDARDS_FILE_BYTES = 1024 * 1024;
/** The same limit `validateProfile` holds a profile's rendered planner text to. */
const MAX_PLANNER_TEXT_CHARS = MAX_STANDARDS_PLANNER_CHARS;
const MAX_ERRORS_SHOWN = 5;

/** What the server writes beside a job for its worker: the approved version, frozen. */
export interface StandardsJobFile {
  schemaVersion: 1;
  version: number;
  /**
   * sha256 of `profile`, re-derived on read. That catches a damaged or half-edited file
   * only: whoever can write the file can update the hash with it. What binds a hosted
   * run to its approved standards is the server, which compares the hash and base ref
   * the worker reports with the ones it froze on the run record.
   */
  contentHash: string;
  /** The ref the standards gate diffs against; null means "no commits yet". */
  baseRef: string | null;
  profile: StandardsProfile;
  /** The text every task prompt carries, rendered by the server. */
  promptText: string;
  /** The text the planning prompt carries, rendered by the server. */
  plannerText: string;
}

/** Where a workspace keeps its standards. */
export function localStandardsPath(cwd: string): string {
  return path.join(cwd, '.moag', 'standards.json');
}

function describe(errors: string[]): string {
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).join('; ');
  return errors.length > MAX_ERRORS_SHOWN ? `${shown}; and ${errors.length - MAX_ERRORS_SHOWN} more` : shown;
}

/** Read and parse a JSON object, or throw an error that names `label`. Null when the file is absent. */
function readJsonObject(filePath: string, label: string): Record<string, unknown> | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
    throw new Error(`Cannot read "${label}" — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isFile()) {
    throw new Error(`"${label}" is not a file.`);
  }
  if (stat.size > MAX_STANDARDS_FILE_BYTES) {
    throw new Error(`"${label}" is ${stat.size} bytes; a standards file is at most ${MAX_STANDARDS_FILE_BYTES}.`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read "${label}" — ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`"${label}" contains invalid JSON. Check for syntax errors (missing commas, trailing commas, etc).`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`"${label}" is not a valid standards file — expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requireKeys(obj: Record<string, unknown>, keys: string[], label: string): void {
  const unknown = Object.keys(obj).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    throw new Error(`"${label}" has unknown key${unknown.length === 1 ? '' : 's'}: ${unknown.slice(0, 5).map((k) => k.slice(0, 40)).join(', ')}.`);
  }
  if (obj.schemaVersion !== 1) {
    throw new Error(`"${label}" has unsupported schemaVersion ${JSON.stringify(obj.schemaVersion) ?? 'undefined'}; this build reads schemaVersion 1.`);
  }
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error(`"${label}" needs "version" to be a whole number of at least 1.`);
  }
}

/** Validate an in-memory document, or throw an error that names `label`. */
function parseDocument(obj: Record<string, unknown>, label: string): StandardsDocument {
  requireKeys(obj, ['schemaVersion', 'version', 'profile', 'provenance'], label);
  const profile = validateProfile(obj.profile);
  if (!profile.ok) {
    throw new Error(`"${label}" is not a valid standards profile: ${describe(profile.errors)}`);
  }
  const provenance = validateProvenance(obj.provenance);
  if (!provenance.ok) {
    throw new Error(`"${label}" has invalid provenance: ${describe(provenance.errors)}`);
  }
  return { schemaVersion: 1, version: obj.version as number, profile: profile.profile, provenance: provenance.provenance };
}

/**
 * Load `<cwd>/.moag/standards.json`.
 *
 * A missing file returns null — the workspace simply has no standards. A file
 * that is unreadable, malformed or invalid throws a user-facing error naming
 * the file, the same contract as `loadPlan`.
 */
export function loadLocalStandards(cwd: string): StandardsDocument | null {
  const label = '.moag/standards.json';
  const obj = readJsonObject(localStandardsPath(cwd), label);
  return obj === null ? null : parseDocument(obj, label);
}

/**
 * Write `<cwd>/.moag/standards.json` atomically. The document is validated
 * first, so this can never leave behind a file `loadLocalStandards` would refuse.
 */
export function writeLocalStandards(cwd: string, doc: StandardsDocument): void {
  const checked = parseDocument(doc as unknown as Record<string, unknown>, '.moag/standards.json');
  writeFileAtomicSync(localStandardsPath(cwd), JSON.stringify(checked, null, 2) + '\n', 0o644);
}

/**
 * The standards block for task prompts, read from one workspace's standards file.
 *
 * The file is looked up under `workspaceRoot`, not under the task's own cwd: a task may
 * run in a subdirectory or a worktree, and the standards belong to the workspace. The
 * parsed document is cached by the file's mtime and size, so a run of many tasks — or
 * several playlists in parallel — reads and validates it once and each sees the same text.
 *
 * Returns null when the workspace has no standards file. THROWS the file-naming error
 * when the file is invalid; the runner turns that into a failed task, never a silent skip.
 */
export function createLocalStandardsProvider(
  workspaceRoot: string | (() => string | undefined),
): (taskCwd: string, opts?: { skipRuleNames?: string[] }) => { text: string; version: number } | null {
  let cached: { root: string; mtimeMs: number; size: number; doc: StandardsDocument } | null = null;
  return (taskCwd, opts) => {
    const root = (typeof workspaceRoot === 'function' ? workspaceRoot() : workspaceRoot) ?? taskCwd;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(localStandardsPath(root));
    } catch {
      stat = null;
    }
    let doc: StandardsDocument | null;
    if (stat && cached && cached.root === root && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      doc = cached.doc;
    } else {
      cached = null;
      doc = loadLocalStandards(root);
      if (doc && stat) { cached = { root, mtimeMs: stat.mtimeMs, size: stat.size, doc }; }
    }
    if (!doc) { return null; }
    return { text: renderStandardsText(doc.profile, doc.version, { skipRuleNames: opts?.skipRuleNames }), version: doc.version };
  };
}

/**
 * The standards text a planning prompt carries for this workspace, or undefined when it
 * has no standards file. Throws the file-naming error when the file is invalid.
 */
export function loadLocalPlannerText(cwd: string): string | undefined {
  const doc = loadLocalStandards(cwd);
  return doc ? renderPlannerStandards(doc.profile, doc.version) : undefined;
}

/**
 * Read the standards job file a server wrote for its worker.
 *
 * Unlike the workspace file, a MISSING job file is an error: the worker was
 * told there were standards. The content hash is re-derived from the profile,
 * so a file that no longer agrees with itself is refused. This is an integrity
 * check, not a tamper check: the file sits in the run directory, which the agent
 * can write, and a rewrite that updates the hash too reads as valid here. The
 * server detects that case (see `standardsCheckProblem` in server/app.ts).
 */
export function readStandardsJobFile(filePath: string): StandardsJobFile {
  const label = path.basename(filePath);
  const obj = readJsonObject(filePath, label);
  if (obj === null) {
    throw new Error(`Cannot read "${label}" — file not found or not accessible.`);
  }
  requireKeys(obj, ['schemaVersion', 'version', 'contentHash', 'baseRef', 'profile', 'promptText', 'plannerText'], label);
  const profile = validateProfile(obj.profile);
  if (!profile.ok) {
    throw new Error(`"${label}" is not a valid standards profile: ${describe(profile.errors)}`);
  }
  if (typeof obj.contentHash !== 'string' || obj.contentHash !== profileHash(profile.profile)) {
    throw new Error(`"${label}" does not match its content hash; refusing to use it.`);
  }
  if (obj.baseRef !== null && (typeof obj.baseRef !== 'string' || !/^[0-9a-f]{7,64}$/.test(obj.baseRef))) {
    throw new Error(`"${label}" needs "baseRef" to be a commit id or null.`);
  }
  if (typeof obj.promptText !== 'string' || obj.promptText.length > MAX_STANDARDS_PROMPT_CHARS) {
    throw new Error(`"${label}" needs "promptText" to be text of at most ${MAX_STANDARDS_PROMPT_CHARS} characters.`);
  }
  if (typeof obj.plannerText !== 'string' || obj.plannerText.length > MAX_PLANNER_TEXT_CHARS) {
    throw new Error(`"${label}" needs "plannerText" to be text of at most ${MAX_PLANNER_TEXT_CHARS} characters.`);
  }
  return {
    schemaVersion: 1,
    version: obj.version as number,
    contentHash: obj.contentHash,
    baseRef: obj.baseRef,
    profile: profile.profile,
    promptText: obj.promptText,
    plannerText: obj.plannerText,
  };
}
