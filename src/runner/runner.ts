import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { EventEmitter } from 'events';
import { ChildProcess, execSync, spawn } from 'child_process';
import {
  Plan,
  Playlist,
  Task,
  TaskStatus,
  RunnerState,
  EngineId,
  EngineResult,
  HistoryEntry,
  FailurePolicy,
  TaskArtifact,
  TaskType,
  VerificationResult,
} from '../models/types';
import { generateId } from '../models/plan';
import { commitTask, describePrepareFailure, prepareBranch, DeliveryConfig } from './git-delivery';
import {
  createWorktrees,
  describeIsolationFailure,
  isolationRequired,
  removeWorktrees,
  Worktree,
} from './worktree';
import { resolveRoleCharter } from '../models/roles';
import { selectModel, ReasoningPreset } from '../models/model-selector';
import { resolveProfile, resolveValidationProfile, resolveTaskTimeoutMs, ProfileName, ProfileConfig } from '../models/execution-profiles';
import { getEngine } from '../adapters/index';
import { costLedger, CostEvent } from '../utils/cost-ledger';
import { getValidationAdapters, validationResultToEngineResult } from '../adapters/validation/index';
import { HistoryStore } from '../history/store';
import { buildContext, getContextSettings, runRetrievalCascade, adaptiveContextBudget } from '../context/context-builder';
import { extractSummary } from '../context/memory-extractor';
import { analyzeProject } from '../context/project-analyzer';
import { PromptLibraryStore } from '../templates/prompt-library';
import { AiRulesStore } from '../ai-rules/rules-store';
import { TaskQueue } from './task-queue';
import { ghSync } from '../utils/gh';
import { fileIncidentIssue } from '../github/issue-sync';

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 30_000;

/**
 * Parse a .env-style file into a key-value map.
 * Handles: comments (#), blank lines, quoted values (single or double), KEY=VALUE.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Classify a task failure into an actionable category.
 *
 * This drives three downstream behaviours:
 *  - auto-fix: skip the agent-repair loop for non-code failures (auth/rate-limit are not fixable by writing code)
 *  - retry: surface human-readable guidance instead of a generic "retry"
 *  - task card: show the right badge/message so the user knows what action to take
 */
export type FailureCategory =
  | 'auth'        // Not authenticated — user needs to login
  | 'rate-limit'  // API quota / 429 — wait and retry
  | 'cli-missing' // CLI not installed or not on PATH
  | 'timeout'     // Task timed out
  | 'compile'     // TypeScript / build compilation error — agent-fixable
  | 'test'        // Test suite failure — agent-fixable
  | 'code'        // Generic runtime/lint code error — agent-fixable
  | 'unknown';    // Unrecognised — attempt auto-fix anyway

export interface FailureClassification {
  category: FailureCategory;
  /** One-line human-readable reason (stripped of noise, shown in UI) */
  reason: string;
  /** Whether the auto-fix agent loop should run for this failure */
  agentCanFix: boolean;
  /** Specific error lines extracted for injection into the repair prompt */
  errorLines: string[];
}

const NOISE_LINES = [
  /^reading prompt from stdin/i,
  /^─+\s*(command|response)\s*─+/i,
  /^github copilot/i,
  /^claude code/i,
  /^── /,
  /^\s*$/,
];

export function classifyFailure(stderr: string, stdout: string): FailureClassification {
  const combined = [stderr, stdout].filter(Boolean).join('\n');
  const lines = combined.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const meaningful = lines.filter(l => !NOISE_LINES.some(p => p.test(l)));
  const text = combined.toLowerCase();

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (/not authenticated|unauthorized|please log ?in|sign in|invalid api key|api key.*invalid|authentication failed/i.test(combined)) {
    return {
      category: 'auth',
      reason: 'Not authenticated — run `claude login` or check your API key.',
      agentCanFix: false,
      errorLines: meaningful.slice(0, 3),
    };
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  if (/rate.?limit|quota.?exceeded|too many requests|429|overloaded/i.test(combined)) {
    return {
      category: 'rate-limit',
      reason: 'Rate limit or quota exceeded — wait a moment then retry.',
      agentCanFix: false,
      errorLines: meaningful.slice(0, 3),
    };
  }

  // ── CLI missing ───────────────────────────────────────────────────────────
  if (/command not found|ENOENT|is not recognized as|cannot find.*command|no such file/i.test(combined)) {
    return {
      category: 'cli-missing',
      reason: 'CLI not found — ensure the engine is installed and on PATH.',
      agentCanFix: false,
      errorLines: meaningful.slice(0, 3),
    };
  }

  // ── Timeout ───────────────────────────────────────────────────────────────
  if (/timed? ?out|SIGKILL|exceeded.*timeout/i.test(combined)) {
    return {
      category: 'timeout',
      reason: 'Task timed out — consider splitting it into smaller steps.',
      agentCanFix: false,
      errorLines: meaningful.slice(0, 3),
    };
  }

  // ── TypeScript / compile ──────────────────────────────────────────────────
  const tsErrors = meaningful.filter(l => /error TS\d+:|\.tsx?.*error|compilation error|type error/i.test(l));
  if (tsErrors.length > 0) {
    return {
      category: 'compile',
      reason: tsErrors[0].substring(0, 120),
      agentCanFix: true,
      errorLines: tsErrors.slice(0, 10),
    };
  }

  // ── Test failure ──────────────────────────────────────────────────────────
  const testErrors = meaningful.filter(l => /● |✕ |FAIL |× |AssertionError|Expected.*Received|test.*failed/i.test(l));
  if (testErrors.length > 0 || /\d+ (failing|failed)/i.test(text)) {
    const summary = meaningful.find(l => /\d+ (failing|failed)/i.test(l)) ?? testErrors[0] ?? 'Tests failed';
    return {
      category: 'test',
      reason: summary.substring(0, 120),
      agentCanFix: true,
      errorLines: testErrors.slice(0, 10),
    };
  }

  // ── Generic code error ────────────────────────────────────────────────────
  const errorLines = meaningful.filter(l => /error:|Error:|exception|SyntaxError|ReferenceError|TypeError|Cannot find/i.test(l));
  if (errorLines.length > 0) {
    return {
      category: 'code',
      reason: errorLines[0].substring(0, 120),
      agentCanFix: true,
      errorLines: errorLines.slice(0, 10),
    };
  }

  return {
    category: 'unknown',
    reason: meaningful[0]?.substring(0, 120) ?? 'Task failed with no output.',
    agentCanFix: true,
    errorLines: meaningful.slice(0, 10),
  };
}

interface InteractiveCommandWarning {
  issue: string;
  fix: string;
}

const INTERACTIVE_PATTERNS: Array<{ pattern: RegExp; issue: string; fix: string }> = [
  { pattern: /\bprisma\s+migrate\s+dev\b(?!.*--name)/,
    issue: 'prisma migrate dev prompts for a migration name on stdin',
    fix: 'Add --name flag: prisma migrate dev --name <your_migration_name>' },
  { pattern: /\bgit\s+rebase\s+-i\b/,
    issue: 'git rebase -i opens an interactive editor — no TTY available',
    fix: 'Use git rebase <base-branch> for non-interactive rebase' },
  { pattern: /\bnpm\s+init\b(?!.*-y)/,
    issue: 'npm init prompts for package details on stdin',
    fix: 'Add -y to skip prompts: npm init -y' },
  { pattern: /\byarn\s+init\b(?!.*-y)/,
    issue: 'yarn init prompts for package details on stdin',
    fix: 'Add -y to skip prompts: yarn init -y' },
  { pattern: /\bpnpm\s+create\b(?!.*--)/,
    issue: 'pnpm create may prompt for project options',
    fix: 'Pass all required options as flags' },
  { pattern: /(?:^|\s|&&|\|\|)read\s+/m,
    issue: 'bash "read" reads from stdin — no TTY available in MOAG',
    fix: 'Hardcode the value or pass it via environment variable' },
  { pattern: /\bssh-keygen\b(?!.*-f\s)/,
    issue: 'ssh-keygen prompts for filename and passphrase',
    fix: 'Add -f <path> -t rsa -N "" to run non-interactively' },
];

export function detectInteractiveCommand(command: string): InteractiveCommandWarning | null {
  for (const p of INTERACTIVE_PATTERNS) {
    if (p.pattern.test(command)) {
      return { issue: p.issue, fix: p.fix };
    }
  }
  return null;
}

function composeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) { controller.abort(); return controller.signal; }
    s.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
const DEFAULT_SERVICE_STARTUP_TIMEOUT_MS = 60_000;

export interface BudgetExceededEvent {
  totalCost: number;
  budget: number;
}

export interface RunnerEvents {
  'state-changed': (state: RunnerState) => void;
  'task-started': (task: Task, playlist: Playlist, fullPrompt: string) => void;
  'task-output': (task: Task, chunk: string, stream: 'stdout' | 'stderr') => void;
  'task-completed': (task: Task, result: EngineResult) => void;
  'task-failed': (task: Task, result: EngineResult) => void;
  /** Fired when auto-fix has exhausted its attempts — human intervention needed */
  'task-escalate': (task: Task, category: string, errorLines: string[]) => void;
  'engine-fallback': (details: { taskId: string; fromEngine: EngineId; toEngine: EngineId }) => void;
  'budget-exceeded': (details: BudgetExceededEvent) => void;
  'playlist-started': (playlist: Playlist) => void;
  'playlist-completed': (playlist: Playlist) => void;
  'all-completed': () => void;
  'error': (err: Error) => void;
  /** Fired when a type:"manual" task is waiting for human confirmation */
  'manual-gate': (task: Task) => void;
  /** Fired when a type:"monitor" task detects an incident (optionally with a filed issue URL) */
  'incident': (task: Task, summary: string, issueUrl: string | null) => void;
}

interface ServiceHandle {
  taskId: string;
  taskName: string;
  command: string;
  cwd: string;
  startedAt: string;
  port?: number;
  healthCheckUrl?: string;
  readyPattern?: string;
  proc: ChildProcess;
}

interface CommandRunOptions {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export class TaskRunner {
  private _state: RunnerState = RunnerState.Idle;
  private _emitter = new EventEmitter();
  private _abortController: AbortController | null = null;
  /** Watchdog that forces Idle if a stop() hangs in the Stopping state. */
  private _stoppingWatchdog: ReturnType<typeof setTimeout> | null = null;
  private static readonly STOP_WATCHDOG_MS = 30_000;
  private _currentPlaylistIndex = 0;
  private _currentTaskIndex = 0;
  private _plan: Plan | null = null;
  private _pauseResolve: (() => void) | null = null;
  private _playLock = false;
  private _taskGitRefs = new Map<string, { ref: string; cwd: string }>();
  /** Set once per run when auto-commit is armed; null when delivery is off. */
  private _deliveryBranch: string | null = null;
  /** Worktrees created for this run; emptied on teardown. */
  private _worktrees: Worktree[] = [];
  /** playlistId -> isolated checkout path. */
  private _playlistCwd = new Map<string, string>();
  /** taskId -> isolated checkout path, because resolveCwd has no playlist. */
  private _taskCwdRoot = new Map<string, string>();
  private _serviceProcesses = new Map<string, ServiceHandle>();
  private _currentRunId: string | null = null;
  private _sessionCostUsd = 0;
  private _sessionTokensIn = 0;
  private _sessionTokensOut = 0;
  /** Lifetime-spend level at which the next 'budget-exceeded' fires. Null until the first tracked cost. */
  private _budgetNextThresholdUsd: number | null = null;
  private _autoFixedTasks = new Set<string>();
  /** Live task queue for the currently-running sequential playlist. Null during parallel execution. */
  private _activeQueue: TaskQueue | null = null;
  /** Session key passed to session-aware adapters (e.g. AnthropicAdapter) for multi-turn context. */
  private _currentSessionId: string | null = null;

  private _promptLibrary: PromptLibraryStore | null = null;
  private _aiRulesStore: AiRulesStore | null = null;
  private _pendingScreenshots: string[] = [];
  private _sandboxUrl: string | null = null;
  /** Stores failure context (stderr + verify output) from the last failed attempt, keyed by task id */
  private _taskFailureContext = new Map<string, string>();
  /** Pending manual gate resolvers — keyed by task id, resolved when user marks step complete */
  private _manualGates = new Map<string, { complete: () => void; skip: () => void }>();
  /** Unsubscribes this runner from the shared cost ledger. Called by dispose(). */
  private _ledgerUnsub: (() => void) | null = null;

  constructor(private readonly historyStore: HistoryStore) {
    // Budget enforcement listens to the ledger, not to trackTaskCost(), so
    // authoring calls made outside play() (PRD chat, plan generation, …) count
    // toward the same ceiling as plan execution.
    this._ledgerUnsub = costLedger.onRecord((e) => this.onCostRecorded(e));
  }

  /**
   * Detach from the shared cost ledger. Must be called when the runner is torn
   * down (the extension pushes this into context.subscriptions) so a disposed
   * runner stops emitting 'budget-exceeded'.
   */
  dispose(): void {
    this._ledgerUnsub?.();
    this._ledgerUnsub = null;
  }

  setPromptLibrary(store: PromptLibraryStore): void {
    this._promptLibrary = store;
  }

  setAiRulesStore(store: AiRulesStore): void {
    this._aiRulesStore = store;
  }

  setSandboxUrl(url: string | null): void {
    this._sandboxUrl = url;
  }

  /**
   * Queue screenshot paths to be injected into the next task's context.
   * Paths are consumed (cleared) after the first task that uses them.
   */
  queueScreenshots(paths: string[]): void {
    this._pendingScreenshots = [...this._pendingScreenshots, ...paths];
  }

  get currentRunId(): string | null {
    return this._currentRunId;
  }

  getTaskGitRef(taskId: string): { ref: string; cwd: string } | undefined {
    return this._taskGitRefs.get(taskId);
  }

  getRunningServices(): Array<Omit<ServiceHandle, 'proc'>> {
    return [...this._serviceProcesses.values()].map(({ proc: _proc, ...service }) => service);
  }

  stopAllServices(): void {
    for (const service of this._serviceProcesses.values()) {
      this.killProcess(service.proc);
    }
    this._serviceProcesses.clear();
  }

  get state(): RunnerState {
    return this._state;
  }

  on<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): void {
    this._emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): void {
    this._emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): void {
    this._emitter.emit(event, ...args);
  }

  private setState(state: RunnerState): void {
    this._state = state;
    // Clear the stop watchdog once we actually settle back to Idle.
    if (state === RunnerState.Idle && this._stoppingWatchdog) {
      clearTimeout(this._stoppingWatchdog);
      this._stoppingWatchdog = null;
    }
    this.emit('state-changed', state);
  }

  getSessionCost(): number {
    return this._sessionCostUsd;
  }

  getSessionTokens(): { tokensIn: number; tokensOut: number } {
    return { tokensIn: this._sessionTokensIn, tokensOut: this._sessionTokensOut };
  }

  /**
   * Total estimated spend since the process started (or since resetLifetimeBudget()).
   * Read straight from the shared ledger, so it includes authoring calls made
   * outside play() as well as plan-executed tasks.
   */
  getLifetimeCostUsd(): number {
    return costLedger.getLifetimeUsd();
  }

  /**
   * Zero the lifetime spend accumulator and re-arm the budget ceiling.
   * For callers that genuinely want a fresh ceiling — the daemon deliberately does not call this.
   */
  resetLifetimeBudget(): void {
    costLedger.reset();
    this._budgetNextThresholdUsd = null;
  }

  private resetRunBudgetTracking(): void {
    this._sessionCostUsd = 0;
    this._sessionTokensIn = 0;
    this._sessionTokensOut = 0;
    this._autoFixedTasks.clear();
  }

  private isFailSafeMode(): boolean {
    return vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('failSafeMode', false);
  }

  /**
   * Per-run session counters for tasks this runner executed.
   * Lifetime spend and budget enforcement live on the ledger — see onCostRecorded().
   */
  private trackTaskCost(result: EngineResult): void {
    const estimatedCost = result.tokenUsage?.estimatedCost;
    if (estimatedCost === undefined || !Number.isFinite(estimatedCost)) {
      return;
    }

    this._sessionCostUsd += estimatedCost;
    this._sessionTokensIn += result.tokenUsage?.inputTokens ?? 0;
    this._sessionTokensOut += result.tokenUsage?.outputTokens ?? 0;
  }

  /**
   * Budget ceiling, driven by every accounted engine call in the process —
   * plan tasks and authoring calls alike.
   */
  private onCostRecorded(e: CostEvent): void {
    const budget = vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('costBudgetUsd', 0);
    if (budget <= 0) {
      return;
    }

    if (this._budgetNextThresholdUsd === null) {
      this._budgetNextThresholdUsd = budget;
    }
    if (e.lifetimeUsd <= this._budgetNextThresholdUsd) {
      return;
    }

    // Re-arm one budget-worth above current spend so the ceiling repeats instead of latching.
    this._budgetNextThresholdUsd = e.lifetimeUsd + budget;
    this.emit('budget-exceeded', { totalCost: e.lifetimeUsd, budget });
  }

  async play(plan: Plan, playlistIndex = 0, taskIndex = 0): Promise<void> {
    if (this._state === RunnerState.Playing) {
      return;
    }

    if (this._state === RunnerState.Paused) {
      this.setState(RunnerState.Playing);
      if (this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
      }
      return;
    }

    if (this._playLock) {
      return;
    }
    this._playLock = true;

    this._plan = plan;
    this._currentPlaylistIndex = playlistIndex;
    this._currentTaskIndex = taskIndex;
    this._abortController = new AbortController();
    this.resetRunBudgetTracking();
    this._currentRunId = generateId();
    await this.armGitDelivery(plan);
    this.setState(RunnerState.Playing);

    try {
      await this.runLoop();
    } catch (err) {
      if (this.state !== RunnerState.Stopping) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._playLock = false;
      this._abortController = null;
      this.setState(RunnerState.Idle);
    }
  }

  async playPlaylist(plan: Plan, playlistIndex: number): Promise<void> {
    await this.play(plan, playlistIndex, 0);
  }

  async playTask(plan: Plan, playlistIndex: number, taskIndex: number): Promise<void> {
    if (this._state !== RunnerState.Idle) {
      vscode.window.showWarningMessage('Runner is already active. Stop it first.');
      return;
    }
    if (this._playLock) {
      return;
    }
    this._playLock = true;

    this._plan = plan;
    this._abortController = new AbortController();
    this.resetRunBudgetTracking();
    this.setState(RunnerState.Playing);

    const playlist = plan.playlists[playlistIndex];
    const task = playlist.tasks[taskIndex];

    try {
      await this.executeTaskWithRetry(task, playlist, plan);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._playLock = false;
      this._abortController = null;
      this.setState(RunnerState.Idle);
    }
  }

  async playTasks(plan: Plan, taskList: Array<{ playlistIndex: number; taskIndex: number }>): Promise<void> {
    if (this._state !== RunnerState.Idle) {
      vscode.window.showWarningMessage('Runner is already active. Stop it first.');
      return;
    }
    if (this._playLock) {
      return;
    }
    this._playLock = true;

    this._plan = plan;
    this._abortController = new AbortController();
    this.resetRunBudgetTracking();
    this.setState(RunnerState.Playing);

    try {
      for (const { playlistIndex, taskIndex } of taskList) {
        if (this.state === RunnerState.Stopping) {
          break;
        }

        if (this.state === RunnerState.Paused) {
          await new Promise<void>((resolve) => {
            this._pauseResolve = resolve;
          });
          if (this.isStopping()) {
            break;
          }
        }

        const playlist = plan.playlists[playlistIndex];
        const task = playlist?.tasks[taskIndex];
        if (!playlist || !task) {
          continue;
        }

        await this.executeTaskWithRetry(task, playlist, plan);
      }
      this.emit('all-completed');
    } catch (err) {
      if (this.state !== RunnerState.Stopping) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._playLock = false;
      this._abortController = null;
      this.setState(RunnerState.Idle);
    }
  }

  pause(): void {
    if (this._state === RunnerState.Playing) {
      this.setState(RunnerState.Paused);
    }
  }

  stop(): void {
    if (this._state === RunnerState.Idle) {
      return;
    }
    this.setState(RunnerState.Stopping);
    this._abortController?.abort();

    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }

    // Watchdog: if a task/subprocess refuses to unwind, don't leave the runner
    // wedged in Stopping forever — force Idle so the user can resume/restart.
    if (this._stoppingWatchdog) { clearTimeout(this._stoppingWatchdog); }
    this._stoppingWatchdog = setTimeout(() => {
      this._stoppingWatchdog = null;
      if (this._state === RunnerState.Stopping) {
        this.emit('error', new Error(
          `Runner did not stop within ${TaskRunner.STOP_WATCHDOG_MS / 1000}s — forcing Idle.`,
        ));
        this.setState(RunnerState.Idle);
      }
    }, TaskRunner.STOP_WATCHDOG_MS);
    this._stoppingWatchdog.unref?.();
  }

  /** Called by UI when the user clicks "Mark Complete" on a manual gate task */
  resolveManualGate(taskId: string): void {
    const gate = this._manualGates.get(taskId);
    if (gate) {
      gate.complete();
      this._manualGates.delete(taskId);
    }
  }

  /** Called by UI when the user clicks "Skip" on a manual gate task */
  skipManualGate(taskId: string): void {
    const gate = this._manualGates.get(taskId);
    if (gate) {
      gate.skip();
      this._manualGates.delete(taskId);
    }
  }

  resetPlan(plan: Plan): void {
    for (const pl of plan.playlists) {
      for (const t of pl.tasks) {
        t.status = TaskStatus.Pending;
      }
    }
  }

  /**
   * Detect dependency cycles in the plan's tasks using DFS.
   * Tasks that form a cycle are marked Blocked so the runner skips them gracefully.
   * Returns the names of cyclic tasks (for warning display).
   */
  private detectAndMarkCycles(plan: Plan): string[] {
    const allTasks = plan.playlists.flatMap(pl => pl.tasks);
    const taskMap = new Map(allTasks.map(t => [t.id, t]));
    const cycleTaskIds = new Set<string>();

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(allTasks.map(t => [t.id, WHITE as number]));

    const visit = (id: string, path: string[]): void => {
      const c = color.get(id);
      if (c === BLACK) { return; }

      const cycleStart = path.indexOf(id);
      if (cycleStart !== -1) {
        // All tasks from cycleStart to end of path are in the cycle
        for (const cycleId of path.slice(cycleStart)) { cycleTaskIds.add(cycleId); }
        return;
      }

      const task = taskMap.get(id);
      if (!task) { return; }

      color.set(id, GRAY);
      path.push(id);
      for (const depId of task.dependsOn ?? []) { visit(depId, path); }
      path.pop();
      color.set(id, BLACK);
    };

    for (const task of allTasks) {
      if (color.get(task.id) === WHITE) { visit(task.id, []); }
    }

    const cycleNames: string[] = [];
    for (const id of cycleTaskIds) {
      const task = taskMap.get(id);
      if (task) {
        task.status = TaskStatus.Blocked;
        cycleNames.push(task.name);
      }
    }
    return cycleNames;
  }

  private async runLoop(): Promise<void> {
    const plan = this._plan!;

    // Fix 2: Detect dependency cycles before running — cyclic tasks are marked Blocked
    const cycleNames = this.detectAndMarkCycles(plan);
    if (cycleNames.length > 0) {
      this.emit('error', new Error(
        `Dependency cycle detected — the following tasks have been blocked: ${cycleNames.join(', ')}. ` +
        `Fix "dependsOn" references so no task depends on itself or on a chain that loops back to it.`
      ));
    }

    const failSafe = this.isFailSafeMode();
    const concurrentPlaylists = vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<number>('parallelPlaylists', 1);
    const requested = failSafe ? 1 : concurrentPlaylists;
    // Concurrency is only granted once each playlist has its own checkout.
    const effectiveConcurrentPlaylists = await this.armIsolation(plan, requested);

    try {
      if (effectiveConcurrentPlaylists > 1 && plan.playlists.length > 1) {
        await this.runPlaylistsConcurrently(plan, effectiveConcurrentPlaylists);
      } else {
        await this.runPlaylistsSequentially(plan);
      }
    } finally {
      await this.releaseIsolation();
    }

    this.emit('all-completed');
  }

  private async runPlaylistsSequentially(plan: Plan): Promise<void> {
    // Capture resume position before the loop — _currentPlaylistIndex is mutated inside
    const resumePlaylistIndex = this._currentPlaylistIndex;
    const resumeTaskIndex = this._currentTaskIndex;

    for (let pi = resumePlaylistIndex; pi < plan.playlists.length; pi++) {
      const playlist = plan.playlists[pi];
      this._currentPlaylistIndex = pi;
      const failSafe = this.isFailSafeMode();

      if (this.state === RunnerState.Stopping) {
        return;
      }

      this.emit('playlist-started', playlist);

      if (playlist.parallel && !failSafe) {
        await this.runPlaylistParallel(playlist, plan);
      } else {
        // Only resume mid-playlist for the first playlist we enter; all others start from 0
        const startTask = pi === resumePlaylistIndex ? resumeTaskIndex : 0;
        await this.runPlaylistSequential(playlist, plan, startTask);
      }

      this.emit('playlist-completed', playlist);
    }
  }

  private async runPlaylistsConcurrently(plan: Plan, maxConcurrent: number): Promise<void> {
    const playlists = plan.playlists.slice(this._currentPlaylistIndex);
    let running = 0;
    let nextIndex = 0;

    await new Promise<void>((resolve) => {
      const startNext = () => {
        while (running < maxConcurrent && nextIndex < playlists.length && this.state !== RunnerState.Stopping) {
          const playlist = playlists[nextIndex];
          nextIndex++;
          running++;

          this.emit('playlist-started', playlist);
          const runPlaylist = (playlist.parallel && !this.isFailSafeMode())
            ? this.runPlaylistParallel(playlist, plan)
            : this.runPlaylistSequential(playlist, plan, 0);

          runPlaylist.then(() => {
            this.emit('playlist-completed', playlist);
            running--;
            if (running === 0 && (nextIndex >= playlists.length || this.state === RunnerState.Stopping)) {
              resolve();
            } else {
              startNext();
            }
          }).catch((err) => {
            // Surface the failure instead of swallowing it — a silent catch here
            // left the runner stuck "Playing" with no active playlist.
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
            running--;
            if (running === 0 && (nextIndex >= playlists.length || this.state === RunnerState.Stopping)) {
              resolve();
            } else {
              startNext();
            }
          });
        }

        if (running === 0) {
          resolve();
        }
      };

      startNext();
    });
  }

  private async runPlaylistSequential(playlist: Playlist, plan: Plan, startTask: number): Promise<void> {
    // Build the live queue from remaining tasks — repair tasks will be injected mid-run
    const queue = new TaskQueue();
    queue.enqueueAll(playlist.tasks.slice(startTask), playlist);
    this._activeQueue = queue;
    this._currentSessionId = playlist.id;

    try {
      while (!queue.isEmpty) {
        if (this.state === RunnerState.Stopping) { break; }

        if (this.state === RunnerState.Paused) {
          if (this._pauseResolve) { this._pauseResolve(); }
          await new Promise<void>((resolve) => { this._pauseResolve = resolve; });
          if (this.isStopping()) { break; }
        }

        const entry = queue.dequeue();
        if (!entry) { break; }

        const { task, playlist: taskPlaylist, synthetic, repairCycle } = entry;

        // Completed/skipped/blocked tasks are replayed during resume — skip them (but always run synthetic repair tasks)
        if (!synthetic && (task.status === TaskStatus.Completed || task.status === TaskStatus.Skipped || task.status === TaskStatus.Blocked)) {
          continue;
        }

        if (!synthetic && task.dependsOn && task.dependsOn.length > 0) {
          const depStatus = this.checkDependencies(task, plan);
          if (depStatus === 'skip') {
            task.status = TaskStatus.Skipped;
            this.emit('task-output', task, `[Skipped] "${task.name}" - dependency not met\n`, 'stderr');
            this.emit('task-completed', task, { stdout: '', stderr: 'Skipped: dependency not met', exitCode: 0, durationMs: 0 });
            continue;
          }
        }

        if (!synthetic && this.shouldSkipIf(task, plan)) {
          task.status = TaskStatus.Skipped;
          this.emit('task-output', task, `[Skipped] "${task.name}" - skipIf condition met\n`, 'stderr');
          this.emit('task-completed', task, { stdout: '', stderr: 'Skipped: skipIf condition met', exitCode: 0, durationMs: 0 });
          continue;
        }

        await this.executeTaskWithRetry(task, taskPlaylist, plan, repairCycle);

        if (this.isStopping()) { break; }

        // Autoplay delay only between non-synthetic original tasks
        if (!synthetic && playlist.autoplay && !queue.isEmpty) {
          const delay = taskPlaylist.autoplayDelay ??
            vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('autoplayDelay', 2000);
          await this.sleep(delay);
        }
      }
    } finally {
      this._activeQueue = null;
      this._currentSessionId = null;
    }
  }

  private async runPlaylistParallel(playlist: Playlist, plan: Plan): Promise<void> {
    const taskPromises = new Map<string, Promise<void>>();

    for (const task of playlist.tasks) {
      const promise = (async () => {
        if (task.dependsOn && task.dependsOn.length > 0) {
          for (const depId of task.dependsOn) {
            const depPromise = taskPromises.get(depId);
            if (depPromise) {
              await depPromise;
            }
          }
          const depStatus = this.checkDependencies(task, plan);
          if (depStatus === 'skip') {
            task.status = TaskStatus.Blocked;
            this.emit('task-output', task, `[Blocked] "${task.name}" - dependency failed\n`, 'stderr');
            this.emit('task-failed', task, { stdout: '', stderr: 'Blocked: dependency failed', exitCode: 1, durationMs: 0 });
            return;
          }
        }
        if (this.shouldSkipIf(task, plan)) {
          task.status = TaskStatus.Skipped;
          this.emit('task-output', task, `[Skipped] "${task.name}" - skipIf condition met\n`, 'stderr');
          return;
        }
        await this.executeTaskWithRetry(task, playlist, plan);
      })();
      taskPromises.set(task.id, promise);
    }

    await Promise.allSettled([...taskPromises.values()]);
  }

  private checkDependencies(task: Task, plan: Plan): 'ok' | 'skip' {
    const allTasks = plan.playlists.flatMap(pl => pl.tasks);
    for (const depId of task.dependsOn ?? []) {
      const dep = allTasks.find(t => t.id === depId);
      if (!dep || dep.status === TaskStatus.Failed || dep.status === TaskStatus.Skipped || dep.status === TaskStatus.Blocked) {
        return 'skip';
      }
      if (dep.status !== TaskStatus.Completed) {
        return 'skip';
      }
    }
    return 'ok';
  }

  private shouldSkipIf(task: Task, plan: Plan): boolean {
    if (!task.skipIf) { return false; }
    const allTasks = plan.playlists.flatMap(pl => pl.tasks);
    const ref = allTasks.find(t => t.id === task.skipIf!.taskId);
    if (!ref) { return false; }
    return ref.status === task.skipIf.status;
  }

  private async executeTaskWithRetry(task: Task, playlist: Playlist, plan: Plan, repairCycle = 0): Promise<void> {
    const failSafe = this.isFailSafeMode();
    const fullAuto = !failSafe && vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('fullAuto', false);
    const effectiveMaxAttempts = fullAuto ? Math.max((task.retryCount ?? 0) + 1, 4) : (task.retryCount ?? 0) + 1;

    if (fullAuto) {
      this.emit('task-output', task, '[Full Auto] Write → Test → Fix loop active\n', 'stdout');
    }

    for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
      await this.executeTask(task, playlist, plan, repairCycle);
      if (task.status === TaskStatus.Completed || this.state === RunnerState.Stopping) {
        return;
      }
      if (attempt < effectiveMaxAttempts) {
        const failCtxRaw = this._taskFailureContext.get(task.id) ?? '';
        const categoryMatch = failCtxRaw.match(/^Failure category:\s*(\S+)/m);
        const failCategory = categoryMatch?.[1] as FailureCategory | undefined;

        if (failCategory === 'auth') {
          // Auth cannot be fixed by retrying — surface an actionable hint
          this.emit('task-output', task,
            `[Retry] Stopping — authentication failure cannot be resolved by retrying.\n` +
            `[ACTION:auth] Re-authenticate and retry: run the engine's login command (e.g. \`claude login\`, \`codex login\`), then right-click this task → Retry.\n`,
            'stderr');
          break;
        }

        if (failCategory === 'rate-limit') {
          // Countdown so the user sees progress during the mandatory wait
          const waitSecs = 30;
          this.emit('task-output', task,
            `[Retry] Rate limit hit — waiting ${waitSecs}s before retry ${attempt + 1}...\n`,
            'stderr');
          await this.sleepWithCountdown(task, waitSecs);
        } else {
          this.emit('task-output', task,
            `\n[Retry ${attempt}/${task.retryCount}] Retrying "${task.name}"...\n`,
            'stderr');
          await this.sleep(2_000);
        }
        task.status = TaskStatus.Pending;
      }
    }

    // Auto-fix: if task still failed and auto-fix is enabled (or fullAuto), attempt AI-driven repair
    const autoFixEnabled = !failSafe && vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('autoFix', true);
    if (task.status !== TaskStatus.Completed && this.getTaskType(task) === 'agent' && (autoFixEnabled || fullAuto)) {
      await this.autoFixTask(task, playlist, plan);
    }
  }

  private async autoFixTask(task: Task, playlist: Playlist, plan: Plan): Promise<void> {
    // One auto-fix attempt per task per run — prevents retry→autofix→retry→autofix loops
    if (this._autoFixedTasks.has(task.id)) { return; }

    const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
    const profileName = cfg.get<string>('executionProfile', 'auto');
    const profile = resolveProfile(profileName as ProfileName);
    const autoFix = profile.autoFix && cfg.get<boolean>('autoFix', true);
    if (!autoFix || this.state === RunnerState.Stopping) { return; }

    this._autoFixedTasks.add(task.id);

    // Gather error context from the most recent history entry
    if (!this.historyStore?.getForTask) { return; }
    const entries = this.historyStore.getForTask(task.id);
    const lastEntry = entries[0];
    if (!lastEntry) { return; }

    const classification = classifyFailure(lastEntry.result.stderr, lastEntry.result.stdout);
    const changedFiles = lastEntry.changedFiles?.join(', ') || 'none';

    this.emit('task-output', task, '\n\n━━━ MOAG Auto-Fix ━━━\n', 'stdout');

    // Non-fixable failures: skip the agent loop entirely, surface guidance instead
    if (!classification.agentCanFix) {
      this.emit('task-output', task,
        `[Auto-Fix] Skipped — this failure cannot be fixed by code changes.\n` +
        `Category: ${classification.category}\n` +
        `Reason: ${classification.reason}\n`,
        'stderr');
      return;
    }

    this.emit('task-output', task, `[Auto-Fix] Category: ${classification.category} — attempting targeted repair...\n`, 'stdout');

    const specificErrors = classification.errorLines.length > 0
      ? `SPECIFIC ERRORS TO FIX:\n${classification.errorLines.map(l => `  ${l}`).join('\n')}`
      : `ERROR SUMMARY: ${classification.reason}`;

    const repairPrompt = [
      `The previous attempt to complete this task FAILED with a ${classification.category} error.`,
      ``,
      `ORIGINAL TASK: ${task.name}`,
      `ORIGINAL PROMPT:`,
      task.prompt,
      ``,
      specificErrors,
      ``,
      `FILES CHANGED BY FAILED ATTEMPT: ${changedFiles}`,
      ``,
      `INSTRUCTIONS: Fix ONLY the errors listed above. Do NOT start over from scratch — ` +
      `build on what the previous attempt already did. ` +
      `Address each error line specifically and verify the fix compiles/passes before finishing.`,
    ].join('\n');

    // Save original prompt, swap in repair prompt, run, restore
    const originalPrompt = task.prompt;
    task.prompt = repairPrompt;
    task.status = TaskStatus.Pending;

    await this.executeTask(task, playlist, plan);

    // Restore original prompt regardless of outcome
    task.prompt = originalPrompt;

    // Mark the history entry as auto-fixed
    const fixEntries = this.historyStore.getForTask(task.id);
    const fixEntry = fixEntries[0];
    if (fixEntry) {
      fixEntry.autoFixed = true;
    }

    if ((task.status as string) === TaskStatus.Completed) {
      this.emit('task-output', task, '[Auto-Fix] Repair succeeded!\n', 'stdout');
    } else {
      this.emit('task-output', task, '[Auto-Fix] Repair also failed. Use Smart Fix in the sidebar for guided repair.\n', 'stderr');
      this.emit('task-escalate', task, classification.category, classification.errorLines);
    }
  }

  private async executeTask(task: Task, playlist: Playlist, plan: Plan, repairCycle = 0): Promise<void> {
    const taskType = this.getTaskType(task);

    // type:"check" with no command or verifyCommand — point toward type:"manual" instead
    if (taskType === 'check' && !task.command?.trim() && !task.verifyCommand?.trim()) {
      const noCommandResult: EngineResult = {
        stdout: '',
        stderr: 'check task missing command and verifyCommand',
        exitCode: 1,
        durationMs: 0,
      };
      task.status = TaskStatus.Failed;
      this.emit('task-output', task,
        `[Config Error] type:"check" is an automated check — it requires "command" or "verifyCommand".\n` +
        `  For a human gate with no automated command, use type:"manual" instead.\n` +
        `  type:"manual" shows a "Mark Complete" notification and waits for human confirmation.\n`,
        'stderr');
      this.emit('task-failed', task, noCommandResult);
      return;
    }

    // Fix 1: type:"command" with no command field but with a prompt → user almost certainly meant type:"agent"
    if (taskType === 'command' && !task.command?.trim() && task.prompt?.trim()) {
      const mismatchResult: EngineResult = {
        stdout: '',
        stderr: 'command field missing on command task',
        exitCode: 1,
        durationMs: 0,
      };
      task.status = TaskStatus.Failed;
      this.emit('task-output', task,
        `[Config Error] type:"command" tasks run the "command" field — the "prompt" is ignored.\n` +
        `  This task has a prompt but no "command". Did you mean type:"agent"?\n` +
        `  → Change type to "agent" so Claude reads and executes the prompt.\n`,
        'stderr');
      this.emit('task-failed', task, mismatchResult);
      return;
    }

    // Fix 1b: type:"command" with multi-line prompt → soft warning that prompt is ignored
    if (taskType === 'command' && task.command?.trim() && task.prompt && task.prompt.split('\n').filter(l => l.trim()).length > 2) {
      this.emit('task-output', task,
        `[Warning] type:"command" — only the "command" field runs. The multi-line prompt is ignored.\n` +
        `  If you want Claude to execute steps from the prompt, change type to "agent".\n`,
        'stderr');
    }

    // Fix 2: Detect interactive CLI commands that require a TTY (will hang in MOAG)
    for (const cmd of [task.command, task.verifyCommand].filter(Boolean) as string[]) {
      const interactive = detectInteractiveCommand(cmd);
      if (interactive) {
        this.emit('task-output', task,
          `[Warning] Potentially interactive command detected — MOAG has no TTY:\n` +
          `  Command : ${cmd}\n` +
          `  Problem : ${interactive.issue}\n` +
          `  Fix     : ${interactive.fix}\n`,
          'stderr');
      }
    }

    // Fix 4: Warn about missing context files before the agent starts
    if (task.files && task.files.length > 0 && (taskType === 'agent' || taskType === 'review')) {
      const cwdForFiles = this.resolveCwd(task.cwd, task);
      for (const filePath of task.files) {
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwdForFiles, filePath);
        if (!fs.existsSync(resolved)) {
          this.emit('task-output', task,
            `[Warning] Context file not found: ${filePath}\n` +
            `  Claude will have no context for this file — verify the path in the task's "files" field.\n`,
            'stderr');
        }
      }
    }

    // Fail-fast on empty prompt — sending blank text to an agent wastes tokens and
    // produces confusing output. Surface a clear error immediately instead.
    if ((taskType === 'agent' || taskType === 'review') && !task.prompt?.trim()) {
      const emptyResult: EngineResult = {
        stdout: '',
        stderr: 'Task prompt is empty — add a description to this task before running it.',
        exitCode: 1,
        durationMs: 0,
        summary: 'Task has no prompt.',
      };
      task.status = TaskStatus.Failed;
      this.emit('task-output', task, `[Error] "${task.name}" has an empty prompt.\n`, 'stderr');
      this.emit('task-failed', task, emptyResult);
      return;
    }

    const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');

    // Resolve execution profile
    const profileName = cfg.get<string>('executionProfile', 'auto');
    const profile = resolveProfile(profileName as ProfileName);

    // Engine: task-level override > playlist > plan > profile
    const engineId = task.engine ?? playlist.engine ?? plan.defaultEngine ?? profile.preferredEngine;

    // Store profile's model preset on the task for runAgentOnEngine to pick up
    (task as Task & { _profileModelPreset?: string })._profileModelPreset = profile.modelPreset;

    const cwd = this.resolveCwd(task.cwd, task);

    // Gap 3: Resolve inherited env files — merge before task.env (task.env wins)
    const workspaceRoot = this.resolveCwd(undefined);
    let resolvedEnv: Record<string, string> | undefined = task.env;
    if (task.inheritEnvFiles && task.inheritEnvFiles.length > 0) {
      const inherited: Record<string, string> = {};
      for (const relPath of task.inheritEnvFiles) {
        const absPath = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
        Object.assign(inherited, parseEnvFile(absPath));
      }
      // task.env takes precedence over inherited values
      resolvedEnv = { ...inherited, ...(task.env ?? {}) };
    }

    // Gap 6: Inject failure context into prompt when retrying a failed task
    const failureContext = this._taskFailureContext.get(task.id);
    const basePrompt = (taskType === 'agent' || taskType === 'review')
      ? await this.buildPrompt(task, cwd, plan, playlist)
      : this.buildTaskDescription(task);
    const executionDescription = failureContext
      ? `[RETRY CONTEXT — previous attempt failed]\n${failureContext}\n\n[TASK]\n${basePrompt}`
      : basePrompt;

    task.status = TaskStatus.Running;
    const startedAt = new Date().toISOString();
    this.emit('task-started', task, playlist, executionDescription);

    const gitRef = await this.captureGitRef(cwd);
    if (gitRef) {
      this._taskGitRefs.set(task.id, { ref: gitRef, cwd });
    }

    const taskAbort = new AbortController();
    const settingOverrideMs = (() => {
      try {
        const v = vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('taskTimeoutMs');
        return typeof v === 'number' && v >= 30000 ? v : undefined;
      } catch { return undefined; }
    })();
    const taskTimeoutMs = resolveTaskTimeoutMs({
      isService: taskType === 'service',
      taskTimeoutMs: task.timeoutMs,
      startupTimeoutMs: task.startupTimeoutMs,
      serviceDefaultMs: DEFAULT_SERVICE_STARTUP_TIMEOUT_MS,
      settingOverrideMs,
      profileTimeoutMs: profile.taskTimeoutMs,
    });
    const timeoutId = setTimeout(() => taskAbort.abort(), taskTimeoutMs);
    const onParentAbort = () => taskAbort.abort();
    this._abortController?.signal.addEventListener('abort', onParentAbort, { once: true });

    let verification: VerificationResult | undefined;
    let artifacts: TaskArtifact[] | undefined;

    // Gap 1: Pre-flight baseline check — run verifyCommand before the agent
    let baselineVerification: VerificationResult | undefined;
    if (task.verifyCommand && taskType !== 'check') {
      this.emit('task-output', task, `\n-- Pre-flight baseline: ${task.verifyCommand} --\n`, 'stdout');
      baselineVerification = await this.runVerification(task.verifyCommand, cwd, resolvedEnv, taskAbort.signal, task);
      baselineVerification.baselinePassed = baselineVerification.passed;
      if (!baselineVerification.passed) {
        const haltOnBroken = (() => {
          try {
            return vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('haltOnBrokenBaseline', true);
          } catch { return true; }
        })();
        if (haltOnBroken) {
          const haltMsg = `[Pre-flight] Baseline already broken (exit ${baselineVerification.exitCode ?? 1}) — halting to prevent cascading failures.\n` +
            `Fix the baseline before re-running. Disable agentTaskPlayer.haltOnBrokenBaseline to proceed anyway.\n`;
          this.emit('task-output', task, haltMsg, 'stderr');
          task.status = TaskStatus.Failed;
          this.emit('task-failed', task, {
            stdout: '',
            stderr: haltMsg,
            exitCode: baselineVerification.exitCode ?? 1,
            durationMs: 0,
          });
          clearTimeout(timeoutId);
          this._abortController?.signal.removeEventListener('abort', onParentAbort);
          return;
        }
        this.emit('task-output', task,
          `[Pre-flight] Baseline already broken before agent runs — task will not be blamed for this failure\n`,
          'stderr');
      }
    }

    try {
      let result: EngineResult;

      if (task.consensus && task.consensus.engines.length > 0 && taskType === 'agent') {
        result = await this.runConsensusTask(task, cwd, executionDescription, taskAbort.signal, plan);
      } else {
        result = await this.runTaskByType(taskType, task, engineId, cwd, executionDescription, taskAbort.signal, plan, playlist, plan.fallbackEngine, resolvedEnv);
      }

      if (taskAbort.signal.aborted && !this._abortController?.signal.aborted) {
        result = {
          ...result,
          stderr: (result.stderr || '') + `\n[Task timed out after ${Math.round(taskTimeoutMs / 1000)}s]`,
          exitCode: 124,
          durationMs: taskTimeoutMs,
        };

        // Reconciliation: if the agent wrote output despite the timeout, don't waste the work.
        // Check 1 — explicit artifacts: if all expectedArtifacts exist on disk, treat as done.
        if (task.expectedArtifacts && task.expectedArtifacts.length > 0) {
          const allExist = task.expectedArtifacts.every(artifact => {
            const resolved = path.isAbsolute(artifact) ? artifact : path.join(cwd, artifact);
            return fs.existsSync(resolved);
          });
          if (allExist) {
            this.emit('task-output', task,
              `[Reconcile] All ${task.expectedArtifacts.length} expected artifacts found on disk — treating as completed despite timeout.\n`,
              'stdout');
            result = { ...result, exitCode: 0 };
          }
        }

        // Check 2 — implicit: if git shows file changes since this task started, agent made real progress.
        // Only kicks in when no expectedArtifacts are defined and task is still timed-out.
        if (result.exitCode === 124) {
          const gitRef = this._taskGitRefs.get(task.id);
          if (gitRef) {
            try {
              const diff = await this.runGitCommand(['diff', '--name-only', gitRef.ref], cwd);
              const changedFiles = diff ? diff.trim().split('\n').filter(f => f.length > 0) : [];
              if (changedFiles.length > 0) {
                this.emit('task-output', task,
                  `[Reconcile] ${changedFiles.length} file(s) written before timeout — treating as completed.\n` +
                  changedFiles.map(f => `  • ${f}`).join('\n') + '\n',
                  'stdout');
                result = { ...result, exitCode: 0 };
              }
            } catch { /* git unavailable — leave as timeout failure */ }
          }
        }
      }

      if (result.exitCode === 0 && task.verifyCommand && taskType !== 'check') {
        this.emit('task-output', task, `\n-- Verify: ${task.verifyCommand} --\n`, 'stdout');

        // Gap 2: Scoped verify — limit to changed files when task.scopedVerify is set
        let changedFilesForScope: string[] | undefined;
        if (task.scopedVerify) {
          const nameOnly = await this.runGitCommand(['diff', '--name-only', 'HEAD', '--', '*.ts', '*.tsx', '*.js', '*.jsx'], cwd);
          changedFilesForScope = nameOnly ? nameOnly.split('\n').filter(f => f.length > 0) : [];
        }

        verification = await this.runVerification(task.verifyCommand, cwd, resolvedEnv, taskAbort.signal, task, changedFilesForScope);

        // Gap 1: Determine if failure is pre-existing (baseline was already broken)
        if (!verification.passed && baselineVerification && !baselineVerification.passed) {
          verification.baselineBroken = true;
          this.emit('task-output', task,
            `[Verify] Pre-existing failure detected — baseline was already broken. Treating as completed.\n`,
            'stderr');
          // Override exit code: not the task's fault
          result = { ...result, exitCode: 0 };
        }

        if (verification.output) {
          this.emit('task-output', task, verification.output, verification.passed ? 'stdout' : 'stderr');
        }
        if (!verification.passed && !verification.baselineBroken) {
          result = {
            ...result,
            exitCode: verification.exitCode,
            stderr: (result.stderr ? result.stderr + '\n' : '') +
              `[Verification command failed (exit ${verification.exitCode})]\n${verification.output}`,
          };
        }
      }

      if (task.expectedArtifacts && task.expectedArtifacts.length > 0) {
        artifacts = this.captureArtifacts(task.expectedArtifacts, cwd);
        const missingArtifacts = artifacts.filter(artifact => !artifact.exists);
        if (missingArtifacts.length > 0 && result.exitCode === 0) {
          result = {
            ...result,
            exitCode: 2,
            stderr: (result.stderr ? result.stderr + '\n' : '') +
              `[Missing expected artifacts]\n${missingArtifacts.map(artifact => artifact.target).join('\n')}`,
          };
          this.emit('task-output', task, `\n[Artifacts] Missing: ${missingArtifacts.map(artifact => artifact.target).join(', ')}\n`, 'stderr');
        } else if (artifacts.length > 0) {
          this.emit(
            'task-output',
            task,
            `\n[Artifacts] Verified ${artifacts.filter(artifact => artifact.exists).length}/${artifacts.length} expected artifacts\n`,
            'stdout',
          );
        }
      }

      // Auto-test: run project tests after successful agent task
      if (result.exitCode === 0 && this.getTaskType(task) === 'agent') {
        const testResult = await this.autoTestAfterTask(task, playlist, cwd, taskAbort.signal, repairCycle);
        if (!testResult.passed) {
          // If a repair task was queued, don't mark original task as failed — let the repair run
          if (!testResult.repairQueued) {
            result = {
              ...result,
              exitCode: 1,
              stderr: (result.stderr ? result.stderr + '\n' : '') + '[Auto-Test] Tests failed:\n' + testResult.output.slice(-1000),
            };
          }
        }
      }

      result = {
        ...result,
        summary: this.buildResultSummary(task, result, verification, artifacts),
      };

      const { changedFiles, codeChanges } = await this.captureGitDiff(gitRef, cwd);

      // Fix 6: warn when agent exits 0 but changed nothing and has no verifyCommand —
      // this strongly suggests the agent printed text instead of editing files.
      if (result.exitCode === 0 && taskType === 'agent' && changedFiles.length === 0 && !task.verifyCommand) {
        this.emit('task-output', task,
          `\n[Warning] Task completed with exit 0 but no files were changed and no verifyCommand is configured. ` +
          `The agent may have only printed output without making code changes — ` +
          `consider adding a verifyCommand or checking the task prompt.\n`,
          'stderr');
      }

      const finishedAt = new Date().toISOString();
      const threadMeta = task as Task & { _threadId?: string; _turnIndex?: number };

      task.status = this.resolveFinalStatus(task, result.exitCode);

      const entry: HistoryEntry = {
        id: generateId(),
        taskId: task.id,
        taskName: task.name,
        playlistId: playlist.id,
        playlistName: playlist.name,
        engine: engineId,
        taskType,
        prompt: executionDescription,
        result,
        status: task.status,
        startedAt,
        finishedAt,
        changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
        codeChanges: codeChanges || undefined,
        verification,
        artifacts,
        failurePolicy: task.failurePolicy,
        ownerNote: task.ownerNote,
        threadId: threadMeta._threadId,
        turnIndex: threadMeta._turnIndex,
        runId: this._currentRunId || undefined,
        modelId: (task as Task & { _modelId?: string })._modelId,
        modelReason: (task as Task & { _modelReason?: string })._modelReason,
        validationTargetResults: (task as Task & { _validationTargetResults?: HistoryEntry['validationTargetResults'] })._validationTargetResults,
        summary: extractSummary(result.stdout, changedFiles.length > 0 ? changedFiles : undefined),
        contextBudgetUsage: (task as Task & { _budgetUsage?: HistoryEntry['contextBudgetUsage'] })._budgetUsage,
        tokenUsage: result.tokenUsage ? {
          inputTokens: result.tokenUsage.inputTokens ?? 0,
          outputTokens: result.tokenUsage.outputTokens ?? 0,
          estimatedCostUsd: result.tokenUsage.estimatedCost ?? 0,
        } : undefined,
      };
      this.historyStore.add(entry);
      this.trackTaskCost(result);

      if (task.status === TaskStatus.Completed) {
        // Gap 6: Clear failure context on success
        this._taskFailureContext.delete(task.id);
        await this.commitCompletedTask(task, playlist, cwd, changedFiles, result);
        this.emit('task-completed', task, result);
      } else {
        // Classify and store failure context for retry/auto-fix
        const fc = classifyFailure(result.stderr, result.stdout);
        const failureLines: string[] = [
          `Failure category: ${fc.category}`,
          `Reason: ${fc.reason}`,
        ];
        if (fc.errorLines.length > 0) {
          failureLines.push('Specific errors:\n' + fc.errorLines.map(l => `  ${l}`).join('\n'));
        } else if (result.stderr) {
          failureLines.push('Error output:\n' + result.stderr.slice(-1000));
        }
        if (verification && !verification.passed && !verification.baselineBroken) {
          failureLines.push('Verification failed:\n' + verification.output.slice(-1000));
        }
        this._taskFailureContext.set(task.id, failureLines.join('\n\n'));
        this.emit('task-failed', task, result);
        // Fix 3: Hint when autoFix is off so users know why MOAG won't self-repair
        const autoFixOn = !this.isFailSafeMode() && vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('autoFix', true);
        if (!autoFixOn && taskType === 'agent') {
          this.emit('task-output', task,
            `[Hint] autoFix is disabled — Claude won't attempt self-repair.\n` +
            `  Enable it: Settings → agentTaskPlayer.autoFix: true\n` +
            `  Or right-click the task → Retry Task with Note to manually guide the fix.\n`,
            'stderr');
        }
        this.applyFailurePolicy(task, result);
      }
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const errMsg = err instanceof Error ? err.message : String(err);
      const guidance = taskType === 'agent' ? this.getErrorGuidance(errMsg, engineId) : null;
      const errorResult: EngineResult = {
        stdout: '',
        stderr: guidance ? `${errMsg}\n\n${guidance}` : errMsg,
        exitCode: 1,
        durationMs: 0,
        summary: 'Execution failed before completing.',
        command: task.command,
      };

      task.status = this.resolveFinalStatus(task, errorResult.exitCode);
      const threadMeta = task as Task & { _threadId?: string; _turnIndex?: number };
      this.historyStore.add({
        id: generateId(),
        taskId: task.id,
        taskName: task.name,
        playlistId: playlist.id,
        playlistName: playlist.name,
        engine: engineId,
        taskType,
        prompt: executionDescription,
        result: errorResult,
        status: task.status,
        startedAt,
        finishedAt,
        failurePolicy: task.failurePolicy,
        ownerNote: task.ownerNote,
        threadId: threadMeta._threadId,
        turnIndex: threadMeta._turnIndex,
        runId: this._currentRunId || undefined,
      });

      this.emit('task-failed', task, errorResult);
      // Fix 3: Hint when autoFix is off so users know why MOAG won't self-repair
      const autoFixOnCatch = !this.isFailSafeMode() && vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('autoFix', true);
      if (!autoFixOnCatch && taskType === 'agent') {
        this.emit('task-output', task,
          `[Hint] autoFix is disabled — Claude won't attempt self-repair.\n` +
          `  Enable it: Settings → agentTaskPlayer.autoFix: true\n` +
          `  Or right-click the task → Retry Task with Note to manually guide the fix.\n`,
          'stderr');
      }
      this.applyFailurePolicy(task, errorResult);
    } finally {
      clearTimeout(timeoutId);
      this._abortController?.signal.removeEventListener('abort', onParentAbort);
    }
  }

  private getTaskType(task: Task): TaskType {
    return task.type ?? 'agent';
  }

  private resolveFailurePolicy(task: Task): FailurePolicy {
    return task.failurePolicy ?? 'continue';
  }

  private resolveFinalStatus(task: Task, exitCode: number): TaskStatus {
    if (exitCode === 0) {
      return TaskStatus.Completed;
    }
    return this.resolveFailurePolicy(task) === 'mark-blocked'
      ? TaskStatus.Blocked
      : TaskStatus.Failed;
  }

  private applyFailurePolicy(task: Task, result: EngineResult): void {
    if (this.resolveFailurePolicy(task) === 'stop') {
      this.emit('task-output', task, `\n[Failure policy] Stopping after "${task.name}" failed (exit ${result.exitCode}).\n`, 'stderr');
      this.stop();
    }
    // BUG 1 fix: propagate Blocked status to all tasks that depend on this failed task,
    // including tasks in other playlists. Without this, cross-playlist dependents that
    // have stale "completed" status from a previous run would bypass the dependency check.
    this.markDependentsBlocked(task.id);
  }

  private markDependentsBlocked(failedTaskId: string): void {
    const plan = this._plan;
    if (!plan) { return; }
    const allTasks = plan.playlists.flatMap(pl => pl.tasks);
    // Propagate transitively: a task blocked because its dependency is blocked is also blocked
    const toBlock = new Set<string>([failedTaskId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of allTasks) {
        if (t.status === TaskStatus.Blocked || t.status === TaskStatus.Completed || t.status === TaskStatus.Skipped) { continue; }
        if (t.dependsOn?.some(depId => toBlock.has(depId))) {
          t.status = TaskStatus.Blocked;
          toBlock.add(t.id);
          changed = true;
        }
      }
    }
  }

  private async runTaskByType(
    taskType: TaskType,
    task: Task,
    engineId: EngineId,
    cwd: string,
    fullPrompt: string,
    signal: AbortSignal,
    plan: Plan,
    playlist: Playlist,
    fallbackEngine?: EngineId,
    resolvedEnv?: Record<string, string>,
  ): Promise<EngineResult> {
    switch (taskType) {
      case 'agent':
        return this.runAgentTask(task, engineId, cwd, fullPrompt, signal, fallbackEngine);
      case 'command':
        return this.runCommandTask(task, cwd, signal, resolvedEnv);
      case 'service':
        return this.runServiceTask(task, cwd, signal);
      case 'check':
        return this.runCheckTask(task, cwd, signal, resolvedEnv);
      case 'review':
        return this.runReviewTask(task, engineId, cwd, signal, plan, playlist, fallbackEngine);
      case 'validate':
        return this.runValidateTask(task, cwd, signal, plan);
      case 'manual':
        return this.runManualTask(task, signal);
      case 'visual-test':
        return this.runVisualTestTask(task, cwd, fullPrompt, signal);
      case 'deploy':
        return this.runDeployTask(task, cwd, signal, resolvedEnv);
      case 'release':
        return this.runReleaseTask(task, cwd, signal, resolvedEnv);
      case 'monitor':
        return this.runMonitorTask(task, signal);
      default:
        return { stdout: '', stderr: `Unsupported task type "${taskType}"`, exitCode: 1, durationMs: 0 };
    }
  }

  private async runManualTask(task: Task, signal: AbortSignal): Promise<EngineResult> {
    // In CI environments, skip manual gates automatically rather than hanging
    if (process.env.CI === 'true') {
      this.emit('task-output', task,
        `[Manual Gate] CI environment detected — skipping "${task.name}" automatically.\n` +
        `  Set CI="" in your environment to require manual confirmation.\n`,
        'stderr');
      return { stdout: 'Skipped in CI.', stderr: '', exitCode: 0, durationMs: 0 };
    }

    this.emit('task-output', task,
      `\n[Manual Gate] "${task.name}" requires human action before continuing.\n` +
      (task.prompt ? `  What to do: ${task.prompt}\n` : '') +
      `  → Click "Mark Complete" in the notification to unblock execution.\n` +
      `  → Click "Skip" to bypass this step and continue.\n`,
      'stdout');

    this.emit('manual-gate', task);

    const startMs = Date.now();
    return new Promise<EngineResult>((resolve) => {
      this._manualGates.set(task.id, {
        complete: () => resolve({
          stdout: 'Manual step marked complete by user.',
          stderr: '',
          exitCode: 0,
          durationMs: Date.now() - startMs,
        }),
        skip: () => resolve({
          stdout: 'Manual step skipped by user.',
          stderr: '',
          exitCode: 0,
          durationMs: Date.now() - startMs,
        }),
      });

      signal.addEventListener('abort', () => {
        this._manualGates.delete(task.id);
        resolve({ stdout: '', stderr: 'Manual gate cancelled.', exitCode: 1, durationMs: Date.now() - startMs });
      }, { once: true });
    });
  }

  private async runVisualTestTask(
    task: Task,
    cwd: string,
    fullPrompt: string,
    signal: AbortSignal,
  ): Promise<EngineResult> {
    let engine: import('../adapters/engine').EngineAdapter;
    try {
      engine = getEngine('anthropic' as EngineId);
    } catch {
      return {
        stdout: '',
        stderr:
          '[Visual Test] The "anthropic" engine is not available.\n' +
          'Configure ANTHROPIC_API_KEY or add it in Settings → agentTaskPlayer.engines.anthropic.apiKey',
        exitCode: 1,
        durationMs: 0,
      };
    }

    const cfg = vscode.workspace.getConfiguration('agentTaskPlayer.engines.anthropic');
    const model = cfg.get<string>('model', 'claude-sonnet-4-6');

    return engine.runTask({
      prompt: fullPrompt,
      cwd,
      signal,
      browserEnabled: true,
      sandboxUrl: this._sandboxUrl ?? undefined,
      modelId: model,
      sessionId: this._currentSessionId ?? undefined,
      costLabel: 'task',
      onOutput: (chunk, stream) => {
        this.emit('task-output', task, chunk, stream);
      },
    });
  }

  private async runAgentTask(
    task: Task,
    engineId: EngineId,
    cwd: string,
    fullPrompt: string,
    signal: AbortSignal,
    fallbackEngine?: EngineId,
  ): Promise<EngineResult> {
    const result = await this.runAgentOnEngine(task, engineId, cwd, fullPrompt, signal);

    // Rate-limit fallback: retry once on a different engine
    if (
      result.exitCode !== 0 &&
      fallbackEngine &&
      fallbackEngine !== engineId &&
      this.isRateLimited(result)
    ) {
      this.emit('engine-fallback', { taskId: task.id, fromEngine: engineId, toEngine: fallbackEngine });
      this.emit('task-output', task, `\n[Fallback] Rate limit detected on "${engineId}", retrying with "${fallbackEngine}"...\n`, 'stderr');
      return this.runAgentOnEngine(task, fallbackEngine, cwd, fullPrompt, signal);
    }

    return result;
  }

  private isRateLimited(result: EngineResult): boolean {
    const combined = ((result.stdout || '') + '\n' + (result.stderr || '')).toLowerCase();
    return /usage limit|rate limit|quota exceeded|too many requests/.test(combined);
  }

  private async runAgentOnEngine(
    task: Task,
    engineId: EngineId,
    cwd: string,
    fullPrompt: string,
    signal: AbortSignal,
  ): Promise<EngineResult> {
    // Auto-model selection — profile's modelPreset takes priority over the setting
    const profilePreset = (task as Task & { _profileModelPreset?: string })._profileModelPreset;
    const settingPreset = vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<ReasoningPreset>('defaultReasoningPreset', 'auto');
    const preset: ReasoningPreset = profilePreset ? (profilePreset as ReasoningPreset) : settingPreset;
    const autoSelect = vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<boolean>('autoModelSelection', true);
    const selection = autoSelect ? selectModel(task, engineId, preset) : null;

    const modelMeta = task as Task & { _modelId?: string; _modelReason?: string };
    if (engineId === 'codex') {
      modelMeta._modelId = undefined;
      modelMeta._modelReason = undefined;
    } else {
      // Non-Codex engines use the extension's selector directly.
      modelMeta._modelId = selection?.modelId;
      modelMeta._modelReason = selection?.reason;
    }

    // BUG 2 fix: only pass file paths that actually exist on disk; invalid paths would cause
    // the adapter to report 0 context files and Claude would run with no context.
    const resolvedCwd = this.resolveCwd(task.cwd, task);
    const validFiles = task.files?.filter(f => {
      const abs = path.isAbsolute(f) ? f : path.join(resolvedCwd, f);
      return fs.existsSync(abs);
    });

    const engine = getEngine(engineId);
    const result = await engine.runTask({
      prompt: fullPrompt,
      cwd,
      files: validFiles?.length ? validFiles : undefined,
      signal,
      modelId: selection?.modelId,
      sessionId: this._currentSessionId ?? undefined,
      costLabel: 'task',
      onOutput: (chunk, stream) => {
        this.emit('task-output', task, chunk, stream);
      },
    });

    if (engineId === 'codex') {
      modelMeta._modelId = this.parseReportedModelId(result);
    }

    return result;
  }

  private async runReviewTask(
    task: Task,
    originalEngineId: EngineId,
    cwd: string,
    signal: AbortSignal,
    plan: Plan,
    playlist: Playlist,
    fallbackEngine?: EngineId,
  ): Promise<EngineResult> {
    // Find the dependency task's history entry
    const depId = task.dependsOn?.[0];
    if (!depId) {
      return { stdout: '', stderr: 'Review task requires "dependsOn" pointing to the task to review.', exitCode: 1, durationMs: 0 };
    }

    const entries = this.historyStore?.getForTask?.(depId);
    const depEntry = entries?.[0];
    if (!depEntry) {
      return { stdout: '', stderr: `No history found for dependency task "${depId}". The task must run before it can be reviewed.`, exitCode: 1, durationMs: 0 };
    }

    // Pick a different engine for the review
    const rotated = this.rotateEngine(depEntry.engine, plan.defaultEngine);
    const reviewEngine = task.engine ?? rotated;

    if (reviewEngine === depEntry.engine) {
      this.emit('task-output', task, '[Peer Review] Warning: same engine reviewing its own work — consider adding a second engine\n', 'stderr');
    }

    this.emit('task-output', task, `[Peer Review] Reviewing changes with ${reviewEngine}...\n`, 'stdout');

    // Build the review prompt
    const hasDiff = (depEntry.changedFiles && depEntry.changedFiles.length > 0) || !!depEntry.codeChanges;

    let reviewPrompt: string;
    if (hasDiff) {
      const changedFiles = depEntry.changedFiles?.join(', ') || 'none';
      const rawDiff = depEntry.codeChanges || '';
      const codeChanges = rawDiff.length > 8000 ? rawDiff.slice(0, 8000) + '\n...[truncated]' : rawDiff;
      reviewPrompt = [
        `Review the code changes made by the previous task. The task was: ${depEntry.prompt}`,
        ``,
        `Files changed: ${changedFiles}`,
        ``,
        `Code diff:`,
        codeChanges,
        ``,
        `Check for: bugs, security issues, missing error handling, test coverage, and adherence to the original requirements. If you find issues, fix them directly.`,
      ].join('\n');
    } else {
      this.emit('task-output', task, '[Peer Review] No diff available — reviewing based on task prompt only\n', 'stdout');
      reviewPrompt = [
        `Review the following task for correctness. The task was: ${depEntry.prompt}`,
        ``,
        `Check for: bugs, security issues, missing error handling, test coverage, and adherence to the original requirements. If you find issues, fix them directly.`,
      ].join('\n');
    }

    // Review tasks never touch buildContext (buildPrompt is gated to agent|review but its
    // output is discarded at the runTaskByType dispatch), so the charter is prepended here
    // by hand. Default to the reviewer charter: a review task IS a review, whatever the
    // plan's default role happens to be. Resolved locally on every call — never stashed.
    const rolesEnabled = vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('roles.enabled', true);
    const reviewRole = task.role ?? playlist.role ?? plan.defaultRole ?? 'reviewer';
    const roleCharter = rolesEnabled ? resolveRoleCharter(reviewRole, plan.customRoles) : null;
    const finalPrompt = roleCharter
      ? `## Role\n${roleCharter}\n\n${reviewPrompt}`
      : reviewPrompt;

    return this.runAgentTask(task, reviewEngine, cwd, finalPrompt, signal, fallbackEngine);
  }

  private async runValidateTask(
    task: Task,
    cwd: string,
    signal: AbortSignal,
    plan: Plan,
  ): Promise<EngineResult> {
    // Resolve effective targets: task-level override → plan-level default → 'all'
    const rawTargets: Array<import('../models/types').ValidationTarget | 'all'> =
      (task.validation?.targets ?? plan.validation?.targets ?? ['all']) as Array<import('../models/types').ValidationTarget | 'all'>;

    const profile: 'quick' | 'pr' | 'full' =
      (task.validation?.profile ?? plan.validation?.profile ?? 'quick') as 'quick' | 'pr' | 'full';

    const adapters = getValidationAdapters(rawTargets);
    if (adapters.length === 0) {
      return {
        stdout: '',
        stderr: `No validation adapters matched targets: ${rawTargets.join(', ')}`,
        exitCode: 1,
        durationMs: 0,
        summary: 'Validation configuration error.',
      };
    }

    const profileConfig = resolveValidationProfile(profile);
    const { parallelTargets, maxWallClockMs } = profileConfig;

    this.emit('task-output', task, `\n[validate] Profile: ${profile}  Targets: ${rawTargets.join(', ')}  Parallel: ${parallelTargets}\n`, 'stdout');

    // Scoped signal that also fires when the wall-clock budget expires
    const wallController = new AbortController();
    const wallTimer = setTimeout(() => {
      wallController.abort();
      this.emit('task-output', task, `\n[validate] Wall-clock budget (${maxWallClockMs / 1000}s) exceeded — aborting remaining targets\n`, 'stderr');
    }, maxWallClockMs);
    const scopedSignal = composeAbortSignals(signal, wallController.signal);

    const results: import('../adapters/validation/types').ValidationResult[] = [];
    const runStartedAt = Date.now();

    const runAdapter = async (adapter: import('../adapters/validation/types').ValidationAdapter) => {
      const available = await adapter.isAvailable(cwd);
      if (!available) {
        const reason = await adapter.unavailableReason(cwd);
        this.emit('task-output', task, `\n[validate:${adapter.target}] SKIPPED — ${reason}\n`, 'stderr');
        return {
          target: adapter.target,
          available: false,
          skipReason: reason,
          stages: [],
          exitCode: 0,
          durationMs: 0,
          output: '',
          summary: 'skipped',
        } as import('../adapters/validation/types').ValidationResult;
      }

      this.emit('task-output', task, `\n[validate:${adapter.target}] Starting ${profile} validation...\n`, 'stdout');
      const result = await adapter.run({
        cwd,
        profile,
        signal: scopedSignal,
        env: task.env,
        onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
      });

      const icon = result.exitCode === 0 ? '✓' : '✗';
      this.emit('task-output', task, `\n[validate:${adapter.target}] ${icon} ${result.summary}\n`, result.exitCode === 0 ? 'stdout' : 'stderr');
      return result;
    };

    // Run adapters in parallel batches respecting the profile's parallelTargets limit
    for (let i = 0; i < adapters.length; i += parallelTargets) {
      if (scopedSignal.aborted) { break; }
      const batch = adapters.slice(i, i + parallelTargets);
      const batchResults = await Promise.all(batch.map(runAdapter));
      results.push(...batchResults);
    }

    clearTimeout(wallTimer);

    const engineResult = validationResultToEngineResult(results);
    engineResult.durationMs = Date.now() - runStartedAt;

    // Stash per-target breakdown on the task for history entry enrichment
    (task as Task & { _validationTargetResults?: HistoryEntry['validationTargetResults'] })._validationTargetResults =
      results.map(r => ({
        target: r.target,
        status: !r.available ? 'skip' : r.exitCode === 0 ? 'pass' : 'fail',
        stagesPassed: r.stages.filter(s => s.passed).length,
        stagesFailed: r.stages.filter(s => !s.passed).length,
        durationMs: r.durationMs,
        summary: r.summary,
      })) as HistoryEntry['validationTargetResults'];

    return engineResult;
  }

  private async runConsensusTask(
    task: Task,
    cwd: string,
    fullPrompt: string,
    signal: AbortSignal,
    plan: Plan,
  ): Promise<EngineResult> {
    const consensus = task.consensus!;
    const engines = consensus.engines;
    const strategy = consensus.strategy || 'first-pass';

    this.emit('task-output', task, `\n[Consensus] Running on ${engines.length} engines (${strategy}): ${engines.join(', ')}\n`, 'stdout');

    const results: Array<{ engine: EngineId; result: EngineResult; changedFiles: string[] }> = [];

    for (const engine of engines) {
      if (signal.aborted) { break; }

      // Capture git state before this attempt
      const beforeRef = await this.captureGitRef(cwd);

      this.emit('task-output', task, `\n[Consensus] Trying engine: ${engine}...\n`, 'stdout');
      const result = await this.runAgentTask(task, engine, cwd, fullPrompt, signal, plan.fallbackEngine);

      // Capture what changed
      const { changedFiles } = beforeRef
        ? await this.captureGitDiff(beforeRef, cwd)
        : { changedFiles: [] };

      results.push({ engine, result, changedFiles });

      if (strategy === 'first-pass' && result.exitCode === 0) {
        this.emit('task-output', task,
          `\n[Consensus] Winner: ${engine} (passed, ${changedFiles.length} files changed)\n`, 'stdout');
        return result;
      }

      // Each engine builds on the previous attempt's work — no destructive revert.
      // First success returns early (first-pass), failed attempts leave changes for the next engine.
    }

    // All engines have run — pick the best result based on strategy
    if (strategy === 'best-diff') {
      // Pick the result that changed the most files
      let best = results[0];
      for (const entry of results) {
        if (entry.result.exitCode === 0 && (best.result.exitCode !== 0 || entry.changedFiles.length > best.changedFiles.length)) {
          best = entry;
        }
      }
      // If the best isn't the last one, we need to revert and re-run the winner
      // For v1 simplicity, the last result's changes are in the working tree
      // If the best is not the last, report it but keep last result (sequential limitation)
      this.emit('task-output', task,
        `\n[Consensus] Best result: ${best.engine} (${best.changedFiles.length} files changed, exit ${best.result.exitCode})\n`, 'stdout');
      return best.result;
    }

    // first-pass strategy but none passed — pick the one with most stdout
    let bestFallback = results[0];
    for (const entry of results) {
      if (entry.result.stdout.length > bestFallback.result.stdout.length) {
        bestFallback = entry;
      }
    }
    this.emit('task-output', task,
      `\n[Consensus] No engine passed. Best effort: ${bestFallback.engine} (${bestFallback.result.stdout.length} chars output)\n`, 'stderr');
    return bestFallback.result;
  }

  private rotateEngine(originalEngine: EngineId, defaultEngine: EngineId): EngineId {
    const rotation: Record<string, EngineId> = {
      claude: 'codex',
      codex: 'gemini',
      gemini: 'claude',
      ollama: 'claude',
      custom: 'claude',
      anthropic: 'claude',
    };
    const rotated = rotation[originalEngine];
    if (rotated && rotated !== originalEngine) {
      return rotated;
    }
    // Fallback: if rotation gives same engine, use defaultEngine if different
    if (defaultEngine !== originalEngine) {
      return defaultEngine;
    }
    return rotation[defaultEngine] ?? 'claude';
  }

  private async runCommandTask(task: Task, cwd: string, signal: AbortSignal, resolvedEnv?: Record<string, string>): Promise<EngineResult> {
    const command = task.command?.trim();
    if (!command) {
      return { stdout: '', stderr: 'Command task is missing the "command" field.', exitCode: 1, durationMs: 0 };
    }
    this.emit('task-output', task, `\n-- Command: ${command} --\n`, 'stdout');
    const result = await this.runLocalCommand(command, {
      cwd,
      env: resolvedEnv ?? task.env,
      signal,
      onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
    });
    // Gap 7: command tasks — exit code 0 = success, non-zero = failure. No stdout-pattern checks.
    return { ...result, summary: result.exitCode === 0 ? 'Command completed successfully.' : 'Command exited with an error.' };
  }

  private async runCheckTask(task: Task, cwd: string, signal: AbortSignal, resolvedEnv?: Record<string, string>): Promise<EngineResult> {
    const command = task.command?.trim() || task.verifyCommand?.trim();
    if (!command) {
      return {
        stdout: '',
        stderr:
          `[Config Error] type:"check" requires a "command" or "verifyCommand" — it is an automated polling check, not a human gate.\n` +
          `  If you need a human step with no automated command, use type:"manual" instead.\n` +
          `  type:"manual" shows a "Mark Complete" button and waits for human confirmation.`,
        exitCode: 1,
        durationMs: 0,
      };
    }
    this.emit('task-output', task, `\n-- Check: ${command} --\n`, 'stdout');
    const result = await this.runLocalCommand(command, {
      cwd,
      env: resolvedEnv ?? task.env,
      signal,
      onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
    });
    // Gap 7: check tasks — exit code 0 = passed, non-zero = failed. No stdout-pattern checks.
    return { ...result, summary: result.exitCode === 0 ? 'Check passed.' : 'Check failed.' };
  }

  /**
   * deploy task — runs a pluggable deploy command (env-aware via inheritEnvFiles, e.g.
   * .env.staging) and, if healthCheckUrl is set, gates success on a post-deploy smoke
   * check. "Gated at ship": place a type:"manual" approval task that deploy dependsOn.
   */
  private async runDeployTask(task: Task, cwd: string, signal: AbortSignal, resolvedEnv?: Record<string, string>): Promise<EngineResult> {
    const command = task.command?.trim();
    if (!command) {
      return { stdout: '', stderr: 'Deploy task is missing the "command" field (e.g. "npm run deploy").', exitCode: 1, durationMs: 0 };
    }
    this.emit('task-output', task, `\n-- Deploy: ${command} --\n`, 'stdout');
    const result = await this.runLocalCommand(command, {
      cwd,
      env: resolvedEnv ?? task.env,
      signal,
      onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
    });
    if (result.exitCode !== 0) {
      return { ...result, summary: 'Deploy command failed.' };
    }
    if (task.healthCheckUrl) {
      const healthy = await this.waitForHealthy(task.healthCheckUrl, signal, task.startupTimeoutMs ?? 60_000);
      if (!healthy) {
        return {
          stdout: result.stdout,
          stderr: `${result.stderr}\n[Smoke gate] Deploy ran but ${task.healthCheckUrl} did not become healthy.`,
          exitCode: 1,
          durationMs: result.durationMs,
          summary: 'Deploy smoke check failed.',
        };
      }
      this.emit('task-output', task, `[Smoke gate] ${task.healthCheckUrl} healthy.\n`, 'stdout');
    }
    return { ...result, summary: 'Deploy completed successfully.' };
  }

  /** Poll a health endpoint until it returns <400 or the deadline passes. */
  private async waitForHealthy(url: string, signal: AbortSignal, timeoutMs: number, intervalMs = 2000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      if (signal.aborted) { return false; }
      if (await this.checkHealthUrl(url)) { return true; }
      if (Date.now() + intervalMs >= deadline) { break; }
      await new Promise((r) => setTimeout(r, intervalMs));
    } while (Date.now() < deadline);
    return false;
  }

  /**
   * release task — optional pluggable command (version bump / changelog / publish),
   * then optional annotated git tag, then optional push + GitHub release via gh.
   */
  private async runReleaseTask(task: Task, cwd: string, signal: AbortSignal, resolvedEnv?: Record<string, string>): Promise<EngineResult> {
    const command = task.command?.trim();
    if (!command && !task.releaseTag) {
      return { stdout: '', stderr: 'Release task needs a "command" and/or a "releaseTag".', exitCode: 1, durationMs: 0 };
    }
    const outputs: string[] = [];

    if (command) {
      this.emit('task-output', task, `\n-- Release: ${command} --\n`, 'stdout');
      const result = await this.runLocalCommand(command, {
        cwd,
        env: resolvedEnv ?? task.env,
        signal,
        onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
      });
      if (result.exitCode !== 0) {
        return { ...result, summary: 'Release command failed.' };
      }
      outputs.push(result.stdout);
    }

    if (task.releaseTag) {
      const notes = task.releaseNotes ?? `Release ${task.releaseTag}`;
      const tagged = await this.runGitCommand(['tag', '-a', task.releaseTag, '-m', notes], cwd);
      if (tagged === null) {
        return { stdout: outputs.join('\n'), stderr: `Failed to create git tag ${task.releaseTag}.`, exitCode: 1, durationMs: 0, summary: 'Release tag failed.' };
      }
      this.emit('task-output', task, `[Release] Tagged ${task.releaseTag}.\n`, 'stdout');

      if (task.githubRelease) {
        const pushed = await this.runGitCommand(['push', 'origin', task.releaseTag], cwd);
        if (pushed === null) {
          return { stdout: outputs.join('\n'), stderr: `Tag created but failed to push ${task.releaseTag}.`, exitCode: 1, durationMs: 0, summary: 'Release push failed.' };
        }
        try {
          ghSync(['release', 'create', task.releaseTag, '--title', task.releaseTag, '--notes', notes], { cwd, timeout: 20_000 });
          this.emit('task-output', task, `[Release] GitHub release ${task.releaseTag} created.\n`, 'stdout');
        } catch (err) {
          return { stdout: outputs.join('\n'), stderr: `GitHub release failed: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1, durationMs: 0, summary: 'GitHub release failed.' };
        }
      }
    }

    return { stdout: outputs.join('\n'), stderr: '', exitCode: 0, durationMs: 0, summary: 'Release completed.' };
  }

  /**
   * monitor task — samples a health endpoint; on breach it surfaces an incident and
   * (if incidentRepo is set) files an issue the autonomous loop will intake → fix →
   * gated-redeploy, closing the maintenance loop. Fails the task on breach so it's visible.
   */
  private async runMonitorTask(task: Task, signal: AbortSignal): Promise<EngineResult> {
    const url = task.healthCheckUrl?.trim();
    if (!url) {
      return { stdout: '', stderr: 'Monitor task requires a "healthCheckUrl" to probe.', exitCode: 1, durationMs: 0 };
    }
    const samples = Math.max(1, task.monitorSamples ?? 3);
    const intervalMs = task.monitorIntervalMs ?? 2000;
    const threshold = Math.max(1, task.failureThreshold ?? 1);
    this.emit('task-output', task, `\n-- Monitor: ${url} (${samples} samples, threshold ${threshold}) --\n`, 'stdout');

    let failures = 0;
    for (let i = 0; i < samples; i++) {
      if (signal.aborted) { break; }
      const healthy = await this.checkHealthUrl(url);
      if (!healthy) { failures++; }
      this.emit('task-output', task, `  sample ${i + 1}/${samples}: ${healthy ? 'ok' : 'FAIL'}\n`, healthy ? 'stdout' : 'stderr');
      if (i < samples - 1 && intervalMs > 0) { await new Promise((r) => setTimeout(r, intervalMs)); }
    }

    if (failures >= threshold) {
      const summary = `Health check ${url} failed ${failures}/${samples} samples.`;
      this.emit('task-output', task, `[Incident] ${summary}\n`, 'stderr');
      let issueUrl: string | null = null;
      if (task.incidentRepo) {
        issueUrl = fileIncidentIssue(
          task.incidentRepo,
          `Incident: ${task.name} unhealthy`,
          `Automated incident from a MOAG monitor task.\n\n${summary}\n\nEndpoint: ${url}`,
          { label: task.incidentLabel ?? 'moag:incident', cwd: this.resolveCwd(task.cwd, task) },
        );
        if (issueUrl) { this.emit('task-output', task, `[Incident] Filed ${issueUrl}\n`, 'stdout'); }
      }
      this.emit('incident', task, summary, issueUrl);
      return { stdout: '', stderr: summary, exitCode: 1, durationMs: 0, summary: 'Incident detected.' };
    }
    return { stdout: `Healthy (${samples - failures}/${samples}).`, stderr: '', exitCode: 0, durationMs: 0, summary: 'Monitor: healthy.' };
  }

  private async runServiceTask(task: Task, cwd: string, signal: AbortSignal): Promise<EngineResult> {
    const command = task.command?.trim();
    if (!command) {
      return { stdout: '', stderr: 'Service task is missing the "command" field.', exitCode: 1, durationMs: 0 };
    }

    const startedAt = Date.now();
    const serviceTimeoutMs = task.startupTimeoutMs ?? DEFAULT_SERVICE_STARTUP_TIMEOUT_MS;

    return new Promise<EngineResult>((resolve) => {
      const proc = spawn(command, [], {
        cwd,
        shell: true,
        env: { ...process.env, ...(task.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: EngineResult, keepProcess = false) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(readinessInterval);
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        proc.stdout?.removeListener('data', onStdout);
        proc.stderr?.removeListener('data', onStderr);
        proc.removeListener('error', onError);
        proc.removeListener('close', onCloseBeforeReady);

        if (keepProcess) {
          this._serviceProcesses.set(task.id, {
            taskId: task.id,
            taskName: task.name,
            command,
            cwd,
            startedAt: new Date().toISOString(),
            port: task.port,
            healthCheckUrl: task.healthCheckUrl,
            readyPattern: task.readyPattern,
            proc,
          });
          proc.once('close', () => {
            this._serviceProcesses.delete(task.id);
          });
        } else {
          this.killProcess(proc);
        }

        resolve(result);
      };

      const onStdout = (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        this.emit('task-output', task, text, 'stdout');
      };

      const onStderr = (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        this.emit('task-output', task, text, 'stderr');
      };

      const onError = (err: Error) => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + err.message,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service failed to start.',
        });
      };

      const onCloseBeforeReady = (code: number | null, procSignal: NodeJS.Signals | null) => {
        finish({
          stdout,
          stderr: stderr || `Service exited before becoming ready (${code ?? procSignal ?? 'unknown'}).`,
          exitCode: code ?? 1,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service exited before becoming ready.',
        });
      };

      const onAbort = () => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + '[Service start aborted]',
          exitCode: 130,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service start aborted.',
        });
      };

      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.once('error', onError);
      proc.once('close', onCloseBeforeReady);
      signal.addEventListener('abort', onAbort, { once: true });

      this.emit('task-output', task, `\n-- Service: ${command} --\n`, 'stdout');

      const readinessInterval = setInterval(async () => {
        if (settled) {
          return;
        }
        const ready = await this.isServiceReady(task, stdout + '\n' + stderr, Date.now() - startedAt);
        if (!ready) {
          return;
        }
        this.emit('task-output', task, '\n[Service] Ready\n', 'stdout');
        finish({
          stdout,
          stderr,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          command,
          summary: this.describeServiceReady(task),
        }, true);
      }, 400);

      const timeoutId = setTimeout(() => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + `[Service readiness timed out after ${Math.round(serviceTimeoutMs / 1000)}s]`,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service did not become ready in time.',
        });
      }, serviceTimeoutMs);
    });
  }

  private async isServiceReady(task: Task, output: string, elapsedMs: number): Promise<boolean> {
    const checks: boolean[] = [];

    if (task.readyPattern) {
      checks.push(this.matchesReadyPattern(output, task.readyPattern));
    }

    if (task.port) {
      checks.push(await this.checkPort(task.port));
    }

    if (task.healthCheckUrl) {
      checks.push(await this.checkHealthUrl(task.healthCheckUrl));
    }

    if (checks.length === 0) {
      return elapsedMs >= 1500;
    }

    return checks.every(Boolean);
  }

  private describeServiceReady(task: Task): string {
    const parts: string[] = ['Service is running'];
    if (task.port) {
      parts.push(`port ${task.port} is open`);
    }
    if (task.healthCheckUrl) {
      parts.push(`health check passed at ${task.healthCheckUrl}`);
    }
    if (task.readyPattern) {
      parts.push(`ready pattern "${task.readyPattern}" matched`);
    }
    return parts.join('; ') + '.';
  }

  private matchesReadyPattern(output: string, pattern: string): boolean {
    try {
      return new RegExp(pattern, 'm').test(output);
    } catch {
      return output.includes(pattern);
    }
  }

  private checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(750);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, '127.0.0.1');
    });
  }

  private checkHealthUrl(urlString: string): Promise<boolean> {
    return new Promise((resolve) => {
      const client = urlString.startsWith('https://') ? https : http;
      const req = client.get(urlString, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 400);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });
  }

  private async runVerification(
    command: string,
    cwd: string,
    env: Record<string, string> | undefined,
    parentSignal: AbortSignal,
    task: Task,
    changedFiles?: string[],
  ): Promise<VerificationResult> {
    // Gap 2: Scoped verify — transform command to target only changed files
    let effectiveCommand = command;
    if (changedFiles && changedFiles.length > 0) {
      const tsFiles = changedFiles.filter(f => /\.(ts|tsx)$/.test(f));
      const jsFiles = changedFiles.filter(f => /\.(js|jsx)$/.test(f));
      const scopedFiles = [...tsFiles, ...jsFiles];
      if (scopedFiles.length > 0) {
        const fileArgs = scopedFiles.map(f => JSON.stringify(f)).join(' ');
        if (/\bnpx\s+tsc\b/.test(command) || /\btsc\s+--noEmit\b/.test(command)) {
          // Append files after --noEmit
          effectiveCommand = command.replace(/(--noEmit)/, `$1 ${fileArgs}`);
          if (effectiveCommand === command) {
            effectiveCommand = command + ' ' + fileArgs;
          }
        } else if (/\beslint\b/.test(command)) {
          effectiveCommand = command + ' ' + fileArgs;
        }
        // Otherwise fall through with original command
      }
    }

    const verifyAbort = new AbortController();
    const timer = setTimeout(() => verifyAbort.abort(), VERIFY_TIMEOUT_MS);
    const onParentAbort = () => verifyAbort.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const result = await this.runLocalCommand(effectiveCommand, {
        cwd,
        env,
        signal: verifyAbort.signal,
        onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return {
        command: effectiveCommand,
        exitCode: result.exitCode,
        output,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      };
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  private runLocalCommand(command: string, options: CommandRunOptions): Promise<EngineResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let settled = false;

      const proc = spawn(command, [], {
        cwd: options.cwd,
        shell: true,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (result: EngineResult) => {
        if (settled) {
          return;
        }
        settled = true;
        options.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const onAbort = () => {
        this.killProcess(proc);
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + '[Command aborted]',
          exitCode: 130,
          durationMs: Date.now() - startedAt,
          command,
        });
      };

      options.signal.addEventListener('abort', onAbort, { once: true });

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        options.onOutput?.(text, 'stdout');
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        options.onOutput?.(text, 'stderr');
      });

      proc.on('error', (err: Error) => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + err.message,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          command,
        });
      });

      proc.on('close', (code) => {
        finish({
          stdout,
          stderr,
          exitCode: code ?? 1,
          durationMs: Date.now() - startedAt,
          command,
        });
      });
    });
  }

  private killProcess(proc: ChildProcess): void {
    if (proc.killed) {
      return;
    }
    if (process.platform === 'win32' && proc.pid) {
      try {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  private async buildPrompt(task: Task, cwd: string, plan: Plan, playlist: Playlist): Promise<string> {
    const settings = getContextSettings();
    let prompt = '';
    if (settings.enabled) {
      const pendingScreenshots = this._pendingScreenshots.length > 0
        ? [...this._pendingScreenshots]
        : undefined;
      // Consume the queue — screenshots attach to the first task after capture
      this._pendingScreenshots = [];

      // Run retrieval cascade: symbol hints → semantic provider.
      // Skip for command/visual-test tasks — they don't read source files.
      const needsCodeContext = task.type !== 'command' && task.type !== 'visual-test';
      const { spans: retrievedSpans, usedSemantic: retrievedSpansUsedSemantic } =
        needsCodeContext
          ? await runRetrievalCascade(task, cwd, settings.maxFileContextChars)
          : { spans: [], usedSemantic: false };

      const ruleParts: string[] = [];
      const storeRules = this._aiRulesStore?.getEnabledText(cwd) ?? '';
      if (storeRules) { ruleParts.push(storeRules); }
      if (plan.aiRules?.trim()) { ruleParts.push(`### Plan Rules\n${plan.aiRules.trim()}`); }
      if (playlist.aiRules?.trim()) { ruleParts.push(`### Playlist Rules\n${playlist.aiRules.trim()}`); }
      const aiRules = ruleParts.join('\n\n');

      // Role: task > playlist > plan, mirroring the engine chain in runTaskByType.
      // Resolved fresh on every call and never stashed on the task — a second concurrent
      // loop would otherwise overwrite the first one's charter mid-flight.
      const rolesEnabled = vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('roles.enabled', true);
      const roleId = task.role ?? playlist.role ?? plan.defaultRole;
      const roleCharter = rolesEnabled ? resolveRoleCharter(roleId, plan.customRoles) : null;

      const threadMeta = task as Task & { _threadId?: string; _turnIndex?: number };
      const priorThread = (threadMeta._threadId && (threadMeta._turnIndex ?? 0) > 0)
        ? this.historyStore.getThread(threadMeta._threadId)
            .filter(e => (e.turnIndex ?? 0) < (threadMeta._turnIndex ?? 0))
        : undefined;
      const effectiveBudget = adaptiveContextBudget(task, settings.maxContextChars);
      const effectiveSettings = effectiveBudget !== settings.maxContextChars
        ? { ...settings, maxContextChars: effectiveBudget }
        : settings;
      const budgetUsage: import('../context/context-builder').ContextBudgetUsage = {
        totalCharsUsed: 0, totalCharsBudget: effectiveBudget,
        sectionsDropped: 0, usedSemanticRetrieval: false, semanticSpansReturned: 0,
      };
      const ctx = buildContext({
        plan, playlist, task, cwd, historyStore: this.historyStore, settings: effectiveSettings,
        budgetUsage,
        pendingScreenshots, retrievedSpans, retrievedSpansUsedSemantic,
        roleCharter: roleCharter ?? undefined,
        aiRules: aiRules || undefined,
        priorThread: priorThread?.length ? priorThread : undefined,
        sandboxUrl: (playlist.testPhase && this._sandboxUrl) ? this._sandboxUrl : undefined,
      });
      // Stash telemetry on task for the history entry and dashboard (same pattern as _modelId)
      (task as Task & { _budgetUsage?: typeof budgetUsage })._budgetUsage = budgetUsage;
      // Stash unique retrieved file paths for the Context Memory dashboard panel
      const retrievedFiles = [...new Set(retrievedSpans.map(s => s.filePath))];
      (task as Task & { _retrievedFiles?: string[] })._retrievedFiles = retrievedFiles;
      if (ctx) {
        prompt += ctx + '\n\n';
      }
    }
    // Inject execution rules before the task prompt
    const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
    const rulesEnabled = cfg.get<boolean>('promptRulesEnabled', true);
    if (rulesEnabled) {
      const rules = cfg.get<string>('promptRules', '');
      if (rules) {
        prompt += rules + '\n\n';
      }
    }

    // Inject auto-inject prompt snippets
    const snippetsEnabled = cfg.get<boolean>('promptSnippets.enabled', true);
    if (snippetsEnabled && this._promptLibrary) {
      const snippets = this._promptLibrary.getAutoInject();
      if (snippets.length > 0) {
        prompt += '[PROMPT SNIPPETS]\n';
        for (const s of snippets) {
          prompt += `- ${s.text}\n`;
        }
        prompt += '[/PROMPT SNIPPETS]\n\n';
      }
    }

    prompt += task.prompt;

    const contract = this.buildTaskContract(task);
    if (contract) {
      prompt += `\n\nExecution contract:\n${contract}`;
    }

    // Fix 3: record where task.prompt was appended so we can trim context prefix if needed
    const taskPartStart = prompt.length - task.prompt.length;

    if (task.files && task.files.length > 0) {
      const fileContents: string[] = [];
      let remainingFileBudget = Math.max(settings.maxFileContextChars, 1000);
      for (const filePath of task.files) {
        if (remainingFileBudget <= 0) {
          fileContents.push(`--- ${filePath} --- (skipped: context budget exhausted)`);
          continue;
        }
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
        try {
          const content = fs.readFileSync(resolved, 'utf-8');
          const clipped = content.length > remainingFileBudget
            ? content.slice(0, remainingFileBudget) + '\n...[truncated]'
            : content;
          const block = `--- ${filePath} ---\n${clipped}`;
          fileContents.push(block);
          remainingFileBudget -= clipped.length;
        } catch {
          fileContents.push(`--- ${filePath} --- (file not found)`);
        }
      }
      prompt += `\n\nContext files:\n\n${fileContents.join('\n\n')}`;
    }

    // Fix 3: hard cap at 80K chars — trim the context prefix to preserve the task prompt
    const MAX_PROMPT_CHARS = 80_000;
    if (prompt.length > MAX_PROMPT_CHARS) {
      const taskPart = prompt.slice(taskPartStart);
      const allowedPrefixLen = MAX_PROMPT_CHARS - taskPart.length;
      if (allowedPrefixLen > 0) {
        prompt = prompt.slice(0, allowedPrefixLen) +
          '\n...[context trimmed to fit 80K limit]\n\n' +
          taskPart;
      } else {
        // Task portion alone is already huge — truncate at limit
        prompt = taskPart.slice(0, MAX_PROMPT_CHARS) + '\n...[prompt truncated at 80K chars]';
      }
    }

    // Variable substitution: {{varName}} → value
    prompt = this.substituteVariables(prompt, plan, cwd);

    return prompt;
  }

  private substituteVariables(prompt: string, plan: Plan, cwd: string): string {
    if (!prompt.includes('{{')) { return prompt; }

    // Built-in variables
    const builtIn: Record<string, string> = {
      planName: plan.name,
      workspaceFolder: cwd,
      date: new Date().toISOString().split('T')[0],
    };

    // Merge user-defined variables (user vars take precedence)
    const vars = { ...builtIn, ...(plan.variables ?? {}) };

    return prompt.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return vars[name] !== undefined ? vars[name] : match;
    });
  }

  private buildTaskDescription(task: Task): string {
    const lines = [
      task.prompt ? `Task: ${task.prompt}` : `Task: ${task.name}`,
      this.buildTaskContract(task),
    ].filter(Boolean);
    return lines.join('\n\n');
  }

  private buildTaskContract(task: Task): string {
    const sections: string[] = [];

    if (task.command) {
      sections.push(`- Command: ${task.command}`);
    }
    if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
      sections.push(`- Acceptance criteria:\n${task.acceptanceCriteria.map(item => `  - ${item}`).join('\n')}`);
    }
    if (task.verifyCommand) {
      sections.push(`- Verify command: ${task.verifyCommand}`);
    }
    if (task.expectedArtifacts && task.expectedArtifacts.length > 0) {
      sections.push(`- Expected artifacts:\n${task.expectedArtifacts.map(item => `  - ${item}`).join('\n')}`);
    }
    if (task.ownerNote) {
      sections.push(`- Owner note: ${task.ownerNote}`);
    }
    if (task.failurePolicy) {
      sections.push(`- Failure policy: ${task.failurePolicy}`);
    }
    if (task.port) {
      sections.push(`- Port check: ${task.port}`);
    }
    if (task.healthCheckUrl) {
      sections.push(`- Health check: ${task.healthCheckUrl}`);
    }
    if (task.readyPattern) {
      sections.push(`- Ready pattern: ${task.readyPattern}`);
    }

    return sections.join('\n');
  }

  private resolveCwd(taskCwd?: string, task?: Task): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const isolated = task ? this._taskCwdRoot.get(task.id) : undefined;
    const root = isolated ?? workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    if (!taskCwd) {
      return root;
    }
    return path.isAbsolute(taskCwd) ? taskCwd : path.join(root, taskCwd);
  }

  private captureArtifacts(expectedArtifacts: string[], cwd: string): TaskArtifact[] {
    return expectedArtifacts.map((target) => {
      const resolvedPath = path.isAbsolute(target) ? target : path.join(cwd, target);
      return {
        target,
        exists: fs.existsSync(resolvedPath),
        resolvedPath,
      };
    });
  }

  private buildResultSummary(
    task: Task,
    result: EngineResult,
    verification?: VerificationResult,
    artifacts?: TaskArtifact[],
  ): string {
    const parts: string[] = [];
    parts.push(result.exitCode === 0 ? `${this.getTaskType(task)} task passed` : `${this.getTaskType(task)} task failed with exit ${result.exitCode}`);
    if (verification) {
      parts.push(verification.passed ? 'verification passed' : 'verification failed');
    }
    if (artifacts && artifacts.length > 0) {
      const found = artifacts.filter(artifact => artifact.exists).length;
      parts.push(`artifacts ${found}/${artifacts.length} present`);
    }
    if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
      parts.push(`${task.acceptanceCriteria.length} acceptance criteria documented`);
    }
    return parts.join('; ') + '.';
  }

  private parseReportedModelId(result: EngineResult): string | undefined {
    const combined = [result.stderr, result.stdout].filter(Boolean).join('\n');
    const match = combined.match(/^\s*model:\s*([^\r\n]+)\s*$/mi);
    return match?.[1]?.trim() || undefined;
  }

  private getErrorGuidance(errorMsg: string, engineId: EngineId): string | null {
    const lower = errorMsg.toLowerCase();

    if (lower.includes('enoent') || lower.includes('not found') || lower.includes('not recognized')) {
      return `Hint: The "${engineId}" CLI does not appear to be installed or is not in your PATH. Check the command in Settings > agentTaskPlayer.engines.${engineId}.command`;
    }
    if (lower.includes('eacces') || lower.includes('permission denied')) {
      return `Hint: Permission denied. Ensure the "${engineId}" CLI binary is executable.`;
    }
    if (lower.includes('timeout') || lower.includes('etimedout')) {
      return `Hint: The task timed out. The AI engine may be overloaded - try again or use a different engine.`;
    }
    if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('authentication')) {
      return `Hint: Authentication failed. Ensure your API key or credentials for "${engineId}" are configured correctly.`;
    }
    if (lower.includes('rate limit') || lower.includes('429')) {
      return `Hint: Rate limited by the "${engineId}" API. Wait a moment and try again.`;
    }
    return null;
  }


  /**
   * Arm per-task commits for this run, if the user opted in.
   *
   * Every refusal is a warning, never a failure: delivery being unavailable is
   * not a reason to abandon the work. The run proceeds exactly as it does today
   * and the user keeps their diff.
   */
  private async armGitDelivery(plan: Plan): Promise<void> {
    this._deliveryBranch = null;

    const cfg = this.getDeliveryConfig();
    if (!cfg.enabled) { return; }

    const cwd = this.resolveCwd(undefined);
    const outcome = await prepareBranch(
      cwd,
      plan.name,
      this._currentRunId ?? 'run',
      cfg,
      (args, dir) => this.runGitCommand(args, dir),
    );

    if (!outcome.ok) {
      this.emit('error', new Error(describePrepareFailure(outcome.reason)));
      return;
    }
    this._deliveryBranch = outcome.branch;
  }

  /** Commit a task that just passed, when delivery is armed. */
  private async commitCompletedTask(
    task: Task,
    playlist: Playlist,
    cwd: string,
    changedFiles: string[],
    result: EngineResult,
  ): Promise<void> {
    if (!this._deliveryBranch) { return; }

    const outcome = await commitTask(
      {
        cwd,
        taskName: task.name,
        playlistName: playlist.name,
        engine: task.engine ?? playlist.engine ?? 'unknown',
        changedFiles,
        costUsd: result.tokenUsage?.estimatedCost,
      },
      (args, dir) => this.runGitCommand(args, dir),
    );

    if (outcome.committed) {
      this.emit('task-output', task,
        `[MOAG] Committed ${outcome.sha} on ${this._deliveryBranch}\n`, 'stdout');
    } else if (outcome.reason === 'commit-failed') {
      // Surface it, but never fail a task that already passed its gates.
      this.emit('task-output', task,
        `[MOAG] Auto-commit failed: ${outcome.detail}\n`, 'stderr');
    }
  }

  private getDeliveryConfig(): DeliveryConfig {
    const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
    return {
      enabled: cfg.get<boolean>('git.autoCommit', false),
      branchPrefix: cfg.get<string>('git.branchPrefix', 'moag/') || 'moag/',
    };
  }


  /**
   * Establish worktree isolation for a concurrent run, or refuse the concurrency.
   *
   * Returns the concurrency that may actually be used. Falling back to 1 is
   * always safe; running N agents in one directory is not, so isolation failing
   * downgrades the run rather than risking a tree nobody can attribute.
   */
  private async armIsolation(plan: Plan, requested: number): Promise<number> {
    this._playlistCwd.clear();
    this._worktrees = [];

    if (!isolationRequired(requested, plan.playlists.length)) {
      return requested;
    }

    // Isolation without delivery would strand each playlist's work in a
    // throwaway checkout that teardown then has to keep. Refuse the concurrency
    // instead of creating that situation.
    if (!this.getDeliveryConfig().enabled) {
      this.emit('error', new Error(describeIsolationFailure('delivery-off')));
      return 1;
    }

    const repoRoot = this.resolveCwd(undefined);
    const outcome = await createWorktrees(
      repoRoot,
      plan.playlists.map((pl) => ({ id: pl.id, name: pl.name })),
      this._currentRunId ?? 'run',
      this.getDeliveryConfig().branchPrefix,
      (args, dir) => this.runGitCommand(args, dir),
    );

    if (!outcome.ok) {
      this.emit('error', new Error(describeIsolationFailure(outcome.reason)));
      return 1;
    }

    this._worktrees = outcome.worktrees;
    for (const wt of outcome.worktrees) {
      const playlist = plan.playlists.find((pl) => pl.id === wt.playlistId);
      if (!playlist) { continue; }
      this._playlistCwd.set(playlist.id, wt.path);
      // Tasks reach resolveCwd without their playlist in scope, so map them here.
      for (const task of playlist.tasks) {
        this._taskCwdRoot.set(task.id, wt.path);
      }
    }
    return requested;
  }

  /** Tear down this run's worktrees. Branches are kept — they hold the work. */
  private async releaseIsolation(): Promise<void> {
    if (this._worktrees.length === 0) { return; }
    const repoRoot = this.resolveCwd(undefined);
    const kept = await removeWorktrees(repoRoot, this._worktrees, (args, dir) => this.runGitCommand(args, dir));
    if (kept.length > 0) {
      // git refused to remove these because they still hold uncommitted work.
      // Say where it is rather than letting it disappear from view.
      this.emit('error', new Error(
        'Kept ' + kept.length + ' worktree(s) holding uncommitted work: ' + kept.join(', '),
      ));
    }
    this._worktrees = [];
    this._playlistCwd.clear();
    this._taskCwdRoot.clear();
  }

  private runGitCommand(args: string[], cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.killProcess(proc);
          resolve(null);
        }
      }, GIT_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
      proc.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(code === 0 ? stdout.trim() : null);
        }
      });
    });
  }

  private async captureGitRef(cwd: string): Promise<string | null> {
    const stashRef = await this.runGitCommand(['stash', 'create'], cwd);
    if (stashRef) {
      return stashRef;
    }
    return this.runGitCommand(['rev-parse', 'HEAD'], cwd);
  }

  private async captureGitDiff(ref: string | null, cwd: string): Promise<{ changedFiles: string[]; codeChanges: string }> {
    if (!ref) {
      return { changedFiles: [], codeChanges: '' };
    }
    const nameOnly = await this.runGitCommand(['diff', '--name-only', ref], cwd);
    const diff = await this.runGitCommand(['diff', '--no-color', ref], cwd);
    const changedFiles = nameOnly ? nameOnly.split('\n').filter(f => f.length > 0) : [];
    return { changedFiles, codeChanges: diff || '' };
  }

  private detectTestCommand(cwd: string): string | null {
    const analysis = analyzeProject(cwd);
    if (analysis.testFramework) {
      const commandMap: Record<string, string> = {
        'jest': 'npx jest --passWithNoTests',
        'vitest': 'npx vitest run',
        'mocha': 'npm test',
        'ava': 'npx ava',
        'pytest': 'pytest',
        'go test': 'go test ./...',
        'cargo test': 'cargo test',
      };
      return commandMap[analysis.testFramework] ?? null;
    }
    return analysis.hasTests ? 'npm test' : null;
  }

  private async autoTestAfterTask(
    task: Task,
    playlist: Playlist,
    cwd: string,
    signal: AbortSignal,
    repairCycle: number,
  ): Promise<{ passed: boolean; output: string; repairQueued?: boolean }> {
    const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
    if (!cfg.get<boolean>('autoTest', false)) {
      return { passed: true, output: '' };
    }

    const testCmd = this.detectTestCommand(cwd);
    if (!testCmd) {
      return { passed: true, output: '' };
    }

    this.emit('task-output', task, `\n[Auto-Test] Running: ${testCmd}...\n`, 'stdout');

    const result = await this.runLocalCommand(testCmd, {
      cwd,
      signal,
      onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
    });

    if (result.exitCode === 0) {
      this.emit('task-output', task, '[Auto-Test] Tests passed \u2713\n', 'stdout');
      return { passed: true, output: result.stdout };
    }

    const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
    this.emit('task-output', task, `[Auto-Test] Tests failed (exit ${result.exitCode})\n`, 'stderr');

    // Queue a repair task if we're under the cycle cap and a queue is active
    const MAX_REPAIR_CYCLES = 2;
    if (repairCycle < MAX_REPAIR_CYCLES && this._activeQueue) {
      const repairTask: Task = {
        id: generateId(),
        name: `[Auto-Repair ${repairCycle + 1}/${MAX_REPAIR_CYCLES}] Fix tests after: ${task.name}`,
        prompt: [
          `Tests are failing after the agent completed task: "${task.name}".`,
          ``,
          `TEST FAILURE OUTPUT:`,
          output.slice(-3000),
          ``,
          `INSTRUCTIONS:`,
          `- Fix the production code to make these tests pass.`,
          `- Do NOT modify or delete test files.`,
          `- Focus only on the minimal changes needed to fix the failing assertions.`,
          `- After making changes, verify by reasoning through what each failing test checks.`,
        ].join('\n'),
        type: 'agent',
        engine: task.engine,
        cwd: task.cwd,
        env: task.env,
        status: TaskStatus.Pending,
      };

      this._activeQueue.injectNext(repairTask, playlist, repairCycle + 1);
      this.emit('task-output', task,
        `[Auto-Test] Repair task queued (cycle ${repairCycle + 1}/${MAX_REPAIR_CYCLES}) \u2014 continuing...\n`,
        'stderr');
      return { passed: false, output, repairQueued: true };
    }

    return { passed: false, output };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Emit a live countdown tick every second so the user sees progress during rate-limit waits. */
  private async sleepWithCountdown(task: Task, totalSecs: number): Promise<void> {
    for (let remaining = totalSecs; remaining > 0; remaining--) {
      if (this.isStopping()) { return; }
      this.emit('task-output', task, `\r[Rate Limit] Retrying in ${remaining}s... `, 'stderr');
      await this.sleep(1000);
    }
    this.emit('task-output', task, '\n', 'stderr');
  }

  private isStopping(): boolean {
    return this._state === RunnerState.Stopping;
  }
}
