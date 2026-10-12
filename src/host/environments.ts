// ─── Environments: a project branch as a running Docker stack ───
//
// One environment per (project, branch). Everything a branch contains is treated as written by an
// adversary — the compose file, its .env, and anything its containers later write into the checkout
// — because an AI wrote it and its containers run with a bind mount of it. So:
//
//   resolve   the project id → its approved folder (projects.json, never a path from ONOSOO); the
//             recipe from THAT folder (recipe.ts); the branch from the host's own mirror (git-safe.ts)
//   checkout  a detached worktree of the branch; git is always given the worktree's gitdir
//             explicitly (--git-dir/--work-tree), never discovering it from the checkout's `.git`
//             file, which a container could repoint at a gitdir whose config runs commands
//   prepare   before EVERY `up`: write the override, resolve the configuration with no inherited
//             environment and an empty env file, check it (compose-policy.ts), and save the checked
//             result to a host-owned file outside the checkout
//   run       Docker always runs from that saved, checked file — so a container rewriting the compose
//             file in the checkout changes nothing until the next prepare, which checks it again
//
// Starting an environment that exists refreshes it to the branch's latest commit — its containers are
// stopped first, so none of them can touch the checkout between the check and `up`. Stopping keeps the
// worktree and volumes; the agent never restarts what a person stopped, and stops what nobody has
// opened for `idle_stop_minutes`.
//
// Imports node built-ins and sibling host modules only; never vscode.

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import { buildOverride, childEnv, composeProjectName, composeVersionOk, deriveStatus, envKeyFor, isSafeBranch, parsePsOutput, servicesFromPs } from './compose';
import { composePolicyViolations } from './compose-policy';
import { dockerChildEnv, prepareHostDockerConfig } from './docker-config';
import { gitVersionOk, mirrorPath, safeGitArgs, safeGitEnv } from './git-safe';
import type { HostConfig } from './host-config';
import { parseRecipe, RECIPE_FILE, type Recipe } from './recipe';
import type { EnvRecord, ProjectsLoader, ServiceRole, ServiceSnapshot } from './types';

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
) => Promise<ExecResult>;

export interface EnvironmentDeps {
  exec: Exec;
  config: HostConfig;
  stateDir: string;
  loadProjects: ProjectsLoader;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** True when nothing listens on 127.0.0.1:port. */
  portFree?: (port: number) => Promise<boolean>;
  fs?: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'existsSync' | 'renameSync' | 'rmSync'>;
  /** Resolve symlinks for the compose policy; injectable for tests. */
  realpath?: (p: string) => string;
  log?: (line: string) => void;
}

const PORT_MIN = 41000;
const PORT_MAX = 41999;
/** PROTOCOL §3: a snapshot carries at most 50 environments, stopped ones included. */
export const MAX_RECORDS = 50;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const CMD_TIMEOUT_MS = 2 * 60 * 1000;
/** Builds are chatty; the default 10 MB would leave a long build "starting" forever. */
const BIG_BUFFER = 256 * 1024 * 1024;
const MAX_LOG_LINES = 2000;

export class EnvError extends Error {
  /** "rejected": the request was refused (bad input, limits); "failed": it was tried and broke. */
  constructor(message: string, readonly kind: 'rejected' | 'failed' = 'failed') {
    super(message);
  }
}

function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** The last useful lines of a failed command, for a manager to read. */
function tail(text: string, lines = 8): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n').slice(-1500);
}

export class EnvironmentManager {
  private records = new Map<string, EnvRecord>();
  /** Keys with an operation in flight: one at a time per environment. */
  private busy = new Set<string>();
  /** Starts admitted but not yet recorded, and the ports they hold: the limit counts them. */
  private pendingStarts = new Set<string>();
  private reservedPorts = new Set<number>();
  /** Serialises admission (limit check + port allocation) across all environments. */
  private admission: Promise<unknown> = Promise.resolve();
  private readonly exec: Exec;
  private readonly fs: NonNullable<EnvironmentDeps['fs']>;
  private readonly now: () => number;
  private readonly portFree: (port: number) => Promise<boolean>;
  private readonly env: NodeJS.ProcessEnv;
  /** The unfiltered environment: read once, to find the user's Docker configuration. */
  private readonly rawEnv: NodeJS.ProcessEnv;
  private dockerEnvCache: NodeJS.ProcessEnv | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: EnvironmentDeps) {
    this.exec = deps.exec;
    this.fs = deps.fs ?? fs;
    this.now = deps.now ?? Date.now;
    this.portFree = deps.portFree ?? defaultPortFree;
    this.rawEnv = deps.env ?? process.env;
    this.env = childEnv(this.rawEnv);
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
    this.load();
  }

  // ─── State ───

  private load(): void {
    try {
      const raw = JSON.parse(String(this.fs.readFileSync(this.deps.config.stateFile, 'utf-8'))) as { environments?: EnvRecord[] };
      for (const r of raw.environments ?? []) {
        if (r && typeof r.key === 'string') { this.records.set(r.key, r); }
      }
    } catch {
      /* no state yet */
    }
  }

  private save(): void {
    const file = this.deps.config.stateFile;
    this.fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    this.fs.writeFileSync(tmp, JSON.stringify({ version: 1, environments: [...this.records.values()] }, null, 2), { mode: 0o600 });
    this.fs.renameSync(tmp, file);
  }

  list(): EnvRecord[] {
    return [...this.records.values()];
  }

  get(key: string): EnvRecord | undefined {
    return this.records.get(key);
  }

  /** Called by the gateway on every proxied request. Saved lazily by the idle sweep. */
  touch(key: string): void {
    const r = this.records.get(key);
    if (r) { r.lastAccessAt = new Date(this.now()).toISOString(); }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) { throw new EnvError('Something is already happening to this environment; try again in a moment.', 'rejected'); }
    this.busy.add(key);
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
    }
  }

  /** Run `fn` with no other admission in progress. */
  private admit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.admission.then(fn, fn);
    this.admission = next.catch(() => undefined);
    return next;
  }

  // ─── Host-owned files ───

  /** <stateDir>/host/compose/<key>: the override, the checked config, the empty env file. Never mounted. */
  private hostDir(key: string): string {
    return path.join(this.deps.stateDir, 'host', 'compose', key);
  }

  private hostFile(key: string, name: 'override.yml' | 'resolved.json' | 'empty.env'): string {
    return path.join(this.hostDir(key), name);
  }

  // ─── Processes ───

  /**
   * The environment of every docker and compose child: the allow-list plus DOCKER_CONFIG pointing at
   * the host-owned configuration with no registry credentials (docker-config.ts), written on first
   * use. If it cannot be written, docker does not run — never with the user's own configuration.
   */
  private dockerEnv(): NodeJS.ProcessEnv {
    if (!this.dockerEnvCache) {
      try {
        this.dockerEnvCache = dockerChildEnv(this.env, prepareHostDockerConfig(this.deps.stateDir, this.rawEnv));
      } catch (err) {
        throw new EnvError(`Could not write the host's Docker configuration: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.dockerEnvCache;
  }

  /** exec that never rejects: a spawn failure or an overflowing buffer is a failed result. */
  private async run(command: string, args: string[], opts: Parameters<Exec>[2]): Promise<ExecResult> {
    try {
      return await this.exec(command, args, opts);
    } catch (err) {
      return { exitCode: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false };
    }
  }

  /** A docker child with the host-owned Docker configuration. Never rejects, like run(). */
  private docker(args: string[], opts: Omit<Parameters<Exec>[2], 'env'>): Promise<ExecResult> {
    let env: NodeJS.ProcessEnv;
    try {
      env = this.dockerEnv();
    } catch (err) {
      return Promise.resolve({ exitCode: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
    }
    return this.run('docker', args, { ...opts, env });
  }

  /**
   * Compose on the BRANCH's file plus the override — used only to list and resolve the configuration
   * before it is checked. No inherited environment beyond the allow-list, and an empty env file so
   * the branch's .env is not read for interpolation either.
   */
  private composeSource(r: Pick<EnvRecord, 'key' | 'worktree' | 'composeFile'>, args: string[]): Promise<ExecResult> {
    return this.docker([
      'compose', '-p', composeProjectName(r.key),
      '--project-directory', r.worktree,
      '--env-file', this.hostFile(r.key, 'empty.env'),
      '-f', r.composeFile, '-f', this.hostFile(r.key, 'override.yml'),
      ...args,
    ], { cwd: this.hostDir(r.key), timeoutMs: CMD_TIMEOUT_MS, maxBuffer: BIG_BUFFER });
  }

  /** Compose on the checked, host-owned configuration. Every command that runs anything uses this. */
  private compose(r: Pick<EnvRecord, 'key'>, args: string[], timeoutMs = CMD_TIMEOUT_MS): Promise<ExecResult> {
    return this.docker([
      'compose', '-p', composeProjectName(r.key),
      '--env-file', this.hostFile(r.key, 'empty.env'),
      '-f', this.hostFile(r.key, 'resolved.json'),
      '--progress', 'quiet',
      ...args,
    ], { cwd: this.hostDir(r.key), timeoutMs, maxBuffer: BIG_BUFFER });
  }

  /** Every host git call: hardened options, explicit repository, never discovered from a checkout. */
  private git(gitArgs: string[], opts: { gitDir: string; workTree?: string; allowLocal?: boolean }): Promise<ExecResult> {
    const emptyHooksDir = path.join(this.deps.stateDir, 'host', 'no-hooks');
    this.fs.mkdirSync(emptyHooksDir, { recursive: true });
    const repo = ['--git-dir', opts.gitDir, ...(opts.workTree ? ['--work-tree', opts.workTree] : [])];
    return this.run('git', safeGitArgs([...repo, ...gitArgs], { emptyHooksDir, allowLocal: opts.allowLocal }), {
      cwd: path.dirname(opts.gitDir), env: safeGitEnv(this.env), timeoutMs: CMD_TIMEOUT_MS,
    });
  }

  /** Docker, Compose and git are present and new enough. Null when all is well. */
  async checkPrerequisites(): Promise<string | null> {
    let dockerEnv: NodeJS.ProcessEnv;
    try { dockerEnv = this.dockerEnv(); } catch (err) { return err instanceof Error ? err.message : String(err); }
    const v = await this.run('docker', ['compose', 'version', '--short'], { env: dockerEnv, timeoutMs: 20_000 });
    if (v.exitCode !== 0) { return 'Docker with the Compose plugin is not available on this machine.'; }
    if (!composeVersionOk(v.stdout)) { return `Docker Compose ${v.stdout.trim()} is too old; 2.24.4 or newer is needed.`; }
    const g = await this.run('git', ['--version'], { env: safeGitEnv(this.env), timeoutMs: 20_000 });
    if (g.exitCode !== 0) { return 'git is not available on this machine.'; }
    if (!gitVersionOk(g.stdout)) { return `${g.stdout.trim()} is too old; git 2.45.1 or newer is needed (it hardens local clones).`; }
    return null;
  }

  // ─── Lookups ───

  private project(projectId: string): { id: string; name: string; path: string } {
    const found = this.deps.loadProjects(this.deps.stateDir).projects.find((p) => p.id === projectId);
    if (!found) { throw new EnvError('That project is not on this machine\'s list of approved projects.', 'rejected'); }
    return found;
  }

  private recipeFor(projectPath: string): Recipe {
    let text: string;
    try {
      text = String(this.fs.readFileSync(path.join(projectPath, RECIPE_FILE), 'utf-8'));
    } catch {
      throw new EnvError(
        `This project has no approved run recipe. On the machine, run "moag host draft <project>", check the draft, and save it as ${RECIPE_FILE.replace(/\\/g, '/')}.`,
        'rejected',
      );
    }
    const parsed = parseRecipe(text);
    if (!parsed.ok) { throw new EnvError(`The run recipe is invalid: ${parsed.error}`, 'rejected'); }
    return parsed.recipe;
  }

  private async allocatePort(): Promise<number> {
    const used = new Set([...this.list().map((r) => r.port), ...this.reservedPorts]);
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      if (!used.has(p) && await this.portFree(p)) { return p; }
    }
    throw new EnvError('No free local port for the preview.', 'failed');
  }

  /**
   * Environments running or on their way: every running record plus EVERY admission in flight —
   * new starts, refreshes of stopped ones and restarts of stopped ones alike, since a stopped record
   * does not say "running" until its start finishes. Counted once per key.
   */
  private runningCount(except: string): number {
    const keys = new Set([...this.list().filter((r) => r.desired === 'running').map((r) => r.key), ...this.pendingStarts]);
    keys.delete(except);
    return keys.size;
  }

  // ─── Git ───

  /**
   * Bring the host's mirror of a project up to date with the project's branches. The project is
   * read as a remote — git uses none of its config, hooks or attribute drivers to do that.
   */
  private async refreshMirror(projectId: string, projectPath: string): Promise<string> {
    const mirror = mirrorPath(this.deps.stateDir, projectId);
    if (!this.fs.existsSync(mirror)) {
      this.fs.mkdirSync(path.dirname(mirror), { recursive: true });
      const emptyHooksDir = path.join(this.deps.stateDir, 'host', 'no-hooks');
      this.fs.mkdirSync(emptyHooksDir, { recursive: true });
      const clone = await this.run('git', safeGitArgs(['clone', '--bare', '--no-local', '--no-hardlinks', '--quiet', projectPath, mirror], { emptyHooksDir, allowLocal: true }), {
        cwd: path.dirname(mirror), env: safeGitEnv(this.env), timeoutMs: CMD_TIMEOUT_MS,
      });
      if (clone.exitCode !== 0) { throw new EnvError(`Could not read the project's repository: ${tail(clone.stderr)}`); }
    }
    const fetch = await this.git(['fetch', '--quiet', '--prune', '--no-tags', projectPath, '+refs/heads/*:refs/heads/*'], { gitDir: mirror, allowLocal: true });
    if (fetch.exitCode !== 0) { throw new EnvError(`Could not read the project's branches: ${tail(fetch.stderr)}`); }
    return mirror;
  }

  /** The worktree's own gitdir inside the mirror: host-owned, unlike the checkout's `.git` file. */
  private worktreeGitDir(mirror: string, key: string): string {
    return path.join(mirror, 'worktrees', key);
  }

  /** Make `worktree` a detached checkout of `branch`'s latest commit, from the host's mirror. */
  private async checkout(projectId: string, projectPath: string, key: string, worktree: string, branch: string): Promise<void> {
    if (!isSafeBranch(branch)) { throw new EnvError('That branch name is not valid.', 'rejected'); }
    const mirror = await this.refreshMirror(projectId, projectPath);
    const fmt = await this.git(['check-ref-format', '--branch', branch], { gitDir: mirror });
    if (fmt.exitCode !== 0) { throw new EnvError('That branch name is not valid.', 'rejected'); }

    const ref = `refs/heads/${branch}`;
    // Only the approved project's own branches. A remote run's branch is imported into the project
    // when the run ends (MOAG's daemon), so while it is still running it is not here yet.
    const found = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { gitDir: mirror });
    if (found.exitCode !== 0) {
      throw new EnvError(`Branch "${branch}" is not in the project yet. A run's branch arrives when the run ends; try again then.`, 'rejected');
    }

    const gitDir = this.worktreeGitDir(mirror, key);
    if (this.fs.existsSync(worktree) && this.fs.existsSync(gitDir)) {
      // Explicit gitdir and work tree: the checkout's `.git` file is never read.
      const r = await this.git(['checkout', '--quiet', '--force', '--detach', ref], { gitDir, workTree: worktree });
      if (r.exitCode !== 0) { throw new EnvError(`Could not update the checkout: ${tail(r.stderr)}`); }
      return;
    }
    this.fs.mkdirSync(path.dirname(worktree), { recursive: true });
    await this.git(['worktree', 'prune'], { gitDir: mirror });
    const add = await this.git(['worktree', 'add', '--force', '--detach', worktree, ref], { gitDir: mirror });
    if (add.exitCode !== 0) { throw new EnvError(`Could not check out the branch: ${tail(add.stderr)}`); }
    if (!this.fs.existsSync(gitDir)) { throw new EnvError('The checkout was created under an unexpected name; remove the environment and start it again.'); }
  }

  // ─── Prepare: resolve, check, save — before every up ───

  /**
   * Resolve the branch's compose configuration with the override, check it, and save the checked
   * result where only the host can write. Returns the services. Throws a "rejected" EnvError with the
   * reasons when the policy refuses it, so nothing starts.
   */
  private async prepare(r: EnvRecord, recipe: Recipe): Promise<string[]> {
    this.fs.mkdirSync(this.hostDir(r.key), { recursive: true });
    this.fs.writeFileSync(this.hostFile(r.key, 'empty.env'), '');
    this.fs.writeFileSync(this.hostFile(r.key, 'override.yml'), 'services: {}\n');

    if (!this.fs.existsSync(r.composeFile)) {
      throw new EnvError(`The compose file ${recipe.composeFile} is not in ${recipe.composeFromProject ? 'the project folder' : 'this branch'}.`, 'rejected');
    }
    const listed = await this.composeSource(r, ['config', '--services']);
    if (listed.exitCode !== 0) { throw new EnvError(`The compose file could not be read: ${tail(listed.stderr)}`, 'rejected'); }
    const services = listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (recipe.web && !services.includes(recipe.web.service)) {
      throw new EnvError(`The recipe's web service "${recipe.web.service}" is not in the compose file.`, 'rejected');
    }
    r.roles = { ...recipe.roles };
    for (const s of services) { if (!r.roles[s]) { r.roles[s] = 'other'; } }
    r.web = recipe.web;

    this.fs.writeFileSync(this.hostFile(r.key, 'override.yml'), buildOverride({
      envKey: r.key, services, web: recipe.web, hostPort: r.port, cpus: this.deps.config.cpus, memoryMb: this.deps.config.memoryMb,
    }));

    const resolved = await this.composeSource(r, ['config', '--format', 'json']);
    if (resolved.exitCode !== 0) { throw new EnvError(`The compose file could not be read: ${tail(resolved.stderr)}`, 'rejected'); }
    let configJson: unknown;
    try {
      configJson = JSON.parse(resolved.stdout);
    } catch {
      throw new EnvError('The compose configuration could not be read as JSON.', 'rejected');
    }
    const violations = composePolicyViolations(configJson, {
      roots: [r.worktree], web: recipe.web, hostPort: r.port, projectName: composeProjectName(r.key), realpath: this.deps.realpath,
    });
    if (violations.length > 0) {
      throw new EnvError(`This branch's compose file asks for more than an environment may have: ${violations.slice(0, 6).join('; ')}.`, 'rejected');
    }
    // What Docker will run from now on: exactly what was checked.
    this.fs.writeFileSync(this.hostFile(r.key, 'resolved.json'), JSON.stringify(configJson), { mode: 0o600 });
    return services;
  }

  // ─── Commands ───

  /** Start (or refresh) the environment for a project branch. */
  async start(projectId: string, branch: string, runKey: string | null = null): Promise<EnvRecord> {
    const project = this.project(projectId);
    const recipe = this.recipeFor(project.path);
    const key = envKeyFor(projectId, branch);

    const port = await this.admit(async () => {
      const existing = this.records.get(key);
      if (!existing && this.records.size + this.pendingStarts.size >= MAX_RECORDS) {
        throw new EnvError(`This machine already keeps ${MAX_RECORDS} environments. Remove a stopped one on the machine first.`, 'rejected');
      }
      const running = this.runningCount(key);
      if ((!existing || existing.desired !== 'running') && running >= this.deps.config.maxEnvironments) {
        throw new EnvError(`This machine already runs ${running} environments (its limit). Stop one first.`, 'rejected');
      }
      const p = existing?.port ?? await this.allocatePort();
      this.reservedPorts.add(p);
      this.pendingStarts.add(key);
      return p;
    });

    try {
      return await this.withLock(key, async () => {
        const existing = this.records.get(key);
        const worktree = path.join(this.deps.config.worktreesDir, key);

        // A refresh: stop the old containers FIRST. While they run they can write to the checkout,
        // so between the policy's realpath check and `up` they could swap a checked bind source,
        // env_file or build context for a link — Docker resolves those paths again at `up`. With
        // them stopped, nothing but the host touches the checkout until the checked `up`.
        const refreshing = existing !== undefined && this.fs.existsSync(this.hostFile(key, 'resolved.json'));
        if (refreshing) {
          const stopped = await this.compose(existing, ['stop']);
          if (stopped.exitCode !== 0) { throw new EnvError(`Could not stop the environment to refresh it: ${tail(stopped.stderr)}`); }
        }
        /** The old containers are stopped now: say so on the record, then rethrow. */
        const failRefresh = (err: unknown): unknown => {
          if (existing && refreshing) {
            existing.status = 'failed';
            existing.message = `Refreshing failed: ${err instanceof Error ? err.message : String(err)}`;
            this.save();
          }
          return err;
        };
        try {
          await this.checkout(projectId, project.path, key, worktree, branch);
        } catch (err) {
          throw failRefresh(err);
        }

        const record: EnvRecord = {
          key,
          projectId,
          projectName: project.name,
          branch,
          runKey: runKey ?? existing?.runKey ?? null,
          port,
          worktree,
          composeFile: recipe.composeFromProject ? path.join(project.path, recipe.composeFile) : path.join(worktree, recipe.composeFile),
          roles: { ...recipe.roles },
          web: recipe.web,
          desired: 'running',
          status: 'starting',
          message: null,
          createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
          startedAt: null,
          lastAccessAt: new Date(this.now()).toISOString(),
        };

        try {
          await this.prepare(record, recipe);
        } catch (err) {
          throw failRefresh(err);
        }
        this.records.set(key, record);
        this.save();

        // --force-recreate: containers pick up the freshly checked config and checkout.
        const up = await this.compose(record, ['up', '-d', '--build', '--remove-orphans', '--force-recreate'], BUILD_TIMEOUT_MS);
        if (up.exitCode !== 0) {
          record.status = 'failed';
          record.message = up.timedOut ? 'Starting took longer than 30 minutes and was stopped.' : `Starting failed: ${tail(up.stderr)}`;
          this.save();
          throw new EnvError(record.message);
        }
        record.startedAt = new Date(this.now()).toISOString();
        record.message = null;
        this.save();
        return record;
      });
    } finally {
      this.pendingStarts.delete(key);
      this.reservedPorts.delete(port);
    }
  }

  private need(key: string): EnvRecord {
    const r = this.records.get(key);
    if (!r) { throw new EnvError('That environment is not on this machine.', 'rejected'); }
    return r;
  }

  private needResolved(r: EnvRecord): void {
    if (!this.fs.existsSync(this.hostFile(r.key, 'resolved.json'))) {
      throw new EnvError('This environment needs to be started again before it can be used.', 'rejected');
    }
  }

  async stop(key: string, reason: string | null = null): Promise<void> {
    const r = this.need(key);
    await this.withLock(key, async () => {
      this.needResolved(r);
      const res = await this.compose(r, ['stop']);
      if (res.exitCode !== 0) { throw new EnvError(`Stopping failed: ${tail(res.stderr)}`); }
      r.desired = 'stopped';
      r.status = 'stopped';
      r.message = reason;
      this.save();
    });
  }

  async restart(key: string, service: string | null): Promise<void> {
    const r = this.need(key);
    if (service && !r.roles[service]) { throw new EnvError(`There is no service "${service}" in this environment.`, 'rejected'); }

    if (r.desired !== 'stopped') {
      await this.withLock(key, async () => {
        this.needResolved(r);
        const res = await this.compose(r, ['restart', ...(service ? [service] : [])]);
        if (res.exitCode !== 0) { throw new EnvError(`Restarting failed: ${tail(res.stderr)}`); }
        r.message = null;
        r.lastAccessAt = new Date(this.now()).toISOString();
        this.save();
      });
      return;
    }

    // Starting a stopped environment again is a start: the project must still be approved, the
    // limit applies, and the configuration is resolved and checked again before anything runs.
    const project = this.project(r.projectId);
    const recipe = this.recipeFor(project.path);
    await this.admit(async () => {
      const running = this.runningCount(key);
      if (running >= this.deps.config.maxEnvironments) {
        throw new EnvError(`This machine already runs ${running} environments (its limit). Stop one first.`, 'rejected');
      }
      this.pendingStarts.add(key);
    });
    try {
      await this.withLock(key, async () => {
        // "Stopped" is what a person asked for, not proof that nothing runs: a `restart: always`
        // container comes back with the Docker daemon and holds a read-write bind of the checkout.
        // Stop it before the check, as start() does, so nothing can swap a checked path for a link.
        if (this.fs.existsSync(this.hostFile(r.key, 'resolved.json'))) {
          const stopped = await this.compose(r, ['stop']);
          if (stopped.exitCode !== 0) { throw new EnvError(`Could not stop the environment to start it again: ${tail(stopped.stderr)}`); }
        }
        r.composeFile = recipe.composeFromProject ? path.join(project.path, recipe.composeFile) : path.join(r.worktree, recipe.composeFile);
        await this.prepare(r, recipe);
        const res = await this.compose(r, ['up', '-d', '--force-recreate'], BUILD_TIMEOUT_MS);
        if (res.exitCode !== 0) { throw new EnvError(`Starting again failed: ${tail(res.stderr)}`); }
        r.desired = 'running';
        r.message = null;
        r.lastAccessAt = new Date(this.now()).toISOString();
        this.save();
      });
    } finally {
      this.pendingStarts.delete(key);
    }
  }

  async resetDb(key: string): Promise<void> {
    const r = this.need(key);
    const project = this.project(r.projectId);
    const recipe = this.recipeFor(project.path);
    await this.withLock(key, async () => {
      if (recipe.resetDb) {
        this.needResolved(r);
        const res = await this.compose(r, ['exec', '-T', recipe.resetDb.service, ...recipe.resetDb.command], BUILD_TIMEOUT_MS);
        if (res.exitCode !== 0) { throw new EnvError(`The reset command failed: ${tail(res.stderr || res.stdout)}`); }
        return;
      }
      // No reset command: recreate the stack with fresh volumes — after checking the configuration
      // again, since `up` is about to run it.
      r.composeFile = recipe.composeFromProject ? path.join(project.path, recipe.composeFile) : path.join(r.worktree, recipe.composeFile);
      if (this.fs.existsSync(this.hostFile(r.key, 'resolved.json'))) {
        const down = await this.compose(r, ['down', '--volumes', '--remove-orphans']);
        if (down.exitCode !== 0) { throw new EnvError(`Resetting failed: ${tail(down.stderr)}`); }
      }
      await this.prepare(r, recipe);
      const up = await this.compose(r, ['up', '-d', '--force-recreate'], BUILD_TIMEOUT_MS);
      if (up.exitCode !== 0) { throw new EnvError(`Starting again after the reset failed: ${tail(up.stderr)}`); }
      r.desired = 'running';
      this.save();
    });
  }

  /** Remove an environment entirely: containers, volumes, worktree, host files, record. Machine only. */
  async remove(key: string): Promise<void> {
    const r = this.need(key);
    await this.withLock(key, async () => {
      if (this.fs.existsSync(this.hostFile(r.key, 'resolved.json'))) { await this.compose(r, ['down', '--volumes', '--remove-orphans']); }
      // Deleted as files, not with `git worktree remove`, which would read the checkout's `.git`.
      try { this.fs.rmSync(r.worktree, { recursive: true, force: true }); } catch (err) {
        this.log(`moag host: could not delete ${r.worktree} (files written by a container as root?): ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.git(['worktree', 'prune'], { gitDir: mirrorPath(this.deps.stateDir, r.projectId) });
      try { this.fs.rmSync(this.hostDir(r.key), { recursive: true, force: true }); } catch { /* best effort */ }
      this.records.delete(key);
      this.save();
    });
  }

  /** The last `lines` of a service's output. The caller redacts it. */
  async logs(key: string, service: string, lines: number): Promise<string> {
    const r = this.need(key);
    if (!r.roles[service]) { throw new EnvError(`There is no service "${service}" in this environment.`, 'rejected'); }
    this.needResolved(r);
    const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.trunc(lines) || 500));
    const res = await this.compose(r, ['logs', '--no-color', '--timestamps', '--tail', String(n), service]);
    if (res.exitCode !== 0) { throw new EnvError(`Could not read the logs: ${tail(res.stderr)}`); }
    // Compose prefixes each line with "<service>-1  | "; strip it for readability.
    return res.stdout.replace(/^[^|\n]{1,80}\|\s?/gm, '');
  }

  /** Refresh every environment's services and status from Docker. */
  async refresh(): Promise<void> {
    for (const r of this.list()) {
      if (this.busy.has(r.key) || !this.fs.existsSync(this.hostFile(r.key, 'resolved.json'))) { continue; }
      const ps = await this.compose(r, ['ps', '-a', '--format', 'json']);
      if (ps.exitCode !== 0) { continue; }
      const services = servicesFromPs(parsePsOutput(ps.stdout), r.roles);
      const next = deriveStatus(services, r.desired, r.web?.service ?? null);
      // A start that failed stays failed until it is started again; ps alone cannot clear that.
      if (!(r.status === 'failed' && r.message && r.desired === 'running' && next === 'failed')) { r.status = next; }
      this.lastServices.set(r.key, services);
    }
  }

  private lastServices = new Map<string, ServiceSnapshot[]>();

  services(key: string): ServiceSnapshot[] {
    const r = this.records.get(key);
    if (!r) { return []; }
    return this.lastServices.get(key) ?? Object.entries(r.roles).map(([name, role]) => ({ name, role: role as ServiceRole, state: 'exited' as const, health: 'unknown' as const }));
  }

  /** Stop environments nobody has opened for the configured time. Returns the keys stopped. */
  async idleSweep(): Promise<string[]> {
    const minutes = this.deps.config.idleStopMinutes;
    if (minutes <= 0) { return []; }
    const stopped: string[] = [];
    for (const r of this.list()) {
      if (r.desired !== 'running' || this.busy.has(r.key)) { continue; }
      const idleMs = this.now() - Date.parse(r.lastAccessAt);
      if (idleMs < minutes * 60_000) { continue; }
      try {
        await this.stop(r.key, `Stopped after ${minutes} minutes without visitors. Restart it to use it again.`);
        stopped.push(r.key);
      } catch (err) {
        this.log(`moag host: idle stop of ${r.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.save();
    return stopped;
  }
}
