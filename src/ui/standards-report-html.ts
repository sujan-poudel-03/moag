// ─── The standards section of the local verification report ───
//
// The report a local PRD verification opens in the browser shows every gate as one table
// row, which leaves room for the last line of its output and nothing else. Standards need
// more than that: what BLOCKED, what was only ADVISORY, which rules were NOT CHECKED and
// which changed FILES were not checked are four different answers, and a reader must be
// able to tell them apart at a glance.
//
// The words follow the kind of row. Only a profile command is "passed" or "failed". A rule
// MOAG decides itself is "no findings" or "findings" — never "passed": a scan that found
// nothing has not proved nothing is there.
//
// Pure: a report in, a string out. Every value that came from the repository — file names,
// messages, command lines, reasons — is escaped before it reaches the markup.

import {
  SCANNER_PROMOTION_WARNING, StandardsFinding, StandardsReport, StandardsRuleOutcome, groupStandardsRules, isBlockingNotChecked,
  NO_BLOCKING_RULES, promotedScannerRules, ruleOutcomeLabel, severityOf, standardsBlockingState,
} from '../standards/checker';
import { isStandardsGateCommand, standardsGateWord } from '../models/requirement-trace';
import { StandardsCheckCounts } from '../models/types';

/** Most findings spelled out per group; the heading always carries the true count. */
const MAX_FINDINGS_SHOWN = 100;
/** Most not-checked files spelled out; the heading always carries the true count. */
const MAX_FILES_SHOWN = 100;

// ─── Colours ───

/**
 * The colours this module writes inline. Each is a design-system token with a fallback:
 *
 *   - inside MOAG — a webview whose stylesheet includes `designSystemCssTokens()` — the
 *     `--ds-*` token is defined and the markup follows the user's VS Code theme;
 *   - in the standalone report (`.moag/verification-<ts>.html`, opened in the system
 *     browser) no `--ds-*` token exists, because there is no VS Code theme to map onto. The
 *     value after the comma is used, and it is the colour that report has always had.
 *
 * The fallbacks are the only raw colours in this file; nothing else may add one.
 */
export const REPORT_COLOR = {
  pass: 'var(--ds-success, #28a745)',
  fail: 'var(--ds-error, #dc3545)',
  muted: 'var(--ds-muted, #999)',
} as const;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ruleName(row: StandardsRuleOutcome): string {
  return row.rule === 'command' ? `command: ${row.command ?? ''}` : row.rule;
}

/** One table of decided rules. The result is a word as well as a mark, never a colour alone. */
function ruleTable(rows: StandardsRuleOutcome[]): string {
  if (rows.length === 0) { return '<p class="meta">No rule in this group was decided.</p>'; }
  const body = rows.map((row) => {
    const failed = row.result === 'failed';
    // Only a command that exited 0 earns the pass mark. A scan that found nothing is
    // "no findings" with a neutral mark: it has not proved nothing is there.
    const passed = !failed && row.rule === 'command';
    const cls = failed ? 'fail' : passed ? 'pass' : 'neutral';
    const icon = failed ? '✗' : passed ? '✓' : '–';
    const detail = row.rule === 'command' && row.exitCode !== undefined ? ` (exit ${row.exitCode})` : '';
    return `<tr>
      <td><code>${escapeHtml(ruleName(row))}</code></td>
      <td><span class="criterion ${cls}"><span class="icon">${icon}</span><span>${escapeHtml(ruleOutcomeLabel(row))}${detail}</span></span></td>
      <td>${row.reason ? escapeHtml(row.reason) : ''}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>Rule</th><th>Result</th><th>Note</th></tr></thead><tbody>${body}</tbody></table>`;
}

function findingList(findings: StandardsFinding[]): string {
  if (findings.length === 0) { return ''; }
  const items = findings.slice(0, MAX_FINDINGS_SHOWN)
    .map((f) => `<li><code>${escapeHtml(`${f.file}:${f.line}`)}</code> ${escapeHtml(f.rule)} — ${escapeHtml(f.message)}</li>`)
    .join('');
  const more = findings.length > MAX_FINDINGS_SHOWN ? `<li>…and ${findings.length - MAX_FINDINGS_SHOWN} more</li>` : '';
  return `<ul>${items}${more}</ul>`;
}

/** The changed files no line rule read, each with its reason; the heading carries the true count. */
function notCheckedFileList(report: StandardsReport): string {
  const total = report.totals.notCheckedFiles;
  if (total === 0) { return '<p class="meta">Every changed source file was read.</p>'; }
  const files = (report.notCheckedFiles ?? []).slice(0, MAX_FILES_SHOWN);
  const items = files.map((f) => `<li><code>${escapeHtml(f.file)}</code> — not checked (${escapeHtml(f.reason)})</li>`).join('');
  const more = total > files.length ? `<li>…and ${total - files.length} more</li>` : '';
  return `<ul>${items}${more}</ul>`;
}

// ─── Deterministic gates table ───

/** The fields of a gate result the table reads; narrow on purpose, so `ui/` does not import the runner. */
export interface GateRowInput {
  command: string;
  exitCode: number;
  passed: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
  standardsCounts?: StandardsCheckCounts;
}

/** What the status cell of one gate row says, and whether it is good, bad or neither. */
export interface GateStatus {
  word: string;
  tone: 'pass' | 'fail' | 'neutral';
}

/**
 * The words for one gate row. A command says pass / fail / timeout. The synthetic
 * `moag:standards` row is not a command and is never said to have passed or failed: it says
 * what `standardsGateWord` says on every surface — "stopped" when it stopped the release,
 * else "no blocking rules configured" (the profile has no command and no promoted rule) or
 * "nothing blocking", in a neutral tone.
 */
export function gateStatus(gate: Pick<GateRowInput, 'command' | 'passed' | 'timedOut' | 'standardsCounts'>): GateStatus {
  if (isStandardsGateCommand(gate.command)) {
    return { word: standardsGateWord(gate.passed, gate.standardsCounts), tone: gate.passed ? 'neutral' : 'fail' };
  }
  if (gate.passed) { return { word: 'pass', tone: 'pass' }; }
  return { word: gate.timedOut ? 'timeout' : 'fail', tone: 'fail' };
}

/** The body rows of the "Deterministic gates" table: one row per gate, everything escaped. */
export function verificationGateRows(gates: readonly GateRowInput[]): string {
  return gates.map((gate) => {
    const status = gateStatus(gate);
    // A neutral row takes the text colour: no green for a row that proved nothing.
    const style = status.tone === 'neutral' ? '' : ` style="color:${status.tone === 'pass' ? REPORT_COLOR.pass : REPORT_COLOR.fail}"`;
    const snippet = gate.output
      .split('\n').map((l) => l.trim()).reverse().find((l) => l.length > 0)?.substring(0, 160) ?? '—';
    // The standards row is not a process: it has no exit code to show.
    const exit = isStandardsGateCommand(gate.command) ? '—' : String(gate.exitCode);
    return `<tr>
      <td><code>${escapeHtml(gate.command)}</code></td>
      <td${style}>${escapeHtml(status.word)}</td>
      <td>${exit}</td>
      <td>${gate.durationMs}ms</td>
      <td style="font-size:0.8em;color:${REPORT_COLOR.muted}">${escapeHtml(snippet)}</td>
    </tr>`;
  }).join('');
}

// ─── Project standards section ───

/**
 * The "Project standards" section of the verification report, or '' when the run had no
 * standards. Four groups, in this order and never merged: Blocking, Advisory, Rules not
 * checked, Files not checked — with the rules the profile does not configure named apart
 * as "not configured", never counted among the rules not checked. A blocking rule that could not read a changed file is called
 * out above all of them, and so is a scanner rule the project promoted to blocking.
 */
export function standardsReportSection(report: StandardsReport | null): string {
  if (!report) { return ''; }
  const groups = groupStandardsRules(report);
  const t = report.totals;
  const blockingFindings = report.findings.filter((f) => severityOf(f) === 'blocking');
  const advisoryFindings = report.findings.filter((f) => severityOf(f) === 'advisory');
  const unread = groups.notChecked.filter(isBlockingNotChecked);
  const noBlocking = standardsBlockingState(report) === 'none-configured';
  const promoted = promotedScannerRules(report);
  const title = report.version === null ? 'Project standards' : `Project standards v${report.version}`;
  const stopping = (rows: StandardsRuleOutcome[]): number => rows.filter((r) => r.result === 'failed').length;

  const unreadNote = unread.length === 0 ? '' :
    `<p class="callout"><strong>${unread.length} blocking rule${unread.length === 1 ? '' : 's'} or command${unread.length === 1 ? ' was' : 's were'} not checked.</strong> ` +
    'That is not a pass: nothing failed there because nothing was evaluated.</p>';
  const noBlockingNote = !noBlocking ? '' :
    `<p class="callout"><strong>${escapeHtml(NO_BLOCKING_RULES[0].toUpperCase() + NO_BLOCKING_RULES.slice(1))}.</strong> ` +
    'MOAG blocks on your project\'s own tools: this profile has no command and no promoted rule, so nothing here can stop a release — and nothing here passed.</p>';
  const promotedNote = promoted.length === 0 ? '' :
    `<p class="callout"><strong>Promoted to blocking: ${escapeHtml(promoted.join(', '))}.</strong> ${escapeHtml(SCANNER_PROMOTION_WARNING)}</p>`;
  const notChecked = groups.notChecked.length === 0
    ? '<p class="meta">Every rule was checked.</p>'
    : `<ul>${groups.notChecked.map((row) =>
      `<li>${isBlockingNotChecked(row) ? '<strong>Blocking rule, not checked:</strong> ' : ''}<code>${escapeHtml(ruleName(row))}</code> — ${escapeHtml(row.reason ?? 'no reason given')}</li>`).join('')}</ul>`;
  // Rules the profile does not configure: listed apart, never as a gap in the check.
  const notConfigured = groups.notConfigured.length === 0 ? '' :
    `<h2>Not configured — this profile does not configure these rules (${groups.notConfigured.length})</h2>
  <p class="meta">${groups.notConfigured.map((row) => `<code>${escapeHtml(ruleName(row))}</code>`).join(', ')}</p>`;

  return `<div class="section">
  <h2>${escapeHtml(title)}</h2>
  <p class="meta">${t.passed} passed · ${t.noFindings} no findings · ${t.failed} blocking · ${t.advisory} advisory with findings (${t.advisoryFindings} finding${t.advisoryFindings === 1 ? '' : 's'}) · ${t.notChecked} rule${t.notChecked === 1 ? '' : 's'} not checked · ${t.notConfigured ?? 0} not configured · ${t.notCheckedFiles} file${t.notCheckedFiles === 1 ? '' : 's'} not checked · ${t.findings} finding${t.findings === 1 ? '' : 's'}</p>
  ${unreadNote}
  ${noBlockingNote}
  ${promotedNote}
  <h2>Blocking — a failure or a finding here stops a release (${stopping(groups.blocking)} stopping)</h2>
  ${ruleTable(groups.blocking)}
  ${findingList(blockingFindings)}
  <h2>Advisory — heuristic scans: reported, never blocking (${stopping(groups.advisory)} with findings)</h2>
  ${ruleTable(groups.advisory)}
  ${findingList(advisoryFindings)}
  <h2>Rules not checked — not a pass (${groups.notChecked.length})</h2>
  ${notChecked}
  ${notConfigured}
  <h2>Files not checked — nothing in them counts towards "no findings" (${t.notCheckedFiles})</h2>
  ${notCheckedFileList(report)}
</div>`;
}
