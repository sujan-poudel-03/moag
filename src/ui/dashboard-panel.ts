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
const HTML_VERSION = '11';

/** A fresh nonce per render; the CSP admits only the script carrying it. */
function dashboardNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) { out += chars[Math.floor(Math.random() * chars.length)]; }
  return out;
}

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
    this._panel.webview.html = this.getHtml(this._panel.webview);
    this._webviewReadyFallbackTimer = setTimeout(() => {
      this._webviewReadyFallbackTimer = null;
      if (!this._webviewReady) {
        outputChannel.appendLine('[renderWebview] webview-ready handshake timed out; sending fallback update');
        this._webviewReady = true;
        this.update();
        this.replayHistoryCards();
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

  /** Push context memory info to the dashboard for the current task */
  public postContextMemory(info: {
    taskId: string;
    taskName: string;
    sections: Array<{ name: string; chars: number }>;
    totalCharsUsed: number;
    totalCharsBudget: number;
    sectionsDropped: number;
    retrievedFiles: string[];
  }): void {
    this.safePostMessage({ type: 'context-memory', ...info });
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

  /**
   * Replay completed history entries as task cards.
   * Called on webview-ready so a re-opened dashboard always shows prior results
   * even if the panel was closed during or after a run.
   */
  private replayHistoryCards(): void {
    const entries = this.historyStore.getAll().slice(0, 50);
    const replayable = entries.filter(
      e => e.result && (e.status === 'completed' || e.status === 'failed' || e.status === 'blocked'),
    );
    outputChannel.appendLine(`[replayHistoryCards] replaying ${replayable.length} entries`);
    for (const entry of replayable) {
      const r = entry.result;
      this.safePostMessage({
        type: 'complete-task-card',
        taskId: entry.taskId,
        taskName: entry.taskName,
        status: entry.status,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        stderr: (r.stderr ?? '').substring(0, 8000),
        stdoutTail: (r.stdout ?? '').substring(Math.max(0, (r.stdout ?? '').length - 3000)),
        command: r.command || '',
        summary: r.summary || '',
        changedFiles: entry.changedFiles,
        codeChanges: entry.codeChanges,
        verification: entry.verification,
        artifacts: entry.artifacts,
        autoFixed: entry.autoFixed || false,
        validationTargetResults: entry.validationTargetResults ?? null,
      });
    }
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
        this.replayHistoryCards();
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
        vscode.commands.executeCommand('agentTaskPlayer.newPlan');
        break;
      case 'export-results':
        vscode.commands.executeCommand('agentTaskPlayer.exportResults');
        break;
      case 'retry-failed':
        // agentTaskPlayer.retryFailed was never registered; this only appeared to
        // work because the rejected promise fell through to a full replay.
        vscode.commands.executeCommand('agentTaskPlayer.fixAllFailed');
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
  public getHtml(webview?: vscode.Webview): string {
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

    // Handed to the page as DATA, not as an interpolated script. The lone < is
    // escaped so a value can never terminate the block it is carried in.
    const bootstrapJson = JSON.stringify({
      htmlVersion: HTML_VERSION,
      stateBase64: initialStateBase64,
    }).replace(/</g, '\u003c');

    const view = webview ?? this._panel.webview;
    const scriptUri = view.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'dashboard.js'),
    );
    // A fresh nonce per render: the CSP admits exactly this script and nothing else.
    const nonce = dashboardNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';
    img-src ${view.cspSource} data: https:;
    style-src ${view.cspSource} 'unsafe-inline';
    font-src ${view.cspSource};
    script-src 'nonce-${nonce}';">
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
      margin: 6px;
      border: 1px solid var(--focus-border);
      border-radius: 6px;
      overflow: hidden;
      display: none;
      flex-direction: column;
      flex-grow: 1;
      min-height: 120px;
    }
    body.task-active .active-task { display: flex; }
    .active-task.visible { display: flex; }
    .active-task-header {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      background: rgba(0,122,204,0.06);
      flex-shrink: 0;
    }
    .active-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--success); animation: dot-pulse 1s infinite;
    }
    @keyframes dot-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.7); opacity: 0.4; }
    }
    .active-task-name {
      flex: 1; font-weight: 600; font-size: 13px;
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
      font-size: 12px; font-family: monospace; color: var(--dimmed);
    }

    /* ─── Terminal Output ─── */
    .terminal-output {
      background: var(--terminal-bg); color: var(--terminal-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; overflow-y: auto; white-space: pre-wrap;
      word-break: break-all; word-wrap: break-word; line-height: 1.4;
    }
    .active-task-output {
      padding: 8px 10px; min-height: 80px; flex: 1;
      overflow-y: auto; overflow-x: hidden; max-width: 100%;
    }
    .active-task-details { border-top: 1px solid var(--border); font-size: 12px; }
    .active-task-details summary { padding: 4px 10px; cursor: pointer; color: var(--dimmed); }
    .active-task-details pre { padding: 6px 10px; margin: 0; max-height: 150px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
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
    /* ─── Quick Composer ─── */
    .prompt-composer { margin: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--sidebar-bg); overflow: hidden; }
    .prompt-composer-header { font-size: 10px; font-weight: 600; color: var(--dimmed); padding: 7px 10px 4px; text-transform: uppercase; letter-spacing: 0.3px; }
    .prompt-composer-input { width: 100%; box-sizing: border-box; background: transparent; border: none; border-top: 1px solid var(--border); color: var(--fg); font-size: 12px; padding: 8px 10px; resize: none; outline: none; font-family: var(--vscode-editor-font-family, inherit); line-height: 1.5; }
    .prompt-composer-toolbar { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-top: 1px solid var(--border); }
    .prompt-engine-select { font-size: 10px; background: var(--sidebar-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; }
    .prompt-char-count { font-size: 10px; color: var(--dimmed); flex: 1; }
    .prompt-composer-actions { display: flex; gap: 4px; }
    .prompt-action-btn { font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer; }
    .prompt-action-btn.ghost { border: 1px solid var(--border); background: transparent; color: var(--dimmed); }
    .prompt-action-btn.primary { border: 1px solid rgba(79,163,255,0.5); background: rgba(79,163,255,0.15); color: var(--vscode-textLink-foreground); }
    .prompt-action-btn:hover { opacity: 0.85; }
    .prompt-context-pill { padding: 3px 10px 5px; font-size: 10px; color: var(--dimmed); border-top: 1px solid var(--border); }

    /* ─── Result Banner ─── */
    .result-banner {
      margin: 8px; padding: 12px 14px; border-radius: 6px; display: none;
    }
    .result-banner.success { background: rgba(78,201,176,0.12); border: 1px solid rgba(78,201,176,0.5); }
    .result-banner.has-failures { background: rgba(200,140,40,0.12); border: 1px solid rgba(220,160,50,0.6); }
    .result-banner-title { font-weight: 700; font-size: 14px; margin-bottom: 8px; }
    .result-banner.success .result-banner-title { color: var(--success); }
    .result-banner.has-failures .result-banner-title { color: #e8a838; }
    .result-banner-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .result-banner-btn {
      padding: 5px 14px; border-radius: 4px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: 1px solid; white-space: nowrap;
    }

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
    .completed-card { border: 1px solid var(--border); border-radius: 4px; margin-bottom: 3px; overflow: hidden; }
    .completed-card.failed { border-left: 3px solid var(--error); }
    .completed-card-row {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px; cursor: pointer; font-size: 12px; height: 30px;
    }
    .completed-card-row:hover { background: var(--hover-bg); }
    .cc-icon { font-size: 12px; flex-shrink: 0; width: 14px; text-align: center; }
    .cc-icon.pass { color: var(--success); }
    .cc-icon.fail { color: var(--error); }
    .cc-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cc-meta { font-size: 10px; color: var(--dimmed); flex-shrink: 0; }
    .cc-error { font-size: 11px; color: var(--error); padding: 2px 8px 4px 28px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cc-detail { display: none; border-top: 1px solid var(--border); }
    .completed-card.expanded .cc-detail { display: block; }
    .cc-chevron { font-size: 9px; color: var(--dimmed); flex-shrink: 0; transform: rotate(90deg); transition: transform 0.15s; }
    .completed-card.expanded .cc-chevron { transform: rotate(270deg); }
    .cc-actions { display: flex; gap: 6px; padding: 6px 8px 4px; }
    .cc-btn { font-size: 10px; padding: 2px 7px; border-radius: 3px; cursor: pointer; border: 1px solid rgba(79,163,255,0.4); background: rgba(79,163,255,0.1); color: var(--vscode-textLink-foreground); }
    .cc-btn.ghost { border-color: rgba(255,255,255,0.15); background: transparent; color: var(--dimmed); }
    .cc-btn:hover { opacity: 0.85; }

    /* ─── Diff Viewer ─── */
    .diff-add { background: rgba(78,201,176,0.15); color: inherit; display: block; }
    .diff-hunk { color: var(--dimmed); font-style: italic; display: block; }

    /* ─── Context Memory Panel ─── */
    .ctx-mem-section { border-top: 1px solid var(--border); flex-shrink: 0; }
    .ctx-mem-body { padding: 6px 12px 10px; font-size: 11px; }
    .ctx-mem-task { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctx-mem-stale { font-size: 9px; opacity: 0.5; font-style: italic; }
    .ctx-mem-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
    .ctx-mem-bar-wrap { flex: 1; background: rgba(255,255,255,0.06); border-radius: 3px; height: 5px; overflow: hidden; }
    .ctx-mem-bar { height: 100%; border-radius: 3px; background: var(--vscode-textLink-foreground); }
    .ctx-mem-name { width: 72px; flex-shrink: 0; color: var(--vscode-foreground); font-weight: 600; }
    .ctx-mem-chars { width: 52px; flex-shrink: 0; text-align: right; color: var(--vscode-descriptionForeground); }
    .ctx-mem-total { display: flex; justify-content: space-between; margin-top: 6px; padding-top: 5px; border-top: 1px solid rgba(255,255,255,0.07); color: var(--vscode-descriptionForeground); }
    .ctx-mem-total-pct { font-weight: 600; color: var(--vscode-foreground); }
    .ctx-mem-files { margin-top: 4px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .ctx-mem-dropped { color: var(--vscode-editorWarning-foreground); font-size: 10px; margin-top: 3px; }

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
    .sandbox-error-banner {
      display: none; flex-direction: column; gap: 6px;
      background: rgba(244,67,54,0.12); border: 1px solid rgba(244,67,54,0.4);
      border-radius: 4px; padding: 8px 10px;
    }
    .sandbox-error-banner.visible { display: flex; }
    .sandbox-error-title { font-size: 11px; font-weight: 600; color: #f44336; }
    .sandbox-error-msg { font-size: 11px; color: var(--fg); line-height: 1.5; word-break: break-word; }
    .sandbox-error-hint { font-size: 10px; color: var(--dimmed); line-height: 1.4; }
    .sandbox-retry-btn {
      align-self: flex-start; font-size: 11px; padding: 3px 10px;
      background: rgba(244,67,54,0.2); border: 1px solid rgba(244,67,54,0.5);
      color: #f88; border-radius: 3px; cursor: pointer;
    }
    .sandbox-retry-btn:hover { background: rgba(244,67,54,0.35); }
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
      <button id="btn-play" class="icon-btn primary" title="Execute">▶</button>
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
      <details class="active-task-details" id="active-task-details">
        <summary>Details</summary>
        <pre id="active-task-details-content"></pre>
      </details>
    </div>

    <!-- IDLE: Plan summary -->
    <div class="plan-summary" id="plan-summary" hidden>
      <div class="plan-summary-name" id="plan-summary-name"></div>
      <div class="plan-summary-desc" id="plan-summary-desc" hidden></div>
      <div class="plan-summary-playlists" id="plan-summary-playlists"></div>
      <div class="plan-summary-total" id="plan-summary-total"></div>
      <button class="plan-summary-play" id="plan-summary-play">▶ Play</button>
    </div>
    <!-- Quick composer — visible in idle/no-plan state -->
    <div class="prompt-composer" id="prompt-composer" hidden>
      <div class="prompt-composer-header">Run a prompt or generate a plan</div>
      <textarea id="prompt-input" class="prompt-composer-input" rows="3"
        placeholder="Describe what you want to build or fix…"></textarea>
      <div class="prompt-composer-toolbar">
        <select id="prompt-engine" class="prompt-engine-select"></select>
        <span id="prompt-char-count" class="prompt-char-count">0</span>
        <div class="prompt-composer-actions">
          <button id="prompt-generate-plan" class="prompt-action-btn ghost" title="Generate a plan from this description">Plan</button>
          <button id="prompt-add-task" class="prompt-action-btn ghost" title="Add as a task to the current plan">Add Task</button>
          <button id="prompt-submit" class="prompt-action-btn primary" title="Execute now (Ctrl+Enter)">Execute ▶</button>
        </div>
      </div>
      <div id="prompt-context-pill" class="prompt-context-pill" hidden>
        <span id="prompt-context-note"></span>
      </div>
    </div>
    <div class="no-plan-message" id="no-plan-message" hidden>
      No plan loaded. Use the sidebar to create a plan or run a prompt.
    </div>

    <!-- IDLE + COMPLETE: Result banner -->
    <div class="result-banner" id="result-banner"></div>

    <!-- IDLE + COMPLETE: Error banner -->
    <div class="error-banner" id="error-banner"></div>

    <!-- COMPLETE: Completed cards -->
    <div class="completed-section" id="completed-section" hidden></div>

    <!-- Context Memory Panel — shows what the agent sees before executing -->
    <div class="ctx-mem-section" id="ctx-mem-section" hidden>
      <button class="section-toggle" data-section="ctx-mem" onclick="toggleSection('ctx-mem')">
        <span class="section-toggle-icon">&#x25BC;</span>
        <span class="section-toggle-label">Context Memory</span>
        <span class="section-toggle-count" id="ctx-mem-count"></span>
      </button>
      <div class="section-body" id="body-ctx-mem">
        <div class="ctx-mem-body" id="ctx-mem-body"></div>
      </div>
    </div>

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
          <div class="sandbox-error-banner" id="sandbox-error-banner">
            <span class="sandbox-error-title">&#9888; Sandbox failed to start</span>
            <span class="sandbox-error-msg" id="sandbox-error-msg"></span>
            <span class="sandbox-error-hint" id="sandbox-error-hint"></span>
            <button class="sandbox-retry-btn" onclick="vscode.postMessage({type:'sandbox-launch'})">&#8635; Retry</button>
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
  <script id="moag-bootstrap" type="application/json">${bootstrapJson}</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
