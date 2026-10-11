// ─── Host agent: shared shapes ───
//
// `moag host` runs project branches as live environments on this machine, puts a gateway in front
// of them that only lets workspace members in (checked with ONOSOO), and reports what it runs.
// docs/host-agent.md explains the whole; ONOSOO's docs/builds/PROTOCOL.md §2–3 is the contract.
//
// Imports nothing at runtime; never vscode.

/** The approved-projects loader's result (src/headless/onosoo-projects.ts owns the loader). */
export interface ApprovedProjectsResult {
  remoteStart: boolean;
  dailyBudgetUsd: number | null;
  projects: { id: string; name: string; path: string; kinds?: string[] }[];
  errors: string[];
}

/** Injected so the host agent and its tests never depend on where the loader lives. */
export type ProjectsLoader = (stateDir: string) => ApprovedProjectsResult;

export type ServiceRole = 'web' | 'api' | 'db' | 'worker' | 'other';
export type ServiceState = 'running' | 'starting' | 'restarting' | 'exited' | 'dead';
export type ServiceHealth = 'healthy' | 'unhealthy' | 'starting' | 'unknown';
export type EnvStatus = 'starting' | 'running' | 'unhealthy' | 'stopped' | 'failed';

export interface ServiceSnapshot {
  name: string;
  role: ServiceRole;
  state: ServiceState;
  health: ServiceHealth;
}

/** What the agent remembers about one environment (persisted in <stateDir>/host/state.json). */
export interface EnvRecord {
  key: string;
  projectId: string;
  projectName: string;
  branch: string;
  /** The MOAG run that produced the branch, when ONOSOO or MOAG said so. */
  runKey: string | null;
  /** Loopback port the web service is published on, for the gateway. */
  port: number;
  worktree: string;
  /** The compose file the stack was started from (absolute). */
  composeFile: string;
  /** Service name → role, from the recipe plus anything else the compose file defines. */
  roles: Record<string, ServiceRole>;
  /** The web service and its container port; null when the project has no web service. */
  web: { service: string; port: number } | null;
  /** What a person last asked for. The agent never restarts what someone stopped. */
  desired: 'running' | 'stopped';
  status: EnvStatus;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  /** Last proxied request through the gateway: what the idle stop measures. */
  lastAccessAt: string;
}

/** One command ONOSOO queued for this machine. */
export interface HostCommand {
  id: string;
  kind: 'env-start' | 'env-stop' | 'env-restart' | 'env-reset-db';
  payload: Record<string, unknown>;
  requested_by: string | null;
}

export type CommandOutcome =
  | { status: 'succeeded' | 'failed' | 'rejected'; message: string }
  | { status: 'running'; message: string };
