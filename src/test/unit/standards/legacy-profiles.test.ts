// ─── Standards profiles written before the Project Rulebook ───
//
// Pins every profile that existed before the rulebook sections: the built-in profiles as
// they were (captured in fixtures/pre-rulebook-profiles.json) and the bench fixtures. Each
// must still validate to itself, keep its content hash and render byte-identical prompt
// text — a stored version's hash and prompt never move under a newer build.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  StandardsProfile,
  profileHash,
  renderPlannerStandards,
  renderStandardsText,
  validateProfile,
} from '../../../standards/profile';

interface LegacyFixture {
  stack: string;
  profile: StandardsProfile;
  hash: string;
  text: string;
  plannerText: string;
}

const REPO = path.resolve(__dirname, '../../../..');
const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'pre-rulebook-profiles.json'), 'utf8'),
) as LegacyFixture[];

/** Hashes of the bench scenario profiles, computed before the rulebook existed. */
const BENCH_HASHES: Record<string, string> = {
  'brownfield-moag': '84e841c8ab01578f9dd39b70cf9b2e9f4a9e05ac95dafd3a0cc89d698195b3f5',
  'greenfield-todo': 'f84e9d5122727ab23a2bc0bf61074c4b1f5c65297d64d8fc91541be720f90252',
  'standards-violation': '736c21bc9ee446b32302129e94967e50235c23575a1506610cf8cb7d55fa1394',
};

describe('standards/legacy profiles', () => {
  it('has a fixture for every stack', () => {
    assert.ok(FIXTURES.length >= 7);
  });

  for (const fixture of FIXTURES) {
    describe(`built-in ${fixture.stack} as it was`, () => {
      it('validates to itself and keeps its hash', () => {
        const v = validateProfile(fixture.profile);
        assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
        assert.deepEqual(v.profile, fixture.profile);
        assert.equal(profileHash(v.profile), fixture.hash);
      });

      it('renders byte-identical prompt and planner text', () => {
        assert.equal(renderStandardsText(fixture.profile, 3), fixture.text);
        assert.equal(renderPlannerStandards(fixture.profile, 3), fixture.plannerText);
      });
    });
  }

  for (const [scenario, hash] of Object.entries(BENCH_HASHES)) {
    it(`bench ${scenario} standards validate to themselves and keep their hash`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'scenarios', scenario, 'standards.json'), 'utf8')) as unknown;
      const v = validateProfile(raw);
      assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
      assert.deepEqual(v.profile, raw);
      assert.equal(profileHash(v.profile), hash);
    });
  }

  it('a changed profile changes the hash (the pin is not vacuous)', () => {
    const changed = { ...FIXTURES[0].profile, freeText: `${FIXTURES[0].profile.freeText}x` };
    assert.notEqual(profileHash(changed), FIXTURES[0].hash);
  });
});
