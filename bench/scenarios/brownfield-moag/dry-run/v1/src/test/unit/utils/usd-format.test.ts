import { strict as assert } from 'assert';
import { formatUsd } from '../../../utils/usd-format';

describe('formatUsd', () => {
  it('renders finite non-negative amounts with a dollar sign and two decimals', () => {
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatUsd(0.5), '$0.50');
    assert.equal(formatUsd(12.3), '$12.30');
    assert.equal(formatUsd(7.129), '$7.13');
  });

  it("renders 'unknown' as unknown", () => {
    assert.equal(formatUsd('unknown'), 'unknown');
  });

  it('throws a RangeError for a negative amount, NaN and both infinities', () => {
    for (const bad of [-0.01, -5, NaN, Infinity, -Infinity]) {
      assert.throws(() => formatUsd(bad), RangeError, String(bad));
    }
  });
});
