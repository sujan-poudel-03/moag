// ─── Shared mock for the 'vscode' module ───
// Used by unit tests via proxyquire to avoid loading the real VS Code API.

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data: T) {
    this.listeners.forEach(l => l(data));
  }
  dispose() {
    this.listeners = [];
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  description?: string;
  tooltip?: unknown;
  command?: unknown;
  contextValue?: string;
  iconPath?: unknown;

  constructor(label: string, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class MarkdownString {
  value: string;
  constructor(value = '') {
    this.value = value;
  }
}

export class ThemeIcon {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// Configurable mock configuration store
const configStore: Record<string, Record<string, unknown>> = {};

export function setMockConfig(section: string, values: Record<string, unknown>): void {
  configStore[section] = values;
}

export function clearMockConfig(): void {
  for (const key of Object.keys(configStore)) {
    delete configStore[key];
  }
}

export const workspace = {
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const fullSection = section || '';
        const stored = configStore[fullSection];
        if (stored && key in stored) {
          return stored[key] as T;
        }
        return defaultValue as T;
      },
    };
  },
  workspaceFolders: [
    { uri: { fsPath: '/mock/workspace' } },
  ],
};

export const window = {
  showWarningMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showErrorMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  setStatusBarMessage: (..._args: unknown[]) => ({ dispose: () => {} }),
  createTreeView: () => ({ dispose: () => {} }),
  createStatusBarItem: () => ({
    text: '',
    command: '',
    show: () => {},
    dispose: () => {},
  }),
};

export class Uri {
  readonly fsPath: string;
  readonly scheme: string;
  constructor(fsPath: string) {
    this.fsPath = fsPath;
    this.scheme = 'file';
  }
  static file(path: string) {
    return new Uri(path);
  }
}

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const commands = {
  registerCommand: (_id: string, _handler: unknown) => ({ dispose: () => {} }),
};

export const extensions = {
  all: [],
};
