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
import { STANDARDS_GATE_COMMAND, isStandardsGateCommand, standardsGateCommand, standardsGateWord } from '../../../models/requirement-trace';
import { gateStatus } from '../../../ui/standards-report-html';

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

    // A standards row with a command and an exit code and nothing else — what the trace API
    // sent before it forwarded the row's counts: it used to read "2/2 pass".
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

  it('a gates list with a null or non-object element does not break the cell: the entry is left out', () => {
    const { gateSummary } = loadWebModule('screens/trace.js', { ...DOM_STUBS, uid: never, Map }, ['gateSummary']) as { gateSummary: (gates: unknown) => string };
    const cmd = { command: 'npm test', exitCode: 0, timedOut: false };
    const std = { command: 'moag:standards v2', exitCode: 0, timedOut: false, standardsCounts: { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true } };
    assert.doesNotThrow(() => gateSummary([null]));
    assert.equal(gateSummary([null, cmd]), '1/1 pass');
    assert.equal(gateSummary([cmd, null, std, undefined, 'npm test', 7]), '1/1 pass · standards: no blocking rules configured');
    assert.equal(gateSummary([null, undefined]), '—', 'nothing left to show');
    assert.equal(gateSummary(['x', 3, true]), '—');
    // A row that is an object but malformed is still a row: it is counted, and not as a pass.
    assert.equal(gateSummary([{}, cmd]), '1/2 pass');
    assert.equal(gateSummary([{ command: 'moag:standards v2', exitCode: 0, standardsCounts: null }]), 'standards: nothing blocking');
    assert.equal(gateSummary([{ command: 'moag:standards v2', exitCode: 0, standardsCounts: 'x' }]), 'standards: nothing blocking');
  });

  it('the name of the standards row is one pattern: the web copy is the server one, source and behaviour', () => {
    const web = loadWebModule('screens/trace.js', { ...DOM_STUBS, uid: never, Map }, ['STANDARDS_GATE_COMMAND']) as { STANDARDS_GATE_COMMAND: RegExp };
    assert.equal(web.STANDARDS_GATE_COMMAND.source, STANDARDS_GATE_COMMAND.source);
    assert.equal(web.STANDARDS_GATE_COMMAND.flags, STANDARDS_GATE_COMMAND.flags);
    const names = [
      standardsGateCommand(null), standardsGateCommand(1), standardsGateCommand(42), 'moag:standards v', 'moag:standards v1.2', 'moag:standardsx',
      'moag:standards v3 && npm test', 'echo moag:standards', ' moag:standards', 'moag:standards v1 ', 'MOAG:STANDARDS', 'npm test', '',
    ];
    for (const name of names) {
      assert.equal(web.STANDARDS_GATE_COMMAND.test(name), isStandardsGateCommand(name), JSON.stringify(name));
    }
    // And there is one copy on the web side: no second pattern literal anywhere under web/js.
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
    const literal = 'moag:standards(?:';
    const holders = walk(WEB).filter((file) => fs.readFileSync(file, 'utf-8').includes(literal));
    assert.deepEqual(holders.map((f) => path.relative(WEB, f).split(path.sep).join('/')), ['screens/trace.js']);
    assert.equal(fs.readFileSync(path.join(WEB, 'screens', 'trace.js'), 'utf-8').split(literal).length - 1, 1, 'written once in that file');
  });

  it('one word for the standards row on every surface: the hosted trace, the trace API and the VS Code gate table agree', () => {
    const web = loadWebModule('screens/trace.js', { ...DOM_STUBS, uid: never, Map }, ['standardsGateWord', 'gateSummary']) as {
      standardsGateWord: (gate: unknown) => string; gateSummary: (gates: unknown) => string;
    };
    const NONE = { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true as const };
    const SOME = { advisoryFindings: 2, notCheckedRules: 0, notCheckedFiles: 0 };
    for (const exitCode of [0, 1]) {
      for (const standardsCounts of [undefined, NONE, SOME]) {
        const passed = exitCode === 0;
        const server = standardsGateWord(passed, standardsCounts);
        const name = `exit ${exitCode}, ${JSON.stringify(standardsCounts)}`;
        assert.equal(web.standardsGateWord({ command: 'moag:standards v3', exitCode, timedOut: false, standardsCounts }), server, name);
        assert.equal(web.gateSummary([{ command: 'moag:standards v3', exitCode, timedOut: false, standardsCounts }]), `standards: ${server}`, name);
        assert.equal(gateStatus({ command: 'moag:standards v3', passed, timedOut: false, standardsCounts }).word, server, `VS Code gate table, ${name}`);
      }
    }
    // The failing row in particular: "stopped" everywhere, never "fail" in one place and "stopped" in another.
    assert.equal(web.standardsGateWord({ command: 'moag:standards v3', exitCode: 1 }), 'stopped');
    assert.equal(gateStatus({ command: 'moag:standards v3', passed: false, timedOut: false }).word, 'stopped');
    assert.equal(web.standardsGateWord({ command: 'moag:standards v3', exitCode: 0, timedOut: true }), 'stopped', 'a row that timed out did not pass');
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

  describe('the task row of a halted ship gate', () => {
    const { taskDisplayStatus } = loadWebModule('screens/run.js', { ...DOM_STUBS, Set, Map }, ['taskDisplayStatus']) as
      { taskDisplayStatus: (run: unknown, task: { id: string }, status: string) => string };
    const gate = { id: 'ship-gate-1' };
    const waiting = { status: 'awaiting-approval', gate: { taskId: 'ship-gate-1', name: 'Ship approval' } };

    it('shows awaiting approval, not failed, while the run waits at that gate', () => {
      // The worker halts by stopping the runner, which reports the gate task as failed ("Manual gate cancelled").
      assert.equal(taskDisplayStatus(waiting, gate, 'failed'), 'awaiting');
      assert.equal(taskDisplayStatus(waiting, gate, 'pending'), 'awaiting');
    });

    it('leaves every other task, and the gate once the run moves on, as reported', () => {
      assert.equal(taskDisplayStatus(waiting, { id: 'other' }, 'failed'), 'failed');
      assert.equal(taskDisplayStatus(waiting, gate, 'completed'), 'completed');
      assert.equal(taskDisplayStatus({ status: 'gaps' }, gate, 'failed'), 'failed');
      assert.equal(taskDisplayStatus({ status: 'completed' }, gate, 'completed'), 'completed');
    });
  });

  describe('the gate card of a run that started before the project had standards', () => {
    const { legacyGateStandards } = loadWebModule('screens/run.js', { ...DOM_STUBS, Set, Map }, ['legacyGateStandards']) as
      { legacyGateStandards: (run: unknown, stored: unknown, effectiveVersion: number | null) => unknown };
    const legacy = { status: 'awaiting-approval' };

    it('says approving applies the version in effect, checked at verify', () => {
      assert.deepEqual(plain(legacyGateStandards(legacy, null, 3)), { kind: 'apply', version: 3 });
    });

    it('says nothing is approved yet when no version is in effect', () => {
      assert.deepEqual(plain(legacyGateStandards(legacy, null, null)), { kind: 'none' });
    });

    it('is not used for a run with a version, a run with a stored report, or a run not at its gate', () => {
      assert.equal(legacyGateStandards({ ...legacy, standardsVersion: 2 }, null, 3), null);
      assert.equal(legacyGateStandards(legacy, { phase: 'pre-gate', report: {} }, 3), null);
      assert.equal(legacyGateStandards({ status: 'running' }, null, 3), null);
      assert.equal(legacyGateStandards({ status: 'completed' }, null, 3), null);
    });

    it('the copy exists, names the version, and replaces the "predates" line on the gate card', () => {
      const { STR } = loadWebModule('strings.js', {}, ['STR']) as { STR: Record<string, { text: string } | ((...a: unknown[]) => { text: string })> };
      const c63 = (STR.C63 as (v: number) => { text: string })(3).text;
      assert.match(c63, /standards v3/);
      assert.match(c63, /checked against them when it verifies/);
      assert.match((STR.C64 as { text: string }).text, /none are approved yet/);
      const source = fs.readFileSync(path.join(WEB, 'screens', 'run.js'), 'utf-8');
      assert.match(source, /const legacy = legacyGateStandards\(run, stored, effectiveVersion\);\n\s+if \(legacy\) \{ return h\('p', \{ class: 'muted' \}, legacyGateText\(legacy\)\); \}/);
      assert.match(source, /standardsGateLine\(run, standards\.stored, standards\.focusReport, standards\.effectiveVersion\)/);
      assert.match(source, /effectiveVersion: project\.standards \? project\.standards\.effectiveVersion : null/);
    });
  });

  describe('the card badge: green only for a command that passed', () => {
    interface Look { text: string; kind: string; card: string }
    const { standardsBadge } = loadWebModule('screens/run.js', { ...DOM_STUBS, Set, Map }, ['standardsBadge']) as { standardsBadge: (t: unknown) => Look };
    const clean = [{ path: 'src/usd-format.ts', status: 'added' as const, addedLines: [1], content: 'export {};' }];
    const lookOf = (report: StandardsReport): Look => plain(standardsBadge(run.asStandardsReport(JSON.parse(JSON.stringify(report)))!.totals));
    const withCommand = (result: 'passed' | 'failed' | 'not-checked'): StandardsReport => {
      const report = checkStandards(sampleProfile(), input(clean));
      report.rules.push(commandRow({ result, command: 'npm run lint', ...(result === 'not-checked' ? { reason: 'Commands were not run' } : { exitCode: result === 'passed' ? 0 : 1 }) }));
      report.totals = recountTotals(report);
      return report;
    };
    const TOTALS = { passed: 0, noFindings: 0, failed: 0, advisory: 0, notChecked: 0, blockingNotChecked: 0, noBlockingRules: false, findings: 0, advisoryFindings: 0, notCheckedFiles: 0 };

    it('a real report whose only blocking rows are promoted scans with no findings is never badged green', () => {
      const report = checkStandards(promote(sampleProfile(), 'frontend/raw-pattern'), input(clean));
      assert.equal(standardsBlockingState(report), 'evaluated', 'the fixture really has a blocking set, and it was evaluated');
      assert.equal(report.rules.some((r) => r.rule === 'command'), false, 'and no command in it');
      assert.equal(report.totals.failed, 0);
      const look = lookOf(report);
      assert.match(look.text, /^NOTHING BLOCKING · /, look.text);
      assert.doesNotMatch(look.text, /✓|PASS/, 'no tick: a scan that found nothing proved nothing');
      assert.notEqual(look.kind, 'success');
      assert.notEqual(look.card, 'card-success');
    });

    it('promoted scans, no findings, nothing left open: "NOTHING BLOCKING · NO FINDINGS", neutral, no green frame', () => {
      const scansOnly = { ...TOTALS, noFindings: 2 };
      assert.deepEqual(plain(standardsBadge(scansOnly)), { text: 'NOTHING BLOCKING · NO FINDINGS', kind: 'muted', card: '' });
      // What was left open is still named, in the warning colour, and still with no tick.
      assert.deepEqual(plain(standardsBadge({ ...scansOnly, advisory: 1, advisoryFindings: 3, notCheckedFiles: 2 })),
        { text: 'NOTHING BLOCKING · 3 ADVISORY · 2 FILES NOT CHECKED', kind: 'warning', card: 'card-warning' });
      assert.equal(plain(standardsBadge({ ...scansOnly, notChecked: 1, notCheckedFiles: 1 })).text, 'NOTHING BLOCKING · 1 RULE NOT CHECKED · 1 FILE NOT CHECKED');
      assert.equal(plain(standardsBadge({ ...scansOnly, notChecked: 2 })).text, 'NOTHING BLOCKING · 2 RULES NOT CHECKED', 'upper case to the last letter');
      for (const t of [scansOnly, { ...scansOnly, noFindings: 9 }, { ...scansOnly, advisory: 2, advisoryFindings: 2 }, { ...scansOnly, notChecked: 1 }, { ...scansOnly, notCheckedFiles: 1 }]) {
        const look = plain(standardsBadge(t));
        assert.doesNotMatch(look.text, /✓|PASS/, JSON.stringify(t));
        assert.notEqual(look.kind, 'success', JSON.stringify(t));
        assert.notEqual(look.card, 'card-success', JSON.stringify(t));
      }
    });

    it('a command that passed, with nothing left open, is the one case that earns the green tick', () => {
      const green = { text: '✓ NOTHING BLOCKING', kind: 'success', card: 'card-success' };
      assert.deepEqual(plain(standardsBadge({ ...TOTALS, passed: 1, noFindings: 4 })), green);
      assert.deepEqual(plain(standardsBadge({ ...TOTALS, passed: 2 })), green);
      // From a real report: the command passed, so there is a real result behind the badge.
      const real = lookOf(withCommand('passed'));
      assert.match(real.text, /NOTHING BLOCKING/);
      assert.equal(real.text.includes('✓'), real.kind === 'success', 'a tick only ever on the success badge');
    });

    it('the other states keep their words: stopped, not checked, no blocking rules configured', () => {
      const failed = lookOf(withCommand('failed'));
      assert.deepEqual([failed.text, failed.kind, failed.card], ['✗ 1 BLOCKING', 'error', 'card-error']);
      const unread = lookOf(withCommand('not-checked'));
      assert.deepEqual([unread.text, unread.kind, unread.card], ['✗ 1 BLOCKING NOT CHECKED', 'error', 'card-error']);
      const none = lookOf(checkStandards(sampleProfile(), input(clean)));
      assert.match(none.text, /^NO BLOCKING RULES CONFIGURED/);
      assert.deepEqual([none.kind, none.card], ['warning', 'card-warning']);
      assert.deepEqual(plain(standardsBadge(TOTALS)), { text: '○ NOT CHECKED', kind: 'muted', card: '' });
      // A failure outranks everything else on the card.
      assert.equal(plain(standardsBadge({ ...TOTALS, failed: 2, passed: 3, noBlockingRules: true })).text, '✗ 2 BLOCKING');
    });

    it('the card is drawn from it: no second badge decision in the render', () => {
      const source = fs.readFileSync(path.join(WEB, 'screens', 'run.js'), 'utf-8');
      assert.ok(source.includes('const look = standardsBadge(t);'));
      assert.ok(source.includes('const state = badge(look.text, look.kind);'));
      assert.equal(source.split("'✓ NOTHING BLOCKING'").length - 1, 1, 'the green badge is written in one place');
      assert.equal(source.split("card: 'card-success'").length - 1, 1, 'and so is the green frame of this card');
    });
  });

  it('the plan card never offers a start the server would refuse over review errors: it says why and lists them', () => {
    // Line endings are normalised: a Windows checkout with autocrlf holds this file with CRLF.
    const source = fs.readFileSync(path.join(WEB, 'screens', 'plan.js'), 'utf-8').replace(/\r\n/g, '\n');
    assert.ok(source.includes("if (reason === 'review-errors') { return STR.C60.text; }"));
    assert.ok(source.includes("p.startBlockedReason === 'review-errors' && Array.isArray(p.startBlockedErrors)"));
    // Both buttons are drawn from the server's allowedActions and, for Approve, the review the server sent.
    assert.ok(source.includes("allowed.has('plan.approve') && review.ok ?"));
    assert.ok(source.includes("allowed.has('run.start')\n          ? h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-primary', on: { click: start } }, 'Start run'))"));
    const strings = fs.readFileSync(path.join(WEB, 'strings.js'), 'utf-8');
    assert.ok(strings.split('\n').some((l) => l.trimStart().startsWith('C60:')), 'C60 is defined');
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

describe('web run view — dependency install lines', () => {
  type Line = { kind: string; text: string; tail: string };
  const { dependencyLines, initialDependencyEvents } = loadWebModule('screens/run.js', { ...DOM_STUBS, Set, Map },
    ['dependencyLines', 'initialDependencyEvents']) as {
    dependencyLines: (events: unknown[], tasks: unknown[]) => Line[];
    initialDependencyEvents: (detail: unknown, runId: string) => Array<{ event: string }>;
  };
  const base = {
    stage: 'task', taskId: 't-build', ecosystem: 'npm', dir: '.', trigger: 'install-dir-missing',
    command: 'npm ci --no-audit --no-fund', durationMs: 12_345, exitCode: 0, timedOut: false, tail: '', note: null,
  };
  const tasks = [{ id: 't-build', name: 'Compile with tsc' }];

  it('maps the three events to success, error and info lines, skipping everything else', () => {
    const lines = plain(dependencyLines([
      { event: 'state', state: 'playing' },
      { ...base, event: 'dependencies-installed' },
      { ...base, event: 'dependencies-install-failed', exitCode: 1, durationMs: 900, tail: 'npm ERR! ERESOLVE' },
      { ...base, event: 'dependencies-not-installed', ecosystem: 'python', command: null, note: 'not installed: no virtualenv' },
    ], tasks));
    assert.deepEqual(lines, [
      { kind: 'success', text: 'Dependencies installed · npm ci --no-audit --no-fund · 12.3s · before Compile with tsc', tail: '' },
      { kind: 'error', text: 'Dependencies could not be installed · npm ci --no-audit --no-fund · exit 1 · before Compile with tsc', tail: 'npm ERR! ERESOLVE' },
      { kind: 'info', text: 'Dependencies not installed · python · not installed: no virtualenv', tail: '' },
    ]);
  });

  it('an unknown or missing taskId falls back to the stage', () => {
    const lines = plain(dependencyLines([
      { ...base, event: 'dependencies-installed', taskId: 'gone', stage: 'verify' },
      { ...base, event: 'dependencies-installed', taskId: undefined, stage: 'standards' },
    ], tasks));
    assert.ok(lines[0].text.endsWith('before the verify step'), lines[0].text);
    assert.ok(lines[1].text.endsWith('before the standards step'), lines[1].text);
  });

  it('a timed-out install says so instead of an exit code', () => {
    const [line] = plain(dependencyLines([{ ...base, event: 'dependencies-install-failed', exitCode: 124, timedOut: true, durationMs: 600_000 }], tasks));
    assert.ok(line.text.includes('timed out after 600.0s'), line.text);
  });

  it('after a reload, the card uses the server\'s whole-run list, not the recent-events window (QA M2)', () => {
    const early = { ...base, event: 'dependencies-install-failed', exitCode: 1, tail: 'npm ERR!' };
    // The early failure is gone from `events` (the last 200) but present in dependencyEvents.
    const detail = { runId: 'r1', events: [{ event: 'cost', usd: 0 }], dependencyEvents: [early] };
    const initial = plain(initialDependencyEvents(detail, 'r1'));
    assert.deepEqual(initial, [early]);
    const [line] = plain(dependencyLines(initial, tasks));
    assert.equal(line.kind, 'error');
    // An older server without the list: fall back to filtering the window.
    assert.deepEqual(plain(initialDependencyEvents({ runId: 'r1', events: [{ event: 'cost' }, early] }, 'r1')), [early]);
    // A different run's detail contributes nothing.
    assert.deepEqual(plain(initialDependencyEvents(detail, 'r2')), []);
    assert.deepEqual(plain(initialDependencyEvents(null, 'r1')), []);
  });

  it('no events means no lines', () => {
    assert.deepEqual(plain(dependencyLines([], tasks)), []);
    assert.deepEqual(plain(dependencyLines(undefined as unknown as unknown[], undefined as unknown as unknown[])), []);
  });
});
