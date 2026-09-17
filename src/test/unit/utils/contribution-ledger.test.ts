import { strict as assert } from 'assert';
import { rollupContributionLedger } from '../../../utils/contribution-ledger';
import { UsageLogEntry } from '../../../utils/usage-log';

const NOW = new Date('2026-01-15T12:00:00.000Z');

function entry(over: Partial<UsageLogEntry> = {}): UsageLogEntry {
  return {
    ts: NOW.toISOString(),
    taskId: 'task-1',
    taskName: 'Task One',
    engine: 'claude-code',
    prompt: 'Please update `src/utils/auth.ts` to add token refresh handling for '
      + 'expired sessions and add regression tests for authTokenRefresh',
    tokenUsageAvailable: true,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.01,
    developerEmail: 'dev@example.com',
    ...over,
  };
}

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('rollupContributionLedger', () => {
  it('sums two calls sharing a taskId across different engines', () => {
    const entries = [
      entry({ taskId: 't1', engine: 'claude-code', developerEmail: 'a@x.com', inputTokens: 100, outputTokens: 50, ts: isoDaysAgo(2) }),
      entry({ taskId: 't1', engine: 'codex', developerEmail: 'a@x.com', inputTokens: 200, outputTokens: 80, ts: isoDaysAgo(1) }),
    ];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t1', 'completed']]),
      leads: [],
    });
    assert.equal(payload.leaderboard.length, 1);
    const row = payload.leaderboard[0];
    assert.equal(row.developerEmail, 'a@x.com');
    assert.equal(row.tasksCompleted, 1);
    assert.equal(row.totalTokens, 100 + 50 + 200 + 80);
    assert.equal(row.tokensPerTask, 100 + 50 + 200 + 80);
  });

  it('excludes a non-completed task from tokensPerTask num+denom but keeps it in totalTokens', () => {
    const entries = [
      entry({ taskId: 't2', developerEmail: 'b@x.com', inputTokens: 100, outputTokens: 50 }),
    ];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t2', 'failed']]),
      leads: [],
    });
    assert.equal(payload.totalTokens, 150);
    const row = payload.leaderboard[0];
    assert.equal(row.tasksCompleted, 0);
    assert.equal(row.tokensPerTask, null);
  });

  it('attributes two overlapping-timestamp tasks to different contributors independently', () => {
    const entries = [
      entry({ taskId: 't3', developerEmail: 'dev1@x.com', inputTokens: 10, outputTokens: 5, ts: isoDaysAgo(1) }),
      entry({ taskId: 't4', developerEmail: 'dev2@x.com', inputTokens: 20, outputTokens: 5, ts: isoDaysAgo(1) }),
    ];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t3', 'completed'], ['t4', 'completed']]),
      leads: [],
    });
    assert.equal(payload.leaderboard.length, 2);
    const dev1Row = payload.leaderboard.find(r => r.developerEmail === 'dev1@x.com');
    const dev2Row = payload.leaderboard.find(r => r.developerEmail === 'dev2@x.com');
    assert.equal(dev1Row?.totalTokens, 15);
    assert.equal(dev2Row?.totalTokens, 25);
  });

  it('contributes 0 and excludes from the denominator when tokenUsageAvailable is false, even on a completed task', () => {
    const entries = [
      entry({ taskId: 't5', developerEmail: 'c@x.com', tokenUsageAvailable: false, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    ];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t5', 'completed']]),
      leads: [],
    });
    const row = payload.leaderboard[0];
    assert.equal(row.tasksCompleted, 1);
    assert.equal(row.totalTokens, null);
    assert.equal(row.tokensPerTask, null);
    assert.equal(payload.totalTokens, 0);
  });

  it('never badges isTopThisWeek when nobody meets the volume threshold', () => {
    const entries = [
      entry({ taskId: 't6', developerEmail: 'dev1@x.com' }),
      entry({ taskId: 't7', developerEmail: 'dev2@x.com' }),
    ];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t6', 'completed'], ['t7', 'completed']]),
      leads: [],
    });
    assert.equal(payload.isTopThisWeek, false);
  });

  it('raises zero coaching cards when every prompt in the window is adequate', () => {
    const entries = [entry({ taskId: 't8' })];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t8', 'completed']]),
      leads: [],
    });
    assert.deepEqual(payload.coachingCards, []);
  });

  it('produces exactly one coaching card for a task retried twice with the same weak prompt', () => {
    const entries = [
      entry({ taskId: 't9', prompt: 'fix it', ts: isoDaysAgo(2), engine: 'claude-code' }),
      entry({ taskId: 't9', prompt: 'fix it', ts: isoDaysAgo(1), engine: 'codex' }),
    ];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t9', 'failed']]),
      leads: [],
    });
    assert.equal(payload.coachingCards.length, 1);
    assert.equal(payload.coachingCards[0].taskId, 't9');
  });

  it('excludes entries outside the rolling 7-day window', () => {
    const entries = [
      entry({ taskId: 't10', ts: isoDaysAgo(10), inputTokens: 999, outputTokens: 999 }),
      entry({ taskId: 't11', ts: isoDaysAgo(1), inputTokens: 100, outputTokens: 50 }),
    ];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t10', 'completed'], ['t11', 'completed']]),
      leads: [],
    });
    assert.equal(payload.totalTokens, 150);
    assert.equal(payload.leaderboard.reduce((n, r) => n + r.tasksCompleted, 0), 1);
  });

  it('returns a well-formed empty payload for an empty entries array without throwing', () => {
    let payload;
    assert.doesNotThrow(() => {
      payload = rollupContributionLedger([], { now: NOW, taskStatusById: new Map(), leads: [] });
    });
    assert.deepEqual(payload, {
      windowDays: 7,
      windowStart: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      windowEnd: NOW.toISOString(),
      totalTokens: 0,
      totalCostUsd: 0,
      contributorCount: 0,
      leaderboard: [],
      isTopThisWeek: false,
      volumeThreshold: 3,
      coachingCards: [],
    });
  });

  it('caps a pathologically long one-line prompt defensively, without needing a 4000-char budget', () => {
    // Regression pin for the HIGH finding: entry.prompt is always the short
    // human prompt, so the cap only needs to guard a pathological case, not
    // a ~12,000-char assembled-context blob.
    const longPrompt = 'x'.repeat(600);
    const entries = [entry({ taskId: 't12', prompt: longPrompt })];
    const payload = rollupContributionLedger(entries, {
      now: NOW,
      taskStatusById: new Map([['t12', 'completed']]),
      leads: [],
    });
    assert.equal(payload.coachingCards.length, 1);
    const card = payload.coachingCards[0];
    assert.equal(card.promptTruncated, true);
    assert.ok(card.promptText.length < 600, 'a pathological one-line prompt must still be capped');
    assert.ok(card.promptText.length < 550, 'the defensive cap must be far below the old 4000-char budget');
  });
});
