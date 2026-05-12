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
function buildRunner() {
  const historyStore = createMockHistoryStore();
  const mockEngine = createMockEngine();
  spawnStub = sinon.stub().callsFake(() => createSpawnProc());

  const { TaskRunner } = proxyquire('../../../runner/runner', {
    'vscode': vscodeMock,
    '../adapters/index': {
      getEngine: () => mockEngine,
    },
    '../context/context-builder': {
      buildContext: () => '',
      getContextSettings: () => ({ enabled: false }),
    },
    'child_process': { spawn: spawnStub, execSync: sinon.stub() },
  });

  const runner = new TaskRunner(historyStore);
  return { runner, historyStore, mockEngine };
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
    spawnStub.callsFake((command: string) => {
      if (command === 'git') {
        return createSpawnProc({ stdoutChunks: ['abc123'], closeCode: 0 });
      }
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handlers = (serviceProc as any).__stdoutHandlers;
        if (handlers?.data) {
          handlers.data.forEach((handler: (...args: unknown[]) => void) => handler(Buffer.from('server ready')));
        }
      }, 10);
      return serviceProc;
    });

    const plan = makePlan();
    plan.playlists[0].tasks = [plan.playlists[0].tasks[0]];
    plan.playlists[0].tasks[0].type = 'service';
    plan.playlists[0].tasks[0].command = 'npm run dev';
    plan.playlists[0].tasks[0].readyPattern = 'server ready';

    await runner.play(plan);

    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(runner.getRunningServices().length, 1);
    runner.stopAllServices();
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
});
