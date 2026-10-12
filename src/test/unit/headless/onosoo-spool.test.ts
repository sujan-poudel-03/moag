// ─── ONOSOO relay spool ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OnosooSpool, RelayEvent, SPOOL_MAX_AGE_MS } from '../../../headless/onosoo-spool';

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
