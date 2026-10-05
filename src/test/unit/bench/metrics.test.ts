import { strict as assert } from 'assert';
import {
  buildVersionMetrics, costPerRequirementShipped, emptyObservation, summarize, VersionObservation,
} from '../../../bench/metrics';
import { BudgetLedger } from '../../../bench/budget';

const AT = '2026-10-05T00:00:00.000Z';

function shippedV2(over: Partial<VersionObservation> = {}): VersionObservation {
  return {
    ...emptyObservation('v2', 'patch'),
    recommendedBump: 'minor',
    bumpOverridden: true,
    requirementsAdded: [],
    requirementsChanged: ['R-2', 'R-3'],
    tasksGenerated: 3,
    finalTasks: [
      { id: 'a', name: 'A', type: 'agent', status: 'completed' },
      { id: 'b', name: 'B', type: 'agent', status: 'completed' },
      { id: 't', name: 'Tests', type: 'command', status: 'completed' },
      { id: 'g', name: 'Ship approval', type: 'manual', status: 'completed' },
    ],
    costEvents: [{ usd: 0.5, source: 'reported' }, { usd: 0.25, source: 'reported' }],
    savedAtMs: 1_000,
    shippedAtMs: 61_000,
    required: [{ kind: 'plan-approval', at: AT }, { kind: 'ship-approval', at: AT }],
    unplanned: [{ kind: 'bump-override', at: AT, detail: 'recommended minor, intended patch' }],
    trace: { 'R-2': 'shipped', 'R-3': 'shipped', 'R-1': 'shipped' },
    verifyFinished: [{ passed: true, failedGate: null, iterations: 1 }],
    taskStarts: ['a', 'b', 'a', 't'],
    ...over,
  };
}

describe('bench metrics', () => {
  it('a shipped version: bump mismatch, counts, cost, wall clock and interventions', () => {
    const m = buildVersionMetrics(shippedV2(), 1);
    assert.equal(m.outcome, 'shipped');
    assert.equal(m.bumpMatch, false);
    assert.equal(m.bumpOverridden, true);
    assert.equal(m.requirementsChanged, 2);
    assert.equal(m.requirementsShipped, 2, 'only this version\'s ids count (R-1 is not in scope)');
    assert.equal(m.tasksCompleted, 3, 'the ship gate is not counted');
    assert.equal(m.costUsd, 0.75);
    assert.equal(m.costPerRequirementShippedUsd, 0.375);
    assert.equal(m.wallClockMs, 60_000);
    assert.equal(m.endState, null);
    assert.deepEqual(m.interventions.required.map((i) => i.kind), ['plan-approval', 'ship-approval']);
    assert.deepEqual(m.interventions.unplanned.map((i) => i.kind), ['bump-override']);
    assert.equal(m.fixIterations, 1);
    assert.equal(m.taskRestarts, 1, 'a was started twice');
    assert.deepEqual(m.moagVerify, { passed: true, failedGate: null });
  });

  it('any unreported or estimated call makes the cost unknown, keeping the reported part', () => {
    const none = buildVersionMetrics(shippedV2({ costEvents: [{ usd: 0.5, source: 'reported' }, { usd: 0, source: 'none' }] }), 1);
    assert.equal(none.costUsd, 'unknown');
    assert.equal(none.reportedUsd, 0.5);
    assert.equal(none.unreportedCalls, 1);
    assert.equal(none.upperBoundUsd, 1.5);
    assert.equal(none.costPerRequirementShippedUsd, 'unknown');
    const est = buildVersionMetrics(shippedV2({ costEvents: [{ usd: 0.5, source: 'estimated' }] }), 1);
    assert.equal(est.costUsd, 'unknown');
    assert.equal(est.estimatedCalls, 1);
  });

  it('bumpMatch is null for the initial version and true on a match', () => {
    assert.equal(buildVersionMetrics({ ...emptyObservation('v1', 'initial'), recommendedBump: null }, 1).bumpMatch, null);
    assert.equal(buildVersionMetrics(shippedV2({ intendedBump: 'minor' }), 1).bumpMatch, true);
  });

  it('partial and failed versions: outcome, end state, no wall clock, null cost per requirement', () => {
    const partial = buildVersionMetrics(shippedV2({ trace: { 'R-2': 'shipped', 'R-3': 'in-progress' }, endState: 'run-gaps' }), 1);
    assert.equal(partial.outcome, 'partially-shipped');
    assert.equal(partial.wallClockMs, null);
    assert.equal(partial.endState, 'run-gaps');
    const none = buildVersionMetrics(shippedV2({ trace: {}, endState: 'ship-rejected' }), 1);
    assert.equal(none.outcome, 'not-shipped');
    assert.equal(none.costPerRequirementShippedUsd, null);
    assert.equal(buildVersionMetrics({ ...emptyObservation('v3', 'minor'), planFailed: true, endState: 'plan-parse-failed' }, 1).outcome, 'plan-failed');
    assert.equal(buildVersionMetrics({ ...emptyObservation('v3', 'minor'), notRunBudget: true }, 1).outcome, 'not run (budget)');
    assert.equal(buildVersionMetrics({ ...emptyObservation('v3', 'minor'), noDelta: true }, 1).outcome, 'no-delta');
    assert.equal(buildVersionMetrics({ ...emptyObservation('v3', 'minor'), error: 'boom' }, 1).outcome, 'error');
  });

  it('costPerRequirementShipped', () => {
    assert.equal(costPerRequirementShipped('unknown', 3), 'unknown');
    assert.equal(costPerRequirementShipped(3, 0), null);
    assert.equal(costPerRequirementShipped(3, 2), 1.5);
  });

  it('summarize totals the versions and marks the total cost unknown when any call was not reported', () => {
    const b = new BudgetLedger(10, 1, 1.5);
    b.onCost({ usd: 0.5, source: 'reported' });
    const v = [buildVersionMetrics(shippedV2(), 1), buildVersionMetrics({ ...emptyObservation('v3', 'minor'), notRunBudget: true }, 1)];
    const meta = {
      scenario: 's', scenarioFile: 'f', mode: 'dry-run' as const, startedAt: AT, endedAt: AT, aborted: false, stoppedForBudget: false,
      harnessError: null, exitCode: 0, workspace: null, engine: { id: 'claude', version: null, probeVersion: null }, eventsTruncated: false, notes: [],
    };
    const s = summarize(v, b.snapshot(), meta);
    assert.equal(s.totals.requirementsShipped, 2);
    assert.equal(s.totals.interventionsRequired, 2);
    assert.equal(s.totals.interventionsUnplanned, 1);
    assert.equal(s.totals.costUsd, 0.5);
    b.onCost({ usd: 0, source: 'none' });
    assert.equal(summarize(v, b.snapshot(), meta).totals.costUsd, 'unknown');
  });
});
