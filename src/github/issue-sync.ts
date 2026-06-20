/**
 * GitHub issue intake + completion feedback — the "close the loop" core.
 *
 * This module is intentionally FREE of any `vscode` dependency so it can run both
 * inside the extension and in the headless daemon. All `gh` invocations go through
 * the safe `ghSync`/`ghAsync` wrappers (no shell, array args).
 */

import { ghSync, ghAsync } from '../utils/gh';
import { createTask } from '../models/plan';
import { Task } from '../models/types';

export interface GhIssue {
  number: number;
  title: string;
  body: string;
}

export interface FetchOptions {
  repo: string;          // owner/repo
  label?: string;        // optional sync label filter
  cwd?: string;
  limit?: number;        // default 50
  timeoutMs?: number;    // default 15000
}

/**
 * Fetch open issues for a repo via the gh CLI. Returns [] on any failure (gh
 * missing, auth, network, malformed JSON) — callers decide how to surface that.
 */
export function fetchOpenIssues(opts: FetchOptions): GhIssue[] {
  const args = ['issue', 'list', '--repo', opts.repo, '--state', 'open'];
  if (opts.label) { args.push('--label', opts.label); }
  args.push('--json', 'number,title,body', '--limit', String(opts.limit ?? 50));
  let raw: string;
  try {
    raw = ghSync(args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15_000 });
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) { return []; }
    return parsed
      .filter((i): i is GhIssue => i && typeof i.number === 'number' && typeof i.title === 'string')
      .map((i) => ({ number: i.number, title: i.title, body: typeof i.body === 'string' ? i.body : '' }));
  } catch {
    return [];
  }
}

/**
 * Filter to issues we haven't seen yet (keyed "repo#number") and convert each into
 * a runnable agent task tagged with its source issue for two-way sync.
 */
export function newIssuesToTasks(issues: GhIssue[], repo: string, known: Set<string>): Task[] {
  const tasks: Task[] = [];
  for (const issue of issues) {
    const key = `${repo}#${issue.number}`;
    if (known.has(key)) { continue; }
    known.add(key);
    const task = createTask(
      issue.title.substring(0, 60),
      `Fix GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body ?? ''}`,
    );
    task.sourceIssueNumber = issue.number;
    task.sourceIssueRepo = repo;
    tasks.push(task);
  }
  return tasks;
}

export interface ReportOptions {
  cwd?: string;
  /** When true, close the issue on success (default true). */
  closeOnSuccess?: boolean;
  /** Label applied when a task fails (default "moag:failed"). */
  failureLabel?: string;
}

/**
 * Report a task's outcome back to its source issue, closing the loop:
 *   success → comment "resolved by MOAG" + close
 *   failure → comment with the reason + apply a failure label (left open)
 * Fire-and-forget; never throws.
 */
export function reportIssueResult(
  repo: string,
  issueNumber: number,
  outcome: { success: boolean; summary?: string },
  opts: ReportOptions = {},
): void {
  const cwd = opts.cwd;
  if (outcome.success) {
    const body = `✅ Resolved by MOAG automated run.${outcome.summary ? `\n\n${outcome.summary}` : ''}`;
    ghAsync(['issue', 'comment', String(issueNumber), '--repo', repo, '--body', body], { cwd }, () => {
      if (opts.closeOnSuccess !== false) {
        ghAsync(['issue', 'close', String(issueNumber), '--repo', repo], { cwd });
      }
    });
  } else {
    const body = `❌ MOAG run did not resolve this issue.${outcome.summary ? `\n\n${outcome.summary}` : ''}`;
    ghAsync(['issue', 'comment', String(issueNumber), '--repo', repo, '--body', body], { cwd });
    ghAsync(['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', opts.failureLabel ?? 'moag:failed'], { cwd });
  }
}

/**
 * File a new incident issue (used by monitor tasks and error-log seeding). The
 * label should match what the autonomous loop polls for, so the incident is picked
 * up → fixed → (gated) redeployed — closing the maintenance loop. Returns the issue
 * URL, or null on failure (so callers can degrade without throwing).
 */
export function fileIncidentIssue(
  repo: string,
  title: string,
  body: string,
  opts: { label?: string; cwd?: string; timeoutMs?: number } = {},
): string | null {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', opts.label ?? 'moag:incident'];
  try {
    const out = ghSync(args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000 });
    const url = out.trim().split('\n').filter((l) => l.includes('github.com')).pop();
    return url ?? null;
  } catch {
    return null;
  }
}
