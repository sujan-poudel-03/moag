// ─── Remote runs: audit log and result outbox ───
//
// Every command ONOSOO sends is written here BEFORE anything else happens to it,
// so the machine owner can always see what was asked and what MOAG decided:
//
//   <stateDir>/remote/audit.jsonl (0600, append-only; rotated to audit.1.jsonl at 5 MB)
//   { at, id, kind, requested_by, created_at, project_id, phase, decision, message, run_id, prd? }
//
// phase: received → decided → running → final → delivered. The command payload is
// never copied: a PRD is recorded as { bytes, sha256 } only, and nothing else from
// the payload but the project id and the run id it names.
//
// The audit log is also the at-most-once guard: an id it has seen is never executed
// again, and an id with no `final` line at start-up was cut short by a restart.
//
// <stateDir>/remote/outbox.json (atomic, 0600) holds results not yet delivered to
// ONOSOO, so a restart still reports them. Imports nothing that loads `vscode`.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';
import type { CommandResult } from './onosoo-control';

export const AUDIT_FILE = 'audit.jsonl';
export const AUDIT_ROTATED_FILE = 'audit.1.jsonl';
export const OUTBOX_FILE = 'outbox.json';
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export type AuditPhase = 'received' | 'decided' | 'running' | 'final' | 'delivered';

/** What a caller records. `prd` is the PRD text, of which only the size and hash are kept. */
export interface AuditInput {
  id: string;
  kind: string;
  phase: AuditPhase;
  requestedBy?: string | null;
  createdAt?: string | null;
  projectId?: string | null;
  decision?: string | null;
  message?: string | null;
  runId?: string | null;
  prd?: string | null;
}

export interface AuditLine {
  at: string;
  id: string;
  kind: string;
  requested_by: string | null;
  created_at: string | null;
  project_id: string | null;
  phase: AuditPhase;
  decision: string | null;
  message: string | null;
  run_id: string | null;
  prd?: { bytes: number; sha256: string };
}

export interface OutboxItem {
  id: string;
  result: CommandResult;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** The line written for `input` — only these fields, never the payload. */
export function auditLine(input: AuditInput, at: Date): AuditLine {
  const line: AuditLine = {
    at: at.toISOString(),
    id: String(input.id).slice(0, 64),
    kind: String(input.kind).slice(0, 64),
    requested_by: str(input.requestedBy, 200),
    created_at: str(input.createdAt, 64),
    project_id: str(input.projectId, 64),
    phase: input.phase,
    decision: str(input.decision, 64),
    message: str(input.message, 2000),
    run_id: str(input.runId, 128),
  };
  if (typeof input.prd === 'string') {
    line.prd = { bytes: Buffer.byteLength(input.prd, 'utf-8'), sha256: createHash('sha256').update(input.prd, 'utf-8').digest('hex') };
  }
  return line;
}

export class RemoteAudit {
  readonly dir: string;
  readonly file: string;
  private readonly now: () => Date;
  private readonly maxBytes: number;

  constructor(stateDir: string, opts: { now?: () => Date; maxBytes?: number } = {}) {
    this.dir = path.join(stateDir, 'remote');
    this.file = path.join(this.dir, AUDIT_FILE);
    this.now = opts.now ?? ((): Date => new Date());
    this.maxBytes = opts.maxBytes ?? AUDIT_MAX_BYTES;
  }

  /** Append one line, synchronously. Throws when it cannot be written: callers must then refuse the command. */
  appendOrThrow(input: AuditInput): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(this.file).size >= this.maxBytes) {
        fs.renameSync(this.file, path.join(this.dir, AUDIT_ROTATED_FILE));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
    }
    fs.appendFileSync(this.file, JSON.stringify(auditLine(input, this.now())) + '\n', { encoding: 'utf-8', mode: 0o600 });
  }

  /** Every audit line, oldest first (rotated file first); malformed lines are skipped. */
  readAll(): AuditLine[] {
    const out: AuditLine[] = [];
    for (const name of [AUDIT_ROTATED_FILE, AUDIT_FILE]) {
      let text: string;
      try { text = fs.readFileSync(path.join(this.dir, name), 'utf-8'); } catch { continue; }
      for (const l of text.split('\n')) {
        if (!l) { continue; }
        try {
          const v = JSON.parse(l) as AuditLine;
          if (v && typeof v.id === 'string' && typeof v.phase === 'string') { out.push(v); }
        } catch { /* a torn last line */ }
      }
    }
    return out;
  }

  /** At start-up: every command id ever seen, and those that never reached `final`. */
  reconcileOnBoot(): { seen: Set<string>; unfinished: Array<{ id: string; kind: string }> } {
    const seen = new Set<string>();
    const finals = new Set<string>();
    const kinds = new Map<string, string>();
    for (const l of this.readAll()) {
      seen.add(l.id);
      if (!kinds.has(l.id)) { kinds.set(l.id, l.kind); }
      if (l.phase === 'final' || l.phase === 'delivered') { finals.add(l.id); }
    }
    const unfinished = [...seen].filter((id) => !finals.has(id)).map((id) => ({ id, kind: kinds.get(id) ?? '' }));
    return { seen, unfinished };
  }

  // ─── Outbox ───

  private outboxPath(): string {
    return path.join(this.dir, OUTBOX_FILE);
  }

  /** Results not yet delivered, oldest first. */
  outboxList(): OutboxItem[] {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.outboxPath(), 'utf-8'));
      return Array.isArray(v)
        ? v.filter((x): x is OutboxItem => !!x && typeof x.id === 'string' && !!x.result && typeof x.result.status === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private writeOutbox(items: OutboxItem[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(this.outboxPath(), JSON.stringify(items, null, 2), 0o600);
  }

  /** Queue a result for delivery; a later result for the same id replaces the earlier one. */
  outboxAdd(id: string, result: CommandResult): void {
    const items = this.outboxList().filter((x) => x.id !== id);
    items.push({ id, result });
    this.writeOutbox(items);
  }

  outboxRemove(id: string): void {
    const items = this.outboxList();
    const next = items.filter((x) => x.id !== id);
    if (next.length !== items.length) { this.writeOutbox(next); }
  }
}
