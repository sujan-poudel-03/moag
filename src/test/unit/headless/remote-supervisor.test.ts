// ─── Remote runs: supervisor ───

import { strict as assert } from 'assert';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import * as sinon from 'sinon';
import { createEmptyPlan, createTask, dehydratePlan } from '../../../models/plan';
import { TaskStatus } from '../../../models/types';
import { RemoteLedger } from '../../../headless/remote-ledger';
import { RemoteRunRecord, RemoteRuns } from '../../../headless/remote-runs';
import {
  FORCE_STOPPED_MESSAGE, MAX_CHILD_LINE_BYTES, REMOTE_RUN_MAX_MS, RemoteSupervisor, RUN_TIME_LIMIT_REASON, RunRelay, STOP_GRACE_MS, SupervisorOptions,
} from '../../../headless/remote-supervisor';

const KEY = 'onosoo_live_' + 'S'.repeat(43);

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-sup-')));
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written = '';
  constructor() {
    super();
    this.stdin.on('data', (c: Buffer) => { this.written += c.toString(); });
  }
  line(o: Record<string, unknown>): void { this.stdout.write(JSON.stringify({ ts: '2026-10-11T00:00:00.000Z', ...o }) + '\n'); }
  exit(code: number | null): void { this.stdout.end(); this.emit('close', code); }
}

function planFile() {
  const plan = createEmptyPlan('Remote');
  const a = createTask('Build', 'build'); a.id = 'a';
  const g = createTask('Gate', ''); g.id = 'gate'; g.type = 'manual'; g.dependsOn = ['a'];
  plan.playlists[0].tasks.push(a, g);
  return dehydratePlan(plan);
}

function setup(over: Partial<SupervisorOptions> = {}) {
  const stateDir = tmp();
  const child = new FakeChild();
  const relayed: Array<Record<string, unknown>> = [];
  const relayIds: string[] = [];
  let relayMeta: unknown = null;
  let relayClosed = 0;
  const ledger = new RemoteLedger(stateDir);
  ledger.reserve('run-1', 5, 10);
  const runs = new RemoteRuns(stateDir);
  const record: RemoteRunRecord = {
    runId: 'run-1', projectId: 'web', commandId: 'c1', kind: 'start-run', branch: 'moag/remote-1', startSha: 'a'.repeat(40), engine: 'claude',
    allotment: 5, startedAt: '2026-10-11T00:00:00Z', exitCode: null, outcome: 'live', gateTaskId: null, snapshot: dehydratePlan(createEmptyPlan('pending')),
  };
  runs.save(record);
  const started: string[] = [];
  const imports: string[] = [];
  let forceKills = 0;
  let sweeps = 0;
  const opts: SupervisorOptions = {
    record, projectName: 'Web app', specLine: JSON.stringify({ op: 'run', runId: 'run-1' }), bundle: Buffer.from('INBOUND'),
    spawnChild: () => child,
    relayFactory: (runId): RunRelay => {
      relayIds.push(runId);
      return {
        start: (meta) => { relayMeta = meta ?? null; },
        record: (l) => { relayed.push({ ...l, run_id: runId }); },
        close: async () => { relayClosed++; },
      };
    },
    ledger, runs, tmpDir: path.join(stateDir, 'remote', 'tmp'),
    importBranch: async (file) => { imports.push(fs.readFileSync(file, 'utf-8')); return { ok: true }; },
    forceKill: async () => { forceKills++; },
    sweep: async () => { sweeps++; },
    onStarted: (id) => started.push(id),
    ...over,
  };
  const sup = new RemoteSupervisor(opts);
  return {
    sup, child, relayed, relayIds, started, imports, runs, ledger, record,
    get relayMeta() { return relayMeta; }, get relayClosed() { return relayClosed; }, get forceKills() { return forceKills; }, get sweeps() { return sweeps; },
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('remote supervisor', () => {
  it('writes the spec then the bundle; relays every non-remote line under the run id; onStarted gets that id', async () => {
    const s = setup();
    s.sup.start();
    assert.equal(s.child.written, `${JSON.stringify({ op: 'run', runId: 'run-1' })}\nINBOUND`);
    assert.ok(!s.child.written.includes(KEY));
    s.child.line({ event: 'remote-plan', plan: planFile() });
    s.child.line({ event: 'run-started', plan: 'Remote', branch: 'moag/remote-1' });
    s.child.line({ event: 'task-started', id: 'a', name: 'Build' });
    s.child.line({ event: 'remote-cost', usd: 1.5, engine: 'claude' });
    s.child.line({ event: 'task-completed', id: 'a', name: 'Build' });
    s.child.line({ event: 'remote-statuses', statuses: { a: 'completed', gate: 'not-a-status', ghost: 'failed' } });
    s.child.line({ event: 'manual-gate', id: 'gate', name: 'Gate' });
    s.child.line({ event: 'run-finished', code: 3 });
    s.child.line({ event: 'remote-bundle-end', bytes: 0, sha256: null });
    await tick();
    s.child.exit(3);
    const exit = await s.sup.exit;

    assert.deepEqual(s.started, ['run-1']);
    assert.deepEqual(s.relayIds, ['run-1']);
    assert.ok(s.relayed.every((l) => l.run_id === 'run-1'));
    assert.deepEqual(s.relayed.map((l) => l.event), ['run-started', 'task-started', 'task-completed', 'manual-gate', 'run-finished']);
    assert.ok(!s.relayed.some((l) => String(l.event).startsWith('remote-')), 'remote-* lines are never relayed');
    assert.deepEqual(s.relayMeta, { plan_name: 'Remote', project: 'Web app', tasks: [{ id: 'a', name: 'Build' }, { id: 'gate', name: 'Gate' }], branch: 'moag/remote-1' });
    assert.equal(s.relayClosed, 1);

    const rec = s.runs.get('run-1')!;
    assert.equal(rec.outcome, 'finished');
    assert.equal(rec.exitCode, 3);
    assert.equal(rec.gateTaskId, 'gate');
    assert.deepEqual(rec.snapshot.playlists[0].tasks.map((t) => [t.id, t.status ?? 'pending']), [['a', 'completed'], ['gate', 'pending']]);
    assert.equal(exit.started, true);
    assert.equal(exit.failure, null);
    assert.equal(s.ledger.entries()[0].charged, 1.5, 'settled at the reported spend');
  });

  it('imports a verified bundle and records a damaged one as an import error', async () => {
    const good = setup();
    good.sup.start();
    const data = Buffer.from('OUTBOUND BUNDLE');
    good.child.line({ event: 'run-started' });
    good.child.line({ event: 'remote-bundle-chunk', data: data.toString('base64') });
    good.child.line({ event: 'remote-bundle-end', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    await tick();
    good.child.exit(0);
    await good.sup.exit;
    assert.deepEqual(good.imports, ['OUTBOUND BUNDLE']);
    assert.equal(good.runs.get('run-1')!.importError, undefined);
    assert.deepEqual(fs.readdirSync(path.dirname(path.join(good.runs.dir, '..', 'tmp', 'x'))), [], 'the staged bundle is deleted');

    const bad = setup();
    bad.sup.start();
    bad.child.line({ event: 'run-started' });
    bad.child.line({ event: 'remote-bundle-chunk', data: data.toString('base64') });
    bad.child.line({ event: 'remote-bundle-end', bytes: data.length, sha256: 'f'.repeat(64) });
    await tick();
    bad.child.exit(0);
    await bad.sup.exit;
    assert.deepEqual(bad.imports, []);
    assert.match(bad.runs.get('run-1')!.importError!, /damaged/);
  });

  it('spend: a clean early failure settles what was reported; a killed child is charged in full; the runner is swept', async () => {
    const early = setup();
    early.sup.start();
    early.child.line({ event: 'remote-cost', usd: 0.75, engine: 'claude' });
    early.child.line({ event: 'error', message: 'The plan could not be generated (claude exited 1).' });
    early.child.line({ event: 'remote-bundle-end', bytes: 0, sha256: null });
    await tick();
    early.child.exit(2);
    await early.sup.exit;
    assert.equal(early.ledger.entries()[0].charged, 0.75);
    assert.equal(early.sweeps, 1);

    const killed = setup();
    killed.sup.start();
    killed.child.line({ event: 'run-started' });
    killed.child.line({ event: 'remote-cost', usd: 0.1, engine: 'claude' });
    await tick();
    killed.child.exit(null);
    await killed.sup.exit;
    assert.equal(killed.ledger.entries()[0].charged, 5, 'spend unknown → the full allotment');
    assert.equal(killed.sweeps, 1);
  });

  it('records what the child sent: commitsSent and the branch tip', async () => {
    const s = setup();
    s.sup.start();
    s.child.line({ event: 'run-started' });
    s.child.line({ event: 'remote-bundle-end', bytes: 70_000_000, sha256: null, error: 'too large', tip: 'd'.repeat(40) });
    await tick();
    s.child.exit(1);
    await s.sup.exit;
    const rec = s.runs.get('run-1')!;
    assert.equal(rec.commitsSent, true, 'an oversize bundle still means commits exist (in the mirror)');
    assert.equal(rec.branchTip, 'd'.repeat(40));
    assert.match(rec.importError!, /too large/);

    const none = setup();
    none.sup.start();
    none.child.line({ event: 'run-started' });
    none.child.line({ event: 'remote-bundle-end', bytes: 0, sha256: null, tip: 'a'.repeat(40) });
    await tick();
    none.child.exit(0);
    await none.sup.exit;
    assert.equal(none.runs.get('run-1')!.commitsSent, false);
  });

  it('cost: an error line followed by a crash is unknown (full charge); an explicit no-spend failure is known', async () => {
    const crashed = setup();
    crashed.sup.start();
    crashed.child.line({ event: 'remote-cost', usd: 0.2, engine: 'claude' });
    crashed.child.line({ event: 'error', message: 'something went wrong' });
    await tick();
    crashed.child.exit(1);
    await crashed.sup.exit;
    assert.equal(crashed.ledger.entries()[0].charged, 5);

    const early = setup();
    early.sup.start();
    early.child.line({ event: 'error', message: 'The project\'s code did not arrive.' });
    early.child.line({ event: 'remote-no-spend' });
    await tick();
    early.child.exit(2);
    await early.sup.exit;
    assert.equal(early.ledger.entries()[0].charged, 0);
  });

  it('a ledger that throws inside the stdout handler is logged once, and the run is charged in full', async () => {
    const notes: string[] = [];
    const s = setup({ stderr: (x) => notes.push(x) });
    const real = s.ledger.record.bind(s.ledger);
    s.ledger.record = () => { throw new Error('EIO'); };
    s.sup.start();
    s.child.line({ event: 'run-started' });
    s.child.line({ event: 'remote-cost', usd: 0.1, engine: 'claude' });
    s.child.line({ event: 'remote-cost', usd: 0.1, engine: 'claude' });
    s.child.line({ event: 'remote-bundle-end', bytes: 0, sha256: null });
    s.child.line({ event: 'run-finished' });
    await tick();
    s.ledger.record = real;
    s.child.exit(0);
    await s.sup.exit;
    assert.equal(notes.length, 1);
    assert.match(notes[0], /charged its full allotment/);
    assert.equal(s.ledger.entries()[0].charged, 5);
    assert.deepEqual(s.relayed.map((l) => l.event), ['run-started', 'run-finished'], 'the stream carried on');
  });

  it('a multi-byte character split across chunks arrives intact', async () => {
    const s = setup();
    s.sup.start();
    const bytes = Buffer.from(JSON.stringify({ event: 'warning', message: 'café — ✓ 日本' }) + '\n', 'utf-8');
    const cut = bytes.indexOf(Buffer.from('✓')) + 1;
    s.child.stdout.write(bytes.subarray(0, cut));
    s.child.stdout.write(bytes.subarray(cut));
    await tick();
    s.child.exit(0);
    await s.sup.exit;
    assert.equal(s.relayed[0].message, 'café — ✓ 日本');
  });

  it('an exit before run-started fails with the child\'s message', async () => {
    const s = setup();
    s.sup.start();
    s.child.line({ event: 'error', message: 'The commit the run starts from is not in the runner copy.' });
    await tick();
    s.child.exit(2);
    const exit = await s.sup.exit;
    assert.equal(exit.started, false);
    assert.equal(exit.failure, 'The commit the run starts from is not in the runner copy.');
    assert.deepEqual(s.started, []);
  });

  it('an overlong line is dropped and counted; the next line still parses', async () => {
    const s = setup();
    s.sup.start();
    s.child.stdout.write('{"event":"warning","message":"' + 'x'.repeat(MAX_CHILD_LINE_BYTES + 10) + '"}\n');
    s.child.line({ event: 'run-started' });
    await tick();
    s.child.exit(0);
    await s.sup.exit;
    assert.equal(s.sup.droppedLines, 1);
    assert.deepEqual(s.relayed.map((l) => l.event), ['run-started']);
  });

  it('an overlong line split across chunks is dropped too', async () => {
    const s = setup();
    s.sup.start();
    s.child.stdout.write('{"event":"warning","message":"' + 'y'.repeat(MAX_CHILD_LINE_BYTES + 10));
    s.child.stdout.write('tail"}\n');
    s.child.line({ event: 'run-started' });
    await tick();
    s.child.exit(0);
    await s.sup.exit;
    assert.equal(s.sup.droppedLines, 1);
    assert.deepEqual(s.relayed.map((l) => l.event), ['run-started']);
  });

  describe('stopping (fake timers)', () => {
    let clock: sinon.SinonFakeTimers;
    beforeEach(() => { clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => clock.restore());

    it('stop writes {"op":"stop"}; the child relays stopping/idle and exits → success, no force-kill', async () => {
      const s = setup();
      s.sup.start();
      s.child.line({ event: 'run-started' });
      await clock.tickAsync(0);
      const stopping = s.sup.stop();
      assert.ok(s.child.written.endsWith('{"op":"stop"}\n'));
      s.child.line({ event: 'state', state: 'stopping' });
      s.child.line({ event: 'state', state: 'idle' });
      await clock.tickAsync(0);
      s.child.exit(1);
      const exit = await stopping;
      assert.equal(exit.failure, null);
      assert.equal(s.forceKills, 0);
      assert.deepEqual(s.relayed.map((l) => l.state).filter(Boolean), ['stopping', 'idle']);
      await clock.tickAsync(STOP_GRACE_MS * 2);
      assert.equal(s.forceKills, 0, 'the grace timer was cleared');
    });

    it('no exit within the grace period → force-kill and failed', async () => {
      const s = setup();
      s.sup.start();
      s.child.line({ event: 'run-started' });
      await clock.tickAsync(0);
      const stopping = s.sup.stop();
      await clock.tickAsync(STOP_GRACE_MS - 1);
      assert.equal(s.forceKills, 0);
      await clock.tickAsync(1);
      assert.equal(s.forceKills, 1);
      s.child.exit(null);
      const exit = await stopping;
      assert.equal(exit.failure, FORCE_STOPPED_MESSAGE);
    });

    it('a child that never closes after the force-kill is finalized anyway', async () => {
      const s = setup();
      s.sup.start();
      await clock.tickAsync(0);
      const stopping = s.sup.stop();
      await clock.tickAsync(STOP_GRACE_MS + 10_000);
      const exit = await stopping;
      assert.equal(exit.code, null);
      assert.equal(s.runs.get('run-1')!.outcome, 'finished');
    });

    it('the 4-hour wall clock stops the run and records why', async () => {
      const s = setup();
      s.sup.start();
      s.child.line({ event: 'run-started' });
      await clock.tickAsync(REMOTE_RUN_MAX_MS - 1);
      assert.ok(!s.child.written.includes('"op":"stop"'));
      await clock.tickAsync(1);
      assert.ok(s.child.written.endsWith('{"op":"stop"}\n'));
      const warning = s.relayed.find((l) => l.event === 'warning');
      assert.equal(warning?.message, 'Stopped: the run exceeded the 4-hour limit for remote runs.');
      assert.equal(RUN_TIME_LIMIT_REASON, 'Stopped: the run exceeded the 4-hour limit for remote runs.');
      s.child.exit(1);
      await s.sup.exit;
      assert.equal(s.runs.get('run-1')!.stopReason, RUN_TIME_LIMIT_REASON);
    });
  });

  it('an unreadable remote-plan fails the run', async () => {
    const s = setup();
    s.sup.start();
    s.child.line({ event: 'remote-plan', plan: { nonsense: true } });
    await tick();
    assert.ok(s.child.written.endsWith('{"op":"stop"}\n'));
    s.child.exit(2);
    const exit = await s.sup.exit;
    assert.match(exit.failure!, /plan could not be read/);
    assert.equal(s.ledger.entries()[0].open, false);
    void TaskStatus;
  });
});
