import { strict as assert } from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { PassThrough } from 'stream';
import {
  readJsonBody, sendJson, sendError, HttpError, parseCookies, clientIp, securityHeaders, Router, CONTENT_SECURITY_POLICY, MAX_BODY_BYTES,
} from '../../../server/http-kit';
import {
  obj, str, oneOf, bool, num, opt, nullable, engineId, bump, stack, roles, parseBody, ValidationError,
} from '../../../server/validate';

// ─── Helpers ───

function withServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function post(url: string, body: string | Buffer, headers: Record<string, string>): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const echo: http.RequestListener = (req, res) => {
  readJsonBody(req).then((b) => sendJson(res, 200, { got: b }), (e) => sendError(res, e));
};

function fakeReq(headers: Record<string, string | string[]>, remote = '10.0.0.5'): http.IncomingMessage {
  const s = new PassThrough() as unknown as http.IncomingMessage;
  (s as unknown as { headers: unknown }).headers = headers;
  (s as unknown as { socket: unknown }).socket = { remoteAddress: remote };
  return s;
}

describe('http-kit', () => {
  describe('readJsonBody', () => {
    it('parses JSON and treats an empty body as {}', async () => {
      const srv = await withServer(echo);
      try {
        const r = await post(srv.url, '{"a":1}', { 'Content-Type': 'application/json; charset=utf-8' });
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.body), { got: { a: 1 } });
        const e = await post(srv.url, '', { 'Content-Type': 'application/json' });
        assert.deepEqual(JSON.parse(e.body), { got: {} });
      } finally { await srv.close(); }
    });

    it('415 for a non-JSON content type (form posts cannot reach handlers)', async () => {
      const srv = await withServer(echo);
      try {
        for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
          const r = await post(srv.url, '{"a":1}', { 'Content-Type': ct });
          assert.equal(r.status, 415, ct);
        }
        const none = await post(srv.url, '{"a":1}', {});
        assert.equal(none.status, 415);
      } finally { await srv.close(); }
    });

    // Deterministic by construction: the 1 MB default is exercised on in-memory
    // requests (no socket), and the over-the-wire check uses a small injected
    // limit. Posting a real 1 MB body raced the server's early 413 against the
    // client's upload, so the client could see ECONNRESET/EPIPE instead.
    it('413 past the 1 MB default for a declared Content-Length, without reading the body', async () => {
      assert.equal(MAX_BODY_BYTES, 1024 * 1024);
      const req = fakeReq({ 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 10) });
      await assert.rejects(readJsonBody(req), (e: unknown) => e instanceof HttpError && e.status === 413 && e.code === 'payload-too-large');
      const atLimit = fakeReq({ 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES) });
      const pending = readJsonBody(atLimit);
      (atLimit as unknown as PassThrough).end(Buffer.alloc(MAX_BODY_BYTES, 0x20));
      assert.deepEqual(await pending, {}, 'exactly 1 MB is accepted (whitespace parses as an empty body)');
    });

    it('413 past the 1 MB default for a streamed body (no Content-Length)', async () => {
      const req = fakeReq({ 'content-type': 'application/json' });
      const p = readJsonBody(req);
      (req as unknown as PassThrough).write(Buffer.alloc(MAX_BODY_BYTES, 0x20));
      (req as unknown as PassThrough).write(Buffer.alloc(10, 0x20));
      await assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === 413);
    });

    it('413 over the wire maps to a payload-too-large JSON error (small injected limit)', async () => {
      const srv = await withServer((req, res) => {
        readJsonBody(req, 64).then((b) => sendJson(res, 200, { got: b }), (e) => sendError(res, e));
      });
      try {
        const r = await post(srv.url, Buffer.alloc(100, 0x20), { 'Content-Type': 'application/json' });
        assert.equal(r.status, 413);
        assert.equal(JSON.parse(r.body).error, 'payload-too-large');
        const ok = await post(srv.url, '{"a":1}', { 'Content-Type': 'application/json' });
        assert.equal(ok.status, 200, 'under the limit still parses');
      } finally { await srv.close(); }
    });

    it('413 for a streamed body without Content-Length', async () => {
      const req = fakeReq({ 'content-type': 'application/json' });
      const p = readJsonBody(req, 100);
      (req as unknown as PassThrough).write(Buffer.alloc(60, 0x20));
      (req as unknown as PassThrough).write(Buffer.alloc(60, 0x20));
      await assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === 413);
    });

    it('400 on invalid JSON', async () => {
      const srv = await withServer(echo);
      try {
        const r = await post(srv.url, '{nope', { 'Content-Type': 'application/json' });
        assert.equal(r.status, 400);
        assert.equal(JSON.parse(r.body).error, 'invalid-json');
      } finally { await srv.close(); }
    });
  });

  describe('sendError', () => {
    it('500 carries no stack trace or message from the thrown error', async () => {
      const srv = await withServer((_req, res) => sendError(res, new Error('secret internals at /srv/x.ts:12')));
      try {
        const r = await post(srv.url, '', { 'Content-Type': 'application/json' });
        assert.equal(r.status, 500);
        assert.equal(r.body.includes('secret internals'), false);
        assert.equal(r.body.includes('.ts:'), false);
      } finally { await srv.close(); }
    });

    it('maps ValidationError to 400 with the field', async () => {
      const srv = await withServer((_req, res) => sendError(res, new ValidationError('engine', 'bad')));
      try {
        const r = await post(srv.url, '', { 'Content-Type': 'application/json' });
        assert.equal(r.status, 400);
        assert.equal(JSON.parse(r.body).field, 'engine');
      } finally { await srv.close(); }
    });
  });

  describe('validators', () => {
    const schema = obj({ name: str(1, 10), engine: engineId, b: opt(bump), s: opt(stack), r: opt(roles), n: opt(num(0, 5)), f: opt(bool()), z: opt(nullable(str(1, 3))) });

    it('accepts a valid body', () => {
      const v = parseBody(schema, { name: 'x', engine: 'claude', b: 'minor', s: 'go', r: ['admin'], n: 2, f: true, z: null });
      assert.deepEqual(v, { name: 'x', engine: 'claude', b: 'minor', s: 'go', r: ['admin'], n: 2, f: true, z: null });
    });

    it('rejects an unknown body key with 400 semantics', () => {
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', extra: 1 }), (e: unknown) => e instanceof ValidationError && e.field === 'extra');
      assert.throws(() => parseBody(schema, JSON.parse('{"name":"x","engine":"claude","__proto__":{"admin":true}}')), ValidationError);
    });

    it('rejects invalid engine, bump, stack and roles', () => {
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'rm' }), /engine/);
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', b: 'huge' }), /b:/);
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', s: 'rust' }), /s:/);
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', r: ['architect'] }), /r:/);
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', r: [] }), /r:/);
    });

    it('rejects missing required, wrong types, lengths, ranges and patterns', () => {
      assert.throws(() => parseBody(schema, { engine: 'claude' }), /name: is required/);
      assert.throws(() => parseBody(schema, { name: 'x'.repeat(11), engine: 'claude' }), /1-10/);
      assert.throws(() => parseBody(schema, { name: 1, engine: 'claude' }), /string/);
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', n: 6 }), /between/);
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', n: Infinity }), /finite/);
      assert.throws(() => parseBody(schema, { name: 'x', engine: 'claude', f: 'true' }), /boolean/);
      assert.throws(() => parseBody(obj({ a: str(1, 5, /^[a-z]+$/) }), { a: 'AB' }), /invalid format/);
      assert.throws(() => parseBody(obj({ a: num(0, 5, { integer: true }) }), { a: 1.5 }), /integer/);
      assert.throws(() => parseBody(obj({ a: oneOf(['x', 'y'] as const) }), { a: 'z' }), /one of/);
      assert.throws(() => parseBody(schema, []), /object/);
      assert.throws(() => parseBody(schema, null), /object/);
    });
  });

  describe('parseCookies', () => {
    it('parses pairs, skips malformed, first wins', () => {
      const c = parseCookies('a=1; b="2"; junk; =x; a=3; c=%41');
      assert.equal(c.a, '1');
      assert.equal(c.b, '2');
      assert.equal(c.c, 'A');
      assert.equal(Object.keys(c).length, 3);
      assert.deepEqual({ ...parseCookies(undefined) }, {});
    });
  });

  describe('clientIp', () => {
    it('ignores X-Forwarded-For unless the proxy is trusted', () => {
      const req = fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
      assert.equal(clientIp(req, false), '10.0.0.5');
    });

    it('uses the rightmost hop when trusted', () => {
      assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), true), '203.0.113.9');
      assert.equal(clientIp(fakeReq({}), true), '10.0.0.5');
    });
  });

  describe('securityHeaders', () => {
    it('sends CSP, nosniff, referrer policy, COOP and no-store on /api', () => {
      const h = securityHeaders({ secure: false, api: true });
      assert.equal(h['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
      for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) {
        assert.ok(h['Content-Security-Policy'].includes(d), d);
      }
      assert.equal(h['Content-Security-Policy'].includes('unsafe-inline'), false);
      assert.equal(h['Content-Security-Policy'].includes('unsafe-eval'), false);
      assert.equal(h['X-Content-Type-Options'], 'nosniff');
      assert.equal(h['Referrer-Policy'], 'no-referrer');
      assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin');
      assert.equal(h['Cache-Control'], 'no-store');
      assert.equal('Strict-Transport-Security' in h, false);
    });

    it('adds HSTS on https and omits no-store off /api', () => {
      const h = securityHeaders({ secure: true, api: false });
      assert.match(h['Strict-Transport-Security'], /max-age=\d+/);
      assert.equal('Cache-Control' in h, false);
    });
  });

  describe('Router', () => {
    const r = new Router<string>();
    r.add('GET', '/api/projects/:id', 'get');
    r.add('PATCH', '/api/projects/:id', 'patch');
    r.add('POST', '/api/projects/:id/plans/:planId/approve', 'approve');

    it('matches params', () => {
      const m = r.match('POST', '/api/projects/p-1/plans/abc/approve');
      assert.deepEqual(m, { kind: 'found', handler: 'approve', params: { id: 'p-1', planId: 'abc' } });
    });

    it('reports 405 with allowed methods', () => {
      const m = r.match('DELETE', '/api/projects/p1');
      assert.equal(m.kind, 'method-not-allowed');
      assert.deepEqual((m as { allowed: string[] }).allowed.sort(), ['GET', 'PATCH']);
    });

    it('rejects params outside [A-Za-z0-9-]{1,64}', () => {
      for (const bad of ['..', '%2e%2e', 'a.b', 'a_b', 'x'.repeat(65), 'a%2fb']) {
        assert.equal(r.match('GET', `/api/projects/${bad}`).kind, 'not-found', bad);
      }
      assert.equal(r.match('GET', '/api/projects/a/b').kind, 'not-found');
    });
  });
});
