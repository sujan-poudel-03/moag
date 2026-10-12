// ─── Remote runs: daily spend ledger ───
//
// The machine owner's daily cap for runs ONOSOO starts (projects.json
// `daily_budget_usd`). <stateDir>/remote/spend.json (0600):
//
//   { "day": "2026-10-11",
//     "entries": [ { runId, day, pid, allotment, reportedUsd, unreported, engines, open, charged } ] }
//
// A run reserves its whole allotment when it is accepted; an open entry counts in
// full. When it ends it is charged:
//   - the full allotment when any engine that reports no cost was used (gemini,
//     copilot, custom) or any call went unreported — MOAG cannot know what it spent;
//   - otherwise the sum the engines reported (ollama reports 0).
// An entry left open by a process that is gone (a crash, a kill) is charged its full
// allotment.
//
// Every entry belongs to the LOCAL day it was reserved on (`day`). A new day starts
// with nothing spent; a run still open across midnight stays in the file and is
// charged to its reservation day when it settles. Settled entries are kept through
// the next day (so that day's total stays right) and dropped after.
//
// The file is re-read before every change (read-modify-write), so a second process
// on the same state dir never overwrites what the first recorded.
//
// Fails closed: an unreadable or corrupt file means "today's budget is spent".
// Imports nothing that loads `vscode`.

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';

export const SPEND_FILE = 'spend.json';
/** Engines that report no cost: a run that used one is charged its full allotment. */
export const UNMETERED_ENGINES: ReadonlySet<string> = new Set(['gemini', 'copilot', 'custom']);

export interface LedgerEntry {
  runId: string;
  /** The local day the run was reserved on; its charge counts against that day. */
  day: string;
  pid: number;
  allotment: number;
  reportedUsd: number;
  unreported: boolean;
  engines: string[];
  open: boolean;
  /** What the run was charged once settled; null while open. */
  charged: number | null;
}

interface LedgerFile {
  day: string;
  entries: LedgerEntry[];
}

export interface LedgerOptions {
  now?: () => Date;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** The local calendar day of `date`, as YYYY-MM-DD. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** What a settled entry costs under the charging rule. */
export function chargeFor(e: Pick<LedgerEntry, 'allotment' | 'reportedUsd' | 'unreported' | 'engines'>): number {
  if (e.unreported || e.engines.some((x) => UNMETERED_ENGINES.has(x))) { return e.allotment; }
  return Math.max(0, e.reportedUsd);
}

function isEntry(v: unknown): v is Omit<LedgerEntry, 'day'> & { day?: unknown } {
  if (!v || typeof v !== 'object') { return false; }
  const e = v as Record<string, unknown>;
  return typeof e.runId === 'string' && typeof e.pid === 'number'
    && typeof e.allotment === 'number' && Number.isFinite(e.allotment) && e.allotment >= 0
    && typeof e.reportedUsd === 'number' && Number.isFinite(e.reportedUsd)
    && typeof e.unreported === 'boolean' && Array.isArray(e.engines) && e.engines.every((x) => typeof x === 'string')
    && typeof e.open === 'boolean' && (e.charged === null || (typeof e.charged === 'number' && Number.isFinite(e.charged)))
    && (e.day === undefined || typeof e.day === 'string');
}

/** What an entry counts for against its day: in full while open, its charge once settled. */
function costOf(e: LedgerEntry): number {
  return e.open ? e.allotment : (e.charged ?? e.allotment);
}

export class RemoteLedger {
  readonly file: string;
  /** Problems found reading the file; non-empty means the ledger is failing closed. */
  readonly errors: string[] = [];
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private data: LedgerFile;
  /** The day a corrupt file was found; that whole day counts as spent. */
  private corruptDay: string | null = null;

  constructor(stateDir: string, opts: LedgerOptions = {}) {
    this.file = path.join(stateDir, 'remote', SPEND_FILE);
    this.now = opts.now ?? ((): Date => new Date());
    this.pid = opts.pid ?? process.pid;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.data = { day: this.today(), entries: [] };
    this.reload();
  }

  private today(): string {
    return localDayKey(this.now());
  }

  /**
   * Read the file again (another process may have written it), drop closed entries of
   * earlier days, and charge in full any entry a dead process left open. Persists what
   * it changed. A corrupt or unreadable file fails today closed.
   */
  private reload(): void {
    const today = this.today();
    if (this.corruptDay !== null && this.corruptDay !== today) {
      // The fail-closed day is over: start again (the bad file is replaced on the next write).
      this.corruptDay = null;
      this.data = { day: today, entries: [] };
      return;
    }
    if (this.corruptDay === today) { return; }
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { this.data = { day: today, entries: [] }; return; }
      this.failClosed(`The remote spend ledger could not be read (${(err as Error).message}); today's remote budget counts as spent.`);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const o = parsed as { day?: unknown; entries?: unknown } | null;
    if (!o || typeof o.day !== 'string' || !Array.isArray(o.entries) || !o.entries.every(isEntry)) {
      this.failClosed('The remote spend ledger is corrupt; today\'s remote budget counts as spent.');
      return;
    }
    const fileDay = o.day;
    // Settled entries are kept through the next day, so a run that crossed midnight still
    // shows in its reservation day's total; anything older is history.
    const yesterday = localDayKey(new Date(this.now().getTime() - 24 * 60 * 60 * 1000));
    let changed = false;
    const entries: LedgerEntry[] = [];
    for (const raw of o.entries as Array<Omit<LedgerEntry, 'day'> & { day?: unknown }>) {
      const e: LedgerEntry = { ...raw, day: typeof raw.day === 'string' ? raw.day : fileDay, engines: [...raw.engines] };
      if (e.open && e.pid !== this.pid && !this.isPidAlive(e.pid)) {
        e.open = false;
        e.charged = e.allotment;
        changed = true;
      }
      // Open entries are kept until they settle, whatever their day.
      if (!e.open && e.day < yesterday) { changed = true; continue; }
      entries.push(e);
    }
    if (fileDay !== today) { changed = true; }
    this.data = { day: today, entries };
    if (changed) { this.persist(); }
  }

  private failClosed(message: string): void {
    this.errors.push(message);
    this.corruptDay = this.today();
    this.data = { day: this.today(), entries: [] };
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(this.file, JSON.stringify(this.data, null, 2), 0o600);
  }

  /** Spent (or reserved) against `day` (default today). */
  spentOn(day: string = this.today()): number {
    this.reload();
    return this.data.entries.filter((e) => e.day === day).reduce((sum, e) => sum + costOf(e), 0);
  }

  /** Spent (or reserved) today. */
  spentToday(): number {
    return this.spentOn(this.today());
  }

  /** What is left of `dailyUsd` today; 0 while failing closed. */
  remaining(dailyUsd: number): number {
    this.reload();
    if (this.corruptDay === this.today()) { return 0; }
    return Math.max(0, dailyUsd - this.spentToday());
  }

  /**
   * Reserve `allotment` for a run. False (nothing written) when it does not fit what is
   * left of `dailyUsd`, when failing closed, or when the run is already in the ledger.
   * Throws only if the ledger cannot be written.
   */
  reserve(runId: string, allotment: number, dailyUsd: number): boolean {
    if (!(allotment > 0) || !Number.isFinite(allotment)) { return false; }
    if (allotment > this.remaining(dailyUsd) + 1e-9) { return false; }
    if (this.data.entries.some((e) => e.runId === runId)) { return false; }
    this.data.entries.push({
      runId, day: this.today(), pid: this.pid, allotment, reportedUsd: 0, unreported: false, engines: [], open: true, charged: null,
    });
    this.persist();
    return true;
  }

  /** Record one engine call's spend (`usd`) or an unreported call. Ignores unknown or settled runs. */
  record(runId: string, spend: { usd: number } | { unreported: true }, engine: string): void {
    this.reload();
    const e = this.data.entries.find((x) => x.runId === runId && x.open);
    if (!e) { return; }
    if ('unreported' in spend) {
      e.unreported = true;
    } else if (Number.isFinite(spend.usd) && spend.usd > 0) {
      e.reportedUsd += spend.usd;
    }
    if (engine && !e.engines.includes(engine)) { e.engines.push(engine); }
    try { this.persist(); } catch { /* the in-memory entry still settles correctly */ }
  }

  /** Close a run's entry under the charging rule; returns what it was charged (0 for an unknown run). */
  settle(runId: string): number {
    this.reload();
    const e = this.data.entries.find((x) => x.runId === runId);
    if (!e) { return 0; }
    if (e.open) {
      e.open = false;
      e.charged = chargeFor(e);
      this.persist();
    }
    return e.charged ?? e.allotment;
  }

  /** Close an entry at its full allotment (an interrupted run, or one whose spend is unknown). */
  chargeInFull(runId: string): number {
    this.reload();
    const e = this.data.entries.find((x) => x.runId === runId);
    if (!e) { return 0; }
    e.open = false;
    e.charged = e.allotment;
    this.persist();
    return e.charged;
  }

  /** A copy of the entries kept (today's, plus earlier days' still open). */
  entries(): LedgerEntry[] {
    this.reload();
    return this.data.entries.map((e) => ({ ...e, engines: [...e.engines] }));
  }
}
