// ─── Unit test runner: tsx, not ts-node ───
//
// On Node 22.6+ the runtime strips TypeScript natively and loads .ts as ESM,
// which broke `mocha --require ts-node/register` with "require is not defined
// in ES module scope". The suite now runs through tsx's ESM loader
// (`node --import tsx`), which works on Node 20.6+ through 24. These checks
// keep a script from drifting back to ts-node.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

/** The `scripts` block of package.json. */
function scripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

describe('unit test runner (package.json scripts)', () => {
  it('test:unit loads TypeScript through `node --import tsx`', () => {
    const unit = scripts()['test:unit'];
    assert.ok(unit, 'test:unit script is missing');
    assert.match(unit, /^node --import tsx /);
  });

  it('test:unit excludes the live (credit-spending) tests', () => {
    assert.match(scripts()['test:unit'], /--ignore "src\/test\/unit\/\*\*\/\*live\.test\.ts"/);
  });

  it('no script loads ts-node/register', () => {
    const offenders = Object.entries(scripts()).filter(([, cmd]) => cmd.includes('ts-node/register'));
    assert.deepEqual(offenders, []);
  });
});
