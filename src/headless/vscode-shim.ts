/**
 * Minimal `vscode` API shim for HEADLESS execution.
 *
 * MOAG's execution path (runner, adapters, context-builder, history store) imports
 * `vscode` but only touches a tiny, well-defined surface — almost entirely
 * `workspace.getConfiguration`. This module reimplements exactly that surface in
 * plain Node so the runner can run from a terminal/daemon with no VS Code host.
 *
 * The require hook in `install-shim.ts` maps `require('vscode')` to this module.
 *
 * Surface implemented (enumerated from the codebase):
 *   workspace.getConfiguration / workspace.workspaceFolders
 *   window.show{Information,Warning,Error}Message
 *   EventEmitter, Disposable, Uri, ConfigurationTarget
 * Copilot-only symbols (lm, LanguageModelChatMessage, CancellationTokenSource) are
 * provided as throwing stubs — the Copilot engine requires a real VS Code host.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Config backing store ───────────────────────────────────────────────────

let workspaceRoot: string = process.cwd();
let configRoot: Record<string, unknown> | null = null;

/** Set by the CLI so workspaceFolders and the config file resolve correctly. */
export function __setWorkspaceRoot(root: string): void {
  workspaceRoot = root;
  configRoot = null; // force reload against the new root
}

function loadConfig(): Record<string, unknown> {
  if (configRoot) { return configRoot; }
  const explicit = process.env.MOAG_CONFIG_PATH;
  const configPath = explicit && explicit.length > 0
    ? explicit
    : path.join(workspaceRoot, '.moag', 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      configRoot = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } else {
      configRoot = {};
    }
  } catch {
    configRoot = {};
  }
  return configRoot;
}

/** Walk a nested object by a dotted path (e.g. "agentTaskPlayer.issueSync.enabled"). */
function resolvePath(root: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = root;
  for (const part of dotted.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

class Configuration {
  constructor(private readonly section?: string) {}
  private full(key: string): string { return this.section ? `${this.section}.${key}` : key; }
  get<T>(key: string, defaultValue?: T): T | undefined {
    const v = resolvePath(loadConfig(), this.full(key));
    return v === undefined ? defaultValue : (v as T);
  }
  has(key: string): boolean {
    return resolvePath(loadConfig(), this.full(key)) !== undefined;
  }
  inspect(): undefined { return undefined; }
  // Persist into the in-memory config for the lifetime of the process.
  async update(key: string, value: unknown): Promise<void> {
    const root = loadConfig();
    const parts = this.full(key).split('.');
    let cur: Record<string, unknown> = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== 'object' || cur[p] === null) { cur[p] = {}; }
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }
}

// ─── EventEmitter (matches vscode.EventEmitter shape) ────────────────────────

interface Disposable { dispose(): void; }

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) { try { l(data); } catch { /* swallow listener errors */ } }
  }
  dispose(): void { this.listeners = []; }
}

// ─── Uri (minimal) ───────────────────────────────────────────────────────────

export class Uri {
  private constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
  static file(p: string): Uri { return new Uri(p); }
  static parse(value: string): Uri { return new Uri(value, value.split(':')[0] || 'file'); }
  toString(): string { return this.fsPath; }
}

// ─── window (headless: log to stderr, never block) ───────────────────────────

export const window = {
  showInformationMessage: async (msg: string, ..._items: unknown[]): Promise<undefined> => {
    process.stderr.write(`[info] ${msg}\n`); return undefined;
  },
  showWarningMessage: async (msg: string, ..._items: unknown[]): Promise<undefined> => {
    process.stderr.write(`[warn] ${msg}\n`); return undefined;
  },
  showErrorMessage: async (msg: string, ..._items: unknown[]): Promise<undefined> => {
    process.stderr.write(`[error] ${msg}\n`); return undefined;
  },
  createOutputChannel: (name: string) => ({
    name,
    append: (v: string) => process.stderr.write(v),
    appendLine: (v: string) => process.stderr.write(v + '\n'),
    clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
  }),
};

// ─── workspace ───────────────────────────────────────────────────────────────

export const workspace = {
  getConfiguration: (section?: string): Configuration => new Configuration(section),
  get workspaceFolders(): Array<{ uri: Uri; name: string; index: number }> {
    return [{ uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }];
  },
  onDidChangeConfiguration: (_listener: (e: unknown) => void): Disposable => ({ dispose: () => {} }),
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }

// ─── commands (headless: no-op; most are UI navigation) ──────────────────────

export const commands = {
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<undefined> => undefined,
  registerCommand: (_command: string, _cb: (...a: unknown[]) => unknown): Disposable => ({ dispose: () => {} }),
};

// ─── Copilot-only stubs (require a real VS Code host) ────────────────────────

function unsupported(symbol: string): never {
  throw new Error(`vscode.${symbol} is not available in headless mode (use a CLI-based engine like claude/codex/anthropic).`);
}
export const lm = {
  selectChatModels: async (): Promise<never> => unsupported('lm.selectChatModels'),
};
export const LanguageModelChatMessage = {
  User: (_content: string) => unsupported('LanguageModelChatMessage.User'),
};
export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
  cancel(): void { this.token.isCancellationRequested = true; }
  dispose(): void {}
}

// All public symbols are ES named exports above; `require('vscode')` (via the
// install-shim hook) receives this module's namespace, so consumer code that does
// `import * as vscode from 'vscode'` sees vscode.workspace, vscode.EventEmitter, etc.
