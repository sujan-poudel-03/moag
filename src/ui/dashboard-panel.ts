// ─── Dashboard webview panel ───
// Provides a rich UI for task editing, play/pause/stop controls,
// live output streaming, and history viewing.

import * as vscode from 'vscode';
import { Plan, Task, Playlist, EngineResult } from '../models/types';
import { HistoryStore } from '../history/store';
import { TaskRunner } from '../runner/runner';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly runner: TaskRunner,
    private readonly historyStore: HistoryStore,
    private getPlan: () => Plan | null,
    private savePlanCallback: () => void,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this._disposables,
    );
    this.update();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    runner: TaskRunner,
    historyStore: HistoryStore,
    getPlan: () => Plan | null,
    savePlanCallback: () => void,
  ): DashboardPanel {
    const column = vscode.ViewColumn.Beside;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(column);
      DashboardPanel.currentPanel.update();
      return DashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerDashboard',
      'Agent Task Player',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel, extensionUri, runner, historyStore, getPlan, savePlanCallback,
    );
    return DashboardPanel.currentPanel;
  }

  /** Push updated state to the webview */
  public update(): void {
    this._panel.webview.postMessage({
      type: 'update',
      plan: this.getPlan(),
      runnerState: this.runner.state,
      history: this.historyStore.getAll().slice(0, 50),
    });
  }

  /** Clear the live output panel (alias for clearTimeline) */
  public clearOutput(): void {
    this.clearTimeline();
  }

  /** Append output chunk to the live output panel */
  public appendOutput(text: string, stream: 'stdout' | 'stderr', taskId?: string): void {
    this._panel.webview.postMessage({
      type: 'output',
      text,
      stream,
      taskId,
    });
  }

  /** Create a new task card in the timeline */
  public startTaskCard(task: Task, playlist: Playlist, prompt: string): void {
    this._panel.webview.postMessage({
      type: 'start-task-card',
      taskId: task.id,
      taskName: task.name,
      playlistName: playlist.name,
      engine: task.engine ?? playlist.engine,
      prompt,
    });
  }

  /** Complete a task card with result, changed files, and code diff */
  public completeTaskCard(
    task: Task,
    result: EngineResult,
    changedFiles?: string[],
    codeChanges?: string,
  ): void {
    this._panel.webview.postMessage({
      type: 'complete-task-card',
      taskId: task.id,
      taskName: task.name,
      status: task.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      changedFiles,
      codeChanges,
    });
  }

  /** Clear all task cards from the timeline */
  public clearTimeline(): void {
    this._panel.webview.postMessage({ type: 'clear-timeline' });
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'play':
        vscode.commands.executeCommand('agentTaskPlayer.play');
        break;
      case 'pause':
        vscode.commands.executeCommand('agentTaskPlayer.pause');
        break;
      case 'stop':
        vscode.commands.executeCommand('agentTaskPlayer.stop');
        break;
      case 'addPlaylist':
        vscode.commands.executeCommand('agentTaskPlayer.addPlaylist');
        break;
      case 'addTask':
        vscode.commands.executeCommand('agentTaskPlayer.addTask', msg.playlistIndex);
        break;
      case 'editTask': {
        const plan = this.getPlan();
        if (plan && typeof msg.playlistIndex === 'number' && typeof msg.taskIndex === 'number') {
          vscode.commands.executeCommand('agentTaskPlayer.editTask', {
            playlistIndex: msg.playlistIndex,
            taskIndex: msg.taskIndex,
          });
        }
        break;
      }
      case 'clearHistory':
        vscode.commands.executeCommand('agentTaskPlayer.clearHistory');
        break;
      case 'refresh':
        this.update();
        break;
    }
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  /** Generate the full HTML for the webview */
  public getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Task Player</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --success: var(--vscode-testing-iconPassed);
      --error: var(--vscode-testing-iconFailed);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      padding: 16px;
    }

    h2 { margin-bottom: 12px; font-size: 1.2em; }
    h3 { margin: 12px 0 8px; font-size: 1em; opacity: 0.8; }

    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
      align-items: center;
    }

    button {
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      padding: 6px 14px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.9em;
    }
    button:hover { background: var(--button-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }

    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.8em;
      font-weight: bold;
    }
    .status-idle { background: var(--badge-bg); color: var(--badge-fg); }
    .status-playing { background: var(--success); color: #fff; }
    .status-paused { background: #cc8800; color: #fff; }

    .section {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 16px;
    }

    .task-list { list-style: none; }
    .task-list li {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .task-list li:last-child { border-bottom: none; }

    .task-status {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .task-status.pending { border: 2px solid var(--fg); background: transparent; }
    .task-status.running { background: var(--success); animation: pulse 1s infinite; }
    .task-status.completed { background: var(--success); }
    .task-status.failed { background: var(--error); }
    .task-status.paused { background: #cc8800; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .task-name { flex: 1; }
    .task-engine { opacity: 0.6; font-size: 0.85em; }
    .task-actions button { padding: 2px 8px; font-size: 0.8em; }

    .output-panel {
      background: var(--vscode-terminal-background, #1e1e1e);
      color: var(--vscode-terminal-foreground, #ccc);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      padding: 8px;
      height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      border-radius: 4px;
    }

    /* ─── Timeline ─── */
    .timeline {
      max-height: calc(100vh - 160px);
      overflow-y: auto;
      padding: 4px 0;
    }
    .timeline-empty {
      text-align: center;
      padding: 40px;
      opacity: 0.5;
      font-style: italic;
    }

    .task-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .task-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background, rgba(255,255,255,0.03));
      border-bottom: 1px solid var(--border);
    }
    .task-card-icon {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .task-card-icon.running {
      background: var(--success);
      animation: pulse 1s infinite;
    }
    .task-card-icon.completed { background: var(--success); }
    .task-card-icon.failed { background: var(--error); }
    .task-card-title {
      flex: 1;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .task-card-meta {
      font-size: 0.8em;
      opacity: 0.6;
      white-space: nowrap;
    }
    .task-card-body { padding: 0; }

    .task-card-prompt {
      font-size: 0.85em;
      border-bottom: 1px solid var(--border);
    }
    .task-card-prompt summary {
      padding: 6px 12px;
      cursor: pointer;
      opacity: 0.7;
      font-size: 0.9em;
    }
    .task-card-prompt pre {
      background: var(--vscode-terminal-background, #1e1e1e);
      color: var(--vscode-terminal-foreground, #ccc);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 8px 12px;
      margin: 0;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .task-card-output {
      background: var(--vscode-terminal-background, #1e1e1e);
      color: var(--vscode-terminal-foreground, #ccc);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      padding: 8px 12px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      min-height: 24px;
    }

    .task-card-files {
      border-top: 1px solid var(--border);
      font-size: 0.85em;
    }
    .task-card-files summary {
      padding: 6px 12px;
      cursor: pointer;
      font-weight: 600;
    }
    .task-card-files ul {
      list-style: none;
      padding: 0 12px 8px 12px;
    }
    .task-card-files li {
      padding: 2px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .task-card-files li::before {
      content: '\u2022 ';
      opacity: 0.5;
    }

    .task-card-diff {
      border-top: 1px solid var(--border);
      font-size: 0.85em;
    }
    .task-card-diff summary {
      padding: 6px 12px;
      cursor: pointer;
      font-weight: 600;
    }
    .task-card-diff pre {
      background: var(--vscode-terminal-background, #1e1e1e);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 8px 12px;
      margin: 0;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .diff-add { color: #4ec94e; }
    .diff-del { color: #f44747; }
    .diff-hunk { color: #569cd6; }
    .diff-meta { color: #888; font-weight: bold; }

    .history-entry {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    .history-entry:hover { background: var(--vscode-list-hoverBackground); }
    .history-meta { font-size: 0.8em; opacity: 0.6; }

    .history-detail {
      display: none;
      padding: 8px 4px;
      font-size: 0.85em;
    }
    .history-entry.expanded .history-detail { display: block; }

    .detail-block {
      margin: 6px 0;
    }
    .detail-block summary {
      cursor: pointer;
      font-weight: bold;
      opacity: 0.9;
    }
    .detail-block pre {
      background: var(--vscode-terminal-background, #1e1e1e);
      color: var(--vscode-terminal-foreground, #ccc);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 6px;
      border-radius: 3px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin-top: 4px;
    }
    .detail-block.diff pre {
      color: var(--vscode-terminal-foreground, #ccc);
    }
    .detail-block .file-list {
      list-style: none;
      padding-left: 4px;
    }
    .detail-block .file-list li {
      padding: 1px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .detail-block .file-list li::before {
      content: '\u2022 ';
      opacity: 0.5;
    }
    .show-more-hint {
      font-size: 0.8em;
      opacity: 0.5;
      font-style: italic;
    }

    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .tab {
      padding: 8px 16px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      background: none;
      color: var(--fg);
    }
    .tab.active { border-bottom-color: var(--button-bg); }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .no-plan {
      text-align: center;
      padding: 40px;
      opacity: 0.6;
    }
  </style>
</head>
<body>

  <h2>Agent Task Player</h2>

  <div class="toolbar">
    <button id="btn-play" title="Play">&#9654; Play</button>
    <button id="btn-pause" title="Pause">&#10074;&#10074; Pause</button>
    <button id="btn-stop" title="Stop">&#9632; Stop</button>
    <span id="runner-status" class="status-badge status-idle">Idle</span>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="plan">Plan</div>
    <div class="tab" data-tab="output">Output</div>
    <div class="tab" data-tab="history">History</div>
  </div>

  <!-- Plan Tab -->
  <div id="tab-plan" class="tab-content active">
    <div id="plan-content"></div>
  </div>

  <!-- Output Tab -->
  <div id="tab-output" class="tab-content">
    <div class="timeline" id="timeline">
      <div class="timeline-empty" id="timeline-empty">
        No tasks running yet. Press Play to start execution.
      </div>
    </div>
  </div>

  <!-- History Tab -->
  <div id="tab-history" class="tab-content">
    <button class="secondary" id="btn-clear-history">Clear History</button>
    <div id="history-content" style="margin-top: 8px;"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Toolbar buttons
    document.getElementById('btn-play').onclick = () => vscode.postMessage({ type: 'play' });
    document.getElementById('btn-pause').onclick = () => vscode.postMessage({ type: 'pause' });
    document.getElementById('btn-stop').onclick = () => vscode.postMessage({ type: 'stop' });
    document.getElementById('btn-clear-history').onclick = () => vscode.postMessage({ type: 'clearHistory' });

    // ─── Timeline state ───
    const cardElements = {};  // taskId → { card, output, header, icon, meta }
    let currentCardId = null;

    // Receive messages from extension
    window.addEventListener('message', event => {
      const msg = event.data;

      if (msg.type === 'update') {
        renderPlan(msg.plan);
        renderStatus(msg.runnerState);
        renderHistory(msg.history || []);
      }

      if (msg.type === 'clear-output' || msg.type === 'clear-timeline') {
        clearTimeline();
      }

      if (msg.type === 'start-task-card') {
        createTaskCard(msg);
      }

      if (msg.type === 'output') {
        const targetId = msg.taskId || currentCardId;
        if (targetId && cardElements[targetId]) {
          appendToCard(targetId, msg.text, msg.stream);
        }
      }

      if (msg.type === 'complete-task-card') {
        completeTaskCard(msg);
      }
    });

    function switchToTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
      if (tab) { tab.classList.add('active'); }
      const content = document.getElementById('tab-' + tabName);
      if (content) { content.classList.add('active'); }
    }

    function clearTimeline() {
      const timeline = document.getElementById('timeline');
      timeline.innerHTML = '<div class="timeline-empty" id="timeline-empty">No tasks running yet. Press Play to start execution.</div>';
      Object.keys(cardElements).forEach(k => delete cardElements[k]);
      currentCardId = null;
    }

    function createTaskCard(msg) {
      const timeline = document.getElementById('timeline');
      const emptyEl = document.getElementById('timeline-empty');
      if (emptyEl) { emptyEl.remove(); }

      const card = document.createElement('div');
      card.className = 'task-card';
      card.id = 'card-' + msg.taskId;

      // Header
      const header = document.createElement('div');
      header.className = 'task-card-header';
      const icon = document.createElement('div');
      icon.className = 'task-card-icon running';
      const title = document.createElement('span');
      title.className = 'task-card-title';
      title.textContent = msg.taskName;
      const meta = document.createElement('span');
      meta.className = 'task-card-meta';
      const parts = [];
      if (msg.playlistName) { parts.push(msg.playlistName); }
      if (msg.engine) { parts.push(msg.engine); }
      parts.push('Running...');
      meta.textContent = parts.join(' · ');
      header.appendChild(icon);
      header.appendChild(title);
      header.appendChild(meta);

      // Body
      const body = document.createElement('div');
      body.className = 'task-card-body';

      // Prompt (collapsible)
      const promptDetails = document.createElement('details');
      promptDetails.className = 'task-card-prompt';
      const promptSummary = document.createElement('summary');
      promptSummary.textContent = 'Prompt';
      const promptPre = document.createElement('pre');
      const promptText = msg.prompt.length > 2000
        ? msg.prompt.substring(0, 2000) + '\\n... (truncated)'
        : msg.prompt;
      promptPre.textContent = promptText;
      promptDetails.appendChild(promptSummary);
      promptDetails.appendChild(promptPre);
      body.appendChild(promptDetails);

      // Output area
      const output = document.createElement('div');
      output.className = 'task-card-output';
      body.appendChild(output);

      // Completion placeholder (files + diff injected here later)
      const completion = document.createElement('div');
      completion.className = 'task-card-completion';
      body.appendChild(completion);

      card.appendChild(header);
      card.appendChild(body);
      timeline.appendChild(card);

      // Store references
      cardElements[msg.taskId] = { card, output, header, icon, meta, completion };
      currentCardId = msg.taskId;

      // Auto-switch to Output tab
      switchToTab('output');

      // Scroll card into view
      card.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    function appendToCard(taskId, text, stream) {
      const refs = cardElements[taskId];
      if (!refs) { return; }
      const span = document.createElement('span');
      span.textContent = text;
      if (stream === 'stderr') {
        span.style.color = 'var(--error, #f44)';
      }
      refs.output.appendChild(span);
      refs.output.scrollTop = refs.output.scrollHeight;

      // Also scroll the timeline to keep the active card visible
      const timeline = document.getElementById('timeline');
      timeline.scrollTop = timeline.scrollHeight;
    }

    function completeTaskCard(msg) {
      const refs = cardElements[msg.taskId];
      if (!refs) { return; }

      // Update icon
      refs.icon.className = 'task-card-icon ' + (msg.status === 'completed' ? 'completed' : 'failed');

      // Update meta
      const durStr = msg.durationMs < 1000
        ? msg.durationMs + 'ms'
        : (msg.durationMs / 1000).toFixed(1) + 's';
      const statusLabel = msg.status === 'completed' ? 'Completed' : 'Failed (exit ' + msg.exitCode + ')';
      refs.meta.textContent = statusLabel + ' · ' + durStr;

      // Inject changed files
      if (msg.changedFiles && msg.changedFiles.length > 0) {
        const filesDetails = document.createElement('details');
        filesDetails.className = 'task-card-files';
        filesDetails.open = true;
        const filesSummary = document.createElement('summary');
        filesSummary.textContent = 'Changed Files (' + msg.changedFiles.length + ')';
        const filesList = document.createElement('ul');
        msg.changedFiles.forEach(function(f) {
          const li = document.createElement('li');
          li.textContent = f;
          filesList.appendChild(li);
        });
        filesDetails.appendChild(filesSummary);
        filesDetails.appendChild(filesList);
        refs.completion.appendChild(filesDetails);
      }

      // Inject code changes diff
      if (msg.codeChanges) {
        const diffDetails = document.createElement('details');
        diffDetails.className = 'task-card-diff';
        const diffSummary = document.createElement('summary');
        diffSummary.textContent = 'Code Changes';
        const diffPre = document.createElement('pre');
        const diffText = msg.codeChanges.length > 5000
          ? msg.codeChanges.substring(0, 5000) + '\\n... (truncated)'
          : msg.codeChanges;
        diffPre.innerHTML = colorDiff(diffText);
        diffDetails.appendChild(diffSummary);
        diffDetails.appendChild(diffPre);
        refs.completion.appendChild(diffDetails);
      }

      // Scroll to bottom
      const timeline = document.getElementById('timeline');
      timeline.scrollTop = timeline.scrollHeight;
    }

    function colorDiff(diff) {
      return diff
        .split('\\n')
        .map(function(line) {
          const escaped = escHtml(line);
          if (line.startsWith('+++') || line.startsWith('---')) {
            return '<span class="diff-meta">' + escaped + '</span>';
          }
          if (line.startsWith('@@')) {
            return '<span class="diff-hunk">' + escaped + '</span>';
          }
          if (line.startsWith('+')) {
            return '<span class="diff-add">' + escaped + '</span>';
          }
          if (line.startsWith('-')) {
            return '<span class="diff-del">' + escaped + '</span>';
          }
          return escaped;
        })
        .join('\\n');
    }

    function renderStatus(state) {
      const el = document.getElementById('runner-status');
      el.textContent = state.charAt(0).toUpperCase() + state.slice(1);
      el.className = 'status-badge status-' + state;

      document.getElementById('btn-play').disabled = state === 'playing';
      document.getElementById('btn-pause').disabled = state !== 'playing';
      document.getElementById('btn-stop').disabled = state === 'idle';
    }

    function renderPlan(plan) {
      const container = document.getElementById('plan-content');
      if (!plan || !plan.playlists) {
        container.innerHTML = '<div class="no-plan">No plan loaded.<br><br>Use the toolbar to open or create a plan file.</div>';
        return;
      }

      let html = '<div style="margin-bottom:8px;"><strong>' + escHtml(plan.name) + '</strong></div>';

      plan.playlists.forEach((pl, pi) => {
        html += '<div class="section">';
        html += '<h3>' + escHtml(pl.name) + ' <span class="task-engine">(' + (pl.engine || plan.defaultEngine) + ')</span></h3>';
        html += '<ul class="task-list">';

        pl.tasks.forEach((task, ti) => {
          html += '<li>';
          html += '<div class="task-status ' + task.status + '"></div>';
          html += '<span class="task-name">' + escHtml(task.name) + '</span>';
          html += '<span class="task-engine">' + (task.engine || '') + '</span>';
          html += '<span class="task-actions">';
          html += '<button onclick="editTask(' + pi + ',' + ti + ')">Edit</button>';
          html += '</span>';
          html += '</li>';
        });

        html += '</ul>';
        html += '<button class="secondary" onclick="addTask(' + pi + ')">+ Add Task</button>';
        html += '</div>';
      });

      html += '<button class="secondary" onclick="addPlaylist()">+ Add Playlist</button>';
      container.innerHTML = html;
    }

    function renderHistory(entries) {
      const container = document.getElementById('history-content');
      if (!entries.length) {
        container.innerHTML = '<div class="no-plan">No history yet.</div>';
        return;
      }

      let html = '';
      entries.forEach((entry, idx) => {
        const icon = entry.status === 'completed' ? '&#10004;' : '&#10008;';
        const color = entry.status === 'completed' ? 'var(--success)' : 'var(--error)';
        const time = entry.startedAt.split('T')[1]?.substring(0, 8) || '';
        html += '<div class="history-entry" id="hist-' + idx + '" onclick="toggleHistory(' + idx + ')">';
        html += '<span style="color:' + color + '">' + icon + '</span> ';
        html += '<strong>' + escHtml(entry.taskName) + '</strong>';
        html += '<div class="history-meta">' + time + ' | ' + entry.engine + ' | ' + entry.result.durationMs + 'ms | exit ' + entry.result.exitCode + '</div>';

        // Expandable detail section
        html += '<div class="history-detail">';

        // Command
        if (entry.result.command) {
          html += '<div class="detail-block"><summary>Command</summary>';
          html += '<pre>' + escHtml(entry.result.command) + '</pre></div>';
        }

        // Prompt (truncated)
        if (entry.prompt) {
          const promptText = entry.prompt.length > 300
            ? entry.prompt.substring(0, 300) + '...'
            : entry.prompt;
          html += '<div class="detail-block"><summary>Prompt</summary>';
          html += '<pre>' + escHtml(promptText) + '</pre>';
          if (entry.prompt.length > 300) {
            html += '<div class="show-more-hint">Truncated. Use sidebar History for full view.</div>';
          }
          html += '</div>';
        }

        // Output (truncated)
        if (entry.result.stdout) {
          const outText = entry.result.stdout.length > 500
            ? entry.result.stdout.substring(0, 500) + '...'
            : entry.result.stdout;
          html += '<div class="detail-block"><summary>Output</summary>';
          html += '<pre>' + escHtml(outText) + '</pre>';
          if (entry.result.stdout.length > 500) {
            html += '<div class="show-more-hint">Truncated. Use sidebar History for full view.</div>';
          }
          html += '</div>';
        }

        // Changed files
        if (entry.changedFiles && entry.changedFiles.length > 0) {
          html += '<div class="detail-block"><summary>Changed Files (' + entry.changedFiles.length + ')</summary>';
          html += '<ul class="file-list">';
          entry.changedFiles.forEach(function(f) {
            html += '<li>' + escHtml(f) + '</li>';
          });
          html += '</ul></div>';
        }

        // Code diff (truncated)
        if (entry.codeChanges) {
          const diffText = entry.codeChanges.length > 2000
            ? entry.codeChanges.substring(0, 2000) + '\n... (truncated)'
            : entry.codeChanges;
          html += '<div class="detail-block diff"><summary>Code Changes</summary>';
          html += '<pre>' + escHtml(diffText) + '</pre></div>';
        }

        // Token usage
        if (entry.result.tokenUsage) {
          const u = entry.result.tokenUsage;
          let usageText = '';
          if (u.inputTokens) { usageText += 'In: ' + u.inputTokens; }
          if (u.outputTokens) { usageText += (usageText ? ' | ' : '') + 'Out: ' + u.outputTokens; }
          if (u.totalTokens) { usageText += (usageText ? ' | ' : '') + 'Total: ' + u.totalTokens; }
          if (u.estimatedCost) { usageText += (usageText ? ' | ' : '') + '$' + u.estimatedCost.toFixed(4); }
          if (usageText) {
            html += '<div class="detail-block"><summary>Token Usage</summary>';
            html += '<pre>' + escHtml(usageText) + '</pre></div>';
          }
        }

        html += '</div>'; // .history-detail
        html += '</div>'; // .history-entry
      });
      container.innerHTML = html;
    }

    function toggleHistory(idx) {
      const el = document.getElementById('hist-' + idx);
      if (el) {
        el.classList.toggle('expanded');
      }
    }

    function escHtml(s) {
      const div = document.createElement('div');
      div.textContent = s || '';
      return div.innerHTML;
    }

    function addPlaylist() { vscode.postMessage({ type: 'addPlaylist' }); }
    function addTask(pi) { vscode.postMessage({ type: 'addTask', playlistIndex: pi }); }
    function editTask(pi, ti) { vscode.postMessage({ type: 'editTask', playlistIndex: pi, taskIndex: ti }); }

    // Request initial data
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}
