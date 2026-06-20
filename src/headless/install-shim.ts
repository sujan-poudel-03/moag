/**
 * Installs the headless `vscode` shim via a Node require hook, and provides a
 * file-backed Memento so the history/session/template stores persist across runs.
 *
 * IMPORTANT: call installVscodeShim() BEFORE requiring anything that imports
 * `vscode` (runner, adapters, stores). Because those imports run `require('vscode')`
 * at module load, the hook must already be in place.
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

let installed = false;

/** Redirect every `require('vscode')` to the headless shim. */
export function installVscodeShim(workspaceRoot?: string): void {
  if (installed) { return; }
  installed = true;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shim = require('./vscode-shim');
  if (workspaceRoot) { shim.__setWorkspaceRoot(workspaceRoot); }

  const originalLoad = Module._load;
  Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') { return shim; }
    return originalLoad.call(Module, request, parent, isMain);
  };
}

/**
 * A vscode.Memento-compatible store backed by a JSON file under `.moag/`.
 * Used in place of context.workspaceState / context.globalState.
 */
export class FileMemento {
  private data: Record<string, unknown> = {};
  constructor(private readonly filePath: string) {
    try {
      if (fs.existsSync(filePath)) {
        this.data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch { this.data = {}; }
  }
  keys(): readonly string[] { return Object.keys(this.data); }
  get<T>(key: string, defaultValue?: T): T | undefined {
    const v = this.data[key];
    return v === undefined ? defaultValue : (v as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { delete this.data[key]; } else { this.data[key] = value; }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Atomic write: temp file then rename, so a crash can't corrupt the store.
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* best-effort persistence */ }
  }
  setKeysForSync(_keys: readonly string[]): void { /* no-op headless */ }
}
