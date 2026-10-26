// ─── MOAG: Export Diagnostics ───
//
// Gathers the facts a support request needs (versions, engines, changed
// settings, recent internal errors, relay state, the Windows daemon log), builds
// the report (utils/diagnostics.ts), redacts the whole text (report-redaction),
// and saves it where the user chooses: the home folder by default, never the
// workspace, so it is not committed by accident.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ENGINE_IDS } from '../models/types';
import { checkEngineAvailability } from '../adapters/index';
import { buildDiagnosticsMarkdown, DiagnosticsFacts } from '../utils/diagnostics';
import { readRecentErrors } from '../utils/error-log';
import { getMoagDir } from '../workspace/moag-paths';
import { resolveOnosooConfig, userConfigDir } from '../headless/onosoo-config';
import { probeRelayStatus } from '../headless/host-run-relay';
import type { RelayEnvSnapshot } from '../headless/run-reporter';
import { buildReportRedactor } from './report-redaction';

/** What the command needs from activate(). */
export interface DiagnosticsDeps {
  context: Pick<vscode.ExtensionContext, 'extension'>;
  relayEnv: RelayEnvSnapshot;
  /** Exact secret values to remove (the Anthropic key, the ONOSOO key). */
  extraSecrets(): Promise<string[]>;
}

/** Lines kept from the end of the daemon log. */
const DAEMON_LOG_LINES = 50;

/** Every agentTaskPlayer.* setting the manifest declares. */
function declaredSettingKeys(pkg: unknown): string[] {
  const conf = (pkg as { contributes?: { configuration?: unknown } })?.contributes?.configuration;
  const blocks = Array.isArray(conf) ? conf : conf ? [conf] : [];
  const keys: string[] = [];
  for (const b of blocks) {
    const props = (b as { properties?: Record<string, unknown> })?.properties;
    if (props) { keys.push(...Object.keys(props)); }
  }
  return keys.filter((k) => k.startsWith('agentTaskPlayer.'));
}

/** Count and size the ONOSOO spool. Never throws. */
function spoolSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { bytes += fs.statSync(p).size; files++; } catch { /* vanished */ }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** The last lines of %LOCALAPPDATA%\moag\daemon.log on Windows; null elsewhere or when absent. */
function daemonLogTail(): string | null {
  if (process.platform !== 'win32') { return null; }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  try {
    const text = fs.readFileSync(path.join(local, 'moag', 'daemon.log'), 'utf-8');
    return text.split(/\r?\n/).slice(-DAEMON_LOG_LINES - 1).join('\n');
  } catch {
    return null;
  }
}

/** Gather every fact. Each part is best-effort: a failure leaves that part empty. */
async function gatherFacts(deps: DiagnosticsDeps): Promise<DiagnosticsFacts> {
  const pkg = deps.context.extension?.packageJSON as { version?: string } | undefined;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  const settings: DiagnosticsFacts['settings'] = [];
  const cfg = vscode.workspace.getConfiguration();
  for (const key of declaredSettingKeys(pkg)) {
    try {
      const ins = cfg.inspect(key);
      const set = ins?.workspaceFolderValue ?? ins?.workspaceValue ?? ins?.globalValue;
      settings.push({ key, value: set === undefined ? ins?.defaultValue : set, isDefault: set === undefined });
    } catch { /* skip */ }
  }

  let engines: DiagnosticsFacts['engines'] = [];
  try {
    const avail = await checkEngineAvailability([...ENGINE_IDS]);
    engines = [...avail.entries()].map(([id, a]) => ({ id, available: a.available, version: a.version ?? null }));
  } catch { /* none */ }

  const moagDir = getMoagDir();
  const errors = moagDir ? readRecentErrors(moagDir, 50) : [];

  const env = { ...process.env, ...deps.relayEnv };
  const enabled = vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('onosoo.relay', true);
  let status = 'none';
  let urlOrigin: string | null = null;
  try {
    status = probeRelayStatus(env, cwd, enabled, () => undefined);
    const relay = resolveOnosooConfig({ env, cwd: cwd ?? os.tmpdir(), stderr: () => undefined });
    if (relay) { urlOrigin = new URL(relay.baseUrl).origin; }
  } catch { /* leave none */ }

  let spool = { files: 0, bytes: 0 };
  try {
    spool = spoolSize(path.join(userConfigDir(process.env, process.platform, os.homedir), 'moag', 'onosoo-spool'));
  } catch { /* none */ }

  return {
    versions: {
      moag: pkg?.version ?? 'unknown',
      vscode: vscode.version,
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
    },
    engines,
    settings,
    errors,
    relay: { status, urlOrigin },
    spool,
    daemonLogTail: daemonLogTail(),
  };
}

/** `yyyymmdd-hhmm` for the default file name. */
function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Export a redacted diagnostics report to a file the user picks. */
export async function cmdExportDiagnostics(deps: DiagnosticsDeps): Promise<void> {
  const facts = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'MOAG: gathering diagnostics…' },
    () => gatherFacts(deps),
  );
  let extra: string[] = [];
  try { extra = await deps.extraSecrets(); } catch { /* shapes and .env still apply */ }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const redact = buildReportRedactor({ cwd, home: os.homedir(), env: process.env, extraSecrets: extra });
  const text = redact(buildDiagnosticsMarkdown(facts));

  const target = await vscode.window.showSaveDialog({
    title: 'Export MOAG Diagnostics',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `moag-diagnostics-${stamp()}.md`)),
    filters: { Markdown: ['md'] },
  });
  if (!target) { return; }
  try {
    fs.writeFileSync(target.fsPath, text, 'utf-8');
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not save the diagnostics: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { preview: false });
}
