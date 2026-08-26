// ─── Run session store — tracks plan execution runs using VS Code memento API ───

import * as vscode from 'vscode';
import { ContextBudget, EngineId, ValidationProfile, ValidationTarget } from './types';

/** Run-level artifact evidence linking a produced file/resource back to a task */
export interface RunArtifact {
  taskId: string;
  taskName: string;
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

export interface RunSession {
  id: string;
  planName: string;
  planPath?: string;
  startedAt: string;
  finishedAt?: string;
  engines: EngineId[];
  taskCount: number;
  tasksCompleted: number;
  tasksFailed: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  validationProfile?: ValidationProfile;
  validationTargets?: ValidationTarget[];
  contextBudget?: ContextBudget;
  contextTokensUsed?: Partial<ContextBudget>;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** Artifact evidence collected across all tasks in this run */
  artifacts?: RunArtifact[];
}

const STORAGE_KEY = 'agentTaskPlayer.runSessions';
const MAX_SESSIONS = 50;
const MAX_PLAN_NAME_CHARS = 160;
const MAX_ARTIFACTS_PER_SESSION = 200;

export class RunSessionStore {
  private _sessions: RunSession[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly storage: vscode.Memento) {
    this._sessions = storage.get<RunSession[]>(STORAGE_KEY, [])
      .map((session) => this.sanitizeSession(session));
    this.trim();
    this.trimByStorageBytes();
    this.persist();
  }

  /** Create a new run session */
  create(session: RunSession): void {
    this._sessions.push(this.sanitizeSession(session));
    this.trim();
    this.trimByStorageBytes();
    this.persist();
    this._onDidChange.fire();
  }

  /** Update an existing session by id */
  update(id: string, partial: Partial<RunSession>): void {
    const idx = this._sessions.findIndex(s => s.id === id);
    if (idx === -1) { return; }
    this._sessions[idx] = this.sanitizeSession({ ...this._sessions[idx], ...partial });
    this.trimByStorageBytes();
    this.persist();
    this._onDidChange.fire();
  }

  /** Get a session by id */
  get(id: string): RunSession | undefined {
    return this._sessions.find(s => s.id === id);
  }

  /** Get all sessions (newest first) */
  getAll(): RunSession[] {
    return [...this._sessions].reverse();
  }

  /** Delete a session by id */
  delete(id: string): void {
    this._sessions = this._sessions.filter(s => s.id !== id);
    this.persist();
    this._onDidChange.fire();
  }

  /** Clear all sessions */
  clear(): void {
    this._sessions = [];
    this.persist();
    this._onDidChange.fire();
  }

  /** Trim oldest sessions when exceeding max */
  private trim(): void {
    if (this._sessions.length > MAX_SESSIONS) {
      this._sessions = this._sessions.slice(this._sessions.length - MAX_SESSIONS);
    }
  }

  private trimByStorageBytes(): void {
    const maxBytes = this.getMaxSessionStorageBytes();
    while (this._sessions.length > 0 && this.getSerializedBytes(this._sessions) > maxBytes) {
      this._sessions.shift();
    }
  }

  private getSerializedBytes(entries: RunSession[]): number {
    try {
      return Buffer.byteLength(JSON.stringify(entries), 'utf8');
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private getMaxSessionStorageBytes(): number {
    return vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<number>('maxRunSessionStorageBytes', 200_000);
  }

  private sanitizeSession(session: RunSession): RunSession {
    const safePlanName = (session.planName || '').slice(0, MAX_PLAN_NAME_CHARS);
    const artifacts = session.artifacts
      ? session.artifacts.slice(0, MAX_ARTIFACTS_PER_SESSION).map(a => ({
          ...a,
          target: a.target.slice(0, 260),
          resolvedPath: a.resolvedPath?.slice(0, 260),
          failureSummary: a.failureSummary?.slice(0, 500),
          screenshots: a.screenshots?.slice(0, 20).map(p => p.slice(0, 260)),
          traces: a.traces?.slice(0, 10).map(p => p.slice(0, 260)),
          logs: a.logs?.slice(0, 20).map(p => p.slice(0, 260)),
        }))
      : undefined;
    return {
      ...session,
      planName: safePlanName || 'Untitled',
      engines: Array.isArray(session.engines) ? session.engines.slice(0, 8) : [],
      validationTargets: session.validationTargets?.slice(0, 4),
      artifacts,
    };
  }

  private persist(): void {
    void Promise.resolve(this.storage.update(STORAGE_KEY, this._sessions)).catch(() => {
      // Fallback path under storage pressure.
      this._sessions = this._sessions.slice(-10);
      void this.storage.update(STORAGE_KEY, this._sessions);
    });
  }
}
