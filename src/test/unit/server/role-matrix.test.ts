// ─── AC7: every mutating endpoint × every role — 403 for each disallowed pair ───
//
// Walks the ROUTES table (data, exported by app.ts) against WEB_ROLES using a
// valid session + CSRF token and a JSON body, so the only thing that can refuse
// is the role check. Allowed pairs must NOT be 403-forbidden at the role gate.

import { strict as assert } from 'assert';
import { startHarness, Harness } from './app-harness';
import { ROUTES, ACTION_VARIANTS } from '../../../server/app';
import { ROLE_MATRIX, SERVER_ACTIONS, canPerform } from '../../../server/permissions';
import { WEB_ROLES } from '../../../server/web-roles';

const ACCOUNT_FOR_ROLE: Record<string, string> = {
  'product-owner': 'po', reviewer: 'reviewer', approver: 'approver', admin: 'admin',
};

describe('role matrix (ROUTES × WEB_ROLES)', function () {
  this.timeout(30000);
  let h: Harness;
  let projectId: string;

  before(async () => {
    h = await startHarness();
    const r = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'claude' },
    });
    projectId = (r.body.project as { id: string }).id;
  });
  after(async () => { await h.close(); });

  const fill = (p: string): string => p
    .replace(':id', p.startsWith('/api/admin/users') ? 'no-such-user' : projectId)
    .replace(':planId', 'no-such-plan')
    .replace(':runId', 'no-such-run')
    .replace(':version', '1')
    .replace(':engine', 'anthropic');

  it('every server action is guarded by at least one route or a body-selected variant', () => {
    const used = new Set([...ROUTES.map((r) => r.action), ...ACTION_VARIANTS.map((v) => v.action)].filter(Boolean));
    for (const a of SERVER_ACTIONS) { assert.ok(used.has(a), `${a} has no route`); }
  });

  it('every mutating session route names an action, except logout and self-service password', () => {
    const exempt = new Set(['POST /api/logout', 'POST /api/me/password']);
    for (const r of ROUTES) {
      if (r.mutating && r.auth === 'session' && !exempt.has(`${r.method} ${r.path}`)) {
        assert.ok(r.action, `${r.method} ${r.path} is mutating but unguarded`);
      }
    }
  });

  it('the matrix matches the locked role decisions', () => {
    const allowed = (a: keyof typeof ROLE_MATRIX) => [...ROLE_MATRIX[a]].sort();
    assert.deepEqual(allowed('run.start'), ['admin', 'reviewer']);
    assert.deepEqual(allowed('gate.approve'), ['approver']);
    assert.deepEqual(allowed('gate.skip'), ['admin']);
    assert.deepEqual(allowed('plan.approve'), ['reviewer']);
    assert.deepEqual(allowed('prd.save'), ['product-owner']);
    assert.deepEqual(allowed('users.manage'), ['admin']);
    assert.deepEqual(allowed('plan.reject'), ['reviewer']);
    assert.deepEqual(allowed('gate.reject'), ['approver']);
    assert.deepEqual(allowed('run.stop'), ['admin', 'reviewer']);
    assert.deepEqual(allowed('project.create'), ['admin', 'product-owner']);
    assert.deepEqual(allowed('project.update'), ['admin', 'product-owner']);
    assert.deepEqual(allowed('engines.manage'), ['admin']);
    assert.deepEqual(allowed('audit.view'), ['admin']);
  });

  it('every server action has an explicit pin (a new or changed action must be decided here, not inherited)', () => {
    const PINNED: Record<string, string[]> = {
      'project.create': ['admin', 'product-owner'],
      'project.update': ['admin', 'product-owner'],
      'prd.save': ['product-owner'],
      'prd.bump-override': ['product-owner'],
      'plan.generate': ['product-owner'],
      'plan.generate-initial': ['product-owner'],
      'plan.cancel': ['admin', 'product-owner'],
      'plan.approve': ['reviewer'],
      'plan.reject': ['reviewer'],
      'run.start': ['admin', 'reviewer'],
      'run.stop': ['admin', 'reviewer'],
      'gate.approve': ['approver'],
      'gate.reject': ['approver'],
      'gate.skip': ['admin'],
      'standards.propose': ['admin', 'product-owner'],
      'standards.approve': ['reviewer'],
      'standards.reject': ['reviewer'],
      'standards.accept-defaults': ['admin'],
      'users.manage': ['admin'],
      'audit.view': ['admin'],
      'engines.manage': ['admin'],
      'jobs.force-release': ['admin'],
    };
    assert.deepEqual(Object.keys(PINNED).sort(), [...SERVER_ACTIONS].sort());
    for (const a of SERVER_ACTIONS) { assert.deepEqual([...ROLE_MATRIX[a]].sort(), PINNED[a], a); }
  });

  for (const route of ROUTES) {
    if (!route.action) { continue; }
    for (const role of WEB_ROLES) {
      const allowed = canPerform({ id: 'x', roles: [role] }, route.action);
      it(`${route.method} ${route.path} as ${role} → ${allowed ? 'not forbidden' : '403'}`, async () => {
        const auditBefore = h.auditEntries().length;
        const r = await h.request(route.method, fill(route.path), { as: ACCOUNT_FOR_ROLE[role], body: route.method === 'GET' ? undefined : {} });
        if (allowed) {
          assert.notEqual(r.body.error, 'forbidden', `${role} should pass the role gate (${r.status} ${r.raw})`);
        } else {
          assert.equal(r.status, 403, `${role} → ${r.status} ${r.raw}`);
          assert.equal(r.body.error, 'forbidden');
          assert.equal(h.auditEntries().length, auditBefore, 'a refused request writes no audit line');
        }
      });
    }
  }

  for (const v of ACTION_VARIANTS) {
    for (const role of WEB_ROLES) {
      const allowed = canPerform({ id: 'x', roles: [role] }, v.action);
      it(`${v.method} ${v.path} ${JSON.stringify(v.body)} (${v.action}) as ${role} → ${allowed ? 'not forbidden' : '403'}`, async () => {
        const auditBefore = h.auditEntries().length;
        const r = await h.request(v.method, fill(v.path), { as: ACCOUNT_FOR_ROLE[role], body: v.body });
        if (allowed) {
          assert.notEqual(r.body.error, 'forbidden', `${role} should pass the role gate (${r.status} ${r.raw})`);
        } else {
          assert.equal(r.status, 403, `${role} → ${r.status} ${r.raw}`);
          assert.equal(r.body.error, 'forbidden');
          assert.equal(h.auditEntries().length, auditBefore, 'a refused request writes no audit line');
        }
      });
    }
  }

  it('a body-selected variant names a real route', () => {
    for (const v of ACTION_VARIANTS) {
      assert.ok(ROUTES.some((r) => r.method === v.method && r.path === v.path && r.action), `${v.method} ${v.path}`);
    }
  });

  it('every session route is 401 without a session', async () => {
    for (const route of ROUTES) {
      if (route.auth !== 'session') { continue; }
      const r = await h.request(route.method, fill(route.path), { body: route.method === 'GET' ? undefined : {} });
      assert.equal(r.status, 401, `${route.method} ${route.path}`);
    }
  });

  it('a multi-role user gets the union of permissions', () => {
    const both = { id: 'x', roles: ['product-owner', 'reviewer'] as const };
    assert.equal(canPerform({ ...both, roles: [...both.roles] }, 'prd.save'), true);
    assert.equal(canPerform({ ...both, roles: [...both.roles] }, 'plan.approve'), true);
    assert.equal(canPerform({ ...both, roles: [...both.roles] }, 'gate.approve'), false);
  });

  it('state rules: cancel only by requester/admin, stop only while playing/paused, gate only when awaiting', () => {
    const po = { id: 'u1', roles: ['product-owner' as const] };
    assert.equal(canPerform(po, 'plan.cancel', { requestedBy: 'u1', planStatus: 'generating' }), true);
    assert.equal(canPerform(po, 'plan.cancel', { requestedBy: 'u2', planStatus: 'generating' }), false);
    assert.equal(canPerform({ id: 'a', roles: ['admin'] }, 'plan.cancel', { requestedBy: 'u2', planStatus: 'pending' }), true);
    assert.equal(canPerform(po, 'plan.cancel', { requestedBy: 'u1', planStatus: 'approved' }), false);
    const rev = { id: 'r', roles: ['reviewer' as const] };
    // A plan the review rules refuse today: approving and starting are off, rejecting and cancelling stay.
    assert.equal(canPerform(rev, 'plan.approve', { planStatus: 'pending', reviewPasses: false }), false);
    assert.equal(canPerform(rev, 'plan.approve', { planStatus: 'pending', reviewPasses: true }), true);
    assert.equal(canPerform(rev, 'plan.approve', { planStatus: 'pending' }), true, 'unknown is not a refusal');
    assert.equal(canPerform(rev, 'plan.reject', { planStatus: 'pending', reviewPasses: false }), true, 'the way out stays open');
    assert.equal(canPerform(po, 'plan.cancel', { requestedBy: 'u1', planStatus: 'pending', reviewPasses: false }), true);
    assert.equal(canPerform(rev, 'run.start', { planStatus: 'approved', reviewPasses: false }), false);
    assert.equal(canPerform(rev, 'run.start', { planStatus: 'approved', reviewPasses: true }), true);
    assert.equal(canPerform(rev, 'run.stop', { runnerState: 'playing' }), true);
    assert.equal(canPerform(rev, 'run.stop', { runnerState: 'paused' }), true);
    assert.equal(canPerform(rev, 'run.stop', { runnerState: 'idle' }), false);
    assert.equal(canPerform(rev, 'plan.approve', { planStatus: 'approved' }), false);
    const appr = { id: 'p', roles: ['approver' as const] };
    assert.equal(canPerform(appr, 'gate.approve', { runStatus: 'awaiting-approval' }), true);
    assert.equal(canPerform(appr, 'gate.approve', { runStatus: 'running' }), false);
    assert.equal(canPerform(po, 'prd.bump-override', { overrideLocked: true }), false);
  });

  it('state rules: plan generation needs a scope (delta) or exactly one version (initial), no open plan, no CI lock', () => {
    const po = { id: 'u1', roles: ['product-owner' as const] };
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: true, openPlan: false }), true);
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: false }), false);
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: true, openPlan: true }), false);
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: true, runsDisabled: true }), false);
    assert.equal(canPerform(po, 'plan.generate-initial', { versionCount: 1 }), true);
    assert.equal(canPerform(po, 'plan.generate-initial', { versionCount: 0 }), false);
    assert.equal(canPerform(po, 'plan.generate-initial', { versionCount: 2 }), false);
    assert.equal(canPerform(po, 'plan.generate-initial', { versionCount: 1, openPlan: true }), false);
    assert.equal(canPerform({ id: 'r', roles: ['reviewer'] }, 'plan.generate-initial', { versionCount: 1 }), false);
  });

  it('state rules: an exhausted version budget hides plan.generate and plan.generate-initial', () => {
    const po = { id: 'u1', roles: ['product-owner' as const] };
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: true, budgetExhausted: true }), false);
    assert.equal(canPerform(po, 'plan.generate-initial', { versionCount: 1, budgetExhausted: true }), false);
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: true, budgetExhausted: false }), true);
    assert.equal(canPerform(po, 'plan.generate-initial', { versionCount: 1, budgetExhausted: false }), true);
  });

  it('state rules: standards are decided only while pending, defaults accepted only when acceptable, and plans need an approved version', () => {
    const rev = { id: 'r', roles: ['reviewer' as const] };
    const admin = { id: 'a', roles: ['admin' as const] };
    const po = { id: 'u1', roles: ['product-owner' as const] };
    assert.equal(canPerform(rev, 'standards.approve', { standardsStatus: 'pending' }), true);
    assert.equal(canPerform(rev, 'standards.reject', { standardsStatus: 'pending' }), true);
    for (const status of ['approved', 'rejected', 'superseded']) {
      assert.equal(canPerform(rev, 'standards.approve', { standardsStatus: status }), false, status);
      assert.equal(canPerform(rev, 'standards.reject', { standardsStatus: status }), false, status);
    }
    assert.equal(canPerform(admin, 'standards.accept-defaults', { standardsAcceptable: true }), true);
    assert.equal(canPerform(admin, 'standards.accept-defaults', { standardsAcceptable: false }), false);
    assert.equal(canPerform(admin, 'standards.approve', { standardsStatus: 'pending' }), false, 'an admin never reviews');
    assert.equal(canPerform(po, 'standards.approve', { standardsStatus: 'pending' }), false, 'the proposer role never approves');
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: true, standardsApproved: false }), false);
    assert.equal(canPerform(po, 'plan.generate-initial', { versionCount: 1, standardsApproved: false }), false);
    assert.equal(canPerform(po, 'plan.generate', { hasDeltaScope: true, standardsApproved: true }), true);
    assert.equal(canPerform(rev, 'run.start', { planStatus: 'approved', standardsApproved: false }), false);
    assert.equal(canPerform(rev, 'run.start', { planStatus: 'approved', standardsApproved: true }), true);
  });

  it('state rules: run.start is refused once the engine changed after approval', () => {
    const rev = { id: 'r', roles: ['reviewer' as const] };
    assert.equal(canPerform(rev, 'run.start', { planStatus: 'approved', engineChanged: true }), false);
    assert.equal(canPerform(rev, 'run.start', { planStatus: 'approved', engineChanged: false }), true);
  });
});
