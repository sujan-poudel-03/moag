// ─── Repository line endings: .gitattributes keeps src/ and web/ LF in every checkout ───
//
// Git for Windows ships core.autocrlf=true. Without a .gitattributes a fresh
// clone held every source file with CRLF, and tests that read source as text
// failed there while passing on an older working tree whose copies were LF.
// The behaviour is checked with real git in a throwaway repository that uses
// this repository's own .gitattributes.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const ATTRIBUTES = path.join(REPO, '.gitattributes');

/** Folders whose files tests read as text. */
const LF_FOLDERS = ['src', 'web'];

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

/** The `pattern attr...` rules of a .gitattributes text (comments and blank lines dropped). */
function parseRules(text: string): Array<{ pattern: string; attrs: string[] }> {
  return text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => {
      const [pattern, ...attrs] = l.split(/\s+/);
      return { pattern, attrs };
    });
}

describe('repository line endings (.gitattributes)', () => {
  const made: string[] = [];

  afterEach(() => {
    for (const dir of made.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on Windows */ }
    }
  });

  function git(cwd: string, ...args: string[]): Buffer {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 });
  }

  /**
   * A repository with core.autocrlf set to `autocrlf` and `attributes` as its
   * .gitattributes (none when null). `files` are committed, then the working
   * copies are deleted and checked out again, the way a fresh clone gets them.
   */
  function checkoutWith(autocrlf: 'true' | 'false', attributes: string | null, files: Record<string, Buffer | string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-eol-'));
    made.push(dir);
    git(dir, 'init', '-q', '.');
    git(dir, 'config', 'user.email', 't@t.t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', autocrlf);
    git(dir, 'config', 'core.safecrlf', 'false');
    if (attributes !== null) { fs.writeFileSync(path.join(dir, '.gitattributes'), attributes); }
    for (const [rel, content] of Object.entries(files)) {
      const at = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, content);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    for (const rel of Object.keys(files)) { fs.rmSync(path.join(dir, ...rel.split('/'))); }
    git(dir, 'checkout', '--', '.');
    return dir;
  }

  /** Run `body`, skipping the test where the sandbox cannot spawn git. */
  function withGit(ctx: Mocha.Context, body: () => void): void {
    ctx.timeout(60_000);
    try {
      body();
    } catch (err) {
      if (isSpawnEperm(err)) { ctx.skip(); return; }
      throw err;
    }
  }

  const LF_SOURCE = 'export function foldEvent(view, ev) {\n  return view;\n}\n';
  const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x0a, 0x00, 0x0d, 0x0a, 0xff]);

  it('declares eol=lf for everything under src/ and web/, and never CRLF', () => {
    assert.ok(fs.existsSync(ATTRIBUTES), '.gitattributes exists at the repository root');
    const rules = parseRules(fs.readFileSync(ATTRIBUTES, 'utf-8'));
    for (const folder of LF_FOLDERS) {
      const rule = rules.find((r) => r.pattern === `${folder}/**`);
      assert.ok(rule, `a rule for ${folder}/**`);
      assert.ok(rule.attrs.includes('eol=lf'), `${folder}/** is eol=lf (got ${rule.attrs.join(' ')})`);
      assert.ok(rule.attrs.includes('text=auto'), `${folder}/** keeps binary detection (got ${rule.attrs.join(' ')})`);
    }
    assert.deepEqual(rules.filter((r) => r.attrs.includes('eol=crlf')), [], 'no rule asks for CRLF');
  });

  it('is repository plumbing: the VSIX does not ship it', () => {
    const ignore = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf-8').split(/\r?\n/).map((l) => l.trim());
    // .vscodeignore is an allowlist: everything is excluded unless a `!` line keeps it.
    const rules = ignore.filter((l) => l !== '' && !l.startsWith('#'));
    assert.equal(rules[0], '**');
    assert.ok(!rules.some((l) => l.startsWith('!') && l.includes('gitattributes')));
  });

  it('a core.autocrlf=true checkout holds src/ and web/ with LF, and still converts files outside them', function () {
    withGit(this, () => {
      const dir = checkoutWith('true', fs.readFileSync(ATTRIBUTES, 'utf-8'), {
        'src/server/a.ts': LF_SOURCE,
        'src/test/unit/server/a.test.ts': LF_SOURCE,
        'web/js/screens/run.js': LF_SOURCE,
        'web/app.css': 'body {\n  margin: 0;\n}\n',
        'notes/outside.txt': 'one\ntwo\n',
      });
      for (const rel of ['src/server/a.ts', 'src/test/unit/server/a.test.ts', 'web/js/screens/run.js']) {
        assert.equal(fs.readFileSync(path.join(dir, rel), 'utf-8'), LF_SOURCE, `${rel} is checked out byte for byte`);
      }
      assert.equal(fs.readFileSync(path.join(dir, 'web', 'app.css'), 'utf-8').includes('\r'), false);
      // The control: autocrlf really was converting in this repository.
      assert.equal(fs.readFileSync(path.join(dir, 'notes', 'outside.txt'), 'utf-8'), 'one\r\ntwo\r\n');
    });
  });

  it('without the file the same checkout has CRLF (the failure this guards against)', function () {
    withGit(this, () => {
      const dir = checkoutWith('true', null, { 'web/js/screens/run.js': LF_SOURCE });
      const onDisk = fs.readFileSync(path.join(dir, 'web', 'js', 'screens', 'run.js'), 'utf-8');
      assert.equal(onDisk, LF_SOURCE.replace(/\n/g, '\r\n'));
      assert.equal(/export function foldEvent\(view, ev\) \{[\s\S]*?\n\}\n/.test(onDisk), false, 'an LF-only pattern cannot match it');
    });
  });

  it('a CRLF working copy under src/ or web/ is committed as LF, whatever core.autocrlf says', function () {
    withGit(this, () => {
      for (const autocrlf of ['true', 'false'] as const) {
        const crlf = LF_SOURCE.replace(/\n/g, '\r\n');
        const dir = checkoutWith(autocrlf, fs.readFileSync(ATTRIBUTES, 'utf-8'), { 'src/a.ts': crlf, 'web/js/b.js': crlf });
        for (const rel of ['src/a.ts', 'web/js/b.js']) {
          assert.equal(git(dir, 'show', `HEAD:${rel}`).toString('utf-8'), LF_SOURCE, `${rel} blob (autocrlf=${autocrlf})`);
          assert.equal(fs.readFileSync(path.join(dir, rel), 'utf-8'), LF_SOURCE, `${rel} checkout (autocrlf=${autocrlf})`);
        }
      }
    });
  });

  it('a binary file under those folders is left untouched', function () {
    withGit(this, () => {
      const dir = checkoutWith('true', fs.readFileSync(ATTRIBUTES, 'utf-8'), { 'web/img/logo.png': BINARY, 'src/fixtures/blob.bin': BINARY });
      for (const rel of ['web/img/logo.png', 'src/fixtures/blob.bin']) {
        assert.ok(fs.readFileSync(path.join(dir, rel)).equals(BINARY), `${rel} working copy`);
        assert.ok(git(dir, 'show', `HEAD:${rel}`).equals(BINARY), `${rel} blob`);
      }
    });
  });

  it('git resolves eol=lf for the files the suite reads as text', function () {
    withGit(this, () => {
      if (!fs.existsSync(path.join(REPO, '.git'))) { this.skip(); return; }
      const files = ['web/js/screens/run.js', 'web/js/strings.js', 'src/extension.ts', 'src/ui/standards-report-html.ts'];
      const out = git(REPO, 'check-attr', 'eol', '--', ...files).toString('utf-8');
      for (const f of files) { assert.ok(out.split(/\r?\n/).includes(`${f}: eol: lf`), `${f} in\n${out}`); }
    });
  });
});
