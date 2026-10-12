// ─── New project (/projects/new) and project settings (/p/:id/settings) ───
//
// One form in two modes. Source is chosen at creation and read-only afterwards.
// Engine, stack and role lists come from the server (`session.meta`), never a
// hard-coded copy, so the form can only offer values the server will accept.
//
// The stack recommendation card (UX §2.3) shows only what the server measured.
// In its static-default state it shows no percentage and no sample figure at all.
// Its prior state (nothing measured yet) is "Suggested stack", LOW CONFIDENCE, from
// general model strengths, and shows no number at all.
// Measured data is headlined "Recommended" only in the server's 'recommended'
// state; single-stack, poor-completion and detected-differs show it as evidence.

import { h, mount, field, toast, confirmDialog, fmtUsd, badge, glyph, skeleton } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

const STACK_CHANGE_TEXT = 'Changing the stack affects future runs and recommendations only. Past outcomes keep the stack they were recorded with.';

function meta(app) {
  const m = (app.session && app.session.meta) || {};
  return {
    engines: Array.isArray(m.engines) ? m.engines : [],
    unsupportedEngines: Array.isArray(m.unsupportedEngines) ? m.unsupportedEngines : [],
    stacks: Array.isArray(m.stacks) ? m.stacks : [],
    // Sent only to someone who may create a project, and only by a server that knows it.
    projectsRoot: typeof m.projectsRoot === 'string' && m.projectsRoot !== '' ? m.projectsRoot : null,
  };
}

// ─── Folder field: pure helpers ───

/** Longest folder name the Name field prefills. */
const MAX_SLUG = 64;

/**
 * A folder name from a project name: lowercase; every run of characters outside
 * `[a-z0-9._-]` becomes one `-`; leading and trailing `-` and `.` trimmed; at most 64 characters.
 */
export function slugify(name) {
  const trim = (s) => s.replace(/^[-.]+|[-.]+$/g, '');
  return trim(trim(String(name || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')).slice(0, MAX_SLUG));
}

/** Windows device names, alone or with any extension (server `RESERVED_DEVICE_RE`). */
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i;
/** Characters Windows does not allow in a file name, and control characters (server `RESERVED_CHAR_RE`). */
// eslint-disable-next-line no-control-regex
const RESERVED_CHAR_RE = /[<>"|?*\x00-\x1f]/;

/**
 * Why one folder name is refused, or '' when it is accepted: the same rule as the server's
 * `invalidSegmentReason` (src/server/projects.ts). Only dots, a leading space, a trailing dot
 * or space, a device name, or a reserved character: Windows would open a different folder.
 */
export function invalidSegmentReason(s) {
  if (s === '.') { return ''; }
  if (s === '..') { return 'Path must not contain "..".'; }
  if (/^\.+$/.test(s)) { return 'A folder name cannot be only dots.'; }
  if (/^\s/.test(s) || /[\s.]$/.test(s)) { return 'A folder name cannot start with a space, or end with a space or a dot.'; }
  if (RESERVED_CHAR_RE.test(s)) { return 'A folder name cannot contain < > " | ? * or control characters.'; }
  if (RESERVED_DEVICE_RE.test(s)) { return `"${s}" is a reserved device name on Windows.`; }
  return '';
}

/**
 * What a Folder value is, against the projects root, without asking the server:
 * `{kind:'relative', rel}` — a name under the root, as the server wants it;
 * `{kind:'inside-root', rel}` — an absolute path inside the root, which becomes `rel`;
 * `{kind:'is-root'}` — the root itself; `{kind:'outside-root'}` — an absolute path elsewhere;
 * `{kind:'dotdot'}` — a `..` segment; `{kind:'colon'}` — a folder name with a `:` in it
 * (a drive letter part-way, or a stream name), which the server refuses;
 * `{kind:'bad-name', reason}` — a folder name the server refuses because Windows would open a
 * different folder (see {@link invalidSegmentReason}); `{kind:'empty'}`. Separators are read as `/`; a root
 * with a drive letter is compared without case. An absolute value is one starting with
 * `/` or `\`, or with a drive letter.
 */
export function classifyFolder(value, root) {
  const v = String(value || '').trim();
  if (v === '') { return { kind: 'empty' }; }
  const slashed = v.replace(/\\/g, '/');
  const absolute = /^[/\\]/.test(v) || /^[A-Za-z]:/.test(v);
  const relOf = (text) => {
    const segments = text.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.includes('..')) { return { kind: 'dotdot' }; }
    if (segments.some((s) => s.includes(':'))) { return { kind: 'colon' }; }
    for (const s of segments) {
      const reason = invalidSegmentReason(s);
      if (reason) { return { kind: 'bad-name', reason }; }
    }
    return segments.length === 0 ? { kind: 'is-root' } : { rel: segments.join('/') };
  };
  if (!absolute) {
    const r = relOf(slashed);
    return r.rel !== undefined ? { kind: 'relative', rel: r.rel } : r;
  }
  if (!root) { return { kind: 'outside-root' }; }
  const caseless = /^[A-Za-z]:/.test(root);
  const cmp = (s) => (caseless ? s.toLowerCase() : s);
  const rootN = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const valueN = slashed.replace(/\/+$/, '');
  if (cmp(valueN) === cmp(rootN) || (rootN === '' && valueN === '')) { return { kind: 'is-root' }; }
  if (!cmp(valueN).startsWith(`${cmp(rootN)}/`)) { return { kind: 'outside-root' }; }
  const r = relOf(valueN.slice(rootN.length + 1));
  return r.rel !== undefined ? { kind: 'inside-root', rel: r.rel } : r;
}

/** The full path a folder name resolves to, written with the root's own separator. */
export function composeFullPath(root, rel) {
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${base}${sep}${String(rel).split('/').filter(Boolean).join(sep)}`;
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

/** "What are you building?" choices: the server's BUILDING_KINDS, with the words a person reads. */
const BUILDING_OPTIONS = [
  ['', 'Not sure'],
  ['web-app', 'Web app'],
  ['api', 'API or backend service'],
  ['cli', 'Command-line tool'],
  ['static-site', 'Static website'],
];

/**
 * The suggestion from general model strengths (server source 'prior'): never headlined
 * "Recommended", LOW CONFIDENCE, the server's label verbatim, and no number of any kind.
 * The "What are you building?" select re-ranks only this suggestion.
 */
function priorCard(rec, use, opts, skipped) {
  const engines = Array.isArray(rec.enginesConsidered) ? rec.enginesConsidered : [];
  const select = h('select', { id: 'rec-building', on: { change: (e) => { if (opts.onBuilding) { opts.onBuilding(e.target.value); } } } },
    BUILDING_OPTIONS.map(([value, label]) => h('option', { value, selected: value === (opts.building || '') }, label)));
  return h('section', { class: 'card', 'aria-label': `Suggested stack: ${rec.stack}, low confidence, ${rec.label}` },
    h('div', { class: 'card-head' }, h('h3', null, 'Suggested stack'), h('span', { class: 'header-spacer' }), badge('LOW CONFIDENCE', 'warning')),
    h('p', null, h('strong', null, rec.stack)),
    skipped,
    h('p', { class: 'muted' }, rec.label),
    engines.length > 0 ? h('p', { class: 'muted' }, `Engines considered: ${engines.map((e) => e.engine).join(', ')}`) : null,
    opts.onBuilding ? h('div', { class: 'field' },
      h('label', { for: 'rec-building' }, 'What are you building? (optional)'),
      select,
      h('p', { class: 'hint' }, 'Changes only this suggestion. Measured results and detected stacks are not affected.')) : null,
    h('details', null, h('summary', null, 'How this is chosen'),
      h('ul', { class: 'diff-list' }, engines.map((e) => h('li', null, `${e.engine} · ${rec.stack}: ${e.strength}`))),
      h('p', { class: 'hint' }, STR.C86(rec.minPerGroup).text)),
    h('div', { class: 'form-actions' }, use));
}

/**
 * The recommendation card. `rec` is the server's StackRecommendation; `onUse`
 * puts its stack into the form's stack select. `opts.detectionSkipped` says the
 * repository was not read (the folder is not valid yet); `opts.building` and
 * `opts.onBuilding` drive the prior card's "What are you building?" select.
 */
export function recommendationCard(rec, onUse, opts = {}) {
  const use = h('button', { type: 'button', class: 'btn btn-secondary btn-small', on: { click: () => onUse(rec.stack) } }, `Use ${rec.stack}`);
  const skipped = opts.detectionSkipped ? h('p', { class: 'muted' }, glyph('○'), ' ', STR.C87.text) : null;
  if (rec.source === 'prior') {
    return priorCard(rec, use, opts, skipped);
  }
  if (rec.source !== 'measured') {
    const n = Number(rec.recordedTasks) || 0;
    return h('section', { class: 'card', 'aria-label': `${rec.label}. No data.` },
      h('div', { class: 'card-head' }, h('h3', null, rec.label), h('span', { class: 'header-spacer' }), badge('NO DATA', 'muted')),
      h('p', null, h('strong', null, rec.stack), ` (${rec.defaultLabel})`),
      skipped,
      rec.priorSuggests && rec.defaultKind === 'detected'
        ? h('p', { class: 'muted' }, `General model strengths would suggest ${rec.priorSuggests}. Your repository looks like ${rec.stack}, so ${rec.stack} is offered.`)
        : null,
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
      skipped,
      h('p', { class: 'muted' }, why),
      h('details', null, h('summary', null, `Measured evidence (${rec.recordedTasks} finished agent tasks)`), groups),
      h('div', { class: 'form-actions' }, use));
  }
  const [pillText, pillKind] = CONFIDENCE_BADGE[rec.confidence] || CONFIDENCE_BADGE.low;
  return h('section', { class: 'card', 'aria-label': `Recommended for this server: ${rec.stack}, ${pillText.toLowerCase()}` },
    h('div', { class: 'card-head' }, h('h3', null, 'Recommended for this server'), h('span', { class: 'header-spacer' }), badge(pillText, pillKind)),
    h('p', null, h('strong', null, rec.stack)),
    skipped,
    h('p', { class: 'muted' }, `Measured from ${rec.recordedTasks} finished agent tasks with a recorded stack.`),
    groups,
    h('details', null, h('summary', null, 'How this is computed'),
      h('p', { class: 'hint' }, `Only tasks run by this server count, grouped by engine and stack, on engines connected now. A group needs at least ${rec.minPerGroup} tasks. Each group is scored by the lower end of its 95% confidence interval for completion, so small samples are not over-trusted. Gate pass rate is shown separately and does not change the score.`)),
    rec.excludedNoStack > 0 ? h('p', { class: 'hint' }, `${rec.excludedNoStack} older task record${rec.excludedNoStack === 1 ? '' : 's'} without a stack were not counted.`) : null,
    h('div', { class: 'form-actions' }, use));
}

/**
 * Fetch and mount the recommendation into `host`. A failure leaves a quiet note and a way to
 * try again, never a guess. `opts.building` / `opts.onBuilding` drive the prior card's
 * "What are you building?" select; after a change of it, focus returns to the select.
 */
async function loadRecommendation(app, host, query, onUse, opts = {}) {
  const hadFocus = !!(document.activeElement && document.activeElement.id === 'rec-building');
  mount(host, skeleton(2));
  const r = await app.api('GET', `/api/projects/recommendation${query}`, undefined, { quiet: true });
  if (!r.ok || !r.body.recommendation) {
    mount(host, h('p', { class: 'hint' }, STR.C88.text, ' ',
      h('button', { type: 'button', class: 'btn-link', on: { click: () => { void loadRecommendation(app, host, query, onUse, opts); } } }, 'Try again')));
    return;
  }
  mount(host, recommendationCard(r.body.recommendation, onUse, { ...opts, detectionSkipped: r.body.detectionSkipped === true }));
  const select = hadFocus ? document.getElementById('rec-building') : null;
  if (select) { select.focus(); }
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
  const { engines, stacks, projectsRoot } = meta(app);
  const name = field({ label: 'Name', input: h('input', { type: 'text', maxlength: 80, required: true }) });
  const kindPath = h('input', { type: 'radio', name: 'source-kind', value: 'path', checked: true, id: 'src-path' });
  const kindClone = h('input', { type: 'radio', name: 'source-kind', value: 'clone', id: 'src-clone' });
  const kindNew = h('input', { type: 'radio', name: 'source-kind', value: 'new', id: 'src-new' });
  const path = field({ label: 'Folder', hint: 'A folder inside the server\'s projects root, e.g. acme-checkout.', input: h('input', { type: 'text', maxlength: 1024 }) });
  // The Folder field serves both "Folder on the server" and "Start a new empty project".
  const folder = folderAssist(app, path, projectsRoot, () => refreshRec(), () => kindNew.checked);
  const newHint = h('p', { class: 'hint', hidden: true }, STR.C106.text);
  name.input.addEventListener('input', () => folder.prefill(name.input.value));
  const url = field({ label: 'Clone URL', hint: 'https only (ssh when the server allows it).', input: h('input', { type: 'url', maxlength: 2048, placeholder: 'https://github.com/acme/checkout.git' }) });
  const dirName = field({ label: 'Folder name', hint: 'Where the clone goes inside the projects root.', input: h('input', { type: 'text', maxlength: 64 }) });
  const engine = field({ label: 'Default engine', input: engineSelect(app, engines.includes('claude') ? 'claude' : engines[0]) });
  const cap = field({ label: 'Cost cap per PRD version (USD)', hint: '0 = no cap.', input: capInput(10) });
  const stack = field({ label: 'Stack', input: stackSelect(app, stacks[0]) });
  const recHost = h('div', { 'aria-live': 'polite' });
  const useStack = (s) => { stack.input.value = s; stack.input.focus(); };
  let building = '';
  const refreshRec = () => {
    const rel = kindPath.checked ? folder.effective() : '';
    const params = [rel ? `path=${encodeURIComponent(rel)}` : null, building ? `building=${encodeURIComponent(building)}` : null].filter(Boolean);
    void loadRecommendation(app, recHost, params.length > 0 ? `?${params.join('&')}` : '', useStack, {
      building, onBuilding: (value) => { building = value; refreshRec(); },
    });
  };
  path.input.addEventListener('change', refreshRec);
  const formErr = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const pathBlock = h('div', { class: 'source-block' }, path.wrap, newHint, folder.parts);
  const cloneBlock = h('div', { class: 'source-block', hidden: true }, url.wrap, dirName.wrap);
  const syncKind = () => {
    pathBlock.hidden = !(kindPath.checked || kindNew.checked);
    newHint.hidden = !kindNew.checked;
    cloneBlock.hidden = !kindClone.checked;
    // The same folder name means something else in each mode: check it again.
    folder.update();
    refreshRec();
  };
  kindPath.addEventListener('change', syncKind);
  kindClone.addEventListener('change', syncKind);
  kindNew.addEventListener('change', syncKind);
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create project');

  const submit = async (e) => {
    e.preventDefault();
    formErr.hidden = true;
    for (const f of [name, path, url, dirName, cap]) { f.setError(''); }
    const budget = parseCap(cap.input.value);
    if (budget === null) { cap.setError('Enter an amount of 0 or more.'); cap.input.focus(); return; }
    // A Folder value the server would refuse is said here, on the field, and nothing is sent.
    if ((kindPath.checked || kindNew.checked) && !folder.readyToSubmit()) { path.input.focus(); return; }
    const source = kindPath.checked ? { kind: 'path', path: path.input.value.trim() }
      : kindNew.checked ? { kind: 'new', path: path.input.value.trim() }
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
            h('label', { for: 'src-clone' }, kindClone, ' Clone from URL'),
            h('label', { for: 'src-new' }, kindNew, ' Start a new empty project'))),
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
  folder.update();
  refreshRec();
}

/** How long the Folder field waits after the last keystroke before asking the server. */
const FOLDER_CHECK_DEBOUNCE_MS = 300;

/**
 * Everything around the Folder input of the new-project form: the projects root and the full
 * path the value resolves to, the prefill from the project name until the user edits the
 * field, an absolute path inside the root turned into the relative name (always shown, never
 * silent), the client-side refusals, and the live check against the server (debounced; a late
 * answer to an older value is dropped). With no `root` from the server, only the line saying
 * so is shown and the field behaves as it always did. While `isNew()` is true (a new empty
 * project) the server is asked whether the folder can be CREATED instead (`mode=new`).
 */
export function folderAssist(app, path, root, onSettled, isNew = () => false) {
  const input = path.input;
  let touched = false;
  let seq = 0;
  let timer = null;
  const prefillHint = h('p', { class: 'hint', hidden: true, id: `${input.id}-prefill` }, STR.C83b.text);
  const rootDd = h('dd', { class: 'diff-id' }, root || STR.C84b.text);
  const fullDd = h('dd', { class: 'diff-id' }, '');
  const summary = h('dl', { class: 'summary', id: `${input.id}-paths` },
    h('dt', null, 'Projects root'), rootDd,
    root ? [h('dt', null, 'Full path'), fullDd] : null);
  const note = h('p', { class: 'hint', hidden: true, id: `${input.id}-note` });
  const status = h('p', { role: 'status', id: `${input.id}-status` });
  const described = input.getAttribute('aria-describedby') || '';
  input.setAttribute('aria-describedby', [prefillHint.id, summary.id, note.id, status.id, described].filter(Boolean).join(' '));

  const showNote = (text) => { note.textContent = text || ''; note.hidden = !text; };
  const showStatus = (glyphText, text, cls, extra) => {
    while (status.firstChild) { status.removeChild(status.firstChild); }
    status.className = cls || '';
    if (text) { status.appendChild(h('span', { 'aria-hidden': 'true' }, glyphText)); status.appendChild(document.createTextNode(` ${text}`)); }
    if (extra) { status.appendChild(document.createTextNode(' ')); status.appendChild(extra); }
  };
  const classify = () => classifyFolder(input.value, root);
  /** The relative name the server will be sent (or would be, once converted), or ''. */
  const effective = () => {
    const c = classify();
    return c.kind === 'relative' || c.kind === 'inside-root' ? c.rel : '';
  };
  /** The client's own refusal of the current value, or ''. */
  const clientError = () => {
    if (!root) { return ''; }
    const c = classify();
    if (c.kind === 'is-root') { return STR.C81.text; }
    if (c.kind === 'outside-root') { return STR.C82(input.value.trim(), root).text; }
    if (c.kind === 'dotdot') { return 'Path must not contain "..".'; }
    if (c.kind === 'colon') { return 'Folder names must not contain ":".'; }
    if (c.kind === 'bad-name') { return c.reason; }
    return '';
  };
  const useTopLevel = (rel) => h('button', { type: 'button', class: 'btn-link', on: { click: () => {
    touched = true;
    prefillHint.hidden = true;
    input.value = rel;
    update();
    input.focus();
  } } }, `Use ${rel}`);
  const settle = (body) => {
    if (body.fullPath) { fullDd.textContent = body.fullPath; }
    switch (body.status) {
      case 'ok': showStatus('✓', STR.C74.text, 'text-success'); break;
      case 'path-not-found': showStatus('✗', STR.C75(root).text, 'text-error'); break;
      case 'not-a-git-repo': showStatus('✗', STR.C76.text, 'text-error'); break;
      case 'not-repo-root': showStatus('✗', STR.C77(body.topLevelRel || null).text, 'text-error', body.topLevelRel ? useTopLevel(body.topLevelRel) : null); break;
      case 'workspace-registered': showStatus('✗', STR.C78.text, 'text-error'); break;
      case 'workspace-nested': showStatus('✗', STR.C79.text, 'text-error'); break;
      case 'root-missing': showStatus('⚠', STR.C84(root).text, 'text-warning'); break;
      case 'invalid-path': showStatus('', '', ''); path.setError(body.reason || 'That folder name is not valid.'); break;
      case 'will-create': showStatus('✓', STR.C103.text, 'text-success'); break;
      case 'empty-folder': showStatus('✓', STR.C104.text, 'text-success'); break;
      case 'not-empty': showStatus('✗', STR.C105.text, 'text-error'); break;
      default: showStatus('○', STR.C83.text, 'muted');
    }
  };
  const check = async () => {
    const rel = effective();
    if (!root || rel === '' || clientError()) { return; }
    const mine = ++seq;
    showStatus('⟳', 'Checking…', 'muted');
    const mode = isNew() ? '&mode=new' : '';
    const r = await app.api('GET', `/api/projects/folder-check?path=${encodeURIComponent(rel)}${mode}`, undefined, { quiet: true });
    if (mine !== seq) { return; }
    if (!r.ok || !r.body || typeof r.body.status !== 'string') { showStatus('○', STR.C83.text, 'muted'); return; }
    settle(r.body);
    onSettled();
  };
  /** Redraw the full path, the note and the client error for the current value; schedule the check. */
  const update = () => {
    path.setError('');
    if (!root) { return; }
    const c = classify();
    const rel = effective();
    fullDd.textContent = composeFullPath(root, rel || '…');
    showNote(c.kind === 'inside-root' ? STR.C80b(c.rel).text : '');
    const error = clientError();
    if (error) { path.setError(error); }
    if (timer) { clearTimeout(timer); }
    seq++; // whatever is in flight answers an older value
    if (rel === '' || error) { showStatus('', '', ''); return; }
    timer = setTimeout(() => { void check(); }, FOLDER_CHECK_DEBOUNCE_MS);
  };
  /** An absolute path inside the root becomes its relative name, and the note says so. */
  const convert = () => {
    if (!root) { return; }
    const c = classify();
    if (c.kind !== 'inside-root') { return; }
    const typed = input.value.trim();
    input.value = c.rel;
    update();
    showNote(STR.C80(typed, c.rel).text);
  };
  input.addEventListener('input', () => { touched = true; prefillHint.hidden = true; update(); });
  input.addEventListener('blur', convert);
  input.addEventListener('paste', () => { setTimeout(convert, 0); });

  return {
    parts: [prefillHint, summary, note, status],
    effective,
    update,
    /** Fill the folder from the project name until the user has typed in it. */
    prefill(projectName) {
      if (touched) { return; }
      input.value = slugify(projectName);
      prefillHint.hidden = input.value === '';
      update();
    },
    /** False (with the error on the field) when the value must not be sent; converts an absolute path first. */
    readyToSubmit() {
      if (!root) { return true; }
      convert();
      if (classify().kind === 'empty') { path.setError('Enter a folder name, for example acme-checkout.'); return false; }
      const error = clientError();
      if (error) { path.setError(error); return false; }
      return true;
    },
  };
}

/** /p/:id/settings — the same form in edit mode; read-only without project.update. */
export function renderSettings(app, _params, view) {
  const p = app.project.project;
  app.setTitle(`Settings · ${p.name}`);
  const editable = Array.isArray(p.allowedActions) && p.allowedActions.includes('project.update');
  const sourceText = p.source && p.source.kind === 'clone' ? `Cloned from ${p.source.url || ''} into ${p.workspaceName}`
    : p.source && p.source.kind === 'new' ? `Started as a new empty project in ${p.workspaceName} on the server`
      : `Folder ${p.workspaceName} on the server`;

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
  let building = '';
  const refreshRec = () => {
    const extra = building ? `&building=${encodeURIComponent(building)}` : '';
    void loadRecommendation(app, recHost, `?projectId=${encodeURIComponent(p.id)}${extra}`, (s) => { stack.input.value = s; stack.input.focus(); }, {
      building, onBuilding: (value) => { building = value; refreshRec(); },
    });
  };
  refreshRec();
}
