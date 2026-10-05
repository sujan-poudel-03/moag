// ─── /admin/engines — installed CLIs and API keys (UX §2.10) ───
//
// Status comes from the server's last engine probe (`--version` checks run in a
// worker at boot and on Re-check). No live provider calls are made, so CLI
// auth is shown as "unknown". The anthropic key is write-only from here: the
// server returns whether it is set and its last 4 characters, never the key.

import { h, mount, badge, glyph, toast, confirmDialog, openModal, field, skeleton, errorCard, fmtTime } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

const KEY_DIALOG_TEXT = 'Stored encrypted on the server. After saving you will only see the last 4 characters.';
const POLL_MS = 2000;

function installCell(row) {
  if (!row.supported) { return h('td', { class: 'muted' }, '— Not supported in web'); }
  if (row.kind === 'api') { return h('td', null, 'API'); }
  if (row.available === null) { return h('td', { class: 'muted' }, glyph('○'), ' Not checked yet'); }
  if (row.available) { return h('td', null, glyph('✓'), ` Installed${row.version ? ` ${row.version}` : ''}`); }
  return h('td', { class: 'muted' }, glyph('✗'), ' Not installed', row.error ? h('span', { class: 'hint' }, ` (${row.error})`) : null);
}

function authCell(row) {
  if (!row.supported) { return h('td', null, ''); }
  switch (row.auth) {
    case 'key-set': return h('td', null, glyph('✓'), ` Key set (…${row.key && row.key.last4 ? row.key.last4 : ''})`);
    case 'key-unreadable': return h('td', null, badge('KEY UNREADABLE', 'error'), ' Set it again (wrong master key or damaged file).');
    case 'key-not-set': return h('td', { class: 'muted' }, 'Key not set');
    default: return h('td', { class: 'muted' }, '? Auth unknown');
  }
}

/** Help shown under a CLI row; text only, the server has no install action. */
function helpText(row) {
  if (row.kind !== 'cli' || !row.supported) { return null; }
  return row.available
    ? `Sign in to ${row.id} as the server's user (in the container, with HOME on the data volume). See docs/server.md.`
    : `Install the ${row.id} CLI in the server image (a derived Docker image), then Re-check. See docs/server.md.`;
}

export async function render(app, params, view) {
  app.setTitle('Engines');
  if (!app.can('engines.manage')) { mount(view, h('div', { class: 'card' }, h('p', null, STR.C21.text))); return; }
  mount(view, h('h1', null, 'Engines'), skeleton(5));
  const r = await app.api('GET', '/api/admin/engines');
  if (!r.ok) { mount(view, h('h1', null, 'Engines'), errorCard(`Couldn't load engines. ${serverMessage(r)}`, () => render(app, params, view))); return; }
  const d = r.body;
  const reload = () => render(app, params, view);

  let poll = null;
  if (d.inProgress) {
    poll = setTimeout(() => { if (document.contains(view) && location.pathname === '/admin/engines') { void reload(); } }, POLL_MS);
  }

  const recheck = async () => {
    const resp = await app.api('POST', '/api/admin/engines/recheck', {});
    if (!resp.ok && resp.status !== 403) { toast(serverMessage(resp), resp.status === 409 ? 'info' : 'error'); }
    if (poll) { clearTimeout(poll); }
    await reload();
  };

  const setKey = async (row) => {
    const saved = await openModal({
      title: `${row.key && row.key.set ? 'Rotate' : 'Set'} the ${row.id} API key`,
      initialFocus: 'input[type="password"]',
      build: (close) => {
        const key = field({ label: 'API key', hint: KEY_DIALOG_TEXT, input: h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: 512 }) });
        const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
        const submit = async (e) => {
          e.preventDefault();
          err.hidden = true;
          const value = key.input.value.trim();
          if (value === '') { key.setError('Enter the key.'); key.input.focus(); return; }
          const resp = await app.api('PUT', `/api/admin/engines/${encodeURIComponent(row.id)}/key`, { value });
          // The key never stays in the page once submitted.
          key.input.value = '';
          if (!resp.ok) { err.textContent = serverMessage(resp); err.hidden = false; return; }
          close(true);
        };
        return h('form', { class: 'dialog-body', on: { submit }, novalidate: true }, key.wrap, err,
          h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', class: 'btn btn-secondary', dataset: { role: 'cancel' }, on: { click: () => close(null) } }, 'Cancel'),
            h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save key')));
      },
    });
    if (saved) { toast(`${row.id} API key saved.`, 'success'); await reload(); }
  };

  const clearKey = async (row) => {
    const ok = await confirmDialog({ title: `Clear the ${row.id} API key?`, text: STR.C27(row.id).text, confirmLabel: 'Clear key', destructive: true });
    if (!ok) { return; }
    const resp = await app.api('DELETE', `/api/admin/engines/${encodeURIComponent(row.id)}/key`, {});
    if (!resp.ok) { if (resp.status !== 403) { toast(serverMessage(resp), 'error'); } return; }
    toast(`${row.id} API key cleared.`, 'success');
    await reload();
  };

  const keyActions = (row) => {
    if (row.kind !== 'api' || !row.supported) { return null; }
    if (!d.masterKeyConfigured) {
      return h('span', { class: 'hint' }, 'Keys can\'t be stored: the server has no master key (MOAG_MASTER_KEY_FILE).');
    }
    const isSet = row.key && row.key.set;
    return h('div', { class: 'inline-row' },
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', on: { click: () => setKey(row) } }, isSet ? 'Rotate' : 'Set key'),
      isSet ? h('button', { type: 'button', class: 'btn btn-danger btn-small', on: { click: () => clearKey(row) } }, 'Clear') : null);
  };

  const status = d.inProgress
    ? h('span', { class: 'muted', role: 'status' }, glyph('⟳'), ' Checking…')
    : h('span', { class: 'muted' }, d.checkedAt ? `No live calls; status as of ${fmtTime(d.checkedAt)}` : 'Not checked yet');

  mount(view,
    h('div', { class: 'screen-header' }, h('h1', null, 'Engines'), h('span', { class: 'header-spacer' }), status,
      h('button', { type: 'button', class: 'btn btn-secondary', disabled: !!d.inProgress, on: { click: recheck } }, 'Re-check')),
    d.error ? h('div', { class: ['card', 'card-error'], role: 'alert' }, h('p', null, glyph('✗'), ' The last engine check failed: '), h('pre', { class: 'mono' }, d.error)) : null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('caption', null, 'Engine CLIs installed on this server and stored API keys'),
      h('thead', null, h('tr', null, ['Engine', 'Installed', 'Auth', 'Actions'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, (d.rows || []).map((row) => h('tr', null,
        h('th', { scope: 'row' }, row.id),
        installCell(row),
        authCell(row),
        h('td', null, keyActions(row), helpText(row) ? h('p', { class: 'hint' }, helpText(row)) : null)))))));

  return () => { if (poll) { clearTimeout(poll); } };
}
