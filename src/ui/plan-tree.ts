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
        const progress = this.playlistProgress(pl);
        item.tooltip = `${pl.name}\n\n${progress}`;
        item.description = progress;
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
          this.truncateLabel(task.name, 64),
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = this.taskIcon(task);
        item.tooltip = this.taskTooltip(task);
        item.description = this.taskDescription(task, playlist);
        return item;
      });
    }

    return [];
  }

  private playlistProgress(pl: Playlist): string {
    const total = pl.tasks.length;
    const completed = pl.tasks.filter(t => t.status === TaskStatus.Completed).length;
    return `${completed}/${total} tasks`;
  }

  private playlistIcon(pl: Playlist): vscode.ThemeIcon {
    const allDone = pl.tasks.length > 0 && pl.tasks.every(t => t.status === TaskStatus.Completed);
    const anyFailed = pl.tasks.some(t => t.status === TaskStatus.Failed);
    if (anyFailed) { return new vscode.ThemeIcon('folder', new vscode.ThemeColor('testing.iconFailed')); }
    if (allDone) { return new vscode.ThemeIcon('folder', new vscode.ThemeColor('testing.iconPassed')); }
    return new vscode.ThemeIcon('folder', new vscode.ThemeColor('descriptionForeground'));
  }

  private taskIcon(task: Task): vscode.ThemeIcon {
    switch (task.status) {
      case TaskStatus.Pending: return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
      case TaskStatus.Running: return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('progressBar.background'));
      case TaskStatus.Completed: return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case TaskStatus.Failed: return new vscode.ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed'));
      case TaskStatus.Paused:
      case TaskStatus.Blocked:
      case TaskStatus.Skipped:
      default:
        return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
    }
  }

  private taskDescription(task: Task, playlist: Playlist): string {
    const executor = this.taskExecutorLabel(task, playlist);
    return `${executor} ${this.taskSummaryStatus(task.status)}`;
  }

  private taskTooltip(task: Task): string {
    const preview = this.promptPreview(task.prompt, 100) ?? 'No prompt';
    return `${task.name}\n\nPrompt: ${preview}`;
  }

  private taskExecutorLabel(task: Task, playlist: Playlist): string {
    const executor = task.engine
      ?? ((task.type && task.type !== 'agent') ? task.type : undefined)
      ?? playlist.engine
      ?? this._plan?.defaultEngine
      ?? 'agent';

    return executor.charAt(0).toUpperCase() + executor.slice(1);
  }

  private taskSummaryStatus(status: TaskStatus): string {
    switch (status) {
      case TaskStatus.Completed:
        return 'done';
      case TaskStatus.Failed:
        return 'failed';
      default:
        return 'pending';
    }
  }

  private truncateLabel(label: string, limit: number): string {
    if (label.length <= limit) {
      return label;
    }
    return `${label.substring(0, limit - 3)}...`;
  }

  private promptPreview(prompt: string | undefined, limit: number): string | undefined {
    if (!prompt) {
      return undefined;
    }

    const cleaned = prompt.replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      return undefined;
    }

    return cleaned.length > limit ? `${cleaned.substring(0, limit)}...` : cleaned;
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
