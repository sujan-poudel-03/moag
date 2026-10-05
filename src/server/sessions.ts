// ─── Sessions and cookies ───
//
// A session id is 32 random bytes (base64url). Only its SHA-256 is stored, so a
// leaked `sessions.json` cannot be replayed as cookies. Each session carries a
// synchronizer CSRF token and the user's `sessionEpoch` at creation: when the
// user's epoch moves on (role change, disable, password set) the session dies.

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { writeFileAtomicSync } from '../utils/file-io';

export const SESSIONS_FILE = 'sessions.json';
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const PRE_AUTH_MAX_AGE_SEC = 60 * 60;
/** lastSeen is persisted at most this often per session (it is kept exact in memory). */
const LAST_SEEN_PERSIST_MS = 60 * 1000;

export interface SessionRecord {
  sidHash: string;
  userId: string;
  csrfToken: string;
  epoch: number;
  createdAt: number;
  lastSeen: number;
}

/** The minimum a session check needs to know about the user. */
export interface SessionUser { id: string; sessionEpoch: number; disabled: boolean; }

interface SessionsFile { schemaVersion: 1; sessions: SessionRecord[]; }

export interface SessionStoreOptions {
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
}

/** SHA-256 hex of a session id — the only form ever stored. */
export function hashSid(sid: string): string {
  return createHash('sha256').update(sid, 'utf-8').digest('hex');
}

/** Constant-time string equality (via fixed-length digests, so lengths may differ). */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) { return false; }
  const da = createHash('sha256').update(a, 'utf-8').digest();
  const db = createHash('sha256').update(b, 'utf-8').digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

export class SessionStore {
  private readonly filePath: string;
  private sessions = new Map<string, SessionRecord>();
  private lastPersisted = new Map<string, number>();
  private readonly revokeListeners = new Set<(sidHashes: string[]) => void>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;

  constructor(dataDir: string, opts: SessionStoreOptions = {}) {
    this.filePath = path.join(dataDir, SESSIONS_FILE);
    this.now = opts.now ?? (() => Date.now());
    this.idleMs = opts.idleMs ?? SESSION_IDLE_MS;
    this.absoluteMs = opts.absoluteMs ?? SESSION_ABSOLUTE_MS;
    this.load();
  }

  /** Create a session for `user`. The returned `sid` goes in the cookie and is never stored. */
  create(user: SessionUser): { sid: string; csrfToken: string } {
    this.pruneExpired();
    const sid = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const t = this.now();
    const rec: SessionRecord = { sidHash: hashSid(sid), userId: user.id, csrfToken, epoch: user.sessionEpoch, createdAt: t, lastSeen: t };
    this.sessions.set(rec.sidHash, rec);
    this.lastPersisted.set(rec.sidHash, t);
    this.save();
    return { sid, csrfToken };
  }

  /**
   * Resolve a cookie value to a live session. Returns null (and deletes the
   * session) when it is idle-expired, past its absolute lifetime, belongs to a
   * missing or disabled user, or the user's epoch has moved on.
   */
  get(sid: unknown, lookupUser: (id: string) => SessionUser | undefined): SessionRecord | null {
    if (typeof sid !== 'string' || sid.length === 0 || sid.length > 128) { return null; }
    const key = hashSid(sid);
    const rec = this.sessions.get(key);
    if (!rec) { return null; }
    const t = this.now();
    const user = lookupUser(rec.userId);
    if (
      t - rec.lastSeen > this.idleMs
      || t - rec.createdAt > this.absoluteMs
      || !user || user.disabled || user.sessionEpoch !== rec.epoch
    ) {
      this.sessions.delete(key);
      this.lastPersisted.delete(key);
      this.save();
      this.notifyRevoked([key]);
      return null;
    }
    rec.lastSeen = t;
    if (t - (this.lastPersisted.get(key) ?? 0) >= LAST_SEEN_PERSIST_MS) {
      this.lastPersisted.set(key, t);
      this.save();
    }
    return { ...rec };
  }

  destroy(sid: unknown): void {
    if (typeof sid !== 'string') { return; }
    const key = hashSid(sid);
    if (this.sessions.delete(key)) {
      this.lastPersisted.delete(key);
      this.save();
      this.notifyRevoked([key]);
    }
  }

  destroyAllForUser(userId: string): number {
    const gone: string[] = [];
    for (const [k, r] of this.sessions) {
      if (r.userId === userId) { this.sessions.delete(k); this.lastPersisted.delete(k); gone.push(k); }
    }
    if (gone.length > 0) { this.save(); this.notifyRevoked(gone); }
    return gone.length;
  }

  /**
   * Is `sidHash` still a live session for a usable user? Unlike {@link get}
   * it never touches `lastSeen` (a long-lived stream must not keep a session
   * from idling out) and never deletes; expiry is applied the same way.
   */
  isLive(sidHash: string, lookupUser: (id: string) => SessionUser | undefined): boolean {
    const rec = this.sessions.get(sidHash);
    if (!rec) { return false; }
    const t = this.now();
    const user = lookupUser(rec.userId);
    return t - rec.lastSeen <= this.idleMs && t - rec.createdAt <= this.absoluteMs
      && !!user && !user.disabled && user.sessionEpoch === rec.epoch;
  }

  /** Be told (by sid hash) whenever sessions end: logout, revocation or expiry. Returns a disposer. */
  onRevoke(listener: (sidHashes: string[]) => void): () => void {
    this.revokeListeners.add(listener);
    return () => { this.revokeListeners.delete(listener); };
  }

  /** Number of stored sessions (tests/metrics). */
  size(): number { return this.sessions.size; }

  // ─── Internals ───

  private notifyRevoked(sidHashes: string[]): void {
    for (const l of [...this.revokeListeners]) {
      try { l(sidHashes); } catch { /* a listener never breaks session bookkeeping */ }
    }
  }

  private pruneExpired(): void {
    const t = this.now();
    for (const [k, r] of this.sessions) {
      if (t - r.lastSeen > this.idleMs || t - r.createdAt > this.absoluteMs) {
        this.sessions.delete(k);
        this.lastPersisted.delete(k);
      }
    }
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<SessionsFile>;
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.sessions)) {
        for (const s of parsed.sessions) {
          if (s && typeof s.sidHash === 'string' && typeof s.userId === 'string') {
            this.sessions.set(s.sidHash, s);
            this.lastPersisted.set(s.sidHash, s.lastSeen);
          }
        }
      }
    } catch {
      // Missing or corrupt: everyone signs in again. Fail-closed.
    }
  }

  private save(): void {
    const file: SessionsFile = { schemaVersion: 1, sessions: [...this.sessions.values()] };
    writeFileAtomicSync(this.filePath, JSON.stringify(file), 0o600);
  }
}

// ─── Cookies ───

/** `__Host-` requires Secure, so the prefix is only used on https deployments. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-moag_sid' : 'moag_sid';
}

export function preAuthCookieName(secure: boolean): string {
  return secure ? '__Host-moag_pre' : 'moag_pre';
}

function cookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  const parts = [`${name}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (secure) { parts.push('Secure'); }
  return parts.join('; ');
}

/** Set-Cookie value for a new session. */
export function sessionCookie(sid: string, secure: boolean): string {
  return cookie(sessionCookieName(secure), sid, Math.floor(SESSION_ABSOLUTE_MS / 1000), secure);
}

/** Set-Cookie value that removes the session cookie. */
export function clearSessionCookie(secure: boolean): string {
  return cookie(sessionCookieName(secure), '', 0, secure);
}

/**
 * Set-Cookie value for the pre-auth double-submit token (login/bootstrap CSRF).
 * HttpOnly is fine: the browser learns the token from the JSON body of
 * `GET /api/session` and echoes it in `X-CSRF-Token`; the server compares it to
 * this cookie.
 */
export function preAuthCookie(token: string, secure: boolean): string {
  return cookie(preAuthCookieName(secure), token, PRE_AUTH_MAX_AGE_SEC, secure);
}

/** A fresh random pre-auth token. */
export function newPreAuthToken(): string {
  return randomBytes(32).toString('base64url');
}
