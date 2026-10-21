#!/usr/bin/env node
/**
 * MOAG headless CLI — run a plan, verify it against a PRD, or run a continuous
 * intake loop, with no VS Code.
 *
 *   moag run    <plan.json> [--no-interactive] [--full-auto] [--engine <id>] [--cwd <dir>]
 *                           [--verify] [--fix] [--prd <file>] [--gate "<cmd>"] [--max-iterations <n>]
 *                           [--uat | --no-uat] [--uat-spec <path>]
 *                           [--standards <file> | --no-standards] [--base <ref>]
 *   moag run    --prompt "<text>" [--engine <id>] [--full-auto] [--cwd <dir>]
 *   moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--max-iterations <n>]
 *                           [--engine <id>] [--cwd <dir>] [--uat | --no-uat] [--uat-spec <path>]
 *                           [--standards <file> | --no-standards] [--base <ref>]
 *   moag loop   --repo <owner/repo> [--label <l>] [--interval <sec>] [--once]
 *                                   [--full-auto] [--engine <id>] [--cwd <dir>]
 *   moag config <get-engine | set-engine <id>>
 *   moag trace  [<plan.json> | --plan <path>] [--req R-<n>]
 *   moag standards show
 *   moag standards check   [--base <ref>] [--no-commands]
 *   moag standards propose [--stack <id>] [--write [--force]]
 *   moag bench  <scenario.json> [--dry-run] [--out <dir>] [--max-usd <n>] [--allow-failed-probes]
 *   moag host   [run | init | draft <project> | status | stop <env> | remove <env>]
 *
 * `host`  runs approved project branches as live environments for ONOSOO previews, behind a
 *          gateway only workspace members get through (src/host/, docs/host-agent.md).
 * `run`   executes a single plan file, or a one-shot prompt (`--prompt`) which is
 *          turned into a single agent task and run through the selected engine.
 * `verify` runs the deterministic PRD gates (status / change / standards / command /
 *          artifact) and only then asks a model for a verdict; with `--fix` it generates and
 *          runs fix playlists until the gates pass or a halt condition trips.
 *          The standards gate checks the diff since `--base` against `.moag/standards.json`
 *          when the workspace has one. Without `--base` that is the commit captured when the
 *          first run since the last passed verification started (`.moag/standards-base.json`),
 *          so work a run committed is still checked; with none captured it is HEAD.
 *          `--standards <file>` reads a server-written job file instead.
 *          `--no-standards` turns project standards off for this invocation, all of it: task
 *          prompts carry no standards block, and verification runs no standards gate — neither
 *          the static rules nor the profile's commands. Nothing else is affected.
 *          `--uat` forces the browser UAT gate to run and pass (a missing
 *          Playwright/Cypress setup then FAILS verification); `--no-uat` disables
 *          it. Without either flag, agentTaskPlayer.prdLoop.uat.mode decides.
 * `config` reads/sets the persistent default engine in `.moag/config.json`.
 * `trace`  prints one JSONL line per PRD requirement (shipped / in-progress / not-shipped /
 *          untracked / removed) with its PRD version, release tag, the standards version that
 *          release was checked against, tasks and gate exit codes.
 * `standards` works on the workspace's own `.moag/standards.json`, with no engine and no model:
 *          `show` prints the document and the text every task prompt carries; `check` checks
 *          the diff since `--base` (default: the captured run base, else HEAD) and exits 0 when
 *          no BLOCKING rule or command failed (or none is configured, which it says), 1 when
 *          one did, 5 when no diff could be taken at all, so nothing was checked, and 6 when
 *          a command or a promoted rule was NOT CHECKED. Advisory findings are listed and do
 *          not change the exit code; rules it could not decide are listed as "not checked",
 *          which is never a pass. `propose` detects the repository's conventions from the
 *          files git tracks and prints a
 *          proposed profile, writing it (as the next version) only with `--write`; an existing
 *          file that differs — it may hold hand edits — is replaced only with `--force`, and
 *          the file it replaces is kept as `.moag/standards.json.bak`.
 * `bench`  drives the hosted server end to end through one benchmark scenario
 *          (docs/benchmark.md). `--dry-run` uses a fake engine and spends nothing;
 *          a paid run requires `--max-usd`, and stops before any engine call when a
 *          scenario environment probe fails unless `--allow-failed-probes` is given.
 * `loop`   polls a GitHub repo for open issues, turns each new issue into a task,
 *          runs them, then reports the outcome back to the issue (comment + close on
 *          success; comment + label on failure) — the closed autonomous loop.
 *
 * Exit codes: 0 ok · 1 task(s) failed or PRD gaps remain · 2 error/usage ·
 *             3 halted at ship gate · 4 halted on cost ceiling.
 * Progress is JSONL on stdout; human notices on stderr.
 *
 * `run` also reports, after each task's own line, `task-changes` (files changed, and a
 *          redacted diff capped at 64 KB) for tasks that started and ended Completed or
 *          Failed in a git work tree, and a redacted `task-error-tail` for a failed task.
 *
 * ONOSOO relay (`run` only): with a device key configured, every JSONL line except
 *          task-pid/task-output is also mirrored to ONOSOO, redacted, spooled to disk first
 *          and resent until acknowledged. Sources, and only these:
 *            MOAG_ONOSOO_KEY   the device key   (else "key" in the user file)
 *            MOAG_ONOSOO_URL   the base URL     (else "url" in the user file; https, or
 *                                                http to localhost only)
 *          User file: <configDir>/moag/onosoo.json — <configDir> is %APPDATA% on Windows,
 *          else $XDG_CONFIG_HOME, else ~/.config. It also keeps the generated device_id; the
 *          spool lives beside it. Nothing relay-related is ever written under the workspace.
 *          No key: no request, no spool, no timer. Relay trouble never changes an exit code.
 *
 * ONOSOO remote work (`daemon`): with a device key, `moag daemon` also polls ONOSOO for stop /
 *          retry / approve / skip / start-run commands — with a key alone (no daemon.json) that
 *          poller is all it runs. Remote runs execute as a separate runner account through sudo,
 *          Linux only; setup, projects.json and the files kept are in docs/onosoo-remote.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import { installVscodeShim, FileMemento } from './install-shim';
// Both of these are free of VS Code API imports, so they are safe to load before the shim.
import { captureHeadRef, collectStandardsInput, detectPrdFile, EMPTY_TREE_REF, gatesForStoredReport, runGate } from '../runner/evidence';
import { createPrdLoop, HaltReason, PrdLoopConfig, PrdLoopReport, UatSession } from '../runner/prd-loop';
import {
  DependencyInstallSettings, ensureDependencies, formatDependencyEventLine, readDependencyInstallSettings,
} from '../runner/dependency-install';
import { getConfig } from '../core/host';
import type { DependencyEvent } from '../models/types';
import {
  capStandardsReport, checkStandards, commandRow, groupStandardsRules, isBlockingNotChecked, MAX_REPORT_TAIL_CHARS, NO_BLOCKING_RULES,
  promotedScannerRules, recountTotals, ruleOutcomeLabel, SCANNER_PROMOTION_WARNING, severityOf, standardsBlocked, standardsBlockingState,
  StandardsReport,
} from '../standards/checker';
import { loadLocalStandards, localStandardsPath, readStandardsJobFile, writeDesignFiles, writeLocalStandards } from '../standards/local-store';
import { DESIGN_SYSTEM_HEADER, DesignSystem, parseDesignTokens, renderDesignPromptText } from '../standards/design';
import { profileHash, renderStandardsText, StandardsDocument } from '../standards/profile';
import { clearStandardsBase, rememberStandardsBase, resolveStandardsBase } from '../runner/standards-base';
import { detectedStackId, proposeProfile } from '../standards/propose';
import { detectConventions } from '../ai-rules/project-detector';
import { STACK_IDS, isStackId } from '../server/stacks';
import type { Plan } from '../models/types';
import { reportingSecretValues, wireTaskReporting } from './task-reporting';
import { createRedactor, Redactor } from '../utils/redact';
import { OnosooConfig, resolveOnosooConfig } from './onosoo-config';
import { OnosooSpool } from './onosoo-spool';
import { OnosooRelay, RelayHttpClient, RunMeta } from './onosoo-relay';

/** How long a freshly launched headless sandbox gets to report `running`. */
const UAT_SANDBOX_READY_TIMEOUT_MS = 120_000;

export interface Args {
  command: string;
  planPath?: string;
  cwd: string;
  noInteractive: boolean;
  fullAuto: boolean;
  engine?: string;
  prompt?: string;
  /** Raw non-flag positional args, in order (e.g. config subcommand + value). */
  positionals: string[];
  // loop-only
  repo?: string;
  label?: string;
  intervalSec: number;
  once: boolean;
  // daemon-only
  configPath?: string;
  maxTicks?: number;
  // verify-only
  prdPath?: string;
  verify: boolean;
  fix: boolean;
  maxIterations?: number;
  gates: string[];
  /** Browser UAT mode from the CLI. Undefined means "use the setting". */
  uatMode?: 'off' | 'auto' | 'required';
  /** Spec filter for the browser UAT gate. */
  uatSpec?: string;
  /** Open a pull request for the committed work once the run finishes. */
  pr?: boolean;
  /** Target branch for --pr; gh picks the repo default when omitted. */
  prBase?: string;
  /** Lower bound for `digest`, any value git --since understands. */
  since?: string;
  /** `land` only: actually merge, instead of reporting what would happen. */
  merge?: boolean;
  /** `land` only: the branch to land into; defaults to the current one. */
  into?: string;
  /** `trace` only: report a single requirement ID (`R-<n>`). */
  req?: string;
  /** `--plan` was given without a path (end of argv, or followed by another flag). */
  planFlagMissing?: boolean;
  /** `bench` only: use the fake engine (zero spend). */
  dryRun?: boolean;
  /** `bench` only: output directory, resolved against the final --cwd ('' when the flag had no value). */
  out?: string;
  /** `bench` only: hard spend cap in USD; NaN when the value was not a positive number. */
  maxUsd?: number;
  /** `bench` only: let a paid run go ahead although a scenario environment probe failed. */
  allowFailedProbes?: boolean;
  /** Verify: a server-written standards job file. Takes the place of `.moag/standards.json`. */
  standardsPath?: string;
  /**
   * Turn project standards off for this invocation: no standards block in task prompts and
   * no standards gate in verification, even when the workspace has a standards file.
   */
  noStandards?: boolean;
  /** Verify: the ref the standards gate diffs against. Undefined means the captured run base, else HEAD. */
  base?: string;
  /** `standards propose` only: save the proposal to `.moag/standards.json`. */
  write?: boolean;
  /** `standards propose --write` only: replace an existing file that differs from the proposal. */
  force?: boolean;
  /** `standards propose` only: the stack whose built-in profile the proposal starts from ('' when the flag had no value). */
  stack?: string;
  /** `standards check` only: check the static rules but run none of the profile's commands. */
  noCommands?: boolean;
}

/** The closed set of UAT modes, as a runtime guard for untrusted config values. */
const UAT_MODES = ['off', 'auto', 'required'] as const;

/** Coerce any config value onto a valid mode; anything unrecognised becomes `auto`. */
function normalizeUatMode(value: unknown): 'off' | 'auto' | 'required' {
  return (UAT_MODES as readonly string[]).includes(String(value))
    ? (value as 'off' | 'auto' | 'required')
    : 'auto';
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? '', cwd: process.cwd(), positionals: [],
    noInteractive: false, fullAuto: false, intervalSec: 300, once: false,
    verify: false, fix: false, gates: [],
  };
  const rest = argv.slice(1);
  let planFlag: string | undefined;
  let outFlag: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--no-interactive') { a.noInteractive = true; }
    else if (arg === '--full-auto') { a.fullAuto = true; }
    else if (arg === '--once') { a.once = true; }
    else if (arg === '--verify') { a.verify = true; }
    else if (arg === '--fix') { a.fix = true; }
    else if (arg === '--engine') { a.engine = rest[++i]; }
    else if (arg === '--prompt') { a.prompt = rest[++i]; }
    else if (arg === '--cwd') { a.cwd = path.resolve(rest[++i]); }
    else if (arg === '--repo') { a.repo = rest[++i]; }
    else if (arg === '--label') { a.label = rest[++i]; }
    else if (arg === '--interval') { a.intervalSec = Math.max(10, parseInt(rest[++i], 10) || 300); }
    else if (arg === '--config') { a.configPath = path.resolve(a.cwd, rest[++i]); }
    else if (arg === '--max-ticks') { a.maxTicks = Math.max(1, parseInt(rest[++i], 10) || 1); }
    else if (arg === '--prd') { a.prdPath = path.resolve(a.cwd, rest[++i]); }
    // A 0 here would make the loop a no-op, so the floor is 1.
    else if (arg === '--max-iterations') { a.maxIterations = Math.max(1, parseInt(rest[++i], 10) || 1); }
    else if (arg === '--gate') { const g = rest[++i]; if (g) { a.gates.push(g); } }
    // --uat / --no-uat are plain booleans, so passing both is simply last-wins.
    else if (arg === '--uat') { a.uatMode = 'required'; }
    else if (arg === '--no-uat') { a.uatMode = 'off'; }
    else if (arg === '--uat-spec') { const s = rest[++i]; if (s) { a.uatSpec = s; } }
    else if (arg === '--standards') { const s = rest[++i]; if (s) { a.standardsPath = path.resolve(a.cwd, s); } }
    else if (arg === '--no-standards') { a.noStandards = true; }
    else if (arg === '--base') { const b = rest[++i]; if (b) { a.base = b; } }
    else if (arg === '--write') { a.write = true; }
    else if (arg === '--force') { a.force = true; }
    else if (arg === '--no-commands') { a.noCommands = true; }
    // A bare --stack becomes '' so cmdStandards reports it as a usage error.
    else if (arg === '--stack') {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) { a.stack = ''; } else { a.stack = v; i++; }
    }
    else if (arg === '--since') { const v = rest[++i]; if (v) { a.since = v; } }
    else if (arg === '--merge') { a.merge = true; }
    else if (arg === '--dry-run') { a.dryRun = true; }
    else if (arg === '--allow-failed-probes') { a.allowFailedProbes = true; }
    else if (arg === '--out') {
      const v = rest[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) { outFlag = ''; } else { outFlag = v; i++; }
    }
    else if (arg === '--max-usd') {
      const n = Number(rest[++i]);
      a.maxUsd = Number.isFinite(n) && n > 0 ? n : NaN;
    }
    else if (arg === '--into') { const v = rest[++i]; if (v) { a.into = v; } }
    else if (arg === '--pr') { a.pr = true; }
    else if (arg === '--pr-base') { const b = rest[++i]; if (b) { a.prBase = b; } }
    // Resolved after the loop so a later --cwd still applies, whatever the flag order.
    // A bare --plan (nothing after it, or another flag) is recorded, never silently ignored:
    // `moag trace --plan` would otherwise fall back to .moag/plan.json and report the wrong plan.
    else if (arg === '--plan') {
      const v = rest[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) { a.planFlagMissing = true; } else { planFlag = v; i++; }
    }
    // A bare trailing --req becomes '' so traceArgsError reports it as a usage error.
    else if (arg === '--req') { a.req = rest[++i] ?? ''; }
    else if (!arg.startsWith('--')) {
      // `queue`/`config` read their verb from positionals; `run`/`verify` take a plan path.
      a.positionals.push(arg);
      if (!a.planPath) { a.planPath = path.resolve(a.cwd, arg); }
    }
  }
  // `trace` resolves its positional plan path like --plan: against the FINAL --cwd,
  // whatever the flag order (`moag trace plan.json --cwd repo` reads repo/plan.json).
  if (a.command === 'trace' && planFlag === undefined && a.positionals.length > 0) {
    a.planPath = path.resolve(a.cwd, a.positionals[0]);
  }
  if (planFlag !== undefined) { a.planPath = path.resolve(a.cwd, planFlag); }
  if (outFlag !== undefined) { a.out = outFlag === '' ? '' : path.resolve(a.cwd, outFlag); }
  return a;
}

/**
 * Sees every emitted line after it is written to stdout — the ONOSOO relay while a
 * relay-enabled `moag run` is live, null otherwise. Module-level: one cmdRun per process.
 */
let emitTap: ((line: Record<string, unknown>) => void) | null = null;

function emit(obj: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), ...obj };
  process.stdout.write(JSON.stringify(line) + '\n');
  try { emitTap?.(line); } catch { /* the relay never disturbs the run */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
/** What the post-shim commands need. Exported so tests can drive a command with fakes. */
export interface Ctx {
  runner: any;
  vscode: any;
  TaskStatus: any;
  loadPlan: (p: string) => any;
  /** Test seams for `moag run`'s task reporting and ONOSOO relay. Absent in production. */
  relayDeps?: RelayDeps;
}

/** Injected dependencies of `moag run`'s reporting and relay; every field defaults to the real thing. */
export interface RelayDeps {
  env?: NodeJS.ProcessEnv;
  http?: RelayHttpClient;
  /** Builds the reporting redactor; `extra` holds the relay's device key when one is configured. */
  makeRedactor?: (extra: string[]) => Redactor;
  stderr?: (s: string) => void;
  isPidAlive?: (pid: number) => boolean;
  closeDeadlineMs?: number;
  /** `moag daemon` only: register a callback that stops the daemon (tests use it instead of a signal). */
  onDaemonStop?: (stop: () => void) => void;
  /** `moag daemon` only: how a second stop signal exits (process.exit in production). */
  exit?: (code: number) => void;
}

/**
 * Give a headless runner the two things the extension host gives its own: the AI rules
 * store and the project standards. Headless has no global storage, so the rules store is
 * workspace-tier only (`<cwd>/.moag/rules.json`); standards come from `<cwd>/.moag/standards.json`.
 *
 * Both files are trusted here because the workspace is the user's own. The hosted server's
 * worker must NOT call this — it is handed approved standards by the server instead.
 *
 * With `standards: false` (`--no-standards`) the runner gets the rules store only: no
 * standards block reaches any prompt, and no standards base is captured.
 */
export function wireRunnerStandards(runner: any, cwd: string, opts: { standards?: boolean } = {}): void {
  const { AiRulesStore } = require('../ai-rules/rules-store');
  const { createLocalStandardsProvider } = require('../standards/local-store');
  runner.setAiRulesStore(new AiRulesStore(null));
  if (opts.standards === false) { return; }
  runner.setStandardsProvider(createLocalStandardsProvider(cwd));
  // Before the run's first task: remember where the tree stood, so a later check still
  // sees work the run committed.
  runner.setRunStartHook(() => rememberStandardsBase(cwd, new Date(), captureHeadRef));
}

/**
 * Shared headless bootstrap. Installs the shim, then loads vscode-dependent modules.
 * `mementoPath` puts the runner's history somewhere other than `<cwd>/.moag` (the remote
 * child keeps it outside the worktree). Exported for the remote child.
 */
export async function setup(args: Args, opts: { mementoPath?: string } = {}): Promise<Ctx> {
  installVscodeShim(args.cwd);
  const { loadPlan } = require('../models/plan');
  const { TaskRunner } = require('../runner/runner');
  const { HistoryStore } = require('../history/store');
  const { registerAllEngines } = require('../adapters/index');
  const vscode = require('vscode');
  const { TaskStatus } = require('../models/types');

  if (args.fullAuto) {
    await vscode.workspace.getConfiguration('agentTaskPlayer').update('fullAuto', true);
  }
  registerAllEngines();

  const memento = new FileMemento(opts.mementoPath ?? path.join(args.cwd, '.moag', 'headless-state.json'));
  const runner = new TaskRunner(new HistoryStore(memento));
  wireRunnerStandards(runner, args.cwd, { standards: !args.noStandards });
  // No runner.dispose() here on purpose: the CLI process is short-lived and
  // owns exactly one runner, so its cost-ledger subscription dies with the
  // process. The extension host, which outlives many runners, does dispose.
  return { runner, vscode, TaskStatus, loadPlan };
}

/** What halted a run, exposed to the commands that need to act on the reason. */
export interface RunnerEventState {
  manualGateHit(): boolean;
  manualGateTaskId(): string | null;
  budgetHit(): boolean;
}

/** Wire runner events to JSONL output. Returns accessors for why a run halted. */
export function wireEvents(runner: any): RunnerEventState {
  let manualGateHit = false;
  let manualGateTaskId: string | null = null;
  let budgetHit = false;
  runner.on('state-changed', (state: string) => emit({ event: 'state', state }));
  runner.on('task-started', (t: any) => emit({ event: 'task-started', id: t.id, name: t.name }));
  // The final status says which: task-completed also fires for a Skipped task, task-failed
  // for a Blocked one (a failed dependency, or failurePolicy "mark-blocked").
  runner.on('task-completed', (t: any) => emit({ event: 'task-completed', id: t.id, name: t.name, status: t.status }));
  runner.on('task-failed', (t: any) => emit({ event: 'task-failed', id: t.id, name: t.name, status: t.status }));
  runner.on('task-escalate', (t: any, category: string) => emit({ event: 'task-escalate', id: t.id, name: t.name, category }));
  runner.on('incident', (t: any, summary: string, issueUrl: string | null) => emit({ event: 'incident', id: t.id, name: t.name, summary, issueUrl }));
  runner.on('error', (err: Error) => emit({ event: 'error', message: err.message }));
  // Automatic dependency installs: the event already carries every field of the protocol line.
  runner.on('dependencies-installed', (_t: any, ev: Record<string, unknown>) => emit(ev));
  runner.on('dependencies-install-failed', (_t: any, ev: Record<string, unknown>) => emit(ev));
  runner.on('dependencies-not-installed', (_t: any, ev: Record<string, unknown>) => emit(ev));
  // Headless has no human to answer a Continue/Stop prompt, so a breached ceiling always stops.
  runner.on('budget-exceeded', (d: any) => {
    budgetHit = true;
    emit({ event: 'budget-exceeded', totalCost: d.totalCost, budget: d.budget });
    runner.stop();
  });
  runner.on('manual-gate', (t: any) => {
    manualGateHit = true;
    manualGateTaskId = t.id;
    emit({ event: 'manual-gate', id: t.id, name: t.name, note: 'Halting for human approval (ship gate).' });
    // Deferred on purpose (as in src/server/run-worker.ts): stop() inside this
    // emit aborts the task signal BEFORE runManualTask attaches its abort
    // listener, so the gate promise never settles and play() never resolves —
    // exit 3 would hang until the watchdog. One tick later the listener is attached.
    setImmediate(() => runner.stop());
  });
  return {
    manualGateHit: () => manualGateHit,
    manualGateTaskId: () => manualGateTaskId,
    budgetHit: () => budgetHit,
  };
}

function tally(plan: any, TaskStatus: any): { total: number; completed: number; failed: number } {
  const tasks = plan.playlists.flatMap((pl: any) => pl.tasks);
  return {
    total: tasks.length,
    completed: tasks.filter((t: any) => t.status === TaskStatus.Completed).length,
    failed: tasks.filter((t: any) => t.status === TaskStatus.Failed).length,
  };
}

// ─── verify helpers (pure — unit-testable without booting the CLI) ───────────

/** 2 when the command cannot run as invoked, null when the args are usable. */
export function verifyArgsError(args: Args): number | null {
  if (!args.planPath) { return 2; }
  return null;
}

/**
 * Resolve PRD text for an unattended run:
 * plan.prdSource → first playlist prdContext → --prd → detected file → null.
 * Never prompts — there is no human at the other end.
 */
export function resolvePrdTextHeadless(plan: any, args: Args, cwd: string): string | null {
  if (plan?.prdSource) { return plan.prdSource as string; }
  const firstContext = plan?.playlists?.find((pl: any) => pl.prdContext)?.prdContext;
  if (firstContext) { return firstContext as string; }
  if (args.prdPath) {
    try { return fs.readFileSync(args.prdPath, 'utf-8'); } catch { return null; }
  }
  const detected = detectPrdFile(cwd);
  if (detected) {
    try { return fs.readFileSync(path.join(cwd, detected), 'utf-8'); } catch { return null; }
  }
  return null;
}

/**
 * Map a verification report onto a process exit code.
 * 0 ok · 1 gaps remain · 2 error/usage · 3 ship gate · 4 cost ceiling.
 */
export function exitCodeForReport(report: { passed: boolean; haltReason: HaltReason | null }): number {
  if (report.passed) { return 0; }
  switch (report.haltReason) {
    case 'manual-gate': return 3;
    case 'budget-exceeded': return 4;
    case 'engine-error': return 2;
    case 'no-prd': return 2;
    default: return 1;
  }
}

/** A per-run budget setting as a usable number: anything non-finite or negative disables it (0). */
function normalizeBudgetUsd(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * The standards a verification is checked against.
 *
 * `--standards <file>` (a server-written job file, which carries its own base ref) wins;
 * then `--no-standards`; otherwise the workspace's own `.moag/standards.json`, diffed
 * against `--base`. The hosted worker always passes one of the two flags, so a server
 * run never falls through to a file the repository shipped.
 *
 * Throws a file-naming error when a standards file exists but is invalid — a broken
 * file must stop verification, not quietly turn the gate off.
 *
 * `preloaded` takes the place of every file: the hosted worker reads its job file ONCE,
 * before the agent runs, and hands what it read to each later check. Reading the file
 * again afterwards would mean trusting whatever the agent left in the run directory.
 */
export function resolveVerifyStandards(args: Args, preloaded?: NonNullable<PrdLoopConfig['standards']>): PrdLoopConfig['standards'] {
  if (preloaded) {
    return { profile: preloaded.profile, version: preloaded.version, baseRef: preloaded.baseRef };
  }
  if (args.standardsPath) {
    const job = readStandardsJobFile(args.standardsPath);
    return { profile: job.profile, version: job.version, baseRef: job.baseRef };
  }
  if (args.noStandards) { return null; }
  const doc = loadLocalStandards(args.cwd);
  return doc ? { profile: doc.profile, version: doc.version, baseRef: args.base ?? null } : null;
}

/**
 * What a `verify-standards` line says the check was made against: the hash of the profile
 * actually used and the base ref it was told to diff from (the report's own `baseRef` is
 * the one the diff ended up using, which differs when the recorded base was lost).
 *
 * The hosted server compares both with what it froze on the run record. A job file
 * rewritten after the agent ran — self-consistently, hash included — is caught there,
 * because this is computed from the profile in hand, not copied from the file.
 */
function standardsAttestation(standards: NonNullable<PrdLoopConfig['standards']>): { contentHash: string; recordedBaseRef: string | null } {
  return { contentHash: profileHash(standards.profile), recordedBaseRef: standards.baseRef };
}

// ─── standards check without a run ───────────────────────────────────────────

/** How long one profile command may run when no settings are loaded to say otherwise. */
const STANDARDS_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Check the working tree against a standards profile: the static rules over the diff
 * since `baseRef`, then the profile's commands through `runGate`. No runner, no engine,
 * no model call.
 *
 * The order and the stopping rules are the PRD loop's: commands run only when no static
 * rule failed, and stop at the first one that fails. A command that did not run is
 * `not-checked` with the reason — never `passed`.
 */
export async function checkStandardsNow(
  standards: NonNullable<PrdLoopConfig['standards']>,
  cwd: string,
  opts: {
    signal: AbortSignal; commands: boolean; timeoutMs?: number;
    /** Automatic dependency installs before the profile's commands. */
    dependencies: DependencyInstallSettings;
    onDependencyEvent: (ev: DependencyEvent) => void;
  },
): Promise<StandardsReport> {
  const input = await collectStandardsInput(cwd, standards.baseRef, {
    probeDirs: standards.profile.structure.requiredDirs,
    designPaths: standards.profile.design ? [standards.profile.design.docPath, standards.profile.design.tokensPath] : undefined,
  });
  const report = checkStandards(standards.profile, input);
  report.version = standards.version;
  // Only a blocking failure stops the commands: an advisory finding is no reason not to lint.
  let skip: string | null = !opts.commands ? 'Commands were not run'
    : standardsBlocked(report) ? 'A standards rule failed first' : null;
  let commands = standards.profile.commands;
  if (!skip && commands.length > 0) {
    // The profile's commands (lint, format) usually need the project's dependencies.
    const install = await ensureDependencies(cwd, {
      settings: opts.dependencies,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? STANDARDS_COMMAND_TIMEOUT_MS,
      stage: 'standards',
      onEvent: opts.onDependencyEvent,
    });
    if (install.aborted) {
      skip = 'The check was stopped';
    } else if (!install.ok) {
      const failed = install.failed;
      const [first, ...rest] = commands;
      const reason = `Dependencies could not be installed (\`${failed?.command ?? 'install'}\` exited ${failed?.exitCode ?? 1})\n`;
      report.rules.push(commandRow({
        result: 'failed', command: first.run, exitCode: failed?.exitCode || 1,
        tail: (reason + (failed?.tail ?? '')).slice(-MAX_REPORT_TAIL_CHARS),
      }));
      skip = 'Dependencies could not be installed';
      commands = rest;
    }
  }
  for (const cmd of commands) {
    if (!skip && opts.signal.aborted) { skip = 'The check was stopped'; }
    if (skip) {
      report.rules.push(commandRow({ result: 'not-checked', reason: skip, command: cmd.run }));
      continue;
    }
    const result = await runGate(cmd.run, { cwd, signal: opts.signal, timeoutMs: opts.timeoutMs ?? STANDARDS_COMMAND_TIMEOUT_MS });
    report.rules.push(commandRow({
      result: result.passed ? 'passed' : 'failed', command: cmd.run, exitCode: result.exitCode,
      tail: result.output.slice(-MAX_REPORT_TAIL_CHARS),
    }));
    if (!result.passed) { skip = 'An earlier standards command failed'; }
  }
  report.totals = recountTotals(report);
  return report;
}

/**
 * The standards gate on its own, for the moment a hosted run halts at its ship gate: the
 * approver gets a real result to look at before deciding, without waiting for the
 * verification pass that only runs after approval. Informational — the authoritative
 * check is still the one in `runVerifyCore`.
 *
 * Emits one `verify-standards` line with `phase: 'pre-gate'` and returns the report.
 * Returns null, emitting nothing, when the arguments name no standards or the check was
 * stopped part-way (a half-finished report would read as a result). Throws when the
 * standards file is unreadable or invalid; the caller decides what that means.
 *
 * `preloaded` is what the worker read from its job file at start: with it, nothing is read
 * from disk here, so the profile and its commands are the ones the server approved even
 * if the file was rewritten while the agent ran.
 */
export async function runStandardsCheckCore(
  args: Args, signal: AbortSignal, preloaded?: NonNullable<PrdLoopConfig['standards']>,
): Promise<StandardsReport | null> {
  const standards = resolveVerifyStandards(args, preloaded);
  if (!standards || signal.aborted) { return null; }
  const recorded = { ...standards };
  // A job file carries its own base ref. The workspace file names none: without --base
  // that is the base captured at run start, or HEAD when none was.
  if (!preloaded && !args.standardsPath && args.base === undefined) {
    standards.baseRef = await resolveStandardsBase(args.cwd, undefined, captureHeadRef);
  }
  const report = await checkStandardsNow(standards, args.cwd, {
    signal, commands: true, dependencies: standardsDependencySettings(args.cwd), onDependencyEvent: (ev) => emit({ ...ev }),
  });
  if (signal.aborted) { return null; }
  const capped = capStandardsReport(report);
  emit({ event: 'verify-standards', phase: 'pre-gate', ...capped, ...standardsAttestation(recorded) });
  return capped;
}

/**
 * Dependency-install settings for a standards check. The worker (and the unit tests) have a
 * host installed; `moag standards` deliberately runs without the shim, so there it reads
 * `.moag/config.json` through the shim's config reader directly — every shape it accepts.
 */
function standardsDependencySettings(cwd: string): DependencyInstallSettings {
  try {
    return readDependencyInstallSettings(getConfig('agentTaskPlayer'));
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shim = require('./vscode-shim');
    shim.__setWorkspaceRoot(cwd);
    return readDependencyInstallSettings(shim.workspace.getConfiguration('agentTaskPlayer'));
  }
}

/** Build the loop config from settings, with CLI flags taking precedence. */
export function buildVerifyConfig(args: Args, ctx: Ctx, preloaded?: NonNullable<PrdLoopConfig['standards']>): PrdLoopConfig {
  const cfg = ctx.vscode.workspace.getConfiguration('agentTaskPlayer');
  return {
    cwd: args.cwd,
    maxFixIterations: args.maxIterations ?? cfg.get('prdLoop.maxFixIterations', 3),
    gateCommands: args.gates.length > 0 ? args.gates : cfg.get('prdLoop.gateCommands', []),
    gateTimeoutMs: cfg.get('prdLoop.gateTimeoutMs', 600_000),
    maxDiffChars: cfg.get('prdLoop.maxDiffChars', 40_000),
    onManualGate: cfg.get('prdLoop.onManualGate', 'halt'),
    versionBudgetUsd: normalizeBudgetUsd(cfg.get('prdLoop.versionBudgetUsd', 0)),
    fix: args.fix,
    // Unattended: an undetectable repo is a hard failure, not a warning.
    unattended: true,
    uat: {
      // CLI flag → setting → default, exactly like --gate above. An unrecognised
      // setting value degrades to 'auto' rather than throwing.
      mode: args.uatMode ?? normalizeUatMode(cfg.get('prdLoop.uat.mode', 'auto')),
      command: cfg.get('prdLoop.uat.command', ''),
      specPath: args.uatSpec ?? cfg.get('prdLoop.uat.specPath', ''),
      timeoutMs: cfg.get('prdLoop.uat.timeoutMs', 900_000),
    },
    dependencies: readDependencyInstallSettings(cfg),
    standards: resolveVerifyStandards(args, preloaded),
  };
}

/**
 * Run the PRD loop over an already-loaded plan and write the full report to
 * `.moag/verification-<ts>.json`. Shared by `moag verify` and `moag run --verify`.
 * `persist` decides what the loop's saves write: `'plan'` (moag verify) saves the whole
 * plan; `'trace'` (moag run --verify) writes only `requirementTrace` and `fixIterations`,
 * because a headless run never persists its task statuses.
 *
 * `opts.standards` is the hosted worker's job standards as it read them at start; see
 * {@link resolveVerifyStandards}.
 */
export async function runVerifyCore(
  args: Args, ctx: Ctx, plan: any, events: RunnerEventState, persist: 'plan' | 'trace',
  opts: { standards?: NonNullable<PrdLoopConfig['standards']> } = {},
): Promise<number> {
  const { savePlan } = require('../models/plan');
  const { getEngine } = require('../adapters/index');
  // Loaded here, inside the post-shim region, for consistency with setup().
  const { SandboxManager, isPortOpen } = require('../sandbox/sandbox-manager');
  const { detectProject } = require('../sandbox/project-detector');

  let cfgForUat: PrdLoopConfig;
  /** True when the standards are the workspace's own file, whose base this process manages. */
  const localStandards = !opts.standards && !args.standardsPath;
  try {
    cfgForUat = buildVerifyConfig(args, ctx, opts.standards);
    // The workspace file names no base. Without --base that is the commit captured when the
    // run started — so work the run committed is still inside the diff — or, with none
    // captured, HEAD as it stands now.
    if (cfgForUat.standards && localStandards && args.base === undefined) {
      cfgForUat.standards.baseRef = await resolveStandardsBase(args.cwd, undefined, captureHeadRef);
    }
  } catch (err) {
    emit({ event: 'error', message: err instanceof Error ? err.message : String(err) });
    return 2;
  }
  const sandbox: { mgr: any | null } = { mgr: null };

  const abort = new AbortController();
  const onSignal = (): void => {
    emit({ event: 'verify-stopping' });
    abort.abort();
    ctx.runner.stop();
    // A dev server started for UAT must die with the CLI, not outlive it.
    try { sandbox.mgr?.stop(); } catch { /* best effort */ }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  /** The port the UAT sandbox is expected to serve on. */
  const uatPort = (): number => {
    const configured = plan?.sandbox?.port ?? plan?.sandbox?.targets?.[0]?.port;
    if (typeof configured === 'number' && configured > 0) { return configured; }
    try {
      const info = detectProject(args.cwd);
      if (info && info.defaultPort > 0) { return info.defaultPort; }
    } catch { /* fall through to the conventional default */ }
    return 3000;
  };

  /**
   * Bring up a sandbox for the browser UAT gate, or resolve null.
   *
   * Preflights the port: if something is ALREADY listening we refuse rather than
   * test against a server this run does not control (and never kill it) — a green
   * UAT against a stale process is worse than no UAT at all.
   */
  const prepareUat = async (signal: AbortSignal): Promise<UatSession | null> => {
    try {
      if (signal.aborted) { return null; }
      const port = uatPort();
      if (await isPortOpen(port)) {
        emit({
          event: 'verify-progress',
          phase: 'warning',
          detail: `Port ${port} is already in use; refusing to run UAT against a server this run did not start.`,
        });
        return null;
      }

      const mgr = new SandboxManager();
      sandbox.mgr = mgr;
      const url = await new Promise<string | null>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: string | null): void => {
          if (settled) { return; }
          settled = true;
          try {
            mgr.off('state-changed', onState);
            signal.removeEventListener('abort', onAbort);
          } finally {
            if (timer) { clearTimeout(timer); timer = null; }
            resolve(value);
          }
        };
        const onState = (s: { status: string; url: string | null }): void => {
          if (s.status === 'running' && s.url) { finish(s.url); }
          else if (s.status === 'error' || s.status === 'stopped') { finish(null); }
        };
        const onAbort = (): void => finish(null);
        mgr.on('state-changed', onState);
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(null), UAT_SANDBOX_READY_TIMEOUT_MS);
        void Promise.resolve(mgr.launch(args.cwd, plan?.sandbox)).catch(() => finish(null));
      });

      if (!url) {
        try { mgr.stop(); } catch { /* best effort */ }
        sandbox.mgr = null;
        return null;
      }
      return {
        baseUrl: url,
        startedByUs: true,
        dispose: (): void => {
          try { mgr.stop(); } catch { /* best effort */ }
          sandbox.mgr = null;
        },
      };
    } catch {
      // Never let a rejection escape into the loop — null means "gate unavailable".
      return null;
    }
  };

  // Assigned below; the runPlan seam needs to reach the controller it belongs to.
  const holder: { controller: ReturnType<typeof createPrdLoop> | null } = { controller: null };
  const persistTrace = persist === 'trace' && args.planPath ? tracePersister(plan, args.planPath) : null;

  try {
    const controller = createPrdLoop(cfgForUat, {
      plan,
      resolvePrdText: async () => resolvePrdTextHeadless(plan, args, args.cwd),
      runPlan: async (p: any) => {
        await ctx.runner.play(p);
        // The wired events already stopped the runner; tell the loop why.
        if (events.manualGateHit()) { holder.controller?.noteManualGate(events.manualGateTaskId() ?? ''); }
        if (events.budgetHit()) { holder.controller?.noteBudgetExceeded(); }
      },
      runEngine: (prompt: string, signal: AbortSignal) =>
        getEngine(plan.defaultEngine).runTask({ prompt, cwd: args.cwd, signal, costLabel: 'prd-loop' }),
      savePlan: () => {
        if (persistTrace) { persistTrace(); return; }
        if (args.planPath) {
          try { savePlan(plan, args.planPath); }
          catch (err) { emit({ event: 'error', message: err instanceof Error ? err.message : String(err) }); }
        }
      },
      onProgress: (phase: string, detail: string) => emit({ event: 'verify-progress', phase, detail }),
      emitReport: (r: PrdLoopReport) => emit({
        event: 'verify-report',
        passed: r.passed,
        score: r.score,
        haltReason: r.haltReason,
        failedGate: r.failedGate,
      }),
      onDependencyEvent: (ev) => emit({ ...ev }),
      skipManualGate: (taskId: string) => ctx.runner.skipManualGate(taskId),
      prepareUat,
      // Per-run PRD budget: lazy, so the ledger singleton loads inside the post-shim region.
      subscribeSpend: (cb: (usd: number) => void) =>
        require('../utils/cost-ledger').costLedger.onRecord((e: { estimatedCostUsd: number }) => cb(e.estimatedCostUsd)),
      stopRun: () => ctx.runner.stop(),
      signal: abort.signal,
    });
    holder.controller = controller;

    emit({ event: 'verify-started', plan: plan.name, fix: args.fix });
    const report = await controller.run();

    const reportPath = path.join(args.cwd, '.moag', `verification-${Date.now()}.json`);
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      // The standards row is stored in words, never as a bare "passed: true".
      fs.writeFileSync(reportPath, JSON.stringify({ ...report, gates: gatesForStoredReport(report.gates) }, null, 2), 'utf-8');
    } catch (err) {
      emit({ event: 'error', message: `Could not write verification report: ${err instanceof Error ? err.message : String(err)}` });
    }

    // Per-rule standards results, bounded so the line stays far below the worker protocol's
    // limit. Emitted before verify-finished, and only when a standards gate was configured.
    if (report.standards) {
      emit({
        event: 'verify-standards', phase: 'verify', ...capStandardsReport(report.standards),
        ...(cfgForUat.standards ? standardsAttestation(cfgForUat.standards) : {}),
      });
    }

    // Verified: the work since the captured base has been judged and accepted. The next
    // run captures a new base. A failed or halted verification keeps the old one, so
    // nothing unverified ever drops out of the diff.
    if (report.passed && localStandards && cfgForUat.standards) { clearStandardsBase(args.cwd); }

    emit({
      event: 'verify-finished',
      passed: report.passed,
      score: report.score,
      haltReason: report.haltReason,
      failedGate: report.failedGate,
      iterations: report.iterations,
      modelCallsMade: report.modelCallsMade,
      gateCommandsEmpty: report.gateCommandsEmpty,
      uatRan: report.uatRan,
      uatSkipReason: report.uatSkipReason,
      changedFiles: report.changedFiles.length,
      reportPath,
    });
    return exitCodeForReport(report);
  } catch (err) {
    emit({ event: 'error', message: err instanceof Error ? err.message : String(err) });
    return 2;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

// ─── command: run ────────────────────────────────────────────────────────────

/** `moag run`. Exported so tests can drive it with a fake runner. */
export async function cmdRun(args: Args, ctx: Ctx): Promise<number> {
  let plan;
  let planPath: string;
  if (args.prompt) {
    // One-shot mode: synthesise a single agent task from the prompt, like `claude "<text>"`.
    // Resolve the engine: explicit flag wins, else the persistent default (.moag/config.json).
    const engineId = args.engine
      ?? ctx.vscode.workspace.getConfiguration('agentTaskPlayer').get('defaultEngine', 'claude');
    plan = buildPromptPlan(args.prompt, engineId);
    planPath = '<inline prompt>';
  } else {
    planPath = args.planPath!;
    try { plan = ctx.loadPlan(planPath); }
    catch (err) { process.stderr.write(`Failed to load plan: ${err instanceof Error ? err.message : String(err)}\n`); return 2; }
    if (args.engine) { plan.defaultEngine = args.engine; }
  }

  const events = wireEvents(ctx.runner);
  // After wireEvents, so task-changes / task-error-tail follow the task's own line.
  // Injected in tests; otherwise process.env plus the relay variables main() took out of it.
  const env = ctx.relayDeps?.env ?? relayConfigEnv();
  const redactorExtra: string[] = [];
  const buildRedactor = ctx.relayDeps?.makeRedactor
    ?? ((extra: string[]): Redactor => createRedactor(reportingSecretValues(args.cwd, env, extra)));
  const unwireReporting = wireTaskReporting(ctx.runner, {
    cwd: args.cwd,
    emit,
    makeRedactor: () => buildRedactor(redactorExtra),
  });
  let relay: OnosooRelay | null = null;
  try {
    const started = startRelay(args, ctx, plan, env, buildRedactor);
    // main() already did this; a caller that bypassed main() still must not leak the key to children.
    if (!ctx.relayDeps?.env) { forgetRelayEnv(process.env); }
    if (started) {
      relay = started.relay;
      // The device key is a secret of its own: it never appears in a reported diff or tail.
      redactorExtra.push(started.key);
      emitTap = (line) => started.relay.record(line);
    }
    return await runAfterWiring(args, ctx, plan, planPath, events);
  } finally {
    emitTap = null;
    if (relay) { await relay.close(); }
    unwireReporting();
  }
}

/** Remove the ONOSOO relay variables from `env` (the device key must not reach child processes). */
export function forgetRelayEnv(env: NodeJS.ProcessEnv): void {
  delete env.MOAG_ONOSOO_KEY;
  delete env.MOAG_ONOSOO_URL;
}

/** The relay variables as main() found them, before it removed them from process.env. */
let relayEnvSnapshot: { MOAG_ONOSOO_KEY?: string; MOAG_ONOSOO_URL?: string } | null = null;

/**
 * Take the ONOSOO relay variables out of `env` (process.env in main()), keeping a private
 * copy for `moag run`'s relay. Called first thing, so no command — and no agent or tool any
 * command spawns — ever inherits the device key.
 */
export function captureRelayEnv(env: NodeJS.ProcessEnv = process.env): void {
  relayEnvSnapshot = {
    ...(env.MOAG_ONOSOO_KEY !== undefined ? { MOAG_ONOSOO_KEY: env.MOAG_ONOSOO_KEY } : {}),
    ...(env.MOAG_ONOSOO_URL !== undefined ? { MOAG_ONOSOO_URL: env.MOAG_ONOSOO_URL } : {}),
  };
  forgetRelayEnv(env);
}

/** The env the relay configuration reads: process.env with main()'s captured relay variables over it. */
function relayConfigEnv(): NodeJS.ProcessEnv {
  return relayEnvSnapshot ? { ...process.env, ...relayEnvSnapshot } : process.env;
}

/**
 * Start the ONOSOO relay when a device key is configured (env MOAG_ONOSOO_KEY or the
 * user-level onosoo.json); null otherwise — then nothing is spooled, sent or timed.
 * Never throws: a relay that cannot start leaves the run exactly as it was.
 */
function startRelay(
  args: Args,
  ctx: Ctx,
  plan: any,
  env: NodeJS.ProcessEnv,
  buildRedactor: (extra: string[]) => Redactor,
): { relay: OnosooRelay; key: string } | null {
  const deps = ctx.relayDeps;
  const stderr = deps?.stderr ?? ((s: string): void => { process.stderr.write(s); });
  try {
    const cfg = resolveOnosooConfig({ env, cwd: args.cwd, stderr });
    if (!cfg) { return null; }
    let redactor: Redactor;
    try {
      redactor = buildRedactor([cfg.key]);
    } catch {
      // Every relayed event then carries { redaction_failed: true } instead of its data.
      redactor = { redact: (): never => { throw new Error('redactor unavailable'); } };
    }
    const spool = new OnosooSpool(cfg.stateDir, args.cwd, { isPidAlive: deps?.isPidAlive });
    const relay = new OnosooRelay({
      config: cfg, spool, http: deps?.http, redactor, stderr, closeDeadlineMs: deps?.closeDeadlineMs, cwd: args.cwd,
    });
    relay.start(buildRunMeta(plan, args.cwd));
    return { relay, key: cfg.key };
  } catch (err) {
    stderr(`ONOSOO relay could not start: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

/**
 * The relay-only `run-meta` facts for a plan: its name, the project's package.json
 * name (else the folder's base name — never a path), and each task's id and name in
 * plan order. Caps and redaction are the relay's.
 */
export function buildRunMeta(plan: any, cwd: string): RunMeta {
  let project = '';
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    const name = (pkg as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim().length > 0) { project = name; }
  } catch { /* no package.json */ }
  if (!project) { project = path.basename(path.resolve(cwd)); }
  const tasks = (plan?.playlists ?? []).flatMap((pl: any) => pl?.tasks ?? [])
    .map((t: any) => ({ id: String(t?.id), name: String(t?.name ?? '') }));
  return { plan_name: String(plan?.name ?? ''), project, tasks };
}

/** Emit a `cost` line per engine call during a run; returns the unsubscribe. Never throws. */
function subscribeRunCost(): () => void {
  try {
    const { costLedger } = require('../utils/cost-ledger');
    const offRecord = costLedger.onRecord((e: { estimatedCostUsd: number; costSource?: string }) =>
      emit({ event: 'cost', usd: e.estimatedCostUsd, source: e.costSource ?? 'estimated' }));
    const offUnreported = costLedger.onUnreported(() => emit({ event: 'cost', usd: 0, source: 'none' }));
    return (): void => { offRecord(); offUnreported(); };
  } catch {
    return (): void => undefined;
  }
}

/** What a caller other than cmdRun adds to the run: the delivery branch an ONOSOO remote run commits to. */
export interface RunExtra {
  branch?: string | null;
}

/**
 * The body of {@link cmdRun} once events and task reporting are wired. Exported for the
 * remote child (`moag remote-child`), which wires its own events and passes its branch.
 */
export async function runAfterWiring(
  args: Args, ctx: Ctx, plan: any, planPath: string, events: RunnerEventState, extra: RunExtra = {},
): Promise<number> {
  // Captured before the run so --pr can report what the run actually touched.
  const { captureBaseRef } = require('../runner/evidence');
  const prBaseRef = args.pr ? await captureBaseRef(args.cwd) : null;
  // The standards gate diffs against the tree as it was BEFORE the run: the run may commit,
  // and a base captured afterwards would hide exactly the work that needs checking. An
  // earlier run that was never verified left its own base behind; that one still stands.
  // A repository with no commits has no HEAD; the gate then treats every file as added.
  let verifyArgs = args;
  if (args.verify && args.base === undefined && !args.standardsPath && !args.noStandards) {
    const before: string | null = await resolveStandardsBase(args.cwd, undefined, captureHeadRef);
    if (before) { verifyArgs = { ...args, base: before }; }
  }
  // `branch` is null for a run started by hand; a remote run names the branch it delivers to.
  emit({ event: 'run-started', plan: plan.name, planPath, fullAuto: args.fullAuto, engine: plan.defaultEngine, branch: extra.branch ?? null });
  // Headless runs do not save the plan, except for requirement trace evidence (commits,
  // release stamps) the run recorded — that is persisted only when it actually changed.
  const persistTrace = !args.prompt && args.planPath ? tracePersister(plan, args.planPath) : (): void => undefined;
  // Every engine call's cost, in the hosted worker's shape (run-worker.ts subscribeCost), so ONOSOO
  // can total what the run spent. A call that reported no cost is counted as `source: 'none'`.
  const offCost = subscribeRunCost();
  try { await ctx.runner.play(plan); }
  catch (err) { offCost(); persistTrace(); emit({ event: 'error', message: err instanceof Error ? err.message : String(err) }); return 2; }
  offCost();
  persistTrace();

  const t = tally(plan, ctx.TaskStatus);
  const runCode = events.manualGateHit() ? 3 : (t.failed > 0 ? 1 : 0);
  // `code` is the run's own outcome, as the hosted worker reports it: ONOSOO derives the run's
  // status from it (0 completed, 1 gaps, 3 awaiting approval, 4 budget) and treats a missing one
  // as a failure.
  emit({ event: 'run-finished', ...t, manualGateHit: events.manualGateHit(), code: events.budgetHit() ? 4 : runCode });

  if (args.pr) { await openPullRequest(args, plan, prBaseRef); }

  if (!args.verify) { return runCode; }
  // A clean task tally is not evidence — fold the PRD verdict into the exit code.
  const verifyCode = await runVerifyCore(verifyArgs, ctx, plan, events, args.prompt ? 'plan' : 'trace');
  return runCode !== 0 ? runCode : verifyCode;
}

/**
 * A function that writes `plan.requirementTrace` to `planPath` via `persistRequirementTrace`
 * whenever it changed since the last write (or since this call, for the first). Never throws:
 * a failed write is emitted as an error event and retried on the next call.
 */
function tracePersister(plan: Plan, planPath: string): () => void {
  // The fix-iteration count rides along: without it on disk the next
  // `moag run --verify --fix` would start the ceiling over from 0.
  const snapshot = (): string => JSON.stringify([plan.requirementTrace ?? null, plan.fixIterations ?? null]);
  let persisted = snapshot();
  return (): void => {
    const current = snapshot();
    if (current === persisted) { return; }
    try {
      persistRequirementTrace(plan, planPath);
      persisted = current;
    } catch (err) {
      emit({ event: 'error', message: `Failed to save requirement trace: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
}

/**
 * Write only `requirementTrace` and `fixIterations` back to the plan file. The file is
 * re-read and just those keys are replaced (`fixIterations` so the PRD loop's fix ceiling
 * carries across runs), so the run's task statuses never reach disk — a full `savePlan` would make
 * the next `moag run` silently skip every task this run completed, release included. The
 * write goes to a sibling temp file that is renamed over the original, so a crash mid-write
 * cannot truncate the plan. Throws on an unreadable or unparsable plan file.
 */
export function persistRequirementTrace(plan: Plan, planPath: string): void {
  const { dehydratePlan } = require('../models/plan');
  const file = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error(`"${path.basename(planPath)}" is not a valid plan — expected a JSON object.`);
  }
  // dehydratePlan rebuilds the trace field by field; it omits the key when the trace is empty.
  const dehydrated = dehydratePlan(plan);
  const trace = dehydrated.requirementTrace;
  if (trace) { file.requirementTrace = trace; } else { delete file.requirementTrace; }
  // Same key and form as savePlan writes (an integer >= 0; 0 is a real value).
  if (typeof dehydrated.fixIterations === 'number') { file.fixIterations = dehydrated.fixIterations; } else { delete file.fixIterations; }
  const tmp = `${planPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
    fs.renameSync(tmp, planPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Open a PR for whatever the run committed. Never throws and never changes the
 * exit code: a run that succeeded did not fail because delivery was unavailable,
 * so the reason is emitted and the caller decides what to do about it.
 */
async function openPullRequest(args: Args, plan: any, baseRef: string | null): Promise<void> {
  const { createPullRequest, describeFailure } = require('../utils/pr');
  const { collectDiffEvidence } = require('../runner/evidence');
  const { TaskStatus } = require('../models/types');

  const evidence = baseRef
    ? await collectDiffEvidence(args.cwd, baseRef, { maxDiffChars: 1 })
    : { changedFiles: [] };

  const tasks = (plan.playlists ?? []).flatMap((pl: any) => pl.tasks ?? []).map((t: any) => ({
    name: t.name,
    completed: t.status === TaskStatus.Completed,
  }));

  const outcome = createPullRequest({
    cwd: args.cwd,
    title: plan.name || 'MOAG automated changes',
    planName: plan.name ?? '',
    tasks,
    changedFiles: evidence.changedFiles,
    base: args.prBase,
  });

  if (outcome.ok) {
    emit({ event: 'pr-created', url: outcome.url });
  } else {
    emit({ event: 'pr-skipped', reason: outcome.reason, message: describeFailure(outcome) });
  }
}

// ─── command: verify ─────────────────────────────────────────────────────────

async function cmdVerify(args: Args, ctx: Ctx): Promise<number> {
  const usageError = verifyArgsError(args);
  if (usageError !== null) {
    process.stderr.write('Usage: moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--max-iterations <n>]\n');
    return usageError;
  }
  let plan;
  try { plan = ctx.loadPlan(args.planPath!); }
  catch (err) { process.stderr.write(`Failed to load plan: ${err instanceof Error ? err.message : String(err)}\n`); return 2; }
  if (args.engine) { plan.defaultEngine = args.engine; }

  const events = wireEvents(ctx.runner);
  return runVerifyCore(args, ctx, plan, events, 'plan');
}

// ─── command: loop ───────────────────────────────────────────────────────────

async function cmdLoop(args: Args, ctx: Ctx): Promise<number> {
  if (!args.repo) { process.stderr.write('loop requires --repo <owner/repo>\n'); return 2; }
  const repo: string = args.repo;
  // Lazy-require the loop core (vscode-free, but keep all requires past shim install).
  const { fetchOpenIssues, newIssuesToTasks, reportIssueResult } = require('../github/issue-sync');
  const { createEmptyPlan, createPlaylist } = require('../models/plan');

  const events = wireEvents(ctx.runner);
  const known = new Set<string>();
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; emit({ event: 'loop-stopping' }); });

  emit({ event: 'loop-started', repo, label: args.label, intervalSec: args.intervalSec, once: args.once });

  let iteration = 0;
  do {
    iteration++;
    const issues = fetchOpenIssues({ repo, label: args.label, cwd: args.cwd });
    const tasks = newIssuesToTasks(issues, repo, known);
    emit({ event: 'loop-poll', iteration, openIssues: issues.length, newTasks: tasks.length });

    if (tasks.length > 0) {
      const plan = createEmptyPlan(`GitHub loop — ${args.repo}`);
      plan.playlists = [Object.assign(createPlaylist('GitHub Issues'), { tasks })];
      if (args.engine) { plan.defaultEngine = args.engine; }

      try { await ctx.runner.play(plan); }
      catch (err) { emit({ event: 'error', message: err instanceof Error ? err.message : String(err) }); }

      // Report each issue-backed task's final status back to GitHub (close the loop).
      for (const task of tasks) {
        if (!task.sourceIssueNumber || !task.sourceIssueRepo) { continue; }
        const success = task.status === ctx.TaskStatus.Completed;
        reportIssueResult(task.sourceIssueRepo, task.sourceIssueNumber, { success }, { cwd: args.cwd });
        emit({ event: 'issue-reported', issue: task.sourceIssueNumber, success });
      }
      if (events.manualGateHit()) { emit({ event: 'loop-halted', reason: 'ship-gate' }); return 3; }
    }

    if (args.once || stopping) { break; }
    await sleep(args.intervalSec * 1000);
  } while (!stopping);

  emit({ event: 'loop-finished', iterations: iteration });
  return 0;
}

// ─── command: daemon ─────────────────────────────────────────────────────────

/**
 * `moag daemon`. With a daemon.json it runs the issue loop as before. With an ONOSOO device
 * key it also polls ONOSOO for commands (docs/onosoo-remote.md) — and with a key alone, the
 * poller is all it runs, until a signal stops it. With neither it exits 2, as it always has.
 * Exported so tests can drive it with fakes.
 */
export async function cmdDaemon(args: Args, ctx: Ctx): Promise<number> {
  const { runDaemon } = require('./daemon');
  const { fetchOpenIssues, newIssuesToTasks, reportIssueResult } = require('../github/issue-sync');
  const { createEmptyPlan, createPlaylist, createTask } = require('../models/plan');

  // The key was captured once, at the top of main(); resolve it here, once, for the poller.
  const env = ctx.relayDeps?.env ?? relayConfigEnv();
  const stderr = ctx.relayDeps?.stderr ?? ((s: string): void => { process.stderr.write(s); });
  const onosoo = resolveOnosooConfig({ env, cwd: args.cwd, stderr });

  const configPath = args.configPath ?? path.join(args.cwd, '.moag', 'daemon.json');
  let config: any = null;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
  catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!(missing && onosoo)) {
      process.stderr.write(`Failed to read daemon config at ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    config = null; // ONOSOO poller only
  }

  const host = onosoo ? createDaemonRemoteHost(onosoo, ctx, args, stderr) : null;
  // The poller's own timers are unref'd, so nothing else holds the process open: this ref'd
  // interval does, from start until the host has closed (a run finalizing at shutdown included).
  const keepAlive = host ? setInterval(() => undefined, 60 * 60 * 1000) : null;
  const closeHost = async (): Promise<void> => {
    try { await host?.close(); } finally { if (keepAlive) { clearInterval(keepAlive); } }
  };
  // Every path to the end awaits the same close (the host's close() is idempotent).
  let closing: Promise<void> | null = null;
  const closeOnce = (): Promise<void> => { if (!closing) { closing = closeHost(); } return closing; };

  // Signals are handled from before the host starts. The first one stops cleanly (which can
  // take minutes while an active run finalizes); a second one during that wait gives up:
  // the lock is released and the process exits 130.
  let stopping = false;
  let signals = 0;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((r) => { resolveStopped = r; });
  const exit = ctx.relayDeps?.exit ?? ((code: number): void => { process.exit(code); });
  const onSignal = (): Promise<void> => {
    signals++;
    if (signals > 1) {
      try { host?.releaseLock(); } catch { /* best effort */ }
      exit(130);
      return closing ?? Promise.resolve();
    }
    stopping = true;
    emit({ event: 'daemon-stopping' });
    try { ctx.runner.stop(); } catch { /* nothing running */ }
    resolveStopped();
    return closeOnce();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  ctx.relayDeps?.onDaemonStop?.(onSignal);
  const offSignals = (): void => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };

  if (host) { await host.start(); }

  if (!config) {
    try {
      await stopped;
      await closeOnce();
    } finally {
      offSignals();
      await closeOnce();
    }
    return 0;
  }

  if (args.maxTicks) { config.maxTicks = args.maxTicks; }
  if (args.intervalSec && args.intervalSec !== 300) { config.intervalSec = args.intervalSec; }
  if (config.fullAuto) { await ctx.vscode.workspace.getConfiguration('agentTaskPlayer').update('fullAuto', true); }

  wireEvents(ctx.runner); // stream task/incident events into the JSONL output


  // A breached ceiling must end the daemon, not just the current plan. Without this the
  // budget degrades into a rate limiter that re-trips every tick and never actually halts.
  ctx.runner.on('budget-exceeded', () => {
    stopping = true;
    emit({ event: 'daemon-stopping', reason: 'budget-exceeded' });
  });

  // Once the daemon is stopping, no further engine call may start — including
  // authoring calls the tick loop makes outside play(). A plain synchronous
  // flag read, never async.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setCeilingGuard } = require('../adapters/index');
  setCeilingGuard(() => !stopping);

  try {
    return await runDaemon(config, {
      runner: ctx.runner,
      TaskStatus: ctx.TaskStatus,
      fetchOpenIssues, newIssuesToTasks, reportIssueResult,
      createEmptyPlan, createPlaylist, createTask,
      emit,
      sleep,
      shouldStop: () => stopping,
    });
  } finally {
    offSignals();
    await closeOnce();
  }
}

// ─── ONOSOO remote host (moag daemon) ────────────────────────────────────────

/** How long a probe child, a force-kill or the boot sweep may take. */
const REMOTE_HELPER_TIMEOUT_MS = 15_000;

/** Run a sudo helper (probe, kill sweep) with a bounded wait; resolves its stdout (capped at 1 MB). */
function runHelper(command: { command: string; args: string[] }, input: string | null): Promise<string> {
  const { spawn } = require('child_process');
  const { childSpawnEnv } = require('./remote-isolation');
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (done) { return; }
      done = true;
      if (timer) { clearTimeout(timer); }
      resolve(out);
    };
    let proc: any;
    try {
      proc = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'], env: childSpawnEnv(process.env), windowsHide: true });
    } catch {
      resolve('');
      return;
    }
    timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } finish(); }, REMOTE_HELPER_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout?.on('data', (c: Buffer) => { if (out.length < 1024 * 1024) { out += c.toString(); } });
    proc.stderr?.on('data', () => undefined);
    proc.stdin?.on('error', () => undefined);
    proc.on('error', finish);
    proc.on('close', finish);
    proc.stdin?.end(input === null ? undefined : `${input}\n`);
  });
}

/**
 * The real command host for `moag daemon`: ONOSOO control client, projects.json, the
 * spend ledger, audit log and run records under the user-level state dir, isolation
 * probes and remote children through sudo, and one relay per remote run.
 */
function createDaemonRemoteHost(
  cfg: OnosooConfig, ctx: Ctx, args: Args, stderr: (s: string) => void,
): { start(): Promise<void>; close(): Promise<void>; releaseLock(): void } {
  const { randomUUID } = require('crypto');
  const { spawn } = require('child_process');
  const { OnosooControl } = require('./onosoo-control');
  const { createCommandHost } = require('./onosoo-commands');
  const { loadApprovedProjects } = require('./onosoo-projects');
  const { RemoteAudit } = require('./remote-audit');
  const { RemoteLedger } = require('./remote-ledger');
  const { RemoteRuns } = require('./remote-runs');
  const iso = require('./remote-isolation');
  const branch = require('./remote-branch');
  const { RemoteSupervisor } = require('./remote-supervisor');

  const http = ctx.relayDeps?.http;
  const control = new OnosooControl({ config: cfg, http, stderr });
  const ledger = new RemoteLedger(cfg.stateDir);
  const runs = new RemoteRuns(cfg.stateDir);
  const engineEnv: Record<string, string> = iso.engineEnvFrom(process.env);
  const redactorFor = (projectPath: string): Redactor =>
    createRedactor(reportingSecretValues(projectPath, process.env, [cfg.key, ...Object.values(engineEnv)]));
  const branchPrefix = String(ctx.vscode?.workspace?.getConfiguration?.('agentTaskPlayer')?.get?.('git.branchPrefix', 'moag/') || 'moag/');
  const cliPath = path.join(__dirname, 'cli.js');
  const protectedPaths: string[] = iso.protectedStatePaths(cfg.stateDir);
  const { execFile } = require('child_process');
  const execFileText = (cmd: string, argv: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: REMOTE_HELPER_TIMEOUT_MS, windowsHide: true }, (err: Error | null, out: string) => (err ? reject(err) : resolve(String(out))));
  });
  const { DaemonLock } = require('./remote-lock');
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  // The runner account's home, learned from the probe, so worktree paths are scrubbed from relayed events.
  let runnerHome: string | null = null;
  const runnerUser = (): string | null => loadApprovedProjects(cfg.stateDir).runnerUser;

  return createCommandHost({
    control,
    stateDir: cfg.stateDir,
    loadProjects: () => loadApprovedProjects(cfg.stateDir),
    platform: process.platform,
    probe: async (projects: any) => {
      // MOAG's own checks first: its state must be private, whatever the runner says.
      const insecure = iso.checkStateSecurity(cfg.stateDir, ownUid);
      if (insecure) { return { ok: false, reason: insecure }; }
      const command = iso.childCommand(projects.runnerUser, process.execPath, cliPath);
      const spec = JSON.stringify({ op: 'probe', protectedPaths, projects: projects.projects.map((p: any) => p.id), engineEnv });
      const out = iso.parseProbe(await runHelper(command, spec), ownUid, protectedPaths);
      if (!out.ok) {
        // Show the exact command, so a sudoers rule can be matched to it character for character.
        return out.reason === iso.NO_PROBE_ANSWER
          ? { ok: false, reason: `${out.reason} MOAG ran: ${command.command} ${command.args.join(' ')}` }
          : out;
      }
      const uidProblem = iso.checkRunnerUid(await iso.resolveRunnerUid(projects.runnerUser, execFileText), out.uid, ownUid);
      if (uidProblem) { return { ok: false, reason: uidProblem }; }
      if (out.home) { runnerHome = out.home; }
      return out;
    },
    supervisorFactory: (req: any) => new RemoteSupervisor({
      record: req.record,
      projectName: req.project.name,
      specLine: req.specLine,
      bundle: req.bundle,
      spawnChild: () => {
        const c = iso.childCommand(runnerUser(), process.execPath, cliPath);
        return spawn(c.command, c.args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: iso.childSpawnEnv(process.env), windowsHide: true });
      },
      relayFactory: (runId: string) => new OnosooRelay({
        config: cfg,
        spool: new OnosooSpool(cfg.stateDir, req.project.path, { isPidAlive: ctx.relayDeps?.isPidAlive }),
        http,
        redactor: redactorFor(req.project.path),
        stderr,
        runId,
        cwd: runnerHome ? path.posix.join(runnerHome, '.moag-remote', 'worktrees', runId) : req.project.path,
        otherHomes: runnerHome ? [runnerHome] : [],
      }),
      ledger,
      runs,
      tmpDir: path.join(cfg.stateDir, 'remote', 'tmp'),
      importBranch: (file: string) => branch.importRunBranch(req.project.path, file, req.record.branch, branchPrefix, branch.spawnBranchGit),
      forceKill: async () => {
        const user = runnerUser();
        if (user && user !== 'root') { await runHelper(iso.forceKillCommand(user), null); }
      },
      // After every run: nothing the runner account started outlives it.
      sweep: async () => {
        const user = runnerUser();
        if (user && user !== 'root') { await runHelper(iso.forceKillCommand(user), null); }
      },
      stderr,
      onStarted: req.onStarted,
      onExit: req.onExit,
    }),
    exportBundle: (projectPath: string, opts: any) => branch.exportInboundBundle(projectPath, opts, branch.spawnBranchGit),
    branchExists: (projectPath: string, name: string) => branch.projectHasBranch(projectPath, name, branch.spawnBranchGit),
    projectBranchTip: (projectPath: string, name: string) => branch.projectBranchTip(projectPath, name, branch.spawnBranchGit),
    lock: new DaemonLock(cfg.stateDir),
    ledger,
    audit: new RemoteAudit(cfg.stateDir),
    runs,
    branchPrefix,
    engineEnv,
    newRunId: () => randomUUID(),
    projectDefaultEngine: (p: any) => { try { return readDefaultEngine(p.path) ?? null; } catch { return null; } },
    drainLeftoverSpool: async () => {
      const dirs = [args.cwd, ...loadApprovedProjects(cfg.stateDir).projects.map((p: any) => p.path)];
      for (const dir of dirs) {
        const relay = new OnosooRelay({
          config: cfg, spool: new OnosooSpool(cfg.stateDir, dir, { isPidAlive: ctx.relayDeps?.isPidAlive }), http,
          redactor: redactorFor(dir), stderr, heartbeat: false, closeDeadlineMs: ctx.relayDeps?.closeDeadlineMs,
        });
        relay.start();
        await relay.close();
      }
    },
    killSweep: async (user: string) => { await runHelper(iso.forceKillCommand(user), null); },
    tighten: () => {
      for (const problem of iso.tightenStatePermissions(cfg.stateDir)) { stderr(`ONOSOO: could not tighten permissions: ${problem}\n`); }
    },
    stderr: (line: string) => stderr(line.endsWith('\n') ? line : `${line}\n`),
  });
}

// ─── command: land ───────────────────────────────────────────────────────────

/**
 * Get the branches a run left behind back into the trunk.
 *
 * Reports by default and merges only when asked. Conflicts are detected with
 * `git merge-tree`, which merges in memory — assessing never leaves the
 * repository half-merged, which matters because this runs unattended.
 *
 * Exits 1 while anything still needs a person, so `moag land || notify-me` works
 * the same way the digest does.
 */
async function cmdLand(args: Args): Promise<number> {
  const { assessAll, landBranch, renderLandReport, resolveBase } = require('../runner/land');
  const { spawn } = require('child_process');

  // Keeps stdout on failure: git merge-tree reports conflicted paths there while
  // exiting non-zero, and discarding them would throw away the useful half.
  const git = (gitArgs: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> =>
    new Promise((resolve) => {
      const proc = spawn('git', gitArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('error', () => resolve({ ok: false, stdout: '' }));
      proc.on('close', (code: number) => resolve({ ok: code === 0, stdout: out }));
    });

  installVscodeShim(args.cwd);
  const prefix = require('vscode').workspace
    .getConfiguration('agentTaskPlayer')
    .get('git.branchPrefix', 'moag/') || 'moag/';

  const base = await resolveBase(args.cwd, args.into, prefix, git);
  if (!base) {
    process.stderr.write('Could not determine a branch to land into; pass --into <branch>.\n');
    return 2;
  }

  const report = await assessAll(args.cwd, prefix, base, git);
  process.stdout.write(renderLandReport(report) + '\n');
  emit({
    event: 'land-assessed',
    base,
    ready: report.ready.length,
    blocked: report.blocked.length,
    alreadyLanded: report.alreadyLanded.length,
  });

  if (!args.merge) {
    // Reporting is the default: merging is a write, and a write nobody asked
    // for is exactly what an unattended tool must not do.
    return report.blocked.length > 0 ? 1 : 0;
  }

  let landed = 0;
  for (const b of report.ready) {
    const outcome = await landBranch(args.cwd, b.branch, base, git);
    if (outcome.merged) {
      emit({ event: 'land-merged', branch: b.branch, into: base });
      landed++;
    } else {
      emit({ event: 'land-failed', branch: b.branch, reason: outcome.reason, detail: outcome.detail });
    }
  }
  emit({ event: 'land-finished', merged: landed, blocked: report.blocked.length });
  return report.blocked.length > 0 || landed < report.ready.length ? 1 : 0;
}

// ─── command: digest ─────────────────────────────────────────────────────────

/**
 * The morning review: what needs a decision, then what shipped, then cost.
 *
 * Exits 1 while anything is waiting on a person, so `moag digest || notify-me`
 * is a complete morning workflow.
 */
async function cmdDigest(args: Args): Promise<number> {
  const { buildDigest, collectCommits, renderDigest } = require('../runner/digest');
  const { openItems } = require('../runner/park-queue');
  const { spawn } = require('child_process');
  const nodeFs = require('fs');

  const git = (gitArgs: string[], cwd: string): Promise<string | null> => new Promise((resolve) => {
    const proc = spawn('git', gitArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code: number) => resolve(code === 0 ? out : null));
  });

  // The shim reads .moag/config.json, so digest sees the same branch prefix the
  // runner used to create those branches.
  installVscodeShim(args.cwd);
  const prefix = require('vscode').workspace
    .getConfiguration('agentTaskPlayer')
    .get('git.branchPrefix', 'moag/') || 'moag/';
  const commits = await collectCommits(args.cwd, prefix, args.since, git);
  const digest = buildDigest(openItems(args.cwd, nodeFs), commits, args.since);

  // Human-readable on stdout; the JSONL summary keeps it scriptable.
  process.stdout.write(renderDigest(digest) + '\n');
  emit({
    event: 'digest',
    needsDecision: digest.needsDecision.length,
    shipped: digest.shipped.length,
    branches: digest.branches.length,
    totalCostUsd: Number(digest.totalCostUsd.toFixed(4)),
  });
  return digest.needsDecision.length > 0 ? 1 : 0;
}

// ─── command: queue ──────────────────────────────────────────────────────────

/**
 * List or clear parked work.
 *
 * The morning-review surface for the headless side: everything the run stopped
 * on, newest first, with the decision each item is waiting for.
 */
function cmdQueue(args: Args): number {
  const { openItems, readQueue, resolveItem, describeParkReason } = require('../runner/park-queue');
  const nodeFs = require('fs');
  const verb = args.positionals[0] ?? 'list';

  if (verb === 'resolve') {
    const id = args.positionals[1];
    if (!id) {
      process.stderr.write('Usage: moag queue resolve <id>\n');
      return 2;
    }
    if (!resolveItem(args.cwd, id, new Date().toISOString(), nodeFs)) {
      process.stderr.write('No open parked item with id ' + id + '\n');
      return 1;
    }
    emit({ event: 'queue-resolved', id });
    return 0;
  }

  if (verb !== 'list') {
    process.stderr.write('Usage: moag queue <list | resolve <id>>\n');
    return 2;
  }

  const open = openItems(args.cwd, nodeFs);
  emit({ event: 'queue-listed', open: open.length, total: readQueue(args.cwd, nodeFs).length });
  for (const item of open) {
    emit({
      event: 'queue-item',
      id: item.id,
      parkedAt: item.parkedAt,
      reason: item.reason,
      summary: describeParkReason(item.reason),
      task: item.taskName,
      playlist: item.playlistName,
      decision: item.decision,
    });
  }
  // Exit 1 when work is waiting, so a wrapper script can branch on it.
  return open.length > 0 ? 1 : 0;
}

// ─── command: trace ──────────────────────────────────────────────────────────

const TRACE_USAGE = 'Usage: moag trace [<plan.json> | --plan <path>] [--req R-<n>]\n';

/** A usage message when `moag trace` was given a malformed `--req`, else null. */
export function traceArgsError(args: Args): string | null {
  if (args.planFlagMissing) {
    return `--plan needs a path.\n${TRACE_USAGE}`;
  }
  if (args.req !== undefined && !/^R-\d+$/.test(args.req)) {
    return `Invalid --req "${args.req}" — expected a requirement ID like R-7.\n${TRACE_USAGE}`;
  }
  return null;
}

/** The plan `moag trace` reads: `--plan` or the positional, else `<cwd>/.moag/plan.json` when it exists. */
export function resolveTracePlanPath(args: Args): string | null {
  if (args.planPath) { return args.planPath; }
  const fallback = path.join(args.cwd, '.moag', 'plan.json');
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * `moag trace` — read-only requirement status, one JSONL line per requirement.
 * Like `queue`: no setup(), no runner, no spawn, no shim — it loads the plan and derives
 * each status from recorded evidence only.
 */
export function cmdTrace(args: Args): number {
  const usageError = traceArgsError(args);
  if (usageError) {
    process.stderr.write(usageError);
    return 2;
  }
  const planPath = resolveTracePlanPath(args);
  if (!planPath) {
    process.stderr.write(`No plan found at ${path.join(args.cwd, '.moag', 'plan.json')}.\n${TRACE_USAGE}`);
    return 2;
  }
  const { loadPlan } = require('../models/plan');
  const { requirementStatuses } = require('../models/requirement-trace');
  let plan;
  try { plan = loadPlan(planPath); }
  catch (err) {
    process.stderr.write(`Failed to load plan: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const rows: Array<{
    id: string; status: string; version: string | null; releaseTag: string | null; standardsVersion: number | null;
    standardsCounts: unknown; tasks: unknown; gates: unknown; blockedBy?: string;
  }> = requirementStatuses(plan);
  const selected = args.req ? rows.filter((r) => r.id === args.req) : rows;
  if (args.req && selected.length === 0) {
    process.stderr.write(`No requirement ${args.req} in ${planPath}\n`);
    return 2;
  }
  for (const row of selected) {
    emit({
      event: 'trace',
      id: row.id,
      status: row.status,
      version: row.version,
      releaseTag: row.releaseTag,
      // The project standards version the last release was checked against; null when it had none.
      standardsVersion: row.standardsVersion,
      // What that check left open: advisory findings, rules and files not checked. Null when none was recorded.
      standardsCounts: row.standardsCounts,
      tasks: row.tasks,
      gates: row.gates,
      // Present only on not-shipped rows: the Failed/Blocked/Skipped task holding it back.
      ...(row.blockedBy ? { blockedBy: row.blockedBy } : {}),
    });
  }
  return 0;
}

// ─── command: standards ──────────────────────────────────────────────────────

/** `moag standards check`: nothing could be diffed, so nothing was checked. Distinct from 1 (a rule failed) and 2 (usage). */
export const STANDARDS_EXIT_NOTHING_CHECKED = 5;
/**
 * `moag standards check`: nothing blocking failed, but a blocking rule or command was NOT
 * CHECKED — a command that did not run (`--no-commands` included), or a promoted rule that
 * could not read what it had to. Unevaluated blocking evidence is not a pass.
 */
export const STANDARDS_EXIT_BLOCKING_NOT_CHECKED = 6;

const STANDARDS_USAGE =
  'Usage: moag standards <show | check | propose> [--cwd <dir>]\n' +
  '  moag standards show                              print .moag/standards.json and the text task prompts carry\n' +
  '  moag standards check [--base <ref>] [--no-commands]\n' +
  '        exit 0: nothing blocking — every command passed, or the profile has no blocking rules configured\n' +
  '                (advisory findings and files not checked are listed, not counted)\n' +
  '        exit 1: a command failed, or a promoted rule has findings\n' +
  '        exit 2: usage error, no standards file, or an invalid one\n' +
  `        exit ${STANDARDS_EXIT_NOTHING_CHECKED}: no diff could be taken, so nothing was checked\n` +
  `        exit ${STANDARDS_EXIT_BLOCKING_NOT_CHECKED}: a command or a promoted rule was not checked (so also with --no-commands)\n` +
  `  moag standards propose [--stack <${STACK_IDS.join('|')}>] [--write [--force]]\n` +
  '        --write   save the proposal as the next version; refuses to replace an existing file that differs\n' +
  '        --force   replace it anyway; the old file is kept as .moag/standards.json.bak\n' +
  '        A proposal with a design system also writes DESIGN.md and the tokens file. One that\n' +
  '        already exists and differs is never replaced without --force (then kept as <file>.bak);\n' +
  '        such a conflict is found before anything is written, so a refusal writes nothing.\n';

const STANDARDS_FILE_LABEL = '.moag/standards.json';

/** One rule row as `moag standards check` names it. */
function ruleLabel(row: StandardsReport['rules'][number]): string {
  return row.rule === 'command' ? `command: ${row.command ?? ''}` : row.rule;
}

/** Most not-checked files `moag standards check` spells out; the heading carries the true count. */
const MAX_NOT_CHECKED_FILES_SHOWN = 50;

/**
 * The human-readable result of a check, in groups that are never mixed: what is BLOCKING,
 * what is ADVISORY, which rules were NOT CHECKED, and which changed FILES were not checked.
 * A blocking rule or command that was not checked leads its group and is marked, because
 * it is the one line a reader must not take for a pass. A profile with no command and no
 * promoted rule says "no blocking rules configured" — never that anything passed.
 *
 * The verdict words follow the kind of row. Only a command says `passed` or `FAILED`. Every
 * rule MOAG decides itself says `no findings` or `FINDINGS`: a scan that found nothing has
 * not proved that nothing is there.
 */
export function renderStandardsCheck(report: StandardsReport): string {
  const out: string[] = [];
  const version = report.version === null ? 'Standards' : `Standards v${report.version}`;
  const since = report.baseRef === EMPTY_TREE_REF ? 'the empty tree (every file counts as added)'
    : report.baseRef ?? 'nothing (no diff could be taken)';
  out.push(`${version} — diff since ${since}`);
  const groups = groupStandardsRules(report);
  const findingsOf = (severity: 'blocking' | 'advisory'): string[] =>
    // Flush left, `file:line` first: the shape editors and terminals turn into a link.
    report.findings.filter((f) => severityOf(f) === severity).map((f) => `${f.file}:${f.line} ${f.rule} — ${f.message}`);
  const verdicts = (rows: StandardsReport['rules']): string[] => rows.map((row) => {
    const detail = row.rule === 'command' && row.result === 'failed' ? ` (exit ${row.exitCode ?? '?'})` : '';
    // A decided rule that left vendored or generated files out says which.
    const note = row.rule !== 'command' && row.reason ? ` — ${row.reason}` : '';
    const label = ruleOutcomeLabel(row);
    const word = row.result === 'failed' ? label.toUpperCase() : label;
    return `  ${word}  ${ruleLabel(row)}${detail}${note}`;
  });
  const stopping = (rows: StandardsReport['rules']): number => rows.filter((r) => r.result === 'failed').length;

  out.push('', `Blocking (a failure or a finding here stops a release) — ${stopping(groups.blocking)} stopping:`);
  const blockingState = standardsBlockingState(report);
  const nothingBlocking = blockingState === 'none-configured' ? `  (${NO_BLOCKING_RULES}: MOAG blocks on your project's own tools — add a command to the profile)`
    : '  (no blocking rule was decided)';
  out.push(...(groups.blocking.length > 0 ? verdicts(groups.blocking) : [nothingBlocking]), ...findingsOf('blocking'));
  const promoted = promotedScannerRules(report);
  if (promoted.length > 0) {
    out.push(`  !! Promoted to blocking: ${promoted.join(', ')}. ${SCANNER_PROMOTION_WARNING}`);
  }

  out.push('', `Advisory (heuristic scans: reported, never blocking) — ${stopping(groups.advisory)} with findings:`);
  out.push(...(groups.advisory.length > 0 ? verdicts(groups.advisory) : ['  (no advisory rule was decided)']), ...findingsOf('advisory'));

  if (groups.notChecked.length > 0) {
    out.push('', 'Rules not checked (not a pass):');
    for (const row of groups.notChecked) {
      const mark = isBlockingNotChecked(row) ? '!! BLOCKING RULE NOT CHECKED  ' : '  ';
      out.push(`${mark}${ruleLabel(row)} — ${row.reason ?? 'no reason given'}`);
    }
  }
  if (groups.notConfigured.length > 0) {
    // Rules this profile never asked for: listed so the reader knows, never a gap in the check.
    out.push('', 'Not configured in this profile:');
    for (const row of groups.notConfigured) { out.push(`  ${ruleLabel(row)}`); }
  }
  const t = report.totals;
  const files = report.notCheckedFiles ?? [];
  if (t.notCheckedFiles > 0) {
    out.push('', `Files not checked (${t.notCheckedFiles}) — nothing in them counts towards "no findings":`);
    for (const f of files.slice(0, MAX_NOT_CHECKED_FILES_SHOWN)) { out.push(`  ${f.file} — not checked (${f.reason})`); }
    const shown = Math.min(files.length, MAX_NOT_CHECKED_FILES_SHOWN);
    if (t.notCheckedFiles > shown) { out.push(`  …and ${t.notCheckedFiles - shown} more`); }
  }
  out.push('', `${t.passed} passed · ${t.noFindings} no findings · ${t.failed} blocking · ` +
    `${t.advisory} advisory with findings (${t.advisoryFindings} finding${t.advisoryFindings === 1 ? '' : 's'}) · ` +
    `${t.notChecked} rule${t.notChecked === 1 ? '' : 's'} not checked` +
    (t.blockingNotChecked > 0 ? ` (${t.blockingNotChecked} blocking)` : '') +
    ` · ${t.notCheckedFiles} file${t.notCheckedFiles === 1 ? '' : 's'} not checked` +
    ` · ${t.findings} finding${t.findings === 1 ? '' : 's'}` +
    (blockingState === 'none-configured' ? ` · ${NO_BLOCKING_RULES}` : ''));
  if (t.notConfigured > 0) {
    out.push(`${t.notConfigured} rule${t.notConfigured === 1 ? '' : 's'} not configured in this profile (not a gap in this check)`);
  }
  return out.join('\n') + '\n';
}

/**
 * `moag standards <show | check | propose>` — the workspace's own standards file.
 * Like `trace`: no setup(), no shim, no runner and no engine. `check` spawns git
 * (and the profile's commands unless `--no-commands`); `propose` asks git which files it
 * tracks; `show` spawns nothing.
 *
 * Exit codes: 0 ok / nothing blocking · 1 a command failed, or a promoted rule has findings (`check`) ·
 * 2 usage, no profile, an invalid standards file, or a refused overwrite (`propose --write`)
 * · 5 no diff could be taken, so nothing was checked (`check`) · 6 a blocking rule or command
 * was not checked (`check`).
 */
/** The design system as `moag standards show` prints it: the two files and every listed token. */
function renderDesignSummary(design: DesignSystem): string {
  const parsed = parseDesignTokens(design.tokensPath, design.tokens);
  const lines = [
    '─── Design system ───',
    `DESIGN.md:   ${design.docPath} (${design.doc.length} characters)`,
    `Tokens file: ${design.tokensPath}${parsed.listable ? ` (${parsed.tokens.length} token${parsed.tokens.length === 1 ? '' : 's'})` : ` (not listable: ${parsed.reason ?? 'unknown format'})`}`,
    ...parsed.tokens.map((t) => `  ${t.name}: ${t.value}`),
  ];
  return lines.join('\n') + '\n';
}

/** The design files that exist and differ (line endings aside) from what `design` would write. */
function designFileConflicts(cwd: string, design: DesignSystem): string[] {
  const out: string[] = [];
  for (const [rel, content] of [[design.docPath, design.doc], [design.tokensPath, design.tokens]] as const) {
    let current: string;
    try { current = fs.readFileSync(path.join(cwd, ...rel.split('/')), 'utf-8'); } catch { continue; }
    if (current.replace(/\r\n?/g, '\n') !== content.replace(/\r\n?/g, '\n')) { out.push(rel); }
  }
  return out;
}

/**
 * Write the proposed design system's files: each conflicting one (only reached with --force)
 * is kept as `<file>.bak` first. Returns the exit code.
 */
function writeProposedDesign(cwd: string, design: DesignSystem, conflicts: string[]): number {
  for (const rel of conflicts) {
    const full = path.join(cwd, ...rel.split('/'));
    try { fs.copyFileSync(full, `${full}.bak`); }
    catch (err) {
      process.stderr.write(`Could not back up ${rel}, so the design system was not written: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  try {
    const { written } = writeDesignFiles(cwd, design);
    for (const rel of written) {
      process.stderr.write(`Wrote ${rel}.${conflicts.includes(rel) ? ` The previous file is ${rel}.bak.` : ''}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`Could not write the design system: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

export async function cmdStandards(args: Args): Promise<number> {
  const verb = args.positionals[0];
  if (verb !== 'show' && verb !== 'check' && verb !== 'propose') {
    process.stderr.write(verb ? `Unknown standards command "${verb}".\n${STANDARDS_USAGE}` : STANDARDS_USAGE);
    return 2;
  }
  if (args.stack !== undefined && (verb !== 'propose' || !isStackId(args.stack))) {
    process.stderr.write(verb !== 'propose'
      ? `--stack only applies to "moag standards propose".\n${STANDARDS_USAGE}`
      : `Invalid --stack "${args.stack}" — expected one of ${STACK_IDS.join(', ')}.\n${STANDARDS_USAGE}`);
    return 2;
  }

  // A file that exists but is wrong stops every verb: showing, checking against, or
  // versioning on top of a document the validator refuses would all be misleading.
  let doc: StandardsDocument | null;
  try { doc = loadLocalStandards(args.cwd); }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (verb === 'propose') {
    // From the files git tracks: nothing `.gitignore` names is ever proposed.
    const detection = await detectConventions(args.cwd);
    const stack = args.stack !== undefined && isStackId(args.stack) ? args.stack : detectedStackId(detection) ?? 'other';
    const proposal = proposeProfile(stack, detection);
    const next: StandardsDocument = { schemaVersion: 1, version: (doc?.version ?? 0) + 1, profile: proposal.profile, provenance: proposal.provenance };
    process.stdout.write(JSON.stringify(next, null, 2) + '\n');
    if (!args.write) {
      process.stderr.write(`Proposal only — nothing was written. Re-run with --write to save it as ${STANDARDS_FILE_LABEL} (v${next.version}).\n`);
      return 0;
    }
    // The design files are checked before anything is written: a conflict refuses the whole write.
    const design = next.profile.design;
    const conflicts = design ? designFileConflicts(args.cwd, design) : [];
    if (conflicts.length > 0 && !args.force) {
      for (const rel of conflicts) {
        process.stderr.write(`${rel} differs from the proposed design system and may hold hand edits — not replaced. ` +
          `Re-run with --write --force; it is then kept as ${rel}.bak.\n`);
      }
      process.stderr.write('Nothing was written.\n');
      return 2;
    }
    if (doc) {
      if (profileHash(doc.profile) === profileHash(next.profile)) {
        process.stderr.write(`${STANDARDS_FILE_LABEL} (v${doc.version}) already holds this proposal — nothing was written.\n`);
        return design ? writeProposedDesign(args.cwd, design, conflicts) : 0;
      }
      // The file differs from what detection proposes now. Whether a person edited it or
      // the repository moved on cannot be told apart, so it is never replaced silently.
      if (!args.force) {
        process.stderr.write(
          `${STANDARDS_FILE_LABEL} (v${doc.version}) differs from this proposal and may hold hand edits — nothing was written.\n` +
          `Re-run with --write --force to replace it; the current file is then kept as ${STANDARDS_FILE_LABEL}.bak.\n`);
        return 2;
      }
      try { fs.copyFileSync(localStandardsPath(args.cwd), `${localStandardsPath(args.cwd)}.bak`); }
      catch (err) {
        process.stderr.write(`Could not back up ${STANDARDS_FILE_LABEL}, so it was not replaced: ${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
    }
    try { writeLocalStandards(args.cwd, next); }
    catch (err) {
      process.stderr.write(`Could not write ${STANDARDS_FILE_LABEL}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    process.stderr.write(`Wrote ${STANDARDS_FILE_LABEL} (v${next.version}).${doc ? ` The previous file is ${STANDARDS_FILE_LABEL}.bak.` : ''}\n`);
    return design ? writeProposedDesign(args.cwd, design, conflicts) : 0;
  }

  if (!doc) {
    process.stderr.write(`No standards found at ${path.join(args.cwd, '.moag', 'standards.json')}. Run "moag standards propose --write" to create one.\n`);
    return 2;
  }

  if (verb === 'show') {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n\n');
    const design = doc.profile.design;
    if (design) { process.stdout.write(renderDesignSummary(design) + '\n'); }
    process.stdout.write('─── Text every task prompt carries ───\n' + renderStandardsText(doc.profile, doc.version) + '\n');
    if (design) {
      process.stdout.write(`\n${DESIGN_SYSTEM_HEADER}\n${renderDesignPromptText(design, doc.profile.frontend.componentKit, doc.version)}\n`);
    }
    return 0;
  }

  // check: the diff since --base, else since the base captured at run start, else since HEAD
  // (no commits yet: every file counts as added).
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const baseRef = await resolveStandardsBase(args.cwd, args.base, captureHeadRef);
    const report = await checkStandardsNow({ profile: doc.profile, version: doc.version, baseRef }, args.cwd, {
      signal: abort.signal, commands: !args.noCommands,
      dependencies: standardsDependencySettings(args.cwd),
      onDependencyEvent: (ev) => process.stderr.write(`${formatDependencyEventLine(ev)}\n`),
    });
    if (abort.signal.aborted) {
      process.stderr.write('Standards check stopped.\n');
      return 2;
    }
    if (baseRef !== null && baseRef !== EMPTY_TREE_REF && report.baseRef === EMPTY_TREE_REF) {
      process.stderr.write(`"${baseRef}" is not a commit in this repository, so every file was checked as if it were new.\n`);
    }
    process.stdout.write(renderStandardsCheck(report));
    if (report.baseRef === null) {
      // Not a pass: there was no diff to judge (not a git repository, or git is unavailable).
      process.stderr.write('No diff could be taken, so nothing was checked. Run this inside a git repository.\n');
      return STANDARDS_EXIT_NOTHING_CHECKED;
    }
    if (standardsBlocked(report)) { return 1; }
    if (standardsBlockingState(report) === 'not-checked') {
      const open = report.rules.filter(isBlockingNotChecked).length;
      process.stderr.write(`${open} blocking rule${open === 1 ? '' : 's'} or command${open === 1 ? ' was' : 's were'} not checked — that is not a pass.\n`);
      return STANDARDS_EXIT_BLOCKING_NOT_CHECKED;
    }
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

// ─── one-shot prompt → plan ──────────────────────────────────────────────────

/** Build a single-agent-task plan from a prompt string (the `--prompt` one-shot path). */
export function buildPromptPlan(prompt: string, engineId: string): any {
  const { createEmptyPlan, createTask } = require('../models/plan');
  const plan = createEmptyPlan('One-shot prompt');
  const name = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
  plan.playlists[0].tasks = [createTask(name, prompt, undefined)];
  plan.defaultEngine = engineId;
  return plan;
}

// ─── command: config ─────────────────────────────────────────────────────────

const KNOWN_ENGINES = ['claude', 'codex', 'gemini', 'ollama', 'custom', 'copilot', 'anthropic'];

/** Resolve the persistent config file path (honours MOAG_CONFIG_PATH). */
export function configFilePath(cwd: string): string {
  const explicit = process.env.MOAG_CONFIG_PATH;
  return explicit && explicit.length > 0 ? path.resolve(explicit) : path.join(cwd, '.moag', 'config.json');
}

/** Read the `.moag/config.json` object (empty object if missing/unreadable). */
export function readConfigFile(cwd: string): Record<string, any> {
  const fs = require('fs');
  const p = configFilePath(cwd);
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {}; }
  catch { return {}; }
}

/** Current persistent default engine, defaulting to `claude`. */
export function readDefaultEngine(cwd: string): string {
  const cfg = readConfigFile(cwd);
  return (cfg && cfg.agentTaskPlayer && cfg.agentTaskPlayer.defaultEngine) || 'claude';
}

/** Validate + persist the default engine, preserving other config keys. Atomic write. */
export function setDefaultEngine(cwd: string, id: string): { ok: boolean; path: string; error?: string } {
  const fs = require('fs');
  const p = configFilePath(cwd);
  if (!id || !KNOWN_ENGINES.includes(id)) {
    return { ok: false, path: p, error: `Usage: moag config set-engine <${KNOWN_ENGINES.join('|')}>` };
  }
  const cfg = readConfigFile(cwd);
  cfg.agentTaskPlayer = (cfg.agentTaskPlayer && typeof cfg.agentTaskPlayer === 'object') ? cfg.agentTaskPlayer : {};
  cfg.agentTaskPlayer.defaultEngine = id;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    return { ok: false, path: p, error: `Failed to write config at ${p}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, path: p };
}

/** Read/set the persistent default engine in `.moag/config.json` (no runner needed). */
async function cmdConfig(args: Args): Promise<number> {
  const sub = args.positionals[0];

  if (sub === 'set-engine') {
    const res = setDefaultEngine(args.cwd, args.positionals[1]);
    if (!res.ok) { process.stderr.write(`${res.error}\n`); return 2; }
    emit({ event: 'config-updated', key: 'agentTaskPlayer.defaultEngine', value: args.positionals[1], path: res.path });
    return 0;
  }

  if (sub === 'get-engine') {
    const current = readDefaultEngine(args.cwd);
    let detected: string[] = [];
    try {
      installVscodeShim(args.cwd);
      const { registerAllEngines } = require('../adapters/index');
      registerAllEngines();
      const { detectEngines } = require('../engine-detection');
      detected = (await detectEngines()).available;
    } catch { /* detection is best-effort */ }
    emit({ event: 'config', defaultEngine: current, detected, path: configFilePath(args.cwd) });
    return 0;
  }

  process.stderr.write(
    'Usage: moag config <get-engine | set-engine <id>>\n' +
    `  engines: ${KNOWN_ENGINES.join(' | ')}\n`,
  );
  return 2;
}

// ─── entry ───────────────────────────────────────────────────────────────────

/** The CLI entry point. Exported so a test can drive dispatch. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Before anything else: no command handler, and nothing any of them spawns, sees the device key.
  captureRelayEnv(process.env);
  if (argv[0] === 'host') {
    // No setup() and no shim: the host agent runs environments and a gateway, never the runner.
    // It reads the device key from the captured snapshot, like the relay.
    return require('../host/cli').cmdHost(argv.slice(1), relayConfigEnv());
  }
  const args = parseArgs(argv);
  // Hidden: the ONOSOO remote child, started by `moag daemon` through sudo (docs/onosoo-remote.md).
  if (args.command === 'remote-child') {
    return require('./remote-child').remoteChildMain();
  }
  if (args.command === 'bench') {
    // No setup() and no shim: the bench drives the hosted server over HTTP and never loads vscode.
    if (args.out === '' || (args.maxUsd !== undefined && Number.isNaN(args.maxUsd))) {
      process.stderr.write('Usage: moag bench <scenario.json> [--dry-run] [--out <dir>] [--max-usd <n>] [--allow-failed-probes]  (--max-usd must be a positive number)\n');
      return 2;
    }
    return require('../bench/harness').cmdBench(args);
  }
  if (args.command === 'run') {
    if (!args.planPath && !args.prompt) {
      process.stderr.write('Usage: moag run <plan.json | --prompt "<text>"> [--full-auto] [--engine <id>] [--cwd <dir>]\n');
      return 2;
    }
    return cmdRun(args, await setup(args));
  }
  if (args.command === 'verify') {
    if (!args.planPath) {
      process.stderr.write('Usage: moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--max-iterations <n>]\n');
      return 2;
    }
    return cmdVerify(args, await setup(args));
  }
  if (args.command === 'loop') {
    return cmdLoop(args, await setup(args));
  }
  if (args.command === 'land') {
    return cmdLand(args);
  }
  if (args.command === 'digest') {
    return cmdDigest(args);
  }
  if (args.command === 'queue') {
    return cmdQueue(args);
  }
  if (args.command === 'daemon') {
    return cmdDaemon(args, await setup(args));
  }
  if (args.command === 'config') {
    return cmdConfig(args);
  }
  if (args.command === 'trace') {
    return cmdTrace(args);
  }
  if (args.command === 'standards') {
    // No setup() and no shim: the standards file is read, checked and proposed without the runner.
    return cmdStandards(args);
  }
  process.stderr.write(
    'Usage: moag <run|verify|loop|daemon|config|queue|digest|land|trace|standards|bench> ...\n' +
    '       moag host [run | init | draft <project> | status | stop <env> | remove <env>]   (docs/host-agent.md)\n' +
    '  moag run <plan.json> [--full-auto] [--engine <id>] [--verify] [--fix] [--pr] [--no-standards] [--base <ref>]\n' +
    '      --no-standards   project standards off for this invocation: no standards block in task prompts,\n' +
    '                       no standards gate (static rules and profile commands) in verification\n' +
    '  moag run --prompt "<text>" [--engine <id>] [--full-auto]\n' +
    '  moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--max-iterations <n>] [--no-standards] [--base <ref>]\n' +
    '  moag loop --repo <owner/repo> [--label <l>] [--interval <sec>] [--once] [--full-auto]\n' +
    '  moag daemon [--config <.moag/daemon.json>] [--interval <sec>] [--max-ticks <n>] [--full-auto]\n' +
    '  moag config <get-engine | set-engine <id>>\n' +
    '  moag queue <list | resolve <id>>\n' +
    '  moag digest [--since <when>]\n' +
    '  moag land [--into <branch>] [--merge]\n' +
    '  moag trace [<plan.json> | --plan <path>] [--req R-<n>]\n' +
    '  moag standards show\n' +
    '  moag standards check [--base <ref>] [--no-commands]     exit 0 ok · 1 blocking failure · 5 nothing checked · 6 blocking not checked\n' +
    '  moag standards propose [--stack <id>] [--write [--force]]\n' +
    '  moag bench <scenario.json> [--dry-run] [--out <dir>] [--max-usd <n>] [--allow-failed-probes]\n',
  );
  return 2;
}

// Only run when invoked as a program — importing this module (e.g. from unit tests
// exercising parseArgs) must not start the CLI or call process.exit.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(2);
    });
}
