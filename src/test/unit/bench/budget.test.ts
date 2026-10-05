import { strict as assert } from 'assert';
import { BudgetLedger } from '../../../bench/budget';

describe('bench BudgetLedger', () => {
  it('cap 10, per-call 1, factor 1.5: the first version gets 8.5', () => {
    const b = new BudgetLedger(10, 1, 1.5);
    assert.equal(b.versionCap(1), 8.5);
    assert.equal(b.upperBoundUsd(), 0);
    assert.equal(b.mustStopNow(), false);
  });

  it('reported spend reduces the next version cap; exhausted gives null', () => {
    const b = new BudgetLedger(10, 1, 1.5);
    b.onCost({ usd: 4, source: 'reported' });
    assert.equal(b.versionCap(1), 4.5);
    b.onCost({ usd: 3.6, source: 'reported' });
    assert.equal(b.versionCap(1), null, '0.9 left is below the 1.00 minimum');
    assert.equal(b.versionCap(0.5), 0.9);
  });

  it('three unreported calls move the upper bound by three per-call caps', () => {
    const b = new BudgetLedger(10, 1, 1.5);
    b.onCost({ usd: 0.25, source: 'reported' });
    for (let i = 0; i < 3; i++) { b.onCost({ usd: 0, source: 'none' }); }
    assert.equal(b.upperBoundUsd(), 3.25);
    assert.equal(b.snapshot().unreportedCalls, 3);
    assert.equal(b.snapshot().reportedUsd, 0.25);
  });

  it('estimated cost (and a sourceless old line) counts toward the bound', () => {
    const b = new BudgetLedger(10, 1, 1.5);
    b.onCost({ usd: 2, source: 'estimated' });
    b.onCost({ usd: 1 });
    assert.equal(b.upperBoundUsd(), 3);
    assert.equal(b.snapshot().estimatedCalls, 2);
  });

  it('a malformed amount counts as an unreported call', () => {
    const b = new BudgetLedger(10, 1, 1.5);
    b.onCost({ usd: NaN, source: 'reported' });
    b.onCost({ usd: -3, source: 'reported' });
    assert.equal(b.snapshot().unreportedCalls, 2);
    assert.equal(b.upperBoundUsd(), 2);
  });

  it('mustStopNow flips once one more call could cross the cap', () => {
    const b = new BudgetLedger(5, 1, 1.5);
    b.onCost({ usd: 3.9, source: 'reported' });
    assert.equal(b.mustStopNow(), false, '3.9 + 1 <= 5');
    b.onCost({ usd: 0.2, source: 'reported' });
    assert.equal(b.mustStopNow(), true, '4.1 + 1 > 5');
  });

  it('refuses a nonsensical construction', () => {
    assert.throws(() => new BudgetLedger(0, 1, 1.5));
    assert.throws(() => new BudgetLedger(10, 0, 1.5));
    assert.throws(() => new BudgetLedger(10, 1, 0.5));
  });
});
