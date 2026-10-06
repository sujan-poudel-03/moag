// ─── MOAG PO web app: shell, router, API client, live updates ───
//
// Vanilla ES modules, no build step. The server decides what each user may do:
// every resource it returns carries `allowedActions`, computed by the same
// predicate its route guards use, and this app renders a control only when its
// action is in that list. Nothing here is a security boundary — the server
// enforces every rule regardless of what is shown.

import { h, mount, clear, toast, openModal, field, glyph, badge, fmtAgo } from './dom.js';
import { STR, serverMessage } from './strings.js';
import * as loginScreen from './screens/login.js';
import * as bootstrapScreen from './screens/bootstrap.js';
import * as projectsScreen from './screens/projects.js';
import * as projectForm from './screens/project-form.js';
import * as prdScreen from './screens/prd.js';
import * as standardsScreen from './screens/standards.js';
import * as planScreen from './screens/plan.js';
import * as runScreen from './screens/run.js';
import * as traceScreen from './screens/trace.js';
import * as adminUsers from './screens/admin-users.js';
import * as adminAudit from './screens/admin-audit.js';
import * as adminEngines from './screens/admin-engines.js';

// ─── State ───

const app = {
  /** Signed-in session: { user, csrfToken, allowedActions, meta } or null. */
  session: null,
  /** Pre-auth state: { preAuthToken, bootstrapNeeded }. */
  pre: null,
  /** The project the current route belongs to (GET /api/projects/:id body), or null. */
  project: null,
  api,
  navigate,
  can,
  login,
  refreshSession,
  refreshProject,
  connectEvents,
  setTitle,
  afterLoginPath,
  rerender: () => route(),
};

/** Route table. `nav` marks the active rail entry; `project` routes load the project first. */
const ROUTES = [
  { path: '/login', public: true, render: loginScreen.renderLogin },
  { path: '/bootstrap', public: true, render: bootstrapScreen.render },
  { path: '/me/password', render: loginScreen.renderChangePassword },
  { path: '/projects', render: projectsScreen.render },
  { path: '/projects/new', render: projectForm.renderCreate },
  { path: '/p/:id', redirect: (p) => `/p/${p.id}/prd` },
  { path: '/p/:id/overview', redirect: (p) => `/p/${p.id}/prd` },
  { path: '/p/:id/prd', project: true, nav: 'prd', render: prdScreen.render },
  { path: '/p/:id/standards', project: true, nav: 'standards', render: standardsScreen.render },
  { path: '/p/:id/plan', project: true, nav: 'plan', render: planScreen.render },
  { path: '/p/:id/run', project: true, nav: 'run', render: runScreen.render },
  { path: '/p/:id/trace', project: true, nav: 'trace', render: traceScreen.render },
  { path: '/admin/users', nav: 'users', render: adminUsers.render },
  { path: '/admin/audit', nav: 'audit', render: adminAudit.render },
  { path: '/admin/engines', nav: 'engines', render: adminEngines.render },
  { path: '/p/:id/settings', project: true, nav: 'settings', render: projectForm.renderSettings },
];

const PROJECT_NAV = [
  { id: 'prd', label: 'PRD' },
  { id: 'standards', label: 'Standards' },
  { id: 'plan', label: 'Plan' },
  { id: 'run', label: 'Run' },
  { id: 'trace', label: 'Trace' },
  { id: 'settings', label: 'Settings' },
];

const ADMIN_NAV = [
  { id: 'users', label: 'Users', path: '/admin/users', action: 'users.manage' },
  { id: 'engines', label: 'Engines', path: '/admin/engines', action: 'engines.manage' },
  { id: 'audit', label: 'Audit log', path: '/admin/audit', action: 'audit.view' },
];

let cleanup = null;
let renderSeq = 0;
let reauthOpen = false;

// ─── API client ───

/**
 * Call the JSON API. Mutating requests carry the CSRF token (the session's, or
 * the pre-auth double-submit token with `{ pre: true }`). Never throws:
 * resolves `{ ok, status, body }`, with status 0 for a network failure.
 * 401 opens the re-login modal; 403 forbidden shows the C21 toast.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ pre?: boolean, quiet?: boolean }} [opts]
 */
async function api(method, path, body, opts = {}) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    const token = opts.pre ? app.pre && app.pre.preAuthToken : app.session && app.session.csrfToken;
    if (token) { headers['X-CSRF-Token'] = token; }
    init.body = JSON.stringify(body === undefined ? {} : body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, body: { error: 'network', message: 'The server could not be reached.' } };
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  const out = { ok: res.ok, status: res.status, body: data };
  if (!opts.quiet) {
    if (res.status === 401 && app.session) { promptReauth(); }
    else if (res.status === 403 && data.error === 'password-change-required') { navigate('/me/password'); }
    else if (res.status === 403 && data.error === 'forbidden') { toast(STR.C21.text, 'error'); }
  }
  return out;
}

/** May the signed-in user perform a session-level action (users.manage, project.create…)? */
function can(action) {
  return !!(app.session && Array.isArray(app.session.allowedActions) && app.session.allowedActions.includes(action));
}

/** Reload GET /api/session. Signed out: keeps the pre-auth token for login/bootstrap. */
async function refreshSession() {
  const r = await api('GET', '/api/session', undefined, { quiet: true });
  if (!r.ok) { return r; }
  if (r.body.user) {
    app.session = r.body;
    app.pre = null;
  } else {
    app.session = null;
    app.pre = { preAuthToken: r.body.preAuthToken, bootstrapNeeded: !!r.body.bootstrapNeeded };
  }
  return r;
}

/**
 * Sign in with the pre-auth double-submit flow. Resolves the login response;
 * on success the session is reloaded.
 */
async function login(username, password) {
  if (!app.pre || !app.pre.preAuthToken) { await refreshSession(); }
  const r = await api('POST', '/api/login', { username, password }, { pre: true, quiet: true });
  if (r.ok) { await refreshSession(); }
  else if (r.status === 403 && r.body.error === 'csrf') {
    // The pre-auth cookie expired or was replaced: fetch a fresh one and retry once.
    await refreshSession();
    const again = await api('POST', '/api/login', { username, password }, { pre: true, quiet: true });
    if (again.ok) { await refreshSession(); }
    return again;
  }
  return r;
}

/** Load the project for a project route; the rail and header read it. */
async function refreshProject(id) {
  const r = await api('GET', `/api/projects/${encodeURIComponent(id)}`);
  app.project = r.ok ? r.body : null;
  renderRail(currentNav);
  renderHeader();
  return r;
}

// ─── Re-login modal (C20) ───

function promptReauth() {
  if (reauthOpen) { return; }
  reauthOpen = true;
  const lastUser = app.session && app.session.user ? app.session.user.username : '';
  app.session = null;
  void openModal({
    title: 'Sign in again',
    initialFocus: 'input[type="password"]',
    build: (close) => {
      const user = field({ label: 'Username', input: h('input', { type: 'text', autocomplete: 'username', value: lastUser, required: true }) });
      const pass = field({ label: 'Password', input: h('input', { type: 'password', autocomplete: 'current-password', required: true }) });
      const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
      const submit = async (e) => {
        e.preventDefault();
        err.hidden = true;
        const r = await login(user.input.value.trim(), pass.input.value);
        if (r.ok) { close(true); return; }
        err.textContent = r.status === 429 ? STR.C24.text : r.status === 401 ? STR.C23.text : serverMessage(r);
        err.hidden = false;
      };
      return h('form', { class: 'dialog-body', on: { submit } },
        h('p', null, STR.C20.text), user.wrap, pass.wrap, err,
        h('div', { class: 'dialog-actions' },
          h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => close(false) } }, 'Go to sign-in page'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in')));
    },
  }).then((ok) => {
    reauthOpen = false;
    if (ok) { void route(); } else { navigate('/login'); }
  });
}

// ─── Router ───

function matchRoute(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  for (const r of ROUTES) {
    const ps = r.path.split('/').filter(Boolean);
    if (ps.length !== segs.length) { continue; }
    const params = {};
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].startsWith(':')) {
        let v;
        try { v = decodeURIComponent(segs[i]); } catch { ok = false; break; }
        if (!/^[A-Za-z0-9-]{1,64}$/.test(v)) { ok = false; break; }
        params[ps[i].slice(1)] = v;
      } else if (ps[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) { return { route: r, params }; }
  }
  return null;
}

/** Navigate within the app (History API). */
function navigate(path, opts = {}) {
  if (opts.replace) { history.replaceState(null, '', path); } else { history.pushState(null, '', path); }
  void route();
}

let currentNav = null;
let nextAfterLogin = null;

async function route() {
  const seq = ++renderSeq;
  if (cleanup) { try { cleanup(); } catch { /* screen teardown must not break navigation */ } cleanup = null; }
  const path = location.pathname;
  const user = app.session && app.session.user;

  if (path === '/' || path === '') { return navigate(user ? '/projects' : '/login', { replace: true }); }
  const match = matchRoute(path);
  if (match && match.route.redirect) { return navigate(match.route.redirect(match.params), { replace: true }); }

  if (!user && !(match && match.route.public)) {
    nextAfterLogin = path;
    return navigate(app.pre && app.pre.bootstrapNeeded ? '/bootstrap' : '/login', { replace: true });
  }
  if (user && app.session.mustChangePassword && path !== '/me/password') { return navigate('/me/password', { replace: true }); }
  if (user && match && match.route.public) { return navigate('/projects', { replace: true }); }

  currentNav = match ? match.route.nav || null : null;
  const main = document.getElementById('main');
  const view = h('div', { class: 'screen' });
  mount(main, view);

  if (match && match.route.project) {
    if (!app.project || !app.project.project || app.project.project.id !== match.params.id) { app.project = null; }
    const r = await refreshProject(match.params.id);
    if (seq !== renderSeq) { return; }
    if (!r.ok) {
      mount(view, r.status === 404 ? notFoundView() : h('div', { class: ['card', 'card-error'], role: 'alert' }, glyph('✗'), ` Couldn't load the project. ${serverMessage(r)}`));
      return;
    }
  } else {
    app.project = null;
  }
  renderHeader();
  renderRail(currentNav);

  if (!match) { mount(view, notFoundView()); setTitle('Not found'); return; }
  try {
    const result = await match.route.render(app, match.params, view);
    if (seq !== renderSeq) { if (typeof result === 'function') { result(); } return; }
    cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    mount(view, h('div', { class: ['card', 'card-error'], role: 'alert' }, glyph('✗'), ' This screen failed to load. Reload the page to try again.'));
    console.error(err);
  }
}

/** Where to go after a successful sign-in. */
function afterLoginPath() {
  const p = nextAfterLogin;
  nextAfterLogin = null;
  return p && p !== '/login' && p !== '/bootstrap' ? p : '/projects';
}

function notFoundView() {
  return h('div', { class: 'card' },
    h('h1', null, 'Not found'),
    h('p', null, 'This page does not exist. '),
    h('a', { href: '/projects', dataset: { link: '' } }, 'Back to projects'));
}

function setTitle(t) {
  document.title = t ? `${t} · MOAG` : 'MOAG';
}

// ─── Shell ───

const conn = { state: 'idle', lastUpdate: null, retry: null };

function renderHeader() {
  const header = document.getElementById('app-header');
  if (!header) { return; }
  const user = app.session && app.session.user;
  const project = app.project && app.project.project;
  mount(header,
    h('a', { class: 'brand', href: user ? '/projects' : '/login', dataset: { link: '' } }, 'MOAG'),
    project ? h('span', { class: 'header-project' }, project.name) : null,
    h('span', { class: 'header-spacer' }),
    connectionIndicator(),
    user ? h('div', { class: 'header-user' },
      h('span', { class: 'header-username' }, user.displayName || user.username),
      user.roles.map((r) => badge(r.toUpperCase(), 'muted')),
      h('a', { href: '/me/password', dataset: { link: '' }, class: 'header-link' }, 'Password'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', on: { click: logout } }, 'Sign out')) : null);
}

function connectionIndicator() {
  if (conn.state === 'idle') { return null; }
  if (conn.state === 'live') { return h('span', { class: 'conn conn-live', role: 'status' }, glyph('●'), ' Live'); }
  if (conn.state === 'reconnecting') { return h('span', { class: 'conn conn-reconnecting', role: 'status' }, glyph('◌'), ' Reconnecting…'); }
  return h('span', { class: 'conn conn-paused', role: 'status' }, glyph('✗'),
    ` Updates paused${conn.lastUpdate ? `, last update ${fmtAgo(conn.lastUpdate)}` : ''} `,
    conn.retry ? h('button', { type: 'button', class: 'btn btn-secondary btn-small', on: { click: conn.retry } }, 'Retry') : null);
}

function setConnection(state, retry) {
  conn.state = state;
  if (state === 'live') { conn.lastUpdate = new Date().toISOString(); }
  conn.retry = retry || null;
  renderHeader();
}

function renderRail(active) {
  const rail = document.getElementById('app-rail');
  if (!rail) { return; }
  const user = app.session && app.session.user;
  if (!user) { clear(rail); rail.hidden = true; return; }
  rail.hidden = false;
  const project = app.project && app.project.project;
  const pendingPlans = app.project && Array.isArray(app.project.plans) ? app.project.plans.filter((p) => p.status === 'pending').length : 0;
  const lastRun = app.project && Array.isArray(app.project.runs) && app.project.runs.length > 0 ? app.project.runs[app.project.runs.length - 1] : null;
  const adminItems = ADMIN_NAV.filter((n) => can(n.action));
  const navLink = (label, path, isActive, extra) => h('a', {
    href: path, dataset: { link: '' }, class: ['rail-link', isActive ? 'active' : ''], 'aria-current': isActive ? 'page' : null,
  }, h('span', null, label), extra || null);
  mount(rail,
    h('a', { href: '/projects', dataset: { link: '' }, class: 'rail-link' }, 'All projects'),
    project ? h('nav', { 'aria-label': 'Project' },
      h('p', { class: 'section-header' }, 'Project'),
      PROJECT_NAV.map((n) => {
        let extra = null;
        // A standards version is waiting for a reviewer (the server's answer, never a client guess).
        if (n.id === 'standards' && project.standards && project.standards.pendingVersion) { extra = badge('REVIEW', 'warning'); }
        if (n.id === 'plan' && pendingPlans > 0) { extra = badge(String(pendingPlans), 'warning'); }
        if (n.id === 'run' && lastRun) {
          if (lastRun.status === 'running') { extra = h('span', { class: 'rail-glyph' }, glyph('⟳'), h('span', { class: 'sr-only' }, 'running')); }
          else if (lastRun.status === 'awaiting-approval') { extra = badge('GATE', 'warning'); }
        }
        return navLink(n.label, `/p/${project.id}/${n.id}`, active === n.id, extra);
      })) : null,
    adminItems.length > 0 ? h('nav', { 'aria-label': 'Admin' },
      h('p', { class: 'section-header' }, 'Admin'),
      adminItems.map((n) => navLink(n.label, n.path, active === n.id))) : null);
}

async function logout() {
  await api('POST', '/api/logout', {}, { quiet: true });
  app.session = null;
  app.project = null;
  await refreshSession();
  navigate('/login');
}

// ─── Live updates (SSE) ───

/**
 * Subscribe to a project's live job events. The header indicator shows
 * Live / Reconnecting / Updates paused (with Retry). Returns a disposer.
 * @param {string} projectId
 * @param {{ snapshot?: (d: object) => void, event?: (d: object) => void, end?: (d: object) => void }} handlers
 */
function connectEvents(projectId, handlers) {
  let es = null;
  let closed = false;
  const parse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
  const open = () => {
    if (es) { es.close(); }
    es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
    setConnection('reconnecting');
    es.addEventListener('open', () => setConnection('live'));
    es.addEventListener('snapshot', (e) => { const d = parse(e); setConnection('live'); if (d && handlers.snapshot) { handlers.snapshot(d); } });
    es.addEventListener('job-event', (e) => { const d = parse(e); conn.lastUpdate = new Date().toISOString(); if (d && handlers.event) { handlers.event(d); } });
    es.addEventListener('job-end', (e) => { const d = parse(e); conn.lastUpdate = new Date().toISOString(); if (d && handlers.end) { handlers.end(d); } });
    // The server ended this stream because the session was revoked or expired:
    // stop auto-reconnecting (it would only get 401s) and ask to sign in again.
    es.addEventListener('session-ended', () => {
      es.close();
      setConnection('paused', () => open());
      if (app.session) { promptReauth(); }
    });
    es.addEventListener('error', () => {
      if (closed) { return; }
      if (es.readyState === EventSource.CLOSED) { setConnection('paused', () => open()); }
      else { setConnection('reconnecting'); }
    });
  };
  open();
  return () => {
    closed = true;
    if (es) { es.close(); }
    setConnection('idle');
  };
}

// ─── Boot ───

document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[data-link]') : null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { return; }
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/')) { return; }
  e.preventDefault();
  navigate(href);
});

window.addEventListener('popstate', () => { void route(); });

async function boot() {
  const r = await refreshSession();
  if (!r.ok) {
    mount(document.getElementById('main'), h('div', { class: ['card', 'card-error'], role: 'alert' },
      glyph('✗'), ' Couldn\'t reach the MOAG server. ',
      h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => { void boot(); } } }, 'Retry')));
    return;
  }
  await route();
}

void boot();
