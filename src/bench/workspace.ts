// ─── Benchmark workspace preparation and gate execution ───
//
// A scenario's repository always starts in a FRESH directory under the
// server's projects root: a template folder copied and turned into a new git
// repository, or a local repository cloned at a named ref. The live working
// tree is never used: the destination may not equal, contain, or sit inside
// the clone source (compared as real paths, case-insensitively on Windows).
//
// git runs through execFile with array arguments (no shell). Setup and gate
// commands are scenario-authored shell commands; each gets a timeout and a
// tree kill (`taskkill /T /F` on Windows), and every listener and timer is
// released on both `close` and `error`.

import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { killProcess, SPAWN_DETACHED } from '../utils/process-kill';
import { Scenario, isInsideOrSame } from './scenario';

/** Most output kept per command (the tail). */
export const COMMAND_TAIL_BYTES = 64 * 1024;
/** Upper bound for one git call (a clone of a large repo can take a while). */
const GIT_TIMEOUT_MS = 10 * 60_000;
/** Upper bound for one setup command (`npm ci`). */
export const SETUP_TIMEOUT_MS = 20 * 60_000;

export interface CommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last {@link COMMAND_TAIL_BYTES} of combined stdout/stderr. */
  tail: string;
}

export interface PreparedWorkspace {
  dir: string;
  /** Workspace folder name relative to the projects root (what the server's project intake takes). */
  name: string;
  kind: 'template' | 'clone';
  head: string | null;
  setup: CommandResult[];
}

/** A workspace could not be prepared (refused, git failed, a setup command failed). */
export class BenchWorkspaceError extends Error {
  constructor(message: string) { super(message); this.name = 'BenchWorkspaceError'; }
}

const BENCH_GIT_IDENTITY = ['-c', 'user.name=moag-bench', '-c', 'user.email=bench@moag.invalid'];

/** Run git with array args and no shell. Rejects on a non-zero exit with git's stderr. */
export function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new BenchWorkspaceError(`git ${args.filter((a) => !a.startsWith('user.')).join(' ')} failed: ${String(stderr || err.message).trim().slice(-2000)}`)); return; }
      resolve(String(stdout));
    });
  });
}

/** Real path of `p`, or of its nearest existing ancestor joined with the rest. */
function realish(p: string): string {
  const abs = path.resolve(p);
  let probe = abs;
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(probe), ...rest.reverse()); } catch { /* climb */ }
    const parent = path.dirname(probe);
    if (parent === probe) { return abs; }
    rest.push(path.basename(probe));
    probe = parent;
  }
}

/**
 * Why `dest` may not be a clone of `source`, or null when it may: it must not
 * be the source, inside it, or contain it.
 */
export function cloneGuardProblem(source: string, dest: string): string | null {
  const s = realish(source);
  const d = realish(dest);
  if (isInsideOrSame(s, d)) { return `the workspace ${d} would be inside the clone source ${s} (never the live working tree)`; }
  if (isInsideOrSame(d, s)) { return `the workspace ${d} would contain the clone source ${s}`; }
  return null;
}

/**
 * Create the scenario's workspace at `<projectsRoot>/<name>` and run its setup
 * commands. Throws {@link BenchWorkspaceError} on any refusal or failure.
 */
export async function prepareWorkspace(
  scenario: Scenario, projectsRoot: string, name: string, env: NodeJS.ProcessEnv = process.env,
): Promise<PreparedWorkspace> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { throw new BenchWorkspaceError(`invalid workspace name "${name}"`); }
  const dir = path.join(path.resolve(projectsRoot), name);
  if (fs.existsSync(dir)) { throw new BenchWorkspaceError(`the workspace ${dir} already exists`); }
  fs.mkdirSync(path.resolve(projectsRoot), { recursive: true });

  let head: string | null = null;
  if (scenario.repo.kind === 'template') {
    fs.cpSync(scenario.repo.templateDir, dir, { recursive: true, errorOnExist: true, force: false });
    await git(['init', '-b', 'main'], dir, env);
    await git(['add', '-A'], dir, env);
    await git([...BENCH_GIT_IDENTITY, 'commit', '--allow-empty', '-m', 'bench: initial'], dir, env);
  } else {
    const problem = cloneGuardProblem(scenario.repo.path, dir);
    if (problem) { throw new BenchWorkspaceError(problem); }
    await git(['-c', 'core.longpaths=true', 'clone', '--no-hardlinks', '--branch', scenario.repo.ref, '--single-branch', '--', scenario.repo.path, dir], path.resolve(projectsRoot), env);
    // The clone source is the user's live repository: no remote may point back
    // at it, so nothing a run does (a push, a tag push) can write into it.
    await git(['remote', 'remove', 'origin'], dir, env);
  }
  head = (await git(['rev-parse', 'HEAD'], dir, env)).trim() || null;

  const setup: CommandResult[] = [];
  for (const command of scenario.setupCommands) {
    const r = await runCommand(command, dir, env, SETUP_TIMEOUT_MS);
    setup.push(r);
    if (r.exitCode !== 0 || r.timedOut) {
      throw new BenchWorkspaceError(`setup command "${command}" ${r.timedOut ? 'timed out' : `exited ${r.exitCode}`}:\n${r.tail.slice(-2000)}`);
    }
  }
  return { dir, name, kind: scenario.repo.kind, head, setup };
}

/**
 * Run one shell command in `cwd` with a timeout. Never rejects: a spawn error
 * is exit code null with the message in the tail. On timeout the whole process
 * tree is killed.
 */
export function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  return new Promise<CommandResult>((resolve) => {
    let tail = '';
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer | string): void => {
      tail = (tail + chunk.toString()).slice(-COMMAND_TAIL_BYTES);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: SPAWN_DETACHED, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ command, exitCode: null, timedOut: false, durationMs: 0, tail: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killProcess(child);
    }, timeoutMs);
    const finish = (exitCode: number | null, extra?: string): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', append);
      child.stderr?.off('data', append);
      child.off('close', onClose);
      child.off('error', onError);
      if (extra) { append(`\n${extra}`); }
      resolve({ command, exitCode, timedOut, durationMs: Date.now() - started, tail });
    };
    const onClose = (code: number | null): void => finish(timedOut ? null : code);
    const onError = (err: Error): void => finish(null, err.message);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('close', onClose);
    child.on('error', onError);
  });
}

/** Run every gate in order (a failure does not stop the rest). */
export async function runGates(commands: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult[]> {
  const out: CommandResult[] = [];
  for (const c of commands) { out.push(await runCommand(c, cwd, env, timeoutMs)); }
  return out;
}

/** True when every gate exited 0 without timing out. */
export function gatesGreen(results: readonly CommandResult[]): boolean {
  return results.length > 0 && results.every((r) => r.exitCode === 0 && !r.timedOut);
}
