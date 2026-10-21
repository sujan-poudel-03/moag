// ─── ONOSOO relay spool ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OnosooSpool, RelayEvent, SPOOL_MAX_AGE_MS, SPOOL_OWNER_MAX_IDLE_MS } from '../../../headless/onosoo-spool';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const ev = (runId: string, seq: number, data: Record<string, unknown> = {}): RelayEvent =>
  ({ run_id: runId, seq, type: 'task-started', at: '2026-10-11T00:00:00.000Z', data });

/** A spool over a fresh state dir; every foreign pid counts as dead unless told otherwise. */
function mk(opts: { isPidAlive?: (pid: number) => boolean; maxDirBytes?: number; cwd?: string; stateDir?: string } = {}) {
  const stateDir = opts.stateDir ?? tmp('moag-spool-state-');
  const cwd = opts.cwd ?? tmp('moag-spool-ws-');
  const spool = new OnosooSpool(stateDir, cwd, { isPidAlive: opts.isPidAlive ?? (() => false), maxDirBytes: opts.maxDirBytes });
  return { spool, stateDir, cwd };
}

/** Rewrite a run file's meta pid, as if another process had written it. */
function setMetaPid(spool: OnosooSpool, runId: string, pid: number): void {
  const file = path.join(spool.dir, `${runId}.jsonl`);
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const meta = JSON.parse(lines[0]);
  meta.meta.pid = pid;
  lines[0] = JSON.stringify(meta);
  fs.writeFileSync(file, lines.join('\n'));
}

describe('ONOSOO spool', () => {
  it('appends, reloads, acks and reloads only seq > ack', () => {
    const { spool } = mk();
    assert.ok(spool.openRun('run-a'));
    for (let s = 1; s <= 5; s++) { assert.ok(spool.append(ev('run-a', s))); }
    assert.deepEqual(spool.loadReplayable(null).map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.ok(spool.writeAck('run-a', 3));
    assert.deepEqual(spool.loadReplayable(null).map((e) => e.seq), [4, 5]);
    assert.deepEqual(spool.loadReplayable('run-a'), [], 'the excluded (current) run is never replayed');
  });

  it('writeAck does not recreate the ack of a run whose event file another process removed', () => {
    const { spool, stateDir, cwd } = mk();
    spool.openRun('r');
    spool.append(ev('r', 1));
    assert.ok(spool.writeAck('r', 1));
    // Another process drained the run and removed its files.
    const other = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
    assert.ok(other.dropIfFullyAcked('r', 1));
    assert.equal(spool.writeAck('r', 2), false);
    assert.ok(!fs.existsSync(path.join(spool.dir, 'r.ack')), 'no stray ack');
    assert.deepEqual(fs.readdirSync(spool.dir), []);
    assert.equal(spool.writeAck('never-opened', 1), false, 'nor for a run that never had a file');
    assert.ok(!fs.existsSync(path.join(spool.dir, 'never-opened.ack')));
  });

  it('quarantine skips a seq already in the run\'s rejected file, across spool instances (restarts)', () => {
    const { spool, stateDir, cwd } = mk();
    assert.ok(spool.quarantine([ev('r', 2)], 'too_large'));
    assert.ok(spool.quarantine([ev('r', 2)], 'too_large'), 'same instance: skipped, still ok');
    const restarted = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
    assert.ok(restarted.quarantine([ev('r', 2), ev('r', 3)], 'too_large'));
    assert.ok(restarted.quarantine([ev('r', 3)], 'bad_request'));
    // Another run's rejected file is its own.
    assert.ok(restarted.quarantine([ev('other', 2)], 'too_large'));
    const seqs = (run: string): number[] => fs.readFileSync(spool.rejectedFile(run), 'utf-8').trim().split('\n').map((l) => JSON.parse(l).event.seq);
    assert.deepEqual(seqs('r'), [2, 3]);
    assert.deepEqual(seqs('other'), [2]);
  });

  it('the rejected-file scan finds seqs after a line larger than its read block, and ignores a malformed line', () => {
    const { spool, stateDir, cwd } = mk();
    spool.quarantine([ev('r', 1, { pad: 'x'.repeat(3 * 1024 * 1024) })], 'too_large');
    spool.quarantine([ev('r', 7)], 'bad_request');
    fs.appendFileSync(spool.rejectedFile('r'), 'not json\n');
    spool.quarantine([ev('r', 9)], 'bad_request');
    const restarted = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
    restarted.quarantine([ev('r', 1), ev('r', 7), ev('r', 9), ev('r', 10)], 'too_large');
    const lines = fs.readFileSync(spool.rejectedFile('r'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 5, 'four events and the malformed line; only seq 10 was added');
    assert.equal(JSON.parse(lines[4]).event.seq, 10);
  });

  it('writeAck never lowers the mark', () => {
    const { spool } = mk();
    spool.openRun('r');
    spool.writeAck('r', 10);
    spool.writeAck('r', 4);
    assert.equal(spool.readAck('r'), 10);
  });

  it('ignores a truncated final line and malformed lines', () => {
    const { spool } = mk();
    spool.openRun('r');
    spool.append(ev('r', 1));
    spool.append(ev('r', 2));
    fs.appendFileSync(path.join(spool.dir, 'r.jsonl'), 'garbage\n{"run_id":"r","seq":3,"ty');
    assert.deepEqual(spool.loadReplayable(null).map((e) => e.seq), [1, 2]);
  });

  it('skips a file with an unknown spool version or a broken meta line', () => {
    const { spool } = mk();
    spool.openRun('r');
    spool.append(ev('r', 1));
    const file = path.join(spool.dir, 'r.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines[0] = JSON.stringify({ meta: { v: 2, run_id: 'r', pid: 1 } });
    fs.writeFileSync(file, lines.join('\n'));
    assert.deepEqual(spool.loadReplayable(null), []);
    fs.writeFileSync(file, '{"meta":\n' + lines.slice(1).join('\n'));
    assert.deepEqual(spool.loadReplayable(null), []);
  });

  it('prunes event, ack and rejected files older than seven days', () => {
    const now = Date.now();
    const { spool, stateDir, cwd } = mk();
    spool.openRun('old');
    spool.append(ev('old', 1));
    spool.append(ev('old', 2));
    spool.writeAck('old', 1);
    spool.quarantine([ev('old', 3)], 'bad_request');
    const old = new Date(now - SPOOL_MAX_AGE_MS - 24 * 60 * 60 * 1000);
    for (const n of fs.readdirSync(spool.dir)) { fs.utimesSync(path.join(spool.dir, n), old, old); }
    const again = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false, now: () => now });
    assert.deepEqual(again.loadReplayable(null), []);
    assert.deepEqual(fs.readdirSync(spool.dir), []);
  });

  it('skips a run still owned by another live process, replays it once that process is gone', () => {
    let alive = true;
    const { spool } = mk({ isPidAlive: () => alive });
    spool.openRun('r');
    spool.append(ev('r', 1));
    setMetaPid(spool, 'r', 999_999);
    assert.deepEqual(spool.loadReplayable(null), []);
    alive = false;
    assert.deepEqual(spool.loadReplayable(null).map((e) => e.seq), [1]);
  });

  it('dropIfFullyAcked removes events and ack, keeps rejected events', () => {
    const { spool } = mk();
    spool.openRun('r');
    spool.append(ev('r', 1));
    spool.append(ev('r', 2));
    spool.quarantine([ev('r', 2)], 'bad_request');
    spool.writeAck('r', 1);
    assert.equal(spool.dropIfFullyAcked('r', 2), false, 'not yet: seq 2 unacked');
    spool.writeAck('r', 2);
    assert.equal(spool.dropIfFullyAcked('r', 2), true);
    assert.deepEqual(fs.readdirSync(spool.dir), ['r.rejected.jsonl']);
  });

  it('quarantined events are never replayed', () => {
    const { spool } = mk();
    spool.openRun('r');
    spool.append(ev('r', 1));
    assert.ok(spool.quarantine([ev('r', 1)], 'bad_request'));
    spool.writeAck('r', 1);
    assert.deepEqual(spool.loadReplayable(null), []);
    const rejected = fs.readFileSync(spool.rejectedFile('r'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, 'bad_request');
    assert.equal(rejected[0].event.seq, 1);
    assert.equal(typeof rejected[0].rejected_at, 'string');
  });

  it('two workspaces get separate directories', () => {
    const stateDir = tmp('moag-spool-state-');
    const a = mk({ stateDir });
    const b = mk({ stateDir });
    assert.notEqual(a.spool.dir, b.spool.dir);
    a.spool.openRun('r');
    a.spool.append(ev('r', 1));
    assert.deepEqual(b.spool.loadReplayable(null), []);
  });

  it('append returns false once the directory is over its cap', () => {
    const { spool } = mk({ maxDirBytes: 600 });
    spool.openRun('r');
    let accepted = 0;
    for (let s = 1; s <= 20; s++) { if (spool.append(ev('r', s, { pad: 'x'.repeat(50) }))) { accepted++; } else { break; } }
    assert.ok(accepted > 0 && accepted < 20, `accepted ${accepted}`);
    assert.equal(spool.append(ev('r', 99)), false);
  });

  it('a fully acked leftover run is cleaned up on load', () => {
    const { spool } = mk();
    spool.openRun('r');
    spool.append(ev('r', 1));
    spool.writeAck('r', 1);
    assert.deepEqual(spool.loadReplayable(null), []);
    assert.deepEqual(fs.readdirSync(spool.dir), []);
  });

  describe('chunked replay (byte budget + cursors)', () => {
    const size = (e: RelayEvent): number => Buffer.byteLength(JSON.stringify(e), 'utf-8');

    /** A spool whose runs were opened at the given times, so "oldest first" is testable. */
    function runsAt(starts: Array<[string, number, number]>) {
      const stateDir = tmp('moag-spool-state-');
      const cwd = tmp('moag-spool-ws-');
      for (const [runId, startedAt, count] of starts) {
        const w = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false, now: () => startedAt });
        w.openRun(runId);
        for (let s = 1; s <= count; s++) { w.append(ev(runId, s, { pad: 'p'.repeat(100) })); }
      }
      return new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
    }

    it('returns oldest runs first, by started_at rather than by name', () => {
      const spool = runsAt([['a-newer', Date.parse('2026-10-11T00:00:00Z'), 2], ['z-older', Date.parse('2026-10-10T00:00:00Z'), 2]]);
      assert.deepEqual(spool.loadReplayable(null).map((e) => `${e.run_id}:${e.seq}`), ['z-older:1', 'z-older:2', 'a-newer:1', 'a-newer:2']);
    });

    it('a budget splits the backlog into chunks: each within the budget, together every event once, in order', () => {
      const spool = runsAt([['r1', 1_000, 7], ['r2', 2_000, 5]]);
      const one = size(ev('r1', 1, { pad: 'p'.repeat(100) }));
      const budget = one * 3 + 10;
      const cursors = new Map();
      const all: string[] = [];
      let chunks = 0;
      for (;;) {
        const got = spool.loadReplayable(null, { budgetBytes: budget, cursors });
        if (got.length === 0) { break; }
        chunks++;
        assert.ok(got.reduce((n, e) => n + size(e), 0) <= budget, 'a chunk never exceeds the budget');
        all.push(...got.map((e) => `${e.run_id}:${e.seq}`));
        // The caller delivers and acks the chunk before asking for more.
        for (const e of got) { spool.writeAck(e.run_id, e.seq); }
      }
      assert.ok(chunks >= 4, `${chunks} chunks`);
      assert.deepEqual(all, [...[1, 2, 3, 4, 5, 6, 7].map((s) => `r1:${s}`), ...[1, 2, 3, 4, 5].map((s) => `r2:${s}`)]);
      assert.ok([...cursors.values()].every((c) => c.eof), 'every run read to the end');
    });

    it('without acks between chunks, the cursors alone prevent duplicates and gaps', () => {
      const spool = runsAt([['r', 1_000, 10]]);
      const budget = size(ev('r', 1, { pad: 'p'.repeat(100) })) * 4;
      const cursors = new Map();
      const seqs: number[] = [];
      for (let i = 0; i < 10; i++) { seqs.push(...spool.loadReplayable(null, { budgetBytes: budget, cursors }).map((e) => e.seq)); }
      assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('the next chunk resumes at the stored file offset: lines before it are never read again', () => {
      const spool = runsAt([['r', 1_000, 6]]);
      const budget = size(ev('r', 1, { pad: 'p'.repeat(100) })) * 3;
      const cursors = new Map();
      assert.deepEqual(spool.loadReplayable(null, { budgetBytes: budget, cursors }).map((e) => e.seq), [1, 2, 3]);
      const cursor = cursors.get('r');
      assert.equal(cursor.eof, false);
      assert.equal(cursor.seq, 3);
      // Renumber the events before the offset to 7, 8, 9 (same byte length): a re-read from
      // the start would return those instead of 4, 5, 6.
      const file = path.join(spool.dir, 'r.jsonl');
      const text = fs.readFileSync(file, 'utf-8');
      const head = text.slice(0, cursor.offset).replace('"seq":1,', '"seq":7,').replace('"seq":2,', '"seq":8,').replace('"seq":3,', '"seq":9,');
      assert.equal(Buffer.byteLength(head), cursor.offset);
      fs.writeFileSync(file, head + text.slice(cursor.offset));
      assert.deepEqual(spool.loadReplayable(null, { budgetBytes: budget, cursors }).map((e) => e.seq), [4, 5, 6]);
      assert.equal(cursors.get('r').eof, true);
    });

    it('an event larger than the budget is not returned; the run stays pending at that line', () => {
      const spool = runsAt([['r', 1_000, 2]]);
      const cursors = new Map();
      assert.deepEqual(spool.loadReplayable(null, { budgetBytes: 10, cursors }), []);
      assert.equal(cursors.get('r').eof, false);
      assert.equal(cursors.get('r').seq, 0);
      assert.deepEqual(spool.loadReplayable(null, { cursors }).map((e) => e.seq), [1, 2], 'nothing was skipped');
    });

    it('a read error part-way through a run keeps what was taken and never returns it twice', () => {
      // 15 events of ~85 KB: over one 1 MiB read block, so the file is read in two blocks.
      const stateDir = tmp('moag-spool-state-');
      const cwd = tmp('moag-spool-ws-');
      const w = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
      w.openRun('r');
      for (let s = 1; s <= 15; s++) { w.append(ev('r', s, { pad: 'q'.repeat(85_000) })); }
      const spool = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const realFs = require('fs') as typeof fs;
      const original = realFs.readSync;
      let n = 0;
      // Read 1 = the meta line check, read 2 = the first block of events, read 3 fails.
      realFs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
        if (++n === 3) { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); }
        return (original as (...a: unknown[]) => number)(...args);
      }) as typeof fs.readSync;
      const cursors = new Map();
      let first: number[];
      try {
        first = spool.loadReplayable(null, { cursors }).map((e) => e.seq);
      } finally {
        realFs.readSync = original;
      }
      assert.ok(first.length > 0 && first.length < 15, `first load took ${first.length}`);
      assert.deepEqual(first, first.map((_s, i) => i + 1));
      assert.equal(cursors.get('r').eof, false, 'the rest is still pending');
      const rest = spool.loadReplayable(null, { cursors }).map((e) => e.seq);
      assert.deepEqual([...first, ...rest], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'no duplicates, no gaps');
      assert.equal(cursors.get('r').eof, true);
    });

    it('a cursor whose run file is gone is dropped', () => {
      const spool = runsAt([['r', 1_000, 6], ['s', 2_000, 2]]);
      const cursors = new Map();
      const budget = size(ev('r', 1, { pad: 'p'.repeat(100) })) * 2;
      assert.deepEqual(spool.loadReplayable(null, { budgetBytes: budget, cursors }).map((e) => e.seq), [1, 2]);
      assert.equal(cursors.get('r').eof, false);
      fs.rmSync(path.join(spool.dir, 'r.jsonl')); // removed by another process
      const next = spool.loadReplayable(null, { budgetBytes: budget, cursors });
      assert.equal(cursors.has('r'), false, 'stale cursor removed');
      assert.deepEqual(next.map((e) => `${e.run_id}:${e.seq}`), ['s:1', 's:2'], 'the next run carries on');
    });

    it('an event over maxEventBytes is skipped and reported; the cursor moves past it, newer events and runs follow', () => {
      const stateDir = tmp('moag-spool-state-');
      const cwd = tmp('moag-spool-ws-');
      const a = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false, now: () => 1_000 });
      a.openRun('a');
      a.append(ev('a', 1));
      a.append(ev('a', 2, { pad: 'z'.repeat(5_000) }));
      a.append(ev('a', 3));
      const b = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false, now: () => 2_000 });
      b.openRun('b');
      b.append(ev('b', 1));
      const spool = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
      const skipped: Array<[number, number]> = [];
      const cursors = new Map();
      const got = spool.loadReplayable(null, {
        cursors, budgetBytes: 4_000, maxEventBytes: 4_000, onOversize: (e, bytes) => skipped.push([e.seq, bytes]),
      });
      assert.deepEqual(got.map((e) => `${e.run_id}:${e.seq}`), ['a:1', 'a:3', 'b:1']);
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0][0], 2);
      assert.ok(skipped[0][1] > 4_000);
      assert.deepEqual(cursors.get('a'), { ...cursors.get('a'), seq: 3, eof: true }, 'the skipped seq is not "taken"');
      assert.deepEqual(spool.loadReplayable(null, { cursors, maxEventBytes: 4_000, onOversize: () => skipped.push([0, 0]) }), []);
      assert.equal(skipped.length, 1, 'never reported twice');
    });

    it('a run whose only unacked event is oversized is tracked (eof, seq 0) rather than re-read every time', () => {
      const spool = runsAt([['r', 1_000, 0]]);
      spool.append(ev('r', 1, { pad: 'z'.repeat(5_000) }));
      const cursors = new Map();
      let reports = 0;
      assert.deepEqual(spool.loadReplayable(null, { cursors, maxEventBytes: 1_000, onOversize: () => { reports++; } }), []);
      assert.deepEqual(cursors.get('r'), { ...cursors.get('r'), seq: 0, eof: true });
      spool.loadReplayable(null, { cursors, maxEventBytes: 1_000, onOversize: () => { reports++; } });
      assert.equal(reports, 1);
    });

    it('a run already being replayed is not re-checked for a live owner', () => {
      let alive = false;
      const stateDir = tmp('moag-spool-state-');
      const cwd = tmp('moag-spool-ws-');
      const w = new OnosooSpool(stateDir, cwd, { isPidAlive: () => false });
      w.openRun('r');
      for (let s = 1; s <= 4; s++) { w.append(ev('r', s)); }
      setMetaPid(w, 'r', 999_999);
      const spool = new OnosooSpool(stateDir, cwd, { isPidAlive: () => alive });
      const cursors = new Map();
      const budget = size(ev('r', 1)) * 2;
      assert.deepEqual(spool.loadReplayable(null, { budgetBytes: budget, cursors }).map((e) => e.seq), [1, 2]);
      alive = true; // the pid is reused by an unrelated process mid-replay
      assert.deepEqual(spool.loadReplayable(null, { budgetBytes: budget, cursors }).map((e) => e.seq), [3, 4]);
    });
  });

  describe('pid reuse: is the meta pid still the process that wrote the run?', () => {
    const HOUR = 60 * 60 * 1000;
    const MIN = 60 * 1000;
    const OTHER = 999_999;

    /** Write run "r" as process OTHER would have; returns a reader built with `opts`. */
    function written(opts: {
      platform: NodeJS.Platform; procStart?: (pid: number) => string | null;
      writerProcStart?: string | null; startedAgoMs?: number; idleMs?: number; alive?: boolean;
    }) {
      const stateDir = tmp('moag-spool-state-');
      const cwd = tmp('moag-spool-ws-');
      const now = Date.now();
      const w = new OnosooSpool(stateDir, cwd, {
        isPidAlive: () => false, now: () => now - (opts.startedAgoMs ?? 0), platform: opts.platform,
        procStart: () => opts.writerProcStart ?? null,
      });
      w.openRun('r');
      w.append(ev('r', 1));
      setMetaPid(w, 'r', OTHER);
      const file = path.join(w.dir, 'r.jsonl');
      const mtime = new Date(now - (opts.idleMs ?? 0));
      fs.utimesSync(file, mtime, mtime);
      const reader = new OnosooSpool(stateDir, cwd, {
        isPidAlive: (pid) => pid === OTHER && opts.alive !== false, now: () => now, platform: opts.platform,
        ...(opts.procStart ? { procStart: opts.procStart } : {}),
      });
      return { reader, file };
    }
    const replayed = (s: OnosooSpool): number[] => s.loadReplayable(null).map((e) => e.seq);

    it('openRun records proc_start on Linux only', () => {
      const linux = written({ platform: 'linux', writerProcStart: '4242' });
      assert.equal(JSON.parse(fs.readFileSync(linux.file, 'utf-8').split('\n')[0]).meta.proc_start, '4242');
      const win = written({ platform: 'win32', writerProcStart: '4242' });
      assert.equal('proc_start' in JSON.parse(fs.readFileSync(win.file, 'utf-8').split('\n')[0]).meta, false);
    });

    describe('linux', () => {
      it('the same start time: the owner is alive, the run is skipped', () => {
        const { reader } = written({ platform: 'linux', writerProcStart: '4242', procStart: () => '4242', idleMs: 10 * HOUR, startedAgoMs: 3 * 24 * HOUR });
        assert.deepEqual(replayed(reader), [], 'a start-time match wins over age and idleness');
      });

      it('a different start time: the pid was reused, the run is replayed', () => {
        const { reader } = written({ platform: 'linux', writerProcStart: '4242', procStart: () => '9999' });
        assert.deepEqual(replayed(reader), [1]);
      });

      it('a dead pid is replayed whatever the start time', () => {
        const { reader } = written({ platform: 'linux', writerProcStart: '4242', procStart: () => '4242', alive: false });
        assert.deepEqual(replayed(reader), [1]);
      });

      it('an unreadable start time falls back to idleness', () => {
        const fresh = written({ platform: 'linux', writerProcStart: '4242', procStart: () => null, idleMs: MIN });
        assert.deepEqual(replayed(fresh.reader), [], 'recently written: still owned');
        const idle = written({ platform: 'linux', writerProcStart: '4242', procStart: () => null, idleMs: 11 * MIN });
        assert.deepEqual(replayed(idle.reader), [1]);
      });

      it('a meta without proc_start (an older spool) falls back to idleness', () => {
        const fresh = written({ platform: 'linux', writerProcStart: null, procStart: () => '1', startedAgoMs: 3 * 24 * HOUR, idleMs: MIN });
        assert.deepEqual(replayed(fresh.reader), []);
        const idle = written({ platform: 'linux', writerProcStart: null, procStart: () => '1', idleMs: 11 * MIN });
        assert.deepEqual(replayed(idle.reader), [1]);
      });
    });

    describe('other platforms (win32, darwin)', () => {
      for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
        it(`${platform}: a run 3 days old, touched 1 min ago, with a live pid → owned (skipped)`, () => {
          const { reader } = written({ platform, startedAgoMs: 3 * 24 * HOUR, idleMs: MIN });
          assert.deepEqual(replayed(reader), []);
        });

        it(`${platform}: file idle for 11 min → treated as dead (a reused pid) and replayed`, () => {
          const { reader } = written({ platform, idleMs: 11 * MIN });
          assert.deepEqual(replayed(reader), [1]);
        });

        it(`${platform}: the limit is SPOOL_OWNER_MAX_IDLE_MS = 10 min`, () => {
          assert.equal(SPOOL_OWNER_MAX_IDLE_MS, 10 * MIN);
          assert.deepEqual(replayed(written({ platform, idleMs: 9 * MIN }).reader), []);
        });

        it(`${platform}: dead pid → replayed`, () => {
          const { reader } = written({ platform, alive: false });
          assert.deepEqual(replayed(reader), [1]);
        });

        it(`${platform}: the proc reader is never consulted`, () => {
          let asked = 0;
          const { reader } = written({ platform, procStart: () => { asked++; return 'x'; } });
          assert.deepEqual(replayed(reader), []);
          assert.equal(asked, 0);
        });
      }

      it('started_at plays no part in ownership: an unparsable one with a fresh file is still owned', () => {
        const { reader, file } = written({ platform: 'win32' });
        const lines = fs.readFileSync(file, 'utf-8').split('\n');
        const meta = JSON.parse(lines[0]);
        meta.meta.started_at = 'not a date';
        lines[0] = JSON.stringify(meta);
        fs.writeFileSync(file, lines.join('\n'));
        assert.deepEqual(replayed(reader), []);
      });
    });

    it('touchRun refreshes the file mtime so a quiet live run stays owned', () => {
      const { reader, file } = written({ platform: 'win32', idleMs: 3 * HOUR });
      assert.ok(reader.touchRun('r'));
      assert.ok(Date.now() - fs.statSync(file).mtimeMs < HOUR);
      assert.deepEqual(replayed(reader), []);
      assert.equal(reader.touchRun('missing'), false, 'never throws for a missing file');
      assert.equal(reader.touchRun('../escape'), false);
    });
  });

  it('refuses a run id that is not a safe file name', () => {
    const { spool } = mk();
    assert.equal(spool.openRun('../escape'), false);
    assert.equal(spool.append(ev('../escape', 1)), false);
  });

  it('creates files with owner-only permissions (POSIX)', function () {
    if (process.platform === 'win32') { this.skip(); }
    const { spool } = mk();
    spool.openRun('r');
    assert.equal(fs.statSync(spool.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(spool.dir, 'r.jsonl')).mode & 0o777, 0o600);
  });
});
