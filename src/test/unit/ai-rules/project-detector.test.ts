// ─── Project detector — detectProjectRules characterization, then detectProjectConventions ───

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectConventions, detectDesignSources, detectProjectConventions, detectProjectRules, minimalGitEnv, readTrackedFiles,
} from '../../../ai-rules/project-detector';
import { ruleSeverity } from '../../../standards/profile';
import { proposeProfile } from '../../../standards/propose';
import { makeRepo } from './fixtures';

const ALL_EIGHT = [
  'builtin-solid', 'builtin-clean-code', 'builtin-self-documenting', 'builtin-tdd',
  'builtin-owasp', 'builtin-error-handling', 'builtin-perf', 'builtin-dry',
];

// Pins the behaviour of the pre-existing export, so adding detectProjectConventions
// beside it cannot change what the "suggest rules" flow returns.
describe('project detector — detectProjectRules (characterization)', () => {
  it('returns only Clean Code for an empty directory', () => {
    const dir = makeRepo('moag-det-empty-', {});
    assert.deepEqual(detectProjectRules(dir), { signals: [], suggestedRuleIds: ['builtin-clean-code'] });
  });

  it('detects a TypeScript React + Express + Prisma + Jest project', () => {
    const dir = makeRepo('moag-det-node-', {
      'package.json': JSON.stringify({
        dependencies: { react: '18', 'react-dom': '18', express: '4', '@prisma/client': '5' },
        devDependencies: { typescript: '5', jest: '29' },
      }),
    });
    assert.deepEqual(detectProjectRules(dir), {
      signals: ['TypeScript', 'React', 'Express', 'Database', 'Jest'],
      suggestedRuleIds: ALL_EIGHT,
    });
  });

  it('detects TypeScript from tsconfig.json alone and a test script as Mocha', () => {
    const dir = makeRepo('moag-det-tsconfig-', {
      'tsconfig.json': '{}',
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    });
    assert.deepEqual(detectProjectRules(dir), {
      signals: ['TypeScript', 'Mocha'],
      suggestedRuleIds: ['builtin-solid', 'builtin-clean-code', 'builtin-self-documenting', 'builtin-tdd'],
    });
  });

  it('detects a Python FastAPI project from requirements.txt', () => {
    const dir = makeRepo('moag-det-py-', {
      'requirements.txt': 'fastapi==0.110\nsqlalchemy>=2\npytest\n# a comment\n-r other.txt\n',
    });
    assert.deepEqual(detectProjectRules(dir), {
      signals: ['Python', 'FastAPI', 'SQLAlchemy', 'pytest'],
      suggestedRuleIds: ['builtin-clean-code', 'builtin-tdd', 'builtin-owasp', 'builtin-error-handling', 'builtin-perf', 'builtin-dry'],
    });
  });

  it('detects a Go Gin project from go.mod', () => {
    const dir = makeRepo('moag-det-go-', {
      'go.mod': 'module example.com/app\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgithub.com/stretchr/testify v1.8.0\n)\n',
    });
    assert.deepEqual(detectProjectRules(dir), {
      signals: ['Go', 'Gin', 'Testify'],
      suggestedRuleIds: [
        'builtin-clean-code', 'builtin-self-documenting', 'builtin-tdd', 'builtin-owasp',
        'builtin-error-handling', 'builtin-perf', 'builtin-dry',
      ],
    });
  });

  it('detects a Rust Axum project from Cargo.toml', () => {
    const dir = makeRepo('moag-det-rust-', {
      'Cargo.toml': '[package]\nname = "app"\n\n[dependencies]\ntokio = { version = "1" }\naxum = "0.7"\n',
    });
    assert.deepEqual(detectProjectRules(dir), {
      signals: ['Rust', 'Tokio (async)', 'Axum'],
      suggestedRuleIds: [
        'builtin-clean-code', 'builtin-self-documenting', 'builtin-owasp', 'builtin-error-handling',
        'builtin-perf', 'builtin-dry',
      ],
    });
  });

  it('detects a Java Spring Boot project from pom.xml', () => {
    const dir = makeRepo('moag-det-java-', {
      'pom.xml': '<project><dependencies>'
        + '<dependency><artifactId>spring-boot-starter-web</artifactId></dependency>'
        + '<dependency><artifactId>junit-jupiter</artifactId></dependency>'
        + '</dependencies></project>',
    });
    assert.deepEqual(detectProjectRules(dir), { signals: ['Java', 'Spring Boot', 'JUnit'], suggestedRuleIds: ALL_EIGHT });
  });

  it('treats a malformed package.json as no JavaScript project, without throwing', () => {
    const dir = makeRepo('moag-det-bad-', { 'package.json': '{ not json' });
    assert.deepEqual(detectProjectRules(dir), { signals: [], suggestedRuleIds: ['builtin-clean-code'] });
  });

  it('does not throw for a directory that does not exist', () => {
    const missing = path.join(os.tmpdir(), `moag-det-missing-${Date.now()}`);
    assert.deepEqual(detectProjectRules(missing), { signals: [], suggestedRuleIds: ['builtin-clean-code'] });
  });
});

describe('project detector — detectProjectConventions', () => {
  it('reports nothing for an empty directory', () => {
    const d = detectProjectConventions(makeRepo('moag-conv-empty-', {}));
    assert.deepEqual(d, {
      stack: null, framework: null, topLevel: [], sourceDirs: null, testDirs: null,
      lintConfigs: [], formatConfigs: [], testRunner: null, componentLibrary: null, scripts: null,
      sourceFileCount: 0, sampleSourceFile: null, sourceFileSample: [], commentDensity: null, suggestedRuleIds: ['builtin-clean-code'],
      trackedTopLevelDirs: null, trackedUnavailable: 'git was not asked which files it tracks',
    });
  });

  it('samples source file names shallowest first, bounded, and leaves out noise and configuration', function () {
    // Writes and walks 1,008 real files: 0.4-1 s normally, past mocha's 2 s default on a busy Windows disk.
    this.timeout(30_000);
    const files: Record<string, string> = { 'package.json': '{}', 'vite.config.ts': 'export default {};\n', 'node_modules/dep/index.js': 'x();\n' };
    for (let i = 0; i < 1_005; i++) { files[`src/deep/f${String(i).padStart(4, '0')}.ts`] = ''; }
    files['src/useAuth.ts'] = 'export const useAuth = 1;\n';
    const d = detectProjectConventions(makeRepo('moag-conv-sample-', files));
    assert.equal(d.sourceFileCount, 1_006);
    assert.equal(d.sourceFileSample.length, 1_000);
    assert.equal(d.sourceFileSample[0], 'src/useAuth.ts', 'the shallower file comes first');
    assert.ok(d.sourceFileSample.every((f) => f.startsWith('src/')), 'no dependency tree, no tool configuration');
  });

  it('never throws for a directory that does not exist', () => {
    const missing = path.join(os.tmpdir(), `moag-conv-missing-${Date.now()}`);
    const d = detectProjectConventions(missing);
    assert.equal(d.sourceFileCount, 0);
    assert.equal(d.stack, null);
  });

  it('node-ts: every finding names the file that proved it', () => {
    const dir = makeRepo('moag-conv-node-', {
      'package.json': JSON.stringify({
        dependencies: { next: '14', react: '18', tailwindcss: '3' },
        devDependencies: { typescript: '5', vitest: '1' },
        scripts: { lint: 'next lint', 'format:check': 'prettier --check .', 'has space': 'x' },
      }),
      'vitest.config.ts': 'export default {};\n',
      'eslint.config.mjs': 'export default [];\n',
      '.prettierrc.json': '{}',
      '.editorconfig': 'root = true\n',
      'src/app/page.tsx': 'export default function Page() { return null; }\n',
      'src/lib/util.ts': '// helper\nexport const one = 1;\n',
      'src/__tests__/util.test.ts': 'import { one } from "../lib/util";\none;\n',
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      'dist/out.js': 'var a = 1;\n',
    });
    const d = detectProjectConventions(dir);
    assert.deepEqual(d.stack, { value: 'node-ts', evidence: 'package.json' });
    assert.deepEqual(d.framework, { value: 'Next.js', evidence: 'package.json' });
    assert.deepEqual(d.componentLibrary, { value: 'Tailwind CSS', evidence: 'package.json' });
    assert.deepEqual(d.testRunner, { value: 'Vitest', evidence: 'vitest.config.ts' });
    assert.deepEqual(d.lintConfigs, [{ tool: 'eslint', file: 'eslint.config.mjs' }]);
    assert.deepEqual(d.formatConfigs, [{ tool: 'prettier', file: '.prettierrc.json' }, { tool: 'editorconfig', file: '.editorconfig' }]);
    assert.deepEqual(d.scripts, { value: ['lint', 'format:check'], evidence: 'package.json' });
    assert.deepEqual(d.sourceDirs, { value: ['src'], evidence: 'src/app/page.tsx' });
    assert.deepEqual(d.testDirs, { value: ['src/__tests__'], evidence: 'src/__tests__/util.test.ts' });
    assert.equal(d.sourceFileCount, 3, 'node_modules, dist and *.config.* are not project source');
    assert.equal(d.sampleSourceFile, 'src/__tests__/util.test.ts');
    assert.ok(!d.topLevel.includes('node_modules') && !d.topLevel.includes('dist'));
    assert.ok(d.topLevel.includes('src') && d.topLevel.includes('package.json'));
    assert.ok(d.commentDensity);
    assert.equal(d.commentDensity.filesSampled, 3);
    for (const proof of [d.stack.evidence, d.testRunner.evidence, d.sourceDirs.evidence, d.testDirs.evidence, d.commentDensity.evidence]) {
      assert.ok(fs.existsSync(path.join(dir, ...proof.split('/'))), proof);
    }
  });

  it('measures the comment-density baseline with the standards lexer', () => {
    const dir = makeRepo('moag-conv-density-', {
      'package.json': '{}',
      'src/a.ts': [
        '// header line, not counted',
        'const url = "http://not-a-comment";',
        '// counted',
        '/** doc, not counted */',
        'export const a = 1; // trailing, not a comment-only line',
        '// counted',
        '',
        'export const b = 2;',
      ].join('\n'),
      'src/broken.ts': 'const s = `never closed',
      'src/main.rs': '// rust is not lexed\nfn main() {}\n',
    });
    const d = detectProjectConventions(dir);
    assert.deepEqual(d.commentDensity, { pct: 25, filesSampled: 1, evidence: 'src/a.ts' });
  });

  it('detects dotnet from a .csproj below the root, preferring a solution file when there is one', () => {
    const nested = makeRepo('moag-conv-net-', {
      'src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PackageReference Include="NUnit" /></Project>',
      'src/App/Program.cs': 'class Program {}\n',
    });
    const d = detectProjectConventions(nested);
    assert.deepEqual(d.stack, { value: 'dotnet', evidence: 'src/App/App.csproj' });
    assert.deepEqual(d.framework, { value: 'ASP.NET Core', evidence: 'src/App/App.csproj' });
    assert.deepEqual(d.testRunner, { value: 'NUnit', evidence: 'src/App/App.csproj' });

    const withSln = makeRepo('moag-conv-sln-', { 'App.sln': 'x', 'App/App.csproj': '<Project />', 'App/A.cs': 'class A {}\n' });
    assert.deepEqual(detectProjectConventions(withSln).stack, { value: 'dotnet', evidence: 'App.sln' });
  });

  it('detects python, go, java and rust from their manifests', () => {
    const py = detectProjectConventions(makeRepo('moag-conv-py-', {
      'requirements.txt': 'django\n', 'conftest.py': '', 'pyproject.toml': '[tool.ruff]\n[tool.black]\n', 'app/models.py': 'x = 1\n',
    }));
    assert.deepEqual(py.stack, { value: 'python', evidence: 'pyproject.toml' });
    assert.deepEqual(py.framework, { value: 'Django', evidence: 'pyproject.toml' });
    assert.deepEqual(py.testRunner, { value: 'pytest', evidence: 'conftest.py' });
    assert.deepEqual(py.lintConfigs, [{ tool: 'ruff', file: 'pyproject.toml' }]);
    assert.deepEqual(py.formatConfigs, [{ tool: 'black', file: 'pyproject.toml' }]);

    const go = detectProjectConventions(makeRepo('moag-conv-go-', {
      'go.mod': 'module example.com/app\nrequire github.com/go-chi/chi v5\n', 'main.go': 'package main\n',
    }));
    assert.deepEqual(go.stack, { value: 'go', evidence: 'go.mod' });
    assert.deepEqual(go.framework, { value: 'Chi', evidence: 'go.mod' });
    assert.deepEqual(go.testRunner, { value: 'go test', evidence: 'go.mod' });
    assert.equal(go.sourceDirs, null, 'source at the root is not a source directory');

    const java = detectProjectConventions(makeRepo('moag-conv-java-', {
      'build.gradle': 'dependencies { implementation "io.quarkus:quarkus-core" }\n', 'src/main/java/A.java': 'class A {}\n',
    }));
    assert.deepEqual(java.stack, { value: 'java', evidence: 'build.gradle' });
    assert.deepEqual(java.framework, { value: 'Quarkus', evidence: 'build.gradle' });
    assert.equal(java.testRunner, null);

    const rust = detectProjectConventions(makeRepo('moag-conv-rust-', { 'Cargo.toml': '[package]\n', 'src/main.rs': 'fn main() {}\n' }));
    assert.deepEqual(rust.stack, { value: 'rust', evidence: 'Cargo.toml' });
  });

  it('picks the stack with the most source when several manifests are present', () => {
    const dir = makeRepo('moag-conv-mixed-', {
      'package.json': '{}',
      'go.mod': 'module example.com/app\n',
      'tools/build.js': 'module.exports = 1;\n',
      'cmd/a.go': 'package main\n',
      'cmd/b.go': 'package main\n',
    });
    assert.deepEqual(detectProjectConventions(dir).stack, { value: 'go', evidence: 'go.mod' });
  });

  it('falls back to static-web only when there is an index.html and no manifest', () => {
    const d = detectProjectConventions(makeRepo('moag-conv-static-', { 'index.html': '<p>x</p>\n', 'css/site.css': '.a{}\n' }));
    assert.deepEqual(d.stack, { value: 'static-web', evidence: 'index.html' });
    assert.equal(d.sourceFileCount, 2);
  });

  it('treats a malformed package.json as proof of nothing', () => {
    const d = detectProjectConventions(makeRepo('moag-conv-bad-', { 'package.json': '{ "scripts": ', 'src/a.js': 'module.exports = 1;\n' }));
    assert.equal(d.stack, null);
    assert.equal(d.scripts, null);
    assert.equal(d.testRunner, null);
    assert.equal(d.sourceFileCount, 1);
  });

  it('ignores a package.json whose sections have the wrong types', () => {
    const d = detectProjectConventions(makeRepo('moag-conv-types-', {
      'package.json': JSON.stringify({ dependencies: 'react', devDependencies: ['jest'], scripts: 7 }),
      'src/a.js': 'module.exports = 1;\n',
    }));
    assert.deepEqual(d.stack, { value: 'node-ts', evidence: 'package.json' });
    assert.equal(d.framework, null);
    assert.equal(d.scripts, null);
  });

  it('does not read an oversize manifest', () => {
    const dir = makeRepo('moag-conv-big-', {
      'package.json': `{"dependencies":{"react":"18"},"pad":"${'x'.repeat(300 * 1024)}"}`,
      'src/a.js': 'module.exports = 1;\n',
    });
    const d = detectProjectConventions(dir);
    assert.equal(d.stack, null);
    assert.deepEqual(d.suggestedRuleIds, [], 'the unbounded legacy detector is not run over an oversize manifest');
  });

  it('does not follow a symlinked directory', function () {
    const outside = makeRepo('moag-conv-outside-', { 'secret/a.ts': 'export const a = 1;\n' });
    const dir = makeRepo('moag-conv-link-', { 'package.json': '{}', 'src/b.ts': 'export const b = 1;\n' });
    try {
      fs.symlinkSync(path.join(outside, 'secret'), path.join(dir, 'linked'), 'junction');
    } catch {
      this.skip();
    }
    const d = detectProjectConventions(dir);
    assert.equal(d.sourceFileCount, 1);
    assert.deepEqual(d.sourceDirs, { value: ['src'], evidence: 'src/b.ts' });
  });

  it('stops descending at the depth limit instead of walking forever', () => {
    const deep = `${Array.from({ length: 12 }, (_, i) => `d${i}`).join('/')}/far.ts`;
    const d = detectProjectConventions(makeRepo('moag-conv-deep-', { 'package.json': '{}', 'near.ts': 'export {};\n', [deep]: 'export {};\n' }));
    assert.equal(d.sourceFileCount, 1);
  });
});

// ─── Real git: what is on disk is not what the repository tracks ───

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

describe('project detector — git-tracked files only (real git)', function () {
  // Every case spawns git several times; on Windows each spawn is slow.
  this.timeout(30_000);

  /** Run git in `dir`; returns false when this environment cannot spawn at all. */
  function git(dir: string, ...args: string[]): boolean {
    try {
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch (err) {
      if (isSpawnEperm(err) || (err as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
      throw err;
    }
  }

  /** The QA reproduction: tracked `src` (with a nested test folder), gitignored `lib` and `playwright-report`. */
  function repoWithIgnoredOutput(): string {
    return makeRepo('moag-conv-git-', {
      '.gitignore': 'lib/\nplaywright-report/\n',
      'package.json': '{}',
      'src/a.ts': 'export const a = 1;\n',
      'src/cart/__tests__/cart.test.ts': 'export {};\n',
      'lib/a.js': 'module.exports = 1;\n',
      'playwright-report/index.html': '<html></html>\n',
    });
  }

  function commitAll(dir: string): boolean {
    return git(dir, 'init', '-q', '.') && git(dir, 'config', 'user.email', 't@t.t') && git(dir, 'config', 'user.name', 't')
      && git(dir, 'add', '-A') && git(dir, 'commit', '-qm', 'init');
  }

  it('lists what git tracks; a gitignored directory with a source file is never detected, let alone proposed', async function () {
    const dir = repoWithIgnoredOutput();
    if (!commitAll(dir)) { this.skip(); return; }
    const tracked = await readTrackedFiles(dir);
    assert.deepEqual(tracked, { ok: true, files: ['.gitignore', 'package.json', 'src/a.ts', 'src/cart/__tests__/cart.test.ts'] });

    const d = await detectConventions(dir);
    assert.deepEqual(d.trackedTopLevelDirs, ['src']);
    assert.equal(d.trackedUnavailable, undefined);
    // Not even seen: the detection is made from git's listing, not from the disk.
    assert.deepEqual(d.sourceDirs?.value, ['src']);
    assert.deepEqual(d.topLevel, ['.gitignore', 'package.json', 'src']);
    assert.ok(d.sourceFileSample.every((f) => f.startsWith('src/')), d.sourceFileSample.join(', '));

    const proposal = proposeProfile('node-ts', d);
    assert.deepEqual(proposal.profile.structure.requiredDirs, ['src']);
    assert.match(proposal.provenance['structure.requiredDirs'].evidence, /tracked by git$/);
    assert.equal(ruleSeverity(proposal.profile, 'structure/required-dirs'), 'advisory', 'detected or not, a scan MOAG makes itself never blocks by default');
    // (`lib` is also a name the stack template allows; what matters is that nothing was DETECTED from the ignored one.)
    assert.doesNotMatch(JSON.stringify(proposal.profile), /playwright-report/, 'no ignored directory anywhere in the proposal');
    assert.doesNotMatch(JSON.stringify(proposal.provenance), /lib\/|playwright-report/, 'and none is the proof of anything');

    // An ordinary clean: the proposal must still hold.
    fs.rmSync(path.join(dir, 'lib'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'playwright-report'), { recursive: true, force: true });
    assert.deepEqual(proposeProfile('node-ts', await detectConventions(dir)).profile, proposal.profile);
  });

  it('an untracked directory that is not ignored is not proposed either: it is not in the index', async function () {
    const dir = makeRepo('moag-conv-git-untracked-', { 'package.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
    if (!commitAll(dir)) { this.skip(); return; }
    fs.mkdirSync(path.join(dir, 'scratch'));
    fs.writeFileSync(path.join(dir, 'scratch', 'b.ts'), 'export const b = 1;\n');
    const d = await detectConventions(dir);
    assert.deepEqual(d.trackedTopLevelDirs, ['src']);
    assert.deepEqual(proposeProfile('node-ts', d).profile.structure.requiredDirs, ['src']);
  });

  it('a configuration file that is on disk but ignored proves nothing', async function () {
    const dir = makeRepo('moag-conv-git-config-', {
      '.gitignore': '.eslintrc.json\n', 'package.json': '{}', '.eslintrc.json': '{}', 'src/a.ts': 'export const a = 1;\n',
    });
    if (!commitAll(dir)) { this.skip(); return; }
    assert.deepEqual((await detectConventions(dir)).lintConfigs, []);
    assert.deepEqual(detectProjectConventions(dir).lintConfigs, [{ tool: 'eslint', file: '.eslintrc.json' }], 'without the listing the disk is all there is');
  });

  it('says why when git gives no listing, and then no directory is proposed at all', async function () {
    const plain = repoWithIgnoredOutput();
    const notARepo = await readTrackedFiles(plain);
    if (!notARepo.ok && /not installed/.test(notARepo.reason)) { this.skip(); return; }
    assert.deepEqual(notARepo, { ok: false, reason: 'the workspace is not a git repository' });
    assert.equal((await readTrackedFiles(path.join(plain, 'does-not-exist'))).ok, false, 'no such directory');

    const d = await detectConventions(plain);
    assert.equal(d.trackedTopLevelDirs, null);
    assert.equal(d.trackedUnavailable, 'the workspace is not a git repository');
    // The code is still described from the disk: stack, counts, naming.
    assert.deepEqual(d.stack, { value: 'node-ts', evidence: 'package.json' });
    assert.ok(d.sourceFileCount > 0);
    const proposal = proposeProfile('node-ts', d);
    assert.deepEqual(proposal.profile.structure.requiredDirs, [], 'lib/ and playwright-report/ may be ignored: nothing is proposed');
    assert.deepEqual(proposal.profile.structure.placement, []);
    assert.deepEqual(proposal.profile.backend.layers, []);
    assert.deepEqual(proposal.provenance['structure.requiredDirs'],
      { tag: 'assumed', evidence: 'no directory is proposed: the workspace is not a git repository' });
    assert.match(proposal.provenance['structure.allowedTopLevel'].evidence, /no directory is proposed: the workspace is not a git repository$/);

    const outer = repoWithIgnoredOutput();
    if (!commitAll(outer)) { this.skip(); return; }
    assert.deepEqual(await readTrackedFiles(path.join(outer, 'src')),
      { ok: false, reason: 'the workspace is not the root of its git repository' });
  });

  it('a repository with nothing added yet tracks nothing: greenfield, whatever sits on disk', async function () {
    const unborn = repoWithIgnoredOutput();
    if (!git(unborn, 'init', '-q', '.')) { this.skip(); return; }
    assert.deepEqual(await readTrackedFiles(unborn), { ok: true, files: [] });
    const d = await detectConventions(unborn);
    assert.equal(d.sourceFileCount, 0);
    assert.deepEqual(d.trackedTopLevelDirs, []);
    assert.equal(proposeProfile('node-ts', d).profile.repoState, 'greenfield');
  });

  it('an inherited GIT_DIR or GIT_WORK_TREE cannot make git answer for another repository', async function () {
    const mine = makeRepo('moag-conv-git-mine-', { 'package.json': '{}', 'src/mine.ts': 'export const a = 1;\n' });
    const other = makeRepo('moag-conv-git-other-', { 'package.json': '{}', 'elsewhere/other.ts': 'export const b = 1;\n' });
    if (!commitAll(mine) || !commitAll(other)) { this.skip(); return; }
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    try {
      assert.deepEqual(await readTrackedFiles(mine), { ok: true, files: ['package.json', 'src/mine.ts'] });
    } finally {
      if (saved.dir === undefined) { delete process.env.GIT_DIR; } else { process.env.GIT_DIR = saved.dir; }
      if (saved.tree === undefined) { delete process.env.GIT_WORK_TREE; } else { process.env.GIT_WORK_TREE = saved.tree; }
    }
  });

  it('the environment git is given holds no GIT_* variable from the caller, and never prompts', () => {
    const env = minimalGitEnv({
      PATH: '/usr/bin', Path: 'C:\\bin', HOME: '/home/u', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index', GIT_CONFIG_GLOBAL: '/tmp/other', NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'x',
    });
    assert.deepEqual(Object.keys(env).sort(), ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH', 'Path']);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });
});

describe('project detector — git is asked asynchronously, and a refusal is said in words', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxyquire = require('proxyquire').noCallThru();
  type GitError = Error & { code?: string | number; killed?: boolean };
  type Callback = (err: GitError | null, stdout: string, stderr: string) => void;
  interface Answer { err?: GitError; stdout?: string; stderr?: string }
  /** The detector with `git` answered by `answer`; every call is recorded. */
  function withGit(answer: (args: string[]) => Answer) {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const detector = proxyquire('../../../ai-rules/project-detector', {
      child_process: {
        execFile: (_file: string, args: string[], opts: { env: NodeJS.ProcessEnv }, cb: Callback) => {
          calls.push({ args, env: opts.env });
          const a = answer(args);
          setImmediate(() => cb(a.err ?? null, a.stdout ?? '', a.stderr ?? ''));
        },
        execFileSync: () => { throw new Error('execFileSync must never be used: it blocks the server event loop'); },
        spawn: () => { throw new Error('spawn is not how the detector asks git'); },
        execSync: () => { throw new Error('execSync must never be used'); },
      },
    }) as typeof import('../../../ai-rules/project-detector');
    return { detector, calls };
  }
  const fail = (stderr: string, code: string | number = 128): Answer => ({ err: Object.assign(new Error('git failed'), { code }), stderr });

  it('safe.directory: git refusing the workspace is reported as that, and reaches the provenance', async () => {
    const { detector, calls } = withGit(() => fail(
      "fatal: detected dubious ownership in repository at 'D:/ws'\nTo add an exception for this directory, call:\n\tgit config --global --add safe.directory D:/ws\n"));
    const dir = makeRepo('moag-conv-refused-', { 'package.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
    const tracked = await detector.readTrackedFiles(dir);
    assert.deepEqual(tracked, { ok: false, reason: 'git refuses this workspace: it is owned by another user (see git safe.directory)' });
    assert.equal(calls.length, 1, 'the listing is not asked for after a refusal');
    assert.equal(calls[0].env.GIT_DIR, undefined);

    const proposal = proposeProfile('node-ts', await detector.detectConventions(dir));
    assert.deepEqual(proposal.profile.structure.requiredDirs, []);
    assert.equal(proposal.provenance['structure.requiredDirs'].evidence,
      'no directory is proposed: git refuses this workspace: it is owned by another user (see git safe.directory)');
  });

  it('a missing git, a timeout and an oversize listing each get their own words; none throws', async () => {
    const cases: Array<[Answer, RegExp]> = [
      [fail('', 'ENOENT'), /not installed or could not be started/],
      [{ err: Object.assign(new Error('killed'), { killed: true }), stderr: '' }, /did not answer in time/],
      [fail('', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'), /more files than can be listed/],
      [fail('fatal: something else'), /could not list the tracked files/],
    ];
    for (const [answer, words] of cases) {
      const { detector } = withGit(() => answer);
      const tracked = await detector.readTrackedFiles('.');
      assert.equal(tracked.ok, false);
      if (!tracked.ok) { assert.match(tracked.reason, words); }
    }
  });

  it('the listing itself failing after the root check is a refusal too', async () => {
    const { detector, calls } = withGit((args) => (args.includes('rev-parse') ? { stdout: '\n' } : fail('fatal: index file corrupt')));
    assert.deepEqual(await detector.readTrackedFiles('.'), { ok: false, reason: 'git could not list the tracked files' });
    assert.deepEqual(calls.map((c) => c.args.slice(-2)), [['rev-parse', '--show-prefix'], ['ls-files', '-z']]);
  });

  it('the synchronous detection spawns nothing at all', () => {
    const { detector, calls } = withGit(() => { throw new Error('git was asked'); });
    const d = detector.detectProjectConventions(makeRepo('moag-conv-nospawn-', { 'package.json': '{}', 'src/a.ts': 'export const a = 1;\n' }));
    assert.equal(d.sourceFileCount, 1);
    assert.equal(calls.length, 0);
  });
});

describe('project detector — detectDesignSources', () => {
  it('adopts a CSS file that declares :root custom properties, and a design document', () => {
    const dir = makeRepo('moag-design-src-', { 'src/theme.css': ':root{--x:1px}', 'docs/DESIGN.md': '# D\n', 'index.html': '<!doctype html>' });
    assert.deepEqual(detectDesignSources(dir), {
      tokens: { path: 'src/theme.css', content: ':root{--x:1px}' },
      doc: { path: 'docs/DESIGN.md', content: '# D\n' },
      ui: { value: 'index.html', evidence: 'index.html' },
    });
  });

  it('ignores a CSS candidate without :root variables and moves on to the next one', () => {
    const dir = makeRepo('moag-design-src2-', { 'src/styles/tokens.css': 'body { margin: 0; }', 'css/tokens.css': ':root {\n  --a: #fff;\n}' });
    assert.equal(detectDesignSources(dir).tokens?.path, 'css/tokens.css');
    assert.deepEqual(detectDesignSources(dir).notAdopted, [{ path: 'src/styles/tokens.css', reason: 'declares no :root custom properties', content: 'body { margin: 0; }' }]);
    assert.deepEqual(detectDesignSources(makeRepo('moag-design-src3-', { 'src/theme.css': 'a{}' })), {
      tokens: null, doc: null, ui: null,
      notAdopted: [{ path: 'src/theme.css', reason: 'declares no :root custom properties', content: 'a{}' }],
    });
  });

  it('accepts :root in a selector list as a tokens file', () => {
    for (const head of [':root, [data-theme="light"] {', '[data-theme="dark"], :root {', 'html:root {']) {
      const dir = makeRepo('moag-design-sellist-', { 'css/tokens.css': `${head}\n  --a: #fff;\n}\n` });
      assert.equal(detectDesignSources(dir).tokens?.path, 'css/tokens.css', head);
    }
    const notRoot = makeRepo('moag-design-sellist-no-', { 'css/tokens.css': '.root { --a: #fff; }\n' });
    assert.equal(detectDesignSources(notRoot).tokens, null);
  });

  it('lists every candidate or fallback path that exists but was not adopted, so a proposal never targets it', () => {
    const dir = makeRepo('moag-design-taken-', {
      'src/theme.css': ':root{--x:1px}', 'css/tokens.css': 'a{}', 'css/design-tokens.css': 'b{}', 'docs/design/DESIGN.md': 'x'.repeat(13_000),
    });
    const found = detectDesignSources(dir);
    assert.equal(found.tokens?.path, 'src/theme.css');
    assert.deepEqual(found.notAdopted, [
      { path: 'css/tokens.css', reason: 'src/theme.css was adopted instead' },
      { path: 'docs/design/DESIGN.md', reason: 'larger than 12000 characters' },
      { path: 'css/design-tokens.css', reason: 'already exists', content: 'b{}' },
    ]);
  });

  it('ignores an untracked candidate when the tracked listing is given', () => {
    const dir = makeRepo('moag-design-src4-', { 'src/theme.css': ':root{--x:1px}', 'src/a.ts': 'export {};\n' });
    const detection = detectProjectConventions(dir, { tracked: { ok: true, files: ['src/a.ts'] } });
    assert.equal(detection.designSources?.tokens, null, 'an untracked candidate is never adopted');
    assert.deepEqual(detection.designSources?.notAdopted, [{ path: 'src/theme.css', reason: 'not tracked by git', content: ':root{--x:1px}' }],
      'but it is listed, so a proposal never writes over it');
    const none = detectProjectConventions(makeRepo('moag-design-src4b-', { 'src/a.ts': 'export {};\n' }), { tracked: { ok: true, files: ['src/a.ts'] } });
    assert.equal(none.designSources, undefined, 'nothing on disk, no key at all');
    const tracked = detectProjectConventions(dir, { tracked: { ok: true, files: ['src/a.ts', 'src/theme.css'] } });
    assert.equal(tracked.designSources?.tokens?.path, 'src/theme.css');
  });

  it('skips an oversized file', () => {
    const dir = makeRepo('moag-design-src5-', { 'src/theme.css': ':root{--x:1px}' + ' '.repeat(9_000), 'DESIGN.md': 'x'.repeat(13_000) });
    const found = detectDesignSources(dir);
    assert.equal(found.tokens, null);
    assert.equal(found.doc, null);
    assert.deepEqual(found.notAdopted, [
      { path: 'src/theme.css', reason: 'larger than 8000 characters' },
      { path: 'DESIGN.md', reason: 'larger than 12000 characters' },
    ]);
  });

  it('never throws, even when present() throws', () => {
    assert.deepEqual(detectDesignSources('/nope', () => { throw new Error('boom'); }), { tokens: null, doc: null, ui: null });
  });
});
