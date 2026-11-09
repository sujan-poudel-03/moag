// ─── Delivering a remote run's branch ───
//
// A remote run ends with its commits imported into the approved project as `refs/heads/<branch>`
// (remote-branch.ts). That is where the work used to stop: someone had to push it and open the pull
// request by hand. This module is the optional last step, and it is deliberately small:
//
//   delivery "off"       nothing happens (the default)
//   delivery "branch"    push that one branch
//   delivery "draft-pr"  push it, then open a DRAFT pull request for it
//
// The setting is per project, in the machine's own projects.json, so nobody can switch it on from the
// web. It never merges, never deploys and never forces: a branch someone moved is refused, not
// overwritten. Only a branch under the MOAG prefix is ever pushed, with an explicit refspec, so a
// crafted branch name cannot name another ref. Git runs with hooks off and prompts off.
//
// The result for ONOSOO is the pair of events `moag run --pr` already sends: `pr-created { url }` and
// `pr-skipped { reason, message }`. A skipped delivery is information, never an error: the run itself
// succeeded.
//
// Imports `child_process` and the PR helper only: no `vscode`.

import { spawn } from 'child_process';
import * as os from 'os';

import { createPullRequest, describeFailure, PrOutcome, PrRequest } from '../utils/pr';

export const DELIVERY_MODES = ['off', 'branch', 'draft-pr'] as const;
export type DeliveryMode = typeof DELIVERY_MODES[number];

/** A branch name safe to put in a refspec: plain path characters only, no traversal, no leading dash. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** What a base branch may look like in the project's settings. */
export const PR_BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

const GIT_TIMEOUT_MS = 90_000;

export type GitResult = { ok: true; stdout: string } | { ok: false; message: string };

export interface DeliveryDeps {
  /** Run git in `cwd`, hooks and prompts off. Never rejects. */
  git(args: string[], cwd: string): Promise<GitResult>;
  /** Open the pull request (the `gh` call). */
  openPr(req: PrRequest): PrOutcome;
}

export interface DeliveryRequest {
  mode: DeliveryMode;
  projectPath: string;
  /** The run's branch, as imported. */
  branch: string;
  /** Only a branch under this prefix is ever pushed (the daemon's `moag/`). */
  branchPrefix: string;
  /** The branch the pull request targets; the repository default when absent. */
  base?: string | null;
  projectName: string;
  planName: string;
  taskNames: readonly string[];
  /** How the run ended, for the pull request text. */
  exitCode: number | null;
  runId: string;
}

/** What to tell ONOSOO (a run event, or nothing) and a line for the daemon's own log. */
export interface DeliveryResult {
  event: { event: 'pr-created'; url: string } | { event: 'pr-skipped'; reason: string; message: string } | null;
  note: string;
}

const skipped = (reason: string, message: string): DeliveryResult => ({
  event: { event: 'pr-skipped', reason, message },
  note: `delivery skipped (${reason}): ${message}`,
});

/** True when `branch` may be pushed: under the prefix, and shaped like a plain branch name. */
export function isDeliverableBranch(branch: string, prefix: string): boolean {
  if (!prefix || !branch.startsWith(prefix) || branch === prefix) { return false; }
  if (!BRANCH_RE.test(branch)) { return false; }
  return !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.') && !branch.endsWith('.lock');
}

/** The pull request text: plain, and clear that nothing was merged or deployed. */
export function deliveryBody(req: Pick<DeliveryRequest, 'projectName' | 'planName' | 'taskNames' | 'exitCode' | 'runId' | 'branch'>): string {
  const tasks = req.taskNames.length > 0 ? req.taskNames.map((t) => `- ${t.replace(/[\r\n]+/g, ' ').slice(0, 160)}`).join('\n') : 'No task names were recorded.';
  const ended = req.exitCode === 0 ? 'The run finished.' : `The run ended with exit code ${req.exitCode ?? 'unknown'}: read the run in ONOSOO before trusting this.`;
  return [
    '## Summary',
    `Built by MOAG on the build machine for **${req.projectName}** from an ONOSOO run: "${(req.planName || 'untitled').slice(0, 160)}".`,
    '',
    ended,
    '',
    '**This is a draft. Nothing was merged or deployed.** Read the diff and run the checks before you merge it.',
    '',
    '### Tasks',
    tasks,
    '',
    '---',
    `Run \`${req.runId}\` on branch \`${req.branch}\`. Opened by [MOAG](https://github.com/sujan-poudel-03/moag).`,
  ].join('\n');
}

/**
 * Push the run's branch, and open a draft pull request when asked. Never throws; every failure is a
 * `pr-skipped` result with a reason a person can act on.
 */
export async function deliverBranch(req: DeliveryRequest, deps: DeliveryDeps): Promise<DeliveryResult> {
  if (req.mode === 'off') { return { event: null, note: 'delivery is off for this project' }; }
  if (!isDeliverableBranch(req.branch, req.branchPrefix)) {
    return skipped('unsafe-branch', `The branch "${req.branch.slice(0, 80)}" is not one MOAG may push, so nothing was pushed.`);
  }
  const ref = `refs/heads/${req.branch}`;

  const exists = await deps.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], req.projectPath);
  if (!exists.ok) { return skipped('no-branch', 'The run left no branch in the project, so there is nothing to push.'); }

  const remote = await deps.git(['remote', 'get-url', 'origin'], req.projectPath);
  if (!remote.ok) { return skipped('no-remote', 'The project has no "origin" remote to push to.'); }

  // An explicit refspec and no force: a branch someone moved on the remote is refused, never overwritten.
  const pushed = await deps.git(['push', '--no-verify', 'origin', `${ref}:${ref}`], req.projectPath);
  if (!pushed.ok) {
    return skipped('push-failed', `The branch could not be pushed: ${pushed.message.replace(/\s+/g, ' ').slice(0, 200)} Check the machine's GitHub login.`);
  }
  if (req.mode === 'branch') { return { event: null, note: `pushed ${req.branch}` }; }

  const outcome = deps.openPr({
    cwd: req.projectPath,
    title: (req.planName || `MOAG run ${req.runId.slice(0, 8)}`).slice(0, 200),
    planName: req.planName,
    tasks: [],
    changedFiles: [],
    head: req.branch,
    ...(req.base ? { base: req.base } : {}),
    draft: true,
    body: deliveryBody(req),
  });
  if (outcome.ok) { return { event: { event: 'pr-created', url: outcome.url }, note: `pushed ${req.branch} and opened a draft PR: ${outcome.url}` }; }
  return skipped(outcome.reason, `${describeFailure(outcome)} (The branch was pushed.)`);
}

/** Real git and `gh`: git with hooks, prompts and the pager off, bounded in time. */
export const realDeliveryDeps: DeliveryDeps = {
  git: (args, cwd) => new Promise<GitResult>((resolve) => {
    let settled = false;
    const done = (r: GitResult): void => { if (!settled) { settled = true; resolve(r); } };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
      });
    } catch (err) { done({ ok: false, message: err instanceof Error ? err.message : String(err) }); return; }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } done({ ok: false, message: 'git did not finish in time.' }); }, GIT_TIMEOUT_MS);
    let out = '';
    let err = '';
    proc.stdout?.on('data', (c: Buffer) => { if (out.length < 64 * 1024) { out += c.toString(); } });
    proc.stderr?.on('data', (c: Buffer) => { if (err.length < 64 * 1024) { err += c.toString(); } });
    proc.on('error', (e) => { clearTimeout(timer); done({ ok: false, message: e.message }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true, stdout: out.trim() } : { ok: false, message: (err.trim() || out.trim() || `git exited ${code}`) });
    });
  }),
  openPr: (req) => createPullRequest(req),
};
