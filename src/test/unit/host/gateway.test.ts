// ─── Host agent: gateway ───
//
// Real sockets: a fake app on a loopback port, the gateway in front of it, and a fake ONOSOO that
// redeems tickets and answers membership checks. The tests are mostly refusals — the gateway is
// the only thing between the internet and code an AI wrote.

import { strict as assert } from 'assert';
import * as http from 'http';
import * as net from 'net';

import {
  envKeyFromHost,
  forwardHeaders,
  Gateway,
  parseCookies,
  safeNext,
  SESSION_COOKIE,
  SessionStore,
  stripCookie,
} from '../../../host/gateway';
import type { OnosooReply } from '../../../host/onosoo-client';
import type { EnvRecord } from '../../../host/types';

const DOMAIN = 'preview.test';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function env(key: string, port: number, over: Partial<EnvRecord> = {}): EnvRecord {
  return {
    key, projectId: 'shop', projectName: 'Shop', branch: 'main', runKey: null, port, worktree: '/w', composeFile: '/w/c.yml',
    roles: { web: 'web', api: 'api' }, web: { service: 'web', port: 5173 }, desired: 'running', status: 'running', message: null,
    createdAt: '', startedAt: '', lastAccessAt: '', ...over,
  };
}

interface Got { status: number; headers: http.IncomingHttpHeaders; body: string }

function get(port: number, host: string, path: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('host/gateway helpers', () => {
  it('maps a host to an environment key only under the preview domain', () => {
    assert.equal(envKeyFromHost('shop-main-1.preview.test', DOMAIN), 'shop-main-1');
    assert.equal(envKeyFromHost('Shop-Main-1.Preview.Test:443', DOMAIN), 'shop-main-1');
    assert.equal(envKeyFromHost('evil.com', DOMAIN), null);
    assert.equal(envKeyFromHost('a.b.preview.test', DOMAIN), null);
    assert.equal(envKeyFromHost('xpreview.test', DOMAIN), null);
    assert.equal(envKeyFromHost(undefined, DOMAIN), null);
  });

  it('strips only the session cookie', () => {
    assert.equal(stripCookie(`a=1; ${SESSION_COOKIE}=s; b=2`, SESSION_COOKIE), 'a=1; b=2');
    assert.equal(stripCookie(`${SESSION_COOKIE}=s`, SESSION_COOKIE), undefined);
    assert.equal(parseCookies(`x=1; ${SESSION_COOKIE}=abc`).get(SESSION_COOKIE), 'abc');
  });

  it('only redirects to a path on the same host', () => {
    assert.equal(safeNext('/dash?x=1'), '/dash?x=1');
    for (const n of ['//evil.com', 'https://evil.com', '/\\evil.com', '', null]) { assert.equal(safeNext(n), '/'); }
  });

  it('forwards without the session, the authorization header or spoofed X-Forwarded-*', () => {
    const h = forwardHeaders(
      { host: 'a.preview.test', cookie: `${SESSION_COOKIE}=s; theme=dark`, authorization: 'Bearer obt_x', 'x-forwarded-for': '6.6.6.6', connection: 'keep-alive', accept: '*/*' },
      { port: 41001, originalHost: 'a.preview.test', remoteAddress: '1.2.3.4', keepUpgrade: false },
    );
    assert.equal(h.host, 'localhost:41001');
    assert.equal(h.cookie, 'theme=dark');
    assert.equal(h.authorization, undefined);
    assert.equal(h['x-forwarded-for'], '1.2.3.4');
    assert.equal(h['x-forwarded-proto'], 'https');
    assert.equal(h.connection, undefined);
    assert.equal(h.accept, '*/*');
  });

  it('sessions are bound to one environment and expire', () => {
    let now = 1000;
    const store = new SessionStore(() => now);
    const s = store.create({ userId: 'u', userName: 'U', role: 'member', scope: 'preview', envKey: 'a', expiresAt: 2000 });
    assert.ok(store.find(s.id, 'a'));
    assert.equal(store.find(s.id, 'b'), null);
    now = 2000;
    assert.equal(store.find(s.id, 'a'), null);
  });

  it('membership answers drop removed people and logs sessions of guests', () => {
    const store = new SessionStore(() => 0);
    const a = store.create({ userId: 'a', userName: '', role: 'member', scope: 'preview', envKey: 'e', expiresAt: 10 });
    const b = store.create({ userId: 'b', userName: '', role: 'member', scope: 'logs', envKey: 'e', expiresAt: 10 });
    const c = store.create({ userId: 'c', userName: '', role: 'member', scope: 'preview', envKey: 'e', expiresAt: 10 });
    assert.equal(store.applyMembership({ a: 'member', b: 'guest', c: null }), 2);
    assert.ok(store.find(a.id, 'e'));
    assert.equal(store.find(b.id, 'e'), null);
    assert.equal(store.find(c.id, 'e'), null);
  });
});

describe('host/gateway server', () => {
  let app: http.Server;
  let appPort: number;
  let gw: Gateway;
  let gwPort: number;
  let lastAppRequest: http.IncomingMessage | null;
  const calls: { route: string; body: unknown }[] = [];
  let members: Record<string, unknown> = { 'user-1': 'member', 'user-g': 'guest' };
  const tickets: Record<string, Record<string, unknown>> = {};
  const envs = new Map<string, EnvRecord>();

  const call = async (route: string, body: unknown): Promise<OnosooReply> => {
    calls.push({ route, body });
    if (route === 'previews/redeem') {
      const t = (body as { ticket: string }).ticket;
      const hit = tickets[t];
      delete tickets[t]; // single use, like ONOSOO
      return hit ? { status: 200, json: hit } : { status: 404, json: { code: 'not_found' } };
    }
    if (route === 'previews/check') { return { status: 200, json: { members } }; }
    return { status: 404, json: null };
  };

  const ticket = (id: string, over: Record<string, unknown> = {}): string => {
    tickets[id] = { user_id: 'user-1', user_name: 'Una', role: 'member', scope: 'preview', env_key: 'shop-1', session_ttl: 3600, recheck_after: 60, ...over };
    return id;
  };

  async function login(id = 'obt_login'): Promise<string> {
    const r = await get(gwPort, 'shop-1.preview.test', `/__onosoo/auth?ticket=${ticket(id)}&next=/dash`);
    assert.equal(r.status, 302);
    const cookie = String(r.headers['set-cookie']?.[0] ?? '');
    return cookie.split(';')[0];
  }

  before(async () => {
    appPort = await freePort();
    app = http.createServer((req, res) => {
      lastAppRequest = req;
      res.setHeader('Set-Cookie', [`${SESSION_COOKIE}=hijack`, 'app=1']);
      res.end(`app:${req.url}`);
    });
    app.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello');
      socket.end();
    });
    await new Promise<void>((r) => app.listen(appPort, '127.0.0.1', () => r()));

    envs.set('shop-1', env('shop-1', appPort));
    envs.set('shop-2', env('shop-2', appPort));
    envs.set('stopped-1', env('stopped-1', appPort, { desired: 'stopped' }));
    gw = new Gateway({
      previewDomain: DOMAIN,
      appUrl: 'https://app.example.com',
      appOrigins: ['https://app.example.com'],
      call,
      environment: (k) => envs.get(k),
      status: (k) => ({ env_key: k }),
      logs: async (_k, service) => { if (service !== 'api') { throw new Error('no such service'); } return 'line1\nline2'; },
      touch: () => undefined,
      log: () => undefined,
    });
    gwPort = await freePort();
    await gw.listen(gwPort);
  });

  after(async () => {
    await gw.close();
    await new Promise<void>((r) => app.close(() => r()));
  });

  beforeEach(() => { lastAppRequest = null; members = { 'user-1': 'member', 'user-g': 'guest' }; });

  it('sends a visitor without a session back to ONOSOO, and never reaches the app', async () => {
    const r = await get(gwPort, 'shop-1.preview.test', '/', { accept: 'text/html' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, 'https://app.example.com/builds');
    const api = await get(gwPort, 'shop-1.preview.test', '/api');
    assert.equal(api.status, 401);
    assert.equal(lastAppRequest, null);
  });

  it('answers 404 for a host that is not one of its environments', async () => {
    assert.equal((await get(gwPort, 'nope.preview.test', '/')).status, 404);
    assert.equal((await get(gwPort, 'evil.com', '/')).status, 404);
  });

  it('turns a ticket into a host-only, HttpOnly, Secure session and redirects to next', async () => {
    const r = await get(gwPort, 'shop-1.preview.test', `/__onosoo/auth?ticket=${ticket('obt_a')}&next=//evil.com`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    const c = String(r.headers['set-cookie']?.[0]);
    assert.match(c, /HttpOnly/);
    assert.match(c, /Secure/);
    assert.match(c, /SameSite=Lax/);
    assert.doesNotMatch(c, /Domain=/i);
  });

  it('refuses a used, unknown or other-environment ticket', async () => {
    const t = ticket('obt_once');
    assert.equal((await get(gwPort, 'shop-1.preview.test', `/__onosoo/auth?ticket=${t}`)).status, 302);
    assert.equal((await get(gwPort, 'shop-1.preview.test', `/__onosoo/auth?ticket=${t}`)).status, 403);
    assert.equal((await get(gwPort, 'shop-1.preview.test', '/__onosoo/auth?ticket=obt_never')).status, 403);
    const other = ticket('obt_other', { env_key: 'shop-2' });
    assert.equal((await get(gwPort, 'shop-1.preview.test', `/__onosoo/auth?ticket=${other}`)).status, 403);
  });

  it('proxies with the session: the app never sees or sets the session cookie', async () => {
    const cookie = await login('obt_p');
    const r = await get(gwPort, 'shop-1.preview.test', '/dash?x=1', { cookie: `${cookie}; theme=dark` });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'app:/dash?x=1');
    assert.equal(lastAppRequest?.headers.cookie, 'theme=dark');
    assert.equal(lastAppRequest?.headers.host, `localhost:${appPort}`);
    assert.equal(lastAppRequest?.headers['x-forwarded-host'], 'shop-1.preview.test');
    assert.deepEqual(r.headers['set-cookie'], ['app=1']);
  });

  it('does not honour one environment\'s session on another', async () => {
    const cookie = await login('obt_x');
    const r = await get(gwPort, 'shop-2.preview.test', '/', { cookie });
    assert.equal(r.status, 401);
  });

  it('serves logs to members, refuses guests, and allows only the ONOSOO origin', async () => {
    const member = await login('obt_m');
    const ok = await get(gwPort, 'shop-1.preview.test', '/__onosoo/logs?service=api', { cookie: member, origin: 'https://app.example.com' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'line1\nline2');
    assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com');
    const evil = await get(gwPort, 'shop-1.preview.test', '/__onosoo/logs?service=api', { cookie: member, origin: 'https://evil.com' });
    assert.equal(evil.headers['access-control-allow-origin'], undefined);

    const g = ticket('obt_g', { user_id: 'user-g', role: 'guest', scope: 'preview' });
    const gr = await get(gwPort, 'shop-1.preview.test', `/__onosoo/auth?ticket=${g}`);
    const guestCookie = String(gr.headers['set-cookie']?.[0]).split(';')[0];
    assert.equal((await get(gwPort, 'shop-1.preview.test', '/__onosoo/logs?service=api', { cookie: guestCookie })).status, 403);
  });

  it('accepts a logs ticket as a bearer, redeemed once and reused for a few minutes', async () => {
    const t = ticket('obt_bearer', { scope: 'logs' });
    const before = calls.filter((c) => c.route === 'previews/redeem').length;
    const a = await get(gwPort, 'shop-1.preview.test', '/__onosoo/logs?service=api', { authorization: `Bearer ${t}` });
    const b = await get(gwPort, 'shop-1.preview.test', '/__onosoo/status', { authorization: `Bearer ${t}` });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(calls.filter((c) => c.route === 'previews/redeem').length - before, 1);
    assert.equal((await get(gwPort, 'shop-1.preview.test', '/__onosoo/status', { authorization: 'Bearer obt_nope' })).status, 401);
  });

  it('closes the session of someone removed from the workspace at the next check', async () => {
    const cookie = await login('obt_r');
    assert.equal((await get(gwPort, 'shop-1.preview.test', '/', { cookie })).status, 200);
    members = { 'user-1': null };
    await gw.recheck();
    assert.equal((await get(gwPort, 'shop-1.preview.test', '/api', { cookie })).status, 401);
  });

  it('shows a stopped environment as not running, without reaching the app', async () => {
    const t = ticket('obt_s', { env_key: 'stopped-1' });
    const r = await get(gwPort, 'stopped-1.preview.test', `/__onosoo/auth?ticket=${t}`);
    const cookie = String(r.headers['set-cookie']?.[0]).split(';')[0];
    const page = await get(gwPort, 'stopped-1.preview.test', '/', { cookie });
    assert.equal(page.status, 503);
    assert.equal(lastAppRequest, null);
  });

  it('proxies a WebSocket upgrade only with a session', async () => {
    const cookie = await login('obt_ws');
    const upgrade = (withCookie: boolean): Promise<string> => new Promise((resolve) => {
      const s = net.connect(gwPort, '127.0.0.1', () => {
        s.write(`GET /hmr HTTP/1.1\r\nHost: shop-1.preview.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${withCookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
      });
      let data = '';
      s.on('data', (c) => { data += c.toString(); });
      s.on('close', () => resolve(data));
      s.on('error', () => resolve(data));
    });
    assert.match(await upgrade(true), /101 Switching Protocols[\s\S]*hello/);
    assert.match(await upgrade(false), /401/);
  });
});
