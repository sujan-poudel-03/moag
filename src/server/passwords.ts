// ─── Password hashing (scrypt) ───
//
// Format: `scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>`. Node's built-in
// `crypto.scrypt` — no native dependency. Verification is constant-time over
// equal-length buffers, and a malformed stored hash verifies as false rather
// than throwing. Concurrent scrypt computations are capped (each one holds
// ~32 MB) so a login burst cannot exhaust memory.

import * as crypto from 'crypto';

export const SCRYPT_LOG_N = 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
export const SCRYPT_SALT_BYTES = 16;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const SCRYPT_MAX_CONCURRENCY = 4;
/** Waiters allowed to queue for a slot before login is refused as busy (see {@link isScryptSaturated}). */
export const SCRYPT_MAX_WAITERS = 16;

// Parameter bounds accepted when parsing a stored hash, so a tampered record
// cannot make verification arbitrarily expensive.
const LOG_N_RANGE = [10, 20] as const;
const R_RANGE = [1, 16] as const;
const P_RANGE = [1, 4] as const;

/**
 * A well-formed hash of no known password, verified against when the username
 * does not exist so that unknown and known users take the same time.
 */
export const DUMMY_HASH =
  'scrypt$15$8$1$AAECAwQFBgcICQoLDA0ODw==$'
  + 'O6X15WVyEJbKhh3gvvlD1dLZ9waiRMDvM5lw3p8GPpBfNgoQ85L517O3c/U/JQ28PzqiqtEFMheqC0yPT+HcfQ==';

// ─── Semaphore ───

let active = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= SCRYPT_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) { next(); } else { active--; }
  }
}

/**
 * True when every slot is busy AND the wait queue is full. The login route
 * checks this synchronously and answers 503 instead of queueing without bound.
 */
export function isScryptSaturated(): boolean {
  return active >= SCRYPT_MAX_CONCURRENCY && waiters.length >= SCRYPT_MAX_WAITERS;
}

/** Current number of in-flight scrypt computations (for tests/metrics). */
export function activeScryptCount(): number {
  return active;
}

function scryptAsync(password: string, salt: Buffer, logN: number, r: number, p: number, keylen: number): Promise<Buffer> {
  const N = 2 ** logN;
  return withSlot(() => new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) => {
      if (err) { reject(err); } else { resolve(key); }
    });
  }));
}

// ─── Public API ───

/** Hash a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const key = await scryptAsync(password, salt, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN);
  return ['scrypt', SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

interface ParsedHash { logN: number; r: number; p: number; salt: Buffer; key: Buffer; }

function inRange(n: number, [lo, hi]: readonly [number, number]): boolean {
  return Number.isInteger(n) && n >= lo && n <= hi;
}

function parseHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string' || stored.length > 1024) { return null; }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') { return null; }
  const [logN, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!inRange(logN, LOG_N_RANGE) || !inRange(r, R_RANGE) || !inRange(p, P_RANGE)) { return null; }
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!b64.test(parts[4]) || !b64.test(parts[5])) { return null; }
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || key.length < 16 || key.length > 128) { return null; }
  return { logN, r, p, salt, key };
}

/**
 * Verify `password` against a stored hash. Returns false (never throws) for a
 * wrong password, a malformed hash, or a non-string input.
 */
export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  if (typeof password !== 'string') { return false; }
  const parsed = parseHash(stored);
  if (!parsed) { return false; }
  try {
    const key = await scryptAsync(password, parsed.salt, parsed.logN, parsed.r, parsed.p, parsed.key.length);
    if (key.length !== parsed.key.length) { return false; }
    return crypto.timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/** Return an error message when `password` violates the policy, else null. */
export function validatePasswordPolicy(password: unknown): string | null {
  if (typeof password !== 'string') { return 'Password is required.'; }
  const len = [...password].length;
  if (len < PASSWORD_MIN_LENGTH) { return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`; }
  if (len > PASSWORD_MAX_LENGTH) { return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`; }
  return null;
}
