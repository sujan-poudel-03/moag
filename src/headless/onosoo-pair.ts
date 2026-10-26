// ─── ONOSOO pairing — save a device key, check it, remove it ───
//
// One step instead of hand-editing onosoo.json: `moag pair` and the VS Code
// Connect / Disconnect commands both come through here.
//
//   writePairing   validate, merge into <configDir>/moag/onosoo.json (0600,
//                  atomic, device_id kept), discard the spool when the key
//                  changed, lock the folder down on Windows
//   checkPairing   one liveness POST with no events: accepted / refused /
//                  unverified
//   removePairing  drop key and url, keep device_id, discard the spool
//
// The key never appears in a message, an error, or any file but onosoo.json.
// Pairing writes the file BEFORE checking, so an unreachable ONOSOO still pairs.
// Imports nothing that loads `vscode`.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { API_KEY_RE } from '../shared/engine-keys';
import { writeFileAtomicSync } from '../utils/file-io';
import { execFileAsync } from '../utils/exec-file';
import { DEFAULT_ONOSOO_URL, endpointFor, OnosooConfig, userConfigDir } from './onosoo-config';
import { defaultHttpClient, readMoagVersion, RelayHttpClient } from './onosoo-relay';

/** A pairing input was refused. The message never contains the key. */
export class PairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairError';
  }
}

/** Where the pairing lives, for the injected env/platform/home. */
export interface PairingLocation {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

export interface WritePairingOptions extends PairingLocation {
  key: string;
  /** Base URL; DEFAULT_ONOSOO_URL when omitted. */
  url?: string;
  /** Runs icacls on Windows; injectable for tests. */
  exec?: typeof execFileAsync;
}

export interface WritePairingResult {
  /** The onosoo.json that was written. */
  file: string;
  /** True when a different key was saved before. */
  keyChanged: boolean;
  /** Spool run files discarded because the key changed. */
  spoolDiscarded: number;
  /** Windows: whether the user-only ACL was applied; 'n/a' elsewhere. */
  aclApplied: boolean | 'n/a';
  /**
   * What checkPairing needs, from what was just saved. Not re-resolved through
   * resolveOnosooConfig, which refuses when the working folder contains the
   * config folder (`moag pair` run from the home directory).
   */
  saved: Pick<OnosooConfig, 'key' | 'endpoint' | 'deviceId'>;
}

/** What a liveness check concluded. */
export type PairingCheck = 'accepted' | 'refused' | { unverified: string };

/** How long the liveness POST may take. */
export const PAIR_CHECK_TIMEOUT_MS = 15_000;

function stateDirFor(o: PairingLocation): string {
  return path.join(userConfigDir(o.env, o.platform ?? process.platform, o.homedir ?? os.homedir), 'moag');
}

function readFile(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Unsent events in the spool (lines past each run's ack), and the run files holding them. */
export function spoolBacklog(stateDir: string): { runs: number; events: number } {
  let runs = 0;
  let events = 0;
  const root = path.join(stateDir, 'onosoo-spool');
  let workspaces: string[];
  try { workspaces = fs.readdirSync(root); } catch { return { runs, events }; }
  for (const ws of workspaces) {
    let names: string[];
    try { names = fs.readdirSync(path.join(root, ws)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || name.endsWith('.rejected.jsonl')) { continue; }
      runs++;
      try {
        const lines = fs.readFileSync(path.join(root, ws, name), 'utf-8').split('\n').filter((l) => l.trim().length > 0);
        // First line is the meta header; the rest are events with seq 1..n.
        const total = Math.max(0, lines.length - 1);
        let acked = 0;
        try {
          const a = JSON.parse(fs.readFileSync(path.join(root, ws, name.replace(/\.jsonl$/, '.ack')), 'utf-8')) as { acked?: unknown };
          if (typeof a.acked === 'number' && Number.isFinite(a.acked)) { acked = a.acked; }
        } catch { /* no ack yet */ }
        events += Math.max(0, total - acked);
      } catch { /* unreadable run file: counted as a run, no events */ }
    }
  }
  return { runs, events };
}

/** Remove the whole spool; returns how many run files were in it. */
function discardSpool(stateDir: string): number {
  const { runs } = spoolBacklog(stateDir);
  try { fs.rmSync(path.join(stateDir, 'onosoo-spool'), { recursive: true, force: true }); } catch { /* best effort */ }
  return runs;
}

/** Validate the inputs; throws PairError. Returns the base URL to save. */
function validate(key: string, url: string | undefined): string {
  if (typeof key !== 'string' || !API_KEY_RE.test(key)) {
    throw new PairError('That is not a device key: it must be 8-512 printable characters with no spaces.');
  }
  const base = url ?? DEFAULT_ONOSOO_URL;
  if (!endpointFor(base)) {
    throw new PairError('The ONOSOO URL must be https (http only for localhost), with no query, fragment or credentials.');
  }
  return base;
}

/**
 * Would saving `key` replace a different saved key, and how much would that discard?
 * Lets a UI ask before writePairing drops the spool.
 */
export function inspectPairing(o: PairingLocation & { key: string }): { keyChanged: boolean; unsentEvents: number } {
  const stateDir = stateDirFor(o);
  const old = readFile(path.join(stateDir, 'onosoo.json')).key;
  const keyChanged = typeof old === 'string' && old.length > 0 && old !== o.key;
  return { keyChanged, unsentEvents: keyChanged ? spoolBacklog(stateDir).events : 0 };
}

/**
 * Save a pairing. Validates first (PairError, nothing written), then merges
 * `key` and `url` into onosoo.json keeping `device_id`. A changed key discards
 * the spool, so the old pairing's unsent events never replay under the new key.
 */
export async function writePairing(o: WritePairingOptions): Promise<WritePairingResult> {
  const url = validate(o.key, o.url);
  const platform = o.platform ?? process.platform;
  const stateDir = stateDirFor(o);
  const file = path.join(stateDir, 'onosoo.json');

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const existing = readFile(file);
  const keyChanged = typeof existing.key === 'string' && existing.key.length > 0 && existing.key !== o.key;
  // The device id is kept; a first pairing gets one now, as resolveOnosooConfig would.
  const deviceId = typeof existing.device_id === 'string' && existing.device_id.length > 0 ? existing.device_id : randomUUID();
  writeFileAtomicSync(file, JSON.stringify({ ...existing, key: o.key, url, device_id: deviceId }, null, 2), 0o600);

  const spoolDiscarded = keyChanged ? discardSpool(stateDir) : 0;

  let aclApplied: boolean | 'n/a' = 'n/a';
  if (platform === 'win32') {
    // On the folder, not the file: the next atomic rename (device id) would drop a file ACL.
    aclApplied = await restrictWindowsDir(stateDir, o.env, o.exec ?? execFileAsync);
  }
  const endpoint = endpointFor(url) as string; // validated above
  return { file, keyChanged, spoolDiscarded, aclApplied, saved: { key: o.key, endpoint, deviceId } };
}

/** Grant only the current user on `dir` (inheritance off). Never throws. */
async function restrictWindowsDir(dir: string, env: NodeJS.ProcessEnv, exec: typeof execFileAsync): Promise<boolean> {
  let user = env.USERNAME;
  if (!user) {
    try { user = os.userInfo().username; } catch { return false; }
  }
  const principal = env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
  try {
    const r = await exec('icacls', [dir, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`], { timeoutMs: 15_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Remove the pairing: drop `key` and `url`, keep `device_id`, discard the spool.
 * Returns the file, or null when there was nothing to remove.
 */
export function removePairing(o: PairingLocation): { file: string; spoolDiscarded: number } | null {
  const stateDir = stateDirFor(o);
  const file = path.join(stateDir, 'onosoo.json');
  if (!fs.existsSync(file)) { return null; }
  const existing = readFile(file);
  const rest: Record<string, unknown> = { ...existing };
  delete rest.key;
  delete rest.url;
  writeFileAtomicSync(file, JSON.stringify(rest, null, 2), 0o600);
  return { file, spoolDiscarded: discardSpool(stateDir) };
}

/**
 * Ask ONOSOO whether it accepts the key: one POST of the protocol envelope with
 * no events. 2xx → accepted, 401/403 → refused, anything else (or a network
 * failure, or the 15 s timeout) → unverified with a reason. Never throws.
 */
export async function checkPairing(
  cfg: Pick<OnosooConfig, 'key' | 'endpoint' | 'deviceId'>,
  http: RelayHttpClient = defaultHttpClient,
): Promise<PairingCheck> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PAIR_CHECK_TIMEOUT_MS);
  try {
    const res = await http({
      url: cfg.endpoint,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ protocol: 1, device_id: cfg.deviceId, moag_version: readMoagVersion(), events: [] }),
      signal: ac.signal,
      timeoutMs: PAIR_CHECK_TIMEOUT_MS,
    });
    if (res.status >= 200 && res.status < 300) { return 'accepted'; }
    if (res.status === 401 || res.status === 403) { return 'refused'; }
    return { unverified: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A network error message never carries the key, but keep it short and plain.
    return { unverified: ac.signal.aborted ? 'timed out' : msg.split('\n')[0].slice(0, 120).split(cfg.key).join('[key]') };
  } finally {
    clearTimeout(timer);
  }
}
