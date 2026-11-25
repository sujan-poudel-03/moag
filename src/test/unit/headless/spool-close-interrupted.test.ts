// ─── Ending a run the daemon was cut off in, in ONOSOO's eyes ───
//
// closeInterrupted writes an `error` and a `run-finished` (code 2) after the run's last event, so the replay at the
// next start delivers them and ONOSOO stops showing the run as running.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INTERRUPTED_RUN_MESSAGE, OnosooSpool, RelayEvent } from '../../../headless/onosoo-spool';

const tmp = (p: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const ev = (runId: string, seq: number, type = 'task-started', data: Record<string, unknown> = {}): RelayEvent =>
  ({ run_id: runId, seq, type, at: '2026-11-25T10:00:00.000Z', data });

function mk(): OnosooSpool {
  return new OnosooSpool(tmp('moag-close-state-'), tmp('moag-close-ws-'), { isPidAlive: () => false, now: () => Date.parse('2026-11-25T10:30:00Z') });
}

describe('OnosooSpool.closeInterrupted', () => {
  it('adds an error and a failed run-finished after the last event, which the replay then delivers', () => {
    const spool = mk();
    spool.openRun('run-a');
    for (let s = 1; s <= 4; s++) { assert.ok(spool.append(ev('run-a', s))); }
    assert.equal(spool.closeInterrupted('run-a', INTERRUPTED_RUN_MESSAGE), true);
    const events = spool.loadReplayable(null);
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[1, 'task-started'], [2, 'task-started'], [3, 'task-started'], [4, 'task-started'], [5, 'error'], [6, 'run-finished']]);
    assert.equal(events[4].data.message, INTERRUPTED_RUN_MESSAGE);
    assert.equal(events[5].data.code, 2);
    assert.equal(events[5].at, '2026-11-25T10:30:00.000Z');
  });

  it('only what was not yet acked is replayed, so events ONOSOO already has are not sent twice', () => {
    const spool = mk();
    spool.openRun('run-a');
    for (let s = 1; s <= 3; s++) { spool.append(ev('run-a', s)); }
    spool.writeAck('run-a', 3);
    spool.closeInterrupted('run-a', 'x');
    assert.deepEqual(spool.loadReplayable(null).map((e) => e.seq), [4, 5]);
  });

  it('does nothing for a run that already ended with run-finished', () => {
    const spool = mk();
    spool.openRun('run-a');
    spool.append(ev('run-a', 1));
    spool.append(ev('run-a', 2, 'run-finished', { code: 0 }));
    assert.equal(spool.closeInterrupted('run-a', 'x'), false);
    assert.deepEqual(spool.loadReplayable(null).map((e) => e.type), ['task-started', 'run-finished']);
  });

  it('does nothing for a run ONOSOO never heard of: no file, or a file with no events', () => {
    const spool = mk();
    assert.equal(spool.closeInterrupted('never-started', 'x'), false);
    spool.openRun('only-meta');
    assert.equal(spool.closeInterrupted('only-meta', 'x'), false);
    assert.deepEqual(spool.loadReplayable(null), []);
  });

  it('refuses a run id that is not a plain id, so it can never name another file', () => {
    const spool = mk();
    assert.equal(spool.closeInterrupted('../escape', 'x'), false);
    assert.equal(spool.closeInterrupted('a/b', 'x'), false);
    assert.equal(spool.closeInterrupted('', 'x'), false);
  });

  it('is safe to call twice: the second call finds run-finished and adds nothing', () => {
    const spool = mk();
    spool.openRun('run-a');
    spool.append(ev('run-a', 1));
    assert.equal(spool.closeInterrupted('run-a', 'x'), true);
    assert.equal(spool.closeInterrupted('run-a', 'x'), false);
    assert.equal(spool.loadReplayable(null).length, 3);
  });

  it('skips lines of another run or that are not events, and still finds the real last seq', () => {
    const spool = mk();
    spool.openRun('run-a');
    spool.append(ev('run-a', 1));
    fs.appendFileSync(path.join(spool.dir, 'run-a.jsonl'), 'not json\n' + JSON.stringify(ev('other', 99)) + '\n');
    spool.append(ev('run-a', 2));
    assert.equal(spool.closeInterrupted('run-a', 'x'), true);
    assert.deepEqual(spool.loadReplayable(null).map((e) => e.seq), [1, 2, 3, 4]);
  });

  it('reports false when the spool directory is over its size cap, rather than half-closing', () => {
    const spool = new OnosooSpool(tmp('moag-close-state-'), tmp('moag-close-ws-'), { isPidAlive: () => false, maxDirBytes: 400 });
    spool.openRun('run-a');
    spool.append(ev('run-a', 1));
    assert.equal(spool.closeInterrupted('run-a', 'x'.repeat(2000)), false);
  });
});
