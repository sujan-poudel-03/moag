// ─── Environments: a project branch as a running Docker stack ───
//
// One environment per (project, branch). Starting one:
//
//   1. resolve the project id to its approved folder (projects.json — never a path from ONOSOO);
//   2. read and validate the recipe from THAT folder (recipe.ts);
//   3. check the branch name, then create (or refresh) a detached git worktree of the branch under
//      <stateDir>/host/worktrees/<key> — detached, so the branch itself stays free for MOAG runs;
//   4. list the compose services, write the override (compose.ts), and `up -d --build`.
//
// Starting an environment that exists refreshes it to the branch's latest commit. Stopping keeps
// the worktree and volumes; the agent never restarts what a person stopped, and stops what nobody
// has opened for `idle_stop_minutes`.
//
// Every command goes through the injected `exec` with childEnv(): no shell, no machine key.
// Imports node built-ins and sibling host modules only; never vscode.

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import { buildOverride, childEnv, composePolicyViolations, composeProjectName, composeVersionOk, deriveStatus, envKeyFor, isSafeBranch, parsePsOutput, servicesFromPs } from './compose';
import { mirrorPath, safeGitArgs, safeGitEnv } from './git-safe';
import type { HostConfig } from './host-config';
import { parseRecipe, RECIPE_FILE, type Recipe } from './recipe';
import type { EnvRecord, ProjectsLoader, ServiceRole, ServiceSnapshot } from './types';

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<ExecResult>;

export interface EnvironmentDeps {
  exec: Exec;
  config: HostConfig;
  stateDir: string;
  loadProjects: ProjectsLoader;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** True when nothing listens on 127.0.0.1:port. */
  portFree?: (port: number) => Promise<boolean>;
  fs?: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'existsSync' | 'renameSync'>;
  log?: (line: string) => void;
}

const PORT_MIN = 41000;
const PORT_MAX = 41999;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const CMD_TIMEOUT_MS = 2 * 60 * 1000;
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
  private readonly exec: Exec;
  private readonly fs: NonNullable<EnvironmentDeps['fs']>;
  private readonly now: () => number;
  private readonly portFree: (port: number) => Promise<boolean>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: EnvironmentDeps) {
    this.exec = deps.exec;
    this.fs = deps.fs ?? fs;
    this.now = deps.now ?? Date.now;
    this.portFree = deps.portFree ?? defaultPortFree;
    this.env = childEnv(deps.env ?? process.env);
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

  // ─── Commands ───

  private compose(r: Pick<EnvRecord, 'key' | 'worktree' | 'composeFile'>, args: string[], timeoutMs = CMD_TIMEOUT_MS): Promise<ExecResult> {
    return this.exec('docker', [
      'compose', '-p', composeProjectName(r.key),
      '--project-directory', r.worktree,
      '-f', r.composeFile, '-f', this.overridePath(r.key),
      ...args,
    ], { cwd: r.worktree, env: this.env, timeoutMs });
  }

  private overridePath(key: string): string {
    return path.join(this.deps.config.worktreesDir, `${key}.override.yml`);
  }

  /** Every host git call: hardened options, no system/global config, no prompts (git-safe.ts). */
  private git(cwd: string, args: string[], allowLocal = false): Promise<ExecResult> {
    const emptyHooksDir = path.join(this.deps.stateDir, 'host', 'no-hooks');
    this.fs.mkdirSync(emptyHooksDir, { recursive: true });
    return this.exec('git', safeGitArgs(args, { emptyHooksDir, allowLocal }), { cwd, env: safeGitEnv(this.env), timeoutMs: CMD_TIMEOUT_MS });
  }

  /** Docker and Compose are present and new enough. */
  async checkDocker(): Promise<string | null> {
    const v = await this.exec('docker', ['compose', 'version', '--short'], { env: this.env, timeoutMs: 20_000 }).catch(() => null);
    if (!v || v.exitCode !== 0) { return 'Docker with the Compose plugin is not available on this machine.'; }
    if (!composeVersionOk(v.stdout)) { return `Docker Compose ${v.stdout.trim()} is too old; 2.24.4 or newer is needed.`; }
    return null;
  }

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
    const used = new Set(this.list().map((r) => r.port));
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      if (!used.has(p) && await this.portFree(p)) { return p; }
    }
    throw new EnvError('No free local port for the preview.', 'failed');
  }

  /**
   * Bring the host's mirror of a project up to date with the project's branches. The project is
   * read as a remote — git uses none of its config, hooks or attributes drivers to do that — and
   * the mirror's own config is the host's alone (git-safe.ts).
   */
  private async refreshMirror(projectId: string, projectPath: string): Promise<string> {
    const mirror = mirrorPath(this.deps.stateDir, projectId);
    if (!this.fs.existsSync(mirror)) {
      this.fs.mkdirSync(path.dirname(mirror), { recursive: true });
      const clone = await this.git(path.dirname(mirror), ['clone', '--bare', '--no-local', '--no-hardlinks', '--quiet', projectPath, mirror], true);
      if (clone.exitCode !== 0) { throw new EnvError(`Could not read the project's repository: ${tail(clone.stderr)}`); }
    }
    const fetch = await this.git(mirror, ['fetch', '--quiet', '--prune', '--no-tags', projectPath, '+refs/heads/*:refs/heads/*'], true);
    if (fetch.exitCode !== 0) { throw new EnvError(`Could not read the project's branches: ${tail(fetch.stderr)}`); }
    return mirror;
  }

  /** Make `worktree` a detached checkout of `branch`'s latest commit, from the host's mirror. */
  private async checkout(projectId: string, projectPath: string, worktree: string, branch: string): Promise<void> {
    if (!isSafeBranch(branch)) { throw new EnvError('That branch name is not valid.', 'rejected'); }
    const mirror = await this.refreshMirror(projectId, projectPath);
    const fmt = await this.git(mirror, ['check-ref-format', '--branch', branch]);
    if (fmt.exitCode !== 0) { throw new EnvError('That branch name is not valid.', 'rejected'); }

    const ref = `refs/heads/${branch}`;
    // Only the approved project's own branches. A remote run's branch is imported into the project
    // when the run ends (MOAG's daemon), so while it is still running it is not here yet. No fallback
    // to the project's origin: reading its URL would mean running git on the project repo's config.
    const found = await this.git(mirror, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (found.exitCode !== 0) {
      throw new EnvError(`Branch "${branch}" is not in the project yet. A run's branch arrives when the run ends; try again then.`, 'rejected');
    }

    if (this.fs.existsSync(worktree)) {
      const r = await this.git(worktree, ['checkout', '--quiet', '--force', '--detach', ref]);
      if (r.exitCode !== 0) { throw new EnvError(`Could not update the checkout: ${tail(r.stderr)}`); }
      return;
    }
    this.fs.mkdirSync(path.dirname(worktree), { recursive: true });
    await this.git(mirror, ['worktree', 'prune']);
    const add = await this.git(mirror, ['worktree', 'add', '--force', '--detach', worktree, ref]);
    if (add.exitCode !== 0) { throw new EnvError(`Could not check out the branch: ${tail(add.stderr)}`); }
  }

  /** Start (or refresh) the environment for a project branch. Returns its key. */
  async start(projectId: string, branch: string, runKey: string | null = null): Promise<EnvRecord> {
    const project = this.project(projectId);
    const recipe = this.recipeFor(project.path);
    const key = envKeyFor(projectId, branch);
    const existing = this.records.get(key);
    const running = this.list().filter((r) => r.desired === 'running' && r.key !== key).length;
    if (!existing && running >= this.deps.config.maxEnvironments) {
      throw new EnvError(`This machine already runs ${running} environments (its limit). Stop one first.`, 'rejected');
    }

    return this.withLock(key, async () => {
      const worktree = path.join(this.deps.config.worktreesDir, key);
      await this.checkout(projectId, project.path, worktree, branch);

      const composeFile = recipe.composeFromProject ? path.join(project.path, recipe.composeFile) : path.join(worktree, recipe.composeFile);
      if (!this.fs.existsSync(composeFile)) {
        throw new EnvError(`The compose file ${recipe.composeFile} is not in ${recipe.composeFromProject ? 'the project folder' : 'this branch'}.`, 'rejected');
      }

      const port = existing?.port ?? await this.allocatePort();
      const record: EnvRecord = {
        key,
        projectId,
        projectName: project.name,
        branch,
        runKey: runKey ?? existing?.runKey ?? null,
        port,
        worktree,
        composeFile,
        roles: { ...recipe.roles },
        web: recipe.web,
        desired: 'running',
        status: 'starting',
        message: null,
        createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
        startedAt: null,
        lastAccessAt: new Date(this.now()).toISOString(),
      };

      // The services the compose file actually defines: the override must reset every one's ports.
      this.fs.writeFileSync(this.overridePath(key), 'services: {}\n');
      const listed = await this.compose(record, ['config', '--services']);
      if (listed.exitCode !== 0) { throw new EnvError(`The compose file could not be read: ${tail(listed.stderr)}`, 'rejected'); }
      const services = listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (recipe.web && !services.includes(recipe.web.service)) {
        throw new EnvError(`The recipe's web service "${recipe.web.service}" is not in the compose file.`, 'rejected');
      }
      for (const s of services) { if (!record.roles[s]) { record.roles[s] = 'other'; } }

      this.fs.writeFileSync(this.overridePath(key), buildOverride({
        envKey: key, services, web: recipe.web, hostPort: port, cpus: this.deps.config.cpus, memoryMb: this.deps.config.memoryMb,
      }));

      // The compose file is the branch's: check what it asks Docker for before anything starts.
      const resolved = await this.compose(record, ['config', '--format', 'json']);
      if (resolved.exitCode !== 0) { throw new EnvError(`The compose file could not be read: ${tail(resolved.stderr)}`, 'rejected'); }
      let configJson: unknown;
      try {
        configJson = JSON.parse(resolved.stdout);
      } catch {
        throw new EnvError('The compose configuration could not be read as JSON.', 'rejected');
      }
      const violations = composePolicyViolations(configJson, [worktree]);
      if (violations.length > 0) {
        throw new EnvError(`This branch's compose file asks for more than an environment may have: ${violations.slice(0, 5).join('; ')}.`, 'rejected');
      }

      this.records.set(key, record);
      this.save();

      const up = await this.compose(record, ['up', '-d', '--build', '--remove-orphans'], BUILD_TIMEOUT_MS);
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
  }

  private need(key: string): EnvRecord {
    const r = this.records.get(key);
    if (!r) { throw new EnvError('That environment is not on this machine.', 'rejected'); }
    return r;
  }

  async stop(key: string, reason: string | null = null): Promise<void> {
    const r = this.need(key);
    await this.withLock(key, async () => {
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
    await this.withLock(key, async () => {
      // A stopped environment is started again; a running one restarted.
      const args = r.desired === 'stopped' ? ['up', '-d'] : ['restart', ...(service ? [service] : [])];
      const res = await this.compose(r, args, r.desired === 'stopped' ? BUILD_TIMEOUT_MS : CMD_TIMEOUT_MS);
      if (res.exitCode !== 0) { throw new EnvError(`Restarting failed: ${tail(res.stderr)}`); }
      r.desired = 'running';
      r.message = null;
      r.lastAccessAt = new Date(this.now()).toISOString();
      this.save();
    });
  }

  async resetDb(key: string): Promise<void> {
    const r = this.need(key);
    const project = this.project(r.projectId);
    const recipe = this.recipeFor(project.path);
    await this.withLock(key, async () => {
      if (recipe.resetDb) {
        const res = await this.compose(r, ['exec', '-T', recipe.resetDb.service, ...recipe.resetDb.command], BUILD_TIMEOUT_MS);
        if (res.exitCode !== 0) { throw new EnvError(`The reset command failed: ${tail(res.stderr || res.stdout)}`); }
        return;
      }
      // No reset command: recreate the stack with fresh volumes. Everything stateful starts empty.
      const down = await this.compose(r, ['down', '--volumes', '--remove-orphans']);
      if (down.exitCode !== 0) { throw new EnvError(`Resetting failed: ${tail(down.stderr)}`); }
      const up = await this.compose(r, ['up', '-d'], BUILD_TIMEOUT_MS);
      if (up.exitCode !== 0) { throw new EnvError(`Starting again after the reset failed: ${tail(up.stderr)}`); }
      r.desired = 'running';
      this.save();
    });
  }

  /** Remove an environment entirely: containers, volumes, worktree, record. Not exposed to ONOSOO. */
  async remove(key: string): Promise<void> {
    const r = this.need(key);
    await this.withLock(key, async () => {
      await this.compose(r, ['down', '--volumes', '--remove-orphans']);
      await this.git(mirrorPath(this.deps.stateDir, r.projectId), ['worktree', 'remove', '--force', r.worktree]);
      this.records.delete(key);
      this.save();
    });
  }

  /** The last `lines` of a service's output. The caller redacts it. */
  async logs(key: string, service: string, lines: number): Promise<string> {
    const r = this.need(key);
    if (!r.roles[service]) { throw new EnvError(`There is no service "${service}" in this environment.`, 'rejected'); }
    const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.trunc(lines) || 500));
    const res = await this.compose(r, ['logs', '--no-color', '--timestamps', '--tail', String(n), service]);
    if (res.exitCode !== 0) { throw new EnvError(`Could not read the logs: ${tail(res.stderr)}`); }
    // Compose prefixes each line with "<service>-1  | "; strip it for readability.
    return res.stdout.replace(/^[^|\n]{1,80}\|\s?/gm, '');
  }

  /** Refresh every environment's services and status from Docker. */
  async refresh(): Promise<void> {
    for (const r of this.list()) {
      if (this.busy.has(r.key)) { continue; }
      const ps = await this.compose(r, ['ps', '-a', '--format', 'json']).catch(() => null);
      if (!ps || ps.exitCode !== 0) { continue; }
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
