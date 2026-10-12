// ─── Remote runs: run records ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEmptyPlan, createTask, dehydratePlan, hydratePlan } from '../../../models/plan';
import { TaskStatus } from '../../../models/types';
import { isHandStarted, RemoteRunRecord, RemoteRuns } from '../../../headless/remote-runs';

function tmp(prefix = 'moag-runs-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function record(over: Partial<RemoteRunRecord> = {}): RemoteRunRecord {
  const plan = createEmptyPlan('Remote plan');
  const a = createTask('Build', 'Build it');
  const b = createTask('Ship', 'Ship it');
  a.status = TaskStatus.Running;
  b.status = TaskStatus.Completed;
  plan.playlists[0].tasks.push(a, b);
  return {
    runId: 'run-1', projectId: 'web', commandId: 'cmd-1', kind: 'start-run', branch: 'moag/remote-1', startSha: 'a'.repeat(40),
    engine: 'claude', allotment: 5, startedAt: '2026-10-11T10:00:00.000Z', exitCode: null, outcome: 'live', gateTaskId: null,
    snapshot: dehydratePlan(plan),
    ...over,
  };
}

describe('remote run records', () => {
  it('saves and loads: the snapshot round-trips through dehydratePlan → hydratePlan deep-equal', () => {
    const dir = tmp();
    const runs = new RemoteRuns(dir);
    const r = record();
    runs.save(r);
    const loaded = runs.load('run-1')!;
    assert.deepEqual(loaded.record, JSON.parse(JSON.stringify(r)), 'what was saved is what loads (as JSON)');
    assert.deepEqual(loaded.plan, hydratePlan(r.snapshot, 'x'));
    assert.deepEqual(JSON.parse(JSON.stringify(dehydratePlan(loaded.plan))), JSON.parse(JSON.stringify(r.snapshot)));
    if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(runs.dir, 'run-1.json')).mode & 0o777, 0o600); }
  });

  it('a missing, unreadable or unsafe record loads as null', () => {
    const dir = tmp();
    const runs = new RemoteRuns(dir);
    assert.equal(runs.load('nope'), null);
    assert.equal(runs.load('../x'), null);
    fs.mkdirSync(runs.dir, { recursive: true });
    fs.writeFileSync(path.join(runs.dir, 'bad.json'), '{oops');
    assert.equal(runs.load('bad'), null);
    assert.throws(() => runs.save(record({ runId: '../escape' })));
  });

  it('marks live records interrupted at boot: Running → Failed, no exit code; finished ones untouched', () => {
    const dir = tmp();
    const runs = new RemoteRuns(dir, { now: () => new Date('2026-10-11T12:00:00Z') });
    runs.save(record());
    runs.save(record({ runId: 'run-2', outcome: 'finished', exitCode: 0, endedAt: '2026-10-11T11:00:00Z' }));
    assert.deepEqual(runs.markInterruptedOnBoot(), ['run-1']);
    const r = runs.get('run-1')!;
    assert.equal(r.outcome, 'interrupted');
    assert.equal(r.exitCode, null);
    assert.equal(r.endedAt, '2026-10-11T12:00:00.000Z');
    assert.deepEqual(r.snapshot.playlists[0].tasks.map((t) => t.status), [TaskStatus.Failed, TaskStatus.Completed]);
    assert.equal(runs.get('run-2')!.outcome, 'finished');
    assert.deepEqual(runs.markInterruptedOnBoot(), [], 'idempotent');
  });

  it('prunes ended records older than 30 days and beyond 200, never a live one', () => {
    const dir = tmp();
    const runs = new RemoteRuns(dir, { now: () => new Date('2026-10-11T12:00:00Z') });
    runs.save(record({ runId: 'old', outcome: 'finished', startedAt: '2026-08-01T00:00:00Z', endedAt: '2026-08-01T01:00:00Z' }));
    runs.save(record({ runId: 'old-live', startedAt: '2026-08-01T00:00:00Z' }));
    for (let i = 0; i < 202; i++) {
      runs.save(record({ runId: `r${i}`, outcome: 'finished', startedAt: new Date(Date.UTC(2026, 9, 10, 0, 0, i)).toISOString(), endedAt: '2026-10-10T12:00:00Z' }));
    }
    runs.prune();
    const left = runs.list().map((r) => r.runId);
    assert.ok(!left.includes('old'));
    assert.ok(left.includes('old-live'));
    assert.ok(!left.includes('r0') && !left.includes('r1'), 'the two oldest beyond 200 are gone');
    assert.equal(left.length, 201);
  });

  it('detects a run started by hand from its spool file', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'onosoo-spool', 'abc123'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'onosoo-spool', 'abc123', 'hand-run.jsonl'), '{"meta":{}}\n');
    assert.equal(isHandStarted(dir, 'hand-run'), true);
    assert.equal(isHandStarted(dir, 'other'), false);
    assert.equal(isHandStarted(dir, '../x'), false);
    assert.equal(isHandStarted(tmp(), 'hand-run'), false);
  });

  it('writes nothing under a project folder', () => {
    const project = tmp('moag-runs-project-');
    const state = tmp();
    new RemoteRuns(state).save(record());
    assert.deepEqual(fs.readdirSync(project), []);
    assert.ok(fs.existsSync(path.join(state, 'remote', 'runs', 'run-1.json')));
  });
});
