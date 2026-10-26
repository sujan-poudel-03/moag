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

describe('cost-format: unknown-cost calls', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isUnknownCostCall, sessionUsageDelta, formatTotal: total } = require('../../../utils/cost-format');

  it('an engine call with no usage, or usage with no cost, is unknown; a reported cost is not', () => {
    assert.equal(isUnknownCostCall(undefined), true, 'Copilot / custom: no usage at all');
    assert.equal(isUnknownCostCall(undefined, 'agent'), true);
    assert.equal(isUnknownCostCall({ inputTokens: 10 }), true, 'tokens but no cost');
    assert.equal(isUnknownCostCall({ costSource: 'unknown' }, 'review'), true);
    assert.equal(isUnknownCostCall({ estimatedCost: 0, costSource: 'reported' }), false, 'Ollama: a real zero');
    assert.equal(isUnknownCostCall({ estimatedCost: 0.2, costSource: 'reported' }), false);
  });

  it('a task that calls no engine is never an unknown-cost call', () => {
    for (const t of ['command', 'check', 'service', 'manual', 'deploy', 'release', 'monitor', 'validate']) {
      assert.equal(isUnknownCostCall(undefined, t), false, t);
    }
  });

  it('a Copilot-only run reads "cost unknown", never $0.00', () => {
    let s = { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 };
    s = sessionUsageDelta(s, undefined, 'agent');
    s = sessionUsageDelta(s, undefined, 'agent');
    assert.deepEqual(s, { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, costUnknownCalls: 2 });
    assert.equal(total(s.totalCost, s.costUnknownCalls), 'cost unknown');
  });

  it('a Codex run with no tokens counts as unknown; a command task in the same run does not', () => {
    let s = { totalTokensIn: 0, totalTokensOut: 0, totalCost: 1, costUnknownCalls: 0 };
    s = sessionUsageDelta(s, { costSource: 'unknown' }, 'agent');
    s = sessionUsageDelta(s, undefined, 'command');
    s = sessionUsageDelta(s, { inputTokens: 5, outputTokens: 2, estimatedCost: 0.5, costSource: 'reported' });
    assert.deepEqual(s, { totalTokensIn: 5, totalTokensOut: 2, totalCost: 1.5, costUnknownCalls: 1 });
    assert.equal(total(s.totalCost, s.costUnknownCalls), '$1.50 + 1 call of unknown cost');
  });

  it('a number tagged unknown is never added to the total', () => {
    const s = sessionUsageDelta({ totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 }, { estimatedCost: 9, costSource: 'unknown' });
    assert.equal(s.totalCost, 0);
    assert.equal(s.costUnknownCalls, 1);
  });
});
