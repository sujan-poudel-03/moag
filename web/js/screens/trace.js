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

function gateSummary(gates) {
  if (!gates.length) { return '—'; }
  const pass = gates.filter((g) => g.exitCode === 0).length;
  return `${pass}/${gates.length} pass`;
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
          h('td', null, row.version ? `v${String(row.version).replace(/^v/, '')}` : '—'),
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
