// ─── Hosted server HTTP app: auth, CSRF, validation, plans, runs, ship gate ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import {
  startHarness, Harness, waitFor, approvedProject, planWorker, gatedPlaylist, PRD_V1, PASSWORD, FakeWorker,
} from './app-harness';
import { loadPlan, dehydratePlan } from '../../../models/plan';
import { recordGateResults } from '../../../models/requirement-trace';
import { TaskStatus } from '../../../models/types';
import { PROJECTS_FILE } from '../../../server/projects';
import { recommendStack } from '../../../server/stack-recommendation';
import { OutcomeStore } from '../../../server/outcomes';
import { SecretStore } from '../../../server/secrets';
import { referencedEngines } from '../../../server/run-env';
import { PlanJob } from '../../../server/worker-protocol';
import { contentHash } from '../../../server/prd-ops';

describe('server app', function () {
  this.timeout(20000);
  let h: Harness;

  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  async function newProject(as = 'po'): Promise<string> {
    const r = await h.request('POST', '/api/projects', {
      as, body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: 'claude' },
    });
    assert.equal(r.status, 201, r.raw);
    return (r.body.project as { id: string }).id;
  }

  // ─── Basics ───

  it('GET /healthz is public and carries the security headers', async () => {
    const r = await h.request('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('GET /api/session carries per-role allowedActions and the server enumerations', async () => {
    const expected: Record<string, string[]> = {
      po: ['project.create'],
      reviewer: [],
      approver: [],
      admin: ['project.create', 'users.manage', 'audit.view', 'engines.manage'],
    };
    for (const [who, actions] of Object.entries(expected)) {
      const r = await h.request('GET', '/api/session', { as: who });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.allowedActions, actions, who);
      const meta = r.body.meta as Record<string, string[]>;
      assert.ok(!meta.engines.includes('custom') && !meta.engines.includes('copilot'), 'unsupported engines are not offered');
      assert.deepEqual(meta.unsupportedEngines, ['custom', 'copilot']);
      assert.deepEqual(meta.bumps, ['patch', 'minor', 'major']);
      assert.ok(meta.stacks.includes('node-ts') && meta.roles.includes('approver'));
    }
    const anon = await h.request('GET', '/api/session');
    assert.equal(anon.body.user, null);
    assert.equal(anon.body.allowedActions, undefined, 'no actions without a session');
    assert.equal(anon.body.meta, undefined);
  });

  it('GET /api/projects lists project.create only for product owners and admins', async () => {
    for (const [who, can] of [['po', true], ['reviewer', false], ['approver', false], ['admin', true]] as const) {
      const r = await h.request('GET', '/api/projects', { as: who });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.allowedActions, can ? ['project.create'] : [], who);
    }
  });

  it('a session route without a session is 401', async () => {
    assert.equal((await h.request('GET', '/api/projects')).status, 401);
    assert.equal((await h.request('GET', '/api/projects', { cookie: 'moag_sid=forged' })).status, 401);
  });

  it('a 500 carries no stack trace', async () => {
    const id = await newProject();
    fs.mkdirSync(path.join(h.dataDir, 'projects', id), { recursive: true });
    fs.writeFileSync(path.join(h.dataDir, 'projects', id, 'state.json'), '{"schemaVersion":99}');
    const r = await h.request('GET', `/api/projects/${id}`, { as: 'po' });
    assert.equal(r.status, 500);
    assert.deepEqual(Object.keys(r.body).sort(), ['error', 'message']);
    assert.equal(r.raw.includes('at '), false);
    assert.equal(r.raw.includes('state.json'), false);
  });

  // ─── CSRF / Origin / content type ───

  it('CSRF: one mutating endpoint per role is 403 without a valid token, with no side effects', async () => {
    const id = await newProject();
    const before = h.auditEntries().length;
    const cases: Array<[string, string, string, unknown]> = [
      ['po', 'POST', `/api/projects/${id}/prd/versions`, { text: PRD_V1, baseCreatedAt: null }],
      ['reviewer', 'POST', `/api/projects/${id}/plans/x/approve`, { contentHash: 'a'.repeat(64) }],
      ['approver', 'POST', `/api/projects/${id}/runs/x/gate/approve`, {}],
      ['admin', 'POST', '/api/admin/users', { username: 'eve', roles: ['admin'], password: PASSWORD }],
    ];
    for (const [as, method, p, body] of cases) {
      const missing = await h.request(method, p, { as, body, csrf: false });
      assert.equal(missing.status, 403, `${as} missing token`);
      assert.equal(missing.body.error, 'csrf');
      const wrong = await h.request(method, p, { as, body, csrf: 'not-the-token' });
      assert.equal(wrong.status, 403, `${as} wrong token`);
      const otherUsers = await h.request(method, p, { as, body, csrf: h.tokens[as === 'po' ? 'admin' : 'po'].csrfToken });
      assert.equal(otherUsers.status, 403, `${as} another session's token`);
    }
    assert.equal(h.auditEntries().length, before);
    assert.equal(h.users.findByUsername('eve'), undefined);
    assert.equal(h.state.loadCanonicalPlan(id, 'Acme').prdVersions, undefined);
  });

  it('refuses a cross-origin mutating request and a non-JSON body', async () => {
    const r = await h.request('POST', '/api/projects', { as: 'po', body: {}, headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'bad-origin');
    const form = await h.request('POST', '/api/projects', { as: 'po', body: 'name=x', contentType: 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
  });

  // ─── Login, sessions, rate limit ───

  async function preAuth(): Promise<{ cookie: string; token: string }> {
    const r = await h.request('GET', '/api/session');
    const set = String((r.headers['set-cookie'] ?? [])[0]);
    return { cookie: set.split(';')[0], token: String(r.body.preAuthToken) };
  }

  it('login sets an HttpOnly SameSite=Lax session cookie and the session works', async () => {
    const pre = await preAuth();
    const r = await h.request('POST', '/api/login', { body: { username: 'po', password: PASSWORD }, cookie: pre.cookie, csrf: pre.token });
    assert.equal(r.status, 200, r.raw);
    const cookie = String((r.headers['set-cookie'] ?? [])[0]);
    assert.match(cookie, /^moag_sid=[A-Za-z0-9_-]{43};/);
    for (const f of ['HttpOnly', 'SameSite=Lax', 'Path=/']) { assert.ok(cookie.includes(f), f); }
    assert.equal(cookie.includes('Secure'), false, 'http public URL');
    const me = await h.request('GET', '/api/session', { cookie: cookie.split(';')[0] });
    assert.equal((me.body.user as { username: string }).username, 'po');
    assert.equal(typeof me.body.csrfToken, 'string');
    assert.ok(h.auditEntries().some((e) => e.action === 'login.success' && e.actorUsername === 'po'));
  });

  it('login needs the pre-auth double-submit token', async () => {
    const pre = await preAuth();
    const r = await h.request('POST', '/api/login', { body: { username: 'po', password: PASSWORD }, cookie: pre.cookie, csrf: false });
    assert.equal(r.status, 403);
    const r2 = await h.request('POST', '/api/login', { body: { username: 'po', password: PASSWORD }, csrf: pre.token });
    assert.equal(r2.status, 403, 'header without the matching cookie');
  });

  it('a failed login is generic, audited with no actor and the account as target only when it exists', async () => {
    const pre = await preAuth();
    const bad = await h.request('POST', '/api/login', { body: { username: 'po', password: 'wrong-password-xx' }, cookie: pre.cookie, csrf: pre.token });
    const ghost = await h.request('POST', '/api/login', { body: { username: 'ghost', password: 'wrong-password-xx' }, cookie: pre.cookie, csrf: pre.token });
    assert.equal(bad.status, 401);
    assert.equal(ghost.status, 401);
    assert.equal(bad.body.message, ghost.body.message);
    const fails = h.auditEntries().filter((e) => e.action === 'login.failure');
    assert.equal(fails.length, 2);
    assert.deepEqual(fails.map((e) => [e.actorUserId, e.actorUsername]), [['', ''], ['', '']], 'no actor: nobody is signed in');
    assert.equal(fails[0].target, 'po', 'the attempted account is the target');
    assert.equal(fails[1].target, '(unknown account)');
    assert.equal(h.auditEntries().filter((e) => e.actorUsername === 'po').length, 0, "a stranger's guess is not attributed to the account");
    assert.equal(JSON.stringify(fails).includes('ghost'), false);
    assert.equal(fs.readFileSync(path.join(h.dataDir, 'audit.jsonl'), 'utf-8').includes('wrong-password-xx'), false);
  });

  it('the 6th failed login is 429 without calling verifyPassword', async () => {
    const pre = await preAuth();
    const attempt = () => h.request('POST', '/api/login', { body: { username: 'po', password: 'nope-nope-nope' }, cookie: pre.cookie, csrf: pre.token });
    for (let i = 0; i < 5; i++) { assert.equal((await attempt()).status, 401); }
    const calls = h.verifyCalls();
    const r = await attempt();
    assert.equal(r.status, 429);
    assert.equal(h.verifyCalls(), calls, 'password not checked while locked');
    const good = await h.request('POST', '/api/login', { body: { username: 'po', password: PASSWORD }, cookie: pre.cookie, csrf: pre.token });
    assert.equal(good.status, 429, 'even the right password is refused while locked');
  });

  it('concurrent wrong logins cannot outrun the limit: verify runs at most 5 times, the rest are 429', async () => {
    const pre = await preAuth();
    const before = h.verifyCalls();
    const burst = await Promise.all(Array.from({ length: 12 }, () =>
      h.request('POST', '/api/login', { body: { username: 'po', password: 'nope-nope-nope' }, cookie: pre.cookie, csrf: pre.token })));
    const statuses = burst.map((r) => r.status);
    assert.ok(h.verifyCalls() - before <= 5, `verify ran ${h.verifyCalls() - before} times`);
    assert.equal(statuses.filter((s) => s === 401).length, 5);
    assert.equal(statuses.filter((s) => s === 429).length, 7);
    const good = await h.request('POST', '/api/login', { body: { username: 'po', password: PASSWORD }, cookie: pre.cookie, csrf: pre.token });
    assert.equal(good.status, 429, 'the account is locked after the burst');
  });

  it('login is 503 without verifying or counting a failure when the scrypt queue is full', async () => {
    let saturated = true;
    const hx = await startHarness({ scryptSaturated: () => saturated });
    try {
      const s = await hx.request('GET', '/api/session');
      const pre = { cookie: String((s.headers['set-cookie'] ?? [])[0]).split(';')[0], token: String(s.body.preAuthToken) };
      const attempt = (password: string) => hx.request('POST', '/api/login', { body: { username: 'po', password }, cookie: pre.cookie, csrf: pre.token });
      for (let i = 0; i < 8; i++) {
        const r = await attempt('nope-nope-nope');
        assert.equal(r.status, 503);
        assert.equal(r.body.error, 'busy');
      }
      assert.equal(hx.verifyCalls(), 0);
      saturated = false;
      assert.equal((await attempt(PASSWORD)).status, 200, 'busy refusals did not count toward the lock');
    } finally { await hx.close(); }
  });

  it('logout invalidates the session server-side (next request 401)', async () => {
    const r = await h.request('POST', '/api/logout', { as: 'reviewer', body: {} });
    assert.equal(r.status, 200);
    assert.match(String((r.headers['set-cookie'] ?? [])[0]), /Max-Age=0/);
    assert.equal((await h.request('GET', '/api/projects', { as: 'reviewer' })).status, 401);
  });

  it('a role change invalidates the target user\'s sessions (next request 401)', async () => {
    const r = await h.request('PATCH', `/api/admin/users/${h.accounts.reviewer.id}`, { as: 'admin', body: { roles: ['approver'] } });
    assert.equal(r.status, 200, r.raw);
    assert.equal((await h.request('GET', '/api/projects', { as: 'reviewer' })).status, 401);
    const audit = h.auditEntries().filter((e) => e.action === 'user.role-change');
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].before, { roles: ['reviewer'] });
    assert.deepEqual(audit[0].after, { roles: ['approver'] });
  });

  it('PATCH users: the last-admin guard is 409', async () => {
    const r = await h.request('PATCH', `/api/admin/users/${h.accounts.admin.id}`, { as: 'admin', body: { roles: ['reviewer'] } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'last-admin');
    const d = await h.request('PATCH', `/api/admin/users/${h.accounts.admin.id}`, { as: 'admin', body: { disabled: true } });
    assert.equal(d.status, 409);
  });

  it('an admin-created user must change their password before anything else', async () => {
    const c = await h.request('POST', '/api/admin/users', { as: 'admin', body: { username: 'newbie', roles: ['product-owner'], password: 'Temporary-Pass-123' } });
    assert.equal(c.status, 201, c.raw);
    h.login('newbie');
    assert.equal((await h.request('GET', '/api/projects', { as: 'newbie' })).status, 403);
    assert.equal((await h.request('GET', '/api/session', { as: 'newbie' })).status, 200);
    const ch = await h.request('POST', '/api/me/password', { as: 'newbie', body: { currentPassword: 'Temporary-Pass-123', newPassword: 'My-Own-Password-456' } });
    assert.equal(ch.status, 200, ch.raw);
    const cookie = String((ch.headers['set-cookie'] ?? [])[0]).split(';')[0];
    const ok = await h.request('GET', '/api/projects', { cookie });
    assert.equal(ok.status, 200);
    const raw = fs.readFileSync(path.join(h.dataDir, 'audit.jsonl'), 'utf-8');
    assert.equal(raw.includes('Temporary-Pass-123') || raw.includes('My-Own-Password-456'), false);
  });

  it('bootstrap is 404 once an admin exists', async () => {
    const pre = await preAuth();
    const r = await h.request('POST', '/api/bootstrap', { body: { token: 'x'.repeat(30), username: 'root', password: PASSWORD }, cookie: pre.cookie, csrf: pre.token });
    assert.equal(r.status, 404);
    assert.deepEqual((await h.request('GET', '/api/bootstrap/status')).body, { needed: false });
  });

  it('bootstrap creates the first admin once, with the token, and is audited', async () => {
    const token = 'b'.repeat(30);
    const fresh = await startHarness({ accounts: {}, config: { bootstrapToken: token } });
    try {
      assert.deepEqual((await fresh.request('GET', '/api/bootstrap/status')).body, { needed: true });
      const s = await fresh.request('GET', '/api/session');
      const cookie = String((s.headers['set-cookie'] ?? [])[0]).split(';')[0];
      const pre = String(s.body.preAuthToken);
      const send = (body: unknown, csrf: string | false = pre) => fresh.request('POST', '/api/bootstrap', { body, cookie, csrf });
      assert.equal((await send({ token, username: 'root', password: PASSWORD }, false)).status, 403, 'pre-auth CSRF');
      assert.equal((await send({ token: 'w'.repeat(30), username: 'root', password: PASSWORD })).status, 403);
      assert.equal((await send({ token, username: 'root', password: 'short' })).status, 400);
      const ok = await send({ token, username: 'root', password: PASSWORD });
      assert.equal(ok.status, 201, ok.raw);
      assert.deepEqual((ok.body.user as { roles: string[] }).roles, ['admin']);
      assert.equal((await send({ token, username: 'root2', password: PASSWORD })).status, 404);
      assert.deepEqual((await fresh.request('GET', '/api/bootstrap/status')).body, { needed: false });
      const raw = fs.readFileSync(path.join(fresh.dataDir, 'audit.jsonl'), 'utf-8');
      assert.equal(raw.includes(token), false);
      assert.equal(fresh.auditEntries().filter((e) => e.action === 'user.create').length, 1);
    } finally { await fresh.close(); }
  });

  it('bootstrap: wrong tokens lock the IP (even for the right token next); a right token with a weak password is not a guess', async () => {
    const token = 'b'.repeat(30);
    const fresh = await startHarness({ accounts: {}, config: { bootstrapToken: token } });
    try {
      const s = await fresh.request('GET', '/api/session');
      const cookie = String((s.headers['set-cookie'] ?? [])[0]).split(';')[0];
      const pre = String(s.body.preAuthToken);
      const send = (body: unknown) => fresh.request('POST', '/api/bootstrap', { body, cookie, csrf: pre });
      for (let i = 0; i < 6; i++) {
        assert.equal((await send({ token, username: 'root', password: 'short' })).status, 400, 'weak password: not counted');
      }
      const wrong = await Promise.all(Array.from({ length: 6 }, () => send({ token: 'w'.repeat(30), username: 'root', password: PASSWORD })));
      assert.deepEqual(wrong.map((r) => r.status).sort(), [403, 403, 403, 403, 403, 429]);
      const locked = await send({ token, username: 'root', password: PASSWORD });
      assert.equal(locked.status, 429, 'locked before the token is even compared');
      assert.ok(Number(locked.body.retryAfterSec) > 0);
      assert.equal(fresh.users.list().length, 0);
    } finally { await fresh.close(); }
  });

  it('POST /api/me/password: wrong current passwords are limited per user; the lock refuses before scrypt and spares other users', async () => {
    const wrong = { currentPassword: 'Not-The-Password-1', newPassword: 'My-Own-Password-456' };
    const results = await Promise.all(Array.from({ length: 7 }, () => h.request('POST', '/api/me/password', { as: 'po', body: wrong })));
    assert.deepEqual(results.map((r) => r.status).sort(), [403, 403, 403, 403, 403, 429, 429], 'five verdicts, then refused');
    const before = h.verifyCalls();
    const right = await h.request('POST', '/api/me/password', { as: 'po', body: { currentPassword: PASSWORD, newPassword: 'My-Own-Password-456' } });
    assert.equal(right.status, 429, 'even the right password is refused while locked');
    assert.equal(h.verifyCalls(), before, 'no scrypt run while locked');
    // Another user is unaffected.
    const other = await h.request('POST', '/api/me/password', { as: 'reviewer', body: { currentPassword: PASSWORD, newPassword: 'My-Own-Password-456' } });
    assert.equal(other.status, 200, other.raw);
    assert.equal(h.auditEntries().filter((e) => e.action === 'user.password-set').length, 1);
  });

  it('POST /api/me/password is 503 when scrypt is saturated, with no attempt counted', async () => {
    const hx = await startHarness({ scryptSaturated: () => true });
    try {
      const r = await hx.request('POST', '/api/me/password', { as: 'po', body: { currentPassword: PASSWORD, newPassword: 'My-Own-Password-456' } });
      assert.equal(r.status, 503);
      assert.equal(hx.verifyCalls(), 0);
    } finally { await hx.close(); }
  });

  // ─── Validation ───

  it('invalid engine, bump or stack is 400 with no audit line and no file change', async () => {
    const id = await newProject();
    const projectsFile = path.join(h.dataDir, PROJECTS_FILE);
    const projBefore = fs.readFileSync(projectsFile, 'utf-8');
    const auditBefore = h.auditEntries().length;
    const bad: Array<[string, string, unknown]> = [
      ['PATCH', `/api/projects/${id}`, { defaultEngine: 'rm -rf /' }],
      ['PATCH', `/api/projects/${id}`, { stack: 'rust' }],
      ['PATCH', `/api/projects/${id}`, { stack: 'go', extra: 1 }],
      ['POST', '/api/projects', { name: 'X', source: { kind: 'path', path: 'other' }, stack: 'cobol', defaultEngine: 'claude' }],
      ['POST', '/api/projects', { name: 'X', source: { kind: 'path', path: 'other' }, stack: 'go', defaultEngine: 'skynet' }],
      ['POST', '/api/projects', { name: 'X', source: { kind: 'shell', cmd: 'id' }, stack: 'go', defaultEngine: 'claude' }],
      ['POST', `/api/projects/${id}/prd/versions/latest/bump`, { bump: 'huge', expectedCreatedAt: 'x' }],
    ];
    for (const [m, p, body] of bad) {
      const r = await h.request(m, p, { as: 'po', body });
      assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(body)} → ${r.raw}`);
    }
    assert.equal(fs.readFileSync(projectsFile, 'utf-8'), projBefore);
    assert.equal(h.auditEntries().length, auditBefore);
    assert.equal(h.projects.list().length, 1);
  });

  it('custom/copilot cannot be a project engine', async () => {
    const r = await h.request('POST', '/api/projects', { as: 'po', body: { name: 'X', source: { kind: 'path', path: 'other' }, stack: 'go', defaultEngine: 'custom' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'engine-not-supported');
  });

  it('project paths escaping the root are rejected', async () => {
    const r = await h.request('POST', '/api/projects', { as: 'po', body: { name: 'X', source: { kind: 'path', path: '../data' }, stack: 'go', defaultEngine: 'claude' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid-path');
  });

  // ─── PRD ───

  it('PRD save: 201 with diff and recommendation; 409 stale; 409 no-change; 422 duplicate ids; audited once', async () => {
    const id = await newProject();
    const s1 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    assert.equal(s1.status, 201, s1.raw);
    const v1 = s1.body.version as { createdAt: string; label: string };
    assert.equal(v1.label, 'v1.0.0');
    const stale = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1 + '- more\n', baseCreatedAt: null } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'stale-base');
    const same = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: String(s1.body.text), baseCreatedAt: v1.createdAt } });
    assert.equal(same.status, 409);
    assert.equal(same.body.error, 'no-change');
    const dup = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: '## Requirements\n- [R-1] a\n- [R-1] b\n', baseCreatedAt: v1.createdAt } });
    assert.equal(dup.status, 422);
    assert.ok(Array.isArray(dup.body.errors));
    const v2 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: String(s1.body.text) + '- Users can export orders as CSV\n', baseCreatedAt: v1.createdAt } });
    assert.equal(v2.status, 201, v2.raw);
    assert.equal((v2.body.recommendation as { bump: string }).bump, 'minor');
    assert.equal(h.auditEntries().filter((e) => e.action === 'prd.version-save').length, 2);
  });

  it('bump override is audited with recommended vs chosen and locked once a plan is requested', async () => {
    const id = await newProject();
    const s1 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const v1 = s1.body.version as { createdAt: string };
    await new Promise((r) => setTimeout(r, 3));
    const s2 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: String(s1.body.text) + '- CSV export\n', baseCreatedAt: v1.createdAt } });
    const v2 = s2.body.version as { createdAt: string };
    const o = await h.request('POST', `/api/projects/${id}/prd/versions/latest/bump`, { as: 'po', body: { bump: 'major', expectedCreatedAt: v2.createdAt } });
    assert.equal(o.status, 200, o.raw);
    const e = h.auditEntries().filter((x) => x.action === 'prd.bump-override');
    assert.equal(e.length, 1);
    assert.deepEqual(e[0].before, { version: '1.1.0', chosenBump: 'minor' });
    assert.deepEqual(e[0].after, { version: '2.0.0', chosenBump: 'major', recommended: 'minor' });

    h.onSpawn = () => { /* keep generating */ };
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'delta' } });
    assert.equal(g.status, 202, g.raw);
    const locked = await h.request('POST', `/api/projects/${id}/prd/versions/latest/bump`, { as: 'po', body: { bump: 'minor', expectedCreatedAt: v2.createdAt } });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error, 'locked');
  });

  // ─── PRD DTO (S2-T3) ───

  async function prdDto(id: string, as: string): Promise<Record<string, unknown>> {
    const r = await h.request('GET', `/api/projects/${id}/prd`, { as });
    assert.equal(r.status, 200, r.raw);
    return r.body;
  }
  const actionsOf = (b: Record<string, unknown>): string[] => [...(b.allowedActions as string[])].sort();

  it('PRD DTO allowedActions follow role and state: none → v1 → v2 with a delta', async () => {
    const id = await newProject();
    assert.deepEqual(actionsOf(await prdDto(id, 'po')), ['prd.save']);
    for (const who of ['reviewer', 'approver', 'admin']) { assert.deepEqual(actionsOf(await prdDto(id, who)), [], who); }

    const s1 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const v1 = s1.body.version as { createdAt: string };
    const d1 = await prdDto(id, 'po');
    assert.deepEqual(actionsOf(d1), ['plan.generate-initial', 'prd.save'], 'first version: initial plan, no override, no delta');
    const first = (d1.versions as Array<Record<string, unknown>>)[0];
    assert.equal(first.diff, null);
    assert.equal(first.rationale, null);
    assert.equal((first.savedBy as { by: string }).by, 'po');
    assert.deepEqual(d1.bumps, ['patch', 'minor', 'major']);
    assert.equal(d1.engine, 'claude');
    for (const who of ['reviewer', 'approver', 'admin']) { assert.deepEqual(actionsOf(await prdDto(id, who)), [], who); }

    await new Promise((r) => setTimeout(r, 3));
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: String(s1.body.text) + '- CSV export\n', baseCreatedAt: v1.createdAt } });
    const d2 = await prdDto(id, 'po');
    assert.deepEqual(actionsOf(d2), ['plan.generate', 'prd.bump-override', 'prd.save']);
    const second = (d2.versions as Array<Record<string, unknown>>)[1];
    const diff = second.diff as { added: Array<{ id: string }>; changed: unknown[]; removed: unknown[]; unchangedCount: number };
    assert.equal(diff.added.length, 1);
    assert.equal(diff.unchangedCount, 2);
    assert.equal(second.recommendedBump, 'minor');
    assert.match(String(second.rationale), new RegExp(diff.added[0].id));
    assert.ok(d2.deltaScope);
    for (const who of ['reviewer', 'approver', 'admin']) { assert.deepEqual(actionsOf(await prdDto(id, who)), [], who); }
  });

  it('PRD DTO: once a plan is requested the override and generate actions disappear, and the override is refused', async () => {
    const id = await newProject();
    const s1 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    await new Promise((r) => setTimeout(r, 3));
    const s2 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: String(s1.body.text) + '- CSV export\n', baseCreatedAt: (s1.body.version as { createdAt: string }).createdAt } });
    const v2 = s2.body.version as { createdAt: string };
    const o = await h.request('POST', `/api/projects/${id}/prd/versions/latest/bump`, { as: 'po', body: { bump: 'major', expectedCreatedAt: v2.createdAt } });
    assert.equal(o.status, 200, o.raw);
    const afterOverride = await prdDto(id, 'po');
    const latest = (afterOverride.versions as Array<Record<string, unknown>>)[1];
    assert.equal(latest.label, 'v2.0.0');
    assert.equal((latest.override as { by: string }).by, 'po', 'override attribution comes from the audit log');

    h.onSpawn = () => { /* keep generating */ };
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'delta' } });
    assert.equal(g.status, 202, g.raw);
    const d = await prdDto(id, 'po');
    assert.deepEqual(actionsOf(d), ['prd.save']);
    assert.equal(d.overrideLocked, true);
    assert.equal((d.openPlan as { status: string }).status, 'generating');
    const refused = await h.request('POST', `/api/projects/${id}/prd/versions/latest/bump`, { as: 'po', body: { bump: 'minor', expectedCreatedAt: v2.createdAt } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'locked');
    const again = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'delta' } });
    assert.equal(again.status, 409, 'a second request for the same version is refused, matching the hidden control');
  });

  it('initial plan: only at exactly one version; a removed-only version offers no delta plan', async () => {
    const id = await newProject();
    const none = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    assert.equal(none.status, 409);
    const s1 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    await new Promise((r) => setTimeout(r, 3));
    // Drop the second requirement: removed-only, so describeDeltaScope is null.
    const removedOnly = String(s1.body.text).split('\n').filter((l) => !/Stripe/.test(l)).join('\n');
    const s2 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: removedOnly, baseCreatedAt: (s1.body.version as { createdAt: string }).createdAt } });
    assert.equal(s2.status, 201, s2.raw);
    const d = await prdDto(id, 'po');
    assert.equal(d.deltaScope, null);
    assert.ok(!actionsOf(d).includes('plan.generate'));
    assert.ok(!actionsOf(d).includes('plan.generate-initial'));
    const initial = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    assert.equal(initial.status, 409);
    assert.equal(initial.body.error, 'not-first-version');
    const delta = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'delta' } });
    assert.equal(delta.status, 409);
    assert.equal(delta.body.error, 'no-delta-scope');
    assert.equal(h.workers.length, 0, 'no worker was spawned');
  });

  // ─── Plans ───

  it('the five plan-outcome kinds produce five distinct results; only appended becomes pending', async () => {
    const outcomes = [
      { kind: 'no-delta' },
      { kind: 'engine-failed', error: 'engine exited 1' },
      { kind: 'parse-failed', error: 'bad json' },
      { kind: 'all-rejected', rejected: [{ taskName: 'x', reason: 'no ids' }] },
      { kind: 'appended', playlist: gatedPlaylist(), rejected: [] },
    ];
    const statuses: string[] = [];
    for (const outcome of outcomes) {
      const local = await startHarness();
      try {
        const c = await local.request('POST', '/api/projects', { as: 'po', body: { name: 'A', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'claude' } });
        const id = (c.body.project as { id: string }).id;
        await local.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
        local.onSpawn = planWorker(outcome);
        const g = await local.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
        assert.equal(g.status, 202, g.raw);
        await local.waitDone(id);
        const plan = local.state.load(id).plans[0];
        statuses.push(plan.status);
        if (outcome.kind === 'appended') {
          assert.match(plan.contentHash ?? '', /^[0-9a-f]{64}$/);
          assert.equal(plan.review?.commands[0].value, 'npm run release');
          assert.equal(plan.playlist?.tasks.some((t) => t.status !== undefined), false, 'generated statuses are stripped');
        } else {
          assert.equal(plan.playlist, undefined);
        }
        const job = local.workers[0].job;
        assert.equal(job.kind, 'plan');
        assert.equal((job as { mode: string }).mode, 'initial');
      } finally { await local.close(); }
    }
    assert.deepEqual(statuses, ['no-delta', 'engine-failed', 'parse-failed', 'all-rejected', 'pending']);
    assert.equal(new Set(statuses).size, 5);
  });

  it('every appended plan has exactly one terminal manual ship gate, hashed and approved with the playlist', async () => {
    const ungated = { id: 'pl-delta-u', name: 'PRD v1.0.0 delta', autoplay: true, tasks: [
      { id: 'u1', name: 'Build', prompt: 'b', requirementIds: ['R-2'] },
      { id: 'u2', name: 'Test', prompt: 't', type: 'command', command: 'npm test', dependsOn: ['u1'], requirementIds: ['R-1', 'R-2'] },
      { id: 'u3', name: 'Docs', prompt: 'd', requirementIds: ['R-1'] },
    ] };
    for (const playlist of [ungated, gatedPlaylist()]) {
      const local = await startHarness();
      try {
        const c = await local.request('POST', '/api/projects', { as: 'po', body: { name: 'A', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'claude' } });
        const id = (c.body.project as { id: string }).id;
        await local.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
        local.onSpawn = planWorker({ kind: 'appended', playlist, rejected: [] });
        const g = await local.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
        const planId = (g.body.plan as { id: string }).id;
        await local.waitDone(id);
        const review = local.state.load(id).plans[0];
        assert.equal(review.status, 'pending');
        const tasks = review.playlist!.tasks;
        const dependedOn = new Set(tasks.flatMap((t) => t.dependsOn ?? []));
        const terminalGates = tasks.filter((t) => t.type === 'manual' && !dependedOn.has(t.id));
        assert.equal(terminalGates.length, 1, JSON.stringify(tasks));
        const gate = terminalGates[0];
        assert.equal(gate.name, 'Ship approval');
        assert.equal(tasks.at(-1), gate);
        const leaves = tasks.filter((t) => t !== gate && !dependedOn.has(t.id)).map((t) => t.id);
        assert.deepEqual(leaves, [], 'every other task is upstream of the gate');
        assert.deepEqual(gate.requirementIds, ['R-1', 'R-2']);
        // The hash covers the gate: the reviewer approves exactly the gated playlist.
        assert.equal(review.contentHash, contentHash(review.playlist));
        const ap = await local.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: review.contentHash } });
        assert.equal(ap.status, 200, ap.raw);
        const canonical = local.state.loadCanonicalPlan(id, 'A');
        const stored = canonical.playlists.at(-1)!.tasks.find((t) => t.id === gate.id);
        assert.equal(stored?.type, 'manual');
        assert.equal(stored?.status, TaskStatus.Pending);
      } finally { await local.close(); }
    }
  });

  it('a generated plan loses env/inheritEnvFiles/githubRelease/releaseTag before hashing; other side effects are listed', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const pl = gatedPlaylist();
    const tasks = pl.tasks as Array<Record<string, unknown>>;
    Object.assign(tasks[0], { env: { NPM_TOKEN: 'x' }, inheritEnvFiles: ['.env'], skipIf: { taskId: 't-gate', status: 'failed' }, failurePolicy: 'continue' });
    Object.assign(tasks[2], { releaseTag: 'v1.0.0', githubRelease: true, healthCheckUrl: 'http://127.0.0.1:9/' });
    h.onSpawn = planWorker({ kind: 'appended', playlist: pl, rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const review = h.state.load(id).plans[0];
    const json = JSON.stringify(review.playlist);
    for (const f of ['"env"', 'inheritEnvFiles', 'githubRelease', 'releaseTag']) { assert.equal(json.includes(f), false, f); }
    assert.equal(review.contentHash, contentHash(review.playlist), 'the hash covers the stripped playlist');
    assert.deepEqual(review.review?.stripped?.map((s) => `${s.taskId}.${s.field}`),
      ['t-impl.env', 't-impl.inheritEnvFiles', 't-rel.githubRelease', 't-rel.releaseTag']);
    assert.deepEqual(review.review?.commands.map((c) => `${c.taskId}.${c.field}`),
      ['t-impl.skipIf', 't-impl.failurePolicy', 't-rel.command', 't-rel.healthCheckUrl']);
    const ap = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: review.contentHash } });
    assert.equal(ap.status, 200, ap.raw);
    const rel = h.state.loadCanonicalPlan(id, 'Acme').playlists.at(-1)!.tasks.find((t) => t.id === 't-rel')!;
    assert.equal(rel.releaseTag, undefined);
    assert.equal(rel.githubRelease, undefined);
  });

  it('plan approve: wrong contentHash 409; stale version 409; self-approval flagged', async () => {
    h = await withSelfReviewer(h);
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po-reviewer', body: { mode: 'initial' } });
    assert.equal(g.status, 202, g.raw);
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const wrong = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'po-reviewer', body: { contentHash: 'f'.repeat(64) } });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, 'hash-mismatch');
    const hash = h.state.load(id).plans[0].contentHash;
    const ok = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'po-reviewer', body: { contentHash: hash } });
    assert.equal(ok.status, 200, ok.raw);
    const e = h.auditEntries().find((x) => x.action === 'plan.approve');
    assert.deepEqual(e?.flags, ['self-approval']);
    const again = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'already-decided');
    const canonical = h.state.loadCanonicalPlan(id, 'Acme');
    assert.equal(canonical.playlists.at(-1)?.name, 'PRD v1.0.0 delta');
    assert.equal(canonical.playlists.at(-1)?.tasks.find((t) => t.id === 't-gate')?.status, TaskStatus.Pending,
      'a generated "completed" gate is not carried into the canonical plan');
  });

  it('plan approve after a newer PRD version is 409 stale', async () => {
    const id = await newProject();
    const s1 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    await new Promise((r) => setTimeout(r, 3));
    const s2 = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: String(s1.body.text) + '- CSV\n', baseCreatedAt: (s1.body.version as { createdAt: string }).createdAt } });
    assert.equal(s2.status, 201);
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: h.state.load(id).plans[0].contentHash } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'stale');
  });

  it('an appended playlist using a forbidden engine cannot be approved', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const pl = gatedPlaylist();
    (pl.tasks as Array<Record<string, unknown>>)[0].engine = 'custom';
    h.onSpawn = planWorker({ kind: 'appended', playlist: pl, rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: h.state.load(id).plans[0].contentHash } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'engine-not-allowed');
  });

  // ─── Runs ───

  it('starting a run on an unapproved plan is 409 and spawns nothing', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const spawned = h.workers.length;
    const r = await h.request('POST', `/api/projects/${id}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'plan-not-approved');
    assert.equal(h.workers.length, spawned);
    const unknown = await h.request('POST', `/api/projects/${id}/runs`, { as: 'reviewer', body: { planId: 'nope' } });
    assert.equal(unknown.status, 409);
  });

  it('a second start while running is 409 and spawn ran once; the worker env is scrubbed', async () => {
    const { projectId, planId } = await approvedProject(h);
    const before = h.workers.length;
    const r1 = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r1.status, 202, r1.raw);
    const r2 = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'admin', body: { planId } });
    assert.equal(r2.status, 409);
    assert.equal(h.workers.length - before, 1);
    const w = h.workers.at(-1)!;
    assert.equal(w.job.kind, 'run');
    const env = w.spec.env;
    for (const k of ['CI', 'MOAG_MASTER_KEY', 'SESSION_SECRET']) { assert.equal(k in env, false, k); }
    assert.ok(env.MOAG_CONFIG_PATH);
    const cfg = JSON.parse(fs.readFileSync(String(env.MOAG_CONFIG_PATH), 'utf-8'));
    assert.equal(cfg.agentTaskPlayer['prdLoop.onManualGate'], 'halt');
    assert.equal(cfg.agentTaskPlayer.costBudgetUsd, 10);
    assert.equal(w.spec.workspace, fs.realpathSync.native(path.join(h.root, 'acme')));
    assert.equal(h.auditEntries().filter((e) => e.action === 'run.start').length, 1);
  });

  it('stop sends IPC to the worker and ends the run as stopped', async () => {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const runId = (r.body.run as { id: string }).id;
    const w = h.workers.at(-1)!;
    w.line({ event: 'state', state: 'playing' });
    const s = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/stop`, { as: 'admin', body: {} });
    assert.equal(s.status, 202, s.raw);
    assert.deepEqual(w.sent, [{ type: 'stop' }]);
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'stopped');
    assert.equal(h.auditEntries().filter((e) => e.action === 'run.stop').length, 1);
  });

  it('a repeated stop while the segment is stopping is a no-op 200: no second IPC, no audit, stoppedBy kept', async () => {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const runId = (r.body.run as { id: string }).id;
    const w = h.workers.at(-1)!;
    w.line({ event: 'state', state: 'playing' });
    const first = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/stop`, { as: 'reviewer', body: {} });
    assert.equal(first.status, 202, first.raw);
    const again = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/stop`, { as: 'admin', body: {} });
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.alreadyStopping, true);
    assert.deepEqual(w.sent, [{ type: 'stop' }], 'one IPC stop');
    assert.equal(h.auditEntries().filter((e) => e.action === 'run.stop').length, 1, 'audited once');
    assert.equal(h.state.load(projectId).runs[0].stoppedBy, h.accounts.reviewer.id, 'the first stopper is kept');
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'stopped');
    const after = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/stop`, { as: 'admin', body: {} });
    assert.equal(after.status, 409, 'an ended run is not running');
    assert.equal(after.body.error, 'not-running');
  });

  it('cost events accumulate per PRD version and an exhausted cap blocks the next start', async () => {
    const { projectId, planId } = await approvedProject(h);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const w = h.workers.at(-1)!;
    w.line({ event: 'cost', usd: 6 });
    w.line({ event: 'cost', usd: 4.5 });
    w.line({ event: 'budget-exceeded', totalCost: 10.5, budget: 10 });
    w.exit(4);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'budget');
    const detail = await h.request('GET', `/api/projects/${projectId}`, { as: 'po' });
    const spend = detail.body.spend as { spentUsd: number; capUsd: number; remainingUsd: number; noCap: boolean };
    assert.equal(spend.spentUsd, 10.5);
    assert.equal(spend.remainingUsd, 0);
    assert.equal(spend.noCap, false);
    const again = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'budget-exhausted');
  });

  it('an exhausted version budget hides plan.generate* on the PRD screen, matching the 409 the route sends', async () => {
    const id = await newProject();
    const saved = await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const createdAt = (saved.body.version as { createdAt: string }).createdAt;
    const actions = async () => (await h.request('GET', `/api/projects/${id}/prd`, { as: 'po' })).body.allowedActions as string[];
    assert.ok((await actions()).includes('plan.generate-initial'), 'offered while budget remains');
    h.state.update(id, (s) => { s.versionSpend[createdAt] = 10; });
    assert.equal((await actions()).includes('plan.generate-initial'), false, 'hidden once the cap is used up');
    assert.equal((await actions()).includes('plan.generate'), false);
    const r = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'budget-exhausted');
    // No cap (0) never exhausts.
    await h.request('PATCH', `/api/projects/${id}`, { as: 'po', body: { versionBudgetUsd: 0 } });
    assert.ok((await actions()).includes('plan.generate-initial'));
  });

  // ─── Ship gate ───

  async function haltAtGate(): Promise<{ projectId: string; runId: string }> {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const runId = (r.body.run as { id: string }).id;
    const w = h.workers.at(-1)!;
    // What a real worker leaves behind: impl done, gate aborted (Failed), release blocked.
    const snapPath = (w.job as { planPath: string }).planPath;
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    for (const t of snap.playlists.at(-1).tasks) {
      t.status = t.id === 't-impl' ? 'completed' : t.id === 't-gate' ? 'failed' : 'blocked';
    }
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    w.line({ event: 'state', state: 'playing' });
    w.line({ event: 'task-completed', id: 't-impl', name: 'Implement checkout' });
    w.line({ event: 'manual-gate', id: 't-gate', name: 'Release gate' });
    w.exit(3);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'awaiting-approval');
    return { projectId, runId };
  }

  it('approve by an approver resumes with a snapshot whose gate task is Completed', async () => {
    const { projectId, runId } = await haltAtGate();
    let snapAtSpawn: ReturnType<typeof loadPlan> | null = null;
    h.onSpawn = (w: FakeWorker) => { snapAtSpawn = loadPlan((w.job as { planPath: string }).planPath); };
    const before = h.workers.length;
    const r = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: { note: 'ship it' } });
    assert.equal(r.status, 202, r.raw);
    assert.equal(h.workers.length, before + 1);
    await waitFor(() => snapAtSpawn !== null);
    const tasks = snapAtSpawn!.playlists.at(-1)!.tasks;
    assert.equal(tasks.find((t) => t.id === 't-gate')?.status, TaskStatus.Completed);
    assert.equal(tasks.find((t) => t.id === 't-rel')?.status, TaskStatus.Pending);
    assert.equal(tasks.find((t) => t.id === 't-impl')?.status, TaskStatus.Completed);
    const run = h.state.load(projectId).runs[0];
    assert.equal(run.status, 'running');
    assert.equal(run.segments, 2);
    assert.equal(h.auditEntries().filter((e) => e.action === 'gate.approve').length, 1);
    assert.equal(h.auditEntries().filter((e) => e.action === 'gate.skip').length, 0);
    const twice = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(twice.status, 409);
  });

  it('the default engine is locked at approval: a changed engine hides run.start and the start is 409', async () => {
    const { projectId, planId } = await approvedProject(h);
    assert.equal(h.state.load(projectId).plans[0].approvedEngine, 'claude', 'approval records the engine');
    const patch = await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { defaultEngine: 'codex' } });
    assert.equal(patch.status, 200, patch.raw);
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
    const plan = (dto.body.plans as Array<{ startBlockedReason: string; allowedActions: string[] }>)[0];
    assert.equal(plan.startBlockedReason, 'engine-changed');
    assert.equal(plan.allowedActions.includes('run.start'), false, 'start is not offered');
    const spawned = h.workers.length;
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'engine-changed');
    assert.equal(h.workers.length, spawned, 'nothing spawned');
    assert.equal(h.state.load(projectId).runs.length, 0);
    assert.equal(h.auditEntries().filter((e) => e.action === 'run.start').length, 0);
    // Switching back unlocks it.
    await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { defaultEngine: 'claude' } });
    const ok = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(ok.status, 202, ok.raw);
  });

  it('a gate resume refuses a run whose project engine changed after approval', async () => {
    const { projectId, runId } = await haltAtGate();
    await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { defaultEngine: 'codex' } });
    const before = h.workers.length;
    const r = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'engine-changed');
    assert.equal(h.workers.length, before);
    assert.equal(h.state.load(projectId).runs[0].status, 'awaiting-approval', 'still waiting');
  });

  it('after a gate resume the run view layers the new segment over the earlier one (statuses kept, cost summed)', async () => {
    const { projectId, runId } = await haltAtGate();
    h.state.update(projectId, (s) => { s.runs[0].view!.costUsd = 2; });
    assert.equal(h.state.load(projectId).runs[0].view?.tasks['t-impl'], 'completed');
    const r = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(r.status, 202, r.raw);
    const recorded = h.state.load(projectId).runs[0].view!;
    assert.equal(recorded.tasks['t-gate'], 'completed', 'the approved gate is done in the record');
    assert.equal(recorded.tasks['t-rel'], 'pending', 'its halted dependent is pending again');
    assert.equal(recorded.gate, undefined);
    const w = h.workers.at(-1)!;
    w.line({ event: 'state', state: 'playing' });
    w.line({ event: 'task-started', id: 't-rel', name: 'Release v1.0.0' });
    w.line({ event: 'cost', usd: 1.5 });
    // While segment 2 runs, the DTO still shows segment 1's work.
    const mid = await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
    const midRun = (mid.body.runs as Array<{ view: { tasks: Record<string, string>; costUsd: number } }>)[0];
    assert.equal(midRun.view.tasks['t-rel'], 'running');
    assert.equal(midRun.view.tasks['t-impl'], 'completed');
    assert.equal(midRun.view.costUsd, 3.5);
    const detailTasks = (mid.body.currentRun as { tasks: Array<{ id: string; status: string }> }).tasks;
    assert.equal(detailTasks.find((t) => t.id === 't-impl')?.status, 'completed');
    w.line({ event: 'task-completed', id: 't-rel', name: 'Release v1.0.0' });
    const shipGate = h.state.load(projectId).plans[0].playlist!.tasks.at(-1)!;
    w.line({ event: 'manual-gate', id: shipGate.id, name: shipGate.name });
    w.exit(3);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'awaiting-approval');
    const end = h.state.load(projectId).runs[0].view!;
    assert.deepEqual(
      { impl: end.tasks['t-impl'], gate: end.tasks['t-gate'], rel: end.tasks['t-rel'] },
      { impl: 'completed', gate: 'completed', rel: 'completed' },
    );
    assert.equal(end.costUsd, 3.5);
    assert.deepEqual(end.gate, { taskId: shipGate.id, name: shipGate.name }, 'the gate comes from the latest segment');
  });

  it('approve by an admin is 403; skip by an admin is audited as gate.skip and needs a reason', async () => {
    const { projectId, runId } = await haltAtGate();
    const forbidden = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'admin', body: {} });
    assert.equal(forbidden.status, 403);
    const noReason = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/skip`, { as: 'admin', body: {} });
    assert.equal(noReason.status, 400);
    const approverSkip = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/skip`, { as: 'approver', body: { reason: 'x' } });
    assert.equal(approverSkip.status, 403);
    const skip = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/skip`, { as: 'admin', body: { reason: 'hotfix' } });
    assert.equal(skip.status, 202, skip.raw);
    const e = h.auditEntries().filter((x) => x.action === 'gate.skip');
    assert.equal(e.length, 1);
    assert.equal((e[0].after as { note: string }).note, 'hotfix');
    assert.equal(h.auditEntries().filter((x) => x.action === 'gate.approve').length, 0);
    assert.equal(h.state.load(projectId).runs[0].gateDecisions?.[0].action, 'skip');
  });

  it('reject needs a note and ends the run without resuming', async () => {
    const { projectId, runId } = await haltAtGate();
    const before = h.workers.length;
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/reject`, { as: 'approver', body: {} })).status, 400);
    const r = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/reject`, { as: 'approver', body: { note: 'not ready' } });
    assert.equal(r.status, 200, r.raw);
    assert.equal(h.workers.length, before);
    assert.equal(h.state.load(projectId).runs[0].status, 'ship-rejected');
  });

  // ─── Ship: approve → green verify → trace shows shipped ───

  /** Halt a fresh run at the SERVER-appended ship gate (the realistic shape: every task before it done). */
  async function haltAtShipGate(): Promise<{ projectId: string; runId: string; shipGateId: string }> {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const runId = (r.body.run as { id: string }).id;
    const w = h.workers.at(-1)!;
    const snapPath = (w.job as { planPath: string }).planPath;
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    const tasks = snap.playlists.at(-1).tasks as Array<{ id: string; name: string; status?: string }>;
    const shipGate = tasks.at(-1)!;
    for (const t of tasks) { t.status = t.id === shipGate.id ? 'failed' : 'completed'; }
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    w.line({ event: 'manual-gate', id: shipGate.id, name: shipGate.name });
    w.exit(3);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'awaiting-approval');
    return { projectId, runId, shipGateId: shipGate.id };
  }

  /** What the resumed worker's verify pass leaves in its snapshot: the gate results it recorded. */
  function verifyPass(w: FakeWorker, gates: Array<{ command: string; exitCode: number }>): void {
    const snapPath = (w.job as { planPath: string }).planPath;
    const snap = loadPlan(snapPath);
    recordGateResults(snap, gates.map((g) => ({ ...g, timedOut: false })), new Date().toISOString());
    fs.writeFileSync(snapPath, JSON.stringify(dehydratePlan(snap)));
  }

  async function traceRows(projectId: string): Promise<Array<{ id: string; status: string; releaseTag: string | null }>> {
    const r = await h.request('GET', `/api/projects/${projectId}/trace`, { as: 'approver' });
    assert.equal(r.status, 200, r.raw);
    return r.body.rows as Array<{ id: string; status: string; releaseTag: string | null }>;
  }

  it('gate approve → green verify → the trace shows every requirement shipped, under a server-generated tag', async () => {
    const { projectId, runId, shipGateId } = await haltAtShipGate();
    const halted = await traceRows(projectId);
    assert.ok(halted.every((row) => row.status !== 'shipped'), 'nothing ships before approval');
    const ap = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: { note: 'ship it' } });
    assert.equal(ap.status, 202, ap.raw);
    const w = h.workers.at(-1)!;
    const resumed = loadPlan((w.job as { planPath: string }).planPath);
    assert.equal(resumed.playlists.at(-1)!.tasks.find((t) => t.id === shipGateId)?.status, TaskStatus.Completed);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).some((r) => r.releases.length > 0));
    const rows = await traceRows(projectId);
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.releaseTag]), [
      ['R-1', 'shipped', `ship-${runId}`],
      ['R-2', 'shipped', `ship-${runId}`],
    ]);
  });

  it('gate approve → failing verify: nothing ships', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const ap = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(ap.status, 202, ap.raw);
    const w = h.workers.at(-1)!;
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }, { command: 'npm run lint', exitCode: 1 }]);
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    const rows = await traceRows(projectId);
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.releaseTag]), [
      ['R-1', 'in-progress', null],
      ['R-2', 'in-progress', null],
    ]);
  });

  it('a red gate never ships, even when the segment exits 0', async () => {
    // Red evidence, exit 0: stampRelease re-checks the gates itself.
    const a = await haltAtShipGate();
    assert.equal((await h.request('POST', `/api/projects/${a.projectId}/runs/${a.runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const wa = h.workers.at(-1)!;
    verifyPass(wa, [{ command: 'npm test', exitCode: 2 }]);
    wa.exit(0);
    await waitFor(() => h.state.load(a.projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(a.projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    assert.ok((await traceRows(a.projectId)).every((row) => row.status !== 'shipped' && row.releaseTag === null));
  });

  it('an admin skip of the ship gate never ships, even with green evidence', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const skip = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/skip`, { as: 'admin', body: { reason: 'hotfix' } });
    assert.equal(skip.status, 202, skip.raw);
    const w = h.workers.at(-1)!;
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    assert.ok((await traceRows(projectId)).every((row) => row.status !== 'shipped' && row.releaseTag === null));
  });

  it('no worker event sequence auto-approves the gate', async () => {
    const { projectId, runId } = await haltAtGate();
    const before = h.workers.length;
    // Whatever a compromised worker printed earlier, nothing resumes without a human.
    await new Promise((r) => setTimeout(r, 30));
    const run = h.state.load(projectId).runs[0];
    assert.equal(run.status, 'awaiting-approval');
    assert.equal(run.id, runId);
    assert.equal(h.workers.length, before);
    assert.equal(h.auditEntries().some((e) => e.action.startsWith('gate.')), false);
    // A forged approval line from a later worker is not part of the protocol at all.
    const { parseWorkerLine } = await import('../../../server/worker-protocol');
    for (const forged of ['gate-approve', 'gate.approve', 'gate-approved', 'approve']) {
      assert.equal(parseWorkerLine(JSON.stringify({ event: forged, id: 't-gate' })), null);
    }
  });

  // ─── Run/gate DTOs (S2-T4) ───

  async function projectDto(id: string, as: string): Promise<Record<string, unknown>> {
    const r = await h.request('GET', `/api/projects/${id}`, { as });
    assert.equal(r.status, 200, r.raw);
    return r.body;
  }
  const runActions = async (id: string, as: string): Promise<string[]> =>
    [...(((await projectDto(id, as)).runs as Array<{ allowedActions: string[] }>)[0].allowedActions)].sort();

  it('run.stop is offered only while the runner is playing or paused, and only to reviewer/admin', async () => {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const w = h.workers.at(-1)!;
    const seen: Record<string, Record<string, string[]>> = {};
    for (const s of ['idle', 'playing', 'paused', 'stopping']) {
      w.line({ event: 'state', state: s });
      await waitFor(() => h.app.jobs.view(projectId)?.runnerState === s);
      seen[s] = {};
      for (const who of ['po', 'reviewer', 'approver', 'admin']) { seen[s][who] = await runActions(projectId, who); }
    }
    for (const s of ['playing', 'paused']) {
      assert.deepEqual(seen[s].reviewer, ['run.stop'], s);
      assert.deepEqual(seen[s].admin, ['run.stop'], s);
      assert.deepEqual(seen[s].po, [], s);
      assert.deepEqual(seen[s].approver, [], s);
    }
    for (const s of ['idle', 'stopping']) {
      for (const who of ['po', 'reviewer', 'approver', 'admin']) { assert.deepEqual(seen[s][who], [], `${s}/${who}`); }
    }
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    assert.deepEqual(await runActions(projectId, 'reviewer'), [], 'a finished run offers no stop');
  });

  it('gate actions: approve/reject only for approvers and skip only for admins, only while awaiting approval', async () => {
    const { projectId } = await haltAtGate();
    assert.deepEqual(await runActions(projectId, 'approver'), ['gate.approve', 'gate.reject']);
    assert.deepEqual(await runActions(projectId, 'admin'), ['gate.skip']);
    assert.deepEqual(await runActions(projectId, 'reviewer'), []);
    assert.deepEqual(await runActions(projectId, 'po'), []);
    const dto = await projectDto(projectId, 'approver');
    const detail = dto.currentRun as { tasks: Array<{ id: string; name: string; status: string }>; afterGate: string[] };
    assert.deepEqual(detail.afterGate, ['Release v1.0.0', 'Ship approval'], 'the gate card lists what runs after approval (incl. the server-appended terminal gate)');
    assert.equal(detail.tasks.find((t) => t.id === 't-impl')?.status, 'completed');
    assert.equal(detail.tasks.find((t) => t.id === 't-gate')?.name, 'Release gate');
  });

  it('gate actions are not offered while a run is still running', async () => {
    const { projectId, planId } = await approvedProject(h);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    h.workers.at(-1)!.line({ event: 'manual-gate', id: 't-gate', name: 'Release gate' });
    await waitFor(() => !!h.app.jobs.view(projectId)?.gate);
    assert.deepEqual(await runActions(projectId, 'approver'), [], 'the gate event alone does not make the run approvable');
    assert.deepEqual(await runActions(projectId, 'admin'), []);
  });

  it('cost DTO: capUsd 0 means noCap with no remaining figure; a cap reports spend and remaining', async () => {
    const { projectId, planId } = await approvedProject(h);
    const patch = await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { versionBudgetUsd: 0 } });
    assert.equal(patch.status, 200, patch.raw);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const w = h.workers.at(-1)!;
    w.line({ event: 'cost', usd: 1.25 });
    await waitFor(() => Object.values(h.state.load(projectId).versionSpend).some((v) => v > 0));
    const cost = ((await projectDto(projectId, 'po')).runs as Array<{ cost: Record<string, unknown> }>)[0].cost;
    assert.equal(cost.capUsd, 0);
    assert.equal(cost.noCap, true);
    assert.equal(cost.remainingUsd, null);
    assert.equal(cost.spentUsd, 1.25);
    await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { versionBudgetUsd: 10 } });
    const capped = ((await projectDto(projectId, 'po')).runs as Array<{ cost: Record<string, unknown> }>)[0].cost;
    assert.equal(capped.capUsd, 10);
    assert.equal(capped.noCap, false);
    assert.equal(capped.remainingUsd, 8.75);
  });

  it('plan DTO: run.start only for reviewer/admin on an approved plan, hidden with a reason while blocked', async () => {
    const { projectId, planId } = await approvedProject(h);
    const planOf = async (as: string) => ((await projectDto(projectId, as)).plans as Array<{ id: string; allowedActions: string[]; startBlockedReason?: string | null }>)
      .find((p) => p.id === planId)!;
    assert.deepEqual((await planOf('reviewer')).allowedActions, ['run.start']);
    assert.deepEqual((await planOf('admin')).allowedActions, ['run.start']);
    assert.deepEqual((await planOf('po')).allowedActions, []);
    assert.deepEqual((await planOf('approver')).allowedActions, []);
    assert.equal((await planOf('reviewer')).startBlockedReason, null);

    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const busy = await planOf('reviewer');
    assert.deepEqual(busy.allowedActions, [], 'no start while a job runs');
    assert.equal(busy.startBlockedReason, 'job-active');
  });

  it('plan DTO: a missing engine hides run.start (reason engine-unavailable) and the start is refused 409', async () => {
    let claudeInstalled = true;
    const hx = await startHarness({ engineAvailable: (e) => (e === 'claude' ? claudeInstalled : true) });
    try {
      const { projectId, planId } = await approvedProject(hx);
      claudeInstalled = false; // the next probe finds the CLI gone
      const spawned = hx.workers.length;
      const dto = await hx.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
      const plan = (dto.body.plans as Array<{ id: string; allowedActions: string[]; startBlockedReason: string }>).find((p) => p.id === planId)!;
      assert.deepEqual(plan.allowedActions, []);
      assert.equal(plan.startBlockedReason, 'engine-unavailable');
      const r = await hx.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'engine-unavailable');
      assert.equal(hx.workers.length, spawned, 'no run worker was spawned');
    } finally { await hx.close(); }
  });

  // ─── The project's engine is the engine that runs ───

  const snapshotOf = (hx: Harness): ReturnType<typeof loadPlan> => loadPlan((hx.workers.at(-1)!.job as { planPath: string }).planPath);

  it('an ollama project runs on ollama: canonical plan, plan-job input, run snapshot and run detail agree', async () => {
    const { projectId, planId } = await approvedProject(h, 'ollama');
    const planJob = h.workers.find((w) => w.job.kind === 'plan')!;
    assert.equal(loadPlan((planJob.job as { planPath: string }).planPath).defaultEngine, 'ollama', 'plan-generation input');
    assert.equal(loadPlan(h.state.canonicalPlanPath(projectId)).defaultEngine, 'ollama', 'canonical plan on disk');
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const runId = (r.body.run as { id: string }).id;
    const snap = loadPlan(path.join(h.state.runDir(projectId, runId), 'plan.json'));
    assert.equal(snap.defaultEngine, 'ollama');
    assert.equal(referencedEngines(snap).has('claude'), false, 'nothing in the run resolves to claude');
    const detail = (await projectDto(projectId, 'reviewer')).currentRun as { tasks: Array<{ id: string; engine: string }> };
    assert.ok(detail.tasks.every((t) => t.engine === 'ollama'), JSON.stringify(detail.tasks));
    // Once the worker reports what actually ran (e.g. after a fallback), the detail shows that.
    h.workers.at(-1)!.line({ event: 'task-engine', id: 't-impl', engine: 'gemini' });
    const events = path.join(h.state.runDir(projectId, runId), 'events.jsonl');
    await waitFor(() => fs.existsSync(events) && fs.readFileSync(events, 'utf-8').includes('gemini'));
    const after = (await projectDto(projectId, 'reviewer')).currentRun as { tasks: Array<{ id: string; engine: string }> };
    assert.equal(after.tasks.find((t) => t.id === 't-impl')?.engine, 'gemini');
  });

  it('a codex project snapshot is codex and its worker env has no ANTHROPIC_API_KEY; an anthropic project gets its key', async () => {
    const MASTER = Buffer.from('master-secret-for-tests-0123456789', 'utf-8');
    const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-KEY-a91F';
    for (const engine of ['codex', 'anthropic'] as const) {
      const hx = await startHarness({ engineAvailable: () => true, secrets: (d) => { const s = new SecretStore(d, MASTER); s.set('anthropic', KEY); return s; } });
      try {
        const { projectId, planId } = await approvedProject(hx, engine);
        const r = await hx.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
        assert.equal(r.status, 202, r.raw);
        const w = hx.workers.at(-1)!;
        assert.equal(w.job.kind, 'run');
        assert.equal(snapshotOf(hx).defaultEngine, engine);
        if (engine === 'codex') {
          assert.equal('ANTHROPIC_API_KEY' in w.spec.env, false, 'a codex run never receives the anthropic key');
        } else {
          assert.equal(w.spec.env.ANTHROPIC_API_KEY, KEY);
        }
      } finally { await hx.close(); }
    }
  });

  it('plan-outcome errors are redacted with the job\'s injected credentials before they are stored or shown', async () => {
    const MASTER = Buffer.from('master-secret-for-tests-0123456789', 'utf-8');
    const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-KEY-a91F';
    const cases: Array<Record<string, unknown>> = [
      { kind: 'engine-failed', error: `401 from API with key ${KEY}` },
      { kind: 'parse-failed', error: `could not parse: {"auth":"${KEY}"}` },
    ];
    for (const outcome of cases) {
      const hx = await startHarness({ engineAvailable: () => true, secrets: (d) => { const s = new SecretStore(d, MASTER); s.set('anthropic', KEY); return s; } });
      try {
        const c = await hx.request('POST', '/api/projects', { as: 'po', body: { name: 'A', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'anthropic' } });
        const id = (c.body.project as { id: string }).id;
        await hx.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
        hx.onSpawn = planWorker(outcome);
        await hx.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
        await waitFor(() => hx.state.load(id).plans[0]?.status === outcome.kind);
        const stored = hx.state.load(id).plans[0].error ?? '';
        assert.equal(stored.includes(KEY), false, `${outcome.kind}: key not stored`);
        assert.match(stored, /\[REDACTED\]/);
        const dto = await hx.request('GET', `/api/projects/${id}`, { as: 'po' });
        assert.equal(dto.raw.includes(KEY), false, `${outcome.kind}: key not in the DTO`);
      } finally { await hx.close(); }
    }
  });

  it('a generated playlist carrying the injected credential is redacted everywhere and can never be approved', async () => {
    const MASTER = Buffer.from('master-secret-for-tests-0123456789', 'utf-8');
    const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-KEY-a91F';
    const hx = await startHarness({ engineAvailable: () => true, secrets: (d) => { const s = new SecretStore(d, MASTER); s.set('anthropic', KEY); return s; } });
    try {
      const c = await hx.request('POST', '/api/projects', { as: 'po', body: { name: 'A', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'anthropic' } });
      const id = (c.body.project as { id: string }).id;
      await hx.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
      const pl = gatedPlaylist();
      const tasks = pl.tasks as Array<Record<string, unknown>>;
      tasks[0].name = `Key is ${KEY}`;
      tasks[0].prompt = `echo ${KEY}`;
      tasks[0].env = { [KEY]: 'x' }; // stripped anyway — and its key must not survive in the "stripped" list either
      hx.onSpawn = planWorker({ kind: 'appended', playlist: pl, rejected: [{ taskName: KEY, reason: `has ${KEY}` }] });
      await hx.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
      await waitFor(() => hx.state.load(id).plans[0]?.status === 'pending');
      const stored = hx.state.load(id).plans[0];
      assert.equal(JSON.stringify(stored).includes(KEY), false, 'key not stored anywhere in the plan record');
      assert.match(String(stored.playlist!.tasks[0].name), /\[REDACTED\]/);
      assert.equal(stored.review!.ok, false);
      assert.ok(stored.review!.errors.some((e) => /credential/i.test(e)));
      const dto = await hx.request('GET', `/api/projects/${id}`, { as: 'po' });
      assert.equal(dto.raw.includes(KEY), false, 'key not in the DTO');
      const ap = await hx.request('POST', `/api/projects/${id}/plans/${stored.id}/approve`, { as: 'reviewer', body: { contentHash: stored.contentHash } });
      assert.equal(ap.status, 409, ap.raw);
      assert.equal(hx.state.load(id).plans[0].status, 'pending', 'not approved');
    } finally { await hx.close(); }
  });

  it('run start checks every engine the plan references, not only the project default', async () => {
    const hx = await startHarness({ engineAvailable: (e) => e !== 'codex' });
    try {
      const created = await hx.request('POST', '/api/projects', {
        as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: 'ollama' },
      });
      assert.equal(created.status, 201, created.raw);
      const projectId = (created.body.project as { id: string }).id;
      await hx.request('POST', `/api/projects/${projectId}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
      const pl = gatedPlaylist() as { tasks: Array<Record<string, unknown>> };
      pl.tasks[0].engine = 'codex'; // one task pinned to an engine this server lacks
      hx.onSpawn = planWorker({ kind: 'appended', playlist: pl, rejected: [] });
      const gen = await hx.request('POST', `/api/projects/${projectId}/plans`, { as: 'po', body: { mode: 'initial' } });
      assert.equal(gen.status, 202, gen.raw);
      const planId = (gen.body.plan as { id: string }).id;
      await waitFor(() => hx.state.load(projectId).plans[0]?.status === 'pending');
      const ap = await hx.request('POST', `/api/projects/${projectId}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hx.state.load(projectId).plans[0].contentHash } });
      assert.equal(ap.status, 200, ap.raw);
      const dto = await hx.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
      const plan = (dto.body.plans as Array<{ id: string; startBlockedReason: string }>).find((p) => p.id === planId)!;
      assert.equal(plan.startBlockedReason, 'engine-unavailable', 'the DTO mirrors the guard');
      const spawned = hx.workers.length;
      const r = await hx.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'engine-unavailable');
      assert.match(String(r.body.message), /codex/);
      assert.equal(hx.workers.length, spawned);
    } finally { await hx.close(); }
  });

  it('changing the project engine restamps the stored canonical plan', async () => {
    const { projectId } = await approvedProject(h, 'claude');
    assert.equal(loadPlan(h.state.canonicalPlanPath(projectId)).defaultEngine, 'claude');
    const p = await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { defaultEngine: 'gemini' } });
    assert.equal(p.status, 200, p.raw);
    assert.equal(loadPlan(h.state.canonicalPlanPath(projectId)).defaultEngine, 'gemini');
  });

  it('a plan-generation job runs with every engine auto-approve off; a run job keeps the defaults', async () => {
    const { projectId, planId } = await approvedProject(h);
    const planJob = h.workers.find((w) => w.job.kind === 'plan')!;
    const pcfg = JSON.parse(fs.readFileSync(String(planJob.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
    assert.equal(pcfg['engines.claude.autoApprove'], false);
    assert.equal(pcfg['engines.codex.autoApprove'], false);
    assert.deepEqual(pcfg['engines.gemini.args'], []);
    assert.ok(pcfg['engines.codex.args'].includes('--skip-git-repo-check'), 'codex plan jobs run in a non-git scratch dir');
    assert.ok(pcfg['engines.codex.args'].includes('shell_tool'), 'codex plan jobs get no shell tool');
    assert.equal(pcfg['prdLoop.onManualGate'], 'halt');
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const rcfg = JSON.parse(fs.readFileSync(String(h.workers.at(-1)!.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
    assert.equal('engines.claude.autoApprove' in rcfg, false);
    assert.equal('engines.codex.args' in rcfg, false, 'run jobs keep the configured codex args');
  });

  it('a plan-generation job never starts in the repo: its cwd is an empty server-owned scratch dir with a file listing', async () => {
    // A repo shipping engine config must not be able to run it on a PO click.
    fs.mkdirSync(path.join(h.root, 'acme', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'acme', '.claude', 'settings.json'), '{"hooks":{}}');
    const { projectId, planId } = await approvedProject(h);
    const project = h.projects.get(projectId)!;
    const planJob = h.workers.find((w) => w.job.kind === 'plan')!;
    const job = planJob.job as PlanJob;
    const repo = fs.realpathSync.native(project.workspacePath);
    assert.notEqual(path.resolve(planJob.spec.workspace), path.resolve(project.workspacePath), 'spawn cwd is not the project workspace');
    assert.notEqual(path.resolve(planJob.spec.workspace), repo);
    assert.equal(job.workspace, planJob.spec.workspace, 'engine runTask cwd (job.workspace) is the same scratch dir');
    assert.equal(path.resolve(job.workspace), path.join(h.state.projectDir(projectId), 'plans', planId, 'work'));
    assert.ok(path.resolve(job.workspace).startsWith(path.resolve(h.dataDir) + path.sep), 'scratch lives in the data dir');
    assert.deepEqual(fs.readdirSync(job.workspace), [], 'scratch dir is empty: no repo config is present');
    assert.ok(job.repoListingPath, 'the job carries the server-generated listing');
    assert.match(fs.readFileSync(job.repoListingPath!, 'utf-8'), /^Repository files/);
    // The run job, approved by a reviewer, does run in the repo.
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    assert.equal(path.resolve(h.workers.at(-1)!.spec.workspace), repo);
    // ...and the project DTO tells the reviewer the repo ships engine config.
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
    assert.deepEqual(dto.body.repoEngineConfig, ['.claude']);
  });

  it('the run record and job.lock name the worker pid', async () => {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    assert.equal(h.state.load(projectId).runs[0].workerPid, 424242);
    assert.equal(JSON.parse(fs.readFileSync(h.app.jobs.lockPath(projectId), 'utf-8')).workerPid, 424242);
  });

  it('currentRun detail carries error tails from the run events', async () => {
    const { projectId, planId } = await approvedProject(h);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const w = h.workers.at(-1)!;
    w.line({ event: 'task-failed', id: 't-impl', name: 'Implement checkout' });
    w.line({ event: 'task-error-tail', id: 't-impl', tail: 'Error: boom\n  at line 3' });
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    const detail = (await projectDto(projectId, 'po')).currentRun as { errorTails: Record<string, string>; events: Array<{ event: string }>; tasks: Array<{ id: string; status: string }> };
    assert.equal(detail.errorTails['t-impl'], 'Error: boom\n  at line 3');
    assert.ok(detail.events.some((e) => e.event === 'task-error-tail'));
    assert.equal(detail.tasks.find((t) => t.id === 't-impl')?.status, 'failed');
  });

  it('CI-locked server refuses plan generation and runs', async () => {
    const locked = await startHarness({ config: { runsDisabledReason: 'ci' } });
    try {
      const c = await locked.request('POST', '/api/projects', { as: 'po', body: { name: 'A', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'claude' } });
      const id = (c.body.project as { id: string }).id;
      await locked.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
      const dto = await locked.request('GET', `/api/projects/${id}/prd`, { as: 'po' });
      assert.deepEqual(dto.body.allowedActions, ['prd.save'], 'generate is hidden while CI-locked');
      assert.equal(dto.body.runsDisabledReason, 'ci');
      const g = await locked.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
      assert.equal(g.status, 409);
      assert.equal(g.body.error, 'runs-disabled');
      assert.equal(locked.workers.length, 0);
    } finally { await locked.close(); }
  });

  // ─── Trace, approvers, audit, SSE ───

  it('GET trace returns rows plus requirement text', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const r = await h.request('GET', `/api/projects/${id}/trace`, { as: 'approver' });
    assert.equal(r.status, 200);
    assert.deepEqual((r.body.requirements as Array<{ id: string }>).map((x) => x.id), ['R-1', 'R-2']);
    assert.deepEqual((r.body.rows as Array<{ status: string }>).map((x) => x.status), ['untracked', 'untracked']);
  });

  it('GET /api/users/approvers lists active approvers only', async () => {
    const r = await h.request('GET', '/api/users/approvers', { as: 'po' });
    assert.deepEqual(r.body.approvers, [{ username: 'approver', displayName: 'approver' }]);
  });

  it('audit query filters and pages; every audited entry is free of secret values', async () => {
    await newProject();
    const r = await h.request('GET', '/api/admin/audit?action=project.create&limit=5', { as: 'admin' });
    assert.equal(r.status, 200);
    const entries = r.body.entries as Array<{ action: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'project.create');
    const bad = await h.request('GET', '/api/admin/audit?limit=-1', { as: 'admin' });
    assert.equal(bad.status, 400);
    const raw = fs.readFileSync(path.join(h.dataDir, 'audit.jsonl'), 'utf-8');
    for (const secret of [PASSWORD, 'server-master-secret', h.tokens.admin.sid, h.tokens.admin.csrfToken]) {
      assert.equal(raw.includes(secret), false);
    }
  });

  it('audit pages at 100 newest-first with a cursor, and filters by actor, action, project and time', async () => {
    const id = await newProject();
    for (let i = 0; i < 105; i++) {
      h.audit.append({ actorUserId: h.accounts.reviewer.id, actorUsername: 'reviewer', action: 'run.stop', projectId: id, target: `run-${i}` });
    }
    const p1 = await h.request('GET', '/api/admin/audit?limit=500', { as: 'admin' });
    assert.equal(p1.status, 200);
    const e1 = p1.body.entries as Array<{ seq: number; target: string; action: string }>;
    assert.equal(e1.length, 100, 'clamped to 100 per page');
    assert.equal(e1[0].target, 'run-104', 'newest first');
    assert.ok(e1.every((e, i) => i === 0 || e.seq < e1[i - 1].seq));
    assert.equal(p1.body.nextBefore, e1[99].seq);
    assert.ok((p1.body.actions as string[]).includes('gate.skip'), 'filter options come from the closed audit action set');

    const p2 = await h.request('GET', `/api/admin/audit?before=${p1.body.nextBefore}`, { as: 'admin' });
    const e2 = p2.body.entries as Array<{ seq: number; target: string }>;
    assert.ok(e2.length >= 5);
    assert.ok(e2.every((e) => e.seq < (p1.body.nextBefore as number)));
    assert.equal(p2.body.nextBefore, null, 'last page has no cursor');

    const byActor = await h.request('GET', '/api/admin/audit?actor=reviewer&action=run.stop', { as: 'admin' });
    assert.equal((byActor.body.entries as unknown[]).length, 100);
    const byProject = await h.request('GET', `/api/admin/audit?projectId=${id}&action=project.create`, { as: 'admin' });
    assert.equal((byProject.body.entries as unknown[]).length, 1);
    const future = await h.request('GET', `/api/admin/audit?from=${encodeURIComponent('2999-01-01T00:00:00.000Z')}`, { as: 'admin' });
    assert.deepEqual(future.body.entries, []);
    assert.equal(future.body.nextBefore, null);
    for (const who of ['po', 'reviewer', 'approver']) {
      const r = await h.request('GET', '/api/admin/audit', { as: who });
      assert.equal(r.status, 403, who);
    }
  });

  it('users PATCH: removing the last admin role or disabling the last admin is 409 with no change, no audit line, sessions intact', async () => {
    const before = h.auditEntries().length;
    const roles = await h.request('PATCH', `/api/admin/users/${h.accounts.admin.id}`, { as: 'admin', body: { roles: ['reviewer'] } });
    assert.equal(roles.status, 409);
    assert.equal(roles.body.error, 'last-admin');
    assert.equal(roles.body.message, 'At least one active admin is required.');
    const off = await h.request('PATCH', `/api/admin/users/${h.accounts.admin.id}`, { as: 'admin', body: { disabled: true } });
    assert.equal(off.status, 409);
    assert.equal(off.body.error, 'last-admin');
    assert.equal(h.auditEntries().length, before);
    assert.deepEqual(h.users.findById(h.accounts.admin.id)!.roles, ['admin']);
    assert.equal(h.users.findById(h.accounts.admin.id)!.disabled, false);
    assert.equal((await h.request('GET', '/api/admin/users', { as: 'admin' })).status, 200, 'the admin is still signed in');

    // With a second admin, the first may step down.
    const add = await h.request('POST', '/api/admin/users', { as: 'admin', body: { username: 'admin2', roles: ['admin'], password: PASSWORD } });
    assert.equal(add.status, 201, add.raw);
    const ok = await h.request('PATCH', `/api/admin/users/${h.accounts.admin.id}`, { as: 'admin', body: { roles: ['reviewer'] } });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(h.auditEntries().filter((e) => e.action === 'user.role-change').length, 1);
  });

  it('SSE: streams job events and allows at most 5 streams per session', async () => {
    const { projectId, planId } = await approvedProject(h);
    const open = (): Promise<{ res: http.IncomingMessage; req: http.ClientRequest; data: () => string }> => new Promise((resolve, reject) => {
      let buf = '';
      const req = http.request(`${h.url}/api/projects/${projectId}/events`, { headers: { Cookie: `moag_sid=${h.tokens.po.sid}` } }, (res) => {
        res.on('data', (c) => { buf += c.toString(); });
        resolve({ res, req, data: () => buf });
      });
      req.on('error', reject);
      req.end();
    });
    const streams: Array<{ res: http.IncomingMessage; req: http.ClientRequest; data: () => string }> = [];
    for (let i = 0; i < 5; i++) { streams.push(await open()); }
    for (const s of streams) { assert.equal(s.res.statusCode, 200); assert.match(String(s.res.headers['content-type']), /text\/event-stream/); }
    const sixth = await h.request('GET', `/api/projects/${projectId}/events`, { as: 'po' });
    assert.equal(sixth.status, 429);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    h.workers.at(-1)!.line({ event: 'task-started', id: 't-impl', name: 'Implement checkout' });
    await waitFor(() => streams[0].data().includes('task-started'));
    assert.match(streams[0].data(), /event: snapshot/);
    for (const s of streams) { s.req.destroy(); }
    await waitFor(() => h.app.jobs.subscriberCount(projectId) === 0);
    const again = await open();
    assert.equal(again.res.statusCode, 200, 'slots are released on close');
    again.req.destroy();
  });

  it('SSE: revoking the session (role change, logout) ends its open streams at once and frees the slots', async () => {
    const id = await newProject();
    const open = (sid: string): Promise<{ res: http.IncomingMessage; req: http.ClientRequest; data: () => string; ended: () => boolean }> =>
      new Promise((resolve, reject) => {
        let buf = '';
        let ended = false;
        const req = http.request(`${h.url}/api/projects/${id}/events`, { headers: { Cookie: `moag_sid=${sid}` } }, (res) => {
          res.on('data', (c) => { buf += c.toString(); });
          res.on('end', () => { ended = true; });
          resolve({ res, req, data: () => buf, ended: () => ended });
        });
        req.on('error', reject);
        req.end();
      });
    const po = await open(h.tokens.po.sid);
    const reviewer = await open(h.tokens.reviewer.sid);
    assert.equal(po.res.statusCode, 200);
    await waitFor(() => po.data().includes('event: snapshot'));
    // An admin changes the product owner's roles: every PO session dies, and so does its stream.
    const r = await h.request('PATCH', `/api/admin/users/${h.accounts.po.id}`, { as: 'admin', body: { roles: ['product-owner', 'reviewer'] } });
    assert.equal(r.status, 200, r.raw);
    await waitFor(() => po.ended());
    assert.match(po.data(), /event: session-ended/);
    assert.equal(reviewer.ended(), false, "another user's stream is untouched");
    // Logout ends that session's stream too.
    await h.request('POST', '/api/logout', { as: 'reviewer', body: {} });
    await waitFor(() => reviewer.ended());
    assert.equal(h.app.jobs.subscriberCount(id), 0, 'no subscription leaks');
  });

  it('SSE: the heartbeat re-checks the session and ends a stream whose user was disabled without a revocation', async () => {
    const hx = await startHarness({ sseHeartbeatMs: 30 });
    try {
      const c = await hx.request('POST', '/api/projects', { as: 'po', body: { name: 'A', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'claude' } });
      const id = (c.body.project as { id: string }).id;
      let buf = '';
      let ended = false;
      const req = http.request(`${hx.url}/api/projects/${id}/events`, { headers: { Cookie: `moag_sid=${hx.tokens.po.sid}` } }, (res) => {
        res.on('data', (d) => { buf += d.toString(); });
        res.on('end', () => { ended = true; });
      });
      req.end();
      await waitFor(() => buf.includes(': hb'), 3000);
      assert.equal(ended, false, 'a live session keeps streaming');
      // Disable straight in the store: no session is destroyed, so only the heartbeat can notice.
      hx.users.disable(hx.accounts.po.id);
      await waitFor(() => ended, 3000);
      assert.match(buf, /event: session-ended/);
      assert.equal(hx.app.jobs.subscriberCount(id), 0);
    } finally { await hx.close(); }
  });

  // ─── Stack recommendation (S3) ───

  it('recommendation: an empty data dir passes through the static default with no numeric rate fields', async () => {
    for (const who of ['po', 'reviewer', 'approver', 'admin']) {
      const r = await h.request('GET', '/api/projects/recommendation', { as: who });
      assert.equal(r.status, 200, `${who}: ${r.raw}`);
      const rec = r.body.recommendation as Record<string, unknown>;
      assert.deepEqual(rec, recommendStack([], [], null));
      assert.equal(rec.source, 'static-default');
      assert.equal(rec.label, 'Insufficient data — static default');
      assert.doesNotMatch(JSON.stringify(rec), /rate|wilson|confidence/i);
    }
    assert.equal((await h.request('GET', '/api/projects/recommendation')).status, 401);
  });

  it('recommendation: repo markers of a chosen folder or a project give the "detected" default; escapes are refused', async () => {
    fs.writeFileSync(path.join(h.root, 'other', 'go.mod'), 'module x');
    const r = await h.request('GET', '/api/projects/recommendation?path=other', { as: 'po' });
    assert.equal(r.status, 200, r.raw);
    assert.equal((r.body.recommendation as { stack: string }).stack, 'go');
    assert.equal((r.body.recommendation as { defaultKind: string }).defaultKind, 'detected');
    for (const bad of ['..', '../..', '/etc', 'missing-folder']) {
      const x = await h.request('GET', `/api/projects/recommendation?path=${encodeURIComponent(bad)}`, { as: 'po' });
      assert.ok(x.status >= 400 && x.status < 500, `${bad} → ${x.status}`);
    }
    const id = await newProject();
    fs.writeFileSync(path.join(h.root, 'acme', 'pyproject.toml'), '');
    const byProject = await h.request('GET', `/api/projects/recommendation?projectId=${id}`, { as: 'reviewer' });
    assert.equal((byProject.body.recommendation as { stack: string }).stack, 'python');
    assert.equal((await h.request('GET', '/api/projects/recommendation?projectId=nope', { as: 'po' })).status, 404);
    assert.equal((await h.request('GET', '/api/projects/recommendation?projectId=a%2Fb', { as: 'po' })).status, 400);
  });

  it('recommendation: measured evidence on connected engines passes through unchanged', async () => {
    await h.close();
    h = await startHarness({ engineAvailable: (e) => e === 'claude' });
    const store = new OutcomeStore(h.dataDir);
    for (let i = 0; i < 12; i++) {
      store.append({ kind: 'task', ts: 't', projectId: 'p', runId: 'r', stack: 'python', engine: 'claude', taskType: 'agent', status: i < 11 ? 'completed' : 'failed' });
      store.append({ kind: 'task', ts: 't', projectId: 'p', runId: 'r', stack: 'go', engine: 'codex', taskType: 'agent', status: 'completed' });
    }
    const r = await h.request('GET', '/api/projects/recommendation', { as: 'po' });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.connectedEngines, ['claude']);
    const expected = recommendStack(store.readAll().records, ['claude'], null);
    assert.deepEqual(r.body.recommendation, JSON.parse(JSON.stringify(expected)));
    const rec = r.body.recommendation as { source: string; state: string; stack: string; confidence: string | null; basis: { n: number } };
    assert.equal(rec.source, 'measured');
    assert.equal(rec.stack, 'python', 'codex is not connected, so its go evidence is ignored');
    assert.equal(rec.state, 'single-stack', 'one measured stack is not a recommendation');
    assert.equal(rec.confidence, null);
    assert.equal(rec.basis.n, 12);

    // With repo files that say otherwise, the detected stack stays primary.
    fs.writeFileSync(path.join(h.root, 'other', 'go.mod'), 'module x');
    const d = await h.request('GET', '/api/projects/recommendation?path=other', { as: 'po' });
    const drec = d.body.recommendation as { state: string; stack: string; stackSource: string; detectedStack: string };
    assert.deepEqual([drec.state, drec.stack, drec.stackSource, drec.detectedStack], ['detected-differs', 'go', 'detected', 'go']);
  });
});

/** Re-start the harness with an extra user holding both product-owner and reviewer. */
async function withSelfReviewer(h: Harness): Promise<Harness> {
  await h.close();
  return startHarness({ extraAccounts: { 'po-reviewer': ['product-owner', 'reviewer'] } });
}
