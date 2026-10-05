import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import {
  parseWorkerLine, foldRunEvent, emptyRunView, exitToRunStatus, parseJob, WorkerEvent, RunView, mergeRunViews,
} from '../../../server/worker-protocol';
import { TaskStatus } from '../../../models/types';

const line = (o: Record<string, unknown>) => JSON.stringify({ ts: '2026-10-04T00:00:00.000Z', ...o });

function fold(events: Array<Record<string, unknown>>): RunView {
  let v = emptyRunView();
  for (const e of events) {
    const parsed = parseWorkerLine(line(e));
    assert.ok(parsed, `should parse ${JSON.stringify(e)}`);
    v = foldRunEvent(v, parsed as WorkerEvent);
  }
  return v;
}

describe('worker-protocol', () => {
  describe('parseWorkerLine', () => {
    it('ignores non-JSON stray output and non-objects', () => {
      for (const l of ['', 'hello from an adapter', '{oops', '[1,2]', '42', 'null', '"state"']) {
        assert.equal(parseWorkerLine(l), null, l);
      }
    });

    it('ignores unknown events and events missing required fields', () => {
      assert.equal(parseWorkerLine(line({ event: 'pr-created', url: 'x' })), null);
      assert.equal(parseWorkerLine(line({ event: 'gate-approved' })), null, 'no event can self-approve');
      assert.equal(parseWorkerLine(line({ event: 'task-completed' })), null);
      assert.equal(parseWorkerLine(line({ event: 'state', state: 'hacked' })), null);
      assert.equal(parseWorkerLine(line({ event: 'cost', usd: -1 })), null);
      assert.equal(parseWorkerLine(line({ event: 'cost', usd: 'NaN' })), null);
      assert.equal(parseWorkerLine(line({ event: 'task-engine', id: 't', engine: 'rm' })), null);
      assert.equal(parseWorkerLine(line({ event: 'plan-outcome', kind: 'approved' })), null);
      assert.equal(parseWorkerLine(line({ event: 'verify-' })), null);
      assert.equal(parseWorkerLine(line({ event: 'run-finished' })), null);
    });

    it('accepts every headless and worker-only event', () => {
      const cases: Array<Record<string, unknown>> = [
        { event: 'state', state: 'playing' },
        { event: 'task-started', id: 't1', name: 'A' },
        { event: 'task-completed', id: 't1', name: 'A' },
        { event: 'task-failed', id: 't1', name: 'A' },
        { event: 'task-escalate', id: 't1', name: 'A', category: 'auth' },
        { event: 'incident', id: 't1', name: 'A', summary: 's', issueUrl: null },
        { event: 'error', message: 'boom' },
        { event: 'budget-exceeded', totalCost: 10.2, budget: 10 },
        { event: 'manual-gate', id: 'g', name: 'Release', note: 'x' },
        { event: 'cost', usd: 0.5 },
        { event: 'task-engine', id: 't1', engine: 'codex' },
        { event: 'task-error-tail', id: 't1', tail: 'last lines' },
        { event: 'plan-outcome', kind: 'appended' },
        { event: 'probe-result', engines: [{ id: 'claude', available: true, version: '2.1.4' }, { id: 'gemini', available: false, error: 'not found' }] },
        { event: 'run-finished', code: 3 },
        { event: 'warning', message: 'w' },
        { event: 'verify-finished', passed: true },
      ];
      for (const c of cases) {
        const p = parseWorkerLine(line(c));
        assert.ok(p, `parse ${c.event}`);
      }
      const v = parseWorkerLine(line({ event: 'verify-report', passed: false, score: 3 }));
      assert.deepEqual(v, { event: 'verify', name: 'verify-report', data: { passed: false, score: 3 } });
    });

    it('rejects a probe row with an unknown engine', () => {
      assert.equal(parseWorkerLine(line({ event: 'probe-result', engines: [{ id: 'evil', available: true }] })), null);
    });
  });

  describe('foldRunEvent', () => {
    it('tracks runner state and per-task statuses', () => {
      const v = fold([
        { event: 'state', state: 'playing' },
        { event: 'task-started', id: 'a', name: 'A' },
        { event: 'task-completed', id: 'a', name: 'A' },
        { event: 'task-started', id: 'b', name: 'B' },
        { event: 'task-failed', id: 'b', name: 'B' },
        { event: 'task-started', id: 'c', name: 'C' },
        { event: 'state', state: 'idle' },
      ]);
      assert.equal(v.runnerState, 'idle');
      assert.deepEqual(v.tasks, { a: 'completed', b: 'failed', c: 'running' });
      assert.equal(v.haltReason, null);
      assert.equal(v.gate, undefined);
    });

    it('honours the status a task-completed/task-failed event carries (skipped, blocked)', () => {
      const v = fold([
        { event: 'task-completed', id: 's', name: 'S', status: 'skipped' },
        { event: 'task-failed', id: 'b', name: 'B', status: 'blocked' },
        { event: 'task-completed', id: 'c', name: 'C', status: 'completed' },
        { event: 'task-failed', id: 'f', name: 'F', status: 'failed' },
        // A contradictory status never turns a terminal event into a live one.
        { event: 'task-completed', id: 'x', name: 'X', status: 'running' },
        { event: 'task-failed', id: 'y', name: 'Y', status: 'completed' },
        { event: 'task-completed', id: 'z', name: 'Z', status: 'bogus' },
      ]);
      assert.deepEqual(v.tasks, { s: 'skipped', b: 'blocked', c: 'completed', f: 'failed', x: 'completed', y: 'failed', z: 'completed' });
    });

    it('the web run view folds every event exactly like the server', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'web', 'js', 'screens', 'run.js'), 'utf-8');
      const m = /export function foldEvent\(view, ev\) \{[\s\S]*?\n\}\n/.exec(src);
      assert.ok(m, 'foldEvent found in web/js/screens/run.js');
      const ctx: { foldEvent?: (v: unknown, e: unknown) => RunView } = {};
      vm.runInNewContext(`${m[0].replace('export function', 'function')}\nthis.foldEvent = foldEvent;`, ctx);
      const events: Array<Record<string, unknown>> = [
        { event: 'state', state: 'playing' },
        { event: 'task-started', id: 'a', name: 'A' },
        { event: 'task-completed', id: 'a', name: 'A', status: 'completed' },
        { event: 'task-completed', id: 's', name: 'S', status: 'skipped' },
        { event: 'task-failed', id: 'b', name: 'B', status: 'blocked' },
        { event: 'task-failed', id: 'f', name: 'F' },
        { event: 'cost', usd: 0.5 },
        { event: 'manual-gate', id: 'g', name: 'G' },
        { event: 'budget-exceeded', totalCost: 2, budget: 1 },
      ];
      let server = emptyRunView();
      let web = emptyRunView();
      for (const e of events) {
        const parsed = parseWorkerLine(JSON.stringify(e)) as WorkerEvent;
        server = foldRunEvent(server, parsed);
        web = ctx.foldEvent!(web, parsed);
      }
      assert.deepEqual(JSON.parse(JSON.stringify(web)), JSON.parse(JSON.stringify(server)));
      assert.equal(web.tasks.s, 'skipped');
      assert.equal(web.tasks.b, 'blocked');
    });

    it('sums cost events', () => {
      const v = fold([{ event: 'cost', usd: 0.25 }, { event: 'cost', usd: 1.5 }]);
      assert.equal(v.costUsd, 1.75);
    });

    it('manual-gate sets gate and haltReason', () => {
      const v = fold([{ event: 'state', state: 'playing' }, { event: 'manual-gate', id: 'rel', name: 'Release v1.3.0' }]);
      assert.deepEqual(v.gate, { taskId: 'rel', name: 'Release v1.3.0' });
      assert.equal(v.haltReason, 'manual-gate');
    });

    it('budget-exceeded sets haltReason without overriding a gate', () => {
      assert.equal(fold([{ event: 'budget-exceeded', totalCost: 11, budget: 10 }]).haltReason, 'budget-exceeded');
      const v = fold([{ event: 'manual-gate', id: 'g', name: 'G' }, { event: 'budget-exceeded', totalCost: 11, budget: 10 }]);
      assert.equal(v.haltReason, 'manual-gate');
    });

    it('is pure and ignores informational events', () => {
      const before = emptyRunView();
      const snapshot = JSON.stringify(before);
      const after = foldRunEvent(before, { event: 'task-started', id: 'x', name: 'X' });
      assert.equal(JSON.stringify(before), snapshot);
      assert.notEqual(after, before);
      for (const ev of [{ event: 'warning', message: 'w' }, { event: 'error', message: 'e' }, { event: 'run-finished', code: 0 }] as WorkerEvent[]) {
        assert.equal(foldRunEvent(before, ev), before);
      }
    });
  });

  describe('mergeRunViews', () => {
    it('layers task statuses (later wins), sums cost, takes state/gate/halt from the later segment', () => {
      const earlier: RunView = { runnerState: 'idle', tasks: { a: TaskStatus.Completed, g: TaskStatus.Completed, r: TaskStatus.Pending }, costUsd: 2, gate: { taskId: 'g', name: 'G' }, haltReason: 'manual-gate' };
      const later: RunView = { runnerState: 'playing', tasks: { r: TaskStatus.Running }, costUsd: 0.5, haltReason: null };
      const m = mergeRunViews(earlier, later);
      assert.deepEqual(m, { runnerState: 'playing', tasks: { a: 'completed', g: 'completed', r: 'running' }, costUsd: 2.5, haltReason: null });
      assert.equal(earlier.tasks.r, 'pending', 'inputs are not mutated');
      assert.equal(mergeRunViews(undefined, later), later, 'the first segment is its own view');
      assert.equal(mergeRunViews(null, later), later);
    });
  });

  describe('exitToRunStatus', () => {
    it('maps all five exit codes', () => {
      assert.equal(exitToRunStatus(0), 'completed');
      assert.equal(exitToRunStatus(1), 'gaps');
      assert.equal(exitToRunStatus(2), 'error');
      assert.equal(exitToRunStatus(3), 'awaiting-approval');
      assert.equal(exitToRunStatus(4), 'budget');
    });

    it('treats a signal/unknown exit as error', () => {
      assert.equal(exitToRunStatus(null), 'error');
      assert.equal(exitToRunStatus(137), 'error');
    });
  });

  describe('parseJob', () => {
    it('accepts well-formed jobs', () => {
      assert.deepEqual(parseJob({ kind: 'probe' }), { kind: 'probe' });
      const run = { kind: 'run', runId: 'r1', workspace: '/w', planPath: '/p.json', startPlaylistIndex: 2, verify: true, allowedEngines: ['claude'] };
      assert.deepEqual(parseJob(run), run);
      const plan = { kind: 'plan', mode: 'initial', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'codex' };
      assert.deepEqual(parseJob(plan), plan);
      const listed = { ...plan, repoListingPath: '/data/projects/p/plans/x/repo-files.txt' };
      assert.deepEqual(parseJob(listed), listed);
    });

    it('rejects malformed jobs', () => {
      assert.equal(parseJob(null), null);
      assert.equal(parseJob({ kind: 'shell', cmd: 'rm' }), null);
      assert.equal(parseJob({ kind: 'run', runId: 'r', workspace: '/w', planPath: '/p', startPlaylistIndex: -1, verify: true, allowedEngines: [] }), null);
      assert.equal(parseJob({ kind: 'run', runId: 'r', workspace: '/w', planPath: '/p', startPlaylistIndex: 0, verify: false, allowedEngines: [] }), null);
      assert.equal(parseJob({ kind: 'run', runId: 'r', workspace: '/w', planPath: '/p', startPlaylistIndex: 0, verify: true, allowedEngines: ['rm'] }), null);
      assert.equal(parseJob({ kind: 'plan', mode: 'full', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'claude' }), null);
      assert.equal(parseJob({ kind: 'plan', mode: 'delta', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'nope' }), null);
      assert.equal(parseJob({ kind: 'plan', mode: 'delta', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'claude', repoListingPath: 42 }), null);
      assert.equal(parseJob({ kind: 'plan', mode: 'delta', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'claude', repoListingPath: '' }), null);
    });
  });
});
