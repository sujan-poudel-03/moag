// ─── Git delivery — turn a run into reviewable increments ────────────────────
//
// Without this, a night of unattended work is one undifferentiated diff: there
// is no way to accept task 4 and reject task 5. Here a run gets its own branch
// and every verified task gets its own commit carrying its own evidence.
//
// Dependency-injected and free of `vscode`, exactly like evidence.ts and
// prd-loop.ts, so the same code runs from the extension and the headless CLI.
//
// SAFETY: this writes to the user's repository. Every guard below exists because
// the alternative is sweeping someone's uncommitted work into an agent's commit.
// It never pushes, never force-anything, and never checks out over dirty state.

/** Runs a git subcommand and resolves stdout, or null when git fails. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export interface DeliveryConfig {
  enabled: boolean;
  /** Branch namespace, e.g. `moag/`. */
  branchPrefix: string;
}

/** Why delivery could not be armed. Closed set — handle every member. */
export type PrepareFailure =
  | 'not-a-repo'
  | 'dirty-tree'
  | 'detached-head'
  | 'branch-failed';

export type PrepareOutcome =
  | { ok: true; branch: string; created: boolean }
  | { ok: false; reason: PrepareFailure; detail: string };

export interface CommitRequest {
  cwd: string;
  taskName: string;
  playlistName: string;
  engine: string;
  /** Files the task changed, for the commit body. */
  changedFiles: string[];
  costUsd?: number;
}

export type CommitOutcome =
  | { committed: true; sha: string }
  | { committed: false; reason: 'nothing-to-commit' | 'commit-failed'; detail: string };

const MAX_SLUG = 32;
const MAX_SUBJECT = 68;
const MAX_BODY_FILES = 40;

/** Lowercase, hyphenated, git-ref-safe fragment of an arbitrary name. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug || 'run';
}

/**
 * Branch name for a run. The run id keeps two runs of the same plan from
 * colliding, which matters most for the daemon where the same plan repeats.
 */
export function branchNameFor(prefix: string, planName: string, runId: string): string {
  const ns = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${ns}${slugify(planName)}-${slugify(runId).slice(0, 8)}`;
}

/** Build the commit message. Pure, so the format is assertable in a test. */
export function buildCommitMessage(req: CommitRequest): string {
  const subject = `${req.taskName}`.replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT) || 'MOAG task';

  const lines: string[] = [subject, ''];
  lines.push(`Playlist: ${req.playlistName}`);
  lines.push(`Engine: ${req.engine}`);
  if (typeof req.costUsd === 'number' && req.costUsd > 0) {
    lines.push(`Cost: $${req.costUsd.toFixed(4)}`);
  }

  if (req.changedFiles.length > 0) {
    lines.push('');
    lines.push('Files:');
    for (const f of req.changedFiles.slice(0, MAX_BODY_FILES)) {
      lines.push(`  ${f}`);
    }
    if (req.changedFiles.length > MAX_BODY_FILES) {
      lines.push(`  ...and ${req.changedFiles.length - MAX_BODY_FILES} more`);
    }
  }

  lines.push('');
  lines.push('Committed by MOAG after this task passed verification.');
  return lines.join('\n');
}

/** True for MOAG's own bookkeeping, which must never count as the user's work. */
function isOwnOutput(file: string): boolean {
  return file === '.moag' || file.startsWith('.moag/') || file.startsWith('.moag\\');
}

/**
 * Paths in `git status --porcelain` that are not MOAG's own output.
 *
 * MOAG writes .moag/ as it runs — the plan, the park queue, headless state. On a
 * target repo that does not ignore .moag/, that made the tree dirty and MOAG then
 * refused to deliver because of changes it had made itself. evidence.ts already
 * excludes .moag/ from changed files for the same reason.
 *
 * Everything else still blocks: the guard exists so an agent's commit cannot
 * sweep in work the user had open.
 */
export function foreignChanges(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    // Porcelain v1 is `XY <path>`; a rename is `R  old -> new`, and the
    // destination is the one that matters.
    .map((line) => {
      const p = line.slice(3).trim();
      const arrow = p.indexOf(' -> ');
      return arrow >= 0 ? p.slice(arrow + 4).trim() : p;
    })
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter((p) => p.length > 0 && !isOwnOutput(p));
}

/**
 * Arm delivery for a run: confirm the repo is in a state we may write to, then
 * put the run on its own branch.
 *
 * Refuses on a dirty tree. An agent's commit must contain the agent's work and
 * nothing else — sweeping in whatever the user had open is unrecoverable once
 * it lands in the same commit.
 */
export async function prepareBranch(
  cwd: string,
  planName: string,
  runId: string,
  cfg: DeliveryConfig,
  git: GitRunner,
): Promise<PrepareOutcome> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside === null || inside.trim() !== 'true') {
    return { ok: false, reason: 'not-a-repo', detail: 'Not a git work tree.' };
  }

  const status = await git(['status', '--porcelain'], cwd);
  if (status === null) {
    return { ok: false, reason: 'not-a-repo', detail: 'git status failed.' };
  }
  const foreign = foreignChanges(status);
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: 'dirty-tree',
      detail: `Working tree has uncommitted changes (${foreign.slice(0, 3).join(', ')}). Commit or stash them first.`,
    };
  }

  // A detached HEAD means there is no branch to return to; refuse rather than
  // strand the commits somewhere the user will not find them.
  const head = await git(['symbolic-ref', '--quiet', 'HEAD'], cwd);
  if (head === null || head.trim().length === 0) {
    return { ok: false, reason: 'detached-head', detail: 'HEAD is detached.' };
  }

  const branch = branchNameFor(cfg.branchPrefix, planName, runId);

  // Reuse the branch when it already exists (a resumed run), otherwise create it.
  const existing = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  const created = !existing || existing.trim().length === 0;
  const result = created
    ? await git(['checkout', '-b', branch], cwd)
    : await git(['checkout', branch], cwd);

  if (result === null) {
    return { ok: false, reason: 'branch-failed', detail: `Could not switch to ${branch}.` };
  }
  return { ok: true, branch, created };
}

/**
 * Commit whatever the task just produced.
 *
 * A task that changed nothing is not an error — check tasks and no-op repairs
 * legitimately produce no diff — so that resolves to `nothing-to-commit`.
 */
export async function commitTask(req: CommitRequest, git: GitRunner): Promise<CommitOutcome> {
  const staged = await git(['add', '-A'], req.cwd);
  if (staged === null) {
    return { committed: false, reason: 'commit-failed', detail: 'git add failed.' };
  }

  const pending = await git(['diff', '--cached', '--name-only'], req.cwd);
  if (pending === null || pending.trim().length === 0) {
    return { committed: false, reason: 'nothing-to-commit', detail: 'No staged changes.' };
  }

  // Message goes through -m as a single argument; it is never interpolated into
  // a shell, so a task name containing quotes or newlines is inert.
  const committed = await git(['commit', '-m', buildCommitMessage(req)], req.cwd);
  if (committed === null) {
    return { committed: false, reason: 'commit-failed', detail: 'git commit failed.' };
  }

  const sha = await git(['rev-parse', '--short', 'HEAD'], req.cwd);
  return { committed: true, sha: (sha ?? '').trim() };
}

/** One human-readable line per prepare failure. */
export function describePrepareFailure(reason: PrepareFailure): string {
  switch (reason) {
    case 'not-a-repo':
      return 'Auto-commit is on but this folder is not a git repository — skipping delivery.';
    case 'dirty-tree':
      return 'Auto-commit is on but the working tree is dirty. Commit or stash first, or the agent\'s commit would include your changes. Skipping delivery.';
    case 'detached-head':
      return 'Auto-commit is on but HEAD is detached — skipping delivery so commits are not stranded.';
    case 'branch-failed':
      return 'Auto-commit is on but the run branch could not be created — skipping delivery.';
  }
}
