// ─── Hosted server HTTP app: auth, CSRF, validation, plans, runs, ship gate ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import { isDeepStrictEqual } from 'util';
import { collectStandardsInput, EMPTY_TREE_REF } from '../../../runner/evidence';
import { checkStandards, StandardsReport } from '../../../standards/checker';
import {
  startHarness, Harness, waitFor, approvedProject, planWorker, gatedPlaylist, PRD_V1, PASSWORD, FakeWorker, enablePlannerFileAccess, FAKE_HEAD,
  attestStandards,
} from './app-harness';
import { loadPlan, dehydratePlan } from '../../../models/plan';
import { recordGateResults } from '../../../models/requirement-trace';
import { TaskStatus } from '../../../models/types';
import { PROJECTS_FILE } from '../../../server/projects';
import { recommendStack } from '../../../server/stack-recommendation';
import { OutcomeStore } from '../../../server/outcomes';
import { SecretStore } from '../../../server/secrets';
import { referencedEngines } from '../../../server/run-env';
import { PlanJob, RunJob } from '../../../server/worker-protocol';
import { verifyArgv } from '../../../server/run-worker';
import { RUN_DETAIL_EVENTS } from '../../../server/app';
import { contentHash } from '../../../server/prd-ops';
import { migrateStandards } from '../../../server/standards-store';
import { readStandardsJobFile } from '../../../standards/local-store';
import { profileHash, renderPlannerStandards, renderStandardsText } from '../../../standards/profile';
import { sampleProfile } from '../standards/fixtures';

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

  it('an admin changing their OWN roles is told the session ended; the next request is 401 unauthenticated, not 403 forbidden', async () => {
    const add = await h.request('POST', '/api/admin/users', { as: 'admin', body: { username: 'admin2', roles: ['admin'], password: PASSWORD } });
    assert.equal(add.status, 201, add.raw);

    // Someone else's change leaves the caller's session alone, and says nothing about it.
    const other = await h.request('PATCH', `/api/admin/users/${h.accounts.reviewer.id}`, { as: 'admin', body: { roles: ['approver'] } });
    assert.equal(other.status, 200, other.raw);
    assert.equal(other.body.sessionEnded, undefined);
    assert.equal((await h.request('GET', '/api/admin/users', { as: 'admin' })).status, 200);

    const own = await h.request('PATCH', `/api/admin/users/${h.accounts.admin.id}`, { as: 'admin', body: { roles: ['reviewer'] } });
    assert.equal(own.status, 200, own.raw);
    assert.equal(own.body.sessionEnded, true);
    assert.deepEqual((own.body.user as { roles: string[] }).roles, ['reviewer']);

    // The session is gone: that is a 401 the client signs out on, never the "no permission" 403.
    const after = await h.request('GET', '/api/admin/users', { as: 'admin' });
    assert.equal(after.status, 401);
    assert.equal(after.body.error, 'unauthenticated');
    const session = await h.request('GET', '/api/session', { as: 'admin' });
    assert.equal(session.status, 200);
    assert.ok(!session.body.user, 'GET /api/session answers signed out');

    // Forbidden stays forbidden: a signed-in user without the permission is 403, not 401.
    const forbidden = await h.request('GET', '/api/admin/users', { as: 'po' });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, 'forbidden');
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

  it('bootstrap: the attempt limit is per client IP, so one locked-out IP does not lock out another', async () => {
    const token = 'b'.repeat(30);
    const fresh = await startHarness({ accounts: {}, config: { bootstrapToken: token, trustProxy: true } });
    try {
      const s = await fresh.request('GET', '/api/session');
      const cookie = String((s.headers['set-cookie'] ?? [])[0]).split(';')[0];
      const pre = String(s.body.preAuthToken);
      const from = (ip: string, body: unknown) =>
        fresh.request('POST', '/api/bootstrap', { body, cookie, csrf: pre, headers: { 'X-Forwarded-For': ip } });
      const attacker = '203.0.113.7';
      for (let i = 0; i < 5; i++) {
        assert.equal((await from(attacker, { token: 'w'.repeat(30), username: 'root', password: PASSWORD })).status, 403);
      }
      assert.equal((await from(attacker, { token, username: 'root', password: PASSWORD })).status, 429, 'the guessing IP is locked');
      // A different client is untouched by that lock: its right token creates the admin.
      const ok = await from('198.51.100.20', { token, username: 'root', password: PASSWORD });
      assert.equal(ok.status, 201, ok.raw);
      assert.equal(fresh.users.list().length, 1);
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

  it('every appended plan has exactly one server ship gate that gates shipping, hashed and approved with the playlist', async () => {
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
        const shipGates = tasks.filter((t) => t.type === 'manual' && t.name === 'Ship approval');
        assert.equal(shipGates.length, 1, JSON.stringify(tasks));
        const gate = shipGates[0];
        const releases = tasks.filter((t) => t.type === 'release' || t.type === 'deploy');
        const dependedOn = new Set(tasks.flatMap((t) => t.dependsOn ?? []));
        if (releases.length === 0) {
          // No shipping work: the gate is terminal and last, and every other task is upstream of it.
          assert.equal(tasks.at(-1), gate);
          assert.equal(dependedOn.has(gate.id), false);
          assert.deepEqual(tasks.filter((t) => t !== gate && !dependedOn.has(t.id)).map((t) => t.id), []);
        } else {
          // The B2 fixture: the release runs only after approval, everything else before it.
          for (const rel of releases) { assert.ok(rel.dependsOn?.includes(gate.id), `${rel.id} waits for the gate`); }
          assert.deepEqual(gate.dependsOn, ['t-impl', 't-gate']);
          assert.deepEqual(tasks.map((t) => t.id), ['t-impl', 't-gate', gate.id, 't-rel']);
        }
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

  it('a generated task whose cwd escapes the workspace cannot be approved; monitor incident fields are listed', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const pl = gatedPlaylist();
    const tasks = pl.tasks as Array<Record<string, unknown>>;
    Object.assign(tasks[0], { cwd: '../other-project' });
    tasks.push({ id: 't-mon', name: 'Watch', prompt: '', type: 'monitor', command: 'curl -f http://127.0.0.1:9/', incidentRepo: 'someone/else', incidentLabel: 'moag:incident' });
    h.onSpawn = planWorker({ kind: 'appended', playlist: pl, rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const review = h.state.load(id).plans[0];
    assert.equal(review.review?.ok, false);
    assert.match(review.review!.errors.join(' '), /"\.\.\/other-project", which is outside the project workspace/);
    const listed = review.review!.commands.map((c) => `${c.taskId}.${c.field}=${c.value}`);
    for (const want of ['t-impl.cwd=../other-project', 't-mon.incidentRepo=someone/else', 't-mon.incidentLabel=moag:incident']) {
      assert.ok(listed.includes(want), want);
    }
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: review.contentHash } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'review-errors', 'a cwd refusal is not an engine problem');
    assert.match(String(r.body.message), /outside the project workspace/, 'the reviewer is told why');
    assert.equal(h.state.load(id).plans[0].status, 'pending', 'nothing was approved');
    assert.equal(h.state.loadCanonicalPlan(id, 'Acme').playlists.some((p) => p.id === 'pl-delta-test'), false, 'nothing reached the canonical plan');
  });

  it('a generated parallel playlist cannot be approved or run: one engine call in flight is a server budget assumption', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const pl = gatedPlaylist();
    (pl as Record<string, unknown>).parallel = true;
    h.onSpawn = planWorker({ kind: 'appended', playlist: pl, rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const review = h.state.load(id).plans[0];
    assert.equal(review.review?.ok, false);
    assert.match(review.review!.errors.join(' '), /runs its tasks in parallel.*one engine call at a time/);
    const spawned = h.workers.length;
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: review.contentHash } });
    assert.equal(r.status, 409);
    assert.match(String(r.body.message ?? ''), /parallel/, 'the reviewer is told why');
    assert.equal(h.state.load(id).plans[0].status, 'pending', 'nothing was approved');
    assert.equal(h.state.loadCanonicalPlan(id, 'Acme').playlists.some((p) => p.parallel), false, 'no parallel playlist reached the canonical plan');
    const run = await h.request('POST', `/api/projects/${id}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(run.status, 409);
    assert.equal(run.body.error, 'plan-not-approved');
    assert.equal(h.workers.length, spawned, 'no run worker was spawned');
    assert.equal(r.body.error, 'review-errors', 'a parallel refusal is not an engine problem');
    assert.deepEqual(r.body.errors, review.review!.errors, 'the review errors are returned as a list too');
  });

  it('a refusal that mixes a forbidden engine with another review error is review-errors and names both', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    const pl = gatedPlaylist();
    (pl as Record<string, unknown>).parallel = true;
    (pl.tasks as Array<Record<string, unknown>>)[0].engine = 'custom';
    h.onSpawn = planWorker({ kind: 'appended', playlist: pl, rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: h.state.load(id).plans[0].contentHash } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'review-errors');
    assert.match(String(r.body.message), /uses engine "custom"/);
    assert.match(String(r.body.message), /runs its tasks in parallel/);
    assert.equal((r.body.errors as string[]).length, 2);
  });

  /** A plan generated normally and still pending, then edited in state as if stored before a review rule existed (its stored review still says ok). */
  async function legacyPendingPlan(edit: (pl: Record<string, unknown>) => void): Promise<{ id: string; planId: string; hash: string }> {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    h.state.update(id, (s) => {
      const p = s.plans[0];
      edit(p.playlist as unknown as Record<string, unknown>);
      p.contentHash = contentHash(p.playlist);
    });
    const stored = h.state.load(id).plans[0];
    assert.equal(stored.review?.ok, true, 'the stored review predates the rule');
    return { id, planId, hash: stored.contentHash! };
  }

  it('a stored pending parallel plan (reviewed ok before the rule existed) cannot be approved: 409 review-errors', async () => {
    const { id, planId, hash } = await legacyPendingPlan((pl) => { pl.parallel = true; });
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'review-errors');
    assert.match(String(r.body.message), /runs its tasks in parallel.*one engine call at a time/);
    const after = h.state.load(id).plans[0];
    assert.equal(after.status, 'pending', 'nothing was approved');
    assert.equal(after.approvedEngine, undefined);
    assert.equal(h.auditEntries().some((e) => e.action === 'plan.approve'), false);
    assert.equal(h.state.loadCanonicalPlan(id, 'Acme').playlists.some((p) => p.parallel), false, 'no parallel playlist reached the canonical plan');
    // It can still be rejected, and the same plan without the flag is approvable: the flag is what was refused.
    h.state.update(id, (s) => { const p = s.plans[0]; delete (p.playlist as unknown as Record<string, unknown>).parallel; p.contentHash = contentHash(p.playlist); });
    const ok = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: h.state.load(id).plans[0].contentHash } });
    assert.equal(ok.status, 200, ok.raw);
  });

  it('a stored pending plan with a cwd outside the workspace is refused at approve with review-errors; a stored forbidden engine stays engine-not-allowed', async () => {
    const cwd = await legacyPendingPlan((pl) => { (pl.tasks as Array<Record<string, unknown>>)[0].cwd = '../other-project'; });
    const r = await h.request('POST', `/api/projects/${cwd.id}/plans/${cwd.planId}/approve`, { as: 'reviewer', body: { contentHash: cwd.hash } });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'review-errors');
    assert.match(String(r.body.message), /outside the project workspace/);
    await h.close();
    h = await startHarness();
    const eng = await legacyPendingPlan((pl) => { (pl.tasks as Array<Record<string, unknown>>)[0].engine = 'copilot'; });
    const r2 = await h.request('POST', `/api/projects/${eng.id}/plans/${eng.planId}/approve`, { as: 'reviewer', body: { contentHash: eng.hash } });
    assert.equal(r2.status, 409, r2.raw);
    assert.equal(r2.body.error, 'engine-not-allowed');
    assert.equal(h.state.load(eng.id).plans[0].status, 'pending');
  });

  it('a stored already-approved parallel plan cannot be started: 409 review-errors, no worker, no run record', async () => {
    const { projectId, planId } = await approvedProject(h);
    const setParallel = (where: 'review' | 'canonical', on: boolean): void => {
      if (where === 'review') {
        h.state.update(projectId, (s) => {
          const pl = s.plans[0].playlist as unknown as Record<string, unknown>;
          if (on) { pl.parallel = true; } else { delete pl.parallel; }
        });
        return;
      }
      const canonical = h.state.loadCanonicalPlan(projectId, 'Acme', 'claude');
      canonical.playlists[h.state.load(projectId).plans[0].playlistIndex!].parallel = on ? true : undefined;
      h.state.saveCanonicalPlan(projectId, canonical, 'claude');
    };
    const spawned = h.workers.length;
    const refused = async (what: string): Promise<void> => {
      const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
      assert.equal(r.status, 409, `${what}: ${r.raw}`);
      assert.equal(r.body.error, 'review-errors', what);
      assert.match(String(r.body.message), /^This plan no longer passes review, so it cannot start\. .*runs its tasks in parallel/, what);
      assert.equal(h.workers.length, spawned, `${what}: no run worker was spawned`);
      assert.equal(h.state.load(projectId).runs.length, 0, `${what}: no run record`);
      assert.equal(h.state.load(projectId).plans[0].status, 'approved', `${what}: the plan is not marked ran`);
      assert.equal(h.auditEntries().some((e) => e.action === 'run.start'), false, what);
    };
    // As a legacy approval looks: both the approved playlist and the canonical copy are parallel.
    setParallel('review', true);
    setParallel('canonical', true);
    assert.equal(h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').playlists.at(-1)?.parallel, true, 'the canonical plan really is parallel');
    await refused('both copies parallel');
    // Either copy alone is enough: the runner loads the canonical one.
    setParallel('review', false);
    await refused('only the canonical playlist is parallel');
    setParallel('review', true);
    setParallel('canonical', false);
    await refused('only the approved playlist is parallel');
    // Without the flag the same approved plan starts: the flag is what was refused.
    setParallel('review', false);
    const ok = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(ok.status, 202, ok.raw);
    assert.equal(h.workers.length, spawned + 1);
  });

  // ─── The plan card is drawn from today's review, not from the one stored with the plan ───

  type PlanCard = {
    id: string; status: string; allowedActions: string[]; startBlockedReason?: string | null; startBlockedErrors?: string[];
    review?: { ok: boolean; errors: string[]; commands: unknown[] };
  };
  const planCard = async (projectId: string, as: string): Promise<PlanCard> => {
    const r = await h.request('GET', `/api/projects/${projectId}`, { as });
    assert.equal(r.status, 200, r.raw);
    return (r.body.plans as PlanCard[])[0];
  };

  it('plan DTO: a stored pending plan a review rule now refuses is sent as failing review, with no plan.approve; reject and cancel stay', async () => {
    const { id, planId, hash } = await legacyPendingPlan((pl) => { pl.parallel = true; });
    const seen = await planCard(id, 'reviewer');
    assert.equal(seen.status, 'pending');
    assert.equal(seen.review?.ok, false, 'the card shows the review of today');
    assert.match(seen.review!.errors.join(' '), /runs its tasks in parallel.*one engine call at a time/);
    assert.deepEqual(seen.allowedActions, ['plan.reject'], 'no Approve button for a plan the approve route refuses');
    assert.deepEqual((await planCard(id, 'po')).allowedActions, ['plan.cancel'], 'the requester can still cancel it');
    assert.ok(Array.isArray(seen.review!.commands), 'the rest of the stored review is kept');
    assert.equal(h.state.load(id).plans[0].review?.ok, true, 'nothing is written back: the DTO is derived on read');
    // The DTO and the guard agree: the click the card no longer offers would have been refused, for the same reasons.
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(r.status, 409, r.raw);
    assert.deepEqual(r.body.errors, seen.review!.errors);
    // Without the flag the same plan is offered for approval again.
    h.state.update(id, (s) => { const p = s.plans[0]; delete (p.playlist as unknown as Record<string, unknown>).parallel; p.contentHash = contentHash(p.playlist); });
    const clean = await planCard(id, 'reviewer');
    assert.equal(clean.review?.ok, true);
    assert.deepEqual(clean.allowedActions, ['plan.approve', 'plan.reject']);
  });

  it('plan DTO: a pending plan with a cwd outside the workspace or a forbidden engine is not offered for approval either', async () => {
    const cwd = await legacyPendingPlan((pl) => { (pl.tasks as Array<Record<string, unknown>>)[0].cwd = '../other-project'; });
    const seen = await planCard(cwd.id, 'reviewer');
    assert.equal(seen.review?.ok, false);
    assert.match(seen.review!.errors.join(' '), /outside the project workspace/);
    assert.deepEqual(seen.allowedActions, ['plan.reject']);
    await h.close();
    h = await startHarness();
    const eng = await legacyPendingPlan((pl) => { (pl.tasks as Array<Record<string, unknown>>)[0].engine = 'copilot'; });
    const forbidden = await planCard(eng.id, 'reviewer');
    assert.equal(forbidden.review?.ok, false);
    assert.deepEqual(forbidden.allowedActions, ['plan.reject']);
  });

  it('plan DTO: an approved plan a review rule now refuses offers no run.start and says why (review-errors, with the errors)', async () => {
    const { projectId, planId } = await approvedProject(h);
    assert.deepEqual((await planCard(projectId, 'reviewer')).allowedActions, ['run.start'], 'offered while the plan passes');
    assert.equal((await planCard(projectId, 'reviewer')).startBlockedReason, null);
    assert.equal('startBlockedErrors' in (await planCard(projectId, 'reviewer')), false);
    const setParallel = (where: 'review' | 'canonical', on: boolean): void => {
      if (where === 'review') {
        h.state.update(projectId, (s) => {
          const pl = s.plans[0].playlist as unknown as Record<string, unknown>;
          if (on) { pl.parallel = true; } else { delete pl.parallel; }
        });
        return;
      }
      const canonical = h.state.loadCanonicalPlan(projectId, 'Acme', 'claude');
      canonical.playlists[h.state.load(projectId).plans[0].playlistIndex!].parallel = on ? true : undefined;
      h.state.saveCanonicalPlan(projectId, canonical, 'claude');
    };
    const blocked = async (what: string): Promise<void> => {
      for (const as of ['reviewer', 'admin']) {
        const card = await planCard(projectId, as);
        assert.deepEqual(card.allowedActions, [], `${what}, ${as}: no Start run`);
        assert.equal(card.startBlockedReason, 'review-errors', what);
        assert.match((card.startBlockedErrors ?? []).join(' '), /runs its tasks in parallel/, what);
      }
      // The DTO mirrors the guard: the same errors the start route answers with.
      const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
      assert.equal(r.status, 409, `${what}: ${r.raw}`);
      assert.equal(r.body.error, 'review-errors', what);
      assert.deepEqual(r.body.errors, (await planCard(projectId, 'reviewer')).startBlockedErrors, what);
    };
    // Either copy of the playlist is enough, as it is for the start route.
    setParallel('review', true);
    await blocked('only the approved playlist is parallel');
    setParallel('canonical', true);
    await blocked('both copies parallel');
    setParallel('review', false);
    await blocked('only the canonical playlist is parallel');
    setParallel('canonical', false);
    const ok = await planCard(projectId, 'reviewer');
    assert.deepEqual([ok.allowedActions, ok.startBlockedReason], [['run.start'], null], 'offered again once the plan passes');
    assert.equal('startBlockedErrors' in ok, false);
  });

  it('plan DTO: a reason checked before the review keeps its place — a job in flight is still job-active', async () => {
    const { projectId, planId } = await approvedProject(h);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    h.state.update(projectId, (s) => { (s.plans[0].playlist as unknown as Record<string, unknown>).parallel = true; });
    const card = await planCard(projectId, 'reviewer');
    assert.equal(card.startBlockedReason, 'job-active');
    assert.equal('startBlockedErrors' in card, false, 'the errors ride only with their own reason');
    assert.deepEqual(card.allowedActions, []);
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

  it('a gate decision that resumes the run re-runs plan review: a legacy parallel run halted at its gate cannot be approved or skipped, only rejected', async () => {
    const { projectId, runId } = await haltAtGate();
    const snapPath = path.join(h.state.runDir(projectId, runId), 'plan.json');
    const setParallel = (where: 'review' | 'snapshot', on: boolean): void => {
      if (where === 'review') {
        h.state.update(projectId, (s) => {
          const pl = s.plans[0].playlist as unknown as Record<string, unknown>;
          if (on) { pl.parallel = true; } else { delete pl.parallel; }
        });
        return;
      }
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
      const pl = snap.playlists[h.state.load(projectId).plans[0].playlistIndex!];
      if (on) { pl.parallel = true; } else { delete pl.parallel; }
      fs.writeFileSync(snapPath, JSON.stringify(snap));
    };
    const spawned = h.workers.length;
    const refused = async (kind: 'approve' | 'skip', what: string): Promise<void> => {
      const before = fs.readFileSync(snapPath, 'utf-8');
      const r = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/${kind}`, { as: kind === 'skip' ? 'admin' : 'approver', body: kind === 'skip' ? { reason: 'hotfix' } : {} });
      assert.equal(r.status, 409, `${what}, ${kind}: ${r.raw}`);
      assert.equal(r.body.error, 'review-errors', `${what}, ${kind}`);
      assert.match(String(r.body.message), /^This plan no longer passes review, so the run cannot resume\. Reject the ship and request a new plan\. .*runs its tasks in parallel/, what);
      assert.ok(Array.isArray(r.body.errors) && (r.body.errors as string[]).length > 0, what);
      assert.equal(h.workers.length, spawned, `${what}, ${kind}: no segment was spawned`);
      const run = h.state.load(projectId).runs[0];
      assert.equal(run.status, 'awaiting-approval', `${what}, ${kind}: still waiting`);
      assert.equal(run.segments, 1, what);
      assert.ok(run.gate, 'the gate is still open');
      assert.deepEqual(run.gateDecisions ?? [], [], 'no decision was recorded');
      assert.equal(fs.readFileSync(snapPath, 'utf-8'), before, `${what}, ${kind}: the snapshot was not rewritten`);
      assert.equal(h.auditEntries().some((e) => e.action === 'gate.approve' || e.action === 'gate.skip'), false, what);
    };
    // As a run started before the rule existed looks: the approved playlist and the snapshot the segment loads are parallel.
    setParallel('review', true);
    setParallel('snapshot', true);
    await refused('approve', 'both copies parallel');
    await refused('skip', 'both copies parallel');
    // Either copy alone is enough: the next segment loads the snapshot.
    setParallel('review', false);
    await refused('approve', 'only the snapshot is parallel');
    await refused('skip', 'only the snapshot is parallel');
    setParallel('review', true);
    setParallel('snapshot', false);
    await refused('approve', 'only the approved playlist is parallel');
    // The way out: rejecting the ship is not a resume, and stays possible.
    const rejected = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/reject`, { as: 'approver', body: { note: 'plan no longer passes review' } });
    assert.equal(rejected.status, 200, rejected.raw);
    assert.equal(h.state.load(projectId).runs[0].status, 'ship-rejected');
    assert.equal(h.workers.length, spawned);
  });

  it('a gate resume of a plan that still passes review goes through once the flag is gone: the flag is what was refused', async () => {
    const { projectId, runId } = await haltAtGate();
    h.state.update(projectId, (s) => { (s.plans[0].playlist as unknown as Record<string, unknown>).parallel = true; });
    const spawned = h.workers.length;
    const no = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(no.status, 409, no.raw);
    assert.equal(no.body.error, 'review-errors');
    h.state.update(projectId, (s) => { delete (s.plans[0].playlist as unknown as Record<string, unknown>).parallel; });
    const ok = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(ok.status, 202, ok.raw);
    assert.equal(h.workers.length, spawned + 1);
    assert.equal(h.state.load(projectId).runs[0].status, 'running');
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

  it('approval binds the engine the pending card shows: a default changed while pending is 409 and nothing is approved', async () => {
    const id = await newProject();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string; engine: string }).id;
    assert.equal((g.body.plan as { engine: string }).engine, 'claude');
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const hash = h.state.load(id).plans[0].contentHash;
    const patch = await h.request('PATCH', `/api/projects/${id}`, { as: 'po', body: { defaultEngine: 'codex' } });
    assert.equal(patch.status, 200, patch.raw);
    const r = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'engine-changed');
    assert.match(String(r.body.message), /generated for claude, but the project now uses codex/);
    const after = h.state.load(id).plans[0];
    assert.equal(after.status, 'pending');
    assert.equal(after.approvedEngine, undefined);
    assert.equal(h.auditEntries().filter((e) => e.action === 'plan.approve').length, 0);
    // Switching back makes the shown engine current again: approval records it.
    await h.request('PATCH', `/api/projects/${id}`, { as: 'po', body: { defaultEngine: 'claude' } });
    const ok = await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(h.state.load(id).plans[0].approvedEngine, 'claude');
    const audit = h.auditEntries().find((e) => e.action === 'plan.approve');
    assert.equal((audit?.after as { engine?: string }).engine, 'claude', 'the audit names the bound engine');
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
    // The server ship gate now sits between the generated gate and the release: segment 2 reaches it first.
    const shipGate = h.state.load(projectId).plans[0].playlist!.tasks.find((t) => t.name === 'Ship approval')!;
    w.line({ event: 'state', state: 'playing' });
    w.line({ event: 'task-started', id: shipGate.id, name: shipGate.name });
    w.line({ event: 'cost', usd: 1.5 });
    // While segment 2 runs, the DTO still shows segment 1's work.
    const mid = await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
    const midRun = (mid.body.runs as Array<{ view: { tasks: Record<string, string>; costUsd: number } }>)[0];
    assert.equal(midRun.view.tasks[shipGate.id], 'running');
    assert.equal(midRun.view.tasks['t-impl'], 'completed');
    assert.equal(midRun.view.costUsd, 3.5);
    const detailTasks = (mid.body.currentRun as { tasks: Array<{ id: string; status: string }> }).tasks;
    assert.equal(detailTasks.find((t) => t.id === 't-impl')?.status, 'completed');
    w.line({ event: 'manual-gate', id: shipGate.id, name: shipGate.name });
    w.exit(3);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'awaiting-approval');
    const end = h.state.load(projectId).runs[0].view!;
    assert.deepEqual(
      { impl: end.tasks['t-impl'], gate: end.tasks['t-gate'], rel: end.tasks['t-rel'] },
      { impl: 'completed', gate: 'completed', rel: 'pending' },
      'the release has not run: it waits for the ship gate',
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
  async function haltAtShipGate(preGate?: Record<string, unknown>): Promise<{ projectId: string; runId: string; shipGateId: string }> {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const runId = (r.body.run as { id: string }).id;
    const w = h.workers.at(-1)!;
    const snapPath = (w.job as { planPath: string }).planPath;
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    const tasks = snap.playlists.at(-1).tasks as Array<{ id: string; name: string; status?: string; dependsOn?: string[] }>;
    const shipGate = tasks.find((t) => t.name === 'Ship approval')!;
    // Upstream of the gate done, the gate aborted (Failed), the release behind it blocked.
    for (const t of tasks) {
      t.status = t.id === shipGate.id ? 'failed' : (t.dependsOn ?? []).includes(shipGate.id) ? 'blocked' : 'completed';
    }
    assert.equal(tasks.find((t) => t.id === 't-rel')?.status, 'blocked', 'the release waits behind the ship gate');
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    // The standards check a real worker makes when it halts at the gate, when the test gives one.
    if (preGate) { w.line(preGate); }
    w.line({ event: 'manual-gate', id: shipGate.id, name: shipGate.name });
    w.exit(3);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'awaiting-approval');
    if (preGate) { await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined); }
    return { projectId, runId, shipGateId: shipGate.id };
  }

  /** What the resumed worker leaves for the release task that runs after approval. */
  function releaseRan(w: FakeWorker, status: 'completed' | 'failed' | 'skipped'): void {
    const snapPath = (w.job as { planPath: string }).planPath;
    const snap = loadPlan(snapPath);
    const rel = snap.playlists.at(-1)!.tasks.find((t) => t.id === 't-rel')!;
    rel.status = status as TaskStatus;
    fs.writeFileSync(snapPath, JSON.stringify(dehydratePlan(snap)));
  }

  /**
   * What the resumed worker's verify pass leaves behind: the gate results it recorded in its
   * snapshot, and the standards report it sent — a passing one, made with the job file's
   * own profile and base, unless `standards` says otherwise ('none' sends no report).
   */
  function verifyPass(w: FakeWorker, gates: Array<{ command: string; exitCode: number }>, standards: Record<string, unknown> | 'none' = {}): void {
    const snapPath = (w.job as { planPath: string }).planPath;
    const snap = loadPlan(snapPath);
    recordGateResults(snap, gates.map((g) => ({ ...g, timedOut: false })), new Date().toISOString());
    fs.writeFileSync(snapPath, JSON.stringify(dehydratePlan(snap)));
    if (standards !== 'none') { attestStandards(w, standards); }
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
    assert.equal(resumed.playlists.at(-1)!.tasks.find((t) => t.id === 't-rel')?.status, TaskStatus.Pending, 'the release runs only now, after approval');
    releaseRan(w, 'completed');
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).some((r) => r.releases.length > 0));
    const rows = await traceRows(projectId);
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.releaseTag]), [
      ['R-1', 'shipped', `ship-${runId}`],
      ['R-2', 'shipped', `ship-${runId}`],
    ]);
    // Each release row records the standards version the run was frozen on.
    assert.equal(h.state.load(projectId).runs[0].standardsVersion, 1);
    assert.deepEqual((rows as unknown as Array<{ standardsVersion: number | null }>).map((row) => row.standardsVersion), [1, 1]);
    const canonical = h.state.loadCanonicalPlan(projectId, 'Acme', 'claude');
    assert.ok((canonical.requirementTrace ?? []).every((rec) => rec.releases.at(-1)?.standardsVersion === 1), 'the stamp survives the merge into the canonical plan');
    // This project's standards have no command and promote no rule: the release ships, and its
    // stamp says "no blocking rules configured" beside the version — never that anything passed.
    assert.deepEqual(h.standards.effective(projectId)!.profile.commands, []);
    const counts = { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true };
    assert.deepEqual((rows as unknown as Array<{ standardsCounts: unknown }>).map((row) => row.standardsCounts), [counts, counts]);
    assert.ok((canonical.requirementTrace ?? []).every((rec) => isDeepStrictEqual(rec.releases.at(-1)?.standardsCounts, counts)));
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    assert.equal(h.state.load(projectId).runs[0].standardsSummary!.passed, 0, 'nothing passed: no command ran');
  });

  it('gate approve → failing verify: nothing ships', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const ap = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(ap.status, 202, ap.raw);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'completed');
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

  // ─── Standards on a run: frozen version, base ref, report, ship blocking ───

  /** A `verify-standards` line as the worker's verify pass (or its pre-gate check) emits it. */
  function standardsLine(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      event: 'verify-standards', phase: 'verify', version: 1, baseRef: FAKE_HEAD,
      // A nested repository blocks only where the approved profile promotes the rule (see
      // `withBlockingNestedRule`); every scan advises by default.
      rules: [
        { rule: 'structure/nested-repository', result: 'failed' },
        { rule: 'naming/files', result: 'passed' },
        { rule: 'layering/imports', result: 'not-checked', reason: 'No checker for .rs files' },
        { rule: 'command', result: 'not-checked', reason: 'A standards rule failed first', command: 'npm run lint' },
      ],
      findings: [{ file: 'src/api/cart', line: 1, rule: 'structure/nested-repository', message: 'src/api/cart is a git repository of its own' }],
      notCheckedFiles: [{ file: 'src/engine.rs', reason: 'No checker for .rs files' }],
      totals: { passed: 0, noFindings: 1, failed: 1, notChecked: 2, findings: 1, notCheckedFiles: 1 },
      ...over,
    };
  }

  it('a run job carries the approved standards from a server-written file, and the run record freezes version, hash and base ref', async () => {
    const { projectId, planId } = await approvedProject(h);
    const approved = h.standards.effective(projectId)!;
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const runId = (r.body.run as { id: string }).id;
    const job = h.workers.at(-1)!.job as RunJob;
    assert.equal(job.standardsPath, path.join(h.state.runDir(projectId, runId), 'standards.json'), 'beside job.json, in the data dir');
    const file = readStandardsJobFile(job.standardsPath!);
    assert.equal(file.version, approved.version);
    assert.equal(file.contentHash, approved.contentHash);
    assert.equal(file.baseRef, FAKE_HEAD, 'HEAD as the server read it at run start');
    assert.deepEqual(file.profile, approved.profile);
    assert.equal(file.promptText, renderStandardsText(approved.profile, approved.version), 'the prompt text is rendered by the server');
    assert.deepEqual(verifyArgv(job).slice(-2), ['--standards', job.standardsPath]);

    const run = h.state.load(projectId).runs[0];
    assert.equal(run.standardsVersion, approved.version);
    assert.equal(run.standardsHash, approved.contentHash);
    assert.equal(run.baseRef, FAKE_HEAD);
    assert.equal(run.standardsSummary, undefined, 'no report yet');
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
    assert.equal((dto.body.runs as Array<{ standardsVersion: number }>)[0].standardsVersion, approved.version);
    assert.equal('standardsReport' in (dto.body.currentRun as object), false, 'no report is not an empty report');
  });

  it('a version approved after run start does not change the running run, and its command never reaches the worker', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const v1 = h.standards.effective(projectId)!;
    // v2 adds a command; it is approved while the run waits at the ship gate.
    const profile = sampleProfile();
    profile.commands = [{ label: 'Extra', run: 'npm run added-after-run-start' }];
    const proposed = await h.request('POST', `/api/projects/${projectId}/standards/versions`, { as: 'po', body: { profile, baseVersion: 1 } });
    assert.equal(proposed.status, 201, proposed.raw);
    const v2 = h.standards.pending(projectId)!;
    assert.equal((await h.request('POST', `/api/projects/${projectId}/standards/versions/2/approve`, {
      as: 'reviewer', body: { contentHash: v2.contentHash, acknowledgedEnforcementHash: v2.contentHash },
    })).status, 200);
    assert.equal(h.standards.effective(projectId)!.version, 2);

    const ap = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(ap.status, 202, ap.raw);
    const job = h.workers.at(-1)!.job as RunJob;
    const raw = fs.readFileSync(job.standardsPath!, 'utf-8');
    const file = readStandardsJobFile(job.standardsPath!);
    assert.equal(file.version, 1, 'the resumed segment is rewritten from the RECORDED version');
    assert.deepEqual(file.profile.commands, v1.profile.commands);
    assert.equal(file.baseRef, FAKE_HEAD, 'and keeps the base ref captured at run start');
    assert.ok(!raw.includes('added-after-run-start'), 'a command absent from the frozen version is not in the job file');
    const argv = verifyArgv(job);
    assert.ok(!argv.includes('--gate') && !argv.join(' ').includes('added-after-run-start'), 'and never in the verify arguments');
    assert.equal(h.state.load(projectId).runs[0].standardsVersion, 1);
  });

  it('a repository with no commits freezes a null base ref (every file counts as added)', async () => {
    await h.close();
    h = await startHarness({ gitHead: () => null });
    const { projectId, planId } = await approvedProject(h);
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } })).status, 202);
    assert.equal(h.state.load(projectId).runs[0].baseRef, null);
    assert.equal(readStandardsJobFile((h.workers.at(-1)!.job as RunJob).standardsPath!).baseRef, null);
  });

  // The diff base is the last ref that SHIPPED. With HEAD-at-run-start as the base, work a
  // run committed without shipping fell out of every later diff and was forgiven for good.
  it('a violation committed between runs is still in the next run\'s diff: violating run → commit → clean delta run ends gaps, nothing ships', async function () {
    this.timeout(60000);
    await h.close();
    let repo = '';
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
    // The project's approved standards promote the placeholder-phrase scan: a finding of it stops a ship.
    h = await startHarness({ gitHead: () => (repo ? git('rev-parse', 'HEAD') : null), promoteRules: ['comment-policy/banned-phrase'] });
    const workspace = path.join(h.root, 'acme');
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: workspace });
      repo = workspace;
      git('config', 'user.email', 't@t.t');
      git('config', 'user.name', 't');
      git('config', 'core.autocrlf', 'false');
      fs.writeFileSync(path.join(repo, 'README.md'), '# acme\n');
      git('add', '-A');
      git('commit', '-qm', 'seed');
    } catch (err) {
      if (err instanceof Error && /spawn EPERM/i.test(err.message)) { this.skip(); return; }
      throw err;
    }
    const seed = git('rev-parse', 'HEAD');

    /** What a real worker does at verify: check the workspace against the job file, report, exit on the result. */
    const verifyStandards = async (w: FakeWorker): Promise<StandardsReport> => {
      const file = readStandardsJobFile((w.job as RunJob).standardsPath!);
      const report = checkStandards(file.profile, await collectStandardsInput(repo, file.baseRef, { probeDirs: file.profile.structure.requiredDirs }));
      report.version = file.version;
      w.line({ event: 'verify-standards', phase: 'verify', ...report, contentHash: file.contentHash, recordedBaseRef: file.baseRef });
      w.line({ event: 'verify-finished', passed: report.totals.failed === 0, score: 0, failedGate: report.totals.failed > 0 ? 'standards' : null, iterations: 1 });
      w.exit(report.totals.failed > 0 ? 1 : 0);
      return report;
    };

    // Run 1 writes commented-out code and a banned phrase, and ends gaps.
    const { projectId, planId } = await approvedProject(h);
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } })).status, 202);
    assert.equal(h.state.load(projectId).runs[0].baseRef, seed, 'the first run diffs against HEAD as it stood');
    fs.mkdirSync(path.join(repo, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'api', 'orders.ts'),
      'export const orders = [];\n// const cache = warm(orders);\n// The rest of the code goes here.\n');
    const first = await verifyStandards(h.workers.at(-1)!);
    assert.deepEqual(first.findings.map((f) => [f.file, f.line, f.rule]), [
      ['src/api/orders.ts', 2, 'comment-policy/commented-out-code'],
      ['src/api/orders.ts', 3, 'comment-policy/banned-phrase'],
    ]);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    assert.equal(h.state.load(projectId).lastShipped, undefined, 'a run that did not ship never moves the base');

    // The violating work is committed — what a full-auto agent's `git commit` does.
    git('add', '-A');
    git('commit', '-qm', 'orders');
    const afterCommit = git('rev-parse', 'HEAD');
    assert.notEqual(afterCommit, seed);

    // PRD v2 adds an unrelated requirement; its delta plan runs and writes only clean code.
    const prd = await h.request('GET', `/api/projects/${projectId}/prd`, { as: 'po' });
    const latest = prd.body.latest as { createdAt: string; text: string };
    await new Promise((r) => setTimeout(r, 3));
    const v2 = await h.request('POST', `/api/projects/${projectId}/prd/versions`, { as: 'po', body: { text: `${latest.text}- Users can export orders as CSV\n`, baseCreatedAt: latest.createdAt } });
    assert.equal(v2.status, 201, v2.raw);
    h.onSpawn = planWorker({
      kind: 'appended', rejected: [],
      playlist: { id: 'pl-delta-2', name: 'PRD v1.1.0 delta', autoplay: true, tasks: [{ id: 't-export', name: 'Implement export', prompt: 'do it', requirementIds: ['R-3'] }] },
    });
    const gen = await h.request('POST', `/api/projects/${projectId}/plans`, { as: 'po', body: { mode: 'delta' } });
    assert.equal(gen.status, 202, gen.raw);
    const deltaId = (gen.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(projectId).plans.find((p) => p.id === deltaId)?.status === 'pending');
    const hash = h.state.load(projectId).plans.find((p) => p.id === deltaId)!.contentHash;
    const ap = await h.request('POST', `/api/projects/${projectId}/plans/${deltaId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(ap.status, 200, ap.raw);
    h.onSpawn = () => { /* default */ };
    const started = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId: deltaId } });
    assert.equal(started.status, 202, started.raw);

    const run2 = h.state.load(projectId).runs[1];
    assert.equal(run2.baseRef, seed, 'still the base of the earliest unshipped run, not the HEAD the commit moved to');
    const w2 = h.workers.at(-1)!;
    const jobFile = readStandardsJobFile((w2.job as RunJob).standardsPath!);
    assert.equal(jobFile.baseRef, seed);
    fs.writeFileSync(path.join(repo, 'src', 'api', 'exports.ts'), 'export const toCsv = (rows: string[]): string => rows.join(\'\\n\');\n');

    // From the HEAD the commit moved to, the same tree looks clean: this is the pass the old base gave.
    const fromNewHead = checkStandards(jobFile.profile, await collectStandardsInput(repo, afterCommit, { probeDirs: jobFile.profile.structure.requiredDirs }));
    assert.deepEqual(fromNewHead.findings, []);

    const second = await verifyStandards(w2);
    assert.deepEqual(second.findings.map((f) => [f.file, f.line]), [['src/api/orders.ts', 2], ['src/api/orders.ts', 3]], 'the committed violations are still found');
    await waitFor(() => h.state.load(projectId).runs[1].status === 'gaps');
    await waitFor(() => h.state.load(projectId).runs[1].standardsSummary !== undefined);
    // The promoted placeholder phrase blocks; the commented-out line is advisory and is counted apart.
    assert.equal(h.state.load(projectId).runs[1].standardsSummary!.failed, 1);
    assert.equal(h.state.load(projectId).runs[1].standardsSummary!.advisory, 1);
    assert.equal(h.state.load(projectId).runs[1].standardsSummary!.findings, 2);
    assert.equal(h.state.load(projectId).runs[1].standardsSummary!.advisoryFindings, 1);
    const rows = await traceRows(projectId);
    assert.ok(rows.length >= 3 && rows.every((row) => row.status !== 'shipped' && row.releaseTag === null), JSON.stringify(rows));
    assert.equal(h.state.load(projectId).lastShipped, undefined);
  });

  it('a stamped ship records HEAD as the last-shipped ref, and the next run diffs against it wherever HEAD has moved since', async () => {
    await h.close();
    let head = 'a'.repeat(40);
    h = await startHarness({ gitHead: () => head });
    const { projectId, runId } = await haltAtShipGate();
    assert.equal(h.state.load(projectId).runs[0].baseRef, 'a'.repeat(40));
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'completed');
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    // The run committed its work before it shipped.
    head = 'b'.repeat(40);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => h.state.load(projectId).lastShipped !== undefined);
    const shipped = h.state.load(projectId).lastShipped!;
    assert.deepEqual([shipped.ref, shipped.runId], ['b'.repeat(40), runId]);

    // Someone commits afterwards; the next run still diffs from the shipped ref.
    head = 'c'.repeat(40);
    const planId = h.state.load(projectId).runs[0].planId;
    const again = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(again.status, 202, again.raw);
    assert.equal(h.state.load(projectId).runs[1].baseRef, 'b'.repeat(40));
    assert.equal(readStandardsJobFile((h.workers.at(-1)!.job as RunJob).standardsPath!).baseRef, 'b'.repeat(40));
  });

  it('a ship whose HEAD cannot be read never stores a null base: the previous base stays in force', async () => {
    await h.close();
    let head: string | null = 'a'.repeat(40);
    h = await startHarness({ gitHead: () => head });
    const { projectId, runId } = await haltAtShipGate();
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'completed');
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    // git stops answering just as the run ships.
    head = null;
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => h.state.load(projectId).runs[0].endedAt !== undefined);
    assert.equal(h.state.load(projectId).lastShipped, undefined, 'no ref, so no base is recorded');

    // The next run diffs from the earliest run's base, not from the empty tree.
    head = 'c'.repeat(40);
    const planId = h.state.load(projectId).runs[0].planId;
    const again = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(again.status, 202, again.raw);
    assert.equal(h.state.load(projectId).runs[1].baseRef, 'a'.repeat(40));
  });

  it('a null last-shipped ref stored by an earlier build heals: the base falls back instead of staying null', async () => {
    await h.close();
    h = await startHarness({ gitHead: () => 'a'.repeat(40) });
    const { projectId, runId } = await haltAtShipGate();
    h.state.update(projectId, (s) => { s.lastShipped = { ref: null, runId, at: '2026-09-01T00:00:00.000Z' }; });
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'completed');
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).lastShipped?.ref === 'a'.repeat(40));

    h.state.update(projectId, (s) => { s.lastShipped = { ref: null, runId, at: '2026-09-01T00:00:00.000Z' }; });
    const planId = h.state.load(projectId).runs[0].planId;
    const again = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(again.status, 202, again.raw);
    assert.equal(h.state.load(projectId).runs[1].baseRef, 'a'.repeat(40), 'the earliest run\'s base, never null');
  });

  it('a resumed segment fails closed when the store no longer has the frozen version', async () => {
    const { projectId, runId } = await haltAtShipGate();
    fs.rmSync(h.standards.filePath(projectId));
    const before = h.workers.length;
    const ap = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(ap.status, 409, ap.raw);
    assert.equal(ap.body.error, 'standards-not-approved');
    assert.equal(h.workers.length, before, 'no segment was spawned');
    assert.equal(h.state.load(projectId).runs[0].status, 'awaiting-approval');
  });

  /** Restart the harness with standards that PROMOTE the nested-repository rule, so a static rule can block. */
  async function withBlockingNestedRule(): Promise<void> {
    await h.close();
    h = await startHarness({ promoteRules: ['structure/nested-repository'] });
  }

  /** Restart the harness with standards that carry one command: the blocking set every project should have. */
  async function withLintCommand(): Promise<void> {
    await h.close();
    h = await startHarness({ profileCommands: [{ label: 'Lint', run: 'npm run lint' }] });
  }

  it('approved gate + every task completed + green command gates + a FAILED standards report → gaps, no release stamp, nothing shipped', async () => {
    await withBlockingNestedRule();
    const { projectId, runId } = await haltAtShipGate();
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'completed');
    // The repository's own gates are all green; only the standards gate failed.
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    const snap = loadPlan((w.job as RunJob).planPath);
    assert.ok(snap.playlists.at(-1)!.tasks.every((t) => t.status === TaskStatus.Completed), 'every task is completed');
    w.line(standardsLine());
    w.line({ event: 'verify-finished', passed: false, score: 0, failedGate: 'standards', iterations: 1 });
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);

    const run = h.state.load(projectId).runs[0];
    assert.equal(run.gateDecisions?.at(-1)?.action, 'approve', 'the last gate decision was an approval');
    assert.equal(run.exitCode, 1);
    const rows = await traceRows(projectId);
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.releaseTag]), [['R-1', 'in-progress', null], ['R-2', 'in-progress', null]]);
    const canonical = h.state.loadCanonicalPlan(projectId, 'Acme', 'claude');
    assert.ok((canonical.requirementTrace ?? []).every((rec) => rec.releases.length === 0), 'no release stamp was written');

    // The report reached the run: totals on the record, the full report in the run dir.
    assert.deepEqual({ ...run.standardsSummary, at: '' }, {
      // One blocking failure (the promoted rule) and one blocking row not checked (the command that never ran).
      phase: 'verify', version: 1, passed: 0, noFindings: 1, failed: 1, advisory: 0, notChecked: 2, blockingNotChecked: 1,
      findings: 1, advisoryFindings: 0, notCheckedFiles: 1, at: '',
    });
    assert.equal(JSON.stringify(h.state.load(projectId)).includes('api/cart'), false, 'findings never enter state.json');
    assert.equal(JSON.stringify(h.state.load(projectId)).includes('engine.rs'), false, 'and neither do the names of files that were not checked');
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'approver' });
    const detail = dto.body.currentRun as { standardsReport: { phase: string; report: { rules: Array<{ rule: string; result: string; reason?: string }>; findings: unknown[]; notCheckedFiles: unknown[]; totals: Record<string, number> } } };
    assert.equal(detail.standardsReport.phase, 'verify');
    assert.deepEqual(detail.standardsReport.report.findings,
      [{ file: 'src/api/cart', line: 1, rule: 'structure/nested-repository', message: 'src/api/cart is a git repository of its own', severity: 'blocking' }]);
    // The files no line rule read are in the stored report, with their reason, for the reviewer and the approver.
    assert.deepEqual(detail.standardsReport.report.notCheckedFiles, [{ file: 'src/engine.rs', reason: 'No checker for .rs files' }]);
    assert.equal(detail.standardsReport.report.totals.notCheckedFiles, 1);
    // Not-checked rules are their own result, with a reason, and never in the passed total.
    const notChecked = detail.standardsReport.report.rules.filter((x) => x.result === 'not-checked');
    assert.deepEqual(notChecked.map((x) => x.rule), ['layering/imports', 'command']);
    assert.equal(notChecked[0].reason, 'No checker for .rs files');
    // A scan that found nothing is counted as "no findings", never as passed.
    assert.equal(detail.standardsReport.report.totals.passed, 0);
    assert.equal(detail.standardsReport.report.totals.noFindings, 1);
  });

  // ─── Exit 0 is not proof: the run must show its check was made with what the server froze ───

  /** Approve the ship gate of a halted run and hand back the resumed worker, release done and gates green. */
  async function resumedAfterApprove(projectId: string, runId: string): Promise<FakeWorker> {
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'completed');
    return w;
  }

  async function assertNothingShipped(projectId: string, why: RegExp): Promise<void> {
    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    const run = h.state.load(projectId).runs[0];
    assert.equal(run.exitCode, 1);
    assert.match(run.errorTail ?? '', why);
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    const rows = await traceRows(projectId);
    assert.ok(rows.every((row) => row.status !== 'shipped' && row.releaseTag === null), JSON.stringify(rows));
    const canonical = h.state.loadCanonicalPlan(projectId, 'Acme', 'claude');
    assert.ok((canonical.requirementTrace ?? []).every((rec) => rec.releases.length === 0), 'no release stamp was written');
    assert.equal(h.state.load(projectId).lastShipped, undefined, 'and the standards base did not move');
  }

  it('approved gate + green gates + exit 0 but NO verify-phase standards report → gaps, nothing shipped', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], 'none');
    w.exit(0);
    await assertNothingShipped(projectId, /the verification pass sent no standards report/);
  });

  it('a pre-gate report from the earlier segment, or one in this segment, does not stand in for the verify report', async () => {
    const { projectId, planId } = await approvedProject(h);
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } })).status, 202);
    const runId = h.state.load(projectId).runs[0].id;
    const w1 = h.workers.at(-1)!;
    const snapPath = (w1.job as RunJob).planPath;
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    const tasks = snap.playlists.at(-1).tasks as Array<{ id: string; name: string; status?: string; dependsOn?: string[] }>;
    const shipGate = tasks.find((t) => t.name === 'Ship approval')!;
    for (const t of tasks) { t.status = t.id === shipGate.id ? 'failed' : (t.dependsOn ?? []).includes(shipGate.id) ? 'blocked' : 'completed'; }
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    // Segment 1 sends a clean, fully attested VERIFY-shaped report, then halts at the gate.
    attestStandards(w1);
    w1.line({ event: 'manual-gate', id: shipGate.id, name: shipGate.name });
    w1.exit(3);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'awaiting-approval');

    const w2 = await resumedAfterApprove(projectId, runId);
    verifyPass(w2, [{ command: 'npm test', exitCode: 0 }], 'none');
    attestStandards(w2, { phase: 'pre-gate' });
    w2.exit(0);
    await assertNothingShipped(projectId, /the verification pass sent no standards report/);
  });

  it('a standards job file rewritten self-consistently after the tasks ran is caught by the server: gaps, nothing shipped', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const frozen = h.state.load(projectId).runs[0];
    const w = await resumedAfterApprove(projectId, runId);
    const jobFile = (w.job as RunJob).standardsPath!;

    // What an agent running as the worker's uid can do between play() and verify: empty the
    // profile's checks and commands, and update the hash so the file still agrees with itself.
    const doc = JSON.parse(fs.readFileSync(jobFile, 'utf-8'));
    doc.profile.comments.forbidCommentedOutCode = false;
    doc.profile.comments.bannedPhrases = [];
    doc.profile.commands = [];
    doc.contentHash = profileHash(doc.profile);
    fs.writeFileSync(jobFile, JSON.stringify(doc));
    const reread = readStandardsJobFile(jobFile);
    assert.notEqual(reread.contentHash, frozen.standardsHash, 'the worker\'s own hash check accepts the rewritten file');

    // The worker reports what it actually used — which is what the rewritten file says.
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await assertNothingShipped(projectId, /not made against the approved standards v1/);
  });

  it('a job file whose base ref was moved to the current HEAD is caught the same way', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    const jobFile = (w.job as RunJob).standardsPath!;
    const doc = JSON.parse(fs.readFileSync(jobFile, 'utf-8'));
    assert.equal(doc.baseRef, FAKE_HEAD);
    doc.baseRef = 'f'.repeat(40);
    fs.writeFileSync(jobFile, JSON.stringify(doc));
    assert.equal(readStandardsJobFile(jobFile).baseRef, 'f'.repeat(40), 'the file still reads as valid');
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await assertNothingShipped(projectId, /not made against the base recorded for this run/);
  });

  it('a report that omits what it was checked against, or lists a failed rule at exit 0, ships nothing', async () => {
    const a = await haltAtShipGate();
    const wa = await resumedAfterApprove(a.projectId, a.runId);
    verifyPass(wa, [{ command: 'npm test', exitCode: 0 }], { contentHash: undefined, recordedBaseRef: undefined });
    wa.exit(0);
    await assertNothingShipped(a.projectId, /not made against the approved standards v1/);

    await withBlockingNestedRule();
    const b = await haltAtShipGate();
    const wb = await resumedAfterApprove(b.projectId, b.runId);
    verifyPass(wb, [{ command: 'npm test', exitCode: 0 }], {
      rules: [{ rule: 'structure/nested-repository', result: 'failed' }],
      findings: [{ file: 'cloned', line: 1, rule: 'structure/nested-repository', message: 'cloned is a git repository of its own' }],
    });
    wb.exit(0);
    await assertNothingShipped(b.projectId, /the standards report lists a failed blocking rule/);
  });

  it('what blocks is decided by the profile the server froze: a blocking rule the report calls advisory still ships nothing', async () => {
    await withBlockingNestedRule();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [{ rule: 'structure/nested-repository', result: 'failed', severity: 'advisory' }],
      findings: [{ file: 'cloned', line: 1, rule: 'structure/nested-repository', message: 'cloned is a git repository of its own', severity: 'advisory' }],
      totals: { passed: 0, failed: 0, advisory: 1, notChecked: 0, blockingNotChecked: 0, findings: 1, advisoryFindings: 1 },
    });
    w.exit(0);
    await assertNothingShipped(projectId, /the standards report lists a failed blocking rule/);
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.failed, summary.advisory, summary.advisoryFindings], [1, 0, 0], 'the stored totals are the server\'s, not the report\'s');
  });

  it('and the other way round: a rule the frozen profile holds as advisory cannot be made to block by the report', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [
        { rule: 'structure/nested-repository', result: 'passed' },
        { rule: 'comment-policy/banned-phrase', result: 'failed', severity: 'blocking' },
      ],
      findings: [{ file: 'src/a.ts', line: 2, rule: 'comment-policy/banned-phrase', message: 'Banned phrase in a comment', severity: 'blocking' }],
    });
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.failed, summary.advisory, summary.advisoryFindings], [0, 1, 1], 'a text scan is advisory unless the approved profile promotes it');
  });

  it('an advisory failure at exit 0 ships: it is stored, shown with its severity, and stops nothing', async () => {
    await withBlockingNestedRule();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [
        { rule: 'structure/nested-repository', result: 'passed' },
        { rule: 'comment-policy/commented-out-code', result: 'failed' },
        { rule: 'comment-policy/banned-phrase', result: 'passed' },
      ],
      findings: [{ file: 'src/a.ts', line: 2, rule: 'comment-policy/commented-out-code', message: 'Commented-out code' }],
    });
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => h.state.load(projectId).lastShipped !== undefined);
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);

    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.failed, summary.advisory, summary.findings], [0, 1, 1]);
    const rows = await traceRows(projectId);
    assert.ok(rows.every((row) => row.status === 'shipped'), JSON.stringify(rows));
    // The reviewer and the approver still see it, marked for what it is.
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'approver' });
    const detail = dto.body.currentRun as { standardsReport: { report: { rules: Array<{ rule: string; result: string; severity: string }>; findings: Array<{ rule: string; severity: string }> } } };
    assert.deepEqual(detail.standardsReport.report.findings.map((f) => [f.rule, f.severity]), [['comment-policy/commented-out-code', 'advisory']]);
    assert.deepEqual(detail.standardsReport.report.rules.map((r) => [r.rule, r.result, r.severity]), [
      ['structure/nested-repository', 'passed', 'blocking'],
      ['comment-policy/commented-out-code', 'failed', 'advisory'],
      ['comment-policy/banned-phrase', 'passed', 'advisory'],
    ]);
    assert.equal(summary.advisoryFindings, 1);
  });

  // ─── Unevaluated blocking evidence is not a pass: it stops the ship ───

  it('a promoted rule that was not checked ships nothing, whatever the advisory scans read', async () => {
    await withBlockingNestedRule();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      baseRef: null,
      rules: [
        // The one rule that blocks under this profile could not be evaluated; the scans beside it found nothing.
        { rule: 'structure/nested-repository', result: 'not-checked', undecided: true, reason: 'No diff could be taken (not a git repository, or the base ref is unknown)' },
        { rule: 'structure/required-dirs', result: 'passed' },
        { rule: 'naming/files', result: 'passed' },
        { rule: 'comment-policy/commented-out-code', result: 'passed' },
      ],
    });
    w.exit(0);
    await assertNothingShipped(projectId, /the standards report lists a blocking rule or command that was not checked/);
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    assert.equal(h.state.load(projectId).runs[0].standardsSummary!.blockingNotChecked, 1);
  });

  it('a promoted rule the change gave nothing to judge is not checked either: no reason is weighed', async () => {
    await withBlockingNestedRule();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [{ rule: 'structure/nested-repository', result: 'not-checked', reason: 'The diff holds nothing for this rule to check' }],
    });
    w.exit(0);
    await assertNothingShipped(projectId, /a blocking rule or command that was not checked/);
  });

  it('a profile command that never ran is a blocking row that was not evaluated: nothing ships', async () => {
    await withLintCommand();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [
        { rule: 'structure/nested-repository', result: 'passed' },
        { rule: 'command', result: 'not-checked', reason: 'Commands were not run', command: 'npm run lint' },
      ],
    });
    w.exit(0);
    await assertNothingShipped(projectId, /a blocking rule or command that was not checked/);
  });

  it('a report that leaves an approved command out is not "nothing blocking": the server counts the command as not checked', async () => {
    await withLintCommand();
    const { projectId, runId } = await haltAtShipGate();
    assert.deepEqual(h.standards.effective(projectId)!.profile.commands, [{ label: 'Lint', run: 'npm run lint' }]);
    const w = await resumedAfterApprove(projectId, runId);
    // Every row it does send is clean — and the one command the approved profile runs is simply absent.
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [{ rule: 'structure/nested-repository', result: 'passed' }, { rule: 'comment-policy/commented-out-code', result: 'passed' }],
      totals: { passed: 0, noFindings: 2, failed: 0, notChecked: 0, findings: 0 },
    });
    w.exit(0);
    await assertNothingShipped(projectId, /a blocking rule or command that was not checked/);
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.passed, summary.notChecked, summary.blockingNotChecked], [0, 1, 1], 'the stored totals are the server\'s');
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'approver' });
    const rules = (dto.body.currentRun as { standardsReport: { report: { rules: Array<{ rule: string; result: string; command?: string; reason?: string }> } } }).standardsReport.report.rules;
    assert.deepEqual(rules.at(-1), { rule: 'command', severity: 'blocking', result: 'not-checked', reason: 'The report holds no result for this command', command: 'npm run lint' });
  });

  it('a report naming some other command does not stand in for the approved one', async () => {
    await withLintCommand();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [{ rule: 'command', result: 'passed', command: 'true', exitCode: 0 }],
    });
    w.exit(0);
    await assertNothingShipped(projectId, /a blocking rule or command that was not checked/);
  });

  it('a row that calls itself unconfigured cannot take a blocking rule or a command out of the set', async () => {
    await withBlockingNestedRule();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      // `undecided` and `unconfigured` together: the worker's report cannot have it both ways.
      rules: [
        { rule: 'structure/nested-repository', result: 'not-checked', undecided: true, unconfigured: true, reason: 'x' },
        { rule: 'command', result: 'not-checked', unconfigured: true, command: 'npm run lint' },
      ],
    });
    w.exit(0);
    await assertNothingShipped(projectId, /a blocking rule or command that was not checked/);
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    assert.equal(h.state.load(projectId).runs[0].standardsSummary!.blockingNotChecked, 2);
  });

  it('the approved command ran and passed → shipped and stamped, with no "no blocking rules" marker', async () => {
    await withLintCommand();
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).some((r) => r.releases.length > 0));
    const rows = await traceRows(projectId) as unknown as Array<{ status: string; standardsVersion: number | null; standardsCounts: unknown }>;
    const counts = { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0 };
    assert.deepEqual(rows.map((row) => [row.status, row.standardsVersion, row.standardsCounts]), [['shipped', 1, counts], ['shipped', 1, counts]]);
  });

  // ─── The ship gate itself: no approval over a standards check that stops the release ───

  /** A pre-gate report as the worker sends it when it halts at the ship gate, attested like a real one. */
  function preGateLine(rules: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> {
    return { event: 'verify-standards', phase: 'pre-gate', version: 1, baseRef: FAKE_HEAD, rules, findings: [], ...over };
  }

  it('gate approve is refused 409 while the pre-gate report shows a failed command; reject and skip still work', async () => {
    await withLintCommand();
    const { projectId, runId } = await haltAtShipGate(preGateLine([
      { rule: 'structure/nested-repository', result: 'passed' },
      { rule: 'command', result: 'failed', command: 'npm run lint', exitCode: 1, tail: 'src/a.ts: 3 problems' },
    ]));
    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.phase, summary.failed, summary.blockingNotChecked], ['pre-gate', 1, 0]);

    const workers = h.workers.length;
    const audited = h.auditEntries().length;
    const refused = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: { note: 'ship it anyway' } });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.error, 'standards-blocking');
    assert.match(String(refused.body.message), /can't be approved: the standards check before the gate shows that 1 blocking rule or command failed/);
    assert.deepEqual([refused.body.failed, refused.body.blockingNotChecked, refused.body.standardsVersion], [1, 0, 1]);
    assert.equal(h.workers.length, workers, 'no segment was spawned');
    assert.equal(h.auditEntries().length, audited, 'a refused approval writes no audit line');
    const run = h.state.load(projectId).runs[0];
    assert.equal(run.status, 'awaiting-approval');
    assert.deepEqual(run.gateDecisions ?? [], [], 'and records no decision');

    // The approver can still say no.
    const rejected = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/reject`, { as: 'approver', body: { note: 'lint fails' } });
    assert.equal(rejected.status, 200, rejected.raw);
    assert.equal(h.state.load(projectId).runs[0].status, 'ship-rejected');
  });

  it('gate approve is refused 409 while the pre-gate report shows a blocking command or rule not checked', async () => {
    await withLintCommand();
    const a = await haltAtShipGate(preGateLine([
      { rule: 'structure/nested-repository', result: 'passed' },
      { rule: 'command', result: 'not-checked', command: 'npm run lint', reason: 'The check was stopped' },
    ]));
    const refused = await h.request('POST', `/api/projects/${a.projectId}/runs/${a.runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.error, 'standards-blocking');
    assert.match(String(refused.body.message), /1 blocking rule or command was not checked/);
    assert.deepEqual([refused.body.failed, refused.body.blockingNotChecked], [0, 1]);

    // A skip ships nothing, so it is not held back.
    const skipped = await h.request('POST', `/api/projects/${a.projectId}/runs/${a.runId}/gate/skip`, { as: 'admin', body: { reason: 'documentation only' } });
    assert.ok(skipped.status === 202 || skipped.status === 403, skipped.raw);

    // A pre-gate report that leaves the approved command out is the same thing.
    await withLintCommand();
    const b = await haltAtShipGate(preGateLine([{ rule: 'structure/nested-repository', result: 'passed' }]));
    const omitted = await h.request('POST', `/api/projects/${b.projectId}/runs/${b.runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(omitted.status, 409, omitted.raw);
    assert.equal(omitted.body.error, 'standards-blocking');

    // And so is a promoted rule that could not be checked.
    await withBlockingNestedRule();
    const c = await haltAtShipGate(preGateLine([
      { rule: 'structure/nested-repository', result: 'not-checked', undecided: true, reason: 'No diff could be taken' },
    ]));
    const unread = await h.request('POST', `/api/projects/${c.projectId}/runs/${c.runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(unread.status, 409, unread.raw);
    assert.equal(unread.body.error, 'standards-blocking');
  });

  it('gate approve goes through when the pre-gate report stops nothing: commands passed, findings only advisory', async () => {
    await withLintCommand();
    const { projectId, runId } = await haltAtShipGate(preGateLine([
      { rule: 'command', result: 'passed', command: 'npm run lint', exitCode: 0 },
      { rule: 'comment-policy/commented-out-code', result: 'failed' },
      { rule: 'layering/imports', result: 'not-checked', undecided: true, reason: 'No checker for .rs files (src/engine.rs)' },
    ], { findings: [{ file: 'src/a.ts', line: 2, rule: 'comment-policy/commented-out-code', message: 'Commented-out code' }] }));
    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.failed, summary.blockingNotChecked, summary.advisory], [0, 0, 1]);
    const ap = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} });
    assert.equal(ap.status, 202, ap.raw);
  });

  it('gate approve goes through with no blocking rules configured, and with no pre-gate report at all', async () => {
    // The default harness profile: no command, nothing promoted.
    const a = await haltAtShipGate(preGateLine([{ rule: 'structure/nested-repository', result: 'failed' }], {
      findings: [{ file: 'cloned', line: 1, rule: 'structure/nested-repository', message: 'cloned is a git repository of its own' }],
    }));
    const summary = h.state.load(a.projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.failed, summary.advisory, summary.blockingNotChecked], [0, 1, 0], 'an advisory finding, even a nested repository, stops nothing');
    assert.equal((await h.request('POST', `/api/projects/${a.projectId}/runs/${a.runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);

    await h.close();
    h = await startHarness();
    const b = await haltAtShipGate();
    assert.equal(h.state.load(b.projectId).runs[0].standardsSummary, undefined);
    assert.equal((await h.request('POST', `/api/projects/${b.projectId}/runs/${b.runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
  });

  it('the blocking set evaluated → stamped, with what the check left open recorded beside the version', async () => {
    const { projectId, runId } = await haltAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [
        { rule: 'structure/nested-repository', result: 'passed' },
        { rule: 'command', result: 'passed', command: 'npm run lint', exitCode: 0 },
        // Every scan below is advisory under the frozen profile: none of it holds the stamp back.
        { rule: 'comment-policy/commented-out-code', result: 'failed' },
        { rule: 'comment-policy/banned-phrase', result: 'not-checked', undecided: true, reason: 'No checker for .rs files (src/engine.rs)' },
        { rule: 'layering/imports', result: 'not-checked', unconfigured: true, reason: 'Not configured in this profile' },
      ],
      findings: [
        { file: 'src/a.ts', line: 2, rule: 'comment-policy/commented-out-code', message: 'Commented-out code' },
        { file: 'src/a.ts', line: 9, rule: 'comment-policy/commented-out-code', message: 'Commented-out code' },
      ],
      notCheckedFiles: [{ file: 'src/engine.rs', reason: 'No checker for .rs files' }, { file: 'vendor/x/y.go', reason: 'vendored code' }],
      totals: { findings: 2, advisoryFindings: 2, notCheckedFiles: 2 },
    });
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).some((r) => r.releases.length > 0));
    const counts = { advisoryFindings: 2, notCheckedRules: 1, notCheckedFiles: 2 };
    const rows = await traceRows(projectId) as unknown as Array<{ id: string; status: string; standardsVersion: number | null; standardsCounts: unknown }>;
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.standardsVersion, row.standardsCounts]),
      [['R-1', 'shipped', 1, counts], ['R-2', 'shipped', 1, counts]]);
    const canonical = h.state.loadCanonicalPlan(projectId, 'Acme', 'claude');
    assert.ok((canonical.requirementTrace ?? []).every((rec) => isDeepStrictEqual(rec.releases.at(-1)?.standardsCounts, counts)), 'the counts survive the merge into the canonical plan');
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    // One pass: the command. The nested-repository scan found nothing, which is not a pass.
    assert.deepEqual([summary.passed, summary.failed, summary.advisory, summary.advisoryFindings, summary.notCheckedFiles], [1, 0, 1, 2, 2]);
    // Numbers only: neither a finding's file nor a not-checked file's name enters state.json or the trace.
    const stored = JSON.stringify(h.state.load(projectId)) + JSON.stringify(canonical.requirementTrace);
    assert.equal(/engine\.rs|vendor\/x|src\/a\.ts/.test(stored), false);
  });

  // The stored base lives in the agent-writable `.git`. Losing it must not turn the gate off.
  it('a base commit removed from the workspace with plain git: the check falls back to the whole tree, the run ends gaps and nothing is stamped', async function () {
    this.timeout(60000);
    await h.close();
    let repo = '';
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // The approved standards promote the placeholder-phrase scan, so its finding stops the run.
    h = await startHarness({ gitHead: () => (repo ? git('rev-parse', 'HEAD') : null), promoteRules: ['comment-policy/banned-phrase'] });
    const workspace = path.join(h.root, 'acme');
    let branch = '';
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: workspace });
      repo = workspace;
      git('config', 'user.email', 't@t.t');
      git('config', 'user.name', 't');
      git('config', 'core.autocrlf', 'false');
      fs.writeFileSync(path.join(repo, 'README.md'), '# acme\n');
      git('add', '-A');
      git('commit', '-qm', 'seed');
      branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    } catch (err) {
      if (err instanceof Error && /spawn EPERM/i.test(err.message)) { this.skip(); return; }
      throw err;
    }
    const seed = git('rev-parse', 'HEAD');
    const { projectId, runId } = await haltAtShipGate();
    assert.equal(h.state.load(projectId).runs[0].baseRef, seed);

    // Commit X disappears: an orphan history replaces the branch and the old objects are pruned.
    git('checkout', '-q', '--orphan', 'fresh');
    git('add', '-A');
    git('commit', '-qm', 'fresh');
    git('branch', '-D', branch);
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    assert.throws(() => git('cat-file', '-e', `${seed}^{commit}`), 'the recorded base is gone from the repository');

    fs.mkdirSync(path.join(repo, 'src', 'domain'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'domain', 'extra.ts'),
      'export const extra = 1;\n// const cached = cache.get(id);\n// rest of the code goes here\n');

    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], 'none');
    // What the real verify pass does: check the workspace against the job file and exit on the result.
    const file = readStandardsJobFile((w.job as RunJob).standardsPath!);
    assert.equal(file.baseRef, seed, 'the resumed segment still carries the recorded base');
    const report = checkStandards(file.profile, await collectStandardsInput(repo, file.baseRef, { probeDirs: file.profile.structure.requiredDirs }));
    report.version = file.version;
    assert.equal(report.baseRef, EMPTY_TREE_REF, 'not null: the diff was taken, against the empty tree');
    const found = report.findings.filter((f) => f.file === 'src/domain/extra.ts').map((f) => [f.line, f.rule]);
    assert.deepEqual(found, [[2, 'comment-policy/commented-out-code'], [3, 'comment-policy/banned-phrase']]);
    assert.ok(report.totals.failed > 0);
    w.line({ event: 'verify-standards', phase: 'verify', ...report, contentHash: file.contentHash, recordedBaseRef: file.baseRef });
    w.line({ event: 'verify-finished', passed: false, score: 0, failedGate: 'standards', iterations: 1 });
    w.exit(1);

    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary?.phase === 'verify');
    assert.ok(h.state.load(projectId).runs[0].standardsSummary!.failed > 0);
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    const rows = await traceRows(projectId) as unknown as Array<{ status: string; releaseTag: string | null; standardsVersion: number | null }>;
    assert.ok(rows.every((row) => row.status !== 'shipped' && row.releaseTag === null && row.standardsVersion === null), JSON.stringify(rows));
    assert.equal(h.state.load(projectId).lastShipped, undefined);
  });

  // ─── A run started before standards existed, approved at its ship gate afterwards ───

  /** A run halted at its ship gate, rewound to how a run started before the upgrade looks: nothing frozen. */
  async function legacyRunAtShipGate(): Promise<{ projectId: string; runId: string }> {
    const halted = await haltAtShipGate();
    h.state.update(halted.projectId, (s) => {
      delete s.runs[0].standardsVersion;
      delete s.runs[0].standardsHash;
      delete s.runs[0].baseRef;
    });
    return halted;
  }

  it('legacy run: gate approve freezes the effective standards onto the run, and the resumed segment carries them', async () => {
    const { projectId, runId } = await legacyRunAtShipGate();
    const effective = h.standards.effective(projectId)!;
    const w = await resumedAfterApprove(projectId, runId);
    const run = h.state.load(projectId).runs[0];
    assert.deepEqual([run.standardsVersion, run.standardsHash], [effective.version, effective.contentHash]);
    // No ship and no other run recorded a base: never HEAD now (it may be past this run's work), the whole tree.
    assert.equal(run.baseRef, null);
    const job = w.job as RunJob;
    assert.equal(job.standardsPath, path.join(h.state.runDir(projectId, runId), 'standards.json'));
    const file = readStandardsJobFile(job.standardsPath!);
    assert.deepEqual([file.version, file.contentHash, file.baseRef], [effective.version, effective.contentHash, null]);
  });

  it('legacy run: approved, but the verify pass sends no standards report → gaps, nothing shipped', async () => {
    const { projectId, runId } = await legacyRunAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], 'none');
    w.exit(0);
    await assertNothingShipped(projectId, /the verification pass sent no standards report/);
  });

  it('legacy run: approved, and the approved command failed in the verify pass → gaps, nothing shipped', async () => {
    await withLintCommand();
    const { projectId, runId } = await legacyRunAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }], {
      rules: [{ rule: 'command', result: 'failed', command: 'npm run lint', exitCode: 1, tail: 'src/a.ts: 3 problems' }],
      totals: { passed: 0, noFindings: 0, failed: 1, notChecked: 0, findings: 0 },
    });
    w.exit(0);
    await assertNothingShipped(projectId, /a failed blocking rule/);
  });

  it('legacy run: approved and the check proved → shipped, stamped with the standards version frozen at approve', async () => {
    await withLintCommand();
    const { projectId, runId } = await legacyRunAtShipGate();
    const w = await resumedAfterApprove(projectId, runId);
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).some((r) => r.releases.length > 0));
    const rows = await traceRows(projectId) as unknown as Array<{ status: string; standardsVersion: number | null }>;
    assert.deepEqual(rows.map((row) => [row.status, row.standardsVersion]), [['shipped', 1], ['shipped', 1]]);
  });

  it('legacy run: the frozen base is the last ship when there is one', async () => {
    const { projectId, runId } = await legacyRunAtShipGate();
    const shippedRef = 'a'.repeat(40);
    h.state.update(projectId, (s) => { s.lastShipped = { ref: shippedRef, runId: 'earlier', at: '2000-01-01T00:00:00.000Z' }; });
    const w = await resumedAfterApprove(projectId, runId);
    assert.equal(h.state.load(projectId).runs[0].baseRef, shippedRef);
    assert.equal(readStandardsJobFile((w.job as RunJob).standardsPath!).baseRef, shippedRef);
  });

  it('legacy run: a ship or run base recorded after the legacy run started is never its base — it may already hold that run\'s committed work', async () => {
    const { projectId, runId } = await legacyRunAtShipGate();
    const later = '9999-01-01T00:00:00.000Z';
    h.state.update(projectId, (s) => {
      s.lastShipped = { ref: 'b'.repeat(40), runId: 'newer', at: later };
      s.runs.push({ ...s.runs[0], id: 'newer-run', startedAt: later, baseRef: 'c'.repeat(40) });
    });
    const w = await resumedAfterApprove(projectId, runId);
    const run = h.state.load(projectId).runs.find((r) => r.id === runId)!;
    assert.equal(run.baseRef, null, 'neither newer base is used: the whole tree is checked');
    assert.equal(readStandardsJobFile((w.job as RunJob).standardsPath!).baseRef, null);
  });

  it('legacy run: a skip freezes nothing (it ships nothing), and a refused approve leaves the run unfrozen', async () => {
    const a = await legacyRunAtShipGate();
    // The job manager refuses the segment AFTER the standards were set on the in-memory record:
    // the project's job.lock is held by this server with no job of its own behind it.
    const lockPath = h.app.jobs.lockPath(a.projectId);
    fs.writeFileSync(lockPath, String(process.pid));
    const workers = h.workers.length;
    const audited = h.auditEntries().length;
    const refused = await h.request('POST', `/api/projects/${a.projectId}/runs/${a.runId}/gate/approve`, { as: 'approver', body: {} });
    fs.rmSync(lockPath, { force: true });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.error, 'project-locked');
    assert.equal(h.workers.length, workers, 'no segment was spawned');
    assert.equal(h.auditEntries().length, audited, 'nothing audited');
    const kept = h.state.load(a.projectId).runs[0];
    assert.deepEqual([kept.status, kept.standardsVersion, kept.standardsHash, 'baseRef' in kept], ['awaiting-approval', undefined, undefined, false],
      'a refused approve leaves the run exactly as it was');
    assert.deepEqual(kept.gateDecisions ?? [], []);
    // With the lock gone the same approval goes through, and freezes then.
    assert.equal((await h.request('POST', `/api/projects/${a.projectId}/runs/${a.runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    assert.equal(h.state.load(a.projectId).runs[0].standardsVersion, h.standards.effective(a.projectId)!.version);

    await h.close();
    h = await startHarness();
    const b = await legacyRunAtShipGate();
    const skipped = await h.request('POST', `/api/projects/${b.projectId}/runs/${b.runId}/gate/skip`, { as: 'admin', body: { reason: 'documentation only' } });
    assert.equal(skipped.status, 202, skipped.raw);
    const run = h.state.load(b.projectId).runs[0];
    assert.equal(run.standardsVersion, undefined, 'a skip ships nothing, so nothing is frozen');
    assert.equal((h.workers.at(-1)!.job as RunJob).standardsPath, undefined);
  });

  it('a malformed verify-standards payload is dropped without throwing; the run carries on and a later valid report is kept', async () => {
    const { projectId, planId } = await approvedProject(h);
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } })).status, 202);
    const runId = h.state.load(projectId).runs[0].id;
    const w = h.workers.at(-1)!;
    const reportFile = path.join(h.state.runDir(projectId, runId), 'standards-report.json');
    for (const bad of [
      { event: 'verify-standards', rules: 'nope', findings: [] },
      { event: 'verify-standards', rules: [{ rule: 'made-up/rule', result: 'passed' }], findings: [] },
      { event: 'verify-standards', rules: [{ rule: 'naming/files', result: 'probably-fine' }], findings: [] },
      { event: 'verify-standards', rules: [], findings: [{ file: 'a.ts', line: 'one', rule: 'naming/files', message: 'x' }] },
      { event: 'verify-standards' },
    ]) { w.line(bad); }
    w.line({ event: 'task-started', id: 't-impl', name: 'Implement checkout' });
    await waitFor(() => h.app.jobs.view(projectId)?.tasks['t-impl'] === 'running');
    assert.equal(fs.existsSync(reportFile), false, 'nothing malformed was stored');
    assert.equal(h.state.load(projectId).runs[0].standardsSummary, undefined);

    // A report whose claimed totals lie is recounted from its rows, and its command tail is bounded.
    w.line(standardsLine({
      phase: 'pre-gate',
      rules: [{ rule: 'naming/files', result: 'not-checked', reason: 'Not configured in this profile' }, { rule: 'command', result: 'failed', command: 'npm run lint', exitCode: 2, tail: 'x'.repeat(5000) }],
      findings: [], totals: { passed: 99, failed: 0, notChecked: 0, findings: 0 },
    }));
    await waitFor(() => h.state.load(projectId).runs[0].standardsSummary !== undefined);
    const summary = h.state.load(projectId).runs[0].standardsSummary!;
    assert.deepEqual([summary.phase, summary.passed, summary.failed, summary.notChecked], ['pre-gate', 0, 1, 1]);
    const stored = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    assert.equal(stored.report.rules[1].tail.length, 2000);
  });

  it('a red gate never ships, even when the segment exits 0', async () => {
    // Red evidence, exit 0: stampRelease re-checks the gates itself.
    const a = await haltAtShipGate();
    assert.equal((await h.request('POST', `/api/projects/${a.projectId}/runs/${a.runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const wa = h.workers.at(-1)!;
    releaseRan(wa, 'completed');
    verifyPass(wa, [{ command: 'npm test', exitCode: 2 }]);
    wa.exit(0);
    await waitFor(() => h.state.load(a.projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(a.projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    assert.ok((await traceRows(a.projectId)).every((row) => row.status !== 'shipped' && row.releaseTag === null));
  });

  it('an admin skip of the ship gate never ships, even with green evidence', async () => {
    const { projectId, runId, shipGateId } = await haltAtShipGate();
    const skip = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/skip`, { as: 'admin', body: { reason: 'hotfix' } });
    assert.equal(skip.status, 202, skip.raw);
    const w = h.workers.at(-1)!;
    // The resumed snapshot never lets the release run: gate Completed, release Skipped (not Pending).
    const resumed = loadPlan((w.job as { planPath: string }).planPath);
    assert.equal(resumed.playlists.at(-1)!.tasks.find((t) => t.id === shipGateId)?.status, TaskStatus.Completed);
    assert.equal(resumed.playlists.at(-1)!.tasks.find((t) => t.id === 't-rel')?.status, TaskStatus.Skipped, 'a skip never runs the release');
    const view = (skip.body.run as { view?: { tasks: Record<string, string> } }).view;
    if (view) { assert.equal(view.tasks['t-rel'], TaskStatus.Skipped, 'the recorded view mirrors the snapshot'); }
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(0);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'completed');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    assert.ok((await traceRows(projectId)).every((row) => row.status !== 'shipped' && row.releaseTag === null));
  });

  it('gate approve → the release fails: nothing ships', async () => {
    const { projectId, runId } = await haltAtShipGate();
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'failed');
    verifyPass(w, [{ command: 'npm test', exitCode: 0 }]);
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    await waitFor(() => (h.state.loadCanonicalPlan(projectId, 'Acme', 'claude').requirementTrace ?? []).length > 0);
    assert.ok((await traceRows(projectId)).every((row) => row.status !== 'shipped' && row.releaseTag === null));
  });

  it('gate approve → green gates and exit 0 but the release was skipped: nothing ships', async () => {
    const { projectId, runId } = await haltAtShipGate();
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/approve`, { as: 'approver', body: {} })).status, 202);
    const w = h.workers.at(-1)!;
    releaseRan(w, 'skipped');
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
    attestStandards(w);
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
    assert.deepEqual(detail.afterGate, ['Ship approval', 'Release v1.0.0'], 'the gate card lists what runs after approval (incl. the server ship gate, which precedes the release)');
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
        if (engine === 'anthropic') { await enablePlannerFileAccess(hx); }
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
        await enablePlannerFileAccess(hx);
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
      await enablePlannerFileAccess(hx);
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

  it('MOAG_GATE_TIMEOUT_MS reaches a run job\'s worker config as prdLoop.gateTimeoutMs; unset, the key is absent', async () => {
    const hx = await startHarness({ config: { gateTimeoutMs: 1_800_000 } });
    try {
      const { projectId, planId } = await approvedProject(hx);
      const r = await hx.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
      assert.equal(r.status, 202, r.raw);
      const rcfg = JSON.parse(fs.readFileSync(String(hx.workers.at(-1)!.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
      assert.equal(rcfg['prdLoop.gateTimeoutMs'], 1_800_000);
    } finally { await hx.close(); }
    const { projectId, planId } = await approvedProject(h);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const dcfg = JSON.parse(fs.readFileSync(String(h.workers.at(-1)!.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
    assert.equal('prdLoop.gateTimeoutMs' in dcfg, false, 'no operator value: verify keeps its 600000 default');
  });

  it('the plan review DTO states the dependency-install rule; the run worker config carries the operator keys', async () => {
    const id = await (async () => {
      const created = await h.request('POST', '/api/projects', {
        as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: 'claude' },
      });
      return (created.body.project as { id: string }).id;
    })();
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    const view = await h.request('GET', `/api/projects/${id}`, { as: 'reviewer' });
    const pending = (view.body.plans as Array<{ id: string; dependencyInstall: { enabled: boolean; text: string } }>).find((p) => p.id === planId)!;
    assert.equal(pending.dependencyInstall.enabled, true);
    assert.ok(pending.dependencyInstall.text.includes('npm ci --no-audit --no-fund'));
    assert.ok(pending.dependencyInstall.text.includes('when a dependency manifest or lockfile changes'));
    assert.ok(pending.dependencyInstall.text.endsWith('Lifecycle scripts run.'));
    const hash = h.state.load(id).plans[0].contentHash;
    await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    h.onSpawn = () => { /* default */ };
    await h.request('POST', `/api/projects/${id}/runs`, { as: 'reviewer', body: { planId } });
    const rcfg = JSON.parse(fs.readFileSync(String(h.workers.at(-1)!.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
    assert.equal(rcfg.autoInstallDependencies, true);
    assert.equal(rcfg['dependencyInstall.ignoreScripts'], false);
  });

  it('with installs off or scripts ignored, the review card says so and the worker config follows', async () => {
    for (const [over, phrase, enabled, ignore] of [
      [{ autoInstallDependencies: false }, 'not installed automatically', false, false],
      [{ installIgnoreScripts: true }, 'skipped (--ignore-scripts)', true, true],
    ] as const) {
      const hx = await startHarness({ config: over });
      try {
        const { projectId, planId } = await approvedProject(hx);
        const view = await hx.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
        const plan = (view.body.plans as Array<{ id: string; dependencyInstall: { text: string } }>).find((p) => p.id === planId)!;
        assert.ok(plan.dependencyInstall.text.includes(phrase), plan.dependencyInstall.text);
        await hx.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
        const rcfg = JSON.parse(fs.readFileSync(String(hx.workers.at(-1)!.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
        assert.equal(rcfg.autoInstallDependencies, enabled);
        assert.equal(rcfg['dependencyInstall.ignoreScripts'], ignore);
      } finally { await hx.close(); }
    }
  });

  // ─── Planner lockdown (no file/tool access during plan generation) ───

  it('a claude plan job gets no tools and no MCP servers; a run job keeps the configured claude args', async () => {
    const { projectId, planId } = await approvedProject(h);
    const planJob = h.workers.find((w) => w.job.kind === 'plan')!;
    const pcfg = JSON.parse(fs.readFileSync(String(planJob.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
    assert.deepEqual(pcfg['engines.claude.args'], ['-p', '--strict-mcp-config', '--tools', '']);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const rcfg = JSON.parse(fs.readFileSync(String(h.workers.at(-1)!.spec.env.MOAG_CONFIG_PATH), 'utf-8')).agentTaskPlayer;
    assert.equal('engines.claude.args' in rcfg, false, 'agents in a run keep their tools');
  });

  let projectSeq = 0;
  async function projectOn(engine: string, hx: Harness = h): Promise<string> {
    const dir = `lockdown-${++projectSeq}`;
    fs.mkdirSync(path.join(hx.root, dir), { recursive: true });
    const c = await hx.request('POST', '/api/projects', { as: 'po', body: { name: `On ${engine} ${projectSeq}`, source: { kind: 'path', path: dir }, stack: 'go', defaultEngine: engine } });
    assert.equal(c.status, 201, c.raw);
    const id = (c.body.project as { id: string }).id;
    await hx.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    return id;
  }

  for (const engine of ['gemini', 'anthropic']) {
    it(`plan generation on ${engine} is refused (409 planner-file-access) while planner file access is off`, async () => {
      const hx = await startHarness({ engineAvailable: () => true });
      try {
        const id = await projectOn(engine, hx);
        const spawned = hx.workers.length;
        const g = await hx.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
        assert.equal(g.status, 409, g.raw);
        assert.equal(g.body.error, 'planner-file-access');
        assert.match(String(g.body.message), new RegExp(`^${engine} can't plan without its file`));
        assert.equal(hx.workers.length, spawned, 'no worker spawned');
        assert.deepEqual(hx.state.load(id).plans, [], 'no plan record');
        assert.equal(hx.auditEntries().some((e) => e.action === 'plan.generate'), false);
      } finally { await hx.close(); }
    });
  }

  it('claude, codex and ollama plan without the override', async () => {
    for (const engine of ['claude', 'codex', 'ollama']) {
      const id = await projectOn(engine);
      h.onSpawn = planWorker({ kind: 'no-delta' });
      const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
      assert.equal(g.status, 202, `${engine}: ${g.raw}`);
      await h.waitDone(id);
      const audit = h.auditEntries().filter((e) => e.action === 'plan.generate').at(-1)!;
      assert.equal((audit.after as Record<string, unknown>).plannerFileAccess, undefined, `${engine}: a locked-down planner is not flagged`);
    }
  });

  it('the admin override is audited only when it changes, and then lets gemini plan (flagged in the audit)', async () => {
    const get0 = await h.request('GET', '/api/admin/settings', { as: 'admin' });
    assert.equal(get0.status, 200, get0.raw);
    assert.deepEqual((get0.body.settings as Record<string, unknown>), { allowPlannerFileAccess: false }, 'default off');
    assert.deepEqual([...(get0.body.plannerLockedEngines as string[])].sort(), ['claude', 'codex', 'ollama']);

    const noop = await h.request('PATCH', '/api/admin/settings', { as: 'admin', body: { allowPlannerFileAccess: false } });
    assert.equal(noop.status, 200, noop.raw);
    assert.equal(h.auditEntries().filter((e) => e.action === 'settings.update').length, 0, 'no change, no audit');

    const on = await h.request('PATCH', '/api/admin/settings', { as: 'admin', body: { allowPlannerFileAccess: true } });
    assert.equal(on.status, 200, on.raw);
    assert.deepEqual(on.body.settings, { allowPlannerFileAccess: true });
    const changes = h.auditEntries().filter((e) => e.action === 'settings.update');
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].before, { allowPlannerFileAccess: false });
    assert.deepEqual(changes[0].after, { allowPlannerFileAccess: true });
    assert.equal(changes[0].actorUsername, 'admin');
    await h.request('PATCH', '/api/admin/settings', { as: 'admin', body: { allowPlannerFileAccess: true } });
    assert.equal(h.auditEntries().filter((e) => e.action === 'settings.update').length, 1, 'setting it again is not a change');

    const id = await projectOn('gemini');
    h.onSpawn = planWorker({ kind: 'no-delta' });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    assert.equal(g.status, 202, g.raw);
    await h.waitDone(id);
    const audit = h.auditEntries().filter((e) => e.action === 'plan.generate').at(-1)!;
    assert.equal((audit.after as Record<string, unknown>).plannerFileAccess, true, 'an unrestricted planner is flagged in the audit');

    // Turning it back off refuses gemini again (and is audited).
    await h.request('PATCH', '/api/admin/settings', { as: 'admin', body: { allowPlannerFileAccess: false } });
    assert.equal(h.auditEntries().filter((e) => e.action === 'settings.update').length, 2);
    const id2 = await projectOn('gemini');
    const g2 = await h.request('POST', `/api/projects/${id2}/plans`, { as: 'po', body: { mode: 'initial' } });
    assert.equal(g2.status, 409, g2.raw);
  });

  it('only an admin may read or change server settings; a malformed value is a 400', async () => {
    for (const as of ['po', 'reviewer', 'approver']) {
      assert.equal((await h.request('GET', '/api/admin/settings', { as })).status, 403, as);
      assert.equal((await h.request('PATCH', '/api/admin/settings', { as, body: { allowPlannerFileAccess: true } })).status, 403, as);
    }
    const bad = await h.request('PATCH', '/api/admin/settings', { as: 'admin', body: { allowPlannerFileAccess: 'yes' } });
    assert.equal(bad.status, 400, bad.raw);
    const extra = await h.request('PATCH', '/api/admin/settings', { as: 'admin', body: { somethingElse: true } });
    assert.equal(extra.status, 400, extra.raw);
    assert.deepEqual((await h.request('GET', '/api/admin/settings', { as: 'admin' })).body.settings, { allowPlannerFileAccess: false });
    assert.equal(h.auditEntries().filter((e) => e.action === 'settings.update').length, 0);
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

  it('currentRun detail keeps an early dependency event that fell out of the recent-events window', async () => {
    const { projectId, planId } = await approvedProject(h);
    await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    const w = h.workers.at(-1)!;
    const failed = {
      event: 'dependencies-install-failed', stage: 'task', taskId: 't-impl', ecosystem: 'npm', dir: '.',
      trigger: 'install-dir-missing', command: 'npm ci --no-audit --no-fund', durationMs: 1200, exitCode: 1,
      timedOut: false, tail: 'npm ERR! not in sync', note: null,
    };
    w.line(failed);
    for (let i = 0; i < RUN_DETAIL_EVENTS + 20; i++) { w.line({ event: 'cost', usd: 0, source: 'none' }); }
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status !== 'running');
    const detail = (await projectDto(projectId, 'po')).currentRun as {
      events: Array<{ event: string }>; dependencyEvents: Array<Record<string, unknown>>;
    };
    assert.ok(!detail.events.some((e) => e.event === 'dependencies-install-failed'), 'the window lost it');
    assert.equal(detail.dependencyEvents.length, 1);
    const { ts, ...stored } = detail.dependencyEvents[0];
    assert.equal(typeof ts, 'string', 'the server stamps the time');
    assert.deepEqual(stored, failed);
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

// ─── Admin force-release of a project's job.lock ───

describe('server app — job lock force-release', function () {
  this.timeout(20000);
  const LIVE_TASK_PID = 31337;
  let h: Harness;

  beforeEach(async () => { h = await startHarness({ isPidAlive: (pid) => pid === LIVE_TASK_PID }); });
  afterEach(async () => { await h.close(); });

  const release = (projectId: string, body: unknown = { reason: 'agent confirmed dead via ps' }, as = 'admin') =>
    h.request('POST', `/api/admin/projects/${projectId}/lock/release`, { as, body });

  it('409 job-active while a run is going, and nothing is audited', async () => {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    await waitFor(() => h.app.jobs.isActive(projectId));
    const x = await release(projectId);
    assert.equal(x.status, 409, x.raw);
    assert.equal(x.body.error, 'job-active');
    assert.equal(h.auditEntries().some((e) => e.action === 'job.lock-force-release'), false);
    h.workers.at(-1)!.exit(0);
    await waitFor(() => !h.app.jobs.isActive(projectId));
  });

  it('409 not-locked when the project has no lock', async () => {
    const { projectId } = await approvedProject(h);
    const x = await release(projectId);
    assert.equal(x.status, 409, x.raw);
    assert.equal(x.body.error, 'not-locked');
  });

  it('releases a lock held by a live task pid, shows lockHeld, and audits the before state and the reason', async () => {
    const { projectId } = await approvedProject(h);
    const lockPath = h.app.jobs.lockPath(projectId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ serverPid: process.pid, workerPid: 999991, taskPids: [LIVE_TASK_PID] }));
    const before = await h.request('GET', `/api/projects/${projectId}`, { as: 'po' });
    assert.equal(before.body.lockHeld, true, 'the project DTO tells callers a start would 409');

    const x = await release(projectId);
    assert.equal(x.status, 200, x.raw);
    assert.deepEqual(x.body, { released: true });
    assert.equal(fs.existsSync(lockPath), false);
    const entry = h.auditEntries().find((e) => e.action === 'job.lock-force-release')!;
    assert.ok(entry, 'audited');
    assert.equal(entry.projectId, projectId);
    assert.equal(entry.actorUsername, 'admin');
    assert.deepEqual((entry.before as { taskPids: number[] }).taskPids, [LIVE_TASK_PID]);
    assert.deepEqual(entry.after, { reason: 'agent confirmed dead via ps' });
    const after = await h.request('GET', `/api/projects/${projectId}`, { as: 'po' });
    assert.equal(after.body.lockHeld, false);
  });

  it('a missing reason is a 400 and the lock stays', async () => {
    const { projectId } = await approvedProject(h);
    const lockPath = h.app.jobs.lockPath(projectId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ serverPid: process.pid, taskPids: [LIVE_TASK_PID] }));
    const x = await release(projectId, {});
    assert.equal(x.status, 400, x.raw);
    assert.ok(fs.existsSync(lockPath));
    assert.equal(h.auditEntries().some((e) => e.action === 'job.lock-force-release'), false);
  });

  it('only an admin may force-release', async () => {
    const { projectId } = await approvedProject(h);
    for (const as of ['po', 'reviewer', 'approver']) {
      assert.equal((await release(projectId, undefined, as)).status, 403, as);
    }
  });
});

/** Re-start the harness with an extra user holding both product-owner and reviewer. */
async function withSelfReviewer(h: Harness): Promise<Harness> {
  await h.close();
  return startHarness({ extraAccounts: { 'po-reviewer': ['product-owner', 'reviewer'] } });
}

// ─── Standards gate: no plan without an approved standards version ───

describe('server app — standards gate', function () {
  this.timeout(20000);
  let h: Harness;
  let projectId: string;

  beforeEach(async () => {
    // 'manual': nothing approves the automatic proposal behind the test's back.
    h = await startHarness({ standards: 'manual' });
    const r = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: 'claude' },
    });
    assert.equal(r.status, 201, r.raw);
    projectId = (r.body.project as { id: string }).id;
    const saved = await h.request('POST', `/api/projects/${projectId}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    assert.equal(saved.status, 201, saved.raw);
  });
  afterEach(async () => { await h.close(); });

  const generate = () => h.request('POST', `/api/projects/${projectId}/plans`, { as: 'po', body: { mode: 'initial' } });
  const prdActions = async (): Promise<{ actions: string[]; reason: unknown; standards: unknown }> => {
    const r = await h.request('GET', `/api/projects/${projectId}/prd`, { as: 'po' });
    return { actions: r.body.allowedActions as string[], reason: r.body.planBlockedReason, standards: r.body.standards };
  };
  const approveStandards = async (): Promise<void> => {
    const pending = h.standards.pending(projectId)!;
    const r = await h.request('POST', `/api/projects/${projectId}/standards/versions/${pending.version}/approve`, { as: 'reviewer', body: { contentHash: pending.contentHash, acknowledgedEnforcementHash: pending.contentHash } });
    assert.equal(r.status, 200, r.raw);
  };
  /** Generate a plan and wait until it is pending review. Returns its id. */
  const pendingPlan = async (): Promise<string> => {
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const gen = await generate();
    assert.equal(gen.status, 202, gen.raw);
    await waitFor(() => h.state.load(projectId).plans.at(-1)?.status === 'pending');
    h.onSpawn = () => { /* default */ };
    return (gen.body.plan as { id: string }).id;
  };

  it('plan generation is 409 standards-not-approved with the state: no worker, no plan record, no directory, no audit line', async () => {
    const auditBefore = h.auditEntries().length;
    const r = await generate();
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'standards-not-approved');
    assert.equal(r.body.state, 'pending');
    assert.equal(r.body.pendingVersion, 1);
    assert.equal(h.workers.length, 0, 'no FakeWorker was spawned');
    assert.equal(h.app.jobs.isActive(projectId), false);
    assert.deepEqual(h.state.load(projectId).plans, []);
    assert.equal(fs.existsSync(path.join(h.state.projectDir(projectId), 'plans')), false, 'no plan directory was created');
    assert.equal(h.auditEntries().length, auditBefore);
    assert.equal(h.auditEntries().filter((e) => e.action === 'plan.generate').length, 0);
  });

  it('a rejected proposal keeps the gate closed and says so', async () => {
    const rj = await h.request('POST', `/api/projects/${projectId}/standards/versions/1/reject`, { as: 'reviewer', body: { reason: 'no test dir' } });
    assert.equal(rj.status, 200, rj.raw);
    const r = await generate();
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'standards-not-approved');
    assert.equal(r.body.state, 'rejected');
    assert.equal(r.body.pendingVersion, null);
    assert.equal(h.workers.length, 0);
  });

  it('the generate actions are absent from the PRD DTO until a version is approved, with the reason', async () => {
    const before = await prdActions();
    assert.ok(!before.actions.includes('plan.generate') && !before.actions.includes('plan.generate-initial'), before.actions.join(','));
    assert.ok(before.actions.includes('prd.save'), 'saving the PRD is not blocked');
    assert.equal(before.reason, 'standards-not-approved');
    assert.deepEqual(before.standards, { effectiveVersion: null, pendingVersion: 1, state: 'pending' });

    await approveStandards();
    const after = await prdActions();
    assert.ok(after.actions.includes('plan.generate-initial'), after.actions.join(','));
    assert.equal(after.reason, null);
    assert.deepEqual(after.standards, { effectiveVersion: 1, pendingVersion: null, state: 'approved' });
  });

  it('after approval the plan job carries a standardsPath whose file holds the approved text, and the plan records the version', async () => {
    // v2 is what gets approved; it carries a recognisable rule.
    const profile = sampleProfile();
    profile.freeText = 'Every handler validates its input first.';
    const proposed = await h.request('POST', `/api/projects/${projectId}/standards/versions`, { as: 'po', body: { profile, baseVersion: 1 } });
    assert.equal(proposed.status, 201, proposed.raw);
    await approveStandards();

    const planId = await pendingPlan();
    const worker = h.workers.find((w) => w.job.kind === 'plan')!;
    const job = worker.job as PlanJob;
    assert.ok(job.standardsPath, 'the job names a standards file');
    assert.equal(path.dirname(job.standardsPath!), path.join(h.state.projectDir(projectId), 'plans', planId), 'beside job.json, in the data dir');
    assert.ok(!path.resolve(job.standardsPath!).startsWith(path.resolve(h.root) + path.sep), 'never inside a workspace');

    const file = readStandardsJobFile(job.standardsPath!);
    assert.equal(file.version, 2);
    assert.equal(file.baseRef, null);
    assert.deepEqual(file.profile, h.standards.effective(projectId)!.profile);
    assert.equal(file.plannerText, renderPlannerStandards(file.profile, 2));
    assert.equal(file.promptText, renderStandardsText(file.profile, 2));
    assert.ok(file.plannerText.includes('> Every handler validates its input first.'));
    assert.ok(file.plannerText.includes('Lint: npm run lint'), 'the approved command is in the planner text');

    const plan = h.state.load(projectId).plans[0];
    assert.equal(plan.standardsVersion, 2);
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
    assert.equal((dto.body.plans as Array<{ standardsVersion: number }>)[0].standardsVersion, 2);
    assert.equal(h.auditEntries().filter((e) => e.action === 'plan.generate').length, 1);
  });

  it('a legacy pending plan is refused at approve while nothing is approved, and approvable once defaults are accepted', async () => {
    await approveStandards();
    const planId = await pendingPlan();
    // Rewind to what an upgraded server holds: a pending plan with no standards version,
    // and a project with no standards file until the boot migration proposes one.
    h.state.update(projectId, (s) => { delete s.plans[0].standardsVersion; });
    fs.rmSync(h.standards.filePath(projectId));
    assert.deepEqual(await migrateStandards(h.projects, h.standards, h.audit, () => undefined), [projectId]);

    const hash = h.state.load(projectId).plans[0].contentHash;
    const auditBefore = h.auditEntries().length;
    const refused = await h.request('POST', `/api/projects/${projectId}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.error, 'standards-not-approved');
    assert.equal(refused.body.state, 'pending');
    assert.equal(h.state.load(projectId).plans[0].status, 'pending');
    assert.equal(h.auditEntries().length, auditBefore);

    const pending = h.standards.pending(projectId)!;
    const accepted = await h.request('POST', `/api/projects/${projectId}/standards/accept-defaults`, { as: 'admin', body: { contentHash: pending.contentHash, acknowledgedEnforcementHash: pending.contentHash } });
    assert.equal(accepted.status, 200, accepted.raw);
    const ok = await h.request('POST', `/api/projects/${projectId}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    assert.equal(ok.status, 200, ok.raw);
  });

  /** Approve standards, generate and approve a plan. Returns its id. */
  const approvedPlan = async (): Promise<string> => {
    await approveStandards();
    const planId = await pendingPlan();
    const hash = h.state.load(projectId).plans[0].contentHash;
    assert.equal((await h.request('POST', `/api/projects/${projectId}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } })).status, 200);
    return planId;
  };
  /** Rewind to what an upgraded server holds: the approved plan has no standards version, and the boot migration proposed v1 (pending). */
  const rewindToLegacy = async (): Promise<void> => {
    h.state.update(projectId, (s) => { delete s.plans[0].standardsVersion; });
    fs.rmSync(h.standards.filePath(projectId));
    assert.deepEqual(await migrateStandards(h.projects, h.standards, h.audit, () => undefined), [projectId]);
    assert.equal(h.standards.effective(projectId), null);
  };
  const planCard = async (): Promise<{ startBlockedReason: string | null; allowedActions: string[]; status: string }> =>
    ((await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' })).body.plans as Array<{ startBlockedReason: string | null; allowedActions: string[]; status: string }>)[0];

  it('run start: a legacy approved plan is refused while the project has no approved standards, and says why on the plan card', async () => {
    const planId = await approvedPlan();
    await rewindToLegacy();
    const card = await planCard();
    assert.equal(card.startBlockedReason, 'standards-not-approved', 'a legacy plan is blocked too');
    assert.ok(!card.allowedActions.includes('run.start'), card.allowedActions.join(','));
    const auditBefore = h.auditEntries().length;
    const workersBefore = h.workers.length;
    const refused = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.error, 'standards-not-approved');
    assert.equal(refused.body.state, 'pending');
    assert.equal(refused.body.pendingVersion, 1);
    assert.match(String(refused.body.message), /no approved standards.*Standards v1 is waiting for a reviewer/);
    assert.equal(h.workers.length, workersBefore, 'no run worker was spawned');
    assert.deepEqual(h.state.load(projectId).runs, []);
    assert.equal(h.state.load(projectId).plans[0].status, 'approved', 'the plan stays approved');
    assert.equal(h.auditEntries().length, auditBefore, 'nothing was audited');
  });

  it('run start: once the migrated standards are approved, the legacy plan starts without being approved again, held to them', async () => {
    const planId = await approvedPlan();
    await rewindToLegacy();
    assert.equal((await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } })).status, 409);
    const pending = h.standards.pending(projectId)!;
    const accepted = await h.request('POST', `/api/projects/${projectId}/standards/accept-defaults`, { as: 'admin', body: { contentHash: pending.contentHash, acknowledgedEnforcementHash: pending.contentHash } });
    assert.equal(accepted.status, 200, accepted.raw);
    const card = await planCard();
    assert.equal(card.status, 'approved');
    assert.equal(card.startBlockedReason, null);
    assert.ok(card.allowedActions.includes('run.start'), card.allowedActions.join(','));
    const started = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(started.status, 202, started.raw);
    assert.equal(h.auditEntries().filter((e) => e.action === 'plan.approve').length, 1, 'no second plan approval');
    const run = h.state.load(projectId).runs[0];
    const effective = h.standards.effective(projectId)!;
    assert.equal(run.standardsVersion, effective.version, 'the run is held to the standards now in effect');
    assert.equal(run.standardsHash, effective.contentHash);
    const job = h.workers.at(-1)!.job as RunJob;
    assert.ok(job.standardsPath, 'the worker gets the standards job file');
    assert.notEqual(verifyArgv(job).at(-1), '--no-standards');
  });

  /** Start an approved plan's run and halt it at its ship gate, as a real worker would. Returns the run id. */
  const haltAtGateHere = async (planId: string): Promise<string> => {
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const w = h.workers.at(-1)!;
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
    return (r.body.run as { id: string }).id;
  };

  it('gate approve and skip are refused while the project has no approved standards (legacy run included); reject stays possible', async () => {
    const runId = await haltAtGateHere(await approvedPlan());
    fs.rmSync(h.standards.filePath(projectId));
    assert.equal(h.standards.effective(projectId), null);
    const spawned = h.workers.length;
    for (const legacy of [false, true]) {
      if (legacy) { h.state.update(projectId, (s) => { delete s.runs[0].standardsVersion; delete s.runs[0].standardsHash; }); }
      for (const kind of ['approve', 'skip'] as const) {
        const r = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/${kind}`,
          { as: kind === 'skip' ? 'admin' : 'approver', body: kind === 'skip' ? { reason: 'hotfix' } : {} });
        assert.equal(r.status, 409, `${kind} (legacy ${legacy}): ${r.raw}`);
        assert.equal(r.body.error, 'standards-not-approved', `${kind} (legacy ${legacy})`);
        assert.match(String(r.body.message), /no approved standards/);
      }
      const run = h.state.load(projectId).runs[0];
      assert.equal(run.status, 'awaiting-approval', 'still waiting');
      assert.equal(run.segments, 1);
      assert.deepEqual(run.gateDecisions ?? [], []);
      assert.equal(h.workers.length, spawned, 'no segment was spawned');
    }
    assert.equal(h.auditEntries().some((e) => e.action === 'gate.approve' || e.action === 'gate.skip'), false);
    const rej = await h.request('POST', `/api/projects/${projectId}/runs/${runId}/gate/reject`, { as: 'approver', body: { note: 'no standards' } });
    assert.equal(rej.status, 200, rej.raw);
    assert.equal(h.state.load(projectId).runs[0].status, 'ship-rejected');
  });

  it('run start: a plan generated under standards fails closed when the store has lost them', async () => {
    const planId = await approvedPlan();

    // The standards file is gone (store loss or tampering) but the plan says it was generated under v1.
    fs.rmSync(h.standards.filePath(projectId));
    const dto = await h.request('GET', `/api/projects/${projectId}`, { as: 'reviewer' });
    const planDto = (dto.body.plans as Array<{ startBlockedReason: string; allowedActions: string[] }>)[0];
    assert.equal(planDto.startBlockedReason, 'standards-not-approved');
    assert.ok(!planDto.allowedActions.includes('run.start'));
    const workersBefore = h.workers.length;
    const refused = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.error, 'standards-not-approved');
    assert.equal(refused.body.state, 'none');
    assert.equal(h.workers.length, workersBefore, 'no run worker was spawned');
    assert.deepEqual(h.state.load(projectId).runs, []);

    // The same plan as a legacy one (approved before the project had standards) is refused too.
    h.state.update(projectId, (s) => { delete s.plans[0].standardsVersion; });
    assert.equal((await planCard()).startBlockedReason, 'standards-not-approved');
    const legacy = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(legacy.status, 409, legacy.raw);
    assert.equal(legacy.body.error, 'standards-not-approved');
    assert.equal(h.workers.length, workersBefore);
  });
});
