// ─── host-run-relay: one ONOSOO relay per run played inside a long-lived host ───
//
// No network: every test injects a recording HTTP client. The runner is an EventEmitter
// fake that scripts state-changed and task events the way TaskRunner emits them.

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  createHostRunRelay, HOST_MANUAL_GATE_NOTE, HostRelayRunner, HostRunRelayDeps, hostRunFinishedCode, probeRelayStatus, RelayStatus,
} from '../../../headless/host-run-relay';
import { REVOKED_MESSAGE } from '../../../headless/onosoo-relay';
import { costLedger } from '../../../utils/cost-ledger';
import { createPlaylist, createTask, loadPlan } from '../../../models/plan';
import { Plan, TaskStatus } from '../../../models/types';

const KEY = 'onosoo_live_' + 'H'.repeat(43);
const URL = 'http://127.0.0.1:9';
const PROMPT = 'Implement the host-relay feature';

type Ev = { run_id: string; seq: number; type: string; at: string; data: Record<string, unknown> };
type Body = { events: Ev[] };
type Call = { body: Body; raw: string };
type Reply = { status: number; body: string };

const MAPPED_EVENTS = [
  'state-changed', 'task-started', 'task-completed', 'task-failed', 'task-escalate', 'incident', 'error',
  'dependencies-installed', 'dependencies-install-failed', 'dependencies-not-installed', 'budget-exceeded', 'manual-gate',
];

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A plan dir and a separate user config dir (never inside the plan dir). */
function workspace(): { dir: string; planFile: string; configDir: string } {
  const dir = tmp('moag-hrr-');
  const configDir = tmp('moag-hrr-cfg-');
  const planFile = path.join(dir, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({
    version: '1.0', name: 'Host plan', defaultEngine: 'claude',
    playlists: [{ id: 'pl', name: 'Build', tasks: [
      { id: 't-1', name: 'First', prompt: PROMPT },
      { id: 't-2', name: 'Second', prompt: PROMPT },
    ] }],
  }, null, 2));
  return { dir, planFile, configDir };
}

function recorder(respond?: (body: Body) => Promise<Reply> | Reply) {
  const calls: Call[] = [];
  const http = async (req: { body: string }): Promise<Reply> => {
    const body = JSON.parse(req.body) as Body;
    calls.push({ body, raw: req.body });
    if (respond) { return respond(body); }
    const acked: Record<string, number> = {};
    for (const e of body.events) { acked[e.run_id] = Math.max(acked[e.run_id] ?? 0, e.seq); }
    return { status: 200, body: JSON.stringify({ acked }) };
  };
  const sent = (): Ev[] => calls.flatMap((c) => c.body.events);
  return { calls, http, sent };
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) { throw new Error('timed out waiting'); }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The fake runner: an EventEmitter with the getters the controller reads. */
type FakeRunner = EventEmitter & {
  state: string;
  currentPlan: Plan | null;
  currentRunTaskIds: readonly string[] | null;
  setTaskSettledHook: sinon.SinonSpy;
};

function fakeRunner(): FakeRunner {
  const r = new EventEmitter() as FakeRunner;
  r.state = 'idle';
  r.currentPlan = null;
  r.currentRunTaskIds = null;
  r.setTaskSettledHook = sinon.spy();
  return r;
}

function setState(r: FakeRunner, s: string): void {
  r.state = s;
  r.emit('state-changed', s);
}

function harness(opts: Partial<HostRunRelayDeps> & { respond?: (body: Body) => Promise<Reply> | Reply; cwdNull?: boolean } = {}) {
  const ws = workspace();
  const rec = recorder(opts.respond);
  const runner = fakeRunner();
  const statuses: RelayStatus[] = [];
  const logs: string[] = [];
  const env: NodeJS.ProcessEnv = { APPDATA: ws.configDir, XDG_CONFIG_HOME: ws.configDir, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: URL };
  const ctl = createHostRunRelay({
    runner: runner as unknown as HostRelayRunner,
    cwd: () => (opts.cwdNull ? null : ws.dir),
    env: () => env,
    enabled: () => true,
    planPath: () => ws.planFile,
    fullAuto: () => false,
    log: (l) => logs.push(l),
    onStatus: (s) => statuses.push(s),
    http: rec.http,
    closeDeadlineMs: 500,
    ...opts,
  });
  const plan = loadPlan(ws.planFile);
  /** Start a run of `plan` (optionally scoped) the way TaskRunner does. */
  const start = (ids: readonly string[] | null = null): void => {
    runner.currentPlan = plan;
    runner.currentRunTaskIds = ids;
    setState(runner, 'playing');
  };
  return { ws, rec, runner, statuses, logs, ctl, plan, start, env };
}

describe('host-run-relay', function () {
  this.timeout(20_000);
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) { try { disposers.pop()!(); } catch { /* ignore */ } }
    sinon.restore();
  });
  const make = (opts: Parameters<typeof harness>[0] = {}) => {
    const h = harness(opts);
    disposers.push(() => h.ctl.dispose());
    return h;
  };

  // ─── pure helpers ───

  it('hostRunFinishedCode: 4 budget-stopped, 1 failed or stopped, else 0', () => {
    assert.equal(hostRunFinishedCode({ budgetStopped: true, failed: 0, stopped: true }), 4);
    assert.equal(hostRunFinishedCode({ budgetStopped: false, failed: 2, stopped: false }), 1);
    assert.equal(hostRunFinishedCode({ budgetStopped: false, failed: 0, stopped: true }), 1);
    assert.equal(hostRunFinishedCode({ budgetStopped: false, failed: 0, stopped: false }), 0);
  });

  it('probeRelayStatus: none without a cwd or key, else on/off by the setting', () => {
    const ws = workspace();
    const env = { APPDATA: ws.configDir, XDG_CONFIG_HOME: ws.configDir, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: URL };
    assert.equal(probeRelayStatus(env, null, true, () => undefined), 'none');
    assert.equal(probeRelayStatus({ APPDATA: ws.configDir, XDG_CONFIG_HOME: ws.configDir }, ws.dir, true, () => undefined), 'none');
    assert.equal(probeRelayStatus(env, ws.dir, true, () => undefined), 'on');
    assert.equal(probeRelayStatus(env, ws.dir, false, () => undefined), 'off');
  });

  // ─── when nothing is relayed ───

  it('no key: zero http calls, the settled hook is never set, status none', async () => {
    const h = make();
    delete h.env.MOAG_ONOSOO_KEY;
    h.start();
    setState(h.runner, 'idle');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.rec.calls.length, 0);
    assert.equal(h.runner.setTaskSettledHook.called, false);
    assert.equal(h.ctl.status, 'none');
    assert.equal(h.ctl.live, false);
  });

  it('setting off: zero http calls, status off, no hook', async () => {
    const h = make({ enabled: () => false });
    h.start();
    assert.equal(h.ctl.live, false);
    setState(h.runner, 'idle');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.rec.calls.length, 0);
    assert.equal(h.ctl.status, 'off');
    assert.equal(h.runner.setTaskSettledHook.called, false);
  });

  it('no key and the setting off: status none, not off (the key is checked first)', async () => {
    const h = make({ enabled: () => false });
    delete h.env.MOAG_ONOSOO_KEY;
    h.start();
    setState(h.runner, 'idle');
    assert.equal(h.ctl.status, 'none');
    assert.deepEqual(h.statuses, ['none']);
    assert.equal(h.rec.calls.length, 0);
  });

  it('no cwd: not relayed', async () => {
    const h = make({ cwdNull: true });
    h.start();
    assert.equal(h.ctl.live, false);
    setState(h.runner, 'idle');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.rec.calls.length, 0);
    assert.equal(h.ctl.status, 'none');
  });

  // ─── parity with moag run ───

  it('parity with the CLI: the same scripted run relays the same types, data keys and statuses', async () => {
    const SECRET = 'sk-ant-api03-' + 'Z'.repeat(40);
    /** The scripted run, on whatever plan object the caller ran. */
    const script = (r: EventEmitter, plan: Plan): void => {
      const [a, b] = plan.playlists[0].tasks;
      r.emit('task-started', a);
      a.status = TaskStatus.Completed;
      r.emit('task-completed', a, { stdout: 'ok', stderr: '' });
      costLedger.record({ estimatedCost: 0.02, costSource: 'reported' }, { engineId: 'claude', label: 'task' });
      b.status = TaskStatus.Failed;
      r.emit('task-failed', b, { stdout: '', stderr: `failed with ${SECRET}` });
    };

    // The CLI.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const proxyquire = require('proxyquire').noCallThru();
    const cli = proxyquire('../../../headless/cli', {
      '../runner/evidence': { detectPrdFile: () => null, captureBaseRef: async () => null, captureHeadRef: async () => null },
      '../adapters/index': { getEngine: () => ({ runTask: async () => { throw new Error('no engine in tests'); } }) },
      '../sandbox/sandbox-manager': { SandboxManager: class {}, isPortOpen: async () => false },
      '../sandbox/project-detector': { detectProject: () => null },
    });
    const cliWs = workspace();
    const cliRec = recorder();
    const cliRunner = new EventEmitter() as EventEmitter & { stop: () => void; play: (p: Plan) => Promise<void> };
    cliRunner.stop = () => undefined;
    cliRunner.play = async (plan: Plan) => { script(cliRunner, plan); };
    const stdout = sinon.stub(process.stdout, 'write').returns(true);
    let code: number;
    try {
      code = await cli.cmdRun(cli.parseArgs(['run', cliWs.planFile, '--cwd', cliWs.dir]), {
        runner: cliRunner,
        vscode: { workspace: { getConfiguration: () => ({ get: <T>(_k: string, d: T) => d }) } },
        TaskStatus,
        loadPlan,
        relayDeps: {
          env: { APPDATA: cliWs.configDir, XDG_CONFIG_HOME: cliWs.configDir, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: URL },
          http: cliRec.http, closeDeadlineMs: 500, stderr: () => undefined,
        },
      });
    } finally {
      stdout.restore();
    }
    assert.equal(code, 1);

    // The controller.
    const h = make();
    h.start();
    script(h.runner, h.plan);
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));

    const cliSent = cliRec.sent();
    const hostSent = h.rec.sent().filter((e) => e.type !== 'state');
    const expected = ['run-meta', 'run-started', 'task-started', 'task-completed', 'cost', 'task-failed', 'task-error-tail', 'run-finished'];
    assert.deepEqual(cliSent.map((e) => e.type), expected);
    assert.deepEqual(hostSent.map((e) => e.type), expected);
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(Object.keys(hostSent[i].data).sort(), Object.keys(cliSent[i].data).sort(), expected[i]);
    }
    assert.equal(hostSent[3].data.status, 'Completed');
    assert.equal(hostSent[5].data.status, 'Failed');
    assert.equal(cliSent[3].data.status, 'Completed');
    assert.equal(cliSent[5].data.status, 'Failed');
    const finished = hostSent[7].data;
    assert.deepEqual([finished.total, finished.completed, finished.failed, finished.code, finished.manualGateHit], [2, 1, 1, 1, false]);
    // The relay copy of the plan path is cwd-relative (path scrubbing).
    assert.equal(hostSent[1].data.planPath, 'plan.json');
    assert.equal(hostSent[1].data.branch, null);
    assert.equal(hostSent[1].data.engine, 'claude');
    // No prompt text and no engine key in any body.
    for (const c of h.rec.calls) {
      assert.ok(!c.raw.includes(PROMPT));
      assert.ok(!c.raw.includes(SECRET));
    }
  });

  // ─── run boundaries ───

  it('resume (playing → paused → playing → idle) is one run: one run_id and one run-meta', async () => {
    const h = make();
    h.start();
    setState(h.runner, 'paused');
    setState(h.runner, 'playing');
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    const sent = h.rec.sent();
    assert.equal(new Set(sent.map((e) => e.run_id)).size, 1);
    assert.equal(sent.filter((e) => e.type === 'run-meta').length, 1);
    assert.deepEqual(sent.filter((e) => e.type === 'state').map((e) => e.data.state), ['playing', 'paused', 'playing', 'idle']);
  });

  it('two runs: two run_ids, each starting with run-meta at seq 1', async () => {
    const h = make();
    h.start();
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    h.start();
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().filter((e) => e.type === 'run-finished').length === 2);
    const sent = h.rec.sent();
    const runs = [...new Set(sent.map((e) => e.run_id))];
    assert.equal(runs.length, 2);
    for (const run of runs) {
      const first = sent.filter((e) => e.run_id === run).sort((a, b) => a.seq - b.seq)[0];
      assert.equal(first.type, 'run-meta');
      assert.equal(first.seq, 1);
    }
  });

  it('back-to-back runs: the second run never resends the first run while it is still closing', async () => {
    // Every POST takes 400 ms, so run A is still draining in close() when run B starts 50 ms later.
    const h = make({
      respond: async (body) => {
        await new Promise((r) => setTimeout(r, 400));
        const acked: Record<string, number> = {};
        for (const e of body.events) { acked[e.run_id] = Math.max(acked[e.run_id] ?? 0, e.seq); }
        return { status: 200, body: JSON.stringify({ acked }) };
      },
      closeDeadlineMs: 3000,
    });
    const t = h.plan.playlists[0].tasks[0];
    h.start();
    h.runner.emit('task-started', t);
    t.status = TaskStatus.Completed;
    h.runner.emit('task-completed', t, { stdout: '', stderr: '' });
    setState(h.runner, 'idle');
    await new Promise((r) => setTimeout(r, 50));
    h.start();
    setState(h.runner, 'idle');
    // Only now wait: both runs delivered, plus time for any resend to arrive.
    await waitFor(() => h.rec.sent().filter((e) => e.type === 'run-finished').length >= 2, 8000);
    await new Promise((r) => setTimeout(r, 1000));
    const sent = h.rec.sent();
    const runA = sent.find((e) => e.type === 'run-meta')!.run_id;
    const seqsA = sent.filter((e) => e.run_id === runA).map((e) => e.seq);
    assert.deepEqual(seqsA, [...new Set(seqsA)], `run A sent a seq twice: ${seqsA.join(',')}`);
    const keys = sent.map((e) => `${e.run_id}:${e.seq}`);
    assert.equal(new Set(keys).size, keys.length, 'no event of either run is sent twice');
  });

  it('a watchdog double idle produces one run-finished', async () => {
    const h = make();
    h.start();
    setState(h.runner, 'stopping');
    setState(h.runner, 'idle');
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.rec.sent().filter((e) => e.type === 'run-finished').length, 1);
  });

  // ─── exit codes ───

  const codeOf = async (drive: (h: ReturnType<typeof harness>) => void): Promise<unknown> => {
    const h = make();
    h.start();
    drive(h);
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    return h.rec.sent().find((e) => e.type === 'run-finished')!.data.code;
  };
  const completeAll = (h: ReturnType<typeof harness>): void => {
    for (const t of h.plan.playlists[0].tasks) {
      h.runner.emit('task-started', t);
      t.status = TaskStatus.Completed;
      h.runner.emit('task-completed', t, { stdout: '', stderr: '' });
    }
  };

  it('a user stop is code 1', async () => {
    assert.equal(await codeOf((h) => setState(h.runner, 'stopping')), 1);
  });

  it('a budget breach then stopping is code 4', async () => {
    assert.equal(await codeOf((h) => {
      h.runner.emit('budget-exceeded', { totalCost: 2, budget: 1 });
      setState(h.runner, 'stopping');
    }), 4);
  });

  it('a budget breach, Continue, then a clean finish is code 0', async () => {
    assert.equal(await codeOf((h) => {
      h.runner.emit('budget-exceeded', { totalCost: 2, budget: 1 });
      completeAll(h);
    }), 0);
  });

  it('a budget pause, Continue (resume), then a later Stop is code 1, not 4', async () => {
    assert.equal(await codeOf((h) => {
      h.runner.emit('budget-exceeded', { totalCost: 2, budget: 1 });
      setState(h.runner, 'paused');
      setState(h.runner, 'playing');
      setState(h.runner, 'stopping');
    }), 1);
  });

  it('a budget pause answered with Stop is still code 4', async () => {
    assert.equal(await codeOf((h) => {
      h.runner.emit('budget-exceeded', { totalCost: 2, budget: 1 });
      setState(h.runner, 'paused');
      setState(h.runner, 'stopping');
    }), 4);
  });

  it('a failed task is code 1', async () => {
    assert.equal(await codeOf((h) => {
      const t = h.plan.playlists[0].tasks[0];
      h.runner.emit('task-started', t);
      t.status = TaskStatus.Failed;
      h.runner.emit('task-failed', t, { stdout: '', stderr: '' });
    }), 1);
  });

  it('a manual gate carries the host note and never code 3', async () => {
    const h = make();
    h.start();
    h.runner.emit('manual-gate', h.plan.playlists[0].tasks[0]);
    setState(h.runner, 'stopping');
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    const sent = h.rec.sent();
    assert.equal(sent.find((e) => e.type === 'manual-gate')!.data.note, HOST_MANUAL_GATE_NOTE);
    assert.equal(sent.find((e) => e.type === 'run-finished')!.data.code, 1);
  });

  // ─── scope, cost, secrets ───

  it('playTask scope: run-meta.tasks and run-finished.total hold only the scoped task', async () => {
    const h = make();
    h.start(['t-2']);
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    const sent = h.rec.sent();
    assert.deepEqual(sent.find((e) => e.type === 'run-meta')!.data.tasks, [{ id: 't-2', name: 'Second' }]);
    assert.equal(sent.find((e) => e.type === 'run-finished')!.data.total, 1);
    assert.equal(h.plan.playlists[0].tasks.length, 2, 'the runner\'s plan is not modified');
  });

  it('a play from a later playlist: a stale Failed task in playlist 0 neither shows nor counts', async () => {
    const h = make();
    const pl1 = createPlaylist('Later');
    const t3 = createTask('Third', 'x');
    pl1.tasks.push(t3);
    h.plan.playlists.push(pl1);
    h.plan.playlists[0].tasks[0].status = TaskStatus.Failed; // left over from an earlier run
    // What TaskRunner.play(plan, 1) scopes the run to: playlists [1..end].
    h.start([t3.id]);
    h.runner.emit('task-started', t3);
    t3.status = TaskStatus.Completed;
    h.runner.emit('task-completed', t3, { stdout: '', stderr: '' });
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    const sent = h.rec.sent();
    assert.deepEqual(sent.find((e) => e.type === 'run-meta')!.data.tasks, [{ id: t3.id, name: 'Third' }]);
    const fin = sent.find((e) => e.type === 'run-finished')!.data;
    assert.deepEqual([fin.total, fin.completed, fin.failed, fin.code], [1, 1, 0, 0]);
  });

  it('cost filter: a prd-chat call gives no cost line; a task call does', async () => {
    const h = make();
    h.start();
    costLedger.record({ estimatedCost: 0.5 }, { engineId: 'claude', label: 'prd-chat' });
    costLedger.recordUnreported({ engineId: 'claude', label: 'prd-chat' });
    costLedger.record({ estimatedCost: 0.1 }, { engineId: 'claude', label: 'task' });
    setState(h.runner, 'idle');
    // After the run, no subscription is left.
    costLedger.record({ estimatedCost: 9 }, { engineId: 'claude', label: 'task' });
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    const costs = h.rec.sent().filter((e) => e.type === 'cost');
    assert.deepEqual(costs.map((c) => c.data.usd), [0.1]);
  });

  it('the device key in task-failed stderr never appears in any http body', async () => {
    const h = make();
    h.start();
    const t = h.plan.playlists[0].tasks[0];
    h.runner.emit('task-started', t);
    t.status = TaskStatus.Failed;
    h.runner.emit('task-failed', t, { stdout: '', stderr: `auth failed with ${KEY}` });
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    const tail = h.rec.sent().find((e) => e.type === 'task-error-tail');
    assert.ok(tail, 'the tail is relayed');
    assert.ok(String(tail.data.tail).includes('[REDACTED]'));
    for (const c of h.rec.calls) { assert.ok(!c.raw.includes(KEY)); }
  });

  // ─── failure paths ───

  it('401: status revoked; the next run starts again and sets on first', async () => {
    const h = make({ respond: () => ({ status: 401, body: '{"error":"unauthorized"}' }) });
    h.start();
    assert.deepEqual(h.statuses, ['on']);
    setState(h.runner, 'idle');
    await waitFor(() => h.statuses.includes('revoked'));
    assert.ok(h.logs.some((l) => l.startsWith(REVOKED_MESSAGE)));
    const before = h.statuses.length;
    h.start();
    assert.equal(h.statuses[before], 'on');
    setState(h.runner, 'idle');
  });

  it('close is not awaited: with an http that never resolves, the idle emit returns at once and live is false', () => {
    const h = make({ respond: () => new Promise<Reply>(() => undefined) });
    h.start();
    assert.equal(h.ctl.live, true);
    const t0 = Date.now();
    setState(h.runner, 'idle');
    assert.ok(Date.now() - t0 < 200);
    assert.equal(h.ctl.live, false);
  });

  it('dispose mid-run: run-finished with code 1, the hook cleared, and no listener left', async () => {
    const h = harness();
    h.start();
    assert.equal(h.runner.setTaskSettledHook.lastCall.args[0] !== null, true, 'the hook is set while live');
    h.ctl.dispose();
    assert.equal(h.runner.setTaskSettledHook.lastCall.args[0], null);
    for (const e of MAPPED_EVENTS) { assert.equal(h.runner.listenerCount(e), 0, e); }
    assert.equal(h.ctl.live, false);
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
    assert.equal(h.rec.sent().find((e) => e.type === 'run-finished')!.data.code, 1);
  });

  it('a throwing onRunRelayed does not break the run', async () => {
    const h = make({ onRunRelayed: () => { throw new Error('notice failed'); } });
    h.start();
    assert.equal(h.ctl.live, true);
    setState(h.runner, 'idle');
    await waitFor(() => h.rec.sent().some((e) => e.type === 'run-finished'));
  });

  it('onRunRelayed receives the scoped plan', () => {
    let got: Plan | null = null;
    const h = make({ onRunRelayed: (p) => { got = p; } });
    h.start(['t-1']);
    assert.ok(got);
    assert.deepEqual((got as Plan).playlists[0].tasks.map((t) => t.id), ['t-1']);
    setState(h.runner, 'idle');
  });
});
