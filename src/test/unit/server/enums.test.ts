import { strict as assert } from 'assert';
import { WEB_ROLES, isWebRole, parseRoles } from '../../../server/web-roles';
import { STACK_IDS, isStackId, STATIC_DEFAULT_STACK } from '../../../server/stacks';
import { AUDIT_ACTIONS, isAuditAction } from '../../../server/audit';

describe('server enums', () => {
  describe('web roles', () => {
    it('has exactly the four locked roles', () => {
      assert.deepEqual([...WEB_ROLES], ['product-owner', 'reviewer', 'approver', 'admin']);
    });

    it('accepts every member', () => {
      for (const r of WEB_ROLES) { assert.equal(isWebRole(r), true); }
    });

    it('rejects unknown strings, agent RoleIds, empty, wrong case and non-strings', () => {
      for (const bad of ['architect', 'developer', '', 'Admin', 'ADMIN', ' admin', 'owner', null, undefined, 1, {}, ['admin']]) {
        assert.equal(isWebRole(bad), false, `should reject ${JSON.stringify(bad)}`);
      }
    });

    it('parseRoles accepts a non-empty unique list', () => {
      assert.deepEqual(parseRoles(['reviewer', 'approver']), ['reviewer', 'approver']);
      assert.deepEqual(parseRoles(['admin']), ['admin']);
    });

    it('parseRoles rejects empty, duplicate, unknown and non-array input', () => {
      assert.equal(parseRoles([]), null);
      assert.equal(parseRoles(['admin', 'admin']), null);
      assert.equal(parseRoles(['admin', 'architect']), null);
      assert.equal(parseRoles(['']), null);
      assert.equal(parseRoles('admin'), null);
      assert.equal(parseRoles(null), null);
      assert.equal(parseRoles({ 0: 'admin', length: 1 }), null);
    });
  });

  describe('stacks', () => {
    it('lists the closed stack set and a member default', () => {
      assert.deepEqual([...STACK_IDS], ['node-ts', 'python', 'go', 'java', 'dotnet', 'static-web', 'other']);
      assert.equal(isStackId(STATIC_DEFAULT_STACK), true);
    });

    it('rejects unknown stacks', () => {
      for (const bad of ['rust', '', 'Node-TS', null, 3]) {
        assert.equal(isStackId(bad), false);
      }
    });
  });

  describe('audit actions', () => {
    it('covers every audited action exactly once', () => {
      assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length);
      for (const a of ['login.success', 'login.failure', 'user.role-change', 'prd.bump-override',
        'plan.approve', 'run.start', 'gate.approve', 'gate.skip', 'engine.key-set', 'engine.key-clear']) {
        assert.equal(isAuditAction(a), true, a);
      }
      assert.equal(isAuditAction('gate.force'), false);
      assert.equal(isAuditAction(''), false);
    });
  });
});
