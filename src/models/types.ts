// ─── Core data models for Agent Task Player ───

/** Supported agent engine identifiers */
export type EngineId = 'codex' | 'claude' | 'gemini' | 'ollama' | 'custom';

/** Supported task execution modes */
export type TaskType = 'agent' | 'command' | 'service' | 'check';

/** How the runner should react when a task fails */
export type FailurePolicy = 'stop' | 'continue' | 'mark-blocked';

/** Status of a task in the execution lifecycle */
export enum TaskStatus {
  Pending = 'pending',
  Running = 'running',
  Paused = 'paused',
  Completed = 'completed',
  Failed = 'failed',
  Skipped = 'skipped',
  Blocked = 'blocked',
}

/** Status of the overall runner state machine */
export enum RunnerState {
  Idle = 'idle',
  Playing = 'playing',
  Paused = 'paused',
  Stopping = 'stopping',
}

/** A single task (analogous to a "song") */
export interface Task {
  id: string;
  name: string;
  prompt: string;
  /** Execution mode for this task */
  type?: TaskType;
  /** Optional engine override — falls back to playlist/global default */
  engine?: EngineId;
  /** Command to run for command/check/service tasks */
  command?: string;
  /** Working directory override relative to workspace root */
  cwd?: string;
  /** Environment variable overrides for local execution */
  env?: Record<string, string>;
  /** File references to include as context */
  files?: string[];
  /** Success criteria shown in the dashboard and checked by the operator */
  acceptanceCriteria?: string[];
  /** Optional shell command to verify the task result */
  verifyCommand?: string;
  /** Files or outputs expected after the task completes */
  expectedArtifacts?: string[];
  /** Owner guidance or review notes */
  ownerNote?: string;
  /** How to handle failures for this task */
  failurePolicy?: FailurePolicy;
  /** Port that should be opened by a service/check task */
  port?: number;
  /** Regex/text that indicates a background service is ready */
  readyPattern?: string;
  /** HTTP endpoint to probe for service readiness */
  healthCheckUrl?: string;
  /** Startup timeout override for service tasks */
  startupTimeoutMs?: number;
  /** Number of times to retry on failure (default 0 = no retry) */
  retryCount?: number;
  /** Task IDs that must complete before this task runs */
  dependsOn?: string[];
  /** Runtime status (not persisted in the plan file) */
  status: TaskStatus;
}

/** A playlist (analogous to an "epoch") — an ordered group of tasks */
export interface Playlist {
  id: string;
  name: string;
  /** Default engine for tasks in this playlist */
  engine?: EngineId;
  /** Whether to automatically advance to the next task */
  autoplay: boolean;
  /** Delay between tasks in ms (overrides global setting) */
  autoplayDelay?: number;
  /** Run all tasks in this playlist concurrently */
  parallel?: boolean;
  tasks: Task[];
}

/** Top-level plan file structure */
export interface Plan {
  /** Schema version for forward compatibility */
  version: string;
  name: string;
  description?: string;
  /** Global default engine */
  defaultEngine: EngineId;
  playlists: Playlist[];
}

/** Result returned by an engine adapter after running a task */
export interface EngineResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Human-readable execution summary */
  summary?: string;
  /** Token usage stats (when available from the engine) */
  tokenUsage?: TokenUsage;
  /** The CLI command that was executed (without the prompt body) */
  command?: string;
}

/** Token/cost tracking for a single task execution */
export interface TokenUsage {
  /** Number of tokens in the prompt */
  inputTokens?: number;
  /** Number of tokens in the response */
  outputTokens?: number;
  /** Total tokens (input + output) */
  totalTokens?: number;
  /** Estimated cost in USD (if computable) */
  estimatedCost?: number;
}

/** Result of a verification command */
export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
  passed: boolean;
}

/** Artifact evidence recorded for a task run */
export interface TaskArtifact {
  target: string;
  exists: boolean;
  resolvedPath?: string;
}

/** A single entry in the execution history log */
export interface HistoryEntry {
  id: string;
  taskId: string;
  taskName: string;
  playlistId: string;
  playlistName: string;
  engine: EngineId;
  taskType?: TaskType;
  prompt: string;
  result: EngineResult;
  status: TaskStatus;
  /** ISO timestamp of when execution started */
  startedAt: string;
  /** ISO timestamp of when execution ended */
  finishedAt: string;
  /** List of files changed during task execution (from git diff) */
  changedFiles?: string[];
  /** Unified diff of code changes made during task execution */
  codeChanges?: string;
  verification?: VerificationResult;
  artifacts?: TaskArtifact[];
  failurePolicy?: FailurePolicy;
  ownerNote?: string;
  /** Groups related turns; first entry uses threadId = id */
  threadId?: string;
  /** 0 = original, 1 = first reply, etc. */
  turnIndex?: number;
  /** Groups entries from the same runner.play() invocation */
  runId?: string;
  /** Which model was used (e.g., "claude-sonnet-4") */
  modelId?: string;
  /** Why this model was selected by auto-selection */
  modelReason?: string;
}

/** Serializable plan file format (status fields stripped) */
export interface PlanFile {
  version: string;
  name: string;
  description?: string;
  defaultEngine: EngineId;
  playlists: PlanFilePlaylist[];
}

export interface PlanFilePlaylist {
  id: string;
  name: string;
  engine?: EngineId;
  autoplay: boolean;
  autoplayDelay?: number;
  parallel?: boolean;
  tasks: PlanFileTask[];
}

export interface PlanFileTask {
  id: string;
  name: string;
  prompt: string;
  type?: TaskType;
  engine?: EngineId;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  files?: string[];
  acceptanceCriteria?: string[];
  verifyCommand?: string;
  expectedArtifacts?: string[];
  ownerNote?: string;
  failurePolicy?: FailurePolicy;
  port?: number;
  readyPattern?: string;
  healthCheckUrl?: string;
  startupTimeoutMs?: number;
  retryCount?: number;
  dependsOn?: string[];
  /** Persisted execution status (omitted or 'pending' means not yet run) */
  status?: string;
}
