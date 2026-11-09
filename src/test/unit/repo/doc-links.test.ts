// ─── Relative links in the user-facing docs resolve ───
//
// README.md (shown on the Marketplace), the manual, the walkthrough pages and the
// ONOSOO guide must not point at a file that does not exist. Links inside HTML
// comments (screenshot placeholders) and pure #anchors are skipped. The moag.dev
// domain does not resolve, so no checked file may mention it.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function checkedFiles(): string[] {
  const media = fs.readdirSync(path.join(ROOT, 'media')).filter((f) => f.endsWith('.md')).map((f) => path.join('media', f));
  return ['README.md', path.join('docs', 'MANUAL.md'), path.join('docs', 'onosoo-builds.md'), ...media]
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
}

/** Every relative link target in `text`, outside HTML comments and fenced code. */
export function relativeLinks(text: string): string[] {
  const visible = text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
  const out: string[] = [];
  for (const m of visible.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) { continue; }
    out.push(target.split('#')[0]);
  }
  return out;
}

describe('docs: relative links resolve', () => {
  it('skips comments, code, anchors and URLs', () => {
    assert.deepEqual(
      relativeLinks('[a](docs/x.md) [b](#top) [c](https://x.dev) <!-- [d](missing.png) --> ```\n[e](nope.md)\n``` [f](y.md#sec)'),
      ['docs/x.md', 'y.md'],
    );
  });

  it('the install walkthrough says the prompt goes on stdin, not as a CLI argument', () => {
    const text = fs.readFileSync(path.join(ROOT, 'media', 'walkthrough-install.md'), 'utf-8');
    assert.ok(!text.includes('as a CLI argument'));
    assert.ok(text.includes('on stdin'));
  });

  for (const file of checkedFiles()) {
    it(`${file}: every relative link exists`, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const base = path.dirname(path.join(ROOT, file));
      const missing = relativeLinks(text).filter((t) => !fs.existsSync(path.resolve(base, decodeURIComponent(t))));
      assert.deepEqual(missing, [], `${file} links to files that do not exist`);
    });

    it(`${file}: never mentions moag.dev (it does not resolve)`, () => {
      assert.ok(!fs.readFileSync(path.join(ROOT, file), 'utf-8').includes('moag.dev'));
    });
  }
});
