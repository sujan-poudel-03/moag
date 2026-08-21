// ─── Core data models for Agent Task Player ───

/** Supported agent engine identifiers */
export type EngineId = 'codex' | 'claude' | 'gemini' | 'ollama' | 'custom' | 'copilot' | 'anthropic';

/** Supported expert-role identifiers a plan, playlist, or task may declare */
export type RoleId = 'architect' | 'designer' | 'engineer' | 'reviewer' | 'tester' | 'devops' | 'custom';

/** A named expert role and the charter text injected into the prompt for it */
export interface RoleDefinition {
  id: RoleId;
  name: string;
  charter: string;
}

/** Supported task execution modes */
export type TaskType = 'agent' | 'command' | 'service' | 'check' | 'review' | 'validate' | 'manual' | 'visual-test' | 'deploy' | 'release' | 'monitor';

/** Supported validation targets for cross-platform checks */
export type ValidationTarget = 'web' | 'mobile' | 'desktop' | 'all';

/** Supported validation depth profiles */
export type ValidationProfile = 'quick' | 'pr' | 'full';

/** Token budgets for context discovery/analysis/fix phases */
export interface ContextBudget {
  discoveryTokens: number;
  analysisTokens: number;
  fixTokens: number;
}

/** Plan-level validation defaults and context limits */
export interface ValidationSettings {
  targets: ValidationTarget[];
  profile: ValidationProfile;
  contextBudget: ContextBudget;
}

/** Task-level validation override knobs */
export interface TaskValidationSettings {
  targets?: ValidationTarget[];
  profile?: ValidationProfile;
  contextBudget?: Partial<ContextBudget>;
}

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
  /** Optional expert-role override — falls back to playlist role, then plan.defaultRole */
  role?: RoleId;
  /** Command to run for command/check/service tasks */
  command?: string;
  /** Working directory override relative to workspace root */
  cwd?: string;
  /** Environment variable overrides for local execution */
  env?: Record<string, string>;
  /** Env files to inherit (e.g. [".env.test", ".env.local"]) — merged before task.env */
  inheritEnvFiles?: string[];
  /** When true, scope the verifyCommand to only files changed by this task */
  scopedVerify?: boolean;
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
  /** Per-task timeout override in milliseconds (overrides profile and global setting) */
  timeoutMs?: number;
  /** Number of times to retry on failure (default 0 = no retry) */
  retryCount?: number;
  /** Task IDs that must complete before this task runs */
  dependsOn?: string[];
  /** Skip this task if a referenced task has a specific status */
  skipIf?: { taskId: string; status: TaskStatus };
  /** Consensus mode: run the same task on multiple engines, pick the best result */
  consensus?: { engines: EngineId[]; strategy: 'first-pass' | 'best-diff' };
  /** Optional validation target/profile/budget overrides for validate tasks */
  validation?: TaskValidationSettings;
  /** GitHub issue number this task was generated from (used for two-way sync) */
  sourceIssueNumber?: number;
  /** GitHub repo (owner/repo) for the source issue */
  sourceIssueRepo?: string;
  /** release task: annotated git tag to create after the release command succeeds (e.g. "v1.2.0") */
  releaseTag?: string;
  /** release task: message/notes for the tag and optional GitHub release */
  releaseNotes?: string;
  /** release task: when true, push the tag and create a GitHub release via gh */
  githubRelease?: boolean;
  /** monitor task: number of health samples to take (default 3) */
  monitorSamples?: number;
  /** monitor task: delay between samples in ms (default 2000) */
  monitorIntervalMs?: number;
  /** monitor task: failed-sample count that constitutes an incident (default 1) */
  failureThreshold?: number;
  /** monitor task: repo (owner/repo) to file an incident issue into on breach */
  incidentRepo?: string;
  /** monitor task: label applied to filed incident issues (default "moag:incident") */
  incidentLabel?: string;
  /** Runtime status (not persisted in the plan file) */
  status: TaskStatus;
}

/** A playlist (analogous to an "epoch") — an ordered group of tasks */
export interface Playlist {
  id: string;
  name: string;
  /** Default engine for tasks in this playlist */
  engine?: EngineId;
  /** Default expert role for tasks in this playlist — overridden per task */
  role?: RoleId;
  /** Whether to automatically advance to the next task */
  autoplay: boolean;
  /** Delay between tasks in ms (overrides global setting) */
  autoplayDelay?: number;
  /** Run all tasks in this playlist concurrently */
  parallel?: boolean;
  /** Freeform rules/guidelines injected before every task in this playlist (merges with plan-level and global rules) */
  aiRules?: string;
  /** When true, this playlist represents the test/verification phase of a PRD workflow */
  testPhase?: boolean;
  /** The PRD snippet that generated this playlist */
  prdContext?: string;
  tasks: Task[];
}

/**
 * Optional sandbox configuration — overrides auto-detection.
 * Useful for monorepos where the root package.json doesn't represent any runnable app.
 *
 * Example for a monorepo with separate frontend and backend:
 *   "sandbox": { "targets": [
 *     { "name": "Frontend", "cwd": "apps/web", "command": "npm run dev", "port": 3000 },
 *     { "name": "Backend",  "cwd": "apps/api", "command": "npm run dev", "port": 4000 }
 *   ]}
 */
export interface SandboxTarget {
  /** Display label for this target (e.g. "Frontend", "API") */
  name: string;
  /** Path relative to workspace root where the dev command runs (defaults to the workspace root) */
  cwd?: string;
  /** Shell command to start the dev server (e.g. "npm run dev") */
  command: string;
  /** Expected port so MOAG can detect readiness and build the URL */
  port?: number;
}

export interface SandboxConfig {
  /** Explicit list of apps/services to start. When provided, auto-detection is skipped. */
  targets?: SandboxTarget[];
  /** Shorthand: a single command at the workspace root (overrides auto-detection) */
  command?: string;
  /** Port for the shorthand single-command target */
  port?: number;
}

/** A saved snapshot of a PRD at a specific version */
export interface PrdVersion {
  version: string;
  text: string;
  createdAt: string;
}

/** Top-level plan file structure */
export interface Plan {
  /** Schema version for forward compatibility */
  version: string;
  name: string;
  description?: string;
  /** Global default engine */
  defaultEngine: EngineId;
  /** Backup engine to switch to when the primary hits a rate limit */
  fallbackEngine?: EngineId;
  /** User-defined variables for template substitution in prompts */
  variables?: Record<string, string>;
  /** Plan-wide default expert role — the last link in the task → playlist → plan chain */
  defaultRole?: RoleId;
  /** Project-specific role definitions; override built-in roles by id */
  customRoles?: RoleDefinition[];
  /** Validation defaults (targets/profile/budget) used by validation-aware tasks */
  validation: ValidationSettings;
  /** Optional sandbox configuration — overrides project auto-detection */
  sandbox?: SandboxConfig;
  /** Freeform rules/guidelines injected before every task in this plan (merges with global/workspace rules) */
  aiRules?: string;
  /** Full original PRD text from which this plan was generated */
  prdSource?: string;
  /** Version history of the PRD — each entry is a snapshot saved by the user */
  prdVersions?: PrdVersion[];
  /** Number of fix-iteration playlists generated so far (iteration guard ceiling: 3) */
  fixIterations?: number;
  /** GitHub issues this plan was generated from — used to close them after successful completion */
  sourceIssues?: Array<{ repo: string; number: number; title: string }>;
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

/** Result of an AI-driven PRD verification pass */
export interface PrdVerificationResult {
  passed: boolean;
  score: number;
  gaps: string[];
  suggestion: string;
}

/** Result of a verification command */
export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
  passed: boolean;
  /** True when this was the baseline (pre-agent) verification run */
  baselinePassed?: boolean;
  /** True when the baseline was already broken before the agent ran — task is not at fault */
  baselineBroken?: boolean;
}

/** Artifact evidence recorded for a task run */
export interface TaskArtifact {
  /** File path or logical target name */
  target: string;
  exists: boolean;
  resolvedPath?: string;
  /** Validation target platform that produced this artifact */
  validationTarget?: 'web' | 'mobile' | 'desktop';
  /** Which stage produced this artifact */
  stage?: 'lint' | 'unit' | 'integration' | 'e2e';
  /** Outcome of this stage — 'pass', 'fail', or 'skip' */
  stageStatus?: 'pass' | 'fail' | 'skip';
  /** Stage execution duration in milliseconds */
  durationMs?: number;
  /** Screenshot file paths captured during this stage */
  screenshots?: string[];
  /** Trace file paths (e.g. Playwright .zip traces) */
  traces?: string[];
  /** Log file paths captured during execution */
  logs?: string[];
  /** Short failure summary for quick diagnosis */
  failureSummary?: string;
  /** Whether this artifact came from a flaky test run (passed after retry) */
  flaky?: boolean;
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
  /** Whether this task was auto-fixed after initial failure */
  autoFixed?: boolean;
  /** Per-target pass/fail/skip breakdown for validate tasks */
  validationTargetResults?: Array<{
    target: 'web' | 'mobile' | 'desktop';
    /** 'pass' | 'fail' | 'skip' */
    status: 'pass' | 'fail' | 'skip';
    stagesPassed: number;
    stagesFailed: number;
    durationMs: number;
    summary: string;
  }>;
  /** Total flaky detections across all validation targets in this run */
  flakyCount?: number;
  /** Rule-based compressed summary of what this task accomplished (~250 chars, set after completion) */
  summary?: string;
  /** Context budget usage for this task execution */
  contextBudgetUsage?: {
    totalCharsUsed: number;
    totalCharsBudget: number;
    sectionsDropped: number;
    usedSemanticRetrieval: boolean;
    semanticSpansReturned: number;
    sectionBreakdown?: Record<string, number>;
  };
  /** Token consumption for this task (input + output) */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  /** Snapshot of context settings active during this task — enables reproducibility analysis */
  contextSettingsSnapshot?: {
    maxContextChars: number;
    maxFileContextChars: number;
    maxPriorTasks: number;
    maxOutputPerTask: number;
    planOverview: boolean;
    priorTaskOutputs: boolean;
    relevantFiles: boolean;
  };
}

/** Serializable plan file format (status fields stripped) */
export interface PlanFile {
  version: string;
  name: string;
  description?: string;
  defaultEngine: EngineId;
  /** Backup engine to switch to when the primary hits a rate limit */
  fallbackEngine?: EngineId;
  /** User-defined variables for template substitution in prompts */
  variables?: Record<string, string>;
  /** Plan-wide default expert role */
  defaultRole?: RoleId;
  /** Project-specific role definitions; override built-in roles by id */
  customRoles?: RoleDefinition[];
  /** GitHub issues this plan was generated from */
  sourceIssues?: Array<{ repo: string; number: number; title: string }>;
  /** Full original PRD text from which this plan was generated */
  prdSource?: string;
  /** Freeform rules/guidelines injected before every task in this plan */
  aiRules?: string;
  /** Version history of the PRD — each entry is a snapshot saved by the user */
  prdVersions?: PrdVersion[];
  /** Number of fix-iteration playlists generated so far */
  fixIterations?: number;
  /** Optional sandbox configuration — overrides project auto-detection */
  sandbox?: SandboxConfig;
  /** Optional plan-level validation defaults */
  validation?: {
    targets?: ValidationTarget[];
    profile?: ValidationProfile;
    contextBudget?: Partial<ContextBudget>;
  };
  playlists: PlanFilePlaylist[];
}

export interface PlanFilePlaylist {
  id: string;
  name: string;
  engine?: EngineId;
  role?: RoleId;
  autoplay: boolean;
  autoplayDelay?: number;
  parallel?: boolean;
  aiRules?: string;
  testPhase?: boolean;
  /** PRD slice relevant to this playlist's tasks — used by per-version verify */
  prdContext?: string;
  tasks: PlanFileTask[];
}

export interface PlanFileTask {
  id: string;
  name: string;
  prompt: string;
  type?: TaskType;
  engine?: EngineId;
  role?: RoleId;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  inheritEnvFiles?: string[];
  scopedVerify?: boolean;
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
  /** Per-task timeout override in milliseconds (overrides profile and global setting) */
  timeoutMs?: number;
  retryCount?: number;
  dependsOn?: string[];
  /** Skip this task if a referenced task has a specific status */
  skipIf?: { taskId: string; status: string };
  /** Consensus mode: run the same task on multiple engines, pick the best result */
  consensus?: { engines: EngineId[]; strategy: 'first-pass' | 'best-diff' };
  /** Optional validation target/profile/budget overrides */
  validation?: TaskValidationSettings;
  /** GitHub issue number this task was generated from */
  sourceIssueNumber?: number;
  /** GitHub repo (owner/repo) for the source issue */
  sourceIssueRepo?: string;
  /** release task fields */
  releaseTag?: string;
  releaseNotes?: string;
  githubRelease?: boolean;
  /** monitor task fields */
  monitorSamples?: number;
  monitorIntervalMs?: number;
  failureThreshold?: number;
  incidentRepo?: string;
  incidentLabel?: string;
  /** Persisted execution status (omitted or 'pending' means not yet run) */
  status?: string;
}
