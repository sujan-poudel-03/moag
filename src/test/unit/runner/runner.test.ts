import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { Plan, Task, TaskStatus, RunnerState, EngineResult, EngineId } from '../../../models/types';
import { createEmptyPlan, createPlaylist, createTask } from '../../../models/plan';
import type { EngineCallUsage } from '../../../utils/usage-log';

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
/** Every process the runner asked to have killed, through the stubbed `utils/process-kill`. */
let killProcessStub: sinon.SinonStub;
/** The dependency installer the runner sees; ok and silent unless a test replaces it. */
let ensureDepsStub: sinon.SinonStub;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realDependencyInstall = require('../../../runner/dependency-install');

function createSpawnProc(options?: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  closeCode?: number;
  keepOpen?: boolean;
}) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const stdoutHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const stderrHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    pid: 1234,
    killed: false,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) { handlers[event] = []; }
      handlers[event].push(handler);
      return proc;
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) { handlers[event] = []; }
      const onceHandler = (...args: unknown[]) => {
        handler(...args);
        handlers[event] = (handlers[event] || []).filter(h => h !== onceHandler);
      };
      handlers[event].push(onceHandler);
      return proc;
    },
    stdout: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (!stdoutHandlers[event]) { stdoutHandlers[event] = []; }
        stdoutHandlers[event].push(handler);
        return proc.stdout;
      },
      removeListener: (event: string, handler: (...args: unknown[]) => void) => {
        stdoutHandlers[event] = (stdoutHandlers[event] || []).filter(h => h !== handler);
        return proc.stdout;
      },
    },
    stderr: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (!stderrHandlers[event]) { stderrHandlers[event] = []; }
        stderrHandlers[event].push(handler);
        return proc.stderr;
      },
      removeListener: (event: string, handler: (...args: unknown[]) => void) => {
        stderrHandlers[event] = (stderrHandlers[event] || []).filter(h => h !== handler);
        return proc.stderr;
      },
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = (handlers[event] || []).filter(h => h !== handler);
      return proc;
    },
    kill: sinon.stub().callsFake(() => {
      proc.killed = true;
      return true;
    }),
  };
  // Expose handler maps for tests that need to emit service output after spawn.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proc as any).__stdoutHandlers = stdoutHandlers;
  // Emit a process event (`close`, `error`) to whatever is listening right now.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proc as any).__emit = (event: string, ...args: unknown[]) => { [...(handlers[event] || [])].forEach(h => h(...args)); };

  if (!options?.keepOpen) {
    setTimeout(() => {
      (options?.stdoutChunks ?? []).forEach(chunk => {
        (stdoutHandlers['data'] || []).forEach(h => h(Buffer.from(chunk)));
      });
      (options?.stderrChunks ?? []).forEach(chunk => {
        (stderrHandlers['data'] || []).forEach(h => h(Buffer.from(chunk)));
      });
      (handlers['close'] || []).forEach(h => h(options?.closeCode ?? 0));
    }, 5);
  }

  return proc;
}

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
    getForTask: sinon.stub().returns([]),
    clear: sinon.stub(),
    onDidChange: sinon.stub(),
  };
}

// Build TaskRunner with mocked dependencies
function buildRunner(routingOverrides?: {
  '../routing/routing-store'?: { loadWorkspaceRoutingConfig: (root: string) => unknown };
}) {
  const historyStore = createMockHistoryStore();
  const mockEngine = createMockEngine();
  spawnStub = sinon.stub().callsFake(() => createSpawnProc());
  // The real helper shells out (`taskkill /pid <pid> /T /F` on Windows, a group signal on
  // POSIX) with its OWN child_process import, which the stub below does not reach: left in
  // place it spends real process-spawn time inside a test and aims a real kill at the fake
  // pid 1234. Here it only marks the fake process killed, as a real kill would.
  killProcessStub = sinon.stub().callsFake((proc: { kill?: () => void }) => { proc.kill?.(); });
  ensureDepsStub = sinon.stub().resolves({ ok: true, aborted: false, failed: null, events: [] });

  let lastEngineId: string | undefined;

  const { TaskRunner } = proxyquire('../../../runner/runner', {
    'vscode': vscodeMock,
    '../adapters/index': {
      getEngine: (id: string) => { lastEngineId = id; return mockEngine; },
    },
    '../context/context-builder': {
      buildContext: () => '',
      getContextSettings: () => ({ enabled: false }),
    },
    'child_process': { spawn: spawnStub, execSync: sinon.stub() },
    '../utils/process-kill': { killProcess: killProcessStub, SPAWN_DETACHED: false },
    './dependency-install': {
      ...realDependencyInstall,
      ensureDependencies: (...args: unknown[]) => ensureDepsStub(...args),
    },
    ...(routingOverrides ?? {}),
  });

  const runner = new TaskRunner(historyStore);
  return { runner, historyStore, mockEngine, getLastEngineId: () => lastEngineId };
}

function makePlan(): Plan {
  const plan = createEmptyPlan('Test Plan');
  // Use the default playlist that createEmptyPlan provides
  const pl = plan.playlists[0];
  pl.name = 'Phase 1';
  pl.autoplay = true;
  pl.autoplayDelay = 0; // no delay in tests
  pl.tasks.push(
    createTask('Task 1', 'Do first thing'),
    createTask('Task 2', 'Do second thing'),
  );
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

  it('should execute command tasks without using an agent engine', async () => {
    const { runner, historyStore } = buildRunner();
    spawnStub.callsFake((command: string) => {
      if (command === 'git') {
        return createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 });
      }
      return createSpawnProc({ stdoutChunks: ['command ok'], closeCode: 0 });
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'command';
    plan.playlists[0].tasks[0].command = 'npm test';

    await runner.play(plan);

    assert.equal(engineRunStub.callCount, 0);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    const entry = historyStore.add.firstCall.args[0];
    assert.equal(entry.taskType, 'command');
    assert.equal(entry.result.command, 'npm test');
  });

  it('should mark blocked when failurePolicy is mark-blocked', async () => {
    const { runner, historyStore } = buildRunner();
    spawnStub.callsFake((command: string) => {
      if (command === 'git') {
        return createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 });
      }
      return createSpawnProc({ stderrChunks: ['boom'], closeCode: 1 });
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'command';
    plan.playlists[0].tasks[0].command = 'npm test';
    plan.playlists[0].tasks[0].failurePolicy = 'mark-blocked';

    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Blocked);
    const entry = historyStore.add.firstCall.args[0];
    assert.equal(entry.status, TaskStatus.Blocked);
  });

  it('should fail when expected artifacts are missing', async () => {
    const { runner, historyStore } = buildRunner();
    spawnStub.callsFake((command: string) => {
      if (command === 'git') {
        return createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 });
      }
      return createSpawnProc({ stdoutChunks: ['done'], closeCode: 0 });
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'command';
    plan.playlists[0].tasks[0].command = 'npm run build';
    plan.playlists[0].tasks[0].expectedArtifacts = ['dist/output.js'];

    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    const entry = historyStore.add.firstCall.args[0];
    assert.equal(entry.artifacts[0].target, 'dist/output.js');
    assert.equal(entry.artifacts[0].exists, false);
  });

  it('should keep a service task running after it becomes ready', async () => {
    const { runner } = buildRunner();
    const serviceProc = createSpawnProc({ keepOpen: true });
    // No real time decides this test. The runner polls readiness on an interval; only that
    // interval is faked (the git stub above still closes on a real timer), and the test fires
    // it itself. Before, a 10 ms timer raced a 400 ms poll against mocha's 2 s limit.
    const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let polls = 0;
    spawnStub.callsFake((command: string) => {
      if (command === 'git') {
        return createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 });
      }
      // runServiceTask attaches its output listeners and starts its readiness poll in the
      // same synchronous stretch that called spawn(), so by the time this microtask runs
      // both exist: the service prints its ready line, then the poll fires once.
      queueMicrotask(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handlers = (serviceProc as any).__stdoutHandlers;
        (handlers?.data ?? []).forEach((handler: (...args: unknown[]) => void) => handler(Buffer.from('server ready')));
        polls = clock.countTimers();
        clock.next();
      });
      return serviceProc;
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'service';
    plan.playlists[0].tasks[0].command = 'npm run dev';
    plan.playlists[0].tasks[0].readyPattern = 'server ready';

    try {
      await runner.play(plan);

      assert.equal(polls, 1, 'the readiness poll was the one pending interval when the service printed its line');
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
      assert.equal(runner.getRunningServices().length, 1);
      assert.equal(clock.countTimers(), 0, 'the poll was cleared once the service was ready');
      assert.equal(killProcessStub.called, false, 'a ready service is kept, not killed');
      runner.stopAllServices();
      assert.equal(killProcessStub.calledOnceWithExactly(serviceProc), true, 'stopping the services kills it, once');
      assert.equal(runner.getRunningServices().length, 0);
    } finally {
      runner.stopAllServices();
      clock.restore();
    }
  });

  it('should fail a service task whose process exits before it is ready, and keep nothing running', async () => {
    const { runner } = buildRunner();
    const serviceProc = createSpawnProc({ keepOpen: true });
    const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    spawnStub.callsFake((command: string) => {
      if (command === 'git') {
        return createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 });
      }
      // The process dies before any readiness poll fires: same sequencing, no timer.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queueMicrotask(() => { (serviceProc as any).__emit('close', 3); });
      return serviceProc;
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'service';
    plan.playlists[0].tasks[0].command = 'npm run dev';
    plan.playlists[0].tasks[0].readyPattern = 'server ready';

    try {
      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
      assert.equal(runner.getRunningServices().length, 0);
      assert.equal(clock.countTimers(), 0, 'the readiness poll does not outlive the failed start');
      assert.equal(killProcessStub.calledWith(serviceProc), true, 'what is left of the failed start is killed');
    } finally {
      runner.stopAllServices();
      clock.restore();
    }
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

  // ─── currentPlan / currentRunTaskIds ───

  describe('current run scope getters', () => {
    /** Records both getters at the moment the runner announces `playing`. */
    function capture(runner: { on: (e: string, h: (s: RunnerState) => void) => void; currentPlan: Plan | null; currentRunTaskIds: readonly string[] | null }) {
      const seen: Array<{ plan: Plan | null; ids: readonly string[] | null }> = [];
      runner.on('state-changed', (s: RunnerState) => {
        if (s === RunnerState.Playing) {
          seen.push({ plan: runner.currentPlan, ids: runner.currentRunTaskIds ? [...runner.currentRunTaskIds] : null });
        }
      });
      return seen;
    }

    it('play() exposes the plan and no task scope from the playing emit', async () => {
      const { runner } = buildRunner();
      const seen = capture(runner);
      const plan = makePlan();
      await runner.play(plan);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].plan, plan);
      assert.equal(seen[0].ids, null);
    });

    it('playTask() scopes the run to that one task', async () => {
      const { runner } = buildRunner();
      const seen = capture(runner);
      const plan = makePlan();
      await runner.playTask(plan, 0, 1);
      assert.equal(seen[0].plan, plan);
      assert.deepEqual(seen[0].ids, [plan.playlists[0].tasks[1].id]);
      assert.deepEqual(runner.currentRunTaskIds, [plan.playlists[0].tasks[1].id], 'never cleared at idle');
    });

    it('playTasks() scopes the run to the resolved ids and skips missing ones', async () => {
      const { runner } = buildRunner();
      const seen = capture(runner);
      const plan = makePlan();
      await runner.playTasks(plan, [
        { playlistIndex: 0, taskIndex: 1 },
        { playlistIndex: 0, taskIndex: 7 },
        { playlistIndex: 3, taskIndex: 0 },
        { playlistIndex: 0, taskIndex: 0 },
      ]);
      assert.equal(seen[0].plan, plan);
      assert.deepEqual(seen[0].ids, [plan.playlists[0].tasks[1].id, plan.playlists[0].tasks[0].id]);
    });

    it('a play() from a later playlist scopes the run to playlists [index..end]', async () => {
      const { runner } = buildRunner();
      const seen = capture(runner);
      const plan = makePlan();
      const pl2 = createPlaylist('Phase 2');
      pl2.autoplayDelay = 0;
      pl2.tasks.push(createTask('Task 3', 'Do third thing'));
      const pl3 = createPlaylist('Phase 3');
      pl3.autoplayDelay = 0;
      pl3.tasks.push(createTask('Task 4', 'Do fourth thing'));
      plan.playlists.push(pl2, pl3);
      await runner.playPlaylist(plan, 1);
      assert.deepEqual(seen[0].ids, [pl2.tasks[0].id, pl3.tasks[0].id]);
      // From index 0 it is the whole plan again.
      await runner.playPlaylist(plan, 0);
      assert.equal(seen[1].ids, null);
    });

    it('a play() after a playTask() resets the task scope to null', async () => {
      const { runner } = buildRunner();
      const seen = capture(runner);
      const plan = makePlan();
      await runner.playTask(plan, 0, 0);
      const plan2 = makePlan();
      await runner.play(plan2);
      assert.equal(seen.length, 2);
      assert.equal(seen[1].plan, plan2);
      assert.equal(seen[1].ids, null);
      assert.equal(runner.currentRunTaskIds, null);
    });

    it('a play() rejected by the play lock changes neither getter', async () => {
      const { runner } = buildRunner();
      const plan = makePlan();
      await runner.playTask(plan, 0, 0);
      const ids = runner.currentRunTaskIds;
      (runner as unknown as { _playLock: boolean })._playLock = true;
      await runner.play(makePlan());
      assert.equal(runner.currentPlan, plan);
      assert.equal(runner.currentRunTaskIds, ids);
      (runner as unknown as { _playLock: boolean })._playLock = false;
    });
  });

  it('should retry a failed task when retryCount is set', async function () {
    this.timeout(10000);
    const { runner } = buildRunner();
    // Stub the sleep method to avoid the 2s retry delay
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(Object.getPrototypeOf(runner), 'sleep').resolves();
    let callCount = 0;
    engineRunStub.callsFake(async () => {
      callCount++;
      // Fail on first attempt, succeed on second
      if (callCount === 1) {
        return { ...mockEngineResult, exitCode: 1 };
      }
      return mockEngineResult;
    });

    const plan = makePlan();
    // Only one task with retryCount
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].retryCount = 1;
    plan.playlists[0].autoplayDelay = 0;

    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(callCount, 2);
  });

  it('should skip task when dependency is not met', async () => {
    const { runner } = buildRunner();
    engineRunStub.resolves({ ...mockEngineResult, exitCode: 1 });

    const plan = makePlan();
    plan.playlists[0].tasks[0].id = 'dep-task';
    plan.playlists[0].tasks[1].dependsOn = ['dep-task'];
    plan.playlists[0].autoplayDelay = 0;

    await runner.play(plan);

    // First task fails
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    // Second task should be blocked because its dependency failed
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Blocked);
  });

  it('should run tasks in parallel when playlist.parallel is true', async () => {
    const { runner } = buildRunner();
    const startedTasks: string[] = [];
    runner.on('task-started', (task: { name: string }) => startedTasks.push(task.name));

    const plan = makePlan();
    plan.playlists[0].parallel = true;

    await runner.play(plan);

    // Both tasks should have started
    assert.ok(startedTasks.includes('Task 1'));
    assert.ok(startedTasks.includes('Task 2'));
    assert.equal(runner.state, RunnerState.Idle);
  });

  it('should force sequential execution in fail-safe mode even when playlist.parallel is true', async () => {
    const { runner } = buildRunner();
    let inFlight = 0;
    let maxInFlight = 0;
    engineRunStub.callsFake(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 30));
      inFlight--;
      return mockEngineResult;
    });

    vscodeMock.setMockConfig('agentTaskPlayer', { failSafeMode: true });

    const plan = makePlan();
    plan.playlists[0].parallel = true;

    await runner.play(plan);

    assert.equal(maxInFlight, 1, 'fail-safe mode must prevent concurrent task execution');
    vscodeMock.clearMockConfig();
  });

  it('should skip completed tasks on resume', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    // Mark first task as already completed
    plan.playlists[0].tasks[0].status = TaskStatus.Completed;

    await runner.play(plan);

    // Only second task should have been executed
    assert.deepEqual(taskNames, ['Task 2']);
  });

  it('should prevent concurrent play() via mutex', async () => {
    const { runner } = buildRunner();
    let startCount = 0;
    runner.on('task-started', () => { startCount++; });

    engineRunStub.callsFake(async () => {
      await new Promise(r => setTimeout(r, 50));
      return mockEngineResult;
    });

    const plan = makePlan();
    const p1 = runner.play(plan);
    // Immediate second call should be blocked by mutex
    const p2 = runner.play(plan);
    await Promise.all([p1, p2]);

    // Should only have run tasks from the first play invocation
    assert.ok(startCount <= 2, `Expected at most 2 task starts, got ${startCount}`);
  });

  it('should clean up abort controller after play finishes', async () => {
    const { runner } = buildRunner();
    const plan = makePlan();
    await runner.play(plan);

    // After play finishes, abort controller should be null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((runner as any)._abortController, null);
  });

  it('should return to Idle after stop from pause', async () => {
    const { runner } = buildRunner();
    engineRunStub.callsFake(async () => {
      await new Promise(r => setTimeout(r, 200));
      return mockEngineResult;
    });

    const plan = makePlan();
    const playPromise = runner.play(plan);

    await new Promise(r => setTimeout(r, 50));
    runner.pause();
    await new Promise(r => setTimeout(r, 50));
    runner.stop();
    await playPromise;

    assert.equal(runner.state, RunnerState.Idle);
  });

  it('should not allow playTask when runner is busy', async () => {
    const { runner } = buildRunner();
    engineRunStub.callsFake(async () => {
      await new Promise(r => setTimeout(r, 100));
      return mockEngineResult;
    });

    const plan = makePlan();
    const p1 = runner.play(plan);
    await new Promise(r => setTimeout(r, 10));

    // playTask while playing should be rejected
    await runner.playTask(plan, 0, 0);
    await p1;

    assert.equal(runner.state, RunnerState.Idle);
  });

  // ─── skipIf Tests ───

  it('should skip task when skipIf condition matches', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    plan.playlists[0].tasks[0].id = 'task-a';
    plan.playlists[0].tasks[0].status = TaskStatus.Completed;
    // Task 2 should be skipped because task-a is Completed
    plan.playlists[0].tasks[1].skipIf = { taskId: 'task-a', status: TaskStatus.Completed };

    await runner.play(plan);

    // Task 1 was already completed (skipped on resume), Task 2 skipped via skipIf
    assert.deepEqual(taskNames, []);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Skipped);
  });

  it('should emit task-completed with Skipped status when skipIf matches', async () => {
    const { runner } = buildRunner();
    const completedTasks: Array<{ name: string; status: TaskStatus }> = [];
    runner.on('task-completed', (task: { name: string; status: TaskStatus }) => {
      completedTasks.push({ name: task.name, status: task.status });
    });

    const plan = makePlan();
    plan.playlists[0].tasks[0].id = 'task-1';
    plan.playlists[0].tasks[0].status = TaskStatus.Completed;
    plan.playlists[0].tasks[1].skipIf = { taskId: 'task-1', status: TaskStatus.Completed };

    await runner.play(plan);

    // Task 2 should appear in task-completed with Skipped status
    const task2Event = completedTasks.find(t => t.name === 'Task 2');
    assert.ok(task2Event, 'task-completed should fire for skipped task');
    assert.equal(task2Event!.status, TaskStatus.Skipped);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Skipped);
  });

  it('should skip task and emit task-completed(Skipped) using auto-generated task id', async () => {
    const { runner } = buildRunner();
    const completedEvents: Array<{ name: string; status: TaskStatus }> = [];
    runner.on('task-completed', (task: { name: string; status: TaskStatus }) => {
      completedEvents.push({ name: task.name, status: task.status });
    });

    const plan = makePlan();
    const task1 = plan.playlists[0].tasks[0];
    const task2 = plan.playlists[0].tasks[1];
    task1.status = TaskStatus.Completed;
    task2.skipIf = { taskId: task1.id, status: TaskStatus.Completed };

    await runner.play(plan);

    assert.equal(task2.status, TaskStatus.Skipped);
    const task2Event = completedEvents.find(e => e.name === task2.name);
    assert.ok(task2Event, 'task-completed should fire for skipped task');
    assert.equal(task2Event!.status, TaskStatus.Skipped);
  });

  it('should run task when skipIf condition does not match', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    plan.playlists[0].tasks[0].id = 'task-a';
    // Task 2 skipIf references task-a with Failed, but task-a is Pending → no match
    plan.playlists[0].tasks[1].skipIf = { taskId: 'task-a', status: TaskStatus.Failed };

    await runner.play(plan);

    // Both tasks should run since skipIf doesn't match
    assert.deepEqual(taskNames, ['Task 1', 'Task 2']);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Completed);
  });

  it('should run task when skipIf status does not match completed task', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    plan.playlists[0].tasks[0].id = 'task-a';
    plan.playlists[0].tasks[0].status = TaskStatus.Completed;
    // skipIf checks for Failed, but task-a is Completed → condition does NOT match → task 2 runs
    plan.playlists[0].tasks[1].skipIf = { taskId: 'task-a', status: TaskStatus.Failed };

    await runner.play(plan);

    // Task 1 already completed (skipped on resume), Task 2 should run normally
    assert.deepEqual(taskNames, ['Task 2']);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Completed);
  });

  it('should run task when skipIf references non-existent task', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    plan.playlists[0].tasks[1].skipIf = { taskId: 'no-such-task', status: TaskStatus.Completed };

    await runner.play(plan);

    assert.deepEqual(taskNames, ['Task 1', 'Task 2']);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Completed);
  });

  it('should handle skipIf across playlists', async () => {
    const { runner } = buildRunner();

    const plan = makePlan();
    // First playlist has task-a that will succeed
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].id = 'task-a';
    // Second playlist has task-b that should be skipped when task-a completed
    const pl2 = createPlaylist('Phase 2');
    pl2.autoplay = true;
    pl2.autoplayDelay = 0;
    const taskB = createTask('Task B', 'Do something');
    taskB.skipIf = { taskId: 'task-a', status: TaskStatus.Completed };
    pl2.tasks.push(taskB);
    plan.playlists.push(pl2);

    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(plan.playlists[1].tasks[0].status, TaskStatus.Skipped);
  });

  it('should run task normally when skipIf condition is failed but task completed', async () => {
    const { runner } = buildRunner();
    const taskNames: string[] = [];
    runner.on('task-started', (task: { name: string }) => taskNames.push(task.name));

    const plan = makePlan();
    const task1Id = plan.playlists[0].tasks[0].id;
    plan.playlists[0].tasks[0].status = TaskStatus.Completed;
    // skipIf checks for 'failed', but task 1 is 'completed' → no match → task 2 runs
    plan.playlists[0].tasks[1].skipIf = { taskId: task1Id, status: TaskStatus.Failed };

    await runner.play(plan);

    // Task 1 already completed (skipped on resume), Task 2 should run and complete
    assert.deepEqual(taskNames, ['Task 2']);
    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Completed);
  });

  // ─── Plan Variables Tests ───

  it('should substitute {{planName}} in task prompt', async () => {
    const { runner } = buildRunner();
    let capturedPrompt = '';
    engineRunStub.callsFake(async (opts: { prompt: string }) => {
      capturedPrompt = opts.prompt;
      return mockEngineResult;
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].prompt = 'Working on {{planName}}';

    await runner.play(plan);

    assert.ok(capturedPrompt.includes('Working on Test Plan'), `Expected planName substitution, got: ${capturedPrompt}`);
  });

  it('should substitute user-defined variables in prompt', async () => {
    const { runner } = buildRunner();
    let capturedPrompt = '';
    engineRunStub.callsFake(async (opts: { prompt: string }) => {
      capturedPrompt = opts.prompt;
      return mockEngineResult;
    });

    const plan = makePlan();
    plan.variables = { framework: 'React', version: '18' };
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].prompt = 'Upgrade {{framework}} to v{{version}}';

    await runner.play(plan);

    assert.ok(capturedPrompt.includes('Upgrade React to v18'), `Expected variable substitution, got: ${capturedPrompt}`);
  });

  it('should leave unknown variables as-is', async () => {
    const { runner } = buildRunner();
    let capturedPrompt = '';
    engineRunStub.callsFake(async (opts: { prompt: string }) => {
      capturedPrompt = opts.prompt;
      return mockEngineResult;
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].prompt = 'Use {{unknownVar}} here';

    await runner.play(plan);

    assert.ok(capturedPrompt.includes('{{unknownVar}}'), `Unknown var should remain, got: ${capturedPrompt}`);
  });

  it('should let user variables override built-in variables', async () => {
    const { runner } = buildRunner();
    let capturedPrompt = '';
    engineRunStub.callsFake(async (opts: { prompt: string }) => {
      capturedPrompt = opts.prompt;
      return mockEngineResult;
    });

    const plan = makePlan();
    plan.variables = { planName: 'Custom Name' };
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].prompt = 'Project: {{planName}}';

    await runner.play(plan);

    assert.ok(capturedPrompt.includes('Project: Custom Name'), `User var should override built-in, got: ${capturedPrompt}`);
  });

  // ─── Auto-Fix Tests ───

  it('should auto-fix a failed agent task', async () => {
    const { runner, historyStore } = buildRunner();
    // getForTask must return a history entry with error context for auto-fix
    historyStore.getForTask = sinon.stub().returns([{
      result: { stderr: 'compilation error', stdout: 'partial output' },
      changedFiles: ['src/foo.ts'],
    }]);

    let callCount = 0;
    engineRunStub.callsFake(async () => {
      callCount++;
      // First call fails, second (auto-fix) succeeds
      if (callCount === 1) {
        return { ...mockEngineResult, exitCode: 1 };
      }
      return mockEngineResult;
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].autoplayDelay = 0;

    await runner.play(plan);

    // Auto-fix should have retried and succeeded
    assert.equal(callCount, 2);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  it('should skip auto-fix when autoFix setting is disabled', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask = sinon.stub().returns([{
      result: { stderr: 'error', stdout: '' },
      changedFiles: [],
    }]);

    // Disable auto-fix via config
    vscodeMock.setMockConfig('agentTaskPlayer', { autoFix: false });

    engineRunStub.resolves({ ...mockEngineResult, exitCode: 1 });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].autoplayDelay = 0;

    await runner.play(plan);

    // Engine should only be called once — no auto-fix retry
    assert.equal(engineRunStub.callCount, 1);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);

    vscodeMock.clearMockConfig();
  });

  it('should skip auto-fix when fail-safe mode is enabled', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask = sinon.stub().returns([{
      result: { stderr: 'error', stdout: '' },
      changedFiles: [],
    }]);

    vscodeMock.setMockConfig('agentTaskPlayer', { failSafeMode: true, autoFix: true });
    engineRunStub.resolves({ ...mockEngineResult, exitCode: 1 });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].autoplayDelay = 0;

    await runner.play(plan);

    assert.equal(engineRunStub.callCount, 1);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    vscodeMock.clearMockConfig();
  });

  it('should skip auto-fix for command tasks', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask = sinon.stub().returns([{
      result: { stderr: 'boom', stdout: '' },
      changedFiles: [],
    }]);

    spawnStub.callsFake((command: string) => {
      if (command === 'git') {
        return createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 });
      }
      return createSpawnProc({ stderrChunks: ['boom'], closeCode: 1 });
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'command';
    plan.playlists[0].tasks[0].command = 'failing-cmd';
    plan.playlists[0].autoplayDelay = 0;

    await runner.play(plan);

    // Command task fails — auto-fix should NOT be attempted (engine never called)
    assert.equal(engineRunStub.callCount, 0);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
  });

  it('should restore original prompt after auto-fix attempt', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask = sinon.stub().returns([{
      result: { stderr: 'error output', stdout: '' },
      changedFiles: ['file.ts'],
    }]);

    const originalPrompt = 'Do first thing';
    let capturedPrompt: string | undefined;
    let callCount = 0;
    engineRunStub.callsFake(async (opts: { prompt: string }) => {
      callCount++;
      if (callCount === 2) {
        // Capture the prompt during auto-fix execution
        capturedPrompt = opts.prompt;
      }
      // Both attempts fail so we can check prompt restoration
      return { ...mockEngineResult, exitCode: 1 };
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].autoplayDelay = 0;

    await runner.play(plan);

    // During auto-fix, a repair prompt should have been used (not the original)
    assert.ok(capturedPrompt);
    assert.ok(capturedPrompt!.includes('FAILED'), 'repair prompt should contain failure context');
    assert.ok(capturedPrompt!.includes(originalPrompt), 'repair prompt should include original prompt');

    // After completion, the original prompt should be restored
    assert.equal(plan.playlists[0].tasks[0].prompt, originalPrompt);
  });

  // ─── Ship half: deploy / release task types ───

  function shipPlan(mut: (t: ReturnType<typeof createTask>) => void): Plan {
    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].autoplayDelay = 0;
    mut(plan.playlists[0].tasks[0]);
    return plan;
  }

  it('deploy task runs its command without an engine and completes', async () => {
    const { runner, historyStore } = buildRunner();
    spawnStub.callsFake((command: string) =>
      command === 'git'
        ? createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 })
        : createSpawnProc({ stdoutChunks: ['deployed'], closeCode: 0 }));

    const plan = shipPlan((t) => { t.type = 'deploy'; t.command = 'npm run deploy'; });
    await runner.play(plan);

    assert.equal(engineRunStub.callCount, 0);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(historyStore.add.firstCall.args[0].taskType, 'deploy');
  });

  it('deploy task fails when the command exits non-zero', async () => {
    const { runner } = buildRunner();
    spawnStub.callsFake((command: string) =>
      command === 'git'
        ? createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 })
        : createSpawnProc({ stderrChunks: ['deploy boom'], closeCode: 1 }));

    const plan = shipPlan((t) => { t.type = 'deploy'; t.command = 'npm run deploy'; });
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
  });

  it('deploy task with no command fails with a config error', async () => {
    const { runner } = buildRunner();
    const plan = shipPlan((t) => { t.type = 'deploy'; });
    await runner.play(plan);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
  });

  it('release task runs its command and creates a tag', async () => {
    const { runner, historyStore } = buildRunner();
    const gitArgs: string[][] = [];
    spawnStub.callsFake((command: string, args: string[]) => {
      if (command === 'git') { gitArgs.push(args); return createSpawnProc({ stdoutChunks: [''], closeCode: 0 }); }
      return createSpawnProc({ stdoutChunks: ['v1.2.3'], closeCode: 0 });
    });

    const plan = shipPlan((t) => { t.type = 'release'; t.command = 'npm version patch'; t.releaseTag = 'v1.2.3'; });
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(historyStore.add.firstCall.args[0].taskType, 'release');
    assert.ok(gitArgs.some((a) => a[0] === 'tag' && a.includes('v1.2.3')), 'should create an annotated git tag');
  });

  /** A release plan whose latest PRD version has R-1, implemented by a completed agent task with passing gates. */
  function tracedReleasePlan(): Plan {
    const plan = shipPlan((t) => { t.type = 'release'; t.releaseTag = 'v1.2.3'; });
    const impl = createTask('Implement R-1', 'build it');
    impl.status = TaskStatus.Completed;
    impl.requirementIds = ['R-1'];
    plan.playlists[0].tasks.unshift(impl);
    plan.prdVersions = [
      { version: '1.0.0', text: '## Requirements\n- [R-1] x', createdAt: '2026-10-01T00:00:00.000Z' },
      { version: '2.0.0', text: '## Requirements\n- [R-1] x\n', createdAt: '2026-10-02T00:00:00.000Z' },
    ];
    plan.requirementTrace = [{
      id: 'R-1',
      taskIds: [impl.id],
      commits: [],
      gates: [{ command: 'npm test', exitCode: 0, timedOut: false, at: '2026-10-03T00:00:00.000Z' }],
      releases: [],
    }];
    return plan;
  }

  it('a successful release stamps the requirement with the tag and the latest PRD version', async () => {
    const { runner } = buildRunner();
    spawnStub.callsFake(() => createSpawnProc({ stdoutChunks: [''], closeCode: 0 }));
    const output: string[] = [];
    runner.on('task-output', (_t: unknown, chunk: string) => { output.push(chunk); });

    const plan = tracedReleasePlan();
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Completed);
    const release = plan.requirementTrace![0].releases[0];
    assert.ok(release, 'R-1 must be stamped');
    assert.equal(release.releaseTag, 'v1.2.3');
    assert.equal(release.prdVersion, '2.0.0');
    assert.deepEqual(release.taskIds, [plan.playlists[0].tasks[0].id]);
    assert.ok(output.some((c) => c.includes('[Release] Shipped R-1 in PRD 2.0.0.')));
    assert.equal('standardsVersion' in release, false, 'no standards on this host: no version is stamped');
  });

  it('a successful release stamps the standards version only when the last verification judged the diff against it; unreadable standards stamp none and do not fail the release', async () => {
    const a = buildRunner();
    spawnStub.callsFake(() => createSpawnProc({ stdoutChunks: [''], closeCode: 0 }));
    a.runner.setStandardsProvider(() => ({ text: 'Project standards v7', version: 7 }));
    const planA = tracedReleasePlan();
    // What the PRD loop records when the standards gate really judged the diff: its own row.
    planA.requirementTrace![0].gates.unshift({ command: 'moag:standards v7', exitCode: 0, timedOut: false, at: '2026-10-03T00:00:00.000Z' });
    await a.runner.play(planA);
    assert.equal(planA.playlists[0].tasks[1].status, TaskStatus.Completed);
    assert.equal(planA.requirementTrace![0].releases[0].standardsVersion, 7);

    // The host carries standards v7, but the last verification never judged the diff against
    // them (no standards row among the gates): the release ships and claims no check.
    const unjudged = buildRunner();
    unjudged.runner.setStandardsProvider(() => ({ text: 'Project standards v7', version: 7 }));
    const planU = tracedReleasePlan();
    await unjudged.runner.play(planU);
    assert.equal(planU.playlists[0].tasks[1].status, TaskStatus.Completed);
    assert.equal(planU.requirementTrace![0].releases[0].releaseTag, 'v1.2.3');
    assert.equal('standardsVersion' in planU.requirementTrace![0].releases[0], false);

    // Judged — but against another version than the one in effect now: not this version's stamp.
    const stale = buildRunner();
    stale.runner.setStandardsProvider(() => ({ text: 'Project standards v8', version: 8 }));
    const planS = tracedReleasePlan();
    planS.requirementTrace![0].gates.unshift({ command: 'moag:standards v7', exitCode: 0, timedOut: false, at: '2026-10-03T00:00:00.000Z' });
    await stale.runner.play(planS);
    assert.equal('standardsVersion' in planS.requirementTrace![0].releases[0], false);

    // The tag already exists by the time the stamp is written: a broken standards file
    // must not turn a release that happened into a failed task.
    const b = buildRunner();
    b.runner.setStandardsProvider(() => { throw new Error('".moag/standards.json" contains invalid JSON.'); });
    const planB = tracedReleasePlan();
    await b.runner.play(planB);
    assert.equal(planB.playlists[0].tasks[1].status, TaskStatus.Completed);
    const release = planB.requirementTrace![0].releases[0];
    assert.equal(release.releaseTag, 'v1.2.3');
    assert.equal('standardsVersion' in release, false);
  });

  it('a failed git tag fails the release and stamps nothing (F3.5)', async () => {
    const { runner } = buildRunner();
    spawnStub.callsFake((command: string, args: string[]) =>
      command === 'git' && args[0] === 'tag'
        ? createSpawnProc({ stderrChunks: ['fatal: tag exists'], closeCode: 1 })
        : createSpawnProc({ stdoutChunks: [''], closeCode: 0 }));

    const plan = tracedReleasePlan();
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Failed);
    assert.deepEqual(plan.requirementTrace![0].releases, []);
  });

  it('a release with failing recorded gates stamps nothing', async () => {
    const { runner } = buildRunner();
    spawnStub.callsFake(() => createSpawnProc({ stdoutChunks: [''], closeCode: 0 }));
    const plan = tracedReleasePlan();
    plan.requirementTrace![0].gates[0].exitCode = 1;

    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Completed);
    assert.deepEqual(plan.requirementTrace![0].releases, []);
  });

  it('release task with neither command nor tag fails', async () => {
    const { runner } = buildRunner();
    const plan = shipPlan((t) => { t.type = 'release'; });
    await runner.play(plan);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
  });

  // ─── Maintain half: monitor task type ───

  it('monitor task passes when the endpoint is healthy', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http');
    const server = http.createServer((_req: unknown, res: { statusCode: number; end: () => void }) => { res.statusCode = 200; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const { runner } = buildRunner();
      const plan = shipPlan((t) => {
        t.type = 'monitor';
        t.healthCheckUrl = `http://127.0.0.1:${port}/health`;
        t.monitorSamples = 1; t.monitorIntervalMs = 0;
      });
      await runner.play(plan);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('monitor task fails and emits an incident when the endpoint is down', async () => {
    const { runner } = buildRunner();
    const incidents: string[] = [];
    runner.on('incident', (_t: unknown, summary: string) => incidents.push(summary));
    const plan = shipPlan((t) => {
      t.type = 'monitor';
      t.healthCheckUrl = 'http://127.0.0.1:1/health'; // nothing listening → breach
      t.monitorSamples = 1; t.monitorIntervalMs = 0; t.failureThreshold = 1;
    });
    await runner.play(plan);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    assert.equal(incidents.length, 1);
  });

  it('monitor task with no healthCheckUrl fails', async () => {
    const { runner } = buildRunner();
    const plan = shipPlan((t) => { t.type = 'monitor'; });
    await runner.play(plan);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
  });
});

// ─── Expert role resolution in buildPrompt ───

describe('TaskRunner — role charter resolution', () => {
  // Captures the options object handed to buildContext so the resolved charter can be
  // inspected without asserting on the final prompt text.
  function buildRunnerCapturingContext() {
    const historyStore = createMockHistoryStore();
    const mockEngine = createMockEngine();
    const captured: Array<Record<string, unknown>> = [];
    spawnStub = sinon.stub().callsFake(() => createSpawnProc());

    const { TaskRunner } = proxyquire('../../../runner/runner', {
      'vscode': vscodeMock,
      '../adapters/index': { getEngine: () => mockEngine },
      '../context/context-builder': {
        buildContext: (opts: Record<string, unknown>) => { captured.push(opts); return ''; },
        getContextSettings: () => ({ enabled: true, maxContextChars: 30000, maxFileContextChars: 4000 }),
        runRetrievalCascade: async () => ({ spans: [], usedSemantic: false }),
        adaptiveContextBudget: (_t: unknown, base: number) => base,
      },
      'child_process': { spawn: spawnStub, execSync: sinon.stub() },
    });

    return { runner: new TaskRunner(historyStore), captured };
  }

  function singleTaskPlan(): Plan {
    const plan = createEmptyPlan('Role Plan');
    const pl = plan.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    pl.tasks.push(createTask('Only Task', 'Do the thing'));
    return plan;
  }

  afterEach(() => {
    vscodeMock.clearMockConfig();
    sinon.restore();
  });

  it('prefers the task role over the playlist and plan roles', async () => {
    const { runner, captured } = buildRunnerCapturingContext();
    const plan = singleTaskPlan();
    plan.defaultRole = 'architect';
    plan.playlists[0].role = 'designer';
    plan.playlists[0].tasks[0].role = 'tester';

    await runner.play(plan);

    assert.equal(captured.length, 1);
    assert.ok(String(captured[0].roleCharter).startsWith('You are the tester.'));
  });

  it('falls back to the playlist role when the task declares none', async () => {
    const { runner, captured } = buildRunnerCapturingContext();
    const plan = singleTaskPlan();
    plan.defaultRole = 'architect';
    plan.playlists[0].role = 'designer';

    await runner.play(plan);

    assert.ok(String(captured[0].roleCharter).startsWith('You are the designer.'));
  });

  it('falls back to plan.defaultRole when neither task nor playlist declares one', async () => {
    const { runner, captured } = buildRunnerCapturingContext();
    const plan = singleTaskPlan();
    plan.defaultRole = 'architect';

    await runner.play(plan);

    assert.ok(String(captured[0].roleCharter).startsWith('You are the architect.'));
  });

  it('passes no charter at all when no level declares a role', async () => {
    const { runner, captured } = buildRunnerCapturingContext();

    await runner.play(singleTaskPlan());

    assert.equal(captured[0].roleCharter, undefined);
  });

  it('resolves a plan-level custom role that overrides a built-in by id', async () => {
    const { runner, captured } = buildRunnerCapturingContext();
    const plan = singleTaskPlan();
    plan.customRoles = [{ id: 'tester', name: 'House Tester', charter: 'House charter.' }];
    plan.playlists[0].tasks[0].role = 'tester';

    await runner.play(plan);

    assert.equal(captured[0].roleCharter, 'House charter.');
  });

  it('emits no charter when roles.enabled is false, at every level', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { 'roles.enabled': false });
    const { runner, captured } = buildRunnerCapturingContext();
    const plan = singleTaskPlan();
    plan.defaultRole = 'architect';
    plan.playlists[0].role = 'designer';
    plan.playlists[0].tasks[0].role = 'tester';

    await runner.play(plan);

    assert.equal(captured[0].roleCharter, undefined);
  });

  it('never stashes the resolved charter on the task object', async () => {
    const { runner } = buildRunnerCapturingContext();
    const plan = singleTaskPlan();
    plan.defaultRole = 'reviewer';

    await runner.play(plan);

    const task = plan.playlists[0].tasks[0] as unknown as Record<string, unknown>;
    assert.ok(!('_roleCharter' in task), 'a stashed charter would be clobbered by a concurrent loop');
    assert.equal(task.role, undefined, 'resolution must not write a role back onto the task');
  });
});

// ─── Expert role on review tasks (which bypass the context builder entirely) ───

describe('TaskRunner — role charter on review tasks', () => {
  const DEP_ENTRY = {
    id: 'h-1',
    taskId: 'target-task',
    engine: 'codex',
    prompt: 'Build the thing',
    changedFiles: ['src/a.ts'],
    codeChanges: '--- a/src/a.ts',
  };

  function reviewPlan(): Plan {
    const plan = createEmptyPlan('Review Plan');
    const pl = plan.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;

    const target = createTask('Build', 'Build the thing');
    target.id = 'target-task';

    const review = createTask('Review', 'Review the build');
    review.id = 'review-task';
    review.type = 'review';
    review.dependsOn = ['target-task'];

    pl.tasks.push(target, review);
    return plan;
  }

  /** The prompt actually handed to the engine for the review (the last engine call). */
  function reviewPromptSent(): string {
    return String(engineRunStub.lastCall.args[0].prompt);
  }

  afterEach(() => {
    vscodeMock.clearMockConfig();
    sinon.restore();
  });

  it('prepends the reviewer charter when no level declares a role', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask.returns([DEP_ENTRY]);

    await runner.play(reviewPlan());

    const prompt = reviewPromptSent();
    assert.ok(prompt.startsWith('## Role'), 'charter must lead the review prompt');
    assert.ok(prompt.includes('You are the reviewer.'));
    assert.ok(prompt.includes('Review the code changes made by the previous task.'),
      'the original review prompt must survive underneath the charter');
  });

  it('lets an explicit task role override the reviewer default', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask.returns([DEP_ENTRY]);
    const plan = reviewPlan();
    plan.playlists[0].tasks[1].role = 'architect';

    await runner.play(plan);

    const prompt = reviewPromptSent();
    assert.ok(prompt.includes('You are the architect.'));
    assert.ok(!prompt.includes('You are the reviewer.'));
  });

  it('prefers the task role over the playlist role and plan.defaultRole', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask.returns([DEP_ENTRY]);
    const plan = reviewPlan();
    plan.defaultRole = 'devops';
    plan.playlists[0].role = 'designer';
    plan.playlists[0].tasks[1].role = 'tester';

    await runner.play(plan);

    assert.ok(reviewPromptSent().includes('You are the tester.'));
  });

  it('emits no ## Role section when roles.enabled is false', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { 'roles.enabled': false });
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask.returns([DEP_ENTRY]);

    await runner.play(reviewPlan());

    const prompt = reviewPromptSent();
    assert.ok(!prompt.includes('## Role'));
    assert.ok(prompt.startsWith('Review the code changes made by the previous task.'));
  });

  it('leaves the missing-dependsOn early return untouched', async () => {
    const { runner, historyStore } = buildRunner();
    historyStore.getForTask.returns([DEP_ENTRY]);
    const plan = reviewPlan();
    plan.playlists[0].tasks[1].dependsOn = undefined;

    const failures: EngineResult[] = [];
    runner.on('task-failed', (_t: unknown, r: EngineResult) => failures.push(r));

    await runner.play(plan);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].exitCode, 1);
    assert.equal(
      failures[0].stderr,
      'Review task requires "dependsOn" pointing to the task to review.',
    );
    assert.ok(!failures[0].stderr.includes('## Role'), 'the guard must return before role resolution');
  });

  it('leaves the missing-history early return untouched', async () => {
    const { runner } = buildRunner();
    // Default mock history store returns no entries for any task.

    const failures: EngineResult[] = [];
    runner.on('task-failed', (_t: unknown, r: EngineResult) => failures.push(r));

    await runner.play(reviewPlan());

    assert.equal(failures.length, 1);
    assert.equal(failures[0].exitCode, 1);
    assert.ok(failures[0].stderr.startsWith(
      'No history found for dependency task "target-task".',
    ));
    assert.ok(!failures[0].stderr.includes('## Role'), 'the guard must return before role resolution');
  });
});

describe('TaskRunner — auto-routing engine resolution', () => {
  const SIMPLE_PROMPT = 'rename variable foo to bar';
  const COMPLEX_PROMPT = 'Refactor the entire authentication system to use OAuth2. ' +
    'This involves redesigning the database schema, migrating existing users, ' +
    'implementing security best practices, and optimizing performance. ' +
    'The system architecture needs a complete overhaul with complex state management.';

  function routingPlan(prompt: string, opts?: {
    taskEngine?: EngineId;
    playlistEngine?: EngineId;
    planDefaultEngine?: EngineId;
  }): Plan {
    const plan = createEmptyPlan('Routing Plan');
    // createEmptyPlan always sets defaultEngine to 'claude'; these tests need to
    // clear it to isolate routing/playlist resolution, so the type is widened here.
    plan.defaultEngine = opts?.planDefaultEngine as EngineId;
    const pl = plan.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    pl.engine = opts?.playlistEngine;
    pl.tasks.push(createTask('Routed Task', prompt, opts?.taskEngine));
    return plan;
  }

  function buildRoutedRunner(loadWorkspaceRoutingConfig: (root: string) => unknown) {
    return buildRunner({
      '../routing/routing-store': { loadWorkspaceRoutingConfig },
    });
  }

  afterEach(() => {
    vscodeMock.clearMockConfig();
    sinon.restore();
  });

  it('routes a simple-prompt task to simpleEngine when enabled and no workspace override exists', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', {
      'autoRouting.enabled': true,
      'autoRouting.simpleEngine': 'ollama',
      'autoRouting.complexEngine': 'claude',
      'autoRouting.complexityThreshold': 50,
    });
    const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));

    await runner.play(routingPlan(SIMPLE_PROMPT));

    assert.equal(getLastEngineId(), 'ollama');
  });

  it('routes a complex-prompt task to complexEngine when enabled', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', {
      'autoRouting.enabled': true,
      'autoRouting.simpleEngine': 'ollama',
      'autoRouting.complexEngine': 'claude',
      'autoRouting.complexityThreshold': 50,
    });
    const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));

    const plan = routingPlan(COMPLEX_PROMPT);
    plan.playlists[0].tasks[0].files = ['auth.ts', 'db.ts', 'middleware.ts', 'routes.ts', 'models.ts'];
    plan.playlists[0].tasks[0].dependsOn = [];
    plan.playlists[0].tasks[0].verifyCommand = 'npm test';

    await runner.play(plan);

    assert.equal(getLastEngineId(), 'claude');
  });

  it('lets an explicit task.engine override routing', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', {
      'autoRouting.enabled': true,
      'autoRouting.simpleEngine': 'ollama',
      'autoRouting.complexEngine': 'claude',
      'autoRouting.complexityThreshold': 50,
    });
    const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));

    await runner.play(routingPlan(SIMPLE_PROMPT, { taskEngine: 'codex' }));

    assert.equal(getLastEngineId(), 'codex');
  });

  it('lets an explicit playlist.engine win over routing', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', {
      'autoRouting.enabled': true,
      'autoRouting.simpleEngine': 'ollama',
      'autoRouting.complexEngine': 'claude',
      'autoRouting.complexityThreshold': 50,
    });
    const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));

    await runner.play(routingPlan(SIMPLE_PROMPT, { playlistEngine: 'gemini' }));

    assert.equal(getLastEngineId(), 'gemini');
  });

  it('lets an explicit plan.defaultEngine win over routing', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', {
      'autoRouting.enabled': true,
      'autoRouting.simpleEngine': 'ollama',
      'autoRouting.complexEngine': 'gemini',
      'autoRouting.complexityThreshold': 50,
    });
    const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));

    await runner.play(routingPlan(SIMPLE_PROMPT, { planDefaultEngine: 'claude' }));

    assert.equal(getLastEngineId(), 'claude');
  });

  it('regression pin: autoRouting disabled by default resolves to the pre-routing default engine', async () => {
    // No 'autoRouting.*' keys set at all — mirrors an unconfigured workspace.
    const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));

    await runner.play(routingPlan(SIMPLE_PROMPT));

    assert.equal(getLastEngineId(), 'claude');
  });

  it('two different workspace routing overrides against an identical task resolve to different engines', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', {
      'autoRouting.enabled': true,
      'autoRouting.simpleEngine': 'ollama',
      'autoRouting.complexEngine': 'claude',
      'autoRouting.complexityThreshold': 50,
    });

    const runA = buildRoutedRunner(() => ({}));
    await runA.runner.play(routingPlan(SIMPLE_PROMPT));
    const engineA = runA.getLastEngineId();

    const runB = buildRoutedRunner(() => ({ simpleEngine: 'gemini' }));
    await runB.runner.play(routingPlan(SIMPLE_PROMPT));
    const engineB = runB.getLastEngineId();

    assert.equal(engineA, 'ollama');
    assert.equal(engineB, 'gemini');
    assert.notEqual(engineA, engineB);
  });

  it('stamps engineRoutingReason on the history entry only when routing actually fired', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', {
      'autoRouting.enabled': true,
      'autoRouting.simpleEngine': 'ollama',
      'autoRouting.complexEngine': 'claude',
      'autoRouting.complexityThreshold': 50,
    });

    const routed = buildRoutedRunner(() => ({}));
    await routed.runner.play(routingPlan(SIMPLE_PROMPT));
    const routedEntry = routed.historyStore.add.firstCall.args[0];
    assert.equal(typeof routedEntry.engineRoutingReason, 'string');
    assert.ok(routedEntry.engineRoutingReason.length > 0);

    const overridden = buildRoutedRunner(() => ({}));
    await overridden.runner.play(routingPlan(SIMPLE_PROMPT, { taskEngine: 'codex' }));
    const overriddenEntry = overridden.historyStore.add.firstCall.args[0];
    assert.equal(overriddenEntry.engineRoutingReason, undefined);
  });

  describe('CLI-missing fallback (auto-routing tier substitution)', () => {
    function autoRoutingCfg(threshold = 50) {
      vscodeMock.setMockConfig('agentTaskPlayer', {
        'autoRouting.enabled': true,
        'autoRouting.simpleEngine': 'ollama',
        'autoRouting.complexEngine': 'claude',
        'autoRouting.complexityThreshold': threshold,
      });
    }

    it('retries on the auto-routing complex tier when the auto-routed simple engine reports CLI-missing and no plan.fallbackEngine is set', async () => {
      autoRoutingCfg();
      const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));
      engineRunStub.onCall(0).resolves({
        ...mockEngineResult,
        exitCode: 1,
        stderr: 'ollama: command not found',
      });
      engineRunStub.onCall(1).resolves(mockEngineResult);

      const fallbackEvents: Array<{ taskId: string; fromEngine: string; toEngine: string }> = [];
      runner.on('engine-fallback', (details: { taskId: string; fromEngine: string; toEngine: string }) => fallbackEvents.push(details));
      const outputs: string[] = [];
      runner.on('task-output', (_task: unknown, chunk: string) => outputs.push(chunk));

      const plan = routingPlan(SIMPLE_PROMPT);
      await runner.play(plan);

      assert.equal(getLastEngineId(), 'claude');
      assert.equal(fallbackEvents.length, 1);
      assert.equal(fallbackEvents[0].fromEngine, 'ollama');
      assert.equal(fallbackEvents[0].toEngine, 'claude');
      assert.ok(outputs.some(o => o.includes('Engine CLI not found or unreachable') && o.includes('auto-routing')));
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    });

    it('prefers an explicit plan.fallbackEngine over the auto-routing complex tier on CLI-missing', async () => {
      autoRoutingCfg();
      const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));
      engineRunStub.onCall(0).resolves({
        ...mockEngineResult,
        exitCode: 1,
        stderr: 'ollama: command not found',
      });
      engineRunStub.onCall(1).resolves(mockEngineResult);

      const plan = routingPlan(SIMPLE_PROMPT);
      plan.fallbackEngine = 'gemini' as EngineId;
      await runner.play(plan);

      assert.equal(getLastEngineId(), 'gemini');
    });

    it('does not auto-substitute the other routing tier when the CLI-missing engine was an explicit task.engine override', async () => {
      autoRoutingCfg();
      const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));
      engineRunStub.resolves({
        ...mockEngineResult,
        exitCode: 1,
        stderr: 'codex: command not found',
      });

      const plan = routingPlan(SIMPLE_PROMPT, { taskEngine: 'codex' });
      await runner.play(plan);

      assert.equal(engineRunStub.callCount, 1);
      assert.equal(getLastEngineId(), 'codex');
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    });

    it('does not auto-substitute the other routing tier on a rate-limited auto-routed engine — only plan.fallbackEngine applies to rate-limit', async () => {
      autoRoutingCfg();
      const { runner, getLastEngineId } = buildRoutedRunner(() => ({}));
      engineRunStub.resolves({
        ...mockEngineResult,
        exitCode: 1,
        stderr: 'Error: rate limit exceeded, please retry later',
      });

      const fallbackEvents: unknown[] = [];
      runner.on('engine-fallback', (d: unknown) => fallbackEvents.push(d));

      const plan = routingPlan(SIMPLE_PROMPT);
      await runner.play(plan);

      assert.equal(engineRunStub.callCount, 1);
      assert.equal(getLastEngineId(), 'ollama');
      assert.equal(fallbackEvents.length, 0);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    });

    it('isCliMissing matches known CLI-missing phrasings and rejects unrelated stderr', () => {
      const { runner } = buildRunner();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isCliMissing = (result: EngineResult) => (runner as any).isCliMissing(result);

      assert.equal(isCliMissing({ stdout: '', stderr: 'ollama: command not found', exitCode: 127, durationMs: 0 }), true);
      assert.equal(isCliMissing({ stdout: '', stderr: "'foo' is not recognized as an internal or external command", exitCode: 1, durationMs: 0 }), true);
      assert.equal(isCliMissing({ stdout: '', stderr: 'AssertionError: expected 1 to equal 2', exitCode: 1, durationMs: 0 }), false);
    });
  });
});

describe('TaskRunner — usage recorder', () => {
  afterEach(() => {
    sinon.restore();
  });

  function singleTaskPlan(): Plan {
    const plan = createEmptyPlan('Usage Recorder Plan');
    const pl = plan.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    pl.tasks.push(createTask('Solo Task', 'Do the one thing'));
    return plan;
  }

  it('is called once on a normal successful agent task, with correct fields', async () => {
    const { runner } = buildRunner();
    engineRunStub.resolves({
      ...mockEngineResult,
      tokenUsage: { inputTokens: 10, outputTokens: 20, estimatedCost: 0.0015 },
    });

    const records: EngineCallUsage[] = [];
    runner.setUsageRecorder((r: EngineCallUsage) => records.push(r));

    const plan = singleTaskPlan();
    await runner.play(plan);

    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.taskId, plan.playlists[0].tasks[0].id);
    assert.equal(record.taskName, 'Solo Task');
    assert.equal(record.engine, 'claude');
    assert.equal(record.prompt, 'Do the one thing');
    assert.equal(record.tokenUsageAvailable, true);
    assert.equal(record.inputTokens, 10);
    assert.equal(record.outputTokens, 20);
    assert.equal(record.estimatedCostUsd, 0.0015);
  });

  it('records tokenUsageAvailable:false and zero token fields when the adapter omits tokenUsage', async () => {
    const { runner } = buildRunner();
    // mockEngineResult (the default stub resolution) carries no tokenUsage.

    const records: EngineCallUsage[] = [];
    runner.setUsageRecorder((r: EngineCallUsage) => records.push(r));

    const plan = singleTaskPlan();
    await runner.play(plan);

    assert.equal(records.length, 1);
    assert.equal(records[0].tokenUsageAvailable, false);
    assert.equal(records[0].inputTokens, 0);
    assert.equal(records[0].outputTokens, 0);
    assert.equal(records[0].estimatedCostUsd, 0);
  });

  it('is called twice for the same taskId, once per engine, when a rate-limit fallback fires', async () => {
    const { runner } = buildRunner();
    engineRunStub.onCall(0).resolves({
      ...mockEngineResult,
      exitCode: 1,
      stderr: 'Error: rate limit exceeded, please retry later',
    });
    engineRunStub.onCall(1).resolves(mockEngineResult);

    const records: EngineCallUsage[] = [];
    runner.setUsageRecorder((r: EngineCallUsage) => records.push(r));

    const plan = singleTaskPlan();
    plan.defaultEngine = 'claude' as EngineId;
    plan.fallbackEngine = 'codex' as EngineId;
    await runner.play(plan);

    assert.equal(records.length, 2);
    assert.equal(records[0].taskId, records[1].taskId);
    assert.notEqual(records[0].engine, records[1].engine);
  });

  it('is never called when no usage recorder has been set', async () => {
    const { runner } = buildRunner();
    const plan = singleTaskPlan();
    // setUsageRecorder is never called — this must not throw or otherwise break the task.
    await runner.play(plan);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  it('does not fail the task when the recorder throws — task-completed still fires', async () => {
    const { runner } = buildRunner();
    runner.setUsageRecorder(() => { throw new Error('recorder boom'); });

    const completed: string[] = [];
    runner.on('task-completed', (task: { name: string }) => completed.push(task.name));

    const plan = singleTaskPlan();
    await runner.play(plan);

    assert.deepEqual(completed, ['Solo Task']);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  // Regression pin for the HIGH finding: the recorder must receive only the
  // short, human-written task prompt — never buildContext()'s assembled
  // prompt (AI rules, retrieved code spans, prior outputs). Builds its own
  // TaskRunner with context building actually enabled and a distinctive
  // marker standing in for a large assembled-context blob, so a regression
  // that starts passing `fullPrompt` again would fail this test even though
  // every other test in this file stubs context building as disabled.
  it('never records assembled buildContext() output — only the short task prompt', async () => {
    const ASSEMBLED_CONTEXT_MARKER = 'ASSEMBLED-CONTEXT-'.repeat(200); // stands in for AI rules + retrieved code spans

    const historyStore = createMockHistoryStore();
    const mockEngine = createMockEngine();
    const localSpawnStub = sinon.stub().callsFake(() => createSpawnProc());

    const { TaskRunner } = proxyquire('../../../runner/runner', {
      'vscode': vscodeMock,
      '../adapters/index': {
        getEngine: () => mockEngine,
      },
      '../context/context-builder': {
        buildContext: () => ASSEMBLED_CONTEXT_MARKER,
        getContextSettings: () => ({ enabled: true, maxFileContextChars: 2000, maxContextChars: 50000 }),
        runRetrievalCascade: async () => ({ spans: [], usedSemantic: false }),
        adaptiveContextBudget: () => 50000,
      },
      'child_process': { spawn: localSpawnStub, execSync: sinon.stub() },
    });

    const runner = new TaskRunner(historyStore);
    const records: EngineCallUsage[] = [];
    runner.setUsageRecorder((r: EngineCallUsage) => records.push(r));

    const plan = createEmptyPlan('Assembled Context Plan');
    const pl = plan.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    pl.tasks.push(createTask('Context Task', 'Do the short thing'));

    // Sanity: prove the assembled context actually flowed into task-started's
    // fullPrompt, so a passing assertion below is not just an inert stub.
    let observedFullPrompt = '';
    runner.on('task-started', (_task: unknown, _playlist: unknown, fullPrompt: string) => {
      observedFullPrompt = fullPrompt;
    });

    await runner.play(plan);

    assert.ok(observedFullPrompt.includes(ASSEMBLED_CONTEXT_MARKER),
      'test setup must actually exercise the assembled-context path');
    assert.equal(records.length, 1);
    assert.equal(records[0].prompt, 'Do the short thing');
    assert.ok(!records[0].prompt.includes('ASSEMBLED-CONTEXT-'),
      'usage recorder must never see assembled buildContext() output');
    assert.ok(records[0].prompt.length < 100,
      'the recorded prompt must be the short human prompt, not a large assembled blob');
  });
});


// ─── Hosted-server worker: deferred stop on the manual gate ───
//
// The server's run worker (src/server/run-worker.ts) stops the runner one tick
// AFTER the 'manual-gate' emit. This pins that the deferred path really unwinds:
// play() resolves promptly and the gate task ends Failed (halted, not approved).

describe('TaskRunner — deferred stop on manual-gate (server worker path)', () => {
  afterEach(() => { sinon.restore(); });

  function manualPlan(): Plan {
    const plan = createEmptyPlan('Gate Plan');
    const pl = plan.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    const gate = createTask('Release v1.0.0', 'Ship it');
    gate.type = 'manual';
    pl.tasks.push(gate);
    return plan;
  }

  it('play() resolves within 3 s and the gate task is Failed when stop() is deferred via setImmediate', async function () {
    this.timeout(5000);
    const prevCi = process.env.CI;
    delete process.env.CI;
    try {
      const { runner } = buildRunner();
      const plan = manualPlan();
      let gateSeen = false;
      runner.on('manual-gate', () => {
        gateSeen = true;
        setImmediate(() => runner.stop());
      });
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 3000); });
      const outcome = await Promise.race([runner.play(plan).then(() => 'resolved' as const), timeout]);
      if (timer) { clearTimeout(timer); }
      assert.equal(outcome, 'resolved', 'play() must resolve within 3 s');
      assert.ok(Date.now() - started < 3000);
      assert.equal(gateSeen, true);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
      assert.equal(runner.state, RunnerState.Idle);
    } finally {
      if (prevCi === undefined) { delete process.env.CI; } else { process.env.CI = prevCi; }
    }
  });
});

// ─── Project standards in the prompt ───

describe('TaskRunner — project standards', () => {
  const TEXT = 'Project standards v3 · stack node-ts · brownfield repository\n### Comments\n- Never leave commented-out code';
  const SECTION = `## Project Standards\n${TEXT}`;

  type ContextMode = 'off' | 'empty' | 'real';

  /** A runner whose engine records every prompt. `real` loads the real context builder. */
  function build(mode: ContextMode) {
    const historyStore = createMockHistoryStore();
    const mockEngine = createMockEngine();
    const prompts: string[] = [];
    const contextOptions: Array<Record<string, unknown>> = [];
    engineRunStub.callsFake(async (opts: { prompt: string }) => { prompts.push(opts.prompt); return mockEngineResult; });
    spawnStub = sinon.stub().callsFake(() => createSpawnProc());

    const stubs: Record<string, unknown> = {
      'vscode': vscodeMock,
      '../adapters/index': { getEngine: () => mockEngine },
      'child_process': { spawn: spawnStub, execSync: sinon.stub() },
    };
    if (mode !== 'real') {
      stubs['../context/context-builder'] = {
        buildContext: (opts: Record<string, unknown>) => { contextOptions.push(opts); return ''; },
        getContextSettings: () => ({ enabled: mode !== 'off', maxContextChars: 30000, maxFileContextChars: 4000 }),
        runRetrievalCascade: async () => ({ spans: [], usedSemantic: false }),
        adaptiveContextBudget: (_t: unknown, base: number) => base,
      };
    }
    const { TaskRunner } = proxyquire('../../../runner/runner', stubs);
    return { runner: new TaskRunner(historyStore), prompts, contextOptions, mockEngine };
  }

  function plan(tasks: Array<{ name: string; prompt: string; type?: 'agent' | 'command'; command?: string; dependsOn?: string[] }> = [{ name: 'Only', prompt: 'Do the thing' }]): Plan {
    const p = createEmptyPlan('Standards Plan');
    const pl = p.playlists[0];
    pl.autoplay = true;
    pl.autoplayDelay = 0;
    for (const spec of tasks) {
      const t = createTask(spec.name, spec.prompt);
      if (spec.type) { t.type = spec.type; }
      if (spec.command) { t.command = spec.command; }
      pl.tasks.push(t);
    }
    return p;
  }

  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  afterEach(() => {
    vscodeMock.clearMockConfig();
    sinon.restore();
  });

  describe('run-start hook', () => {
    it('runs once per run, before the first task reaches its engine', async () => {
      const { runner, prompts } = build('off');
      const seen: Array<{ cwd: string; promptsSoFar: number }> = [];
      runner.setRunStartHook(async (cwd: string) => {
        await new Promise((resolve) => setImmediate(resolve));
        seen.push({ cwd, promptsSoFar: prompts.length });
      });

      await runner.play(plan([{ name: 'One', prompt: 'first' }, { name: 'Two', prompt: 'second' }]));

      assert.equal(seen.length, 1, 'once for the run, not once per task');
      assert.equal(seen[0].promptsSoFar, 0, 'awaited before any task started');
      assert.equal(typeof seen[0].cwd, 'string');
      assert.equal(prompts.length, 2);
    });

    it('a hook that throws or rejects never fails the run', async () => {
      for (const hook of [() => { throw new Error('disk full'); }, async () => { throw new Error('git missing'); }]) {
        const { runner, prompts } = build('off');
        const errors: Error[] = [];
        runner.on('error', (err: Error) => errors.push(err));
        runner.setRunStartHook(hook);
        const p = plan();
        await runner.play(p);
        assert.equal(prompts.length, 1);
        assert.equal(p.playlists[0].tasks[0].status, TaskStatus.Completed);
        assert.deepEqual(errors, []);
      }
    });

    it('fires for a single-task run and a task-list run too, and not at all once cleared', async () => {
      const single = build('off');
      let calls = 0;
      single.runner.setRunStartHook(() => { calls++; });
      await single.runner.playTask(plan(), 0, 0);
      assert.equal(calls, 1);

      const list = build('off');
      list.runner.setRunStartHook(() => { calls++; });
      await list.runner.playTasks(plan(), [{ playlistIndex: 0, taskIndex: 0 }]);
      assert.equal(calls, 2);

      const cleared = build('off');
      cleared.runner.setRunStartHook(() => { calls++; });
      cleared.runner.setRunStartHook(null);
      await cleared.runner.play(plan());
      assert.equal(calls, 2);
    });
  });

  it('carries the standards even when context is disabled', async () => {
    const { runner, prompts } = build('off');
    runner.setStandardsProvider(() => ({ text: TEXT, version: 3 }));

    await runner.play(plan());

    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].startsWith(`${SECTION}\n\n`), prompts[0]);
    assert.ok(prompts[0].includes('Do the thing'));
  });

  it('hands the text to the context builder, and prepends it when the built context lacks the section', async () => {
    const { runner, prompts, contextOptions } = build('empty');
    runner.setStandardsProvider(() => ({ text: `  ${TEXT}\n`, version: 3 }));

    await runner.play(plan());

    assert.equal(contextOptions[0].standards, TEXT, 'trimmed text reaches the builder');
    assert.equal(occurrences(prompts[0], '## Project Standards'), 1);
    assert.ok(prompts[0].startsWith(SECTION));
  });

  it('with the real context builder: ## Project Standards sits directly before ## AI Rules, exactly once', async () => {
    const { runner, prompts } = build('real');
    runner.setStandardsProvider(() => ({ text: TEXT, version: 3 }));
    runner.setAiRulesStore({ getEnabledText: () => '### House Rule\nKeep modules small' } as never);

    await runner.play(plan());

    assert.equal(occurrences(prompts[0], '## Project Standards'), 1, 'no duplicate from the fallback');
    assert.ok(prompts[0].includes(`${SECTION}\n\n## AI Rules\n### House Rule`), prompts[0].slice(0, 600));
    assert.ok(prompts[0].indexOf('[CONTEXT START]') < prompts[0].indexOf('## Project Standards'));
  });

  it('with the real context builder and a budget smaller than the block: still whole, still once', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer.context', { maxContextChars: 1000 });
    const big = `${TEXT}\n${'- another convention line for the agent\n'.repeat(80)}`.trim();
    assert.ok(big.length > 3000);
    const { runner, prompts } = build('real');
    runner.setStandardsProvider(() => ({ text: big, version: 3 }));
    runner.setAiRulesStore({ getEnabledText: () => '### House Rule\nKeep modules small' } as never);

    await runner.play(plan());

    assert.ok(prompts[0].includes(`## Project Standards\n${big}`), 'the whole block is present');
    assert.equal(occurrences(prompts[0], '## Project Standards'), 1);
    assert.ok(!prompts[0].includes('## AI Rules'), 'the squeeze drops other sections, never the standards');
  });

  it('carries the design system after the standards when context is disabled; without one the prompt is unchanged', async () => {
    const DESIGN = 'Design system v3 · DESIGN.md at docs/design/DESIGN.md · tokens in css/tokens.css\nTokens:\n--color-bg: #ffffff';
    const withDesign = build('off');
    withDesign.runner.setStandardsProvider(() => ({ text: TEXT, version: 3, design: DESIGN }));
    await withDesign.runner.play(plan());
    assert.ok(withDesign.prompts[0].startsWith(`${SECTION}\n\n## Design System\n${DESIGN}\n\n`), withDesign.prompts[0].slice(0, 400));
    const plain = build('off');
    plain.runner.setStandardsProvider(() => ({ text: TEXT, version: 3 }));
    await plain.runner.play(plan());
    const blank = build('off');
    blank.runner.setStandardsProvider(() => ({ text: TEXT, version: 3, design: '   ' }));
    await blank.runner.play(plan());
    assert.equal(blank.prompts[0], plain.prompts[0], 'a blank design adds nothing');
    assert.ok(!plain.prompts[0].includes('## Design System'));
  });

  it('hands the design text to the context builder', async () => {
    const { runner, contextOptions } = build('empty');
    runner.setStandardsProvider(() => ({ text: TEXT, version: 3, design: ' Design system v3 ' }));
    await runner.play(plan());
    assert.equal(contextOptions[0].design, 'Design system v3');
  });

  it('with the real context builder the design system appears exactly once, after the standards', async () => {
    const DESIGN = 'Design system v3 · tokens in css/tokens.css';
    const { runner, prompts } = build('real');
    runner.setStandardsProvider(() => ({ text: TEXT, version: 3, design: DESIGN }));
    await runner.play(plan());
    assert.equal(occurrences(prompts[0], '## Design System'), 1);
    assert.ok(prompts[0].indexOf('## Project Standards') < prompts[0].indexOf('## Design System'));
  });

  it('passes the built-in rules the store already carries as skipRuleNames', async () => {
    const { runner } = build('off');
    const seen: Array<{ cwd: string; skipRuleNames: string[] }> = [];
    runner.setStandardsProvider((cwd: string, opts: { skipRuleNames: string[] }) => { seen.push({ cwd, ...opts }); return { text: TEXT, version: 1 }; });
    runner.setAiRulesStore({ getEnabledText: () => '### Clean Code\nbody\n\n### Test-Driven Development\nbody\n\n### My Own Rule\nbody' } as never);

    await runner.play(plan());

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].skipRuleNames, ['Clean Code', 'Test-Driven Development']);
  });

  it('adds nothing when no provider is set, or the provider reports no standards', async () => {
    const none = build('off');
    await none.runner.play(plan());
    assert.ok(!none.prompts[0].includes('## Project Standards'));

    const empty = build('off');
    empty.runner.setStandardsProvider(() => null);
    await empty.runner.play(plan());
    assert.ok(!empty.prompts[0].includes('## Project Standards'));

    const cleared = build('off');
    cleared.runner.setStandardsProvider(() => ({ text: TEXT, version: 3 }));
    cleared.runner.setStandardsProvider(null);
    await cleared.runner.play(plan());
    assert.ok(!cleared.prompts[0].includes('## Project Standards'));
  });

  it('a provider that throws fails the task with the file-named error and never calls the engine', async () => {
    const { runner, prompts } = build('off');
    runner.setStandardsProvider(() => { throw new Error('".moag/standards.json" contains invalid JSON. Check for syntax errors.'); });
    const failed: Array<{ name: string; stderr: string; exitCode: number }> = [];
    const output: string[] = [];
    runner.on('task-failed', (t: Task, r: EngineResult) => failed.push({ name: t.name, stderr: r.stderr, exitCode: r.exitCode }));
    runner.on('task-output', (_t: Task, text: string) => output.push(text));
    runner.on('error', () => undefined);

    const p = plan([{ name: 'First', prompt: 'a' }, { name: 'Second', prompt: 'b' }]);
    p.playlists[0].tasks[1].dependsOn = [p.playlists[0].tasks[0].id];
    await runner.play(p);

    assert.equal(prompts.length, 0, 'no agent may run without the standards it is bound by');
    assert.equal(p.playlists[0].tasks[0].status, TaskStatus.Failed);
    assert.equal(failed[0].name, 'First');
    assert.match(failed[0].stderr, /"\.moag\/standards\.json" contains invalid JSON/);
    assert.equal(failed[0].exitCode, 1);
    assert.ok(output.some((o) => /\[Standards Error\] "\.moag\/standards\.json" contains invalid JSON/.test(o)));
    assert.equal(p.playlists[0].tasks[1].status, TaskStatus.Blocked, 'a dependent task is blocked, not run');
  });

  it('does not ask for standards for a task that sends no prompt to an agent', async () => {
    const { runner } = build('off');
    let calls = 0;
    runner.setStandardsProvider(() => { calls++; throw new Error('must not be reached'); });

    const p = plan([{ name: 'Build', prompt: '', type: 'command', command: 'echo ok' }]);
    await runner.play(p);

    assert.equal(calls, 0);
    assert.equal(p.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  it('keeps the block when a huge task prompt forces the 80K truncation', async () => {
    const { runner, prompts } = build('off');
    runner.setStandardsProvider(() => ({ text: TEXT, version: 3 }));

    await runner.play(plan([{ name: 'Huge', prompt: 'x'.repeat(90_000) }]));

    assert.ok(prompts[0].startsWith(`${SECTION}\n\n`));
    assert.ok(prompts[0].includes('[prompt truncated at 80K chars]'));
    assert.ok(prompts[0].length < 80_100);
  });
});

// ─── Task-settled hook (headless task-changes) ───

describe('TaskRunner — task-settled hook', () => {
  const HEAD = 'c'.repeat(40);
  type SettledInfo = {
    taskId: string; status: TaskStatus; cwd: string; snapshotRef: string | null; headRef: string | null;
    untrackedAtStart: string[] | null; commit: { sha: string; branch: string } | null;
  };

  /** A runner whose git answers the three start-fact commands; `extra` adds proxyquire stubs. */
  function build(extra: Record<string, unknown> = {}) {
    const historyStore = createMockHistoryStore();
    const mockEngine = createMockEngine();
    spawnStub = sinon.stub().callsFake((cmd: string, args: string[] = []) => {
      if (cmd === 'git' && args[0] === 'stash' && args[1] === 'create') { return createSpawnProc({ stdoutChunks: ['stashsha'] }); }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') { return createSpawnProc({ stdoutChunks: [HEAD] }); }
      if (cmd === 'git' && args[0] === 'ls-files') { return createSpawnProc({ stdoutChunks: ['old.txt\0'] }); }
      return createSpawnProc();
    });
    const mod = proxyquire('../../../runner/runner', {
      'vscode': vscodeMock,
      '../adapters/index': { getEngine: () => mockEngine },
      '../context/context-builder': { buildContext: () => '', getContextSettings: () => ({ enabled: false }) },
      'child_process': { spawn: spawnStub, execSync: sinon.stub() },
      '../utils/process-kill': { killProcess: sinon.stub(), SPAWN_DETACHED: false },
      ...extra,
    });
    return { TaskRunner: mod.TaskRunner, runner: new mod.TaskRunner(historyStore) };
  }

  const spawnedLsFiles = (): boolean => spawnStub.getCalls().some((c) => c.args[0] === 'git' && (c.args[1] as string[])[0] === 'ls-files');

  afterEach(() => {
    vscodeMock.clearMockConfig();
    sinon.restore();
  });

  it('is called once for a completed task, before task-completed, with the start facts', async () => {
    const { runner } = build();
    const order: string[] = [];
    const infos: SettledInfo[] = [];
    runner.setTaskSettledHook(async (info: SettledInfo) => { order.push('hook'); infos.push(info); });
    runner.on('task-completed', () => order.push('completed'));
    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];

    await runner.play(plan);

    assert.deepEqual(order, ['hook', 'completed']);
    assert.equal(infos.length, 1);
    assert.equal(infos[0].taskId, plan.playlists[0].tasks[0].id);
    assert.equal(infos[0].status, TaskStatus.Completed);
    assert.equal(infos[0].snapshotRef, 'stashsha');
    assert.equal(infos[0].headRef, HEAD);
    assert.deepEqual(infos[0].untrackedAtStart, ['old.txt']);
    assert.equal(infos[0].commit, null);
    assert.equal(typeof infos[0].cwd, 'string');
  });

  it('is called for a failed task, before task-failed', async () => {
    const { runner } = build();
    engineRunStub.resolves({ ...mockEngineResult, exitCode: 1 });
    const order: string[] = [];
    runner.setTaskSettledHook((info: SettledInfo) => { order.push(`hook:${info.status}`); });
    runner.on('task-failed', () => order.push('failed'));
    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];

    await runner.play(plan);

    assert.deepEqual(order, ['hook:failed', 'failed']);
  });

  it('is not called for a dependency-blocked task', async () => {
    const { runner } = build();
    engineRunStub.resolves({ ...mockEngineResult, exitCode: 1 });
    const ids: string[] = [];
    runner.setTaskSettledHook((info: SettledInfo) => { ids.push(info.taskId); });
    const plan = makePlan();
    plan.playlists[0].tasks[0].id = 'dep-task';
    plan.playlists[0].tasks[1].dependsOn = ['dep-task'];

    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[1].status, TaskStatus.Blocked);
    assert.deepEqual(ids, ['dep-task']);
  });

  it('is not called for a skipped task', async () => {
    const { runner } = build();
    const ids: string[] = [];
    runner.setTaskSettledHook((info: SettledInfo) => { ids.push(info.taskId); });
    const plan = makePlan();
    const [first, second] = plan.playlists[0].tasks;
    second.skipIf = { taskId: first.id, status: TaskStatus.Completed };

    await runner.play(plan);

    assert.equal(second.status, TaskStatus.Skipped);
    assert.deepEqual(ids, [first.id]);
  });

  it('a throwing hook never changes the outcome', async () => {
    for (const hook of [() => { throw new Error('sync boom'); }, async () => { throw new Error('async boom'); }]) {
      const { runner } = build();
      const completed: string[] = [];
      runner.on('task-completed', (t: Task) => completed.push(t.id));
      runner.setTaskSettledHook(hook);
      const plan = makePlan();
      plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
      await runner.play(plan);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
      assert.deepEqual(completed, [plan.playlists[0].tasks[0].id]);
    }
  });

  describe('bounded', () => {
    let restore: (() => void) | null = null;
    afterEach(() => { restore?.(); restore = null; });

    it('a never-resolving hook is abandoned after TASK_SETTLED_HOOK_MS and its signal aborts', async () => {
      const { runner, TaskRunner } = build();
      const original = TaskRunner.TASK_SETTLED_HOOK_MS;
      TaskRunner.TASK_SETTLED_HOOK_MS = 30;
      restore = () => { TaskRunner.TASK_SETTLED_HOOK_MS = original; };
      let seen: AbortSignal | null = null;
      runner.setTaskSettledHook((_info: SettledInfo, signal: AbortSignal) => { seen = signal; return new Promise<void>(() => undefined); });
      const completed: string[] = [];
      runner.on('task-completed', (t: Task) => completed.push(t.id));
      const plan = makePlan();
      plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];

      await runner.play(plan);

      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
      assert.equal(completed.length, 1);
      assert.ok(seen);
      assert.equal((seen as AbortSignal).aborted, true);
    });

    it('stop() aborts a never-resolving hook at once: the task still completes, well under TASK_SETTLED_HOOK_MS', async () => {
      const { runner, TaskRunner } = build();
      assert.equal(TaskRunner.TASK_SETTLED_HOOK_MS, 20_000, 'the real bound is in force');
      let seen: AbortSignal | null = null;
      runner.setTaskSettledHook((_info: SettledInfo, signal: AbortSignal) => {
        seen = signal;
        setTimeout(() => runner.stop(), 10);
        return new Promise<void>(() => undefined);
      });
      const completed: string[] = [];
      runner.on('task-completed', (t: Task) => completed.push(t.id));
      const plan = makePlan();
      plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];

      const t0 = Date.now();
      await runner.play(plan);
      const elapsed = Date.now() - t0;

      assert.ok(elapsed < 5_000, `play() settled in ${elapsed} ms`);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed, 'the outcome is unchanged');
      assert.deepEqual(completed, [plan.playlists[0].tasks[0].id]);
      assert.ok(seen);
      assert.equal((seen as AbortSignal).aborted, true);
    });

    it('a hook that settles normally is not aborted by a later stop()', async () => {
      const { runner } = build();
      let seen: AbortSignal | null = null;
      runner.setTaskSettledHook((_info: SettledInfo, signal: AbortSignal) => { seen = signal; });
      const plan = makePlan();
      plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
      await runner.play(plan);
      runner.stop();
      assert.ok(seen);
      assert.equal((seen as AbortSignal).aborted, false);
    });
  });

  it('with no hook, no start facts are captured (no ls-files spawn)', async () => {
    const { runner } = build();
    const plan = makePlan();
    await runner.play(plan);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(spawnedLsFiles(), false);
  });

  it('a cleared hook is not called and captures nothing', async () => {
    const { runner } = build();
    let calls = 0;
    runner.setTaskSettledHook(() => { calls++; });
    runner.setTaskSettledHook(null);
    await runner.play(makePlan());
    assert.equal(calls, 0);
    assert.equal(spawnedLsFiles(), false);
  });

  it('carries the full commit sha and the delivery branch when delivery committed the task', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { 'git.autoCommit': true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const realDelivery = require('../../../runner/git-delivery');
    const { runner } = build({
      './git-delivery': {
        ...realDelivery,
        prepareBranch: async () => ({ ok: true, branch: 'moag/p', created: true }),
        commitTask: async () => ({ committed: true, sha: 'abc1234', fullSha: 'f'.repeat(40) }),
      },
    });
    const infos: SettledInfo[] = [];
    runner.setTaskSettledHook((info: SettledInfo) => { infos.push(info); });
    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];

    await runner.play(plan);

    assert.equal(infos.length, 1);
    assert.deepEqual(infos[0].commit, { sha: 'f'.repeat(40), branch: 'moag/p' });
  });

  describe('the full sha is read only for the hook', () => {
    /** Real commitTask over a recording git; returns the git calls and the options the runner passed. */
    function buildRecording() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const realDelivery = require('../../../runner/git-delivery');
      const gitCalls: string[][] = [];
      const optsSeen: unknown[] = [];
      const git = async (args: string[]): Promise<string | null> => {
        gitCalls.push(args);
        if (args[0] === 'diff') { return 'src/a.ts'; }
        if (args[0] === 'rev-parse' && args[1] === '--short') { return 'abc1234'; }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') { return 'e'.repeat(40); }
        return '';
      };
      const built = build({
        './git-delivery': {
          ...realDelivery,
          prepareBranch: async () => ({ ok: true, branch: 'moag/p', created: true }),
          commitTask: (req: unknown, _git: unknown, opts?: unknown) => { optsSeen.push(opts); return realDelivery.commitTask(req, git, opts); },
        },
      });
      const revParseHead = (): boolean => gitCalls.some((a) => a[0] === 'rev-parse' && a[1] === 'HEAD');
      return { ...built, gitCalls, optsSeen, revParseHead };
    }

    it('with no hook, the commit makes no rev-parse HEAD call', async () => {
      vscodeMock.setMockConfig('agentTaskPlayer', { 'git.autoCommit': true });
      const { runner, gitCalls, optsSeen, revParseHead } = buildRecording();
      const plan = makePlan();
      plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
      await runner.play(plan);
      assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
      assert.ok(gitCalls.some((a) => a[0] === 'commit'), 'the task was committed');
      assert.deepEqual(optsSeen, [{ fullSha: false }]);
      assert.equal(revParseHead(), false);
    });

    it('with a hook, rev-parse HEAD is called and the hook gets the full sha', async () => {
      vscodeMock.setMockConfig('agentTaskPlayer', { 'git.autoCommit': true });
      const { runner, optsSeen, revParseHead } = buildRecording();
      const infos: SettledInfo[] = [];
      runner.setTaskSettledHook((info: SettledInfo) => { infos.push(info); });
      const plan = makePlan();
      plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
      await runner.play(plan);
      assert.deepEqual(optsSeen, [{ fullSha: true }]);
      assert.equal(revParseHead(), true);
      assert.deepEqual(infos[0].commit, { sha: 'e'.repeat(40), branch: 'moag/p' });
    });
  });

  it('a commit without a readable full sha reports commit null', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { 'git.autoCommit': true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const realDelivery = require('../../../runner/git-delivery');
    const { runner } = build({
      './git-delivery': {
        ...realDelivery,
        prepareBranch: async () => ({ ok: true, branch: 'moag/p', created: true }),
        commitTask: async () => ({ committed: true, sha: 'abc1234', fullSha: null }),
      },
    });
    const infos: SettledInfo[] = [];
    runner.setTaskSettledHook((info: SettledInfo) => { infos.push(info); });
    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    await runner.play(plan);
    assert.equal(infos[0].commit, null);
  });
});

// ─── Required delivery branch (ONOSOO remote runs) ───

describe('TaskRunner — required delivery branch', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realDelivery = require('../../../runner/git-delivery');

  function build(prepare: (...args: unknown[]) => Promise<unknown>) {
    const historyStore = createMockHistoryStore();
    const mockEngine = createMockEngine();
    spawnStub = sinon.stub().callsFake(() => createSpawnProc());
    const prepareCalls: unknown[][] = [];
    const { TaskRunner } = proxyquire('../../../runner/runner', {
      'vscode': vscodeMock,
      '../adapters/index': { getEngine: () => mockEngine },
      '../context/context-builder': { buildContext: () => '', getContextSettings: () => ({ enabled: false }) },
      'child_process': { spawn: spawnStub, execSync: sinon.stub() },
      '../utils/process-kill': { killProcess: sinon.stub(), SPAWN_DETACHED: false },
      './git-delivery': {
        ...realDelivery,
        prepareBranch: (...args: unknown[]) => { prepareCalls.push(args); return prepare(...args); },
        commitTask: async () => ({ committed: false, reason: 'nothing-to-commit', detail: '' }),
      },
    });
    const runner = new TaskRunner(historyStore);
    const errors: string[] = [];
    const started: string[] = [];
    runner.on('error', (e: Error) => errors.push(e.message));
    runner.on('task-started', (t: Task) => started.push(t.id));
    return { runner, errors, started, prepareCalls };
  }

  const oneTask = (): Plan => {
    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    return plan;
  };

  afterEach(() => { vscodeMock.clearMockConfig(); sinon.restore(); });

  it('required + not a repo: no task starts, one error, state Idle, and the lock is released', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { 'git.autoCommit': true });
    const { runner, errors, started } = build(async () => ({ ok: false, reason: 'not-a-repo', detail: 'Not a git work tree.' }));
    runner.setDeliveryBranch('moag/remote-1', { required: true });
    await runner.play(oneTask());
    assert.deepEqual(started, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /moag\/remote-1/);
    assert.equal(runner.state, RunnerState.Idle);
    assert.equal(runner.deliveryBranch, null);

    // The lock was released: a second play (requirement cleared) runs.
    runner.setDeliveryBranch(null);
    const plan = oneTask();
    await runner.play(plan);
    assert.equal(started.length, 1);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  it('required + auto-commit off: no task starts, one error', async () => {
    const { runner, errors, started, prepareCalls } = build(async () => ({ ok: true, branch: 'x', created: false }));
    runner.setDeliveryBranch('moag/remote-2', { required: true });
    await runner.play(oneTask());
    assert.deepEqual(started, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /git\.autoCommit is off/);
    assert.equal(prepareCalls.length, 0);
  });

  it('a set branch is passed to prepareBranch and exposed while the run delivers to it', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { 'git.autoCommit': true });
    const { runner, started, prepareCalls } = build(async (...args: unknown[]) => ({ ok: true, branch: (args[5] as { branch: string }).branch, created: false }));
    runner.setDeliveryBranch('moag/remote-3', { required: true });
    let during: string | null = null;
    runner.on('task-started', () => { during = runner.deliveryBranch; });
    await runner.play(oneTask());
    assert.equal(started.length, 1);
    assert.deepEqual(prepareCalls[0][5], { branch: 'moag/remote-3' });
    assert.equal(during, 'moag/remote-3');
  });

  it('nothing set: today\'s behaviour — a refusal is a warning and the run proceeds', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { 'git.autoCommit': true });
    const { runner, errors, started, prepareCalls } = build(async () => ({ ok: false, reason: 'dirty-tree', detail: 'dirty' }));
    await runner.play(oneTask());
    assert.equal(errors.length, 1);
    assert.equal(started.length, 1);
    assert.deepEqual(prepareCalls[0][5], {});
  });
});

describe('TaskRunner — automatic dependency installs', () => {
  afterEach(() => {
    sinon.restore();
    vscodeMock.clearMockConfig();
  });

  const failedEvent = {
    event: 'dependencies-install-failed', stage: 'task', taskId: 'x', ecosystem: 'npm', dir: '.',
    trigger: 'manifest-changed', command: 'npm ci --no-audit --no-fund', durationMs: 2500, exitCode: 1,
    timedOut: false, tail: 'npm ERR! ERESOLVE', note: null,
  };

  function commandPlan(command = 'npm run build'): Plan {
    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'command';
    plan.playlists[0].tasks[0].command = command;
    return plan;
  }

  const commandSpawns = (): string[] =>
    spawnStub.getCalls().map((c) => String(c.args[0])).filter((c) => c !== 'git');

  it('a failing install fails the command task without running its command', async () => {
    const { runner } = buildRunner();
    ensureDepsStub.callsFake(async (_cwd: string, o: { onEvent: (ev: unknown) => void }) => {
      o.onEvent(failedEvent);
      return { ok: false, aborted: false, failed: failedEvent, events: [failedEvent] };
    });
    spawnStub.callsFake((command: string) => createSpawnProc({ stdoutChunks: command === 'git' ? ['abc123'] : ['ok'], closeCode: 0 }));
    const seen: unknown[] = [];
    runner.on('dependencies-install-failed', (t: Task, ev: unknown) => seen.push([t.name, ev]));
    const failures: EngineResult[] = [];
    runner.on('task-failed', (_t: Task, r: EngineResult) => failures.push(r));

    const plan = commandPlan();
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    assert.deepEqual(commandSpawns(), [], 'the task command never ran');
    assert.ok(failures[0].stderr.includes('[Dependencies] Install failed: `npm ci --no-audit --no-fund` exited 1 after 2.5s (needed by "Task 1")'));
    assert.ok(failures[0].stderr.includes('ERESOLVE'));
    assert.deepEqual(seen, [['Task 1', failedEvent]]);
  });

  it('a passing install runs the command and forwards the event as (task, ev)', async () => {
    const { runner } = buildRunner();
    const installed = { ...failedEvent, event: 'dependencies-installed', exitCode: 0, tail: 'added 1' };
    ensureDepsStub.callsFake(async (_cwd: string, o: { onEvent: (ev: unknown) => void }) => {
      o.onEvent(installed);
      return { ok: true, aborted: false, failed: null, events: [installed] };
    });
    spawnStub.callsFake((command: string) => createSpawnProc({ stdoutChunks: command === 'git' ? ['abc123'] : ['ok'], closeCode: 0 }));
    const seen: unknown[] = [];
    runner.on('dependencies-installed', (t: Task, ev: unknown) => seen.push([t.id, ev]));

    const plan = commandPlan();
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.deepEqual(commandSpawns(), ['npm run build']);
    assert.deepEqual(seen, [[plan.playlists[0].tasks[0].id, installed]]);
    const [cwd, opts] = ensureDepsStub.firstCall.args;
    assert.equal(typeof cwd, 'string');
    assert.equal(opts.stage, 'task');
    assert.equal(opts.taskId, plan.playlists[0].tasks[0].id);
    assert.equal(opts.timeoutMs, 600_000);
  });

  it('an abort during the install is exit 130 with no failed event', async () => {
    const { runner } = buildRunner();
    ensureDepsStub.callsFake(async () => {
      runner.stop();
      return { ok: false, aborted: true, failed: null, events: [] };
    });
    spawnStub.callsFake((command: string) => createSpawnProc({ stdoutChunks: command === 'git' ? ['abc123'] : ['ok'], closeCode: 0 }));
    let failedEvents = 0;
    runner.on('dependencies-install-failed', () => { failedEvents++; });

    const plan = commandPlan();
    await runner.play(plan);

    assert.equal(failedEvents, 0);
    assert.deepEqual(commandSpawns(), []);
    assert.notEqual(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  it('a verifyCommand whose install fails is a failed verification (pre-flight halts)', async () => {
    const { runner } = buildRunner();
    ensureDepsStub.callsFake(async (_cwd: string, o: { stage: string }) => (o.stage === 'verify'
      ? { ok: false, aborted: false, failed: { ...failedEvent, stage: 'verify' }, events: [] }
      : { ok: true, aborted: false, failed: null, events: [] }));
    spawnStub.callsFake((command: string) => createSpawnProc({ stdoutChunks: command === 'git' ? ['abc123'] : ['ok'], closeCode: 0 }));

    const failures: EngineResult[] = [];
    runner.on('task-failed', (_t: Task, r: EngineResult) => failures.push(r));

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].verifyCommand = 'npm test';
    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed);
    assert.equal(engineRunStub.callCount, 0, 'the agent never ran against a baseline that could not be checked');
    assert.deepEqual(commandSpawns(), [], 'npm test never ran');
    assert.ok(ensureDepsStub.getCalls().some((c) => c.args[1].stage === 'verify'));
    // QA M1: the halt keeps the real reason — marker first, command, tail — and never
    // claims the project's tests were "already broken".
    assert.equal(failures.length, 1);
    const stderr = failures[0].stderr;
    assert.ok(stderr.startsWith('[Dependencies] Install failed: `npm ci --no-audit --no-fund` exited 1 after 2.5s'), stderr);
    assert.ok(stderr.includes('npm ERR! ERESOLVE'), 'the install tail survives');
    assert.ok(stderr.includes('[Pre-flight] The baseline check "npm test" could not run because its dependencies could not be installed'));
    assert.ok(!stderr.includes('Baseline already broken'), stderr);
    assert.equal(failures[0].summary, 'Dependencies could not be installed.');
  });

  it('a pre-flight install failure with haltOnBrokenBaseline:false says so and lets the agent run', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { haltOnBrokenBaseline: false });
    const { runner } = buildRunner();
    let verifyCalls = 0;
    ensureDepsStub.callsFake(async (_cwd: string, o: { stage: string }) => {
      if (o.stage === 'verify' && verifyCalls++ === 0) {
        return { ok: false, aborted: false, failed: { ...failedEvent, stage: 'verify' }, events: [] };
      }
      return { ok: true, aborted: false, failed: null, events: [] };
    });
    spawnStub.callsFake((command: string) => createSpawnProc({ stdoutChunks: command === 'git' ? ['abc123'] : ['ok'], closeCode: 0 }));
    const output: string[] = [];
    runner.on('task-output', (_t: Task, chunk: string) => output.push(chunk));

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].verifyCommand = 'npm test';
    await runner.play(plan);

    const text = output.join('');
    assert.ok(text.includes('[Pre-flight] Dependencies could not be installed for the baseline check'), text);
    assert.ok(!text.includes('Baseline already broken'), text);
    assert.equal(engineRunStub.callCount, 1, 'the agent ran');
  });

  it('agent tasks never call the installer', async () => {
    const { runner } = buildRunner();
    spawnStub.callsFake(() => createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 }));
    const plan = makePlan();
    await runner.play(plan);
    assert.equal(engineRunStub.callCount, 2);
    assert.equal(ensureDepsStub.callCount, 0);
  });

  it('autoInstallDependencies:false reaches the installer as enabled:false', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { autoInstallDependencies: false, 'dependencyInstall.ignoreScripts': true });
    const { runner } = buildRunner();
    spawnStub.callsFake((command: string) => createSpawnProc({ stdoutChunks: command === 'git' ? ['abc123'] : ['ok'], closeCode: 0 }));
    await runner.play(commandPlan());
    assert.equal(ensureDepsStub.callCount, 1);
    assert.deepEqual(ensureDepsStub.firstCall.args[1].settings, { enabled: false, ignoreScripts: true, pythonVenv: null });
  });

  it('the unit-test default is off (no test may install into the repository)', async () => {
    const { runner } = buildRunner();
    spawnStub.callsFake((command: string) => createSpawnProc({ stdoutChunks: command === 'git' ? ['abc123'] : ['ok'], closeCode: 0 }));
    await runner.play(commandPlan());
    assert.equal(ensureDepsStub.firstCall.args[1].settings.enabled, false);
  });
});
