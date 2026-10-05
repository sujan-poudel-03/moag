import { strict as assert } from 'assert';
import { BenchClient, BenchHttpError, redactForLog, BenchSseEvent } from '../../../bench/client';
import { startHarness, Harness, waitFor } from '../server/app-harness';

const BOOT = 'bench-bootstrap-token-0123456789abcdef';
const ADMIN_PW = 'Admin-Password-Long-1!';
const TEMP_PW = 'Temp-Password-Long-22!';
const NEW_PW = 'Final-Password-Long-333!';

describe('bench client (against the app harness)', function () {
  this.timeout(20000);
  let h: Harness;
  let logs: Array<Record<string, unknown>>;
  let c: BenchClient;

  beforeEach(async () => {
    h = await startHarness({ accounts: {}, config: { bootstrapToken: BOOT } });
    logs = [];
    c = new BenchClient(h.url, (e) => logs.push(e), { sseReconnectMs: 20 });
  });
  afterEach(async () => { await h.close(); });

  async function admin(): Promise<void> {
    const b = await c.bootstrap(BOOT, 'bench-admin', ADMIN_PW);
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const l = await c.login('admin', 'bench-admin', ADMIN_PW);
    assert.equal(l.status, 200, JSON.stringify(l.body));
  }

  it('bootstrap → login → create user → forced password change → session', async () => {
    await admin();
    const u = await c.call('admin', 'POST', '/api/admin/users', { username: 'bench-po', roles: ['product-owner'], password: TEMP_PW });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    const l = await c.login('po', 'bench-po', TEMP_PW);
    assert.equal(l.status, 200);
    assert.equal(l.body.mustChangePassword, true);
    const blocked = await c.call('po', 'GET', '/api/projects');
    assert.equal(blocked.status, 403, 'a temporary password must be changed first');
    const ch = await c.changePassword('po', TEMP_PW, NEW_PW);
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const s = await c.call('po', 'GET', '/api/session');
    assert.equal(s.status, 200);
    assert.equal((s.body.user as { username: string }).username, 'bench-po');
    assert.equal((await c.call('po', 'GET', '/api/projects')).status, 200, 'the rotated session and CSRF token work');
  });

  it('a missing CSRF token is surfaced as a 403, not thrown', async () => {
    await admin();
    const r = await c.call('admin', 'POST', '/api/admin/users', { username: 'x', roles: ['approver'], password: TEMP_PW }, { csrfOverride: null });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'csrf');
  });

  it('a network failure is a BenchHttpError', async () => {
    const dead = new BenchClient('http://127.0.0.1:9', () => undefined);
    await assert.rejects(() => dead.call('x', 'GET', '/healthz'), BenchHttpError);
  });

  it('SSE delivers the snapshot event, and the disposer leaves no subscriber behind', async () => {
    await admin();
    const p = await c.call('admin', 'POST', '/api/projects', { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: 'claude' });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const id = (p.body.project as { id: string }).id;
    const seen: BenchSseEvent[] = [];
    const dispose = c.events('admin', id, (e) => seen.push(e));
    await waitFor(() => seen.some((e) => e.event === 'snapshot'), 5000);
    assert.equal(h.app.jobs.subscriberCount(id), 1);
    dispose();
    await waitFor(() => h.app.jobs.subscriberCount(id) === 0, 5000);
  });

  it('SSE gives up after the reconnect limit when the stream is refused', async () => {
    const seen: BenchSseEvent[] = [];
    const dispose = c.events('nobody', 'no-such-project', (e) => seen.push(e));
    await waitFor(() => logs.some((l) => l.kind === 'sse-gave-up'), 5000);
    assert.equal(logs.filter((l) => l.kind === 'sse-reconnect').length, 5);
    assert.deepEqual(seen, []);
    dispose();
  });

  it('logs every call with credentials redacted', async () => {
    await admin();
    await c.call('admin', 'POST', '/api/admin/users', { username: 'bench-r', roles: ['reviewer'], password: TEMP_PW });
    const text = JSON.stringify(logs);
    for (const secret of [BOOT, ADMIN_PW, TEMP_PW]) { assert.equal(text.includes(secret), false, 'a secret leaked into the log'); }
    assert.ok(logs.some((l) => l.kind === 'http' && l.path === '/api/admin/users' && l.status === 201));
    assert.deepEqual(redactForLog({ a: 1, password: 'x', nested: { csrfToken: 'y', list: [{ token: 'z' }] } }),
      { a: 1, password: '[redacted]', nested: { csrfToken: '[redacted]', list: [{ token: '[redacted]' }] } });
  });
});
