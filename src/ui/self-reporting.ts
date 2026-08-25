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
import { analyzeProject } from '../context/project-analyzer';
import { analyzeWeights, saveWeights } from '../context/weights';
import { invalidateWeightsCache } from '../context/context-builder';
import { ghSync } from '../utils/gh';
import { getMoagDir } from '../workspace/moag-paths';
import { RunSession } from '../models/run-session';

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
}

const MOAG_REPO = 'sujan-poudel-03/moag';

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
  const costStr = report.summary.estimatedCostUsd > 0 ? `$${report.summary.estimatedCostUsd.toFixed(2)}` : 'n/a';

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
    placeHolder: issues.length + ' MOAG issue' + (issues.length > 1 ? 's' : '') + ' collected — select to file on GitHub',
    title: 'MOAG Self-Issues',
  });
  if (!selected || selected.length === 0) { return; }
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try { execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' }); }
  catch { vscode.window.showWarningMessage('Install GitHub CLI (gh) to file issues. https://cli.github.com'); return; }
  const repo = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('issueRepo', '').trim() || MOAG_REPO;
  const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
  const filedIds: string[] = [];
  for (const item of selected) {
    const { issue } = item;
    const title = '[auto] ' + issue.message + ' [v' + issue.moagVersion + ' / ' + issue.type + ']';
    const body = [
      '## Auto-collected MOAG Issue',
      '**Type:** `' + issue.type + '`  **Detected:** ' + new Date(issue.timestamp).toLocaleString(),
      '', '## Environment', '| | |', '|---|---|',
      '| **MOAG** | v' + issue.moagVersion + ' |',
      '| **Engine** | ' + issue.engine + ' |',
      '| **Platform** | ' + issue.platform + ' |',
      '', '## Detail', '```', issue.detail.substring(0, 500), '```',
      '---', '*Auto-collected by MOAG v' + extVersion + ' self-issue monitor*',
    ].join('\n');
    try {
      const tmpPath = path.join(require('os').tmpdir(), 'moag-si-' + Date.now() + '.md');
      fs.writeFileSync(tmpPath, body, 'utf-8');
      const result = ghSync(
        ['issue', 'create', '--repo', repo, '--title', title, '--body-file', tmpPath, '--label', 'bug'],
        { cwd, timeout: 20000 },
      ).trim();
      filedIds.push(issue.id);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      const url = result.split('\n').pop() || '';
      if (url) {
        vscode.window.showInformationMessage('Filed: ' + url, 'View').then((a: string | undefined) => {
          if (a === 'View') { vscode.env.openExternal(vscode.Uri.parse(url)); }
        });
      }
    } catch (err) {
      vscode.window.showErrorMessage('Failed: ' + (err instanceof Error ? err.message.substring(0, 150) : String(err)));
    }
  }
  if (filedIds.length > 0) { markSelfIssuesFiled(filedIds); }
}


// ─── Embedded report panel (replaces showInputBox for bug/feedback flows) ───

export function buildReportPanelHtml(opts: {
  mode: 'bug' | 'feedback';
  title: string;
  subtitle: string;
  placeholder: string;
  contextHtml: string;
}): string {
  const { mode, title, subtitle, placeholder, contextHtml } = opts;
  const btnLabel = mode === 'bug' ? 'File Issue &rarr;' : 'Share Feedback &rarr;';
  const icon = mode === 'bug' ? '🐛' : '📊';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .header{padding:20px 24px 12px;border-bottom:1px solid var(--vscode-widget-border,#333)}
  h1{font-size:1.3em;font-weight:600;margin-bottom:6px}
  .subtitle{color:var(--vscode-descriptionForeground);font-size:.88em;line-height:1.5}
  .body{flex:1;padding:16px 24px;display:flex;flex-direction:column;gap:12px;overflow:auto}
  label{font-size:.85em;font-weight:600;color:var(--vscode-foreground);opacity:.8}
  textarea{flex:1;min-height:120px;resize:none;padding:10px 12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:4px;font-family:inherit;font-size:inherit;line-height:1.5}
  textarea:focus{outline:none;border-color:var(--vscode-focusBorder)}
  .context-box{background:var(--vscode-textBlockQuote-background,#1e1e2e);border-left:3px solid var(--vscode-textBlockQuote-border,#444);padding:10px 14px;border-radius:0 4px 4px 0;font-size:.82em;line-height:1.7;color:var(--vscode-descriptionForeground)}
  .context-box strong{color:var(--vscode-foreground)}
  .footer{padding:12px 24px;border-top:1px solid var(--vscode-widget-border,#333);display:flex;justify-content:flex-end}
  .file-btn{padding:8px 22px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:.9em;font-weight:600}
  .file-btn:hover{background:var(--vscode-button-hoverBackground)}
  .file-btn:disabled{opacity:.5;cursor:not-allowed}
</style></head><body>
<div class="header">
  <h1>${icon} ${title}</h1>
  <p class="subtitle">${subtitle}</p>
</div>
<div class="body">
  <div>
    <label>Description (optional)</label>
    <textarea id="desc" placeholder="${placeholder}" style="margin-top:6px;width:100%"></textarea>
  </div>
  <div class="context-box"><strong>Auto-included:</strong><br>${contextHtml}</div>
</div>
<div class="footer">
  <button class="file-btn" id="fileBtn">${btnLabel}</button>
</div>
<script>
  var vscode = acquireVsCodeApi();
  var desc = document.getElementById('desc');
  var fileBtn = document.getElementById('fileBtn');
  fileBtn.addEventListener('click', function() {
    fileBtn.disabled = true;
    fileBtn.textContent = 'Filing\\u2026';
    vscode.postMessage({ type: 'submitReport', description: desc.value.trim() });
  });
  desc.focus();
</script></body></html>`;
}

export async function openReportPanel(
  mode: 'bug' | 'feedback',
  prefillText?: string,
  frictionReport?: RunFrictionReport | null,
  targetRepo?: string,
): Promise<void> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try { execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' }); }
  catch { vscode.window.showWarningMessage('Install GitHub CLI (gh) to file issues. https://cli.github.com'); return; }

  const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
  const detectedEngines = deps.globalState?.get<EngineId[]>('agentTaskPlayer.detectedEngines', []) ?? [];
  const defaultEngine = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('defaultEngine', 'claude');

  let contextHtml = `MOAG v${extVersion} &nbsp;·&nbsp; VS Code v${vscode.version} &nbsp;·&nbsp; ${process.platform} &nbsp;·&nbsp; engine: ${defaultEngine}`;
  if (detectedEngines.length > 0) { contextHtml += ` (installed: ${detectedEngines.join(', ')})`; }

  let panelTitle: string, subtitle: string, placeholder: string;

  if (mode === 'bug') {
    panelTitle = 'Report MOAG Issue';
    subtitle = `Files to <code>${MOAG_REPO}</code> with environment info attached automatically.`;
    placeholder = 'e.g. task hung, wrong output, crashed on start...';
    const friction = frictionReport ?? readLastFrictionReport();
    if (friction) {
      contextHtml += `<br>Recent run: ${friction.summary.failed} failed · ${friction.summary.escalated} escalated · engine: ${friction.engine}`;
    }
    if (prefillText) {
      const snippet = prefillText.split('\n').filter(l => l.trim()).slice(0, 5).join('<br>');
      contextHtml += `<br><em>Error output: ${snippet}</em>`;
    }
  } else {
    panelTitle = 'Share Run Feedback';
    const fc = frictionReport?.friction.length ?? 0;
    subtitle = `${fc} friction point${fc !== 1 ? 's' : ''} on <strong>${frictionReport?.projectType ?? 'unknown project'}</strong> — files to <code>${targetRepo ?? MOAG_REPO}</code>.`;
    placeholder = 'What was confusing, slow, or broke unexpectedly? (optional)';
    if (frictionReport) {
      contextHtml += `<br>${frictionReport.summary.total} tasks · ${frictionReport.summary.failed} failed · ${frictionReport.summary.escalated} escalated · ${frictionReport.summary.durationMs > 0 ? Math.round(frictionReport.summary.durationMs / 60000) + 'm' : 'n/a'}`;
      const cats = Object.entries(frictionReport.errorCategories).map(([k, v]) => `${k}(${v})`).join(', ');
      if (cats) { contextHtml += ` · errors: ${cats}`; }
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'moagReportIssue', `MOAG — ${panelTitle}`, vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  panel.webview.html = buildReportPanelHtml({ mode, title: panelTitle, subtitle, placeholder, contextHtml });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type !== 'submitReport') { return; }
    panel.dispose();
    const description = message.description as string;

    if (mode === 'bug') {
      const autoTitle = `MOAG bug report [v${extVersion} / ${new Date().toISOString().substring(0, 10)}]`;
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
      const fullBody = [description, bodyParts + frictionSuffix + errorLogSection].filter(Boolean).join('\n\n');
      const cfgForReport = vscode.workspace.getConfiguration('agentTaskPlayer');
      const repo = cfgForReport.get<string>('issueRepo', '').trim() || MOAG_REPO;
      const syncLabel = cfgForReport.get<string>('issueSync.label', '').trim() || 'moag';
      const tmpPath = path.join(os.tmpdir(), `moag-bug-${Date.now()}.md`);
      // Verify gh is available and authenticated (exit code 0 = ok, non-zero = not auth'd, ENOENT = not installed)
      try {
        execSync('gh auth status', { cwd, timeout: 8000, stdio: 'ignore' });
      } catch (authErr) {
        const msg = authErr instanceof Error ? authErr.message : String(authErr);
        if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('not recognized')) {
          vscode.window.showErrorMessage('GitHub CLI (gh) is not installed. Install from https://cli.github.com');
        } else {
          vscode.window.showErrorMessage('GitHub CLI (gh) is not authenticated. Run "gh auth login" in a terminal first.');
        }
        return;
      }
      try {
        fs.writeFileSync(tmpPath, fullBody, 'utf-8');
        // Ensure labels exist (idempotent)
        try { ghSync(['label', 'create', 'bug', '--repo', repo, '--color', 'd73a4a', '--description', "Something isn't working", '--force'], { cwd, timeout: 8000 }); } catch { /* already exists */ }
        try { ghSync(['label', 'create', syncLabel, '--repo', repo, '--color', '0075ca', '--description', 'MOAG task sync', '--force'], { cwd, timeout: 8000 }); } catch { /* already exists */ }
        const rawOut = ghSync(['issue', 'create', '--repo', repo, '--title', autoTitle, '--body-file', tmpPath, '--label', 'bug', '--label', syncLabel], { cwd, timeout: 20000 });
        const url = rawOut.trim().split('\n').filter(l => l.includes('github.com')).pop() || rawOut.trim().split('\n').pop() || '';
        if (!url.includes('github.com')) {
          vscode.window.showErrorMessage(`Issue creation returned unexpected output: ${rawOut.substring(0, 200)}`);
          return;
        }
        const action = await vscode.window.showInformationMessage(`Issue filed: ${url}`, 'View Issue');
        if (action === 'View Issue') { vscode.env.openExternal(vscode.Uri.parse(url)); }
        // Immediately poll so the new issue appears as a task without waiting for the interval
        void vscode.commands.executeCommand('agentTaskPlayer.ghSyncPollNow');
      } catch (err) {
        const msg = err instanceof Error ? err.message.substring(0, 300) : String(err);
        appendErrorLog({ ts: new Date().toISOString(), category: 'github', message: msg, context: 'gh issue create (bug report)' });
        vscode.window.showErrorMessage(`Failed to create issue: ${msg}`);
      }
      finally { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }

    } else {
      if (!frictionReport) { return; }
      const fc = frictionReport.friction.length;
      const title = `Session feedback: ${fc} friction point${fc !== 1 ? 's' : ''} on ${frictionReport.projectType} [${frictionReport.date.substring(0, 10)}]`;
      const body = buildFrictionIssueBody(frictionReport, description);
      const repo = targetRepo ?? MOAG_REPO;
      const tmpPath = path.join(os.tmpdir(), `moag-feedback-${Date.now()}.md`);
      try {
        fs.writeFileSync(tmpPath, body, 'utf-8');
        const url = ghSync(['issue', 'create', '--repo', repo, '--title', title, '--body-file', tmpPath, '--label', 'feedback'], { cwd, timeout: 20000 }).trim().split('\n').pop() || '';
        const action = await vscode.window.showInformationMessage(`Feedback filed: ${url}`, 'View Issue');
        if (action === 'View Issue' && url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
      } catch {
        try {
          fs.writeFileSync(tmpPath, body, 'utf-8');
          const url = ghSync(['issue', 'create', '--repo', repo, '--title', title, '--body-file', tmpPath], { cwd, timeout: 20000 }).trim().split('\n').pop() || '';
          const action = await vscode.window.showInformationMessage(`Feedback filed: ${url}`, 'View Issue');
          if (action === 'View Issue' && url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
        } catch (e2) { vscode.window.showErrorMessage(`Failed to file feedback: ${e2 instanceof Error ? e2.message.substring(0, 200) : String(e2)}`); }
      } finally { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
    }
  });
}

export async function cmdShareRunFeedback(): Promise<void> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const report = readLastFrictionReport();
  if (!report) {
    vscode.window.showInformationMessage('No recent friction data found. Run a plan first.');
    return;
  }

  // 3-tier repo resolution: setting → git remote → MOAG repo
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  let repo = cfg.get<string>('issueRepo', '').trim();
  if (!repo) {
    try {
      const remote = execSync('git remote get-url origin', { cwd, timeout: 5000 }).toString().trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) { repo = `${m[1]}/${m[2]}`; }
    } catch { /* no remote */ }
  }
  if (!repo) { repo = MOAG_REPO; }

  await openReportPanel('feedback', undefined, report, repo);
}

export async function cmdReportIssue(prefillText?: string): Promise<void> {
  await openReportPanel('bug', prefillText);
}
