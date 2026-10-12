// ─── Outcome evidence store (stack recommendation input) ───
//
// `outcomes.jsonl` in the data dir, one JSON object per line, append-only:
//
//   {kind:'task', ts, projectId, runId, stack, engine, taskType, status}
//       one per task-completed / task-failed event from a server run
//   {kind:'gate', ts, projectId, runId, stack, engine, gateRun:true, allGreen}
//       one per PRD-loop gate run recorded in the run's requirement trace
//
// `stack` is the project's stack FROZEN at run start (a later stack change never
// rewrites evidence). Reads skip malformed lines and are cached by the file's
// mtime and size, so the recommendation endpoint does not re-parse an unchanged
// file on every request.

import * as fs from 'fs';
import * as path from 'path';
import { EngineId, TaskType } from '../models/types';
import { StackId } from './stacks';
import { OutcomeLike } from './stack-recommendation';

export const OUTCOMES_FILE = 'outcomes.jsonl';

export interface TaskOutcomeRecord {
  kind: 'task';
  ts: string;
  projectId: string;
  runId: string;
  stack: StackId;
  engine: EngineId;
  taskType: TaskType;
  status: 'completed' | 'failed' | 'blocked';
}

export interface GateOutcomeRecord {
  kind: 'gate';
  ts: string;
  projectId: string;
  runId: string;
  stack: StackId;
  engine: EngineId;
  gateRun: true;
  allGreen: boolean;
}

export type OutcomeRecord = TaskOutcomeRecord | GateOutcomeRecord;

export interface OutcomeRead {
  records: OutcomeLike[];
  malformed: number;
}

export class OutcomeStore {
  private readonly file: string;
  private cache: { mtimeMs: number; size: number; read: OutcomeRead } | null = null;

  constructor(dataDir: string, private readonly log: (m: string) => void = () => { /* quiet */ }) {
    this.file = path.join(dataDir, OUTCOMES_FILE);
  }

  /** Append one record. Never throws (evidence is best effort; a run must not fail over it). */
  append(record: OutcomeRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch (err) {
      this.log(`outcomes.jsonl: ${(err as Error).message}`);
    }
  }

  /** Every well-formed record (object lines only), plus how many lines were skipped. */
  readAll(): OutcomeRead {
    let st: fs.Stats;
    try { st = fs.statSync(this.file); } catch { this.cache = null; return { records: [], malformed: 0 }; }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) { return this.cache.read; }
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch { return { records: [], malformed: 0 }; }
    const records: OutcomeLike[] = [];
    let malformed = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') { continue; }
      try {
        const o = JSON.parse(line) as unknown;
        if (o && typeof o === 'object' && !Array.isArray(o)) { records.push(o as OutcomeLike); } else { malformed++; }
      } catch { malformed++; }
    }
    const read = { records, malformed };
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, read };
    return read;
  }
}
