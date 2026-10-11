// ─── Deterministic evidence gates — failure paths first ───

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  captureBaseRef,
  captureHeadRef,
  checkArtifacts,
  collectDiffEvidence,
  collectStandardsInput,
  describeGateLine,
  detectPrdFile,
  DiffEvidence,
  EMPTY_TREE_REF,
  GateResult,
  gatesForStoredReport,
  HIDDEN_FROM_GIT,
  readDesignFiles,
  readWorkspacePackages,
  resolveGateCommands,
  resolveUatGate,
  runGate,
  summarizeEvidence,
} from '../../../runner/evidence';
import { BUILT_IN_PROFILES } from '../../../standards/built-in-profiles';
import { checkStandards, StandardsCheckInput, standardsBlocked, standardsBlockingState } from '../../../standards/checker';
import { StandardsProfile } from '../../../standards/profile';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A signal that counts its listeners so we can prove they are removed. */
function countingSignal(): { signal: AbortSignal; count: () => number; abort: () => void } {
  const listeners = new Set<(...args: unknown[]) => void>();
  const fake = {
    aborted: false,
    addEventListener: (_type: string, fn: (...args: unknown[]) => void) => { listeners.add(fn); },
    removeEventListener: (_type: string, fn: (...args: unknown[]) => void) => { listeners.delete(fn); },
  };
  return {
    signal: fake as unknown as AbortSignal,
    count: () => listeners.size,
    abort: () => {
      fake.aborted = true;
      for (const fn of [...listeners]) { fn(); }
    },
  };
}

const SLEEP_CMD = process.platform === 'win32'
  ? 'ping -n 30 127.0.0.1 > nul'
  : 'sleep 30';

describe('evidence — diff collection', () => {
  it('returns empty evidence and does not throw when baseRef is null', async () => {
    const ev = await collectDiffEvidence(process.cwd(), null, { maxDiffChars: 1000 });
    assert.equal(ev.baseRef, null);
    assert.deepEqual(ev.changedFiles, []);
    assert.equal(ev.diffStat, '');
    assert.equal(ev.unifiedDiff, '');
    assert.equal(ev.truncated, false);
  });

  it('returns empty evidence rather than propagating when git exits non-zero', async function () {
    this.timeout(15_000); // three git invocations on a cold Windows path
    // A bare temp dir is not a repository, so every git call exits non-zero.
    const dir = makeTempDir('moag-nogit-');
    let ev: DiffEvidence;
    try {
      ev = await collectDiffEvidence(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', { maxDiffChars: 1000 });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.deepEqual(ev.changedFiles, []);
    assert.equal(ev.unifiedDiff, '');
    assert.equal(ev.truncated, false);
  });

  it('captureBaseRef resolves null (never throws) outside a repository', async function () {
    this.timeout(15_000);
    const dir = makeTempDir('moag-baseref-');
    let ref: string | null;
    try {
      ref = await captureBaseRef(dir);
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(ref, null);
  });

  // Regression: `git diff` cannot see untracked files, so an agent that CREATES
  // files — the most common success case — used to report zero changed files and
  // fail the change gate with "the work was not performed".
  it('counts newly created untracked files as changes', async function () {
    this.timeout(20_000);
    const dir = makeTempDir('moag-untracked-');
    let ev: DiffEvidence;
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

      // The agent's work: a brand-new, never-tracked file.
      fs.writeFileSync(path.join(dir, 'greet.js'), 'module.exports = () => "hi";\n');

      const ref = await captureBaseRef(dir);
      ev = await collectDiffEvidence(dir, ref, { maxDiffChars: 5000 });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.ok(ev.changedFiles.includes('greet.js'), `expected greet.js in ${JSON.stringify(ev.changedFiles)}`);
  });

  // Regression: MOAG writes its own state and reports under .moag/. Counting those
  // would let the change gate pass on MOAG's own output when the agent did nothing.
  it('excludes MOAG\'s own .moag/ output from the changed-file evidence', async function () {
    this.timeout(20_000);
    const dir = makeTempDir('moag-selfoutput-');
    let ev: DiffEvidence;
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

      // Only MOAG's own writes — the agent produced nothing.
      fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.moag', 'verification-1.json'), '{}');
      fs.writeFileSync(path.join(dir, '.moag', 'headless-state.json'), '{}');

      const ref = await captureBaseRef(dir);
      ev = await collectDiffEvidence(dir, ref, { maxDiffChars: 5000 });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.deepEqual(ev.changedFiles, [], `MOAG output must not count as evidence: ${JSON.stringify(ev.changedFiles)}`);
  });
});

describe('evidence — standards input', () => {
  /** A committed repo with one tracked file; resolves the HEAD it captured. */
  function seedRepo(dir: string, files: Record<string, string>): void {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  }

  function fileOf(input: StandardsCheckInput, rel: string): StandardsCheckInput['files'][number] {
    const found = input.files.find((f) => f.path === rel);
    assert.ok(found, `expected ${rel} in ${JSON.stringify(input.files.map((f) => f.path))}`);
    return found;
  }

  it('returns an empty input with a null base outside a repository, without throwing', async function () {
    this.timeout(15_000);
    const dir = makeTempDir('moag-std-nogit-');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};\n');
    let input: StandardsCheckInput;
    let head: string | null;
    try {
      head = await captureHeadRef(dir);
      input = await collectStandardsInput(dir, head, { probeDirs: ['src', 'missing'] });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(head, null);
    // `src` is on disk, but with no listing from git no directory is known to exist: the
    // checker then reports the required-directories rule as not checked, not as a finding.
    assert.deepEqual(input, { baseRef: null, files: [], existingDirs: [], topLevel: [], goModulePath: null });
  });

  it('designPaths: reads each design file, marks a missing one, skips an oversized one — even with no diff', async function () {
    this.timeout(15_000);
    const dir = makeTempDir('moag-std-design-');
    fs.mkdirSync(path.join(dir, 'docs', 'design'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'css'));
    fs.writeFileSync(path.join(dir, 'docs', 'design', 'DESIGN.md'), '# Design\r\n');
    fs.writeFileSync(path.join(dir, 'css', 'big.css'), 'x'.repeat(600 * 1024));
    let input: StandardsCheckInput;
    try {
      input = await collectStandardsInput(dir, null, { designPaths: ['docs/design/DESIGN.md', 'css/tokens.css', 'css/big.css'] });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(input.baseRef, null);
    assert.deepEqual(input.designFiles, [
      { path: 'docs/design/DESIGN.md', content: '# Design\r\n' },
      { path: 'css/tokens.css', content: null, missing: true },
      { path: 'css/big.css', content: null, skipped: 'File is larger than 512 KB' },
    ]);
    // Without designPaths nothing about them is said.
    assert.equal('designFiles' in (await collectStandardsInput(dir, null)), false);
  });

  it('readDesignFiles refuses a path outside the workspace and a directory', () => {
    const dir = makeTempDir('moag-std-design2-');
    fs.mkdirSync(path.join(dir, 'tokens.css'));
    assert.deepEqual(readDesignFiles(dir, ['../outside.css', 'tokens.css']).map((f) => [f.content, f.skipped ?? (f.missing ? 'missing' : '')]), [
      [null, 'Path is outside the workspace'],
      [null, 'Not a regular file'],
    ]);
  });

  // The case a stash base misses: `git stash create` snapshots the working tree, so a
  // diff against it shows no tracked change. HEAD is the base the standards gate needs.
  it('sees a tracked modification with the exact added line numbers', async function () {
    this.timeout(30_000);
    const dir = makeTempDir('moag-std-tracked-');
    let input: StandardsCheckInput;
    let head: string | null;
    let stashView: DiffEvidence;
    try {
      seedRepo(dir, { 'src/a.ts': 'const one = 1;\nconst two = 2;\nconst three = 3;\n', 'README.md': '# seed\n' });
      head = await captureHeadRef(dir);
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'),
        'const one = 1;\n// inserted();\nconst two = 2;\nconst three = 33;\n+++ b/README.md\nconst tail = 4;\n');
      input = await collectStandardsInput(dir, head, { probeDirs: ['src'] });
      stashView = await collectDiffEvidence(dir, await captureBaseRef(dir), { maxDiffChars: 5000 });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.match(head ?? '', /^[0-9a-f]{40}$/);
    assert.equal(input.baseRef, head);
    assert.deepEqual(input.files.map((f) => f.path), ['src/a.ts']);
    const file = fileOf(input, 'src/a.ts');
    assert.equal(file.status, 'modified');
    assert.deepEqual(file.addedLines, [2, 4, 5, 6], 'a line that looks like a patch header is still just an added line');
    assert.ok(file.content?.includes('// inserted();'));
    assert.deepEqual(input.existingDirs, ['src']);
    assert.deepEqual(input.topLevel.sort(), ['README.md', 'src']);
    assert.deepEqual(stashView.changedFiles, [], 'the stash base really does miss this change');
  });

  it('reports an untracked file as added with every line, and a staged new file as added', async function () {
    this.timeout(30_000);
    const dir = makeTempDir('moag-std-untracked-');
    let input: StandardsCheckInput;
    try {
      seedRepo(dir, { 'README.md': '# seed\n' });
      const head = await captureHeadRef(dir);
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib', 'new file.js'), 'const a = 1;\nconst b = 2;\nmodule.exports = a + b;\n');
      fs.writeFileSync(path.join(dir, 'staged.js'), 'one();\ntwo();');
      execFileSync('git', ['add', 'staged.js'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'empty.js'), '');
      input = await collectStandardsInput(dir, head);
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    const untracked = fileOf(input, 'lib/new file.js');
    assert.equal(untracked.status, 'added');
    assert.deepEqual(untracked.addedLines, [1, 2, 3]);
    const staged = fileOf(input, 'staged.js');
    assert.equal(staged.status, 'added');
    assert.deepEqual(staged.addedLines, [1, 2]);
    assert.deepEqual(fileOf(input, 'empty.js').addedLines, []);
    assert.deepEqual(input.topLevel, ['README.md'], 'only what existed at the base');
  });

  it('skips an oversize file and a binary file, saying why, and leaves deletions out', async function () {
    this.timeout(30_000);
    const dir = makeTempDir('moag-std-skipped-');
    let input: StandardsCheckInput;
    try {
      seedRepo(dir, { 'README.md': '# seed\n', 'gone.js': 'bye();\n' });
      const head = await captureHeadRef(dir);
      fs.writeFileSync(path.join(dir, 'big.ts'), `// ${'x'.repeat(513 * 1024)}\n`);
      fs.writeFileSync(path.join(dir, 'blob.ts'), Buffer.from([0x63, 0x6f, 0x00, 0x6e, 0x73, 0x74]));
      fs.rmSync(path.join(dir, 'gone.js'));
      input = await collectStandardsInput(dir, head);
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.deepEqual(input.files.map((f) => f.path), ['big.ts', 'blob.ts']);
    assert.deepEqual(fileOf(input, 'big.ts'), { path: 'big.ts', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' });
    assert.deepEqual(fileOf(input, 'blob.ts'), { path: 'blob.ts', status: 'added', addedLines: [], content: null, skipped: 'Binary content' });
  });

  it('excludes .moag/ and honours .gitignore', async function () {
    this.timeout(30_000);
    const dir = makeTempDir('moag-std-own-');
    let input: StandardsCheckInput;
    try {
      seedRepo(dir, { 'README.md': '# seed\n', '.gitignore': 'node_modules/\n' });
      const head = await captureHeadRef(dir);
      fs.mkdirSync(path.join(dir, '.moag'));
      fs.writeFileSync(path.join(dir, '.moag', 'standards.json'), '{}');
      fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), '// x\n');
      fs.writeFileSync(path.join(dir, 'real.js'), 'work();\n');
      input = await collectStandardsInput(dir, head);
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.deepEqual(input.files.map((f) => f.path), ['real.js']);
  });

  it('diffs against the empty tree when there is no commit yet, so every file is added', async function () {
    this.timeout(30_000);
    const dir = makeTempDir('moag-std-empty-');
    let input: StandardsCheckInput;
    let head: string | null;
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
      fs.mkdirSync(path.join(dir, 'cmd'));
      fs.writeFileSync(path.join(dir, 'cmd', 'main.go'), 'package main\n\nfunc main() {}\n');
      head = await captureHeadRef(dir);
      input = await collectStandardsInput(dir, head, { probeDirs: ['cmd', 'internal'] });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(head, null, 'a repository with no commits has no HEAD');
    assert.equal(input.baseRef, EMPTY_TREE_REF);
    assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines.length]), [['cmd/main.go', 'added', 3], ['go.mod', 'added', 3]]);
    assert.deepEqual(input.topLevel, []);
    assert.deepEqual(input.existingDirs, ['cmd']);
    assert.equal(input.goModulePath, 'example.com/app');
  });

  it('reports the diff as unavailable for a ref shaped like an option', async function () {
    this.timeout(30_000);
    const dir = makeTempDir('moag-std-badref-');
    let option: StandardsCheckInput;
    try {
      seedRepo(dir, { 'README.md': '# seed\n' });
      fs.writeFileSync(path.join(dir, 'new.js'), 'work();\n');
      option = await collectStandardsInput(dir, '--output=pwned.txt');
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(option.baseRef, null);
    assert.deepEqual(option.files, []);
    assert.ok(!fs.existsSync(path.join(dir, 'pwned.txt')), 'the ref never reached git as an option');
  });

  // A recorded base the repository can no longer resolve must not turn the gate off.
  describe('a recorded base the repository no longer has', () => {
    const VIOLATING = 'export const live = 1;\n// const cached = cache.get(id);\n// rest of the code goes here\n';

    it('fails closed for an unknown commit id: the diff is taken against the empty tree, so every file is judged', async function () {
      this.timeout(30_000);
      const dir = makeTempDir('moag-std-unknownbase-');
      let input: StandardsCheckInput;
      try {
        seedRepo(dir, { 'README.md': '# seed\n', 'src/old.ts': 'export const old = 1;\n' });
        fs.mkdirSync(path.join(dir, 'src', 'domain'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'domain', 'extra.ts'), VIOLATING);
        input = await collectStandardsInput(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      assert.equal(input.baseRef, EMPTY_TREE_REF, 'the base actually used is reported, and it is not the one asked for');
      assert.deepEqual(input.files.map((f) => [f.path, f.status]), [['README.md', 'added'], ['src/domain/extra.ts', 'added'], ['src/old.ts', 'added']]);
      const profile = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as StandardsProfile;
      const report = checkStandards(profile, input);
      // This profile has no command and promotes nothing: no blocking set, and nothing left unevaluated.
      assert.equal(standardsBlockingState(report), 'none-configured');
      assert.deepEqual(report.findings.map((f) => `${f.file}:${f.line} ${f.rule}`), [
        'src/domain/extra.ts:2 comment-policy/commented-out-code',
        'src/domain/extra.ts:3 comment-policy/banned-phrase',
      ]);
    });

    it('fails closed after the base commit is orphaned and pruned with plain git', async function () {
      this.timeout(60_000);
      const dir = makeTempDir('moag-std-prunedbase-');
      let input: StandardsCheckInput;
      let base: string | null;
      try {
        seedRepo(dir, { 'README.md': '# seed\n', 'src/old.ts': 'export const old = 1;\n' });
        base = await captureHeadRef(dir);
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
        const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); };
        git('checkout', '-q', '--orphan', 'fresh');
        git('add', '-A');
        git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'fresh');
        git('branch', '-D', branch);
        git('reflog', 'expire', '--expire=now', '--all');
        git('gc', '-q', '--prune=now');
        fs.mkdirSync(path.join(dir, 'src', 'domain'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'domain', 'extra.ts'), VIOLATING);
        input = await collectStandardsInput(dir, base);
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      assert.ok(base, 'the seed commit existed');
      assert.equal(input.baseRef, EMPTY_TREE_REF);
      const profile = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as StandardsProfile;
      const report = checkStandards(profile, input);
      assert.equal(report.rules.find((r) => r.rule === 'comment-policy/commented-out-code')!.result, 'failed');
      assert.deepEqual(report.findings.map((f) => `${f.file}:${f.line}`), ['src/domain/extra.ts:2', 'src/domain/extra.ts:3']);
    });

    it('stays unavailable outside a repository, whatever base was recorded', async function () {
      this.timeout(30_000);
      const dir = makeTempDir('moag-std-norepo-base-');
      let input: StandardsCheckInput;
      try {
        fs.writeFileSync(path.join(dir, 'a.ts'), VIOLATING);
        input = await collectStandardsInput(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      assert.equal(input.baseRef, null);
      assert.deepEqual(input.files, []);
    });
  });

  // Git state that leaves no trace in the repository must not hide a file from the check.
  describe('git state that hides files without a trace', () => {
    const VIOLATING = 'export const live = 1;\n// const cached = cache.get(id);\n// rest of the code goes here\n';
    const commentRules = ['comment-policy/commented-out-code', 'comment-policy/banned-phrase', 'comment-policy/density'] as const;
    const check = (input: StandardsCheckInput) => checkStandards(JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as StandardsProfile, input);

    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      it(`a tracked file marked ${flag} is listed as changed and unread: its rules are not-checked, never passed`, async function () {
        this.timeout(30_000);
        const dir = makeTempDir('moag-std-hidden-index-');
        let input: StandardsCheckInput;
        let porcelain: string;
        try {
          seedRepo(dir, { 'README.md': '# seed\n', 'src/hidden.ts': 'export const live = 1;\n', 'src/clean.ts': 'export const a = 1;\n' });
          const head = await captureHeadRef(dir);
          execFileSync('git', ['update-index', flag, 'src/hidden.ts'], { cwd: dir });
          fs.writeFileSync(path.join(dir, 'src', 'hidden.ts'), VIOLATING);
          fs.writeFileSync(path.join(dir, 'src', 'clean.ts'), 'export const a = 1;\nexport const b = 2;\n');
          porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
          input = await collectStandardsInput(dir, head);
        } catch (err) {
          if (isSpawnEperm(err)) { this.skip(); return; }
          throw err;
        }
        assert.ok(!porcelain.includes('hidden.ts'), 'git itself shows nothing for the file');
        assert.deepEqual(input.files.map((f) => f.path), ['src/clean.ts', 'src/hidden.ts']);
        assert.deepEqual(fileOf(input, 'src/hidden.ts'), { path: 'src/hidden.ts', status: 'modified', addedLines: [], content: null, skipped: HIDDEN_FROM_GIT });
        const report = check(input);
        for (const rule of commentRules) {
          const row = report.rules.find((r) => r.rule === rule)!;
          assert.equal(row.result, 'not-checked', rule);
          assert.ok((row.reason ?? '').includes('src/hidden.ts'), `${rule} names the file`);
        }
      });
    }

    it('a flagged file whose content never changed is still undecided, and one that is not on disk is left out', async function () {
      this.timeout(30_000);
      const dir = makeTempDir('moag-std-hidden-absent-');
      let input: StandardsCheckInput;
      try {
        seedRepo(dir, { 'README.md': '# seed\n', 'src/kept.ts': 'export const a = 1;\n', 'src/sparse.ts': 'export const b = 1;\n' });
        const head = await captureHeadRef(dir);
        execFileSync('git', ['update-index', '--skip-worktree', 'src/kept.ts', 'src/sparse.ts'], { cwd: dir });
        fs.rmSync(path.join(dir, 'src', 'sparse.ts'));
        input = await collectStandardsInput(dir, head);
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      assert.deepEqual(input.files.map((f) => [f.path, f.skipped]), [['src/kept.ts', HIDDEN_FROM_GIT]]);
    });

    it('a new file listed in .git/info/exclude is still seen, read and judged', async function () {
      this.timeout(30_000);
      const dir = makeTempDir('moag-std-hidden-exclude-');
      let input: StandardsCheckInput;
      let porcelain: string;
      try {
        seedRepo(dir, { 'README.md': '# seed\n', '.gitignore': 'node_modules/\n' });
        const head = await captureHeadRef(dir);
        fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
        fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\nsrc/secret.ts\n');
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'secret.ts'), VIOLATING);
        fs.writeFileSync(path.join(dir, 'src', 'clean.ts'), 'export const a = 1;\n');
        fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), VIOLATING);
        porcelain = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir }).toString();
        input = await collectStandardsInput(dir, head);
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      assert.ok(!porcelain.includes('secret.ts'), 'git status hides the file');
      assert.deepEqual(input.files.map((f) => f.path), ['src/clean.ts', 'src/secret.ts'], '.gitignore is still honoured');
      const report = check(input);
      assert.deepEqual(report.findings.map((f) => `${f.file}:${f.line} ${f.rule}`), [
        'src/secret.ts:2 comment-policy/commented-out-code',
        'src/secret.ts:3 comment-policy/banned-phrase',
      ]);
    });

    it('a global excludes file does not hide a new file either', async function () {
      this.timeout(30_000);
      const dir = makeTempDir('moag-std-hidden-global-');
      let input: StandardsCheckInput;
      try {
        seedRepo(dir, { 'README.md': '# seed\n' });
        const head = await captureHeadRef(dir);
        const excludes = path.join(dir, '.git', 'my-excludes');
        fs.writeFileSync(excludes, 'secret.ts\n');
        execFileSync('git', ['config', 'core.excludesFile', excludes], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'secret.ts'), VIOLATING);
        input = await collectStandardsInput(dir, head);
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      assert.deepEqual(input.files.map((f) => f.path), ['secret.ts']);
      assert.equal(check(input).findings.length, 2);
    });
  });

  // The party being checked can write to the repository. A `-diff` attribute makes plain
  // `git diff` print no hunks, which used to read as "no lines added" and pass every rule.
  describe('a repository that tells git not to render its diff', () => {
    const VIOLATING = 'const live = 1;\n// const dead = compute(live);\n// ... rest of the code ...\nmodule.exports = live;\n';
    const lineRules = ['comment-policy/commented-out-code', 'comment-policy/banned-phrase'] as const;

    it('still sees a staged added file under `*.js -diff`, and the rules fail as they would without it', async function () {
      this.timeout(30_000);
      const dir = makeTempDir('moag-std-attr-added-');
      let input: StandardsCheckInput;
      try {
        seedRepo(dir, { 'README.md': '# seed\n' });
        const head = await captureHeadRef(dir);
        fs.writeFileSync(path.join(dir, '.gitattributes'), '*.js -diff\n');
        fs.writeFileSync(path.join(dir, 'attack.js'), VIOLATING);
        execFileSync('git', ['add', '-A'], { cwd: dir });
        input = await collectStandardsInput(dir, head);
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      const file = fileOf(input, 'attack.js');
      assert.deepEqual([file.status, file.addedLines, file.skipped], ['added', [1, 2, 3, 4], undefined]);
      const report = checkStandards(BUILT_IN_PROFILES.other, input);
      for (const rule of lineRules) { assert.equal(report.rules.find((r) => r.rule === rule)?.result, 'failed', rule); }
      assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [
        ['attack.js', 2, 'comment-policy/commented-out-code'],
        ['attack.js', 3, 'comment-policy/banned-phrase'],
      ]);
    });

    it('still sees the added lines of a modified tracked file under `-diff`, staged and after the agent commits the attribute', async function () {
      this.timeout(30_000);
      const dir = makeTempDir('moag-std-attr-modified-');
      let staged: StandardsCheckInput;
      let binary: StandardsCheckInput;
      try {
        seedRepo(dir, { 'src/a.js': 'const live = 1;\nmodule.exports = live;\n' });
        const head = await captureHeadRef(dir);
        fs.writeFileSync(path.join(dir, '.gitattributes'), '*.js -diff\n');
        fs.writeFileSync(path.join(dir, 'src', 'a.js'), VIOLATING);
        execFileSync('git', ['add', '-A'], { cwd: dir });
        staged = await collectStandardsInput(dir, head);
        // The same with the `binary` macro, which also unsets `diff`.
        fs.writeFileSync(path.join(dir, '.gitattributes'), '*.js binary\n');
        binary = await collectStandardsInput(dir, head);
      } catch (err) {
        if (isSpawnEperm(err)) { this.skip(); return; }
        throw err;
      }
      for (const input of [staged, binary]) {
        const file = fileOf(input, 'src/a.js');
        assert.deepEqual([file.status, file.addedLines, file.skipped], ['modified', [2, 3], undefined]);
        const report = checkStandards(BUILT_IN_PROFILES.other, input);
        for (const rule of lineRules) { assert.equal(report.rules.find((r) => r.rule === rule)?.result, 'failed', rule); }
      }
    });

    /** `collectStandardsInput` over a scripted git: each call is answered by the first matching argument. */
    async function collectWithGit(dir: string, answers: Array<[string, string]>): Promise<{ input: StandardsCheckInput; calls: string[][] }> {
      const { EventEmitter } = require('events');
      const calls: string[][] = [];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pq = require('proxyquire').noCallThru();
      const mod = pq('../../../runner/evidence', {
        child_process: {
          spawn: (_cmd: string, args: string[]) => {
            calls.push(args);
            const proc = new EventEmitter() as NodeJS.EventEmitter & { stdout: NodeJS.EventEmitter; stderr: NodeJS.EventEmitter };
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            const out = answers.find(([arg]) => args.includes(arg))?.[1] ?? '';
            setImmediate(() => { proc.stdout.emit('data', Buffer.from(out)); proc.emit('close', 0); });
            return proc;
          },
          execSync: () => Buffer.from(''),
        },
      });
      const input = await mod.collectStandardsInput(dir, 'a'.repeat(40)) as StandardsCheckInput;
      return { input, calls };
    }

    it('asks git for the patch with --text and --no-textconv', async () => {
      const { calls } = await collectWithGit(makeTempDir('moag-std-flags-'), []);
      const patch = calls.find((args) => args.includes('--unified=0'));
      assert.ok(patch, 'the patch was requested');
      for (const flag of ['--text', '--no-textconv', '--no-ext-diff']) { assert.ok(patch.includes(flag), flag); }
    });

    it('a changed file with content but no rendered hunk is skipped: every line-based rule is not-checked, never passed', async () => {
      const dir = makeTempDir('moag-std-nohunk-');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.js'), VIOLATING);
      fs.writeFileSync(path.join(dir, 'new.js'), VIOLATING);
      // Git lists both as changed, and the patch says nothing about either.
      const { input } = await collectWithGit(dir, [
        ['--name-status', 'M\0src/a.js\0A\0new.js\0'],
        ['--unified=0', 'diff --git a/new.js b/new.js\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/new.js differ\n'],
      ]);
      const reason = 'Git rendered no diff for this changed file, so its added lines are unknown';
      assert.deepEqual(input.files, [
        { path: 'new.js', status: 'added', addedLines: [], content: null, skipped: reason },
        { path: 'src/a.js', status: 'modified', addedLines: [], content: null, skipped: reason },
      ]);
      const report = checkStandards(BUILT_IN_PROFILES.other, input);
      for (const rule of [...lineRules, 'comment-policy/density'] as const) {
        const row = report.rules.find((r) => r.rule === rule);
        assert.equal(row?.result, 'not-checked', rule);
        assert.match(row?.reason ?? '', /Git rendered no diff for this changed file/, rule);
      }
      // "No nested repository" passes and the marker scan found no marker; neither says anything
      // about what the files hold, and both files are listed as not checked.
      assert.deepEqual(report.rules.filter((r) => r.result === 'passed').map((r) => r.rule), ['structure/nested-repository', 'exemption/newly-generated']);
      assert.deepEqual(report.notCheckedFiles, [{ file: 'new.js', reason }, { file: 'src/a.js', reason }]);
      assert.equal(report.totals.notCheckedFiles, 2);
      assert.equal(report.totals.blockingNotChecked, 0, 'no line rule blocks by default');
    });

    it('does not skip what really has nothing to render: a mode-only change, a deletion-only edit, an empty new file', async () => {
      const dir = makeTempDir('moag-std-quiet-');
      fs.writeFileSync(path.join(dir, 'run.js'), 'run();\n');
      fs.writeFileSync(path.join(dir, 'trimmed.js'), 'keep();\n');
      fs.writeFileSync(path.join(dir, 'empty.js'), '');
      const { input } = await collectWithGit(dir, [
        ['--name-status', 'M\0run.js\0M\0trimmed.js\0A\0empty.js\0'],
        ['--unified=0', [
          'diff --git a/empty.js b/empty.js', 'new file mode 100644', 'index 0000000..e69de29',
          'diff --git a/run.js b/run.js', 'old mode 100644', 'new mode 100755',
          'diff --git a/trimmed.js b/trimmed.js', 'index 1111111..2222222 100644', '--- a/trimmed.js', '+++ b/trimmed.js',
          '@@ -2 +1,0 @@', '-gone();', '',
        ].join('\n')],
      ]);
      assert.deepEqual(input.files.map((f) => [f.path, f.addedLines, f.skipped, f.content === null]), [
        ['empty.js', [], undefined, false],
        ['run.js', [], undefined, false],
        ['trimmed.js', [], undefined, false],
      ]);
    });
  });

  it('feeds the checker: commented-out code added to a tracked file is found at its line', async function () {
    this.timeout(30_000);
    const dir = makeTempDir('moag-std-e2e-');
    let input: StandardsCheckInput;
    try {
      seedRepo(dir, { 'src/a.ts': 'const one = 1;\n// legacyCall(one);\nexport default one;\n' });
      const head = await captureHeadRef(dir);
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'const one = 1;\n// legacyCall(one);\n// freshCall(one);\nexport default one;\n');
      input = await collectStandardsInput(dir, head);
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    const report = checkStandards(BUILT_IN_PROFILES.other, input);
    assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [['src/a.ts', 3, 'comment-policy/commented-out-code']]);
  });
});

// Real repositories throughout: each of these is a fact about what git reports, and a
// scripted git would only prove what the script says.
describe('evidence — standards input: what a plain diff gets wrong', () => {
  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  }

  function seedRepo(dir: string, files: Record<string, string>): string {
    git(dir, 'init', '-q', '.');
    git(dir, 'config', 'user.email', 't@t.t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    write(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    return git(dir, 'rev-parse', 'HEAD').trim();
  }

  function write(dir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
  }

  /**
   * The comment policy with the placeholder-phrase and layering scans PROMOTED to blocking.
   * Both are advisory by default; these tests are about what the collector lets a blocking
   * rule see, so they hold the rules the way a project that promoted them would.
   */
  function commentPolicy(): StandardsProfile {
    const p = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as StandardsProfile;
    p.severity = { 'comment-policy/banned-phrase': 'blocking', 'layering/imports': 'blocking' };
    return p;
  }

  /** Run `body`, skipping the test where the sandbox cannot spawn git. */
  async function withGit(ctx: Mocha.Context, body: () => Promise<void>): Promise<void> {
    ctx.timeout(60_000);
    try {
      await body();
    } catch (err) {
      if (isSpawnEperm(err)) { ctx.skip(); return; }
      throw err;
    }
  }

  const LEGACY = 'export const one = 1;\n// legacyCall(one);\n// ... rest of the code ...\nexport const two = 2;\n';

  describe('a nested git repository', () => {
    /** Make `rel` inside `dir` a repository of its own with one commit. */
    function innerRepo(dir: string, rel: string): void {
      const at = path.join(dir, ...rel.split('/'));
      git(at, 'init', '-q', '.');
      git(at, 'config', 'user.email', 't@t.t');
      git(at, 'config', 'user.name', 't');
      git(at, 'add', '-A');
      git(at, 'commit', '-qm', 'inner');
    }
    const nestedRule = (input: StandardsCheckInput, profile: StandardsProfile = commentPolicy()) => {
      const report = checkStandards(profile, input);
      return { report, row: report.rules.find((r) => r.rule === 'structure/nested-repository') };
    };
    const NESTED = 'nested repository — files inside were not read';
    const SUBMODULE = 'submodule — files inside were not read';

    it('an untracked directory that is its own repository is a finding and is listed as not checked, never read past', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-nested-');
        const head = seedRepo(dir, { 'src/a.ts': 'export const a = 1;\n' });
        // What `git clone` or `git init` inside the workspace leaves behind.
        write(dir, { 'cloned/bad.ts': '// ... rest of the code ...\n', 'cloned/deep/worse.ts': '// oldCall();\n' });
        git(path.join(dir, 'cloned'), 'init', '-q', '.');
        write(dir, { 'src/b.ts': 'export const b = 2;\n' });

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.nestedRepos, ['cloned']);
        assert.deepEqual(input.submodules, []);
        assert.deepEqual(input.files.map((f) => f.path), ['src/b.ts'], 'the directory is not passed off as a file');

        const { report, row } = nestedRule(input);
        assert.equal(row?.result, 'failed');
        assert.equal(row?.severity, 'advisory', 'a scan MOAG makes itself: advisory unless a project promotes it');
        assert.deepEqual(report.findings.map((f) => [f.file, f.rule]), [['cloned', 'structure/nested-repository']]);
        assert.deepEqual(report.notCheckedFiles, [{ file: 'cloned', reason: NESTED }]);
        assert.equal(standardsBlocked(report), false);

        const promoted = commentPolicy();
        promoted.severity = { ...promoted.severity, 'structure/nested-repository': 'blocking' };
        assert.equal(standardsBlocked(checkStandards(promoted, input)), true, 'promoted, it stops the release');
      });
    });

    it('finds one below the top level, one with commits of its own, and an empty one', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-nested-deep-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'tools/gen/repo/y.ts': 'export const y = 1;\n', 'tools/gen/z.ts': 'export const z = 1;\n' });
        innerRepo(dir, 'tools/gen/repo');
        fs.mkdirSync(path.join(dir, 'empty-repo'));
        git(path.join(dir, 'empty-repo'), 'init', '-q', '.');

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.nestedRepos, ['empty-repo', 'tools/gen/repo']);
        assert.deepEqual(input.files.map((f) => f.path), ['tools/gen/z.ts']);
      });
    });

    it('an undeclared gitlink is reported by the state of the tree: staged, committed, and long after — whatever the base', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-gitlink-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'vendored/lib/x.ts': '// oldCall();\n' });
        innerRepo(dir, 'vendored/lib');
        execFileSync('git', ['add', 'vendored/lib'], { cwd: dir, stdio: 'ignore' });

        const staged = await collectStandardsInput(dir, head);
        assert.deepEqual(staged.nestedRepos, ['vendored/lib']);
        assert.deepEqual(staged.files, []);

        git(dir, 'commit', '-qm', 'add nested');
        write(dir, { 'src/a.ts': 'export const a = 1;\n' });
        git(dir, 'add', 'src/a.ts');
        git(dir, 'commit', '-qm', 'later work');
        const later = git(dir, 'rev-parse', 'HEAD').trim();

        // The base the gitlink was added after, the commit after it, no base, a base that is
        // gone: the answer is the same, because no base ref enters into it.
        for (const base of [head, later, null, 'f'.repeat(40)]) {
          const input = await collectStandardsInput(dir, base);
          assert.deepEqual(input.nestedRepos, ['vendored/lib'], `base ${base}`);
          assert.ok(!input.files.some((f) => f.path === 'vendored/lib'), 'the gitlink is never listed as a file');
          const { report, row } = nestedRule(input);
          assert.equal(row?.result, 'failed', `base ${base}`);
          assert.deepEqual(report.findings.filter((f) => f.rule === 'structure/nested-repository').map((f) => f.file), ['vendored/lib']);
          assert.ok(report.notCheckedFiles?.some((f) => f.file === 'vendored/lib' && f.reason === NESTED), `base ${base}`);
        }
        // With a degraded base the rest of the tree is still judged: fail closed, every file added.
        assert.ok((await collectStandardsInput(dir, 'f'.repeat(40))).files.some((f) => f.path === 'src/a.ts' && f.status === 'added'));
      });
    });

    it('a submodule a tracked .gitmodules declares is listed as not checked and is no finding', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-submodule-');
        seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'lib/x.ts': 'export const x = 1;\n', 'other/y.ts': 'export const y = 1;\n' });
        innerRepo(dir, 'lib');
        innerRepo(dir, 'other');
        // Declared the way `git submodule add` records it; `other` is a gitlink nobody declared.
        write(dir, { '.gitmodules': '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n' });
        execFileSync('git', ['add', '.gitmodules', 'lib', 'other'], { cwd: dir, stdio: 'ignore' });
        git(dir, 'commit', '-qm', 'add submodule');
        const head = git(dir, 'rev-parse', 'HEAD').trim();

        for (const base of [head, null]) {
          const input = await collectStandardsInput(dir, base);
          assert.deepEqual(input.submodules, ['lib'], `base ${base}`);
          assert.deepEqual(input.nestedRepos, ['other'], `base ${base}`);
          const { report } = nestedRule(input);
          assert.deepEqual(report.findings.filter((f) => f.rule === 'structure/nested-repository').map((f) => f.file), ['other']);
          assert.deepEqual((report.notCheckedFiles ?? []).filter((f) => f.file === 'lib' || f.file === 'other'),
            [{ file: 'lib', reason: SUBMODULE }, { file: 'other', reason: NESTED }]);
        }
      });
    });

    it('a .gitmodules that is not tracked declares nothing: writing one does not make a nested repository a submodule', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-fake-gitmodules-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'lib/x.ts': '// oldCall();\n' });
        innerRepo(dir, 'lib');
        execFileSync('git', ['add', 'lib'], { cwd: dir, stdio: 'ignore' });
        // On disk only — the change under review could have written this a moment ago.
        write(dir, { '.gitmodules': '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n' });

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.nestedRepos, ['lib']);
        assert.deepEqual(input.submodules, []);
        assert.equal(nestedRule(input).row?.result, 'failed');
      });
    });

    it('respects .git/info/exclude and a configured excludes file exactly as git status does', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-nested-excluded-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'scratch/a.ts': 'export const a = 1;\n', 'sandbox/b.ts': 'export const b = 1;\n', 'seen/c.ts': 'export const c = 1;\n' });
        for (const nested of ['scratch', 'sandbox', 'seen']) { git(path.join(dir, nested), 'init', '-q', '.'); }
        fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'scratch/\n');
        const excludes = path.join(makeTempDir('moag-std-excludes-'), 'ignore');
        fs.writeFileSync(excludes, 'sandbox/\n');
        git(dir, 'config', 'core.excludesFile', excludes);

        const status = git(dir, 'status', '--porcelain', '--untracked-files=all');
        assert.doesNotMatch(status, /scratch|sandbox/, 'git status itself does not show them');
        assert.match(status, /seen\//);

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.nestedRepos, ['seen'], 'only the one git status shows');
        assert.deepEqual(input.files, [], 'and none of the three is ever read as files');
      });
    });

    it('a repository with nothing nested reports none: "no findings" about the tree, and an unread file is still listed', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-nonest-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'notes.rs': 'fn main() {}\n' });
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.nestedRepos, []);
        assert.deepEqual(input.submodules, []);
        const report = checkStandards(commentPolicy(), input);
        assert.equal(report.rules.find((r) => r.rule === 'structure/nested-repository')?.result, 'passed');
        assert.deepEqual(report.notCheckedFiles, [{ file: 'notes.rs', reason: 'No checker for .rs files' }], 'the one changed file was read by no line rule, and says so');
      });
    });
  });

  describe('required directories: what git lists, compared exactly', () => {
    it('a tracked directory and an untracked, not ignored one exist; an ignored one and a differently cased one do not', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-dirs-');
        const head = seedRepo(dir, { '.gitignore': 'dist/\n', 'src/a.ts': 'export const a = 1;\n', 'docs/guide/intro.md': '# x\n' });
        write(dir, { 'test/a.test.ts': 'export {};\n', 'dist/out.js': 'var a = 1;\n' });
        fs.mkdirSync(path.join(dir, 'empty'));

        const input = await collectStandardsInput(dir, head, {
          probeDirs: ['src', 'docs/guide', 'test', 'dist', 'empty', 'SRC', 'Docs/guide', 'missing', 'sr'],
        });
        // `dist` and `empty` are on disk, and on a case-insensitive file system so are `SRC` and
        // `Docs/guide`. Git lists none of them.
        assert.deepEqual(input.existingDirs, ['src', 'docs/guide', 'test']);
        for (const onDisk of ['dist', 'empty']) { assert.ok(fs.statSync(path.join(dir, onDisk)).isDirectory(), onDisk); }

        const profile = commentPolicy();
        profile.structure.requiredDirs = ['src', 'SRC', 'dist'];
        const report = checkStandards(profile, input);
        assert.deepEqual(report.findings.filter((f) => f.rule === 'structure/required-dirs').map((f) => f.file).sort(), ['SRC', 'dist']);
        assert.equal(report.rules.find((r) => r.rule === 'structure/required-dirs')?.severity, 'advisory');
      });
    });

    it('a directory that is a submodule or a nested repository exists: git lists it, as one entry', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-dirs-link-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'lib/x.ts': 'export const x = 1;\n' });
        git(path.join(dir, 'lib'), 'init', '-q', '.');
        assert.deepEqual((await collectStandardsInput(dir, head, { probeDirs: ['lib'] })).existingDirs, ['lib']);
      });
    });
  });

  describe('renames', () => {
    it('git mv of a legacy file adds no line: only the new path is judged', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-rename-');
        const head = seedRepo(dir, { 'src/legacy.ts': LEGACY, 'README.md': '# seed\n' });
        fs.mkdirSync(path.join(dir, 'lib'));
        git(dir, 'mv', 'src/legacy.ts', 'lib/LegacyThing.ts');

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.skipped]), [['lib/LegacyThing.ts', 'renamed', [], undefined]]);

        const p = commentPolicy();
        p.naming.files = [{ globs: ['**/*.ts'], style: 'kebab-case' }];
        p.structure.placement = [{ id: 'ts', files: '**/*.ts', under: ['src'] }];
        const report = checkStandards(p, input);
        // The legacy comments came along untouched; the path is what this change chose.
        assert.deepEqual(report.findings.map((f) => [f.file, f.rule]).sort(), [
          ['lib/LegacyThing.ts', 'naming/files'], ['lib/LegacyThing.ts', 'structure/placement'],
        ]);
        for (const rule of ['comment-policy/commented-out-code', 'comment-policy/banned-phrase'] as const) {
          assert.equal(report.rules.find((r) => r.rule === rule)?.result, 'not-checked', rule);
        }
      });
    });

    it('a rename with an edit judges exactly the edited lines, committed or not', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-rename-edit-');
        const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
        const head = seedRepo(dir, { 'src/values.ts': body });
        git(dir, 'mv', 'src/values.ts', 'src/all-values.ts');
        fs.writeFileSync(path.join(dir, 'src', 'all-values.ts'), body + '// oldCall(v1);\n');

        const staged = await collectStandardsInput(dir, head);
        assert.deepEqual(staged.files.map((f) => [f.path, f.status, f.addedLines]), [['src/all-values.ts', 'renamed', [31]]]);

        git(dir, 'add', '-A');
        git(dir, 'commit', '-qm', 'move and edit');
        const committed = await collectStandardsInput(dir, head);
        assert.deepEqual(committed.files.map((f) => [f.path, f.status, f.addedLines]), [['src/all-values.ts', 'renamed', [31]]]);
        const report = checkStandards(commentPolicy(), committed);
        assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [['src/all-values.ts', 31, 'comment-policy/commented-out-code']]);
      });
    });

    it('a plain mv (old path deleted, new path untracked) with identical content is a rename as well', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-plain-mv-');
        const head = seedRepo(dir, { 'src/legacy.ts': LEGACY });
        fs.renameSync(path.join(dir, 'src', 'legacy.ts'), path.join(dir, 'src', 'moved.ts'));
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines]), [['src/moved.ts', 'renamed', []]]);
      });
    });

    // The auto-commit flow: task 1 moves a legacy file and commits, task 2 touches it again.
    // The committed version is listed beside the working tree's, and used to come back as
    // `added` with every legacy line counted as new.
    it('git mv, commit, then an uncommitted edit: the committed version is a rename too, with no legacy line judged', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-mv-commit-edit-');
        const head = seedRepo(dir, { 'src/legacy.ts': LEGACY, 'README.md': '# seed\n' });
        git(dir, 'mv', 'src/legacy.ts', 'src/moved.ts');
        git(dir, 'commit', '-qm', 'task 1: move');
        fs.appendFileSync(path.join(dir, 'src', 'moved.ts'), 'export const three = 3;\n');

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin, f.skipped]), [
          ['src/moved.ts', 'renamed', [5], undefined, undefined],
          ['src/moved.ts', 'renamed', [], 'committed', undefined],
        ]);
        assert.equal(input.files[1].content, LEGACY);
        const report = checkStandards(commentPolicy(), input);
        assert.deepEqual(report.findings, []);
        assert.equal(report.rules.find((r) => r.rule === 'comment-policy/banned-phrase')?.result, 'passed');
        assert.equal(standardsBlocked(report), false);
      });
    });

    it('git mv, commit, then the moved file deleted: still a rename with nothing added', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-mv-commit-delete-');
        const head = seedRepo(dir, { 'src/legacy.ts': LEGACY, 'README.md': '# seed\n' });
        git(dir, 'mv', 'src/legacy.ts', 'src/moved.ts');
        git(dir, 'commit', '-qm', 'task 1: move');
        fs.rmSync(path.join(dir, 'src', 'moved.ts'));

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin, f.skipped]), [
          ['src/moved.ts', 'renamed', [], 'committed', undefined],
        ]);
        const report = checkStandards(commentPolicy(), input);
        assert.deepEqual(report.findings, []);
        assert.equal(standardsBlocked(report), false);
      });
    });

    it('a move committed WITH an edit, then touched again: the committed version judges only the lines that commit added', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-mv-edit-commit-edit-');
        const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
        const head = seedRepo(dir, { 'src/values.ts': body + '// ... rest of the code ...\n' });
        git(dir, 'mv', 'src/values.ts', 'src/all-values.ts');
        fs.appendFileSync(path.join(dir, 'src', 'all-values.ts'), '// ... existing code ...\n');
        git(dir, 'commit', '-qam', 'task 1: move and edit');
        fs.appendFileSync(path.join(dir, 'src', 'all-values.ts'), 'export const last = 1;\n');

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin]), [
          ['src/all-values.ts', 'renamed', [32, 33], undefined],
          ['src/all-values.ts', 'renamed', [32], 'committed'],
        ]);
        const report = checkStandards(commentPolicy(), input);
        // The legacy placeholder on line 31 is nobody's new work; the one this run added is found, in both versions.
        assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [
          ['src/all-values.ts', 32, 'comment-policy/banned-phrase'], ['src/all-values.ts', 32, 'comment-policy/banned-phrase'],
        ]);
      });
    });

    it('a plain mv under core.autocrlf=true (a CRLF checkout of an LF blob) is still a rename', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-plain-mv-crlf-');
        const head = seedRepo(dir, { 'src/legacy.ts': LEGACY });
        // Check the file out again the way Git for Windows does by default: CRLF on disk, LF in the blob.
        git(dir, 'config', 'core.autocrlf', 'true');
        fs.rmSync(path.join(dir, 'src', 'legacy.ts'));
        git(dir, 'checkout', '--', 'src/legacy.ts');
        const onDisk = fs.readFileSync(path.join(dir, 'src', 'legacy.ts'), 'utf-8');
        assert.equal(onDisk, LEGACY.replace(/\n/g, '\r\n'), 'the checkout has CRLF line endings');
        fs.renameSync(path.join(dir, 'src', 'legacy.ts'), path.join(dir, 'src', 'moved.ts'));

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines]), [['src/moved.ts', 'renamed', []]]);
        const report = checkStandards(commentPolicy(), input);
        assert.deepEqual(report.findings, []);
        assert.equal(standardsBlocked(report), false);
      });
    });

    it('a new file that merely resembles nothing is still added, every line of it', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-not-rename-');
        const head = seedRepo(dir, { 'src/legacy.ts': LEGACY });
        fs.rmSync(path.join(dir, 'src', 'legacy.ts'));
        write(dir, { 'src/fresh.ts': 'export const fresh = 1;\n// ... rest of the code ...\n' });
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines]), [['src/fresh.ts', 'added', [1, 2]]]);
        assert.equal(standardsBlocked(checkStandards(commentPolicy(), input)), true);
      });
    });
  });

  describe('work that was committed and then taken out of the working tree', () => {
    const VIOLATION = 'export const a = 1;\n// ... rest of the code ...\n';

    it('a file committed since the base and then deleted without a commit is still judged, from the commit', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-commit-delete-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'src/hidden.ts': VIOLATION });
        git(dir, 'add', '-A');
        git(dir, 'commit', '-qm', 'agent work');
        fs.rmSync(path.join(dir, 'src', 'hidden.ts'));

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files, [
          { path: 'src/hidden.ts', status: 'added', addedLines: [1, 2], content: VIOLATION, origin: 'committed' },
        ]);
        const report = checkStandards(commentPolicy(), input);
        assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [['src/hidden.ts', 2, 'comment-policy/banned-phrase']]);
        assert.match(report.findings[0].message, /in the committed version/);
        assert.equal(standardsBlocked(report), true);
      });
    });

    it('a committed violation "fixed" only in the working tree is judged twice: as committed and as it stands', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-commit-rewrite-');
        const head = seedRepo(dir, { 'src/a.ts': 'export const seed = 0;\n' });
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const seed = 0;\n// ... rest of the code ...\n');
        git(dir, 'commit', '-qam', 'agent work');
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const seed = 0;\nexport const clean = 1;\n');

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin]), [
          ['src/a.ts', 'modified', [2], undefined],
          ['src/a.ts', 'modified', [2], 'committed'],
        ]);
        const report = checkStandards(commentPolicy(), input);
        assert.equal(standardsBlocked(report), true, 'the clean working tree does not clear what was committed');
        assert.deepEqual(report.findings.map((f) => f.rule), ['comment-policy/banned-phrase']);
      });
    });

    it('when the working tree matches the last commit, nothing is listed twice', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-commit-clean-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'src/a.ts': VIOLATION });
        git(dir, 'add', '-A');
        git(dir, 'commit', '-qm', 'agent work');
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.addedLines, f.origin]), [['src/a.ts', [1, 2], undefined]]);
      });
    });

    it('a file that was already deleted at the last commit is simply gone', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-commit-gone-');
        const head = seedRepo(dir, { 'src/old.ts': 'export const old = 1;\n', 'README.md': '# seed\n' });
        git(dir, 'rm', '-q', 'src/old.ts');
        git(dir, 'commit', '-qm', 'remove');
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files, []);
      });
    });
  });

  // `-M` alone is not enough. The repository's own config is writable by the party being
  // checked, and `diff.renameLimit` silently switches inexact rename detection off — after
  // which every moved legacy file is "added" and each of its old lines is judged as new.
  describe('rename detection does not depend on the repository\'s configuration', () => {
    const A = Array.from({ length: 30 }, (_, i) => `export const a${i} = ${i};`).join('\n') + '\n// ... rest of the code ...\n';
    const B = Array.from({ length: 30 }, (_, i) => `export function b${i}() { return ${i}; }`).join('\n') + '\n// ... rest of the code ...\n';

    /** Two legacy files, each moved AND edited, with rename detection turned off and capped in the repository's config. */
    function movedAndEdited(dir: string): string {
      const head = seedRepo(dir, { 'src/legacy-a.ts': A, 'src/legacy-b.ts': B });
      git(dir, 'config', 'diff.renames', 'false');
      git(dir, 'config', 'diff.renameLimit', '1');
      git(dir, 'mv', 'src/legacy-a.ts', 'src/moved-a.ts');
      git(dir, 'mv', 'src/legacy-b.ts', 'src/moved-b.ts');
      fs.appendFileSync(path.join(dir, 'src', 'moved-a.ts'), 'export const lastA = 1;\n');
      fs.appendFileSync(path.join(dir, 'src', 'moved-b.ts'), 'export const lastB = 1;\n');
      return head;
    }

    it('the configuration really does defeat a bare -M: git itself reports the moves as additions', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-renamelimit-probe-');
        const head = movedAndEdited(dir);
        git(dir, 'commit', '-qam', 'task 1: move and edit');
        // What the collector would see without an explicit limit of its own.
        const bare = execFileSync('git', ['diff', '--name-status', '-M', head, 'HEAD'], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        assert.match(bare, /^A\tsrc\/moved-a\.ts$/m);
        assert.match(bare, /^A\tsrc\/moved-b\.ts$/m);
      });
    });

    it('moved, edited and still uncommitted: both files are renames, and only the appended line is new', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-renamelimit-worktree-');
        const head = movedAndEdited(dir);
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin]), [
          ['src/moved-a.ts', 'renamed', [32], undefined],
          ['src/moved-b.ts', 'renamed', [32], undefined],
        ]);
        // The legacy placeholder on line 31 of each is nobody's new work.
        assert.deepEqual(checkStandards(commentPolicy(), input).findings, []);
      });
    });

    it('git mv, edit, COMMIT, then touched again: the committed versions are renames too — not judged as added', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-renamelimit-committed-');
        const head = movedAndEdited(dir);
        git(dir, 'commit', '-qam', 'task 1: move and edit');
        // Task 2 touches one again and deletes the other, without a commit: both committed versions are listed.
        fs.appendFileSync(path.join(dir, 'src', 'moved-a.ts'), 'export const again = 2;\n');
        fs.rmSync(path.join(dir, 'src', 'moved-b.ts'));

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin, f.skipped]), [
          ['src/moved-a.ts', 'renamed', [32, 33], undefined, undefined],
          ['src/moved-a.ts', 'renamed', [32], 'committed', undefined],
          ['src/moved-b.ts', 'renamed', [32], 'committed', undefined],
        ]);
        const report = checkStandards(commentPolicy(), input);
        assert.deepEqual(report.findings, [], 'no legacy line of a moved file is held against this change');
        assert.equal(standardsBlocked(report), false);
        // Had the moves come back as additions, line 31 of each would be a blocking finding.
        const asAdded = checkStandards(commentPolicy(), {
          ...input, files: [{ path: 'src/moved-b.ts', status: 'added', addedLines: Array.from({ length: 32 }, (_, i) => i + 1), content: B + 'export const lastB = 1;\n' }],
        });
        assert.deepEqual(asAdded.findings.map((f) => [f.line, f.rule]), [[31, 'comment-policy/banned-phrase']]);
      });
    });
  });

  // A working-tree diff shows what is on disk. What `git commit` ships is what is in the index.
  describe('content that is staged and no longer in the working tree', () => {
    const VIOLATION = 'export const a = 1;\n// ... rest of the code ...\n';

    it('staged, then deleted from the working tree: judged from the index, and its findings say where they are', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-staged-delete-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'src/hidden.ts': VIOLATION });
        git(dir, 'add', '-A');
        fs.rmSync(path.join(dir, 'src', 'hidden.ts'));
        // Neither the working tree nor any commit holds the file — only the index does.
        assert.equal(git(dir, 'ls-files', '--others', '--exclude-standard').trim(), '');
        assert.equal(git(dir, 'diff', '--name-only', head).trim(), '', 'the working-tree diff does not show it at all');

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files, [
          { path: 'src/hidden.ts', status: 'added', addedLines: [1, 2], content: VIOLATION, origin: 'staged' },
        ]);
        const report = checkStandards(commentPolicy(), input);
        assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [['src/hidden.ts', 2, 'comment-policy/banned-phrase']]);
        assert.match(report.findings[0].message, /in the staged version; the working tree no longer matches it/);
        assert.equal(standardsBlocked(report), true);
      });
    });

    it('a staged violation "fixed" only in the working tree is judged twice: as staged and as it stands', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-staged-rewrite-');
        const head = seedRepo(dir, { 'src/a.ts': 'export const seed = 0;\n' });
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const seed = 0;\n// ... rest of the code ...\n');
        git(dir, 'add', '-A');
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const seed = 0;\nexport const clean = 1;\n');

        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin]), [
          ['src/a.ts', 'modified', [2], undefined],
          ['src/a.ts', 'modified', [2], 'staged'],
        ]);
        const report = checkStandards(commentPolicy(), input);
        assert.equal(standardsBlocked(report), true, 'the clean working tree does not clear what is staged for the next commit');
        assert.deepEqual(report.findings.map((f) => f.rule), ['comment-policy/banned-phrase']);
      });
    });

    it('a staged git mv of a legacy file, then the moved file deleted: a rename with nothing added', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-staged-mv-');
        const head = seedRepo(dir, { 'src/legacy.ts': LEGACY, 'README.md': '# seed\n' });
        git(dir, 'mv', 'src/legacy.ts', 'src/moved.ts');
        fs.rmSync(path.join(dir, 'src', 'moved.ts'));
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin, f.skipped]), [
          ['src/moved.ts', 'renamed', [], 'staged', undefined],
        ]);
        assert.deepEqual(checkStandards(commentPolicy(), input).findings, []);
      });
    });

    it('when the index matches the working tree, or only repeats the last commit, nothing is listed twice', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-staged-clean-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        write(dir, { 'src/a.ts': VIOLATION });
        git(dir, 'add', '-A');
        const staged = await collectStandardsInput(dir, head);
        assert.deepEqual(staged.files.map((f) => [f.path, f.addedLines, f.origin]), [['src/a.ts', [1, 2], undefined]]);

        // Committed, then deleted: the index still holds what HEAD holds, so this is the committed version — once.
        git(dir, 'commit', '-qm', 'agent work');
        fs.rmSync(path.join(dir, 'src', 'a.ts'));
        const committed = await collectStandardsInput(dir, head);
        assert.deepEqual(committed.files.map((f) => [f.path, f.addedLines, f.origin]), [['src/a.ts', [1, 2], 'committed']]);
      });
    });

    it('in a repository with no commit yet, staged-then-deleted content is still judged', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-staged-nocommit-');
        git(dir, 'init', '-q', '.');
        git(dir, 'config', 'core.autocrlf', 'false');
        write(dir, { 'src/hidden.ts': VIOLATION, 'README.md': '# new\n' });
        git(dir, 'add', '-A');
        fs.rmSync(path.join(dir, 'src', 'hidden.ts'));
        const input = await collectStandardsInput(dir, null);
        assert.equal(input.baseRef, EMPTY_TREE_REF);
        assert.deepEqual(input.files.map((f) => [f.path, f.status, f.addedLines, f.origin]), [
          ['README.md', 'added', [1], undefined],
          ['src/hidden.ts', 'added', [1, 2], 'staged'],
        ]);
        assert.equal(standardsBlocked(checkStandards(commentPolicy(), input)), true);
      });
    });
  });

  describe('directories the repository marks as third-party', () => {
    it('lists a node_modules beside a package.json and a vendor beside a go.mod; a bare name is not enough', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-vendor-');
        const head = seedRepo(dir, { 'README.md': '# seed\n' });
        const COMMENTED = 'const a = 1;\n// oldCall(a);\n';
        write(dir, {
          'packages/web/package.json': '{"name":"web"}\n',
          'packages/web/node_modules/dep/index.js': COMMENTED,
          'services/api/go.mod': 'module example.com/api\n',
          'services/api/vendor/dep/dep.go': 'package dep\n\n// x := load()\n',
          'src/vendor/api.js': COMMENTED,
          'src/node_modules/local/index.js': COMMENTED,
        });
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.vendorRoots, ['packages/web/node_modules', 'services/api/vendor']);

        const report = checkStandards(commentPolicy(), input);
        // The two directories with nothing beside them are the project's own code.
        assert.deepEqual(report.findings.map((f) => f.file).sort(), ['src/node_modules/local/index.js', 'src/vendor/api.js']);
      });
    });
  });

  describe('workspace packages', () => {
    function layered(): StandardsProfile {
      const p = commentPolicy();
      p.backend = {
        layers: [{ name: 'web', globs: ['packages/web/**'] }, { name: 'db', globs: ['packages/db/**'] }],
        forbiddenImports: [{ from: 'web', to: 'db' }],
        importAliases: [],
      };
      return p;
    }
    const PAGE = 'import { query } from "@acme/db";\nimport React from "react";\nexport const page = query(React);\n';

    it('reads package.json workspaces, so an import of another layer\'s package is a layering finding', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-ws-');
        const head = seedRepo(dir, {
          'package.json': JSON.stringify({ private: true, workspaces: ['packages/*', 'tools/cli'] }),
          'packages/db/package.json': '{"name":"@acme/db"}',
          'packages/db/src/index.ts': 'export const query = (x: unknown) => x;\n',
          'packages/web/package.json': '{"name":"@acme/web"}',
          'tools/cli/package.json': '{"name":"acme-cli"}',
          'packages/notes/README.md': 'no manifest here\n',
        });
        write(dir, { 'packages/web/src/page.ts': PAGE });
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.workspacePackages, [
          { name: '@acme/db', dir: 'packages/db' }, { name: '@acme/web', dir: 'packages/web' }, { name: 'acme-cli', dir: 'tools/cli' },
        ]);
        const report = checkStandards(layered(), input);
        assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [['packages/web/src/page.ts', 1, 'layering/imports']]);
        assert.equal(standardsBlocked(report), true);
      });
    });

    it('reads pnpm-workspace.yaml and the { packages } form', async function () {
      await withGit(this, async () => {
        const pnpm = makeTempDir('moag-std-ws-pnpm-');
        seedRepo(pnpm, {
          'pnpm-workspace.yaml': 'packages:\n  # apps and libraries\n  - "apps/*"\n  - \'libs/**\'\n  - tools/one\n  - "!**/test/**"\n',
          'apps/site/package.json': '{"name":"site"}',
          'libs/ui/button/package.json': '{"name":"@acme/button"}',
          'libs/core/package.json': '{"name":"@acme/core"}',
          'tools/one/package.json': '{"name":"one"}',
        });
        assert.deepEqual(readWorkspacePackages(pnpm), [
          { name: 'site', dir: 'apps/site' }, { name: '@acme/core', dir: 'libs/core' },
          { name: '@acme/button', dir: 'libs/ui/button' }, { name: 'one', dir: 'tools/one' },
        ]);

        const yarn = makeTempDir('moag-std-ws-yarn-');
        write(yarn, { 'package.json': JSON.stringify({ workspaces: { packages: ['packages/*'] } }), 'packages/a/package.json': '{"name":"a"}' });
        assert.deepEqual(readWorkspacePackages(yarn), [{ name: 'a', dir: 'packages/a' }]);
      });
    });

    it('no workspace declared is an empty list; one that cannot be read is null, and the import is then not-checked', async function () {
      await withGit(this, async () => {
        assert.deepEqual(readWorkspacePackages(makeTempDir('moag-std-ws-none-')), []);

        const plain = makeTempDir('moag-std-ws-plain-');
        write(plain, { 'package.json': '{"name":"app"}' });
        assert.deepEqual(readWorkspacePackages(plain), []);

        for (const [label, files] of Object.entries({
          'unreadable root manifest': { 'package.json': '{ not json' },
          'workspaces of the wrong type': { 'package.json': '{"workspaces":"packages/*"}' },
          'a pattern this reader does not expand': { 'package.json': '{"workspaces":["packages/*-lib"]}' },
          'a member whose manifest is broken': { 'package.json': '{"workspaces":["packages/*"]}', 'packages/a/package.json': '{' },
          'a pnpm file with an inline list': { 'pnpm-workspace.yaml': 'packages: ["apps/*"]\n' },
        } as Record<string, Record<string, string>>)) {
          const dir = makeTempDir('moag-std-ws-bad-');
          write(dir, files);
          assert.equal(readWorkspacePackages(dir), null, label);
        }

        const dir = makeTempDir('moag-std-ws-null-');
        const head = seedRepo(dir, { 'package.json': '{"workspaces":["packages/*-lib"]}', 'packages/db/package.json': '{"name":"@acme/db"}' });
        write(dir, { 'packages/web/src/page.ts': PAGE });
        const input = await collectStandardsInput(dir, head);
        assert.equal(input.workspacePackages, null);
        const row = checkStandards(layered(), input).rules.find((r) => r.rule === 'layering/imports');
        assert.equal(row?.result, 'not-checked');
        assert.equal(row?.undecided, true);
        assert.match(row?.reason ?? '', /Import @acme\/db cannot be mapped to a path/);
      });
    });
  });

  // No workspaces here: scoped `paths` aliases are how Nx, Angular and NestJS repositories import
  // their own code, and the layering rule used to take every one for a published package.
  describe('tsconfig path aliases', () => {
    function layered(): StandardsProfile {
      const p = commentPolicy();
      p.backend = {
        layers: [{ name: 'domain', globs: ['src/domain/**'] }, { name: 'infra', globs: ['src/infra/**'] }],
        forbiddenImports: [{ from: 'domain', to: 'infra' }],
        importAliases: [],
      };
      return p;
    }
    const ORDER = [
      'import { db } from "@infra/db";',
      'import { pool } from "@app/infra/pool";',
      'import { x } from "$lib/infra/x";',
      'import express from "express";',
      '',
    ].join('\n');
    const TSCONFIG = '{\n  // paths, as tsc --init leaves them\n  "compilerOptions": {\n    "paths": { "@infra/*": ["./src/infra/*"], "@app/*": ["./src/*"], "$lib/*": ["./src/*"], },\n  },\n}\n';
    const layeringRow = (input: StandardsCheckInput) => checkStandards(layered(), input).rules.find((r) => r.rule === 'layering/imports');

    it('an import mapped into a forbidden layer by the root tsconfig fails the blocking rule', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-paths-');
        const head = seedRepo(dir, { 'tsconfig.json': TSCONFIG, 'src/infra/db.ts': 'export const db = 1;\n' });
        write(dir, { 'src/domain/order.ts': ORDER });
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.importPathScopes, [{
          dir: '',
          aliases: [
            { pattern: '@infra/*', targets: ['src/infra/*'] }, { pattern: '@app/*', targets: ['src/*'] }, { pattern: '$lib/*', targets: ['src/*'] },
          ],
        }]);
        const report = checkStandards(layered(), input);
        assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [
          ['src/domain/order.ts', 1, 'layering/imports'], ['src/domain/order.ts', 2, 'layering/imports'], ['src/domain/order.ts', 3, 'layering/imports'],
        ]);
        assert.equal(standardsBlocked(report), true);
      });
    });

    it('paths kept in tsconfig.base.json and reached through extends are read as well', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-paths-base-');
        const head = seedRepo(dir, {
          'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@infra/*": ["src/infra/*"] } } }\n',
          'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n',
        });
        write(dir, { 'src/domain/order.ts': 'import { db } from "@infra/db";\nimport { q } from "src/infra/q";\n' });
        const report = checkStandards(layered(), await collectStandardsInput(dir, head));
        assert.deepEqual(report.findings.map((f) => [f.file, f.line]), [['src/domain/order.ts', 1], ['src/domain/order.ts', 2]]);
      });
    });

    it('an unreadable tsconfig, or one whose base is missing, leaves the imports not-checked — never passed', async function () {
      await withGit(this, async () => {
        for (const [label, tsconfig] of [
          ['unparsable', '{ "compilerOptions": { "paths": '],
          ['extends a file that is not there', '{ "extends": "./tsconfig.paths.json" }'],
        ]) {
          const dir = makeTempDir('moag-std-paths-bad-');
          const head = seedRepo(dir, { 'tsconfig.json': tsconfig });
          write(dir, { 'src/domain/order.ts': ORDER });
          const input = await collectStandardsInput(dir, head);
          assert.deepEqual(input.importPathScopes, [{ dir: '', aliases: null }], label);
          const row = layeringRow(input);
          assert.equal(row?.result, 'not-checked', label);
          assert.equal(row?.undecided, true, label);
          assert.match(row?.reason ?? '', /Import @infra\/db cannot be mapped to a path/, label);
        }
      });
    });

    // The Vite / Angular / Nx shape: the root tsconfig only lists references, and the paths
    // are in the config it refers to. `@infra/db` is not a package, and the import crosses a layer.
    it('paths kept in a referenced config (a solution tsconfig) are read: the import is a finding, in a .mts file too', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-paths-refs-');
        const head = seedRepo(dir, {
          'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }\n',
          'tsconfig.app.json': '{\n  // the app\n  "compilerOptions": { "paths": { "@infra/*": ["./src/infra/*"], "@app/*": ["./src/*"], "$lib/*": ["./src/*"], }, },\n}\n',
          'tsconfig.node.json': '{ "compilerOptions": { "composite": true } }\n',
          'src/infra/db.ts': 'export const db = 1;\n',
        });
        write(dir, { 'src/domain/order.ts': ORDER, 'src/domain/load.mts': 'import { db } from "@infra/db";\n' });
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.importPathScopes?.map((s) => [s.dir, s.aliases?.map((a) => a.pattern)]), [['', ['@infra/*', '@app/*', '$lib/*']]]);
        const report = checkStandards(layered(), input);
        assert.deepEqual(report.findings.map((f) => [f.file, f.line, f.rule]), [
          ['src/domain/load.mts', 1, 'layering/imports'],
          ['src/domain/order.ts', 1, 'layering/imports'], ['src/domain/order.ts', 2, 'layering/imports'], ['src/domain/order.ts', 3, 'layering/imports'],
        ]);
      });
    });

    it('a referenced config that is missing or unparsable leaves the alias imports not-checked — never "no findings"', async function () {
      await withGit(this, async () => {
        for (const [label, files] of [
          ['the referenced file is not there', { 'tsconfig.json': '{ "references": [{ "path": "./tsconfig.app.json" }] }\n' }],
          ['the referenced file is unparsable', { 'tsconfig.json': '{ "references": [{ "path": "./tsconfig.app.json" }] }\n', 'tsconfig.app.json': '{ "compilerOptions": { "paths": ' }],
        ] as Array<[string, Record<string, string>]>) {
          const dir = makeTempDir('moag-std-paths-refs-bad-');
          const head = seedRepo(dir, files);
          write(dir, { 'src/domain/order.ts': ORDER });
          const input = await collectStandardsInput(dir, head);
          assert.deepEqual(input.importPathScopes, [{ dir: '', aliases: null }], label);
          const row = layeringRow(input);
          assert.equal(row?.result, 'not-checked', label);
          assert.equal(row?.undecided, true, label);
          assert.match(row?.reason ?? '', /Import @infra\/db cannot be mapped to a path/, label);
          assert.notEqual(row?.result, 'passed', label);
        }
      });
    });

    it('a repository with no path aliases reports none, and a real package import still passes', async function () {
      await withGit(this, async () => {
        const dir = makeTempDir('moag-std-paths-none-');
        const head = seedRepo(dir, { 'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n' });
        write(dir, { 'src/domain/order.ts': 'import express from "express";\n' });
        const input = await collectStandardsInput(dir, head);
        assert.deepEqual(input.importPathScopes, []);
        assert.equal(layeringRow(input)?.result, 'passed');
      });
    });
  });
});

describe('evidence — runGate', () => {
  it('reports timedOut and removes its abort listener', async function () {
    this.timeout(20_000);
    const { signal, count } = countingSignal();
    const before = count();
    let result;
    try {
      result = await runGate(SLEEP_CMD, { cwd: process.cwd(), signal, timeoutMs: 400 });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(result.timedOut, true);
    assert.equal(result.passed, false);
    assert.notEqual(result.exitCode, 0);
    assert.equal(count(), before, 'abort listener must be removed on the timeout path');
  });

  it('resolves exactly once when the process errors (ENOENT double-settle guard)', async function () {
    this.timeout(15_000);
    const { signal } = countingSignal();
    let settles = 0;
    const dir = makeTempDir('moag-enoent-');
    let result;
    try {
      result = await runGate('moag-definitely-not-a-real-binary-xyz', {
        cwd: dir,
        signal,
        timeoutMs: 5_000,
      });
      settles++;
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    // Give any stray close/error handler a chance to double-resolve.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settles, 1);
    assert.equal(result.passed, false);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  });

  it('settles exactly once when the child emits both error and close', async () => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter() as NodeJS.EventEmitter & {
      stdout: NodeJS.EventEmitter; stderr: NodeJS.EventEmitter; killed: boolean; pid: number; kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.pid = 4242;
    proc.kill = () => { proc.killed = true; };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pq = require('proxyquire').noCallThru();
    const mod = pq('../../../runner/evidence', {
      child_process: {
        spawn: () => proc,
        // The Windows kill path shells out — a missing stub makes this hang.
        execSync: () => Buffer.from(''),
      },
    });

    const { signal, count } = countingSignal();
    let settles = 0;
    const promise = mod.runGate('anything', { cwd: process.cwd(), signal, timeoutMs: 5_000 })
      .then((r: GateResult) => { settles++; return r; });

    proc.emit('error', new Error('spawn ENOENT'));
    proc.emit('close', 0);          // a late close must not resolve a second time
    proc.emit('error', new Error('again'));

    const result = await promise;
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(settles, 1, 'the gate promise must settle exactly once');
    assert.equal(result.exitCode, 1, 'the first settle (the error) wins, not the later close');
    assert.equal(result.passed, false);
    assert.ok(result.output.includes('spawn ENOENT'));
    assert.equal(count(), 0, 'the abort listener must be removed on the error path');
  });

  describe('processGroup', () => {
    const spawnOptionsFor = async (processGroup: boolean | undefined): Promise<{ detached?: boolean }> => {
      const { EventEmitter } = require('events');
      const proc = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: NodeJS.EventEmitter; stderr: NodeJS.EventEmitter; killed: boolean; pid: number; kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.pid = 4343;
      proc.kill = () => { proc.killed = true; };
      let seen: { detached?: boolean } = {};
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pq = require('proxyquire').noCallThru();
      const mod = pq('../../../runner/evidence', {
        child_process: {
          spawn: (_c: string, _a: string[], opts: { detached?: boolean }) => { seen = opts; return proc; },
          execSync: () => Buffer.from(''),
        },
        // Pretend to be POSIX, where a process group exists.
        '../utils/process-kill': { SPAWN_DETACHED: true, killProcess: () => undefined },
      });
      const promise = mod.runGate('anything', {
        cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 5_000,
        ...(processGroup === undefined ? {} : { processGroup }),
      });
      proc.emit('close', 0);
      await promise;
      return seen;
    };

    it('spawns detached (a group leader) when processGroup is true on POSIX', async () => {
      assert.equal((await spawnOptionsFor(true)).detached, true);
    });

    it('does not detach by default', async () => {
      assert.equal((await spawnOptionsFor(undefined)).detached, false);
      assert.equal((await spawnOptionsFor(false)).detached, false);
    });
  });

  it('aborts promptly on an already-aborted signal without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await runGate(SLEEP_CMD, {
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 130);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - started < 2_000, 'pre-aborted gate must not wait for the command');
  });
});

describe('evidence — resolveGateCommands', () => {
  it('returns an empty list for a bare directory with nothing detectable', () => {
    const dir = makeTempDir('moag-bare-');
    assert.deepEqual(resolveGateCommands(dir), []);
  });

  it('returns explicit commands verbatim and in order', () => {
    const dir = makeTempDir('moag-explicit-');
    assert.deepEqual(resolveGateCommands(dir, ['a b', 'c d']), ['a b', 'c d']);
  });

  it('maps package.json scripts to build/lint/test order', () => {
    const dir = makeTempDir('moag-scripts-');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'mocha', build: 'tsc', lint: 'eslint .' } }),
      'utf-8',
    );
    assert.deepEqual(resolveGateCommands(dir), ['npm run build', 'npm run lint', 'npm test']);
  });
});

describe('evidence — summarizeEvidence', () => {
  it('stays within budget with a 10x-oversized diff and marks the truncation', () => {
    const budget = 2_000;
    const ev = {
      baseRef: 'abc123',
      changedFiles: ['src/a.ts', 'src/b.ts'],
      diffStat: ' src/a.ts | 2 +-',
      unifiedDiff: 'x'.repeat(budget * 10),
      truncated: true,
    };
    const gates = [
      { command: 'npm test', exitCode: 1, passed: false, output: 'y'.repeat(5_000), durationMs: 12, timedOut: false },
    ];
    const out = summarizeEvidence(ev, gates, budget);
    assert.ok(out.length <= budget, `expected <= ${budget}, got ${out.length}`);
    assert.ok(out.includes('[diff truncated]') || out.includes('[output truncated]'), 'truncation marker must be present');
    assert.ok(out.includes('npm test'), 'gate command must survive truncation');
  });
});

describe('evidence — the standards row is worded, never labelled PASS, off-screen', () => {
  const ev: DiffEvidence = { baseRef: 'abc123', changedFiles: ['src/a.ts'], diffStat: ' src/a.ts | 2 +-', unifiedDiff: '+x', truncated: false };
  const NONE = { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true as const };
  const OPEN = { advisoryFindings: 2, notCheckedRules: 1, notCheckedFiles: 3 };
  const gate = (over: Partial<GateResult>): GateResult =>
    ({ command: 'npm test', exitCode: 0, passed: true, output: 'ok', durationMs: 12, timedOut: false, ...over });
  const standardsLine = (text: string): string => text.split('\n').find((l) => l.startsWith('- `moag:standards')) ?? '';

  it('the model evidence says what the row means: nothing blocking, with what the check left open', () => {
    const out = summarizeEvidence(ev, [
      gate({ command: 'moag:standards v3', output: 'Project standards: nothing blocking (2 advisory findings, 1 rule not checked, 3 files not checked).', standardsCounts: OPEN }),
      gate({}),
    ], 10_000);
    assert.equal(standardsLine(out), '- `moag:standards v3` — nothing blocking (2 advisory findings · 1 rule not checked · 3 files not checked, 12ms)');
    assert.doesNotMatch(standardsLine(out), /PASS|exit 0/);
    // The real command beside it keeps its exit code and its PASS.
    assert.ok(out.includes('- `npm test` — exit 0 (PASS, 12ms)'));
    assert.equal((out.match(/\(PASS/g) ?? []).length, 1, 'one PASS in the block: the command');
  });

  it('a profile with no blocking set says "no blocking rules configured"; a row without counts says "nothing blocking"', () => {
    assert.equal(describeGateLine(gate({ command: 'moag:standards v1', standardsCounts: NONE })), '- `moag:standards v1` — no blocking rules configured (12ms)');
    assert.equal(describeGateLine(gate({ command: 'moag:standards v1', standardsCounts: { ...NONE, advisoryFindings: 1 } })),
      '- `moag:standards v1` — no blocking rules configured (1 advisory finding, 12ms)');
    assert.equal(describeGateLine(gate({ command: 'moag:standards' })), '- `moag:standards` — nothing blocking (12ms)');
  });

  it('a standards row that stopped the release says "stopped", never FAIL or an exit code', () => {
    const line = describeGateLine(gate({ command: 'moag:standards v3', exitCode: 1, passed: false, durationMs: 40 }));
    assert.equal(line, '- `moag:standards v3` — stopped (40ms)');
    assert.doesNotMatch(line, /FAIL|exit 1/);
    // Its output — the findings, the rows not checked — still follows it in the block.
    const out = summarizeEvidence(ev, [gate({ command: 'moag:standards v3', exitCode: 1, passed: false, output: 'Project standards stop this release: naming/files (findings)' })], 10_000);
    assert.ok(out.includes('Project standards stop this release: naming/files (findings)'));
  });

  it('commands are worded as before: exit code, PASS / FAIL, TIMED OUT — also one that merely mentions the name', () => {
    assert.equal(describeGateLine(gate({})), '- `npm test` — exit 0 (PASS, 12ms)');
    assert.equal(describeGateLine(gate({ exitCode: 2, passed: false })), '- `npm test` — exit 2 (FAIL, 12ms)');
    assert.equal(describeGateLine(gate({ exitCode: 124, passed: false, timedOut: true })), '- `npm test` — exit 124 (FAIL, TIMED OUT, 12ms)');
    assert.equal(describeGateLine(gate({ command: 'echo moag:standards v3' })), '- `echo moag:standards v3` — exit 0 (PASS, 12ms)');
  });

  it('a stored report keeps a command whole and stores the standards row in words, with no "passed" key', () => {
    const command = gate({});
    const failing = gate({ command: 'npm run lint', exitCode: 2, passed: false });
    const stored = gatesForStoredReport([
      gate({ command: 'moag:standards v3', output: 'Project standards: nothing blocking', standardsCounts: OPEN }), command, failing,
    ]);
    assert.deepEqual(stored[0], {
      command: 'moag:standards v3', exitCode: 0, output: 'Project standards: nothing blocking', durationMs: 12, timedOut: false,
      standardsCounts: OPEN, standards: 'nothing blocking', standardsOpen: '2 advisory findings · 1 rule not checked · 3 files not checked',
    });
    assert.equal('passed' in stored[0], false, 'no bare "passed: true" for a scan');
    assert.equal(stored[1], command, 'a command is stored exactly as it ran');
    assert.equal(stored[2], failing);
    const none = gatesForStoredReport([gate({ command: 'moag:standards v1', standardsCounts: NONE })])[0] as Record<string, unknown>;
    assert.deepEqual([none.standards, none.standardsOpen, 'passed' in none], ['no blocking rules configured', '', false]);
    const stopped = gatesForStoredReport([gate({ command: 'moag:standards v1', exitCode: 1, passed: false })])[0] as Record<string, unknown>;
    assert.deepEqual([stopped.standards, stopped.exitCode, 'passed' in stopped], ['stopped', 1, false]);
    assert.deepEqual(gatesForStoredReport([]), []);
    // The input is not changed: the loop still reads `passed` on its own rows.
    const row = gate({ command: 'moag:standards v3' });
    gatesForStoredReport([row]);
    assert.equal(row.passed, true);
  });
});

describe('evidence — checkArtifacts', () => {
  it('joins relative targets against cwd and uses absolute targets verbatim', () => {
    const cwdDir = makeTempDir('moag-art-cwd-');
    const otherDir = makeTempDir('moag-art-other-');
    fs.mkdirSync(path.join(cwdDir, 'sub'));
    fs.writeFileSync(path.join(cwdDir, 'sub', 'made.txt'), 'ok', 'utf-8');
    const absTarget = path.join(otherDir, 'elsewhere.txt');
    fs.writeFileSync(absTarget, 'ok', 'utf-8');

    const results = checkArtifacts(cwdDir, [
      path.join('sub', 'made.txt'),
      path.join('sub', 'missing.txt'),
      absTarget,
    ]);

    assert.equal(results.length, 3);
    assert.equal(results[0].exists, true, 'relative target must resolve through path.join');
    assert.equal(results[1].exists, false, 'a missing artifact must report false');
    // An absolute target joined onto cwd would not exist — proving isAbsolute is honoured.
    assert.equal(results[2].exists, true);
    assert.equal(results[2].target, absTarget);
  });
});

describe('evidence — detectPrdFile', () => {
  it('returns null for a directory with no PRD', () => {
    const dir = makeTempDir('moag-noprd-');
    assert.equal(detectPrdFile(dir), null);
  });

  it('finds a nested docs/PRD.md via path.join', () => {
    const dir = makeTempDir('moag-prd-');
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'PRD.md'), '# PRD', 'utf-8');
    assert.equal(detectPrdFile(dir), 'docs/PRD.md');
  });
});

describe('evidence — UAT capability', () => {
  it('returns nulls with a non-empty reason for a bare directory', () => {
    const dir = makeTempDir('moag-uat-bare-');
    const cap = resolveUatGate(dir, {});
    assert.equal(cap.tool, null);
    assert.equal(cap.command, null);
    assert.ok(cap.reason.length > 0, 'reason must always be populated');
    assert.match(cap.reason, /playwright\.config/);
  });

  it('does not throw on a malformed package.json', () => {
    const dir = makeTempDir('moag-uat-badpkg-');
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json', 'utf-8');
    let cap: ReturnType<typeof resolveUatGate> | undefined;
    assert.doesNotThrow(() => { cap = resolveUatGate(dir, {}); });
    assert.equal(cap!.tool, null);
    assert.equal(cap!.command, null);
    assert.ok(cap!.reason.length > 0);
  });

  it('prefers a config marker over a package.json dependency (deterministic)', () => {
    const dir = makeTempDir('moag-uat-both-');
    fs.writeFileSync(path.join(dir, 'cypress.config.js'), 'module.exports = {};', 'utf-8');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { '@playwright/test': '^1.62.1' } }),
      'utf-8',
    );
    // Markers are probed before the dependency fallback, so the on-disk cypress
    // config wins over the playwright devDependency. Deterministic either way.
    const cap = resolveUatGate(dir, {});
    assert.equal(cap.tool, 'cypress');
    assert.equal(cap.reason, 'cypress.config.js');
    assert.equal(cap.command, 'npx cypress run');
  });

  it('detects playwright from a config marker ahead of a cypress marker', () => {
    const dir = makeTempDir('moag-uat-pwmarker-');
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), 'export default {};', 'utf-8');
    fs.writeFileSync(path.join(dir, 'cypress.config.js'), 'module.exports = {};', 'utf-8');
    const cap = resolveUatGate(dir, {});
    assert.equal(cap.tool, 'playwright');
    assert.equal(cap.reason, 'playwright.config.ts');
    assert.equal(cap.command, 'npx playwright test --reporter=line');
  });

  it('falls back to a package.json dependency when no marker exists', () => {
    const dir = makeTempDir('moag-uat-dep-');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { cypress: '^13.0.0' } }),
      'utf-8',
    );
    const cap = resolveUatGate(dir, {});
    assert.equal(cap.tool, 'cypress');
    assert.match(cap.reason, /package\.json dependency/);
  });

  it('uses an explicit command verbatim on a bare directory with tool null', () => {
    const dir = makeTempDir('moag-uat-explicit-');
    const cap = resolveUatGate(dir, { explicitCommand: 'npm run e2e -- --headed' });
    assert.equal(cap.command, 'npm run e2e -- --headed');
    assert.equal(cap.tool, null);
    assert.ok(cap.reason.length > 0);
  });

  it('quotes a specPath containing spaces', () => {
    const dir = makeTempDir('moag-uat-spec-');
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), 'export default {};', 'utf-8');
    const cap = resolveUatGate(dir, { specPath: 'e2e/my specs/login.spec.ts' });
    assert.equal(cap.command, 'npx playwright test "e2e/my specs/login.spec.ts" --reporter=line');
    assert.equal(cap.specPath, 'e2e/my specs/login.spec.ts');

    fs.rmSync(path.join(dir, 'playwright.config.ts'));
    fs.writeFileSync(path.join(dir, 'cypress.config.js'), 'module.exports = {};', 'utf-8');
    const cy = resolveUatGate(dir, { specPath: 'cypress/e2e/a b.cy.ts' });
    assert.equal(cy.command, 'npx cypress run --spec "cypress/e2e/a b.cy.ts"');
  });

  it('leaves a space-free specPath unquoted', () => {
    const dir = makeTempDir('moag-uat-spec2-');
    fs.writeFileSync(path.join(dir, 'playwright.config.js'), 'module.exports = {};', 'utf-8');
    const cap = resolveUatGate(dir, { specPath: 'e2e/login.spec.ts' });
    assert.equal(cap.command, 'npx playwright test e2e/login.spec.ts --reporter=line');
  });
});
