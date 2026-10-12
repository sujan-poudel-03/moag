// ─── Project Rulebook view: what the reviewer reads as CHECKED and as GUIDANCE ───

import { strict as assert } from 'assert';
import { BUILT_IN_PROFILES } from '../../../standards/built-in-profiles';
import { STANDARDS_RULE_IDS, StandardsProfile } from '../../../standards/profile';
import { RULEBOOK_KEYS } from '../../../standards/rulebook';
import { RULEBOOK_RULE_SECTION, commandSection, rulebookView } from '../../../standards/rulebook-view';
import { promote, sampleProfile } from './fixtures';

/** A profile with no rulebook section: what every version written before the rulebook is. */
function legacy(): StandardsProfile {
  const p = JSON.parse(JSON.stringify(BUILT_IN_PROFILES['node-ts'])) as Record<string, unknown>;
  for (const key of RULEBOOK_KEYS) { delete p[key]; }
  return p as unknown as StandardsProfile;
}

describe('standards rulebook view', () => {
  it('maps every rulebook rule id to a section (the rules before the rulebook belong to none)', () => {
    const before = STANDARDS_RULE_IDS.slice(0, STANDARDS_RULE_IDS.indexOf('practice/todo-without-issue'));
    for (const rule of STANDARDS_RULE_IDS) {
      if (before.includes(rule)) { assert.equal(RULEBOOK_RULE_SECTION[rule], undefined, rule); continue; }
      assert.ok((RULEBOOK_KEYS as readonly string[]).includes(RULEBOOK_RULE_SECTION[rule]), rule);
    }
  });

  it('a legacy version: no section present, yet the always-on .env and credential checks are listed under security', () => {
    const view = rulebookView(legacy(), 4);
    assert.ok(view.sections.every((s) => !s.present));
    const security = view.sections.find((s) => s.key === 'security')!;
    assert.deepEqual(security.checked, [
      { kind: 'rule', rule: 'security/env-file', severity: 'advisory', alwaysOn: true },
      { kind: 'rule', rule: 'security/secret-literal', severity: 'advisory', alwaysOn: true },
    ]);
    assert.ok(view.sections.every((s) => s.guidance.length === 0 && s.notYetChecked.length === 0));
    assert.equal(view.sections.find((s) => s.key === 'accessibility')!.applicable, false, 'no UI: accessibility does not apply');
    assert.deepEqual(view.counts, { checked: 2, guidance: 0 });
  });

  it('the static-web built-in: HTML checks listed with their severity, guidance all sent, unset settings not yet checked', () => {
    const view = rulebookView(BUILT_IN_PROFILES['static-web'], 1);
    const a11y = view.sections.find((s) => s.key === 'accessibility')!;
    assert.equal(a11y.applicable, true);
    assert.deepEqual(a11y.checked.map((c) => (c.kind === 'rule' ? c.rule : c.label)), ['a11y/img-alt', 'a11y/html-lang']);
    assert.ok(view.sections.flatMap((s) => s.guidance).every((g) => g.sent));
    const docs = view.sections.find((s) => s.key === 'docsGit')!;
    assert.deepEqual(docs.notYetChecked, [{ text: 'The changelog is updated in a run that ships a version', hint: 'Checked once a changelog path is set.' }]);
    // Off in the built-ins until the pre-gate check is given requirement ids (deferred D1).
    assert.deepEqual(view.sections.find((s) => s.key === 'testPolicy')!.notYetChecked, [
      { text: 'Each requirement (R-n) is named in a test file', hint: 'Checked once "each requirement is named in a test" is switched on.' },
    ], 'off in the built-in');
    assert.equal(view.counts.guidance, view.sections.reduce((n, s) => n + s.guidance.length, 0));
  });

  it('a promoted rule shows as blocking; commands map to sections by label', () => {
    const p = promote(JSON.parse(JSON.stringify(BUILT_IN_PROFILES['node-ts'])) as StandardsProfile, 'practice/todo-without-issue');
    p.commands = [
      { label: 'Lint', run: 'npm run lint' }, { label: 'Typecheck', run: 'tsc' }, { label: 'Test', run: 'npm test' },
      { label: 'Audit', run: 'npm audit' }, { label: 'Bundle size', run: 'npx size-limit' }, { label: 'Build', run: 'npm run build' },
    ];
    const view = rulebookView(p, 2);
    const practice = view.sections.find((s) => s.key === 'practice')!;
    assert.deepEqual(practice.checked.find((c) => c.kind === 'rule' && c.rule === 'practice/todo-without-issue'),
      { kind: 'rule', rule: 'practice/todo-without-issue', severity: 'blocking' });
    assert.deepEqual(practice.checked.filter((c) => c.kind === 'command').map((c) => (c.kind === 'command' ? c.label : '')), ['Lint', 'Typecheck']);
    assert.equal(commandSection('Test'), 'testPolicy');
    assert.equal(commandSection('Vet'), 'practice', 'go vet is Coding practice');
    assert.equal(commandSection('Vetting'), null, 'only the word Vet');
    assert.equal(commandSection('npm audit'), 'security');
    assert.equal(commandSection('Lighthouse CI'), 'performance');
    assert.equal(commandSection('Build'), null, 'a command no section claims is listed in none');
  });

  it('guidance cut to fit the prompt is marked "not sent"', () => {
    const p: StandardsProfile = {
      ...sampleProfile(),
      freeText: Array.from({ length: 60 }, () => 'y'.repeat(48)).join('\n'),
      practice: { todoNeedsIssue: false, noDebugStatements: false, guidance: Array.from({ length: 12 }, (_, i) => `practice ${i} `.padEnd(150, '.')) },
    };
    const view = rulebookView(p, 1);
    const guidance = view.sections.find((s) => s.key === 'practice')!.guidance;
    assert.ok(guidance.some((g) => !g.sent), 'some items did not fit');
    assert.ok(guidance.some((g) => g.sent) || guidance.every((g) => !g.sent));
  });
});
