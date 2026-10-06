#!/usr/bin/env node
// ─── Hosted server entry point ───
//
//   MOAG_DATA_DIR=/data MOAG_PUBLIC_URL=https://moag.example.com node out/server/main.js
//
// Boot order: validate config → scrub secrets from process.env → create the
// data dir (0700) → refuse to start with zero admins and no bootstrap token →
// recover state left by a crash → propose standards for projects that have
// none → listen. SIGTERM/SIGINT stop every job, then
// close the server. This module never imports `vscode`; engine work happens
// only in `run-worker.js` child processes.

import * as fs from 'fs';
import * as path from 'path';
import { spawn, SpawnOptions } from 'child_process';
import { loadServerConfig, scrubServerSecrets, ServerConfig } from './config';
import { UserStore } from './users';
import { SessionStore } from './sessions';
import { AuditLog } from './audit';
import { ProjectStore } from './projects';
import { ProjectStateStore } from './project-state';
import { StandardsStore, migrateStandards } from './standards-store';
import { LoginRateLimiter } from './rate-limit';
import { createApp, App } from './app';
import { JobManager, SpawnSpec, WorkerProcess } from './jobs';
import { killProcess, SPAWN_DETACHED } from '../utils/process-kill';

const log = (m: string): void => { process.stderr.write(`${new Date().toISOString()} [moag-server] ${m}\n`); };

/**
 * AC3: with zero admin accounts the only way in is the one-time bootstrap
 * token. Without one the server would be unusable and — worse — would invite
 * someone to "fix" it by editing users.json, so refuse to start instead.
 */
export function bootPreconditionError(users: Pick<UserStore, 'list'>, config: Pick<ServerConfig, 'bootstrapToken'>): string | null {
  const hasAdmin = users.list().some((u) => u.roles.includes('admin'));
  if (!hasAdmin && config.bootstrapToken === null) {
    return 'No admin account exists and MOAG_BOOTSTRAP_TOKEN is not set. Set a bootstrap token (24+ characters) to create the first admin.';
  }
  return null;
}

/**
 * Spawn options for a run worker: no shell, cwd = workspace, a built env, an
 * IPC channel for stop — and `detached: true` on EVERY platform.
 *
 * POSIX: the worker leads its own process group (recorded in job.lock as
 * `workerPgid`; `killProcess` signals the group). Windows: without `detached`,
 * libuv puts the worker in the server's kill-on-close job object, so a server
 * crash hard-kills the worker before it can stop its runner. The agent's own
 * descendants are not in that job and survive as orphans, while job.lock (whose
 * worker pid is now dead) is reclaimed — admitting a second concurrent run into
 * the same workspace. Detached, the worker outlives the server, receives
 * `disconnect`, and `runner.stop()` tree-kills the running task before it exits.
 * `windowsHide` keeps the detached worker from opening a console window.
 */
export function workerSpawnOptions(spec: SpawnSpec): SpawnOptions {
  return {
    shell: false,
    cwd: spec.workspace,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: true,
    windowsHide: true,
  };
}

/** Spawn a run worker with {@link workerSpawnOptions}. */
export function spawnRunWorker(spec: SpawnSpec): WorkerProcess {
  const workerScript = path.join(__dirname, 'run-worker.js');
  return spawn(process.execPath, [workerScript, spec.jobPath], workerSpawnOptions(spec)) as WorkerProcess;
}

export interface BootRecoveryResult {
  /** Interrupted run/plan records marked now. */
  recovered: number;
  /** Projects whose stale job.lock was removed. */
  reclaimed: string[];
  /** Projects left alone because a predecessor's worker still holds their lock. */
  held: string[];
}

/**
 * Crash recovery at boot. Stale locks are reclaimed first; a project whose lock
 * is still HELD (a predecessor's worker — or the agent it started — is alive)
 * is not recovered now: marking its run `interrupted` and merging its snapshot
 * while the worker is still writing that snapshot would record a half-finished
 * run as final. Instead its lock is watched, and recovery runs for that project
 * (under its project lock) once the worker has exited. Every other project is
 * recovered immediately. Returns a disposer for the watch alongside the counts.
 */
export function recoverAfterRestart(
  ids: readonly string[],
  jobs: Pick<JobManager, 'reclaimStaleLocks' | 'isLockHeld' | 'watchHeldLocks'>,
  state: Pick<ProjectStateStore, 'recoverOnBoot' | 'withProjectLock'>,
  log: (m: string) => void,
): BootRecoveryResult & { stopWatching: () => void } {
  const reclaimed = jobs.reclaimStaleLocks(ids);
  const held = ids.filter((id) => jobs.isLockHeld(id));
  const recovered = state.recoverOnBoot(ids.filter((id) => !held.includes(id)), new Date(), log);
  const stopWatching = held.length === 0 ? () => undefined : jobs.watchHeldLocks(held, (id) => {
    state.withProjectLock(id, () => {
      const n = state.recoverOnBoot([id], new Date(), log);
      log(`project ${id}: previous worker exited; recovered ${n} interrupted record(s)`);
    }).catch((err) => log(`deferred recovery ${id}: ${(err as Error).message}`));
  });
  if (held.length > 0) { log(`${held.length} project(s) still locked by a previous worker; recovery deferred until it exits`); }
  return { recovered, reclaimed, held, stopWatching };
}

/** Build and start the server. Resolves once it is listening. */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<{ app: App; config: ServerConfig }> {
  const loaded = loadServerConfig(env);
  if (!loaded.ok) { throw new Error(loaded.error); }
  const config = loaded.config;
  scrubServerSecrets(env);

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(config.dataDir, 0o700); } catch { /* not supported (Windows) */ }
  fs.mkdirSync(config.projectsRoot, { recursive: true, mode: 0o700 });

  const users = new UserStore(config.dataDir);
  const precondition = bootPreconditionError(users, config);
  if (precondition) { throw new Error(precondition); }

  const projects = new ProjectStore(config.dataDir);
  const state = new ProjectStateStore(config.dataDir);
  const audit = new AuditLog(config.dataDir);
  const standards = new StandardsStore(config.dataDir);
  const app = createApp({
    config,
    users,
    sessions: new SessionStore(config.dataDir),
    audit,
    projects,
    state,
    standards,
    limiter: new LoginRateLimiter(),
    spawnWorker: spawnRunWorker,
    killProcess: (proc) => killProcess(proc as Parameters<typeof killProcess>[0]),
    // Workers are always detached, but only POSIX gives them a process group to record.
    workerLeadsProcessGroup: SPAWN_DETACHED,
    serverEnv: env,
    log,
  });

  const ids = projects.list().map((p) => p.id);
  const { recovered, reclaimed } = recoverAfterRestart(ids, app.jobs, state, log);
  if (recovered > 0) { log(`marked ${recovered} interrupted run/plan record(s) after restart`); }
  if (reclaimed.length > 0) { log(`reclaimed ${reclaimed.length} stale job lock(s)`); }
  // Projects created before project standards existed get an automatic proposal to review.
  const migrated = await migrateStandards(projects, standards, audit, log);
  if (migrated.length > 0) { log(`proposed standards for ${migrated.length} project(s) that had none; new plans wait for a reviewer or an admin`); }
  if (config.runsDisabledReason === 'ci') { log('CI=true is set: runs and plan generation are DISABLED (CI would auto-approve ship gates).'); }

  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, () => { app.server.off('error', reject); resolve(); });
  });
  log(`listening on ${config.host}:${config.port} (public URL ${config.publicUrl})`);
  // Fill the engine status cache (installed CLIs). Runs in a worker; never blocks boot.
  if (!app.probeEngines()) { log('engine probe did not start; admins can re-check from the Engines screen'); }
  return { app, config };
}

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
  const { app } = await startServer(process.env);
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) { return; }
    shuttingDown = true;
    log(`${signal}: stopping jobs`);
    app.jobs.stopAll()
      .catch((err) => log(`stopAll: ${(err as Error).message}`))
      .finally(() => {
        app.server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
