// ─── Sign in, and the forced password change ───

import { h, mount, field } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

/** /login — the 360px sign-in card. Failure copy is identical whether or not the user exists (C23). */
export function renderLogin(app, _params, view) {
  app.setTitle('Sign in');
  const user = field({ label: 'Username', input: h('input', { type: 'text', autocomplete: 'username', required: true, autofocus: true }) });
  const pass = field({ label: 'Password', input: h('input', { type: 'password', autocomplete: 'current-password', required: true }) });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in');

  const submit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    submitBtn.disabled = true;
    const r = await app.login(user.input.value.trim(), pass.input.value);
    submitBtn.disabled = false;
    if (r.ok) {
      app.navigate(app.session && app.session.mustChangePassword ? '/me/password' : app.afterLoginPath());
      return;
    }
    pass.input.value = '';
    err.textContent = r.status === 429 ? STR.C24.text : r.status === 401 ? STR.C23.text : serverMessage(r);
    err.hidden = false;
    pass.input.focus();
  };

  mount(view, h('div', { class: 'auth-card' },
    h('h1', null, 'MOAG'),
    h('form', { on: { submit }, novalidate: true },
      user.wrap, pass.wrap, err,
      h('div', { class: 'form-actions' }, submitBtn)),
    app.pre && app.pre.bootstrapNeeded
      ? h('p', { class: 'muted' }, 'No admin exists yet. ', h('a', { href: '/bootstrap', dataset: { link: '' } }, 'Create the first admin'))
      : null));
  user.input.focus();
}

/** /me/password — required before anything else when an admin set a temporary password. */
export function renderChangePassword(app, _params, view) {
  app.setTitle('Change password');
  const forced = !!(app.session && app.session.mustChangePassword);
  const current = field({ label: forced ? 'Temporary password' : 'Current password', input: h('input', { type: 'password', autocomplete: 'current-password', required: true }) });
  const next = field({ label: 'New password', hint: '12 to 256 characters.', input: h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 12, maxlength: 256 }) });
  const confirm = field({ label: 'Confirm new password', input: h('input', { type: 'password', autocomplete: 'new-password', required: true }) });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const submit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    confirm.setError('');
    if (next.input.value !== confirm.input.value) { confirm.setError('The passwords do not match.'); confirm.input.focus(); return; }
    const r = await app.api('POST', '/api/me/password', { currentPassword: current.input.value, newPassword: next.input.value });
    if (!r.ok) {
      err.textContent = serverMessage(r);
      err.hidden = false;
      return;
    }
    await app.refreshSession();
    app.navigate('/projects');
  };

  mount(view, h('div', { class: 'auth-card' },
    h('h1', null, 'Change password'),
    forced ? h('p', null, 'An admin set a temporary password for you. Choose your own to continue.') : null,
    h('form', { on: { submit }, novalidate: true },
      current.wrap, next.wrap, confirm.wrap, err,
      h('div', { class: 'form-actions' },
        forced ? null : h('a', { href: '/projects', dataset: { link: '' }, class: 'btn btn-secondary' }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password')))));
  current.input.focus();
}
