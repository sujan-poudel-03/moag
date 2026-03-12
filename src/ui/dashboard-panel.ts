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
    // Register handlers BEFORE setting HTML — setting HTML triggers the
    // webview script which immediately sends 'refresh', so the handler
    // must already be listening.
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this._disposables,
    );
    const plan = this.getPlan();
    outputChannel.appendLine(`[constructor] getPlan() returned: ${plan ? plan.name + ' (' + plan.playlists.length + ' playlists)' : 'null'}`);
    this.renderWebview();
    // Send state multiple times to ensure delivery — webview may not be ready immediately
    this.update();
    setTimeout(() => this.update(), 200);
    setTimeout(() => this.update(), 600);
    setTimeout(() => this.update(), 1500);
    setTimeout(() => this.update(), 3000);

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
      }
      DashboardPanel.currentPanel.update();
      return DashboardPanel.currentPanel;
    }
    outputChannel.appendLine('[createOrShow] creating new panel');

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

  private renderWebview(): void {
    this._webviewReady = false;
    this._panel.webview.html = this.getHtml();
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
    });
  }

  /** Clear all task cards from the timeline */
  public clearTimeline(): void {
    this.postMessageWithRetries({ type: 'clear-timeline' });
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    outputChannel.appendLine(`[handleMessage] type=${msg.type}`);
    switch (msg.type) {
      case 'ready':
        this._webviewReady = true;
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
      case 'refresh':
        this.update();
        break;
    }
  }

  private dispose(): void {
    this._disposed = true;
    DashboardPanel.currentPanel = undefined;
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
  <title>Agent Task Player</title>
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

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      height: 100vh;
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
      padding: 8px 12px;
      background: var(--sidebar-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-height: 40px;
    }
    .plan-name {
      font-weight: 600;
      font-size: 12px;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
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
      justify-content: space-between;
      font-size: 11px;
      color: var(--dimmed);
      margin-bottom: 6px;
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
    .pill-separator {
      width: 1px;
      background: var(--border);
      margin: 2px 2px;
      align-self: stretch;
    }
    .task-pill {
      height: 20px;
      min-width: 20px;
      max-width: 140px;
      padding: 0 6px;
      border-radius: 3px;
      font-size: 10px;
      line-height: 20px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
    }

    /* ─── Active Task Panel ─── */
    .active-task {
      margin: 8px;
      border: 1px solid var(--focus-border);
      border-radius: 6px;
      overflow: hidden;
      display: none;
      flex-shrink: 0;
      flex-grow: 1;
      min-height: 180px;
    }
    .active-task.visible { display: flex; flex-direction: column; animation: border-pulse 2s ease-in-out infinite; }
    @keyframes border-pulse {
      0%, 100% { border-color: var(--focus-border); }
      50% { border-color: var(--success); }
    }
    .active-task-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: rgba(0,122,204,0.06);
    }
    .active-task-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
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
    .active-task-meta {
      font-size: 10px;
      color: var(--dimmed);
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
    .active-timer {
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--dimmed);
      flex-shrink: 0;
    }
    .active-task-output {
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 8px 10px;
      min-height: 80px;
      flex: 1;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.4;
    }
    .active-task-contract {
      border-top: 1px solid var(--border);
      padding: 8px 10px;
      display: grid;
      gap: 6px;
      background: color-mix(in srgb, var(--sidebar-bg) 84%, transparent);
    }
    .contract-row {
      display: grid;
      gap: 4px;
      font-size: 11px;
    }
    .contract-label {
      color: var(--dimmed);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .contract-list {
      margin: 0;
      padding-left: 16px;
    }
    .contract-inline {
      word-break: break-word;
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
    .active-task-prompt {
      font-size: 11px;
      border-top: 1px solid var(--border);
    }
    .active-task-prompt summary {
      padding: 5px 10px;
      cursor: pointer;
      color: var(--dimmed);
      font-size: 10px;
    }
    .active-task-prompt pre {
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 6px 10px;
      margin: 0;
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* ─── Collapsible Section Headers ─── */
    .section-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 4px 6px;
      cursor: pointer;
      user-select: none;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      color: var(--dimmed);
    }
    .section-toggle:hover { color: var(--fg); }
    .section-toggle-icon {
      font-size: 8px;
      transition: transform 0.15s;
      width: 12px;
      text-align: center;
      flex-shrink: 0;
    }
    .section-toggle.collapsed .section-toggle-icon {
      transform: rotate(-90deg);
    }
    .section-toggle-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .section-toggle-count {
      font-size: 10px;
      font-weight: normal;
      opacity: 0.7;
    }
    .section-body {
      overflow: hidden;
      transition: max-height 0.2s ease;
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
    /* During execution, cap completed list so active output gets priority */
    body.task-active .completed-section {
      max-height: 180px;
    }
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
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 6px 8px;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
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

    /* ─── Task List (Plan View) ─── */
    .plan-section {
      padding: 0 8px 8px;
      min-height: 0;
      overflow-y: auto;
    }
    .playlist-group {
      margin-bottom: 6px;
    }
    .playlist-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 4px;
      font-size: 11px;
      font-weight: 600;
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
    .playlist-meta {
      font-size: 10px;
      color: var(--dimmed);
      font-weight: normal;
    }
    .task-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      font-size: 12px;
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.15s ease, box-shadow 0.15s ease;
    }
    .task-row:hover { background: var(--hover-bg); }
    .task-row:hover .task-edit-btn { opacity: 1; }
    .task-row.current-task {
      background: rgba(0,122,204,0.14);
      box-shadow: inset 2px 0 0 var(--focus-border);
    }
    .task-row.current-task .tr-name {
      font-weight: 600;
      color: var(--fg);
    }
    .task-row.focus-flash {
      animation: row-flash 0.9s ease;
    }
    @keyframes row-flash {
      0% { background: rgba(0,122,204,0.26); }
      100% { background: rgba(0,122,204,0.14); }
    }
    .tr-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tr-dot.pending { border: 1.5px solid var(--dimmed); background: transparent; }
    .tr-dot.running { background: var(--success); animation: dot-pulse 1s ease-in-out infinite; }
    .tr-dot.completed { background: var(--success); }
    .tr-dot.failed { background: var(--error); }
    .tr-dot.paused { background: var(--warning); }
    .tr-dot.skipped { background: var(--dimmed); }
    .tr-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tr-engine-tag {
      font-size: 9px;
      color: var(--dimmed);
      flex-shrink: 0;
    }
    .task-edit-btn {
      opacity: 0;
      background: none;
      border: none;
      color: var(--dimmed);
      cursor: pointer;
      font-size: 12px;
      padding: 2px 4px;
      border-radius: 2px;
      transition: opacity 0.15s;
    }
    .task-edit-btn:hover { color: var(--fg); background: var(--hover-bg); }
    .task-pill.current-task {
      box-shadow: inset 0 0 0 1px var(--focus-border), 0 0 0 1px rgba(0,122,204,0.16);
    }
    .add-btn {
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--dimmed);
      padding: 4px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      margin-top: 4px;
      width: 100%;
      text-align: center;
    }
    .add-btn:hover { color: var(--fg); border-color: var(--fg); background: var(--hover-bg); }

    /* ─── History Drawer ─── */
    .history-drawer {
      border-top: 1px solid var(--border);
      padding: 0 8px;
      margin-bottom: 8px;
    }
    .history-drawer > summary {
      padding: 8px 4px;
      cursor: pointer;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--dimmed);
      display: flex;
      align-items: center;
      gap: 8px;
    }
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
    .history-list {
      padding-bottom: 4px;
    }
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
    .hist-meta { font-size: 10px; color: var(--dimmed); flex-shrink: 0; }
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
      padding: 5px 12px;
      border-top: 1px solid var(--border);
      background: var(--sidebar-bg);
      font-size: 11px;
      color: var(--dimmed);
      flex-shrink: 0;
    }
    .status-bar .spacer { flex: 1; }

    /* ─── Empty state ─── */
    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--dimmed);
      display: none;
    }
    .empty-state-icon {
      font-size: 32px;
      margin-bottom: 12px;
      opacity: 0.4;
    }
    .empty-state-text {
      font-size: 12px;
      line-height: 1.6;
    }
    .empty-state-text strong {
      color: var(--fg);
    }

    /* ─── Error banner ─── */
    .error-banner {
      margin: 8px;
      padding: 8px 10px;
      background: rgba(244,71,71,0.1);
      border: 1px solid var(--error);
      border-radius: 4px;
      font-size: 11px;
      display: none;
    }
    .error-banner.visible { display: block; }
    .error-banner-title {
      font-weight: 600;
      color: var(--error);
      margin-bottom: 4px;
    }
    .error-banner-detail {
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 6px 8px;
      border-radius: 3px;
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin-top: 4px;
    }

    /* ─── Inline error for failed tasks ─── */
    .ct-error-line {
      font-size: 11px;
      color: var(--error);
      padding: 4px 8px 4px 28px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ─── Execution mode: keep output and navigation visible together ─── */
    body.task-active .active-task {
      flex-grow: 0;
      min-height: 220px;
      max-height: 46vh;
    }
    body.task-active .plan-section {
      max-height: 280px;
      overflow-y: auto;
    }
    body.task-active .history-drawer[open] { max-height: 120px; overflow-y: auto; }
    body.task-active .empty-state { display: none; }
    body.task-active .pill-row { max-height: 40px; }
    body.task-active .pipeline { padding: 6px 12px 4px; }

    /* ─── Diff colors ─── */
    .diff-add { color: #4ec94e; }
    .diff-del { color: #f44747; }
    .diff-hunk { color: #569cd6; }
    .diff-meta { color: #888; font-weight: bold; }

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

      .active-task-header { padding: 6px 8px; gap: 6px; }
      .active-task-name { font-size: 11px; }
      .active-task-meta { font-size: 9px; }
      .active-task-output { min-height: 80px; padding: 6px 8px; font-size: 10px; }

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

      .status-bar { padding: 4px 8px; font-size: 10px; }

      .error-banner { margin: 6px; padding: 6px 8px; font-size: 10px; }
      .error-banner-detail { font-size: 10px; max-height: 80px; }

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
      .active-task-output { min-height: 60px; }
    }

    /* ─── Responsive: wide panel (>600px) ─── */
    @media (min-width: 600px) {
      .task-pill {
        max-width: 120px;
        padding: 0 8px;
      }
      /* active-task-output sizing handled by flex layout */
      .ct-detail-output { max-height: 250px; }
      .stats-row { font-size: 12px; }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <span class="plan-name" id="plan-name">Agent Task Player</span>
    <span id="runner-status" class="status-badge status-idle">Idle</span>
    <div class="transport">
      <button id="btn-play" class="icon-btn primary" title="Play">&#9654;</button>
      <button id="btn-pause" class="icon-btn" title="Pause">&#10074;&#10074;</button>
      <button id="btn-stop" class="icon-btn" title="Stop">&#9632;</button>
    </div>
  </div>

  <!-- Pipeline overview -->
  <div class="pipeline" id="pipeline" style="display:none;">
    <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
    <div class="stats-row">
      <span id="stats-tasks">0 / 0 tasks</span>
      <span id="stats-elapsed"></span>
      <span id="stats-files"></span>
      <button style="background:none;border:none;color:var(--dimmed);cursor:pointer;font-size:9px;padding:0 2px;" id="pill-toggle" onclick="togglePillRow()" title="Toggle task pills">&#9660;</button>
    </div>
    <div class="pill-row" id="pill-row"></div>
  </div>

  <!-- Scrollable main area -->
  <div class="main-content" id="main-content">

    <!-- Active task panel -->
    <div class="active-task" id="active-task">
      <div class="active-task-header">
        <div class="active-dot"></div>
        <div class="active-task-main">
          <span class="active-task-name" id="active-task-name"></span>
          <span class="active-task-meta" id="active-task-meta"></span>
        </div>
        <span class="engine-badge" id="active-engine"></span>
        <span class="active-timer" id="active-timer">0s</span>
      </div>
      <div class="active-task-output" id="active-output"></div>
      <div class="active-task-contract" id="active-contract" style="display:none;"></div>
      <details class="active-task-prompt" id="active-prompt-section">
        <summary>Show prompt</summary>
        <pre id="active-prompt"></pre>
      </details>
    </div>

    <!-- Error banner (shown when first failure occurs) -->
    <div class="error-banner" id="error-banner">
      <div class="error-banner-title" id="error-banner-title"></div>
      <div class="error-banner-detail" id="error-banner-detail"></div>
    </div>

    <!-- Completed tasks -->
    <div class="completed-section" id="completed-section"></div>

    <!-- History drawer — above task list so it's accessible without scrolling past 93 tasks -->
    <details class="history-drawer" id="history-drawer" style="display:none;">
      <summary>
        History
        <button class="history-clear-btn" id="btn-clear-history" onclick="event.stopPropagation();">Clear</button>
      </summary>
      <div class="history-list" id="history-content"></div>
    </details>

    <details class="history-drawer" id="pm-summary-drawer">
      <summary>PM Summary</summary>
      <div class="history-list" id="pm-summary-content"></div>
    </details>

    <!-- Plan / task list -->
    <div class="plan-section" id="plan-section"></div>

    <!-- Empty state -->
    <div class="empty-state" id="empty-state">
      <div class="empty-state-icon">&#9881;</div>
      <div class="empty-state-text">
        No plan loaded.<br>
        Open a <strong>.agent-plan.json</strong> file<br>
        or use the sidebar to create one.
      </div>
    </div>

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

    // ─── Toolbar ───
    document.getElementById('btn-play').onclick = () => vscode.postMessage({ type: 'play' });
    document.getElementById('btn-pause').onclick = () => vscode.postMessage({ type: 'pause' });
    document.getElementById('btn-stop').onclick = () => vscode.postMessage({ type: 'stop' });
    document.getElementById('btn-clear-history').onclick = () => vscode.postMessage({ type: 'clearHistory' });

    // ─── Message Handler ───
    window.addEventListener('message', event => {
      const msg = event.data;

      switch (msg.type) {
        case 'update': {
          const newHash = msg.plan ? msg.plan.name + '|' + msg.plan.playlists.map(p => p.tasks.map(t => t.status || 'p').join('')).join('|') : '';
          currentPlan = msg.plan;
          currentServices = msg.services || [];
          if (newHash !== lastPlanHash) {
            lastPlanHash = newHash;
            renderPlan(msg.plan);
            renderPills(msg.plan);
          }
          renderStatus(msg.runnerState);
          renderHistory(msg.history || []);
          renderPmSummary();
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
      }
    });

    // ─── Execution Logic ───

    function resetExecution() {
      Object.keys(cardState).forEach(k => delete cardState[k]);
      currentTaskId = null;
      completedOrder = [];
      completedCount = 0;
      failedCount = 0;
      blockedCount = 0;
      totalFilesChanged = 0;
      runStartTime = null;
      taskStartTime = null;
      stopTimer();
      document.getElementById('active-task').classList.remove('visible');
      document.getElementById('active-task-meta').textContent = '';
      document.getElementById('active-contract').style.display = 'none';
      document.getElementById('active-contract').innerHTML = '';
      document.getElementById('completed-section').innerHTML = '';
      document.getElementById('error-banner').classList.remove('visible');
      syncCurrentTaskMarker();
      updateProgress();
      renderPmSummary();
    }

    function setActiveTaskMeta(playlistName, engine, phase) {
      const parts = [];
      if (playlistName) { parts.push(playlistName); }
      if (engine) { parts.push(engine.toUpperCase()); }
      if (phase) { parts.push(phase); }
      const text = parts.join(' • ');
      const meta = document.getElementById('active-task-meta');
      meta.textContent = text;
      meta.title = text;
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

    function renderActiveContract(state) {
      const el = document.getElementById('active-contract');
      const sections = [];
      if (state.command) {
        sections.push('<div class="contract-row"><span class="contract-label">Command</span><span class="contract-inline">' + escHtml(state.command) + '</span></div>');
      }
      if (state.acceptanceCriteria && state.acceptanceCriteria.length) {
        sections.push(
          '<div class="contract-row"><span class="contract-label">Acceptance Criteria</span>' +
          '<ul class="contract-list">' + state.acceptanceCriteria.map(item => '<li>' + escHtml(item) + '</li>').join('') + '</ul></div>',
        );
      }
      if (state.expectedArtifacts && state.expectedArtifacts.length) {
        sections.push(
          '<div class="contract-row"><span class="contract-label">Expected Artifacts</span>' +
          '<ul class="contract-list">' + state.expectedArtifacts.map(item => '<li>' + escHtml(item) + '</li>').join('') + '</ul></div>',
        );
      }
      if (state.ownerNote) {
        sections.push('<div class="contract-row"><span class="contract-label">Owner Note</span><span class="contract-inline">' + escHtml(state.ownerNote) + '</span></div>');
      }
      if (state.failurePolicy) {
        sections.push('<div class="contract-row"><span class="contract-label">Failure Policy</span><span class="contract-inline">' + escHtml(state.failurePolicy) + '</span></div>');
      }

      if (sections.length === 0) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
      }

      el.style.display = '';
      el.innerHTML = sections.join('');
    }

    function expandSectionBody(body) {
      if (!body || !body.id) { return; }
      body.classList.remove('collapsed');
      const sectionId = body.id.replace(/^body-/, '');
      collapsedSections[sectionId] = false;
      const toggle = document.querySelector('[data-section="' + sectionId + '"]');
      if (toggle) {
        toggle.classList.remove('collapsed');
      }
    }

    function revealTask(taskId, flash) {
      if (!taskId) { return; }
      const row = document.querySelector('.task-row[data-task-id="' + taskId + '"]');
      if (row) {
        document.querySelectorAll('.section-body.collapsed').forEach(body => {
          if (body.contains(row)) {
            expandSectionBody(body);
          }
        });
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (flash) {
          row.classList.remove('focus-flash');
          void row.offsetWidth;
          row.classList.add('focus-flash');
        }
      }
      const pill = document.querySelector('.task-pill[data-task-id="' + taskId + '"]');
      if (pill) {
        pill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
      syncCurrentTaskMarker();
    }

    function syncCurrentTaskMarker() {
      document.querySelectorAll('.task-row.current-task, .task-pill.current-task').forEach(el => {
        el.classList.remove('current-task');
      });
      if (!currentTaskId) { return; }
      const row = document.querySelector('.task-row[data-task-id="' + currentTaskId + '"]');
      const pill = document.querySelector('.task-pill[data-task-id="' + currentTaskId + '"]');
      if (row) { row.classList.add('current-task'); }
      if (pill) { pill.classList.add('current-task'); }
    }

    function wireTaskNavigation() {
      document.querySelectorAll('.task-row').forEach(row => {
        row.onclick = (event) => {
          const clickTarget = event.target instanceof Element ? event.target : null;
          if (clickTarget && clickTarget.closest('.task-edit-btn')) { return; }
          const taskId = row.dataset.taskId;
          revealTask(taskId, true);
          if (taskId === currentTaskId) {
            document.getElementById('active-task').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        };
      });
      document.querySelectorAll('.task-pill').forEach(pill => {
        pill.onclick = () => revealTask(pill.dataset.taskId, true);
      });
    }

    function startTask(msg) {
      // Enter execution mode — hides non-essential sections for max output visibility
      document.body.classList.add('task-active');

      // Initialize run timer on first task
      if (!runStartTime) {
        runStartTime = Date.now();
        startTimer();
      }
      taskStartTime = Date.now();

      currentTaskId = msg.taskId;
      cardState[msg.taskId] = {
        output: '',
        prompt: msg.prompt || '',
        engine: msg.engine || '',
        taskType: msg.taskType || 'agent',
        command: msg.command || '',
        playlistName: msg.playlistName || '',
        acceptanceCriteria: msg.acceptanceCriteria || [],
        expectedArtifacts: msg.expectedArtifacts || [],
        ownerNote: msg.ownerNote || '',
        failurePolicy: msg.failurePolicy || 'continue',
        durationMs: 0,
        exitCode: null,
        status: 'running',
        changedFiles: null,
        codeChanges: null,
        verification: null,
        artifacts: null,
        summary: '',
      };

      // Show active panel
      const panel = document.getElementById('active-task');
      panel.classList.add('visible');
      document.getElementById('active-task-name').textContent = msg.taskName;
      const runtimeLabel = msg.taskType === 'agent'
        ? (msg.engine || 'agent')
        : (msg.taskType + (msg.command ? ': ' + msg.command : ''));
      setActiveTaskMeta(msg.playlistName || '', runtimeLabel, 'Waiting for live output');

      const engineEl = document.getElementById('active-engine');
      engineEl.textContent = msg.engine || '';
      engineEl.className = 'engine-badge engine-' + (msg.engine || 'custom');

      document.getElementById('active-timer').textContent = '0s';
      showActiveOutputPlaceholder((msg.engine || 'Agent') + ' is running. Live output will appear here as soon as the task starts emitting logs.');

      const promptPre = document.getElementById('active-prompt');
      const promptSection = document.getElementById('active-prompt-section');
      if (msg.prompt) {
        promptPre.textContent = msg.prompt.length > 2000
          ? msg.prompt.substring(0, 2000) + '\\n... (truncated)'
          : msg.prompt;
        promptSection.style.display = '';
        promptSection.removeAttribute('open');
      } else {
        promptSection.style.display = 'none';
      }

      renderActiveContract(cardState[msg.taskId]);

      // Update pill
      updatePillStatus(msg.taskId, 'running');
      syncCurrentTaskMarker();
      revealTask(msg.taskId, false);

      // Scroll active task into view
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        const isNearBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 50;
        outputEl.appendChild(document.createTextNode(text));
        const active = cardState[taskId] || {};
        setActiveTaskMeta(active.playlistName || '', active.engine || '', 'Streaming live output');
        while (outputEl.childNodes.length > 500) {
          outputEl.removeChild(outputEl.firstChild);
        }
        if (isNearBottom) {
          outputEl.scrollTop = outputEl.scrollHeight;
        }
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

      // Show error banner on first failure with the actual error
      if (!passed && msg.status !== 'skipped' && msg.status !== 'blocked') {
        showErrorBanner(msg);
      }

      // Move to completed list
      addCompletedCard(msg.taskId, msg.taskName, msg);

      // Hide active panel (next start-task-card will re-show it)
      if (msg.taskId === currentTaskId) {
        document.getElementById('active-task').classList.remove('visible');
        document.getElementById('active-task-meta').textContent = '';
        currentTaskId = null;
      }

      syncCurrentTaskMarker();
      updateProgress();
      updateStatusBar();
      renderPmSummary();
    }

    function showErrorBanner(msg) {
      const banner = document.getElementById('error-banner');
      const title = document.getElementById('error-banner-title');
      const detail = document.getElementById('error-banner-detail');

      // Extract the most useful error info
      const stderr = msg.stderr || '';
      const output = (cardState[msg.taskId] || {}).output || '';
      const errorText = stderr || output || 'No output captured';
      // Get just the meaningful part — last few lines of stderr, skip blank lines
      const errorLines = errorText.split('\\n').filter(l => l.trim()).slice(-8).join('\\n');

      if (failedCount === 1) {
        // First failure — show full banner
        title.textContent = '\\u2717 Task "' + escHtml(msg.taskName) + '" failed (exit ' + msg.exitCode + ')';
        detail.textContent = errorLines || 'Exit code ' + msg.exitCode + ' — no error output captured';
        if (msg.command) {
          detail.textContent = 'Command: ' + msg.command + '\\n\\n' + detail.textContent;
        }
      } else {
        // Subsequent failures — update count
        title.textContent = '\\u2717 ' + failedCount + ' tasks failed — latest: "' + escHtml(msg.taskName) + '"';
        detail.textContent = errorLines || 'Exit code ' + msg.exitCode;
      }
      banner.classList.add('visible');
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
      row.innerHTML =
        '<span class="ct-icon ' + (passed ? 'pass' : skipped ? 'skip' : blocked ? 'fail' : 'fail') + '">' +
          (passed ? '\\u2713' : skipped ? '\\u2212' : blocked ? '!' : '\\u2717') +
        '</span>' +
        '<span class="ct-name">' + escHtml(taskName) + '</span>' +
        '<span class="ct-stats">' +
          (state.taskType ? '<span class="engine-badge engine-custom">' + escHtml(state.taskType) + '</span>' : '') +
          (state.engine ? '<span class="engine-badge engine-' + state.engine + '">' + state.engine + '</span>' : '') +
          '<span>' + durStr + '</span>' +
          (filesCount > 0 ? '<span>' + filesCount + ' file' + (filesCount !== 1 ? 's' : '') + '</span>' : '') +
        '</span>';
      row.onclick = () => card.classList.toggle('expanded');

      // For failed tasks: show inline error preview (no click needed)
      if (!passed && !skipped) {
        const errLine = document.createElement('div');
        errLine.className = 'ct-error-line';
        const stderr = msg.stderr || (state.output || '');
        const errPreview = stderr.split('\\n').filter(l => l.trim()).slice(-2).join(' | ').substring(0, 120);
        errLine.textContent = blocked ? 'blocked' : (errPreview || 'exit ' + msg.exitCode);
        errLine.title = stderr.split('\\n').filter(l => l.trim()).slice(-5).join('\\n');
        card.appendChild(errLine);
        // Auto-expand failed tasks
        card.classList.add('expanded');
      }

      // Detail panel
      const detail = document.createElement('div');
      detail.className = 'ct-detail';

      if (state.summary) {
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'ct-detail-output';
        summaryDiv.textContent = state.summary;
        detail.appendChild(summaryDiv);
      }

      if (state.command) {
        const cmdDiv = document.createElement('div');
        cmdDiv.className = 'ct-detail-output';
        cmdDiv.textContent = state.command;
        detail.appendChild(cmdDiv);
      }

      if (state.verification) {
        const verifyDiv = document.createElement('div');
        verifyDiv.className = 'ct-detail-output';
        verifyDiv.textContent =
          'Verify: ' + state.verification.command + ' -> ' +
          (state.verification.passed ? 'passed' : 'failed') +
          ' (' + formatDuration(state.verification.durationMs || 0) + ')';
        detail.appendChild(verifyDiv);
      }

      // Stderr (for failed tasks, show prominently)
      if (msg.stderr) {
        const stderrDiv = document.createElement('div');
        stderrDiv.className = 'ct-detail-output';
        stderrDiv.style.color = 'var(--error)';
        stderrDiv.textContent = msg.stderr;
        detail.appendChild(stderrDiv);
      }

      // Output (last 100 lines)
      if (state.output) {
        const lines = state.output.split('\\n');
        const tail = lines.length > 100 ? lines.slice(-100).join('\\n') : state.output;
        const outDiv = document.createElement('div');
        outDiv.className = 'ct-detail-output';
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

      // Code diff
      if (msg.codeChanges) {
        const diffSection = document.createElement('details');
        diffSection.className = 'ct-detail-section';
        const diffText = msg.codeChanges.length > 5000
          ? msg.codeChanges.substring(0, 5000) + '\\n... (truncated)'
          : msg.codeChanges;
        diffSection.innerHTML =
          '<summary>Code Changes</summary>' +
          '<pre>' + colorDiff(diffText) + '</pre>';
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
      if (totalTasks === 0) {
        fill.style.width = '0%';
        document.getElementById('stats-tasks').textContent = '0 / 0 tasks';
        return;
      }
      const pct = Math.round((completedCount / totalTasks) * 100);
      fill.style.width = pct + '%';

      if (failedCount > 0) {
        const passPct = Math.round(((completedCount - failedCount) / totalTasks) * 100);
        fill.classList.add('has-errors');
        fill.style.setProperty('--pass-pct', passPct + '%');
      } else {
        fill.classList.remove('has-errors');
      }

      document.getElementById('stats-tasks').textContent =
        completedCount + ' / ' + totalTasks + ' tasks' +
        (failedTasks > 0 || blockedTasks > 0
          ? ' (' + [
            failedTasks > 0 ? failedTasks + ' failed' : '',
            blockedTasks > 0 ? blockedTasks + ' blocked' : '',
          ].filter(Boolean).join(', ') + ')'
          : '');

      document.getElementById('stats-files').textContent =
        totalFilesChanged > 0 ? totalFilesChanged + ' file' + (totalFilesChanged !== 1 ? 's' : '') : '';
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
      if (runStartTime) {
        document.getElementById('stats-elapsed').textContent = formatDuration(Date.now() - runStartTime);
      }
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
        summary.textContent = 'Running: ' + (document.getElementById('active-task-name').textContent || cardState[currentTaskId].playlistName || 'Task');
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

    function renderPills(plan) {
      const pipeline = document.getElementById('pipeline');
      const row = document.getElementById('pill-row');
      if (!plan || !plan.playlists || plan.playlists.length === 0) {
        pipeline.style.display = 'none';
        return;
      }
      pipeline.style.display = '';

      let html = '';
      let taskCount = 0;
      plan.playlists.forEach((pl, pi) => {
        if (pi > 0) { html += '<div class="pill-separator"></div>'; }
        pl.tasks.forEach(task => {
          taskCount++;
          const isCurrent = task.id === currentTaskId || task.status === 'running';
          const runtime = (task.type || 'agent') === 'agent'
            ? (task.engine || pl.engine || plan.defaultEngine)
            : (task.type || 'agent');
          html += '<div class="task-pill ' + (task.status || 'pending') + (isCurrent ? ' current-task' : '') + '" ' +
            'data-task-id="' + task.id + '" ' +
            'title="Click to jump to ' + escHtml(task.name) + ' (' + runtime + ')">' +
            escHtml(task.name) +
            '</div>';
        });
      });
      totalTasks = taskCount;
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

      if (state === 'idle') {
        // Exit execution mode — show all sections again
        document.body.classList.remove('task-active');
        stopTimer();
        updateTimers();
        updateStatusBar();
        if (completedCount > 0 && completedCount >= totalTasks) {
          const tasks = currentPlan ? currentPlan.playlists.flatMap(pl => pl.tasks || []) : [];
          const passedTasks = tasks.filter(task => task.status === 'completed').length;
          const failedTasks = tasks.filter(task => task.status === 'failed').length;
          const blockedTasks = tasks.filter(task => task.status === 'blocked').length;
          document.getElementById('status-summary').textContent =
            passedTasks + '/' + totalTasks + ' passed' +
            ((failedTasks > 0 || blockedTasks > 0)
              ? ' \\u2014 ' + [failedTasks > 0 ? failedTasks + ' failed' : '', blockedTasks > 0 ? blockedTasks + ' blocked' : ''].filter(Boolean).join(', ')
              : ' \\u2014 All done');
        }
      }
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
      const emptyState = document.getElementById('empty-state');
      const planName = document.getElementById('plan-name');

      if (!plan || !plan.playlists) {
        section.innerHTML = '';
        emptyState.style.display = '';
        planName.textContent = 'Agent Task Player';
        return;
      }

      emptyState.style.display = 'none';
      planName.textContent = plan.name || 'Untitled Plan';

      const totalTaskCount = plan.playlists.reduce((s, pl) => s + pl.tasks.length, 0);
      const isCollapsed = collapsedSections['tasks'] || false;

      let html = '<button class="section-toggle' + (isCollapsed ? ' collapsed' : '') + '" data-section="tasks" onclick="toggleSection(&quot;tasks&quot;)">' +
        '<span class="section-toggle-icon">\\u25BC</span>' +
        '<span class="section-toggle-label">Tasks</span>' +
        '<span class="section-toggle-count">' + totalTaskCount + '</span>' +
        '</button>';

      html += '<div id="body-tasks" class="section-body' + (isCollapsed ? ' collapsed' : '') + '">';

      plan.playlists.forEach((pl, pi) => {
        const plCompleted = pl.tasks.filter(t => t.status === 'completed').length;
        const plFailed = pl.tasks.filter(t => t.status === 'failed').length;
        const plTotal = pl.tasks.length;
        const plStatusText = plCompleted > 0 || plFailed > 0
          ? ' (' + plCompleted + '/' + plTotal + (plFailed > 0 ? ', ' + plFailed + ' failed' : '') + ')'
          : '';
        const plSectionId = 'playlist-' + pi;
        const plCollapsed = collapsedSections[plSectionId] || false;

        html += '<div class="playlist-group">';
        if (plan.playlists.length > 1) {
          html += '<button class="section-toggle' + (plCollapsed ? ' collapsed' : '') + '" data-section="' + plSectionId + '" onclick="toggleSection(&quot;' + plSectionId + '&quot;)" style="padding:5px 4px 3px;">' +
            '<span class="section-toggle-icon" style="font-size:7px;">\\u25BC</span>' +
            '<span style="font-size:11px;font-weight:600;">' + escHtml(pl.name) + '</span>' +
            '<span class="playlist-engine">' + (pl.engine || plan.defaultEngine) + '</span>' +
            (pl.parallel ? '<span class="playlist-meta">parallel</span>' : '') +
            '<span class="section-toggle-count">' + plStatusText + '</span>' +
            '</button>';
        }

        html += '<div id="body-' + plSectionId + '" class="section-body' + (plCollapsed ? ' collapsed' : '') + '">';
        pl.tasks.forEach((task, ti) => {
          const isCurrent = task.id === currentTaskId || task.status === 'running';
          const taskType = task.type || 'agent';
          const criteriaCount = task.acceptanceCriteria?.length || 0;
          const artifactCount = task.expectedArtifacts?.length || 0;
          html += '<div class="task-row' + (isCurrent ? ' current-task' : '') + '" data-task-id="' + task.id + '" data-pi="' + pi + '" data-ti="' + ti + '" title="Click to jump to this task">' +
            '<div class="tr-dot ' + (task.status || 'pending') + '"></div>' +
            '<span class="tr-name">' + escHtml(task.name) + '</span>' +
            '<span class="tr-engine-tag">' + escHtml(taskType) + '</span>' +
            (task.engine && taskType === 'agent' ? '<span class="tr-engine-tag">' + task.engine + '</span>' : '') +
            (criteriaCount > 0 ? '<span class="playlist-meta">' + criteriaCount + ' criteria</span>' : '') +
            (artifactCount > 0 ? '<span class="playlist-meta">' + artifactCount + ' artifacts</span>' : '') +
            '<button class="task-edit-btn" onclick="editTask(' + pi + ',' + ti + ')" title="Edit">\\u270E</button>' +
            '</div>';
        });

        html += '<button class="add-btn" onclick="addTask(' + pi + ')">+ Add Task</button>';
        html += '</div>'; // section-body
        html += '</div>'; // playlist-group
      });

      html += '<button class="add-btn" onclick="addPlaylist()" style="margin-top:4px;">+ Add Playlist</button>';
      html += '</div>'; // section-body for tasks
      section.innerHTML = html;
      wireTaskNavigation();
      syncCurrentTaskMarker();
    }

    function renderHistory(entries) {
      const drawer = document.getElementById('history-drawer');
      const container = document.getElementById('history-content');
      if (!entries.length) {
        drawer.style.display = 'none';
        return;
      }
      drawer.style.display = '';

      let html = '';
      entries.slice(0, 20).forEach((entry, idx) => {
        const passed = entry.status === 'completed';
        const time = entry.startedAt ? entry.startedAt.split('T')[1]?.substring(0, 5) || '' : '';
        const durStr = formatDuration(entry.result.durationMs || 0);

        html += '<div class="hist-row" id="hist-' + idx + '" onclick="toggleHistRow(this)">' +
          '<span class="hist-icon ' + (passed ? 'pass' : 'fail') + '">' + (passed ? '\\u2713' : '\\u2717') + '</span>' +
          '<span class="hist-name">' + escHtml(entry.taskName) + '</span>' +
          '<span class="hist-meta">' + durStr + '</span>' +
          '</div>';

        html += '<div class="hist-detail">';
        if (entry.taskType) {
          html += '<div style="font-size:10px;padding:2px 0;color:var(--dimmed);">Type: ' + escHtml(entry.taskType) + '</div>';
        }
        if (entry.result.summary) {
          html += '<div style="font-size:10px;padding:2px 0;">' + escHtml(entry.result.summary) + '</div>';
        }
        if (entry.result.command) {
          html += '<pre>' + escHtml(entry.result.command) + '</pre>';
        }
        if (entry.verification) {
          html += '<div style="font-size:10px;padding:2px 0;">Verify: ' + escHtml(entry.verification.command) + ' -> ' + (entry.verification.passed ? 'pass' : 'fail') + '</div>';
        }
        if (entry.result.stdout) {
          const outText = entry.result.stdout.length > 500
            ? entry.result.stdout.substring(0, 500) + '...'
            : entry.result.stdout;
          html += '<pre>' + escHtml(outText) + '</pre>';
        }
        if (entry.artifacts && entry.artifacts.length > 0) {
          html += '<div style="font-size:10px;padding:2px 0;">Artifacts: ' + entry.artifacts.filter(artifact => artifact.exists).length + '/' + entry.artifacts.length + '</div>';
        }
        if (entry.changedFiles && entry.changedFiles.length > 0) {
          html += '<div style="font-size:10px;padding:2px 0;">' + entry.changedFiles.length + ' files changed</div>';
        }
        html += '</div>';
      });
      container.innerHTML = html;
    }

    function renderPmSummary() {
      const container = document.getElementById('pm-summary-content');
      if (!container) { return; }

      if (!currentPlan) {
        container.innerHTML = '<div class="hist-detail">No plan loaded.</div>';
        return;
      }

      const tasks = currentPlan.playlists.flatMap(pl => pl.tasks || []);
      const total = tasks.length;
      const completed = tasks.filter(task => task.status === 'completed').length;
      const failed = tasks.filter(task => task.status === 'failed').length;
      const blocked = tasks.filter(task => task.status === 'blocked').length;
      const running = tasks.find(task => task.status === 'running');
      const currentPhase = currentPlan.playlists.find(pl => pl.tasks.some(task => task.status === 'running' || task.status === 'failed' || task.status === 'blocked'))
        || currentPlan.playlists.find(pl => pl.tasks.some(task => task.status !== 'completed' && task.status !== 'skipped'))
        || currentPlan.playlists[currentPlan.playlists.length - 1];
      const latestDone = completedOrder.length > 0 ? cardState[completedOrder[completedOrder.length - 1]] : null;
      const servicesHtml = currentServices.length > 0
        ? currentServices.map(service => '<li>' + escHtml(service.taskName) + (service.port ? ' (port ' + service.port + ')' : '') + '</li>').join('')
        : '<li>No services running</li>';

      container.innerHTML =
        '<div class="hist-detail">' +
          '<div><strong>Phase:</strong> ' + escHtml(currentPhase?.name || 'N/A') + '</div>' +
          '<div><strong>Progress:</strong> ' + completed + ' / ' + total + ' complete</div>' +
          '<div><strong>Failures:</strong> ' + failed + ' failed, ' + blocked + ' blocked</div>' +
          '<div><strong>Latest outcome:</strong> ' + escHtml(latestDone?.summary || latestDone?.status || 'No completed tasks yet') + '</div>' +
          '<div><strong>Files changed:</strong> ' + totalFilesChanged + '</div>' +
          '<div><strong>Running now:</strong> ' + escHtml(running?.name || 'Idle') + '</div>' +
          '<div style="margin-top:6px;"><strong>Services</strong><ul style="padding-left:16px;margin:4px 0 0;">' + servicesHtml + '</ul></div>' +
        '</div>';
    }

    // ─── Interactions ───

    function toggleHistRow(el) {
      el.classList.toggle('expanded');
    }

    function addPlaylist() { vscode.postMessage({ type: 'addPlaylist' }); }
    function addTask(pi) { vscode.postMessage({ type: 'addTask', playlistIndex: pi }); }
    function editTask(pi, ti) { vscode.postMessage({ type: 'editTask', playlistIndex: pi, taskIndex: ti }); }

    let pillRowCollapsed = false;
    function togglePillRow() {
      pillRowCollapsed = !pillRowCollapsed;
      const row = document.getElementById('pill-row');
      const toggle = document.getElementById('pill-toggle');
      if (pillRowCollapsed) {
        row.classList.add('collapsed');
        toggle.innerHTML = '\\u25B6';
      } else {
        row.classList.remove('collapsed');
        toggle.innerHTML = '\\u25BC';
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
        if (line.startsWith('+++') || line.startsWith('---')) return '<span class="diff-meta">' + escaped + '</span>';
        if (line.startsWith('@@')) return '<span class="diff-hunk">' + escaped + '</span>';
        if (line.startsWith('+')) return '<span class="diff-add">' + escaped + '</span>';
        if (line.startsWith('-')) return '<span class="diff-del">' + escaped + '</span>';
        return escaped;
      }).join('\\n');
    }

    // ─── Init ───

    // Embedded initial state — rendered at HTML generation time,
    // no postMessage round-trip needed for first paint.
    (function() {
      try {
        const initState = JSON.parse(decodeBase64Utf8('${initialStateBase64}'));
        if (initState && initState.plan) {
          currentPlan = initState.plan;
          renderPlan(initState.plan);
          renderStatus(initState.runnerState || 'idle');
          renderPills(initState.plan);
          renderHistory(initState.history || []);
        } else {
          // No plan embedded — show empty state
          document.getElementById('empty-state').style.display = '';
        }
      } catch(e) {
        console.error('[Dashboard] Failed to parse initial state:', e);
        document.getElementById('empty-state').style.display = '';
      }
    })();

    // Tell the extension we are ready, then request fresh state
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'refresh' });

    // Retry polling: if no plan loaded after init, keep asking the extension
    // for up to 5 seconds (covers async plan loading race condition)
    (function() {
      let retries = 0;
      const maxRetries = 10;
      const interval = setInterval(function() {
        retries++;
        if (currentPlan || retries >= maxRetries) {
          clearInterval(interval);
          if (!currentPlan) {
            document.getElementById('empty-state').style.display = '';
          }
          return;
        }
        vscode.postMessage({ type: 'refresh' });
      }, 500);
    })();
  </script>
</body>
</html>`;
  }
}
