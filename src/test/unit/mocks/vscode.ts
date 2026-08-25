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

export class ThemeColor {
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

// ─── Additions for the activation smoke test ─────────────────────────────────
// activate() touches far more of the API than a focused unit test does. These
// are inert stubs: enough shape for the extension to wire itself up, with no
// behaviour, so the test asserts registration rather than side effects.

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 };
export const UIKind = { Desktop: 1, Web: 2 };

export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose(): void { this.fn(); }
  static from(...items: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
}

export class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export class Selection extends Range {}

const noopWatcher = () => ({
  onDidCreate: () => ({ dispose: () => {} }),
  onDidChange: () => ({ dispose: () => {} }),
  onDidDelete: () => ({ dispose: () => {} }),
  dispose: () => {},
});

const noopChannel = () => ({
  appendLine: () => {},
  append: () => {},
  clear: () => {},
  show: () => {},
  hide: () => {},
  dispose: () => {},
});

const noopPanel = () => ({
  webview: {
    html: '',
    options: {},
    cspSource: '',
    asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    postMessage: async () => true,
  },
  onDidDispose: () => ({ dispose: () => {} }),
  onDidChangeViewState: () => ({ dispose: () => {} }),
  reveal: () => {},
  dispose: () => {},
  visible: true,
  active: true,
  title: '',
  viewType: '',
});

Object.assign(window, {
  createOutputChannel: noopChannel,
  createWebviewPanel: noopPanel,
  registerWebviewViewProvider: () => ({ dispose: () => {} }),
  registerTreeDataProvider: () => ({ dispose: () => {} }),
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showTextDocument: async () => ({ document: {}, selection: null }),
  withProgress: async (_o: unknown, task: (p: unknown, t: unknown) => unknown) =>
    task({ report: () => {} }, { isCancellationRequested: false }),
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  onDidChangeVisibleTextEditors: () => ({ dispose: () => {} }),
  onDidChangeWindowState: () => ({ dispose: () => {} }),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  tabGroups: { all: [], close: async () => true, onDidChangeTabs: () => ({ dispose: () => {} }) },
});

Object.assign(workspace, {
  createFileSystemWatcher: noopWatcher,
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  onDidSaveTextDocument: () => ({ dispose: () => {} }),
  onDidOpenTextDocument: () => ({ dispose: () => {} }),
  onDidCloseTextDocument: () => ({ dispose: () => {} }),
  onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  openTextDocument: async () => ({ getText: () => '', uri: Uri.file('/mock/doc'), fileName: '/mock/doc' }),
  applyEdit: async () => true,
  findFiles: async () => [],
  asRelativePath: (p: unknown) => String(p),
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    createDirectory: async () => {},
    stat: async () => ({ type: 1, size: 0 }),
    delete: async () => {},
  },
  name: 'mock-workspace',
});

Object.assign(commands, {
  executeCommand: async () => undefined,
  getCommands: async () => [],
  registerTextEditorCommand: (_id: string, _h: unknown) => ({ dispose: () => {} }),
});

export const env = {
  openExternal: async () => true,
  clipboard: { writeText: async () => {}, readText: async () => '' },
  appName: 'Mock VS Code',
  uiKind: UIKind.Desktop,
  machineId: 'mock-machine',
  sessionId: 'mock-session',
};

export const languages = {
  registerCodeLensProvider: () => ({ dispose: () => {} }),
  createDiagnosticCollection: () => ({ set: () => {}, clear: () => {}, dispose: () => {} }),
};

export const version = '1.90.0';

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };

Object.assign(extensions, {
  getExtension: () => undefined,
  onDidChange: () => ({ dispose: () => {} }),
});
