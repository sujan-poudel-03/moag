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

const DRAG_MIME = 'application/vnd.code.tree.agenttaskplayer';

export class PlanTreeProvider implements vscode.TreeDataProvider<PlanTreeItem>, vscode.TreeDragAndDropController<PlanTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PlanTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dropMimeTypes = [DRAG_MIME];
  readonly dragMimeTypes = [DRAG_MIME];

  private _plan: Plan | null = null;
  private _runnerState: RunnerState = RunnerState.Idle;
  private _onDidReorder = new vscode.EventEmitter<void>();
  readonly onDidReorder = this._onDidReorder.event;

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
          pl.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = this.playlistIcon(pl);
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
          task.name,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = this.taskIcon(task);
        item.tooltip = task.prompt.substring(0, 200);
        item.description = task.engine ?? '';
        return item;
      });
    }

    return [];
  }

  private playlistIcon(pl: Playlist): vscode.ThemeIcon {
    const allDone = pl.tasks.length > 0 && pl.tasks.every(t => t.status === TaskStatus.Completed);
    const anyRunning = pl.tasks.some(t => t.status === TaskStatus.Running);
    const anyFailed = pl.tasks.some(t => t.status === TaskStatus.Failed);
    if (anyRunning) { return new vscode.ThemeIcon('loading~spin'); }
    if (anyFailed) { return new vscode.ThemeIcon('error'); }
    if (allDone) { return new vscode.ThemeIcon('check-all'); }
    return new vscode.ThemeIcon('list-unordered');
  }

  private taskIcon(task: Task): vscode.ThemeIcon {
    switch (task.status) {
      case TaskStatus.Pending: return new vscode.ThemeIcon('circle-outline');
      case TaskStatus.Running: return new vscode.ThemeIcon('loading~spin');
      case TaskStatus.Paused: return new vscode.ThemeIcon('debug-pause');
      case TaskStatus.Completed: return new vscode.ThemeIcon('check');
      case TaskStatus.Failed: return new vscode.ThemeIcon('error');
      case TaskStatus.Skipped: return new vscode.ThemeIcon('circle-slash');
      default: return new vscode.ThemeIcon('circle-outline');
    }
  }

  // ─── Drag & Drop ───

  handleDrag(source: readonly PlanTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const item = source[0];
    if (!item) { return; }
    dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({
      kind: item.kind,
      playlistIndex: item.playlistIndex,
      taskIndex: item.taskIndex,
    })));
  }

  handleDrop(target: PlanTreeItem | undefined, dataTransfer: vscode.DataTransfer): void {
    if (!this._plan) { return; }
    const raw = dataTransfer.get(DRAG_MIME);
    if (!raw) { return; }

    const source: { kind: TreeItemKind; playlistIndex: number; taskIndex?: number } = JSON.parse(raw.value);

    // Reorder playlists (drop on root or another playlist)
    if (source.kind === 'playlist') {
      const targetIndex = target?.kind === 'playlist' ? target.playlistIndex : this._plan.playlists.length - 1;
      if (targetIndex === source.playlistIndex) { return; }
      const [moved] = this._plan.playlists.splice(source.playlistIndex, 1);
      this._plan.playlists.splice(targetIndex, 0, moved);
      this._onDidReorder.fire();
      this.refresh();
      return;
    }

    // Reorder tasks within or across playlists
    if (source.kind === 'task' && source.taskIndex !== undefined) {
      const targetPlaylistIndex = target?.playlistIndex ?? source.playlistIndex;
      const targetTaskIndex = target?.kind === 'task' && target.taskIndex !== undefined
        ? target.taskIndex
        : this._plan.playlists[targetPlaylistIndex].tasks.length;

      const sourcePlaylist = this._plan.playlists[source.playlistIndex];
      const targetPlaylist = this._plan.playlists[targetPlaylistIndex];
      const [moved] = sourcePlaylist.tasks.splice(source.taskIndex, 1);
      targetPlaylist.tasks.splice(targetTaskIndex, 0, moved);
      this._onDidReorder.fire();
      this.refresh();
    }
  }
}
