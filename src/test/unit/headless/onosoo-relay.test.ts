// ─── ONOSOO relay — envelope, acks, spool replay, backoff, heartbeat, close ───
//
// No network: every test injects a recording HTTP client, except the two that
// exercise the default client against a loopback server this test starts.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  BACKOFF_MAX_MS, BACKOFF_START_MS, classify, CLOSE_DEADLINE_MS, defaultHttpClient, HEARTBEAT_MS, MAX_BODY_BYTES, MAX_EVENTS,
  MAX_EVENT_DATA_BYTES, MAX_MEMORY_BYTES, OnosooRelay, protocolStatus, REPLAY_MEMORY_BYTES, RelayHttpClient, RelayHttpRequest, REQUEST_TIMEOUT_MS, REVOKED_MESSAGE, RunMeta, scrubPaths,
  SPOOL_TOUCH_MS,
} from '../../../headless/onosoo-relay';
import {
  isLiveRelayRun, OnosooSpool, RelayEvent, releaseLiveRelayRun, SPOOL_OWNER_MAX_IDLE_MS,
} from '../../../headless/onosoo-spool';
import type { OnosooConfig } from '../../../headless/onosoo-config';
import { createRedactor, Redactor } from '../../../utils/redact';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = require('../../../../package.json').version;
const KEY = 'onosoo_live_' + 'K'.repeat(43);
const ENDPOINT = 'https://xyz.supabase.co/functions/v1/builds/events';
const SECRET = 'sk-ant-api03-' + 'P'.repeat(40);

type Reply = { status: number; body: string };
type Responder = (req: RelayHttpRequest, body: Envelope, n: number) => Reply | Promise<Reply>;
interface Envelope { protocol: number; device_id: string; moag_version: string; events: RelayEvent[]; heartbeat?: { active_runs: string[] } }

/** Ack every event in the body: the highest seq of each run. */
function ackAll(body: Envelope): Reply {
  const acked: Record<string, number> = {};
  for (const e of body.events) { acked[e.run_id] = Math.max(acked[e.run_id] ?? 0, e.seq); }
  return { status: 200, body: JSON.stringify({ acked }) };
}

/**
 * A server faithful to ONOSOO: stores every seq it is sent (out of order too),
 * dedupes, and acks the highest CONTIGUOUS seq per run. `received` counts how often
 * each run:seq arrived, so tests can prove nothing is resent.
 */
function onosooServer() {
  const stored = new Map<string, Set<number>>();
  const received = new Map<string, number>();
  const contiguous = (run: string): number => {
    let n = 0;
    while (stored.get(run)?.has(n + 1)) { n++; }
    return n;
  };
  const respond = (body: Envelope): Reply => {
    for (const e of body.events) {
      const k = `${e.run_id}:${e.seq}`;
      received.set(k, (received.get(k) ?? 0) + 1);
      const set = stored.get(e.run_id) ?? new Set<number>();
      set.add(e.seq);
      stored.set(e.run_id, set);
    }
    const acked: Record<string, number> = {};
    for (const run of new Set(body.events.map((e) => e.run_id))) { acked[run] = contiguous(run); }
    return { status: 200, body: JSON.stringify({ acked }) };
  };
  return { stored, received, respond, contiguous };
}

function recorder(respond?: Responder) {
  const server = onosooServer();
  const reply: Responder = respond ?? ((_r, b) => server.respond(b));
  const calls: Array<{ req: RelayHttpRequest; body: Envelope; at: number }> = [];
  const client: RelayHttpClient = async (req) => {
    const body = JSON.parse(req.body) as Envelope;
    calls.push({ req, body, at: Date.now() });
    return reply(req, body, calls.length);
  };
  return { calls, client, server };
}

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fixture() {
  const stateDir = tmp('moag-relay-state-');
  const cwd = tmp('moag-relay-ws-');
  const config: OnosooConfig = { key: KEY, baseUrl: 'https://xyz.supabase.co', endpoint: ENDPOINT, deviceId: 'dev-1', stateDir };
  const spool = (): OnosooSpool => new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
  return { stateDir, cwd, config, spool };
}

function mkRelay(client: RelayHttpClient, opts: { redactor?: Redactor; closeDeadlineMs?: number; fx?: ReturnType<typeof fixture>; cwd?: string; homedir?: string; runId?: string; heartbeat?: boolean } = {}) {
  const fx = opts.fx ?? fixture();
  const stderr: string[] = [];
  const spool = fx.spool();
  const relay = new OnosooRelay({
    config: fx.config, spool, http: client, redactor: opts.redactor ?? createRedactor([KEY]),
    stderr: (s) => stderr.push(s), closeDeadlineMs: opts.closeDeadlineMs, cwd: opts.cwd, homedir: opts.homedir, runId: opts.runId, heartbeat: opts.heartbeat,
  });
  return { relay, spool, stderr, fx };
}

const line = (event: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ts: '2026-10-11T12:00:00.000Z', event, ...extra });

/** Every file under `dir`, recursively, as text. */
function allText(dir: string): string {
  if (!fs.existsSync(dir)) { return ''; }
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? allText(p) : fs.readFileSync(p, 'utf-8');
  }
  return out;
}

/** Let microtasks and immediate callbacks run (real timers). */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) { await new Promise((r) => setImmediate(r)); }
}

describe('ONOSOO relay — constants and classify', () => {
  it('pins the limits and timings', () => {
    assert.equal(MAX_EVENTS, 100);
    assert.equal(MAX_BODY_BYTES, 262_144);
    assert.equal(REQUEST_TIMEOUT_MS, 30_000);
    assert.equal(HEARTBEAT_MS, 60_000);
    assert.equal(CLOSE_DEADLINE_MS, 20_000);
    assert.equal(BACKOFF_START_MS, 5_000);
    assert.equal(BACKOFF_MAX_MS, 300_000);
    assert.equal(MAX_EVENT_DATA_BYTES, 90_000);
  });

  it('the revoked message is exact', () => {
    assert.equal(REVOKED_MESSAGE, 'ONOSOO device key was revoked or is wrong — re-pair this machine in ONOSOO (Builds → Pair machine).');
  });

  it('classifies every response class', () => {
    assert.deepEqual(classify(200, '{"acked":{"r":4,"bad":-1,"x":"y"},"duplicates":2}'), { kind: 'ok', acked: { r: 4 } });
    assert.deepEqual(classify(200, 'not json'), { kind: 'transient', reason: 'unreadable reply' });
    assert.deepEqual(classify(202, '{}'), { kind: 'transient', reason: 'unreadable reply' });
    assert.deepEqual(classify(400, '{"code":"bad_event","error":"seq missing"}'), { kind: 'rejected', code: 'bad_event', error: 'seq missing' });
    assert.deepEqual(classify(400, ''), { kind: 'rejected', code: 'bad_request', error: '' });
    assert.deepEqual(classify(401, ''), { kind: 'revoked' });
    assert.deepEqual(classify(403, ''), { kind: 'revoked' });
    assert.deepEqual(classify(413, ''), { kind: 'too-large' });
    assert.deepEqual(classify(429, '{"retry_after":30}'), { kind: 'rate-limited', retryAfterMs: 30_000 });
    assert.deepEqual(classify(429, ''), { kind: 'rate-limited', retryAfterMs: null });
    assert.equal(classify(302, '').kind, 'transient');
    assert.equal(classify(404, '').kind, 'transient');
    assert.equal(classify(503, '').kind, 'transient');
  });
});

describe('ONOSOO relay — wire format', () => {
  afterEach(() => sinon.restore());

  it('posts the exact envelope and event keys to the endpoint with a Bearer key (AC3)', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('task-started', { id: 't1', name: 'Build' }));
    relay.record(line('task-completed', { id: 't1', name: 'Build' }));
    await settle();
    await relay.close();

    assert.ok(calls.length >= 1);
    const { req, body } = calls[0];
    assert.equal(req.url, ENDPOINT);
    assert.equal(req.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.equal(req.headers['User-Agent'], `moag/${PKG_VERSION}`);
    assert.ok(req.timeoutMs <= 30_000);
    assert.deepEqual(Object.keys(body).sort(), ['device_id', 'events', 'moag_version', 'protocol']);
    assert.equal(body.protocol, 1);
    assert.equal(body.device_id, 'dev-1');
    assert.equal(body.moag_version, PKG_VERSION);
    for (const e of body.events) { assert.deepEqual(Object.keys(e).sort(), ['at', 'data', 'run_id', 'seq', 'type']); }
    assert.deepEqual(body.events.map((e) => [e.seq, e.type, e.at]), [
      [1, 'task-started', '2026-10-11T12:00:00.000Z'],
      [2, 'task-completed', '2026-10-11T12:00:00.000Z'],
    ]);
    assert.deepEqual(body.events[0].data, { id: 't1', name: 'Build' });
    assert.equal(body.events[0].run_id, relay.runId);
  });

  it('task-completed / task-failed status goes out in ONOSOO\'s spelling; unknown values and other events are unchanged', async () => {
    assert.deepEqual(['completed', 'failed', 'skipped', 'blocked', 'running', 'Weird'].map(protocolStatus),
      ['Completed', 'Failed', 'Skipped', 'Blocked', 'running', 'Weird']);
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('task-completed', { id: 'a', name: 'A', status: 'completed' }));
    relay.record(line('task-completed', { id: 'b', name: 'B', status: 'skipped' }));
    relay.record(line('task-failed', { id: 'c', name: 'C', status: 'failed' }));
    relay.record(line('task-failed', { id: 'd', name: 'D', status: 'blocked' }));
    relay.record(line('task-failed', { id: 'e', name: 'E', status: 'mystery' }));
    relay.record(line('task-completed', { id: 'f', name: 'F' }));
    relay.record(line('state', { state: 'idle', status: 'skipped' }));
    await settle();
    await relay.close();
    const sent = calls.flatMap((c) => c.body.events);
    assert.deepEqual(sent.map((e) => e.data.status), ['Completed', 'Skipped', 'Failed', 'Blocked', 'mystery', undefined, 'skipped']);
    assert.ok(!('status' in sent[5].data), 'no status is invented');
  });

  it('never relays task-pid or task-output (AC5)', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('task-pid', { pid: 5, alive: true }));
    relay.record(line('task-output', { text: 'hi' }));
    relay.record(line('state', { state: 'playing' }));
    await settle();
    await relay.close();
    const types = calls.flatMap((c) => c.body.events.map((e) => e.type));
    assert.deepEqual(types, ['state']);
    assert.equal(calls[0].body.events[0].seq, 1, 'skipped events consume no seq');
  });

  it('250 events go out in at least 3 requests, each ≤ 100 events and ≤ 256 KB (AC6)', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    for (let i = 0; i < 250; i++) { relay.record(line('task-started', { id: `t${i}`, name: 'n' })); }
    await settle(50);
    await relay.close();
    assert.ok(calls.length >= 3, `${calls.length} requests`);
    for (const c of calls) {
      assert.ok(c.body.events.length <= 100);
      assert.ok(Buffer.byteLength(c.req.body) <= MAX_BODY_BYTES);
    }
    assert.deepEqual(calls.flatMap((c) => c.body.events.map((e) => e.seq)), Array.from({ length: 250 }, (_, i) => i + 1));
  });

  it('large events are split by the 256 KB body cap', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    for (let i = 0; i < 60; i++) { relay.record(line('warning', { message: 'w'.repeat(20_000) })); }
    await settle(50);
    await relay.close();
    assert.ok(calls.length >= 5);
    for (const c of calls) { assert.ok(Buffer.byteLength(c.req.body) <= MAX_BODY_BYTES, `${Buffer.byteLength(c.req.body)}`); }
    assert.equal(calls.reduce((n, c) => n + c.body.events.length, 0), 60);
  });

  it('an event whose data exceeds 90 KB is replaced by a dropped marker', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('task-changes', { diff: { text: 'y'.repeat(95_000) } }));
    relay.record(line('task-changes', { diff: { text: 'y'.repeat(80_000) } }));
    await settle();
    await relay.close();
    const [big, ok] = calls.flatMap((c) => c.body.events);
    assert.equal(big.data.dropped, 'event-too-large');
    assert.ok((big.data.bytes as number) > 90_000);
    assert.equal((ok.data.diff as { text: string }).text.length, 80_000);
  });

  it('an event larger than a body is replaced by a dropped marker', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('warning', { message: 'x'.repeat(300_000) }));
    await settle();
    await relay.close();
    const data = calls[0].body.events[0].data;
    assert.equal(data.dropped, 'event-too-large');
    assert.ok((data.bytes as number) > 300_000);
  });
});

describe('ONOSOO relay — acknowledgement and spool', () => {
  it('a 2xx delivers the whole batch: a lower acked value never causes a resend', async () => {
    const { calls, client } = recorder((_r, b, n) => {
      if (n === 1) { return { status: 200, body: JSON.stringify({ acked: { [b.events[0].run_id]: 40 }, duplicates: 3 }) }; }
      return ackAll(b);
    });
    const { relay, spool } = mkRelay(client);
    relay.start();
    for (let i = 0; i < 100; i++) { relay.record(line('state', { state: 'playing' })); }
    await settle(50);
    relay.record(line('state', { state: 'idle' }));
    await settle(50);
    await relay.close();
    assert.equal(calls[0].body.events.length, 100);
    assert.deepEqual(calls.slice(1).flatMap((c) => c.body.events.map((e) => e.seq)), [101], 'only the new event follows');
    assert.ok(!fs.existsSync(path.join(spool.dir, `${relay.runId}.jsonl`)), 'fully delivered: the run file is dropped');
  });

  it('spools before the first send; a new relay resends the killed run after its last delivered batch, with run_id and seq (AC8)', async () => {
    const fx = fixture();
    let spooledBeforeSend: boolean | null = null;
    const a = mkRelay(async (req) => {
      const body = JSON.parse(req.body) as Envelope;
      if (spooledBeforeSend === null) {
        const text = allText(fx.stateDir);
        spooledBeforeSend = body.events.every((e) => text.includes(`"seq":${e.seq}`));
        return ackAll(body);
      }
      return new Promise<Reply>(() => undefined); // the process is "killed" mid-request
    }, { fx });
    a.relay.start();
    for (let i = 0; i < 2; i++) { a.relay.record(line('task-started', { id: `t${i}`, name: 'n' })); }
    await settle();
    assert.equal(spooledBeforeSend, true);
    for (let i = 2; i < 5; i++) { a.relay.record(line('task-started', { id: `t${i}`, name: 'n' })); }
    await settle();
    // No close(): relay A is abandoned as a killed process would be. A killed process's
    // live-run registry dies with it; in this process it has to be cleared by hand.
    assert.equal(isLiveRelayRun(a.relay.runId), true, 'an open relay is registered as live');
    releaseLiveRelayRun(a.relay.runId);

    const b = recorder();
    const relayB = mkRelay(b.client, { fx });
    relayB.relay.start();
    await settle();
    await relayB.relay.close();
    const resent = b.calls.flatMap((c) => c.body.events).filter((e) => e.run_id === a.relay.runId);
    assert.deepEqual(resent.map((e) => e.seq), [3, 4, 5]);
    assert.deepEqual(resent.map((e) => (e.data as { id: string }).id), ['t2', 't3', 't4']);
    assert.notEqual(relayB.relay.runId, a.relay.runId);
    // Delivered now: A's files are gone.
    assert.ok(!fs.readdirSync(relayB.spool.dir).some((n) => n.startsWith(a.relay.runId) && !n.endsWith('.rejected.jsonl')));
  });

  it('a gap from a 400 never stalls the run: later events are delivered once each (faithful server)', async () => {
    const server = onosooServer();
    const { calls, client } = recorder((_r, b, n) => (n === 1
      ? { status: 400, body: JSON.stringify({ code: 'bad_event', error: 'x' }) }
      : server.respond(b)));
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('state', { state: 'playing' }));
    await settle();
    for (let i = 0; i < 30; i++) { relay.record(line('task-started', { id: `t${i}`, name: 'n' })); await settle(2); }
    await settle(30);
    await relay.close();
    // Seq 1 never reached the server, so it acks 0 forever; the relay must not care.
    assert.equal(server.contiguous(relay.runId), 0);
    for (let q = 2; q <= 31; q++) { assert.equal(server.received.get(`${relay.runId}:${q}`), 1, `seq ${q} delivered exactly once`); }
    assert.ok(calls.length <= 32, `${calls.length} requests`);
  });

  it('re-pair after a partial ack: the live run goes first, the replayed backlog drains, nothing resends forever', async () => {
    const fx = fixture();
    // A run from before the re-pair: 150 events, the OLD device's server acked 30.
    const old = fx.spool();
    old.openRun('old-run');
    for (let q = 1; q <= 150; q++) { old.append({ run_id: 'old-run', seq: q, type: 'state', at: '2026-10-10T00:00:00.000Z', data: { state: 'playing' } }); }
    old.writeAck('old-run', 30);

    const { calls, client, server } = recorder();
    const { relay, spool } = mkRelay(client, { fx });
    relay.start({ plan_name: 'p', project: 'proj', tasks: [] });
    relay.record(line('run-started'));
    await settle(50);
    await relay.close();

    const first = calls[0].body.events;
    assert.equal(first[0].run_id, relay.runId, 'the current run leads the first request');
    assert.deepEqual(first.filter((e) => e.run_id === relay.runId).map((e) => e.seq), [1, 2]);
    for (let q = 31; q <= 150; q++) { assert.equal(server.received.get(`old-run:${q}`), 1, `old seq ${q} once`); }
    assert.equal(server.received.get('old-run:30'), undefined);
    assert.equal(server.contiguous('old-run'), 0, 'the new server never saw 1..30');
    assert.ok(calls.length <= 3, `${calls.length} requests`);
    assert.ok(!fs.existsSync(path.join(spool.dir, 'old-run.jsonl')), 'the drained backlog is removed');
  });

  it('a backlog over MAX_MEMORY_BYTES replays in chunks: every event once, no gaps, memory never over the ceiling', async function () {
    this.timeout(120_000);
    const fx = fixture();
    // Three dead runs of 85 KB events, ~22 MB in all, opened a day apart (oldest is "run-c").
    const runs: Array<[string, string]> = [['run-c', '2026-10-01T00:00:00Z'], ['run-a', '2026-10-02T00:00:00Z'], ['run-b', '2026-10-03T00:00:00Z']];
    const PER_RUN = 90;
    const pad = 'x'.repeat(85_000);
    for (const [runId, startedAt] of runs) {
      const w = new OnosooSpool(fx.stateDir, fx.cwd, { isPidAlive: () => false, now: () => Date.parse(startedAt) });
      w.openRun(runId);
      for (let q = 1; q <= PER_RUN; q++) { w.append({ run_id: runId, seq: q, type: 'state', at: startedAt, data: { pad } }); }
    }
    const total = PER_RUN * runs.length;

    const server = onosooServer();
    let relayRef: OnosooRelay | null = null;
    let peak = 0;
    const order: string[] = [];
    const client: RelayHttpClient = async (req) => {
      const body = JSON.parse(req.body) as Envelope;
      const mem = (relayRef as unknown as { memBytes: number }).memBytes;
      peak = Math.max(peak, mem);
      for (const e of body.events) { if (!order.includes(e.run_id)) { order.push(e.run_id); } }
      return server.respond(body);
    };
    const { relay, spool } = mkRelay(client, { fx, closeDeadlineMs: 60_000, heartbeat: false });
    relayRef = relay;
    const loads = sinon.spy(spool, 'loadReplayable');
    relay.start();
    const delivered = (): number => runs.reduce((n, [r]) => n + server.contiguous(r), 0);
    const until = Date.now() + 90_000;
    while (delivered() < total && Date.now() < until) { await settle(5); }
    await relay.close();

    assert.ok(loads.callCount >= 2, `the backlog came in ${loads.callCount} loads`);
    for (const call of loads.getCalls()) {
      const opts = call.args[1] as { budgetBytes: number };
      assert.ok(opts.budgetBytes <= REPLAY_MEMORY_BYTES, 'every load is within the replay half of the ceiling');
    }
    assert.ok(peak <= REPLAY_MEMORY_BYTES, `replay memory peaked at ${peak} bytes`);
    for (const [runId] of runs) {
      assert.equal(server.contiguous(runId), PER_RUN, `${runId}: no gaps`);
      for (let q = 1; q <= PER_RUN; q++) { assert.equal(server.received.get(`${runId}:${q}`), 1, `${runId}:${q} delivered once`); }
    }
    assert.deepEqual(order, ['run-c', 'run-a', 'run-b'], 'oldest run first');
    assert.ok(!fs.readdirSync(spool.dir).some((n) => n.startsWith('run-')), 'every drained run file is removed');
  });

  it('replay-too-large: an event over the replay budget is skipped with one stderr line and quarantined; newer runs still go out', async function () {
    this.timeout(60_000);
    const fx = fixture();
    const big = new OnosooSpool(fx.stateDir, fx.cwd, { isPidAlive: () => false, now: () => Date.parse('2026-10-01T00:00:00Z') });
    big.openRun('big-run');
    big.append({ run_id: 'big-run', seq: 1, type: 'state', at: 'a', data: { n: 1 } });
    big.append({ run_id: 'big-run', seq: 2, type: 'state', at: 'a', data: { pad: 'x'.repeat(REPLAY_MEMORY_BYTES + 1) } });
    big.append({ run_id: 'big-run', seq: 3, type: 'state', at: 'a', data: { n: 3 } });
    const newer = new OnosooSpool(fx.stateDir, fx.cwd, { isPidAlive: () => false, now: () => Date.parse('2026-10-02T00:00:00Z') });
    newer.openRun('newer-run');
    for (let q = 1; q <= 2; q++) { newer.append({ run_id: 'newer-run', seq: q, type: 'state', at: 'b', data: { n: q } }); }

    const { calls, client, server } = recorder();
    const { relay, spool, stderr } = mkRelay(client, { fx, heartbeat: false });
    relay.start();
    await settle(30);
    await relay.close();

    const sent = calls.flatMap((c) => c.body.events).map((e) => `${e.run_id}:${e.seq}`);
    assert.deepEqual(sent, ['big-run:1', 'big-run:3', 'newer-run:1', 'newer-run:2'], 'the oversized event never goes out; nothing waits behind it');
    assert.equal(server.received.get('big-run:2'), undefined);
    const lines = stderr.filter((s) => s.includes('too large to resend'));
    assert.equal(lines.length, 1, stderr.join(''));
    assert.ok(!stderr.some((s) => s.includes('could not be read')));
    const rejected = fs.readFileSync(spool.rejectedFile('big-run'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rejected.map((r) => [r.event.seq, r.reason]), [[2, 'too_large']]);
    assert.ok(!fs.existsSync(path.join(spool.dir, 'big-run.jsonl')), 'the run is dropped once the rest is acked');
    assert.ok(!fs.existsSync(path.join(spool.dir, 'newer-run.jsonl')));
  });

  it('a run file removed by another process mid-replay drops its cursor: replay ends quietly, no warning', async function () {
    this.timeout(60_000);
    const fx = fixture();
    const w = new OnosooSpool(fx.stateDir, fx.cwd, { isPidAlive: () => false });
    w.openRun('gone-run');
    const pad = 'x'.repeat(85_000);
    // ~11 MB: more than one replay chunk (8 MiB).
    for (let q = 1; q <= 130; q++) { w.append({ run_id: 'gone-run', seq: q, type: 'state', at: 'a', data: { pad } }); }
    const file = path.join(w.dir, 'gone-run.jsonl');

    const { calls, client } = recorder((_r, body) => {
      if (fs.existsSync(file)) { fs.rmSync(file); } // another process cleaned it up
      return ackAll(body);
    });
    const { relay, spool, stderr } = mkRelay(client, { fx, heartbeat: false });
    const loads = sinon.spy(spool, 'loadReplayable');
    const internals = relay as unknown as { replayPending: boolean; replayCursors: Map<string, unknown> };
    relay.start();
    assert.equal(internals.replayPending, true, 'the first chunk did not hold the whole run');
    await settle(60);
    await relay.close();

    assert.ok(loads.callCount >= 2, 'the next chunk was asked for');
    assert.equal(internals.replayPending, false);
    assert.equal(internals.replayCursors.has('gone-run'), false, 'the stale cursor is gone');
    assert.deepEqual(stderr, [], 'no too-large / unreadable warning');
    assert.ok(calls.length > 0);
  });

  it('replay stops at half the memory ceiling, so a live run with replay at its budget stays in memory (not spool-only)', async () => {
    const fx = fixture();
    // A dead run of ~17 MB: over the whole ceiling, so a full-ceiling replay would leave no room.
    const w = new OnosooSpool(fx.stateDir, fx.cwd, { isPidAlive: () => false });
    w.openRun('old-run');
    const pad = 'x'.repeat(85_000);
    for (let q = 1; q <= 200; q++) { w.append({ run_id: 'old-run', seq: q, type: 'state', at: '2026-10-01T00:00:00Z', data: { pad } }); }
    // The server never answers: nothing drains, so memory only grows.
    const { relay } = mkRelay(async () => new Promise<Reply>(() => undefined), { fx, closeDeadlineMs: 10, heartbeat: false });
    const internals = relay as unknown as { memBytes: number; spoolOnly: boolean; queue: Array<{ ev: RelayEvent }> };
    relay.start();
    const replayed = internals.memBytes;
    assert.ok(replayed <= REPLAY_MEMORY_BYTES, `replay holds ${replayed} bytes`);
    assert.ok(replayed > REPLAY_MEMORY_BYTES - 100_000, 'replay is at its budget (within one event)');

    // ~4 MB of live events: they would have overflowed a full 16 MiB replay.
    for (let i = 0; i < 45; i++) { relay.record(line('task-started', { id: `t${i}`, name: 'y'.repeat(85_000) })); }
    assert.equal(internals.spoolOnly, false, 'the live run is not spool-only');
    const live = internals.queue.filter((q) => q.ev.run_id === relay.runId);
    assert.equal(live.length, 45, 'every live event is queued in memory');
    assert.ok(internals.memBytes <= MAX_MEMORY_BYTES);
    await relay.close();
  });

  it('a 400 quarantines the batch, marks it acked, prints one line, and sending continues', async () => {
    const { calls, client } = recorder((_r, b, n) => (n === 1
      ? { status: 400, body: JSON.stringify({ code: 'bad_event', error: 'unknown type' }) }
      : ackAll(b)));
    const { relay, spool, stderr } = mkRelay(client);
    relay.start();
    relay.record(line('error', { message: `boom ${SECRET}` }));
    await settle();
    relay.record(line('state', { state: 'idle' }));
    await settle();
    await relay.close();
    assert.deepEqual(stderr, ['ONOSOO rejected a batch (bad_event): unknown type\n']);
    assert.deepEqual(calls.map((c) => c.body.events.map((e) => e.seq)), [[1], [2]], 'the rejected seq is never resent');
    const rejected = fs.readFileSync(spool.rejectedFile(relay.runId), 'utf-8');
    assert.ok(rejected.includes('"seq":1'));
    assert.ok(!rejected.includes(SECRET));
    assert.equal(spool.readAck(relay.runId), 0, 'the run is fully acked, so its ack file was dropped at close');
    assert.ok(!fs.existsSync(path.join(spool.dir, `${relay.runId}.jsonl`)));
  });

  it('a planted secret never reaches the spool or a request body', async () => {
    const { calls, client } = recorder(() => ({ status: 500, body: '' }));
    const { relay, fx } = mkRelay(client, { closeDeadlineMs: 50 });
    relay.start({ plan_name: `plan ${SECRET}`, project: 'p', tasks: [{ id: 't', name: SECRET }] });
    relay.record(line('task-error-tail', { id: 't', tail: `Authorization failed with ${SECRET}` }));
    relay.record(line('task-changes', { diff: { text: `+key=${SECRET}`, nested: [SECRET] } }));
    await settle();
    await relay.close();
    assert.ok(calls.length >= 1);
    for (const c of calls) { assert.ok(!c.req.body.includes(SECRET)); }
    assert.ok(!allText(fx.stateDir).includes(SECRET));
    assert.ok(allText(fx.stateDir).includes('[REDACTED]'));
  });

  it('a redactor that throws sends { redaction_failed: true } instead of the data', async () => {
    const { calls, client } = recorder();
    const throwing: Redactor = { redact: () => { throw new Error('nope'); } };
    const { relay, fx } = mkRelay(client, { redactor: throwing });
    relay.start();
    relay.record(line('task-error-tail', { id: 't', tail: SECRET }));
    await settle();
    await relay.close();
    assert.deepEqual(calls[0].body.events[0].data, { redaction_failed: true });
    assert.ok(!allText(fx.stateDir).includes(SECRET));
  });

  it('replayed task-completed / task-failed lines an older MOAG spooled in lowercase go out in ONOSOO\'s spelling', async () => {
    const fx = fixture();
    const old = fx.spool();
    old.openRun('old-run');
    old.append({ run_id: 'old-run', seq: 1, type: 'task-completed', at: 'a', data: { id: 't-1', status: 'completed' } });
    old.append({ run_id: 'old-run', seq: 2, type: 'task-completed', at: 'a', data: { id: 't-2', status: 'skipped' } });
    old.append({ run_id: 'old-run', seq: 3, type: 'task-failed', at: 'a', data: { id: 't-3', status: 'blocked' } });
    old.append({ run_id: 'old-run', seq: 4, type: 'task-failed', at: 'a', data: { id: 't-4', status: 'Failed' } });
    // Not a task outcome: a "status" field elsewhere is left alone.
    old.append({ run_id: 'old-run', seq: 5, type: 'state', at: 'a', data: { status: 'completed' } });

    const { calls, client } = recorder();
    const { relay } = mkRelay(client, { fx, heartbeat: false });
    relay.start();
    relay.record(line('task-completed', { id: 'live', status: 'completed' }));
    await settle();
    await relay.close();

    const sent = calls.flatMap((c) => c.body.events);
    const old5 = sent.filter((e) => e.run_id === 'old-run').map((e) => [e.seq, e.data.status]);
    assert.deepEqual(old5, [[1, 'Completed'], [2, 'Skipped'], [3, 'Blocked'], [4, 'Failed'], [5, 'completed']]);
    const live = sent.filter((e) => e.run_id === relay.runId && e.type === 'task-completed');
    assert.deepEqual(live.map((e) => e.data.status), ['Completed'], 'a live event is mapped once, as before');
  });

  it('a live run\'s own spooled outcome is already mapped, and a later replay of it sends the same spelling', async () => {
    const fx = fixture();
    const first = mkRelay(async () => ({ status: 500, body: '' }), { fx, heartbeat: false, closeDeadlineMs: 20 });
    first.relay.start();
    first.relay.record(line('task-failed', { id: 't', status: 'blocked' }));
    await settle();
    await first.relay.close();
    const spooled = fs.readFileSync(path.join(first.spool.dir, `${first.relay.runId}.jsonl`), 'utf-8');
    assert.ok(spooled.includes('"status":"Blocked"') && !spooled.includes('"status":"blocked"'));

    const { calls, client } = recorder();
    const second = mkRelay(client, { fx, heartbeat: false });
    second.relay.start();
    await settle();
    await second.relay.close();
    const replayed = calls.flatMap((c) => c.body.events).filter((e) => e.run_id === first.relay.runId && e.type === 'task-failed');
    assert.deepEqual(replayed.map((e) => e.data.status), ['Blocked']);
  });

  it('an oversized spooled event met again after a restart is quarantined once, not twice', async function () {
    this.timeout(60_000);
    const fx = fixture();
    const big = fx.spool();
    big.openRun('big-run');
    big.append({ run_id: 'big-run', seq: 1, type: 'state', at: 'a', data: { pad: 'x'.repeat(REPLAY_MEMORY_BYTES + 1) } });
    big.append({ run_id: 'big-run', seq: 2, type: 'state', at: 'a', data: { n: 2 } });

    // The server is down both times, so big-run is never acked and never dropped.
    for (let i = 0; i < 2; i++) {
      const { relay } = mkRelay(async () => ({ status: 500, body: '' }), { fx, heartbeat: false, closeDeadlineMs: 20 });
      relay.start();
      await settle();
      await relay.close();
    }
    const rejected = fs.readFileSync(fx.spool().rejectedFile('big-run'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rejected.map((r) => [r.event.seq, r.reason]), [[1, 'too_large']]);
  });
});

describe('ONOSOO relay — absolute paths are scrubbed from the relay copy', () => {
  it('scrubPaths: inside cwd → relative, outside → basename, prefixes in text → . and ~', () => {
    const cwd = '/home/al/proj';
    const home = '/home/al';
    assert.equal(scrubPaths('/home/al/proj/plans/plan.json', cwd, home), 'plans/plan.json');
    assert.equal(scrubPaths('/home/al/proj', cwd, home), '.');
    assert.equal(scrubPaths('/etc/secrets/other.json', cwd, home), 'other.json');
    assert.equal(scrubPaths('cannot open /home/al/.npmrc: denied', cwd, home), 'cannot open ~/.npmrc: denied');
    assert.equal(scrubPaths('failed in /home/al/proj/src/a.ts line 3', cwd, home), 'failed in ./src/a.ts line 3');
    assert.equal(scrubPaths('/usr/bin/git exited 1', cwd, home), '/usr/bin/git exited 1', 'a message that starts with a path is text');
    assert.equal(scrubPaths('/home/alice/x and more', cwd, home), '/home/alice/x and more', 'only at a path boundary');
    assert.equal(scrubPaths('relative/path.ts', cwd, home), 'relative/path.ts');
  });

  it('scrubPaths: another account\'s home (the remote runner) becomes ~ too', () => {
    const out = scrubPaths('cache at /home/moag-runner/.cache/x failed; see /home/me/log', '/home/moag-runner/.moag-remote/worktrees/r1', '/home/me', ['/home/moag-runner']);
    assert.equal(out, 'cache at ~/.cache/x failed; see ~/log');
    assert.equal(scrubPaths('/home/moag-runner/.moag-remote/worktrees/r1/src/a.ts', '/home/moag-runner/.moag-remote/worktrees/r1', null, ['/home/moag-runner']), 'src/a.ts');
  });

  it('scrubPaths: Windows paths, case-insensitively, and UNC shares', () => {
    const cwd = 'D:\\Work\\Proj';
    const home = 'C:\\Users\\al';
    assert.equal(scrubPaths('d:\\work\\proj\\src\\x.ts', cwd, home), 'src/x.ts');
    assert.equal(scrubPaths('C:\\Program Files\\tool\\t.exe', cwd, home), 't.exe');
    assert.equal(scrubPaths('\\\\server\\share\\f.txt', cwd, home), 'f.txt');
    assert.equal(scrubPaths('read C:\\Users\\al\\.ssh\\id failed', cwd, home), 'read ~\\.ssh\\id failed');
    assert.equal(scrubPaths('in D:/Work/Proj/src now', cwd, home), 'in ./src now');
  });

  it('a run-started planPath under cwd arrives relative; an outside path arrives as its basename; home becomes ~', async () => {
    const { calls, client } = recorder();
    const cwd = tmp('moag-relay-cwd-');
    const home = tmp('moag-relay-home-');
    const outside = path.join(tmp('moag-relay-out-'), 'report.json');
    const { relay } = mkRelay(client, { cwd, homedir: home });
    relay.start({ plan_name: 'p', project: cwd, tasks: [] });
    relay.record(line('run-started', { plan: 'p', planPath: path.join(cwd, 'plans', 'plan.json') }));
    relay.record(line('verify-finished', { reportPath: outside }));
    relay.record(line('error', { message: `could not read ${path.join(home, '.npmrc')} (EACCES)` }));
    await settle();
    await relay.close();
    const sent = calls.flatMap((c) => c.body.events);
    assert.equal(sent[0].data.project, path.basename(cwd));
    assert.equal(sent[1].data.planPath, 'plans/plan.json');
    assert.equal(sent[2].data.reportPath, 'report.json');
    assert.equal(sent[3].data.message, `could not read ~${path.sep}.npmrc (EACCES)`);
    for (const c of calls) {
      assert.ok(!c.req.body.includes(JSON.stringify(cwd).slice(1, -1)), 'no absolute cwd in any body');
      assert.ok(!c.req.body.includes(JSON.stringify(home).slice(1, -1)), 'no home dir in any body');
    }
  });
});

describe('ONOSOO relay — run-meta', () => {
  it('is seq 1, first in the first request, carries no absolute path, and caps tasks at 1000', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    const abs = path.join(os.tmpdir(), 'some', 'my-project');
    const meta: RunMeta = {
      plan_name: 'Nightly '.repeat(50),
      project: abs,
      tasks: Array.from({ length: 1200 }, (_, i) => ({ id: `t-${i}`, name: `Task ${i}` })),
    };
    relay.start(meta);
    relay.record(line('run-started', { plan: 'Nightly' }));
    await settle();
    await relay.close();
    const first = calls[0].body.events[0];
    assert.equal(first.type, 'run-meta');
    assert.equal(first.seq, 1);
    assert.equal((first.data.plan_name as string).length, 200);
    assert.equal(first.data.project, 'my-project');
    assert.equal((first.data.tasks as unknown[]).length, 1000);
    assert.equal(first.data.tasks_truncated, true);
    assert.ok(!calls[0].req.body.includes(abs));
    assert.equal(calls[0].body.events[1].seq, 2);
  });

  it('drops tasks from the end when the event would not fit one body', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start({ plan_name: 'p', project: 'proj', tasks: Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`.padEnd(100, 'x'), name: 'n'.repeat(400) })) });
    await settle();
    await relay.close();
    const first = calls[0].body.events[0];
    const tasks = first.data.tasks as Array<{ name: string }>;
    assert.ok(tasks.length > 0 && tasks.length < 1000);
    assert.equal(tasks[0].name.length, 200);
    assert.equal(first.data.tasks_truncated, true);
    assert.ok(Buffer.byteLength(calls[0].req.body) <= MAX_BODY_BYTES);
  });

  it('without meta there is no run-meta and the first line is seq 1', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('run-started'));
    await settle();
    await relay.close();
    assert.deepEqual(calls[0].body.events.map((e) => [e.seq, e.type]), [[1, 'run-started']]);
  });
});

describe('ONOSOO relay — daemon options (injected run id, branch, heartbeat off)', () => {
  it('an injected run id is on every event and every spool line', async () => {
    const { calls, client } = recorder(() => ({ status: 500, body: '' }));
    const { relay, spool } = mkRelay(client, { runId: 'run-abc_123', closeDeadlineMs: 50 });
    assert.equal(relay.runId, 'run-abc_123');
    relay.start({ plan_name: 'p', project: 'proj', tasks: [] });
    relay.record(line('run-started'));
    relay.record(line('state', { state: 'playing' }));
    await settle();
    await relay.close();
    assert.ok(calls.flatMap((c) => c.body.events).every((e) => e.run_id === 'run-abc_123'));
    const spooled = fs.readFileSync(path.join(spool.dir, 'run-abc_123.jsonl'), 'utf-8').trim().split('\n').slice(1).map((l) => JSON.parse(l));
    assert.equal(spooled.length, 3);
    assert.ok(spooled.every((e: RelayEvent) => e.run_id === 'run-abc_123'));
  });

  for (const bad of ['../escape', '', 'x'.repeat(129), 'has space']) {
    it(`an unsafe injected id (${JSON.stringify(bad).slice(0, 20)}) falls back to a random one`, () => {
      const { relay } = mkRelay(recorder().client, { runId: bad });
      assert.notEqual(relay.runId, bad);
      assert.match(relay.runId, /^[0-9a-f-]{36}$/);
    });
  }

  it('run-meta carries the branch (redacted, capped at 255); no branch key when null', async () => {
    const { calls, client } = recorder();
    const { relay } = mkRelay(client);
    relay.start({ plan_name: 'p', project: 'proj', tasks: [], branch: 'moag/' + 'b'.repeat(300) });
    await settle();
    await relay.close();
    assert.equal((calls[0].body.events[0].data.branch as string).length, 255);

    const other = recorder();
    const r2 = mkRelay(other.client);
    r2.relay.start({ plan_name: 'p', project: 'proj', tasks: [], branch: null });
    await settle();
    await r2.relay.close();
    assert.ok(!('branch' in other.calls[0].body.events[0].data));
  });

  describe('heartbeat: false', () => {
    let clock: sinon.SinonFakeTimers;
    beforeEach(() => { clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
    afterEach(() => { clock.restore(); });

    it('sends no heartbeat body, ever', async () => {
      const { calls, client } = recorder();
      const { relay } = mkRelay(client, { heartbeat: false });
      relay.start();
      await clock.tickAsync(10 * HEARTBEAT_MS);
      relay.record(line('state', { state: 'idle' }));
      await clock.tickAsync(10 * HEARTBEAT_MS);
      assert.ok(calls.length >= 1);
      assert.ok(calls.every((c) => c.body.heartbeat === undefined));
      const closing = relay.close();
      await clock.tickAsync(CLOSE_DEADLINE_MS);
      await closing;
    });
  });
});

describe('ONOSOO relay — failure handling (fake timers)', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { clock.restore(); });

  it('sends exactly one heartbeat after 60 s of quiet, consuming no seq; none after close (AC10)', async () => {
    const { calls, client } = recorder();
    const { relay, fx } = mkRelay(client);
    relay.start();
    await clock.tickAsync(HEARTBEAT_MS - 1);
    assert.equal(calls.length, 0);
    await clock.tickAsync(1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.events, []);
    assert.deepEqual(calls[0].body.heartbeat, { active_runs: [relay.runId] });
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['device_id', 'events', 'heartbeat', 'moag_version', 'protocol']);
    assert.ok(!allText(fx.stateDir).includes('heartbeat'), 'a heartbeat is never spooled');
    relay.record(line('state', { state: 'idle' }));
    await clock.tickAsync(0);
    assert.equal(calls[1].body.events[0].seq, 1);
    const closing = relay.close();
    await clock.tickAsync(0);
    await closing;
    const n = calls.length;
    await clock.tickAsync(10 * HEARTBEAT_MS);
    assert.equal(calls.length, n);
  });

  it('a quiet live run keeps its spool file fresh (touched with each heartbeat), so it is never taken for a dead run', async () => {
    const { client } = recorder();
    const { relay, spool } = mkRelay(client);
    relay.start();
    const file = path.join(spool.dir, `${relay.runId}.jsonl`);
    const size = fs.statSync(file).size;
    // Three hours of quiet (fake clock): only heartbeats go out, nothing is appended.
    for (let i = 0; i < 180; i++) {
      await clock.tickAsync(HEARTBEAT_MS);
      // The touch uses the relay's clock: the mtime follows it, never more than two heartbeats behind.
      const lag = Date.now() - fs.statSync(file).mtimeMs;
      assert.ok(lag >= -1000 && lag <= 2 * HEARTBEAT_MS, `after ${i + 1} min the file was ${lag} ms stale`);
    }
    assert.equal(fs.statSync(file).size, size, 'touched, not written');
    const closing = relay.close();
    await clock.tickAsync(0);
    await closing;
  });

  it('the spool file is touched every 30 s (halves the stale window after a sleep/resume off Linux)', async () => {
    assert.equal(SPOOL_TOUCH_MS, 30_000);
    const { client } = recorder();
    const { relay, spool } = mkRelay(client, { heartbeat: false });
    relay.start();
    const file = path.join(spool.dir, `${relay.runId}.jsonl`);
    const touches = sinon.spy(spool, 'touchRun');
    await clock.tickAsync(SPOOL_TOUCH_MS - 1);
    assert.equal(touches.callCount, 0);
    await clock.tickAsync(1);
    assert.equal(touches.callCount, 1);
    assert.ok(Math.abs(Date.now() - fs.statSync(file).mtimeMs) < 1000, 'the mtime is now');
    await clock.tickAsync(4 * SPOOL_TOUCH_MS);
    assert.equal(touches.callCount, 5);
    const closing = relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await closing;
  });

  it('5xx backs off 5, 10, 20 … capped at 300 s, printing one line per kind', async () => {
    const { calls, client } = recorder(() => ({ status: 503, body: '' }));
    const { relay, stderr } = mkRelay(client);
    relay.start();
    relay.record(line('state', { state: 'playing' }));
    await clock.tickAsync(0);
    for (let i = 0; i < 8; i++) { await clock.tickAsync(BACKOFF_MAX_MS); }
    const sends = calls.filter((c) => c.body.events.length > 0);
    const gaps = sends.slice(1).map((c, i) => c.at - sends[i].at);
    assert.deepEqual(gaps.slice(0, 7), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
    assert.ok(gaps.every((g) => g <= BACKOFF_MAX_MS));
    assert.equal(stderr.length, 1);
    const closing = relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await closing;
  });

  it('429 honours retry_after, caps it at 300 s, falls back to the current backoff, and does not grow it', async () => {
    const replies: Reply[] = [
      { status: 429, body: JSON.stringify({ retry_after: 30 }) },
      { status: 429, body: JSON.stringify({ retry_after: 9999 }) },
      { status: 429, body: '' },
      { status: 500, body: '' },
    ];
    const { calls, client } = recorder((_r, b, n) => replies[n - 1] ?? ackAll(b));
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('state', { state: 'playing' }));
    await clock.tickAsync(0);
    assert.equal(calls.length, 1);
    await clock.tickAsync(29_999);
    assert.equal(calls.length, 1);
    await clock.tickAsync(1);
    assert.equal(calls.length, 2);
    await clock.tickAsync(BACKOFF_MAX_MS - 1);
    assert.equal(calls.length, 2, '9999 s is capped at 300 s');
    await clock.tickAsync(1);
    assert.equal(calls.length, 3);
    await clock.tickAsync(BACKOFF_START_MS);
    assert.equal(calls.length, 4, 'missing retry_after waits the current backoff');
    await clock.tickAsync(BACKOFF_START_MS);
    assert.equal(calls.length, 5, 'a 500 after 429s waits 5 s: the backoff did not grow');
    const closing = relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await closing;
  });

  it('a 5xx backoff still heartbeats at least every 60 s; a 429 window does not', async () => {
    const { calls, client } = recorder(() => ({ status: 500, body: '' }));
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('state', { state: 'playing' }));
    await clock.tickAsync(0);
    await clock.tickAsync(30 * 60_000);
    const beats = calls.filter((c) => c.body.heartbeat !== undefined);
    assert.ok(beats.length >= 10, `${beats.length} heartbeats in 30 min`);
    const all = calls.map((c) => c.at);
    assert.ok(all.slice(1).every((t, i) => t - all[i] <= HEARTBEAT_MS), 'never 60 s without a request');
    const closing = relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await closing;

    const limited = recorder(() => ({ status: 429, body: JSON.stringify({ retry_after: 290 }) }));
    const r2 = mkRelay(limited.client);
    r2.relay.start();
    r2.relay.record(line('state', { state: 'playing' }));
    await clock.tickAsync(0);
    await clock.tickAsync(280_000);
    assert.equal(limited.calls.length, 1, 'no heartbeat inside the 429 window');
    const c2 = r2.relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await c2;
  });

  for (const status of [401, 403]) {
    it(`${status}: no further request or heartbeat for the rest of the run, one exact stderr line, spool kept`, async () => {
      const { calls, client } = recorder(() => ({ status, body: '' }));
      const { relay, spool, stderr } = mkRelay(client);
      relay.start();
      relay.record(line('state', { state: 'playing' }));
      await clock.tickAsync(0);
      assert.equal(calls.length, 1);
      relay.record(line('state', { state: 'idle' }));
      await clock.tickAsync(10 * HEARTBEAT_MS);
      const closing = relay.close();
      await clock.tickAsync(CLOSE_DEADLINE_MS);
      await closing;
      assert.equal(calls.length, 1);
      assert.deepEqual(stderr, [`${REVOKED_MESSAGE}\n`]);
      assert.ok(fs.existsSync(path.join(spool.dir, `${relay.runId}.jsonl`)), 'events stay on disk');
    });
  }

  it('after a 401 the relay keeps touching its spool file, so another loader still sees a live owner after 15 min of quiet', async () => {
    const { calls, client } = recorder(() => ({ status: 401, body: '' }));
    const { relay, spool, fx } = mkRelay(client);
    relay.start();
    relay.record(line('state', { state: 'playing' }));
    await clock.tickAsync(0);
    assert.equal(calls.length, 1, 'the 401 disabled the relay');
    const file = path.join(spool.dir, `${relay.runId}.jsonl`);
    for (let i = 0; i < 15; i++) { await clock.tickAsync(60_000); }
    assert.equal(calls.length, 1, 'still nothing sent');
    const age = Date.now() - fs.statSync(file).mtimeMs;
    assert.ok(age >= 0 && age < SPOOL_OWNER_MAX_IDLE_MS, `the file is ${age} ms old`);

    // Another process's loader: the meta pid is "someone else" and alive. Keep the mtime.
    const mtime = fs.statSync(file).mtime;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const meta = JSON.parse(lines[0]);
    meta.meta.pid = 999_999;
    lines[0] = JSON.stringify(meta);
    fs.writeFileSync(file, lines.join('\n'));
    fs.utimesSync(file, mtime, mtime);
    const other = new OnosooSpool(fx.stateDir, fx.cwd, { isPidAlive: () => true, platform: 'win32' });
    assert.deepEqual(other.loadReplayable(null), [], 'owned: not replayed');

    const closing = relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await closing;
    // Closed: no more touches.
    const closedAt = fs.statSync(file).mtimeMs;
    await clock.tickAsync(5 * 60_000);
    assert.equal(fs.statSync(file).mtimeMs, closedAt);
  });

  it('a heartbeat answered 401 disables the relay too', async () => {
    const { calls, client } = recorder(() => ({ status: 401, body: '' }));
    const { relay, stderr } = mkRelay(client);
    relay.start();
    await clock.tickAsync(HEARTBEAT_MS);
    assert.equal(calls.length, 1);
    relay.record(line('state', { state: 'idle' }));
    await clock.tickAsync(5 * HEARTBEAT_MS);
    assert.equal(calls.length, 1);
    assert.deepEqual(stderr, [`${REVOKED_MESSAGE}\n`]);
    await relay.close();
  });

  it('413 halves the batch (100 → 50 → 25), restores 100 after a 2xx; a single-event 413 is quarantined', async () => {
    const { calls, client } = recorder((_r, b) => (b.events.length > 25 ? { status: 413, body: '' } : ackAll(b)));
    const { relay } = mkRelay(client);
    relay.start();
    for (let i = 0; i < 100; i++) { relay.record(line('state', { state: 'playing' })); }
    await clock.tickAsync(0);
    assert.deepEqual(calls.slice(0, 4).map((c) => c.body.events.length), [100, 50, 25, 75]);
    const closing = relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await closing;

    const single = recorder((_r, b) => (b.events.length >= 1 && b.events[0].seq === 1 ? { status: 413, body: '' } : ackAll(b)));
    const s = mkRelay(single.client);
    s.relay.start();
    s.relay.record(line('warning', { message: 'big' }));
    await clock.tickAsync(0);
    s.relay.record(line('state', { state: 'idle' }));
    await clock.tickAsync(0);
    assert.deepEqual(single.calls.map((c) => c.body.events.map((e) => e.seq)), [[1], [2]]);
    assert.ok(fs.readFileSync(s.spool.rejectedFile(s.relay.runId), 'utf-8').includes('"too_large"'));
    assert.deepEqual(s.stderr, ['ONOSOO rejected a batch (too_large): a single event was too large\n']);
    const c2 = s.relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await c2;
  });

  it('a 2xx that acknowledges nothing still counts as delivered: no resend, no backoff', async () => {
    const { calls, client } = recorder(() => ({ status: 200, body: JSON.stringify({ acked: {} }) }));
    const { relay } = mkRelay(client);
    relay.start();
    relay.record(line('state', { state: 'playing' }));
    await clock.tickAsync(0);
    assert.equal(calls.length, 1);
    await clock.tickAsync(BACKOFF_START_MS * 4);
    assert.equal(calls.filter((c) => c.body.events.length > 0).length, 1);
    const closing = relay.close();
    await clock.tickAsync(CLOSE_DEADLINE_MS);
    await closing;
  });
});

describe('ONOSOO relay — close is bounded and never rejects (AC9)', () => {
  const clients: Array<[string, RelayHttpClient]> = [
    ['throwing', async () => { throw new Error('ECONNREFUSED'); }],
    ['synchronously throwing', (() => { throw new Error('sync'); }) as unknown as RelayHttpClient],
    ['hanging', () => new Promise(() => undefined)],
    ['500', async () => ({ status: 500, body: 'oops' })],
  ];
  for (const [label, client] of clients) {
    it(`${label} client: record never throws, close resolves within the deadline`, async () => {
      const { relay, stderr } = mkRelay(client, { closeDeadlineMs: 50 });
      relay.start();
      for (let i = 0; i < 5; i++) { assert.doesNotThrow(() => relay.record(line('state', { state: 'playing' }))); }
      await settle();
      const t0 = Date.now();
      await relay.close();
      assert.ok(Date.now() - t0 < 1000, `close took ${Date.now() - t0} ms`);
      assert.ok(stderr.length <= 2);
      assert.doesNotThrow(() => relay.record(line('state', { state: 'idle' })));
    });
  }

  it('close() keeps the events of an unsent run on disk', async () => {
    const { relay, spool } = mkRelay(async () => ({ status: 500, body: '' }), { closeDeadlineMs: 50 });
    relay.start();
    relay.record(line('state', { state: 'playing' }));
    await settle();
    await relay.close();
    assert.ok(fs.existsSync(path.join(spool.dir, `${relay.runId}.jsonl`)));
  });
});

describe('ONOSOO relay — default HTTP client (loopback only)', () => {
  let server: http.Server;
  let port = 0;
  let mode: 'redirect' | 'ok' | 'hang' = 'ok';
  let hits = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      hits++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (mode === 'redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${port}/elsewhere` }); res.end(); return; }
        if (mode === 'hang') { return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echoed: JSON.parse(body), auth: req.headers.authorization }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  after(() => { server.closeAllConnections?.(); server.close(); });

  it('POSTs the body and returns status and text', async () => {
    mode = 'ok';
    const res = await defaultHttpClient({
      url: `http://127.0.0.1:${port}/functions/v1/builds/events`, headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      body: '{"a":1}', signal: new AbortController().signal, timeoutMs: 5000,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { echoed: { a: 1 }, auth: 'Bearer k' });
  });

  it('does not follow a 302', async () => {
    mode = 'redirect';
    hits = 0;
    const res = await defaultHttpClient({
      url: `http://127.0.0.1:${port}/x`, headers: {}, body: '{}', signal: new AbortController().signal, timeoutMs: 5000,
    });
    assert.equal(res.status, 302);
    assert.equal(hits, 1);
    assert.equal(classify(res.status, res.body).kind, 'transient');
  });

  it('rejects when aborted', async () => {
    mode = 'hang';
    const ac = new AbortController();
    const p = defaultHttpClient({ url: `http://127.0.0.1:${port}/x`, headers: {}, body: '{}', signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p);
  });
});
