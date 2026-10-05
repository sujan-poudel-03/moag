// ─── Engine API key store ───
//
// Server-side storage for engine API keys (`secrets.json`, mode 0600 in the
// data dir). Each value is encrypted with AES-256-GCM under a key derived with
// HKDF-SHA256 from the operator's master secret (`MOAG_MASTER_KEY` or
// `MOAG_MASTER_KEY_FILE`, which must live OUTSIDE the data dir) and a random
// salt stored beside the entries. Each entry has its own 12-byte IV and is bound
// to its engine with AAD `engine:<id>`, so swapping ciphertexts between engines
// fails authentication.
//
// The browser never gets a key back: `status()` returns only whether a key is
// set, its last four characters, when it was set, and whether it can still be
// decrypted. A key is decrypted only by `decryptFor()`, which the server calls
// when building the environment of a job whose plan references that engine.
//
// Threat model (docs/server.md): this protects keys at rest in the data volume
// and in backups that do not also carry the master secret. It does NOT protect
// keys from an agent: agents run as the server's OS user, and the decrypted key
// is in the agent's own environment by design.

import * as fs from 'fs';
import * as path from 'path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { EngineId } from '../models/types';
import { writeFileAtomicSync } from '../utils/file-io';

export const SECRETS_FILE = 'secrets.json';
export const HKDF_INFO = 'moag-engine-keys-v1';
const SALT_BYTES = 16;
const IV_BYTES = 12;
/** Printable ASCII, no spaces: API keys are tokens, and this keeps control characters out of a child env. */
export const API_KEY_RE = /^[\x21-\x7e]{8,512}$/;

/**
 * Engines whose credentials the server stores, and the env var each is injected
 * as. Closed map: S3 covers `anthropic` only.
 */
export const KEYED_ENGINE_ENV: Readonly<Partial<Record<EngineId, string>>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
});

/** Engines in {@link KEYED_ENGINE_ENV}. */
export const KEYED_ENGINES: readonly EngineId[] = Object.freeze(Object.keys(KEYED_ENGINE_ENV) as EngineId[]);

/** True when `value` is an engine whose key the server stores. */
export function isKeyedEngine(value: unknown): value is EngineId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KEYED_ENGINE_ENV, value);
}

/** What the API may say about a stored key. Never the key itself. */
export interface KeyStatus {
  set: boolean;
  /** Last four characters, for recognition only. */
  last4: string | null;
  updatedAt: string | null;
  /** False when an entry exists but cannot be decrypted (tampered file or wrong master key). */
  readable: boolean;
}

/** Setting a key without a configured master secret. */
export class NoMasterKeyError extends Error {
  constructor() { super('No master key is configured (MOAG_MASTER_KEY_FILE), so API keys cannot be stored.'); this.name = 'NoMasterKeyError'; }
}

interface SecretEntry { iv: string; tag: string; ct: string; last4: string; updatedAt: string; }
interface SecretsFile { schemaVersion: 1; salt: string; entries: Record<string, SecretEntry>; }

export class SecretStore {
  private readonly file: string;

  constructor(dataDir: string, private readonly masterKey: Buffer | null, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(dataDir, SECRETS_FILE);
  }

  /** Whether keys can be stored and read at all. */
  hasMasterKey(): boolean { return this.masterKey !== null && this.masterKey.length > 0; }

  /** Encrypt and store `value` for `engine`. Throws NoMasterKeyError / on a non-keyed engine or malformed key. */
  set(engine: EngineId, value: string): KeyStatus {
    if (!isKeyedEngine(engine)) { throw new Error(`"${engine}" has no stored key`); }
    if (!API_KEY_RE.test(value)) { throw new Error('The key must be 8-512 printable characters without spaces.'); }
    if (!this.hasMasterKey()) { throw new NoMasterKeyError(); }
    const doc = this.read() ?? { schemaVersion: 1, salt: randomBytes(SALT_BYTES).toString('base64'), entries: {} };
    const key = this.deriveKey(doc.salt);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aadFor(engine));
    const ct = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    doc.entries[engine] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
      last4: value.slice(-4),
      updatedAt: this.now().toISOString(),
    };
    this.write(doc);
    return this.status(engine);
  }

  /** Remove the key for `engine`. Returns false when none was set. */
  clear(engine: EngineId): boolean {
    const doc = this.read();
    if (!doc || !doc.entries[engine]) { return false; }
    delete doc.entries[engine];
    this.write(doc);
    return true;
  }

  /** Public status for `engine`. Never throws. */
  status(engine: EngineId): KeyStatus {
    const e = this.read()?.entries[engine];
    if (!e) { return { set: false, last4: null, updatedAt: null, readable: false }; }
    return {
      set: true,
      last4: typeof e.last4 === 'string' ? e.last4.slice(-4) : null,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
      readable: this.decrypt(engine) !== null,
    };
  }

  /**
   * Env-var name → plaintext for every keyed engine in `engines` that has a
   * readable key. Unreadable or missing keys are simply absent. Never throws.
   */
  decryptFor(engines: Iterable<EngineId>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const engine of new Set(engines)) {
      const envName = KEYED_ENGINE_ENV[engine];
      if (!envName) { continue; }
      const v = this.decrypt(engine);
      if (v !== null) { out[envName] = v; }
    }
    return out;
  }

  // ─── Internals ───

  private decrypt(engine: EngineId): string | null {
    if (!this.hasMasterKey()) { return null; }
    const doc = this.read();
    const e = doc?.entries[engine];
    if (!doc || !e) { return null; }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.deriveKey(doc.salt), Buffer.from(e.iv, 'base64'));
      decipher.setAAD(aadFor(engine));
      decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(e.ct, 'base64')), decipher.final()]).toString('utf-8');
    } catch {
      return null;
    }
  }

  private deriveKey(saltB64: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.masterKey as Buffer, Buffer.from(saltB64, 'base64'), HKDF_INFO, 32));
  }

  private read(): SecretsFile | null {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch { return null; }
    try {
      const doc = JSON.parse(raw) as Partial<SecretsFile>;
      if (!doc || typeof doc !== 'object' || typeof doc.salt !== 'string' || !doc.entries || typeof doc.entries !== 'object') { return null; }
      return { schemaVersion: 1, salt: doc.salt, entries: doc.entries as Record<string, SecretEntry> };
    } catch {
      return null;
    }
  }

  private write(doc: SecretsFile): void {
    writeFileAtomicSync(this.file, JSON.stringify(doc, null, 2), 0o600);
  }
}

function aadFor(engine: EngineId): Buffer {
  return Buffer.from(`engine:${engine}`, 'utf-8');
}
