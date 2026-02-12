// ─── History store — persists task execution results using VS Code memento API ───

import * as vscode from 'vscode';
import { HistoryEntry } from '../models/types';

const HISTORY_KEY = 'agentTaskPlayer.history';

export class HistoryStore {
  private _entries: HistoryEntry[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly storage: vscode.Memento) {
    this._entries = storage.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  /** Get all history entries (newest first) */
  getAll(): HistoryEntry[] {
    return [...this._entries].reverse();
  }

  /** Get entries for a specific task */
  getForTask(taskId: string): HistoryEntry[] {
    return this._entries.filter(e => e.taskId === taskId).reverse();
  }

  /** Get entries for a specific playlist */
  getForPlaylist(playlistId: string): HistoryEntry[] {
    return this._entries.filter(e => e.playlistId === playlistId).reverse();
  }

  /** Add a new history entry */
  add(entry: HistoryEntry): void {
    this._entries.push(entry);
    this.trim();
    this.persist();
    this._onDidChange.fire();
  }

  /** Clear all history */
  clear(): void {
    this._entries = [];
    this.persist();
    this._onDidChange.fire();
  }

  /** Trim to max entries */
  private trim(): void {
    const max = vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<number>('maxHistoryEntries', 200);
    if (this._entries.length > max) {
      this._entries = this._entries.slice(this._entries.length - max);
    }
  }

  private persist(): void {
    this.storage.update(HISTORY_KEY, this._entries);
  }
}
