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

/** What went wrong with git, in words a person can act on. `kind` is stable (tests, logs); `text` is for people. */
export interface GitProblem {
  kind:
    | 'network-blocked'
    | 'ssh-key'
    | 'https-login'
    | 'host-key'
    | 'repo-not-found'
    | 'protected-branch'
    | 'moved-branch'
    | 'timeout'
    | 'other';
  text: string;
}

const SSH_443_HINT =
  'Many networks block port 22. Point the remote at ssh.github.com on port 443 (in ~/.ssh/config: HostName ssh.github.com, Port 443), or switch the remote to its https address.';

/**
 * Turn git's own words into the real reason and what to do about it. The raw message is only ever shortened, never
 * hidden: it follows the plain reason, so nothing is lost. The first rule that matches wins.
 */
export function classifyGitFailure(message: string): GitProblem {
  const m = message.replace(/\s+/g, ' ').trim();
  const lower = m.toLowerCase();
  const raw = m.slice(0, 160);
  if (/did not finish in time/.test(lower)) {
    return { kind: 'timeout', text: `git took too long, so the connection is probably blocked or very slow. ${SSH_443_HINT}` };
  }
  if (/connection timed out|operation timed out|network is unreachable|no route to host|could not resolve host|connection refused|port 22/.test(lower)) {
    return { kind: 'network-blocked', text: `git could not reach the remote. ${SSH_443_HINT} (git said: ${raw})` };
  }
  if (/host key verification failed|remote host identification has changed/.test(lower)) {
    return {
      kind: 'host-key',
      text: `This machine does not trust the remote's SSH host key yet. Run "git ls-remote origin" once in the project and accept it. (git said: ${raw})`,
    };
  }
  if (/permission denied \(publickey\)|no matching host key|publickey/.test(lower)) {
    return {
      kind: 'ssh-key',
      text: `The remote refused this machine's SSH key. Check that the key in ~/.ssh is added to your GitHub account and that the project's remote uses the right host alias. (git said: ${raw})`,
    };
  }
  if (/could not read username|terminal prompts disabled|authentication failed|invalid username or password|error: 40[13]|http 40[13]/.test(lower)) {
    return {
      kind: 'https-login',
      text: `This machine is not signed in to GitHub over https. Run "gh auth login", or switch the remote to SSH. (git said: ${raw})`,
    };
  }
  if (/repository not found|does not appear to be a git repository|not found/.test(lower)) {
    return {
      kind: 'repo-not-found',
      text: `The remote does not exist, or the signed-in account cannot see it. Check the origin address and the account's access. (git said: ${raw})`,
    };
  }
  if (/protected branch|gh006|gh013|push declined due to repository rule|rule violations/.test(lower)) {
    return {
      kind: 'protected-branch',
      text: `GitHub refused the push because of a branch rule. Allow moag/* branches in the repository's rules. (git said: ${raw})`,
    };
  }
  if (/non-fast-forward|fetch first|updates were rejected/.test(lower)) {
    return {
      kind: 'moved-branch',
      text: `A branch with this name already exists on the remote and has moved on, so it was not overwritten. Delete or rename it there and run again. (git said: ${raw})`,
    };
  }
  return { kind: 'other', text: `git said: ${raw}` };
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
    return skipped('push-failed', `The branch could not be pushed. ${classifyGitFailure(pushed.message).text}`);
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
