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

/** `path`: an existing repository; `clone`: cloned from `url`; `new`: an empty repository the server created. */
export interface ProjectSource { kind: 'path' | 'clone' | 'new'; url?: string; }

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
  const segments = projectPathSegments(rel);

  let rootReal: string;
  try { rootReal = realpath(root); } catch {
    throw new ProjectInputError('root-missing', 'The projects root does not exist on the server.', 500);
  }
  let real: string;
  try { real = realpath(path.resolve(rootReal, ...segments)); } catch {
    throw new ProjectInputError('path-not-found', 'That folder does not exist under the projects root.');
  }
  if (!strictlyInside(rootReal, real)) {
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

/**
 * The segments of a workspace path given RELATIVE to the projects root, checked by text
 * alone: a non-empty relative path, no drive letter, no `..`, not the root itself. Every
 * way a project folder is named — an existing one or a new one — goes through here.
 */
function projectPathSegments(rel: unknown): string[] {
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
  // A drive letter part-way (`foo/Q:x`) makes path.resolve jump to that drive, and any other
  // colon is an NTFS alternate data stream (`foo:bar`): no folder name may contain one.
  if (segments.some((s) => s.includes(':'))) {
    throw new ProjectInputError('invalid-path', 'Folder names must not contain ":".');
  }
  if (segments.every((s) => s === '.')) {
    throw new ProjectInputError('invalid-path', 'Path must name a folder inside the projects root, not the root itself.');
  }
  // Windows strips a trailing dot or space from a name everywhere except `\\?\` paths, so
  // `...`, `.. ` or `a.` would be created literally by mkdir but reached by git and a spawn's
  // cwd as `..`, the parent, or a different folder. Device names and the reserved characters
  // are refused for the same reason: the name the server checks must be the name every tool opens.
  for (const s of segments) {
    const why = invalidSegmentReason(s);
    if (why) { throw new ProjectInputError('invalid-path', why); }
  }
  return segments;
}

/** Windows device names, alone or with any extension (`CON`, `nul.txt`, `COM1`). */
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i;
/** Characters Windows does not allow in a file name, and control characters. */
// eslint-disable-next-line no-control-regex
const RESERVED_CHAR_RE = /[<>"|?*\x00-\x1f]/;

/**
 * Why one folder name is refused, or null when it is accepted. A lone `.` is left to the
 * caller (`path.resolve` drops it); `..` and any other run of dots, a leading space, a
 * trailing dot or space, a device name, and the reserved characters are refused everywhere,
 * so a path accepted on one server is accepted on every other.
 */
function invalidSegmentReason(s: string): string | null {
  if (s === '.') { return null; }
  if (s === '..') { return 'Path must not contain "..".'; }
  if (/^\.+$/.test(s)) { return 'A folder name cannot be only dots.'; }
  if (/^\s/.test(s) || /[\s.]$/.test(s)) { return 'A folder name cannot start with a space, or end with a space or a dot.'; }
  if (RESERVED_CHAR_RE.test(s)) { return 'A folder name cannot contain < > " | ? * or control characters.'; }
  if (RESERVED_DEVICE_RE.test(s)) { return `"${s}" is a reserved device name on Windows.`; }
  return null;
}

/** True when `real` (a realpath) is strictly inside `rootReal`. */
function strictlyInside(rootReal: string, real: string): boolean {
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return norm(real).startsWith(norm(prefix));
}

// ─── New empty repository ───

/** The identity the server commits a new project's first, empty commit as. */
export const NEW_REPO_IDENTITY = { name: 'MOAG server', email: 'moag-server@moag.invalid' } as const;
/** The message of that commit. */
export const NEW_REPO_COMMIT_MESSAGE = 'Initial empty commit (created by MOAG)';
const NEW_REPO_GIT_TIMEOUT_MS = 30_000;

/** Who already owns a workspace path: a project that has it, or one it is nested with. */
export interface WorkspaceOwners {
  isWorkspaceRegistered(workspacePath: string): boolean;
  nestedWorkspaceOwner(workspacePath: string): ProjectRecord | undefined;
}

/**
 * Create a new, empty git repository at `rel` under the projects root and return its
 * realpath. The path is held to the same rules as {@link resolveProjectPath}: relative, no
 * `..`, not the root, and nothing on the way (an existing parent folder or a symlink) may
 * lead outside the root. A folder that already exists is used only when it is empty; one
 * with anything in it is refused (409 `dest-not-empty`), as is one another project owns or
 * is nested with. Then `git init` and one empty commit made as {@link NEW_REPO_IDENTITY},
 * with hooks and signing off, so the project has a HEAD for its first run to diff against.
 *
 * On any failure nothing it made is left behind, and nothing it did not make is touched: the
 * folder is removed only if this call created it, a parent it created only while that parent is
 * empty, and in a folder that was already there only a `.git` its own `git init` made. Callers
 * serialize it per projects root ({@link withNewRepoLock}, as {@link intakeProject} does).
 * Git missing on the server is `git-missing` (500); git failing is `init-failed` (502).
 */
export async function createEmptyRepo(rel: unknown, owners: WorkspaceOwners, deps: CloneDeps): Promise<string> {
  const { rootReal, dest, firstNew, refuseOwned } = planNewRepo(deps.projectsRoot, rel, owners);

  // What this call provably created, so an undo removes only that: the outermost parent
  // `mkdir -p` made (it returns it), and the folder itself when its own mkdir succeeded.
  let madeParent: string | undefined;
  let madeDest = false;
  /** Remove the folder only if this call made it, then each parent it made, and only while empty. */
  const removeCreated = (): void => {
    if (madeDest) { fs.rmSync(dest, { recursive: true, force: true }); }
    if (madeParent === undefined) { return; }
    for (let dir = path.dirname(dest); ; dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { return; } // not empty: another request's work is in it
      if (norm(dir) === norm(madeParent) || path.dirname(dir) === dir) { return; }
    }
  };
  if (firstNew !== null) {
    try {
      madeParent = fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      // Non-recursive for the folder itself: a concurrent request for the same name gets EEXIST.
      fs.mkdirSync(dest, { mode: 0o700 });
      madeDest = true;
    } catch (err) {
      removeCreated();
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ProjectInputError('dest-not-empty', 'A folder with that name was just created by another request.', 409);
      }
      throw new ProjectInputError('invalid-path', `That folder could not be created: ${(err as Error).message}`);
    }
  }
  // In a folder that was already there (checked empty under the intake lock), only a `.git`
  // this call's `git init` made is removed: never one that was there before it ran.
  const hadGit = fs.existsSync(path.join(dest, '.git'));
  const undo = (): void => {
    if (firstNew !== null) { removeCreated(); return; }
    if (!hadGit) { fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true }); }
  };
  let real: string;
  try {
    real = realpath(dest);
    if (!strictlyInside(rootReal, real)) { throw new ProjectInputError('path-escape', 'That folder resolves outside the projects root.'); }
    refuseOwned(real);
  } catch (err) {
    undo();
    throw err;
  }

  const exec = deps.exec ?? execFileAsync;
  const env = cloneEnv(deps.serverEnv, false);
  const git = (args: string[]): Promise<ExecFileAsyncResult> => exec('git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', real, ...args],
    { cwd: real, env, timeoutMs: NEW_REPO_GIT_TIMEOUT_MS });
  try {
    const init = await git(['-c', 'init.defaultBranch=main', 'init', '-q']);
    if (init.exitCode !== 0) { throw initFailed(init); }
    // Defence in depth: the repository git made must be this folder, not the root or a parent
    // that git reached through a name the OS normalises differently from the checks above.
    const top = await git(['rev-parse', '--show-toplevel']);
    let topReal: string | null = null;
    try { topReal = top.exitCode === 0 && top.stdout.trim() !== '' ? realpath(top.stdout.trim()) : null; } catch { topReal = null; }
    if (topReal === null || norm(topReal) !== norm(real)) {
      throw new ProjectInputError('path-escape', 'git did not create the repository in the named folder, so the project was not registered.');
    }
    const commit = await git([
      '-c', `user.name=${NEW_REPO_IDENTITY.name}`, '-c', `user.email=${NEW_REPO_IDENTITY.email}`, '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-q', '-m', NEW_REPO_COMMIT_MESSAGE,
    ]);
    if (commit.exitCode !== 0) { throw initFailed(commit); }
  } catch (err) {
    undo();
    if (err instanceof ProjectInputError) { throw err; }
    throw new ProjectInputError('git-missing', `git could not be run on the server: ${(err as Error).message}`, 500);
  }
  return real;
}

/** Where a new project's folder would go, and whether it exists yet. See {@link planNewRepo}. */
export interface NewRepoPlan {
  rootReal: string;
  /** The folder, resolved against the root's realpath (not itself a realpath: it may not exist). */
  dest: string;
  /** The outermost folder on the way that does not exist yet (the folder itself, or a parent); null when it exists. */
  firstNew: string | null;
  /** What `dest` will resolve to once created: the realpath of its nearest existing folder plus the rest. */
  predicted: string;
  /** Throws the 409 for a path another project owns or is nested with. */
  refuseOwned: (p: string) => void;
}

/**
 * Every check {@link createEmptyRepo} makes before it touches the disk, with nothing created:
 * the path rules of {@link resolveProjectPath}, a nearest existing folder that resolves inside
 * the root, no other project's workspace, and an existing folder only when it is an empty one.
 * Throws the same {@link ProjectInputError} the create would. The new-project form's folder
 * check asks this too, so the two can never disagree.
 */
export function planNewRepo(root: string, rel: unknown, owners: WorkspaceOwners): NewRepoPlan {
  const segments = projectPathSegments(rel);
  let rootReal: string;
  try { rootReal = realpath(root); } catch {
    throw new ProjectInputError('root-missing', 'The projects root does not exist on the server.', 500);
  }
  const dest = path.resolve(rootReal, ...segments);
  // The nearest folder on the way that exists already decides where the new one really goes.
  let existing = dest;
  let firstNew: string | null = null;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    // Defence in depth: a filesystem root that does not exist (a missing drive) never ends the walk.
    if (parent === existing) { throw new ProjectInputError('invalid-path', 'That folder could not be resolved.'); }
    firstNew = existing;
    existing = parent;
  }
  let existingReal: string;
  try { existingReal = realpath(existing); } catch {
    throw new ProjectInputError('invalid-path', 'That folder could not be resolved.');
  }
  if (norm(existingReal) !== norm(rootReal) && !strictlyInside(rootReal, existingReal)) {
    throw new ProjectInputError('path-escape', 'That folder resolves outside the projects root.');
  }
  if (firstNew === null && norm(existingReal) === norm(rootReal)) {
    throw new ProjectInputError('invalid-path', 'Path must name a folder inside the projects root, not the root itself.');
  }
  const predicted = firstNew === null ? existingReal : path.join(existingReal, path.relative(existing, dest));
  const refuseOwned = (p: string): void => {
    if (owners.isWorkspaceRegistered(p)) {
      throw new ProjectInputError('workspace-registered', 'That workspace already belongs to a project.', 409);
    }
    if (owners.nestedWorkspaceOwner(p)) { throw new ProjectInputError('workspace-nested', NESTED_WORKSPACE_MESSAGE, 409); }
  };
  refuseOwned(predicted);

  if (firstNew === null) {
    if (!fs.statSync(dest).isDirectory()) { throw new ProjectInputError('not-a-directory', 'That path is not a folder.'); }
    if (fs.readdirSync(dest).length > 0) {
      throw new ProjectInputError('dest-not-empty',
        'That folder already exists and is not empty. Choose a new folder name, or add the existing folder as a repository.', 409);
    }
  }
  return { rootReal, dest, firstNew, predicted, refuseOwned };
}

/** The error for a `git init` or first commit that exited non-zero. */
function initFailed(r: ExecFileAsyncResult): ProjectInputError {
  const why = r.timedOut ? 'timed out' : (r.stderr.trim().split('\n').pop() ?? 'failed');
  return new ProjectInputError('init-failed', `The new repository could not be created: ${why.slice(0, 300)}`, 502);
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

/**
 * The commit `dir`'s work tree is based on, or null when there is none: not a
 * repository, git failed, or the repository has no commits yet. A run records
 * it at start as the base its standards check diffs against.
 */
export async function gitHead(dir: string, exec: ExecFn = execFileAsync): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 30_000 });
    const head = r.stdout.trim();
    return r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(head) ? head : null;
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
 * Repository entries an engine (or MOAG itself) loads as configuration or
 * standing instructions when it runs with cwd = the workspace: hooks, MCP
 * servers and tool grants (`.claude`, `.mcp.json`, `.gemini`, `.codex`), agent
 * instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules`) and
 * MOAG's workspace AI rules file (`.moag/rules.json`). A hosted run does NOT
 * inject that file — the server worker never builds an AI rules store, and its
 * task prompts carry only the approved project standards — but a local
 * `moag run` or VS Code session in the same checkout does, so the reviewer is
 * still told it is there. Plan generation never runs in the workspace; an
 * approved run does. Paths are relative to the workspace root, `/`-separated.
 */
export const REPO_ENGINE_CONFIG_ENTRIES = [
  '.claude', '.mcp.json', '.gemini', '.codex',
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
  '.moag/rules.json', '.cursor/rules',
] as const;

/** The engine-config entries present in `dir` (empty when none or unreadable). */
export function detectRepoEngineConfig(dir: string): string[] {
  return REPO_ENGINE_CONFIG_ENTRIES.filter((name) => {
    try { fs.lstatSync(path.join(dir, ...name.split('/'))); return true; } catch { return false; }
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

/** The tail of each projects root's new-repository queue (see {@link withNewRepoLock}). */
const newRepoLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` once every earlier new-repository intake under the same projects root has
 * settled. Exported for tests. A failure in one call never blocks the next.
 */
export async function withNewRepoLock<T>(projectsRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = norm(path.resolve(projectsRoot));
  const prev = newRepoLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  newRepoLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (newRepoLocks.get(key) === tail) { newRepoLocks.delete(key); }
  }
}

export interface ProjectIntakeInput {
  name: string;
  /** `new`: create an empty repository at `path` under the projects root (see {@link createEmptyRepo}). */
  source: { kind: 'path'; path: string } | { kind: 'clone'; url: string; dirName: string } | { kind: 'new'; path: string };
  stack: StackId;
  defaultEngine: EngineId;
  versionBudgetUsd?: number;
}

/**
 * Resolve, clone or create the workspace, require a git repo, then register the
 * project. Nothing is registered unless every step succeeds; a failed clone or
 * a failed new repository leaves neither a record nor a folder.
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
  } else if (input.source.kind === 'new') {
    // Planning, creating and registering a new folder is one step per projects root, so two
    // requests for the same (or a nested) name can never undo each other's folder or repository.
    const newPath = input.source.path;
    return withNewRepoLock(deps.projectsRoot, async () => {
      const created = await createEmptyRepo(newPath, store, deps);
      return store.create({
        name: input.name,
        workspacePath: created,
        source: { kind: 'new' },
        stack: input.stack,
        defaultEngine: input.defaultEngine,
        versionBudgetUsd: input.versionBudgetUsd ?? DEFAULT_VERSION_BUDGET_USD,
        createdBy,
      });
    });
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
