#!/usr/bin/env node
/**
 * MOAG headless CLI — run a plan, or run a continuous intake loop, with no VS Code.
 *
 *   moag run  <plan.json> [--no-interactive] [--full-auto] [--engine <id>] [--cwd <dir>]
 *   moag loop --repo <owner/repo> [--label <l>] [--interval <sec>] [--once]
 *             [--full-auto] [--engine <id>] [--cwd <dir>]
 *
 * `run`  executes a single plan file.
 * `loop` polls a GitHub repo for open issues, turns each new issue into a task,
 *        runs them, then reports the outcome back to the issue (comment + close on
 *        success; comment + label on failure) — the closed autonomous loop.
 *
 * Exit codes: 0 ok · 1 task(s) failed · 2 error/usage · 3 halted at ship gate.
 * Progress is JSONL on stdout; human notices on stderr.
 */

import * as path from 'path';
import { installVscodeShim, FileMemento } from './install-shim';

interface Args {
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
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? '', cwd: process.cwd(),
    noInteractive: false, fullAuto: false, intervalSec: 300, once: false,
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--no-interactive') { a.noInteractive = true; }
    else if (arg === '--full-auto') { a.fullAuto = true; }
    else if (arg === '--once') { a.once = true; }
    else if (arg === '--engine') { a.engine = rest[++i]; }
    else if (arg === '--cwd') { a.cwd = path.resolve(rest[++i]); }
    else if (arg === '--repo') { a.repo = rest[++i]; }
    else if (arg === '--label') { a.label = rest[++i]; }
    else if (arg === '--interval') { a.intervalSec = Math.max(10, parseInt(rest[++i], 10) || 300); }
    else if (arg === '--config') { a.configPath = path.resolve(a.cwd, rest[++i]); }
    else if (arg === '--max-ticks') { a.maxTicks = Math.max(1, parseInt(rest[++i], 10) || 1); }
    else if (!arg.startsWith('--') && !a.planPath) { a.planPath = path.resolve(a.cwd, arg); }
  }
  return a;
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-var-requires */
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
  return { runner, vscode, TaskStatus, loadPlan };
}

/** Wire runner events to JSONL output. Returns a getter for whether a gate halted. */
function wireEvents(runner: any): () => boolean {
  let manualGateHit = false;
  runner.on('state-changed', (state: string) => emit({ event: 'state', state }));
  runner.on('task-started', (t: any) => emit({ event: 'task-started', id: t.id, name: t.name }));
  runner.on('task-completed', (t: any) => emit({ event: 'task-completed', id: t.id, name: t.name }));
  runner.on('task-failed', (t: any) => emit({ event: 'task-failed', id: t.id, name: t.name }));
  runner.on('task-escalate', (t: any, category: string) => emit({ event: 'task-escalate', id: t.id, name: t.name, category }));
  runner.on('incident', (t: any, summary: string, issueUrl: string | null) => emit({ event: 'incident', id: t.id, name: t.name, summary, issueUrl }));
  runner.on('error', (err: Error) => emit({ event: 'error', message: err.message }));
  runner.on('manual-gate', (t: any) => {
    manualGateHit = true;
    emit({ event: 'manual-gate', id: t.id, name: t.name, note: 'Halting for human approval (ship gate).' });
    runner.stop();
  });
  return () => manualGateHit;
}

function tally(plan: any, TaskStatus: any): { total: number; completed: number; failed: number } {
  const tasks = plan.playlists.flatMap((pl: any) => pl.tasks);
  return {
    total: tasks.length,
    completed: tasks.filter((t: any) => t.status === TaskStatus.Completed).length,
    failed: tasks.filter((t: any) => t.status === TaskStatus.Failed).length,
  };
}

// ─── command: run ────────────────────────────────────────────────────────────

async function cmdRun(args: Args, ctx: Ctx): Promise<number> {
  const planPath = args.planPath!;
  let plan;
  try { plan = ctx.loadPlan(planPath); }
  catch (err) { process.stderr.write(`Failed to load plan: ${err instanceof Error ? err.message : String(err)}\n`); return 2; }
  if (args.engine) { plan.defaultEngine = args.engine; }

  const gateHalted = wireEvents(ctx.runner);
  emit({ event: 'run-started', plan: plan.name, planPath, fullAuto: args.fullAuto });
  try { await ctx.runner.play(plan); }
  catch (err) { emit({ event: 'error', message: err instanceof Error ? err.message : String(err) }); return 2; }

  const t = tally(plan, ctx.TaskStatus);
  emit({ event: 'run-finished', ...t, manualGateHit: gateHalted() });
  if (gateHalted()) { return 3; }
  return t.failed > 0 ? 1 : 0;
}

// ─── command: loop ───────────────────────────────────────────────────────────

async function cmdLoop(args: Args, ctx: Ctx): Promise<number> {
  if (!args.repo) { process.stderr.write('loop requires --repo <owner/repo>\n'); return 2; }
  const repo: string = args.repo;
  // Lazy-require the loop core (vscode-free, but keep all requires past shim install).
  const { fetchOpenIssues, newIssuesToTasks, reportIssueResult } = require('../github/issue-sync');
  const { createEmptyPlan, createPlaylist } = require('../models/plan');

  const gateHalted = wireEvents(ctx.runner);
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
      if (gateHalted()) { emit({ event: 'loop-halted', reason: 'ship-gate' }); return 3; }
    }

    if (args.once || stopping) { break; }
    await sleep(args.intervalSec * 1000);
  } while (!stopping);

  emit({ event: 'loop-finished', iterations: iteration });
  return 0;
}

// ─── command: daemon ─────────────────────────────────────────────────────────

async function cmdDaemon(args: Args, ctx: Ctx): Promise<number> {
  const fs = require('fs');
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
  const onSignal = () => { stopping = true; emit({ event: 'daemon-stopping' }); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

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
  if (args.command === 'loop') {
    return cmdLoop(args, await setup(args));
  }
  if (args.command === 'daemon') {
    return cmdDaemon(args, await setup(args));
  }
  process.stderr.write(
    'Usage: moag <run|loop|daemon> ...\n' +
    '  moag run <plan.json> [--full-auto] [--engine <id>]\n' +
    '  moag loop --repo <owner/repo> [--label <l>] [--interval <sec>] [--once] [--full-auto]\n' +
    '  moag daemon [--config <.moag/daemon.json>] [--interval <sec>] [--max-ticks <n>] [--full-auto]\n',
  );
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  });
