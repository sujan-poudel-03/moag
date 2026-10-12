// ─── /p/:id/prd — PRD editor, version history, version diff panel (UX §2.4) ───
//
// Save sends the `createdAt` of the version the editor started from, so a save
// that raced another product owner's is refused (409, C5) instead of silently
// diffing against their text. Unsaved text lives in page memory per project,
// so a re-login (C20) or a stale-save review never loses it.

import { h, mount, badge, toast, announce, skeleton, errorCard, fmtAgo } from '../dom.js';
import { STR, serverMessage } from '../strings.js';
import { renderVersionPanel } from './version-panel.js';

/** projectId → { text, baseCreatedAt } — survives re-renders within the page. */
const drafts = new Map();

const BUMP_KIND = { major: 'error', minor: 'info', patch: 'muted' };

export async function render(app, params, view) {
  const projectId = params.id;
  const project = app.project.project;
  app.setTitle(`PRD · ${project.name}`);
  mount(view, skeleton(4));
  const r = await app.api('GET', `/api/projects/${encodeURIComponent(projectId)}/prd`);
  if (!r.ok) {
    mount(view, errorCard(`Couldn't load the PRD. ${serverMessage(r)}`, () => render(app, params, view)));
    return;
  }
  const state = { dto: r.body, selected: r.body.versions.length - 1, notice: null };
  const latestCreatedAt = () => (state.dto.latest ? state.dto.latest.createdAt : null);
  if (!drafts.has(projectId)) {
    drafts.set(projectId, { text: state.dto.latest ? state.dto.latest.text : '', baseCreatedAt: latestCreatedAt() });
  }
  const draft = drafts.get(projectId);
  const canSave = (state.dto.allowedActions || []).includes('prd.save');

  // ─── Elements ───
  const editor = h('textarea', {
    class: 'prd-editor', id: 'prd-editor', spellcheck: 'true', readOnly: !canSave,
    'aria-label': 'PRD text', placeholder: '# Product\n\n## Requirements\n- Users can …',
  });
  editor.value = draft.text;
  const status = h('span', { class: 'muted' });
  const saveBtn = canSave ? h('button', { type: 'button', class: 'btn btn-primary' }, 'Save PRD version') : null;
  const noticeHost = h('div');
  const versionsHost = h('div');
  const panelHost = h('div');

  const baseLabel = () => {
    const v = state.dto.versions.find((x) => x.createdAt === draft.baseCreatedAt);
    return v ? v.label : null;
  };
  const latestText = () => (state.dto.latest ? state.dto.latest.text : '');

  const updateStatus = () => {
    const label = baseLabel();
    status.textContent = `${label ? `editing from ${label}` : 'no saved version yet'}${draft.text !== latestText() ? ' ● unsaved' : ''}`;
    if (saveBtn) {
      const unchanged = draft.text === latestText();
      saveBtn.disabled = unchanged;
      saveBtn.title = unchanged ? (label ? `No changes since ${label}` : 'Write a PRD first') : '';
    }
  };

  const setNotice = (node) => { mount(noticeHost, node); };

  const renderVersions = () => {
    const list = state.dto.versions.map((v, i) => ({ v, i })).reverse();
    mount(versionsHost,
      h('h2', { class: 'section-header' }, `Versions  ${state.dto.versions.length}`),
      list.length === 0 ? h('p', { class: 'muted' }, 'No versions yet. Save the PRD to create v1.0.0.') : h('ul', { class: 'version-list' },
        list.map(({ v, i }) => h('li', null, h('button', {
          type: 'button', class: 'version-item', 'aria-current': i === state.selected ? 'true' : 'false',
          on: { click: () => { state.selected = i; renderVersions(); renderPanel(true); } },
        },
        h('span', { class: 'diff-id' }, v.label),
        v.chosenBump ? badge(v.chosenBump.toUpperCase(), BUMP_KIND[v.chosenBump] || 'muted') : h('span', { class: 'muted' }, '—'),
        h('span', { class: 'muted' }, `${v.savedBy ? `${v.savedBy.by} · ` : ''}${fmtAgo(v.createdAt)}`))))));
  };

  const renderPanel = (focus) => {
    if (state.selected < 0 || state.dto.versions.length === 0) {
      mount(panelHost, state.dto.versions.length === 0 ? h('div', { class: 'card' }, h('p', { class: 'muted' }, STR.C3.text)) : null);
      return;
    }
    const { el, heading } = renderVersionPanel(app, { projectId, dto: state.dto, index: state.selected, onChanged: () => { void reload(true); } });
    mount(panelHost, el);
    if (focus) { heading.focus(); }
  };

  const reload = async (focusPanel) => {
    const again = await app.api('GET', `/api/projects/${encodeURIComponent(projectId)}/prd`);
    if (!again.ok) { toast(`Couldn't reload the PRD. ${serverMessage(again)}`, 'error'); return; }
    state.dto = again.body;
    state.selected = state.dto.versions.length - 1;
    renderVersions();
    renderPanel(focusPanel);
    updateStatus();
  };

  // ─── Save ───
  const save = async () => {
    setNotice(null);
    editor.removeAttribute('aria-invalid');
    saveBtn.disabled = true;
    const resp = await app.api('POST', `/api/projects/${encodeURIComponent(projectId)}/prd/versions`, { text: draft.text, baseCreatedAt: draft.baseCreatedAt });
    saveBtn.disabled = false;
    if (resp.ok) {
      const label = resp.body.version.label;
      const msg = STR.C4(label, resp.body.version.recommendedBump).text;
      toast(msg, 'success');
      announce(msg);
      // The server tags untagged requirements with IDs on save: continue from that text.
      draft.text = resp.body.text;
      editor.value = draft.text;
      await reload(false);
      draft.baseCreatedAt = latestCreatedAt();
      updateStatus();
      renderPanel(true);
      return;
    }
    if (resp.status === 409 && resp.body.error === 'stale-base') {
      setNotice(h('div', { class: ['card', 'card-warning'], role: 'alert' },
        h('p', null, STR.C5(state.dto.versions.length ? 'A newer version' : 'The PRD').text),
        h('button', { type: 'button', class: 'btn btn-secondary', on: { click: async () => {
          await reload(true);
          // Rebase onto the version that won; the user's text is untouched.
          draft.baseCreatedAt = latestCreatedAt();
          updateStatus();
          setNotice(h('p', { class: 'muted' }, `Now editing from ${baseLabel()}. Review it, then save again.`));
        } } }, 'Show latest version')));
      return;
    }
    if (resp.status === 409 && resp.body.error === 'no-change') {
      setNotice(h('p', { class: 'card card-info', role: 'status' }, serverMessage(resp)));
      return;
    }
    if (resp.status === 422 && Array.isArray(resp.body.errors)) {
      editor.setAttribute('aria-invalid', 'true');
      setNotice(h('div', { class: ['card', 'card-error'], role: 'alert' },
        h('p', null, h('strong', null, '✗ PRD not saved — requirement IDs are ambiguous')),
        h('ul', { class: 'diff-list' }, resp.body.errors.map((e) => h('li', null,
          h('span', { class: 'diff-id' }, e.id), `line ${e.line}: ${e.message}`)))));
      return;
    }
    if (resp.status !== 401 && resp.status !== 403) { setNotice(h('p', { class: 'form-error', role: 'alert' }, serverMessage(resp))); }
  };

  editor.addEventListener('input', () => { draft.text = editor.value; updateStatus(); });
  if (saveBtn) { saveBtn.addEventListener('click', () => { void save(); }); }

  mount(view,
    h('div', { class: 'prd-toolbar' },
      h('h1', null, `PRD · ${project.name}`), status, h('span', { class: 'header-spacer' }), saveBtn),
    canSave ? null : h('p', { class: 'muted' }, 'Read-only: only a product owner can edit the PRD.'),
    h('div', { class: 'prd-layout' },
      h('div', null, noticeHost, editor),
      h('div', null, versionsHost, panelHost)));
  renderVersions();
  renderPanel(false);
  updateStatus();
  if (canSave && !state.dto.latest) { editor.focus(); }

  // A different tab or user may have saved since this draft was taken.
  if (draft.baseCreatedAt !== latestCreatedAt() && draft.text === latestText()) {
    draft.baseCreatedAt = latestCreatedAt();
    updateStatus();
  }
  return () => { drafts.set(projectId, { ...draft }); };
}

