// ─── PRD loop — deterministic gates must fail without ever calling a model ───

import { strict as assert } from 'assert';
import { EngineResult, Plan, TaskStatus } from '../../../models/types';
import type {
  PrdLoopConfig,
  PrdLoopController,
  PrdLoopDeps,
  PrdLoopReport,
  UatSession,
} from '../../../runner/prd-loop';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

interface GateStub {
  command: string;
  exitCode: number;
  passed: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

interface EvidenceStubOptions {
  /** One entry per collectDiffEvidence call; the last entry repeats. */
  changedFilesSequence?: string[][];
  gateCommands?: string[];
  /** Result for each resolved gate command. */
  gateResult?: (command: string, call: number) => GateStub;
  artifactsExist?: boolean;
  baseRef?: string | null;
  /** What resolveUatGate reports. Defaults to "no browser tooling in this repo". */
  uatCapability?: {
    tool: 'playwright' | 'cypress' | null;
    command: string | null;
    specPath: string | null;
    reason: string;
  };
  /** Make runGate reject for this command, proving dispose() still fires. */
  throwOnGate?: string;
}

interface LoopHarness {
  createPrdLoop: (cfg: PrdLoopConfig, deps: PrdLoopDeps) => PrdLoopController;
  diffCalls: () => number;
  gateCalls: () => string[];
  gateEnvs: () => Array<Record<string, string> | undefined>;
}

/** "This repository has no browser test tooling at all." */
const NO_UAT_TOOLING = {
  tool: null,
  command: null,
  specPath: null,
  reason: 'No playwright.config.* or cypress.config.* and no playwright/cypress dependency in package.json.',
} as const;

/** "This repository can run Playwright." */
const HAS_UAT_TOOLING = {
  tool: 'playwright' as const,
  command: 'npx playwright test --reporter=line',
  specPath: null,
  reason: 'playwright.config.ts',
};

function loadLoop(opts: EvidenceStubOptions = {}): LoopHarness {
  let diffCall = 0;
  let gateCall = 0;
  const gateCalls: string[] = [];
  const gateEnvs: Array<Record<string, string> | undefined> = [];
  const sequence = opts.changedFilesSequence ?? [['src/a.ts']];

  const evidenceStub = {
    captureBaseRef: async () => (opts.baseRef === undefined ? 'base-ref' : opts.baseRef),
    collectDiffEvidence: async () => {
      const entry = sequence[Math.min(diffCall, sequence.length - 1)];
      diffCall++;
      return {
        baseRef: opts.baseRef === undefined ? 'base-ref' : opts.baseRef,
        changedFiles: entry,
        diffStat: entry.length > 0 ? ` ${entry[0]} | 1 +` : '',
        unifiedDiff: entry.length > 0 ? '--- diff ---' : '',
        truncated: false,
      };
    },
    resolveGateCommands: () => opts.gateCommands ?? ['npm test'],
    resolveUatGate: () => opts.uatCapability ?? NO_UAT_TOOLING,
    runGate: async (command: string, gateOpts: { env?: Record<string, string> }) => {
      gateCalls.push(command);
      gateEnvs.push(gateOpts?.env);
      if (opts.throwOnGate && command === opts.throwOnGate) {
        gateCall++;
        throw new Error('runGate exploded');
      }
      const result = opts.gateResult
        ? opts.gateResult(command, gateCall)
        : { command, exitCode: 0, passed: true, output: 'ok', durationMs: 1, timedOut: false };
      gateCall++;
      return result;
    },
    checkArtifacts: (_cwd: string, artifacts: string[]) =>
      artifacts.map((target) => ({ target, exists: opts.artifactsExist !== false })),
    summarizeEvidence: () => '## Deterministic evidence\n(stub)',
  };

  const mod = proxyquire('../../../runner/prd-loop', { './evidence': evidenceStub });
  return {
    createPrdLoop: mod.createPrdLoop,
    diffCalls: () => diffCall,
    gateCalls: () => gateCalls,
    gateEnvs: () => gateEnvs,
  };
}

function baseConfig(over: Partial<PrdLoopConfig> = {}): PrdLoopConfig {
  return {
    cwd: '/repo',
    maxFixIterations: 3,
    gateCommands: [],
    gateTimeoutMs: 1_000,
    maxDiffChars: 4_000,
    onManualGate: 'halt',
    fix: false,
    unattended: false,
    uat: { mode: 'off', timeoutMs: 60_000 },
    ...over,
  };
}

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    version: '1.0',
    name: 'Test Plan',
    defaultEngine: 'claude',
    validation: {
      targets: ['web'],
      profile: 'quick',
      contextBudget: { discoveryTokens: 1, analysisTokens: 1, fixTokens: 1 },
    },
    prdSource: 'PRD TEXT',
    playlists: [
      {
        id: 'pl-1',
        name: 'Build',
        autoplay: true,
        tasks: [
          { id: 't-1', name: 'Task one', prompt: 'do it', type: 'agent', status: TaskStatus.Completed },
        ],
      },
    ],
    ...over,
  };
}

function engineResult(stdout: string, exitCode = 0): EngineResult {
  return { stdout, stderr: '', exitCode, durationMs: 1 };
}

interface DepsHarness {
  deps: PrdLoopDeps;
  engineCalls: string[];
  reports: PrdLoopReport[];
  progress: Array<{ phase: string; detail: string }>;
  skipped: string[];
  /** Mutable counters — kept in an object so tests can bump them from their own fakes. */
  counters: { planRuns: number; saves: number };
}

/** Mark every pending task complete, the way a real successful run would. */
function completeAll(plan: Plan): void {
  for (const pl of plan.playlists) {
    for (const t of pl.tasks) {
      if (t.status === TaskStatus.Pending) { t.status = TaskStatus.Completed; }
    }
  }
}

function makeDeps(plan: Plan, over: Partial<PrdLoopDeps> = {}): DepsHarness {
  const engineCalls: string[] = [];
  const reports: PrdLoopReport[] = [];
  const progress: Array<{ phase: string; detail: string }> = [];
  const skipped: string[] = [];
  const counters = { planRuns: 0, saves: 0 };

  const deps: PrdLoopDeps = {
    plan,
    resolvePrdText: async () => 'PRD TEXT',
    runPlan: async (p: Plan) => {
      counters.planRuns++;
      completeAll(p);
    },
    runEngine: async (prompt: string) => {
      engineCalls.push(prompt);
      return engineResult('{"passed":false,"score":10,"gaps":["g"],"suggestion":"s"}');
    },
    savePlan: () => { counters.saves++; },
    onProgress: (phase: string, detail: string) => { progress.push({ phase, detail }); },
    emitReport: (r: PrdLoopReport) => { reports.push(r); },
    skipManualGate: (taskId: string) => { skipped.push(taskId); },
    signal: new AbortController().signal,
    ...over,
  };
  return { deps, engineCalls, reports, progress, skipped, counters };
}

const FAILING_GATE = (command: string): GateStub => ({
  command,
  exitCode: 1,
  passed: false,
  output: 'AssertionError: expected true to equal false',
  durationMs: 5,
  timedOut: false,
});

describe('createPrdLoop — deterministic gates', () => {
  it('1. a "successful" agent that changed nothing fails the change gate with zero model calls', async () => {
    const { createPrdLoop } = loadLoop({ changedFilesSequence: [[]] });
    const plan = makePlan();
    const h = makeDeps(plan);
    let engineCalled = false;
    h.deps.runEngine = async () => { engineCalled = true; return engineResult('{"passed":true,"score":100,"gaps":[],"suggestion":""}'); };

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'change');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(engineCalled, false, 'no model may be consulted when nothing changed');
  });

  it('2. a gate command exiting 1 fails the command gate with zero model calls', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const h = makeDeps(makePlan());

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'command');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(h.engineCalls.length, 0);
    assert.equal(report.gates.length, 1);
    assert.equal(report.gates[0].exitCode, 1);
  });

  it('3. a Failed task fails the status gate with zero model calls', async () => {
    const { createPrdLoop } = loadLoop();
    const plan = makePlan();
    plan.playlists[0].tasks[0].status = TaskStatus.Failed;
    const h = makeDeps(plan);

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.failedGate, 'status');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(h.engineCalls.length, 0);
  });

  it('3b. a Blocked task also fails the status gate (markDependentsBlocked cascade)', async () => {
    const { createPrdLoop } = loadLoop();
    const plan = makePlan();
    plan.playlists[0].tasks[0].status = TaskStatus.Blocked;
    const h = makeDeps(plan);

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.failedGate, 'status');
    assert.equal(report.modelCallsMade, 0);
  });

  it('4. a missing declared artifact fails the artifact gate with zero model calls', async () => {
    const { createPrdLoop } = loadLoop({ artifactsExist: false });
    const plan = makePlan();
    plan.playlists[0].tasks[0].expectedArtifacts = ['dist/app.js'];
    const h = makeDeps(plan);

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.failedGate, 'artifact');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(h.engineCalls.length, 0);
  });

  it('5. a model that always says "passed" cannot override a failed gate', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true,"score":100,"gaps":[],"suggestion":"ship it"}');

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'command');
    assert.equal(report.score, 0);
  });

  it('6. unparsable model output halts with engine-error and never reports passed', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('I think it looks good to me!');

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.haltReason, 'engine-error');
    assert.equal(report.passed, false);
    assert.equal(report.modelCallsMade, 1);
  });

  it('6b. a non-zero engine exit halts with engine-error', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true}', 1);

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.haltReason, 'engine-error');
    assert.equal(report.passed, false);
  });

  it('7. a null PRD halts with no-prd and makes zero model calls', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    h.deps.resolvePrdText = async () => null;

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.haltReason, 'no-prd');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(h.engineCalls.length, 0);
  });
});

describe('createPrdLoop — iteration control', () => {
  it('8. stops after maxFixIterations fix playlists and saves after each increment', async () => {
    const { createPrdLoop } = loadLoop({
      gateResult: (c) => FAILING_GATE(c),
      // A different file each round, so the no-progress guard does not fire first.
      changedFilesSequence: [['a.ts'], ['b.ts'], ['c.ts'], ['d.ts']],
    });
    const plan = makePlan();
    const h = makeDeps(plan);
    h.deps.runEngine = async (prompt: string) => {
      h.engineCalls.push(prompt);
      return engineResult('[{"name":"Fix it","prompt":"fix"}]');
    };

    const report = await createPrdLoop(baseConfig({ fix: true, maxFixIterations: 2 }), h.deps).run();

    assert.equal(report.haltReason, 'max-iterations');
    const fixPlaylists = plan.playlists.filter((pl) => pl.name.startsWith('Fix — Iteration'));
    assert.equal(fixPlaylists.length, 2);
    assert.equal(plan.fixIterations, 2);
    // 1 reset save + 1 save per increment
    assert.ok(h.counters.saves >= 3, `expected >= 3 saves, got ${h.counters.saves}`);
  });

  it('9. halts on no-progress well before the iteration ceiling', async () => {
    const { createPrdLoop } = loadLoop({
      gateResult: (c) => FAILING_GATE(c),
      changedFilesSequence: [['a.ts']], // identical fingerprint every round
    });
    const plan = makePlan();
    const h = makeDeps(plan);
    h.deps.runEngine = async (prompt: string) => {
      h.engineCalls.push(prompt);
      return engineResult('[{"name":"Fix it","prompt":"fix"}]');
    };

    const report = await createPrdLoop(baseConfig({ fix: true, maxFixIterations: 5 }), h.deps).run();

    assert.equal(report.haltReason, 'no-progress');
    assert.ok(report.modelCallsMade < 5, `expected fewer than 5 model calls, got ${report.modelCallsMade}`);
  });

  it('10. a budget breach mid-run halts and does not run the plan again', async () => {
    const { createPrdLoop } = loadLoop({
      gateResult: (c) => FAILING_GATE(c),
      changedFilesSequence: [['a.ts'], ['b.ts'], ['c.ts']],
    });
    const plan = makePlan();
    const h = makeDeps(plan);
    let loop: PrdLoopController | null = null;
    h.deps.runPlan = async (p: Plan) => {
      h.counters.planRuns++;
      completeAll(p);
      loop?.noteBudgetExceeded();
    };
    h.deps.runEngine = async () => engineResult('[{"name":"Fix it","prompt":"fix"}]');
    loop = createPrdLoop(baseConfig({ fix: true, maxFixIterations: 5 }), h.deps);

    const report = await loop.run();

    assert.equal(report.haltReason, 'budget-exceeded');
    assert.equal(h.counters.planRuns, 1, 'the plan must not be replayed after the ceiling is breached');
  });

  it('11. a manual gate with onManualGate:halt stops before verification runs', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    const loop = createPrdLoop(baseConfig({ onManualGate: 'halt' }), h.deps);
    loop.noteManualGate('t-ship');

    const report = await loop.run();

    assert.equal(report.haltReason, 'manual-gate');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(h.skipped.length, 0);
  });

  it('12. a manual gate with onManualGate:skip clears the gate and continues', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true,"score":95,"gaps":[],"suggestion":"ok"}');
    const loop = createPrdLoop(baseConfig({ onManualGate: 'skip' }), h.deps);
    loop.noteManualGate('t-ship');

    const report = await loop.run();

    assert.deepEqual(h.skipped, ['t-ship']);
    assert.notEqual(report.haltReason, 'manual-gate');
    assert.equal(report.passed, true);
  });

  it('13. a pre-aborted signal halts without running the plan or an engine', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    const controller = new AbortController();
    controller.abort();
    h.deps.signal = controller.signal;

    const report = await createPrdLoop(baseConfig({ fix: true }), h.deps).run();

    assert.equal(report.haltReason, 'aborted');
    assert.equal(h.counters.planRuns, 0);
    assert.equal(h.engineCalls.length, 0);
    assert.equal(report.modelCallsMade, 0);
  });

  it('14. a new PRD resets fixIterations to 0 instead of halting on the old ceiling', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const plan = makePlan({ fixIterations: 3, prdSource: 'OLD PRD' });
    const h = makeDeps(plan);
    h.deps.resolvePrdText = async () => 'BRAND NEW PRD';

    const report = await createPrdLoop(baseConfig({ maxFixIterations: 3 }), h.deps).run();

    assert.equal(plan.fixIterations, 0);
    assert.equal(plan.prdSource, 'BRAND NEW PRD');
    assert.notEqual(report.haltReason, 'max-iterations');
    assert.equal(report.failedGate, 'command');
  });
});

describe('createPrdLoop — reporting and isolation', () => {
  it('15. emits exactly one report, including when runPlan rejects', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('[{"name":"Fix it","prompt":"fix"}]');
    h.deps.runPlan = async () => { throw new Error('runner exploded'); };

    const report = await createPrdLoop(baseConfig({ fix: true }), h.deps).run();

    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0], report);
    assert.equal(report.haltReason, 'engine-error');
    assert.ok(report.suggestion.includes('runner exploded'));
  });

  it('15b. emits exactly one report on the happy path too', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true,"score":90,"gaps":[],"suggestion":"good"}');

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(h.reports.length, 1);
    assert.equal(report.passed, true);
    assert.equal(report.score, 90);
  });

  it('16. two concurrent controllers halt independently', async () => {
    const { createPrdLoop } = loadLoop();
    const hA = makeDeps(makePlan());
    const hB = makeDeps(makePlan());
    hA.deps.runEngine = async () => engineResult('{"passed":true,"score":80,"gaps":[],"suggestion":""}');
    hB.deps.runEngine = async () => engineResult('{"passed":true,"score":80,"gaps":[],"suggestion":""}');

    const loopA = createPrdLoop(baseConfig(), hA.deps);
    const loopB = createPrdLoop(baseConfig(), hB.deps);
    loopA.noteBudgetExceeded();

    const [reportA, reportB] = await Promise.all([loopA.run(), loopB.run()]);

    assert.equal(reportA.haltReason, 'budget-exceeded');
    assert.equal(reportB.haltReason, null);
    assert.equal(reportB.passed, true);
  });

  it('17. an empty gate list is a hard failure when unattended', async () => {
    const { createPrdLoop } = loadLoop({ gateCommands: [] });
    const h = makeDeps(makePlan());

    const report = await createPrdLoop(baseConfig({ unattended: true }), h.deps).run();

    assert.equal(report.haltReason, 'no-gates');
    assert.equal(report.passed, false);
    assert.equal(report.gateCommandsEmpty, true);
    assert.equal(report.modelCallsMade, 0);
    assert.equal(h.engineCalls.length, 0);
  });

  it('17b. an empty gate list is only a warning when interactive', async () => {
    const { createPrdLoop } = loadLoop({ gateCommands: [] });
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true,"score":70,"gaps":[],"suggestion":""}');

    const report = await createPrdLoop(baseConfig({ unattended: false }), h.deps).run();

    assert.notEqual(report.haltReason, 'no-gates');
    assert.equal(report.gateCommandsEmpty, true);
    assert.ok(h.progress.some((p) => p.phase === 'warning'), 'a warning must be surfaced');
  });
});

// ─── Browser UAT gate ───

const UAT_COMMAND = 'npx playwright test --reporter=line';

/** A prepareUat spy that hands out a session and counts its own dispose calls. */
function makeUatSpy(baseUrl = 'http://localhost:3000'): {
  state: { prepared: number; disposed: number };
  prepareUat: (signal: AbortSignal) => Promise<UatSession | null>;
} {
  const state = { prepared: 0, disposed: 0 };
  const prepareUat = async (): Promise<UatSession | null> => {
    state.prepared++;
    return {
      baseUrl,
      startedByUs: true,
      dispose: (): void => { state.disposed++; },
    };
  };
  return { state, prepareUat };
}

describe('createPrdLoop — browser UAT gate', () => {
  it('U1. required + no tooling fails deterministically without calling a model', async () => {
    const { createPrdLoop } = loadLoop({ uatCapability: NO_UAT_TOOLING });
    const h = makeDeps(makePlan());
    let engineCalled = false;
    h.deps.runEngine = async () => {
      engineCalled = true;
      return engineResult('{"passed":true,"score":100,"gaps":[],"suggestion":""}');
    };
    const uat = makeUatSpy();
    h.deps.prepareUat = uat.prepareUat;

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'command');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(engineCalled, false, 'a required UAT gate must fail before any model call');
    assert.equal(report.uatRan, false);
    assert.match(report.uatSkipReason ?? '', /playwright\.config/);
    // The failure is recorded as a real failing row — never a fabricated pass.
    const uatRow = report.gates.find((g) => g.command === '(uat)');
    assert.ok(uatRow, 'required mode must push a failing gate row');
    assert.equal(uatRow!.passed, false);
    assert.equal(uatRow!.exitCode, 1);
    assert.equal(uat.state.prepared, 0, 'no tooling means no sandbox is ever prepared');
  });

  it('U2. required + tooling but no prepareUat dep fails, citing the missing URL', async () => {
    const { createPrdLoop } = loadLoop({ uatCapability: HAS_UAT_TOOLING });
    const h = makeDeps(makePlan());
    h.deps.prepareUat = undefined;
    let engineCalled = false;
    h.deps.runEngine = async () => {
      engineCalled = true;
      return engineResult('{"passed":true,"score":100,"gaps":[],"suggestion":""}');
    };

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'command');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(engineCalled, false);
    assert.equal(report.uatRan, false);
    assert.match(report.uatSkipReason ?? '', /URL/);
    assert.ok(report.gates.some((g) => g.command === UAT_COMMAND && !g.passed));
  });

  it('U3. required + prepareUat resolving null fails with zero model calls', async () => {
    const { createPrdLoop, gateCalls } = loadLoop({ uatCapability: HAS_UAT_TOOLING });
    const h = makeDeps(makePlan());
    h.deps.prepareUat = async () => null;
    let engineCalled = false;
    h.deps.runEngine = async () => { engineCalled = true; return engineResult('{}'); };

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(report.failedGate, 'command');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(engineCalled, false);
    assert.equal(report.uatRan, false);
    assert.match(report.uatSkipReason ?? '', /URL/);
    assert.ok(!gateCalls().includes(UAT_COMMAND), 'the UAT command must never be spawned');
  });

  it('U4. auto + no tooling skips silently and lets the model decide', async () => {
    const { createPrdLoop } = loadLoop({ uatCapability: NO_UAT_TOOLING });
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true,"score":88,"gaps":[],"suggestion":"ok"}');

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'auto', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(report.passed, true, 'the verdict must follow the model, not the missing gate');
    assert.equal(report.score, 88);
    assert.equal(report.uatRan, false);
    assert.ok(report.uatSkipReason);
    assert.deepEqual(
      report.gates.map((g) => g.command),
      ['npm test'],
      'auto must push NOTHING into gates when it cannot run',
    );
    assert.ok(!report.gates.some((g) => g.command === '(uat)'), 'no fabricated passing UAT row');
    assert.ok(h.progress.some((p) => p.phase === 'warning' && /UAT/i.test(p.detail)));
  });

  it('U5. auto + tooling + a UAT exit 1 fails the loop with zero model calls', async () => {
    const { createPrdLoop, gateEnvs } = loadLoop({
      uatCapability: HAS_UAT_TOOLING,
      gateResult: (c) => (c === UAT_COMMAND
        ? FAILING_GATE(c)
        : { command: c, exitCode: 0, passed: true, output: 'ok', durationMs: 1, timedOut: false }),
    });
    const h = makeDeps(makePlan());
    let engineCalled = false;
    h.deps.runEngine = async () => { engineCalled = true; return engineResult('{}'); };
    const uat = makeUatSpy('http://localhost:4321');
    h.deps.prepareUat = uat.prepareUat;

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'auto', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'command');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(engineCalled, false);
    assert.equal(report.uatRan, true);
    assert.equal(report.uatSkipReason, null);
    assert.equal(uat.state.disposed, 1);
    // The base URL reaches all three runners the ecosystem reads.
    const env = gateEnvs()[gateEnvs().length - 1];
    assert.equal(env?.MOAG_UAT_BASE_URL, 'http://localhost:4321');
    assert.equal(env?.PLAYWRIGHT_TEST_BASE_URL, 'http://localhost:4321');
    assert.equal(env?.CYPRESS_BASE_URL, 'http://localhost:4321');
  });

  it('U6. off never invokes prepareUat', async () => {
    const { createPrdLoop, gateCalls } = loadLoop({ uatCapability: HAS_UAT_TOOLING });
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true,"score":90,"gaps":[],"suggestion":""}');
    const uat = makeUatSpy();
    h.deps.prepareUat = uat.prepareUat;

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'off', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(uat.state.prepared, 0);
    assert.equal(uat.state.disposed, 0);
    assert.equal(report.uatRan, false);
    assert.equal(report.uatSkipReason, null);
    assert.ok(!gateCalls().includes(UAT_COMMAND));
  });

  it('U7. dispose() is called exactly once when the UAT gate fails', async () => {
    const { createPrdLoop } = loadLoop({
      uatCapability: HAS_UAT_TOOLING,
      gateResult: (c) => (c === UAT_COMMAND
        ? FAILING_GATE(c)
        : { command: c, exitCode: 0, passed: true, output: 'ok', durationMs: 1, timedOut: false }),
    });
    const h = makeDeps(makePlan());
    const uat = makeUatSpy();
    h.deps.prepareUat = uat.prepareUat;

    await createPrdLoop(baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }), h.deps).run();

    assert.equal(uat.state.prepared, 1);
    assert.equal(uat.state.disposed, 1, 'the session must be disposed exactly once on failure');
  });

  it('U8. dispose() is called when runGate throws', async () => {
    const { createPrdLoop } = loadLoop({
      uatCapability: HAS_UAT_TOOLING,
      throwOnGate: UAT_COMMAND,
    });
    const h = makeDeps(makePlan());
    const uat = makeUatSpy();
    h.deps.prepareUat = uat.prepareUat;

    const controller = createPrdLoop(
      baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }),
      h.deps,
    );
    await assert.rejects(controller.run(), /runGate exploded/);

    assert.equal(uat.state.disposed, 1, 'a throwing gate must not leak the sandbox');
    assert.equal(h.reports.length, 1, 'still exactly one report on the throw path');
  });

  it('U9. dispose() is called when the signal aborts after the session is prepared', async () => {
    const { createPrdLoop, gateCalls } = loadLoop({ uatCapability: HAS_UAT_TOOLING });
    const h = makeDeps(makePlan());
    const ac = new AbortController();
    h.deps.signal = ac.signal;
    const state = { prepared: 0, disposed: 0 };
    h.deps.prepareUat = async () => {
      state.prepared++;
      ac.abort(); // the user hits Stop while the sandbox is coming up
      return {
        baseUrl: 'http://localhost:3000',
        startedByUs: true,
        dispose: (): void => { state.disposed++; },
      };
    };

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(report.haltReason, 'aborted');
    assert.equal(state.prepared, 1);
    assert.equal(state.disposed, 1, 'aborting must still dispose the session');
    assert.ok(!gateCalls().includes(UAT_COMMAND), 'an aborted signal must not spawn the gate');
  });

  it('U10. a failing repo gate never reaches prepareUat (cost control)', async () => {
    const { createPrdLoop, gateCalls } = loadLoop({
      uatCapability: HAS_UAT_TOOLING,
      gateResult: (c) => FAILING_GATE(c),
    });
    const h = makeDeps(makePlan());
    const uat = makeUatSpy();
    h.deps.prepareUat = uat.prepareUat;

    const report = await createPrdLoop(
      baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.equal(report.failedGate, 'command');
    assert.equal(uat.state.prepared, 0, 'no sandbox may start once a repo gate already failed');
    assert.equal(uat.state.disposed, 0);
    assert.ok(!gateCalls().includes(UAT_COMMAND));
    assert.equal(report.uatRan, false);
    assert.equal(report.uatSkipReason, null, 'an earlier failure is not a UAT skip');
  });

  it('U11. unattended + auto + no tooling does not produce haltReason "no-gates"', async () => {
    const { createPrdLoop } = loadLoop({ uatCapability: NO_UAT_TOOLING });
    const h = makeDeps(makePlan());
    h.deps.runEngine = async () => engineResult('{"passed":true,"score":75,"gaps":[],"suggestion":""}');

    const report = await createPrdLoop(
      baseConfig({ unattended: true, uat: { mode: 'auto', timeoutMs: 60_000 } }),
      h.deps,
    ).run();

    assert.notEqual(report.haltReason, 'no-gates');
    assert.equal(report.passed, true);
    assert.equal(report.uatRan, false);
  });

  it('U12. two concurrent loops get independent prepareUat/dispose pairs', async () => {
    const { createPrdLoop } = loadLoop({ uatCapability: HAS_UAT_TOOLING });
    const hA = makeDeps(makePlan());
    const hB = makeDeps(makePlan());
    hA.deps.runEngine = async () => engineResult('{"passed":true,"score":80,"gaps":[],"suggestion":""}');
    hB.deps.runEngine = async () => engineResult('{"passed":true,"score":80,"gaps":[],"suggestion":""}');
    const uatA = makeUatSpy('http://localhost:3001');
    const uatB = makeUatSpy('http://localhost:3002');
    hA.deps.prepareUat = uatA.prepareUat;
    hB.deps.prepareUat = uatB.prepareUat;

    const loopA = createPrdLoop(baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }), hA.deps);
    const loopB = createPrdLoop(baseConfig({ uat: { mode: 'required', timeoutMs: 60_000 } }), hB.deps);

    const [reportA, reportB] = await Promise.all([loopA.run(), loopB.run()]);

    assert.equal(reportA.uatRan, true);
    assert.equal(reportB.uatRan, true);
    assert.equal(uatA.state.prepared, 1);
    assert.equal(uatA.state.disposed, 1);
    assert.equal(uatB.state.prepared, 1);
    assert.equal(uatB.state.disposed, 1);
  });

  it('U13. uatRan/uatSkipReason are present and typed on the no-prd early return', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    h.deps.resolvePrdText = async () => null;

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.haltReason, 'no-prd');
    assert.equal(typeof report.uatRan, 'boolean');
    assert.equal(report.uatRan, false);
    assert.equal(report.uatSkipReason, null);
  });

  it('U14. uatRan/uatSkipReason are present and typed on the aborted early return', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());
    const ac = new AbortController();
    ac.abort();
    h.deps.signal = ac.signal;

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.haltReason, 'aborted');
    assert.equal(typeof report.uatRan, 'boolean');
    assert.equal(report.uatRan, false);
    assert.equal(report.uatSkipReason, null);
  });
});
