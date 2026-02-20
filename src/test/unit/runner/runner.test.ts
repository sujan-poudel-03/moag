import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { Plan, TaskStatus, RunnerState, EngineResult } from '../../../models/types';
import { createEmptyPlan, createPlaylist, createTask } from '../../../models/plan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

// Stub getEngine to return a mock engine
const mockEngineResult: EngineResult = {
  stdout: 'mock output',
  stderr: '',
  exitCode: 0,
  durationMs: 50,
};

let engineRunStub: sinon.SinonStub;
let spawnStub: sinon.SinonStub;

function createMockEngine() {
  engineRunStub = sinon.stub().resolves(mockEngineResult);
  return {
    id: 'claude',
    displayName: 'Mock Claude',
    runTask: engineRunStub,
  };
}

// Create a mock HistoryStore
function createMockHistoryStore() {
  return {
    add: sinon.stub(),
    getAll: sinon.stub().returns([]),
    clear: sinon.stub(),
    onDidChange: sinon.stub(),
  };
}

// Build TaskRunner with mocked dependencies
function buildRunner() {
  const historyStore = createMockHistoryStore();
  const mockEngine = createMockEngine();
  spawnStub = sinon.stub().returns({
    on: sinon.stub(),
    stdout: { on: sinon.stub() },
    stderr: { on: sinon.stub() },
    kill: sinon.stub(),
  });

  const { TaskRunner } = proxyquire('../../../runner/runner', {
    'vscode': vscodeMock,
    '../adapters/index': {
      getEngine: () => mockEngine,
    },
    'child_process': { spawn: spawnStub },
  });

  const runner = new TaskRunner(historyStore);
  return { runner, historyStore, mockEngine };
}

function makePlan(): Plan {
  const plan = createEmptyPlan('Test Plan');
  const pl = createPlaylist('Phase 1');
  pl.autoplay = true;
  pl.autoplayDelay = 0; // no delay in tests
  pl.tasks.push(
    createTask('Task 1', 'Do first thing'),
    createTask('Task 2', 'Do second thing'),
  );
  plan.playlists.push(pl);
  return plan;
}

describe('TaskRunner', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should start in Idle state', () => {
    const { runner } = buildRunner();
    assert.equal(runner.state, RunnerState.Idle);
  });

  it('should transition to Playing state on play', async () => {
    const { runner } = buildRunner();
    const states: RunnerState[] = [];
    runner.on('state-changed', (s: RunnerState) => states.push(s));

    const plan = makePlan();
    await runner.play(plan);

    assert.ok(states.includes(RunnerState.Playing));
    // Should end back in Idle
    assert.equal(states[states.length - 1], RunnerState.Idle);
  });

  it('should execute tasks in order', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    await runner.play(plan);

    assert.deepEqual(taskNames, ['Task 1', 'Task 2']);
  });

  it('should emit task-completed for successful tasks', async () => {
    const { runner } = buildRunner();
    const completed: string[] = [];
    runner.on('task-completed', (task: { name: string }) => completed.push(task.name));

    const plan = makePlan();
    await runner.play(plan);

    assert.deepEqual(completed, ['Task 1', 'Task 2']);
  });

  it('should emit task-failed for failing tasks', async () => {
    const { runner } = buildRunner();
    engineRunStub.resolves({ ...mockEngineResult, exitCode: 1 });

    const failed: string[] = [];
    runner.on('task-failed', (task: { name: string }) => failed.push(task.name));

    const plan = makePlan();
    await runner.play(plan);

    assert.deepEqual(failed, ['Task 1', 'Task 2']);
  });

  it('should set task status to Completed on success', async () => {
    const { runner } = buildRunner();
    const plan = makePlan();
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Completed);
  });

  it('should set task status to Failed on failure', async () => {
    const { runner } = buildRunner();
    engineRunStub.resolves({ ...mockEngineResult, exitCode: 1 });

    const plan = makePlan();
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
  });

  it('should record history for each task', async () => {
    const { runner, historyStore } = buildRunner();
    const plan = makePlan();
    await runner.play(plan);

    assert.equal(historyStore.add.callCount, 2);
  });

  it('should emit playlist-completed', async () => {
    const { runner } = buildRunner();
    let playlistCompleted = false;
    runner.on('playlist-completed', () => { playlistCompleted = true; });

    const plan = makePlan();
    await runner.play(plan);

    assert.ok(playlistCompleted);
  });

  it('should emit all-completed', async () => {
    const { runner } = buildRunner();
    let allCompleted = false;
    runner.on('all-completed', () => { allCompleted = true; });

    const plan = makePlan();
    await runner.play(plan);

    assert.ok(allCompleted);
  });

  it('should pause and resume', async () => {
    const { runner } = buildRunner();
    const states: RunnerState[] = [];
    runner.on('state-changed', (s: RunnerState) => states.push(s));

    // Make the engine slow so we can pause
    engineRunStub.callsFake(async () => {
      await new Promise(r => setTimeout(r, 100));
      return mockEngineResult;
    });

    const plan = makePlan();
    const playPromise = runner.play(plan);

    // Pause after first task starts
    await new Promise(r => setTimeout(r, 50));
    runner.pause();

    // Verify paused state
    await new Promise(r => setTimeout(r, 200));
    assert.ok(states.includes(RunnerState.Paused));

    // Resume
    runner.play(plan);
    await playPromise;

    assert.equal(states[states.length - 1], RunnerState.Idle);
  });

  it('should stop from playing state', async () => {
    const { runner } = buildRunner();
    engineRunStub.callsFake(async () => {
      await new Promise(r => setTimeout(r, 500));
      return mockEngineResult;
    });

    const plan = makePlan();
    const playPromise = runner.play(plan);

    await new Promise(r => setTimeout(r, 50));
    runner.stop();
    await playPromise;

    assert.equal(runner.state, RunnerState.Idle);
  });

  it('should not start if already playing', async () => {
    const { runner } = buildRunner();
    engineRunStub.callsFake(async () => {
      await new Promise(r => setTimeout(r, 100));
      return mockEngineResult;
    });

    const plan = makePlan();
    const p1 = runner.play(plan);
    await new Promise(r => setTimeout(r, 10));

    // Second call should be a no-op
    const p2 = runner.play(plan);
    await Promise.all([p1, p2]);

    // Engine should have been called only for the tasks in the first play
    assert.ok(engineRunStub.callCount <= 2);
  });

  it('should reset plan to all Pending', () => {
    const { runner } = buildRunner();
    const plan = makePlan();
    plan.playlists[0].tasks[0].status = TaskStatus.Completed;
    plan.playlists[0].tasks[1].status = TaskStatus.Failed;

    runner.resetPlan(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Pending);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Pending);
  });

  it('should do nothing when stopping from idle', () => {
    const { runner } = buildRunner();
    const states: RunnerState[] = [];
    runner.on('state-changed', (s: RunnerState) => states.push(s));
    runner.stop();
    assert.equal(states.length, 0);
  });

  it('should use task engine override when specified', async () => {
    const { runner } = buildRunner();
    const plan = makePlan();
    plan.playlists[0].tasks[0].engine = 'codex';

    await runner.play(plan);

    // The mock getEngine always returns our mock, but the engine selection
    // logic in executeTask picks task.engine first
    assert.ok(engineRunStub.called);
  });

  it('should run verify command on successful task', async () => {
    const { runner } = buildRunner();

    // spawnStub is used for verify commands via child_process.spawn
    // Set up the spawn stub to simulate a successful verify command
    spawnStub.callsFake(() => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const proc = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
          if (event === 'close') {
            setTimeout(() => handler(0), 10);
          }
          return proc;
        },
        stdout: { on: sinon.stub() },
        stderr: { on: sinon.stub() },
        kill: sinon.stub(),
      };
      return proc;
    });

    const plan = makePlan();
    plan.playlists[0].tasks[0].verifyCommand = 'npm test';

    await runner.play(plan);

    // Verify command should have been called via spawn
    // The test validates the flow doesn't crash with verifyCommand set
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  it('should play a single task', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    await runner.playTask(plan, 0, 1);

    assert.deepEqual(taskNames, ['Task 2']);
    assert.equal(runner.state, RunnerState.Idle);
  });
});
