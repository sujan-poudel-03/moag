// ─── /p/:id/run — live run, ship-gate card, halt banners (UX §2.7) ───
//
// The run view folds the same worker events the server folds (state,
// task-started/completed/failed, cost, manual-gate) as they arrive over SSE,
// updating rows in place so keyboard focus in the task tree is never lost.
// When the job ends the screen reloads the server's record, which is the
// source of truth for the exit code, the halt banner and allowed actions.

import { h, mount, clear, badge, glyph, toast, announce, confirmDialog, field, fmtTime, fmtUsd, fmtAgo } from '../dom.js';
import { STR, serverMessage } from '../strings.js';
import { cappedList } from './version-panel.js';

const TASK_STATUS = {
  pending: { glyph: '○', label: 'Pending', badge: null },
  running: { glyph: '⟳', label: 'Running', badge: ['RUNNING', 'info'] },
  paused: { glyph: '⏸', label: 'Paused', badge: ['PAUSED', 'warning'] },
  completed: { glyph: '✓', label: 'Completed', badge: null },
  failed: { glyph: '✗', label: 'Failed', badge: ['FAILED', 'error'] },
  skipped: { glyph: '→', label: 'Skipped', badge: ['SKIPPED', 'muted'] },
  blocked: { glyph: '⊘', label: 'Blocked', badge: ['BLOCKED', 'warning'] },
  awaiting: { glyph: '⏸', label: 'Awaiting approval', badge: ['AWAITING APPROVAL', 'warning'] },
};

const RUNNER_BADGE = {
  idle: ['IDLE', 'muted'],
  playing: ['● EXECUTING', 'info'],
  paused: ['⏸ PAUSED', 'warning'],
  stopping: ['STOPPING…', 'warning'],
};

const RUN_STATUS_BADGE = {
  'awaiting-approval': ['⏸ GATE', 'warning'],
  completed: ['✓ COMPLETE', 'success'],
  gaps: ['✗ GAPS', 'error'],
  error: ['✗ ERROR', 'error'],
  budget: ['⊘ COST CAP', 'warning'],
  stopped: ['STOPPED', 'muted'],
  'ship-rejected': ['SHIP REJECTED', 'muted'],
  interrupted: ['INTERRUPTED', 'warning'],
};

const TAIL_LINES = 6;

/**
 * A rule MOAG decides itself — every row that is not a profile command (the server's
 * `isScannerRule`). Never worded "Passed" or "Failed": only a command, judged by the exit
 * code of the project's own tool, is.
 */
const isScanner = (row) => row.rule !== 'command';

/** The stored results, in the order a table lists them. "Not checked" is never counted as a pass. */
const RESULT_ORDER = { failed: 0, 'not-checked': 1, passed: 2 };

/**
 * How one row's outcome is worded. A command passes or fails; every other rule has
 * findings or no findings — that a scan found nothing is not proof nothing is there.
 */
export function ruleOutcome(row) {
  if (row.result === 'not-checked') { return { glyph: '○', label: 'Not checked', cls: 'muted' }; }
  if (isScanner(row)) {
    return row.result === 'failed'
      ? { glyph: '✗', label: 'Findings', cls: isAdvisory(row) ? 'text-warning' : 'text-error' }
      : { glyph: '–', label: 'No findings', cls: 'muted' };
  }
  return row.result === 'failed' ? { glyph: '✗', label: 'Failed', cls: 'text-error' } : { glyph: '✓', label: 'Passed', cls: 'text-success' };
}

/** The well-known empty tree: the diff base of a repository that had no commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A rule row or finding is blocking unless it says it is advisory; a command always blocks. */
const isAdvisory = (row) => row.rule !== 'command' && row.severity === 'advisory';
/**
 * A blocking row the profile configures that ended not checked, whatever the reason: a
 * command that did not run, or a promoted rule that could not read what it had to or found
 * nothing to judge. Mirrors the server's `isBlockingNotChecked`.
 */
const isUnreadBlocking = (row) => row.result === 'not-checked' && !isAdvisory(row) && row.unconfigured !== true;
/** A profile with no command and no configured promoted rule: nothing in the report can stop a release. */
const hasNoBlockingRules = (rules) => !rules.some((r) => !isAdvisory(r) && r.unconfigured !== true);

/**
 * A standards report in the shape the card renders, or null when `data` is not
 * one. The server validates what it stores; a live event is checked here too.
 */
export function asStandardsReport(data) {
  if (!data || !Array.isArray(data.rules) || !Array.isArray(data.findings)) { return null; }
  const rules = data.rules.filter((r) => r && typeof r.rule === 'string' && RESULT_ORDER[r.result] !== undefined);
  const findings = data.findings.filter((f) => f && typeof f.file === 'string' && typeof f.rule === 'string');
  const notCheckedFiles = (Array.isArray(data.notCheckedFiles) ? data.notCheckedFiles : [])
    .filter((f) => f && typeof f.file === 'string' && typeof f.reason === 'string');
  const t = data.totals && typeof data.totals === 'object' ? data.totals : {};
  const atLeast = (key, listed) => (Number.isFinite(t[key]) ? Math.max(t[key], listed) : listed);
  // Every rule count comes from the rows themselves, so the card can never show a total that
  // disagrees with the table under it. "Passed" counts commands only; a rule MOAG decides
  // itself that found nothing is counted as "no findings".
  const failedRows = rules.filter((r) => r.result === 'failed');
  const cleanRows = rules.filter((r) => r.result === 'passed');
  return {
    version: Number.isFinite(data.version) ? data.version : null,
    baseRef: typeof data.baseRef === 'string' ? data.baseRef : null,
    rules,
    findings,
    notCheckedFiles,
    totals: {
      passed: cleanRows.filter((r) => !isScanner(r)).length,
      noFindings: cleanRows.filter(isScanner).length,
      failed: failedRows.filter((r) => !isAdvisory(r)).length,
      advisory: failedRows.filter(isAdvisory).length,
      notChecked: rules.filter((r) => r.result === 'not-checked').length,
      blockingNotChecked: rules.filter(isUnreadBlocking).length,
      noBlockingRules: hasNoBlockingRules(rules),
      findings: atLeast('findings', findings.length),
      advisoryFindings: atLeast('advisoryFindings', findings.filter(isAdvisory).length),
      notCheckedFiles: atLeast('notCheckedFiles', notCheckedFiles.length),
    },
  };
}

/** "Standards v3" for a run: the version its report names, else the one frozen at run start. */
function standardsName(run, stored) {
  const version = (stored && stored.report.version) || run.standardsVersion || null;
  return version ? `Standards v${version}` : 'Standards';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The one-line tally under the card heading, in the words each kind of rule is given. */
function totalsLine(t) {
  return [
    `${t.passed} passed`, `${t.noFindings} no findings`, `${t.failed} blocking`,
    `${t.advisory} advisory with findings`, `${plural(t.notChecked, 'rule')} not checked`,
    `${plural(t.notCheckedFiles, 'file')} not checked`,
  ].join(' · ');
}

/**
 * The badge and the frame of the standards card, from the report's totals: `{ text, kind,
 * card }`, where `kind` is the badge colour and `card` the card's class ('' for a plain one).
 *
 * "PASSED" is never the badge: most rows are scans, and a scan does not pass. The green
 * "✓ NOTHING BLOCKING" is earned only by a command that ran and exited 0 (`t.passed`). When
 * the blocking set is made only of scanner rules a project promoted, and they found nothing,
 * nothing was proved: the badge says "NOTHING BLOCKING · NO FINDINGS" in the neutral colour,
 * with no tick and no green frame. A profile with no command and no promoted rule says so
 * in so many words.
 */
export function standardsBadge(t) {
  const extras = [
    t.advisory > 0 ? `${t.advisoryFindings} ADVISORY` : null,
    // Upper case throughout: `plural` would append a lower-case "s" ("2 FILEs").
    t.notChecked > 0 ? `${t.notChecked} ${t.notChecked === 1 ? 'RULE' : 'RULES'} NOT CHECKED` : null,
    t.notCheckedFiles > 0 ? `${t.notCheckedFiles} ${t.notCheckedFiles === 1 ? 'FILE' : 'FILES'} NOT CHECKED` : null,
  ].filter(Boolean);
  // Stopped: something blocking failed, or something blocking was never evaluated.
  if (t.failed > 0) { return { text: `✗ ${t.failed} BLOCKING`, kind: 'error', card: 'card-error' }; }
  if (t.blockingNotChecked > 0) { return { text: `✗ ${t.blockingNotChecked} BLOCKING NOT CHECKED`, kind: 'error', card: 'card-error' }; }
  const open = extras.length > 0;
  if (t.passed === 0 && t.noFindings === 0 && t.advisory === 0 && !t.noBlockingRules) {
    return { text: '○ NOT CHECKED', kind: 'muted', card: open ? 'card-warning' : '' };
  }
  if (t.noBlockingRules) { return { text: ['NO BLOCKING RULES CONFIGURED', ...extras].join(' · '), kind: 'warning', card: 'card-warning' }; }
  if (open) { return { text: `NOTHING BLOCKING · ${extras.join(' · ')}`, kind: 'warning', card: 'card-warning' }; }
  // No command passed, so every blocking row is a promoted scan that found nothing.
  if (t.passed === 0) { return { text: 'NOTHING BLOCKING · NO FINDINGS', kind: 'muted', card: '' }; }
  return { text: '✓ NOTHING BLOCKING', kind: 'success', card: 'card-success' };
}

/**
 * What a legacy run's gate says about standards: a run that started before the
 * project had standards carries no version and gets no check before its gate.
 * Approving its ship applies the standards in effect then, and its verify pass is
 * checked against them. Returns null for any other run (one with a version, one
 * with a stored report, or one not awaiting approval); otherwise
 * `{ kind: 'apply', version }` when a version is in effect, or `{ kind: 'none' }`.
 */
export function legacyGateStandards(run, stored, effectiveVersion) {
  if (stored || run.standardsVersion || run.status !== 'awaiting-approval') { return null; }
  return effectiveVersion ? { kind: 'apply', version: effectiveVersion } : { kind: 'none' };
}

/** The copy for {@link legacyGateStandards}' result. */
const legacyGateText = (legacy) => (legacy.kind === 'apply' ? STR.C63(legacy.version).text : STR.C64.text);

/**
 * The standards report card. `stored` is `{ phase, report }` or null. A run
 * with no report says why: "no report" is never shown as a pass.
 */
function standardsCard(run, stored, effectiveVersion) {
  const name = standardsName(run, stored);
  const heading = h('h2', { tabindex: '-1', dataset: { focus: 'standards-report' } }, name);
  if (!stored) {
    const legacy = legacyGateStandards(run, stored, effectiveVersion);
    const text = legacy ? legacyGateText(legacy)
      : !run.standardsVersion ? STR.C39.text
      : run.status === 'running' ? 'Checked when the run verifies.'
        : run.status === 'awaiting-approval' ? 'Not checked yet for this run.'
          : 'Standards were not checked: the run ended first.';
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, heading), h('p', { class: 'muted' }, text));
  }
  const report = stored.report;
  const t = report.totals;
  // The badge and the frame: see standardsBadge — green only for a command that passed.
  const look = standardsBadge(t);
  const kind = look.card || null;
  const state = badge(look.text, look.kind);
  const truncated = t.findings > report.findings.length;
  const perRule = {};
  for (const f of report.findings) { perRule[f.rule] = (perRule[f.rule] || 0) + 1; }
  const byResult = (a, b) => RESULT_ORDER[a.result] - RESULT_ORDER[b.result];
  // Groups that are never mixed: what blocks, what only advises, and what was not checked.
  const decided = report.rules.filter((r) => r.result !== 'not-checked');
  const blockingRows = decided.filter((r) => !isAdvisory(r)).sort(byResult);
  const advisoryRows = decided.filter(isAdvisory).sort(byResult);
  // Blocking rules that could not read a changed file lead the not-checked group.
  const notCheckedRows = report.rules.filter((r) => r.result === 'not-checked')
    .sort((a, b) => Number(isUnreadBlocking(b)) - Number(isUnreadBlocking(a)));
  const blockingFindings = report.findings.filter((f) => !isAdvisory(f));
  const advisoryFindings = report.findings.filter(isAdvisory);
  // Scanner rules this project made blocking: said out loud wherever a report is shown.
  const promoted = report.rules.filter((r) => isScanner(r) && !isAdvisory(r) && r.unconfigured !== true).map((r) => r.rule);

  const ruleRow = (r) => {
    const info = ruleOutcome(r);
    const isCommand = r.rule === 'command';
    const n = perRule[r.rule] || 0;
    const unread = isUnreadBlocking(r);
    return h('tr', null,
      h('th', { scope: 'row', class: 'diff-id' }, isCommand ? `command: ${r.command || ''}` : r.rule),
      h('td', null,
        unread
          ? h('span', { class: 'text-warning' }, glyph('⚠'), ' Blocking rule, not checked')
          : h('span', { class: info.cls }, glyph(info.glyph), ' ', info.label),
        // On a decided rule the reason names the vendored or generated files it did not check.
        r.reason ? h('div', { class: 'muted' }, r.reason) : null,
        isCommand && r.tail ? h('details', null, h('summary', null, 'Output'), h('pre', { class: 'tail' }, r.tail)) : null),
      h('td', { class: 'col-optional' },
        isCommand ? (Number.isFinite(r.exitCode) ? `exit ${r.exitCode}` : '—')
          : r.result === 'not-checked' ? '—' : `${n}${truncated && n > 0 ? '+' : ''}`));
  };
  const ruleTable = (title, rows, summary) => (rows.length === 0 ? null : [
    h('h3', { class: 'section-header' }, title),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('caption', null, `${name}, ${summary}`),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Rule'), h('th', { scope: 'col' }, 'Result'), h('th', { scope: 'col', class: 'col-optional' }, 'Findings'))),
      h('tbody', null, rows.map(ruleRow))))]);
  const findingList = (title, findings, isOpen) => (findings.length === 0 ? null : h('details', { class: 'diff-group', open: isOpen },
    h('summary', null, `${title}  ${findings.length}${truncated ? '+' : ''}`),
    cappedList(findings, (f) => h('li', null,
      h('span', { class: 'diff-id' }, `${f.file}:${f.line}`), f.rule,
      f.message ? h('span', { class: 'muted' }, ` · ${f.message}`) : null))));
  const stopping = (rows) => rows.filter((r) => r.result === 'failed').length;
  const filesShown = report.notCheckedFiles.length;

  return h('section', { class: ['card', kind].filter(Boolean) },
    h('div', { class: 'card-head' }, heading, h('span', { class: 'header-spacer' }), state),
    h('p', null, totalsLine(t)),
    // The one line nobody may miss: a rule that can stop a release read nothing.
    t.blockingNotChecked > 0 ? h('p', { class: 'text-warning', role: 'alert' }, glyph('⚠'), ' ', STR.C48(t.blockingNotChecked).text) : null,
    t.noBlockingRules ? h('p', { class: 'text-warning', role: 'note' }, glyph('⚠'), ' ', STR.C58.text) : null,
    promoted.length > 0 ? h('p', { class: 'text-warning' }, glyph('⚠'), ' ', STR.C52(promoted.join(', ')).text) : null,
    t.notChecked > 0 ? h('p', { class: 'muted' }, STR.C40.text) : null,
    stored.phase === 'pre-gate' ? h('p', { class: 'muted' }, 'Checked before the ship gate. The run is checked again when it verifies.') : null,
    report.baseRef ? h('p', { class: 'muted' },
      report.baseRef === EMPTY_TREE ? 'Diff base: the empty tree, so every file counts as added.' : `Diff base: ${report.baseRef.slice(0, 12)}`) : null,
    ruleTable(`Blocking  ${stopping(blockingRows)} stopping`, blockingRows, 'blocking rules and commands: a failure or a finding here stops the release'),
    findingList('Blocking findings', blockingFindings, true),
    ruleTable(`Advisory  ${stopping(advisoryRows)} with findings`, advisoryRows, 'advisory rules: heuristic scans, reported, never blocking'),
    advisoryFindings.length > 0 ? h('p', { class: 'muted' }, STR.C49.text) : null,
    findingList('Advisory findings', advisoryFindings, false),
    ruleTable(`Rules not checked  ${notCheckedRows.length}`, notCheckedRows, 'rules that were not checked: not a pass'),
    t.notCheckedFiles > 0 ? h('details', { class: 'diff-group' },
      h('summary', null, `Files not checked  ${t.notCheckedFiles}`),
      h('p', { class: 'muted' }, STR.C53.text),
      cappedList(report.notCheckedFiles, (f) => h('li', null,
        h('span', { class: 'diff-id' }, f.file), h('span', { class: 'muted' }, ` · not checked (${f.reason})`))),
      t.notCheckedFiles > filesShown ? h('p', { class: 'muted' }, `Listing the first ${filesShown} of ${t.notCheckedFiles} files.`) : null) : null,
    truncated ? h('p', { class: 'muted' }, `Showing the first ${report.findings.length} of ${t.findings} findings.`) : null);
}

/** The read-only standards line inside the ship-gate card (the full table stays in the report card). */
function standardsGateLine(run, stored, focusReport, effectiveVersion) {
  const legacy = legacyGateStandards(run, stored, effectiveVersion);
  if (legacy) { return h('p', { class: 'muted' }, legacyGateText(legacy)); }
  if (!stored && !run.standardsVersion) {
    return h('p', { class: 'muted' }, 'Standards: none. This plan predates project standards.');
  }
  const name = standardsName(run, stored);
  if (!stored) { return h('p', null, `${name}: not checked yet for this run.`); }
  const t = stored.report.totals;
  const view = h('button', { type: 'button', class: 'btn-link', on: { click: focusReport } }, 'View report');
  if (t.failed > 0) {
    return h('p', null, `${name}: `, h('span', { class: 'text-error' }, glyph('✗'),
      ` ${plural(t.failed, 'blocking rule or command')} stop${t.failed === 1 ? 's' : ''} this release, ${plural(t.findings, 'finding')}.`), ' ', view);
  }
  if (t.blockingNotChecked > 0) {
    return h('p', null, `${name}: `, h('span', { class: 'text-error' }, glyph('✗'),
      ` ${plural(t.blockingNotChecked, 'blocking rule or command')} ${t.blockingNotChecked === 1 ? 'was' : 'were'} not checked, which stops this release.`), ' ', view);
  }
  // What the approver decides on: nothing blocks, and here is what was only advised or never read.
  const parts = [
    t.noBlockingRules ? h('span', { class: 'text-warning' }, glyph('⚠'), ' no blocking rules configured') : null,
    t.passed > 0 ? [glyph('✓'), ` ${t.passed} passed`] : null,
    t.noFindings > 0 ? `${plural(t.noFindings, 'scan')} with no findings` : null,
    t.advisory > 0 ? h('span', { class: 'text-warning' }, glyph('⚠'), ` ${plural(t.advisoryFindings, 'advisory finding')} (not blocking)`) : null,
    t.notChecked > 0 ? [glyph('○'), ` ${plural(t.notChecked, 'rule')} not checked`] : null,
    t.notCheckedFiles > 0 ? [glyph('○'), ` ${plural(t.notCheckedFiles, 'file')} not checked`] : null,
  ].filter(Boolean);
  return h('p', null, `${name}: `, parts.map((part, i) => [i > 0 ? ' · ' : null, part]), '. ', view);
}

/**
 * The status a task row shows. The worker halts at a ship gate by stopping the runner, which
 * reports the gate task as failed ("Manual gate cancelled"); while the run waits for an
 * approver, that task is awaiting approval, not failed.
 */
export function taskDisplayStatus(run, task, status) {
  const halted = run && run.status === 'awaiting-approval' && run.gate && run.gate.taskId === task.id;
  return halted && status !== 'completed' ? 'awaiting' : status;
}

const DEPENDENCY_EVENTS = ['dependencies-installed', 'dependencies-install-failed', 'dependencies-not-installed'];

/**
 * The automatic dependency installs a run reported, one line each, in the order they
 * happened. `kind` is success / error / info; `tail` is the install output of a failure.
 */
export function dependencyLines(events, tasks) {
  const names = {};
  for (const t of tasks || []) { names[t.id] = t.name; }
  const lines = [];
  for (const ev of events || []) {
    if (!ev || DEPENDENCY_EVENTS.indexOf(ev.event) < 0) { continue; }
    const secs = `${((Number(ev.durationMs) || 0) / 1000).toFixed(1)}s`;
    const before = ev.taskId && names[ev.taskId] ? names[ev.taskId] : `the ${ev.stage || 'next'} step`;
    if (ev.event === 'dependencies-installed') {
      lines.push({ kind: 'success', text: `Dependencies installed · ${ev.command} · ${secs} · before ${before}`, tail: '' });
    } else if (ev.event === 'dependencies-install-failed') {
      const how = ev.timedOut ? `timed out after ${secs}` : `exit ${ev.exitCode === null || ev.exitCode === undefined ? 1 : ev.exitCode}`;
      lines.push({ kind: 'error', text: `Dependencies could not be installed · ${ev.command} · ${how} · before ${before}`, tail: ev.tail || '' });
    } else {
      lines.push({ kind: 'info', text: `Dependencies not installed · ${ev.ecosystem} · ${ev.note || ''}`, tail: '' });
    }
  }
  return lines;
}

/**
 * The dependency events to show when the run view opens. The server's
 * `dependencyEvents` covers the whole run; `events` is only the most recent window, so
 * it is the fallback for an older server that does not send the list.
 */
export function initialDependencyEvents(detail, runId) {
  if (!detail || detail.runId !== runId) { return []; }
  if (Array.isArray(detail.dependencyEvents)) { return detail.dependencyEvents.slice(); }
  return (detail.events || []).filter((e) => e && DEPENDENCY_EVENTS.indexOf(e.event) >= 0);
}

/** Fold one worker event into the live view (mirrors the server's foldRunEvent). */
export function foldEvent(view, ev) {
  switch (ev.event) {
    case 'state': return { ...view, runnerState: ev.state };
    case 'task-started': return { ...view, tasks: { ...view.tasks, [ev.id]: 'running' } };
    // task-completed also reports a skipped task, task-failed a blocked one.
    case 'task-completed': return { ...view, tasks: { ...view.tasks, [ev.id]: ev.status === 'skipped' ? 'skipped' : 'completed' } };
    case 'task-failed': return { ...view, tasks: { ...view.tasks, [ev.id]: ev.status === 'blocked' ? 'blocked' : 'failed' } };
    case 'cost': return { ...view, costUsd: view.costUsd + (Number(ev.usd) || 0) };
    case 'manual-gate': return { ...view, gate: { taskId: ev.id, name: ev.name }, haltReason: 'manual-gate' };
    case 'budget-exceeded': return { ...view, haltReason: view.haltReason || 'budget-exceeded' };
    default: return view;
  }
}

function lastLines(text, n) {
  const lines = String(text || '').split('\n');
  return lines.slice(-n).join('\n');
}

function elapsed(fromIso, toIso) {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) { return ''; }
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function render(app, params, view) {
  const pdto = app.project;
  const project = pdto.project;
  const base = `/p/${encodeURIComponent(project.id)}`;
  app.setTitle(`Run · ${project.name}`);
  const refresh = async () => { await app.refreshProject(project.id); app.rerender(); };

  if (!pdto.latestVersion) {
    mount(view, h('h1', null, 'Run'), h('div', { class: 'card empty' },
      h('p', null, STR.C2.text), h('a', { href: `${base}/prd`, dataset: { link: '' }, class: 'btn btn-primary' }, 'Open PRD')));
    return undefined;
  }

  const runs = pdto.runs || [];
  const run = runs.length > 0 ? runs[runs.length - 1] : null;
  const detail = pdto.currentRun;
  const runnable = (pdto.plans || []).find((p) => (p.allowedActions || []).includes('run.start'));

  if (!run) {
    mount(view, h('h1', null, 'Run'),
      pdto.runsDisabledReason ? h('div', { class: ['card', 'card-error'], role: 'alert' }, glyph('✗'), ' ', STR.C18.text) : null,
      h('div', { class: 'card' },
        h('p', null, badge('IDLE', 'muted'), ' No runs yet.'),
        runnable
          ? h('a', { href: `${base}/plan`, dataset: { link: '' }, class: 'btn btn-primary' }, 'Start run from the approved plan')
          : h('p', { class: 'muted' }, 'A run starts from a reviewer-approved plan.')));
    return undefined;
  }

  // ─── Live model ───
  const live = {
    view: run.view ? { ...run.view, tasks: { ...run.view.tasks } } : { runnerState: 'idle', tasks: {}, costUsd: 0, haltReason: null },
    spentUsd: run.cost ? run.cost.spentUsd : 0,
    warned: false,
  };
  const tasks = detail && detail.runId === run.id ? detail.tasks : [];
  const errorTails = detail && detail.runId === run.id ? { ...detail.errorTails } : {};
  const statusOf = (t) => taskDisplayStatus(run, t, live.view.tasks[t.id] || t.status || 'pending');
  const runNumber = runs.length;

  // ─── Header ───
  const stateBadgeHost = h('span');
  const stopHost = h('span');
  const renderHeaderState = () => {
    if (run.status === 'running') {
      const [label, kind] = RUNNER_BADGE[live.view.runnerState] || RUNNER_BADGE.playing;
      const b = badge(label, kind);
      if (live.view.runnerState === 'playing') { b.classList.add('pulse'); }
      mount(stateBadgeHost, b);
    } else {
      const [label, kind] = RUN_STATUS_BADGE[run.status] || [run.status.toUpperCase(), 'muted'];
      mount(stateBadgeHost, badge(label, kind));
    }
    clear(stopHost);
    const canStop = (run.allowedActions || []).includes('run.stop');
    if (run.status === 'running' && live.view.runnerState === 'stopping') {
      stopHost.appendChild(h('span', { class: 'muted' }, 'Stopping…'));
    } else if (canStop && ['playing', 'paused'].includes(live.view.runnerState)) {
      stopHost.appendChild(h('button', {
        type: 'button', class: 'btn btn-danger',
        title: live.view.runnerState === 'paused' ? 'Paused runs can be stopped here; resuming is not available in the web app.' : null,
        on: { click: stop },
      }, 'Stop'));
    }
  };

  const stop = async () => {
    const ok = await confirmDialog({ title: `Stop run #${runNumber}?`, text: STR.C16b.text, confirmLabel: 'Stop run', cancelLabel: 'Keep running', destructive: true });
    if (!ok) { return; }
    const r = await app.api('POST', `/api/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(run.id)}/stop`, {});
    if (!r.ok && r.status !== 403) { toast(serverMessage(r), 'error'); }
    await refresh();
  };

  // ─── Progress zone ───
  const progressHost = h('div', { class: 'progress-zone' });
  const renderProgress = () => {
    const total = tasks.length;
    const done = tasks.filter((t) => statusOf(t) === 'completed').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const cost = run.cost || { noCap: true, capUsd: 0 };
    const parts = [
      h('span', null, `${done}/${total} tasks`),
      h('progress', { max: 100, value: pct, 'aria-label': 'Tasks completed' }),
      h('span', null, `${pct}%`),
    ];
    if (cost.noCap) {
      parts.push(h('span', null, `Cost ${fmtUsd(live.spentUsd)} · no cap set`));
    } else {
      const ratio = cost.capUsd > 0 ? live.spentUsd / cost.capUsd : 0;
      const bar = h('progress', { max: 100, value: Math.min(100, Math.round(ratio * 100)), 'aria-label': 'Cost cap used' });
      if (ratio >= 1) { bar.classList.add('cost-error'); } else if (ratio >= 0.8) { bar.classList.add('cost-warning'); }
      parts.push(h('span', null, `Cost ${fmtUsd(live.spentUsd)} of ${fmtUsd(cost.capUsd)} version cap`), bar, h('span', null, `${Math.round(ratio * 100)}%`));
      if (ratio >= 0.8 && !live.warned && run.status === 'running') { live.warned = true; announce('80% of the cost cap used.'); }
    }
    mount(progressHost, ...parts);
  };

  // ─── Task tree ───
  const rowEls = new Map();
  const tree = h('ul', { class: 'task-list', role: 'tree', 'aria-label': 'Run tasks' });
  const renderRow = (t) => {
    const s = statusOf(t);
    const info = TASK_STATUS[s] || TASK_STATUS.pending;
    const li = rowEls.get(t.id) || h('li', { role: 'treeitem', tabindex: '-1' });
    rowEls.set(t.id, li);
    li.className = `task-row task-${s}`;
    li.setAttribute('aria-label', `${t.name}: ${info.label}`);
    const tail = s === 'failed' && errorTails[t.id] ? lastLines(errorTails[t.id], TAIL_LINES) : null;
    if (tail) { li.setAttribute('aria-expanded', 'true'); } else { li.removeAttribute('aria-expanded'); }
    mount(li,
      glyph(info.glyph),
      h('span', { class: 'task-name', title: t.name }, t.name),
      h('span', null, info.badge ? badge(info.badge[0], info.badge[1]) : null, t.type === 'manual' ? [' ', badge('SHIP GATE', 'warning')] : null),
      h('span', { class: 'muted col-optional' }, t.type === 'agent' ? t.engine || '' : t.type),
      tail ? h('pre', { class: 'tail task-detail' }, tail) : null);
    return li;
  };
  const playlistExpanded = { value: true };
  const playlistHead = h('button', { type: 'button', class: 'playlist-head', 'aria-expanded': 'true' });
  const renderTree = () => {
    const done = tasks.filter((t) => statusOf(t) === 'completed').length;
    mount(playlistHead, glyph(playlistExpanded.value ? '▼' : '▸'), h('strong', null, (detail && detail.playlistName) || 'Plan'), h('span', { class: 'header-spacer' }), h('span', { class: 'muted' }, `${done}/${tasks.length}`));
    playlistHead.setAttribute('aria-expanded', String(playlistExpanded.value));
    clear(tree);
    tree.hidden = !playlistExpanded.value;
    tasks.forEach((t) => tree.appendChild(renderRow(t)));
    const items = [...tree.children];
    if (items.length > 0 && !items.some((x) => x.tabIndex === 0)) { items[0].tabIndex = 0; }
  };
  playlistHead.addEventListener('click', () => { playlistExpanded.value = !playlistExpanded.value; renderTree(); });
  tree.addEventListener('keydown', (e) => {
    const items = [...tree.children];
    const i = items.indexOf(document.activeElement);
    if (i < 0) { return; }
    let next = -1;
    if (e.key === 'ArrowDown') { next = Math.min(items.length - 1, i + 1); }
    else if (e.key === 'ArrowUp') { next = Math.max(0, i - 1); }
    else if (e.key === 'Home') { next = 0; }
    else if (e.key === 'End') { next = items.length - 1; }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); playlistExpanded.value = false; renderTree(); playlistHead.focus(); return; }
    else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      const detailEl = items[i].querySelector('.task-detail');
      if (detailEl) { e.preventDefault(); detailEl.hidden = e.key === 'ArrowRight' ? false : !detailEl.hidden; items[i].setAttribute('aria-expanded', String(!detailEl.hidden)); }
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      items.forEach((x) => { x.tabIndex = -1; });
      items[next].tabIndex = 0;
      items[next].focus();
    }
  });

  // ─── Events log ───
  const events = detail && detail.runId === run.id ? [...detail.events] : [];
  const eventsSummary = h('summary', null, `Events  ${events.length}`);
  const eventsPre = h('pre', { class: 'events-log', 'aria-live': 'polite' });
  const renderEvents = () => {
    eventsSummary.textContent = `Events  ${events.length}`;
    eventsPre.textContent = events.slice(-200).map((e) => JSON.stringify(e)).join('\n');
  };

  // ─── Standards report ───
  const storedRaw = detail && detail.runId === run.id ? detail.standardsReport : null;
  const storedReport = storedRaw ? asStandardsReport(storedRaw.report) : null;
  const standardsHost = h('div');
  const standards = {
    stored: storedReport ? { phase: storedRaw.phase === 'pre-gate' ? 'pre-gate' : 'verify', report: storedReport } : null,
    focusReport: () => {
      const target = standardsHost.querySelector('[data-focus="standards-report"]');
      if (target) { target.focus(); }
    },
    /** The project's approved standards version now: what approving a legacy run's ship applies. */
    effectiveVersion: project.standards ? project.standards.effectiveVersion : null,
  };
  const renderStandards = () => mount(standardsHost, standardsCard(run, standards.stored, standards.effectiveVersion));

  // ─── Banners and the gate card ───
  const bannerHost = h('div');
  const renderBanner = () => mount(bannerHost, haltBanner(app, project, run, tasks, statusOf, live, runnable, base, refresh, standards));

  // ─── Dependency installs ───
  // From the server's own list, collected over the WHOLE events.jsonl: an early install
  // (or its failure) must survive a reload on a long run, where it has left `events`
  // (the last 200 only). Live events append to it.
  const depEvents = initialDependencyEvents(detail, run.id);
  const depsHost = h('div');
  const renderDeps = () => {
    const lines = dependencyLines(depEvents, tasks);
    if (lines.length === 0) { clear(depsHost); return; }
    const failed = lines.some((l) => l.kind === 'error');
    const glyphs = { success: '✓', error: '✗', info: 'ⓘ' };
    mount(depsHost, h('section', { class: ['card', failed ? 'card-error' : null].filter(Boolean), role: 'status' },
      h('h2', { class: 'section-header' }, 'Dependencies'),
      h('ul', { class: 'diff-list' }, lines.map((l) => h('li', { class: l.kind === 'error' ? 'text-error' : null },
        glyph(glyphs[l.kind]), ' ', l.text,
        l.tail ? h('pre', { class: 'tail' }, lastLines(l.tail, TAIL_LINES)) : null)))));
  };

  const startedText = `started by ${run.startedByName || '—'} · ${fmtTime(run.startedAt)} · ${elapsed(run.startedAt, run.endedAt)}`;
  mount(view,
    h('div', { class: 'run-header' },
      h('h1', null, `Run #${runNumber} · PRD ${pdto.latestVersion.label} · ${project.defaultEngine}`),
      stateBadgeHost, h('span', { class: 'muted' }, startedText), h('span', { class: 'header-spacer' }), stopHost),
    progressHost,
    pdto.runsDisabledReason ? h('div', { class: ['card', 'card-error'], role: 'alert' }, glyph('✗'), ' ', STR.C18.text) : null,
    bannerHost,
    depsHost,
    standardsHost,
    h('div', { class: 'card' }, playlistHead, tree,
      h('details', { class: 'diff-group' }, eventsSummary, eventsPre)));
  renderHeaderState();
  renderProgress();
  renderTree();
  renderEvents();
  renderDeps();
  renderStandards();
  renderBanner();
  const gateHeading = bannerHost.querySelector('[data-focus="gate"]');
  if (gateHeading) { gateHeading.focus(); }

  if (run.status !== 'running') { return undefined; }

  // ─── Live updates ───
  const onEvent = (n) => {
    const ev = n.event;
    if (!ev || typeof ev.event !== 'string') { return; }
    events.push(ev);
    renderEvents();
    if (ev.event === 'task-error-tail') { errorTails[ev.id] = ev.tail; }
    if (ev.event === 'cost') { live.spentUsd += Number(ev.usd) || 0; }
    live.view = foldEvent(live.view, ev);
    if (ev.event === 'task-completed' && ev.status === 'skipped') { announce(`${ev.name} skipped.`, { key: 'skipped', plural: (k) => `${k} tasks skipped.` }); }
    else if (ev.event === 'task-completed') { announce(`${ev.name} completed.`, { assertive: true, key: 'done', plural: (k) => `${k} tasks completed.` }); }
    if (ev.event === 'task-failed' && ev.status === 'blocked') { announce(`${ev.name} blocked.`, { assertive: true, key: 'blocked', plural: (k) => `${k} tasks blocked.` }); }
    else if (ev.event === 'task-failed') { announce(`${ev.name} failed.`, { assertive: true, key: 'failed', plural: (k) => `${k} tasks failed.` }); }
    if (ev.event === 'manual-gate') { announce(`Halted at the ship gate: ${ev.name}.`, { assertive: true }); }
    if (DEPENDENCY_EVENTS.indexOf(ev.event) >= 0) {
      depEvents.push(ev);
      renderDeps();
      if (ev.event === 'dependencies-install-failed') { announce(`Dependencies could not be installed (${ev.command}).`, { assertive: true }); }
    }
    if (ev.event === 'verify' && ev.name === 'verify-standards') {
      const report = asStandardsReport(ev.data);
      if (report) {
        standards.stored = { phase: ev.data.phase === 'pre-gate' ? 'pre-gate' : 'verify', report };
        renderStandards();
        // Never "passed": most of the check is a scan, and a scan does not pass.
        const tt = report.totals;
        if (tt.failed > 0) { announce('Standards stopped the release.', { assertive: true }); }
        else if (tt.passed > 0 || tt.noFindings > 0 || tt.advisory > 0) { announce(`Standards: nothing blocking. ${tt.advisoryFindings} advisory finding${tt.advisoryFindings === 1 ? '' : 's'}.`); }
        else { announce('Standards could not be checked.'); }
      }
    }
    const t = tasks.find((x) => x.id === ev.id);
    if (t) { renderRow(t); }
    renderHeaderState();
    renderProgress();
    if (ev.event === 'state') { void refreshRunActions(); }
  };
  // Stop is offered from the server's allowedActions, which depend on the runner state.
  const refreshRunActions = async () => {
    const r = await app.api('GET', `/api/projects/${encodeURIComponent(project.id)}`);
    const fresh = r.ok && Array.isArray(r.body.runs) ? r.body.runs.find((x) => x.id === run.id) : null;
    if (fresh) { run.allowedActions = fresh.allowedActions; renderHeaderState(); }
  };
  return app.connectEvents(project.id, {
    snapshot: (d) => {
      if (d && d.view && d.activeJob === 'run') {
        // A resumed segment's snapshot covers only its own tasks: layer it over what we know.
        live.view = { ...d.view, tasks: { ...live.view.tasks, ...d.view.tasks } };
        renderTree();
        renderHeaderState();
      } else if (d && d.activeJob === null) {
        // The run ended while we were away: reload the record.
        void refresh();
      }
    },
    event: onEvent,
    end: () => { announce('The run ended.', { assertive: true }); void refresh(); },
  });
}

function haltBanner(app, project, run, tasks, statusOf, live, runnable, base, refresh, standards) {
  const failed = tasks.filter((t) => ['failed', 'blocked'].includes(statusOf(t)));
  const notRun = tasks.filter((t) => ['pending', 'blocked', 'skipped'].includes(statusOf(t))).length;
  const canEditCap = (project.allowedActions || []).includes('project.update');
  const lastDecision = (run.gateDecisions || []).slice(-1)[0];
  switch (run.status) {
    case 'awaiting-approval':
      return gateCard(app, project, run, tasks, statusOf, live, refresh, standards);
    case 'budget':
      return h('div', { class: ['card', 'card-warning'], role: 'status' },
        h('h2', null, glyph('⊘'), ' Run stopped: cost cap reached'),
        h('p', null, `${fmtUsd(live.spentUsd)} of ${fmtUsd(run.cost ? run.cost.capUsd : 0)} spent on this PRD version. ${notRun} task${notRun === 1 ? '' : 's'} did not run.`),
        h('div', { class: 'inline-row' },
          canEditCap ? h('a', { href: `${base}/settings`, dataset: { link: '' }, class: 'btn btn-secondary' }, 'Edit cost cap') : null,
          runnable ? h('a', { href: `${base}/plan`, dataset: { link: '' }, class: 'btn btn-primary' }, 'Start run') : null));
    case 'gaps': {
      // Every task can be complete under a GAPS badge when the standards check is what failed: say so.
      const st = standards.stored ? standards.stored.report.totals : null;
      return h('div', { class: ['card', 'card-error'], role: 'status' },
        h('h2', null, glyph('✗'), ' Run finished with gaps'),
        st && st.failed > 0 ? h('p', null, STR.C41(st.failed, st.findings).text, ' ',
          h('button', { type: 'button', class: 'btn-link', on: { click: standards.focusReport } }, 'View report')) : null,
        // Set by the server when a run exited cleanly without proving its standards check.
        run.errorTail ? h('p', null, run.errorTail) : null,
        failed.length > 0 ? h('ul', { class: 'diff-list' }, failed.map((t) => h('li', null, `${t.name} — ${(TASK_STATUS[statusOf(t)] || TASK_STATUS.pending).label}`))) : null);
    }
    case 'error':
      return h('div', { class: ['card', 'card-error'], role: 'status' },
        h('h2', null, glyph('✗'), ' Run could not continue'),
        run.errorTail ? h('pre', { class: 'tail' }, run.errorTail) : null);
    case 'completed':
      return h('div', { class: ['card', 'card-success'], role: 'status' },
        h('h2', null, glyph('✓'), ' Run complete'),
        h('p', null, 'See ', h('a', { href: `${base}/trace`, dataset: { link: '' } }, 'Trace'), ' for what shipped.'));
    case 'stopped':
      return h('div', { class: 'card', role: 'status' }, h('p', null, `Run stopped${run.stoppedByName ? ` by ${run.stoppedByName}` : ''}. Completed tasks stay completed.`));
    case 'ship-rejected':
      return h('div', { class: 'card', role: 'status' },
        h('p', null, STR.C16d.text),
        lastDecision ? h('p', { class: 'muted' }, `Rejected by ${lastDecision.byName || '—'} · ${fmtTime(lastDecision.at)}${lastDecision.note ? ` · "${lastDecision.note}"` : ''}`) : null);
    case 'interrupted':
      return h('div', { class: ['card', 'card-warning'], role: 'status' }, h('p', null, 'This run was interrupted by a server restart. Start it again from the plan.'));
    default:
      return null;
  }
}

function gateCard(app, project, run, tasks, statusOf, live, refresh, standards) {
  const allowed = new Set(run.allowedActions || []);
  const gate = run.gate || { name: 'Ship gate', taskId: '' };
  const gateIndex = tasks.findIndex((t) => t.id === gate.taskId);
  const before = gateIndex >= 0 ? tasks.slice(0, gateIndex) : [];
  const beforeDone = before.filter((t) => statusOf(t) === 'completed').length;
  const after = (app.project.currentRun && app.project.currentRun.afterGate) || [];
  const heading = h('h2', { tabindex: '-1', dataset: { focus: 'gate' } }, glyph('⏸'), ' Awaiting ship approval');
  const note = field({ label: 'Note', hint: 'Required to reject.', input: h('input', { type: 'text', maxlength: 2000 }) });
  const me = (app.session.user.displayName || app.session.user.username);
  const url = (action) => `/api/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(run.id)}/gate/${action}`;

  const conflict = async (r) => {
    if (r.status === 409 && r.body.error === 'standards-blocking') {
      toast(STR.C59(Number(r.body.failed) || 0, Number(r.body.blockingNotChecked) || 0).text, 'error');
    } else if (r.status === 409 && r.body.lastDecision) {
      const d = r.body.lastDecision;
      const verb = d.action === 'approve' ? 'approved' : d.action === 'reject' ? 'rejected' : 'skipped';
      toast(STR.C22(verb, '', fmtTime(d.at)).text, 'warning');
    } else if (r.status !== 403) {
      toast(serverMessage(r), 'error');
    }
    await refresh();
  };

  const approve = async () => {
    const ok = await confirmDialog({ title: 'Approve and ship?', text: STR.C16c(gate.name, me).text, confirmLabel: 'Approve and ship' });
    if (!ok) { return; }
    const text = note.input.value.trim();
    const r = await app.api('POST', url('approve'), text ? { note: text } : {});
    if (!r.ok) { await conflict(r); return; }
    toast('Approved. The run is resuming.', 'success');
    await refresh();
  };
  const reject = async () => {
    note.setError('');
    const text = note.input.value.trim();
    if (!text) { note.setError('A note is required to reject.'); note.input.focus(); return; }
    const ok = await confirmDialog({ title: 'Reject the ship?', text: STR.C16d.text, confirmLabel: 'Reject', destructive: true });
    if (!ok) { return; }
    const r = await app.api('POST', url('reject'), { note: text });
    if (!r.ok) { await conflict(r); return; }
    toast(STR.C16d.text, 'success');
    await refresh();
  };
  const skip = async () => {
    const res = await confirmDialog({
      title: 'Skip the ship gate?', text: STR.C16e.text, confirmLabel: 'Skip gate', destructive: true,
      field: { label: 'Reason', required: true, multiline: true },
    });
    if (!res) { return; }
    const r = await app.api('POST', url('skip'), { reason: res.value });
    if (!r.ok) { await conflict(r); return; }
    toast('Gate skipped. The run is resuming.', 'warning');
    await refresh();
  };

  const canDecide = allowed.has('gate.approve') || allowed.has('gate.reject');
  // The server refuses to approve a ship over a pre-gate standards check that stops it; the
  // button says so up front instead of letting the approver find out from an error.
  const preGate = standards.stored && standards.stored.phase === 'pre-gate' ? standards.stored.report.totals : null;
  const standardsStop = !!preGate && (preGate.failed > 0 || preGate.blockingNotChecked > 0);
  const approversLine = h('p', { class: 'muted' }, 'Waiting for an approver.');
  if (!canDecide) {
    void app.api('GET', '/api/users/approvers').then((r) => {
      if (r.ok && Array.isArray(r.body.approvers)) {
        approversLine.textContent = `Waiting for an approver. Approvers: ${r.body.approvers.map((a) => a.username).join(', ') || 'none — ask an admin to assign one'}.`;
      }
    });
  }
  const cost = run.cost || { noCap: true };
  return h('section', { class: ['card', 'card-warning'] },
    h('div', { class: 'card-head' }, heading, h('span', { class: 'header-spacer' }), badge('GATE', 'warning')),
    h('p', null, `"${gate.name}" is waiting for an approver. Halted ${run.endedAt ? fmtAgo(run.endedAt) : 'just now'}.`),
    h('p', null, `${beforeDone}/${before.length} tasks before the gate completed.`),
    h('p', null, cost.noCap ? `Cost so far ${fmtUsd(live.spentUsd)} · no cap set` : `Cost so far ${fmtUsd(live.spentUsd)} of ${fmtUsd(cost.capUsd)}`),
    standardsGateLine(run, standards.stored, standards.focusReport, standards.effectiveVersion),
    after.length > 0 ? h('p', null, `Tasks that run after approval: ${after.join(', ')}`) : null,
    canDecide ? [note.wrap,
      h('div', { class: 'form-actions gate-actions' },
        allowed.has('gate.reject') ? h('button', { type: 'button', class: 'btn btn-danger', on: { click: reject } }, 'Reject') : null,
        allowed.has('gate.approve') ? h('button', { type: 'button', class: 'btn btn-primary', disabled: standardsStop, on: { click: approve } }, 'Approve and ship') : null),
      standardsStop ? h('p', { class: 'text-error', role: 'alert' }, glyph('✗'), ' ', STR.C59(preGate.failed, preGate.blockingNotChecked).text) : null]
      : approversLine,
    allowed.has('gate.skip') ? [h('hr', { class: 'panel-divider' }),
      h('button', { type: 'button', class: 'btn-link', on: { click: skip } }, 'Skip gate without approval…')] : null);
}
