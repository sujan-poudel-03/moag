// ─── Run session store — tracks plan execution runs using VS Code memento API ───

import * as vscode from 'vscode';
import { EngineId } from './types';

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
  status: 'running' | 'completed' | 'failed' | 'stopped';
}

const STORAGE_KEY = 'agentTaskPlayer.runSessions';
const MAX_SESSIONS = 50;

export class RunSessionStore {
  private _sessions: RunSession[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly storage: vscode.Memento) {
    this._sessions = storage.get<RunSession[]>(STORAGE_KEY, []);
  }

  /** Create a new run session */
  create(session: RunSession): void {
    this._sessions.push(session);
    this.trim();
    this.persist();
    this._onDidChange.fire();
  }

  /** Update an existing session by id */
  update(id: string, partial: Partial<RunSession>): void {
    const idx = this._sessions.findIndex(s => s.id === id);
    if (idx === -1) { return; }
    this._sessions[idx] = { ...this._sessions[idx], ...partial };
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

  private persist(): void {
    this.storage.update(STORAGE_KEY, this._sessions);
  }
}
