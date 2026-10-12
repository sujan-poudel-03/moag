// ─── Remote runs: code in, branches out (daemon side) ───
//
// The daemon (main user) is the only process that touches the user's project
// repository on behalf of a remote run, and it only ever does three things there:
//
//   in   `git bundle create - HEAD [refs/heads/<continue>] --not <shas the runner's
//        mirror already has>` — the project's code as a (thin) bundle for the child;
//   out  `git bundle verify <file>` then a fast-forward-only fetch of exactly
//        refs/heads/<branch> from the child's bundle into the project;
//   check  rev-parse / cat-file to resolve shas.
//
// Every call runs with cwd = the project path (never a runner path), hooks off
// (`core.hooksPath=/dev/null`) and fsmonitor off; the import also has
// `transfer.fsckObjects=true`. The refspec has no `+`: a branch that would not
// fast-forward is refused, never forced. Imports nothing that loads `vscode`.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { killProcess } from '../utils/process-kill';

/** Runs git with cwd = the project; resolves raw stdout, or null on failure. */
export type BranchGit = (args: string[], cwd: string) => Promise<Buffer | null>;

/** Flags on every git call this module makes in the user's project. */
export const SAFE_GIT_FLAGS: readonly string[] = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
/** Extra flag on the import fetch: reject malformed objects in the child's bundle. */
export const IMPORT_FSCK_FLAGS: readonly string[] = Object.freeze(['-c', 'transfer.fsckObjects=true']);

/** Largest bundle accepted from a child. */
export const MAX_IMPORT_BUNDLE_BYTES = 64 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const GIT_TIMEOUT_MS = 10 * 60_000;

/** True when `branch` is a safe ref name under `prefix`. */
export function isRunBranch(branch: string, prefix: string): boolean {
  return BRANCH.test(branch) && prefix.length > 0 && branch.startsWith(prefix) && !branch.includes('..')
    && !branch.endsWith('/') && !branch.endsWith('.lock') && !branch.includes('//');
}

function run(git: BranchGit, projectPath: string, args: string[], extra: readonly string[] = []): Promise<Buffer | null> {
  return git([...SAFE_GIT_FLAGS, ...extra, ...args], projectPath);
}

async function revParse(git: BranchGit, projectPath: string, rev: string): Promise<string | null> {
  const out = await run(git, projectPath, ['rev-parse', '--verify', '--quiet', rev]);
  const sha = out ? out.toString('utf-8').trim() : '';
  return SHA.test(sha) ? sha : null;
}

export type InboundBundle =
  | { ok: true; baseSha: string; startSha: string; bundle: Buffer }
  | { ok: false; reason: string };

/**
 * The project's code for a remote run: HEAD (and the branch being continued), minus
 * whatever the runner's mirror already has (`haveShas`, each checked to exist here).
 * An empty bundle means the mirror already has everything the run needs.
 */
export async function exportInboundBundle(
  projectPath: string,
  opts: { continueBranch?: string; startSha?: string; haveShas: readonly string[] },
  git: BranchGit,
): Promise<InboundBundle> {
  const baseSha = await revParse(git, projectPath, 'HEAD^{commit}');
  if (!baseSha) { return { ok: false, reason: 'The project has no commits yet, so there is nothing to run on.' }; }
  let startSha = baseSha;
  const refs = ['HEAD'];
  if (opts.continueBranch !== undefined) {
    if (!BRANCH.test(opts.continueBranch) || opts.continueBranch.includes('..')) { return { ok: false, reason: 'The branch to continue is not a valid branch name.' }; }
    const tip = await revParse(git, projectPath, `refs/heads/${opts.continueBranch}^{commit}`);
    if (!tip) { return { ok: false, reason: `The branch ${opts.continueBranch} does not exist in the project on this PC.` }; }
    startSha = tip;
    refs.push(`refs/heads/${opts.continueBranch}`);
  } else if (opts.startSha !== undefined) {
    // A fresh branch from an earlier run's start point (its own branch never reached the
    // project). The runner's mirror already has that commit; the child checks it does.
    if (!SHA.test(opts.startSha)) { return { ok: false, reason: 'The run to continue has no valid start point.' }; }
    startSha = opts.startSha;
  }
  const have: string[] = [];
  for (const sha of opts.haveShas) {
    if (!SHA.test(sha)) { continue; }
    if ((await run(git, projectPath, ['cat-file', '-e', `${sha}^{commit}`])) !== null) { have.push(sha); }
  }
  const bundle = await run(git, projectPath, ['bundle', 'create', '-', ...refs, ...(have.length > 0 ? ['--not', ...have] : [])]);
  if (bundle === null || bundle.length === 0) {
    // Git refuses an empty bundle: with a mirror that already has everything, that is fine.
    if (have.length > 0) { return { ok: true, baseSha, startSha, bundle: Buffer.alloc(0) }; }
    return { ok: false, reason: 'The project\'s code could not be packaged for the run.' };
  }
  return { ok: true, baseSha, startSha, bundle };
}

/**
 * Bring a run's branch from the child's bundle into the project: the branch must be
 * under `prefix`, the bundle must verify, and the update must fast-forward.
 */
export async function importRunBranch(
  projectPath: string,
  bundleFile: string,
  branch: string,
  prefix: string,
  git: BranchGit,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isRunBranch(branch, prefix)) { return { ok: false, reason: `The run's branch ${branch.slice(0, 80)} is not one of MOAG's branches (${prefix}…) and was not imported.` }; }
  if ((await run(git, projectPath, ['bundle', 'verify', bundleFile])) === null) {
    return { ok: false, reason: 'The run\'s commits did not verify against the project and were not imported.' };
  }
  const fetched = await run(git, projectPath, [
    'fetch', '--no-write-fetch-head', '--no-recurse-submodules', '--no-tags', bundleFile, `refs/heads/${branch}:refs/heads/${branch}`,
  ], IMPORT_FSCK_FLAGS);
  if (fetched === null) {
    return { ok: false, reason: `The branch ${branch} could not be updated in the project: it would not fast-forward, or it is checked out there.` };
  }
  return { ok: true };
}

// ─── Assembling the child's outbound bundle ───

/** Collects `remote-bundle-chunk` lines and checks them against `remote-bundle-end`. */
export class BundleAssembler {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflow = false;

  constructor(private readonly maxBytes: number = MAX_IMPORT_BUNDLE_BYTES) {}

  /** Add one base64 chunk. False once the bundle is too large (everything is then dropped). */
  addChunk(b64: unknown): boolean {
    if (this.overflow || typeof b64 !== 'string') { this.overflow = this.overflow || typeof b64 !== 'string'; return false; }
    const buf = Buffer.from(b64, 'base64');
    if (this.size + buf.length > this.maxBytes) {
      this.overflow = true;
      this.chunks = [];
      return false;
    }
    this.chunks.push(buf);
    this.size += buf.length;
    return true;
  }

  /** Check the end line. `data` is null when the child sent no commits. */
  finish(end: { bytes?: unknown; sha256?: unknown; error?: unknown }): { ok: true; data: Buffer | null } | { ok: false; reason: string } {
    if (typeof end.error === 'string') { return { ok: false, reason: end.error.slice(0, 300) }; }
    if (this.overflow) { return { ok: false, reason: 'The run\'s commits were larger than 64 MB and were not imported.' }; }
    if (end.bytes === 0 && this.size === 0) { return { ok: true, data: null }; }
    const data = Buffer.concat(this.chunks);
    if (end.bytes !== data.length) { return { ok: false, reason: 'The run\'s commits arrived incomplete and were not imported.' }; }
    if (typeof end.sha256 !== 'string' || createHash('sha256').update(data).digest('hex') !== end.sha256) {
      return { ok: false, reason: 'The run\'s commits arrived damaged and were not imported.' };
    }
    return { ok: true, data };
  }
}

/** Write a received bundle to `file` (0600). */
export function writeBundleFile(file: string, data: Buffer): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
}

/** The real {@link BranchGit}: spawn git, collect raw stdout (bounded), time out after 10 minutes. */
export const spawnBranchGit: BranchGit = (args, cwd) => new Promise((resolve) => {
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch {
    resolve(null);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const finish = (v: Buffer | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
  const timer = setTimeout(() => { killProcess(proc); finish(null); }, GIT_TIMEOUT_MS);
  proc.stdout?.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_IMPORT_BUNDLE_BYTES + 1024) { killProcess(proc); finish(null); return; }
    chunks.push(c);
  });
  proc.stderr?.on('data', () => undefined);
  proc.on('error', () => finish(null));
  proc.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : null));
});

/** The project's tip of `refs/heads/<branch>`, or null when the branch is not there. */
export async function projectBranchTip(projectPath: string, branch: string, git: BranchGit): Promise<string | null> {
  if (!BRANCH.test(branch) || branch.includes('..')) { return null; }
  return revParse(git, projectPath, `refs/heads/${branch}^{commit}`);
}

/** True when `refs/heads/<branch>` exists in the project. */
export async function projectHasBranch(projectPath: string, branch: string, git: BranchGit): Promise<boolean> {
  return (await projectBranchTip(projectPath, branch, git)) !== null;
}
