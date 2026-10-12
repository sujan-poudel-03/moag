// ─── /projects — the project list ───

import { h, mount, skeleton, errorCard } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

/** List every project (all signed-in users see all projects). "New project" renders only when allowed. */
export async function render(app, _params, view) {
  app.setTitle('Projects');
  mount(view, h('h1', null, 'Projects'), skeleton(3));
  const r = await app.api('GET', '/api/projects');
  if (!r.ok) {
    mount(view, h('h1', null, 'Projects'), errorCard(`Couldn't load projects. ${serverMessage(r)}`, () => render(app, _params, view)));
    return;
  }
  const canCreate = Array.isArray(r.body.allowedActions) && r.body.allowedActions.includes('project.create');
  const projects = Array.isArray(r.body.projects) ? r.body.projects : [];
  const newBtn = canCreate ? h('a', { href: '/projects/new', dataset: { link: '' }, class: 'btn btn-primary' }, '+ New project') : null;

  if (projects.length === 0) {
    mount(view,
      h('div', { class: 'screen-header' }, h('h1', null, 'Projects')),
      h('div', { class: 'card empty' },
        h('p', null, canCreate ? STR.C1.text : STR.C1b.text),
        newBtn));
    return;
  }

  mount(view,
    h('div', { class: 'screen-header' }, h('h1', null, 'Projects'), h('span', { class: 'header-spacer' }), newBtn),
    h('ul', { class: 'project-list' },
      projects.map((p) => h('li', null,
        h('a', { href: `/p/${encodeURIComponent(p.id)}/prd`, dataset: { link: '' }, class: 'project-row' },
          h('span', { class: 'project-name' }, p.name),
          h('span', { class: 'muted' }, `${p.stack} · ${p.defaultEngine}`),
          h('span', { class: 'muted' }, p.versionBudgetUsd === 0 ? 'no cap set' : `$${Number(p.versionBudgetUsd).toFixed(2)} cap per version`))))));
}
