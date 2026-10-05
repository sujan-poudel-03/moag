// ─── Run worker (child-process entry) ───
//
// One process per job. The server spawns `node out/server/run-worker.js <job.json>`
// with cwd = the job's workspace (the project repo for runs; a server-owned empty
// scratch dir for plan generation) and a BUILT environment (see run-env.ts). The
// worker installs the headless vscode shim against a server-generated config,
// runs exactly one job, reports JSONL on stdout and exits with the headless
// exit-code contract: 0 ok · 1 gaps · 2 error · 3 ship gate · 4 cost ceiling.
//
// Only four modules are imported at top level. Everything that touches the
// engine core is required lazily inside `main()`, AFTER the shim is installed,
// so this file (and its unit tests) never load `vscode`.

import * as fs from 'fs';
import * as path from 'path';
import { parseJob, WorkerJob, RunJob, PlanJob, ProbeRow, DeltaOutcomeKind } from './worker-protocol';
import { installVscodeShim } from '../headless/install-shim';

// ─── Narrow structural types (no engine-core imports at top level) ───

interface TaskLike { id: string; name: string; status?: string; engine?: string; }
interface PlaylistLike { engine?: string; tasks: TaskLike[]; }
interface PlanLike { defaultEngine: string; playlists: PlaylistLike[]; }
type Listener = (...args: never[]) => void;

export interface RunnerLike {
  on(event: string, listener: Listener): void;
  off(event: string, listener: Listener): void;
  play(plan: PlanLike, playlistIndex?: number): Promise<void>;
  stop(): void;
}

interface EngineResultLike { stdout: string; stderr: string; exitCode: number; durationMs: number; }

export interface DeltaOutcomeLike {
  kind: DeltaOutcomeKind;
  error?: string;
  rejected?: Array<{ taskName: string; reason: string }>;
  playlist?: unknown;
}

/** What the halt accessors look like to `runVerifyCore`. */
export interface RunEventState {
  manualGateHit(): boolean;
  manualGateTaskId(): string | null;
  budgetHit(): boolean;
}

export interface WorkerDeps {
  runner: RunnerLike;
  loadPlan(planPath: string): PlanLike;
  savePlanAtomic(plan: PlanLike, planPath: string): void;
  getEngine(id: string): { runTask(opts: { prompt: string; cwd: string; signal: AbortSignal; costLabel?: string }): Promise<EngineResultLike> };
  generateDeltaPlan(plan: PlanLike, deps: {
    runEngine: (prompt: string, signal: AbortSignal) => Promise<EngineResultLike>;
    signal: AbortSignal;
  }): Promise<DeltaOutcomeLike>;
  checkAvailability(): Promise<ProbeRow[]>;
  costLedger: { onRecord(listener: (e: { estimatedCostUsd: number }) => void): () => void };
  /** `cli.runVerifyCore` bound to this job's args/ctx with persist = 'plan'. */
  runVerifyCore(plan: PlanLike, events: RunEventState): Promise<number>;
  emit(obj: Record<string, unknown>): void;
  /** Register a stop request handler (IPC `stop` / `disconnect`). Returns a disposer. */
  onStop(cb: () => void): () => void;
  env: NodeJS.ProcessEnv;
  /** `validateRoutingConfig` from routing-store. */
  validateRoutingConfig(raw: unknown): { dropped: string[] };
  /** `withSyntheticBaseline` from prd-ops. */
  withSyntheticBaseline(plan: PlanLike): PlanLike;
  /** Serialize one playlist the way `savePlan` would. */
  dehydratePlaylist(plan: PlanLike, playlist: unknown): unknown;
  /** Defer a callback past the current emit (setImmediate in production). */
  defer?(fn: () => void): void;
  /** `classifyFailure(stderr, stdout).category` from the runner; absent = every failure is a verdict. */
  failureCategory?(stderr: string, stdout: string): string;
}

const ERROR_TAIL_CHARS = 2000;

/**
 * Failure categories that say nothing about the engine × stack pair: the engine
 * never got to work on the task (bad credentials, provider throttling, CLI not
 * installed). Such a failure is not stack evidence.
 */
export const NON_EVIDENCE_FAILURE_CATEGORIES: readonly string[] = ['auth', 'rate-limit', 'cli-missing'];

/** The runner's own message when a task halts on a broken pre-flight baseline (runner.ts executeTask). */
const PREFLIGHT_HALT_MARKER = '[Pre-flight] Baseline already broken';

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ─── Job dispatch ───

/** Run one job. Never throws: every failure becomes an `error` event and exit code 2. */
export async function runJob(job: WorkerJob, deps: WorkerDeps): Promise<number> {
  try {
    switch (job.kind) {
      case 'run': return await runRunJob(job, deps);
      case 'plan': return await runPlanJob(job, deps);
      case 'probe': return await runProbeJob(deps);
    }
  } catch (err) {
    deps.emit({ event: 'error', message: errMessage(err) });
    return 2;
  }
}

// ─── Run mode ───

async function runRunJob(job: RunJob, deps: WorkerDeps): Promise<number> {
  // A CI env makes the runner auto-skip ship gates. The server strips CI, so its
  // presence here means something is wrong — refuse rather than auto-approve.
  if (deps.env.CI) {
    deps.emit({ event: 'error', message: 'Refusing to run: CI is set in the worker environment (it would auto-approve ship gates).' });
    return 2;
  }

  warnOnRoutingConfig(job.workspace, deps);

  const { runner } = deps;
  const defer = deps.defer ?? ((fn: () => void) => { setImmediate(fn); });
  const plan = deps.loadPlan(job.planPath);
  let gateHit = false;
  let gateTaskId: string | null = null;
  let budgetHit = false;
  // Set once anything asks the runner to stop (gate, budget, IPC stop/disconnect):
  // tasks that end after it were aborted, not judged by their engine.
  let stopRequested = false;
  const requestStop = (): void => { stopRequested = true; runner.stop(); };
  // Tasks whose execution actually began (task-started). Skipped and Blocked
  // tasks end without one; they are not evidence about any engine.
  const started = new Set<string>();
  /**
   * Did the engine run this task to its own verdict? False for skipped and
   * blocked tasks, a pre-flight baseline halt, and anything ending after a stop
   * request — the server records stack evidence only when this is true.
   */
  const engineRan = (t: TaskLike, result?: Partial<EngineResultLike>): boolean =>
    started.has(t.id) && !stopRequested && !String(result?.stderr ?? '').includes(PREFLIGHT_HALT_MARKER);
  /** A failure the environment caused (auth, rate limit, missing CLI) is no verdict on the engine. */
  const environmentFailure = (result?: Partial<EngineResultLike>): boolean => {
    if (!deps.failureCategory) { return false; }
    try { return NON_EVIDENCE_FAILURE_CATEGORIES.includes(deps.failureCategory(String(result?.stderr ?? ''), String(result?.stdout ?? ''))); }
    catch { return false; }
  };

  const persist = (): void => {
    try { deps.savePlanAtomic(plan, job.planPath); }
    catch (err) { deps.emit({ event: 'error', message: `Failed to persist run snapshot: ${errMessage(err)}` }); }
  };

  const listeners: Array<[string, Listener]> = [
    ['state-changed', ((state: string) => deps.emit({ event: 'state', state })) as Listener],
    ['task-started', ((t: TaskLike, pl?: PlaylistLike) => {
      started.add(t.id);
      deps.emit({ event: 'task-started', id: t.id, name: t.name });
      const engine = t.engine ?? pl?.engine ?? plan.defaultEngine;
      if (engine) { deps.emit({ event: 'task-engine', id: t.id, engine }); }
    }) as Listener],
    ['task-completed', ((t: TaskLike, result?: Partial<EngineResultLike>) => {
      // The runner also emits task-completed for a SKIPPED task; the status says which.
      deps.emit({ event: 'task-completed', id: t.id, name: t.name, ...(t.status ? { status: t.status } : {}), engineRan: engineRan(t, result) });
      started.delete(t.id);
      persist();
    }) as Listener],
    ['task-failed', ((t: TaskLike, result?: Partial<EngineResultLike>) => {
      // ...and task-failed for a BLOCKED one.
      deps.emit({
        event: 'task-failed', id: t.id, name: t.name, ...(t.status ? { status: t.status } : {}),
        engineRan: engineRan(t, result) && !environmentFailure(result),
      });
      started.delete(t.id);
      const tail = String(result?.stderr || result?.stdout || '').slice(-ERROR_TAIL_CHARS);
      if (tail) { deps.emit({ event: 'task-error-tail', id: t.id, tail }); }
      persist();
    }) as Listener],
    ['task-escalate', ((t: TaskLike, category: string) => deps.emit({ event: 'task-escalate', id: t.id, name: t.name, category })) as Listener],
    ['incident', ((t: TaskLike, summary: string, issueUrl: string | null) =>
      deps.emit({ event: 'incident', id: t.id, name: t.name, summary, issueUrl })) as Listener],
    ['error', ((err: Error) => deps.emit({ event: 'error', message: errMessage(err) })) as Listener],
    ['engine-fallback', ((d: { taskId: string; toEngine: string }) =>
      deps.emit({ event: 'task-engine', id: d.taskId, engine: d.toEngine })) as Listener],
    ['budget-exceeded', ((d: { totalCost: number; budget: number }) => {
      budgetHit = true;
      deps.emit({ event: 'budget-exceeded', totalCost: d.totalCost, budget: d.budget });
      stopRequested = true;
      defer(() => runner.stop());
    }) as Listener],
    ['manual-gate', ((t: TaskLike) => {
      gateHit = true;
      gateTaskId = t.id;
      deps.emit({ event: 'manual-gate', id: t.id, name: t.name, note: 'Halting for human approval (ship gate).' });
      // Deferred on purpose: stop() inside this emit aborts the task signal BEFORE
      // runManualTask attaches its abort listener, so the gate promise would never
      // settle. One tick later the listener is attached and the abort lands.
      stopRequested = true;
      defer(() => runner.stop());
    }) as Listener],
  ];

  let unsubscribeCost: (() => void) | null = null;
  let disposeStop: (() => void) | null = null;
  try {
    unsubscribeCost = deps.costLedger.onRecord((e) => deps.emit({ event: 'cost', usd: e.estimatedCostUsd }));
    for (const [ev, fn] of listeners) { runner.on(ev, fn); }
    // IPC stop or parent disconnect: stop the runner and let play() settle — it
    // aborts and tree-kills the running task — before this function returns.
    // Nothing here exits the process; main() exits only after runJob resolves.
    disposeStop = deps.onStop(requestStop);

    try {
      await runner.play(plan, job.startPlaylistIndex);
    } catch (err) {
      deps.emit({ event: 'error', message: errMessage(err) });
      persist();
      deps.emit({ event: 'run-finished', code: 2 });
      return 2;
    }
    // Blocked/Skipped are set without a terminal event; capture the final statuses.
    persist();

    let code: number;
    if (gateHit) { code = 3; }
    else if (budgetHit) { code = 4; }
    else if (plan.playlists.some((pl) => pl.tasks.some((t) => t.status === 'failed'))) { code = 1; }
    // Stopped (or orphaned by a dead server): no verify model call nobody asked for.
    else if (stopRequested) { code = 1; }
    else {
      code = await deps.runVerifyCore(plan, {
        manualGateHit: () => gateHit,
        manualGateTaskId: () => gateTaskId,
        budgetHit: () => budgetHit,
      });
    }
    deps.emit({ event: 'run-finished', code });
    return code;
  } finally {
    unsubscribeCost?.();
    disposeStop?.();
    for (const [ev, fn] of listeners) { runner.off(ev, fn); }
  }
}

/** Repo-controlled routing config: report every value the validator drops. */
function warnOnRoutingConfig(workspace: string, deps: WorkerDeps): void {
  const file = path.join(workspace, '.moag', 'routing.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    deps.emit({ event: 'warning', message: '.moag/routing.json is not valid JSON and was ignored.' });
    return;
  }
  for (const d of deps.validateRoutingConfig(parsed).dropped) {
    deps.emit({ event: 'warning', message: `.moag/routing.json: dropped ${d}` });
  }
}

// ─── Plan mode ───

/** Most characters of the server's repository listing a planning prompt carries. */
export const MAX_REPO_LISTING_CHARS = 120_000;

/** Append the server-generated repository listing (plain text, capped) to a planning prompt. */
export function withRepoListing(prompt: string, listing: string | null): string {
  const text = (listing ?? '').trim().slice(0, MAX_REPO_LISTING_CHARS);
  return text ? `${prompt}\n\n${text}` : prompt;
}

/**
 * Plan generation runs with cwd = `job.workspace`, a server-owned EMPTY scratch
 * directory: the engine CLI never starts inside the repository, so repo-shipped
 * engine config (`.claude/settings.json` hooks, `.mcp.json`, `.gemini/`) cannot
 * load. The planner sees the repository only as the server's file listing.
 */
async function runPlanJob(job: PlanJob, deps: WorkerDeps): Promise<number> {
  let listing: string | null = null;
  if (job.repoListingPath) {
    try { listing = fs.readFileSync(job.repoListingPath, 'utf-8'); }
    catch (err) { deps.emit({ event: 'warning', message: `Repository listing unavailable: ${errMessage(err)}` }); }
  }
  const loaded = deps.loadPlan(job.planPath);
  const copy = job.mode === 'initial' ? deps.withSyntheticBaseline(loaded) : loaded;
  const abort = new AbortController();
  let unsubscribeCost: (() => void) | null = null;
  let disposeStop: (() => void) | null = null;
  try {
    unsubscribeCost = deps.costLedger.onRecord((e) => deps.emit({ event: 'cost', usd: e.estimatedCostUsd }));
    disposeStop = deps.onStop(() => abort.abort());
    const engine = deps.getEngine(job.engine);
    const outcome = await deps.generateDeltaPlan(copy, {
      runEngine: (prompt, signal) => engine.runTask({ prompt: withRepoListing(prompt, listing), cwd: job.workspace, signal, costLabel: 'plan-generation' }),
      signal: abort.signal,
    });
    const doc: Record<string, unknown> = { kind: outcome.kind };
    if (outcome.error !== undefined) { doc.error = outcome.error; }
    if (outcome.rejected !== undefined) { doc.rejected = outcome.rejected; }
    if (outcome.kind === 'appended' && outcome.playlist !== undefined) {
      doc.playlist = deps.dehydratePlaylist(copy, outcome.playlist);
    }
    fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
    fs.writeFileSync(job.outPath, JSON.stringify(doc, null, 2), { encoding: 'utf-8', mode: 0o600 });
    deps.emit({ event: 'plan-outcome', kind: outcome.kind });
    return 0;
  } finally {
    unsubscribeCost?.();
    disposeStop?.();
  }
}

// ─── Probe mode ───

async function runProbeJob(deps: WorkerDeps): Promise<number> {
  const engines = await deps.checkAvailability();
  deps.emit({ event: 'probe-result', engines });
  return 0;
}

// ─── Entry ───

function emitLine(obj: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch { /* parent gone: nothing is listening; keep supervising the task tree */ }
}

/**
 * Swallow write errors on the worker's pipes. When the server dies, the next
 * write gets EPIPE; unhandled, that error event crashes the worker and orphans
 * the agent it was supervising (still running, with no timeout and uncounted
 * spend). With this the worker survives, its disconnect handler stops the
 * runner, and it exits only once play() has settled and killed the task tree.
 */
export function guardParentPipes(...streams: Array<{ on(event: 'error', fn: (err: Error) => void): unknown } | null | undefined>): void {
  for (const s of streams) { s?.on('error', () => { /* EPIPE after the parent died */ }); }
}

// ─── Post-disconnect watchdog ───

/** How long a worker whose server died may take to settle before it kills its own tree and exits. */
export const DISCONNECT_WATCHDOG_MS = 30_000;

export interface DisconnectWatchdogOptions {
  /** Kill every descendant of this process (`killOwnProcessTree`). */
  killTree(): void;
  exit(code: number): void;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/**
 * Arm the last-resort exit for a worker whose server is gone. The disconnect
 * handler already stopped the runner; normally `play()` settles and `main()`
 * exits well inside the grace period. If it has not — a task that escaped its
 * abort, a hung promise — nobody is left to stop it, and while the worker lives
 * the project's job lock stays held. So after `graceMs` the worker kills its own
 * process tree and exits 2, unconditionally. Never throws.
 */
export function armDisconnectWatchdog(opts: DisconnectWatchdogOptions): void {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  setTimer(() => {
    try { opts.killTree(); } catch { /* exit regardless */ }
    opts.exit(2);
  }, opts.graceMs ?? DISCONNECT_WATCHDOG_MS);
}

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Wire the real dependencies (post-shim) and run the job named on argv. */
async function main(): Promise<number> {
  guardParentPipes(process.stdout, process.stderr);
  // Server gone: the job's onStop handler stops the runner; this guarantees the
  // worker (and the job lock it holds) does not outlive it if play() never settles.
  process.once('disconnect', () => armDisconnectWatchdog({
    killTree: () => require('../utils/process-kill').killOwnProcessTree(),
    exit: (code) => process.exit(code),
  }));
  const jobPath = process.argv[2];
  if (!jobPath) { emitLine({ event: 'error', message: 'usage: run-worker <job.json>' }); return 2; }
  let job: WorkerJob | null = null;
  try { job = parseJob(JSON.parse(fs.readFileSync(jobPath, 'utf-8'))); } catch { job = null; }
  if (!job) { emitLine({ event: 'error', message: 'Malformed job file.' }); return 2; }
  if (process.env.CI) {
    emitLine({ event: 'error', message: 'Refusing to run: CI is set in the worker environment.' });
    return 2;
  }

  const workspace = job.kind === 'probe' ? process.cwd() : job.workspace;
  installVscodeShim(workspace);

  const { loadPlan, dehydratePlan } = require('../models/plan');
  const { writeFileAtomicSync } = require('../utils/file-io');
  const { TaskRunner } = require('../runner/runner');
  const { HistoryStore } = require('../history/store');
  const { registerAllEngines, getEngine } = require('../adapters/index');
  const { TaskStatus } = require('../models/types');
  const { costLedger } = require('../utils/cost-ledger');
  const { generateDeltaPlan } = require('../runner/prd-plan');
  const { validateRoutingConfig } = require('../routing/routing-store');
  const cli = require('../headless/cli');
  const vscode = require('../headless/vscode-shim');
  const { FileMemento } = require('../headless/install-shim');
  registerAllEngines();

  // The runner's history memento lives beside the job file (server data dir),
  // never in the workspace, where an agent's relative-path edits could reach it.
  const statePath = path.join(path.dirname(path.resolve(jobPath)), 'headless-state.json');
  const runner = new TaskRunner(new HistoryStore(new FileMemento(statePath)));

  const deps: WorkerDeps = {
    runner,
    loadPlan,
    savePlanAtomic: (plan, p) => writeFileAtomicSync(p, JSON.stringify(dehydratePlan(plan), null, 2)),
    getEngine,
    generateDeltaPlan,
    checkAvailability: async () => {
      const { checkEngineAvailability } = require('../adapters/engine');
      const { ENGINE_PRIORITY } = require('../engine-detection');
      const map: Map<string, { available: boolean; version?: string }> = await checkEngineAvailability(ENGINE_PRIORITY);
      return (ENGINE_PRIORITY as string[]).map((id) => {
        const a = map.get(id);
        return { id, available: a?.available === true, ...(a?.version ? { version: a.version } : {}) } as ProbeRow;
      });
    },
    costLedger,
    runVerifyCore: (plan, events) => {
      if (job?.kind !== 'run') { return Promise.resolve(2); }
      const args = cli.parseArgs(['verify', job.planPath, '--cwd', job.workspace, '--no-uat']);
      const ctx = { runner, vscode, TaskStatus, loadPlan };
      return cli.runVerifyCore(args, ctx, plan, events, 'plan');
    },
    emit: emitLine,
    onStop: (cb) => {
      const onMessage = (m: unknown): void => {
        if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'stop') { cb(); }
      };
      process.on('message', onMessage);
      process.on('disconnect', cb);
      return () => { process.off('message', onMessage); process.off('disconnect', cb); };
    },
    env: process.env,
    validateRoutingConfig,
    withSyntheticBaseline: (plan) => require('./prd-ops').withSyntheticBaseline(plan),
    dehydratePlaylist: (plan, playlist) => dehydratePlan({ ...(plan as any), playlists: [playlist] }).playlists[0],
    failureCategory: (stderr, stdout) => require('../runner/runner').classifyFailure(stderr, stdout).category,
  };
  return runJob(job, deps);
}
/* eslint-enable @typescript-eslint/no-var-requires */
/* eslint-enable @typescript-eslint/no-explicit-any */

if (require.main === module) {
  main()
    .then((code) => {
      // Flush stdout before exiting so the last JSONL line is not lost. With the
      // parent gone the flush may never call back; exit anyway.
      setTimeout(() => process.exit(code), 2000);
      try { process.stdout.write('', () => process.exit(code)); } catch { process.exit(code); }
    })
    .catch((err) => {
      emitLine({ event: 'error', message: errMessage(err) });
      process.exit(2);
    });
}
