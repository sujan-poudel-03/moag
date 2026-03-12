// ─── Extension entry point ───
// Registers all commands, tree views, and wires the runner to the UI.

import * as vscode from 'vscode';
import * as path from 'path';
import { Plan, RunnerState, EngineId, HistoryEntry, TaskStatus, TaskType, FailurePolicy, Task } from './models/types';
import { loadPlan, savePlan, dehydratePlan, hydratePlan, createEmptyPlan, createPlaylist, createTask } from './models/plan';
import { registerAllEngines, checkEngineAvailability, getEngine } from './adapters/index';
import { TaskRunner } from './runner/runner';
import { HistoryStore } from './history/store';
import { TemplateStore } from './templates/store';
import { generateId } from './models/plan';
import { PlanTreeProvider, PlanTreeItem } from './ui/plan-tree';
import { HistoryTreeProvider } from './ui/history-tree';
import { DashboardPanel } from './ui/dashboard-panel';
import { ExecutionDetailPanel } from './ui/execution-detail-panel';
import { PromptInputViewProvider } from './ui/prompt-input-view';
import { detectAndConfigureEngines, redetectEngines } from './engine-detection';
import { RunSessionStore, RunSession } from './models/run-session';
import { SessionsTreeProvider, SessionsTreeItem } from './ui/sessions-tree';

// ─── Shared state ───

let currentPlan: Plan | null = null;
let currentPlanPath: string | null = null;
let runner: TaskRunner;
let historyStore: HistoryStore;
let planTree: PlanTreeProvider;
let planView: vscode.TreeView<PlanTreeItem>;
let historyTree: HistoryTreeProvider;
let templateStore: TemplateStore;
let runSessionStore: RunSessionStore;
let sessionsTree: SessionsTreeProvider;
let planFileWatcher: vscode.FileSystemWatcher | null = null;

// ─── Execution progress tracking ───
let executionTaskCount = 0;
let executionTasksCompleted = 0;
let executionTasksFailed = 0;
let executionStartTime = 0;

// ─── Execution progress notification ───
let progressResolve: (() => void) | null = null;
let progressReport: vscode.Progress<{ message?: string; increment?: number }> | null = null;

function startProgressNotification(): void {
  if (progressResolve) { return; } // already running
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Agent Task Player', cancellable: true },
    (progress, token) => {
      progressReport = progress;
      token.onCancellationRequested(() => {
        runner.stop();
      });
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

// ─── Pause state persistence ───
const PAUSE_STATE_KEY = 'agentTaskPlayer.pauseState';

interface PersistentPauseState {
  /** Task statuses keyed by task ID */
  taskStatuses: Record<string, string>;
  /** Path to the plan file that was running */
  planPath: string | null;
}

/** Save current task statuses to workspace state (called on pause/stop) */
function savePauseState(ctx: vscode.ExtensionContext): void {
  if (!currentPlan) { return; }
  const taskStatuses: Record<string, string> = {};
  for (const pl of currentPlan.playlists) {
    for (const t of pl.tasks) {
      taskStatuses[t.id] = t.status;
    }
  }
  const state: PersistentPauseState = { taskStatuses, planPath: currentPlanPath };
  ctx.workspaceState.update(PAUSE_STATE_KEY, state);
}

/** Restore task statuses from workspace state (called on activation) */
function restorePauseState(ctx: vscode.ExtensionContext): void {
  const state = ctx.workspaceState.get<PersistentPauseState>(PAUSE_STATE_KEY);
  if (!state || !currentPlan || state.planPath !== currentPlanPath) { return; }

  let restored = false;
  for (const pl of currentPlan.playlists) {
    for (const t of pl.tasks) {
      if (state.taskStatuses[t.id] && state.taskStatuses[t.id] !== 'pending') {
        t.status = state.taskStatuses[t.id] as import('./models/types').TaskStatus;
        restored = true;
      }
    }
  }
  if (restored) {
    planTree.setPlan(currentPlan);
    DashboardPanel.currentPanel?.update();
  }
}

/** Clear saved pause state */
function clearPauseState(ctx: vscode.ExtensionContext): void {
  ctx.workspaceState.update(PAUSE_STATE_KEY, undefined);
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

export function activate(context: vscode.ExtensionContext): void {
  // Register all engine adapters
  registerAllEngines();

  // Initialize history store from workspace state
  historyStore = new HistoryStore(context.workspaceState);

  // Initialize run session store
  runSessionStore = new RunSessionStore(context.workspaceState);

  // Initialize template store
  templateStore = new TemplateStore(context.globalState);

  // Initialize task runner
  runner = new TaskRunner(historyStore);

  // Initialize tree providers
  planTree = new PlanTreeProvider();
  historyTree = new HistoryTreeProvider(historyStore);

  // Register tree views
  planView = vscode.window.createTreeView('agentTaskPlayer.planView', {
    treeDataProvider: planTree,
    showCollapseAll: true,
    dragAndDropController: planTree,
    canSelectMany: true,
  });
  const histView = vscode.window.createTreeView('agentTaskPlayer.historyView', {
    treeDataProvider: historyTree,
  });

  // Initialize sessions tree
  sessionsTree = new SessionsTreeProvider(historyStore, runSessionStore);
  const sessView = vscode.window.createTreeView('agentTaskPlayer.sessionsView', {
    treeDataProvider: sessionsTree,
    showCollapseAll: true,
  });
  context.subscriptions.push(planView, histView, sessView);

  // Register prompt input webview in sidebar
  const promptProvider = new PromptInputViewProvider(
    context.extensionUri,
    async (prompt: string) => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }

      // Auto-create a plan if none loaded
      if (!currentPlan) {
        const planName = prompt.substring(0, 60).trim();
        currentPlan = createEmptyPlan(planName);
        currentPlan.description = prompt;
        currentPlanPath = path.join(
          workspaceFolder.uri.fsPath,
          `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`,
        );
      }

      // Ensure at least one playlist exists
      if (currentPlan.playlists.length === 0) {
        currentPlan.playlists.push(createPlaylist('Tasks'));
      }

      // Create and add the task
      const taskName = prompt.length > 60 ? prompt.substring(0, 57) + '...' : prompt;
      const task = createTask(taskName, prompt);
      currentPlan.playlists[0].tasks.push(task);
      saveAndRefresh();

      // Find the indices for the new task
      const playlistIndex = 0;
      const taskIndex = currentPlan.playlists[0].tasks.length - 1;

      // Pre-flight engine check
      if (!await preflightEngineCheck(currentPlan, playlistIndex, taskIndex)) {
        return;
      }

      // Run the task immediately — auto-open dashboard
      vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      runner.playTask(currentPlan, playlistIndex, taskIndex).catch(err => {
        vscode.window.showErrorMessage(`Task failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PromptInputViewProvider.viewType, promptProvider),
  );

  // Save plan when tree items are reordered via drag-and-drop
  planTree.onDidReorder(() => saveAndRefresh());

  // ─── Wire runner events to UI ───

  runner.on('state-changed', (state) => {
    planTree.setRunnerState(state);
    DashboardPanel.currentPanel?.update();
    updateStatusBar(state);
    // Persist task progress when pausing or stopping
    if (state === RunnerState.Paused || state === RunnerState.Stopping) {
      savePauseState(context);
    }
    // Clear saved state when going idle after a full run (all-completed will fire too)
    if (state === RunnerState.Idle) {
      savePauseState(context);
    }
  });

  runner.on('task-started', (task, playlist, fullPrompt) => {
    executionTasksCompleted++; // tracks current task number (1-based)
    planTree.refresh();

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

    // Auto-open the Dashboard so users can see live output during execution
    ensureDashboardOpen();
    DashboardPanel.currentPanel?.update();
    DashboardPanel.currentPanel?.startTaskCard(task, playlist, fullPrompt);

    // Show real progress in status bar and notification
    const shortName = task.name.length > 40 ? task.name.substring(0, 37) + '...' : task.name;
    statusBarItem.text = `$(sync~spin) ATP: Task ${executionTasksCompleted}/${executionTaskCount} — ${shortName}`;
    startProgressNotification();
    updateProgressNotification(`Task ${executionTasksCompleted}/${executionTaskCount}: ${shortName}`);
  });

  runner.on('task-output', (task, chunk, stream) => {
    DashboardPanel.currentPanel?.appendOutput(chunk, stream, task.id);
  });

  runner.on('task-completed', (task, _result) => {
    planTree.refresh();
    saveAndRefresh();
    const entries = historyStore.getForTask(task.id);
    const entry = entries[0];
    DashboardPanel.currentPanel?.completeTaskCard(
      task, entry?.result ?? _result, entry?.changedFiles, entry?.codeChanges, entry?.verification, entry?.artifacts,
    );
    DashboardPanel.currentPanel?.update();
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
  });

  runner.on('task-failed', (task, result) => {
    executionTasksFailed++;
    planTree.refresh();
    saveAndRefresh();
    const entries = historyStore.getForTask(task.id);
    const entry = entries[0];
    DashboardPanel.currentPanel?.completeTaskCard(
      task, entry?.result ?? result, entry?.changedFiles, entry?.codeChanges, entry?.verification, entry?.artifacts,
    );
    DashboardPanel.currentPanel?.update();
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
  });

  runner.on('playlist-completed', (_playlist) => {
    // Silent — don't interrupt between playlists in autopilot mode
  });

  runner.on('all-completed', () => {
    endProgressNotification();
    clearPauseState(context);
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
      'Show Summary',
    ).then(action => {
      if (action === 'Show Dashboard') {
        vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      } else if (action === 'Show Summary') {
        vscode.commands.executeCommand('agentTaskPlayer.showCostSummary');
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

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
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
    vscode.commands.registerCommand('agentTaskPlayer.play', cmdPlay),
    vscode.commands.registerCommand('agentTaskPlayer.pause', cmdPause),
    vscode.commands.registerCommand('agentTaskPlayer.stop', cmdStop),
    vscode.commands.registerCommand('agentTaskPlayer.openPlan', cmdOpenPlan),
    vscode.commands.registerCommand('agentTaskPlayer.newPlan', cmdNewPlan),
    vscode.commands.registerCommand('agentTaskPlayer.addPlaylist', cmdAddPlaylist),
    vscode.commands.registerCommand('agentTaskPlayer.addTask', cmdAddTask),
    vscode.commands.registerCommand('agentTaskPlayer.editTask', cmdEditTask),
    vscode.commands.registerCommand('agentTaskPlayer.deleteItem', cmdDeleteItem),
    vscode.commands.registerCommand('agentTaskPlayer.moveUp', cmdMoveUp),
    vscode.commands.registerCommand('agentTaskPlayer.moveDown', cmdMoveDown),
    vscode.commands.registerCommand('agentTaskPlayer.showHistory', cmdShowHistory),
    vscode.commands.registerCommand('agentTaskPlayer.showDashboard', cmdShowDashboard),
    vscode.commands.registerCommand('agentTaskPlayer.clearHistory', cmdClearHistory),
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
    vscode.commands.registerCommand('agentTaskPlayer.detectEngines', () => redetectEngines(context)),
    vscode.commands.registerCommand('agentTaskPlayer.loadExamplePlan', cmdLoadExamplePlan),
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
  );

  // Show walkthrough on first activation (no plan loaded yet)
  const hasSeenWalkthrough = context.globalState.get<boolean>('agentTaskPlayer.hasSeenWalkthrough', false);
  if (!hasSeenWalkthrough) {
    // Check if there's no plan in workspace — likely a first-time user
    vscode.workspace.findFiles('**/*.agent-plan.json', '**/node_modules/**', 1).then(files => {
      if (files.length === 0) {
        vscode.commands.executeCommand(
          'workbench.action.openWalkthrough',
          'moag.agent-task-player#agentTaskPlayer.getStarted',
          false,
        );
      }
      context.globalState.update('agentTaskPlayer.hasSeenWalkthrough', true);
    });
  }

  // Auto-detect installed engines on first launch (non-blocking)
  detectAndConfigureEngines(context);

  // Auto-load plan if one exists in workspace, then restore pause state
  autoLoadPlan().then(() => restorePauseState(context));

  // Watch for .agent-plan.json changes — auto-reload on external edits
  planFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.agent-plan.json');
  planFileWatcher.onDidChange((uri) => {
    if (currentPlanPath && uri.fsPath === currentPlanPath && runner.state === RunnerState.Idle) {
      try {
        currentPlan = loadPlan(currentPlanPath);
        planTree.setPlan(currentPlan);
        planView.message = currentPlan.description || undefined;
        DashboardPanel.currentPanel?.update();
      } catch {
        // ignore reload errors
      }
    }
  });
  context.subscriptions.push(planFileWatcher);
}

export function deactivate(): void {
  runner?.stop();
  runner?.stopAllServices();
  if (planFileWatcher) {
    planFileWatcher.dispose();
    planFileWatcher = null;
  }
}

// ─── Helper: save & refresh ───

function saveAndRefresh(): void {
  const plan = getActivePlan();
  if (plan && currentPlanPath) {
    savePlan(plan, currentPlanPath);
  }
  planTree.setPlan(plan);
  planView.message = plan?.description || undefined;
  DashboardPanel.currentPanel?.update();
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

// ─── Auto-load: find .agent-plan.json in workspace ───

async function autoLoadPlan(): Promise<void> {
  const files = await vscode.workspace.findFiles('**/*.agent-plan.json', '**/node_modules/**', 1);
  if (files.length > 0) {
    try {
      currentPlanPath = files[0].fsPath;
      currentPlan = loadPlan(currentPlanPath);
      planTree.setPlan(currentPlan);
      planView.message = currentPlan.description || undefined;
      // Update dashboard if already open
      DashboardPanel.currentPanel?.update();
    } catch {
      // Silently ignore corrupt plan files on startup
    }
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

async function cmdPlay(): Promise<void> {
  if (!currentPlan) {
    vscode.window.showWarningMessage('No plan loaded. Open or create a plan first.');
    return;
  }

  // Resume from pause — don't reset anything
  if (runner.state === RunnerState.Paused) {
    runner.play(currentPlan);
    return;
  }

  // Already running or stopping — ignore
  if (runner.state !== RunnerState.Idle) {
    return;
  }

  // Check if there are already completed/failed tasks (partial run)
  const hasProgress = currentPlan.playlists.some(pl =>
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
      runner.resetPlan(currentPlan);
      DashboardPanel.currentPanel?.clearTimeline();
    }
    // For resume: leave task statuses as-is — the runner skips completed tasks
  } else {
    // Fresh start
    runner.resetPlan(currentPlan);
    DashboardPanel.currentPanel?.clearTimeline();
  }

  // Pre-flight engine check
  if (!await preflightEngineCheck(currentPlan)) {
    return;
  }

  // Initialize progress counters
  executionTaskCount = currentPlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  executionTasksCompleted = 0;
  executionTasksFailed = 0;
  executionStartTime = Date.now();

  saveAndRefresh();
  startProgressNotification();
  // Auto-open the dashboard so the user sees live output
  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  runner.play(currentPlan).catch(err => {
    vscode.window.showErrorMessage(`Runner error: ${err instanceof Error ? err.message : String(err)}`);
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
    currentPlanPath = uris[0].fsPath;
    currentPlan = loadPlan(currentPlanPath);
    planTree.setPlan(currentPlan);
    planView.message = currentPlan.description || undefined;
    DashboardPanel.currentPanel?.update();
    vscode.window.showInformationMessage(`Loaded plan: ${currentPlan.name}`);
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : `Failed to load plan: ${err}`);
  }
}

async function cmdNewPlan(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
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

  // Use the AI engine to convert the raw idea into a structured plan
  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<EngineId>('defaultEngine', 'claude' as EngineId);
  const isLargeSpec = rawIdea.length > 500 || rawIdea.split('\n').length > 20;

  let planName = rawIdea.substring(0, 60).replace(/\n.*/s, '').trim();
  let playlists: Array<{ name: string; engine?: string; tasks: Array<{ name: string; prompt: string }> }> = [];

  try {
    const engine = getEngine(defaultEngine);
    const cwd = workspaceFolder.uri.fsPath;
    const prompt = isLargeSpec ? PLAN_GENERATION_PROMPT_LARGE : PLAN_GENERATION_PROMPT;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating plan from your description...', cancellable: true },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const result = await engine.runTask({
          prompt: prompt + '\n\nUser description:\n' + rawIdea,
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
    // Engine not available or failed — fall back to manual
  }

  // Fallback: if AI didn't produce anything, create a single task
  if (playlists.length === 0) {
    playlists = [{ name: 'Tasks', tasks: [{ name: planName, prompt: rawIdea }] }];
  }

  // Build the plan with proper multi-playlist structure
  currentPlan = createEmptyPlan(planName);
  currentPlan.description = rawIdea.length > 500 ? rawIdea.substring(0, 500) + '...' : rawIdea;
  currentPlan.playlists = playlists.map(pl => {
    const playlist = createPlaylist(pl.name, pl.engine as EngineId | undefined);
    for (const t of pl.tasks) {
      playlist.tasks.push(createTask(t.name, t.prompt));
    }
    return playlist;
  });

  const totalTasks = currentPlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  currentPlanPath = path.join(workspaceFolder.uri.fsPath, `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`);
  saveAndRefresh();
  vscode.window.showInformationMessage(
    `Plan "${planName}" created — ${currentPlan.playlists.length} playlist${currentPlan.playlists.length > 1 ? 's' : ''}, ${totalTasks} task${totalTasks > 1 ? 's' : ''}.`,
  );
}

async function cmdLoadExamplePlan(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  currentPlan = createEmptyPlan('Example: Todo CLI App');
  currentPlan.description = 'Build a simple command-line todo app with add, list, complete, and delete operations. This is an example plan to show how Agent Task Player works.';

  const pl = currentPlan.playlists[0];
  pl.name = 'Build Todo App';
  pl.tasks = [
    createTask(
      'Set up project structure',
      'Create a new Node.js project with a package.json. Set up a src/ directory with an index.ts entry point. Add TypeScript as a dev dependency and create a tsconfig.json with strict mode enabled.',
    ),
    createTask(
      'Implement todo data model',
      'Create src/todo.ts with a Todo interface (id, title, completed, createdAt) and a TodoStore class that stores todos in a JSON file. Implement methods: add(title), list(), complete(id), delete(id), and save/load from ~/.todos.json.',
    ),
    createTask(
      'Build CLI interface',
      'Update src/index.ts to parse command-line arguments using process.argv. Support these commands: add <title>, list, done <id>, delete <id>. Print a helpful usage message if no arguments are given. Use the TodoStore to persist data.',
    ),
    createTask(
      'Add tests',
      'Create src/todo.test.ts with unit tests for the TodoStore class. Test add, list, complete, and delete operations. Use a temp directory for the test JSON file. Make sure tests clean up after themselves.',
    ),
  ];

  currentPlanPath = path.join(workspaceFolder.uri.fsPath, 'example-todo-app.agent-plan.json');
  saveAndRefresh();
  vscode.window.showInformationMessage(
    'Example plan loaded! Click Play to start building, or explore the tasks first.',
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
    // Only one playlist — use it directly, no need to ask
    playlistIndex = 0;
  } else if (currentPlan.playlists.length === 0) {
    vscode.window.showWarningMessage('Add a playlist first.');
    return;
  } else {
    // Multiple playlists — ask user to pick
    const items = currentPlan.playlists.map((pl, i) => ({ label: pl.name, index: i }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select playlist' });
    if (!picked) { return; }
    playlistIndex = picked.index;
  }

  const name = await vscode.window.showInputBox({ prompt: 'Task name' });
  if (!name) { return; }

  const typePick = await vscode.window.showQuickPick(
    [
      { label: 'agent', description: 'AI agent task' },
      { label: 'command', description: 'Run a local shell command' },
      { label: 'service', description: 'Start and verify a background service' },
      { label: 'check', description: 'Run a validation/check command' },
    ],
    { placeHolder: 'Task type' },
  );
  if (!typePick) { return; }

  const prompt = await vscode.window.showInputBox({
    prompt: typePick.label === 'agent' ? 'Task prompt (instruction for the agent)' : 'Task description',
    placeHolder: typePick.label === 'agent'
      ? 'e.g., Create a REST API endpoint for user authentication'
      : 'Optional description shown in the dashboard',
  });
  if (typePick.label === 'agent' && !prompt) { return; }

  const task = createTask(name, prompt ?? '');
  task.type = typePick.label as TaskType;

  if (task.type !== 'agent') {
    const command = await vscode.window.showInputBox({
      prompt: task.type === 'check' ? 'Check command' : 'Shell command',
      placeHolder: task.type === 'service'
        ? 'e.g., npm run dev'
        : 'e.g., npm test',
    });
    if (!command) { return; }
    task.command = command;
  }

  currentPlan.playlists[playlistIndex].tasks.push(task);
  saveAndRefresh();
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

  const currentType = getTaskType(task);

  const name = await vscode.window.showInputBox({
    prompt: 'Task name',
    value: task.name,
  });
  if (name !== undefined) { task.name = name; }

  const prompt = await vscode.window.showInputBox({
    prompt: currentType === 'agent' ? 'Task prompt' : 'Task description',
    value: task.prompt,
  });
  if (prompt !== undefined) { task.prompt = prompt; }

  const taskType = await vscode.window.showQuickPick(
    ['agent', 'command', 'service', 'check'],
    { placeHolder: `Task type (current: ${currentType})` },
  );
  if (taskType) {
    task.type = taskType as TaskType;
  }

  const engine = await vscode.window.showQuickPick(
    ['(use default)', 'claude', 'codex', 'gemini', 'ollama', 'custom'],
    { placeHolder: 'Engine override' },
  );
  if (getTaskType(task) === 'agent') {
    if (engine === '(use default)') {
      task.engine = undefined;
    } else if (engine) {
      task.engine = engine as EngineId;
    }
  } else {
    task.engine = undefined;
  }

  const command = await vscode.window.showInputBox({
    prompt: 'Shell command (optional for agent tasks)',
    value: task.command ?? '',
    placeHolder: getTaskType(task) === 'service' ? 'e.g., npm run dev' : 'e.g., npm test',
  });
  if (command !== undefined) {
    task.command = command || undefined;
  }

  const verify = await vscode.window.showInputBox({
    prompt: 'Verification command (optional)',
    value: task.verifyCommand ?? '',
    placeHolder: 'e.g., npm test',
  });
  if (verify !== undefined) {
    task.verifyCommand = verify || undefined;
  }

  const acceptanceCriteria = await vscode.window.showInputBox({
    prompt: 'Acceptance criteria (one per line)',
    value: formatTaskList(task.acceptanceCriteria),
    placeHolder: 'Criteria shown in the dashboard and reports',
    ignoreFocusOut: true,
  });
  if (acceptanceCriteria !== undefined) {
    task.acceptanceCriteria = parseTaskList(acceptanceCriteria);
  }

  const expectedArtifacts = await vscode.window.showInputBox({
    prompt: 'Expected artifacts (one path per line)',
    value: formatTaskList(task.expectedArtifacts),
    placeHolder: 'e.g., dist/index.js',
    ignoreFocusOut: true,
  });
  if (expectedArtifacts !== undefined) {
    task.expectedArtifacts = parseTaskList(expectedArtifacts);
  }

  const ownerNote = await vscode.window.showInputBox({
    prompt: 'Owner note (optional)',
    value: task.ownerNote ?? '',
    placeHolder: 'Review notes, product context, or implementation constraints',
    ignoreFocusOut: true,
  });
  if (ownerNote !== undefined) {
    task.ownerNote = ownerNote || undefined;
  }

  const failurePolicy = await vscode.window.showQuickPick(
    [
      { label: '(continue)', value: 'continue', description: 'Default - mark failed and continue the run' },
      { label: 'stop', value: 'stop', description: 'Stop the run when this task fails' },
      { label: 'mark-blocked', value: 'mark-blocked', description: 'Mark blocked instead of failed' },
    ],
    { placeHolder: `Failure policy (current: ${task.failurePolicy ?? 'continue'})` },
  );
  if (failurePolicy) {
    task.failurePolicy = failurePolicy.value as FailurePolicy;
  }

  const env = await vscode.window.showInputBox({
    prompt: 'Environment variables (KEY=value, one per line)',
    value: formatTaskEnv(task.env),
    placeHolder: 'PORT=3000',
    ignoreFocusOut: true,
  });
  if (env !== undefined) {
    task.env = parseTaskEnv(env);
  }

  const port = await vscode.window.showInputBox({
    prompt: 'Port check (optional)',
    value: task.port ? String(task.port) : '',
    placeHolder: 'e.g., 3000',
  });
  if (port !== undefined) {
    const parsedPort = Number(port);
    task.port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined;
  }

  const readyPattern = await vscode.window.showInputBox({
    prompt: 'Ready pattern (optional)',
    value: task.readyPattern ?? '',
    placeHolder: 'e.g., listening on',
  });
  if (readyPattern !== undefined) {
    task.readyPattern = readyPattern || undefined;
  }

  const healthCheckUrl = await vscode.window.showInputBox({
    prompt: 'Health check URL (optional)',
    value: task.healthCheckUrl ?? '',
    placeHolder: 'e.g., http://localhost:3000/health',
  });
  if (healthCheckUrl !== undefined) {
    task.healthCheckUrl = healthCheckUrl || undefined;
  }

  const startupTimeoutMs = await vscode.window.showInputBox({
    prompt: 'Service startup timeout ms (optional)',
    value: task.startupTimeoutMs ? String(task.startupTimeoutMs) : '',
    placeHolder: 'e.g., 60000',
  });
  if (startupTimeoutMs !== undefined) {
    const parsedTimeout = Number(startupTimeoutMs);
    task.startupTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;
  }

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

async function cmdRetryTask(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }
  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Runner is busy. Stop it first before retrying.');
    return;
  }

  const task = currentPlan.playlists[item.playlistIndex]?.tasks[item.taskIndex];
  if (!task) { return; }
  if (task.status !== TaskStatus.Failed && task.status !== TaskStatus.Blocked) {
    vscode.window.showInformationMessage('Only failed or blocked tasks can be retried.');
    return;
  }

  // Reset just this task
  task.status = TaskStatus.Pending;
  saveAndRefresh();

  if (!await preflightEngineCheck(currentPlan, item.playlistIndex, item.taskIndex)) {
    return;
  }

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  runner.playTask(currentPlan, item.playlistIndex, item.taskIndex).catch(err => {
    vscode.window.showErrorMessage(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function cmdRetryTaskWithNote(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }
  if (runner.state !== RunnerState.Idle) {
    vscode.window.showWarningMessage('Runner is busy. Stop it first before retrying.');
    return;
  }

  const task = currentPlan.playlists[item.playlistIndex]?.tasks[item.taskIndex];
  if (!task) { return; }
  if (task.status !== TaskStatus.Failed && task.status !== TaskStatus.Blocked) {
    vscode.window.showInformationMessage('Only failed or blocked tasks can be retried with a note.');
    return;
  }

  const note = await vscode.window.showInputBox({
    prompt: `Retry note for "${task.name}"`,
    placeHolder: 'Describe what should change on the retry',
    ignoreFocusOut: true,
  });
  if (!note) { return; }

  const noteBlock = `Retry revision note:\n${note}`;
  if (task.ownerNote) {
    task.ownerNote = `${task.ownerNote}\n\n${noteBlock}`;
  } else {
    task.ownerNote = noteBlock;
  }
  task.status = TaskStatus.Pending;
  saveAndRefresh();

  if (!await preflightEngineCheck(currentPlan, item.playlistIndex, item.taskIndex)) {
    return;
  }

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  runner.playTask(currentPlan, item.playlistIndex, item.taskIndex).catch(err => {
    vscode.window.showErrorMessage(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
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
  DashboardPanel.createOrShow(
    vscode.Uri.file(''),
    runner,
    historyStore,
    () => getActivePlan(),
    () => saveAndRefresh(),
  );
}

function cmdClearHistory(): void {
  historyStore.clear();
  vscode.window.showInformationMessage('History cleared.');
}

async function cmdPlayPlaylist(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'playlist') { return; }

  if (!await preflightEngineCheck(currentPlan, item.playlistIndex)) {
    return;
  }

  // Only reset tasks in this specific playlist, not the entire plan
  const playlist = currentPlan.playlists[item.playlistIndex];
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
  runner.playPlaylist(currentPlan, item.playlistIndex).catch(err => {
    vscode.window.showErrorMessage(`Runner error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function cmdPlayTask(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }

  if (!await preflightEngineCheck(currentPlan, item.playlistIndex, item.taskIndex)) {
    return;
  }

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  runner.playTask(currentPlan, item.playlistIndex, item.taskIndex).catch(err => {
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

  // Reset selected tasks to pending
  for (const { playlistIndex, taskIndex } of taskList) {
    const task = currentPlan.playlists[playlistIndex]?.tasks[taskIndex];
    if (task) { task.status = TaskStatus.Pending; }
  }
  saveAndRefresh();

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  DashboardPanel.currentPanel?.clearTimeline();
  runner.playTasks(currentPlan, taskList).catch(err => {
    vscode.window.showErrorMessage(`Runner error: ${err instanceof Error ? err.message : String(err)}`);
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
    currentPlanPath = planPath;
    currentPlan = loadPlan(planPath);
    planTree.setPlan(currentPlan);
    planView.message = currentPlan.description || undefined;
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : `Failed to load plan: ${err}`);
    return;
  }

  // Pre-flight
  if (!await preflightEngineCheck(currentPlan)) {
    return;
  }

  // Check if the plan file has tasks with existing progress (completed/failed)
  const hasProgress = currentPlan.playlists.some(pl =>
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
      runner.resetPlan(currentPlan);
      DashboardPanel.currentPanel?.clearTimeline();
    }
  } else {
    runner.resetPlan(currentPlan);
    DashboardPanel.currentPanel?.clearTimeline();
  }

  // Initialize progress counters
  executionTaskCount = currentPlan.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
  executionTasksCompleted = 0;
  executionTasksFailed = 0;
  executionStartTime = Date.now();

  saveAndRefresh();

  vscode.window.setStatusBarMessage(
    `$(rocket) Running plan "${currentPlan.name}" (${executionTaskCount} tasks)...`,
    5000,
  );

  vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
  runner.play(currentPlan).catch(err => {
    vscode.window.showErrorMessage(`Runner error: ${err instanceof Error ? err.message : String(err)}`);
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
      vscode.window.showErrorMessage(err instanceof Error ? err.message : `Failed to load plan: ${err}`);
      return;
    }
  }

  // Ask where to save the imported plan
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  currentPlan = plan;
  currentPlanPath = path.join(
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
    vscode.window.showErrorMessage('Open a workspace folder first.');
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
