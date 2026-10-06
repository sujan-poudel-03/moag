// ─── Local verification report — the standards section ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { StandardsCheckInput, StandardsReport, checkStandards, commandRow, recountTotals } from '../../../standards/checker';
import { GateRowInput, REPORT_COLOR, gateStatus, standardsReportSection, verificationGateRows } from '../../../ui/standards-report-html';
import { designSystemCssTokens } from '../../../ui/design-system';
import { isStandardsGateCommand, standardsGateCommand } from '../../../models/requirement-trace';
import { STANDARDS_RULE_IDS } from '../../../standards/profile';
import { promote, sampleProfile, totalsOf } from '../standards/fixtures';

function input(files: StandardsCheckInput['files']): StandardsCheckInput {
  return { baseRef: 'abc123', files, existingDirs: ['src', 'src/test'], topLevel: ['src'], goModulePath: null };
}

/** The text of `html` between two headings, tags removed. */
function between(html: string, from: string, to?: string): string {
  const start = html.indexOf(from);
  assert.ok(start >= 0, `"${from}" not found`);
  const end = to ? html.indexOf(to, start) : html.length;
  assert.ok(end > start, `"${to}" not found after "${from}"`);
  return html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

const BLOCKING = 'Blocking — a failure or a finding here stops a release';
const ADVISORY = 'Advisory — heuristic scans: reported, never blocking';
const RULES_NOT_CHECKED = 'Rules not checked — not a pass';
const FILES_NOT_CHECKED = 'Files not checked — nothing in them counts towards';

describe('verification report — standards section', () => {
  it('renders nothing for a run without standards', () => {
    assert.equal(standardsReportSection(null), '');
  });

  it('keeps Blocking, Advisory, rules not checked and files not checked in four groups, each finding in its own', () => {
    // The phrase and layering rules are promoted: the blocking group needs a scanner rule in it.
    const p = promote(sampleProfile(), 'comment-policy/banned-phrase', 'layering/imports');
    p.backend.forbiddenImports = [{ from: 'ui', to: 'models' }];
    const report = checkStandards(p, input([
      { path: 'src/usdFormat.ts', status: 'added', addedLines: [1, 2, 3], content: 'export {};\n// foo();\n// as an AI I cannot' },
      { path: 'src/ui/broken.ts', status: 'added', addedLines: [1], content: 'const a = `open' },
    ]));
    report.version = 4;
    report.rules.push(commandRow({ result: 'failed', command: 'npm run lint', exitCode: 2 }));
    report.totals = recountTotals(report);
    const html = standardsReportSection(report);

    assert.match(html, /<h2>Project standards v4<\/h2>/);
    const blocking = between(html, BLOCKING, ADVISORY);
    const advisory = between(html, ADVISORY, RULES_NOT_CHECKED);
    const notChecked = between(html, RULES_NOT_CHECKED, FILES_NOT_CHECKED);
    const files = between(html, FILES_NOT_CHECKED);

    assert.match(blocking, /\(2 stopping\)/);
    // A promoted scanner rule has "findings"; only the command "failed".
    assert.match(blocking, /comment-policy\/banned-phrase ✗ findings/);
    assert.match(blocking, /command: npm run lint ✗ failed \(exit 2\)/);
    assert.doesNotMatch(blocking, /structure\/required-dirs/, 'advisory by default: not in the blocking group');
    assert.match(advisory, /structure\/required-dirs – no findings/);
    assert.match(blocking, /src\/usdFormat\.ts:3 comment-policy\/banned-phrase — Banned phrase/);
    assert.doesNotMatch(blocking, /commented-out-code — Commented-out code/, 'no advisory finding among the blocking ones');

    assert.match(advisory, /naming\/files ✗ findings/);
    assert.match(advisory, /src\/usdFormat\.ts:2 comment-policy\/commented-out-code — Commented-out code/);
    assert.doesNotMatch(advisory, /banned-phrase — Banned phrase/);

    assert.match(notChecked, /Blocking rule, not checked: layering\/imports — .*unterminated template string/);
    assert.match(files, /\(1\)/);
    assert.match(files, /src\/ui\/broken\.ts — not checked \(Could not lex the file: unterminated template string/);
    assert.match(html, /1 blocking rule or command was not checked\.<\/strong> That is not a pass/);
    assert.doesNotMatch(html, /No blocking rules configured/, 'this profile has a blocking set');
    assert.match(html, /Promoted to blocking: layering\/imports, comment-policy\/banned-phrase\.<\/strong> Scanner rules are heuristic/);
    assert.match(html, /\d+ passed · \d+ no findings · 2 blocking · 2 advisory with findings \(2 findings\) · \d+ rules? not checked · 1 file not checked · 3 findings/);
  });

  it('no rule MOAG decides itself is ever said to have passed or failed', () => {
    const report = checkStandards(sampleProfile(), input([
      { path: 'src/usdFormat.ts', status: 'added', addedLines: [1, 2], content: 'export {};\n// foo();' },
      { path: 'src/usd-format.ts', status: 'added', addedLines: [1], content: 'export {};' },
    ]));
    report.rules.push(commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0 }));
    report.totals = recountTotals(report);
    const text = standardsReportSection(report).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const rule of STANDARDS_RULE_IDS) {
      assert.doesNotMatch(text, new RegExp(`${rule.replace('/', '\\/')} [✓✗] (?:passed|failed)`), rule);
    }
    assert.match(text, /structure\/placement – no findings/);
    assert.match(text, /naming\/files ✗ findings/);
    // The words "passed" and "failed" are kept for the command alone.
    assert.match(text, /command: npm run lint ✓ passed \(exit 0\)/);
    assert.match(text, /structure\/required-dirs – no findings/);
    assert.match(text, /structure\/nested-repository – no findings/);
    assert.match(text, /1 passed · \d+ no findings · 0 blocking/);
  });

  it('a clean report says so without inventing a warning', () => {
    const report = checkStandards(sampleProfile(), input([{ path: 'src/usd-format.ts', status: 'added', addedLines: [1], content: 'export {};' }]));
    const html = standardsReportSection(report);
    assert.match(html, /<h2>Project standards<\/h2>/, 'no version, no "vnull"');
    assert.match(html, /\(0 stopping\)/);
    assert.match(html, /\(0 with findings\)/);
    assert.match(html, /Every changed source file was read\./);
    assert.doesNotMatch(html, /was not checked\.<\/strong>/);
    assert.doesNotMatch(html, /Promoted to blocking/);
    assert.doesNotMatch(html, /✗/);
  });

  it('a profile with no command and no promoted rule says "no blocking rules configured", never that anything passed', () => {
    const clean = { path: 'src/usd-format.ts', status: 'added' as const, addedLines: [1], content: 'export {};' };
    const none = standardsReportSection(checkStandards(sampleProfile(), input([clean])));
    assert.match(none, /<strong>No blocking rules configured\.<\/strong> MOAG blocks on your project&#39;s own tools|<strong>No blocking rules configured\.<\/strong> MOAG blocks on your project's own tools/);
    assert.match(none, /0 passed · /);
    assert.doesNotMatch(none, /<span>passed<\/span>/, 'no row is called passed: no command ran');

    // Once a command ran, there is a blocking set and the note is gone.
    const report = checkStandards(sampleProfile(), input([clean]));
    report.rules.push(commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0 }));
    report.totals = recountTotals(report);
    const some = standardsReportSection(report);
    assert.doesNotMatch(some, /No blocking rules configured/);
    assert.match(some, /1 passed · /);

    // A command that did not run is the other warning: not checked, not a pass.
    const skipped = checkStandards(sampleProfile(), input([clean]));
    skipped.rules.push(commandRow({ result: 'not-checked', command: 'npm run lint', reason: 'Commands were not run' }));
    skipped.totals = recountTotals(skipped);
    const open = standardsReportSection(skipped);
    assert.match(open, /1 blocking rule or command was not checked\./);
    assert.match(open, /<strong>Blocking rule, not checked:<\/strong> <code>command: npm run lint<\/code>/);
    assert.doesNotMatch(open, /No blocking rules configured/);
  });

  it('lists every file that was not checked with its reason, and the true count when the list was capped', () => {
    const report = checkStandards(sampleProfile(), input([
      { path: 'vendor/acme/lib.go', status: 'modified', addedLines: [2], content: 'package lib\nvar a = 1' },
      { path: 'src/tool.rb', status: 'added', addedLines: [1], content: 'puts 1' },
      { path: 'src/gen.ts', status: 'added', addedLines: [1, 2], content: '// @generated\nexport {};' },
    ]));
    const files = between(standardsReportSection(report), FILES_NOT_CHECKED);
    assert.match(files, /\(3\)/);
    assert.match(files, /src\/gen\.ts — not checked \(generated file, added or newly marked by this change\)/);
    assert.match(files, /src\/tool\.rb — not checked \(No checker for \.rb files\)/);
    assert.match(files, /vendor\/acme\/lib\.go — not checked \(vendored code\)/);

    const capped: StandardsReport = { ...report, notCheckedFiles: report.notCheckedFiles!.slice(0, 1), totals: { ...report.totals, notCheckedFiles: 240 } };
    const text = between(standardsReportSection(capped), FILES_NOT_CHECKED);
    assert.match(text, /\(240\)/);
    assert.match(text, /…and 239 more/);
  });

  it('escapes everything that came from the repository', () => {
    const report: StandardsReport = {
      version: 1, baseRef: 'abc',
      rules: [
        { rule: 'comment-policy/banned-phrase', severity: 'blocking', result: 'failed', reason: 'Left out <b>x</b>' },
        commandRow({ result: 'failed', command: 'npm run "lint" && <script>alert(1)</script>', exitCode: 1 }),
        { rule: 'layering/imports', severity: 'blocking', result: 'not-checked', undecided: true, reason: 'bad <img src=x onerror=alert(1)> (a&b.ts)' },
      ],
      findings: [{ file: 'src/<img>.ts', line: 1, rule: 'comment-policy/banned-phrase', message: '"quoted" & <i>tagged</i>', severity: 'blocking' }],
      notCheckedFiles: [{ file: 'src/<svg onload=x>.rb', reason: 'No checker for <u>.rb</u> files' }],
      totals: totalsOf({ failed: 2, notChecked: 1, blockingNotChecked: 1, findings: 1, notCheckedFiles: 1 }),
    };
    const html = standardsReportSection(report);
    assert.doesNotMatch(html, /<script>|<img|<i>|<b>x|<svg|<u>/);
    assert.match(html, /src\/&lt;img&gt;\.ts:1/);
    assert.match(html, /&quot;quoted&quot; &amp; &lt;i&gt;tagged&lt;\/i&gt;/);
    assert.match(html, /npm run &quot;lint&quot; &amp;&amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /bad &lt;img src=x onerror=alert\(1\)&gt; \(a&amp;b\.ts\)/);
    assert.match(html, /src\/&lt;svg onload=x&gt;\.rb<\/code> — not checked \(No checker for &lt;u&gt;\.rb&lt;\/u&gt; files\)/);
  });

  it('caps the findings it spells out and says how many more there are', () => {
    const lines = ['export {};', ...Array.from({ length: 150 }, () => '// as an AI I cannot')];
    // Promoted, so the phrase findings are a group of their own (the density finding stays advisory).
    const report = checkStandards(promote(sampleProfile(), 'comment-policy/banned-phrase'), input([
      { path: 'src/big.ts', status: 'added', addedLines: lines.map((_, i) => i + 1), content: lines.join('\n') },
    ]));
    const html = standardsReportSection(report);
    assert.equal(html.split('comment-policy/banned-phrase — Banned phrase').length - 1, 100);
    assert.match(html, /…and 50 more/);
  });
});

describe('verification report — a scanner row is never marked as a pass', () => {
  it('a scan with no findings carries a neutral mark and class; only a command that exited 0 carries the tick', () => {
    const report = checkStandards(sampleProfile(), input([{ path: 'src/usd-format.ts', status: 'added', addedLines: [1], content: 'export {};' }]));
    const scansOnly = standardsReportSection(report);
    assert.match(scansOnly, /<span class="criterion neutral"><span class="icon">–<\/span><span>no findings<\/span>/);
    assert.doesNotMatch(scansOnly, /✓/, 'no tick anywhere: nothing here is a command');
    assert.doesNotMatch(scansOnly, /class="criterion pass"/);

    report.rules.push(commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0 }));
    report.totals = recountTotals(report);
    const html = standardsReportSection(report);
    assert.equal(html.split('✓').length - 1, 1, 'exactly one tick: the command');
    assert.equal(html.split('class="criterion pass"').length - 1, 1);
    assert.match(html, /<code>command: npm run lint<\/code><\/td>\s*<td><span class="criterion pass"><span class="icon">✓<\/span><span>passed \(exit 0\)<\/span>/);
    // Every scanner row, one by one: its result cell has neither the class nor the tick.
    for (const row of html.split('<tr>').filter((r) => STANDARDS_RULE_IDS.some((id) => r.includes(`<code>${id}</code>`)))) {
      assert.doesNotMatch(row, /criterion pass|✓/, row);
    }
  });
});

describe('verification report — the gates table never calls the standards row a pass', () => {
  const gate = (over: Partial<GateRowInput>): GateRowInput =>
    ({ command: 'npm test', exitCode: 0, passed: true, output: 'ok', durationMs: 12, timedOut: false, ...over });
  const NONE = { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true as const };
  const SOME = { advisoryFindings: 2, notCheckedRules: 0, notCheckedFiles: 0 };
  /** The row of `html` for `command`, tags kept. */
  const rowOf = (html: string, command: string): string => {
    const row = html.split('<tr>').find((r) => r.includes(`<code>${command}</code>`));
    assert.ok(row, `no row for ${command}`);
    return row;
  };

  it('words the row from its counts: "no blocking rules configured" or "nothing blocking", neutral, with no exit code', () => {
    const html = verificationGateRows([
      gate({ command: standardsGateCommand(1), output: 'Project standards: no blocking rules configured (0 findings)', standardsCounts: NONE }),
      gate({}),
    ]);
    const standards = rowOf(html, 'moag:standards v1');
    assert.match(standards, /<td>no blocking rules configured<\/td>\s*<td>—<\/td>/);
    assert.doesNotMatch(standards, />pass</);
    assert.doesNotMatch(standards, /✓|#28a745|--ds-success/, 'no green, no tick');
    // The real command beside it is still a pass, in green, with its exit code.
    assert.ok(rowOf(html, 'npm test').includes(`<td style="color:${REPORT_COLOR.pass}">pass</td>`));
    assert.match(rowOf(html, 'npm test'), />pass<\/td>\s*<td>0<\/td>/);

    for (const command of [standardsGateCommand(7), standardsGateCommand(null)]) {
      const evaluated = rowOf(verificationGateRows([gate({ command, standardsCounts: SOME })]), command);
      assert.match(evaluated, /<td>nothing blocking<\/td>/);
      assert.doesNotMatch(evaluated, />pass<|#28a745|--ds-success/);
      // A row recorded without counts is worded the same way, never upgraded to a pass.
      assert.match(rowOf(verificationGateRows([gate({ command })]), command), /<td>nothing blocking<\/td>/);
    }
  });

  it('gateStatus: a standards row that stopped the release says "stopped", in the failing tone; commands keep pass / fail / timeout', () => {
    assert.deepEqual(gateStatus(gate({ command: 'moag:standards v3', standardsCounts: NONE })), { word: 'no blocking rules configured', tone: 'neutral' });
    assert.deepEqual(gateStatus(gate({ command: 'moag:standards v3', standardsCounts: SOME })), { word: 'nothing blocking', tone: 'neutral' });
    assert.deepEqual(gateStatus(gate({ command: 'moag:standards v3', exitCode: 1, passed: false })), { word: 'stopped', tone: 'fail' });
    // Its counts do not soften it, and it is never "timeout": the row is not a process.
    assert.deepEqual(gateStatus(gate({ command: 'moag:standards v3', exitCode: 1, passed: false, standardsCounts: NONE })), { word: 'stopped', tone: 'fail' });
    assert.deepEqual(gateStatus(gate({ command: 'moag:standards', exitCode: 1, passed: false, timedOut: true })), { word: 'stopped', tone: 'fail' });
    assert.deepEqual(gateStatus(gate({})), { word: 'pass', tone: 'pass' });
    assert.deepEqual(gateStatus(gate({ exitCode: 1, passed: false })), { word: 'fail', tone: 'fail' });
    assert.deepEqual(gateStatus(gate({ exitCode: 124, passed: false, timedOut: true })), { word: 'timeout', tone: 'fail' });
    // Only the exact synthetic name is special: a real command that merely mentions it is a command.
    assert.deepEqual(gateStatus(gate({ command: 'moag:standards v3 && npm test' })), { word: 'pass', tone: 'pass' });
    assert.deepEqual(gateStatus(gate({ command: 'echo moag:standards' })), { word: 'pass', tone: 'pass' });
    assert.equal(isStandardsGateCommand('moag:standards v12'), true);
    assert.equal(isStandardsGateCommand('moag:standards'), true);
    assert.equal(isStandardsGateCommand('moag:standardsx'), false);
  });

  it('a failing or timed-out gate is red, and everything from the repository is escaped', () => {
    const html = verificationGateRows([
      gate({ command: 'npm run "lint" && <script>x</script>', exitCode: 2, passed: false, output: 'first\n<img src=x onerror=1>\n\n' }),
      gate({ command: 'npm run slow', exitCode: 124, passed: false, timedOut: true, output: '' }),
    ]);
    assert.doesNotMatch(html, /<script>|<img/);
    assert.match(html, /npm run &quot;lint&quot; &amp;&amp; &lt;script&gt;x&lt;\/script&gt;/);
    assert.ok(html.includes(`<td style="color:${REPORT_COLOR.fail}">fail</td>`));
    assert.match(html, />fail<\/td>\s*<td>2<\/td>/);
    assert.match(html, /&lt;img src=x onerror=1&gt;/, 'the last non-empty output line');
    assert.ok(rowOf(html, 'npm run slow').includes(`<td style="color:${REPORT_COLOR.fail}">timeout</td>`));
    assert.match(rowOf(html, 'npm run slow'), />timeout<\/td>[\s\S]*<td style="[^"]*">—<\/td>/);
    assert.equal(verificationGateRows([]), '');
  });

  it('a standards row that stopped the release is red and says "stopped", with no exit code', () => {
    const html = verificationGateRows([gate({ command: 'moag:standards v3', exitCode: 1, passed: false, output: 'Project standards stop this release' })]);
    const row = rowOf(html, 'moag:standards v3');
    assert.ok(row.includes(`<td style="color:${REPORT_COLOR.fail}">stopped</td>`), row);
    assert.match(row, />stopped<\/td>\s*<td>—<\/td>/);
    assert.doesNotMatch(row, />fail</);
  });

  it('every colour is a design-system token with the standalone report colour as its documented fallback', () => {
    const tokens = designSystemCssTokens();
    for (const [name, value] of Object.entries(REPORT_COLOR)) {
      const m = /^var\((--ds-[a-z-]+), (#[0-9a-f]{3,6})\)$/.exec(value);
      assert.ok(m, `${name}: ${value} is var(--ds-token, #fallback)`);
      assert.ok(tokens.includes(`${m[1]}:`), `${m[1]} is a token the design system defines`);
    }
    // The fallbacks are the colours the standalone browser report has always had.
    assert.deepEqual(REPORT_COLOR, { pass: 'var(--ds-success, #28a745)', fail: 'var(--ds-error, #dc3545)', muted: 'var(--ds-muted, #999)' });
    // Outside that one table the module holds no raw colour, and the markup it writes uses the table.
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'ui', 'standards-report-html.ts'), 'utf-8');
    const [, afterTable] = source.split('} as const;');
    assert.ok(afterTable && afterTable.length > 1000, 'the colour table is closed before the markup');
    assert.doesNotMatch(afterTable, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no raw colour after the table');
    assert.match(source, /In the standalone report[\s\S]*no `--ds-\*` token exists/i, 'the fallback is documented where it is defined');
    const html = verificationGateRows([gate({}), gate({ command: 'npm run lint', exitCode: 2, passed: false })]);
    for (const colour of html.match(/color:[^";]+/g) ?? []) {
      assert.match(colour, /^color:var\(--ds-(success|error|muted), #[0-9a-f]{3,6}\)$/, colour);
    }
    assert.equal((html.match(/color:/g) ?? []).length, 4, 'two status cells and two output cells');
  });

  it('the report is built through it: extension.ts has no gate-status wording of its own', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'extension.ts'), 'utf-8');
    assert.ok(source.includes('const gateRows = verificationGateRows(report.gates);'));
    assert.doesNotMatch(source, /gate\.passed \? 'pass'/);
  });
});
