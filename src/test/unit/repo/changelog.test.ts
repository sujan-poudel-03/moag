// ─── CHANGELOG.md: shape, order, and agreement with package.json ───
//
// The release workflow publishes the CHANGELOG section for the tag as the
// GitHub release notes (scripts/release-notes.js), and refuses a tag whose
// section is missing. These checks keep the file in a shape that works:
// one well-formed heading per version, newest first, the newest one matching
// package.json, and a compare link for every released version.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseChangelog } from '../../../utils/changelog';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const TEXT = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf-8');
const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')) as { version: string }).version;
const COMPARE = 'https://github.com/sujan-poudel-03/moag/compare/';

/** Every `## ` heading line, as written. */
const HEADINGS = TEXT.split(/\r?\n/).filter((l) => l.startsWith('## '));

/** -1, 0 or 1 comparing two x.y.z versions numerically. */
function cmp(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] < y[i] ? -1 : 1; } }
  return 0;
}

describe('CHANGELOG.md', () => {
  const sections = parseChangelog(TEXT);

  it('has versioned sections', () => {
    assert.ok(sections.length > 10, `found only ${sections.length} sections; the parse is broken`);
  });

  it('starts with [Unreleased], and its first version is package.json\'s', () => {
    assert.equal(HEADINGS[0], '## [Unreleased]');
    assert.equal(sections[0].version, VERSION);
  });

  it('every heading is `## [x.y.z] - YYYY-MM-DD` or `## [x.y.z] - not released`', () => {
    const bad = HEADINGS.slice(1).filter((h) => !/^## \[\d+\.\d+\.\d+\] - (\d{4}-\d{2}-\d{2}|not released)$/.test(h));
    assert.deepEqual(bad, []);
  });

  it('every date is a real calendar date', () => {
    const bad = sections.filter((s) => s.date !== 'not released')
      .filter((s) => new Date(`${s.date}T00:00:00Z`).toISOString().slice(0, 10) !== s.date);
    assert.deepEqual(bad.map((s) => `${s.version}: ${s.date}`), []);
  });

  it('versions strictly descend (newest first, no duplicates)', () => {
    const out: string[] = [];
    for (let i = 1; i < sections.length; i++) {
      if (cmp(sections[i - 1].version, sections[i].version) <= 0) { out.push(`${sections[i - 1].version} before ${sections[i].version}`); }
    }
    assert.deepEqual(out, []);
  });

  it('every released version has a compare link (the first release links its tree)', () => {
    const links = new Map<string, string>();
    for (const m of TEXT.matchAll(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm)) { links.set(m[1], m[2]); }
    const released = sections.filter((s) => s.date !== 'not released');
    const oldest = released[released.length - 1].version;
    const missing = released.filter((s) => {
      const url = links.get(s.version) ?? '';
      return s.version === oldest
        ? !url.startsWith('https://github.com/sujan-poudel-03/moag/')
        : !url.startsWith(COMPARE);
    });
    assert.deepEqual(missing.map((s) => s.version), []);
    assert.ok((links.get('Unreleased') ?? '').startsWith(`${COMPARE}v${VERSION}...`), 'Unreleased compares from the current tag');
  });

  it('every released section has a body', () => {
    assert.deepEqual(sections.filter((s) => s.body === '').map((s) => s.version), []);
  });
});
