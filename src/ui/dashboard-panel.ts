// ─── Dashboard webview panel ───
// Provides a rich UI for task editing, play/pause/stop controls,
// live output streaming, and history viewing.

import * as vscode from 'vscode';
import { Plan, Task, Playlist, EngineResult, VerificationResult, TaskArtifact } from '../models/types';
import { HistoryStore } from '../history/store';
import { TaskRunner } from '../runner/runner';
import { designSystemCssTokens } from './design-system';
import { SandboxState } from '../sandbox/sandbox-manager';

// Diagnostic output channel for debugging dashboard issues
const outputChannel = vscode.window.createOutputChannel('ATP Dashboard');

// Increment this whenever the HTML/JS template changes. If the webview
// reports a different version on webview-ready, we force a full re-render
// instead of just posting a data update — this fixes stale cached webviews
// that VS Code restores from a previous session with old HTML.
const HTML_VERSION = '9';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _outputBuffer: { text: string; stream: 'stdout' | 'stderr'; taskId?: string }[] = [];
  private _outputFlushTimer: ReturnType<typeof setInterval> | null = null;
  private _webviewReadyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;
  private _webviewReady = false;
  private _sandboxState: SandboxState | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly runner: TaskRunner,
    private readonly historyStore: HistoryStore,
    private getPlan: () => Plan | null,
    private savePlanCallback: () => void,
    private readonly getPromptEngines: () => Array<{ id: string; label: string }>,
    private readonly getSelectedPromptEngineId: () => string | undefined,
    private readonly submitPrompt: (prompt: string, engineId?: string) => Promise<boolean>,
    private readonly generatePlanFromPrompt: (prompt: string) => Promise<boolean>,
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
    getPromptEngines: () => Array<{ id: string; label: string }>,
    getSelectedPromptEngineId: () => string | undefined,
    submitPrompt: (prompt: string, engineId?: string) => Promise<boolean>,
    generatePlanFromPrompt: (prompt: string) => Promise<boolean>,
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

    // Allow loading local files (screenshots) from any workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const localRoots = workspaceFolders.map(f => f.uri);

    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerDashboard',
      'MOAG',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: localRoots,
      },
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel,
      extensionUri,
      runner,
      historyStore,
      getPlan,
      savePlanCallback,
      getPromptEngines,
      getSelectedPromptEngineId,
      submitPrompt,
      generatePlanFromPrompt,
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
      promptEngines: this.getPromptEngines(),
      selectedPromptEngineId: this.getSelectedPromptEngineId(),
      sandboxState: this._sandboxState,
    }, this._webviewReady ? [0] : [0, 200, 600]);
  }

  /**
   * Called by extension.ts whenever the sandbox state changes.
   * Converts the screenshot path to a webview URI before posting so the
   * <img> tag can load the local file.
   */
  public postSandboxState(state: SandboxState): void {
    this._sandboxState = state;
    const serializable = { ...state };
    if (state.lastScreenshotPath) {
      try {
        serializable.lastScreenshotPath = this._panel.webview
          .asWebviewUri(vscode.Uri.file(state.lastScreenshotPath))
          .toString();
      } catch {
        // keep raw path as fallback
      }
    }
    this.safePostMessage({ type: 'sandbox-state', sandboxState: serializable });
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
    validationTargetResults?: import('../models/types').HistoryEntry['validationTargetResults'],
  ): void {
    // Send stderr/stdout snippet so the dashboard can show WHY a task failed
    const stderrSnippet = result.stderr
      ? result.stderr.substring(0, 8000)
      : '';
    const stdoutTail = result.stdout
      ? result.stdout.substring(Math.max(0, result.stdout.length - 3000))
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
      validationTargetResults: validationTargetResults ?? null,
    });
  }

  /** Clear all task cards from the timeline */
  public clearTimeline(): void {
    this.postMessageWithRetries({ type: 'clear-timeline' });
  }

  private async handlePromptSubmission(msg: { prompt?: unknown; engineId?: unknown }): Promise<void> {
    const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : '';
    const engineId = typeof msg.engineId === 'string' ? msg.engineId : undefined;

    if (!prompt) {
      return;
    }

    this.safePostMessage({ type: 'composer-action-state', action: 'run', busy: true });

    try {
      const submitted = await this.submitPrompt(prompt, engineId);
      if (submitted) {
        this.safePostMessage({ type: 'composer-action-success', action: 'run' });
      }
    } finally {
      this.safePostMessage({ type: 'composer-action-state', action: 'run', busy: false });
      this.update();
    }
  }

  private async handlePlanGeneration(msg: { prompt?: unknown }): Promise<void> {
    const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : '';

    if (!prompt) {
      return;
    }

    this.safePostMessage({ type: 'composer-action-state', action: 'plan', busy: true });

    try {
      const generated = await this.generatePlanFromPrompt(prompt);
      if (generated) {
        this.safePostMessage({ type: 'composer-action-success', action: 'plan' });
      }
    } finally {
      this.safePostMessage({ type: 'composer-action-state', action: 'plan', busy: false });
      this.update();
    }
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    outputChannel.appendLine(`[handleMessage] type=${msg.type}`);
    switch (msg.type) {
      case 'webview-ready':
        if (this._webviewReady) {
          break;
        }
        // If the webview reports a stale HTML version (VS Code restored old
        // cached HTML from a previous session), force a full re-render.
        if (msg.htmlVersion !== HTML_VERSION) {
          outputChannel.appendLine(`[handleMessage] stale htmlVersion=${msg.htmlVersion}, expected=${HTML_VERSION} — forcing re-render`);
          this.renderWebview();
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
      case 'submit-prompt':
        void this.handlePromptSubmission({ prompt: msg.prompt, engineId: msg.engineId });
        break;
      case 'generate-plan':
        void this.handlePlanGeneration({ prompt: msg.prompt });
        break;
      case 'run-prompt':
        vscode.commands.executeCommand('agentTaskPlayer.runPrompt', msg.prompt);
        break;
      case 'smart-plan':
        vscode.commands.executeCommand('agentTaskPlayer.smartNewPlan');
        break;
      case 'new-plan-template':
        vscode.commands.executeCommand('agentTaskPlayer.newPlanFromTemplate');
        break;
      case 'open-plan':
        vscode.commands.executeCommand('agentTaskPlayer.openPlan');
        break;
      case 'detect-engines':
        vscode.commands.executeCommand('agentTaskPlayer.detectEngines');
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
      case 'show-history':
        vscode.commands.executeCommand('agentTaskPlayer.showHistory');
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
      case 'retryTaskWithNote': {
        const taskId = msg.taskId as string | undefined;
        if (taskId) {
          const plan = this.getPlan();
          if (plan) {
            for (let pi = 0; pi < plan.playlists.length; pi++) {
              for (let ti = 0; ti < plan.playlists[pi].tasks.length; ti++) {
                if (plan.playlists[pi].tasks[ti].id === taskId) {
                  vscode.commands.executeCommand('agentTaskPlayer.retryTaskWithNote', {
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
      case 'open-settings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'agentTaskPlayer');
        break;
      case 'sandbox-launch':
        vscode.commands.executeCommand('agentTaskPlayer.launchSandbox');
        break;
      case 'sandbox-stop':
        vscode.commands.executeCommand('agentTaskPlayer.stopSandbox');
        break;
      case 'sandbox-screenshot':
        vscode.commands.executeCommand('agentTaskPlayer.takeScreenshot');
        break;
      case 'sandbox-open-browser': {
        const url = typeof msg.url === 'string' ? msg.url : null;
        if (url) {
          vscode.commands.executeCommand('simpleBrowser.api.open', url);
        }
        break;
      }
    }
  }

  /** Stream sandbox dev-server output to the dashboard terminal pane */
  public appendSandboxOutput(text: string): void {
    this.safePostMessage({ type: 'sandbox-output', text });
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
      promptEngines: this.getPromptEngines(),
      selectedPromptEngineId: this.getSelectedPromptEngineId(),
    }), 'utf8').toString('base64');
    outputChannel.appendLine(`[getHtml] base64 length=${initialStateBase64.length}`);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MOAG</title>
  <style>
    ${designSystemCssTokens()}
    :root {
      --bg: var(--ds-bg);
      --fg: var(--ds-fg);
      --border: var(--ds-border);
      --button-bg: var(--ds-btn-bg);
      --button-fg: var(--ds-btn-fg);
      --button-hover: var(--ds-btn-hover);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --success: var(--ds-success);
      --error: var(--ds-error);
      --warning: var(--ds-warning);
      --dimmed: var(--vscode-disabledForeground, rgba(128,128,128,0.6));
      --sidebar-bg: var(--ds-surface);
      --terminal-bg: var(--vscode-terminal-background, #1e1e1e);
      --terminal-fg: var(--vscode-terminal-foreground, #ccc);
      --hover-bg: var(--ds-hover);
      --focus-border: var(--ds-focus);
      --progress-bg: var(--vscode-progressBar-background, #007acc);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }

    html, body {
      height: 100vh;
      width: 100%;
      max-height: 100vh;
      max-width: 100%;
      overflow: hidden;
      min-height: 0;
    }

    body {
      font-family: var(--ds-font-family);
      font-size: var(--ds-font-size);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      min-height: 0;
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
      height: 44px;
      min-height: 44px;
      max-height: 44px;
      flex-wrap: nowrap;
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
    .transport { display: flex; gap: 2px; flex-shrink: 0; }
    .icon-btn {
      width: 26px; height: 26px; border: none; border-radius: 4px;
      background: transparent; color: var(--fg); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; transition: background 0.1s;
    }
    .icon-btn:hover { background: var(--hover-bg); }
    .icon-btn:disabled { opacity: 0.3; cursor: default; }
    .icon-btn:disabled:hover { background: transparent; }
    .icon-btn.primary { background: var(--button-bg); color: var(--button-fg); }
    .icon-btn.primary:hover { background: var(--button-hover); }
    .icon-btn.primary:disabled { background: var(--button-bg); opacity: 0.4; }

    /* ─── Zone Layout ─── */
    .main-zone {
      flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
      display: flex; flex-direction: column;
    }
    body[data-dashboard-state="executing"] .main-zone {
      overflow: hidden;
    }
    /* ─── Progress Section ─── */
    .progress-section {
      padding: 4px 12px 0;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      height: 30px;
      min-height: 30px;
      max-height: 30px;
    }
    .progress-track { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; margin-bottom: 4px; }
    .progress-fill { height: 100%; background: var(--success); border-radius: 2px; transition: width 0.4s ease; width: 0%; }
    .progress-fill.has-errors {
      background: linear-gradient(90deg, var(--success) 0%, var(--success) var(--pass-pct), var(--error) var(--pass-pct), var(--error) 100%);
    }
    .stats-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--dimmed); margin-bottom: 0; line-height: 20px; }
    .minimap { display: flex; flex-wrap: wrap; gap: 2px; max-height: 22px; overflow: hidden; }
    body[data-dashboard-state="executing"] .minimap { display: none; }
    .minimap .dot {
      width: 6px; height: 6px; border-radius: 1px;
    }
    .minimap .dot.completed { background: var(--success); }
    .minimap .dot.failed { background: var(--error); }
    .minimap .dot.pending { background: rgba(128,128,128,0.3); }
    .minimap .dot.running { background: var(--success); animation: pill-pulse 1.5s infinite; }
    .minimap .dot.skipped { background: rgba(128,128,128,0.15); }
    @keyframes pill-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }

    /* ─── Playlist Tiles ─── */
    #playlist-tiles {
      display: flex; flex-wrap: wrap; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .playlist-tile {
      display: flex; flex-direction: column; gap: 3px;
      padding: 8px 12px; background: var(--hover-bg);
      border: 1px solid var(--border); border-radius: 6px;
      cursor: pointer; font-family: var(--vscode-font-family); color: var(--fg);
      text-align: left; min-width: 90px; max-width: 180px;
      transition: border-color 0.15s, background 0.15s;
    }
    .playlist-tile:hover { background: rgba(128,128,128,0.15); }
    .playlist-tile.is-active { border-color: var(--focus-border); background: rgba(0,122,204,0.08); }
    .playlist-tile.has-failure { border-color: var(--error); }
    .playlist-tile.is-done { opacity: 0.65; }
    .tile-name {
      font-size: 11px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 156px;
    }
    .tile-meta { display: flex; align-items: center; gap: 6px; }
    .tile-status {
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      padding: 1px 5px; border-radius: 3px; letter-spacing: 0.3px;
    }
    .tile-status.running { background: rgba(76,175,80,0.2); color: var(--success); }
    .tile-status.done { background: rgba(76,175,80,0.15); color: var(--success); }
    .tile-status.failed { background: rgba(244,71,71,0.15); color: var(--error); }
    .tile-status.pending { background: var(--badge-bg); color: var(--badge-fg); }
    .tile-fraction { font-size: 10px; color: var(--dimmed); }

    /* ─── Active Task Terminal ─── */
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
      display: flex; align-items: center; gap: 8px;
      min-height: 32px; height: 32px; max-height: 32px; padding: 0 10px;
      background: rgba(0,122,204,0.04);
      border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .active-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--success); flex-shrink: 0;
      animation: dot-pulse 1s ease-in-out infinite;
    }
    @keyframes dot-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.7); opacity: 0.4; }
    }
    .active-task-name {
      flex: 1; font-weight: 600; font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .engine-badge {
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      padding: 1px 5px; border-radius: 3px; letter-spacing: 0.4px; flex-shrink: 0;
    }
    .engine-claude { background: #e8a04c22; color: #e8a04c; }
    .engine-codex { background: #4caf5022; color: #4caf50; }
    .engine-gemini { background: #4285f422; color: #4285f4; }
    .engine-ollama { background: #9c27b022; color: #9c27b0; }
    .engine-custom { background: rgba(128,128,128,0.15); color: var(--dimmed); }
    .active-timer {
      font-size: 11px; font-family: var(--vscode-editor-font-family, monospace);
      color: var(--dimmed); flex-shrink: 0;
    }

    /* ─── Terminal Output ─── */
    .terminal-output {
      background: var(--terminal-bg); color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; overflow-y: auto; white-space: pre-wrap;
      word-break: break-all; word-wrap: break-word; line-height: 1.4;
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
    }
    .active-output-empty { color: var(--dimmed); font-style: italic; }

    /* ─── Idle Plan Summary ─── */
    .plan-summary {
      margin: 12px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--sidebar-bg);
    }
    .plan-summary-name { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .plan-summary-desc {
      font-size: 12px;
      color: var(--dimmed);
      margin-bottom: 12px;
      max-height: 36px;
      overflow: hidden;
    }
    .plan-summary-playlists { font-size: 12px; margin-bottom: 12px; }
    .plan-summary-pl { padding: 3px 0; display: flex; justify-content: space-between; gap: 8px; }
    .plan-summary-total { font-size: 12px; color: var(--dimmed); margin-bottom: 12px; }
    .plan-summary-play {
      width: 100%; padding: 8px; border: none; border-radius: 4px;
      background: var(--button-bg); color: var(--button-fg);
      font-size: 13px; font-weight: 600; cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    .plan-summary-play:hover { background: var(--button-hover); }
    .no-plan-message {
      margin: 12px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--sidebar-bg);
      font-size: 12px;
      color: var(--dimmed);
    }

    /* ─── Result Banner ─── */
    .result-banner {
      margin: 8px; padding: 10px 14px; border-radius: 6px;
      border-left: 3px solid var(--success); background: rgba(76,175,80,0.10); flex-shrink: 0;
    }
    .result-banner.result-warning { border-left-color: var(--warning); background: rgba(229,160,0,0.12); }
    .result-banner-header { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .result-banner-copy { flex: 1; min-width: 0; }
    .result-banner-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
    .result-banner-meta { font-size: 11px; color: var(--dimmed); }
    .result-banner-actions { display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0; }
    .result-banner-btn {
      font-size: 11px; padding: 3px 10px; background: var(--button-bg); color: var(--button-fg);
      border: none; border-radius: 3px; cursor: pointer; font-family: var(--vscode-font-family);
    }
    .result-banner-btn:hover { background: var(--button-hover); }
    .result-banner-btn:disabled { opacity: 0.4; cursor: default; }

    /* ─── Section Toggle ─── */
    .section-toggle {
      display: flex; align-items: center; gap: 4px;
      width: 100%; height: 22px; line-height: 22px;
      padding: 0; border: none; background: none;
      cursor: pointer; user-select: none; color: var(--fg);
    }
    .section-toggle:hover { background: var(--hover-bg); }
    .section-toggle-icon { font-size: 12px; width: 20px; text-align: center; flex-shrink: 0; transition: transform 0.1s; opacity: 0.8; }
    .section-toggle.collapsed .section-toggle-icon { transform: rotate(-90deg); }
    .section-toggle-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; flex: 1; }
    .section-toggle-count { font-size: 10px; font-weight: normal; opacity: 0.6; padding-right: 8px; }
    .section-body { overflow: hidden; }
    .section-body.collapsed { display: none; }

    /* ─── Completed Task Cards ─── */
    .completed-section { padding: 0 0 8px; }
    .completed-section-header {
      display: flex; align-items: center; justify-content: space-between;
      margin: 0 8px; height: 24px;
    }
    .completed-show-all {
      font-size: 11px; color: var(--focus-border);
      border: none; background: none; cursor: pointer; padding: 0 8px;
      font-family: var(--vscode-font-family);
    }
    .completed-show-all:hover { text-decoration: underline; }
    .completed-task { border-left: 2px solid transparent; margin: 0 8px 2px; border-radius: 3px; }
    .completed-task.failed-task { border-left-color: var(--error); }
    .completed-task-row {
      display: flex; align-items: center; gap: 8px;
      min-height: 28px; height: 28px; padding: 0 8px; cursor: pointer; border-radius: 3px;
    }
    .completed-task-row:hover { background: var(--hover-bg); }
    .ct-icon {
      width: 16px; height: 16px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; flex-shrink: 0;
    }
    .ct-icon.pass { background: rgba(76,175,80,0.15); color: var(--success); }
    .ct-icon.fail { background: rgba(244,71,71,0.15); color: var(--error); }
    .ct-icon.skip { background: rgba(128,128,128,0.1); color: var(--dimmed); }
    .ct-name { flex: 1; font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ct-stats { display: flex; align-items: center; gap: 4px; flex-shrink: 0; font-size: 11px; color: var(--dimmed); }
    .ct-error-line {
      font-size: 11px; color: var(--error); padding: 2px 8px 4px 32px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ct-detail { display: none; padding: 4px 8px 8px 32px; }
    .completed-task.expanded .ct-detail { display: block; }
    .ct-detail-output {
      font-size: 10px; padding: 4px 6px; border-radius: 3px;
      margin-bottom: 4px; max-height: 160px; overflow-y: auto;
    }

    /* ─── Diff Viewer ─── */
    .diff-add { background: rgba(78,201,176,0.15); color: inherit; }
    .diff-remove { background: rgba(244,71,71,0.15); color: inherit; }
    .diff-hunk { color: var(--dimmed); font-style: italic; }
    .diff-header { font-weight: 700; color: var(--fg); }

    /* ─── Sandbox Panel ─── */
    .sandbox-section { border-top: 1px solid var(--border); flex-shrink: 0; }
    .sandbox-content { padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
    .sandbox-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .sandbox-framework { font-size: 11px; font-weight: 600; }
    .sandbox-url { font-size: 11px; color: var(--dimmed); text-decoration: none; }
    .sandbox-url:hover { color: var(--fg); text-decoration: underline; cursor: pointer; }
    .sandbox-status-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: var(--dimmed);
    }
    .sandbox-status-dot.running { background: var(--success); box-shadow: 0 0 4px var(--success); }
    .sandbox-status-dot.starting { background: var(--warning); animation: pulse 1.2s ease-in-out infinite; }
    .sandbox-status-dot.error { background: var(--error); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
    .sandbox-status-label { font-size: 10px; color: var(--dimmed); }
    .sandbox-btn {
      font-size: 11px; padding: 3px 10px; border: none; border-radius: 3px; cursor: pointer;
      background: var(--button-bg); color: var(--button-fg); font-family: var(--vscode-font-family);
      white-space: nowrap;
    }
    .sandbox-btn:hover { background: var(--button-hover); }
    .sandbox-btn:disabled { opacity: 0.4; cursor: default; }
    .sandbox-btn.primary { background: var(--focus-border); color: #fff; }
    .sandbox-btn.primary:hover { opacity: 0.85; }
    .sandbox-screenshot-thumb {
      max-width: 100%; max-height: 180px; border-radius: 4px;
      border: 1px solid var(--border); cursor: pointer;
      object-fit: contain; display: block;
    }
    .sandbox-screenshot-label { font-size: 10px; color: var(--dimmed); margin-bottom: 3px; }
    .sandbox-output {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; line-height: 1.4; color: var(--terminal-fg);
      background: var(--terminal-bg); padding: 6px 8px; border-radius: 3px;
      max-height: 80px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
    }
    .status-bar {
      height: 28px;
      min-height: 28px;
      max-height: 28px;
      padding: 0 10px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--dimmed);
      background: var(--sidebar-bg);
      flex-shrink: 0;
    }
    .status-bar .spacer { flex: 1; min-width: 0; }

  </style>
</head>
<body>
  <!-- A. Header Bar (fixed top, 44px) -->
  <div class="header" id="header">
    <button class="plan-name" id="plan-name" onclick="vscode.postMessage({type:'switch-plan'})">MOAG</button>
    <span id="runner-status" class="status-badge status-idle">Idle</span>
    <div class="transport">
      <button id="btn-play" class="icon-btn primary" title="Play">▶</button>
      <button id="btn-pause" class="icon-btn" title="Pause">⏸</button>
      <button id="btn-stop" class="icon-btn" title="Stop">■</button>
    </div>
  </div>

  <!-- Dashboard State Sections -->
  <div class="progress-section" id="progress-section" hidden>
    <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
    <div class="stats-row">
      <span id="stats-tasks">0/0 tasks (0 failed)</span>
      <span id="stats-elapsed"></span>
    </div>
    <div class="minimap" id="minimap"></div>
  </div>

  <!-- Main scrollable zone -->
  <div class="main-zone" id="main-content">

    <!-- EXECUTING: Active task terminal -->
    <div class="active-task" id="active-task" hidden>
      <div class="active-task-header">
        <div class="active-dot"></div>
        <span class="active-task-name" id="active-task-name"></span>
        <span class="engine-badge" id="active-engine"></span>
        <span class="active-timer" id="active-timer">0s</span>
      </div>
      <div class="terminal-output active-task-output" id="active-output"></div>
    </div>

    <!-- IDLE: Plan summary -->
    <div class="plan-summary" id="plan-summary" hidden>
      <div class="plan-summary-name" id="plan-summary-name"></div>
      <div class="plan-summary-desc" id="plan-summary-desc" hidden></div>
      <div class="plan-summary-playlists" id="plan-summary-playlists"></div>
      <div class="plan-summary-total" id="plan-summary-total"></div>
      <button class="plan-summary-play" id="plan-summary-play">▶ Play</button>
    </div>
    <div class="no-plan-message" id="no-plan-message" hidden>
      No plan loaded. Use the sidebar to create a plan or run a prompt.
    </div>

    <!-- IDLE + COMPLETE: Result banner -->
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

    <!-- IDLE + COMPLETE: Error banner -->
    <div class="error-banner" id="error-banner"></div>

    <!-- COMPLETE: Completed cards -->
    <div class="completed-section" id="completed-section" hidden></div>

    <!-- Sandbox Panel — always shown when a workspace is open -->
    <div class="sandbox-section" id="sandbox-section">
      <button class="section-toggle" data-section="sandbox" onclick="toggleSection('sandbox')">
        <span class="section-toggle-icon">&#x25BC;</span>
        <span class="section-toggle-label">Sandbox</span>
        <span class="section-toggle-count" id="sandbox-status-badge"></span>
      </button>
      <div class="section-body collapsed" id="body-sandbox">
        <div class="sandbox-content">
          <div class="sandbox-row" id="sandbox-info-row">
            <span class="sandbox-status-dot" id="sandbox-dot"></span>
            <span class="sandbox-status-label" id="sandbox-status-label">Not started</span>
            <span class="sandbox-framework" id="sandbox-framework"></span>
            <a class="sandbox-url" id="sandbox-url" hidden
               onclick="vscode.postMessage({type:'sandbox-open-browser',url:this.dataset.url})"
               title="Open in VS Code Simple Browser"></a>
          </div>
          <div class="sandbox-row" id="sandbox-action-row">
            <button class="sandbox-btn primary" id="sandbox-btn-launch"
                    onclick="vscode.postMessage({type:'sandbox-launch'})">Launch Sandbox</button>
            <button class="sandbox-btn" id="sandbox-btn-stop" hidden
                    onclick="vscode.postMessage({type:'sandbox-stop'})">Stop</button>
            <button class="sandbox-btn" id="sandbox-btn-screenshot"
                    onclick="vscode.postMessage({type:'sandbox-screenshot'})"
                    title="Capture screenshot and attach to next agent task">Screenshot</button>
          </div>
          <div id="sandbox-output-wrap" hidden>
            <div class="sandbox-output" id="sandbox-output"></div>
          </div>
          <div id="sandbox-screenshot-wrap" hidden>
            <div class="sandbox-screenshot-label">Last screenshot (attached to next task)</div>
            <img class="sandbox-screenshot-thumb" id="sandbox-screenshot-img" src="" alt="screenshot" />
          </div>
        </div>
      </div>
    </div>

  </div>

  <!-- E. Status Bar (fixed bottom, 28px) -->
  <div class="status-bar">
    <span id="status-summary">Ready</span>
    <span class="spacer"></span>
    <span id="status-right"></span>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    window.__moagHtmlVersion = '${HTML_VERSION}';

    function decodeBase64Utf8(value) {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
      return new TextDecoder().decode(bytes);
    }

    // ─── State ───
    const cardState = {};
    let currentTaskId = null;
    let completedOrder = [];
    let completedTasks = [];
    const completedExpandedState = {};
    let showAllCompletedCards = false;
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
    var dashboardState = 'idle'; // 'idle' | 'executing' | 'complete'
    let runnerState = 'idle';
    let promptBusy = false;
    let composerBusyAction = '';
    let promptEngines = [];
    let selectedPromptEngineId = '';
    const taskStartTimes = {};
    const promptComposerEl = document.getElementById('prompt-composer');
    const promptInputEl = document.getElementById('prompt-input');
    const promptEngineEl = document.getElementById('prompt-engine');
    const promptSubmitEl = document.getElementById('prompt-submit');
    const promptGeneratePlanEl = document.getElementById('prompt-generate-plan');
    const promptAddTaskEl = document.getElementById('prompt-add-task');
    const promptAddPlaylistEl = document.getElementById('prompt-add-playlist');
    const promptContextPillEl = document.getElementById('prompt-context-pill');
    const promptContextNoteEl = document.getElementById('prompt-context-note');
    const promptCharCountEl = document.getElementById('prompt-char-count');

    // ─── Toolbar ───
    if (promptSubmitEl) { promptSubmitEl.onclick = submitPromptFromComposer; }
    if (promptGeneratePlanEl) { promptGeneratePlanEl.onclick = generatePlanFromComposer; }
    if (promptAddTaskEl) { promptAddTaskEl.onclick = function() { vscode.postMessage({ type: 'addTask' }); }; }
    if (promptAddPlaylistEl) { promptAddPlaylistEl.onclick = function() { vscode.postMessage({ type: 'addPlaylist' }); }; }
    if (promptInputEl) {
      promptInputEl.addEventListener('input', function() {
        autoResizePromptInput();
        updatePromptCharCount();
        renderPromptComposerState();
      });
      promptInputEl.addEventListener('keydown', function(event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          submitPromptFromComposer();
        }
      });
    }
    if (promptEngineEl) {
      promptEngineEl.addEventListener('change', function() {
        selectedPromptEngineId = promptEngineEl.value;
        renderPromptComposerState();
        renderEngineStatus();
      });
    }
    document.getElementById('btn-play').onclick = () => vscode.postMessage({ type: 'play' });
    document.getElementById('btn-pause').onclick = () => vscode.postMessage({ type: 'pause' });
    document.getElementById('btn-stop').onclick = () => vscode.postMessage({ type: 'stop' });
    var summaryPlayBtn = document.getElementById('plan-summary-play');
    if (summaryPlayBtn) { summaryPlayBtn.onclick = () => vscode.postMessage({ type: 'play' }); }
    var resultBannerReview = document.getElementById('result-banner-review');
    if (resultBannerReview) { resultBannerReview.onclick = () => vscode.postMessage({ type: 'review-changes' }); }
    var resultBannerRetry = document.getElementById('result-banner-retry');
    if (resultBannerRetry) { resultBannerRetry.onclick = () => vscode.postMessage({ type: 'retry-failed' }); }
    var resultBannerExport = document.getElementById('result-banner-export');
    if (resultBannerExport) { resultBannerExport.onclick = () => vscode.postMessage({ type: 'export-results' }); }

    // ─── State Machine ───
    function setDashboardState(newState) {
      if (newState !== 'idle' && newState !== 'executing' && newState !== 'complete') {
        newState = 'idle';
      }
      dashboardState = newState;
      document.body.dataset.dashboardState = newState;

      var progressSection = document.getElementById('progress-section');
      var activeTask = document.getElementById('active-task');
      var planSummary = document.getElementById('plan-summary');
      var noPlanMessage = document.getElementById('no-plan-message');
      var resultBanner = document.getElementById('result-banner');
      var completedSection = document.getElementById('completed-section');
      var errorBanner = document.getElementById('error-banner');
      var sandboxSection = document.getElementById('sandbox-section');
      var hasResults = !!(resultBanner && resultBanner.dataset.hasResults === 'true');
      var hasPlan = hasPlanLoaded();

      // Hide all dashboard sections first.
      if (progressSection) { progressSection.hidden = true; }
      if (activeTask) {
        activeTask.hidden = true;
        activeTask.classList.remove('visible');
      }
      if (planSummary) { planSummary.hidden = true; }
      if (noPlanMessage) { noPlanMessage.hidden = true; }
      if (resultBanner) { resultBanner.hidden = true; }
      if (completedSection) { completedSection.hidden = true; }
      if (errorBanner) { errorBanner.hidden = true; }
      if (sandboxSection) { sandboxSection.hidden = true; }

      if (newState === 'executing') {
        if (progressSection) { progressSection.hidden = false; }
        if (activeTask) {
          activeTask.hidden = false;
          activeTask.classList.add('visible');
        }
        return;
      }

      if (progressSection) { progressSection.hidden = false; }

      if (newState === 'complete') {
        if (completedSection) { completedSection.hidden = false; }
        if (hasResults && resultBanner) { resultBanner.hidden = false; }
        if (errorBanner && errorBanner.textContent && errorBanner.textContent.trim()) {
          errorBanner.hidden = false;
        }
        return;
      }

      if (hasPlan) {
        if (planSummary) { planSummary.hidden = false; }
      } else {
        if (noPlanMessage) { noPlanMessage.hidden = false; }
      }
      if (hasResults && resultBanner) {
        resultBanner.hidden = false;
      }
      if (errorBanner && errorBanner.textContent && errorBanner.textContent.trim()) {
        errorBanner.hidden = false;
      }
    }

    // ─── Utilities ───
    function getPlanTasks(plan) {
      return plan && plan.playlists ? plan.playlists.flatMap(function(pl) { return pl.tasks || []; }) : [];
    }

    function getTaskStats(tasks) {
      return tasks.reduce(function(stats, task) {
        switch (task.status) {
          case 'completed': stats.completed++; break;
          case 'failed': stats.failed++; break;
          case 'blocked': stats.blocked++; break;
          case 'running': stats.running++; break;
          case 'skipped': stats.skipped++; break;
          default: stats.pending++; break;
        }
        return stats;
      }, { total: tasks.length, pending: 0, running: 0, completed: 0, failed: 0, blocked: 0, skipped: 0 });
    }

    function getPlanStats(plan) { return getTaskStats(getPlanTasks(plan)); }
    function hasPlanLoaded() { return !!(currentPlan && currentPlan.playlists && currentPlan.playlists.length > 0); }
    function hasTaskResults(stats) { return (stats.completed + stats.failed + stats.blocked + stats.skipped) > 0; }

    function findRunningOrNextTask(plan) {
      if (!plan || !Array.isArray(plan.playlists)) {
        return null;
      }
      for (var i = 0; i < plan.playlists.length; i++) {
        var runningPlaylist = plan.playlists[i];
        var runningTasks = Array.isArray(runningPlaylist.tasks) ? runningPlaylist.tasks : [];
        for (var ri = 0; ri < runningTasks.length; ri++) {
          var rt = runningTasks[ri];
          if (String(rt && rt.status || '').toLowerCase() === 'running') {
            return {
              phase: 'running',
              playlistName: runningPlaylist.name || ('Playlist ' + (i + 1)),
              task: rt,
              playlist: runningPlaylist,
            };
          }
        }
      }

      for (var j = 0; j < plan.playlists.length; j++) {
        var pendingPlaylist = plan.playlists[j];
        var pendingTasks = Array.isArray(pendingPlaylist.tasks) ? pendingPlaylist.tasks : [];
        for (var pi = 0; pi < pendingTasks.length; pi++) {
          var pt = pendingTasks[pi];
          var s = String(pt && pt.status || '').toLowerCase();
          if (!s || s === 'pending' || s === 'queued' || s === 'todo') {
            return {
              phase: 'queued',
              playlistName: pendingPlaylist.name || ('Playlist ' + (j + 1)),
              task: pt,
              playlist: pendingPlaylist,
            };
          }
        }
      }
      return null;
    }

    function autoResizePromptInput() {
      if (!promptInputEl) { return; }
      promptInputEl.style.height = 'auto';
      const minHeight = 118;
      const maxHeight = 240;
      promptInputEl.style.height = Math.min(Math.max(promptInputEl.scrollHeight, minHeight), maxHeight) + 'px';
    }

    function updatePromptCharCount() {
      if (!promptInputEl || !promptCharCountEl) { return; }
      promptCharCountEl.textContent = promptInputEl.value.length + ' chars | Ctrl+Enter';
    }

    function syncPromptEngineOptions(engines, preferredId) {
      if (!promptEngineEl) {
        promptEngines = Array.isArray(engines) ? engines : [];
        renderEngineStatus();
        return;
      }
      promptEngines = Array.isArray(engines) ? engines : [];
      const currentValue = selectedPromptEngineId || promptEngineEl.value;
      const preferredValue = typeof preferredId === 'string' ? preferredId : '';
      const resolvedValue = promptEngines.some(function(engine) { return engine.id === currentValue; })
        ? currentValue
        : (promptEngines.some(function(engine) { return engine.id === preferredValue; })
          ? preferredValue
          : (promptEngines[0] ? promptEngines[0].id : ''));

      promptEngineEl.textContent = '';

      if (promptEngines.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No engines detected';
        promptEngineEl.appendChild(option);
        selectedPromptEngineId = '';
      } else {
        promptEngines.forEach(function(engine) {
          const option = document.createElement('option');
          option.value = engine.id;
          option.textContent = engine.label;
          promptEngineEl.appendChild(option);
        });
        selectedPromptEngineId = resolvedValue;
        promptEngineEl.value = resolvedValue;
      }

      renderPromptComposerState();
      renderEngineStatus();
    }

    function renderEngineStatus() {
      var el = document.getElementById('engine-status');
      if (!el) { return; }
      if (!promptEngines || promptEngines.length === 0) {
        el.innerHTML = '<span style="color:var(--dimmed)">No supported engines detected.</span>';
        return;
      }
      var selected = promptEngines.find(function(engine) { return engine.id === selectedPromptEngineId; }) || promptEngines[0];
      var otherEngines = promptEngines.filter(function(engine) { return engine.id !== selected.id; }).map(function(engine) { return engine.label; });
      var extra = otherEngines.length > 0 ? ' <span style="color:var(--dimmed)">(also available: ' + escHtml(otherEngines.join(', ')) + ')</span>' : '';
      el.innerHTML = '<span>Engine: <strong>' + escHtml(selected.label) + '</strong></span>' + extra;
    }

    function submitPromptFromComposer() {
      if (!promptInputEl || !promptSubmitEl) { return; }
      const prompt = promptInputEl.value.trim();
      if (!prompt || promptSubmitEl.disabled) {
        return;
      }

      promptBusy = true;
      composerBusyAction = 'run';
      renderPromptComposerState();
      vscode.postMessage({
        type: 'submit-prompt',
        prompt: prompt,
        engineId: selectedPromptEngineId || undefined,
      });
    }

    function generatePlanFromComposer() {
      if (!promptInputEl || !promptGeneratePlanEl) { return; }
      const prompt = promptInputEl.value.trim();
      if (!prompt || promptGeneratePlanEl.disabled) {
        return;
      }

      promptBusy = true;
      composerBusyAction = 'plan';
      renderPromptComposerState();
      vscode.postMessage({
        type: 'generate-plan',
        prompt: prompt,
      });
    }

    function clearPromptComposer() {
      if (!promptInputEl) { return; }
      promptInputEl.value = '';
      autoResizePromptInput();
      updatePromptCharCount();
      renderPromptComposerState();
      if (runnerState === 'idle' && promptEngines.length > 0) {
        promptInputEl.focus();
      }
    }

    function renderPromptComposerState() {
      if (
        !promptComposerEl ||
        !promptInputEl ||
        !promptEngineEl ||
        !promptSubmitEl ||
        !promptGeneratePlanEl ||
        !promptAddTaskEl ||
        !promptAddPlaylistEl ||
        !promptContextPillEl ||
        !promptContextNoteEl
      ) {
        return;
      }
      const hasEngines = promptEngines.length > 0;
      const isIdle = runnerState === 'idle';
      const hasPrompt = !!promptInputEl.value.trim();
      const canType = isIdle && !promptBusy;
      const canRunPrompt = canType && hasEngines && hasPrompt;
      const canGeneratePlan = canType && hasPrompt;
      const canManagePlan = canType && hasPlanLoaded();

      promptComposerEl.classList.toggle('compact', !isIdle);
      promptInputEl.disabled = !canType;
      promptEngineEl.disabled = !canType || !hasEngines;
      promptSubmitEl.disabled = !canRunPrompt;
      promptGeneratePlanEl.disabled = !canGeneratePlan;
      promptAddTaskEl.disabled = !canManagePlan;
      promptAddPlaylistEl.disabled = !canManagePlan;
      promptSubmitEl.textContent = composerBusyAction === 'run' ? 'Running...' : 'Run Prompt';
      promptGeneratePlanEl.innerHTML = composerBusyAction === 'plan' ? '&#128393; Generating...' : '&#128393; Generate Plan';
      promptContextPillEl.textContent = hasPlanLoaded() ? 'Current plan' : 'One-off run';

      if (!hasEngines) {
        promptContextNoteEl.textContent = 'No engines detected. Plan generation still works, but running a prompt needs an installed engine.';
      } else if (!isIdle) {
        promptContextNoteEl.textContent = 'Runner is active. Stop the current run to submit another prompt.';
      } else if (hasPlanLoaded()) {
        promptContextNoteEl.textContent = 'Run the prompt, generate a plan from this chat, or add tasks and playlists to the current plan.';
      } else {
        promptContextNoteEl.textContent = 'No plan loaded. You can still run a one-off prompt or generate a plan from this chat.';
      }
    }

    // ─── Result Banner ───
    function renderResultBanner() {
      const banner = document.getElementById('result-banner');
      const title = document.getElementById('result-banner-title');
      const meta = document.getElementById('result-banner-meta');
      const retryBtn = document.getElementById('result-banner-retry');
      if (!banner || !title || !meta || !retryBtn) { return; }
      if (!currentPlan) {
        banner.dataset.hasResults = 'false';
        title.textContent = '';
        meta.textContent = '';
        retryBtn.disabled = true;
        setDashboardState(dashboardState);
        return;
      }
      const stats = getPlanStats(currentPlan);
      const failures = stats.failed + stats.blocked;
      const hasResults = hasTaskResults(stats);
      if (!hasResults) {
        banner.dataset.hasResults = 'false';
        title.textContent = '';
        meta.textContent = '';
        retryBtn.disabled = true;
        setDashboardState(dashboardState);
        return;
      }
      banner.dataset.hasResults = 'true';
      banner.className = 'result-banner' + (failures > 0 ? ' result-warning' : '');
      if (failures > 0) {
        title.textContent = stats.completed + ' passed, ' + failures + ' failed \u2014 ' +
          totalFilesChanged + ' file' + (totalFilesChanged !== 1 ? 's' : '') + ' changed';
        meta.textContent = runStartTime ? 'Run time: ' + formatDuration(Date.now() - runStartTime) : '';
      } else {
        title.textContent = 'All ' + stats.completed + ' tasks completed \u2014 ' +
          totalFilesChanged + ' file' + (totalFilesChanged !== 1 ? 's' : '') + ' changed';
        meta.textContent = runStartTime ? 'Run time: ' + formatDuration(Date.now() - runStartTime) : '';
      }
      retryBtn.disabled = failures === 0;
      setDashboardState(dashboardState);
    }

    function renderIdleOverview(plan) {
      var summaryEl = document.getElementById('plan-summary');
      var noPlanEl = document.getElementById('no-plan-message');
      var nameEl = document.getElementById('plan-summary-name');
      var descEl = document.getElementById('plan-summary-desc');
      var playlistsEl = document.getElementById('plan-summary-playlists');
      var totalEl = document.getElementById('plan-summary-total');
      var playBtn = document.getElementById('plan-summary-play');
      if (!summaryEl || !noPlanEl || !nameEl || !descEl || !playlistsEl || !totalEl || !playBtn) { return; }

      if (!plan || !Array.isArray(plan.playlists) || plan.playlists.length === 0) {
        summaryEl.hidden = true;
        noPlanEl.hidden = false;
        return;
      }

      summaryEl.hidden = false;
      noPlanEl.hidden = true;

      nameEl.textContent = plan.name || 'Untitled Plan';
      var description = typeof plan.description === 'string' ? plan.description.trim() : '';
      if (description) {
        descEl.hidden = false;
        descEl.textContent = description;
      } else {
        descEl.hidden = true;
        descEl.textContent = '';
      }

      var totalTasksInPlan = 0;
      playlistsEl.innerHTML = plan.playlists.map(function(pl, idx) {
        var tasks = Array.isArray(pl.tasks) ? pl.tasks : [];
        totalTasksInPlan += tasks.length;
        var done = tasks.filter(function(t) {
          var status = String(t && t.status || '').toLowerCase();
          return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'skipped';
        }).length;
        var playlistName = escHtml(pl.name || ('Playlist ' + (idx + 1)));
        return '<div class="plan-summary-pl"><span>' + playlistName + '</span><span>' + done + '/' + tasks.length + ' done</span></div>';
      }).join('');
      totalEl.textContent = totalTasksInPlan + ' tasks across ' + plan.playlists.length + ' playlists';
      playBtn.disabled = runnerState === 'playing';
    }

    // ─── Message Handler ───
    window.addEventListener('message', function(event) {
      const msg = event.data;
      switch (msg.type) {
        case 'update': {
          try {
            var incomingPlan = msg.plan || null;
            if (incomingPlan) {
              currentPlan = incomingPlan;
            }
            var planForRender = currentPlan;
            var planPlaylists = (planForRender && planForRender.playlists) ? planForRender.playlists : [];
            var newHash = planForRender
              ? planForRender.name + '|' + planPlaylists.map(function(pl) {
                return [pl.name||'', pl.engine||'', pl.parallel?'parallel':'sequential',
                  (pl.tasks||[]).map(function(t) { return [t.id||'',t.name||'',t.status||'pending'].join(':'); }).join(',')
                ].join('|');
              }).join('||') : '';
            var shouldRenderPlan = newHash !== lastPlanHash;
            currentServices = msg.services || [];
            syncPromptEngineOptions(msg.promptEngines || [], msg.selectedPromptEngineId);
            if (shouldRenderPlan) {
              lastPlanHash = newHash;
              renderPlan(planForRender);
            }
            renderPlaylistTiles(planForRender);
            renderPills(planForRender);
            syncActiveTaskFromPlan(planForRender);
            updateProgress();
            renderStatus(msg.runnerState);
          } catch(e) {
            console.error('[MOAG Dashboard] Update error:', e);
            const incomingPlan = msg.plan || null;
            if (incomingPlan) {
              currentPlan = incomingPlan;
            }
            currentServices = msg.services || [];
            syncPromptEngineOptions(msg.promptEngines || [], msg.selectedPromptEngineId);
            renderPlan(currentPlan);
            renderPlaylistTiles(currentPlan);
            renderPills(currentPlan);
            syncActiveTaskFromPlan(currentPlan);
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
          if (targetId) { appendOutput(targetId, msg.text, msg.stream); }
          break;
        }
        case 'complete-task-card':
          completeTask(msg);
          break;
        case 'composer-action-state':
          promptBusy = !!msg.busy;
          composerBusyAction = msg.busy ? (typeof msg.action === 'string' ? msg.action : '') : '';
          renderPromptComposerState();
          break;
        case 'composer-action-success':
          promptBusy = false;
          composerBusyAction = '';
          if (msg.action === 'run' || msg.action === 'plan') {
            clearPromptComposer();
          }
          break;
        case 'engine-fallback': {
          const targetId = currentTaskId;
          if (targetId) {
            const fallbackText = '[MOAG] Switching from ' + msg.fromEngine + ' to ' + msg.toEngine + ' due to rate limit';
            const st = cardState[targetId];
            if (st) { st.output += '\\n' + fallbackText + '\\n'; }
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
        case 'sandbox-state':
          renderSandboxPanel(msg.sandboxState);
          break;
        case 'sandbox-output': {
          var sbOut = document.getElementById('sandbox-output');
          var sbWrap = document.getElementById('sandbox-output-wrap');
          if (sbOut && sbWrap) {
            sbWrap.hidden = false;
            sbOut.textContent = (sbOut.textContent + msg.text).slice(-2000);
            sbOut.scrollTop = sbOut.scrollHeight;
          }
          break;
        }
      }
      // Also handle sandboxState in update messages
      if (msg.type === 'update' && msg.sandboxState) {
        renderSandboxPanel(msg.sandboxState);
      }
    });

    // ─── Sandbox Panel ───

    function renderSandboxPanel(state) {
      if (!state) { return; }
      var dot = document.getElementById('sandbox-dot');
      var label = document.getElementById('sandbox-status-label');
      var badge = document.getElementById('sandbox-status-badge');
      var framework = document.getElementById('sandbox-framework');
      var urlEl = document.getElementById('sandbox-url');
      var btnLaunch = document.getElementById('sandbox-btn-launch');
      var btnStop = document.getElementById('sandbox-btn-stop');
      var screenshotWrap = document.getElementById('sandbox-screenshot-wrap');
      var screenshotImg = document.getElementById('sandbox-screenshot-img');

      if (!dot) { return; }

      // Status dot
      dot.className = 'sandbox-status-dot ' + (state.status || 'stopped');

      // Status label
      var labelMap = { stopped: 'Stopped', starting: 'Starting...', running: 'Running', error: 'Error' };
      label.textContent = state.error || labelMap[state.status] || state.status;
      badge.textContent = state.status === 'running' ? '●' : '';

      // Framework label
      if (state.projectInfo) {
        framework.textContent = state.projectInfo.framework || '';
      }

      // URL link
      if (state.url) {
        urlEl.textContent = state.url;
        urlEl.dataset.url = state.url;
        urlEl.hidden = false;
        urlEl.title = 'Open in VS Code Simple Browser: ' + state.url;
      } else {
        urlEl.hidden = true;
      }

      // Buttons
      var running = state.status === 'running' || state.status === 'starting';
      btnLaunch.hidden = running;
      btnStop.hidden = !running;

      // Screenshot
      if (state.lastScreenshotPath) {
        screenshotImg.src = state.lastScreenshotPath;
        screenshotImg.alt = 'Last screenshot';
        screenshotWrap.hidden = false;
      } else {
        screenshotWrap.hidden = true;
      }
    }

    // ─── Execution Logic ───

    function resetExecution() {
      Object.keys(cardState).forEach(function(k) { delete cardState[k]; });
      Object.keys(taskStartTimes).forEach(function(k) { delete taskStartTimes[k]; });
      currentTaskId = null;
      completedOrder = [];
      completedTasks = [];
      Object.keys(completedExpandedState).forEach(function(k) { delete completedExpandedState[k]; });
      showAllCompletedCards = false;
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
      renderCompletedCards();
      updateProgress();
      renderResultBanner();
      updateStatusSummary('Ready');
      updateStatusRight('');
      setDashboardState('idle');
    }

    function getActiveRuntimeLabel(task) {
      if (task.engine) { return task.engine; }
      if (task.taskType && task.taskType !== 'agent') { return task.taskType; }
      return 'agent';
    }

    function getExecutionEtaText(effectiveCompleted) {
      if (!runStartTime || totalTasks === 0) { return ''; }
      const processedTasks = effectiveCompleted > 0 ? effectiveCompleted : (currentTaskId ? 1 : 0);
      if (processedTasks === 0) { return 'ETA --'; }
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

    function updateStatusSummary(text) {
      var el = document.getElementById('status-summary');
      if (el) { el.textContent = text || 'Ready'; }
    }
    function updateStatusRight(text) {
      var el = document.getElementById('status-right');
      if (el) { el.textContent = text || ''; }
    }

    function clearActiveOutputPlaceholder() {
      const hint = document.querySelector('#active-output .active-output-empty');
      if (hint) { hint.remove(); }
    }

    function startTask(msg) {
      if (!runStartTime) { runStartTime = Date.now(); startTimer(); }
      taskStartTime = Date.now();
      taskStartTimes[msg.taskId] = Date.now();
      currentTaskId = msg.taskId;
      cardState[msg.taskId] = {
        output: '', engine: msg.engine || '', taskType: msg.taskType || 'agent',
        command: msg.command || '', playlistName: msg.playlistName || '',
        durationMs: 0, exitCode: null, status: 'running',
        changedFiles: null, codeChanges: null, verification: null, artifacts: null, validationTargetResults: null, summary: '',
      };
      document.getElementById('active-task-name').textContent = msg.taskName;
      const engineEl = document.getElementById('active-engine');
      engineEl.textContent = getActiveRuntimeLabel(msg);
      engineEl.className = 'engine-badge engine-' + (msg.engine || 'custom');
      document.getElementById('active-timer').textContent = '0s';
      showActiveOutputPlaceholder('Waiting for terminal output...');
      updateStatusSummary('Running: ' + msg.taskName);
      setDashboardState('executing');
    }

    function syncActiveTaskFromPlan(plan) {
      if (runnerState !== 'playing') {
        return;
      }
      if (currentTaskId && cardState[currentTaskId]) {
        return;
      }
      const candidate = findRunningOrNextTask(plan);
      if (!candidate || !candidate.task) {
        updateStatusSummary('Running: preparing next task...');
        return;
      }

      const taskName = candidate.task.name || 'Untitled task';
      const playlistName = candidate.playlistName || 'Playlist';

      document.getElementById('active-task-name').textContent = taskName;

      const engineEl = document.getElementById('active-engine');
      const engineId = candidate.task.engine || (candidate.playlist && candidate.playlist.engine) || 'custom';
      engineEl.textContent = candidate.phase === 'queued'
        ? ('QUEUED - ' + getActiveRuntimeLabel(candidate.task))
        : getActiveRuntimeLabel(candidate.task);
      engineEl.className = 'engine-badge engine-' + engineId;
      document.getElementById('active-timer').textContent = candidate.phase === 'queued' ? '--' : '0s';

      if (candidate.phase === 'queued') {
        showActiveOutputPlaceholder('Task is queued. Runner will start it next.');
      } else {
        showActiveOutputPlaceholder('Waiting for terminal output...');
      }

      updateStatusSummary('Running: ' + taskName);
      setDashboardState('executing');
    }

    function appendOutput(taskId, text, stream) {
      const state = cardState[taskId];
      if (state) {
        state.output += text;
        if (state.output.length > 50000) { state.output = '... (truncated) ...\\n' + state.output.slice(-40000); }
      }
      if (taskId === currentTaskId) {
        const outputEl = document.getElementById('active-output');
        clearActiveOutputPlaceholder();
        outputEl.appendChild(document.createTextNode(text));
        while (outputEl.childNodes.length > 500) { outputEl.removeChild(outputEl.firstChild); }
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
        state.validationTargetResults = msg.validationTargetResults || null;
      }
      const passed = msg.status === 'completed';
      const blocked = msg.status === 'blocked';
      const failed = !passed && !blocked && msg.status !== 'skipped';
      completedCount++;
      if (failed) { failedCount++; }
      if (blocked) { blockedCount++; }
      if (msg.changedFiles) { totalFilesChanged += msg.changedFiles.length; }
      completedOrder.push(msg.taskId);
      addCompletedCard(msg.taskId, msg.taskName, msg);
      if (msg.taskId === currentTaskId) { currentTaskId = null; }
      updateProgress();
      renderResultBanner();
      renderPlaylistTiles(currentPlan);
      if (runnerState === 'playing') {
        setDashboardState('executing');
      } else if (runnerState === 'idle' && completedCount > 0 && completedCount >= totalTasks) {
        setDashboardState('complete');
      } else if (runnerState === 'idle' && currentPlan) {
        setDashboardState('idle');
      }
    }

    function addCompletedCard(taskId, taskName, msg) {
      var state = cardState[taskId] || {};
      var failed = msg.status === 'failed' || msg.status === 'blocked';
      if (typeof completedExpandedState[taskId] !== 'boolean') {
        completedExpandedState[taskId] = failed;
      }
      completedTasks.push({
        taskId: taskId,
        taskName: taskName,
        status: msg.status,
        engine: state.engine || '',
        durationMs: msg.durationMs || 0,
        filesCount: Array.isArray(msg.changedFiles) ? msg.changedFiles.length : 0,
        stderr: msg.stderr || '',
        output: state.output || msg.stdoutTail || '',
      });
      renderCompletedCards();
    }

    function firstNonEmptyLine(text) {
      if (!text) { return ''; }
      var lines = String(text).split('\\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line) { return line; }
      }
      return '';
    }

    function getOutputTail(output, limit) {
      if (!output) { return '(no output captured)'; }
      var lines = String(output).split('\\n');
      return lines.length > limit ? lines.slice(-limit).join('\\n') : lines.join('\\n');
    }

    function renderCompletedCards() {
      var section = document.getElementById('completed-section');
      if (!section) { return; }
      section.innerHTML = '';
      if (completedTasks.length === 0) { return; }

      var headerWrap = document.createElement('div');
      headerWrap.className = 'completed-section-header';
      var header = document.createElement('button');
      header.className = 'section-toggle' + (collapsedSections.completed ? ' collapsed' : '');
      header.dataset.section = 'completed';
      header.onclick = function() { toggleSection('completed'); };
      header.innerHTML = '<span class="section-toggle-icon">\\u25BC</span>' +
        '<span class="section-toggle-label">Completed Tasks</span>' +
        '<span class="section-toggle-count" id="completed-count">' + completedTasks.length + '</span>';
      var showAllBtn = document.createElement('button');
      showAllBtn.className = 'completed-show-all';
      showAllBtn.hidden = completedTasks.length <= 10;
      showAllBtn.textContent = showAllCompletedCards ? 'Show less' : ('Show all (' + completedTasks.length + ')');
      showAllBtn.onclick = function() {
        showAllCompletedCards = !showAllCompletedCards;
        renderCompletedCards();
      };
      headerWrap.appendChild(header);
      headerWrap.appendChild(showAllBtn);
      section.appendChild(headerWrap);

      var body = document.createElement('div');
      body.id = 'body-completed';
      body.className = 'section-body' + (collapsedSections.completed ? ' collapsed' : '');
      section.appendChild(body);

      var visibleCards = showAllCompletedCards ? completedTasks : completedTasks.slice(-10);
      visibleCards.forEach(function(entry) {
        var passed = entry.status === 'completed';
        var skipped = entry.status === 'skipped';
        var failed = entry.status === 'failed' || entry.status === 'blocked';
        var card = document.createElement('div');
        card.className = 'completed-task' + (failed ? ' failed-task' : '') +
          (completedExpandedState[entry.taskId] ? ' expanded' : '');
        card.dataset.taskId = entry.taskId;

        var row = document.createElement('div');
        row.className = 'completed-task-row';
        row.innerHTML =
          '<span class="ct-icon ' + (passed ? 'pass' : skipped ? 'skip' : 'fail') + '">' +
          (passed ? '\\u2713' : skipped ? '\\u2212' : '\\u2717') +
          '</span>' +
          '<span class="ct-name">' + escHtml(entry.taskName) + '</span>' +
          '<span class="ct-stats">' +
          (entry.engine ? '<span class="engine-badge engine-' + escHtml(String(entry.engine).toLowerCase()) + '">' + escHtml(entry.engine) + '</span>' : '') +
          '<span>' + formatDuration(entry.durationMs) + '</span>' +
          '<span>' + entry.filesCount + ' file' + (entry.filesCount !== 1 ? 's' : '') + '</span>' +
          '</span>';
        row.onclick = function() {
          completedExpandedState[entry.taskId] = !completedExpandedState[entry.taskId];
          card.classList.toggle('expanded', completedExpandedState[entry.taskId]);
        };
        card.appendChild(row);

        if (failed) {
          var errLine = document.createElement('div');
          errLine.className = 'ct-error-line';
          var firstErrLine = firstNonEmptyLine(entry.stderr);
          errLine.textContent = firstErrLine || 'Task failed without stderr output';
          errLine.title = entry.stderr || '';
          card.appendChild(errLine);
        }

        var detail = document.createElement('div');
        detail.className = 'ct-detail';
        var outputDiv = document.createElement('pre');
        outputDiv.className = 'terminal-output ct-detail-output';
        outputDiv.textContent = getOutputTail(entry.output || entry.stderr, 50);
        detail.appendChild(outputDiv);
        card.appendChild(detail);
        body.appendChild(card);
      });
    }

    // ─── Progress + Stats ───

    function renderPills(plan) {
      var minimap = document.getElementById('minimap');
      if (!minimap || !plan || !plan.playlists) { if (minimap) minimap.innerHTML = ''; return; }
      var html = '';
      var count = 0;
      plan.playlists.forEach(function(pl) {
        pl.tasks.forEach(function(task) {
          count++;
          var isCurrent = task.id === currentTaskId || task.status === 'running';
          var status = isCurrent ? 'running' : (task.status || 'pending');
          html += '<div class="dot ' + status + '" data-task-id="' + task.id + '" title="' + count + '. ' + escHtml(task.name) + '"></div>';
        });
      });
      totalTasks = count;
      minimap.innerHTML = html;
      updateProgress();
    }

    function updateProgress() {
      const fill = document.getElementById('progress-fill');
      const tasks = currentPlan ? currentPlan.playlists.flatMap(function(pl) { return pl.tasks || []; }) : [];
      const passedTasks = tasks.filter(function(t) { return t.status === 'completed'; }).length;
      const failedTasks = tasks.filter(function(t) { return t.status === 'failed'; }).length;
      const blockedTasks = tasks.filter(function(t) { return t.status === 'blocked'; }).length;
      const effectiveCompleted = Math.max(completedCount, passedTasks + failedTasks + blockedTasks +
        tasks.filter(function(t) { return t.status === 'skipped'; }).length);
      const effectiveFailed = Math.max(failedCount, failedTasks);

      if (totalTasks === 0) {
        fill.style.width = '0%';
        fill.classList.remove('has-errors');
        document.getElementById('stats-tasks').textContent = '0/0';
        document.getElementById('stats-elapsed').textContent = '';
        return;
      }

      const pct = Math.round((effectiveCompleted / totalTasks) * 100);
      fill.style.width = pct + '%';

      if (effectiveFailed > 0) {
        const passPct = effectiveCompleted > 0
          ? Math.round(((effectiveCompleted - effectiveFailed) / effectiveCompleted) * 100)
          : 0;
        fill.classList.add('has-errors');
        fill.style.setProperty('--pass-pct', passPct + '%');
      } else {
        fill.classList.remove('has-errors');
      }

      const isExecuting = currentTaskId !== null;
      var failureCount = failedTasks + blockedTasks;
      if (isExecuting) {
        document.getElementById('stats-tasks').textContent = effectiveCompleted + '/' + totalTasks;
        document.getElementById('stats-elapsed').textContent = getExecutionEtaText(effectiveCompleted);
      } else {
        document.getElementById('stats-tasks').textContent = effectiveCompleted + '/' + totalTasks + ' tasks (' + failureCount + ' failed)';
        document.getElementById('stats-elapsed').textContent = runStartTime ? formatDuration(Date.now() - runStartTime) : '';
      }
    }

    function startTimer() { stopTimer(); elapsedInterval = setInterval(updateTimers, 1000); }
    function stopTimer() { if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; } }

    function updateTimers() {
      updateProgress();
      if (taskStartTime && currentTaskId) {
        document.getElementById('active-timer').textContent = formatDuration(Date.now() - taskStartTime);
      }
      if (runStartTime && (runnerState === 'playing' || runnerState === 'paused' || runnerState === 'stopping')) {
        updateStatusRight(formatDuration(Date.now() - runStartTime));
      } else {
        updateStatusRight('');
      }
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + 'ms';
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return secs + 's';
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      if (mins < 60) return mins + 'm ' + remSecs + 's';
      const hrs = Math.floor(mins / 60);
      return hrs + 'h ' + (mins % 60) + 'm';
    }

    // ─── Playlist Tiles ───

    function getPlaylistTileStatus(stats) {
      if (stats.running > 0) { return 'running'; }
      if ((stats.failed + stats.blocked) > 0) { return 'failed'; }
      if (stats.total > 0 && (stats.completed + stats.skipped) === stats.total) { return 'done'; }
      return 'pending';
    }

    function renderPlaylistTiles(plan) {
      const container = document.getElementById('playlist-tiles');
      if (!container) { return; }
      if (!plan || !plan.playlists || plan.playlists.length === 0) {
        container.hidden = true;
        container.innerHTML = '';
        return;
      }
      container.hidden = false;
      var activePlaylistName = currentTaskId && cardState[currentTaskId] ? cardState[currentTaskId].playlistName : null;

      container.innerHTML = plan.playlists.map(function(pl) {
        const tasks = pl.tasks || [];
        const stats = getTaskStats(tasks);
        const statusKey = getPlaylistTileStatus(stats);
        const doneCount = stats.completed + stats.failed + stats.blocked + stats.skipped;
        const fraction = doneCount + '/' + stats.total;
        const isActive = pl.name === activePlaylistName || stats.running > 0;
        const classes = ['playlist-tile'];
        if (isActive) { classes.push('is-active'); }
        if ((stats.failed + stats.blocked) > 0) { classes.push('has-failure'); }
        if (statusKey === 'done') { classes.push('is-done'); }
        return '<button class="' + classes.join(' ') + '" onclick="vscode.postMessage({type:\\x27switch-plan\\x27})" title="' + escHtml(pl.name || 'Playlist') + '">' +
          '<span class="tile-name">' + escHtml(pl.name || 'Playlist') + '</span>' +
          '<span class="tile-meta">' +
            '<span class="tile-status ' + statusKey + '">' + statusKey + '</span>' +
            '<span class="tile-fraction">' + fraction + '</span>' +
          '</span>' +
        '</button>';
      }).join('');
    }

    // ─── Render Functions ───

    function renderStatus(state) {
      runnerState = state;
      const el = document.getElementById('runner-status');
      el.textContent = state.charAt(0).toUpperCase() + state.slice(1);
      el.className = 'status-badge status-' + state;
      const playBtn = document.getElementById('btn-play');
      const pauseBtn = document.getElementById('btn-pause');
      const stopBtn = document.getElementById('btn-stop');
      playBtn.disabled = state === 'playing';
      pauseBtn.disabled = state !== 'playing';
      stopBtn.disabled = state === 'idle';
      playBtn.className = playBtn.disabled ? 'icon-btn' : 'icon-btn primary';
      renderResultBanner();
      renderPromptComposerState();
      if (state === 'playing') {
        syncActiveTaskFromPlan(currentPlan);
      }
      if (state === 'playing') {
        setDashboardState('executing');
      } else if (state === 'idle' && completedCount > 0 && completedCount >= totalTasks) {
        setDashboardState('complete');
      } else {
        setDashboardState('idle');
      }
      if (state === 'idle') {
        updateStatusSummary('Ready');
        updateStatusRight('');
        stopTimer();
      } else if (state === 'paused') {
        updateStatusSummary('Paused');
      } else if (state === 'stopping') {
        updateStatusSummary('Stopping...');
      }
      updateTimers();
    }

    const collapsedSections = { completed: false, sandbox: true };

    function toggleSection(sectionId) {
      collapsedSections[sectionId] = !collapsedSections[sectionId];
      const toggle = document.querySelector('[data-section="' + sectionId + '"]');
      const body = document.getElementById('body-' + sectionId);
      if (toggle && body) {
        toggle.classList.toggle('collapsed', !!collapsedSections[sectionId]);
        body.classList.toggle('collapsed', !!collapsedSections[sectionId]);
      }
    }

    // ─── Plan Tab: Tree View ───

    function renderPlan(plan) {
      const planName = document.getElementById('plan-name');
      if (!plan || !plan.playlists || plan.playlists.length === 0) {
        if (planName) { planName.textContent = plan && plan.name ? plan.name : 'MOAG'; }
        totalTasks = 0;
        renderPills(null);
        renderIdleOverview(null);
        renderPromptComposerState();
        setDashboardState(runnerState === 'playing' ? 'executing' : 'idle');
        return;
      }

      if (planName) { planName.textContent = plan.name || 'Untitled Plan'; }
      let taskCount = 0;
      plan.playlists.forEach(function(pl) { taskCount += (pl.tasks || []).length; });
      totalTasks = taskCount;
      renderIdleOverview(plan);
      setDashboardState(runnerState === 'playing' ? 'executing' : dashboardState);
      renderPromptComposerState();
    }

    // ─── Utilities ───

    function escHtml(s) {
      const div = document.createElement('div');
      div.textContent = s || '';
      return div.innerHTML;
    }

    // ─── Init ───

    (function() {
      try {
        console.log('[MOAG] Init: decoding base64');
        var rawState = decodeBase64Utf8('${initialStateBase64}');
        var initState = JSON.parse(rawState);
        console.log('[MOAG] Init: plan=' + (initState.plan ? initState.plan.name : 'null'));
        syncPromptEngineOptions(initState.promptEngines || [], initState.selectedPromptEngineId);
        autoResizePromptInput();
        updatePromptCharCount();
        if (initState && initState.plan) {
          currentPlan = initState.plan;
          renderPlan(initState.plan);
          renderEngineStatus();
          renderPlaylistTiles(initState.plan);
          renderPills(initState.plan);
          updateProgress();
          renderStatus(initState.runnerState || 'idle');
        } else {
          currentPlan = null;
          renderPlan(null);
          renderEngineStatus();
          renderPlaylistTiles(null);
          renderPills(null);
          updateProgress();
          renderStatus('idle');
        }
      } catch(initErr) {
        console.error('[MOAG Dashboard] Init error:', initErr);
        currentPlan = null;
        syncPromptEngineOptions([], '');
        autoResizePromptInput();
        updatePromptCharCount();
        renderPlan(null);
        renderEngineStatus();
        renderPlaylistTiles(null);
        renderPills(null);
        updateProgress();
        renderStatus('idle');
      }
    })();

    function notifyWebviewReady() { vscode.postMessage({ type: 'webview-ready', htmlVersion: window.__moagHtmlVersion }); }

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
        var hasRenderedPlan = !!currentPlan;
        if ((currentPlan && hasRenderedPlan) || retries >= maxRetries) {
          clearInterval(interval);
          if (currentPlan && !hasRenderedPlan) { vscode.postMessage({ type: 'refresh' }); }
          return;
        }
        if (!currentPlan || !hasRenderedPlan) { vscode.postMessage({ type: 'refresh' }); }
      }, 500);
    })();

  </script>
</body>
</html>`;
  }
}
