// ─── Dashboard webview panel ───
// Provides a rich UI for task editing, play/pause/stop controls,
// live output streaming, and history viewing.

import * as vscode from 'vscode';
import { Plan, Task, Playlist, EngineResult, VerificationResult, TaskArtifact } from '../models/types';
import { HistoryStore } from '../history/store';
import { TaskRunner } from '../runner/runner';

// Diagnostic output channel for debugging dashboard issues
const outputChannel = vscode.window.createOutputChannel('ATP Dashboard');

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _outputBuffer: { text: string; stream: 'stdout' | 'stderr'; taskId?: string }[] = [];
  private _outputFlushTimer: ReturnType<typeof setInterval> | null = null;
  private _webviewReadyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;
  private _webviewReady = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly runner: TaskRunner,
    private readonly historyStore: HistoryStore,
    private getPlan: () => Plan | null,
    private savePlanCallback: () => void,
  ) {
    this._panel = panel;
    // Register handlers BEFORE setting HTML so the initial webview-ready
    // handshake cannot race the extension-side listener.
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this._disposables,
    );
    const plan = this.getPlan();
    outputChannel.appendLine(`[constructor] getPlan() returned: ${plan ? plan.name + ' (' + plan.playlists.length + ' playlists)' : 'null'}`);
    this.renderWebview();

    // Resend state whenever the panel becomes visible (e.g. user switches tabs)
    this._panel.onDidChangeViewState(
      () => { if (this._panel.visible) { this.update(); } },
      null,
      this._disposables,
    );
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
      outputChannel.appendLine(`[createOrShow] reusing existing panel, webviewReady=${DashboardPanel.currentPanel._webviewReady}`);
      DashboardPanel.currentPanel._panel.reveal(column);
      if (!DashboardPanel.currentPanel._webviewReady) {
        DashboardPanel.currentPanel.renderWebview();
      } else {
        DashboardPanel.currentPanel.update();
      }
      return DashboardPanel.currentPanel;
    }
    outputChannel.appendLine('[createOrShow] creating new panel');

    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerDashboard',
      'MOAG',
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

  private renderWebview(): void {
    this.clearWebviewReadyFallback();
    this._webviewReady = false;
    this._panel.webview.html = this.getHtml();
    this._webviewReadyFallbackTimer = setTimeout(() => {
      this._webviewReadyFallbackTimer = null;
      if (!this._webviewReady) {
        outputChannel.appendLine('[renderWebview] webview-ready handshake timed out; sending fallback update');
        this.update();
      }
    }, 3000);
  }

  private clearWebviewReadyFallback(): void {
    if (this._webviewReadyFallbackTimer) {
      clearTimeout(this._webviewReadyFallbackTimer);
      this._webviewReadyFallbackTimer = null;
    }
  }

  /** Safely post a message to the webview (no-op if disposed) */
  private safePostMessage(msg: unknown): void {
    if (this._disposed) { return; }
    try {
      this._panel.webview.postMessage(msg);
    } catch {
      // Panel was disposed between check and post — ignore
    }
  }

  /**
   * The webview is sometimes not ready the moment the panel is created.
   * Retry stateful UI events so the dashboard does not miss task lifecycle updates.
   */
  private postMessageWithRetries(msg: unknown, delays = [0, 200, 600]): void {
    for (const delay of delays) {
      if (delay === 0) {
        this.safePostMessage(msg);
        continue;
      }
      setTimeout(() => this.safePostMessage(msg), delay);
    }
  }

  /** Push updated state to the webview */
  public update(): void {
    const plan = this.getPlan();
    outputChannel.appendLine(`[update] plan=${plan ? plan.name : 'null'}, webviewReady=${this._webviewReady}, disposed=${this._disposed}`);
    this.postMessageWithRetries({
      type: 'update',
      plan,
      runnerState: this.runner.state,
      history: this.historyStore.getAll().slice(0, 50),
      services: this.runner.getRunningServices(),
    }, this._webviewReady ? [0] : [0, 200, 600]);
  }

  /** Clear the live output panel (alias for clearTimeline) */
  public clearOutput(): void {
    this.clearTimeline();
  }

  /** Notify the webview about an engine fallback due to rate limiting */
  public postEngineFallback(fromEngine: string, toEngine: string): void {
    this.safePostMessage({ type: 'engine-fallback', fromEngine, toEngine });
  }

  /** Append output chunk to the live output panel (rate-limited to prevent webview freeze) */
  public appendOutput(text: string, stream: 'stdout' | 'stderr', taskId?: string): void {
    this._outputBuffer.push({ text, stream, taskId });
    if (!this._outputFlushTimer) {
      this._outputFlushTimer = setInterval(() => this._flushOutput(), 150);
    }
  }

  private _flushOutput(): void {
    if (this._outputBuffer.length === 0) {
      if (this._outputFlushTimer) {
        clearInterval(this._outputFlushTimer);
        this._outputFlushTimer = null;
      }
      return;
    }
    // Batch all pending chunks into a single message
    const batch = this._outputBuffer.splice(0);
    const combined = batch.map(b => b.text).join('');
    const stream = batch[batch.length - 1].stream;
    const taskId = batch[batch.length - 1].taskId;
    this.safePostMessage({
      type: 'output',
      text: combined,
      stream,
      taskId,
    });
  }

  /** Create a new task card in the timeline */
  public startTaskCard(task: Task, playlist: Playlist, prompt: string): void {
    this.postMessageWithRetries({
      type: 'start-task-card',
      taskId: task.id,
      taskName: task.name,
      playlistName: playlist.name,
      taskType: task.type ?? 'agent',
      engine: task.engine ?? playlist.engine,
      command: task.command || '',
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      expectedArtifacts: task.expectedArtifacts ?? [],
      ownerNote: task.ownerNote || '',
      failurePolicy: task.failurePolicy || 'continue',
      prompt,
    });
  }

  /** Complete a task card with result, changed files, and code diff */
  public completeTaskCard(
    task: Task,
    result: EngineResult,
    changedFiles?: string[],
    codeChanges?: string,
    verification?: VerificationResult,
    artifacts?: TaskArtifact[],
    autoFixed?: boolean,
  ): void {
    // Send stderr/stdout snippet so the dashboard can show WHY a task failed
    const stderrSnippet = result.stderr
      ? result.stderr.substring(0, 2000)
      : '';
    const stdoutTail = result.stdout
      ? result.stdout.substring(Math.max(0, result.stdout.length - 1000))
      : '';

    this.postMessageWithRetries({
      type: 'complete-task-card',
      taskId: task.id,
      taskName: task.name,
      status: task.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stderr: stderrSnippet,
      stdoutTail,
      command: result.command || '',
      summary: result.summary || '',
      changedFiles,
      codeChanges,
      verification,
      artifacts,
      autoFixed: autoFixed || false,
    });
  }

  /** Clear all task cards from the timeline */
  public clearTimeline(): void {
    this.postMessageWithRetries({ type: 'clear-timeline' });
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    outputChannel.appendLine(`[handleMessage] type=${msg.type}`);
    switch (msg.type) {
      case 'webview-ready':
        if (this._webviewReady) {
          break;
        }
        this._webviewReady = true;
        this.clearWebviewReadyFallback();
        this.update();
        break;
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
      case 'switch-engine':
        vscode.commands.executeCommand('agentTaskPlayer.switchEngine');
        break;
      case 'viewTaskOutput': {
        // Open full output for a completed/failed task
        const taskId = msg.taskId as string | undefined;
        if (taskId) {
          const entries = this.historyStore.getForTask(taskId);
          if (entries.length > 0) {
            const entry = entries[0]; // newest first
            const content = [
              `# Task: ${entry.taskName}`,
              `Engine: ${entry.engine} | Status: ${entry.status} | Duration: ${entry.result.durationMs}ms`,
              entry.taskType ? `Type: ${entry.taskType}` : '',
              entry.result.summary ? `Summary: ${entry.result.summary}` : '',
              entry.result.command ? `Command: ${entry.result.command}` : '',
              entry.verification ? `Verify: ${entry.verification.command} -> ${entry.verification.passed ? 'pass' : 'fail'}` : '',
              '',
              '## stdout',
              entry.result.stdout || '(no output)',
              '',
              entry.result.stderr ? `## stderr\n${entry.result.stderr}` : '',
              entry.artifacts?.length ? `\n## Artifacts\n${entry.artifacts.map(artifact => `${artifact.target}: ${artifact.exists ? 'present' : 'missing'}`).join('\n')}` : '',
              entry.changedFiles?.length ? `\n## Changed Files\n${entry.changedFiles.join('\n')}` : '',
              entry.codeChanges ? `\n## Code Changes\n${entry.codeChanges}` : '',
            ].filter(Boolean).join('\n');
            vscode.workspace.openTextDocument({ content, language: 'markdown' })
              .then(doc => vscode.window.showTextDocument(doc, { preview: true }));
          } else {
            vscode.window.showInformationMessage('No execution history found for this task.');
          }
        }
        break;
      }
      case 'retryTask': {
        const taskId = msg.taskId as string | undefined;
        if (taskId) {
          // Find the task's tree item indices to call retryTask
          const plan = this.getPlan();
          if (plan) {
            for (let pi = 0; pi < plan.playlists.length; pi++) {
              for (let ti = 0; ti < plan.playlists[pi].tasks.length; ti++) {
                if (plan.playlists[pi].tasks[ti].id === taskId) {
                  vscode.commands.executeCommand('agentTaskPlayer.retryTask', {
                    kind: 'task', playlistIndex: pi, taskIndex: ti, label: plan.playlists[pi].tasks[ti].name,
                  });
                  return;
                }
              }
            }
          }
        }
        break;
      }
      case 'open-diff': {
        const diffTaskId = msg.taskId as string | undefined;
        if (diffTaskId) {
          const entries = this.historyStore.getForTask(diffTaskId);
          const entry = entries[0];
          if (entry?.codeChanges) {
            const os = require('os') as typeof import('os');
            const tmpPath = require('path').join(os.tmpdir(), `moag-diff-${diffTaskId}.diff`);
            require('fs').writeFileSync(tmpPath, entry.codeChanges, 'utf-8');
            vscode.workspace.openTextDocument(tmpPath)
              .then(doc => vscode.window.showTextDocument(doc, { preview: true }));
          }
        }
        break;
      }
      case 'create-pr':
        vscode.commands.executeCommand('agentTaskPlayer.createPR');
        break;
      case 'refresh':
        this.update();
        break;
      case 'review-changes':
        vscode.commands.executeCommand('agentTaskPlayer.reviewChanges');
        break;
      case 'switch-plan':
        vscode.commands.executeCommand('agentTaskPlayer.switchPlan');
        break;
      case 'new-plan':
        vscode.commands.executeCommand('agentTaskPlayer.createPlan');
        break;
      case 'export-results':
        vscode.commands.executeCommand('agentTaskPlayer.exportResults');
        break;
      case 'retry-failed':
        vscode.commands.executeCommand('agentTaskPlayer.retryFailed').then(undefined, () => {
          vscode.commands.executeCommand('agentTaskPlayer.play');
        });
        break;
    }
  }

  private dispose(): void {
    this._disposed = true;
    DashboardPanel.currentPanel = undefined;
    this.clearWebviewReadyFallback();
    if (this._outputFlushTimer) {
      clearInterval(this._outputFlushTimer);
      this._outputFlushTimer = null;
    }
    this._outputBuffer = [];
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  /** Generate the full HTML for the webview */
  public getHtml(): string {
    // Encode initial state as base64 so prompt/task text cannot break the inline script.
    const plan = this.getPlan();
    outputChannel.appendLine(`[getHtml] plan=${plan ? plan.name + ' (' + plan.playlists?.length + ' playlists, ' + plan.playlists?.reduce((s: number, p: { tasks: unknown[] }) => s + p.tasks.length, 0) + ' tasks)' : 'null'}`);
    const initialStateBase64 = Buffer.from(JSON.stringify({
      plan,
      runnerState: this.runner.state,
      history: this.historyStore.getAll().slice(0, 50),
    }), 'utf8').toString('base64');
    outputChannel.appendLine(`[getHtml] base64 length=${initialStateBase64.length}`);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MOAG</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, rgba(128,128,128,0.2));
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --success: var(--vscode-testing-iconPassed, #4caf50);
      --error: var(--vscode-testing-iconFailed, #f44747);
      --warning: var(--vscode-editorWarning-foreground, #cca700);
      --dimmed: var(--vscode-disabledForeground, rgba(128,128,128,0.6));
      --sidebar-bg: var(--vscode-sideBar-background, var(--bg));
      --terminal-bg: var(--vscode-terminal-background, #1e1e1e);
      --terminal-fg: var(--vscode-terminal-foreground, #ccc);
      --hover-bg: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
      --focus-border: var(--vscode-focusBorder, #007acc);
      --progress-bg: var(--vscode-progressBar-background, #007acc);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      height: 100vh;
      width: 100vw;
      max-width: 100vw;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ─── Scrollbar ─── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.3)); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.5)); }

    /* ─── Header ─── */
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      background: var(--sidebar-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-height: 44px;
    }
    .plan-name {
      font-weight: 600;
      font-size: 12px;
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      font-family: inherit;
      padding: 0;
      text-align: left;
    }
    .plan-name:hover { opacity: 0.8; }
    .plan-name:focus-visible { outline: 1px solid var(--focus-border); }
    .status-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 8px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }
    .status-idle { background: var(--badge-bg); color: var(--badge-fg); }
    .status-playing { background: var(--success); color: #fff; }
    .status-paused { background: var(--warning); color: #000; }
    .status-stopping { background: var(--error); color: #fff; }
    .transport {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .icon-btn {
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--fg);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: background 0.1s;
    }
    .icon-btn:hover { background: var(--hover-bg); }
    .icon-btn:disabled { opacity: 0.3; cursor: default; }
    .icon-btn:disabled:hover { background: transparent; }
    .icon-btn.primary { background: var(--button-bg); color: var(--button-fg); }
    .icon-btn.primary:hover { background: var(--button-hover); }
    .icon-btn.primary:disabled { background: var(--button-bg); opacity: 0.4; }

    /* ─── Pipeline Section ─── */
    .pipeline {
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .progress-track {
      height: 3px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 6px;
    }
    .progress-fill {
      height: 100%;
      background: var(--progress-bg);
      border-radius: 2px;
      transition: width 0.4s ease;
      width: 0%;
    }
    .progress-fill.has-errors {
      background: linear-gradient(90deg, var(--success) 0%, var(--success) var(--pass-pct), var(--error) var(--pass-pct), var(--error) 100%);
    }
    .stats-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: var(--dimmed);
      min-height: 16px;
    }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      max-height: 200px;
      overflow-y: auto;
    }
    .pill-row.collapsed {
      max-height: 0;
      overflow: hidden;
      margin: 0;
    }
    /* Compact minimap mode for large plans (>30 tasks) */
    .pill-row.minimap {
      gap: 2px;
      max-height: 22px;
      overflow: hidden;
    }
    .pill-row.minimap .pill-separator { display: none; }
    .pill-row.minimap .task-pill {
      width: 6px; min-width: 6px; max-width: 6px;
      height: 6px;
      border-radius: 1px;
      font-size: 0;
      line-height: 6px;
      padding: 0;
      border: none;
    }
    .pill-row.minimap.expanded {
      max-height: 60px;
      overflow-y: auto;
    }
    .pill-row.minimap.expanded .task-pill {
      width: 10px; min-width: 10px; max-width: 10px;
      height: 10px;
      line-height: 10px;
      border-radius: 2px;
    }
    .pill-separator {
      width: 1px;
      background: var(--border);
      margin: 2px 2px;
      align-self: stretch;
    }
    .task-pill {
      height: 22px;
      width: 22px;
      min-width: 22px;
      max-width: 22px;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 600;
      line-height: 22px;
      text-align: center;
      cursor: default;
      transition: all 0.2s;
      border: 1px solid transparent;
    }
    .task-pill.pending {
      background: rgba(128,128,128,0.12);
      color: var(--dimmed);
      border-color: rgba(128,128,128,0.2);
    }
    .task-pill.running {
      background: rgba(76,175,80,0.15);
      color: var(--success);
      border-color: var(--success);
      animation: pill-pulse 1.5s ease-in-out infinite;
    }
    .task-pill.completed {
      background: rgba(76,175,80,0.15);
      color: var(--success);
    }
    .task-pill.failed {
      background: rgba(244,71,71,0.15);
      color: var(--error);
    }
    .task-pill.skipped {
      background: rgba(128,128,128,0.08);
      color: var(--dimmed);
      text-decoration: line-through;
    }
    @keyframes pill-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* ─── Main Content (scrollable) ─── */
    .main-content {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      min-height: 0;
      max-width: 100%;
      width: 100%;
    }

    /* ─── Active Task Panel ─── */
    .active-task {
      display: none;
      flex-direction: column;
      flex-grow: 1;
      margin: 0 6px;
      border: 1px solid var(--focus-border);
      border-radius: 4px;
      overflow: hidden;
      min-height: 0;
    }
    .active-task.visible {
      display: flex;
    }
    .active-task-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 0 10px;
      background: rgba(0,122,204,0.04);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .active-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      flex-shrink: 0;
      animation: dot-pulse 1s ease-in-out infinite;
    }
    @keyframes dot-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.7); opacity: 0.4; }
    }
    .active-task-name {
      flex: 1;
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .engine-badge {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      letter-spacing: 0.4px;
      flex-shrink: 0;
    }
    .engine-claude { background: #e8a04c22; color: #e8a04c; }
    .engine-codex { background: #4caf5022; color: #4caf50; }
    .engine-gemini { background: #4285f422; color: #4285f4; }
    .engine-ollama { background: #9c27b022; color: #9c27b0; }
    .engine-custom { background: rgba(128,128,128,0.15); color: var(--dimmed); }
    .autofix-badge {
      display: inline-block;
      font-size: 9px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 3px;
      margin-left: 6px;
      background: rgba(56, 132, 244, 0.15);
      color: #3884f4;
      vertical-align: middle;
    }
    .active-timer {
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--dimmed);
      flex-shrink: 0;
    }
    /* ─ Diff viewer ─ */
    .diff-section {
      margin-top: 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    .diff-section summary {
      padding: 6px 10px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      background: rgba(128,128,128,0.08);
      user-select: none;
    }
    .diff-section summary:hover { background: rgba(128,128,128,0.14); }
    .diff-view {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.5;
      overflow-x: auto;
      padding: 8px;
      margin: 0;
      white-space: pre;
    }
    .diff-add { background: rgba(78,201,176,0.15); color: inherit; }
    .diff-remove { background: rgba(244,71,71,0.15); color: inherit; }
    .diff-hunk { color: var(--dimmed); font-style: italic; }
    .diff-header { font-weight: 700; color: var(--fg); }
    .diff-file-summary {
      font-size: 10px;
      color: var(--dimmed);
      padding: 4px 10px;
      border-bottom: 1px solid var(--border);
    }
    .diff-actions {
      display: flex;
      gap: 6px;
      padding: 4px 10px;
      border-top: 1px solid var(--border);
    }
    .diff-actions button {
      font-size: 10px;
      padding: 2px 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .diff-actions button:hover { opacity: 0.85; }
    /* ─── Shared terminal output style ─── */
    .terminal-output {
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      word-wrap: break-word;
      line-height: 1.4;
    }
    .active-task-output {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 8px 10px;
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.5;
      max-width: 100%;
    }
    .active-output-empty {
      color: var(--dimmed);
      white-space: normal;
      line-height: 1.5;
    }
    .active-output-empty::after {
      content: '\\25AE';
      display: inline-block;
      animation: cursor-blink 1s step-end infinite;
      margin-left: 4px;
      color: var(--success);
    }
    @keyframes cursor-blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    /* ─── Collapsible Section Headers (VS Code tree-view style) ─── */
    .section-toggle {
      display: flex;
      align-items: center;
      gap: 0;
      padding: 0;
      cursor: pointer;
      user-select: none;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      color: var(--fg);
      height: 22px;
      line-height: 22px;
      border-radius: 0;
    }
    .section-toggle:hover { background: var(--hover-bg); }
    .section-toggle:focus-visible { outline: 1px solid var(--focus-border); outline-offset: -1px; }
    .section-toggle-icon {
      font-size: 12px;
      width: 20px;
      text-align: center;
      flex-shrink: 0;
      transition: transform 0.1s ease;
      opacity: 0.8;
    }
    .section-toggle.collapsed .section-toggle-icon {
      transform: rotate(-90deg);
    }
    .section-toggle-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      flex: 1;
    }
    .section-toggle-count {
      font-size: 10px;
      font-weight: normal;
      opacity: 0.6;
      padding-right: 8px;
    }
    .section-body {
      overflow: hidden;
    }
    .section-body.collapsed {
      max-height: 0 !important;
      overflow: hidden;
    }

    /* ─── Completed Tasks List ─── */
    .completed-section {
      padding: 0 8px 8px;
      flex-shrink: 1;
      overflow-y: auto;
      min-height: 0;
    }
    /* Completed section compact styling is in the execution mode block below */
    .section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--dimmed);
      padding: 10px 4px 6px;
    }
    .completed-task {
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 4px;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .completed-task:hover { border-color: rgba(128,128,128,0.4); }
    .completed-task.failed-task { border-left: 3px solid var(--error); }
    .completed-task-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .completed-task-row:hover { background: var(--hover-bg); }
    .ct-icon {
      font-size: 12px;
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }
    .ct-icon.pass { color: var(--success); }
    .ct-icon.fail { color: var(--error); }
    .ct-icon.skip { color: var(--dimmed); }
    .ct-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ct-stats {
      font-size: 10px;
      color: var(--dimmed);
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .ct-detail {
      display: none;
      border-top: 1px solid var(--border);
    }
    .completed-task.expanded .ct-detail { display: block; }
    .ct-detail-output {
      padding: 6px 8px;
      max-height: 200px;
    }
    .ct-detail-section {
      border-top: 1px solid var(--border);
      font-size: 11px;
    }
    .ct-detail-section summary {
      padding: 5px 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
    }
    .ct-detail-section pre {
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 6px 8px;
      margin: 0;
      max-height: 250px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .ct-detail-section ul {
      list-style: none;
      padding: 4px 8px;
    }
    .ct-detail-section li {
      padding: 1px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .ct-detail-section li::before { content: '\\2022 '; opacity: 0.4; }

    /* ─── Plan Overview ─── */
    .plan-section {
      padding: 8px;
      min-height: 0;
      overflow-y: auto;
    }
    .plan-overview {
      display: grid;
      gap: 8px;
    }
    .plan-overview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 2px 4px;
    }
    .plan-overview-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--dimmed);
    }
    .plan-overview-meta {
      font-size: 11px;
      color: var(--dimmed);
    }
    .plan-placeholder {
      padding: 16px 14px;
      border: 1px dashed var(--border);
      border-radius: 6px;
      color: var(--dimmed);
      font-size: 12px;
      line-height: 1.6;
      background: rgba(128,128,128,0.05);
    }
    .playlist-summary-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      display: grid;
      gap: 8px;
      background: rgba(128,128,128,0.05);
    }
    .playlist-summary-card.is-running {
      border-color: rgba(76,175,80,0.5);
      background: rgba(76,175,80,0.08);
    }
    .playlist-summary-card.has-failure {
      border-color: rgba(244,71,71,0.45);
    }
    .playlist-summary-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .playlist-summary-name {
      font-size: 11px;
      font-weight: 600;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .playlist-summary-status {
      font-size: 10px;
      font-weight: 600;
      color: var(--dimmed);
      flex-shrink: 0;
      text-transform: capitalize;
    }
    .playlist-summary-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 11px;
      color: var(--dimmed);
    }
    .playlist-engine {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 4px;
      border-radius: 2px;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }
    .playlist-summary-mode {
      font-size: 10px;
      color: var(--dimmed);
    }
    .playlist-summary-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .summary-chip {
      font-size: 10px;
      padding: 3px 7px;
      border-radius: 999px;
      background: rgba(128,128,128,0.12);
      color: var(--dimmed);
      border: 1px solid transparent;
    }
    .summary-chip.pass {
      background: rgba(76,175,80,0.14);
      color: var(--success);
      border-color: rgba(76,175,80,0.22);
    }
    .summary-chip.fail {
      background: rgba(244,71,71,0.14);
      color: var(--error);
      border-color: rgba(244,71,71,0.22);
    }
    .summary-chip.running {
      background: rgba(0,122,204,0.14);
      color: var(--focus-border);
      border-color: rgba(0,122,204,0.22);
    }
    .summary-chip.pending {
      background: rgba(128,128,128,0.09);
      color: var(--dimmed);
    }
    .playlist-summary-foot {
      font-size: 11px;
      color: var(--dimmed);
      line-height: 1.5;
    }
    .task-pill.current-task {
      box-shadow: inset 0 0 0 1px var(--focus-border), 0 0 0 1px rgba(0,122,204,0.16);
    }

    /* ─── History / Info panel ─── */
    .info-panel-body-wrap {
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      max-height: 280px;
      position: relative;
    }
    .info-panel-tabs {
      display: flex;
      align-items: center;
      gap: 0;
      padding: 0 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .info-tab {
      background: none;
      border: none;
      color: var(--dimmed);
      cursor: pointer;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 6px 10px 5px;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .info-tab:hover { color: var(--fg); }
    .info-tab.active {
      color: var(--accent, var(--fg));
      border-bottom-color: var(--accent, var(--fg));
    }
    .info-panel-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0 8px;
    }
    .info-pane { display: none; }
    .info-pane.active { display: block; }
    .history-clear-btn {
      background: none;
      border: none;
      color: var(--dimmed);
      cursor: pointer;
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 2px;
      margin-left: auto;
    }
    .history-clear-btn:hover { color: var(--error); background: var(--hover-bg); }
    .hist-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 4px;
      font-size: 11px;
      cursor: pointer;
      border-radius: 3px;
    }
    .hist-row:hover { background: var(--hover-bg); }
    .hist-icon { font-size: 11px; flex-shrink: 0; width: 14px; text-align: center; }
    .hist-icon.pass { color: var(--success); }
    .hist-icon.fail { color: var(--error); }
    .hist-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hist-meta { font-size: 10px; color: var(--dimmed); flex-shrink: 0; min-width: 50px; text-align: right; }
    .hist-detail {
      display: none;
      padding: 4px 4px 8px 20px;
    }
    .hist-row.expanded + .hist-detail { display: block; }
    .hist-detail pre {
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 6px;
      border-radius: 3px;
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 2px 0;
    }

    /* ─── Status Bar ─── */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      padding: 0 12px;
      border-top: 1px solid var(--border);
      background: var(--sidebar-bg);
      font-size: 11px;
      color: var(--dimmed);
      flex-shrink: 0;
    }
    .status-bar .spacer { flex: 1; }

    /* ─── Inline error for failed tasks ─── */
    .ct-error-line {
      font-size: 11px;
      color: var(--error);
      padding: 4px 8px 4px 28px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ─── Collapsible error output in failed task cards ─── */
    .ct-error-output {
      border-top: 1px solid rgba(244,71,71,0.2);
      font-size: 11px;
    }
    .ct-error-output summary {
      padding: 5px 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
      color: var(--error);
      background: rgba(244,71,71,0.06);
    }
    .ct-error-output summary:hover {
      background: rgba(244,71,71,0.12);
    }
    .ct-error-output pre {
      background: rgba(244,71,71,0.08);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 6px 8px;
      margin: 0;
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      border-top: 1px solid rgba(244,71,71,0.15);
    }

    /* ─── Executing layout ─── */
    body[data-dashboard-state="executing"] .main-content {
      overflow: hidden;
    }
    body[data-dashboard-state="executing"] .pipeline {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-height: 30px;
      padding: 0 12px;
    }
    body[data-dashboard-state="executing"] .progress-track {
      margin-bottom: 0;
    }
    body[data-dashboard-state="executing"] .stats-row {
      white-space: nowrap;
      justify-content: flex-end;
    }
    body[data-dashboard-state="executing"] .active-task {
      margin: 0 6px;
      flex: 1;
    }
    body[data-dashboard-state="executing"] #pill-row,
    body[data-dashboard-state="executing"] #pill-toggle {
      display: none !important;
    }
    body[data-dashboard-state="complete"] .main-content {
      overflow: hidden;
    }
    body[data-dashboard-state="complete"] .completed-section {
      flex: 1;
    }

    /* ─── Diff colors ─── */
    .diff-add { color: #4ec94e; }
    .diff-hunk { color: #569cd6; }

    /* ─── Result banner ─── */
    .result-banner {
      margin: 8px;
      padding: 12px 14px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: rgba(128,128,128,0.08);
    }
    .result-banner.result-success {
      background: rgba(78,201,176,0.12);
      border-color: rgba(78,201,176,0.5);
    }
    .result-banner.result-warning {
      background: rgba(200,140,40,0.12);
      border-color: rgba(220,160,50,0.6);
    }
    .result-banner-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .result-banner-copy {
      min-width: 0;
      flex: 1;
    }
    .result-banner-title {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .result-banner.result-success .result-banner-title {
      color: var(--success);
    }
    .result-banner.result-warning .result-banner-title {
      color: #e8a838;
    }
    .result-banner-meta {
      font-size: 11px;
      color: var(--dimmed);
      line-height: 1.5;
    }
    .result-banner-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .result-banner-btn {
      padding: 5px 14px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      border: 1px solid transparent;
    }
    .result-banner.result-success .result-banner-btn {
      background: rgba(78,201,176,0.18);
      color: var(--success);
      border-color: rgba(78,201,176,0.4);
    }
    .result-banner.result-success .result-banner-btn:hover:not(:disabled) {
      background: rgba(78,201,176,0.3);
    }
    .result-banner.result-warning .result-banner-btn {
      background: rgba(220,160,50,0.18);
      color: #e8a838;
      border-color: rgba(220,160,50,0.4);
    }
    .result-banner.result-warning .result-banner-btn:hover:not(:disabled) {
      background: rgba(220,160,50,0.35);
    }
    .result-banner-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    /* ─── Responsive: narrow panel (<400px) ─── */
    @media (max-width: 420px) {
      .task-pill {
        min-width: 10px;
        max-width: 10px;
        height: 10px;
        padding: 0;
        border-radius: 2px;
        font-size: 0;
        line-height: 10px;
        overflow: hidden;
      }
      .pill-row { gap: 2px; }
      .pill-separator { margin: 1px 1px; }
      .stats-row { font-size: 10px; }
      .pipeline { padding: 6px 8px 5px; }
      .progress-track { margin-bottom: 4px; }

      .active-task-header { padding: 0 8px; gap: 6px; }
      .active-task-name { font-size: 11px; }
      .active-task-output { min-height: 0; padding: 6px 8px; font-size: 10px; }

      .completed-task-row { padding: 4px 6px; font-size: 11px; }
      .ct-stats { gap: 4px; font-size: 9px; }
      .ct-error-line { font-size: 10px; padding: 3px 6px 3px 22px; }
      .ct-detail-output { font-size: 10px; padding: 4px 6px; max-height: 120px; }

      .section-label { font-size: 9px; padding: 6px 4px 4px; }
      .task-row { padding: 3px 6px; font-size: 11px; }
      .playlist-header { font-size: 10px; padding: 4px 4px; }
      .add-btn { font-size: 10px; padding: 3px 8px; }

      .header { padding: 6px 8px; min-height: 34px; }
      .plan-name { font-size: 11px; }
      .status-badge { font-size: 9px; padding: 1px 5px; }
      .icon-btn { width: 22px; height: 22px; font-size: 12px; }

      .status-bar { min-height: 28px; padding: 0 8px; font-size: 10px; }

      .result-banner { margin: 6px; padding: 10px 12px; }
      .result-banner-title { font-size: 12px; }
      .result-banner-meta { font-size: 10px; }

      .hist-row { font-size: 10px; padding: 3px 4px; }
    }

    /* ─── Responsive: very narrow panel (<300px) ─── */
    @media (max-width: 300px) {
      .task-pill {
        min-width: 8px;
        max-width: 8px;
        height: 8px;
      }
      .pill-row { gap: 1px; }
      .engine-badge { display: none; }
      .active-timer { font-size: 10px; }
      .ct-stats .engine-badge { display: none; }
      .tr-engine-tag { display: none; }
      .task-edit-btn { display: none; }
      .active-task-output { min-height: 0; }
    }

    /* ─── Responsive: wide panel (>600px) ─── */
    @media (min-width: 600px) {
      .task-pill {
        width: 26px;
        min-width: 26px;
        max-width: 26px;
        height: 26px;
        line-height: 26px;
        font-size: 10px;
      }
      /* active-task-output sizing handled by flex layout */
      .ct-detail-output { max-height: 250px; }
      .stats-row { font-size: 12px; }
    }

    /* ─── Execution sizing contract ─── */
    body[data-dashboard-state="executing"] .header {
      min-height: 44px;
      padding: 0 12px;
    }
    body[data-dashboard-state="executing"] #btn-play {
      display: none;
    }
    body[data-dashboard-state="executing"] .pipeline {
      min-height: 30px;
      padding: 0 12px;
    }
    body[data-dashboard-state="executing"] .active-task {
      flex: 1;
      min-height: 0;
      margin: 0 6px;
    }
    body[data-dashboard-state="executing"] .active-task-header {
      min-height: 32px;
      padding: 0 10px;
    }
    body[data-dashboard-state="executing"] .active-task-output {
      padding: 8px 10px;
      font-size: 12px;
    }
    body[data-dashboard-state="executing"] .status-bar {
      min-height: 28px;
      padding: 0 12px;
    }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <button type="button" class="plan-name" id="plan-name" onclick="vscode.postMessage({type:'switch-plan'})">MOAG</button>
    <span id="runner-status" class="status-badge status-idle">Idle</span>
    <div class="transport">
      <button id="btn-play" class="icon-btn primary" title="Play">&#9654;</button>
      <button id="btn-pause" class="icon-btn" title="Pause">&#10074;&#10074;</button>
      <button id="btn-stop" class="icon-btn" title="Stop">&#9632;</button>
    </div>
  </div>

  <!-- Pipeline overview -->
  <div class="pipeline" id="pipeline" hidden>
    <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
    <div class="stats-row">
      <span id="stats-tasks">0 / 0 tasks</span>
      <span id="stats-elapsed"></span>
      <button style="background:none;border:none;color:var(--dimmed);cursor:pointer;font-size:9px;padding:0 2px;" id="pill-toggle" onclick="togglePillRow()" title="Toggle task pills" hidden>&#9660;</button>
    </div>
    <div class="pill-row" id="pill-row" hidden></div>
  </div>

  <!-- Scrollable main area -->
  <div class="main-content" id="main-content">

    <!-- Active task panel -->
    <div class="active-task" id="active-task" hidden>
      <div class="active-task-header">
        <div class="active-dot"></div>
        <span class="active-task-name" id="active-task-name"></span>
        <span class="engine-badge" id="active-engine"></span>
        <span class="active-timer" id="active-timer">0s</span>
      </div>
      <div class="terminal-output active-task-output" id="active-output"></div>
    </div>

    <div class="result-banner" id="result-banner" hidden>
      <div class="result-banner-header">
        <div class="result-banner-copy">
          <div class="result-banner-title" id="result-banner-title"></div>
          <div class="result-banner-meta" id="result-banner-meta"></div>
        </div>
        <div class="result-banner-actions">
          <button class="result-banner-btn" id="result-banner-review">Review Changes</button>
          <button class="result-banner-btn" id="result-banner-retry">Retry Failed</button>
          <button class="result-banner-btn" id="result-banner-export">Export</button>
        </div>
      </div>
    </div>

    <!-- Plan / task list (primary view when idle) -->
    <div class="plan-section" id="plan-section" hidden></div>

    <!-- Completed tasks (populated during execution) -->
    <div class="completed-section" id="completed-section" hidden></div>

  </div>

  <!-- Status bar -->
  <div class="status-bar">
    <span id="status-summary">Ready</span>
    <span class="spacer"></span>
    <span id="status-right"></span>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function decodeBase64Utf8(value) {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    }

    // ─── State ───
    const cardState = {};      // taskId → execution details for each task card
    let currentTaskId = null;
    let completedOrder = [];   // taskIds in completion order
    let totalTasks = 0;
    let completedCount = 0;
    let failedCount = 0;
    let blockedCount = 0;
    let totalFilesChanged = 0;
    let runStartTime = null;
    let taskStartTime = null;
    let elapsedInterval = null;
    let currentPlan = null;
    let currentServices = [];
    let lastPlanHash = '';
    let dashboardState = 'idle';
    const taskStartTimes = {};

    // ─── Toolbar ───
    document.getElementById('btn-play').onclick = () => vscode.postMessage({ type: 'play' });
    document.getElementById('btn-pause').onclick = () => vscode.postMessage({ type: 'pause' });
    document.getElementById('btn-stop').onclick = () => vscode.postMessage({ type: 'stop' });
    document.getElementById('result-banner-review').onclick = () => vscode.postMessage({ type: 'review-changes' });
    document.getElementById('result-banner-retry').onclick = () => vscode.postMessage({ type: 'retry-failed' });
    document.getElementById('result-banner-export').onclick = () => vscode.postMessage({ type: 'export-results' });

    function getPlanTasks(plan) {
      return plan && plan.playlists ? plan.playlists.flatMap(function(pl) { return pl.tasks || []; }) : [];
    }

    function getTaskStats(tasks) {
      return tasks.reduce(function(stats, task) {
        switch (task.status) {
          case 'completed':
            stats.completed++;
            break;
          case 'failed':
            stats.failed++;
            break;
          case 'blocked':
            stats.blocked++;
            break;
          case 'running':
            stats.running++;
            break;
          case 'skipped':
            stats.skipped++;
            break;
          default:
            stats.pending++;
            break;
        }
        return stats;
      }, {
        total: tasks.length,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
      });
    }

    function getPlanStats(plan) {
      return getTaskStats(getPlanTasks(plan));
    }

    function hasPlanLoaded() {
      return !!(currentPlan && currentPlan.playlists && currentPlan.playlists.length > 0);
    }

    function hasTaskResults(stats) {
      return (stats.completed + stats.failed + stats.blocked + stats.skipped) > 0;
    }

    function formatCountSummary(stats) {
      const parts = [];
      if (stats.completed > 0) { parts.push(stats.completed + ' passed'); }
      if (stats.failed > 0) { parts.push(stats.failed + ' failed'); }
      if (stats.blocked > 0) { parts.push(stats.blocked + ' blocked'); }
      if (stats.skipped > 0) { parts.push(stats.skipped + ' skipped'); }
      if (stats.running > 0) { parts.push(stats.running + ' running'); }
      if (stats.pending > 0) { parts.push(stats.pending + ' pending'); }
      return parts.join(' · ');
    }

    function getNextTask(tasks) {
      return tasks.find(function(task) { return task.status === 'running'; })
        || tasks.find(function(task) { return !task.status || task.status === 'pending' || task.status === 'paused'; })
        || null;
    }

    function renderResultBanner() {
      const banner = document.getElementById('result-banner');
      const title = document.getElementById('result-banner-title');
      const meta = document.getElementById('result-banner-meta');
      const reviewBtn = document.getElementById('result-banner-review');
      const retryBtn = document.getElementById('result-banner-retry');
      const exportBtn = document.getElementById('result-banner-export');
      const stats = getPlanStats(currentPlan);
      const failures = stats.failed + stats.blocked;
      const hasResults = hasTaskResults(stats);
      banner.className = 'result-banner ' + (failures > 0 ? 'result-warning' : 'result-success');

      if (!hasResults) {
        title.textContent = '';
        meta.textContent = '';
        reviewBtn.disabled = true;
        retryBtn.disabled = true;
        exportBtn.disabled = true;
        return;
      }

      title.textContent = failures > 0
        ? (dashboardState === 'idle' ? 'Last run needs attention' : 'Run finished with failures')
        : (dashboardState === 'idle' ? 'Last run succeeded' : 'Run finished successfully');

      const metaParts = [formatCountSummary(stats)];
      if (totalFilesChanged > 0) {
        metaParts.push(totalFilesChanged + ' file' + (totalFilesChanged !== 1 ? 's changed' : ' changed'));
      }
      if (runStartTime && dashboardState === 'complete') {
        metaParts.push('Elapsed ' + formatDuration(Date.now() - runStartTime));
      }
      meta.textContent = metaParts.filter(Boolean).join(' · ');
      reviewBtn.disabled = false;
      retryBtn.disabled = failures === 0;
      exportBtn.disabled = false;
    }

    function shouldShowCompletedRun() {
      return completedOrder.length > 0 && hasTaskResults(getPlanStats(currentPlan));
    }

    function setSectionVisibility(id, visible) {
      const el = document.getElementById(id);
      if (el) {
        el.hidden = !visible;
        if (id === 'active-task') {
          el.classList.toggle('visible', visible);
        }
      }
    }

    function setDashboardState(state) {
      dashboardState = state;
      document.body.dataset.dashboardState = state;

      ['pipeline', 'plan-section', 'active-task', 'result-banner', 'completed-section'].forEach(function(id) {
        setSectionVisibility(id, false);
      });

      const showPipeline = hasPlanLoaded();
      const showPills = showPipeline && state === 'idle' && totalTasks > 0;
      const showResult = state !== 'executing' && hasTaskResults(getPlanStats(currentPlan));

      setSectionVisibility('pill-toggle', showPills && totalTasks > 12);
      setSectionVisibility('pill-row', showPills);

      if (state === 'idle') {
        setSectionVisibility('pipeline', showPipeline);
        setSectionVisibility('plan-section', true);
        setSectionVisibility('result-banner', showResult);
        return;
      }

      if (state === 'executing') {
        setSectionVisibility('pipeline', showPipeline);
        setSectionVisibility('active-task', true);
        return;
      }

      setSectionVisibility('pipeline', showPipeline);
      setSectionVisibility('result-banner', showResult);
      setSectionVisibility('completed-section', completedOrder.length > 0);
    }

    function resolveDashboardState(runnerState) {
      if (runnerState !== 'idle') {
        return 'executing';
      }
      return shouldShowCompletedRun() ? 'complete' : 'idle';
    }

    function getPlaylistStatusLabel(stats) {
      if (stats.running > 0) { return 'running'; }
      if ((stats.failed + stats.blocked) > 0) { return 'needs attention'; }
      if (stats.total > 0 && (stats.completed + stats.skipped) === stats.total) { return 'complete'; }
      if (stats.completed > 0) { return 'in progress'; }
      return 'pending';
    }

    function renderPlaylistSummaryCard(playlist, planDefaultEngine) {
      const tasks = playlist.tasks || [];
      const stats = getTaskStats(tasks);
      const nextTask = getNextTask(tasks);
      const isRunning = stats.running > 0;
      const hasFailure = (stats.failed + stats.blocked) > 0;
      const resolvedCount = stats.completed + stats.failed + stats.blocked + stats.skipped;
      const classes = ['playlist-summary-card'];
      if (isRunning) { classes.push('is-running'); }
      if (hasFailure) { classes.push('has-failure'); }

      const chips = [];
      chips.push('<span class="summary-chip">' + stats.total + ' task' + (stats.total !== 1 ? 's' : '') + '</span>');
      if (stats.completed > 0) { chips.push('<span class="summary-chip pass">' + stats.completed + ' passed</span>'); }
      if (stats.failed > 0) { chips.push('<span class="summary-chip fail">' + stats.failed + ' failed</span>'); }
      if (stats.blocked > 0) { chips.push('<span class="summary-chip fail">' + stats.blocked + ' blocked</span>'); }
      if (stats.running > 0) { chips.push('<span class="summary-chip running">' + stats.running + ' running</span>'); }
      if (stats.pending > 0) { chips.push('<span class="summary-chip pending">' + stats.pending + ' pending</span>'); }
      if (stats.skipped > 0) { chips.push('<span class="summary-chip pending">' + stats.skipped + ' skipped</span>'); }

      let foot = 'Not started yet.';
      if (isRunning) {
        const activeTask = tasks.find(function(task) { return task.status === 'running'; });
        foot = activeTask ? ('Running now: ' + escHtml(activeTask.name)) : 'Execution in progress.';
      } else if (stats.total > 0 && resolvedCount === stats.total) {
        foot = hasFailure
          ? 'Finished with failures.'
          : 'All tasks finished successfully.';
      } else if (nextTask) {
        foot = 'Next: ' + escHtml(nextTask.name);
      } else if (stats.completed > 0) {
        foot = 'Paused after ' + stats.completed + ' completed task' + (stats.completed !== 1 ? 's' : '') + '.';
      }

      return '' +
        '<article class="' + classes.join(' ') + '">' +
          '<div class="playlist-summary-header">' +
            '<span class="playlist-summary-name">' + escHtml(playlist.name || 'Untitled Playlist') + '</span>' +
            '<span class="playlist-summary-status">' + getPlaylistStatusLabel(stats) + '</span>' +
          '</div>' +
          '<div class="playlist-summary-meta">' +
            '<span class="playlist-engine">' + escHtml(playlist.engine || planDefaultEngine || 'agent') + '</span>' +
            '<span class="playlist-summary-mode">' + (playlist.parallel ? 'Parallel' : 'Sequential') + '</span>' +
          '</div>' +
          '<div class="playlist-summary-stats">' + chips.join('') + '</div>' +
          '<div class="playlist-summary-foot">' + foot + '</div>' +
        '</article>';
    }

    // ─── Message Handler ───
    window.addEventListener('message', event => {
      const msg = event.data;

      switch (msg.type) {
        case 'update': {
          try {
            console.log('[MOAG] Update msg: plan=' + (msg.plan ? msg.plan.name + ', playlists=' + msg.plan.playlists.length : 'null'));
            var planPlaylists = (msg.plan && msg.plan.playlists) ? msg.plan.playlists : [];
            var newHash = msg.plan
              ? msg.plan.name + '|' + planPlaylists.map(function(playlist) {
                return [
                  playlist.name || '',
                  playlist.engine || '',
                  playlist.parallel ? 'parallel' : 'sequential',
                  (playlist.tasks || []).map(function(task) {
                    return [
                      task.id || '',
                      task.name || '',
                      task.status || 'pending',
                    ].join(':');
                  }).join(','),
                ].join('|');
              }).join('||')
              : '';
            var planSection = document.getElementById('plan-section');
            var shouldRenderPlan = newHash !== lastPlanHash || !!(planSection && !planSection.innerHTML.trim());
            currentPlan = msg.plan;
            currentServices = msg.services || [];
            if (shouldRenderPlan) {
              lastPlanHash = newHash;
              renderPlan(msg.plan);
            }
            renderPills(msg.plan);
            updateProgress();
            renderStatus(msg.runnerState);
          } catch(updateErr) {
            console.error('[MOAG Dashboard] Update error:', updateErr);
            // Force render even if hash logic fails
            currentPlan = msg.plan;
            currentServices = msg.services || [];
            renderPlan(msg.plan);
            renderPills(msg.plan);
            updateProgress();
            renderStatus(msg.runnerState || 'idle');
          }
          break;
        }

        case 'clear-output':
        case 'clear-timeline':
          resetExecution();
          break;

        case 'start-task-card':
          startTask(msg);
          break;

        case 'output': {
          const targetId = msg.taskId || currentTaskId;
          if (targetId) {
            appendOutput(targetId, msg.text, msg.stream);
          }
          break;
        }

        case 'complete-task-card':
          completeTask(msg);
          break;

        case 'engine-fallback': {
          const targetId = currentTaskId;
          if (targetId) {
            const fallbackText = '[MOAG] Switching from ' + msg.fromEngine + ' to ' + msg.toEngine + ' due to rate limit';
            // Store in card state
            const st = cardState[targetId];
            if (st) { st.output += '\\n' + fallbackText + '\\n'; }
            // Render as a yellow info line in the active output
            const outputEl = document.getElementById('active-output');
            if (outputEl && targetId === currentTaskId) {
              clearActiveOutputPlaceholder();
              const span = document.createElement('span');
              span.style.color = 'var(--warning)';
              span.style.fontWeight = '600';
              span.textContent = '\\n' + fallbackText + '\\n';
              outputEl.appendChild(span);
              outputEl.scrollTop = outputEl.scrollHeight;
            }
          }
          break;
        }
      }
    });

    // ─── Execution Logic ───

    function resetExecution() {
      Object.keys(cardState).forEach(k => delete cardState[k]);
      Object.keys(taskStartTimes).forEach(k => delete taskStartTimes[k]);
      currentTaskId = null;
      completedOrder = [];
      completedCount = 0;
      failedCount = 0;
      blockedCount = 0;
      totalFilesChanged = 0;
      runStartTime = null;
      taskStartTime = null;
      stopTimer();
      document.getElementById('active-task-name').textContent = '';
      document.getElementById('active-output').textContent = '';
      document.getElementById('active-engine').textContent = '';
      document.getElementById('active-engine').className = 'engine-badge engine-custom';
      document.getElementById('active-timer').textContent = '0s';
      const completedSection = document.getElementById('completed-section');
      completedSection.innerHTML = '';
      syncCurrentTaskMarker();
      updateProgress();
      renderStatus('idle');
    }

    function getActiveRuntimeLabel(task) {
      if (task.engine) { return task.engine; }
      if (task.taskType && task.taskType !== 'agent') { return task.taskType; }
      return 'agent';
    }

    function getExecutionEtaText(effectiveCompleted) {
      if (!runStartTime || totalTasks === 0) {
        return '';
      }

      const processedTasks = effectiveCompleted > 0 ? effectiveCompleted : (currentTaskId ? 1 : 0);
      if (processedTasks === 0) {
        return 'ETA --';
      }

      const remainingTasks = Math.max(totalTasks - effectiveCompleted, 0);
      const elapsedMs = Date.now() - runStartTime;
      const etaMs = Math.round((elapsedMs / processedTasks) * remainingTasks);
      return 'ETA ~' + formatDuration(Math.max(etaMs, 0));
    }

    function showActiveOutputPlaceholder(text) {
      const outputEl = document.getElementById('active-output');
      outputEl.textContent = '';
      const hint = document.createElement('div');
      hint.className = 'active-output-empty';
      hint.textContent = text;
      outputEl.appendChild(hint);
    }

    function clearActiveOutputPlaceholder() {
      const hint = document.querySelector('#active-output .active-output-empty');
      if (hint) {
        hint.remove();
      }
    }

    function syncCurrentTaskMarker() {
      document.querySelectorAll('.task-pill.current-task').forEach(el => {
        el.classList.remove('current-task');
      });
      if (!currentTaskId) { return; }
      const pill = document.querySelector('.task-pill[data-task-id="' + currentTaskId + '"]');
      if (pill) { pill.classList.add('current-task'); }
    }

    function wireTaskNavigation() {
      document.querySelectorAll('.task-pill').forEach(pill => {
        pill.onclick = () => {
          if (pill.dataset.taskId === currentTaskId) {
            document.getElementById('active-task').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        };
      });
    }

    function startTask(msg) {
      // Enter execution mode — hides non-essential sections for max output visibility

      // Initialize run timer on first task
      if (!runStartTime) {
        runStartTime = Date.now();
        startTimer();
      }
      taskStartTime = Date.now();
      taskStartTimes[msg.taskId] = Date.now();

      currentTaskId = msg.taskId;
      cardState[msg.taskId] = {
        output: '',
        engine: msg.engine || '',
        taskType: msg.taskType || 'agent',
        command: msg.command || '',
        playlistName: msg.playlistName || '',
        durationMs: 0,
        exitCode: null,
        status: 'running',
        changedFiles: null,
        codeChanges: null,
        verification: null,
        artifacts: null,
        summary: '',
      };

      document.getElementById('active-task-name').textContent = msg.taskName;
      const runtimeLabel = getActiveRuntimeLabel(msg);

      const engineEl = document.getElementById('active-engine');
      engineEl.textContent = runtimeLabel;
      engineEl.className = 'engine-badge engine-' + (msg.engine || 'custom');

      document.getElementById('active-timer').textContent = '0s';
      showActiveOutputPlaceholder('Waiting for terminal output...');

      updatePillStatus(msg.taskId, 'running');
      syncCurrentTaskMarker();
      setDashboardState('executing');
      updateStatusBar();
    }

    function appendOutput(taskId, text, stream) {
      const state = cardState[taskId];
      if (state) {
        state.output += text;
        if (state.output.length > 50000) {
          state.output = '... (truncated) ...\\n' + state.output.slice(-40000);
        }
      }
      if (taskId === currentTaskId) {
        const outputEl = document.getElementById('active-output');
        clearActiveOutputPlaceholder();
        outputEl.appendChild(document.createTextNode(text));
        while (outputEl.childNodes.length > 500) {
          outputEl.removeChild(outputEl.firstChild);
        }
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    }

    function completeTask(msg) {
      const state = cardState[msg.taskId];
      if (state) {
        state.durationMs = msg.durationMs;
        state.exitCode = msg.exitCode;
        state.status = msg.status;
        state.changedFiles = msg.changedFiles;
        state.codeChanges = msg.codeChanges;
        state.stderr = msg.stderr || '';
        state.stdoutTail = msg.stdoutTail || '';
        state.command = msg.command || '';
        state.summary = msg.summary || '';
        state.verification = msg.verification || null;
        state.artifacts = msg.artifacts || null;
      }

      const passed = msg.status === 'completed';
      const blocked = msg.status === 'blocked';
      const failed = !passed && !blocked && msg.status !== 'skipped';
      completedCount++;
      if (failed) { failedCount++; }
      if (blocked) { blockedCount++; }
      if (msg.changedFiles) { totalFilesChanged += msg.changedFiles.length; }
      completedOrder.push(msg.taskId);

      // Update pill
      updatePillStatus(msg.taskId, msg.status);

      // Move to completed list
      addCompletedCard(msg.taskId, msg.taskName, msg);

      if (msg.taskId === currentTaskId) {
        currentTaskId = null;
      }

      syncCurrentTaskMarker();
      updateProgress();
      renderResultBanner();
      updateStatusBar();
    }

    function detectErrorReason(text) {
      if (!text) { return null; }
      if (/usage.?limit|rate.?limit|quota.?exceeded|too many requests/i.test(text)) {
        var resetMatch = text.match(/try again at ([^.\\n]+)/i) || text.match(/reset[s]? (?:at|on) ([^.\\n]+)/i);
        return '\\u26A0 Rate limit reached' + (resetMatch ? ' — resets ' + resetMatch[1].trim() : '') + '. Switch engine or wait.';
      }
      if (/authentication|auth.*fail|invalid.*key|unauthorized|403/i.test(text)) {
        return '\\u26A0 Authentication failed — check your API key or login.';
      }
      if (/not.?found|command.?not.?found|is not recognized|ENOENT/i.test(text)) {
        return '\\u26A0 CLI not found — is the engine installed and in PATH?';
      }
      if (/model.*not.*supported|model.*not.*found|invalid.*model/i.test(text)) {
        return '\\u26A0 Model not available — check engine settings or switch model.';
      }
      if (/ETIMEDOUT|ECONNREFUSED|network|socket hang up/i.test(text)) {
        return '\\u26A0 Network error — check your internet connection.';
      }
      return null;
    }

    function extractErrorLines(text) {
      if (!text) { return ''; }
      // Find lines containing ERROR, error, fail, exception, or rate/usage limit
      var lines = text.split('\\n');
      var errorLines = [];
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (!l) { continue; }
        if (/^ERROR:|error:|failed|exception|limit|unauthorized|not found|not supported|ENOENT|ETIMEDOUT/i.test(l)) {
          // Grab this line and up to 2 lines after for context
          errorLines.push(l);
          if (lines[i + 1] && lines[i + 1].trim()) { errorLines.push(lines[i + 1].trim()); }
          if (lines[i + 2] && lines[i + 2].trim()) { errorLines.push(lines[i + 2].trim()); }
          break;
        }
      }
      if (errorLines.length === 0) {
        // Fallback: last 5 non-empty lines
        errorLines = lines.filter(function(l) { return l.trim(); }).slice(-5);
      }
      return errorLines.map(function(l) { return l.length > 200 ? l.substring(0, 200) + '...' : l; }).join('\\n');
    }

    function addCompletedCard(taskId, taskName, msg) {
      const section = document.getElementById('completed-section');
      // Add collapsible header if first completed task
      if (completedOrder.length === 1) {
        const header = document.createElement('button');
        header.className = 'section-toggle';
        header.dataset.section = 'completed';
        header.onclick = () => toggleSection('completed');
        header.innerHTML = '<span class="section-toggle-icon">\\u25BC</span>' +
          '<span class="section-toggle-label">Completed Tasks</span>' +
          '<span class="section-toggle-count" id="completed-count">1</span>';
        header.id = 'completed-label';
        section.prepend(header);

        const body = document.createElement('div');
        body.id = 'body-completed';
        body.className = 'section-body';
        section.appendChild(body);
      } else {
        // Update count in header
        const countEl = document.getElementById('completed-count');
        if (countEl) { countEl.textContent = completedOrder.length; }
      }

      const state = cardState[taskId] || {};
      const passed = msg.status === 'completed';
      const skipped = msg.status === 'skipped';
      const blocked = msg.status === 'blocked';
      const durStr = formatDuration(msg.durationMs || 0);
      const filesCount = (msg.changedFiles || []).length;

      const card = document.createElement('div');
      card.className = 'completed-task' + (passed ? '' : skipped ? '' : ' failed-task');
      card.dataset.taskId = taskId;

      // Summary row
      const row = document.createElement('div');
      row.className = 'completed-task-row';
      var autoFixBadge = msg.autoFixed
        ? '<span class="autofix-badge">\\uD83D\\uDD27 Auto-fixed</span>'
        : '';
      row.innerHTML =
        '<span class="ct-icon ' + (passed ? 'pass' : skipped ? 'skip' : blocked ? 'fail' : 'fail') + '">' +
          (passed ? '\\u2713' : skipped ? '\\u2212' : blocked ? '!' : '\\u2717') +
        '</span>' +
        '<span class="ct-name">' + escHtml(taskName) + autoFixBadge + '</span>' +
        '<span class="ct-stats">' +
          (state.taskType ? '<span class="engine-badge engine-custom">' + escHtml(state.taskType) + '</span>' : '') +
          (state.engine ? '<span class="engine-badge engine-' + state.engine + '">' + state.engine + '</span>' : '') +
          '<span>' + durStr + '</span>' +
          (filesCount > 0 ? '<span>' + filesCount + ' file' + (filesCount !== 1 ? 's' : '') + '</span>' : '') +
        '</span>';
      row.onclick = () => card.classList.toggle('expanded');

      // For failed tasks: show inline error preview and collapsible error output
      if (!passed && !skipped) {
        const errLine = document.createElement('div');
        errLine.className = 'ct-error-line';
        const stderr = msg.stderr || (state.output || '');
        const errPreview = stderr.split('\\n').filter(l => l.trim()).slice(-2).join(' | ').substring(0, 120);
        errLine.textContent = blocked ? 'blocked' : (errPreview || 'exit ' + msg.exitCode);
        errLine.title = stderr.split('\\n').filter(l => l.trim()).slice(-5).join('\\n');
        card.appendChild(errLine);

        // Collapsible Error Output: last 5 lines of stderr (or stdout if stderr empty)
        if (!blocked) {
          const rawStderr = (msg.stderr || '').trim();
          const rawStdout = (msg.stdoutTail || state.output || '').trim();
          const errorSource = rawStderr || rawStdout;
          if (errorSource) {
            const errorLines = errorSource.split('\\n').filter(l => l.trim()).slice(-5)
              .map(l => l.length > 200 ? l.substring(0, 200) + '...' : l);
            if (errorLines.length > 0) {
              const errDetails = document.createElement('details');
              errDetails.className = 'ct-error-output';
              errDetails.open = true;
              const errSummary = document.createElement('summary');
              errSummary.textContent = 'Error Output (' + (rawStderr ? 'stderr' : 'stdout') + ')';
              const errPre = document.createElement('pre');
              errPre.textContent = errorLines.join('\\n');
              errDetails.appendChild(errSummary);
              errDetails.appendChild(errPre);
              card.appendChild(errDetails);
            }
          }
        }

        // Auto-expand failed tasks
        card.classList.add('expanded');
      }

      // Detail panel
      const detail = document.createElement('div');
      detail.className = 'ct-detail';

      if (state.summary) {
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'terminal-output ct-detail-output';
        summaryDiv.textContent = state.summary;
        detail.appendChild(summaryDiv);
      }

      if (state.command) {
        const cmdDiv = document.createElement('div');
        cmdDiv.className = 'terminal-output ct-detail-output';
        cmdDiv.textContent = state.command;
        detail.appendChild(cmdDiv);
      }

      if (state.verification) {
        const verifyDiv = document.createElement('div');
        verifyDiv.className = 'terminal-output ct-detail-output';
        verifyDiv.textContent =
          'Verify: ' + state.verification.command + ' -> ' +
          (state.verification.passed ? 'passed' : 'failed') +
          ' (' + formatDuration(state.verification.durationMs || 0) + ')';
        detail.appendChild(verifyDiv);
      }

      // Stderr (for failed tasks, show prominently)
      if (msg.stderr) {
        const stderrDiv = document.createElement('div');
        stderrDiv.className = 'terminal-output ct-detail-output';
        stderrDiv.style.color = 'var(--error)';
        stderrDiv.textContent = msg.stderr;
        detail.appendChild(stderrDiv);
      }

      // Output (last 100 lines)
      if (state.output) {
        const lines = state.output.split('\\n');
        const tail = lines.length > 100 ? lines.slice(-100).join('\\n') : state.output;
        const outDiv = document.createElement('div');
        outDiv.className = 'terminal-output ct-detail-output';
        outDiv.textContent = tail;
        detail.appendChild(outDiv);
      }

      // Changed files
      if (msg.changedFiles && msg.changedFiles.length > 0) {
        const filesSection = document.createElement('details');
        filesSection.className = 'ct-detail-section';
        filesSection.open = true;
        filesSection.innerHTML =
          '<summary>Changed Files (' + msg.changedFiles.length + ')</summary>' +
          '<ul>' + msg.changedFiles.map(f => '<li>' + escHtml(f) + '</li>').join('') + '</ul>';
        detail.appendChild(filesSection);
      }

      if (state.artifacts && state.artifacts.length > 0) {
        const artifactsSection = document.createElement('details');
        artifactsSection.className = 'ct-detail-section';
        artifactsSection.open = !passed;
        artifactsSection.innerHTML =
          '<summary>Artifacts (' + state.artifacts.length + ')</summary>' +
          '<ul>' + state.artifacts.map(artifact =>
            '<li>' + escHtml(artifact.target) + ' - ' + (artifact.exists ? 'present' : 'missing') + '</li>',
          ).join('') + '</ul>';
        detail.appendChild(artifactsSection);
      }

      // Code diff with enhanced viewer
      if (msg.codeChanges) {
        const diffSection = document.createElement('details');
        diffSection.className = 'diff-section';
        const diffText = msg.codeChanges.length > 8000
          ? msg.codeChanges.substring(0, 8000) + '\\n... (truncated)'
          : msg.codeChanges;
        // Parse file-level summary from diff headers
        var fileSummaries = [];
        var diffLines = diffText.split('\\n');
        for (var fi = 0; fi < diffLines.length; fi++) {
          var diffLine = diffLines[fi];
          if (!diffLine.startsWith('diff --git a/')) { continue; }
          var afterPrefix = diffLine.slice('diff --git a/'.length);
          var separatorIndex = afterPrefix.indexOf(' b/');
          if (separatorIndex === -1) { continue; }
          fileSummaries.push(afterPrefix.slice(0, separatorIndex));
        }
        var fileSummaryHtml = fileSummaries.length > 0
          ? '<div class="diff-file-summary">' + fileSummaries.map(function(f) { return escHtml(f); }).join(' &middot; ') + '</div>'
          : '';
        diffSection.innerHTML =
          '<summary>Changes (' + (msg.changedFiles || []).length + ' files)</summary>' +
          fileSummaryHtml +
          '<div class="diff-view">' + colorDiff(diffText) + '</div>' +
          '<div class="diff-actions">' +
            '<button onclick="navigator.clipboard.writeText(this.closest(\\'.diff-section\\').querySelector(\\'.diff-view\\').textContent)">Copy Diff</button>' +
            '<button onclick="vscode.postMessage({type:\\x27open-diff\\x27, taskId:\\x27' + taskId + '\\x27})">Open in Editor</button>' +
          '</div>';
        detail.appendChild(diffSection);
      }

      card.appendChild(row);
      card.appendChild(detail);
      const body = document.getElementById('body-completed') || section;
      body.appendChild(card);

      // Scroll completed card into view
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ─── Progress + Stats ───

    function updateProgress() {
      const fill = document.getElementById('progress-fill');
      const tasks = currentPlan ? currentPlan.playlists.flatMap(pl => pl.tasks || []) : [];
      const passedTasks = tasks.filter(task => task.status === 'completed').length;
      const failedTasks = tasks.filter(task => task.status === 'failed').length;
      const blockedTasks = tasks.filter(task => task.status === 'blocked').length;
      const skippedTasks = tasks.filter(task => task.status === 'skipped').length;
      // Use plan-derived counts as the floor — completedCount only tracks the current session
      const effectiveCompleted = Math.max(completedCount, passedTasks + failedTasks + blockedTasks + skippedTasks);
      const effectiveFailed = Math.max(failedCount, failedTasks);
      if (totalTasks === 0) {
        fill.style.width = '0%';
        fill.classList.remove('has-errors');
        document.getElementById('stats-tasks').textContent = dashboardState === 'executing' ? '0/0' : '0 / 0 tasks';
        document.getElementById('stats-elapsed').textContent = '';
        return;
      }
      const pct = Math.round((effectiveCompleted / totalTasks) * 100);
      fill.style.width = pct + '%';

      if (effectiveFailed > 0) {
        const passPct = Math.round(((effectiveCompleted - effectiveFailed) / totalTasks) * 100);
        fill.classList.add('has-errors');
        fill.style.setProperty('--pass-pct', passPct + '%');
      } else {
        fill.classList.remove('has-errors');
      }

      if (dashboardState === 'executing') {
        document.getElementById('stats-tasks').textContent = effectiveCompleted + '/' + totalTasks;
        document.getElementById('stats-elapsed').textContent = getExecutionEtaText(effectiveCompleted);
        return;
      }

      document.getElementById('stats-tasks').textContent =
        effectiveCompleted + ' / ' + totalTasks + ' tasks' +
        (failedTasks > 0 || blockedTasks > 0
          ? ' (' + [
            failedTasks > 0 ? failedTasks + ' failed' : '',
            blockedTasks > 0 ? blockedTasks + ' blocked' : '',
          ].filter(Boolean).join(', ') + ')'
          : '');
      document.getElementById('stats-elapsed').textContent =
        runStartTime ? formatDuration(Date.now() - runStartTime) : '';
    }

    function startTimer() {
      stopTimer();
      elapsedInterval = setInterval(updateTimers, 1000);
    }

    function stopTimer() {
      if (elapsedInterval) {
        clearInterval(elapsedInterval);
        elapsedInterval = null;
      }
    }

    function updateTimers() {
      updateProgress();
      if (taskStartTime && currentTaskId) {
        document.getElementById('active-timer').textContent = formatDuration(Date.now() - taskStartTime);
      }
      updateStatusBar();
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + 'ms';
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return secs + 's';
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      if (mins < 60) return mins + 'm ' + remSecs + 's';
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      return hrs + 'h ' + remMins + 'm';
    }

    function updateStatusBar() {
      const summary = document.getElementById('status-summary');
      const right = document.getElementById('status-right');
      const tasks = currentPlan ? currentPlan.playlists.flatMap(pl => pl.tasks || []) : [];
      const passedTasks = tasks.filter(task => task.status === 'completed').length;
      const failedTasks = tasks.filter(task => task.status === 'failed').length;
      const blockedTasks = tasks.filter(task => task.status === 'blocked').length;
      if (currentTaskId && cardState[currentTaskId]) {
        summary.textContent = 'Running: ' + (document.getElementById('active-task-name').textContent || 'Task');
        right.textContent = runStartTime ? formatDuration(Date.now() - runStartTime) : '';
        return;
      } else if (completedCount > 0 && completedCount >= totalTasks) {
        // Run finished — show actionable summary
        if (failedTasks > 0 && passedTasks === 0) {
          summary.textContent = 'All ' + failedTasks + ' tasks failed \\u2014 retry or switch engine';
        } else if (failedTasks > 0) {
          summary.textContent = passedTasks + ' passed, ' + failedTasks + ' failed \\u2014 right-click to retry';
        } else {
          summary.textContent = 'All ' + passedTasks + ' tasks completed \\u2713';
        }
      } else if (completedCount > 0) {
        summary.textContent = passedTasks + ' passed' +
          (failedTasks > 0 ? ', ' + failedTasks + ' failed' : '') +
          (blockedTasks > 0 ? ', ' + blockedTasks + ' blocked' : '');
      } else {
        summary.textContent = 'Ready';
      }
      if (runStartTime) {
        right.textContent = formatDuration(Date.now() - runStartTime) +
          (currentServices.length > 0 ? ' | ' + currentServices.length + ' service' + (currentServices.length !== 1 ? 's' : '') : '');
      } else {
        right.textContent = currentServices.length > 0 ? currentServices.length + ' services' : '';
      }
    }

    // ─── Pill Row ───

    var minimapMode = false;

    function renderPills(plan) {
      const row = document.getElementById('pill-row');
      if (!plan || !plan.playlists || plan.playlists.length === 0) {
        totalTasks = 0;
        minimapMode = false;
        row.className = 'pill-row';
        row.innerHTML = '';
        updateProgress();
        return;
      }

      // Count tasks first to decide pill vs minimap
      let taskCount = 0;
      plan.playlists.forEach(pl => { taskCount += pl.tasks.length; });
      minimapMode = taskCount > 30;

      let html = '';
      let idx = 0;
      plan.playlists.forEach((pl, pi) => {
        if (pi > 0 && !minimapMode) { html += '<div class="pill-separator"></div>'; }
        pl.tasks.forEach(task => {
          idx++;
          const isCurrent = task.id === currentTaskId || task.status === 'running';
          const pillStatus = isCurrent ? 'running' : (task.status || 'pending');
          html += '<div class="task-pill ' + pillStatus + (isCurrent ? ' current-task' : '') + '" ' +
            'data-task-id="' + task.id + '" ' +
            'title="' + idx + '. ' + escHtml(task.name) + '">' +
            (minimapMode ? '' : idx) +
            '</div>';
        });
      });
      totalTasks = taskCount;

      // Apply minimap class
      row.className = 'pill-row' + (minimapMode ? ' minimap' : '') + (pillRowCollapsed ? ' collapsed' : '');
      row.innerHTML = html;
      wireTaskNavigation();
      syncCurrentTaskMarker();
      updateProgress();
    }

    function updatePillStatus(taskId, status) {
      const pill = document.querySelector('.task-pill[data-task-id="' + taskId + '"]');
      if (pill) {
        pill.className = 'task-pill ' + status + (taskId === currentTaskId ? ' current-task' : '');
      }
    }

    // ─── Render Functions ───

    function renderStatus(state) {
      const el = document.getElementById('runner-status');
      el.textContent = state.charAt(0).toUpperCase() + state.slice(1);
      el.className = 'status-badge status-' + state;

      const playBtn = document.getElementById('btn-play');
      const pauseBtn = document.getElementById('btn-pause');
      const stopBtn = document.getElementById('btn-stop');

      playBtn.disabled = state === 'playing';
      pauseBtn.disabled = state !== 'playing';
      stopBtn.disabled = state === 'idle';

      // Toggle play button style
      playBtn.className = playBtn.disabled ? 'icon-btn' : 'icon-btn primary';
      setDashboardState(resolveDashboardState(state));
      renderResultBanner();
      if (state === 'idle') {
        stopTimer();
      }
      updateTimers();
    }

    // Track collapsed state for sections
    const collapsedSections = {};

    function toggleSection(sectionId) {
      collapsedSections[sectionId] = !collapsedSections[sectionId];
      const toggle = document.querySelector('[data-section="' + sectionId + '"]');
      const body = document.getElementById('body-' + sectionId);
      if (toggle && body) {
        if (collapsedSections[sectionId]) {
          toggle.classList.add('collapsed');
          body.classList.add('collapsed');
        } else {
          toggle.classList.remove('collapsed');
          body.classList.remove('collapsed');
        }
      }
    }

    function renderPlan(plan) {
      const section = document.getElementById('plan-section');
      const planName = document.getElementById('plan-name');

      if (!plan || !plan.playlists || plan.playlists.length === 0) {
        section.innerHTML = '<div class="plan-placeholder">No plan loaded - use the sidebar to create one.</div>';
        planName.textContent = plan && plan.name ? plan.name : 'MOAG';
        return;
      }

      planName.textContent = plan.name || 'Untitled Plan';
      const stats = getPlanStats(plan);
      const metaParts = [
        plan.playlists.length + ' playlist' + (plan.playlists.length !== 1 ? 's' : ''),
        stats.total + ' task' + (stats.total !== 1 ? 's' : ''),
      ];
      if (stats.total > 0) {
        metaParts.push(formatCountSummary(stats) || 'Ready to run');
      }

      let html = '<div class="plan-overview">';
      html += '<div class="plan-overview-header">' +
        '<span class="plan-overview-title">Plan Overview</span>' +
        '<span class="plan-overview-meta">' + escHtml(metaParts.join(' · ')) + '</span>' +
        '</div>';
      html += plan.playlists.map(function(playlist) {
        return renderPlaylistSummaryCard(playlist, plan.defaultEngine);
      }).join('');
      html += '</div>';
      section.innerHTML = html;
    }

    // ─── Interactions ───

    let pillRowCollapsed = false;
    function togglePillRow() {
      const row = document.getElementById('pill-row');
      const toggle = document.getElementById('pill-toggle');
      if (minimapMode) {
        // In minimap mode, toggle between collapsed → compact → expanded
        var isExpanded = row.classList.contains('expanded');
        if (pillRowCollapsed) {
          pillRowCollapsed = false;
          row.classList.remove('collapsed');
          row.classList.remove('expanded');
          toggle.innerHTML = '\\u25BC';
        } else if (!isExpanded) {
          row.classList.add('expanded');
          toggle.innerHTML = '\\u25B2';
        } else {
          pillRowCollapsed = true;
          row.classList.add('collapsed');
          row.classList.remove('expanded');
          toggle.innerHTML = '\\u25B6';
        }
      } else {
        pillRowCollapsed = !pillRowCollapsed;
        if (pillRowCollapsed) {
          row.classList.add('collapsed');
          toggle.innerHTML = '\\u25B6';
        } else {
          row.classList.remove('collapsed');
          toggle.innerHTML = '\\u25BC';
        }
      }
    }

    // ─── Utilities ───

    function escHtml(s) {
      const div = document.createElement('div');
      div.textContent = s || '';
      return div.innerHTML;
    }

    function colorDiff(diff) {
      return diff.split('\\n').map(function(line) {
        const escaped = escHtml(line);
        if (line.startsWith('diff --git')) return '<span class="diff-header">' + escaped + '</span>';
        if (line.startsWith('+++') || line.startsWith('---')) return '<span class="diff-header">' + escaped + '</span>';
        if (line.startsWith('@@')) return '<span class="diff-hunk">' + escaped + '</span>';
        if (line.startsWith('+')) return '<span class="diff-add">' + escaped + '</span>';
        if (line.startsWith('-')) return '<span class="diff-remove">' + escaped + '</span>';
        return escaped;
      }).join('\\n');
    }

    // ─── Init ───

    // Embedded initial state — rendered at HTML generation time,
    // no postMessage round-trip needed for first paint.
    (function() {
      try {
        console.log('[MOAG] Init: decoding base64, length=' + '${initialStateBase64}'.length);
        var rawState = decodeBase64Utf8('${initialStateBase64}');
        var initState = JSON.parse(rawState);
        console.log('[MOAG] Init: parsed JSON, plan=' + (initState.plan ? initState.plan.name : 'null'));
        if (initState && initState.plan) {
          currentPlan = initState.plan;
          renderPlan(initState.plan);
          renderPills(initState.plan);
          updateProgress();
          renderStatus(initState.runnerState || 'idle');
        } else {
          currentPlan = null;
          renderPlan(null);
          renderPills(null);
          updateProgress();
          renderStatus('idle');
        }
      } catch(initErr) {
        console.error('[MOAG Dashboard] Init error:', initErr);
        currentPlan = null;
        renderPlan(null);
        renderPills(null);
        updateProgress();
        renderStatus('idle');
      }
    })();

    function notifyWebviewReady() {
      vscode.postMessage({ type: 'webview-ready' });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', notifyWebviewReady, { once: true });
    } else {
      notifyWebviewReady();
    }

    // Retry polling: if no plan loaded after init, keep asking the extension
    // for up to 5 seconds (covers async plan loading race condition)
    (function() {
      let retries = 0;
      const maxRetries = 10;
      const interval = setInterval(function() {
        retries++;
        var planSection = document.getElementById('plan-section');
        var hasRenderedPlan = !!(planSection && planSection.innerHTML.trim());
        if ((currentPlan && hasRenderedPlan) || retries >= maxRetries) {
          clearInterval(interval);
          if (currentPlan && !hasRenderedPlan) {
            vscode.postMessage({ type: 'refresh' });
          }
          return;
        }
        if (!currentPlan || !hasRenderedPlan) {
          vscode.postMessage({ type: 'refresh' });
        }
      }, 500);
    })();
  </script>
</body>
</html>`;
  }
}
