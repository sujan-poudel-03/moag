// ─── Worktree isolation — make concurrent playlists safe ─────────────────────
//
// `parallelPlaylists > 1` used to run N agents in ONE working directory. Two
// agents editing the same file at 3am produce a tree that compiles, passes
// nothing, and cannot be attributed to either of them. This gives each
// concurrent playlist its own git worktree and its own branch, so their edits
// cannot collide and each one's work stays reviewable on its own.
//
// Dependency-injected and free of `vscode`, like evidence.ts and prd-loop.ts.
//
// Worktrees are created OUTSIDE the repository, under the OS temp directory.
// Putting them in `.moag/` would leave untracked files in a target repo that
// does not ignore `.moag/`, which would then trip the dirty-tree guard in
// git-delivery.ts — the isolation feature would break the delivery feature.

import * as os from 'os';
import * as path from 'path';
import { slugify } from './git-delivery';

/** Runs a git subcommand and resolves stdout, or null when git fails. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export interface Worktree {
  /** Absolute path of the isolated checkout. */
  path: string;
  /** Branch checked out inside it. */
  branch: string;
  /** The playlist this worktree serves. */
  playlistId: string;
}

/** Why isolation could not be established. Closed set — handle every member. */
export type IsolationFailure = 'not-a-repo' | 'unsupported' | 'create-failed' | 'delivery-off';

export type IsolationOutcome =
  | { ok: true; worktrees: Worktree[] }
  | { ok: false; reason: IsolationFailure; detail: string };

/** Where a playlist's isolated checkout lives. */
export function worktreePathFor(repoRoot: string, playlistName: string, runId: string): string {
  const repo = slugify(path.basename(repoRoot));
  const name = slugify(playlistName);
  const run = slugify(runId).slice(0, 8);
  return path.join(os.tmpdir(), 'moag-worktrees', `${repo}-${name}-${run}`);
}

/** Branch checked out inside a playlist's worktree. */
export function worktreeBranchFor(prefix: string, playlistName: string, runId: string): string {
  const ns = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${ns}${slugify(playlistName)}-${slugify(runId).slice(0, 8)}`;
}

/** True when the run needs isolation: more than one playlist may be in flight. */
export function isolationRequired(concurrency: number, playlistCount: number): boolean {
  return concurrency > 1 && playlistCount > 1;
}

/** `git worktree` exists in every git that ships today, but verify rather than assume. */
export async function supportsWorktrees(repoRoot: string, git: GitRunner): Promise<boolean> {
  const out = await git(['worktree', 'list'], repoRoot);
  return out !== null;
}

/**
 * Create one worktree per playlist.
 *
 * All-or-nothing: if any worktree cannot be created, the ones already made are
 * removed and the caller is told to fall back to sequential execution. Partial
 * isolation is worse than none — some playlists colliding while others do not
 * is a bug that reproduces only under load.
 */
export async function createWorktrees(
  repoRoot: string,
  playlists: Array<{ id: string; name: string }>,
  runId: string,
  branchPrefix: string,
  git: GitRunner,
): Promise<IsolationOutcome> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (inside === null || inside.trim() !== 'true') {
    return { ok: false, reason: 'not-a-repo', detail: 'Not a git work tree.' };
  }
  if (!await supportsWorktrees(repoRoot, git)) {
    return { ok: false, reason: 'unsupported', detail: 'This git does not support worktrees.' };
  }

  const made: Worktree[] = [];
  for (const pl of playlists) {
    const wtPath = worktreePathFor(repoRoot, pl.name, runId);
    const branch = worktreeBranchFor(branchPrefix, pl.name, runId);

    // `-B` resets the branch if a previous run left one behind, so a repeated
    // daemon run does not fail on "branch already exists".
    const created = await git(['worktree', 'add', '-B', branch, wtPath], repoRoot);
    if (created === null) {
      await removeWorktrees(repoRoot, made, git);
      return { ok: false, reason: 'create-failed', detail: `Could not create worktree for "${pl.name}".` };
    }
    made.push({ path: wtPath, branch, playlistId: pl.id });
  }

  return { ok: true, worktrees: made };
}

/**
 * Remove worktrees created for a run, and report any that were kept.
 *
 * Deliberately does NOT pass --force: git refuses to remove a worktree holding
 * uncommitted changes, and that refusal is the point. A worktree still dirty at
 * teardown holds agent work that was never committed, and forcing it would
 * destroy that work silently. Those paths are returned so the caller can tell
 * the user where the work actually is.
 *
 * Never throws: teardown failing must not fail a run whose work already landed.
 * Branches are always left behind — they hold the commits a human reviews.
 */
export async function removeWorktrees(
  repoRoot: string,
  worktrees: Worktree[],
  git: GitRunner,
): Promise<string[]> {
  const kept: string[] = [];
  for (const wt of worktrees) {
    const removed = await git(['worktree', 'remove', wt.path], repoRoot);
    if (removed === null) { kept.push(wt.path); }
  }
  // Drop administrative records for any directory that vanished underneath us.
  await git(['worktree', 'prune'], repoRoot);
  return kept;
}

/** One human-readable line per isolation failure. */
export function describeIsolationFailure(reason: IsolationFailure): string {
  switch (reason) {
    case 'not-a-repo':
      return 'Concurrent playlists need git worktree isolation, but this folder is not a git repository. Running playlists one at a time instead.';
    case 'unsupported':
      return 'Concurrent playlists need git worktree isolation, which this git does not support. Running playlists one at a time instead.';
    case 'create-failed':
      return 'Concurrent playlists need git worktree isolation, which could not be set up. Running playlists one at a time instead.';
    case 'delivery-off':
      // Isolation without delivery would strand each playlist's work in a
      // throwaway checkout with no commit to carry it out.
      return 'Concurrent playlists need agentTaskPlayer.git.autoCommit so each playlist can commit inside its own checkout. Running playlists one at a time instead.';
  }
}
