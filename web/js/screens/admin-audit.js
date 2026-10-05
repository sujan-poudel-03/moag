// ─── /admin/audit — append-only audit log (UX §2.10) ───
//
// Newest first, 100 per page, "Load older" follows the server's cursor. The
// log has no edit or delete control because the server has no such route.
// Before/after values are shown as compact JSON text — never as markup.

import { h, mount, glyph, skeleton, errorCard, uid, fmtTime } from '../dom.js';
import { serverMessage } from '../strings.js';

const WARN_ACTIONS = new Set(['gate.skip', 'login.failure']);

/** One-line summary of an entry's change. */
function summary(e) {
  const parts = [];
  if (e.target) { parts.push(e.target); }
  const fmt = (v) => (v === undefined ? '' : JSON.stringify(v));
  if (e.before !== undefined || e.after !== undefined) {
    const b = fmt(e.before);
    const a = fmt(e.after);
    parts.push(b && a ? `${b} → ${a}` : a || b);
  }
  if (Array.isArray(e.flags) && e.flags.length) { parts.push(`[${e.flags.join(', ')}]`); }
  return parts.join(' · ');
}

export async function render(app, _params, view) {
  app.setTitle('Audit log');
  if (!app.can('audit.view')) { mount(view, h('div', { class: 'card' }, h('p', null, 'Only an admin can view the audit log.'))); return; }
  mount(view, h('h1', null, 'Audit log'), skeleton(5));

  const [first, usersResp, projectsResp] = await Promise.all([
    app.api('GET', '/api/admin/audit'),
    app.api('GET', '/api/admin/users'),
    app.api('GET', '/api/projects'),
  ]);
  if (!first.ok) { mount(view, h('h1', null, 'Audit log'), errorCard(`Couldn't load the audit log. ${serverMessage(first)}`, () => render(app, _params, view))); return; }
  const projectName = new Map(((projectsResp.ok && projectsResp.body.projects) || []).map((p) => [p.id, p.name]));

  const ids = { actor: uid('a'), action: uid('a'), project: uid('a'), from: uid('a'), to: uid('a') };
  const actor = h('select', { id: ids.actor }, h('option', { value: '' }, 'All'),
    ((usersResp.ok && usersResp.body.users) || []).map((u) => h('option', { value: u.username }, u.username)));
  const action = h('select', { id: ids.action }, h('option', { value: '' }, 'All'),
    (first.body.actions || []).map((a) => h('option', { value: a }, a)));
  const project = h('select', { id: ids.project }, h('option', { value: '' }, 'All'),
    [...projectName.entries()].map(([id, name]) => h('option', { value: id }, name)));
  const from = h('input', { id: ids.from, type: 'date' });
  const to = h('input', { id: ids.to, type: 'date' });

  const tbody = h('tbody');
  const caption = h('caption');
  const more = h('div', { class: 'pager' });
  const state = { entries: [], nextBefore: null };

  const query = (before) => {
    const q = new URLSearchParams();
    if (actor.value) { q.set('actor', actor.value); }
    if (action.value) { q.set('action', action.value); }
    if (project.value) { q.set('projectId', project.value); }
    if (from.value) { q.set('from', new Date(`${from.value}T00:00:00`).toISOString()); }
    if (to.value) { q.set('to', new Date(`${to.value}T23:59:59.999`).toISOString()); }
    if (before !== null && before !== undefined) { q.set('before', String(before)); }
    return `/api/admin/audit${q.toString() ? `?${q}` : ''}`;
  };

  const renderRows = () => {
    caption.textContent = `${state.entries.length} entr${state.entries.length === 1 ? 'y' : 'ies'} shown, newest first`;
    mount(tbody, ...state.entries.map((e) => h('tr', null,
      h('td', null, fmtTime(e.ts)),
      h('th', { scope: 'row' }, e.actorUsername || '—'),
      h('td', { class: WARN_ACTIONS.has(e.action) ? 'text-warning' : null },
        WARN_ACTIONS.has(e.action) ? [glyph('⚠'), h('span', { class: 'sr-only' }, 'Warning: ')] : null, ` ${e.action}`),
      h('td', null, e.projectId ? projectName.get(e.projectId) || e.projectId : '—'),
      h('td', { class: 'mono' }, summary(e)))));
    mount(more,
      h('span', { class: 'muted' }, '100 per page'),
      state.nextBefore !== null
        ? h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => { void load(true); } } }, 'Load older')
        : h('span', { class: 'muted' }, 'End of log'));
  };

  const load = async (older) => {
    const resp = await app.api('GET', query(older ? state.nextBefore : null));
    if (!resp.ok) { mount(more, errorCard(`Couldn't load entries. ${serverMessage(resp)}`, () => { void load(older); })); return; }
    state.entries = older ? [...state.entries, ...resp.body.entries] : resp.body.entries;
    state.nextBefore = resp.body.nextBefore;
    renderRows();
  };

  for (const el of [actor, action, project, from, to]) { el.addEventListener('change', () => { void load(false); }); }

  state.entries = first.body.entries || [];
  state.nextBefore = first.body.nextBefore;
  mount(view,
    h('h1', null, 'Audit log'),
    h('div', { class: 'filters' },
      h('div', { class: 'field' }, h('label', { for: ids.actor }, 'Actor'), actor),
      h('div', { class: 'field' }, h('label', { for: ids.action }, 'Action'), action),
      h('div', { class: 'field' }, h('label', { for: ids.project }, 'Project'), project),
      h('div', { class: 'field' }, h('label', { for: ids.from }, 'From'), from),
      h('div', { class: 'field' }, h('label', { for: ids.to }, 'To'), to)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, caption,
      h('thead', null, h('tr', null, ['Time', 'Actor', 'Action', 'Project', 'Details'].map((c) => h('th', { scope: 'col' }, c)))),
      tbody)),
    more);
  renderRows();
}
