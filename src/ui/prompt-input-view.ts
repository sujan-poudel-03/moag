import * as vscode from 'vscode';
import { designSystemCssTokens } from './design-system';

export interface PromptInputSubmitRequest {
  prompt: string;
  engineId?: string;
  imageData?: string; // base64 data URI (e.g. data:image/png;base64,...)
}

export interface PromptEngineOption {
  id: string;
  label: string;
}

export interface PromptSidebarListItem {
  id: string;
  kind: 'thread' | 'run' | 'plan' | 'history';
  title: string;
  subtitle: string;
  status?: string;
  planName?: string;
  playlistName?: string;
}

export interface PromptSidebarPlanGroup {
  id: string;
  name: string;
  playlistStatus: string;
  progress: { done: number; total: number };
  tasks: Array<{ id: string; name: string; status: string; failureReason?: string }>;
}

export interface PromptSidebarChatMessage {
  id: string;
  role: 'user' | 'assistant';
  author: string;
  text: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
  changedFilesCount?: number;
  durationMs?: number;
  verificationPassed?: boolean;
  exitCode?: number;
}

export interface PromptSidebarRunnerState {
  state: 'idle' | 'playing' | 'paused' | 'stopping';
}

export class PromptInputViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentTaskPlayer.promptView';

  private _view?: vscode.WebviewView;
  private _engines: PromptEngineOption[] = [];
  private _selectedEngineId?: string;
  private _chatItems: PromptSidebarListItem[] = [];
  private _planItems: PromptSidebarListItem[] = [];
  private _historyItems: PromptSidebarListItem[] = [];
  private _chatTitle = 'New Chat';
  private _chatMessages: PromptSidebarChatMessage[] = [];
  private _activeThreadId = '';
  private _runnerState: PromptSidebarRunnerState['state'] = 'idle';
  private _planGroups: PromptSidebarPlanGroup[] = [];
  private _activePlanName = '';
  private _activePlaylistName = '';
  private _sandboxState: unknown = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _onSubmit: (request: PromptInputSubmitRequest) => Promise<boolean>,
    private readonly _onOpenItem: (id: string, kind: 'thread' | 'run' | 'plan' | 'history') => void,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'ready') {
        this._syncState();
        return;
      }

      if (message.type === 'openItem') {
        const id = typeof message.id === 'string' ? message.id : '';
        const kind = message.kind === 'run' || message.kind === 'plan' || message.kind === 'history'
          ? message.kind
          : 'thread';
        if (id) {
          this._onOpenItem(id, kind);
        }
        return;
      }

      if (message.type === 'showDashboard') {
        void vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
        return;
      }

      if (message.type === 'reviewChanges') {
        void vscode.commands.executeCommand('agentTaskPlayer.reviewChanges');
        return;
      }

      if (message.type === 'openSettings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'agentTaskPlayer');
        return;
      }

      if (message.type === 'newThread') {
        void vscode.commands.executeCommand('agentTaskPlayer.newThread');
        return;
      }

      if (message.type === 'switchPlan') {
        void vscode.commands.executeCommand('agentTaskPlayer.switchPlan');
        return;
      }

      if (message.type === 'newPlan') {
        void vscode.commands.executeCommand('agentTaskPlayer.newPlan');
        return;
      }

      if (message.type === 'addTask') {
        void vscode.commands.executeCommand('agentTaskPlayer.addTask');
        return;
      }

      if (message.type === 'playPlan') {
        void vscode.commands.executeCommand('agentTaskPlayer.play');
        return;
      }

      if (message.type === 'playPlaylist') {
        const playlistIndex = Number(message.playlistIndex);
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.playPlaylist', {
            kind: 'playlist',
            playlistIndex,
          });
        }
        return;
      }

      if (message.type === 'playTask') {
        const playlistIndex = Number(message.playlistIndex);
        const taskIndex = Number(message.taskIndex);
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0 && !Number.isNaN(taskIndex) && taskIndex >= 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.playTask', {
            kind: 'task',
            playlistIndex,
            taskIndex,
          });
        }
        return;
      }

      if (message.type === 'retryTask') {
        const playlistIndex = Number(message.playlistIndex);
        const taskIndex = Number(message.taskIndex);
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0 && !Number.isNaN(taskIndex) && taskIndex >= 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.retryTask', {
            kind: 'task',
            playlistIndex,
            taskIndex,
          });
        }
        return;
      }

      if (message.type === 'retryTaskWithNote') {
        const playlistIndex = Number(message.playlistIndex);
        const taskIndex = Number(message.taskIndex);
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0 && !Number.isNaN(taskIndex) && taskIndex >= 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.retryTaskWithNote', {
            kind: 'task',
            playlistIndex,
            taskIndex,
          });
        }
        return;
      }

      if (message.type === 'pauseRun') {
        void vscode.commands.executeCommand('agentTaskPlayer.pause');
        return;
      }

      if (message.type === 'runSelectedPlaylists') {
        const rawItems = Array.isArray(message.items) ? message.items : [];
        const selectedItems = rawItems
          .map((item: unknown) => {
            const it = item as { kind?: string; playlistIndex?: unknown; taskIndex?: unknown };
            const playlistIndex = Number(it.playlistIndex);
            const taskIndex = it.taskIndex === undefined ? undefined : Number(it.taskIndex);
            if (Number.isNaN(playlistIndex) || playlistIndex < 0) {
              return null;
            }
            if (it.kind === 'task') {
              if (taskIndex === undefined || Number.isNaN(taskIndex) || taskIndex < 0) {
                return null;
              }
              return { kind: 'task', playlistIndex, taskIndex };
            }
            return { kind: 'playlist', playlistIndex };
          })
          .filter((item: unknown): item is { kind: 'playlist' | 'task'; playlistIndex: number; taskIndex?: number } => !!item);
        if (selectedItems.length > 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.runSelected', selectedItems[0], selectedItems);
        }
        return;
      }

      if (message.type === 'submit' && message.text?.trim()) {
        this.setBusy(true);
        try {
          const submitted = await this._onSubmit({
            prompt: message.text.trim(),
            engineId: typeof message.engineId === 'string' ? message.engineId : undefined,
            imageData: typeof message.imageData === 'string' ? message.imageData : undefined,
          });
          if (submitted) {
            this.clear();
          }
        } finally {
          this.setBusy(false);
        }
      }

      if (message.type === 'launchSandbox') {
        void vscode.commands.executeCommand('agentTaskPlayer.launchSandbox');
        return;
      }
      if (message.type === 'stopSandbox') {
        void vscode.commands.executeCommand('agentTaskPlayer.stopSandbox');
        return;
      }
      if (message.type === 'takeScreenshot') {
        void vscode.commands.executeCommand('agentTaskPlayer.takeScreenshot');
        return;
      }
      if (message.type === 'openSandboxBrowser') {
        const url = typeof message.url === 'string' ? message.url : '';
        if (url) {
          void vscode.commands.executeCommand('simpleBrowser.api.open', url);
        }
        return;
      }
    });
  }

  setEngines(engines: PromptEngineOption[], selectedEngineId?: string): void {
    this._engines = engines;
    this._selectedEngineId = selectedEngineId;
    this._syncState();
  }

  setSidebarState(
    chatItems: PromptSidebarListItem[],
    planItems: PromptSidebarListItem[],
    historyItems: PromptSidebarListItem[],
    chatTitle: string,
    chatMessages: PromptSidebarChatMessage[],
    activeThreadId: string,
    runnerState: PromptSidebarRunnerState['state'],
    planGroups: PromptSidebarPlanGroup[],
    activePlanName: string,
    activePlaylistName: string,
  ): void {
    this._chatItems = chatItems;
    this._planItems = planItems;
    this._historyItems = historyItems;
    this._chatTitle = chatTitle || 'New Chat';
    this._chatMessages = chatMessages;
    this._activeThreadId = activeThreadId;
    this._runnerState = runnerState;
    this._planGroups = planGroups;
    this._activePlanName = activePlanName || '';
    this._activePlaylistName = activePlaylistName || '';
    this._syncState();
  }

  setBusy(busy: boolean): void {
    this._view?.webview.postMessage({ type: 'setBusy', busy });
  }

  clear(): void {
    this._view?.webview.postMessage({ type: 'clear' });
  }

  private _syncState(): void {
    this._view?.webview.postMessage({
      type: 'syncState',
      engines: this._engines,
      selectedEngineId: this._selectedEngineId,
      chatItems: this._chatItems,
      planItems: this._planItems,
      historyItems: this._historyItems,
      chatTitle: this._chatTitle,
    chatMessages: this._chatMessages,
      planGroups: this._planGroups,
    activeThreadId: this._activeThreadId,
    runnerState: this._runnerState,
    activePlanName: this._activePlanName,
    activePlaylistName: this._activePlaylistName,
    sandboxState: this._sandboxState,
  });
  }

  /** Push sandbox state to the sidebar webview */
  postSandboxState(state: unknown): void {
    this._sandboxState = state;
    this._view?.webview.postMessage({ type: 'sandbox-state', sandboxState: state });
  }

  private _getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${designSystemCssTokens()}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--ds-font-family);
      font-size: var(--ds-font-size);
      color: var(--ds-fg);
      background: transparent;
      overflow: hidden;
    }
    .topbar {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      padding: 0 4px 0 6px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      flex-shrink: 0;
      min-height: 35px;
    }
    .tabs { display: inline-flex; align-items: stretch; gap: 0; flex: 1; min-width: 0; overflow: hidden; }
    .tab {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      padding: 0 10px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .tab:hover:not(.active) { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.07)); }
    .tab-icon {
      width: 13px; height: 13px; flex-shrink: 0;
      fill: currentColor; display: block; opacity: 0.8;
    }
    .tab.active .tab-icon { opacity: 1; }
    .topbar-actions {
      display: inline-flex; align-items: center; gap: 1px; flex-shrink: 0; padding: 4px 0;
    }
    .topbar-divider {
      width: 1px; height: 16px; align-self: center;
      background: var(--vscode-panel-border, rgba(128,128,128,0.35));
      margin: 0 4px; flex-shrink: 0;
    }
    .topbar-btn {
      width: 26px; height: 26px; border: none; border-radius: 4px;
      background: transparent; color: var(--vscode-descriptionForeground);
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .topbar-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .topbar-btn svg { width: 14px; height: 14px; fill: currentColor; display: block; }
    /* keep action-btn for backward compat with plan tab buttons */
    .action-btn-icon { width: 14px; height: 14px; flex-shrink: 0; fill: currentColor; display: block; }
    .action-btn {
      min-width: 26px; height: 26px; padding: 0 5px; border: none; border-radius: 4px;
      background: transparent; color: var(--vscode-descriptionForeground);
      font-size: 11px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    }
    .action-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .tab:focus-visible, .topbar-btn:focus-visible, .action-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
    }

    .content {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 8px;
    }
    .list { display: none; flex-direction: column; gap: 4px; min-height: 0; overflow-y: auto; overflow-x: hidden; }
    .list.active { display: flex; flex: 1; }
    .item {
      width: 100%;
      border: none;
      background: transparent;
      text-align: left;
      padding: 7px 8px;
      border-radius: 8px;
      cursor: pointer;
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .item.running-item {
      background: rgba(76,175,80,0.14);
      box-shadow: inset 3px 0 0 rgba(76,175,80,0.9);
      border: 1px solid rgba(76,175,80,0.3);
    }
    .item-title {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .item-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      flex-shrink: 0; opacity: 0.4;
    }
    .item-dot.recent { background: #4fa3ff; opacity: 1; }
    .item-dot.active { background: #4caf50; opacity: 1; }
    .item-dot.failed { background: #f44747; opacity: 1; }
    .item-meta {
      display: flex; align-items: center; gap: 6px;
      font-size: 10px; color: var(--vscode-descriptionForeground);
      padding-left: 13px;
    }
    .item-meta-files { color: #4caf50; }
    .item-tip {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      padding: 8px 10px; border-radius: 6px;
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06));
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
      line-height: 1.5; margin: 4px 0 6px;
    }
    .item-tip a, .item-tip strong { color: var(--vscode-focusBorder); font-weight: 600; }
    .state-icon {
      width: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      flex-shrink: 0;
      opacity: 0.95;
    }
    .state-icon.completed { color: #4caf50; }
    .state-icon.pending { color: var(--vscode-descriptionForeground); }
    .state-icon.running { color: #4fa3ff; }
    .state-icon.failed { color: #f44747; }
    .state-icon.blocked { color: #cca700; }
    .state-icon.skipped { color: #b0b0b0; }
    .task-title-completed {
      text-decoration: line-through;
      text-decoration-color: rgba(76,175,80,0.5);
    }
    .item-subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding-left: 12px;
    }
    .item.running-item .item-subtitle {
      color: #8ce89a;
      font-weight: 600;
    }
    .item-subtitle.error {
      color: #f44747;
      font-size: 10px;
      margin-top: -1px;
    }
    .run-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid rgba(76,175,80,0.5);
      color: #4caf50;
      background: rgba(76,175,80,0.12);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.35px;
      width: fit-content;
      margin-left: 12px;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 10px 6px;
      display: none;
    }
    .empty.active { display: block; }

    .chat-screen { display: none; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; overflow-x: hidden; }
    .chat-screen.active { display: flex; flex: 1; }
    .history-tools {
      display: none;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
      padding: 0 2px;
    }
    .history-tools.active { display: flex; }
    .tool-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .tool-select {
      height: 20px;
      padding: 0 4px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      font-size: 10px;
    }
    .group-head {
      width: 100%;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      margin: 8px 0 2px;
      padding: 0 8px;
      text-align: left;
      cursor: pointer;
    }
    .group-head:hover { color: var(--vscode-foreground); }
    .group-head.plan {
      border-left: 2px solid #4fa3ff;
      padding-left: 6px;
    }
    .group-head.playlist {
      border-left: 2px solid #3ebf6a;
      padding-left: 6px;
    }
    .group-head-label {
      display: inline-block;
      margin-right: 6px;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 9px;
      letter-spacing: 0.3px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      vertical-align: middle;
    }
    .group-head.plan .group-head-label {
      border-color: rgba(79,163,255,0.6);
      color: #4fa3ff;
      background: rgba(79,163,255,0.12);
    }
    .group-head.playlist .group-head-label {
      border-color: rgba(62,191,106,0.6);
      color: #3ebf6a;
      background: rgba(62,191,106,0.12);
    }
    .plan-overview {
      display: none;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 8px;
      padding: 8px;
      margin-bottom: 8px;
      background: rgba(128,128,128,0.04);
    }
    .plan-overview.active { display: block; }
    .plan-overview-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
    }
    .plan-overview-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .plan-overview-running {
      display: none;
      margin-top: 6px;
      font-size: 10px;
      color: #8ce89a;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .plan-overview-running.active {
      display: inline-flex;
    }
    .plan-overview-running .dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #4caf50;
      box-shadow: 0 0 0 0 rgba(76,175,80,0.5);
      animation: running-dot-pulse 1.2s ease-out infinite;
      flex-shrink: 0;
    }
    .plan-overview-running .text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    @keyframes running-dot-pulse {
      0% { box-shadow: 0 0 0 0 rgba(76,175,80,0.5); }
      100% { box-shadow: 0 0 0 6px rgba(76,175,80,0); }
    }
    .plan-overview-bar {
      height: 6px;
      width: 100%;
      border-radius: 999px;
      background: rgba(128,128,128,0.2);
      overflow: hidden;
    }
    .plan-overview-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #4fa3ff 0%, #3ebf6a 100%);
      transition: width 180ms ease;
    }
    .plan-queue {
      display: none;
      margin-bottom: 8px;
      border: 1px solid var(--ds-border);
      border-radius: 10px;
      background: rgba(128,128,128,0.04);
      overflow: hidden;
    }
    .plan-queue.active { display: block; }
    .plan-queue-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 10px;
      border-bottom: 1px solid var(--ds-border);
    }
    .plan-queue-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: var(--ds-muted);
      font-weight: 600;
    }
    .plan-queue-meta {
      font-size: 10px;
      color: var(--ds-muted);
    }
    .plan-queue-next {
      padding: 9px 10px;
      font-size: 12px;
      color: var(--ds-fg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .plan-queue-next-task {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .plan-queue-dots {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }
    .plan-queue-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: rgba(128,128,128,0.35);
    }
    .plan-queue-dot.active { background: #cca700; }
    .plan-tools {
      display: none;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      margin-bottom: 8px;
    }
    .plan-tools.active { display: flex; }
    .plan-tools-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-wrap: wrap;
    }
    .plan-tools-row.secondary { display: none; }
    .plan-tool-btn {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 9px;
      cursor: pointer;
      text-transform: uppercase;
    }
    .plan-tool-btn.icon-only {
      width: 24px;
      min-width: 24px;
      padding: 1px 0;
      text-align: center;
      font-size: 12px;
      text-transform: none;
      font-weight: 500;
      line-height: 1;
    }
    .plan-tool-btn .plan-icon-svg {
      width: 12px;
      height: 12px;
      display: block;
      margin: auto;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .plan-search-bar {
      display: none;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
      margin-bottom: 4px;
    }
    .plan-search-bar.active {
      display: flex;
    }
    .plan-search-input {
      flex: 1;
      min-width: 0;
      height: 22px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 11px;
      padding: 0 8px;
      outline: none;
    }
    .plan-search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .plan-tool-btn.icon-only[data-badge]:not([data-badge="0"]) {
      position: relative;
    }
    .plan-tool-btn.icon-only[data-badge]:not([data-badge="0"])::after {
      content: attr(data-badge);
      position: absolute;
      top: -5px;
      right: -5px;
      min-width: 12px;
      height: 12px;
      border-radius: 999px;
      background: var(--ds-warning);
      color: #111;
      font-size: 8px;
      line-height: 12px;
      text-align: center;
      font-weight: 700;
      padding: 0 3px;
      border: 1px solid rgba(0,0,0,0.25);
    }
    .plan-tool-btn.icon-only:disabled {
      opacity: 0.5;
    }
    .plan-tool-btn:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: rgba(0,122,204,0.12);
    }
    .plan-tool-btn.active {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: rgba(0,122,204,0.16);
    }
    .plan-tools-left {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .plan-select-master {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 999px;
      padding: 1px 7px;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      user-select: none;
    }
    .plan-select-master input {
      width: 12px;
      height: 12px;
      accent-color: var(--vscode-focusBorder);
    }
    .plan-exec-counter {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 999px;
      padding: 1px 6px;
      text-transform: uppercase;
      letter-spacing: 0.2px;
    }
    .plan-runner-badge {
      font-size: 9px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 999px;
      padding: 1px 6px;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      color: var(--vscode-descriptionForeground);
      background: rgba(128,128,128,0.06);
    }
    .plan-runner-badge.running {
      color: #4caf50;
      border-color: rgba(76,175,80,0.5);
      background: rgba(76,175,80,0.12);
      animation: plan-runner-pulse 1.2s ease-in-out infinite;
    }
    .plan-runner-badge.paused {
      color: #cca700;
      border-color: rgba(204,167,0,0.5);
      background: rgba(204,167,0,0.12);
    }
    .plan-runner-badge.stopping {
      color: #f39c12;
      border-color: rgba(243,156,18,0.5);
      background: rgba(243,156,18,0.12);
    }
    @keyframes plan-runner-pulse {
      0% { opacity: 0.65; }
      50% { opacity: 1; }
      100% { opacity: 0.65; }
    }
    .plan-tools-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .plan-list-heading {
      display: none;
      font-size: 11px;
      font-weight: 600;
      color: var(--ds-muted);
      padding: 2px 2px 8px;
      text-transform: uppercase;
      letter-spacing: 0.35px;
      align-items: center;
      gap: 6px;
    }
    .plan-list-heading.active { display: inline-flex; }
    .plan-list-heading .plan-tool-btn {
      margin-left: auto;
      text-transform: none;
      font-size: 10px;
    }
    .plan-tools-meta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-left: auto;
    }
    .plan-tool-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      padding-left: 6px;
      margin-left: 2px;
    }
    .plan-tool-group:first-child {
      border-left: none;
      padding-left: 0;
      margin-left: 0;
    }
    .plan-tool-group.filter-right {
      margin-left: auto;
    }
    .plan-manage-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .plan-manage-menu {
      display: none;
      position: absolute;
      top: 22px;
      left: 0;
      z-index: 30;
      min-width: 170px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      padding: 4px;
      flex-direction: column;
      gap: 4px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.25);
    }
    .plan-manage-menu.open { display: inline-flex; }
    .plan-menu-item {
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 6px;
      padding: 3px 6px;
      font-size: 10px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    .plan-menu-item:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: rgba(0,122,204,0.12);
    }
    .plan-menu-item:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .plan-check {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .plan-check input {
      width: 12px;
      height: 12px;
      accent-color: var(--vscode-focusBorder);
    }
    .plan-filter {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      margin-left: 0;
    }
    .plan-filter-label {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .plan-filter-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .plan-filter-menu {
      display: none;
      position: absolute;
      top: 22px;
      right: 0;
      left: auto;
      z-index: 30;
      min-width: 200px;
      max-width: 260px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      padding: 6px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.25);
      display: none;
      flex-direction: column;
      gap: 6px;
    }
    .plan-filter-menu.open { display: inline-flex; }
    .plan-active-name {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 170px;
    }
    .plan-group-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .plan-group-toggle {
      flex: 1;
      min-width: 0;
      border: none;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      flex-direction: column;
      gap: 2px;
    }
    .plan-group-play {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 9px;
      cursor: pointer;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .plan-group-play.running {
      border-color: rgba(204,167,0,0.5);
      color: #cca700;
      background: rgba(204,167,0,0.12);
    }
    .task-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .task-check {
      width: 12px;
      height: 12px;
      accent-color: var(--vscode-focusBorder);
      flex-shrink: 0;
      display: none;
    }
    .plan-group-row > input[type="checkbox"] {
      display: none;
    }
    .plan-selection-mode .task-check,
    .plan-selection-mode .plan-group-row > input[type="checkbox"] {
      display: inline-block;
    }
    .task-main {
      flex: 1;
      min-width: 0;
      border: none;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      flex-direction: column;
      gap: 2px;
    }
    .task-actions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease;
    }
    .item:hover .task-actions,
    .task-row:focus-within .task-actions,
    .task-actions.always-visible {
      opacity: 1;
      pointer-events: auto;
    }
    .task-act-btn {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 9px;
      cursor: pointer;
      text-transform: uppercase;
    }
    .task-act-btn.running {
      border-color: rgba(204,167,0,0.5);
      color: #cca700;
      background: rgba(204,167,0,0.12);
    }
    .chip-row { display: inline-flex; gap: 4px; margin-left: 4px; }
    .chip {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 10px;
      cursor: pointer;
      text-transform: uppercase;
    }
    .chip.active {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: rgba(0,122,204,0.12);
    }

    /* ─── Sidebar Sandbox ─── */
    .sidebar-sandbox { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15)); margin-top: 6px; padding-top: 2px; }
    .sidebar-sandbox-toggle {
      display: flex; align-items: center; gap: 4px; width: 100%;
      border: none; background: none; cursor: pointer; user-select: none;
      color: var(--vscode-foreground); padding: 4px 0; font-size: 11px;
    }
    .sidebar-sandbox-toggle:hover { opacity: 0.8; }
    .sidebar-sandbox-icon { font-size: 10px; width: 14px; text-align: center; transition: transform 0.1s; }
    .sidebar-sandbox-toggle.collapsed .sidebar-sandbox-icon { transform: rotate(-90deg); }
    .sidebar-sandbox-label { font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
    .sidebar-sandbox-badge {
      font-size: 9px; margin-left: auto; padding: 1px 6px;
      border-radius: 999px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      color: var(--vscode-descriptionForeground);
    }
    .sidebar-sandbox-badge.running { border-color: rgba(76,175,80,0.5); color: #4caf50; background: rgba(76,175,80,0.1); }
    .sidebar-sandbox-badge.starting { border-color: rgba(204,167,0,0.5); color: #cca700; background: rgba(204,167,0,0.1); }
    .sidebar-sandbox-body { padding: 6px 0; }
    .sidebar-sandbox-body.collapsed { display: none; }
    .sidebar-sandbox-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; flex-wrap: wrap; }
    .sidebar-sandbox-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(128,128,128,0.4); flex-shrink: 0; }
    .sidebar-sandbox-dot.running { background: #4caf50; }
    .sidebar-sandbox-dot.starting { background: #cca700; animation: sbPulse 1.2s ease-in-out infinite; }
    .sidebar-sandbox-dot.error { background: #f44747; }
    @keyframes sbPulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    .sidebar-sandbox-status { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .sidebar-sandbox-framework { font-size: 10px; font-weight: 600; }
    .sidebar-sandbox-url {
      font-size: 10px; color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none; cursor: pointer;
    }
    .sidebar-sandbox-url:hover { text-decoration: underline; }
    .sidebar-sandbox-actions { display: flex; gap: 4px; padding: 4px 0; }
    .sb-btn {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      background: transparent; color: var(--vscode-descriptionForeground);
      border-radius: 999px; padding: 2px 8px; font-size: 9px;
      cursor: pointer; text-transform: uppercase;
    }
    .sb-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
    .sb-btn.primary {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .sb-btn.primary:hover { background: var(--vscode-button-hoverBackground); }

    .thread-chip {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 10px;
      cursor: pointer;
      white-space: nowrap;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .thread-chip.active {
      border-color: var(--vscode-focusBorder);
      color: var(--vscode-foreground);
      background: rgba(0,122,204,0.1);
    }
    .chat-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 2px 2px 6px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.14));
    }
    .chat-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: none;
      letter-spacing: 0.2px;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chat-feed { display: flex; flex-direction: column; gap: 0; padding: 0; }
    .msg {
      width: 100%; display: flex; flex-direction: column; gap: 0;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08));
    }
    .msg:last-child { border-bottom: none; }
    .msg.user { background: rgba(0,122,204,0.04); }
    .msg-header {
      display: flex; align-items: center; gap: 6px;
      color: var(--vscode-descriptionForeground); font-size: 11px;
      margin-bottom: 5px;
    }
    .msg-avatar {
      width: 15px; height: 15px; flex-shrink: 0; fill: currentColor; display: block; opacity: 0.65;
    }
    .msg-author { font-weight: 600; font-size: 11px; color: var(--vscode-foreground); }
    .msg-status-icon {
      width: 13px; height: 13px; fill: none; stroke: currentColor;
      stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
      flex-shrink: 0; display: block;
    }
    .msg-status-icon.completed { color: #4caf50; }
    .msg-status-icon.failed { color: #f44747; }
    .msg-status-icon.blocked { color: #cca700; }
    .msg-status-icon.running { color: #4caf50; }
    .msg-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: auto; }
    .msg-type-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .msg-type-dot.answer { background: #4fa3ff; }
    .msg-type-dot.code-change { background: #3ebf6a; }
    .msg-type-dot.run-status { background: #cca700; }
    .msg-text {
      font-size: 12px; line-height: 1.5; padding: 0 0 0 21px;
      word-break: break-word; color: var(--vscode-foreground);
    }
    .msg-text pre {
      overflow-x: auto;
      background: rgba(0,0,0,0.18);
      padding: 8px;
      border-radius: 6px;
      margin: 6px 0;
    }
    .msg-text code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .msg-collapse {
      margin-top: 6px;
      border: none;
      background: transparent;
      color: var(--vscode-focusBorder);
      font-size: 11px;
      cursor: pointer;
      padding: 0;
      text-align: left;
    }
    .msg-actions {
      margin-top: 4px;
      display: inline-flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .msg-action-btn {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 9px;
      cursor: pointer;
    }
    .msg-action-btn:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: rgba(0,122,204,0.12);
    }
    .msg-actions-more {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .msg-more-panel {
      display: none;
      position: absolute;
      top: 20px;
      left: 0;
      z-index: 20;
      min-width: 160px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      padding: 4px;
      flex-direction: column;
      gap: 4px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.25);
    }
    .msg-more-panel.open { display: inline-flex; }
    .msg-more-item {
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 6px;
      padding: 3px 6px;
      font-size: 10px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    .msg-more-item:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: rgba(0,122,204,0.12);
    }
    .running-inline {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .running-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4caf50;
      animation: pulse-dot 1.1s ease-in-out infinite;
      opacity: 0.65;
    }
    @keyframes pulse-dot {
      0% { opacity: 0.35; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.15); }
      100% { opacity: 0.35; transform: scale(0.9); }
    }
    .result-card {
      margin-top: 4px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 8px;
      padding: 4px 7px;
      background: rgba(128,128,128,0.04);
      display: inline-flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .result-pill {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 999px;
      padding: 1px 6px;
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 0.25px;
    }
    .result-pill.completed { color: #4caf50; border-color: rgba(76,175,80,0.5); }
    .result-pill.failed { color: #f44747; border-color: rgba(244,71,71,0.5); }
    .result-pill.blocked { color: #cca700; border-color: rgba(204,167,0,0.5); }
    .result-sep { opacity: 0.7; }
    .result-strong {
      color: var(--vscode-foreground);
      font-weight: 600;
    }

    .composer {
      flex-shrink: 0;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--vscode-editorWidget-background, transparent);
    }
    .context-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 16px;
      flex-wrap: nowrap;
      overflow: hidden;
      white-space: nowrap;
    }
    .ctx-chip {
      border: none;
      padding: 0;
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .input-wrap {
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-input-background);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .input-wrap:focus-within { border-color: var(--vscode-focusBorder); }
    .input-wrap.drag-over { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.07)); }
    .textarea-row { display: flex; align-items: flex-end; }
    .image-preview-bar { display: none; padding: 6px 8px 0; gap: 6px; flex-wrap: wrap; }
    .image-preview-bar.visible { display: flex; }
    .image-preview-item { position: relative; }
    .image-preview-thumb {
      width: 52px; height: 52px; object-fit: cover;
      border-radius: 4px; border: 1px solid var(--vscode-panel-border); display: block;
    }
    .image-remove-btn {
      position: absolute; top: -4px; right: -4px;
      width: 15px; height: 15px; border-radius: 50%; border: none;
      background: var(--vscode-errorForeground, #c44); color: #fff;
      font-size: 10px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center; padding: 0;
    }
    textarea {
      flex: 1;
      min-height: 52px;
      max-height: 160px;
      resize: none;
      border: none;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      line-height: 1.45;
      padding: 8px 10px;
      overflow-y: auto;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    textarea:disabled { opacity: 0.6; cursor: not-allowed; }
    .send {
      width: 26px;
      height: 26px;
      margin: 0 6px 6px 0;
      border: none;
      border-radius: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 11px;
      line-height: 1;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .send:disabled { opacity: 0.45; cursor: not-allowed; }
    .composer-meta {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 4px 2px; min-height: 26px;
    }
    .composer-meta-btn {
      height: 22px; min-width: 22px; padding: 0 6px; border: none; border-radius: 4px;
      background: transparent; color: var(--vscode-descriptionForeground);
      font-size: 11px; font-family: var(--vscode-font-family);
      cursor: pointer; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
    }
    .composer-meta-btn:hover:not(:disabled) { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .composer-meta-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .composer-meta-btn svg { width: 12px; height: 12px; fill: currentColor; flex-shrink: 0; }
    .composer-meta-sep { width: 1px; height: 14px; background: var(--vscode-panel-border, rgba(128,128,128,0.3)); margin: 0 2px; flex-shrink: 0; }
    .meta-grow { flex: 1; min-width: 0; }
    select {
      height: 22px; padding: 0 6px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      font-size: 11px; font-family: var(--vscode-font-family); max-width: 130px;
    }
    select:disabled { opacity: 0.6; cursor: not-allowed; }
    /* context bar → compact icon chips */
    .context-bar { display: flex; align-items: center; gap: 4px; padding: 3px 8px 0; flex-wrap: wrap; }
    .ctx-chip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; color: var(--vscode-descriptionForeground);
      padding: 1px 6px; border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;
    }
    .ctx-chip svg { width: 10px; height: 10px; fill: currentColor; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="tabs">
      <button class="tab active" data-tab="chat" type="button" title="Chat">
        <svg class="tab-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M1 3c0-.6.4-1 1-1h12c.6 0 1 .4 1 1v8c0 .6-.4 1-1 1H9l-2 2-2-2H2c-.6 0-1-.4-1-1V3z"/></svg>
        Chat
      </button>
      <button class="tab" data-tab="plan" type="button" title="Plan">
        <svg class="tab-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M3 4h1v1H3V4zm3 0h7v1H6V4zm-3 4h1v1H3V8zm3 0h7v1H6V8zm-3 4h1v1H3v-1zm3 0h7v1H6v-1z"/></svg>
        Plan
      </button>
      <button class="tab" data-tab="history" type="button" title="History">
        <svg class="tab-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm0 1a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 2v3.75l2.75 1.5-.5.87L7 9.5V5h.5z"/></svg>
        History
      </button>
    </div>
    <div class="topbar-actions">
      <div class="topbar-divider"></div>
      <button class="topbar-btn" id="newChatBtn" title="New Chat" aria-label="New Chat">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1v6H2v1h6v6h1V8h6V7H9V1H8z"/></svg>
      </button>
      <button class="topbar-btn" id="dashboardBtn" title="Show Dashboard" aria-label="Show Dashboard">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h5v5H2V2zm7 0h5v5H9V2zm-7 7h5v5H2V9zm7 0h5v5H9V9z"/></svg>
      </button>
      <button class="topbar-btn" id="settingsBtn" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 8A1.4 1.4 0 1 1 6.6 8 1.4 1.4 0 0 1 9.4 8z"/></svg>
      </button>
    </div>
  </div>

  <div class="content">
    <div id="chatScreen" class="chat-screen active">
      <div class="chat-header">
        <div id="chatTitle" class="chat-title">NEW CHAT</div>
      </div>
      <div id="chatFeed" class="chat-feed"></div>
      <div id="chatEmpty" class="item-tip" style="display:none">
        <strong>New conversation</strong> — type a prompt below to start.<br>
        Use the <strong>Plan</strong> tab to queue tasks or <strong>History</strong> to revisit past runs.
      </div>
    </div>
    <div id="planTools" class="plan-tools">
      <div class="plan-tools-row">
        <div class="plan-tools-left">
          <span id="planActiveName" class="plan-active-name">Plan: Ad hoc</span>
          <span id="planExecCounter" class="plan-exec-counter">Executed 0/0</span>
          <span id="planRunnerBadge" class="plan-runner-badge">IDLE</span>
        </div>
        <div class="plan-tools-right">
          <div class="plan-tool-group">
            <button id="planPlayBtn" class="plan-tool-btn" type="button" title="Play Plan" aria-label="Play Plan">Play</button>
            <button id="planRunPendingBtn" class="plan-tool-btn" type="button" title="Run Pending" aria-label="Run Pending">Run</button>
            <button id="planSearchBtn" class="plan-tool-btn" type="button" title="Search Tasks" aria-label="Search Tasks">Search</button>
            <button id="planSwitchQuickBtn" class="plan-tool-btn" type="button" title="Switch Plan" aria-label="Switch Plan">Switch</button>
          </div>
          <div class="plan-tool-group">
            <div class="plan-manage-wrap">
              <button id="planManageBtn" class="plan-tool-btn" type="button" title="More Actions" aria-label="More Actions">More</button>
              <div id="planManageMenu" class="plan-manage-menu">
                <button id="planStopBtn" class="plan-menu-item" type="button">Stop</button>
                <button id="planRunSelectedBtn" class="plan-menu-item" type="button">Run Selected</button>
                <button id="planAddTaskBtn" class="plan-menu-item" type="button">Add Task</button>
                <button id="planSwitchBtn" class="plan-menu-item" type="button">Switch Plan</button>
                <button id="planNewBtn" class="plan-menu-item" type="button">New Plan</button>
              </div>
            </div>
          </div>
          <div class="plan-tool-group filter-right">
            <div class="plan-filter-wrap">
              <button id="planFilterBtn" class="plan-tool-btn icon-only" type="button" title="Filters" aria-label="Filters">⚙</button>
              <div id="planFilterMenu" class="plan-filter-menu">
                <div id="planFilterChips" class="plan-filter">
                  <span class="plan-filter-label">Status</span>
                  <button type="button" class="chip active" data-plan-filter="all">All</button>
                  <button type="button" class="chip" data-plan-filter="pending">Pending</button>
                  <button type="button" class="chip" data-plan-filter="completed">Completed</button>
                  <button type="button" class="chip" data-plan-filter="failed">Failed</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="planSearchBar" class="plan-search-bar">
        <input id="planSearchInput" class="plan-search-input" type="text" placeholder="Search tasks or playlists">
        <button id="planSearchClearBtn" class="plan-tool-btn" type="button" title="Clear Search" aria-label="Clear Search">Clear</button>
      </div>
    </div>
    <div id="planOverview" class="plan-overview">
      <div id="planOverviewTitle" class="plan-overview-title">Optimization Plan Progress</div>
      <div id="planOverviewMeta" class="plan-overview-meta">0/0 playlists, 0/0 tasks completed</div>
      <div class="plan-overview-bar"><div id="planOverviewFill" class="plan-overview-fill"></div></div>
      <div id="planOverviewRunning" class="plan-overview-running"><span class="dot"></span><span id="planOverviewRunningText" class="text"></span></div>
    </div>
    <div id="planQueue" class="plan-queue">
      <div class="plan-queue-head">
        <span class="plan-queue-title">Queue</span>
        <span id="planQueueMeta" class="plan-queue-meta">0 tasks pending</span>
      </div>
      <div class="plan-queue-next">
        <span id="planQueueNextTask" class="plan-queue-next-task">Next: -</span>
        <span id="planQueueDots" class="plan-queue-dots"></span>
      </div>
    </div>
    <div id="planListHeading" class="plan-list-heading"><input id="planListSelectModeCb" type="checkbox" aria-label="Enable selection mode"><span>All Tasks</span><button id="planHeadingCollapseBtn" class="plan-tool-btn" type="button" title="Collapse All" aria-label="Collapse All">Collapse All</button></div>
    <div id="planList" class="list"></div>

    <!-- Sidebar Sandbox -->
    <div id="sidebarSandbox" class="sidebar-sandbox">
      <button class="sidebar-sandbox-toggle collapsed" id="sbToggle" type="button">
        <span class="sidebar-sandbox-icon">&#x25BC;</span>
        <span class="sidebar-sandbox-label">Sandbox</span>
        <span class="sidebar-sandbox-badge" id="sbBadge"></span>
      </button>
      <div class="sidebar-sandbox-body collapsed" id="sbBody">
        <div class="sidebar-sandbox-row">
          <span class="sidebar-sandbox-dot" id="sbDot"></span>
          <span class="sidebar-sandbox-status" id="sbStatus">Not started</span>
          <span class="sidebar-sandbox-framework" id="sbFramework"></span>
        </div>
        <div class="sidebar-sandbox-row">
          <a class="sidebar-sandbox-url" id="sbUrl" style="display:none;"></a>
        </div>
        <div class="sidebar-sandbox-actions">
          <button class="sb-btn primary" id="sbLaunch" type="button">Launch</button>
          <button class="sb-btn" id="sbStop" type="button" style="display:none;">Stop</button>
          <button class="sb-btn" id="sbScreenshot" type="button">Screenshot</button>
        </div>
      </div>
    </div>

    <div id="historyTools" class="history-tools">
      <span class="tool-label">View</span>
      <select id="historyViewMode" class="tool-select">
        <option value="default">Default</option>
        <option value="executed">Executed</option>
      </select>
      <span class="tool-label">Group</span>
      <select id="historyGroupBy" class="tool-select">
        <option value="none">None</option>
        <option value="plan">Plan</option>
        <option value="playlist">Playlist</option>
      </select>
      <span class="tool-label">Status</span>
      <div class="chip-row" id="historyStatusChips">
        <button type="button" class="chip active" data-status="all">All</button>
        <button type="button" class="chip" data-status="completed">Completed</button>
        <button type="button" class="chip" data-status="failed">Failed</button>
      </div>
    </div>
    <div id="historyList" class="list"></div>
    <div id="listEmpty" class="empty"></div>
  </div>

  <div class="composer">
    <div id="contextBar" class="context-bar">
      <span id="ctxPlan" class="ctx-chip">
        <svg viewBox="0 0 16 16"><path d="M3 3h10v1H3V3zm0 4h10v1H3V7zm0 4h7v1H3v-1z"/></svg>
        Ad hoc
      </span>
      <span id="ctxRunner" class="ctx-chip">
        <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
        IDLE
      </span>
    </div>
    <div class="input-wrap" id="inputWrap">
      <div id="imagePreviewBar" class="image-preview-bar">
        <div class="image-preview-item">
          <img id="imagePreviewThumb" class="image-preview-thumb" alt="Attached image" />
          <button id="imageRemoveBtn" class="image-remove-btn" type="button" title="Remove image">&#x2715;</button>
        </div>
      </div>
      <div class="textarea-row">
        <textarea id="prompt" placeholder="Describe what to build" rows="2"></textarea>
        <button id="send" class="send" type="button" title="Run (Ctrl+Enter)"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2.5 2L14 8l-11.5 6V9.5L9 8 2.5 6.5V2z"/></svg></button>
      </div>
    </div>
    <div class="composer-meta">
      <button class="composer-meta-btn" id="attachBtn" type="button" title="Attach file or image">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5.5l-6.4 6.4a3.2 3.2 0 01-4.5-4.5L9.5 1a2.1 2.1 0 013 3L6.1 10.4a1.1 1.1 0 01-1.5-1.5L10 3.5"/></svg>
      </button>
      <div class="composer-meta-sep"></div>
      <select id="engine"></select>
      <span class="meta-grow"></span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById('prompt');
    const sendEl = document.getElementById('send');
    const engineEl = document.getElementById('engine');
    const attachBtnEl = document.getElementById('attachBtn');
    const dashboardBtnEl = document.getElementById('dashboardBtn');
    const settingsBtnEl = document.getElementById('settingsBtn');
    const newChatBtnEl = document.getElementById('newChatBtn');
    const inputWrapEl = document.getElementById('inputWrap');
    const imagePreviewBarEl = document.getElementById('imagePreviewBar');
    const imagePreviewThumbEl = document.getElementById('imagePreviewThumb');
    const imageRemoveBtnEl = document.getElementById('imageRemoveBtn');
    let attachedImage = null;
    const tabEls = Array.from(document.querySelectorAll('.tab'));
    const chatScreenEl = document.getElementById('chatScreen');
    const chatTitleEl = document.getElementById('chatTitle');
    const chatFeedEl = document.getElementById('chatFeed');
    const chatEmptyEl = document.getElementById('chatEmpty');
    const planToolsEl = document.getElementById('planTools');
    const planActiveNameEl = document.getElementById('planActiveName');
    const planExecCounterEl = document.getElementById('planExecCounter');
    const planRunnerBadgeEl = document.getElementById('planRunnerBadge');
    const planFilterBtnEl = document.getElementById('planFilterBtn');
    const planFilterMenuEl = document.getElementById('planFilterMenu');
    const planSelectModeCbEl = document.getElementById('planSelectModeCb');
    const planFilterChipsEl = document.getElementById('planFilterChips');
    const planRunSelectedBtnEl = document.getElementById('planRunSelectedBtn');
    const planRunPendingBtnEl = document.getElementById('planRunPendingBtn');
    const planSearchBtnEl = document.getElementById('planSearchBtn');
    const planSearchBarEl = document.getElementById('planSearchBar');
    const planSearchInputEl = document.getElementById('planSearchInput');
    const planSearchClearBtnEl = document.getElementById('planSearchClearBtn');
    const planSwitchQuickBtnEl = document.getElementById('planSwitchQuickBtn');
    const planStopBtnEl = document.getElementById('planStopBtn');
    const planManageBtnEl = document.getElementById('planManageBtn');
    const planManageMenuEl = document.getElementById('planManageMenu');
    const planPlayBtnEl = document.getElementById('planPlayBtn');
    const planAddTaskBtnEl = document.getElementById('planAddTaskBtn');
    const planNewBtnEl = document.getElementById('planNewBtn');
    const planToggleTasksBtnEl = document.getElementById('planToggleTasksBtn');
    const planToggleExpandBtnEl = document.getElementById('planToggleExpandBtn');
    const planSwitchBtnEl = document.getElementById('planSwitchBtn');
    const planOverviewEl = document.getElementById('planOverview');
    const planOverviewTitleEl = document.getElementById('planOverviewTitle');
    const planOverviewMetaEl = document.getElementById('planOverviewMeta');
    const planOverviewFillEl = document.getElementById('planOverviewFill');
    const planOverviewRunningEl = document.getElementById('planOverviewRunning');
    const planOverviewRunningTextEl = document.getElementById('planOverviewRunningText');
    const planQueueEl = document.getElementById('planQueue');
    const planQueueMetaEl = document.getElementById('planQueueMeta');
    const planQueueNextTaskEl = document.getElementById('planQueueNextTask');
    const planQueueDotsEl = document.getElementById('planQueueDots');
    const planListHeadingEl = document.getElementById('planListHeading');
    const planListSelectModeCbEl = document.getElementById('planListSelectModeCb');
    const planHeadingCollapseBtnEl = document.getElementById('planHeadingCollapseBtn');
    const planListEl = document.getElementById('planList');
    const historyToolsEl = document.getElementById('historyTools');
    const historyViewModeEl = document.getElementById('historyViewMode');
    const historyGroupByEl = document.getElementById('historyGroupBy');
    const historyStatusChipsEl = document.getElementById('historyStatusChips');
    const historyListEl = document.getElementById('historyList');
    const listEmptyEl = document.getElementById('listEmpty');
    const ctxPlanEl = document.getElementById('ctxPlan');
    const ctxRunnerEl = document.getElementById('ctxRunner');
    let busy = false;
    let activeTab = 'chat';
    let chatItems = [];
    let planItems = [];
    let planGroups = [];
    let historyItems = [];
    let activeThreadId = '';
    let chatMessages = [];
    let runnerState = 'idle';
    let historyViewMode = 'default';
    let historyGroupBy = 'none';
    let historyStatusFilter = 'all';
    let collapsedHistoryGroups = {};
    let collapsedPlanGroups = {};
    let planTasksVisible = true;
    let planFilterMode = 'all';
    let planSearchQuery = '';
    let selectionMode = false;
    let selectedPlaylists = {};
    let selectedTasks = {};
    let activePlanName = '';
    let activePlaylistName = '';
    let actionMenuHandlersBound = false;
    const ICON_COLLAPSED = '\u25B6';
    const ICON_EXPANDED = '\u25BC';
    const ICON_COMPLETED = '\u2713';
    const ICON_RUNNING = '\u25B6';
    const ICON_FAILED = '\u2715';
    const ICON_BLOCKED = '!';
    const ICON_SKIPPED = '\u21BB';
    const ICON_PENDING = '\u25CB';
    const ICON_PLAY = '\u23F5';
    const ICON_PAUSE = '\u23F8';
    const ICON_RUN_PENDING = '\u25F7';
    const ICON_STOP = '\u23F9';
    const ICON_MENU = '\u22EF';
    const ICON_FILTER = '\u25BE';
    const ICON_LAYOUT = '\u21F5';
    const ICON_ARROW_RIGHT = '\u2192';
    const ICON_DOT = '\u2022';

    function autoResize() {
      promptEl.style.height = 'auto';
      promptEl.style.height = Math.min(Math.max(promptEl.scrollHeight, 52), 160) + 'px';
    }

    function updateActionState() {
      sendEl.disabled = busy || !promptEl.value.trim();
    }

    function renderEngines(engines, selectedEngineId) {
      engineEl.textContent = '';
      if (!engines || engines.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No engines';
        engineEl.appendChild(option);
        engineEl.disabled = true;
        return;
      }

      const fallbackId = engines[0].id;
      const nextSelected = engines.some((engine) => engine.id === selectedEngineId) ? selectedEngineId : fallbackId;
      for (const engine of engines) {
        const option = document.createElement('option');
        option.value = engine.id;
        option.textContent = engine.label;
        option.selected = engine.id === nextSelected;
        engineEl.appendChild(option);
      }
      engineEl.disabled = busy;
      renderContextBar();
    }

    function itemDotClass(item, index) {
      const s = String(item.status || '').toLowerCase();
      if (s === 'running') { return 'active'; }
      if (s === 'failed') { return 'failed'; }
      return index < 3 ? 'recent' : '';
    }

    function renderItemList(targetEl, items) {
      targetEl.textContent = '';
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'item';
        const dc = itemDotClass(item, i);
        btn.innerHTML =
          '<span class="item-title"><span class="item-dot' + (dc ? ' ' + dc : '') + '"></span>' + escHtml(item.title || 'Untitled') + '</span>' +
          (item.subtitle ? '<span class="item-meta">' + escHtml(item.subtitle) + '</span>' : '');
        btn.addEventListener('click', () => {
          if (item.id) {
            vscode.postMessage({ type: 'openItem', id: item.id, kind: item.kind || 'thread' });
          }
        });
        targetEl.appendChild(btn);
      }
    }

    function buildHistoryGroups(items) {
      const groups = new Map();
      for (const item of items) {
        let key = 'All History';
        if (historyGroupBy === 'plan') {
          key = item.planName || 'Unplanned';
        } else if (historyGroupBy === 'playlist') {
          key = item.playlistName || 'Unassigned playlist';
        }
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(item);
      }
      return groups;
    }

    function normalizeStatus(item) {
      return String(item.status || '').toLowerCase();
    }

    function isPendingLikeStatus(status) {
      return status === '' || status === 'pending' || status === 'queued' || status === 'todo';
    }

    function isExecutedHistory(item) {
      const status = normalizeStatus(item);
      if (!status) {
        return true;
      }
      return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'skipped';
    }

    function statusMatchesFilter(item) {
      const status = normalizeStatus(item);
      if (historyStatusFilter === 'all') {
        return true;
      }
      if (historyStatusFilter === 'completed') {
        return status === 'completed';
      }
      if (historyStatusFilter === 'failed') {
        return status === 'failed' || status === 'blocked';
      }
      return true;
    }

    function renderHistoryList() {
      historyListEl.textContent = '';
      const base = Array.isArray(historyItems) ? historyItems : [];
      const byView = historyViewMode === 'executed' ? base.filter(isExecutedHistory) : base;
      const filtered = byView.filter(statusMatchesFilter);
      const groups = buildHistoryGroups(filtered);

      groups.forEach((items, label) => {
        if (historyGroupBy !== 'none') {
          const head = document.createElement('button');
          const collapsed = !!collapsedHistoryGroups[label];
          const groupKind = historyGroupBy === 'plan' ? 'plan' : historyGroupBy === 'playlist' ? 'playlist' : '';
          head.className = 'group-head' + (groupKind ? (' ' + groupKind) : '');
          head.type = 'button';
          const badge = historyGroupBy === 'plan' ? 'Plan' : 'Playlist';
          head.innerHTML =
            '<span class="group-head-label">' + escHtml(badge) + '</span>' +
            escHtml((collapsed ? (ICON_COLLAPSED + ' ') : (ICON_EXPANDED + ' ')) + label + ' (' + items.length + ')');
          head.addEventListener('click', () => {
            collapsedHistoryGroups[label] = !collapsedHistoryGroups[label];
            renderHistoryList();
          });
          historyListEl.appendChild(head);
          if (collapsed) {
            return;
          }
        }
        for (let hi = 0; hi < items.length; hi++) {
          const item = items[hi];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'item';
          const dc = itemDotClass(item, hi);
          btn.innerHTML =
            '<span class="item-title"><span class="item-dot' + (dc ? ' ' + dc : '') + '"></span>' + escHtml(item.title || 'Untitled') + '</span>' +
            (item.subtitle ? '<span class="item-meta">' + escHtml(item.subtitle) + '</span>' : '');
          btn.addEventListener('click', () => {
            if (item.id) {
              vscode.postMessage({ type: 'openItem', id: item.id, kind: item.kind || 'history' });
            }
          });
          historyListEl.appendChild(btn);
        }
      });

      if (activeTab === 'history') {
        listEmptyEl.textContent = 'No history entries yet.';
        listEmptyEl.classList.toggle('active', filtered.length === 0);
      }
    }

    function renderPlanGroups(targetEl, groups) {
      targetEl.textContent = '';
      targetEl.classList.toggle('plan-selection-mode', selectionMode);
      const list = Array.isArray(groups) ? groups : [];
      let renderedAny = false;
      for (let i = 0; i < list.length; i++) {
        const group = list[i];
        const groupKey = group.id || ('playlist-' + i);
        const hasSavedCollapse = Object.prototype.hasOwnProperty.call(collapsedPlanGroups, groupKey);
        const defaultCollapsed = String(group.playlistStatus || '').toLowerCase() !== 'running';
        const activeQuery = planSearchQuery.trim();
        const collapsed = activeQuery
          ? false
          : (!planTasksVisible || (hasSavedCollapse ? !!collapsedPlanGroups[groupKey] : defaultCollapsed));
        const allTasks = Array.isArray(group.tasks) ? group.tasks : [];
        if (selectedPlaylists[groupKey]) {
          for (let ti = 0; ti < allTasks.length; ti++) {
            selectedTasks[groupKey + ':' + ti] = true;
          }
        }
        const tasks = allTasks.filter((task) => {
          const status = String(task.status || '').toLowerCase();
          const query = planSearchQuery.trim().toLowerCase();
          const taskName = String(task.name || '').toLowerCase();
          const groupName = String(group.name || '').toLowerCase();
          if (query && !taskName.includes(query) && !groupName.includes(query)) {
            return false;
          }
          if (planFilterMode === 'pending') {
            return status === '' || status === 'pending' || status === 'queued' || status === 'todo';
          }
          if (planFilterMode === 'completed') {
            return status === 'completed';
          }
          if (planFilterMode === 'failed') {
            return status === 'failed' || status === 'blocked';
          }
          return true;
        });
        if (tasks.length === 0) {
          continue;
        }
        const header = document.createElement('div');
        header.className = 'item';
        const row = document.createElement('div');
        row.className = 'plan-group-row';

        const select = document.createElement('input');
        select.type = 'checkbox';
        const checkedTaskCount = allTasks.filter((_t, ti) => !!selectedTasks[groupKey + ':' + ti]).length;
        const allTaskChecked = allTasks.length > 0 && checkedTaskCount === allTasks.length;
        const anyTaskChecked = checkedTaskCount > 0;
        const playlistChecked = !!selectedPlaylists[groupKey] || allTaskChecked;
        select.checked = playlistChecked;
        select.indeterminate = !playlistChecked && anyTaskChecked;
        select.addEventListener('change', () => {
          selectedPlaylists[groupKey] = select.checked;
          const tasks = Array.isArray(group.tasks) ? group.tasks : [];
          for (let ti = 0; ti < tasks.length; ti++) {
            const taskKey = groupKey + ':' + ti;
            selectedTasks[taskKey] = select.checked;
          }
          renderPlanTools();
          renderPlanGroups(targetEl, list);
        });

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'plan-group-toggle';

        const groupStatus = String(group.playlistStatus || 'pending').toLowerCase();
        if (groupStatus === 'running') {
          header.classList.add('running-item');
        }
        const groupIcon = groupStatus === 'completed'
          ? ICON_COMPLETED
          : groupStatus === 'running'
            ? ICON_RUNNING
            : groupStatus === 'failed'
              ? ICON_FAILED
              : groupStatus === 'blocked'
                ? ICON_BLOCKED
                : groupStatus === 'skipped'
                  ? ICON_SKIPPED
                  : ICON_PENDING;
        const groupLabel = (collapsed ? (ICON_COLLAPSED + ' ') : (ICON_EXPANDED + ' ')) + (group.name || 'Playlist');
        const pendingCount = allTasks.filter((t) => {
          const s = String(t.status || '').toLowerCase();
          return isPendingLikeStatus(s);
        }).length;
        const groupSubLabel = groupStatus === 'running'
          ? 'RUNNING now'
          : ('pending ' + pendingCount + '/' + (group.progress?.total ?? 0));
        toggle.innerHTML =
          '<span class="item-title">' +
            '<span class="state-icon ' + escHtml(groupStatus) + '">' + escHtml(groupIcon) + '</span>' +
            escHtml(groupLabel) +
          '</span>' +
          '<span class="item-subtitle">' + escHtml(groupSubLabel) + '</span>' +
          (groupStatus === 'running' ? '<span class="run-badge">Running</span>' : '');
        toggle.addEventListener('click', () => {
          collapsedPlanGroups[groupKey] = !collapsedPlanGroups[groupKey];
          renderPlanGroups(targetEl, list);
        });
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'plan-group-play';
        play.textContent = groupStatus === 'running' ? 'Pause' : 'Play';
        if (groupStatus === 'running') {
          play.classList.add('running');
        }
        play.addEventListener('click', () => {
          if (groupStatus === 'running') {
            vscode.postMessage({ type: 'pauseRun' });
          } else {
            vscode.postMessage({ type: 'playPlaylist', playlistIndex: i });
          }
        });

        row.appendChild(select);
        row.appendChild(toggle);
        row.appendChild(play);
        header.appendChild(row);
        targetEl.appendChild(header);
        renderedAny = true;
        if (collapsed) {
          continue;
        }

        for (let ti = 0; ti < tasks.length; ti++) {
          const task = tasks[ti];
          const originalIndex = allTasks.indexOf(task);
          const taskKey = groupKey + ':' + originalIndex;
          const taskBtn = document.createElement('button');
          taskBtn.type = 'button';
          taskBtn.className = 'item';
          taskBtn.style.paddingLeft = '20px';
          const status = String(task.status || 'pending').toLowerCase();
          const failureReason = (status === 'failed' || status === 'blocked')
            ? String(task.failureReason || '').trim()
            : '';
          const statusLabel = status === 'running'
            ? 'RUNNING'
            : (task.status || 'pending');
          if (status === 'running') {
            taskBtn.classList.add('running-item');
          }
          const taskIcon = status === 'completed'
            ? ICON_COMPLETED
            : status === 'running'
              ? ICON_RUNNING
              : status === 'failed'
                ? ICON_FAILED
                : status === 'blocked'
                  ? ICON_BLOCKED
                  : status === 'skipped'
                    ? ICON_SKIPPED
                    : ICON_PENDING;
          const isFailedLike = status === 'failed' || status === 'blocked';
          const actionButtons = isFailedLike
            ? '<button type="button" class="task-act-btn task-retry">Retry</button>' +
              '<button type="button" class="task-act-btn task-fix">Fix</button>'
            : '<button type="button" class="task-act-btn task-toggle">' + escHtml(status === 'running' ? 'Pause' : 'Play') + '</button>';
          taskBtn.innerHTML =
            '<div class="task-row">' +
              '<input type="checkbox" class="task-check"' + (selectedTasks[taskKey] ? ' checked' : '') + '>' +
              '<button type="button" class="task-main">' +
                '<span class="item-title"><span class="item-dot"></span>' + escHtml(task.name || 'Untitled task') + '</span>' +
                '<span class="item-subtitle">' + escHtml(statusLabel) + '</span>' +
                (failureReason ? '<span class="item-subtitle error" title="' + escHtml(failureReason) + '">' + escHtml(failureReason) + '</span>' : '') +
                (status === 'running' ? '<span class="run-badge">Running</span>' : '') +
              '</button>' +
              '<span class="task-actions' + (status === 'running' || isFailedLike ? ' always-visible' : '') + '">' +
                actionButtons +
              '</span>' +
            '</div>';
          const baseTaskTitle = '<span class="item-title"><span class="item-dot"></span>' + escHtml(task.name || 'Untitled task') + '</span>';
          const richTaskTitle =
            '<span class="item-title">' +
              '<span class="state-icon ' + escHtml(status) + '">' + escHtml(taskIcon) + '</span>' +
              '<span class="' + (status === 'completed' ? 'task-title-completed' : '') + '">' + escHtml(task.name || 'Untitled task') + '</span>' +
            '</span>';
          taskBtn.innerHTML = taskBtn.innerHTML.replace(baseTaskTitle, richTaskTitle);
          const mainBtn = taskBtn.querySelector('.task-main');
          mainBtn?.addEventListener('click', () => {
            if (task.id) {
              vscode.postMessage({ type: 'openItem', id: task.id, kind: 'plan' });
            }
          });
          const check = taskBtn.querySelector('.task-check');
          check?.addEventListener('click', (event) => event.stopPropagation());
          check?.addEventListener('change', () => {
            const checked = !!check.checked;
            selectedTasks[taskKey] = checked;
            const allTaskKeys = allTasks.map((_t, idx) => groupKey + ':' + idx);
            const allChecked = allTaskKeys.length > 0 && allTaskKeys.every((k) => !!selectedTasks[k]);
            selectedPlaylists[groupKey] = allChecked;
            renderPlanTools();
            renderPlanGroups(targetEl, list);
          });
          const toggleBtn = taskBtn.querySelector('.task-toggle');
          toggleBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            if (status === 'running') {
              vscode.postMessage({ type: 'pauseRun' });
            } else {
              vscode.postMessage({ type: 'playTask', playlistIndex: i, taskIndex: originalIndex });
            }
          });
          if (status === 'running' && toggleBtn) {
            toggleBtn.classList.add('running');
          }
          const retryBtn = taskBtn.querySelector('.task-retry');
          retryBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'retryTask', playlistIndex: i, taskIndex: originalIndex });
          });
          const fixBtn = taskBtn.querySelector('.task-fix');
          fixBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'retryTaskWithNote', playlistIndex: i, taskIndex: originalIndex });
          });
          targetEl.appendChild(taskBtn);
        }
      }
      if (!renderedAny) {
        const empty = document.createElement('div');
        empty.className = 'empty active';
        empty.textContent = planSearchQuery
          ? 'No tasks match this search.'
          : 'No tasks to display.';
        targetEl.appendChild(empty);
      }
    }

    function renderPlanOverview(groups) {
      const list = Array.isArray(groups) ? groups : [];
      if (list.length === 0) {
        planOverviewEl.classList.remove('active');
        planOverviewRunningEl.classList.remove('active');
        planOverviewRunningTextEl.textContent = '';
        return;
      }
      const playlistTotal = list.length;
      const playlistDone = list.filter((group) => String(group.playlistStatus || '').toLowerCase() === 'completed').length;
      const taskTotal = list.reduce((sum, group) => sum + (group.progress?.total || 0), 0);
      const taskDone = list.reduce((sum, group) => sum + (group.progress?.done || 0), 0);
      const pct = taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : 0;

      planOverviewTitleEl.textContent = 'Optimization Plan Progress';
      planOverviewMetaEl.textContent = playlistDone + '/' + playlistTotal + ' playlists, ' + taskDone + '/' + taskTotal + ' tasks processed';
      planOverviewFillEl.style.width = pct + '%';

      let runningPlaylistName = '';
      let runningTaskName = '';
      let queuedPlaylistName = '';
      let queuedTaskName = '';
      for (let i = 0; i < list.length; i++) {
        const group = list[i];
        const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
        const runningTask = tasks.find((task) => String(task?.status || '').toLowerCase() === 'running');
        if (runningTask) {
          runningPlaylistName = group?.name || ('Playlist ' + (i + 1));
          runningTaskName = runningTask?.name || 'Untitled task';
          break;
        }
        if (!runningPlaylistName && String(group?.playlistStatus || '').toLowerCase() === 'running') {
          runningPlaylistName = group?.name || ('Playlist ' + (i + 1));
        }
        if (!queuedTaskName) {
          const queuedTask = tasks.find((task) => {
            const s = String(task?.status || '').toLowerCase();
            return !s || s === 'pending' || s === 'queued' || s === 'todo';
          });
          if (queuedTask) {
            queuedPlaylistName = group?.name || ('Playlist ' + (i + 1));
            queuedTaskName = queuedTask?.name || 'Untitled task';
          }
        }
      }
      if (runningPlaylistName || runnerState === 'playing') {
        const runningLabel = runningTaskName
          ? ('Running: ' + runningPlaylistName + ' ' + ICON_ARROW_RIGHT + ' ' + runningTaskName)
          : queuedTaskName
            ? ('Queued next: ' + queuedPlaylistName + ' ' + ICON_ARROW_RIGHT + ' ' + queuedTaskName)
            : runningPlaylistName
              ? ('Running: ' + runningPlaylistName)
              : 'Running: preparing next task...';
        planOverviewRunningTextEl.textContent = runningLabel;
        planOverviewRunningEl.classList.add('active');
      } else {
        planOverviewRunningEl.classList.remove('active');
        planOverviewRunningTextEl.textContent = '';
      }
      planOverviewEl.classList.add('active');
    }

    function renderPlanQueue(groups) {
      const list = Array.isArray(groups) ? groups : [];
      const pending = [];
      for (let i = 0; i < list.length; i++) {
        const group = list[i];
        const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
        for (let ti = 0; ti < tasks.length; ti++) {
          const task = tasks[ti];
          const status = String(task?.status || '').toLowerCase();
          if (isPendingLikeStatus(status)) {
            pending.push({ groupName: group?.name || ('Playlist ' + (i + 1)), taskName: task?.name || 'Untitled task' });
          }
        }
      }

      if (pending.length === 0) {
        planQueueMetaEl.textContent = '0 tasks pending';
        planQueueNextTaskEl.textContent = 'Next: all tasks complete';
        planQueueDotsEl.textContent = '';
        planQueueEl.classList.remove('active');
        return;
      }

      planQueueMetaEl.textContent = pending.length + ' task' + (pending.length === 1 ? '' : 's') + ' pending';
      const next = pending[0];
      planQueueNextTaskEl.textContent = 'Next: ' + next.groupName + ' ' + ICON_ARROW_RIGHT + ' ' + next.taskName;
      planQueueDotsEl.textContent = '';
      const dotCount = Math.min(4, pending.length);
      for (let i = 0; i < dotCount; i++) {
        const dot = document.createElement('span');
        dot.className = 'plan-queue-dot' + (i === 0 ? ' active' : '');
        planQueueDotsEl.appendChild(dot);
      }
      planQueueEl.classList.add('active');
    }

    function renderPlanListHeading() {
      if (activeTab !== 'plan') {
        planListHeadingEl.classList.remove('active');
        return;
      }
      planListHeadingEl.classList.add('active');
    }

    function renderPlanTools() {
      const iconMarkup = (kind) => {
        if (kind === 'play') {
          return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5l7 4.5-7 4.5z"></path></svg>';
        }
        if (kind === 'pause') {
          return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9"></path><path d="M10.5 3.5v9"></path></svg>';
        }
        if (kind === 'pending') {
          return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v4.5l3 1.5"></path><path d="M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"></path></svg>';
        }
        if (kind === 'search') {
          return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 11.5l2 2"></path><path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"></path></svg>';
        }
        if (kind === 'switch') {
          return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h9"></path><path d="M10 3l2 2-2 2"></path><path d="M13 11H4"></path><path d="M6 9l-2 2 2 2"></path></svg>';
        }
        if (kind === 'menu') {
          return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1"></circle><circle cx="8" cy="8" r="1"></circle><circle cx="12" cy="8" r="1"></circle></svg>';
        }
        if (kind === 'filter') {
          return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11l-4.5 5v3l-2 1v-4l-4.5-5z"></path></svg>';
        }
        return '';
      };
      const setIconButton = (el, icon, label) => {
        el.textContent = icon;
        el.title = label;
        el.setAttribute('aria-label', label);
      };
      const label = activePlanName || 'Ad hoc';
      planActiveNameEl.textContent = 'Plan: ' + label;
      planPlayBtnEl.innerHTML = runnerState === 'playing' ? iconMarkup('pause') : iconMarkup('play');
      planPlayBtnEl.title = runnerState === 'playing' ? 'Pause Plan' : 'Play Plan';
      planPlayBtnEl.setAttribute('aria-label', planPlayBtnEl.title);
      planPlayBtnEl.classList.toggle('active', runnerState === 'playing');
      planRunPendingBtnEl.innerHTML = iconMarkup('pending');
      planRunPendingBtnEl.title = 'Run Pending';
      planRunPendingBtnEl.setAttribute('aria-label', 'Run Pending');
      planSearchBtnEl.innerHTML = iconMarkup('search');
      planSearchBtnEl.setAttribute('aria-label', 'Search tasks');
      planSwitchQuickBtnEl.innerHTML = iconMarkup('switch');
      planSwitchQuickBtnEl.title = 'Switch Plan';
      planSwitchQuickBtnEl.setAttribute('aria-label', 'Switch Plan');
      planManageBtnEl.innerHTML = iconMarkup('menu');
      planManageBtnEl.title = 'More Actions';
      planManageBtnEl.setAttribute('aria-label', 'More Actions');
      planFilterBtnEl.innerHTML = iconMarkup('filter');
      planFilterBtnEl.title = 'Filters';
      planFilterBtnEl.setAttribute('aria-label', 'Filters');
      const searchLabel = planSearchQuery ? ('Search: ' + planSearchQuery) : 'Search tasks';
      planSearchBtnEl.title = searchLabel;
      planSearchBtnEl.classList.toggle('active', !!planSearchQuery);
      planSearchBarEl.classList.toggle('active', !!planSearchQuery || planSearchInputEl === document.activeElement);
      if (planSearchInputEl.value !== planSearchQuery) {
        planSearchInputEl.value = planSearchQuery;
      }
      const keys = (planGroups || []).map((g, i) => g.id || ('playlist-' + i));
      const taskTotal = (planGroups || []).reduce((sum, group) => sum + ((group?.tasks || []).length), 0);
      const taskDone = (planGroups || []).reduce((sum, group) => {
        const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
        return sum + tasks.filter((t) => String(t?.status || '').toLowerCase() === 'completed').length;
      }, 0);
      planExecCounterEl.textContent = 'Executed ' + taskDone + '/' + taskTotal;
      const runnerLabel = runnerState === 'playing'
        ? 'RUNNING'
        : runnerState === 'paused'
          ? 'PAUSED'
          : runnerState === 'stopping'
            ? 'STOPPING'
            : 'IDLE';
      planRunnerBadgeEl.textContent = runnerLabel;
      planRunnerBadgeEl.classList.remove('running', 'paused', 'stopping');
      if (runnerState === 'playing') {
        planRunnerBadgeEl.classList.add('running');
      } else if (runnerState === 'paused') {
        planRunnerBadgeEl.classList.add('paused');
      } else if (runnerState === 'stopping') {
        planRunnerBadgeEl.classList.add('stopping');
      }
      const selectedCount = keys.filter((k) => !!selectedPlaylists[k]).length;
      const selectedTaskCount = Object.keys(selectedTasks).filter((k) => !!selectedTasks[k]).length;
      const selectedTotal = selectedCount + selectedTaskCount;
      const collapsedCount = keys.filter((k) => !!collapsedPlanGroups[k]).length;
      const collapseLabel = collapsedCount > 0 || !planTasksVisible ? 'Expand All' : 'Collapse All';
      planHeadingCollapseBtnEl.textContent = collapseLabel;
      planHeadingCollapseBtnEl.title = collapseLabel;
      planHeadingCollapseBtnEl.setAttribute('aria-label', collapseLabel);
      if (planSelectModeCbEl) {
        planSelectModeCbEl.checked = selectionMode;
        planSelectModeCbEl.title = selectionMode ? 'Selection mode enabled' : 'Selection mode disabled';
        planSelectModeCbEl.setAttribute('aria-label', planSelectModeCbEl.title);
      }
      if (planListSelectModeCbEl) {
        planListSelectModeCbEl.checked = selectionMode;
      }
      const runSelectedLabel = selectedTotal > 0 ? ('Run Selected (' + selectedTotal + ')') : 'Run Selected';
      planRunSelectedBtnEl.textContent = runSelectedLabel;
      planRunSelectedBtnEl.title = runSelectedLabel;
      planRunSelectedBtnEl.setAttribute('aria-label', runSelectedLabel);
      planRunSelectedBtnEl.disabled = !selectionMode || selectedTotal === 0 || runnerState === 'playing';
      const pendingTaskCount = (planGroups || []).reduce((sum, group) => {
        const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
        return sum + tasks.filter((t) => {
          const s = String(t?.status || '').toLowerCase();
          return isPendingLikeStatus(s);
        }).length;
      }, 0);
      planRunPendingBtnEl.setAttribute('data-badge', String(pendingTaskCount));
      const pendingLabel = pendingTaskCount > 0
        ? ('Run Pending (' + pendingTaskCount + ')')
        : 'Run Pending';
      planRunPendingBtnEl.title = pendingLabel;
      planRunPendingBtnEl.setAttribute('aria-label', pendingLabel);
      planRunPendingBtnEl.disabled = pendingTaskCount === 0 || runnerState === 'playing';
      planStopBtnEl.disabled = runnerState !== 'playing';
      planFilterChipsEl.querySelectorAll('[data-plan-filter]').forEach((chip) => {
        const on = (chip.getAttribute('data-plan-filter') || 'all') === planFilterMode;
        chip.classList.toggle('active', on);
      });
    }

    function statusBadge(status) {
      const normalized = typeof status === 'string' ? status.toLowerCase() : '';
      if (!normalized || normalized === 'pending') { return ''; }
      if (normalized === 'completed') {
        return '<svg class="msg-status-icon completed" viewBox="0 0 16 16"><polyline points="2,9 6,13 14,4"/></svg>';
      }
      if (normalized === 'failed' || normalized === 'blocked') {
        return '<svg class="msg-status-icon ' + normalized + '" viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
      }
      if (normalized === 'running') {
        return '<svg class="msg-status-icon running" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" stroke-dasharray="8 24" stroke-dashoffset="0"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle></svg>';
      }
      return '';
    }

    function messageTypeBadge(msg, displayText) {
      if (!msg || msg.role !== 'assistant') {
        return '';
      }
      const status = String(msg.status || '').toLowerCase();
      const changedFiles = typeof msg.changedFilesCount === 'number' ? msg.changedFilesCount : 0;
      if (status === 'running' || status === 'pending' || status === 'paused' || status === 'stopping') {
        return '<span class="msg-type-dot run-status"></span>';
      }
      if (changedFiles > 0) {
        return '<span class="msg-type-dot code-change"></span>';
      }
      const text = String(displayText || '').trim();
      const looksLikeRunStatus = /^done\./i.test(text) || /^run failed\./i.test(text) || /^task failed\./i.test(text);
      if (looksLikeRunStatus) {
        return '<span class="msg-type-dot run-status"></span>';
      }
      return '<span class="msg-type-dot answer"></span>';
    }

    function isDoneStatus(status) {
      const normalized = typeof status === 'string' ? status.toLowerCase() : '';
      return normalized === 'completed' || normalized === 'failed' || normalized === 'blocked' || normalized === 'skipped';
    }

    function formatDuration(durationMs) {
      const ms = typeof durationMs === 'number' ? durationMs : 0;
      if (!ms || ms < 1000) {
        return '-';
      }
      const secs = Math.floor(ms / 1000);
      if (secs < 60) {
        return secs + 's';
      }
      const mins = Math.floor(secs / 60);
      const rem = secs % 60;
      return mins + 'm ' + rem + 's';
    }

    function renderResultCard(msg) {
      const normalized = (msg.status || 'completed').toString().toLowerCase();
      const outcome = normalized.toUpperCase();
      const files = typeof msg.changedFilesCount === 'number' ? msg.changedFilesCount : 0;
      const duration = formatDuration(msg.durationMs);
      const fileLabel = files === 1 ? '1 file' : files + ' files';
      return (
        '<div class="result-card">' +
          '<span class="result-pill ' + escHtml(normalized) + '">' + escHtml(outcome) + '</span>' +
          '<span class="result-strong">' + escHtml(fileLabel) + '</span>' +
          '<span class="result-sep">' + ICON_DOT + '</span>' +
          '<span>' + escHtml(duration) + '</span>' +
        '</div>'
      );
    }

    function markdownToHtml(text) {
      const raw = text || '';
      const parts = [];
      const bt = String.fromCharCode(96);
      const fence = bt + bt + bt;
      const escapedFence = fence.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
      const regex = new RegExp(escapedFence + '([a-zA-Z0-9_-]+)?\\\\n?([\\\\s\\\\S]*?)' + escapedFence, 'g');
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(raw)) !== null) {
        const plain = raw.slice(lastIndex, match.index);
        if (plain) {
          parts.push(renderInlineMarkdown(plain));
        }
        const lang = match[1] ? '<div class="meta-text">' + escHtml(match[1]) + '</div>' : '';
        const code = '<pre><code>' + escHtml(match[2]) + '</code></pre>';
        parts.push(lang + code);
        lastIndex = regex.lastIndex;
      }

      const tail = raw.slice(lastIndex);
      if (tail) {
        parts.push(renderInlineMarkdown(tail));
      }

      return parts.join('');
    }

    function renderInlineMarkdown(text) {
      let html = escHtml(text);
      const bt = String.fromCharCode(96);
      const inlineCodeRegex = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
      html = html.replace(inlineCodeRegex, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      html = html.replace(/\\n/g, '<br>');
      return html;
    }

    function compactUserText(text) {
      const raw = text || '';
      if (!raw.includes('[CONTEXT START]')) {
        return raw;
      }
      const lines = raw.split(/\\r?\\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      return lines.length > 0 ? lines[lines.length - 1] : 'Prompt submitted';
    }

    function renderMessageBody(messageText, status, role) {
      const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
      if (role === 'assistant' && normalizedStatus === 'running') {
        return (
          '<div class="msg-text">' +
            '<span class="running-inline"><span class="running-dot"></span>' + escHtml(messageText || 'Running...') + '</span>' +
          '</div>'
        );
      }
      const text = messageText || '';
      const lines = text.split(/\\r?\\n/);
      const shouldCollapse = text.length > 800 || lines.length > 18;
      const fullHtml = markdownToHtml(text);
      if (!shouldCollapse) {
        return '<div class="msg-text">' + fullHtml + '</div>';
      }

      const preview = lines.slice(0, 8).join('\\n');
      const previewHtml = markdownToHtml(preview);
      return (
        '<div class="msg-text" data-collapsible="1">' +
          '<div class="msg-preview">' + previewHtml + '</div>' +
          '<div class="msg-full" hidden>' + fullHtml + '</div>' +
          '<button type="button" class="msg-collapse">Show more</button>' +
        '</div>'
      );
    }

    function attachCollapseHandlers() {
      chatFeedEl.querySelectorAll('.msg-collapse').forEach((btn) => {
        btn.addEventListener('click', () => {
          const container = btn.closest('[data-collapsible="1"]');
          if (!container) { return; }
          const preview = container.querySelector('.msg-preview');
          const full = container.querySelector('.msg-full');
          const expanded = !full.hidden;
          full.hidden = expanded;
          preview.hidden = !expanded;
          btn.textContent = expanded ? 'Show more' : 'Show less';
        });
      });
    }

    function attachActionMenuHandlers() {
      chatFeedEl.querySelectorAll('.msg-actions-more').forEach((wrap) => {
        wrap.addEventListener('click', (event) => {
          event.stopPropagation();
        });
      });
      if (!actionMenuHandlersBound) {
        actionMenuHandlersBound = true;
        document.addEventListener('click', () => {
          chatFeedEl.querySelectorAll('.msg-more-panel.open').forEach((panel) => {
            panel.classList.remove('open');
          });
        });
      }
    }

    function renderChat(chatTitle, messages) {
      chatTitleEl.textContent = chatTitle || 'New Chat';
      chatFeedEl.textContent = '';
      const list = Array.isArray(messages) ? messages : [];
      chatEmptyEl.style.display = list.length === 0 ? 'block' : 'none';

      for (const msg of list) {
        const wrap = document.createElement('div');
        wrap.className = 'msg ' + (msg.role === 'assistant' ? 'assistant' : 'user');
        const displayText = msg.role === 'user' ? compactUserText(msg.text || '') : (msg.text || '');
        const isUser = msg.role !== 'assistant';
        const avatarSvg = isUser
          ? '<svg class="msg-avatar" viewBox="0 0 16 16"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1c-2.67 0-4 1.33-4 3v1h8v-1c0-1.67-1.33-3-4-3z"/></svg>'
          : '<svg class="msg-avatar" viewBox="0 0 16 16"><path d="M9 1L3 9h5l-1 6 6-8H8L9 1z"/></svg>';
        wrap.innerHTML =
          '<div class="msg-header">' +
            avatarSvg +
            '<span class="msg-author">' + escHtml(msg.author || (isUser ? 'You' : 'Assistant')) + '</span>' +
            messageTypeBadge(msg, displayText) +
            statusBadge(msg.status) +
          '</div>' +
          renderMessageBody(displayText, msg.status, msg.role);

        if (msg.role === 'assistant' && displayText.trim()) {
          if (isDoneStatus(msg.status)) {
            const cardWrap = document.createElement('div');
            cardWrap.innerHTML = renderResultCard(msg);
            wrap.appendChild(cardWrap.firstChild);
            const actions = document.createElement('div');
            actions.className = 'msg-actions';
            const changedFiles = typeof msg.changedFilesCount === 'number' ? msg.changedFilesCount : 0;
            const primaryBtn = document.createElement('button');
            primaryBtn.type = 'button';
            primaryBtn.className = 'msg-action-btn';
            if (changedFiles > 0) {
              primaryBtn.textContent = 'Review Diff';
              primaryBtn.addEventListener('click', () => vscode.postMessage({ type: 'reviewChanges' }));
            } else {
              primaryBtn.textContent = 'Open Dashboard';
              primaryBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDashboard' }));
            }
            actions.appendChild(primaryBtn);

            const moreWrap = document.createElement('div');
            moreWrap.className = 'msg-actions-more';
            const moreBtn = document.createElement('button');
            moreBtn.type = 'button';
            moreBtn.className = 'msg-action-btn';
            moreBtn.textContent = 'More';
            const panel = document.createElement('div');
            panel.className = 'msg-more-panel';

            const addMoreItem = (label, onClick) => {
              const item = document.createElement('button');
              item.type = 'button';
              item.className = 'msg-more-item';
              item.textContent = label;
              item.addEventListener('click', () => {
                panel.classList.remove('open');
                onClick();
              });
              panel.appendChild(item);
            };

            if (changedFiles > 0) {
              addMoreItem('Open Dashboard', () => vscode.postMessage({ type: 'showDashboard' }));
            } else {
              addMoreItem('Review Diff', () => vscode.postMessage({ type: 'reviewChanges' }));
            }
            addMoreItem('Use as playlist template', () => {
              const seed = 'Create a playlist + tasks from this:\\n' + displayText.slice(0, 1200);
              promptEl.value = seed;
              autoResize();
                      updateActionState();
              promptEl.focus();
            });

            moreBtn.addEventListener('click', () => {
              panel.classList.toggle('open');
            });
            moreWrap.appendChild(moreBtn);
            moreWrap.appendChild(panel);
            actions.appendChild(moreWrap);
            wrap.appendChild(actions);
          }
        }
        chatFeedEl.appendChild(wrap);
      }

      attachCollapseHandlers();
      attachActionMenuHandlers();
      if (list.length > 0) {
        chatFeedEl.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
    }

    function renderRunnerChip(state) {
      runnerState = typeof state === 'string' ? state : 'idle';
      renderContextBar();
    }

    function renderContextBar() {
      const planLabel = (activePlanName || 'Ad hoc').replace(/^MOAG\s*[-:]\s*/i, '').trim();
      const planTrunc = planLabel.length > 20 ? planLabel.slice(0, 19) + '\u2026' : planLabel;
      const planSvg = '<svg viewBox="0 0 16 16" style="width:10px;height:10px;fill:currentColor;flex-shrink:0"><path d="M3 3h10v1H3V3zm0 4h10v1H3V7zm0 4h7v1H3v-1z"/></svg>';
      ctxPlanEl.innerHTML = planSvg + ' ' + escHtml(planTrunc);
      const stateColor = runnerState === 'playing' ? '#4caf50' : runnerState === 'paused' ? '#cca700' : 'currentColor';
      const runnerSvg = '<svg viewBox="0 0 16 16" style="width:10px;height:10px;flex-shrink:0"><circle cx="8" cy="8" r="5" fill="none" stroke="' + stateColor + '" stroke-width="1.5"/></svg>';
      ctxRunnerEl.innerHTML = runnerSvg + ' ' + escHtml(runnerState.toUpperCase());
    }

    function setActiveTab(tab) {
      activeTab = tab === 'plan' || tab === 'history' ? tab : 'chat';
      tabEls.forEach((el) => el.classList.toggle('active', el.dataset.tab === activeTab));

      const showChat = activeTab === 'chat';
      chatScreenEl.classList.toggle('active', showChat);
      planListEl.classList.toggle('active', activeTab === 'plan');
      planToolsEl.classList.toggle('active', activeTab === 'plan');
      planOverviewEl.classList.toggle('active', activeTab === 'plan' && planGroups.length > 0);
      if (activeTab !== 'plan') {
        planQueueEl.classList.remove('active');
      }
      renderPlanListHeading();
      historyListEl.classList.toggle('active', activeTab === 'history');
      historyToolsEl.classList.toggle('active', activeTab === 'history');

      if (showChat) {
        listEmptyEl.classList.remove('active');
      } else {
        if (activeTab === 'history') {
          renderHistoryList();
          return;
        }
        const activeItems = planGroups;
        listEmptyEl.textContent = 'No plan tasks yet.';
        listEmptyEl.classList.toggle('active', activeItems.length === 0);
      }
    }

    function attachImage(dataUri) {
      attachedImage = dataUri;
      imagePreviewThumbEl.src = dataUri;
      imagePreviewBarEl.classList.add('visible');
    }

    function removeImage() {
      attachedImage = null;
      imagePreviewThumbEl.src = '';
      imagePreviewBarEl.classList.remove('visible');
    }

    function submit() {
      const text = promptEl.value.trim();
      if (!text || sendEl.disabled) {
        return;
      }
      setActiveTab('chat');
      vscode.postMessage({
        type: 'submit',
        text,
        engineId: engineEl.disabled ? undefined : engineEl.value,
        imageData: attachedImage || undefined,
      });
    }

    function escHtml(value) {
      const div = document.createElement('div');
      div.textContent = value || '';
      return div.innerHTML;
    }

    sendEl.addEventListener('click', submit);
    newChatBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
    dashboardBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'showDashboard' }));
    attachBtnEl.addEventListener('click', function() {
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = 'image/*';
      fileInput.onchange = function() {
        const file = fileInput.files && fileInput.files[0];
        if (!file) { return; }
        const reader = new FileReader();
        reader.onload = function(ev) { if (ev.target?.result) { attachImage(String(ev.target.result)); } };
        reader.readAsDataURL(file);
      };
      fileInput.click();
    });
    promptEl.addEventListener('input', () => {
      autoResize();
      updateActionState();
    });
    promptEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });
    settingsBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    imageRemoveBtnEl.addEventListener('click', removeImage);
    promptEl.addEventListener('paste', function(e) {
      const items = e.clipboardData?.items;
      if (!items) { return; }
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) { continue; }
          const reader = new FileReader();
          reader.onload = function(ev) { if (ev.target?.result) { attachImage(String(ev.target.result)); } };
          reader.readAsDataURL(file);
          return;
        }
      }
    });
    inputWrapEl.addEventListener('dragover', function(e) {
      if (Array.from(e.dataTransfer?.items || []).some(function(i) { return i.type.startsWith('image/'); })) {
        e.preventDefault();
        inputWrapEl.classList.add('drag-over');
      }
    });
    inputWrapEl.addEventListener('dragleave', function() { inputWrapEl.classList.remove('drag-over'); });
    inputWrapEl.addEventListener('drop', function(e) {
      inputWrapEl.classList.remove('drag-over');
      const file = Array.from(e.dataTransfer?.files || []).find(function(f) { return f.type.startsWith('image/'); });
      if (!file) { return; }
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = function(ev) { if (ev.target?.result) { attachImage(String(ev.target.result)); } };
      reader.readAsDataURL(file);
    });
    tabEls.forEach((tabEl) => tabEl.addEventListener('click', () => setActiveTab(tabEl.dataset.tab || 'chat')));
    if (planListSelectModeCbEl) {
      planListSelectModeCbEl.addEventListener('change', () => {
        selectionMode = !!planListSelectModeCbEl.checked;
        if (planSelectModeCbEl) {
          planSelectModeCbEl.checked = selectionMode;
        }
        if (!selectionMode) {
          selectedPlaylists = {};
          selectedTasks = {};
        }
        renderPlanGroups(planListEl, planGroups);
        renderPlanTools();
      });
    }
    if (planSelectModeCbEl) {
      planSelectModeCbEl.addEventListener('change', () => {
        selectionMode = !!planSelectModeCbEl.checked;
        if (planListSelectModeCbEl) {
          planListSelectModeCbEl.checked = selectionMode;
        }
        if (!selectionMode) {
          selectedPlaylists = {};
          selectedTasks = {};
        }
        renderPlanGroups(planListEl, planGroups);
        renderPlanTools();
      });
    }
    planRunSelectedBtnEl.addEventListener('click', () => {
      const items = [];
      (planGroups || []).forEach((group, idx) => {
        const key = group.id || ('playlist-' + idx);
        const tasks = Array.isArray(group.tasks) ? group.tasks : [];
        for (let ti = 0; ti < tasks.length; ti++) {
          if (selectedTasks[key + ':' + ti]) {
            items.push({ kind: 'task', playlistIndex: idx, taskIndex: ti });
          }
        }
        if (selectedPlaylists[key]) {
          items.push({ kind: 'playlist', playlistIndex: idx });
        }
      });
      if (items.length > 0) {
        vscode.postMessage({ type: 'runSelectedPlaylists', items });
      }
    });
    planRunPendingBtnEl.addEventListener('click', () => {
      const items = [];
      (planGroups || []).forEach((group, idx) => {
        const tasks = Array.isArray(group.tasks) ? group.tasks : [];
        for (let ti = 0; ti < tasks.length; ti++) {
          const status = String(tasks[ti]?.status || '').toLowerCase();
          if (isPendingLikeStatus(status)) {
            items.push({ kind: 'task', playlistIndex: idx, taskIndex: ti });
          }
        }
      });
      if (items.length > 0) {
        vscode.postMessage({ type: 'runSelectedPlaylists', items });
      }
    });
    planStopBtnEl.addEventListener('click', () => {
      planManageMenuEl.classList.remove('open');
      vscode.postMessage({ type: 'pauseRun' });
    });
    planSearchBtnEl.addEventListener('click', () => {
      if (!planSearchBarEl.classList.contains('active')) {
        planSearchBarEl.classList.add('active');
        planSearchInputEl.focus();
        planSearchInputEl.select();
        return;
      }
      if (planSearchQuery) {
        planSearchQuery = '';
        planSearchInputEl.value = '';
      } else {
        planSearchBarEl.classList.remove('active');
      }
      renderPlanGroups(planListEl, planGroups);
      renderPlanTools();
    });
    planSearchInputEl.addEventListener('input', () => {
      planSearchQuery = planSearchInputEl.value.trim().toLowerCase();
      renderPlanGroups(planListEl, planGroups);
      renderPlanTools();
    });
    planSearchInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        planSearchQuery = '';
        planSearchInputEl.value = '';
        planSearchBarEl.classList.remove('active');
        renderPlanGroups(planListEl, planGroups);
        renderPlanTools();
      }
    });
    planSearchClearBtnEl.addEventListener('click', () => {
      planSearchQuery = '';
      planSearchInputEl.value = '';
      planSearchInputEl.focus();
      renderPlanGroups(planListEl, planGroups);
      renderPlanTools();
    });
    planPlayBtnEl.addEventListener('click', () => {
      if (runnerState === 'playing') {
        vscode.postMessage({ type: 'pauseRun' });
      } else {
        vscode.postMessage({ type: 'playPlan' });
      }
    });
    planAddTaskBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'addTask' }));
    planNewBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'newPlan' }));
    planManageBtnEl.addEventListener('click', (event) => {
      event.stopPropagation();
      planManageMenuEl.classList.toggle('open');
      planFilterMenuEl.classList.remove('open');
    });
    planManageMenuEl.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    planFilterBtnEl.addEventListener('click', (event) => {
      event.stopPropagation();
      planFilterMenuEl.classList.toggle('open');
      planManageMenuEl.classList.remove('open');
    });
    planFilterMenuEl.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    planFilterChipsEl.querySelectorAll('[data-plan-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const next = chip.getAttribute('data-plan-filter') || 'all';
        planFilterMode = (next === 'pending' || next === 'completed' || next === 'failed') ? next : 'all';
        renderPlanGroups(planListEl, planGroups);
        renderPlanTools();
        planFilterMenuEl.classList.remove('open');
      });
    });
    planAddTaskBtnEl.addEventListener('click', () => {
      planManageMenuEl.classList.remove('open');
    });
    planNewBtnEl.addEventListener('click', () => {
      planManageMenuEl.classList.remove('open');
    });
    planRunSelectedBtnEl.addEventListener('click', () => {
      planManageMenuEl.classList.remove('open');
    });
    planSwitchBtnEl.addEventListener('click', () => {
      planManageMenuEl.classList.remove('open');
    });
    planHeadingCollapseBtnEl.addEventListener('click', () => {
      const keys = (planGroups || []).map((group, idx) => group.id || ('playlist-' + idx));
      const anyCollapsed = keys.some((key) => !!collapsedPlanGroups[key]);
      const next = {};
      keys.forEach((key) => {
        next[key] = !anyCollapsed;
      });
      planTasksVisible = true;
      collapsedPlanGroups = next;
      renderPlanGroups(planListEl, planGroups);
      renderPlanTools();
    });
    planSwitchQuickBtnEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'switchPlan' });
    });
    planSwitchBtnEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'switchPlan' });
    });
    historyViewModeEl.addEventListener('change', () => {
      historyViewMode = historyViewModeEl.value === 'executed' ? 'executed' : 'default';
      renderHistoryList();
    });
    historyGroupByEl.addEventListener('change', () => {
      const next = historyGroupByEl.value;
      historyGroupBy = next === 'plan' || next === 'playlist' ? next : 'none';
      renderHistoryList();
    });
    historyStatusChipsEl.querySelectorAll('[data-status]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const next = chip.getAttribute('data-status') || 'all';
        historyStatusFilter = next === 'completed' || next === 'failed' ? next : 'all';
        historyStatusChipsEl.querySelectorAll('[data-status]').forEach((el) => {
          const on = (el.getAttribute('data-status') || 'all') === historyStatusFilter;
          el.classList.toggle('active', on);
        });
        renderHistoryList();
      });
    });
    document.addEventListener('click', (event) => {
      planManageMenuEl.classList.remove('open');
      planFilterMenuEl.classList.remove('open');
      const target = event.target;
      const clickedSearch = target && planSearchBarEl.contains(target);
      const clickedSearchBtn = target && planSearchBtnEl.contains(target);
      if (!clickedSearch && !clickedSearchBtn && !planSearchQuery) {
        planSearchBarEl.classList.remove('active');
      }
    });
    engineEl.addEventListener('change', () => renderContextBar());

    // ─── Sidebar Sandbox ───
    const sbSectionEl = document.getElementById('sidebarSandbox');
    const sbToggleEl = document.getElementById('sbToggle');
    const sbBodyEl = document.getElementById('sbBody');
    const sbDotEl = document.getElementById('sbDot');
    const sbStatusEl = document.getElementById('sbStatus');
    const sbFrameworkEl = document.getElementById('sbFramework');
    const sbUrlEl = document.getElementById('sbUrl');
    const sbBadgeEl = document.getElementById('sbBadge');
    const sbLaunchEl = document.getElementById('sbLaunch');
    const sbStopEl = document.getElementById('sbStop');
    const sbScreenshotEl = document.getElementById('sbScreenshot');
    let sbCollapsed = true;

    sbToggleEl.addEventListener('click', () => {
      sbCollapsed = !sbCollapsed;
      sbToggleEl.classList.toggle('collapsed', sbCollapsed);
      sbBodyEl.classList.toggle('collapsed', sbCollapsed);
    });
    sbLaunchEl.addEventListener('click', () => vscode.postMessage({ type: 'launchSandbox' }));
    sbStopEl.addEventListener('click', () => vscode.postMessage({ type: 'stopSandbox' }));
    sbScreenshotEl.addEventListener('click', () => vscode.postMessage({ type: 'takeScreenshot' }));
    sbUrlEl.addEventListener('click', () => {
      const url = sbUrlEl.dataset.url;
      if (url) { vscode.postMessage({ type: 'openSandboxBrowser', url: url }); }
    });

    function renderSidebarSandbox(state) {
      if (!state) { return; }
      sbDotEl.className = 'sidebar-sandbox-dot ' + (state.status || 'stopped');
      var labels = { stopped: 'Stopped', starting: 'Starting...', running: 'Running', error: 'Error' };
      sbStatusEl.textContent = state.error || labels[state.status] || state.status;
      sbFrameworkEl.textContent = state.projectInfo ? state.projectInfo.framework : '';
      if (state.url) {
        sbUrlEl.textContent = state.url;
        sbUrlEl.dataset.url = state.url;
        sbUrlEl.style.display = 'inline';
      } else {
        sbUrlEl.style.display = 'none';
      }
      var active = state.status === 'running' || state.status === 'starting';
      sbLaunchEl.style.display = active ? 'none' : 'inline-block';
      sbStopEl.style.display = active ? 'inline-block' : 'none';
      sbBadgeEl.textContent = active ? (state.status === 'running' ? 'Running' : 'Starting') : '';
      sbBadgeEl.className = 'sidebar-sandbox-badge ' + (active ? state.status : '');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'setBusy') {
        busy = !!msg.busy;
        promptEl.disabled = busy;
        engineEl.disabled = busy || engineEl.options.length === 0 || engineEl.value === '';
        updateActionState();
      } else if (msg.type === 'clear') {
        promptEl.value = '';
        removeImage();
        autoResize();
          updateActionState();
        if (!busy) {
          promptEl.focus();
        }
      } else if (msg.type === 'syncState') {
        renderEngines(msg.engines || [], msg.selectedEngineId);
        chatItems = msg.chatItems || [];
        planItems = msg.planItems || [];
        planGroups = msg.planGroups || [];
        const currentKeys = new Set((planGroups || []).map((g, i) => g.id || ('playlist-' + i)));
        Object.keys(selectedPlaylists).forEach((key) => {
          if (!currentKeys.has(key)) {
            delete selectedPlaylists[key];
          }
        });
        const validTaskKeys = new Set();
        (planGroups || []).forEach((group, idx) => {
          const gk = group.id || ('playlist-' + idx);
          const tasks = Array.isArray(group.tasks) ? group.tasks : [];
          for (let ti = 0; ti < tasks.length; ti++) {
            validTaskKeys.add(gk + ':' + ti);
          }
        });
        Object.keys(selectedTasks).forEach((key) => {
          if (!validTaskKeys.has(key)) {
            delete selectedTasks[key];
          }
        });
        historyItems = msg.historyItems || [];
        activeThreadId = msg.activeThreadId || '';
        chatMessages = msg.chatMessages || [];
        activePlanName = msg.activePlanName || '';
        activePlaylistName = msg.activePlaylistName || '';
        // Chat tab is conversation-first; no session strip row.
        renderPlanGroups(planListEl, planGroups);
        renderPlanOverview(planGroups);
        renderPlanQueue(planGroups);
        renderPlanTools();
        renderHistoryList();
        renderChat(msg.chatTitle || 'New Chat', chatMessages);
        renderRunnerChip(msg.runnerState || 'idle');
        renderContextBar();
        setActiveTab(activeTab);
        engineEl.disabled = busy || engineEl.options.length === 0 || engineEl.value === '';
        updateActionState();
        if (msg.sandboxState) { renderSidebarSandbox(msg.sandboxState); }
      } else if (msg.type === 'sandbox-state') {
        renderSidebarSandbox(msg.sandboxState);
      }
    });

    autoResize();
    updateActionState();
    setActiveTab('chat');
    renderContextBar();
    vscode.postMessage({ type: 'ready' });
    promptEl.focus();
  </script>
</body>
</html>`;
  }
}

