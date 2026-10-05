// ─── Project registry and repo intake ───
//
// A project binds one git workspace under the configured projects root to its
// server-side settings. Workspace paths are confined to the root by realpath
// (so neither `..` nor a symlink can escape it), clone URLs are allowlisted by
// scheme, and git runs through `execFileAsync` with array args and no shell.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { writeFileAtomicSync } from '../utils/file-io';
import { execFileAsync, ExecFileAsyncOptions, ExecFileAsyncResult } from '../utils/exec-file';
import { EngineId } from '../models/types';
import { StackId } from './stacks';

export const PROJECTS_FILE = 'projects.json';
export const DEFAULT_VERSION_BUDGET_USD = 10;
export const MAX_CLONE_URL_LENGTH = 2048;
export const CLONE_DEST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export interface ProjectSource { kind: 'path' | 'clone'; url?: string; }

export interface ProjectRecord {
  id: string;
  name: string;
  /** Realpath of the workspace — always inside the projects root. */
  workspacePath: string;
  source: ProjectSource;
  stack: StackId;
  defaultEngine: EngineId;
  /** Per-PRD-version cost cap in USD; 0 means "no cap set". */
  versionBudgetUsd: number;
  createdAt: string;
  createdBy: string;
}

interface ProjectsFile { schemaVersion: 1; projects: ProjectRecord[]; }

/** A rejected project input. `code` is stable; the app maps it to 400/409. */
export class ProjectInputError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number = 400) {
    super(message);
    this.name = 'ProjectInputError';
  }
}

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

function realpath(p: string): string {
  return fs.realpathSync.native(p);
}

// ─── Store ───

export class ProjectStore {
  private readonly filePath: string;
  private projects: ProjectRecord[];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, PROJECTS_FILE);
    this.projects = this.load();
  }

  list(): ProjectRecord[] { return this.projects.map(clone); }

  get(id: string): ProjectRecord | undefined {
    const p = this.projects.find((x) => x.id === id);
    return p ? clone(p) : undefined;
  }

  /** True when a project already owns `workspacePath` (compared as realpath). */
  isWorkspaceRegistered(workspacePath: string): boolean {
    const key = norm(workspacePath);
    return this.projects.some((p) => norm(p.workspacePath) === key);
  }

  /**
   * A registered project whose workspace is an ancestor or a descendant of
   * `workspacePath` (compared as realpath). Two projects must never share files:
   * one project's run would edit, commit or reset the other's tree.
   */
  nestedWorkspaceOwner(workspacePath: string): ProjectRecord | undefined {
    const p = this.projects.find((x) => isPathNested(x.workspacePath, workspacePath));
    return p ? clone(p) : undefined;
  }

  create(input: Omit<ProjectRecord, 'id' | 'createdAt'>, now: Date = new Date()): ProjectRecord {
    if (this.isWorkspaceRegistered(input.workspacePath)) {
      throw new ProjectInputError('workspace-registered', 'That workspace already belongs to a project.', 409);
    }
    if (this.nestedWorkspaceOwner(input.workspacePath)) {
      throw new ProjectInputError('workspace-nested', NESTED_WORKSPACE_MESSAGE, 409);
    }
    const rec: ProjectRecord = { ...clone(input as ProjectRecord), id: randomUUID(), createdAt: now.toISOString() };
    this.projects.push(rec);
    this.save();
    return clone(rec);
  }

  /** Update mutable settings. Workspace and source are fixed after creation. */
  update(id: string, patch: Partial<Pick<ProjectRecord, 'name' | 'stack' | 'defaultEngine' | 'versionBudgetUsd'>>): ProjectRecord {
    const p = this.projects.find((x) => x.id === id);
    if (!p) { throw new ProjectInputError('not-found', 'Project not found.', 404); }
    if (patch.name !== undefined) { p.name = patch.name; }
    if (patch.stack !== undefined) { p.stack = patch.stack; }
    if (patch.defaultEngine !== undefined) { p.defaultEngine = patch.defaultEngine; }
    if (patch.versionBudgetUsd !== undefined) { p.versionBudgetUsd = patch.versionBudgetUsd; }
    this.save();
    return clone(p);
  }

  private load(): ProjectRecord[] {
    let raw: string;
    try { raw = fs.readFileSync(this.filePath, 'utf-8'); } catch { return []; }
    const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects)) {
      throw new Error(`${PROJECTS_FILE} has an unsupported format (expected schemaVersion 1).`);
    }
    return parsed.projects;
  }

  private save(): void {
    writeFileAtomicSync(this.filePath, JSON.stringify({ schemaVersion: 1, projects: this.projects }, null, 2), 0o600);
  }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

const NESTED_WORKSPACE_MESSAGE = 'That folder is inside another project\'s workspace, or contains one. Projects cannot share files.';

/** True when `a` is a strict ancestor or strict descendant of `b` (both realpaths). */
export function isPathNested(a: string, b: string): boolean {
  const withSep = (p: string): string => norm(p.endsWith(path.sep) ? p : p + path.sep);
  const na = withSep(a);
  const nb = withSep(b);
  return na !== nb && (na.startsWith(nb) || nb.startsWith(na));
}

// ─── Path confinement ───

/**
 * Resolve a workspace given RELATIVE to the projects root. Rejects absolute
 * paths, any `..` segment, the root itself, non-directories, anything whose
 * realpath leaves the root (symlink escape), and workspaces already registered.
 * Returns the realpath.
 */
export function resolveProjectPath(root: string, rel: unknown, isRegistered: (p: string) => boolean = () => false): string {
  if (typeof rel !== 'string' || rel.trim() === '' || rel.length > 1024 || rel.includes('\0')) {
    throw new ProjectInputError('invalid-path', 'Path must be a non-empty relative path.');
  }
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new ProjectInputError('invalid-path', 'Path must be relative to the projects root.');
  }
  const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    throw new ProjectInputError('invalid-path', 'Path must not contain "..".');
  }
  if (segments.every((s) => s === '.')) {
    throw new ProjectInputError('invalid-path', 'Path must name a folder inside the projects root, not the root itself.');
  }

  let rootReal: string;
  try { rootReal = realpath(root); } catch {
    throw new ProjectInputError('root-missing', 'The projects root does not exist on the server.', 500);
  }
  let real: string;
  try { real = realpath(path.resolve(rootReal, ...segments)); } catch {
    throw new ProjectInputError('path-not-found', 'That folder does not exist under the projects root.');
  }
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (!norm(real).startsWith(norm(prefix))) {
    throw new ProjectInputError('path-escape', 'That folder resolves outside the projects root.');
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new ProjectInputError('not-a-directory', 'That path is not a folder.');
  }
  if (isRegistered(real)) {
    throw new ProjectInputError('workspace-registered', 'That workspace already belongs to a project.', 409);
  }
  return real;
}

// ─── Clone URLs ───

/** Validate a clone URL: https (or ssh when allowed), a host, no password, ≤ 2048 chars. */
export function validateCloneUrl(url: unknown, opts: { allowSsh: boolean }): string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_CLONE_URL_LENGTH) {
    throw new ProjectInputError('invalid-url', `Clone URL must be 1-${MAX_CLONE_URL_LENGTH} characters.`);
  }
  if (url.startsWith('-') || /[\s\0]/.test(url)) {
    throw new ProjectInputError('invalid-url', 'Clone URL is not valid.');
  }
  let u: URL;
  try { u = new URL(url); } catch {
    throw new ProjectInputError('invalid-url', 'Clone URL is not a valid URL.');
  }
  const allowed = opts.allowSsh ? ['https:', 'ssh:'] : ['https:'];
  if (!allowed.includes(u.protocol)) {
    throw new ProjectInputError('invalid-url-scheme', `Clone URL must use ${opts.allowSsh ? 'https or ssh' : 'https'}.`);
  }
  if (!u.hostname) { throw new ProjectInputError('invalid-url', 'Clone URL must include a host.'); }
  if (u.password) {
    throw new ProjectInputError('invalid-url', 'Clone URL must not contain a password. Configure credentials on the server instead.');
  }
  return url;
}

/**
 * The URL with any userinfo removed. A username slot can carry an access token
 * (`https://<token>@host/...`), so the stored/displayed form never includes it.
 */
export function redactUrlUserinfo(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) { return url; }
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '';
  }
}

// ─── git ───

export type ExecFn = (cmd: string, args: string[], opts?: ExecFileAsyncOptions) => Promise<ExecFileAsyncResult>;

export interface CloneDeps {
  projectsRoot: string;
  allowSsh: boolean;
  /** The server's env; only PATH/HOME (and Windows essentials) are passed to git. */
  serverEnv: NodeJS.ProcessEnv;
  exec?: ExecFn;
}

/** The minimal env git gets for a clone. */
export function cloneEnv(serverEnv: NodeJS.ProcessEnv, allowSsh: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: allowSsh ? 'https:ssh' : 'https',
  };
  for (const k of ['PATH', 'HOME']) {
    if (serverEnv[k] !== undefined) { env[k] = serverEnv[k]; }
  }
  if (process.platform === 'win32') {
    // git for Windows cannot resolve hosts or find its config without these.
    for (const k of ['Path', 'SystemRoot', 'USERPROFILE']) {
      if (serverEnv[k] !== undefined) { env[k] = serverEnv[k]; }
    }
  }
  return env;
}

/**
 * Clone `url` into `<projectsRoot>/<destName>`. The URL is validated, passed
 * after `--` as a single argv element, with file/ext transports disabled and no
 * submodules. On any failure the partial destination is removed and the error
 * rethrown. Returns the realpath of the clone.
 */
export async function cloneRepo(url: unknown, destName: unknown, deps: CloneDeps): Promise<string> {
  const safeUrl = validateCloneUrl(url, { allowSsh: deps.allowSsh });
  if (typeof destName !== 'string' || !CLONE_DEST_RE.test(destName) || destName === '.' || destName === '..') {
    throw new ProjectInputError('invalid-dest', 'Folder name must be 1-64 characters: letters, digits, ".", "_" or "-".');
  }
  const rootReal = realpath(deps.projectsRoot);
  const dest = path.join(rootReal, destName);
  // Reserve the destination atomically: a non-recursive mkdir fails with EEXIST
  // if the folder (or a concurrent clone's reservation) is already there, so
  // two requests can never clone into, or later remove, the same folder. From
  // here on `dest` is this call's own, empty directory (git clones into it).
  try {
    fs.mkdirSync(dest, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ProjectInputError('dest-exists', 'A folder with that name already exists under the projects root.', 409);
    }
    throw new ProjectInputError('clone-failed', `The destination folder could not be created: ${(err as Error).message}`, 500);
  }
  const exec = deps.exec ?? execFileAsync;
  const args = [
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    'clone', '--no-recurse-submodules', '--', safeUrl, dest,
  ];
  let result: ExecFileAsyncResult;
  try {
    result = await exec('git', args, { cwd: rootReal, env: cloneEnv(deps.serverEnv, deps.allowSsh), timeoutMs: CLONE_TIMEOUT_MS });
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new ProjectInputError('clone-failed', `git could not be run: ${(err as Error).message}`, 502);
  }
  if (result.exitCode !== 0) {
    fs.rmSync(dest, { recursive: true, force: true });
    const why = result.timedOut ? 'timed out' : (result.stderr.trim().split('\n').pop() ?? 'failed');
    throw new ProjectInputError('clone-failed', `Clone failed: ${why.slice(0, 300)}`, 502);
  }
  return realpath(dest);
}

/** True when `dir` is inside a git work tree. */
export async function isGitRepo(dir: string, exec: ExecFn = execFileAsync): Promise<boolean> {
  try {
    const r = await exec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 30_000 });
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * The realpath of the top level of the git work tree containing `dir`, or null
 * when `dir` is not in one (or git fails). Git prints forward slashes on
 * Windows; realpath normalizes them so the result compares with a realpath.
 */
export async function gitTopLevel(dir: string, exec: ExecFn = execFileAsync): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 30_000 });
    const top = r.stdout.trim();
    if (r.exitCode !== 0 || top === '') { return null; }
    return realpath(top);
  } catch {
    return null;
  }
}

// ─── Planning context (no repo code runs) ───

/** Most paths the planning prompt's repository listing carries. */
export const REPO_LISTING_MAX_PATHS = 2000;
/** Character cap of that listing (long paths cannot blow up the prompt). */
export const REPO_LISTING_MAX_CHARS = 100_000;

/**
 * Repository entries an engine CLI loads as its own configuration when it runs
 * with cwd = the workspace (hooks, MCP servers, tool grants). Plan generation
 * never runs there; an approved run does.
 */
export const REPO_ENGINE_CONFIG_ENTRIES = ['.claude', '.mcp.json', '.gemini'] as const;

/** The engine-config entries present at the top of `dir` (empty when none or unreadable). */
export function detectRepoEngineConfig(dir: string): string[] {
  return REPO_ENGINE_CONFIG_ENTRIES.filter((name) => {
    try { fs.lstatSync(path.join(dir, name)); return true; } catch { return false; }
  });
}

/**
 * The planning prompt's view of the repository: the first
 * {@link REPO_LISTING_MAX_PATHS} tracked paths (`git ls-files`, array args, no
 * shell, fsmonitor forced off so a repo-local `.git/config` cannot run a hook),
 * as plain text. Nothing in the repository is executed or loaded as config.
 * When git fails the text says the listing is unavailable.
 */
export async function buildRepoListing(dir: string, exec: ExecFn = execFileAsync, maxPaths = REPO_LISTING_MAX_PATHS): Promise<string> {
  const header = 'Repository files (tracked paths only; the repository itself is NOT available in this session — plan from this listing and the PRD):';
  let paths: string[] = [];
  try {
    const r = await exec('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'ls-files', '-z'], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) { return `${header}\n(listing unavailable)`; }
    paths = r.stdout.split('\0').map((p) => p.trim()).filter((p) => p.length > 0);
  } catch {
    return `${header}\n(listing unavailable)`;
  }
  const shown: string[] = [];
  let chars = 0;
  for (const p of paths) {
    if (shown.length >= maxPaths || chars + p.length + 1 > REPO_LISTING_MAX_CHARS) { break; }
    shown.push(p);
    chars += p.length + 1;
  }
  const more = paths.length - shown.length;
  return [header, ...shown, ...(more > 0 ? [`… and ${more} more file(s) not listed`] : [])].join('\n');
}

// ─── Intake ───

export interface ProjectIntakeInput {
  name: string;
  source: { kind: 'path'; path: string } | { kind: 'clone'; url: string; dirName: string };
  stack: StackId;
  defaultEngine: EngineId;
  versionBudgetUsd?: number;
}

/**
 * Resolve or clone the workspace, require a git repo, then register the
 * project. Nothing is registered unless every step succeeds; a failed clone
 * leaves neither a record nor a folder.
 */
export async function intakeProject(
  store: ProjectStore,
  input: ProjectIntakeInput,
  createdBy: string,
  deps: CloneDeps,
): Promise<ProjectRecord> {
  const exec = deps.exec ?? execFileAsync;
  let workspacePath: string;
  let source: ProjectSource;
  if (input.source.kind === 'path') {
    workspacePath = resolveProjectPath(deps.projectsRoot, input.source.path, (p) => store.isWorkspaceRegistered(p));
    source = { kind: 'path' };
    if (store.nestedWorkspaceOwner(workspacePath)) {
      throw new ProjectInputError('workspace-nested', NESTED_WORKSPACE_MESSAGE, 409);
    }
    // The workspace must BE a repository's top level: a subfolder of a repo
    // would let a run's git operations reach files outside the workspace.
    const top = await gitTopLevel(workspacePath, exec);
    if (top === null) {
      throw new ProjectInputError('not-a-git-repo', 'That folder is not a git repository.');
    }
    if (norm(top) !== norm(workspacePath)) {
      throw new ProjectInputError('not-repo-root', 'That folder is inside a git repository but is not its top-level folder. Choose the repository root.');
    }
  } else {
    workspacePath = await cloneRepo(input.source.url, input.source.dirName, deps);
    source = { kind: 'clone', url: redactUrlUserinfo(input.source.url) };
  }
  return store.create({
    name: input.name,
    workspacePath,
    source,
    stack: input.stack,
    defaultEngine: input.defaultEngine,
    versionBudgetUsd: input.versionBudgetUsd ?? DEFAULT_VERSION_BUDGET_USD,
    createdBy,
  });
}
