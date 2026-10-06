// ─── New project (/projects/new) and project settings (/p/:id/settings) ───
//
// One form in two modes. Source is chosen at creation and read-only afterwards.
// Engine, stack and role lists come from the server (`session.meta`), never a
// hard-coded copy, so the form can only offer values the server will accept.
//
// The stack recommendation card (UX §2.3) shows only what the server measured.
// In its static-default state it shows no percentage and no sample figure at all.
// Measured data is headlined "Recommended" only in the server's 'recommended'
// state; single-stack, poor-completion and detected-differs show it as evidence.

import { h, mount, field, toast, confirmDialog, fmtUsd, badge } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

const STACK_CHANGE_TEXT = 'Changing the stack affects future runs and recommendations only. Past outcomes keep the stack they were recorded with.';

function meta(app) {
  const m = (app.session && app.session.meta) || {};
  return {
    engines: Array.isArray(m.engines) ? m.engines : [],
    unsupportedEngines: Array.isArray(m.unsupportedEngines) ? m.unsupportedEngines : [],
    stacks: Array.isArray(m.stacks) ? m.stacks : [],
  };
}

function engineSelect(app, selected) {
  const { engines, unsupportedEngines } = meta(app);
  return h('select', { required: true },
    engines.map((e) => h('option', { value: e, selected: e === selected }, e)),
    unsupportedEngines.map((e) => h('option', { value: e, disabled: true }, `${e} (not supported in web)`)));
}

function stackSelect(app, selected) {
  return h('select', { required: true }, meta(app).stacks.map((s) => h('option', { value: s, selected: s === selected }, s)));
}

function capInput(value) {
  return h('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', value: String(value), required: true });
}

const CONFIDENCE_BADGE = { low: ['LOW CONFIDENCE', 'warning'], medium: ['MEDIUM CONFIDENCE', 'info'], high: ['HIGH CONFIDENCE', 'success'] };

/** Measured states that are NOT a recommendation (server `MeasuredState`). */
const MEASURED_STATE_BADGE = {
  'single-stack': ['NO COMPARISON', 'muted'],
  'poor-completion': ['LOW COMPLETION', 'warning'],
  'detected-differs': ['DETECTED', 'info'],
};

const STACK_SOURCE_TEXT = { measured: 'measured on this server', detected: 'detected from repository files', static: 'static default, not measured' };

const pct = (x) => `${Math.round(Number(x) * 100)}%`;

/**
 * The recommendation card. `rec` is the server's StackRecommendation; `onUse`
 * puts its stack into the form's stack select.
 */
function recommendationCard(rec, onUse) {
  const use = h('button', { type: 'button', class: 'btn btn-secondary btn-small', on: { click: () => onUse(rec.stack) } }, `Use ${rec.stack}`);
  if (rec.source !== 'measured') {
    const n = Number(rec.recordedTasks) || 0;
    return h('section', { class: 'card', 'aria-label': `${rec.label}. No data.` },
      h('div', { class: 'card-head' }, h('h3', null, rec.label), h('span', { class: 'header-spacer' }), badge('NO DATA', 'muted')),
      h('p', null, h('strong', null, rec.stack), ` (${rec.defaultLabel})`),
      h('p', { class: 'muted' },
        `${n} finished agent task${n === 1 ? ' has' : 's have'} a recorded stack on the connected engines. A measured recommendation needs at least ${rec.minPerGroup} per engine and stack. Tasks run before stacks were recorded are not counted.`),
      h('div', { class: 'form-actions' }, use));
  }
  const groups = h('ul', null, (rec.groups || []).map((g) => h('li', null,
    `${g.engine} × ${g.stack} · ${g.n} tasks · ${pct(g.rate)} completed (at least ${pct(g.wilsonLower)} at 95% confidence)`,
    typeof g.gatePassRate === 'number' ? ` · gate pass ${pct(g.gatePassRate)} of ${g.gateRuns} gate runs` : '')));
  if (rec.state !== 'recommended') {
    // Measured, but not a recommendation: never headlined "Recommended", no confidence pill.
    const [stateText, stateKind] = MEASURED_STATE_BADGE[rec.state] || ['NOT RECOMMENDED', 'muted'];
    const why = rec.state === 'single-stack'
      ? `Only ${rec.basis.stack} has enough measured tasks, so there is nothing to compare it against.`
      : rec.state === 'poor-completion'
        ? `The best measured group completes too few tasks to recommend (at least ${pct(rec.basis.wilsonLower)} at 95% confidence).`
        : `The repository looks like ${rec.detectedStack}. Measured tasks favour ${rec.basis.stack}; that is shown as evidence only.`;
    return h('section', { class: 'card', 'aria-label': `${rec.label}. ${rec.stack}, ${STACK_SOURCE_TEXT[rec.stackSource] || ''}.` },
      h('div', { class: 'card-head' }, h('h3', null, rec.label), h('span', { class: 'header-spacer' }), badge(stateText, stateKind)),
      h('p', null, h('strong', null, rec.stack), ` (${STACK_SOURCE_TEXT[rec.stackSource] || rec.stackSource})`),
      h('p', { class: 'muted' }, why),
      h('details', null, h('summary', null, `Measured evidence (${rec.recordedTasks} finished agent tasks)`), groups),
      h('div', { class: 'form-actions' }, use));
  }
  const [pillText, pillKind] = CONFIDENCE_BADGE[rec.confidence] || CONFIDENCE_BADGE.low;
  return h('section', { class: 'card', 'aria-label': `Recommended for this server: ${rec.stack}, ${pillText.toLowerCase()}` },
    h('div', { class: 'card-head' }, h('h3', null, 'Recommended for this server'), h('span', { class: 'header-spacer' }), badge(pillText, pillKind)),
    h('p', null, h('strong', null, rec.stack)),
    h('p', { class: 'muted' }, `Measured from ${rec.recordedTasks} finished agent tasks with a recorded stack.`),
    groups,
    h('details', null, h('summary', null, 'How this is computed'),
      h('p', { class: 'hint' }, `Only tasks run by this server count, grouped by engine and stack, on engines connected now. A group needs at least ${rec.minPerGroup} tasks. Each group is scored by the lower end of its 95% confidence interval for completion, so small samples are not over-trusted. Gate pass rate is shown separately and does not change the score.`)),
    rec.excludedNoStack > 0 ? h('p', { class: 'hint' }, `${rec.excludedNoStack} older task record${rec.excludedNoStack === 1 ? '' : 's'} without a stack were not counted.`) : null,
    h('div', { class: 'form-actions' }, use));
}

/** Fetch and mount the recommendation into `host`. A failure leaves a quiet note, never a guess. */
async function loadRecommendation(app, host, query, onUse) {
  const r = await app.api('GET', `/api/projects/recommendation${query}`, undefined, { quiet: true });
  if (!r.ok || !r.body.recommendation) {
    mount(host, h('p', { class: 'hint' }, 'No stack recommendation is available right now.'));
    return;
  }
  mount(host, recommendationCard(r.body.recommendation, onUse));
}

/** Parse the cost-cap field; null when invalid. */
function parseCap(raw) {
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : null;
}

/**
 * Show a server error on the matching field when the server names one
 * (400 invalid-input carries `field`), else on the form.
 */
function showError(resp, fields, formErr) {
  const name = resp.body && typeof resp.body.field === 'string' ? resp.body.field : '';
  const target = fields[name] || fields[name.split('.').pop()];
  if (target) { target.setError(serverMessage(resp)); target.input.focus(); return; }
  formErr.textContent = serverMessage(resp);
  formErr.hidden = false;
}

/** /projects/new */
export function renderCreate(app, _params, view) {
  app.setTitle('New project');
  if (!app.can('project.create')) {
    mount(view, h('div', { class: 'card' }, h('p', null, 'Only a product owner or admin can create projects.')));
    return;
  }
  const { engines, stacks } = meta(app);
  const name = field({ label: 'Name', input: h('input', { type: 'text', maxlength: 80, required: true }) });
  const kindPath = h('input', { type: 'radio', name: 'source-kind', value: 'path', checked: true, id: 'src-path' });
  const kindClone = h('input', { type: 'radio', name: 'source-kind', value: 'clone', id: 'src-clone' });
  const path = field({ label: 'Folder', hint: 'A folder inside the server\'s projects root, e.g. acme-checkout.', input: h('input', { type: 'text', maxlength: 1024 }) });
  const url = field({ label: 'Clone URL', hint: 'https only (ssh when the server allows it).', input: h('input', { type: 'url', maxlength: 2048, placeholder: 'https://github.com/acme/checkout.git' }) });
  const dirName = field({ label: 'Folder name', hint: 'Where the clone goes inside the projects root.', input: h('input', { type: 'text', maxlength: 64 }) });
  const engine = field({ label: 'Default engine', input: engineSelect(app, engines.includes('claude') ? 'claude' : engines[0]) });
  const cap = field({ label: 'Cost cap per PRD version (USD)', hint: '0 = no cap.', input: capInput(10) });
  const stack = field({ label: 'Stack', input: stackSelect(app, stacks[0]) });
  const recHost = h('div', { 'aria-live': 'polite' });
  const useStack = (s) => { stack.input.value = s; stack.input.focus(); };
  const refreshRec = () => {
    const rel = kindPath.checked ? path.input.value.trim() : '';
    void loadRecommendation(app, recHost, rel ? `?path=${encodeURIComponent(rel)}` : '', useStack);
  };
  path.input.addEventListener('change', refreshRec);
  const formErr = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const pathBlock = h('div', { class: 'source-block' }, path.wrap);
  const cloneBlock = h('div', { class: 'source-block', hidden: true }, url.wrap, dirName.wrap);
  const syncKind = () => { pathBlock.hidden = !kindPath.checked; cloneBlock.hidden = !kindClone.checked; refreshRec(); };
  kindPath.addEventListener('change', syncKind);
  kindClone.addEventListener('change', syncKind);
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create project');

  const submit = async (e) => {
    e.preventDefault();
    formErr.hidden = true;
    for (const f of [name, path, url, dirName, cap]) { f.setError(''); }
    const budget = parseCap(cap.input.value);
    if (budget === null) { cap.setError('Enter an amount of 0 or more.'); cap.input.focus(); return; }
    const source = kindPath.checked
      ? { kind: 'path', path: path.input.value.trim() }
      : { kind: 'clone', url: url.input.value.trim(), dirName: dirName.input.value.trim() };
    submitBtn.disabled = true;
    const r = await app.api('POST', '/api/projects', {
      name: name.input.value.trim(), source, stack: stack.input.value, defaultEngine: engine.input.value, versionBudgetUsd: budget,
    });
    submitBtn.disabled = false;
    if (!r.ok) {
      showError(r, { name, path, url, dirName, versionBudgetUsd: cap, stack, defaultEngine: engine }, formErr);
      return;
    }
    toast(`Project ${r.body.project.name} created.`, 'success');
    // Standards v1 was proposed with the project: that is the next thing to look at.
    app.navigate(`/p/${encodeURIComponent(r.body.project.id)}/standards`);
  };

  mount(view,
    h('div', { class: 'form-page' },
      h('h1', null, 'New project'),
      h('form', { on: { submit }, novalidate: true },
        name.wrap,
        h('fieldset', { class: 'field' },
          h('legend', null, 'Source'),
          h('div', { class: 'radio-row' },
            h('label', { for: 'src-path' }, kindPath, ' Folder on the server'),
            h('label', { for: 'src-clone' }, kindClone, ' Clone from URL'))),
        pathBlock, cloneBlock,
        engine.wrap, cap.wrap,
        h('h2', { class: 'section-header' }, 'Tech stack'),
        recHost,
        stack.wrap,
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Project standards'), h('p', { class: 'hint' }, STR.C44.text)),
        formErr,
        h('div', { class: 'form-actions' },
          h('a', { href: '/projects', dataset: { link: '' }, class: 'btn btn-secondary' }, 'Cancel'),
          submitBtn))));
  name.input.focus();
  refreshRec();
}

/** /p/:id/settings — the same form in edit mode; read-only without project.update. */
export function renderSettings(app, _params, view) {
  const p = app.project.project;
  app.setTitle(`Settings · ${p.name}`);
  const editable = Array.isArray(p.allowedActions) && p.allowedActions.includes('project.update');
  const sourceText = p.source && p.source.kind === 'clone' ? `Cloned from ${p.source.url || ''} into ${p.workspaceName}` : `Folder ${p.workspaceName} on the server`;

  if (!editable) {
    mount(view, h('div', { class: 'form-page' },
      h('h1', null, 'Settings'),
      h('dl', { class: 'summary' },
        h('dt', null, 'Name'), h('dd', null, p.name),
        h('dt', null, 'Source'), h('dd', null, sourceText),
        h('dt', null, 'Default engine'), h('dd', null, p.defaultEngine),
        h('dt', null, 'Cost cap'), h('dd', null, p.versionBudgetUsd === 0 ? 'no cap set' : `${fmtUsd(p.versionBudgetUsd)} per PRD version`),
        h('dt', null, 'Stack'), h('dd', null, p.stack)),
      h('p', { class: 'muted' }, 'Only a product owner or admin can change project settings.')));
    return;
  }

  const name = field({ label: 'Name', input: h('input', { type: 'text', maxlength: 80, required: true, value: p.name }) });
  const engine = field({ label: 'Default engine', input: engineSelect(app, p.defaultEngine) });
  const cap = field({ label: 'Cost cap per PRD version (USD)', hint: '0 = no cap.', input: capInput(p.versionBudgetUsd) });
  const stack = field({ label: 'Stack', hint: STACK_CHANGE_TEXT, input: stackSelect(app, p.stack) });
  const recHost = h('div', { 'aria-live': 'polite' });
  const formErr = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const submit = async (e) => {
    e.preventDefault();
    formErr.hidden = true;
    for (const f of [name, cap]) { f.setError(''); }
    const budget = parseCap(cap.input.value);
    if (budget === null) { cap.setError('Enter an amount of 0 or more.'); cap.input.focus(); return; }
    const patch = {};
    if (name.input.value.trim() !== p.name) { patch.name = name.input.value.trim(); }
    if (engine.input.value !== p.defaultEngine) { patch.defaultEngine = engine.input.value; }
    if (budget !== p.versionBudgetUsd) { patch.versionBudgetUsd = budget; }
    if (stack.input.value !== p.stack) {
      const ok = await confirmDialog({ title: 'Change the stack?', text: STACK_CHANGE_TEXT, confirmLabel: `Change to ${stack.input.value}` });
      if (!ok) { return; }
      patch.stack = stack.input.value;
    }
    if (Object.keys(patch).length === 0) { toast('No changes to save.', 'info'); return; }
    const r = await app.api('PATCH', `/api/projects/${encodeURIComponent(p.id)}`, patch);
    if (!r.ok) { showError(r, { name, versionBudgetUsd: cap, stack, defaultEngine: engine }, formErr); return; }
    toast('Settings saved.', 'success');
    await app.refreshProject(p.id);
    app.rerender();
  };

  mount(view, h('div', { class: 'form-page' },
    h('h1', null, 'Settings'),
    h('form', { on: { submit }, novalidate: true },
      name.wrap,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Source'), h('p', null, sourceText)),
      engine.wrap, cap.wrap,
      h('h2', { class: 'section-header' }, 'Tech stack'),
      recHost,
      stack.wrap,
      formErr,
      h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save settings')))));
  void loadRecommendation(app, recHost, `?projectId=${encodeURIComponent(p.id)}`, (s) => { stack.input.value = s; stack.input.focus(); });
}
