import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runBench, BenchDeps, EventLog, terminationSignals, planApprovalProblems, scenarioAllowedCommands, standardsApprovalProblems, benchStandardsProfile,
} from '../../../bench/harness';
import { profileHash } from '../../../standards/profile';
import { builtInProfile } from '../../../standards/built-in-profiles';
import { readStandardsJobFile } from '../../../standards/local-store';
import { sampleProfile } from '../standards/fixtures';
import { Scenario, ScenarioVersion } from '../../../bench/scenario';
import { CommandResult } from '../../../bench/workspace';
import { FakeEngine } from '../../../bench/fake-engine';
import { LaunchOptions, LaunchedServer } from '../../../bench/server-launcher';
import { startHarness, Harness, FakeWorker, attestStandards } from '../server/app-harness';
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
  /** When set, MOAG's own verify (segment 2) runs `npm run lint`, then stops at this gate command: the run ends with gaps. */
  verifyFailsAt?: string;
  /** With `verifyFailsAt`: the repo gates all pass and verify ends on the standards gate instead. */
  verifyFailsOnStandards?: boolean;
  /** When set, segment 1 sends a pre-gate standards report with these rule rows before it halts at the ship gate. */
  preGateRules?: Array<Record<string, unknown>>;
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
      if (script.preGateRules && job.standardsPath) {
        // What a real worker's check at the ship gate sends: made with the job file's own profile and base.
        const file = readStandardsJobFile(job.standardsPath);
        w.line({
          event: 'verify-standards', phase: 'pre-gate', version: file.version, baseRef: file.baseRef,
          rules: script.preGateRules, findings: [], contentHash: file.contentHash, recordedBaseRef: file.baseRef,
        });
      }
      w.line({ event: 'manual-gate', id: gate.id, name: gate.name });
      w.exit(3);
      return;
    }
    for (const t of pl.tasks) { t.status = TaskStatus.Completed; }
    if (script.verifyFailsAt) {
      fs.writeFileSync(job.planPath, JSON.stringify(dehydratePlan(snap), null, 2));
      w.line({ event: 'verify-started', plan: 'p', fix: false });
      w.line({ event: 'verify-progress', phase: 'gate', detail: 'npm run lint' });
      w.line({ event: 'verify-progress', phase: 'gate', detail: script.verifyFailsAt });
      if (script.verifyFailsOnStandards) {
        // What the real loop announces: the static check, then a profile command that fails.
        w.line({ event: 'verify-progress', phase: 'standards', detail: 'Checking the diff against moag:standards v1' });
        w.line({ event: 'verify-progress', phase: 'standards-command', detail: 'npm run format:check' });
        w.line({ event: 'verify-finished', passed: false, score: 0, failedGate: 'standards', iterations: 1 });
        w.exit(1);
        return;
      }
      w.line({ event: 'verify-finished', passed: false, score: 0, failedGate: 'command', iterations: 1 });
      w.exit(1);
      return;
    }
    recordGateResults(snap, [{ command: 'npm test', exitCode: 0, timedOut: false }], new Date().toISOString());
    fs.writeFileSync(job.planPath, JSON.stringify(dehydratePlan(snap), null, 2));
    attestStandards(w);
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
      versionTimeoutMin: 5, passEnv: [], gateCommands: ['npm test'], gateTimeoutMs: 10_000, allowedCommands: [], environmentProbes: [],
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
      // Never the real installer in a unit test: nothing may reach a registry.
      ensureDependencies: async () => ({ ok: true, aborted: false, events: [] }),
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
    assert.deepEqual(s.environment, { node: null, probes: [] }, 'a scenario without probes runs none');
    assert.deepEqual(s.versions.map((v) => v.environment), [[], [], []]);
    assert.deepEqual(s.versions[0].moagVerify, { passed: true, failedGate: null, failedCommand: null });
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

  it('dependencies are installed before the acceptance gates, and the install is logged as bench-deps', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    const order: string[] = [];
    const installed = {
      event: 'dependencies-installed' as const, stage: 'bench' as const, ecosystem: 'npm' as const, dir: '.', trigger: 'install-dir-missing' as const,
      command: 'npm install --no-audit --no-fund', durationMs: 7, exitCode: 0, timedOut: false, tail: 'added 1 package', note: null,
    };
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({
      ensureDependencies: async (cwd, _env, timeoutMs, signal) => {
        order.push(`install:${path.basename(cwd)}:${timeoutMs}:${signal.aborted}`);
        return { ok: true, aborted: false, events: [installed] };
      },
      onGates: () => { order.push('gates'); },
    }));
    assert.equal(r.summary!.versions[0].outcome, 'shipped');
    assert.deepEqual(order.slice(0, 2), ['install:acme:10000:false', 'gates']);
    const logged = fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((e) => e.kind === 'bench-deps');
    assert.equal(logged.length >= 1, true);
    assert.deepEqual([logged[0].version, logged[0].ok, logged[0].events[0].command], ['v1', true, 'npm install --no-audit --no-fund']);
  });

  it('a failed install makes the acceptance gates red even when the gate commands pass', async () => {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    const failed = {
      event: 'dependencies-install-failed' as const, stage: 'bench' as const, ecosystem: 'npm' as const, dir: '.', trigger: 'install-dir-missing' as const,
      command: 'npm install --no-audit --no-fund', durationMs: 7, exitCode: 1, timedOut: false, tail: 'npm ERR! ENOTCACHED', note: null,
    };
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({
      ensureDependencies: async () => ({ ok: false, aborted: false, events: [failed] }),
    }));
    const v = r.summary!.versions[0];
    assert.equal(v.outcome, 'not-shipped');
    assert.equal(v.gateFirstRunPass?.pass, false);
    assert.deepEqual(v.gateFirstRunPass?.results.map((x) => [x.command, x.exitCode]),
      [['npm install --no-audit --no-fund', 1], ['npm test', 0]]);
    const rejected = v.interventions.unplanned.find((i) => i.kind === 'gate-rejected');
    assert.ok(rejected && /npm install --no-audit --no-fund → exit 1/.test(rejected.detail ?? ''), JSON.stringify(v.interventions.unplanned));
    const events = fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8');
    assert.ok(events.includes('"kind":"bench-deps"'));
  });

  it('a ship the server refuses over the pre-gate standards check is rejected by the bench approver: nothing shipped, and it says why', async () => {
    await manualStandards();
    const seen = { plans: 0, runs: 0 };
    // The acceptance gates are green; the profile's own command failed at the gate.
    scriptWorkers(h, { plans: [], costs: [], preGateRules: [{ rule: 'command', result: 'failed', command: 'npm test', exitCode: 1, tail: '1 failing' }] }, seen);
    const profile = { ...sampleProfile(), commands: [{ label: 'Test', run: 'npm test' }] };
    const r = await runBench(scenario({ standardsProfile: { file: path.join(tmp, 'standards.json'), profile } }, 1),
      { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    const v = r.summary!.versions[0];
    assert.equal(v.outcome, 'not-shipped');
    assert.equal(v.endState, 'run-ship-rejected');
    assert.equal(v.gateFirstRunPass?.pass, true, 'the bench acceptance gates were green: it is the product that refused');
    assert.deepEqual(v.interventions.required.map((i) => i.kind), ['plan-approval', 'ship-approval']);
    assert.deepEqual(v.interventions.unplanned.map((i) => i.kind), ['ship-refused-standards']);
    assert.match(v.interventions.unplanned[0].detail ?? '', /standards check before the ship gate stops this release/);
    const audit = h.auditEntries().map((e) => e.action);
    assert.equal(audit.includes('gate.approve'), false, 'the approval never went through');
    assert.equal(audit.filter((a) => a === 'gate.reject').length, 1);
    assert.equal(seen.runs, 1, 'no second segment was spawned');
    assert.ok(fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8').includes('"kind":"ship-refused-standards"'));
    assert.ok(Object.values(v.trace).every((status) => status !== 'shipped'), JSON.stringify(v.trace));
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
    };
    // No timer decides when the lock is released: the task process "exits" inside the bench's
    // own second lock-retry wait. The sequence is therefore fixed whatever the machine's speed:
    // approve → 409 → wait → approve → 409 (lock-wait recorded) → wait, lock released → approve → 202.
    // The retry wait is told apart from the poll wait by its own duration; the retry window is
    // far longer than the test, so the clock never ends it.
    const LOCK_RETRY_MS = 7;
    const lockWaits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      if (ms === LOCK_RETRY_MS) {
        lockWaits.push(ms);
        if (lockWaits.length === 2) { liveLockPid = null; }
        return;
      }
      await new Promise<void>((res) => setTimeout(res, ms));
    };
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet },
      deps({ onGates, sleep, lockRetryMs: LOCK_RETRY_MS, lockRetryMaxMs: 60 * 60_000 }));
    const v = r.summary!.versions[0];
    assert.equal(v.outcome, 'shipped', JSON.stringify(v));
    assert.equal(lockWaits.length, 2, 'exactly two refusals were waited out before the approval went through');
    assert.deepEqual(v.interventions.unplanned.filter((i) => i.kind === 'lock-wait').map((i) => i.detail),
      ['gate approve got 409 project-locked; waiting for the previous task processes to exit'], JSON.stringify(v.interventions));
    assert.deepEqual(v.interventions.required.map((i) => i.kind), ['plan-approval', 'ship-approval']);
    assert.equal(h.auditEntries().filter((e) => e.action === 'gate.approve').length, 1, 'approved once, after the lock was free');
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

  /** One version whose MOAG verify stops at `npm test`, with `npm test` probed first in the untouched workspace. */
  async function verifyStopsAtNpmTest(
    probeExit: number, node = 'v24.16.0',
    opts: { dryRun?: boolean; allowFailedProbes?: boolean; onStandards?: boolean } = { allowFailedProbes: true },
  ) {
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.1, source: 'reported' }]], verifyFailsAt: 'npm test', verifyFailsOnStandards: opts.onStandards === true }, seen);
    const calls: string[][] = [];
    const runGates: BenchDeps['runGates'] = async (commands) => {
      calls.push([...commands]);
      return commands.map((command): CommandResult => {
        if (command === 'node --version') { return { command, exitCode: 0, timedOut: false, durationMs: 1, tail: `${node}\n` }; }
        if (command === 'npm test') {
          return { command, exitCode: probeExit, timedOut: false, durationMs: 2000, tail: probeExit === 0 ? '2080 passing' : ' Exception during run: ReferenceError: require is not defined in ES module scope\n    at file:///x.ts:4:20\n' };
        }
        return { command, exitCode: 0, timedOut: false, durationMs: 5, tail: 'ok' };
      });
    };
    const fakeCheck: Partial<BenchDeps> = opts.dryRun
      ? { checkEngine: async () => ({ available: true, probeVersion: null, shellVersion: '0.0.0-moag-bench-fake (Claude Code)' }) } : {};
    const r = await runBench(scenario({ gateCommands: ['npm run compile'], environmentProbes: ['npm test'] }, 1),
      { dryRun: opts.dryRun === true, ...(opts.dryRun ? {} : { maxUsd: 10 }), ...(opts.allowFailedProbes ? { allowFailedProbes: true } : {}), outDir: out(), ...quiet },
      deps({ runGates, ...fakeCheck }));
    return { r, v: r.summary!.versions[0], calls, seen };
  }

  it('the scenario gate timeout reaches the server launch; a verify gate that still times out leaves the version not shipped', async () => {
    const seen = { plans: 0, runs: 0 };
    // What the worker reports when verify kills `npm test` at its gate timeout: the command gate failed.
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.1, source: 'reported' }]], verifyFailsAt: 'npm test' }, seen);
    const launched: LaunchOptions[] = [];
    const server: LaunchedServer = { url: h.url, projectsRoot: h.root, bootstrapToken: BOOT, serverEnv: { ...process.env }, stop: async () => undefined };
    const r = await runBench(scenario({ gateTimeoutMs: 1_800_000 }, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet },
      deps({ launchServer: async (opts) => { launched.push(opts); return server; } }));
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.equal(launched.length, 1);
    assert.equal(launched[0].gateTimeoutMs, 1_800_000, 'the server verify gets the scenario gate timeout');
    const v = r.summary!.versions[0];
    assert.deepEqual(v.moagVerify, { passed: false, failedGate: 'command', failedCommand: 'npm test' });
    assert.equal(v.outcome, 'not-shipped');
    assert.equal(v.endState, 'run-gaps');
    assert.ok(Object.values(v.trace).every((status) => status !== 'shipped'), JSON.stringify(v.trace));
  });

  it('a paid run stops at a failing environment probe before any plan request: exit 2, the probe and its exit code named', async () => {
    const { r, v, calls, seen } = await verifyStopsAtNpmTest(1, 'v24.16.0', {});
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /paid run refused: environment probe "npm test" \(exit 1\) fails in the untouched workspace on Node v24\.16\.0\./);
    assert.match(r.summary!.harnessError ?? '', /--allow-failed-probes/);
    assert.deepEqual(calls, [['node --version', 'npm test']], 'only the probes ran');
    assert.equal(seen.plans, 0, 'no plan job was started');
    assert.equal(h.workers.length, 0, 'no worker was spawned');
    assert.equal(h.auditEntries().some((e) => e.action === 'plan.generate'), false, 'no plan was requested');
    assert.equal(h.projects.list().length, 0, 'the bench stopped before it created anything on the server');
    assert.equal(r.summary!.environment.probes[0].exitCode, 1, 'the probe result is still in the summary');
    assert.deepEqual([v.outcome, v.endState], ['error', 'harness-error'], 'the version is not a product outcome');
    assert.equal(r.summary!.budget.upperBoundUsd, 0, 'nothing was spent');
    const written = JSON.parse(fs.readFileSync(path.join(out(), 'summary.json'), 'utf-8'));
    assert.match(written.harnessError, /environment probe "npm test" \(exit 1\)/, 'summary.json records the stop');
    assert.ok(fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8').includes('"kind":"environment-probes-stop"'));
  });

  it('a probe that timed out stops a paid run too, and is named as timed out', async () => {
    const runGates: BenchDeps['runGates'] = async (commands) => commands.map((command): CommandResult => (
      command === 'npm test' ? { command, exitCode: null, timedOut: true, durationMs: 10_000, tail: '' }
        : { command, exitCode: 0, timedOut: false, durationMs: 1, tail: 'v20.20.2\n' }));
    const r = await runBench(scenario({ environmentProbes: ['npm test'] }, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({ runGates }));
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /environment probe "npm test" \(timed out\)/);
    assert.equal(h.workers.length, 0);
  });

  it('a dry-run never stops for a failing environment probe, and needs no flag', async () => {
    const { r, seen } = await verifyStopsAtNpmTest(1, 'v24.16.0', { dryRun: true });
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.equal(r.summary!.mode, 'dry-run');
    assert.equal(seen.plans, 1, 'the plan was requested');
    assert.equal(r.summary!.environment.probes[0].pass, false);
    assert.equal(r.summary!.notes.some((n) => /allow-failed-probes/.test(n)), false);
  });

  it('a paid run whose probes all pass needs no flag', async () => {
    const { r, seen } = await verifyStopsAtNpmTest(0, 'v20.20.2', {});
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.equal(seen.plans, 1);
  });

  it('a verify failure at a command the untouched workspace already could not run is recorded as environment, not product', async () => {
    const { r, v, calls, seen } = await verifyStopsAtNpmTest(1);
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.deepEqual(calls[0], ['node --version', 'npm test'], 'the probes run first, before any plan');
    assert.deepEqual(calls[1], ['npm run compile'], 'the acceptance gates are still only the scenario gate commands');
    assert.equal(seen.plans, 1, 'with --allow-failed-probes a failing probe does not stop a paid run');
    assert.ok(r.summary!.notes.some((n) => /--allow-failed-probes: the paid run went ahead although environment probe "npm test" \(exit 1\)/.test(n)), JSON.stringify(r.summary!.notes));
    assert.equal(r.summary!.environment.node, 'v24.16.0');
    assert.deepEqual(r.summary!.environment.probes, [{
      command: 'npm test', exitCode: 1, timedOut: false, durationMs: 2000, pass: false,
      detail: 'Exception during run: ReferenceError: require is not defined in ES module scope',
    }]);
    assert.deepEqual(v.moagVerify, { passed: false, failedGate: 'command', failedCommand: 'npm test' });
    assert.equal(v.environment.length, 1, JSON.stringify(v.environment));
    assert.match(v.environment[0], /^environment: Node v24\.16\.0 cannot run "npm test": it exits 1 in the untouched workspace, before any plan .*MOAG's own verify stopped at this command\.$/);
    assert.equal(v.gateFirstRunPass?.pass, true, 'the bench acceptance gate passed and is reported separately');
    assert.equal(v.outcome, 'not-shipped', 'nothing shipped, and the outcome says so');
    assert.equal(v.endState, 'run-gaps');
    const events = fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8');
    assert.ok(events.includes('"kind":"environment-probes"'));
  });

  it('a standards-gate failure names no command and is never excused as an environment problem', async () => {
    // The probe for "npm test" fails in the untouched workspace AND verify announced "npm test"
    // as a gate — but verify ended on the standards gate, so neither may be blamed.
    const { r, v } = await verifyStopsAtNpmTest(1, 'v24.16.0', { allowFailedProbes: true, onStandards: true });
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.deepEqual(v.moagVerify, { passed: false, failedGate: 'standards', failedCommand: null });
    assert.deepEqual(v.environment, [], JSON.stringify(v.environment));
    assert.equal(v.outcome, 'not-shipped');
    assert.equal(v.endState, 'run-gaps');
  });

  it('the same verify failure where the probe passed (Node 20) stays a product failure', async () => {
    const { r, v } = await verifyStopsAtNpmTest(0, 'v20.20.2');
    assert.equal(r.summary!.environment.node, 'v20.20.2');
    assert.equal(r.summary!.environment.probes[0].pass, true);
    assert.deepEqual(v.moagVerify, { passed: false, failedGate: 'command', failedCommand: 'npm test' });
    assert.deepEqual(v.environment, [], 'no environment excuse when the untouched workspace ran the suite');
    assert.equal(v.endState, 'run-gaps');
  });

  it('a command the scenario author listed in allowedCommands is approved; one that is not is rejected by name (unplanned)', async () => {
    const seen = { plans: 0, runs: 0 };
    const patch: NonNullable<Script['patch']> = (_pl, tasks, n) => {
      // Plan 1 carries only listed commands; plan 2 adds a near-miss of a listed one.
      tasks.push({ id: `lint-${n}`, name: 'Lint', type: 'command', command: 'npm run lint', prompt: 'lint' });
      tasks.push({ id: `suite-${n}`, name: 'Suite', type: 'agent', verifyCommand: ' npm test ', prompt: 'suite' });
      if (n === 2) { tasks.push({ id: 'near', name: 'Near miss', type: 'command', command: 'npm run lint -- --fix', prompt: 'x' }); }
    };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.1, source: 'reported' }]], patch }, seen);
    const r = await runBench(scenario({ allowedCommands: ['npm run lint'] }, 2), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    const [v1, v2] = r.summary!.versions;
    assert.equal(v1.outcome, 'shipped', JSON.stringify(v1.interventions));
    assert.deepEqual(v1.interventions.unplanned, [], 'a listed command is not an intervention');
    assert.equal(v2.outcome, 'plan-failed');
    assert.equal(v2.endState, 'plan-rejected');
    assert.match(rejectedDetail(v2), /task "Near miss" command: npm run lint -- --fix/);
    assert.doesNotMatch(rejectedDetail(v2), /"Lint"|"Suite"/, 'the listed commands are not named as problems');
    assert.deepEqual(v2.interventions.required, [], 'no approval is recorded for the rejected plan');
    assert.equal(seen.runs, 1, 'only the first plan ran');
  });

  it('scenarioAllowedCommands is gate commands + allowedCommands + the dry-run plan command, and nothing is a pattern', () => {
    const s = scenario({ gateCommands: ['npm test'], allowedCommands: ['npm run *'], dryRun: { planCommand: 'node t.js' } });
    assert.deepEqual(scenarioAllowedCommands(s), ['npm test', 'npm run *', 'node t.js']);
    const review = (value: string) => ({ review: { ok: true, commands: [{ taskName: 'T', field: 'command', value }] } });
    assert.deepEqual(planApprovalProblems(review('npm run *'), scenarioAllowedCommands(s)), [], 'the literal string itself matches');
    assert.deepEqual(planApprovalProblems(review('npm run publish'), scenarioAllowedCommands(s)), ['task "T" command: npm run publish'],
      'an entry with a wildcard matches nothing but itself');
    assert.equal(planApprovalProblems(review('npm test && git push'), scenarioAllowedCommands(s)).length, 1, 'a listed command with a suffix is refused');
    assert.equal(planApprovalProblems(review('NPM TEST'), scenarioAllowedCommands(s)).length, 1, 'matching is case-sensitive');
    assert.deepEqual(scenarioAllowedCommands(scenario({ dryRun: undefined })), ['npm test']);
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

  it('planApprovalProblems treats parallel by truthiness, as the runner does', () => {
    const problems = (parallel: unknown) => planApprovalProblems({ playlist: { parallel, tasks: [] }, review: { ok: true, commands: [] } }, []);
    for (const truthy of [true, 'true', 'false', 1, {}, []]) {
      assert.equal(problems(truthy).length, 1, `parallel: ${JSON.stringify(truthy)} runs in parallel in the runner`);
      assert.match(problems(truthy)[0], /parallel/);
    }
    for (const falsy of [false, 0, '', null, undefined]) {
      assert.deepEqual(problems(falsy), [], `parallel: ${JSON.stringify(falsy)} is sequential`);
    }
  });

  it('a playlist whose parallel flag is a truthy non-boolean is rejected, never run', async () => {
    const { v, seen, serverPlan } = await oneVersionWith((pl) => { pl.parallel = 'yes'; });
    assert.equal(v.outcome, 'plan-failed');
    assert.equal(v.endState, 'plan-rejected');
    assert.match(rejectedDetail(v), /parallel/);
    assert.equal(seen.runs, 0);
    assert.equal(serverPlan.status, 'rejected');
  });

  // ─── Standards: approved through the reviewed path before the first plan ───

  /** Swap the default harness (standards auto-approved) for one where nothing is approved behind the bench's back. */
  async function manualStandards(): Promise<void> {
    await h.close();
    h = await startHarness({ accounts: {}, config: { bootstrapToken: BOOT }, engineAvailable: () => true, standards: 'manual' });
  }

  /** Every mutating bench request in events.jsonl, in order, as "actor METHOD path-suffix". */
  const httpLog = (name = 'out'): Array<{ actor: string; method: string; path: string; status: number }> =>
    fs.readFileSync(path.join(out(name), 'events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.kind === 'http' && e.method !== 'GET')
      .map((e) => ({ actor: String(e.actor), method: String(e.method), path: String(e.path), status: Number(e.status) }));

  it('the bench proposes as product owner and approves as reviewer before the first plan request, never through accept-defaults', async () => {
    await manualStandards();
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.1, source: 'reported' }]] }, seen);
    const sc = scenario({}, 1);
    const r = await runBench(sc, { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.equal(r.summary!.versions[0].outcome, 'shipped', JSON.stringify(r.summary!.versions[0]));

    // Request order, as the bench sent it: propose (po) → approve (reviewer) → first plan request (po).
    const calls = httpLog();
    const propose = calls.findIndex((c) => /\/standards\/versions$/.test(c.path));
    const approve = calls.findIndex((c) => /\/standards\/versions\/\d+\/approve$/.test(c.path));
    const firstPlan = calls.findIndex((c) => /\/plans$/.test(c.path));
    assert.ok(propose >= 0 && approve > propose && firstPlan > approve, JSON.stringify({ propose, approve, firstPlan }));
    assert.deepEqual([calls[propose].actor, calls[propose].status], ['po', 201]);
    assert.deepEqual([calls[approve].actor, calls[approve].status], ['reviewer', 200]);
    assert.equal(calls.some((c) => /accept-defaults/.test(c.path)), false);

    // The same order in the server's own audit log, each step under its own account.
    const audit = h.auditEntries().map((e) => `${e.action}:${e.actorUsername}`);
    const approvedAt = audit.indexOf('standards.approve:bench-reviewer');
    assert.ok(audit.indexOf('standards.propose:bench-po') >= 0 && approvedAt > audit.lastIndexOf('standards.propose:bench-po'), audit.join(','));
    assert.ok(audit.indexOf('plan.generate:bench-po') > approvedAt, audit.join(','));
    assert.equal(audit.some((a) => a.startsWith('standards.accept-defaults')), false);

    // What is in effect is exactly the stack's built-in profile, with no commands.
    const projectId = h.projects.list()[0].id;
    const effective = h.standards.effective(projectId)!;
    assert.equal(effective.origin, 'user');
    assert.equal(effective.decision, 'approved');
    assert.equal(effective.contentHash, profileHash(benchStandardsProfile(sc)));
    assert.deepEqual(effective.profile, { ...builtInProfile('node-ts'), commands: [] });
    // Setup, not an intervention: the per-version required approvals are unchanged, and the summary says what happened.
    assert.deepEqual(r.summary!.versions[0].interventions.required.map((i) => i.kind), ['plan-approval', 'ship-approval']);
    assert.deepEqual(r.summary!.versions[0].interventions.unplanned, []);
    assert.ok(r.summary!.notes.some((n) => /^standards v2 \(node-ts built-in profile, 0 commands\) proposed by bench-po and approved by bench-reviewer/.test(n)), JSON.stringify(r.summary!.notes));
  });

  it('a scenario profile is what gets approved; a cloned repository gets the built-in as brownfield', async () => {
    await manualStandards();
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [[{ usd: 0.1, source: 'reported' }]] }, seen);
    const profile = { ...sampleProfile(), commands: [{ label: 'Test', run: 'npm test' }] };
    const sc = scenario({ standardsProfile: { file: path.join(tmp, 'standards.json'), profile } }, 1);
    const r = await runBench(sc, { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    assert.deepEqual(h.standards.effective(h.projects.list()[0].id)!.profile, profile);
    assert.ok(r.summary!.notes.some((n) => /scenario profile standards\.json, 1 command\)/.test(n)), JSON.stringify(r.summary!.notes));

    assert.equal(benchStandardsProfile(scenario()).repoState, 'greenfield');
    const cloned = benchStandardsProfile(scenario({ repo: { kind: 'clone', path: tmp, ref: 'main' } }));
    assert.equal(cloned.repoState, 'brownfield');
    assert.deepEqual(cloned.commands, []);
  });

  it('a profile command the scenario does not allow is never approved: exit 2 before any plan request, named in the error', async () => {
    await manualStandards();
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    // Built by hand, past the scenario parser, the way a programmatic caller could.
    const profile = { ...sampleProfile(), commands: [{ label: 'Test', run: 'npm test' }, { label: 'Publish', run: 'npm publish' }] };
    const r = await runBench(scenario({ standardsProfile: { file: path.join(tmp, 'standards.json'), profile } }, 1),
      { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /will not approve standards v2 unreviewed: standards command "Publish": npm publish No plan was requested\./);
    assert.equal(seen.plans, 0);
    assert.equal(h.workers.length, 0, 'no worker was spawned');
    const audit = h.auditEntries().map((e) => e.action);
    assert.equal(audit.includes('standards.approve'), false, 'nothing was approved');
    assert.equal(audit.includes('plan.generate'), false, 'no plan was requested');
    assert.equal(h.standards.effective(h.projects.list()[0].id), null);
    assert.deepEqual([r.summary!.versions[0].outcome, r.summary!.versions[0].endState], ['error', 'harness-error']);
    assert.ok(fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8').includes('"kind":"standards-refused"'));
  });

  it('a proposal the server refuses stops the bench (exit 2) before any plan request', async () => {
    await manualStandards();
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    const profile = { ...sampleProfile(), commands: [], freeText: 'x'.repeat(20_001) };
    const r = await runBench(scenario({ standardsProfile: { file: path.join(tmp, 'standards.json'), profile } }, 1),
      { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /standards proposal refused \(scenario profile standards\.json\): HTTP 400 invalid-standards .*freeText/);
    assert.equal(seen.plans, 0);
    assert.equal(h.auditEntries().some((e) => e.action === 'plan.generate' || e.action === 'standards.approve'), false);
  });

  it('a refused approval stops the bench (exit 2) before any plan request', async () => {
    await manualStandards();
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    // Someone else proposes between the bench's proposal and its approval: the bench's version is superseded.
    const realApprove = h.standards.approve.bind(h.standards);
    h.standards.approve = (projectId, version, input, now) => {
      h.standards.propose(projectId, { profile: builtInProfile('node-ts'), provenance: h.standards.get(projectId, version)!.provenance, origin: 'user', proposedBy: 'someone-else', baseVersion: version });
      return realApprove(projectId, version, input, now);
    };
    const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 2);
    assert.match(r.summary!.harnessError ?? '', /standards approval refused: HTTP 409 /);
    assert.equal(seen.plans, 0);
    assert.equal(h.auditEntries().some((e) => e.action === 'plan.generate'), false);
  });

  it('a 409 standards-not-approved on the plan request is reported once per version, never retried', async () => {
    await manualStandards();
    const seen = { plans: 0, runs: 0 };
    scriptWorkers(h, { plans: [], costs: [] }, seen);
    // The store loses every version right after the bench's approval (loss or tampering): the plan gate fails closed.
    const realApprove = h.standards.approve.bind(h.standards);
    h.standards.approve = (projectId, version, input, now) => {
      const decided = realApprove(projectId, version, input, now);
      h.standards.load = () => ({ migrated: false, versions: [] });
      return decided;
    };
    const r = await runBench(scenario({}, 2, ['initial', 'minor']), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps());
    assert.equal(r.exitCode, 0, r.summary?.harnessError ?? '');
    for (const v of r.summary!.versions) {
      assert.equal(v.outcome, 'plan-failed', v.id);
      assert.equal(v.endState, 'plan-request-standards-not-approved', v.id);
      assert.deepEqual(v.interventions.unplanned.filter((i) => i.kind.startsWith('plan-')).map((i) => i.kind), ['plan-standards-not-approved'], v.id);
      assert.deepEqual(v.interventions.required, [], v.id);
    }
    const planRequests = httpLog().filter((c) => /\/plans$/.test(c.path));
    assert.deepEqual(planRequests.map((c) => c.status), [409, 409], 'one request per version, none repeated');
    assert.equal(seen.plans, 0, 'no plan job was started');
    assert.equal(h.auditEntries().some((e) => e.action === 'plan.generate'), false);
  });

  it('standardsApprovalProblems: only a pending version with the proposed content and allow-listed commands is approvable', () => {
    const hash = 'a'.repeat(64);
    const ok = { version: 2, status: 'pending', contentHash: hash, commands: [{ label: 'Test', run: 'npm test' }], profile: { commands: [{ label: 'Test', run: 'npm test' }] } };
    assert.deepEqual(standardsApprovalProblems(ok, ['npm test'], hash), []);
    assert.deepEqual(standardsApprovalProblems({ ...ok, commands: [], profile: { commands: [] } }, [], hash), [], 'no commands needs no allow-list');
    assert.deepEqual(standardsApprovalProblems(ok, [' npm test '], hash), [], 'compared after trimming, like plan commands');
    assert.equal(standardsApprovalProblems(undefined, ['npm test']).length, 1, 'no version');
    assert.match(standardsApprovalProblems({ ...ok, status: 'approved' }, ['npm test'], hash)[0], /is approved, not pending/);
    assert.match(standardsApprovalProblems({ ...ok, status: 'superseded' }, ['npm test'], hash)[0], /superseded/);
    assert.match(standardsApprovalProblems(ok, ['npm test'], 'b'.repeat(64))[0], /not the profile the bench proposed/);
    assert.match(standardsApprovalProblems({ ...ok, contentHash: undefined }, ['npm test'])[0], /no content hash/);
    assert.match(standardsApprovalProblems({ ...ok, commands: undefined }, ['npm test'], hash)[0], /no command list/);
    assert.deepEqual(standardsApprovalProblems(ok, ['npm run test'], hash), ['standards command "Test": npm test'], 'exact strings, named once');
    assert.equal(standardsApprovalProblems(ok, ['NPM TEST', 'npm test && git push', 'npm *'], hash).length, 1, 'case-sensitive, no prefixes, no patterns');
    // A command the profile carries but the verbatim list hides is still caught.
    const hidden = { ...ok, profile: { commands: [{ label: 'Test', run: 'npm test' }, { label: 'Push', run: 'git push' }] } };
    assert.deepEqual(standardsApprovalProblems(hidden, ['npm test'], hash), ['standards command "Push": git push']);
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

  it('a non-empty --out whose job.lock names live processes lists them with kill commands, and starts nothing', async () => {
    const lockDir = path.join(out(), 'server-data', 'projects', 'p1');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'job.lock'), JSON.stringify({ serverPid: 111111, workerPid: 222222, taskPids: [333333, 444444] }));
    const lines: string[] = [];
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 1, outDir: out(), progress: (l) => lines.push(l) },
      deps({ isPidAlive: (pid) => pid === 222222 || pid === 333333 }));
    assert.equal(r.exitCode, 2);
    assert.equal(launches, 0);
    const text = lines.join('\n');
    assert.match(text, /project p1: worker 222222; task 333333/);
    assert.doesNotMatch(text, /111111|444444/, 'dead pids are not listed');
    assert.match(text, /may still be spending/);
    assert.match(text, process.platform === 'win32' ? /taskkill \/T \/F \/PID 222222/ : /kill -TERM -222222/);
  });

  it('a non-empty --out whose lock holders are all dead keeps the plain refusal', async () => {
    const lockDir = path.join(out(), 'server-data', 'projects', 'p1');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'job.lock'), JSON.stringify({ serverPid: 111111, workerPid: 222222 }));
    const lines: string[] = [];
    const r = await runBench(scenario(), { dryRun: false, maxUsd: 1, outDir: out(), progress: (l) => lines.push(l) }, deps({ isPidAlive: () => false }));
    assert.equal(r.exitCode, 2);
    assert.match(lines.join('\n'), /is not empty; refusing to mix two benchmark runs/);
  });

  describe('termination signals', () => {
    interface Term { handlers: { signal(name: string): void; exit(): void } | null; disposed: number }
    const termDeps = (t: Term): Pick<BenchDeps, 'onTermination'> => ({
      onTermination: (hd) => { t.handlers = hd; return () => { t.disposed++; }; },
    });
    /** A server whose killNow and stop are counted. */
    const countingServer = (c: { kills: number; stops: number }): LaunchedServer => ({
      url: h.url, projectsRoot: h.root, bootstrapToken: BOOT, serverEnv: { ...process.env },
      stop: async () => { c.stops++; }, killNow: () => { c.kills++; },
    });
    /**
     * The run worker stays running until it is told to stop. `fire` runs once the bench
     * has started the run (its "run … started" progress line). Returns that progress sink.
     */
    function signalDuringRun(fire: () => void, lines: string[] = []): (l: string) => void {
      const seen = { plans: 0, runs: 0 };
      scriptWorkers(h, { plans: [], costs: [] }, seen);
      const scripted = h.onSpawn;
      h.onSpawn = (w: FakeWorker) => {
        if (w.job.kind !== 'run') { scripted(w); return; }
        w.send = (m: unknown): boolean => {
          if ((m as { type?: string })?.type === 'stop') { setImmediate(() => w.exit(1)); }
          return true;
        };
        w.line({ event: 'state', state: 'playing' });
      };
      let fired = false;
      return (l: string) => {
        lines.push(l);
        if (!fired && /: run \S+ started/.test(l)) { fired = true; fire(); }
      };
    }

    it('SIGTERM mid-run stops the run through the API, aborts with its name, stops the server and disposes the handlers', async () => {
      const t: Term = { handlers: null, disposed: 0 };
      const c = { kills: 0, stops: 0 };
      const lines: string[] = [];
      const progress = signalDuringRun(() => t.handlers!.signal('SIGTERM'), lines);
      const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), progress },
        deps({ ...termDeps(t), launchServer: async () => countingServer(c) }));
      assert.equal(r.exitCode, 2);
      assert.equal(r.summary!.harnessError, 'aborted (SIGTERM)');
      // The stop request is fire-and-forget; its log line may land just after runBench returns.
      const stopLogged = (): boolean => fs.readFileSync(path.join(out(), 'events.jsonl'), 'utf-8').trim().split('\n')
        .map((l) => JSON.parse(l)).some((e) => e.kind === 'stop-request' && e.why === 'sigterm' && e.status === 202);
      for (let i = 0; i < 100 && !stopLogged(); i++) { await new Promise((res) => setTimeout(res, 20)); }
      assert.ok(stopLogged(), 'the run was stopped through the API');
      assert.ok(h.auditEntries().some((e) => e.action === 'run.stop'), 'the server recorded the stop');
      assert.ok(lines.some((l) => /^SIGTERM: stopping the active run/.test(l)));
      assert.equal(c.stops, 1);
      assert.equal(c.kills, 0, 'one SIGTERM stops gracefully');
      assert.equal(t.disposed, 1);
    });

    it('a second signal kills every worker now', async () => {
      const t: Term = { handlers: null, disposed: 0 };
      const c = { kills: 0, stops: 0 };
      const lines: string[] = [];
      const progress = signalDuringRun(() => { t.handlers!.signal('SIGINT'); t.handlers!.signal('SIGINT'); }, lines);
      const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), progress },
        deps({ ...termDeps(t), launchServer: async () => countingServer(c) }));
      assert.equal(r.summary!.harnessError, 'aborted (SIGINT)');
      assert.ok(lines.some((l) => /^Ctrl\+C: stopping the active run/.test(l)));
      assert.equal(c.kills, 1);
      assert.ok(lines.includes('second SIGINT: killing every worker now'));
      assert.equal(t.disposed, 1);
    });

    it('SIGHUP kills the workers at once (Windows ends the process soon after)', async () => {
      const t: Term = { handlers: null, disposed: 0 };
      const c = { kills: 0, stops: 0 };
      let killsWhenFired = -1;
      const progress = signalDuringRun(() => { t.handlers!.signal('SIGHUP'); killsWhenFired = c.kills; });
      const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), progress },
        deps({ ...termDeps(t), launchServer: async () => countingServer(c) }));
      assert.equal(killsWhenFired, 1);
      assert.equal(r.summary!.harnessError, 'aborted (SIGHUP)');
      assert.equal(t.disposed, 1);
    });

    it('exit kills the workers synchronously and does not itself abort', async () => {
      const t: Term = { handlers: null, disposed: 0 };
      const c = { kills: 0, stops: 0 };
      let killsAfterExit = -1;
      // exit does not abort the flow; a SIGTERM afterwards ends the run so the test finishes.
      const progress = signalDuringRun(() => { t.handlers!.exit(); killsAfterExit = c.kills; t.handlers!.signal('SIGTERM'); });
      const r = await runBench(scenario({}, 1), { dryRun: false, maxUsd: 10, outDir: out(), progress },
        deps({ ...termDeps(t), launchServer: async () => countingServer(c) }));
      assert.equal(killsAfterExit, 1);
      assert.equal(r.summary!.harnessError, 'aborted (SIGTERM)');
      assert.equal(c.kills, 1, 'the SIGTERM after it is a first signal: graceful');
      assert.equal(t.disposed, 1);
    });

    it('the handlers are disposed on a harness error too', async () => {
      const t: Term = { handlers: null, disposed: 0 };
      const r = await runBench(scenario(), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({
        ...termDeps(t),
        prepareWorkspace: async () => { throw new Error('setup failed'); },
      }));
      assert.equal(r.exitCode, 2);
      assert.equal(t.disposed, 1);
    });

    it('the default registration adds real process handlers and removes every one', async () => {
      const count = () => ({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'), hup: process.listenerCount('SIGHUP'), exit: process.listenerCount('exit') });
      const before = count();
      let during = before;
      await runBench(scenario(), { dryRun: false, maxUsd: 10, outDir: out(), ...quiet }, deps({
        prepareWorkspace: async () => { during = count(); throw new Error('stop here'); },
      }));
      assert.deepEqual(during, { int: before.int + 1, term: before.term + 1, hup: before.hup + 1, exit: before.exit + 1 });
      assert.deepEqual(count(), before);
    });
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

describe('terminationSignals', () => {
  it('adds SIGBREAK only on Windows', () => {
    assert.deepEqual(terminationSignals('win32'), ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
    assert.deepEqual(terminationSignals('linux'), ['SIGINT', 'SIGTERM', 'SIGHUP']);
  });
});
