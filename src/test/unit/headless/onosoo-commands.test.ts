// ─── ONOSOO command host ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEmptyPlan, createTask, dehydratePlan } from '../../../models/plan';
import { PlanFile, TaskStatus } from '../../../models/types';
import {
  AUDIT_UNAVAILABLE, CommandHost, createCommandHost, RESTARTED_MESSAGE, SupervisorLike, SupervisorRequest,
} from '../../../headless/onosoo-commands';
import type { Capabilities, CommandResult, PolledCommand, ResultOutcome } from '../../../headless/onosoo-control';
import type { ApprovedProjects } from '../../../headless/onosoo-projects';
import { RemoteAudit } from '../../../headless/remote-audit';
import { BUSY, REMOTE_START_OFF } from '../../../headless/remote-commands';
import { RemoteLedger } from '../../../headless/remote-ledger';
import { DaemonLock, LockOutcome } from '../../../headless/remote-lock';
import { mirrorBranchGoneMessage } from '../../../headless/remote-child';
import { RemoteRunRecord, RemoteRuns } from '../../../headless/remote-runs';
import type { RunExit } from '../../../headless/remote-supervisor';

const PROJECT_PATH = '/srv/secret-layout/web';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-host-')));
}

class FakeControl {
  revoked = false;
  polls: Array<PolledCommand[] | 'stop' | { waitMs: number }> = [];
  pollCount = 0;
  results: Array<{ id: string; result: CommandResult }> = [];
  caps: Capabilities[] = [];
  resultReply: ResultOutcome = 'delivered';
  lastRetryAfterMs: number | null = null;
  log: string[] = [];
  async poll(): Promise<PolledCommand[] | 'stop' | { waitMs: number }> {
    this.pollCount++;
    return this.polls.shift() ?? [];
  }
  async postResult(id: string, result: CommandResult): Promise<ResultOutcome> {
    this.results.push({ id, result });
    return this.resultReply;
  }
  async sendCapabilities(caps: Capabilities): Promise<boolean> {
    this.log.push(`caps:${caps.remote_start}`);
    this.caps.push(JSON.parse(JSON.stringify(caps)));
    return true;
  }
}

class FakeSupervisor implements SupervisorLike {
  stops = 0;
  started = false;
  readonly exit: Promise<RunExit>;
  private resolveExit!: (e: RunExit) => void;
  constructor(readonly req: SupervisorRequest, private readonly behaviour: 'starts' | 'never') {
    this.exit = new Promise((r) => { this.resolveExit = r; });
  }
  get runId(): string { return this.req.record.runId; }
  start(): void {
    this.started = true;
    if (this.behaviour === 'starts') { void Promise.resolve().then(() => this.req.onStarted(this.runId)); }
  }
  async stop(): Promise<RunExit> {
    this.stops++;
    this.end(1);
    return this.exit;
  }
  end(code: number, failure: string | null = null): void {
    const exit = { record: this.req.record, code, started: this.behaviour === 'starts', failure };
    this.req.onExit(exit);
    this.resolveExit(exit);
  }
}

function projects(over: Partial<ApprovedProjects> = {}): ApprovedProjects {
  return {
    remoteStart: true, dailyBudgetUsd: 20, runnerUser: 'moag-runner', errors: [],
    projects: [{ id: 'web', name: 'Web app', kinds: ['node'], path: PROJECT_PATH }], ...over,
  };
}

function harness(opts: {
  platform?: NodeJS.Platform; behaviour?: 'starts' | 'never'; stateDir?: string;
  branchExists?: boolean; exportFails?: boolean; lock?: { acquire(): LockOutcome; release(): void }; idPrefix?: string;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }; stderr?: (s: string) => void;
  /** The project's tip of the parent branch (null = no branch); when set, the host uses it instead of branchExists. */
  projectTip?: string | null; drain?: () => Promise<void>;
} = {}) {
  const exports: Array<Record<string, unknown>> = [];
  const stateDir = opts.stateDir ?? tmp();
  const control = new FakeControl();
  let current = projects();
  const sups: FakeSupervisor[] = [];
  let ids = 0;
  const host: CommandHost = createCommandHost({
    control,
    stateDir,
    loadProjects: () => current,
    platform: opts.platform ?? 'linux',
    probe: async () => ({ ok: true, uid: 1001, engines: ['claude', 'ollama'], mirrors: {} }),
    supervisorFactory: (req) => { const s = new FakeSupervisor(req, opts.behaviour ?? 'starts'); sups.push(s); return s; },
    exportBundle: async (_p, o) => {
      exports.push({ ...o });
      if (opts.exportFails) { return { ok: false, reason: 'The branch moag/x does not exist in the project on this PC.' }; }
      return { ok: true, baseSha: 'a'.repeat(40), startSha: o.startSha ?? 'a'.repeat(40), bundle: Buffer.from('B') };
    },
    branchExists: async () => opts.branchExists ?? true,
    ...(opts.projectTip !== undefined ? { projectBranchTip: async () => opts.projectTip as string | null } : {}),
    ...(opts.drain ? { drainLeftoverSpool: opts.drain } : {}),
    ...(opts.lock ? { lock: opts.lock } : {}),
    ledger: new RemoteLedger(stateDir),
    audit: new RemoteAudit(stateDir),
    runs: new RemoteRuns(stateDir),
    branchPrefix: 'moag/',
    engineEnv: { ANTHROPIC_API_KEY: 'sk-engine' },
    newRunId: () => `run-${opts.idPrefix ?? ''}${++ids}`,
    timers: opts.timers ?? { setTimeout: () => null, clearTimeout: () => undefined },
    stderr: opts.stderr ?? (() => undefined),
  });
  return {
    host, control, sups, stateDir, exports,
    setProjects: (p: ApprovedProjects) => { current = p; },
    audit: () => new RemoteAudit(stateDir).readAll(),
    runs: new RemoteRuns(stateDir),
  };
}

const startRun = (id: string, over: Record<string, unknown> = {}): PolledCommand =>
  ({ id, kind: 'start-run', payload: { project_id: 'web', goal: 'Add login', budget_usd: 5, ...over }, requested_by: 'Ana' });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const finals = (c: FakeControl, id: string): CommandResult[] => c.results.filter((r) => r.id === id).map((r) => r.result);

describe('ONOSOO command host', () => {
  it('starts a run: running, then succeeded with the run id; polling continues while the run never ends', async () => {
    const h = harness();
    h.control.polls.push([startRun('c1')]);
    await h.host.tick();
    await tick();
    assert.equal(h.sups.length, 1);
    const [running, succeeded] = finals(h.control, 'c1');
    assert.equal(running.status, 'running');
    assert.deepEqual(succeeded, { status: 'succeeded', message: 'The run started on this PC.', run_id: 'run-1' });
    // The run is still live; the loop keeps polling.
    await h.host.tick();
    await h.host.tick();
    assert.equal(h.control.pollCount, 3);
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.branch.startsWith('moag/web-'), true);
    assert.equal(spec.engineEnv.ANTHROPIC_API_KEY, 'sk-engine');
    assert.ok(!h.sups[0].req.specLine.includes('onosoo_live_'));
    assert.equal(h.runs.get('run-1')!.outcome, 'live');
  });

  it('a second start while one is active is busy', async () => {
    const h = harness({ behaviour: 'never' });
    h.control.polls.push([startRun('c1'), startRun('c2')]);
    await h.host.tick();
    assert.equal(h.sups.length, 1);
    assert.deepEqual(finals(h.control, 'c2'), [{ status: 'rejected', message: BUSY }]);
  });

  it('capabilities never carry a project path; an edit to projects.json shows in the next ones; unchanged ones are not resent', async () => {
    const h = harness();
    await h.host.tick();
    await h.host.tick();
    assert.equal(h.control.caps.length, 1);
    assert.deepEqual(h.control.caps[0], { remote_start: true, projects: [{ id: 'web', name: 'Web app', kinds: ['node'] }], engines: ['claude', 'ollama'] });
    assert.ok(!JSON.stringify(h.control.caps).includes(PROJECT_PATH));
    h.setProjects(projects({ projects: [{ id: 'web', name: 'Web (renamed)', kinds: [], path: PROJECT_PATH }] }));
    await h.host.tick();
    assert.equal(h.control.caps.length, 2);
    assert.equal(h.control.caps[1].projects[0].name, 'Web (renamed)');
  });

  it('every rejection is audited and nothing is spawned', async () => {
    const h = harness();
    h.setProjects(projects({ remoteStart: false }));
    h.control.polls.push([startRun('c1', { prd: 'TOP SECRET PRD TEXT' })]);
    await h.host.tick();
    assert.equal(h.sups.length, 0);
    assert.deepEqual(finals(h.control, 'c1'), [{ status: 'rejected', message: REMOTE_START_OFF }]);
    const phases = h.audit().filter((l) => l.id === 'c1').map((l) => l.phase);
    assert.deepEqual(phases, ['received', 'decided', 'final', 'delivered']);
    assert.ok(!fs.readFileSync(path.join(h.stateDir, 'remote', 'audit.jsonl'), 'utf-8').includes('TOP SECRET'));
  });

  it('an unknown kind and a malformed command are rejected', async () => {
    const h = harness();
    h.control.polls.push([{ id: 'u1', kind: 'env-start', payload: {} }, { id: 'm1', invalid: 'The command has no kind.' }]);
    await h.host.tick();
    assert.equal(finals(h.control, 'u1')[0].status, 'rejected');
    assert.deepEqual(finals(h.control, 'm1'), [{ status: 'rejected', message: 'The command has no kind.' }]);
  });

  it('after a restart, an unfinished command fails with the restart message and is never executed again', async () => {
    const stateDir = tmp();
    new RemoteAudit(stateDir).appendOrThrow({ id: 'cut', kind: 'start-run', phase: 'received' });
    const h = harness({ stateDir });
    await h.host.start();
    assert.deepEqual(finals(h.control, 'cut'), [{ status: 'failed', message: RESTARTED_MESSAGE }]);
    h.control.polls.push([startRun('cut')]);
    await h.host.tick();
    assert.equal(h.sups.length, 0, 'never re-executed');
    assert.equal(finals(h.control, 'cut').length, 1);
  });

  it('at boot a live record becomes interrupted and its allotment is charged in full', async () => {
    const stateDir = tmp();
    const ledger = new RemoteLedger(stateDir, { pid: process.pid });
    ledger.reserve('run-old', 6, 20);
    const runs = new RemoteRuns(stateDir);
    runs.save({
      runId: 'run-old', projectId: 'web', commandId: 'c0', kind: 'start-run', branch: 'moag/x', startSha: 'a'.repeat(40), engine: 'claude',
      allotment: 6, startedAt: '2026-10-11T00:00:00Z', exitCode: null, outcome: 'live', gateTaskId: null, snapshot: dehydratePlan(createEmptyPlan('x')),
    });
    const h = harness({ stateDir });
    await h.host.start();
    assert.equal(h.runs.get('run-old')!.outcome, 'interrupted');
    assert.equal(new RemoteLedger(stateDir).remaining(20), 14);
  });

  it('a 409 result is not retried; a retry result stays in the outbox for the next cycle', async () => {
    const h = harness();
    h.control.resultReply = 'final';
    h.control.polls.push([{ id: 'u1', kind: 'nope', payload: {} }]);
    await h.host.tick();
    const n = h.control.results.length;
    await h.host.tick();
    assert.equal(h.control.results.length, n, 'nothing reposted');

    const r = harness();
    r.control.resultReply = 'retry';
    r.control.polls.push([{ id: 'u2', kind: 'nope', payload: {} }]);
    await r.host.tick();
    r.control.resultReply = 'delivered';
    await r.host.tick();
    assert.equal(finals(r.control, 'u2').length, 2, 'retried once more, then delivered');
    assert.deepEqual(new RemoteAudit(r.stateDir).outboxList(), []);
  });

  it('a revoked key (poll says stop) ends polling', async () => {
    const h = harness();
    h.control.polls.push('stop');
    await h.host.tick();
    await h.host.tick();
    assert.equal(h.control.pollCount, 1);
  });

  it('on Windows everything is rejected with the isolation message while polling and capabilities continue', async () => {
    const h = harness({ platform: 'win32' });
    h.control.polls.push([startRun('c1')]);
    await h.host.tick();
    await h.host.tick();
    assert.equal(h.sups.length, 0);
    assert.match(finals(h.control, 'c1')[0].message, /Linux .*Windows/);
    assert.equal(h.control.caps[0].remote_start, false);
    assert.deepEqual(h.control.caps[0].engines, []);
    assert.equal(h.control.pollCount, 2);
  });

  it('stop: the active run is stopped and the result follows its exit', async () => {
    const h = harness({ behaviour: 'never' });
    h.control.polls.push([startRun('c1')]);
    await h.host.tick();
    h.control.polls.push([{ id: 's1', kind: 'stop', payload: { run_id: 'run-1' } }]);
    await h.host.tick();
    await tick();
    assert.equal(h.sups[0].stops, 1);
    assert.deepEqual(finals(h.control, 's1'), [{ status: 'succeeded', message: 'The run was stopped.', run_id: 'run-1' }]);
    assert.deepEqual(finals(h.control, 'c1').map((r) => r.status), ['running', 'failed'], 'a run that never started reports failed');
  });

  it('stop of an unknown run and of a hand-started run get distinct messages', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.stateDir, 'onosoo-spool', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, 'onosoo-spool', 'abc', 'hand-1.jsonl'), '{}\n');
    h.control.polls.push([{ id: 's1', kind: 'stop', payload: { run_id: 'nope' } }, { id: 's2', kind: 'stop', payload: { run_id: 'hand-1' } }]);
    await h.host.tick();
    assert.match(finals(h.control, 's1')[0].message, /No run with this id/);
    assert.match(finals(h.control, 's2')[0].message, /started by hand/);
  });

  it('approve resumes a halted run on its branch with the gate Completed, once', async () => {
    const h = harness({ behaviour: 'starts' });
    const plan = createEmptyPlan('P');
    const a = createTask('A', 'a'); a.id = 'a'; a.status = TaskStatus.Completed;
    const g = createTask('Gate', ''); g.id = 'gate'; g.type = 'manual'; g.status = TaskStatus.Failed; g.dependsOn = ['a'];
    plan.playlists[0].tasks.push(a, g);
    const parent: RemoteRunRecord = {
      runId: 'run-p', projectId: 'web', commandId: 'c0', kind: 'start-run', branch: 'moag/web-parent', startSha: 'a'.repeat(40), engine: 'claude',
      allotment: 3, startedAt: '2026-10-11T00:00:00Z', exitCode: 3, outcome: 'finished', gateTaskId: 'gate', snapshot: dehydratePlan(plan),
    };
    h.runs.save(parent);
    h.control.polls.push([{ id: 'ap1', kind: 'approve', payload: { run_id: 'run-p', task_id: 'gate' } }]);
    await h.host.tick();
    assert.equal(h.sups.length, 1);
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.branch, 'moag/web-parent');
    assert.equal(spec.allotment, 3);
    const gate = (spec.snapshot as PlanFile).playlists[0].tasks.find((t) => t.id === 'gate')!;
    assert.equal(gate.status, TaskStatus.Completed);
    assert.equal(h.runs.get('run-p')!.decided!.kind, 'approve');
    assert.equal(h.runs.get(spec.runId)!.parentRunId, 'run-p');

    await tick();
    h.sups[0].end(0);
    h.control.polls.push([{ id: 'ap2', kind: 'skip', payload: { run_id: 'run-p', task_id: 'gate' } }]);
    await h.host.tick();
    assert.match(finals(h.control, 'ap2')[0].message, /already been decided \(approve\)/);
  });

  function haltedParent(h: ReturnType<typeof harness>, over: Partial<RemoteRunRecord> = {}): RemoteRunRecord {
    const plan = createEmptyPlan('P');
    const a = createTask('A', 'a'); a.id = 'a'; a.status = TaskStatus.Failed;
    const g = createTask('Gate', ''); g.id = 'gate'; g.type = 'manual'; g.dependsOn = ['a'];
    plan.playlists[0].tasks.push(a, g);
    const parent: RemoteRunRecord = {
      runId: 'run-p', projectId: 'web', commandId: 'c0', kind: 'start-run', branch: 'moag/web-parent', startSha: 'b'.repeat(40), engine: 'claude',
      allotment: 3, startedAt: '2026-10-11T00:00:00Z', exitCode: 1, outcome: 'finished', gateTaskId: null, snapshot: dehydratePlan(plan), ...over,
    };
    h.runs.save(parent);
    return parent;
  }

  it('retry of a run that finished cleanly with no commits continues from its start point on a fresh branch', async () => {
    const h = harness({ branchExists: false });
    haltedParent(h, { commitsSent: false });
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-p' } }]);
    await h.host.tick();
    await tick();
    assert.equal(h.sups.length, 1);
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.notEqual(spec.branch, 'moag/web-parent');
    assert.ok(spec.branch.startsWith('moag/web-'));
    assert.equal(spec.startSha, 'b'.repeat(40));
    assert.deepEqual(h.exports[0], { startSha: 'b'.repeat(40), haveShas: [] });
    assert.equal(spec.resumeFromMirrorBranch, undefined);
    assert.equal(finals(h.control, 'r1').pop()!.status, 'succeeded');
    assert.equal(h.runs.get('run-p')!.decided!.kind, 'retry');
  });

  it('an interrupted parent with commits resumes from the runner mirror\'s copy of its branch, keeping completed work', async () => {
    const h = harness({ branchExists: false });
    const parent = haltedParent(h, { outcome: 'interrupted', exitCode: null });
    parent.snapshot.playlists[0].tasks[0].status = TaskStatus.Failed;
    const done = createTask('Done', 'd'); done.id = 'done'; done.status = TaskStatus.Completed;
    parent.snapshot.playlists[0].tasks.unshift(dehydratePlan({ ...createEmptyPlan('x'), playlists: [{ ...createEmptyPlan('x').playlists[0], tasks: [done] }] }).playlists[0].tasks[0]);
    h.runs.save(parent);
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-p' } }]);
    await h.host.tick();
    await tick();
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.resumeFromMirrorBranch, 'moag/web-parent');
    assert.equal(spec.branch, 'moag/web-parent', 'the work continues on the same branch');
    assert.equal(spec.startSha, 'b'.repeat(40), 'cut from the project-known base');
    assert.equal(spec.expectedTip, undefined, 'no tip was ever reported');
    const tasks = (spec.snapshot as PlanFile).playlists[0].tasks;
    assert.equal(tasks.find((t) => t.id === 'done')!.status, TaskStatus.Completed, 'completed work is not redone');
    assert.equal(finals(h.control, 'r1').pop()!.status, 'succeeded');
  });

  it('an approve after a failed import continues from the mirror, at the tip the parent reported (even with the branch in the project)', async () => {
    const h = harness({ branchExists: true });
    haltedParent(h, { gateTaskId: 'gate', exitCode: 3, commitsSent: true, branchTip: 'c'.repeat(40), importError: 'it would not fast-forward' });
    h.control.polls.push([{ id: 'ap1', kind: 'approve', payload: { run_id: 'run-p', task_id: 'gate' } }]);
    await h.host.tick();
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.resumeFromMirrorBranch, 'moag/web-parent');
    assert.equal(spec.expectedTip, 'c'.repeat(40));
  });

  it('an interrupted continuation run whose branch exists in the project resumes from the mirror', async () => {
    const h = harness({ branchExists: true, projectTip: 'a'.repeat(40) });
    haltedParent(h, { kind: 'retry', outcome: 'interrupted', exitCode: null, branchTip: 'c'.repeat(40) });
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-p' } }]);
    await h.host.tick();
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.resumeFromMirrorBranch, 'moag/web-parent', 'continuing from the project branch would drop the unimported commits');
    assert.equal(spec.branch, 'moag/web-parent');
    assert.equal(spec.expectedTip, 'c'.repeat(40));
    assert.deepEqual(h.exports[0], { startSha: 'b'.repeat(40), haveShas: [] });
  });

  it('a parent that finished with its import intact continues from the project branch', async () => {
    const h = harness({ projectTip: 'f'.repeat(40) });
    haltedParent(h, { commitsSent: true, branchTip: 'c'.repeat(40) });
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-p' } }]);
    await h.host.tick();
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.resumeFromMirrorBranch, undefined);
    assert.deepEqual(h.exports[0], { continueBranch: 'moag/web-parent', haveShas: [] });
  });

  it('a project tip equal to the parent\'s reported tip continues from the project branch, even after an interruption', async () => {
    const h = harness({ projectTip: 'c'.repeat(40) });
    haltedParent(h, { outcome: 'interrupted', exitCode: null, branchTip: 'c'.repeat(40) });
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-p' } }]);
    await h.host.tick();
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.resumeFromMirrorBranch, undefined);
    assert.deepEqual(h.exports[0], { continueBranch: 'moag/web-parent', haveShas: [] });
  });

  it('close() during the initial boot waits for the boot before releasing the lock', async () => {
    const stateDir = tmp();
    let finishDrain: () => void = () => undefined;
    let drainDone = false;
    const lock = new DaemonLock(stateDir, { pid: 444, isPidAlive: () => true, procStart: () => null });
    const h = harness({
      stateDir, lock,
      drain: () => new Promise<void>((r) => { finishDrain = () => { drainDone = true; r(); }; }),
    });
    const starting = h.host.start();
    await tick();
    let closed = false;
    const closing = h.host.close().then(() => { closed = true; });
    await tick();
    await tick();
    assert.equal(closed, false, 'close waits for the boot');
    assert.ok(fs.existsSync(lock.file), 'the lock is still held during boot');
    finishDrain();
    await starting;
    await closing;
    assert.equal(drainDone, true);
    assert.equal(closed, true);
    assert.ok(!fs.existsSync(lock.file), 'released once the boot finished');
  });

  it('close() after a boot that rejected resolves and releases the lock', async () => {
    const stateDir = tmp();
    // An unfinished command makes the boot finalize it; the outbox write that follows throws.
    new RemoteAudit(stateDir).appendOrThrow({ id: 'cut', kind: 'start-run', phase: 'received' });
    const lock = new DaemonLock(stateDir, { pid: 445, isPidAlive: () => true, procStart: () => null });
    const h = harness({ stateDir, lock });
    const original = RemoteAudit.prototype.outboxRemove;
    RemoteAudit.prototype.outboxRemove = function (): void { throw new Error('EACCES: outbox.json'); };
    try {
      await assert.rejects(h.host.start(), /EACCES/);
      assert.ok(fs.existsSync(lock.file), 'the lock is held after the failed boot');
      await h.host.close();
      assert.ok(!fs.existsSync(lock.file), 'close() released the lock');
      await h.host.close(); // every caller gets the same, resolved promise
    } finally {
      RemoteAudit.prototype.outboxRemove = original;
    }
  });

  it('close() while a boot is pending that then rejects resolves and releases the lock', async () => {
    const stateDir = tmp();
    let failDrain: (e: Error) => void = () => undefined;
    const lock = new DaemonLock(stateDir, { pid: 446, isPidAlive: () => true, procStart: () => null });
    const h = harness({ stateDir, lock, drain: () => new Promise<void>((_r, reject) => { failDrain = reject; }) });
    // drainLeftoverSpool's rejection is swallowed by boot; make loadProjects throw right after it.
    const starting = h.host.start().then(() => 'resolved', () => 'rejected');
    await tick();
    const closing = h.host.close();
    h.setProjects(null as unknown as ApprovedProjects);
    failDrain(new Error('drain failed'));
    await closing;
    assert.equal(await starting, 'rejected');
    assert.ok(!fs.existsSync(lock.file), 'released even though the boot rejected');
  });

  it('when the mirror\'s copy is gone the resume fails with a readable message and the parent stays undecided', async () => {
    const h = harness({ branchExists: false, behaviour: 'never' });
    haltedParent(h, { outcome: 'interrupted', exitCode: null });
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-p' } }]);
    await h.host.tick();
    const message = mirrorBranchGoneMessage('moag/web-parent');
    assert.equal(message, 'This run\'s commits never reached the project on this PC and the runner\'s copy of branch moag/web-parent is gone; start a new run instead.');
    h.sups[0].end(2, message);
    await tick();
    assert.deepEqual(finals(h.control, 'r1').pop(), { status: 'failed', message, run_id: 'run-1' });
    assert.equal(h.runs.get('run-p')!.decided, undefined);
  });

  it('retrying a goal-only run does not add a ship gate', async () => {
    const h = harness();
    const plan = createEmptyPlan('Goal');
    const t = createTask('Add login', 'Add login'); t.id = 'only'; t.status = TaskStatus.Failed;
    plan.playlists[0].tasks.push(t);
    h.runs.save({
      runId: 'run-g', projectId: 'web', commandId: 'c0', kind: 'start-run', branch: 'moag/web-g', startSha: 'b'.repeat(40), engine: 'claude',
      allotment: 3, startedAt: '2026-10-11T00:00:00Z', exitCode: 1, outcome: 'finished', gateTaskId: null, planKind: 'goal', snapshot: dehydratePlan(plan),
    });
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-g' } }]);
    await h.host.tick();
    const spec = JSON.parse(h.sups[0].req.specLine);
    assert.equal(spec.planKind, 'goal');
    assert.ok(!(spec.snapshot as PlanFile).playlists.some((pl) => pl.tasks.some((x) => x.type === 'manual')));
    assert.equal(h.runs.get(spec.runId)!.planKind, 'goal');
  });

  it('a start-run records its plan kind', async () => {
    const h = harness();
    h.control.polls.push([startRun('c1'), startRun('c2', { prd: '# PRD' })]);
    await h.host.tick();
    assert.equal(JSON.parse(h.sups[0].req.specLine).planKind, 'goal');
  });

  it('a daemon that lost the lock retries every minute and takes over once the other stops', async () => {
    const stateDir = tmp();
    const first = harness({ stateDir, lock: new DaemonLock(stateDir, { pid: 111, isPidAlive: () => true, procStart: () => null }) });
    await first.host.start();
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const notes: string[] = [];
    const second = harness({
      stateDir, idPrefix: 'b',
      lock: new DaemonLock(stateDir, { pid: 222, isPidAlive: (pid) => pid !== 111 || !firstGone, procStart: () => null }),
      timers: { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: () => undefined },
      stderr: (x) => notes.push(x),
    });
    let firstGone = false;
    await second.host.start();
    assert.equal(second.host.standingDown, true);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 60_000);
    pending.shift()!.fn(); // still held
    assert.equal(second.host.standingDown, true);
    assert.equal(pending.length, 1, 'tries again');
    firstGone = true;
    pending.shift()!.fn();
    await tick();
    await tick();
    assert.equal(second.host.standingDown, false);
    assert.ok(notes.some((n) => /now handles remote commands/.test(n)));
    assert.ok(pending.some((t) => t.ms === 0), 'the poll loop was scheduled');
    await second.host.close();
  });

  it('an export failure during approve leaves the parent undecided, so a second approve works', async () => {
    const h = harness({ exportFails: true });
    haltedParent(h, { gateTaskId: 'gate', exitCode: 3 });
    h.control.polls.push([{ id: 'ap1', kind: 'approve', payload: { run_id: 'run-p', task_id: 'gate' } }]);
    await h.host.tick();
    assert.equal(finals(h.control, 'ap1').pop()!.status, 'failed');
    assert.equal(h.runs.get('run-p')!.decided, undefined);
    assert.equal(h.sups.length, 0);

    const again = harness({ stateDir: h.stateDir, idPrefix: 'b' });
    again.control.polls.push([{ id: 'ap2', kind: 'approve', payload: { run_id: 'run-p', task_id: 'gate' } }]);
    await again.host.tick();
    await tick();
    assert.equal(again.sups.length, 1);
    assert.equal(again.runs.get('run-p')!.decided!.commandId, 'ap2');
  });

  it('a run that never starts rolls its parent\'s decision back', async () => {
    const h = harness({ behaviour: 'never' });
    haltedParent(h, { gateTaskId: 'gate', exitCode: 3 });
    h.control.polls.push([{ id: 'ap1', kind: 'approve', payload: { run_id: 'run-p', task_id: 'gate' } }]);
    await h.host.tick();
    assert.equal(h.runs.get('run-p')!.decided!.commandId, 'ap1');
    h.sups[0].end(2, 'The commit the run starts from is not in the runner copy.');
    assert.equal(h.runs.get('run-p')!.decided, undefined);
  });

  it('a resume snapshot that would leave the worktree is rejected and the parent stays undecided', async () => {
    const h = harness();
    const parent = haltedParent(h);
    parent.snapshot.playlists[0].tasks[0].cwd = '/etc';
    h.runs.save(parent);
    h.control.polls.push([{ id: 'r1', kind: 'retry', payload: { run_id: 'run-p' } }]);
    await h.host.tick();
    assert.match(finals(h.control, 'r1')[0].message, /outside the project/);
    assert.equal(h.sups.length, 0);
    assert.equal(h.runs.get('run-p')!.decided, undefined);
  });

  it('capabilities say remote_start only when there is a daily budget too', async () => {
    const h = harness();
    h.setProjects(projects({ dailyBudgetUsd: null }));
    await h.host.tick();
    assert.equal(h.control.caps[0].remote_start, false);
  });

  it('a rate-limited result stops the outbox flush and skips this cycle\'s poll, for retry_after', async () => {
    const h = harness();
    new RemoteAudit(h.stateDir).outboxAdd('old-1', { status: 'rejected', message: 'x' });
    new RemoteAudit(h.stateDir).outboxAdd('old-2', { status: 'rejected', message: 'y' });
    h.control.resultReply = 'retry';
    h.control.lastRetryAfterMs = 30_000;
    assert.equal(await h.host.tick(), 30_000);
    assert.deepEqual(h.control.results.map((r) => r.id), ['old-1'], 'stopped at the first');
    assert.equal(h.control.pollCount, 0);
  });

  it('a second host on the same state dir stands down while the first holds the lock; a stale lock is taken over', async () => {
    const stateDir = tmp();
    const first = harness({ stateDir, lock: new DaemonLock(stateDir, { pid: 111, isPidAlive: () => true, procStart: () => null }) });
    await first.host.start();
    const notes: string[] = [];
    const second = harness({ stateDir, lock: new DaemonLock(stateDir, { pid: 222, isPidAlive: () => true, procStart: () => null }) });
    (second.host as unknown as { o: { stderr: (s: string) => void } }).o.stderr = (x) => notes.push(x);
    await second.host.start();
    assert.equal(second.host.standingDown, true);
    second.control.polls.push([startRun('c1')]);
    await second.host.tick();
    assert.equal(second.control.pollCount, 0, 'no polling at all');
    assert.equal(second.control.caps.length, 0);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /pid 111/);

    // The first holder dies: the next daemon takes the lock over.
    const third = harness({ stateDir, lock: new DaemonLock(stateDir, { pid: 333, isPidAlive: (pid) => pid !== 111, procStart: () => null }) });
    await third.host.start();
    assert.equal(third.host.standingDown, false);
    await third.host.close();
    assert.ok(!fs.existsSync(path.join(stateDir, 'remote', 'daemon.lock')), 'released on close');
  });

  it('close: remote_start:false first, then the run is stopped and close waits for it; every caller gets the same promise', async () => {
    const h = harness({ behaviour: 'never' });
    h.control.polls.push([startRun('c1')]);
    await h.host.tick();
    const sup = h.sups[0];
    let release: () => void = () => undefined;
    sup.stop = async () => {
      h.control.log.push('stop');
      sup.stops++;
      await new Promise<void>((r) => { release = r; });
      sup.end(1);
      return sup.exit;
    };
    let closed = false;
    const p1 = h.host.close().then(() => { closed = true; });
    const p2 = h.host.close();
    await tick();
    await tick();
    assert.deepEqual(h.control.log.slice(-2), ['caps:false', 'stop']);
    assert.equal(closed, false, 'close waits for the run to finalize');
    release();
    await p1;
    await p2;
    assert.equal(closed, true);
    assert.equal(sup.stops, 1);
  });

  it('a command whose audit line cannot be written fails with "audit log unavailable"', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.stateDir, 'remote', 'audit.jsonl'), { recursive: true });
    h.control.polls.push([startRun('c1')]);
    await h.host.tick();
    assert.deepEqual(finals(h.control, 'c1'), [{ status: 'failed', message: AUDIT_UNAVAILABLE }]);
    assert.equal(h.sups.length, 0);
  });

  it('close stops the active run and reports remote_start: false', async () => {
    const h = harness({ behaviour: 'never' });
    h.control.polls.push([startRun('c1')]);
    await h.host.tick();
    await h.host.close();
    assert.equal(h.sups[0].stops, 1);
    assert.equal(h.control.caps[h.control.caps.length - 1].remote_start, false);
  });
});
