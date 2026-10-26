import { strict as assert } from 'assert';
import { formatTotal, formatUsageCost, formatUsd, isCostKnown } from '../../../utils/cost-format';

describe('cost-format', () => {
  it('formatUsageCost: a reported 0 is $0.00, never "Free"', () => {
    assert.equal(formatUsageCost({ estimatedCost: 0, costSource: 'reported' }), '$0.00');
    assert.equal(formatUsageCost({ estimatedCost: 0 }), '$0.00');
  });

  it('formatUsageCost: unknown cost reads "cost unknown"', () => {
    assert.equal(formatUsageCost({ costSource: 'unknown' }), 'cost unknown');
    assert.equal(formatUsageCost({ estimatedCost: 1, costSource: 'unknown' }), 'cost unknown');
    assert.equal(formatUsageCost(undefined), 'cost unknown');
    assert.equal(formatUsageCost({ estimatedCost: Number.NaN }), 'cost unknown');
  });

  it('formatUsageCost: tiny values get four decimals, others two', () => {
    assert.equal(formatUsageCost({ estimatedCost: 0.0042, costSource: 'reported' }), '$0.0042');
    assert.equal(formatUsageCost({ estimatedCost: 1.234, costSource: 'estimated' }), '$1.23');
  });

  it('formatUsd clamps negative and non-finite input to $0.00', () => {
    assert.equal(formatUsd(-1), '$0.00');
    assert.equal(formatUsd(Number.POSITIVE_INFINITY), '$0.00');
  });

  it('formatTotal: known only, mixed, unknown only', () => {
    assert.equal(formatTotal(1.23, 0), '$1.23');
    assert.equal(formatTotal(1.23, 3), '$1.23 + 3 calls of unknown cost');
    assert.equal(formatTotal(1.23, 1), '$1.23 + 1 call of unknown cost');
    assert.equal(formatTotal(0, 2), 'cost unknown');
    assert.equal(formatTotal(0, 0), '$0.00');
  });

  it('isCostKnown', () => {
    assert.equal(isCostKnown({ estimatedCost: 0, costSource: 'reported' }), true);
    assert.equal(isCostKnown({ costSource: 'unknown' }), false);
    assert.equal(isCostKnown({ estimatedCost: 2, costSource: 'unknown' }), false);
    assert.equal(isCostKnown(undefined), false);
  });
});
