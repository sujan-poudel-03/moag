// ─── Remote runs: isolation helpers ───
//
// Runs ONOSOO starts execute as a SEPARATE, low-privilege OS account (projects.json
// `runner_user`), reached through `sudo -n -u <runner>` with a fixed sudoers rule.
// That account must not be able to read the device key, projects.json, the spend
// ledger or the audit log — the daemon proves it with a probe child before it
// accepts remote work, and refuses everywhere this cannot hold (Windows, macOS).
//
// This module holds the pure parts: refusal reasons, the exact commands, the child
// environment allowlists, probe parsing, and tightening the state directory.
// Imports nothing that loads `vscode`.

import * as fs from 'fs';
import * as path from 'path';

/** How long the probe child may take to answer. */
export const PROBE_TIMEOUT_MS = 15_000;
/** How often isolation is checked again while the daemon runs. */
export const ISOLATION_RECHECK_MS = 10 * 60_000;

/** Environment variables an engine needs, copied into the job spec (never the device key). */
export const ENGINE_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OLLAMA_HOST',
] as const;

/**
 * Why a probe gets no answer, most often: sudo refused the command because it does not
 * match the sudoers rule character for character (node path, cli.js path).
 */
export const NO_PROBE_ANSWER = 'The runner account did not answer the isolation check. Most often the sudoers rule does not match '
  + 'this daemon\'s node and cli.js paths exactly (see docs/onosoo-remote.md).';

/** Engines a remote run may never use: copilot and custom run arbitrary local tooling. */
export const REMOTE_EXCLUDED_ENGINES: ReadonlySet<string> = new Set(['copilot', 'custom']);

/** Why this machine cannot take remote work at all, or null when it may (pending the probe). */
export function isolationRefusal(platform: NodeJS.Platform, runnerUser: string | null): string | null {
  if (platform !== 'linux') {
    return `Remote runs need a Linux (or WSL) build machine with a separate runner account; this PC runs ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform}.`;
  }
  if (!runnerUser) { return 'Set runner_user in projects.json to a separate account to allow remote runs.'; }
  if (runnerUser === 'root') { return 'runner_user must not be root.'; }
  return null;
}

export interface SpawnCommand {
  command: string;
  args: string[];
}

/** `sudo -n -u <runner> -- <node> <cli.js> remote-child` — exactly what the sudoers rule allows. */
export function childCommand(runnerUser: string, nodePath: string, cliPath: string): SpawnCommand {
  return { command: 'sudo', args: ['-n', '-u', runnerUser, '--', nodePath, cliPath, 'remote-child'] };
}

/** `sudo -n -u <runner> -- /usr/bin/kill -KILL -1`: every process the runner account owns. */
export function forceKillCommand(runnerUser: string): SpawnCommand {
  return { command: 'sudo', args: ['-n', '-u', runnerUser, '--', '/usr/bin/kill', '-KILL', '-1'] };
}

/** The child's environment: PATH, LANG, LC_*, TZ — never MOAG_*, never CI, never a key. */
export function childSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) { continue; }
    if (k === 'PATH' || k === 'LANG' || k === 'TZ' || k.startsWith('LC_')) { out[k] = v; }
  }
  return out;
}

/** The engine credentials present in `env`, for the job spec. */
export function engineEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENGINE_ENV_KEYS) {
    const v = env[k];
    if (typeof v === 'string' && v.length > 0) { out[k] = v; }
  }
  return out;
}

// ─── Probe ───

/** What a probe child reports, as one JSON line. */
export interface ProbeReport {
  event: 'remote-probe';
  uid: number;
  /** path → true when the runner account could NOT read it. */
  unreadable: Record<string, boolean>;
  engines: string[];
  /** projectId → commit shas its mirror already has (for thin bundles). */
  mirrors: Record<string, string[]>;
  /** The runner account's home (so the daemon can scrub its worktree paths from relayed events). */
  home?: string;
}

export type ProbeOutcome =
  | { ok: true; uid: number; engines: string[]; mirrors: Record<string, string[]>; home?: string }
  | { ok: false; reason: string };

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Check a probe child's stdout. Isolation holds only when the child runs as a
 * different, non-root uid and could read none of `protectedPaths`.
 */
export function parseProbe(stdout: string, ownUid: number, protectedPaths: readonly string[]): ProbeOutcome {
  // The FIRST probe line counts; anything the child prints after it is ignored.
  let report: Partial<ProbeReport> | null = null;
  for (const l of stdout.split('\n')) {
    if (!l.trim().startsWith('{')) { continue; }
    try {
      const v = JSON.parse(l) as Partial<ProbeReport>;
      if (v && v.event === 'remote-probe') { report = v; break; }
    } catch { /* not the probe line */ }
  }
  if (!report) { return { ok: false, reason: NO_PROBE_ANSWER }; }
  if (typeof report.uid !== 'number' || !Number.isInteger(report.uid)) { return { ok: false, reason: 'The isolation check did not report the runner account.' }; }
  if (report.uid === 0) { return { ok: false, reason: 'The runner account is root; remote runs need a separate unprivileged account.' }; }
  if (report.uid === ownUid) { return { ok: false, reason: 'The runner account is the same account as MOAG; remote runs need a separate account.' }; }
  const unreadable = report.unreadable && typeof report.unreadable === 'object' ? report.unreadable : {};
  for (const p of protectedPaths) {
    if (unreadable[p] !== true) {
      return { ok: false, reason: `The runner account can read ${path.basename(p)}; tighten its permissions (MOAG does this at start-up) before remote runs are allowed.` };
    }
  }
  const engines = Array.isArray(report.engines)
    ? [...new Set(report.engines.filter((e): e is string => typeof e === 'string' && !REMOTE_EXCLUDED_ENGINES.has(e)))]
    : [];
  const mirrors: Record<string, string[]> = {};
  if (report.mirrors && typeof report.mirrors === 'object') {
    for (const [id, shas] of Object.entries(report.mirrors)) {
      if (Array.isArray(shas)) { mirrors[id] = shas.filter((s): s is string => typeof s === 'string' && SHA_RE.test(s)).slice(0, 100); }
    }
  }
  const home = typeof report.home === 'string' && report.home.startsWith('/') && report.home.length < 512 ? report.home : undefined;
  return { ok: true, uid: report.uid, engines, mirrors, ...(home ? { home } : {}) };
}

/**
 * Every file and directory the runner account must not be able to read: the device
 * key, the allowlist, the ledger, the audit log (current and rotated), undelivered
 * results and the run records.
 */
export function protectedStatePaths(stateDir: string): string[] {
  return [
    path.join(stateDir, 'onosoo.json'),
    path.join(stateDir, 'projects.json'),
    path.join(stateDir, 'remote', 'spend.json'),
    path.join(stateDir, 'remote', 'audit.jsonl'),
    path.join(stateDir, 'remote', 'audit.1.jsonl'),
    path.join(stateDir, 'remote', 'outbox.json'),
    path.join(stateDir, 'remote', 'runs'),
  ];
}

/**
 * The daemon's own check of the runner account, not the probe's word: the uid MOAG
 * resolved for `runner_user` must exist, differ from MOAG's own, not be root, and be
 * the uid the probe child actually ran as.
 */
export function checkRunnerUid(resolvedUid: number | null, probeUid: number, ownUid: number): string | null {
  if (resolvedUid === null) { return 'MOAG could not look up the runner account\'s user id (id -u failed); remote runs stay off.'; }
  if (resolvedUid === 0) { return 'The runner account is root; remote runs need a separate unprivileged account.'; }
  if (resolvedUid === ownUid) { return 'The runner account is the same account as MOAG; remote runs need a separate account.'; }
  if (resolvedUid !== probeUid) { return 'The isolation check ran as a different account than runner_user names; check the sudoers rule.'; }
  return null;
}

/**
 * The daemon's own check of its state directory: the directory (and remote/) must be
 * owned by MOAG's account with mode 0700, and every protected file that exists must be
 * owned by it with no group or other bits. Fails on file systems that ignore modes
 * (a Windows drive under WSL, /mnt/c). Null on Windows, where POSIX modes do not apply.
 */
export function checkStateSecurity(stateDir: string, ownUid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') { return null; }
  const where = 'Remote runs stay off: MOAG\'s state directory must be private to its account';
  for (const dir of [stateDir, path.join(stateDir, 'remote')]) {
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { continue; }
    if (st.uid !== ownUid) { return `${where}, but ${dir} belongs to another account.`; }
    if ((st.mode & 0o777) !== 0o700) {
      return `${where}, but ${dir} has mode ${(st.mode & 0o777).toString(8)} and could not be set to 700 (a Windows drive under WSL cannot hold private files).`;
    }
  }
  for (const p of protectedStatePaths(stateDir)) {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.uid !== ownUid) { return `${where}, but ${path.basename(p)} belongs to another account.`; }
    if ((st.mode & 0o077) !== 0) {
      return `${where}, but ${path.basename(p)} is readable by other accounts and could not be made private.`;
    }
  }
  return null;
}

/** `id -u <user>` through an injected command runner; null when the account does not exist. */
export async function resolveRunnerUid(
  user: string,
  runCommand: (cmd: string, args: string[]) => Promise<string>,
): Promise<number | null> {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) { return null; }
  try {
    const out = (await runCommand('id', ['-u', user])).trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

// ─── State directory permissions ───

/**
 * Owner-only permissions on MOAG's state: the directory and its subdirectories 0700,
 * every file 0600. A no-op on Windows (no POSIX modes). Returns readable problems.
 */
export function tightenStatePermissions(stateDir: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') { return []; }
  const problems: string[] = [];
  const walk = (dir: string): void => {
    try { fs.chmodSync(dir, 0o700); } catch (err) { problems.push(`${dir}: ${(err as Error).message}`); return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { problems.push(`${dir}: ${(err as Error).message}`); return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { continue; }
      if (e.isDirectory()) { walk(p); continue; }
      try { fs.chmodSync(p, 0o600); } catch (err) { problems.push(`${p}: ${(err as Error).message}`); }
    }
  };
  if (fs.existsSync(stateDir)) { walk(stateDir); }
  return problems;
}

/** The sudoers drop-in the setup guide shows (docs/onosoo-remote.md). */
export const SUDOERS_EXAMPLE = [
  'Cmnd_Alias MOAG_REMOTE = /usr/bin/node /opt/moag/out/headless/cli.js remote-child, /usr/bin/kill -KILL -1',
  'Defaults!MOAG_REMOTE !use_pty, env_reset',
  '<mainuser> ALL=(moag-runner) NOPASSWD: MOAG_REMOTE',
].join('\n');
