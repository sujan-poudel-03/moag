// ─── Marketplace listing metadata ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..', '..');

describe('Marketplace listing metadata', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require(path.join(ROOT, 'package.json'));

  it('is free, lists AI first, and sends questions to the GitHub issues', () => {
    assert.equal(pkg.pricing, 'Free');
    assert.equal(pkg.qna, 'https://github.com/sujan-poudel-03/moag/issues');
    assert.ok(pkg.categories.includes('AI'));
    assert.ok(!pkg.categories.includes('Other'), '"Other" hides the extension');
  });

  it('every README screenshot placeholder names a PNG or GIF that CAPTURES.md lists', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
    const captures = fs.readFileSync(path.join(ROOT, 'media', 'screenshots', 'CAPTURES.md'), 'utf-8');
    const names = [...readme.matchAll(/<!-- screenshot: media\/screenshots\/([^ ]+) \| alt: "[^"]+" -->/g)].map((m) => m[1]);
    assert.ok(names.length >= 7, `found ${names.length} placeholders`);
    for (const n of names) {
      assert.match(n, /\.(png|gif)$/, `${n}: the Marketplace rejects SVG in a README`);
      assert.ok(captures.includes('`' + n + '`'), `${n} is not in CAPTURES.md`);
    }
  });
});
