// ─── A stop that lands while a task is starting (real runner) ───
//
// Regression for the gap between `task-started` and the task's abort listener:
// the runner awaits `captureGitRef` there, and a `stop()` in that window aborted
// the parent signal before `executeTask` subscribed to it. The listener never
// fired, so the task's command (or agent) was spawned anyway and ran
// unsupervised, and a manual gate waited forever — `play()` never settled and a
// server worker never exited. These tests use the REAL TaskRunner and the real
// `child_process`; `captureGitRef` is replaced on the instance so the stop lands
// exactly in that window.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEmptyPlan, createTask } from '../../../models/plan';
import { Plan, RunnerState, TaskStatus, TaskType } from '../../../models/types';
import type { TaskRunner as TaskRunnerType } from '../../../runner/runner';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

// The real runner and the REAL child_process; only the adapter registry (which
// pulls in the VS Code-only Copilot adapter) and the context builder are stubbed.
const { TaskRunner } = proxyquire('../../../runner/runner', {
  'vscode': vscodeMock,
  '../adapters/index': { getEngine: () => { throw new Error('no engine in this test'); } },
  '../context/context-builder': {
    buildContext: () => '',
    getContextSettings: () => ({ enabled: false }),
    runRetrievalCascade: async () => [],
    adaptiveContextBudget: () => 0,
  },
}) as { TaskRunner: typeof TaskRunnerType };
type TaskRunner = TaskRunnerType;

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && (/spawn EPERM/i.test(err.message) || (err as NodeJS.ErrnoException).code === 'EPERM');
}

function historyStub(): ConstructorParameters<typeof TaskRunnerType>[0] {
  return {
    add: () => undefined,
    getAll: () => [],
    getForTask: () => [],
    clear: () => undefined,
    onDidChange: () => undefined,
  } as unknown as ConstructorParameters<typeof TaskRunnerType>[0];
}

/** A one-task plan whose task runs in `cwd`. */
function onePlan(cwd: string, type: TaskType, extra: Record<string, unknown> = {}): Plan {
  const plan = createEmptyPlan('Stop race');
  const pl = plan.playlists[0];
  pl.autoplay = true;
  pl.autoplayDelay = 0;
  const t = createTask('Racing task', 'p');
  Object.assign(t, { type, cwd, ...extra });
  pl.tasks.push(t);
  return plan;
}

/** Make `captureGitRef` call `stop()` — the stop lands after task-started, before the listener. */
function stopDuringCaptureGitRef(runner: TaskRunner): { calls: () => number } {
  let calls = 0;
  (runner as unknown as { captureGitRef: (cwd: string) => Promise<string | null> }).captureGitRef = async () => {
    calls++;
    runner.stop();
    await new Promise((r) => setTimeout(r, 20));
    return null;
  };
  return { calls: () => calls };
}

/** Resolve `p`, or reject after `ms` (a hung play() must fail the test, not the suite). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); }),
  ]);
}

describe('TaskRunner — stop during task start (real runner)', function () {
  this.timeout(20000);
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-stop-race-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold it briefly */ } });

  it('a command task stopped during captureGitRef is never spawned, and play() resolves', async function () {
    const marker = path.join(dir, 'spawned.txt');
    const command = 'node -e "require(\'fs\').writeFileSync(\'spawned.txt\', \'x\')"';
    const plan = onePlan(dir, 'command', { command });
    const runner = new TaskRunner(historyStub());
    const hook = stopDuringCaptureGitRef(runner);
    const started: string[] = [];
    runner.on('task-started', (t: { id: string }) => started.push(t.id));

    try {
      await within(runner.play(plan), 10000, 'play()');
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); }
      throw err;
    }
    // Give a wrongly spawned child time to write its marker before asserting.
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(hook.calls(), 1, 'the stop must land inside captureGitRef');
    assert.equal(started.length, 1, 'the task started');
    assert.equal(fs.existsSync(marker), false, 'the command must never be spawned after the stop');
    assert.notEqual(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(runner.state, RunnerState.Idle);
  });

  it('a pre-flight baseline is not run (and not reported as broken) after such a stop', async function () {
    const marker = path.join(dir, 'baseline.txt');
    const verify = 'node -e "require(\'fs\').writeFileSync(\'baseline.txt\', \'x\')"';
    const plan = onePlan(dir, 'command', { command: 'node -e "0"', verifyCommand: verify });
    const runner = new TaskRunner(historyStub());
    stopDuringCaptureGitRef(runner);
    const output: string[] = [];
    runner.on('task-output', (_t: unknown, chunk: string) => output.push(chunk));

    try {
      await within(runner.play(plan), 10000, 'play()');
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); }
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(fs.existsSync(marker), false, 'the baseline command must not run');
    assert.ok(!output.join('').includes('Baseline already broken'), 'a stop is not a broken baseline');
  });

  it('a manual gate stopped during captureGitRef never parks: no manual-gate event, and play() resolves', async () => {
    const plan = onePlan(dir, 'manual');
    const runner = new TaskRunner(historyStub());
    stopDuringCaptureGitRef(runner);
    let gates = 0;
    runner.on('manual-gate', () => { gates++; });

    await within(runner.play(plan), 5000, 'play()');

    assert.equal(gates, 0, 'a stopped run must not halt at the gate (that would read as awaiting approval)');
    assert.notEqual(plan.playlists[0].tasks[0].status, TaskStatus.Completed);
    assert.equal(runner.state, RunnerState.Idle);
  });
});
