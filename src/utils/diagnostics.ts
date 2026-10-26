// ─── Diagnostics report (pure) ───
//
// Builds the markdown "MOAG: Export Diagnostics" saves. Every fact is passed
// in; nothing is read here. The caller runs the whole text through the report
// redactor (ui/report-redaction.ts) before writing it, and this builder adds a
// first line of defence: a setting whose name looks secret renders as [set] or
// [not set], never its value.

import type { InternalError } from './error-log';

export interface DiagnosticsFacts {
  versions: { moag: string; vscode: string; os: string; node: string };
  engines: Array<{ id: string; available: boolean; version?: string | null }>;
  settings: Array<{ key: string; value: unknown; isDefault: boolean }>;
  errors: InternalError[];
  relay: { status: string; urlOrigin: string | null };
  spool: { files: number; bytes: number };
  /** The last lines of the Windows daemon log; null when there is none. */
  daemonLogTail: string | null;
  /** When the report was made (ISO); defaults to now. */
  generatedAt?: string;
}

/** A setting name that may hold a credential. */
export const SECRET_SETTING_RE = /key|token|secret|password/i;

const MAX_VALUE_CHARS = 200;

/** Text for a table cell: one line, pipes escaped, capped. */
function cell(s: string): string {
  const one = s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return one.length > MAX_VALUE_CHARS ? one.slice(0, MAX_VALUE_CHARS - 1) + '…' : one;
}

/** How a setting's value is shown. */
export function renderSettingValue(key: string, value: unknown): string {
  const empty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
  if (SECRET_SETTING_RE.test(key)) { return empty ? '[not set]' : '[set]'; }
  if (value === undefined) { return '(unset)'; }
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  return cell(text ?? String(value));
}

/** A fenced block whose fence cannot be closed by its content. */
function fenced(text: string): string {
  let fence = '```';
  while (text.includes(fence)) { fence += '`'; }
  return `${fence}\n${text}\n${fence}`;
}

/** The diagnostics report as markdown. Pure. */
export function buildDiagnosticsMarkdown(f: DiagnosticsFacts): string {
  const out: string[] = [];
  out.push('# MOAG diagnostics', '');
  out.push(`Generated ${f.generatedAt ?? new Date().toISOString()}. Secrets, the home folder and the workspace path have been removed; read it before you share it.`, '');

  out.push('## Versions', '', '| | |', '|---|---|');
  out.push(`| MOAG | ${cell(f.versions.moag)} |`);
  out.push(`| VS Code | ${cell(f.versions.vscode)} |`);
  out.push(`| OS | ${cell(f.versions.os)} |`);
  out.push(`| Node | ${cell(f.versions.node)} |`, '');

  out.push('## Engines', '');
  if (f.engines.length === 0) {
    out.push('none checked', '');
  } else {
    out.push('| Engine | Available | Version |', '|---|---|---|');
    for (const e of f.engines) {
      out.push(`| ${cell(e.id)} | ${e.available ? 'yes' : 'no'} | ${cell(e.version ?? '')} |`);
    }
    out.push('');
  }

  const changed = f.settings.filter((s) => !s.isDefault);
  out.push('## Settings', '');
  if (changed.length === 0) {
    out.push('All settings are at their defaults.', '');
  } else {
    out.push('| Setting | Value |', '|---|---|');
    for (const s of [...changed].sort((a, b) => a.key.localeCompare(b.key))) {
      out.push(`| ${cell(s.key)} | ${renderSettingValue(s.key, s.value)} |`);
    }
    out.push('', `${f.settings.length - changed.length} other settings are at their defaults.`, '');
  }

  out.push('## Recent errors', '');
  if (f.errors.length === 0) {
    out.push('none', '');
  } else {
    const lines = f.errors.map((e) => {
      const head = `[${String(e.ts).slice(0, 19)}] [${e.category}] ${e.message}${e.context ? ` | ${e.context}` : ''}`;
      const frame = e.stack ? `\n  ${(e.stack.split('\n')[1] ?? '').trim()}` : '';
      return head + frame;
    });
    out.push(fenced(lines.join('\n')), '');
  }

  out.push('## ONOSOO relay', '', '| | |', '|---|---|');
  out.push(`| Status | ${cell(f.relay.status)} |`);
  out.push(`| Backend | ${cell(f.relay.urlOrigin ?? 'not paired')} |`);
  out.push(`| Unsent spool | ${f.spool.files} file${f.spool.files === 1 ? '' : 's'}, ${f.spool.bytes} bytes |`, '');

  out.push('## Daemon log (Windows)', '');
  out.push(f.daemonLogTail === null ? 'not found' : fenced(f.daemonLogTail.trimEnd()), '');

  return out.join('\n');
}
