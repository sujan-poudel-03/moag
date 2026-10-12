import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import {
  parseWorkerLine, foldRunEvent, emptyRunView, exitToRunStatus, parseJob, WorkerEvent, RunView, mergeRunViews,
  HEADLESS_EVENTS, WORKER_ONLY_EVENTS,
} from '../../../server/worker-protocol';
import { MAX_LINE_BYTES } from '../../../server/jobs';
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

/**
 * The web run view's `foldEvent`, cut out of the text of web/js/screens/run.js
 * and evaluated on its own. Works on an LF and on a CRLF copy of that file.
 */
function extractWebFoldEvent(source: string): (view: RunView, ev: WorkerEvent) => RunView {
  const m = /export function foldEvent\(view, ev\) \{[\s\S]*?\r?\n\}\r?\n/.exec(source);
  assert.ok(m, 'foldEvent found in web/js/screens/run.js');
  const ctx: { foldEvent?: (v: RunView, e: WorkerEvent) => RunView } = {};
  vm.runInNewContext(`${m[0].replace('export function', 'function')}\nthis.foldEvent = foldEvent;`, ctx);
  assert.equal(typeof ctx.foldEvent, 'function');
  return ctx.foldEvent as (v: RunView, e: WorkerEvent) => RunView;
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
    });

    it('keeps a cost source only from the closed set; a line without one still parses', () => {
      for (const source of ['reported', 'estimated', 'none']) {
        assert.deepEqual(parseWorkerLine(line({ event: 'cost', usd: 0.5, source })), { event: 'cost', usd: 0.5, source });
      }
      assert.deepEqual(parseWorkerLine(line({ event: 'cost', usd: 0.5, source: 'guessed' })), { event: 'cost', usd: 0.5 });
      assert.deepEqual(parseWorkerLine(line({ event: 'cost', usd: 0.5, source: 7 })), { event: 'cost', usd: 0.5 });
      assert.deepEqual(parseWorkerLine(line({ event: 'cost', usd: 0.5 })), { event: 'cost', usd: 0.5 });
      assert.deepEqual(parseWorkerLine(line({ event: 'cost', usd: 0, source: 'none' })), { event: 'cost', usd: 0, source: 'none' });
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

    it('parses task-pid and rejects a non-positive, fractional or missing pid / alive flag', () => {
      assert.deepEqual(parseWorkerLine(line({ event: 'task-pid', pid: 4321, alive: true })), { event: 'task-pid', pid: 4321, alive: true });
      assert.deepEqual(parseWorkerLine(line({ event: 'task-pid', pid: 4321, alive: false })), { event: 'task-pid', pid: 4321, alive: false });
      for (const bad of [{ pid: 0, alive: true }, { pid: -5, alive: true }, { pid: 1.5, alive: true }, { pid: '12', alive: true }, { pid: 12 }, { pid: 12, alive: 'yes' }]) {
        assert.equal(parseWorkerLine(line({ event: 'task-pid', ...bad })), null, JSON.stringify(bad));
      }
    });

    it('rejects a probe row with an unknown engine', () => {
      assert.equal(parseWorkerLine(line({ event: 'probe-result', engines: [{ id: 'evil', available: true }] })), null);
    });

    describe('dependency-install events', () => {
      const installed = {
        event: 'dependencies-installed', stage: 'task', taskId: 't1', ecosystem: 'npm', dir: '.',
        trigger: 'install-dir-missing', command: 'npm install --no-audit --no-fund', durationMs: 1234,
        exitCode: 0, timedOut: false, tail: 'added 1 package', note: null,
      };

      it('parses all three events', () => {
        assert.deepEqual(parseWorkerLine(line(installed)), installed);
        const failed = { ...installed, event: 'dependencies-install-failed', exitCode: 1, tail: 'ERESOLVE' };
        assert.equal(parseWorkerLine(line(failed))?.event, 'dependencies-install-failed');
        const note = {
          ...installed, event: 'dependencies-not-installed', ecosystem: 'python', command: null,
          durationMs: 0, exitCode: null, tail: '', note: 'not installed: no virtualenv',
        };
        assert.deepEqual(parseWorkerLine(line(note)), note);
      });

      it('omits a missing taskId and rejects an empty one', () => {
        const noTask: Record<string, unknown> = { ...installed };
        delete noTask.taskId;
        const parsed = parseWorkerLine(line(noTask)) as Record<string, unknown> | null;
        assert.ok(parsed);
        assert.equal('taskId' in parsed, false);
        assert.equal(parseWorkerLine(line({ ...installed, taskId: '' })), null);
      });

      it('rejects malformed lines', () => {
        const bad: Record<string, unknown>[] = [
          { ...installed, ecosystem: 'bower' },
          { ...installed, stage: 'deploy' },
          { ...installed, trigger: 'because' },
          { ...installed, command: null },
          { ...installed, event: 'dependencies-install-failed', command: null },
          { ...installed, durationMs: -1 },
          { ...installed, durationMs: 'fast' },
          { ...installed, timedOut: 'no' },
          { ...installed, exitCode: 1.5 },
          { ...installed, tail: 42 },
          { ...installed, note: 7 },
          { ...installed, dir: null },
        ];
        for (const b of bad) {
          assert.equal(parseWorkerLine(line(b)), null, JSON.stringify(b));
        }
      });

      it('cuts a long tail to its last 2000 characters', () => {
        const tail = 'a'.repeat(3000) + 'b'.repeat(2000);
        const parsed = parseWorkerLine(line({ ...installed, event: 'dependencies-install-failed', exitCode: 1, tail })) as { tail: string };
        assert.equal(parsed.tail.length, 2000);
        assert.equal(parsed.tail, 'b'.repeat(2000));
      });

      it('does not change the run view', () => {
        const v = fold([{ event: 'state', state: 'playing' }, installed]);
        assert.deepEqual(v, { ...emptyRunView(), runnerState: 'playing' });
      });
    });

    it('pins HEADLESS_EVENTS', () => {
      assert.deepEqual([...HEADLESS_EVENTS], [
        'state', 'task-started', 'task-completed', 'task-failed', 'task-escalate',
        'incident', 'error', 'budget-exceeded', 'manual-gate',
        'dependencies-installed', 'dependencies-install-failed', 'dependencies-not-installed',
      ]);
    });
  });

  describe('task-changes', () => {
    const good = (): Record<string, unknown> => ({
      event: 'task-changes', task_id: 't1', status: 'completed', source: 'worktree',
      base_sha: 'a'.repeat(40), commit_sha: null, branch: 'main',
      files: [
        { path: 'a.ts', status: 'modified', binary: false, added: 2, removed: 1 },
        { path: 'b.ts', status: 'renamed', old_path: 'old.ts', binary: false, added: 0, removed: 0 },
        { path: 'img.png', status: 'added', binary: true, added: null, removed: null },
      ],
      diff: { text: 'diff --git a/a.ts b/a.ts\n', truncated: true, bytes: 70000, redactions: 2 },
    });

    it('pins WORKER_ONLY_EVENTS', () => {
      assert.deepEqual([...WORKER_ONLY_EVENTS], [
        'cost', 'task-engine', 'task-error-tail', 'plan-outcome', 'probe-result', 'run-finished', 'warning', 'task-pid',
        'task-changes',
      ]);
    });

    it('parses a well-formed line, keeps diff.truncated and drops ts and unknown keys', () => {
      const parsed = parseWorkerLine(line({ ...good(), extra: 'x' }));
      assert.ok(parsed && parsed.event === 'task-changes');
      assert.equal(parsed.diff?.truncated, true);
      assert.ok(!('ts' in parsed));
      assert.deepEqual(parsed, good());
    });

    it('accepts a stray top-level truncated and drops it', () => {
      const parsed = parseWorkerLine(line({ ...good(), truncated: true }));
      assert.ok(parsed);
      assert.ok(!('truncated' in parsed));
    });

    it('accepts diff null with a diff_error', () => {
      const parsed = parseWorkerLine(line({ ...good(), diff: null, diff_error: 'redaction failed' }));
      assert.ok(parsed && parsed.event === 'task-changes');
      assert.equal(parsed.diff, null);
      assert.equal(parsed.diff_error, 'redaction failed');
    });

    const bad: Array<[string, (o: Record<string, unknown>) => void]> = [
      ['missing task_id', (o) => { delete o.task_id; }],
      ['bad status', (o) => { o.status = 'skipped'; }],
      ['bad source', (o) => { o.source = 'stash'; }],
      ['base_sha not a string', (o) => { o.base_sha = 1; }],
      ['commit_sha a number', (o) => { o.commit_sha = 5; }],
      ["file status 'copied'", (o) => { (o.files as Array<Record<string, unknown>>)[0].status = 'copied'; }],
      ["binary 'yes'", (o) => { (o.files as Array<Record<string, unknown>>)[0].binary = 'yes'; }],
      ['negative added', (o) => { (o.files as Array<Record<string, unknown>>)[0].added = -1; }],
      ['fractional removed', (o) => { (o.files as Array<Record<string, unknown>>)[0].removed = 1.5; }],
      ['old_path not a string', (o) => { (o.files as Array<Record<string, unknown>>)[1].old_path = 3; }],
      ['files not an array', (o) => { o.files = {}; }],
      ['a file that is null', (o) => { o.files = [null]; }],
      ['diff.bytes negative', (o) => { (o.diff as Record<string, unknown>).bytes = -1; }],
      ['diff missing truncated', (o) => { delete (o.diff as Record<string, unknown>).truncated; }],
      ["diff.truncated 'no'", (o) => { (o.diff as Record<string, unknown>).truncated = 'no'; }],
      ['diff.redactions fractional', (o) => { (o.diff as Record<string, unknown>).redactions = 0.5; }],
      ['diff a string', (o) => { o.diff = 'x'; }],
      ['diff missing', (o) => { delete o.diff; }],
      ['diff_error a number', (o) => { o.diff_error = 1; }],
    ];
    for (const [label, mutate] of bad) {
      it(`returns null (never throws) for ${label}`, () => {
        const o = good();
        mutate(o);
        assert.equal(parseWorkerLine(line(o)), null);
      });
    }

    it('does not change the run view', () => {
      const parsed = parseWorkerLine(line(good()));
      assert.ok(parsed);
      const v = { ...emptyRunView(), runnerState: 'playing' };
      assert.deepEqual(foldRunEvent(v, parsed), v);
    });

    it('a maximal line (64 KB of control chars + 500 files) stays under MAX_LINE_BYTES', () => {
      const files = Array.from({ length: 500 }, (_, i) => ({
        path: `src/some/deeply/nested/directory/structure/file-${String(i).padStart(4, '0')}.tsx`,
        status: 'renamed', old_path: `src/old/deeply/nested/directory/structure/file-${String(i).padStart(4, '0')}.tsx`,
        binary: false, added: 99999, removed: 99999,
      }));
      const o = { ...good(), files, diff: { text: '\u0001'.repeat(65_536), truncated: true, bytes: 10_000_000, redactions: 0 } };
      const l = line(o);
      assert.ok(Buffer.byteLength(l) < MAX_LINE_BYTES, `${Buffer.byteLength(l)} bytes`);
      assert.ok(parseWorkerLine(l));
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

    // The web copy of the fold is read out of web/js/screens/run.js as text. A
    // checkout may hold that file with CRLF (Git for Windows defaults to
    // core.autocrlf=true), so the extraction is run against both renditions.
    for (const [label, eolOf] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
      it(`the web run view folds every event exactly like the server (${label} checkout)`, () => {
        const onDisk = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'web', 'js', 'screens', 'run.js'), 'utf-8');
        const src = onDisk.replace(/\r\n/g, '\n').replace(/\n/g, eolOf);
        assert.equal(src.includes('\r\n'), eolOf === '\r\n', `the source under test is ${label}`);
        const webFold = extractWebFoldEvent(src);
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
          web = webFold(web, parsed);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(web)), JSON.parse(JSON.stringify(server)));
        assert.equal(web.tasks.s, 'skipped');
        assert.equal(web.tasks.b, 'blocked');
      });
    }

    it('reports a web source without foldEvent instead of comparing nothing', () => {
      assert.throws(() => extractWebFoldEvent('export function somethingElse(view, ev) {\n  return view;\n}\n'), /foldEvent found in web\/js\/screens\/run\.js/);
      assert.throws(() => extractWebFoldEvent(''), /foldEvent found in web\/js\/screens\/run\.js/);
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
      const runWithStandards = { ...run, standardsPath: '/data/projects/p/runs/r1/standards.json' };
      assert.deepEqual(parseJob(runWithStandards), runWithStandards, 'a run job round-trips its standards file path');
      assert.equal('standardsPath' in (parseJob(run) as object), false, 'absent stays absent');
      const plan = { kind: 'plan', mode: 'initial', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'codex' };
      assert.deepEqual(parseJob(plan), plan);
      const listed = { ...plan, repoListingPath: '/data/projects/p/plans/x/repo-files.txt' };
      assert.deepEqual(parseJob(listed), listed);
      const withStandards = { ...listed, standardsPath: '/data/projects/p/plans/x/standards.json' };
      assert.deepEqual(parseJob(withStandards), withStandards, 'a plan job round-trips its standards file path');
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
      for (const bad of [42, '', null, ['/x'], { path: '/x' }, true]) {
        assert.equal(parseJob({ kind: 'run', runId: 'r', workspace: '/w', planPath: '/p', startPlaylistIndex: 0, verify: true, allowedEngines: ['claude'], standardsPath: bad }), null, `run standardsPath ${JSON.stringify(bad)}`);
        assert.equal(parseJob({ kind: 'plan', mode: 'delta', workspace: '/w', planPath: '/p', outPath: '/o', engine: 'claude', standardsPath: bad }), null, `plan standardsPath ${JSON.stringify(bad)}`);
      }
    });
  });
});
