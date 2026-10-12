// ─── Standards checker — severity, and the inputs that used to read as "passed" ───
//
// A failed rule is `blocking` or `advisory`. Everything MOAG decides by scanning paths
// and text — placement, layering, naming, raw patterns, the top-level layout, the comment
// policy, generated markers — is advisory by default: reported with file, line and rule,
// never a reason to stop a release — and so are required directories and nested
// repositories. Only the profile's commands block by default. A project may promote a rule;
// the tests of what a BLOCKING scanner rule does promote it first, as a project would.
//
// The second half pins the ways unread content used to come back `passed`.

import { strict as assert } from 'assert';
import {
  StandardsCheckFile,
  StandardsCheckInput,
  StandardsReport,
  checkStandards,
  commandRow,
  groupStandardsRules,
  isBlockingNotChecked,
  isUnreadBlocking,
  parseStandardsReport,
  promotedScannerRules,
  recountTotals,
  ruleOutcomeLabel,
  severityOf,
  standardsBlocked,
  standardsBlockingEvaluated,
  standardsBlockingState,
  standardsCheckCounts,
  applyProfileSeverity,
  NOT_CONFIGURED,
  CONFIGURED_NOT_CHECKED,
} from '../../../standards/checker';
import { BUILT_IN_PROFILES } from '../../../standards/built-in-profiles';
import {
  DEFAULT_RULE_SEVERITY,
  RULE_SEVERITIES,
  STANDARDS_RULE_IDS,
  StandardsProfile,
  StandardsRuleId,
  isScannerRule,
  ruleSeverity,
} from '../../../standards/profile';
import { promote, sampleProfile } from './fixtures';

function added(path: string, lines: string[]): StandardsCheckFile {
  return { path, status: 'added', addedLines: lines.map((_, i) => i + 1), content: lines.join('\n') };
}

function input(files: StandardsCheckFile[], over: Partial<StandardsCheckInput> = {}): StandardsCheckInput {
  return { baseRef: 'abc123', files, existingDirs: ['src', 'src/test'], topLevel: ['src', 'docs', 'package.json'], goModulePath: null, ...over };
}

function row(report: StandardsReport, rule: StandardsRuleId) {
  const found = report.rules.find((r) => r.rule === rule);
  assert.ok(found, `no row for ${rule}`);
  return found;
}

function lines(report: StandardsReport, rule: StandardsRuleId): string[] {
  return report.findings.filter((f) => f.rule === rule).map((f) => `${f.file}:${f.line}`);
}

/** Only the comment policy, with every phrase the built-ins ban. */
function commentsOnly(): StandardsProfile {
  return JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as StandardsProfile;
}

const CODE_RULE = 'comment-policy/commented-out-code';
const PHRASE_RULE = 'comment-policy/banned-phrase';

describe('standards severity — defaults', () => {
  it('every rule has a default, and no rule blocks by default: only a profile command does', () => {
    assert.deepEqual(Object.keys(DEFAULT_RULE_SEVERITY).sort(), [...STANDARDS_RULE_IDS].sort());
    for (const rule of STANDARDS_RULE_IDS) { assert.ok((RULE_SEVERITIES as readonly string[]).includes(DEFAULT_RULE_SEVERITY[rule]), rule); }
    assert.deepEqual(STANDARDS_RULE_IDS.filter((r) => DEFAULT_RULE_SEVERITY[r] === 'blocking'), []);
    // Every rule MOAG decides itself is advisory by default, with no exception — the two
    // structural rules that used to block (required directories, nested repositories) too.
    for (const rule of STANDARDS_RULE_IDS) {
      assert.equal(isScannerRule(rule), true, rule);
      assert.equal(DEFAULT_RULE_SEVERITY[rule], 'advisory', rule);
      assert.equal(ruleSeverity({}, rule), 'advisory', rule);
    }
    assert.equal(isScannerRule('command'), false, 'a command is evidence, not a scan');
    assert.equal(commandRow({ result: 'failed', command: 'npm test' }).severity, 'blocking');
  });

  it('a missing required directory and a nested repository are findings that stop nothing until the project promotes the rule', () => {
    const p = sampleProfile();
    const bad = input([added('src/a.ts', ['export const a = 1;'])], { existingDirs: [], nestedRepos: ['cloned'] });
    const byDefault = checkStandards(p, bad);
    assert.equal(standardsBlocked(byDefault), false);
    assert.equal(byDefault.totals.failed, 0);
    for (const rule of ['structure/required-dirs', 'structure/nested-repository'] as const) {
      assert.equal(row(byDefault, rule).result, 'failed', rule);
      assert.equal(row(byDefault, rule).severity, 'advisory', rule);
    }
    const promoted = checkStandards(promote(p, 'structure/required-dirs', 'structure/nested-repository'), bad);
    assert.equal(standardsBlocked(promoted), true);
    assert.equal(promoted.totals.failed, 2);
    // Promotable like any other rule, and named with the same heuristic warning.
    assert.deepEqual(promotedScannerRules(promoted), ['structure/required-dirs', 'structure/nested-repository']);
  });

  it('every row and every finding of a report carries its severity', () => {
    const report = checkStandards(sampleProfile(), input([added('src/usdFormat.ts', ['export {};', '// foo();', '// as an AI I cannot'])]));
    for (const r of report.rules) { assert.equal(r.severity, DEFAULT_RULE_SEVERITY[r.rule as StandardsRuleId], r.rule); }
    assert.deepEqual(report.findings.map((f) => [f.rule, f.severity]).sort(), [
      ['comment-policy/banned-phrase', 'advisory'],
      ['comment-policy/commented-out-code', 'advisory'],
      ['naming/files', 'advisory'],
    ]);
    assert.equal(report.totals.advisoryFindings, 3);
    assert.equal(standardsBlocked(report), false);
  });
});

describe('standards wording — a scan never "passes"', () => {
  it('only a command passes or fails; every rule MOAG decides itself has findings or no findings', () => {
    assert.equal(ruleOutcomeLabel({ rule: 'command', result: 'passed' }), 'passed');
    assert.equal(ruleOutcomeLabel({ rule: 'command', result: 'failed' }), 'failed');
    for (const rule of STANDARDS_RULE_IDS) {
      assert.equal(ruleOutcomeLabel({ rule, result: 'passed' }), 'no findings', rule);
      assert.equal(ruleOutcomeLabel({ rule, result: 'failed' }), 'findings', rule);
    }
    for (const rule of [...STANDARDS_RULE_IDS, 'command'] as const) {
      assert.equal(ruleOutcomeLabel({ rule, result: 'not-checked' }), 'not checked', rule);
    }
  });

  it('the totals keep the two apart: "passed" never counts a scan', () => {
    const report = checkStandards(sampleProfile(), input([added('src/models/plan.ts', ['export const a = 1;'])]));
    const clean = report.rules.filter((r) => r.result === 'passed');
    assert.equal(report.totals.passed, clean.filter((r) => !isScannerRule(r.rule)).length);
    assert.equal(report.totals.noFindings, clean.filter((r) => isScannerRule(r.rule)).length);
    assert.equal(report.totals.passed, 0, 'no static rule is ever counted as passed');
    assert.ok(report.totals.noFindings > 0);
    report.rules.push(commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0 }));
    assert.equal(recountTotals(report).passed, 1, 'a command that exited 0 did pass');
  });

  it('a promoted scanner rule is named, so every surface can warn about it', () => {
    assert.deepEqual(promotedScannerRules(checkStandards(sampleProfile(), input([]))), []);
    const p = promote(sampleProfile(), 'layering/imports', 'naming/files');
    assert.deepEqual(promotedScannerRules(checkStandards(p, input([]))), ['layering/imports', 'naming/files']);
    // A promoted rule the profile does not configure warns about nothing.
    const bare = promote(commentsOnly(), 'layering/imports');
    assert.deepEqual(promotedScannerRules(checkStandards(bare, input([]))), []);
  });
});

describe('standards severity — an advisory failure is reported but never blocks', () => {
  const heuristicOnly = (): StandardsReport => checkStandards(sampleProfile(), input([
    // A camelCase name where kebab-case is asked, commented-out code, and a new top-level entry.
    added('src/usdFormat.ts', ['export {};', '// foo();']),
    added('scratch/notes.ts', ['export const a = 1;']),
  ]));

  it('the findings are listed with file, line and rule; the rules read failed; nothing is blocked', () => {
    const report = heuristicOnly();
    assert.deepEqual(report.findings.map((f) => `${f.file}:${f.line} ${f.rule}`), [
      'scratch/notes.ts:1 structure/top-level',
      'src/usdFormat.ts:1 naming/files',
      'src/usdFormat.ts:2 comment-policy/commented-out-code',
    ]);
    for (const rule of ['structure/top-level', 'naming/files', CODE_RULE] as const) {
      assert.equal(row(report, rule).result, 'failed', rule);
      assert.equal(row(report, rule).severity, 'advisory', rule);
    }
    assert.equal(standardsBlocked(report), false);
    assert.equal(report.totals.failed, 0, 'failed counts blocking failures only');
    assert.equal(report.totals.advisory, 3);
    assert.equal(report.totals.findings, 3);
    assert.equal(report.totals.advisoryFindings, 3);
    assert.equal(standardsBlockingEvaluated(report), false, 'nothing blocks by default: an empty blocking set vouches for nothing');
    report.rules.push(commandRow({ result: 'passed', command: 'npm test', exitCode: 0 }));
    assert.equal(standardsBlockingEvaluated(report), true, 'the command was decided; the advisory findings play no part');
  });

  it('the same failures block once the profile promotes the rule', () => {
    const p = sampleProfile();
    p.severity = { 'naming/files': 'blocking' };
    const report = checkStandards(p, input([added('src/usdFormat.ts', ['export {};'])]));
    assert.equal(row(report, 'naming/files').severity, 'blocking');
    assert.equal(report.findings[0].severity, 'blocking');
    assert.equal(standardsBlocked(report), true);
    assert.deepEqual([report.totals.failed, report.totals.advisory], [1, 0]);
  });

  it('a promoted rule the profile demotes again stops blocking, and still reports', () => {
    const p = promote(sampleProfile(), PHRASE_RULE);
    const violating = input([added('src/a.ts', ['export const a = 1;', '// as an AI, I cannot verify this'])]);
    assert.equal(standardsBlocked(checkStandards(p, violating)), true);

    p.severity = { 'comment-policy/banned-phrase': 'advisory' };
    const demoted = checkStandards(p, violating);
    assert.equal(ruleSeverity(p, PHRASE_RULE), 'advisory');
    assert.equal(standardsBlocked(demoted), false);
    assert.deepEqual(lines(demoted, PHRASE_RULE), ['src/a.ts:2']);
    assert.equal(demoted.totals.advisory, 1);
  });

  it('a promoted structural rule the profile demotes again stops blocking too, and still reports', () => {
    const p = promote(sampleProfile(), 'structure/required-dirs');
    const missing = input([added('src/a.ts', ['export const a = 1;'])], { existingDirs: [] });
    assert.equal(standardsBlocked(checkStandards(p, missing)), true);
    p.severity = { 'structure/required-dirs': 'advisory' };
    const demoted = checkStandards(p, missing);
    assert.equal(standardsBlocked(demoted), false);
    assert.deepEqual(lines(demoted, 'structure/required-dirs'), ['src:1', 'src/test:1']);
  });

  it('a failed profile command always blocks', () => {
    const report = checkStandards(sampleProfile(), input([added('src/a.ts', ['export const a = 1;'])]));
    report.rules.push(commandRow({ result: 'failed', command: 'npm run lint', exitCode: 1 }));
    report.totals = recountTotals(report);
    assert.equal(standardsBlocked(report), true);
    assert.equal(report.totals.failed, 1);
  });
});

describe('standards severity — the three groups every surface shows', () => {
  it('splits decided rows into Blocking and Advisory, and lists Not checked with unread blocking rules first', () => {
    const p = promote(sampleProfile(), 'layering/imports', PHRASE_RULE);
    p.backend.forbiddenImports = [{ from: 'ui', to: 'models' }];
    const report = checkStandards(p, input([
      added('src/usdFormat.ts', ['export {};']),
      // A restricted layer whose file cannot be lexed: layering and banned-phrase could not read it.
      added('src/ui/broken.ts', ['const a = `never closed']),
    ]));
    const groups = groupStandardsRules(report);
    assert.ok(groups.blocking.every((r) => r.severity === 'blocking' && r.result !== 'not-checked'));
    assert.ok(groups.advisory.every((r) => r.severity === 'advisory' && r.result !== 'not-checked'));
    assert.ok(groups.advisory.some((r) => r.rule === 'naming/files' && r.result === 'failed'));
    assert.equal(groups.blocking.length + groups.advisory.length + groups.notChecked.length + groups.notConfigured.length, report.rules.length);
    assert.ok(groups.notConfigured.length > 0 && groups.notConfigured.every((r) => r.unconfigured === true));
    assert.ok(groups.notChecked.every((r) => r.unconfigured !== true), 'a rule the profile does not configure is not "not checked"');

    const unread = groups.notChecked.filter(isUnreadBlocking).map((r) => r.rule);
    assert.deepEqual(unread.sort(), ['comment-policy/banned-phrase', 'layering/imports']);
    assert.deepEqual(groups.notChecked.slice(0, unread.length).map((r) => r.rule).sort(), unread.sort(), 'unread blocking rules lead the list');
    assert.equal(report.totals.blockingNotChecked, 2);
    for (const rule of unread) { assert.match(row(report, rule as StandardsRuleId).reason ?? '', /unterminated template string.*src\/ui\/broken\.ts/); }
  });

  it('a blocking rule that could not read its input is not-checked, never passed, and does not block on its own', () => {
    const p = promote(sampleProfile(), 'layering/imports');
    p.backend.forbiddenImports = [{ from: 'ui', to: 'models' }];
    const report = checkStandards(p, input([added('src/ui/broken.ts', ['import { a } from "../models/a";', 'const s = `open'])]));
    assert.equal(row(report, 'layering/imports').result, 'not-checked');
    assert.equal(row(report, 'layering/imports').undecided, true);
    assert.equal(standardsBlocked(report), false);
  });

  it('"not configured" and "nothing in the diff" are not flagged as unread', () => {
    const report = checkStandards(commentsOnly(), input([]));
    assert.ok(report.rules.every((r) => r.result !== 'not-checked' || r.undecided !== true));
    assert.equal(report.totals.blockingNotChecked, 0);
  });
});

describe('standards severity — reports that cross a process boundary', () => {
  it('keeps severity, the unread and unconfigured flags and the not-checked files through JSON, and recomputes the totals from them', () => {
    const p = promote(sampleProfile(), 'layering/imports');
    p.backend.forbiddenImports = [{ from: 'ui', to: 'models' }];
    p.frontend.rawPatterns = [];
    const report = checkStandards(p, input([added('src/usdFormat.ts', ['export {};']), added('src/ui/broken.ts', ['const a = `open'])]));
    assert.equal(report.notCheckedFiles?.length, 1);
    assert.ok(report.rules.some((r) => r.unconfigured === true) && report.rules.some((r) => r.undecided === true));
    const parsed = parseStandardsReport(JSON.parse(JSON.stringify({ ...report, totals: { passed: 99, failed: 99, noFindings: 99, findings: report.findings.length } })));
    assert.deepEqual(parsed, report);
  });

  it('a row cannot claim to be unconfigured to slip out of the blocking set', () => {
    const base = { version: 1, baseRef: 'abc', findings: [] };
    // Only a not-checked static rule can be "not configured": never a command, never an undecided row.
    const parsed = parseStandardsReport({ ...base, rules: [
      { rule: 'command', result: 'not-checked', unconfigured: true, command: 'npm run lint' },
      { rule: 'structure/nested-repository', result: 'not-checked', undecided: true, unconfigured: true },
      { rule: 'structure/required-dirs', result: 'passed', unconfigured: true },
    ] });
    assert.ok(parsed);
    assert.ok(parsed.rules.every((r) => r.unconfigured === undefined));
    assert.equal(standardsBlockingEvaluated(parsed), false);
  });

  it('the reader re-derives "not configured" from its own profile: a configured, promoted rule claimed unconfigured still blocks', () => {
    const base = { version: 1, baseRef: 'abc', findings: [] };
    // naming/files is configured in the sample profile and promoted here; frontend/design-tokens is not configured.
    const frozen = promote(sampleProfile(), 'naming/files');
    for (const claim of [{ unconfigured: true, reason: 'whatever' }, { reason: NOT_CONFIGURED }]) {
      const parsed = parseStandardsReport({ ...base, rules: [
        { rule: 'naming/files', severity: 'advisory', result: 'not-checked', ...claim },
        { rule: 'frontend/design-tokens', result: 'not-checked', reason: 'no flag at all' },
      ] });
      assert.ok(parsed);
      assert.equal(parsed.rules[0].unconfigured, true, 'the payload claims it');
      const report = applyProfileSeverity(parsed, frozen);
      const naming = report.rules.find((r) => r.rule === 'naming/files');
      assert.equal(naming?.unconfigured, undefined, 'the claim is ignored');
      assert.notEqual(naming?.reason, NOT_CONFIGURED, 'nor does the text keep saying "not configured"');
      if (claim.reason === NOT_CONFIGURED) { assert.equal(naming?.reason, CONFIGURED_NOT_CHECKED); }
      // A re-read of the stored row agrees: the text no longer makes it "not configured".
      const reread = parseStandardsReport(JSON.parse(JSON.stringify(report)));
      assert.equal(reread?.rules.find((r) => r.rule === 'naming/files')?.unconfigured, undefined);
      assert.equal(naming?.severity, 'blocking');
      assert.ok(naming && isBlockingNotChecked(naming));
      assert.equal(report.totals.blockingNotChecked, 1);
      assert.equal(standardsBlockingEvaluated(report), false, 'an unevaluated blocking rule is no pass');
      assert.equal(report.rules.find((r) => r.rule === 'frontend/design-tokens')?.unconfigured, true,
        'a rule the frozen profile does not configure is "not configured" whatever the payload says');
    }
  });

  it('with no profile to re-derive from, no row is "not configured": every not-checked rule counts against the gate', () => {
    const parsed = parseStandardsReport({ version: 1, baseRef: 'abc', findings: [], rules: [
      { rule: 'frontend/design-tokens', result: 'not-checked', unconfigured: true, reason: NOT_CONFIGURED },
    ] });
    assert.ok(parsed);
    const report = applyProfileSeverity(parsed, null);
    assert.equal(report.rules[0].unconfigured, undefined);
    assert.equal(report.rules[0].reason, CONFIGURED_NOT_CHECKED, 'the refused "not configured" text is replaced');
    assert.equal(report.totals.blockingNotChecked, 1);
  });

  it('the not-checked files are bounded and their true count is kept, never taken as less than what is listed', () => {
    const files = Array.from({ length: 450 }, (_, i) => ({ file: `gen/f${i}.ts`, reason: 'generated file' }));
    const parsed = parseStandardsReport({ version: 1, baseRef: 'abc', rules: [], findings: [], notCheckedFiles: files, totals: { notCheckedFiles: 3 } });
    assert.ok(parsed);
    assert.equal(parsed.notCheckedFiles?.length, 200);
    assert.equal(parsed.totals.notCheckedFiles, 200, 'a claimed total below the listed files is not believed');
    assert.equal(parseStandardsReport({ rules: [], findings: [], notCheckedFiles: files, totals: { notCheckedFiles: 450 } })?.totals.notCheckedFiles, 450);
    assert.equal(parseStandardsReport({ rules: [], findings: [], notCheckedFiles: [{ file: 7, reason: 'x' }] }), null);
    assert.equal(parseStandardsReport({ rules: [], findings: [], notCheckedFiles: 'nope' }), null);
    // A report written before the list existed has none, and says zero.
    const old = parseStandardsReport({ rules: [], findings: [] });
    assert.ok(old && old.notCheckedFiles === undefined && old.totals.notCheckedFiles === 0);
  });

  it('a report written before severities existed reads as all blocking', () => {
    const parsed = parseStandardsReport({
      version: 1, baseRef: 'abc', rules: [{ rule: 'naming/files', result: 'failed' }],
      findings: [{ file: 'a.ts', line: 1, rule: 'naming/files', message: 'm' }], totals: { findings: 1 },
    });
    assert.ok(parsed);
    assert.equal(severityOf(parsed.rules[0]), 'blocking');
    assert.equal(parsed.findings[0].severity, 'blocking');
    assert.equal(parsed.totals.failed, 1);
  });

  it('rejects an unknown severity, never lets a command be advisory, and takes a finding\'s severity from its rule row', () => {
    assert.equal(parseStandardsReport({ rules: [{ rule: 'naming/files', result: 'failed', severity: 'optional' }], findings: [] }), null);
    const parsed = parseStandardsReport({
      rules: [
        { rule: 'command', result: 'failed', severity: 'advisory', command: 'npm test' },
        { rule: 'comment-policy/banned-phrase', result: 'failed', severity: 'blocking' },
      ],
      findings: [{ file: 'a.ts', line: 1, rule: 'comment-policy/banned-phrase', message: 'm', severity: 'advisory' }],
    });
    assert.ok(parsed);
    assert.equal(parsed.rules[0].severity, 'blocking');
    assert.equal(parsed.findings[0].severity, 'blocking');
    assert.equal(parsed.totals.failed, 2);
  });
});

describe('standards checker — a nested repository', () => {
  it('is a finding naming the directory AND is listed as not checked: nothing inside was read', () => {
    const report = checkStandards(sampleProfile(), input([added('src/a.ts', ['export const a = 1;'])], { nestedRepos: ['third/cloned', 'tools\\gen'] }));
    const r = row(report, 'structure/nested-repository');
    assert.equal(r.result, 'failed');
    assert.equal(r.severity, 'advisory');
    assert.equal(ruleOutcomeLabel(r), 'findings', 'never "failed": MOAG decided this itself');
    assert.deepEqual(lines(report, 'structure/nested-repository'), ['third/cloned:1', 'tools/gen:1']);
    assert.match(report.findings.find((f) => f.file === 'third/cloned')!.message, /git repository of its own.*none of its files were read/);
    assert.deepEqual(report.notCheckedFiles, [
      { file: 'third/cloned', reason: 'nested repository — files inside were not read' },
      { file: 'tools/gen', reason: 'nested repository — files inside were not read' },
    ]);
    assert.equal(report.totals.notCheckedFiles, 2);
    assert.equal(standardsBlocked(report), false, 'advisory by default');
  });

  it('is reported by the state of the tree: an empty diff hides nothing, and promotion makes it stop the release', () => {
    // No changed file at all — the nested repository was there before this change, or came with it. Either way it is there.
    const report = checkStandards(commentsOnly(), input([], { nestedRepos: ['cloned'] }));
    assert.equal(row(report, 'structure/nested-repository').result, 'failed');
    assert.deepEqual(report.notCheckedFiles, [{ file: 'cloned', reason: 'nested repository — files inside were not read' }]);
    assert.equal(standardsBlocked(report), false);
    assert.equal(standardsBlocked(checkStandards(promote(commentsOnly(), 'structure/nested-repository'), input([], { nestedRepos: ['cloned'] }))), true);
  });

  it('a declared submodule is listed as not checked and is no finding', () => {
    const report = checkStandards(commentsOnly(), input([added('src/a.ts', ['export const a = 1;'])], { submodules: ['vendor/lib', 'docs\\theme'] }));
    assert.equal(row(report, 'structure/nested-repository').result, 'passed');
    assert.deepEqual(lines(report, 'structure/nested-repository'), []);
    assert.deepEqual(report.notCheckedFiles, [
      { file: 'docs/theme', reason: 'submodule — files inside were not read' },
      { file: 'vendor/lib', reason: 'submodule — files inside were not read' },
    ]);
    assert.equal(report.totals.findings, 0);
    assert.equal(standardsBlocked(checkStandards(promote(commentsOnly(), 'structure/nested-repository'), input([], { submodules: ['vendor/lib'] }))), false,
      'promoted or not, a declared submodule stops nothing');
  });

  it('a directory listed both ways is undeclared: the finding wins, and it is listed once', () => {
    const report = checkStandards(commentsOnly(), input([], { nestedRepos: ['x'], submodules: ['x', 'y'] }));
    assert.deepEqual(lines(report, 'structure/nested-repository'), ['x:1']);
    assert.deepEqual(report.notCheckedFiles, [
      { file: 'x', reason: 'nested repository — files inside were not read' },
      { file: 'y', reason: 'submodule — files inside were not read' },
    ]);
  });

  it('with no nested repository the rule says "no findings" about the tree, and an unread file is still listed', () => {
    const report = checkStandards(commentsOnly(), input([added('src/main.rs', ['fn main() {}'])]));
    assert.equal(row(report, 'structure/nested-repository').result, 'passed');
    assert.equal(ruleOutcomeLabel(row(report, 'structure/nested-repository')), 'no findings');
    assert.deepEqual(report.notCheckedFiles, [{ file: 'src/main.rs', reason: 'No checker for .rs files' }]);
    for (const rule of [CODE_RULE, PHRASE_RULE, 'comment-policy/density'] as const) { assert.equal(row(report, rule).result, 'not-checked', rule); }
  });

  it('is not-checked when git gave no view of the tree', () => {
    const report = checkStandards(commentsOnly(), input([], { baseRef: null, nestedRepos: ['cloned'] }));
    assert.equal(row(report, 'structure/nested-repository').result, 'not-checked');
    assert.equal(row(report, 'structure/nested-repository').undecided, true);
  });
});

describe('standards checker — required directories are compared with what git lists, exactly', () => {
  const dirs = (requiredDirs: string[], existingDirs: string[], baseRef: string | null = 'abc123'): StandardsReport => {
    const p = commentsOnly();
    p.structure.requiredDirs = requiredDirs;
    return checkStandards(p, input([], { existingDirs, baseRef }));
  };

  it('a directory git does not list is a finding, whatever the file system would say about its case', () => {
    // The evidence collector reports `SRC` as existing only when git lists a path under `SRC/`.
    const report = dirs(['src', 'docs'], ['SRC', 'docs']);
    assert.deepEqual(lines(report, 'structure/required-dirs'), ['src:1']);
    assert.equal(row(report, 'structure/required-dirs').severity, 'advisory');
    assert.equal(ruleOutcomeLabel(row(report, 'structure/required-dirs')), 'findings');
  });

  it('every required directory listed is "no findings", never "passed"', () => {
    assert.equal(ruleOutcomeLabel(row(dirs(['src'], ['src']), 'structure/required-dirs')), 'no findings');
  });

  it('with no listing from git the rule is not checked — not a finding per directory, and not a pass', () => {
    const report = dirs(['src'], [], null);
    assert.equal(row(report, 'structure/required-dirs').result, 'not-checked');
    assert.deepEqual(lines(report, 'structure/required-dirs'), []);
  });
});

describe('standards checker — the blocking set: evaluated, not checked, or none configured', () => {
  const clean = [added('src/a.ts', ['export const a = 1;'])];
  const withCommand = (report: StandardsReport, result: 'passed' | 'failed' | 'not-checked'): StandardsReport => {
    report.rules.push(commandRow({ result, command: 'npm test', ...(result === 'not-checked' ? { reason: 'Commands were not run' } : { exitCode: result === 'passed' ? 0 : 1 }) }));
    report.totals = recountTotals(report);
    return report;
  };

  it('no command and no promoted rule: none configured — allowed to ship, and never called evaluated or passed', () => {
    for (const profile of [commentsOnly(), sampleProfile(), ...Object.values(BUILT_IN_PROFILES)]) {
      const report = checkStandards(profile, input(clean));
      assert.equal(standardsBlockingState(report), 'none-configured');
      assert.equal(standardsBlockingEvaluated(report), false);
      assert.equal(standardsBlocked(report), false);
      assert.equal(report.totals.passed, 0, 'nothing passed: no command ran');
      assert.equal(report.totals.blockingNotChecked, 0);
      assert.deepEqual(standardsCheckCounts(report).noBlockingRules, true);
    }
  });

  it('a command that ran makes the set evaluated, pass or fail; the counts then carry no "no blocking rules"', () => {
    for (const result of ['passed', 'failed'] as const) {
      const report = withCommand(checkStandards(commentsOnly(), input(clean)), result);
      assert.equal(standardsBlockingState(report), 'evaluated', result);
      assert.equal(standardsBlocked(report), result === 'failed');
      assert.equal('noBlockingRules' in standardsCheckCounts(report), false);
    }
  });

  it('a command that did not run is unevaluated blocking evidence: not checked, counted, never a pass', () => {
    const report = withCommand(checkStandards(commentsOnly(), input(clean)), 'not-checked');
    assert.equal(standardsBlockingState(report), 'not-checked');
    assert.equal(standardsBlockingEvaluated(report), false);
    assert.equal(report.totals.blockingNotChecked, 1);
    assert.equal(isBlockingNotChecked(report.rules[report.rules.length - 1]), true);
    assert.equal(isUnreadBlocking(report.rules[report.rules.length - 1]), false, 'that word is kept for a rule that could not read a file');
    // One command passing does not vouch for the one that never ran.
    assert.equal(standardsBlockingState(withCommand(withCommand(checkStandards(commentsOnly(), input(clean)), 'passed'), 'not-checked')), 'not-checked');
  });

  it('a promoted rule that could not read a changed file, or had no diff, is not checked', () => {
    const promoted = promote(commentsOnly(), CODE_RULE);
    const unread = checkStandards(promoted, input([added('src/main.rs', ['fn main() {}'])]));
    assert.equal(row(unread, CODE_RULE).undecided, true);
    assert.equal(standardsBlockingState(unread), 'not-checked');
    assert.equal(unread.totals.blockingNotChecked, 1);
    assert.equal(standardsBlockingState(checkStandards(promoted, input([], { baseRef: null }))), 'not-checked');
  });

  it('a promoted rule the change gave nothing to judge is not checked too — no reason is weighed; an unconfigured one is no gap', () => {
    // Only a data file changed: the rule looked at nothing. That is not a result.
    const nothingInScope = checkStandards(promote(commentsOnly(), CODE_RULE), input([added('data/a.json', ['{}'])]));
    assert.equal(row(nothingInScope, CODE_RULE).result, 'not-checked');
    assert.notEqual(row(nothingInScope, CODE_RULE).undecided, true);
    assert.equal(standardsBlockingState(nothingInScope), 'not-checked');
    assert.equal(nothingInScope.totals.blockingNotChecked, 1);
    assert.equal(isBlockingNotChecked(row(nothingInScope, CODE_RULE)), true);
    assert.equal(isUnreadBlocking(row(nothingInScope, CODE_RULE)), false, 'it could read everything; there was nothing for it');
    // An empty diff under a promoted rule: nothing was judged, so nothing is vouched for.
    assert.equal(standardsBlockingState(checkStandards(promote(commentsOnly(), CODE_RULE), input([]))), 'not-checked');
    // Promoted but unconfigured: it can stop nothing, so the profile still has no blocking set.
    const unconfigured = checkStandards(promote(commentsOnly(), 'naming/files'), input(clean));
    assert.equal(row(unconfigured, 'naming/files').unconfigured, true);
    assert.equal(standardsBlockingState(unconfigured), 'none-configured');
  });

  it('the state survives a process boundary: a parsed report says the same', () => {
    const reports = [
      checkStandards(commentsOnly(), input(clean)),
      withCommand(checkStandards(commentsOnly(), input(clean)), 'passed'),
      withCommand(checkStandards(commentsOnly(), input(clean)), 'not-checked'),
      checkStandards(promote(commentsOnly(), CODE_RULE), input([added('src/main.rs', ['fn main() {}'])])),
    ];
    for (const report of reports) {
      const parsed = parseStandardsReport(JSON.parse(JSON.stringify(report)));
      assert.ok(parsed);
      assert.equal(standardsBlockingState(parsed), standardsBlockingState(report));
      assert.equal(parsed.totals.blockingNotChecked, report.totals.blockingNotChecked);
    }
  });
});

describe('standards checker — a file type no scanner reads is listed, never skipped in silence', () => {
  const unsupported: Array<[string, string]> = [
    ['build.gradle', '.gradle'], ['build.gradle.kts', '.kts'], ['docs/guide.mdx', '.mdx'], ['assets/logo.svg', '.svg'],
    ['src/App.vue', '.vue'], ['src/App.svelte', '.svelte'], ['src/site.scss', '.scss'], ['scripts/deploy.sh', '.sh'],
    ['.github/workflows/ci.yml', '.yml'], ['config/app.yaml', '.yaml'], ['pyproject.toml', '.toml'],
    ['Dockerfile', 'Dockerfile'], ['docker/Dockerfile.dev', 'Dockerfile'], ['Makefile', 'Makefile'],
  ];

  it('each one, added or modified with new lines, is listed as not checked (unsupported type)', () => {
    for (const [file, label] of unsupported) {
      for (const changed of [added(file, ['x = 1']), { path: file, status: 'modified' as const, addedLines: [1], content: 'x = 1\ny = 2' }]) {
        const report = checkStandards(commentsOnly(), input([changed]));
        assert.deepEqual(report.notCheckedFiles, [{ file, reason: `unsupported type (${label})` }], `${file} (${changed.status})`);
        assert.equal(report.totals.notCheckedFiles, 1, file);
        assert.equal(standardsCheckCounts(report).notCheckedFiles, 1, file);
      }
    }
  });

  it('a whole change of unsupported files reports no "no findings" from the line rules, and every file by name', () => {
    const report = checkStandards(commentsOnly(), input(unsupported.map(([file]) => added(file, ['x = 1']))));
    assert.deepEqual((report.notCheckedFiles ?? []).map((f) => f.file).sort(), unsupported.map(([file]) => file).sort());
    for (const rule of [CODE_RULE, PHRASE_RULE, 'comment-policy/density'] as const) {
      assert.equal(row(report, rule).result, 'not-checked', `${rule} read none of them`);
    }
  });

  it('an existing file of such a type with no added line is not listed: nothing in it was there to read', () => {
    const report = checkStandards(commentsOnly(), input([{ path: 'ci.yml', status: 'modified', addedLines: [], content: 'a: 1' }]));
    assert.deepEqual(report.notCheckedFiles, []);
  });

  it('plain data and prose stay out of the list, and a readable source file is not on it', () => {
    const report = checkStandards(commentsOnly(), input([
      added('package.json', ['{}']), added('README.md', ['# x']), added('notes.txt', ['x']), added('src/a.ts', ['export const a = 1;']),
    ]));
    assert.deepEqual(report.notCheckedFiles, []);
  });
});

describe('standards checker — renamed files', () => {
  const legacy = ['export const a = 1;', '// foo();', '// as an AI I cannot'];

  it('a pure rename judges the new path and nothing in the file', () => {
    const p = sampleProfile();
    const moved: StandardsCheckFile = { path: 'lib/usdFormat.ts', status: 'renamed', addedLines: [], content: legacy.join('\n') };
    p.naming.files = [{ globs: ['**/*.ts'], style: 'kebab-case' }];
    p.structure.placement = [{ id: 'ts', files: '**/*.ts', under: ['src'] }];
    const report = checkStandards(p, input([moved], { topLevel: ['src'] }));
    assert.deepEqual(report.findings.map((f) => `${f.file}:${f.line} ${f.rule}`), [
      'lib/usdFormat.ts:1 naming/files',
      'lib/usdFormat.ts:1 structure/placement',
      'lib/usdFormat.ts:1 structure/top-level',
    ]);
    // The legacy lines came along untouched: no line-based rule has anything to judge.
    for (const rule of [CODE_RULE, PHRASE_RULE, 'comment-policy/density'] as const) {
      assert.equal(row(report, rule).result, 'not-checked', rule);
      assert.match(row(report, rule).reason ?? '', /nothing for this rule to check/, rule);
    }
  });

  it('a rename with edits judges only the lines the edit added', () => {
    const edited: StandardsCheckFile = {
      path: 'src/usd-format.ts', status: 'renamed', addedLines: [4],
      content: [...legacy, '// bar();'].join('\n'),
    };
    const report = checkStandards(sampleProfile(), input([edited]));
    assert.deepEqual(lines(report, CODE_RULE), ['src/usd-format.ts:4']);
    assert.deepEqual(lines(report, PHRASE_RULE), []);
    assert.equal(row(report, 'naming/files').result, 'passed');
  });

  it('a modified file is still never judged on its path', () => {
    const report = checkStandards(sampleProfile(), input([{ path: 'src/usdFormat.ts', status: 'modified', addedLines: [1], content: 'export {};' }]));
    assert.deepEqual(lines(report, 'naming/files'), []);
  });
});

describe('standards checker — the committed version of a file the working tree no longer matches', () => {
  it('is judged like any file, and its findings say where they are', () => {
    const committed: StandardsCheckFile = {
      path: 'src/hidden.ts', status: 'added', addedLines: [1, 2], content: 'export const a = 1;\n// as an AI I cannot', origin: 'committed',
    };
    const report = checkStandards(promote(sampleProfile(), PHRASE_RULE), input([committed]));
    assert.deepEqual(lines(report, PHRASE_RULE), ['src/hidden.ts:2']);
    assert.match(report.findings[0].message, /in the committed version; the working tree no longer matches it/);
    assert.equal(standardsBlocked(report), true);
  });
});

describe('standards checker — generated and vendored files are exempt only where the repository says so', () => {
  const COMMENTED = '// const a = load();';
  const flagged = (file: string, body: string[], over: Partial<StandardsCheckInput> = {}): number[] =>
    checkStandards(commentsOnly(), input([added(file, body)], over)).findings.filter((f) => f.rule === CODE_RULE).map((f) => f.line);

  it('a generated marker inside a string literal exempts nothing', () => {
    assert.deepEqual(flagged('src/banner.ts', ['export const banner = "@generated";', COMMENTED]), [2]);
    assert.deepEqual(flagged('src/banner.go', ['package a', 'var s = "Code generated by hand. DO NOT EDIT."', COMMENTED]), [3]);
    assert.deepEqual(flagged('src/banner.py', ['MARK = "<auto-generated>"', '# value = compute(a, b)', '# return value']), [2, 3]);
  });

  it('the same marker in a comment still does', () => {
    assert.deepEqual(flagged('src/gen.ts', ['// @generated by codegen', COMMENTED]), []);
    assert.deepEqual(flagged('src/gen.go', ['// Code generated by protoc-gen-go. DO NOT EDIT.', 'package a', COMMENTED]), []);
  });

  it('in a file no lexer reads, the marker must open a comment line', () => {
    const p = commentsOnly();
    p.naming.files = [{ globs: ['**/*.rs'], style: 'snake_case' }];
    const named = (body: string[]): string[] => lines(checkStandards(p, input([added('src/BadName.rs', body)])), 'naming/files');
    assert.deepEqual(named(['// @generated', 'fn main() {}']), []);
    assert.deepEqual(named(['let s = "@generated";', 'fn main() {}']), ['src/BadName.rs:1']);
  });

  it('vendor/ and node_modules/ below the root are the project\'s own code unless the repository marks them', () => {
    assert.deepEqual(flagged('src/vendor/api.ts', ['export const a = 1;', COMMENTED]), [2]);
    assert.deepEqual(flagged('src/billing/vendor/api.ts', ['export const a = 1;', COMMENTED]), [2]);
    assert.deepEqual(flagged('app/node_modules/x/index.js', ['const a = 1;', COMMENTED]), [2]);
    assert.deepEqual(flagged('internal/third_party/x.go', ['package x', '', COMMENTED]), [3]);
  });

  it('a recognised root is left out: the repository root by name, a deeper one when a manifest sits beside it', () => {
    assert.deepEqual(flagged('vendor/acme/lib.go', ['package lib', '', COMMENTED]), []);
    assert.deepEqual(flagged('node_modules/x/index.js', ['const a = 1;', COMMENTED]), []);
    assert.deepEqual(flagged('packages/web/node_modules/x/index.js', ['const a = 1;', COMMENTED], { vendorRoots: ['packages/web/node_modules'] }), []);
    // The marked root exempts what is under it and nothing beside it.
    assert.deepEqual(flagged('packages/api/node_modules/x/index.js', ['const a = 1;', COMMENTED], { vendorRoots: ['packages/web/node_modules'] }), [2]);
  });

  it('a file NAMED vendor at the root is not a vendored directory', () => {
    assert.deepEqual(flagged('vendor', ['#!/bin/sh', 'echo hi']), []);
    const report = checkStandards(commentsOnly(), input([added('vendor.ts', ['export const a = 1;', COMMENTED])]));
    assert.deepEqual(lines(report, CODE_RULE), ['vendor.ts:2']);
  });
});

describe('standards checker — exemptions are matched where they apply, not anywhere in the comment', () => {
  const flagged = (file: string, body: string[]): number[] =>
    checkStandards(commentsOnly(), input([added(file, body)])).findings.filter((f) => f.rule === CODE_RULE).map((f) => f.line);

  it('a directive is one only at the start of the comment', () => {
    assert.deepEqual(flagged('src/a.ts', [
      'const a = 1;',
      '// eslint-disable-next-line no-console',
      '// @ts-expect-error legacy(args);',
      '// prettier-ignore',
      'const b = 2;',
    ]), []);
    assert.deepEqual(flagged('src/a.py', ['a = 1', 'b = compute(a)  # noqa: E501', '# type: ignore', '# pragma: no cover']), []);
    assert.deepEqual(flagged('src/a.go', ['package a', '', '//go:generate stringer -type=Kind', '//nolint:errcheck', 'var b = 2']), []);
  });

  it('a directive tacked on to disabled code does not hide the code', () => {
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// legacy.run(a); // eslint-disable-line', 'const b = 2;']), [2]);
    assert.deepEqual(flagged('src/a.py', ['a = 1', '# cache.get(key)  # noqa', 'b = 2']), [2]);
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// const pragma = load();', 'const b = 2;']), [2]);
    assert.deepEqual(flagged('src/a.go', ['package a', '', 'func f() {', '\t// cfg := load("go:embed")', '}']), [4]);
  });

  it('a URL does not exempt the code around it; a comment that is only a link is prose', () => {
    assert.deepEqual(flagged('src/a.ts', [
      'const a = 1;',
      '// See https://example.com/docs/setup(v2); for the details.',
      '// https://example.com/a(b);',
      'const b = 2;',
    ]), []);
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// fetch("https://example.com/api");', 'const b = 2;']), [2]);
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// const url = "http://localhost:3000";', 'const b = 2;']), [2]);
  });
});

describe('standards checker — Go documentation comments', () => {
  const report = (body: string[]): StandardsReport => {
    const p = commentsOnly();
    p.comments.minAddedLines = 4;
    return checkStandards(p, input([added('internal/store/store.go', body)]));
  };

  it('a godoc example indented under a doc comment is not commented-out code', () => {
    const r = report([
      'package store',
      '',
      '// Open returns a store for path.',
      '//',
      '// Usage:',
      '//',
      '//\ts, err := store.Open(path)',
      '//\tif err != nil {',
      '//\t\treturn err',
      '//\t}',
      '//\tdefer s.Close()',
      'func Open(path string) (*Store, error) {',
      '\treturn nil, nil',
      '}',
    ]);
    assert.deepEqual(lines(r, CODE_RULE), []);
    assert.equal(row(r, CODE_RULE).result, 'passed');
  });

  it('plain // lines above a declaration are documentation: they do not count against comment density', () => {
    const r = report([
      'package store',
      '',
      '// Store keeps values on disk.',
      '// It is safe for concurrent use.',
      '// The zero value is not usable.',
      'type Store struct {',
      '\t// Path is where the data lives.',
      '\tPath string',
      '}',
    ]);
    assert.deepEqual(lines(r, 'comment-policy/density'), []);
    assert.equal(row(r, 'comment-policy/density').result, 'passed');
  });

  it('the same lines inside a function body are ordinary comments and do count', () => {
    const r = report([
      'package store',
      '',
      'func run() {',
      '\t// first note',
      '\t// second note',
      '\t// third note',
      '\tx := 1',
      '\t_ = x',
      '}',
    ]);
    assert.deepEqual(lines(r, 'comment-policy/density'), ['internal/store/store.go:4']);
  });

  it('disabled statements parked above a declaration are still found', () => {
    const r = report(['package store', '', '// cfg := load()', '// return cfg', 'func Open() {}']);
    assert.deepEqual(lines(r, CODE_RULE), ['internal/store/store.go:3', 'internal/store/store.go:4']);
    assert.equal(row(r, CODE_RULE).severity, 'advisory');
  });
});

describe('standards checker — placeholder phrases', () => {
  const found = (file: string, body: string[]): number[] =>
    checkStandards(commentsOnly(), input([added(file, body)])).findings.filter((f) => f.rule === PHRASE_RULE).map((f) => f.line);

  it('finds the placeholder comments an agent leaves behind, in every spelling', () => {
    assert.deepEqual(found('src/a.ts', [
      'export function a() {',
      '  // rest of the code',
      '  // ... rest of the code ...',
      '  // ... existing code ...',
      '  // ...existing code...',
      '  /* … existing code … */',
      '  // Existing code here',
      '  // your code here',
      '  // TODO: Your Code Here!',
      '  // rest of the implementation',
      '  // code goes here',
      '}',
    ]), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(found('src/a.py', ['def a():', '    # ... existing code ...', '    # rest of the code remains unchanged', '    pass']), [2, 3]);
  });

  it('reports one finding per comment however many phrases match it', () => {
    assert.deepEqual(found('src/a.ts', ['const a = 1;', '// ... rest of the code goes here ...']), [2]);
  });

  it('leaves documentation that merely uses the words alone', () => {
    assert.deepEqual(found('src/a.ts', [
      'const a = 1;',
      '// Isolates the parser so the rest of the code in this package never sees raw tokens.',
      '// Wraps the existing code path without changing its behaviour.',
      '// The remaining code units are decoded lazily.',
      '/** Shared helpers used by the rest of the codebase. */',
      '// Same as before the migration: one row per user.',
      'export default a;',
    ]), []);
  });

  // Every sentence here was reported as a false positive against an earlier built-in list.
  it('never flags an ordinary sentence that shares words with a placeholder', () => {
    const PROSE = [
      'Mark the block as an AI-generated summary',
      'Label the message as an AI response',
      'Mark the message as an AI response so the UI can style it',
      'Tag the sender as an AI agent',
      'Registers Claude as an AI provider for the orchestrator.',
      'The existing code remains untouched by this refactor',
      'Scaffolded code goes here once the generator runs',
      'Same as before.',
      'Keeps compatibility with existing code...',
      'Careful... existing code paths rely on the old order.',
      'The generated code goes here: out/.',
      'Hook for plugins: put your code here if you need a custom step.',
    ];
    assert.deepEqual(found('src/a.ts', ['const a = 1;', ...PROSE.map((s) => `// ${s}`), 'export default a;']), []);
    // Each on its own, so no neighbour is what saves it; and as a trailing comment.
    for (const sentence of PROSE) {
      assert.deepEqual(found('src/a.ts', ['const a = 1;', '', `// ${sentence}`, '', 'export default a;']), [], sentence);
      assert.deepEqual(found('src/a.test.ts', [`const a = 1; // ${sentence}`]), [], sentence);
      assert.deepEqual(found('src/a.py', ['a = 1', `# ${sentence}`]), [], sentence);
    }
    assert.deepEqual(found('src/a.ts', [
      '/** Wraps the existing code here so callers need no change. */',
      'export function wrap() {}',
      '/**',
      ' * Existing code',
      ' * is wrapped rather than rewritten, so callers need no change.',
      ' */',
      'export function keep() {}',
      '/*',
      ' * Nothing is cached here; the',
      ' * rest of the code',
      ' * reads straight from disk.',
      ' */',
    ]), []);
    assert.deepEqual(found('cmd/app/main.go', [
      'package main',
      '',
      '// main is the entry point; implementation goes here once flags are parsed.',
      'func main() {}',
    ]), []);
  });

  it('a placeholder that is a whole block comment is still found, on the line that holds its words', () => {
    assert.deepEqual(found('src/a.ts', [
      'export function a() {',
      '  /* rest of the code */',
      '  /*',
      '   * ... existing code ...',
      '   */',
      '  /*',
      '   * rest of the code',
      '   */',
      '  /**',
      '   * Existing code',
      '   * (rest of the code remains unchanged)',
      '   */',
      '  // [your code here]',
      '  // As an AI language model, I cannot run this.',
      '  // As an AI, I have left this part out.',
      '}',
    ]), [2, 4, 7, 13]);
    // Lines 9-12 are ONE comment that says two things, so neither line is the whole of it;
    // lines 14-15 are assistant voice, which the defaults no longer list.
  });

  it('is advisory by default, blocks only once promoted, and never fires on a string literal', () => {
    const report = checkStandards(commentsOnly(), input([added('src/a.ts', ['const s = "your code here"; // a label'])]));
    assert.deepEqual(report.findings, []);
    assert.equal(row(report, PHRASE_RULE).severity, 'advisory');
    const placeholder = input([added('src/a.ts', ['export const a = 1;', '// rest of the code'])]);
    assert.equal(standardsBlocked(checkStandards(commentsOnly(), placeholder)), false);
    assert.equal(checkStandards(commentsOnly(), placeholder).totals.advisoryFindings, 1);
    assert.equal(standardsBlocked(checkStandards(promote(commentsOnly(), PHRASE_RULE), placeholder)), true);
  });

  it('a profile phrase written as a comment must be the whole comment', () => {
    const p = commentsOnly();
    p.comments.bannedPhrases = ['// placeholder', '# stub'];
    const hits = checkStandards(p, input([added('src/a.ts', [
      'const a = 1;', '// placeholder', '// ...Placeholder...', '// a placeholder for the real client', '// stub', 'const b = 2;',
    ])])).findings.map((f) => f.line);
    assert.deepEqual(hits, [2, 3, 5]);
  });
});

describe('standards checker — monorepo workspace imports', () => {
  const profile = (): StandardsProfile => {
    const p = commentsOnly();
    p.backend = {
      layers: [{ name: 'web', globs: ['packages/web/**'] }, { name: 'db', globs: ['packages/db/**'] }],
      forbiddenImports: [{ from: 'web', to: 'db' }],
      importAliases: [],
    };
    return p;
  };
  const web = (body: string[]): StandardsCheckFile => added('packages/web/src/page.ts', body);
  const packages = [{ name: '@acme/db', dir: 'packages/db' }, { name: '@acme/web', dir: 'packages/web' }, { name: 'shared-utils', dir: 'packages/utils' }];

  it('an import of another layer\'s workspace package is a layering finding', () => {
    const report = checkStandards(profile(), input([web([
      'import { query } from "@acme/db";',
      'import { pool } from "@acme/db/src/pool";',
      'import { helper } from "shared-utils";',
      'import React from "react";',
      'import { self } from "@acme/web/src/self";',
    ])], { workspacePackages: packages }));
    assert.deepEqual(lines(report, 'layering/imports'), ['packages/web/src/page.ts:1', 'packages/web/src/page.ts:2']);
    assert.equal(row(report, 'layering/imports').result, 'failed');
    assert.equal(row(report, 'layering/imports').severity, 'advisory', 'a scan of imports is advisory by default');
    assert.equal(standardsBlocked(report), false);
    const strict = checkStandards(promote(profile(), 'layering/imports'), input([web(['import { query } from "@acme/db";'])], { workspacePackages: packages }));
    assert.equal(standardsBlocked(strict), true, 'and blocks once a project promotes it');
  });

  it('with the workspace read and no forbidden import, the rule passes', () => {
    const report = checkStandards(profile(), input([web(['import { helper } from "shared-utils";', 'import React from "react";'])], { workspacePackages: packages }));
    assert.equal(row(report, 'layering/imports').result, 'passed');
  });

  it('a declared workspace that could not be read leaves bare imports not-checked, never passed', () => {
    const report = checkStandards(profile(), input([web(['import { query } from "@acme/db";', 'import fs from "node:fs";'])], { workspacePackages: null }));
    const r = row(report, 'layering/imports');
    assert.equal(r.result, 'not-checked');
    assert.equal(r.undecided, true);
    assert.match(r.reason ?? '', /Import @acme\/db cannot be mapped to a path/);
    assert.doesNotMatch(r.reason ?? '', /node:fs/);
  });

  it('a file outside every restricted layer is not held to the workspace', () => {
    const report = checkStandards(profile(), input([added('packages/db/src/pool.ts', ['import { page } from "@acme/web";'])], { workspacePackages: null }));
    assert.equal(row(report, 'layering/imports').result, 'passed');
  });
});

describe('standards checker — inline script and style in an HTML file are read, never waved through', () => {
  const staticWeb = (): StandardsProfile => JSON.parse(JSON.stringify(BUILT_IN_PROFILES['static-web'])) as StandardsProfile;
  // The phrase rule is promoted here: what is under test is that a BLOCKING rule reads these bodies.
  const check = (body: string[]): StandardsReport =>
    checkStandards(promote(staticWeb(), PHRASE_RULE), input([added('index.html', body)], { existingDirs: ['css', 'js'], topLevel: [] }));

  it('a placeholder comment inside <script> or <style> is found by the promoted phrase rule', () => {
    const report = check([
      '<!doctype html>',
      '<style>',
      '/* ... existing code ... */',
      'body { margin: 0; }',
      '</style>',
      '<script>',
      '// rest of the code',
      'function a() {}',
      '</script>',
      '<p>ok</p> <!-- ... rest of the code ... -->',
    ]);
    assert.deepEqual(lines(report, PHRASE_RULE), ['index.html:3', 'index.html:7', 'index.html:10']);
    assert.equal(row(report, PHRASE_RULE).result, 'failed');
    assert.equal(standardsBlocked(report), true);
  });

  it('a clean inline script has no findings, with its comments read', () => {
    const report = check(['<script>', '// Wires the form to the list.', 'function a() {}', '</script>']);
    assert.equal(row(report, PHRASE_RULE).result, 'passed');
    assert.equal(report.totals.blockingNotChecked, 0);
  });

  it('a script the lexer cannot read leaves the rule not-checked and undecided, never passed', () => {
    for (const body of [
      ['<script type="text/x-template">', '<!-- ... rest of the code ... -->', '</script>'],
      ['<script>', 'const s = "open', '// rest of the code', '</script>'],
    ]) {
      const r = row(check(body), PHRASE_RULE);
      assert.equal(r.result, 'not-checked', body[0]);
      assert.equal(r.undecided, true, body[0]);
      assert.match(r.reason ?? '', /index\.html/);
      assert.equal(check(body).totals.blockingNotChecked >= 1, true);
      assert.deepEqual(check(body).notCheckedFiles?.map((f) => f.file), ['index.html'], 'and the file is listed as not checked');
    }
  });
});

// One comment line, one directory name or one manifest — each written by the party being
// checked — used to switch every blocking line rule off for a file while the row said `passed`.
// The phrase rule is promoted in this block: it is the blocking rule under test.
describe('standards checker — an exemption the change wrote for itself is never a quiet pass', () => {
  const PLACEHOLDER = '// ... rest of the code ...';
  const clean = (): StandardsCheckFile => added('src/clean.ts', ['export const a = 1;', '// Adds one.']);
  const modified = (path: string, body: string[], addedLines: number[]): StandardsCheckFile =>
    ({ path, status: 'modified', addedLines, content: body.join('\n') });
  const strict = (): StandardsProfile => promote(commentsOnly(), PHRASE_RULE);
  const phrase = (files: StandardsCheckFile[], over: Partial<StandardsCheckInput> = {}) => {
    const report = checkStandards(strict(), input(files, over));
    return { report, r: row(report, PHRASE_RULE) };
  };

  it('a generated marker on an added file leaves the blocking rule not-checked and undecided, alone or beside a clean file', () => {
    for (const files of [
      [added('src/bad.ts', ['// @generated', PLACEHOLDER, 'export {};'])],
      [added('src/bad.ts', ['// @generated', PLACEHOLDER, 'export {};']), clean()],
      [added('src/bad.go', ['// Code generated by hand. DO NOT EDIT.', 'package a', PLACEHOLDER]), clean()],
    ]) {
      const { report, r } = phrase(files);
      assert.equal(r.result, 'not-checked', files[0].path);
      assert.equal(r.undecided, true);
      assert.match(r.reason ?? '', /Not checked: this change added it, or marked it, as generated \(src\/bad\.(?:ts|go)\)/);
      assert.equal(isUnreadBlocking(r), true);
      assert.equal(report.totals.blockingNotChecked, 1);
      assert.equal(standardsBlocked(report), false, 'a warning, not a failure: real generated code must not stop a release');
      assert.equal(standardsBlockingEvaluated(report), false, 'and the blocking set was not evaluated, so nothing is stamped');
    }
  });

  it('a file newly marked generated is a finding of its own, advisory, on the marker line — and is listed as not checked', () => {
    const marked = modified('src/legacy.ts', ['export const a = 1;', '// @generated', PLACEHOLDER], [2, 3]);
    const report = checkStandards(commentsOnly(), input([marked, added('src/new.pb.go', ['package a']), clean()]));
    const r = row(report, 'exemption/newly-generated');
    assert.equal(r.result, 'failed');
    assert.equal(r.severity, 'advisory');
    // The file that is generated by its NAME carries no marker anybody wrote: listed below, no finding.
    assert.deepEqual(lines(report, 'exemption/newly-generated'), ['src/legacy.ts:2']);
    assert.match(report.findings.find((f) => f.rule === 'exemption/newly-generated')!.message, /Newly marked generated in this change/);
    assert.equal(standardsBlocked(report), false);
    assert.deepEqual(report.notCheckedFiles, [
      { file: 'src/legacy.ts', reason: 'generated file, added or newly marked by this change' },
      { file: 'src/new.pb.go', reason: 'generated file, added or newly marked by this change' },
    ]);
    // The placeholder on line 3 was not read, and no rule says "no findings" on its account.
    assert.deepEqual(lines(report, PHRASE_RULE), []);
    assert.match(row(report, PHRASE_RULE).reason ?? '', /2 vendored or generated files not checked \(src\/legacy\.ts, src\/new\.pb\.go\)/);
    // A project may promote the rule like any other; then it stops the release.
    assert.equal(standardsBlocked(checkStandards(promote(commentsOnly(), 'exemption/newly-generated'), input([marked, clean()]))), true);
  });

  it('a file that was generated or vendored before the change is listed too, and is no finding', () => {
    const generated = modified('src/api/client.ts', ['// Code generated by openapi-gen. DO NOT EDIT.', 'export const a = 1;', 'export const b = 2;'], [3]);
    const vendored = modified('vendor/acme/lib.go', ['package lib', 'var a = 1'], [2]);
    const report = checkStandards(commentsOnly(), input([generated, vendored, clean()]));
    assert.equal(row(report, 'exemption/newly-generated').result, 'passed');
    assert.deepEqual(lines(report, 'exemption/newly-generated'), []);
    assert.deepEqual(report.notCheckedFiles, [
      { file: 'src/api/client.ts', reason: 'generated file' },
      { file: 'vendor/acme/lib.go', reason: 'vendored code' },
    ]);
    assert.equal(report.totals.notCheckedFiles, 2);
  });

  it('exempt files are never the evidence for "no findings": with nothing else in the diff every line rule is not-checked', () => {
    const vendored = modified('vendor/acme/lib.go', ['package lib', 'var a = 1'], [2]);
    const report = checkStandards(commentsOnly(), input([vendored, added('src/tool.rb', ['puts 1'])]));
    for (const rule of [CODE_RULE, PHRASE_RULE, 'comment-policy/density'] as const) {
      assert.equal(row(report, rule).result, 'not-checked', rule);
    }
    assert.deepEqual(report.notCheckedFiles, [
      { file: 'src/tool.rb', reason: 'No checker for .rb files' },
      { file: 'vendor/acme/lib.go', reason: 'vendored code' },
    ]);
    assert.equal(report.totals.noFindings, 4, 'the generated-marker, .env and credential scans, which did read the files, and the nested-repository scan');
    // A data file is out of scope for the line rules, not skipped by them: it is not listed.
    const data = checkStandards(commentsOnly(), input([added('package.json', ['{}']), clean()]));
    assert.deepEqual(data.notCheckedFiles, []);
  });

  it('a file the change adds under a vendor directory is the same, at the root or beside a manifest', () => {
    for (const [path, over] of [
      ['vendor/mine.ts', {}],
      ['node_modules/x/index.js', {}],
      ['third_party/x/y.ts', {}],
      ['src/vendor/mine.ts', { vendorRoots: ['src/vendor'] }],
    ] as Array<[string, Partial<StandardsCheckInput>]>) {
      const { report, r } = phrase([added(path, ['export const a = 1;', PLACEHOLDER]), clean()], over);
      assert.equal(r.result, 'not-checked', path);
      assert.equal(r.undecided, true, path);
      assert.match(r.reason ?? '', /this change added it as vendored code/);
      assert.equal(report.totals.blockingNotChecked, 1, path);
    }
  });

  it('a manifest the change adds does not quietly turn the project\'s own directory into a vendor root', () => {
    const legacy = modified('src/vendor/mine.ts', ['export const a = 1;', PLACEHOLDER], [2]);
    const manifest = added('src/go.mod', ['module example.com/x']);
    const { r } = phrase([legacy, manifest, clean()], { vendorRoots: ['src/vendor'] });
    assert.equal(r.result, 'not-checked');
    assert.equal(r.undecided, true);
    assert.match(r.reason ?? '', /src\/vendor\/mine\.ts/);
    // The same file under a root the repository already had is quietly exempt.
    const quiet = phrase([legacy, clean()], { vendorRoots: ['src/vendor'] });
    assert.equal(quiet.r.result, 'passed');
    assert.match(quiet.r.reason ?? '', /1 vendored or generated file not checked \(src\/vendor\/mine\.ts\)/);
    assert.equal(quiet.report.totals.blockingNotChecked, 0);
    assert.deepEqual(quiet.report.notCheckedFiles, [{ file: 'src/vendor/mine.ts', reason: 'vendored code' }], 'quiet for the rule, never invisible');
  });

  it('a file that was already generated or vendored at the base stays quietly exempt', () => {
    const generated = modified('src/api/client.ts', ['// Code generated by openapi-gen. DO NOT EDIT.', 'export const a = 1;', 'export const b = 2;'], [3]);
    const named = modified('internal/userpb/user.pb.go', ['package userpb', 'var a = 1'], [2]);
    const vendored = modified('vendor/acme/lib.go', ['package lib', 'var a = 1'], [2]);
    const { report, r } = phrase([generated, named, vendored, clean()]);
    assert.equal(r.result, 'passed');
    assert.equal(r.undecided, undefined);
    assert.match(r.reason ?? '', /3 vendored or generated files not checked/);
    assert.equal(report.totals.blockingNotChecked, 0);
    assert.equal(report.totals.notCheckedFiles, 3);
  });

  it('writing the marker onto an existing file is the change exempting it', () => {
    const marked = modified('src/legacy.ts', ['// @generated', 'export const a = 1;', PLACEHOLDER], [1, 3]);
    const { r } = phrase([marked, clean()]);
    assert.equal(r.result, 'not-checked');
    assert.equal(r.undecided, true);
  });

  it('layering is not waved through either: a marked Go file importing a forbidden layer is undecided', () => {
    const go = promote(JSON.parse(JSON.stringify(BUILT_IN_PROFILES.go)) as StandardsProfile, 'layering/imports');
    const report = checkStandards(go, input([
      added('internal/a/a.go', ['// Code generated by hand. DO NOT EDIT.', 'package a', 'import "example.com/app/cmd/x"']),
      added('internal/b/b.go', ['package b', 'import "fmt"']),
    ], { goModulePath: 'example.com/app', existingDirs: ['cmd', 'internal'], topLevel: ['cmd', 'internal'] }));
    const r = row(report, 'layering/imports');
    assert.equal(r.severity, 'blocking');
    assert.equal(r.result, 'not-checked');
    assert.equal(r.undecided, true);
    assert.match(r.reason ?? '', /internal\/a\/a\.go/);
  });

  it('an advisory rule only notes the file, and a real failure elsewhere still names what was left unread', () => {
    const report = checkStandards(strict(), input([
      added('src/gen.ts', ['// @generated', '// const a = load();']),
      added('src/bad.ts', ['export const a = 1;', PLACEHOLDER]),
    ]));
    const code = row(report, CODE_RULE);
    assert.equal(code.severity, 'advisory');
    assert.equal(code.result, 'passed');
    assert.match(code.reason ?? '', /1 vendored or generated file not checked \(src\/gen\.ts\)/);
    const r = row(report, PHRASE_RULE);
    assert.equal(r.result, 'failed');
    assert.match(r.reason ?? '', /Not checked: .*\(src\/gen\.ts\)/);
  });

  it('a project that promotes a heuristic gets the same treatment for it', () => {
    const p = commentsOnly();
    p.severity = { 'comment-policy/commented-out-code': 'blocking' };
    const r = row(checkStandards(p, input([added('src/gen.ts', ['// @generated', '// const a = load();']), clean()])), CODE_RULE);
    assert.equal(r.result, 'not-checked');
    assert.equal(r.undecided, true);
  });
});

// `@infra/db` looks like a published package. Where a tsconfig maps it into the repository
// it is the project's own code — and the layering rule used to pass on it unread. The rule
// is promoted here, so what a blocking layering rule does with an alias is pinned as well.
describe('standards checker — tsconfig path aliases', () => {
  const profile = (): StandardsProfile => {
    const p = promote(commentsOnly(), 'layering/imports');
    p.backend = {
      layers: [{ name: 'domain', globs: ['src/domain/**'] }, { name: 'infra', globs: ['src/infra/**'] }],
      forbiddenImports: [{ from: 'domain', to: 'infra' }],
      importAliases: [],
    };
    return p;
  };
  const order = (body: string[]): StandardsCheckFile => added('src/domain/order.ts', body);
  const IMPORTS = [
    'import { db } from "@infra/db";',
    'import { pool } from "@app/infra/pool";',
    'import { x } from "$lib/infra/x";',
    'import express from "express";',
    'import { Injectable } from "@nestjs/common";',
  ];
  const scopes = [{
    dir: '',
    aliases: [
      { pattern: '@infra/*', targets: ['src/infra/*'] },
      { pattern: '@app/*', targets: ['src/*'] },
      { pattern: '$lib/*', targets: ['src/*'] },
    ],
  }];
  const layering = (files: StandardsCheckFile[], over: Partial<StandardsCheckInput>) => {
    const report = checkStandards(profile(), input(files, over));
    return { report, r: row(report, 'layering/imports') };
  };

  it('an import mapped into a forbidden layer by paths is a finding, scoped or not; packages still pass', () => {
    const { report, r } = layering([order(IMPORTS)], { importPathScopes: scopes });
    assert.deepEqual(lines(report, 'layering/imports'), ['src/domain/order.ts:1', 'src/domain/order.ts:2', 'src/domain/order.ts:3']);
    assert.equal(r.result, 'failed');
    assert.equal(r.severity, 'blocking');
    assert.equal(standardsBlocked(report), true);
  });

  it('with the aliases read and none crossing a layer, the rule passes', () => {
    const { r } = layering([order(['import { money } from "@app/domain/money";', 'import express from "express";'])], { importPathScopes: scopes });
    assert.equal(r.result, 'passed');
  });

  it('a tsconfig that could not be read leaves every non-relative import not-checked, never passed', () => {
    const { report, r } = layering([order(['import { db } from "@infra/db";', 'import fs from "node:fs";', 'import { a } from "./a";'])],
      { importPathScopes: [{ dir: '', aliases: null }] });
    assert.equal(r.result, 'not-checked');
    assert.equal(r.undecided, true);
    assert.match(r.reason ?? '', /Import @infra\/db cannot be mapped to a path/);
    assert.doesNotMatch(r.reason ?? '', /node:fs|\.\/a/);
    assert.equal(report.totals.blockingNotChecked, 1);
    // A relative import into the forbidden layer is still a finding beside it.
    const mixed = layering([order(['import { db } from "@infra/db";', 'import { q } from "../infra/q";'])], { importPathScopes: [{ dir: '', aliases: null }] });
    assert.equal(mixed.r.result, 'failed');
  });

  it('$lib/x is never a package: without an alias for it the import is not-checked', () => {
    const { r } = layering([order(['import { x } from "$lib/infra/x";'])], {});
    assert.equal(r.result, 'not-checked');
    assert.equal(r.undecided, true);
    assert.match(r.reason ?? '', /Import \$lib\/infra\/x cannot be mapped/);
  });

  it('the longest matching pattern wins, as it does for the compiler', () => {
    const narrowed = [{ dir: '', aliases: [...scopes[0].aliases, { pattern: '@app/infra/*', targets: ['libs/shared/*'] }] }];
    const { report } = layering([order(['import { pool } from "@app/infra/pool";'])], { importPathScopes: narrowed });
    assert.deepEqual(lines(report, 'layering/imports'), []);
  });

  it('a baseUrl maps a bare path into the repository; a package of another name still passes', () => {
    const baseUrl = [{ dir: '', aliases: [{ pattern: '*', targets: ['src/*'] }] }];
    const { report } = layering([order(['import { db } from "infra/db";', 'import express from "express";'])], { importPathScopes: baseUrl });
    assert.deepEqual(lines(report, 'layering/imports'), ['src/domain/order.ts:1']);
    // An explicit alias is tried before the baseUrl.
    const both = [{ dir: '', aliases: [{ pattern: 'infra/*', targets: ['libs/other/*'] }, { pattern: '*', targets: ['src/*'] }] }];
    assert.deepEqual(lines(layering([order(['import { db } from "infra/db";'])], { importPathScopes: both }).report, 'layering/imports'), []);
  });

  it('a nested config applies below its own directory only', () => {
    const nested = [{ dir: 'packages/api', aliases: null }, { dir: 'src/domain', aliases: [{ pattern: '@infra/*', targets: ['src/infra/*'] }] }];
    assert.deepEqual(lines(layering([order(['import { db } from "@infra/db";'])], { importPathScopes: nested }).report, 'layering/imports'), ['src/domain/order.ts:1']);
    const elsewhere = [{ dir: 'packages/api', aliases: null }];
    assert.equal(layering([order(['import express from "express";'])], { importPathScopes: elsewhere }).r.result, 'passed');
  });

  it('a profile import alias still takes precedence over the tsconfig', () => {
    const p = profile();
    p.backend.importAliases = [{ prefix: '@infra/', path: 'libs/elsewhere/' }];
    const report = checkStandards(p, input([order(['import { db } from "@infra/db";'])], { importPathScopes: scopes }));
    assert.deepEqual(lines(report, 'layering/imports'), []);
  });
});
