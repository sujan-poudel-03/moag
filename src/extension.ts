// ─── Extension entry point ───
// Registers all commands, tree views, and wires the runner to the UI.

import * as vscode from 'vscode';
import * as path from 'path';
import { Plan, RunnerState, EngineId, HistoryEntry } from './models/types';
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

// ─── Shared state ───

let currentPlan: Plan | null = null;
let currentPlanPath: string | null = null;
let runner: TaskRunner;
let historyStore: HistoryStore;
let planTree: PlanTreeProvider;
let planView: vscode.TreeView<PlanTreeItem>;
let historyTree: HistoryTreeProvider;
let templateStore: TemplateStore;

export function activate(context: vscode.ExtensionContext): void {
  // Register all engine adapters
  registerAllEngines();

  // Initialize history store from workspace state
  historyStore = new HistoryStore(context.workspaceState);

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
  });
  const histView = vscode.window.createTreeView('agentTaskPlayer.historyView', {
    treeDataProvider: historyTree,
  });
  context.subscriptions.push(planView, histView);

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

      // Run the task immediately
      await runner.playTask(currentPlan, playlistIndex, taskIndex);
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
  });

  runner.on('task-started', (task, playlist, fullPrompt) => {
    planTree.refresh();
    DashboardPanel.currentPanel?.update();
    DashboardPanel.currentPanel?.startTaskCard(task, playlist, fullPrompt);
    vscode.window.setStatusBarMessage(`Running: ${task.name}`, 3000);
  });

  runner.on('task-output', (task, chunk, stream) => {
    DashboardPanel.currentPanel?.appendOutput(chunk, stream, task.id);
  });

  runner.on('task-completed', (task, _result) => {
    planTree.refresh();
    const entries = historyStore.getForTask(task.id);
    const entry = entries[0]; // newest first
    DashboardPanel.currentPanel?.completeTaskCard(
      task, entry?.result ?? _result, entry?.changedFiles, entry?.codeChanges,
    );
    DashboardPanel.currentPanel?.update();
  });

  runner.on('task-failed', (task, result) => {
    planTree.refresh();
    const entries = historyStore.getForTask(task.id);
    const entry = entries[0];
    DashboardPanel.currentPanel?.completeTaskCard(
      task, entry?.result ?? result, entry?.changedFiles, entry?.codeChanges,
    );
    DashboardPanel.currentPanel?.update();
    const stderrPreview = result.stderr.split('\n').filter(l => l.trim()).slice(0, 2).join(' | ');
    const detail = stderrPreview ? `: ${stderrPreview.substring(0, 120)}` : '';
    vscode.window.showWarningMessage(
      `Task "${task.name}" failed (exit ${result.exitCode})${detail}`,
      'Show Output',
    ).then(action => {
      if (action === 'Show Output') {
        vscode.commands.executeCommand('agentTaskPlayer.showDashboard');
      }
    });
  });

  runner.on('playlist-completed', (playlist) => {
    vscode.window.showInformationMessage(`Playlist "${playlist.name}" completed.`);
  });

  runner.on('all-completed', () => {
    vscode.window.showInformationMessage('All playlists completed!');
  });

  runner.on('error', (err) => {
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

  // Auto-load plan if one exists in workspace
  autoLoadPlan();
}

export function deactivate(): void {
  runner?.stop();
}

// ─── Helper: save & refresh ───

function saveAndRefresh(): void {
  if (currentPlan && currentPlanPath) {
    savePlan(currentPlan, currentPlanPath);
  }
  planTree.setPlan(currentPlan);
  planView.message = currentPlan?.description || undefined;
  DashboardPanel.currentPanel?.update();
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
    } catch {
      // Silently ignore corrupt plan files on startup
    }
  }
}

// ─── Pre-flight engine validation ───

/** Collect unique engine IDs needed to execute a given scope of the plan. */
function collectEngineIds(plan: Plan, playlistIndex?: number, taskIndex?: number): EngineId[] {
  const engines = new Set<EngineId>();

  if (playlistIndex !== undefined && taskIndex !== undefined) {
    const playlist = plan.playlists[playlistIndex];
    const task = playlist.tasks[taskIndex];
    engines.add(task.engine ?? playlist.engine ?? plan.defaultEngine);
  } else if (playlistIndex !== undefined) {
    const playlist = plan.playlists[playlistIndex];
    for (const task of playlist.tasks) {
      engines.add(task.engine ?? playlist.engine ?? plan.defaultEngine);
    }
  } else {
    for (const playlist of plan.playlists) {
      for (const task of playlist.tasks) {
        engines.add(task.engine ?? playlist.engine ?? plan.defaultEngine);
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
  if (runner.state === RunnerState.Paused) {
    // Resume
    runner.play(currentPlan);
    return;
  }
  if (runner.state === RunnerState.Playing) {
    return;
  }
  // Pre-flight engine check
  if (!await preflightEngineCheck(currentPlan)) {
    return;
  }

  // Reset all tasks and start from the beginning
  runner.resetPlan(currentPlan);
  saveAndRefresh();
  DashboardPanel.currentPanel?.clearTimeline();
  runner.play(currentPlan);
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
    vscode.window.showErrorMessage(`Failed to load plan: ${err}`);
  }
}

async function cmdNewPlan(): Promise<void> {
  const rawIdea = await vscode.window.showInputBox({
    prompt: 'Describe your project or what you want built',
    placeHolder: 'e.g., Build a REST API with auth, user CRUD, and tests',
  });
  if (!rawIdea) { return; }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  // Use the AI engine to convert the raw idea into a structured playlist
  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<EngineId>('defaultEngine', 'claude' as EngineId);

  let planName = rawIdea.substring(0, 60).trim();
  let tasks: Array<{ name: string; prompt: string }> = [];

  try {
    const engine = getEngine(defaultEngine);
    const cwd = workspaceFolder.uri.fsPath;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating plan from your idea...', cancellable: true },
      async (progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const result = await engine.runTask({
          prompt: PLAN_GENERATION_PROMPT + '\n\nUser idea:\n' + rawIdea,
          cwd,
          signal: abortController.signal,
        });

        if (result.exitCode === 0 && result.stdout.trim()) {
          const parsed = parsePlanResponse(result.stdout);
          if (parsed) {
            planName = parsed.name;
            tasks = parsed.tasks;
          }
        }
      },
    );
  } catch {
    // Engine not available or failed — fall back to manual
  }

  // Fallback: if AI didn't produce tasks, create a single task from the raw idea
  if (tasks.length === 0) {
    tasks = [{ name: planName, prompt: rawIdea }];
  }

  currentPlan = createEmptyPlan(planName);
  currentPlan.description = rawIdea;
  currentPlan.playlists[0].name = 'Tasks';
  for (const t of tasks) {
    currentPlan.playlists[0].tasks.push(createTask(t.name, t.prompt));
  }

  currentPlanPath = path.join(workspaceFolder.uri.fsPath, `${planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.agent-plan.json`);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Plan "${planName}" created with ${tasks.length} task${tasks.length > 1 ? 's' : ''}.`);
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

/** Try to extract structured plan from AI response */
function parsePlanResponse(raw: string): { name: string; tasks: Array<{ name: string; prompt: string }> } | null {
  try {
    // Strip markdown code fences if present
    let json = raw.trim();
    const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      json = fenceMatch[1].trim();
    }
    const parsed = JSON.parse(json);
    if (parsed.name && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
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

  const prompt = await vscode.window.showInputBox({
    prompt: 'Task prompt (instruction for the agent)',
    placeHolder: 'e.g., Create a REST API endpoint for user authentication',
  });
  if (!prompt) { return; }

  const task = createTask(name, prompt);
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

  const name = await vscode.window.showInputBox({
    prompt: 'Task name',
    value: task.name,
  });
  if (name !== undefined) { task.name = name; }

  const prompt = await vscode.window.showInputBox({
    prompt: 'Task prompt',
    value: task.prompt,
  });
  if (prompt !== undefined) { task.prompt = prompt; }

  const engine = await vscode.window.showQuickPick(
    ['(use default)', 'claude', 'codex', 'gemini', 'ollama', 'custom'],
    { placeHolder: 'Engine override' },
  );
  if (engine === '(use default)') {
    task.engine = undefined;
  } else if (engine) {
    task.engine = engine as EngineId;
  }

  const verify = await vscode.window.showInputBox({
    prompt: 'Verification command (optional)',
    value: task.verifyCommand ?? '',
    placeHolder: 'e.g., npm test',
  });
  if (verify !== undefined) {
    task.verifyCommand = verify || undefined;
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
    ExecutionDetailPanel.show(entry as HistoryEntry, historyStore);
    return;
  }
  ExecutionDetailPanel.showEmpty(historyStore);
}

function cmdShowThreadList(): void {
  ExecutionDetailPanel.showEmpty(historyStore);
}

function cmdShowDashboard(): void {
  const panel = DashboardPanel.createOrShow(
    vscode.Uri.file(''),
    runner,
    historyStore,
    () => currentPlan,
    () => saveAndRefresh(),
  );
  // Set the HTML content
  (panel as unknown as { _panel: vscode.WebviewPanel })._panel?.webview &&
    ((panel as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html = panel.getHtml());
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

  runner.resetPlan(currentPlan);
  saveAndRefresh();
  DashboardPanel.currentPanel?.clearTimeline();
  runner.playPlaylist(currentPlan, item.playlistIndex);
}

async function cmdPlayTask(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }

  if (!await preflightEngineCheck(currentPlan, item.playlistIndex, item.taskIndex)) {
    return;
  }

  runner.playTask(currentPlan, item.playlistIndex, item.taskIndex);
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
  task.files = t.files;
  task.verifyCommand = t.verifyCommand;
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
    engine: task.engine,
    files: task.files,
    verifyCommand: task.verifyCommand,
    retryCount: task.retryCount,
    category,
  });
  vscode.window.showInformationMessage(`Template "${task.name}" saved.`);
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
      vscode.window.showErrorMessage(`Invalid plan JSON: ${err}`);
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
      vscode.window.showErrorMessage(`Failed to load plan: ${err}`);
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
  const file = JSON.parse(json);
  if (!file.version || !file.playlists) {
    throw new Error('Missing required fields (version, playlists)');
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

function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  const secs = Math.floor(ms / 1000);
  if (secs < 60) { return `${secs}s`; }
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}
