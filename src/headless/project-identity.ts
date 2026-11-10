/**
 * Project identity for protocol v1.2: a stable, path-free `project_key` for the folder a run
 * starts in, so ONOSOO groups the same repository together across machines, folder names and
 * package renames.
 *
 *   git:<host>/<path>   the `origin` remote, normalised (no scheme, user, password, port, .git)
 *   root:<sha>          no usable origin: the smallest root commit, 40 lower-case hex digits
 *   multi:<sha256>      not a repository, but some immediate subfolders are (up to 20, by name)
 *   absent (null)       anything else, any git failure, or a shallow clone with no usable origin
 *
 * Git is run through `execFile` only (never a shell), with a short timeout, a SIGKILL backstop and
 * an env stripped of anything that would point git at a different repository. Every entry point
 * resolves; none rejects or throws.
 *
 * Free of any `vscode` import (asserted by src/test/unit/server/no-vscode.test.ts).
 */

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types and limits ───

/** One child repository of a `multi:` project. `dir` is the folder name only, never a path. */
export interface RepoIdentity {
  dir: string;
  key: string;
  repo_url?: string;
}

/** The identity of the folder a run starts in. */
export interface ProjectIdentity {
  project_key: string;
  repo_url?: string;
  repos?: RepoIdentity[];
}

/** Timeout of one git call. */
export const IDENTITY_GIT_TIMEOUT_MS = 3_000;
/** Extra grace after the git timeout before the module's own timer gives up on the child. */
export const IDENTITY_GIT_BACKSTOP_MS = 500;
/** How long a run start waits for an identity it does not have cached. */
export const IDENTITY_WAIT_MS = 2_000;
/** How long a resolved identity stays fresh. */
export const IDENTITY_TTL_MS = 600_000;
/** The most child repositories a `multi:` key is built from. */
export const MAX_MULTI_CHILDREN = 20;
/** The most directory entries read when looking for child repositories; reading stops there. */
export const MAX_MULTI_SCAN = 500;
/** The longest `project_key`. */
export const PROJECT_KEY_MAX = 255;
/** The longest `repo_url`. */
export const REPO_URL_MAX = 500;
/** The most output read from one git call. */
export const IDENTITY_GIT_MAX_BUFFER = 1_048_576;

/** Children resolved at once for a `multi:` key. */
const CHILD_CONCURRENCY = 4;

// ─── Remote normalisation (pure) ───

const URL_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git']);
const SSH_SCHEMES = new Set(['ssh', 'git+ssh', 'ssh+git']);

/** Well-known hosts whose SSH aliases name the same repositories. */
const SSH_CANONICAL_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
/** The SSH-over-443 endpoints of those hosts. */
const SSH_ALT_HOSTS: Record<string, string> = { 'ssh.github.com': 'github.com', 'altssh.gitlab.com': 'gitlab.com', 'altssh.bitbucket.org': 'bitbucket.org' };

/**
 * The real host behind an SSH host as people write it: `github.com-personal` (a `Host` alias in
 * ~/.ssh/config, the usual way to use two accounts) and `ssh.github.com` are `github.com`, so every
 * clone of one repository gets one key. Any other host is returned unchanged.
 */
export function canonicalSshHost(host: string): string {
  const h = host.toLowerCase();
  if (SSH_ALT_HOSTS[h]) { return SSH_ALT_HOSTS[h]; }
  for (const base of SSH_CANONICAL_HOSTS) {
    if (h.startsWith(base + '-') && h.length > base.length + 1) { return base; }
  }
  return host;
}

/**
 * Normalise an `origin` URL to a `git:` key and a browsable https URL. Returns null for a local
 * path, an unsupported scheme, or anything that does not parse cleanly. Credentials and ports
 * never reach either field.
 */
export function normaliseRemote(raw: string): { key: string; repoUrl?: string } | null {
  if (typeof raw !== 'string') { return null; }
  const s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || /[\s\x00-\x1f\x7f]/.test(s)) { return null; }

  // Local paths are never an identity.
  if (/^(\/|\.\/|\.\.\/|~|\\\\)/.test(s)) { return null; }
  if (/^[A-Za-z]:/.test(s)) { return null; }
  if (/^file:/i.test(s)) { return null; }
  if (s.includes('::')) { return null; }
  // A query or fragment can carry a token (?private_token=…) and is never part of a repository's identity.
  if (/[?#]/.test(s)) { return null; }

  const split = splitRemote(s);
  if (!split) { return null; }
  const { repoPath } = split;

  if (!/^[A-Za-z0-9._-]+$/.test(split.host)) { return null; }
  // Not a real host name: an empty label, or a label that starts or ends with a hyphen (github.com-).
  if (split.host.split('.').some((label) => label === '' || label.startsWith('-') || label.endsWith('-'))) { return null; }
  // An SSH nickname for a well-known host (github.com-work, ssh.github.com) is that host.
  const host = split.ssh ? canonicalSshHost(split.host) : split.host;
  // A loopback host names this machine, not a repository anyone else can reach.
  if (isLocalHost(host)) { return null; }

  let p = repoPath.replace(/^\/+/, '').replace(/\/+$/, '');
  p = p.replace(/\.git$/i, '').replace(/\/+$/, '');
  // A backslash or an @ in the path is a local path, or credentials parsed in the wrong place.
  if (!p || p.includes('\\') || p.includes('@')) { return null; }
  const segments = p.split('/');
  if (segments.some((seg) => seg === '' || seg === '..')) { return null; }
  // A drive as the first segment (ssh://host/C:/Users/…) is a local Windows path.
  if (/^[A-Za-z]:$/.test(segments[0])) { return null; }

  const key = 'git:' + (host + '/' + p).toLowerCase();
  if (key.length > PROJECT_KEY_MAX) { return null; }
  const repoUrl = 'https://' + host.toLowerCase() + '/' + p;
  return repoUrl.length > REPO_URL_MAX ? { key } : { key, repoUrl };
}

/**
 * Split a remote into host and path. URL form: the authority runs to the first `/`, and any
 * userinfo is stripped up to the last `@` within the authority only; a port must be numeric.
 * Otherwise the scp form `[user@]host:path`. Null when neither parses.
 */
function splitRemote(s: string): { host: string; repoPath: string; ssh: boolean } | null {
  const urlForm = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (!urlForm) {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(s);
    return scp ? { host: scp[1], repoPath: scp[2], ssh: true } : null;
  }
  const scheme = urlForm[1].toLowerCase();
  if (!URL_SCHEMES.has(scheme)) { return null; }
  const rest = s.slice(urlForm[0].length);
  const slash = rest.indexOf('/');
  if (slash < 0) { return null; }
  let authority = rest.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at >= 0) { authority = authority.slice(at + 1); }
  if (authority.startsWith('[')) { return null; }
  const colon = authority.indexOf(':');
  if (colon >= 0) {
    if (!/^\d+$/.test(authority.slice(colon + 1))) { return null; }
    authority = authority.slice(0, colon);
  }
  return { host: authority, repoPath: rest.slice(slash), ssh: SSH_SCHEMES.has(scheme) };
}

/** True for a loopback or unspecified host: localhost, 0.0.0.0, or any 127.x address. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h.startsWith('127.');
}

/** The `multi:` key of a set of child keys: order-independent, lower-case hex SHA-256. */
export function multiKey(keys: readonly string[]): string {
  const sorted = [...keys].sort();
  return 'multi:' + crypto.createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

// ─── Git ───

/** The result of one git call: `ok` is a zero exit within the timeout. */
export interface GitResult {
  ok: boolean;
  stdout: string;
}

/** Runs git in `cwd` with `args`; always resolves. */
export type IdentityGitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

const STRIPPED_GIT_ENV = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
]);

/**
 * The env for identity git calls: the given env minus anything that would point git at another
 * repository or inject config, plus no prompts, no optional locks and a fixed locale.
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` are kept, so `insteadOf` and test isolation apply.
 */
export function identityGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (STRIPPED_GIT_ENV.has(upper) || /^GIT_CONFIG_(KEY|VALUE)_/.test(upper)) { continue; }
    out[k] = v;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_OPTIONAL_LOCKS = '0';
  out.LC_ALL = 'C';
  return out;
}

/** The default git runner: `execFile`, no shell, SIGKILL on timeout, and a module backstop timer. */
function execFileGitRunner(env: NodeJS.ProcessEnv): IdentityGitRunner {
  const gitEnv = identityGitEnv(env);
  return (cwd, args) => new Promise<GitResult>((resolve) => {
    let done = false;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: GitResult): void => {
      if (done) { return; }
      done = true;
      if (backstop) { clearTimeout(backstop); }
      resolve(r);
    };
    let child: cp.ChildProcess | undefined;
    try {
      child = cp.execFile('git', ['--no-pager', ...args], {
        cwd,
        env: gitEnv,
        timeout: IDENTITY_GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: IDENTITY_GIT_MAX_BUFFER,
      }, (err, stdout) => finish({ ok: !err, stdout: typeof stdout === 'string' ? stdout : '' }));
    } catch {
      finish({ ok: false, stdout: '' });
      return;
    }
    if (done) { return; }
    backstop = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, stdout: '' });
    }, IDENTITY_GIT_TIMEOUT_MS + IDENTITY_GIT_BACKSTOP_MS);
    if (typeof backstop === 'object' && backstop && typeof backstop.unref === 'function') { backstop.unref(); }
  });
}

// ─── Resolution ───

/** Options of {@link resolveProjectIdentity}. */
export interface ResolveIdentityOptions {
  /** The env git inherits (default `process.env`); stripped by {@link identityGitEnv}. */
  env?: NodeJS.ProcessEnv;
  /** Replace the git runner (tests). */
  git?: IdentityGitRunner;
}

function identityOf(key: string, repoUrl?: string): ProjectIdentity {
  return repoUrl ? { project_key: key, repo_url: repoUrl } : { project_key: key };
}

/** Resolve one folder as a repository: `'not-repo'` when git says it is not inside one. */
async function resolveRepo(dir: string, git: IdentityGitRunner): Promise<ProjectIdentity | null | 'not-repo'> {
  const rp = await git(dir, ['rev-parse', '--is-inside-work-tree', '--is-shallow-repository']);
  if (!rp.ok) { return 'not-repo'; }
  const lines = rp.stdout.split(/\r?\n/);
  if (lines[0] !== 'true' || (lines[1] !== 'true' && lines[1] !== 'false')) { return null; }
  const shallow = lines[1] === 'true';

  const origin = await git(dir, ['remote', 'get-url', 'origin']);
  if (origin.ok) {
    const n = normaliseRemote(origin.stdout.trim());
    if (n) { return identityOf(n.key, n.repoUrl); }
  }

  // A shallow clone's root is its shallow boundary, not the history's root.
  if (shallow) { return null; }

  const roots = await git(dir, ['rev-list', '--max-parents=0', 'HEAD']);
  if (!roots.ok) { return null; }
  const shas = roots.stdout.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0);
  if (shas.length === 0 || shas.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) { return null; }
  shas.sort();
  return { project_key: 'root:' + shas[0] };
}

/** True when `dir` or any ancestor has a `.git` entry. */
async function hasGitAtOrAbove(dir: string): Promise<boolean> {
  let cur = dir;
  for (;;) {
    if (await entryExists(path.join(cur, '.git'))) { return true; }
    const parent = path.dirname(cur);
    if (parent === cur) { return false; }
    cur = parent;
  }
}

/** True when `p` exists (a symlink counts as itself, never followed). Never rejects. */
async function entryExists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The names of `root`'s real subdirectories (symlinks skipped), from at most MAX_MULTI_SCAN
 * directory entries, sorted by code unit. Reading stops at the cap.
 */
async function scanSubdirs(root: string): Promise<string[]> {
  const names: string[] = [];
  const dir = await fs.promises.opendir(root);
  let examined = 0;
  // Breaking out of the loop closes the directory handle.
  for await (const e of dir) {
    if (e.isDirectory()) { names.push(e.name); }
    examined++;
    if (examined >= MAX_MULTI_SCAN) { break; }
  }
  return names.sort(byCodeUnit);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Run `fn` over `items` with at most `limit` at once; results keep the input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/** A folder that is not a repository: a `multi:` key from its immediate repository children. */
async function resolveMulti(root: string, git: IdentityGitRunner): Promise<ProjectIdentity | null> {
  // Git refused a folder that really is (inside) a repository: no key rather than a wrong one.
  if (await hasGitAtOrAbove(root)) { return null; }
  // The first MAX_MULTI_CHILDREN subdirectories by name that hold a `.git` entry.
  const names: string[] = [];
  for (const name of await scanSubdirs(root)) {
    if (names.length >= MAX_MULTI_CHILDREN) { break; }
    if (await entryExists(path.join(root, name, '.git'))) { names.push(name); }
  }
  const resolved = await mapLimited(names, CHILD_CONCURRENCY, (name) => resolveRepo(path.join(root, name), git));
  const repos: RepoIdentity[] = [];
  names.forEach((name, i) => {
    const r = resolved[i];
    if (!r || r === 'not-repo') { return; }
    if (/[\/\\]/.test(name) || name.length > PROJECT_KEY_MAX) { return; }
    repos.push(r.repo_url ? { dir: name, key: r.project_key, repo_url: r.repo_url } : { dir: name, key: r.project_key });
  });
  if (repos.length === 0) { return null; }
  return { project_key: multiKey(repos.map((r) => r.key)), repos };
}

/**
 * Resolve the identity of `dir`. A folder inside a repository gets the repository's key. Never
 * rejects: any failure resolves null.
 */
export async function resolveProjectIdentity(dir: string, opts: ResolveIdentityOptions = {}): Promise<ProjectIdentity | null> {
  try {
    const git = opts.git ?? execFileGitRunner(opts.env ?? process.env);
    const abs = path.resolve(dir);
    const own = await resolveRepo(abs, git);
    if (own !== 'not-repo') { return own; }
    return await resolveMulti(abs, git);
  } catch {
    return null;
  }
}

// ─── Cache ───

/** Timer functions the cache uses (tests inject fakes). */
export interface IdentityCacheTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Options of {@link ProjectIdentityCache}. */
export interface ProjectIdentityCacheOptions {
  /** Resolves one folder (default {@link resolveProjectIdentity}). */
  resolve?: (dir: string) => Promise<ProjectIdentity | null>;
  now?: () => number;
  ttlMs?: number;
  /** Most lookups running at once (default 4). */
  maxConcurrent?: number;
  /** Most folders remembered (default 256); the oldest is evicted first. */
  maxEntries?: number;
  timers?: IdentityCacheTimers;
}

interface CacheEntry {
  value: ProjectIdentity | null;
  at: number;
}

interface QueuedLookup {
  key: string;
  run: () => void;
}

const DEFAULT_TIMERS: IdentityCacheTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h && typeof h.unref === 'function') { h.unref(); }
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * In-memory project identities by folder: a TTL, one lookup per folder at a time, a concurrency
 * limit with priority, and a bounded size. No method rejects or throws.
 */
export class ProjectIdentityCache {
  private readonly resolveFn: (dir: string) => Promise<ProjectIdentity | null>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly maxEntries: number;
  private readonly timers: IdentityCacheTimers;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ProjectIdentity | null>>();
  private readonly queue: QueuedLookup[] = [];
  private running = 0;

  constructor(opts: ProjectIdentityCacheOptions = {}) {
    this.resolveFn = opts.resolve ?? ((dir) => resolveProjectIdentity(dir));
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? IDENTITY_TTL_MS;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 4);
    this.maxEntries = Math.max(1, opts.maxEntries ?? 256);
    this.timers = opts.timers ?? DEFAULT_TIMERS;
  }

  /** The remembered identity of `dir`, fresh or stale; `undefined` when never resolved. */
  peek(dir: string): ProjectIdentity | null | undefined {
    try {
      return this.entries.get(cacheKey(dir))?.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve `dir` unless a fresh entry exists; joins a lookup already in flight. `priority` puts a
   * queued lookup at the front of the queue. Never rejects.
   */
  warm(dir: string, opts: { priority?: boolean } = {}): Promise<ProjectIdentity | null> {
    try {
      const key = cacheKey(dir);
      const entry = this.entries.get(key);
      if (entry && this.now() - entry.at < this.ttlMs) { return Promise.resolve(entry.value); }
      const running = this.inflight.get(key);
      if (running) {
        if (opts.priority) { this.promote(key); }
        return running;
      }
      const p = new Promise<ProjectIdentity | null>((resolve) => {
        const run = (): void => {
          this.running++;
          let lookup: Promise<ProjectIdentity | null>;
          try {
            lookup = Promise.resolve(this.resolveFn(dir));
          } catch {
            lookup = Promise.resolve(null);
          }
          lookup.then((v) => v ?? null, () => null).then((value) => {
            this.store(key, value);
            this.inflight.delete(key);
            this.running--;
            this.pump();
            resolve(value);
          });
        };
        if (opts.priority) { this.queue.unshift({ key, run }); } else { this.queue.push({ key, run }); }
      });
      this.inflight.set(key, p);
      this.pump();
      return p;
    } catch {
      return Promise.resolve(null);
    }
  }

  /**
   * The identity of `dir` within `ms`: a remembered one at once (a stale one is also refreshed in
   * the background), else a priority lookup raced against a timer that resolves null. The late
   * result still lands in the cache. Never rejects.
   */
  within(dir: string, ms: number): Promise<ProjectIdentity | null> {
    try {
      const entry = this.entries.get(cacheKey(dir));
      if (entry) {
        if (this.now() - entry.at >= this.ttlMs) { void this.warm(dir); }
        return Promise.resolve(entry.value);
      }
      return new Promise<ProjectIdentity | null>((resolve) => {
        let done = false;
        const timer = this.timers.setTimeout(() => {
          if (done) { return; }
          done = true;
          resolve(null);
        }, ms);
        void this.warm(dir, { priority: true }).then((value) => {
          if (done) { return; }
          done = true;
          this.timers.clearTimeout(timer);
          resolve(value);
        });
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  private promote(key: string): void {
    const i = this.queue.findIndex((q) => q.key === key);
    if (i > 0) { this.queue.unshift(...this.queue.splice(i, 1)); }
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      this.queue.shift()!.run();
    }
  }

  private store(key: string, value: ProjectIdentity | null): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) { break; }
      this.entries.delete(oldest);
    }
  }
}

/** The cache key of a folder: resolved, and lower-cased on Windows. */
function cacheKey(dir: string): string {
  const abs = path.resolve(dir);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}
