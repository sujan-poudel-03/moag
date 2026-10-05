import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseScenario, dryRunProblem } from '../../../bench/scenario';
import { parseRequirements } from '../../../models/requirements';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SCENARIOS = path.join(REPO, 'bench', 'scenarios');

describe('bench scenarios shipped in bench/scenarios', () => {
  it('greenfield-todo: $10, template repo, npm test gate, v1 initial / v2 patch / v3 minor', () => {
    const s = parseScenario(path.join(SCENARIOS, 'greenfield-todo', 'scenario.json'));
    assert.equal(s.budgetUsd, 10);
    assert.equal(s.perCallCapUsd, 1);
    assert.equal(s.engine, 'claude');
    assert.equal(s.stack, 'node-ts');
    assert.equal(s.repo.kind, 'template');
    assert.deepEqual(s.gateCommands, ['npm test']);
    assert.deepEqual(s.versions.map((v) => v.intendedBump), ['initial', 'patch', 'minor']);
    assert.equal(dryRunProblem(s), null);
    assert.ok(fs.existsSync(path.join(SCENARIOS, 'greenfield-todo', 'template', '.gitignore')));
  });

  it('brownfield-moag: $5, a clone of this repository at feat/sdlc-automation, compile + one mocha file', () => {
    const s = parseScenario(path.join(SCENARIOS, 'brownfield-moag', 'scenario.json'));
    assert.equal(s.budgetUsd, 5);
    assert.equal(s.repo.kind, 'clone');
    if (s.repo.kind !== 'clone') { return; }
    assert.equal(path.resolve(s.repo.path), REPO, 'the clone source is this repository');
    assert.equal(s.repo.ref, 'feat/sdlc-automation');
    assert.deepEqual(s.setupCommands, ['npm ci']);
    assert.deepEqual(s.passEnv, ['NODE_OPTIONS']);
    assert.equal(s.gateCommands.length, 2);
    assert.equal(s.gateCommands[0], 'npm run compile');
    assert.match(s.gateCommands[1], /mocha .*src\/test\/unit\/utils\/usd-format\.test\.ts$/);
    assert.deepEqual(s.versions.map((v) => v.intendedBump), ['initial']);
    assert.equal(dryRunProblem(s), null);
  });

  for (const name of ['greenfield-todo', 'brownfield-moag']) {
    it(`${name}: every PRD and fixture exists, and every requirement line carries an explicit tag`, () => {
      const s = parseScenario(path.join(SCENARIOS, name, 'scenario.json'));
      for (const v of s.versions) {
        assert.ok(fs.statSync(v.prdFile).isFile(), v.prdFile);
        assert.ok(v.dryRunFixture && fs.statSync(v.dryRunFixture).isDirectory(), `${v.id} fixture`);
        const { items, errors } = parseRequirements(fs.readFileSync(v.prdFile, 'utf-8'));
        assert.deepEqual(errors, [], `${v.id}: requirement parse errors`);
        assert.ok(items.length > 0, `${v.id}: no requirements found`);
        const untagged = items.filter((i) => i.id === null).map((i) => i.line);
        assert.deepEqual(untagged, [], `${v.id}: untagged requirement lines (an untagged reworded line becomes a new id, i.e. a removal and a major bump)`);
      }
    });
  }

  it('greenfield versions only reword/bugfix in v2 and only add in v3 (ids stay stable)', () => {
    const ids = (f: string) => parseRequirements(fs.readFileSync(path.join(SCENARIOS, 'greenfield-todo', 'prd', f), 'utf-8')).items.map((i) => i.id);
    assert.deepEqual(ids('v1.md'), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5']);
    assert.deepEqual(ids('v2.md'), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5']);
    assert.deepEqual(ids('v3.md'), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7', 'R-8']);
  });
});
