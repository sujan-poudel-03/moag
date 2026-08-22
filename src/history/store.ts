// ─── History store — persists task execution results using VS Code memento API ───

import * as vscode from 'vscode';
import { HistoryEntry } from '../models/types';

const HISTORY_KEY = 'agentTaskPlayer.history';
const TRUNCATED_SUFFIX = '\n...[truncated for storage]';

export class HistoryStore {
  private _entries: HistoryEntry[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly storage: vscode.Memento) {
    this._entries = storage.get<HistoryEntry[]>(HISTORY_KEY, [])
      .map((entry) => this.sanitizeEntry(entry));
    this.trim();
    this.trimByStorageBytes();
    this.persist();
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

  /** Add a new history entry (truncates large outputs before persisting) */
  add(entry: HistoryEntry): void {
    this._entries.push(this.sanitizeEntry(entry));
    this.trim();
    this.trimByStorageBytes();
    this.persist();
    this._onDidChange.fire();
  }

  /** Get all entries in a thread, sorted by startedAt ascending */
  getThread(threadId: string): HistoryEntry[] {
    return this._entries
      .filter(e => (e.threadId ?? e.id) === threadId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Get the most recent entry per unique thread, sorted newest first */
  getThreadHeads(): HistoryEntry[] {
    const headMap = new Map<string, HistoryEntry>();
    for (const entry of this._entries) {
      const tid = entry.threadId ?? entry.id;
      const existing = headMap.get(tid);
      if (!existing || entry.startedAt > existing.startedAt) {
        headMap.set(tid, entry);
      }
    }
    return [...headMap.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Delete all entries belonging to a thread */
  deleteThread(threadId: string): void {
    this._entries = this._entries.filter(e => (e.threadId ?? e.id) !== threadId);
    this.persist();
    this._onDidChange.fire();
  }

  /** Get all entries from a specific run */
  getForRun(runId: string): HistoryEntry[] {
    return this._entries.filter(e => e.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
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

  /**
   * Keep persisted history safely below VS Code memento limits.
   * Drops oldest entries until serialized payload fits configured budget.
   */
  private trimByStorageBytes(): void {
    const maxBytes = this.getMaxHistoryStorageBytes();
    while (this._entries.length > 0 && this.getSerializedBytes(this._entries) > maxBytes) {
      this._entries.shift();
    }
  }

  private getSerializedBytes(entries: HistoryEntry[]): number {
    try {
      return Buffer.byteLength(JSON.stringify(entries), 'utf8');
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private getMaxHistoryStorageBytes(): number {
    // Must match the declared default in package.json. It did not: the manifest
    // says 400_000 while this fell back to 3_000_000, and the fallback is what
    // headless actually hits — the shim reads .moag/config.json, which usually
    // has no such key. So the CLI kept 7.5x the history VS Code did, silently.
    return vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<number>('maxHistoryStorageBytes', 400_000);
  }

  private sanitizeEntry(entry: HistoryEntry): HistoryEntry {
    const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
    const maxOutputChars = cfg.get<number>('maxStoredOutputChars', 4_000);
    const maxPromptChars = cfg.get<number>('maxStoredPromptChars', 2_000);
    const maxCodeChangesChars = cfg.get<number>('maxStoredCodeChangesChars', 4_000);
    const maxVerificationChars = cfg.get<number>('maxStoredVerificationChars', 4_000);
    const maxChangedFiles = cfg.get<number>('maxStoredChangedFiles', 300);
    const maxArtifacts = cfg.get<number>('maxStoredArtifacts', 150);

    const changedFiles = entry.changedFiles
      ? entry.changedFiles.slice(0, maxChangedFiles).map((f) => this.clampText(f, 260))
      : undefined;
    const artifacts = entry.artifacts
      ? entry.artifacts.slice(0, maxArtifacts).map(a => ({
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
      ...entry,
      prompt: this.clampText(entry.prompt, maxPromptChars),
      result: {
        ...entry.result,
        stdout: this.clampText(entry.result.stdout, maxOutputChars),
        stderr: this.clampText(entry.result.stderr, maxOutputChars),
      },
      codeChanges: this.clampOptionalText(entry.codeChanges, maxCodeChangesChars),
      verification: entry.verification
        ? {
          ...entry.verification,
          output: this.clampText(entry.verification.output, maxVerificationChars),
        }
        : undefined,
      changedFiles,
      artifacts,
    };
  }

  private clampOptionalText(value: string | undefined, maxChars: number): string | undefined {
    if (typeof value !== 'string') {
      return value;
    }
    return this.clampText(value, maxChars);
  }

  private clampText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }
    return value.slice(0, maxChars) + TRUNCATED_SUFFIX;
  }

  private persist(): void {
    void Promise.resolve(this.storage.update(HISTORY_KEY, this._entries)).catch(() => {
      // Fallback path when storage is under pressure: keep fewer recent entries and retry once.
      this._entries = this._entries.slice(-20);
      void this.storage.update(HISTORY_KEY, this._entries);
    });
  }
}
