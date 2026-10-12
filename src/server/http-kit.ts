// ─── Minimal HTTP toolkit over node:http ───
//
// Body parsing with a hard size cap, JSON responses, cookie parsing, client-IP
// resolution, security headers and a tiny `:param` router. No framework: the
// server's whole job is guarding remote code execution, so every dependency we
// do not take is supply-chain surface we do not have.

import { IncomingMessage, ServerResponse } from 'http';
import { ValidationError } from './validate';

export const MAX_BODY_BYTES = 1024 * 1024;
export const PARAM_RE = /^[A-Za-z0-9-]{1,64}$/;

/** An error that maps directly to an HTTP response. `code` is a stable machine-readable reason. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

/**
 * Read and parse a JSON request body. 415 unless `Content-Type` is
 * `application/json`; 413 past `maxBytes`; 400 on invalid JSON. An empty body
 * parses as `{}`.
 */
export function readJsonBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    req.resume();
    return Promise.reject(new HttpError(415, 'unsupported-media-type', 'Content-Type must be application/json'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new HttpError(413, 'payload-too-large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) { return; }
      done = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      if (err) { reject(err); } else { resolve(value); }
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.resume(); // drain without buffering
        finish(new HttpError(413, 'payload-too-large'));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.trim() === '') { finish(null, {}); return; }
      try { finish(null, JSON.parse(text)); } catch { finish(new HttpError(400, 'invalid-json', 'Request body is not valid JSON')); }
    };
    const onError = (e: Error) => finish(e);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** Send a JSON response. Safe to call on an already-ended response (no-op). */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (res.writableEnded) { return; }
  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    for (const [k, v] of Object.entries(headers)) { res.setHeader(k, v); }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(payload));
  }
  res.end(payload);
}

/** Map any thrown value to a response. Never leaks a stack trace. */
export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra ?? {}) });
  } else if (err instanceof ValidationError) {
    sendJson(res, 400, { error: 'invalid-input', message: err.message, field: err.field });
  } else {
    sendJson(res, 500, { error: 'internal', message: 'Internal server error' });
  }
}

/** Parse a `Cookie` header. Malformed pairs are skipped; the first occurrence of a name wins. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header) { return out; }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) { continue; }
    const name = part.slice(0, eq).trim();
    if (!name || name in out) { continue; }
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) { value = value.slice(1, -1); }
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

/**
 * The client's IP. `X-Forwarded-For` is honoured only when the operator says a
 * trusted reverse proxy is in front (`MOAG_TRUST_PROXY=1`), and then only its
 * RIGHTMOST hop — the one our proxy appended; everything left of it is
 * client-supplied.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    if (raw) {
      const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length > 0) { return hops[hops.length - 1]; }
    }
  }
  return req.socket?.remoteAddress ?? '';
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** Headers sent on every response. */
export function securityHeaders(opts: { secure: boolean; api: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  if (opts.secure) { h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'; }
  if (opts.api) { h['Cache-Control'] = 'no-store'; }
  return h;
}

// ─── Router ───

export type RouteParams = Record<string, string>;

interface CompiledRoute<H> { method: string; segments: string[]; handler: H; }

export type RouteMatch<H> =
  | { kind: 'found'; handler: H; params: RouteParams }
  | { kind: 'method-not-allowed'; allowed: string[] }
  | { kind: 'not-found' };

/**
 * Exact-segment router with `:param` placeholders. A parameter value must match
 * {@link PARAM_RE}; anything else (dots, slashes, encoded traversal) is a 404.
 */
export class Router<H> {
  private readonly routes: CompiledRoute<H>[] = [];

  add(method: string, pattern: string, handler: H): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
  }

  match(method: string, pathname: string): RouteMatch<H> {
    const segs = splitPath(pathname);
    const allowed: string[] = [];
    for (const r of this.routes) {
      const params = matchSegments(r.segments, segs);
      if (!params) { continue; }
      if (r.method === method.toUpperCase()) { return { kind: 'found', handler: r.handler, params }; }
      allowed.push(r.method);
    }
    return allowed.length > 0 ? { kind: 'method-not-allowed', allowed } : { kind: 'not-found' };
  }
}

function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): RouteParams | null {
  if (pattern.length !== actual.length) { return null; }
  const params: RouteParams = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(':')) {
      if (!PARAM_RE.test(actual[i])) { return null; }
      params[p.slice(1)] = actual[i];
    } else if (p !== actual[i]) {
      return null;
    }
  }
  return params;
}
