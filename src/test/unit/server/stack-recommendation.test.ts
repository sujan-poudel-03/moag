// ─── Stack recommendation: evidence only, Wilson lower bound, honest static default ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recommendStack, wilsonInterval, detectStackFromRepo, OutcomeLike, StaticRecommendation, MeasuredRecommendation,
  INSUFFICIENT_LABEL, DETECTED_LABEL, STATIC_LABEL, MIN_GROUP_N, MIN_RECOMMEND_LOWER,
  SINGLE_STACK_LABEL, POOR_COMPLETION_LABEL, DETECTED_DIFFERS_LABEL,
} from '../../../server/stack-recommendation';
import { OutcomeStore, OUTCOMES_FILE } from '../../../server/outcomes';
import { EngineId } from '../../../models/types';
import { startHarness, Harness, approvedProject, waitFor } from './app-harness';

const CONNECTED: EngineId[] = ['claude', 'codex'];

function tasks(engine: string, stack: string | undefined, completed: number, failed: number, extra: Partial<OutcomeLike> = {}): OutcomeLike[] {
  const out: OutcomeLike[] = [];
  for (let i = 0; i < completed; i++) { out.push({ kind: 'task', engine, stack, taskType: 'agent', status: 'completed', ...extra }); }
  for (let i = 0; i < failed; i++) { out.push({ kind: 'task', engine, stack, taskType: 'agent', status: 'failed', ...extra }); }
  return out;
}

const STATIC_KEYS = ['defaultKind', 'defaultLabel', 'excludedNoStack', 'label', 'minPerGroup', 'recordedTasks', 'source', 'stack'];

describe('stack recommendation (pure)', () => {
  it('wilsonInterval is [0,1] at n=0 and tight-but-honest at small n', () => {
    assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 1 });
    const w = wilsonInterval(10, 10);
    assert.ok(w.lower > 0.72 && w.lower < 0.73, String(w.lower));
    assert.ok(w.upper > 0.999999 && w.upper <= 1, String(w.upper));
    const half = wilsonInterval(25, 50);
    assert.ok(half.lower < 0.5 && half.upper > 0.5);
  });

  it('an empty data set gives source static-default with NO numeric rate fields', () => {
    const r = recommendStack([], CONNECTED, null);
    assert.equal(r.source, 'static-default');
    assert.deepEqual(Object.keys(r).sort(), STATIC_KEYS);
    const s = r as StaticRecommendation;
    assert.equal(s.label, INSUFFICIENT_LABEL);
    assert.equal(s.label, 'Insufficient data — static default');
    assert.equal(s.stack, 'node-ts');
    assert.equal(s.defaultKind, 'static');
    assert.equal(s.defaultLabel, STATIC_LABEL);
    assert.equal(s.recordedTasks, 0);
    assert.equal(s.excludedNoStack, 0);
    const json = JSON.stringify(r);
    assert.doesNotMatch(json, /rate|score|wilson|lower|upper|confidence|percent|accuracy/i);
  });

  it('records without a stack are excluded and counted, never guessed into a group', () => {
    const records = [
      ...tasks('claude', undefined, 40, 0),
      ...tasks('claude', 'cobol', 5, 0),
      ...tasks('claude', 'go', 3, 0),
    ];
    const r = recommendStack(records, CONNECTED, null, 7) as StaticRecommendation;
    assert.equal(r.source, 'static-default');
    assert.equal(r.excludedNoStack, 40 + 5 + 7);
    assert.equal(r.recordedTasks, 3);
    assert.equal(r.stack, 'node-ts', 'the 40 stackless tasks did not push any stack');
  });

  // A runner-up stack that is eligible but clearly worse, so the top stack is a real comparison.
  const weakRunnerUp = (): OutcomeLike[] => tasks('codex', 'java', 6, 6);

  it('n = 9 is insufficient; n = 10 with a comparison is low', () => {
    assert.equal(recommendStack(tasks('claude', 'go', 9, 0), CONNECTED, null).source, 'static-default');
    const r = recommendStack([...tasks('claude', 'go', 10, 0), ...weakRunnerUp()], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(r.source, 'measured');
    assert.equal(r.state, 'recommended');
    assert.equal(r.stack, 'go');
    assert.equal(r.stackSource, 'measured');
    assert.equal(r.confidence, 'low');
    assert.equal(r.basis.n, MIN_GROUP_N);
    assert.equal(r.basis.completed, 10);
    assert.equal(r.recordedTasks, 22);
  });

  it('n = 49 is still low', () => {
    const r = recommendStack([...tasks('claude', 'python', 49, 0), ...weakRunnerUp()], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(r.state, 'recommended');
    assert.equal(r.confidence, 'low');
  });

  it('n = 50: high only when the top lower bound clears the runner-up upper bound, else medium', () => {
    const high = recommendStack([...tasks('claude', 'node-ts', 50, 0), ...tasks('codex', 'python', 25, 25)], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(high.stack, 'node-ts');
    assert.equal(high.confidence, 'high');
    assert.equal(high.runnerUp!.stack, 'python');
    assert.ok(high.basis.wilsonLower > high.runnerUp!.wilsonUpper);

    const overlap = recommendStack([...tasks('claude', 'node-ts', 40, 10), ...tasks('codex', 'python', 38, 12)], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(overlap.stack, 'node-ts');
    assert.equal(overlap.confidence, 'medium');

    const alone = recommendStack(tasks('claude', 'go', 50, 0), CONNECTED, null) as MeasuredRecommendation;
    assert.equal(alone.state, 'single-stack', 'no runner-up stack to separate from');
    assert.equal(alone.confidence, null);
  });

  // ─── Honesty rules (B4) ───

  it('one stack measured alone is never medium/high and never headlined as a recommendation', () => {
    for (const n of [10, 50, 500]) {
      const r = recommendStack([...tasks('claude', 'go', n, 0), ...tasks('codex', 'go', n, 0)], CONNECTED, null) as MeasuredRecommendation;
      assert.equal(r.source, 'measured');
      assert.equal(r.state, 'single-stack', `n=${n}`);
      assert.equal(r.runnerUp, null);
      assert.equal(r.confidence, null);
      assert.equal(r.label, SINGLE_STACK_LABEL);
      assert.doesNotMatch(r.label, /recommend|confidence/i);
      assert.equal(r.stack, 'go', 'the only measured stack is still offered, labelled as measured');
      assert.equal(r.stackSource, 'measured');
    }
  });

  it('a detected stack stays primary; differing measurements are supporting evidence only', () => {
    const records = [...tasks('claude', 'python', 60, 0), ...weakRunnerUp()];
    const differs = recommendStack(records, CONNECTED, 'go') as MeasuredRecommendation;
    assert.equal(differs.state, 'detected-differs');
    assert.equal(differs.stack, 'go', 'detection wins the primary slot');
    assert.equal(differs.stackSource, 'detected');
    assert.equal(differs.detectedStack, 'go');
    assert.equal(differs.basis.stack, 'python', 'the measured best is still reported as evidence');
    assert.equal(differs.confidence, null);
    assert.equal(differs.label, DETECTED_DIFFERS_LABEL);

    const agrees = recommendStack(records, CONNECTED, 'python') as MeasuredRecommendation;
    assert.equal(agrees.state, 'recommended', 'measured data recommends only the detected stack');
    assert.equal(agrees.stack, 'python');
    assert.equal(agrees.stackSource, 'detected');
    assert.equal(agrees.confidence, 'high');

    const agreesAlone = recommendStack(tasks('claude', 'python', 60, 0), CONNECTED, 'python') as MeasuredRecommendation;
    assert.equal(agreesAlone.state, 'single-stack', 'agreeing with detection does not replace a comparison');
    assert.equal(agreesAlone.confidence, null);
  });

  it('a group with poor completion is never recommended', () => {
    const records = [...tasks('claude', 'go', 12, 18), ...tasks('codex', 'python', 5, 25)];
    const r = recommendStack(records, CONNECTED, null) as MeasuredRecommendation;
    assert.equal(r.source, 'measured');
    assert.ok(r.basis.wilsonLower < MIN_RECOMMEND_LOWER);
    assert.equal(r.state, 'poor-completion');
    assert.equal(r.confidence, null);
    assert.equal(r.label, POOR_COMPLETION_LABEL);
    assert.equal(r.stack, 'node-ts', 'the poor measured stack is not offered; the labelled static default is');
    assert.equal(r.stackSource, 'static');
    const detected = recommendStack(records, CONNECTED, 'go') as MeasuredRecommendation;
    assert.equal(detected.state, 'poor-completion');
    assert.equal(detected.stack, 'go');
    assert.equal(detected.stackSource, 'detected');

    // Lots of tasks do not rescue a 40% completion rate.
    const big = recommendStack([...tasks('claude', 'go', 400, 600), ...tasks('codex', 'python', 100, 900)], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(big.state, 'poor-completion');
  });

  it('every recommended answer has a runner-up and a basis lower bound of at least 0.5 (sweep)', () => {
    for (let a = 0; a <= 30; a += 3) {
      for (let b = 0; b <= 30; b += 5) {
        const r = recommendStack([...tasks('claude', 'go', a, 30 - a), ...tasks('codex', 'python', b, 30 - b)], CONNECTED, null);
        if (r.source !== 'measured' || r.state !== 'recommended') { continue; }
        assert.ok(r.runnerUp, `a=${a} b=${b}`);
        assert.ok(r.basis.wilsonLower >= MIN_RECOMMEND_LOWER, `a=${a} b=${b}`);
        assert.notEqual(r.confidence, null);
      }
    }
  });

  it('a stack scores by its best eligible engine; a sub-threshold group never counts', () => {
    const r = recommendStack([
      ...tasks('claude', 'go', 6, 6), // n=12, poor
      ...tasks('codex', 'go', 30, 0), // n=30, strong
      ...tasks('claude', 'python', 9, 0), // n=9, ineligible however good
    ], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(r.stack, 'go');
    assert.equal(r.basis.engine, 'codex');
    assert.equal(r.runnerUp, null);
    assert.ok(r.groups.every((g) => g.n >= MIN_GROUP_N));
  });

  it('disconnected engines are ignored', () => {
    const r = recommendStack(tasks('gemini', 'go', 80, 0), CONNECTED, null);
    assert.equal(r.source, 'static-default');
    assert.equal((r as StaticRecommendation).recordedTasks, 0);
    const m = recommendStack([...tasks('gemini', 'go', 80, 0), ...tasks('claude', 'python', 10, 0)], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(m.stack, 'python');
    assert.ok(m.groups.every((g) => g.engine !== 'gemini'));
  });

  it('skipped tasks, non-agent tasks and malformed records are not evidence', () => {
    const r = recommendStack([
      ...tasks('claude', 'go', 20, 0, { status: 'skipped' }),
      ...tasks('claude', 'go', 20, 0, { taskType: 'check' }),
      null as unknown as OutcomeLike, 42 as unknown as OutcomeLike, { kind: 'task' },
    ], CONNECTED, null);
    assert.equal(r.source, 'static-default');
  });

  it('blocked tasks count against the group', () => {
    const r = recommendStack([...tasks('claude', 'go', 10, 0), ...tasks('claude', 'go', 0, 5, { status: 'blocked' })], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(r.basis.n, 15);
    assert.equal(r.basis.completed, 10);
  });

  it('gate pass rate is a separate figure, shown only from 10 gate runs, never blended into the score', () => {
    const base = tasks('claude', 'go', 12, 0);
    const gates = (n: number, green: number): OutcomeLike[] =>
      Array.from({ length: n }, (_, i) => ({ kind: 'gate', engine: 'claude', stack: 'go', gateRun: true, allGreen: i < green }));
    const few = recommendStack([...base, ...gates(9, 0)], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(few.basis.gateRuns, 9);
    assert.equal('gatePassRate' in few.basis, false);
    const many = recommendStack([...base, ...gates(10, 4)], CONNECTED, null) as MeasuredRecommendation;
    assert.equal(many.basis.gatePassRate, 0.4);
    assert.equal(many.basis.wilsonLower, few.basis.wilsonLower, 'gate results do not move the score');
  });

  it('repo markers give the "detected" label', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-stack-'));
    try {
      const at = (files: string[]): string => {
        const d = fs.mkdtempSync(path.join(dir, 'r-'));
        for (const f of files) { fs.writeFileSync(path.join(d, f), ''); }
        return d;
      };
      assert.equal(detectStackFromRepo(at(['go.mod', 'README.md'])), 'go');
      assert.equal(detectStackFromRepo(at(['package.json'])), 'node-ts');
      assert.equal(detectStackFromRepo(at(['tsconfig.json', 'go.mod'])), 'node-ts');
      assert.equal(detectStackFromRepo(at(['pyproject.toml'])), 'python');
      assert.equal(detectStackFromRepo(at(['requirements.txt'])), 'python');
      assert.equal(detectStackFromRepo(at(['pom.xml'])), 'java');
      assert.equal(detectStackFromRepo(at(['build.gradle.kts'])), 'java');
      assert.equal(detectStackFromRepo(at(['App.csproj'])), 'dotnet');
      assert.equal(detectStackFromRepo(at(['App.sln'])), 'dotnet');
      assert.equal(detectStackFromRepo(at(['index.html', 'style.css'])), 'static-web');
      assert.equal(detectStackFromRepo(at(['README.md'])), null);
      assert.equal(detectStackFromRepo(path.join(dir, 'missing')), null);

      const r = recommendStack([], CONNECTED, detectStackFromRepo(at(['go.mod']))) as StaticRecommendation;
      assert.equal(r.source, 'static-default');
      assert.equal(r.stack, 'go');
      assert.equal(r.defaultKind, 'detected');
      assert.equal(r.defaultLabel, DETECTED_LABEL);
      assert.deepEqual(Object.keys(r).sort(), STATIC_KEYS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('outcome store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-outcomes-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads nothing from an empty data dir', () => {
    assert.deepEqual(new OutcomeStore(dir).readAll(), { records: [], malformed: 0 });
  });

  it('appends JSONL and skips malformed lines on read', () => {
    const s = new OutcomeStore(dir);
    s.append({ kind: 'task', ts: 't', projectId: 'p', runId: 'r', stack: 'go', engine: 'claude', taskType: 'agent', status: 'completed' });
    fs.appendFileSync(path.join(dir, OUTCOMES_FILE), '{torn line\n[1,2]\n"str"\n');
    s.append({ kind: 'gate', ts: 't', projectId: 'p', runId: 'r', stack: 'go', engine: 'claude', gateRun: true, allGreen: false });
    const read = s.readAll();
    assert.equal(read.records.length, 2);
    assert.equal(read.malformed, 3);
  });

  it('caches by mtime/size and re-reads after an append', () => {
    const s = new OutcomeStore(dir);
    s.append({ kind: 'task', ts: 't', projectId: 'p', runId: 'r', stack: 'go', engine: 'claude', taskType: 'agent', status: 'completed' });
    const a = s.readAll();
    assert.equal(s.readAll(), a, 'unchanged file: same cached object');
    s.append({ kind: 'task', ts: 't', projectId: 'p', runId: 'r', stack: 'go', engine: 'claude', taskType: 'agent', status: 'failed' });
    assert.equal(s.readAll().records.length, 2);
  });

  it('append never throws (unwritable path is logged)', () => {
    const logs: string[] = [];
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const s = new OutcomeStore(path.join(blocker, 'sub'), (m) => logs.push(m));
    assert.doesNotThrow(() => s.append({ kind: 'task', ts: 't', projectId: 'p', runId: 'r', stack: 'go', engine: 'claude', taskType: 'agent', status: 'completed' }));
    assert.equal(logs.length, 1);
  });
});

describe('outcome stamping from server runs', function () {
  this.timeout(20000);
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  const read = (): Array<Record<string, unknown>> => {
    const f = path.join(h.dataDir, OUTCOMES_FILE);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it('stamps terminal tasks with the stack frozen at run start and the reported engine', async () => {
    const { projectId, planId } = await approvedProject(h);
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const runId = (r.body.run as { id: string }).id;
    // The stack changes mid-run: evidence keeps the stack the run started with.
    const p = await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { stack: 'python' } });
    assert.equal(p.status, 200, p.raw);
    const w = h.workers.at(-1)!;
    w.line({ event: 'task-engine', id: 't-impl', engine: 'codex' });
    w.line({ event: 'task-completed', id: 't-impl', name: 'Implement checkout', status: 'completed', engineRan: true });
    w.line({ event: 'task-failed', id: 't-rel', name: 'Release v1.0.0', status: 'failed', engineRan: true });
    // Gate evidence the PRD loop wrote to the snapshot during this segment.
    const snapPath = (w.job as { planPath: string }).planPath;
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    const at = new Date(Date.now() + 1000).toISOString();
    snap.requirementTrace = [
      { id: 'R-1', taskIds: ['t-impl'], commits: [], releases: [], gates: [{ command: 'npm test', exitCode: 0, timedOut: false, at }, { command: 'npm run lint', exitCode: 1, timedOut: false, at }] },
      { id: 'R-2', taskIds: ['t-impl'], commits: [], releases: [], gates: [{ command: 'npm test', exitCode: 0, timedOut: false, at }, { command: 'npm run lint', exitCode: 1, timedOut: false, at }] },
      { id: 'R-9', taskIds: [], commits: [], releases: [], gates: [{ command: 'old', exitCode: 0, timedOut: false, at: '2000-01-01T00:00:00.000Z' }] },
    ];
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    w.exit(1);
    await waitFor(() => h.state.load(projectId).runs[0].status === 'gaps');
    await waitFor(() => read().some((x) => x.kind === 'gate'));
    const recs = read();
    const taskRecs = recs.filter((x) => x.kind === 'task');
    assert.equal(taskRecs.length, 2);
    const impl = taskRecs.find((x) => x.status === 'completed')!;
    assert.deepEqual(
      { projectId: impl.projectId, runId: impl.runId, stack: impl.stack, engine: impl.engine, taskType: impl.taskType },
      { projectId, runId, stack: 'node-ts', engine: 'codex', taskType: 'agent' },
    );
    const rel = taskRecs.find((x) => x.status === 'failed')!;
    assert.equal(rel.taskType, 'release');
    assert.equal(rel.engine, 'claude', 'no task-engine event: statically resolved engine (the project engine)');
    const gateRecs = recs.filter((x) => x.kind === 'gate');
    assert.equal(gateRecs.length, 1, 'one gate run (deduped across requirements); the stale one is ignored');
    assert.equal(gateRecs[0].allGreen, false);
    assert.equal(gateRecs[0].stack, 'node-ts');
  });

  it('plan generation and engine probes record no outcomes', async () => {
    await approvedProject(h);
    h.onSpawn = (w) => {
      if (w.job.kind === 'probe') { w.line({ event: 'task-completed', id: 'x', name: 'x' }); w.exit(0); }
    };
    h.app.probeEngines();
    await waitFor(() => h.app.engines.snapshot().checkedAt !== null);
    assert.deepEqual(read(), []);
  });
});
