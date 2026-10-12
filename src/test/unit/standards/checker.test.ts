// ─── Standards checker — every rule is passed, failed or not-checked, never guessed ───

import { strict as assert } from 'assert';
import {
  MAX_REPORT_FINDINGS,
  MAX_REPORT_TAIL_CHARS,
  StandardsCheckFile,
  StandardsCheckInput,
  StandardsReport,
  StandardsRuleOutcome,
  capStandardsReport,
  checkStandards,
  commandRow,
  parseStandardsReport,
  skippedStandardsReport,
  standardsBlockingEvaluated,
  standardsBlockingState,
  standardsBlocked,
  isBlockingNotChecked,
  ruleOutcomeLabel,
  groupStandardsRules,
  standardsCheckCounts,
  BINARY_NOT_READ,
} from '../../../standards/checker';
import { templateDesign } from '../../../standards/design';
import { MAX_GLOB_WILDCARDS, globToRegExp, isUnder, matchesAny } from '../../../standards/glob';
import { RULE_RESULTS, STANDARDS_RULE_IDS, StandardsProfile, StandardsRuleId, ruleConfigured } from '../../../standards/profile';
import { BUILT_IN_PROFILES } from '../../../standards/built-in-profiles';
import { promote, sampleProfile, totalsOf } from './fixtures';
import { RULEBOOK_KEYS } from '../../../standards/rulebook';

/** A file whose every line was added. */
function added(path: string, lines: string[]): StandardsCheckFile {
  return { path, status: 'added', addedLines: lines.map((_, i) => i + 1), content: lines.join('\n') };
}

/** A legacy file in which only `addedLines` are new. */
function modified(path: string, lines: string[], addedLines: number[]): StandardsCheckFile {
  return { path, status: 'modified', addedLines, content: lines.join('\n') };
}

function input(files: StandardsCheckFile[], over: Partial<StandardsCheckInput> = {}): StandardsCheckInput {
  return { baseRef: 'abc123', files, existingDirs: ['src', 'src/test'], topLevel: ['src', 'docs', 'package.json'], goModulePath: null, ...over };
}

function outcome(report: StandardsReport, rule: StandardsRuleId): { result: string; reason?: string; unconfigured?: boolean } {
  const row = report.rules.find((r) => r.rule === rule);
  assert.ok(row, `no row for ${rule}`);
  return row;
}

function findingsFor(report: StandardsReport, rule: StandardsRuleId): Array<{ file: string; line: number }> {
  return report.findings.filter((f) => f.rule === rule).map((f) => ({ file: f.file, line: f.line }));
}

/** The `other` built-in without its Project Rulebook sections: nothing configured but the comment policy. */
function bareOther(): StandardsProfile {
  const p = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as Record<string, unknown>;
  for (const key of RULEBOOK_KEYS) { delete p[key]; }
  return p as unknown as StandardsProfile;
}

/** A profile with only the comment policy configured. */
function commentsOnly(over: Partial<StandardsProfile['comments']> = {}): StandardsProfile {
  const p = bareOther();
  p.comments = { ...p.comments, bannedPhrases: ['as an AI'], ...over };
  return p;
}

describe('standards glob', () => {
  it('supports *, ** and ? and nothing else', () => {
    assert.ok(globToRegExp('src/**/*.ts')!.test('src/a/b/c.ts'));
    assert.ok(globToRegExp('src/**/*.ts')!.test('src/c.ts'), '**/ matches zero segments');
    assert.ok(!globToRegExp('src/*.ts')!.test('src/a/c.ts'), '* stays within a segment');
    assert.ok(globToRegExp('src/ui/**')!.test('src/ui/a/b.tsx'));
    assert.ok(!globToRegExp('src/ui/**')!.test('src/uix/b.tsx'));
    assert.ok(globToRegExp('file?.js')!.test('file1.js'));
    assert.ok(!globToRegExp('file?.js')!.test('file12.js'));
    assert.ok(globToRegExp('a.(b)+[c]{d}|e$^')!.test('a.(b)+[c]{d}|e$^'), 'regex metacharacters are literal');
    assert.ok(!globToRegExp('*.ts')!.test('ats'), 'the dot is literal');
    assert.ok(globToRegExp('.*')!.test('.github'));
  });

  it('refuses patterns that are empty, too long or wildcard-heavy', () => {
    assert.equal(globToRegExp(''), null);
    assert.equal(globToRegExp('a'.repeat(201)), null);
    assert.equal(globToRegExp(Array.from({ length: MAX_GLOB_WILDCARDS + 1 }, () => '*a').join('/')), null);
  });

  it('matches a hostile pattern against a long path quickly', () => {
    const re = globToRegExp(Array.from({ length: MAX_GLOB_WILDCARDS }, () => '**').join('a'))!;
    const started = Date.now();
    re.test(`${'a'.repeat(400)}!`);
    assert.ok(Date.now() - started < 2_000);
  });

  it('matchesAny reports null when "no match" depends on an unreadable pattern', () => {
    assert.equal(matchesAny('src/a.ts', ['src/**']), true);
    assert.equal(matchesAny('lib/a.ts', ['src/**']), false);
    assert.equal(matchesAny('lib/a.ts', ['src/**', '']), null);
    assert.equal(matchesAny('src/a.ts', ['', 'src/**']), true);
    assert.equal(matchesAny('src\\a.ts', ['src/*.ts']), true, 'backslashes are normalised');
  });

  it('isUnder is a directory test, not a prefix test', () => {
    assert.ok(isUnder('src/ui/a.ts', 'src/ui'));
    assert.ok(isUnder('src/ui/a.ts', 'src/ui/'));
    assert.ok(!isUnder('src/uix/a.ts', 'src/ui'));
    assert.ok(isUnder('a.ts', '.'));
  });
});

describe('standards checker — report shape', () => {
  it('returns exactly one outcome per static rule, each a closed result', () => {
    const report = checkStandards(sampleProfile(), input([]));
    assert.deepEqual(report.rules.map((r) => r.rule), [...STANDARDS_RULE_IDS]);
    for (const r of report.rules) { assert.ok((RULE_RESULTS as readonly string[]).includes(r.result)); }
    assert.equal(report.version, null);
    assert.equal(report.baseRef, 'abc123');
    const t = report.totals;
    assert.equal(t.passed + t.noFindings + t.failed + t.advisory + t.notChecked + t.notConfigured, STANDARDS_RULE_IDS.length, 'every row is counted once');
  });

  it('reports every unconfigured rule as not configured — never passed, never counted as not checked', () => {
    const p = commentsOnly({ forbidCommentedOutCode: false, bannedPhrases: [] });
    const report = checkStandards(p, input([added('src/a.ts', ['const a = 1;'])]));
    // Five rules need no configuration: density always has a limit; a nested repository, a
    // newly generated file, a .env file and a credential are looked for whatever the profile says.
    const always = ['comment-policy/density', 'structure/nested-repository', 'exemption/newly-generated', 'security/env-file', 'security/secret-literal'];
    for (const rule of STANDARDS_RULE_IDS) {
      if (always.includes(rule)) { continue; }
      const row = report.rules.find((r) => r.rule === rule)!;
      assert.equal(row.result, 'not-checked', rule);
      assert.equal(row.unconfigured, true, rule);
      assert.match(row.reason ?? '', /Not configured/);
      assert.equal(ruleOutcomeLabel(row), 'not configured', rule);
    }
    for (const rule of always) { assert.equal(outcome(report, rule as StandardsRuleId).result, 'passed', rule); }
    // No static rule is counted as passed: all five found nothing, which is not a pass.
    assert.equal(report.totals.passed, 0);
    assert.equal(report.totals.noFindings, 5);
    assert.equal(report.totals.notChecked, 0, 'a rule the profile does not configure is no gap in the check');
    assert.equal(report.totals.notConfigured, STANDARDS_RULE_IDS.length - 5);
    const groups = groupStandardsRules(report);
    assert.equal(groups.notChecked.length, 0);
    assert.equal(groups.notConfigured.length, STANDARDS_RULE_IDS.length - 5);
    assert.equal(standardsCheckCounts(report).notCheckedRules, 0);
    assert.equal(report.totals.blockingNotChecked, 0, 'not configured is not "could not be read"');
    assert.equal(standardsBlockingEvaluated(report), false, 'nothing blocks by default, so there is no blocking set to vouch for');
    // A promoted rule the profile leaves unconfigured is no gap in the check of the rest.
    const promoted = checkStandards(promote(p, 'naming/files', 'comment-policy/density'), input([added('src/a.ts', ['const a = 1;'])]));
    assert.equal(standardsBlockingEvaluated(promoted), true, 'density was decided; unconfigured naming is no gap');
  });

  it('without git\'s view of the tree no rule is decided: not the diff rules, not required directories', () => {
    const report = checkStandards(sampleProfile(), input([], { baseRef: null }));
    for (const rule of STANDARDS_RULE_IDS) {
      const row = outcome(report, rule);
      assert.equal(row.result, 'not-checked', rule);
      // The sample profile has no design system and no rulebook: those rules are simply not configured.
      if (!ruleConfigured(sampleProfile(), rule)) { assert.equal(row.unconfigured, true, rule); continue; }
      assert.match(row.reason ?? '', /No diff could be taken/);
    }
    assert.equal(report.baseRef, null);
    // No rule blocks by default, so nothing blocking went unread; a promoted one would have.
    const unconfigured = STANDARDS_RULE_IDS.filter((r) => !ruleConfigured(sampleProfile(), r)).length;
    assert.ok(unconfigured > 0);
    assert.deepEqual(report.totals, totalsOf({ notChecked: STANDARDS_RULE_IDS.length - unconfigured, notConfigured: unconfigured }));
    assert.equal(standardsBlockingEvaluated(report), false);
    assert.equal(standardsBlockingState(report), 'none-configured');
    assert.equal(standardsBlockingState(checkStandards(promote(sampleProfile(), 'structure/required-dirs'), input([], { baseRef: null }))), 'not-checked',
      'a promoted required-directories rule with no listing to compare with was not evaluated');
    const promoted = checkStandards(promote(sampleProfile(), 'structure/nested-repository'), input([], { baseRef: null }));
    assert.equal(promoted.totals.blockingNotChecked, 1, 'a promoted rule that could not be evaluated is said to be blocking and unread');
  });

  it('an empty diff passes nothing: every diff-based rule is not-checked, and the diff was not judged', () => {
    // The shape left behind when violating work was committed and the base is the new HEAD.
    const report = checkStandards(sampleProfile(), input([]));
    // The two rules that read the state of the tree, not the diff, are still decided.
    const treeRules = ['structure/required-dirs', 'structure/nested-repository'];
    for (const rule of treeRules) { assert.equal(outcome(report, rule as StandardsRuleId).result, 'passed', rule); }
    for (const rule of STANDARDS_RULE_IDS) {
      if (treeRules.includes(rule)) { continue; }
      const row = outcome(report, rule);
      assert.equal(row.result, 'not-checked', rule);
      if (!ruleConfigured(sampleProfile(), rule)) { assert.equal(row.unconfigured, true, rule); continue; }
      assert.match(row.reason ?? '', /nothing for this rule to check/, rule);
    }
    const unconfigured = STANDARDS_RULE_IDS.filter((r) => !ruleConfigured(sampleProfile(), r)).length;
    assert.deepEqual(report.totals, totalsOf({ noFindings: 2, notChecked: STANDARDS_RULE_IDS.length - 2 - unconfigured, notConfigured: unconfigured }));
    assert.equal(standardsBlockingEvaluated(report), false, 'nothing blocking was decided');
  });

  it('a rule passes only on what it really judged: deletions and data files leave the line-based rules not-checked', () => {
    const p = sampleProfile();
    const report = checkStandards(p, input([
      modified('src/models/plan.ts', ['export const a = 1;'], []),
      added('notes/data.json', ['{}']),
    ], { topLevel: ['src', 'notes'] }));
    for (const rule of ['comment-policy/commented-out-code', 'comment-policy/banned-phrase', 'comment-policy/density', 'layering/imports'] as const) {
      assert.equal(outcome(report, rule).result, 'not-checked', rule);
    }
    // A file was added, so the name-based rules did judge something.
    for (const rule of ['structure/top-level', 'structure/placement', 'naming/files'] as const) {
      assert.equal(outcome(report, rule).result, 'passed', rule);
    }
    assert.equal(standardsBlockingEvaluated(report), false, 'no rule blocks by default');
    const promoted = checkStandards(promote(p, 'structure/required-dirs', 'structure/nested-repository'), input([
      modified('src/models/plan.ts', ['export const a = 1;'], []),
      added('notes/data.json', ['{}']),
    ], { topLevel: ['src', 'notes'] }));
    assert.equal(standardsBlockingEvaluated(promoted), true, 'both promoted rules were decided');
  });

  it('the blocking set is evaluated only when every configured blocking rule and command was decided', () => {
    const files = [added('src/models/plan.ts', ['export const a = 1;'])];
    const clean = checkStandards(sampleProfile(), input(files));
    assert.equal(standardsBlockingEvaluated(clean), false, 'with no command and no promoted rule there is no blocking set');

    // A profile command that has not run yet is a blocking row that was not evaluated.
    const pending: StandardsReport = { ...clean, rules: [...clean.rules, commandRow({ result: 'not-checked', command: 'npm run lint' })] };
    assert.equal(standardsBlockingEvaluated(pending), false);
    const ran: StandardsReport = { ...clean, rules: [...clean.rules, commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0 })] };
    assert.equal(standardsBlockingEvaluated(ran), true);

    // A failure is an evaluation; whether it blocks is a separate question.
    const missing = checkStandards(promote(sampleProfile(), 'structure/required-dirs'), input(files, { existingDirs: [] }));
    assert.equal(outcome(missing, 'structure/required-dirs').result, 'failed');
    assert.equal(standardsBlockingEvaluated(missing), true);

    // A promoted scanner rule that could not read a file leaves the set unevaluated,
    // and what the advisory scans read makes no difference either way.
    const unread = checkStandards(promote(sampleProfile(), 'comment-policy/banned-phrase'), input([added('src/main.rs', ['fn main() {}'])]));
    assert.equal(outcome(unread, 'comment-policy/banned-phrase').result, 'not-checked');
    assert.equal(standardsBlockingEvaluated(unread), false);
    const advisoryOnly = checkStandards(sampleProfile(), input([added('src/main.rs', ['fn main() {}'])]));
    assert.equal(outcome(advisoryOnly, 'comment-policy/banned-phrase').result, 'not-checked');
    const withCommand: StandardsReport = { ...advisoryOnly, rules: [...advisoryOnly.rules, commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0 })] };
    assert.equal(standardsBlockingEvaluated(withCommand), true);
  });

  it('a file the collector could not read is undecided even when the diff lists no added lines for it', () => {
    const unread: StandardsCheckFile = { path: 'src/ui/big.ts', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' };
    const p = sampleProfile();
    p.backend.forbiddenImports = [{ from: 'ui', to: 'models' }];
    const report = checkStandards(p, input([unread]));
    for (const rule of ['comment-policy/commented-out-code', 'comment-policy/banned-phrase', 'comment-policy/density', 'frontend/raw-pattern', 'layering/imports'] as const) {
      const row = outcome(report, rule);
      assert.equal(row.result, 'not-checked', rule);
      assert.match(row.reason ?? '', /larger than 512 KB \(src\/ui\/big\.ts\)/, rule);
    }
  });

  it('is pure: the same input gives a deep-equal report and the input is not mutated', () => {
    const files = [added('src/a.ts', ['const a = 1;', '// foo();'])];
    const snapshot = JSON.stringify(files);
    const a = checkStandards(sampleProfile(), input(files));
    const b = checkStandards(sampleProfile(), input(files));
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(files), snapshot);
  });
});

describe('standards checker — comment policy', () => {
  it('finds nothing in strings, URLs, a shebang, a licence header or a doc block', () => {
    const file = added('src/cli.ts', [
      '#!/usr/bin/env node',
      '/*',
      ' * Copyright (c) Acme. See http://acme.dev/licence',
      ' * useLicence(true);',
      ' */',
      'const a = \'// foo();\';',
      'const b = "// const x = 1;";',
      'const c = `// return bar();`;',
      'const url = "http://example.com/a(b);";',
      '/**',
      ' * Example:',
      ' *   const total = add(1, 2);',
      ' */',
      'export function add(x: number, y: number): number { return x + y; }',
      '// See https://example.com/docs/add(x);',
      '// eslint-disable-next-line no-console',
      '// @ts-expect-error legacy(call);',
      '// Explains why the retry exists.',
      'console.log(add(1, 2));',
    ]);
    const report = checkStandards(commentsOnly(), input([file]));
    assert.deepEqual(report.findings, []);
    assert.equal(outcome(report, 'comment-policy/commented-out-code').result, 'passed');
    assert.equal(outcome(report, 'comment-policy/banned-phrase').result, 'passed');
  });

  it('finds commented-out code with file, line and rule', () => {
    const file = added('src/a.ts', [
      'const live = 1;',
      '// const dead = compute(live);',
      '// if (dead) {',
      '//   retry();',
      '// }',
      'export default live;',
    ]);
    const report = checkStandards(commentsOnly(), input([file]));
    assert.equal(outcome(report, 'comment-policy/commented-out-code').result, 'failed');
    assert.deepEqual(findingsFor(report, 'comment-policy/commented-out-code'), [
      { file: 'src/a.ts', line: 2 }, { file: 'src/a.ts', line: 3 }, { file: 'src/a.ts', line: 4 },
      // The lone closing brace is a weak signal, counted because its neighbour is code too.
      { file: 'src/a.ts', line: 5 },
    ]);
    assert.ok(report.findings.every((f) => f.message.length > 0));
  });

  it('flags weak signals only when two sit on consecutive lines', () => {
    const alone = added('src/a.py', ['x = 1', '# total = price', 'y = 2']);
    assert.deepEqual(checkStandards(commentsOnly(), input([alone])).findings, []);

    const pair = added('src/b.py', ['x = 1', '# total = price', '# return total', 'y = 2']);
    assert.deepEqual(findingsFor(checkStandards(commentsOnly(), input([pair])), 'comment-policy/commented-out-code'), [
      { file: 'src/b.py', line: 2 }, { file: 'src/b.py', line: 3 },
    ]);
  });

  it('leaves ordinary prose alone, even when it mentions code', () => {
    const file = added('src/a.ts', [
      'const a = 1;',
      '// Returns early when the cache is warm (see warmCache).',
      '// If the request fails (timeout), retry once.',
      '// For each item, call process() and collect the result.',
      '// TODO(sam): remove after the migration',
      '// Usage: add(1, 2);',
      'const rows = [',
      '  make(6, 6), // n=12, poor',
      '  make(30, 0), // n=30, strong',
      '];',
      // A word followed by a parenthesis and then prose is an annotation, not a call.
      '// Note(alice): revisit once the cache lands (see ADR-12)',
      'const b = 2;',
      '// Fallback(legacy clients): keep the old header (remove in v3)',
      'const c = 3;',
      // A colon before a brace introduces an example; it does not open a block.
      '// Shape of the payload: {',
      'const d = 4;',
      // A keyword that is also an English word, a semicolon, and no expression between them.
      '// return early when the list is empty;',
      'const e = 5;',
      // Two formulas explain a calculation. Neither is a statement on its own.
      '// width = columns * cell',
      '// height = rows * cell',
      'const g = 6;',
      '// for each item in the list:',
      '// case closed, nothing more to do here;',
      'export default a;',
    ]);
    // (Density is its own rule; this fixture is nearly all comments on purpose.)
    assert.deepEqual(checkStandards(commentsOnly({ maxDensityPct: 100 }), input([file])).findings, []);
    // The same holds for the profile an admin accepts unread. (Its Project Rulebook TODO rule
    // rightly reports the bare TODO in this fixture; that is not the comment policy.)
    const builtIn = checkStandards(BUILT_IN_PROFILES['node-ts'], input([file], { topLevel: ['src'] }));
    assert.deepEqual(builtIn.findings.filter((f) => f.rule !== 'comment-policy/density' && f.rule !== 'practice/todo-without-issue'), []);
  });

  it('matches banned phrases on word boundaries: the built-in defaults leave documentation alone', () => {
    const prose = added('src/a.ts', [
      'const a = 1;',
      '// Kept as an aid for debugging slow starts.',
      '// Isolates the parser so the rest of the codebase never sees raw tokens.',
      '/** Shared helpers used by the rest of the code in this package. */',
      'export default a;',
    ]);
    const clean = checkStandards(BUILT_IN_PROFILES['node-ts'], input([prose], { topLevel: ['src'] }));
    assert.deepEqual(clean.findings, []);
    assert.equal(outcome(clean, 'comment-policy/banned-phrase').result, 'passed');

    const placeholders = added('src/b.ts', [
      'const a = 1;',
      '// As an AI, I cannot verify this.',
      '// ... rest of the code',
      '// The rest of the  code goes here.',
      '// rest of the code remains the same',
      '// TODO: implementation goes here',
      '// existing code',
      'export default a;',
    ]);
    // Line 2 is assistant voice and line 7 a bare two-word label: neither is a default any
    // more. Only the truncation placeholders are.
    assert.deepEqual(
      findingsFor(checkStandards(BUILT_IN_PROFILES['node-ts'], input([placeholders], { topLevel: ['src'] })), 'comment-policy/banned-phrase').map((f) => f.line),
      [3, 4, 5, 6],
    );
  });

  it('the default phrases are truncation placeholders only: no assistant voice, nothing prose-prone', () => {
    const defaults = BUILT_IN_PROFILES['node-ts'].comments.bannedPhrases;
    assert.ok(defaults.length > 0);
    for (const phrase of defaults) {
      assert.doesNotMatch(phrase, /\bAI\b/i, phrase);
      // Either the whole comment, or set off by an ellipsis on both sides.
      assert.match(phrase, /^\/\/ \S|^\.\.\. .* \.\.\.$/, phrase);
    }
    assert.ok(!defaults.includes('// existing code') && !defaults.includes('// remaining code'), 'a bare label is also a section heading');
    for (const stack of Object.keys(BUILT_IN_PROFILES) as Array<keyof typeof BUILT_IN_PROFILES>) {
      assert.deepEqual(BUILT_IN_PROFILES[stack].comments.bannedPhrases, defaults, stack);
    }
    // Honest prose about AI in a codebase that handles AI messages is left alone.
    const prose = added('src/a.ts', [
      'const a = 1;',
      '// Label the message as an AI response before it is stored.',
      '// As an AI assistant, I would answer here: the reply is rendered below.',
      'export default a;',
    ]);
    assert.deepEqual(checkStandards(BUILT_IN_PROFILES['node-ts'], input([prose], { topLevel: ['src'] })).findings, []);
  });

  it('a phrase is matched within ONE comment: never across two, and a block comment is read whole', () => {
    const p = commentsOnly({ bannedPhrases: ['// rest of the code', '... existing code ...', 'as an AI'] });
    const report = checkStandards(p, input([added('src/a.ts', [
      'const a = 1; /* rest of */ const b = 2; /* the code */',
      '/*',
      ' * rest of',
      ' * the code',
      ' */',
      '/* The cache keeps the',
      ' * rest of the code',
      ' * away from raw tokens. */',
      '// ... existing',
      '// code ...',
      '/* label it as an',
      '   AI response */',
      'export default a;',
    ])]));
    // Line 1 holds two comments and lines 9-10 are two comments: neither is run together.
    // Lines 2-5 are one comment that IS the placeholder, reported on line 3 where its words
    // start; lines 6-8 are one comment that says more, so its middle line is where a sentence
    // wrapped. Lines 11-12 are one comment, and a plain phrase is found in it across the line break.
    assert.deepEqual(findingsFor(report, 'comment-policy/banned-phrase'), [{ file: 'src/a.ts', line: 3 }, { file: 'src/a.ts', line: 11 }]);
  });

  it('a whole-comment phrase is held against the whole comment, a plain one only against the lines the change wrote', () => {
    const p = commentsOnly({ bannedPhrases: ['// rest of the code', 'as an AI'] });
    const lines = ['/* rest of', '   the code */', 'const a = 1;', '/* legacy: as an AI,', '   edited line */', 'export default a;'];
    // Only the second line of each block comment is new.
    const report = checkStandards(p, input([modified('src/a.ts', lines, [2, 5])]));
    assert.deepEqual(findingsFor(report, 'comment-policy/banned-phrase'), [{ file: 'src/a.ts', line: 2 }],
      'the placeholder is reported on the line the change wrote; the legacy phrase on an untouched line is not');
  });

  it('a profile phrase with regex metacharacters is matched literally', () => {
    const p = commentsOnly({ bannedPhrases: ['(placeholder)', 'a.b'] });
    const report = checkStandards(p, input([added('src/a.ts', ['const a = 1;', '// (placeholder) for now', '// axb is fine', '// see a.b here'])]));
    assert.deepEqual(findingsFor(report, 'comment-policy/banned-phrase').map((f) => f.line), [2, 4]);
  });

  // Each of these used to come back `passed`.
  describe('commented-out code the rule must not miss', () => {
    const codeLines = (file: StandardsCheckFile): number[] =>
      findingsFor(checkStandards(commentsOnly(), input([file])), 'comment-policy/commented-out-code').map((f) => f.line);

    it('above the first line of code: disabled statements are not a licence header', () => {
      assert.deepEqual(codeLines(added('src/a.ts', [
        '// import { old } from \'./old\';',
        '// const cache = new Map();',
        '// old.init(cache);',
        'import { live } from \'./live\';',
        'live();',
      ])), [1, 2, 3]);
    });

    it('below the header: the header ends at the first blank line, not at the first line of code', () => {
      assert.deepEqual(codeLines(added('src/a.ts', [
        '// Copyright (c) Acme. All rights reserved.',
        '// Licensed under the MIT licence.',
        '',
        '// old.init(cache);',
        'import { live } from \'./live\';',
      ])), [4]);
    });

    it('a whole file commented out is not all header', () => {
      assert.deepEqual(codeLines(added('src/a.ts', [
        '// Disabled until the migration lands.',
        '',
        '// import { old } from \'./old\';',
        '// export function run(): void {',
        '//   old.init();',
        '// }',
      ])), [3, 4, 5, 6]);
      assert.deepEqual(codeLines(added('src/b.py', ['# def run(x):', '#     return compute(x)'])), [1, 2]);
    });

    it('a shebang and a licence block separated by a blank line are still one header', () => {
      assert.deepEqual(codeLines(added('bin/tool.js', [
        '#!/usr/bin/env node',
        '',
        '// Copyright (c) Acme.',
        '// setup(licence);',
        'run();',
      ])), []);
    });

    it('Python blocks, with no terminator to go by', () => {
      assert.deepEqual(codeLines(added('src/a.py', [
        'x = 1',
        '# if x > 0:',
        '#     y = compute(x)',
        'z = 2',
        '# result = compute(a, b)',
        'w = 3',
        '# for item in items:',
        'v = 4',
        '# while not done:',
        'u = 5',
        '# with open(path) as handle:',
        't = 6',
        '# class Order(Base):',
        's = 7',
      ])), [2, 3, 5, 7, 9, 11, 13]);
    });

    it('Go short declarations and the return beside them', () => {
      assert.deepEqual(codeLines(added('internal/a.go', [
        'package a',
        '// x := compute(y)',
        'var live = 1',
        '// value, err := run(ctx)',
        '// return x, nil',
      ])), [2, 4, 5]);
    });

    it('a commented-out JSX element', () => {
      assert.deepEqual(codeLines(added('src/app.tsx', [
        'export const App = () => (',
        '  <main>',
        '    {/* <OldBanner title="x" /> */}',
        '    {/* Shown only to signed-in users. */}',
        '  </main>',
        ');',
      ])), [3]);
    });

    it('a `///` line and a one-line `/** */` that are statements, but not a doc block or a tag', () => {
      assert.deepEqual(codeLines(added('src/a.ts', [
        'const x = 1;',
        '/// const y = compute(x);',
        '/** legacy.init(x); */',
        '/// <reference path="./types.d.ts" />',
        '/** Initialises the legacy bridge. */',
        '/**',
        ' * Example:',
        ' *   legacy.init(x);',
        ' */',
        'export default x;',
      ])), [2, 3]);
    });

    it('unmistakable code trailing a live statement', () => {
      assert.deepEqual(codeLines(added('src/a.ts', [
        'const z = 2; // old.run(z);',
        'const n = 3; // n = 12, poor',
        'const m = 4; // see run(m) for why',
      ])), [1]);
    });
  });

  it('judges only added lines: legacy commented-out code in a modified file is not this change\'s', () => {
    const file = modified('src/a.ts', ['const a = 1;', '// legacyCall(a);', 'const b = 2;', '// freshCall(b);'], [3, 4]);
    assert.deepEqual(findingsFor(checkStandards(commentsOnly(), input([file])), 'comment-policy/commented-out-code'),
      [{ file: 'src/a.ts', line: 4 }]);
  });

  it('finds a banned phrase in a comment, case-insensitively, but not in code', () => {
    const file = added('src/a.ts', [
      'const label = "as an AI";',
      '// As an AI I cannot verify this.',
      '/** As an ai, documented. */',
      'export default label;',
    ]);
    const report = checkStandards(commentsOnly(), input([file]));
    assert.deepEqual(findingsFor(report, 'comment-policy/banned-phrase'), [
      { file: 'src/a.ts', line: 2 }, { file: 'src/a.ts', line: 3 },
    ]);
    assert.equal(outcome(report, 'comment-policy/banned-phrase').result, 'failed');
  });

  it('finds commented-out markup in html and a commented-out declaration in css', () => {
    const html = added('index.html', ['<p>live</p>', '<!-- <div class="old">gone</div> -->', '<!-- Navigation starts here -->']);
    const css = added('css/site.css', ['.a { color: red; }', '/* color: blue; */', '/* Layout helpers */']);
    const report = checkStandards(commentsOnly(), input([html, css]));
    assert.deepEqual(findingsFor(report, 'comment-policy/commented-out-code'), [
      { file: 'css/site.css', line: 2 }, { file: 'index.html', line: 2 },
    ]);
  });

  it('reports a .rs file as not-checked for every comment rule, never passed', () => {
    const report = checkStandards(commentsOnly(), input([added('src/main.rs', ['// foo();', 'fn main() {}'])]));
    for (const rule of ['comment-policy/commented-out-code', 'comment-policy/banned-phrase', 'comment-policy/density'] as const) {
      const row = outcome(report, rule);
      assert.equal(row.result, 'not-checked', rule);
      assert.match(row.reason ?? '', /No checker for \.rs files \(src\/main\.rs\)/);
    }
    assert.deepEqual(report.findings, []);
    // The nested-repository, generated-marker, .env and credential scans found nothing; none
    // of them reads the code as code, and the file is listed as not checked.
    assert.deepEqual(report.rules.filter((r) => r.result === 'passed').map((r) => r.rule),
      ['structure/nested-repository', 'exemption/newly-generated', 'security/env-file', 'security/secret-literal']);
    assert.deepEqual(report.notCheckedFiles, [{ file: 'src/main.rs', reason: 'No checker for .rs files' }]);
    assert.equal(report.totals.notCheckedFiles, 1);
    assert.equal(report.totals.noFindings, 4, 'the four scans that do not read the file as code');
    assert.equal(report.totals.passed, 0);
    assert.equal(report.totals.blockingNotChecked, 0, 'every comment rule is advisory by default');
    const promoted = checkStandards(promote(commentsOnly(), 'comment-policy/banned-phrase'), input([added('src/main.rs', ['// foo();', 'fn main() {}'])]));
    assert.equal(promoted.totals.blockingNotChecked, 1, 'once promoted, the rule that could not read the file is said to be blocking and unread');
  });

  it('reports an unterminated template string as not-checked', () => {
    const report = checkStandards(commentsOnly(), input([added('src/a.ts', ['// foo();', 'const a = `open'])]));
    const row = outcome(report, 'comment-policy/commented-out-code');
    assert.equal(row.result, 'not-checked');
    assert.match(row.reason ?? '', /unterminated template string/);
  });

  it('reports a skipped file as not-checked with the collector\'s reason', () => {
    const skipped: StandardsCheckFile = { path: 'src/big.ts', status: 'added', addedLines: [1], content: null, skipped: 'File is larger than 512 KB' };
    const row = outcome(checkStandards(commentsOnly(), input([skipped])), 'comment-policy/density');
    assert.equal(row.result, 'not-checked');
    assert.match(row.reason ?? '', /larger than 512 KB \(src\/big\.ts\)/);
  });

  it('still fails a rule when one file has a finding and another could not be read', () => {
    const report = checkStandards(commentsOnly(), input([
      added('src/a.ts', ['const a = 1;', '// foo();']),
      added('src/main.rs', ['fn main() {}']),
    ]));
    assert.equal(outcome(report, 'comment-policy/commented-out-code').result, 'failed');
    assert.equal(outcome(report, 'comment-policy/banned-phrase').result, 'not-checked');
  });

  it('ignores data and prose files instead of calling them unreadable', () => {
    const report = checkStandards(commentsOnly(), input([
      added('package.json', ['{ "name": "x" }']),
      added('README.md', ['# Title', '// foo();']),
      added('src/a.ts', ['const a = 1;']),
    ]));
    assert.equal(outcome(report, 'comment-policy/commented-out-code').result, 'passed');
    assert.deepEqual(report.findings, []);
  });

  describe('density', () => {
    const lines = (comments: number, code: number): string[] => [
      ...Array.from({ length: code }, (_, i) => `const v${i} = ${i};`),
      ...Array.from({ length: comments }, (_, i) => `// explanation number ${i}`),
    ];

    it('fires at 20 added lines when more than 30% are comments', () => {
      const report = checkStandards(commentsOnly(), input([added('src/a.ts', lines(7, 13))]));
      assert.equal(outcome(report, 'comment-policy/density').result, 'failed');
      const [finding] = report.findings;
      assert.deepEqual({ file: finding.file, line: finding.line, rule: finding.rule }, { file: 'src/a.ts', line: 14, rule: 'comment-policy/density' });
      assert.match(finding.message, /7 of 20 added lines \(35%\) are comments; the limit is 30%/);
    });

    it('does not fire at exactly the limit', () => {
      const report = checkStandards(commentsOnly(), input([added('src/a.ts', lines(6, 14))]));
      assert.equal(outcome(report, 'comment-policy/density').result, 'passed');
    });

    it('does not fire below 20 added lines, however dense', () => {
      const report = checkStandards(commentsOnly(), input([added('src/a.ts', lines(15, 4))]));
      assert.equal(outcome(report, 'comment-policy/density').result, 'passed');
      assert.deepEqual(report.findings, []);
    });

    it('counts added lines only, and leaves doc comments and the file header out', () => {
      const legacy = modified('src/a.ts', lines(15, 15), Array.from({ length: 10 }, (_, i) => i + 16));
      assert.equal(outcome(checkStandards(commentsOnly(), input([legacy])), 'comment-policy/density').result, 'passed',
        '10 added lines is under the threshold even though all are comments');

      const documented = added('src/b.ts', [
        '// Licence header line one',
        '// Licence header line two',
        ...Array.from({ length: 10 }, (_, i) => `/** Documents v${i}. */`),
        ...Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`),
      ]);
      assert.equal(outcome(checkStandards(commentsOnly(), input([documented])), 'comment-policy/density').result, 'passed');
    });
  });
});

describe('standards checker — structure', () => {
  it('required-dirs passes when every directory exists and fails naming the missing one', () => {
    assert.equal(outcome(checkStandards(sampleProfile(), input([])), 'structure/required-dirs').result, 'passed');
    const report = checkStandards(sampleProfile(), input([], { existingDirs: ['src'] }));
    assert.equal(outcome(report, 'structure/required-dirs').result, 'failed');
    assert.deepEqual(findingsFor(report, 'structure/required-dirs'), [{ file: 'src/test', line: 1 }]);
  });

  it('placement: a passing and a failing fixture', () => {
    const pass = checkStandards(sampleProfile(), input([added('src/ui/panel.tsx', ['export const a = 1;'])]));
    assert.equal(outcome(pass, 'structure/placement').result, 'passed');

    const fail = checkStandards(sampleProfile(), input([added('src/models/panel.tsx', ['export const a = 1;'])]));
    assert.equal(outcome(fail, 'structure/placement').result, 'failed');
    assert.deepEqual(findingsFor(fail, 'structure/placement'), [{ file: 'src/models/panel.tsx', line: 1 }]);
  });

  it('placement exempts modified legacy files', () => {
    const report = checkStandards(sampleProfile(), input([modified('src/models/panel.tsx', ['export const a = 1;'], [1])]));
    // No file was added, so the rule judged nothing: no finding, and no pass either.
    assert.equal(outcome(report, 'structure/placement').result, 'not-checked');
    assert.deepEqual(findingsFor(report, 'structure/placement'), []);
  });

  it('top-level: a new entry outside the allowed layout fails; a pre-existing one never does', () => {
    const fail = checkStandards(sampleProfile(), input([added('scratch/notes.ts', ['export {};']), added('scratch/more.ts', ['export {};'])]));
    assert.equal(outcome(fail, 'structure/top-level').result, 'failed');
    assert.equal(findingsFor(fail, 'structure/top-level').length, 1, 'one finding per new entry');

    const legacy = checkStandards(sampleProfile(), input([added('scratch/notes.ts', ['export {};'])], { topLevel: ['scratch'] }));
    assert.equal(outcome(legacy, 'structure/top-level').result, 'passed');

    const allowed = checkStandards(sampleProfile(), input([added('docs/new.md', ['# x'])], { topLevel: [] }));
    assert.equal(outcome(allowed, 'structure/top-level').result, 'passed');
  });

  it('an unreadable pattern makes the rule not-checked rather than passed', () => {
    const p = sampleProfile();
    p.structure.allowedTopLevel = [''.padEnd(MAX_GLOB_WILDCARDS + 2, '?')];
    const report = checkStandards(p, input([added('scratch/a.ts', ['export {};'])]));
    assert.equal(outcome(report, 'structure/top-level').result, 'not-checked');
  });
});

describe('standards checker — naming', () => {
  it('fails an added file whose name breaks the style and passes one that follows it', () => {
    const pass = checkStandards(sampleProfile(), input([added('src/usd-format.test.ts', ['export {};'])]));
    assert.equal(outcome(pass, 'naming/files').result, 'passed');

    const fail = checkStandards(sampleProfile(), input([added('src/usdFormat.ts', ['export {};'])]));
    assert.equal(outcome(fail, 'naming/files').result, 'failed');
    assert.deepEqual(findingsFor(fail, 'naming/files'), [{ file: 'src/usdFormat.ts', line: 1 }]);
    assert.match(fail.findings[0].message, /usdFormat\.ts is not kebab-case/);
  });

  it('exempts modified legacy files', () => {
    const report = checkStandards(sampleProfile(), input([modified('src/LegacyThing.ts', ['export {};', 'export const a = 1;'], [2])]));
    assert.equal(outcome(report, 'naming/files').result, 'not-checked');
    assert.deepEqual(report.findings, []);
  });

  it('supports each naming style', () => {
    const cases: Array<[StandardsProfile['naming']['files'][number]['style'], string, string]> = [
      ['PascalCase', 'src/OrderService.java', 'src/orderService.java'],
      ['snake_case', 'src/__init__.py', 'src/OrderService.py'],
      ['camelCase', 'src/orderService.js', 'src/order-service.js'],
      ['kebab-case', 'src/order-service.css', 'src/order_service.css'],
    ];
    for (const [style, good, bad] of cases) {
      const p = sampleProfile();
      p.naming.files = [{ globs: ['src/**'], style }];
      p.structure.placement = [];
      assert.equal(outcome(checkStandards(p, input([added(good, ['x'])])), 'naming/files').result, 'passed', `${style} ${good}`);
      assert.equal(outcome(checkStandards(p, input([added(bad, ['x'])])), 'naming/files').result, 'failed', `${style} ${bad}`);
    }
  });
});

describe('standards checker — frontend raw patterns', () => {
  it('a passing and a failing fixture for a built-in pattern, on added lines of code only', () => {
    const pass = checkStandards(sampleProfile(), input([added('src/ui/theme.ts', [
      'export const fg = "var(--ds-fg)";',
      '// The old value was #ff0000',
      'const n = items.#count;',
    ])]));
    assert.equal(outcome(pass, 'frontend/raw-pattern').result, 'passed');

    const fail = checkStandards(sampleProfile(), input([modified('src/ui/theme.ts', [
      'export const legacy = "#00ff00";',
      'export const fg = "#ff0000";',
    ], [2])]));
    assert.equal(outcome(fail, 'frontend/raw-pattern').result, 'failed');
    assert.deepEqual(findingsFor(fail, 'frontend/raw-pattern'), [{ file: 'src/ui/theme.ts', line: 2 }]);
    assert.equal(fail.findings[0].message, 'Use design tokens, not hex colours');
  });

  it('ignores files outside the pattern\'s globs', () => {
    const report = checkStandards(sampleProfile(), input([added('src/models/color.ts', ['export const c = "#ff0000";'])]));
    assert.equal(outcome(report, 'frontend/raw-pattern').result, 'passed');
  });

  it('matches a literal pattern, and falls back to the raw line where no lexer exists', () => {
    const p = sampleProfile();
    p.frontend.rawPatterns = [{ id: 'no-important', kind: 'literal', value: '!important', globs: ['**/*.scss', '**/*.css'], message: 'No !important' }];
    const report = checkStandards(p, input([
      added('css/a.css', ['.a { color: red !important; }', '/* never use !important */']),
      added('css/b.scss', ['.b { margin: 0 !important; }']),
    ]));
    assert.deepEqual(findingsFor(report, 'frontend/raw-pattern'), [{ file: 'css/a.css', line: 1 }, { file: 'css/b.scss', line: 1 }]);
  });

  it('detects inline styles and colour functions', () => {
    const p = sampleProfile();
    p.frontend.rawPatterns = [
      { id: 'inline', kind: 'builtin', value: 'inline-style', globs: [], message: 'inline' },
      { id: 'fn', kind: 'builtin', value: 'css-color-function', globs: [], message: 'fn' },
    ];
    const report = checkStandards(p, input([added('index.html', ['<p style="color:red">x</p>', '<p class="a">y</p>', '<i data-c="rgb(1,2,3)"></i>'])]));
    assert.deepEqual(report.findings.filter((f) => f.rule === 'frontend/raw-pattern').map((f) => [f.line, f.message]), [[1, 'inline'], [3, 'fn']]);
  });

  it('a file that was not read is not-checked', () => {
    const skipped: StandardsCheckFile = { path: 'src/ui/big.ts', status: 'added', addedLines: [1], content: null, skipped: 'Binary content' };
    assert.equal(outcome(checkStandards(sampleProfile(), input([skipped])), 'frontend/raw-pattern').result, 'not-checked');
  });
});

describe('standards checker — layer imports', () => {
  it('a passing and a failing fixture for relative imports', () => {
    const pass = checkStandards(sampleProfile(), input([added('src/models/plan.ts', [
      'import * as fs from "fs";',
      'import { helper } from "./helper";',
      'import { Panel } from "react-ui";',
    ])]));
    assert.equal(outcome(pass, 'layering/imports').result, 'passed');

    const fail = checkStandards(sampleProfile(), input([added('src/models/plan.ts', [
      'import { Panel } from "../ui/panel";',
      'const lazy = require(\'../ui/dashboard\');',
      'export { x } from "../ui";',
    ])]));
    assert.equal(outcome(fail, 'layering/imports').result, 'failed');
    assert.deepEqual(findingsFor(fail, 'layering/imports'), [
      { file: 'src/models/plan.ts', line: 1 }, { file: 'src/models/plan.ts', line: 2 }, { file: 'src/models/plan.ts', line: 3 },
    ]);
    assert.match(fail.findings[0].message, /models must not import from ui \(\.\.\/ui\/panel\)/);
  });

  it('.mts and .cts files are read like .ts: their imports are judged, and a file among them is never "no checker"', () => {
    for (const ext of ['mts', 'cts']) {
      const report = checkStandards(sampleProfile(), input([added(`src/models/plan.${ext}`, [
        'import { Panel } from "../ui/panel.mjs";',
        'const half = cfg.in! / 2; // halved',
        'import { helper } from "./helper.js";',
      ])]));
      assert.equal(outcome(report, 'layering/imports').result, 'failed', ext);
      assert.deepEqual(findingsFor(report, 'layering/imports'), [{ file: `src/models/plan.${ext}`, line: 1 }], ext);
      assert.deepEqual(report.notCheckedFiles, [], ext);
      for (const rule of ['comment-policy/commented-out-code', 'comment-policy/banned-phrase', 'comment-policy/density'] as const) {
        assert.equal(outcome(report, rule).result, 'passed', `${ext} ${rule}`);
      }
    }
  });

  it('resolves declared aliases and never flags a bare package import', () => {
    const report = checkStandards(sampleProfile(), input([added('src/models/plan.ts', [
      'import { Panel } from "@/ui/panel";',
      'import ui from "ui";',
      'import x from "src/ui/panel";',
    ])]));
    assert.deepEqual(findingsFor(report, 'layering/imports'), [{ file: 'src/models/plan.ts', line: 1 }]);
  });

  it('ignores an import that is only mentioned in a comment or was not added', () => {
    const report = checkStandards(sampleProfile(), input([modified('src/models/plan.ts', [
      'import { Panel } from "../ui/panel";',
      '// import { Other } from "../ui/other" would break layering',
      'export const a = 1;',
    ], [2, 3])]));
    assert.equal(outcome(report, 'layering/imports').result, 'passed');
  });

  it('allows the reverse direction', () => {
    const report = checkStandards(sampleProfile(), input([added('src/ui/panel.tsx', ['import { Plan } from "../models/plan";'])]));
    assert.equal(outcome(report, 'layering/imports').result, 'passed');
  });

  it('reports C# layering as not-checked', () => {
    const p = sampleProfile();
    p.backend.layers = [{ name: 'models', globs: ['src/Models/**'] }, { name: 'ui', globs: ['src/Ui/**'] }];
    p.naming.files = [];
    const report = checkStandards(p, input([added('src/Models/Plan.cs', ['using Acme.Ui;', 'class Plan {}'])]));
    const row = outcome(report, 'layering/imports');
    assert.equal(row.result, 'not-checked');
    assert.match(row.reason ?? '', /C# using directives cannot be mapped to paths/);
  });

  it('maps Go imports through the module path, and is not-checked without one', () => {
    const p = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.go)) as StandardsProfile;
    const file = added('internal/store/store.go', ['package store', 'import (', '\t"fmt"', '\t"github.com/acme/app/cmd/server"', ')']);
    const withModule = checkStandards(p, input([file], { goModulePath: 'github.com/acme/app' }));
    assert.deepEqual(findingsFor(withModule, 'layering/imports'), [{ file: 'internal/store/store.go', line: 4 }]);

    const without = checkStandards(p, input([file]));
    assert.equal(outcome(without, 'layering/imports').result, 'not-checked');
    assert.match(outcome(without, 'layering/imports').reason ?? '', /Go module path is unknown/);
  });

  it('maps Python relative imports', () => {
    const p = sampleProfile();
    p.backend.layers = [{ name: 'models', globs: ['app/models/**'] }, { name: 'ui', globs: ['app/ui/**'] }];
    p.backend.importAliases = [{ prefix: 'app.', path: 'app/' }];
    const report = checkStandards(p, input([added('app/models/plan.py', [
      'from ..ui import panel',
      'from . import helper',
      'import os',
      'from app.ui.panel import Panel',
    ])]));
    assert.deepEqual(findingsFor(report, 'layering/imports'), [{ file: 'app/models/plan.py', line: 1 }, { file: 'app/models/plan.py', line: 4 }]);
  });

  describe('Python `from <package> import <name>`: the imported name may be the forbidden package', () => {
    /** api must not import db. `app/main.py` is part of the api layer so `from . import db` can be written. */
    function apiDb(): StandardsProfile {
      const p = sampleProfile();
      p.backend = {
        layers: [{ name: 'api', globs: ['app/api/**', 'app/main.py'] }, { name: 'db', globs: ['app/db/**'] }],
        forbiddenImports: [{ from: 'api', to: 'db' }],
        importAliases: [],
      };
      p.naming.files = [];
      p.structure.placement = [];
      return p;
    }
    const layering = (p: StandardsProfile, file: string, lines: string[]) => {
      const report = checkStandards(p, input([added(file, lines)]));
      return { row: outcome(report, 'layering/imports'), lines: findingsFor(report, 'layering/imports').map((f) => f.line) };
    };

    it('from ..db import client is one finding, not one per name', () => {
      assert.deepEqual(layering(apiDb(), 'app/api/h.py', ['from ..db import client, session']).lines, [1]);
    });

    it('from .. import db fails', () => {
      const r = layering(apiDb(), 'app/api/h.py', ['from .. import db']);
      assert.equal(r.row.result, 'failed');
      assert.deepEqual(r.lines, [1]);
    });

    it('from . import db fails, alone, renamed with `as`, and among other names', () => {
      assert.deepEqual(layering(apiDb(), 'app/main.py', ['from . import db']).lines, [1]);
      assert.deepEqual(layering(apiDb(), 'app/main.py', ['from . import db as database']).lines, [1]);
      assert.deepEqual(layering(apiDb(), 'app/main.py', ['from . import config, db']).lines, [1]);
      assert.deepEqual(layering(apiDb(), 'app/main.py', ['from . import (config, db)']).lines, [1]);
    });

    it('an aliased from app import db fails; names outside the forbidden layer pass', () => {
      const p = apiDb();
      p.backend.importAliases = [{ prefix: 'app.', path: 'app/' }];
      assert.deepEqual(layering(p, 'app/api/h.py', ['from app import db']).lines, [1]);
      const fine = layering(p, 'app/api/h.py', ['from app import config', 'from .. import config', 'from . import helpers']);
      assert.equal(fine.row.result, 'passed');
      assert.deepEqual(fine.lines, []);
    });

    it('a name list that cannot be read on the line is not-checked for the project\'s own packages, never passed', () => {
      for (const line of ['from .. import (', 'from .. import *', 'from .. import config, \\']) {
        const r = layering(apiDb(), 'app/api/h.py', [line, '    db,', ')']);
        assert.equal(r.row.result, 'not-checked', line);
        assert.match(r.row.reason ?? '', /The names imported from \.\. could not be read on one line \(app\/api\/h\.py:1\)/, line);
      }
      // A third-party module spread over lines is no concern, and a forbidden module is already a finding.
      assert.equal(layering(apiDb(), 'app/api/h.py', ['from typing import (', '    List,', ')']).row.result, 'passed');
      const star = layering(apiDb(), 'app/api/h.py', ['from ..db import *']);
      assert.equal(star.row.result, 'failed');
      assert.deepEqual(star.lines, [1]);
    });
  });

  // An import the checker cannot place may cross a layer. Saying `passed` for it would be a guess.
  describe('imports that cannot be mapped to a path', () => {
    /** domain must not import web; no alias unless the test adds one. */
    function layered(domain: string, web: string): StandardsProfile {
      const p = sampleProfile();
      p.backend = {
        layers: [{ name: 'domain', globs: [domain] }, { name: 'web', globs: [web] }],
        forbiddenImports: [{ from: 'domain', to: 'web' }],
        importAliases: [],
      };
      p.naming.files = [];
      p.structure.placement = [];
      return p;
    }

    it('Java with no import alias is not-checked outright, as C# is', () => {
      const p = layered('src/main/java/com/a/domain/**', 'src/main/java/com/a/web/**');
      const report = checkStandards(p, input([added('src/main/java/com/a/domain/Order.java', [
        'package com.a.domain;',
        'import com.a.web.Controller;',
        'class Order {}',
      ])]));
      const row = outcome(report, 'layering/imports');
      assert.equal(row.result, 'not-checked');
      assert.match(row.reason ?? '', /Java imports cannot be mapped to paths without an import alias \(src\/main\/java\/com\/a\/domain\/Order\.java\)/);
      assert.deepEqual(findingsFor(report, 'layering/imports'), []);
    });

    it('Java with an alias: a mapped import is a finding, the JDK passes, and the project\'s own package outside every alias is not-checked', () => {
      const p = layered('src/main/java/com/a/domain/**', 'src/main/java/com/a/web/**');
      p.backend.importAliases = [{ prefix: 'com.a.web.', path: 'src/main/java/com/a/web/' }];
      const file = (imports: string[]) => added('src/main/java/com/a/domain/Order.java', ['package com.a.domain;', ...imports, 'class Order {}']);

      const mapped = checkStandards(p, input([file(['import com.a.web.Controller;'])]));
      assert.deepEqual(findingsFor(mapped, 'layering/imports'), [{ file: 'src/main/java/com/a/domain/Order.java', line: 2 }]);

      const jdk = checkStandards(p, input([file(['import java.util.List;', 'import com.google.common.base.Joiner;'])]));
      assert.equal(outcome(jdk, 'layering/imports').result, 'passed');

      const unmapped = checkStandards(p, input([file(['import com.a.api.Routes;'])]));
      assert.equal(outcome(unmapped, 'layering/imports').result, 'not-checked');
      assert.match(outcome(unmapped, 'layering/imports').reason ?? '', /Import com\.a\.api\.Routes cannot be mapped to a path/);
    });

    it('a Python absolute import of the project\'s own package is not-checked without an alias; the standard library still passes', () => {
      const p = layered('app/domain/**', 'app/api/**');
      for (const line of ['from app.api import routes', 'import app.api.routes']) {
        const report = checkStandards(p, input([added('app/domain/order.py', [line, 'x = 1'])]));
        const row = outcome(report, 'layering/imports');
        assert.equal(row.result, 'not-checked', line);
        assert.match(row.reason ?? '', /cannot be mapped to a path; declare an import alias for it \(app\/domain\/order\.py\)/, line);
      }
      const stdlib = checkStandards(p, input([added('app/domain/order.py', ['import os', 'from typing import List', 'x = 1'])]));
      assert.equal(outcome(stdlib, 'layering/imports').result, 'passed');
      // The relative form is still mapped, and still a finding.
      const relative = checkStandards(p, input([added('app/domain/order.py', ['from ..api import routes'])]));
      assert.deepEqual(findingsFor(relative, 'layering/imports'), [{ file: 'app/domain/order.py', line: 1 }]);
    });

    it('a JS non-relative specifier that names a repository path is not-checked without an alias; a package still passes', () => {
      const p = layered('src/domain/**', 'src/ui/**');
      for (const spec of ['src/ui/b', '@/ui/c', '~/ui/d', '#ui/e']) {
        const report = checkStandards(p, input([added('src/domain/order.ts', [`import { x } from "${spec}";`])]));
        assert.equal(outcome(report, 'layering/imports').result, 'not-checked', spec);
        assert.deepEqual(findingsFor(report, 'layering/imports'), [], spec);
      }
      const packages = checkStandards(p, input([added('src/domain/order.ts', [
        'import * as fs from "fs";', 'import React from "react";', 'import { z } from "@scope/pkg";',
      ])]));
      assert.equal(outcome(packages, 'layering/imports').result, 'passed');
    });

    it('a file outside every restricted layer is not held to its unmapped imports', () => {
      const p = layered('src/domain/**', 'src/ui/**');
      const report = checkStandards(p, input([added('src/ui/panel.ts', ['import { x } from "src/domain/order";'])]));
      assert.equal(outcome(report, 'layering/imports').result, 'passed');
    });
  });

  it('a file in a restricted layer that cannot be lexed is not-checked', () => {
    const report = checkStandards(sampleProfile(), input([added('src/models/plan.ts', ['const a = `open'])]));
    assert.equal(outcome(report, 'layering/imports').result, 'not-checked');
  });
});

describe('standards checker — skipped, capped and parsed reports', () => {
  it('skippedStandardsReport marks every static rule and every command not-checked with the reason', () => {
    const report = skippedStandardsReport(sampleProfile(), 4, 'abc', 'The change gate failed first');
    assert.equal(report.version, 4);
    assert.equal(report.rules.length, STANDARDS_RULE_IDS.length + 1);
    // A rule the profile configures carries the skip's reason; one it does not stays "not configured".
    for (const r of report.rules) {
      assert.equal(r.result, 'not-checked');
      const configured = r.rule === 'command' || ruleConfigured(sampleProfile(), r.rule);
      assert.equal(r.reason, configured ? 'The change gate failed first' : 'Not configured in this profile', r.rule);
      assert.equal(r.unconfigured === true, !configured, r.rule);
    }
    assert.deepEqual(report.rules[report.rules.length - 1],
      { rule: 'command', severity: 'blocking', result: 'not-checked', reason: 'The change gate failed first', command: 'npm run lint' });
    assert.ok(report.rules.every((r) => r.severity === 'blocking' || r.severity === 'advisory'), 'every row says how severe it is');
    // The command is blocking and did not run: unevaluated blocking evidence, counted as such.
    const unconfigured = STANDARDS_RULE_IDS.filter((r) => !ruleConfigured(sampleProfile(), r)).length;
    assert.deepEqual(report.totals, totalsOf({ notChecked: STANDARDS_RULE_IDS.length + 1 - unconfigured, notConfigured: unconfigured, blockingNotChecked: 1 }));
    assert.equal(standardsBlockingEvaluated(report), false, 'a skipped check evaluated nothing');
    assert.equal(standardsBlockingState(report), 'not-checked');
  });

  it('capStandardsReport bounds findings and tails but keeps the true finding total', () => {
    const lines = ['const first = 1;', ...Array.from({ length: 300 }, (_, i) => `// call${i}();`)];
    const full = checkStandards(commentsOnly({ maxDensityPct: 100 }), input([added('src/a.ts', lines)]));
    assert.equal(full.findings.length, 300);
    full.rules.push({ rule: 'command', result: 'failed', command: 'npm run lint', exitCode: 2, tail: 'x'.repeat(5_000) + 'END' });
    const capped = capStandardsReport(full);
    assert.equal(capped.findings.length, MAX_REPORT_FINDINGS);
    assert.equal(capped.totals.findings, 300);
    const row = capped.rules[capped.rules.length - 1];
    assert.equal(row.tail!.length, MAX_REPORT_TAIL_CHARS);
    assert.ok(row.tail!.endsWith('END'), 'the end of the output is what is kept');
    assert.equal(full.findings.length, 300, 'the original is untouched');
  });

  it('parseStandardsReport round-trips a real report through JSON', () => {
    const report = checkStandards(sampleProfile(), input([added('src/usdFormat.ts', ['export {};', '// foo();'])]));
    assert.equal(report.findings.length, 2);
    report.version = 3;
    report.rules.push(commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0, tail: 'ok' }));
    report.totals = { ...report.totals, passed: report.totals.passed + 1 };
    assert.deepEqual(parseStandardsReport(JSON.parse(JSON.stringify(report))), report);
  });

  it('parseStandardsReport reads a report stored before "not configured" existed by its reason', () => {
    const report = checkStandards(sampleProfile(), input([added('src/a.ts', ['export {};'])]));
    const unconfigured = report.rules.filter((r) => r.unconfigured === true).length;
    assert.ok(unconfigured > 0);
    // The legacy shape: no flag, every unconfigured rule counted among the rules not checked.
    const legacy = JSON.parse(JSON.stringify(report)) as StandardsReport;
    for (const r of legacy.rules) { delete r.unconfigured; }
    legacy.totals = { ...legacy.totals, notChecked: legacy.totals.notChecked + unconfigured };
    delete (legacy.totals as Partial<StandardsReport['totals']>).notConfigured;
    const parsed = parseStandardsReport(legacy)!;
    assert.equal(parsed.totals.notConfigured, unconfigured);
    assert.equal(parsed.totals.notChecked, report.totals.notChecked);
    assert.equal(parsed.rules.filter((r) => r.unconfigured === true).length, unconfigured);
    // An undecided row, or a command, is never read as "not configured", whatever its reason says.
    const forged = parseStandardsReport({ ...legacy, rules: [
      { rule: 'naming/files', result: 'not-checked', undecided: true, reason: 'Not configured in this profile' },
      { rule: 'command', result: 'not-checked', reason: 'Not configured in this profile', command: 'npm test' },
    ] })!;
    assert.equal(forged.totals.notConfigured, 0);
    assert.equal(forged.totals.notChecked, 2);
    assert.equal(forged.totals.blockingNotChecked, 2, 'both stay unevaluated blocking rows');
  });

  it('parseStandardsReport rejects malformed payloads instead of throwing', () => {
    const good = JSON.parse(JSON.stringify(checkStandards(sampleProfile(), input([])))) as Record<string, unknown>;
    const bad: unknown[] = [
      null, 'x', 7, [], {},
      { ...good, rules: 'nope' },
      { ...good, findings: {} },
      { ...good, version: '3' },
      { ...good, version: 0 },
      { ...good, baseRef: 5 },
      { ...good, rules: [{ rule: 'made/up', result: 'passed' }] },
      { ...good, rules: [{ rule: 'naming/files', result: 'skipped' }] },
      { ...good, rules: [null] },
      { ...good, findings: [{ file: 'a', line: -1, rule: 'naming/files', message: 'm' }] },
      { ...good, findings: [{ file: 'a', line: 1, rule: 'command', message: 'm' }] },
      { ...good, findings: [{ file: 7, line: 1, rule: 'naming/files', message: 'm' }] },
      { ...good, rules: Array.from({ length: 41 }, () => ({ rule: 'naming/files', result: 'passed' })) },
    ];
    for (const payload of bad) {
      assert.doesNotThrow(() => parseStandardsReport(payload));
      assert.equal(parseStandardsReport(payload), null, JSON.stringify(payload).slice(0, 80));
    }
  });

  it('parseStandardsReport caps what it accepts and recomputes the rule totals', () => {
    const finding = { file: 'f'.repeat(5_000), line: 1, rule: 'naming/files', message: 'm'.repeat(5_000) };
    const parsed = parseStandardsReport({
      version: 2,
      rules: [
        { rule: 'naming/files', result: 'failed', extra: 'dropped' },
        { rule: 'command', result: 'failed', command: 'c'.repeat(900), exitCode: 1, tail: 't'.repeat(9_000) },
      ],
      findings: Array.from({ length: 450 }, () => finding),
      totals: { passed: 99, failed: 0, notChecked: 0, findings: 450 },
    });
    assert.ok(parsed);
    assert.equal(parsed.findings.length, MAX_REPORT_FINDINGS);
    assert.equal(parsed.findings[0].file.length, 1_000);
    assert.equal(parsed.findings[0].message.length, 500);
    assert.equal(parsed.rules[1].tail!.length, MAX_REPORT_TAIL_CHARS);
    assert.equal(parsed.rules[1].command!.length, 500);
    assert.ok(!('extra' in parsed.rules[0]));
    assert.deepEqual(parsed.totals, totalsOf({ failed: 2, findings: 450 }));
    assert.deepEqual(parsed.rules.map((r) => r.severity), ['blocking', 'blocking'], 'a row with no severity is blocking');
    assert.equal(parsed.baseRef, null);
  });
});

// ─── frontend/design-tokens ───

describe('standards checker — frontend/design-tokens', () => {
  const RULE: StandardsRuleId = 'frontend/design-tokens';

  function designed(kit = ''): StandardsProfile {
    const p = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as StandardsProfile;
    p.frontend.componentKit = kit;
    p.design = templateDesign('node-ts', kit)!;
    return p;
  }
  /** The two design files exactly as approved (CRLF on disk is no difference). */
  function intact(p: StandardsProfile): StandardsCheckInput['designFiles'] {
    return [{ path: p.design!.docPath, content: p.design!.doc }, { path: p.design!.tokensPath, content: p.design!.tokens.replace(/\n/g, '\r\n') }];
  }
  const run = (p: StandardsProfile, files: StandardsCheckFile[], over: Partial<StandardsCheckInput> = {}): StandardsReport =>
    checkStandards(p, input(files, { designFiles: intact(p), ...over }));
  const row = (report: StandardsReport): StandardsRuleOutcome => report.rules.find((r) => r.rule === RULE)!;

  it('is not configured without a design system', () => {
    const report = checkStandards(BUILT_IN_PROFILES.other, input([added('src/a.css', ['a { color: #fff; }'])]));
    assert.equal(row(report).result, 'not-checked');
    assert.equal(row(report).unconfigured, true);
    assert.deepEqual(findingsFor(report, RULE), []);
  });

  it('a raw hex in .css and in .tsx is a finding; inside a comment it is not', () => {
    const report = run(designed(), [
      added('src/a.css', ['/* #ffffff is the old bg */', '.a { color: #1f2328; }', '.b { color: var(--color-fg); }']),
      added('src/B.tsx', ['// #000 in a comment', 'export const B = () => <div style={{ color: "#ff0000" }} />;']),
    ]);
    assert.deepEqual(findingsFor(report, RULE), [{ file: 'src/a.css', line: 2 }, { file: 'src/B.tsx', line: 2 }]);
    assert.equal(row(report).result, 'failed');
    assert.ok(report.findings.filter((f) => f.rule === RULE).every((f) => f.severity === 'advisory'));
    assert.match(report.findings.find((f) => f.rule === RULE)!.message, /Raw colour; use a design token from src\/styles\/tokens.css/);
    assert.equal(ruleOutcomeLabel(row(report)), 'findings');
    assert.equal(standardsBlocked(report), false, 'advisory by default');
  });

  it('a styled-components .ts file and a plain-JS .js component are scanned: raw values in their literals are findings', () => {
    const report = run(designed(), [
      added('src/d.ts', [
        'import styled from "styled-components";',
        'export const Box = styled.div`',
        '  color: #ff0000; padding: 16px;',
        '  margin: ${(p) => p.gap}px;',
        '  @media (min-width: 768px) { display: flex; }',
        '`;',
      ]),
      added('src/Card.js', ['export const Card = () => h("div", { style: { color: "#00ff00" } });']),
    ]);
    assert.deepEqual(report.findings.filter((f) => f.rule === RULE).map((f) => [f.file, f.line, f.message.split(';')[0]]), [
      ['src/Card.js', 1, 'Raw colour'],
      ['src/d.ts', 3, 'Raw colour'],
      ['src/d.ts', 3, 'Raw length'],
    ]);
  });

  it('in a .ts/.js file only literal text is read: code, comments and ${} expressions are not findings', () => {
    const report = run(designed(), [
      added('src/server.ts', [
        'class A { #abc = 1; #fade = 2; }',
        '// #ff0000 and 16px in a comment',
        'const n = 16; const css = `a { color: ${theme.fg}; }`;',
        'const label = "Version 2";',
      ]),
      added('src/b.mjs', ['export const x = 0x1f;']),
    ]);
    assert.deepEqual(findingsFor(report, RULE), []);
    assert.equal(row(report).result, 'passed', 'they were read: no design findings');
    assert.equal(ruleOutcomeLabel(row(report)), 'no findings');
  });

  it('a .ts file that cannot be lexed or read is not checked, never silently passed', () => {
    const unread = run(designed(), [{ path: 'src/big.ts', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' }]);
    assert.equal(row(unread).result, 'not-checked');
    assert.match(row(unread).reason ?? '', /not checked \(File is larger than 512 KB\) \(src\/big\.ts\)/);
    const unlexed = run(designed(), [added('src/broken.ts', ['const s = `never closed', 'color: #fff;'])]);
    if (row(unlexed).result === 'not-checked') {
      assert.match(row(unlexed).reason ?? '', /not checked \(.+\) \(src\/broken\.ts\)/);
    } else {
      // The lexer accepted it: then it was read, and the literal is a finding.
      assert.equal(row(unlexed).result, 'failed');
    }
  });

  it('@media lengths, 0 and 1px are not findings; 14px and rgb() are', () => {
    const report = run(designed(), [added('src/a.css', [
      '@media (min-width: 768px) {',
      '  .a { margin: 0; border: 1px solid var(--color-border); }',
      '  .b { font-size: 14px; }',
      '  .c { background: rgb(0, 0, 0); padding: var(--space-2, 8px); }',
      '}',
    ])]);
    assert.deepEqual(report.findings.filter((f) => f.rule === RULE).map((f) => [f.line, f.message.split(';')[0]]), [
      [3, 'Raw length'],
      [4, 'Raw colour'],
    ]);
  });

  it('a clean UI change reads "no findings", never "passed"', () => {
    const report = run(designed(), [added('src/a.css', ['.a { color: var(--color-fg); padding: var(--space-2); }'])]);
    assert.equal(row(report).result, 'passed');
    assert.equal(ruleOutcomeLabel(row(report)), 'no findings');
  });

  it('with the design files intact and no UI change, the integrity check alone is evidence', () => {
    const report = run(designed(), []);
    assert.equal(row(report).result, 'passed');
    assert.equal(ruleOutcomeLabel(row(report)), 'no findings');
  });

  it('the tokens file itself is never scanned, by either rule', () => {
    const p = designed();
    p.frontend.rawPatterns = [{ id: 'hex', kind: 'builtin', value: 'hex-color', globs: [], message: 'No hex' }];
    const report = run(p, [added(p.design!.tokensPath, p.design!.tokens.split('\n'))]);
    assert.deepEqual(report.findings, []);
  });

  it('a .scss change is not checked, undecided, with the reason; it is listed among the files not checked', () => {
    const report = run(designed(), [added('src/a.scss', ['$x: #fff;'])]);
    assert.equal(row(report).result, 'not-checked');
    assert.equal(row(report).undecided, true);
    assert.match(row(report).reason ?? '', /not checked \(unsupported type \(\.scss\)\) \(src\/a\.scss\)/);
    assert.ok((report.notCheckedFiles ?? []).some((f) => f.file === 'src/a.scss'));
  });

  it('an unread .css file is not checked', () => {
    const report = run(designed(), [{ path: 'src/big.css', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' }]);
    assert.equal(row(report).result, 'not-checked');
    assert.match(row(report).reason ?? '', /not checked \(File is larger than 512 KB\) \(src\/big\.css\)/);
  });

  it('a tokens file that differs, and a DESIGN.md that is missing, are findings on line 1', () => {
    const p = designed();
    const report = checkStandards(p, input([], { designFiles: [
      { path: p.design!.docPath, content: null, missing: true },
      { path: p.design!.tokensPath, content: p.design!.tokens.replace('#ffffff', '#fafafa') },
    ] }));
    assert.deepEqual(findingsFor(report, RULE), [{ file: 'docs/design/DESIGN.md', line: 1 }, { file: 'src/styles/tokens.css', line: 1 }]);
    const msgs = report.findings.map((f) => f.message).join('\n');
    assert.match(msgs, /docs\/design\/DESIGN.md is missing; it is part of the approved design system/);
    assert.match(msgs, /src\/styles\/tokens.css differs from the approved design system; runs may not change it/);
  });

  it('a design file that could not be read leaves the rule undecided', () => {
    const p = designed();
    const report = checkStandards(p, input([], { designFiles: [
      { path: p.design!.docPath, content: p.design!.doc },
      { path: p.design!.tokensPath, content: null, skipped: 'Not a regular file' },
    ] }));
    assert.equal(row(report).result, 'not-checked');
    assert.match(row(report).reason ?? '', /Not a regular file \(src\/styles\/tokens.css\)/);
  });

  it('an import of another known kit is a finding; the approved kit and unknown packages are not', () => {
    const report = run(designed('Chakra UI'), [added('src/App.tsx', [
      'import { Button } from "@mui/material";',
      'import { Box } from "@chakra-ui/react";',
      'import x from "lodash";',
    ])]);
    assert.deepEqual(report.findings.filter((f) => f.rule === RULE).map((f) => [f.line, f.message]),
      [[1, 'Imports @mui/material; the approved component kit is Chakra UI']]);
  });

  it('without the design files read, the rule is undecided', () => {
    const report = checkStandards(designed(), input([added('src/a.css', ['.a { color: var(--color-fg); }'])]));
    assert.equal(row(report).result, 'not-checked');
    assert.match(row(report).reason ?? '', /The design files were not read/);
  });

  it('promoted to blocking: a finding blocks; an unread check is blocking and not checked', () => {
    const p = promote(designed(), RULE);
    assert.equal(standardsBlocked(run(p, [added('src/a.css', ['.a { color: #123456; }'])])), true);
    const unread = checkStandards(p, input([]));
    assert.equal(isBlockingNotChecked(row(unread)), true);
    assert.equal(standardsBlockingState(unread), 'not-checked');
  });

  it('a vendored UI file is left out', () => {
    const report = run(designed(), [added('vendor/lib/a.css', ['.a { color: #fff; }'])]);
    assert.deepEqual(findingsFor(report, RULE), []);
  });

  describe('only style-shaped text is read as a colour or a length', () => {
    /** The design profile with test files and one backend layer declared. */
    function scoped(): StandardsProfile {
      const p = designed();
      p.testing.fileGlobs = ['**/*.test.ts'];
      p.backend.layers = [{ name: 'server', globs: ['src/server/**'] }];
      return p;
    }

    it('an issue reference, a selector, a test file and a backend file are no findings', () => {
      const report = run(scoped(), [
        added('src/ui/x.ts', ['// see below', 'const msg = \'fixes #123\';', 'document.querySelector(\'#abc\');']),
        added('src/ui/View.tsx', ['export const V = () => { document.querySelector("#abc"); return <p>Issue #123</p>; };']),
        added('src/ui/x.test.ts', ['const s = { color: \'#fff\' };']),
        added('src/server/x.ts', ['const s = { color: \'#fff\', padding: \'12px\' };']),
      ]);
      assert.deepEqual(findingsFor(report, RULE), []);
    });

    it('prose with a colon is not a CSS declaration: only a real property name (or a custom property) is read', () => {
      const prose = run(scoped(), [
        added('src/ui/p.ts', [
          'const a = \'Issue: #123\';',
          'const b = "Ref: #abc, see PR";',
          'const c = `Step 2: wait 3px later`;',
          'const d = \'Note: rgb( is not a colour here\';',
        ]),
      ]);
      assert.deepEqual(findingsFor(prose, RULE), []);
      const css = run(scoped(), [
        added('src/ui/q.ts', [
          'el.style.cssText = \'background-color: #123\';',
          'el.style.cssText = \'--brand: #abcdef\';',
          'el.style.cssText = \'margin-top: 4px\';',
        ]),
      ]);
      assert.deepEqual(findingsFor(css, RULE).map((f) => f.line), [1, 2, 3]);
    });

    it('a style object, a styled template, a css template and JSX colour attributes are findings', () => {
      const report = run(scoped(), [
        added('src/ui/a.ts', ['export const s = { color: \'#fff\' };']),
        added('src/ui/b.ts', ['export const B = styled.div`color:#fff`;']),
        added('src/ui/c.ts', ['export const c = css`padding: 12px`;']),
        added('src/ui/d.css', ['.d { color: #fff; }']),
        added('src/ui/e.html', ['<p style="color: #fff">x</p>']),
        added('src/ui/F.jsx', ['export const F = () => <div style={{color:\'#fff\'}} />;']),
        added('src/ui/G.tsx', ['export const G = () => <div style={{color:\'#fff\'}} />;']),
        added('src/ui/H.tsx', ['export const H = () => <path fill="#ff0000" />;']),
        added('src/ui/i.ts', ['el.style.cssText = \'border: 1px solid #333\';']),
      ]);
      assert.deepEqual([...new Set(findingsFor(report, RULE).map((f) => f.file))].sort(), [
        'src/ui/F.jsx', 'src/ui/G.tsx', 'src/ui/H.tsx', 'src/ui/a.ts', 'src/ui/b.ts', 'src/ui/c.ts', 'src/ui/d.css', 'src/ui/e.html', 'src/ui/i.ts',
      ].sort());
    });

    it('a change of only a test file and a backend file is out of scope: only the design files decide, nothing is undecided', () => {
      const report = run(scoped(), [
        added('src/ui/x.test.ts', ['const s = { color: \'#fff\' };']),
        added('src/server/x.ts', ['const s = { color: \'#fff\' };']),
      ]);
      assert.deepEqual(findingsFor(report, RULE), []);
      assert.equal(row(report).result, 'passed', 'the intact design files are the evidence');
      assert.equal(row(report).undecided, undefined);
      assert.doesNotMatch(row(report).reason ?? '', /x\.test\.ts|server\/x\.ts/);
      const unread = checkStandards(scoped(), input([added('src/server/x.ts', ['const s = { color: \'#fff\' };'])]));
      assert.doesNotMatch(row(unread).reason ?? '', /server\/x\.ts/, 'only the unread design files are named');
    });

    it('a script file with no style-shaped line is not evidence by itself', () => {
      const report = checkStandards(scoped(), input([added('src/ui/plain.ts', ['export const n = 1;'])], {
        designFiles: [],
      }));
      assert.equal(row(report).result, 'not-checked');
    });
  });
});

// ─── Project Rulebook rules ───

describe('standards checker — Project Rulebook rules', () => {
  /** The `other` built-in with the rulebook sections given. */
  function withRulebook(over: Partial<StandardsProfile>): StandardsProfile {
    return { ...bareOther(), ...over };
  }
  const rowOf = (report: StandardsReport, rule: StandardsRuleId): StandardsRuleOutcome => report.rules.find((r) => r.rule === rule)!;
  const practice = withRulebook({ practice: { todoNeedsIssue: true, noDebugStatements: true, guidance: [] } });

  it('practice/todo-without-issue: a TODO citing #12, JIRA-4 or a link is fine; a bare TODO or FIXME is a finding', () => {
    const report = checkStandards(practice, input([added('src/a.ts', [
      '// TODO #12 handle retries',
      '// TODO JIRA-4 split this',
      '// FIXME see https://example.com/issues/9',
      '// TODO handle retries',
      'const s = "TODO in a string";',
      '/* FIXME later */',
    ])]));
    assert.deepEqual(findingsFor(report, 'practice/todo-without-issue'), [{ file: 'src/a.ts', line: 4 }, { file: 'src/a.ts', line: 6 }]);
    assert.equal(ruleOutcomeLabel(rowOf(report, 'practice/todo-without-issue')), 'findings');
    assert.equal(rowOf(report, 'practice/todo-without-issue').severity, 'advisory');
  });

  it('practice/todo-without-issue: unconfigured is "not configured"; a file that cannot be lexed is not checked', () => {
    const off = checkStandards(bareOther(), input([added('src/a.ts', ['// TODO x'])]));
    assert.equal(rowOf(off, 'practice/todo-without-issue').unconfigured, true);
    const unread = checkStandards(practice, input([{ path: 'src/big.ts', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' }]));
    assert.equal(rowOf(unread, 'practice/todo-without-issue').result, 'not-checked');
    assert.match(rowOf(unread, 'practice/todo-without-issue').reason ?? '', /File is larger than 512 KB \(src\/big\.ts\)/);
  });

  it('practice/debug-statement: debugger in code and breakpoint() in Python are findings; in a string or another language they are not', () => {
    const report = checkStandards(practice, input([
      added('src/a.ts', ['const s = "debugger";', 'debugger;', 'if (x) { debugger;', '}']),
      added('tool/b.py', ['x = "breakpoint()"', 'breakpoint()', 'import pdb; pdb.set_trace()']),
      added('src/c.go', ['debugger']),
    ]));
    assert.deepEqual(findingsFor(report, 'practice/debug-statement'), [
      { file: 'src/a.ts', line: 2 }, { file: 'src/a.ts', line: 3 }, { file: 'tool/b.py', line: 2 }, { file: 'tool/b.py', line: 3 },
    ]);
    const goOnly = checkStandards(practice, input([added('src/c.go', ['package c'])]));
    assert.equal(rowOf(goOnly, 'practice/debug-statement').result, 'not-checked', 'a Go file is out of scope: nothing judged');
  });

  it('security/env-file: a .env or .env.local is a finding; .env.example is not; checked without any configuration', () => {
    const report = checkStandards(BUILT_IN_PROFILES.other, input([
      added('.env.example', ['API_KEY=']), added('.env.local', ['API_KEY=x']), added('config/.env', ['A=1']),
    ], { topLevel: [] }));
    assert.deepEqual(findingsFor(report, 'security/env-file'), [{ file: '.env.local', line: 1 }, { file: 'config/.env', line: 1 }]);
    assert.equal(rowOf(report, 'security/env-file').unconfigured, undefined);
    assert.equal(ruleOutcomeLabel(rowOf(checkStandards(BUILT_IN_PROFILES.other, input([added('src/a.ts', ['x'])])), 'security/env-file')), 'no findings');
  });

  it('security/secret-literal: a credential on an added line is a finding that never repeats the value', () => {
    const key = `sk-${'a1B2c3D4e5F6g7H8'.repeat(2)}`;
    const report = checkStandards(BUILT_IN_PROFILES.other, input([
      added('src/a.ts', ['const ok = 1;', `const k = "${key}";`]),
      modified('src/b.ts', [`const old = "${key}";`, 'const n = 2;'], [2]),
    ]));
    assert.deepEqual(findingsFor(report, 'security/secret-literal'), [{ file: 'src/a.ts', line: 2 }]);
    const f = report.findings.find((x) => x.rule === 'security/secret-literal')!;
    assert.equal(f.message, 'Credential-shaped value (an API key (sk-…)). The value is not shown.');
    assert.ok(!JSON.stringify(report).includes(key), 'the key appears nowhere in the report');
  });

  it('security/secret-literal: a binary file is out of scope; an oversize file is not checked', () => {
    const binary = checkStandards(BUILT_IN_PROFILES.other, input([{ path: 'img/a.png', status: 'added', addedLines: [], content: null, skipped: BINARY_NOT_READ }]));
    assert.equal(rowOf(binary, 'security/secret-literal').result, 'not-checked');
    assert.equal(rowOf(binary, 'security/secret-literal').undecided, undefined, 'out of scope, not undecided');
    const big = checkStandards(BUILT_IN_PROFILES.other, input([{ path: 'src/big.ts', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' }]));
    assert.equal(rowOf(big, 'security/secret-literal').undecided, true);
  });

  it('a11y/img-alt and a11y/html-lang: HTML pages only; a .tsx file is out of scope', () => {
    const p = withRulebook({ accessibility: { imgAlt: true, htmlLang: true, guidance: [] } });
    const report = checkStandards(p, input([
      added('web/index.html', ['<html>', '<body>', '<img src="a.png" alt="Logo">', '<img src="b.png">', '<img', '  src="c.png">', '</body></html>']),
      added('web/ok.html', ['<html lang="en">', '<img src="a.png" alt="">', '</html>']),
      modified('web/old.htm', ['<img src="x.png">', '<img src="y.png">'], [2]),
      added('src/App.tsx', ['export const A = () => <img src="x.png" />;']),
    ]));
    assert.deepEqual(findingsFor(report, 'a11y/img-alt'), [{ file: 'web/index.html', line: 4 }, { file: 'web/index.html', line: 5 }, { file: 'web/old.htm', line: 2 }]);
    assert.deepEqual(findingsFor(report, 'a11y/html-lang'), [{ file: 'web/index.html', line: 1 }]);
    const tsxOnly = checkStandards(p, input([added('src/App.tsx', ['export const A = () => <img src="x.png" />;'])]));
    assert.equal(rowOf(tsxOnly, 'a11y/img-alt').result, 'not-checked');
    assert.equal(rowOf(tsxOnly, 'a11y/html-lang').result, 'not-checked');
  });

  it('docs/changelog-updated: a change without the changelog is a finding at its path; with it, no findings; no diff is not checked', () => {
    const p = withRulebook({ docsGit: { changelogPath: 'CHANGELOG.md', guidance: [] } });
    const missing = checkStandards(p, input([added('src/a.ts', ['x'])]));
    assert.deepEqual(findingsFor(missing, 'docs/changelog-updated'), [{ file: 'CHANGELOG.md', line: 1 }]);
    const present = checkStandards(p, input([added('src/a.ts', ['x']), modified('CHANGELOG.md', ['# Changes', '- x'], [2])]));
    assert.equal(ruleOutcomeLabel(rowOf(present, 'docs/changelog-updated')), 'no findings');
    const noBase = checkStandards(p, input([added('src/a.ts', ['x'])], { baseRef: null }));
    assert.equal(rowOf(noBase, 'docs/changelog-updated').result, 'not-checked');
    assert.equal(rowOf(checkStandards(BUILT_IN_PROFILES.other, input([added('src/a.ts', ['x'])])), 'docs/changelog-updated').unconfigured, true);
  });

  it('every new rule is advisory: findings never stop the ship unless promoted, and a promoted one does', () => {
    const report = checkStandards(practice, input([added('src/a.ts', ['// TODO x', 'debugger;']), added('.env', ['A=1'])], { topLevel: [] }));
    assert.equal(standardsBlocked(report), false);
    assert.equal(standardsBlocked(checkStandards(promote(practice, 'practice/todo-without-issue'), input([added('src/a.ts', ['// TODO x'])]))), true);
  });
});

// ─── Project Rulebook rules that need new evidence: deleted files, requirement ids ───

describe('standards checker — migrations and requirement references', () => {
  function withRulebook(over: Partial<StandardsProfile>): StandardsProfile {
    return { ...bareOther(), ...over };
  }
  const rowOf = (report: StandardsReport, rule: StandardsRuleId): StandardsRuleOutcome => report.rules.find((r) => r.rule === rule)!;
  const migrations = withRulebook({ apiData: { migrationsGlob: 'db/migrate/**', guidance: [] } });

  it('data/migration-edited: an edited, deleted or moved-away migration is a finding; an added one is not', () => {
    const report = checkStandards(migrations, input([
      modified('db/migrate/002.sql', ['create table b (id int);', 'alter table b add c int;'], [2]),
      added('db/migrate/004.sql', ['create table d (id int);']),
      { path: 'db/old/003.sql', status: 'renamed', renamedFrom: 'db/migrate/003.sql', addedLines: [], content: 'x' },
    ], { deletedFiles: ['db/migrate/001.sql', 'src/gone.ts'] }));
    assert.deepEqual(findingsFor(report, 'data/migration-edited'), [
      { file: 'db/migrate/001.sql', line: 1 }, { file: 'db/migrate/002.sql', line: 1 }, { file: 'db/old/003.sql', line: 1 },
    ]);
    const fresh = checkStandards(migrations, input([added('db/migrate/004.sql', ['create table d (id int);'])], { deletedFiles: [] }));
    assert.equal(ruleOutcomeLabel(rowOf(fresh, 'data/migration-edited')), 'no findings');
  });

  it('data/migration-edited: deleted files not listed is "not checked"; unconfigured is "not configured"', () => {
    const unlisted = checkStandards(migrations, input([added('db/migrate/004.sql', ['x'])]));
    assert.equal(rowOf(unlisted, 'data/migration-edited').result, 'not-checked');
    assert.match(rowOf(unlisted, 'data/migration-edited').reason ?? '', /the deleted files were not listed/);
    assert.equal(rowOf(checkStandards(BUILT_IN_PROFILES.other, input([], { deletedFiles: [] })), 'data/migration-edited').unconfigured, true);
  });

  const traced = withRulebook({ testPolicy: { requirementReference: true, guidance: [] } });
  traced.testing.fileGlobs = ['test/**/*.test.js'];

  it('testing/requirement-reference: an id named in a changed test file is fine; one named nowhere is a finding; R-1 never matches R-10', () => {
    const report = checkStandards(traced, input([
      added('test/a.test.js', ['// covers R-10 and R-2', 'it("R-2 works", () => {});']),
      added('src/a.js', ['// R-1 is implemented here']),
    ], { requirementIds: ['R-1', 'R-2', 'R-10'] }));
    assert.deepEqual(findingsFor(report, 'testing/requirement-reference'), [{ file: 'requirement R-1', line: 1 }]);
    assert.match(report.findings.find((f) => f.rule === 'testing/requirement-reference')!.message, /Requirement R-1 is not named in any test file/);
  });

  it('testing/requirement-reference: no ids, or an unread test file, is not checked — never a pass', () => {
    const noIds = checkStandards(traced, input([added('test/a.test.js', ['x'])]));
    assert.equal(rowOf(noIds, 'testing/requirement-reference').result, 'not-checked');
    assert.match(rowOf(noIds, 'testing/requirement-reference').reason ?? '', /no requirement ids were given to this check/);
    const unread = checkStandards(traced, input([{ path: 'test/big.test.js', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' }],
      { requirementIds: ['R-1'] }));
    assert.equal(rowOf(unread, 'testing/requirement-reference').undecided, true);
    assert.deepEqual(findingsFor(unread, 'testing/requirement-reference'), []);
  });
});
