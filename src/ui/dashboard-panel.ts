// ─── Dashboard webview panel ───
// Provides a rich UI for task editing, play/pause/stop controls,
// live output streaming, and history viewing.

import * as vscode from 'vscode';
import { Plan } from '../models/types';
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

  /** Append output chunk to the live output panel */
  public appendOutput(text: string, stream: 'stdout' | 'stderr'): void {
    this._panel.webview.postMessage({
      type: 'output',
      text,
      stream,
    });
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

    .history-entry {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    .history-entry:hover { background: var(--vscode-list-hoverBackground); }
    .history-meta { font-size: 0.8em; opacity: 0.6; }

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
    <div class="output-panel" id="output-panel"></div>
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

    // Receive messages from extension
    window.addEventListener('message', event => {
      const msg = event.data;

      if (msg.type === 'update') {
        renderPlan(msg.plan);
        renderStatus(msg.runnerState);
        renderHistory(msg.history || []);
      }

      if (msg.type === 'output') {
        const panel = document.getElementById('output-panel');
        const span = document.createElement('span');
        span.textContent = msg.text;
        if (msg.stream === 'stderr') {
          span.style.color = 'var(--error, #f44)';
        }
        panel.appendChild(span);
        panel.scrollTop = panel.scrollHeight;
      }
    });

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
      entries.forEach(entry => {
        const icon = entry.status === 'completed' ? '&#10004;' : '&#10008;';
        const color = entry.status === 'completed' ? 'var(--success)' : 'var(--error)';
        const time = entry.startedAt.split('T')[1]?.substring(0, 8) || '';
        html += '<div class="history-entry">';
        html += '<span style="color:' + color + '">' + icon + '</span> ';
        html += '<strong>' + escHtml(entry.taskName) + '</strong>';
        html += '<div class="history-meta">' + time + ' | ' + entry.engine + ' | ' + entry.result.durationMs + 'ms | exit ' + entry.result.exitCode + '</div>';
        html += '</div>';
      });
      container.innerHTML = html;
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
