// ─── Engine status (admin Engines screen, run-start availability) ───
//
// Which engine CLIs are installed on this server is learned ONLY from a probe
// job: a worker child process that runs the existing `checkEngineAvailability`
// (`--version` probing) under the headless shim and reports a `probe-result`
// line. The server never loads that code itself (it imports `vscode`). The
// result is cached here; the probe runs at boot and on an admin's re-check.
//
// No live provider calls are made, so CLI auth is always reported as
// `'unknown'`. `anthropic` is an API engine: its status is whether a key is
// stored (and still decryptable). `copilot` and `custom` are not supported in
// the web app.

import { EngineId } from '../models/types';
import { ProbeRow } from './worker-protocol';
import { KeyStatus, isKeyedEngine } from './secrets';
import { SERVER_FORBIDDEN_ENGINES } from './prd-ops';

/**
 * Engines the probe job checks — the same list as `ENGINE_PRIORITY` in
 * `src/engine-detection.ts` (which cannot be imported here: it imports `vscode`).
 * A unit test pins the two together.
 */
export const PROBED_ENGINES: readonly EngineId[] = Object.freeze(['claude', 'codex', 'gemini', 'ollama'] as EngineId[]);

/** Rows on the Engines screen, in display order. */
export const ENGINE_ROW_ORDER: readonly EngineId[] = Object.freeze([...PROBED_ENGINES, 'anthropic', 'copilot', 'custom'] as EngineId[]);

/** A probe that has not reported within this window is stopped and recorded as failed. */
export const PROBE_TIMEOUT_MS = 60_000;

export interface ProbeSnapshot {
  /** When the last probe finished; null = never. */
  checkedAt: string | null;
  inProgress: boolean;
  /** Set when the last probe failed as a whole (no result). */
  error: string | null;
  rows: ProbeRow[];
}

export type EngineAuth = 'unknown' | 'key-set' | 'key-not-set' | 'key-unreadable' | 'not-applicable';

/** One row of `GET /api/admin/engines`. Never carries a key, only its {@link KeyStatus}. */
export interface EngineRow {
  id: EngineId;
  kind: 'cli' | 'api';
  supported: boolean;
  /** CLI: installed per the last probe (null = not probed yet). API: key usable. Unsupported: false. */
  available: boolean | null;
  version: string | null;
  error: string | null;
  auth: EngineAuth;
  key?: KeyStatus;
}

/** Cache of the last engine probe. */
export class EngineStatusCache {
  private snap: ProbeSnapshot = { checkedAt: null, inProgress: false, error: null, rows: [] };

  constructor(private readonly now: () => Date = () => new Date()) {}

  snapshot(): ProbeSnapshot { return { ...this.snap, rows: this.snap.rows.map((r) => ({ ...r })) }; }

  begin(): void { this.snap = { ...this.snap, inProgress: true }; }

  /** Record a probe result. Rows for engines outside {@link PROBED_ENGINES} are dropped. */
  record(rows: readonly ProbeRow[]): void {
    const byId = new Map(rows.filter((r) => PROBED_ENGINES.includes(r.id)).map((r) => [r.id, r]));
    this.snap = {
      checkedAt: this.now().toISOString(),
      inProgress: false,
      error: null,
      rows: PROBED_ENGINES.map((id) => byId.get(id) ?? { id, available: false, error: 'Not reported by the probe.' }),
    };
  }

  /** The probe ended without a result: every probed engine counts as unavailable. */
  fail(error: string): void {
    const msg = error.trim().slice(-500) || 'The engine probe failed.';
    this.snap = {
      checkedAt: this.now().toISOString(),
      inProgress: false,
      error: msg,
      rows: PROBED_ENGINES.map((id) => ({ id, available: false, error: msg })),
    };
  }

  /**
   * Is `engine` usable for a job on this server? `undefined` = unknown (no
   * probe has finished yet). API engines are usable when their key is stored
   * and decryptable.
   */
  isAvailable(engine: EngineId, keyStatus: (e: EngineId) => KeyStatus): boolean | undefined {
    if (SERVER_FORBIDDEN_ENGINES.includes(engine)) { return false; }
    if (isKeyedEngine(engine)) { const k = keyStatus(engine); return k.set && k.readable; }
    if (!PROBED_ENGINES.includes(engine) || this.snap.checkedAt === null) { return undefined; }
    return this.snap.rows.find((r) => r.id === engine)?.available === true;
  }
}

/** Build the Engines screen rows from the probe cache and the key store. Pure. */
export function buildEngineRows(snap: ProbeSnapshot, keyStatus: (e: EngineId) => KeyStatus): EngineRow[] {
  return ENGINE_ROW_ORDER.map((id): EngineRow => {
    if (SERVER_FORBIDDEN_ENGINES.includes(id)) {
      return { id, kind: 'cli', supported: false, available: false, version: null, error: null, auth: 'not-applicable' };
    }
    if (isKeyedEngine(id)) {
      const key = keyStatus(id);
      const auth: EngineAuth = !key.set ? 'key-not-set' : key.readable ? 'key-set' : 'key-unreadable';
      return { id, kind: 'api', supported: true, available: key.set && key.readable, version: null, error: null, auth, key };
    }
    const row = snap.rows.find((r) => r.id === id);
    return {
      id, kind: 'cli', supported: true,
      available: snap.checkedAt === null ? null : row?.available === true,
      version: row?.version ?? null,
      error: row?.error ?? null,
      auth: 'unknown',
    };
  });
}
