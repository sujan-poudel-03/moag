// ─── README settings table vs package.json defaults ───
//
// The README's settings table is what a new user reads first. Every row whose
// default is a literal must match the manifest, so a changed default cannot
// leave the README quietly wrong.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..', '..');

describe('README: the settings table matches package.json defaults', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require(path.join(ROOT, 'package.json'));
  const props: Record<string, { default?: unknown }> = Object.assign(
    {},
    ...[].concat(pkg.contributes.configuration).map((c: { properties: Record<string, unknown> }) => c.properties),
  );

  // | `key` | `value` | description |
  const rows = [...readme.matchAll(/^\| `([^`]+)` \| (`[^`]*`|--|varies) \|/gm)]
    .map((m) => ({ key: m[1], value: m[2] }))
    .filter((r) => r.value !== '--' && r.value !== 'varies' && !r.key.includes('*'))
    .filter((r) => Object.prototype.hasOwnProperty.call(props, `agentTaskPlayer.${r.key}`));

  it('finds the settings rows', () => {
    assert.ok(rows.length >= 6, `parsed only ${rows.length} rows`);
  });

  it('every literal default matches the manifest', () => {
    const wrong: string[] = [];
    for (const r of rows) {
      const shown = r.value.slice(1, -1);
      const actual = props[`agentTaskPlayer.${r.key}`].default;
      const expected = typeof actual === 'string' ? actual : JSON.stringify(actual);
      // A string default is written unquoted, except the empty string ("").
      const ok = shown === expected || (actual === '' && shown === '""');
      if (!ok) { wrong.push(`${r.key}: README says ${r.value}, package.json says ${JSON.stringify(actual)}`); }
    }
    assert.deepEqual(wrong, []);
  });
});
