// ─── Self-reporting — what MOAG says about its own run ──────────────────────
//
// Friction collection, the internal error log, self-issue triage and the
// embedded report panel. One domain: everything MOAG records about how a run
// went and how a person files it back.
//
// Extracted from extension.ts, which was past 9,000 lines. The four pieces of
// extension state this needs are injected rather than reached for, so nothing
// here depends on module load order.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { InternalError } from '../utils/error-log';
import { appendErrorLog as _appendErrorLog, readRecentErrors as _readRecentErrors } from '../utils/error-log';
import { EngineId, HistoryEntry } from '../models/types';
import * as os from 'os';
import { execSync } from 'child_process';
import { analyzeProject } from '../context/project-analyzer';
import { analyzeWeights, saveWeights } from '../context/weights';
import { invalidateWeightsCache } from '../context/context-builder';
import { ghSync } from '../utils/gh';
import { getMoagDir } from '../workspace/moag-paths';
import { RunSession } from '../models/run-session';
import { webviewCsp, webviewNonce, webviewScriptUri } from './webview-assets';
import { buildReportRedactor } from './report-redaction';
import { formatUsd } from '../utils/cost-format';
import * as UserMsg from '../utils/user-messages';

/** What a run cost in friction: retries, escalations, auto-fixes. */
export interface RunFrictionReport {
  runId: string;
  date: string;
  moagVersion: string;
  engine: string;
  projectType: string;
  summary: { total: number; passed: number; failed: number; escalated: number; durationMs: number; estimatedCostUsd: number };
  friction: Array<{ taskName: string; attempts: number; escalated: boolean; autoFixed: boolean; errorSummary: string }>;
  errorCategories: Record<string, number>;
}

/** Everything this module needs from extension.ts, passed in explicitly. */
export interface SelfReportingDeps {
  historyStore: { getAll(): HistoryEntry[]; getForRun(runId: string): HistoryEntry[] };
  runSessionStore: { get(id: string): RunSession | undefined };
  escalatedTaskIds: Set<string>;
  globalState?: { get<T>(key: string, fallback: T): T };
  // Read live: these change as a run proceeds, so a snapshot would be stale.
  executionTaskCount(): number;
  executionTasksFailed(): number;
  appendOutput(line: string): void;
  /** Exact secret values to strip from outbound reports (Anthropic key, ONOSOO key). */
  extraSecrets(): Promise<string[]>;
}

/** Every bug report, feedback and self-issue goes here, whatever the workspace is. */
export const MOAG_REPO = 'sujan-poudel-03/moag';

let deps: SelfReportingDeps;

/** Call once during activate(), before any command can run. */
export function initSelfReporting(d: SelfReportingDeps): void { deps = d; }
// ─── GitHub Integration: report issue ───

export function collectRunFriction(runId: string, durationMs: number): RunFrictionReport {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const entries = deps.historyStore.getForRun(runId);
  const session = deps.runSessionStore.get(runId);
  const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';

  // Group entries by taskId to detect retries
  const byTask = new Map<string, typeof entries>();
  for (const e of entries) {
    const group = byTask.get(e.taskId) ?? [];
    group.push(e);
    byTask.set(e.taskId, group);
  }

  // Project type from analyzeProject
  let projectType = 'unknown';
  try {
    const analysis = analyzeProject(cwd);
    projectType = [analysis.language, analysis.framework].filter(Boolean).join(' / ');
  } catch { /* best-effort */ }

  const dominantEngine = session?.engines?.[0] ?? (entries[0]?.engine ?? 'unknown');

  const friction: RunFrictionReport['friction'] = [];
  const errorCats: Record<string, number> = {};

  for (const [taskId, group] of byTask) {
    const isEscalated = deps.escalatedTaskIds.has(taskId);
    const wasAutoFixed = group.some(e => e.autoFixed);
    const attempts = group.length;
    const lastFailed = [...group].reverse().find(e => e.status === 'failed' || e.status === 'blocked');
    const hasFriction = attempts > 1 || isEscalated || lastFailed;
    if (!hasFriction) { continue; }

    const errorSummary = lastFailed
      ? (lastFailed.result.stderr || lastFailed.result.stdout || '')
          .split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
      : '';

    // Detect error category from stderr prefix patterns
    const stderr = lastFailed?.result.stderr ?? '';
    if (/error ts\d+|typeerror|syntaxerror|cannot find/i.test(stderr)) { errorCats['compile'] = (errorCats['compile'] ?? 0) + 1; }
    else if (/assertionerror|test.*fail|failing.*test|expect.*received/i.test(stderr)) { errorCats['test'] = (errorCats['test'] ?? 0) + 1; }
    else if (/etimedout|timed out|timeout/i.test(stderr)) { errorCats['timeout'] = (errorCats['timeout'] ?? 0) + 1; }
    else if (/spawn.*enoent|command not found|not installed/i.test(stderr)) { errorCats['cli-missing'] = (errorCats['cli-missing'] ?? 0) + 1; }
    else if (lastFailed) { errorCats['unknown'] = (errorCats['unknown'] ?? 0) + 1; }

    friction.push({ taskName: group[0].taskName, attempts, escalated: isEscalated, autoFixed: wasAutoFixed, errorSummary: errorSummary.substring(0, 120) });
  }

  return {
    runId,
    date: new Date().toISOString(),
    moagVersion: extVersion,
    engine: dominantEngine,
    projectType,
    summary: {
      total: deps.executionTaskCount(),
      passed: deps.executionTaskCount() - deps.executionTasksFailed(),
      failed: deps.executionTasksFailed(),
      escalated: deps.escalatedTaskIds.size,
      durationMs,
      estimatedCostUsd: session?.totalCost ?? 0,
    },
    friction,
    errorCategories: errorCats,
  };
}

export function appendFrictionLog(report: RunFrictionReport): void {
  try {
    const moagDir = getMoagDir();
    if (!moagDir) { return; }
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const logPath = path.join(moagDir, 'feedback.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(report) + '\n', 'utf-8');
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length > 20) {
      fs.writeFileSync(logPath, lines.slice(-20).join('\n') + '\n', 'utf-8');
    }
  } catch { /* best-effort */ }
}

export function readLastFrictionReport(): RunFrictionReport | null {
  try {
    const moagDir = getMoagDir();
    if (!moagDir) { return null; }
    const logPath = path.join(moagDir, 'feedback.jsonl');
    if (!fs.existsSync(logPath)) { return null; }
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) { return null; }
    const report = JSON.parse(last) as RunFrictionReport;
    const age = Date.now() - new Date(report.date).getTime();
    return age < 86_400_000 ? report : null;
  } catch { return null; }
}

// ─── Internal error log — thin wrappers around src/utils/error-log.ts ────────


export function appendErrorLog(err: InternalError): void {
  const moagDir = getMoagDir();
  if (!moagDir) { return; }
  _appendErrorLog(moagDir, err, (line: string) => deps.appendOutput(line));
}

export function readRecentErrors(n = 10): InternalError[] {
  const moagDir = getMoagDir();
  if (!moagDir) { return []; }
  return _readRecentErrors(moagDir, n);
}

export async function cmdRunContextEval(): Promise<void> {
  const moagDir = getMoagDir();
  if (!moagDir) { vscode.window.showWarningMessage('No .moag directory found. Open a workspace with a plan first.'); return; }

  // Gather all history entries from deps.historyStore
  const allEntries = deps.historyStore.getAll?.() ?? [];

  // Compute 7 evaluation metrics from instrumented history
  const instrumented = allEntries.filter((e: import('../models/types').HistoryEntry) => e.contextBudgetUsage);
  const total = allEntries.length;
  const withCtx = instrumented.length;

  const completed = allEntries.filter((e: import('../models/types').HistoryEntry) => e.status === 'completed');
  const autoFixed = allEntries.filter((e: import('../models/types').HistoryEntry) => (e as import('../models/types').HistoryEntry & { autoFixed?: boolean }).autoFixed);

  const successRate = total > 0 ? Math.round((completed.length / total) * 100) : 0;
  const firstAttemptSuccess = total > 0
    ? Math.round(((completed.length - autoFixed.length) / total) * 100) : 0;

  const ctxEfficiencies = instrumented.map((e: import('../models/types').HistoryEntry) =>
    e.contextBudgetUsage!.totalCharsBudget > 0
      ? e.contextBudgetUsage!.totalCharsUsed / e.contextBudgetUsage!.totalCharsBudget
      : 0,
  );
  const avgCtxEfficiency = ctxEfficiencies.length > 0
    ? Math.round((ctxEfficiencies.reduce((a: number, b: number) => a + b, 0) / ctxEfficiencies.length) * 100) : 0;

  const signalDensities = instrumented
    .filter((e: import('../models/types').HistoryEntry) => e.contextBudgetUsage!.totalCharsUsed > 0 && (e.changedFiles?.length ?? 0) > 0)
    .map((e: import('../models/types').HistoryEntry) => (e.changedFiles?.length ?? 0) / e.contextBudgetUsage!.totalCharsUsed * 10000);
  const avgSignalDensity = signalDensities.length > 0
    ? (signalDensities.reduce((a: number, b: number) => a + b, 0) / signalDensities.length).toFixed(2) : 'n/a';

  const avgSectionsDropped = instrumented.length > 0
    ? (instrumented.reduce((a: number, e: import('../models/types').HistoryEntry) => a + (e.contextBudgetUsage!.sectionsDropped), 0) / instrumented.length).toFixed(2)
    : 'n/a';

  const tokensEntries = allEntries.filter((e: import('../models/types').HistoryEntry) => (e as import('../models/types').HistoryEntry & { tokenUsage?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } }).tokenUsage);
  const totalCostUsd = tokensEntries.reduce((a: number, e: import('../models/types').HistoryEntry) => {
    const tu = (e as import('../models/types').HistoryEntry & { tokenUsage?: { estimatedCostUsd: number } }).tokenUsage;
    return a + (tu?.estimatedCostUsd ?? 0);
  }, 0);
  const costPerSuccess = completed.length > 0 && totalCostUsd > 0
    ? `$${(totalCostUsd / completed.length).toFixed(4)}` : 'n/a';

  // Read all friction reports for retry rate
  let avgRetries = 'n/a';
  try {
    const logPath = path.join(moagDir, 'feedback.jsonl');
    if (fs.existsSync(logPath)) {
      const reports = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
        .map((l: string) => { try { return JSON.parse(l) as RunFrictionReport; } catch { return null; } })
        .filter(Boolean) as RunFrictionReport[];
      const allFriction = reports.flatMap((r: RunFrictionReport) => r.friction ?? []);
      if (allFriction.length > 0) {
        const totalAttempts = allFriction.reduce((a: number, f: { attempts: number }) => a + f.attempts, 0);
        avgRetries = (totalAttempts / allFriction.length).toFixed(2);
      }
    }
  } catch { /* best-effort */ }

  // Section breakdown averages
  const sectionTotals: Record<string, number[]> = {};
  for (const e of instrumented) {
    const bd = e.contextBudgetUsage!.sectionBreakdown ?? {};
    for (const [k, v] of Object.entries(bd)) {
      if (!sectionTotals[k]) { sectionTotals[k] = []; }
      sectionTotals[k].push(v as number);
    }
  }
  const sectionAvgRows = Object.entries(sectionTotals)
    .sort(([, a], [, b]) => b.reduce((x: number, y: number) => x + y, 0) - a.reduce((x: number, y: number) => x + y, 0))
    .map(([k, vals]) => `| ${k} | ${Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length).toLocaleString()} | ${vals.length} |`)
    .join('\n');

  const reportLines = [
    `# MOAG Context Efficiency Report`,
    ``,
    `Generated from **${total}** history entries (${withCtx} with context instrumentation).`,
    ``,
    `## Evaluation Metrics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Task success rate | ${successRate}% (${completed.length}/${total}) |`,
    `| First-attempt success | ${firstAttemptSuccess}% |`,
    `| Context efficiency ratio | ${avgCtxEfficiency}% (chars used / budget) |`,
    `| Avg signal density | ${avgSignalDensity} (files/10K chars) |`,
    `| Avg sections dropped | ${avgSectionsDropped} |`,
    `| Cost per success | ${costPerSuccess} |`,
    `| Avg retries per task | ${avgRetries} |`,
    ``,
    `## Average Chars per Section (instrumented tasks)`,
    ``,
    sectionTotals && Object.keys(sectionTotals).length > 0
      ? `| Section | Avg chars | Tasks |\n|---------|-----------|-------|\n${sectionAvgRows}`
      : `_No section breakdown data yet — run tasks to populate._`,
    ``,
    `## Interpretation`,
    ``,
    `- **Context efficiency ratio < 50%**: context budget is oversized — reduce \`maxContextChars\``,
    `- **Sections dropped > 0**: budget is too tight for some tasks — consider increasing for agent tasks`,
    `- **Signal density > 1.0**: good — each 10K chars of context drives ≥1 file change`,
    `- **First-attempt success < 70%**: agents may be getting noisy/irrelevant context`,
  ];

  const doc = await vscode.workspace.openTextDocument({ content: reportLines.join('\n'), language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function cmdAnalyzeContextWeights(): Promise<void> {
  const moagDir = getMoagDir();
  if (!moagDir) { vscode.window.showWarningMessage('No .moag directory found.'); return; }
  const all = deps.historyStore.getAll();
  const instrumented = all.filter(e => e.contextBudgetUsage);
  if (instrumented.length < 20) {
    vscode.window.showInformationMessage(
      `Need ≥20 instrumented tasks to compute weights (have ${instrumented.length}). Run more tasks first.`,
    );
    return;
  }
  const weights = analyzeWeights(instrumented);
  saveWeights(moagDir, weights);
  invalidateWeightsCache();
  vscode.window.showInformationMessage(
    `Context weights updated from ${weights.sampleCount} tasks. Active on next task run.`,
  );
}

export function buildFrictionIssueBody(report: RunFrictionReport, notes: string): string {
  const durationStr = report.summary.durationMs > 0
    ? `${Math.floor(report.summary.durationMs / 60000)}m ${Math.floor((report.summary.durationMs % 60000) / 1000)}s`
    : 'n/a';
  // The friction report has no count of unknown-cost calls, so zero reads "not reported", never "$0".
  const costStr = report.summary.estimatedCostUsd > 0 ? formatUsd(report.summary.estimatedCostUsd) : 'not reported';

  const frictionTable = report.friction.length > 0
    ? `| Task | Attempts | Auto-fixed | Escalated | Error |\n` +
      `|------|----------|------------|-----------|-------|\n` +
      report.friction.map(f =>
        `| ${f.taskName.substring(0, 40)} | ${f.attempts} | ${f.autoFixed ? '✓' : '✗'} | ${f.escalated ? '✓' : '✗'} | ${f.errorSummary.substring(0, 60)} |`
      ).join('\n')
    : '_No friction points recorded._';

  const errorPatterns = Object.entries(report.errorCategories)
    .map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none';

  return [
    `## MOAG Session Feedback`,
    ``,
    `**MOAG:** v${report.moagVersion} | **Engine:** ${report.engine} | **Project:** ${report.projectType}`,
    ``,
    `### Run Summary`,
    `- ${report.summary.total} tasks total · ${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.escalated} escalated`,
    `- Duration: ${durationStr} · Est. cost: ${costStr}`,
    ``,
    `### Friction Points`,
    frictionTable,
    ``,
    `### Error Patterns`,
    errorPatterns,
    notes ? `\n### Notes\n${notes}` : '',
    ``,
    `---`,
    `*Filed automatically by MOAG v${report.moagVersion}*`,
  ].filter(l => l !== null).join('\n');
}


// --- MOAG Self-Issue Collection ---

export type SelfIssueType = 'engine-not-found' | 'spawn-error' | 'context-overflow' |
  'auth-failure' | 'parse-error' | 'timeout' | 'moag-crash' | 'other';

export interface SelfIssue {
  id: string; type: SelfIssueType; message: string; detail: string;
  moagVersion: string; engine: string; platform: string;
  timestamp: string; fingerprint: string; filed: boolean;
}

export function classifyMoagIssue(stderr: string, exitCode: number): SelfIssueType | null {
  const s = stderr.toLowerCase();
  if (s.includes('spawn') && s.includes('enoent')) { return 'engine-not-found'; }
  if (s.includes('spawn') && (s.includes('eperm') || s.includes('eacces'))) { return 'spawn-error'; }
  if (s.includes('context length') || s.includes('context window') || s.includes('too many tokens')) { return 'context-overflow'; }
  if (s.includes('authentication') || s.includes('unauthorized') || s.includes('api key') || s.includes('401')) { return 'auth-failure'; }
  if (s.includes('syntaxerror') && s.includes('json')) { return 'parse-error'; }
  if (exitCode === 124 || (s.includes('timed out') && !s.includes('task timed out'))) { return 'timeout'; }
  return null;
}

export function getSelfIssueLogPath(): string | null {
  const d = getMoagDir(); return d ? path.join(d, 'self-issues.jsonl') : null;
}

export function logMoagSelfIssue(type: SelfIssueType, message: string, detail: string): void {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath) { return; }
    const moagDir = path.dirname(logPath);
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const fingerprint = type + ':' + detail.substring(0, 60).replace(/\s+/g, ' ').trim();
    if (fs.existsSync(logPath)) {
      const cutoff = Date.now() - 86400000;
      const recent = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
        .map((l: string) => { try { return JSON.parse(l) as SelfIssue; } catch { return null; } })
        .filter((e: SelfIssue | null): e is SelfIssue => !!e && new Date(e.timestamp).getTime() > cutoff);
      if (recent.some((e: SelfIssue) => e.fingerprint === fingerprint)) { return; }
    }
    const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
    const issue: SelfIssue = {
      id: 'si-' + Date.now(), type, message, detail, moagVersion: extVersion,
      engine: vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('defaultEngine', 'claude'),
      platform: process.platform, timestamp: new Date().toISOString(), fingerprint, filed: false,
    };
    fs.appendFileSync(logPath, JSON.stringify(issue) + '\n', 'utf-8');
    const all = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (all.length > 50) { fs.writeFileSync(logPath, all.slice(-50).join('\n') + '\n', 'utf-8'); }
  } catch { /* best-effort */ }
}

export function readUnfiledSelfIssues(): SelfIssue[] {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath || !fs.existsSync(logPath)) { return []; }
    return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l: string) => { try { return JSON.parse(l) as SelfIssue; } catch { return null; } })
      .filter((e: SelfIssue | null): e is SelfIssue => !!e && !e.filed);
  } catch { return []; }
}

export function markSelfIssuesFiled(ids: string[]): void {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath || !fs.existsSync(logPath)) { return; }
    const updated = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l: string) => {
        try { const e = JSON.parse(l) as SelfIssue; if (ids.includes(e.id)) { e.filed = true; } return JSON.stringify(e); }
        catch { return l; }
      });
    fs.writeFileSync(logPath, updated.join('\n') + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

/**
 * File the selected self-issues as one public issue on the MOAG repository,
 * through the same preview-before-posting panel as a bug report.
 */
export async function cmdReviewSelfIssues(): Promise<void> {
  const issues = readUnfiledSelfIssues();
  if (issues.length === 0) {
    vscode.window.showInformationMessage('No unfiled MOAG self-issues collected yet.');
    return;
  }
  const items = issues.map(issue => ({
    label: '$(bug) ' + issue.message,
    description: new Date(issue.timestamp).toLocaleString(),
    detail: issue.type + ' · engine: ' + issue.engine + ' · v' + issue.moagVersion,
    issue, picked: true,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: issues.length + ' MOAG issue' + (issues.length > 1 ? 's' : '') + ' collected — select to report in one public issue',
    title: 'MOAG Self-Issues',
  });
  if (!selected || selected.length === 0) { return; }
  const extVersion = moagVersion();
  const n = selected.length;
  const title = `[auto] ${n} MOAG self-issue${n === 1 ? '' : 's'} [v${extVersion}]`;
  const sections = selected.map(({ issue }, i) => [
    `## ${i + 1}. ${issue.message}`,
    '**Type:** `' + issue.type + '`  **Detected:** ' + new Date(issue.timestamp).toLocaleString(),
    '', '| | |', '|---|---|',
    '| **MOAG** | v' + issue.moagVersion + ' |',
    '| **Engine** | ' + issue.engine + ' |',
    '| **Platform** | ' + issue.platform + ' |',
    '', '```', issue.detail.substring(0, 500), '```',
  ].join('\n'));
  const body = [
    ...sections,
    '---', '*Auto-collected by MOAG v' + extVersion + ' self-issue monitor*',
  ].join('\n\n');
  await openReportPanel('bug', undefined, undefined, {
    draft: { title, body },
    onPosted: () => markSelfIssuesFiled(selected.map(s => s.issue.id)),
  });
}


// ─── Embedded report panel: compose → preview → post ───

/** GitHub caps nothing, but the OS does: ShellExecute on Windows stops near 2,083 characters. */
const NEW_ISSUE_URL_MAX: Readonly<Record<'win32' | 'other', number>> = { win32: 2000, other: 8000 };

const TRUNCATION_NOTE = '\n\n_(Truncated: the full report is on your clipboard — paste it here.)_';

/**
 * A prefilled `issues/new` URL on the MOAG repository, for when `gh` is missing
 * or not signed in. The whole URL (after encodeURIComponent) stays under the
 * platform cap; when the body had to be cut, the cut is stated in the body and
 * `truncated` is true so the caller can put the full body on the clipboard.
 */
export function buildNewIssueUrl(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): { url: string; truncated: boolean } {
  const cap = platform === 'win32' ? NEW_ISSUE_URL_MAX.win32 : NEW_ISSUE_URL_MAX.other;
  const head = (t: string): string => `https://github.com/${MOAG_REPO}/issues/new?title=${encodeURIComponent(t)}&body=`;
  let base = head(title);
  const full = base + encodeURIComponent(body);
  if (full.length <= cap) { return { url: full, truncated: false }; }

  // A title that alone overflows is cut too (by code point, so no lone surrogate reaches the encoder).
  const titleChars = Array.from(title);
  while (base.length + encodeURIComponent(TRUNCATION_NOTE).length > cap && titleChars.length > 0) {
    titleChars.splice(Math.max(0, titleChars.length - 10));
    base = head(titleChars.join(''));
  }
  // Largest body prefix (in code points) that still fits with the note.
  const chars = Array.from(body);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const len = base.length + encodeURIComponent(chars.slice(0, mid).join('') + TRUNCATION_NOTE).length;
    if (len <= cap) { lo = mid; } else { hi = mid - 1; }
  }
  return { url: base + encodeURIComponent(chars.slice(0, lo).join('') + TRUNCATION_NOTE), truncated: true };
}

/** Escape text for an HTML text node or attribute. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The installed MOAG version, or 'unknown'. */
function moagVersion(): string {
  return (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
}

export function buildReportPanelHtml(webview: vscode.Webview, opts: {
  mode: 'bug' | 'feedback';
  title: string;
  subtitle: string;
  placeholder: string;
  contextHtml: string;
  /** A ready draft (self-issues): the panel opens straight on the preview step. */
  draft?: { title: string; body: string };
}): string {
  // The script is a compiled file; the CSP admits only the nonce it carries.
  const scriptUri = webviewScriptUri(webview, 'report-panel');
  const nonce = webviewNonce();
  const csp = webviewCsp(webview, nonce);
  const { mode, title, subtitle, placeholder, contextHtml, draft } = opts;
  const icon = mode === 'bug' ? '🐛' : '📊';
  // Data, not script: the CSP never runs it, and `<` is escaped so it cannot close the tag.
  const draftJson = draft ? JSON.stringify(draft).replace(/</g, '\\u003c') : '';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  ${csp}
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .header{padding:20px 24px 12px;border-bottom:1px solid var(--vscode-widget-border,transparent)}
  h1{font-size:1.3em;font-weight:600;margin-bottom:6px}
  h2{font-size:1em;font-weight:600}
  .subtitle{color:var(--vscode-descriptionForeground);font-size:.88em;line-height:1.5}
  .body{flex:1;padding:16px 24px;display:flex;flex-direction:column;gap:12px;overflow:auto}
  label{font-size:.85em;font-weight:600;color:var(--vscode-foreground);opacity:.8}
  textarea{flex:1;min-height:120px;resize:none;padding:10px 12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;font-family:inherit;font-size:inherit;line-height:1.5}
  textarea:focus{outline:none;border-color:var(--vscode-focusBorder)}
  .context-box{background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-textBlockQuote-border);padding:10px 14px;border-radius:0 4px 4px 0;font-size:.82em;line-height:1.7;color:var(--vscode-descriptionForeground)}
  .context-box strong{color:var(--vscode-foreground)}
  pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background);padding:10px 12px;border-radius:4px;font-family:var(--vscode-editor-font-family);font-size:.85em;line-height:1.5;flex:1;overflow:auto}
  .notice{color:var(--vscode-descriptionForeground);font-size:.85em}
  .footer{padding:12px 24px;border-top:1px solid var(--vscode-widget-border,transparent);display:flex;justify-content:flex-end;gap:8px}
  button{padding:8px 18px;border:none;border-radius:4px;cursor:pointer;font-size:.9em;font-weight:600;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  button.primary:hover{background:var(--vscode-button-hoverBackground)}
  button:disabled{opacity:.5;cursor:not-allowed}
  [hidden]{display:none!important}
</style></head><body>
<div class="header">
  <h1>${icon} ${escapeHtml(title)}</h1>
  <p class="subtitle">${subtitle}</p>
</div>
<div id="composeStep" class="body"${draft ? ' hidden' : ''}>
  <div>
    <label for="desc">Description (optional)</label>
    <textarea id="desc" placeholder="${escapeHtml(placeholder)}" style="margin-top:6px;width:100%"></textarea>
  </div>
  <div class="context-box"><strong>Auto-included:</strong><br>${contextHtml}</div>
</div>
<div id="previewStep" class="body"${draft ? '' : ' hidden'}>
  <p class="notice">This is exactly what will be posted. Secrets and your home and workspace paths have been removed.</p>
  <h2 id="previewTitle"></h2>
  <pre id="preview"></pre>
</div>
<div class="footer">
  <span id="composeButtons"${draft ? ' hidden' : ''}><button class="primary" id="fileBtn">Preview &rarr;</button></span>
  <span id="previewButtons"${draft ? '' : ' hidden'}>
    <button id="cancelBtn">Cancel</button>
    <button id="copyBtn">Copy</button>
    <button class="primary" id="postBtn" title="Posts a public issue on github.com/${MOAG_REPO}">Post publicly</button>
  </span>
</div>
<p class="notice" style="padding:0 24px 12px;text-align:right">Posts a public issue on github.com/${MOAG_REPO}</p>
<script type="application/json" id="draft">${draftJson}</script>
  <script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

/** A report as it will be posted: already redacted. */
interface ReportDraft { title: string; body: string }

/** Options for a panel opened on a ready draft (self-issues). */
interface PreparedReport {
  draft: { title: string; body: string };
  /** Called after the issue was created through gh. */
  onPosted?: () => void;
}

/** The redactor every outbound report passes through, built per report. */
async function reportRedactor(cwd: string | null): Promise<(text: string) => string> {
  let extra: string[] = [];
  try { extra = await deps.extraSecrets(); } catch { /* the shapes and .env still apply */ }
  return buildReportRedactor({ cwd, home: os.homedir(), env: process.env, extraSecrets: extra });
}

/** True when `gh` is installed and signed in. */
function ghReady(cwd: string | undefined): boolean {
  try {
    execSync('gh auth status', { cwd, timeout: 8000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Post a redacted draft to the MOAG repository: through `gh` when it is signed
 * in, otherwise by opening a prefilled issues/new page in the browser. Returns
 * true when an issue was created through gh.
 */
async function postReport(draft: ReportDraft, cwd: string | undefined): Promise<boolean> {
  if (ghReady(cwd)) {
    const tmpPath = path.join(os.tmpdir(), `moag-report-${Date.now()}.md`);
    try {
      fs.writeFileSync(tmpPath, draft.body, 'utf-8');
      const rawOut = ghSync(['issue', 'create', '--repo', MOAG_REPO, '--title', draft.title, '--body-file', tmpPath], { cwd, timeout: 20000 });
      const url = rawOut.trim().split('\n').filter(l => l.includes('github.com')).pop() || '';
      if (!url) {
        vscode.window.showErrorMessage(`Issue creation returned unexpected output: ${rawOut.substring(0, 200)}`);
        return false;
      }
      void vscode.window.showInformationMessage(`Issue filed: ${url}`, 'View Issue').then((a) => {
        if (a === 'View Issue') { void vscode.env.openExternal(vscode.Uri.parse(url)); }
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message.substring(0, 300) : String(err);
      appendErrorLog({ ts: new Date().toISOString(), category: 'github', message: msg, context: 'gh issue create (report)' });
      vscode.window.showErrorMessage(`Failed to create issue: ${msg}`);
      return false;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  // No gh, or not signed in: the browser fallback.
  const { url, truncated } = buildNewIssueUrl(draft.title, draft.body);
  if (truncated) {
    await vscode.env.clipboard.writeText(draft.body);
    void vscode.window.showInformationMessage(
      'The report was too long for a link, so GitHub opens with a shortened copy. The full report is on your clipboard: paste it into the issue.',
    );
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
  return false;
}

export async function openReportPanel(
  mode: 'bug' | 'feedback',
  prefillText?: string,
  frictionReport?: RunFrictionReport | null,
  prepared?: PreparedReport,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const cwd = workspaceRoot ?? undefined;
  // Built first: even the compose step shows only redacted text.
  const redact = await reportRedactor(workspaceRoot);

  const extVersion = moagVersion();
  const detectedEngines = deps.globalState?.get<EngineId[]>('agentTaskPlayer.detectedEngines', []) ?? [];
  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('defaultEngine', 'claude');

  let contextHtml = `MOAG v${escapeHtml(extVersion)} &nbsp;·&nbsp; VS Code v${escapeHtml(vscode.version)} &nbsp;·&nbsp; ${process.platform} &nbsp;·&nbsp; engine: ${escapeHtml(defaultEngine)}`;
  if (detectedEngines.length > 0) { contextHtml += ` (installed: ${escapeHtml(detectedEngines.join(', '))})`; }

  let panelTitle: string, subtitle: string, placeholder: string;

  if (prepared) {
    panelTitle = 'Report MOAG Self-Issues';
    subtitle = `Review the report, then post it as a public issue on <code>${MOAG_REPO}</code>.`;
    placeholder = '';
  } else if (mode === 'bug') {
    panelTitle = 'Report MOAG Issue';
    subtitle = `Posts a public issue on <code>${MOAG_REPO}</code> with environment info. You see the full text before anything is posted.`;
    placeholder = 'e.g. task hung, wrong output, crashed on start...';
    const friction = frictionReport ?? readLastFrictionReport();
    if (friction) {
      contextHtml += `<br>Recent run: ${friction.summary.failed} failed · ${friction.summary.escalated} escalated · engine: ${escapeHtml(friction.engine)}`;
    }
    if (prefillText) {
      const snippet = redact(prefillText).split('\n').filter(l => l.trim()).slice(0, 5).map(escapeHtml).join('<br>');
      contextHtml += `<br><em>Error output: ${snippet}</em>`;
    }
  } else {
    panelTitle = 'Share Run Feedback';
    const fc = frictionReport?.friction.length ?? 0;
    subtitle = `${fc} friction point${fc !== 1 ? 's' : ''} on <strong>${escapeHtml(frictionReport?.projectType ?? 'unknown project')}</strong>. Posts a public issue on <code>${MOAG_REPO}</code>; you see the full text first.`;
    placeholder = 'What was confusing, slow, or broke unexpectedly? (optional)';
    if (frictionReport) {
      contextHtml += `<br>${frictionReport.summary.total} tasks · ${frictionReport.summary.failed} failed · ${frictionReport.summary.escalated} escalated · ${frictionReport.summary.durationMs > 0 ? Math.round(frictionReport.summary.durationMs / 60000) + 'm' : 'n/a'}`;
      const cats = Object.entries(frictionReport.errorCategories).map(([k, v]) => `${k}(${v})`).join(', ');
      if (cats) { contextHtml += ` · errors: ${escapeHtml(cats)}`; }
    }
  }

  // The draft shown is the draft posted: both are this redacted copy.
  let pending: ReportDraft | null = prepared
    ? { title: redact(prepared.draft.title), body: redact(prepared.draft.body) }
    : null;

  const panel = vscode.window.createWebviewPanel(
    'moagReportIssue', `MOAG — ${panelTitle}`, vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  let disposed = false;
  panel.onDidDispose(() => { disposed = true; });
  const post = (message: unknown): void => {
    if (disposed) { return; }
    try { void panel.webview.postMessage(message); } catch { /* panel closed mid-call */ }
  };
  panel.webview.html = buildReportPanelHtml(panel.webview, {
    mode, title: panelTitle, subtitle, placeholder, contextHtml, draft: pending ?? undefined,
  });

  let posting = false;
  panel.webview.onDidReceiveMessage(async (message: { type?: string; description?: string }) => {
    switch (message?.type) {
      case 'submitReport': {
        const description = typeof message.description === 'string' ? message.description : '';
        const draft = mode === 'bug'
          ? buildBugDraft(description, prefillText, frictionReport, extVersion, defaultEngine, detectedEngines)
          : buildFeedbackDraft(description, frictionReport);
        if (!draft) { return; }
        pending = { title: redact(draft.title), body: redact(draft.body) };
        post({ type: 'preview', title: pending.title, body: pending.body, via: ghReady(cwd) ? 'gh' : 'browser' });
        return;
      }
      case 'confirmPost': {
        if (!pending || posting) { return; }
        posting = true;
        try {
          const viaGh = await postReport(pending, cwd);
          if (viaGh) { prepared?.onPosted?.(); }
        } catch (err) {
          // The browser fallback (clipboard, openExternal) can reject: say so, keep the panel for Copy.
          void UserMsg.showError(UserMsg.actionFailed('post the report', err instanceof Error ? err.message : String(err)));
          return;
        } finally {
          posting = false;
        }
        if (!disposed) { panel.dispose(); }
        return;
      }
      case 'copy': {
        if (!pending) { return; }
        try {
          await vscode.env.clipboard.writeText(`${pending.title}\n\n${pending.body}`);
          void vscode.window.showInformationMessage('Report copied to the clipboard.');
        } catch (err) {
          void UserMsg.showError(UserMsg.actionFailed('copy the report', err instanceof Error ? err.message : String(err)));
        }
        return;
      }
      case 'cancel':
        if (!disposed) { panel.dispose(); }
        return;
      default:
        return;
    }
  });
}

/** The bug report as it would be posted, before redaction. */
function buildBugDraft(
  description: string,
  prefillText: string | undefined,
  frictionReport: RunFrictionReport | null | undefined,
  extVersion: string,
  defaultEngine: string,
  detectedEngines: readonly string[],
): ReportDraft {
  const title = `MOAG bug report [v${extVersion} / ${new Date().toISOString().substring(0, 10)}]`;
  const errLines = (prefillText ?? '').split('\n').filter(l => l.trim()).slice(0, 30).join('\n');
  const friction = frictionReport ?? readLastFrictionReport();
  const frictionSuffix = friction
    ? `\n\n**Recent run friction:**\n- ${friction.summary.failed} failed · ${friction.summary.escalated} escalated · engine: ${friction.engine}\n- Error patterns: ${Object.entries(friction.errorCategories).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`
    : '';
  // Attach recent internal extension errors to the report
  const recentErrs = readRecentErrors(15);
  const errorLogSection = recentErrs.length > 0
    ? `\n\n## Extension Error Log (last ${recentErrs.length})\n\`\`\`\n` +
      recentErrs.map(e =>
        `[${e.ts.substring(0, 19)}] [${e.category}] ${e.message}` +
        (e.context ? ` | ${e.context}` : '') +
        (e.stack ? `\n  ${(e.stack.split('\n')[1] ?? '').trim()}` : '')
      ).join('\n') +
      '\n```'
    : '';

  const bodyParts = [
    '## Environment', '| | |', '|---|---|',
    `| **MOAG** | v${extVersion} |`,
    `| **VS Code** | v${vscode.version} |`,
    `| **Platform** | ${process.platform} |`,
    `| **Engine** | ${defaultEngine} (detected: ${detectedEngines.join(', ') || 'none'}) |`,
    errLines ? `\n## Error Output\n\`\`\`\n${errLines}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');
  const body = [description, bodyParts + frictionSuffix + errorLogSection].filter(Boolean).join('\n\n');
  return { title, body };
}

/** The run-feedback report as it would be posted, before redaction; null without friction data. */
function buildFeedbackDraft(description: string, frictionReport: RunFrictionReport | null | undefined): ReportDraft | null {
  if (!frictionReport) { return null; }
  const fc = frictionReport.friction.length;
  const title = `Session feedback: ${fc} friction point${fc !== 1 ? 's' : ''} on ${frictionReport.projectType} [${frictionReport.date.substring(0, 10)}]`;
  return { title, body: buildFrictionIssueBody(frictionReport, description) };
}

/** Share the last run's friction report as a public issue on the MOAG repository. */
export async function cmdShareRunFeedback(): Promise<void> {
  const report = readLastFrictionReport();
  if (!report) {
    vscode.window.showInformationMessage('No recent friction data found. Run a plan first.');
    return;
  }
  await openReportPanel('feedback', undefined, report);
}

export async function cmdReportIssue(prefillText?: string): Promise<void> {
  await openReportPanel('bug', prefillText);
}
