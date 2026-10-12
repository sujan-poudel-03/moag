import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { JobManager, JobManagerOptions, WorkerProcess, JobEnd, redactSecrets, MAX_LINE_BYTES, STOP_KILL_AFTER_MS, HELD_LOCK_POLL_MS, readJobLock } from '../../../server/jobs';
import { ProjectStateStore, emptyProjectState, PLAN_REVIEW_STATUSES, RUN_STATUSES } from '../../../server/project-state';
import { WorkerJob, emptyRunView } from '../../../server/worker-protocol';
import { createEmptyPlan, createTask, dehydratePlan } from '../../../models/plan';

class FakeProc extends EventEmitter implements WorkerProcess {
  pid = 99999;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  sent: unknown[] = [];
  send(m: unknown): boolean { this.sent.push(m); return true; }
  line(o: Record<string, unknown>): void { this.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n')); }
}

const RUN_JOB: WorkerJob = { kind: 'run', runId: 'r1', workspace: '/w', planPath: '/p', startPlaylistIndex: 0, verify: true, allowedEngines: ['claude'] };

describe('JobManager', () => {
  let dataDir: string;
  let procs: FakeProc[];
  let spawn: sinon.SinonStub;
  let kill: sinon.SinonSpy;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-jobs-'));
    procs = [];
    spawn = sinon.stub().callsFake(() => { const p = new FakeProc(); procs.push(p); return p; });
    kill = sinon.spy();
  });
  afterEach(() => { sinon.restore(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const mk = (over: Partial<JobManagerOptions> = {}) => new JobManager({
    dataDir, spawnWorker: spawn, maxConcurrent: 2, runsDisabledReason: null, killProcess: kill, ...over,
  });
  const jobPath = (id: string) => path.join(dataDir, 'projects', id, 'runs', 'r1', 'job.json');
  const start = (m: JobManager, projectId: string, over: Record<string, unknown> = {}) =>
    m.start({ projectId, job: RUN_JOB, jobPath: jobPath(projectId), workspace: '/w', env: {}, ...over });

  it('a second start for the same project is 409 and spawn ran exactly once', () => {
    const m = mk();
    assert.equal(start(m, 'p1').ok, true);
    const r = start(m, 'p1');
    assert.deepEqual([r.ok, (r as { status: number }).status, (r as { reason: string }).reason], [false, 409, 'job-active']);
    assert.equal(spawn.callCount, 1);
    assert.ok(fs.existsSync(m.lockPath('p1')));
    assert.ok(fs.existsSync(jobPath('p1')), 'job document written');
  });

  it('enforces the server-wide cap with 429', () => {
    const m = mk({ maxConcurrent: 1 });
    assert.equal(start(m, 'p1').ok, true);
    const r = start(m, 'p2');
    assert.equal((r as { status: number }).status, 429);
    assert.equal(spawn.callCount, 1);
  });

  it("runsDisabledReason:'ci' refuses runs and plan jobs but not probes", () => {
    const m = mk({ runsDisabledReason: 'ci' });
    const r = start(m, 'p1');
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'runs-disabled');
    const plan = m.start({ projectId: 'p2', job: { kind: 'plan', mode: 'delta', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'claude' }, jobPath: jobPath('p2'), workspace: '/w', env: {} });
    assert.equal(plan.ok, false);
    assert.equal(spawn.callCount, 0);
    assert.equal(m.start({ projectId: '__probe', job: { kind: 'probe' }, jobPath: jobPath('__probe'), workspace: '/w', env: {} }).ok, true);
  });

  it('stop sends IPC first and kills only after 30 s', () => {
    const clock = sinon.useFakeTimers();
    try {
      const m = mk();
      start(m, 'p1');
      assert.equal(m.stop('p1'), true);
      assert.deepEqual(procs[0].sent, [{ type: 'stop' }]);
      clock.tick(STOP_KILL_AFTER_MS - 1);
      assert.equal(kill.called, false);
      clock.tick(1);
      assert.equal(kill.calledOnceWith(procs[0]), true);
      assert.equal(m.stop('nope'), false);
    } finally { clock.restore(); }
  });

  it('a worker that exits after stop clears the kill timer and ends as stopped', () => {
    const clock = sinon.useFakeTimers();
    try {
      const m = mk();
      let end: JobEnd | null = null;
      start(m, 'p1', { onEnd: (e: JobEnd) => { end = e; } });
      m.stop('p1');
      procs[0].emit('close', 1);
      clock.tick(STOP_KILL_AFTER_MS * 2);
      assert.equal(kill.called, false);
      assert.equal(end!.status, 'stopped');
      assert.equal(clock.countTimers(), 0);
    } finally { clock.restore(); }
  });

  it('exit 3 ends as awaiting-approval with the gate folded into the view; releases the slot and lock', () => {
    const m = mk();
    const ends: JobEnd[] = [];
    start(m, 'p1', { onEnd: (e: JobEnd) => ends.push(e) });
    procs[0].line({ event: 'state', state: 'playing' });
    procs[0].line({ event: 'manual-gate', id: 'rel', name: 'Release' });
    procs[0].emit('close', 3);
    assert.equal(ends[0].status, 'awaiting-approval');
    assert.deepEqual(ends[0].view.gate, { taskId: 'rel', name: 'Release' });
    assert.equal(m.isActive('p1'), false);
    assert.equal(fs.existsSync(m.lockPath('p1')), false);
    assert.equal(start(m, 'p1').ok, true, 'project can start again');
  });

  it('maps every exit code', () => {
    const m = mk();
    const got: string[] = [];
    for (const [i, code] of [0, 1, 2, 3, 4].entries()) {
      start(m, `p${i}`, { onEnd: (e: JobEnd) => got.push(e.status) });
      procs[i].emit('close', code);
    }
    assert.deepEqual(got, ['completed', 'gaps', 'error', 'awaiting-approval', 'budget']);
  });

  it('a spawn error event leaves no lock file and no listeners', () => {
    const m = mk();
    let end: JobEnd | null = null;
    start(m, 'p1', { onEnd: (e: JobEnd) => { end = e; } });
    const p = procs[0];
    p.emit('error', new Error('spawn node ENOENT'));
    assert.equal(fs.existsSync(m.lockPath('p1')), false);
    assert.equal(p.listenerCount('close'), 0);
    assert.equal(p.listenerCount('error'), 0);
    assert.equal(p.stdout.listenerCount('data'), 0);
    assert.equal(p.stderr.listenerCount('data'), 0);
    assert.equal(m.isActive('p1'), false);
    assert.equal(end!.status, 'error');
    assert.match(end!.spawnError ?? '', /ENOENT/);
    p.emit('close', 0);
    assert.equal(end!.status, 'error', 'a late close does not re-settle');
  });

  it('a synchronous spawn throw releases the lock and reports spawn-failed', () => {
    const m = mk({ spawnWorker: () => { throw new Error('EMFILE'); } });
    const r = start(m, 'p1');
    assert.equal((r as { reason: string }).reason, 'spawn-failed');
    assert.equal(fs.existsSync(m.lockPath('p1')), false);
    assert.equal(m.isActive('p1'), false);
  });

  it('close also removes every listener', () => {
    const m = mk();
    start(m, 'p1');
    procs[0].emit('close', 0);
    assert.equal(procs[0].listenerCount('close') + procs[0].listenerCount('error'), 0);
    assert.equal(procs[0].stdout.listenerCount('data') + procs[0].stderr.listenerCount('data'), 0);
  });

  it('frames split lines, ignores junk and drops a line over 1 MB', () => {
    const m = mk();
    const events: string[] = [];
    start(m, 'p1', { onEvent: (e: { event: string }) => events.push(e.event) });
    const p = procs[0];
    p.stdout.emit('data', '{"event":"task-st');
    p.stdout.emit('data', 'arted","id":"a","name":"A"}\nnot json\n');
    p.stdout.emit('data', 'x'.repeat(MAX_LINE_BYTES + 10));
    p.stdout.emit('data', 'still the same overlong line\n{"event":"task-completed","id":"a","name":"A"}\n');
    assert.deepEqual(events, ['task-started', 'task-completed']);
    assert.equal(m.view('p1')?.tasks.a, 'completed');
  });

  it('redacts injected secrets from error tails, error messages and stderr', () => {
    const m = mk();
    const secret = 'sk-ant-SECRET-123456';
    const seen: Array<Record<string, unknown>> = [];
    let end: JobEnd | null = null;
    start(m, 'p1', { redact: [secret], onEvent: (e: Record<string, unknown>) => seen.push(e), onEnd: (e: JobEnd) => { end = e; } });
    procs[0].line({ event: 'task-error-tail', id: 'a', tail: `401 for key ${secret}` });
    procs[0].line({ event: 'error', message: `bad ${secret}` });
    procs[0].stderr.emit('data', `env dump ANTHROPIC_API_KEY=${secret}\n`);
    procs[0].emit('close', 2);
    const all = JSON.stringify(seen) + JSON.stringify(end);
    assert.equal(all.includes(secret), false);
    assert.ok(all.includes('[REDACTED]'));
    assert.equal(redactSecrets('abc', ['']), 'abc');
  });

  it('redacts injected secrets from a task-changes diff, keeping diff.truncated', () => {
    const m = mk();
    const secret = 'sk-ant-SECRET-123456';
    const seen: Array<Record<string, unknown>> = [];
    start(m, 'p1', { redact: [secret], onEvent: (e: Record<string, unknown>) => seen.push(e), onEnd: () => undefined });
    procs[0].line({
      event: 'task-changes', task_id: 'a', status: 'completed', source: 'worktree', base_sha: 'b'.repeat(40),
      commit_sha: null, branch: null, files: [{ path: 'x.env', status: 'added', binary: false, added: 1, removed: 0 }],
      diff: { text: `+KEY=${secret}\n`, truncated: true, bytes: 99, redactions: 0 },
    });
    procs[0].emit('close', 0);
    const ev = seen.find((e) => e.event === 'task-changes') as { diff: { text: string; truncated: boolean } } | undefined;
    assert.ok(ev);
    assert.equal(ev.diff.text.includes(secret), false);
    assert.ok(ev.diff.text.includes('[REDACTED]'));
    assert.equal(ev.diff.truncated, true);
  });

  it('redacts injected secrets from a dependency install tail and note', () => {
    const m = mk();
    const secret = 'npm_SECRETTOKEN123456';
    const seen: Array<Record<string, unknown>> = [];
    start(m, 'p1', { redact: [secret], onEvent: (e: Record<string, unknown>) => seen.push(e), onEnd: () => undefined });
    procs[0].line({
      event: 'dependencies-install-failed', stage: 'task', taskId: 'a', ecosystem: 'npm', dir: '.',
      trigger: 'manifest-changed', command: 'npm ci --no-audit --no-fund', durationMs: 10, exitCode: 1,
      timedOut: false, tail: `401 Unauthorized //registry.npmjs.org/:_authToken=${secret}`, note: null,
    });
    procs[0].line({
      event: 'dependencies-not-installed', stage: 'task', ecosystem: 'python', dir: '.', trigger: 'first-seen',
      command: null, durationMs: 0, exitCode: null, timedOut: false, tail: '', note: `odd ${secret}`,
    });
    procs[0].emit('close', 0);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].event, 'dependencies-install-failed');
    const all = JSON.stringify(seen);
    assert.equal(all.includes(secret), false);
    assert.ok(all.includes('[REDACTED]'));
  });

  it('records cost into the spend bucket and reports task outcomes with the engine', () => {
    const spend: Array<[string, string, number]> = [];
    const outcomes: unknown[] = [];
    const m = mk({ recordSpend: (p, k, u) => spend.push([p, k, u]), onTaskOutcome: (o) => outcomes.push(o) });
    start(m, 'p1', { spendKey: '2026-10-04T00:00:00.000Z' });
    procs[0].line({ event: 'cost', usd: 0.5 });
    procs[0].line({ event: 'task-engine', id: 'a', engine: 'codex' });
    procs[0].line({ event: 'task-completed', id: 'a', name: 'A', status: 'completed', engineRan: true });
    procs[0].line({ event: 'task-failed', id: 'b', name: 'B', status: 'failed', engineRan: true });
    assert.deepEqual(spend, [['p1', '2026-10-04T00:00:00.000Z', 0.5]]);
    assert.deepEqual(outcomes.map((o) => (o as { taskId: string; status: string; engine: string | null })).map((o) => [o.taskId, o.status, o.engine]),
      [['a', 'completed', 'codex'], ['b', 'failed', null]]);
    assert.equal(m.view('p1')?.costUsd, 0.5);
  });

  it('subscribe fans out events and end; the disposer unsubscribes', () => {
    const m = mk();
    const a: string[] = [];
    const b: string[] = [];
    const disposeA = m.subscribe('p1', (n) => a.push(n.type));
    m.subscribe('p1', (n) => b.push(n.type));
    start(m, 'p1');
    procs[0].line({ event: 'state', state: 'playing' });
    disposeA();
    procs[0].emit('close', 0);
    assert.deepEqual(a, ['event']);
    assert.deepEqual(b, ['event', 'end']);
    assert.equal(m.subscriberCount('p1'), 1);
  });

  it('respects a lock held by a live process and reclaims one from a dead pid', () => {
    const live = mk({ isPidAlive: () => true });
    fs.mkdirSync(path.dirname(live.lockPath('p1')), { recursive: true });
    fs.writeFileSync(live.lockPath('p1'), '424242');
    assert.equal((start(live, 'p1') as { reason: string }).reason, 'project-locked');
    assert.equal(spawn.callCount, 0);

    const dead = mk({ isPidAlive: () => false });
    assert.equal(start(dead, 'p1').ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(dead.lockPath('p1'), 'utf-8')), { serverPid: process.pid, workerPid: 99999 });
  });

  it('the lock names the worker pid (and its process group when workers lead one)', () => {
    const m = mk({ workerLeadsProcessGroup: true });
    const r = start(m, 'p1');
    assert.equal(r.ok, true);
    assert.equal((r as { workerPid?: number }).workerPid, 99999);
    assert.deepEqual(JSON.parse(fs.readFileSync(m.lockPath('p1'), 'utf-8')), { serverPid: process.pid, workerPid: 99999, workerPgid: 99999 });
  });

  it('after a server crash, a lock whose WORKER is still alive is not reclaimed and blocks a new job', () => {
    // The crashed server (pid 5555) is dead; its worker (pid 7777) is still running an agent.
    const alive = new Set([7777]);
    const m = mk({ isPidAlive: (pid) => alive.has(pid) });
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777 }));
    assert.deepEqual(m.reclaimStaleLocks(['p1']), [], 'a live worker keeps its lock');
    assert.ok(fs.existsSync(m.lockPath('p1')));
    const refused = start(m, 'p1');
    assert.deepEqual([refused.ok, (refused as { status: number }).status, (refused as { reason: string }).reason], [false, 409, 'project-locked']);
    assert.equal(spawn.callCount, 0, 'no second worker in the same workspace');

    alive.delete(7777); // the orphan stopped its runner and exited
    assert.equal(start(m, 'p1').ok, true);
    assert.equal(spawn.callCount, 1);
  });

  it('a lock whose worker pid is dead but whose process group is alive is still held', () => {
    const m = mk({ isPidAlive: (pid) => pid === -7777 });
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777, workerPgid: 7777 }));
    assert.deepEqual(m.reclaimStaleLocks(['p1']), []);
    assert.equal((start(m, 'p1') as { reason: string }).reason, 'project-locked');
  });

  it('a lock whose server and worker are both dead is reclaimed at boot', () => {
    const m = mk({ isPidAlive: () => false });
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777, workerPgid: 7777 }));
    assert.deepEqual(m.reclaimStaleLocks(['p1']), ['p1']);
    assert.equal(fs.existsSync(m.lockPath('p1')), false);
  });

  it('a lock that records task pids is held while any of them is alive, even with server and worker dead', () => {
    const alive = new Set([8888]);
    const m = mk({ isPidAlive: (pid) => alive.has(pid) });
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777, taskPids: [9999, 8888] }));
    assert.deepEqual(m.reclaimStaleLocks(['p1']), [], 'a live orphaned agent keeps the lock');
    assert.ok(fs.existsSync(m.lockPath('p1')));
    assert.equal((start(m, 'p1') as { reason: string }).reason, 'project-locked');
    assert.equal(spawn.callCount, 0, 'no second run while the agent lives');

    alive.delete(8888);
    assert.deepEqual(m.reclaimStaleLocks(['p1']), ['p1']);
    assert.equal(start(m, 'p1').ok, true);
  });

  it('records task pids the worker reports in job.lock, drops them on exit, and never fans them out', () => {
    const m = mk({ workerLeadsProcessGroup: true });
    const events: string[] = [];
    const notices: string[] = [];
    m.start({ projectId: 'p1', job: RUN_JOB, jobPath: jobPath('p1'), workspace: '/w', env: {}, onEvent: (e) => events.push(e.event) });
    m.subscribe('p1', (n) => notices.push(n.type === 'event' ? n.event.event : 'end'));
    const lock = () => JSON.parse(fs.readFileSync(m.lockPath('p1'), 'utf-8'));
    procs[0].line({ event: 'task-pid', pid: 5001, alive: true });
    procs[0].line({ event: 'task-pid', pid: 5002, alive: true });
    assert.deepEqual(lock(), { serverPid: process.pid, workerPid: 99999, workerPgid: 99999, taskPids: [5001, 5002] });
    procs[0].line({ event: 'task-pid', pid: 5001, alive: false });
    assert.deepEqual(lock().taskPids, [5002]);
    procs[0].line({ event: 'task-pid', pid: 5002, alive: false });
    assert.deepEqual(lock(), { serverPid: process.pid, workerPid: 99999, workerPgid: 99999 }, 'no empty taskPids array');
    procs[0].line({ event: 'task-pid', pid: 7, alive: false });
    assert.deepEqual(events, [], 'task-pid never reaches onEvent');
    assert.deepEqual(notices, [], 'task-pid never reaches SSE subscribers');
    assert.deepEqual(m.view('p1'), emptyRunView(), 'and is not folded into the run view');
    procs[0].emit('close', 0);
    assert.equal(fs.existsSync(m.lockPath('p1')), false, 'a finished job releases its lock');
  });

  it('a recorded task pid keeps the workspace locked after the worker dies mid-task (successor server)', () => {
    const m = mk();
    start(m, 'p1');
    procs[0].line({ event: 'task-pid', pid: 6006, alive: true });
    // The server and the worker crash: no close event, the lock file stays as written.
    const lockText = fs.readFileSync(m.lockPath('p1'), 'utf-8');
    const successor = mk({ isPidAlive: (pid) => pid === 6006 });
    assert.deepEqual(successor.reclaimStaleLocks(['p1']), [], 'the orphaned agent still owns the workspace');
    assert.equal(fs.readFileSync(successor.lockPath('p1'), 'utf-8'), lockText);
    assert.equal((start(successor, 'p1') as { reason: string }).reason, 'project-locked');
    const afterAgentExit = mk({ isPidAlive: () => false });
    assert.deepEqual(afterAgentExit.reclaimStaleLocks(['p1']), ['p1']);
  });

  it('task-pid events after the job ended do not resurrect the lock', () => {
    const m = mk();
    start(m, 'p1');
    const p = procs[0];
    const stdoutListener = p.stdout.listeners('data')[0] as (c: Buffer) => void;
    p.emit('close', 0);
    stdoutListener(Buffer.from(JSON.stringify({ event: 'task-pid', pid: 42, alive: true }) + '\n'));
    assert.equal(fs.existsSync(m.lockPath('p1')), false);
  });

  it('isLockHeld: false without a lock or with only dead holders, true while a holder lives', () => {
    const alive = new Set<number>([7777]);
    const m = mk({ isPidAlive: (pid) => alive.has(pid) });
    assert.equal(m.isLockHeld('p1'), false, 'no lock file');
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777 }));
    assert.equal(m.isLockHeld('p1'), true);
    alive.clear();
    assert.equal(m.isLockHeld('p1'), false);
    fs.writeFileSync(m.lockPath('p1'), 'garbage');
    assert.equal(m.isLockHeld('p1'), false, 'garbage is not a holder');
  });

  it('watchHeldLocks reclaims and reports a project only once its holder exits, then stops polling', () => {
    const alive = new Set<number>([7777]);
    const m = mk({ isPidAlive: (pid) => alive.has(pid) });
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777, taskPids: [8888] }));
    let tick: (() => void) | null = null;
    let interval = -1;
    let cleared = 0;
    const released: string[] = [];
    m.watchHeldLocks(['p1'], (id) => released.push(id), {
      setInterval: (fn, ms) => { tick = fn; interval = ms; return 'timer'; },
      clearInterval: (t) => { assert.equal(t, 'timer'); cleared++; },
    });
    assert.equal(interval, HELD_LOCK_POLL_MS);
    tick!();
    assert.deepEqual(released, [], 'worker alive: nothing recovered');
    alive.delete(7777);
    alive.add(8888);
    tick!();
    assert.deepEqual(released, [], 'its agent alive: still held');
    alive.clear();
    tick!();
    assert.deepEqual(released, ['p1']);
    assert.equal(fs.existsSync(m.lockPath('p1')), false, 'the stale lock is reclaimed');
    assert.equal(cleared, 1, 'polling stops once every project is released');
  });

  it('watchHeldLocks waits while this server has its own job in the project', () => {
    const alive = new Set<number>([7777]);
    const m = mk({ isPidAlive: (pid) => alive.has(pid) });
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777 }));
    let tick: (() => void) | null = null;
    const released: string[] = [];
    m.watchHeldLocks(['p1'], (id) => released.push(id), { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => undefined });
    alive.clear();
    assert.equal(start(m, 'p1').ok, true, 'the dead holder lets a new job in');
    tick!();
    assert.deepEqual(released, [], 'never recover under a live job of ours');
    procs[0].emit('close', 0);
    tick!();
    assert.deepEqual(released, ['p1']);
  });

  it('watchHeldLocks: the disposer stops polling; a throwing callback is logged and does not stop other projects', () => {
    const logs: string[] = [];
    const m = mk({ isPidAlive: () => false, log: (x) => logs.push(x) });
    let tick: (() => void) | null = null;
    let cleared = 0;
    const seen: string[] = [];
    const stop = m.watchHeldLocks(['a', 'b'], (id) => { seen.push(id); if (id === 'a') { throw new Error('boom'); } },
      { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { cleared++; } });
    tick!();
    assert.deepEqual(seen, ['a', 'b']);
    assert.ok(logs.some((l) => l.includes('boom')));
    const stop2 = m.watchHeldLocks(['c'], () => assert.fail('disposed'), { setInterval: (fn) => { tick = fn; return 2; }, clearInterval: () => { cleared++; } });
    stop2();
    stop();
    assert.equal(cleared, 2);
  });

  it('task pids that are not positive integers are ignored; a lock of only dead task pids is reclaimed', () => {
    const probed: number[] = [];
    const m = mk({ isPidAlive: (pid) => { probed.push(pid); return false; } });
    fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
    fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ taskPids: [-1, 0, 'x', 1.5, null, 4321] }));
    assert.deepEqual(m.reclaimStaleLocks(['p1']), ['p1']);
    assert.deepEqual(probed, [4321], 'only a valid pid is probed (never a negative = group)');
    fs.mkdirSync(path.dirname(m.lockPath('p2')), { recursive: true });
    fs.writeFileSync(m.lockPath('p2'), JSON.stringify({ taskPids: 'not-an-array' }));
    assert.deepEqual(m.reclaimStaleLocks(['p2']), ['p2'], 'garbage is reclaimed');
  });

  // ─── Lock linger: task pids outliving their job ───

  describe('killAll', () => {
    it('hard-kills every active worker at once and marks each stop requested', () => {
      const m = mk();
      start(m, 'p1');
      start(m, 'p2');
      m.killAll();
      assert.equal(kill.callCount, 2);
      assert.deepEqual(kill.getCalls().map((c) => c.args[0]), [procs[0], procs[1]]);
      assert.equal(m.isStopRequested('p1'), true);
      assert.equal(m.isStopRequested('p2'), true);
    });

    it('does nothing with no jobs', () => {
      mk().killAll();
      assert.equal(kill.called, false);
    });

    it('a throwing kill does not stop the others, and killAll never throws', () => {
      const logs: string[] = [];
      const throwing = sinon.stub();
      throwing.onFirstCall().throws(new Error('taskkill failed'));
      const m = mk({ killProcess: throwing, log: (msg) => logs.push(msg) });
      start(m, 'p1');
      start(m, 'p2');
      assert.doesNotThrow(() => m.killAll());
      assert.equal(throwing.callCount, 2);
      assert.ok(logs.some((l) => /p1.*taskkill failed/.test(l)));
    });

    it('leaves the lock to close handling, and a killed job ends as stopped', () => {
      const m = mk();
      let end: JobEnd | null = null;
      start(m, 'p1', { onEnd: (e: JobEnd) => { end = e; } });
      m.killAll();
      assert.ok(fs.existsSync(m.lockPath('p1')), 'the lock is still held until the worker closes');
      procs[0].emit('close', null);
      assert.equal(end!.status, 'stopped');
      assert.equal(m.isActive('p1'), false);
    });
  });

  describe('lock linger', () => {
    const POLL = 1_000;
    const MAX = 10_000;
    const lingerMk = (alive: Set<number>, logs: string[] = []) =>
      mk({ isPidAlive: (pid) => alive.has(pid), lingerPollMs: POLL, lingerMaxMs: MAX, log: (x) => logs.push(x) });
    const lockOf = (m: JobManager) => JSON.parse(fs.readFileSync(m.lockPath('p1'), 'utf-8'));

    it('a finish with a live task pid keeps the lock, naming only the live pids, and a new start is 409 project-locked', () => {
      const clock = sinon.useFakeTimers();
      const alive = new Set<number>([5001]);
      const m = lingerMk(alive);
      start(m, 'p1');
      procs[0].line({ event: 'task-pid', pid: 5001, alive: true });
      procs[0].line({ event: 'task-pid', pid: 5002, alive: true });
      procs[0].emit('close', 0);
      assert.equal(m.isActive('p1'), false, 'the job itself ended');
      assert.ok(fs.existsSync(m.lockPath('p1')), 'the lock is kept');
      assert.deepEqual(lockOf(m).taskPids, [5001], 'only the live pid is recorded');
      const r = start(m, 'p1');
      assert.deepEqual([r.ok, (r as { status: number }).status, (r as { reason: string }).reason], [false, 409, 'project-locked']);
      assert.equal(spawn.callCount, 1);
      assert.deepEqual(m.lockInfo('p1'), { held: true, taskPids: [5001], workerPid: 99999, lingering: true, expired: false });
      assert.equal(clock.countTimers(), 1, 'one linger interval');
    });

    it('when the pid dies, the next tick removes the lock and stops polling', () => {
      const clock = sinon.useFakeTimers();
      const alive = new Set<number>([5001]);
      const m = lingerMk(alive);
      start(m, 'p1');
      procs[0].line({ event: 'task-pid', pid: 5001, alive: true });
      procs[0].emit('close', 0);
      clock.tick(POLL);
      assert.ok(fs.existsSync(m.lockPath('p1')), 'still alive: still locked');
      alive.clear();
      clock.tick(POLL);
      assert.equal(fs.existsSync(m.lockPath('p1')), false);
      assert.equal(clock.countTimers(), 0, 'no leaked interval');
      assert.equal(m.lockInfo('p1'), null);
      assert.equal(start(m, 'p1').ok, true, 'a new job is admitted');
    });

    it('at the max wait the lock is kept, the interval is cleared, and an admin hint is logged', () => {
      const clock = sinon.useFakeTimers();
      const logs: string[] = [];
      const m = lingerMk(new Set([5001]), logs);
      start(m, 'p1');
      procs[0].line({ event: 'task-pid', pid: 5001, alive: true });
      procs[0].emit('close', 0);
      clock.tick(MAX + POLL);
      assert.ok(fs.existsSync(m.lockPath('p1')), 'kept after expiry');
      assert.equal(clock.countTimers(), 0, 'no leaked interval');
      assert.equal(m.lockInfo('p1')?.expired, true);
      assert.ok(logs.some((l) => /still held/.test(l) && /force-release/.test(l)), logs.join('\n'));
      assert.equal((start(m, 'p1') as { reason: string }).reason, 'project-locked');
    });

    it('race: the pid dies, a new job starts before the tick, and the stale tick leaves the new lock intact', () => {
      const clock = sinon.useFakeTimers();
      const alive = new Set<number>([5001]);
      const m = lingerMk(alive);
      start(m, 'p1');
      procs[0].line({ event: 'task-pid', pid: 5001, alive: true });
      procs[0].emit('close', 0);
      alive.clear();
      assert.equal(start(m, 'p1').ok, true, 'acquireLock reclaims the dead lingering lock');
      const newLock = fs.readFileSync(m.lockPath('p1'), 'utf-8');
      clock.tick(POLL * 5);
      assert.equal(fs.readFileSync(m.lockPath('p1'), 'utf-8'), newLock, 'the new job\'s lock is untouched');
      assert.equal(clock.countTimers(), 0, 'the old linger watch was cancelled');
      assert.equal(m.lockInfo('p1')?.lingering, false);
    });

    it('forceReleaseLock: job-active while a job runs, not-locked without a lock, and releases a lingering lock', () => {
      const clock = sinon.useFakeTimers();
      const m = lingerMk(new Set([5001]));
      assert.deepEqual(m.forceReleaseLock('p1'), { ok: false, reason: 'not-locked' });
      start(m, 'p1');
      assert.deepEqual(m.forceReleaseLock('p1'), { ok: false, reason: 'job-active' });
      assert.ok(fs.existsSync(m.lockPath('p1')), 'refusal touches nothing');
      procs[0].line({ event: 'task-pid', pid: 5001, alive: true });
      procs[0].emit('close', 0);
      const r = m.forceReleaseLock('p1');
      assert.equal(r.ok, true);
      assert.deepEqual((r as { before: unknown }).before, { held: true, taskPids: [5001], workerPid: 99999, lingering: true, expired: false });
      assert.equal(fs.existsSync(m.lockPath('p1')), false);
      assert.equal(clock.countTimers(), 0, 'the linger timer is cleared');
      assert.equal(kill.callCount, 0, 'force-release kills nothing');
      assert.deepEqual(m.forceReleaseLock('p1'), { ok: false, reason: 'not-locked' });
    });

    it('forceReleaseLock also releases a lock left by a predecessor (no linger watch)', () => {
      const m = lingerMk(new Set([7777]));
      fs.mkdirSync(path.dirname(m.lockPath('p1')), { recursive: true });
      fs.writeFileSync(m.lockPath('p1'), JSON.stringify({ serverPid: 5555, workerPid: 7777 }));
      const r = m.forceReleaseLock('p1');
      assert.equal(r.ok, true);
      assert.equal((r as { before: { lingering: boolean } }).before.lingering, false);
      assert.equal(fs.existsSync(m.lockPath('p1')), false);
    });

    it('regression: a finish with no task pids (or only dead ones) releases at once and starts no timer', () => {
      const clock = sinon.useFakeTimers();
      const m = lingerMk(new Set());
      start(m, 'p1');
      procs[0].emit('close', 0);
      assert.equal(fs.existsSync(m.lockPath('p1')), false);
      start(m, 'p2');
      procs[1].line({ event: 'task-pid', pid: 6001, alive: true });
      procs[1].emit('close', 0);
      assert.equal(fs.existsSync(m.lockPath('p2')), false, 'a recorded but dead pid does not linger');
      assert.equal(clock.countTimers(), 0);
    });
  });

  it('records task outcomes only for tasks the engine ran to a verdict', () => {
    const outcomes: Array<{ taskId: string; status: string }> = [];
    const m = mk({ onTaskOutcome: (o) => outcomes.push(o) });
    start(m, 'p1');
    const p = procs[0];
    p.line({ event: 'task-completed', id: 'skipped', name: 's', status: 'skipped', engineRan: false });
    p.line({ event: 'task-failed', id: 'blocked', name: 'b', status: 'blocked', engineRan: false });
    p.line({ event: 'task-failed', id: 'preflight', name: 'p', status: 'failed', engineRan: false });
    p.line({ event: 'task-completed', id: 'legacy', name: 'l' }); // no engineRan: not evidence
    p.line({ event: 'task-completed', id: 'mismatch', name: 'm', status: 'skipped', engineRan: true });
    p.line({ event: 'task-completed', id: 'ok', name: 'o', status: 'completed', engineRan: true });
    p.line({ event: 'task-failed', id: 'bad', name: 'x', status: 'failed', engineRan: true });
    assert.deepEqual(outcomes.map((o) => [o.taskId, o.status]), [['ok', 'completed'], ['bad', 'failed']]);

    // After a budget halt, a task that ends was aborted, not judged.
    p.line({ event: 'budget-exceeded', totalCost: 2, budget: 1 });
    p.line({ event: 'task-failed', id: 'aborted', name: 'a', status: 'failed', engineRan: true });
    assert.equal(outcomes.length, 2);

    // A server-side stop request does the same.
    start(m, 'p2');
    m.stop('p2');
    procs[1].line({ event: 'task-failed', id: 'stopped', name: 's', status: 'failed', engineRan: true });
    assert.equal(outcomes.length, 2);
    procs[1].emit('close', 1); // clears the kill timer
    p.emit('close', 4);
  });

  it('reclaimStaleLocks removes dead and garbage locks only', () => {
    const m = mk({ isPidAlive: (pid) => pid === 1111 });
    for (const [id, content] of [['alive', '1111'], ['dead', '2222'], ['junk', 'zzz']]) {
      fs.mkdirSync(path.dirname(m.lockPath(id)), { recursive: true });
      fs.writeFileSync(m.lockPath(id), content);
    }
    assert.deepEqual(m.reclaimStaleLocks(['alive', 'dead', 'junk', 'none']).sort(), ['dead', 'junk']);
    assert.ok(fs.existsSync(m.lockPath('alive')));
  });

  it('stopAll stops every job and resolves once they end', async () => {
    const m = mk();
    start(m, 'p1');
    start(m, 'p2');
    const done = m.stopAll(1000);
    for (const p of procs) { assert.deepEqual(p.sent, [{ type: 'stop' }]); p.emit('close', 1); }
    await done;
    assert.equal(m.activeCount(), 0);
  });
});

describe('ProjectStateStore', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-pstate-')); });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('defines each status set once with no duplicates', () => {
    assert.equal(new Set(PLAN_REVIEW_STATUSES).size, PLAN_REVIEW_STATUSES.length);
    assert.equal(new Set(RUN_STATUSES).size, RUN_STATUSES.length);
  });

  it('round-trips state and the canonical plan', () => {
    const s = new ProjectStateStore(dataDir);
    s.update('p1', (st) => { st.versionSpend['v'] = 1.25; });
    assert.equal(s.load('p1').versionSpend.v, 1.25);
    assert.deepEqual(s.load('p2'), emptyProjectState());
    const plan = createEmptyPlan('X');
    plan.playlists[0].tasks.push(createTask('t', 'p'));
    s.saveCanonicalPlan('p1', plan);
    assert.equal(s.loadCanonicalPlan('p1', 'ignored').playlists[0].tasks[0].name, 't');
    assert.equal(s.loadCanonicalPlan('p3', 'Fresh').name, 'Fresh');
  });

  it('boot recovery marks running runs and generating plans interrupted', () => {
    const s = new ProjectStateStore(dataDir);
    s.update('p1', (st) => {
      st.runs.push({ id: 'r1', planId: 'pl', status: 'running', startedBy: 'u', startedAt: 'x', versionCreatedAt: 'v', stack: 'go', segments: 1 });
      st.runs.push({ id: 'r2', planId: 'pl', status: 'awaiting-approval', startedBy: 'u', startedAt: 'x', versionCreatedAt: 'v', stack: 'go', segments: 1 });
      st.plans.push({ id: 'pl', status: 'generating', mode: 'delta', engine: 'claude', forVersionCreatedAt: 'v', forVersionLabel: '1.1.0', requestedBy: 'u', requestedAt: 'x' });
    });
    assert.equal(s.recoverOnBoot(['p1', 'missing']), 2);
    const st = s.load('p1');
    assert.equal(st.runs[0].status, 'interrupted');
    assert.equal(st.runs[1].status, 'awaiting-approval', 'a halted gate survives a restart');
    assert.equal(st.plans[0].status, 'interrupted');
  });

  it('boot recovery merges an interrupted run snapshot so completed tasks are not rerun', () => {
    const s = new ProjectStateStore(dataDir);
    const canonical = createEmptyPlan('X');
    for (const id of ['a', 'b', 'c', 'd']) { const t = createTask(id, 'p'); t.id = id; canonical.playlists[0].tasks.push(t); }
    s.saveCanonicalPlan('p1', canonical);
    const snap = createEmptyPlan('X');
    for (const [id, status] of [['a', 'completed'], ['b', 'failed'], ['c', 'running'], ['d', 'paused']] as const) {
      const t = createTask(id, 'p'); t.id = id; t.status = status as typeof t.status; snap.playlists[0].tasks.push(t);
    }
    fs.mkdirSync(s.runDir('p1', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(s.runDir('p1', 'r1'), 'plan.json'), JSON.stringify(dehydratePlan(snap)));
    s.update('p1', (st) => {
      st.runs.push({ id: 'r1', planId: 'pl', status: 'running', startedBy: 'u', startedAt: 'x', versionCreatedAt: 'v', stack: 'go', segments: 1 });
      // A finished run's snapshot is never re-merged at boot.
      st.runs.push({ id: 'r0', planId: 'pl', status: 'completed', startedBy: 'u', startedAt: 'x', versionCreatedAt: 'v', stack: 'go', segments: 1 });
    });
    assert.equal(s.recoverOnBoot(['p1']), 1);
    const byId = Object.fromEntries(s.loadCanonicalPlan('p1', 'X').playlists[0].tasks.map((t) => [t.id, t.status]));
    assert.equal(byId.a, 'completed', 'paid-for completed task is kept');
    assert.equal(byId.b, 'failed');
    assert.equal(byId.c, 'pending', 'a task caught mid-flight stays pending');
    assert.equal(byId.d, 'pending');
  });

  it('boot recovery survives a missing or corrupt snapshot and leaves the canonical plan intact', () => {
    const s = new ProjectStateStore(dataDir);
    const canonical = createEmptyPlan('X');
    const t = createTask('a', 'p'); t.id = 'a'; canonical.playlists[0].tasks.push(t);
    s.saveCanonicalPlan('p1', canonical);
    fs.mkdirSync(s.runDir('p1', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(s.runDir('p1', 'bad'), 'plan.json'), '{not json');
    s.update('p1', (st) => {
      st.runs.push({ id: 'bad', planId: 'pl', status: 'running', startedBy: 'u', startedAt: 'x', versionCreatedAt: 'v', stack: 'go', segments: 1 });
      st.runs.push({ id: 'gone', planId: 'pl', status: 'running', startedBy: 'u', startedAt: 'x', versionCreatedAt: 'v', stack: 'go', segments: 1 });
    });
    const logs: string[] = [];
    assert.equal(s.recoverOnBoot(['p1'], new Date(), (m) => logs.push(m)), 2);
    assert.ok(logs.some((m) => m.includes('bad') && m.includes('snapshot merge failed')));
    assert.equal(s.loadCanonicalPlan('p1', 'X').playlists[0].tasks[0].status, 'pending');
    assert.ok(s.load('p1').runs.every((r) => r.status === 'interrupted'));
  });

  it('withProjectLock serializes work per project even across awaits and failures', async () => {
    const s = new ProjectStateStore(dataDir);
    const order: string[] = [];
    const slow = s.withProjectLock('p1', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end'); });
    const failing = s.withProjectLock('p1', async () => { order.push('b'); throw new Error('x'); });
    const after = s.withProjectLock('p1', () => { order.push('c'); return 7; });
    const other = s.withProjectLock('p2', () => { order.push('other'); });
    await Promise.allSettled([slow, failing, after, other]);
    assert.deepEqual(order.filter((o) => o !== 'other'), ['a-start', 'a-end', 'b', 'c']);
    assert.ok(order.indexOf('other') < order.indexOf('a-end'), 'other projects are not blocked');
    assert.equal(await after, 7);
    await assert.rejects(failing);
  });
});

describe('readJobLock', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-readlock-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses the JSON form', () => {
    const p = path.join(dir, 'job.lock');
    fs.writeFileSync(p, JSON.stringify({ serverPid: 1, workerPid: 2, taskPids: [3] }));
    assert.deepEqual(readJobLock(p), { serverPid: 1, workerPid: 2, workerPgid: null, taskPids: [3] });
  });

  it('is undefined for a missing file and null for garbage', () => {
    assert.equal(readJobLock(path.join(dir, 'nope.lock')), undefined);
    const p = path.join(dir, 'job.lock');
    fs.writeFileSync(p, '{not json');
    assert.equal(readJobLock(p), null);
  });
});
