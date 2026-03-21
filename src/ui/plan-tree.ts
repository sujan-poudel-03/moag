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
        const desc = this.playlistDescription(pl);
        item.tooltip = `${desc} | Engine: ${pl.engine ?? this._plan!.defaultEngine} | Autoplay: ${pl.autoplay ? 'on' : 'off'}`;
        item.description = desc;
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
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${task.name}**\n\n`);
        md.appendMarkdown(`Type: \`${task.type || 'agent'}\``);
        if (task.engine) { md.appendMarkdown(` · Engine: \`${task.engine}\``); }
        md.appendMarkdown(` · Status: \`${task.status}\`\n\n`);
        if (task.prompt) {
          const preview = task.prompt.length > 300 ? task.prompt.substring(0, 297) + '...' : task.prompt;
          md.appendMarkdown(`---\n\n${preview}`);
        }
        if (task.verifyCommand) {
          md.appendMarkdown(`\n\n*Verify:* \`${task.verifyCommand}\``);
        }
        if (task.dependsOn && task.dependsOn.length > 0) {
          md.appendMarkdown(`\n\n*Depends on:* ${task.dependsOn.length} task(s)`);
        }
        item.tooltip = md;
        // Build a compact description string
        const descParts: string[] = [];
        const type = task.type ?? 'agent';
        if (type !== 'agent') { descParts.push(type); }
        if (task.engine) { descParts.push(task.engine); }
        if (task.status === TaskStatus.Completed) { descParts.push('done'); }
        else if (task.status === TaskStatus.Failed) { descParts.push('failed'); }
        else if (task.status === TaskStatus.Running) { descParts.push('running...'); }
        else if (task.status === TaskStatus.Skipped) { descParts.push('skipped'); }
        else if (task.status === TaskStatus.Blocked) { descParts.push('blocked'); }
        if (task.verifyCommand) { descParts.push('✓ verify'); }
        if (task.dependsOn && task.dependsOn.length > 0) { descParts.push('→ deps'); }
        item.description = descParts.join(' · ');
        return item;
      });
    }

    return [];
  }

  private playlistDescription(pl: Playlist): string {
    const total = pl.tasks.length;
    const completed = pl.tasks.filter(t => t.status === TaskStatus.Completed).length;
    const failed = pl.tasks.filter(t => t.status === TaskStatus.Failed).length;
    const blocked = pl.tasks.filter(t => t.status === TaskStatus.Blocked).length;

    if (completed === 0 && failed === 0) {
      return `${total} tasks`;
    }

    const parts = [`${completed}/${total}`];
    if (failed > 0) { parts.push(`${failed} failed`); }
    if (blocked > 0) { parts.push(`${blocked} blocked`); }
    if (completed === total) { parts[0] += ' ✓'; }
    return parts.join(' · ');
  }

  private playlistIcon(pl: Playlist): vscode.ThemeIcon {
    const allDone = pl.tasks.length > 0 && pl.tasks.every(t => t.status === TaskStatus.Completed);
    const anyRunning = pl.tasks.some(t => t.status === TaskStatus.Running);
    const anyFailed = pl.tasks.some(t => t.status === TaskStatus.Failed);
    const anyBlocked = pl.tasks.some(t => t.status === TaskStatus.Blocked);
    if (anyRunning) { return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('progressBar.background')); }
    if (anyBlocked) { return new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('editorWarning.foreground')); }
    if (anyFailed) { return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')); }
    if (allDone) { return new vscode.ThemeIcon('check-all', new vscode.ThemeColor('testing.iconPassed')); }
    return new vscode.ThemeIcon('list-unordered', new vscode.ThemeColor('descriptionForeground'));
  }

  private taskIcon(task: Task): vscode.ThemeIcon {
    switch (task.status) {
      case TaskStatus.Pending: return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
      case TaskStatus.Running: return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('progressBar.background'));
      case TaskStatus.Paused: return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('debugIcon.pauseForeground'));
      case TaskStatus.Completed: return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case TaskStatus.Failed: return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
      case TaskStatus.Blocked: return new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('editorWarning.foreground'));
      case TaskStatus.Skipped: return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
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
