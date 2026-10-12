// ─── Changed files at the ship gate ───
//
// What the approver reads before approving a ship: every file the run changed since its
// diff base (the run's `baseRef`), with per-file added/removed line counts. Collected by
// the SERVER, from the workspace, when a run halts at its ship gate — never taken from the
// worker, whose run directory the agent can write.
//
// Git runs here against a workspace an agent has written to, so every call is narrowed: no
// shell, array arguments, fsmonitor and hooks off, no external diff or textconv driver, a
// base that must be a commit id, a timeout and an output cap. What the workspace's own git
// state may hide is listed the way the standards evidence lists it: untracked files honour
// `.gitignore` files only (never `.git/info/exclude` or a global excludes file), and a file
// flagged skip-worktree or assume-unchanged is listed as changed with its counts unknown.
//
// Residual risk, not closed here: `git diff` against the working tree runs any clean or
// process filter driver that `.git/config` defines and `.gitattributes` selects. Both are
// writable by the agent. Agents already run as the server's user, so this is no new
// privilege, but it is code the workspace chooses. The collector never throws: any failure
// is "not collected", never "0 files".

import * as fs from 'fs';
import * as path from 'path';
import { EMPTY_TREE_REF } from '../runner/evidence';
import { parseNameStatusZ, parseNumstatZ } from '../runner/task-changes';
import { execFileAsync } from '../utils/exec-file';
import type { ExecFn } from './projects';

// ─── Constants ───

/** The file in a run's data directory that holds the collected list. */
export const CHANGED_FILES_FILE = 'changed-files.json';
/** Most rows a list carries; `total` still counts every changed file. */
export const CHANGED_FILES_LIMIT = 500;
/** Longest path (or rename source) kept, in characters. */
const MAX_PATH_CHARS = 1_000;
/** Most bytes read of one untracked file to count its lines. */
const MAX_UNTRACKED_READ_BYTES = 1024 * 1024;
/**
 * Most untracked files whose lines are counted, listed or not, so the totals cover more than
 * the listed rows without reading an unbounded tree. Past it a file is counted as "lines not counted".
 */
export const MAX_UNTRACKED_COUNTED = 5_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
/** A base must be a full commit id, exactly as `gitHead` records one. */
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
/** Git options that keep a workspace's own configuration from running anything. */
const HARDENED = [
  '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=',
];
/** MOAG's own folder is never listed. */
const PATHSPEC = ['--', '.', ':(exclude).moag'];

// ─── Types ───

/** One changed file. Counts are null where git (or the read) gives none: binary or unread. */
export interface ChangedFileRow {
  path: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
  untracked: boolean;
  deleted?: true;
  renamedFrom?: string;
  /**
   * The index flags this file skip-worktree or assume-unchanged, so git reports it as
   * unchanged whatever is on disk. Listed as changed; its counts are unknown (null).
   */
  hiddenFromGit?: true;
}

/**
 * Line and file counts over EVERY changed file — not only the listed rows — taken when the
 * list is collected. A row with no counts adds nothing to `added`/`removed` and is counted
 * once: as binary, as hidden from git, or as uncounted (unread, or past the untracked read cap).
 */
export interface ChangedFilesTotals {
  added: number;
  removed: number;
  binary: number;
  hiddenFromGit: number;
  uncounted: number;
}

/** See {@link ChangedFilesDoc.baseKind}. */
export type ChangedFilesBaseKind = 'last-shipped' | 'before-first-ship';
const BASE_KINDS: readonly string[] = ['last-shipped', 'before-first-ship'];

/** A collected list. `files` holds at most {@link CHANGED_FILES_LIMIT} rows, sorted by path. */
export interface ChangedFilesDoc {
  collected: true;
  baseRef: string | null;
  /** True when the run had no base commit: the diff is against the empty tree. */
  emptyTreeBase: boolean;
  total: number;
  /** Over all `total` files. Absent on a list stored before it existed: a reader then sums the rows it has. */
  totals?: ChangedFilesTotals;
  /**
   * What the base is, as the server knew when it collected the list: the ref the project last
   * shipped at, or — nothing shipped yet — the start of its first run. Either way the list may
   * hold the work of earlier runs that were not shipped. Absent when it is neither, or unknown.
   */
  baseKind?: ChangedFilesBaseKind;
  files: ChangedFileRow[];
}

/** Why no list could be taken. */
export interface ChangedFilesNotCollected {
  collected: false;
  reason: string;
}

// ─── Collect ───

/**
 * Every file changed in `workspace` since `baseRef` (the empty tree when null): tracked
 * changes, staged or not, plus untracked files git does not ignore, `.moag/` excluded.
 * Resolves `{ collected: false, reason }` on any failure; never throws.
 */
export async function collectChangedFiles(
  workspace: string, baseRef: string | null, exec: ExecFn = execFileAsync,
): Promise<ChangedFilesDoc | ChangedFilesNotCollected> {
  if (baseRef !== null && !COMMIT_ID.test(baseRef)) {
    return { collected: false, reason: 'the diff base is not a commit id' };
  }
  const base = baseRef ?? EMPTY_TREE_REF;
  const git = async (args: string[]): Promise<string | null> => {
    const r = await exec('git', [...HARDENED, '-C', workspace, ...args], { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
    return r.exitCode === 0 ? r.stdout : null;
  };
  try {
    const numstat = await git(['diff', '--no-ext-diff', '--no-textconv', '-M', '--numstat', '-z', base, ...PATHSPEC]);
    const nameStatus = await git(['diff', '--no-ext-diff', '-M', '--name-status', '-z', base, ...PATHSPEC]);
    // Only `.gitignore` files — in the tree, so an edit to one is itself a listed change —
    // decide what is ignored; `--exclude-standard` would also honour `.git/info/exclude`.
    const untracked = await git(['ls-files', '--others', '--exclude-per-directory=.gitignore', '-z', ...PATHSPEC]);
    const indexFlags = await git(['ls-files', '-v', '-z', ...PATHSPEC]);
    if (numstat === null || nameStatus === null || untracked === null || indexFlags === null) {
      return { collected: false, reason: 'git could not list the changes' };
    }
    const rows = new Map<string, ChangedFileRow>();
    for (const e of parseNumstatZ(numstat)) {
      rows.set(e.path, {
        path: e.path, added: e.added, removed: e.removed, binary: e.binary, untracked: false,
        ...(e.old_path !== undefined ? { renamedFrom: e.old_path } : {}),
      });
    }
    for (const e of parseNameStatusZ(nameStatus)) {
      const row = rows.get(e.path) ?? { path: e.path, added: null, removed: null, binary: false, untracked: false };
      if (e.status === 'deleted') { row.deleted = true; }
      if (e.status === 'renamed' && e.old_path !== undefined) { row.renamedFrom = e.old_path; }
      rows.set(e.path, row);
    }
    const extra = untracked.split('\0').filter((p) => p !== '' && !rows.has(p)).sort();
    extra.forEach((p, i) => {
      rows.set(p, { path: p, ...(i < MAX_UNTRACKED_COUNTED ? countUntracked(workspace, p) : { added: null, binary: false }), removed: null, untracked: true });
    });
    for (const p of hiddenFromGit(workspace, indexFlags)) {
      rows.set(p, { ...(rows.get(p) ?? { path: p, untracked: false }), added: null, removed: null, binary: false, hiddenFromGit: true });
    }
    const all = [...rows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      collected: true,
      baseRef,
      emptyTreeBase: baseRef === null,
      total: all.length,
      totals: totalsOf(all),
      files: all.slice(0, CHANGED_FILES_LIMIT).map(capRow),
    };
  } catch {
    return { collected: false, reason: 'git could not list the changes' };
  }
}

/** The {@link ChangedFilesTotals} of `rows` — all of them, before the list is capped. */
export function totalsOf(rows: readonly ChangedFileRow[]): ChangedFilesTotals {
  const t: ChangedFilesTotals = { added: 0, removed: 0, binary: 0, hiddenFromGit: 0, uncounted: 0 };
  for (const r of rows) {
    t.added += r.added ?? 0;
    t.removed += r.removed ?? 0;
    if (r.hiddenFromGit) { t.hiddenFromGit++; } else if (r.binary) { t.binary++; } else if (r.added === null && r.removed === null) { t.uncounted++; }
  }
  return t;
}

/**
 * The files `git ls-files -v` tags skip-worktree (`S`) or assume-unchanged (a lowercase tag)
 * that are on disk. A flagged path that is not a file on disk (a sparse checkout) hides nothing.
 */
function hiddenFromGit(workspace: string, listing: string): string[] {
  const out: string[] = [];
  for (const entry of listing.split('\0')) {
    const tag = entry.charAt(0);
    const file = entry.slice(2);
    if (file === '' || entry.charAt(1) !== ' ' || !(tag === 'S' || (tag >= 'a' && tag <= 'z'))) { continue; }
    try {
      if (fs.lstatSync(path.join(workspace, ...file.split('/'))).isFile()) { out.push(file); }
    } catch {
      // Not on disk: nothing is hidden.
    }
  }
  return out;
}

/** The line count of an untracked file: null when unread or binary (a NUL byte in what was read). */
function countUntracked(workspace: string, rel: string): { added: number | null; binary: boolean } {
  let fd: number | null = null;
  try {
    const full = path.join(workspace, ...rel.split('/'));
    if (!fs.lstatSync(full).isFile()) { return { added: null, binary: false }; }
    fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(MAX_UNTRACKED_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) { return { added: null, binary: true }; }
    if (n === 0) { return { added: 0, binary: false }; }
    let lines = 0;
    for (const b of bytes) { if (b === 0x0a) { lines++; } }
    if (bytes[n - 1] !== 0x0a) { lines++; }
    return { added: lines, binary: false };
  } catch {
    return { added: null, binary: false };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** A row with its strings cut to {@link MAX_PATH_CHARS}. */
function capRow(row: ChangedFileRow): ChangedFileRow {
  return {
    ...row,
    path: row.path.slice(0, MAX_PATH_CHARS),
    ...(row.renamedFrom !== undefined ? { renamedFrom: row.renamedFrom.slice(0, MAX_PATH_CHARS) } : {}),
  };
}

// ─── Parse ───

/** A count from disk: a whole number of at least 0, or null. Undefined when it is neither. */
function count(raw: unknown): number | null | undefined {
  if (raw === null) { return null; }
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}

/**
 * A stored list, validated: the exact shape {@link collectChangedFiles} writes, strings cut
 * to 1000 characters, at most {@link CHANGED_FILES_LIMIT} rows. Null for anything else.
 */
export function parseChangedFilesDoc(raw: unknown): ChangedFilesDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
  const o = raw as Record<string, unknown>;
  if (o.collected !== true || typeof o.emptyTreeBase !== 'boolean') { return null; }
  if (o.baseRef !== null && (typeof o.baseRef !== 'string' || !COMMIT_ID.test(o.baseRef))) { return null; }
  if (typeof o.total !== 'number' || !Number.isInteger(o.total) || o.total < 0) { return null; }
  if (!Array.isArray(o.files) || o.files.length > CHANGED_FILES_LIMIT || o.files.length > o.total) { return null; }
  let totals: ChangedFilesTotals | undefined;
  if (o.totals !== undefined) {
    if (!o.totals || typeof o.totals !== 'object' || Array.isArray(o.totals)) { return null; }
    const t = o.totals as Record<string, unknown>;
    const n = (k: keyof ChangedFilesTotals): number | null => {
      const v = count(t[k]);
      return typeof v === 'number' ? v : null;
    };
    const [added, removed, binary, hidden, uncounted] = [n('added'), n('removed'), n('binary'), n('hiddenFromGit'), n('uncounted')];
    if (added === null || removed === null || binary === null || hidden === null || uncounted === null
      || binary + hidden + uncounted > o.total) { return null; }
    totals = { added, removed, binary, hiddenFromGit: hidden, uncounted };
  }
  if (o.baseKind !== undefined && !(typeof o.baseKind === 'string' && BASE_KINDS.includes(o.baseKind))) { return null; }
  const files: ChangedFileRow[] = [];
  for (const entry of o.files as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return null; }
    const f = entry as Record<string, unknown>;
    const added = count(f.added);
    const removed = count(f.removed);
    if (typeof f.path !== 'string' || f.path === '' || added === undefined || removed === undefined
      || typeof f.binary !== 'boolean' || typeof f.untracked !== 'boolean'
      || (f.deleted !== undefined && f.deleted !== true)
      || (f.renamedFrom !== undefined && typeof f.renamedFrom !== 'string')
      || (f.hiddenFromGit !== undefined && f.hiddenFromGit !== true)) {
      return null;
    }
    files.push(capRow({
      path: f.path, added, removed, binary: f.binary, untracked: f.untracked,
      ...(f.deleted === true ? { deleted: true as const } : {}),
      ...(typeof f.renamedFrom === 'string' ? { renamedFrom: f.renamedFrom } : {}),
      ...(f.hiddenFromGit === true ? { hiddenFromGit: true as const } : {}),
    }));
  }
  return {
    collected: true, baseRef: o.baseRef as string | null, emptyTreeBase: o.emptyTreeBase, total: o.total,
    ...(totals ? { totals } : {}),
    ...(o.baseKind !== undefined ? { baseKind: o.baseKind as ChangedFilesBaseKind } : {}),
    files,
  };
}
