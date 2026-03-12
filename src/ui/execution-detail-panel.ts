// ─── Execution detail panel ───
// Interactive chat-style webview with session list (Mode 1) and thread detail
// (Mode 2).  Inspired by Copilot Chat sessions / Codex tasks / Claude Code
// conversations panels — shows execution history with model info, cost, tokens,
// retries, diffs, and a reply-capable thread view.

import * as vscode from 'vscode';
import { HistoryEntry, EngineId, TaskStatus } from '../models/types';
import { HistoryStore } from '../history/store';
import { RunSession, RunSessionStore } from '../models/run-session';
import { getModelSpec, ModelSpec, getAllModelSpecs } from '../models/model-specs';
import { getEngine } from '../adapters/index';
import { generateId } from '../models/plan';

/** Tracks open panels by threadId so clicking the same thread reuses its panel. */
const openPanels = new Map<string, ExecutionDetailPanel>();

export class ExecutionDetailPanel {
  private readonly _panel: vscode.WebviewPanel;
  private readonly _historyStore: HistoryStore;
  private readonly _runSessionStore: RunSessionStore | null;
  private _threadId: string | null = null;
  private _abortController: AbortController | null = null;
  private _isStreaming = false;
  private _disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    historyStore: HistoryStore,
    runSessionStore?: RunSessionStore,
  ) {
    this._panel = panel;
    this._historyStore = historyStore;
    this._runSessionStore = runSessionStore ?? null;

    panel.onDidDispose(() => {
      this._disposed = true;
      this._abortController?.abort();
      if (this._threadId) {
        openPanels.delete(this._threadId);
      } else {
        openPanels.delete('__empty__');
      }
    });

    panel.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
  }

  /**
   * Show (or re-reveal) a conversation panel for a history entry's thread.
   */
  static show(entry: HistoryEntry, historyStore: HistoryStore, runSessionStore?: RunSessionStore): void {
    const threadId = entry.threadId ?? entry.id;

    const existing = openPanels.get(threadId);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    // Reuse the empty-state panel if one is open
    const emptyPanel = openPanels.get('__empty__');
    if (emptyPanel) {
      openPanels.delete('__empty__');
      emptyPanel._threadId = threadId;
      openPanels.set(threadId, emptyPanel);
      emptyPanel._panel.title = entry.taskName;
      emptyPanel._renderThread(threadId);
      emptyPanel._panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerDetail',
      entry.taskName,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const instance = new ExecutionDetailPanel(panel, historyStore, runSessionStore);
    instance._threadId = threadId;
    openPanels.set(threadId, instance);
    instance._renderThread(threadId);
  }

  /**
   * Show thread list / session list when no specific entry is selected.
   */
  static showEmpty(historyStore: HistoryStore, runSessionStore?: RunSessionStore): void {
    const existing = openPanels.get('__empty__');
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.Active);
      existing._renderEmpty();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerDetail',
      'Sessions',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const instance = new ExecutionDetailPanel(panel, historyStore, runSessionStore);
    openPanels.set('__empty__', instance);
    instance._renderEmpty();
  }

  // ─── Message handling ───

  private async _handleMessage(msg: { type: string; text?: string; threadId?: string; runId?: string; engine?: string }): Promise<void> {
    switch (msg.type) {
      case 'send-reply':
        if (msg.text && this._threadId) {
          await this._sendReply(msg.text);
        }
        break;
      case 'navigate-back':
        this._navigateToEmpty();
        break;
      case 'open-thread':
        if (msg.threadId) {
          this._navigateToThread(msg.threadId);
        }
        break;
      case 'open-run':
        if (msg.runId) {
          this._navigateToRun(msg.runId);
        }
        break;
      case 'delete-thread':
        if (msg.threadId) {
          this._deleteThread(msg.threadId);
        }
        break;
      case 'delete-run':
        if (msg.runId) {
          this._deleteRun(msg.runId);
        }
        break;
      case 'new-conversation':
        if (msg.text) {
          await this._startNewConversation(msg.text, (msg.engine || 'claude') as EngineId);
        }
        break;
    }
  }

  private _navigateToEmpty(): void {
    if (this._threadId) {
      openPanels.delete(this._threadId);
    }
    this._threadId = null;
    openPanels.set('__empty__', this);
    this._panel.title = 'Sessions';
    this._renderEmpty();
  }

  private _navigateToThread(threadId: string): void {
    if (this._threadId) {
      openPanels.delete(this._threadId);
    } else {
      openPanels.delete('__empty__');
    }

    const existing = openPanels.get(threadId);
    if (existing && existing !== this) {
      existing._panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this._threadId = threadId;
    openPanels.set(threadId, this);

    const entries = this._historyStore.getThread(threadId);
    this._panel.title = entries.length > 0 ? entries[0].taskName : 'Conversation';
    this._renderThread(threadId);
  }

  private _navigateToRun(runId: string): void {
    // For run view, we set threadId to `run:<runId>` to distinguish from threads
    const key = `run:${runId}`;
    if (this._threadId) {
      openPanels.delete(this._threadId);
    } else {
      openPanels.delete('__empty__');
    }

    this._threadId = key;
    openPanels.set(key, this);

    const session = this._runSessionStore?.get(runId);
    this._panel.title = session?.planName ?? 'Run Details';
    this._renderRun(runId);
  }

  // ─── Delete ───

  private async _deleteThread(threadId: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Delete this conversation? This cannot be undone.',
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') { return; }

    this._historyStore.deleteThread(threadId);

    if (this._threadId === threadId) {
      this._navigateToEmpty();
    } else {
      this._renderEmpty();
    }
  }

  private async _deleteRun(runId: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Delete this run session? This cannot be undone.',
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') { return; }

    this._runSessionStore?.delete(runId);
    this._navigateToEmpty();
  }

  // ─── New conversation from session list ───

  private async _startNewConversation(text: string, engineId: EngineId): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const id = generateId();
    const taskName = text.length > 60 ? text.substring(0, 57) + '...' : text;
    const startedAt = new Date().toISOString();

    // Navigate to the thread immediately (will show empty, then stream)
    this._threadId = id;
    if (this._threadId) { openPanels.delete('__empty__'); }
    openPanels.set(id, this);
    this._panel.title = taskName;

    // Build a minimal thread view with streaming
    this._panel.webview.html = buildThreadHtml([]);
    this._postMessage({ type: 'user-message', text });
    this._postMessage({ type: 'stream-start', engine: engineId });

    this._isStreaming = true;
    this._abortController = new AbortController();

    try {
      const engine = getEngine(engineId);
      const result = await engine.runTask({
        prompt: text,
        cwd,
        signal: this._abortController.signal,
        onOutput: (chunk, stream) => {
          if (!this._disposed && stream === 'stdout') {
            this._postMessage({ type: 'stream-chunk', text: chunk });
          }
        },
      });

      const entry: HistoryEntry = {
        id,
        taskId: id,
        taskName,
        playlistId: 'conversation',
        playlistName: 'Conversations',
        engine: engineId,
        prompt: text,
        result,
        status: result.exitCode === 0 ? TaskStatus.Completed : TaskStatus.Failed,
        startedAt,
        finishedAt: new Date().toISOString(),
        threadId: id,
        turnIndex: 0,
      };

      this._historyStore.add(entry);

      if (!this._disposed) {
        this._postMessage({ type: 'stream-end', entry });
      }
    } catch (err) {
      if (!this._disposed) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this._postMessage({ type: 'stream-error', error: errMsg });
      }
    } finally {
      this._isStreaming = false;
      this._abortController = null;
    }
  }

  // ─── Reply flow ───

  private async _sendReply(text: string): Promise<void> {
    if (this._isStreaming || !this._threadId) { return; }
    this._isStreaming = true;
    this._abortController = new AbortController();

    const threadEntries = this._historyStore.getThread(this._threadId);
    if (threadEntries.length === 0) { this._isStreaming = false; return; }

    const firstEntry = threadEntries[0];
    const engineId: EngineId = firstEntry.engine;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    this._postMessage({ type: 'user-message', text });
    this._postMessage({ type: 'stream-start', engine: engineId });

    const startedAt = new Date().toISOString();

    try {
      const engine = getEngine(engineId);

      let contextPrompt = '';
      for (const entry of threadEntries) {
        contextPrompt += `User: ${entry.prompt}\n\nAssistant: ${entry.result.stdout}\n\n`;
      }
      contextPrompt += `User: ${text}`;

      const result = await engine.runTask({
        prompt: contextPrompt,
        cwd,
        signal: this._abortController.signal,
        onOutput: (chunk, stream) => {
          if (!this._disposed && stream === 'stdout') {
            this._postMessage({ type: 'stream-chunk', text: chunk });
          }
        },
      });

      const finishedAt = new Date().toISOString();
      const turnIndex = threadEntries.length;

      const newEntry: HistoryEntry = {
        id: generateId(),
        taskId: firstEntry.taskId,
        taskName: firstEntry.taskName,
        playlistId: firstEntry.playlistId,
        playlistName: firstEntry.playlistName,
        engine: engineId,
        prompt: text,
        result,
        status: result.exitCode === 0 ? TaskStatus.Completed : TaskStatus.Failed,
        startedAt,
        finishedAt,
        threadId: this._threadId,
        turnIndex,
      };

      this._historyStore.add(newEntry);

      if (!this._disposed) {
        this._postMessage({ type: 'stream-end', entry: newEntry });
      }
    } catch (err) {
      if (!this._disposed) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this._postMessage({ type: 'stream-error', error: errMsg });
      }
    } finally {
      this._isStreaming = false;
      this._abortController = null;
    }
  }

  private _postMessage(msg: unknown): void {
    if (!this._disposed) {
      this._panel.webview.postMessage(msg);
    }
  }

  // ─── Rendering ───

  private _renderThread(threadId: string): void {
    const entries = this._historyStore.getThread(threadId);
    this._panel.webview.html = buildThreadHtml(entries);
  }

  private _renderEmpty(): void {
    const heads = this._historyStore.getThreadHeads().slice(0, 20);
    const sessions = this._runSessionStore?.getAll().slice(0, 20) ?? [];
    this._panel.webview.html = buildSessionListHtml(heads, sessions);
  }

  private _renderRun(runId: string): void {
    const session = this._runSessionStore?.get(runId);
    const entries = this._historyStore.getForRun(runId);
    this._panel.webview.html = buildRunDetailHtml(session ?? null, entries);
  }
}

// ─── HTML helpers ───

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatDurationFromIso(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) { return 'running...'; }
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return formatDuration(ms);
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

function formatCost(cost: number): string {
  if (cost === 0) { return 'Free'; }
  if (cost < 0.01) { return `$${cost.toFixed(4)}`; }
  return `$${cost.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) { return `${(count / 1_000_000).toFixed(1)}M`; }
  if (count >= 1_000) { return `${(count / 1_000).toFixed(1)}K`; }
  return `${count}`;
}

function engineBadgeClass(engine: EngineId): string {
  const map: Record<string, string> = {
    claude: 'engine-claude',
    codex: 'engine-codex',
    gemini: 'engine-gemini',
    ollama: 'engine-ollama',
    custom: 'engine-custom',
  };
  return map[engine] || 'engine-custom';
}

function reasoningBadge(level: string): string {
  const icons: Record<string, string> = {
    low: '&#9679;',
    medium: '&#9679;&#9679;',
    high: '&#9679;&#9679;&#9679;',
    'extra-high': '&#9679;&#9679;&#9679;&#9679;',
  };
  return icons[level] || '';
}

function colorDiff(diff: string): string {
  return diff
    .split('\n')
    .map(line => {
      const escaped = escHtml(line);
      if (line.startsWith('+++') || line.startsWith('---')) {
        return `<span class="diff-meta">${escaped}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="diff-hunk">${escaped}</span>`;
      }
      if (line.startsWith('+')) {
        return `<span class="diff-add">${escaped}</span>`;
      }
      if (line.startsWith('-')) {
        return `<span class="diff-del">${escaped}</span>`;
      }
      return escaped;
    })
    .join('\n');
}

// ─── Mode 1: Session List HTML ───

function buildSessionListHtml(threadHeads: HistoryEntry[], sessions: RunSession[]): string {
  // Active session (if any)
  const activeSession = sessions.find(s => s.status === 'running');
  const pastSessions = sessions.filter(s => s.status !== 'running');

  let html = '';

  // Active run card
  if (activeSession) {
    const progress = activeSession.taskCount > 0
      ? Math.round((activeSession.tasksCompleted / activeSession.taskCount) * 100)
      : 0;
    html += `
    <div class="active-run-card">
      <div class="active-run-indicator">
        <span class="pulse-dot"></span>
        <span class="active-run-label">Running</span>
      </div>
      <div class="active-run-title">${escHtml(activeSession.planName)}</div>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${progress}%"></div>
      </div>
      <div class="active-run-stats">
        <span>${activeSession.tasksCompleted}/${activeSession.taskCount} tasks</span>
        <span>${activeSession.engines.map(e => `<span class="engine-pill ${engineBadgeClass(e)}">${escHtml(e)}</span>`).join(' ')}</span>
        <span>${formatCost(activeSession.totalCost)}</span>
      </div>
      <button class="active-run-open" data-run-id="${escHtml(activeSession.id)}">View Details</button>
    </div>`;
  }

  // Section: Past Sessions
  if (pastSessions.length > 0) {
    html += `<div class="section-header">Recent Sessions</div>`;
    html += `<div class="session-list">`;
    for (const session of pastSessions) {
      const statusClass = session.status === 'completed' ? 'status-ok'
        : session.status === 'failed' ? 'status-fail'
        : 'status-stopped';
      const statusLabel = session.status === 'completed' ? 'Completed'
        : session.status === 'failed' ? 'Failed'
        : 'Stopped';
      const duration = formatDurationFromIso(session.startedAt, session.finishedAt);
      const enginePills = session.engines.map(e =>
        `<span class="engine-pill ${engineBadgeClass(e)}">${escHtml(e)}</span>`
      ).join(' ');

      html += `
      <div class="session-card" data-run-id="${escHtml(session.id)}">
        <div class="session-card-row">
          <div class="session-card-title">${escHtml(session.planName)}</div>
          <button class="card-delete" data-run-id="${escHtml(session.id)}" title="Delete session">&#x2715;</button>
        </div>
        <div class="session-card-meta">
          <span class="badge-sm ${statusClass}">${statusLabel}</span>
          ${enginePills}
          <span class="meta-sep">&middot;</span>
          <span>${session.tasksCompleted}/${session.taskCount} tasks</span>
          <span class="meta-sep">&middot;</span>
          <span>${duration}</span>
        </div>
        <div class="session-card-bottom">
          <span class="token-info">
            ${formatTokens(session.totalTokensIn)} in / ${formatTokens(session.totalTokensOut)} out
          </span>
          <span class="cost-info">${formatCost(session.totalCost)}</span>
          <span class="time-ago">${timeAgo(session.startedAt)}</span>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  // Section: Threads (conversations)
  if (threadHeads.length > 0) {
    html += `<div class="section-header">Conversations</div>`;
    html += `<div class="thread-list">`;
    for (const head of threadHeads) {
      const tid = head.threadId ?? head.id;
      const ago = timeAgo(head.startedAt);
      const modelSpec = head.modelId ? getModelSpec(head.modelId) : null;
      const engineClass = engineBadgeClass(head.engine);

      html += `
      <div class="thread-card" data-thread-id="${escHtml(tid)}">
        <div class="thread-card-row">
          <div class="thread-card-title">${escHtml(head.taskName)}</div>
          <button class="card-delete" data-thread-id="${escHtml(tid)}" title="Delete conversation">&#x2715;</button>
        </div>
        <div class="thread-card-meta">
          <span class="engine-pill ${engineClass}">${escHtml(head.engine)}</span>
          ${modelSpec ? `<span class="model-label">${escHtml(modelSpec.displayName)}</span>` : ''}
          <span class="meta-sep">&middot;</span>
          <span>${ago}</span>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  // Empty state if nothing at all
  if (!activeSession && pastSessions.length === 0 && threadHeads.length === 0) {
    html += `
    <div class="empty-hint-container">
      <div class="empty-icon">&#9654;</div>
      <p class="empty-hint-title">No sessions yet</p>
      <p class="empty-hint-text">Run a task from the Plan view to start a new session.</p>
    </div>`;
  }

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sessions</title>
  <style>${sharedStyles()}</style>
</head>
<body>
  <div class="session-list-container">
    <div class="panel-header">
      <div class="panel-header-row">
        <h2>Sessions</h2>
      </div>
      <div class="search-bar">
        <input type="text" id="searchInput" placeholder="Search sessions and conversations..." />
      </div>
    </div>
    <div id="filterable-content">
      ${html}
    </div>
  </div>

  <!-- Footer input bar -->
  <div class="footer-input-bar">
    <select id="enginePicker" class="engine-select">
      <option value="claude">Claude</option>
      <option value="codex">Codex</option>
      <option value="gemini">Gemini</option>
      <option value="ollama">Ollama</option>
    </select>
    <input type="text" id="newPromptInput" class="footer-prompt-input" placeholder="Start a new conversation..." />
    <button id="btnNewConversation" class="footer-send-btn" title="Start conversation">&#9654;</button>
  </div>

  <script>${sessionListScript()}</script>
</body>
</html>`;
}

// ─── Mode 2: Thread Detail HTML ───

function buildThreadHtml(entries: HistoryEntry[]): string {
  const title = entries.length > 0 ? escHtml(entries[0].taskName) : 'Conversation';
  const engine = entries.length > 0 ? entries[0].engine : '';
  const turnCount = entries.length;
  const threadId = entries.length > 0 ? escHtml(entries[0].threadId ?? entries[0].id) : '';

  // Compute thread-level summary
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0, totalDuration = 0;
  const enginesUsed = new Set<string>();
  const modelsUsed = new Set<string>();

  for (const entry of entries) {
    enginesUsed.add(entry.engine);
    if (entry.modelId) { modelsUsed.add(entry.modelId); }
    if (entry.result.tokenUsage) {
      totalTokensIn += entry.result.tokenUsage.inputTokens ?? 0;
      totalTokensOut += entry.result.tokenUsage.outputTokens ?? 0;
      totalCost += entry.result.tokenUsage.estimatedCost ?? 0;
    }
    totalDuration += entry.result.durationMs;
  }

  // Build turn cards
  let turnsHtml = '';
  for (const entry of entries) {
    turnsHtml += buildTurnCard(entry);
  }

  // Thread summary bar
  const summaryHtml = entries.length > 0 ? `
  <div class="thread-summary">
    <span class="engine-pill ${engineBadgeClass(engine as EngineId)}">${escHtml(engine)}</span>
    <span class="summary-stat">${turnCount} turn${turnCount !== 1 ? 's' : ''}</span>
    <span class="summary-stat">${formatTokens(totalTokensIn)} in / ${formatTokens(totalTokensOut)} out</span>
    <span class="summary-stat">${formatCost(totalCost)}</span>
    <span class="summary-stat">${formatDuration(totalDuration)}</span>
  </div>` : '';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${sharedStyles()}</style>
</head>
<body>

  <!-- Nav bar -->
  <div class="nav-bar">
    <button class="nav-back" id="btnBack" title="Back to sessions">&#8592; Sessions</button>
    <div class="nav-title">
      <strong>${title}</strong>
    </div>
    <button class="nav-delete" id="btnDelete" data-thread-id="${threadId}" title="Delete conversation">Delete</button>
  </div>

  ${summaryHtml}

  <!-- Chat area -->
  <div class="chat" id="chatArea">
    ${turnsHtml}
    <!-- Streaming bubble (hidden by default) -->
    <div class="bubble-row assistant streaming-row" id="streamingRow" style="display:none;">
      <div>
        <div class="bubble-label" id="streamingLabel">...</div>
        <div class="bubble" id="streamingBubble"><span class="typing-indicator">Thinking...</span></div>
      </div>
    </div>
  </div>

  <!-- Input area -->
  <div class="input-area" id="inputArea">
    <textarea id="replyInput" placeholder="Type a follow-up message..." rows="2"></textarea>
    <button id="btnSend" title="Send reply">Send</button>
  </div>

  <script>${threadScript()}</script>
</body>
</html>`;
}

/** Build a rich turn card for a single history entry */
function buildTurnCard(entry: HistoryEntry): string {
  const statusLabel = entry.status === 'completed' ? 'Completed'
    : entry.status === 'blocked' ? 'Blocked'
    : entry.status === 'failed' ? 'Failed'
    : entry.status;
  const statusClass = entry.status === 'completed' ? 'status-ok'
    : entry.status === 'blocked' ? 'status-warn'
    : 'status-fail';
  const duration = formatDuration(entry.result.durationMs);

  const modelSpec = entry.modelId ? getModelSpec(entry.modelId) : null;
  const engineClass = engineBadgeClass(entry.engine);

  // Model info line
  let modelLine = `<span class="engine-pill ${engineClass}">${escHtml(entry.engine)}</span>`;
  if (modelSpec) {
    modelLine += ` <span class="model-label">${escHtml(modelSpec.displayName)}</span>`;
    modelLine += ` <span class="reasoning-dots" title="${escHtml(modelSpec.reasoning)} reasoning">${reasoningBadge(modelSpec.reasoning)}</span>`;
  } else if (entry.modelId) {
    modelLine += ` <span class="model-label">${escHtml(entry.modelId)}</span>`;
  }

  // Token info
  let tokenLine = '';
  if (entry.result.tokenUsage) {
    const u = entry.result.tokenUsage;
    const parts: string[] = [];
    if (u.inputTokens !== undefined) { parts.push(`${formatTokens(u.inputTokens)} in`); }
    if (u.outputTokens !== undefined) { parts.push(`${formatTokens(u.outputTokens)} out`); }
    if (u.estimatedCost !== undefined) { parts.push(formatCost(u.estimatedCost)); }
    tokenLine = parts.join(' &middot; ');
  }

  // Auto-selection reason
  let reasonLine = '';
  if (entry.modelReason) {
    reasonLine = `<div class="auto-select-reason" title="${escHtml(entry.modelReason)}">Auto: ${escHtml(entry.modelReason)}</div>`;
  }

  // Changed files
  let filesHtml = '';
  if (entry.changedFiles && entry.changedFiles.length > 0) {
    const fileItems = entry.changedFiles.map(f => `<li>${escHtml(f)}</li>`).join('');
    filesHtml = `
    <details class="section">
      <summary>Files Changed (${entry.changedFiles.length})</summary>
      <ul class="file-list">${fileItems}</ul>
    </details>`;
  }

  // Diff
  let diffHtml = '';
  if (entry.codeChanges) {
    diffHtml = `
    <details class="section">
      <summary>Diff</summary>
      <pre class="diff">${colorDiff(entry.codeChanges)}</pre>
    </details>`;
  }

  // Verification
  let verifyHtml = '';
  if (entry.verification) {
    const vClass = entry.verification.passed ? 'verify-pass' : 'verify-fail';
    verifyHtml = `
    <details class="section">
      <summary class="${vClass}">Verification ${entry.verification.passed ? 'Passed' : 'Failed'}</summary>
      <pre>${escHtml(`$ ${entry.verification.command}\nexit ${entry.verification.exitCode}\n${entry.verification.output}`)}</pre>
    </details>`;
  }

  // Stderr
  let stderrHtml = '';
  if (entry.result.stderr && entry.result.stderr.trim()) {
    stderrHtml = `
    <details class="section">
      <summary>Stderr</summary>
      <pre class="stderr">${escHtml(entry.result.stderr)}</pre>
    </details>`;
  }

  return `
    <!-- User prompt -->
    <div class="bubble-row user">
      <div>
        <div class="bubble-label">You</div>
        <div class="bubble user-bubble">${escHtml(entry.prompt)}</div>
      </div>
    </div>

    <!-- Assistant response -->
    <div class="turn-card">
      <div class="turn-header">
        <div class="turn-model-row">
          ${modelLine}
          <span class="badge-sm ${statusClass}">${statusLabel}</span>
          <span class="turn-duration">${duration}</span>
        </div>
        ${tokenLine ? `<div class="turn-token-row">${tokenLine}</div>` : ''}
        ${reasonLine}
      </div>
      <div class="turn-body">
        <pre class="turn-output">${escHtml(entry.result.stdout || '(no output)')}</pre>
      </div>
      <div class="turn-sections">
        ${filesHtml}${diffHtml}${verifyHtml}${stderrHtml}
      </div>
    </div>`;
}

// ─── Run Detail HTML (session view with all tasks) ───

function buildRunDetailHtml(session: RunSession | null, entries: HistoryEntry[]): string {
  if (!session) {
    return buildErrorHtml('Run session not found');
  }

  const statusClass = session.status === 'completed' ? 'status-ok'
    : session.status === 'failed' ? 'status-fail'
    : session.status === 'running' ? 'status-running'
    : 'status-stopped';
  const statusLabel = session.status.charAt(0).toUpperCase() + session.status.slice(1);
  const duration = formatDurationFromIso(session.startedAt, session.finishedAt);
  const progress = session.taskCount > 0
    ? Math.round((session.tasksCompleted / session.taskCount) * 100)
    : 0;

  const enginePills = session.engines.map(e =>
    `<span class="engine-pill ${engineBadgeClass(e)}">${escHtml(e)}</span>`
  ).join(' ');

  // Group entries by playlist
  const playlistGroups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const key = entry.playlistName || 'Default';
    if (!playlistGroups.has(key)) { playlistGroups.set(key, []); }
    playlistGroups.get(key)!.push(entry);
  }

  let tasksHtml = '';
  for (const [playlistName, groupEntries] of playlistGroups) {
    tasksHtml += `<div class="playlist-group">
      <div class="playlist-group-header">${escHtml(playlistName)}</div>`;
    for (const entry of groupEntries) {
      tasksHtml += buildTurnCard(entry);
    }
    tasksHtml += `</div>`;
  }

  // Model breakdown
  const modelCounts = new Map<string, { count: number; tokensIn: number; tokensOut: number; cost: number }>();
  for (const entry of entries) {
    const mid = entry.modelId || 'unknown';
    const existing = modelCounts.get(mid) ?? { count: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    existing.count++;
    existing.tokensIn += entry.result.tokenUsage?.inputTokens ?? 0;
    existing.tokensOut += entry.result.tokenUsage?.outputTokens ?? 0;
    existing.cost += entry.result.tokenUsage?.estimatedCost ?? 0;
    modelCounts.set(mid, existing);
  }

  let modelBreakdownHtml = '';
  if (modelCounts.size > 0) {
    const rows = [...modelCounts.entries()].map(([mid, stats]) => {
      const spec = getModelSpec(mid);
      const name = spec?.displayName ?? mid;
      return `<tr>
        <td>${escHtml(name)}</td>
        <td>${stats.count}</td>
        <td>${formatTokens(stats.tokensIn)} / ${formatTokens(stats.tokensOut)}</td>
        <td>${formatCost(stats.cost)}</td>
      </tr>`;
    }).join('');

    modelBreakdownHtml = `
    <details class="section" open>
      <summary>Model Breakdown</summary>
      <table class="breakdown-table">
        <thead><tr><th>Model</th><th>Tasks</th><th>Tokens (in/out)</th><th>Cost</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
  }

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(session.planName)}</title>
  <style>${sharedStyles()}</style>
</head>
<body>

  <!-- Nav bar -->
  <div class="nav-bar">
    <button class="nav-back" id="btnBack" title="Back to sessions">&#8592; Sessions</button>
    <div class="nav-title">
      <strong>${escHtml(session.planName)}</strong>
      <span class="badge-sm ${statusClass}">${statusLabel}</span>
    </div>
    <button class="nav-delete" id="btnDeleteRun" data-run-id="${escHtml(session.id)}" title="Delete run">Delete</button>
  </div>

  <!-- Run summary header -->
  <div class="run-summary-header">
    <div class="run-summary-row">
      ${enginePills}
      <span class="summary-stat">${session.tasksCompleted}/${session.taskCount} tasks</span>
      <span class="summary-stat">${session.tasksFailed} failed</span>
      <span class="summary-stat">${duration}</span>
    </div>
    <div class="progress-bar-container">
      <div class="progress-bar ${statusClass}" style="width: ${progress}%"></div>
    </div>
    <div class="run-summary-row">
      <span class="summary-stat">${formatTokens(session.totalTokensIn)} in / ${formatTokens(session.totalTokensOut)} out</span>
      <span class="summary-stat cost-highlight">${formatCost(session.totalCost)}</span>
      <span class="summary-stat time-ago">${timeAgo(session.startedAt)}</span>
    </div>
  </div>

  <!-- Model breakdown -->
  <div class="run-breakdown">
    ${modelBreakdownHtml}
  </div>

  <!-- Task cards -->
  <div class="chat" id="chatArea">
    ${tasksHtml || '<p class="empty-hint-text">No task entries recorded for this run.</p>'}
  </div>

  <script>${runDetailScript()}</script>
</body>
</html>`;
}

function buildErrorHtml(message: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>${sharedStyles()}</style>
</head>
<body>
  <div class="nav-bar">
    <button class="nav-back" id="btnBack">&#8592; Sessions</button>
    <div class="nav-title"><strong>Error</strong></div>
  </div>
  <div class="empty-hint-container">
    <p class="empty-hint-title">${escHtml(message)}</p>
  </div>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      document.getElementById('btnBack').addEventListener('click', () => {
        vscode.postMessage({ type: 'navigate-back' });
      });
    })();
  </script>
</body>
</html>`;
}

// ─── Shared CSS ───

function sharedStyles(): string {
  return /* css */ `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    /* ── Nav bar ── */
    .nav-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .nav-back {
      background: none;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-secondaryBackground, transparent);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85em;
    }
    .nav-back:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    }
    .nav-title { flex: 1; display: flex; align-items: center; gap: 8px; }
    .nav-title strong { margin-right: 4px; }
    .nav-meta { opacity: 0.6; font-size: 0.85em; }
    .nav-delete {
      background: none;
      border: 1px solid var(--vscode-testing-iconFailed, #f44336);
      color: var(--vscode-testing-iconFailed, #f44336);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85em;
    }
    .nav-delete:hover {
      background: var(--vscode-testing-iconFailed, #f44336);
      color: #fff;
    }

    /* ── Panel header ── */
    .panel-header {
      padding: 16px 20px 8px;
    }
    .panel-header h2 {
      font-size: 1.2em;
      font-weight: 600;
    }

    /* ── Session list container ── */
    .session-list-container {
      flex: 1;
      overflow-y: auto;
      padding-bottom: 24px;
    }

    .section-header {
      padding: 16px 20px 8px;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.5;
      font-weight: 600;
    }

    /* ── Active run card ── */
    .active-run-card {
      margin: 12px 20px;
      padding: 16px;
      border-radius: 10px;
      border: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      animation: active-glow 2s ease-in-out infinite;
    }
    @keyframes active-glow {
      0%, 100% { border-color: var(--vscode-focusBorder); }
      50% { border-color: var(--vscode-button-background); }
    }
    .active-run-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed, #4caf50);
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }
    .active-run-label {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-testing-iconPassed, #4caf50);
      font-weight: 600;
    }
    .active-run-title {
      font-weight: 600;
      font-size: 1.05em;
      margin-bottom: 10px;
    }
    .active-run-stats {
      display: flex;
      gap: 12px;
      font-size: 0.85em;
      opacity: 0.8;
      margin-top: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .active-run-open {
      margin-top: 12px;
      padding: 6px 16px;
      border: none;
      border-radius: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 600;
    }
    .active-run-open:hover {
      background: var(--vscode-button-hoverBackground);
    }

    /* ── Progress bar ── */
    .progress-bar-container {
      width: 100%;
      height: 4px;
      border-radius: 2px;
      background: var(--vscode-editorWidget-background, rgba(255,255,255,0.1));
      overflow: hidden;
    }
    .progress-bar {
      height: 100%;
      border-radius: 2px;
      background: var(--vscode-button-background);
      transition: width 0.3s ease;
    }
    .progress-bar.status-ok { background: var(--vscode-testing-iconPassed, #4caf50); }
    .progress-bar.status-fail { background: var(--vscode-testing-iconFailed, #f44336); }
    .progress-bar.status-running { background: var(--vscode-button-background); }

    /* ── Session card ── */
    .session-list, .thread-list {
      padding: 0 20px;
    }
    .session-card, .thread-card {
      padding: 12px 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      margin-bottom: 6px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .session-card:hover, .thread-card:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .session-card-row, .thread-card-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .session-card-title, .thread-card-title {
      font-weight: 600;
      font-size: 0.95em;
    }
    .session-card-meta, .thread-card-meta {
      display: flex;
      gap: 6px;
      font-size: 0.8em;
      opacity: 0.75;
      align-items: center;
      flex-wrap: wrap;
    }
    .session-card-bottom {
      display: flex;
      gap: 12px;
      font-size: 0.75em;
      opacity: 0.55;
      margin-top: 4px;
    }
    .meta-sep { opacity: 0.4; }

    /* ── Card delete button ── */
    .card-delete {
      background: none;
      border: none;
      color: var(--vscode-editor-foreground);
      opacity: 0;
      cursor: pointer;
      font-size: 1em;
      padding: 2px 6px;
      border-radius: 4px;
      transition: opacity 0.15s;
    }
    .session-card:hover .card-delete,
    .thread-card:hover .card-delete {
      opacity: 0.5;
    }
    .card-delete:hover {
      opacity: 1 !important;
      color: var(--vscode-testing-iconFailed, #f44336);
      background: var(--vscode-list-hoverBackground);
    }

    /* ── Engine pills ── */
    .engine-pill {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .engine-claude { background: #d4a574; color: #1a1a1a; }
    .engine-codex  { background: #74b9ff; color: #1a1a1a; }
    .engine-gemini { background: #81ecec; color: #1a1a1a; }
    .engine-ollama { background: #a29bfe; color: #1a1a1a; }
    .engine-custom { background: #636e72; color: #fff; }

    /* ── Badges ── */
    .badge-sm {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 0.75em;
      font-weight: 600;
    }
    .status-ok { background: var(--vscode-testing-iconPassed, #4caf50); color: #fff; }
    .status-warn { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
    .status-fail { background: var(--vscode-testing-iconFailed, #f44336); color: #fff; }
    .status-stopped { background: var(--vscode-descriptionForeground, #888); color: #fff; }
    .status-running { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

    .model-label {
      font-size: 0.85em;
      opacity: 0.8;
    }

    .reasoning-dots {
      font-size: 0.6em;
      color: var(--vscode-button-background);
      letter-spacing: -1px;
    }

    /* ── Chat area ── */
    .chat {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      max-width: 900px;
      width: 100%;
      margin: 0 auto;
    }

    /* ── Bubble rows ── */
    .bubble-row {
      display: flex;
      margin-bottom: 12px;
    }
    .bubble-row.user { justify-content: flex-end; }
    .bubble-row.assistant { justify-content: flex-start; }

    .bubble {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.9em;
    }
    .bubble-row.user .bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 4px;
    }
    .bubble-row.assistant .bubble {
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom-left-radius: 4px;
    }

    .bubble-label {
      font-size: 0.7em;
      opacity: 0.5;
      margin-bottom: 3px;
    }
    .bubble-row.user .bubble-label { text-align: right; }

    /* ── Turn card (rich assistant response) ── */
    .turn-card {
      margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      overflow: hidden;
    }
    .turn-header {
      padding: 10px 14px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .turn-model-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .turn-duration {
      font-size: 0.8em;
      opacity: 0.6;
      margin-left: auto;
    }
    .turn-token-row {
      font-size: 0.75em;
      opacity: 0.55;
      margin-top: 4px;
    }
    .auto-select-reason {
      font-size: 0.7em;
      opacity: 0.45;
      font-style: italic;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .turn-body {
      padding: 12px 14px;
    }
    .turn-output {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      max-height: 400px;
      overflow-y: auto;
    }
    .turn-sections {
      padding: 0 14px 8px;
    }

    /* ── Collapsible sections ── */
    .section {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 6px;
    }
    .section summary {
      cursor: pointer;
      padding: 6px 10px;
      font-weight: 600;
      font-size: 0.85em;
      user-select: none;
    }
    .section summary:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .section pre, .section ul, .section table {
      padding: 8px 10px;
      margin: 0;
    }
    .section pre {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-x: auto;
    }
    .file-list {
      list-style: none;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .file-list li { padding: 2px 0; }
    .file-list li::before { content: '\\2022 '; opacity: 0.5; }

    /* ── Diff coloring ── */
    .diff-add  { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
    .diff-del  { color: var(--vscode-gitDecoration-deletedResourceForeground, #f44336); }
    .diff-hunk { color: var(--vscode-gitDecoration-modifiedResourceForeground, #2196f3); }
    .diff-meta { opacity: 0.7; font-weight: bold; }
    .stderr { color: var(--vscode-testing-iconFailed, #f44336); }
    .verify-pass summary { color: var(--vscode-testing-iconPassed, #4caf50); }
    .verify-fail summary { color: var(--vscode-testing-iconFailed, #f44336); }

    /* ── Breakdown table ── */
    .breakdown-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85em;
    }
    .breakdown-table th {
      text-align: left;
      font-weight: 600;
      opacity: 0.6;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .breakdown-table td {
      padding: 4px 8px;
    }

    /* ── Thread summary bar ── */
    .thread-summary {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      font-size: 0.8em;
      opacity: 0.7;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .summary-stat { white-space: nowrap; }
    .cost-highlight { font-weight: 600; }

    /* ── Run summary header ── */
    .run-summary-header {
      padding: 12px 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .run-summary-row {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 0.85em;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .run-breakdown {
      padding: 8px 20px;
      flex-shrink: 0;
    }

    /* ── Playlist group ── */
    .playlist-group {
      margin-bottom: 16px;
    }
    .playlist-group-header {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.5;
      font-weight: 600;
      padding: 8px 0 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 12px;
    }

    /* ── Input area ── */
    .input-area {
      display: flex;
      gap: 8px;
      padding: 10px 20px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      flex-shrink: 0;
      max-width: 900px;
      width: 100%;
      margin: 0 auto;
    }
    .input-area textarea {
      flex: 1;
      resize: none;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
    }
    .input-area textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .input-area button {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-weight: 600;
      align-self: flex-end;
    }
    .input-area button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .input-area button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* ── Typing indicator ── */
    .typing-indicator { opacity: 0.6; font-style: italic; }

    /* ── Empty state ── */
    .empty-hint-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 48px 24px;
      text-align: center;
    }
    .empty-icon {
      font-size: 2.5em;
      opacity: 0.15;
      margin-bottom: 12px;
    }
    .empty-hint-title {
      font-weight: 600;
      margin-bottom: 6px;
    }
    .empty-hint-text {
      opacity: 0.5;
      font-size: 0.9em;
    }

    .time-ago { opacity: 0.6; }
    .token-info { font-family: var(--vscode-editor-font-family, monospace); }
    .cost-info { font-weight: 600; }

    /* ── Search bar ── */
    .search-bar {
      padding: 0 20px 8px;
    }
    .search-bar input {
      width: 100%;
      padding: 6px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .search-bar input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .panel-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* ── Footer input bar ── */
    .footer-input-bar {
      display: flex;
      gap: 6px;
      padding: 10px 20px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      flex-shrink: 0;
    }
    .engine-select {
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      font-size: 0.85em;
      cursor: pointer;
    }
    .footer-prompt-input {
      flex: 1;
      padding: 6px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .footer-prompt-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .footer-send-btn {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 0.9em;
    }
    .footer-send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    /* ── Hidden by search ── */
    .search-hidden { display: none !important; }
  `;
}

// ─── Webview scripts ───

function sessionListScript(): string {
  return /* js */ `
    (function() {
      const vscode = acquireVsCodeApi();

      // Session card clicks
      document.querySelectorAll('.session-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.card-delete')) return;
          const runId = card.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'open-run', runId });
          }
        });
      });

      // Thread card clicks
      document.querySelectorAll('.thread-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.card-delete')) return;
          const threadId = card.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'open-thread', threadId });
          }
        });
      });

      // Active run view-details button
      document.querySelectorAll('.active-run-open').forEach(btn => {
        btn.addEventListener('click', () => {
          const runId = btn.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'open-run', runId });
          }
        });
      });

      // Delete buttons (sessions)
      document.querySelectorAll('.card-delete[data-run-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const runId = btn.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'delete-run', runId });
          }
        });
      });

      // Delete buttons (threads)
      document.querySelectorAll('.card-delete[data-thread-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const threadId = btn.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'delete-thread', threadId });
          }
        });
      });

      // Search filtering
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.addEventListener('input', () => {
          const query = searchInput.value.toLowerCase().trim();
          document.querySelectorAll('.session-card, .thread-card').forEach(card => {
            const title = card.querySelector('.session-card-title, .thread-card-title');
            const text = (title ? title.textContent : '').toLowerCase();
            card.classList.toggle('search-hidden', query.length > 0 && !text.includes(query));
          });
        });
      }

      // New conversation from footer
      const newPromptInput = document.getElementById('newPromptInput');
      const btnNewConversation = document.getElementById('btnNewConversation');
      const enginePicker = document.getElementById('enginePicker');

      if (btnNewConversation && newPromptInput) {
        function startConversation() {
          const text = newPromptInput.value.trim();
          if (!text) return;
          const engine = enginePicker ? enginePicker.value : 'claude';
          vscode.postMessage({ type: 'new-conversation', text, engine });
          newPromptInput.value = '';
        }
        btnNewConversation.addEventListener('click', startConversation);
        newPromptInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            startConversation();
          }
        });
      }
    })();
  `;
}

function threadScript(): string {
  return /* js */ `
    (function() {
      const vscode = acquireVsCodeApi();
      const chatArea = document.getElementById('chatArea');
      const replyInput = document.getElementById('replyInput');
      const btnSend = document.getElementById('btnSend');
      const btnBack = document.getElementById('btnBack');
      const streamingRow = document.getElementById('streamingRow');
      const streamingBubble = document.getElementById('streamingBubble');
      const streamingLabel = document.getElementById('streamingLabel');
      let isStreaming = false;
      let streamedText = '';

      function scrollToBottom() {
        const threshold = 50;
        const nearBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < threshold;
        if (nearBottom || !isStreaming) {
          chatArea.scrollTop = chatArea.scrollHeight;
        }
      }
      scrollToBottom();

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      const btnDelete = document.getElementById('btnDelete');

      btnBack.addEventListener('click', () => {
        vscode.postMessage({ type: 'navigate-back' });
      });

      if (btnDelete) {
        btnDelete.addEventListener('click', () => {
          const threadId = btnDelete.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'delete-thread', threadId });
          }
        });
      }

      function sendReply() {
        const text = replyInput.value.trim();
        if (!text || isStreaming) return;
        replyInput.value = '';
        vscode.postMessage({ type: 'send-reply', text });
      }

      btnSend.addEventListener('click', sendReply);
      replyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendReply();
        }
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
          case 'user-message': {
            const row = document.createElement('div');
            row.className = 'bubble-row user';
            row.innerHTML = '<div><div class="bubble-label">You</div><div class="bubble">' + escapeHtml(msg.text) + '</div></div>';
            chatArea.insertBefore(row, streamingRow);
            scrollToBottom();
            break;
          }
          case 'stream-start': {
            isStreaming = true;
            streamedText = '';
            btnSend.disabled = true;
            replyInput.disabled = true;
            streamingLabel.textContent = msg.engine || '...';
            streamingBubble.innerHTML = '<span class="typing-indicator">Thinking...</span>';
            streamingRow.style.display = '';
            scrollToBottom();
            break;
          }
          case 'stream-chunk': {
            if (streamedText === '') {
              streamingBubble.textContent = '';
            }
            streamedText += msg.text;
            streamingBubble.textContent = streamedText;
            scrollToBottom();
            break;
          }
          case 'stream-end': {
            isStreaming = false;
            btnSend.disabled = false;
            replyInput.disabled = false;
            streamingRow.style.display = 'none';

            const row = document.createElement('div');
            row.className = 'bubble-row assistant';
            const stdout = (msg.entry && msg.entry.result && msg.entry.result.stdout) || streamedText || '(no output)';
            row.innerHTML = '<div><div class="bubble-label">' + escapeHtml(streamingLabel.textContent) + '</div><div class="bubble">' + escapeHtml(stdout) + '</div></div>';
            chatArea.insertBefore(row, streamingRow);
            scrollToBottom();
            replyInput.focus();
            break;
          }
          case 'stream-error': {
            isStreaming = false;
            btnSend.disabled = false;
            replyInput.disabled = false;
            streamingRow.style.display = 'none';

            const row = document.createElement('div');
            row.className = 'bubble-row assistant';
            row.innerHTML = '<div><div class="bubble-label">Error</div><div class="bubble stderr">' + escapeHtml(msg.error || 'Unknown error') + '</div></div>';
            chatArea.insertBefore(row, streamingRow);
            scrollToBottom();
            break;
          }
        }
      });
    })();
  `;
}

function runDetailScript(): string {
  return /* js */ `
    (function() {
      const vscode = acquireVsCodeApi();

      document.getElementById('btnBack').addEventListener('click', () => {
        vscode.postMessage({ type: 'navigate-back' });
      });

      const btnDeleteRun = document.getElementById('btnDeleteRun');
      if (btnDeleteRun) {
        btnDeleteRun.addEventListener('click', () => {
          const runId = btnDeleteRun.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'delete-run', runId });
          }
        });
      }
    })();
  `;
}
