// ─── /bootstrap — create the first admin with the one-time token ───

import { h, mount, field } from '../dom.js';
import { serverMessage } from '../strings.js';

/** Renders only while the server reports bootstrap is needed; otherwise goes to sign-in. */
export function render(app, _params, view) {
  app.setTitle('Create the first admin');
  if (!app.pre || !app.pre.bootstrapNeeded) { app.navigate('/login', { replace: true }); return; }

  const token = field({ label: 'Bootstrap token', hint: 'The MOAG_BOOTSTRAP_TOKEN value the server was started with.', input: h('input', { type: 'password', autocomplete: 'off', required: true }) });
  const user = field({ label: 'Username', hint: 'Lowercase letters, digits, dot, dash or underscore.', input: h('input', { type: 'text', autocomplete: 'username', required: true, maxlength: 32 }) });
  const pass = field({ label: 'Password', hint: '12 to 256 characters.', input: h('input', { type: 'password', autocomplete: 'new-password', required: true }) });
  const confirm = field({ label: 'Confirm', input: h('input', { type: 'password', autocomplete: 'new-password', required: true }) });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const submit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    confirm.setError('');
    if (pass.input.value !== confirm.input.value) { confirm.setError('The passwords do not match.'); confirm.input.focus(); return; }
    const username = user.input.value.trim();
    const r = await app.api('POST', '/api/bootstrap', { token: token.input.value, username, password: pass.input.value }, { pre: true, quiet: true });
    if (!r.ok) {
      err.textContent = r.status === 404 ? 'An admin already exists. Sign in instead.' : serverMessage(r);
      err.hidden = false;
      return;
    }
    const l = await app.login(username, pass.input.value);
    app.navigate(l.ok ? '/projects' : '/login');
  };

  mount(view, h('div', { class: 'auth-card' },
    h('h1', null, 'Create the first admin'),
    h('form', { on: { submit }, novalidate: true },
      token.wrap, user.wrap, pass.wrap, confirm.wrap, err,
      h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create admin')))));
  token.input.focus();
}
