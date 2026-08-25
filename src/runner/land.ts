// ─── Landing — getting the night's branches back into the trunk ──────────────
//
// Worktree isolation gives each concurrent playlist its own branch, which is what
// makes parallelism safe. It also means a productive night ends with several
// branches and nothing to do with them: the operator who was supposed to spend
// fifteen minutes reviewing instead merges by hand. Delivery solved the wrong
// half of the problem if the work cannot land.
//
// The discipline here is the same one the verification loop is built on: find
// out, do not guess. Conflicts are DETECTED without touching the working tree —
// `git merge-tree` merges in memory and reports — and a branch that conflicts is
// reported for a person, never forced. Nothing here rewrites history.
//
// Dependency-injected and free of `vscode`, like evidence.ts and prd-loop.ts.

/** Outcome of one git invocation. stdout is kept even when the command fails. */
export interface GitResult {
  ok: boolean;
  stdout: string;
}

/**
 * Runs a git subcommand.
 *
 * Unlike the runner elsewhere in this codebase this keeps stdout on failure,
 * because `git merge-tree` reports the conflicted paths there while exiting
 * non-zero — and those paths are the whole point of asking.
 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/** What we know about one branch a run left behind. */
export interface BranchAssessment {
  branch: string;
  /** Commits on this branch that the base does not have. */
  commits: number;
  /** Files the branch would bring in. */
  changedFiles: string[];
  /** True when it merges into the base with no conflict. */
  clean: boolean;
  /** Paths that conflict, when it does not. */
  conflicts: string[];
}

export interface LandReport {
  base: string;
  ready: BranchAssessment[];
  blocked: BranchAssessment[];
  /** Branches whose work is already in the base — nothing to do. */
  alreadyLanded: string[];
}

export type MergeOutcome =
  | { merged: true; branch: string }
  | { merged: false; branch: string; reason: 'conflict' | 'failed'; detail: string };

/** The branch a run should land into: whatever HEAD was before MOAG branched. */
export async function resolveBase(
  repoRoot: string,
  explicit: string | undefined,
  prefix: string,
  git: GitRunner,
): Promise<string | null> {
  if (explicit) { return explicit; }

  // The current branch, unless we are standing on a MOAG branch — in which case
  // it is the thing we want to land INTO, not the thing to land.
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const ns = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const current = head.stdout.trim();
  if (current && current !== 'HEAD' && !current.startsWith(ns)) { return current; }

  // Otherwise fall back to the repository's default branch.
  for (const candidate of ['main', 'master']) {
    const found = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], repoRoot);
    if (found.ok && found.stdout.trim()) { return candidate; }
  }
  return null;
}

/** Every branch in the MOAG namespace. */
export async function findRunBranches(
  repoRoot: string,
  prefix: string,
  git: GitRunner,
): Promise<string[]> {
  const ns = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const out = await git(['branch', '--list', `${ns}*`, '--format=%(refname:short)'], repoRoot);
  if (!out.ok) { return []; }
  return out.stdout.split(String.fromCharCode(10)).map((b: string) => b.trim()).filter(Boolean).sort();
}

/**
 * Assess one branch against the base WITHOUT touching the working tree.
 *
 * `git merge-tree --write-tree` performs the merge in memory and reports the
 * conflicted paths. That matters: assessing must never leave the repository in a
 * half-merged state, because this runs unattended.
 */
export async function assessBranch(
  repoRoot: string,
  branch: string,
  base: string,
  git: GitRunner,
): Promise<BranchAssessment> {
  const empty: BranchAssessment = { branch, commits: 0, changedFiles: [], clean: true, conflicts: [] };

  const log = await git(['rev-list', '--count', `${base}..${branch}`], repoRoot);
  const commits = Number(log.stdout.trim()) || 0;
  if (commits === 0) { return empty; }

  const files = await git(['diff', '--name-only', `${base}...${branch}`], repoRoot);
  const changedFiles = files.stdout.split(String.fromCharCode(10)).map((f: string) => f.trim()).filter(Boolean);

  // merge-tree exits non-zero on conflict and names the conflicted paths on
  const merged = await git(['merge-tree', '--write-tree', '--name-only', base, branch], repoRoot);
  if (merged.ok) {
    return { branch, commits, changedFiles, clean: true, conflicts: [] };
  }

  // stdout, so the failure IS the answer — it must not be discarded.
  // merge-tree prints: <tree-oid>, then the conflicted paths, then a BLANK LINE,
  // then its own commentary ('Auto-merging x', 'CONFLICT (content): ...'). Only
  // the paths are useful, so stop at the blank line rather than reporting git
  // talking to itself as though it were a filename.
  const raw = merged.stdout.split(String.fromCharCode(10)).map((l: string) => l.trimEnd());
  const conflicts: string[] = [];
  for (const line of raw.slice(1)) {
    if (line.trim().length === 0) { break; }
    conflicts.push(line.trim());
  }

  return { branch, commits, changedFiles, clean: false, conflicts };
}

/** Assess every branch a run left behind. */
export async function assessAll(
  repoRoot: string,
  prefix: string,
  base: string,
  git: GitRunner,
): Promise<LandReport> {
  const report: LandReport = { base, ready: [], blocked: [], alreadyLanded: [] };

  for (const branch of await findRunBranches(repoRoot, prefix, git)) {
    const a = await assessBranch(repoRoot, branch, base, git);
    if (a.commits === 0) { report.alreadyLanded.push(branch); }
    else if (a.clean) { report.ready.push(a); }
    else { report.blocked.push(a); }
  }
  return report;
}

/**
 * Merge one branch into the base.
 *
 * Refuses to start on a dirty tree, uses --no-ff so a night's work stays
 * identifiable as a unit, and aborts cleanly if git reports a conflict rather
 * than leaving the repository half-merged.
 */
export async function landBranch(
  repoRoot: string,
  branch: string,
  base: string,
  git: GitRunner,
): Promise<MergeOutcome> {
  const status = await git(['status', '--porcelain'], repoRoot);
  if (!status.ok) { return { merged: false, branch, reason: 'failed', detail: 'git status failed.' }; }
  if (status.stdout.trim().length > 0) {
    return { merged: false, branch, reason: 'failed', detail: 'Working tree is dirty; commit or stash first.' };
  }

  const onBase = await git(['checkout', base], repoRoot);
  if (!onBase.ok) { return { merged: false, branch, reason: 'failed', detail: `Could not check out ${base}.` }; }

  const merged = await git(['merge', '--no-ff', '-m', `Land ${branch}`, branch], repoRoot);
  if (merged.ok) { return { merged: true, branch }; }

  // Never leave a half-merged tree behind for the next run to trip over.
  await git(['merge', '--abort'], repoRoot);
  return { merged: false, branch, reason: 'conflict', detail: `${branch} conflicts with ${base}; merge it by hand.` };
}

/** Render the assessment as plain text for a terminal. */
export function renderLandReport(r: LandReport): string {
  const out: string[] = [`Landing into ${r.base}`, ''];

  if (r.ready.length === 0 && r.blocked.length === 0) {
    out.push('Nothing to land.');
    if (r.alreadyLanded.length > 0) {
      out.push(`  (${r.alreadyLanded.length} branch(es) already merged)`);
    }
    return out.join('\n');
  }

  if (r.ready.length > 0) {
    out.push(`${r.ready.length} branch(es) land cleanly:`);
    for (const b of r.ready) {
      out.push(`  ${b.branch}  ${b.commits} commit(s), ${b.changedFiles.length} file(s)`);
    }
    out.push('');
  }

  if (r.blocked.length > 0) {
    out.push(`${r.blocked.length} branch(es) need a person:`);
    for (const b of r.blocked) {
      out.push(`  ${b.branch}  ${b.commits} commit(s)`);
      for (const c of b.conflicts.slice(0, 8)) { out.push(`      conflict: ${c}`); }
      if (b.conflicts.length > 8) { out.push(`      ...and ${b.conflicts.length - 8} more`); }
    }
    out.push('');
  }

  if (r.alreadyLanded.length > 0) {
    out.push(`${r.alreadyLanded.length} branch(es) already merged.`);
  }
  return out.join('\n').trimEnd();
}
