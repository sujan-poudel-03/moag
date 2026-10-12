// ─── Built-in standards profiles — one valid profile per stack ───

import { strict as assert } from 'assert';
import { BUILT_IN_RULES } from '../../../ai-rules/built-in-rules';
import { STACK_IDS, StackId } from '../../../server/stacks';
import { StandardsCheckFile, StandardsCheckInput, checkStandards, standardsBlocked } from '../../../standards/checker';
import {
  BUILT_IN_PROFILES,
  DEFAULT_MAX_COMMENT_DENSITY_PCT,
  DEFAULT_MIN_ADDED_LINES,
  builtInProfile,
} from '../../../standards/built-in-profiles';
import {
  MAX_STANDARDS_PLANNER_CHARS, MAX_STANDARDS_PROMPT_CHARS, STANDARDS_RULE_IDS, isScannerRule, renderPlannerStandards, renderStandardsText,
  renderStandardsTextDetailed, ruleSeverity, validateProfile,
} from '../../../standards/profile';
import { RULEBOOK_KEYS, plannerSummaryLines } from '../../../standards/rulebook';
import { SCAFFOLD_FIXTURES, ScaffoldFixture } from './scaffold-fixtures';

/** Every string anywhere inside `value`. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') { return [value]; }
  if (Array.isArray(value)) { return value.flatMap(stringsIn); }
  if (value && typeof value === 'object') { return Object.values(value as Record<string, unknown>).flatMap(stringsIn); }
  return [];
}

describe('standards — built-in profiles', () => {
  it('has exactly one profile per STACK_IDS member', () => {
    assert.deepEqual(Object.keys(BUILT_IN_PROFILES).sort(), [...STACK_IDS].sort());
  });

  for (const stack of STACK_IDS) {
    describe(stack, () => {
      const profile = BUILT_IN_PROFILES[stack];

      it('passes validateProfile unchanged and names its own stack', () => {
        const result = validateProfile(profile);
        assert.ok(result.ok, JSON.stringify(result));
        assert.deepEqual(result.profile, profile);
        assert.equal(profile.stackTemplateId, stack);
      });

      it('carries the default comment policy', () => {
        assert.equal(profile.comments.maxDensityPct, DEFAULT_MAX_COMMENT_DENSITY_PCT);
        assert.equal(profile.comments.minAddedLines, DEFAULT_MIN_ADDED_LINES);
        assert.equal(DEFAULT_MAX_COMMENT_DENSITY_PCT, 30);
        assert.equal(DEFAULT_MIN_ADDED_LINES, 20);
        assert.equal(profile.comments.forbidCommentedOutCode, true);
        assert.ok(profile.comments.bannedPhrases.length > 0);
      });

      if (stack === 'other') {
        it('carries the comment policy only', () => {
          assert.deepEqual(profile.structure, { requiredDirs: [], allowedTopLevel: [], placement: [] });
          assert.deepEqual(profile.naming, { files: [], notes: '' });
          assert.deepEqual(profile.testing, { runner: '', fileGlobs: [], notes: '' });
          assert.deepEqual(profile.backend, { layers: [], forbiddenImports: [], importAliases: [] });
          assert.deepEqual(profile.builtInRuleIds, []);
        });
      } else {
        it('has non-empty structure, naming and testing', () => {
          assert.ok(profile.structure.requiredDirs.length > 0, 'requiredDirs');
          assert.ok(profile.structure.allowedTopLevel.length > 0, 'allowedTopLevel');
          assert.ok(profile.structure.placement.length > 0, 'placement');
          assert.ok(profile.naming.files.length > 0, 'naming');
          assert.ok(profile.testing.fileGlobs.length > 0, 'testing.fileGlobs');
          assert.ok(profile.testing.notes.length > 0, 'testing.notes');
        });

        it('lists every required directory\'s top-level entry as allowed', () => {
          for (const dir of profile.structure.requiredDirs) {
            assert.ok(profile.structure.allowedTopLevel.includes(dir.split('/')[0]), dir);
          }
        });
      }

      it('references only rules that exist in BUILT_IN_RULES', () => {
        const known = new Set(BUILT_IN_RULES.map((r) => r.id));
        for (const id of profile.builtInRuleIds) { assert.ok(known.has(id), id); }
      });

      it('copies no built-in rule body into any profile string', () => {
        const strings = stringsIn(profile);
        for (const rule of BUILT_IN_RULES) {
          const bodyLines = rule.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
          for (const s of strings) {
            assert.ok(!s.includes(rule.text), `${rule.id} body in "${s.slice(0, 40)}"`);
            for (const bodyLine of bodyLines) {
              assert.ok(!s.includes(bodyLine), `${rule.id} line "${bodyLine.slice(0, 40)}" in a profile string`);
            }
          }
        }
      });

      it('declares no commands — a built-in never assumes a tool is installed', () => {
        assert.deepEqual(profile.commands, []);
      });

      it('renders within the prompt cap', () => {
        assert.ok(renderStandardsText(profile, 1).length <= MAX_STANDARDS_PROMPT_CHARS);
      });
    });
  }

  // On a greenfield repository the diff base is the empty tree: EVERY file is new and is
  // judged. A profile that rejects what the stack's own tooling generates ends a correct
  // first run in `gaps`, so each built-in must accept its stack's ordinary scaffold.
  describe('ordinary greenfield scaffolds yield zero findings', () => {
    const SCAFFOLDS: Record<Exclude<StackId, 'other'>, string[]> = {
      'node-ts': [
        'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig.json', 'jest.config.js', 'vitest.config.ts',
        '.gitignore', '.eslintrc.json', '.github/workflows/ci.yml', 'README.md', 'CHANGELOG', 'LICENSE', 'Dockerfile', 'docker-compose.yml',
        'src/index.ts', 'src/cart-total.ts', 'src/cart-total.test.ts', 'src/[id].ts', 'lib/util.ts',
        'test/smoke.test.ts', 'e2e/checkout.spec.ts', 'prisma/schema.prisma',
      ],
      'python': [
        'pyproject.toml', 'requirements.txt', 'setup.cfg', 'Pipfile', 'Pipfile.lock', 'MANIFEST.in', 'mkdocs.yml', 'docker-compose.yml',
        'README.md', '.gitignore', 'manage.py',
        'src/app/__init__.py', 'src/app/order_service.py', 'src/app/tests/test_order_service.py', 'app/main.py',
        'tests/conftest.py', 'tests/test_smoke.py',
      ],
      'go': [
        'go.mod', 'go.sum', 'Makefile', 'README.md', '.golangci.yml', 'main.go',
        'cmd/server/main.go', 'internal/store/store.go', 'internal/store/store_test.go', 'internal/tools/gen/main.go',
        'pkg/api/client.go', 'tools/tools.go', 'examples/basic/main.go', 'testdata/input.json', 'vendor/modules.txt',
      ],
      'java': [
        'pom.xml', 'build.gradle', 'settings.gradle', 'gradle.properties', 'gradlew', 'gradlew.bat', 'lombok.config',
        'gradle/wrapper/gradle-wrapper.properties', 'config/checkstyle/checkstyle.xml', 'README.md', '.gitignore',
        'src/main/java/module-info.java', 'src/main/java/com/acme/app/Application.java', 'src/main/java/com/acme/app/package-info.java',
        'src/main/resources/application.yml', 'src/test/java/com/acme/app/ApplicationTest.java',
      ],
      'dotnet': [
        'App.sln', 'App.slnx', 'NuGet.Config', 'nuget.config', 'global.json', 'Directory.Build.props', 'docker-compose.yml',
        'README.md', '.editorconfig',
        'src/App/App.csproj', 'src/App/Program.cs', 'src/App/OrderService.cs',
        'src/App/Migrations/20240101120000_InitialCreate.cs', 'src/App/Migrations/20240101120000_InitialCreate.Designer.cs',
        'src/App/Migrations/AppDbContextModelSnapshot.cs',
        'tests/App.Tests/App.Tests.csproj', 'tests/App.Tests/OrderServiceTests.cs',
      ],
      'static-web': [
        'index.html', 'about.html', '404.html', 'css/site.css', 'js/app.js', 'js/vendor/Chart.min.js', 'sw.js',
        'CNAME', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'images/hero.png', 'img/logo.svg',
        'robots.txt', 'sitemap.xml', 'site.webmanifest', 'manifest.json', 'netlify.toml', '_redirects', 'README.md',
        'tests/smoke.test.js',
      ],
    };
    /** One file the layout must still refuse, per stack: widening the defaults must not empty the rule. */
    const MISPLACED: Record<Exclude<StackId, 'other'>, { path: string; rule: string }> = {
      'node-ts': { path: 'scratch/notes.ts', rule: 'structure/top-level' },
      'python': { path: 'test_orders.py', rule: 'structure/placement' },
      'go': { path: 'pkg/api/main.go', rule: 'structure/placement' },
      'java': { path: 'src/main/java/com/acme/app/WidgetTest.java', rule: 'structure/placement' },
      'dotnet': { path: 'src/App/OrderServiceTests.cs', rule: 'structure/placement' },
      'static-web': { path: 'assets/widget.js', rule: 'structure/placement' },
    };
    const BODY: Record<string, string> = {
      ts: 'export const value = 1;', js: 'const value = 1;', py: 'value = 1', go: 'package main',
      java: 'package com.acme.app;', cs: 'namespace App;', html: '<p>hello</p>', css: '.a { margin: 0; }',
    };
    const fileOf = (path: string): StandardsCheckFile => {
      const content = BODY[path.split('.').pop() ?? ''] ?? 'x';
      return { path, status: 'added', addedLines: [1], content };
    };
    const greenfield = (stack: Exclude<StackId, 'other'>, paths: string[]): StandardsCheckInput => ({
      baseRef: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      files: paths.map(fileOf),
      existingDirs: BUILT_IN_PROFILES[stack].structure.requiredDirs,
      topLevel: [],
      goModulePath: stack === 'go' ? 'example.com/app' : null,
    });

    for (const stack of Object.keys(SCAFFOLDS) as Array<Exclude<StackId, 'other'>>) {
      it(`${stack}: the scaffold passes, and a misplaced file is still refused`, () => {
        const report = checkStandards(BUILT_IN_PROFILES[stack], greenfield(stack, SCAFFOLDS[stack]));
        assert.deepEqual(report.findings, []);
        assert.deepEqual(report.rules.filter((r) => r.result === 'failed'), []);
        for (const rule of ['structure/required-dirs', 'structure/top-level', 'structure/placement', 'naming/files']) {
          assert.equal(report.rules.find((r) => r.rule === rule)?.result, 'passed', rule);
        }

        const bad = MISPLACED[stack];
        const refused = checkStandards(BUILT_IN_PROFILES[stack], greenfield(stack, [...SCAFFOLDS[stack], bad.path]));
        assert.deepEqual(refused.findings.map((f) => [f.file, f.rule]), [[bad.path, bad.rule]]);
      });
    }
  });

  it('builtInProfile returns an independent copy', () => {
    const copy = builtInProfile('go');
    assert.deepEqual(copy, BUILT_IN_PROFILES.go);
    copy.structure.requiredDirs.push('mutated');
    copy.comments.bannedPhrases.length = 0;
    assert.ok(!BUILT_IN_PROFILES.go.structure.requiredDirs.includes('mutated'));
    assert.ok(BUILT_IN_PROFILES.go.comments.bannedPhrases.length > 0);
  });
});

// A built-in profile is the stack's most common shape, assumed for a project nobody has
// reviewed yet. It may advise; it may not stop a release over a layout that is just as
// ordinary as the one it assumed.
describe('standards — built-in profiles never block a mainstream scaffold', () => {
  const BODY: Record<string, string> = {
    ts: 'export const value = 1;', tsx: 'export const App = () => <p>Don\'t panic</p>;', js: 'const value = 1;', mjs: 'export default {};',
    py: 'value = 1', go: 'package main', java: 'package com.acme.app;', cs: 'namespace App;',
    html: '<p>hello</p>', css: '.a { margin: 0; }',
  };
  const fileOf = (path: string): StandardsCheckFile => ({
    path, status: 'added', addedLines: [1], content: BODY[path.split('.').pop() ?? ''] ?? 'x',
  });
  /** A greenfield first run: every file is new, and only the directories in the listing exist. */
  const inputFor = (fixture: ScaffoldFixture, extra: StandardsCheckFile[] = []): StandardsCheckInput => {
    const dirs = new Set<string>();
    for (const file of fixture.files) {
      const parts = file.split('/');
      for (let n = 1; n < parts.length; n++) { dirs.add(parts.slice(0, n).join('/')); }
    }
    return {
      baseRef: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      files: [...fixture.files.map(fileOf), ...extra],
      existingDirs: BUILT_IN_PROFILES[fixture.stack].structure.requiredDirs.filter((d) => dirs.has(d)),
      topLevel: [],
      goModulePath: fixture.stack === 'go' ? 'example.com/app' : null,
    };
  };

  it('covers every stack that has an opinionated profile, several ways each', () => {
    for (const stack of STACK_IDS) {
      if (stack === 'other') { continue; }
      assert.ok(SCAFFOLD_FIXTURES.filter((f) => f.stack === stack).length >= 3, stack);
    }
  });

  for (const fixture of SCAFFOLD_FIXTURES) {
    it(`${fixture.stack}: ${fixture.name} — zero blocking failures`, () => {
      const report = checkStandards(BUILT_IN_PROFILES[fixture.stack], inputFor(fixture));
      assert.deepEqual(report.findings.filter((f) => f.severity !== 'advisory'), []);
      assert.deepEqual(report.rules.filter((r) => r.result === 'failed' && r.severity !== 'advisory'), []);
      assert.equal(standardsBlocked(report), false);
      assert.equal(report.totals.failed, 0);
      // Every file in the listing was read: no blocking rule is left unread either.
      assert.equal(report.totals.blockingNotChecked, 0, JSON.stringify(report.rules.filter((r) => r.undecided)));
    });
  }

  it('what a built-in assumes about layout is advisory: reported with file and rule, not blocking', () => {
    const cra = SCAFFOLD_FIXTURES.find((f) => f.name.startsWith('Create React App'))!;
    const report = checkStandards(BUILT_IN_PROFILES['node-ts'], inputFor(cra));
    // camelCase names where the built-in assumes kebab-case: the CRA template's own files.
    assert.deepEqual(report.findings.map((f) => `${f.file} ${f.rule} ${f.severity}`), [
      'src/hooks/useCart.test.ts naming/files advisory',
      'src/hooks/useCart.ts naming/files advisory',
      'src/reportWebVitals.ts naming/files advisory',
      'src/setupTests.ts naming/files advisory',
    ]);

    const gradle = SCAFFOLD_FIXTURES.find((f) => f.name.startsWith('Gradle (gradle init'))!;
    const java = checkStandards(BUILT_IN_PROFILES.java, inputFor(gradle));
    assert.ok(java.findings.length > 0, 'the app/ subproject is not where the built-in assumed sources live');
    assert.ok(java.findings.every((f) => f.severity === 'advisory'));
    assert.deepEqual([...new Set(java.findings.map((f) => f.rule))].sort(), ['structure/placement', 'structure/required-dirs']);
  });

  it('nothing in a built-in blocks: no command, no severity override, and every rule advisory', () => {
    for (const stack of STACK_IDS) {
      const profile = BUILT_IN_PROFILES[stack];
      assert.equal(profile.severity, undefined, `${stack}: the defaults are already advisory, so a built-in overrides nothing`);
      assert.deepEqual(profile.commands, [], `${stack}: a built-in carries no command`);
      assert.deepEqual(STANDARDS_RULE_IDS.filter((rule) => ruleSeverity(profile, rule) === 'blocking'), [], stack);
      for (const rule of STANDARDS_RULE_IDS.filter(isScannerRule)) {
        assert.equal(ruleSeverity(profile, rule), 'advisory', `${stack} ${rule}`);
      }
    }
  });

  it('a placeholder comment and a nested repository in a scaffold are reported and do not block until promoted', () => {
    const vite = SCAFFOLD_FIXTURES.find((f) => f.name.startsWith('Vite'))!;
    const placeholder: StandardsCheckFile = {
      path: 'src/cart.ts', status: 'added', addedLines: [1, 2, 3],
      content: 'export function total() {\n  // ... rest of the code ...\n}',
    };
    const withPlaceholder = checkStandards(BUILT_IN_PROFILES['node-ts'], inputFor(vite, [placeholder]));
    assert.equal(standardsBlocked(withPlaceholder), false, 'a text scan is advisory by default');
    assert.deepEqual(withPlaceholder.findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.severity}`),
      ['src/cart.ts:2 comment-policy/banned-phrase advisory']);
    // A project that wants the scan to stop a release promotes it.
    const promoted = { ...BUILT_IN_PROFILES['node-ts'], severity: { 'comment-policy/banned-phrase': 'blocking' as const } };
    assert.equal(standardsBlocked(checkStandards(promoted, inputFor(vite, [placeholder]))), true);

    const nested = checkStandards(BUILT_IN_PROFILES['node-ts'], { ...inputFor(vite), nestedRepos: ['template-clone'] });
    assert.equal(standardsBlocked(nested), false);
    assert.deepEqual(nested.findings.map((f) => `${f.rule} ${f.severity}`), ['structure/nested-repository advisory']);
    const nestedPromoted = { ...BUILT_IN_PROFILES['node-ts'], severity: { 'structure/nested-repository': 'blocking' as const } };
    assert.equal(standardsBlocked(checkStandards(nestedPromoted, { ...inputFor(vite), nestedRepos: ['template-clone'] })), true);
  });

  it('a project that promotes the layout makes it binding', () => {
    const p = builtInProfile('java');
    p.severity = { ...p.severity, 'structure/placement': 'blocking' };
    assert.ok(validateProfile(p).ok);
    const gradle = SCAFFOLD_FIXTURES.find((f) => f.name.startsWith('Gradle (gradle init'))!;
    assert.equal(standardsBlocked(checkStandards(p, inputFor(gradle))), true);
  });
});

// ─── Project Rulebook defaults ───

describe('built-in profiles — Project Rulebook defaults', () => {
  for (const stack of STACK_IDS) {
    it(`${stack}: valid, fits the prompt with no guidance cut, one planner line per section, nothing blocking`, () => {
      const p = BUILT_IN_PROFILES[stack];
      const v = validateProfile(p);
      assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
      const rendered = renderStandardsTextDetailed(p, 999_999);
      assert.ok(rendered.text.length <= MAX_STANDARDS_PROMPT_CHARS, `${rendered.text.length}`);
      assert.deepEqual(rendered.guidanceCut, []);
      const planner = renderPlannerStandards(p, 999_999);
      assert.ok(planner.length <= MAX_STANDARDS_PLANNER_CHARS, `${planner.length}`);
      const present = RULEBOOK_KEYS.filter((k) => p[k] !== undefined);
      assert.equal(plannerSummaryLines(p).length, present.length);
      assert.ok(present.includes('practice') && present.includes('security'), 'every stack has coding practice and security');
      for (const rule of STANDARDS_RULE_IDS.filter(isScannerRule)) { assert.equal(ruleSeverity(p, rule), 'advisory', rule); }
      for (const key of present) {
        const lines = p[key]!.guidance;
        assert.ok(lines.length >= 2 && lines.length <= 4, `${key}: ${lines.length} guidance lines`);
        assert.ok(lines.every((l) => l.length <= 120), key);
      }
      assert.equal(p.practice!.todoNeedsIssue, true);
      // Off for every stack until the pre-gate check is given requirement ids (deferred D1);
      // on, it would read "not checked" at every hosted ship gate.
      assert.equal(p.testPolicy?.requirementReference, stack === 'other' ? undefined : false);
      assert.equal(p.testPolicy !== undefined, stack !== 'other');
      assert.equal(p.accessibility?.imgAlt ?? false, stack === 'static-web');
    });
  }

  it('names each stack\'s dependency audit as guidance, never as a command', () => {
    const audit: Record<string, RegExp> = {
      'node-ts': /npm audit --audit-level=high/, python: /pip-audit/, go: /govulncheck/, dotnet: /dotnet list package --vulnerable/,
    };
    for (const [stack, re] of Object.entries(audit)) {
      const p = BUILT_IN_PROFILES[stack as StackId];
      assert.ok(p.security!.guidance.some((g) => re.test(g)), stack);
      assert.ok(!p.commands.some((c) => re.test(c.run)), stack);
    }
  });
});
