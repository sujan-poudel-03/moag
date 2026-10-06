// ─── Web app: rule severity in the standards editor and in the run's standards report ───
//
// The web modules are plain browser ES modules with no build step, so their pure
// functions are lifted out of the source and run in a VM — the same way the worker
// protocol test checks `foldEvent`. Nothing here touches a DOM.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { BUILT_IN_PROFILES } from '../../../standards/built-in-profiles';
import {
  checkStandards, commandRow, recountTotals, ruleOutcomeLabel, standardsBlockingState, StandardsCheckInput, StandardsReport,
} from '../../../standards/checker';
import { DEFAULT_RULE_SEVERITY, STANDARDS_RULE_IDS, StandardsProfile, isScannerRule, validateProfile } from '../../../standards/profile';
import { promote, sampleProfile } from '../standards/fixtures';

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'web', 'js');

/** A web module with its imports removed and its exports made plain, run with `stubs` in scope. */
function loadWebModule(file: string, stubs: Record<string, unknown>, expose: string[]): Record<string, unknown> {
  const source = fs.readFileSync(path.join(WEB, file), 'utf-8')
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+(async\s+)?function\s/gm, '$1function ')
    .replace(/^export\s+const\s/gm, 'const ');
  const context: Record<string, unknown> = { ...stubs };
  vm.runInNewContext(`${source}\n${expose.map((name) => `this[${JSON.stringify(name)}] = ${name};`).join('\n')}`, context);
  return context;
}

const never = (): never => { throw new Error('a DOM helper was called by a pure function'); };
const DOM_STUBS = {
  h: never, mount: never, badge: never, glyph: never, toast: never, announce: never, confirmDialog: never, field: never,
  skeleton: never, errorCard: never, fmtAgo: never, fmtTime: never, fmtUsd: never, serverMessage: never,
  STR: new Proxy({}, { get: () => ({ text: '' }) }),
};

/** JSON round trip: a value made inside the VM compared as plain data. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('web standards editor — rule severity survives an edit and can be changed', () => {
  type Vals = { severity: Record<string, string> } & Record<string, unknown>;
  interface EditorModule {
    toForm: (profile: unknown) => Vals;
    fromForm: (vals: Vals, source: unknown) => { profile: StandardsProfile; errors: Record<string, string> };
    sectionRows: (profile: unknown, key: string) => Array<{ label: string; value: string }>;
    severityChangeLines: (version: unknown) => string[];
    promotedScannerRules: (profile: unknown) => string[];
  }
  const SCANNER_RULES = STANDARDS_RULE_IDS.filter((rule) => isScannerRule(rule));
  /**
   * The editor module with the server's severity table in place. `render()` sets that
   * module-level variable from the DTO; a `let` cannot be reached from outside a module, so
   * here it is initialised in the source before the module runs.
   */
  function editor(defaults: Record<string, string> = DEFAULT_RULE_SEVERITY): EditorModule {
    const raw = fs.readFileSync(path.join(WEB, 'screens', 'standards.js'), 'utf-8');
    assert.match(raw, /^let severityDefaults = \{\};$/m, 'the editor keeps the server\'s severity table in one module variable');
    assert.match(raw, /severityDefaults = first\.body\.standards\.severityDefaults \|\| \{\};/, 'and fills it from the DTO');
    assert.match(raw, /^let scannerRules = \[\];$/m, 'and the server\'s list of scanner rules in another');
    assert.match(raw, /scannerRules = list\(first\.body\.standards\.scannerRules\);/, 'filled from the DTO too');
    const source = raw
      .replace(/^import\s[^;]*;\s*$/gm, '')
      .replace(/^export\s+(async\s+)?function\s/gm, '$1function ')
      .replace(/^let severityDefaults = \{\};$/m, `let severityDefaults = ${JSON.stringify(defaults)};`)
      .replace(/^let scannerRules = \[\];$/m, `let scannerRules = ${JSON.stringify(SCANNER_RULES)};`);
    const context: Record<string, unknown> = { ...DOM_STUBS, Map };
    vm.runInNewContext(`${source}\nthis.toForm = toForm; this.fromForm = fromForm; this.sectionRows = sectionRows; this.severityChangeLines = severityChangeLines; this.promotedScannerRules = promotedScannerRules;`, context);
    return context as unknown as EditorModule;
  }

  it('an edit that touches no severity sends the profile back exactly as it was — built-in demotions included', () => {
    const ed = editor();
    for (const stack of ['node-ts', 'python', 'go', 'java', 'dotnet', 'static-web', 'other'] as const) {
      const source = BUILT_IN_PROFILES[stack];
      const built = ed.fromForm(ed.toForm(source), source);
      assert.deepEqual(plain(built.errors), {}, stack);
      assert.deepEqual(plain(built.profile), plain(source), stack);
      assert.ok(validateProfile(plain(built.profile)).ok, stack);
    }
    // A profile that says nothing about severity gets no severity key added.
    const bare = ed.fromForm(ed.toForm(sampleProfile()), sampleProfile());
    assert.equal('severity' in plain(bare.profile), false);
    assert.deepEqual(plain(bare.profile), sampleProfile());
  });

  it('the form shows the resolved severity of every rule', () => {
    const ed = editor();
    const vals = ed.toForm(BUILT_IN_PROFILES['node-ts']);
    assert.deepEqual(Object.keys(plain(vals.severity)).sort(), [...STANDARDS_RULE_IDS].sort());
    assert.equal(vals.severity['structure/required-dirs'], 'advisory');
    assert.equal(vals.severity['structure/nested-repository'], 'advisory');
    // Everything MOAG decides itself is advisory unless the profile promotes it.
    for (const rule of SCANNER_RULES) { assert.equal(vals.severity[rule], 'advisory', rule); }
  });

  it('promoting and demoting become overrides the server accepts; choosing the default again removes the override', () => {
    const ed = editor();
    const source = sampleProfile();
    const vals = ed.toForm(source);
    vals.severity['naming/files'] = 'blocking';
    vals.severity['structure/nested-repository'] = 'blocking';
    const changed = plain(ed.fromForm(vals, source).profile);
    assert.deepEqual(changed.severity, { 'structure/nested-repository': 'blocking', 'naming/files': 'blocking' });
    const checked = validateProfile(changed);
    assert.ok(checked.ok, JSON.stringify(checked));

    const back = ed.toForm(changed);
    back.severity['naming/files'] = 'advisory';
    back.severity['structure/nested-repository'] = 'advisory';
    assert.equal('severity' in plain(ed.fromForm(back, sampleProfile()).profile), false, 'no override is left for a default');
  });

  it('any rule made blocking is named for the warning, the structural ones included; an advisory rule is not', () => {
    const ed = editor();
    assert.deepEqual(plain(ed.promotedScannerRules(sampleProfile())), [], 'nothing is promoted by default');
    assert.deepEqual(plain(ed.promotedScannerRules(BUILT_IN_PROFILES['node-ts'])), []);
    const promoted = promote(sampleProfile(), 'layering/imports', 'comment-policy/banned-phrase', 'structure/required-dirs');
    assert.deepEqual(plain(ed.promotedScannerRules(promoted)), ['structure/required-dirs', 'layering/imports', 'comment-policy/banned-phrase'],
      'required directories are promotable like every other rule, with the same warning');
  });

  it('the editor warns, at the control, the moment a scanner rule is set to blocking — and the review card warns the reviewer', () => {
    const source = fs.readFileSync(path.join(WEB, 'screens', 'standards.js'), 'utf-8');
    // In the editor: an alert under the select, driven by the current choice.
    assert.match(source, /const promoted = vals\.severity\[rule\] === 'blocking' && isScannerRule\(rule\);/);
    assert.match(source, /warning\.textContent = promoted \? `⚠ \$\{STR\.C54\(rule\)\.text\}` : '';/);
    assert.match(source, /warning\.hidden = !promoted;/);
    assert.match(source, /h\('p', \{ class: 'text-warning', role: 'alert', hidden: true \}\)/);
    assert.match(source, /isScannerRule\(rule\) \? h\('span', \{ class: 'muted' \}, ' · heuristic scan'\) : null/);
    // On the version card: whoever reads the version sees it, not only whoever chose it.
    assert.match(source, /key === 'severity' \? promotionNote\(profile\) : null/);
    assert.match(source, /STR\.C52\(promoted\.map\(ruleLabel\)\.join\('; '\)\)\.text/);
    // The words themselves: heuristic, can block correct code, can miss violations.
    const strings = fs.readFileSync(path.join(WEB, 'strings.js'), 'utf-8');
    for (const id of ['C52', 'C54']) {
      const line = strings.split('\n').find((l) => l.trimStart().startsWith(`${id}:`)) ?? '';
      assert.match(line, /[Hh]euristic/, id);
      assert.match(line, /can stop correct code/, id);
      assert.match(line, /can miss real violations/, id);
    }
  });

  it('an override the source spells out is kept as written, even when it equals the default', () => {
    const ed = editor();
    const source = { ...sampleProfile(), severity: { 'naming/files': 'advisory' as const, 'layering/imports': 'advisory' as const } };
    assert.deepEqual(plain(ed.fromForm(ed.toForm(source), source).profile.severity), { 'layering/imports': 'advisory', 'naming/files': 'advisory' });
  });

  it('with no severity table from the server, the source\'s overrides pass through untouched', () => {
    const ed = editor({});
    const source = BUILT_IN_PROFILES.java;
    assert.deepEqual(plain(ed.fromForm(ed.toForm(source), source).profile), plain(source));
  });

  it('the read-only section lists every rule under Blocking or Advisory, by name and id', () => {
    const ed = editor();
    const rows = plain(ed.sectionRows(BUILT_IN_PROFILES['node-ts'], 'severity'));
    assert.deepEqual(rows.map((r) => r.label), ['Blocking', 'Advisory']);
    const all = rows.flatMap((r) => r.value.split('\n'));
    // Every rule once, plus the line that says commands always block.
    assert.equal(all.length, STANDARDS_RULE_IDS.length + 1);
    for (const rule of STANDARDS_RULE_IDS) { assert.ok(all.some((line) => line.endsWith(`(${rule})`)), rule); }
    assert.deepEqual(rows[0].value.split('\n'), ['Commands (always)'], 'what blocks under a built-in: commands, and nothing else');
    assert.match(rows[1].value, /No git repository nested inside the workspace \(structure\/nested-repository\)/);
    assert.match(rows[1].value, /Required directories exist \(structure\/required-dirs\)/);
    assert.match(rows[1].value, /No banned placeholder phrases \(comment-policy\/banned-phrase\)/);
    assert.match(rows[1].value, /Files sit where the placement rules say \(structure\/placement\)/);
    assert.match(rows[1].value, /No file newly marked as generated \(exemption\/newly-generated\)/);
  });

  it('the review card names each rule a version promotes or demotes, and shows nothing for a malformed entry', () => {
    const ed = editor();
    assert.deepEqual(plain(ed.severityChangeLines({
      severityChanged: [
        { rule: 'comment-policy/banned-phrase', from: 'blocking', to: 'advisory' },
        { rule: 'naming/files', from: 'advisory', to: 'blocking' },
      ],
    })), [
      'No banned placeholder phrases (comment-policy/banned-phrase): blocking → advisory',
      'File names follow the naming style (naming/files): advisory → blocking',
    ]);
    // A version from an older server (no list), an empty list, and entries that are not a known severity.
    assert.deepEqual(plain(ed.severityChangeLines({})), []);
    assert.deepEqual(plain(ed.severityChangeLines(null)), []);
    assert.deepEqual(plain(ed.severityChangeLines({ severityChanged: [] })), []);
    assert.deepEqual(plain(ed.severityChangeLines({ severityChanged: [null, { rule: 'naming/files', from: 'fatal', to: 'blocking' }, { rule: 'x' }] })), []);
  });

  it('enforcement changes are read from the server as before/after, shown un-collapsed, and must be ticked before a version can be put into effect', () => {
    const raw = fs.readFileSync(path.join(WEB, 'screens', 'standards.js'), 'utf-8');
    const source = raw
      .replace(/^import\s[^;]*;\s*$/gm, '')
      .replace(/^export\s+(async\s+)?function\s/gm, '$1function ')
      .replace(/^let severityDefaults = \{\};$/m, `let severityDefaults = ${JSON.stringify(DEFAULT_RULE_SEVERITY)};`);
    const context: Record<string, unknown> = { ...DOM_STUBS, Map };
    vm.runInNewContext(`${source}\nthis.enforcementChanges = enforcementChanges;`, context);
    const changes = (context as { enforcementChanges: (v: unknown) => { changed: boolean } & Record<string, unknown> }).enforcementChanges;

    assert.deepEqual(plain(changes({ enforcementChanged: {
      comparedTo: 2, changed: true, fields: ['commands', 'severity', 'requiredDirs', 'ruleConfig'],
      commands: {
        before: [{ label: 'Lint', run: 'npm run lint' }, { label: 'Test', run: 'npm test' }],
        after: [{ label: 'Test', run: 'npm test || true' }, null, { label: 'x' }, { label: '', run: 'y' }],
      },
      severity: [{ rule: 'naming/files', from: 'blocking', to: 'advisory' }, { rule: 'naming/files', from: 'fatal', to: 'blocking' }, null],
      requiredDirs: { before: ['src', 'test'], after: ['src', 7, ''] },
      ruleConfig: [{ rule: 'naming/files', before: [{ globs: ['src/**'], style: 'kebab-case' }], after: [] }, { before: 1 }],
    } })), {
      comparedTo: 2,
      commands: { before: ['Lint: npm run lint', 'Test: npm test'], after: ['Test: npm test || true'] },
      severity: ['File names follow the naming style (naming/files): blocking → advisory'],
      requiredDirs: { before: ['src', 'test'], after: ['src'] },
      ruleConfig: [{
        rule: 'naming/files',
        before: ['[', '  {', '    "globs": [', '      "src/**"', '    ],', '    "style": "kebab-case"', '  }', ']'],
        after: ['[]'],
      }],
      changed: true,
    });

    // One field alone is enough, and so is the server saying so with nothing this screen can read.
    assert.equal(changes({ enforcementChanged: { requiredDirs: { before: ['src'], after: [] } } }).changed, true);
    assert.equal(changes({ enforcementChanged: { commands: { before: [], after: [] } } }).changed, true, 'a field the server sent is a difference, even when nothing in it is readable');
    assert.equal(changes({ enforcementChanged: { changed: true } }).changed, true, 'asks for the acknowledgement rather than letting an approval go without');
    // A version from an older server, or one that changes nothing, asks for nothing.
    const none = { comparedTo: null, commands: null, severity: [], requiredDirs: null, ruleConfig: [], changed: false };
    for (const quiet of [null, undefined, {}, { enforcementChanged: null }, { enforcementChanged: { comparedTo: null, changed: false, commands: null, severity: [], requiredDirs: null } }]) {
      assert.deepEqual(plain(changes(quiet)), none, JSON.stringify(quiet));
    }

    // Shown at the top of the card, outside every collapsed before/after.
    assert.match(raw, /v\.status === 'pending' \|\| v\.inEffect \? enforcementNote\(v\) : null,\n\s+sectionsView\(v, baseRecord, state\.dto\.limits\),/);
    const note = raw.slice(raw.indexOf('function enforcementNote'), raw.indexOf('/** One read-only section of a version'));
    assert.ok(note.length > 0 && !note.includes('details'), 'never inside a <details>');
    assert.match(note, /STR\.C55\(set\.comparedTo\)\.text/);
    for (const field of ['set.commands', 'set.severity', 'set.requiredDirs', 'set.ruleConfig']) { assert.ok(note.includes(field), field); }
    assert.doesNotMatch(raw, /blockingSetChanged|rulesDisabled|rulesEnabled|commandChangeNote|ruleSwitchNote/, 'the reduced/extended view is gone');

    // The acknowledgement: a checkbox, the buttons disabled until it is ticked, and the hash sent only then.
    assert.match(raw, /const mustAcknowledge = enforcementChanges\(v\)\.changed;/);
    assert.match(raw, /h\('input', \{ type: 'checkbox', id: ackId \}\)/);
    assert.match(raw, /h\('label', \{ for: ackId \}, STR\.C57\(v\.version\)\.text\)/);
    assert.match(raw, /class: 'btn btn-primary', disabled: mustAcknowledge, on: \{ click: \(\) => \{ if \(acknowledged\(\)\) \{ void approve\(v, mustAcknowledge\); \} \} \} \}, 'Approve standards'\)/);
    assert.match(raw, /class: 'btn-link', disabled: mustAcknowledge, on: \{ click: \(\) => \{ if \(acknowledged\(\)\) \{ void acceptDefaults\(v, mustAcknowledge\); \} \} \} \}/);
    assert.match(raw, /approveBtn\.disabled = !ackBox\.checked;/);
    assert.match(raw, /\? \{ contentHash: v\.contentHash, acknowledgedEnforcementHash: v\.contentHash \} : \{ contentHash: v\.contentHash \}\);/);
    assert.match(raw, /r\.body\.error === 'acknowledgement-required'\) \{\n\s+toast\(STR\.C56\.text, 'error'\);/);
    const strings = fs.readFileSync(path.join(WEB, 'strings.js'), 'utf-8');
    for (const id of ['C55', 'C56', 'C57', 'C58', 'C59']) {
      assert.ok(strings.split('\n').some((l) => l.trimStart().startsWith(`${id}:`)), `${id} is defined`);
    }
    assert.doesNotMatch(strings, /tighten(?!s or loosens)|blocking-set|switches off by emptying/, 'no string claims to know whether a change tightens or loosens');
  });

  it('the editor offers the choice for every rule, says what it means, and maps a server error back to it', () => {
    const source = fs.readFileSync(path.join(WEB, 'screens', 'standards.js'), 'utf-8');
    assert.match(source, /h\('legend', null, 'What blocks a release'\)/);
    assert.match(source, /\['profile\.severity', 'severity'\]/);
    assert.match(source, /STR\.C47\.text/);
    assert.match(source, /STR\.C50\.text/);
    // The review card names what a version promotes or demotes, whatever it was proposed on top of.
    assert.match(source, /key === 'severity' \? severityChangeNote\(version\) : null/);
    assert.match(source, /STR\.C51\(lines\.length, version\.severityComparedTo \|\| null\)\.text/);
    for (const rule of STANDARDS_RULE_IDS) { assert.ok(source.includes(`'${rule}':`), `${rule} has a label`); }
  });
});

describe('web trace screen — what a checked release left open', () => {
  const trace = loadWebModule('screens/trace.js', { ...DOM_STUBS, uid: never, Map }, ['standardsOpen']) as { standardsOpen: (counts: unknown) => string };

  it('says the counts in words beside the standards version, and nothing when nothing was left open', () => {
    assert.equal(trace.standardsOpen({ advisoryFindings: 2, notCheckedRules: 1, notCheckedFiles: 7 }), '2 advisory findings · 1 rule not checked · 7 files not checked');
    assert.equal(trace.standardsOpen({ advisoryFindings: 1, notCheckedRules: 0, notCheckedFiles: 1 }), '1 advisory finding · 1 file not checked');
    assert.equal(trace.standardsOpen({ advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0 }), '');
    // A release whose standards had nothing that could stop it says so first — and never "passed".
    assert.equal(trace.standardsOpen({ advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true }), 'no blocking rules configured');
    assert.equal(trace.standardsOpen({ advisoryFindings: 3, notCheckedRules: 0, notCheckedFiles: 1, noBlockingRules: true }),
      'no blocking rules configured · 3 advisory findings · 1 file not checked');
    assert.equal(trace.standardsOpen({ advisoryFindings: 1, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: 'yes' }), '1 advisory finding', 'only the literal true counts');
    // A row from a release stamped before the counts existed, or a malformed one, says nothing rather than something wrong.
    for (const bad of [null, undefined, 'x', 7, {}, { advisoryFindings: '2' }, { advisoryFindings: -1, notCheckedRules: 1.5 }]) {
      assert.equal(trace.standardsOpen(bad), '', JSON.stringify(bad));
    }
  });

  it('the Gates cell tallies commands only: the moag:standards row is never counted as a pass', () => {
    const { gateSummary } = loadWebModule('screens/trace.js', { ...DOM_STUBS, uid: never, Map }, ['gateSummary']) as { gateSummary: (gates: unknown) => string };
    const std = (exitCode: number, standardsCounts?: unknown, command = 'moag:standards v2'): unknown => ({ command, exitCode, timedOut: false, standardsCounts });
    const cmd = (exitCode: number, command = 'npm test'): unknown => ({ command, exitCode, timedOut: false });
    const NONE = { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true };
    const SOME = { advisoryFindings: 1, notCheckedRules: 0, notCheckedFiles: 0 };

    // The greenfield dry-run trace exactly as the trace API sends it (command and exit code
    // only — `requirementStatuses` does not forward a gate's counts): it used to read "2/2 pass".
    assert.equal(gateSummary([{ command: 'moag:standards v2', exitCode: 0 }, { command: 'npm test', exitCode: 0 }]), '1/1 pass · standards: nothing blocking');
    // When a gate row does carry its counts, the row with no blocking set says so.
    assert.equal(gateSummary([std(0, NONE), cmd(0)]), '1/1 pass · standards: no blocking rules configured');
    // A profile made only of MOAG scans, and no other gate: no tally at all, and no "pass".
    assert.equal(gateSummary([std(0, NONE)]), 'standards: no blocking rules configured');
    assert.doesNotMatch(gateSummary([std(0, NONE)]), /pass/);
    assert.equal(gateSummary([std(0, SOME), cmd(0), cmd(1, 'npm run lint')]), '1/2 pass · standards: nothing blocking');
    assert.equal(gateSummary([std(0, undefined, 'moag:standards'), cmd(0)]), '1/1 pass · standards: nothing blocking', 'a row recorded without counts');
    // A standards row that stopped the release is said so, and still kept out of the tally.
    assert.equal(gateSummary([std(1), cmd(0)]), '1/1 pass · standards: stopped');
    assert.equal(gateSummary([std(1, NONE)]), 'standards: stopped');
    // Commands alone read as before; a command that merely mentions the name is a command.
    assert.equal(gateSummary([cmd(0), cmd(2, 'npm run lint')]), '1/2 pass');
    assert.equal(gateSummary([cmd(0, 'echo moag:standards v2 ok')]), '1/1 pass');
    for (const empty of [[], null, undefined]) { assert.equal(gateSummary(empty), '—'); }
    for (const gates of [[std(0, NONE), cmd(0)], [std(0, SOME)], [std(0)]]) {
      const tally = /(\d+)\/(\d+) pass/.exec(gateSummary(gates));
      assert.equal(tally ? Number(tally[2]) : 0, gates.length - 1, 'the standards row is in neither number');
    }
  });

  it('the table shows them only beside a standards version', () => {
    const source = fs.readFileSync(path.join(WEB, 'screens', 'trace.js'), 'utf-8');
    assert.ok(source.includes('row.standardsVersion && standardsOpen(row.standardsCounts)'));
  });
});

describe('web run screen — the standards report keeps Blocking, Advisory and Not checked apart', () => {
  interface ReportView {
    rules: Array<{ rule: string; result: string; severity?: string }>;
    findings: unknown[];
    notCheckedFiles: Array<{ file: string; reason: string }>;
    totals: {
      passed: number; noFindings: number; failed: number; advisory: number; notChecked: number; blockingNotChecked: number;
      findings: number; advisoryFindings: number; notCheckedFiles: number; noBlockingRules: boolean;
    };
  }
  const run = loadWebModule('screens/run.js', { ...DOM_STUBS, Set, Map }, ['asStandardsReport', 'ruleOutcome']) as {
    asStandardsReport: (data: unknown) => ReportView | null;
    ruleOutcome: (row: { rule: string; result: string; severity?: string }) => { label: string };
  };

  const input = (files: StandardsCheckInput['files']): StandardsCheckInput =>
    ({ baseRef: 'abc123', files, existingDirs: ['src', 'src/test'], topLevel: ['src'], goModulePath: null });

  it('counts a real report the way the server does: passes, scans with no findings, blocking, advisory, unread rules and files', () => {
    const p = promote(sampleProfile(), 'comment-policy/banned-phrase', 'layering/imports');
    p.backend.forbiddenImports = [{ from: 'ui', to: 'models' }];
    const report = checkStandards(p, input([
      { path: 'src/usdFormat.ts', status: 'added', addedLines: [1, 2, 3], content: 'export {};\n// foo();\n// as an AI I cannot' },
      { path: 'src/ui/broken.ts', status: 'added', addedLines: [1], content: 'const a = `open' },
    ]));
    report.rules.push(commandRow({ result: 'passed', command: 'npm run lint', exitCode: 0 }));
    report.totals = recountTotals(report);
    const view = plain(run.asStandardsReport(JSON.parse(JSON.stringify(report))))!;
    // The server's totals, plus the one thing the card derives for itself: whether a blocking set exists at all.
    assert.deepEqual(view.totals, { ...report.totals, noBlockingRules: false });
    assert.equal(standardsBlockingState(report), 'not-checked', 'and the server agrees with what the card will show');
    assert.ok(view.totals.failed >= 1 && view.totals.advisory >= 2 && view.totals.blockingNotChecked >= 1, JSON.stringify(view.totals));
    assert.equal(view.totals.passed, 1, 'the command alone — never a rule MOAG decides itself');
    assert.ok(view.totals.noFindings >= 1);
    assert.deepEqual(view.notCheckedFiles.map((f) => f.file), ['src/ui/broken.ts']);
    assert.equal(view.totals.notCheckedFiles, 1);
  });

  it('agrees with the server on the blocking set: not checked, none configured, or evaluated', () => {
    const clean = [{ path: 'src/usd-format.ts', status: 'added' as const, addedLines: [1], content: 'export {};' }];
    const cases: Array<[string, StandardsReport]> = [];
    const none = checkStandards(sampleProfile(), input(clean));
    cases.push(['no command, nothing promoted', none]);
    for (const result of ['passed', 'failed', 'not-checked'] as const) {
      const report = checkStandards(sampleProfile(), input(clean));
      report.rules.push(commandRow({ result, command: 'npm run lint', ...(result === 'not-checked' ? { reason: 'Commands were not run' } : { exitCode: result === 'passed' ? 0 : 1 }) }));
      report.totals = recountTotals(report);
      cases.push([`command ${result}`, report]);
    }
    cases.push(['a promoted rule that was decided', checkStandards(promote(sampleProfile(), 'frontend/raw-pattern'), input(clean))]);
    cases.push(['a promoted rule with nothing to judge', checkStandards(promote(sampleProfile(), 'structure/placement'), input([{ path: 'src/a.ts', status: 'modified', addedLines: [1], content: 'export {};' }]))]);
    cases.push(['a promoted rule the profile leaves unconfigured', checkStandards({ ...promote(sampleProfile(), 'naming/files'), naming: { files: [], notes: '' } }, input(clean))]);
    for (const [name, report] of cases) {
      const view = plain(run.asStandardsReport(JSON.parse(JSON.stringify(report))))!;
      const state = standardsBlockingState(report);
      assert.equal(view.totals.noBlockingRules, state === 'none-configured', name);
      assert.equal(view.totals.blockingNotChecked > 0, state === 'not-checked', name);
      assert.equal(view.totals.blockingNotChecked, report.totals.blockingNotChecked, name);
    }
    // The card says each of them in words, and stops the approver where the server will.
    const source = fs.readFileSync(path.join(WEB, 'screens', 'run.js'), 'utf-8');
    assert.match(source, /NO BLOCKING RULES CONFIGURED/);
    assert.match(source, /BLOCKING NOT CHECKED/);
    assert.match(source, /t\.noBlockingRules \? h\('p', \{ class: 'text-warning', role: 'note' \}, glyph\('⚠'\), ' ', STR\.C58\.text\) : null/);
    assert.match(source, /const standardsStop = !!preGate && \(preGate\.failed > 0 \|\| preGate\.blockingNotChecked > 0\);/);
    assert.match(source, /class: 'btn btn-primary', disabled: standardsStop, on: \{ click: approve \} \}, 'Approve and ship'\)/);
    assert.match(source, /r\.body\.error === 'standards-blocking'\) \{\n\s+toast\(STR\.C59\(/);
  });

  it('words every row as the server does: a scan has findings or no findings, and is never "Passed" or "Failed"', () => {
    for (const rule of [...STANDARDS_RULE_IDS, 'command'] as const) {
      for (const result of ['passed', 'failed', 'not-checked'] as const) {
        assert.equal(run.ruleOutcome({ rule, result }).label.toLowerCase(), ruleOutcomeLabel({ rule, result }), `${rule} ${result}`);
      }
    }
    assert.equal(run.ruleOutcome({ rule: 'naming/files', result: 'passed' }).label, 'No findings');
    assert.equal(run.ruleOutcome({ rule: 'naming/files', result: 'failed', severity: 'advisory' }).label, 'Findings');
    assert.equal(run.ruleOutcome({ rule: 'command', result: 'passed' }).label, 'Passed');
  });

  it('the listed files are kept, a claimed count below what is listed is not believed, and an old report has none', () => {
    const files = [{ file: 'a.rb', reason: 'No checker for .rb files' }, { file: 'vendor/x.go', reason: 'vendored code' }, { file: 7, reason: 'x' }];
    const view = plain(run.asStandardsReport({ rules: [], findings: [], notCheckedFiles: files, totals: { notCheckedFiles: 1 } }))!;
    assert.deepEqual(view.notCheckedFiles, files.slice(0, 2));
    assert.equal(view.totals.notCheckedFiles, 2);
    assert.equal(plain(run.asStandardsReport({ rules: [], findings: [], notCheckedFiles: files, totals: { notCheckedFiles: 40 } }))!.totals.notCheckedFiles, 40);
    const old = plain(run.asStandardsReport({ rules: [], findings: [] }))!;
    assert.deepEqual([old.notCheckedFiles, old.totals.notCheckedFiles], [[], 0]);
  });

  it('a report with no severities is all blocking, and a command is blocking whatever it claims', () => {
    const view = plain(run.asStandardsReport({
      rules: [
        { rule: 'naming/files', result: 'failed' },
        { rule: 'command', result: 'failed', severity: 'advisory', command: 'npm test' },
        { rule: 'comment-policy/density', result: 'failed', severity: 'advisory' },
        { rule: 'layering/imports', result: 'not-checked', undecided: true },
        { rule: 'structure/top-level', result: 'not-checked', severity: 'advisory', undecided: true },
        { rule: 'made-up', result: 'exploded' },
      ],
      findings: [],
      totals: { passed: 7, failed: 0, advisory: 9, notChecked: 2 },
    }))!;
    assert.equal(view.rules.length, 5, 'a row with an unknown result is dropped');
    assert.deepEqual([view.totals.failed, view.totals.advisory, view.totals.blockingNotChecked], [2, 1, 1],
      'counted from the rows, not taken from the totals the report claims');
  });

  it('rejects what is not a report', () => {
    for (const bad of [null, {}, { rules: [] }, { rules: 'x', findings: [] }]) { assert.equal(run.asStandardsReport(bad), null); }
  });

  it('the card renders the groups, the unread-blocking and promotion warnings, the finding lists and the files not checked', () => {
    const source = fs.readFileSync(path.join(WEB, 'screens', 'run.js'), 'utf-8');
    assert.match(source, /ruleTable\(`Blocking {2}\$\{/);
    assert.match(source, /ruleTable\(`Advisory {2}\$\{/);
    assert.match(source, /ruleTable\(`Rules not checked {2}\$\{/);
    assert.match(source, /findingList\('Blocking findings', blockingFindings, true\)/);
    assert.match(source, /findingList\('Advisory findings', advisoryFindings, false\)/);
    assert.match(source, /t\.blockingNotChecked > 0 \? h\('p', \{ class: 'text-warning', role: 'alert' \}/);
    assert.match(source, /Blocking rule, not checked/);
    assert.match(source, /promoted\.length > 0 \? h\('p', \{ class: 'text-warning' \}, glyph\('⚠'\), ' ', STR\.C52\(promoted\.join\(', '\)\)\.text\)/);
    assert.match(source, /`Files not checked {2}\$\{t\.notCheckedFiles\}`/);
    assert.match(source, /not checked \(\$\{f\.reason\}\)/);
    // The card as a whole is never badged "PASSED" or "FAILED": most of it is a scan.
    assert.match(source, /NOTHING BLOCKING/);
    assert.doesNotMatch(source, /✓ PASSED|BLOCKING FAILED|Standards check passed/);
    assert.doesNotMatch(source, /advisory failed|advisory rule\$\{[^}]*\} failed/);
  });
});
