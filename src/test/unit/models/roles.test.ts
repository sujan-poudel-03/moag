import * as assert from 'assert';
import {
  ROLE_IDS,
  MAX_ROLE_CHARTER_CHARS,
  isRoleId,
  getRoleDefinition,
  resolveRoleCharter,
} from '../../../models/roles';
import { RoleDefinition } from '../../../models/types';

describe('ROLE_IDS', () => {
  it('contains exactly seven ids including custom', () => {
    assert.strictEqual(ROLE_IDS.length, 7);
    assert.ok(ROLE_IDS.includes('custom'));
    assert.deepStrictEqual(
      [...ROLE_IDS].sort(),
      ['architect', 'custom', 'designer', 'devops', 'engineer', 'reviewer', 'tester'],
    );
  });

  it('has no duplicate ids', () => {
    assert.strictEqual(new Set(ROLE_IDS).size, ROLE_IDS.length);
  });
});

describe('built-in charters', () => {
  it('every built-in role resolves to a non-empty charter within the cap', () => {
    for (const id of ROLE_IDS) {
      if (id === 'custom') {
        continue;
      }
      const definition = getRoleDefinition(id);
      assert.ok(definition, `missing built-in definition for ${id}`);
      assert.strictEqual(definition!.id, id);
      assert.ok(definition!.name.length > 0, `missing name for ${id}`);
      assert.ok(definition!.charter.length > 0, `empty charter for ${id}`);
      assert.ok(
        definition!.charter.length <= MAX_ROLE_CHARTER_CHARS,
        `charter for ${id} is ${definition!.charter.length} chars, cap is ${MAX_ROLE_CHARTER_CHARS}`,
      );
    }
  });

  it('custom has no built-in definition', () => {
    assert.strictEqual(getRoleDefinition('custom'), null);
  });
});

describe('isRoleId', () => {
  it('accepts every member of ROLE_IDS', () => {
    for (const id of ROLE_IDS) {
      assert.strictEqual(isRoleId(id), true, `expected ${id} to be a role id`);
    }
  });

  it('rejects non-members and non-strings', () => {
    assert.strictEqual(isRoleId(undefined), false);
    assert.strictEqual(isRoleId(null), false);
    assert.strictEqual(isRoleId(42), false);
    assert.strictEqual(isRoleId('Engineer'), false);
    assert.strictEqual(isRoleId('senior-backend-engineer'), false);
    assert.strictEqual(isRoleId(''), false);
    assert.strictEqual(isRoleId({ id: 'engineer' }), false);
  });
});

describe('resolveRoleCharter', () => {
  it('returns null for an undefined role id', () => {
    assert.strictEqual(resolveRoleCharter(undefined), null);
  });

  it('returns the built-in charter for a built-in id', () => {
    const charter = resolveRoleCharter('reviewer');
    assert.ok(charter);
    assert.ok(charter!.startsWith('You are the reviewer.'));
  });

  it('returns null for custom with no customRoles and does not throw', () => {
    assert.doesNotThrow(() => resolveRoleCharter('custom'));
    assert.strictEqual(resolveRoleCharter('custom'), null);
    assert.strictEqual(resolveRoleCharter('custom', []), null);
  });

  it('resolves a custom role supplied under the custom id', () => {
    const customRoles: RoleDefinition[] = [
      { id: 'custom', name: 'Data Steward', charter: 'You own the schema.' },
    ];
    assert.strictEqual(resolveRoleCharter('custom', customRoles), 'You own the schema.');
  });

  it('lets a custom definition override a built-in by id', () => {
    const customRoles: RoleDefinition[] = [
      { id: 'engineer', name: 'House Engineer', charter: 'Override charter.' },
    ];
    assert.strictEqual(resolveRoleCharter('engineer', customRoles), 'Override charter.');
    // Other built-ins are untouched by the override.
    assert.ok(resolveRoleCharter('architect', customRoles)!.startsWith('You are the architect.'));
  });

  it('caps an oversized custom charter at exactly MAX_ROLE_CHARTER_CHARS', () => {
    const customRoles: RoleDefinition[] = [
      { id: 'custom', name: 'Verbose', charter: 'x'.repeat(5000) },
    ];
    const charter = resolveRoleCharter('custom', customRoles);
    assert.strictEqual(charter!.length, MAX_ROLE_CHARTER_CHARS);
  });

  it('returns null — not an empty string — for a whitespace-only charter', () => {
    const customRoles: RoleDefinition[] = [
      { id: 'custom', name: 'Blank', charter: '   \n\t  ' },
    ];
    assert.strictEqual(resolveRoleCharter('custom', customRoles), null);
  });

  it('trims surrounding whitespace before capping', () => {
    const customRoles: RoleDefinition[] = [
      { id: 'custom', name: 'Padded', charter: '   hello   ' },
    ];
    assert.strictEqual(resolveRoleCharter('custom', customRoles), 'hello');
  });

  it('survives a malformed custom entry without throwing', () => {
    const customRoles = [
      null,
      { id: 'custom', name: 'Late', charter: 'Real charter.' },
    ] as unknown as RoleDefinition[];
    assert.doesNotThrow(() => resolveRoleCharter('custom', customRoles));
    assert.strictEqual(resolveRoleCharter('custom', customRoles), 'Real charter.');
  });

  it('returns null when a custom charter is not a string', () => {
    const customRoles = [
      { id: 'custom', name: 'Bad', charter: 42 },
    ] as unknown as RoleDefinition[];
    assert.strictEqual(resolveRoleCharter('custom', customRoles), null);
  });
});

describe('getRoleDefinition', () => {
  it('prefers the first matching custom entry over a built-in', () => {
    const customRoles: RoleDefinition[] = [
      { id: 'tester', name: 'First', charter: 'first' },
      { id: 'tester', name: 'Second', charter: 'second' },
    ];
    assert.strictEqual(getRoleDefinition('tester', customRoles)!.name, 'First');
  });

  it('falls back to the built-in when no custom entry matches', () => {
    const customRoles: RoleDefinition[] = [
      { id: 'devops', name: 'House DevOps', charter: 'devops charter' },
    ];
    assert.strictEqual(getRoleDefinition('tester', customRoles)!.name, 'Tester');
  });
});
