// ─── The base a local standards check diffs against ───
//
//   <cwd>/.moag/standards-base.json   the commit the workspace stood at when the first
//                                     run since the last passed verification started
//
// HEAD at verification time is the wrong base. A run that commits its work — the runner's
// own `git.autoCommit`, or an agent that commits — moves HEAD past that work, and a diff
// taken from the new HEAD shows nothing: the work would never be checked. So the base is
// captured when a run STARTS, before any task has touched the tree, and kept until a
// verification passes. Fix iterations run in between do not move it, so everything not
// yet verified stays inside the diff.
//
// Local only. The hosted server keeps its own base on the run record and never reads or
// writes this file; the workspace is the user's own, so the file is trusted like
// `.moag/standards.json` beside it.
//
// Free of VS Code API imports: the extension and the headless CLI both load it.

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';
import { localStandardsPath } from '../standards/local-store';
import { captureHeadRef } from './evidence';

/** What the base file holds. `ref` null means "no commit existed": every file counts as added. */
export interface StandardsBase {
  ref: string | null;
  capturedAt: string;
}

/** Reads the commit a workspace stands at; `captureHeadRef` unless a caller brings its own. */
export type HeadReader = (cwd: string) => Promise<string | null>;

const MAX_BASE_FILE_BYTES = 4 * 1024;
const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/** Where a workspace keeps its captured standards base. */
export function standardsBasePath(cwd: string): string {
  return path.join(cwd, '.moag', 'standards-base.json');
}

/**
 * The captured base, or null when there is none — the file is absent, unreadable or not
 * in the shape this module writes. A damaged file is the same as no file: the caller
 * falls back to HEAD, which is what every check used before a base was ever captured.
 */
export function readStandardsBase(cwd: string): StandardsBase | null {
  try {
    const file = standardsBasePath(cwd);
    if (fs.statSync(file).size > MAX_BASE_FILE_BYTES) { return null; }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return null; }
    const obj = parsed as Record<string, unknown>;
    if (obj.schemaVersion !== 1) { return null; }
    if (obj.ref !== null && !(typeof obj.ref === 'string' && COMMIT_ID.test(obj.ref))) { return null; }
    return { ref: obj.ref, capturedAt: typeof obj.capturedAt === 'string' ? obj.capturedAt : '' };
  } catch {
    return null;
  }
}

/**
 * Capture the base for a run that is about to start: HEAD as it stands now.
 *
 * A no-op when a base is already captured (an earlier run has not been verified yet, and
 * its work must stay in the diff) and when the workspace has no standards file (nothing
 * would ever read the base). Never throws — a run is not failed over bookkeeping.
 */
export async function rememberStandardsBase(cwd: string, now: Date = new Date(), headRef: HeadReader = captureHeadRef): Promise<void> {
  try {
    if (!fs.existsSync(localStandardsPath(cwd)) || readStandardsBase(cwd) !== null) { return; }
    const head = await headRef(cwd);
    // An empty answer is not a commit id: treat it like "no commits yet".
    const ref = head && COMMIT_ID.test(head) ? head : null;
    writeFileAtomicSync(standardsBasePath(cwd), JSON.stringify({ schemaVersion: 1, ref, capturedAt: now.toISOString() }, null, 2) + '\n', 0o644);
  } catch {
    // Best effort: without a captured base the check falls back to HEAD.
  }
}

/** Forget the captured base: the work since it was verified. The next run captures a new one. Never throws. */
export function clearStandardsBase(cwd: string): void {
  try {
    fs.unlinkSync(standardsBasePath(cwd));
  } catch {
    // Already gone, or never captured.
  }
}

/**
 * The ref a local standards check diffs against: `explicit` (`--base`) when given, else
 * the base captured at run start, else HEAD as it stands. Null means "no commits": every
 * file is then judged as added.
 */
export async function resolveStandardsBase(cwd: string, explicit?: string, headRef: HeadReader = captureHeadRef): Promise<string | null> {
  if (explicit !== undefined) { return explicit; }
  const captured = readStandardsBase(cwd);
  if (captured) { return captured.ref; }
  return headRef(cwd);
}
