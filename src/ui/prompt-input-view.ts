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

/**
 * A fresh nonce per render. The CSP admits exactly the script carrying it, so
 * an injected <script> without the value cannot execute.
 */
function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) { out += chars[Math.floor(Math.random() * chars.length)]; }
  return out;
}

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
    webviewView.webview.options = {
      enableScripts: true,
      // Without this the compiled sidebar script cannot be loaded at all.
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

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

  /**
   * The script is a separate compiled file, not an inline block. It used to be
   * 2,869 lines inside this template literal, where the compiler never parsed it.
   */
  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'sidebar.js'),
    );
    // A fresh nonce per render: the CSP admits exactly this script and nothing else.
    const nonce = generateNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';
    img-src ${webview.cspSource} data: https:;
    style-src ${webview.cspSource} 'unsafe-inline';
    font-src ${webview.cspSource};
    script-src 'nonce-${nonce}';">
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

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

