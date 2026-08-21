// ─── Runner cost budget: lifetime spend + repeating ceiling ───
// The budget must survive play() boundaries (a daemon tick loop calls play()
// once per tick) and must re-arm after each breach instead of latching forever.

import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { Plan, EngineResult } from '../../../models/types';
import { createEmptyPlan, createTask } from '../../../models/plan';
import { withCostAccounting, EngineAdapter } from '../../../adapters/engine';
import { costLedger } from '../../../utils/cost-ledger';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

type Handler = (...args: unknown[]) => void;

/**
 * Minimal child_process fake — the runner only spawns `git` during these runs.
 * Listener registration returns void: nothing in the git path chains off it.
 */
function createSpawnProc() {
  const handlers: Record<string, Handler[]> = {};
  const streamHandlers: Record<string, Handler[]> = {};

  const addStream = (event: string, handler: Handler): void => {
    if (!streamHandlers[event]) { streamHandlers[event] = []; }
    streamHandlers[event].push(handler);
  };
  const removeStream = (event: string, handler: Handler): void => {
    streamHandlers[event] = (streamHandlers[event] || []).filter(h => h !== handler);
  };
  const add = (event: string, handler: Handler): void => {
    if (!handlers[event]) { handlers[event] = []; }
    handlers[event].push(handler);
  };
  const remove = (event: string, handler: Handler): void => {
    handlers[event] = (handlers[event] || []).filter(h => h !== handler);
  };

  const stream = { on: addStream, removeListener: removeStream };
  const proc = {
    pid: 4321,
    killed: false,
    on: add,
    once: add,
    removeListener: remove,
    stdout: stream,
    stderr: stream,
    kill: (): boolean => true,
  };

  // Every git probe in these runs exits cleanly on the next tick.
  setTimeout(() => { (handlers['close'] || []).forEach(h => h(0)); }, 1);
  return proc;
}

interface BudgetEvent { totalCost: number; budget: number; }

/** Runners built during a test, torn off the shared ledger in afterEach. */
const liveRunners: Array<{ dispose(): void }> = [];

function buildRunner() {
  const runTask = sinon.stub();
  const engine: EngineAdapter = {
    id: 'claude',
    displayName: 'Mock Claude',
    getCommand: () => 'claude',
    runTask,
  };
  const historyStore = {
    add: sinon.stub(),
    getAll: sinon.stub().returns([]),
    getForTask: sinon.stub().returns([]),
    clear: sinon.stub(),
    onDidChange: sinon.stub(),
  };

  // The real registry stores adapters wrapped in withCostAccounting(), so a
  // bare fake here would hide the wrapper from every assertion in this file.
  const getEngine = (): ReturnType<typeof withCostAccounting> => withCostAccounting(engine);

  const { TaskRunner } = proxyquire('../../../runner/runner', {
    'vscode': vscodeMock,
    '../adapters/index': { getEngine },
    '../context/context-builder': {
      buildContext: () => '',
      getContextSettings: () => ({ enabled: false }),
    },
    'child_process': { spawn: sinon.stub().callsFake(() => createSpawnProc()), execSync: sinon.stub() },
  });

  const runner = new TaskRunner(historyStore);
  liveRunners.push(runner);
  const events: BudgetEvent[] = [];
  runner.on('budget-exceeded', (e: BudgetEvent) => events.push(e));
  return { runner, runTask, events, getEngine };
}

/** An engine result carrying an estimated cost (undefined cost = no tokenUsage block at all). */
function result(estimatedCost?: number, exitCode = 0): EngineResult {
  return {
    stdout: 'mock output',
    stderr: '',
    exitCode,
    durationMs: 10,
    tokenUsage: estimatedCost === undefined
      ? undefined
      : { inputTokens: 100, outputTokens: 50, estimatedCost },
  };
}

/** A fresh single-task plan — plans are not reused because completed tasks are skipped. */
function onePlan(name: string): Plan {
  const plan = createEmptyPlan(name);
  const pl = plan.playlists[0];
  pl.autoplay = false;
  pl.tasks.push(createTask(`${name} task`, 'Do the thing'));
  return plan;
}

describe('TaskRunner cost budget', () => {
  // The ledger is a module singleton shared by the entire suite — a record from
  // any other test file would otherwise show up in these exact-total asserts.
  beforeEach(() => {
    costLedger.reset();
  });

  afterEach(() => {
    // Every runner subscribes to the ledger in its constructor; leaking those
    // subscriptions across tests would leave stale listeners on the singleton.
    while (liveRunners.length > 0) {
      liveRunners.pop()!.dispose();
    }
    costLedger.reset();
    vscodeMock.clearMockConfig();
    sinon.restore();
  });

  it('accumulates lifetime spend across play() boundaries while per-run totals reset', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 0 });
    const { runner, runTask, events } = buildRunner();
    runTask.resolves(result(0.5));

    await runner.play(onePlan('a'));
    assert.equal(runner.getSessionCost(), 0.5);
    assert.equal(runner.getLifetimeCostUsd(), 0.5);

    await runner.play(onePlan('b'));
    assert.equal(runner.getSessionCost(), 0.5, 'per-run session cost resets on each play()');
    assert.equal(runner.getLifetimeCostUsd(), 1, 'lifetime spend survives the run reset');
    assert.equal(events.length, 0, 'budget of 0 must never fire');
  });

  it('re-arms the ceiling so it fires again a further budget-worth later', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 1 });
    const { runner, runTask, events } = buildRunner();
    runTask.resolves(result(0.75));

    await runner.play(onePlan('a')); // lifetime 0.75 — under
    assert.equal(events.length, 0);

    await runner.play(onePlan('b')); // lifetime 1.5 — breach #1, next threshold 2.5
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { totalCost: 1.5, budget: 1 });

    await runner.play(onePlan('c')); // lifetime 2.25 — under the re-armed threshold
    assert.equal(events.length, 1, 'must not re-fire before another full budget is spent');

    await runner.play(onePlan('d')); // lifetime 3.0 — breach #2
    assert.equal(events.length, 2, 'ceiling repeats instead of latching');
    assert.deepEqual(events[1], { totalCost: 3, budget: 1 });
  });

  it('disables the check entirely when the budget is zero or negative', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: -5 });
    const { runner, runTask, events } = buildRunner();
    runTask.resolves(result(5));

    await runner.play(onePlan('a'));
    await runner.play(onePlan('b'));

    assert.equal(events.length, 0);
    assert.equal(runner.getLifetimeCostUsd(), 10, 'spend is still tracked, just never enforced');
  });

  it('resetLifetimeBudget() zeroes spend and re-arms the ceiling', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 1 });
    const { runner, runTask, events } = buildRunner();
    runTask.resolves(result(0.75));

    await runner.play(onePlan('a'));
    await runner.play(onePlan('b')); // breach #1 at 1.5
    assert.equal(events.length, 1);

    runner.resetLifetimeBudget();
    assert.equal(runner.getLifetimeCostUsd(), 0);

    await runner.play(onePlan('c')); // 0.75 — under a freshly-armed budget
    assert.equal(events.length, 1);

    await runner.play(onePlan('d')); // 1.5 — breach against the fresh ceiling
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], { totalCost: 1.5, budget: 1 });
  });

  it('ignores results with no usage block or a non-finite cost', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 1 });
    const { runner, runTask, events } = buildRunner();

    runTask.resolves(result(undefined));
    await runner.play(onePlan('a'));

    runTask.resolves(result(Number.NaN));
    await runner.play(onePlan('b'));

    assert.equal(runner.getLifetimeCostUsd(), 0, 'malformed usage must not corrupt the accumulator');
    assert.equal(events.length, 0);
  });

  it('counts spend from a failed task and still trips the ceiling', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 1, autoFix: false });
    const { runner, runTask, events } = buildRunner();
    runTask.resolves(result(1.5, 1));

    await runner.play(onePlan('a'));

    assert.ok(runner.getLifetimeCostUsd() >= 1.5, 'a failed task still burned tokens');
    assert.ok(events.length >= 1, 'failed work counts against the budget');
    assert.equal(events[0].budget, 1);
  });

  // ─── Non-runner spend counts too ───

  it('trips the ceiling on an authoring call with no play() in flight', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 1 });
    const { runner, runTask, events, getEngine } = buildRunner();
    runTask.resolves(result(1.5));

    // Exactly what an authoring call site does: take the adapter out of the
    // registry and run it directly, never touching TaskRunner.play().
    await getEngine().runTask({ prompt: 'improve this PRD', cwd: '.', costLabel: 'prd-improve' });

    assert.equal(runner.state, 'idle', 'no run is in flight');
    assert.equal(runner.getLifetimeCostUsd(), 1.5, 'authoring spend reaches the ledger');
    assert.equal(events.length, 1, 'the ceiling bounds the product, not just plan execution');
    assert.deepEqual(events[0], { totalCost: 1.5, budget: 1 });
  });

  it('getSessionCost() counts only runner-executed tasks', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 0 });
    const { runner, runTask, getEngine } = buildRunner();
    runTask.resolves(result(0.5));

    await runner.play(onePlan('a'));
    assert.equal(runner.getSessionCost(), 0.5);

    runTask.resolves(result(2));
    await getEngine().runTask({ prompt: 'chat', cwd: '.', costLabel: 'prd-chat' });

    assert.equal(runner.getSessionCost(), 0.5, 'authoring spend is not run spend');
    assert.deepEqual(runner.getSessionTokens(), { tokensIn: 100, tokensOut: 50 });
    assert.equal(runner.getLifetimeCostUsd(), 2.5, 'but it does count toward lifetime spend');
  });

  it('stops emitting budget-exceeded after dispose()', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { costBudgetUsd: 1 });
    const { runner, runTask, events, getEngine } = buildRunner();
    runTask.resolves(result(5));

    runner.dispose();
    await getEngine().runTask({ prompt: 'p', cwd: '.', costLabel: 'prd-chat' });

    assert.equal(costLedger.getLifetimeUsd(), 5, 'the ledger still accounts');
    assert.equal(events.length, 0, 'a disposed runner must not emit');
  });

  it('dispose() is idempotent', () => {
    const { runner } = buildRunner();
    runner.dispose();
    assert.doesNotThrow(() => runner.dispose());
  });
});
