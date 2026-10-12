// ─── /admin/users — accounts and roles (UX §2.10) ───
//
// Role changes, disabling and temporary passwords sign the user out of every
// session (server-side epoch bump). Done to your own account, that includes the
// session you are using: the app then sends you to sign in with C61/C62, never the
// "no permission" message (C21). The last active admin cannot be removed or
// disabled (409, C26). Role choices come from the server's closed list.

import { h, mount, badge, toast, confirmDialog, openModal, field, skeleton, errorCard, uid } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

const ROLE_LABEL = { 'product-owner': 'PO', reviewer: 'REVIEWER', approver: 'APPROVER', admin: 'ADMIN' };
const ROLE_NAME = { 'product-owner': 'Product owner', reviewer: 'Reviewer', approver: 'Approver', admin: 'Admin' };

function roleChecks(allRoles, selected) {
  const boxes = allRoles.map((r) => {
    const id = uid('role');
    const input = h('input', { type: 'checkbox', id, value: r, checked: selected.includes(r) });
    return { input, el: h('label', { for: id }, input, ` ${ROLE_NAME[r] || r}`) };
  });
  return {
    el: h('fieldset', { class: 'field' }, h('legend', null, 'Roles'), h('div', { class: 'radio-row' }, boxes.map((b) => b.el))),
    value: () => boxes.filter((b) => b.input.checked).map((b) => b.input.value),
  };
}

/**
 * The sign-in notice to show when a successful PATCH ended the signed-in user's own
 * session, or null when that session survives. The server says so (`sessionEnded`); a
 * change to the user's own account that the server did not flag is read the same way,
 * because a role change, disable or password set always signs the target out. Pure.
 * @param {{ ok: boolean, body: object }} resp
 * @param {{ roles?: string[], disabled?: boolean, password?: string }} body what was sent
 * @param {boolean} isSelf the target is the signed-in user
 */
export function ownSessionEndedNotice(resp, body, isSelf) {
  if (!resp || !resp.ok) { return null; }
  const sent = body || {};
  const flagged = !!(resp.body && resp.body.sessionEnded === true);
  const ownChange = isSelf && (sent.roles !== undefined || sent.disabled !== undefined || sent.password !== undefined);
  if (!flagged && !ownChange) { return null; }
  return sent.roles !== undefined ? STR.C61.text : STR.C62.text;
}

export async function render(app, _params, view) {
  app.setTitle('Users');
  if (!app.can('users.manage')) { mount(view, h('div', { class: 'card' }, h('p', null, STR.C21.text))); return; }
  mount(view, h('h1', null, 'Users'), skeleton(4));
  const r = await app.api('GET', '/api/admin/users');
  if (!r.ok) { mount(view, h('h1', null, 'Users'), errorCard(`Couldn't load users. ${serverMessage(r)}`, () => render(app, _params, view))); return; }
  const allRoles = (app.session.meta && app.session.meta.roles) || Object.keys(ROLE_LABEL);
  const users = r.body.users || [];
  const reload = () => render(app, _params, view);

  const patch = async (u, body, success) => {
    const resp = await app.api('PATCH', `/api/admin/users/${encodeURIComponent(u.id)}`, body);
    if (!resp.ok) {
      if (resp.status === 409 && resp.body.error === 'last-admin') { toast(STR.C26.text, 'error'); }
      // 403 forbidden (C21) and 401 session ended (the sign-in prompt) are shown by app.api.
      else if (resp.status !== 403 && resp.status !== 401) { toast(serverMessage(resp), 'error'); }
      return false;
    }
    // Changing your own roles (or account) signs you out: say why and go to sign-in,
    // instead of re-rendering a screen the now signed-out user cannot see (C21).
    const ended = ownSessionEndedNotice(resp, body, u.id === app.session.user.id);
    if (ended) { await app.endSession(ended); return true; }
    toast(success, 'success');
    if (u.id === app.session.user.id) { await app.refreshSession(); }
    await reload();
    return true;
  };

  const changeRoles = async (u) => {
    const chosen = await openModal({
      title: `Change ${u.username}'s roles`,
      build: (close) => {
        const checks = roleChecks(allRoles, u.roles);
        const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
        const submit = (e) => {
          e.preventDefault();
          const v = checks.value();
          if (v.length === 0) { err.textContent = 'Choose at least one role.'; err.hidden = false; return; }
          close(v);
        };
        return h('form', { class: 'dialog-body', on: { submit } }, checks.el, err,
          h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => close(null) } }, 'Cancel'),
            h('button', { type: 'submit', class: 'btn btn-primary' }, 'Continue')));
      },
    });
    if (!chosen) { return; }
    const names = chosen.map((x) => ROLE_NAME[x] || x).join(', ');
    const ok = await confirmDialog({ title: 'Change roles?', text: STR.C25(u.username, names).text, confirmLabel: 'Change roles' });
    if (ok) { await patch(u, { roles: chosen }, `${u.username}'s roles changed.`); }
  };

  const setPassword = async (u) => {
    const res = await confirmDialog({
      title: `Set a temporary password for ${u.username}`,
      text: `${u.username} is signed out and must choose a new password at next sign-in. 12 to 256 characters.`,
      confirmLabel: 'Set password',
      field: { label: 'Temporary password', required: true, type: 'password' },
    });
    if (res) { await patch(u, { password: res.value }, `Temporary password set for ${u.username}.`); }
  };

  const toggleDisabled = async (u) => {
    if (!u.disabled) {
      const ok = await confirmDialog({ title: `Disable ${u.username}?`, text: STR.C28(u.username).text, confirmLabel: 'Disable', destructive: true });
      if (!ok) { return; }
    }
    await patch(u, { disabled: !u.disabled }, u.disabled ? `${u.username} enabled.` : `${u.username} disabled.`);
  };

  const addUser = async () => {
    const created = await openModal({
      title: 'Add user',
      build: (close) => {
        const username = field({ label: 'Username', hint: 'Lowercase letters, digits, dot, dash or underscore.', input: h('input', { type: 'text', maxlength: 32, autocomplete: 'off' }) });
        const display = field({ label: 'Name', input: h('input', { type: 'text', maxlength: 80, autocomplete: 'off' }) });
        const checks = roleChecks(allRoles, []);
        const pass = field({ label: 'Temporary password', hint: '12 to 256 characters. They choose their own at first sign-in.', input: h('input', { type: 'password', autocomplete: 'new-password' }) });
        const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
        const submit = async (e) => {
          e.preventDefault();
          err.hidden = true;
          const roles = checks.value();
          if (roles.length === 0) { err.textContent = 'Choose at least one role.'; err.hidden = false; return; }
          const body = { username: username.input.value.trim(), roles, password: pass.input.value };
          if (display.input.value.trim()) { body.displayName = display.input.value.trim(); }
          const resp = await app.api('POST', '/api/admin/users', body);
          if (!resp.ok) { err.textContent = serverMessage(resp); err.hidden = false; return; }
          close(resp.body.user);
        };
        return h('form', { class: 'dialog-body', on: { submit }, novalidate: true }, username.wrap, display.wrap, checks.el, pass.wrap, err,
          h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => close(null) } }, 'Cancel'),
            h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add user')));
      },
    });
    if (created) { toast(`${created.username} added.`, 'success'); await reload(); }
  };

  mount(view,
    h('div', { class: 'screen-header' }, h('h1', null, 'Users'), h('span', { class: 'header-spacer' }),
      h('button', { type: 'button', class: 'btn btn-primary', on: { click: addUser } }, '+ Add user')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('caption', null, `${users.length} user${users.length === 1 ? '' : 's'}`),
      h('thead', null, h('tr', null, ['User', 'Name', 'Roles', 'Status', 'Actions'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, users.map((u) => h('tr', null,
        h('th', { scope: 'row' }, u.username),
        h('td', null, u.displayName || '—'),
        h('td', null, u.roles.map((x) => [badge(ROLE_LABEL[x] || x, 'muted'), ' '])),
        h('td', { class: u.disabled ? 'muted' : null }, u.disabled ? 'Disabled' : u.mustChangePassword ? 'Must change password' : 'Active'),
        h('td', null, h('div', { class: 'inline-row' },
          h('button', { type: 'button', class: 'btn btn-secondary btn-small', on: { click: () => changeRoles(u) } }, 'Change roles…'),
          h('button', { type: 'button', class: 'btn btn-secondary btn-small', on: { click: () => setPassword(u) } }, 'Set temporary password…'),
          h('button', { type: 'button', class: ['btn', 'btn-small', u.disabled ? 'btn-secondary' : 'btn-danger'], on: { click: () => toggleDisabled(u) } }, u.disabled ? 'Enable' : 'Disable')))))))));
}
