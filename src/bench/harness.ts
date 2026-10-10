// ─── `moag bench`: benchmark harness ───
//
// Drives the REAL hosted server end to end over HTTP, the way a team would:
// an admin bootstraps the server and creates a product owner, a reviewer and
// an approver; the product owner creates the project and saves each PRD
// version; the reviewer approves each generated plan and starts the run; the
// approver decides each ship gate. The bench plays every role automatically,
// but RECORDS each decision: the two approvals a version always needs
// (`plan-approval`, `ship-approval`) as required, anything else (a bump
// override, a rejected plan or gate, a generated manual gate, a lock wait, a
// timeout, a budget halt) as unplanned — so autonomy is measured honestly.
//
// Spend is bounded four ways: Claude's own `--max-budget-usd` per call, the
// server's per-version cap (set by the bench before each version), the
// bench's between-version cap (total minus the upper bound minus a reserve),
// and a watchdog that stops the run when one more call could cross the total.
// A dry-run swaps the engine for a fake `claude` and spends nothing.
//
// Outputs (in `--out`): events.jsonl (every HTTP call, SSE event and gate
// run, credentials redacted; capped at 50 MB) and summary.json.
//
// Never imports vscode (pinned by no-vscode.test.ts).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { SHIP_GATE_NAME } from '../server/prd-ops';
import { BenchClient, BenchResponse, BenchSseEvent, redactForLog } from './client';
import { BudgetLedger, CostEventSource } from './budget';
import {
  BenchEnvironment, BenchSummary, GateRunObservation, Intervention, VersionObservation, buildVersionMetrics, emptyObservation,
  environmentFindings, errorLine, summarize,
} from './metrics';
import { Scenario, dryRunProblem, parseScenario, scenarioAllowedCommands, BenchScenarioError } from './scenario';
import { builtInProfile } from '../standards/built-in-profiles';
import { StandardsProfile, profileHash } from '../standards/profile';
import { CommandResult, PreparedWorkspace, gatesGreen, prepareWorkspace, runCommand, runGates } from './workspace';
import { FAKE_VERSION_MARKER, FakeEngine, installFakeEngine, readFakeCalls } from './fake-engine';
import { LaunchOptions, LaunchedServer, launchServer } from './server-launcher';
import { describeLeftovers, defaultIsAlive, findLiveLeftovers } from './leftovers';
import { ensureDependencies } from '../runner/dependency-install';
import type { DependencyEvent } from '../models/types';

/** Cap on events.jsonl. */
export const MAX_EVENTS_BYTES = 50 * 1024 * 1024;
/** At most this many run segments per version (gate approvals resume a new one). */
export const MAX_SEGMENTS = 6;
/** How long the bench waits for the server's engine probe. */
export const ENGINE_PROBE_WAIT_MS = 2 * 60_000;
const LOCK_RETRY_MS = 5_000;
const LOCK_RETRY_MAX_MS = 6 * 60_000;
const RUN_TERMINAL = new Set(['completed', 'gaps', 'error', 'budget', 'stopped', 'ship-rejected', 'interrupted']);

export interface BenchOptions {
  dryRun: boolean;
  outDir: string;
  /** Required for a paid run; the effective cap is min(maxUsd, scenario.budgetUsd). */
  maxUsd?: number;
  /**
   * Paid runs only: carry on when an `environmentProbes` command fails in the
   * untouched workspace (`--allow-failed-probes`). Without it a paid run stops
   * there, before any engine call. A dry-run never stops for a probe.
   */
  allowFailedProbes?: boolean;
  /** Human progress lines (default: stderr). */
  progress?: (line: string) => void;
}

/** What the bench learned about the engine before planning anything. */
export interface EngineCheck {
  available: boolean | null;
  /** Version from the server's own `--version` probe (null when it could not run the CLI). */
  probeVersion: string | null;
  /** `<engine> --version` resolved through a shell with the server's PATH, the way runs resolve it. */
  shellVersion: string | null;
  error?: string;
}

export interface BenchDeps {
  launchServer: (opts: LaunchOptions) => Promise<LaunchedServer>;
  prepareWorkspace: (scenario: Scenario, projectsRoot: string, name: string, env: NodeJS.ProcessEnv) => Promise<PreparedWorkspace>;
  runGates: (commands: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<CommandResult[]>;
  /**
   * Install the workspace's dependencies before the acceptance gates, from the same fixed
   * table the worker uses. Always on: not tied to any MOAG setting.
   */
  ensureDependencies: (
    cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal,
  ) => Promise<{ ok: boolean; aborted: boolean; events: DependencyEvent[] }>;
  checkEngine: (client: BenchClient, scenario: Scenario, server: LaunchedServer) => Promise<EngineCheck>;
  installFakeEngine: (binDir: string) => FakeEngine;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  lockRetryMs: number;
  lockRetryMaxMs: number;
  /**
   * Register handlers for the bench's own termination: `signal(name)` for SIGINT,
   * SIGTERM, SIGHUP (and SIGBREAK on Windows), `exit()` for the process `exit`
   * event. Returns a disposer that removes every handler it added.
   */
  onTermination: (h: { signal(name: string): void; exit(): void }) => () => void;
  /** Is this pid alive? (the leftover-worker check on a non-empty --out). */
  isPidAlive: (pid: number) => boolean;
}

export interface BenchResult {
  exitCode: number;
  summary: BenchSummary | null;
  summaryPath: string | null;
}

// ─── Event log ───

/** Append-only JSONL log with a size cap (lines past the cap are dropped and counted). */
export class EventLog {
  private bytes = 0;
  truncated = false;
  dropped = 0;
  constructor(readonly file: string, private readonly maxBytes = MAX_EVENTS_BYTES) {}
  write(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    const n = Buffer.byteLength(line);
    if (this.bytes + n > this.maxBytes) { this.truncated = true; this.dropped++; return; }
    try { fs.appendFileSync(this.file, line); this.bytes += n; } catch { this.dropped++; }
  }
}

// ─── Plan approval policy ───

/** Task types the bench never auto-approves: they publish, tag or deploy. */
const UNREVIEWED_TASK_TYPES = new Set(['release', 'deploy']);

/** The parts of a generated plan the bench inspects before it plays the reviewer. */
export interface GeneratedPlanForApproval {
  playlist?: { parallel?: unknown; tasks?: Array<{ id?: string; name?: string; type?: string; command?: unknown }> };
  review?: { ok?: boolean; errors?: string[]; commands?: Array<{ taskName?: string; field?: string; value?: string }> };
}

// The allow-list lives with the scenario (its parser needs it for the standards profile).
export { scenarioAllowedCommands };

/**
 * Why the bench must NOT auto-approve a generated plan, or an empty list when
 * it may. The bench approves without a human reading the plan, so it refuses:
 * a review the server flagged; a missing review; a `parallel` playlist (every
 * budget guard assumes one engine call in flight at a time); any release or
 * deploy task; and any reviewed entry (`command`, `verifyCommand`, `cwd` or a
 * side-effect field) that is not exactly one of `allowedCommands`
 * ({@link scenarioAllowedCommands}). Each refusal names the offending value.
 */
export function planApprovalProblems(plan: GeneratedPlanForApproval, allowedCommands: readonly string[]): string[] {
  const problems: string[] = [];
  const review = plan.review;
  if (!review) { problems.push('the server returned no review for the plan.'); }
  if (review && review.ok === false) { problems.push(...(review.errors ?? [])); }
  // Truthiness, exactly as the runner decides it (`playlist.parallel && !failSafe`):
  // a plan saying "true" or 1 runs in parallel there, so it is refused here.
  if (plan.playlist?.parallel) {
    problems.push('the playlist runs its tasks in parallel, which the bench budget guards cannot bound.');
  }
  for (const t of plan.playlist?.tasks ?? []) {
    if (typeof t.type === 'string' && UNREVIEWED_TASK_TYPES.has(t.type)) {
      problems.push(`task "${String(t.name ?? '?')}" is a ${t.type} task.`);
    }
  }
  const allowed = new Set(allowedCommands.map((c) => c.trim()));
  for (const c of review?.commands ?? []) {
    const isCommand = c.field === 'command' || c.field === 'verifyCommand';
    if (!isCommand || !allowed.has(String(c.value ?? '').trim())) {
      problems.push(`task "${String(c.taskName ?? '?')}" ${String(c.field ?? '?')}: ${String(c.value ?? '')}`);
    }
  }
  return problems;
}

// ─── Standards approval policy ───

/** The parts of a proposed standards version the bench inspects before it plays the reviewer. */
export interface ProposedStandardsForApproval {
  version?: number;
  status?: string;
  contentHash?: string;
  profile?: { commands?: Array<{ label?: string; run?: string }> };
  commands?: Array<{ label?: string; run?: string }>;
}

/**
 * The profile the bench product owner proposes for `scenario`: the scenario's
 * own profile, or the stack's built-in one with no commands — which has no
 * blocking rule at all, so every shipped scenario names a profile with a command. A cloned
 * repository has code, so the built-in (written for an empty repository) is
 * proposed as brownfield — the planner is not told to scaffold what exists.
 */
export function benchStandardsProfile(scenario: Pick<Scenario, 'stack' | 'repo' | 'standardsProfile'>): StandardsProfile {
  if (scenario.standardsProfile) { return scenario.standardsProfile.profile; }
  return { ...builtInProfile(scenario.stack), repoState: scenario.repo.kind === 'clone' ? 'brownfield' : 'greenfield', commands: [] };
}

/**
 * Why the bench must NOT approve a proposed standards version, or an empty
 * list when it may. Approving lets the version's commands run on the server on
 * every run, and the bench approves without a human reading it, so it refuses:
 * a version that is not pending; one whose content is not what the bench
 * proposed (`expectedHash`); and any command — in the verbatim list the
 * server shows a reviewer or in the profile itself — that is not exactly one of
 * `allowedCommands` ({@link scenarioAllowedCommands}).
 */
export function standardsApprovalProblems(
  version: ProposedStandardsForApproval | undefined, allowedCommands: readonly string[], expectedHash?: string,
): string[] {
  if (!version) { return ['the server returned no standards version to approve.']; }
  const problems: string[] = [];
  if (version.status !== 'pending') { problems.push(`standards v${String(version.version ?? '?')} is ${String(version.status ?? 'missing')}, not pending.`); }
  if (typeof version.contentHash !== 'string' || version.contentHash === '') {
    problems.push('the server returned no content hash for the standards version.');
  } else if (expectedHash !== undefined && version.contentHash !== expectedHash) {
    problems.push('the standards version the server holds is not the profile the bench proposed.');
  }
  if (!Array.isArray(version.commands)) { problems.push('the server returned no command list for the standards version.'); }
  const allowed = new Set(allowedCommands.map((c) => c.trim()));
  const seen = new Set<string>();
  for (const c of [...(version.commands ?? []), ...(version.profile?.commands ?? [])]) {
    const run = String(c.run ?? '');
    if (allowed.has(run.trim()) || seen.has(run)) { continue; }
    seen.add(run);
    problems.push(`standards command "${String(c.label ?? '?')}": ${run}`);
  }
  return problems;
}

// ─── Defaults ───

/** Poll the server's engine probe as admin, then resolve `<engine> --version` through a shell with the server's PATH. */
export async function defaultCheckEngine(client: BenchClient, scenario: Scenario, server: LaunchedServer): Promise<EngineCheck> {
  const deadline = Date.now() + ENGINE_PROBE_WAIT_MS;
  let row: { available?: boolean | null; version?: string | null; error?: string | null } | undefined;
  for (;;) {
    const r = await client.call('admin', 'GET', '/api/admin/engines', undefined, { quiet: true });
    if (r.status === 200 && typeof r.body.checkedAt === 'string' && r.body.inProgress !== true) {
      row = (r.body.rows as Array<{ id: string }> | undefined)?.find((x) => x.id === scenario.engine) as typeof row;
      break;
    }
    if (Date.now() > deadline) { return { available: null, probeVersion: null, shellVersion: null, error: 'the server engine probe did not finish within 2 minutes' }; }
    await new Promise((res) => setTimeout(res, 1_000));
  }
  const shell = await runCommand(`${scenario.engine} --version`, os.tmpdir(), server.serverEnv, 30_000);
  const firstLine = shell.exitCode === 0 ? shell.tail.trim().split(/\r?\n/)[0]?.trim() || null : null;
  return { available: row?.available ?? null, probeVersion: row?.version ?? null, shellVersion: firstLine, ...(row?.error ? { error: row.error } : {}) };
}

/** Production dependencies. */
export function defaultDeps(): BenchDeps {
  return {
    launchServer,
    prepareWorkspace,
    runGates,
    ensureDependencies: benchEnsureDependencies,
    checkEngine: defaultCheckEngine,
    installFakeEngine: (binDir) => installFakeEngine(binDir),
    now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    pollMs: 2_000,
    lockRetryMs: LOCK_RETRY_MS,
    lockRetryMaxMs: LOCK_RETRY_MAX_MS,
    onTermination: registerTermination,
    isPidAlive: defaultIsAlive,
  };
}

/** The signals the bench treats as "stop now". SIGBREAK (Ctrl+Break) exists only on Windows. */
export function terminationSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

/** Production {@link BenchDeps.onTermination}: real process signal and `exit` handlers. */
function registerTermination(h: { signal(name: string): void; exit(): void }): () => void {
  const added: Array<[string, (...a: unknown[]) => void]> = [];
  for (const sig of terminationSignals()) {
    const fn = (): void => h.signal(sig);
    try { process.on(sig, fn); added.push([sig, fn]); } catch { /* signal not supported here */ }
  }
  const onExit = (): void => h.exit();
  process.on('exit', onExit);
  added.push(['exit', onExit]);
  return () => { for (const [ev, fn] of added) { process.off(ev, fn); } };
}

/**
 * The bench's acceptance gates install dependencies exactly as a worker would, through
 * `runCommand` so the install runs with the same env, timeout and tree-kill as the gates.
 */
async function benchEnsureDependencies(
  cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal,
): Promise<{ ok: boolean; aborted: boolean; events: DependencyEvent[] }> {
  const result = await ensureDependencies(cwd, {
    settings: { enabled: true, ignoreScripts: false, pythonVenv: null },
    stage: 'bench',
    // Ctrl+C: no install starts after it. One already running ends at its timeout, like the gates.
    signal,
    timeoutMs,
    onEvent: () => undefined,
    exec: async (command, o) => {
      const r = await runCommand(command, o.cwd, env, o.timeoutMs);
      const exitCode = r.timedOut ? 124 : r.exitCode ?? 1;
      return { command, exitCode, passed: exitCode === 0, output: r.tail, durationMs: r.durationMs, timedOut: r.timedOut };
    },
  });
  return { ok: result.ok, aborted: result.aborted, events: result.events };
}

/** A strong random password that satisfies the server's policy. */
function randomPassword(): string {
  return `Bench-${randomBytes(18).toString('base64url')}-9a`;
}

class BenchAbort extends Error {
  constructor(message: string) { super(message); this.name = 'BenchAbort'; }
}

type JobEvent = { event?: string; usd?: unknown; source?: unknown; id?: unknown; name?: unknown; data?: Record<string, unknown> };

// ─── The run ───

/**
 * Run one scenario. Never throws: harness failures become exit code 2 with
 * `harnessError` in the summary (when one could be written).
 */
export async function runBench(scenario: Scenario, opts: BenchOptions, depsIn: Partial<BenchDeps> = {}): Promise<BenchResult> {
  const deps: BenchDeps = { ...defaultDeps(), ...depsIn };
  const progress = opts.progress ?? ((l: string) => process.stderr.write(`[moag bench] ${l}\n`));
  const mode: 'dry-run' | 'paid' = opts.dryRun ? 'dry-run' : 'paid';

  // ── Usage checks: before anything is created or started ──
  if (!opts.dryRun && !(typeof opts.maxUsd === 'number' && Number.isFinite(opts.maxUsd) && opts.maxUsd > 0)) {
    progress('a paid run needs --max-usd <n> (or use --dry-run). Nothing was started.');
    return { exitCode: 2, summary: null, summaryPath: null };
  }
  if (opts.dryRun) {
    const problem = dryRunProblem(scenario);
    if (problem) { progress(`cannot dry-run this scenario: ${problem}`); return { exitCode: 2, summary: null, summaryPath: null }; }
  }
  const capUsd = typeof opts.maxUsd === 'number' && opts.maxUsd > 0 ? Math.min(opts.maxUsd, scenario.budgetUsd) : scenario.budgetUsd;
  const outDir = path.resolve(opts.outDir);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    // A previous bench killed outright may have left workers (and their agents) running.
    const leftovers = findLiveLeftovers(outDir, deps.isPidAlive);
    if (leftovers.length > 0) {
      progress(describeLeftovers(outDir, leftovers));
    } else {
      progress(`--out ${outDir} is not empty; refusing to mix two benchmark runs. Nothing was started.`);
    }
    return { exitCode: 2, summary: null, summaryPath: null };
  }
  fs.mkdirSync(outDir, { recursive: true });

  const log = new EventLog(path.join(outDir, 'events.jsonl'));
  const ledger = new BudgetLedger(capUsd, scenario.perCallCapUsd, scenario.reserveFactor);
  const startedAt = new Date(deps.now()).toISOString();
  const observations: VersionObservation[] = scenario.versions.map((v) => emptyObservation(v.id, v.intendedBump));
  const notes: string[] = [];
  let harnessError: string | null = null;
  let aborted = false;
  /** The signal that aborted the bench (SIGINT, SIGTERM, …). */
  let abortSignal: string | null = null;
  /** Aborted on Ctrl+C, so a dependency install does not start after it. */
  const sigintAbort = new AbortController();
  let stoppedForBudget = false;
  let server: LaunchedServer | null = null;
  let disposeSse: (() => void) | null = null;
  let fake: FakeEngine | null = null;
  let workspace: PreparedWorkspace | null = null;
  let engineCheck: EngineCheck | null = null;
  let current: VersionObservation | null = null;
  let projectId: string | null = null;
  let activeRunId: string | null = null;
  let generatingPlanId: string | null = null;
  let client: BenchClient | null = null;
  // Jobs the bench started (plan request, run start, gate approve) vs `job-end` events seen:
  // a job's last `cost` events stream before its `job-end`, so waiting for it settles the budget.
  let jobsStarted = 0;
  let jobEnds = 0;
  // What the scenario's environment probes found in the untouched workspace.
  const environment: BenchEnvironment = { node: null, probes: [] };
  // The last gate command MOAG's verify announced (`verify-progress`, phase `gate`).
  let lastVerifyGateCommand: string | null = null;
  const at = (): string => new Date(deps.now()).toISOString();

  log.write({ kind: 'bench-start', scenario: scenario.name, file: scenario.file, mode, capUsd, perCallCapUsd: scenario.perCallCapUsd });

  /** Ask the server to stop whatever is running for this project (run stop or plan cancel). */
  const stopActive = async (why: string): Promise<void> => {
    if (!client || !projectId) { return; }
    try {
      if (activeRunId) {
        const r = await client.call('reviewer', 'POST', `/api/projects/${projectId}/runs/${activeRunId}/stop`, {});
        log.write({ kind: 'stop-request', why, runId: activeRunId, status: r.status });
      } else if (generatingPlanId) {
        const r = await client.call('po', 'POST', `/api/projects/${projectId}/plans/${generatingPlanId}/cancel`, {});
        log.write({ kind: 'stop-request', why, planId: generatingPlanId, status: r.status });
      }
    } catch (err) { log.write({ kind: 'stop-request-failed', why, error: (err as Error).message }); }
  };

  /**
   * A termination signal. The first one stops gracefully: the active run through the
   * API, then the server. SIGHUP and SIGBREAK (Windows ends the process about 10 s
   * later) also kill every worker at once; so does any second signal. Neither ends
   * the bench itself: a wedged flow needs one more signal or a kill.
   */
  const onSignal = (name: string): void => {
    if (aborted) {
      progress(`second ${name}: killing every worker now`);
      server?.killNow?.();
      return;
    }
    aborted = true;
    abortSignal = name;
    sigintAbort.abort();
    progress(`${name === 'SIGINT' ? 'Ctrl+C' : name}: stopping the active run through the API, then shutting the server down…`);
    if (name === 'SIGHUP' || name === 'SIGBREAK') { server?.killNow?.(); }
    void stopActive(name.toLowerCase());
  };
  /** Process exit: best effort, synchronous. A no-op once stop() has ended every job. */
  const onExit = (): void => { server?.killNow?.(); };
  const disposeTermination = deps.onTermination({ signal: onSignal, exit: onExit });
  const abortedMessage = (): string => `aborted (${abortSignal ?? 'SIGINT'})`;

  const check = (): void => {
    if (aborted) { throw new BenchAbort(abortedMessage()); }
  };

  /** Handle one SSE event: log it, account cost, feed the current version's observations. */
  const onSse = (e: BenchSseEvent): void => {
    log.write({ kind: 'sse', event: e.event, data: redactForLog(e.data) });
    if (e.event === 'job-end') { jobEnds++; return; }
    if (e.event !== 'job-event') { return; }
    const ev = ((e.data as { event?: JobEvent } | null)?.event ?? {}) as JobEvent;
    switch (ev.event) {
      case 'cost': {
        const source = ev.source === 'reported' || ev.source === 'estimated' || ev.source === 'none' ? ev.source as CostEventSource : undefined;
        const usd = typeof ev.usd === 'number' ? ev.usd : NaN;
        ledger.onCost({ usd, ...(source ? { source } : {}) });
        current?.costEvents.push({ usd, ...(source ? { source } : {}) });
        if (!stoppedForBudget && ledger.mustStopNow()) {
          stoppedForBudget = true;
          current?.unplanned.push({ kind: 'budget-halt', at: at(), detail: `upper bound ${ledger.upperBoundUsd().toFixed(2)} + per-call ${scenario.perCallCapUsd.toFixed(2)} > cap ${capUsd.toFixed(2)}` });
          progress(`budget watchdog: upper bound $${ledger.upperBoundUsd().toFixed(2)} leaves less than one call; stopping.`);
          void stopActive('budget');
        }
        break;
      }
      case 'task-started':
        if (typeof ev.id === 'string') { current?.taskStarts.push(ev.id); }
        break;
      case 'task-escalate':
        current?.unplanned.push({ kind: 'task-escalate', at: at(), detail: `${String(ev.name ?? ev.id)}` });
        break;
      case 'verify': {
        if (ev.name === 'verify-started') { lastVerifyGateCommand = null; }
        if (ev.name === 'verify-progress' && ev.data) {
          // Verify stops at the first failing gate command, so the last one it
          // announced is the one that failed. A browser UAT gate is not a repo command,
          // and neither is the standards gate: its static rules announce phase 'standards'
          // and its profile commands 'standards-command', so they never land here.
          if (ev.data.phase === 'gate' && typeof ev.data.detail === 'string') { lastVerifyGateCommand = ev.data.detail; }
          if (ev.data.phase === 'uat') { lastVerifyGateCommand = null; }
        }
        if (ev.name === 'verify-finished' && ev.data) {
          const d = ev.data;
          const failedGate = typeof d.failedGate === 'string' ? d.failedGate : null;
          current?.verifyFinished.push({
            passed: d.passed === true,
            failedGate,
            iterations: typeof d.iterations === 'number' ? d.iterations : 0,
            // Only a failed REPO command names a command. A 'standards' failure is findings
            // (or a profile command, reported in the standards report), so it stays null and
            // is never mistaken for an environment problem with a gate command.
            failedCommand: failedGate === 'command' ? lastVerifyGateCommand : null,
          });
          lastVerifyGateCommand = null;
        }
        break;
      }
      default:
        break;
    }
  };

  /** GET the project detail as `actor` (quiet poll). */
  const projectDetail = async (actor = 'reviewer'): Promise<Record<string, unknown>> => {
    const r = await client!.call(actor, 'GET', `/api/projects/${projectId}`, undefined, { quiet: true });
    if (r.status !== 200) { throw new BenchAbort(`GET project: ${r.status}`); }
    return r.body;
  };

  /** Wait (bounded) until every job the bench started has streamed its `job-end`. */
  const settleSse = async (): Promise<void> => {
    const until = deps.now() + 10_000;
    while (jobEnds < jobsStarted && deps.now() < until) { await deps.sleep(Math.min(deps.pollMs, 50)); }
    if (jobEnds < jobsStarted) { log.write({ kind: 'sse-settle-timeout', jobsStarted, jobEnds }); }
  };

  const expect = (r: BenchResponse, status: number, what: string): BenchResponse => {
    if (r.status !== status) { throw new BenchAbort(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`); }
    return r;
  };

  try {
    // ── Server ──
    if (opts.dryRun) {
      fake = deps.installFakeEngine(path.join(outDir, 'fake-bin'));
      log.write({ kind: 'fake-engine', binDir: fake.binDir });
    }
    progress(`starting the server (${mode}, cap $${capUsd.toFixed(2)})…`);
    server = await deps.launchServer({ outDir, fakeBinDir: fake?.binDir ?? null, passEnv: scenario.passEnv, maxUsdPerCall: scenario.perCallCapUsd, gateTimeoutMs: scenario.gateTimeoutMs });
    log.write({ kind: 'server', url: server.url, projectsRoot: server.projectsRoot });
    client = new BenchClient(server.url, (entry) => log.write(entry));
    check();

    // ── Workspace ──
    progress(`preparing the workspace (${scenario.repo.kind})…`);
    workspace = await deps.prepareWorkspace(scenario, server.projectsRoot, 'bench-ws', server.serverEnv);
    log.write({ kind: 'workspace', dir: workspace.dir, head: workspace.head, setup: workspace.setup.map((s) => ({ command: s.command, exitCode: s.exitCode, ms: s.durationMs })) });
    check();

    // ── Environment probes: the untouched workspace, before any plan ──
    // A probe that fails here fails whatever MOAG does next, so a later failure
    // of the same command is the machine's, not the product's. A dry-run carries
    // on (it spends nothing). A paid run stops here, before any engine call,
    // unless the caller opted in with `allowFailedProbes`.
    if (scenario.environmentProbes.length > 0) {
      progress('probing the environment in the untouched workspace…');
      const [nodeProbe, ...probed] = await deps.runGates(['node --version', ...scenario.environmentProbes], workspace.dir, server.serverEnv, scenario.gateTimeoutMs);
      const nodeLine = nodeProbe?.exitCode === 0 ? nodeProbe.tail.trim().split(/\r?\n/)[0]?.trim() ?? '' : '';
      environment.node = /^v\d+\.\d+\.\d+/.test(nodeLine) ? nodeLine : null;
      environment.probes = probed.map((r) => {
        const pass = r.exitCode === 0 && !r.timedOut;
        return { command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, pass, detail: pass ? null : errorLine(r.tail) };
      });
      log.write({ kind: 'environment-probes', node: environment.node, probes: probed.map((r) => ({ command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.durationMs, tail: r.tail.slice(-4000) })) });
      for (const p of environment.probes.filter((x) => !x.pass)) {
        progress(`environment: "${p.command}" fails in the untouched workspace (${p.timedOut ? 'timed out' : `exit ${p.exitCode}`})${environment.node ? ` on Node ${environment.node}` : ''}`);
      }
      check();
      const failedProbes = environment.probes.filter((x) => !x.pass);
      if (failedProbes.length > 0 && !opts.dryRun) {
        const named = failedProbes.map((p) => `"${p.command}" (${p.timedOut ? 'timed out' : `exit ${p.exitCode}`})`).join(', ');
        if (!opts.allowFailedProbes) {
          log.write({ kind: 'environment-probes-stop', failed: failedProbes.map((p) => ({ command: p.command, exitCode: p.exitCode, timedOut: p.timedOut })) });
          throw new BenchAbort(`paid run refused: environment probe ${named} fails in the untouched workspace${environment.node ? ` on Node ${environment.node}` : ''}. `
            + 'No plan was requested and no engine call was made. Fix the environment, or pass --allow-failed-probes to run anyway.');
        }
        notes.push(`--allow-failed-probes: the paid run went ahead although environment probe ${named} fails in the untouched workspace`);
      }
    }

    // ── People (setup, not interventions) ──
    const adminPw = randomPassword();
    expect(await client.bootstrap(server.bootstrapToken, 'bench-admin', adminPw), 201, 'bootstrap');
    expect(await client.login('admin', 'bench-admin', adminPw), 200, 'admin login');

    // ── Engine check: before any plan request ──
    engineCheck = await deps.checkEngine(client, scenario, server);
    log.write({ kind: 'engine-check', ...engineCheck });
    if (engineCheck.available !== true) {
      throw new BenchAbort(`engine ${scenario.engine} is not available on the bench server (${engineCheck.error ?? 'probe says unavailable'})`);
    }
    const sawMarker = [engineCheck.probeVersion, engineCheck.shellVersion].some((v) => typeof v === 'string' && v.includes(FAKE_VERSION_MARKER));
    if (opts.dryRun) {
      const shellFake = typeof engineCheck.shellVersion === 'string' && engineCheck.shellVersion.includes(FAKE_VERSION_MARKER);
      const probeReal = typeof engineCheck.probeVersion === 'string' && !engineCheck.probeVersion.includes(FAKE_VERSION_MARKER);
      if (!shellFake || probeReal) {
        throw new BenchAbort(`dry-run refused: the server would not run the fake engine (shell: ${engineCheck.shellVersion ?? 'none'}, probe: ${engineCheck.probeVersion ?? 'none'})`);
      }
    } else if (sawMarker) {
      throw new BenchAbort('paid run refused: the engine on PATH is the bench fake');
    }

    const roles: Array<[string, string, string]> = [['po', 'bench-po', 'product-owner'], ['reviewer', 'bench-reviewer', 'reviewer'], ['approver', 'bench-approver', 'approver']];
    for (const [actor, username, role] of roles) {
      const temp = randomPassword();
      expect(await client.call('admin', 'POST', '/api/admin/users', { username, roles: [role], password: temp }), 201, `create ${username}`);
      expect(await client.login(actor, username, temp), 200, `${username} login`);
      expect(await client.changePassword(actor, temp, randomPassword()), 200, `${username} password change`);
      log.write({ kind: 'setup', actor, username, role });
    }

    // ── Project ──
    const created = expect(await client.call('po', 'POST', '/api/projects', {
      name: scenario.name.slice(0, 80), source: { kind: 'path', path: workspace.name }, stack: scenario.stack, defaultEngine: scenario.engine,
    }), 201, 'create project');
    projectId = (created.body.project as { id: string }).id;
    disposeSse = client.events('admin', projectId, onSse);

    // ── Standards: proposed by the product owner, approved by the reviewer, before any plan ──
    // The server proposes v1 itself when the project is created; the bench replaces it with
    // the scenario's profile so the REVIEWED path (propose → approve) is what gets measured.
    // It never uses accept-defaults. A refusal at any step stops the bench (exit 2) before
    // a plan is requested. This is project setup, like creating the people: it is logged,
    // not counted as an intervention.
    {
      const profile = benchStandardsProfile(scenario);
      const source = scenario.standardsProfile ? `scenario profile ${path.basename(scenario.standardsProfile.file)}` : `${scenario.stack} built-in profile`;
      const seenStd = expect(await client.call('po', 'GET', `/api/projects/${projectId}/standards`), 200, 'GET standards');
      const before = ((seenStd.body.standards as { versions?: Array<{ version: number }> } | undefined)?.versions ?? []);
      const baseVersion = before.length > 0 ? before[before.length - 1].version : null;
      const proposed = await client.call('po', 'POST', `/api/projects/${projectId}/standards/versions`, { profile, baseVersion });
      if (proposed.status !== 201) {
        throw new BenchAbort(`standards proposal refused (${source}): HTTP ${proposed.status} ${String(proposed.body.error ?? '')} ${JSON.stringify(proposed.body.errors ?? proposed.body.message ?? '').slice(0, 500)}. No plan was requested.`);
      }
      const number = proposed.body.version as number;
      const record = ((proposed.body.standards as { versions?: ProposedStandardsForApproval[] } | undefined)?.versions ?? []).find((x) => x.version === number);
      const problems = standardsApprovalProblems(record, scenarioAllowedCommands(scenario), profileHash(profile));
      if (problems.length > 0) {
        log.write({ kind: 'standards-refused', version: number, problems });
        throw new BenchAbort(`the bench will not approve standards v${number} unreviewed: ${problems.join(' ')} No plan was requested.`);
      }
      // A first version that brings a command changes enforcement, and the server approves
      // that only with an acknowledgement. The bench gives it for exactly the content it just
      // checked above: its own profile (the hash) with allow-listed commands only.
      const approved = await client.call('reviewer', 'POST', `/api/projects/${projectId}/standards/versions/${number}/approve`, {
        contentHash: record!.contentHash, acknowledgedEnforcementHash: record!.contentHash,
      });
      if (approved.status !== 200) {
        throw new BenchAbort(`standards approval refused: HTTP ${approved.status} ${String(approved.body.error ?? '')} ${String(approved.body.message ?? '').slice(0, 300)}. No plan was requested.`);
      }
      log.write({ kind: 'standards-approved', version: number, contentHash: record!.contentHash, source, commands: profile.commands.map((c) => c.run) });
      notes.push(`standards v${number} (${source}, ${profile.commands.length} command${profile.commands.length === 1 ? '' : 's'}) proposed by bench-po and approved by bench-reviewer before the first plan`);
      progress(`standards v${number} approved (${source})`);
      check();
    }

    // ── Versions ──
    for (let i = 0; i < scenario.versions.length; i++) {
      check();
      const v = scenario.versions[i];
      const obs = observations[i];
      current = obs;
      if (stoppedForBudget) { obs.notRunBudget = true; continue; }
      const cap = ledger.versionCap(scenario.minVersionUsd);
      if (cap === null) {
        for (let j = i; j < observations.length; j++) { observations[j].notRunBudget = true; }
        progress(`${v.id}: not run (budget) — upper bound $${ledger.upperBoundUsd().toFixed(2)} of $${capUsd.toFixed(2)}`);
        break;
      }
      progress(`${v.id}: version cap $${cap.toFixed(2)}`);
      try {
        await runVersion(i, cap);
      } catch (err) {
        if (err instanceof BenchAbort && aborted) { throw err; }
        obs.error = (err as Error).message;
        obs.endState = obs.endState ?? 'error';
        log.write({ kind: 'version-error', version: v.id, error: obs.error });
        progress(`${v.id}: error — ${obs.error}`);
      }
      if (stoppedForBudget) {
        for (let j = i + 1; j < observations.length; j++) { observations[j].notRunBudget = true; }
        break;
      }
    }
    current = null;

    if (fake) {
      const calls = readFakeCalls(fake);
      if (calls.length === 0) {
        harnessError = 'dry-run check failed: the fake engine was never called (fake-bin/calls.jsonl is empty or missing)';
      } else {
        notes.push(`fake engine calls: ${calls.length} (${['plan', 'task', 'verify'].map((m) => `${m} ${calls.filter((c) => c.mode === m).length}`).join(', ')})`);
      }
    }
  } catch (err) {
    harnessError = aborted ? abortedMessage() : (err as Error).message;
    log.write({ kind: 'harness-error', error: harnessError });
    progress(`harness error: ${harnessError}`);
  } finally {
    try { disposeTermination(); } catch { /* best effort */ }
    try { disposeSse?.(); } catch { /* best effort */ }
    if (server) {
      progress('stopping the server…');
      await server.stop();
    }
  }

  // ── Summary ──
  if (harnessError !== null) {
    // A version the harness never reached is not a product outcome: say so.
    for (const o of observations) {
      if (o.savedAtMs === null && !o.notRunBudget && !o.error && !o.noDelta && !o.planFailed) {
        o.error = `not run: ${harnessError.split('\n')[0].slice(0, 300)}`;
        o.endState = 'harness-error';
      }
    }
  }
  const versions = observations.map((o) => buildVersionMetrics(o, scenario.perCallCapUsd));
  const exitCode = harnessError !== null ? 2 : stoppedForBudget ? 4 : 0;
  const summary = summarize(versions, ledger.snapshot(), {
    scenario: scenario.name,
    scenarioFile: scenario.file,
    mode,
    startedAt,
    endedAt: new Date(deps.now()).toISOString(),
    aborted,
    stoppedForBudget,
    harnessError,
    exitCode,
    workspace: workspace ? { dir: workspace.dir, head: workspace.head } : null,
    engine: { id: scenario.engine, version: engineCheck?.shellVersion ?? null, probeVersion: engineCheck?.probeVersion ?? null },
    environment,
    eventsTruncated: log.truncated,
    notes,
  });
  const summaryPath = path.join(outDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  log.write({ kind: 'bench-end', exitCode, summaryPath });
  progress(`done: exit ${exitCode}; summary at ${summaryPath}`);
  return { exitCode, summary, summaryPath };

  // ─── One PRD version ───

  async function runVersion(i: number, cap: number): Promise<void> {
    const v = scenario.versions[i];
    const obs = observations[i];
    const c = client!;
    const pid = projectId!;
    const deadline = deps.now() + scenario.versionTimeoutMin * 60_000;
    const unplanned = (kind: string, detail?: string): void => { obs.unplanned.push({ kind, at: at(), ...(detail ? { detail } : {}) }); };
    const required = (kind: string, detail?: string): void => { obs.required.push({ kind, at: at(), ...(detail ? { detail } : {}) }); };

    expect(await c.call('po', 'PATCH', `/api/projects/${pid}`, { versionBudgetUsd: cap }), 200, 'set version budget');
    if (fake) { fake.setVersion(v.dryRunFixture ?? null, scenario.dryRun?.planCommand ?? null); }

    // Save the PRD.
    const prd = expect(await c.call('po', 'GET', `/api/projects/${pid}/prd`), 200, 'GET prd');
    const baseCreatedAt = (prd.body.latest as { createdAt?: string } | null)?.createdAt ?? null;
    obs.savedAtMs = deps.now();
    const saved = expect(await c.call('po', 'POST', `/api/projects/${pid}/prd/versions`, { text: fs.readFileSync(v.prdFile, 'utf-8'), baseCreatedAt }), 201, 'save PRD');
    const version = saved.body.version as { createdAt: string; recommendedBump: string | null };
    obs.recommendedBump = version.recommendedBump ?? null;
    const diff = saved.body.diff as { added?: Array<{ id: string }>; changed?: Array<{ id: string }> } | null;
    if (i === 0 || !diff) {
      const tr = expect(await c.call('po', 'GET', `/api/projects/${pid}/trace`), 200, 'GET trace');
      obs.requirementsAdded = ((tr.body.requirements as Array<{ id: string }> | undefined) ?? []).map((r) => r.id);
    } else {
      obs.requirementsAdded = (diff.added ?? []).map((r) => r.id);
      obs.requirementsChanged = (diff.changed ?? []).map((r) => r.id);
    }
    progress(`${v.id}: saved (recommended ${obs.recommendedBump ?? 'none'}, intended ${v.intendedBump}; added ${obs.requirementsAdded.join(',') || '-'}, changed ${obs.requirementsChanged.join(',') || '-'})`);

    // Bump: a mismatch is a decision a human would have to make.
    if (i > 0 && obs.recommendedBump !== v.intendedBump) {
      unplanned('bump-override', `recommended ${obs.recommendedBump ?? 'none'}, intended ${v.intendedBump}`);
      const b = await c.call('po', 'POST', `/api/projects/${pid}/prd/versions/latest/bump`, { bump: v.intendedBump, expectedCreatedAt: version.createdAt });
      if (b.status === 200) { obs.bumpOverridden = true; } else { obs.notes.push(`bump override refused: ${b.status} ${String(b.body.error ?? '')}`); }
    }

    // Anything to plan?
    if (i > 0) {
      const p2 = expect(await c.call('po', 'GET', `/api/projects/${pid}/prd`), 200, 'GET prd');
      if (p2.body.deltaScope === null || p2.body.deltaScope === undefined) {
        obs.noDelta = true;
        obs.endState = 'no-delta';
        return;
      }
    }

    // Plan.
    const gen = await c.call('po', 'POST', `/api/projects/${pid}/plans`, { mode: i === 0 ? 'initial' : 'delta' });
    if (gen.status !== 202) {
      const code = String(gen.body.error ?? gen.status);
      unplanned(`plan-${code}`, String(gen.body.message ?? ''));
      obs.planFailed = true;
      obs.endState = `plan-request-${code}`;
      return;
    }
    const planId = (gen.body.plan as { id: string }).id;
    jobsStarted++;
    generatingPlanId = planId;
    let plan: Record<string, unknown> | undefined;
    try {
      for (;;) {
        check();
        const d = await projectDetail('po');
        plan = (d.plans as Array<Record<string, unknown>>).find((x) => x.id === planId);
        if (plan && plan.status !== 'generating') { break; }
        if (deps.now() > deadline) {
          unplanned('timeout', 'plan generation');
          await c.call('po', 'POST', `/api/projects/${pid}/plans/${planId}/cancel`, {});
          obs.planFailed = true;
          obs.endState = 'timeout';
          return;
        }
        if (stoppedForBudget) { obs.planFailed = true; obs.endState = 'budget-halt'; return; }
        await deps.sleep(deps.pollMs);
      }
    } finally {
      generatingPlanId = null;
    }
    await settleSse();
    const pstatus = String(plan.status);
    if (pstatus !== 'pending') {
      unplanned(`plan-${pstatus}`, typeof plan.error === 'string' ? plan.error.slice(0, 500) : undefined);
      obs.planFailed = true;
      obs.endState = `plan-${pstatus}`;
      return;
    }
    const playlist = plan.playlist as GeneratedPlanForApproval['playlist'];
    obs.tasksGenerated = (playlist?.tasks ?? []).filter((t) => !(t.type === 'manual' && t.name === SHIP_GATE_NAME)).length;
    const allowedCommands = scenarioAllowedCommands(scenario);
    const problems = planApprovalProblems({ playlist, review: plan.review as GeneratedPlanForApproval['review'] }, allowedCommands);
    if (problems.length > 0) {
      // The bench never approves what no human has read: a refusal goes through
      // the reviewer route, so the server records it and nothing runs.
      const reason = `bench: the plan cannot be approved unreviewed: ${problems.join(' ')}`.slice(0, 1900);
      const rj = await c.call('reviewer', 'POST', `/api/projects/${pid}/plans/${planId}/reject`, { reason });
      if (rj.status !== 200) { obs.notes.push(`plan reject refused: ${rj.status} ${String(rj.body.error ?? '')}`); }
      unplanned('plan-rejected', reason);
      obs.planFailed = true;
      obs.endState = 'plan-rejected';
      return;
    }
    expect(await c.call('reviewer', 'POST', `/api/projects/${pid}/plans/${planId}/approve`, { contentHash: plan.contentHash }), 200, 'approve plan');
    required('plan-approval');

    // Run.
    const started = expect(await c.call('reviewer', 'POST', `/api/projects/${pid}/runs`, { planId }), 202, 'start run');
    const runId = (started.body.run as { id: string }).id;
    jobsStarted++;
    activeRunId = runId;
    progress(`${v.id}: run ${runId} started (${obs.tasksGenerated} tasks + ship gate)`);
    let segments = 1;
    let status = 'running';
    let completedAtMs: number | null = null;
    let haltSeen = '';
    try {
      for (;;) {
        check();
        const d = await projectDetail();
        const run = (d.runs as Array<Record<string, unknown>>).find((r) => r.id === runId);
        status = String(run?.status ?? 'missing');
        if (status === 'completed') { completedAtMs = deps.now(); }
        if (RUN_TERMINAL.has(status) || status === 'missing') { break; }
        if (status === 'awaiting-approval') {
          const gate = run?.gate as { taskId: string; name: string } | undefined;
          const haltKey = `${segments}:${gate?.taskId ?? '?'}`;
          if (haltSeen !== haltKey) {
            haltSeen = haltKey;
            if (gate?.name === SHIP_GATE_NAME) { required('ship-approval'); } else { unplanned('generated-manual-gate', gate?.name); }
            progress(`${v.id}: halted at "${gate?.name ?? '?'}"; running the bench acceptance gates…`);
            const installed = await deps.ensureDependencies(workspace!.dir, server!.serverEnv, scenario.gateTimeoutMs, sigintAbort.signal);
            check();
            log.write({ kind: 'bench-deps', version: v.id, ok: installed.ok, events: installed.events });
            const failedInstall = installed.ok ? null : installed.events.find((e) => e.event === 'dependencies-install-failed') ?? null;
            const results = [
              // A failed install is a failing gate: the acceptance gates cannot be green without it.
              ...(installed.ok ? [] : [{
                command: failedInstall?.command ?? 'dependency install',
                exitCode: failedInstall?.exitCode || 1,
                timedOut: failedInstall?.timedOut ?? false,
                durationMs: failedInstall?.durationMs ?? 0,
                tail: failedInstall?.tail ?? '',
              }]),
              ...await deps.runGates(scenario.gateCommands, workspace!.dir, server!.serverEnv, scenario.gateTimeoutMs),
            ];
            const green = gatesGreen(results);
            log.write({ kind: 'bench-gates', version: v.id, green, results: results.map((r) => ({ command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.durationMs, tail: r.tail.slice(-4000) })) });
            if (!obs.gateFirstRun) {
              obs.gateFirstRun = { pass: green, results: results.map((r) => ({ command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs })) } as GateRunObservation;
            }
            if (green) {
              const approved = await approveGate(runId, deadline);
              if (approved === 'standards-blocking') {
                // The server refuses to ship over a standards check that stops the release (a
                // failed command, or a blocking rule or command that was not checked). The
                // approver does what a person would: rejects the ship. Nothing is shipped.
                const note = 'the standards check before the ship gate stops this release, so the server refused the approval';
                log.write({ kind: 'ship-refused-standards', version: v.id, runId });
                expect(await c.call('approver', 'POST', `/api/projects/${pid}/runs/${runId}/gate/reject`, { note }), 200, 'reject gate');
                unplanned('ship-refused-standards', note);
                progress(`${v.id}: ${note}`);
                continue;
              }
              if (!approved) { break; }
              segments++;
              if (segments > MAX_SEGMENTS) {
                unplanned('timeout', `more than ${MAX_SEGMENTS} run segments`);
                await stopActive('segment limit');
                status = 'too-many-segments';
                break;
              }
            } else {
              const failing = results.filter((r) => r.exitCode !== 0 || r.timedOut).map((r) => `${r.command} → ${r.timedOut ? 'timed out' : `exit ${r.exitCode}`}`);
              const note = `bench acceptance gates failed: ${failing.join('; ')}`.slice(0, 1900);
              expect(await c.call('approver', 'POST', `/api/projects/${pid}/runs/${runId}/gate/reject`, { note }), 200, 'reject gate');
              unplanned('gate-rejected', note);
            }
            continue;
          }
        }
        if (deps.now() > deadline) {
          unplanned('timeout', 'run');
          await stopActive('version timeout');
          const stopBy = deps.now() + 60_000;
          while (deps.now() < stopBy) {
            const d2 = await projectDetail();
            const r2 = (d2.runs as Array<Record<string, unknown>>).find((r) => r.id === runId);
            if (RUN_TERMINAL.has(String(r2?.status))) { status = String(r2?.status); break; }
            await deps.sleep(deps.pollMs);
          }
          if (!RUN_TERMINAL.has(status)) { status = 'timeout'; }
          break;
        }
        await deps.sleep(deps.pollMs);
      }
    } finally {
      activeRunId = null;
    }
    await settleSse();
    if (status === 'budget') { stoppedForBudget = true; if (!obs.unplanned.some((u) => u.kind === 'budget-halt')) { unplanned('budget-halt', 'server per-version cap reached'); } }
    if (status === 'error') { unplanned('run-error'); }

    // Final state: run detail, trace, cost reconciliation.
    const d = await projectDetail();
    const runRec = (d.runs as Array<Record<string, unknown>>).find((r) => r.id === runId);
    const detail = d.currentRun as { runId?: string; tasks?: Array<{ id: string; name: string; type: string; status: string }> } | null;
    if (detail?.runId === runId) { obs.finalTasks = (detail.tasks ?? []).map((t) => ({ id: t.id, name: t.name, type: t.type, status: t.status })); }
    if (typeof (runRec?.errorTail) === 'string') { obs.notes.push(`run error tail: ${(runRec.errorTail as string).slice(-500)}`); }
    obs.serverSpentUsd = typeof (runRec?.cost as { spentUsd?: unknown } | undefined)?.spentUsd === 'number' ? (runRec!.cost as { spentUsd: number }).spentUsd : null;
    const tr = expect(await c.call('po', 'GET', `/api/projects/${pid}/trace`), 200, 'GET trace');
    const rows = (tr.body.rows as Array<{ id: string; status: string }> | undefined) ?? [];
    for (const id of [...obs.requirementsAdded, ...obs.requirementsChanged]) {
      obs.trace[id] = rows.find((r) => r.id === id)?.status ?? 'missing';
    }
    const ids = [...obs.requirementsAdded, ...obs.requirementsChanged];
    if (status === 'completed' && ids.length > 0 && ids.every((id) => obs.trace[id] === 'shipped')) {
      obs.shippedAtMs = completedAtMs;
    } else {
      obs.endState = `run-${status}`;
    }
    // A failure the untouched workspace already had is the machine's, not the product's.
    const lastVerify = obs.verifyFinished[obs.verifyFinished.length - 1];
    const failedTasks = obs.finalTasks.filter((t) => t.status === 'failed').flatMap((t) => {
      const command = (playlist?.tasks ?? []).find((p) => p.id === t.id)?.command;
      return typeof command === 'string' ? [{ name: t.name, command }] : [];
    });
    obs.environment = environmentFindings(environment, lastVerify && !lastVerify.passed ? lastVerify.failedCommand ?? null : null, failedTasks);
    for (const finding of obs.environment) { progress(`${v.id}: ${finding}`); }
    const sseUsd = obs.costEvents.reduce((n, e) => n + (Number.isFinite(e.usd) ? e.usd : 0), 0);
    if (obs.serverSpentUsd !== null && Math.abs(obs.serverSpentUsd - sseUsd) > 0.005) {
      obs.notes.push(`cost mismatch: SSE events sum to $${sseUsd.toFixed(4)}, the server recorded $${obs.serverSpentUsd.toFixed(4)} (plan generation and every segment are both in the server figure)`);
    }
    progress(`${v.id}: run ${status}; trace ${Object.entries(obs.trace).map(([k, s]) => `${k}=${s}`).join(' ')}`);
  }

  /**
   * Approver approves the halted gate; retries a 409 project-locked (never force-releases).
   * `'standards-blocking'` when the server refuses because the pre-gate standards check stops the ship.
   */
  async function approveGate(runId: string, deadline: number): Promise<boolean | 'standards-blocking'> {
    const c = client!;
    const obs = current!;
    const lockDeadline = Math.min(deadline, deps.now() + deps.lockRetryMaxMs);
    let retries = 0;
    for (;;) {
      check();
      const r = await c.call('approver', 'POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { note: 'bench: acceptance gates green' });
      if (r.status === 202 || r.status === 200) { jobsStarted++; return true; }
      if (r.status === 409 && r.body.error === 'project-locked' && deps.now() < lockDeadline) {
        retries++;
        if (retries === 2) { obs.unplanned.push({ kind: 'lock-wait', at: at(), detail: 'gate approve got 409 project-locked; waiting for the previous task processes to exit' }); }
        await deps.sleep(deps.lockRetryMs);
        continue;
      }
      if (r.status === 409 && r.body.error === 'standards-blocking') {
        obs.notes.push(`ship approval refused by the server: ${String(r.body.message ?? 'standards-blocking').slice(0, 300)}`);
        return 'standards-blocking';
      }
      obs.notes.push(`gate approve failed: ${r.status} ${String(r.body.error ?? '')}`);
      if (r.status === 409 && r.body.error === 'project-locked') { obs.unplanned.push({ kind: 'lock-wait', at: at(), detail: 'gave up: the lock was still held' }); }
      return false;
    }
  }
}

// ─── CLI entry ───

/** Arguments `moag bench` reads (a subset of the headless CLI's Args). */
export interface BenchCliArgs {
  planPath?: string;
  positionals: string[];
  dryRun?: boolean;
  out?: string;
  maxUsd?: number;
  allowFailedProbes?: boolean;
}

/** `moag bench <scenario.json> [--dry-run] [--out <dir>] [--max-usd <n>] [--allow-failed-probes]`. Returns the exit code. */
export async function cmdBench(args: BenchCliArgs): Promise<number> {
  const file = args.planPath ?? args.positionals[0];
  if (!file) {
    process.stderr.write('Usage: moag bench <scenario.json> [--dry-run] [--out <dir>] [--max-usd <n>] [--allow-failed-probes]\n');
    return 2;
  }
  if (args.maxUsd !== undefined && !(Number.isFinite(args.maxUsd) && args.maxUsd > 0)) {
    process.stderr.write('--max-usd must be a positive number.\n');
    return 2;
  }
  let scenario: Scenario;
  try { scenario = parseScenario(file); } catch (err) {
    process.stderr.write(`Invalid scenario: ${err instanceof BenchScenarioError ? err.message : (err as Error).message}\n`);
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const outDir = args.out ?? path.join(os.tmpdir(), 'moag-bench', `${scenario.name.replace(/[^A-Za-z0-9._-]/g, '-')}-${stamp}`);
  const r = await runBench(scenario, {
    dryRun: args.dryRun === true, outDir,
    ...(args.maxUsd !== undefined ? { maxUsd: args.maxUsd } : {}),
    ...(args.allowFailedProbes === true ? { allowFailedProbes: true } : {}),
  });
  if (r.summary) {
    const s = r.summary;
    process.stdout.write(JSON.stringify({
      summary: r.summaryPath,
      mode: s.mode,
      exitCode: r.exitCode,
      harnessError: s.harnessError,
      versions: s.versions.map((v) => ({ id: v.id, outcome: v.outcome, endState: v.endState, costUsd: v.costUsd })),
      upperBoundUsd: s.budget.upperBoundUsd,
    }) + '\n');
  }
  return r.exitCode;
}

/** Interventions of a summary, flattened (docs and tests). */
export function allInterventions(s: BenchSummary): { required: Intervention[]; unplanned: Intervention[] } {
  return {
    required: s.versions.flatMap((v) => v.interventions.required),
    unplanned: s.versions.flatMap((v) => v.interventions.unplanned),
  };
}
