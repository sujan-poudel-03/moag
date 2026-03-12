// ─── Sessions TreeView provider ───
// Sidebar tree showing run sessions and conversation threads, inspired by
// Copilot Chat sessions / Codex tasks / Claude Code conversations panels.

import * as vscode from 'vscode';
import { HistoryEntry, EngineId, TaskStatus } from '../models/types';
import { HistoryStore } from '../history/store';
import { RunSession, RunSessionStore } from '../models/run-session';
import { getModelSpec } from '../models/model-specs';

// ─── Tree item types ───

type SessionsNodeKind = 'running-group' | 'sessions-group' | 'conversations-group'
  | 'session' | 'thread';

export class SessionsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: SessionsNodeKind,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly session?: RunSession,
    public readonly threadHead?: HistoryEntry,
  ) {
    super(label, collapsible);
  }
}

// ─── Provider ───

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionsTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionsTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _filter = '';

  constructor(
    private readonly historyStore: HistoryStore,
    private readonly runSessionStore: RunSessionStore,
  ) {
    historyStore.onDidChange(() => this.refresh());
    runSessionStore.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  setFilter(filter: string): void {
    this._filter = filter.toLowerCase();
    this.refresh();
  }

  getTreeItem(element: SessionsTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionsTreeItem): SessionsTreeItem[] {
    if (!element) {
      return this._getRootNodes();
    }

    switch (element.kind) {
      case 'running-group':
        return this._getRunningSessionNodes();
      case 'sessions-group':
        return this._getPastSessionNodes();
      case 'conversations-group':
        return this._getThreadNodes();
      default:
        return [];
    }
  }

  // ─── Root groups ───

  private _getRootNodes(): SessionsTreeItem[] {
    const roots: SessionsTreeItem[] = [];
    const sessions = this.runSessionStore.getAll();
    const runningSessions = sessions.filter(s => s.status === 'running');
    const pastSessions = sessions.filter(s => s.status !== 'running');
    const threads = this.historyStore.getThreadHeads();

    if (runningSessions.length > 0) {
      const item = new SessionsTreeItem(
        'running-group',
        `Running (${runningSessions.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon('pulse', new vscode.ThemeColor('testing.iconPassed'));
      roots.push(item);
    }

    if (pastSessions.length > 0) {
      const item = new SessionsTreeItem(
        'sessions-group',
        `Sessions (${pastSessions.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon('history');
      roots.push(item);
    }

    if (threads.length > 0) {
      const item = new SessionsTreeItem(
        'conversations-group',
        `Conversations (${threads.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      roots.push(item);
    }

    if (roots.length === 0) {
      const empty = new SessionsTreeItem(
        'sessions-group',
        'No sessions yet',
        vscode.TreeItemCollapsibleState.None,
      );
      empty.description = 'Run a task to get started';
      empty.iconPath = new vscode.ThemeIcon('info');
      roots.push(empty);
    }

    return roots;
  }

  // ─── Session nodes ───

  private _getRunningSessionNodes(): SessionsTreeItem[] {
    return this.runSessionStore.getAll()
      .filter(s => s.status === 'running')
      .filter(s => !this._filter || s.planName.toLowerCase().includes(this._filter))
      .map(s => this._buildSessionNode(s));
  }

  private _getPastSessionNodes(): SessionsTreeItem[] {
    return this.runSessionStore.getAll()
      .filter(s => s.status !== 'running')
      .filter(s => !this._filter || s.planName.toLowerCase().includes(this._filter))
      .slice(0, 30)
      .map(s => this._buildSessionNode(s));
  }

  private _buildSessionNode(session: RunSession): SessionsTreeItem {
    const progress = session.taskCount > 0
      ? `${session.tasksCompleted}/${session.taskCount}`
      : '0/0';

    const item = new SessionsTreeItem(
      'session',
      session.planName,
      vscode.TreeItemCollapsibleState.None,
      session,
    );

    // Status icon
    const iconId = session.status === 'running' ? 'sync~spin'
      : session.status === 'completed' ? 'check'
      : session.status === 'failed' ? 'error'
      : 'debug-stop';
    const iconColor = session.status === 'running' ? 'testing.iconQueued'
      : session.status === 'completed' ? 'testing.iconPassed'
      : session.status === 'failed' ? 'testing.iconFailed'
      : 'descriptionForeground';
    item.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor(iconColor));

    // Description: tasks + cost
    const costStr = session.totalCost > 0 ? ` | $${session.totalCost.toFixed(2)}` : '';
    const engines = session.engines.join(', ');
    item.description = `${progress} tasks | ${engines}${costStr}`;

    // Tooltip
    const duration = session.finishedAt
      ? formatDurationMs(new Date(session.finishedAt).getTime() - new Date(session.startedAt).getTime())
      : 'running...';
    item.tooltip = new vscode.MarkdownString(
      `**${session.planName}**\n\n` +
      `Status: ${session.status}\n\n` +
      `Tasks: ${session.tasksCompleted}/${session.taskCount} (${session.tasksFailed} failed)\n\n` +
      `Engines: ${engines}\n\n` +
      `Duration: ${duration}\n\n` +
      `Tokens: ${session.totalTokensIn.toLocaleString()} in / ${session.totalTokensOut.toLocaleString()} out\n\n` +
      `Cost: $${session.totalCost.toFixed(4)}`
    );

    item.contextValue = 'session';
    item.command = {
      command: 'agentTaskPlayer.openSession',
      title: 'Open Session',
      arguments: [session],
    };

    return item;
  }

  // ─── Thread nodes ───

  private _getThreadNodes(): SessionsTreeItem[] {
    return this.historyStore.getThreadHeads()
      .filter(h => !this._filter || h.taskName.toLowerCase().includes(this._filter))
      .slice(0, 30)
      .map(head => {
        const tid = head.threadId ?? head.id;
        const item = new SessionsTreeItem(
          'thread',
          head.taskName,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          head,
        );

        // Engine-colored icon
        const iconId = head.status === TaskStatus.Completed ? 'comment' : 'comment-draft';
        item.iconPath = new vscode.ThemeIcon(iconId);

        // Description
        const modelSpec = head.modelId ? getModelSpec(head.modelId) : null;
        const modelLabel = modelSpec?.displayName ?? head.engine;
        const ago = timeAgo(head.startedAt);
        item.description = `${modelLabel} | ${ago}`;

        // Tooltip
        const thread = this.historyStore.getThread(tid);
        item.tooltip = new vscode.MarkdownString(
          `**${head.taskName}**\n\n` +
          `Engine: ${head.engine}\n\n` +
          (modelSpec ? `Model: ${modelSpec.displayName}\n\n` : '') +
          `Turns: ${thread.length}\n\n` +
          `Started: ${ago}`
        );

        item.contextValue = 'thread';
        item.command = {
          command: 'agentTaskPlayer.openThread',
          title: 'Open Thread',
          arguments: [head],
        };

        return item;
      });
  }
}

// ─── Helpers ───

function formatDurationMs(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hours = Math.floor(mins / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
