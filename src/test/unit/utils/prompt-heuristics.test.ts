import { strict as assert } from 'assert';
import { rateHeuristically } from '../../../utils/prompt-heuristics';

describe('rateHeuristically', () => {
  it('flags too-short in isolation for a brief but specific prompt', () => {
    const { score, flags } = rateHeuristically('check `foo.ts`');
    assert.deepEqual(flags, ['too-short']);
    assert.equal(score, 70);
  });

  it('flags vague-phrasing in isolation for a long-enough, specific, but vague prompt', () => {
    const { score, flags } = rateHeuristically(
      'Please fix it in the `utils/helper.ts` file soon',
    );
    assert.deepEqual(flags, ['vague-phrasing']);
    assert.equal(score, 70);
  });

  it('flags no-specifics in isolation for a mid-length prompt with no concrete tokens', () => {
    const { score, flags } = rateHeuristically(
      'Please refactor the authentication logic to support additional providers cleanly',
    );
    assert.deepEqual(flags, ['no-specifics']);
    assert.equal(score, 70);
  });

  it('raises zero flags for an adequately detailed prompt', () => {
    const { score, flags } = rateHeuristically(
      'Update `src/utils/auth.ts` to add token refresh handling for expired sessions ' +
      'and write regression tests in authTokenRefresh.test.ts',
    );
    assert.deepEqual(flags, []);
    assert.equal(score, 100);
  });

  it('stacks all three flags at the score floor for a short, vague, non-specific prompt', () => {
    const { score, flags } = rateHeuristically('fix it now');
    assert.deepEqual(flags.sort(), ['no-specifics', 'too-short', 'vague-phrasing']);
    assert.equal(score, 10);
  });
});
