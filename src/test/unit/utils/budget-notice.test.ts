import { strict as assert } from 'assert';
import { watchUnenforceableBudget } from '../../../utils/budget-notice';
import { costLedger } from '../../../utils/cost-ledger';

describe('watchUnenforceableBudget', () => {
  it('fires once over three unreported calls', () => {
    const seen: string[] = [];
    const off = watchUnenforceableBudget({ budget: () => 10, onFirst: (e) => seen.push(e.engineId) });
    try {
      costLedger.recordUnreported({ engineId: 'claude', label: 'task' });
      costLedger.recordUnreported({ engineId: 'codex', label: 'task' });
      costLedger.recordUnreported({ engineId: 'gemini', label: 'task' });
      assert.deepEqual(seen, ['claude']);
    } finally { off(); }
  });

  it('does not fire when no budget is set', () => {
    let fired = 0;
    const off = watchUnenforceableBudget({ budget: () => 0, onFirst: () => { fired++; } });
    try {
      costLedger.recordUnreported({ engineId: 'claude' });
      assert.equal(fired, 0);
    } finally { off(); }
  });

  it('fires later if a budget is set after earlier unreported calls', () => {
    let budget = 0;
    let fired = 0;
    const off = watchUnenforceableBudget({ budget: () => budget, onFirst: () => { fired++; } });
    try {
      costLedger.recordUnreported({ engineId: 'claude' });
      budget = 5;
      costLedger.recordUnreported({ engineId: 'claude' });
      assert.equal(fired, 1);
    } finally { off(); }
  });

  it('unsubscribing removes the listener', () => {
    const before = costLedger.unreportedListenerCount();
    const off = watchUnenforceableBudget({ budget: () => 1, onFirst: () => { /* */ } });
    assert.equal(costLedger.unreportedListenerCount(), before + 1);
    off();
    assert.equal(costLedger.unreportedListenerCount(), before);
  });

  it('a throwing onFirst or budget does not stop the next listener', () => {
    const offA = watchUnenforceableBudget({ budget: () => 1, onFirst: () => { throw new Error('boom'); } });
    const offB = watchUnenforceableBudget({ budget: () => { throw new Error('bad config'); }, onFirst: () => { /* */ } });
    let next = 0;
    const offC = costLedger.onUnreported(() => { next++; });
    try {
      assert.doesNotThrow(() => costLedger.recordUnreported({ engineId: 'claude' }));
      assert.equal(next, 1);
    } finally { offA(); offB(); offC(); }
  });
});
