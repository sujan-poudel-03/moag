#!/usr/bin/env node
/**
 * MOAG headless CLI — run a plan, verify it against a PRD, or run a continuous
 * intake loop, with no VS Code.
 *
 *   moag run    <plan.json> [--no-interactive] [--full-auto] [--engine <id>] [--cwd <dir>]
 *                           [--verify] [--fix] [--prd <file>] [--gate "<cmd>"] [--max-iterations <n>]
 *                           [--uat | --no-uat] [--uat-spec <path>]
 *   moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--max-iterations <n>]
 *                           [--engine <id>] [--cwd <dir>] [--uat | --no-uat] [--uat-spec <path>]
 *   moag loop   --repo <owner/repo> [--label <l>] [--interval <sec>] [--once]
 *                                   [--full-auto] [--engine <id>] [--cwd <dir>]
 *
 * `run`    executes a single plan file.
 * `verify` runs the deterministic PRD gates (change / command / artifact / status)
 *          and only then asks a model for a verdict; with `--fix` it generates and
 *          runs fix playlists until the gates pass or a halt condition trips.
 *          `--uat` forces the browser UAT gate to run and pass (a missing
 *          Playwright/Cypress setup then FAILS verification); `--no-uat` disables
 *          it. Without either flag, agentTaskPlayer.prdLoop.uat.mode decides.
 * `loop`   polls a GitHub repo for open issues, turns each new issue into a task,
 *          runs them, then reports the outcome back to the issue (comment + close on
 *          success; comment + label on failure) — the closed autonomous loop.
 *
 * Exit codes: 0 ok · 1 task(s) failed or PRD gaps remain · 2 error/usage ·
 *             3 halted at ship gate · 4 halted on cost ceiling.
 * Progress is JSONL on stdout; human notices on stderr.
 */

import * as fs from 'fs';
import * as path from 'path';
import { installVscodeShim, FileMemento } from './install-shim';
// Both of these are free of VS Code API imports, so they are safe to load before the shim.
import { detectPrdFile } from '../runner/evidence';
import { createPrdLoop, HaltReason, PrdLoopConfig, PrdLoopReport, UatSession } from '../runner/prd-loop';

/** How long a freshly launched headless sandbox gets to report `running`. */
const UAT_SANDBOX_READY_TIMEOUT_MS = 120_000;

export interface Args {
  command: string;
  planPath?: string;
  cwd: string;
  noInteractive: boolean;
  fullAuto: boolean;
  engine?: string;
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
    command: argv[0] ?? '', cwd: process.cwd(),
    noInteractive: false, fullAuto: false, intervalSec: 300, once: false,
    verify: false, fix: false, gates: [],
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--no-interactive') { a.noInteractive = true; }
    else if (arg === '--full-auto') { a.fullAuto = true; }
    else if (arg === '--once') { a.once = true; }
    else if (arg === '--verify') { a.verify = true; }
    else if (arg === '--fix') { a.fix = true; }
    else if (arg === '--engine') { a.engine = rest[++i]; }
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
    else if (!arg.startsWith('--') && !a.planPath) { a.planPath = path.resolve(a.cwd, arg); }
  }
  return a;
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Ctx {
  runner: any;
  vscode: any;
  TaskStatus: any;
  loadPlan: (p: string) => any;
}

/** Shared headless bootstrap. Installs the shim, then loads vscode-dependent modules. */
async function setup(args: Args): Promise<Ctx> {
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

  const memento = new FileMemento(path.join(args.cwd, '.moag', 'headless-state.json'));
  const runner = new TaskRunner(new HistoryStore(memento));
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
function wireEvents(runner: any): RunnerEventState {
  let manualGateHit = false;
  let manualGateTaskId: string | null = null;
  let budgetHit = false;
  runner.on('state-changed', (state: string) => emit({ event: 'state', state }));
  runner.on('task-started', (t: any) => emit({ event: 'task-started', id: t.id, name: t.name }));
  runner.on('task-completed', (t: any) => emit({ event: 'task-completed', id: t.id, name: t.name }));
  runner.on('task-failed', (t: any) => emit({ event: 'task-failed', id: t.id, name: t.name }));
  runner.on('task-escalate', (t: any, category: string) => emit({ event: 'task-escalate', id: t.id, name: t.name, category }));
  runner.on('incident', (t: any, summary: string, issueUrl: string | null) => emit({ event: 'incident', id: t.id, name: t.name, summary, issueUrl }));
  runner.on('error', (err: Error) => emit({ event: 'error', message: err.message }));
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
    runner.stop();
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

/** Build the loop config from settings, with CLI flags taking precedence. */
export function buildVerifyConfig(args: Args, ctx: Ctx): PrdLoopConfig {
  const cfg = ctx.vscode.workspace.getConfiguration('agentTaskPlayer');
  return {
    cwd: args.cwd,
    maxFixIterations: args.maxIterations ?? cfg.get('prdLoop.maxFixIterations', 3),
    gateCommands: args.gates.length > 0 ? args.gates : cfg.get('prdLoop.gateCommands', []),
    gateTimeoutMs: cfg.get('prdLoop.gateTimeoutMs', 600_000),
    maxDiffChars: cfg.get('prdLoop.maxDiffChars', 40_000),
    onManualGate: cfg.get('prdLoop.onManualGate', 'halt'),
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
  };
}

/**
 * Run the PRD loop over an already-loaded plan and write the full report to
 * `.moag/verification-<ts>.json`. Shared by `moag verify` and `moag run --verify`.
 */
async function runVerifyCore(args: Args, ctx: Ctx, plan: any, events: RunnerEventState): Promise<number> {
  const { savePlan } = require('../models/plan');
  const { getEngine } = require('../adapters/index');
  // Loaded here, inside the post-shim region, for consistency with setup().
  const { SandboxManager, isPortOpen } = require('../sandbox/sandbox-manager');
  const { detectProject } = require('../sandbox/project-detector');

  const cfgForUat = buildVerifyConfig(args, ctx);
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
      skipManualGate: (taskId: string) => ctx.runner.skipManualGate(taskId),
      prepareUat,
      signal: abort.signal,
    });
    holder.controller = controller;

    emit({ event: 'verify-started', plan: plan.name, fix: args.fix });
    const report = await controller.run();

    const reportPath = path.join(args.cwd, '.moag', `verification-${Date.now()}.json`);
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    } catch (err) {
      emit({ event: 'error', message: `Could not write verification report: ${err instanceof Error ? err.message : String(err)}` });
    }

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

async function cmdRun(args: Args, ctx: Ctx): Promise<number> {
  const planPath = args.planPath!;
  let plan;
  try { plan = ctx.loadPlan(planPath); }
  catch (err) { process.stderr.write(`Failed to load plan: ${err instanceof Error ? err.message : String(err)}\n`); return 2; }
  if (args.engine) { plan.defaultEngine = args.engine; }

  const events = wireEvents(ctx.runner);
  emit({ event: 'run-started', plan: plan.name, planPath, fullAuto: args.fullAuto });
  try { await ctx.runner.play(plan); }
  catch (err) { emit({ event: 'error', message: err instanceof Error ? err.message : String(err) }); return 2; }

  const t = tally(plan, ctx.TaskStatus);
  emit({ event: 'run-finished', ...t, manualGateHit: events.manualGateHit() });
  const runCode = events.manualGateHit() ? 3 : (t.failed > 0 ? 1 : 0);

  if (!args.verify) { return runCode; }
  // A clean task tally is not evidence — fold the PRD verdict into the exit code.
  const verifyCode = await runVerifyCore(args, ctx, plan, events);
  return runCode !== 0 ? runCode : verifyCode;
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
  return runVerifyCore(args, ctx, plan, events);
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

async function cmdDaemon(args: Args, ctx: Ctx): Promise<number> {
  const { runDaemon } = require('./daemon');
  const { fetchOpenIssues, newIssuesToTasks, reportIssueResult } = require('../github/issue-sync');
  const { createEmptyPlan, createPlaylist, createTask } = require('../models/plan');

  const configPath = args.configPath ?? path.join(args.cwd, '.moag', 'daemon.json');
  let config: any;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
  catch (err) { process.stderr.write(`Failed to read daemon config at ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`); return 2; }

  if (args.maxTicks) { config.maxTicks = args.maxTicks; }
  if (args.intervalSec && args.intervalSec !== 300) { config.intervalSec = args.intervalSec; }
  if (config.fullAuto) { await ctx.vscode.workspace.getConfiguration('agentTaskPlayer').update('fullAuto', true); }

  wireEvents(ctx.runner); // stream task/incident events into the JSONL output

  let stopping = false;
  // Flip the flag runDaemon polls, then abort whatever the runner is mid-way through.
  const onSignal = () => {
    stopping = true;
    emit({ event: 'daemon-stopping' });
    ctx.runner.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

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

  return runDaemon(config, {
    runner: ctx.runner,
    TaskStatus: ctx.TaskStatus,
    fetchOpenIssues, newIssuesToTasks, reportIssueResult,
    createEmptyPlan, createPlaylist, createTask,
    emit,
    sleep,
    shouldStop: () => stopping,
  });
}

// ─── entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'run') {
    if (!args.planPath) { process.stderr.write('Usage: moag run <plan.json> [--full-auto] [--engine <id>] [--cwd <dir>]\n'); return 2; }
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
  if (args.command === 'daemon') {
    return cmdDaemon(args, await setup(args));
  }
  process.stderr.write(
    'Usage: moag <run|verify|loop|daemon> ...\n' +
    '  moag run <plan.json> [--full-auto] [--engine <id>] [--verify] [--fix]\n' +
    '  moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--max-iterations <n>]\n' +
    '  moag loop --repo <owner/repo> [--label <l>] [--interval <sec>] [--once] [--full-auto]\n' +
    '  moag daemon [--config <.moag/daemon.json>] [--interval <sec>] [--max-ticks <n>] [--full-auto]\n',
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
