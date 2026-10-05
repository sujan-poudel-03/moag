// ─── Run worker: job execution with a fake runner (never installs the shim) ───

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runJob, WorkerDeps, RunnerLike, DeltaOutcomeLike, guardParentPipes, withRepoListing, MAX_REPO_LISTING_CHARS, NON_EVIDENCE_FAILURE_CATEGORIES,
} from '../../../server/run-worker';
import { RunJob, PlanJob, parseWorkerLine } from '../../../server/worker-protocol';
import { buildDeltaPlanPrompt, buildFullPlanPrompt } from '../../../runner/prd-plan';
import { resolveRequirements } from '../../../models/requirements';

interface FakeTask { id: string; name: string; status?: string; engine?: string; }

/** EventEmitter-backed runner whose play() runs a scripted sequence. */
class FakeRunner implements RunnerLike {
  ee = new EventEmitter();
  stopCalls = 0;
  stopCalledDuringEmit = false;
  inEmit = false;
  playArgs: Array<[unknown, number | undefined]> = [];
  forbidden: string[] = [];
  constructor(private readonly script: (r: FakeRunner, plan: { playlists: Array<{ tasks: FakeTask[] }> }) => Promise<void>) {}
  on(ev: string, fn: (...a: never[]) => void): void { this.ee.on(ev, fn as (...a: unknown[]) => void); }
  off(ev: string, fn: (...a: never[]) => void): void { this.ee.off(ev, fn as (...a: unknown[]) => void); }
  emit(ev: string, ...args: unknown[]): void {
    this.inEmit = true;
    try { this.ee.emit(ev, ...args); } finally { this.inEmit = false; }
  }
  async play(plan: unknown, idx?: number): Promise<void> {
    this.playArgs.push([plan, idx]);
    await this.script(this, plan as { playlists: Array<{ tasks: FakeTask[] }> });
  }
  stop(): void {
    this.stopCalls++;
    if (this.inEmit) { this.stopCalledDuringEmit = true; }
  }
  // Present so a test can prove the worker never calls them.
  skipManualGate(): void { this.forbidden.push('skipManualGate'); }
  resolveManualGate(): void { this.forbidden.push('resolveManualGate'); }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function mkPlan(): { defaultEngine: string; playlists: Array<{ engine?: string; tasks: FakeTask[] }> } {
  return {
    defaultEngine: 'claude',
    playlists: [{ engine: 'codex', tasks: [{ id: 'a', name: 'A', status: 'pending' }, { id: 'gate', name: 'Release', status: 'pending' }] }],
  };
}

interface Harness {
  deps: WorkerDeps;
  events: Array<Record<string, unknown>>;
  saves: number;
  verifyCalls: number;
  unsubscribed: number;
  stopDisposed: number;
  triggerStop: () => void;
  costListener: ((e: { estimatedCostUsd: number }) => void) | null;
}

function harness(runner: FakeRunner, over: Partial<WorkerDeps> = {}, plan = mkPlan()): Harness {
  const h: Harness = {
    events: [], saves: 0, verifyCalls: 0, unsubscribed: 0, stopDisposed: 0, triggerStop: () => {}, costListener: null,
    deps: undefined as unknown as WorkerDeps,
  };
  h.deps = {
    runner,
    loadPlan: () => plan,
    savePlanAtomic: () => { h.saves++; },
    getEngine: () => ({ runTask: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) }),
    generateDeltaPlan: async () => ({ kind: 'no-delta' }),
    checkAvailability: async () => [],
    costLedger: { onRecord: (l) => { h.costListener = l; return () => { h.unsubscribed++; h.costListener = null; }; } },
    runVerifyCore: async () => { h.verifyCalls++; return 0; },
    emit: (o) => { h.events.push(o); },
    onStop: (cb) => { h.triggerStop = cb; return () => { h.stopDisposed++; }; },
    env: {},
    validateRoutingConfig: () => ({ dropped: [] }),
    withSyntheticBaseline: (p) => p,
    dehydratePlaylist: (_p, pl) => pl,
    ...over,
  };
  return h;
}

const RUN_JOB: RunJob = { kind: 'run', runId: 'r1', workspace: os.tmpdir(), planPath: '/snap/plan.json', startPlaylistIndex: 1, verify: true, allowedEngines: ['claude'] };

describe('run-worker', () => {
  describe('run mode', () => {
    it('does not call stop() inside the manual-gate emit; calls it after setImmediate', async () => {
      let stopsRightAfterEmit = -1;
      const runner = new FakeRunner(async (r, plan) => {
        r.emit('task-started', plan.playlists[0].tasks[1], plan.playlists[0]);
        r.emit('manual-gate', plan.playlists[0].tasks[1]);
        stopsRightAfterEmit = r.stopCalls;
        await tick();
        await tick();
      });
      const h = harness(runner);
      const code = await runJob(RUN_JOB, h.deps);
      assert.equal(stopsRightAfterEmit, 0, 'stop must be deferred');
      assert.equal(runner.stopCalledDuringEmit, false);
      assert.equal(runner.stopCalls, 1);
      assert.equal(code, 3);
      assert.ok(h.events.some((e) => e.event === 'manual-gate' && e.id === 'gate'));
      assert.deepEqual(runner.forbidden, [], 'the worker never approves or skips a gate');
    });

    it('defers stop() on budget-exceeded and exits 4', async () => {
      let stopsRightAfterEmit = -1;
      const runner = new FakeRunner(async (r) => {
        r.emit('budget-exceeded', { totalCost: 10.5, budget: 10 });
        stopsRightAfterEmit = r.stopCalls;
        await tick();
      });
      const h = harness(runner);
      assert.equal(await runJob(RUN_JOB, h.deps), 4);
      assert.equal(stopsRightAfterEmit, 0);
      assert.equal(runner.stopCalls, 1);
    });

    it('exit 3 and 4 skip verification', async () => {
      for (const ev of ['manual-gate', 'budget-exceeded']) {
        const runner = new FakeRunner(async (r, plan) => {
          r.emit(ev, ev === 'manual-gate' ? plan.playlists[0].tasks[1] : { totalCost: 1, budget: 1 });
          await tick();
        });
        const h = harness(runner);
        await runJob(RUN_JOB, h.deps);
        assert.equal(h.verifyCalls, 0, ev);
      }
    });

    it('exit 1 when a task failed, without verification', async () => {
      const runner = new FakeRunner(async (r, plan) => {
        const t = plan.playlists[0].tasks[0];
        t.status = 'failed';
        r.emit('task-failed', t, { stdout: '', stderr: 'x'.repeat(5000) + 'TAIL', exitCode: 1, durationMs: 1 });
      });
      const h = harness(runner);
      assert.equal(await runJob(RUN_JOB, h.deps), 1);
      assert.equal(h.verifyCalls, 0);
      const tail = h.events.find((e) => e.event === 'task-error-tail');
      assert.ok(tail);
      assert.ok(String(tail.tail).endsWith('TAIL'));
      assert.ok(String(tail.tail).length <= 2000);
    });

    it('exit 0 runs verification and returns its code', async () => {
      const runner = new FakeRunner(async (r, plan) => {
        for (const t of plan.playlists[0].tasks) { t.status = 'completed'; r.emit('task-completed', t); }
      });
      const h = harness(runner, { runVerifyCore: async () => { return 1; } });
      assert.equal(await runJob(RUN_JOB, h.deps), 1, 'verify gaps propagate');
      const h2 = harness(new FakeRunner(async () => {}));
      assert.equal(await runJob(RUN_JOB, h2.deps), 0);
      assert.equal(h2.verifyCalls, 1);
      assert.deepEqual(h2.events.at(-1), { event: 'run-finished', code: 0 });
    });

    it('plays from startPlaylistIndex and persists on every terminal event and at the end', async () => {
      const runner = new FakeRunner(async (r, plan) => {
        const [a, g] = plan.playlists[0].tasks;
        a.status = 'completed'; r.emit('task-completed', a);
        g.status = 'failed'; r.emit('task-failed', g, { stderr: 'no' });
      });
      const h = harness(runner);
      await runJob(RUN_JOB, h.deps);
      assert.equal(runner.playArgs[0][1], 1);
      assert.equal(h.saves, 3, 'completed + failed + final');
    });

    it('emits task-engine from the resolved engine and from engine-fallback', async () => {
      const runner = new FakeRunner(async (r, plan) => {
        r.emit('task-started', plan.playlists[0].tasks[0], plan.playlists[0]);
        r.emit('engine-fallback', { taskId: 'a', fromEngine: 'codex', toEngine: 'gemini' });
      });
      const h = harness(runner);
      await runJob(RUN_JOB, h.deps);
      const engines = h.events.filter((e) => e.event === 'task-engine').map((e) => e.engine);
      assert.deepEqual(engines, ['codex', 'gemini']);
    });

    it('forwards cost records as cost events and every line parses under the protocol', async () => {
      let h!: Harness;
      const runner = new FakeRunner(async () => { h.costListener?.({ estimatedCostUsd: 0.42 }); });
      h = harness(runner);
      await runJob(RUN_JOB, h.deps);
      assert.ok(h.events.some((e) => e.event === 'cost' && e.usd === 0.42));
      for (const e of h.events) {
        assert.ok(parseWorkerLine(JSON.stringify(e)), `protocol rejects ${JSON.stringify(e)}`);
      }
    });

    it('refuses with exit 2 and never plays when CI is set', async () => {
      const runner = new FakeRunner(async () => {});
      const h = harness(runner, { env: { CI: 'true' } });
      assert.equal(await runJob(RUN_JOB, h.deps), 2);
      assert.equal(runner.playArgs.length, 0);
      assert.match(String(h.events[0].message), /CI/);
      const h1 = harness(new FakeRunner(async () => {}), { env: { CI: '1' } });
      assert.equal(await runJob(RUN_JOB, h1.deps), 2, 'any truthy CI is refused');
    });

    it('disposes the cost subscription, stop handler and listeners when play throws', async () => {
      const runner = new FakeRunner(async () => { throw new Error('kaboom'); });
      const h = harness(runner);
      assert.equal(await runJob(RUN_JOB, h.deps), 2);
      assert.equal(h.unsubscribed, 1);
      assert.equal(h.stopDisposed, 1);
      assert.equal(runner.ee.eventNames().length, 0, 'no runner listeners left');
      assert.ok(h.events.some((e) => e.event === 'error' && e.message === 'kaboom'));
      assert.deepEqual(h.events.at(-1), { event: 'run-finished', code: 2 });
    });

    it('disposes the cost subscription when loading the plan throws', async () => {
      const h = harness(new FakeRunner(async () => {}), { loadPlan: () => { throw new Error('bad plan'); } });
      assert.equal(await runJob(RUN_JOB, h.deps), 2);
      assert.equal(h.costListener, null);
    });

    it('an IPC stop request calls runner.stop()', async () => {
      let h!: Harness;
      const runner = new FakeRunner(async () => { h.triggerStop(); });
      h = harness(runner);
      await runJob(RUN_JOB, h.deps);
      assert.equal(runner.stopCalls, 1);
    });

    it('disconnect (parent died): calls stop() and does not finish before play() settles; no verify call', async () => {
      let h!: Harness;
      let releasePlay!: () => void;
      const runner = new FakeRunner(async () => {
        h.triggerStop(); // what process.on('disconnect') invokes
        await new Promise<void>((r) => { releasePlay = r; }); // the runner is aborting + tree-killing the task
      });
      h = harness(runner);
      let finished = false;
      const done = runJob(RUN_JOB, h.deps).then((code) => { finished = true; return code; });
      for (let i = 0; i < 5; i++) { await tick(); }
      assert.equal(runner.stopCalls, 1, 'stop() was called');
      assert.equal(finished, false, 'runJob (and so process.exit in main) waits for play() to settle');
      releasePlay();
      const code = await done;
      assert.equal(finished, true);
      assert.equal(h.verifyCalls, 0, 'a stopped run never makes the verify model call');
      assert.equal(code, 1);
      assert.deepEqual(h.events.at(-1), { event: 'run-finished', code: 1 });
      assert.equal(h.stopDisposed, 1);
    });

    it('guardParentPipes keeps an EPIPE on a dead parent pipe from crashing the worker', () => {
      const out = new EventEmitter();
      const err = new EventEmitter();
      guardParentPipes(out, err, null);
      assert.doesNotThrow(() => out.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      assert.doesNotThrow(() => err.emit('error', new Error('write EPIPE')));
      assert.throws(() => new EventEmitter().emit('error', new Error('unguarded')), /unguarded/, 'control: an unguarded stream throws');
    });

    it('reports the final status and whether the engine ran on every terminal task event', async () => {
      // The runner's real sequence: t1 runs and fails; its dependents are SKIPPED via
      // task-completed; a parallel dependent is BLOCKED via task-failed; a pre-flight
      // halt fails after task-started; a task in flight when Stop arrives fails.
      let h!: Harness;
      const tasks: FakeTask[] = ['t1', 't2', 't3', 'tb', 'tp', 'ts', 'tok'].map((id) => ({ id, name: id, status: 'pending' }));
      const plan = { defaultEngine: 'ollama', playlists: [{ tasks }] };
      const byId = (id: string) => tasks.find((t) => t.id === id)!;
      const runner = new FakeRunner(async (r) => {
        const pl = plan.playlists[0];
        const t1 = byId('t1'); r.emit('task-started', t1, pl); t1.status = 'failed'; r.emit('task-failed', t1, { exitCode: 1, stderr: 'tests failed' });
        for (const id of ['t2', 't3']) { const t = byId(id); t.status = 'skipped'; r.emit('task-completed', t, { stderr: 'Skipped: dependency not met', exitCode: 0 }); }
        const tb = byId('tb'); tb.status = 'blocked'; r.emit('task-failed', tb, { stderr: 'Blocked: dependency failed', exitCode: 1 });
        const tp = byId('tp'); r.emit('task-started', tp, pl); tp.status = 'failed';
        r.emit('task-failed', tp, { stderr: '[Pre-flight] Baseline already broken (exit 1) — halting to prevent cascading failures.\n', exitCode: 1 });
        const tok = byId('tok'); r.emit('task-started', tok, pl); tok.status = 'completed'; r.emit('task-completed', tok, { exitCode: 0 });
        const ts = byId('ts'); r.emit('task-started', ts, pl);
        h.triggerStop();
        ts.status = 'failed'; r.emit('task-failed', ts, { exitCode: 1, stderr: 'aborted' });
      });
      h = harness(runner, {}, plan as ReturnType<typeof mkPlan>);
      await runJob(RUN_JOB, h.deps);
      const terminal = h.events.filter((e) => e.event === 'task-completed' || e.event === 'task-failed')
        .map((e) => [e.id, e.event, e.status, e.engineRan]);
      assert.deepEqual(terminal, [
        ['t1', 'task-failed', 'failed', true],
        ['t2', 'task-completed', 'skipped', false],
        ['t3', 'task-completed', 'skipped', false],
        ['tb', 'task-failed', 'blocked', false],
        ['tp', 'task-failed', 'failed', false],
        ['tok', 'task-completed', 'completed', true],
        ['ts', 'task-failed', 'failed', false],
      ]);
      for (const e of h.events) { assert.ok(parseWorkerLine(JSON.stringify(e)), `protocol rejects ${JSON.stringify(e)}`); }
      const parsed = parseWorkerLine(JSON.stringify(h.events.find((e) => e.id === 't2')));
      assert.deepEqual(parsed, { event: 'task-completed', id: 't2', name: 't2', status: 'skipped', engineRan: false });
    });

    it('a failure caused by the environment (auth, rate limit, missing CLI) is not an engine verdict', async () => {
      const tasks: FakeTask[] = ['auth', 'rate', 'cli', 'real', 'odd'].map((id) => ({ id, name: id, status: 'pending' }));
      const plan = { defaultEngine: 'claude', playlists: [{ tasks }] };
      const out: Record<string, string> = {
        auth: 'Error: Invalid API key', rate: '429 Too Many Requests', cli: 'spawn claude ENOENT', real: '3 failing', odd: 'boom',
      };
      const runner = new FakeRunner(async (r) => {
        for (const t of tasks) {
          r.emit('task-started', t, plan.playlists[0]);
          t.status = 'failed';
          r.emit('task-failed', t, { exitCode: 1, stderr: out[t.id], stdout: '' });
        }
      });
      const seen: Array<[string, string]> = [];
      const failureCategory = (stderr: string, stdout: string): string => {
        seen.push([stderr, stdout]);
        if (stderr === 'boom') { throw new Error('classifier broke'); }
        return /api key/i.test(stderr) ? 'auth' : /429/.test(stderr) ? 'rate-limit' : /ENOENT/.test(stderr) ? 'cli-missing' : 'test';
      };
      const h = harness(runner, { failureCategory }, plan as ReturnType<typeof mkPlan>);
      await runJob(RUN_JOB, h.deps);
      const ran = Object.fromEntries(h.events.filter((e) => e.event === 'task-failed').map((e) => [e.id, e.engineRan]));
      assert.deepEqual(ran, { auth: false, rate: false, cli: false, real: true, odd: true });
      assert.ok(seen.some(([e]) => e === 'Error: Invalid API key'), 'the classifier sees the task output');
      // Without a classifier (older deps) every failure stays a verdict.
      const tasks2 = [{ id: 'auth', name: 'auth', status: 'pending' }];
      const plan2 = { defaultEngine: 'claude', playlists: [{ tasks: tasks2 }] };
      const r2 = new FakeRunner(async (r) => {
        r.emit('task-started', tasks2[0], plan2.playlists[0]);
        tasks2[0].status = 'failed';
        r.emit('task-failed', tasks2[0], { exitCode: 1, stderr: 'Error: Invalid API key' });
      });
      const h2 = harness(r2, {}, plan2 as ReturnType<typeof mkPlan>);
      await runJob(RUN_JOB, h2.deps);
      assert.equal(h2.events.find((e) => e.event === 'task-failed')?.engineRan, true);
    });

    it('the excluded categories are real runner failure categories', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'runner', 'runner.ts'), 'utf-8');
      for (const c of NON_EVIDENCE_FAILURE_CATEGORIES) { assert.ok(src.includes(`category: '${c}'`), c); }
    });

    it('tasks ending after a ship-gate or budget halt are not engine verdicts', async () => {
      for (const halt of ['manual-gate', 'budget-exceeded']) {
        const runner = new FakeRunner(async (r, plan) => {
          const [a, g] = plan.playlists[0].tasks;
          r.emit('task-started', a, plan.playlists[0]);
          r.emit(halt, halt === 'manual-gate' ? g : { totalCost: 2, budget: 1 });
          a.status = 'failed';
          r.emit('task-failed', a, { exitCode: 1 });
          await tick();
        });
        const h = harness(runner);
        await runJob(RUN_JOB, h.deps);
        const ev = h.events.find((e) => e.event === 'task-failed');
        assert.equal(ev?.engineRan, false, halt);
      }
    });

    it('reports task child pids as task-pid events while the job runs, and unsubscribes after', async () => {
      let child: ((c: { pid: number; alive: boolean }) => void) | null = null;
      let disposed = 0;
      const runner = new FakeRunner(async () => {
        child!({ pid: 9001, alive: true });
        child!({ pid: 9001, alive: false });
      });
      const h = harness(runner, {
        onChildProcess: (l) => { child = l; return () => { disposed++; child = null; }; },
      });
      await runJob(RUN_JOB, h.deps);
      const pids = h.events.filter((e) => e.event === 'task-pid');
      assert.deepEqual(pids, [{ event: 'task-pid', pid: 9001, alive: true }, { event: 'task-pid', pid: 9001, alive: false }]);
      for (const e of pids) { assert.ok(parseWorkerLine(JSON.stringify(e)), 'every task-pid line parses under the protocol'); }
      assert.equal(disposed, 1);
      assert.equal(child, null);
    });

    it('unsubscribes the child tracker when play() throws', async () => {
      let disposed = 0;
      const runner = new FakeRunner(async () => { throw new Error('boom'); });
      const h = harness(runner, { onChildProcess: () => () => { disposed++; } });
      assert.equal(await runJob(RUN_JOB, h.deps), 2);
      assert.equal(disposed, 1);
    });

    it('warns for each routing.json value the validator drops', async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-worker-'));
      try {
        fs.mkdirSync(path.join(ws, '.moag'));
        fs.writeFileSync(path.join(ws, '.moag', 'routing.json'), JSON.stringify({ complexEngine: 'rm' }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { validateRoutingConfig } = require('../../../routing/routing-store');
        const h = harness(new FakeRunner(async () => {}), { validateRoutingConfig });
        await runJob({ ...RUN_JOB, workspace: ws }, h.deps);
        const warnings = h.events.filter((e) => e.event === 'warning');
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0].message), /complexEngine/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('plan mode', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-planjob-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const outcomes: DeltaOutcomeLike[] = [
      { kind: 'no-delta' },
      { kind: 'engine-failed', error: 'engine exited 1' },
      { kind: 'parse-failed', error: 'bad json' },
      { kind: 'all-rejected', rejected: [{ taskName: 'x', reason: 'no ids' }] },
      { kind: 'appended', playlist: { id: 'pl-delta-1', name: 'PRD v1.1.0 delta', tasks: [] }, rejected: [] },
    ];

    for (const outcome of outcomes) {
      it(`maps ${outcome.kind} to the out file and a plan-outcome event`, async () => {
        const outPath = path.join(dir, 'out.json');
        const job: PlanJob = { kind: 'plan', mode: 'delta', workspace: dir, planPath: '/p', outPath, engine: 'claude' };
        const h = harness(new FakeRunner(async () => {}), {
          generateDeltaPlan: async () => outcome,
          dehydratePlaylist: (_p, pl) => ({ dehydrated: true, pl }),
        });
        assert.equal(await runJob(job, h.deps), 0);
        const doc = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        assert.equal(doc.kind, outcome.kind);
        if (outcome.kind === 'appended') { assert.equal(doc.playlist.dehydrated, true); } else { assert.equal(doc.playlist, undefined); }
        if (outcome.error) { assert.equal(doc.error, outcome.error); }
        if (outcome.kind === 'all-rejected') { assert.deepEqual(doc.rejected, outcome.rejected); }
        assert.deepEqual(h.events.filter((e) => e.event === 'plan-outcome'), [{ event: 'plan-outcome', kind: outcome.kind }]);
        assert.equal(h.unsubscribed, 1);
      });
    }

    it('initial mode runs against the synthetic baseline; delta mode does not', async () => {
      const seen: unknown[] = [];
      const baseline = { defaultEngine: 'claude', playlists: [], marker: 'baseline' };
      for (const mode of ['initial', 'delta'] as const) {
        const h = harness(new FakeRunner(async () => {}), {
          withSyntheticBaseline: () => baseline,
          generateDeltaPlan: async (p) => { seen.push(p); return { kind: 'no-delta' }; },
        });
        await runJob({ kind: 'plan', mode, workspace: dir, planPath: '/p', outPath: path.join(dir, `${mode}.json`), engine: 'claude' }, h.deps);
      }
      assert.equal(seen[0], baseline);
      assert.notEqual(seen[1], baseline);
    });

    it('calls the engine with the workspace cwd and the plan-generation cost label; stop aborts', async () => {
      let opts: { cwd: string; costLabel?: string; signal: AbortSignal } | null = null;
      let h!: Harness;
      h = harness(new FakeRunner(async () => {}), {
        getEngine: () => ({ runTask: async (o) => { opts = o; return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 }; } }),
        generateDeltaPlan: async (_p, d) => {
          await d.runEngine('prompt', d.signal);
          h.triggerStop();
          assert.equal(d.signal.aborted, true);
          return { kind: 'engine-failed', error: 'aborted' };
        },
      });
      await runJob({ kind: 'plan', mode: 'delta', workspace: dir, planPath: '/p', outPath: path.join(dir, 'o.json'), engine: 'codex' }, h.deps);
      assert.equal(opts!.cwd, dir);
      assert.equal(opts!.costLabel, 'plan-generation');
    });

    it('puts the server repository listing in a context section before the output-format rules; cwd stays the scratch dir', async () => {
      const scratch = path.join(dir, 'work');
      fs.mkdirSync(scratch);
      const listingPath = path.join(dir, 'repo-files.txt');
      fs.writeFileSync(listingPath, 'Repository files (tracked paths only):\nsrc/index.ts\npackage.json');
      let seen: { prompt: string; cwd: string } | null = null;
      const h = harness(new FakeRunner(async () => {}), {
        getEngine: () => ({ runTask: async (o) => { seen = o; return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 }; } }),
        generateDeltaPlan: async (_p, d) => { await d.runEngine('PLAN PROMPT\n\nRules:\n- Return ONLY valid JSON.\n\nFull PRD:\nx', d.signal); return { kind: 'no-delta' }; },
      });
      await runJob({ kind: 'plan', mode: 'delta', workspace: scratch, planPath: '/p', outPath: path.join(dir, 'o.json'), engine: 'claude', repoListingPath: listingPath }, h.deps);
      assert.equal(seen!.cwd, scratch);
      assert.equal(seen!.prompt,
        'PLAN PROMPT\n\nRepository files (tracked paths only):\nsrc/index.ts\npackage.json\n\nRules:\n- Return ONLY valid JSON.\n\nFull PRD:\nx');
      assert.equal(fs.readdirSync(scratch).length, 0, 'nothing from the repo is placed in the scratch cwd');
    });

    it('withRepoListing places the listing before the Rules section of the real planning prompts', () => {
      const LISTING = 'Repository files (tracked paths only):\nsrc/a.ts';
      const delta = buildDeltaPlanPrompt({ fullPrdText: '- [R-1] login', scope: { versionLabel: '1.1.0', added: resolveRequirements('## Requirements\n- [R-1] login\n'), changed: [] } });
      assert.ok(delta.includes('- [R-1] (added) login'), 'the fixture has a real changed-requirements section');
      for (const prompt of [delta, buildFullPlanPrompt('# PRD\nRules:\n(a PRD line that only looks like the marker)')]) {
        const out = withRepoListing(prompt, LISTING);
        const listingAt = out.indexOf(LISTING);
        const rulesAt = out.indexOf('\nRules:\n');
        const jsonRuleAt = out.indexOf('Return ONLY valid JSON');
        assert.ok(listingAt > 0 && listingAt < rulesAt, 'listing precedes the rules');
        assert.ok(listingAt < jsonRuleAt, 'listing precedes the output-format instruction');
        assert.equal(out.split(LISTING).length, 2, 'inserted exactly once');
        assert.equal(out.replace(`${LISTING}\n\n`, ''), prompt, 'nothing else changes');
      }
    });

    it('withRepoListing leads the prompt with the listing when there is no Rules section', () => {
      assert.equal(withRepoListing('P', 'L'), 'L\n\nP');
    });

    it('a missing repository listing is a warning, and the prompt goes out unchanged', async () => {
      let prompt: string | null = null;
      const h = harness(new FakeRunner(async () => {}), {
        getEngine: () => ({ runTask: async (o) => { prompt = o.prompt; return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 }; } }),
        generateDeltaPlan: async (_p, d) => { await d.runEngine('PLAN PROMPT', d.signal); return { kind: 'no-delta' }; },
      });
      const code = await runJob({ kind: 'plan', mode: 'delta', workspace: dir, planPath: '/p', outPath: path.join(dir, 'o.json'), engine: 'claude', repoListingPath: path.join(dir, 'missing.txt') }, h.deps);
      assert.equal(code, 0);
      assert.equal(prompt, 'PLAN PROMPT');
      assert.equal(h.events.filter((e) => e.event === 'warning' && /Repository listing unavailable/.test(String(e.message))).length, 1);
    });

    it('withRepoListing caps the listing and ignores an empty one', () => {
      assert.equal(withRepoListing('P', null), 'P');
      assert.equal(withRepoListing('P', '   \n'), 'P');
      const huge = 'x'.repeat(MAX_REPO_LISTING_CHARS + 5000);
      assert.equal(withRepoListing('P', huge).length, '\n\nP'.length + MAX_REPO_LISTING_CHARS);
    });

    it('a thrown generator becomes exit 2 with an error event and a disposed subscription', async () => {
      const h = harness(new FakeRunner(async () => {}), { generateDeltaPlan: async () => { throw new Error('gen blew up'); } });
      assert.equal(await runJob({ kind: 'plan', mode: 'delta', workspace: dir, planPath: '/p', outPath: path.join(dir, 'o.json'), engine: 'claude' }, h.deps), 2);
      assert.equal(h.unsubscribed, 1);
      assert.ok(h.events.some((e) => e.event === 'error'));
    });
  });

  describe('probe mode', () => {
    it('emits probe-result rows', async () => {
      const rows = [{ id: 'claude' as const, available: true, version: '2.1.4' }, { id: 'gemini' as const, available: false }];
      const h = harness(new FakeRunner(async () => {}), { checkAvailability: async () => rows });
      assert.equal(await runJob({ kind: 'probe' }, h.deps), 0);
      assert.deepEqual(h.events, [{ event: 'probe-result', engines: rows }]);
    });

    it('a probe job does not subscribe to child processes', async () => {
      let subscribed = 0;
      const h = harness(new FakeRunner(async () => undefined), { onChildProcess: () => { subscribed++; return () => undefined; } });
      await runJob({ kind: 'probe' }, h.deps);
      assert.equal(subscribed, 0);
    });

    it('a failing probe is exit 2', async () => {
      const h = harness(new FakeRunner(async () => {}), { checkAvailability: async () => { throw new Error('no'); } });
      assert.equal(await runJob({ kind: 'probe' }, h.deps), 2);
    });
  });
});

describe('armDisconnectWatchdog', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { armDisconnectWatchdog, DISCONNECT_WATCHDOG_MS } = require('../../../server/run-worker') as typeof import('../../../server/run-worker');

  it('after the grace period it kills the worker\'s own tree, then exits 2', () => {
    const calls: string[] = [];
    let fire: (() => void) | null = null;
    let armedMs = -1;
    armDisconnectWatchdog({
      killTree: () => calls.push('kill'),
      exit: (code) => calls.push(`exit ${code}`),
      setTimer: (fn, ms) => { fire = fn; armedMs = ms; },
    });
    assert.equal(armedMs, DISCONNECT_WATCHDOG_MS);
    assert.deepEqual(calls, [], 'nothing happens before the grace period');
    fire!();
    assert.deepEqual(calls, ['kill', 'exit 2']);
  });

  describe('main() arms it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { main } = require('../../../server/run-worker') as typeof import('../../../server/run-worker');

    /** A fake process: records what main() registers, writes and asks for. */
    function host(argv: string[]) {
      const disconnect: Array<() => void> = [];
      const h = {
        calls: [] as string[],
        out: [] as string[],
        timers: [] as Array<{ fn: () => void; ms: number }>,
        pipeErrorHandlers: 0,
        disconnect,
        host: {
          argv,
          stdout: { write: (s: string) => { h.out.push(s); return true; }, on: () => { h.pipeErrorHandlers++; } },
          stderr: { on: () => { h.pipeErrorHandlers++; } },
          once: (event: 'disconnect', fn: () => void) => { assert.equal(event, 'disconnect'); disconnect.push(fn); },
          exit: (code: number) => { h.calls.push('exit ' + code); },
          killTree: () => { h.calls.push('kill'); },
          setTimer: (fn: () => void, ms: number) => { h.timers.push({ fn, ms }); },
        },
      };
      return h;
    }

    it('hooks disconnect before reading argv; a disconnect arms the 30 s kill-then-exit', async () => {
      const h = host(['node', 'run-worker.js']); // no job path: main returns early
      assert.equal(await main(h.host), 2);
      assert.match(h.out.join(''), /usage: run-worker/);
      assert.equal(h.pipeErrorHandlers, 2, 'both parent pipes are guarded');
      assert.equal(h.disconnect.length, 1, 'the watchdog hook is registered even on the earliest return');
      assert.equal(h.timers.length, 0, 'nothing is armed until the parent disconnects');
      h.disconnect[0]();
      assert.equal(h.timers.length, 1);
      assert.equal(h.timers[0].ms, DISCONNECT_WATCHDOG_MS);
      assert.deepEqual(h.calls, [], 'no kill before the grace period');
      h.timers[0].fn();
      assert.deepEqual(h.calls, ['kill', 'exit 2']);
    });

    it('a malformed job file still leaves the watchdog armed', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-main-'));
      try {
        const jobPath = path.join(dir, 'job.json');
        fs.writeFileSync(jobPath, '{not json');
        const h = host(['node', 'run-worker.js', jobPath]);
        assert.equal(await main(h.host), 2);
        assert.match(h.out.join(''), /Malformed job file/);
        assert.equal(h.disconnect.length, 1);
        h.disconnect[0]();
        h.timers[0].fn();
        assert.deepEqual(h.calls, ['kill', 'exit 2']);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });

  it('exits even when killing the tree throws', () => {
    const exits: number[] = [];
    armDisconnectWatchdog({
      killTree: () => { throw new Error('taskkill missing'); },
      exit: (code) => exits.push(code),
      graceMs: 5,
      setTimer: (fn) => fn(),
    });
    assert.deepEqual(exits, [2]);
  });
});
