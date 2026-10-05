import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBench, BenchDeps, EventLog, planApprovalProblems } from '../../../bench/harness';
import { Scenario, ScenarioVersion } from '../../../bench/scenario';
import { CommandResult } from '../../../bench/workspace';
import { FakeEngine } from '../../../bench/fake-engine';
import { LaunchedServer } from '../../../bench/server-launcher';
import { startHarness, Harness, FakeWorker } from '../server/app-harness';
import { loadPlan, dehydratePlan } from '../../../models/plan';
import { recordGateResults } from '../../../models/requirement-trace';
import { TaskStatus } from '../../../models/types';

const BOOT = 'bench-harness-bootstrap-token-0123456789';
const PRDS = [
  '# Todo\n\n## Requirements\n- [R-1] add a todo\n- [R-2] list todos\n',
  '# Todo\n\n## Requirements\n- [R-1] add a todo\n- [R-2] list todos in ascending id order\n',
  '# Todo\n\n## Requirements\n- [R-1] add a todo\n- [R-2] list todos in ascending id order\n- [R-3] due dates\n',
];

type Cost = { usd: number; source?: string };

interface Script {
  /** Per plan job (in order): the outcome kind; 'appended' builds a playlist from the PRD scope. */
  plans: Array<'appended' | 'parse-failed'>;
  /** Per run (in order): cost events emitted in segment 1. */
  costs: Cost[][];
  /** Edits the generated playlist of plan job `n` (1-based) before it is written. */
  patch?: (playlist: Record<string, unknown>, tasks: Array<Record<string, unknown>>, n: number) => void;
}

/** Scripted workers: plan jobs write an outcome, run segment 1 halts at the ship gate, segment 2 ships. */
function scriptWorkers(h: Harness, script: Script, seen: { plans: number; runs: number }): void {
  h.onSpawn = (w: FakeWorker) => {
    if (w.job.kind === 'plan') {
      const kind = script.plans[seen.plans++] ?? 'appended';
      const plan = loadPlan(w.job.planPath);
      const latest = plan.prdVersions![plan.prdVersions!.length - 1];
      const prev = plan.prdVersions!.length > 1 ? plan.prdVersions![plan.prdVersions!.length - 2].text : '';
      const ids = [...latest.text.matchAll(/\[(R-\d+)\] ([^\n]*)/g)]
        .filter((m) => !prev.includes(`[${m[1]}] ${m[2]}`)).map((m) => m[1]);
      fs.mkdirSync(path.dirname(w.job.outPath), { recursive: true });
      const tasks: Array<Record<string, unknown>> = ids.map((id) => ({ id: `t${seen.plans}-${id}`, name: `Do ${id}`, prompt: id, requirementIds: [id] }));
      const playlist: Record<string, unknown> = { id: `pl-${seen.plans}`, name: `delta ${seen.plans}`, autoplay: true, tasks };
      script.patch?.(playlist, tasks, seen.plans);
      const outcome = kind === 'appended'
        ? { kind, playlist, rejected: [] }
        : { kind, error: 'AI returned invalid JSON.' };
      fs.writeFileSync(w.job.outPath, JSON.stringify(outcome));
      w.line({ event: 'cost', usd: 0, source: 'reported' });
      w.line({ event: 'plan-outcome', kind });
      w.exit(0);
      return;
    }
    if (w.job.kind !== 'run') { return; }
    const job = w.job;
    const snap = loadPlan(job.planPath);
    const pl = snap.playlists[job.startPlaylistIndex];
    const gate = pl.tasks.find((t) => t.type === 'manual' && t.name === 'Ship approval')!;
    if (gate.status !== TaskStatus.Completed) {
      const costs = script.costs[seen.runs++] ?? [];
      for (const t of pl.tasks) {
        if (t === gate) { continue; }
        w.line({ event: 'task-started', id: t.id, name: t.name });
        t.status = TaskStatus.Completed;
        w.line({ event: 'task-completed', id: t.id, name: t.name, status: 'completed', engineRan: true });
      }
      for (const c of costs) { w.line({ event: 'cost', ...c }); }
      fs.writeFileSync(job.planPath, JSON.stringify(dehydratePlan(snap), null, 2));
      w.line({ event: 'manual-gate', id: gate.id, name: gate.name });
      w.exit(3);
      return;
    }
    for (const t of pl.tasks) { t.status = TaskStatus.Completed; }
    recordGateResults(snap, [{ command: 'npm test', exitCode: 0, timedOut: false }], new Date().toISOString());
    fs.writeFileSync(job.planPath, JSON.stringify(dehydratePlan(snap), null, 2));
    w.line({ event: 'verify-finished', passed: true, score: 100, failedGate: null, iterations: 1 });
    w.exit(0);
  };
}

describe('bench harness (scripted workers behind the real app)', function () {
  this.timeout(60000);
  let tmp: string;
  let h: Harness;
  let liveLockPid: number | null;
  let launches: number;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-bh-')));
    liveLockPid = null;
    launches = 0;
    h = await startHarness({ accounts: {}, config: { bootstrapToken: BOOT }, engineAvailable: () => true, isPidAlive: (pid) => pid === liveLockPid });
    PRDS.forEach((t, i) => fs.writeFileSync(path.join(tmp, `v${i + 1}.md`), t));
    fs.mkdirSync(path.join(tmp, 'fx'), { recursive: true });
  });
  afterEach(async () => { await h.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  function scenario(over: Partial<Scenario> = {}, n = 3, bumps: ScenarioVersion['intendedBump'][] = ['initial', 'patch', 'minor']): Scenario {
    return {
      file: path.join(tmp, 'scenario.json'), dir: tmp, name: 'bench-test', description: '', repo: { kind: 'template', templateDir: tmp },
      setupCommands: [], stack: 'node-ts', engine: 'claude', budgetUsd: 10, perCallCapUsd: 1, minVersionUsd: 1, reserveFactor: 1.5,
      versionTimeoutMin: 5, passEnv: [], gateCommands: ['npm test'], gateTimeoutMs: 10_000,
      versions: Array.from({ length: n }, (_, i) => ({ id: `v${i + 1}`, prdFile: path.join(tmp, `v${i + 1}.md`), intendedBump: bumps[i], dryRunFixture: path.join(tmp, 'fx') })),
      dryRun: { planCommand: 'npm test' },
      ...over,
    };
  }

  function deps(over: Partial<BenchDeps> & { green?: () => boolean; onGates?: () => void } = {}): Partial<BenchDeps> {
    const server: LaunchedServer = { url: h.url, projectsRoot: h.root, bootstrapToken: BOOT, serverEnv: { ...process.env }, stop: async () => undefined };
    return {
      launchServer: async () => { launches++; return server; },
      prepareWorkspace: async () => ({ dir: path.join(h.root, 'acme'), name: 'acme', kind: 'template', head: null, setup: [] }),
      runGates: async (commands): Promise<CommandResult[]> => {
        over.onGates?.();
        const ok = over.green ? over.green() : true;
        return commands.map((command) => ({ command, exitCode: ok ? 0 : 1, timedOut: false, durationMs: 5, tail: ok ? 'ok' : 'FAIL' }));
      },
      checkEngine: async () => ({ available: true, probeVersion: null, shellVersion: '2.1.287 (Claude Code)' }),
      installFakeEngine: (binDir: string): FakeEngine => {
        fs.mkdirSync(binDir, { recursive: true });
        const callsPath = path.join(binDir, 'calls.jsonl');
        fs.writeFileSync(callsPath, JSON.stringify({ mode: 'plan' }) + '\n');
        return { binDir, statePath: path.join(binDir, 'fake-state.json'), callsPath, setVersion: () => undefined };
      },
      pollMs: 10,
      lockRetryMs: 20,
      lockRetryMaxMs: 5_000,
      ...over,
    };
  }

  const out = (name = 'out') => path.join(tmp, name);
  const quiet = { progress: () => undefined };

  it('three versions ship end to end: required approvals per version, the v2 bump mismatch is an unplanned override', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.5, source: 'reported' }], [{ usd: 0.25, source: 'reported' }], [{ usd: 0.25, source: 'reported' }]] }, seen);
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 0, JSON.stringify(r.summary?.harnessError));
    const s = r.summary!;
    assert.deepEqual(s.versions.map((v) => v.outcome), ['shipped', 'shipped', 'shipped']);
    for (const v of s.versions) {
      assert.deepEqual(v.interventions.required.map((i) => i.kind), ['plan-approval', 'ship-approval'], v.id);
      assert.equal(typeof v.wallClockMs, 'number');
      assert.equal(v.fixIterations, 1);
    }
    assert.deepEqual(s.versions[0].requirementIds, ['R-1', 'R-2']);
    assert.deepEqual(s.versions[1].requirementIds, ['R-2']);
    assert.deepEqual(s.versions[2].requirementIds, ['R-3']);
    assert.equal(s.versions[1].recommendedBump, 'minor');
    assert.equal(s.versions[1].bumpMatch, false);
    assert.equal(s.versions[1].bumpOverridden, true);
    assert.deepEqual(s.versions[1].interventions.unplanned.map((i) => i.kind), ['bump-override']);
    assert.equal(s.versions[2].bumpMatch, true);
    assert.equal(s.versions[0].costUsd, 0.5);
    assert.equal(s.versions[0].tasksGenerated, 2);
    assert.equal(s.versions[0].tasksCompleted, 2);
    assert.deepEqual(s.versions[0].trace, { 'R-1': 'shipped', 'R-2': 'shipped' });
    assert.equal(s.budget.upperBoundUsd, 1);
    assert.ok(fs.existsSync(r.summaryPath!));
    const events = fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8');
    assert.ok(events.includes('"kind":"sse"'));
    for (const line of events.trim().split('\n')) { assert.doesNotThrow(() => JSON.parse(line)); }
    // The server's audit names a different user for each role.
    const actors = new Set(h.auditEntries().filter((e) => ['plan.approve', 'gate.approve', 'prd.version-save'].includes(e.action)).map((e) => `${e.action}:${e.actorUsername}`));
    assert.ok(actors.has('plan.approve:bench-reviewer') && actors.has('gate.approve:bench-approver') && actors.has('prd.version-save:bench-po'), [...actors].join(','));
  });

  it('source:none cost events make the version cost unknown and move the upper bound by the per-call cap', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.5, source: 'reported' }, { usd: 0, source: 'none' }]] }, seen);
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    const v = r.summary!.versions[0];
    assert.equal(v.costUsd, 'unknown');
    assert.equal(v.reportedUsd, 0.5);
    assert.equal(v.unreportedCalls, 1);
    assert.equal(r.summary!.budget.upperBoundUsd, 1.5);
    assert.equal(r.summary!.totals.costUsd, 'unknown');
  });

  it('a budget too small for v3 marks v3 alone not run (budget)', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.5, source: 'reported' }], [{ usd: 7.5, source: 'reported' }]] }, seen);
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.summary!.versions.map((v) => v.outcome), ['shipped', 'shipped', 'not run (budget)']);
    assert.equal(seen.runs, 2, 'v3 never ran');
    assert.equal(r.summary!.stoppedForBudget, false);
  });

  it('the watchdog stops a run that could cross the cap, and later versions are not run (exit 4)', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 9.5, source: 'reported' }]] }, seen);
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 4);
    assert.equal(r.summary!.stoppedForBudget, true);
    assert.ok(r.summary!.versions[0].interventions.unplanned.some((i) => i.kind === 'budget-halt'));
    assert.deepEqual(r.summary!.versions.slice(1).map((v) => v.outcome), ['not run (budget)', 'not run (budget)']);
  });

  it('a parse-failed plan is plan-failed with an unplanned intervention, and the next version still runs', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: ['parse-failed', 'appended'], costs: [[{ usd: 0.1, source: 'reported' }]] }, seen);
    const r = await runBench(scenario({}, 2), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    const [v1, v2] = r.summary!.versions;
    assert.equal(v1.outcome, 'plan-failed');
    assert.equal(v1.endState, 'plan-parse-failed');
    assert.ok(v1.interventions.unplanned.some((i) => i.kind === 'plan-parse-failed'));
    assert.equal(v1.interventions.required.length, 0);
    assert.equal(seen.plans, 2, 'v2 still requested a plan');
    assert.notEqual(v2.outcome, 'plan-failed');
  });

  it('red acceptance gates reject the ship gate: unplanned gate-rejected, nothing shipped', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({ green: () => false }));
    const v = r.summary!.versions[0];
    assert.equal(v.outcome, 'not-shipped');
    assert.equal(v.endState, 'run-ship-rejected');
    assert.equal(v.gateFirstRunPass?.pass, false);
    assert.deepEqual(v.gateFirstRunPass?.results.map((x) => x.exitCode), [1]);
    assert.ok(v.interventions.unplanned.some((i) => i.kind === 'gate-rejected'));
    assert.deepEqual(v.interventions.required.map((i) => i.kind), ['plan-approval', 'ship-approval']);
  });

  it('a 409 project-locked on gate approve is retried (recorded as lock-wait), never force-released', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    let armed = false;
    const onGates = (): void => {
      if (armed) { return; }
      armed = true;
      // A task process from the halted segment is still alive: the lock is held.
      liveLockPid = 31337;
      const lockPath = h.app.jobs.lockPath(h.projects.list()[0].id);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ serverPid: process.pid, workerPid: 999991, taskPids: [31337] }));
      setTimeout(() => { liveLockPid = null; }, 150);
    };
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({ onGates }));
    const v = r.summary!.versions[0];
    assert.equal(v.outcome, 'shipped', JSON.stringify(v));
    assert.ok(v.interventions.unplanned.some((i) => i.kind === 'lock-wait'), JSON.stringify(v.interventions));
    assert.equal(h.auditEntries().some((e) => e.action === 'job.lock-force-release'), false, 'the bench never force-releases');
  });

  /** Run one version whose generated playlist `patch` edits; returns the version summary and the server's plan record. */
  async function oneVersionWith(patch: NonNullable<Script['patch']>) {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.1, source: 'reported' }]], patch }, seen);
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    const serverPlan = h.state.load(h.projects.list()[0].id).plans[0];
    return { r, v: r.summary!.versions[0], seen, serverPlan };
  }

  const rejectedDetail = (v: { interventions: { unplanned: Array<{ kind: string; detail?: string }> } }): string =>
    v.interventions.unplanned.find((i) => i.kind === 'plan-rejected')?.detail ?? '';

  it('a parallel playlist is never auto-approved: rejected through the reviewer, unplanned plan-rejected, nothing runs', async () => {
    const { v, seen, serverPlan } = await oneVersionWith((pl) => { pl.parallel = true; });
    assert.equal(v.outcome, 'plan-failed');
    assert.equal(v.endState, 'plan-rejected');
    assert.match(rejectedDetail(v), /parallel/);
    assert.deepEqual(v.interventions.required, [], 'no plan-approval is recorded for a plan nobody approved');
    assert.equal(seen.runs, 0, 'no run segment was spawned');
    assert.equal(serverPlan.status, 'rejected');
    assert.equal(h.auditEntries().some((e) => e.action === 'plan.approve'), false);
    assert.ok(h.auditEntries().some((e) => e.action === 'plan.reject' && e.actorUsername === 'bench-reviewer'));
  });

  it('a push command outside the scenario gates is never auto-approved; the refusal names it', async () => {
    const { v, seen, serverPlan } = await oneVersionWith((_pl, tasks) => {
      tasks.push({ id: 'push', name: 'Publish branch', type: 'command', command: 'git push origin HEAD:refs/heads/x', prompt: 'push' });
    });
    assert.equal(v.endState, 'plan-rejected');
    assert.match(rejectedDetail(v), /git push origin HEAD:refs\/heads\/x/);
    assert.deepEqual(v.interventions.required, []);
    assert.equal(seen.runs, 0);
    assert.equal(serverPlan.status, 'rejected');
  });

  it('a release or deploy task is never auto-approved', async () => {
    const { v, seen } = await oneVersionWith((_pl, tasks) => {
      tasks.push({ id: 'rel', name: 'Cut release', type: 'release', prompt: 'release' });
    });
    assert.equal(v.endState, 'plan-rejected');
    assert.match(rejectedDetail(v), /Cut release" is a release task/);
    assert.equal(seen.runs, 0);
  });

  it('a command task that is exactly a scenario gate command is still approved and ships', async () => {
    const { v, seen } = await oneVersionWith((_pl, tasks) => {
      tasks.push({ id: 'tests', name: 'Run tests', type: 'command', command: 'npm test', prompt: 'tests' });
    });
    assert.equal(v.outcome, 'shipped', JSON.stringify(v.interventions));
    assert.deepEqual(v.interventions.required.map((i) => i.kind), ['plan-approval', 'ship-approval']);
    assert.equal(seen.runs, 1);
  });

  it('planApprovalProblems: a missing or flagged review, non-command fields and unknown commands are refusals', () => {
    assert.deepEqual(planApprovalProblems({ playlist: { tasks: [] }, review: { ok: true, commands: [] } }, ['npm test']), []);
    assert.equal(planApprovalProblems({ playlist: { tasks: [] } }, []).length, 1, 'no review');
    assert.deepEqual(planApprovalProblems({ review: { ok: false, errors: ['bad engine'] } }, []), ['bad engine']);
    assert.deepEqual(planApprovalProblems({ review: { ok: true, commands: [{ taskName: 'T', field: 'verifyCommand', value: ' npm test ' }] } }, ['npm test']), []);
    assert.equal(planApprovalProblems({ review: { ok: true, commands: [{ taskName: 'T', field: 'cwd', value: 'npm test' }] } }, ['npm test']).length, 1,
      'a cwd or side-effect field is never covered by the allow-list');
    assert.equal(planApprovalProblems({ review: { ok: true, commands: [{ taskName: 'T', field: 'command', value: 'npm publish' }] } }, ['npm test']).length, 1);
    assert.equal(planApprovalProblems({ playlist: { parallel: true, tasks: [{ name: 'D', type: 'deploy' }] }, review: { ok: true } }, []).length, 2);
  });

  it('a paid run without --max-usd exits 2 before any server start', async () => {
    const r = await runBench(scenario(), { dryRun: false, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 2);
    assert.equal(launches, 0);
    assert.equal(fs.existsSync(out()), false, 'nothing was created');
  });

  it('a dry-run whose engine is not the fake aborts before any plan request', async () => {
    const r = await runBench(scenario(), { dryRun: true, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /dry-run refused/);
    assert.deepEqual(r.summary!.versions.map((v) => [v.outcome, v.endState]), [['error', 'harness-error'], ['error', 'harness-error'], ['error', 'harness-error']],
      'versions the harness never reached are errors, not product outcomes');
    assert.equal(h.workers.length, 0, 'no worker was spawned');
    assert.equal(h.auditEntries().some((e) => e.action === 'plan.generate'), false);
  });

  it('a paid run that sees the fake marker aborts before any plan request', async () => {
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 5, outDir: out(), ...quiet },
      deps({ checkEngine: async () => ({ available: true, probeVersion: null, shellVersion: '0.0.0-moag-bench-fake (Claude Code)' }) }));
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /bench fake/);
    assert.equal(h.workers.length, 0);
  });

  it('a dry-run with the fake engine completes and records the fake call count', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0, source: 'reported' }]] }, seen);
    const r = await runBench(scenario({}, 1), { dryRun: true, outDir: out(), ...quiet },
      deps({ checkEngine: async () => ({ available: true, probeVersion: null, shellVersion: '0.0.0-moag-bench-fake (Claude Code)' }) }));
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.equal(r.summary!.mode, 'dry-run');
    assert.ok(r.summary!.notes.some((n) => /fake engine calls: 1/.test(n)));
  });

  it('a failing workspace setup is a harness error (exit 2), and the server is still stopped', async () => {
    let stopped = 0;
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({
      launchServer: async () => ({ url: h.url, projectsRoot: h.root, bootstrapToken: BOOT, serverEnv: {}, stop: async () => { stopped++; } }),
      prepareWorkspace: async () => { throw new Error('setup command "npm ci" exited 1'); },
    }));
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /npm ci/);
    assert.equal(stopped, 1);
    assert.ok(r.summary!.versions.every((v) => v.outcome === 'error' && v.endState === 'harness-error'));
    assert.ok(fs.existsSync(path.join(out(), 'summary.json')));
  });

  it('refuses a non-empty --out without starting anything', async () => {
    fs.mkdirSync(out(), { recursive: true });
    fs.writeFileSync(path.join(out(), 'x'), '');
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 1, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 2);
    assert.equal(launches, 0);
  });

  it('EventLog drops lines past its cap and says so', () => {
    const f = path.join(tmp, 'log.jsonl');
    const l = new EventLog(f, 200);
    for (let i = 0; i < 10; i++) { l.write({ kind: 'x', i }); }
    assert.equal(l.truncated, true);
    assert.ok(l.dropped > 0);
    assert.ok(fs.statSync(f).size <= 200);
  });
});
