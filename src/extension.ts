// ─── Extension entry point ───
// Registers all commands, tree views, and wires the runner to the UI.

import * as vscode from 'vscode';
import * as path from 'path';
import { Plan, Playlist, Task, TaskStatus, RunnerState, EngineId } from './models/types';
import { loadPlan, savePlan, createEmptyPlan, createPlaylist, createTask } from './models/plan';
import { registerAllEngines } from './adapters/index';
import { TaskRunner } from './runner/runner';
import { HistoryStore } from './history/store';
import { PlanTreeProvider, PlanTreeItem } from './ui/plan-tree';
import { HistoryTreeProvider } from './ui/history-tree';
import { DashboardPanel } from './ui/dashboard-panel';

// ─── Shared state ───

let currentPlan: Plan | null = null;
let currentPlanPath: string | null = null;
let runner: TaskRunner;
let historyStore: HistoryStore;
let planTree: PlanTreeProvider;
let historyTree: HistoryTreeProvider;

export function activate(context: vscode.ExtensionContext): void {
  // Register all engine adapters
  registerAllEngines();

  // Initialize history store from workspace state
  historyStore = new HistoryStore(context.workspaceState);

  // Initialize task runner
  runner = new TaskRunner(historyStore);

  // Initialize tree providers
  planTree = new PlanTreeProvider();
  historyTree = new HistoryTreeProvider(historyStore);

  // Register tree views
  const planView = vscode.window.createTreeView('agentTaskPlayer.planView', {
    treeDataProvider: planTree,
    showCollapseAll: true,
  });
  const histView = vscode.window.createTreeView('agentTaskPlayer.historyView', {
    treeDataProvider: historyTree,
  });
  context.subscriptions.push(planView, histView);

  // ─── Wire runner events to UI ───

  runner.on('state-changed', (state) => {
    planTree.setRunnerState(state);
    DashboardPanel.currentPanel?.update();
    updateStatusBar(state);
  });

  runner.on('task-started', (task, playlist) => {
    planTree.refresh();
    DashboardPanel.currentPanel?.update();
    vscode.window.setStatusBarMessage(`Running: ${task.name}`, 3000);
  });

  runner.on('task-completed', (task, result) => {
    planTree.refresh();
    DashboardPanel.currentPanel?.update();
  });

  runner.on('task-failed', (task, result) => {
    planTree.refresh();
    DashboardPanel.currentPanel?.update();
    vscode.window.showWarningMessage(`Task "${task.name}" failed (exit ${result.exitCode})`);
  });

  runner.on('playlist-completed', (playlist) => {
    vscode.window.showInformationMessage(`Playlist "${playlist.name}" completed.`);
  });

  runner.on('all-completed', () => {
    vscode.window.showInformationMessage('All playlists completed!');
  });

  runner.on('error', (err) => {
    vscode.window.showErrorMessage(`Runner error: ${err.message}`);
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
  );

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
    } catch {
      // Silently ignore corrupt plan files on startup
    }
  }
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
  // Reset all tasks and start from the beginning
  runner.resetPlan(currentPlan);
  saveAndRefresh();
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
    DashboardPanel.currentPanel?.update();
    vscode.window.showInformationMessage(`Loaded plan: ${currentPlan.name}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to load plan: ${err}`);
  }
}

async function cmdNewPlan(): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Plan name',
    placeHolder: 'My Agent Plan',
    value: 'New Plan',
  });
  if (!name) { return; }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  currentPlan = createEmptyPlan(name);
  currentPlanPath = path.join(workspaceFolder.uri.fsPath, `${name.toLowerCase().replace(/\s+/g, '-')}.agent-plan.json`);
  saveAndRefresh();
  vscode.window.showInformationMessage(`Created plan: ${name}`);
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
  } else {
    // Ask user to pick a playlist
    const items = currentPlan.playlists.map((pl, i) => ({ label: pl.name, index: i }));
    if (items.length === 0) {
      vscode.window.showWarningMessage('Add a playlist first.');
      return;
    }
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
  // If called with a history entry, show details
  if (entry && typeof entry === 'object' && 'result' in entry) {
    const e = entry as import('./models/types').HistoryEntry;
    const doc = `# ${e.taskName}

**Engine:** ${e.engine}
**Status:** ${e.status}
**Started:** ${e.startedAt}
**Finished:** ${e.finishedAt}
**Duration:** ${e.result.durationMs}ms
**Exit Code:** ${e.result.exitCode}

## Prompt
\`\`\`
${e.prompt}
\`\`\`

## Stdout
\`\`\`
${e.result.stdout}
\`\`\`

## Stderr
\`\`\`
${e.result.stderr}
\`\`\`
`;
    vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
      .then(d => vscode.window.showTextDocument(d, { preview: true }));
    return;
  }

  // Otherwise, show the dashboard with history tab
  cmdShowDashboard();
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
  runner.resetPlan(currentPlan);
  saveAndRefresh();
  runner.playPlaylist(currentPlan, item.playlistIndex);
}

async function cmdPlayTask(item?: PlanTreeItem): Promise<void> {
  if (!currentPlan || !item || item.kind !== 'task' || item.taskIndex === undefined) { return; }
  runner.playTask(currentPlan, item.playlistIndex, item.taskIndex);
}
