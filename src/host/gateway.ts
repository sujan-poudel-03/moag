// ─── Gateway: the only way into a running environment ───
//
// Listens on 127.0.0.1 only; the tunnel delivers `https://<env key>.<preview domain>` to it.
// Nothing reaches an environment without a session, and a session only comes from ONOSOO:
//
//   GET /__onosoo/auth?ticket=…&next=/   ticket → ONOSOO previews/redeem → session cookie → next
//   GET /__onosoo/logs?service=…&tail=N  redacted log tail   (session or `Authorization: Bearer <ticket>`)
//   GET /__onosoo/status                 the environment's state as JSON
//   anything else                        proxied to the environment's web service (HTTP + WebSocket)
//
// Sessions live in memory, keyed by a random id in an HttpOnly, Secure, SameSite=Lax cookie that is
// host-only, so a session for one environment is never sent to another. Every minute the gateway
// asks ONOSOO whether each session's member is still in the workspace (previews/check) and drops
// those who are not — removing someone from the workspace closes their preview within a minute.
//
// What the environment sees: the request without the session cookie, Host rewritten to its own
// loopback address (dev servers refuse unknown hosts), and X-Forwarded-* describing the original.
// Imports node built-ins only; never vscode.

import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import * as net from 'net';

import type { OnosooCall } from './onosoo-client';
import type { EnvRecord } from './types';

export const SESSION_COOKIE = '__onosoo_preview';
const TICKET_PREFIX = 'obt_';
const BEARER_TICKET_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_RECHECK_MS = 60_000;

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type Scope = 'preview' | 'logs';

export interface Session {
  id: string;
  userId: string;
  userName: string;
  role: Role;
  scope: Scope;
  envKey: string;
  expiresAt: number;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** `shop-main-3f9a.preview.onosoo.com[:443]` → `shop-main-3f9a`, or null when not one of ours. */
export function envKeyFromHost(host: string | undefined, previewDomain: string): string | null {
  if (!host) { return null; }
  const name = host.toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${previewDomain}`;
  if (!name.endsWith(suffix)) { return null; }
  const label = name.slice(0, -suffix.length);
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(label) ? label : null;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) { continue; }
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

/** The Cookie header without `name`; undefined when nothing is left. */
export function stripCookie(header: string | undefined, name: string): string | undefined {
  if (!header) { return undefined; }
  const kept = header.split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${name}=`));
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** A redirect target on the same host: a path, never `//host` or a scheme. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) { return '/'; }
  return next;
}

export function canReadLogs(role: Role): boolean {
  return role !== 'guest';
}

function isRole(v: unknown): v is Role {
  return v === 'owner' || v === 'admin' || v === 'member' || v === 'guest';
}

function hashTicket(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Headers for the request forwarded to the environment. */
export function forwardHeaders(
  incoming: http.IncomingHttpHeaders,
  opts: { port: number; originalHost: string; remoteAddress: string | undefined; keepUpgrade: boolean },
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined) { continue; }
    if (HOP_BY_HOP.has(key) && !(opts.keepUpgrade && (key === 'connection' || key === 'upgrade'))) { continue; }
    if (key === 'host' || key === 'authorization' || key.startsWith('x-forwarded-') || key === 'forwarded') { continue; }
    if (key === 'cookie') {
      const c = stripCookie(Array.isArray(v) ? v.join('; ') : v, SESSION_COOKIE);
      if (c) { out.cookie = c; }
      continue;
    }
    out[key] = v;
  }
  out.host = `localhost:${opts.port}`;
  out['x-forwarded-host'] = opts.originalHost;
  out['x-forwarded-proto'] = 'https';
  if (opts.remoteAddress) { out['x-forwarded-for'] = opts.remoteAddress; }
  return out;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export class SessionStore {
  private sessions = new Map<string, Session>();
  private bearer = new Map<string, { session: Session; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  create(s: Omit<Session, 'id'>): Session {
    const session = { ...s, id: randomBytes(32).toString('base64url') };
    this.sessions.set(session.id, session);
    return session;
  }

  /** The live session for `id` on `envKey`; null when absent, expired, or for another environment. */
  find(id: string | undefined, envKey: string): Session | null {
    if (!id) { return null; }
    const s = this.sessions.get(id);
    if (!s) { return null; }
    if (s.envKey !== envKey || s.expiresAt <= this.now()) {
      if (s.expiresAt <= this.now()) { this.sessions.delete(id); }
      return null;
    }
    return s;
  }

  rememberBearer(ticket: string, session: Session): void {
    this.bearer.set(hashTicket(ticket), { session, until: this.now() + BEARER_TICKET_CACHE_MS });
  }

  findBearer(ticket: string, envKey: string): Session | null {
    const hit = this.bearer.get(hashTicket(ticket));
    if (!hit) { return null; }
    if (hit.until <= this.now() || hit.session.envKey !== envKey || !this.sessions.has(hit.session.id)) {
      this.bearer.delete(hashTicket(ticket));
      return null;
    }
    return hit.session;
  }

  userIds(): string[] {
    return [...new Set([...this.sessions.values()].map((s) => s.userId))];
  }

  /** Apply ONOSOO's answer: drop sessions of non-members, and logs sessions of members who lost access. */
  applyMembership(members: Record<string, unknown>): number {
    let dropped = 0;
    for (const [id, s] of this.sessions) {
      const role = members[s.userId];
      const keep = isRole(role) && (s.scope === 'preview' || canReadLogs(role));
      if (!keep) { this.sessions.delete(id); dropped++; } else { s.role = role; }
    }
    return dropped;
  }

  /** Drop every session of an environment (it was stopped or removed). */
  dropEnvironment(envKey: string): void {
    for (const [id, s] of this.sessions) { if (s.envKey === envKey) { this.sessions.delete(id); } }
  }

  sweep(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) { if (s.expiresAt <= now) { this.sessions.delete(id); } }
    for (const [k, b] of this.bearer) { if (b.until <= now) { this.bearer.delete(k); } }
  }

  size(): number {
    return this.sessions.size;
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

export interface GatewayDeps {
  previewDomain: string;
  appUrl: string;
  appOrigins: string[];
  call: OnosooCall;
  /** The environment for a key, or undefined. */
  environment: (key: string) => EnvRecord | undefined;
  /** Status JSON for /__onosoo/status. */
  status: (key: string) => unknown;
  /** Redacted log tail. Throws with a readable message on failure. */
  logs: (key: string, service: string, lines: number) => Promise<string>;
  touch: (key: string) => void;
  sessions?: SessionStore;
  now?: () => number;
  log?: (line: string) => void;
}

function securityHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

function page(res: http.ServerResponse, status: number, title: string, body: string, appUrl: string): void {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, securityHeaders());
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222">`
    + `<h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(body)}</p>`
    + `<p><a href="${esc(appUrl)}/builds">Open Builds in ONOSOO</a></p></body>`);
}

export class Gateway {
  readonly sessions: SessionStore;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private server: http.Server | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private recheckMs = DEFAULT_RECHECK_MS;

  constructor(private readonly deps: GatewayDeps) {
    this.now = deps.now ?? Date.now;
    this.sessions = deps.sessions ?? new SessionStore(this.now);
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
  }

  listen(port: number): Promise<void> {
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket as net.Socket, head); });
    this.server.headersTimeout = 30_000;
    this.server.requestTimeout = 0; // long-lived streams (SSE) are the app's business
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
  }

  startRecheck(): void {
    this.recheckStopped = false;
    const tick = async (): Promise<void> => {
      try {
        await this.recheck();
      } finally {
        if (!this.recheckStopped) { this.recheckTimer = setTimeout(() => { void tick(); }, this.recheckMs); }
      }
    };
    this.recheckTimer = setTimeout(() => { void tick(); }, this.recheckMs);
  }

  private recheckStopped = false;

  stopRecheck(): void {
    this.recheckStopped = true;
    if (this.recheckTimer) { clearTimeout(this.recheckTimer); }
    this.recheckTimer = null;
  }

  async close(): Promise<void> {
    this.stopRecheck();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Ask ONOSOO whether each session's member is still in the workspace. Fails closed only on 401. */
  async recheck(): Promise<void> {
    this.sessions.sweep();
    const ids = this.sessions.userIds();
    for (let i = 0; i < ids.length; i += 200) {
      const r = await this.deps.call('previews/check', { user_ids: ids.slice(i, i + 200) }).catch(() => null);
      if (!r) { continue; } // network trouble: keep sessions until the next check (they expire anyway)
      if (r.status === 401) {
        // This machine was revoked: nobody gets in any more.
        this.sessions.applyMembership({});
        return;
      }
      const members = r.json?.members;
      if (r.status === 200 && members && typeof members === 'object') {
        const dropped = this.sessions.applyMembership(members as Record<string, unknown>);
        if (dropped > 0) { this.log(`moag host: closed ${dropped} preview session(s) of people no longer allowed`); }
      }
    }
  }

  private async redeem(ticket: string, envKey: string): Promise<Session | null> {
    if (!ticket.startsWith(TICKET_PREFIX) || ticket.length > 200) { return null; }
    const r = await this.deps.call('previews/redeem', { ticket }).catch(() => null);
    const j = r?.json;
    if (!r || r.status !== 200 || !j || j.env_key !== envKey || !isRole(j.role) || typeof j.user_id !== 'string') { return null; }
    const scope: Scope = j.scope === 'logs' ? 'logs' : 'preview';
    const ttl = typeof j.session_ttl === 'number' && j.session_ttl > 0 ? Math.min(j.session_ttl, 12 * 3600) : 3600;
    if (typeof j.recheck_after === 'number' && j.recheck_after >= 15 && j.recheck_after <= 600) { this.recheckMs = j.recheck_after * 1000; }
    return this.sessions.create({
      userId: j.user_id,
      userName: typeof j.user_name === 'string' ? j.user_name : 'Member',
      role: j.role,
      scope,
      envKey,
      expiresAt: this.now() + ttl * 1000,
    });
  }

  private cors(req: http.IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin || !this.deps.appOrigins.includes(origin)) { return {}; }
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const envKey = envKeyFromHost(req.headers.host, this.deps.previewDomain);
      const env = envKey ? this.deps.environment(envKey) : undefined;
      if (!envKey || !env) { return page(res, 404, 'Nothing here', 'This preview does not exist on this machine.', this.deps.appUrl); }
      const url = new URL(req.url ?? '/', 'https://gateway.local');

      if (url.pathname.startsWith('/__onosoo/')) { return await this.control(req, res, url, envKey); }

      const session = this.sessions.find(parseCookies(req.headers.cookie).get(SESSION_COOKIE), envKey);
      if (!session) {
        const wantsHtml = (req.headers.accept ?? '').includes('text/html');
        if (wantsHtml) {
          res.writeHead(302, { Location: `${this.deps.appUrl}/builds`, 'Cache-Control': 'no-store' });
          res.end();
        } else {
          res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
          res.end('Open this preview from ONOSOO.');
        }
        return;
      }
      if (!env.web || env.desired !== 'running') {
        return page(res, 503, 'Not running', 'This environment is stopped. Restart it from Builds in ONOSOO.', this.deps.appUrl);
      }
      this.deps.touch(envKey);
      this.proxy(req, res, env.port, req.headers.host ?? '');
    } catch (err) {
      this.log(`moag host: gateway error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) { page(res, 500, 'Something went wrong', 'The gateway could not handle this request.', this.deps.appUrl); } else { res.destroy(); }
    }
  }

  private async control(req: http.IncomingMessage, res: http.ServerResponse, url: URL, envKey: string): Promise<void> {
    const cors = this.cors(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, cors); res.end(); return; }

    if (url.pathname === '/__onosoo/auth') {
      const session = await this.redeem(url.searchParams.get('ticket') ?? '', envKey);
      if (!session) {
        return page(res, 403, 'This link has expired', 'Preview links work once and only for a minute. Open the preview again from ONOSOO.', this.deps.appUrl);
      }
      const maxAge = Math.max(1, Math.floor((session.expiresAt - this.now()) / 1000));
      res.writeHead(302, {
        Location: safeNext(url.searchParams.get('next')),
        'Set-Cookie': `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    // Logs and status: a session cookie (same-site, embedded) or a logs ticket as a bearer (the
    // ONOSOO app calling cross-site, where the cookie would be blocked).
    let session = this.sessions.find(parseCookies(req.headers.cookie).get(SESSION_COOKIE), envKey);
    const auth = req.headers.authorization;
    if (!session && auth?.startsWith('Bearer ')) {
      const ticket = auth.slice(7).trim();
      session = this.sessions.findBearer(ticket, envKey) ?? await this.redeem(ticket, envKey);
      if (session) { this.sessions.rememberBearer(ticket, session); }
    }
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!session) { return json(401, { error: 'Open this from ONOSOO.' }); }

    if (url.pathname === '/__onosoo/status') { return json(200, this.deps.status(envKey)); }

    if (url.pathname === '/__onosoo/logs') {
      if (!canReadLogs(session.role)) { return json(403, { error: 'Your role in this workspace cannot read logs.' }); }
      const service = url.searchParams.get('service') ?? '';
      const tailN = Number(url.searchParams.get('tail') ?? '500');
      try {
        const text = await this.deps.logs(envKey, service, tailN);
        res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(text);
      } catch (err) {
        json(400, { error: err instanceof Error ? err.message : 'Could not read the logs.' });
      }
      return;
    }
    json(404, { error: 'Not found' });
  }

  private proxy(req: http.IncomingMessage, res: http.ServerResponse, port: number, originalHost: string): void {
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers, { port, originalHost, remoteAddress: req.socket.remoteAddress, keepUpgrade: false }),
    }, (up) => {
      const headers = { ...up.headers };
      // The app must not be able to read or overwrite the gateway's session.
      const setCookie = headers['set-cookie'];
      if (setCookie) { headers['set-cookie'] = setCookie.filter((c) => !c.trim().startsWith(`${SESSION_COOKIE}=`)); }
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        page(res, 502, 'The app is not answering', 'It may still be starting. Wait a moment and reload; if it lasts, check its logs in ONOSOO.', this.deps.appUrl);
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  }

  private async upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const envKey = envKeyFromHost(req.headers.host, this.deps.previewDomain);
    const env = envKey ? this.deps.environment(envKey) : undefined;
    const session = envKey ? this.sessions.find(parseCookies(req.headers.cookie).get(SESSION_COOKIE), envKey) : null;
    if (!envKey || !env || !session || !env.web || env.desired !== 'running') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    this.deps.touch(envKey);
    const upstream = net.connect(env.port, '127.0.0.1', () => {
      const headers = forwardHeaders(req.headers, { port: env.port, originalHost: req.headers.host ?? '', remoteAddress: socket.remoteAddress, keepUpgrade: true });
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        for (const value of Array.isArray(v) ? v : [v]) { lines.push(`${k}: ${String(value)}`); }
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length > 0) { upstream.write(head); }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = (): void => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close);
    socket.on('error', close);
  }
}
