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
const HTML_VERSION = '7';

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
      padding: 6px 12px;
      background: var(--sidebar-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-height: 48px;
      flex-wrap: wrap;
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
    .main-zone, .main-content {
      flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
      display: flex; flex-direction: column;
    }
    /* ─── Compact Chat Composer ─── */
    .prompt-composer {
      padding: 8px 10px 10px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--sidebar-bg);
    }
    .composer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .composer-action-btn {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(128,128,128,0.06);
      color: var(--dimmed);
      font-family: var(--vscode-font-family);
      font-size: 11px;
      cursor: pointer;
    }
    .composer-action-btn:hover:not(:disabled) { background: var(--hover-bg); color: var(--fg); }
    .composer-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .composer-input-wrap {
      position: relative;
      display: flex;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 8px;
      background: var(--vscode-input-background);
      overflow: hidden;
    }
    .composer-input-wrap:focus-within { border-color: var(--focus-border); }
    .prompt-textarea {
      flex: 1;
      min-height: 54px;
      max-height: 160px;
      resize: none;
      padding: 8px 10px;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      line-height: 1.5;
      outline: none;
      overflow-y: auto;
    }
    .prompt-textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .prompt-textarea:disabled { opacity: 0.6; cursor: not-allowed; }
    .composer-send-btn {
      align-self: flex-end;
      width: 30px;
      height: 30px;
      margin: 6px 6px 6px 0;
      border: none;
      border-radius: 6px;
      background: var(--button-bg);
      color: var(--button-fg);
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .composer-send-btn:hover:not(:disabled) { background: var(--button-hover); }
    .composer-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .prompt-select {
      height: 22px;
      padding: 0 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      font-family: var(--vscode-font-family);
      font-size: 11px;
      outline: none;
    }
    .prompt-select:disabled { opacity: 0.6; cursor: not-allowed; }
    .composer-context-pill {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: var(--dimmed);
      background: rgba(128,128,128,0.1);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 1px 7px;
      white-space: nowrap;
    }
    .composer-note { font-size: 10px; color: var(--dimmed); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .composer-chars { font-size: 10px; color: var(--dimmed); white-space: nowrap; flex-shrink: 0; }

    /* ─── State 1: Empty ─── */
    .state-empty { padding: 24px 12px; }
    .hero-input-wrap { margin-bottom: 20px; }
    .hero-input {
      width: 100%;
      padding: 12px 14px;
      font-size: 15px;
      font-family: var(--vscode-font-family);
      background: var(--bg);
      color: var(--fg);
      border: 2px solid var(--focus-border);
      border-radius: 6px;
      outline: none;
      box-sizing: border-box;
    }
    .hero-input:focus { border-color: var(--button-bg); }
    .hero-input::placeholder { color: var(--dimmed); }
    .secondary-actions { display: flex; flex-direction: column; gap: 8px; padding: 0 20px; }
    .or-divider { text-align: center; color: var(--dimmed); font-size: 13px; margin: 4px 0; }
    .action-btn {
      width: 100%; padding: 10px 16px; border: 1px solid var(--border); border-radius: 6px;
      font-size: 14px; cursor: pointer; text-align: center;
      background: transparent; color: var(--fg);
    }
    .action-btn:hover { background: var(--hover-bg); }
    .action-primary { border-color: var(--button-bg); background: rgba(0,122,204,0.08); }
    .action-secondary { border-color: var(--border); }
    .action-tertiary { border-color: var(--border); color: var(--dimmed); }
    .engine-status { padding: 16px 20px; font-size: 12px; color: var(--dimmed); }

    /* ─── Progress Section ─── */
    .run-intro {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 10px;
      min-height: 180px;
      margin: auto 16px;
      padding: 22px 20px;
      border: 1px dashed rgba(128,128,128,0.35);
      border-radius: 14px;
      background:
        radial-gradient(circle at top left, rgba(0,122,204,0.12), transparent 45%),
        linear-gradient(180deg, rgba(128,128,128,0.04), rgba(128,128,128,0.02)),
        var(--sidebar-bg);
    }
    .run-intro-title {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.2;
    }
    .run-intro-copy {
      font-size: 12px;
      color: var(--dimmed);
      line-height: 1.5;
      max-width: 520px;
    }

    .progress-section {
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .progress-track { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin-bottom: 4px; }
    .progress-fill { height: 100%; background: var(--success); border-radius: 2px; transition: width 0.4s ease; width: 0%; }
    .progress-fill.has-errors {
      background: linear-gradient(90deg, var(--success) 0%, var(--success) var(--pass-pct), var(--error) var(--pass-pct), var(--error) 100%);
    }
    .stats-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--dimmed); margin-bottom: 4px; }
    .minimap { display: flex; flex-wrap: wrap; gap: 2px; max-height: 22px; overflow: hidden; }
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

    /* ─── Active Task Card ─── */
    .active-task-card {
      display: none; flex-direction: column; flex-grow: 1;
      margin: 8px; border: 1px solid var(--focus-border);
      border-radius: 6px; overflow: hidden; min-height: 200px;
    }
    .active-task-card.visible { display: flex; }
    .active-task-header {
      display: flex; align-items: center; gap: 8px;
      min-height: 32px; padding: 0 10px;
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
    .active-task-context {
      max-width: 42%;
      font-size: 10px;
      color: var(--dimmed);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 0;
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
    .autofix-badge {
      display: inline-block; font-size: 9px; font-weight: 600;
      padding: 1px 6px; border-radius: 3px; margin-left: 6px;
      background: rgba(56,132,244,0.15); color: #3884f4; vertical-align: middle;
    }
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
      flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
      padding: 8px 10px; background: var(--terminal-bg); color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; white-space: pre-wrap; word-break: break-all; line-height: 1.5;
    }
    .active-output-empty { color: var(--dimmed); font-style: italic; }

    /* ─── Result Banner ─── */
    .result-banner {
      margin: 8px; padding: 10px 14px; border-radius: 6px;
      border-left: 3px solid var(--success); background: rgba(76,175,80,0.06); flex-shrink: 0;
    }
    .result-banner.result-warning { border-left-color: var(--error); background: rgba(244,71,71,0.06); }
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
    .completed-task { border-left: 2px solid transparent; margin: 0 8px 2px; border-radius: 3px; }
    .completed-task.failed-task { border-left-color: var(--error); }
    .completed-task-row {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 8px; cursor: pointer; border-radius: 3px;
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
    .ct-error-output {
      margin: 4px 8px 4px 32px; border: 1px solid rgba(244,71,71,0.3);
      border-radius: 3px; font-size: 10px;
    }
    .ct-error-output summary {
      padding: 3px 8px; cursor: pointer; font-weight: 600;
      color: var(--error); background: rgba(244,71,71,0.06);
    }
    .ct-error-output pre {
      padding: 6px 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
      font-family: var(--vscode-editor-font-family, monospace); max-height: 150px; overflow-y: auto;
    }
    .ct-detail { display: none; padding: 4px 8px 8px 32px; }
    .completed-task.expanded .ct-detail { display: block; }
    .ct-detail-output {
      font-size: 10px; padding: 4px 6px; border-radius: 3px;
      margin-bottom: 4px; max-height: 120px; overflow-y: auto;
    }
    .ct-detail-section { font-size: 11px; margin-top: 6px; }
    .ct-detail-section summary { cursor: pointer; font-weight: 600; padding: 2px 0; }
    .ct-detail-section ul { padding-left: 16px; margin-top: 4px; }
    .ct-detail-section li { margin: 2px 0; font-size: 10px; }

    /* ─── Diff Viewer ─── */
    .diff-section { margin-top: 8px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
    .diff-section summary { padding: 6px 10px; cursor: pointer; font-size: 11px; font-weight: 600; background: rgba(128,128,128,0.08); user-select: none; }
    .diff-section summary:hover { background: rgba(128,128,128,0.14); }
    .diff-view { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; overflow-x: auto; padding: 8px; margin: 0; white-space: pre; }
    .diff-add { background: rgba(78,201,176,0.15); color: inherit; }
    .diff-remove { background: rgba(244,71,71,0.15); color: inherit; }
    .diff-hunk { color: var(--dimmed); font-style: italic; }
    .diff-header { font-weight: 700; color: var(--fg); }
    .diff-file-summary { font-size: 10px; color: var(--dimmed); padding: 4px 10px; border-bottom: 1px solid var(--border); }
    .diff-actions { display: flex; gap: 6px; padding: 4px 10px; border-top: 1px solid var(--border); }
    .diff-actions button { font-size: 10px; padding: 2px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; cursor: pointer; }
    .diff-actions button:hover { opacity: 0.85; }

    /* ─── Plan Tab Tree View ─── */
    .plan-section { padding: 8px 0; flex: 1; }
    .plan-placeholder { padding: 20px 16px; color: var(--dimmed); font-size: 12px; text-align: center; }
    .playlist-block { margin-top: 2px; }
    .playlist-toggle { padding-left: 16px; }
    .playlist-toggle .section-toggle-label {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0;
      min-width: 0;
    }
    .playlist-name {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      min-width: 0; flex: 1;
    }
    .playlist-progress {
      font-size: 10px; color: var(--dimmed); flex-shrink: 0;
      padding-right: 8px;
    }
    .task-list { padding: 0; }
    .task-row {
      display: flex; align-items: center; gap: 8px;
      height: 24px; line-height: 24px; padding: 0 8px 0 36px;
      font-size: 11px;
    }
    .task-row:hover { background: var(--hover-bg); }
    .task-status-dot {
      width: 10px; height: 10px; border-radius: 50%;
      flex-shrink: 0; background: rgba(128,128,128,0.4);
    }
    .task-status-dot.completed { background: var(--success); }
    .task-status-dot.failed, .task-status-dot.blocked { background: var(--error); }
    .task-status-dot.running { background: var(--success); animation: dot-pulse 1s ease-in-out infinite; }
    .task-status-dot.skipped { background: rgba(128,128,128,0.2); }
    .task-name {
      flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .task-duration {
      font-size: 10px; color: var(--dimmed); flex-shrink: 0;
    }
    .task-runtime-badge {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      border-radius: 999px;
      padding: 1px 6px;
      flex-shrink: 0;
    }
    .task-runtime-badge.running {
      background: rgba(76,175,80,0.2);
      color: var(--success);
    }
    .task-runtime-badge.queued {
      background: rgba(0,122,204,0.2);
      color: var(--focus-border);
    }
    .task-edit-btn {
      height: 18px; min-width: 18px; padding: 0 4px;
      border: 1px solid transparent; border-radius: 3px;
      background: transparent; color: var(--dimmed); font-size: 10px;
      cursor: pointer; opacity: 0; transition: opacity 0.1s;
      flex-shrink: 0;
    }
    .task-row:hover .task-edit-btn { opacity: 1; }
    .task-edit-btn:hover { border-color: var(--border); color: var(--fg); background: var(--hover-bg); }
    .tree-add-btn {
      width: calc(100% - 36px); margin: 2px 8px 4px 28px;
      height: 22px; line-height: 20px; border: 1px dashed var(--border);
      border-radius: 4px; background: transparent; color: var(--dimmed);
      font-size: 11px; text-align: left; padding: 0 8px; cursor: pointer;
    }
    .tree-add-btn:hover { background: var(--hover-bg); color: var(--fg); }
    .tree-add-playlist-btn {
      width: calc(100% - 16px); margin: 6px 8px 0;
      height: 22px; line-height: 20px; border: 1px dashed var(--border);
      border-radius: 4px; background: transparent; color: var(--dimmed);
      font-size: 11px; text-align: left; padding: 0 8px; cursor: pointer;
    }
    .tree-add-playlist-btn:hover { background: var(--hover-bg); color: var(--fg); }

    /* ─── History Section ─── */
    .history-section { border-top: 1px solid var(--border); flex-shrink: 0; padding-top: 2px; }
    .history-entry {
      display: flex; align-items: center; gap: 8px; padding: 5px 12px;
      font-size: 11px; border-bottom: 1px solid rgba(128,128,128,0.06);
    }
    .history-entry:hover { background: var(--hover-bg); }
    .history-run-label { font-weight: 600; flex: 1; }
    .history-run-meta { color: var(--dimmed); font-size: 10px; }
    .history-run-status { font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 3px; }
    .history-run-status.pass { background: rgba(76,175,80,0.15); color: var(--success); }
    .history-run-status.fail { background: rgba(244,71,71,0.15); color: var(--error); }

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

  <!-- F. Progress Section (hidden until plan loaded) -->
  <div class="progress-section" id="progress-section" style="display:none;">
    <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
    <div class="stats-row">
      <span id="stats-tasks">0/0 tasks (0 failed)</span>
      <span id="stats-elapsed"></span>
    </div>
    <div class="minimap" id="minimap"></div>
  </div>

  <!-- ETA display -->
  <div class="eta-display" id="eta-display" style="display:none;"></div>

  <!-- Main scrollable zone -->
  <div class="main-zone" id="main-content">

    <!-- STATE 1: Empty state (no plan) -->
    <div class="state-empty" id="state-empty">
      <div class="hero-input-wrap">
        <input type="text" class="hero-input" id="hero-input" placeholder="What do you want to build?" />
      </div>
      <div class="secondary-actions">
        <span class="or-divider">or</span>
        <button class="action-btn action-primary" onclick="vscode.postMessage({type:'smart-plan'})">Smart Plan (auto-detect project)</button>
        <button class="action-btn action-secondary" onclick="vscode.postMessage({type:'new-plan-template'})">Browse 12 Templates</button>
        <button class="action-btn action-tertiary" onclick="vscode.postMessage({type:'open-plan'})">Open Plan File</button>
      </div>
      <div class="engine-status" id="engine-status"></div>
    </div>

    <!-- STATE 3: Active task panel (execution) -->
    <div class="active-task" id="active-task">
      <div class="active-task-header">
        <div class="active-dot"></div>
        <span class="active-task-name" id="active-task-name"></span>
        <span class="active-task-context" id="active-task-context"></span>
        <span class="engine-badge" id="active-engine"></span>
        <span class="active-timer" id="active-timer">0s</span>
      </div>
      <div class="terminal-output active-task-output" id="active-output"></div>
      <details class="active-task-details" id="active-details">
        <summary>Details</summary>
        <div id="active-contract-inline"></div>
        <pre id="active-prompt"></pre>
      </details>
    </div>

    <!-- STATE 4: Result banner -->
    <div class="result-banner" id="result-banner" style="display:none;"></div>

    <!-- STATE 4: Error banner -->
    <div class="error-banner" id="error-banner"></div>

    <!-- STATE 4: Completed cards -->
    <div class="completed-section" id="completed-section"></div>

    <!-- STATE 2+4: Tasks section -->
    <div class="plan-section" id="plan-section"></div>

    <!-- STATE 2+4: History section -->
    <div id="info-panel" style="display:none;"></div>

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
            <a class="sandbox-url" id="sandbox-url" style="display:none;"
               onclick="vscode.postMessage({type:'sandbox-open-browser',url:this.dataset.url})"
               title="Open in VS Code Simple Browser"></a>
          </div>
          <div class="sandbox-row" id="sandbox-action-row">
            <button class="sandbox-btn primary" id="sandbox-btn-launch"
                    onclick="vscode.postMessage({type:'sandbox-launch'})">Launch Sandbox</button>
            <button class="sandbox-btn" id="sandbox-btn-stop" style="display:none;"
                    onclick="vscode.postMessage({type:'sandbox-stop'})">Stop</button>
            <button class="sandbox-btn" id="sandbox-btn-screenshot"
                    onclick="vscode.postMessage({type:'sandbox-screenshot'})"
                    title="Capture screenshot and attach to next agent task">Screenshot</button>
          </div>
          <div id="sandbox-output-wrap" style="display:none;">
            <div class="sandbox-output" id="sandbox-output"></div>
          </div>
          <div id="sandbox-screenshot-wrap" style="display:none;">
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
    var dashboardState = 'empty'; // 'empty' | 'idle' | 'executing' | 'complete'
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
    var heroInput = document.getElementById('hero-input');
    if (heroInput) {
      heroInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && heroInput.value.trim()) {
          vscode.postMessage({ type: 'run-prompt', prompt: heroInput.value.trim() });
          heroInput.value = '';
        }
      });
    }
    document.getElementById('btn-play').onclick = () => vscode.postMessage({ type: 'play' });
    document.getElementById('btn-pause').onclick = () => vscode.postMessage({ type: 'pause' });
    document.getElementById('btn-stop').onclick = () => vscode.postMessage({ type: 'stop' });
    var resultBannerReview = document.getElementById('result-banner-review');
    if (resultBannerReview) { resultBannerReview.onclick = () => vscode.postMessage({ type: 'review-changes' }); }
    var resultBannerRetry = document.getElementById('result-banner-retry');
    if (resultBannerRetry) { resultBannerRetry.onclick = () => vscode.postMessage({ type: 'retry-failed' }); }
    var resultBannerExport = document.getElementById('result-banner-export');
    if (resultBannerExport) { resultBannerExport.onclick = () => vscode.postMessage({ type: 'export-results' }); }

    // ─── State Machine ───
    function setDashboardState(newState) {
      if (newState === dashboardState) return;
      dashboardState = newState;

      var stateEmpty = document.getElementById('state-empty');
      var progressSection = document.getElementById('progress-section');
      var activeTask = document.getElementById('active-task');
      var resultBanner = document.getElementById('result-banner');
      var completedSection = document.getElementById('completed-section');
      var planSection = document.getElementById('plan-section');
      var infoPanel = document.getElementById('info-panel');

      // Hide everything first
      stateEmpty.style.display = 'none';
      progressSection.style.display = 'none';
      activeTask.style.display = 'none';
      if (resultBanner) resultBanner.style.display = 'none';
      completedSection.style.display = 'none';
      planSection.style.display = 'none';
      infoPanel.style.display = 'none';
      document.body.classList.remove('task-active');

      switch (newState) {
        case 'empty':
          stateEmpty.style.display = '';
          break;
        case 'idle':
          progressSection.style.display = '';
          planSection.style.display = '';
          infoPanel.style.display = '';
          // Ensure tasks expanded
          if (collapsedSections['tasks']) toggleSection('tasks');
          break;
        case 'executing':
          progressSection.style.display = '';
          activeTask.style.display = 'flex';
          document.body.classList.add('task-active');
          break;
        case 'complete':
          progressSection.style.display = '';
          if (resultBanner) resultBanner.style.display = '';
          completedSection.style.display = '';
          planSection.style.display = '';
          infoPanel.style.display = '';
          break;
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

    function getNextTask(tasks) {
      return tasks.find(function(t) { return t.status === 'running'; })
        || tasks.find(function(t) { return !t.status || t.status === 'pending' || t.status === 'paused'; })
        || null;
    }

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

    function getExecutionPointers(plan) {
      if (!plan || !Array.isArray(plan.playlists)) {
        return { runningTaskId: null, queuedTaskId: null };
      }
      var linear = [];
      plan.playlists.forEach(function(pl) {
        (pl.tasks || []).forEach(function(t) { linear.push(t); });
      });
      if (linear.length === 0) {
        return { runningTaskId: null, queuedTaskId: null };
      }

      var runningIdx = -1;
      for (var i = 0; i < linear.length; i++) {
        if (String(linear[i].status || '').toLowerCase() === 'running') {
          runningIdx = i;
          break;
        }
      }

      var queuedIdx = -1;
      if (runningIdx >= 0) {
        for (var j = runningIdx + 1; j < linear.length; j++) {
          var s = String(linear[j].status || '').toLowerCase();
          if (!s || s === 'pending' || s === 'queued' || s === 'todo') {
            queuedIdx = j;
            break;
          }
        }
      } else {
        for (var k = 0; k < linear.length; k++) {
          var firstPending = String(linear[k].status || '').toLowerCase();
          if (!firstPending || firstPending === 'pending' || firstPending === 'queued' || firstPending === 'todo') {
            queuedIdx = k;
            break;
          }
        }
      }

      return {
        runningTaskId: runningIdx >= 0 ? linear[runningIdx].id : null,
        queuedTaskId: queuedIdx >= 0 ? linear[queuedIdx].id : null,
      };
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
      if (!currentPlan) { banner.hidden = true; return; }
      const stats = getPlanStats(currentPlan);
      const failures = stats.failed + stats.blocked;
      const hasResults = hasTaskResults(stats);
      if (!hasResults) { banner.hidden = true; return; }
      banner.hidden = false;
      banner.className = 'result-banner' + (failures > 0 ? ' result-warning' : '');
      if (failures > 0) {
        title.textContent = failures + ' task' + (failures !== 1 ? 's' : '') + ' failed';
        meta.textContent = stats.completed + ' passed \u00B7 ' + failures + ' failed' +
          (totalFilesChanged > 0 ? ' \u00B7 ' + totalFilesChanged + ' files changed' : '');
      } else {
        title.textContent = 'Run finished \u2013 ' + stats.completed + ' task' + (stats.completed !== 1 ? 's' : '') + ' completed';
        meta.textContent = (totalFilesChanged > 0 ? totalFilesChanged + ' files changed' : 'No files changed') +
          (runStartTime ? ' \u00B7 ' + formatDuration(Date.now() - runStartTime) : '');
      }
      retryBtn.disabled = failures === 0;
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
            var shouldRenderPlan = newHash !== lastPlanHash || !document.getElementById('plan-section').innerHTML.trim();
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
            renderHistory(msg.history || []);
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
            sbWrap.style.display = 'block';
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
        urlEl.style.display = 'inline';
        urlEl.title = 'Open in VS Code Simple Browser: ' + state.url;
      } else {
        urlEl.style.display = 'none';
      }

      // Buttons
      var running = state.status === 'running' || state.status === 'starting';
      btnLaunch.style.display = running ? 'none' : 'inline-block';
      btnStop.style.display = running ? 'inline-block' : 'none';

      // Screenshot
      if (state.lastScreenshotPath) {
        screenshotImg.src = state.lastScreenshotPath;
        screenshotImg.alt = 'Last screenshot';
        screenshotWrap.style.display = 'block';
      }
    }

    // ─── Execution Logic ───

    function resetExecution() {
      Object.keys(cardState).forEach(function(k) { delete cardState[k]; });
      Object.keys(taskStartTimes).forEach(function(k) { delete taskStartTimes[k]; });
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
      document.getElementById('active-task-context').textContent = '';
      document.getElementById('active-output').textContent = '';
      document.getElementById('active-engine').textContent = '';
      document.getElementById('active-engine').className = 'engine-badge engine-custom';
      document.getElementById('active-timer').textContent = '0s';
      document.getElementById('completed-section').innerHTML = '';
      document.getElementById('completed-section').hidden = true;
      const activeCard = document.getElementById('active-task');
      activeCard.hidden = true;
      activeCard.className = 'active-task-card';
      updateProgress();
      renderResultBanner();
      updateStatusSummary('Ready');
      if (!currentPlan || !currentPlan.playlists || currentPlan.playlists.length === 0) {
        setDashboardState('empty');
      } else {
        setDashboardState('idle');
      }
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
      document.getElementById('active-task-context').textContent = msg.playlistName || '';
      const engineEl = document.getElementById('active-engine');
      engineEl.textContent = getActiveRuntimeLabel(msg);
      engineEl.className = 'engine-badge engine-' + (msg.engine || 'custom');
      document.getElementById('active-timer').textContent = '0s';
      showActiveOutputPlaceholder('Waiting for terminal output...');
      const activeCard = document.getElementById('active-task');
      activeCard.hidden = false;
      activeCard.className = 'active-task-card visible';
      updateStatusSummary('Running: ' + (msg.playlistName || 'Playlist') + ' -> ' + msg.taskName);
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

      const activeCard = document.getElementById('active-task');
      const taskName = candidate.task.name || 'Untitled task';
      const playlistName = candidate.playlistName || 'Playlist';
      const contextText = candidate.phase === 'queued'
        ? (playlistName + ' (queued next)')
        : playlistName;

      document.getElementById('active-task-name').textContent = taskName;
      document.getElementById('active-task-context').textContent = contextText;

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

      activeCard.hidden = false;
      activeCard.className = 'active-task-card visible';
      updateStatusSummary('Running: ' + playlistName + ' -> ' + taskName);
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

    function detectErrorReason(text) {
      if (!text) { return null; }
      if (/usage.?limit|rate.?limit|quota.?exceeded|too many requests/i.test(text)) {
        var resetMatch = text.match(/try again at ([^.\\n]+)/i) || text.match(/reset[s]? (?:at|on) ([^.\\n]+)/i);
        return '\\u26A0 Rate limit reached' + (resetMatch ? ' \\u2014 resets ' + resetMatch[1].trim() : '') + '. Switch engine or wait.';
      }
      if (/authentication|auth.*fail|invalid.*key|unauthorized|403/i.test(text)) {
        return '\\u26A0 Authentication failed \\u2014 check your API key or login.';
      }
      if (/not.?found|command.?not.?found|is not recognized|ENOENT/i.test(text)) {
        return '\\u26A0 CLI not found \\u2014 is the engine installed and in PATH?';
      }
      if (/model.*not.*supported|model.*not.*found|invalid.*model/i.test(text)) {
        return '\\u26A0 Model not available \\u2014 check engine settings or switch model.';
      }
      if (/ETIMEDOUT|ECONNREFUSED|network|socket hang up/i.test(text)) {
        return '\\u26A0 Network error \\u2014 check your internet connection.';
      }
      return null;
    }

    function addCompletedCard(taskId, taskName, msg) {
      const section = document.getElementById('completed-section');
      section.hidden = false;

      if (completedOrder.length === 1) {
        const header = document.createElement('button');
        header.className = 'section-toggle';
        header.dataset.section = 'completed';
        header.onclick = function() { toggleSection('completed'); };
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

      const row = document.createElement('div');
      row.className = 'completed-task-row';
      var autoFixBadge = msg.autoFixed ? '<span class="autofix-badge">\\uD83D\\uDD27 Auto-fixed</span>' : '';
      row.innerHTML =
        '<span class="ct-icon ' + (passed ? 'pass' : skipped ? 'skip' : 'fail') + '">' +
          (passed ? '\\u2713' : skipped ? '\\u2212' : blocked ? '!' : '\\u2717') +
        '</span>' +
        '<span class="ct-name">' + escHtml(taskName) + autoFixBadge + '</span>' +
        '<span class="ct-stats">' +
          (state.engine ? '<span class="engine-badge engine-' + state.engine + '">' + state.engine + '</span>' : '') +
          '<span>' + durStr + '</span>' +
          (filesCount > 0 ? '<span>' + filesCount + ' file' + (filesCount !== 1 ? 's' : '') + '</span>' : '') +
        '</span>';
      row.onclick = function() { card.classList.toggle('expanded'); };

      if (!passed && !skipped) {
        const errLine = document.createElement('div');
        errLine.className = 'ct-error-line';
        const stderr = msg.stderr || (state.output || '');
        const errPreview = stderr.split('\\n').filter(function(l) { return l.trim(); }).slice(-2).join(' | ').substring(0, 120);
        errLine.textContent = blocked ? ('blocked' + (errPreview ? ': ' + errPreview : '')) : (errPreview || 'exit ' + msg.exitCode);
        errLine.title = stderr.split('\\n').filter(function(l) { return l.trim(); }).slice(-5).join('\\n');
        card.appendChild(errLine);

        const rawStderr = (msg.stderr || '').trim();
        const rawStdout = (msg.stdoutTail || state.output || '').trim();
        const errorSource = rawStderr || rawStdout;
        if (errorSource) {
          const errorLines = errorSource.split('\\n').filter(function(l) { return l.trim(); }).slice(-5)
            .map(function(l) { return l.length > 200 ? l.substring(0, 200) + '...' : l; });
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
        const actionRow = document.createElement('div');
        actionRow.className = 'diff-actions';
        actionRow.innerHTML =
          '<button type="button" onclick="event.stopPropagation(); vscode.postMessage({type:\\x27retryTask\\x27, taskId:\\x27' + taskId + '\\x27})">Retry</button>' +
          '<button type="button" onclick="event.stopPropagation(); vscode.postMessage({type:\\x27retryTaskWithNote\\x27, taskId:\\x27' + taskId + '\\x27})">Retry with Note</button>';
        card.appendChild(actionRow);
        card.classList.add('expanded');
      }

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
        verifyDiv.textContent = 'Verify: ' + state.verification.command + ' -> ' +
          (state.verification.passed ? 'passed' : 'failed') + ' (' + formatDuration(state.verification.durationMs || 0) + ')';
        detail.appendChild(verifyDiv);
      }
      if (msg.stderr) {
        const stderrDiv = document.createElement('div');
        stderrDiv.className = 'terminal-output ct-detail-output';
        stderrDiv.style.color = 'var(--error)';
        stderrDiv.textContent = msg.stderr;
        detail.appendChild(stderrDiv);
      }
      if (state.output) {
        const lines = state.output.split('\\n');
        const tail = lines.length > 100 ? lines.slice(-100).join('\\n') : state.output;
        const outDiv = document.createElement('div');
        outDiv.className = 'terminal-output ct-detail-output';
        outDiv.textContent = tail;
        detail.appendChild(outDiv);
      }
      if (msg.changedFiles && msg.changedFiles.length > 0) {
        const filesSection = document.createElement('details');
        filesSection.className = 'ct-detail-section';
        filesSection.open = true;
        filesSection.innerHTML = '<summary>Changed Files (' + msg.changedFiles.length + ')</summary>' +
          '<ul>' + msg.changedFiles.map(function(f) { return '<li>' + escHtml(f) + '</li>'; }).join('') + '</ul>';
        detail.appendChild(filesSection);
      }
      if (state.artifacts && state.artifacts.length > 0) {
        const artifactsSection = document.createElement('details');
        artifactsSection.className = 'ct-detail-section';
        artifactsSection.open = !passed;
        artifactsSection.innerHTML = '<summary>Artifacts (' + state.artifacts.length + ')</summary>' +
          '<ul>' + state.artifacts.map(function(a) { return '<li>' + escHtml(a.target) + ' - ' + (a.exists ? 'present' : 'missing') + '</li>'; }).join('') + '</ul>';
        detail.appendChild(artifactsSection);
      }
      if (msg.validationTargetResults && msg.validationTargetResults.length > 0) {
        const valSection = document.createElement('details');
        valSection.className = 'ct-detail-section';
        valSection.open = true;
        const statusIcon = function(s) { return s === 'pass' ? '\\u2713' : s === 'skip' ? '\\u25CB' : '\\u2717'; };
        const statusClass = function(s) { return s === 'pass' ? 'val-pass' : s === 'skip' ? 'val-skip' : 'val-fail'; };
        const rows = msg.validationTargetResults.map(function(r) {
          return '<tr class="' + statusClass(r.status) + '">' +
            '<td>' + statusIcon(r.status) + ' ' + escHtml(r.target) + '</td>' +
            '<td>' + escHtml(r.summary) + '</td>' +
            '<td>' + r.stagesPassed + '/' + (r.stagesPassed + r.stagesFailed) + ' stages</td>' +
            '<td>' + formatDuration(r.durationMs) + '</td>' +
            '</tr>';
        }).join('');
        valSection.innerHTML = '<summary>Validation Targets (' + msg.validationTargetResults.length + ')</summary>' +
          '<table class="val-target-table"><thead><tr><th>Target</th><th>Summary</th><th>Stages</th><th>Duration</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table>';
        detail.appendChild(valSection);
      }
      if (msg.codeChanges) {
        const diffSection = document.createElement('details');
        diffSection.className = 'diff-section';
        const diffText = msg.codeChanges.length > 8000 ? msg.codeChanges.substring(0, 8000) + '\\n... (truncated)' : msg.codeChanges;
        var fileSummaries = [];
        diffText.split('\\n').forEach(function(diffLine) {
          if (!diffLine.startsWith('diff --git a/')) { return; }
          var afterPrefix = diffLine.slice('diff --git a/'.length);
          var sepIdx = afterPrefix.indexOf(' b/');
          if (sepIdx !== -1) { fileSummaries.push(afterPrefix.slice(0, sepIdx)); }
        });
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
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      const progressSection = document.getElementById('progress-section');
      const tasks = currentPlan ? currentPlan.playlists.flatMap(function(pl) { return pl.tasks || []; }) : [];
      const passedTasks = tasks.filter(function(t) { return t.status === 'completed'; }).length;
      const failedTasks = tasks.filter(function(t) { return t.status === 'failed'; }).length;
      const blockedTasks = tasks.filter(function(t) { return t.status === 'blocked'; }).length;
      const effectiveCompleted = Math.max(completedCount, passedTasks + failedTasks + blockedTasks +
        tasks.filter(function(t) { return t.status === 'skipped'; }).length);
      const effectiveFailed = Math.max(failedCount, failedTasks);

      progressSection.hidden = !hasPlanLoaded();

      if (totalTasks === 0) {
        fill.style.width = '0%';
        fill.classList.remove('has-errors');
        document.getElementById('stats-tasks').textContent = '0/0 tasks (0 failed)';
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
        document.getElementById('stats-tasks').textContent = effectiveCompleted + '/' + totalTasks + ' tasks (' + failureCount + ' failed)';
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
        return '<button class="' + classes.join(' ') + '" onclick="document.getElementById(\\x27plan-section\\x27).scrollIntoView({behavior:\\x27smooth\\x27})" title="' + escHtml(pl.name || 'Playlist') + '">' +
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
      if (state === 'idle' && completedCount > 0 && completedCount >= totalTasks) {
        setDashboardState('complete');
      } else if (state === 'idle' && currentPlan) {
        setDashboardState('idle');
      } else if (state === 'playing') {
        setDashboardState('executing');
      }
      if (state === 'idle') {
        updateStatusSummary('Ready');
        stopTimer();
        if (currentTaskId === null) {
          const activeCard = document.getElementById('active-task');
          activeCard.hidden = true;
          activeCard.className = 'active-task-card';
        }
      } else if (state === 'paused') {
        updateStatusSummary('Paused');
      } else if (state === 'stopping') {
        updateStatusSummary('Stopping...');
      }
      updateTimers();
    }

    const collapsedSections = { info: true, sandbox: true };

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

    function getTaskDurationMs(task) {
      var taskState = cardState[task.id];
      if (taskState && typeof taskState.durationMs === 'number' && taskState.durationMs > 0) {
        return taskState.durationMs;
      }
      if (typeof task.durationMs === 'number' && task.durationMs > 0) {
        return task.durationMs;
      }
      return 0;
    }

    function getTaskDurationLabel(task) {
      var status = String(task.status || '').toLowerCase();
      if (status !== 'completed' && status !== 'failed' && status !== 'blocked' && status !== 'skipped') {
        return '';
      }
      var ms = getTaskDurationMs(task);
      return ms > 0 ? formatDuration(ms) : '';
    }

    function renderPlan(plan) {
      const section = document.getElementById('plan-section');
      const planName = document.getElementById('plan-name');
      var pointers = getExecutionPointers(plan);

      if (!plan || !plan.playlists || plan.playlists.length === 0) {
        section.innerHTML = '<div class="plan-placeholder">No plan loaded \\u2014 use the sidebar to create one.</div>';
        planName.textContent = plan && plan.name ? plan.name : 'MOAG';
        totalTasks = 0;
        renderPills(null);
        setDashboardState('empty');
        renderPromptComposerState();
        return;
      }

      planName.textContent = plan.name || 'Untitled Plan';
      let taskCount = 0;
      plan.playlists.forEach(function(pl) { taskCount += (pl.tasks || []).length; });
      totalTasks = taskCount;

      var tasksCollapsed = !!collapsedSections.tasks;
      var html = '<button class="section-toggle' + (tasksCollapsed ? ' collapsed' : '') + '" data-section="tasks" onclick="toggleSection(\\'tasks\\')">' +
        '<span class="section-toggle-icon">\\u25BC</span>' +
        '<span class="section-toggle-label">TASKS</span>' +
        '<span class="section-toggle-count">' + taskCount + '</span>' +
      '</button>';
      html += '<div class="section-body' + (tasksCollapsed ? ' collapsed' : '') + '" id="body-tasks">';

      plan.playlists.forEach(function(pl, playlistIndex) {
        const tasks = pl.tasks || [];
        const stats = getTaskStats(tasks);
        const doneCount = stats.completed + stats.failed + stats.blocked + stats.skipped;
        const playlistSectionId = 'playlist-' + playlistIndex;
        const playlistCollapsed = !!collapsedSections[playlistSectionId];
        const engineId = String(pl.engine || 'custom').toLowerCase();

        html += '<div class="playlist-block">';
        html += '<button class="section-toggle playlist-toggle' + (playlistCollapsed ? ' collapsed' : '') + '" data-section="' + playlistSectionId + '" onclick="toggleSection(\\'' + playlistSectionId + '\\')">' +
          '<span class="section-toggle-icon">\\u25BC</span>' +
          '<span class="section-toggle-label">' +
            '<span class="playlist-name">' + escHtml(pl.name || 'Playlist') + '</span>' +
          '</span>' +
          '<span class="engine-badge engine-' + escHtml(engineId) + '">' + escHtml(pl.engine || 'custom') + '</span>' +
          '<span class="playlist-progress">' + doneCount + '/' + tasks.length + '</span>' +
        '</button>';
        html += '<div class="section-body task-list' + (playlistCollapsed ? ' collapsed' : '') + '" id="body-' + playlistSectionId + '">';

        tasks.forEach(function(task, taskIndex) {
          var duration = getTaskDurationLabel(task);
          var isRunning = pointers.runningTaskId && task.id === pointers.runningTaskId;
          var isQueued = pointers.queuedTaskId && task.id === pointers.queuedTaskId;
          var runtimeBadge = isRunning
            ? '<span class="task-runtime-badge running">RUNNING</span>'
            : isQueued
              ? '<span class="task-runtime-badge queued">QUEUED NEXT</span>'
              : '';
          html += '<div class="task-row">' +
            '<span class="task-status-dot ' + escHtml(String(task.status || 'pending').toLowerCase()) + '"></span>' +
            '<span class="task-name">' + escHtml(task.name) + '</span>' +
            runtimeBadge +
            '<span class="task-duration">' + escHtml(duration) + '</span>' +
            '<button class="task-edit-btn" onclick="event.stopPropagation();vscode.postMessage({type:\\'editTask\\',playlistIndex:' + playlistIndex + ',taskIndex:' + taskIndex + '})" title="Edit task">Edit</button>' +
          '</div>';
        });

        html += '<button class="tree-add-btn" onclick="vscode.postMessage({type:\\'addTask\\',playlistIndex:' + playlistIndex + '})">+ Add task</button>';
        html += '</div>';
        html += '</div>';
      });

      html += '<button class="tree-add-playlist-btn" onclick="vscode.postMessage({type:\\'addPlaylist\\'})">+ Add playlist</button>';
      html += '</div>';
      section.innerHTML = html;
      if (dashboardState === 'empty') {
        setDashboardState('idle');
      }
      renderPromptComposerState();
    }

    // ─── History Section ───

    function renderHistory(history) {
      const section = document.getElementById('info-panel');
      if (!section) { return; }
      if (!history || history.length === 0) { section.innerHTML = ''; section.hidden = true; return; }
      section.hidden = false;

      // Group entries into runs (gap > 60s = new run)
      var runs = [];
      var currentRun = null;
      history.forEach(function(entry) {
        if (!currentRun || Math.abs((entry.startTime || 0) - (currentRun.time || 0)) > 60000) {
          currentRun = { time: entry.startTime || 0, passed: 0, failed: 0, entries: [] };
          runs.push(currentRun);
        }
        currentRun.entries.push(entry);
        if (entry.status === 'completed') { currentRun.passed++; }
        else if (entry.status !== 'skipped') { currentRun.failed++; }
      });

      var infoCollapsed = !!collapsedSections.info;
      var html = '<div class="history-section">';
      html += '<button class="section-toggle' + (infoCollapsed ? ' collapsed' : '') + '" data-section="info" onclick="toggleSection(\\'info\\')">' +
        '<span class="section-toggle-icon">\\u25BC</span>' +
        '<span class="section-toggle-label">HISTORY</span>' +
        '<span class="section-toggle-count">' + runs.length + ' run' + (runs.length !== 1 ? 's' : '') + '</span>' +
      '</button>' +
      '<div class="section-body' + (infoCollapsed ? ' collapsed' : '') + '" id="body-info">';

      runs.slice(0, 20).forEach(function(run, i) {
        var dateStr = run.time ? new Date(run.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown';
        var statusCls = run.failed > 0 ? 'fail' : 'pass';
        var statusText = run.failed > 0 ? (run.failed + ' failed') : 'All passed';
        html += '<div class="history-entry">' +
          '<span class="history-run-label">Run #' + (runs.length - i) + '</span>' +
          '<span class="history-run-meta">' + dateStr + ' \u00B7 ' + run.entries.length + ' tasks</span>' +
          '<span class="history-run-status ' + statusCls + '">' + statusText + '</span>' +
        '</div>';
      });

      html += '</div></div>';
      section.innerHTML = html;
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
          renderHistory(initState.history || []);
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
        var planSection = document.getElementById('plan-section');
        var hasRenderedPlan = !!(planSection && planSection.innerHTML.trim());
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
