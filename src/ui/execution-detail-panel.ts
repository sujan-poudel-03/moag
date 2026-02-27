// ─── Execution detail panel ───
// Interactive chat-style webview that shows thread conversations with reply
// capability, streaming responses, thread list navigation, and empty state.

import * as vscode from 'vscode';
import { HistoryEntry, EngineId, TaskStatus } from '../models/types';
import { HistoryStore } from '../history/store';
import { getEngine } from '../adapters/index';
import { generateId } from '../models/plan';

/** Tracks open panels by threadId so clicking the same thread reuses its panel. */
const openPanels = new Map<string, ExecutionDetailPanel>();

export class ExecutionDetailPanel {
  private readonly _panel: vscode.WebviewPanel;
  private readonly _historyStore: HistoryStore;
  private _threadId: string | null = null;
  private _abortController: AbortController | null = null;
  private _isStreaming = false;
  private _disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    historyStore: HistoryStore,
  ) {
    this._panel = panel;
    this._historyStore = historyStore;

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
  static show(entry: HistoryEntry, historyStore: HistoryStore): void {
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

    const instance = new ExecutionDetailPanel(panel, historyStore);
    instance._threadId = threadId;
    openPanels.set(threadId, instance);
    instance._renderThread(threadId);
  }

  /**
   * Show thread list / empty state when no specific entry is selected.
   */
  static showEmpty(historyStore: HistoryStore): void {
    const existing = openPanels.get('__empty__');
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.Active);
      existing._renderEmpty();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerDetail',
      'Conversations',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const instance = new ExecutionDetailPanel(panel, historyStore);
    openPanels.set('__empty__', instance);
    instance._renderEmpty();
  }

  // ─── Message handling ───

  private async _handleMessage(msg: { type: string; text?: string; threadId?: string }): Promise<void> {
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
      case 'delete-thread':
        if (msg.threadId) {
          this._deleteThread(msg.threadId);
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
    this._panel.title = 'Conversations';
    this._renderEmpty();
  }

  private _navigateToThread(threadId: string): void {
    // Clean up old key
    if (this._threadId) {
      openPanels.delete(this._threadId);
    } else {
      openPanels.delete('__empty__');
    }

    // If there's already a panel for this thread, just reveal it
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

  // ─── Delete thread ───

  private async _deleteThread(threadId: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Delete this conversation? This cannot be undone.',
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') { return; }

    this._historyStore.deleteThread(threadId);

    // If we're viewing the thread we just deleted, go back to thread list
    if (this._threadId === threadId) {
      this._navigateToEmpty();
    } else {
      // Refresh the thread list to remove the deleted card
      this._renderEmpty();
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

    // Show the user message and streaming indicator immediately
    this._postMessage({ type: 'user-message', text });
    this._postMessage({ type: 'stream-start', engine: engineId });

    const startedAt = new Date().toISOString();

    try {
      const engine = getEngine(engineId);

      // Build context from prior turns
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
    const heads = this._historyStore.getThreadHeads().slice(0, 10);
    this._panel.webview.html = buildEmptyHtml(heads);
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
  const secs = (ms / 1000).toFixed(1);
  return `${secs}s`;
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

function buildEntrySections(entry: HistoryEntry): string {
  let sectionsHtml = '';

  if (entry.changedFiles && entry.changedFiles.length > 0) {
    const fileItems = entry.changedFiles.map(f => `<li>${escHtml(f)}</li>`).join('');
    sectionsHtml += `
    <details class="section">
      <summary>Changed Files (${entry.changedFiles.length})</summary>
      <ul class="file-list">${fileItems}</ul>
    </details>`;
  }

  if (entry.codeChanges) {
    sectionsHtml += `
    <details class="section">
      <summary>Code Changes (Diff)</summary>
      <pre class="diff">${colorDiff(entry.codeChanges)}</pre>
    </details>`;
  }

  if (entry.result.tokenUsage) {
    const u = entry.result.tokenUsage;
    const parts: string[] = [];
    if (u.inputTokens !== undefined) { parts.push(`Input: ${u.inputTokens}`); }
    if (u.outputTokens !== undefined) { parts.push(`Output: ${u.outputTokens}`); }
    if (u.totalTokens !== undefined) { parts.push(`Total: ${u.totalTokens}`); }
    if (u.estimatedCost !== undefined) { parts.push(`Cost: $${u.estimatedCost.toFixed(4)}`); }
    if (parts.length > 0) {
      sectionsHtml += `
      <details class="section">
        <summary>Token Usage</summary>
        <pre class="tokens">${escHtml(parts.join('  |  '))}</pre>
      </details>`;
    }
  }

  if (entry.result.stderr && entry.result.stderr.trim()) {
    sectionsHtml += `
    <details class="section">
      <summary>Stderr</summary>
      <pre class="stderr">${escHtml(entry.result.stderr)}</pre>
    </details>`;
  }

  return sectionsHtml;
}

function buildBubblePair(entry: HistoryEntry): string {
  const statusLabel = entry.status === 'completed' ? 'Completed' : 'Failed';
  const statusClass = entry.status === 'completed' ? 'status-ok' : 'status-fail';
  const duration = formatDuration(entry.result.durationMs);
  const sections = buildEntrySections(entry);

  return `
    <!-- User prompt -->
    <div class="bubble-row user">
      <div>
        <div class="bubble-label">You</div>
        <div class="bubble">${escHtml(entry.prompt)}</div>
      </div>
    </div>

    <!-- Assistant response -->
    <div class="bubble-row assistant">
      <div>
        <div class="bubble-label">
          ${escHtml(entry.engine)}
          <span class="badge ${statusClass}">${statusLabel}</span>
          <span class="detail">${duration}</span>
        </div>
        <div class="bubble">${escHtml(entry.result.stdout || '(no output)')}</div>
        ${sections ? `<div class="bubble-sections">${sections}</div>` : ''}
      </div>
    </div>`;
}

// ─── Thread conversation HTML ───

function buildThreadHtml(entries: HistoryEntry[]): string {
  const title = entries.length > 0 ? escHtml(entries[0].taskName) : 'Conversation';
  const engine = entries.length > 0 ? escHtml(entries[0].engine) : '';
  const turnCount = entries.length;
  const threadId = entries.length > 0 ? escHtml(entries[0].threadId ?? entries[0].id) : '';

  let bubblesHtml = '';
  for (const entry of entries) {
    bubblesHtml += buildBubblePair(entry);
  }

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
    <button class="nav-back" id="btnBack" title="Back to thread list">&#8592; Threads</button>
    <div class="nav-title">
      <strong>${title}</strong>
      <span class="nav-meta">${engine} &middot; ${turnCount} turn${turnCount !== 1 ? 's' : ''}</span>
    </div>
    <button class="nav-delete" id="btnDelete" data-thread-id="${threadId}" title="Delete this conversation">Delete</button>
  </div>

  <!-- Chat area -->
  <div class="chat" id="chatArea">
    ${bubblesHtml}
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

// ─── Empty / thread list HTML ───

function buildEmptyHtml(threadHeads: HistoryEntry[]): string {
  let cardsHtml = '';
  if (threadHeads.length > 0) {
    cardsHtml = '<div class="thread-list">';
    for (const head of threadHeads) {
      const tid = head.threadId ?? head.id;
      const ago = timeAgo(head.startedAt);
      cardsHtml += `
      <div class="thread-card" data-thread-id="${escHtml(tid)}">
        <div class="thread-card-header">
          <div class="thread-card-title">${escHtml(head.taskName)}</div>
          <button class="thread-card-delete" data-thread-id="${escHtml(tid)}" title="Delete conversation">&#x2715;</button>
        </div>
        <div class="thread-card-meta">
          <span>${escHtml(head.engine)}</span>
          <span>&middot;</span>
          <span>${ago}</span>
        </div>
      </div>`;
    }
    cardsHtml += '</div>';
  }

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conversations</title>
  <style>${sharedStyles()}</style>
</head>
<body>

  <div class="empty-state">
    <h2>Conversations</h2>
    <p class="empty-subtitle">Select a thread to continue a conversation, or run a task to start a new one.</p>

    ${cardsHtml || '<p class="empty-hint">No conversations yet. Run a task from the Plan view to get started.</p>'}
  </div>

  <script>${emptyScript()}</script>
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
    .nav-title { flex: 1; }
    .nav-title strong { margin-right: 8px; }
    .nav-meta { opacity: 0.6; font-size: 0.85em; }
    .nav-delete {
      background: none;
      border: 1px solid var(--vscode-testing-iconFailed, #f44336);
      color: var(--vscode-testing-iconFailed, #f44336);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85em;
      margin-left: auto;
    }
    .nav-delete:hover {
      background: var(--vscode-testing-iconFailed, #f44336);
      color: #fff;
    }

    /* ── Chat area ── */
    .chat {
      flex: 1;
      overflow-y: auto;
      padding: 24px 20px;
      max-width: 800px;
      width: 100%;
      margin: 0 auto;
    }

    .bubble-row {
      display: flex;
      margin-bottom: 16px;
    }
    .bubble-row.user { justify-content: flex-end; }
    .bubble-row.assistant { justify-content: flex-start; }

    .bubble {
      max-width: 75%;
      padding: 12px 16px;
      border-radius: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
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
      font-size: 0.75em;
      opacity: 0.6;
      margin-bottom: 4px;
    }
    .bubble-row.user .bubble-label { text-align: right; }

    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 0.8em;
      font-weight: 600;
      margin-left: 6px;
    }
    .status-ok { background: var(--vscode-testing-iconPassed, #4caf50); color: #fff; }
    .status-fail { background: var(--vscode-testing-iconFailed, #f44336); color: #fff; }
    .detail { opacity: 0.7; margin-left: 6px; font-size: 0.85em; }

    .bubble-sections {
      margin-top: 8px;
      max-width: 75%;
    }

    /* ── Collapsible sections ── */
    .section {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .section summary {
      cursor: pointer;
      padding: 8px 12px;
      font-weight: 600;
      user-select: none;
    }
    .section summary:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .section pre, .section ul {
      padding: 8px 12px;
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
    .tokens { opacity: 0.85; }

    /* ── Input area ── */
    .input-area {
      display: flex;
      gap: 8px;
      padding: 12px 20px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      flex-shrink: 0;
      max-width: 800px;
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
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 48px 24px;
      text-align: center;
    }
    .empty-state h2 {
      margin-bottom: 8px;
    }
    .empty-subtitle {
      opacity: 0.7;
      margin-bottom: 24px;
    }
    .empty-hint {
      opacity: 0.5;
      font-style: italic;
      margin-top: 16px;
    }

    /* ── Thread list ── */
    .thread-list {
      width: 100%;
      max-width: 600px;
    }
    .thread-card {
      padding: 12px 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .thread-card:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .thread-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .thread-card-title {
      font-weight: 600;
    }
    .thread-card-delete {
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
    .thread-card:hover .thread-card-delete {
      opacity: 0.5;
    }
    .thread-card-delete:hover {
      opacity: 1 !important;
      color: var(--vscode-testing-iconFailed, #f44336);
      background: var(--vscode-list-hoverBackground);
    }
    .thread-card-meta {
      font-size: 0.85em;
      opacity: 0.6;
      display: flex;
      gap: 6px;
    }
  `;
}

// ─── Webview scripts ───

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
        chatArea.scrollTop = chatArea.scrollHeight;
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

      btnDelete.addEventListener('click', () => {
        const threadId = btnDelete.getAttribute('data-thread-id');
        if (threadId) {
          vscode.postMessage({ type: 'delete-thread', threadId });
        }
      });

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

            // Insert the final assistant bubble
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

function emptyScript(): string {
  return /* js */ `
    (function() {
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('.thread-card').forEach(card => {
        card.addEventListener('click', (e) => {
          // Don't navigate if the delete button was clicked
          if (e.target.closest('.thread-card-delete')) return;
          const threadId = card.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'open-thread', threadId });
          }
        });
      });
      document.querySelectorAll('.thread-card-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const threadId = btn.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'delete-thread', threadId });
          }
        });
      });
    })();
  `;
}
