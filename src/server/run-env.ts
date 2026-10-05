// ─── Worker environment and config ───
//
// Every engine-touching job runs in a child process whose environment is BUILT,
// not inherited: an allowlist of OS/toolchain variables, the operator's explicit
// passthrough names, the path of a server-generated config, and only the engine
// credentials the job's plan references. `CI` and every `MOAG_*` (except the
// config path we set) never cross the boundary — `CI=true` would auto-skip ship
// gates (`runner.ts`), and `MOAG_*` carries server secrets.

import { EngineId, Plan } from '../models/types';
import { ProjectRecord } from './projects';
import { KEYED_ENGINE_ENV } from './secrets';

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

/** The `.moag/config.json`-shaped document a worker's shim reads. */
export interface WorkerConfig {
  agentTaskPlayer: {
    defaultEngine: EngineId;
    costBudgetUsd: number;
    fullAuto: false;
    'prdLoop.onManualGate': 'halt';
    'prdLoop.versionBudgetUsd': number;
    'prdLoop.uat.mode': 'off';
  };
}

/**
 * The server-generated worker config. The repo's own `.moag/config.json` is
 * never read (it is attacker-controllable). Ship gates always halt for a human;
 * the per-run cost ceiling is what remains of the project's per-version cap
 * (0 = no cap set); browser UAT is off on the server.
 *
 * Throws when the project HAS a cap but nothing remains: the runner reads a
 * ceiling of 0 as "unlimited" (`runner.ts` `onCostRecorded`), so passing an
 * exhausted remainder through would silently lift the cap.
 */
export function buildWorkerConfig(project: Pick<ProjectRecord, 'defaultEngine' | 'versionBudgetUsd'>, remainingUsd: number): WorkerConfig {
  let cap = 0;
  if (project.versionBudgetUsd > 0) {
    if (!(remainingUsd > 0)) { throw new Error('The per-version cost cap is exhausted.'); }
    cap = remainingUsd;
  }
  return {
    agentTaskPlayer: {
      defaultEngine: project.defaultEngine,
      costBudgetUsd: cap,
      fullAuto: false,
      'prdLoop.onManualGate': 'halt',
      'prdLoop.versionBudgetUsd': cap,
      'prdLoop.uat.mode': 'off',
    },
  };
}

/**
 * Extra `codex exec` arguments for a plan-generation job.
 *
 * - `--skip-git-repo-check`: the plan job's cwd is a server-owned scratch dir,
 *   not a git repo, and `codex exec` refuses to start outside one (or a trusted
 *   folder) without it — every Codex plan would fail.
 * - `--sandbox read-only` plus `--disable shell_tool` / `--disable unified_exec`:
 *   dropping `--full-auto` alone does NOT stop `codex exec` running shell
 *   commands (it runs them unprompted in its sandbox, which can read the whole
 *   filesystem). Both shell-tool feature flags are disabled so the planner gets
 *   no command tool at all; the read-only sandbox is the fallback should a
 *   future Codex add another one.
 * - `shell_environment_policy.inherit=none`: any command that still ran would
 *   see no inherited environment (the worker env carries the engine key).
 *
 * A Codex too old to know a flag exits non-zero, so the plan fails closed
 * (`engine-failed`) rather than running with commands enabled.
 */
export const CODEX_PLAN_ARGS: readonly string[] = Object.freeze([
  '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '--disable', 'shell_tool',
  '--disable', 'unified_exec',
  '-c', 'shell_environment_policy.inherit=none',
]);

/** {@link WorkerConfig} for a plan-generation job: the same, with every engine's auto-approve forced off. */
export interface PlanWorkerConfig {
  agentTaskPlayer: WorkerConfig['agentTaskPlayer'] & {
    'engines.claude.autoApprove': false;
    'engines.codex.autoApprove': false;
    'engines.codex.args': string[];
    'engines.gemini.args': [];
  };
}

/**
 * Config for a plan-generation job. Plan generation is product-owner-triggered
 * and its prompt carries PO-written PRD text verbatim, so it must not run with
 * tools pre-approved: otherwise "request a plan" is "run any command on the
 * server" for a role that may not start runs (OQ3). Claude loses
 * `--dangerously-skip-permissions` and its settings.local.json allow-list,
 * Codex loses `--full-auto` and gets {@link CODEX_PLAN_ARGS} (no shell tool,
 * read-only sandbox, runs outside a git repo), and Gemini gets no extra args
 * (so no `--yolo`). The engines still answer in print/exec mode — generation
 * only needs text.
 */
export function buildPlanWorkerConfig(project: Pick<ProjectRecord, 'defaultEngine' | 'versionBudgetUsd'>, remainingUsd: number): PlanWorkerConfig {
  const base = buildWorkerConfig(project, remainingUsd);
  return {
    agentTaskPlayer: {
      ...base.agentTaskPlayer,
      'engines.claude.autoApprove': false,
      'engines.codex.autoApprove': false,
      'engines.codex.args': [...CODEX_PLAN_ARGS],
      'engines.gemini.args': [],
    },
  };
}
