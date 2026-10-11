// ─── Task changes — what one task did to the repository ───
//
// Builds the payload of the `task-changes` headless line (and of the matching
// ONOSOO relay event): the files a task touched, their line counts, and a
// redacted, size-capped unified diff.
//
// Two sources:
//   - "commit"   — git delivery committed the task: base_sha..commit_sha.
//   - "worktree" — anything else that settled Completed/Failed: the working tree
//                  against the snapshot captured when the task started (the
//                  `git stash create` ref, falling back to HEAD), plus untracked
//                  files that did not exist at task start.
//
// Dependency-injected and free of `vscode`, like evidence.ts. The runner imports
// only the TYPES from here; the headless CLI owns the hook that calls
// collectTaskChanges().

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TaskStatus } from '../models/types';
import type { Redactor } from '../utils/redact';
import { killProcess } from '../utils/process-kill';
import { EMPTY_TREE_REF } from './evidence';

// ─── Contract ───

/** Facts the runner hands its task-settled hook. */
export interface TaskSettledInfo {
  taskId: string;
  status: TaskStatus;
  cwd: string;
  /** The `git stash create` ref (or HEAD) captured at task start; null when none. */
  snapshotRef: string | null;
  /** HEAD at task start; null for a repository with no commits (or no git). */
  headRef: string | null;
  /** Untracked files at task start (cwd-relative); null when not captured. */
  untrackedAtStart: string[] | null;
  /** Set when git delivery committed this task. `sha` is the full 40-hex sha. */
  commit: { sha: string; branch: string } | null;
}

/** Called by the runner just before task-completed/task-failed; bounded and aborted on timeout. */
export type TaskSettledHook = (info: TaskSettledInfo, signal: AbortSignal) => Promise<void> | void;

export type TaskChangeFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TaskChangeFile {
  path: string;
  status: TaskChangeFileStatus;
  old_path?: string;
  binary: boolean;
  added: number | null;
  removed: number | null;
}

export interface TaskChangeDiff {
  text: string;
  truncated: boolean;
  /** UTF-8 size of the untruncated, unredacted diff (a lower bound when git output overflowed). */
  bytes: number;
  redactions: number;
}

/** The `task-changes` line minus its `event` field. */
export interface TaskChangesPayload {
  task_id: string;
  status: 'completed' | 'failed';
  source: 'commit' | 'worktree';
  base_sha: string;
  commit_sha: string | null;
  branch: string | null;
  files: TaskChangeFile[];
  diff: TaskChangeDiff | null;
  diff_error?: string;
}

export const TASK_CHANGES_LIMITS = Object.freeze({
  maxDiffBytes: 65_536,
  maxFiles: 500,
  // Under ONOSOO's 96 KB per-event data cap, so the relay never has to drop a task-changes event.
  maxEventJsonBytes: 90_000,
  maxGitStdoutBytes: 16 * 1024 * 1024,
  maxUntrackedReadBytes: 1024 * 1024,
  untrackedReadBudget: 32 * 1024 * 1024,
});

const GIT_TIMEOUT_MS = 30_000;
const BINARY_SNIFF_BYTES = 8000;
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--relative', '-M', '-l20000'];
const PATHSPEC = ['--', '.', ':(exclude).moag'];

// ─── Git ───

export interface TaskGitResult {
  stdout: string;
  /** True when stdout hit {@link TASK_CHANGES_LIMITS.maxGitStdoutBytes} and was cut. */
  overflow: boolean;
}

/** Runs a git subcommand; resolves null on non-zero exit, spawn error, timeout or abort. */
export type TaskGit = (args: string[], cwd: string, signal: AbortSignal) => Promise<TaskGitResult | null>;

/** Default {@link TaskGit}: spawns git with optional locks off, buffered and bounded. */
export function runTaskGit(args: string[], cwd: string, signal: AbortSignal): Promise<TaskGitResult | null> {
  if (signal.aborted) { return Promise.resolve(null); }
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn('git', ['--no-pager', ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let settled = false;

    const onAbort = (): void => {
      killProcess(proc);
      finish(null);
    };
    const timer = setTimeout(() => {
      killProcess(proc);
      finish(null);
    }, GIT_TIMEOUT_MS);
    timer.unref?.();

    function finish(value: TaskGitResult | null): void {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }

    signal.addEventListener('abort', onAbort);
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) { return; }
      const room = TASK_CHANGES_LIMITS.maxGitStdoutBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        overflow = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    proc.stderr?.on('data', () => { /* drained, not kept */ });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => {
      finish(code === 0 || (overflow && code !== null) ? { stdout: Buffer.concat(chunks).toString('utf-8'), overflow } : null);
    });
  });
}

// ─── Pure helpers ───

/** One entry of `git diff --name-status -z`. */
export interface NameStatusEntry {
  status: TaskChangeFileStatus;
  path: string;
  old_path?: string;
}

/** Parse `git diff --name-status -z` output. */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const tokens = out.split('\0');
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) { i++; continue; }
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 3;
      if (!newPath) { continue; }
      entries.push(letter === 'R'
        ? { status: 'renamed', path: newPath, old_path: oldPath }
        : { status: 'added', path: newPath });
      continue;
    }
    const p = tokens[i + 1];
    i += 2;
    if (!p) { continue; }
    const status: TaskChangeFileStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    entries.push({ status, path: p });
  }
  return entries;
}

/** One entry of `git diff --numstat -z`. */
export interface NumstatEntry {
  path: string;
  old_path?: string;
  binary: boolean;
  added: number | null;
  removed: number | null;
}

/** Parse `git diff --numstat -z` output (renames are `A\tR\t\0old\0new\0`). */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split('\0');
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (!head) { i++; continue; }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) { i++; continue; }
    const binary = m[1] === '-' && m[2] === '-';
    const added = binary ? null : Number(m[1]);
    const removed = binary ? null : Number(m[2]);
    if (m[3] === '') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 3;
      if (!newPath) { continue; }
      entries.push({ path: newPath, old_path: oldPath, binary, added, removed });
      continue;
    }
    i++;
    entries.push({ path: m[3], binary, added, removed });
  }
  return entries;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) { return text; }
  let end = Math.max(0, Math.floor(maxBytes));
  // Back off over continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) { end--; }
  return buf.subarray(0, end).toString('utf-8');
}

/**
 * Shrink `payload` until its JSON line fits {@link TASK_CHANGES_LIMITS.maxEventJsonBytes}:
 * halve diff.text first, then drop files from the end. Marks diff.truncated when it cut
 * anything and a diff is present. Never adds a top-level `truncated`.
 */
export function fitEventSize(payload: TaskChangesPayload): TaskChangesPayload {
  const max = TASK_CHANGES_LIMITS.maxEventJsonBytes;
  const size = (p: TaskChangesPayload): number => Buffer.byteLength(JSON.stringify({ event: 'task-changes', ...p }), 'utf-8');
  if (size(payload) <= max) { return payload; }
  const out: TaskChangesPayload = { ...payload, files: [...payload.files], diff: payload.diff ? { ...payload.diff } : null };
  if (out.diff) { out.diff.truncated = true; }
  while (out.diff && out.diff.text.length > 0 && size(out) > max) {
    out.diff.text = truncateUtf8(out.diff.text, Math.floor(Buffer.byteLength(out.diff.text, 'utf-8') / 2));
  }
  while (out.files.length > 0 && size(out) > max) {
    out.files.pop();
  }
  return out;
}

// ─── Untracked files ───

interface UntrackedFile {
  file: TaskChangeFile;
  diff: string;
}

function synthesizeUntracked(cwd: string, rel: string, budget: { left: number }): UntrackedFile {
  const nullFile: UntrackedFile = {
    file: { path: rel, status: 'added', binary: false, added: null, removed: null },
    diff: '',
  };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.join(cwd, rel));
  } catch {
    return nullFile;
  }
  if (!stat.isFile() || stat.size > TASK_CHANGES_LIMITS.maxUntrackedReadBytes || stat.size > budget.left) {
    return nullFile;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(cwd, rel));
  } catch {
    return nullFile;
  }
  budget.left -= buf.length;
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return {
      file: { path: rel, status: 'added', binary: true, added: null, removed: null },
      diff: `${header}Binary files /dev/null and b/${rel} differ\n`,
    };
  }
  const content = buf.toString('utf-8');
  if (content.length === 0) {
    return { file: { path: rel, status: 'added', binary: false, added: 0, removed: 0 }, diff: header };
  }
  const endsWithNewline = content.endsWith('\n');
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split('\n');
  const body = lines.map((l) => `+${l}`).join('\n') + '\n' + (endsWithNewline ? '' : '\\ No newline at end of file\n');
  return {
    file: { path: rel, status: 'added', binary: false, added: lines.length, removed: 0 },
    diff: `${header}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
  };
}

// ─── Collector ───

/**
 * Collect the changes one settled task made. Resolves null when `cwd` is not a
 * git work tree or `signal` is aborted; never throws for git trouble.
 */
export async function collectTaskChanges(
  info: TaskSettledInfo,
  redactor: Redactor,
  signal: AbortSignal,
  git: TaskGit = runTaskGit,
): Promise<TaskChangesPayload | null> {
  if (signal.aborted) { return null; }
  // TaskStatus is imported type-only, so compare its string value.
  const raw = String(info.status);
  const status: 'completed' | 'failed' | null = raw === 'completed' ? 'completed' : raw === 'failed' ? 'failed' : null;
  if (status === null) { return null; }

  const inside = await git(['rev-parse', '--is-inside-work-tree'], info.cwd, signal);
  if (!inside || inside.stdout.trim() !== 'true') { return null; }

  const baseSha = info.headRef ?? EMPTY_TREE_REF;
  let source: 'commit' | 'worktree';
  let range: string[];
  let commitSha: string | null;
  let branch: string | null;
  if (info.commit) {
    source = 'commit';
    range = [baseSha, info.commit.sha];
    commitSha = info.commit.sha;
    branch = info.commit.branch;
  } else {
    source = 'worktree';
    range = [info.snapshotRef ?? info.headRef ?? EMPTY_TREE_REF];
    commitSha = null;
    const abbrev = await git(['rev-parse', '--abbrev-ref', 'HEAD'], info.cwd, signal);
    const name = abbrev ? abbrev.stdout.trim() : '';
    branch = name && name !== 'HEAD' ? name : null;
  }

  const nameStatus = await git(['diff', ...DIFF_FLAGS, '--name-status', '-z', ...range, ...PATHSPEC], info.cwd, signal);
  const numstat = await git(['diff', ...DIFF_FLAGS, '--numstat', '-z', ...range, ...PATHSPEC], info.cwd, signal);
  const plain = await git(['diff', ...DIFF_FLAGS, ...range, ...PATHSPEC], info.cwd, signal);
  let overflow = Boolean(nameStatus?.overflow || numstat?.overflow || plain?.overflow);

  const counts = new Map<string, NumstatEntry>();
  for (const e of parseNumstatZ(numstat?.stdout ?? '')) { counts.set(e.path, e); }

  const byPath = new Map<string, TaskChangeFile>();
  for (const e of parseNameStatusZ(nameStatus?.stdout ?? '')) {
    const n = counts.get(e.path);
    const file: TaskChangeFile = {
      path: e.path,
      status: e.status,
      binary: n?.binary ?? false,
      added: n ? n.added : null,
      removed: n ? n.removed : null,
    };
    if (e.status === 'renamed' && e.old_path !== undefined) { file.old_path = e.old_path; }
    byPath.set(e.path, file);
  }

  let diffText = plain?.stdout ?? '';
  if (source === 'worktree') {
    const others = await git(['ls-files', '--others', '--exclude-standard', '-z', ...PATHSPEC], info.cwd, signal);
    if (others?.overflow) { overflow = true; }
    const before = new Set(info.untrackedAtStart ?? []);
    const budget = { left: TASK_CHANGES_LIMITS.untrackedReadBudget };
    const newOnes = (others?.stdout ?? '').split('\0').filter((p) => p.length > 0 && !before.has(p)).sort();
    for (const rel of newOnes) {
      if (byPath.has(rel)) { continue; }
      const u = synthesizeUntracked(info.cwd, rel, budget);
      byPath.set(rel, u.file);
      diffText += u.diff;
    }
  }

  if (signal.aborted) { return null; }

  const allFiles = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const filesCut = allFiles.length > TASK_CHANGES_LIMITS.maxFiles;
  const files = allFiles.slice(0, TASK_CHANGES_LIMITS.maxFiles);

  const payload: TaskChangesPayload = {
    task_id: info.taskId,
    status,
    source,
    base_sha: baseSha,
    commit_sha: commitSha,
    branch,
    files,
    diff: null,
  };

  const rawBytes = Buffer.byteLength(diffText, 'utf-8');
  let redacted: { text: string; count: number };
  try {
    redacted = redactor.redact(diffText);
  } catch {
    payload.diff_error = 'redaction failed';
    return fitEventSize(payload);
  }
  const text = truncateUtf8(redacted.text, TASK_CHANGES_LIMITS.maxDiffBytes);
  payload.diff = {
    text,
    truncated: filesCut || overflow || text.length !== redacted.text.length,
    bytes: rawBytes,
    redactions: redacted.count,
  };
  return fitEventSize(payload);
}
