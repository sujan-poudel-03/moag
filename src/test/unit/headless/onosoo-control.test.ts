// ─── ONOSOO control client ───

import { strict as assert } from 'assert';
import { OnosooControl, validateCommand, DAEMON_COMMAND_KINDS } from '../../../headless/onosoo-control';
import type { OnosooConfig } from '../../../headless/onosoo-config';
import { BACKOFF_MAX_MS, BACKOFF_START_MS, RelayHttpRequest, REVOKED_MESSAGE } from '../../../headless/onosoo-relay';

const KEY = 'onosoo_live_' + 'C'.repeat(43);
const CONFIG: OnosooConfig = {
  key: KEY, baseUrl: 'https://xyz.supabase.co', endpoint: 'https://xyz.supabase.co/functions/v1/builds/events',
  deviceId: 'dev-1', stateDir: '/unused',
};

type Reply = { status: number; body: string } | Error;

function client(replies: Reply[] | ((req: RelayHttpRequest) => Reply)) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const stderr: string[] = [];
  let i = 0;
  const control = new OnosooControl({
    config: CONFIG,
    stderr: (s) => stderr.push(s),
    http: async (req) => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(req.body) });
      const r = typeof replies === 'function' ? replies(req) : replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) { throw r; }
      return r;
    },
  });
  return { control, calls, stderr };
}

const ok = (o: unknown): Reply => ({ status: 200, body: JSON.stringify(o) });
const cmd = (over: Record<string, unknown> = {}) => ({ id: 'c0ffee00-1111-2222-3333-444455556666', kind: 'stop', payload: { run_id: 'r1' }, requested_by: 'Ana', created_at: '2026-10-11T00:00:00Z', ...over });

describe('ONOSOO control — poll', () => {
  it('POSTs the kinds to builds/commands/poll with the bearer key', async () => {
    const { control, calls } = client([ok({ commands: [] })]);
    assert.deepEqual(await control.poll(), []);
    assert.equal(calls[0].url, 'https://xyz.supabase.co/functions/v1/builds/commands/poll');
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(calls[0].body, { kinds: ['stop', 'retry', 'approve', 'skip', 'start-run'] });
    assert.deepEqual([...DAEMON_COMMAND_KINDS], ['stop', 'retry', 'approve', 'skip', 'start-run']);
  });

  it('a base URL with a path keeps it', async () => {
    const control = new OnosooControl({
      config: { ...CONFIG, endpoint: 'http://127.0.0.1:54321/sub/functions/v1/builds/events' },
      http: async (req) => { assert.equal(req.url, 'http://127.0.0.1:54321/sub/functions/v1/builds/commands/poll'); return ok({ commands: [] }) as { status: number; body: string }; },
    });
    assert.deepEqual(await control.poll(), []);
  });

  it('returns valid commands, flags malformed ones that have an id, drops the rest', async () => {
    const { control } = client([ok({ commands: [
      cmd(),
      cmd({ id: 'aaaa', kind: '' }),
      cmd({ id: 'bbbb', payload: 'x' }),
      cmd({ id: 'cccc', requested_by: 5 }),
      cmd({ id: 'bad id!' }),
      'nonsense',
    ] })]);
    const out = await control.poll();
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], cmd());
    assert.ok('invalid' in out[1] && out[1].id === 'aaaa');
    assert.ok('invalid' in out[2] && out[2].id === 'bbbb');
    assert.ok('invalid' in out[3] && out[3].id === 'cccc');
  });

  it('401 and 403 stop everything with the revoked message, printed once', async () => {
    for (const status of [401, 403]) {
      const { control, calls, stderr } = client([{ status, body: '' }]);
      assert.equal(await control.poll(), 'stop');
      assert.equal(await control.poll(), 'stop');
      assert.equal(await control.postResult('abcd', { status: 'failed', message: 'x' }), 'revoked');
      assert.equal(await control.sendCapabilities({ remote_start: false, projects: [], engines: [] }), false);
      assert.equal(calls.length, 1, 'nothing is sent after a revocation');
      assert.deepEqual(stderr, [`${REVOKED_MESSAGE}\n`]);
      assert.equal(control.revoked, true);
    }
  });

  it('429 waits retry_after (capped at 5 min); without one, the current backoff', async () => {
    const { control } = client([{ status: 429, body: '{"retry_after":30}' }, { status: 429, body: '{"retry_after":99999}' }, { status: 429, body: '' }]);
    assert.deepEqual(await control.poll(), { waitMs: 30_000 });
    assert.deepEqual(await control.poll(), { waitMs: BACKOFF_MAX_MS });
    assert.deepEqual(await control.poll(), { waitMs: BACKOFF_START_MS });
  });

  it('5xx and network failures back off 5 s doubling to 5 min; a 2xx resets it', async () => {
    const replies: Reply[] = [...Array.from({ length: 8 }, () => ({ status: 503, body: '' })), ok({ commands: [] }), new Error('ECONNRESET')];
    const { control, stderr } = client(replies);
    const waits: number[] = [];
    for (let k = 0; k < 8; k++) { waits.push(((await control.poll()) as { waitMs: number }).waitMs); }
    assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    assert.deepEqual(await control.poll(), []);
    assert.deepEqual(await control.poll(), { waitMs: 5_000 }, 'reset after the 2xx');
    assert.equal(stderr.length, 2, 'one line per kind of failure');
  });

  it('an unreadable 2xx is transient', async () => {
    const { control } = client([{ status: 200, body: 'nope' }]);
    assert.deepEqual(await control.poll(), { waitMs: 5_000 });
  });

  it('400 on poll is logged once and polling stops', async () => {
    const { control, calls, stderr } = client([{ status: 400, body: '{"code":"bad_request"}' }]);
    assert.equal(await control.poll(), 'stop');
    assert.equal(await control.poll(), 'stop');
    assert.equal(calls.length, 1);
    assert.equal(stderr.length, 1);
  });
});

describe('ONOSOO control — results and capabilities', () => {
  it('posts a result to builds/commands/<id>/result', async () => {
    const { control, calls } = client([ok({})]);
    assert.equal(await control.postResult('c0ffee00-1111', { status: 'succeeded', message: 'Run started', run_id: 'run-1' }), 'delivered');
    assert.equal(calls[0].url, 'https://xyz.supabase.co/functions/v1/builds/commands/c0ffee00-1111/result');
    assert.deepEqual(calls[0].body, { status: 'succeeded', message: 'Run started', run_id: 'run-1' });
  });

  it('maps every status', async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 409, body: '' }, 'final'],
      [{ status: 404, body: '' }, 'drop'],
      [{ status: 400, body: '' }, 'drop'],
      [{ status: 500, body: '' }, 'retry'],
      [{ status: 429, body: '' }, 'retry'],
      [new Error('down'), 'retry'],
      [{ status: 401, body: '' }, 'revoked'],
    ];
    for (const [reply, expected] of cases) {
      const { control } = client([reply]);
      assert.equal(await control.postResult('abcd', { status: 'failed', message: 'x' }), expected, JSON.stringify(reply));
    }
  });

  it('refuses an unsafe command id without sending', async () => {
    const { control, calls } = client([ok({})]);
    assert.equal(await control.postResult('../../etc', { status: 'failed', message: 'x' }), 'drop');
    assert.equal(calls.length, 0);
  });

  it('sends capabilities on the events route with no events and never a heartbeat', async () => {
    const { control, calls } = client([ok({ acked: {} })]);
    const caps = { remote_start: true, projects: [{ id: 'web', name: 'Web', kinds: ['node'] }], engines: ['claude'] };
    assert.equal(await control.sendCapabilities(caps), true);
    assert.equal(calls[0].url, CONFIG.endpoint);
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['capabilities', 'device_id', 'events', 'moag_version', 'protocol']);
    assert.deepEqual(calls[0].body.events, []);
    assert.deepEqual(calls[0].body.capabilities, caps);
  });

  it('no request body from the control client ever has a heartbeat', async () => {
    const { control, calls } = client(() => ok({ commands: [], acked: {} }) as { status: number; body: string });
    await control.poll();
    await control.postResult('abcd', { status: 'running', message: 'x' });
    await control.sendCapabilities({ remote_start: false, projects: [], engines: [] });
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => !('heartbeat' in c.body)));
  });

  it('a hanging server times out (the request is bounded)', async () => {
    let fire: (() => void) | null = null;
    const control = new OnosooControl({
      config: CONFIG,
      http: () => new Promise(() => undefined),
      setTimer: (fn) => { fire = fn; return { cancel: () => undefined }; },
      stderr: () => undefined,
    });
    const p = control.poll();
    await new Promise((r) => setImmediate(r));
    (fire as unknown as () => void)();
    assert.deepEqual(await p, { waitMs: 5_000 });
  });
});

describe('ONOSOO control — validateCommand', () => {
  it('drops commands without a usable id', () => {
    assert.equal(validateCommand(null), null);
    assert.equal(validateCommand({ kind: 'stop', payload: {} }), null);
    assert.equal(validateCommand({ id: 'x'.repeat(65), kind: 'stop', payload: {} }), null);
  });
});
