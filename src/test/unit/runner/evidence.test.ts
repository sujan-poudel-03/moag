// ─── Deterministic evidence gates — failure paths first ───

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  captureBaseRef,
  checkArtifacts,
  collectDiffEvidence,
  detectPrdFile,
  DiffEvidence,
  GateResult,
  resolveGateCommands,
  resolveUatGate,
  runGate,
  summarizeEvidence,
} from '../../../runner/evidence';

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
