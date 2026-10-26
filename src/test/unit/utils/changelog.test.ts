// ─── CHANGELOG.md parsing: sections, Unreleased, CRLF, the last section ───

import { strict as assert } from 'assert';
import { parseChangelog, extractSection } from '../../../utils/changelog';

const SAMPLE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Upgrade notes',
  '',
  '- Something pending.',
  '',
  '## [1.2.0] - 2026-10-01',
  '',
  '### Added',
  '',
  '- A feature.',
  '',
  '## [1.1.1] - not released',
  '',
  'Version number skipped; no build was released.',
  '',
  '## [1.1.0] - 2026-09-01',
  '',
  '- The last section.',
  '',
  '[1.2.0]: https://github.com/o/r/compare/v1.1.0...v1.2.0',
  '[1.1.0]: https://github.com/o/r/compare/v1.0.0...v1.1.0',
  '',
].join('\n');

describe('changelog parsing', () => {
  it('lists the versioned sections in file order, skipping Unreleased', () => {
    assert.deepEqual(parseChangelog(SAMPLE).map((s) => [s.version, s.date]), [
      ['1.2.0', '2026-10-01'],
      ['1.1.1', 'not released'],
      ['1.1.0', '2026-09-01'],
    ]);
  });

  it('a body is the text up to the next heading, trimmed', () => {
    assert.equal(extractSection(SAMPLE, '1.2.0'), '### Added\n\n- A feature.');
  });

  it('the last section stops at the compare links', () => {
    assert.equal(extractSection(SAMPLE, '1.1.0'), '- The last section.');
  });

  it('accepts a v-prefixed tag', () => {
    assert.equal(extractSection(SAMPLE, 'v1.2.0'), '### Added\n\n- A feature.');
  });

  it('a missing version is null, not an empty string', () => {
    assert.equal(extractSection(SAMPLE, '9.9.9'), null);
  });

  it('a changelog with only Unreleased has no sections, and Unreleased is never returned', () => {
    const text = '# Changelog\n\n## [Unreleased]\n\n- Work in progress.\n';
    assert.deepEqual(parseChangelog(text), []);
    assert.equal(extractSection(text, 'Unreleased'), null);
  });

  it('reads CRLF the same as LF, and returns LF bodies', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    assert.deepEqual(parseChangelog(crlf), parseChangelog(SAMPLE));
    assert.equal(extractSection(crlf, '1.2.0'), '### Added\n\n- A feature.');
  });

  it('an empty section has an empty body', () => {
    assert.equal(extractSection('## [2.0.0] - 2026-01-01\n\n## [1.0.0] - 2025-01-01\n- x\n', '2.0.0'), '');
  });

  it('empty text has no sections', () => {
    assert.deepEqual(parseChangelog(''), []);
  });
});
