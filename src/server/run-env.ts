// ─── Worker environment and config ───
//
// Every engine-touching job runs in a child process whose environment is BUILT,
// not inherited: an allowlist of OS/toolchain variables, the operator's explicit
// passthrough names, the path of a server-generated config, and only the engine
// credentials the job's plan references. `CI` and every `MOAG_*` (except the
// config path we set) never cross the boundary — `CI=true` would auto-skip ship
// gates (`runner.ts`), and `MOAG_*` carries server secrets.

import { EngineId, Plan } from '../models/types';
import { KEYED_ENGINE_ENV } from '../shared/engine-keys';
import { PLANNER_LOCKED_ENGINES } from '../shared/worker-config';

// The worker config itself is built in shared/ (the remote child ships in the extension, the server does not).
export type { WorkerConfig, WorkerConfigProject, PlanWorkerConfig } from '../shared/worker-config';
export {
  perCallBudgetUsd, buildWorkerConfig, buildPlanWorkerConfig, CODEX_PLAN_ARGS, CLAUDE_PLAN_ARGS, PLANNER_LOCKED_ENGINES,
} from '../shared/worker-config';

/** Exact variable names copied from the server env when present. */
const ENV_ALLOWLIST = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'WINDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'OLLAMA_HOST',
]);
/** Prefixes copied from the server env (git identity for agent commits). */
const ENV_ALLOW_PREFIXES = ['GIT_AUTHOR_', 'GIT_COMMITTER_'];

/** Never set in a worker env, whatever the allowlist or passthrough says. */
export function isForbiddenWorkerEnvName(name: string): boolean {
  return name === 'CI' || name.toUpperCase().startsWith('MOAG_');
}

export interface WorkerEnvOptions {
  /** Operator-approved extra names (`MOAG_RUN_ENV_PASSTHROUGH`). */
  passthrough: string[];
  /** env-var name → secret value; names must be values of {@link KEYED_ENGINE_ENV}. */
  engineCredentials: Record<string, string>;
  /** Server-generated config file the worker's shim must read. */
  configPath: string;
}

/** Build a worker env from scratch. Throws if a credential name is not a keyed-engine variable. */
export function buildWorkerEnv(serverEnv: NodeJS.ProcessEnv, opts: WorkerEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(serverEnv)) {
    if (v === undefined || isForbiddenWorkerEnvName(k)) { continue; }
    if (ENV_ALLOWLIST.has(k) || ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) { env[k] = v; }
  }
  for (const name of opts.passthrough) {
    if (isForbiddenWorkerEnvName(name)) { continue; }
    const v = serverEnv[name];
    if (v !== undefined) { env[name] = v; }
  }
  const allowedCredentialNames = new Set(Object.values(KEYED_ENGINE_ENV));
  for (const [name, value] of Object.entries(opts.engineCredentials)) {
    if (!allowedCredentialNames.has(name)) {
      throw new Error(`"${name}" is not a keyed-engine credential variable`);
    }
    env[name] = value;
  }
  env.MOAG_CONFIG_PATH = opts.configPath;
  return env;
}

/** Every engine a plan can run on: plan default + fallback, playlist and task engines, consensus engines. */
export function referencedEngines(plan: Plan): Set<EngineId> {
  const out = new Set<EngineId>();
  if (plan.defaultEngine) { out.add(plan.defaultEngine); }
  if (plan.fallbackEngine) { out.add(plan.fallbackEngine); }
  for (const pl of plan.playlists ?? []) {
    if (pl.engine) { out.add(pl.engine); }
    for (const t of pl.tasks ?? []) {
      if (t.engine) { out.add(t.engine); }
      for (const e of t.consensus?.engines ?? []) { out.add(e); }
    }
  }
  return out;
}

/**
 * Why `engine` may not generate a plan, or null when it may. An engine outside
 * {@link PLANNER_LOCKED_ENGINES} is refused unless `allowPlannerFileAccess`.
 */
export function plannerFileAccessRefusal(engine: EngineId, allowPlannerFileAccess: boolean): string | null {
  if (PLANNER_LOCKED_ENGINES.includes(engine) || allowPlannerFileAccess) { return null; }
  const alternatives = 'Switch the project to Claude Code, Codex or Ollama, or ask an admin to turn on planner file access';
  if (engine === 'anthropic') {
    return `anthropic can't plan without its file and shell tools (read, write, run commands), so this server won't use it for plan generation. `
      + `${alternatives}, which lets this planner read and write files and run shell commands on the server.`;
  }
  if (engine === 'gemini') {
    return `gemini can't plan without its file tools, so this server won't use it for plan generation. `
      + `${alternatives}, which lets this planner use its full default tool set on the server.`;
  }
  return `${engine} can't be stopped from reading files while it plans, so this server won't use it for plan generation. ${alternatives}.`;
}
