// ─── scripts/release-notes.js: the notes a tag publishes, or a refusal ───
//
// The Publish workflow's first job runs this on the pushed tag. It must refuse
// a tag that is not v + package.json's version (a tag on the wrong commit), and
// a version whose CHANGELOG section is missing or empty, so nothing is released
// without notes. Each case runs against a throwaway root that holds a
// package.json, a CHANGELOG.md and the compiled parser (needs `npm run compile`).

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { releaseNotes } = require('../../../../scripts/release-notes') as {
  releaseNotes(tag: string | undefined, root?: string): { notes?: string; error?: string };
};

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [2.0.0] - 2026-10-01',
  '',
  '### Added',
  '',
  '- The thing.',
  '',
  '## [1.9.0] - 2026-09-01',
  '',
  '## [1.8.0] - 2026-08-01',
  '',
  '- Older.',
  '',
].join('\n');

describe('scripts/release-notes.js', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); } });

  /** A root with package.json at `version`, the given changelog and the compiled parser. */
  function root(version: string, changelog = CHANGELOG): string {
    const compiled = path.join(REPO, 'out', 'utils', 'changelog.js');
    if (!fs.existsSync(compiled)) { assert.fail('out/utils/changelog.js is missing; run `npm run compile` before the unit suite.'); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-notes-'));
    made.push(dir);
    fs.mkdirSync(path.join(dir, 'out', 'utils'), { recursive: true });
    fs.copyFileSync(compiled, path.join(dir, 'out', 'utils', 'changelog.js'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    return dir;
  }

  it('prints the section for a tag that matches package.json', () => {
    assert.deepEqual(releaseNotes('v2.0.0', root('2.0.0')), { notes: '### Added\n\n- The thing.' });
  });

  it('refuses a tag that is not v + package.json\'s version', () => {
    assert.match(releaseNotes('v1.8.0', root('2.0.0')).error ?? '', /does not match package.json version 2\.0\.0/);
    assert.match(releaseNotes('2.0.0', root('2.0.0')).error ?? '', /expected v2\.0\.0/);
    assert.match(releaseNotes(undefined, root('2.0.0')).error ?? '', /\(none\)/);
  });

  it('refuses a version with no changelog section', () => {
    assert.match(releaseNotes('v2.1.0', root('2.1.0')).error ?? '', /no "## \[2\.1\.0\] - YYYY-MM-DD" section/);
  });

  it('refuses an empty section', () => {
    assert.match(releaseNotes('v1.9.0', root('1.9.0')).error ?? '', /section for 1\.9\.0 is empty/);
  });

  it('the repository\'s own tag for its current version has notes', () => {
    const version = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')) as { version: string }).version;
    const r = releaseNotes(`v${version}`);
    assert.equal(r.error, undefined);
    assert.ok((r.notes ?? '').length > 0);
  });
});
