// ─── Run session store — tracks plan execution runs using VS Code memento API ───

import * as vscode from 'vscode';
import { ContextBudget, EngineId, ValidationProfile, ValidationTarget } from './types';

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
}

const STORAGE_KEY = 'agentTaskPlayer.runSessions';
const MAX_SESSIONS = 50;
const MAX_PLAN_NAME_CHARS = 160;

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
      .get<number>('maxRunSessionStorageBytes', 800_000);
  }

  private sanitizeSession(session: RunSession): RunSession {
    const safePlanName = (session.planName || '').slice(0, MAX_PLAN_NAME_CHARS);
    return {
      ...session,
      planName: safePlanName || 'Untitled',
      engines: Array.isArray(session.engines) ? session.engines.slice(0, 8) : [],
      validationTargets: session.validationTargets?.slice(0, 4),
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
