import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parseScenario, dryRunProblem } from '../../../bench/scenario';
import { benchStandardsProfile, scenarioAllowedCommands } from '../../../bench/harness';
import { Scenario } from '../../../bench/scenario';
import {
  StandardsCheckInput, StandardsReport, checkStandards, commandRow, promotedScannerRules, recountTotals, standardsBlocked,
  standardsBlockingState,
} from '../../../standards/checker';
import { builtInProfile } from '../../../standards/built-in-profiles';
import { RULEBOOK_KEYS } from '../../../standards/rulebook';
import { enforcementChangesBetween, enforcementFieldsChanged, severityChangesBetween, validateProfile } from '../../../standards/profile';
import { parseRequirements } from '../../../models/requirements';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SCENARIOS = path.join(REPO, 'bench', 'scenarios');

/** Every file under `dir`, repository-relative with `/` separators. */
function filesUnder(dir: string, prefix = ''): string[] {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, rel) : [rel];
  });
}

/**
 * What the standards gate would see after the fake engine copied `fixtureDir`
 * into the scenario's untouched workspace: every fixture file added in full,
 * against the top-level entries and directories the workspace started with.
 */
function fixtureCheckInput(s: Scenario, fixtureDir: string, requiredDirs: readonly string[]): StandardsCheckInput {
  const workspaceRoot = s.repo.kind === 'template' ? s.repo.templateDir : s.repo.path;
  const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  return {
    baseRef: 'HEAD',
    files: filesUnder(fixtureDir).map((rel) => {
      const content = fs.readFileSync(path.join(fixtureDir, rel), 'utf-8');
      return { path: rel, status: 'added' as const, addedLines: content.replace(/\r\n?/g, '\n').split('\n').map((_, i) => i + 1), content };
    }),
    existingDirs: requiredDirs.filter((d) => isDir(path.join(workspaceRoot, d)) || isDir(path.join(fixtureDir, d))),
    topLevel: fs.readdirSync(workspaceRoot).filter((n) => n !== '.git'),
    goModulePath: null,
  };
}

/** The standards report for one version's dry-run fixture under the profile the bench would get approved. */
function fixtureReport(s: Scenario, versionIndex: number): StandardsReport {
  const profile = benchStandardsProfile(s);
  return checkStandards(profile, fixtureCheckInput(s, s.versions[versionIndex].dryRunFixture!, profile.structure.requiredDirs));
}

describe('bench scenarios shipped in bench/scenarios', () => {
  it('greenfield-todo: $10, template repo, npm test gate, v1 initial / v2 patch / v3 minor', () => {
    const s = parseScenario(path.join(SCENARIOS, 'greenfield-todo', 'scenario.json'));
    assert.equal(s.budgetUsd, 10);
    assert.equal(s.perCallCapUsd, 1);
    assert.equal(s.engine, 'claude');
    assert.equal(s.stack, 'node-ts');
    assert.equal(s.repo.kind, 'template');
    assert.deepEqual(s.gateCommands, ['npm test']);
    assert.deepEqual(s.versions.map((v) => v.intendedBump), ['initial', 'patch', 'minor']);
    assert.deepEqual(s.allowedCommands, ['npm run test', 'npm run build', 'npm install', 'npm ci', 'npm install && npm test', 'npm run build && npm test']);
    assert.equal(dryRunProblem(s), null);
    assert.ok(fs.existsSync(path.join(SCENARIOS, 'greenfield-todo', 'template', '.gitignore')));
  });

  it('brownfield-moag: $5, a clone of this repository at feat/sdlc-automation, compile + one mocha file', () => {
    const s = parseScenario(path.join(SCENARIOS, 'brownfield-moag', 'scenario.json'));
    assert.equal(s.budgetUsd, 5);
    assert.equal(s.repo.kind, 'clone');
    if (s.repo.kind !== 'clone') { return; }
    assert.equal(path.resolve(s.repo.path), REPO, 'the clone source is this repository');
    assert.equal(s.repo.ref, 'feat/sdlc-automation');
    // The unit suite reads compiled output (out/webview): without the compile
    // step the npm test probe fails in the untouched clone with 11 failures.
    assert.deepEqual(s.setupCommands, ['npm ci', 'npm run compile']);
    assert.deepEqual(s.passEnv, ['NODE_OPTIONS']);
    assert.equal(s.gateCommands.length, 2);
    assert.equal(s.gateCommands[0], 'npm run compile');
    assert.match(s.gateCommands[1], /mocha .*src\/test\/unit\/utils\/usd-format\.test\.ts$/);
    // The acceptance gate is the one targeted file, never the full suite (which
    // Node 22.6+ cannot start); it carries no Node flag, so Node 20 runs it too.
    assert.equal(s.gateCommands.includes('npm test'), false);
    assert.doesNotMatch(s.gateCommands.join('\n'), /--no-experimental/);
    // The full suite is what MOAG's own verify auto-detects: probed in the
    // untouched clone so a machine that cannot run it is reported as such.
    assert.deepEqual(s.environmentProbes, ['npm test']);
    // The full suite runs for several minutes: 30 min per gate command, for the
    // bench's own gates and (through MOAG_GATE_TIMEOUT_MS) the server's verify.
    assert.equal(s.gateTimeoutMs, 1_800_000);
    assert.deepEqual(s.versions.map((v) => v.intendedBump), ['initial']);
    assert.equal(dryRunProblem(s), null);
    // What the real planner must emit for this repository (a Testing playlist
    // with a command task running the suite) is approvable; nothing that
    // publishes, pushes or installs is.
    const allowed = scenarioAllowedCommands(s);
    for (const c of ['npm run compile', 'npm run lint', 'npm test', 'npx mocha --require ts-node/register src/test/unit/utils/usd-format.test.ts']) {
      assert.ok(allowed.includes(c), c);
    }
    for (const c of allowed) { assert.doesNotMatch(c, /push|publish|deploy|install|npm ci|[*?]/, c); }
  });

  for (const name of ['greenfield-todo', 'brownfield-moag', 'standards-violation']) {
    it(`${name}: no allow-listed command pushes, publishes, deploys or is a pattern`, () => {
      const s = parseScenario(path.join(SCENARIOS, name, 'scenario.json'));
      for (const c of scenarioAllowedCommands(s)) { assert.doesNotMatch(c, /git |push|publish|deploy|release|[*?;|`$<>]/, c); }
    });
  }

  for (const name of ['greenfield-todo', 'brownfield-moag', 'standards-violation']) {
    it(`${name}: every PRD and fixture exists, and every requirement line carries an explicit tag`, () => {
      const s = parseScenario(path.join(SCENARIOS, name, 'scenario.json'));
      for (const v of s.versions) {
        assert.ok(fs.statSync(v.prdFile).isFile(), v.prdFile);
        assert.ok(v.dryRunFixture && fs.statSync(v.dryRunFixture).isDirectory(), `${v.id} fixture`);
        const { items, errors } = parseRequirements(fs.readFileSync(v.prdFile, 'utf-8'));
        assert.deepEqual(errors, [], `${v.id}: requirement parse errors`);
        assert.ok(items.length > 0, `${v.id}: no requirements found`);
        const untagged = items.filter((i) => i.id === null).map((i) => i.line);
        assert.deepEqual(untagged, [], `${v.id}: untagged requirement lines (an untagged reworded line becomes a new id, i.e. a removal and a major bump)`);
      }
    });
  }

  for (const name of ['greenfield-todo', 'brownfield-moag', 'standards-violation']) {
    it(`${name}: the standards profile the bench gets approved is valid, and its commands are allow-listed`, () => {
      const s = parseScenario(path.join(SCENARIOS, name, 'scenario.json'));
      const profile = benchStandardsProfile(s);
      const checked = validateProfile(profile);
      assert.ok(checked.ok, checked.ok ? '' : checked.errors.join('; '));
      assert.equal(profile.stackTemplateId, s.stack);
      assert.equal(profile.repoState, s.repo.kind === 'clone' ? 'brownfield' : 'greenfield');
      for (const c of profile.commands) { assert.ok(scenarioAllowedCommands(s).includes(c.run), c.run); }
    });

    // standards-violation exists to break its profile; its expected findings are pinned in its own test below.
    if (name === 'standards-violation') { continue; }

    it(`${name}: every dry-run fixture produces zero findings under its standards profile, blocking or advisory`, () => {
      const s = parseScenario(path.join(SCENARIOS, name, 'scenario.json'));
      s.versions.forEach((v, i) => {
        const report = fixtureReport(s, i);
        assert.deepEqual(report.findings, [], `${v.id}: ${JSON.stringify(report.findings)}`);
        assert.deepEqual(report.rules.filter((r) => r.result === 'failed'), [], v.id);
        assert.deepEqual([report.totals.failed, report.totals.advisory, report.totals.advisoryFindings], [0, 0, 0], v.id);
        // A fixture that proved nothing would pass this test vacuously: at least one scan must
        // have read something. (The scans vouch for nothing — the profile's command is what
        // blocks, and the dry-run runs it for real; here no command row exists yet.)
        assert.ok(report.totals.noFindings > 0, `${v.id}: nothing was checked at all`);
        assert.equal(report.totals.passed, 0, `${v.id}: no scan is ever counted as a pass`);
        assert.equal(standardsBlockingState(report), 'none-configured', `${v.id}: nothing MOAG scans for itself blocks`);
        assert.ok(benchStandardsProfile(s).commands.length > 0, `${v.id}: the blocking set is the profile's commands`);
        assert.deepEqual(report.notCheckedFiles, [], `${v.id}: every file of the fixture is read`);
      });
    });

    it(`${name}: its profile holds the new defaults — no assistant-voice phrase, and nothing promoted that it does not name`, () => {
      const s = parseScenario(path.join(SCENARIOS, name, 'scenario.json'));
      const profile = benchStandardsProfile(s);
      for (const phrase of profile.comments.bannedPhrases) {
        assert.doesNotMatch(phrase, /\bAI\b/i, phrase);
        assert.match(phrase, /^\/\/ \S|^\.\.\. .* \.\.\.$/, `${phrase}: a whole-comment placeholder, or one between two ellipses`);
      }
      assert.ok(Object.values(profile.severity ?? {}).every((v) => v === 'advisory'), 'nothing is promoted: every scanner rule is advisory, as a project gets it by default');
    });
  }

  it('greenfield-todo: every dry-run fixture declares a local file: devDependency and an offline .npmrc', () => {
    const s = parseScenario(path.join(SCENARIOS, 'greenfield-todo', 'scenario.json'));
    const declared = new Set<string>();
    for (const v of s.versions) {
      const dir = v.dryRunFixture!;
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { devDependencies?: Record<string, string> };
      const deps = Object.entries(pkg.devDependencies ?? {});
      assert.ok(deps.length > 0 && deps.every(([, spec]) => spec.startsWith('file:')), `${v.id}: ${JSON.stringify(deps)}`);
      for (const [, spec] of deps) {
        assert.ok(fs.existsSync(path.join(dir, spec.slice('file:'.length), 'package.json')), `${v.id}: ${spec} exists in the fixture`);
      }
      declared.add(JSON.stringify(pkg.devDependencies));
      const npmrc = fs.readFileSync(path.join(dir, '.npmrc'), 'utf-8').split(/\r?\n/);
      assert.ok(npmrc.includes('offline=true'), `${v.id}: the install can never reach the registry`);
    }
    assert.equal(declared.size, 1, 'the same dependency in every version, so v2 and v3 exercise "unchanged, no install"');
  });

  it('every scenario directory is covered by these tests', () => {
    const shipped = fs.readdirSync(SCENARIOS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    assert.deepEqual(shipped, ['brownfield-moag', 'greenfield-todo', 'standards-violation']);
  });

  it('every scenario names its own standards profile with a command: no shipped scenario has an empty blocking set', () => {
    const greenfield = parseScenario(path.join(SCENARIOS, 'greenfield-todo', 'scenario.json'));
    assert.equal(greenfield.standardsProfile?.file, path.join(SCENARIOS, 'greenfield-todo', 'standards.json'));
    // Its dry-run stand-in has no src/ directory, so it requires none.
    assert.deepEqual(greenfield.standardsProfile?.profile.structure.requiredDirs, []);
    assert.deepEqual(greenfield.standardsProfile?.profile.commands, [{ label: 'Test', run: 'npm test' }]);

    // brownfield-moag: the built-in node-ts profile as it was before the Project Rulebook (its hash is
    // pinned in legacy-profiles.test.ts), as brownfield, plus the one command that makes its blocking path real.
    const brownfield = parseScenario(path.join(SCENARIOS, 'brownfield-moag', 'scenario.json'));
    assert.equal(brownfield.standardsProfile?.file, path.join(SCENARIOS, 'brownfield-moag', 'standards.json'));
    const preRulebook = builtInProfile('node-ts') as unknown as Record<string, unknown>;
    for (const key of RULEBOOK_KEYS) { delete preRulebook[key]; }
    assert.deepEqual(brownfield.standardsProfile?.profile,
      { ...preRulebook, repoState: 'brownfield', commands: [{ label: 'Compile', run: 'npm run compile' }] });
    assert.ok(brownfield.gateCommands.includes('npm run compile'), 'the command is one the scenario already allows');

    const violation = parseScenario(path.join(SCENARIOS, 'standards-violation', 'scenario.json'));
    assert.deepEqual(violation.standardsProfile?.profile.commands, [{ label: 'Lint', run: 'npm run lint' }]);

    for (const s of [greenfield, brownfield, violation]) {
      const profile = benchStandardsProfile(s);
      assert.ok(profile.commands.length > 0, `${s.name}: a command is what blocks`);
      assert.deepEqual(severityChangesBetween(null, profile), [], `${s.name}: nothing is promoted`);
      // What the hosted server will ask the bench reviewer to acknowledge: a first version that brings a command.
      assert.ok(enforcementFieldsChanged(enforcementChangesBetween(null, profile)).includes('commands'), s.name);
    }
  });

  it('standards-violation: $3, one initial version, a node-ts template whose profile blocks on a lint COMMAND, dry-runnable', () => {
    const s = parseScenario(path.join(SCENARIOS, 'standards-violation', 'scenario.json'));
    assert.equal(s.budgetUsd, 3);
    assert.equal(s.stack, 'node-ts');
    assert.equal(s.engine, 'claude');
    assert.equal(s.repo.kind, 'template');
    assert.deepEqual(s.gateCommands, ['npm test']);
    assert.deepEqual(s.allowedCommands, ['npm run test', 'npm run lint']);
    assert.deepEqual(s.versions.map((v) => [v.id, v.intendedBump]), [['v1', 'initial']]);
    assert.equal(dryRunProblem(s), null);
    assert.equal(s.standardsProfile?.file, path.join(SCENARIOS, 'standards-violation', 'standards.json'));
    assert.equal(s.standardsProfile?.profile.comments.forbidCommentedOutCode, true);
    assert.ok(s.standardsProfile?.profile.comments.bannedPhrases.includes('... rest of the code ...'));
    for (const phrase of s.standardsProfile!.profile.comments.bannedPhrases) { assert.doesNotMatch(phrase, /\bAI\b/i, phrase); }
    // It promotes NOTHING: what stops the ship is the project's own tool, by its exit code.
    assert.equal(s.standardsProfile?.profile.severity, undefined);
    assert.deepEqual(severityChangesBetween(null, s.standardsProfile!.profile), []);
    // The lint command is not the acceptance gate: the bench's own gate stays green on this fixture.
    assert.ok(!s.gateCommands.includes('npm run lint'));
    const pkg = JSON.parse(fs.readFileSync(path.join(s.versions[0].dryRunFixture!, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    assert.deepEqual(pkg.scripts, { test: 'node --test test/slug.test.js', lint: 'node tools/lint.js' });
  });

  it('standards-violation: MOAG\'s own scans report the two violations as advisory — neither can stop the ship', () => {
    // The scenario format has no expected-outcome field, so the expected result is pinned here.
    const s = parseScenario(path.join(SCENARIOS, 'standards-violation', 'scenario.json'));
    const report = fixtureReport(s, 0);
    assert.deepEqual(
      [...report.findings].sort((a, b) => a.line - b.line).map((f) => ({ file: f.file, line: f.line, rule: f.rule, severity: f.severity })),
      [
        { file: 'src/slug.js', line: 4, rule: 'comment-policy/commented-out-code', severity: 'advisory' },
        { file: 'src/slug.js', line: 6, rule: 'comment-policy/banned-phrase', severity: 'advisory' },
      ]);
    for (const f of report.findings) { assert.ok(f.message.length > 0, 'each finding says what is wrong'); }
    // The lines the findings point at really are the offending ones.
    const lines = fs.readFileSync(path.join(s.versions[0].dryRunFixture!, 'src', 'slug.js'), 'utf-8').split(/\r?\n/);
    assert.match(lines[3], /^\s*\/\/ const cached = cache\.get\(text\);$/);
    assert.match(lines[5], /^\s*\/\/ \.\.\. rest of the code \.\.\.$/, 'an unmistakable truncation placeholder, not a sentence');
    assert.deepEqual(report.totals, {
      // The always-on .env and credential scans add two "no findings". Every rule this profile leaves unconfigured is
      // "not configured" — counted apart, never among the rules not checked.
      passed: 0, noFindings: 9, failed: 0, advisory: 2, notChecked: 0, notConfigured: 10, blockingNotChecked: 0, findings: 2, advisoryFindings: 2, notCheckedFiles: 0,
    });
    assert.equal(standardsBlocked(report), false, 'no scan blocks: on the static half alone this would ship');
    assert.deepEqual(promotedScannerRules(report), []);
    // Everything else about the fixture conforms — the lint script it adds included.
    for (const rule of ['structure/required-dirs', 'structure/top-level', 'structure/placement', 'naming/files', 'comment-policy/density', 'security/env-file', 'security/secret-literal']) {
      assert.equal(report.rules.find((r) => r.rule === rule)?.result, 'passed', rule);
    }
    // Unconfigured rules say so; they are never counted as passed.
    for (const rule of ['frontend/raw-pattern', 'frontend/design-tokens', 'layering/imports', 'practice/todo-without-issue', 'practice/debug-statement', 'a11y/img-alt', 'a11y/html-lang', 'docs/changelog-updated', 'data/migration-edited', 'testing/requirement-reference']) {
      assert.equal(report.rules.find((r) => r.rule === rule)?.result, 'not-checked', rule);
    }
  });

  it('standards-violation: its profile COMMAND fails on the fixture while its tests pass — a real tool, a real exit code', function () {
    this.timeout(60_000);
    const s = parseScenario(path.join(SCENARIOS, 'standards-violation', 'scenario.json'));
    const fixture = s.versions[0].dryRunFixture!;
    /** Run one of the fixture's own scripts the way `npm run` would, without a shell. */
    const exitOf = (args: string[]): { code: number; output: string } => {
      const r = spawnSync(process.execPath, args, { cwd: fixture, encoding: 'utf-8', windowsHide: true });
      if (r.error) { throw r.error; }
      return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
    };
    let lint: { code: number; output: string };
    let tests: { code: number; output: string };
    try {
      lint = exitOf(['tools/lint.js']);
      tests = exitOf(['--test', 'test/slug.test.js']);
    } catch (err) {
      if (/EPERM/i.test((err as Error).message)) { this.skip(); return; }
      throw err;
    }
    assert.equal(lint.code, 1, lint.output);
    assert.match(lint.output, /^src\/slug\.js:6 placeholder comment left in the code$/m);
    assert.equal(tests.code, 0, tests.output);

    // That exit code, in the report: the command row fails, it is blocking, and the release stops.
    const report = fixtureReport(s, 0);
    report.rules.push(commandRow({ result: 'failed', command: 'npm run lint', exitCode: lint.code, tail: lint.output }));
    report.totals = recountTotals(report);
    assert.equal(standardsBlocked(report), true, 'the run cannot ship');
    assert.equal(standardsBlockingState(report), 'evaluated');
    assert.deepEqual([report.totals.failed, report.totals.advisory, report.totals.blockingNotChecked], [1, 2, 0]);
    assert.deepEqual(report.rules.filter((r) => r.result === 'failed' && r.severity === 'blocking').map((r) => r.rule), ['command']);
  });

  it('greenfield versions only reword/bugfix in v2 and only add in v3 (ids stay stable)', () => {
    const ids = (f: string) => parseRequirements(fs.readFileSync(path.join(SCENARIOS, 'greenfield-todo', 'prd', f), 'utf-8')).items.map((i) => i.id);
    assert.deepEqual(ids('v1.md'), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5']);
    assert.deepEqual(ids('v2.md'), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5']);
    assert.deepEqual(ids('v3.md'), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7', 'R-8']);
  });
});
