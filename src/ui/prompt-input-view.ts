import * as vscode from 'vscode';
import { designSystemCssTokens } from './design-system';

export interface PromptInputSubmitRequest {
  prompt: string;
  engineId?: string;
  imageData?: string; // base64 data URI (e.g. data:image/png;base64,...)
  activeFilePath?: string; // absolute path of the active editor file to inject into context
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
  failureReason?: string;
  filesChanged?: number;
  taskId?: string;
}

export interface PromptSidebarPlanGroup {
  id: string;
  name: string;
  playlistStatus: string;
  progress: { done: number; total: number };
  tasks: Array<{
    id: string;
    name: string;
    status: string;
    failureReason?: string;
    errorCategory?: string;
    errorLines?: string[];
    attemptCount?: number;
    tokenUsage?: { totalTokens?: number; estimatedCost?: number };
    sourceIssueNumber?: number;
    sourceIssueRepo?: string;
  }>;
  aiRules?: string;
  testPhase?: boolean;
  prdContext?: string;
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
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; estimatedCost?: number };
}

export interface PromptSidebarRunnerState {
  state: 'idle' | 'playing' | 'paused' | 'stopping';
}

export interface AiRuleSidebarItem {
  id: string;
  name: string;
  category: string;
  scope: 'global' | 'workspace';
  enabled: boolean;
  charCount: number;
}

export type RulesAction =
  | { type: 'add' }
  | { type: 'openLibrary' }
  | { type: 'toggle'; id: string; scope: 'global' | 'workspace' }
  | { type: 'edit'; id: string; scope: 'global' | 'workspace' }
  | { type: 'delete'; id: string; scope: 'global' | 'workspace' };

export class PromptInputViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentTaskPlayer.promptView';

  private static _ghAuthUserCache: { user: string | null; ts: number } = { user: null, ts: 0 };
  static _getGhAuthUser(): string | null {
    const now = Date.now();
    if (now - PromptInputViewProvider._ghAuthUserCache.ts < 30_000) {
      return PromptInputViewProvider._ghAuthUserCache.user;
    }
    try {
      const { execSync } = require('child_process') as typeof import('child_process');
      const out = execSync('gh auth status', { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr = (out as unknown as { stderr?: string }).stderr ?? out;
      const m = String(stderr || out).match(/Logged in to \S+ account (\S+)/);
      const user = m ? m[1] : (String(out).includes('Logged in') ? 'authenticated' : null);
      PromptInputViewProvider._ghAuthUserCache = { user, ts: now };
      return user;
    } catch {
      // gh auth status exits with code 1 when not authenticated — capture stderr from the error
      try {
        const { execSync } = require('child_process') as typeof import('child_process');
        // Try again piping stderr to see the message
        const result = execSync('gh auth status 2>&1', { timeout: 5000, encoding: 'utf-8', shell: 'powershell.exe' });
        const m = String(result).match(/Logged in to \S+ account (\S+)/);
        const user = m ? m[1] : null;
        PromptInputViewProvider._ghAuthUserCache = { user, ts: now };
        return user;
      } catch {
        PromptInputViewProvider._ghAuthUserCache = { user: null, ts: now };
        return null;
      }
    }
  }

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
  private _planAiRules = '';
  private _activePlanName = '';
  private _activePlaylistName = '';
  private _planPrdSource = '';
  private _detectedPrdFilePath = '';
  private _planPrdVersions: { version: string; text: string; createdAt: string }[] = [];
  private _planFixIterations = 0;
  private _prdProjectMeta: { name: string; stack: string } = { name: '', stack: '' };
  private _sandboxState: unknown = null;
  private _issueSyncLastPoll: string | null = null;
  private _issueSyncTrackedCount: number | null = null;
  private _aiRules: AiRuleSidebarItem[] = [];
  private _liveOutputBuffer = new Map<string, string>();
  private _liveFlushTimer: ReturnType<typeof setInterval> | null = null;
  private _activeFile: { name: string; path: string } | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _onSubmit: (request: PromptInputSubmitRequest) => Promise<boolean>,
    private readonly _onOpenItem: (id: string, kind: 'thread' | 'run' | 'plan' | 'history') => void,
    private readonly _onGeneratePlan?: (prompt: string) => Promise<void>,
    private readonly _onRulesAction?: (action: RulesAction) => void,
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
        const query = typeof message.query === 'string' ? message.query : 'agentTaskPlayer';
        void vscode.commands.executeCommand('workbench.action.openSettings', query);
        return;
      }

      if (message.type === 'ghSyncPollNow') {
        void vscode.commands.executeCommand('agentTaskPlayer.ghSyncPollNow');
        return;
      }

      if (message.type === 'ghSyncConfigure') {
        // No repo in message = triggered from header pill → open interactive input flow
        if (message.repo === undefined) {
          void vscode.commands.executeCommand('agentTaskPlayer.ghSyncConfigureInteractive');
          return;
        }
        const repo = typeof message.repo === 'string' ? message.repo : '';
        const label = typeof message.label === 'string' ? message.label : 'moag';
        const enabled = !!message.enabled;
        void vscode.commands.executeCommand('agentTaskPlayer.ghSyncConfigure', { repo, label, enabled });
        return;
      }

      if (message.type === 'ghSyncToggleEnabled') {
        void vscode.commands.executeCommand('agentTaskPlayer.ghSyncConfigure', {
          enabled: !!message.enabled,
        });
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

      if (message.type === 'planFromPrd') {
        void vscode.commands.executeCommand('agentTaskPlayer.planFromPrd');
        return;
      }

      if (message.type === 'newPlanFromTemplate') {
        void vscode.commands.executeCommand('agentTaskPlayer.newPlanFromTemplate');
        return;
      }

      if (message.type === 'openPrdFromPlan') {
        void vscode.commands.executeCommand('agentTaskPlayer.openPrdFromPlan');
        return;
      }

      if (message.type === 'prdAiImprove') {
        void vscode.commands.executeCommand('agentTaskPlayer.prdAiImprove', message.text as string);
        return;
      }

      if (message.type === 'openPrdInBrowser') {
        void vscode.commands.executeCommand('agentTaskPlayer.openPrdInBrowser', message.text as string);
        return;
      }

      if (message.type === 'savePrdVersion') {
        void vscode.commands.executeCommand('agentTaskPlayer.savePrdVersion', { text: message.text as string, version: message.version as string });
        return;
      }

      if (message.type === 'setTestTool') {
        const value = typeof message.value === 'string' ? message.value : 'manual';
        void vscode.workspace.getConfiguration('agentTaskPlayer').update('testTool', value, vscode.ConfigurationTarget.Workspace);
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
            activeFilePath: typeof message.activeFilePath === 'string' ? message.activeFilePath : undefined,
          });
          if (submitted) {
            this.clear();
          }
        } finally {
          this.setBusy(false);
        }
      }

      if (message.type === 'generatePlan' && message.text?.trim()) {
        this.setBusy(true);
        try {
          await this._onGeneratePlan?.(message.text.trim());
          this.clear();
        } finally {
          this.setBusy(false);
        }
        return;
      }

      if (message.type === 'previewTask') {
        const playlistIndex = Number(message.playlistIndex);
        const taskIndex = Number(message.taskIndex);
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0 && !Number.isNaN(taskIndex) && taskIndex >= 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.previewTaskPrompt', { playlistIndex, taskIndex });
        }
        return;
      }

      if (message.type === 'saveTaskEdit') {
        const playlistIndex = Number(message.playlistIndex);
        const taskIndex = Number(message.taskIndex);
        const name = typeof message.name === 'string' ? message.name.trim() : '';
        const prompt = typeof message.prompt === 'string' ? message.prompt : '';
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0 && !Number.isNaN(taskIndex) && taskIndex >= 0 && name) {
          void vscode.commands.executeCommand('agentTaskPlayer.saveTaskEdit', { playlistIndex, taskIndex, name, prompt });
        }
        return;
      }

      if (message.type === 'savePlaylistRules') {
        const playlistIndex = Number(message.playlistIndex);
        const rules = typeof message.rules === 'string' ? message.rules : '';
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.savePlaylistRules', { playlistIndex, rules });
        }
        return;
      }

      if (message.type === 'savePlanRules') {
        const rules = typeof message.rules === 'string' ? message.rules : '';
        void vscode.commands.executeCommand('agentTaskPlayer.savePlanRules', { rules });
        return;
      }

      if (message.type === 'showPlaylistPrdContext') {
        const prdText = typeof message.prdContext === 'string' ? message.prdContext : '';
        void vscode.commands.executeCommand('agentTaskPlayer.openPrdFromPlan', { prdOverride: prdText });
        return;
      }

      if (message.type === 'openExternalUrl') {
        const url = typeof message.url === 'string' ? message.url : '';
        if (url.startsWith('https://')) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      }

      if (message.type === 'showSmartFix') {
        const playlistIndex = Number(message.playlistIndex);
        const taskIndex = Number(message.taskIndex);
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0 && !Number.isNaN(taskIndex) && taskIndex >= 0) {
          void vscode.commands.executeCommand('agentTaskPlayer.showSmartFix', { playlistIndex, taskIndex });
        }
        return;
      }

      if (message.type === 'retryTaskWithPrompt') {
        const playlistIndex = Number(message.playlistIndex);
        const taskIndex = Number(message.taskIndex);
        const prompt = typeof message.prompt === 'string' ? message.prompt : '';
        if (!Number.isNaN(playlistIndex) && playlistIndex >= 0 && !Number.isNaN(taskIndex) && taskIndex >= 0 && prompt) {
          void vscode.commands.executeCommand('agentTaskPlayer.retryTaskWithPrompt', { playlistIndex, taskIndex, prompt });
        }
        return;
      }

      if (message.type === 'fixAllFailed') {
        void vscode.commands.executeCommand('agentTaskPlayer.fixAllFailed');
        return;
      }

      if (message.type === 'reportIssue') {
        void vscode.commands.executeCommand('agentTaskPlayer.reportIssue');
        return;
      }

      if (message.type === 'addToPlan') {
        const text = typeof message.text === 'string' ? message.text : '';
        if (text) {
          void vscode.commands.executeCommand('agentTaskPlayer.addTaskFromPrompt', { text });
        }
        return;
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

      if (message.type === 'addRule') {
        this._onRulesAction?.({ type: 'add' });
        return;
      }
      if (message.type === 'openRulesLibrary') {
        this._onRulesAction?.({ type: 'openLibrary' });
        return;
      }
      if (message.type === 'toggleRule') {
        const id = typeof message.id === 'string' ? message.id : '';
        const scope = message.scope === 'workspace' ? 'workspace' : 'global';
        if (id) { this._onRulesAction?.({ type: 'toggle', id, scope }); }
        return;
      }
      if (message.type === 'editRule') {
        const id = typeof message.id === 'string' ? message.id : '';
        const scope = message.scope === 'workspace' ? 'workspace' : 'global';
        if (id) { this._onRulesAction?.({ type: 'edit', id, scope }); }
        return;
      }
      if (message.type === 'deleteRule') {
        const id = typeof message.id === 'string' ? message.id : '';
        const scope = message.scope === 'workspace' ? 'workspace' : 'global';
        if (id) { this._onRulesAction?.({ type: 'delete', id, scope }); }
        return;
      }
      if (message.type === 'tttCriterionChecked') {
        console.log('[TTT] criterion checked:', message.index, message.checked);
        return;
      }
      if (message.type === 'tttAllCriteriaVerified' || message.type === 'verifyAgainstPrd') {
        vscode.commands.executeCommand('agentTaskPlayer.verifyAgainstPrd');
        return;
      }

      if (message.type === 'openPrdFile') {
        vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'PRD files': ['md', 'txt'] },
          title: 'Open PRD file'
        }).then(uris => {
          if (uris && uris[0]) {
            const text = require('fs').readFileSync(uris[0].fsPath, 'utf-8');
            this._view?.webview.postMessage({ type: 'prdFileContent', text });
          }
        });
        return;
      }

      if (message.type === 'generatePlanFromPrd') {
        const prdText = typeof message.prdText === 'string' ? message.prdText.trim() : '';
        if (prdText) {
          void vscode.commands.executeCommand('agentTaskPlayer.generatePlanFromPrdText', prdText);
        }
        return;
      }

      if (message.type === 'savePrdToPlan') {
        const prdText = typeof message.prdText === 'string' ? message.prdText.trim() : '';
        if (prdText) {
          void vscode.commands.executeCommand('agentTaskPlayer.savePrdToPlan', prdText);
        }
        return;
      }

      if (message.type === 'prdAnswer') {
        void vscode.commands.executeCommand(
          'agentTaskPlayer.prdChatAnswer',
          { answer: message.answer, step: message.step, answers: message.answers },
        );
        return;
      }

      if (message.type === 'runCommand') {
        if (typeof message.command === 'string') {
          void vscode.commands.executeCommand(message.command);
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

  postSessionCost(costUsd: number, tokensIn = 0, tokensOut = 0): void {
    this._view?.webview.postMessage({ type: 'sessionCost', cost: costUsd, tokensIn, tokensOut });
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
      sandboxState: this._serializeSandboxState(this._sandboxState),
      activeFile: this._activeFile,
      aiRules: this._aiRules,
      planAiRules: this._planAiRules,
      planPrdSource: this._planPrdSource,
      detectedPrdFilePath: this._detectedPrdFilePath,
      planPrdVersions: this._planPrdVersions,
      planFixIterations: this._planFixIterations,
      prdProjectMeta: this._prdProjectMeta,
      testTool: vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('testTool', 'manual'),
      issueSyncEnabled: vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('issueSync.enabled', false),
      issueSyncRepo: vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('issueRepo', ''),
      issueSyncIntervalMs: vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('issueSync.pollIntervalMs', 300000),
      issueSyncLastPoll: this._issueSyncLastPoll,
      issueSyncTrackedCount: this._issueSyncTrackedCount,
      ghAuthUser: PromptInputViewProvider._getGhAuthUser(),
    });
  }

  setPlanAiRules(rules: string): void {
    this._planAiRules = rules;
  }

  setPlanPrdSource(prdSource: string): void {
    this._planPrdSource = prdSource;
    this._syncState();
  }

  setDetectedPrdFilePath(filePath: string): void {
    this._detectedPrdFilePath = filePath;
    this._syncState();
  }

  setPlanPrdVersions(versions: { version: string; text: string; createdAt: string }[]): void {
    this._planPrdVersions = versions;
    this._syncState();
  }

  setPlanFixIterations(n: number): void {
    this._planFixIterations = n;
  }

  setIssueSyncState(lastPoll: string | null, trackedCount: number | null): void {
    this._issueSyncLastPoll = lastPoll;
    this._issueSyncTrackedCount = trackedCount;
    this._syncState();
  }

  setPrdProjectMeta(meta: { name: string; stack: string }): void {
    this._prdProjectMeta = meta;
  }

  showPrdInputScreen(): void {
    this._view?.webview.postMessage({ type: 'showPrdInputScreen' });
  }

  postMessage(msg: Record<string, unknown>): void {
    this._view?.webview.postMessage(msg);
  }

  /** Push sandbox state to the sidebar webview */
  postSandboxState(state: unknown): void {
    this._sandboxState = state;
    this._view?.webview.postMessage({ type: 'sandbox-state', sandboxState: this._serializeSandboxState(state) });
  }

  private _serializeSandboxState(state: unknown): unknown {
    if (!state || typeof state !== 'object') { return state; }
    const s = state as Record<string, unknown>;
    if (!s.lastScreenshotPath || typeof s.lastScreenshotPath !== 'string' || !this._view) { return state; }
    try {
      return { ...s, lastScreenshotPath: this._view.webview.asWebviewUri(vscode.Uri.file(s.lastScreenshotPath)).toString() };
    } catch {
      return state;
    }
  }

  /** Push AI rules state to the sidebar webview */
  postRulesState(rules: AiRuleSidebarItem[]): void {
    this._aiRules = rules;
    this._view?.webview.postMessage({ type: 'rules-state', rules });
  }

  /** Signal that a task has started — creates a live output block in the chat feed */
  postLiveOutputStart(taskId: string, taskName: string): void {
    this._liveOutputBuffer.delete(taskId);
    this._view?.webview.postMessage({ type: 'live-output-start', taskId, taskName });
  }

  /**
   * Buffer a raw output chunk and flush to the webview at 120ms intervals.
   * Skipped entirely when the sidebar is not visible — zero cost during normal execution
   * where the user is watching the Dashboard instead.
   * Buffer is capped at 3K chars per task to prevent large DOM dumps on flush.
   */
  postLiveOutputChunk(taskId: string, text: string): void {
    if (!this._view?.visible) { return; }
    const current = this._liveOutputBuffer.get(taskId) ?? '';
    if (current.length < 3000) {
      this._liveOutputBuffer.set(taskId, current + text);
    }

    if (!this._liveFlushTimer) {
      this._liveFlushTimer = setInterval(() => {
        if (this._liveOutputBuffer.size === 0) {
          clearInterval(this._liveFlushTimer!);
          this._liveFlushTimer = null;
          return;
        }
        if (!this._view?.visible) { return; }
        for (const [id, buffered] of this._liveOutputBuffer) {
          this._view?.webview.postMessage({ type: 'live-output-chunk', taskId: id, text: buffered });
          this._liveOutputBuffer.delete(id);
        }
      }, 120);
    }
  }

  /** Push the currently active editor file to the sidebar — shows as an injectable context pill */
  postActiveFile(file: { name: string; path: string } | null): void {
    this._activeFile = file;
    this._view?.webview.postMessage({ type: 'active-file', file });
  }

  /** Signal that a task finished — updates the live block badge then lets syncState replace it */
  postLiveOutputEnd(taskId: string, status: string): void {
    this._liveOutputBuffer.delete(taskId);
    this._view?.webview.postMessage({ type: 'live-output-end', taskId, status });
  }

  /** Pre-fill the composer textarea with a Smart Fix prompt and focus it */
  fillComposer(text: string, label?: string, fixRef?: { playlistIndex: number; taskIndex: number }): void {
    this._view?.webview.postMessage({ type: 'fillComposer', text, label: label ?? '', fixRef: fixRef ?? null });
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
    .tabs { display: inline-flex; align-items: stretch; gap: 0; flex: none; overflow: hidden; }
    .tab {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      width: auto;
      padding: 0 10px;
      flex-shrink: 0;
    }
    .tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .tab:hover:not(.active) { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.07)); }
    .tab-icon {
      width: 14px; height: 14px; flex-shrink: 0;
      fill: currentColor; display: block; opacity: 0.7;
    }
    .tab.active .tab-icon { opacity: 1; }
    .tab-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      line-height: 1;
      opacity: 0.75;
    }
    .tab.active .tab-label { opacity: 1; }
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
    .list { display: none; flex-direction: column; gap: 2px; min-height: 0; overflow-y: auto; overflow-x: hidden; }
    .list.active { display: flex; flex: 1; }
    .item {
      width: 100%;
      border: none;
      background: transparent;
      text-align: left;
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: 1px;
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
    .history-item {
      display: flex; align-items: flex-start; gap: 7px;
      padding: 5px 8px; width: 100%; text-align: left;
      border: none; background: transparent; cursor: pointer;
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08));
    }
    .history-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.07)); }
    .history-icon {
      width: 16px; height: 16px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 1px;
    }
    .history-icon.completed { background: rgba(115,201,145,0.18); color: #73c991; }
    .history-icon.failed { background: rgba(241,76,76,0.15); color: #f14c4c; }
    .history-icon.running { background: rgba(79,163,255,0.15); color: #4fa3ff; }
    .history-icon.default { background: var(--vscode-panel-border, rgba(128,128,128,0.2)); color: var(--vscode-descriptionForeground); }
    .history-body { flex: 1; min-width: 0; }
    .history-title { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    .history-breadcrumb { font-size: 9px; color: var(--vscode-descriptionForeground); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; opacity: 0.75; }
    .history-age { font-size: 9px; color: var(--vscode-descriptionForeground); flex-shrink: 0; opacity: 0.6; align-self: center; }
    .history-failure-reason { font-size: 9px; color: var(--vscode-editorError-foreground, #f14c4c); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    .history-files-changed { font-size: 9px; color: #73c991; margin-top: 1px; display: block; }
    .history-retry-btn { flex-shrink: 0; align-self: center; font-size: 11px; padding: 1px 5px; border-radius: 3px; cursor: pointer; border: 1px solid rgba(241,76,76,0.4); background: rgba(241,76,76,0.08); color: #f14c4c; margin-left: 2px; }
    .history-retry-btn:hover { background: rgba(241,76,76,0.18); }
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
    .error-cat {
      display: inline-flex; align-items: center;
      border-radius: 3px; padding: 0 5px; font-size: 9px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.3px; margin-left: 5px;
      border: 1px solid currentColor; opacity: 0.85;
    }
    .error-cat.compile  { color: #f44747; }
    .error-cat.test     { color: #cca700; }
    .error-cat.runtime  { color: #f44747; }
    .error-cat.code     { color: #f44747; }
    .error-cat.auth     { color: #cca700; }
    .error-cat.rate-limit { color: #9c77d9; }
    .error-cat.timeout  { color: #4fa3ff; }
    .error-cat.cli-missing { color: #cca700; }
    .error-cat.config   { color: #cca700; }
    .error-cat.unknown  { color: var(--vscode-descriptionForeground); }
    .attempt-badge {
      display: inline-flex; align-items: center;
      font-size: 9px; color: var(--vscode-descriptionForeground);
      margin-left: 5px; opacity: 0.7;
    }
    .error-lines {
      margin-top: 3px; padding: 4px 6px; border-radius: 4px;
      background: rgba(244,71,71,0.07); border-left: 2px solid rgba(244,71,71,0.35);
      display: flex; flex-direction: column; gap: 1px;
    }
    .error-line {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; color: #f44747; word-break: break-all;
      white-space: pre-wrap; line-height: 1.4;
    }
    .smart-fix-btn {
      height: 20px; padding: 0 7px; font-size: 10px; font-weight: 600;
      background: rgba(244,71,71,0.12); color: #f44747;
      border: 1px solid rgba(244,71,71,0.35); border-radius: 3px;
      cursor: pointer; white-space: nowrap;
    }
    .smart-fix-btn:hover { background: rgba(244,71,71,0.22); }
    .fix-all-btn {
      height: 22px; padding: 0 8px; font-size: 10px; font-weight: 600;
      background: rgba(244,71,71,0.1); color: #f44747;
      border: 1px solid rgba(244,71,71,0.3); border-radius: 999px;
      cursor: pointer; white-space: nowrap;
    }
    .fix-all-btn:hover { background: rgba(244,71,71,0.2); }
    .item-subtitle.token-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      opacity: 0.7;
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

    /* ── Live output panel ────────────────────────────────── */
    .plan-live-panel {
      margin: 0 0 6px;
      border-radius: 6px;
      border: 1px solid rgba(76,175,80,0.3);
      background: rgba(76,175,80,0.05);
      overflow: hidden;
      flex-shrink: 0;
    }
    .plan-live-header {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 8px 4px;
      font-size: 11px; font-weight: 600; color: #4caf50;
      border-bottom: 1px solid rgba(76,175,80,0.15);
    }
    .plan-live-pulse {
      width: 7px; height: 7px; border-radius: 50%;
      background: #4caf50; flex-shrink: 0;
      animation: livePulse 1.2s ease-in-out infinite;
    }
    @keyframes livePulse {
      0%,100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.45; transform: scale(0.75); }
    }
    .plan-live-task { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .plan-live-dash-link {
      font-size: 9px; font-weight: 400; color: var(--vscode-descriptionForeground);
      cursor: pointer; white-space: nowrap; text-decoration: underline; opacity: 0.7;
    }
    .plan-live-dash-link:hover { opacity: 1; }
    .plan-live-output {
      padding: 4px 8px 5px;
      display: flex; flex-direction: column; gap: 1px;
    }
    .plan-live-line {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; line-height: 1.45;
      color: var(--vscode-foreground);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .plan-live-line.old { opacity: 0.4; }
    .plan-live-line.mid { opacity: 0.7; }

    .chat-screen { display: none; flex-direction: column; gap: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; }
    .chat-screen.active { display: flex; flex: 1; }
    .prd-input-screen {
      display: none; flex-direction: column; flex: 1; padding: 0;
      background: var(--vscode-sideBar-background, #1e1e1e);
      position: absolute; inset: 35px 0 0 0; z-index: 50;
    }
    .prd-input-screen.active { display: flex; }
    .prd-input-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px 6px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      flex-shrink: 0;
    }
    .prd-back-btn {
      background: none; border: none; cursor: pointer;
      color: var(--vscode-descriptionForeground); padding: 2px 4px; border-radius: 3px;
      font-size: 13px; line-height: 1; display: flex; align-items: center;
    }
    .prd-back-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .prd-input-title {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--vscode-foreground);
    }
    .prd-input-body {
      flex: 1; display: flex; flex-direction: column; gap: 8px;
      padding: 10px; overflow: hidden;
    }
    .prd-input-hint {
      font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4;
    }
    .prd-textarea {
      resize: none; width: 100%; box-sizing: border-box;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px; padding: 8px; font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      line-height: 1.5; outline: none;
      min-height: 80px; max-height: 220px; overflow-y: auto;
    }
    .prd-textarea:focus { border-color: var(--vscode-focusBorder, #0078d4); }
    .prd-input-footer {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; flex-shrink: 0; padding-top: 2px;
    }
    .prd-browse-btn {
      font-size: 11px; padding: 5px 10px;
      background: transparent;
      border: 1px solid var(--vscode-button-border, #555);
      color: var(--vscode-descriptionForeground); border-radius: 4px; cursor: pointer;
    }
    .prd-browse-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
    .prd-generate-btn {
      font-size: 11px; padding: 5px 14px;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 4px; cursor: pointer; font-weight: 600;
    }
    .prd-generate-btn:disabled { opacity: 0.45; cursor: default; }
    .prd-generate-btn:not(:disabled):hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .prd-char-count { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .prd-version-bar {
      display: none; align-items: center; gap: 6px; flex-shrink: 0;
      padding: 0 10px 6px; font-size: 10px; color: var(--vscode-descriptionForeground);
    }
    .prd-version-bar.visible { display: flex; }
    .prd-version-select {
      font-size: 10px; padding: 2px 6px; border-radius: 3px; cursor: pointer;
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ccc);
      border: 1px solid var(--vscode-dropdown-border, #555);
    }
    .prd-version-save-btn {
      font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer;
      background: transparent; border: 1px solid var(--vscode-button-border, #555);
      color: var(--vscode-descriptionForeground);
    }
    .prd-version-save-btn:hover { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
    .prd-textarea-wrap { flex-shrink: 0; }
    .prd-ai-btn {
      font-size: 10px; padding: 4px 10px; border-radius: 3px; cursor: pointer;
      background: rgba(0,120,212,0.15); border: 1px solid rgba(0,120,212,0.4);
      color: var(--vscode-textLink-foreground, #4fc3f7); white-space: nowrap;
    }
    .prd-ai-btn:hover { background: rgba(0,120,212,0.28); }
    .prd-ai-btn:disabled { opacity: 0.5; cursor: default; }
    .prd-project-card {
      display: flex; align-items: center; gap: 5px; flex-shrink: 0;
      padding: 5px 8px; border-radius: 4px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
      font-size: 10px;
    }
    .prd-project-name { font-weight: 600; color: var(--vscode-foreground); }
    .prd-project-stack { color: var(--vscode-descriptionForeground); }
    .prd-chips-row { display: flex; flex-wrap: wrap; gap: 4px; flex-shrink: 0; }
    .prd-chip {
      font-size: 10px; padding: 2px 9px; border-radius: 10px; cursor: pointer;
      background: transparent;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      color: var(--vscode-descriptionForeground); white-space: nowrap;
    }
    .prd-chip:hover { border-color: rgba(0,120,212,0.6); color: var(--vscode-foreground); }
    .prd-browser-btn {
      font-size: 11px; padding: 5px 9px;
      background: transparent; border: 1px solid var(--vscode-button-border, #555);
      color: var(--vscode-descriptionForeground); border-radius: 4px; cursor: pointer;
    }
    .prd-browser-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
    .history-tools {
      display: none;
      align-items: center;
      flex-wrap: nowrap;
      gap: 4px;
      margin-bottom: 6px;
      padding: 0 2px;
    }
    .history-tools.active { display: flex; }
    .tool-select {
      height: 22px;
      padding: 0 4px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      font-size: 10px;
      max-width: 96px;
      font-family: var(--vscode-font-family);
    }
    .history-status-chips {
      display: inline-flex; gap: 3px; margin-left: auto;
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
    .plan-overview-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 4px;
    }
    .plan-overview-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 0;
      min-width: 0;
      flex: 1;
    }
    .gh-sync-header-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 10px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
      max-width: 120px;
    }
    .gh-sync-header-indicator:hover { background: rgba(255,255,255,0.1); }
    .gh-sync-header-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .gh-sync-header-dot.active { background: #3fb950; }
    .gh-sync-header-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .gh-sync-header-connect { color: var(--vscode-textLink-foreground); }
    .gh-sync-auth-row { display: flex; align-items: center; gap: 5px; padding: 4px 0 2px 0; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .gh-sync-auth-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .gh-sync-auth-dot.ok { background: #3fb950; }
    .gh-sync-auth-label { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .gh-sync-auth-warn { color: #f85149; }
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
    .plan-overview-fill.has-failed { background: linear-gradient(90deg, #4fa3ff 0%, #e09d4a 100%); }
    .plan-overview-meta-failed { color: #e09d4a; font-size: 10px; margin-top: 1px; }
    .plan-overview.done .plan-overview-fill { background: var(--ds-success, #3fb950); }
    .plan-done-banner { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; padding: 5px 8px; border-radius: 6px; background: rgba(63,185,80,0.08); border: 1px solid rgba(63,185,80,0.25); gap: 8px; }
    .plan-done-check { font-size: 11px; font-weight: 600; color: var(--ds-success, #3fb950); white-space: nowrap; }
    .plan-done-actions { display: flex; gap: 5px; flex-shrink: 0; }
    .plan-done-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; cursor: pointer; border: 1px solid rgba(63,185,80,0.5); background: rgba(63,185,80,0.15); color: var(--ds-success, #3fb950); }
    .plan-done-btn.ghost { background: transparent; border-color: rgba(255,255,255,0.15); color: var(--vscode-descriptionForeground); }
    .plan-done-btn:hover { opacity: 0.85; }
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
    .plan-tools.plan-state-running { border-left: 2px solid #4caf50; padding-left: 6px; }
    .plan-tools.plan-state-paused { border-left: 2px solid #cca700; padding-left: 6px; }
    .plan-tools.plan-state-stopping { border-left: 2px solid #f0a040; padding-left: 6px; }
    .plan-tools.plan-state-failed { border-left: 2px solid var(--vscode-testing-iconFailed, #f14c4c); padding-left: 6px; }
    .plan-tools.plan-state-completed { border-left: 2px solid var(--vscode-testing-iconPassed, #73c991); padding-left: 6px; }
    .workflow-stepper {
      display: flex; align-items: center; gap: 0;
      padding: 2px 0 4px; overflow: hidden; flex-wrap: nowrap;
    }
    .workflow-step {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px;
      color: var(--vscode-descriptionForeground); opacity: 0.35;
      white-space: nowrap; flex-shrink: 0;
    }
    .workflow-step.done { opacity: 0.55; color: var(--vscode-testing-iconPassed, #73c991); }
    .workflow-step.active { opacity: 1; color: var(--vscode-foreground); font-weight: 600; }
    .workflow-step-dot {
      width: 13px; height: 13px; border-radius: 50%;
      background: var(--vscode-panel-border, rgba(128,128,128,0.25));
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 7px; font-weight: 700; flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
    }
    .workflow-step.done .workflow-step-dot { background: var(--vscode-testing-iconPassed, #73c991); color: #fff; }
    .workflow-step.active .workflow-step-dot { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .workflow-step-sep {
      width: 8px; height: 1px; flex-shrink: 0;
      background: var(--vscode-panel-border, rgba(128,128,128,0.25));
      margin: 0 1px;
    }
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
      border-radius: 999px;
      padding: 1px 5px;
      background: rgba(128,128,128,0.1);
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
    .plan-runner-badge:not(.running):not(.paused):not(.stopping) { display: none; }
    .plan-prd-badge {
      display: none;
      align-items: center;
      gap: 3px;
      font-size: 9px;
      border: 1px solid rgba(0,120,212,0.45);
      border-radius: 999px;
      padding: 1px 7px;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      color: #5cb3f0;
      background: rgba(0,120,212,0.1);
      cursor: pointer;
      white-space: nowrap;
    }
    .plan-prd-badge.visible { display: inline-flex; }
    .plan-prd-badge:hover { background: rgba(0,120,212,0.2); border-color: rgba(0,120,212,0.7); }
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
    #planRulesSection { display: none; }
    #planRulesSection.active { display: block; }
    #tttCriteriaSection { display: none; padding: 6px 8px 4px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
    #tttCriteriaSection.active { display: block; }
    .ttt-header { font-size: 10px; font-weight: 700; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
    .ttt-header-badge { background: #0078d4; color: #fff; font-size: 9px; padding: 1px 5px; border-radius: 8px; }
    .ttt-criterion { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; font-size: 12px; cursor: pointer; }
    .ttt-criterion input[type=checkbox] { margin-top: 2px; flex-shrink: 0; cursor: pointer; }
    .ttt-criterion.checked span { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
    #tttVerifyBtn { display: none; margin-top: 6px; width: 100%; background: #0078d4; color: #fff; border: none; border-radius: 3px; padding: 5px 0; font-size: 12px; cursor: pointer; }
    #tttVerifyBtn:hover { background: #106ebe; }
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
    .plan-menu-item-prd {
      border-top: 1px solid var(--vscode-widget-border, #444);
      color: var(--vscode-textLink-foreground, #4fc3f7);
      margin-top: 2px;
    }
    .plan-menu-item-prd:hover {
      color: var(--vscode-textLink-activeForeground, #74d7fb);
    }
    .chat-empty-prd-btn {
      display: inline-block;
      padding: 5px 12px;
      font-size: 11px;
      background: transparent;
      border: 1px solid var(--vscode-button-border, #555);
      color: var(--vscode-textLink-foreground, #4fc3f7);
      border-radius: 4px;
      cursor: pointer;
    }
    .chat-empty-prd-btn:hover {
      background: rgba(0,122,204,0.1);
      border-color: var(--vscode-focusBorder);
    }
    .chat-empty-start-prd-btn {
      display: inline-block;
      padding: 5px 12px;
      font-size: 11px;
      background: var(--vscode-button-background, #0078d4);
      border: none;
      color: var(--vscode-button-foreground, #fff);
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
    }
    .chat-empty-start-prd-btn:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .prd-mode-header {
      display: none; align-items: center; justify-content: space-between;
      padding: 5px 10px 4px;
      background: rgba(0,120,212,0.08);
      border-bottom: 1px solid rgba(0,120,212,0.25);
      flex-shrink: 0;
    }
    .prd-mode-header.active { display: flex; }
    .prd-mode-badge {
      font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
      color: #4fc3f7; text-transform: uppercase;
      display: flex; align-items: center; gap: 5px;
    }
    .prd-mode-badge::before {
      content: ''; display: inline-block; width: 7px; height: 7px;
      border-radius: 50%; background: #4fc3f7;
    }
    .prd-mode-cancel {
      font-size: 10px; background: none; border: none;
      color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px;
      border-radius: 3px;
    }
    .prd-mode-cancel:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .prd-msg { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; }
    .prd-msg.prd-bot { background: rgba(0,120,212,0.06); border-left: 2px solid #0078d4; }
    .prd-msg.prd-user { align-items: flex-end; }
    .prd-msg-author { font-size: 9px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
    .prd-msg-text { font-size: 12px; line-height: 1.5; color: var(--vscode-foreground); white-space: pre-wrap; }
    .prd-msg.prd-user .prd-msg-text {
      background: rgba(128,128,128,0.1); border-radius: 6px 6px 0 6px;
      padding: 6px 10px; max-width: 90%; font-size: 11px;
    }
    .prd-convert-wrap { padding: 12px 10px 6px; display: flex; flex-direction: column; gap: 6px; }
    .prd-convert-note { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .prd-convert-btn {
      padding: 8px 16px; background: #0078d4; color: #fff;
      border: none; border-radius: 5px; cursor: pointer; font-weight: 600; font-size: 12px;
      display: flex; align-items: center; gap: 6px; align-self: flex-start;
    }
    .prd-convert-btn:hover { background: #026ec1; }
    .prd-typing { display: flex; align-items: center; gap: 4px; padding: 10px 10px; }
    .prd-typing span {
      width: 5px; height: 5px; border-radius: 50%;
      background: #4fc3f7; animation: prd-bounce 1.2s infinite;
    }
    .prd-typing span:nth-child(2) { animation-delay: 0.2s; }
    .prd-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes prd-bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-5px)} }
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
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
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
      width: 22px; height: 22px;
      border: none; border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .plan-group-play:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .plan-group-play.running { color: #cca700; }
    .plan-group-play.running:hover { background: rgba(204,167,0,0.12); }
    .plan-group-rules-btn {
      width: 18px; height: 18px;
      border: none; border-radius: 3px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      opacity: 0.35;
    }
    .plan-group-rules-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .plan-group-rules-btn.has-rules { opacity: 1; color: var(--vscode-focusBorder, #4fa3ff); }
    .prd-pill-btn {
      height: 16px; padding: 0 5px;
      border: none; border-radius: 999px;
      background: rgba(79,163,255,0.15);
      color: var(--vscode-textLink-foreground, #4fa3ff);
      font-size: 9px; font-weight: 600; letter-spacing: .03em;
      cursor: pointer; flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 3px;
      opacity: 0.8;
    }
    .prd-pill-btn:hover { opacity: 1; background: rgba(79,163,255,0.25); }
    .issue-badge {
      display: inline-flex; align-items: center;
      margin-left: 4px; padding: 0 4px;
      height: 14px; border-radius: 999px;
      background: rgba(79,163,255,0.12);
      color: var(--vscode-textLink-foreground, #4fa3ff);
      font-size: 9px; font-weight: 600;
      cursor: pointer; flex-shrink: 0;
      vertical-align: middle;
    }
    .issue-badge:hover { background: rgba(79,163,255,0.25); text-decoration: underline; }
    .gh-sync-status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      flex-shrink: 0; margin-left: auto;
    }
    .gh-sync-status-dot.active { background: #4caf50; box-shadow: 0 0 4px rgba(76,175,80,0.6); }
    .gh-sync-status-dot.error  { background: #f44747; }
    .gh-sync-repo { font-size: 10px; font-weight: 600; color: var(--vscode-textLink-foreground, #4fa3ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .gh-sync-last { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .gh-sync-count { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .gh-sync-input-row, .gh-sync-label-row { flex-direction: column; align-items: stretch; gap: 3px; }
    .gh-sync-label-row { flex-direction: row; align-items: center; gap: 6px; }
    .gh-sync-input {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      color: var(--vscode-input-foreground);
      font-size: 11px; padding: 3px 6px; border-radius: 3px;
      width: 100%; box-sizing: border-box; font-family: inherit;
    }
    .gh-sync-input:focus { outline: 1px solid var(--vscode-focusBorder, #4fa3ff); border-color: transparent; }
    .gh-sync-input-sm { width: 70px; flex-shrink: 0; }
    .gh-sync-toggle-wrap { display: flex; align-items: center; margin-left: auto; }
    .gh-sync-toggle-label { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
    .gh-sync-toggle-label input[type="checkbox"] { width: 28px; height: 14px; appearance: none; background: var(--vscode-input-border, rgba(128,128,128,0.3)); border-radius: 999px; cursor: pointer; position: relative; flex-shrink: 0; transition: background 0.15s; }
    .gh-sync-toggle-label input[type="checkbox"]:checked { background: #4caf50; }
    .gh-sync-toggle-label input[type="checkbox"]::after { content: ''; position: absolute; width: 10px; height: 10px; border-radius: 50%; background: white; top: 2px; left: 2px; transition: left 0.15s; }
    .gh-sync-toggle-label input[type="checkbox"]:checked::after { left: 16px; }
    .gh-sync-toggle-text { font-size: 9px; color: var(--vscode-descriptionForeground); min-width: 18px; }
    .rules-edit-panel {
      padding: 6px 8px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    }
    .rules-edit-panel textarea {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 3px;
      padding: 4px 6px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      resize: vertical;
      min-height: 60px;
    }
    .rules-edit-panel label {
      display: block;
      font-size: 9px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      letter-spacing: 0.05em;
    }
    .rules-edit-btns {
      display: flex;
      gap: 4px;
      margin-top: 4px;
      justify-content: flex-end;
    }
    .rules-edit-btns button {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      background: transparent;
      color: var(--vscode-foreground);
    }
    .rules-edit-btns .rules-save-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
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
    .selection-mode-hint {
      display: none;
      font-size: 9px;
      color: var(--vscode-focusBorder, #4fa3ff);
      opacity: 0.8;
      margin-left: 4px;
    }
    .plan-selection-mode + * .selection-mode-hint,
    .selection-active .selection-mode-hint { display: inline; }
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
      gap: 1px;
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
      width: 20px; height: 20px;
      border: none; border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0;
    }
    .task-act-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .task-act-btn.running {
      border-color: rgba(204,167,0,0.5);
      color: #cca700;
      background: rgba(204,167,0,0.12);
    }
    .task-edit-panel {
      padding: 8px 12px 10px 20px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
      background: var(--vscode-sideBar-background);
    }
    .task-edit-form { display: flex; flex-direction: column; gap: 6px; }
    .task-edit-name, .task-edit-prompt {
      font-size: 12px;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 3px;
      outline: none;
      width: 100%;
      box-sizing: border-box;
    }
    .task-edit-name:focus, .task-edit-prompt:focus { border-color: var(--vscode-focusBorder); }
    .task-edit-prompt {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      resize: vertical;
      min-height: 80px;
    }
    .task-edit-btns { display: flex; gap: 6px; justify-content: flex-end; }
    .task-edit-save {
      font-size: 10px; padding: 3px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 3px; cursor: pointer;
    }
    .task-edit-save:hover { background: var(--vscode-button-hoverBackground); }
    .task-edit-cancel {
      font-size: 10px; padding: 3px 10px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 3px; cursor: pointer;
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

    /* ─── Extras strip (AI Rules + Sandbox side-by-side) ─── */
    .extras-strip {
      display: flex; flex-direction: row; flex-shrink: 0;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .extras-seg {
      display: none; flex: 1; flex-direction: column; min-width: 0;
      padding: 2px 8px 0;
    }
    .extras-seg + .extras-seg {
      border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .extras-seg.active { display: flex; }

    /* ── AI Rules section ── */
    .sidebar-rules { }
    .sidebar-rules-head {
      display: flex; align-items: center; width: 100%; gap: 2px;
    }
    .sidebar-rules-toggle {
      display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0;
      background: transparent; border: none; cursor: pointer;
      padding: 3px 0; color: var(--vscode-foreground); opacity: 0.75;
    }
    .sidebar-rules-toggle:hover { opacity: 1; }
    .sidebar-rules-icon { font-size: 10px; width: 14px; text-align: center; transition: transform 0.1s; }
    .sidebar-rules-toggle.collapsed .sidebar-rules-icon { transform: rotate(-90deg); }
    .sidebar-rules-label { font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .sidebar-rules-badge {
      font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 999px;
      border: 1px solid transparent; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .sidebar-rules-badge.has-active { border-color: rgba(79,163,255,0.5); color: #4fa3ff; background: rgba(79,163,255,0.1); }
    .sidebar-rules-hd-btns { display: flex; gap: 2px; margin-left: auto; }
    .sidebar-rules-hd-btn {
      width: 20px; height: 20px; border: none; background: transparent;
      color: var(--vscode-descriptionForeground); cursor: pointer; border-radius: 3px;
      display: inline-flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1;
    }
    .sidebar-rules-hd-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .sidebar-rules-body { padding: 4px 0 6px; max-height: 160px; overflow-y: auto; }
    .sidebar-rules-body.collapsed { display: none; }
    .sidebar-rules-list { display: flex; flex-direction: column; gap: 1px; }
    .sidebar-rules-empty { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 2px; }
    .rule-item {
      display: flex; align-items: center; gap: 5px; padding: 3px 2px;
      border-radius: 4px; min-width: 0;
    }
    .rule-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.07)); }
    .rule-item:hover .rule-actions { opacity: 1; }
    .rule-toggle {
      width: 16px; height: 16px; border-radius: 3px; border: 1px solid rgba(128,128,128,0.4);
      background: transparent; cursor: pointer; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center; font-size: 10px; color: #4fa3ff;
    }
    .rule-toggle.enabled { background: rgba(79,163,255,0.15); border-color: rgba(79,163,255,0.6); }
    .rule-toggle.enabled::after { content: '✓'; }
    .rule-name { font-size: 11px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rule-name.disabled { opacity: 0.45; }
    .rule-scope-badge {
      font-size: 9px; padding: 0px 4px; border-radius: 3px; flex-shrink: 0;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px;
    }
    .rule-scope-badge.workspace { border-color: rgba(62,191,106,0.4); color: #3ebf6a; background: rgba(62,191,106,0.1); }
    .rule-actions { display: flex; gap: 1px; opacity: 0; transition: opacity 0.1s; flex-shrink: 0; }
    .rule-action-btn {
      width: 18px; height: 18px; border: none; background: transparent;
      cursor: pointer; border-radius: 3px; display: flex; align-items: center;
      justify-content: center; font-size: 10px; color: var(--vscode-descriptionForeground);
    }
    .rule-action-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .rule-action-btn.delete:hover { color: #f44747; }

    .sidebar-sandbox { }
    .sidebar-sandbox-toggle {
      display: flex; align-items: center; gap: 4px; width: 100%;
      border: none; background: none; cursor: pointer; user-select: none;
      color: var(--vscode-foreground); padding: 3px 0; font-size: 11px;
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
    .sidebar-sandbox-body { padding: 3px 0 4px; }
    .sidebar-sandbox-body.collapsed { display: none; }
    .sidebar-sandbox-row { display: flex; align-items: center; gap: 4px; padding: 1px 0; flex-wrap: nowrap; overflow: hidden; }
    .sidebar-sandbox-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(128,128,128,0.4); flex-shrink: 0; }
    .sidebar-sandbox-dot.running { background: #4caf50; }
    .sidebar-sandbox-dot.starting { background: #cca700; animation: sbPulse 1.2s ease-in-out infinite; }
    .sidebar-sandbox-dot.error { background: #f44747; }
    @keyframes sbPulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    .sidebar-sandbox-status { font-size: 9px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .sidebar-sandbox-framework { font-size: 9px; font-weight: 600; flex-shrink: 0; }
    .sidebar-sandbox-url {
      font-size: 9px; color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sidebar-sandbox-url:hover { text-decoration: underline; }
    .sidebar-sandbox-actions { display: flex; gap: 3px; padding: 2px 0; flex-wrap: wrap; }
    .sb-tool-row { margin-top: 2px; gap: 6px; }
    .sb-tool-label { font-size: 9px; color: var(--vscode-descriptionForeground); flex-shrink: 0; white-space: nowrap; }
    .sb-tool-select { flex: 1; font-size: 9px; background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #ccc); border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 3px; padding: 1px 3px; cursor: pointer; min-width: 0; }
    .sb-ttt-hint { font-size: 9px; padding: 2px 0; }
    .sb-ttt-hint.ok { color: #4caf50; }
    .sb-ttt-hint.warn { color: #cca700; }

    /* ── Test & Verify panel ── */
    #tavPanel {
      display: none; flex-direction: column; flex-shrink: 0;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    #tavPanel.active { display: flex; }
    .tav-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 5px 10px 4px; cursor: pointer; user-select: none;
    }
    .tav-header:hover { background: rgba(128,128,128,0.06); }
    .tav-title {
      font-size: 9px; font-weight: 700; letter-spacing: 0.6px;
      text-transform: uppercase; color: var(--vscode-descriptionForeground);
      display: flex; align-items: center; gap: 5px;
    }
    .tav-state-badge {
      font-size: 8px; padding: 1px 6px; border-radius: 999px; font-weight: 600;
      border: 1px solid rgba(128,128,128,0.3); color: var(--vscode-descriptionForeground);
      text-transform: uppercase; letter-spacing: 0.3px;
    }
    .tav-state-badge.running { color: #4caf50; border-color: rgba(76,175,80,0.5); background: rgba(76,175,80,0.1); }
    .tav-state-badge.done { color: #73c991; border-color: rgba(115,201,145,0.5); background: rgba(115,201,145,0.08); }
    .tav-state-badge.warn { color: #cca700; border-color: rgba(204,167,0,0.4); background: rgba(204,167,0,0.08); }
    .tav-body {
      display: flex; flex-direction: column; gap: 0;
      padding: 0 10px 8px; overflow: hidden;
    }
    .tav-body.collapsed { display: none; }
    .tav-row {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 0; min-height: 22px;
    }
    .tav-row + .tav-row { border-top: 1px solid rgba(128,128,128,0.07); }
    .tav-label {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      flex-shrink: 0; min-width: 72px;
    }
    .tav-select {
      flex: 1; font-size: 10px;
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ccc);
      border: 1px solid var(--vscode-dropdown-border, #555);
      border-radius: 3px; padding: 2px 4px; cursor: pointer; min-width: 0;
    }
    .tav-sb-row { gap: 5px; }
    .tav-sb-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: rgba(128,128,128,0.3); }
    .tav-sb-dot.running { background: #4caf50; }
    .tav-sb-dot.starting { background: #cca700; animation: sbPulse 1.2s ease-in-out infinite; }
    .tav-sb-dot.error { background: #f44747; }
    .tav-sb-status { font-size: 10px; flex: 1; color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tav-sb-url { font-size: 10px; color: #4caf50; text-decoration: none; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .tav-sb-url:hover { text-decoration: underline; }
    .tav-btn {
      font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer; flex-shrink: 0;
      border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.4));
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .tav-btn:hover { opacity: 0.85; }
    .tav-btn.primary { background: #0078d4; border-color: #0078d4; color: #fff; }
    .tav-btn.primary:hover { background: #026ec1; }
    .tav-hint {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      font-style: italic; flex: 1;
    }
    .tav-hint.warn { color: #cca700; font-style: normal; }
    .tav-hint.ok { color: #4caf50; font-style: normal; }
    .tav-prd-val { font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tav-criteria-wrap { display: flex; flex-direction: column; gap: 2px; padding: 3px 0 2px; max-height: 120px; overflow-y: auto; }
    .tav-criterion { display: flex; align-items: flex-start; gap: 5px; padding: 1px 0; }
    .tav-criterion input[type=checkbox] { margin-top: 1px; flex-shrink: 0; accent-color: #4caf50; }
    .tav-criterion-text { font-size: 10px; line-height: 1.4; color: var(--vscode-foreground); }
    .tav-criterion.checked .tav-criterion-text { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
    .tav-verify-btn {
      margin-top: 5px; padding: 5px 0; background: #0078d4; color: #fff;
      border: none; border-radius: 4px; font-size: 11px; font-weight: 600;
      cursor: pointer; width: 100%; text-align: center;
    }
    .tav-verify-btn:hover { background: #026ec1; }
    .tav-verify-btn:disabled { opacity: 0.4; cursor: default; }
    .tav-fix-iter { margin-top: 4px; font-size: 10px; color: var(--vscode-descriptionForeground); text-align: center; padding: 2px 0; }
    .tav-fix-iter.active { color: #e09d4a; font-weight: 600; }
    .tav-chevron { font-size: 9px; color: var(--vscode-descriptionForeground); transition: transform 0.15s; }
    .tav-header.collapsed .tav-chevron { transform: rotate(-90deg); }
    .sb-btn {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      background: transparent; color: var(--vscode-descriptionForeground);
      border-radius: 999px; padding: 1px 6px; font-size: 9px;
      cursor: pointer; text-transform: uppercase; white-space: nowrap;
    }
    .sb-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
    .sb-btn.primary {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .sb-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
    .sb-thumb { width: 100%; max-height: 100px; object-fit: contain; border-radius: 3px; margin-top: 4px; display: none; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); cursor: pointer; }

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
    .chat-header { display: none; }

    .chat-feed { display: flex; flex-direction: column; justify-content: flex-end; gap: 0; padding: 0; flex: 1; }
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
    .result-tokens {
      color: var(--vscode-descriptionForeground);
      opacity: 0.75;
      cursor: default;
    }

    /* ─── Active File Pill ─── */
    .file-pill-row {
      display: flex; align-items: center; gap: 4px;
      padding: 2px 8px 0; min-height: 20px;
    }
    .file-pill {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; padding: 2px 7px; border-radius: 10px;
      background: rgba(0,120,212,0.12);
      color: var(--vscode-textLink-foreground);
      border: 1px solid rgba(0,120,212,0.22);
      max-width: 200px; cursor: default;
    }
    .file-pill-icon { flex-shrink: 0; opacity: 0.75; }
    .file-pill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-pill-dismiss {
      flex-shrink: 0; opacity: 0.55; cursor: pointer;
      border: none; background: none; padding: 0; color: inherit;
      font-size: 11px; line-height: 1;
    }
    .file-pill-dismiss:hover { opacity: 1; }
    .file-pill-hint { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.6; }

    /* ─── Live Output Block ─── */
    .live-output-block {
      margin: 6px 0 2px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      overflow: hidden;
    }
    .live-output-header {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 10px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.05));
    }
    .live-output-task-name {
      flex: 1; font-size: 11px; font-weight: 600;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .live-output-badge {
      font-size: 10px; padding: 1px 7px; border-radius: 10px;
      background: rgba(0,120,212,0.15); color: var(--vscode-textLink-foreground);
    }
    .live-output-badge.running {
      animation: live-pulse 1.4s ease-in-out infinite;
    }
    @keyframes live-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
    .live-output-badge.completed {
      background: rgba(76,175,80,0.18); color: #4caf50; animation: none;
    }
    .live-output-badge.failed {
      background: rgba(244,71,71,0.18); color: #f44747; animation: none;
    }
    .live-output-body {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; line-height: 1.45;
      padding: 6px 10px; margin: 0;
      background: var(--vscode-terminal-background, rgba(0,0,0,0.25));
      color: var(--vscode-terminal-foreground, inherit);
      max-height: 140px; overflow-y: auto;
      white-space: pre-wrap; word-break: break-all;
    }

    .composer {
      flex-shrink: 0;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      padding: 6px 8px 4px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: var(--vscode-editorWidget-background, transparent);
    }
    .context-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 1px 2px 0;
      flex-wrap: nowrap;
      overflow: hidden;
      white-space: nowrap;
      min-height: 14px;
    }
    .ctx-chip {
      border: none;
      padding: 0;
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ctx-sep {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.5;
    }
    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      padding: 4px 6px;
      gap: 6px;
    }
    .composer-toolbar-left {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      flex: 1;
      overflow: hidden;
    }
    .composer-toolbar-right {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }
    .composer-toolbar select {
      height: 20px;
      padding: 0 4px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      font-size: 10px;
      font-family: var(--vscode-font-family);
      max-width: 110px;
      width: auto;
    }
    .composer-toolbar .char-count {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
      white-space: nowrap;
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
    .textarea-row { display: block; }
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
      width: 100%;
      min-height: 36px;
      max-height: 200px;
      resize: none;
      border: none;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      line-height: 1.45;
      padding: 6px 10px;
      overflow-y: hidden;
      box-sizing: border-box;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    textarea:disabled { opacity: 0.6; cursor: not-allowed; }
    .run-btn {
      height: 26px;
      border: none;
      border-radius: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 0 10px;
      white-space: nowrap;
    }
    .run-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .run-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .attach-btn {
      height: 24px;
      width: 24px;
      padding: 0;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .attach-btn svg { width: 13px; height: 13px; flex-shrink: 0; }
    .attach-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .attach-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .gen-plan-btn {
      height: 24px;
      padding: 0 8px;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .gen-plan-btn svg { width: 11px; height: 11px; flex-shrink: 0; }
    .gen-plan-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .gen-plan-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .composer-prd-btn.has-prd { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
    .add-to-plan-btn {
      height: 24px; padding: 0 7px; font-size: 11px;
      background: transparent; color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35)); border-radius: 4px;
      cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;
      flex-shrink: 0;
    }
    .add-to-plan-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .add-to-plan-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .char-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 0 2px;
      min-height: 12px;
    }
    select {
      height: 22px; padding: 0 6px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      font-size: 11px; font-family: var(--vscode-font-family); width: 100%;
    }
    select:disabled { opacity: 0.6; cursor: not-allowed; }
    /* context bar → minimal status footer */
    .context-bar { display: flex; align-items: center; gap: 4px; padding: 1px 2px 0; flex-wrap: nowrap; overflow: hidden; }
    .ctx-chip { font-size: 9px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
    .composer-hint { font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0.75; padding: 0 2px 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .composer-hint.fix-mode { opacity: 1; color: #4fa3ff; }
    /* Smart Fix prominence bar */
    .plan-status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
      background: var(--vscode-sideBar-background, transparent);
    }
    .plan-filter-chips { display: flex; align-items: center; gap: 3px; }
    .status-chip {
      height: 18px; padding: 0 7px; font-size: 9px; font-weight: 600;
      background: transparent; color: var(--vscode-descriptionForeground);
      border: 1px solid rgba(128,128,128,0.25); border-radius: 999px;
      cursor: pointer; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .status-chip:hover { background: rgba(128,128,128,0.1); }
    .status-chip.active { background: rgba(79,163,255,0.15); color: #4fa3ff; border-color: rgba(79,163,255,0.4); }
    .status-chip[data-plan-filter="failed"].active { background: rgba(244,71,71,0.12); color: #f44747; border-color: rgba(244,71,71,0.3); }
    .plan-fix-bar-btn {
      height: 20px; padding: 0 9px; font-size: 9px; font-weight: 700;
      background: rgba(244,71,71,0.18); color: #f14c4c;
      border: 1px solid rgba(244,71,71,0.5); border-radius: 999px;
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
    }
    .plan-fix-bar-btn:hover { background: rgba(244,71,71,0.32); }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="tabs">
      <button class="tab active" data-tab="chat" type="button" title="Chat">
        <svg class="tab-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M1 3c0-.6.4-1 1-1h12c.6 0 1 .4 1 1v8c0 .6-.4 1-1 1H9l-2 2-2-2H2c-.6 0-1-.4-1-1V3z"/></svg>
        <span class="tab-label">Chat</span>
      </button>
      <button class="tab" data-tab="plan" type="button" title="Plan">
        <svg class="tab-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M3 4h1v1H3V4zm3 0h7v1H6V4zm-3 4h1v1H3V8zm3 0h7v1H6V8zm-3 4h1v1H3v-1zm3 0h7v1H6v-1z"/></svg>
        <span class="tab-label">Plan</span>
      </button>
      <button class="tab" data-tab="history" type="button" title="History">
        <svg class="tab-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm0 1a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 2v3.75l2.75 1.5-.5.87L7 9.5V5h.5z"/></svg>
        <span class="tab-label">History</span>
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
      <button class="topbar-btn" id="reportIssueBtn" title="Report a MOAG bug to GitHub" aria-label="Report Bug">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm-.5 3.5h1v4h-1zm0 5h1v1h-1z"/></svg>
      </button>
      <button class="topbar-btn" id="settingsBtn" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 8A1.4 1.4 0 1 1 6.6 8 1.4 1.4 0 0 1 9.4 8z"/></svg>
      </button>
    </div>
  </div>

  <div class="content">
    <div id="prdInputScreen" class="prd-input-screen">
      <div class="prd-input-header">
        <button id="prdBackBtn" class="prd-back-btn" type="button" title="Cancel" aria-label="Cancel">&#8592;</button>
        <span id="prdInputTitle" class="prd-input-title">Generate Plan from PRD</span>
      </div>
      <div class="prd-version-bar" id="prdVersionBar">
        <span>Version:</span>
        <select id="prdVersionSelect" class="prd-version-select"></select>
        <button id="prdVersionSaveBtn" class="prd-version-save-btn" type="button">Save as v1.0</button>
      </div>
      <div class="prd-input-body">
        <div id="prdProjectCard" class="prd-project-card" style="display:none">
          <span>&#128230;</span>
          <span id="prdProjectName" class="prd-project-name"></span>
          <span id="prdProjectStack" class="prd-project-stack"></span>
        </div>
        <div id="prdInputHint" class="prd-input-hint">Paste a PRD or describe what you want to build &mdash; MOAG will generate a Design &rarr; Development &rarr; Testing plan.</div>
        <div class="prd-textarea-wrap">
          <textarea id="prdTextarea" class="prd-textarea" placeholder="Paste your PRD here, or describe what to build:&#10;&#10;Example: &quot;Build a REST API with auth, CRUD, and tests&quot;&#10;&#10;Or paste a full PRD document with Acceptance Criteria..."></textarea>
        </div>
        <div id="prdChipsRow" class="prd-chips-row">
          <button class="prd-chip" data-prompt="Build a REST API with authentication, CRUD endpoints, input validation, and unit tests">REST API</button>
          <button class="prd-chip" data-prompt="Build a SaaS web app with user authentication, dashboard, settings page, and billing integration">SaaS App</button>
          <button class="prd-chip" data-prompt="Build a mobile app with authentication, push notifications, offline support, and onboarding flow">Mobile App</button>
          <button class="prd-chip" data-prompt="Add comprehensive tests: unit tests for core modules, integration tests for key workflows, and coverage reporting">Add Tests</button>
        </div>
        <div class="prd-input-footer">
          <div style="display:flex;align-items:center;gap:6px">
            <button id="prdBrowseBtn" class="prd-browse-btn" type="button">Browse file&hellip;</button>
            <span id="prdCharCount" class="prd-char-count">0 chars</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <button id="prdAiBtn" class="prd-ai-btn" type="button">&#10024; Draft with AI</button>
            <button id="prdGenerateBtn" class="prd-generate-btn" type="button" disabled>Generate Plan &rarr;</button>
          </div>
        </div>
      </div>
    </div>
    <div id="chatScreen" class="chat-screen active">
      <div id="prdModeHeader" class="prd-mode-header">
        <span class="prd-mode-badge">PRD Draft in progress</span>
        <button id="prdModeCancelBtn" class="prd-mode-cancel" type="button">Cancel</button>
      </div>
      <div class="chat-header">
        <div id="chatTitle" class="chat-title">NEW CHAT</div>
      </div>
      <div id="chatFeed" class="chat-feed"></div>
      <div id="chatEmpty" class="item-tip" style="display:none">
        <strong>New conversation</strong> — type a prompt below to start.<br>
        Use the <strong>Plan</strong> tab to queue tasks or <strong>History</strong> to revisit past runs.<br><br>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button id="chatStartPrdBtn" class="chat-empty-start-prd-btn" type="button">&#128172; Draft PRD with AI</button>
          <button id="chatEmptyPrdBtn" class="chat-empty-prd-btn" type="button">&#128196; I have a PRD</button>
          <button id="chatEmptyTemplateBtn" class="chat-empty-prd-btn" type="button">&#x1F4CB; Start from template</button>
        </div>
      </div>
    </div>
    <div id="planTools" class="plan-tools">
      <div class="plan-tools-row">
        <div class="plan-tools-left">
          <span id="planActiveName" class="plan-active-name">Ad hoc</span>
          <span id="planExecCounter" class="plan-exec-counter">0/0</span>
          <span id="planRunnerBadge" class="plan-runner-badge">IDLE</span>
          <button id="planOpenPrdBtn" class="plan-prd-badge" type="button" title="Open source PRD">&#128196; PRD</button>
        </div>
        <div class="plan-tools-right">
          <div class="plan-tool-group">
            <button id="planPlayBtn" class="plan-tool-btn" type="button" title="Execute Plan" aria-label="Execute Plan">Execute</button>
            <button id="planRunPendingBtn" class="plan-tool-btn" type="button" title="Run Pending" aria-label="Run Pending">Run</button>

            <button id="planSearchBtn" class="plan-tool-btn icon-only" type="button" title="Search Tasks" aria-label="Search Tasks"><svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M6.5 1a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm4.986 5.5a4.5 4.5 0 1 0-4.986 4.486A4.5 4.5 0 0 0 11.486 6.5zM14 13l-2.5-2.5.707-.707L14.707 12.29z"/></svg></button>
            <button id="planSwitchQuickBtn" class="plan-tool-btn icon-only" type="button" title="Switch Plan" aria-label="Switch Plan"><svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M5 2l-4 4 4 4V7h5V5H5V2zm6 4v3h-5v2h5v3l4-4-4-4z"/></svg></button>
          </div>
          <div class="plan-tool-group">
            <div class="plan-manage-wrap">
              <button id="planManageBtn" class="plan-tool-btn icon-only" type="button" title="More Actions" aria-label="More Actions"><svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="14" cy="8" r="1.5"/></svg></button>
              <div id="planManageMenu" class="plan-manage-menu">
                <button id="planStopBtn" class="plan-menu-item" type="button">Stop</button>
                <button id="planRunSelectedBtn" class="plan-menu-item" type="button">Run Selected</button>
                <button id="planAddTaskBtn" class="plan-menu-item" type="button">Add Task</button>
                <button id="planSwitchBtn" class="plan-menu-item" type="button">Switch Plan</button>
                <button id="planNewBtn" class="plan-menu-item" type="button">New Plan</button>
                <button id="planFromTemplateBtn" class="plan-menu-item" type="button">&#x1F4CB; New from Template</button>
                <button id="planFromPrdBtn" class="plan-menu-item plan-menu-item-prd" type="button">&#128196; Generate from PRD</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="planStatusBar" class="plan-status-bar">
        <div id="planFilterChips" class="plan-filter-chips">
          <button type="button" class="status-chip active" data-plan-filter="all">All</button>
          <button type="button" class="status-chip" data-plan-filter="pending">Pending</button>
          <button type="button" class="status-chip" data-plan-filter="completed">Completed</button>
          <button type="button" class="status-chip" data-plan-filter="failed">Failed</button>
        </div>
        <button id="planFixAllBarBtn" class="plan-fix-bar-btn" type="button" style="display:none">Fix All</button>
      </div>
      <div id="planSearchBar" class="plan-search-bar">
        <input id="planSearchInput" class="plan-search-input" type="text" placeholder="Search tasks or playlists">
        <button id="planSearchClearBtn" class="plan-tool-btn" type="button" title="Clear Search" aria-label="Clear Search">Clear</button>
      </div>
    </div>
    <div id="planOverview" class="plan-overview">
      <div class="plan-overview-title-row">
        <div id="planOverviewTitle" class="plan-overview-title">Plan Progress</div>
        <div id="ghSyncHeaderIndicator" class="gh-sync-header-indicator" style="display:none"></div>
      </div>
      <div id="planOverviewMeta" class="plan-overview-meta">0/0 playlists, 0/0 tasks completed</div>
      <div class="plan-overview-bar"><div id="planOverviewFill" class="plan-overview-fill"></div></div>
      <div id="planOverviewFailedMeta" class="plan-overview-meta-failed" style="display:none"></div>
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
    <div id="planLivePanel" class="plan-live-panel" style="display:none"></div>
    <div id="planRulesSection"></div>
    <div id="planListHeading" class="plan-list-heading"><input id="planListSelectModeCb" type="checkbox" aria-label="Enable selection mode" title="Enable selection mode — check tasks/playlists for bulk actions (Run Selected, etc.)"><span>All Tasks</span><button id="planHeadingCollapseBtn" class="plan-tool-btn" type="button" title="Collapse All" aria-label="Collapse All">Collapse All</button></div>
    <div id="planList" class="list"></div>
    <div id="historyTools" class="history-tools">
      <select id="historyGroupBy" class="tool-select" title="Group by">
        <option value="none">Flat</option>
        <option value="plan">By plan</option>
        <option value="playlist">By playlist</option>
      </select>
      <div class="history-status-chips" id="historyStatusChips">
        <button type="button" class="chip active" data-status="all">All</button>
        <button type="button" class="chip" data-status="completed">Passed</button>
        <button type="button" class="chip" data-status="failed">Failed</button>
      </div>
    </div>
    <div id="historyList" class="list"></div>
    <div id="listEmpty" class="empty"></div>
  </div>

  <!-- Test & Verify panel — full-width, PLAN tab only -->
  <div id="tavPanel">
    <div class="tav-header" id="tavHeader">
      <span class="tav-title">&#x1F9EA; Test &amp; Verify</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span class="tav-state-badge" id="tavStateBadge">Idle</span>
        <span class="tav-chevron">&#x25BC;</span>
      </span>
    </div>
    <div class="tav-body" id="tavBody">
      <div class="tav-row">
        <span class="tav-label">Test runner</span>
        <select id="tavTestTool" class="tav-select">
          <option value="manual">Manual</option>
          <option value="sandbox">Sandbox (auto-launch)</option>
          <option value="playwright">Playwright</option>
          <option value="cypress">Cypress</option>
          <option value="claude-chrome">Claude + Chrome</option>
        </select>
      </div>
      <div class="tav-row tav-sb-row" id="tavSbRow">
        <span class="tav-sb-dot" id="tavSbDot"></span>
        <span class="tav-sb-status" id="tavSbStatus">Sandbox not started</span>
        <a class="tav-sb-url" id="tavSbUrl" style="display:none"></a>
        <button class="tav-btn primary" id="tavLaunch" type="button">Launch</button>
        <button class="tav-btn" id="tavStop" type="button" style="display:none">Stop</button>
        <button class="tav-btn" id="tavScreenshot" type="button" style="display:none" title="Take screenshot">&#x1F4F7;</button>
      </div>
      <div class="tav-row" id="tavPrdRow">
        <span class="tav-label">PRD source</span>
        <span class="tav-prd-val" id="tavPrdVal">None linked</span>
        <button class="tav-btn" id="tavOpenPrd" type="button">Open</button>
      </div>
      <div id="tavHintRow" class="tav-row" style="display:none">
        <span class="tav-hint" id="tavHint"></span>
      </div>
      <div id="tavCriteriaWrap" class="tav-criteria-wrap" style="display:none"></div>
      <button class="tav-verify-btn" id="tavVerifyBtn" type="button" disabled>Verify Against PRD &#x2192;</button>
      <div class="tav-fix-iter" id="tavFixIter" style="display:none"></div>
    </div>
  </div>

  <!-- Extras strip: AI Rules + Sandbox side-by-side (visible per-tab) -->
  <div class="extras-strip">
    <div id="sidebarRules" class="extras-seg">
      <div class="sidebar-rules-head">
        <button class="sidebar-rules-toggle collapsed" id="rulesToggle" type="button">
          <span class="sidebar-rules-icon">&#x25BC;</span>
          <span class="sidebar-rules-label">AI Rules</span>
          <span class="sidebar-rules-badge" id="rulesBadge"></span>
        </button>
        <span class="sidebar-rules-hd-btns">
          <button id="rulesLibBtn" class="sidebar-rules-hd-btn" type="button" title="Browse built-in rule library">&#x1F4DA;</button>
          <button id="rulesAddBtn" class="sidebar-rules-hd-btn" type="button" title="Add custom rule">&#x2B;</button>
        </span>
      </div>
      <div class="sidebar-rules-body collapsed" id="rulesBody">
        <div id="rulesList" class="sidebar-rules-list"></div>
        <div id="rulesEmpty" class="sidebar-rules-empty">No rules yet. Click + to add one.</div>
      </div>
    </div>
    <div id="sidebarSandbox" class="extras-seg">
      <button class="sidebar-sandbox-toggle" id="sbToggle" type="button">
        <span class="sidebar-sandbox-icon">&#x25BC;</span>
        <span class="sidebar-sandbox-label">Sandbox</span>
        <span class="sidebar-sandbox-badge" id="sbBadge"></span>
      </button>
      <div class="sidebar-sandbox-body" id="sbBody">
        <div class="sidebar-sandbox-row">
          <span class="sidebar-sandbox-dot" id="sbDot"></span>
          <span class="sidebar-sandbox-status" id="sbStatus">Not started</span>
          <span class="sidebar-sandbox-framework" id="sbFramework"></span>
        </div>
        <div class="sidebar-sandbox-row">
          <a class="sidebar-sandbox-url" id="sbUrl" style="display:none;"></a>
        </div>
        <div class="sidebar-sandbox-row sb-tool-row">
          <span class="sb-tool-label">Test Tool</span>
          <select id="sbTestTool" class="sb-tool-select">
            <option value="manual">Manual</option>
            <option value="sandbox">Sandbox (auto-launch)</option>
            <option value="playwright">Playwright</option>
            <option value="cypress">Cypress</option>
            <option value="claude-chrome">Claude + Chrome</option>
          </select>
        </div>
        <div class="sidebar-sandbox-row" id="sbTttHintRow" style="display:none">
          <span class="sb-ttt-hint" id="sbTttHint"></span>
        </div>
        <div class="sidebar-sandbox-actions">
          <button class="sb-btn primary" id="sbLaunch" type="button">Launch</button>
          <button class="sb-btn" id="sbStop" type="button" style="display:none;">Stop</button>
          <button class="sb-btn" id="sbScreenshot" type="button">Screenshot</button>
        </div>
        <img class="sb-thumb" id="sbThumb" alt="screenshot" />
      </div>
    </div>

    <div id="ghSyncSection" class="extras-seg">
      <button class="sidebar-sandbox-toggle" id="ghSyncToggle" type="button">
        <span class="sidebar-sandbox-icon">&#x25BC;</span>
        <span class="sidebar-sandbox-label">GitHub Sync</span>
        <span class="gh-sync-status-dot" id="ghSyncDot"></span>
      </button>
      <div class="sidebar-sandbox-body" id="ghSyncBody">
        <!-- Not-configured state -->
        <div id="ghSyncSetup">
          <div class="sidebar-sandbox-row">
            <span class="gh-sync-last">Connect a GitHub repo to auto-import issues as tasks.</span>
          </div>
          <div class="sidebar-sandbox-row gh-sync-input-row">
            <input id="ghSyncRepoInput" class="gh-sync-input" type="text" placeholder="owner/repo" spellcheck="false" />
          </div>
          <div class="sidebar-sandbox-row gh-sync-label-row">
            <span class="gh-sync-last">Label to watch:</span>
            <input id="ghSyncLabelInput" class="gh-sync-input gh-sync-input-sm" type="text" placeholder="moag" value="moag" spellcheck="false" />
          </div>
          <div class="sidebar-sandbox-actions">
            <button class="sb-btn primary" id="ghSyncConnect" type="button">Connect</button>
          </div>
        </div>
        <!-- gh auth status — always visible -->
        <div id="ghSyncAuthStatus" class="gh-sync-auth-row"></div>
        <!-- Connected state -->
        <div id="ghSyncConnected" style="display:none">
          <div class="sidebar-sandbox-row">
            <span class="gh-sync-repo" id="ghSyncRepo"></span>
            <span class="gh-sync-toggle-wrap">
              <label class="gh-sync-toggle-label">
                <input type="checkbox" id="ghSyncEnabledToggle" />
                <span class="gh-sync-toggle-text" id="ghSyncToggleLabel">Off</span>
              </label>
            </span>
          </div>
          <div class="sidebar-sandbox-row">
            <span class="gh-sync-last" id="ghSyncLast">Never polled</span>
          </div>
          <div class="sidebar-sandbox-row">
            <span class="gh-sync-count" id="ghSyncCount"></span>
          </div>
          <div class="sidebar-sandbox-actions">
            <button class="sb-btn primary" id="ghSyncPollNow" type="button">Poll Now</button>
            <button class="sb-btn" id="ghSyncDisconnect" type="button">Disconnect</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="composer">
    <div class="input-wrap" id="inputWrap">
      <div id="imagePreviewBar" class="image-preview-bar">
        <div class="image-preview-item">
          <img id="imagePreviewThumb" class="image-preview-thumb" alt="Attached image" />
          <button id="imageRemoveBtn" class="image-remove-btn" type="button" title="Remove image">&#x2715;</button>
        </div>
      </div>
      <div class="textarea-row">
        <textarea id="prompt" placeholder="Describe a task..." rows="1"></textarea>
      </div>
      <div class="file-pill-row" id="filePillRow" style="display:none">
        <div class="file-pill" id="filePill">
          <svg class="file-pill-icon" viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1zm0 1.5L12.5 5H9V2.5z"/></svg>
          <span class="file-pill-name" id="filePillName"></span>
          <button class="file-pill-dismiss" id="filePillDismiss" type="button" title="Remove from context">&#x2715;</button>
        </div>
        <span class="file-pill-hint">will be included in prompt</span>
      </div>
      <div class="composer-toolbar">
        <div class="composer-toolbar-left">
          <button class="attach-btn" id="attachBtn" type="button" title="Attach file or image" aria-label="Attach file or image">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5.5l-6.4 6.4a3.2 3.2 0 01-4.5-4.5L9.5 1a2.1 2.1 0 013 3L6.1 10.4a1.1 1.1 0 01-1.5-1.5L10 3.5"/></svg>
          </button>
          <button id="generatePlanBtn" class="gen-plan-btn" type="button" title="Generate a structured task plan from this description">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.2 3.8L13 6l-3.8 1.2L8 11l-1.2-3.8L3 6l3.8-1.2L8 1z"/><circle cx="13" cy="2" r="1"/><circle cx="3" cy="13" r="1"/></svg>
            Plan
          </button>
          <button id="composerPrdBtn" class="gen-plan-btn composer-prd-btn" type="button" title="Add or update PRD for this project" style="display:none">&#128196; PRD</button>
          <select id="engine"></select>
          <span id="promptCharCount" class="char-count">0</span>
        </div>
        <div class="composer-toolbar-right">
          <button id="addToPlanBtn" class="add-to-plan-btn" type="button" title="Add to queue (Shift+Enter)" aria-keyshortcuts="Shift+Enter">+ Queue</button>
          <button id="send" class="run-btn" type="button" title="Execute (Ctrl+Enter)" aria-keyshortcuts="Control+Enter">
            Execute
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0"><path d="M3 2l10 6-10 6V2z"/></svg>
          </button>
        </div>
      </div>
    </div>
    <div id="contextBar" class="context-bar">
      <span id="ctxPlan" class="ctx-chip">Ad hoc</span>
      <span class="ctx-sep">·</span>
      <span id="ctxRunner" class="ctx-chip">IDLE</span>
      <span id="ctxCost" class="ctx-chip" style="display:none;">$0.00</span>
    </div>
    <div id="composerHint" class="composer-hint">Ctrl+Enter execute · Shift+Enter queue</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById('prompt');
    const sendEl = document.getElementById('send');
    const addToPlanBtnEl = document.getElementById('addToPlanBtn');
    const generatePlanBtnEl = document.getElementById('generatePlanBtn');
    const engineEl = document.getElementById('engine');
    const attachBtnEl = document.getElementById('attachBtn');
    const dashboardBtnEl = document.getElementById('dashboardBtn');
    const settingsBtnEl = document.getElementById('settingsBtn');
    const newChatBtnEl = document.getElementById('newChatBtn');
    const inputWrapEl = document.getElementById('inputWrap');
    const imagePreviewBarEl = document.getElementById('imagePreviewBar');
    const imagePreviewThumbEl = document.getElementById('imagePreviewThumb');
    const imageRemoveBtnEl = document.getElementById('imageRemoveBtn');
    const filePillRowEl = document.getElementById('filePillRow');
    const filePillNameEl = document.getElementById('filePillName');
    const filePillDismissEl = document.getElementById('filePillDismiss');
    let attachedImage = null;
    let activeFile = null; // { name, path } | null
    let activeFileDismissed = false;
    let pendingFixRef = null; // { playlistIndex, taskIndex } — set when Fix fills composer; routes Execute to task retry
    // PRD draft mode state
    var prdMode = false;
    var prdStep = 0; // 1 = waiting for feature description, 2 = waiting for follow-up answer
    var prdAnswers = []; // collected answers from user

    function appendPrdMessage(role, text) {
      if (!chatFeedEl) { return; }
      var wrap = document.createElement('div');
      wrap.className = 'prd-msg ' + (role === 'bot' ? 'prd-bot' : 'prd-user');
      var author = document.createElement('div');
      author.className = 'prd-msg-author';
      author.textContent = role === 'bot' ? 'MOAG' : 'You';
      var msg = document.createElement('div');
      msg.className = 'prd-msg-text';
      msg.textContent = text;
      wrap.appendChild(author);
      wrap.appendChild(msg);
      chatFeedEl.appendChild(wrap);
      chatFeedEl.scrollTop = chatFeedEl.scrollHeight;
    }

    function showPrdTyping() {
      if (!chatFeedEl) { return null; }
      var el = document.createElement('div');
      el.className = 'prd-typing';
      el.innerHTML = '<span></span><span></span><span></span>';
      chatFeedEl.appendChild(el);
      chatFeedEl.scrollTop = chatFeedEl.scrollHeight;
      return el;
    }

    function startPrdMode() {
      prdMode = true;
      prdStep = 1;
      prdAnswers = [];
      if (prdModeHeaderEl) { prdModeHeaderEl.classList.add('active'); }
      if (sendEl) { sendEl.innerHTML = 'Answer <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0"><path d="M3 2l10 6-10 6V2z"/></svg>'; }
      if (chatEmptyEl) { chatEmptyEl.style.display = 'none'; }
      if (chatFeedEl) { chatFeedEl.textContent = ''; }
      appendPrdMessage('bot', 'What are you building? Describe the feature in plain terms — what it does, who uses it, and what problem it solves.');
      promptEl.placeholder = 'Describe your feature...';
      promptEl.focus();
    }

    function exitPrdMode() {
      prdMode = false;
      prdStep = 0;
      prdAnswers = [];
      if (prdModeHeaderEl) { prdModeHeaderEl.classList.remove('active'); }
      if (sendEl) { sendEl.innerHTML = 'Execute <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0"><path d="M3 2l10 6-10 6V2z"/></svg>'; }
      promptEl.placeholder = 'Describe a task for the AI agent...';
      renderChat(chatTitleEl ? chatTitleEl.textContent || 'New Chat' : 'New Chat', chatMessages);
    }
    function updateComposerHint() {
      if (!composerHintEl) { return; }
      if (pendingFixRef) {
        composerHintEl.textContent = 'Execute will retry the task with this fix context';
        composerHintEl.classList.add('fix-mode');
      } else {
        composerHintEl.textContent = 'Ctrl+Enter execute · Shift+Enter queue';
        composerHintEl.classList.remove('fix-mode');
      }
    }
    const tabEls = Array.from(document.querySelectorAll('.tab'));
    const chatScreenEl = document.getElementById('chatScreen');
    const chatTitleEl = document.getElementById('chatTitle');
    const chatFeedEl = document.getElementById('chatFeed');
    const chatEmptyEl = document.getElementById('chatEmpty');
    const planToolsEl = document.getElementById('planTools');
    const planActiveNameEl = document.getElementById('planActiveName');
    const planExecCounterEl = document.getElementById('planExecCounter');
    const planRunnerBadgeEl = document.getElementById('planRunnerBadge');
    const planOpenPrdBtnEl = document.getElementById('planOpenPrdBtn');
    const planFilterBtnEl = null; // removed — filter now always visible in status bar
    const planFilterMenuEl = null; // removed
    const planSelectModeCbEl = document.getElementById('planSelectModeCb');
    const planFilterChipsEl = document.getElementById('planFilterChips');
    const planRunSelectedBtnEl = document.getElementById('planRunSelectedBtn');
    const planRunPendingBtnEl = document.getElementById('planRunPendingBtn');
    const planFixAllBtnEl = document.getElementById('planFixAllBtn');
    const planFixBarEl = null; // removed — merged into planStatusBar
    const planFixLabelEl = null; // removed
    const planFixAllBarBtnEl = document.getElementById('planFixAllBarBtn');
    const reportIssueBtnEl = document.getElementById('reportIssueBtn');
    const composerHintEl = document.getElementById('composerHint');
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
    const planFromPrdBtnEl = document.getElementById('planFromPrdBtn');
    const planFromTemplateBtnEl = document.getElementById('planFromTemplateBtn');
    const chatEmptyPrdBtnEl = document.getElementById('chatEmptyPrdBtn');
    const chatEmptyTemplateBtnEl = document.getElementById('chatEmptyTemplateBtn');
    const chatStartPrdBtnEl = document.getElementById('chatStartPrdBtn');
    const prdModeHeaderEl = document.getElementById('prdModeHeader');
    const prdModeCancelBtnEl = document.getElementById('prdModeCancelBtn');
    const prdInputScreenEl = document.getElementById('prdInputScreen');
    const prdBackBtnEl = document.getElementById('prdBackBtn');
    const prdInputTitleEl = document.getElementById('prdInputTitle');
    const prdInputHintEl = document.getElementById('prdInputHint');
    const prdTextareaEl = document.getElementById('prdTextarea');
    const prdBrowseBtnEl = document.getElementById('prdBrowseBtn');
    const prdGenerateBtnEl = document.getElementById('prdGenerateBtn');
    const prdCharCountEl = document.getElementById('prdCharCount');
    const prdVersionBarEl = document.getElementById('prdVersionBar');
    const prdVersionSelectEl = document.getElementById('prdVersionSelect');
    const prdVersionSaveBtnEl = document.getElementById('prdVersionSaveBtn');
    const prdAiBtnEl = document.getElementById('prdAiBtn');
    const prdProjectCardEl = document.getElementById('prdProjectCard');
    const prdProjectNameEl = document.getElementById('prdProjectName');
    const prdProjectStackEl = document.getElementById('prdProjectStack');
    const prdChipsRowEl = document.getElementById('prdChipsRow');
    var prdVersions = [];
    const composerPrdBtnEl = document.getElementById('composerPrdBtn');
    const planToggleTasksBtnEl = document.getElementById('planToggleTasksBtn');
    const planToggleExpandBtnEl = document.getElementById('planToggleExpandBtn');
    const planSwitchBtnEl = document.getElementById('planSwitchBtn');
    const planOverviewEl = document.getElementById('planOverview');
    const planOverviewTitleEl = document.getElementById('planOverviewTitle');
    const planOverviewMetaEl = document.getElementById('planOverviewMeta');
    const planOverviewFailedMetaEl = document.getElementById('planOverviewFailedMeta');
    const planOverviewFillEl = document.getElementById('planOverviewFill');
    const planOverviewRunningEl = document.getElementById('planOverviewRunning');
    const planOverviewRunningTextEl = document.getElementById('planOverviewRunningText');
    const planQueueEl = document.getElementById('planQueue');
    const planQueueMetaEl = document.getElementById('planQueueMeta');
    const planQueueNextTaskEl = document.getElementById('planQueueNextTask');
    const planQueueDotsEl = document.getElementById('planQueueDots');
    const planLivePanelEl = document.getElementById('planLivePanel');
    const planRulesSectionEl = document.getElementById('planRulesSection');
    const tttCriteriaSectionEl = document.getElementById('tttCriteriaSection');
    const tttCriteriaListEl = document.getElementById('tttCriteriaList');
    const tttVerifyBtnEl = document.getElementById('tttVerifyBtn');
    const planListHeadingEl = document.getElementById('planListHeading');
    const planListSelectModeCbEl = document.getElementById('planListSelectModeCb');
    const planHeadingCollapseBtnEl = document.getElementById('planHeadingCollapseBtn');
    const planListEl = document.getElementById('planList');
    const historyToolsEl = document.getElementById('historyTools');
    const historyGroupByEl = document.getElementById('historyGroupBy');
    const historyStatusChipsEl = document.getElementById('historyStatusChips');
    const historyListEl = document.getElementById('historyList');
    const listEmptyEl = document.getElementById('listEmpty');
    const ctxPlanEl = document.getElementById('ctxPlan');
    const ctxRunnerEl = document.getElementById('ctxRunner');
    const ctxCostEl = document.getElementById('ctxCost');
    const promptCharCountEl = document.getElementById('promptCharCount');
    let busy = false;
    let activeTab = 'chat';
    let chatItems = [];
    let planItems = [];
    let planGroups = [];
    let planAiRules = '';
    let planPrdSource = '';
    let detectedPrdFilePath = '';
    let testTool = 'manual';
    let planFixIterations = 0;
    let prdProjectMeta = { name: '', stack: '' };
    let tttCriteriaChecked = [];
    let historyItems = [];
    let activeThreadId = '';
    let chatMessages = [];
    let runnerState = 'idle';
    let historyGroupBy = 'none';
    let historyStatusFilter = 'all';
    let collapsedHistoryGroups = {};
    let collapsedPlanGroups = {};
    let planTasksVisible = true;
    let planFilterMode = 'all';
    let planListScrollTop = 0;
    let planListScrollInitialized = false;
    let planSearchQuery = '';
    let selectionMode = false;
    let selectedPlaylists = {};
    let selectedTasks = {};
    let activePlanName = '';
    let activePlaylistName = '';
    let actionMenuHandlersBound = false;
    let liveTaskId = '';
    let liveTaskName = '';
    let liveOutputLines = [];
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
      const h = Math.min(Math.max(promptEl.scrollHeight + 1, 36), 200);
      promptEl.style.height = h + 'px';
      promptEl.style.overflowY = h >= 200 ? 'auto' : 'hidden';
    }

    function updateActionState() {
      const charCount = promptEl.value.length;
      promptCharCountEl.textContent = charCount === 0 ? '' : charCount === 1 ? '1 char' : charCount + ' chars';
      promptCharCountEl.style.display = charCount === 0 ? 'none' : '';
      const hasText = !!promptEl.value.trim();
      sendEl.disabled = busy || !hasText;
      if (generatePlanBtnEl) { generatePlanBtnEl.disabled = busy || !hasText; }
      if (addToPlanBtnEl) { addToPlanBtnEl.disabled = !hasText; }
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

    function historyStatusIcon(status) {
      const s = String(status || '').toLowerCase();
      if (s === 'completed') {
        return { cls: 'completed', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M13.5 3.5l-7 7-3-3-.7.7 3.7 3.7 7.7-7.7z"/></svg>' };
      }
      if (s === 'failed' || s === 'blocked') {
        return { cls: 'failed', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M9 1H7v8h2zm-1 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>' };
      }
      if (s === 'running') {
        return { cls: 'running', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M3 2l10 6-10 6V2z"/></svg>' };
      }
      return { cls: 'default', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><circle cx="8" cy="8" r="3"/></svg>' };
    }

    function renderHistoryList() {
      historyListEl.textContent = '';
      const base = Array.isArray(historyItems) ? historyItems : [];
      const filtered = base.filter(statusMatchesFilter);
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
          const subParts = (item.subtitle || '').split('  -  ');
          const breadcrumb = subParts[0] || '';
          const age = subParts.length >= 2 ? subParts[subParts.length - 1].trim() : '';
          const hIcon = historyStatusIcon(item.status);
          const isFailed = item.status === 'failed' || item.status === 'blocked';
          btn.className = 'history-item' + (isFailed ? ' failed' : '');
          btn.innerHTML =
            '<span class="history-icon ' + hIcon.cls + '">' + hIcon.svg + '</span>' +
            '<span class="history-body">' +
              '<span class="history-title">' + escHtml(item.title || 'Untitled') + '</span>' +
              (breadcrumb ? '<span class="history-breadcrumb">' + escHtml(breadcrumb) + '</span>' : '') +
              (isFailed && item.failureReason ? '<span class="history-failure-reason">' + escHtml(item.failureReason) + '</span>' : '') +
              (item.filesChanged ? '<span class="history-files-changed">' + item.filesChanged + 'f changed</span>' : '') +
            '</span>' +
            (age ? '<span class="history-age">' + escHtml(age) + '</span>' : '') +
            (isFailed && item.taskId ? '<button class="history-retry-btn" type="button" title="Retry this task">↺</button>' : '');
          btn.addEventListener('click', (e) => {
            // Retry button inside the row — don't open the item
            if ((e.target as HTMLElement).classList.contains('history-retry-btn')) {
              e.stopPropagation();
              if (item.taskId) { vscode.postMessage({ type: 'retryTask', taskId: item.taskId }); }
              return;
            }
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

    function renderLivePanel() {
      if (!planLivePanelEl) { return; }
      if (!liveTaskId) {
        planLivePanelEl.style.display = 'none';
        return;
      }
      planLivePanelEl.style.display = '';
      const linesHtml = liveOutputLines.map((l, i) => {
        const cls = i < liveOutputLines.length - 2 ? ' old' : i < liveOutputLines.length - 1 ? ' mid' : '';
        return '<div class="plan-live-line' + cls + '">' + escHtml(l) + '</div>';
      }).join('');
      planLivePanelEl.innerHTML =
        '<div class="plan-live-header">' +
          '<span class="plan-live-pulse"></span>' +
          '<span class="plan-live-task">' + escHtml(liveTaskName || 'Executing…') + '</span>' +
          '<span class="plan-live-dash-link" data-action="showDashboard">Open Dashboard ↗</span>' +
        '</div>' +
        (liveOutputLines.length > 0
          ? '<div class="plan-live-output">' + linesHtml + '</div>'
          : '');
      planLivePanelEl.querySelector('[data-action="showDashboard"]')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'showDashboard' });
      });
    }

    function renderPlanRulesSection() {
      if (!planRulesSectionEl) { return; }
      planRulesSectionEl.textContent = '';
      if (!activePlanName) { return; }
      const hasRules = planAiRules.trim().length > 0;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'padding:4px 8px 2px;';

      const headerRow = document.createElement('div');
      headerRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;';

      const label = document.createElement('span');
      label.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);flex:1;';
      label.textContent = 'Plan Rules';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'plan-group-rules-btn' + (hasRules ? ' has-rules' : '');
      editBtn.innerHTML = hasRules
        ? '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm0 3h8V4H4v1zm0 3h8V7H4v1zm0 3h5v-1H4v1z"/></svg>'
        : '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';
      editBtn.title = hasRules ? 'Plan rules active — click to edit' : 'Add rules for all tasks in this plan';

      headerRow.appendChild(label);
      headerRow.appendChild(editBtn);
      wrapper.appendChild(headerRow);

      const panel = document.createElement('div');
      panel.className = 'rules-edit-panel';
      panel.style.display = 'none';
      panel.style.padding = '0';
      panel.innerHTML =
        '<label>Plan rules — injected before every task in this plan</label>' +
        '<textarea rows="5" placeholder="e.g. Security: always validate user inputs. Architecture: follow the existing service layer pattern.">' + escHtml(planAiRules) + '</textarea>' +
        '<div class="rules-edit-btns">' +
          '<button type="button" class="rules-cancel-btn">Cancel</button>' +
          '<button type="button" class="rules-save-btn">Save</button>' +
        '</div>';

      editBtn.addEventListener('click', () => {
        const open = panel.style.display !== 'none';
        panel.style.display = open ? 'none' : 'block';
        if (!open) { panel.querySelector('textarea')?.focus(); }
      });
      panel.querySelector('.rules-save-btn')?.addEventListener('click', () => {
        const val = panel.querySelector('textarea')?.value ?? '';
        vscode.postMessage({ type: 'savePlanRules', rules: val });
        panel.style.display = 'none';
      });
      panel.querySelector('.rules-cancel-btn')?.addEventListener('click', () => {
        panel.style.display = 'none';
      });

      wrapper.appendChild(panel);
      planRulesSectionEl.appendChild(wrapper);
    }

    function parsePrdCriteria(prdText) {
      if (!prdText) { return []; }
      var lines = prdText.split('\\n');
      var criteria = [];
      var inCriteriaBlock = false;
      for (var li = 0; li < lines.length; li++) {
        var trimmed = lines[li].trim();
        if (trimmed.toLowerCase().indexOf('acceptance criteria') !== -1 || trimmed.toLowerCase().indexOf('## criteria') !== -1) { inCriteriaBlock = true; continue; }
        if (inCriteriaBlock && /^#{1,3} /.test(trimmed) && trimmed.toLowerCase().indexOf('criteria') === -1) { inCriteriaBlock = false; }
        var cbm = trimmed.match(/^-[ ]*\\[[ x]\\][ ]*(.+)/i);
        if (cbm) { criteria.push(cbm[1].trim()); continue; }
        var acm = trimmed.match(/^ac[0-9]*[:.] *(.+)/i);
        if (acm) { criteria.push(acm[1].trim()); continue; }
        if (inCriteriaBlock && (trimmed.charAt(0) === '-' || trimmed.charAt(0) === '*' || /^[0-9]/.test(trimmed)) && trimmed.length > 8) {
          criteria.push(trimmed.replace(/^[-*0-9.]+[ ]*/, '').trim());
        }
      }
      return criteria.filter(Boolean).slice(0, 20);
    }

    function renderTttCriteria() {
      if (!tttCriteriaSectionEl || !tttCriteriaListEl || !tttVerifyBtnEl) { return; }
      const hasTestPhase = Array.isArray(planGroups) && planGroups.some(function(g) {
        return g.testPhase && (g.playlistStatus === 'running' || g.playlistStatus === 'paused');
      });
      if (!hasTestPhase || !planPrdSource) {
        tttCriteriaSectionEl.classList.remove('active');
        return;
      }
      const criteria = parsePrdCriteria(planPrdSource);
      if (criteria.length === 0) {
        tttCriteriaSectionEl.classList.remove('active');
        return;
      }
      if (tttCriteriaChecked.length !== criteria.length) {
        tttCriteriaChecked = new Array(criteria.length).fill(false);
      }
      tttCriteriaSectionEl.classList.add('active');
      tttCriteriaListEl.textContent = '';
      criteria.forEach(function(text, i) {
        var row = document.createElement('label');
        row.className = 'ttt-criterion' + (tttCriteriaChecked[i] ? ' checked' : '');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!tttCriteriaChecked[i];
        cb.addEventListener('change', function() {
          tttCriteriaChecked[i] = cb.checked;
          row.classList.toggle('checked', cb.checked);
          vscode.postMessage({ type: 'tttCriterionChecked', index: i, checked: cb.checked });
          var allDone = tttCriteriaChecked.length > 0 && tttCriteriaChecked.every(Boolean);
          tttVerifyBtnEl.style.display = allDone ? 'block' : 'none';
        });
        var span = document.createElement('span');
        span.textContent = text;
        row.appendChild(cb);
        row.appendChild(span);
        tttCriteriaListEl.appendChild(row);
      });
      var allDone = tttCriteriaChecked.length > 0 && tttCriteriaChecked.every(Boolean);
      tttVerifyBtnEl.style.display = allDone ? 'block' : 'none';
    }

    function renderPlanGroups(targetEl, groups) {
      renderPlanRulesSection();
      renderTttCriteria();
      const savedScrollTop = planListScrollTop;
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
        const totalCount = allTasks.length;
        const doneCount = allTasks.filter((t) => {
          const s = String(t.status || '').toLowerCase();
          return s === 'completed' || s === 'skipped';
        }).length;
        const failedCount = allTasks.filter((t) => {
          const s = String(t.status || '').toLowerCase();
          return s === 'failed' || s === 'blocked';
        }).length;
        const pendingCount = allTasks.filter((t) => {
          const s = String(t.status || '').toLowerCase();
          return isPendingLikeStatus(s);
        }).length;
        const groupSubLabel = groupStatus === 'running'
          ? 'EXECUTING'
          : doneCount === totalCount && totalCount > 0
            ? (String(totalCount) + '/' + String(totalCount) + ' done')
            : pendingCount === totalCount
              ? (totalCount === 1 ? '1 pending' : String(totalCount) + ' pending')
              : failedCount > 0
                ? (String(failedCount) + ' failed · ' + String(doneCount) + '/' + String(totalCount) + ' done')
                : (String(doneCount) + '/' + String(totalCount) + ' done');
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
        play.title = groupStatus === 'running' ? 'Pause entire run (not just this playlist)' : groupStatus === 'completed' ? 'Re-execute' : 'Execute';
        play.innerHTML = groupStatus === 'running'
          ? '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="3.5" y="2.5" width="3.5" height="11" rx="1"/><rect x="9" y="2.5" width="3.5" height="11" rx="1"/></svg>'
          : groupStatus === 'completed'
            ? '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5"/><polyline points="10.5 2.5 13.5 2.5 13.5 5.5"/></svg>'
            : '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4.5 2.5l8 5.5-8 5.5V2.5z"/></svg>';
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

        const playlistRules = group.aiRules || '';
        const rulesBtn = document.createElement('button');
        rulesBtn.type = 'button';
        rulesBtn.className = 'plan-group-rules-btn' + (playlistRules ? ' has-rules' : '');
        rulesBtn.title = playlistRules ? 'Playlist rules active — click to edit' : 'Add playlist rules';
        rulesBtn.title = playlistRules ? 'Playlist rules active — click to edit' : 'Add playlist rules';
        rulesBtn.innerHTML = playlistRules
          ? '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm0 3h8V4H4v1zm0 3h8V7H4v1zm0 3h5v-1H4v1z"/></svg>'
          : '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';

        const rulesPanel = document.createElement('div');
        rulesPanel.className = 'rules-edit-panel';
        rulesPanel.style.display = 'none';
        rulesPanel.innerHTML =
          '<label>Playlist rules — injected before every task in this playlist</label>' +
          '<textarea rows="5" placeholder="e.g. Always use TypeScript strict mode. Check for existing utilities before creating new ones.">' + escHtml(playlistRules) + '</textarea>' +
          '<div class="rules-edit-btns">' +
            '<button type="button" class="rules-cancel-btn">Cancel</button>' +
            '<button type="button" class="rules-save-btn">Save</button>' +
          '</div>';

        rulesBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = rulesPanel.style.display !== 'none';
          rulesPanel.style.display = open ? 'none' : 'block';
          if (!open) { rulesPanel.querySelector('textarea')?.focus(); }
        });
        rulesPanel.querySelector('.rules-save-btn')?.addEventListener('click', () => {
          const val = rulesPanel.querySelector('textarea')?.value ?? '';
          vscode.postMessage({ type: 'savePlaylistRules', playlistIndex: i, rules: val });
          rulesPanel.style.display = 'none';
        });
        rulesPanel.querySelector('.rules-cancel-btn')?.addEventListener('click', () => {
          rulesPanel.style.display = 'none';
        });

        row.appendChild(select);
        row.appendChild(toggle);
        if (group.prdContext) {
          const prdBtn = document.createElement('button');
          prdBtn.type = 'button';
          prdBtn.className = 'prd-pill-btn';
          prdBtn.title = 'View PRD slice for this playlist';
          prdBtn.innerHTML = '&#128196; PRD';
          prdBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'showPlaylistPrdContext', prdContext: group.prdContext });
          });
          row.appendChild(prdBtn);
        }
        row.appendChild(rulesBtn);
        row.appendChild(play);
        header.appendChild(row);
        header.appendChild(rulesPanel);
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
          taskBtn.dataset.status = status;
          const failureReason = (status === 'failed' || status === 'blocked')
            ? String(task.failureReason || '').trim()
            : '';
          const statusLabel = status === 'running'
            ? 'EXECUTING'
            : status === 'completed'
              ? 'done'
              : isPendingLikeStatus(status)
                ? ''
                : (task.status || '');
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
          const SVG_PLAY = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M4.5 2.5l8 5.5-8 5.5V2.5z"/></svg>';
          const SVG_PAUSE = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><rect x="3.5" y="2.5" width="3.5" height="11" rx="1"/><rect x="9" y="2.5" width="3.5" height="11" rx="1"/></svg>';
          const SVG_RETRY = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5"/><polyline points="10.5 2.5 13.5 2.5 13.5 5.5"/></svg>';
          const SVG_EDIT = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z"/></svg>';
          const SVG_EYE = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="8" rx="6" ry="3.5"/><circle cx="8" cy="8" r="1.5"/></svg>';
          const editBtnHtml = status !== 'running' ? '<button type="button" class="task-act-btn task-edit-btn" title="Edit task">' + SVG_EDIT + '</button>' : '';
          const previewBtnHtml = '<button type="button" class="task-act-btn task-preview-btn" title="Preview prompt">' + SVG_EYE + '</button>';
          const actionButtons = isFailedLike
            ? '<button type="button" class="task-act-btn task-retry" title="Re-execute unchanged">' + SVG_RETRY + '</button>' +
              '<button type="button" class="smart-fix-btn task-fix" title="Pre-fill composer with error context for guided fix">Fix</button>' +
              editBtnHtml + previewBtnHtml
            : '<button type="button" class="task-act-btn task-toggle" title="' + (status === 'running' ? 'Pause entire run (not just this task)' : 'Execute') + '">' + (status === 'running' ? SVG_PAUSE : SVG_PLAY) + '</button>' +
              editBtnHtml + previewBtnHtml;
          const tokenMeta = (() => {
            const u = task.tokenUsage;
            if (!u || (!u.totalTokens && !u.estimatedCost)) { return ''; }
            const parts = [];
            if (u.totalTokens) { parts.push((u.totalTokens >= 1000 ? (u.totalTokens / 1000).toFixed(1) + 'K' : String(u.totalTokens)) + ' tok'); }
            if (u.estimatedCost) { parts.push('$' + u.estimatedCost.toFixed(u.estimatedCost < 0.01 ? 4 : 2)); }
            return parts.length ? '<span class="item-subtitle token-meta">' + escHtml(parts.join(' · ')) + '</span>' : '';
          })();
          const errorCat = task.errorCategory || '';
          const errorCatBadge = errorCat
            ? '<span class="error-cat ' + escHtml(errorCat) + '">' + escHtml(errorCat) + '</span>'
            : '';
          const attemptBadge = (task.attemptCount && task.attemptCount > 1)
            ? '<span class="attempt-badge">(' + task.attemptCount + ' attempts)</span>'
            : '';
          const issueBadge = task.sourceIssueNumber
            ? '<span class="issue-badge" data-repo="' + escHtml(task.sourceIssueRepo || '') + '" data-number="' + escHtml(String(task.sourceIssueNumber)) + '" title="GitHub issue #' + task.sourceIssueNumber + '">#' + task.sourceIssueNumber + '</span>'
            : '';
          const errLines = Array.isArray(task.errorLines) ? task.errorLines : [];
          const errorLinesHtml = isFailedLike && errLines.length > 0
            ? '<div class="error-lines">' + errLines.slice(0, 3).map((l) => '<div class="error-line">' + escHtml(l) + '</div>').join('') + '</div>'
            : '';
          taskBtn.innerHTML =
            '<div class="task-row">' +
              '<input type="checkbox" class="task-check"' + (selectedTasks[taskKey] ? ' checked' : '') + '>' +
              '<button type="button" class="task-main">' +
                '<span class="item-title"><span class="item-dot"></span>' + escHtml(task.name || 'Untitled task') + issueBadge + errorCatBadge + attemptBadge + '</span>' +
                '<span class="item-subtitle">' + escHtml(statusLabel) + '</span>' +
                (failureReason ? '<span class="item-subtitle error" title="' + escHtml(failureReason) + '">' + escHtml(failureReason) + '</span>' : '') +
                errorLinesHtml +
                tokenMeta +
                (status === 'running' ? '<span class="run-badge">Executing</span>' : '') +
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
          const issueBadgeEl = taskBtn.querySelector('.issue-badge');
          issueBadgeEl?.addEventListener('click', (event) => {
            event.stopPropagation();
            const repo = issueBadgeEl.getAttribute('data-repo') || '';
            const num = issueBadgeEl.getAttribute('data-number') || '';
            if (repo && num) {
              vscode.postMessage({ type: 'openExternalUrl', url: 'https://github.com/' + repo + '/issues/' + num });
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
            vscode.postMessage({ type: 'showSmartFix', playlistIndex: i, taskIndex: originalIndex });
          });

          const editPanel = document.createElement('div');
          editPanel.className = 'task-edit-panel';
          editPanel.style.display = 'none';
          editPanel.innerHTML =
            '<div class="task-edit-form">' +
              '<input class="task-edit-name" type="text" value="' + escHtml(task.name || '') + '" placeholder="Task name">' +
              '<textarea class="task-edit-prompt" rows="5" placeholder="Task prompt">' + escHtml(task.prompt || '') + '</textarea>' +
              '<div class="task-edit-btns">' +
                '<button type="button" class="task-edit-cancel">Cancel</button>' +
                '<button type="button" class="task-edit-save">Save</button>' +
              '</div>' +
            '</div>';

          const editBtnEl = taskBtn.querySelector('.task-edit-btn');
          editBtnEl?.addEventListener('click', (event) => {
            event.stopPropagation();
            const open = editPanel.style.display !== 'none';
            editPanel.style.display = open ? 'none' : 'block';
            if (!open) { (editPanel.querySelector('.task-edit-name'))?.focus(); }
          });

          const previewBtnEl = taskBtn.querySelector('.task-preview-btn');
          previewBtnEl?.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'previewTask', playlistIndex: i, taskIndex: originalIndex });
          });

          editPanel.querySelector('.task-edit-save')?.addEventListener('click', () => {
            const nameVal = ((editPanel.querySelector('.task-edit-name'))?.value || '').trim();
            const promptVal = (editPanel.querySelector('.task-edit-prompt'))?.value || '';
            if (!nameVal) { (editPanel.querySelector('.task-edit-name'))?.focus(); return; }
            vscode.postMessage({ type: 'saveTaskEdit', playlistIndex: i, taskIndex: originalIndex, name: nameVal, prompt: promptVal });
            editPanel.style.display = 'none';
          });

          editPanel.querySelector('.task-edit-cancel')?.addEventListener('click', () => {
            editPanel.style.display = 'none';
          });

          targetEl.appendChild(taskBtn);
          targetEl.appendChild(editPanel);
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
      // Restore scroll: on first load auto-scroll to first active/pending task; otherwise restore saved position
      if (!planListScrollInitialized) {
        planListScrollInitialized = true;
        requestAnimationFrame(() => {
          const activeEl = targetEl.querySelector('.item[data-status="running"]')
            || targetEl.querySelector('.item[data-status="failed"]')
            || targetEl.querySelector('.item[data-status="pending"]');
          if (activeEl) {
            activeEl.scrollIntoView({ block: 'center' });
          }
        });
      } else if (savedScrollTop > 0) {
        requestAnimationFrame(() => { targetEl.scrollTop = savedScrollTop; });
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
      const playlistDone = list.filter((group) => {
        const s = String(group.playlistStatus || '').toLowerCase();
        return s === 'completed' || s === 'failed';
      }).length;
      const taskTotal = list.reduce((sum, group) => sum + (group.progress?.total || 0), 0);
      // completed = truly completed (or skipped), failed = failed/blocked
      const taskCompleted = list.reduce((sum, group) => {
        const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
        return sum + tasks.filter((t) => { const s = String(t?.status || '').toLowerCase(); return s === 'completed' || s === 'skipped'; }).length;
      }, 0);
      const taskFailed = list.reduce((sum, group) => {
        const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
        return sum + tasks.filter((t) => { const s = String(t?.status || '').toLowerCase(); return s === 'failed' || s === 'blocked'; }).length;
      }, 0);
      const pct = taskTotal > 0 ? Math.round(((taskCompleted + taskFailed) / taskTotal) * 100) : 0;

      const planLabel = (activePlanName || '').replace(/^MOAG\s*[-:]\s*/i, '').trim() || 'Plan';
      const allDone = taskTotal > 0 && taskFailed === 0 && (taskCompleted >= taskTotal);

      if (allDone) {
        // Auto-collapse sandbox + AI rules sections — they're irrelevant for a completed plan
        if (!sbCollapsed) {
          sbCollapsed = true;
          sbToggleEl?.classList.add('collapsed');
          sbBodyEl?.classList.add('collapsed');
        }
        // ─── Completion ceremony: replace progress bar with done banner ───
        planOverviewTitleEl.textContent = planLabel;
        planOverviewMetaEl.textContent = taskTotal + ' tasks · ' + playlistTotal + ' playlists — all done';
        planOverviewFillEl.style.width = '100%';
        planOverviewFillEl.classList.remove('has-failed');
        planOverviewEl.classList.add('done');
        if (planOverviewFailedMetaEl) { planOverviewFailedMetaEl.style.display = 'none'; }
        // Show done action row (Create PR / New Sprint)
        var doneBannerEl = document.getElementById('planDoneBanner');
        if (!doneBannerEl) {
          doneBannerEl = document.createElement('div');
          doneBannerEl.id = 'planDoneBanner';
          doneBannerEl.className = 'plan-done-banner';
          doneBannerEl.innerHTML =
            '<span class="plan-done-check">✓ Plan complete</span>' +
            '<div class="plan-done-actions">' +
              '<button class="plan-done-btn" onclick="vscode.postMessage({type:\'createPR\'})">Create PR</button>' +
              '<button class="plan-done-btn ghost" onclick="vscode.postMessage({type:\'switchPlan\'})">New Sprint</button>' +
            '</div>';
          planOverviewEl.appendChild(doneBannerEl);
        }
        doneBannerEl.style.display = 'flex';
      } else {
        planOverviewTitleEl.textContent = planLabel + ' Progress';
        planOverviewMetaEl.textContent = playlistDone + '/' + playlistTotal + ' playlists, ' + taskCompleted + '/' + taskTotal + ' tasks completed';
        planOverviewFillEl.style.width = pct + '%';
        planOverviewFillEl.classList.toggle('has-failed', taskFailed > 0);
        planOverviewEl.classList.remove('done');
        var existingBanner = document.getElementById('planDoneBanner');
        if (existingBanner) { existingBanner.style.display = 'none'; }
        if (planOverviewFailedMetaEl) {
          if (taskFailed > 0) {
            planOverviewFailedMetaEl.textContent = '⚠ ' + taskFailed + ' task' + (taskFailed === 1 ? '' : 's') + ' failed — use "Fix All" to retry';
            planOverviewFailedMetaEl.style.display = '';
          } else {
            planOverviewFailedMetaEl.style.display = 'none';
          }
        }
      }

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
      planActiveNameEl.textContent = label;
      planPlayBtnEl.innerHTML = runnerState === 'playing' ? iconMarkup('pause') : iconMarkup('play');
      planPlayBtnEl.title = runnerState === 'playing' ? 'Pause Plan' : 'Execute Plan';
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
      planExecCounterEl.textContent = taskDone + '/' + taskTotal;
      const runnerLabel = runnerState === 'playing'
        ? 'EXECUTING'
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
      const failedTaskCount = (planGroups || []).reduce((sum, group) => {
        const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
        return sum + tasks.filter((t) => {
          const s = String(t?.status || '').toLowerCase();
          return s === 'failed' || s === 'blocked';
        }).length;
      }, 0);
      const planState = runnerState === 'playing' ? 'running'
        : runnerState === 'paused' ? 'paused'
        : runnerState === 'stopping' ? 'stopping'
        : failedTaskCount > 0 ? 'failed'
        : (taskDone === taskTotal && taskTotal > 0) ? 'completed'
        : 'idle';
      planToolsEl.classList.remove('plan-state-idle', 'plan-state-running', 'plan-state-paused', 'plan-state-stopping', 'plan-state-failed', 'plan-state-completed');
      planToolsEl.classList.add('plan-state-' + planState);
      const workflowOrder = ['chat', 'plan', 'review', 'execute', 'fix', 'done'];
      const workflowStep = planState === 'running' || planState === 'paused' || planState === 'stopping' ? 'execute'
        : planState === 'failed' ? 'fix'
        : planState === 'completed' ? 'done'
        : taskTotal > 0 ? 'review'
        : 'plan';
      const workflowStepperEl = document.getElementById('workflowStepper');
      if (workflowStepperEl) {
        const activeIdx = workflowOrder.indexOf(workflowStep);
        workflowStepperEl.querySelectorAll('[data-step]').forEach((el) => {
          const idx = workflowOrder.indexOf(el.getAttribute('data-step') || '');
          el.classList.remove('active', 'done');
          if (idx === activeIdx) { el.classList.add('active'); }
          else if (idx < activeIdx) { el.classList.add('done'); }
        });
      }
      if (planFixAllBtnEl) {
        planFixAllBtnEl.style.display = 'none';
      }
      // Fix All button in the status bar
      if (planFixAllBarBtnEl) {
        if (failedTaskCount > 0) {
          planFixAllBarBtnEl.textContent = 'Fix All (' + failedTaskCount + ')';
          planFixAllBarBtnEl.style.display = '';
          planFixAllBarBtnEl.disabled = runnerState === 'playing';
        } else {
          planFixAllBarBtnEl.style.display = 'none';
        }
      }
      planStopBtnEl.disabled = runnerState !== 'playing';
      if (planOpenPrdBtnEl) {
        const hasPrd = !!(planPrdSource || detectedPrdFilePath);
        planOpenPrdBtnEl.classList.toggle('visible', hasPrd);
        const prdLabel = detectedPrdFilePath
          ? ('&#128196; ' + detectedPrdFilePath.split(/[\\/]/).pop())
          : '&#128196; PRD';
        planOpenPrdBtnEl.innerHTML = prdLabel;
        planOpenPrdBtnEl.title = detectedPrdFilePath
          ? ('Open PRD: ' + detectedPrdFilePath)
          : (planPrdSource ? 'Open source PRD' : '');
      }
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
      const u = msg.tokenUsage;
      const totalTok = (u && ((u.totalTokens || 0) || ((u.inputTokens || 0) + (u.outputTokens || 0)))) || 0;
      const tokLabel = totalTok > 0
        ? (totalTok >= 1000 ? (totalTok / 1000).toFixed(1) + 'K' : String(totalTok)) + ' tok'
        : '';
      const costLabel = u && u.estimatedCost > 0
        ? '$' + u.estimatedCost.toFixed(u.estimatedCost < 0.01 ? 4 : 2)
        : '';
      const tokTitle = u && u.inputTokens
        ? 'In: ' + (u.inputTokens || 0).toLocaleString() + '  Out: ' + (u.outputTokens || 0).toLocaleString() + '  Total: ' + totalTok.toLocaleString()
        : '';
      return (
        '<div class="result-card">' +
          '<span class="result-pill ' + escHtml(normalized) + '">' + escHtml(outcome) + '</span>' +
          '<span class="result-strong">' + escHtml(fileLabel) + '</span>' +
          '<span class="result-sep">' + ICON_DOT + '</span>' +
          '<span>' + escHtml(duration) + '</span>' +
          (tokLabel || costLabel
            ? '<span class="result-sep">' + ICON_DOT + '</span>' +
              '<span class="result-tokens" title="' + escHtml(tokTitle) + '">' + escHtml([tokLabel, costLabel].filter(Boolean).join(' · ')) + '</span>'
            : '') +
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

      // Update empty-state text based on whether a plan with pending tasks is loaded
      if (list.length === 0) {
        const pendingTasks = Array.isArray(planGroups)
          ? planGroups.reduce(function(n, g) {
              return n + (Array.isArray(g.tasks) ? g.tasks.filter(function(t) {
                const s = String(t.status || '').toLowerCase();
                return !s || s === 'pending';
              }).length : 0);
            }, 0)
          : 0;
        const planHeader = chatEmptyEl.querySelector('strong');
        if (planHeader) {
          if (pendingTasks > 0) {
            planHeader.textContent = pendingTasks + ' task' + (pendingTasks > 1 ? 's' : '') + ' ready to run';
            const hint = chatEmptyEl.querySelector('br + br') || chatEmptyEl.querySelector('br');
            // Replace static hint text
            const secondText = chatEmptyEl.childNodes[2];
            if (secondText && secondText.nodeType === Node.TEXT_NODE) { secondText.textContent = ''; }
          } else {
            planHeader.textContent = 'New conversation';
          }
        }
      }

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
      const ctxRunnerLabel = runnerState === 'playing' ? 'EXECUTING' : runnerState.toUpperCase();
      ctxRunnerEl.innerHTML = runnerSvg + ' ' + escHtml(ctxRunnerLabel);
    }

    function setActiveTab(tab) {
      activeTab = tab === 'plan' || tab === 'history' ? tab : 'chat';
      tabEls.forEach((el) => el.classList.toggle('active', el.dataset.tab === activeTab));

      const showChat = activeTab === 'chat';
      chatScreenEl.classList.toggle('active', showChat);
      planListEl.classList.toggle('active', activeTab === 'plan');
      planToolsEl.classList.toggle('active', activeTab === 'plan');
      planOverviewEl.classList.toggle('active', activeTab === 'plan' && planGroups.length > 0);
      planRulesSectionEl?.classList.toggle('active', activeTab === 'plan');
      if (activeTab !== 'plan') {
        planQueueEl.classList.remove('active');
      }
      renderPlanListHeading();
      historyListEl.classList.toggle('active', activeTab === 'history');
      historyToolsEl.classList.toggle('active', activeTab === 'history');
      sbSectionEl.classList.toggle('active', activeTab === 'plan');
      rulesSectionEl.classList.toggle('active', activeTab === 'plan');

      // PRD button in composer toolbar: visible in chat tab only
      if (composerPrdBtnEl) {
        composerPrdBtnEl.style.display = showChat ? '' : 'none';
        composerPrdBtnEl.classList.toggle('has-prd', !!planPrdSource);
        composerPrdBtnEl.title = planPrdSource ? 'Update PRD linked to this plan' : 'Add PRD to this plan';
        composerPrdBtnEl.innerHTML = planPrdSource ? '&#128196; PRD &#10003;' : '&#128196; PRD';
      }

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

    function updateFilePill() {
      if (!filePillRowEl || !filePillNameEl) { return; }
      const show = activeFile && !activeFileDismissed;
      filePillRowEl.style.display = show ? '' : 'none';
      if (show && activeFile) { filePillNameEl.textContent = activeFile.name; }
    }

    function submit() {
      const text = promptEl.value.trim();
      if (!text || sendEl.disabled) {
        return;
      }
      // PRD draft mode — route to guided Q&A instead of normal execution
      if (prdMode) {
        appendPrdMessage('user', text);
        promptEl.value = '';
        promptEl.style.height = '';
        var typing = showPrdTyping();
        prdAnswers.push(text);
        vscode.postMessage({ type: 'prdAnswer', answer: text, step: prdStep, answers: prdAnswers });
        prdStep++;
        return;
      }
      setActiveTab('chat');
      if (pendingFixRef) {
        const ref = pendingFixRef;
        pendingFixRef = null;
        updateComposerHint();
        vscode.postMessage({
          type: 'retryTaskWithPrompt',
          playlistIndex: ref.playlistIndex,
          taskIndex: ref.taskIndex,
          prompt: text,
        });
        return;
      }
      const injectPath = (activeFile && !activeFileDismissed) ? activeFile.path : undefined;
      vscode.postMessage({
        type: 'submit',
        text,
        engineId: engineEl.disabled ? undefined : engineEl.value,
        imageData: attachedImage || undefined,
        activeFilePath: injectPath,
      });
    }

    function escHtml(value) {
      const div = document.createElement('div');
      div.textContent = value || '';
      return div.innerHTML;
    }

    sendEl.addEventListener('click', submit);
    generatePlanBtnEl?.addEventListener('click', () => {
      const text = promptEl.value.trim();
      if (!text || generatePlanBtnEl.disabled) { return; }
      vscode.postMessage({ type: 'generatePlan', text });
    });
    addToPlanBtnEl?.addEventListener('click', () => {
      const text = promptEl.value.trim();
      if (!text) { return; }
      vscode.postMessage({ type: 'addToPlan', text });
    });
    filePillDismissEl?.addEventListener('click', () => {
      activeFileDismissed = true;
      updateFilePill();
    });
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
      } else if (event.key === 'Enter' && (event.altKey || event.shiftKey)) {
        event.preventDefault();
        const text = promptEl.value.trim();
        if (text) { vscode.postMessage({ type: 'addToPlan', text }); }
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
    planFixAllBtnEl?.addEventListener('click', () => {
      vscode.postMessage({ type: 'fixAllFailed' });
    });
    planFixAllBarBtnEl?.addEventListener('click', () => {
      vscode.postMessage({ type: 'fixAllFailed' });
    });
    reportIssueBtnEl?.addEventListener('click', () => {
      vscode.postMessage({ type: 'reportIssue' });
    });
    planListEl.addEventListener('scroll', () => { planListScrollTop = planListEl.scrollTop; }, { passive: true });
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
    var prdScreenMode = 'generate'; // 'generate' | 'update'
    function openPrdInputScreen(mode) {
      prdScreenMode = mode;
      planManageMenuEl?.classList.remove('open');
      if (mode === 'update') {
        if (prdInputTitleEl) { prdInputTitleEl.textContent = planPrdSource ? 'Update PRD' : 'Add PRD'; }
        if (prdInputHintEl) { prdInputHintEl.innerHTML = planPrdSource
          ? 'Edit your PRD below — changes will be saved to the current plan and used for TTT criteria and Verify.'
          : 'Paste your PRD below to link it to the current plan. Use <strong>Verify Against PRD</strong> in the Test &amp; Verify panel after your test playlist runs.'; }
        if (prdGenerateBtnEl) { prdGenerateBtnEl.textContent = 'Save to Plan'; }
        if (prdTextareaEl && planPrdSource) {
          prdTextareaEl.value = planPrdSource;
          var len = planPrdSource.length;
          if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
          if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
        }
      } else {
        if (prdInputTitleEl) { prdInputTitleEl.textContent = 'Generate Plan from PRD'; }
        if (prdInputHintEl) { prdInputHintEl.innerHTML = 'Paste a PRD or describe what you want to build &mdash; MOAG will generate a Design &rarr; Development &rarr; Testing plan.'; }
        if (prdGenerateBtnEl) { prdGenerateBtnEl.textContent = 'Generate Plan →'; }
        if (prdTextareaEl) { prdTextareaEl.value = ''; prdTextareaEl.style.height = '80px'; }
        if (prdCharCountEl) { prdCharCountEl.textContent = '0 chars'; }
        if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = true; }
        if (prdChipsRowEl) { prdChipsRowEl.style.display = 'flex'; }
        renderPrdProjectCard();
      }
      if (prdInputScreenEl) { prdInputScreenEl.classList.add('active'); }
      setTimeout(() => { prdTextareaEl?.focus(); }, 50);
    }
    function showPrdInputScreen() { openPrdInputScreen('generate'); }
    function hidePrdInputScreen() {
      if (prdInputScreenEl) { prdInputScreenEl.classList.remove('active'); }
    }
    planFromPrdBtnEl?.addEventListener('click', showPrdInputScreen);
    planFromTemplateBtnEl?.addEventListener('click', () => {
      planManageMenuEl?.classList.remove('open');
      vscode.postMessage({ type: 'newPlanFromTemplate' });
    });
    chatEmptyTemplateBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'newPlanFromTemplate' }));
    planOpenPrdBtnEl?.addEventListener('click', () => {
      vscode.postMessage({ type: 'openPrdFromPlan' });
    });
    chatEmptyPrdBtnEl?.addEventListener('click', showPrdInputScreen);
    chatStartPrdBtnEl?.addEventListener('click', () => { setActiveTab('chat'); startPrdMode(); });
    composerPrdBtnEl?.addEventListener('click', () => openPrdInputScreen('update'));
    prdModeCancelBtnEl?.addEventListener('click', exitPrdMode);
    prdBackBtnEl?.addEventListener('click', hidePrdInputScreen);
    function updatePrdAiBtn() {
      if (!prdAiBtnEl || !prdTextareaEl) { return; }
      var t = prdTextareaEl.value.trim();
      var looksLikePrd = t.length > 400 || /^#{1,3}\s|acceptance criteria|AC[0-9]*[:.]/im.test(t);
      prdAiBtnEl.textContent = looksLikePrd ? '✨ Improve with AI' : '✨ Draft with AI';
    }
    function renderPrdProjectCard() {
      if (!prdProjectCardEl || !prdProjectNameEl || !prdProjectStackEl) { return; }
      if (prdProjectMeta && prdProjectMeta.name) {
        prdProjectNameEl.textContent = prdProjectMeta.name;
        prdProjectStackEl.textContent = prdProjectMeta.stack ? '· ' + prdProjectMeta.stack : '';
        prdProjectCardEl.style.display = 'flex';
      } else {
        prdProjectCardEl.style.display = 'none';
      }
    }
    function autoResizePrdTextarea() {
      if (!prdTextareaEl) { return; }
      prdTextareaEl.style.height = 'auto';
      var h = Math.min(Math.max(prdTextareaEl.scrollHeight, 80), 220);
      prdTextareaEl.style.height = h + 'px';
    }
    if (prdChipsRowEl) {
      prdChipsRowEl.querySelectorAll('.prd-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          var prompt = chip.getAttribute('data-prompt');
          if (prdTextareaEl && prompt) {
            prdTextareaEl.value = prompt;
            prdTextareaEl.dispatchEvent(new Event('input'));
            prdTextareaEl.focus();
          }
        });
      });
    }
    function updatePrdVersionBar(vers) {
      prdVersions = vers || [];
      if (!prdVersionBarEl || !prdVersionSelectEl || !prdVersionSaveBtnEl) { return; }
      if (prdVersions.length > 0) {
        prdVersionBarEl.classList.add('visible');
        prdVersionSelectEl.innerHTML = prdVersions.map(function(v) {
          var d = new Date(v.createdAt).toLocaleDateString();
          return '<option value="' + v.version + '">' + v.version + ' (' + d + ')</option>';
        }).join('');
        prdVersionSaveBtnEl.textContent = 'Save as v' + (prdVersions.length + 1) + '.0';
      } else {
        prdVersionBarEl.classList.remove('visible');
        prdVersionSaveBtnEl.textContent = 'Save as v1.0';
      }
    }
    prdTextareaEl?.addEventListener('input', function() {
      var len = prdTextareaEl.value.length;
      if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
      if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
      if (prdChipsRowEl) { prdChipsRowEl.style.display = len > 0 ? 'none' : 'flex'; }
      autoResizePrdTextarea();
      updatePrdAiBtn();
    });
    prdVersionSelectEl?.addEventListener('change', function() {
      var ver = prdVersions.find(function(v) { return v.version === prdVersionSelectEl.value; });
      if (ver && prdTextareaEl) {
        prdTextareaEl.value = ver.text;
        var len = ver.text.length;
        if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
        if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
        updatePrdAiBtn();
      }
    });
    prdVersionSaveBtnEl?.addEventListener('click', function() {
      var text = prdTextareaEl ? prdTextareaEl.value.trim() : '';
      if (!text) { return; }
      var nextVersion = 'v' + (prdVersions.length + 1) + '.0';
      vscode.postMessage({ type: 'savePrdVersion', text: text, version: nextVersion });
    });
    prdAiBtnEl?.addEventListener('click', function() {
      var text = prdTextareaEl ? prdTextareaEl.value.trim() : '';
      if (!text) { vscode.postMessage({ type: 'planFromPrd' }); return; }
      var looksLikePrd = text.length > 400 || /^#{1,3}\s|acceptance criteria|AC[0-9]*[:.]/im.test(text);
      prdAiBtnEl.disabled = true;
      prdAiBtnEl.textContent = looksLikePrd ? 'Improving…' : 'Drafting PRD…';
      vscode.postMessage({ type: 'prdAiImprove', text: text });
    });
    prdBrowseBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'openPrdFile' }));
    prdGenerateBtnEl?.addEventListener('click', function() {
      var text = prdTextareaEl ? prdTextareaEl.value.trim() : '';
      if (!text) { return; }
      hidePrdInputScreen();
      if (prdScreenMode === 'update') {
        planPrdSource = text;
        renderTavPanel();
        vscode.postMessage({ type: 'savePrdToPlan', prdText: text });
      } else {
        vscode.postMessage({ type: 'generatePlanFromPrd', prdText: text });
      }
    });
    planManageBtnEl.addEventListener('click', (event) => {
      event.stopPropagation();
      planManageMenuEl.classList.toggle('open');
    });
    planManageMenuEl.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    planFilterChipsEl.querySelectorAll('[data-plan-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const next = chip.getAttribute('data-plan-filter') || 'all';
        planFilterMode = (next === 'pending' || next === 'completed' || next === 'failed') ? next : 'all';
        renderPlanGroups(planListEl, planGroups);
        renderPlanTools();
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

    // ─── Sidebar AI Rules ───
    const rulesSectionEl = document.getElementById('sidebarRules');
    const rulesToggleEl = document.getElementById('rulesToggle');
    const rulesBodyEl = document.getElementById('rulesBody');
    const rulesBadgeEl = document.getElementById('rulesBadge');
    const rulesListEl = document.getElementById('rulesList');
    const rulesEmptyEl = document.getElementById('rulesEmpty');
    const rulesAddBtnEl = document.getElementById('rulesAddBtn');
    const rulesLibBtnEl = document.getElementById('rulesLibBtn');
    let rulesCollapsed = true;
    let aiRules = [];

    rulesToggleEl.addEventListener('click', (e) => {
      if (e.target === rulesAddBtnEl || e.target === rulesLibBtnEl ||
          rulesAddBtnEl.contains(e.target) || rulesLibBtnEl.contains(e.target)) { return; }
      rulesCollapsed = !rulesCollapsed;
      rulesToggleEl.classList.toggle('collapsed', rulesCollapsed);
      rulesBodyEl.classList.toggle('collapsed', rulesCollapsed);
    });
    rulesAddBtnEl.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'addRule' }); });
    rulesLibBtnEl.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openRulesLibrary' }); });

    function renderSidebarRules(rules) {
      aiRules = Array.isArray(rules) ? rules : [];
      const activeCount = aiRules.filter(r => r.enabled).length;
      rulesBadgeEl.textContent = activeCount > 0 ? activeCount + ' active' : '';
      rulesBadgeEl.className = 'sidebar-rules-badge' + (activeCount > 0 ? ' has-active' : '');
      rulesListEl.innerHTML = '';
      if (aiRules.length === 0) {
        rulesEmptyEl.style.display = '';
      } else {
        rulesEmptyEl.style.display = 'none';
        for (var i = 0; i < aiRules.length; i++) {
          var rule = aiRules[i];
          var item = document.createElement('div');
          item.className = 'rule-item';
          item.dataset.id = rule.id;
          item.dataset.scope = rule.scope;
          var toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'rule-toggle' + (rule.enabled ? ' enabled' : '');
          toggleBtn.title = rule.enabled ? 'Disable rule' : 'Enable rule';
          toggleBtn.dataset.id = rule.id;
          toggleBtn.dataset.scope = rule.scope;
          var nameSpan = document.createElement('span');
          nameSpan.className = 'rule-name' + (rule.enabled ? '' : ' disabled');
          nameSpan.textContent = rule.name;
          nameSpan.title = rule.name + ' (' + rule.charCount + ' chars)';
          var scopeBadge = document.createElement('span');
          scopeBadge.className = 'rule-scope-badge' + (rule.scope === 'workspace' ? ' workspace' : '');
          scopeBadge.textContent = rule.scope === 'workspace' ? 'ws' : 'global';
          var actions = document.createElement('div');
          actions.className = 'rule-actions';
          var editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'rule-action-btn';
          editBtn.title = 'Edit rule';
          editBtn.textContent = '✏';
          editBtn.dataset.id = rule.id;
          editBtn.dataset.scope = rule.scope;
          var deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'rule-action-btn delete';
          deleteBtn.title = 'Delete rule';
          deleteBtn.textContent = '✕';
          deleteBtn.dataset.id = rule.id;
          deleteBtn.dataset.scope = rule.scope;
          actions.appendChild(editBtn);
          actions.appendChild(deleteBtn);
          item.appendChild(toggleBtn);
          item.appendChild(nameSpan);
          item.appendChild(scopeBadge);
          item.appendChild(actions);
          rulesListEl.appendChild(item);
          toggleBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'toggleRule', id: this.dataset.id, scope: this.dataset.scope });
          });
          editBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'editRule', id: this.dataset.id, scope: this.dataset.scope });
          });
          deleteBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'deleteRule', id: this.dataset.id, scope: this.dataset.scope });
          });
        }
      }
      // Auto-expand when first rule is added
      if (aiRules.length > 0 && rulesCollapsed && activeCount > 0) {
        rulesCollapsed = false;
        rulesToggleEl.classList.remove('collapsed');
        rulesBodyEl.classList.remove('collapsed');
      }
    }

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
    const sbTestToolEl = document.getElementById('sbTestTool');
    const sbTttHintRowEl = document.getElementById('sbTttHintRow');
    const sbTttHintEl = document.getElementById('sbTttHint');
    // TAV panel elements
    const tavPanelEl = document.getElementById('tavPanel');
    const tavHeaderEl = document.getElementById('tavHeader');
    const tavBodyEl = document.getElementById('tavBody');
    const tavStateBadgeEl = document.getElementById('tavStateBadge');
    const tavTestToolEl = document.getElementById('tavTestTool');
    const tavSbDotEl = document.getElementById('tavSbDot');
    const tavSbStatusEl = document.getElementById('tavSbStatus');
    const tavSbUrlEl = document.getElementById('tavSbUrl');
    const tavLaunchEl = document.getElementById('tavLaunch');
    const tavStopEl = document.getElementById('tavStop');
    const tavScreenshotEl = document.getElementById('tavScreenshot');
    const tavPrdValEl = document.getElementById('tavPrdVal');
    const tavOpenPrdEl = document.getElementById('tavOpenPrd');
    const tavHintRowEl = document.getElementById('tavHintRow');
    const tavHintEl = document.getElementById('tavHint');
    const tavCriteriaWrapEl = document.getElementById('tavCriteriaWrap');
    const tavVerifyBtnEl = document.getElementById('tavVerifyBtn');
    const tavFixIterEl = document.getElementById('tavFixIter');
    let tavCollapsed = false;
    let tavSandboxState = null;
    let tavCriteriaChecked = [];
    let sbCollapsed = false;

    sbToggleEl.addEventListener('click', () => {
      sbCollapsed = !sbCollapsed;
      sbToggleEl.classList.toggle('collapsed', sbCollapsed);
      sbBodyEl.classList.toggle('collapsed', sbCollapsed);
    });
    sbLaunchEl.addEventListener('click', () => vscode.postMessage({ type: 'launchSandbox' }));
    sbStopEl.addEventListener('click', () => vscode.postMessage({ type: 'stopSandbox' }));
    sbScreenshotEl.addEventListener('click', () => vscode.postMessage({ type: 'takeScreenshot' }));
    tttVerifyBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'tttAllCriteriaVerified' }));

    // ─── GitHub Sync Panel ───
    const ghSyncHeaderIndicatorEl = document.getElementById('ghSyncHeaderIndicator');
    const ghSyncSectionEl = document.getElementById('ghSyncSection');
    const ghSyncToggleEl = document.getElementById('ghSyncToggle');
    const ghSyncBodyEl = document.getElementById('ghSyncBody');
    const ghSyncDotEl = document.getElementById('ghSyncDot');
    const ghSyncRepoEl = document.getElementById('ghSyncRepo');
    const ghSyncLastEl = document.getElementById('ghSyncLast');
    const ghSyncCountEl = document.getElementById('ghSyncCount');
    const ghSyncRepoInputEl = document.getElementById('ghSyncRepoInput');
    const ghSyncLabelInputEl = document.getElementById('ghSyncLabelInput');
    const ghSyncConnectEl = document.getElementById('ghSyncConnect');
    const ghSyncSetupEl = document.getElementById('ghSyncSetup');
    const ghSyncConnectedEl = document.getElementById('ghSyncConnected');
    const ghSyncPollNowEl = document.getElementById('ghSyncPollNow');
    const ghSyncDisconnectEl = document.getElementById('ghSyncDisconnect');
    const ghSyncEnabledToggleEl = document.getElementById('ghSyncEnabledToggle');
    const ghSyncToggleLabelEl = document.getElementById('ghSyncToggleLabel');
    let ghSyncCollapsed = false;

    ghSyncToggleEl?.addEventListener('click', () => {
      ghSyncCollapsed = !ghSyncCollapsed;
      ghSyncToggleEl.classList.toggle('collapsed', ghSyncCollapsed);
      if (ghSyncBodyEl) { ghSyncBodyEl.classList.toggle('collapsed', ghSyncCollapsed); }
    });
    ghSyncConnectEl?.addEventListener('click', () => {
      const repo = (ghSyncRepoInputEl && ghSyncRepoInputEl.value.trim()) || '';
      const label = (ghSyncLabelInputEl && ghSyncLabelInputEl.value.trim()) || 'moag';
      if (!repo) { ghSyncRepoInputEl && ghSyncRepoInputEl.focus(); return; }
      vscode.postMessage({ type: 'ghSyncConfigure', repo, label, enabled: true });
    });
    ghSyncPollNowEl?.addEventListener('click', () => vscode.postMessage({ type: 'ghSyncPollNow' }));
    ghSyncDisconnectEl?.addEventListener('click', () => {
      vscode.postMessage({ type: 'ghSyncConfigure', repo: '', label: 'moag', enabled: false });
    });
    ghSyncEnabledToggleEl?.addEventListener('change', () => {
      const enabled = !!ghSyncEnabledToggleEl.checked;
      vscode.postMessage({ type: 'ghSyncToggleEnabled', enabled });
    });

    function renderGhSync(state) {
      const repo = (state && state.issueSyncRepo) || '';
      const enabled = !!(state && state.issueSyncEnabled);
      const hasRepo = !!repo;

      // Header indicator — always visible in plan overview regardless of scroll
      if (ghSyncHeaderIndicatorEl) {
        if (hasRepo) {
          const dotCls = enabled ? 'gh-sync-header-dot active' : 'gh-sync-header-dot';
          const shortRepo = repo.split('/').pop() || repo;
          ghSyncHeaderIndicatorEl.innerHTML = '<span class="' + dotCls + '"></span><span class="gh-sync-header-label">' + shortRepo + '</span>';
          ghSyncHeaderIndicatorEl.style.display = '';
          ghSyncHeaderIndicatorEl.title = (enabled ? 'GitHub sync on — click to manage' : 'GitHub sync off — click to manage') + ' (' + repo + ')';
        } else {
          ghSyncHeaderIndicatorEl.innerHTML = '<span class="gh-sync-header-dot"></span><span class="gh-sync-header-label gh-sync-header-connect">Connect GitHub</span>';
          ghSyncHeaderIndicatorEl.style.display = '';
          ghSyncHeaderIndicatorEl.title = 'Connect GitHub Issues sync — click to configure';
        }
        ghSyncHeaderIndicatorEl.onclick = function() {
          vscode.postMessage({ type: 'ghSyncConfigure' });
        };
      }

      if (!ghSyncSectionEl) { return; }

      if (ghSyncSetupEl)     { ghSyncSetupEl.style.display = hasRepo ? 'none' : ''; }
      if (ghSyncConnectedEl) { ghSyncConnectedEl.style.display = hasRepo ? '' : 'none'; }

      if (ghSyncDotEl) {
        ghSyncDotEl.className = 'gh-sync-status-dot' + (hasRepo && enabled ? ' active' : '');
      }
      if (ghSyncRepoEl) { ghSyncRepoEl.textContent = repo; }
      if (ghSyncEnabledToggleEl) { ghSyncEnabledToggleEl.checked = enabled; }
      if (ghSyncToggleLabelEl)   { ghSyncToggleLabelEl.textContent = enabled ? 'On' : 'Off'; }
      if (ghSyncLastEl) {
        const last = state && state.issueSyncLastPoll;
        ghSyncLastEl.textContent = last
          ? 'Last polled: ' + new Date(last).toLocaleTimeString()
          : enabled ? 'Polling every ' + Math.round(((state && state.issueSyncIntervalMs) || 300000) / 60000) + ' min' : 'Sync off — toggle to enable';
      }
      if (ghSyncCountEl) {
        const count = state && state.issueSyncTrackedCount;
        ghSyncCountEl.textContent = count != null && count > 0 ? count + ' issue' + (count !== 1 ? 's' : '') + ' tracked' : '';
      }
      // gh auth status row
      var ghAuthEl = document.getElementById('ghSyncAuthStatus');
      if (ghAuthEl) {
        var authUser = state && state.ghAuthUser;
        if (authUser) {
          ghAuthEl.innerHTML = '<span class="gh-sync-auth-dot ok"></span><span class="gh-sync-auth-label">gh: ' + authUser + '</span>';
          ghAuthEl.title = 'GitHub CLI authenticated as ' + authUser;
        } else {
          ghAuthEl.innerHTML = '<span class="gh-sync-auth-dot"></span><span class="gh-sync-auth-label gh-sync-auth-warn">gh not authenticated — run "gh auth login"</span>';
          ghAuthEl.title = 'GitHub CLI is not authenticated';
        }
      }
    }

    sbTestToolEl?.addEventListener('change', () => {
      testTool = sbTestToolEl.value;
      vscode.postMessage({ type: 'setTestTool', value: testTool });
      renderSandboxTttHint();
    });

    // TAV panel
    tavHeaderEl?.addEventListener('click', () => {
      tavCollapsed = !tavCollapsed;
      tavHeaderEl.classList.toggle('collapsed', tavCollapsed);
      if (tavBodyEl) { tavBodyEl.classList.toggle('collapsed', tavCollapsed); }
    });
    tavTestToolEl?.addEventListener('change', () => {
      testTool = tavTestToolEl.value;
      if (sbTestToolEl) { sbTestToolEl.value = testTool; }
      vscode.postMessage({ type: 'setTestTool', value: testTool });
      renderTavPanel();
    });
    tavLaunchEl?.addEventListener('click', () => vscode.postMessage({ type: 'launchSandbox' }));
    tavStopEl?.addEventListener('click', () => vscode.postMessage({ type: 'stopSandbox' }));
    tavScreenshotEl?.addEventListener('click', () => vscode.postMessage({ type: 'takeScreenshot' }));
    tavOpenPrdEl?.addEventListener('click', () => vscode.postMessage({ type: 'openPrdFromPlan' }));
    tavVerifyBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'verifyAgainstPrd' }));

    function renderTavPanel() {
      if (!tavPanelEl) { return; }
      tavPanelEl.classList.toggle('active', activeTab === 'plan');
      if (activeTab !== 'plan') { return; }
      if (tavTestToolEl) { tavTestToolEl.value = testTool; }

      // Sandbox state
      var sbState = tavSandboxState;
      var sbRunning = sbState && sbState.status === 'running';
      var sbStarting = sbState && sbState.status === 'starting';
      var sbActive = sbRunning || sbStarting;
      if (tavSbDotEl) { tavSbDotEl.className = 'tav-sb-dot ' + (sbState ? (sbState.status || 'stopped') : ''); }
      if (tavSbStatusEl) {
        tavSbStatusEl.style.display = sbRunning ? 'none' : '';
        tavSbStatusEl.textContent = sbStarting ? 'Starting...' : sbState && sbState.error ? sbState.error.substring(0, 50) : 'Not started';
      }
      if (tavSbUrlEl) {
        if (sbRunning && sbState.url) {
          tavSbUrlEl.textContent = sbState.url;
          tavSbUrlEl.dataset.url = sbState.url;
          tavSbUrlEl.style.display = '';
        } else {
          tavSbUrlEl.style.display = 'none';
        }
      }
      if (tavLaunchEl) { tavLaunchEl.style.display = sbActive ? 'none' : ''; }
      if (tavStopEl) { tavStopEl.style.display = sbActive ? '' : 'none'; }
      if (tavScreenshotEl) { tavScreenshotEl.style.display = sbRunning ? '' : 'none'; }

      // Test phase detection
      var hasTestPlaylist = Array.isArray(planGroups) && planGroups.some(function(g) { return g.testPhase; });
      var testPlaylistRunning = Array.isArray(planGroups) && planGroups.some(function(g) {
        return g.testPhase && (g.playlistStatus === 'running' || g.playlistStatus === 'paused');
      });

      // State badge
      var badgeText = testPlaylistRunning ? 'Running' : hasTestPlaylist ? 'Ready' : 'Setup';
      var badgeClass = testPlaylistRunning ? 'running' : hasTestPlaylist ? 'done' : 'warn';
      if (tavStateBadgeEl) { tavStateBadgeEl.textContent = badgeText; tavStateBadgeEl.className = 'tav-state-badge ' + badgeClass; }

      // PRD row
      var hasPrd = !!(planPrdSource);
      var prdLabel = detectedPrdFilePath ? detectedPrdFilePath.split(/[\\/]/).pop() : (hasPrd ? 'Stored in plan' : 'None linked');
      if (tavPrdValEl) { tavPrdValEl.textContent = prdLabel; tavPrdValEl.style.color = hasPrd ? '' : 'var(--vscode-descriptionForeground)'; }
      if (tavOpenPrdEl) { tavOpenPrdEl.style.display = hasPrd ? '' : 'none'; }

      // Hint row
      var hint = '';
      var hintClass = '';
      if (!hasTestPlaylist) {
        hint = '⚠ No test playlist — right-click a playlist → Toggle Test Phase';
        hintClass = 'warn';
      } else if (testTool === 'sandbox' && !sbActive && !testPlaylistRunning) {
        hint = 'Sandbox will auto-launch when test playlist starts';
        hintClass = 'ok';
      } else if (testTool === 'manual' && hasTestPlaylist) {
        hint = 'Switch to "Sandbox (auto-launch)" to automate this step';
        hintClass = '';
      }
      if (tavHintRowEl) { tavHintRowEl.style.display = hint ? '' : 'none'; }
      if (tavHintEl) { tavHintEl.textContent = hint; tavHintEl.className = 'tav-hint ' + hintClass; }

      // Criteria — show when test playlist is running AND PRD exists
      if (tavCriteriaWrapEl) {
        var showCriteria = testPlaylistRunning && hasPrd;
        tavCriteriaWrapEl.style.display = showCriteria ? '' : 'none';
        if (showCriteria) {
          var criteria = parsePrdCriteria(planPrdSource);
          if (tavCriteriaChecked.length !== criteria.length) { tavCriteriaChecked = new Array(criteria.length).fill(false); }
          tavCriteriaWrapEl.innerHTML = '';
          criteria.forEach(function(text, i) {
            var row = document.createElement('label');
            row.className = 'tav-criterion' + (tavCriteriaChecked[i] ? ' checked' : '');
            var cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = !!tavCriteriaChecked[i];
            cb.addEventListener('change', function() { tavCriteriaChecked[i] = cb.checked; row.classList.toggle('checked', cb.checked); });
            var span = document.createElement('span');
            span.className = 'tav-criterion-text'; span.textContent = text;
            row.appendChild(cb); row.appendChild(span);
            tavCriteriaWrapEl.appendChild(row);
          });
        }
      }

      // Verify button
      if (tavVerifyBtnEl) { tavVerifyBtnEl.disabled = !hasPrd; }

      // Fix iteration counter
      if (tavFixIterEl) {
        if (planFixIterations > 0) {
          tavFixIterEl.textContent = '🔄 Fix loop: iteration ' + planFixIterations + '/3';
          tavFixIterEl.className = 'tav-fix-iter active';
          tavFixIterEl.style.display = '';
        } else {
          tavFixIterEl.style.display = 'none';
        }
      }

      // Hide old sandbox extras-seg when TAV is visible
      var sbSegEl = document.getElementById('sidebarSandbox');
      if (sbSegEl) { sbSegEl.style.display = activeTab === 'plan' ? 'none' : ''; }
    }
    sbUrlEl.addEventListener('click', () => {
      const url = sbUrlEl.dataset.url;
      if (url) { vscode.postMessage({ type: 'openSandboxBrowser', url: url }); }
    });

    var sbThumbEl = document.getElementById('sbThumb');

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
      if (sbScreenshotEl) {
        sbScreenshotEl.disabled = state.status !== 'running';
        sbScreenshotEl.title = state.status !== 'running' ? 'Start the sandbox first' : 'Capture screenshot and attach to next agent task';
      }
      if (sbThumbEl) {
        if (state.lastScreenshotPath) {
          sbThumbEl.src = state.lastScreenshotPath;
          sbThumbEl.style.display = 'block';
        } else {
          sbThumbEl.style.display = 'none';
        }
      }
    }

    function renderSandboxTttHint() {
      if (!sbTestToolEl || !sbTttHintRowEl || !sbTttHintEl) { return; }
      sbTestToolEl.value = testTool;
      const hasTestPlaylist = Array.isArray(planGroups) && planGroups.some(function(g) { return g.testPhase; });
      if (testTool === 'sandbox') {
        if (hasTestPlaylist) {
          sbTttHintEl.textContent = '✓ Auto-launches when test playlist runs';
          sbTttHintEl.className = 'sb-ttt-hint ok';
        } else {
          sbTttHintEl.textContent = '⚠ No test playlist — right-click a playlist → Toggle Test Phase';
          sbTttHintEl.className = 'sb-ttt-hint warn';
        }
        sbTttHintRowEl.style.display = '';
      } else if (testTool === 'manual') {
        sbTttHintRowEl.style.display = hasTestPlaylist ? '' : 'none';
        sbTttHintEl.textContent = hasTestPlaylist ? 'Manual — switch to Sandbox for auto-launch' : '';
        sbTttHintEl.className = 'sb-ttt-hint warn';
      } else {
        sbTttHintEl.textContent = hasTestPlaylist ? ('✓ ' + testTool + ' runs via test tasks') : '';
        sbTttHintEl.className = 'sb-ttt-hint ok';
        sbTttHintRowEl.style.display = hasTestPlaylist ? '' : 'none';
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'showPrdInputScreen') {
        if (prdInputScreenEl) { prdInputScreenEl.classList.add('active'); }
        setTimeout(() => { prdTextareaEl?.focus(); }, 50);
        return;
      }
      if (msg.type === 'prdMoagQuestion') {
        // Remove typing indicator if present
        var typingEl = chatFeedEl ? chatFeedEl.querySelector('.prd-typing') : null;
        if (typingEl) { typingEl.remove(); }
        appendPrdMessage('bot', msg.question);
        promptEl.placeholder = 'Your answer...';
        promptEl.focus();
        return;
      }
      if (msg.type === 'prdConvertReady') {
        var typingEl2 = chatFeedEl ? chatFeedEl.querySelector('.prd-typing') : null;
        if (typingEl2) { typingEl2.remove(); }
        appendPrdMessage('bot', 'I have enough context to write your PRD. Opening the editor now...');
        exitPrdMode();
        return;
      }
      if (msg.type === 'prdError') {
        var typingEl3 = chatFeedEl ? chatFeedEl.querySelector('.prd-typing') : null;
        if (typingEl3) { typingEl3.remove(); }
        var errWrap = document.createElement('div');
        errWrap.className = 'prd-msg prd-bot';
        var errAuthor = document.createElement('div');
        errAuthor.className = 'prd-msg-author';
        errAuthor.textContent = 'MOAG';
        var errText = document.createElement('div');
        errText.className = 'prd-msg-text';
        errText.style.color = '#f48771';
        errText.textContent = msg.error || 'Something went wrong. Please try again.';
        errWrap.appendChild(errAuthor);
        errWrap.appendChild(errText);
        if (msg.action) {
          var actionBtn = document.createElement('button');
          actionBtn.className = 'chat-empty-start-prd-btn';
          actionBtn.style.marginTop = '8px';
          actionBtn.textContent = msg.action.label;
          actionBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'runCommand', command: msg.action.command });
          });
          errWrap.appendChild(actionBtn);
        }
        if (chatFeedEl) { chatFeedEl.appendChild(errWrap); chatFeedEl.scrollTop = chatFeedEl.scrollHeight; }
        prdStep = Math.max(1, prdStep - 1);
        promptEl.focus();
        return;
      }
      if (msg.type === 'prdFileContent') {
        if (prdTextareaEl && typeof msg.text === 'string') {
          prdTextareaEl.value = msg.text;
          var len = msg.text.length;
          if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
          if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
          prdTextareaEl.focus();
        }
        return;
      }
      if (msg.type === 'prdAiImproveResult') {
        if (prdTextareaEl && typeof msg.text === 'string' && msg.text) {
          prdTextareaEl.value = msg.text;
          var len2 = msg.text.length;
          if (prdCharCountEl) { prdCharCountEl.textContent = len2 + ' chars'; }
          if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len2 < 20; }
        }
        if (prdAiBtnEl) { prdAiBtnEl.disabled = false; updatePrdAiBtn(); }
        return;
      }
      if (msg.type === 'prdVersionSaved') {
        updatePrdVersionBar(msg.versions || []);
        if (prdVersionSelectEl && msg.version) { prdVersionSelectEl.value = msg.version; }
        return;
      }
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
        planAiRules = msg.planAiRules || '';
        planPrdSource = msg.planPrdSource || '';
        detectedPrdFilePath = msg.detectedPrdFilePath || '';
        updatePrdVersionBar(msg.planPrdVersions || []);
        testTool = msg.testTool || 'manual';
        planFixIterations = msg.planFixIterations ?? 0;
        prdProjectMeta = msg.prdProjectMeta ?? { name: '', stack: '' };
        renderPrdProjectCard();
        renderPlanRulesSection();
        renderTttCriteria();
        renderSandboxTttHint();
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
        const incomingPlanName = msg.activePlanName || '';
        if (incomingPlanName !== activePlanName) {
          planListScrollInitialized = false;
          planListScrollTop = 0;
          tttCriteriaChecked = [];
        }
        activePlanName = incomingPlanName;
        activePlaylistName = msg.activePlaylistName || '';
        // Chat tab is conversation-first; no session strip row.
        renderPlanGroups(planListEl, planGroups);
        renderPlanOverview(planGroups);
        renderPlanQueue(planGroups);
        renderPlanTools();
        renderHistoryList();
        if (!prdMode) { renderChat(msg.chatTitle || 'New Chat', chatMessages); }
        renderRunnerChip(msg.runnerState || 'idle');
        renderContextBar();
        setActiveTab(activeTab);
        engineEl.disabled = busy || engineEl.options.length === 0 || engineEl.value === '';
        updateActionState();
        if (msg.sandboxState) {
          renderSidebarSandbox(msg.sandboxState);
          tavSandboxState = msg.sandboxState;
        }
        renderTavPanel();
        renderGhSync(msg);
        if (msg.aiRules !== undefined) { renderSidebarRules(msg.aiRules); }
        if (msg.activeFile !== undefined) { activeFile = msg.activeFile || null; updateFilePill(); }
      } else if (msg.type === 'rules-state') {
        renderSidebarRules(msg.rules);
      } else if (msg.type === 'active-file') {
        const prev = activeFile ? activeFile.path : null;
        activeFile = msg.file || null;
        // Auto-show pill when a new file becomes active; reset dismissed state
        if (activeFile && activeFile.path !== prev) { activeFileDismissed = false; }
        updateFilePill();
      } else if (msg.type === 'sandbox-state') {
        renderSidebarSandbox(msg.sandboxState);
        tavSandboxState = msg.sandboxState;
        renderTavPanel();
      } else if (msg.type === 'sessionCost') {
        const cost = typeof msg.cost === 'number' ? msg.cost : 0;
        const tokensIn = typeof msg.tokensIn === 'number' ? msg.tokensIn : 0;
        const tokensOut = typeof msg.tokensOut === 'number' ? msg.tokensOut : 0;
        const totalTok = tokensIn + tokensOut;
        if ((cost > 0 || totalTok > 0) && ctxCostEl) {
          const tokStr = totalTok > 0
            ? (totalTok >= 1000 ? (totalTok / 1000).toFixed(1) + 'K' : String(totalTok)) + ' tok'
            : '';
          const costStr = cost > 0 ? '$' + cost.toFixed(cost < 0.01 ? 4 : 2) : '';
          ctxCostEl.textContent = [tokStr, costStr].filter(Boolean).join(' · ');
          ctxCostEl.title = tokensIn > 0
            ? 'Input: ' + tokensIn.toLocaleString() + ' · Output: ' + tokensOut.toLocaleString() + ' · Total: ' + totalTok.toLocaleString() + ' tokens'
            : '';
          ctxCostEl.style.display = '';
        } else if (cost === 0 && ctxCostEl) {
          ctxCostEl.style.display = 'none';
        }
      } else if (msg.type === 'live-output-start') {
        // Update plan-tab live panel
        liveTaskId = msg.taskId || '';
        liveTaskName = msg.taskName || '';
        liveOutputLines = [];
        renderLivePanel();
        // Auto-switch to chat tab so the user sees the live stream
        setActiveTab('chat');
        var block = document.getElementById('live-block-' + msg.taskId);
        if (!block) {
          block = document.createElement('div');
          block.id = 'live-block-' + msg.taskId;
          block.className = 'live-output-block';
          chatFeedEl.appendChild(block);
          chatEmptyEl.style.display = 'none';
        }
        block.innerHTML =
          '<div class="live-output-header">' +
            '<svg class="msg-avatar" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1L3 9h5l-1 6 6-8H8L9 1z"/></svg>' +
            '<span class="live-output-task-name">' + escHtml(msg.taskName || 'Running...') + '</span>' +
            '<span class="live-output-badge running" id="live-badge-' + msg.taskId + '">running</span>' +
          '</div>' +
          '<pre class="live-output-body" id="live-body-' + msg.taskId + '"></pre>';
        chatFeedEl.scrollTop = chatFeedEl.scrollHeight;

      } else if (msg.type === 'live-output-chunk') {
        var bodyEl = document.getElementById('live-body-' + msg.taskId);
        if (bodyEl) {
          // Keep last 4000 chars to avoid unbounded DOM growth
          var combined = (bodyEl.textContent || '') + (msg.text || '');
          bodyEl.textContent = combined.length > 4000 ? combined.slice(-4000) : combined;
          bodyEl.scrollTop = bodyEl.scrollHeight;
        }
        // Update plan-tab live panel — split incoming text into lines, keep last 4
        if (msg.taskId === liveTaskId && msg.text) {
          var newLines = msg.text.split('\\n');
          liveOutputLines = liveOutputLines.concat(newLines).filter((l) => l.trim()).slice(-4);
          renderLivePanel();
        }

      } else if (msg.type === 'fillComposer') {
        if (promptEl) {
          promptEl.value = msg.text || '';
          autoResize();
          updateActionState();
          pendingFixRef = msg.fixRef || null;
          updateComposerHint();
          if (msg.text) {
            if (runnerState === 'idle') {
              setActiveTab('chat');
              promptEl.focus();
              promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
            }
          }
        }

      } else if (msg.type === 'live-output-end') {
        var badge = document.getElementById('live-badge-' + msg.taskId);
        if (badge) {
          var passed = msg.status === 'completed';
          badge.textContent = passed ? 'done' : 'failed';
          badge.className = 'live-output-badge ' + (passed ? 'completed' : 'failed');
        }
        // Remove block after brief pause — syncState will re-render the real result card
        var endBlock = document.getElementById('live-block-' + msg.taskId);
        if (endBlock) {
          setTimeout(function() {
            if (endBlock.parentNode) { endBlock.parentNode.removeChild(endBlock); }
          }, 1800);
        }
        // Clear the plan-tab live panel after a short delay
        if (msg.taskId === liveTaskId) {
          setTimeout(function() {
            liveTaskId = '';
            liveTaskName = '';
            liveOutputLines = [];
            renderLivePanel();
          }, 2000);
        }
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

