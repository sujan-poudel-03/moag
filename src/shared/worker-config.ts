// ─── Worker config (pure, shared) ───
//
// The server-generated `.moag/config.json` a worker's shim reads, for a run job
// and for a plan-generation job, and the engine tool lockdown the planning
// config carries. The hosted server (`server/run-env.ts`, which re-exports
// these) and the ONOSOO remote child both build it; the remote child ships in
// the extension and the server does not, so it lives here.

import { EngineId } from '../models/types';

/** The two project settings a worker config reads (a subset of the server's ProjectRecord). */
export interface WorkerConfigProject {
  defaultEngine: EngineId;
  versionBudgetUsd: number;
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
    /** Claude reports its own total_cost_usd only in JSON mode; every server job uses it. */
    'engines.claude.outputFormat': 'json';
    /** `--max-budget-usd` for every Claude call (0 = none); see {@link perCallBudgetUsd}. */
    'engines.claude.maxBudgetUsdPerCall': number;
    /**
     * How long verify lets one gate command run. Present only when the operator set
     * `MOAG_GATE_TIMEOUT_MS`; absent, verify keeps its own default (600000).
     */
    'prdLoop.gateTimeoutMs'?: number;
    /** Operator's `MOAG_AUTO_INSTALL_DEPENDENCIES`; always present so a repository's file cannot decide it. */
    'autoInstallDependencies': boolean;
    /** Operator's `MOAG_INSTALL_IGNORE_SCRIPTS`; always present. */
    'dependencyInstall.ignoreScripts': boolean;
  };
}

/**
 * The per-call engine cap for a job: the smaller of the job's remaining cost
 * cap (when one is set) and the server-wide `MOAG_MAX_USD_PER_ENGINE_CALL`
 * (when set); 0 (no per-call cap) when neither is.
 */
export function perCallBudgetUsd(capUsd: number, maxUsdPerCall: number | null): number {
  const perCall = Math.min(capUsd > 0 ? capUsd : Infinity, maxUsdPerCall ?? Infinity);
  return Number.isFinite(perCall) ? perCall : 0;
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
 *
 * Claude always runs in JSON output mode, so the cap is enforced against the
 * CLI's own reported `total_cost_usd`, and every Claude call gets
 * `--max-budget-usd` = {@link perCallBudgetUsd} — the only bound on a call that
 * reports no cost (killed, timed out, unparsable).
 *
 * `gateTimeoutMs` (the operator's `MOAG_GATE_TIMEOUT_MS`, or null) becomes
 * `prdLoop.gateTimeoutMs`. Null leaves the key out, so verify keeps its default.
 */
export function buildWorkerConfig(
  project: WorkerConfigProject, remainingUsd: number, maxUsdPerCall: number | null = null,
  gateTimeoutMs: number | null = null,
  deps: { enabled: boolean; ignoreScripts: boolean } = { enabled: true, ignoreScripts: false },
): WorkerConfig {
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
      'engines.claude.outputFormat': 'json',
      'engines.claude.maxBudgetUsdPerCall': perCallBudgetUsd(cap, maxUsdPerCall),
      ...(gateTimeoutMs !== null ? { 'prdLoop.gateTimeoutMs': gateTimeoutMs } : {}),
      // pythonVenv is never sent: on the server only .venv / venv auto-detection applies.
      'autoInstallDependencies': deps.enabled,
      'dependencyInstall.ignoreScripts': deps.ignoreScripts,
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

/**
 * Claude Code arguments for a plan-generation job (replacing the default `-p`).
 * Without them, print mode still runs the read-only tools (Read, Glob, Grep)
 * unprompted, so a PRD could steer the planner into reading any file the
 * server user can read.
 *
 * - `--tools ""`: "Use "" to disable all tools" (`claude --help`) — no
 *   built-in tool at all, file tools included.
 * - `--strict-mcp-config`: "Only use MCP servers from --mcp-config, ignoring
 *   all other MCP configurations" — none is given, so no MCP server (and no
 *   MCP file tool) loads from the operator's user config either.
 *
 * Both verified against the installed CLI's `--help` (Claude Code 2.1.287). A
 * Claude too old to know a flag exits non-zero, so the plan fails closed.
 */
export const CLAUDE_PLAN_ARGS: readonly string[] = Object.freeze([
  '-p',
  '--strict-mcp-config',
  '--tools', '',
]);

/**
 * Engines a plan-generation job may run on by default, because their tools can
 * be locked down so the server's repository listing in the prompt is meant to
 * be the planner's only repo context: Claude ({@link CLAUDE_PLAN_ARGS}: every
 * built-in tool removed, no MCP server), Codex ({@link CODEX_PLAN_ARGS}: no
 * shell or exec tool, read-only sandbox — whether Codex can still read files
 * through a non-shell built-in is UNVERIFIED), Ollama (`ollama run` is a plain
 * completion with no tools). Gemini CLI has no flag that removes its file
 * tools, and the Anthropic API adapter always offers read_file, write_file,
 * list_directory and run_bash (plus take_screenshot and run_playwright_test) —
 * both are refused for plan generation unless an admin turns on
 * `allowPlannerFileAccess`, which for anthropic grants shell execution and
 * file writes, not just reads.
 */
export const PLANNER_LOCKED_ENGINES: readonly EngineId[] = Object.freeze(['claude', 'codex', 'ollama'] as EngineId[]);

/** {@link WorkerConfig} for a plan-generation job: the same, with every engine's auto-approve forced off. */
export interface PlanWorkerConfig {
  agentTaskPlayer: WorkerConfig['agentTaskPlayer'] & {
    'engines.claude.autoApprove': false;
    'engines.claude.args': string[];
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
 * `--dangerously-skip-permissions` and its settings.local.json allow-list and
 * gets {@link CLAUDE_PLAN_ARGS} (no tools, no MCP servers), Codex loses
 * `--full-auto` and gets {@link CODEX_PLAN_ARGS} (no shell tool, read-only
 * sandbox, runs outside a git repo), and Gemini gets no extra args (so no
 * `--yolo`). The engines still answer in print/exec mode — generation only
 * needs text.
 */
export function buildPlanWorkerConfig(
  project: WorkerConfigProject, remainingUsd: number, maxUsdPerCall: number | null = null,
): PlanWorkerConfig {
  const base = buildWorkerConfig(project, remainingUsd, maxUsdPerCall);
  return {
    agentTaskPlayer: {
      ...base.agentTaskPlayer,
      'engines.claude.autoApprove': false,
      'engines.claude.args': [...CLAUDE_PLAN_ARGS],
      'engines.codex.autoApprove': false,
      'engines.codex.args': [...CODEX_PLAN_ARGS],
      'engines.gemini.args': [],
    },
  };
}
