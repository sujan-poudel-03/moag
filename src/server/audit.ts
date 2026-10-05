// ─── Audit log ───
//
// Append-only JSONL record of who did what on the hosted server. There is no
// edit or delete API. Entries must never carry secrets: `append()` refuses any
// payload with a credential-looking key at any depth, and writes nothing.

import * as fs from 'fs';
import * as path from 'path';

export const AUDIT_ACTIONS = [
  'login.success',
  'login.failure',
  'user.create',
  'user.disable',
  'user.enable',
  'user.role-change',
  'user.password-set',
  'project.create',
  'project.update',
  'project.stack-change',
  'prd.version-save',
  'prd.bump-override',
  'plan.generate',
  'plan.cancel',
  'plan.approve',
  'plan.reject',
  'run.start',
  'run.stop',
  'gate.approve',
  'gate.reject',
  'gate.skip',
  'engine.key-set',
  'engine.key-clear',
] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];

/** True when `value` is exactly one of {@link AUDIT_ACTIONS}. */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** What a caller supplies; `ts` and `seq` are added by the log. */
export interface AuditInput {
  actorUserId: string;
  actorUsername: string;
  action: AuditAction;
  projectId?: string;
  target: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  flags?: string[];
}

export interface AuditEntry extends AuditInput {
  ts: string;
  seq: number;
}

export interface AuditQuery {
  /** Matches `actorUserId` or `actorUsername`. */
  actor?: string;
  action?: string;
  projectId?: string;
  /** Inclusive lower bound on `ts` (ISO string). */
  from?: string;
  /** Inclusive upper bound on `ts` (ISO string). */
  to?: string;
  /** Paging cursor: only entries with `seq` strictly below this. */
  before?: number;
  /** Max entries returned, clamped to 1..100. */
  limit?: number;
}

/** Thrown when an audit payload carries a credential-looking key. */
export class AuditSecretError extends Error {
  constructor(public readonly keyPath: string) {
    super(`Refusing to write audit entry: key "${keyPath}" looks like a secret`);
    this.name = 'AuditSecretError';
  }
}

export const AUDIT_FILE = 'audit.jsonl';
export const AUDIT_ROTATE_BYTES = 20 * 1024 * 1024;
export const AUDIT_MAX_PAGE = 100;
const SECRET_KEY_RE = /password|apikey|secret|token|key$/i;
const ROTATED_RE = /^audit-.+\.jsonl$/;

/** Return the dotted path of the first secret-looking key in `value`, or null. */
export function findSecretKey(value: unknown, prefix = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretKey(value[i], `${prefix}[${i}]`);
      if (hit) { return hit; }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (SECRET_KEY_RE.test(k)) { return p; }
      const hit = findSecretKey(v, p);
      if (hit) { return hit; }
    }
  }
  return null;
}

/** File-backed append-only audit log under the server data directory. */
export class AuditLog {
  private readonly filePath: string;
  private seq: number;

  constructor(private readonly dataDir: string, private readonly opts: { rotateBytes?: number; now?: () => Date } = {}) {
    this.filePath = path.join(dataDir, AUDIT_FILE);
    this.seq = this.recoverLastSeq();
  }

  /**
   * Append one entry. Throws {@link AuditSecretError} (writing nothing) if any
   * key at any depth looks like a credential, and throws on an unknown action.
   */
  append(input: AuditInput): AuditEntry {
    if (!isAuditAction(input.action)) {
      throw new Error(`Unknown audit action "${String(input.action)}"`);
    }
    const secret = findSecretKey(input);
    if (secret) { throw new AuditSecretError(secret); }

    const entry: AuditEntry = {
      ts: (this.opts.now ? this.opts.now() : new Date()).toISOString(),
      seq: this.seq + 1,
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      action: input.action,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      target: input.target,
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.flags !== undefined && input.flags.length > 0 ? { flags: [...input.flags] } : {}),
    };
    const line = JSON.stringify(entry) + '\n';
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.rotateIfNeeded(Buffer.byteLength(line));
    fs.appendFileSync(this.filePath, line, { encoding: 'utf-8', mode: 0o600 });
    this.seq = entry.seq;
    return entry;
  }

  /** Newest-first page of entries matching every given filter. Malformed lines are skipped. */
  query(q: AuditQuery = {}): AuditEntry[] {
    const limit = Math.max(1, Math.min(AUDIT_MAX_PAGE, Math.floor(q.limit ?? AUDIT_MAX_PAGE)));
    const out: AuditEntry[] = [];
    for (const file of this.filesNewestFirst()) {
      const lines = readLines(file);
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = parseEntry(lines[i]);
        if (!e || !matches(e, q)) { continue; }
        out.push(e);
        if (out.length >= limit) { return out; }
      }
    }
    return out;
  }

  // ─── Internals ───

  private filesNewestFirst(): string[] {
    let rotated: string[] = [];
    try {
      rotated = fs.readdirSync(this.dataDir).filter((n) => ROTATED_RE.test(n)).sort().reverse();
    } catch { /* no data dir yet */ }
    return [this.filePath, ...rotated.map((n) => path.join(this.dataDir, n))];
  }

  private rotateIfNeeded(incoming: number): void {
    const max = this.opts.rotateBytes ?? AUDIT_ROTATE_BYTES;
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch { return; }
    if (size === 0 || size + incoming <= max) { return; }
    const stamp = (this.opts.now ? this.opts.now() : new Date()).toISOString().replace(/[:.]/g, '-');
    let target = path.join(this.dataDir, `audit-${stamp}.jsonl`);
    for (let n = 1; fs.existsSync(target); n++) {
      target = path.join(this.dataDir, `audit-${stamp}-${n}.jsonl`);
    }
    fs.renameSync(this.filePath, target);
  }

  private recoverLastSeq(): number {
    for (const file of this.filesNewestFirst()) {
      const lines = readLines(file);
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = parseEntry(lines[i]);
        if (e) { return e.seq; }
      }
    }
    return 0;
  }
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function parseEntry(line: string): AuditEntry | null {
  try {
    const v = JSON.parse(line) as Partial<AuditEntry>;
    if (!v || typeof v !== 'object' || typeof v.seq !== 'number' || typeof v.ts !== 'string'
      || typeof v.action !== 'string' || typeof v.actorUserId !== 'string') {
      return null;
    }
    return v as AuditEntry;
  } catch {
    return null;
  }
}

function matches(e: AuditEntry, q: AuditQuery): boolean {
  if (q.before !== undefined && !(e.seq < q.before)) { return false; }
  if (q.actor !== undefined && e.actorUserId !== q.actor && e.actorUsername !== q.actor) { return false; }
  if (q.action !== undefined && e.action !== q.action) { return false; }
  if (q.projectId !== undefined && e.projectId !== q.projectId) { return false; }
  if (q.from !== undefined && e.ts < q.from) { return false; }
  if (q.to !== undefined && e.ts > q.to) { return false; }
  return true;
}
