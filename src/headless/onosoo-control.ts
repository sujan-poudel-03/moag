// ─── ONOSOO control client (stage 2) ───
//
// The daemon's side of PROTOCOL.md §2 (commands) and the capabilities part of §1:
//
//   POST builds/commands/poll         { kinds: [...] }          → { commands: [...] }
//   POST builds/commands/<id>/result  { status, message, run_id? }
//   POST builds/events                { protocol: 1, device_id, moag_version, events: [], capabilities }
//
// Polling counts as liveness, so this client NEVER sends a `heartbeat` field — only a
// per-run relay does that, and only with its own run id.
//
// Errors follow the protocol table: 401/403 stop everything (the key is revoked or
// wrong; printed once), 429 waits `retry_after`, 5xx and network failures back off
// 5 s → 5 min (reset by any 2xx), 400 on poll is logged once and polling stops.
// Imports nothing that loads `vscode`.

import type { OnosooConfig } from './onosoo-config';
import { EVENTS_PATH } from './onosoo-config';
import {
  BACKOFF_MAX_MS, BACKOFF_START_MS, defaultHttpClient, readMoagVersion, RelayHttpClient, REQUEST_TIMEOUT_MS, REVOKED_MESSAGE,
} from './onosoo-relay';

/** The command kinds the MOAG daemon handles (the host agent asks for its own). */
export const DAEMON_COMMAND_KINDS = ['stop', 'retry', 'approve', 'skip', 'start-run'] as const;

const COMMAND_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** A command as polled. A malformed one with a usable id comes back as `{ id, invalid }` so it can be rejected. */
export type PolledCommand =
  | { id: string; kind: string; payload: Record<string, unknown>; requested_by?: string; created_at?: string }
  | { id: string; invalid: string };

export type CommandStatus = 'running' | 'succeeded' | 'failed' | 'rejected';

export interface CommandResult {
  status: CommandStatus;
  message: string;
  run_id?: string;
}

/** What a result post came to: delivered; final already (409); gone (404/400); try later; key revoked. */
export type ResultOutcome = 'delivered' | 'final' | 'drop' | 'retry' | 'revoked';

export interface Capabilities {
  remote_start: boolean;
  projects: Array<{ id: string; name: string; kinds: string[] }>;
  engines: string[];
}

export interface OnosooControlOptions {
  config: OnosooConfig;
  http?: RelayHttpClient;
  stderr?: (s: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

type Raw = { status: number; body: string } | null;

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Validate one polled command. Null when it has no usable id (it cannot even be answered). */
export function validateCommand(raw: unknown): PolledCommand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !COMMAND_ID_RE.test(c.id)) { return null; }
  const id = c.id;
  if (typeof c.kind !== 'string' || c.kind.length === 0 || c.kind.length > 64) { return { id, invalid: 'The command has no kind.' }; }
  if (!c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload)) { return { id, invalid: 'The command has no payload object.' }; }
  if (c.requested_by !== undefined && c.requested_by !== null && typeof c.requested_by !== 'string') {
    return { id, invalid: 'The command has an invalid requested_by.' };
  }
  if (c.created_at !== undefined && c.created_at !== null && typeof c.created_at !== 'string') {
    return { id, invalid: 'The command has an invalid created_at.' };
  }
  return {
    id,
    kind: c.kind,
    payload: c.payload as Record<string, unknown>,
    ...(typeof c.requested_by === 'string' ? { requested_by: c.requested_by.slice(0, 200) } : {}),
    ...(typeof c.created_at === 'string' ? { created_at: c.created_at.slice(0, 64) } : {}),
  };
}

export class OnosooControl {
  private readonly config: OnosooConfig;
  private readonly http: RelayHttpClient;
  private readonly stderr: (s: string) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel: () => void };
  private readonly base: string;
  private readonly version = readMoagVersion();
  private backoffMs = BACKOFF_START_MS;
  private noted = new Set<string>();
  private pollStopped = false;
  /** True once the server refused the key: nothing more is sent, ever. */
  revoked = false;
  /** The wait a 429 on a result post asked for; null after any delivered result. */
  lastRetryAfterMs: number | null = null;

  constructor(opts: OnosooControlOptions) {
    this.config = opts.config;
    this.http = opts.http ?? defaultHttpClient;
    this.stderr = opts.stderr ?? ((s: string): void => { process.stderr.write(s); });
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
    const ep = opts.config.endpoint;
    this.base = ep.endsWith(EVENTS_PATH) ? ep.slice(0, ep.length - EVENTS_PATH.length) : ep.replace(/\/+$/, '');
  }

  /** `<base>/functions/v1/builds/<route>`. */
  private url(route: string): string {
    return `${this.base}/functions/v1/builds/${route}`;
  }

  private note(kind: string, message: string): void {
    if (this.noted.has(kind)) { return; }
    this.noted.add(kind);
    try { this.stderr(`${message}\n`); } catch { /* ignore */ }
  }

  /** One POST, bounded by REQUEST_TIMEOUT_MS; null on network failure or timeout. */
  private async post(route: string, body: Record<string, unknown>): Promise<Raw> {
    const ac = new AbortController();
    let timer: { cancel: () => void } | null = null;
    try {
      const timedOut = new Promise<null>((resolve) => {
        timer = this.setTimer(() => { ac.abort(); resolve(null); }, REQUEST_TIMEOUT_MS);
      });
      return await Promise.race([
        Promise.resolve().then(() => this.http({
          url: this.url(route),
          headers: {
            'Authorization': `Bearer ${this.config.key}`,
            'Content-Type': 'application/json',
            'User-Agent': `moag/${this.version}`,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })),
        timedOut,
      ]);
    } catch {
      return null;
    } finally {
      (timer as { cancel: () => void } | null)?.cancel();
    }
  }

  private revoke(): void {
    this.revoked = true;
    this.note('revoked', REVOKED_MESSAGE);
  }

  /** The wait after a transient failure: 5 s doubling to 5 min. */
  private transient(kind: string, message: string): number {
    this.note(`transient:${kind}`, message);
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    return wait;
  }

  private retryAfter(res: { body: string }): number {
    const ra = parseJson(res.body)?.retry_after;
    return typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, BACKOFF_MAX_MS) : this.backoffMs;
  }

  /**
   * Ask for queued commands. Resolves the commands (possibly none); `'stop'` when polling
   * must end for good (key revoked, or a 400 for the poll body); `{ waitMs }` to try later.
   */
  async poll(): Promise<PolledCommand[] | 'stop' | { waitMs: number }> {
    if (this.revoked || this.pollStopped) { return 'stop'; }
    const res = await this.post('commands/poll', { kinds: [...DAEMON_COMMAND_KINDS] });
    if (!res) { return { waitMs: this.transient('network', 'ONOSOO commands: the server could not be reached; retrying.') }; }
    if (res.status === 401 || res.status === 403) { this.revoke(); return 'stop'; }
    if (res.status === 429) { return { waitMs: this.retryAfter(res) }; }
    if (res.status === 400) {
      this.pollStopped = true;
      this.note('poll-400', 'ONOSOO refused the command poll (bad request); remote commands are off until MOAG restarts.');
      return 'stop';
    }
    if (res.status >= 200 && res.status < 300) {
      const o = parseJson(res.body);
      if (!o || !Array.isArray(o.commands)) {
        return { waitMs: this.transient('reply', 'ONOSOO commands: unreadable reply; retrying.') };
      }
      this.backoffMs = BACKOFF_START_MS;
      const out: PolledCommand[] = [];
      for (const raw of o.commands as unknown[]) {
        const c = validateCommand(raw);
        if (c) { out.push(c); }
      }
      return out;
    }
    return { waitMs: this.transient(`http-${Math.floor(res.status / 100)}xx`, `ONOSOO commands: HTTP ${res.status}; retrying.`) };
  }

  /** Report a command's outcome. */
  async postResult(id: string, result: CommandResult): Promise<ResultOutcome> {
    if (this.revoked) { return 'revoked'; }
    if (!COMMAND_ID_RE.test(id)) { return 'drop'; }
    const body: Record<string, unknown> = { status: result.status, message: String(result.message ?? '').slice(0, 2000) };
    if (typeof result.run_id === 'string' && result.run_id.length > 0) { body.run_id = result.run_id; }
    const res = await this.post(`commands/${id}/result`, body);
    if (!res) { this.transient('network', 'ONOSOO commands: the server could not be reached; retrying.'); return 'retry'; }
    if (res.status === 401 || res.status === 403) { this.revoke(); return 'revoked'; }
    if (res.status >= 200 && res.status < 300) { this.backoffMs = BACKOFF_START_MS; this.lastRetryAfterMs = null; return 'delivered'; }
    if (res.status === 409) { return 'final'; }
    if (res.status === 429) { this.lastRetryAfterMs = this.retryAfter(res); return 'retry'; }
    if (res.status === 404 || res.status === 400 || res.status === 413) { return 'drop'; }
    this.transient(`result-${res.status}`, `ONOSOO commands: result not delivered (HTTP ${res.status}); retrying.`);
    return 'retry';
  }

  /** Send the machine's capabilities on the events route (no events, never a heartbeat). True on 2xx. */
  async sendCapabilities(caps: Capabilities): Promise<boolean> {
    if (this.revoked) { return false; }
    const res = await this.post('events', {
      protocol: 1,
      device_id: this.config.deviceId,
      moag_version: this.version,
      events: [],
      capabilities: caps,
    });
    if (!res) { return false; }
    if (res.status === 401 || res.status === 403) { this.revoke(); return false; }
    if (res.status >= 200 && res.status < 300) { this.backoffMs = BACKOFF_START_MS; return true; }
    return false;
  }

  /** The current transient backoff, for callers that schedule their own retries. */
  get currentBackoffMs(): number {
    return this.backoffMs;
  }

  /** Time source, for callers that share it. */
  nowMs(): number {
    return this.now();
  }
}
