// ─── Every standards rule id is handled at every site that switches on it ───
//
// STANDARDS_RULE_IDS is a closed set. A new member must have a default severity, a
// configuration answer, exactly one row in every report, a reader-facing label in the web
// app, and an outcome word that is never "passed" (only a command passes). This test walks
// the whole set, so a member added without handling every site fails here.

import { strict as assert } from 'assert';
import {
  DEFAULT_RULE_SEVERITY,
  STANDARDS_RULE_IDS,
  StandardsProfile,
  StandardsRuleId,
  enforcementChangesBetween,
  isScannerRule,
  ruleConfigured,
  validateProfile,
} from '../../../standards/profile';
import { checkStandards, ruleOutcomeLabel, StandardsRuleOutcome } from '../../../standards/checker';
import { BUILT_IN_PROFILES } from '../../../standards/built-in-profiles';
import { promote, sampleProfile } from './fixtures';
import { fakeDomStubs, loadWebModule } from '../server/web-vm';

/** The rule ids the Project Rulebook added; each must be advisory by default. */
const RULEBOOK_RULE_IDS: StandardsRuleId[] = [
  'practice/todo-without-issue',
  'practice/debug-statement',
  'security/env-file',
  'security/secret-literal',
  'a11y/img-alt',
  'a11y/html-lang',
  'docs/changelog-updated',
  'data/migration-edited',
  'testing/requirement-reference',
];

/** A profile with every rulebook section configured, so every rule has something to judge. */
function everything(): StandardsProfile {
  return {
    ...sampleProfile(),
    practice: { todoNeedsIssue: true, noDebugStatements: true, guidance: [] },
    testPolicy: { requirementReference: false, guidance: [] },
    security: { guidance: [] },
    accessibility: { imgAlt: true, htmlLang: true, guidance: [] },
    apiData: { migrationsGlob: '', guidance: [] },
    docsGit: { changelogPath: 'CHANGELOG.md', guidance: [] },
    performance: { guidance: [] },
  };
}

describe('standards rule ids — every member handled at every site', () => {
  it('every rulebook id is a member, and advisory by default', () => {
    for (const rule of RULEBOOK_RULE_IDS) {
      assert.ok((STANDARDS_RULE_IDS as readonly string[]).includes(rule), rule);
      assert.equal(DEFAULT_RULE_SEVERITY[rule], 'advisory', rule);
    }
  });

  for (const rule of STANDARDS_RULE_IDS) {
    describe(rule, () => {
      it('has a default severity, a configuration answer and an enforcement comparison', () => {
        assert.ok(DEFAULT_RULE_SEVERITY[rule] === 'advisory' || DEFAULT_RULE_SEVERITY[rule] === 'blocking');
        for (const p of [BUILT_IN_PROFILES.other, everything()]) {
          assert.equal(typeof ruleConfigured(p, rule), 'boolean');
          assert.doesNotThrow(() => enforcementChangesBetween(p, promote(p, rule)));
          assert.doesNotThrow(() => enforcementChangesBetween(null, promote(p, rule)));
        }
        // The requirement-reference rule cannot be promoted until the pre-gate check gets the ids.
        assert.equal(validateProfile(promote(everything(), rule)).ok, rule !== 'testing/requirement-reference', 'promotion');
      });

      it('has exactly one row in a report, whose word is never "passed"', () => {
        for (const p of [BUILT_IN_PROFILES.other, everything()]) {
          const report = checkStandards(p, {
            baseRef: 'abc', files: [{ path: 'src/a.ts', status: 'added', addedLines: [1], content: 'const a = 1;' }],
            existingDirs: ['src'], topLevel: ['src'], goModulePath: null, designFiles: [],
          });
          const rows = report.rules.filter((r) => r.rule === rule);
          assert.equal(rows.length, 1);
          assert.ok(isScannerRule(rule));
          for (const result of ['passed', 'failed', 'not-checked'] as const) {
            assert.notEqual(ruleOutcomeLabel({ rule, result }), 'passed');
          }
        }
      });
    });
  }

  it('no built-in profile leaves a "no requirement ids" gap at a ship gate, which is given no ids', () => {
    // The pre-gate check is not given requirement ids yet (deferred D1), so the built-ins keep
    // the requirement-reference rule off: an unconfigured row, not an undecided gap.
    for (const [stack, p] of Object.entries(BUILT_IN_PROFILES)) {
      const report = checkStandards(p, {
        baseRef: 'abc', files: [{ path: 'src/a.test.ts', status: 'added', addedLines: [1], content: 'it("works", () => {});' }],
        existingDirs: ['src'], topLevel: ['src'], goModulePath: null, designFiles: [],
      });
      const row = report.rules.find((r) => r.rule === 'testing/requirement-reference');
      assert.ok(row, stack);
      assert.equal(row.unconfigured, true, stack);
      assert.notEqual(row.undecided, true, stack);
      assert.doesNotMatch(row.reason ?? '', /no requirement ids/, stack);
    }
  });

  it('the web app has a label for every rule id, and words every outcome of every rule', () => {
    const stubs = fakeDomStubs();
    const { RULE_LABELS } = loadWebModule('screens/standards.js', stubs, ['RULE_LABELS']) as { RULE_LABELS: Record<string, string> };
    const { ruleOutcome } = loadWebModule('screens/run.js', { ...stubs, cappedList: () => null }, ['ruleOutcome']) as {
      ruleOutcome: (row: Partial<StandardsRuleOutcome>) => { label: string };
    };
    for (const rule of STANDARDS_RULE_IDS) {
      assert.equal(typeof RULE_LABELS[rule], 'string', rule);
      assert.ok(RULE_LABELS[rule].length > 0, rule);
      for (const result of ['passed', 'failed', 'not-checked'] as const) {
        const label = ruleOutcome({ rule, result, severity: DEFAULT_RULE_SEVERITY[rule] }).label;
        assert.ok(label.length > 0, `${rule} ${result}`);
        assert.notEqual(label, 'Passed', `${rule} ${result}: a scan never passes`);
      }
    }
  });
});
