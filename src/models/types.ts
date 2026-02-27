// ─── Core data models for Agent Task Player ───

/** Supported agent engine identifiers */
export type EngineId = 'codex' | 'claude' | 'gemini' | 'ollama' | 'custom';

/** Status of a task in the execution lifecycle */
export enum TaskStatus {
  Pending = 'pending',
  Running = 'running',
  Paused = 'paused',
  Completed = 'completed',
  Failed = 'failed',
  Skipped = 'skipped',
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
  /** Optional engine override — falls back to playlist/global default */
  engine?: EngineId;
  /** Working directory override relative to workspace root */
  cwd?: string;
  /** File references to include as context */
  files?: string[];
  /** Optional shell command to verify the task result */
  verifyCommand?: string;
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

/** A single entry in the execution history log */
export interface HistoryEntry {
  id: string;
  taskId: string;
  taskName: string;
  playlistId: string;
  playlistName: string;
  engine: EngineId;
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
  /** Groups related turns; first entry uses threadId = id */
  threadId?: string;
  /** 0 = original, 1 = first reply, etc. */
  turnIndex?: number;
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
  engine?: EngineId;
  cwd?: string;
  files?: string[];
  verifyCommand?: string;
  retryCount?: number;
  dependsOn?: string[];
}
