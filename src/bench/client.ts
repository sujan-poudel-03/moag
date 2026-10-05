// ─── Benchmark HTTP + SSE client ───
//
// Drives the hosted server exactly as a browser would: cookies per actor, the
// pre-auth double-submit token for bootstrap and sign-in, the session's CSRF
// token on every mutating call, and the project event stream over SSE. It
// never sends an `Origin` header and never touches server internals.
//
// Every call is logged through the injected sink with credentials redacted
// (any key that names a password, token or CSRF value). Network failures throw
// BenchHttpError; HTTP 4xx/5xx are returned, never thrown, so the harness can
// record them.

import * as http from 'http';

/** A request never reached a response (connection refused, reset, timeout). */
export class BenchHttpError extends Error {
  constructor(message: string, public readonly method: string, public readonly path: string) {
    super(`${method} ${path}: ${message}`);
    this.name = 'BenchHttpError';
  }
}

export interface BenchResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Where every request/response line goes (the harness writes it to events.jsonl). */
export type BenchLogSink = (entry: Record<string, unknown>) => void;

/** A server-sent event: its name and parsed `data` (raw text when not JSON). */
export interface BenchSseEvent {
  event: string;
  data: unknown;
}

const REDACT_KEY_RE = /password|token|csrf|secret|cookie/i;
const REQUEST_TIMEOUT_MS = 60_000;
/** Reconnect attempts for one SSE subscription, and the pause between them. */
export const SSE_MAX_RECONNECTS = 5;
export const SSE_RECONNECT_MS = 2_000;

/** Deep copy of `value` with every credential-looking key replaced by "[redacted]". */
export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(redactForLog); }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY_RE.test(k) ? '[redacted]' : redactForLog(v);
    }
    return out;
  }
  return value;
}

interface ActorSession {
  cookies: Map<string, string>;
  csrf: string | null;
  preAuth: string | null;
}

export class BenchClient {
  private readonly sessions = new Map<string, ActorSession>();
  private readonly url: URL;

  constructor(baseUrl: string, private readonly log: BenchLogSink, private readonly opts: { sseReconnectMs?: number } = {}) {
    this.url = new URL(baseUrl);
  }

  private session(actor: string): ActorSession {
    let s = this.sessions.get(actor);
    if (!s) { s = { cookies: new Map(), csrf: null, preAuth: null }; this.sessions.set(actor, s); }
    return s;
  }

  private cookieHeader(actor: string): string | undefined {
    const c = this.session(actor).cookies;
    return c.size > 0 ? [...c.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
  }

  private absorbCookies(actor: string, headers: http.IncomingHttpHeaders): void {
    const jar = this.session(actor).cookies;
    for (const line of headers['set-cookie'] ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) { continue; }
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (expired || value === '') { jar.delete(name); } else { jar.set(name, value); }
    }
  }

  /**
   * One request as `actor`. Mutating methods carry the session's CSRF token
   * (or `csrfOverride`, e.g. the pre-auth token). Resolves for every HTTP
   * status; rejects with BenchHttpError only when no response arrived.
   */
  call(actor: string, method: string, path: string, body?: unknown, opts: { csrfOverride?: string | null; quiet?: boolean } = {}): Promise<BenchResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const cookie = this.cookieHeader(actor);
    if (cookie) { headers.Cookie = cookie; }
    const mutating = method !== 'GET' && method !== 'HEAD';
    const csrf = opts.csrfOverride !== undefined ? opts.csrfOverride : this.session(actor).csrf;
    if (mutating && csrf) { headers['X-CSRF-Token'] = csrf; }
    let payload: string | undefined;
    if (mutating) {
      payload = body === undefined ? '{}' : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const started = Date.now();
    return new Promise<BenchResponse>((resolve, reject) => {
      const req = http.request(new URL(path, this.url), { method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          this.absorbCookies(actor, res.headers);
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          try {
            const v = raw ? JSON.parse(raw) as unknown : {};
            parsed = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : { value: v };
          } catch { parsed = { raw: raw.slice(0, 2000) }; }
          const status = res.statusCode ?? 0;
          this.log({
            kind: 'http', actor, method, path, status, ms: Date.now() - started,
            ...(mutating ? { request: redactForLog(body ?? {}) } : {}),
            // Polls are logged by status only; anything that changed state, or failed, in full.
            ...(!opts.quiet || status >= 400 ? { response: redactForLog(parsed) } : { bytes: raw.length }),
          });
          resolve({ status, body: parsed });
        });
        res.on('error', (err) => reject(new BenchHttpError(err.message, method, path)));
      });
      req.on('timeout', () => { req.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS} ms`)); });
      req.on('error', (err) => {
        this.log({ kind: 'http-error', actor, method, path, error: err.message });
        reject(new BenchHttpError(err.message, method, path));
      });
      req.end(payload);
    });
  }

  /** GET /api/session without a session: keeps the pre-auth cookie and token for `actor`. */
  async preAuth(actor = 'anon'): Promise<{ bootstrapNeeded: boolean }> {
    const r = await this.call(actor, 'GET', '/api/session');
    const token = r.body.preAuthToken;
    if (r.status !== 200 || typeof token !== 'string') { throw new BenchHttpError(`no pre-auth token (${r.status})`, 'GET', '/api/session'); }
    this.session(actor).preAuth = token;
    return { bootstrapNeeded: r.body.bootstrapNeeded === true };
  }

  /** Create the first admin with the one-time bootstrap token. */
  async bootstrap(token: string, username: string, password: string): Promise<BenchResponse> {
    await this.preAuth('anon');
    return this.call('anon', 'POST', '/api/bootstrap', { token, username, password }, { csrfOverride: this.session('anon').preAuth });
  }

  /** Sign in as `actor`; stores the session cookie and CSRF token on success. */
  async login(actor: string, username: string, password: string): Promise<BenchResponse> {
    await this.preAuth(actor);
    const r = await this.call(actor, 'POST', '/api/login', { username, password }, { csrfOverride: this.session(actor).preAuth });
    if (r.status === 200 && typeof r.body.csrfToken === 'string') { this.session(actor).csrf = r.body.csrfToken; }
    return r;
  }

  /** Change `actor`'s own password; the server rotates the session and its CSRF token. */
  async changePassword(actor: string, currentPassword: string, newPassword: string): Promise<BenchResponse> {
    const r = await this.call(actor, 'POST', '/api/me/password', { currentPassword, newPassword });
    if (r.status === 200 && typeof r.body.csrfToken === 'string') { this.session(actor).csrf = r.body.csrfToken; }
    return r;
  }

  /**
   * Subscribe to a project's event stream as `actor`. Parses `event:`/`data:`
   * blocks; on a dropped stream reconnects at most {@link SSE_MAX_RECONNECTS}
   * times, {@link SSE_RECONNECT_MS} apart. The returned disposer destroys the
   * request and cancels any pending reconnect. Never throws.
   */
  events(actor: string, projectId: string, onEvent: (e: BenchSseEvent) => void): () => void {
    const path = `/api/projects/${encodeURIComponent(projectId)}/events`;
    let disposed = false;
    let req: http.ClientRequest | null = null;
    let timer: NodeJS.Timeout | null = null;
    let reconnects = 0;

    const deliver = (block: string): void => {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) { continue; }
        const idx = line.indexOf(':');
        const field = idx < 0 ? line : line.slice(0, idx);
        const value = idx < 0 ? '' : line.slice(idx + 1).replace(/^ /, '');
        if (field === 'event') { event = value; } else if (field === 'data') { data.push(value); }
      }
      if (data.length === 0) { return; }
      const text = data.join('\n');
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep the raw text */ }
      try { onEvent({ event, data: parsed }); } catch (err) { this.log({ kind: 'sse-listener-error', error: (err as Error).message }); }
    };

    const retry = (why: string): void => {
      req = null;
      if (disposed) { return; }
      if (reconnects >= SSE_MAX_RECONNECTS) { this.log({ kind: 'sse-gave-up', actor, path, why }); return; }
      reconnects++;
      this.log({ kind: 'sse-reconnect', actor, path, why, attempt: reconnects });
      timer = setTimeout(() => { timer = null; connect(); }, this.opts.sseReconnectMs ?? SSE_RECONNECT_MS);
    };

    const connect = (): void => {
      if (disposed) { return; }
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      const cookie = this.cookieHeader(actor);
      if (cookie) { headers.Cookie = cookie; }
      let buf = '';
      let ended = false;
      const r = http.request(new URL(path, this.url), { method: 'GET', headers }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.log({ kind: 'sse-refused', actor, path, status: res.statusCode });
          ended = true;
          retry(`status ${res.statusCode}`);
          return;
        }
        this.log({ kind: 'sse-open', actor, path });
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buf += chunk.replace(/\r\n/g, '\n');
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            deliver(block);
          }
        });
        res.on('end', () => { if (!ended) { ended = true; retry('stream ended'); } });
        res.on('error', () => { if (!ended) { ended = true; retry('stream error'); } });
      });
      r.on('error', (err) => { if (!ended) { ended = true; retry(err.message); } });
      r.end();
      req = r;
    };

    connect();
    return () => {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (req) { req.destroy(); req = null; }
    };
  }
}
