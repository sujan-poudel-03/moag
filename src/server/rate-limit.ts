// ─── Login rate limiter ───
//
// In-memory, per process. Two buckets:
//   - account+IP: `maxFailures` failures inside `windowMs` lock that pair for `lockMs`;
//   - IP alone:   `perIpMax` failures inside `windowMs` lock the IP for `lockMs`,
//                 which stops spraying one password across many usernames.
// A locked check returns 429 to the caller WITHOUT the password being checked.
//
// Concurrency: the password check is async (scrypt), so a plain check-then-fail
// lets a burst of parallel attempts all pass `check` before the first failure
// is counted. `begin` closes that gap: it synchronously reserves the attempt as
// an in-flight one that counts toward the limit, and the returned handle turns
// it into a failure, clears it on success, or releases it (cancel).
// State resets on restart — documented as a residual in the threat model.

export interface LoginRateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  lockMs?: number;
  perIpMax?: number;
  now?: () => number;
  /** Upper bound on tracked keys before old ones are pruned. */
  maxKeys?: number;
}

export interface RateCheck { allowed: boolean; retryAfterSec: number; }

/** An admitted login attempt. Exactly one of fail/succeed/cancel takes effect; later calls are no-ops. */
export interface RateAttempt {
  fail(): void;
  succeed(): void;
  /** Release the reservation without counting a failure (e.g. the request errored before a verdict). */
  cancel(): void;
}

export type RateBegin = (RateCheck & { allowed: false }) | (RateCheck & { allowed: true; attempt: RateAttempt });

interface Bucket { failures: number[]; lockedUntil: number; inFlight: number; }

export class LoginRateLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly perIpMax: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly accounts = new Map<string, Bucket>();
  private readonly ips = new Map<string, Bucket>();

  constructor(opts: LoginRateLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000;
    this.lockMs = opts.lockMs ?? 15 * 60 * 1000;
    this.perIpMax = opts.perIpMax ?? 50;
    this.now = opts.now ?? (() => Date.now());
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  /** May this login attempt proceed to password verification? */
  check(username: string, ip: string): RateCheck {
    const t = this.now();
    const waits = [this.lockRemaining(this.accounts.get(accountKey(username, ip)), t),
      this.lockRemaining(this.ips.get(ip), t)];
    const wait = Math.max(...waits);
    return wait > 0 ? { allowed: false, retryAfterSec: Math.ceil(wait / 1000) } : { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Admit one attempt, or refuse it. Admission is synchronous and counts the
   * attempt as in flight, so failures + in-flight attempts can never exceed the
   * limits however many requests arrive before the first verdict.
   */
  begin(username: string, ip: string): RateBegin {
    const locked = this.check(username, ip);
    if (!locked.allowed) { return { allowed: false, retryAfterSec: locked.retryAfterSec }; }
    const t = this.now();
    this.prune(t);
    const aKey = accountKey(username, ip);
    const a = this.bucket(this.accounts, aKey, t);
    const i = this.bucket(this.ips, ip, t);
    if (a.failures.length + a.inFlight >= this.maxFailures || i.failures.length + i.inFlight >= this.perIpMax) {
      // Enough attempts are already counted or in flight to reach the lock; refuse without verifying.
      return { allowed: false, retryAfterSec: Math.ceil(this.lockMs / 1000) };
    }
    a.inFlight++;
    i.inFlight++;
    let settled = false;
    const release = (): boolean => {
      if (settled) { return false; }
      settled = true;
      const ab = this.accounts.get(aKey);
      if (ab && ab.inFlight > 0) { ab.inFlight--; }
      const ib = this.ips.get(ip);
      if (ib && ib.inFlight > 0) { ib.inFlight--; }
      return true;
    };
    return {
      allowed: true,
      retryAfterSec: 0,
      attempt: {
        fail: () => { if (release()) { this.fail(username, ip); } },
        succeed: () => { if (release()) { this.succeed(username, ip); } },
        cancel: () => { release(); },
      },
    };
  }

  /** Record a failed attempt. */
  fail(username: string, ip: string): void {
    const t = this.now();
    this.prune(t);
    this.record(this.accounts, accountKey(username, ip), this.maxFailures, t);
    this.record(this.ips, ip, this.perIpMax, t);
  }

  /**
   * A successful login clears the account+IP failures and lock (the IP bucket
   * is left alone). Other attempts still in flight stay counted.
   */
  succeed(username: string, ip: string): void {
    const key = accountKey(username, ip);
    const b = this.accounts.get(key);
    if (!b) { return; }
    if (b.inFlight > 0) { b.failures = []; b.lockedUntil = 0; } else { this.accounts.delete(key); }
  }

  // ─── Internals ───

  private lockRemaining(b: Bucket | undefined, t: number): number {
    return b && b.lockedUntil > t ? b.lockedUntil - t : 0;
  }

  /** The bucket for `key` (created if missing) with failures outside the window dropped. */
  private bucket(map: Map<string, Bucket>, key: string, t: number): Bucket {
    let b = map.get(key);
    if (!b) { b = { failures: [], lockedUntil: 0, inFlight: 0 }; map.set(key, b); }
    b.failures = b.failures.filter((x) => t - x < this.windowMs);
    return b;
  }

  private record(map: Map<string, Bucket>, key: string, max: number, t: number): void {
    const b = this.bucket(map, key, t);
    b.failures.push(t);
    if (b.failures.length >= max) {
      b.lockedUntil = t + this.lockMs;
      b.failures = [];
    }
    map.set(key, b);
  }

  private prune(t: number): void {
    for (const map of [this.accounts, this.ips]) {
      if (map.size < this.maxKeys) { continue; }
      for (const [k, b] of map) {
        if (b.inFlight === 0 && b.lockedUntil <= t && b.failures.every((x) => t - x >= this.windowMs)) { map.delete(k); }
      }
    }
  }
}

function accountKey(username: string, ip: string): string {
  return `${String(username).trim().toLowerCase()}\u0000${ip}`;
}
