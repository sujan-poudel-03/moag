// ─── Anthropic API key — SecretStorage commands and settings migration ──────
//
// The Anthropic API engine's key lives in VS Code's SecretStorage, never in a
// settings file: user settings sync across machines, and workspace settings
// (.vscode/settings.json) are often committed. The adapter reads it through the
// host port (core/host.ts `secret`), so the engine core stays vscode-free.
//
// Order the adapter uses: stored secret → ANTHROPIC_API_KEY → legacy setting.
// The legacy setting stays declared (deprecated) because the headless CLI's
// file config still reads it; in VS Code, any value found there is moved here.

import * as vscode from 'vscode';
import type { HostSecretName } from '../core/host';
import { API_KEY_RE } from '../shared/engine-keys';

/** SecretStorage key for each host secret. */
export const SECRET_KEYS: Readonly<Record<HostSecretName, string>> = Object.freeze({
  anthropicApiKey: 'agentTaskPlayer.anthropicApiKey',
});

const SECTION = 'agentTaskPlayer.engines.anthropic';
const SETTING = 'apiKey';

/** The slice of ExtensionContext these commands use. */
export interface SecretsContext {
  secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;
}

/** Ask for the key (masked) and store it. The key is never echoed. */
export async function cmdSetAnthropicKey(context: SecretsContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'Set Anthropic API Key',
    prompt: 'Paste your Anthropic API key. It is kept in VS Code\'s secret storage, not in settings.',
    placeHolder: 'sk-ant-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v: string) => (API_KEY_RE.test(v.trim()) ? null : 'That does not look like an API key (8–512 printable characters, no spaces).'),
  });
  const key = value?.trim();
  if (!key) { return; }
  try {
    await context.secrets.store(SECRET_KEYS.anthropicApiKey, key);
    void vscode.window.showInformationMessage('Anthropic API key saved in VS Code\'s secret storage.');
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not save the Anthropic API key: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove the stored key after a modal confirmation. */
export async function cmdClearAnthropicKey(context: SecretsContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Clear the stored Anthropic API key? Tasks on the Anthropic API engine will need ANTHROPIC_API_KEY or a new key.',
    { modal: true },
    'Clear',
  );
  if (choice !== 'Clear') { return; }
  try {
    await context.secrets.delete(SECRET_KEYS.anthropicApiKey);
    void vscode.window.showInformationMessage('Anthropic API key cleared.');
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not clear the Anthropic API key: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One settings scope that held the legacy key. */
interface FoundScope {
  label: string;
  /** True for scopes stored in workspace files that may be committed. */
  inRepository: boolean;
  value: string;
  clear(): Thenable<void>;
}

/** Every scope holding a non-empty legacy key, most specific first (folder → workspace → user). */
function findLegacyKeys(): FoundScope[] {
  const out: FoundScope[] = [];
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const cfg = vscode.workspace.getConfiguration(SECTION, folder.uri);
    const v = cfg.inspect<string>(SETTING)?.workspaceFolderValue;
    if (nonEmpty(v)) {
      out.push({
        label: `Folder settings (${folder.name})`, inRepository: true, value: v.trim(),
        clear: () => cfg.update(SETTING, undefined, vscode.ConfigurationTarget.WorkspaceFolder),
      });
    }
  }
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const ins = cfg.inspect<string>(SETTING);
  if (nonEmpty(ins?.workspaceValue)) {
    out.push({
      label: 'Workspace settings', inRepository: true, value: ins.workspaceValue.trim(),
      clear: () => cfg.update(SETTING, undefined, vscode.ConfigurationTarget.Workspace),
    });
  }
  if (nonEmpty(ins?.globalValue)) {
    out.push({
      label: 'User settings', inRepository: false, value: ins.globalValue.trim(),
      clear: () => cfg.update(SETTING, undefined, vscode.ConfigurationTarget.Global),
    });
  }
  return out;
}

let migrating: Promise<void> = Promise.resolve();

/**
 * Move a key found in settings into SecretStorage and clear it from every scope.
 * The most specific value wins (folder → workspace → user), and is stored only
 * when no secret exists yet. If storing fails, nothing is cleared. Calls are
 * serialised: clearing a scope fires the configuration-change trigger again.
 */
export function migrateAnthropicKeySetting(context: SecretsContext): Promise<void> {
  const run = migrating.then(() => migrateOnce(context));
  migrating = run.catch(() => { /* a failed run must not block the next */ });
  return run;
}

async function migrateOnce(context: SecretsContext): Promise<void> {
  const found = findLegacyKeys();
  if (found.length === 0) { return; }

  const existing = await context.secrets.get(SECRET_KEYS.anthropicApiKey);
  if (!existing) {
    // Throws on failure, so the settings are left as they were.
    await context.secrets.store(SECRET_KEYS.anthropicApiKey, found[0].value);
  }

  const cleared: FoundScope[] = [];
  for (const scope of found) {
    try { await scope.clear(); cleared.push(scope); } catch { /* reported below by omission */ }
  }
  if (cleared.length === 0) { return; }

  const where = cleared.map((s) => s.label).join(', ');
  const lead = existing
    ? `Removed the Anthropic API key from ${where}. MOAG keeps the key it already had in VS Code's secret storage.`
    : `Moved the Anthropic API key from ${where} to VS Code's secret storage.`;
  const rotate = cleared.some((s) => s.inRepository)
    ? ' It was in a workspace settings file that may be committed to git: rotate the key in the Anthropic console.'
    : '';
  void vscode.window.showWarningMessage(lead + rotate);
}
