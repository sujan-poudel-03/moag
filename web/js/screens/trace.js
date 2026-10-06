// ─── /p/:id/trace — per-requirement status (UX §2.8) ───
//
// `rows` is exactly `requirementStatuses(plan)` — the same data `moag trace`
// prints. Requirement text is joined client-side from the latest PRD version
// (the rows carry IDs only). Paged at 100 rows; filter and search are kept
// across pages.

import { h, mount, glyph, skeleton, errorCard, uid } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

const PAGE = 100;

const STATUS = {
  shipped: { glyph: '✓', cls: 'text-success', label: 'Shipped' },
  'in-progress': { glyph: '⟳', cls: 'text-info', label: 'In progress' },
  'not-shipped': { glyph: '⊘', cls: 'text-warning', label: 'Not shipped' },
  untracked: { glyph: '○', cls: 'muted', label: 'Untracked' },
  removed: { glyph: '→', cls: 'muted', label: 'Removed' },
};

const TASK_GLYPH = { completed: '✓', failed: '✗', running: '⟳', blocked: '⊘', skipped: '→', paused: '⏸', pending: '○' };

function taskSummary(tasks) {
  if (!tasks.length) { return '0'; }
  const counts = {};
  for (const t of tasks) { counts[t.status] = (counts[t.status] || 0) + 1; }
  return Object.entries(counts).map(([s, n]) => `${n} ${TASK_GLYPH[s] || s}`).join(' ');
}

function taskSummaryLabel(tasks) {
  if (!tasks.length) { return 'no tasks'; }
  const counts = {};
  for (const t of tasks) { counts[t.status] = (counts[t.status] || 0) + 1; }
  return Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ');
}

/**
 * What the standards check behind a release left open, in words, or '' when it left nothing
 * open or recorded no counts: "2 advisory findings · 1 file not checked". A release whose
 * standards had no command and no promoted rule leads with "no blocking rules configured":
 * it was checked against that version, and nothing in the check could have stopped it.
 */
export function standardsOpen(counts) {
  if (!counts || typeof counts !== 'object') { return ''; }
  const part = (n, one, many) => (Number.isInteger(n) && n > 0 ? `${n} ${n === 1 ? one : many}` : null);
  return [
    counts.noBlockingRules === true ? 'no blocking rules configured' : null,
    part(counts.advisoryFindings, 'advisory finding', 'advisory findings'),
    part(counts.notCheckedRules, 'rule not checked', 'rules not checked'),
    part(counts.notCheckedFiles, 'file not checked', 'files not checked'),
  ].filter(Boolean).join(' · ');
}

/**
 * The Gates cell. Only real commands are tallied as "N/M pass". The synthetic
 * `moag:standards` row is not a command and is never counted as a pass: it is worded beside
 * the tally — "stopped" when it stopped the release, "no blocking rules configured" when the
 * profile had nothing that could, otherwise "nothing blocking".
 */
export function gateSummary(gates) {
  if (!Array.isArray(gates) || !gates.length) { return '—'; }
  const isStandards = (g) => typeof g.command === 'string' && /^moag:standards(?: v\d+)?$/.test(g.command);
  const commands = gates.filter((g) => !isStandards(g));
  const standards = gates.filter(isStandards).pop();
  const parts = [];
  if (commands.length) { parts.push(`${commands.filter((g) => g.exitCode === 0).length}/${commands.length} pass`); }
  if (standards) {
    const noBlocking = standards.standardsCounts && standards.standardsCounts.noBlockingRules === true;
    parts.push(`standards: ${standards.exitCode !== 0 ? 'stopped' : noBlocking ? 'no blocking rules configured' : 'nothing blocking'}`);
  }
  return parts.join(' · ');
}

export async function render(app, params, view) {
  const project = app.project.project;
  app.setTitle(`Trace · ${project.name}`);
  mount(view, h('h1', null, 'Trace'), skeleton(5));
  const r = await app.api('GET', `/api/projects/${encodeURIComponent(params.id)}/trace`);
  if (!r.ok) {
    mount(view, h('h1', null, 'Trace'), errorCard(`Couldn't load the trace. ${serverMessage(r)}`, () => render(app, params, view)));
    return;
  }
  const rows = Array.isArray(r.body.rows) ? r.body.rows : [];
  const textById = new Map((r.body.requirements || []).map((q) => [q.id, q.text]));

  if (rows.length === 0) {
    mount(view, h('h1', null, 'Trace'), h('div', { class: 'card empty' }, h('p', null, app.project.latestVersion ? STR.C3.text : STR.C2.text)));
    return;
  }

  const ui = { status: 'all', search: '', page: 0 };
  const filterId = uid('trace-filter');
  const searchId = uid('trace-search');
  const filter = h('select', { id: filterId },
    h('option', { value: 'all' }, 'All'),
    Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v.label)));
  const search = h('input', { id: searchId, type: 'search', placeholder: 'R-id or text', autocomplete: 'off' });
  const tableHost = h('div');
  const pager = h('div', { class: 'pager' });

  const matches = (row) => {
    if (ui.status !== 'all' && row.status !== ui.status) { return false; }
    if (!ui.search) { return true; }
    const q = ui.search.toLowerCase();
    return row.id.toLowerCase().includes(q) || String(textById.get(row.id) || '').toLowerCase().includes(q);
  };

  const renderTable = () => {
    const visible = rows.filter(matches);
    const pages = Math.max(1, Math.ceil(visible.length / PAGE));
    ui.page = Math.min(ui.page, pages - 1);
    const slice = visible.slice(ui.page * PAGE, ui.page * PAGE + PAGE);
    mount(tableHost, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('caption', null, `${visible.length} of ${rows.length} requirements`),
      h('thead', null, h('tr', null,
        ['ID', 'Requirement', 'Status', 'Version', 'Tag', 'Tasks', 'Gates'].map((c, i) => h('th', { scope: 'col', class: i === 4 || i === 6 ? 'col-optional' : null }, c)))),
      h('tbody', null, slice.map((row) => {
        const st = STATUS[row.status] || STATUS.untracked;
        return h('tr', null,
          h('th', { scope: 'row', class: row.status === 'removed' ? 'diff-id removed-id' : 'diff-id' }, row.id),
          h('td', null, textById.get(row.id) || h('span', { class: 'muted' }, '—'),
            row.blockedBy ? h('div', { class: 'muted' }, `blocked by ${row.blockedBy}`) : null),
          h('td', { class: st.cls }, glyph(st.glyph), ' ', st.label),
          // The standards version the release shipped under rides in the version cell (no extra column).
          h('td', null, row.version ? `v${String(row.version).replace(/^v/, '')}` : '—',
            row.standardsVersion ? ` · standards v${row.standardsVersion}` : null,
            // What that check left open rides beside it: a checked release is not always a clean one.
            row.standardsVersion && standardsOpen(row.standardsCounts)
              ? h('div', { class: 'muted' }, standardsOpen(row.standardsCounts)) : null),
          h('td', { class: 'col-optional' }, row.releaseTag || '—'),
          h('td', null, h('span', { 'aria-hidden': 'true' }, taskSummary(row.tasks)), h('span', { class: 'sr-only' }, taskSummaryLabel(row.tasks))),
          h('td', { class: 'col-optional' }, gateSummary(row.gates)));
      })))));
    mount(pager,
      h('span', { class: 'muted' }, `Page ${ui.page + 1} of ${pages}`),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', disabled: ui.page === 0, on: { click: () => { ui.page -= 1; renderTable(); } } }, 'Previous'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', disabled: ui.page >= pages - 1, on: { click: () => { ui.page += 1; renderTable(); } } }, 'Next'));
  };

  filter.addEventListener('change', () => { ui.status = filter.value; ui.page = 0; renderTable(); });
  search.addEventListener('input', () => { ui.search = search.value.trim(); ui.page = 0; renderTable(); });

  mount(view,
    h('div', { class: 'screen-header' }, h('h1', null, `Trace · ${rows.length} requirements`)),
    h('div', { class: 'filters' },
      h('div', { class: 'field' }, h('label', { for: filterId }, 'Filter'), filter),
      h('div', { class: 'field' }, h('label', { for: searchId }, 'Search'), search)),
    tableHost, pager);
  renderTable();
}
