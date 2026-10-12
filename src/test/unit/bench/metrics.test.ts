import { strict as assert } from 'assert';
import {
  buildVersionMetrics, costPerRequirementShipped, emptyObservation, environmentFindings, errorLine, summarize, VersionObservation,
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
    assert.deepEqual(m.moagVerify, { passed: true, failedGate: null, failedCommand: null });
    assert.deepEqual(m.environment, []);
  });

  it('environmentFindings: only a probe that failed in the untouched workspace AND is the failing command counts', () => {
    const failing = { command: 'npm test', exitCode: 1, timedOut: false, durationMs: 2000, pass: false, detail: 'ReferenceError: require is not defined in ES module scope' };
    const passing = { command: 'npm run lint', exitCode: 0, timedOut: false, durationMs: 9000, pass: true, detail: null };
    const env = { node: 'v24.16.0', probes: [passing, failing] };
    const verify = environmentFindings(env, ' npm test ', []);
    assert.equal(verify.length, 1);
    assert.match(verify[0], /^environment: Node v24\.16\.0 cannot run "npm test": it exits 1 in the untouched workspace, before any plan \(ReferenceError: require is not defined in ES module scope\)\. MOAG's own verify stopped at this command\.$/);
    assert.deepEqual(environmentFindings(env, 'npm run lint', []), [], 'a probe that passed is never an environment failure');
    assert.deepEqual(environmentFindings(env, 'npm test -- --grep x', []), [], 'a different command is a product outcome');
    assert.deepEqual(environmentFindings(env, null, []), [], 'no failed command, no finding');
    assert.deepEqual(environmentFindings({ node: 'v20.20.2', probes: [{ ...failing, pass: true, exitCode: 0, detail: null }] }, 'npm test', []), [],
      'where the suite runs (Node 20), a verify failure stays a product failure');
    const task = environmentFindings(env, null, [{ name: 'Run tests', command: 'npm test' }, { name: 'Lint', command: 'npm run lint' }]);
    assert.equal(task.length, 1);
    assert.match(task[0], /task "Run tests" runs this command and failed\.$/);
    assert.match(environmentFindings({ node: null, probes: [{ ...failing, exitCode: null, timedOut: true, detail: null }] }, 'npm test', [])[0],
      /^environment: this machine cannot run "npm test": it times out in the untouched workspace, before any plan\. /);
    assert.match(environmentFindings({ node: null, probes: [{ ...failing, exitCode: null, detail: null }] }, 'npm test', [])[0], /it does not start/);
  });

  it('errorLine picks the last line that mentions an error, capped at 300 characters', () => {
    assert.equal(errorLine('ok\n Exception during run: ReferenceError: require is not defined\n    at file:///x.ts:4:20\n'), 'Exception during run: ReferenceError: require is not defined');
    assert.equal(errorLine('all good\n'), null);
    assert.equal(errorLine(`Error: ${'x'.repeat(400)}`)?.length, 300);
  });

  it('a failed verify carries the command it stopped at and the environment findings into the metrics', () => {
    const m = buildVersionMetrics(shippedV2({
      trace: {}, endState: 'run-gaps',
      verifyFinished: [{ passed: false, failedGate: 'command', iterations: 1, failedCommand: 'npm test' }],
      environment: ['environment: Node v24.16.0 cannot run "npm test": it exits 1 in the untouched workspace, before any plan. MOAG\'s own verify stopped at this command.'],
    }), 1);
    assert.deepEqual(m.moagVerify, { passed: false, failedGate: 'command', failedCommand: 'npm test' });
    assert.equal(m.environment.length, 1);
    assert.equal(m.outcome, 'not-shipped', 'the outcome is not rewritten: nothing shipped');
    assert.equal(m.endState, 'run-gaps');
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
      harnessError: null, exitCode: 0, workspace: null, engine: { id: 'claude', version: null, probeVersion: null },
      environment: { node: null, probes: [] }, eventsTruncated: false, notes: [],
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
