// ─── TreeView provider for the Plan side panel ───
// Shows playlists as top-level items and tasks as children, with status icons.

import * as vscode from 'vscode';
import { Plan, Playlist, Task, TaskStatus, RunnerState } from '../models/types';

/** Tree item types — used for contextValue to control menus */
type TreeItemKind = 'playlist' | 'task';

export class PlanTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: TreeItemKind,
    public readonly playlistIndex: number,
    public readonly taskIndex: number | undefined,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible);
    this.contextValue = kind;
  }
}

export class PlanTreeProvider implements vscode.TreeDataProvider<PlanTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PlanTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _plan: Plan | null = null;
  private _runnerState: RunnerState = RunnerState.Idle;

  setPlan(plan: Plan | null): void {
    this._plan = plan;
    this.refresh();
  }

  setRunnerState(state: RunnerState): void {
    this._runnerState = state;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  get plan(): Plan | null {
    return this._plan;
  }

  getTreeItem(element: PlanTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PlanTreeItem): PlanTreeItem[] {
    if (!this._plan) {
      return [];
    }

    // Root level — show playlists
    if (!element) {
      return this._plan.playlists.map((pl, i) => {
        const item = new PlanTreeItem(
          'playlist',
          i,
          undefined,
          `${this.playlistIcon(pl)} ${pl.name}`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.tooltip = `${pl.tasks.length} tasks | Engine: ${pl.engine ?? this._plan!.defaultEngine} | Autoplay: ${pl.autoplay ? 'on' : 'off'}`;
        item.description = `${pl.tasks.length} tasks`;
        return item;
      });
    }

    // Playlist children — show tasks
    if (element.kind === 'playlist') {
      const playlist = this._plan.playlists[element.playlistIndex];
      if (!playlist) { return []; }

      return playlist.tasks.map((task, i) => {
        const item = new PlanTreeItem(
          'task',
          element.playlistIndex,
          i,
          `${this.taskIcon(task)} ${task.name}`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.tooltip = task.prompt.substring(0, 200);
        item.description = task.engine ?? '';
        return item;
      });
    }

    return [];
  }

  private playlistIcon(pl: Playlist): string {
    const allDone = pl.tasks.length > 0 && pl.tasks.every(t => t.status === TaskStatus.Completed);
    const anyRunning = pl.tasks.some(t => t.status === TaskStatus.Running);
    const anyFailed = pl.tasks.some(t => t.status === TaskStatus.Failed);
    if (anyRunning) { return '$(loading~spin)'; }
    if (anyFailed) { return '$(error)'; }
    if (allDone) { return '$(check-all)'; }
    return '$(list-unordered)';
  }

  private taskIcon(task: Task): string {
    switch (task.status) {
      case TaskStatus.Pending: return '$(circle-outline)';
      case TaskStatus.Running: return '$(loading~spin)';
      case TaskStatus.Paused: return '$(debug-pause)';
      case TaskStatus.Completed: return '$(check)';
      case TaskStatus.Failed: return '$(error)';
      case TaskStatus.Skipped: return '$(circle-slash)';
      default: return '$(circle-outline)';
    }
  }
}
