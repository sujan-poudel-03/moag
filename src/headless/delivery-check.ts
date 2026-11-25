// ─── `moag delivery-check`: will a finished run's branch actually reach GitHub from this machine? ───
//
//   moag delivery-check [<project id>]
//
// For each approved project (or the one named) it asks the questions a push or a draft pull request depends on,
// without changing anything: is there an `origin`, can git read it from this machine (`git ls-remote --heads`, with
// prompts off and a time limit, so a blocked port or a missing login shows up now instead of at the end of a run),
// and, for projects set to open draft pull requests, is `gh` signed in. A failure is explained with the same plain
// reasons a failed push gives (remote-delivery.ts classifyGitFailure).
//
// Read-only: it never pushes, never writes a file and sends nothing to ONOSOO. Exit 0 when every project is fine,
// 1 when any has a problem, 2 for a wrong argument or no approved projects.
// Imports nothing that loads `vscode`.

import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { userConfigDir } from './onosoo-config';
import { loadApprovedProjects, type ApprovedProject } from './onosoo-projects';
import { classifyGitFailure } from './remote-delivery';

export const DELIVERY_CHECK_USAGE =
  'Usage: moag delivery-check [<project id>]\n'
  + '  Checks, without changing anything, that a finished run can be pushed (and a draft pull request opened) from this\n'
  + '  machine: the remote exists, git can reach it, and `gh` is signed in where draft pull requests are on.\n';

export type GitOutcome = { ok: true; stdout: string } | { ok: false; message: string };

export interface DeliveryCheckDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Run git in `dir` with prompts off; never throws. */
  git?: (args: string[], dir: string) => GitOutcome;
  /** True when `gh` is installed and signed in. */
  ghReady?: () => boolean;
}

const LS_REMOTE_TIMEOUT_MS = 25_000;

function defaultGit(args: string[], dir: string): GitOutcome {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: dir,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: LS_REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { ok: false, message: timedOut ? 'git did not finish in time.' : r.error.message };
  }
  if (r.status === 0) { return { ok: true, stdout: (r.stdout ?? '').trim() }; }
  return { ok: false, message: ((r.stderr ?? '').trim() || (r.stdout ?? '').trim() || `git exited ${r.status}`) };
}

function defaultGhReady(): boolean {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

/** The problems of one project, as sentences; empty when it is fine. `notes` are things worth knowing, not problems. */
export function checkProject(
  p: Pick<ApprovedProject, 'path' | 'delivery'>,
  git: (args: string[], dir: string) => GitOutcome,
  ghReady: () => boolean,
): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const mode = p.delivery ?? 'off';
  if (mode === 'off') {
    notes.push('Delivery is off for this project, so a finished run stays as a local branch. Set "delivery" in projects.json to "branch" or "draft-pr" to push it.');
    return { problems, notes };
  }
  const remote = git(['remote', 'get-url', 'origin'], p.path);
  if (!remote.ok) {
    problems.push('There is no "origin" remote, so there is nowhere to push to. Add one with: git remote add origin <address>');
    return { problems, notes };
  }
  notes.push(`origin is ${remote.stdout}`);
  const reach = git(['ls-remote', '--heads', 'origin'], p.path);
  if (!reach.ok) { problems.push(classifyGitFailure(reach.message).text); }
  if (mode === 'draft-pr' && !ghReady()) {
    problems.push('Draft pull requests are on, but the GitHub CLI is not installed or not signed in. Run: gh auth login');
  }
  return { problems, notes };
}

/** `moag delivery-check`. Returns the exit code. */
export function cmdDeliveryCheck(argv: string[], deps: DeliveryCheckDeps = {}): number {
  const out = deps.out ?? ((s: string): void => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string): void => { process.stderr.write(s); });
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const homedir = deps.homedir ?? os.homedir;
  const git = deps.git ?? defaultGit;
  const ghReady = deps.ghReady ?? defaultGhReady;

  if (argv.some((a) => a.startsWith('--'))) { err(`Unknown option ${argv.find((a) => a.startsWith('--'))}.\n${DELIVERY_CHECK_USAGE}`); return 2; }
  if (argv.length > 1) { err(`Only one project id can be given.\n${DELIVERY_CHECK_USAGE}`); return 2; }

  const stateDir = path.join(userConfigDir(env, platform, homedir), 'moag');
  const approved = loadApprovedProjects(stateDir, { platform });
  if (approved.projects.length === 0) {
    err('No approved projects found. Run `moag init` inside a git repository first.\n');
    for (const problem of approved.errors) { err(`  projects.json: ${problem}\n`); }
    return 2;
  }
  const wanted = argv[0];
  const list = wanted ? approved.projects.filter((p) => p.id === wanted) : approved.projects;
  if (list.length === 0) {
    err(`No approved project has the id "${wanted}". Known: ${approved.projects.map((p) => p.id).join(', ')}.\n`);
    return 2;
  }

  let failed = 0;
  for (const p of list) {
    const { problems, notes } = checkProject(p, git, ghReady);
    out(`${p.name} (${p.id}), delivery ${p.delivery ?? 'off'}: ${problems.length === 0 ? 'OK' : 'PROBLEM'}\n`);
    for (const n of notes) { out(`  - ${n}\n`); }
    for (const problem of problems) { out(`  ! ${problem}\n`); }
    if (problems.length > 0) { failed++; }
  }
  out(failed === 0 ? 'Every checked project can deliver.\n' : `${failed} of ${list.length} project${list.length === 1 ? '' : 's'} cannot deliver yet. Fix the lines marked "!" and run this again.\n`);
  return failed === 0 ? 0 : 1;
}
