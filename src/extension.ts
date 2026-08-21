// ─── Extension entry point ───
// Registers all commands, tree views, and wires the runner to the UI.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Plan, Playlist, RunnerState, EngineId, HistoryEntry, TaskStatus, TaskType, FailurePolicy, Task } from './models/types';
import {
  loadPlan, savePlan, dehydratePlan, hydratePlan, createEmptyPlan, createPlaylist, createTask,
  serializePlanForSharing, appendPrdVersion, MAX_PRD_VERSIONS,
} from './models/plan';
import { registerAllEngines, checkEngineAvailability, getEngine, setCeilingGuard } from './adapters/index';
import { commandExists } from './utils/command-exists';
import { ghSync, ghAsync } from './utils/gh';
import { TaskRunner, classifyFailure } from './runner/runner';
import {
  createPrdLoop, HaltReason, PrdLoopConfig, PrdLoopController, PrdLoopReport, UatSession,
} from './runner/prd-loop';
import { HistoryStore } from './history/store';
import { TemplateStore } from './templates/store';
import { generateId } from './models/plan';
import { isRoleId, resolveRoleCharter } from './models/roles';
import { PlanTreeProvider, PlanTreeItem } from './ui/plan-tree';
import { HistoryTreeProvider } from './ui/history-tree';
import { DashboardPanel } from './ui/dashboard-panel';
import { ExecutionDetailPanel } from './ui/execution-detail-panel';
import { TaskEditorPanel } from './ui/task-editor-panel';
import { RuleEditorPanel } from './ui/rule-editor-panel';
import {
  PromptEngineOption,
  PromptInputViewProvider,
  PromptSidebarListItem,
  PromptSidebarChatMessage,
  PromptSidebarPlanGroup,
  AiRuleSidebarItem,
  RulesAction,
} from './ui/prompt-input-view';
import { AiRulesStore, AiRule, RuleScope } from './ai-rules/rules-store';
import { BUILT_IN_RULES } from './ai-rules/built-in-rules';
import { detectProjectRules } from './ai-rules/project-detector';
import { detectAndConfigureEngines, detectEngines, redetectEngines } from './engine-detection';
import { analyzeProject, formatAnalysis } from './context/project-analyzer';
import {
  buildContext, getContextSettings, runRetrievalCascade, ContextBudgetUsage,
  setActiveKG, getActiveKG, buildKG, setWeightsMoagDir, invalidateWeightsCache,
} from './context/context-builder';
import { analyzeWeights, saveWeights } from './context/weights';
import { rebuildKGForFile } from './context/knowledge-graph';
import { RunSessionStore, RunSession } from './models/run-session';
import * as UserMsg from './utils/user-messages';
import { SessionsTreeProvider, SessionsTreeItem } from './ui/sessions-tree';
import { BUILT_IN_PLAN_TEMPLATES, PlanTemplate } from './templates/built-in-plans';
import { PROFILE_META, ProfileName } from './models/execution-profiles';
import { PromptLibraryStore } from './templates/prompt-library';
import { SandboxManager } from './sandbox/sandbox-manager';
import { resolveBrowserRunner } from './sandbox/browser-driver';
import { runGate } from './runner/evidence';
import { captureScreenshot } from './sandbox/screenshot';

// ─── Shared state ───

let moagOutputChannel: vscode.OutputChannel | null = null;
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

// ─── Cost ceiling ───
/**
 * Raised when the spend ceiling is breached; read synchronously by the engine
 * ceiling guard to block further engine calls. Cleared from the breach
 * notification itself and by any edit to agentTaskPlayer.costBudgetUsd.
 */
let ceilingBlocked = false;

// ─── AI Rules ───
let aiRulesStore: AiRulesStore | null = null;

// ─── Sandbox state ───
let sandboxManager: SandboxManager | null = null;
/** Screenshot paths captured via the sandbox panel, cleared after injected into a task's context */
let pendingScreenshotPaths: string[] = [];

// ─── Watch mode state ───
let watchModeActive = false;
let watchWatcher: vscode.FileSystemWatcher | null = null;
let watchStatusBarItem: vscode.StatusBarItem | null = null;
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Dev hot-reload watcher ───
let devReloadWatcher: fs.FSWatcher | null = null;
let devReloadTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Execution progress tracking ───
let executionTaskCount = 0;
let executionTasksCompleted = 0;
let executionTasksFailed = 0;
let executionStartTime = 0;

// ─── GitHub issue sync polling state ───
let issuePollInterval: ReturnType<typeof setInterval> | null = null;
const issueSyncKnownNumbers = new Set<string>(); // "repo#number" keys already imported into plan
let issueSyncLastPoll: string | null = null; // ISO timestamp of last poll

// ─── Friction tracking (cleared at run start) ───
const escalatedTaskIds = new Set<string>();

interface RunFrictionReport {
  runId: string;
  date: string;
  moagVersion: string;
  engine: string;
  projectType: string;
  summary: { total: number; passed: number; failed: number; escalated: number; durationMs: number; estimatedCostUsd: number };
  friction: Array<{ taskName: string; attempts: number; escalated: boolean; autoFixed: boolean; errorSummary: string }>;
  errorCategories: Record<string, number>;
}

// ─── Execution progress notification ───
let progressResolve: (() => void) | null = null;
let progressReport: vscode.Progress<{ message?: string; increment?: number }> | null = null;

const NO_ENGINES_PROMPT_KEY = 'agentTaskPlayer.noEnginesPromptShown';
const RECENT_PLANS_KEY = 'moag.recentPlans';
const CLAUDE_INSTALL_URL = 'https://www.npmjs.com/package/@anthropic-ai/claude-code';
const CODEX_INSTALL_URL = 'https://www.npmjs.com/package/@openai/codex';
// MOAG's own GitHub repo — always the target for bug reports
const MOAG_REPO = 'sujan-poudel-03/moag';

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
    const isFailed = entry.status === 'failed' || entry.status === 'blocked';
    // Extract first meaningful error line for failed tasks
    let failureReason: string | undefined;
    if (isFailed) {
      const merged = [entry.result?.stderr, entry.result?.stdout].filter(Boolean).join('\n');
      const lines = merged.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      const noise = [/^reading prompt from stdin/i, /^─+\s*(command|response)\s*─+/i, /^claude code/i];
      failureReason = lines.find(l => !noise.some(p => p.test(l)))?.substring(0, 120);
    }
    const filesChanged = entry.changedFiles?.length ?? 0;
    return {
      id: entry.threadId ?? entry.id,
      kind: 'history',
      title: entry.taskName,
      subtitle: `${planName} / ${playlistName}  -  ${getEngineDisplayName(entry.engine)}  -  ${formatSessionAge(entry.startedAt)}`,
      status: entry.status,
      planName,
      playlistName,
      failureReason,
      filesChanged: filesChanged > 0 ? filesChanged : undefined,
      taskId: entry.taskId,
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
      aiRules: playlist.aiRules,
      testPhase: playlist.testPhase,
      prdContext: playlist.prdContext,
      tasks: tasks.map((task) => {
        const taskEntries = historyStore.getForTask(task.id);
        const latestEntry = taskEntries[0];
        const isFailed = task.status === TaskStatus.Failed || task.status === TaskStatus.Blocked;
        const classification = isFailed && latestEntry
          ? classifyFailure(latestEntry.result.stderr, latestEntry.result.stdout)
          : null;
        return {
          id: task.id,
          name: task.name,
          status: task.status ?? 'pending',
          failureReason: getTaskFailureReason(task),
          errorCategory: classification?.category,
          errorLines: classification?.errorLines.slice(0, 5),
          attemptCount: taskEntries.length > 1 ? taskEntries.length : undefined,
          tokenUsage: latestEntry?.result.tokenUsage
            ? { totalTokens: latestEntry.result.tokenUsage.totalTokens, estimatedCost: latestEntry.result.tokenUsage.estimatedCost }
            : undefined,
          sourceIssueNumber: task.sourceIssueNumber,
          sourceIssueRepo: task.sourceIssueRepo,
        };
      }),
    };
  });
}

function detectPrdFileInWorkspace(): string {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) { return ''; }
  const fsLib = require('fs') as typeof import('fs');
  const pathLib = require('path') as typeof import('path');
  const candidates = ['PRD.md', 'prd.md', 'docs/PRD.md', 'docs/prd.md', 'REQUIREMENTS.md', 'requirements.md'];
  for (const rel of candidates) {
    try {
      if (fsLib.existsSync(pathLib.join(cwd, rel))) { return rel; }
    } catch { /* ignore */ }
  }
  return '';
}

function syncPromptProviderSidebar(promptProvider: PromptInputViewProvider): void {
  const chatState = getPromptSidebarChatState();
  const context = getPromptSidebarActiveContext();
  promptProvider.setPlanAiRules(getActivePlan()?.aiRules ?? '');
  let effectivePrdSource = getActivePlan()?.prdSource ?? '';
  let detectedPrdFilePath = '';
  if (!effectivePrdSource) {
    const detectedRel = detectPrdFileInWorkspace();
    if (detectedRel) {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      try { effectivePrdSource = fs.readFileSync(path.join(cwd, detectedRel), 'utf-8'); detectedPrdFilePath = detectedRel; } catch { /* ignore */ }
    }
  }
  promptProvider.setPlanPrdSource(effectivePrdSource);
  promptProvider.setDetectedPrdFilePath(detectedPrdFilePath);
  promptProvider.setPlanPrdVersions(getActivePlan()?.prdVersions ?? []);
  promptProvider.setPlanFixIterations(getActivePlan()?.fixIterations ?? 0);
  promptProvider.setPrdProjectMeta(getProjectMeta());
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
  // Multi-task runs already show a single summary in all-completed — suppress per-task toasts.
  if (executionTaskCount > 1) {
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
  // Cap failure toasts at 3 per run — the all-completed summary lists the total count.
  if (executionTaskCount > 1 && executionTasksFailed > 3) {
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

function getWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function syncRulesSidebar(): void {
  if (!promptViewProvider || !aiRulesStore) { return; }
  const cwd = getWorkspaceCwd();
  const items: AiRuleSidebarItem[] = aiRulesStore.getAllRules(cwd).map(r => ({
    id: r.id,
    name: r.name,
    category: r.category,
    scope: r.scope,
    enabled: r.enabled,
    charCount: r.text.length,
  }));
  promptViewProvider.postRulesState(items);
}

async function handleRulesAction(action: RulesAction): Promise<void> {
  if (!aiRulesStore) { return; }
  const cwd = getWorkspaceCwd();
  const hasWorkspace = !!cwd;

  if (action.type === 'add') {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(library) Browse built-in library', value: 'library' },
        { label: '$(edit) Create custom rule', value: 'custom' },
      ],
      { placeHolder: 'How would you like to add a rule?' },
    );
    if (!choice) { return; }
    if (choice.value === 'library') {
      await openBuiltInLibrary(cwd, hasWorkspace);
    } else {
      RuleEditorPanel.open({
        rule: null,
        hasWorkspace,
        onSave: (rule) => { aiRulesStore!.addRule(rule, cwd); syncRulesSidebar(); },
      });
    }
    return;
  }

  if (action.type === 'openLibrary') {
    await openBuiltInLibrary(cwd, hasWorkspace);
    return;
  }

  if (action.type === 'toggle') {
    aiRulesStore.toggleRule(action.id, action.scope as RuleScope, cwd);
    syncRulesSidebar();
    return;
  }

  if (action.type === 'edit') {
    const rule = aiRulesStore.getAllRules(cwd).find(r => r.id === action.id && r.scope === action.scope);
    if (!rule) { return; }
    RuleEditorPanel.open({
      rule,
      hasWorkspace,
      onSave: (updated) => { aiRulesStore!.updateRule(updated, cwd); syncRulesSidebar(); },
    });
    return;
  }

  if (action.type === 'delete') {
    const rule = aiRulesStore.getAllRules(cwd).find(r => r.id === action.id && r.scope === action.scope);
    const name = rule?.name ?? 'this rule';
    const confirmed = await vscode.window.showWarningMessage(
      `Delete "${name}"?`, { modal: true }, 'Delete',
    );
    if (confirmed === 'Delete') {
      aiRulesStore.deleteRule(action.id, action.scope as RuleScope, cwd);
      syncRulesSidebar();
    }
  }
}

async function openBuiltInLibrary(cwd: string, hasWorkspace: boolean): Promise<void> {
  if (!aiRulesStore) { return; }
  const existingIds = new Set(aiRulesStore.getAllRules(cwd).map(r => r.id));
  const items = BUILT_IN_RULES.map(r => ({
    label: r.name,
    description: r.category.replace(/-/g, ' '),
    detail: r.text.split('\n')[0],
    picked: existingIds.has(r.id),
    id: r.id,
  }));
  const picks = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select rules to add (already added rules are pre-checked)',
    canPickMany: true,
  });
  if (!picks || picks.length === 0) { return; }

  const scopePick = hasWorkspace
    ? await vscode.window.showQuickPick(
      [
        { label: 'Global', description: 'Applies to all projects', value: 'global' as RuleScope },
        { label: 'Workspace', description: 'Applies to this project only (.moag/rules.json)', value: 'workspace' as RuleScope },
      ],
      { placeHolder: 'Save these rules as:' },
    )
    : { value: 'global' as RuleScope };

  if (!scopePick) { return; }
  const scope = scopePick.value;

  for (const pick of picks) {
    if (existingIds.has(pick.id)) { continue; }
    const builtin = BUILT_IN_RULES.find(r => r.id === pick.id);
    if (!builtin) { continue; }
    const rule: AiRule = {
      id: builtin.id,
      name: builtin.name,
      category: builtin.category,
      scope,
      text: builtin.text,
      enabled: true,
    };
    aiRulesStore.addRule(rule, cwd);
  }
  syncRulesSidebar();
}

const RULES_PROMPT_KEY = 'agentTaskPlayer.rulesPromptShown';

/** Parse `### Rule Name\n[text]` blocks from an AI engine response. */
function parseRulesFromOutput(output: string): { name: string; text: string }[] {
  // Support: ### Name, ## Name, **Name**, 1. Name:
  const normalized = output.replace(/^(\d+\.\s+\*\*|##\s+|\*\*)/gm, '### ');
  const blocks = normalized.split(/^###\s+/m).filter(b => b.trim().length > 0);
  return blocks
    .map(block => {
      const lines = block.trim().split('\n');
      const name = lines[0].replace(/\*+/g, '').replace(/:$/, '').trim();
      const text = lines.slice(1).join('\n').trim();
      return { name, text };
    })
    .filter(r => r.name.length > 2 && r.text.length > 10);
}

/**
 * Ask the configured AI engine to generate project-specific rules.
 * `signal` is required, not optional: the compiler must reject the next caller
 * that forgets to wire cancellation, which is how this call went inert before.
 */
async function generateAiRules(
  engineId: EngineId,
  signals: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ name: string; text: string }[]> {
  const engine = getEngine(engineId);
  const prompt = `You are a code quality assistant helping configure an AI coding agent.

This project uses: ${signals.join(', ')}.

Generate exactly 5 concise, actionable coding rules tailored to this specific stack.
Each rule should guide an AI coding agent on what to always do or avoid in this project.

Format each rule exactly like this (use ### heading):

### Rule Name
2-4 sentence description of what to do and why, specific to the stack above.

Output only the 5 rules. No preamble, no conclusion, no numbering outside the ### headings.`;

  const result = await engine.runTask({ prompt, cwd, signal, costLabel: 'ai-rules' });
  if (result.exitCode !== 0 || !result.stdout.trim()) { return []; }
  return parseRulesFromOutput(result.stdout);
}

/** Ask the user which scope to save rules under. Returns null if cancelled. */
async function pickRuleScope(cwd: string): Promise<RuleScope | null> {
  const pick = cwd
    ? await vscode.window.showQuickPick(
      [
        { label: 'Global', description: 'All projects — saved to your user profile', value: 'global' as RuleScope },
        { label: 'Workspace', description: 'This project only — committed to .moag/rules.json', value: 'workspace' as RuleScope },
      ],
      { placeHolder: 'Save these rules as:' },
    )
    : { value: 'global' as RuleScope };
  return pick?.value ?? null;
}

async function maybePromptAiRules(context: vscode.ExtensionContext): Promise<void> {
  if (!aiRulesStore) { return; }
  const cwd = getWorkspaceCwd();
  if (!cwd) { return; }

  if (context.workspaceState.get<boolean>(RULES_PROMPT_KEY)) { return; }

  if (aiRulesStore.getAllRules(cwd).length > 0) {
    void context.workspaceState.update(RULES_PROMPT_KEY, true);
    return;
  }

  const { signals, suggestedRuleIds } = detectProjectRules(cwd);
  if (signals.length === 0) { return; }

  void context.workspaceState.update(RULES_PROMPT_KEY, true);

  const signalStr = signals.slice(0, 3).join(', ');
  const preferredEngine = getPreferredPromptEngine(detectedPromptEngines);
  const engineName = preferredEngine ? getEngineDisplayName(preferredEngine) : null;

  // Primary button: ask the configured engine if one is available
  const primaryLabel = engineName ? `Ask ${engineName}` : 'Use Library';
  const buttons = engineName
    ? [primaryLabel, 'Use Library', 'Dismiss']
    : [primaryLabel, 'Dismiss'];
  const choice = await vscode.window.showInformationMessage(
    `MOAG detected ${signalStr}. Generate tailored AI rules for this project?`,
    ...buttons,
  );

  if (!choice || choice === 'Dismiss') { return; }

  // ── AI generation path ──────────────────────────────────────────────────
  if (choice === primaryLabel && engineName && preferredEngine) {
    let generated: { name: string; text: string }[] = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Generating AI rules for ${signalStr}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        try {
          generated = await generateAiRules(preferredEngine, signals, cwd, abort.signal);
        } catch {
          // Includes the abort rejection — a cancelled generation yields no rules.
          generated = [];
        } finally {
          sub.dispose();
        }
      },
    );

    if (generated.length === 0) {
      void vscode.window.showWarningMessage(
        `${engineName} didn't return parseable rules. Falling back to built-in library.`,
      );
      await openBuiltInLibrary(cwd, !!cwd);
      return;
    }

    // Show generated rules in a reviewable QuickPick (all pre-selected)
    const items = generated.map((r, i) => ({
      label: r.name,
      detail: r.text.split('\n')[0],
      picked: true,
      idx: i,
    }));

    const picks = await vscode.window.showQuickPick(items, {
      placeHolder: `Review ${engineName}-generated rules — deselect any you don't want`,
      canPickMany: true,
    });
    if (!picks || picks.length === 0) { return; }

    const scope = await pickRuleScope(cwd);
    if (!scope) { return; }

    for (const pick of picks) {
      const r = generated[pick.idx];
      aiRulesStore.addRule({
        id: generateId(),
        name: r.name,
        category: 'custom',
        scope,
        text: r.text,
        enabled: true,
      }, cwd);
    }
    syncRulesSidebar();
    void vscode.window.showInformationMessage(
      `Added ${picks.length} AI rule${picks.length === 1 ? '' : 's'} from ${engineName}. Active on every task.`,
    );
    return;
  }

  // ── Static library fallback ─────────────────────────────────────────────
  await openBuiltInLibrary(cwd, !!cwd);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  // ── Output Channel + Global Error Capture ────────────────────────────────
  moagOutputChannel = vscode.window.createOutputChannel('MOAG');
  context.subscriptions.push(moagOutputChannel);

  process.on('uncaughtException', (err: Error) => {
    appendErrorLog({
      ts: new Date().toISOString(), category: 'uncaught',
      message: err.message.substring(0, 300),
      stack: err.stack?.split('\n').slice(0, 3).join('\n'),
    });
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    appendErrorLog({
      ts: new Date().toISOString(), category: 'unhandled-rejection',
      message: msg.substring(0, 300),
      stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 3).join('\n') : undefined,
    });
  });

  // Register all engine adapters
  registerAllEngines();

  // ── Dev hot-reload (FastAPI --reload equivalent) ───────────────────────
  // Only active when launched via F5 (Extension Development Host).
  // Watches out/ for compiled JS changes and auto-restarts the extension host —
  // no manual Ctrl+R needed after every save.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    const outDir = path.join(context.extensionPath, 'out');
    try {
      devReloadWatcher = fs.watch(outDir, { recursive: true }, (_event, filename) => {
        if (!filename?.endsWith('.js')) { return; }
        // Debounce: TypeScript emits many files per compile — wait for the burst to settle
        if (devReloadTimer) { clearTimeout(devReloadTimer); }
        devReloadTimer = setTimeout(() => {
          devReloadTimer = null;
          vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        }, 600);
      });
    } catch {
      // out/ may not exist yet on first launch — ignore
    }
  }

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
  // Detaches the runner from the shared cost ledger on deactivate, so a stale
  // runner cannot keep emitting 'budget-exceeded' after the host tears it down.
  context.subscriptions.push({ dispose: () => runner.dispose() });

  // Cost ceiling. The guard is a plain synchronous latch read — never async and
  // never a modal, because under parallelPlaylists it runs once per concurrent
  // engine call. The latch is raised by the 'budget-exceeded' handler and
  // cleared from the same notification that announces it (plus any change to
  // costBudgetUsd), so the user is never stuck without reloading the window.
  setCeilingGuard(() => !ceilingBlocked);
  context.subscriptions.push({ dispose: () => setCeilingGuard(null) });
  runner.setPromptLibrary(promptLibraryStore);

  // Initialize AI rules store
  aiRulesStore = new AiRulesStore(context.globalStorageUri.fsPath);
  runner.setAiRulesStore(aiRulesStore);

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
    (action: RulesAction) => { void handleRulesAction(action); },
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
  setTimeout(() => syncRulesSidebar(), 200);
  // Delay rule suggestion so it doesn't fire during startup noise
  setTimeout(() => { void maybePromptAiRules(context); }, 3000);
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

  let _prevSandboxStatus: string | null = null;
  sandboxManager.on('state-changed', (state) => {
    DashboardPanel.currentPanel?.postSandboxState(state);
    promptViewProvider?.postSandboxState(state);
    runner.setSandboxUrl(state.status === 'running' ? (state.url ?? null) : null);
    if (state.status === 'running' && _prevSandboxStatus !== 'running' && state.url) {
      void vscode.commands.executeCommand('simpleBrowser.api.open', state.url);
    }
    if (state.status === 'error' && _prevSandboxStatus !== 'error') {
      const msg = state.error ?? 'Sandbox failed to start.';
      void vscode.window.showErrorMessage(
        `Sandbox: ${msg}`,
        'Open Dashboard', 'Configure',
      ).then((action) => {
        if (action === 'Open Dashboard') {
          void vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
        } else if (action === 'Configure') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'agentTaskPlayer.sandbox');
        }
      });
    }
    _prevSandboxStatus = state.status;
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
    // If the panel was closed before this run started, reopen it so task cards are not lost
    if (!DashboardPanel.currentPanel) { ensureDashboardOpen(); }
    DashboardPanel.currentPanel?.startTaskCard(task, playlist, fullPrompt);
    promptViewProvider?.postLiveOutputStart(task.id, task.name);

    // Push Context Memory info to Dashboard so user sees what the agent knows
    const taskWithMeta = task as Task & {
      _budgetUsage?: { totalCharsUsed: number; totalCharsBudget: number; sectionsDropped: number; sectionBreakdown?: Record<string, number> };
      _retrievedFiles?: string[];
    };
    if (taskWithMeta._budgetUsage) {
      const bd = taskWithMeta._budgetUsage;
      const sections = Object.entries(bd.sectionBreakdown ?? {})
        .map(([name, chars]) => ({ name, chars: chars as number }))
        .sort((a, b) => b.chars - a.chars);
      DashboardPanel.currentPanel?.postContextMemory({
        taskId: task.id,
        taskName: task.name,
        sections,
        totalCharsUsed: bd.totalCharsUsed,
        totalCharsBudget: bd.totalCharsBudget,
        sectionsDropped: bd.sectionsDropped,
        retrievedFiles: taskWithMeta._retrievedFiles ?? [],
      });
    }

    // Show real progress in status bar and notification
    const shortName = task.name.length > 40 ? task.name.substring(0, 37) + '...' : task.name;
    statusBarItem.text = `$(sync~spin) ATP: Task ${executionTasksCompleted}/${executionTaskCount} — ${shortName}`;
    startProgressNotification();
    updateProgressNotification(`Task ${executionTasksCompleted}/${executionTaskCount}: ${shortName}`);

    // GitHub two-way sync: post "working on" comment
    if (task.sourceIssueNumber && task.sourceIssueRepo) {
      postIssueComment(task.sourceIssueRepo, task.sourceIssueNumber,
        `▶ Working on: **${task.name}**`);
      applyIssueLabel(task.sourceIssueRepo, task.sourceIssueNumber, 'moag:in-progress');
    }
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
    // Raise the ceiling latch: further engine calls return a synthetic failure
    // until the user clears it from one of the actions below.
    ceilingBlocked = true;
    const message = `Estimated run cost $${totalCost.toFixed(4)} exceeded the configured budget of $${budget.toFixed(4)}.`;

    // A breach can now come from an authoring call (PRD chat, plan generation)
    // with no run in flight. Only pause/resume when a plan is actually playing —
    // calling play(activePlan) from Idle would start a run nobody asked for.
    if (runner.state !== RunnerState.Playing) {
      void vscode.window
        .showWarningMessage(message, 'Open Settings', 'Reset Spend Counter')
        .then((action) => {
          if (action === 'Open Settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'agentTaskPlayer.costBudgetUsd',
            );
            return;
          }
          if (action === 'Reset Spend Counter') {
            runner.resetLifetimeBudget();
            ceilingBlocked = false;
          }
        });
      return;
    }

    runner.pause();

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

      // Resuming without releasing the latch would fail the next task
      // immediately — 'Continue' has to mean continue. The spend counter is
      // deliberately NOT reset: the runner has already re-armed the threshold
      // one budget-worth higher, so the ceiling fires again rather than latching.
      ceilingBlocked = false;

      runner.play(activePlan).catch(err => {
        UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
      });
    });
  });

  runner.on('task-completed', (task, _result) => {
    if (currentPlan) { unblockDependents(task.id, currentPlan); }
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

    // Auto-analyze context weights at key data thresholds
    {
      const instrumented = historyStore.getAll().filter(e => e.contextBudgetUsage);
      const n = instrumented.length;
      if ([20, 50, 100, 200].includes(n)) {
        const moagDirForWeights = getMoagDir();
        if (moagDirForWeights) {
          try {
            const w = analyzeWeights(instrumented);
            saveWeights(moagDirForWeights, w);
            invalidateWeightsCache();
          } catch { /* non-critical */ }
        }
      }
    }

    const { tokensIn, tokensOut } = runner.getSessionTokens();
    promptViewProvider?.postSessionCost(runner.getSessionCost(), tokensIn, tokensOut);
    promptViewProvider?.postLiveOutputEnd(task.id, task.status);
    schedulePromptProviderSidebarSync();

    // GitHub two-way sync: post completion comment
    if (task.sourceIssueNumber && task.sourceIssueRepo) {
      const nFiles = historyStore.getForTask(task.id)[0]?.changedFiles?.length ?? 0;
      postIssueComment(task.sourceIssueRepo, task.sourceIssueNumber,
        `✓ **${task.name}** — ${nFiles} file${nFiles !== 1 ? 's' : ''} changed`);
    }

    // Auto-capture screenshot after each task if sandbox is running
    const sbState = sandboxManager?.state;
    if (sbState?.status === 'running' && sbState.url) {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (cwd) {
        captureScreenshot({ projectType: sbState.projectInfo?.type ?? 'web', url: sbState.url, cwd })
          .then(screenshotPath => {
            if (screenshotPath && sandboxManager) {
              sandboxManager.setLastScreenshotPath(screenshotPath);
              runner.queueScreenshots([screenshotPath]);
            }
          })
          .catch(() => { /* silent — screenshot is best-effort */ });
      }
    }
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
    schedulePromptProviderSidebarSync();

    // GitHub two-way sync: post failure comment
    if (task.sourceIssueNumber && task.sourceIssueRepo) {
      const errLine = result.stderr.split('\n').find(l => l.trim())?.substring(0, 200) ?? `exit ${result.exitCode}`;
      postIssueComment(task.sourceIssueRepo, task.sourceIssueNumber,
        `✗ **${task.name}** failed — ${errLine}`);
    }

    // Silently log MOAG infrastructure failures (spawn errors, auth, context overflow, etc.)
    const issueType = classifyMoagIssue(result.stderr, result.exitCode);
    if (issueType) {
      logMoagSelfIssue(issueType, `${issueType} during task "${task.name}"`, result.stderr.substring(0, 300));
    }
  });

  runner.on('task-escalate', (task, _category, _errorLines) => {
    saveAndRefresh();
    escalatedTaskIds.add(task.id);
    vscode.window.showWarningMessage(
      `Auto-fix exhausted for "${task.name}". Use Smart Fix for guided repair.`,
      'Smart Fix',
    ).then((choice) => {
      if (choice !== 'Smart Fix' || !currentPlan) { return; }
      for (let pi = 0; pi < currentPlan.playlists.length; pi++) {
        const ti = (currentPlan.playlists[pi].tasks || []).findIndex(t => t.id === task.id);
        if (ti >= 0) {
          void cmdShowSmartFix({ playlistIndex: pi, taskIndex: ti });
          break;
        }
      }
    });
  });

  runner.on('playlist-started', (playlist) => {
    if (playlist.testPhase) {
      handleTttPhaseStart(playlist);
    }
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

    // Collect friction and offer feedback sharing when the run had failures/escalations
    const hasFriction = executionTasksFailed > 0 || escalatedTaskIds.size > 0;
    if (runner.currentRunId && hasFriction) {
      const report = collectRunFriction(runner.currentRunId, totalDuration);
      if (report.friction.length > 0) {
        appendFrictionLog(report);
        const frictionMsg = `${report.summary.failed} failed` +
          (report.summary.escalated > 0 ? `, ${report.summary.escalated} escalated` : '') +
          ' — help improve MOAG?';
        vscode.window.showInformationMessage(frictionMsg, 'Share Feedback', 'Show Dashboard').then(choice => {
          if (choice === 'Share Feedback') { void cmdShareRunFeedback(); }
          else if (choice === 'Show Dashboard') { void vscode.commands.executeCommand('agentTaskPlayer.showDashboard'); }
        });
        return;
      }
    }

    // Offer to close the GitHub issues this plan was generated from (only on full success)
    const sourceIssues = currentPlan?.sourceIssues;
    if (executionTasksFailed === 0 && sourceIssues?.length) {
      const issueLabel = sourceIssues.length === 1
        ? `Close #${sourceIssues[0].number} on GitHub`
        : `Close ${sourceIssues.length} issues on GitHub`;
      vscode.window.showInformationMessage(
        `${summary}${filesSuffix}`,
        issueLabel, 'Show Dashboard', 'Create PR',
      ).then(action => {
        if (action === issueLabel) { void cmdCloseSourceIssues(sourceIssues); }
        else if (action === 'Show Dashboard') { void vscode.commands.executeCommand('agentTaskPlayer.showDashboard'); }
        else if (action === 'Create PR') { createPRFromRun(); }
      });
      return;
    }

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

  runner.on('manual-gate', (task) => {
    // Open dashboard so the user sees the waiting state
    void vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
    vscode.window.showInformationMessage(
      `[MOAG] Manual step: "${task.name}"${task.prompt ? ' — ' + task.prompt.split('\n')[0] : ''}`,
      'Mark Complete',
      'Skip',
    ).then(action => {
      if (action === 'Mark Complete') {
        runner.resolveManualGate(task.id);
      } else if (action === 'Skip') {
        runner.skipManualGate(task.id);
      }
      // Dismissed without clicking = do nothing; runner continues waiting until stop() is called
    });
  });

  runner.on('error', (err) => {
    appendErrorLog({
      ts: new Date().toISOString(), category: 'runner',
      message: (err instanceof Error ? err.message : String(err)).substring(0, 300),
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 3).join('\n') : undefined,
    });
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
    vscode.commands.registerCommand('agentTaskPlayer.savePlaylistRules', cmdSavePlaylistRules),
    vscode.commands.registerCommand('agentTaskPlayer.savePlanRules', cmdSavePlanRules),
    vscode.commands.registerCommand('agentTaskPlayer.previewTaskPrompt', cmdPreviewTaskPrompt),
    vscode.commands.registerCommand('agentTaskPlayer.deleteItem', cmdDeleteItem),
    vscode.commands.registerCommand('agentTaskPlayer.moveUp', cmdMoveUp),
    vscode.commands.registerCommand('agentTaskPlayer.moveDown', cmdMoveDown),
    vscode.commands.registerCommand('agentTaskPlayer.showHistory', cmdShowHistory),
    vscode.commands.registerCommand('agentTaskPlayer.showDashboard', cmdShowDashboard),
    vscode.commands.registerCommand('agentTaskPlayer.reloadWindow', () => {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
    vscode.commands.registerCommand('agentTaskPlayer.markTaskComplete', async () => {
      // Let the user pick which pending manual gate to resolve (if multiple)
      const plan = getActivePlan();
      if (!plan) { return; }
      const waitingTasks = plan.playlists.flatMap(pl => pl.tasks)
        .filter(t => t.type === 'manual' && t.status === 'running' as unknown as import('./models/types').TaskStatus);
      if (waitingTasks.length === 0) {
        vscode.window.showInformationMessage('No manual gates are currently waiting.');
        return;
      }
      const pick = waitingTasks.length === 1
        ? waitingTasks[0]
        : await vscode.window.showQuickPick(
            waitingTasks.map(t => ({ label: t.name, task: t })),
            { placeHolder: 'Select the manual step to mark complete' }
          ).then(sel => sel?.task);
      if (pick) { runner.resolveManualGate(pick.id); }
    }),
    vscode.commands.registerCommand('agentTaskPlayer.clearHistory', cmdClearHistory),
    vscode.commands.registerCommand('agentTaskPlayer.addAiRule', () => {
      void handleRulesAction({ type: 'add' });
    }),
    vscode.commands.registerCommand('agentTaskPlayer.manageAiRules', () => {
      void handleRulesAction({ type: 'openLibrary' });
    }),
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
    vscode.commands.registerCommand('agentTaskPlayer.retryTaskWithPrompt', cmdRetryTaskWithPrompt),
    vscode.commands.registerCommand('agentTaskPlayer.showSmartFix', cmdShowSmartFix),
    vscode.commands.registerCommand('agentTaskPlayer.fixAllFailed', cmdFixAllFailed),
    vscode.commands.registerCommand('agentTaskPlayer.addTaskFromPrompt', cmdAddTaskFromPrompt),
    vscode.commands.registerCommand('agentTaskPlayer.exportResults', cmdExportResults),
    vscode.commands.registerCommand('agentTaskPlayer.dryRun', cmdDryRun),
    vscode.commands.registerCommand('agentTaskPlayer.undoTask', cmdUndoTask),
    vscode.commands.registerCommand('agentTaskPlayer.setTaskStatus', cmdSetTaskStatus),
    vscode.commands.registerCommand('agentTaskPlayer.setPlaylistStatus', cmdSetPlaylistStatus),
    vscode.commands.registerCommand('agentTaskPlayer.setTestPhase', cmdSetTestPhase),
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
    vscode.commands.registerCommand('agentTaskPlayer.reportIssue', cmdReportIssue),
    vscode.commands.registerCommand('agentTaskPlayer.planFromOpenIssues', cmdPlanFromOpenIssues),
    vscode.commands.registerCommand('agentTaskPlayer.ghSyncPollNow', () => {
      const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
      const label = cfg.get<string>('issueSync.label', 'moag');
      void pollGitHubIssues(label).then(() => {
        vscode.window.showInformationMessage('GitHub issues poll complete.');
        if (promptViewProvider) { schedulePromptProviderSidebarSync(); }
      });
    }),
    vscode.commands.registerCommand('agentTaskPlayer.ghSyncConfigure', async (args?: { repo?: string; label?: string; enabled?: boolean }) => {
      const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
      const target = vscode.ConfigurationTarget.Workspace;
      if (args?.repo !== undefined) {
        await cfg.update('issueRepo', args.repo, target);
      }
      if (args?.label !== undefined) {
        await cfg.update('issueSync.label', args.label, target);
      }
      if (args?.enabled !== undefined) {
        await cfg.update('issueSync.enabled', args.enabled, target);
      }
      startIssuePolling(context);
      if (promptViewProvider) { schedulePromptProviderSidebarSync(); }
    }),
    vscode.commands.registerCommand('agentTaskPlayer.ghSyncConfigureInteractive', async () => {
      const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
      const currentRepo = cfg.get<string>('issueRepo') || '';
      const currentLabel = cfg.get<string>('issueSync.label') || 'moag';
      const currentEnabled = cfg.get<boolean>('issueSync.enabled') ?? false;

      if (currentRepo) {
        // Already connected — show quick pick to manage
        const pick = await vscode.window.showQuickPick([
          { label: currentEnabled ? '$(debug-pause) Disable sync' : '$(play) Enable sync', action: 'toggle' },
          { label: '$(refresh) Poll now', action: 'poll' },
          { label: '$(edit) Change repo / label', action: 'change' },
          { label: '$(trash) Disconnect', action: 'disconnect' },
        ], { title: `GitHub Sync — ${currentRepo}`, placeHolder: 'Choose an action' });
        if (!pick) { return; }
        if (pick.action === 'toggle') {
          await cfg.update('issueSync.enabled', !currentEnabled, vscode.ConfigurationTarget.Workspace);
          startIssuePolling(context);
        } else if (pick.action === 'poll') {
          void vscode.commands.executeCommand('agentTaskPlayer.ghSyncPollNow');
        } else if (pick.action === 'disconnect') {
          await cfg.update('issueRepo', '', vscode.ConfigurationTarget.Workspace);
          await cfg.update('issueSync.enabled', false, vscode.ConfigurationTarget.Workspace);
          startIssuePolling(context);
        } else {
          // fall through to change flow below
          void vscode.commands.executeCommand('agentTaskPlayer.ghSyncConfigureInteractive');
          return;
        }
        if (promptViewProvider) { schedulePromptProviderSidebarSync(); }
        return;
      }

      // No repo — prompt to connect
      const repo = await vscode.window.showInputBox({
        title: 'Connect GitHub Issues Sync',
        prompt: 'Enter repository in owner/repo format',
        placeHolder: 'e.g. acme/my-app',
        value: currentRepo,
        validateInput: v => v && v.includes('/') ? undefined : 'Must be owner/repo',
      });
      if (!repo) { return; }

      const label = await vscode.window.showInputBox({
        title: 'Issue label to track',
        prompt: 'Only issues with this label will be imported as tasks',
        placeHolder: 'moag',
        value: currentLabel,
      });
      if (label === undefined) { return; }

      await cfg.update('issueRepo', repo.trim(), vscode.ConfigurationTarget.Workspace);
      await cfg.update('issueSync.label', (label.trim() || 'moag'), vscode.ConfigurationTarget.Workspace);
      await cfg.update('issueSync.enabled', true, vscode.ConfigurationTarget.Workspace);
      startIssuePolling(context);
      if (promptViewProvider) { schedulePromptProviderSidebarSync(); }
      vscode.window.showInformationMessage(`GitHub sync connected to ${repo.trim()} — polling for "${label.trim() || 'moag'}" issues.`);
    }),
    vscode.commands.registerCommand('agentTaskPlayer.setupGuide', () => cmdShowSetupGuide(context)),
    vscode.commands.registerCommand('agentTaskPlayer.planFromPrd', cmdPlanFromPRD),
    vscode.commands.registerCommand('agentTaskPlayer.generatePlanFromPrdText', (prdText: string) => generatePlanFromPrdText(prdText)),
    vscode.commands.registerCommand('agentTaskPlayer.prdChatAnswer', (payload: { answer: string; step: number; answers: string[] }) => void handlePrdChatAnswer(payload)),
    vscode.commands.registerCommand('agentTaskPlayer.openPrdFromPlan', cmdOpenPrdFromPlan),
    vscode.commands.registerCommand('agentTaskPlayer.savePrdToPlan', (prdText: string) => void cmdSavePrdToPlan(prdText)),
    vscode.commands.registerCommand('agentTaskPlayer.verifyAgainstPrd', cmdVerifyAgainstPrd),
    vscode.commands.registerCommand('agentTaskPlayer.prdAiImprove', (text: string) =>
      void handlePrdAiImprove(text, (improved) => promptViewProvider?.postMessage({ type: 'prdAiImproveResult', text: improved }))),
    vscode.commands.registerCommand('agentTaskPlayer.openPrdInBrowser', (text: string) => void openPrdInBrowser(text)),
    vscode.commands.registerCommand('agentTaskPlayer.savePrdVersion', (payload: { text: string; version: string }) => {
      const saved = savePrdVersionToActivePlan(payload.text, payload.version);
      promptViewProvider?.postMessage({ type: 'prdVersionSaved', versions: saved.versions, version: saved.version });
    }),
    vscode.commands.registerCommand('agentTaskPlayer.suggestCommit', cmdSuggestCommit),
    vscode.commands.registerCommand('agentTaskPlayer.shareRunFeedback', cmdShareRunFeedback),
    vscode.commands.registerCommand('agentTaskPlayer.runContextEval', cmdRunContextEval),
    vscode.commands.registerCommand('agentTaskPlayer.analyzeContextWeights', cmdAnalyzeContextWeights),
    vscode.commands.registerCommand('agentTaskPlayer.reviewSelfIssues', cmdReviewSelfIssues),
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

    // The ceiling latch has to be escapable from somewhere that is always
    // reachable. Choosing 'Stop' on a breach — or dismissing the notification —
    // leaves the latch raised, and because blocked calls never record, no further
    // budget-exceeded fires to re-offer the inline action. Without this command
    // the only ways out are editing settings or reloading the window.
    vscode.commands.registerCommand('agentTaskPlayer.resetSpendCounter', () => {
      runner.resetLifetimeBudget();
      ceilingBlocked = false;
      void vscode.window.showInformationMessage(
        'Spend counter reset. Estimated spend is back to $0.00 and engine calls are unblocked.',
      );
    }),

    vscode.commands.registerCommand('agentTaskPlayer.provisionBrowsers', async () => {
      try {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('Open a workspace folder before provisioning browsers.');
          return;
        }

        if (resolveBrowserRunner(cwd).kind === 'local') {
          const choice = await vscode.window.showWarningMessage(
            'Playwright is already installed in this workspace. Reinstall it?',
            { modal: true },
            'Reinstall',
          );
          if (choice !== 'Reinstall') {
            return;
          }
        }

        const version = vscode.workspace
          .getConfiguration('agentTaskPlayer')
          .get<string>('browser.playwrightVersion', '1.62.1');
        // Deliberately NOT prdLoop.gateTimeoutMs — a browser download is nothing
        // like a unit-test run, and borrowing that budget would truncate it.
        const provisionTimeoutMs = 900_000;
        const steps = [
          `npm i -D @playwright/test@${version}`,
          'npx playwright install chromium',
        ];

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'MOAG: provisioning browsers',
            cancellable: true,
          },
          async (progress, token) => {
            const abort = new AbortController();
            const cancelSub = token.onCancellationRequested(() => abort.abort());
            try {
              for (const command of steps) {
                progress.report({ message: command });
                // runGate owns spawn, abort, taskkill and the timeout — one
                // implementation for every long-running command MOAG runs.
                const result = await runGate(command, {
                  cwd,
                  signal: abort.signal,
                  timeoutMs: provisionTimeoutMs,
                });
                if (!result.passed) {
                  const tail = result.output.trim().slice(-1_200);
                  UserMsg.showError(UserMsg.runnerError(
                    `Browser provisioning failed at "${command}" (exit ${result.exitCode}` +
                    `${result.timedOut ? ', timed out' : ''}).\n${tail}`,
                  ));
                  return;
                }
              }
              vscode.window.showInformationMessage(
                `Browsers provisioned — Playwright ${version} with chromium is ready.`,
              );
            } finally {
              cancelSub.dispose();
            }
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        UserMsg.showError(UserMsg.runnerError(`Browser provisioning failed: ${msg.substring(0, 200)}`));
      }
    }),
  );

  // ─── Knowledge Graph + Weights: init in background 2s after activation ──────
  {
    const kgCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (kgCwd) {
      // Point weights loader at .moag/ dir
      const moagDirForWeights = getMoagDir();
      if (moagDirForWeights) { setWeightsMoagDir(moagDirForWeights); }

      setTimeout(() => {
        try { setActiveKG(buildKG(kgCwd)); } catch (e) { appendErrorLog({ ts: new Date().toISOString(), category: 'kg', message: String(e).substring(0, 200), context: 'KG initial build' }); }
      }, 2000);

      // Debounce map for file-save KG updates
      const kgRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
      context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
          if (!/\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb|php)$/.test(doc.uri.fsPath)) { return; }
          const relPath = path.relative(kgCwd, doc.uri.fsPath).replace(/\\/g, '/');
          const existing = kgRebuildTimers.get(relPath);
          if (existing) { clearTimeout(existing); }
          kgRebuildTimers.set(relPath, setTimeout(() => {
            kgRebuildTimers.delete(relPath);
            const kg = getActiveKG();
            if (kg) {
              try { rebuildKGForFile(kg, kgCwd, relPath); } catch (e) { appendErrorLog({ ts: new Date().toISOString(), category: 'kg', message: String(e).substring(0, 200), context: 'KG rebuild: ' + relPath }); }
            }
          }, 1500));
        }),
      );
    }
  }

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
      // Show setup guide on first install if no engines found
      const hasSeenSetup = context.globalState.get<boolean>('moag.setupGuideSeen', false);
      if (!hasSeenSetup && result.available.length === 0) {
        context.globalState.update('moag.setupGuideSeen', true);
        cmdShowSetupGuide(context);
      }
    })
    .catch(() => undefined);

  // Auto-load plan if one exists in workspace, then restore pause state
  autoLoadPlan().then(() => {
    restorePauseState(context);
    startIssuePolling(context);
  });

  // Restart polling when issueSync settings change
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('agentTaskPlayer.issueSync')) {
      startIssuePolling(context);
    }
    // Re-editing the budget is an explicit "I know, carry on" — release the latch.
    if (e.affectsConfiguration('agentTaskPlayer.costBudgetUsd')) {
      ceilingBlocked = false;
    }
  }));

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
    const result = ghSync(['pr', 'create', '--title', title, '--body', body], {
      cwd,
      timeout: 30000,
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
  stopIssuePolling();
  if (devReloadTimer) { clearTimeout(devReloadTimer); devReloadTimer = null; }
  devReloadWatcher?.close();
  devReloadWatcher = null;
  if (planFileWatcher) {
    planFileWatcher.dispose();
    planFileWatcher = null;
  }
  disableWatchMode();
}

// ─── Helper: save & refresh ───

/**
 * After a task is completed or manually marked done, reset any Blocked dependents
 * whose full dependency set is now satisfied (all deps Completed or Skipped).
 * Returns true if at least one task was unblocked.
 */
function unblockDependents(resolvedTaskId: string, plan: Plan): boolean {
  const allTasks = plan.playlists.flatMap(pl => pl.tasks);
  const resolved = new Set(
    allTasks
      .filter(t => t.status === TaskStatus.Completed || t.status === TaskStatus.Skipped || t.id === resolvedTaskId)
      .map(t => t.id),
  );
  let any = false;
  for (const t of allTasks) {
    if (t.status !== TaskStatus.Blocked) { continue; }
    if (!t.dependsOn?.length) { continue; }
    if (t.dependsOn.every(depId => resolved.has(depId))) {
      t.status = TaskStatus.Pending;
      any = true;
    }
  }
  return any;
}

function handleTttPhaseStart(playlist: Playlist): void {

  const tool = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('testTool', 'manual');

  DashboardPanel.currentPanel?.appendOutput(
    `\n[TTT] Test phase started — playlist: "${playlist.name}" | tool: ${tool}\n`,
    'stdout',
  );

  switch (tool) {
    case 'claude-chrome':
      vscode.window.showInformationMessage(
        'TTT — Time to Test. Open Claude.ai in Chrome to verify visually.',
        'Open Claude.ai',
      ).then(action => {
        if (action === 'Open Claude.ai') {
          void vscode.env.openExternal(vscode.Uri.parse('https://claude.ai'));
        }
      });
      break;

    case 'sandbox': {
      const state = sandboxManager?.state;
      if (!state || state.status !== 'running') {
        void vscode.commands.executeCommand('agentTaskPlayer.launchSandbox');
      }
      break;
    }

    case 'playwright':
    case 'cypress':
    case 'custom':
      vscode.window.showInformationMessage(
        `TTT — ${tool} will run automatically via test tasks.`,
      );
      break;

    case 'manual':
    default:
      vscode.window.showInformationMessage(
        'TTT — Time to Test. Mark tasks complete when done.',
      );
      break;
  }
}

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
  escalatedTaskIds.clear();
}

function initializeMultiTaskExecution(taskCount: number): void {
  executionTaskCount = Math.max(taskCount, 0);
  executionTasksCompleted = 0;
  executionTasksFailed = 0;
  executionStartTime = Date.now();
  escalatedTaskIds.clear();
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
    runner.play(activePlan).catch(err => {
      UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
    });
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

  // Profile picker — let user choose quality/speed trade-off per run
  if (!await showProfilePicker()) { return; }

  // Initialize progress counters
  initializeMultiTaskExecution(activePlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0));

  saveAndRefresh();
  startProgressNotification();
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
          costLabel: 'plan-generation',
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
    const parsedRole = (pl as ParsedPlanPlaylist).role;
    if (isRoleId(parsedRole)) { playlist.role = parsedRole; }
    if ((pl as ParsedPlanPlaylist).testPhase) { playlist.testPhase = true; }
    if ((pl as ParsedPlanPlaylist).prdContext) { playlist.prdContext = (pl as ParsedPlanPlaylist).prdContext; }
    for (const t of pl.tasks) {
      const task = createTask(t.name, t.prompt);
      const pt = t as ParsedPlanTask;
      if (pt.type) { task.type = pt.type as TaskType; }
      if (pt.command) { task.command = pt.command; }
      playlist.tasks.push(task);
    }
    return playlist;
  });
  injectTestTaskIfMissing(currentPlan, cwd);

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

/** Detect the appropriate test runner command for the workspace. */
function detectTestCommand(cwd: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (scripts?.test && !scripts.test.startsWith('echo "Error: no test')) {
      return 'npm test';
    }
  } catch { /* no package.json */ }
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'pyproject.toml'))) { return 'pytest'; }
  if (fs.existsSync(path.join(cwd, 'setup.py'))) { return 'python -m pytest'; }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) { return 'go test ./...'; }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) { return 'cargo test'; }
  if (fs.existsSync(path.join(cwd, 'pom.xml'))) { return 'mvn test'; }
  if (fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'))) { return './gradlew test'; }
  return null;
}

/** Append a test-runner task to the last playlist if the plan has no command-type test task. */
function injectTestTaskIfMissing(plan: Plan, cwd: string): void {
  const testCmd = detectTestCommand(cwd);
  if (!testCmd) { return; }
  const alreadyHasRunner = plan.playlists.some(pl =>
    pl.tasks.some(t => t.type === 'command' && t.command && /test|spec|check/.test(t.command.toLowerCase())),
  );
  if (alreadyHasRunner) { return; }
  let testPlaylist = plan.playlists.find(pl => /test/i.test(pl.name));
  if (!testPlaylist) {
    testPlaylist = createPlaylist('Testing');
    testPlaylist.testPhase = true;
    plan.playlists.push(testPlaylist);
  }
  const task = createTask('Run Test Suite', 'Run the full test suite and confirm all tests pass.');
  task.type = 'command';
  task.command = testCmd;
  testPlaylist.tasks.push(task);
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
      "name": "Phase name (e.g., Setup, Core, Features, Testing)",
      "testPhase": false,
      "prdContext": "Quote the PRD slice that governs this playlist's tasks. For Testing playlists, copy the full acceptance criteria verbatim.",
      "tasks": [
        {
          "name": "Short task name",
          "prompt": "Detailed, actionable instruction for a coding agent.",
          "type": "agent",
          "command": ""
        }
      ]
    }
  ]
}

Task type rules — set the "type" field accordingly:
- "agent"       AI coding tasks (default — use for most tasks)
- "command"     Shell commands: builds, test runners, linters. Set "command" to the exact shell command and use "prompt" as a brief description. Example: { "type": "command", "command": "npm test", "name": "Run Tests", "prompt": "Run the full test suite." }
- "visual-test" Browser UI verification via screenshot + AI vision. Only for web/frontend projects.

Plan structure rules:
- Group tasks into logical phases: Setup → Core → Features → Testing
- ALWAYS end with a "Testing" playlist — set "testPhase": true on it
- The Testing playlist MUST include at minimum one task with "type": "command" running the test suite (npm test / pytest / go test ./... / cargo test — pick the right one for the project)
- For web/frontend projects, also add a "type": "visual-test" task in Testing to verify the UI
- Each task should be a single, focused coding step a CLI agent can execute independently
- Task prompts must be detailed and self-contained — include file paths, interfaces, acceptance criteria
- For large specs: aim for 4-12 playlists with 3-8 tasks each
- For medium specs: aim for 2-5 playlists with 3-6 tasks each
- Start with foundational work (project setup, core models, database) before features
- The project name should be concise and descriptive
- Do NOT create placeholder or "TODO later" tasks — only include what should be built now`;

interface ParsedPlanTask { name: string; prompt: string; type?: string; command?: string }
interface ParsedPlanPlaylist { name: string; engine?: string; role?: string; testPhase?: boolean; prdContext?: string; tasks: ParsedPlanTask[] }
interface ParsedPlan { name: string; tasks?: ParsedPlanTask[]; playlists?: ParsedPlanPlaylist[] }

/** Try to extract structured plan from AI response */
function parsePlanResponse(raw: string): ParsedPlan | null {
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
      const playlists: ParsedPlanPlaylist[] = parsed.playlists
        .filter((pl: { name?: string; tasks?: unknown[] }) => pl.name && Array.isArray(pl.tasks) && pl.tasks.length > 0)
        .map((pl: { name: string; engine?: string; role?: string; testPhase?: boolean; prdContext?: string; tasks: Array<{ name?: string; prompt?: string; type?: string; command?: string }> }) => ({
          name: pl.name,
          engine: pl.engine,
          role: pl.role,
          testPhase: pl.testPhase === true,
          prdContext: typeof pl.prdContext === 'string' ? pl.prdContext.substring(0, 4000) : undefined,
          tasks: pl.tasks
            .filter(t => t.name && (t.prompt || t.type === 'command'))
            .map(t => ({
              name: String(t.name),
              prompt: String(t.prompt ?? ''),
              ...(t.type && t.type !== 'agent' ? { type: String(t.type) } : {}),
              ...(t.command ? { command: String(t.command) } : {}),
            })),
        }))
        .filter((pl: ParsedPlanPlaylist) => pl.tasks.length > 0);
      if (playlists.length > 0) {
        return { name: String(parsed.name).substring(0, 60), playlists };
      }
    }

    // Single tasks array format (backward compatible)
    if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
      const tasks: ParsedPlanTask[] = parsed.tasks
        .filter((t: { name?: string; prompt?: string }) => t.name && t.prompt)
        .map((t: { name: string; prompt: string; type?: string; command?: string }) => ({
          name: t.name,
          prompt: t.prompt,
          ...(t.type && t.type !== 'agent' ? { type: t.type } : {}),
          ...(t.command ? { command: t.command } : {}),
        }));
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

function cmdSavePlaylistRules(arg?: unknown): void {
  if (!currentPlan || !arg || typeof arg !== 'object') { return; }
  const { playlistIndex, rules } = arg as { playlistIndex: number; rules: string };
  const playlist = currentPlan.playlists[playlistIndex];
  if (!playlist) { return; }
  playlist.aiRules = rules.trim() || undefined;
  saveAndRefresh();
}

function cmdSavePlanRules(arg?: unknown): void {
  if (!currentPlan || !arg || typeof arg !== 'object') { return; }
  const { rules } = arg as { rules: string };
  currentPlan.aiRules = (rules as string).trim() || undefined;
  saveAndRefresh();
}

async function cmdPreviewTaskPrompt(arg?: unknown): Promise<void> {
  if (!currentPlan) { return; }

  let playlistIndex: number;
  let taskIndex: number;

  if (arg && typeof arg === 'object' && 'playlistIndex' in (arg as object)) {
    // Called from tree context menu with explicit indices
    ({ playlistIndex, taskIndex } = arg as { playlistIndex: number; taskIndex: number });
  } else {
    // Called from toolbar or palette — find the first pending task automatically
    let found = false;
    for (let pi = 0; pi < currentPlan.playlists.length; pi++) {
      const pl = currentPlan.playlists[pi];
      for (let ti = 0; ti < pl.tasks.length; ti++) {
        const t = pl.tasks[ti];
        const s = t.status ?? 'pending';
        if (s === 'pending' || s === 'running') {
          playlistIndex = pi;
          taskIndex = ti;
          found = true;
          break;
        }
      }
      if (found) { break; }
    }
    if (!found) {
      vscode.window.showInformationMessage('No pending tasks — all tasks are completed.');
      return;
    }
  }

  const playlist = currentPlan.playlists[playlistIndex!];
  const task = playlist?.tasks[taskIndex!];
  if (!task || !playlist) { return; }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const settings = getContextSettings();
  const budgetUsage: ContextBudgetUsage = {
    totalCharsUsed: 0, totalCharsBudget: settings.maxContextChars,
    sectionsDropped: 0, usedSemanticRetrieval: false, semanticSpansReturned: 0,
  };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building context preview…', cancellable: false },
    async () => {
      const { spans: retrievedSpans, usedSemantic } =
        await runRetrievalCascade(task, cwd, settings.maxFileContextChars);

      const previewAiRules = aiRulesStore?.getEnabledText(cwd) || undefined;
      const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');

      // Same resolution chain as TaskRunner.buildPrompt — task > playlist > plan.
      const rolesEnabled = cfg.get<boolean>('roles.enabled', true);
      const previewRoleId = task.role ?? playlist.role ?? currentPlan!.defaultRole;
      const previewRoleCharter = rolesEnabled
        ? resolveRoleCharter(previewRoleId, currentPlan!.customRoles)
        : null;
      const ctx = buildContext({
        plan: currentPlan!, playlist, task, cwd, historyStore,
        settings, budgetUsage, retrievedSpans, retrievedSpansUsedSemantic: usedSemantic,
        roleCharter: previewRoleCharter ?? undefined,
        aiRules: previewAiRules,
      });

      // Replicate runner prompt assembly (minus screenshots/variable substitution)
      let fullPrompt = ctx ? ctx + '\n\n' : '';
      if (cfg.get<boolean>('promptRulesEnabled', true)) {
        const rules = cfg.get<string>('promptRules', '');
        if (rules) { fullPrompt += rules + '\n\n'; }
      }
      fullPrompt += task.prompt ?? '';

      const totalChars = fullPrompt.length;
      const tokenEst = Math.ceil(totalChars / 4);
      const ctxPct = budgetUsage.totalCharsBudget > 0
        ? Math.round((budgetUsage.totalCharsUsed / budgetUsage.totalCharsBudget) * 100)
        : 0;

      const engine = task.engine ?? (playlist as any).engine ?? 'default';
      const taskType = task.type ?? 'agent';

      const lines: string[] = [
        `# Context Preview — "${task.name}"`,
        ``,
        `| Field | Value |`,
        `|---|---|`,
        `| Engine | \`${engine}\` |`,
        `| Type | \`${taskType}\` |`,
        `| Role | ${previewRoleId ? `\`${previewRoleId}\`${rolesEnabled ? '' : ' (roles disabled)'}` : 'none'} |`,
        `| Playlist | ${playlist.name} |`,
        `| Status | ${task.status ?? 'pending'} |`,
        ``,
        `---`,
        ``,
        `## Token Budget`,
        ``,
        `| Metric | Value |`,
        `|---|---|`,
        `| Context chars used | **${budgetUsage.totalCharsUsed.toLocaleString()} / ${budgetUsage.totalCharsBudget.toLocaleString()}** (${ctxPct}%) |`,
        `| Sections dropped | ${budgetUsage.sectionsDropped} |`,
        `| Semantic retrieval | ${budgetUsage.usedSemanticRetrieval ? `yes — ${budgetUsage.semanticSpansReturned} span${budgetUsage.semanticSpansReturned !== 1 ? 's' : ''}` : 'no'} |`,
        ...(budgetUsage.sectionBreakdown && Object.keys(budgetUsage.sectionBreakdown).length > 0
          ? [`| Sections | ${Object.entries(budgetUsage.sectionBreakdown).map(([k, v]) => `${k}: ${v.toLocaleString()}`).join(' · ')} |`]
          : []),
        `| **Total prompt** | **~${tokenEst.toLocaleString()} tokens · ${totalChars.toLocaleString()} chars** |`,
        ``,
        `---`,
        ``,
        `## Full Prompt`,
        ``,
        `\`\`\``,
        fullPrompt,
        `\`\`\``,
      ];

      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    },
  );
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
          costLabel: 'plan-generation',
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
    const json = ghSync(['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'title,body'], {
      cwd: workspaceFolder.uri.fsPath,
      timeout: 15000,
    });
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
          costLabel: 'plan-generation',
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
  currentPlan.sourceIssues = [{ repo: `${owner}/${repo}`, number: parseInt(issueNumber, 10), title: issueTitle }];
  currentPlan.playlists = playlists.map(pl => {
    const playlist = createPlaylist(pl.name);
    const parsedRole = (pl as ParsedPlanPlaylist).role;
    if (isRoleId(parsedRole)) { playlist.role = parsedRole; }
    if ((pl as ParsedPlanPlaylist).testPhase) { playlist.testPhase = true; }
    if ((pl as ParsedPlanPlaylist).prdContext) { playlist.prdContext = (pl as ParsedPlanPlaylist).prdContext; }
    for (const t of pl.tasks) {
      const task = createTask(t.name, t.prompt);
      const pt = t as ParsedPlanTask;
      if (pt.type) { task.type = pt.type as TaskType; }
      if (pt.command) { task.command = pt.command; }
      playlist.tasks.push(task);
    }
    return playlist;
  });
  injectTestTaskIfMissing(currentPlan, cwd);
  currentPlanPath = getNewPlanSavePath() || path.join(cwd, `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Plan created from issue #${issueNumber}: "${planName}" — ${currentPlan.playlists.reduce((s, p) => s + p.tasks.length, 0)} tasks.`);
}

// ─── GitHub Integration: report issue ───

function collectRunFriction(runId: string, durationMs: number): RunFrictionReport {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const entries = historyStore.getForRun(runId);
  const session = runSessionStore.get(runId);
  const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';

  // Group entries by taskId to detect retries
  const byTask = new Map<string, typeof entries>();
  for (const e of entries) {
    const group = byTask.get(e.taskId) ?? [];
    group.push(e);
    byTask.set(e.taskId, group);
  }

  // Project type from analyzeProject
  let projectType = 'unknown';
  try {
    const analysis = analyzeProject(cwd);
    projectType = [analysis.language, analysis.framework].filter(Boolean).join(' / ');
  } catch { /* best-effort */ }

  const dominantEngine = session?.engines?.[0] ?? (entries[0]?.engine ?? 'unknown');

  const friction: RunFrictionReport['friction'] = [];
  const errorCats: Record<string, number> = {};

  for (const [taskId, group] of byTask) {
    const isEscalated = escalatedTaskIds.has(taskId);
    const wasAutoFixed = group.some(e => e.autoFixed);
    const attempts = group.length;
    const lastFailed = [...group].reverse().find(e => e.status === 'failed' || e.status === 'blocked');
    const hasFriction = attempts > 1 || isEscalated || lastFailed;
    if (!hasFriction) { continue; }

    const errorSummary = lastFailed
      ? (lastFailed.result.stderr || lastFailed.result.stdout || '')
          .split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
      : '';

    // Detect error category from stderr prefix patterns
    const stderr = lastFailed?.result.stderr ?? '';
    if (/error ts\d+|typeerror|syntaxerror|cannot find/i.test(stderr)) { errorCats['compile'] = (errorCats['compile'] ?? 0) + 1; }
    else if (/assertionerror|test.*fail|failing.*test|expect.*received/i.test(stderr)) { errorCats['test'] = (errorCats['test'] ?? 0) + 1; }
    else if (/etimedout|timed out|timeout/i.test(stderr)) { errorCats['timeout'] = (errorCats['timeout'] ?? 0) + 1; }
    else if (/spawn.*enoent|command not found|not installed/i.test(stderr)) { errorCats['cli-missing'] = (errorCats['cli-missing'] ?? 0) + 1; }
    else if (lastFailed) { errorCats['unknown'] = (errorCats['unknown'] ?? 0) + 1; }

    friction.push({ taskName: group[0].taskName, attempts, escalated: isEscalated, autoFixed: wasAutoFixed, errorSummary: errorSummary.substring(0, 120) });
  }

  return {
    runId,
    date: new Date().toISOString(),
    moagVersion: extVersion,
    engine: dominantEngine,
    projectType,
    summary: {
      total: executionTaskCount,
      passed: executionTaskCount - executionTasksFailed,
      failed: executionTasksFailed,
      escalated: escalatedTaskIds.size,
      durationMs,
      estimatedCostUsd: session?.totalCost ?? 0,
    },
    friction,
    errorCategories: errorCats,
  };
}

function appendFrictionLog(report: RunFrictionReport): void {
  try {
    const moagDir = getMoagDir();
    if (!moagDir) { return; }
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const logPath = path.join(moagDir, 'feedback.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(report) + '\n', 'utf-8');
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length > 20) {
      fs.writeFileSync(logPath, lines.slice(-20).join('\n') + '\n', 'utf-8');
    }
  } catch { /* best-effort */ }
}

function readLastFrictionReport(): RunFrictionReport | null {
  try {
    const moagDir = getMoagDir();
    if (!moagDir) { return null; }
    const logPath = path.join(moagDir, 'feedback.jsonl');
    if (!fs.existsSync(logPath)) { return null; }
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) { return null; }
    const report = JSON.parse(last) as RunFrictionReport;
    const age = Date.now() - new Date(report.date).getTime();
    return age < 86_400_000 ? report : null;
  } catch { return null; }
}

// ─── Internal error log — thin wrappers around src/utils/error-log.ts ────────

import type { InternalError } from './utils/error-log';
import { appendErrorLog as _appendErrorLog, readRecentErrors as _readRecentErrors } from './utils/error-log';

function appendErrorLog(err: InternalError): void {
  const moagDir = getMoagDir();
  if (!moagDir) { return; }
  _appendErrorLog(moagDir, err, moagOutputChannel ? (s) => moagOutputChannel!.appendLine(s) : undefined);
}

function readRecentErrors(n = 10): InternalError[] {
  const moagDir = getMoagDir();
  if (!moagDir) { return []; }
  return _readRecentErrors(moagDir, n);
}

async function cmdRunContextEval(): Promise<void> {
  const moagDir = getMoagDir();
  if (!moagDir) { vscode.window.showWarningMessage('No .moag directory found. Open a workspace with a plan first.'); return; }

  // Gather all history entries from historyStore
  const allEntries = historyStore.getAll?.() ?? [];

  // Compute 7 evaluation metrics from instrumented history
  const instrumented = allEntries.filter((e: import('./models/types').HistoryEntry) => e.contextBudgetUsage);
  const total = allEntries.length;
  const withCtx = instrumented.length;

  const completed = allEntries.filter((e: import('./models/types').HistoryEntry) => e.status === 'completed');
  const failed    = allEntries.filter((e: import('./models/types').HistoryEntry) => e.status === 'failed');
  const autoFixed = allEntries.filter((e: import('./models/types').HistoryEntry) => (e as import('./models/types').HistoryEntry & { autoFixed?: boolean }).autoFixed);

  const successRate = total > 0 ? Math.round((completed.length / total) * 100) : 0;
  const firstAttemptSuccess = total > 0
    ? Math.round(((completed.length - autoFixed.length) / total) * 100) : 0;

  const ctxEfficiencies = instrumented.map((e: import('./models/types').HistoryEntry) =>
    e.contextBudgetUsage!.totalCharsBudget > 0
      ? e.contextBudgetUsage!.totalCharsUsed / e.contextBudgetUsage!.totalCharsBudget
      : 0,
  );
  const avgCtxEfficiency = ctxEfficiencies.length > 0
    ? Math.round((ctxEfficiencies.reduce((a: number, b: number) => a + b, 0) / ctxEfficiencies.length) * 100) : 0;

  const signalDensities = instrumented
    .filter((e: import('./models/types').HistoryEntry) => e.contextBudgetUsage!.totalCharsUsed > 0 && (e.changedFiles?.length ?? 0) > 0)
    .map((e: import('./models/types').HistoryEntry) => (e.changedFiles?.length ?? 0) / e.contextBudgetUsage!.totalCharsUsed * 10000);
  const avgSignalDensity = signalDensities.length > 0
    ? (signalDensities.reduce((a: number, b: number) => a + b, 0) / signalDensities.length).toFixed(2) : 'n/a';

  const avgSectionsDropped = instrumented.length > 0
    ? (instrumented.reduce((a: number, e: import('./models/types').HistoryEntry) => a + (e.contextBudgetUsage!.sectionsDropped), 0) / instrumented.length).toFixed(2)
    : 'n/a';

  const tokensEntries = allEntries.filter((e: import('./models/types').HistoryEntry) => (e as import('./models/types').HistoryEntry & { tokenUsage?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } }).tokenUsage);
  const totalCostUsd = tokensEntries.reduce((a: number, e: import('./models/types').HistoryEntry) => {
    const tu = (e as import('./models/types').HistoryEntry & { tokenUsage?: { estimatedCostUsd: number } }).tokenUsage;
    return a + (tu?.estimatedCostUsd ?? 0);
  }, 0);
  const costPerSuccess = completed.length > 0 && totalCostUsd > 0
    ? `$${(totalCostUsd / completed.length).toFixed(4)}` : 'n/a';

  // Read all friction reports for retry rate
  let avgRetries = 'n/a';
  try {
    const logPath = path.join(moagDir, 'feedback.jsonl');
    if (fs.existsSync(logPath)) {
      const reports = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
        .map((l: string) => { try { return JSON.parse(l) as RunFrictionReport; } catch { return null; } })
        .filter(Boolean) as RunFrictionReport[];
      const allFriction = reports.flatMap((r: RunFrictionReport) => r.friction ?? []);
      if (allFriction.length > 0) {
        const totalAttempts = allFriction.reduce((a: number, f: { attempts: number }) => a + f.attempts, 0);
        avgRetries = (totalAttempts / allFriction.length).toFixed(2);
      }
    }
  } catch { /* best-effort */ }

  // Section breakdown averages
  const sectionTotals: Record<string, number[]> = {};
  for (const e of instrumented) {
    const bd = e.contextBudgetUsage!.sectionBreakdown ?? {};
    for (const [k, v] of Object.entries(bd)) {
      if (!sectionTotals[k]) { sectionTotals[k] = []; }
      sectionTotals[k].push(v as number);
    }
  }
  const sectionAvgRows = Object.entries(sectionTotals)
    .sort(([, a], [, b]) => b.reduce((x: number, y: number) => x + y, 0) - a.reduce((x: number, y: number) => x + y, 0))
    .map(([k, vals]) => `| ${k} | ${Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length).toLocaleString()} | ${vals.length} |`)
    .join('\n');

  const reportLines = [
    `# MOAG Context Efficiency Report`,
    ``,
    `Generated from **${total}** history entries (${withCtx} with context instrumentation).`,
    ``,
    `## Evaluation Metrics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Task success rate | ${successRate}% (${completed.length}/${total}) |`,
    `| First-attempt success | ${firstAttemptSuccess}% |`,
    `| Context efficiency ratio | ${avgCtxEfficiency}% (chars used / budget) |`,
    `| Avg signal density | ${avgSignalDensity} (files/10K chars) |`,
    `| Avg sections dropped | ${avgSectionsDropped} |`,
    `| Cost per success | ${costPerSuccess} |`,
    `| Avg retries per task | ${avgRetries} |`,
    ``,
    `## Average Chars per Section (instrumented tasks)`,
    ``,
    sectionTotals && Object.keys(sectionTotals).length > 0
      ? `| Section | Avg chars | Tasks |\n|---------|-----------|-------|\n${sectionAvgRows}`
      : `_No section breakdown data yet — run tasks to populate._`,
    ``,
    `## Interpretation`,
    ``,
    `- **Context efficiency ratio < 50%**: context budget is oversized — reduce \`maxContextChars\``,
    `- **Sections dropped > 0**: budget is too tight for some tasks — consider increasing for agent tasks`,
    `- **Signal density > 1.0**: good — each 10K chars of context drives ≥1 file change`,
    `- **First-attempt success < 70%**: agents may be getting noisy/irrelevant context`,
  ];

  const doc = await vscode.workspace.openTextDocument({ content: reportLines.join('\n'), language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function cmdAnalyzeContextWeights(): Promise<void> {
  const moagDir = getMoagDir();
  if (!moagDir) { vscode.window.showWarningMessage('No .moag directory found.'); return; }
  const all = historyStore.getAll();
  const instrumented = all.filter(e => e.contextBudgetUsage);
  if (instrumented.length < 20) {
    vscode.window.showInformationMessage(
      `Need ≥20 instrumented tasks to compute weights (have ${instrumented.length}). Run more tasks first.`,
    );
    return;
  }
  const weights = analyzeWeights(instrumented);
  saveWeights(moagDir, weights);
  invalidateWeightsCache();
  vscode.window.showInformationMessage(
    `Context weights updated from ${weights.sampleCount} tasks. Active on next task run.`,
  );
}

function buildFrictionIssueBody(report: RunFrictionReport, notes: string): string {
  const durationStr = report.summary.durationMs > 0
    ? `${Math.floor(report.summary.durationMs / 60000)}m ${Math.floor((report.summary.durationMs % 60000) / 1000)}s`
    : 'n/a';
  const costStr = report.summary.estimatedCostUsd > 0 ? `$${report.summary.estimatedCostUsd.toFixed(2)}` : 'n/a';

  const frictionTable = report.friction.length > 0
    ? `| Task | Attempts | Auto-fixed | Escalated | Error |\n` +
      `|------|----------|------------|-----------|-------|\n` +
      report.friction.map(f =>
        `| ${f.taskName.substring(0, 40)} | ${f.attempts} | ${f.autoFixed ? '✓' : '✗'} | ${f.escalated ? '✓' : '✗'} | ${f.errorSummary.substring(0, 60)} |`
      ).join('\n')
    : '_No friction points recorded._';

  const errorPatterns = Object.entries(report.errorCategories)
    .map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none';

  return [
    `## MOAG Session Feedback`,
    ``,
    `**MOAG:** v${report.moagVersion} | **Engine:** ${report.engine} | **Project:** ${report.projectType}`,
    ``,
    `### Run Summary`,
    `- ${report.summary.total} tasks total · ${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.escalated} escalated`,
    `- Duration: ${durationStr} · Est. cost: ${costStr}`,
    ``,
    `### Friction Points`,
    frictionTable,
    ``,
    `### Error Patterns`,
    errorPatterns,
    notes ? `\n### Notes\n${notes}` : '',
    ``,
    `---`,
    `*Filed automatically by MOAG v${report.moagVersion}*`,
  ].filter(l => l !== null).join('\n');
}


// --- MOAG Self-Issue Collection ---

type SelfIssueType = 'engine-not-found' | 'spawn-error' | 'context-overflow' |
  'auth-failure' | 'parse-error' | 'timeout' | 'moag-crash' | 'other';

interface SelfIssue {
  id: string; type: SelfIssueType; message: string; detail: string;
  moagVersion: string; engine: string; platform: string;
  timestamp: string; fingerprint: string; filed: boolean;
}

function classifyMoagIssue(stderr: string, exitCode: number): SelfIssueType | null {
  const s = stderr.toLowerCase();
  if (s.includes('spawn') && s.includes('enoent')) { return 'engine-not-found'; }
  if (s.includes('spawn') && (s.includes('eperm') || s.includes('eacces'))) { return 'spawn-error'; }
  if (s.includes('context length') || s.includes('context window') || s.includes('too many tokens')) { return 'context-overflow'; }
  if (s.includes('authentication') || s.includes('unauthorized') || s.includes('api key') || s.includes('401')) { return 'auth-failure'; }
  if (s.includes('syntaxerror') && s.includes('json')) { return 'parse-error'; }
  if (exitCode === 124 || (s.includes('timed out') && !s.includes('task timed out'))) { return 'timeout'; }
  return null;
}

function getSelfIssueLogPath(): string | null {
  const d = getMoagDir(); return d ? path.join(d, 'self-issues.jsonl') : null;
}

function logMoagSelfIssue(type: SelfIssueType, message: string, detail: string): void {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath) { return; }
    const moagDir = path.dirname(logPath);
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const fingerprint = type + ':' + detail.substring(0, 60).replace(/\s+/g, ' ').trim();
    if (fs.existsSync(logPath)) {
      const cutoff = Date.now() - 86400000;
      const recent = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
        .map((l: string) => { try { return JSON.parse(l) as SelfIssue; } catch { return null; } })
        .filter((e: SelfIssue | null): e is SelfIssue => !!e && new Date(e.timestamp).getTime() > cutoff);
      if (recent.some((e: SelfIssue) => e.fingerprint === fingerprint)) { return; }
    }
    const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
    const issue: SelfIssue = {
      id: 'si-' + Date.now(), type, message, detail, moagVersion: extVersion,
      engine: vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('defaultEngine', 'claude'),
      platform: process.platform, timestamp: new Date().toISOString(), fingerprint, filed: false,
    };
    fs.appendFileSync(logPath, JSON.stringify(issue) + '\n', 'utf-8');
    const all = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (all.length > 50) { fs.writeFileSync(logPath, all.slice(-50).join('\n') + '\n', 'utf-8'); }
  } catch { /* best-effort */ }
}

function readUnfiledSelfIssues(): SelfIssue[] {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath || !fs.existsSync(logPath)) { return []; }
    return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l: string) => { try { return JSON.parse(l) as SelfIssue; } catch { return null; } })
      .filter((e: SelfIssue | null): e is SelfIssue => !!e && !e.filed);
  } catch { return []; }
}

function markSelfIssuesFiled(ids: string[]): void {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath || !fs.existsSync(logPath)) { return; }
    const updated = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l: string) => {
        try { const e = JSON.parse(l) as SelfIssue; if (ids.includes(e.id)) { e.filed = true; } return JSON.stringify(e); }
        catch { return l; }
      });
    fs.writeFileSync(logPath, updated.join('\n') + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

async function cmdReviewSelfIssues(): Promise<void> {
  const issues = readUnfiledSelfIssues();
  if (issues.length === 0) {
    vscode.window.showInformationMessage('No unfiled MOAG self-issues collected yet.');
    return;
  }
  const items = issues.map(issue => ({
    label: '$(bug) ' + issue.message,
    description: new Date(issue.timestamp).toLocaleString(),
    detail: issue.type + ' · engine: ' + issue.engine + ' · v' + issue.moagVersion,
    issue, picked: true,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: issues.length + ' MOAG issue' + (issues.length > 1 ? 's' : '') + ' collected — select to file on GitHub',
    title: 'MOAG Self-Issues',
  });
  if (!selected || selected.length === 0) { return; }
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try { execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' }); }
  catch { vscode.window.showWarningMessage('Install GitHub CLI (gh) to file issues. https://cli.github.com'); return; }
  const repo = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('issueRepo', '').trim() || MOAG_REPO;
  const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
  const filedIds: string[] = [];
  for (const item of selected) {
    const { issue } = item;
    const title = '[auto] ' + issue.message + ' [v' + issue.moagVersion + ' / ' + issue.type + ']';
    const body = [
      '## Auto-collected MOAG Issue',
      '**Type:** `' + issue.type + '`  **Detected:** ' + new Date(issue.timestamp).toLocaleString(),
      '', '## Environment', '| | |', '|---|---|',
      '| **MOAG** | v' + issue.moagVersion + ' |',
      '| **Engine** | ' + issue.engine + ' |',
      '| **Platform** | ' + issue.platform + ' |',
      '', '## Detail', '```', issue.detail.substring(0, 500), '```',
      '---', '*Auto-collected by MOAG v' + extVersion + ' self-issue monitor*',
    ].join('\n');
    try {
      const tmpPath = path.join(require('os').tmpdir(), 'moag-si-' + Date.now() + '.md');
      fs.writeFileSync(tmpPath, body, 'utf-8');
      const result = ghSync(
        ['issue', 'create', '--repo', repo, '--title', title, '--body-file', tmpPath, '--label', 'bug'],
        { cwd, timeout: 20000 },
      ).trim();
      filedIds.push(issue.id);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      const url = result.split('\n').pop() || '';
      if (url) {
        vscode.window.showInformationMessage('Filed: ' + url, 'View').then((a: string | undefined) => {
          if (a === 'View') { vscode.env.openExternal(vscode.Uri.parse(url)); }
        });
      }
    } catch (err) {
      vscode.window.showErrorMessage('Failed: ' + (err instanceof Error ? err.message.substring(0, 150) : String(err)));
    }
  }
  if (filedIds.length > 0) { markSelfIssuesFiled(filedIds); }
}


// ─── Embedded report panel (replaces showInputBox for bug/feedback flows) ───

function buildReportPanelHtml(opts: {
  mode: 'bug' | 'feedback';
  title: string;
  subtitle: string;
  placeholder: string;
  contextHtml: string;
}): string {
  const { mode, title, subtitle, placeholder, contextHtml } = opts;
  const btnLabel = mode === 'bug' ? 'File Issue &rarr;' : 'Share Feedback &rarr;';
  const icon = mode === 'bug' ? '🐛' : '📊';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .header{padding:20px 24px 12px;border-bottom:1px solid var(--vscode-widget-border,#333)}
  h1{font-size:1.3em;font-weight:600;margin-bottom:6px}
  .subtitle{color:var(--vscode-descriptionForeground);font-size:.88em;line-height:1.5}
  .body{flex:1;padding:16px 24px;display:flex;flex-direction:column;gap:12px;overflow:auto}
  label{font-size:.85em;font-weight:600;color:var(--vscode-foreground);opacity:.8}
  textarea{flex:1;min-height:120px;resize:none;padding:10px 12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:4px;font-family:inherit;font-size:inherit;line-height:1.5}
  textarea:focus{outline:none;border-color:var(--vscode-focusBorder)}
  .context-box{background:var(--vscode-textBlockQuote-background,#1e1e2e);border-left:3px solid var(--vscode-textBlockQuote-border,#444);padding:10px 14px;border-radius:0 4px 4px 0;font-size:.82em;line-height:1.7;color:var(--vscode-descriptionForeground)}
  .context-box strong{color:var(--vscode-foreground)}
  .footer{padding:12px 24px;border-top:1px solid var(--vscode-widget-border,#333);display:flex;justify-content:flex-end}
  .file-btn{padding:8px 22px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:.9em;font-weight:600}
  .file-btn:hover{background:var(--vscode-button-hoverBackground)}
  .file-btn:disabled{opacity:.5;cursor:not-allowed}
</style></head><body>
<div class="header">
  <h1>${icon} ${title}</h1>
  <p class="subtitle">${subtitle}</p>
</div>
<div class="body">
  <div>
    <label>Description (optional)</label>
    <textarea id="desc" placeholder="${placeholder}" style="margin-top:6px;width:100%"></textarea>
  </div>
  <div class="context-box"><strong>Auto-included:</strong><br>${contextHtml}</div>
</div>
<div class="footer">
  <button class="file-btn" id="fileBtn">${btnLabel}</button>
</div>
<script>
  var vscode = acquireVsCodeApi();
  var desc = document.getElementById('desc');
  var fileBtn = document.getElementById('fileBtn');
  fileBtn.addEventListener('click', function() {
    fileBtn.disabled = true;
    fileBtn.textContent = 'Filing\\u2026';
    vscode.postMessage({ type: 'submitReport', description: desc.value.trim() });
  });
  desc.focus();
</script></body></html>`;
}

async function openReportPanel(
  mode: 'bug' | 'feedback',
  prefillText?: string,
  frictionReport?: RunFrictionReport | null,
  targetRepo?: string,
): Promise<void> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try { execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' }); }
  catch { vscode.window.showWarningMessage('Install GitHub CLI (gh) to file issues. https://cli.github.com'); return; }

  const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
  const detectedEngines = extensionContext?.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []) ?? [];
  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('defaultEngine', 'claude');

  let contextHtml = `MOAG v${extVersion} &nbsp;·&nbsp; VS Code v${vscode.version} &nbsp;·&nbsp; ${process.platform} &nbsp;·&nbsp; engine: ${defaultEngine}`;
  if (detectedEngines.length > 0) { contextHtml += ` (installed: ${detectedEngines.join(', ')})`; }

  let panelTitle: string, subtitle: string, placeholder: string;

  if (mode === 'bug') {
    panelTitle = 'Report MOAG Issue';
    subtitle = `Files to <code>${MOAG_REPO}</code> with environment info attached automatically.`;
    placeholder = 'e.g. task hung, wrong output, crashed on start...';
    const friction = frictionReport ?? readLastFrictionReport();
    if (friction) {
      contextHtml += `<br>Recent run: ${friction.summary.failed} failed · ${friction.summary.escalated} escalated · engine: ${friction.engine}`;
    }
    if (prefillText) {
      const snippet = prefillText.split('\n').filter(l => l.trim()).slice(0, 5).join('<br>');
      contextHtml += `<br><em>Error output: ${snippet}</em>`;
    }
  } else {
    panelTitle = 'Share Run Feedback';
    const fc = frictionReport?.friction.length ?? 0;
    subtitle = `${fc} friction point${fc !== 1 ? 's' : ''} on <strong>${frictionReport?.projectType ?? 'unknown project'}</strong> — files to <code>${targetRepo ?? MOAG_REPO}</code>.`;
    placeholder = 'What was confusing, slow, or broke unexpectedly? (optional)';
    if (frictionReport) {
      contextHtml += `<br>${frictionReport.summary.total} tasks · ${frictionReport.summary.failed} failed · ${frictionReport.summary.escalated} escalated · ${frictionReport.summary.durationMs > 0 ? Math.round(frictionReport.summary.durationMs / 60000) + 'm' : 'n/a'}`;
      const cats = Object.entries(frictionReport.errorCategories).map(([k, v]) => `${k}(${v})`).join(', ');
      if (cats) { contextHtml += ` · errors: ${cats}`; }
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'moagReportIssue', `MOAG — ${panelTitle}`, vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  panel.webview.html = buildReportPanelHtml({ mode, title: panelTitle, subtitle, placeholder, contextHtml });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type !== 'submitReport') { return; }
    panel.dispose();
    const description = message.description as string;

    if (mode === 'bug') {
      const autoTitle = `MOAG bug report [v${extVersion} / ${new Date().toISOString().substring(0, 10)}]`;
      const errLines = (prefillText ?? '').split('\n').filter(l => l.trim()).slice(0, 30).join('\n');
      const friction = frictionReport ?? readLastFrictionReport();
      const frictionSuffix = friction
        ? `\n\n**Recent run friction:**\n- ${friction.summary.failed} failed · ${friction.summary.escalated} escalated · engine: ${friction.engine}\n- Error patterns: ${Object.entries(friction.errorCategories).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`
        : '';
      // Attach recent internal extension errors to the report
      const recentErrs = readRecentErrors(15);
      const errorLogSection = recentErrs.length > 0
        ? `\n\n## Extension Error Log (last ${recentErrs.length})\n\`\`\`\n` +
          recentErrs.map(e =>
            `[${e.ts.substring(0, 19)}] [${e.category}] ${e.message}` +
            (e.context ? ` | ${e.context}` : '') +
            (e.stack ? `\n  ${(e.stack.split('\n')[1] ?? '').trim()}` : '')
          ).join('\n') +
          '\n```'
        : '';

      const bodyParts = [
        '## Environment', '| | |', '|---|---|',
        `| **MOAG** | v${extVersion} |`,
        `| **VS Code** | v${vscode.version} |`,
        `| **Platform** | ${process.platform} |`,
        `| **Engine** | ${defaultEngine} (detected: ${detectedEngines.join(', ') || 'none'}) |`,
        errLines ? `\n## Error Output\n\`\`\`\n${errLines}\n\`\`\`` : '',
      ].filter(Boolean).join('\n');
      const fullBody = [description, bodyParts + frictionSuffix + errorLogSection].filter(Boolean).join('\n\n');
      const cfgForReport = vscode.workspace.getConfiguration('agentTaskPlayer');
      const repo = cfgForReport.get<string>('issueRepo', '').trim() || MOAG_REPO;
      const syncLabel = cfgForReport.get<string>('issueSync.label', '').trim() || 'moag';
      const tmpPath = path.join(os.tmpdir(), `moag-bug-${Date.now()}.md`);
      // Verify gh is available and authenticated (exit code 0 = ok, non-zero = not auth'd, ENOENT = not installed)
      try {
        execSync('gh auth status', { cwd, timeout: 8000, stdio: 'ignore' });
      } catch (authErr) {
        const msg = authErr instanceof Error ? authErr.message : String(authErr);
        if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('not recognized')) {
          vscode.window.showErrorMessage('GitHub CLI (gh) is not installed. Install from https://cli.github.com');
        } else {
          vscode.window.showErrorMessage('GitHub CLI (gh) is not authenticated. Run "gh auth login" in a terminal first.');
        }
        return;
      }
      try {
        fs.writeFileSync(tmpPath, fullBody, 'utf-8');
        // Ensure labels exist (idempotent)
        try { ghSync(['label', 'create', 'bug', '--repo', repo, '--color', 'd73a4a', '--description', "Something isn't working", '--force'], { cwd, timeout: 8000 }); } catch { /* already exists */ }
        try { ghSync(['label', 'create', syncLabel, '--repo', repo, '--color', '0075ca', '--description', 'MOAG task sync', '--force'], { cwd, timeout: 8000 }); } catch { /* already exists */ }
        const rawOut = ghSync(['issue', 'create', '--repo', repo, '--title', autoTitle, '--body-file', tmpPath, '--label', 'bug', '--label', syncLabel], { cwd, timeout: 20000 });
        const url = rawOut.trim().split('\n').filter(l => l.includes('github.com')).pop() || rawOut.trim().split('\n').pop() || '';
        if (!url.includes('github.com')) {
          vscode.window.showErrorMessage(`Issue creation returned unexpected output: ${rawOut.substring(0, 200)}`);
          return;
        }
        const action = await vscode.window.showInformationMessage(`Issue filed: ${url}`, 'View Issue');
        if (action === 'View Issue') { vscode.env.openExternal(vscode.Uri.parse(url)); }
        // Immediately poll so the new issue appears as a task without waiting for the interval
        void vscode.commands.executeCommand('agentTaskPlayer.ghSyncPollNow');
      } catch (err) {
        const msg = err instanceof Error ? err.message.substring(0, 300) : String(err);
        appendErrorLog({ ts: new Date().toISOString(), category: 'github', message: msg, context: 'gh issue create (bug report)' });
        vscode.window.showErrorMessage(`Failed to create issue: ${msg}`);
      }
      finally { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }

    } else {
      if (!frictionReport) { return; }
      const fc = frictionReport.friction.length;
      const title = `Session feedback: ${fc} friction point${fc !== 1 ? 's' : ''} on ${frictionReport.projectType} [${frictionReport.date.substring(0, 10)}]`;
      const body = buildFrictionIssueBody(frictionReport, description);
      const repo = targetRepo ?? MOAG_REPO;
      const tmpPath = path.join(os.tmpdir(), `moag-feedback-${Date.now()}.md`);
      try {
        fs.writeFileSync(tmpPath, body, 'utf-8');
        const url = ghSync(['issue', 'create', '--repo', repo, '--title', title, '--body-file', tmpPath, '--label', 'feedback'], { cwd, timeout: 20000 }).trim().split('\n').pop() || '';
        const action = await vscode.window.showInformationMessage(`Feedback filed: ${url}`, 'View Issue');
        if (action === 'View Issue' && url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
      } catch {
        try {
          fs.writeFileSync(tmpPath, body, 'utf-8');
          const url = ghSync(['issue', 'create', '--repo', repo, '--title', title, '--body-file', tmpPath], { cwd, timeout: 20000 }).trim().split('\n').pop() || '';
          const action = await vscode.window.showInformationMessage(`Feedback filed: ${url}`, 'View Issue');
          if (action === 'View Issue' && url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
        } catch (e2) { vscode.window.showErrorMessage(`Failed to file feedback: ${e2 instanceof Error ? e2.message.substring(0, 200) : String(e2)}`); }
      } finally { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
    }
  });
}

async function cmdShareRunFeedback(): Promise<void> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const report = readLastFrictionReport();
  if (!report) {
    vscode.window.showInformationMessage('No recent friction data found. Run a plan first.');
    return;
  }

  // 3-tier repo resolution: setting → git remote → MOAG repo
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  let repo = cfg.get<string>('issueRepo', '').trim();
  if (!repo) {
    try {
      const remote = execSync('git remote get-url origin', { cwd, timeout: 5000 }).toString().trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) { repo = `${m[1]}/${m[2]}`; }
    } catch { /* no remote */ }
  }
  if (!repo) { repo = MOAG_REPO; }

  await openReportPanel('feedback', undefined, report, repo);
}

async function cmdReportIssue(prefillText?: string): Promise<void> {
  await openReportPanel('bug', prefillText);
}

// ─── GitHub Integration: plan from open issues ───

async function cmdPlanFromOpenIssues(): Promise<void> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { UserMsg.showError(UserMsg.noWorkspace()); return; }
  const cwd = workspaceFolder.uri.fsPath;

  try {
    execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' });
  } catch {
    vscode.window.showWarningMessage('Install GitHub CLI (gh) to use Plan from Open Issues. https://cli.github.com');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  let repo = cfg.get<string>('issueRepo', '').trim();
  if (!repo) {
    try {
      const remote = execSync('git remote get-url origin', { cwd, timeout: 5000 }).toString().trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) { repo = `${m[1]}/${m[2]}`; }
    } catch { /* no remote */ }
  }
  if (!repo) {
    const input = await vscode.window.showInputBox({
      prompt: 'GitHub repo to load issues from (owner/repo)',
      placeHolder: 'e.g. myorg/moag',
    });
    if (!input?.trim()) { return; }
    repo = input.trim();
  }

  const labelInput = await vscode.window.showInputBox({
    prompt: 'Label filter (leave blank for all open issues)',
    placeHolder: 'e.g. bug',
    value: 'bug',
  });
  if (labelInput === undefined) { return; }

  let issues: Array<{ number: number; title: string; body: string }> = [];
  try {
    const listArgs = ['issue', 'list', '--repo', repo, '--state', 'open'];
    if (labelInput.trim()) { listArgs.push('--label', labelInput.trim()); }
    listArgs.push('--json', 'number,title,body', '--limit', '20');
    const json = ghSync(listArgs, { cwd, timeout: 20000 });
    issues = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to fetch issues: ${msg.substring(0, 200)}`);
    return;
  }

  if (issues.length === 0) {
    vscode.window.showInformationMessage(`No open issues found on ${repo}${labelInput.trim() ? ` with label "${labelInput.trim()}"` : ''}.`);
    return;
  }

  const issuesSummary = issues.map(i =>
    `#${i.number}: ${i.title}\n${(i.body ?? '').substring(0, 400)}`,
  ).join('\n\n---\n\n');

  const rawIdea = `Fix the following open GitHub issues on ${repo}:\n\n${issuesSummary}`;
  const defaultEngine = cfg.get<EngineId>('defaultEngine', 'claude' as EngineId);
  const projectAnalysis = analyzeProject(cwd);
  const projectContext = formatAnalysis(projectAnalysis);

  let planName = `Fix ${issues.length} issue${issues.length > 1 ? 's' : ''} — ${repo}`;
  let playlists: Array<{ name: string; engine?: string; tasks: Array<{ name: string; prompt: string }> }> = [];

  try {
    const engine = getEngine(defaultEngine);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Generating plan from ${issues.length} issues...` },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());
        const result = await engine.runTask({
          prompt: PLAN_GENERATION_PROMPT_LARGE + '\n\nProject context:\n' + projectContext + '\n\nUser description:\n' + rawIdea,
          cwd,
          signal: abortController.signal,
          costLabel: 'plan-generation',
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
    playlists = issues.map(i => ({
      name: `#${i.number}: ${i.title.substring(0, 50)}`,
      tasks: [{ name: i.title.substring(0, 60), prompt: `Fix GitHub issue #${i.number}: ${i.title}\n\n${i.body ?? ''}` }],
    }));
  }

  currentPlan = createEmptyPlan(planName);
  currentPlan.description = `From ${issues.length} open issues on ${repo}`;
  currentPlan.sourceIssues = issues.map(i => ({ repo, number: i.number, title: i.title }));
  currentPlan.playlists = playlists.map(pl => {
    const playlist = createPlaylist(pl.name);
    for (const t of pl.tasks) { playlist.tasks.push(createTask(t.name, t.prompt)); }
    return playlist;
  });
  currentPlanPath = getNewPlanSavePath() || path.join(cwd, `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`);
  saveAndRefresh();
  const taskTotal = playlists.reduce((s, p) => s + p.tasks.length, 0);
  vscode.window.showInformationMessage(
    `Plan created from ${issues.length} issues: "${planName}" — ${taskTotal} task${taskTotal !== 1 ? 's' : ''}.`,
    'Open Dashboard',
  ).then(action => { if (action === 'Open Dashboard') { void vscode.commands.executeCommand('agentTaskPlayer.showDashboard'); } });
}

// ─── GitHub Integration: close source issues after successful plan run ───

async function cmdCloseSourceIssues(sourceIssues: Array<{ repo: string; number: number; title: string }>): Promise<void> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  try { execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' }); }
  catch { vscode.window.showWarningMessage('Install GitHub CLI (gh) to close issues. https://cli.github.com'); return; }

  const items = sourceIssues.map(i => ({
    label: `$(issues) #${i.number}: ${i.title}`,
    description: i.repo,
    issue: i,
    picked: true,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Close Resolved Issues',
    placeHolder: 'Select issues to close on GitHub',
  });
  if (!selected || selected.length === 0) { return; }

  const commentBody = `Resolved by MOAG automated plan. All tasks completed successfully.`;
  const closed: string[] = [];
  for (const item of selected) {
    const { issue } = item;
    try {
      ghSync(['issue', 'comment', String(issue.number), '--repo', issue.repo, '--body', commentBody], { cwd, timeout: 15000, stdio: 'ignore' });
      ghSync(['issue', 'close', String(issue.number), '--repo', issue.repo], { cwd, timeout: 15000, stdio: 'ignore' });
      closed.push(`#${issue.number}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to close #${issue.number}: ${err instanceof Error ? err.message.substring(0, 100) : String(err)}`);
    }
  }
  if (closed.length > 0) {
    vscode.window.showInformationMessage(`Closed ${closed.join(', ')} on GitHub.`);
  }
}

// ─── GitHub Issue Sync: Auto-polling ───

function stopIssuePolling(): void {
  if (issuePollInterval !== null) {
    clearInterval(issuePollInterval);
    issuePollInterval = null;
  }
}

function startIssuePolling(context: vscode.ExtensionContext): void {
  stopIssuePolling();
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  if (!cfg.get<boolean>('issueSync.enabled', false)) { return; }
  const intervalMs = Math.max(60_000, cfg.get<number>('issueSync.pollIntervalMs', 300_000));
  const label = cfg.get<string>('issueSync.label', 'moag');

  // Seed known numbers from current plan to avoid re-importing existing tasks
  issueSyncKnownNumbers.clear();
  const plan = getActivePlan();
  if (plan?.sourceIssues) {
    for (const si of plan.sourceIssues) {
      issueSyncKnownNumbers.add(`${si.repo}#${si.number}`);
    }
  }
  // Also seed from tasks that already have sourceIssueNumber
  plan?.playlists.forEach(pl => pl.tasks.forEach(t => {
    if (t.sourceIssueNumber && t.sourceIssueRepo) {
      issueSyncKnownNumbers.add(`${t.sourceIssueRepo}#${t.sourceIssueNumber}`);
    }
  }));

  void pollGitHubIssues(label);
  issuePollInterval = setInterval(() => { void pollGitHubIssues(label); }, intervalMs);
  context.subscriptions.push({ dispose: stopIssuePolling });
}

async function pollGitHubIssues(label: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  const repo = cfg.get<string>('issueRepo', '').trim();
  if (!repo) { return; }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try { ghSync(['--version'], { cwd, timeout: 5000, stdio: 'ignore' }); }
  catch { return; }

  let issues: Array<{ number: number; title: string; body: string }> = [];
  try {
    const args = ['issue', 'list', '--repo', repo, '--state', 'open'];
    if (label) { args.push('--label', label); }
    args.push('--json', 'number,title,body', '--limit', '50');
    const json = ghSync(args, { cwd, timeout: 15_000 });
    issues = JSON.parse(json);
  } catch { return; }

  const newIssues = issues.filter(i => !issueSyncKnownNumbers.has(`${repo}#${i.number}`));
  if (newIssues.length === 0) { return; }

  const plan = getActivePlan();
  if (!plan) { return; }

  // Find or create "GitHub Issues" playlist
  let targetPlaylist = plan.playlists.find(pl => pl.name === 'GitHub Issues');
  if (!targetPlaylist) {
    targetPlaylist = createPlaylist('GitHub Issues');
    plan.playlists.push(targetPlaylist);
  }

  for (const issue of newIssues) {
    const key = `${repo}#${issue.number}`;
    issueSyncKnownNumbers.add(key);
    const task = createTask(
      issue.title.substring(0, 60),
      `Fix GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body ?? ''}`,
    );
    task.sourceIssueNumber = issue.number;
    task.sourceIssueRepo = repo;
    targetPlaylist.tasks.push(task);
    if (!plan.sourceIssues) { plan.sourceIssues = []; }
    plan.sourceIssues.push({ repo, number: issue.number, title: issue.title });
  }

  issueSyncLastPoll = new Date().toISOString();
  const trackedCount = issueSyncKnownNumbers.size;
  promptViewProvider?.setIssueSyncState(issueSyncLastPoll, trackedCount);
  if (newIssues.length > 0) {
    saveAndRefresh();
    vscode.window.showInformationMessage(
      `${newIssues.length} new issue${newIssues.length > 1 ? 's' : ''} from ${repo} added to plan.`,
    );
  }
}

// ─── GitHub Issue Sync: Comment + Label helpers ───

function postIssueComment(repo: string, issueNumber: number, body: string): void {
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  if (!cfg.get<boolean>('issueSync.postComments', true)) { return; }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const safeBody = body.substring(0, 500);
  ghAsync(['issue', 'comment', String(issueNumber), '--repo', repo, '--body', safeBody], { cwd, timeout: 15_000 });
}

function applyIssueLabel(repo: string, issueNumber: number, label: string): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  ghAsync(['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', label], { cwd, timeout: 15_000 });
}

// ─── Plan from PRD ───

async function handlePrdChatAnswer(payload: { answer: string; step: number; answers: string[] }): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { return; }
  const cwd = workspaceFolder.uri.fsPath;
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  const defaultEngine = cfg.get<EngineId>('defaultEngine', 'claude' as EngineId);

  // Guard: check if any engine is available before attempting AI call
  const detectedEngines = extensionContext?.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []) ?? [];
  if (detectedEngines.length === 0) {
    promptViewProvider?.postMessage({
      type: 'prdError',
      error: 'No AI engine is set up yet. Open the MOAG Setup Guide to install one (Claude Code, Codex, Gemini, or Ollama).',
      action: { label: 'Open Setup Guide', command: 'agentTaskPlayer.setupGuide' },
    });
    return;
  }

  const engine = getEngine(defaultEngine);

  const analysis = analyzeProject(cwd);
  const stackContext = formatAnalysis(analysis);

  const postToSidebar = (msg: Record<string, unknown>) => promptViewProvider?.postMessage(msg);

  if (payload.step === 1) {
    // Step 1: user described the feature — ask one follow-up question
    const prompt = `A developer wants to build a new feature. They described it as:
"${payload.answer}"

The codebase uses: ${stackContext}

Ask ONE focused follow-up question (under 30 words) to get the most important missing info needed to write acceptance criteria. Focus on: UI presence, key user actions, edge cases, or integrations. Do NOT number the question or add preamble — just the question itself.`;

    try {
      // The await stays INSIDE this try: handlePrdChatAnswer is invoked as a
      // floating `void handlePrdChatAnswer(...)`, so an abort rejection escaping
      // here would become an unhandled rejection and kill the extension host.
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'MOAG is drafting a follow-up question…',
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          const sub = token.onCancellationRequested(() => abort.abort());
          try {
            return await engine.runTask({ prompt, cwd, signal: abort.signal, costLabel: 'prd-chat' });
          } finally {
            sub.dispose();
          }
        },
      );
      const question = (result.stdout || '').trim() || 'Any specific acceptance criteria or edge cases to include?';
      postToSidebar({ type: 'prdMoagQuestion', question });
    } catch {
      postToSidebar({ type: 'prdError', error: 'Could not reach AI engine' });
    }

  } else {
    // Step 2: enough context — generate full PRD then open panel
    const [desc, followUp] = payload.answers;
    const prompt = `You are a senior product manager. Generate a structured PRD in Markdown based on this conversation:

Feature description: "${desc}"
Follow-up answer: "${followUp || 'N/A'}"
Codebase: ${stackContext}

Write the PRD with these sections:
## Feature: <name>
## Overview
<1-2 sentences>
## Goals
- bullet points
## Acceptance Criteria
AC1: ...
AC2: ...
AC3: ...
## Technical Notes
<relevant notes based on the codebase context>

Return ONLY the PRD markdown. No preamble, no explanation.`;

    try {
      // As above: the await must not escape this try/catch.
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'MOAG is writing your PRD…',
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          const sub = token.onCancellationRequested(() => abort.abort());
          try {
            return await engine.runTask({ prompt, cwd, signal: abort.signal, costLabel: 'prd-chat' });
          } finally {
            sub.dispose();
          }
        },
      );
      const prdText = (result.stdout || '').trim();
      if (!prdText) {
        postToSidebar({ type: 'prdError', error: 'AI returned empty PRD' });
        return;
      }
      // Tell the sidebar the chat phase is done
      postToSidebar({ type: 'prdConvertReady' });
      // Open the PRD panel pre-filled with the generated PRD
      await openPrdPanel(prdText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      postToSidebar({ type: 'prdError', error: msg.substring(0, 120) });
    }
  }
}

async function cmdSavePrdToPlan(prdText: string): Promise<void> {
  const plan = getActivePlan();
  if (!plan) {
    vscode.window.showWarningMessage('No active plan — open or create a plan first.');
    return;
  }
  plan.prdSource = prdText;
  if (currentPlanPath) { savePlan(plan, currentPlanPath); }
  if (promptViewProvider) { syncPromptProviderSidebar(promptViewProvider); }
  vscode.window.showInformationMessage('PRD saved to plan — use "Verify Against PRD" after your test playlist runs.');
}

async function cmdOpenPrdFromPlan(args?: { prdOverride?: string }): Promise<void> {
  if (args?.prdOverride) {
    await openPrdPanel(args.prdOverride);
    return;
  }
  const plan = getActivePlan();
  if (plan?.prdSource) {
    await openPrdPanel(plan.prdSource);
    return;
  }
  const detectedRel = detectPrdFileInWorkspace();
  if (detectedRel) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const fsLib = require('fs') as typeof import('fs');
    const pathLib = require('path') as typeof import('path');
    const text = fsLib.readFileSync(pathLib.join(cwd, detectedRel), 'utf-8');
    await openPrdPanel(text);
    return;
  }
  // Nothing found — fall through to the file picker
  await cmdPlanFromPRD();
}

async function openPrdPanel(prefill = '', versions?: { version: string; text: string; createdAt: string }[]): Promise<void> {
  const plan = getActivePlan();
  const resolvedVersions = versions ?? plan?.prdVersions ?? [];
  const panel = vscode.window.createWebviewPanel(
    'moagPrdInput',
    'MOAG — Generate Plan from PRD',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  panel.webview.html = buildPrdPanelHtml(prefill, resolvedVersions);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === 'openPrdFile') {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false, filters: { 'PRD files': ['md', 'txt'] }, title: 'Open PRD file',
      });
      if (uris?.[0]) {
        const fsLib = require('fs') as typeof import('fs');
        panel.webview.postMessage({ type: 'prdFileContent', text: fsLib.readFileSync(uris[0].fsPath, 'utf-8') });
      }
    } else if (message.type === 'savePrdFile') {
      const saveUri = await vscode.window.showSaveDialog({
        filters: { 'Markdown': ['md'], 'Text': ['txt'] },
        defaultUri: vscode.Uri.file(
          (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') + '/prd.md',
        ),
        title: 'Save PRD as file',
      });
      if (saveUri) {
        const fsLib = require('fs') as typeof import('fs');
        fsLib.writeFileSync(saveUri.fsPath, message.text as string, 'utf-8');
        vscode.window.showInformationMessage(`PRD saved: ${saveUri.fsPath}`);
      }
    } else if (message.type === 'loadFromGitHubIssue') {
      const input = await vscode.window.showInputBox({
        prompt: 'GitHub issue URL or #number',
        placeHolder: 'https://github.com/owner/repo/issues/123  or  #123',
      });
      if (!input) { return; }
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      let owner = '', issueRepo = '', issueNumber = '';
      const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
      if (urlMatch) { [, owner, issueRepo, issueNumber] = urlMatch; }
      else {
        const numMatch = input.match(/#?(\d+)/);
        if (numMatch) {
          issueNumber = numMatch[1];
          try {
            const { execSync } = require('child_process') as typeof import('child_process');
            const remote = execSync('git remote get-url origin', { cwd, timeout: 5000 }).toString().trim();
            const rm = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
            if (rm) { [, owner, issueRepo] = rm; }
          } catch { /* ignore */ }
        }
      }
      if (!owner || !issueRepo || !issueNumber) {
        vscode.window.showWarningMessage('Could not parse GitHub issue. Use format: https://github.com/owner/repo/issues/123');
        return;
      }
      let issueTitle = '', issueBody = '';
      try {
        const json = ghSync(['issue', 'view', String(issueNumber), '--repo', `${owner}/${issueRepo}`, '--json', 'title,body'], { cwd, timeout: 15000 });
        const parsed = JSON.parse(json);
        issueTitle = parsed.title || ''; issueBody = parsed.body || '';
      } catch {
        try {
          const https = require('https') as typeof import('https');
          const data = await new Promise<string>((resolve, reject) => {
            const req = https.get(`https://api.github.com/repos/${owner}/${issueRepo}/issues/${issueNumber}`, {
              headers: { 'User-Agent': 'MOAG-VSCode', Accept: 'application/vnd.github+json' },
            }, (res: import('http').IncomingMessage) => {
              let body = ''; res.on('data', (c: Buffer) => { body += c.toString(); }); res.on('end', () => resolve(body));
            }); req.on('error', reject); req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
          });
          const parsed = JSON.parse(data); issueTitle = parsed.title || ''; issueBody = parsed.body || '';
        } catch { vscode.window.showErrorMessage('Failed to fetch GitHub issue.'); return; }
      }
      if (!issueTitle) { vscode.window.showWarningMessage('Issue not found or empty.'); return; }
      const formatted = `# ${issueTitle}\n\n${issueBody}`;
      panel.webview.postMessage({
        type: 'prdFromIssueLoaded',
        text: formatted,
        sourceIssue: { repo: `${owner}/${issueRepo}`, number: parseInt(issueNumber, 10), title: issueTitle },
      });
    } else if (message.type === 'generatePlanFromPrd') {
      const si = message.sourceIssue as { repo: string; number: number; title: string } | null;
      panel.dispose();
      await generatePlanFromPrdText(message.prdText as string);
      if (si && currentPlan) { currentPlan.sourceIssues = [si]; saveAndRefresh(); }
    } else if (message.type === 'prdAiImprove') {
      await handlePrdAiImprove(message.text as string, (result) => panel.webview.postMessage({ type: 'prdAiImproveResult', text: result }));
    } else if (message.type === 'prdAiDraft') {
      panel.dispose();
      await cmdPlanFromPRD();
    } else if (message.type === 'openPrdInBrowser') {
      await openPrdInBrowser(message.text as string);
    } else if (message.type === 'savePrdVersion') {
      const saved = savePrdVersionToActivePlan(message.text as string, message.version as string);
      panel.webview.postMessage({ type: 'prdVersionSaved', versions: saved.versions, version: saved.version });
    }
  });
  // Pre-fill after panel loads
  if (prefill) {
    setTimeout(() => panel.webview.postMessage({ type: 'prdFileContent', text: prefill }), 400);
  }
}

function gatherProjectContext(cwd: string): string {
  const parts: string[] = [];
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const deps = Object.keys({ ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) }).slice(0, 25);
      if (pkg.name) { parts.push(`Project name: ${pkg.name}`); }
      if (pkg.description) { parts.push(`Description: ${pkg.description}`); }
      if (deps.length) { parts.push(`Key dependencies: ${deps.join(', ')}`); }
    }
  } catch { /* ignore */ }
  try {
    const readmePath = path.join(cwd, 'README.md');
    if (fs.existsSync(readmePath)) {
      parts.push(`README (first 800 chars):\n${fs.readFileSync(readmePath, 'utf-8').slice(0, 800)}`);
    }
  } catch { /* ignore */ }
  try {
    const entries = fs.readdirSync(cwd).filter(e => !e.startsWith('.') && e !== 'node_modules' && e !== 'dist' && e !== 'out');
    parts.push(`Workspace top-level: ${entries.join(', ')}`);
  } catch { /* ignore */ }
  try {
    const srcPath = path.join(cwd, 'src');
    if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
      parts.push(`src/ contains: ${fs.readdirSync(srcPath).slice(0, 30).join(', ')}`);
    }
  } catch { /* ignore */ }
  return parts.join('\n') || '(workspace context unavailable)';
}

function getProjectMeta(): { name: string; stack: string } {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const wsName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as Record<string, unknown>;
    const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, unknown>;
    const tags: string[] = [];
    if (deps['typescript'] || deps['ts-node']) { tags.push('TypeScript'); }
    if (deps['next']) { tags.push('Next.js'); }
    else if (deps['react']) { tags.push('React'); }
    if (deps['vue']) { tags.push('Vue'); }
    if (deps['express']) { tags.push('Express'); }
    if (deps['@types/vscode'] || (pkg.engines as Record<string, unknown>)?.['vscode']) { tags.push('VS Code Ext'); }
    if (deps['tailwindcss']) { tags.push('Tailwind'); }
    return { name: (pkg.name as string) || wsName, stack: tags.slice(0, 3).join(' · ') };
  } catch {
    return { name: wsName, stack: '' };
  }
}

async function handlePrdAiImprove(text: string, onResult: (improved: string) => void): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  const defaultEngine = cfg.get<EngineId>('defaultEngine', 'claude' as EngineId);
  const engine = getEngine(defaultEngine);

  // If text is short or looks like an instruction rather than a PRD, generate from project context
  const looksLikePrd = text.trim().length > 400 || /^#{1,3}\s|acceptance criteria|AC[0-9]*[:.]/im.test(text);
  let prompt: string;

  if (!looksLikePrd) {
    const projectCtx = gatherProjectContext(cwd);
    const instruction = text.trim() || 'Generate a PRD for this project';
    prompt = `You are a senior product manager. The developer asks: "${instruction}"

Using the project context below, write a complete Product Requirements Document (PRD) in Markdown.

Use this structure:
# [Feature / Product Name]

## Overview
[1-2 sentence summary]

## Goals
- ...

## User Stories
- As a ..., I want ..., so that ...

## Acceptance Criteria
- AC1: ...
- AC2: ...
- [ ] (use checkbox format for testable criteria)

## Technical Notes
[Constraints, APIs, key implementation details]

## Out of Scope
[What this PRD explicitly does NOT cover]

Project context:
${projectCtx}

Return ONLY the PRD markdown. No preamble, no explanation.`;
  } else {
    prompt = `You are a senior product manager. Improve the following PRD: sharpen ambiguous acceptance criteria, add missing edge cases, fill gaps in technical notes, and clarify the overview. Return ONLY the improved PRD markdown — keep the same structure, no preamble.\n\nPRD:\n${text}`;
  }

  try {
    // Await inside the try: this is also called as a floating promise
    // (`void handlePrdAiImprove(...)`), so an abort must not escape.
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'MOAG is improving your PRD…',
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        try {
          return await engine.runTask({ prompt, cwd, signal: abort.signal, costLabel: 'prd-improve' });
        } finally {
          sub.dispose();
        }
      },
    );
    const improved = result.stdout.trim();
    onResult(improved || text);
  } catch (err) {
    vscode.window.showErrorMessage(`AI improve failed: ${err instanceof Error ? err.message : String(err)}`);
    onResult(text);
  }
}

async function openPrdInBrowser(text: string): Promise<void> {
  const plan = getActivePlan();
  const moagDir = ensureMoagDir();
  if (!moagDir) { vscode.window.showErrorMessage('Could not create .moag directory.'); return; }
  const html = buildPrdBrowserHtml(text, plan?.name ?? 'PRD', plan?.prdVersions ?? []);
  const outPath = path.join(moagDir, 'prd-preview.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  await vscode.env.openExternal(vscode.Uri.file(outPath));
}

function savePrdVersionToActivePlan(text: string, version: string): { versions: { version: string; text: string; createdAt: string }[]; version: string } {
  const plan = getActivePlan();
  const newEntry = { version, text, createdAt: new Date().toISOString() };
  if (plan) {
    const { versions, dropped } = appendPrdVersion(plan.prdVersions, newEntry);
    plan.prdVersions = versions;
    plan.prdSource = text;
    if (currentPlanPath) { savePlan(plan, currentPlanPath); }
    if (promptViewProvider) { syncPromptProviderSidebar(promptViewProvider); }
    vscode.window.showInformationMessage(
      dropped > 0
        ? `PRD saved as ${version} — ${dropped} oldest snapshot${dropped !== 1 ? 's' : ''} removed (keeping the last ${MAX_PRD_VERSIONS}).`
        : `PRD saved as ${version}`,
    );
    return { versions: plan.prdVersions, version };
  }
  return { versions: [newEntry], version };
}

function buildPrdBrowserHtml(prdText: string, planName: string, versions: { version: string; createdAt: string }[]): string {
  const safe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rendered = safe(prdText)
    .replace(/^## (.+)$/gm, '</p><h2>$1</h2><p>')
    .replace(/^### (.+)$/gm, '</p><h3>$1</h3><p>')
    .replace(/^# (.+)$/gm, '</p><h1>$1</h1><p>')
    .replace(/^- \[ \] (.+)$/gm, '</p><li class="ac">&#9744; $1</li><p>')
    .replace(/^- \[x\] (.+)$/gm, '</p><li class="ac done">&#9745; $1</li><p>')
    .replace(/^- (.+)$/gm, '</p><li>$1</li><p>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  const versionsHtml = versions.length > 0
    ? `<div class="versions">${versions.map(v => `<span class="vpill">${safe(v.version)}</span>`).join('')}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRD — ${safe(planName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 820px; margin: 0 auto; padding: 40px 32px; background: #1e1e1e; color: #d4d4d4; line-height: 1.7; }
  h1 { font-size: 24px; color: #e8e8e8; border-bottom: 2px solid #0078d4; padding-bottom: 12px; margin: 0 0 20px; }
  h2 { font-size: 18px; color: #e0e0e0; margin: 28px 0 10px; }
  h3 { font-size: 15px; color: #ccc; margin: 18px 0 6px; }
  p { margin: 6px 0; } li { margin: 3px 0 3px 20px; }
  li.ac { list-style: none; margin-left: 0; font-family: 'Cascadia Code', monospace; font-size: 13px; }
  li.done { opacity: 0.55; text-decoration: line-through; }
  code { background: #2d2d2d; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  strong { color: #e0e0e0; }
  .meta { font-size: 12px; color: #555; margin-bottom: 20px; }
  .versions { margin-bottom: 16px; }
  .vpill { background: rgba(0,120,212,0.2); border: 1px solid rgba(0,120,212,0.4); color: #4fc3f7; border-radius: 12px; padding: 2px 10px; font-size: 11px; margin-right: 6px; }
</style>
</head>
<body>
<div class="meta">Generated by MOAG &mdash; ${new Date().toLocaleString()}</div>
${versionsHtml}
<p>${rendered}</p>
</body>
</html>`;
}

function cmdShowSetupGuide(ctx: vscode.ExtensionContext): void {
  const detected = ctx.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []);
  const has = (id: string) => detected.includes(id as EngineId);

  const engineRows = [
    {
      id: 'claude',
      name: 'Claude Code',
      tag: 'Recommended',
      install: 'npm install -g @anthropic-ai/claude-code',
      auth: 'Requires Anthropic account — run <code>claude</code> to sign in',
      url: 'https://docs.anthropic.com/claude-code',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      tag: 'OpenAI',
      install: 'npm install -g @openai/codex',
      auth: 'Set <code>OPENAI_API_KEY</code> environment variable',
      url: 'https://github.com/openai/codex',
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      tag: 'Google',
      install: 'npm install -g @google/gemini-cli',
      auth: 'Requires Google account — run <code>gemini</code> to sign in',
      url: 'https://github.com/google-gemini/gemini-cli',
    },
    {
      id: 'ollama',
      name: 'Ollama',
      tag: 'Local · No API key',
      install: 'Download from ollama.com, then: ollama pull llama3',
      auth: 'Runs fully local — no API key required',
      url: 'https://ollama.com',
    },
  ];

  const rowsHtml = engineRows.map(e => `
    <div class="engine-row ${has(e.id) ? 'ok' : 'missing'}">
      <div class="engine-status">${has(e.id) ? '&#10003;' : '&#10007;'}</div>
      <div class="engine-info">
        <div class="engine-name">${e.name} <span class="engine-tag">${e.tag}</span>${has(e.id) ? ' <span class="engine-found">Found</span>' : ''}</div>
        ${!has(e.id) ? `<div class="engine-install"><code>${e.install}</code></div>` : ''}
        <div class="engine-auth">${e.auth}</div>
      </div>
      ${!has(e.id) ? `<a class="engine-link" href="${e.url}" target="_blank">Docs &#8599;</a>` : ''}
    </div>`).join('');

  const allGood = detected.length > 0;
  const panel = vscode.window.createWebviewPanel(
    'moagSetupGuide', 'MOAG — Setup Guide', vscode.ViewColumn.One,
    { enableScripts: true },
  );

  panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOAG Setup Guide</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; background: #1e1e1e; color: #cccccc; min-height: 100vh; display: flex; flex-direction: column; }
.hero { padding: 32px 40px 20px; border-bottom: 1px solid #333; }
.hero h1 { font-size: 22px; font-weight: 700; color: #e8e8e8; margin-bottom: 6px; }
.hero p { color: #888; line-height: 1.5; max-width: 560px; }
.status-banner { margin: 0 40px; margin-top: 20px; padding: 10px 16px; border-radius: 6px; font-size: 12px; font-weight: 600; }
.status-banner.good { background: rgba(78,201,176,0.12); border: 1px solid rgba(78,201,176,0.3); color: #4ec9b0; }
.status-banner.warn { background: rgba(255,180,0,0.1); border: 1px solid rgba(255,180,0,0.25); color: #ffb400; }
.section { padding: 24px 40px; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #666; margin-bottom: 14px; }
.engine-row { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 1px solid #2d2d2d; border-radius: 8px; margin-bottom: 10px; background: #252525; }
.engine-row.ok { border-color: rgba(78,201,176,0.25); background: rgba(78,201,176,0.04); }
.engine-row.missing { border-color: #333; }
.engine-status { font-size: 18px; line-height: 1; margin-top: 2px; flex-shrink: 0; }
.engine-row.ok .engine-status { color: #4ec9b0; }
.engine-row.missing .engine-status { color: #555; }
.engine-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.engine-name { font-size: 13px; font-weight: 600; color: #e0e0e0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.engine-tag { font-size: 10px; font-weight: 500; color: #888; background: #333; padding: 1px 6px; border-radius: 10px; }
.engine-found { font-size: 10px; font-weight: 700; color: #4ec9b0; background: rgba(78,201,176,0.12); padding: 1px 7px; border-radius: 10px; }
.engine-install { font-size: 11px; background: #1a1a1a; border: 1px solid #3a3a3a; border-radius: 4px; padding: 5px 10px; margin-top: 4px; color: #ce9178; }
.engine-install code { font-family: 'Cascadia Code', 'Consolas', monospace; }
.engine-auth { font-size: 11px; color: #777; line-height: 1.4; }
.engine-auth code { color: #9cdcfe; font-family: monospace; }
.engine-link { font-size: 11px; color: #4fc3f7; text-decoration: none; white-space: nowrap; margin-top: 2px; flex-shrink: 0; }
.engine-link:hover { text-decoration: underline; }
.tip-box { background: #252525; border-left: 3px solid #0078d4; border-radius: 0 6px 6px 0; padding: 10px 14px; font-size: 12px; color: #999; line-height: 1.5; margin-bottom: 12px; }
.tip-box code { color: #9cdcfe; font-family: monospace; }
.footer { padding: 20px 40px 32px; display: flex; gap: 12px; align-items: center; }
.btn-primary { padding: 9px 22px; background: #0078d4; color: #fff; border: none; border-radius: 5px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn-primary:hover { background: #026ec1; }
.btn-secondary { padding: 9px 18px; background: transparent; color: #aaa; border: 1px solid #444; border-radius: 5px; font-size: 12px; cursor: pointer; }
.btn-secondary:hover { border-color: #666; color: #ccc; }
</style></head>
<body>
<div class="hero">
  <h1>&#128640; MOAG Setup Guide</h1>
  <p>MOAG needs at least one AI coding CLI installed on your machine to run tasks, draft PRDs, and verify results.</p>
</div>
${allGood
    ? `<div class="status-banner good">&#10003;&nbsp; ${detected.length} engine${detected.length > 1 ? 's' : ''} detected — you're ready to go!</div>`
    : `<div class="status-banner warn">&#9888;&nbsp; No AI engine found. Install at least one from the list below.</div>`}
<div class="section">
  <div class="section-title">AI Engines</div>
  ${rowsHtml}
</div>
<div class="section" style="padding-top:0">
  <div class="section-title">After installing</div>
  <div class="tip-box">Open a terminal and run <code>claude</code> (or the relevant CLI) once to complete authentication, then click <strong>Re-check engines</strong> below.</div>
  <div class="tip-box">MOAG uses the CLI that matches your <strong>agentTaskPlayer.defaultEngine</strong> setting. You can change it in VS Code Settings.</div>
</div>
<div class="footer">
  <button class="btn-primary" id="recheckBtn">Re-check engines</button>
  <button class="btn-secondary" id="doneBtn">Start using MOAG</button>
</div>
<script>
  var vscode = acquireVsCodeApi();
  document.getElementById('recheckBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'recheck' });
  });
  document.getElementById('doneBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'done' });
  });
</script>
</body></html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'recheck') {
      panel.dispose();
      await vscode.commands.executeCommand('agentTaskPlayer.detectEngines');
      cmdShowSetupGuide(ctx);
    } else if (msg.type === 'done') {
      panel.dispose();
    }
  });
}

async function cmdPlanFromPRD(): Promise<void> {
  await openPrdPanel();
}

// kept for direct invocation from old entry points
function buildPrdPanelHtml(prefill = '', versions: { version: string; text: string; createdAt: string }[] = []): string {
  const escapedPrefill = prefill.replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const versionsJson = JSON.stringify(versions).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Generate Plan from PRD</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; background: #1e1e1e; color: #cccccc;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }
  .header { padding: 20px 32px 12px; border-bottom: 1px solid #333; flex-shrink: 0; }
  .header h1 { font-size: 18px; font-weight: 600; color: #e0e0e0; margin-bottom: 6px; }
  .header p { font-size: 12px; color: #888; line-height: 1.5; }
  .version-bar {
    display: none; align-items: center; gap: 8px;
    padding: 10px 32px 0; flex-shrink: 0; font-size: 12px; color: #888;
  }
  .version-bar.visible { display: flex; }
  .version-select {
    background: #2d2d2d; border: 1px solid #444; color: #ccc;
    border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer;
  }
  .version-save-btn {
    padding: 4px 12px; background: transparent; border: 1px solid #444;
    color: #888; border-radius: 4px; cursor: pointer; font-size: 11px;
  }
  .version-save-btn:hover { border-color: #5a9e5a; color: #9dcc9d; }
  .body {
    flex: 1; display: flex; flex-direction: column;
    padding: 14px 32px 0; gap: 10px; min-height: 0;
  }
  .tip {
    font-size: 11px; color: #666; background: #252525;
    border-left: 3px solid #0078d4; padding: 8px 12px;
    border-radius: 0 4px 4px 0; line-height: 1.5; flex-shrink: 0;
  }
  .tip strong { color: #999; }
  .textarea-wrap { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; }
  textarea {
    flex: 1; resize: none; background: #2d2d2d; color: #d4d4d4;
    border: 1px solid #444; border-radius: 6px; padding: 14px 16px;
    font-size: 13px; font-family: 'Cascadia Code','Fira Code','Consolas',monospace;
    line-height: 1.6; outline: none; min-height: 0;
  }
  textarea:focus { border-color: #0078d4; }
  .ai-btn {
    position: absolute; bottom: 10px; right: 12px;
    font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer;
    background: rgba(0,120,212,0.15); border: 1px solid rgba(0,120,212,0.4); color: #4fc3f7;
  }
  .ai-btn:hover { background: rgba(0,120,212,0.28); }
  .ai-btn:disabled { opacity: 0.5; cursor: default; }
  .footer {
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0; padding: 10px 32px 24px; gap: 12px;
  }
  .footer-left { display: flex; align-items: center; gap: 10px; }
  .browse-btn, .save-btn, .browser-btn {
    padding: 8px 14px; background: transparent; border: 1px solid #555;
    color: #aaa; border-radius: 5px; cursor: pointer; font-size: 12px;
  }
  .browse-btn:hover, .browser-btn:hover { border-color: #0078d4; color: #d4d4d4; }
  .save-btn:hover { border-color: #5a9e5a; color: #9dcc9d; }
  .char-count { font-size: 11px; color: #666; }
  .generate-btn {
    padding: 9px 24px; background: #0078d4; color: #fff; border: none;
    border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 600; min-width: 160px;
  }
  .generate-btn:disabled { opacity: 0.4; cursor: default; }
  .generate-btn:not(:disabled):hover { background: #026ec1; }
</style>
</head>
<body>
<div class="header">
  <h1>&#128196; Generate Plan from PRD</h1>
  <p>Paste your PRD below. MOAG will generate a Design &rarr; Development &rarr; Testing plan automatically.</p>
</div>
<div class="version-bar" id="versionBar">
  <span>Version:</span>
  <select id="versionSelect" class="version-select"></select>
  <button id="versionSaveBtn" class="version-save-btn" type="button">Save as v1.0</button>
</div>
<div class="body">
  <div class="tip">
    <strong>Tip:</strong> Include acceptance criteria (<code>AC1: ...</code> or <code>- [ ] ...</code>) so MOAG builds a TEST CRITERIA checklist during the testing phase.
  </div>
  <div class="textarea-wrap">
    <textarea id="prd" placeholder="Paste your PRD here...

## Feature: User login

### Acceptance Criteria
AC1: User can log in with email and password
AC2: Invalid credentials show a clear error message
AC3: Successful login redirects to dashboard"></textarea>
    <button class="ai-btn" id="aiBtn" type="button">&#10024; Draft with AI</button>
  </div>
</div>
<div class="footer">
  <div class="footer-left">
    <button class="browse-btn" id="browseBtn">Browse .md / .txt&hellip;</button>
    <button class="browse-btn" id="issueBtn" title="Load content from a GitHub issue">&#128279; From Issue</button>
    <button class="save-btn" id="saveBtn">Save as .md</button>
    <button class="browser-btn" id="browserBtn" title="Open PRD in browser">&#127758; Open in Browser</button>
    <span class="char-count" id="charCount">0 chars</span>
  </div>
  <button class="generate-btn" id="generateBtn" disabled>Generate Plan &rarr;</button>
</div>
<script>
  var vscode = acquireVsCodeApi();
  var ta = document.getElementById('prd');
  var charCount = document.getElementById('charCount');
  var generateBtn = document.getElementById('generateBtn');
  var aiBtn = document.getElementById('aiBtn');
  var versionBar = document.getElementById('versionBar');
  var versionSelect = document.getElementById('versionSelect');
  var versionSaveBtn = document.getElementById('versionSaveBtn');
  var versions = ${versionsJson};
  var sourceIssue = null;

  function updateCount() {
    var len = ta.value.length;
    charCount.textContent = len + ' chars';
    generateBtn.disabled = len < 20;
  }
  function updateAiBtn() {
    aiBtn.textContent = ta.value.trim().length > 20 ? '\\u2728 Improve with AI' : '\\u2728 Draft with AI';
  }
  function renderVersionBar() {
    if (versions.length > 0) {
      versionBar.classList.add('visible');
      versionSelect.innerHTML = versions.map(function(v) {
        var d = new Date(v.createdAt).toLocaleDateString();
        return '<option value="' + v.version + '">' + v.version + ' (' + d + ')</option>';
      }).join('');
      versionSaveBtn.textContent = 'Save as v' + (versions.length + 1) + '.0';
    } else {
      versionBar.classList.remove('visible');
    }
  }
  renderVersionBar();

  ta.value = \`${escapedPrefill}\`;
  updateCount();
  updateAiBtn();

  ta.addEventListener('input', function() { updateCount(); updateAiBtn(); });

  versionSelect.addEventListener('change', function() {
    var ver = versions.find(function(v) { return v.version === versionSelect.value; });
    if (ver) { ta.value = ver.text; updateCount(); updateAiBtn(); }
  });

  versionSaveBtn.addEventListener('click', function() {
    var text = ta.value.trim();
    if (!text) { return; }
    var nextVersion = 'v' + (versions.length + 1) + '.0';
    vscode.postMessage({ type: 'savePrdVersion', text: text, version: nextVersion });
  });

  aiBtn.addEventListener('click', function() {
    var text = ta.value.trim();
    if (text.length > 20) {
      aiBtn.disabled = true;
      aiBtn.textContent = 'Improving\\u2026';
      vscode.postMessage({ type: 'prdAiImprove', text: text });
    } else {
      vscode.postMessage({ type: 'prdAiDraft' });
    }
  });

  document.getElementById('browseBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'openPrdFile' });
  });

  document.getElementById('issueBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'loadFromGitHubIssue' });
  });

  document.getElementById('saveBtn').addEventListener('click', function() {
    var text = ta.value.trim();
    if (!text) { return; }
    vscode.postMessage({ type: 'savePrdFile', text: text });
  });

  document.getElementById('browserBtn').addEventListener('click', function() {
    var text = ta.value.trim();
    if (!text) { return; }
    vscode.postMessage({ type: 'openPrdInBrowser', text: text });
  });

  generateBtn.addEventListener('click', function() {
    var text = ta.value.trim();
    if (!text) { return; }
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating\\u2026';
    vscode.postMessage({ type: 'generatePlanFromPrd', prdText: text, sourceIssue: sourceIssue });
  });

  window.addEventListener('message', function(e) {
    if (e.data.type === 'prdFileContent') {
      ta.value = e.data.text || ''; updateCount(); updateAiBtn(); ta.focus();
      sourceIssue = null;
    } else if (e.data.type === 'prdFromIssueLoaded') {
      ta.value = e.data.text || ''; updateCount(); updateAiBtn(); ta.focus();
      sourceIssue = e.data.sourceIssue || null;
    } else if (e.data.type === 'prdAiImproveResult') {
      ta.value = e.data.text || ta.value; updateCount(); updateAiBtn();
      aiBtn.disabled = false; updateAiBtn();
    } else if (e.data.type === 'prdVersionSaved') {
      versions = e.data.versions || versions;
      renderVersionBar();
      if (e.data.version) { versionSelect.value = e.data.version; }
    }
  });

  ta.focus();
</script>
</body>
</html>`;}


async function generatePlanFromPrdText(prdText: string): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { UserMsg.showError(UserMsg.noWorkspace()); return; }
  const cwd = workspaceFolder.uri.fsPath;

  if (!prdText) {
    vscode.window.showWarningMessage('PRD text is empty — plan generation cancelled.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  const defaultEngine = cfg.get<EngineId>('defaultEngine', 'claude' as EngineId);

  const prdPrompt = `You are a senior engineering lead. Given the Product Requirements Document (PRD) below, generate a structured JSON execution plan for an AI coding agent.

The plan MUST have up to three playlists in this order:
1. "Design" — UI/UX specs, component sketches, API contract decisions. OMIT this playlist if the PRD mentions no user interface or front-end work.
2. "Development" — implementation tasks (backend, frontend, infrastructure, migrations, etc.)
3. "Testing" — test writing, QA, edge-case coverage, accessibility checks (set "testPhase": true)

Rules:
- Each task must have: "id" (unique string e.g. "task-1"), "name" (short title), "prompt" (detailed enough for Claude Code to execute autonomously — include file paths, acceptance criteria, patterns to follow), "status": "pending"
- Task type rules — include optional "type" field (defaults to "agent"):
  - "agent"       AI coding tasks (most tasks)
  - "command"     Shell commands (test runners, builds). Set "command" field to the exact shell command (e.g., "npm test", "pytest", "go test ./..."). The Testing playlist MUST include at least one "command" task running the test suite.
  - "visual-test" Browser UI verification via screenshot + vision. For web/frontend projects only.
- Each playlist must have: "id" (unique string), "name" (string), "testPhase" (boolean — true only for Testing), "tasks" (array)
- Each playlist SHOULD have a "role" — the expert persona the agent adopts. Exactly one of:
  "architect" | "designer" | "engineer" | "reviewer" | "tester" | "devops".
  Typical mapping: Design → "designer", Development → "engineer", Testing → "tester".
  Omit the field entirely if unsure. Never invent a value outside that list.
- The root plan object must have: "version": "1.0", "name" (brief feature name derived from the PRD), "description" (one sentence), "playlists" (array)
- Return ONLY valid JSON. No markdown code fences, no explanation, no preamble.
- Keep tasks focused and atomic — one concern per task.

PRD:
${prdText}`;

  const planHolder: { json: string } = { json: '' };

  try {
    const engine = getEngine(defaultEngine);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Generating plan from PRD...' },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());
        const result = await engine.runTask({
          prompt: prdPrompt,
          cwd,
          signal: abortController.signal,
          costLabel: 'plan-generation',
        });
        if (result.exitCode === 0 && result.stdout.trim()) {
          planHolder.json = result.stdout.trim();
        }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`PRD plan generation failed: ${msg.substring(0, 200)}`);
    return;
  }

  if (!planHolder.json) {
    vscode.window.showErrorMessage('AI did not return a plan. Try again or check your API key / engine settings.');
    return;
  }

  // Strip markdown fences if the AI ignored the instruction
  const planJson = planHolder.json.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  let parsed: { version?: string; name?: string; playlists?: unknown[] };
  try {
    parsed = JSON.parse(planJson);
  } catch {
    vscode.window.showErrorMessage('AI returned invalid JSON. Try again.');
    return;
  }

  if (!parsed.version || !parsed.name || !Array.isArray(parsed.playlists) || parsed.playlists.length === 0) {
    vscode.window.showErrorMessage('Generated plan is missing required fields (version, name, playlists).');
    return;
  }

  (parsed as Record<string, unknown>).prdSource = prdText;

  // Count roles the generator invented before hydration silently coerces them away, so the
  // completion notification can say why a playlist came back without the role it asked for.
  const invalidRoleCount = (parsed.playlists as Array<{ role?: unknown }>)
    .filter(pl => pl?.role !== undefined && !isRoleId(pl.role)).length;

  // Hydrate → inject missing test runner → dehydrate back so the JSON file has the task
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hydratedPrd = hydratePlan(parsed as any);
    injectTestTaskIfMissing(hydratedPrd, cwd);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dehydrated = dehydratePlan(hydratedPrd) as any;
    dehydrated.prdSource = prdText;
    parsed = dehydrated;
  } catch { /* best-effort — proceed with unmodified parsed if hydration fails */ }

  const moagDir = ensureMoagDir();
  if (!moagDir) {
    vscode.window.showErrorMessage('Could not create .moag directory.');
    return;
  }

  const taskCount = (parsed.playlists as Array<{ tasks?: unknown[] }>).reduce((s, pl) => s + (pl.tasks?.length ?? 0), 0);
  const playlistCount = (parsed.playlists as unknown[]).length;

  // Guard against duplicates — use a deterministic path based on plan name
  const safeName = (parsed.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 40);
  const canonicalPath = path.join(moagDir, `${safeName}.agent-plan.json`);
  let planPath = canonicalPath;

  if (fs.existsSync(canonicalPath)) {
    const existing = (() => { try { return JSON.parse(fs.readFileSync(canonicalPath, 'utf-8')) as { name?: string; playlists?: unknown[] }; } catch { return null; } })();
    const existingTasks = existing?.playlists
      ? (existing.playlists as Array<{ tasks?: unknown[] }>).reduce((s, pl) => s + (pl.tasks?.length ?? 0), 0)
      : 0;
    const choice = await vscode.window.showWarningMessage(
      `A plan "${existing?.name ?? safeName}" already exists (${existingTasks} tasks). Replace it with the new plan (${taskCount} tasks)?`,
      { modal: false },
      'Replace',
      'Keep Both',
    );
    if (!choice) { return; }
    if (choice === 'Keep Both') {
      planPath = path.join(moagDir, `${safeName}-${Date.now()}.agent-plan.json`);
    }
  }

  fs.writeFileSync(planPath, JSON.stringify(parsed, null, 2), 'utf-8');

  const roleNote = invalidRoleCount > 0
    ? ` — ${invalidRoleCount} playlist${invalidRoleCount !== 1 ? 's' : ''} had an unrecognised role and will use the plan default`
    : '';
  const action = await vscode.window.showInformationMessage(
    `Plan generated — ${taskCount} task${taskCount !== 1 ? 's' : ''} across ${playlistCount} playlist${playlistCount !== 1 ? 's' : ''}${roleNote}`,
    'Open Plan',
  );
  if (action === 'Open Plan') {
    void vscode.commands.executeCommand('agentTaskPlayer.runPlanFile', planPath);
  }
}

// ─── PRD Verification ───

/**
 * Read the PRD loop configuration block.
 * Dotted keys resolve under the headless shim too, so both surfaces read the same values.
 */
function getPrdLoopConfig(cwd: string, fix: boolean): PrdLoopConfig {
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  return {
    cwd,
    maxFixIterations: cfg.get<number>('prdLoop.maxFixIterations', 3),
    gateCommands: cfg.get<string[]>('prdLoop.gateCommands', []),
    gateTimeoutMs: cfg.get<number>('prdLoop.gateTimeoutMs', 600_000),
    maxDiffChars: cfg.get<number>('prdLoop.maxDiffChars', 40_000),
    onManualGate: cfg.get<'halt' | 'skip'>('prdLoop.onManualGate', 'halt'),
    fix,
    // Interactive surface: an undetectable repo warns instead of hard-failing.
    unattended: false,
    uat: {
      mode: cfg.get<'off' | 'auto' | 'required'>('prdLoop.uat.mode', 'auto'),
      command: cfg.get<string>('prdLoop.uat.command', ''),
      specPath: cfg.get<string>('prdLoop.uat.specPath', ''),
      timeoutMs: cfg.get<number>('prdLoop.uat.timeoutMs', 900_000),
    },
  };
}

// ─── Browser UAT sandbox lease ───
//
// There is exactly ONE `sandboxManager`, and two verification loops can be live
// at once (parallelPlaylists 1-8, or Verify fired during a daemon run). Strategy:
// reference counting, serialised behind a promise chain.
//
//  * acquire/release both run inside `uatChain`, so a second loop can never
//    observe `status:'starting'` and take `launch()`'s early return at
//    sandbox-manager.ts:44 as success;
//  * a sandbox this extension started is shared, and only stopped once the LAST
//    loop has released it;
//  * a sandbox the USER started is adopted with a genuinely no-op dispose and is
//    never reference-counted — we must never kill a server we did not launch.

/** Serialises every acquire/release so the refcount cannot be raced. */
let uatChain: Promise<unknown> = Promise.resolve();
/** How many live loops hold the sandbox WE launched. */
let uatRefCount = 0;
/** The URL of the sandbox we launched, while we hold it. */
let uatLeasedUrl: string | null = null;

/** How long to wait for a freshly launched sandbox to report `running`. */
const UAT_SANDBOX_READY_TIMEOUT_MS = 120_000;

/** Run `fn` after everything already queued, keeping the chain alive on failure. */
function serializeUat<T>(fn: () => Promise<T>): Promise<T> {
  const next = uatChain.then(fn, fn);
  uatChain = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Wait for the sandbox to reach `running` with a URL.
 *
 * Resolves null on error, on stop, on abort and on timeout. The `state-changed`
 * listener is removed in every one of those paths — one leaked listener per
 * verification run would accumulate for the life of the extension host.
 */
function waitForSandboxUrl(
  mgr: SandboxManager,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (url: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        mgr.off('state-changed', onState);
        signal.removeEventListener('abort', onAbort);
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(url);
      }
    };

    const onState = (s: { status: string; url: string | null }): void => {
      if (s.status === 'running' && s.url) {
        finish(s.url);
      } else if (s.status === 'error' || s.status === 'stopped') {
        finish(null);
      }
    };
    const onAbort = (): void => finish(null);

    mgr.on('state-changed', onState);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(null), timeoutMs);

    // The sandbox may already be up — no further event would ever arrive.
    const current = mgr.state;
    if (current.status === 'running' && current.url) {
      finish(current.url);
    } else if (signal.aborted) {
      finish(null);
    }
  });
}

/** Drop one reference to the sandbox we launched, stopping it at zero. */
function releaseUatLease(): Promise<void> {
  return serializeUat(async () => {
    uatRefCount = Math.max(0, uatRefCount - 1);
    if (uatRefCount === 0 && uatLeasedUrl) {
      uatLeasedUrl = null;
      try {
        sandboxManager?.stop();
      } catch {
        // ignore — stopping is best-effort
      }
    }
  });
}

/**
 * Prepare a live application for the browser UAT gate.
 *
 * Resolves null — never rejects — when no URL can be prepared, which the loop
 * reads as "the gate could not run".
 */
async function prepareUatSession(cwd: string, signal: AbortSignal): Promise<UatSession | null> {
  try {
    return await serializeUat(async () => {
      const mgr = sandboxManager;
      if (!mgr) {
        return null;
      }
      if (signal.aborted) {
        return null;
      }

      // 1. Another loop already holds the sandbox we launched — share it.
      if (uatRefCount > 0 && uatLeasedUrl) {
        uatRefCount++;
        const url = uatLeasedUrl;
        let released = false;
        return {
          baseUrl: url,
          startedByUs: true,
          dispose: async () => {
            if (released) { return; }
            released = true;
            await releaseUatLease();
          },
        };
      }

      // 2. The user already has a server running — adopt it and NEVER kill it.
      const state = mgr.state;
      if (state.status === 'running' && state.url) {
        return {
          baseUrl: state.url,
          startedByUs: false,
          dispose: (): void => { /* deliberately no-op — we did not start it */ },
        };
      }

      // 3. Launch our own.
      const ready = waitForSandboxUrl(mgr, signal, UAT_SANDBOX_READY_TIMEOUT_MS);
      try {
        await mgr.launch(cwd, currentPlan?.sandbox);
      } catch {
        // The wait still settles via the error/stopped state or the timeout.
      }
      const url = await ready;
      if (!url) {
        return null;
      }
      uatRefCount = 1;
      uatLeasedUrl = url;
      let released = false;
      return {
        baseUrl: url,
        startedByUs: true,
        dispose: async () => {
          if (released) { return; }
          released = true;
          await releaseUatLease();
        },
      };
    });
  } catch {
    // A rejection here must never escape into the loop.
    return null;
  }
}

/**
 * Resolve the PRD text for verification, in the historical order:
 * plan.prdSource → active playlist prdContext → detected workspace file → file picker.
 * Returns null when the user dismisses the picker.
 */
async function resolvePrdTextInteractive(plan: Plan | null, cwd: string): Promise<string | null> {
  let prdText = plan?.prdSource ?? '';
  // Prefer the active (or next incomplete) playlist's own prdContext slice
  const activePl = plan?.playlists.find(pl =>
    pl.tasks.some(t => t.status === TaskStatus.Running),
  ) ?? plan?.playlists.find(pl =>
    pl.tasks.some(t => t.status !== TaskStatus.Completed),
  );
  if (activePl?.prdContext) { prdText = activePl.prdContext; }
  if (!prdText) {
    const detectedRel = detectPrdFileInWorkspace();
    if (detectedRel) {
      try { prdText = fs.readFileSync(path.join(cwd, detectedRel), 'utf-8'); } catch { /* ignore */ }
    }
  }
  if (!prdText) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'PRD files': ['md', 'txt'] },
      title: 'Select PRD file for verification',
    });
    if (!uris?.[0]) { return null; }
    try { prdText = fs.readFileSync(uris[0].fsPath, 'utf-8'); } catch { return null; }
  }
  return prdText || null;
}

/** Escape text that lands in the generated HTML report. */
function escapeReportHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Human phrasing for a halt reason. */
function describeHaltReason(reason: HaltReason): string {
  switch (reason) {
    case 'max-iterations': return 'Fix-iteration ceiling reached — manual intervention required';
    case 'no-progress': return 'The same failure recurred with no change — halted to avoid a loop';
    case 'manual-gate': return 'Halted at a manual ship gate';
    case 'budget-exceeded': return 'Halted on the cost ceiling';
    case 'aborted': return 'Cancelled';
    case 'no-prd': return 'No PRD could be resolved';
    case 'engine-error': return 'The engine did not return a usable result';
    case 'no-gates': return 'No deterministic gate commands could be resolved';
  }
}

/** Build the standalone HTML verification report opened in the browser. */
function buildVerificationReportHtml(planName: string, prdText: string, report: PrdLoopReport): string {
  const timestamp = Date.now();
  const dateStr = new Date(timestamp).toLocaleString();
  const score = report.score ?? 0;
  const scoreBadgeColor = score >= 80 ? '#28a745' : score >= 50 ? '#f0ad4e' : '#dc3545';
  const gaps: string[] = Array.isArray(report.gaps) ? report.gaps : [];
  const suggestion = report.suggestion ?? '';

  // Render PRD source as formatted text with acceptance criteria highlighted
  const escapedPrd = escapeReportHtml(prdText)
    .replace(/^(#{1,3} .+)$/gm, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  const criteriaLines = prdText
    .split('\n')
    .filter(l => /acceptance criteria|must|shall|should|given|when|then/i.test(l) && l.trim().length > 5)
    .slice(0, 20);

  const criteriaHtml = criteriaLines.map(line => {
    const escaped = escapeReportHtml(line);
    const isGap = gaps.some(g => g.toLowerCase().split(' ').some(w => w.length > 4 && line.toLowerCase().includes(w)));
    return `<div class="criterion ${isGap ? 'fail' : 'pass'}">
      <span class="icon">${isGap ? '✗' : '✓'}</span>
      <span>${escaped}</span>
    </div>`;
  }).join('');

  // Deterministic gates — the facts the verdict actually rests on.
  const gateRows = report.gates.map(gate => {
    const statusColor = gate.passed ? '#28a745' : '#dc3545';
    const status = gate.passed ? 'pass' : gate.timedOut ? 'timeout' : 'fail';
    const snippet = gate.output
      .split('\n').map(l => l.trim()).reverse().find(l => l.length > 0)?.substring(0, 160) ?? '—';
    return `<tr>
      <td><code>${escapeReportHtml(gate.command)}</code></td>
      <td style="color:${statusColor}">${status}</td>
      <td>${gate.exitCode}</td>
      <td>${gate.durationMs}ms</td>
      <td style="font-size:0.8em;color:#999">${escapeReportHtml(snippet)}</td>
    </tr>`;
  }).join('');

  const gateEmptyNote = report.gateCommandsEmpty
    ? '<p style="color:#f0ad4e;font-size:0.85em">No gate command could be detected for this repository — set <code>agentTaskPlayer.prdLoop.gateCommands</code> so verification rests on evidence, not judgment.</p>'
    : '';

  // Under `required` the skip arrives as a failing gate row instead, so this
  // note only ever renders for `auto`.
  const uatSkipNote = report.uatRan === false && report.uatSkipReason
    ? `<p style="color:#f0ad4e;font-size:0.85em">Browser UAT: skipped — ${escapeReportHtml(report.uatSkipReason)}</p>`
    : '';

  const changedFilesHtml = report.changedFiles.length > 0
    ? `<ul>${report.changedFiles.slice(0, 200).map(f => `<li>${escapeReportHtml(f)}</li>`).join('')}</ul>`
    : '<p style="color:#dc3545">No files changed — nothing was implemented.</p>';

  const bannerHtml = report.failedGate
    ? `<div class="banner fail-banner">Failed at ${escapeReportHtml(report.failedGate)} gate — no model judgment was needed</div>`
    : report.passed
      ? `<div class="banner pass-banner">All criteria satisfied — ready to commit</div>`
      : report.haltReason
        ? `<div class="banner fail-banner">${escapeReportHtml(describeHaltReason(report.haltReason))}</div>`
        : `<div class="banner fail-banner">Gaps found — fix required before commit</div>`;

  const actionBtn = report.passed
    ? `<button onclick="navigator.clipboard.writeText('MOAG: Commit &amp; Push').then(()=>this.title='Copied!');" title="Paste in VS Code command palette">Commit &amp; Push</button>`
    : `<button onclick="navigator.clipboard.writeText('MOAG: Generate Fix Tasks').then(()=>this.title='Copied!');" title="Paste in VS Code command palette">Generate Fix Tasks</button>`;

  const gapsHtml = gaps.length > 0
    ? `<ul>${gaps.map(g => `<li>${escapeReportHtml(g)}</li>`).join('')}</ul>`
    : '<p style="color:#28a745">No gaps detected.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOAG — PRD Verification Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; background: #1e1e1e; color: #d4d4d4; }
  .header { display: flex; align-items: center; gap: 16px; padding: 16px 24px; background: #252526; border-bottom: 1px solid #3c3c3c; flex-wrap: wrap; }
  .header .logo { font-weight: 700; font-size: 1.1em; color: #0078d4; letter-spacing: 0.04em; }
  .header .plan-name { flex: 1; font-size: 1em; color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .score-badge { padding: 4px 14px; border-radius: 12px; font-weight: 700; font-size: 1em; color: #fff; background: ${scoreBadgeColor}; }
  .header .date { font-size: 0.8em; color: #888; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border-bottom: 1px solid #3c3c3c; }
  .col { padding: 20px 24px; border-right: 1px solid #3c3c3c; }
  .col:last-child { border-right: none; }
  .col h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 14px; }
  .prd-text { font-size: 0.88em; line-height: 1.7; color: #c8c8c8; max-height: 320px; overflow-y: auto; }
  .criterion { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; border-bottom: 1px solid #2d2d2d; font-size: 0.88em; line-height: 1.5; }
  .criterion.pass .icon { color: #28a745; font-weight: bold; }
  .criterion.fail .icon { color: #dc3545; font-weight: bold; }
  .section { padding: 20px 24px; border-bottom: 1px solid #3c3c3c; }
  .section h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
  th { text-align: left; padding: 6px 10px; color: #888; font-weight: 600; border-bottom: 1px solid #3c3c3c; }
  td { padding: 7px 10px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  code { font-family: 'Cascadia Code', Consolas, monospace; font-size: 0.92em; color: #d7ba7d; }
  .file-list ul { padding-left: 18px; columns: 2; }
  .file-list li { margin: 2px 0; font-size: 0.85em; color: #c8c8c8; }
  .gaps { margin-top: 8px; }
  .gaps ul { padding-left: 18px; }
  .gaps li { margin: 4px 0; color: #f0ad4e; font-size: 0.88em; }
  .callout { background: #252526; border-left: 3px solid #0078d4; padding: 14px 18px; font-size: 0.9em; color: #c8c8c8; line-height: 1.6; margin: 0 24px 20px; border-radius: 0 4px 4px 0; white-space: pre-wrap; }
  .banner { text-align: center; padding: 12px 24px; font-weight: 700; font-size: 1em; }
  .pass-banner { background: #1a3a1a; color: #28a745; border-bottom: 1px solid #3c3c3c; }
  .fail-banner { background: #3a1a1a; color: #dc3545; border-bottom: 1px solid #3c3c3c; }
  .action-row { display: flex; gap: 12px; justify-content: center; padding: 16px 24px; background: #252526; border-top: 1px solid #3c3c3c; }
  button { padding: 8px 20px; border-radius: 4px; border: none; background: #0078d4; color: #fff; font-size: 0.9em; cursor: pointer; font-weight: 600; }
  button:hover { background: #005fa3; }
  .meta { font-size: 0.8em; color: #888; margin-top: 10px; }
</style>
</head>
<body>
<div class="header">
  <span class="logo">MOAG</span>
  <span class="plan-name">${escapeReportHtml(planName || 'Unnamed Plan')}</span>
  <span class="score-badge">${score}/100</span>
  <span class="date">${dateStr}</span>
</div>
${bannerHtml}
<div class="two-col">
  <div class="col">
    <h2>PRD Requirements</h2>
    <div class="prd-text">${escapedPrd}</div>
  </div>
  <div class="col">
    <h2>Verification Results</h2>
    ${criteriaHtml || '<p style="color:#888;font-size:0.88em">No acceptance criteria extracted.</p>'}
    <div class="gaps" style="margin-top:14px">
      <strong style="font-size:0.8em;color:#888;text-transform:uppercase;letter-spacing:.05em">Gaps</strong>
      ${gapsHtml}
    </div>
  </div>
</div>
<div class="section">
  <h2>Deterministic gates</h2>
  <table>
    <thead><tr><th>Command</th><th>Result</th><th>Exit</th><th>Duration</th><th>Output tail</th></tr></thead>
    <tbody>${gateRows || '<tr><td colspan="5" style="color:#888">No gate commands were run.</td></tr>'}</tbody>
  </table>
  ${gateEmptyNote}
  ${uatSkipNote}
  <p class="meta">Iterations: ${report.iterations} · Model calls: ${report.modelCallsMade}${report.failedGate ? ' · verdict reached without a model' : ''}</p>
</div>
<div class="section file-list">
  <h2>Changed files (${report.changedFiles.length})</h2>
  ${changedFilesHtml}
  ${report.diffStat ? `<pre style="font-size:0.8em;color:#999;margin-top:10px">${escapeReportHtml(report.diffStat)}</pre>` : ''}
</div>
<div class="callout">${escapeReportHtml(suggestion) || 'No suggestion provided.'}</div>
<div class="action-row">${actionBtn}</div>
</body>
</html>`;
}

/**
 * Run the PRD loop from the extension surface.
 *
 * One cancellable notification wraps the whole loop (it can run for many minutes),
 * runner gate/budget events are bridged into the controller for the loop's duration
 * only, and the HTML report is written and opened at the end.
 */
async function runPrdLoopInteractive(options: { fix: boolean; title: string }): Promise<void> {
  const plan = getActivePlan();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();
  const activePlan: Plan = plan ?? createEmptyPlan('Unnamed Plan');
  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<EngineId>('defaultEngine', 'claude' as EngineId);

  const abort = new AbortController();
  // Holder object: the report is assigned inside a callback, and a plain `let`
  // would lose its narrowing at the await boundary.
  const holder: { report: PrdLoopReport | null; controller: PrdLoopController | null } = {
    report: null,
    controller: null,
  };
  const prdTextHolder: { text: string } = { text: '' };

  const onManualGate = (task: Task): void => { holder.controller?.noteManualGate(task.id); };
  const onBudgetExceeded = (): void => { holder.controller?.noteBudgetExceeded(); };
  runner.on('manual-gate', onManualGate);
  runner.on('budget-exceeded', onBudgetExceeded);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: options.title,
        cancellable: true,
      },
      async (progress, token) => {
        const cancelSub = token.onCancellationRequested(() => abort.abort());
        try {
          const controller = createPrdLoop(getPrdLoopConfig(cwd, options.fix), {
            plan: activePlan,
            resolvePrdText: async () => {
              const text = await resolvePrdTextInteractive(plan, cwd);
              prdTextHolder.text = text ?? '';
              return text;
            },
            runPlan: (p: Plan) => runner.play(p),
            runEngine: (prompt: string, signal: AbortSignal) =>
              getEngine(defaultEngine).runTask({ prompt, cwd, signal, costLabel: 'prd-loop' }),
            savePlan: () => saveAndRefresh(),
            onProgress: (phase: string, detail: string) => progress.report({ message: `${phase}: ${detail}` }),
            emitReport: (r: PrdLoopReport) => { holder.report = r; },
            skipManualGate: (taskId: string) => runner.skipManualGate(taskId),
            prepareUat: (signal: AbortSignal) => prepareUatSession(cwd, signal),
            signal: abort.signal,
          });
          holder.controller = controller;
          await controller.run();
        } finally {
          cancelSub.dispose();
        }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    UserMsg.showError(UserMsg.runnerError(`PRD verification failed: ${msg.substring(0, 200)}`));
    return;
  } finally {
    runner.off('manual-gate', onManualGate);
    runner.off('budget-exceeded', onBudgetExceeded);
  }

  const report = holder.report;
  if (!report) {
    vscode.window.showErrorMessage('Verification produced no report. Try again.');
    return;
  }
  if (report.haltReason === 'no-prd') {
    vscode.window.showWarningMessage('No PRD selected — verification cancelled.');
    return;
  }
  if (report.haltReason === 'aborted') {
    vscode.window.showInformationMessage('PRD verification cancelled.');
    return;
  }

  const html = buildVerificationReportHtml(activePlan.name, prdTextHolder.text, report);
  const moagDir = ensureMoagDir();
  if (!moagDir) {
    vscode.window.showErrorMessage('Could not create .moag directory for report.');
    return;
  }
  const reportPath = path.join(moagDir, `verification-${Date.now()}.html`);
  fs.writeFileSync(reportPath, html, 'utf-8');
  await vscode.env.openExternal(vscode.Uri.file(reportPath));

  if (report.passed) {
    const action = await vscode.window.showInformationMessage(
      `PRD verified (${report.score}/100) — report opened in browser`,
      'Commit & Push',
    );
    if (action === 'Commit & Push') {
      void cmdSuggestCommit();
    }
    return;
  }

  // Name the command when there is one: "command gate" alone cannot tell a failing
  // `npm test` apart from a failing browser UAT run.
  const failingCommand = report.gates.find((g) => !g.passed)?.command;
  const headline = report.failedGate
    ? `Failed at the ${report.failedGate} gate` +
      (failingCommand ? ` (${failingCommand})` : '') +
      ' — report opened in browser'
    : report.haltReason
      ? `${describeHaltReason(report.haltReason)} — report opened in browser`
      : `Verification failed (${report.score}/100) — report opened in browser`;
  const action = await vscode.window.showWarningMessage(headline, 'Generate Fix Tasks');
  if (action === 'Generate Fix Tasks') {
    void cmdGenerateFixTasks();
  }
}

/** Verify the current work against the PRD using deterministic gates first. */
async function cmdVerifyAgainstPrd(): Promise<void> {
  await runPrdLoopInteractive({ fix: false, title: 'Verifying against PRD...' });
}

async function cmdSuggestCommit(): Promise<void> {
  const plan = currentPlan;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();

  if (!plan) {
    vscode.window.showWarningMessage('No active plan. Open a plan before committing.');
    return;
  }

  const { execSync } = require('child_process') as typeof import('child_process');

  let diffStat = '';
  try {
    diffStat = execSync('git diff --stat HEAD', { cwd, timeout: 30_000 }).toString().trim();
  } catch {
    diffStat = '(could not retrieve diff stat)';
  }

  const prdSnippet = plan.prdSource ? plan.prdSource.substring(0, 150).replace(/\n/g, ' ') : '';
  const prdLine = prdSnippet ? `\n${prdSnippet}` : '';
  const defaultMessage =
    `feat: ${plan.name}\n\nImplemented via MOAG PRD workflow.${prdLine}\n\nFiles changed:\n${diffStat}`;

  const message = await vscode.window.showInputBox({
    prompt: 'Commit message (edit if needed)',
    value: defaultMessage,
    ignoreFocusOut: true,
  });

  if (!message) { return; }

  try {
    execSync(`git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd,
      timeout: 30_000,
      shell: true as unknown as string,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Commit failed: ${msg.substring(0, 300)}`);
    return;
  }

  const action = await vscode.window.showInformationMessage('Committed. Push to remote?', 'Push');
  if (action !== 'Push') { return; }

  try {
    execSync('git push', { cwd, timeout: 30_000 });
    vscode.window.showInformationMessage('Pushed successfully.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Push failed: ${msg.substring(0, 300)}`);
  }
}

/**
 * Generate fix tasks and run them, gated the same way verification is:
 * the loop only asks a model for fixes after a deterministic gate has failed.
 */
async function cmdGenerateFixTasks(): Promise<void> {
  await runPrdLoopInteractive({ fix: true, title: 'Generating and running fix tasks...' });
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
          costLabel: 'task-split',
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

  initializeSingleTaskExecution();
  runner.playTask(currentPlan, playlistIndex, taskIndex).catch(err => {
    UserMsg.showError(UserMsg.retryFailed(err instanceof Error ? err.message : String(err)));
  });
}

// ─── Smart Fix ──────────────────────────────────────────────────────────────

const NOISE_PATTERNS_FIX = [
  /^reading prompt from stdin/i,
  /^─+\s*(command|response)\s*─+/i,
  /^github copilot/i,
  /^claude code/i,
  /^── /,
];

function buildSmartFixPrompt(task: Task, latest: HistoryEntry | undefined): string {
  const errorOutput = latest
    ? [latest.result.stderr, latest.result.stdout].filter(Boolean).join('\n')
    : '';
  const errorLines = errorOutput
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !NOISE_PATTERNS_FIX.some(p => p.test(l)))
    .slice(0, 6);

  const classification = latest ? classifyFailure(latest.result.stderr, latest.result.stdout) : null;
  const category = classification?.category ?? 'unknown';

  const lines: string[] = [`Fix: ${task.name}`, ``, `Failed with: ${category}`];

  if (errorLines.length > 0) {
    lines.push(``, ...errorLines);
  }

  lines.push(``, `Identify the root cause and fix it without repeating the same approach.`);

  return lines.join('\n');
}

async function cmdShowSmartFix(item?: PlanTreeItem | TaskLocation): Promise<void> {
  if (!currentPlan || !promptViewProvider) { return; }

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

  const entries = historyStore.getForTask(task.id);
  const latest = entries[0];
  const fixPrompt = buildSmartFixPrompt(task, latest);
  promptViewProvider.fillComposer(fixPrompt, undefined, { playlistIndex, taskIndex });
}

async function cmdRetryTaskWithPrompt(item?: { playlistIndex: number; taskIndex: number; prompt: string }): Promise<void> {
  if (!currentPlan || !item) { return; }
  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Runner is busy. Stop it first before retrying.');
    return;
  }
  const { playlistIndex, taskIndex, prompt } = item;
  const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
  if (!task) { return; }
  if (task.status !== TaskStatus.Failed && task.status !== TaskStatus.Blocked) {
    vscode.window.showInformationMessage('Only failed or blocked tasks can be fixed.');
    return;
  }

  if (task.ownerNote) {
    task.ownerNote = `${task.ownerNote}\n\n${prompt}`;
  } else {
    task.ownerNote = prompt;
  }
  task.status = TaskStatus.Pending;
  saveAndRefresh();

  if (!await preflightEngineCheck(currentPlan, playlistIndex, taskIndex)) {
    return;
  }

  initializeSingleTaskExecution();
  runner.playTask(currentPlan, playlistIndex, taskIndex).catch(err => {
    UserMsg.showError(UserMsg.retryFailed(err instanceof Error ? err.message : String(err)));
  });
}

async function cmdFixAllFailed(): Promise<void> {
  if (!currentPlan) { return; }
  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Runner is busy — stop it before running Fix All.');
    return;
  }

  const failedTasks: Array<{ playlistIndex: number; taskIndex: number }> = [];
  currentPlan.playlists.forEach((playlist, pi) => {
    (playlist.tasks || []).forEach((task, ti) => {
      if (task.status === TaskStatus.Failed || task.status === TaskStatus.Blocked) {
        failedTasks.push({ playlistIndex: pi, taskIndex: ti });
      }
    });
  });

  if (failedTasks.length === 0) {
    vscode.window.showInformationMessage('No failed tasks to fix.');
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Re-execute ${failedTasks.length} failed task${failedTasks.length === 1 ? '' : 's'} with their auto-fix context?`,
    { modal: false },
    'Re-execute All',
  );
  if (choice !== 'Re-execute All') { return; }

  // Reset all failed tasks to pending and run the plan from the first failed playlist
  const firstFailedPlaylist = failedTasks[0].playlistIndex;
  for (const { playlistIndex, taskIndex } of failedTasks) {
    const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
    if (task) { task.status = TaskStatus.Pending; }
  }
  saveAndRefresh();

  if (!await preflightEngineCheck(currentPlan, firstFailedPlaylist, failedTasks[0].taskIndex)) {
    return;
  }
  initializeSingleTaskExecution();
  runner.play(currentPlan, firstFailedPlaylist).catch(err => {
    UserMsg.showError(UserMsg.retryFailed(err instanceof Error ? err.message : String(err)));
  });
}

async function cmdAddTaskFromPrompt(args?: { text?: string }): Promise<void> {
  const text = args?.text?.trim();
  if (!text) { return; }

  if (!currentPlan || !currentPlanPath) {
    vscode.window.showWarningMessage('No plan is open. Open or create a plan first.');
    return;
  }

  // Generate a task name from the first line (max 60 chars)
  const firstLine = text.split('\n')[0].trim();
  const taskName = firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;

  // Add to the last playlist (or create one)
  if (currentPlan.playlists.length === 0) {
    currentPlan.playlists.push(createPlaylist('Queue'));
  }
  const playlist = currentPlan.playlists[currentPlan.playlists.length - 1];
  const task = createTask(taskName, text);
  playlist.tasks = playlist.tasks || [];
  playlist.tasks.push(task);

  saveAndRefresh();

  // Clear the composer
  promptViewProvider?.fillComposer('');
  vscode.window.showInformationMessage(`Task "${taskName}" added to "${playlist.name}".`);
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

  if (!await showProfilePicker()) { return; }

  saveAndRefresh();
  DashboardPanel.currentPanel?.clearTimeline();
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

  runner.play(plan).catch(err => {
    UserMsg.showError(UserMsg.runnerError(err instanceof Error ? err.message : String(err)));
  });
}

// ─── Plan Import / Export ───

// The boundary is "do the bytes leave this machine", not the command name. A path the
// user picked in a save dialog is a backup and stays complete; a clipboard, a gist or an
// issue comment does not. The two functions below therefore return different shapes —
// a bare string vs { json, redacted } — so swapping them is a compile error either way.

/** Export the full plan, secrets included, to a file the user picks. */
async function exportPlanToLocalFile(plan: Plan): Promise<void> {
  const json = JSON.stringify(dehydratePlan(plan), null, 2);

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${plan.name.toLowerCase().replace(/\s+/g, '-')}.agent-plan.json`),
    filters: { 'Agent Plan': ['agent-plan.json', 'json'] },
    title: 'Export Plan',
  });
  if (!uri) { return; }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
  // No redaction claim — nothing was removed.
  vscode.window.showInformationMessage(`Plan exported to ${uri.fsPath}`);
}

/** Copy a redacted plan to the clipboard — variables, rules and PRD never leave. */
async function copyPlanToClipboard(plan: Plan): Promise<void> {
  const { json, redacted } = serializePlanForSharing(plan);

  await vscode.env.clipboard.writeText(json);
  vscode.window.showInformationMessage(
    redacted.length > 0
      ? `Plan copied to clipboard. — removed for safety: ${redacted.join(', ')}`
      : 'Plan copied to clipboard.',
  );
}

async function cmdExportPlan(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Export to file', description: 'Complete backup — includes variables, rules and PRD' },
      { label: 'Copy to clipboard', description: 'Redacted for sharing — variables, rules and PRD removed' },
    ],
    { placeHolder: 'How do you want to export the plan?' },
  );
  if (!choice) { return; }

  if (choice.label === 'Copy to clipboard') {
    await copyPlanToClipboard(currentPlan);
    return;
  }

  await exportPlanToLocalFile(currentPlan);
}

async function cmdSharePlan(): Promise<void> {
  const plan = getActivePlan();
  if (!plan) {
    vscode.window.showWarningMessage('No plan loaded.');
    return;
  }

  // A gist leaves this machine: redact, and strip all statuses to create a clean template.
  const { json, redacted } = serializePlanForSharing(plan, { stripStatus: true });
  const redactionSuffix = redacted.length > 0 ? ` — removed for safety: ${redacted.join(', ')}` : '';

  const fileName = `${plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`;

  // Check if gh CLI is available
  const ghAvailable = await commandExists('gh');

  if (ghAvailable) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();

      const result = ghSync(['gist', 'create', '--public', '-f', fileName, '-'], {
        input: json,
        cwd,
        timeout: 30000,
      });

      const gistUrl = result.trim().split('\n').pop() || '';
      if (!gistUrl) {
        vscode.window.showErrorMessage('Failed to parse gist URL from gh output.');
        return;
      }

      const action = await vscode.window.showInformationMessage(
        `Plan shared: ${gistUrl}${redactionSuffix}`,
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
              const result = ghSync(['gist', 'view', gistId, '--raw'], {
                cwd: workspaceFolder.uri.fsPath,
                timeout: 30000,
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
  if ((pick.value === TaskStatus.Completed || pick.value === TaskStatus.Pending) && currentPlan) {
    unblockDependents(task.id, currentPlan);
  }
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

async function cmdSetTestPhase(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'playlist') { return; }

  const playlist = currentPlan.playlists[item.playlistIndex];
  const current = playlist.testPhase ?? false;
  const picks = [
    { label: '$(beaker) Mark as Test Phase', value: true, description: 'Sandbox auto-launches and TTT check runs when this playlist starts' },
    { label: '$(circle-slash) Remove Test Phase', value: false, description: 'Normal playlist — no sandbox auto-launch' },
  ];
  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: `"${playlist.name}" test phase: currently ${current ? 'ON' : 'OFF'}`,
  });
  if (pick === undefined) { return; }

  playlist.testPhase = pick.value;
  saveAndRefresh();
  vscode.window.showInformationMessage(`"${playlist.name}" test phase: ${pick.value ? 'ON — sandbox will auto-launch when this playlist runs' : 'OFF'}`);
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
          costLabel: 'conversation',
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

/** Show a profile picker before a run. Updates workspace config with the chosen profile. Returns false if cancelled. */
async function showProfilePicker(): Promise<boolean> {
  const current = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('executionProfile', 'auto');
  const items = PROFILE_META.map(p => ({
    label: `${p.icon} ${p.label}`,
    description: p.description + (p.name === current ? '  ← current' : ''),
    profileName: p.name,
    picked: p.name === current,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose execution profile for this run',
    matchOnDescription: true,
  });
  if (!pick) { return false; }
  if (pick.profileName !== current) {
    await vscode.workspace.getConfiguration('agentTaskPlayer').update('executionProfile', pick.profileName, vscode.ConfigurationTarget.Workspace);
  }
  return true;
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
      runner.playTask(plan, first.playlistIndex, first.taskIndex).catch(err => {
        vscode.window.showErrorMessage(`Task failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      const taskList = matchingTasks.map(m => ({ playlistIndex: m.playlistIndex, taskIndex: m.taskIndex }));
      for (const m of matchingTasks) { m.task.status = TaskStatus.Pending; }
      saveAndRefresh();
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
