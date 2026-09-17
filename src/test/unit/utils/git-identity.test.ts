import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Load git-identity fresh (own require.cache entry) so memoization starts clean. */
function loadFresh(childProcessStub?: Record<string, unknown>) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('git-identity')) { delete require.cache[k]; }
  }
  if (childProcessStub) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const proxyquire = require('proxyquire').noCallThru();
    return proxyquire('../../../utils/git-identity', { child_process: childProcessStub });
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../../utils/git-identity');
}

describe('resolveDeveloperEmail', () => {
  it('resolves the configured email from a real tmp git repo', function () {
    this.timeout(15_000);
    const dir = makeTempDir('moag-gitid-');
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: dir });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    const mod = loadFresh();
    const email = mod.resolveDeveloperEmail(dir);
    assert.equal(email, 'dev@example.com');
  });

  it('returns null, not throw, for a directory with no .git and no configured email', function () {
    const dir = makeTempDir('moag-gitid-none-');
    const mod = loadFresh({
      execFileSync: () => { throw new Error('fatal: not in a git directory'); },
    });
    let result: string | null | undefined;
    assert.doesNotThrow(() => { result = mod.resolveDeveloperEmail(dir); });
    assert.equal(result, null);
  });

  it('memoizes — calling twice only shells out once', () => {
    let calls = 0;
    const mod = loadFresh({
      execFileSync: () => { calls++; return 'first@example.com\n'; },
    });
    const a = mod.resolveDeveloperEmail('/some/dir');
    const b = mod.resolveDeveloperEmail('/some/other/dir');
    assert.equal(a, 'first@example.com');
    assert.equal(b, 'first@example.com');
    assert.equal(calls, 1, 'execFileSync must be called exactly once — memoized for process lifetime');
  });

  it('resolves empty string output to null', () => {
    const mod = loadFresh({
      execFileSync: () => '   \n',
    });
    assert.equal(mod.resolveDeveloperEmail('/some/dir'), null);
  });
});
