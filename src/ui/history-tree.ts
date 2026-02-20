// ─── TreeView provider for History panel ───
// Shows execution history entries grouped by date.

import * as vscode from 'vscode';
import { HistoryEntry, TaskStatus } from '../models/types';
import { HistoryStore } from '../history/store';

export class HistoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: HistoryEntry | null,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible);
  }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HistoryTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: HistoryStore) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HistoryTreeItem): HistoryTreeItem[] {
    const entries = this.store.getAll();

    if (!element) {
      // Group by date
      const groups = new Map<string, HistoryEntry[]>();
      for (const entry of entries) {
        const date = entry.startedAt.split('T')[0];
        if (!groups.has(date)) {
          groups.set(date, []);
        }
        groups.get(date)!.push(entry); // eslint-disable-line @typescript-eslint/no-non-null-assertion
      }

      return Array.from(groups.entries()).map(([date, items]) => {
        const item = new HistoryTreeItem(
          null,
          `${date} (${items.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        // Stash date in description for child lookup
        item.description = date;
        return item;
      });
    }

    // Children of a date group
    const date = element.description as string;
    const dayEntries = entries.filter(e => e.startedAt.startsWith(date));

    return dayEntries.map(entry => {
      const time = entry.startedAt.split('T')[1]?.substring(0, 8) ?? '';
      const item = new HistoryTreeItem(
        entry,
        entry.taskName,
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(
        entry.status === TaskStatus.Completed ? 'check' : 'error',
      );
      item.description = `${time} | ${entry.engine} | ${entry.result.durationMs}ms`;
      item.tooltip = new vscode.MarkdownString(
        `**${entry.taskName}**\n\n` +
        `Engine: ${entry.engine}\n\n` +
        `Status: ${entry.status}\n\n` +
        `Duration: ${entry.result.durationMs}ms\n\n` +
        `Exit code: ${entry.result.exitCode}\n\n` +
        `---\n\n` +
        `\`\`\`\n${entry.result.stdout.substring(0, 500)}\n\`\`\``
      );
      item.command = {
        command: 'agentTaskPlayer.showHistory',
        title: 'Show Details',
        arguments: [entry],
      };
      return item;
    });
  }
}
