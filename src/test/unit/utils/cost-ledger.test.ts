import { strict as assert } from 'assert';
import { costLedger, CostEvent } from '../../../utils/cost-ledger';

describe('costLedger', () => {
  const unsubs: Array<() => void> = [];

  beforeEach(() => {
    costLedger.reset();
  });

  afterEach(() => {
    while (unsubs.length > 0) {
      unsubs.pop()!();
    }
    costLedger.reset();
  });

  /** Subscribe and auto-clean at the end of the test. */
  function listen(l: (e: CostEvent) => void): () => void {
    const unsub = costLedger.onRecord(l);
    unsubs.push(unsub);
    return unsub;
  }

  describe('record — happy path', () => {
    it('accumulates cost and notifies listeners', () => {
      const seen: CostEvent[] = [];
      listen((e) => seen.push(e));

      costLedger.record(
        { inputTokens: 10, outputTokens: 20, estimatedCost: 0.25 },
        { engineId: 'claude', label: 'task' }
      );

      assert.equal(costLedger.getLifetimeUsd(), 0.25);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], {
        estimatedCostUsd: 0.25,
        inputTokens: 10,
        outputTokens: 20,
        engineId: 'claude',
        label: 'task',
        lifetimeUsd: 0.25,
      });
    });

    it('defaults the label to "unattributed" and tokens to 0', () => {
      const seen: CostEvent[] = [];
      listen((e) => seen.push(e));

      costLedger.record({ estimatedCost: 1 }, { engineId: 'codex' });

      assert.equal(seen[0].label, 'unattributed');
      assert.equal(seen[0].inputTokens, 0);
      assert.equal(seen[0].outputTokens, 0);
    });

    it('reports a cumulative lifetimeUsd across records', () => {
      const totals: number[] = [];
      listen((e) => totals.push(e.lifetimeUsd));

      costLedger.record({ estimatedCost: 1 }, { engineId: 'claude' });
      costLedger.record({ estimatedCost: 2.5 }, { engineId: 'claude' });

      assert.deepEqual(totals, [1, 3.5]);
      assert.equal(costLedger.getLifetimeUsd(), 3.5);
    });

    it('records a zero cost as a real event', () => {
      const seen: CostEvent[] = [];
      listen((e) => seen.push(e));

      costLedger.record({ estimatedCost: 0 }, { engineId: 'ollama', label: 'task' });

      assert.equal(seen.length, 1);
      assert.equal(costLedger.getLifetimeUsd(), 0);
    });
  });

  describe('record — malformed usage', () => {
    const malformed: Array<[string, { estimatedCost?: number } | undefined]> = [
      ['undefined usage', undefined],
      ['missing tokenUsage fields', {}],
      ['undefined estimatedCost', { estimatedCost: undefined }],
      ['NaN', { estimatedCost: NaN }],
      ['Infinity', { estimatedCost: Infinity }],
      ['-Infinity', { estimatedCost: -Infinity }],
      ['negative cost', { estimatedCost: -1 }],
    ];

    for (const [name, usage] of malformed) {
      it(`ignores ${name}`, () => {
        let notified = 0;
        listen(() => notified++);

        costLedger.record(usage, { engineId: 'claude', label: 'task' });

        assert.equal(costLedger.getLifetimeUsd(), 0);
        assert.equal(notified, 0);
      });
    }

    it('leaves an existing total untouched when a malformed record arrives', () => {
      costLedger.record({ estimatedCost: 2 }, { engineId: 'claude' });
      costLedger.record({ estimatedCost: -5 }, { engineId: 'claude' });
      costLedger.record({ estimatedCost: NaN }, { engineId: 'claude' });

      assert.equal(costLedger.getLifetimeUsd(), 2);
    });
  });

  describe('listener isolation', () => {
    it('a throwing listener neither stops accounting nor propagates to the caller', () => {
      const after: CostEvent[] = [];
      listen(() => {
        throw new Error('listener blew up');
      });
      listen((e) => after.push(e));

      assert.doesNotThrow(() => {
        costLedger.record({ estimatedCost: 3 }, { engineId: 'claude', label: 'prd-chat' });
      });

      assert.equal(costLedger.getLifetimeUsd(), 3);
      assert.equal(after.length, 1, 'later listeners still receive the event');
      assert.equal(after[0].label, 'prd-chat');
    });

    it('a throwing listener does not break subsequent records', () => {
      listen(() => {
        throw new Error('always throws');
      });

      costLedger.record({ estimatedCost: 1 }, { engineId: 'claude' });
      costLedger.record({ estimatedCost: 1 }, { engineId: 'claude' });

      assert.equal(costLedger.getLifetimeUsd(), 2);
    });
  });

  describe('onRecord / unsubscribe', () => {
    it('unsubscribe stops delivery and drops listenerCount()', () => {
      const before = costLedger.listenerCount();
      let notified = 0;
      const unsub = costLedger.onRecord(() => notified++);
      assert.equal(costLedger.listenerCount(), before + 1);

      costLedger.record({ estimatedCost: 1 }, { engineId: 'claude' });
      assert.equal(notified, 1);

      unsub();
      assert.equal(costLedger.listenerCount(), before);

      costLedger.record({ estimatedCost: 1 }, { engineId: 'claude' });
      assert.equal(notified, 1, 'no delivery after unsubscribe');
      assert.equal(costLedger.getLifetimeUsd(), 2, 'accounting continues');
    });

    it('unsubscribing twice is harmless', () => {
      const before = costLedger.listenerCount();
      const unsub = costLedger.onRecord(() => undefined);
      unsub();
      unsub();
      assert.equal(costLedger.listenerCount(), before);
    });
  });

  describe('reset', () => {
    it('zeroes the total but keeps listeners subscribed', () => {
      let notified = 0;
      listen(() => notified++);

      costLedger.record({ estimatedCost: 5 }, { engineId: 'claude' });
      assert.equal(costLedger.getLifetimeUsd(), 5);
      const countBefore = costLedger.listenerCount();

      costLedger.reset();

      assert.equal(costLedger.getLifetimeUsd(), 0);
      assert.equal(costLedger.listenerCount(), countBefore, 'listeners survive reset');

      costLedger.record({ estimatedCost: 1 }, { engineId: 'claude' });
      assert.equal(notified, 2);
      assert.equal(costLedger.getLifetimeUsd(), 1);
    });
  });
});
