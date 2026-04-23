// ─── Extension entry point ───
// Registers all commands, tree views, and wires the runner to the UI.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Plan, RunnerState, EngineId, HistoryEntry, TaskStatus, TaskType, FailurePolicy, Task } from './models/types';
import { loadPlan, savePlan, dehydratePlan, hydratePlan, createEmptyPlan, createPlaylist, createTask } from './models/plan';
import { registerAllEngines, checkEngineAvailability, getEngine } from './adapters/index';
import { commandExists } from './utils/command-exists';
import { TaskRunner } from './runner/runner';
import { HistoryStore } from './history/store';
import { TemplateStore } from './templates/store';
import { generateId } from './models/plan';
import { PlanTreeProvider, PlanTreeItem } from './ui/plan-tree';
import { HistoryTreeProvider } from './ui/history-tree';
import { DashboardPanel } from './ui/dashboard-panel';
import { ExecutionDetailPanel } from './ui/execution-detail-panel';
import { TaskEditorPanel } from './ui/task-editor-panel';
import {
  PromptEngineOption,
  PromptInputViewProvider,
  PromptSidebarListItem,
  PromptSidebarChatMessage,
  PromptSidebarPlanGroup,
} from './ui/prompt-input-view';
import { detectAndConfigureEngines, detectEngines, redetectEngines } from './engine-detection';
import { analyzeProject, formatAnalysis } from './context/project-analyzer';
import { RunSessionStore, RunSession } from './models/run-session';
import * as UserMsg from './utils/user-messages';
import { SessionsTreeProvider, SessionsTreeItem } from './ui/sessions-tree';
import { BUILT_IN_PLAN_TEMPLATES, PlanTemplate } from './templates/built-in-plans';
import { PROFILE_META, ProfileName } from './models/execution-profiles';
import { PromptLibraryStore } from './templates/prompt-library';
import { SandboxManager } from './sandbox/sandbox-manager';
import { captureScreenshot } from './sandbox/screenshot';

// ─── Shared state ───

let currentPlan: Plan | null = null;
let currentPlanPath: string | null = null;
let planDirty = false;
let runner: TaskRunner;
let historyStore: HistoryStore;
let planTree: PlanTreeProvider;
let planView: vscode.TreeView<PlanTreeItem> | undefined;
let historyTree: HistoryTreeProvider;
let templateStore: TemplateStore;
let promptLibraryStore: PromptLibraryStore;
let runSessionStore: RunSessionStore;
let sessionsTree: SessionsTreeProvider;
let planFileWatcher: vscode.FileSystemWatcher | null = null;
let temporaryPlanState: { plan: Plan | null; planPath: string | null; planDirty: boolean } | null = null;
let engineStatusBarItem: vscode.StatusBarItem | null = null;
let extensionContext: vscode.ExtensionContext | null = null;
let detectedPromptEngines: EngineId[] = [];
let promptViewProvider: PromptInputViewProvider | null = null;
let currentSidebarThreadId: string | null = null;
let pendingSidebarTurn: { prompt: string; engine: EngineId; startedAt: string; threadId: string; turnIndex: number } | null = null;
let promptSidebarSyncTimer: ReturnType<typeof setTimeout> | null = null;
let dashboardUpdateTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Sandbox state ───
let sandboxManager: SandboxManager | null = null;
/** Screenshot paths captured via the sandbox panel, cleared after injected into a task's context */
let pendingScreenshotPaths: string[] = [];

// ─── Watch mode state ───
let watchModeActive = false;
let watchWatcher: vscode.FileSystemWatcher | null = null;
let watchStatusBarItem: vscode.StatusBarItem | null = null;
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Execution progress tracking ───
let executionTaskCount = 0;
let executionTasksCompleted = 0;
let executionTasksFailed = 0;
let executionStartTime = 0;

// ─── Execution progress notification ───
let progressResolve: (() => void) | null = null;
let progressReport: vscode.Progress<{ message?: string; increment?: number }> | null = null;

const NO_ENGINES_PROMPT_KEY = 'agentTaskPlayer.noEnginesPromptShown';
const RECENT_PLANS_KEY = 'moag.recentPlans';
const CLAUDE_INSTALL_URL = 'https://www.npmjs.com/package/@anthropic-ai/claude-code';
const CODEX_INSTALL_URL = 'https://www.npmjs.com/package/@openai/codex';

interface TaskLocation {
  playlistIndex: number;
  taskIndex: number;
}

interface RecentPlan {
  name: string;
  path: string;
  openedAt: number;
}

function startProgressNotification(): void {
  if (progressResolve) { return; } // already running
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'MOAG' },
    (progress) => {
      progressReport = progress;
      return new Promise<void>((resolve) => {
        progressResolve = resolve;
      });
    },
  );
}

function updateProgressNotification(message: string): void {
  progressReport?.report({ message });
}

function endProgressNotification(): void {
  if (progressResolve) {
    progressResolve();
    progressResolve = null;
    progressReport = null;
  }
}

function getEngineDisplayName(id: EngineId): string {
  try {
    return getEngine(id).displayName;
  } catch {
    return id;
  }
}

function updateEngineStatusBarVisibility(): void {
  if (!engineStatusBarItem) {
    return;
  }
  engineStatusBarItem.show();
}

function updateEngineStatusBar(available: EngineId[]): void {
  if (!engineStatusBarItem) {
    return;
  }

  const names = available.map(getEngineDisplayName);
  engineStatusBarItem.text = available.length > 0
    ? `$(check) ${available.length} engine${available.length === 1 ? '' : 's'}`
    : '$(warning) No engines';
  engineStatusBarItem.tooltip = available.length > 0
    ? `Detected engines:\n${names.join('\n')}`
    : 'No supported AI engines detected.\nClick to rescan.';
  updateEngineStatusBarVisibility();
}

function getPromptEngineOptions(available: EngineId[]): PromptEngineOption[] {
  return available.map((id) => ({
    id,
    label: getEngineDisplayName(id),
  }));
}

function getPreferredPromptEngine(available: EngineId[]): EngineId | undefined {
  const configuredEngine = vscode.workspace.getConfiguration('agentTaskPlayer')
    .get<EngineId>('defaultEngine', 'claude' as EngineId);

  if (available.includes(configuredEngine)) {
    return configuredEngine;
  }

  return available[0];
}

function syncPromptProviderEngines(
  promptProvider: PromptInputViewProvider,
  available: EngineId[],
): void {
  detectedPromptEngines = [...available];
  promptProvider.setEngines(
    getPromptEngineOptions(available),
    getPreferredPromptEngine(available),
  );
  scheduleDashboardUpdate();
}

function formatSessionAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) { return `${hrs}h ago`; }
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function getPromptSidebarSessions(): PromptSidebarListItem[] {
  const threadHeads = historyStore.getThreadHeads().slice(0, 30);
  if (threadHeads.length > 0) {
    return threadHeads.map((entry) => ({
      id: entry.threadId ?? entry.id,
      kind: 'thread',
      title: entry.taskName,
      subtitle: `${getEngineDisplayName(entry.engine)}  -  ${formatSessionAge(entry.startedAt)}`,
    }));
  }

  return runSessionStore.getAll().slice(0, 30).map((session) => ({
    id: session.id,
    kind: 'run',
    title: session.planName,
    subtitle: `${session.status}  -  ${formatSessionAge(session.startedAt)}`,
  }));
}

function getPromptSidebarPlanItems(): PromptSidebarListItem[] {
  const plan = getActivePlan();
  if (!plan) {
    return [];
  }

  return plan.playlists
    .flatMap((playlist) => (playlist.tasks || []).map((task) => ({
      id: task.id,
      kind: 'plan' as const,
      title: task.name,
      subtitle: `${playlist.name}  -  ${task.status ?? 'pending'}`,
    })))
    .slice(0, 80);
}

function getPromptSidebarHistoryItems(): PromptSidebarListItem[] {
  return historyStore.getAll().slice(0, 80).map((entry) => {
    const planName = entry.runId ? (runSessionStore.get(entry.runId)?.planName ?? 'Ad hoc') : 'Ad hoc';
    const playlistName = entry.playlistName || 'Unassigned';
    return {
      id: entry.threadId ?? entry.id,
      kind: 'history',
      title: entry.taskName,
      subtitle: `${planName} / ${playlistName}  -  ${getEngineDisplayName(entry.engine)}  -  ${formatSessionAge(entry.startedAt)}`,
      status: entry.status,
      planName,
      playlistName,
    };
  });
}

function getPromptSidebarPlanGroups(): PromptSidebarPlanGroup[] {
  const plan = getActivePlan();
  if (!plan) {
    return [];
  }

  const getTaskFailureReason = (task: Task): string | undefined => {
    if (task.status !== TaskStatus.Failed && task.status !== TaskStatus.Blocked) {
      return undefined;
    }
    const entries = historyStore.getForTask(task.id);
    const latest = entries[0];
    if (!latest) {
      return undefined;
    }
    const merged = [latest.result.stderr, latest.result.stdout].filter(Boolean).join('\n');
    const lines = merged.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    // Skip known Claude Code / Codex startup noise that isn't the real error
    const noisePatterns = [
      /^reading prompt from stdin/i,
      /^─+\s*(command|response)\s*─+/i,
      /^github copilot/i,
      /^claude code/i,
    ];
    const errorLine = lines.find(line => !noisePatterns.some(p => p.test(line)));
    return errorLine ? errorLine.substring(0, 160) : undefined;
  };

  return plan.playlists.map((playlist, index) => {
    const tasks = playlist.tasks || [];
    const total = tasks.length;
    const done = tasks.filter((task) =>
      task.status === TaskStatus.Completed
      || task.status === TaskStatus.Failed
      || task.status === TaskStatus.Blocked
      || task.status === TaskStatus.Skipped).length;
    const running = tasks.some((task) => task.status === TaskStatus.Running);
    const failed = tasks.some((task) => task.status === TaskStatus.Failed || task.status === TaskStatus.Blocked);
    const status = running
      ? 'running'
      : failed
        ? 'failed'
        : total > 0 && done === total
          ? 'completed'
          : 'pending';

    return {
      id: playlist.id ?? `playlist-${index}`,
      name: playlist.name || `Playlist ${index + 1}`,
      playlistStatus: status,
      progress: { done, total },
      tasks: tasks.map((task) => {
        const latestEntry = historyStore.getForTask(task.id)[0];
        return {
          id: task.id,
          name: task.name,
          status: task.status ?? 'pending',
          failureReason: getTaskFailureReason(task),
          tokenUsage: latestEntry?.result.tokenUsage
            ? { totalTokens: latestEntry.result.tokenUsage.totalTokens, estimatedCost: latestEntry.result.tokenUsage.estimatedCost }
            : undefined,
        };
      }),
    };
  });
}

function syncPromptProviderSidebar(promptProvider: PromptInputViewProvider): void {
  const chatState = getPromptSidebarChatState();
  const context = getPromptSidebarActiveContext();
  promptProvider.setSidebarState(
    getPromptSidebarSessions(),
    getPromptSidebarPlanItems(),
    getPromptSidebarHistoryItems(),
    chatState.title,
    chatState.messages,
    chatState.threadId,
    runner.state,
    getPromptSidebarPlanGroups(),
    context.planName,
    context.playlistName,
  );
}

function schedulePromptProviderSidebarSync(delayMs = 120): void {
  if (!promptViewProvider) {
    return;
  }
  if (promptSidebarSyncTimer) {
    clearTimeout(promptSidebarSyncTimer);
  }
  promptSidebarSyncTimer = setTimeout(() => {
    promptSidebarSyncTimer = null;
    if (promptViewProvider) {
      syncPromptProviderSidebar(promptViewProvider);
    }
  }, delayMs);
}

function scheduleDashboardUpdate(delayMs = 120): void {
  if (dashboardUpdateTimer) {
    clearTimeout(dashboardUpdateTimer);
  }
  dashboardUpdateTimer = setTimeout(() => {
    dashboardUpdateTimer = null;
    DashboardPanel.currentPanel?.update();
  }, delayMs);
}

function getPromptSidebarActiveContext(): { planName: string; playlistName: string } {
  const plan = getActivePlan();
  if (!plan) {
    return { planName: 'Ad hoc', playlistName: 'Quick Prompt' };
  }

  const runningPlaylist = plan.playlists.find((playlist) => (playlist.tasks || [])
    .some((task) => task.status === TaskStatus.Running));
  if (runningPlaylist) {
    return {
      planName: plan.name || 'Untitled Plan',
      playlistName: runningPlaylist.name || 'Playlist',
    };
  }

  const nextPlaylist = plan.playlists.find((playlist) => (playlist.tasks || [])
    .some((task) => task.status !== TaskStatus.Completed));
  if (nextPlaylist) {
    return {
      planName: plan.name || 'Untitled Plan',
      playlistName: nextPlaylist.name || 'Playlist',
    };
  }

  return {
    planName: plan.name || 'Untitled Plan',
    playlistName: plan.playlists[0]?.name || 'Playlist',
  };
}

function getAssistantText(entry: HistoryEntry): string {
  const getOutputPreview = (text: string | undefined): string => {
    const raw = (text || '').trim();
    if (!raw) {
      return '';
    }
    const lines = raw.split(/\r?\n/).map((line) => line.trimEnd());
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    if (nonEmpty.length === 0) {
      return '';
    }
    const preview = nonEmpty.slice(-24).join('\n').trim();
    return preview.length > 2200 ? `${preview.slice(0, 2200)}...` : preview;
  };

  const summary = entry.result.summary?.trim();
  const genericSummary = summary
    ? /^(agent|command|check|service)\s+task\s+(passed|failed)|^command completed successfully\.?$|^task finished\.?$/i.test(summary)
    : false;
  if (summary && !genericSummary) {
    return summary;
  }

  const changedCount = (entry.changedFiles ?? []).length;
  if (entry.status === TaskStatus.Completed) {
    if (changedCount > 0) {
      return changedCount === 1
        ? 'Done. Updated 1 file successfully.'
        : `Done. Updated ${changedCount} files successfully.`;
    }
    const answerLikeOutput = getOutputPreview(entry.result.stdout);
    if (answerLikeOutput) {
      return answerLikeOutput;
    }
    return 'Done. No file changes were needed.';
  }

  const stdout = getOutputPreview(entry.result.stdout);
  if (stdout) {
    return stdout;
  }

  const stderr = getOutputPreview(entry.result.stderr);
  if (stderr) {
    return stderr;
  }

  return 'Run failed. Open Dashboard for details.';
}

function getUserChatText(rawPrompt: string, fallbackTaskName?: string): string {
  const prompt = (rawPrompt || '').trim();
  if (!prompt) {
    return '';
  }

  // The runner injects context/rules/snippets before the actual task prompt.
  // Keep only the user-authored segment.
  if (/\[CONTEXT START\]/i.test(prompt) || /\[EXECUTION RULES\]/i.test(prompt) || /\[PROMPT SNIPPETS\]/i.test(prompt)) {
    let body = prompt;

    const sectionEnds = [
      body.lastIndexOf('[CONTEXT END]'),
      body.lastIndexOf('[/EXECUTION RULES]'),
      body.lastIndexOf('[/PROMPT SNIPPETS]'),
    ].filter((idx) => idx >= 0);

    if (sectionEnds.length > 0) {
      const lastEnd = Math.max(...sectionEnds);
      const nextBreak = body.indexOf('\n', lastEnd);
      body = nextBreak >= 0 ? body.slice(nextBreak + 1).trim() : body.slice(lastEnd + 1).trim();
    }

    body = body
      .split(/\n\nExecution contract:\n/i)[0]
      .split(/\n\nContext files:\n/i)[0]
      .trim();

    if (body) {
      return body.length > 1200 ? `${body.slice(0, 1200)}...` : body;
    }
  }

  if (fallbackTaskName && fallbackTaskName.trim()) {
    return fallbackTaskName.trim();
  }

  return prompt.length > 1200 ? `${prompt.slice(0, 1200)}...` : prompt;
}

function getPromptSidebarChatState(): { title: string; messages: PromptSidebarChatMessage[]; threadId: string } {
  const heads = historyStore.getThreadHeads();

  if (pendingSidebarTurn) {
    const pending = pendingSidebarTurn;
    const pendingThread = historyStore.getThread(pending.threadId);
    const hasNewResult = pendingThread.some((entry) => (entry.turnIndex ?? 0) >= pending.turnIndex);
    if (!hasNewResult) {
      const pendingPrompt = getUserChatText(pending.prompt, getPromptTaskName(pending.prompt));
      const messages: PromptSidebarChatMessage[] = [];
      const title = pendingThread[0]?.taskName || getPromptTaskName(pending.prompt);

      // Keep prior turns visible so chat remains a continuous conversation.
      for (const entry of pendingThread) {
        const prompt = getUserChatText(entry.prompt ?? '', entry.taskName);
        if (prompt) {
          messages.push({
            id: `${entry.id}-user`,
            role: 'user',
            author: 'You',
            text: prompt,
          });
        }
        messages.push({
          id: `${entry.id}-assistant`,
          role: 'assistant',
          author: getEngineDisplayName(entry.engine),
          text: getAssistantText(entry),
          status: (entry.status as PromptSidebarChatMessage['status']) ?? undefined,
          changedFilesCount: (entry.changedFiles ?? []).length,
          durationMs: entry.result.durationMs,
          verificationPassed: entry.verification?.passed,
          exitCode: entry.result.exitCode,
          tokenUsage: entry.result.tokenUsage,
        });
      }

      if (pendingThread.length === 0 && pendingPrompt) {
        messages.push({
          id: `pending-user-${pending.turnIndex}`,
          role: 'user',
          author: 'You',
          text: pendingPrompt,
        });
        messages.push({
          id: `pending-assistant-${pending.turnIndex}`,
          role: 'assistant',
          author: getEngineDisplayName(pending.engine),
          text: 'Running this request...',
          status: 'running',
        });
      }

      return {
        title,
        threadId: pending.threadId,
        messages,
      };
    }

    const resolvedThreadId = pending.threadId;
    pendingSidebarTurn = null;
    currentSidebarThreadId = resolvedThreadId;
  }

  if (heads.length === 0) {
    currentSidebarThreadId = null;
    return { title: 'New Chat', messages: [], threadId: '' };
  }

  if (!currentSidebarThreadId || !heads.some((head) => (head.threadId ?? head.id) === currentSidebarThreadId)) {
    currentSidebarThreadId = heads[0].threadId ?? heads[0].id;
  }

  const thread = currentSidebarThreadId ? historyStore.getThread(currentSidebarThreadId) : [];
  if (thread.length === 0) {
    return { title: 'New Chat', messages: [], threadId: '' };
  }

  const title = thread[0].taskName || 'Chat';
  const messages: PromptSidebarChatMessage[] = [];
  for (const entry of thread) {
    const prompt = getUserChatText(entry.prompt ?? '', entry.taskName);
    if (prompt) {
      messages.push({
        id: `${entry.id}-user`,
        role: 'user',
        author: 'You',
        text: prompt,
      });
    }
    messages.push({
      id: `${entry.id}-assistant`,
      role: 'assistant',
      author: getEngineDisplayName(entry.engine),
      text: getAssistantText(entry),
      status: (entry.status as PromptSidebarChatMessage['status']) ?? undefined,
      changedFilesCount: (entry.changedFiles ?? []).length,
      durationMs: entry.result.durationMs,
      verificationPassed: entry.verification?.passed,
      exitCode: entry.result.exitCode,
    });
  }

  return { title, messages, threadId: currentSidebarThreadId ?? '' };
}

async function promptToInstallEngineOnce(
  context: vscode.ExtensionContext,
  available: EngineId[],
): Promise<void> {
  if (available.length > 0) {
    return;
  }

  const alreadyShown = context.globalState.get<boolean>(NO_ENGINES_PROMPT_KEY, false);
  if (alreadyShown) {
    return;
  }

  await context.globalState.update(NO_ENGINES_PROMPT_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    'MOAG: No AI engines found. Install one to get started.',
    'Install Claude',
    'Install Codex',
  );

  if (choice === 'Install Claude') {
    void vscode.env.openExternal(vscode.Uri.parse(CLAUDE_INSTALL_URL));
  } else if (choice === 'Install Codex') {
    void vscode.env.openExternal(vscode.Uri.parse(CODEX_INSTALL_URL));
  }
}

function isDashboardVisible(): boolean {
  return Boolean(
    (DashboardPanel.currentPanel as unknown as { _panel?: { visible?: boolean } } | undefined)?._panel?.visible,
  );
}

function shouldShowTaskNotifications(): boolean {
  return vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('showTaskNotifications', true)
    && !isDashboardVisible();
}

function isTaskLocation(value: unknown): value is TaskLocation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as TaskLocation;
  return typeof candidate.playlistIndex === 'number' && typeof candidate.taskIndex === 'number';
}

function isEngineId(value: string | undefined): value is EngineId {
  return value === 'claude'
    || value === 'codex'
    || value === 'gemini'
    || value === 'ollama'
    || value === 'custom';
}

function findTaskLocation(taskId: string): TaskLocation | null {
  const plan = getActivePlan();
  if (!plan) {
    return null;
  }

  for (let playlistIndex = 0; playlistIndex < plan.playlists.length; playlistIndex++) {
    const taskIndex = plan.playlists[playlistIndex].tasks.findIndex(task => task.id === taskId);
    if (taskIndex >= 0) {
      return { playlistIndex, taskIndex };
    }
  }

  return null;
}

function notifyTaskCompleted(task: Task): void {
  if (task.status !== TaskStatus.Completed || !shouldShowTaskNotifications()) {
    return;
  }

  void vscode.window.showInformationMessage(
    `Task "${task.name}" completed`,
    'View Dashboard',
    'View Changes',
  ).then(action => {
    if (action === 'View Dashboard') {
      void vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
    } else if (action === 'View Changes') {
      void vscode.commands.executeCommand('agentTaskPlayer.exportResults');
    }
  });
}

function notifyTaskFailed(task: Task): void {
  if (!shouldShowTaskNotifications()) {
    return;
  }

  void vscode.window.showWarningMessage(
    `Task "${task.name}" failed`,
    'View Dashboard',
    'Retry',
  ).then(action => {
    if (action === 'View Dashboard') {
      void vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      return;
    }

    if (action === 'Retry') {
      const location = findTaskLocation(task.id);
      if (location) {
        void vscode.commands.executeCommand('agentTaskPlayer.retryTask', location);
      }
    }
  });
}

// ─── Pause state persistence ───
const PAUSE_STATE_KEY = 'agentTaskPlayer.pauseState';

interface PersistentPauseState {
  /** Task statuses keyed by task ID */
  taskStatuses: Record<string, string>;
  /** Path to the plan file that was running */
  planPath: string | null;
  /** Signature of task statuses at the moment pause state was captured */
  planStatusSignature?: string;
}

function normalizePersistedTaskStatus(status: TaskStatus): TaskStatus {
  return status === TaskStatus.Running ? TaskStatus.Pending : status;
}

function isRestorableTaskStatus(status: string | undefined): status is TaskStatus {
  return status === TaskStatus.Completed
    || status === TaskStatus.Failed
    || status === TaskStatus.Blocked
    || status === TaskStatus.Skipped;
}

function buildPlanStatusSignature(plan: Plan): string {
  const parts: string[] = [];
  for (const pl of plan.playlists) {
    for (const t of pl.tasks) {
      parts.push(`${t.id}:${String(t.status || TaskStatus.Pending).toLowerCase()}`);
    }
  }
  parts.sort();
  return parts.join('|');
}

/** Save current task statuses to workspace state (called on pause/stop) */
function savePauseState(ctx: vscode.ExtensionContext): void {
  if (!currentPlan || !currentPlanPath) { return; }
  const taskStatuses: Record<string, string> = {};
  for (const pl of currentPlan.playlists) {
    for (const t of pl.tasks) {
      taskStatuses[t.id] = normalizePersistedTaskStatus(t.status);
    }
  }
  const state: PersistentPauseState = {
    taskStatuses,
    planPath: currentPlanPath,
    planStatusSignature: buildPlanStatusSignature(currentPlan),
  };
  ctx.workspaceState.update(PAUSE_STATE_KEY, state);
}

/** Restore task statuses from workspace state (called on activation) */
function restorePauseState(ctx: vscode.ExtensionContext): void {
  const state = ctx.workspaceState.get<PersistentPauseState>(PAUSE_STATE_KEY);
  if (!state || !currentPlan || !currentPlanPath || state.planPath !== currentPlanPath) { return; }
  if (state.planStatusSignature && state.planStatusSignature !== buildPlanStatusSignature(currentPlan)) {
    return;
  }

  let restored = false;
  for (const pl of currentPlan.playlists) {
    for (const t of pl.tasks) {
      const savedStatus = state.taskStatuses[t.id];
      if (isRestorableTaskStatus(savedStatus)) {
        t.status = savedStatus;
        restored = true;
      }
    }
  }
  if (restored) {
    planTree.setPlan(currentPlan);
    scheduleDashboardUpdate();
  }
}

/** Clear saved pause state */
function clearPauseState(ctx: vscode.ExtensionContext): void {
  ctx.workspaceState.update(PAUSE_STATE_KEY, undefined);
}

function addRecentPlan(name: string, planPath: string): void {
  if (!extensionContext) {
    return;
  }

  const resolvedPath = path.resolve(planPath);
  const normalizedPath = normalizeFilePath(resolvedPath);
  const recent = extensionContext.workspaceState.get<RecentPlan[]>(RECENT_PLANS_KEY, []);
  const filtered = recent.filter(entry => normalizeFilePath(entry.path) !== normalizedPath);

  filtered.unshift({
    name,
    path: resolvedPath,
    openedAt: Date.now(),
  });

  void extensionContext.workspaceState.update(RECENT_PLANS_KEY, filtered.slice(0, 5));
}

function getRecentPlans(): RecentPlan[] {
  return extensionContext?.workspaceState.get<RecentPlan[]>(RECENT_PLANS_KEY, []) ?? [];
}

/**
 * Keep the module-level plan reference aligned with the tree view state.
 * The sidebar can already hold a loaded plan when `currentPlan` is stale/null,
 * which would otherwise make the dashboard think nothing is loaded.
 */
function getActivePlan(): Plan | null {
  if (currentPlan) {
    return currentPlan;
  }

  const treePlan = planTree?.plan ?? null;
  if (treePlan) {
    currentPlan = treePlan;
  }
  return treePlan;
}

function setVisiblePlan(
  plan: Plan | null,
  planPath: string | null,
  refreshDashboard = true,
): void {
  currentPlan = plan;
  currentPlanPath = planPath;
  planDirty = false;
  if (plan && planPath) {
    addRecentPlan(plan.name, planPath);
  }
  planTree.setPlan(plan);
  if (planView) {
    planView.message = undefined;
  }
  if (promptViewProvider) {
    schedulePromptProviderSidebarSync();
  }
  if (refreshDashboard) {
    scheduleDashboardUpdate();
  }
}

function activateTemporaryPlan(plan: Plan): void {
  temporaryPlanState = { plan: getActivePlan(), planPath: currentPlanPath, planDirty };
  setVisiblePlan(plan, null);
}

function restoreTemporaryPlan(refreshDashboard = true): void {
  if (!temporaryPlanState) {
    return;
  }

  const { plan, planPath, planDirty: previousPlanDirty } = temporaryPlanState;
  temporaryPlanState = null;
  setVisiblePlan(plan, planPath, refreshDashboard);
  planDirty = previousPlanDirty;
}

function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getSuggestedPlanFileName(planName: string): string {
  const slug = planName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
  return `${slug || 'my-plan'}.json`;
}

function isDefaultPlanPath(planPath: string | null): boolean {
  const defaultPath = getMoagPlanPath();
  return Boolean(planPath && defaultPath && normalizeFilePath(planPath) === normalizeFilePath(defaultPath));
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  // Register all engine adapters
  registerAllEngines();

  // Initialize history store from workspace state
  historyStore = new HistoryStore(context.workspaceState);

  // Initialize run session store
  runSessionStore = new RunSessionStore(context.workspaceState);

  // Initialize template store
  templateStore = new TemplateStore(context.globalState);

  // Initialize prompt library store
  promptLibraryStore = new PromptLibraryStore(context.globalState);

  // Initialize task runner
  runner = new TaskRunner(historyStore);
  runner.setPromptLibrary(promptLibraryStore);

  // Initialize tree providers
  planTree = new PlanTreeProvider();
  historyTree = new HistoryTreeProvider(historyStore);

  // Keep the sessions provider alive for commands/detail panels, but don't
  // create a separate sidebar view now that sessions live behind History.
  sessionsTree = new SessionsTreeProvider(historyStore, runSessionStore);

  // Register prompt input webview in sidebar
  const promptProvider = new PromptInputViewProvider(
    context.extensionUri,
    async ({ prompt, engineId, imageData, activeFilePath }) => {
      let finalPrompt = prompt;
      if (imageData) {
        const match = imageData.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (match) {
          const ext = match[1].split('/')[1].split('+')[0];
          const tmpFile = path.join(os.tmpdir(), `moag-img-${Date.now()}.${ext}`);
          fs.writeFileSync(tmpFile, Buffer.from(match[2], 'base64'));
          finalPrompt = `${prompt}\n\n[Attached image: ${tmpFile}]`;
        }
      }
      if (activeFilePath) {
        try {
          const content = fs.readFileSync(activeFilePath, 'utf-8');
          const MAX_FILE_CHARS = 20_000;
          const truncated = content.length > MAX_FILE_CHARS
            ? content.slice(0, MAX_FILE_CHARS) + '\n...[file truncated]'
            : content;
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const relPath = root ? path.relative(root, activeFilePath) : path.basename(activeFilePath);
          finalPrompt = `[Active file: ${relPath}]\n\`\`\`\n${truncated}\n\`\`\`\n\n${finalPrompt}`;
        } catch { /* unreadable — proceed without it */ }
      }
      return runPromptSubmission(finalPrompt, isEngineId(engineId) ? engineId : undefined);
    },
    (id, kind) => {
      if (kind === 'thread' || kind === 'history') {
        const head = historyStore.getThreadHeads().find((entry) => (entry.threadId ?? entry.id) === id);
        if (head) {
          currentSidebarThreadId = head.threadId ?? head.id;
          schedulePromptProviderSidebarSync();
          cmdOpenThread(head);
          return;
        }
      } else if (kind === 'run') {
        const session = runSessionStore.get(id);
        if (session) {
          const runEntries = historyStore.getForRun(session.id);
          if (runEntries.length > 0) {
            currentSidebarThreadId = runEntries[0].threadId ?? runEntries[0].id;
            schedulePromptProviderSidebarSync();
          }
          cmdOpenSession(session);
          return;
        }
      } else if (kind === 'plan') {
        const location = findTaskLocation(id);
        if (location) {
          cmdEditTask(location);
          return;
        }
      }
      cmdShowHistory();
    },
    async (prompt: string) => {
      await generatePlanFromDashboardPrompt(prompt);
    },
  );
  promptViewProvider = promptProvider;
  syncPromptProviderEngines(
    promptProvider,
    context.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []),
  );

  // Push the active editor file to the sidebar whenever it changes
  const pushActiveFile = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
      promptProvider.postActiveFile({ name: path.basename(editor.document.fileName), path: editor.document.fileName });
    } else {
      promptProvider.postActiveFile(null);
    }
  };
  pushActiveFile();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(pushActiveFile));

  schedulePromptProviderSidebarSync(0);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PromptInputViewProvider.viewType, promptProvider),
  );
  context.subscriptions.push(
    historyStore.onDidChange(() => schedulePromptProviderSidebarSync()),
    runSessionStore.onDidChange(() => schedulePromptProviderSidebarSync()),
  );

  // Save plan when tree items are reordered via drag-and-drop
  planTree.onDidReorder(() => saveAndRefresh());

  // ─── Sandbox manager ───
  sandboxManager = new SandboxManager();

  sandboxManager.on('state-changed', (state) => {
    DashboardPanel.currentPanel?.postSandboxState(state);
    promptViewProvider?.postSandboxState(state);
  });

  sandboxManager.on('output', (text: string) => {
    DashboardPanel.currentPanel?.appendSandboxOutput(text);
  });

  // ─── Wire runner events to UI ───

  runner.on('state-changed', (state) => {
    planTree.setRunnerState(state);
    scheduleDashboardUpdate();
    if (promptViewProvider) {
      schedulePromptProviderSidebarSync();
    }
    updateStatusBar(state);
    // Persist task progress when pausing or stopping
    if (state === RunnerState.Paused || state === RunnerState.Stopping) {
      savePauseState(context);
    }
    // Clear saved state when going idle after a full run (all-completed will fire too)
    if (state === RunnerState.Idle) {
      savePauseState(context);
    }
    // Reset session cost display when a new run starts
    if (state === RunnerState.Playing) {
      promptViewProvider?.postSessionCost(0);
    }
  });

  runner.on('task-started', (task, playlist, fullPrompt) => {
    executionTasksCompleted++; // tracks current task number (1-based)
    planTree.refresh();
    if (promptViewProvider) {
      schedulePromptProviderSidebarSync();
    }

    // Create run session on first task
    if (executionTasksCompleted === 1 && runner.currentRunId) {
      const plan = getActivePlan();
      const engines = new Set<EngineId>();
      plan?.playlists.forEach(pl => pl.tasks.forEach(t => engines.add(t.engine || pl.engine || plan.defaultEngine)));
      runSessionStore.create({
        id: runner.currentRunId,
        planName: plan?.name || 'Untitled',
        planPath: currentPlanPath || undefined,
        startedAt: new Date().toISOString(),
        engines: [...engines],
        taskCount: executionTaskCount,
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCost: 0,
        status: 'running',
      });
    }

    scheduleDashboardUpdate();
    DashboardPanel.currentPanel?.startTaskCard(task, playlist, fullPrompt);
    promptViewProvider?.postLiveOutputStart(task.id, task.name);

    // Show real progress in status bar and notification
    const shortName = task.name.length > 40 ? task.name.substring(0, 37) + '...' : task.name;
    statusBarItem.text = `$(sync~spin) ATP: Task ${executionTasksCompleted}/${executionTaskCount} — ${shortName}`;
    startProgressNotification();
    updateProgressNotification(`Task ${executionTasksCompleted}/${executionTaskCount}: ${shortName}`);
  });

  runner.on('task-output', (task, chunk, stream) => {
    DashboardPanel.currentPanel?.appendOutput(chunk, stream, task.id);
    promptViewProvider?.postLiveOutputChunk(task.id, chunk);
  });

  runner.on('engine-fallback', ({ taskId, fromEngine, toEngine }) => {
    vscode.window.showInformationMessage(`Rate limit hit on ${fromEngine}. Retrying with ${toEngine}.`);
    DashboardPanel.currentPanel?.postEngineFallback(fromEngine, toEngine);
  });

  runner.on('budget-exceeded', ({ totalCost, budget }) => {
    if (runner.state === RunnerState.Playing) {
      runner.pause();
    }

    const message = `Estimated run cost $${totalCost.toFixed(4)} exceeded the configured budget of $${budget.toFixed(4)}.`;
    void vscode.window.showWarningMessage(message, 'Continue', 'Stop').then((action) => {
      if (action === 'Stop') {
        runner.stop();
        return;
      }

      if (runner.state !== RunnerState.Paused) {
        return;
      }

      const activePlan = getActivePlan();
      if (!activePlan) {
        return;
      }

      runner.play(activePlan).catch(err => {
        UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
      });
    });
  });

  runner.on('task-completed', (task, _result) => {
    planTree.refresh();
    saveAndRefresh();
    const entries = historyStore.getForTask(task.id);
    const entry = entries[0];
    DashboardPanel.currentPanel?.completeTaskCard(
      task, entry?.result ?? _result, entry?.changedFiles, entry?.codeChanges, entry?.verification, entry?.artifacts,
      entry?.autoFixed, entry?.validationTargetResults,
    );
    scheduleDashboardUpdate();
    // Update run session stats
    if (runner.currentRunId) {
      const session = runSessionStore.get(runner.currentRunId);
      if (session) {
        const usage = entry?.result?.tokenUsage;
        runSessionStore.update(runner.currentRunId, {
          tasksCompleted: session.tasksCompleted + 1,
          totalTokensIn: session.totalTokensIn + (usage?.inputTokens || 0),
          totalTokensOut: session.totalTokensOut + (usage?.outputTokens || 0),
          totalCost: session.totalCost + (usage?.estimatedCost || 0),
        });
      }
    }
    notifyTaskCompleted(task);
    const { tokensIn, tokensOut } = runner.getSessionTokens();
    promptViewProvider?.postSessionCost(runner.getSessionCost(), tokensIn, tokensOut);
    promptViewProvider?.postLiveOutputEnd(task.id, task.status);
  });

  runner.on('task-failed', (task, result) => {
    executionTasksFailed++;
    planTree.refresh();
    saveAndRefresh();
    const entries = historyStore.getForTask(task.id);
    const entry = entries[0];
    DashboardPanel.currentPanel?.completeTaskCard(
      task, entry?.result ?? result, entry?.changedFiles, entry?.codeChanges, entry?.verification, entry?.artifacts,
      entry?.autoFixed, entry?.validationTargetResults,
    );
    scheduleDashboardUpdate();
    // Update run session stats
    if (runner.currentRunId) {
      const session = runSessionStore.get(runner.currentRunId);
      if (session) {
        const usage = entry?.result?.tokenUsage;
        runSessionStore.update(runner.currentRunId, {
          tasksCompleted: session.tasksCompleted + 1,
          tasksFailed: session.tasksFailed + 1,
          totalTokensIn: session.totalTokensIn + (usage?.inputTokens || 0),
          totalTokensOut: session.totalTokensOut + (usage?.outputTokens || 0),
          totalCost: session.totalCost + (usage?.estimatedCost || 0),
        });
      }
    }
    const shortErr = result.stderr.split('\n').filter(l => l.trim()).slice(0, 1).join('').substring(0, 80);
    vscode.window.setStatusBarMessage(`$(warning) Task "${task.name}" failed: ${shortErr || 'exit ' + result.exitCode}`, 5000);
    notifyTaskFailed(task);
    promptViewProvider?.postLiveOutputEnd(task.id, task.status);
  });

  runner.on('playlist-completed', (_playlist) => {
    // Silent — don't interrupt between playlists in autopilot mode
  });

  runner.on('all-completed', () => {
    endProgressNotification();
    if (!temporaryPlanState) {
      clearPauseState(context);
    }
    // Finalize run session
    if (runner.currentRunId) {
      const session = runSessionStore.get(runner.currentRunId);
      if (session) {
        runSessionStore.update(runner.currentRunId, {
          finishedAt: new Date().toISOString(),
          status: session.tasksFailed > 0 ? 'failed' : 'completed',
        });
      }
    }
    const totalDuration = Date.now() - executionStartTime;
    const passed = executionTaskCount - executionTasksFailed;
    const summary = `Plan complete: ${passed}/${executionTaskCount} passed` +
      (executionTasksFailed > 0 ? `, ${executionTasksFailed} failed` : '') +
      ` in ${formatDuration(totalDuration)}`;

    // Collect changed files across all history for this run
    const recentEntries = historyStore.getAll().slice(0, executionTaskCount);
    const totalFiles = new Set(recentEntries.flatMap(e => e.changedFiles ?? [])).size;
    const filesSuffix = totalFiles > 0 ? ` | ${totalFiles} file${totalFiles !== 1 ? 's' : ''} changed` : '';

    statusBarItem.text = `$(check) ATP: Done`;
    vscode.window.showInformationMessage(
      `${summary}${filesSuffix}`,
      'Show Dashboard',
      'Review Changes',
      'Create PR',
    ).then(action => {
      if (action === 'Show Dashboard') {
        vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      } else if (action === 'Review Changes') {
        vscode.commands.executeCommand('agentTaskPlayer.reviewChanges');
      } else if (action === 'Create PR') {
        createPRFromRun();
      }
    });
  });

  runner.on('error', (err) => {
    endProgressNotification();
    vscode.window.showErrorMessage(
      `Runner error: ${err.message}`,
      'Show Dashboard',
    ).then(action => {
      if (action === 'Show Dashboard') {
        vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      }
    });
  });

  // ─── Status bar ───

  engineStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  engineStatusBarItem.command = 'agentTaskPlayer.detectEngines';
  context.subscriptions.push(engineStatusBarItem);
  updateEngineStatusBar(context.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []));

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  statusBarItem.command = 'agentTaskPlayer.showDashboard';
  statusBarItem.text = '$(rocket) ATP: Idle';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  function updateStatusBar(state: RunnerState): void {
    const icons: Record<RunnerState, string> = {
      [RunnerState.Idle]: '$(rocket)',
      [RunnerState.Playing]: '$(play)',
      [RunnerState.Paused]: '$(debug-pause)',
      [RunnerState.Stopping]: '$(loading~spin)',
    };
    statusBarItem.text = `${icons[state]} ATP: ${state}`;
  }

  // ─── Register commands ───

  // Register all commands — using registerCommand with individual calls
  // to avoid strict type issues with the variadic handler signatures
  context.subscriptions.push(
    vscode.commands.registerCommand('agentTaskPlayer.runPrompt', cmdRunPrompt),
    vscode.commands.registerCommand('agentTaskPlayer.play', cmdPlay),
    vscode.commands.registerCommand('agentTaskPlayer.pause', cmdPause),
    vscode.commands.registerCommand('agentTaskPlayer.stop', cmdStop),
    vscode.commands.registerCommand('agentTaskPlayer.openPlan', cmdOpenPlan),
    vscode.commands.registerCommand('agentTaskPlayer.switchPlan', cmdSwitchPlan),
    vscode.commands.registerCommand('agentTaskPlayer.savePlanAs', cmdSavePlanAs),
    vscode.commands.registerCommand('agentTaskPlayer.newPlan', cmdNewPlan),
    vscode.commands.registerCommand('agentTaskPlayer.addPlaylist', cmdAddPlaylist),
    vscode.commands.registerCommand('agentTaskPlayer.addTask', cmdAddTask),
    vscode.commands.registerCommand('agentTaskPlayer.editTask', cmdEditTask),
    vscode.commands.registerCommand('agentTaskPlayer.saveTaskEdit', cmdSaveTaskEdit),
    vscode.commands.registerCommand('agentTaskPlayer.deleteItem', cmdDeleteItem),
    vscode.commands.registerCommand('agentTaskPlayer.moveUp', cmdMoveUp),
    vscode.commands.registerCommand('agentTaskPlayer.moveDown', cmdMoveDown),
    vscode.commands.registerCommand('agentTaskPlayer.showHistory', cmdShowHistory),
    vscode.commands.registerCommand('agentTaskPlayer.showDashboard', cmdShowDashboard),
    vscode.commands.registerCommand('agentTaskPlayer.clearHistory', cmdClearHistory),
    vscode.commands.registerCommand('agentTaskPlayer.switchEngine', cmdSwitchEngine),
    vscode.commands.registerCommand('agentTaskPlayer.playPlaylist', cmdPlayPlaylist),
    vscode.commands.registerCommand('agentTaskPlayer.playTask', cmdPlayTask),
    vscode.commands.registerCommand('agentTaskPlayer.addTaskFromTemplate', cmdAddTaskFromTemplate),
    vscode.commands.registerCommand('agentTaskPlayer.saveTaskAsTemplate', cmdSaveTaskAsTemplate),
    vscode.commands.registerCommand('agentTaskPlayer.exportPlan', cmdExportPlan),
    vscode.commands.registerCommand('agentTaskPlayer.importPlan', cmdImportPlan),
    vscode.commands.registerCommand('agentTaskPlayer.showCostSummary', cmdShowCostSummary),
    vscode.commands.registerCommand('agentTaskPlayer.gettingStarted', () => {
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'moag.agent-task-player#agentTaskPlayer.getStarted',
        false,
      );
    }),
    vscode.commands.registerCommand('agentTaskPlayer.showChangelog', () => cmdShowChangelog(context)),
    vscode.commands.registerCommand('agentTaskPlayer.detectEngines', async () => {
      const result = await redetectEngines(context);
      updateEngineStatusBar(result.available);
      syncPromptProviderEngines(promptProvider, result.available);
    }),
    vscode.commands.registerCommand('agentTaskPlayer.showThreadList', cmdShowThreadList),
    vscode.commands.registerCommand('agentTaskPlayer.runPlanFile', cmdRunPlanFile),
    vscode.commands.registerCommand('agentTaskPlayer.bulkDelete', cmdBulkDelete),
    vscode.commands.registerCommand('agentTaskPlayer.clearAllTasks', cmdClearAllTasks),
    vscode.commands.registerCommand('agentTaskPlayer.retryTask', cmdRetryTask),
    vscode.commands.registerCommand('agentTaskPlayer.retryTaskWithNote', cmdRetryTaskWithNote),
    vscode.commands.registerCommand('agentTaskPlayer.exportResults', cmdExportResults),
    vscode.commands.registerCommand('agentTaskPlayer.dryRun', cmdDryRun),
    vscode.commands.registerCommand('agentTaskPlayer.undoTask', cmdUndoTask),
    vscode.commands.registerCommand('agentTaskPlayer.setTaskStatus', cmdSetTaskStatus),
    vscode.commands.registerCommand('agentTaskPlayer.setPlaylistStatus', cmdSetPlaylistStatus),
    vscode.commands.registerCommand('agentTaskPlayer.runSelected', cmdRunSelected),
    vscode.commands.registerCommand('agentTaskPlayer.openSession', cmdOpenSession),
    vscode.commands.registerCommand('agentTaskPlayer.openThread', cmdOpenThread),
    vscode.commands.registerCommand('agentTaskPlayer.deleteSession', cmdDeleteSession),
    vscode.commands.registerCommand('agentTaskPlayer.deleteThread', cmdDeleteThread),
    vscode.commands.registerCommand('agentTaskPlayer.renameThread', cmdRenameThread),
    vscode.commands.registerCommand('agentTaskPlayer.searchSessions', cmdSearchSessions),
    vscode.commands.registerCommand('agentTaskPlayer.clearSessions', cmdClearSessions),
    vscode.commands.registerCommand('agentTaskPlayer.newConversation', cmdNewConversation),
    vscode.commands.registerCommand('agentTaskPlayer.reviewChanges', cmdReviewChanges),
    vscode.commands.registerCommand('agentTaskPlayer.duplicateTask', cmdDuplicateTask),
    vscode.commands.registerCommand('agentTaskPlayer.smartNewPlan', cmdSmartNewPlan),
    vscode.commands.registerCommand('agentTaskPlayer.splitTask', cmdSplitTask),
    vscode.commands.registerCommand('agentTaskPlayer.planFromGitHubIssue', cmdPlanFromGitHubIssue),
    vscode.commands.registerCommand('agentTaskPlayer.createPR', createPRFromRun),
    vscode.commands.registerCommand('agentTaskPlayer.quickAddTask', cmdQuickAddTask),
    vscode.commands.registerCommand('agentTaskPlayer.addTaskFromSelection', cmdAddTaskFromSelection),
    vscode.commands.registerCommand('agentTaskPlayer.newPlanFromTemplate', cmdNewPlanFromTemplate),
    vscode.commands.registerCommand('agentTaskPlayer.addReviewStep', cmdAddReviewStep),
    vscode.commands.registerCommand('agentTaskPlayer.sharePlan', cmdSharePlan),
    vscode.commands.registerCommand('agentTaskPlayer.importPlanFromUrl', cmdImportPlanFromUrl),
    vscode.commands.registerCommand('agentTaskPlayer.switchProfile', cmdSwitchProfile),
    vscode.commands.registerCommand('agentTaskPlayer.watchMode', cmdToggleWatchMode),
    vscode.commands.registerCommand('agentTaskPlayer.managePromptSnippets', cmdManagePromptSnippets),
    vscode.commands.registerCommand('agentTaskPlayer.toggleFullAuto', async () => {
      const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
      const current = cfg.get<boolean>('fullAuto', false);
      await cfg.update('fullAuto', !current, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Full Auto mode: ${!current ? 'ON — write → test → fix loop active' : 'OFF'}`);
    }),

    // ─── Sandbox commands ───
    vscode.commands.registerCommand('agentTaskPlayer.launchSandbox', async () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showWarningMessage('Open a workspace folder before launching the sandbox.');
        return;
      }
      ensureDashboardOpen();
      await sandboxManager!.launch(cwd, currentPlan?.sandbox);
    }),

    vscode.commands.registerCommand('agentTaskPlayer.stopSandbox', () => {
      sandboxManager?.stop();
    }),

    vscode.commands.registerCommand('agentTaskPlayer.takeScreenshot', async () => {
      const state = sandboxManager?.state;
      if (!state || state.status !== 'running') {
        vscode.window.showWarningMessage('Launch the sandbox first before taking a screenshot.');
        return;
      }
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) { return; }

      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'MOAG: capturing screenshot…' },
        async () => {
          const screenshotPath = await captureScreenshot({
            projectType: state.projectInfo?.type ?? 'web',
            url: state.url,
            cwd,
          });

          if (screenshotPath) {
            sandboxManager!.setLastScreenshotPath(screenshotPath);
            runner.queueScreenshots([screenshotPath]);
            vscode.window.showInformationMessage(
              `Screenshot captured — will be attached to the next agent task.`,
              'View',
            ).then(choice => {
              if (choice === 'View') {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(screenshotPath));
              }
            });
          } else {
            vscode.window.showWarningMessage(
              'Screenshot failed. For web: install Playwright (npm i -D @playwright/test). ' +
              'For mobile: ensure adb (Android) or xcrun (iOS) is accessible.',
            );
          }
        },
      );
    }),
  );

  // Show walkthrough on first activation — always, regardless of existing plans
  const hasSeenWalkthrough = context.globalState.get<boolean>('agentTaskPlayer.hasSeenWalkthrough', false);
  if (!hasSeenWalkthrough) {
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'moag.agent-task-player#agentTaskPlayer.getStarted',
      false,
    );
    context.globalState.update('agentTaskPlayer.hasSeenWalkthrough', true);
  }

  // Show "What's New" notification when the extension updates to a new version
  const currentVersion = vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON?.version as string | undefined;
  const lastSeenVersion = context.globalState.get<string>('agentTaskPlayer.lastSeenVersion');
  if (currentVersion && lastSeenVersion && lastSeenVersion !== currentVersion) {
    vscode.window.showInformationMessage(
      `MOAG updated to v${currentVersion}`,
      "What's New",
    ).then(choice => {
      if (choice === "What's New") {
        cmdShowChangelog(context);
      }
    });
  }
  if (currentVersion) {
    context.globalState.update('agentTaskPlayer.lastSeenVersion', currentVersion);
  }

  // Auto-detect installed engines on first launch (non-blocking)
  void detectAndConfigureEngines(context)
    .then(async (result) => {
      updateEngineStatusBar(result.available);
      syncPromptProviderEngines(promptProvider, result.available);
      await promptToInstallEngineOnce(context, result.available);
    })
    .catch(() => undefined);

  // Auto-load plan if one exists in workspace, then restore pause state
  autoLoadPlan().then(() => restorePauseState(context));

  // Watch for plan file changes — auto-reload on external edits
  planFileWatcher = vscode.workspace.createFileSystemWatcher('**/{.moag/*.json,*.agent-plan.json}');
  planFileWatcher.onDidChange((uri) => {
    if (currentPlanPath && normalizeFilePath(uri.fsPath) === normalizeFilePath(currentPlanPath) && runner.state === RunnerState.Idle) {
      try {
        const plan = loadPlan(currentPlanPath);
        setVisiblePlan(plan, currentPlanPath);
      } catch {
        // ignore reload errors
      }
    }
  });
  context.subscriptions.push(planFileWatcher);
}

async function createPRFromRun(): Promise<void> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { return; }
  const cwd = workspaceFolder.uri.fsPath;

  // Check gh CLI
  try {
    execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' });
  } catch {
    vscode.window.showWarningMessage('Install GitHub CLI (gh) to create PRs automatically. https://cli.github.com');
    return;
  }

  const plan = getActivePlan();
  const defaultTitle = plan?.name || 'MOAG automated changes';

  const title = await vscode.window.showInputBox({
    prompt: 'PR title',
    value: defaultTitle,
  });
  if (!title) { return; }

  // Build body from run history
  const allEntries = historyStore.getAll();
  const runEntries = runner.currentRunId
    ? allEntries.filter(e => e.runId === runner.currentRunId)
    : allEntries.slice(0, 20);
  const taskList = runEntries.map(e => `- ${e.status === 'completed' ? '✅' : '❌'} ${e.taskName}`).join('\n');
  const changedFiles = [...new Set(runEntries.flatMap(e => e.changedFiles ?? []))];
  const filesStr = changedFiles.length > 0 ? changedFiles.map(f => `- \`${f}\``).join('\n') : 'No file changes detected.';

  const body = `## Summary\nGenerated by MOAG plan: "${plan?.name || 'untitled'}"\n\n### Tasks\n${taskList}\n\n### Changed Files\n${filesStr}\n\n---\n🤖 Generated with [MOAG](https://github.com/sujan-poudel-03/moag)`;

  try {
    const result = execSync(`gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`, {
      cwd,
      timeout: 30000,
      encoding: 'utf-8',
    });
    const prUrl = result.trim().split('\n').pop() || '';
    const action = await vscode.window.showInformationMessage(`PR created: ${prUrl}`, 'Open PR');
    if (action === 'Open PR' && prUrl) {
      vscode.env.openExternal(vscode.Uri.parse(prUrl));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no commits')) {
      vscode.window.showWarningMessage('No commits to create a PR from. Commit your changes first.');
    } else {
      vscode.window.showErrorMessage(`Failed to create PR: ${msg.substring(0, 200)}`);
    }
  }
}

export function deactivate(): void {
  extensionContext = null;
  promptViewProvider = null;
  runner?.stop();
  runner?.stopAllServices();
  sandboxManager?.stop();
  if (planFileWatcher) {
    planFileWatcher.dispose();
    planFileWatcher = null;
  }
  disableWatchMode();
}

// ─── Helper: save & refresh ───

function saveAndRefresh(): void {
  const plan = getActivePlan();
  if (plan && currentPlanPath) {
    savePlan(plan, currentPlanPath);
  }
  planDirty = Boolean(plan && isDefaultPlanPath(currentPlanPath));
  planTree.setPlan(plan);
  if (planView) {
    planView.message = undefined;
  }
  if (promptViewProvider) {
    schedulePromptProviderSidebarSync();
  }
  scheduleDashboardUpdate();
}

async function promptSaveBeforeNew(): Promise<boolean> {
  const plan = getActivePlan();
  if (!plan || !planDirty || !isDefaultPlanPath(currentPlanPath)) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    `Plan "${plan.name}" has unsaved changes in the default location. Save it with a name before creating a new plan?`,
    'Save As...',
    'Discard',
    'Cancel',
  );
  if (!choice || choice === 'Cancel') {
    return false;
  }
  if (choice === 'Save As...') {
    const saved = await cmdSavePlanAs();
    return saved && !isDefaultPlanPath(currentPlanPath);
  }
  return true;
}

function formatTaskList(values?: string[]): string {
  return values?.join('\n') ?? '';
}

function parseTaskList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const values = raw
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function formatTaskEnv(env?: Record<string, string>): string {
  if (!env) {
    return '';
  }
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parseTaskEnv(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) {
    return undefined;
  }
  const envEntries = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (envEntries.length === 0) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const entry of envEntries) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = entry.slice(0, eqIndex).trim();
    const value = entry.slice(eqIndex + 1).trim();
    if (key) {
      env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function getTaskType(task: Task): TaskType {
  return task.type ?? 'agent';
}

// ─── .moag/ directory management ───

const MOAG_DIR = '.moag';
const MOAG_PLAN_FILE = '.agent-plan.json';
const MOAG_FALLBACK_PLAN_FILE = 'plan.json';

/** Get the .moag/ directory path for the current workspace */
function getMoagDir(): string | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { return null; }
  return path.join(workspaceFolder.uri.fsPath, MOAG_DIR);
}

/** Get preferred plan path: .moag/.agent-plan.json (fallback .moag/plan.json) */
function getMoagPlanPath(): string | null {
  const dir = getMoagDir();
  if (!dir) { return null; }
  const fs = require('fs') as typeof import('fs');
  const canonical = path.join(dir, MOAG_PLAN_FILE);
  if (fs.existsSync(canonical)) {
    return canonical;
  }
  return path.join(dir, MOAG_FALLBACK_PLAN_FILE);
}

/** Ensure .moag/ directory exists */
function ensureMoagDir(): string | null {
  const dir = getMoagDir();
  if (!dir) { return null; }
  const fs = require('fs') as typeof import('fs');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return null; // read-only FS or permission denied
    }
  }
  // Add .moag/ to .gitignore if not already there
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    try {
      const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
      if (!content.includes('.moag')) {
        const newLine = content.endsWith('\n') ? '' : '\n';
        fs.appendFileSync(gitignorePath, `${newLine}# MOAG agent orchestrator\n.moag/\n`);
      }
    } catch {
      // ignore gitignore errors
    }
  }
  return dir;
}

/** Resolve the plan path: prefer .moag/.agent-plan.json, then .moag/plan.json */
async function resolvePlanPath(): Promise<string | null> {
  const fs = require('fs') as typeof import('fs');
  const moagDir = getMoagDir();
  const canonicalMoagPath = moagDir ? path.join(moagDir, MOAG_PLAN_FILE) : null;
  const fallbackMoagPath = moagDir ? path.join(moagDir, MOAG_FALLBACK_PLAN_FILE) : null;
  const moagPath = getMoagPlanPath();

  // 1. If .moag/.agent-plan.json exists, use it
  if (canonicalMoagPath && fs.existsSync(canonicalMoagPath)) {
    // Still check for stray legacy files and clean them up
    migrateLegacyPlans();
    return canonicalMoagPath;
  }

  // 2. If .moag/plan.json exists, use it
  if (fallbackMoagPath && fs.existsSync(fallbackMoagPath)) {
    migrateLegacyPlans();
    return fallbackMoagPath;
  }

  // 3. Find any legacy *.agent-plan.json files and auto-migrate the first one
  let files: vscode.Uri[];
  try {
    const findPromise = vscode.workspace.findFiles('*.agent-plan.json', '**/node_modules/**', 10);
    const timeoutPromise = new Promise<vscode.Uri[]>((_, reject) =>
      setTimeout(() => reject(new Error('findFiles timeout')), 1000),
    );
    files = await Promise.race([findPromise, timeoutPromise]);
  } catch {
    return null; // timed out or errored — huge workspace, bail gracefully
  }
  if (files.length === 0) {
    return null;
  }

  // Auto-migrate: move to .moag/plan.json, no questions asked
  const dir = ensureMoagDir();
  if (dir && moagPath) {
    try {
      // Move the first (most relevant) plan file
      fs.copyFileSync(files[0].fsPath, moagPath);
      fs.unlinkSync(files[0].fsPath);

      // Clean up any remaining legacy plan files — move them to .moag/ as backups
      for (let i = 1; i < files.length; i++) {
        const basename = path.basename(files[i].fsPath);
        const backupPath = path.join(dir, basename);
        try {
          fs.renameSync(files[i].fsPath, backupPath);
        } catch { /* ignore */ }
      }

      return moagPath;
    } catch {
      // Migration failed, use legacy path directly
      return files[0].fsPath;
    }
  }

  return files[0].fsPath;
}

/** Silently clean up any stray *.agent-plan.json files from workspace root into .moag/ */
function migrateLegacyPlans(): void {
  const fs = require('fs') as typeof import('fs');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const moagDir = getMoagDir();
  if (!workspaceRoot || !moagDir) { return; }

  try {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.agent-plan.json')) {
        const src = path.join(workspaceRoot, entry.name);
        let dest = path.join(moagDir, entry.name);
        // If destination already exists, use a numbered suffix
        if (fs.existsSync(dest)) {
          const base = entry.name.replace(/\.agent-plan\.json$/, '');
          let counter = 2;
          while (fs.existsSync(path.join(moagDir, `${base}-${counter}.agent-plan.json`))) {
            counter++;
          }
          dest = path.join(moagDir, `${base}-${counter}.agent-plan.json`);
        }
        try {
          fs.renameSync(src, dest);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** Get the save path for a new plan — always .moag/plan.json */
function getNewPlanSavePath(): string | null {
  ensureMoagDir();
  return getMoagPlanPath();
}

// ─── Auto-load plan ───

async function autoLoadPlan(): Promise<void> {
  const planPath = await resolvePlanPath();
  if (!planPath) { return; }

  // If the plan file was deleted externally, reset and bail
  const fs = require('fs') as typeof import('fs');
  if (!fs.existsSync(planPath)) {
    setVisiblePlan(null, null);
    return;
  }

  try {
    const plan = loadPlan(planPath);
    setVisiblePlan(plan, planPath);
  } catch {
    // Silently ignore corrupt plan files on startup
  }
}

// ─── Pre-flight engine validation ───

/** Collect unique engine IDs needed to execute a given scope of the plan. */
function collectEngineIds(plan: Plan, playlistIndex?: number, taskIndex?: number): EngineId[] {
  const engines = new Set<EngineId>();

  const collectFromTask = (task: Task, playlistEngine: EngineId | undefined) => {
    if (getTaskType(task) !== 'agent') {
      return;
    }
    engines.add(task.engine ?? playlistEngine ?? plan.defaultEngine);
  };

  if (playlistIndex !== undefined && taskIndex !== undefined) {
    const playlist = plan.playlists[playlistIndex];
    const task = playlist.tasks[taskIndex];
    collectFromTask(task, playlist.engine);
  } else if (playlistIndex !== undefined) {
    const playlist = plan.playlists[playlistIndex];
    for (const task of playlist.tasks) {
      collectFromTask(task, playlist.engine);
    }
  } else {
    for (const playlist of plan.playlists) {
      for (const task of playlist.tasks) {
        collectFromTask(task, playlist.engine);
      }
    }
  }

  return [...engines];
}

/**
 * Lightweight pre-flight check: verify the engine for the first pending task is installed.
 * Uses `which` (Unix) / `where` (Windows) via commandExists.
 * Returns true if execution should proceed, false if the user cancelled.
 */
async function checkFirstPendingEngine(plan: Plan): Promise<boolean> {
  // Find the first pending agent task
  for (const playlist of plan.playlists) {
    for (const task of playlist.tasks) {
      if (task.status !== TaskStatus.Pending) { continue; }
      if (getTaskType(task) !== 'agent') { continue; }
      const engineId = task.engine ?? playlist.engine ?? plan.defaultEngine;
      try {
        const adapter = getEngine(engineId);
        const command = adapter.getCommand();
        const exists = await commandExists(command);
        if (!exists) {
          const action = await vscode.window.showWarningMessage(
            `Engine "${adapter.displayName}" not found. Install it or change the engine in your plan.`,
            'Continue Anyway',
            'Cancel',
          );
          return action === 'Continue Anyway';
        }
      } catch {
        // No adapter registered — fall through to full preflight
      }
      return true; // Only check the first pending agent task
    }
  }
  return true; // No pending agent tasks
}

/**
 * Pre-flight check: validate that all required engines are available.
 * Returns true if execution should proceed, false if the user cancelled.
 */
async function preflightEngineCheck(
  plan: Plan,
  playlistIndex?: number,
  taskIndex?: number,
): Promise<boolean> {
  const engineIds = collectEngineIds(plan, playlistIndex, taskIndex);
  const availability = await checkEngineAvailability(engineIds);

  const missing: Array<{ id: EngineId; command: string; displayName: string }> = [];
  for (const [id, info] of availability) {
    if (!info.available) {
      missing.push({ id, command: info.command, displayName: info.displayName });
    }
  }

  if (missing.length === 0) {
    return true;
  }

  const engineList = missing
    .map(m => m.command
      ? `"${m.displayName}" (command: ${m.command})`
      : `"${m.displayName}" (not configured)`)
    .join(', ');

  const msg = missing.length === 1
    ? `Engine ${engineList} was not found on your system.`
    : `Engines ${engineList} were not found on your system.`;

  const action = await vscode.window.showWarningMessage(
    msg,
    'Run Anyway',
    'Open Settings',
  );

  if (action === 'Run Anyway') {
    return true;
  }
  if (action === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'agentTaskPlayer.engines');
    return false;
  }

  return false;
}

// ─── Command handlers ───

function getPromptTaskName(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 60 ? normalized.substring(0, 57) + '...' : normalized;
}

function initializeSingleTaskExecution(): void {
  executionTaskCount = 1;
  executionTasksCompleted = 0;
  executionTasksFailed = 0;
  executionStartTime = Date.now();
}

function initializeMultiTaskExecution(taskCount: number): void {
  executionTaskCount = Math.max(taskCount, 0);
  executionTasksCompleted = 0;
  executionTasksFailed = 0;
  executionStartTime = Date.now();
}

function createPromptPlan(prompt: string, engineId: EngineId, threadId: string, turnIndex: number): Plan {
  const taskName = getPromptTaskName(prompt);
  const tempPlan = createEmptyPlan(`Run: ${taskName}`);
  tempPlan.description = prompt;
  tempPlan.defaultEngine = engineId;
  tempPlan.playlists = [createPlaylist('Run Prompt', engineId)];
  const task = createTask(taskName, prompt, engineId) as Task & { _threadId?: string; _turnIndex?: number };
  task._threadId = threadId;
  task._turnIndex = turnIndex;
  tempPlan.playlists[0].tasks.push(task);
  return tempPlan;
}

async function showNoPromptEngineMessage(): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    'No available AI engine was detected. Install or configure one to run prompts.',
    'Detect Engines',
    'Open Settings',
  );
  if (action === 'Detect Engines') {
    vscode.commands.executeCommand('agentTaskPlayer.detectEngines');
  } else if (action === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'agentTaskPlayer.engines');
  }
}

async function resolveRunPromptEngine(): Promise<EngineId | null> {
  const configuredEngine = vscode.workspace.getConfiguration('agentTaskPlayer')
    .get<EngineId>('defaultEngine', 'claude' as EngineId);
  const configuredAvailability = await checkEngineAvailability([configuredEngine]);
  if (configuredAvailability.get(configuredEngine)?.available) {
    return configuredEngine;
  }

  const detected = await detectEngines();
  if (detected.autoSelected) {
    return detected.autoSelected;
  }

  const customEngine = 'custom' as EngineId;
  if (configuredEngine !== customEngine) {
    const customAvailability = await checkEngineAvailability([customEngine]);
    if (customAvailability.get(customEngine)?.available) {
      return customEngine;
    }
  }

  return null;
}

async function runPromptSubmission(
  prompt: string,
  selectedEngineId?: EngineId,
): Promise<boolean> {
  if (!vscode.workspace.workspaceFolders?.[0]) {
    UserMsg.showError(UserMsg.noWorkspace());
    return false;
  }

  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Runner is already active. Stop it first.');
    return false;
  }

  const engineId = selectedEngineId ?? await resolveRunPromptEngine();
  if (!engineId) {
    await showNoPromptEngineMessage();
    return false;
  }

  // Keep sidebar prompts in one continuous chat thread unless user switches threads.
  const sidebarThreadId = currentSidebarThreadId ?? generateId();
  const nextTurnIndex = historyStore.getThread(sidebarThreadId).length;
  currentSidebarThreadId = sidebarThreadId;
  pendingSidebarTurn = {
    prompt,
    engine: engineId,
    startedAt: new Date().toISOString(),
    threadId: sidebarThreadId,
    turnIndex: nextTurnIndex,
  };
  if (promptViewProvider) {
    schedulePromptProviderSidebarSync();
  }

  const promptPlan = createPromptPlan(prompt, engineId, sidebarThreadId, nextTurnIndex);
  if (!await preflightEngineCheck(promptPlan, 0, 0)) {
    pendingSidebarTurn = null;
    if (promptViewProvider) {
      schedulePromptProviderSidebarSync();
    }
    return false;
  }

  void vscode.commands.executeCommand('agentTaskPlayer.showDashboard');

  const activePlan = getActivePlan();
  if (!activePlan) {
    runner.resetPlan(promptPlan);
    initializeSingleTaskExecution();
    activateTemporaryPlan(promptPlan);
    DashboardPanel.currentPanel?.clearTimeline();
    startProgressNotification();

    try {
      await runner.play(promptPlan);
      return true;
    } catch (err) {
      pendingSidebarTurn = null;
      if (promptViewProvider) {
        schedulePromptProviderSidebarSync();
      }
      UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
      return false;
    } finally {
      restoreTemporaryPlan(false);
    }
  }

  if (activePlan.playlists.length === 0) {
    activePlan.playlists.push(createPlaylist('Tasks'));
  }

  const targetPlaylist = activePlan.playlists[0];
  const task = createTask(getPromptTaskName(prompt), prompt, engineId) as Task & { _threadId?: string; _turnIndex?: number };
  task._threadId = sidebarThreadId;
  task._turnIndex = nextTurnIndex;
  targetPlaylist.tasks.push(task);
  saveAndRefresh();

  const singleTaskPlan: Plan = {
    ...activePlan,
    playlists: [
      {
        ...targetPlaylist,
        tasks: [task],
      },
    ],
  };

  runner.resetPlan(singleTaskPlan);
  initializeSingleTaskExecution();
  DashboardPanel.currentPanel?.clearTimeline();
  startProgressNotification();

  try {
    await runner.play(singleTaskPlan);
    return true;
  } catch (err) {
    pendingSidebarTurn = null;
    if (promptViewProvider) {
      schedulePromptProviderSidebarSync();
    }
    UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
    return false;
  }
}

async function generatePlanFromDashboardPrompt(prompt: string): Promise<boolean> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return false;
  }

  if (!prompt.trim()) {
    vscode.window.showWarningMessage('Describe the plan first.');
    return false;
  }

  if (!await promptSaveBeforeNew()) {
    return false;
  }

  return createPlanFromIdea(prompt, workspaceFolder);
}

async function cmdRunPrompt(): Promise<void> {
  const input = await vscode.window.showInputBox({
    placeHolder: 'Describe what you want the AI to do...',
    prompt: 'Run a single prompt with the best available engine',
    ignoreFocusOut: true,
  });
  const prompt = input?.trim();
  if (!prompt) {
    return;
  }

  await runPromptSubmission(prompt);
}

async function cmdPlay(): Promise<void> {
  const activePlan = getActivePlan();
  if (!activePlan) {
    vscode.window.showWarningMessage('No plan loaded. Open or create a plan first.');
    return;
  }

  // Resume from pause — don't reset anything
  if (runner.state === RunnerState.Paused) {
    runner.play(activePlan);
    return;
  }

  // Already running or stopping — ignore
  if (runner.state !== RunnerState.Idle) {
    return;
  }

  // Check if there are already completed/failed tasks (partial run)
  const hasProgress = activePlan.playlists.some(pl =>
    pl.tasks.some(t => t.status !== TaskStatus.Pending),
  );

  if (hasProgress) {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(debug-continue) Resume', description: 'Continue from where it left off (skip completed tasks)', value: 'resume' },
        { label: '$(debug-restart) Restart', description: 'Reset all tasks and start over', value: 'restart' },
      ],
      { placeHolder: 'Plan has progress from a previous run' },
    );
    if (!action) { return; }

    if (action.value === 'restart') {
      runner.resetPlan(activePlan);
      DashboardPanel.currentPanel?.clearTimeline();
    }
    // For resume: leave task statuses as-is — the runner skips completed tasks
  } else {
    // Fresh start
    runner.resetPlan(activePlan);
    DashboardPanel.currentPanel?.clearTimeline();
  }

  // Pre-flight engine check — verify the first pending task's engine is installed
  if (!await checkFirstPendingEngine(activePlan)) {
    return;
  }

  // Initialize progress counters
  initializeMultiTaskExecution(activePlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0));

  saveAndRefresh();
  startProgressNotification();
  // Auto-open the dashboard so the user sees live output
  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  runner.play(activePlan).catch(err => {
    UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
  });
}

function cmdPause(): void {
  runner.pause();
}

function cmdStop(): void {
  runner.stop();
}

async function cmdOpenPlan(): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    filters: { 'Agent Plan': ['agent-plan.json', 'json'] },
    title: 'Open Agent Plan',
  });
  if (!uris || uris.length === 0) { return; }

  try {
    const planPath = uris[0].fsPath;
    const plan = loadPlan(planPath);
    setVisiblePlan(plan, planPath);
    vscode.window.showInformationMessage(`Loaded plan: ${plan.name}`);
  } catch (err) {
    UserMsg.showError(UserMsg.planLoadError(err instanceof Error ? err.message : String(err)));
  }
}

async function cmdSwitchPlan(): Promise<void> {
  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Stop the runner before switching plans.');
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const moagDir = getMoagDir();
  if (!workspaceFolder || !moagDir) {
    vscode.window.showWarningMessage('No workspace open');
    return;
  }

  const fs = require('fs') as typeof import('fs');
  const wsRoot = workspaceFolder.uri.fsPath;

  interface PlanQuickPickItem extends vscode.QuickPickItem {
    path?: string;
  }

  const activePath = currentPlanPath ? normalizeFilePath(currentPlanPath) : null;
  const seenPaths = new Set<string>();
  const fileItems: PlanQuickPickItem[] = [];

  const addPlanItem = (fullPath: string, fallbackName: string, description?: string): void => {
    const normalizedPath = normalizeFilePath(fullPath);
    if (seenPaths.has(normalizedPath) || !fs.existsSync(fullPath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const plan = loadPlanFromJson(raw);
      const isCurrent = activePath !== null && normalizedPath === activePath;
      fileItems.push({
        label: `${isCurrent ? '$(check)' : '$(file)'} ${plan.name || fallbackName}`,
        description: isCurrent ? '(active)' : (description ?? path.relative(wsRoot, fullPath)),
        detail: plan.description ? plan.description.substring(0, 100) : undefined,
        path: fullPath,
      });
      seenPaths.add(normalizedPath);
    } catch {
      // Skip invalid or non-plan JSON files.
    }
  };

  if (fs.existsSync(moagDir)) {
    const moagEntries = fs.readdirSync(moagDir, { withFileTypes: true });
    for (const entry of moagEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      addPlanItem(path.join(moagDir, entry.name), entry.name);
    }
  }

  const rootEntries = fs.readdirSync(wsRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.agent-plan.json')) {
      continue;
    }
    addPlanItem(path.join(wsRoot, entry.name), entry.name, entry.name);
  }

  fileItems.sort((a, b) => {
    if (a.description === '(active)' && b.description !== '(active)') {
      return -1;
    }
    if (b.description === '(active)' && a.description !== '(active)') {
      return 1;
    }
    return a.label.localeCompare(b.label);
  });

  const recentItems: PlanQuickPickItem[] = getRecentPlans()
    .filter(recent => {
      const normalizedPath = normalizeFilePath(recent.path);
      return !seenPaths.has(normalizedPath) && fs.existsSync(recent.path);
    })
    .map(recent => ({
      label: `$(history) ${recent.name}`,
      description: `(recent) ${path.relative(wsRoot, recent.path)}`,
      path: recent.path,
    }));

  if (fileItems.length === 0 && recentItems.length === 0) {
    vscode.window.showInformationMessage('No plan files found. Create one first.');
    return;
  }

  const items: PlanQuickPickItem[] = [...fileItems];
  if (recentItems.length > 0) {
    items.push({
      label: 'Recent Plans',
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push(...recentItems);
  }

  items.push({
    label: '$(add) Create New Plan',
    description: '',
    path: '__new__',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a plan to load',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }

  if (picked.path === '__new__') {
    void vscode.commands.executeCommand('agentTaskPlayer.newPlan');
    return;
  }
  if (!picked.path) {
    return;
  }

  try {
    const plan = loadPlan(picked.path);
    setVisiblePlan(plan, picked.path);
    vscode.window.showInformationMessage(`Loaded plan: ${plan.name}`);
  } catch (err) {
    UserMsg.showError(UserMsg.planLoadError(err instanceof Error ? err.message : String(err)));
  }
}

async function cmdSavePlanAs(): Promise<boolean> {
  const plan = getActivePlan();
  if (!plan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return false;
  }

  const filenameInput = await vscode.window.showInputBox({
    prompt: 'Save plan as (will be saved to .moag/ directory)',
    value: getSuggestedPlanFileName(plan.name),
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Filename required';
      }
      if (trimmed.toLowerCase() === MOAG_PLAN_FILE.toLowerCase()) {
        return 'Use a name other than plan.json';
      }
      if (!trimmed.endsWith('.json')) {
        return 'Must end with .json';
      }
      if (/[<>:"/\\|?*]/.test(trimmed)) {
        return 'Invalid characters in filename';
      }
      return null;
    },
  });
  if (!filenameInput) {
    return false;
  }

  const moagDir = ensureMoagDir();
  if (!moagDir) {
    vscode.window.showWarningMessage('Cannot create .moag/ directory.');
    return false;
  }

  const fs = require('fs') as typeof import('fs');
  const filename = filenameInput.trim();
  const newPath = path.join(moagDir, filename);
  const nextPath = normalizeFilePath(newPath);
  const activePath = currentPlanPath ? normalizeFilePath(currentPlanPath) : null;

  if (fs.existsSync(newPath) && nextPath !== activePath) {
    const overwrite = await vscode.window.showWarningMessage(
      `"${filename}" already exists. Overwrite?`,
      'Overwrite',
      'Cancel',
    );
    if (overwrite !== 'Overwrite') {
      return false;
    }
  }

  try {
    savePlan(plan, newPath);
    setVisiblePlan(plan, newPath);
    planDirty = isDefaultPlanPath(newPath);
    vscode.window.showInformationMessage(`Plan saved as: ${filename}`);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to save plan: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function createPlanFromIdea(
  rawIdea: string,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<boolean> {
  const trimmedIdea = rawIdea.trim();
  if (!trimmedIdea) {
    vscode.window.showWarningMessage('No description provided — plan creation cancelled.');
    return false;
  }

  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<EngineId>('defaultEngine', 'claude' as EngineId);
  const isLargeSpec = trimmedIdea.length > 500 || trimmedIdea.split('\n').length > 20;

  let planName = trimmedIdea.substring(0, 60).replace(/\n.*/s, '').trim();
  let playlists: Array<{ name: string; engine?: string; tasks: Array<{ name: string; prompt: string }> }> = [];

  const cwd = workspaceFolder.uri.fsPath;
  const projectAnalysis = analyzeProject(cwd);
  const projectContext = formatAnalysis(projectAnalysis);

  try {
    const engine = getEngine(defaultEngine);
    const prompt = isLargeSpec ? PLAN_GENERATION_PROMPT_LARGE : PLAN_GENERATION_PROMPT;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Generating plan...' },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const result = await engine.runTask({
          prompt: prompt + '\n\nProject context:\n' + projectContext + '\n\nUser description:\n' + trimmedIdea,
          cwd,
          signal: abortController.signal,
        });

        if (result.exitCode === 0 && result.stdout.trim()) {
          const parsed = parsePlanResponse(result.stdout);
          if (parsed) {
            planName = parsed.name;
            if (parsed.playlists && parsed.playlists.length > 0) {
              playlists = parsed.playlists;
            } else if (parsed.tasks && parsed.tasks.length > 0) {
              playlists = [{ name: 'Tasks', tasks: parsed.tasks }];
            }
          }
        }
      },
    );
  } catch {
    // Engine not available or failed — fall back to a single task plan
  }

  if (playlists.length === 0) {
    playlists = [{ name: 'Tasks', tasks: [{ name: planName, prompt: trimmedIdea }] }];
  }

  const totalGeneratedTasks = playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  if (totalGeneratedTasks > 1) {
    const reviewItems: (vscode.QuickPickItem & { plIdx: number; tIdx: number })[] = [];
    for (let pi = 0; pi < playlists.length; pi++) {
      const pl = playlists[pi];
      for (let ti = 0; ti < pl.tasks.length; ti++) {
        const t = pl.tasks[ti];
        const promptPreview = t.prompt.length > 80 ? t.prompt.substring(0, 77) + '...' : t.prompt;
        reviewItems.push({
          label: t.name,
          description: playlists.length > 1 ? pl.name : undefined,
          detail: promptPreview,
          picked: true,
          plIdx: pi,
          tIdx: ti,
        });
      }
    }

    const selected = await vscode.window.showQuickPick(reviewItems, {
      canPickMany: true,
      placeHolder: `Review ${totalGeneratedTasks} generated tasks — uncheck to remove`,
      title: `Plan: ${planName}`,
    });

    if (!selected) {
      return false;
    }

    const kept = new Set(selected.map(s => `${s.plIdx}-${s.tIdx}`));
    for (let pi = playlists.length - 1; pi >= 0; pi--) {
      playlists[pi].tasks = playlists[pi].tasks.filter((_, ti) => kept.has(`${pi}-${ti}`));
      if (playlists[pi].tasks.length === 0) {
        playlists.splice(pi, 1);
      }
    }

    if (playlists.length === 0) {
      vscode.window.showWarningMessage('All tasks were removed — plan creation cancelled.');
      return false;
    }
  }

  currentPlan = createEmptyPlan(planName);
  currentPlan.description = trimmedIdea.length > 500 ? trimmedIdea.substring(0, 500) + '...' : trimmedIdea;
  currentPlan.playlists = playlists.map(pl => {
    const playlist = createPlaylist(pl.name, pl.engine as EngineId | undefined);
    for (const t of pl.tasks) {
      playlist.tasks.push(createTask(t.name, t.prompt));
    }
    return playlist;
  });

  const totalTasks = currentPlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  currentPlanPath = getNewPlanSavePath() || path.join(workspaceFolder.uri.fsPath, `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`);
  saveAndRefresh();
  vscode.window.showInformationMessage(
    `Plan "${planName}" created — ${currentPlan.playlists.length} playlist${currentPlan.playlists.length > 1 ? 's' : ''}, ${totalTasks} task${totalTasks > 1 ? 's' : ''}.`,
  );
  return true;
}

async function cmdNewPlan(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return;
  }
  if (!await promptSaveBeforeNew()) {
    return;
  }

  // Let the user choose how to input their plan description
  const inputMethod = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Quick description', description: 'Type a one-liner', value: 'quick' },
      { label: '$(file-text) Paste full spec', description: 'Open an editor for large plans, specs, or detailed descriptions', value: 'editor' },
      { label: '$(clippy) From clipboard', description: 'Use text currently in clipboard', value: 'clipboard' },
    ],
    { placeHolder: 'How do you want to describe your plan?' },
  );
  if (!inputMethod) { return; }

  let rawIdea = '';

  if (inputMethod.value === 'quick') {
    const input = await vscode.window.showInputBox({
      prompt: 'Describe your project or what you want built',
      placeHolder: 'e.g., Build a REST API with auth, user CRUD, and tests',
    });
    if (!input) { return; }
    rawIdea = input;
  } else if (inputMethod.value === 'clipboard') {
    rawIdea = await vscode.env.clipboard.readText();
    if (!rawIdea.trim()) {
      vscode.window.showWarningMessage('Clipboard is empty. Copy your plan description first.');
      return;
    }
  } else {
    // Open a temporary untitled document for the user to paste/write their spec
    const doc = await vscode.workspace.openTextDocument({
      content: '# Paste or write your project description here\n# Delete these comment lines, then save and close this tab\n# The more detail you provide, the better the generated plan\n\n',
      language: 'markdown',
    });
    const editor = await vscode.window.showTextDocument(doc);

    // Wait for the user to close the tab
    rawIdea = await new Promise<string>((resolve) => {
      const disposable = vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed === doc) {
          disposable.dispose();
          // Strip comment lines
          const text = closed.getText()
            .split('\n')
            .filter(line => !line.startsWith('#'))
            .join('\n')
            .trim();
          resolve(text);
        }
      });
    });

    if (!rawIdea) {
      vscode.window.showWarningMessage('No description provided — plan creation cancelled.');
      return;
    }
  }

  await createPlanFromIdea(rawIdea, workspaceFolder);
}

async function cmdNewPlanFromTemplate(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return;
  }
  if (!await promptSaveBeforeNew()) {
    return;
  }

  // Group templates by category with counts
  const categories = new Map<string, PlanTemplate[]>();
  for (const tpl of BUILT_IN_PLAN_TEMPLATES) {
    const list = categories.get(tpl.category) ?? [];
    list.push(tpl);
    categories.set(tpl.category, list);
  }

  // Step 1: Pick a category
  const categoryPick = await vscode.window.showQuickPick(
    [...categories.entries()].map(([cat, templates]) => ({
      label: cat,
      description: `${templates.length} template${templates.length > 1 ? 's' : ''}`,
      category: cat,
    })),
    { placeHolder: 'Select a category' },
  );
  if (!categoryPick) { return; }

  // Step 2: Pick a template within the category
  const templates = categories.get(categoryPick.category)!;
  const templatePick = await vscode.window.showQuickPick(
    templates.map(tpl => ({
      label: tpl.name,
      description: tpl.description,
      template: tpl,
    })),
    { placeHolder: `Select a ${categoryPick.category} template` },
  );
  if (!templatePick) { return; }

  // Step 3: Ask for project name
  const folderName = path.basename(workspaceFolder.uri.fsPath);
  const projectName = await vscode.window.showInputBox({
    prompt: 'Project name',
    value: folderName,
    placeHolder: 'e.g., my-app',
  });
  if (!projectName) { return; }

  // Build the plan from the template
  currentPlan = templatePick.template.buildPlan(projectName);
  currentPlanPath = getNewPlanSavePath() || path.join(
    workspaceFolder.uri.fsPath,
    `${currentPlan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`,
  );
  saveAndRefresh();

  const totalTasks = currentPlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  vscode.window.showInformationMessage(
    `Plan "${currentPlan.name}" created from template — ${totalTasks} task${totalTasks > 1 ? 's' : ''}.`,
    'Play Now',
  ).then(action => {
    if (action === 'Play Now') {
      vscode.commands.executeCommand('agentTaskPlayer.play');
    }
  });
}

const PLAN_GENERATION_PROMPT = `You are a project planner. Given a raw idea or description, break it down into a concrete plan.

Respond with ONLY valid JSON (no markdown fences, no commentary) in this exact format:
{
  "name": "Short project name (max 60 chars)",
  "tasks": [
    { "name": "Short task name", "prompt": "Detailed instruction for a coding agent to execute this task" }
  ]
}

Rules:
- Each task should be a single, focused coding step that a CLI agent can execute independently
- Tasks should be ordered so they can be run sequentially (earlier tasks set up what later tasks need)
- Task prompts should be detailed and actionable — the agent needs enough context to do the work
- Keep it to 3-10 tasks. Don't over-split simple work, don't under-split complex work
- The project name should be concise and descriptive`;

const PLAN_GENERATION_PROMPT_LARGE = `You are a senior software architect and project planner. Given a detailed product specification or description, break it down into a structured, phased execution plan for AI coding agents.

Respond with ONLY valid JSON (no markdown fences, no commentary) in this exact format:
{
  "name": "Short project name (max 60 chars)",
  "playlists": [
    {
      "name": "Phase name (e.g., Platform Core, Auth System, Discovery Engine)",
      "tasks": [
        { "name": "Short task name", "prompt": "Detailed, actionable instruction for a coding agent. Include specifics: what files to create, what patterns to follow, what interfaces/types to define, what the expected behavior should be." }
      ]
    }
  ]
}

Rules:
- Group tasks into logical playlists/phases that represent major system areas or build stages
- Each phase should be executable after the previous phases are complete
- Each task should be a single, focused coding step a CLI agent can execute independently
- Task prompts must be detailed and self-contained — include enough context so the agent doesn't need to guess
- Include specific file paths, function names, data structures, and acceptance criteria in prompts
- For large specs: aim for 4-12 playlists with 3-8 tasks each
- For medium specs: aim for 2-5 playlists with 3-6 tasks each
- Start with foundational work (project setup, core models, database) before features
- End phases with testing/validation tasks where appropriate
- The project name should be concise and descriptive
- Do NOT create placeholder or "TODO later" tasks — only include what should be built now`;

/** Try to extract structured plan from AI response */
function parsePlanResponse(raw: string): {
  name: string;
  tasks?: Array<{ name: string; prompt: string }>;
  playlists?: Array<{ name: string; engine?: string; tasks: Array<{ name: string; prompt: string }> }>;
} | null {
  try {
    // Strip markdown code fences if present
    let json = raw.trim();
    const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      json = fenceMatch[1].trim();
    }

    // Sometimes LLMs output multiple JSON blocks or trailing text — find the first complete JSON object
    const objStart = json.indexOf('{');
    if (objStart > 0) { json = json.substring(objStart); }
    // Find matching closing brace
    let depth = 0;
    let objEnd = -1;
    for (let i = 0; i < json.length; i++) {
      if (json[i] === '{') { depth++; }
      else if (json[i] === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
    }
    if (objEnd > 0) { json = json.substring(0, objEnd + 1); }

    const parsed = JSON.parse(json);
    if (!parsed.name) { return null; }

    // Multi-playlist format
    if (Array.isArray(parsed.playlists) && parsed.playlists.length > 0) {
      const playlists = parsed.playlists
        .filter((pl: { name?: string; tasks?: unknown[] }) => pl.name && Array.isArray(pl.tasks) && pl.tasks.length > 0)
        .map((pl: { name: string; engine?: string; tasks: Array<{ name?: string; prompt?: string }> }) => ({
          name: pl.name,
          engine: pl.engine,
          tasks: pl.tasks
            .filter(t => t.name && t.prompt)
            .map(t => ({ name: String(t.name), prompt: String(t.prompt) })),
        }))
        .filter((pl: { tasks: unknown[] }) => pl.tasks.length > 0);
      if (playlists.length > 0) {
        return { name: String(parsed.name).substring(0, 60), playlists };
      }
    }

    // Single tasks array format (backward compatible)
    if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
      const tasks = parsed.tasks
        .filter((t: { name?: string; prompt?: string }) => t.name && t.prompt)
        .map((t: { name: string; prompt: string }) => ({ name: t.name, prompt: t.prompt }));
      if (tasks.length > 0) {
        return { name: String(parsed.name).substring(0, 60), tasks };
      }
    }
  } catch {
    // Parse failed — return null
  }
  return null;
}

async function cmdAddPlaylist(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Playlist name',
    placeHolder: 'e.g., Setup, Feature, Testing',
  });
  if (!name) { return; }

  const engine = await vscode.window.showQuickPick(
    ['claude', 'codex', 'gemini', 'ollama', 'custom'],
    { placeHolder: 'Select default engine (or press Esc for plan default)' },
  );

  const playlist = createPlaylist(name, engine as EngineId | undefined);
  currentPlan.playlists.push(playlist);
  saveAndRefresh();
}

async function cmdAddTask(playlistIndexOrItem?: unknown): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  // Resolve playlist index from tree item or argument
  let playlistIndex: number;
  if (playlistIndexOrItem instanceof PlanTreeItem) {
    playlistIndex = playlistIndexOrItem.playlistIndex;
  } else if (typeof playlistIndexOrItem === 'number') {
    playlistIndex = playlistIndexOrItem;
  } else if (currentPlan.playlists.length === 1) {
    playlistIndex = 0;
  } else if (currentPlan.playlists.length === 0) {
    vscode.window.showWarningMessage('Add a playlist first.');
    return;
  } else {
    const items = currentPlan.playlists.map((pl, i) => ({ label: pl.name, index: i }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select playlist' });
    if (!picked) { return; }
    playlistIndex = picked.index;
  }

  const newTask = createTask('', '');
  const playlist = currentPlan.playlists[playlistIndex];

  TaskEditorPanel.open({
    task: newTask,
    playlistIndex,
    taskIndex: null,
    engines: ['claude', 'codex', 'gemini', 'ollama', 'custom'] as EngineId[],
    onSave: (task) => {
      playlist.tasks.push(task);
      saveAndRefresh();
    },
  });
}

async function cmdEditTask(arg?: unknown): Promise<void> {
  if (!currentPlan) { return; }

  let playlistIndex: number;
  let taskIndex: number;

  if (arg instanceof PlanTreeItem && arg.taskIndex !== undefined) {
    playlistIndex = arg.playlistIndex;
    taskIndex = arg.taskIndex;
  } else if (arg && typeof arg === 'object' && 'playlistIndex' in arg && 'taskIndex' in arg) {
    playlistIndex = (arg as { playlistIndex: number }).playlistIndex;
    taskIndex = (arg as { taskIndex: number }).taskIndex;
  } else {
    return;
  }

  const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
  if (!task) { return; }

  TaskEditorPanel.open({
    task,
    playlistIndex,
    taskIndex,
    engines: ['claude', 'codex', 'gemini', 'ollama', 'custom'] as EngineId[],
    onSave: (updatedTask) => {
      Object.assign(task, updatedTask);
      saveAndRefresh();
    },
  });
}

function cmdSaveTaskEdit(arg?: unknown): void {
  if (!currentPlan || !arg || typeof arg !== 'object') { return; }
  const { playlistIndex, taskIndex, name, prompt } = arg as { playlistIndex: number; taskIndex: number; name: string; prompt: string };
  const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
  if (!task || !name?.trim()) { return; }
  task.name = name.trim();
  task.prompt = prompt ?? task.prompt;
  saveAndRefresh();
}

async function cmdDeleteItem(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item) { return; }

  const confirm = await vscode.window.showWarningMessage(
    `Delete "${item.label}"?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  if (item.kind === 'playlist') {
    currentPlan.playlists.splice(item.playlistIndex, 1);
  } else if (item.kind === 'task' && item.taskIndex !== undefined) {
    currentPlan.playlists[item.playlistIndex].tasks.splice(item.taskIndex, 1);
  }
  saveAndRefresh();
}

// ─── Phase 1: Quick workflow commands ───

async function cmdDuplicateTask(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }

  const playlist = currentPlan.playlists[item.playlistIndex];
  const original = playlist?.tasks[item.taskIndex];
  if (!original) { return; }

  const clone: Task = JSON.parse(JSON.stringify(original));
  clone.id = generateId();
  clone.name = original.name + ' (copy)';
  clone.status = TaskStatus.Pending;

  playlist.tasks.splice(item.taskIndex + 1, 0, clone);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Duplicated "${original.name}".`);
}

async function cmdAddReviewStep(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }

  const playlist = currentPlan.playlists[item.playlistIndex];
  const original = playlist?.tasks[item.taskIndex];
  if (!original) { return; }

  const originalEngine = original.engine ?? playlist.engine ?? currentPlan.defaultEngine;

  // Build engine options excluding the original task's engine
  const allEngines: Array<{ label: string; id: EngineId }> = [
    { label: 'Claude Code', id: 'claude' as EngineId },
    { label: 'Codex CLI', id: 'codex' as EngineId },
    { label: 'Gemini CLI', id: 'gemini' as EngineId },
    { label: 'Ollama (local)', id: 'ollama' as EngineId },
    { label: 'Custom', id: 'custom' as EngineId },
  ];
  const engineOptions = allEngines
    .filter(e => e.id !== originalEngine)
    .map(e => ({ label: e.label, description: e.id, id: e.id }));

  const pick = await vscode.window.showQuickPick(engineOptions, {
    placeHolder: 'Which engine should review?',
  });
  if (!pick) { return; }

  const reviewTask = createTask(`Review: ${original.name}`, '');
  reviewTask.type = 'review' as TaskType;
  reviewTask.dependsOn = [original.id];
  reviewTask.engine = pick.id;

  playlist.tasks.splice(item.taskIndex + 1, 0, reviewTask);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Added review step for "${original.name}" using ${pick.label}.`);
}

async function cmdQuickAddTask(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }
  if (currentPlan.playlists.length === 0) {
    vscode.window.showWarningMessage('Add a playlist first.');
    return;
  }

  // Resolve playlist
  let playlistIndex: number;
  if (currentPlan.playlists.length === 1) {
    playlistIndex = 0;
  } else {
    const items = currentPlan.playlists.map((pl, i) => ({ label: pl.name, index: i }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select playlist' });
    if (!picked) { return; }
    playlistIndex = picked.index;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Task name (first line). Additional lines become the prompt.',
    placeHolder: 'e.g., Add user authentication',
  });
  if (!input) { return; }

  const lines = input.split('\n');
  const name = lines[0].trim();
  const prompt = lines.length > 1 ? lines.slice(1).join('\n').trim() : name;

  const task = createTask(name, prompt);
  currentPlan.playlists[playlistIndex].tasks.push(task);
  saveAndRefresh();

  const action = await vscode.window.showInformationMessage(
    `Task "${name}" added.`,
    'Edit Details',
  );
  if (action === 'Edit Details') {
    const taskIndex = currentPlan.playlists[playlistIndex].tasks.length - 1;
    vscode.commands.executeCommand('agentTaskPlayer.editTask', { playlistIndex, taskIndex });
  }
}

async function cmdAddTaskFromSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }

  const selection = editor.document.getText(editor.selection);
  if (!selection.trim()) { return; }

  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }
  if (currentPlan.playlists.length === 0) {
    vscode.window.showWarningMessage('Add a playlist first.');
    return;
  }

  // Resolve playlist
  let playlistIndex: number;
  if (currentPlan.playlists.length === 1) {
    playlistIndex = 0;
  } else {
    const items = currentPlan.playlists.map((pl, i) => ({ label: pl.name, index: i }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select playlist' });
    if (!picked) { return; }
    playlistIndex = picked.index;
  }

  const firstLine = selection.split('\n')[0].trim();
  const name = firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine;
  const prompt = selection.trim();

  const task = createTask(name, prompt);
  currentPlan.playlists[playlistIndex].tasks.push(task);
  saveAndRefresh();

  const action = await vscode.window.showInformationMessage(
    `Task "${name}" added from selection.`,
    'Edit Details',
  );
  if (action === 'Edit Details') {
    const taskIndex = currentPlan.playlists[playlistIndex].tasks.length - 1;
    vscode.commands.executeCommand('agentTaskPlayer.editTask', { playlistIndex, taskIndex });
  }
}

// ─── Smart Plan: auto-detect project and generate plan ───

async function cmdSmartNewPlan(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return;
  }
  if (!await promptSaveBeforeNew()) {
    return;
  }

  const cwd = workspaceFolder.uri.fsPath;
  const analysis = analyzeProject(cwd);
  const analysisText = formatAnalysis(analysis);

  const frameworkStr = analysis.framework ? ` ${analysis.framework}` : '';
  const rawIdea = `Analyze this${frameworkStr} ${analysis.language} project and create a comprehensive improvement plan. ` +
    `Scan the codebase structure and create tasks to: add missing tests, fix issues, improve documentation, ` +
    `add CI/CD if missing, improve error handling, and any other quality improvements.\n\n` +
    `Project analysis:\n${analysisText}`;

  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<EngineId>('defaultEngine', 'claude' as EngineId);
  let planName = `Improve${frameworkStr} ${analysis.language} project`;
  let playlists: Array<{ name: string; engine?: string; tasks: Array<{ name: string; prompt: string }> }> = [];

  try {
    const engine = getEngine(defaultEngine);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Scanning project...' },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());
        const result = await engine.runTask({
          prompt: PLAN_GENERATION_PROMPT_LARGE + '\n\nUser description:\n' + rawIdea,
          cwd,
          signal: abortController.signal,
        });
        if (result.exitCode === 0 && result.stdout.trim()) {
          const parsed = parsePlanResponse(result.stdout);
          if (parsed) {
            planName = parsed.name || planName;
            if (parsed.playlists && parsed.playlists.length > 0) {
              playlists = parsed.playlists;
            } else if (parsed.tasks && parsed.tasks.length > 0) {
              playlists = [{ name: 'Improvements', tasks: parsed.tasks }];
            }
          }
        }
      },
    );
  } catch { /* fall through */ }

  if (playlists.length === 0) {
    // Generate sensible defaults from analysis
    const tasks: Array<{ name: string; prompt: string }> = [];
    for (const suggestion of analysis.suggestedImprovements) {
      tasks.push({ name: suggestion, prompt: `${suggestion}. This is a ${analysis.language} project${analysis.framework ? ' using ' + analysis.framework : ''}.` });
    }
    if (tasks.length === 0) {
      tasks.push({ name: 'Review and improve project', prompt: rawIdea });
    }
    playlists = [{ name: 'Improvements', tasks }];
  }

  // Review picker
  const totalTasks = playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  if (totalTasks > 1) {
    const reviewItems: (vscode.QuickPickItem & { plIdx: number; tIdx: number })[] = [];
    for (let pi = 0; pi < playlists.length; pi++) {
      for (let ti = 0; ti < playlists[pi].tasks.length; ti++) {
        const t = playlists[pi].tasks[ti];
        reviewItems.push({
          label: t.name,
          description: playlists.length > 1 ? playlists[pi].name : undefined,
          detail: t.prompt.substring(0, 80),
          picked: true,
          plIdx: pi,
          tIdx: ti,
        });
      }
    }
    const selected = await vscode.window.showQuickPick(reviewItems, {
      canPickMany: true,
      placeHolder: `Review ${totalTasks} detected improvements — uncheck to remove`,
      title: planName,
    });
    if (!selected) { return; }
    const kept = new Set(selected.map(s => `${s.plIdx}-${s.tIdx}`));
    for (let pi = playlists.length - 1; pi >= 0; pi--) {
      playlists[pi].tasks = playlists[pi].tasks.filter((_, ti) => kept.has(`${pi}-${ti}`));
      if (playlists[pi].tasks.length === 0) { playlists.splice(pi, 1); }
    }
    if (playlists.length === 0) { return; }
  }

  currentPlan = createEmptyPlan(planName);
  currentPlan.description = `Auto-generated from project scan (${analysis.language}${analysis.framework ? '/' + analysis.framework : ''})`;
  currentPlan.playlists = playlists.map(pl => {
    const playlist = createPlaylist(pl.name);
    for (const t of pl.tasks) { playlist.tasks.push(createTask(t.name, t.prompt)); }
    return playlist;
  });
  currentPlanPath = getNewPlanSavePath() || path.join(cwd, `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Smart plan "${planName}" created with ${playlists.reduce((s, p) => s + p.tasks.length, 0)} tasks.`);
}

// ─── GitHub Integration: plan from issue ───

async function cmdPlanFromGitHubIssue(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'GitHub issue URL or #number',
    placeHolder: 'https://github.com/owner/repo/issues/123 or #123',
  });
  if (!input) { return; }

  let owner = '', repo = '', issueNumber = '';

  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (urlMatch) {
    [, owner, repo, issueNumber] = urlMatch;
  } else {
    const numMatch = input.match(/#?(\d+)/);
    if (numMatch) {
      issueNumber = numMatch[1];
      // Try to detect from git remote
      try {
        const { execSync } = require('child_process') as typeof import('child_process');
        const remote = execSync('git remote get-url origin', { cwd: workspaceFolder.uri.fsPath, timeout: 5000 }).toString().trim();
        const remoteMatch = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (remoteMatch) {
          [, owner, repo] = remoteMatch;
        }
      } catch { /* ignore */ }
    }
  }

  if (!owner || !repo || !issueNumber) {
    vscode.window.showWarningMessage('Could not parse GitHub issue. Use format: https://github.com/owner/repo/issues/123');
    return;
  }

  let issueTitle = '';
  let issueBody = '';

  // Try gh CLI first (handles private repos), fall back to API
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const json = execSync(`gh issue view ${issueNumber} --repo ${owner}/${repo} --json title,body`, {
      cwd: workspaceFolder.uri.fsPath,
      timeout: 15000,
    }).toString();
    const parsed = JSON.parse(json);
    issueTitle = parsed.title || '';
    issueBody = parsed.body || '';
  } catch {
    // Fall back to public API
    try {
      const https = require('https') as typeof import('https');
      const data = await new Promise<string>((resolve, reject) => {
        const req = https.get(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
          headers: { 'User-Agent': 'MOAG-VSCode', Accept: 'application/vnd.github+json' },
        }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      const parsed = JSON.parse(data);
      issueTitle = parsed.title || '';
      issueBody = parsed.body || '';
    } catch {
      vscode.window.showErrorMessage('Failed to fetch GitHub issue. Check the URL and try again.');
      return;
    }
  }

  if (!issueTitle) {
    vscode.window.showWarningMessage('Issue not found or empty.');
    return;
  }

  const rawIdea = `GitHub Issue: ${issueTitle}\n\n${issueBody}`;
  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<EngineId>('defaultEngine', 'claude' as EngineId);
  const cwd = workspaceFolder.uri.fsPath;
  const projectAnalysis = analyzeProject(cwd);
  const projectContext = formatAnalysis(projectAnalysis);

  let planName = issueTitle.substring(0, 60).trim();
  let playlists: Array<{ name: string; engine?: string; tasks: Array<{ name: string; prompt: string }> }> = [];

  try {
    const engine = getEngine(defaultEngine);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Loading issue #${issueNumber}...` },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());
        const result = await engine.runTask({
          prompt: PLAN_GENERATION_PROMPT_LARGE + '\n\nProject context:\n' + projectContext + '\n\nUser description:\n' + rawIdea,
          cwd,
          signal: abortController.signal,
        });
        if (result.exitCode === 0 && result.stdout.trim()) {
          const parsed = parsePlanResponse(result.stdout);
          if (parsed) {
            planName = parsed.name || planName;
            if (parsed.playlists?.length) { playlists = parsed.playlists; }
            else if (parsed.tasks?.length) { playlists = [{ name: 'Tasks', tasks: parsed.tasks }]; }
          }
        }
      },
    );
  } catch { /* fall through */ }

  if (playlists.length === 0) {
    playlists = [{ name: 'Tasks', tasks: [{ name: planName, prompt: rawIdea }] }];
  }

  currentPlan = createEmptyPlan(planName);
  currentPlan.description = `From GitHub issue #${issueNumber}: ${issueTitle}`;
  currentPlan.playlists = playlists.map(pl => {
    const playlist = createPlaylist(pl.name);
    for (const t of pl.tasks) { playlist.tasks.push(createTask(t.name, t.prompt)); }
    return playlist;
  });
  currentPlanPath = getNewPlanSavePath() || path.join(cwd, `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Plan created from issue #${issueNumber}: "${planName}" — ${playlists.reduce((s, p) => s + p.tasks.length, 0)} tasks.`);
}

// ─── Smart Task Decomposition ───

async function cmdSplitTask(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }

  const playlist = currentPlan.playlists[item.playlistIndex];
  const task = playlist?.tasks[item.taskIndex];
  if (!task) { return; }

  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<EngineId>('defaultEngine', 'claude' as EngineId);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();

  let subTasks: Array<{ name: string; prompt: string }> = [];

  try {
    const engine = getEngine(defaultEngine);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Splitting task...` },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());
        const result = await engine.runTask({
          prompt: SPLIT_TASK_PROMPT + '\n\nOriginal task:\nName: ' + task.name + '\nPrompt: ' + task.prompt,
          cwd,
          signal: abortController.signal,
        });
        if (result.exitCode === 0 && result.stdout.trim()) {
          const parsed = parsePlanResponse(result.stdout);
          if (parsed?.tasks?.length) {
            subTasks = parsed.tasks;
          }
        }
      },
    );
  } catch { /* fall through */ }

  if (subTasks.length === 0) {
    vscode.window.showWarningMessage('Could not split this task. Try editing it manually.');
    return;
  }

  // Let user review the split
  const reviewItems = subTasks.map((t, i) => ({
    label: t.name,
    detail: t.prompt.substring(0, 80),
    picked: true,
    index: i,
  }));

  const selected = await vscode.window.showQuickPick(reviewItems, {
    canPickMany: true,
    placeHolder: `Split into ${subTasks.length} sub-tasks — uncheck to remove`,
  });
  if (!selected || selected.length === 0) { return; }

  // Replace original task with selected sub-tasks
  const newTasks = selected.map(s => {
    const t = createTask(subTasks[s.index].name, subTasks[s.index].prompt, task.engine);
    t.type = task.type;
    t.failurePolicy = task.failurePolicy;
    return t;
  });

  playlist.tasks.splice(item.taskIndex, 1, ...newTasks);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Split "${task.name}" into ${newTasks.length} sub-tasks.`);
}

const SPLIT_TASK_PROMPT = `Break this task into 2-4 smaller, independent sub-tasks. Each sub-task should be completable in isolation by an AI coding agent.

Respond with ONLY valid JSON (no markdown fences, no commentary):
{
  "tasks": [
    { "name": "Short task name", "prompt": "Detailed instruction for a coding agent to execute this sub-task" }
  ]
}

Rules:
- Each sub-task should be focused on a single concern
- Sub-tasks should be ordered so they can run sequentially
- Prompts should be detailed and self-contained
- Keep it to 2-4 sub-tasks`;

async function cmdBulkDelete(): Promise<void> {
  if (!currentPlan || currentPlan.playlists.length === 0) {
    vscode.window.showWarningMessage('No plan loaded or plan is empty.');
    return;
  }

  // Build a flat list of all playlists and tasks as QuickPick items
  interface DeletePickItem extends vscode.QuickPickItem {
    itemType: 'playlist' | 'task';
    playlistIndex: number;
    taskIndex?: number;
  }

  const items: DeletePickItem[] = [];
  for (let pi = 0; pi < currentPlan.playlists.length; pi++) {
    const pl = currentPlan.playlists[pi];
    items.push({
      label: `$(list-unordered) ${pl.name}`,
      description: `Playlist — ${pl.tasks.length} tasks`,
      itemType: 'playlist',
      playlistIndex: pi,
    });
    for (let ti = 0; ti < pl.tasks.length; ti++) {
      const task = pl.tasks[ti];
      items.push({
        label: `    $(circle-outline) ${task.name}`,
        description: task.engine || '',
        itemType: 'task',
        playlistIndex: pi,
        taskIndex: ti,
      });
    }
  }

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select items to delete (playlists and/or tasks)',
    title: 'Bulk Delete',
  });

  if (!picks || picks.length === 0) { return; }

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${picks.length} selected item${picks.length > 1 ? 's' : ''}?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  // Collect playlist indices to remove (whole playlists)
  const playlistsToRemove = new Set<number>();
  // Collect task removals as { playlistIndex, taskIndex }
  const tasksToRemove: Array<{ pi: number; ti: number }> = [];

  for (const pick of picks) {
    if (pick.itemType === 'playlist') {
      playlistsToRemove.add(pick.playlistIndex);
    } else if (pick.itemType === 'task' && pick.taskIndex !== undefined) {
      // Only remove individual tasks if their parent playlist isn't being removed
      if (!playlistsToRemove.has(pick.playlistIndex)) {
        tasksToRemove.push({ pi: pick.playlistIndex, ti: pick.taskIndex });
      }
    }
  }

  // Remove tasks first (iterate in reverse to keep indices stable)
  tasksToRemove
    .sort((a, b) => b.ti - a.ti || b.pi - a.pi)
    .forEach(({ pi, ti }) => {
      currentPlan!.playlists[pi].tasks.splice(ti, 1);
    });

  // Remove whole playlists (iterate in reverse)
  [...playlistsToRemove]
    .sort((a, b) => b - a)
    .forEach(pi => {
      currentPlan!.playlists.splice(pi, 1);
    });

  saveAndRefresh();
  vscode.window.showInformationMessage(`Deleted ${picks.length} item${picks.length > 1 ? 's' : ''}.`);
}

async function cmdClearAllTasks(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  const totalTasks = currentPlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  if (totalTasks === 0 && currentPlan.playlists.length === 0) {
    vscode.window.showInformationMessage('Plan is already empty.');
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(clear-all) Clear all tasks', description: 'Remove all tasks but keep playlists', value: 'tasks' },
      { label: '$(trash) Clear entire plan', description: 'Remove all playlists and tasks', value: 'all' },
    ],
    { placeHolder: `Plan has ${currentPlan.playlists.length} playlist(s) with ${totalTasks} total task(s)` },
  );
  if (!choice) { return; }

  const confirm = await vscode.window.showWarningMessage(
    choice.value === 'all'
      ? `Remove all ${currentPlan.playlists.length} playlists and ${totalTasks} tasks?`
      : `Remove all ${totalTasks} tasks from ${currentPlan.playlists.length} playlists?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  if (choice.value === 'all') {
    currentPlan.playlists = [];
  } else {
    for (const pl of currentPlan.playlists) {
      pl.tasks = [];
    }
  }

  saveAndRefresh();
  vscode.window.showInformationMessage(
    choice.value === 'all' ? 'Plan cleared.' : `Cleared ${totalTasks} tasks.`,
  );
}

async function cmdRetryTask(item?: PlanTreeItem | TaskLocation): Promise<void> {
  if (!currentPlan) { return; }

  let playlistIndex: number;
  let taskIndex: number;

  if (item instanceof PlanTreeItem && item.kind === 'task' && item.taskIndex !== undefined) {
    playlistIndex = item.playlistIndex;
    taskIndex = item.taskIndex;
  } else if (isTaskLocation(item)) {
    playlistIndex = item.playlistIndex;
    taskIndex = item.taskIndex;
  } else {
    return;
  }

  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Runner is busy. Stop it first before retrying.');
    return;
  }

  const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
  if (!task) { return; }
  if (task.status !== TaskStatus.Failed && task.status !== TaskStatus.Blocked) {
    vscode.window.showInformationMessage('Only failed or blocked tasks can be retried.');
    return;
  }

  // Reset just this task
  task.status = TaskStatus.Pending;
  saveAndRefresh();

  if (!await preflightEngineCheck(currentPlan, playlistIndex, taskIndex)) {
    return;
  }

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  initializeSingleTaskExecution();
  runner.playTask(currentPlan, playlistIndex, taskIndex).catch(err => {
    UserMsg.showError(UserMsg.retryFailed(err instanceof Error ? err.message : String(err)));
  });
}

async function cmdRetryTaskWithNote(item?: PlanTreeItem | TaskLocation): Promise<void> {
  if (!currentPlan) { return; }
  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Runner is busy. Stop it first before retrying.');
    return;
  }

  let playlistIndex: number;
  let taskIndex: number;
  if (item instanceof PlanTreeItem && item.kind === 'task' && item.taskIndex !== undefined) {
    playlistIndex = item.playlistIndex;
    taskIndex = item.taskIndex;
  } else if (isTaskLocation(item)) {
    playlistIndex = item.playlistIndex;
    taskIndex = item.taskIndex;
  } else {
    return;
  }

  const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
  if (!task) { return; }
  if (task.status !== TaskStatus.Failed && task.status !== TaskStatus.Blocked) {
    vscode.window.showInformationMessage('Only failed or blocked tasks can be retried with a note.');
    return;
  }

  // Extract the meaningful error from history to auto-build a repair prompt
  const entries = historyStore.getForTask(task.id);
  const latest = entries[0];
  const noisePatterns = [
    /^reading prompt from stdin/i,
    /^─+\s*(command|response)\s*─+/i,
    /^github copilot/i,
    /^claude code/i,
    /^── /,
  ];
  const extractError = (text: string): string => {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const meaningful = lines.filter(l => !noisePatterns.some(p => p.test(l)));
    return meaningful.slice(0, 15).join('\n');
  };

  let autoNote = '';
  if (latest) {
    const errText = extractError([latest.result.stderr, latest.result.stdout].filter(Boolean).join('\n'));
    if (errText) {
      autoNote = `[AUTO-FIX] Previous attempt failed with:\n${errText}\n\nAnalyze this error carefully and fix the root cause. Do not repeat the same approach.`;
    }
  }

  // Show the auto-generated note in the input so the user can refine it, but pre-fill it
  const note = await vscode.window.showInputBox({
    prompt: `Fix "${task.name}" — review or edit the repair instruction`,
    value: autoNote || '',
    placeHolder: autoNote ? '' : 'Describe what should change on the retry',
    ignoreFocusOut: true,
  });
  if (note === undefined) { return; }

  const noteBlock = note || autoNote;
  if (!noteBlock) { return; }
  if (task.ownerNote) {
    task.ownerNote = `${task.ownerNote}\n\n${noteBlock}`;
  } else {
    task.ownerNote = noteBlock;
  }
  task.status = TaskStatus.Pending;
  saveAndRefresh();

  if (!await preflightEngineCheck(currentPlan, playlistIndex, taskIndex)) {
    return;
  }

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  initializeSingleTaskExecution();
  runner.playTask(currentPlan, playlistIndex, taskIndex).catch(err => {
    UserMsg.showError(UserMsg.retryFailed(err instanceof Error ? err.message : String(err)));
  });
}

function cmdMoveUp(item?: PlanTreeItem): void {
  if (!currentPlan || !item) { return; }

  if (item.kind === 'playlist' && item.playlistIndex > 0) {
    const arr = currentPlan.playlists;
    [arr[item.playlistIndex - 1], arr[item.playlistIndex]] = [arr[item.playlistIndex], arr[item.playlistIndex - 1]];
  } else if (item.kind === 'task' && item.taskIndex !== undefined && item.taskIndex > 0) {
    const arr = currentPlan.playlists[item.playlistIndex].tasks;
    [arr[item.taskIndex - 1], arr[item.taskIndex]] = [arr[item.taskIndex], arr[item.taskIndex - 1]];
  }
  saveAndRefresh();
}

function cmdMoveDown(item?: PlanTreeItem): void {
  if (!currentPlan || !item) { return; }

  if (item.kind === 'playlist' && item.playlistIndex < currentPlan.playlists.length - 1) {
    const arr = currentPlan.playlists;
    [arr[item.playlistIndex], arr[item.playlistIndex + 1]] = [arr[item.playlistIndex + 1], arr[item.playlistIndex]];
  } else if (item.kind === 'task' && item.taskIndex !== undefined) {
    const arr = currentPlan.playlists[item.playlistIndex].tasks;
    if (item.taskIndex < arr.length - 1) {
      [arr[item.taskIndex], arr[item.taskIndex + 1]] = [arr[item.taskIndex + 1], arr[item.taskIndex]];
    }
  }
  saveAndRefresh();
}

function cmdShowHistory(entry?: unknown): void {
  if (entry && typeof entry === 'object' && 'result' in entry) {
    ExecutionDetailPanel.show(entry as HistoryEntry, historyStore, runSessionStore);
    return;
  }
  ExecutionDetailPanel.showEmpty(historyStore, runSessionStore);
}

function cmdShowThreadList(): void {
  ExecutionDetailPanel.showEmpty(historyStore, runSessionStore);
}

function cmdShowDashboard(): void {
  ensureDashboardOpen();
}

/** Open the Dashboard panel if it isn't already open */
function ensureDashboardOpen(): void {
  const panel = DashboardPanel.createOrShow(
    vscode.Uri.file(''),
    runner,
    historyStore,
    () => getActivePlan(),
    () => saveAndRefresh(),
    () => getPromptEngineOptions(detectedPromptEngines),
    () => getPreferredPromptEngine(detectedPromptEngines),
    async (prompt: string, engineId?: string) => {
      return runPromptSubmission(prompt, isEngineId(engineId) ? engineId : undefined);
    },
    async (prompt: string) => {
      return generatePlanFromDashboardPrompt(prompt);
    },
  );
  // Force a delayed update to ensure the webview receives the plan
  // even if the webview-ready handshake is slow
  for (const delay of [200, 600, 1500]) {
    setTimeout(() => panel.update(), delay);
  }
}

function cmdClearHistory(): void {
  historyStore.clear();
  vscode.window.showInformationMessage('History cleared.');
}

async function cmdSwitchEngine(): Promise<void> {
  if (!currentPlan) { return; }
  const engines: Array<{ label: string; id: string }> = [
    { label: 'Claude Code', id: 'claude' },
    { label: 'Codex CLI', id: 'codex' },
    { label: 'Gemini CLI', id: 'gemini' },
    { label: 'Ollama (local)', id: 'ollama' },
  ];
  const current = currentPlan.defaultEngine;
  const items = engines.map(e => ({
    label: e.label + (e.id === current ? ' (current)' : ''),
    description: e.id,
    id: e.id,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Switch default engine for this plan',
  });
  if (!pick || pick.id === current) { return; }
  currentPlan.defaultEngine = pick.id as import('./models/types').EngineId;
  if (currentPlanPath) {
    savePlan(currentPlan, currentPlanPath);
  }
  planTree.refresh();
  scheduleDashboardUpdate();
  vscode.window.showInformationMessage(`Engine switched to ${pick.label.replace(' (current)', '')}.`);
}

function isPlaylistLikeItem(item: unknown): item is { kind?: string; playlistIndex: number } {
  if (!item || typeof item !== 'object') { return false; }
  const candidate = item as { playlistIndex?: unknown };
  return typeof candidate.playlistIndex === 'number';
}

function isTaskLikeItem(item: unknown): item is { kind?: string; playlistIndex: number; taskIndex: number } {
  if (!item || typeof item !== 'object') { return false; }
  const candidate = item as { playlistIndex?: unknown; taskIndex?: unknown };
  return typeof candidate.playlistIndex === 'number' && typeof candidate.taskIndex === 'number';
}

async function cmdPlayPlaylist(item?: PlanTreeItem | { kind?: string; playlistIndex: number }): Promise<void> {
  const activePlan = getActivePlan();
  if (!activePlan) {
    vscode.window.showWarningMessage('No plan loaded. Open or create a plan first.');
    return;
  }
  if (!item || !isPlaylistLikeItem(item)) {
    vscode.window.showWarningMessage('Could not run playlist: invalid selection payload.');
    return;
  }
  if (item.kind && item.kind !== 'playlist') {
    vscode.window.showWarningMessage('Could not run playlist: selected item is not a playlist.');
    return;
  }
  if (item.playlistIndex < 0 || item.playlistIndex >= activePlan.playlists.length) {
    vscode.window.showWarningMessage('Could not run playlist: playlist index is out of range.');
    return;
  }

  if (!await preflightEngineCheck(activePlan, item.playlistIndex)) {
    return;
  }

  // Only reset tasks in this specific playlist, not the entire plan
  const playlist = activePlan.playlists[item.playlistIndex];
  const hasProgress = playlist.tasks.some(t => t.status !== TaskStatus.Pending);
  if (hasProgress) {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(debug-continue) Resume', description: 'Skip completed tasks in this playlist', value: 'resume' },
        { label: '$(debug-restart) Restart', description: 'Reset all tasks in this playlist', value: 'restart' },
      ],
      { placeHolder: `Playlist "${playlist.name}" has progress from a previous run` },
    );
    if (!action) { return; }
    if (action.value === 'restart') {
      for (const t of playlist.tasks) { t.status = TaskStatus.Pending; }
    }
  } else {
    for (const t of playlist.tasks) { t.status = TaskStatus.Pending; }
  }

  saveAndRefresh();
  DashboardPanel.currentPanel?.clearTimeline();
  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  initializeMultiTaskExecution(playlist.tasks.length);
  runner.playPlaylist(activePlan, item.playlistIndex).catch(err => {
    UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
  });
}

async function cmdPlayTask(item?: PlanTreeItem | { kind?: string; playlistIndex: number; taskIndex: number }): Promise<void> {
  const activePlan = getActivePlan();
  if (!activePlan) {
    vscode.window.showWarningMessage('No plan loaded. Open or create a plan first.');
    return;
  }
  if (!item || !isTaskLikeItem(item)) {
    vscode.window.showWarningMessage('Could not run task: invalid selection payload.');
    return;
  }
  if (item.kind && item.kind !== 'task') {
    vscode.window.showWarningMessage('Could not run task: selected item is not a task.');
    return;
  }
  if (item.playlistIndex < 0 || item.playlistIndex >= activePlan.playlists.length) {
    vscode.window.showWarningMessage('Could not run task: playlist index is out of range.');
    return;
  }
  if (item.taskIndex < 0 || item.taskIndex >= activePlan.playlists[item.playlistIndex].tasks.length) {
    vscode.window.showWarningMessage('Could not run task: task index is out of range.');
    return;
  }

  if (!await preflightEngineCheck(activePlan, item.playlistIndex, item.taskIndex)) {
    return;
  }

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  initializeSingleTaskExecution();
  runner.playTask(activePlan, item.playlistIndex, item.taskIndex).catch(err => {
    vscode.window.showErrorMessage(`Task failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function cmdRunSelected(item?: PlanTreeItem, selectedItems?: PlanTreeItem[]): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  // VS Code passes (clickedItem, allSelectedItems) for multi-select commands
  const items = selectedItems && selectedItems.length > 1 ? selectedItems : item ? [item] : [];
  if (items.length === 0) { return; }

  // Build a list of tasks to run from the selection
  const taskList: Array<{ playlistIndex: number; taskIndex: number }> = [];
  const seen = new Set<string>();

  for (const sel of items) {
    if (sel.kind === 'playlist') {
      // Add all tasks from this playlist
      const playlist = currentPlan.playlists[sel.playlistIndex];
      if (!playlist) { continue; }
      for (let ti = 0; ti < playlist.tasks.length; ti++) {
        const key = `${sel.playlistIndex}:${ti}`;
        if (!seen.has(key)) {
          seen.add(key);
          taskList.push({ playlistIndex: sel.playlistIndex, taskIndex: ti });
        }
      }
    } else if (sel.kind === 'task' && sel.taskIndex !== undefined) {
      const key = `${sel.playlistIndex}:${sel.taskIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        taskList.push({ playlistIndex: sel.playlistIndex, taskIndex: sel.taskIndex });
      }
    }
  }

  if (taskList.length === 0) { return; }

  const selectedEngines = new Set<EngineId>();
  for (const { playlistIndex, taskIndex } of taskList) {
    const playlist = currentPlan.playlists[playlistIndex];
    const task = playlist?.tasks[taskIndex];
    if (!playlist || !task || getTaskType(task) !== 'agent') {
      continue;
    }
    selectedEngines.add(task.engine ?? playlist.engine ?? currentPlan.defaultEngine);
  }
  if (selectedEngines.size > 0) {
    const availability = await checkEngineAvailability([...selectedEngines]);
    const missing: Array<{ command: string; displayName: string }> = [];
    for (const [, info] of availability) {
      if (!info.available) {
        missing.push({ command: info.command, displayName: info.displayName });
      }
    }
    if (missing.length > 0) {
      const engineList = missing
        .map(m => m.command
          ? `"${m.displayName}" (command: ${m.command})`
          : `"${m.displayName}" (not configured)`)
        .join(', ');
      const msg = missing.length === 1
        ? `Engine ${engineList} was not found on your system.`
        : `Engines ${engineList} were not found on your system.`;
      const action = await vscode.window.showWarningMessage(
        msg,
        'Run Anyway',
        'Open Settings',
      );
      if (action === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'agentTaskPlayer.engines');
        return;
      }
      if (action !== 'Run Anyway') {
        return;
      }
    }
  }

  // Reset selected tasks to pending
  for (const { playlistIndex, taskIndex } of taskList) {
    const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
    if (task) { task.status = TaskStatus.Pending; }
  }
  saveAndRefresh();

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  DashboardPanel.currentPanel?.clearTimeline();
  initializeMultiTaskExecution(taskList.length);
  runner.playTasks(currentPlan, taskList).catch(err => {
    UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
  });
}

async function cmdAddTaskFromTemplate(playlistIndexOrItem?: unknown): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  // Resolve playlist index
  let playlistIndex: number;
  if (playlistIndexOrItem instanceof PlanTreeItem) {
    playlistIndex = playlistIndexOrItem.playlistIndex;
  } else if (typeof playlistIndexOrItem === 'number') {
    playlistIndex = playlistIndexOrItem;
  } else if (currentPlan.playlists.length === 1) {
    playlistIndex = 0;
  } else if (currentPlan.playlists.length === 0) {
    vscode.window.showWarningMessage('Add a playlist first.');
    return;
  } else {
    const items = currentPlan.playlists.map((pl, i) => ({ label: pl.name, index: i }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select playlist' });
    if (!picked) { return; }
    playlistIndex = picked.index;
  }

  // Show templates grouped by category
  const templates = templateStore.getAll();
  const items = templates.map(t => ({
    label: t.name,
    description: t.category,
    detail: t.prompt.substring(0, 100),
    template: t,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a template',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) { return; }

  const t = picked.template;
  const task = createTask(t.name, t.prompt, t.engine as EngineId | undefined);
  task.type = (t.type as TaskType | undefined) ?? 'agent';
  task.command = t.command;
  task.env = t.env;
  task.files = t.files;
  task.acceptanceCriteria = t.acceptanceCriteria;
  task.verifyCommand = t.verifyCommand;
  task.expectedArtifacts = t.expectedArtifacts;
  task.ownerNote = t.ownerNote;
  task.failurePolicy = t.failurePolicy as FailurePolicy | undefined;
  task.port = t.port;
  task.readyPattern = t.readyPattern;
  task.healthCheckUrl = t.healthCheckUrl;
  task.startupTimeoutMs = t.startupTimeoutMs;
  task.retryCount = t.retryCount;
  currentPlan.playlists[playlistIndex].tasks.push(task);
  saveAndRefresh();
}

async function cmdSaveTaskAsTemplate(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }

  const task = currentPlan.playlists[item.playlistIndex]?.tasks[item.taskIndex];
  if (!task) { return; }

  const category = await vscode.window.showInputBox({
    prompt: 'Template category',
    placeHolder: 'e.g., Setup, Feature, Testing, Bugfix',
    value: 'Custom',
  });
  if (!category) { return; }

  await templateStore.add({
    id: generateId(),
    name: task.name,
    prompt: task.prompt,
    type: getTaskType(task),
    engine: task.engine,
    command: task.command,
    env: task.env,
    files: task.files,
    acceptanceCriteria: task.acceptanceCriteria,
    verifyCommand: task.verifyCommand,
    expectedArtifacts: task.expectedArtifacts,
    ownerNote: task.ownerNote,
    failurePolicy: task.failurePolicy,
    port: task.port,
    readyPattern: task.readyPattern,
    healthCheckUrl: task.healthCheckUrl,
    startupTimeoutMs: task.startupTimeoutMs,
    retryCount: task.retryCount,
    category,
  });
  vscode.window.showInformationMessage(`Template "${task.name}" saved.`);
}

// ─── Quick Run: load + play in one shot, zero interaction ───

async function cmdRunPlanFile(fileUri?: vscode.Uri): Promise<void> {
  // If called from explorer context menu or command palette with a URI
  let planPath: string;

  if (fileUri) {
    planPath = fileUri.fsPath;
  } else {
    // Open file picker
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { 'Agent Plan': ['agent-plan.json', 'json'] },
      title: 'Select Plan File to Run',
    });
    if (!uris || uris.length === 0) { return; }
    planPath = uris[0].fsPath;
  }

  try {
    const plan = loadPlan(planPath);
    setVisiblePlan(plan, planPath);
  } catch (err) {
    UserMsg.showError(UserMsg.planLoadError(err instanceof Error ? err.message : String(err)));
    return;
  }

  const plan = getActivePlan();
  if (!plan) {
    return;
  }

  // Pre-flight
  if (!await preflightEngineCheck(plan)) {
    return;
  }

  // Check if the plan file has tasks with existing progress (completed/failed)
  const hasProgress = plan.playlists.some(pl =>
    pl.tasks.some(t => t.status !== TaskStatus.Pending),
  );
  if (hasProgress) {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(debug-continue) Resume', description: 'Continue from where it left off (skip completed tasks)', value: 'resume' },
        { label: '$(debug-restart) Restart', description: 'Reset all tasks and start over', value: 'restart' },
      ],
      { placeHolder: 'Plan has progress from a previous run' },
    );
    if (!action) { return; }
    if (action.value === 'restart') {
      runner.resetPlan(plan);
      DashboardPanel.currentPanel?.clearTimeline();
    }
  } else {
    runner.resetPlan(plan);
    DashboardPanel.currentPanel?.clearTimeline();
  }

  // Initialize progress counters
  initializeMultiTaskExecution(plan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0));

  saveAndRefresh();

  vscode.window.setStatusBarMessage(
    `$(rocket) Running plan "${plan.name}" (${executionTaskCount} tasks)...`,
    5000,
  );

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  runner.play(plan).catch(err => {
    UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
  });
}

// ─── Plan Import / Export ───

async function cmdExportPlan(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Export to file', description: 'Save as a new .agent-plan.json file' },
      { label: 'Copy to clipboard', description: 'Copy plan JSON to clipboard for sharing' },
    ],
    { placeHolder: 'How do you want to export the plan?' },
  );
  if (!choice) { return; }

  const planFile = dehydratePlan(currentPlan);
  const json = JSON.stringify(planFile, null, 2);

  if (choice.label === 'Copy to clipboard') {
    await vscode.env.clipboard.writeText(json);
    vscode.window.showInformationMessage('Plan copied to clipboard.');
    return;
  }

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${currentPlan.name.toLowerCase().replace(/\s+/g, '-')}.agent-plan.json`),
    filters: { 'Agent Plan': ['agent-plan.json', 'json'] },
    title: 'Export Plan',
  });
  if (!uri) { return; }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
  vscode.window.showInformationMessage(`Plan exported to ${uri.fsPath}`);
}

async function cmdSharePlan(): Promise<void> {
  const plan = getActivePlan();
  if (!plan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  // Dehydrate and strip all statuses to create a clean template
  const planFile = dehydratePlan(plan);
  for (const pl of planFile.playlists) {
    for (const t of pl.tasks) {
      delete (t as any).status;
    }
  }

  const fileName = `${plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`;
  const json = JSON.stringify(planFile, null, 2);

  // Check if gh CLI is available
  const ghAvailable = await commandExists('gh');

  if (ghAvailable) {
    try {
      const { execSync } = require('child_process') as typeof import('child_process');
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();

      const result = execSync(`gh gist create --public -f "${fileName}" -`, {
        input: json,
        cwd,
        timeout: 30000,
        encoding: 'utf-8',
      });

      const gistUrl = result.trim().split('\n').pop() || '';
      if (!gistUrl) {
        vscode.window.showErrorMessage('Failed to parse gist URL from gh output.');
        return;
      }

      const action = await vscode.window.showInformationMessage(
        `Plan shared: ${gistUrl}`,
        'Open',
        'Copy URL',
      );
      if (action === 'Open') {
        vscode.env.openExternal(vscode.Uri.parse(gistUrl));
      } else if (action === 'Copy URL') {
        await vscode.env.clipboard.writeText(gistUrl);
        vscode.window.showInformationMessage('Gist URL copied to clipboard.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to create gist: ${msg.substring(0, 200)}`);
    }
  } else {
    // Fallback: copy to clipboard
    await vscode.env.clipboard.writeText(json);
    vscode.window.showInformationMessage(
      'Plan copied to clipboard (gh CLI not found). Paste it into a GitHub Gist or share directly.',
    );
  }
}

async function cmdImportPlanFromUrl(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return;
  }

  const url = await vscode.window.showInputBox({
    prompt: 'Plan URL (GitHub Gist, raw file URL, or any .json URL)',
    placeHolder: 'https://gist.github.com/user/abc123 or https://raw.githubusercontent.com/...',
    validateInput: (val) => {
      if (!val.trim()) { return 'URL is required'; }
      try {
        const parsed = new URL(val.trim());
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return 'URL must start with https:// or http://';
        }
        return null;
      } catch {
        return 'Invalid URL';
      }
    },
  });
  if (!url) { return; }

  const trimmedUrl = url.trim();
  let jsonText: string;

  try {
    jsonText = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Fetching plan...' },
      async () => {
        // Detect GitHub Gist URL: gist.github.com/<user>/<id> or gist.github.com/<id>
        const gistMatch = trimmedUrl.match(/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)/i);
        if (gistMatch) {
          const gistId = gistMatch[1];
          // Try gh CLI first (handles private gists)
          const ghAvailable = await commandExists('gh');
          if (ghAvailable) {
            try {
              const { execSync } = require('child_process') as typeof import('child_process');
              const result = execSync(`gh gist view ${gistId} --raw`, {
                cwd: workspaceFolder.uri.fsPath,
                timeout: 30000,
                encoding: 'utf-8',
              });
              return result;
            } catch {
              // Fall through to HTTPS fetch
            }
          }
          // Fetch via GitHub API
          return fetchUrl(`https://api.github.com/gists/${gistId}`, true);
        }

        // Any other URL: fetch directly
        return fetchUrl(trimmedUrl, false);
      },
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to fetch plan: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Parse and validate
  let plan: Plan;
  try {
    plan = loadPlanFromJson(jsonText);
  } catch (err) {
    vscode.window.showErrorMessage(`Invalid plan: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Save to workspace
  currentPlan = plan;
  currentPlanPath = getNewPlanSavePath() || path.join(
    workspaceFolder.uri.fsPath,
    `${plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`,
  );
  saveAndRefresh();

  const totalTasks = plan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  vscode.window.showInformationMessage(
    `Imported "${plan.name}" — ${totalTasks} task${totalTasks !== 1 ? 's' : ''} across ${plan.playlists.length} playlist${plan.playlists.length !== 1 ? 's' : ''}.`,
  );
}

/** Fetch a URL via Node's built-in https/http module. If isGistApi, extract the first file's content. */
function fetchUrl(url: string, isGistApi: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') as typeof import('https') : require('http') as typeof import('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'MOAG-VSCode', Accept: 'application/json' } }, (res) => {
      // Follow redirects (301, 302, 307, 308)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, isGistApi).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        if (isGistApi) {
          try {
            const gist = JSON.parse(body);
            const files = gist.files;
            if (!files || Object.keys(files).length === 0) {
              reject(new Error('Gist has no files.'));
              return;
            }
            // Pick the first .json file, or the first file
            const jsonFile = Object.values(files).find((f: any) => f.filename?.endsWith('.json')) as any;
            const firstFile = jsonFile || Object.values(files)[0] as any;
            resolve(firstFile.content);
          } catch {
            reject(new Error('Failed to parse Gist API response.'));
          }
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function cmdImportPlan(): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Import from file', description: 'Load a .agent-plan.json file' },
      { label: 'Import from clipboard', description: 'Paste plan JSON from clipboard' },
    ],
    { placeHolder: 'Where do you want to import from?' },
  );
  if (!choice) { return; }

  let plan: Plan;

  if (choice.label === 'Import from clipboard') {
    const text = await vscode.env.clipboard.readText();
    if (!text.trim()) {
      vscode.window.showWarningMessage('Clipboard is empty.');
      return;
    }
    try {
      plan = loadPlanFromJson(text);
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : `Invalid plan JSON: ${err}`);
      return;
    }
  } else {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { 'Agent Plan': ['agent-plan.json', 'json'] },
      title: 'Import Plan',
    });
    if (!uris || uris.length === 0) { return; }

    try {
      plan = loadPlan(uris[0].fsPath);
    } catch (err) {
      UserMsg.showError(UserMsg.planLoadError(err instanceof Error ? err.message : String(err)));
      return;
    }
  }

  // Ask where to save the imported plan
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return;
  }

  currentPlan = plan;
  currentPlanPath = getNewPlanSavePath() || path.join(
    workspaceFolder.uri.fsPath,
    `${plan.name.toLowerCase().replace(/\s+/g, '-')}.agent-plan.json`,
  );
  saveAndRefresh();
  vscode.window.showInformationMessage(`Imported plan: ${plan.name}`);
}

/** Parse a JSON string into a Plan (hydrates status fields) */
function loadPlanFromJson(json: string): Plan {
  if (!json.trim()) {
    throw new Error('The pasted text is empty — expected a valid agent plan JSON.');
  }
  let file;
  try {
    file = JSON.parse(json);
  } catch {
    throw new Error('The pasted text is not valid JSON. Check for syntax errors.');
  }
  if (!file || typeof file !== 'object') {
    throw new Error('Expected a JSON object, got ' + typeof file + '.');
  }
  if (!file.version || !file.name || !Array.isArray(file.playlists)) {
    throw new Error('Missing required fields: a plan needs "version", "name", and "playlists".');
  }
  return hydratePlan(file);
}

// ─── Cost / Token Summary ───

function cmdShowCostSummary(): void {
  const entries = historyStore.getAll();
  if (entries.length === 0) {
    vscode.window.showInformationMessage('No execution history yet.');
    return;
  }

  // Aggregate stats by engine
  const stats = new Map<string, { runs: number; totalMs: number; inputTokens: number; outputTokens: number; totalTokens: number; cost: number }>();

  for (const entry of entries) {
    let s = stats.get(entry.engine);
    if (!s) {
      s = { runs: 0, totalMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
      stats.set(entry.engine, s);
    }
    s.runs++;
    s.totalMs += entry.result.durationMs;
    const usage = entry.result.tokenUsage;
    if (usage) {
      s.inputTokens += usage.inputTokens ?? 0;
      s.outputTokens += usage.outputTokens ?? 0;
      s.totalTokens += usage.totalTokens ?? 0;
      s.cost += usage.estimatedCost ?? 0;
    }
  }

  // Build summary document
  let doc = `# Cost & Usage Summary\n\n`;
  doc += `**Total Runs:** ${entries.length}\n\n`;

  let grandTotalMs = 0;
  let grandTotalTokens = 0;
  let grandTotalCost = 0;

  doc += `| Engine | Runs | Total Time | Tokens (In/Out/Total) | Est. Cost |\n`;
  doc += `|--------|------|------------|----------------------|----------|\n`;

  for (const [engine, s] of stats) {
    grandTotalMs += s.totalMs;
    grandTotalTokens += s.totalTokens;
    grandTotalCost += s.cost;
    const time = formatDuration(s.totalMs);
    const tokens = s.totalTokens > 0 ? `${s.inputTokens} / ${s.outputTokens} / ${s.totalTokens}` : 'N/A';
    const cost = s.cost > 0 ? `$${s.cost.toFixed(4)}` : 'N/A';
    doc += `| ${engine} | ${s.runs} | ${time} | ${tokens} | ${cost} |\n`;
  }

  doc += `\n**Grand Total:** ${formatDuration(grandTotalMs)}`;
  if (grandTotalTokens > 0) { doc += ` | ${grandTotalTokens} tokens`; }
  if (grandTotalCost > 0) { doc += ` | $${grandTotalCost.toFixed(4)}`; }
  doc += `\n\n---\n\n`;

  // Recent entries detail
  doc += `## Recent Executions (last 20)\n\n`;
  doc += `| Task | Engine | Duration | Tokens | Cost | Status |\n`;
  doc += `|------|--------|----------|--------|------|--------|\n`;

  for (const e of entries.slice(0, 20)) {
    const time = formatDuration(e.result.durationMs);
    const usage = e.result.tokenUsage;
    const tokens = usage?.totalTokens ? String(usage.totalTokens) : '-';
    const cost = usage?.estimatedCost ? `$${usage.estimatedCost.toFixed(4)}` : '-';
    const status = e.status === 'completed' ? 'Pass' : 'Fail';
    doc += `| ${e.taskName} | ${e.engine} | ${time} | ${tokens} | ${cost} | ${status} |\n`;
  }

  vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
    .then(d => vscode.window.showTextDocument(d, { preview: true }));
}

async function cmdDryRun(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  const engineIds = collectEngineIds(currentPlan);
  const availability = await checkEngineAvailability(engineIds);

  let doc = `# Dry Run Preview: ${currentPlan.name}\n\n`;
  doc += `**Playlists:** ${currentPlan.playlists.length}\n`;
  const totalTasks = currentPlan.playlists.reduce((s, pl) => s + pl.tasks.length, 0);
  doc += `**Total Tasks:** ${totalTasks}\n`;
  doc += `**Default Engine:** ${currentPlan.defaultEngine}\n\n`;

  // Engine availability
  doc += '## Engine Availability\n\n';
  doc += '| Engine | Available | Command | Version |\n';
  doc += '|--------|-----------|---------|--------|\n';
  for (const [id, info] of availability) {
    const status = info.available ? 'Yes' : 'NO';
    doc += `| ${info.displayName} | ${status} | \`${info.command}\` | ${info.version || '-'} |\n`;
  }

  const missing = [...availability.values()].filter(a => !a.available);
  if (missing.length > 0) {
    doc += `\n> **Warning:** ${missing.length} engine(s) not found. Tasks using these engines will fail.\n`;
  }

  // Task execution plan
  doc += '\n## Execution Plan\n\n';
  for (const pl of currentPlan.playlists) {
    const mode = pl.parallel ? '(parallel)' : '(sequential)';
    doc += `### ${pl.name} ${mode}\n\n`;
    doc += '| # | Task | Type | Runtime | Verify | Artifacts | Dependencies |\n';
    doc += '|---|------|------|---------|--------|-----------|-------------|\n';
    pl.tasks.forEach((t, i) => {
      const type = getTaskType(t);
      const runtime = type === 'agent'
        ? (t.engine ?? pl.engine ?? currentPlan!.defaultEngine)
        : (t.command ?? '-');
      const verify = t.verifyCommand ? `\`${t.verifyCommand}\`` : '-';
      const artifacts = t.expectedArtifacts?.length ? t.expectedArtifacts.join(', ') : '-';
      const deps = t.dependsOn?.length ? t.dependsOn.join(', ') : '-';
      doc += `| ${i + 1} | ${t.name} | ${type} | ${runtime} | ${verify} | ${artifacts} | ${deps} |\n`;
    });
    doc += '\n';

    doc += '<details><summary>Task Contracts</summary>\n\n';
    for (const t of pl.tasks) {
      doc += `**${t.name}** (${getTaskType(t)})\n\n`;
      if (t.prompt) {
        doc += `Prompt:\n\`\`\`\n${t.prompt.substring(0, 500)}${t.prompt.length > 500 ? '\n...' : ''}\n\`\`\`\n\n`;
      }
      if (t.command) {
        doc += `Command: \`${t.command}\`\n\n`;
      }
      if (t.acceptanceCriteria?.length) {
        doc += `Acceptance criteria:\n${t.acceptanceCriteria.map(item => `- ${item}`).join('\n')}\n\n`;
      }
      if (t.ownerNote) {
        doc += `Owner note: ${t.ownerNote}\n\n`;
      }
    }
    doc += '</details>\n\n';
  }

  // Concurrency settings
  const concurrency = vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('parallelPlaylists', 1);
  const timeout = vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('taskTimeoutMs', 600000);
  doc += '## Settings\n\n';
  doc += `- **Parallel Playlists:** ${concurrency}\n`;
  doc += `- **Task Timeout:** ${formatDuration(timeout)}\n`;
  doc += `- **Autoplay Delay:** ${vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('autoplayDelay', 500)}ms\n`;

  await vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
    .then(d => vscode.window.showTextDocument(d, { preview: true }));
}

async function cmdExportResults(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  const entries = historyStore.getAll();
  if (entries.length === 0) {
    vscode.window.showWarningMessage('No execution history to export.');
    return;
  }

  const format = await vscode.window.showQuickPick(
    [
      { label: '$(markdown) Markdown Report', value: 'markdown' },
      { label: '$(json) JSON Data', value: 'json' },
      { label: '$(clippy) Copy to Clipboard (Markdown)', value: 'clipboard' },
    ],
    { placeHolder: 'Export format' },
  );
  if (!format) { return; }

  // Gather results for the current plan's tasks
  const planTaskIds = new Set(currentPlan.playlists.flatMap(pl => pl.tasks.map(t => t.id)));
  const planEntries = entries.filter(e => planTaskIds.has(e.taskId));

  if (format.value === 'json') {
    const data = {
      plan: currentPlan.name,
      exportedAt: new Date().toISOString(),
      summary: {
        total: planEntries.length,
        passed: planEntries.filter(e => e.status === 'completed').length,
        failed: planEntries.filter(e => e.status === 'failed').length,
        blocked: planEntries.filter(e => e.status === 'blocked').length,
        totalDurationMs: planEntries.reduce((s, e) => s + e.result.durationMs, 0),
      },
      results: planEntries.map(e => ({
        taskName: e.taskName,
        engine: e.engine,
        taskType: e.taskType,
        status: e.status,
        durationMs: e.result.durationMs,
        exitCode: e.result.exitCode,
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        changedFiles: e.changedFiles,
        verification: e.verification,
        artifacts: e.artifacts,
        summary: e.result.summary,
        tokenUsage: e.result.tokenUsage,
        stdout: e.result.stdout,
        stderr: e.result.stderr,
      })),
    };
    const json = JSON.stringify(data, null, 2);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${currentPlan.name.toLowerCase().replace(/\s+/g, '-')}-results.json`),
      filters: { 'JSON': ['json'] },
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
      vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
    }
    return;
  }

  // Markdown format
  const passed = planEntries.filter(e => e.status === 'completed').length;
  const failed = planEntries.filter(e => e.status === 'failed').length;
  const blocked = planEntries.filter(e => e.status === 'blocked').length;
  const totalMs = planEntries.reduce((s, e) => s + e.result.durationMs, 0);
  const totalFiles = new Set(planEntries.flatMap(e => e.changedFiles ?? [])).size;

  let md = `# Execution Report: ${currentPlan.name}\n\n`;
  md += `**Date:** ${new Date().toLocaleString()}\n`;
  md += `**Results:** ${passed} passed, ${failed} failed, ${blocked} blocked out of ${planEntries.length} tasks\n`;
  md += `**Total Duration:** ${formatDuration(totalMs)}\n`;
  if (totalFiles > 0) { md += `**Files Changed:** ${totalFiles}\n`; }
  md += '\n---\n\n';

  md += '| # | Task | Type | Engine | Status | Duration | Exit Code |\n';
  md += '|---|------|------|--------|--------|----------|-----------|\n';
  planEntries.forEach((e, i) => {
    const status = e.status === 'completed' ? 'Pass' : e.status === 'blocked' ? 'Blocked' : 'Fail';
    md += `| ${i + 1} | ${e.taskName} | ${e.taskType ?? 'agent'} | ${e.engine} | ${status} | ${formatDuration(e.result.durationMs)} | ${e.result.exitCode} |\n`;
  });

  // Add details for failed tasks
  const failedEntries = planEntries.filter(e => e.status !== 'completed');
  if (failedEntries.length > 0) {
    md += '\n## Failed Tasks\n\n';
    for (const e of failedEntries) {
      md += `### ${e.taskName}\n\n`;
      if (e.result.summary) {
        md += `${e.result.summary}\n\n`;
      }
      if (e.verification) {
        md += `Verification: \`${e.verification.command}\` -> ${e.verification.passed ? 'pass' : 'fail'}\n\n`;
      }
      if (e.artifacts?.length) {
        md += `Artifacts:\n${e.artifacts.map(artifact => `- ${artifact.target}: ${artifact.exists ? 'present' : 'missing'}`).join('\n')}\n\n`;
      }
      if (e.result.stderr) {
        md += '```\n' + e.result.stderr.substring(0, 2000) + '\n```\n\n';
      }
    }
  }

  // Changed files summary
  const allFiles = new Set(planEntries.flatMap(e => e.changedFiles ?? []));
  if (allFiles.size > 0) {
    md += '\n## Changed Files\n\n';
    for (const f of allFiles) { md += `- ${f}\n`; }
  }

  if (format.value === 'clipboard') {
    await vscode.env.clipboard.writeText(md);
    vscode.window.showInformationMessage('Results copied to clipboard.');
    return;
  }

  // Save as file
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${currentPlan.name.toLowerCase().replace(/\s+/g, '-')}-results.md`),
    filters: { 'Markdown': ['md'] },
  });
  if (uri) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf-8'));
    vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
  }
}

async function cmdSetTaskStatus(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }

  const task = currentPlan.playlists[item.playlistIndex].tasks[item.taskIndex];
  const picks = [
    { label: '$(circle-outline) Pending', value: TaskStatus.Pending, description: 'Reset — will run on next play' },
    { label: '$(pass) Completed', value: TaskStatus.Completed, description: 'Mark as done — will be skipped' },
    { label: '$(error) Failed', value: TaskStatus.Failed, description: 'Mark as failed' },
    { label: '$(debug-disconnect) Blocked', value: TaskStatus.Blocked, description: 'Mark as blocked for review' },
    { label: '$(debug-step-over) Skipped', value: TaskStatus.Skipped, description: 'Skip — will not run' },
  ];

  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: `Set status for "${task.name}" (currently: ${task.status})`,
  });
  if (!pick) { return; }

  task.status = pick.value;
  saveAndRefresh();
  vscode.window.showInformationMessage(`"${task.name}" → ${pick.value}`);
}

async function cmdSetPlaylistStatus(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'playlist') { return; }

  const playlist = currentPlan.playlists[item.playlistIndex];
  const picks = [
    { label: '$(circle-outline) All Pending', value: TaskStatus.Pending, description: 'Reset all tasks — will run on next play' },
    { label: '$(pass) All Completed', value: TaskStatus.Completed, description: 'Mark all as done — will be skipped' },
    { label: '$(debug-step-over) All Skipped', value: TaskStatus.Skipped, description: 'Skip all tasks in this playlist' },
  ];

  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: `Set status for all ${playlist.tasks.length} tasks in "${playlist.name}"`,
  });
  if (!pick) { return; }

  for (const t of playlist.tasks) {
    t.status = pick.value;
  }
  saveAndRefresh();
  vscode.window.showInformationMessage(`All tasks in "${playlist.name}" → ${pick.value}`);
}

async function cmdUndoTask(treeItem?: PlanTreeItem): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  // Determine which task to undo
  let taskId: string | undefined;
  let taskName: string | undefined;

  if (treeItem && treeItem.contextValue === 'task') {
    // Called from tree view context menu
    taskId = treeItem.id;
    taskName = treeItem.label as string;
  } else {
    // Pick from tasks that have git refs
    const tasks: { id: string; name: string }[] = [];
    for (const pl of currentPlan.playlists) {
      for (const t of pl.tasks) {
        if (runner.getTaskGitRef(t.id)) {
          tasks.push({ id: t.id, name: t.name });
        }
      }
    }
    if (tasks.length === 0) {
      vscode.window.showInformationMessage('No tasks with undo checkpoints available.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      tasks.map(t => ({ label: t.name, taskId: t.id })),
      { placeHolder: 'Select a task to undo' },
    );
    if (!pick) { return; }
    taskId = pick.taskId;
    taskName = pick.label;
  }

  const gitInfo = runner.getTaskGitRef(taskId!);
  if (!gitInfo) {
    vscode.window.showWarningMessage(`No git checkpoint found for task "${taskName}".`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Undo changes from "${taskName}"? This will reset the working tree in ${gitInfo.cwd} to the state before the task ran.`,
    { modal: true },
    'Undo',
  );
  if (confirm !== 'Undo') { return; }

  try {
    const { execFile } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      // Reset working tree to the captured ref
      execFile('git', ['checkout', gitInfo.ref, '--', '.'], { cwd: gitInfo.cwd, timeout: 30000 }, (err) => {
        if (err) { reject(err); return; }
        resolve();
      });
    });
    vscode.window.showInformationMessage(`Undo complete: "${taskName}" changes reverted.`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Undo failed: ${err.message ?? err}`);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  const secs = Math.floor(ms / 1000);
  if (secs < 60) { return `${secs}s`; }
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

// ─── Sessions / thread commands ───

function cmdOpenSession(session?: RunSession): void {
  if (!session) {
    ExecutionDetailPanel.showEmpty(historyStore, runSessionStore);
    return;
  }
  // Find any entry from this run to use as a thread anchor
  const entries = historyStore.getForRun(session.id);
  if (entries.length > 0) {
    ExecutionDetailPanel.show(entries[0], historyStore, runSessionStore);
  } else {
    ExecutionDetailPanel.showEmpty(historyStore, runSessionStore);
  }
}

function cmdOpenThread(entry?: HistoryEntry): void {
  if (entry) {
    ExecutionDetailPanel.show(entry, historyStore, runSessionStore);
  } else {
    ExecutionDetailPanel.showEmpty(historyStore, runSessionStore);
  }
}

async function cmdDeleteSession(item?: SessionsTreeItem): Promise<void> {
  const session = item?.session;
  if (!session) { return; }

  const answer = await vscode.window.showWarningMessage(
    `Delete session "${session.planName}"?`,
    { modal: true },
    'Delete',
  );
  if (answer !== 'Delete') { return; }

  runSessionStore.delete(session.id);
}

async function cmdDeleteThread(item?: SessionsTreeItem): Promise<void> {
  const head = item?.threadHead;
  if (!head) { return; }
  const threadId = head.threadId ?? head.id;

  const answer = await vscode.window.showWarningMessage(
    `Delete conversation "${head.taskName}"?`,
    { modal: true },
    'Delete',
  );
  if (answer !== 'Delete') { return; }

  historyStore.deleteThread(threadId);
}

async function cmdRenameThread(item?: SessionsTreeItem): Promise<void> {
  const head = item?.threadHead;
  if (!head) { return; }
  const threadId = head.threadId ?? head.id;

  const newName = await vscode.window.showInputBox({
    prompt: 'Rename conversation',
    value: head.taskName,
    validateInput: (val) => val.trim() ? null : 'Name cannot be empty',
  });
  if (!newName) { return; }

  // Update the taskName on all entries in this thread
  const thread = historyStore.getThread(threadId);
  for (const entry of thread) {
    (entry as { taskName: string }).taskName = newName.trim();
  }
  // Re-persist by clearing and re-adding (HistoryStore doesn't have an update method)
  // Instead we just refresh the tree since entries are by reference
  sessionsTree.refresh();
  historyTree.refresh();
}

async function cmdSearchSessions(): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: 'Search sessions and conversations',
    placeHolder: 'Type to filter...',
  });
  sessionsTree.setFilter(query ?? '');
}

async function cmdClearSessions(): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    'Clear all run sessions? This cannot be undone.',
    { modal: true },
    'Clear All',
  );
  if (answer !== 'Clear All') { return; }
  runSessionStore.clear();
}

async function cmdNewConversation(): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    prompt: 'Start a new conversation',
    placeHolder: 'Describe what you want to do...',
  });
  if (!prompt?.trim()) { return; }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    UserMsg.showError(UserMsg.noWorkspace());
    return;
  }

  // Pick engine
  const enginePicks: vscode.QuickPickItem[] = [
    { label: 'claude', description: 'Claude Code' },
    { label: 'codex', description: 'Codex (OpenAI)' },
    { label: 'gemini', description: 'Gemini CLI' },
    { label: 'ollama', description: 'Ollama (Local)' },
  ];
  const enginePick = await vscode.window.showQuickPick(enginePicks, {
    placeHolder: 'Select engine for this conversation',
  });
  if (!enginePick) { return; }
  const engineId = enginePick.label as EngineId;

  // Create the conversation entry
  const id = generateId();
  const taskName = prompt.length > 60 ? prompt.substring(0, 57) + '...' : prompt;

  // Run the prompt
  const engine = getEngine(engineId);
  const cwd = workspaceFolder.uri.fsPath;
  const startedAt = new Date().toISOString();

  // Show progress
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Running: ${taskName}`, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());

      try {
        const result = await engine.runTask({
          prompt: prompt.trim(),
          cwd,
          signal: abort.signal,
        });

        const entry: HistoryEntry = {
          id,
          taskId: id,
          taskName,
          playlistId: 'conversation',
          playlistName: 'Conversations',
          engine: engineId,
          prompt: prompt.trim(),
          result,
          status: result.exitCode === 0 ? TaskStatus.Completed : TaskStatus.Failed,
          startedAt,
          finishedAt: new Date().toISOString(),
          threadId: id,
          turnIndex: 0,
        };

        historyStore.add(entry);
        ExecutionDetailPanel.show(entry, historyStore, runSessionStore);
      } catch (err) {
        vscode.window.showErrorMessage(`Conversation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

async function cmdSwitchProfile(): Promise<void> {
  const current = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('executionProfile', 'auto');

  const items = PROFILE_META.map(p => ({
    label: `${p.icon} ${p.label}` + (p.name === current ? ' (current)' : ''),
    description: p.description,
    profileName: p.name,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select execution profile',
  });
  if (!pick || pick.profileName === current) { return; }

  await vscode.workspace.getConfiguration('agentTaskPlayer').update('executionProfile', pick.profileName, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Execution profile: ${pick.profileName}`);
}

async function cmdReviewChanges(): Promise<void> {
  const runId = runner.currentRunId;
  const allEntries = historyStore.getAll();

  // Collect diffs from current run or recent entries
  const entries = runId
    ? allEntries.filter(e => e.runId === runId)
    : allEntries.slice(0, 20);

  const diffs = entries
    .filter(e => e.codeChanges)
    .map(e => `# Task: ${e.taskName} (${e.status})\n${e.codeChanges}`)
    .join('\n\n');

  if (!diffs) {
    vscode.window.showInformationMessage('No code changes were made during this run.');
    return;
  }

  const os = require('os') as typeof import('os');
  const tmpPath = path.join(os.tmpdir(), `moag-review-${runId || 'latest'}.diff`);
  const fs = require('fs') as typeof import('fs');
  fs.writeFileSync(tmpPath, diffs, 'utf-8');

  const doc = await vscode.workspace.openTextDocument(tmpPath);
  await vscode.window.showTextDocument(doc, { preview: true });
}

// ─── Watch Mode ───

function cmdToggleWatchMode(): void {
  if (watchModeActive) {
    disableWatchMode();
    vscode.window.showInformationMessage('Watch mode disabled.');
  } else {
    enableWatchMode();
    vscode.window.showInformationMessage('Watch mode enabled. File changes will trigger re-run suggestions for matching tasks.');
  }
}

function enableWatchMode(): void {
  if (watchModeActive) { return; }
  watchModeActive = true;

  // Create status bar indicator
  if (!watchStatusBarItem) {
    watchStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    watchStatusBarItem.command = 'agentTaskPlayer.watchMode';
  }
  watchStatusBarItem.text = '$(eye) Watch';
  watchStatusBarItem.tooltip = 'MOAG Watch Mode active — click to disable';
  watchStatusBarItem.show();

  // Create file system watcher excluding common build/dependency directories
  watchWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*',
    false, // create
    false, // change
    false, // delete
  );

  const handleFileChange = (uri: vscode.Uri) => {
    // Exclude common non-source directories
    const relPath = vscode.workspace.asRelativePath(uri, false);
    if (/^(node_modules|\.git|out|dist)[/\\]/.test(relPath)) { return; }

    // Debounce: ignore changes within 2 seconds of the last trigger
    if (watchDebounceTimer) {
      clearTimeout(watchDebounceTimer);
    }
    watchDebounceTimer = setTimeout(() => {
      watchDebounceTimer = null;
      onWatchedFileChanged(relPath);
    }, 2000);
  };

  watchWatcher.onDidChange(handleFileChange);
  watchWatcher.onDidCreate(handleFileChange);
}

function disableWatchMode(): void {
  watchModeActive = false;
  if (watchWatcher) {
    watchWatcher.dispose();
    watchWatcher = null;
  }
  if (watchStatusBarItem) {
    watchStatusBarItem.hide();
  }
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = null;
  }
}

function onWatchedFileChanged(relativePath: string): void {
  const plan = getActivePlan();
  if (!plan) { return; }
  if (runner.state !== RunnerState.Idle) { return; }

  // Find tasks whose `files` array includes the changed file path
  const matchingTasks: Array<{ task: Task; playlistIndex: number; taskIndex: number }> = [];
  for (let pi = 0; pi < plan.playlists.length; pi++) {
    const pl = plan.playlists[pi];
    for (let ti = 0; ti < pl.tasks.length; ti++) {
      const task = pl.tasks[ti];
      if (task.files && task.files.some(f =>
        relativePath === f || relativePath.replace(/\\/g, '/') === f.replace(/\\/g, '/'),
      )) {
        matchingTasks.push({ task, playlistIndex: pi, taskIndex: ti });
      }
    }
  }

  if (matchingTasks.length === 0) { return; }

  // Show notification for the first matching task
  const first = matchingTasks[0];
  const taskNames = matchingTasks.map(m => m.task.name).join(', ');
  const label = matchingTasks.length === 1
    ? `Re-run "${first.task.name}"?`
    : `Re-run ${matchingTasks.length} tasks (${taskNames})?`;

  vscode.window.showInformationMessage(
    `File changed: ${relativePath}. ${label}`,
    'Run',
    'Dismiss',
  ).then(action => {
    if (action !== 'Run') { return; }

    if (matchingTasks.length === 1) {
      first.task.status = TaskStatus.Pending;
      saveAndRefresh();
      vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      runner.playTask(plan, first.playlistIndex, first.taskIndex).catch(err => {
        vscode.window.showErrorMessage(`Task failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      const taskList = matchingTasks.map(m => ({ playlistIndex: m.playlistIndex, taskIndex: m.taskIndex }));
      for (const m of matchingTasks) { m.task.status = TaskStatus.Pending; }
      saveAndRefresh();
      vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      runner.playTasks(plan, taskList).catch(err => {
        UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
      });
    }
  });
}

// ─── Prompt Snippets ───

async function cmdManagePromptSnippets(): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: '$(list-unordered) Toggle Snippets', description: 'Enable/disable auto-inject per snippet', value: 'toggle' },
      { label: '$(add) Add Custom Snippet', description: 'Create a new reusable prompt snippet', value: 'add' },
    ],
    { placeHolder: 'Manage prompt snippets' },
  );
  if (!action) { return; }

  if (action.value === 'add') {
    const name = await vscode.window.showInputBox({
      prompt: 'Snippet name',
      placeHolder: 'e.g., code-review',
    });
    if (!name) { return; }

    const text = await vscode.window.showInputBox({
      prompt: 'Snippet text (the instruction injected into prompts)',
      placeHolder: 'e.g., Always review code for security vulnerabilities before completing.',
    });
    if (!text) { return; }

    const category = await vscode.window.showInputBox({
      prompt: 'Category',
      value: 'Custom',
      placeHolder: 'e.g., Workflow, Safety, Quality',
    });
    if (!category) { return; }

    await promptLibraryStore.add({
      id: `user-${generateId()}`,
      name,
      category,
      text,
      autoInject: true,
    });
    vscode.window.showInformationMessage(`Snippet "${name}" added with auto-inject enabled.`);
    return;
  }

  // Toggle mode
  const snippets = promptLibraryStore.getAll();
  const items = snippets.map(s => ({
    label: s.name,
    description: `[${s.category}]` + (s.id.startsWith('builtin-') ? ' (built-in)' : ''),
    detail: s.text,
    picked: s.autoInject,
    snippetId: s.id,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Check snippets to auto-inject into every agent task prompt',
    title: 'Prompt Snippets',
  });
  if (!selected) { return; }

  const selectedIds = new Set(selected.map(s => s.snippetId));
  for (const s of snippets) {
    const shouldBeOn = selectedIds.has(s.id);
    if (shouldBeOn !== s.autoInject) {
      await promptLibraryStore.toggleAutoInject(s.id);
    }
  }

  const count = selected.length;
  vscode.window.showInformationMessage(`${count} snippet${count !== 1 ? 's' : ''} will auto-inject into task prompts.`);
}

async function cmdShowChangelog(context: vscode.ExtensionContext): Promise<void> {
  const changelogPath = vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md');
  let markdown = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(changelogPath);
    markdown = Buffer.from(bytes).toString('utf8');
  } catch {
    vscode.window.showErrorMessage('Could not read CHANGELOG.md.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'moagChangelog',
    "What's New — MOAG",
    vscode.ViewColumn.One,
    { enableScripts: false, retainContextWhenHidden: false },
  );

  // Convert markdown headings/lists to basic HTML
  function mdToHtml(md: string): string {
    return md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^## \[(.+?)\] - (.+)$/gm, '<h2>$1 <span class="date">$2</span></h2>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/^(?!<[hul])/gm, '')
      .trim();
  }

  const currentVersion = context.extension?.packageJSON?.version as string | undefined;
  const html = mdToHtml(markdown);

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>What's New — MOAG</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 32px; max-width: 860px; margin: 0 auto; }
  h1 { color: var(--vscode-textLink-foreground); font-size: 1.6em; margin-bottom: 4px; }
  h2 { color: var(--vscode-textLink-foreground); font-size: 1.25em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 28px; }
  h3 { color: var(--vscode-descriptionForeground); font-size: 1em; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  .date { font-weight: normal; font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  ul { margin: 4px 0 12px; padding-left: 20px; }
  li { margin: 3px 0; line-height: 1.5; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  strong { color: var(--vscode-foreground); }
  .badge { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 2px 10px; font-size: 0.75em; font-weight: bold; margin-left: 8px; vertical-align: middle; }
</style>
</head>
<body>
<h1>MOAG — What's New ${currentVersion ? `<span class="badge">v${currentVersion}</span>` : ''}</h1>
${html}
</body>
</html>`;
}
