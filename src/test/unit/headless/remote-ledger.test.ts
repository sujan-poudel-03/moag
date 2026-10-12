// ─── Remote runs: daily spend ledger ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chargeFor, localDayKey, RemoteLedger, SPEND_FILE } from '../../../headless/remote-ledger';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-ledger-')));
}

/** A clock the test moves by hand. */
function clock(start: Date) {
  let t = start.getTime();
  return { now: () => new Date(t), set: (d: Date) => { t = d.getTime(); } };
}

describe('remote ledger', () => {
  it('localDayKey uses the local calendar date', () => {
    assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    assert.equal(localDayKey(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
  });

  it('reserves the whole allotment; a request above what remains is refused, not clamped', () => {
    const ledger = new RemoteLedger(tmp());
    assert.equal(ledger.remaining(10), 10);
    assert.equal(ledger.reserve('r1', 6, 10), true);
    assert.equal(ledger.remaining(10), 4);
    assert.equal(ledger.reserve('r2', 5, 10), false);
    assert.equal(ledger.remaining(10), 4, 'a refused reservation writes nothing');
    assert.equal(ledger.reserve('r2', 4, 10), true);
    assert.equal(ledger.remaining(10), 0);
    assert.equal(ledger.reserve('r1', 0.5, 100), false, 'a run id is reserved once');
  });

  it('settles at the reported sum; gemini, copilot, custom or an unreported call → full allotment; ollama → 0', () => {
    const ledger = new RemoteLedger(tmp());
    ledger.reserve('claude', 5, 100);
    ledger.record('claude', { usd: 1.25 }, 'claude');
    ledger.record('claude', { usd: 0.5 }, 'claude');
    assert.equal(ledger.settle('claude'), 1.75);

    ledger.reserve('gem', 5, 100);
    ledger.record('gem', { usd: 0 }, 'gemini');
    assert.equal(ledger.settle('gem'), 5);

    ledger.reserve('unrep', 4, 100);
    ledger.record('unrep', { usd: 0.1 }, 'claude');
    ledger.record('unrep', { unreported: true }, 'claude');
    assert.equal(ledger.settle('unrep'), 4);

    ledger.reserve('local', 3, 100);
    ledger.record('local', { usd: 0 }, 'ollama');
    assert.equal(ledger.settle('local'), 0);

    assert.equal(ledger.remaining(100), 100 - 1.75 - 5 - 4 - 0);
    assert.equal(chargeFor({ allotment: 2, reportedUsd: 1, unreported: false, engines: ['custom'] }), 2);
    assert.equal(chargeFor({ allotment: 2, reportedUsd: 1, unreported: false, engines: ['copilot'] }), 2);
  });

  it('survives a restart: reservations and charges persist', () => {
    const dir = tmp();
    const a = new RemoteLedger(dir);
    a.reserve('r1', 3, 10);
    a.record('r1', { usd: 1 }, 'claude');
    a.settle('r1');
    a.reserve('r2', 2, 10);
    const b = new RemoteLedger(dir);
    assert.equal(b.remaining(10), 10 - 1 - 2, 'r2 is still open (same pid) and counts in full');
    const mode = fs.statSync(path.join(dir, 'remote', SPEND_FILE)).mode & 0o777;
    if (process.platform !== 'win32') { assert.equal(mode, 0o600); }
  });

  it('an entry left open by a dead process is charged its full allotment on load', () => {
    const dir = tmp();
    const crashed = new RemoteLedger(dir, { pid: 999_001 });
    crashed.reserve('lost', 7, 10);
    crashed.record('lost', { usd: 0.25 }, 'claude');
    const next = new RemoteLedger(dir, { pid: 999_002, isPidAlive: () => false });
    const e = next.entries().find((x) => x.runId === 'lost')!;
    assert.equal(e.open, false);
    assert.equal(e.charged, 7);
    assert.equal(next.remaining(10), 3);
  });

  it('an entry open in another LIVE process is left open (still counted in full)', () => {
    const dir = tmp();
    new RemoteLedger(dir, { pid: 999_003 }).reserve('busy', 2, 10);
    const other = new RemoteLedger(dir, { pid: 999_004, isPidAlive: () => true });
    assert.equal(other.entries()[0].open, true);
    assert.equal(other.remaining(10), 8);
  });

  it('rolls over at local midnight: a new day starts empty', () => {
    const dir = tmp();
    const c = clock(new Date(2026, 9, 11, 23, 59, 0));
    const ledger = new RemoteLedger(dir, { now: c.now });
    ledger.reserve('late', 9, 10);
    ledger.record('late', { usd: 9 }, 'claude');
    ledger.settle('late');
    assert.equal(ledger.remaining(10), 1);
    c.set(new Date(2026, 9, 12, 0, 0, 1));
    assert.equal(ledger.remaining(10), 10);
    assert.equal(ledger.reserve('early', 10, 10), true);
    // And a restart on the new day reads the new day.
    assert.equal(new RemoteLedger(dir, { now: c.now }).remaining(10), 0);
  });

  it('a run open across midnight is charged to its reservation day; the new day starts clean', () => {
    const dir = tmp();
    const c = clock(new Date(2026, 9, 11, 23, 50, 0));
    const ledger = new RemoteLedger(dir, { now: c.now });
    assert.equal(ledger.reserve('night', 8, 10), true);
    assert.equal(ledger.reserve('extra', 3, 10), false, 'yesterday: the open reservation blocks overspend');
    c.set(new Date(2026, 9, 12, 0, 10, 0));
    assert.equal(ledger.remaining(10), 10, 'today owes nothing for yesterday\'s run');
    ledger.record('night', { usd: 4 }, 'claude');
    // A restart in the middle keeps the open entry too.
    const again = new RemoteLedger(dir, { now: c.now });
    assert.equal(again.entries().find((e) => e.runId === 'night')!.open, true);
    assert.equal(again.settle('night'), 4);
    assert.equal(again.spentOn('2026-10-11'), 4, 'charged to the reservation day');
    assert.equal(again.spentOn('2026-10-12'), 0);
    assert.equal(again.remaining(10), 10);
    // Once settled, the old day's entry is dropped at the next rollover.
    c.set(new Date(2026, 9, 13, 0, 0, 1));
    assert.deepEqual(again.entries(), []);
  });

  it('read-modify-write: two ledgers on one state dir never lose each other\'s entries', () => {
    const dir = tmp();
    const a = new RemoteLedger(dir);
    const b = new RemoteLedger(dir);
    assert.equal(a.reserve('ra', 6, 10), true);
    assert.equal(b.reserve('rb', 6, 10), false, 'b sees a\'s reservation');
    assert.equal(b.reserve('rb', 4, 10), true);
    a.record('ra', { usd: 1 }, 'claude');
    assert.deepEqual(new RemoteLedger(dir).entries().map((e) => [e.runId, e.reportedUsd]).sort(), [['ra', 1], ['rb', 0]]);
  });

  it('a file from an earlier day is ignored', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'remote', SPEND_FILE), JSON.stringify({
      day: '2000-01-01', entries: [{ runId: 'old', pid: 1, allotment: 99, reportedUsd: 0, unreported: false, engines: [], open: true, charged: null }],
    }));
    assert.equal(new RemoteLedger(dir, { isPidAlive: () => false }).remaining(10), 10);
  });

  for (const [label, text] of [['invalid JSON', '{oops'], ['a wrong shape', '{"day":"x","entries":[{"runId":5}]}'], ['an array', '[]']] as Array<[string, string]>) {
    it(`${label} fails closed: today counts as spent, with an error`, () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'remote'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'remote', SPEND_FILE), text);
      const ledger = new RemoteLedger(dir);
      assert.equal(ledger.remaining(1000), 0);
      assert.equal(ledger.reserve('r', 1, 1000), false);
      assert.equal(ledger.errors.length, 1);
    });
  }

  it('a fail-closed day ends at the next local midnight', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'remote', SPEND_FILE), '{oops');
    const c = clock(new Date(2026, 9, 11, 12, 0, 0));
    const ledger = new RemoteLedger(dir, { now: c.now });
    assert.equal(ledger.remaining(10), 0);
    c.set(new Date(2026, 9, 12, 0, 0, 1));
    assert.equal(ledger.remaining(10), 10);
  });

  it('chargeInFull closes an interrupted run at its allotment', () => {
    const ledger = new RemoteLedger(tmp());
    ledger.reserve('i', 4, 10);
    ledger.record('i', { usd: 0.1 }, 'claude');
    assert.equal(ledger.chargeInFull('i'), 4);
    assert.equal(ledger.remaining(10), 6);
  });
});
