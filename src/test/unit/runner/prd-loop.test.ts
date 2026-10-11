// ─── PRD loop — deterministic gates must fail without ever calling a model ───

import { strict as assert } from 'assert';
import { EngineResult, Plan, TaskStatus } from '../../../models/types';
import { requirementStatuses, stampRelease } from '../../../models/requirement-trace';
import type {
  PrdLoopConfig,
  PrdLoopController,
  PrdLoopDeps,
  PrdLoopReport,
  UatSession,
} from '../../../runner/prd-loop';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { builtInProfile } from '../../../standards/built-in-profiles';
import { templateDesign } from '../../../standards/design';
import { withoutApprovedDesign } from '../../../runner/evidence';
import type { StandardsCheckInput } from '../../../standards/checker';
import type { StandardsProfile } from '../../../standards/profile';

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
  /** One entry per collectStandardsInput call; the last entry repeats. */
  standardsInputs?: StandardsCheckInput[];
  /** When given, './knowledge' is stubbed and every recorded fact's `provenBy` lands here. */
  facts?: string[];
  /** When given, './dependency-install' is stubbed with this ensureDependencies. */
  ensureDeps?: (cwd: string, o: { stage: string; onEvent: (ev: unknown) => void; signal: AbortSignal }) => Promise<unknown>;
}

interface LoopHarness {
  createPrdLoop: (cfg: PrdLoopConfig, deps: PrdLoopDeps) => PrdLoopController;
  diffCalls: () => number;
  gateCalls: () => string[];
  gateEnvs: () => Array<Record<string, string> | undefined>;
  /** Arguments of every collectStandardsInput call, in order. */
  standardsCalls: () => Array<{ cwd: string; baseRef: string | null; probeDirs: string[] }>;
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
  const standardsCalls: Array<{ cwd: string; baseRef: string | null; probeDirs: string[] }> = [];
  const sequence = opts.changedFilesSequence ?? [['src/a.ts']];

  const evidenceStub = {
    captureBaseRef: async () => (opts.baseRef === undefined ? 'base-ref' : opts.baseRef),
    captureHeadRef: async () => 'head-ref',
    collectStandardsInput: async (cwd: string, baseRef: string | null, o: { probeDirs?: string[] }) => {
      const inputs = opts.standardsInputs ?? [];
      const input = inputs[Math.min(standardsCalls.length, inputs.length - 1)];
      standardsCalls.push({ cwd, baseRef, probeDirs: o?.probeDirs ?? [] });
      return input ?? { baseRef: null, files: [], existingDirs: [], topLevel: [], goModulePath: null };
    },
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
    // The real filter: it only reads the two design files under cfg.cwd.
    withoutApprovedDesign,
  };

  const stubs: Record<string, unknown> = { './evidence': evidenceStub };
  if (opts.facts) {
    const facts = opts.facts;
    stubs['./knowledge'] = {
      commandFactId: (kind: string, command: string) => `${kind}:${command}`,
      recordFact: (_cwd: string, fact: { provenBy: string }) => { facts.push(fact.provenBy); return true; },
    };
  }
  if (opts.ensureDeps) {
    stubs['./dependency-install'] = { ensureDependencies: opts.ensureDeps };
  }
  const mod = proxyquire('../../../runner/prd-loop', stubs);
  return {
    createPrdLoop: mod.createPrdLoop,
    diffCalls: () => diffCall,
    gateCalls: () => gateCalls,
    gateEnvs: () => gateEnvs,
    standardsCalls: () => standardsCalls,
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
    versionBudgetUsd: 0,
    standards: null,
    dependencies: { enabled: false, ignoreScripts: false, pythonVenv: null },
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
  /** Every dependency-install event the loop forwarded. */
  dependencyEvents: unknown[];
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
  const dependencyEvents: unknown[] = [];

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
    onDependencyEvent: (ev) => { dependencyEvents.push(ev); },
    signal: new AbortController().signal,
    ...over,
  };
  return { deps, engineCalls, reports, progress, skipped, counters, dependencyEvents };
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

  it('1b. only the approved design files the server wrote at run start changed: the change gate still fails', async () => {
    const design = templateDesign('static-web', '')!;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-prd-design-'));
    try {
      fs.mkdirSync(path.join(cwd, 'docs', 'design'), { recursive: true });
      fs.mkdirSync(path.join(cwd, 'css'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'docs', 'design', 'DESIGN.md'), design.doc.replace(/\n/g, '\r\n'));
      fs.writeFileSync(path.join(cwd, 'css', 'tokens.css'), design.tokens);
      const p = builtInProfile('other');
      p.commands = [];
      p.design = design;
      const cfg = baseConfig({ cwd, standards: { profile: p, version: 1, baseRef: 'head-ref' } });

      const { createPrdLoop } = loadLoop({ changedFilesSequence: [[design.docPath, design.tokensPath]] });
      const h = makeDeps(makePlan());
      let engineCalled = false;
      h.deps.runEngine = async () => { engineCalled = true; return engineResult('{"passed":true,"score":100,"gaps":[],"suggestion":""}'); };
      const report = await createPrdLoop(cfg, h.deps).run();
      assert.equal(report.passed, false);
      assert.equal(report.failedGate, 'change', 'MOAG\'s own write is not work');
      assert.equal(report.modelCallsMade, 0);
      assert.equal(engineCalled, false);

      // A run that did edit a design file changed something (the design rule then reports it).
      fs.writeFileSync(path.join(cwd, 'css', 'tokens.css'), ':root { --x: 1px; }\n');
      const edited = await loadLoop({ changedFilesSequence: [[design.docPath, design.tokensPath]] })
        .createPrdLoop(cfg, makeDeps(makePlan()).deps).run();
      assert.notEqual(edited.failedGate, 'change');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
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

// ─── The generated fix playlist carries an explicit role ───

describe('createPrdLoop — fix playlist role', () => {
  it('R1. a generated fix playlist runs as engineer', async () => {
    const { createPrdLoop } = loadLoop({
      gateResult: (c) => FAILING_GATE(c),
      changedFilesSequence: [['a.ts'], ['b.ts']],
    });
    const plan = makePlan();
    const h = makeDeps(plan);
    h.deps.runEngine = async () => engineResult('[{"name":"Fix it","prompt":"fix"}]');

    await createPrdLoop(baseConfig({ fix: true, maxFixIterations: 1 }), h.deps).run();

    const fixPlaylists = plan.playlists.filter((pl) => pl.name.startsWith('Fix — Iteration'));
    assert.equal(fixPlaylists.length, 1);
    assert.equal(fixPlaylists[0].role, 'engineer', 'repair work, not review');
    // The tasks themselves stay role-free so they inherit the playlist role.
    assert.equal(fixPlaylists[0].tasks[0].role, undefined);
  });

  it('R2. verification-only mode pushes no playlist at all', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const plan = makePlan();
    const before = plan.playlists.length;
    const h = makeDeps(plan);

    const report = await createPrdLoop(baseConfig({ fix: false }), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(plan.playlists.length, before, 'fix:false must never mutate the plan');
    assert.equal(plan.playlists.filter((pl) => pl.name.startsWith('Fix — Iteration')).length, 0);
  });

  it('R3. an engine that returns no fix tasks halts without mutating the plan', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const plan = makePlan();
    const before = plan.playlists.length;
    const h = makeDeps(plan);
    h.deps.runEngine = async () => engineResult('[]');

    const report = await createPrdLoop(baseConfig({ fix: true, maxFixIterations: 3 }), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.haltReason, 'engine-error');
    assert.equal(plan.playlists.length, before);
    assert.equal(plan.fixIterations ?? 0, 0);
  });
});

// ─── Requirement trace evidence (F3.3) ───

describe('createPrdLoop — requirement trace evidence', () => {
  function tracedPlan(): Plan {
    const plan = makePlan({
      prdVersions: [{ version: '1.0.0', text: '## Requirements\n- [R-1] login', createdAt: '2026-10-01T00:00:00.000Z' }],
    });
    plan.playlists[0].tasks[0].requirementIds = ['R-1'];
    return plan;
  }

  const PASS_VERDICT = '{"passed":true,"score":100,"gaps":[],"suggestion":""}';

  it('a failing gate is recorded with its real exit code and a "pass" model verdict cannot ship it', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const plan = tracedPlan();
    const h = makeDeps(plan, { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.modelCallsMade, 0);
    assert.equal(report.passed, false);
    const rec = plan.requirementTrace?.find((r) => r.id === 'R-1');
    assert.ok(rec, 'R-1 must have a trace record');
    assert.deepEqual(rec.gates.map((g) => [g.command, g.exitCode, g.timedOut]), [['npm test', 1, false]]);
    assert.deepEqual(rec.taskIds, ['t-1']);
    assert.ok(h.counters.saves > 0, 'the recorded evidence is persisted');

    const status = () => requirementStatuses(plan).find((r) => r.id === 'R-1')?.status;
    assert.notEqual(status(), 'shipped');
    assert.deepEqual(stampRelease(plan, 'v1.0.0', '2026-10-04T00:00:00.000Z').shipped, []);
    assert.notEqual(status(), 'shipped');
  });

  it('a passing gate is recorded as exit 0 even when the model verdict is "not passed"', async () => {
    const { createPrdLoop } = loadLoop();
    const plan = tracedPlan();
    const h = makeDeps(plan);

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.passed, false, 'the stub model says not passed');
    assert.equal(report.modelCallsMade, 1);
    const rec = plan.requirementTrace?.find((r) => r.id === 'R-1');
    assert.ok(rec);
    assert.deepEqual(rec.gates.map((g) => g.exitCode), [0]);
  });

  it('a status-gate failure (no gate ran) leaves the trace unchanged', async () => {
    const { createPrdLoop } = loadLoop();
    const plan = tracedPlan();
    plan.playlists[0].tasks[0].status = TaskStatus.Failed;
    const h = makeDeps(plan);

    const report = await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(report.failedGate, 'status');
    assert.equal(plan.requirementTrace, undefined);
  });

  it('untagged tasks record nothing and do not trigger an extra save', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const plan = makePlan();
    const h = makeDeps(plan);

    await createPrdLoop(baseConfig(), h.deps).run();

    assert.equal(plan.requirementTrace, undefined);
  });
});

// ─── Standards gate ───

describe('createPrdLoop — standards gate', () => {
  const PASS_VERDICT = '{"passed":true,"score":100,"gaps":[],"suggestion":""}';

  /**
   * A profile with one lint command and the default comment policy; nothing else configured.
   * The placeholder-phrase scan is PROMOTED to blocking: it is advisory by default, and most
   * of this block is about what a blocking static rule does to the loop. `defaults()` is the
   * same profile as a project gets it, with nothing promoted.
   */
  function profile(commands: Array<{ label: string; run: string }> = [{ label: 'Lint', run: 'npm run lint' }]): StandardsProfile {
    const p = defaults(commands);
    p.severity = { 'comment-policy/banned-phrase': 'blocking' };
    return p;
  }

  function defaults(commands: Array<{ label: string; run: string }> = [{ label: 'Lint', run: 'npm run lint' }]): StandardsProfile {
    const p = builtInProfile('other');
    p.commands = commands;
    return p;
  }

  function withStandards(p: StandardsProfile = profile(), version: number | null = 3): Partial<PrdLoopConfig> {
    return { standards: { profile: p, version, baseRef: 'head-ref' } };
  }

  /** What the collector reports: one changed file whose every line was added. */
  function diffOf(lines: string[], file = 'src/a.ts'): StandardsCheckInput {
    return {
      baseRef: 'head-ref',
      files: [{ path: file, status: 'added', addedLines: lines.map((_, i) => i + 1), content: lines.join('\n') }],
      existingDirs: [],
      topLevel: ['src'],
      goModulePath: null,
    };
  }

  const CLEAN = diffOf(['export const a = 1;', '// Explains the constant.']);
  // A placeholder comment: under `profile()` the phrase rule is blocking, so this is what fails the gate.
  const ONE_FINDING = diffOf(['export const a = 1;', '// ... rest of the code ...']);
  const TWO_FINDINGS = diffOf(['export const a = 1;', '// ... rest of the code ...', 'export const b = 2;', '// your code here']);
  // Commented-out code: a heuristic, so advisory — reported, never a reason to stop.
  const ADVISORY_ONLY = diffOf(['export const a = 1;', '// oldCall(a);']);
  const NO_DIFF: StandardsCheckInput = { baseRef: null, files: [], existingDirs: [], topLevel: [], goModulePath: null };

  it('S1. a failing static rule fails the standards gate with zero model calls and runs no repo gate', async () => {
    const loop = loadLoop({ standardsInputs: [ONE_FINDING] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'standards');
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(loop.gateCalls(), [], 'neither the repo gates nor the profile commands may run');
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode, g.passed]), [['moag:standards v3', 1, false]]);
    assert.ok(report.standards);
    assert.equal(report.standards.version, 3);
    assert.deepEqual(report.standards.findings.map((f) => [f.file, f.line, f.rule, f.severity]),
      [['src/a.ts', 2, 'comment-policy/banned-phrase', 'blocking']]);
    const command = report.standards.rules[report.standards.rules.length - 1];
    assert.deepEqual(command, { rule: 'command', severity: 'blocking', result: 'not-checked', reason: 'A standards rule failed first', command: 'npm run lint' });
    // A scanner rule has "findings"; it is never said to have failed.
    assert.match(report.suggestion,
      /^Project standards stop this release: comment-policy\/banned-phrase \(findings\) — 1 blocking finding; 0 advisory findings, \d+ rules? not checked, 0 files not checked\.\nBlocking — these must be fixed:\n- src\/a\.ts:2 comment-policy\/banned-phrase/);
    assert.match(report.suggestion, /Promoted to blocking: comment-policy\/banned-phrase\. Scanner rules are heuristic/);
    assert.ok(h.progress.some((p) => p.phase === 'warning' && /comment-policy\/banned-phrase can stop this release\. Scanner rules are heuristic/.test(p.detail)));
    assert.deepEqual(loop.standardsCalls(), [{ cwd: '/repo', baseRef: 'head-ref', probeDirs: [] }]);
    assert.ok(h.progress.some((p) => p.phase === 'standards'));
    assert.ok(!h.progress.some((p) => p.phase === 'gate'), 'no repo gate was announced');
  });

  it('S2. a failing profile command fails the standards gate after the repo gates ran', async () => {
    const loop = loadLoop({
      standardsInputs: [CLEAN],
      gateResult: (c) => (c === 'npm run lint' ? FAILING_GATE(c) : { command: c, exitCode: 0, passed: true, output: 'ok', durationMs: 1, timedOut: false }),
    });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });
    const p = profile([{ label: 'Lint', run: 'npm run lint' }, { label: 'Format', run: 'npm run format:check' }]);

    const report = await loop.createPrdLoop(baseConfig(withStandards(p)), h.deps).run();

    assert.equal(report.failedGate, 'standards');
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(loop.gateCalls(), ['npm test', 'npm run lint'], 'repo gate first, then the profile command; the second never ran');
    // No passing moag:standards row: a command of the blocking set failed, and another never ran.
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['npm test', 0], ['npm run lint', 1]]);
    const rows = report.standards!.rules.filter((r) => r.rule === 'command');
    assert.deepEqual(rows, [
      { rule: 'command', severity: 'blocking', result: 'failed', command: 'npm run lint', exitCode: 1, tail: 'AssertionError: expected true to equal false' },
      { rule: 'command', severity: 'blocking', result: 'not-checked', reason: 'An earlier standards command failed', command: 'npm run format:check' },
    ]);
    assert.equal(report.standards!.totals.failed, 1);
    assert.match(report.suggestion, /Standards command failed: npm run lint\nExit code: 1/);
    assert.deepEqual(h.progress.filter((p) => p.phase === 'standards-command').map((p) => p.detail), ['npm run lint']);
  });

  it('S3. with no diff and nothing blocking configured, the row says "no blocking rules configured" and the model is still reached', async () => {
    // No base was recorded (a workspace that is not a repository), and no diff could be taken.
    const loop = loadLoop({ standardsInputs: [NO_DIFF] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig({ standards: { profile: defaults([]), version: 3, baseRef: null } }), h.deps).run();

    assert.equal(report.passed, true);
    assert.equal(report.modelCallsMade, 1);
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 0], ['npm test', 0]]);
    assert.match(report.gates[0].output, /^Project standards: no blocking rules configured \(/);
    assert.doesNotMatch(report.gates[0].output, /passed/i, 'never called a pass');
    assert.equal(report.gates[0].standardsCounts?.noBlockingRules, true);
    assert.ok(report.standards);
    assert.ok(report.standards.rules.every((r) => r.result === 'not-checked'));
    assert.equal(report.standards.totals.passed, 0, 'not-checked is never counted as passed');
    assert.ok(!h.progress.some((p) => p.phase === 'warning' && /standards base/.test(p.detail)));
  });

  it('S3a. with no diff, a promoted rule was not checked: that stops the release, with no model call', async () => {
    const loop = loadLoop({ standardsInputs: [NO_DIFF] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig({ standards: { profile: profile([]), version: 3, baseRef: null } }), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'standards');
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode, g.passed]), [['moag:standards v3', 1, false], ['npm test', 0, true]]);
    assert.match(report.suggestion, /^Project standards could not be checked: 1 blocking rule was not checked\.\n- comment-policy\/banned-phrase — No diff could be taken/);
    assert.equal(report.standards!.totals.blockingNotChecked, 1);
  });

  it('S3c. a RECORDED base against which no diff could be taken fails closed: standards gate, exit-1 row, no model call', async () => {
    const loop = loadLoop({ standardsInputs: [NO_DIFF] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'standards');
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(loop.gateCalls(), [], 'neither the repo gates nor the profile commands may run');
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode, g.passed]), [['moag:standards v3', 1, false]]);
    assert.match(report.suggestion, /no diff could be taken against the recorded base head-ref/);
    assert.ok(report.standards);
    assert.equal(report.standards.totals.passed, 0);
    assert.deepEqual(report.standards.rules[report.standards.rules.length - 1],
      { rule: 'command', severity: 'blocking', result: 'not-checked', reason: 'The standards base could not be used', command: 'npm run lint' });
  });

  it('S3d. a recorded base the repository has lost is checked against the empty tree: violations fail the gate, and the loop says why', async () => {
    // What the collector returns when the base commit was pruned: every file, as added.
    const fallback: StandardsCheckInput = { ...ONE_FINDING, baseRef: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', topLevel: [] };
    const loop = loadLoop({ standardsInputs: [fallback] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.passed, false);
    assert.equal(report.failedGate, 'standards');
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 1]]);
    assert.equal(report.standards!.baseRef, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'the report states the base actually used');
    assert.ok(h.progress.some((p) => p.phase === 'warning' && /standards base head-ref is not in this repository any more/.test(p.detail)));
  });

  it('S3b. an empty diff under a promoted rule pushes no exit-0 row: nothing was judged, so the release stops', async () => {
    // The work was committed and the base is the new HEAD: the diff is empty, nothing was judged.
    const empty: StandardsCheckInput = { baseRef: 'head-ref', files: [], existingDirs: ['src'], topLevel: ['src'], goModulePath: null };
    const loop = loadLoop({ standardsInputs: [empty] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });
    const p = profile([]);
    p.structure.requiredDirs = ['src'];

    const report = await loop.createPrdLoop(baseConfig(withStandards(p)), h.deps).run();

    assert.equal(report.failedGate, 'standards');
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 1], ['npm test', 0]], 'never an exit-0 standards row');
    assert.match(report.suggestion, /comment-policy\/banned-phrase — The diff holds nothing for this rule to check/);
    assert.ok(report.standards);
    // The two rules that read the tree itself were still decided; they are advisory and vouch for nothing.
    assert.deepEqual(report.standards.rules.filter((r) => r.result === 'passed').map((r) => r.rule), ['structure/required-dirs', 'structure/nested-repository']);
    assert.ok(report.standards.rules.filter((r) => r.rule.startsWith('comment-policy/')).every((r) => r.result === 'not-checked'));
  });

  it('S4. standards: null behaves exactly as before: no collection, no row, no report', async () => {
    const loop = loadLoop();
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig({ standards: null }), h.deps).run();

    assert.equal(report.passed, true);
    assert.equal(report.standards, null);
    assert.deepEqual(loop.standardsCalls(), []);
    assert.deepEqual(report.gates.map((g) => g.command), ['npm test']);
    assert.ok(!h.progress.some((p) => p.phase.startsWith('standards')));
  });

  it('S5. a profile command equal to a repo gate runs once and its result is reused', async () => {
    const loop = loadLoop({ standardsInputs: [CLEAN], gateCommands: ['npm run lint', 'npm test'] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.passed, true);
    assert.deepEqual(loop.gateCalls(), ['npm run lint', 'npm test']);
    assert.deepEqual(report.gates.map((g) => g.command), ['moag:standards v3', 'npm run lint', 'npm test']);
    assert.deepEqual(report.standards!.rules.filter((r) => r.rule === 'command'),
      [{ rule: 'command', severity: 'blocking', result: 'passed', command: 'npm run lint', exitCode: 0, tail: 'ok' }]);
  });

  it('S6. a passing check pushes an exit-0 row, runs the commands and lets the model decide', async () => {
    const loop = loadLoop({ standardsInputs: [CLEAN] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.passed, true);
    assert.equal(report.failedGate, null);
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 0], ['npm test', 0], ['npm run lint', 0]]);
    assert.equal(report.standards!.totals.failed, 0);
    assert.deepEqual(report.standards!.findings, []);
    assert.equal(h.reports.length, 1);
    assert.deepEqual(h.reports[0].standards, report.standards, 'the emitted report carries the standards results');
  });

  it('S7. a failed status gate reports every rule and command not-checked with that reason, without collecting', async () => {
    const loop = loadLoop({ standardsInputs: [ONE_FINDING] });
    const plan = makePlan();
    plan.playlists[0].tasks[0].status = TaskStatus.Failed;
    const h = makeDeps(plan);

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.failedGate, 'status');
    assert.deepEqual(loop.standardsCalls(), []);
    assert.ok(report.standards);
    assert.ok(report.standards.rules.length > 1);
    assert.ok(report.standards.rules.every((r) => r.result === 'not-checked' && r.reason === 'The status gate failed first'));
    assert.deepEqual(report.gates, []);
  });

  it('S8. a failed change gate skips the standards gate the same way', async () => {
    const loop = loadLoop({ changedFilesSequence: [[]], standardsInputs: [ONE_FINDING] });
    const h = makeDeps(makePlan());

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.failedGate, 'change');
    assert.deepEqual(loop.standardsCalls(), []);
    assert.ok(report.standards!.rules.every((r) => r.reason === 'The change gate failed first'));
  });

  it('S9. a failed repo gate leaves the profile commands not-checked and stays a command failure', async () => {
    const loop = loadLoop({ standardsInputs: [CLEAN], gateResult: (c) => FAILING_GATE(c) });
    const h = makeDeps(makePlan());

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.failedGate, 'command');
    assert.deepEqual(loop.gateCalls(), ['npm test']);
    assert.deepEqual(report.standards!.rules.filter((r) => r.rule === 'command'),
      [{ rule: 'command', severity: 'blocking', result: 'not-checked', reason: 'The command gate failed first', command: 'npm run lint' }]);
    // The static rules found nothing, but the profile command never ran: the blocking set was
    // not evaluated, so no row says "checked against standards v3".
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['npm test', 1]]);
  });

  describe('dependency installs before the gates', () => {
    const FAILED_INSTALL = {
      event: 'dependencies-install-failed', stage: 'verify', ecosystem: 'npm', dir: '.', trigger: 'manifest-changed',
      command: 'npm ci --no-audit --no-fund', durationMs: 1500, exitCode: 1, timedOut: false, tail: 'npm ERR! ERESOLVE', note: null,
    };

    it('a failed install fails the command gate with no model call and no gate run', async () => {
      const loop = loadLoop({
        standardsInputs: [CLEAN],
        ensureDeps: async (_cwd, o) => {
          o.onEvent(FAILED_INSTALL);
          return { ok: false, aborted: false, failed: FAILED_INSTALL, events: [FAILED_INSTALL] };
        },
      });
      const h = makeDeps(makePlan());
      const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

      assert.equal(report.failedGate, 'command');
      assert.equal(report.passed, false);
      assert.equal(report.modelCallsMade, 0);
      assert.deepEqual(loop.gateCalls(), [], 'no gate command ran without its dependencies');
      assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode, g.passed, g.output]),
        [['npm ci --no-audit --no-fund', 1, false, 'npm ERR! ERESOLVE']]);
      assert.deepEqual(report.standards!.rules.filter((r) => r.rule === 'command').map((r) => [r.result, r.reason]),
        [['not-checked', 'The command gate failed first']]);
      assert.deepEqual(h.dependencyEvents, [FAILED_INSTALL]);
    });

    it('an abort during the install halts as aborted', async () => {
      const loop = loadLoop({ ensureDeps: async () => ({ ok: false, aborted: true, failed: null, events: [] }) });
      const h = makeDeps(makePlan());
      const report = await loop.createPrdLoop(baseConfig(), h.deps).run();
      assert.equal(report.haltReason, 'aborted');
      assert.deepEqual(loop.gateCalls(), []);
    });

    it('a successful install forwards its events and the gates run', async () => {
      const installed = { ...FAILED_INSTALL, event: 'dependencies-installed', exitCode: 0 };
      const calls: Array<{ stage: string }> = [];
      const loop = loadLoop({
        ensureDeps: async (_cwd, o) => {
          calls.push(o);
          o.onEvent(installed);
          return { ok: true, aborted: false, failed: null, events: [installed] };
        },
      });
      const h = makeDeps(makePlan());
      await loop.createPrdLoop(baseConfig(), h.deps).run();
      assert.deepEqual(loop.gateCalls(), ['npm test']);
      assert.equal(calls.length >= 1, true);
      assert.equal(calls[0].stage, 'verify');
      assert.deepEqual(h.dependencyEvents[0], installed);
    });

    it('no gates, no standards commands and UAT off means no install call', async () => {
      let called = 0;
      const loop = loadLoop({
        gateCommands: [],
        ensureDeps: async () => { called++; return { ok: true, aborted: false, failed: null, events: [] }; },
      });
      const h = makeDeps(makePlan());
      await loop.createPrdLoop(baseConfig(), h.deps).run();
      assert.equal(called, 0);
    });
  });

  it('S10. a null version names the row without a version', async () => {
    const loop = loadLoop({ standardsInputs: [ONE_FINDING] });
    const h = makeDeps(makePlan());

    const report = await loop.createPrdLoop(baseConfig(withStandards(profile([]), null)), h.deps).run();

    assert.deepEqual(report.gates.map((g) => g.command), ['moag:standards']);
    assert.equal(report.standards!.version, null);
  });

  it('S11. the failing standards row is recorded on the requirement trace and blocks a release', async () => {
    const loop = loadLoop({ standardsInputs: [ONE_FINDING] });
    const plan = makePlan({
      prdVersions: [{ version: '1.0.0', text: '## Requirements\n- [R-1] login', createdAt: '2026-10-01T00:00:00.000Z' }],
    });
    plan.playlists[0].tasks[0].requirementIds = ['R-1'];
    const h = makeDeps(plan, { runEngine: async () => engineResult(PASS_VERDICT) });

    await loop.createPrdLoop(baseConfig(withStandards(profile([]))), h.deps).run();

    const rec = plan.requirementTrace?.find((r) => r.id === 'R-1');
    assert.ok(rec, 'R-1 must have a trace record');
    assert.deepEqual(rec.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 1]]);
    assert.deepEqual(stampRelease(plan, 'v1.0.0', '2026-10-04T00:00:00.000Z').shipped, []);
    assert.notEqual(requirementStatuses(plan).find((r) => r.id === 'R-1')?.status, 'shipped');
  });

  it('S12. the synthetic row is never learned as a command fact; real profile commands are', async () => {
    const facts: string[] = [];
    const loop = loadLoop({ standardsInputs: [CLEAN], facts });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.deepEqual(facts, ['npm test -> exit 0', 'npm run lint -> exit 0']);
  });

  it('S13. with --fix, the fix prompt names the standards gate and carries the findings', async () => {
    const loop = loadLoop({ standardsInputs: [ONE_FINDING, CLEAN] });
    const h = makeDeps(makePlan());
    const prompts: string[] = [];
    h.deps.runEngine = async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? engineResult('[{"name":"Finish the function","prompt":"Replace the placeholder comment in src/a.ts with the real code"}]')
        : engineResult(PASS_VERDICT);
    };

    const report = await loop.createPrdLoop(baseConfig({ ...withStandards(profile([])), fix: true }), h.deps).run();

    assert.match(prompts[0], /^A deterministic standards gate failed during PRD verification\./);
    assert.match(prompts[0], /src\/a\.ts:2 comment-policy\/banned-phrase/);
    assert.equal(report.passed, true, 'the second iteration re-checked and found nothing');
    assert.equal(report.iterations, 2);
    assert.equal(loop.standardsCalls().length, 2);
    assert.equal(report.modelCallsMade, 2, 'one fix-generation call, one verdict');
  });

  it('S14. a shrinking finding list is progress; an identical one halts as no-progress', async () => {
    const fixTasks = '[{"name":"Fix","prompt":"fix it"}]';

    const shrinking = loadLoop({ standardsInputs: [TWO_FINDINGS, ONE_FINDING, ONE_FINDING] });
    const h1 = makeDeps(makePlan(), { runEngine: async () => engineResult(fixTasks) });
    const r1 = await shrinking.createPrdLoop(baseConfig({ ...withStandards(profile([])), fix: true, maxFixIterations: 5 }), h1.deps).run();
    assert.equal(r1.haltReason, 'no-progress');
    assert.equal(r1.iterations, 3, 'two findings then one is progress; one then one is not');
    assert.equal(r1.failedGate, 'standards');

    const stuck = loadLoop({ standardsInputs: [ONE_FINDING] });
    const h2 = makeDeps(makePlan(), { runEngine: async () => engineResult(fixTasks) });
    const r2 = await stuck.createPrdLoop(baseConfig({ ...withStandards(profile([])), fix: true, maxFixIterations: 5 }), h2.deps).run();
    assert.equal(r2.haltReason, 'no-progress');
    assert.equal(r2.iterations, 2);
  });

  it('S15. an abort before the check returns aborted without collecting or running anything', async () => {
    const loop = loadLoop({ standardsInputs: [ONE_FINDING] });
    const abort = new AbortController();
    abort.abort();
    const h = makeDeps(makePlan(), { signal: abort.signal });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.haltReason, 'aborted');
    assert.deepEqual(loop.standardsCalls(), []);
    assert.deepEqual(loop.gateCalls(), []);
  });

  it('S16. an abort between the static check and the profile commands stops before running them', async () => {
    const abort = new AbortController();
    const loop = loadLoop({
      standardsInputs: [CLEAN],
      gateResult: (c) => { abort.abort(); return { command: c, exitCode: 0, passed: true, output: 'ok', durationMs: 1, timedOut: false }; },
    });
    const h = makeDeps(makePlan(), { signal: abort.signal });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.haltReason, 'aborted');
    assert.deepEqual(loop.gateCalls(), ['npm test'], 'the profile command never started');
    assert.equal(report.modelCallsMade, 0);
  });

  it('S17. unattended with no repo gate still reports the standards results it gathered', async () => {
    const loop = loadLoop({ standardsInputs: [CLEAN], gateCommands: [] });
    const h = makeDeps(makePlan());

    const report = await loop.createPrdLoop(baseConfig({ ...withStandards(), unattended: true }), h.deps).run();

    assert.equal(report.haltReason, 'no-gates');
    assert.deepEqual(loop.gateCalls(), []);
    assert.ok(report.standards);
    assert.deepEqual(report.standards.rules.filter((r) => r.rule === 'command').map((r) => r.result), ['not-checked']);
  });

  it('S18. two loops keep their standards results apart', async () => {
    const failing = loadLoop({ standardsInputs: [ONE_FINDING] });
    const clean = loadLoop({ standardsInputs: [CLEAN] });
    const a = failing.createPrdLoop(baseConfig(withStandards(profile([]))), makeDeps(makePlan()).deps);
    const b = clean.createPrdLoop(baseConfig(withStandards(profile([]))), makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) }).deps);

    const [ra, rb] = await Promise.all([a.run(), b.run()]);

    assert.equal(ra.failedGate, 'standards');
    assert.equal(rb.passed, true);
    assert.equal(ra.standards!.findings.length, 1);
    assert.equal(rb.standards!.findings.length, 0);
  });

  it('S19. an advisory failure is reported with file, line and rule — and blocks nothing: commands run, the model decides', async () => {
    const loop = loadLoop({ standardsInputs: [ADVISORY_ONLY] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards()), h.deps).run();

    assert.equal(report.passed, true);
    assert.equal(report.failedGate, null);
    assert.equal(report.modelCallsMade, 1);
    assert.deepEqual(loop.gateCalls(), ['npm test', 'npm run lint'], 'an advisory finding is no reason to skip the commands');
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode, g.passed]),
      [['moag:standards v3', 0, true], ['npm test', 0, true], ['npm run lint', 0, true]]);
    assert.ok(report.standards);
    assert.deepEqual(report.standards.findings.map((f) => [f.file, f.line, f.rule, f.severity]),
      [['src/a.ts', 2, 'comment-policy/commented-out-code', 'advisory']]);
    const row = report.standards.rules.find((r) => r.rule === 'comment-policy/commented-out-code');
    assert.deepEqual([row?.result, row?.severity], ['failed', 'advisory']);
    assert.deepEqual([report.standards.totals.failed, report.standards.totals.advisory, report.standards.totals.findings], [0, 1, 1]);
    // The reviewer and the approver read it in the gate row, set apart from anything blocking.
    assert.match(report.gates[0].output,
      /^Project standards: nothing blocking \(1 advisory finding, \d+ rules? not checked, 0 files not checked\)\.\nAdvisory — reported by a heuristic scan, not blocking:\n- src\/a\.ts:2 comment-policy\/commented-out-code/);
    assert.doesNotMatch(report.gates[0].output, /\bpassed\b/i, 'a scan is never said to have passed');
    assert.doesNotMatch(report.gates[0].output, /Blocking — these must be fixed/);
  });

  it('S20. the same finding blocks once the profile promotes its rule, and stops blocking again when a blocking rule is demoted', async () => {
    const promoted = profile([]);
    promoted.severity = { 'comment-policy/commented-out-code': 'blocking' };
    const strict = loadLoop({ standardsInputs: [ADVISORY_ONLY] });
    const blocked = await strict.createPrdLoop(baseConfig(withStandards(promoted)), makeDeps(makePlan()).deps).run();
    assert.equal(blocked.failedGate, 'standards');
    assert.equal(blocked.modelCallsMade, 0);
    assert.deepEqual(blocked.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 1]]);
    assert.equal(blocked.standards!.findings[0].severity, 'blocking');

    const demoted = profile([]);
    demoted.severity = { 'comment-policy/banned-phrase': 'advisory' };
    const lenient = loadLoop({ standardsInputs: [ONE_FINDING] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });
    const passed = await lenient.createPrdLoop(baseConfig(withStandards(demoted)), h.deps).run();
    assert.equal(passed.passed, true);
    assert.deepEqual(passed.standards!.findings.map((f) => [f.rule, f.severity]), [['comment-policy/banned-phrase', 'advisory']]);
  });

  it('S21. blocking and advisory findings are listed apart, and only the blocking ones are what a fix must change', async () => {
    const mixed = diffOf(['export const a = 1;', '// oldCall(a);', '// ... rest of the code ...']);
    const stillAdvisory = diffOf(['export const a = 1;', '// oldCall(a);']);
    const loop = loadLoop({ standardsInputs: [mixed, stillAdvisory] });
    const prompts: string[] = [];
    const h = makeDeps(makePlan());
    h.deps.runEngine = async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1 ? engineResult('[{"name":"Fix","prompt":"fix it"}]') : engineResult(PASS_VERDICT);
    };

    const report = await loop.createPrdLoop(baseConfig({ ...withStandards(profile([])), fix: true }), h.deps).run();

    assert.match(prompts[0], /Project standards stop this release: comment-policy\/banned-phrase \(findings\) — 1 blocking finding; 1 advisory finding, /);
    assert.match(prompts[0], /Blocking — these must be fixed:\n- src\/a\.ts:3 comment-policy\/banned-phrase/);
    assert.match(prompts[0], /Advisory — reported by a heuristic scan, not blocking:\n- src\/a\.ts:2 comment-policy\/commented-out-code/);
    // The placeholder is gone; the advisory finding is still there, and the run passes.
    assert.equal(report.passed, true);
    assert.equal(report.iterations, 2);
    assert.equal(report.standards!.totals.advisory, 1);
  });

  it('S22. a blocking rule that could not read a changed file is said out loud and stops the release: not a pass, never silent', async () => {
    const unread: StandardsCheckInput = {
      baseRef: 'head-ref', existingDirs: [], topLevel: ['src'], goModulePath: null,
      files: [
        { path: 'src/a.ts', status: 'added', addedLines: [1], content: 'export const a = 1;' },
        { path: 'src/big.ts', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' },
      ],
    };
    const loop = loadLoop({ standardsInputs: [unread] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards(profile([]))), h.deps).run();

    const row = report.standards!.rules.find((r) => r.rule === 'comment-policy/banned-phrase');
    assert.deepEqual([row?.result, row?.severity, row?.undecided], ['not-checked', 'blocking', true]);
    assert.equal(report.standards!.totals.blockingNotChecked, 1);
    assert.ok(h.progress.some((p) => p.phase === 'warning'
      && /Standards: 1 blocking rule could not be checked \(comment-policy\/banned-phrase\) — File is larger than 512 KB \(src\/big\.ts\)/.test(p.detail)));
    // Unevaluated blocking evidence is not a pass: the gate fails, before any model is asked.
    assert.equal(report.failedGate, 'standards');
    assert.equal(report.passed, false);
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode, g.passed]), [['moag:standards v3', 1, false], ['npm test', 0, true]]);
    assert.match(report.suggestion,
      /^Project standards could not be checked: 1 blocking rule was not checked\.\n- comment-policy\/banned-phrase — File is larger than 512 KB \(src\/big\.ts\)/);
    assert.deepEqual(report.standards!.notCheckedFiles, [{ file: 'src/big.ts', reason: 'File is larger than 512 KB' }]);
  });

  it('S24. by default a placeholder comment is advisory: it is reported, the commands run, and the commands decide', async () => {
    const loop = loadLoop({ standardsInputs: [ONE_FINDING] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards(defaults())), h.deps).run();

    assert.equal(report.passed, true);
    assert.equal(report.failedGate, null);
    assert.deepEqual(loop.gateCalls(), ['npm test', 'npm run lint']);
    assert.deepEqual(report.standards!.findings.map((f) => [f.file, f.line, f.rule, f.severity]),
      [['src/a.ts', 2, 'comment-policy/banned-phrase', 'advisory']]);
    // The whole blocking set of a default profile: its commands, and nothing MOAG scans for itself.
    assert.deepEqual(report.standards!.rules.filter((r) => r.severity === 'blocking').map((r) => [r.rule, r.result]), [['command', 'passed']]);
    assert.ok(!h.progress.some((p) => p.phase === 'warning' && /Scanner rules are heuristic/.test(p.detail)), 'nothing was promoted, so nothing warns');
    // The same diff with a failing lint command: the command, not a text scan, stops the release.
    const failing = loadLoop({
      standardsInputs: [ONE_FINDING],
      gateResult: (c) => (c === 'npm run lint' ? FAILING_GATE(c) : { command: c, exitCode: 0, passed: true, output: 'ok', durationMs: 1, timedOut: false }),
    });
    const stopped = await failing.createPrdLoop(baseConfig(withStandards(defaults())), makeDeps(makePlan()).deps).run();
    assert.equal(stopped.failedGate, 'standards');
    assert.match(stopped.suggestion, /^Standards command failed: npm run lint\nExit code: 1/);
  });

  it('S25. the passing row is written once the whole blocking set was evaluated, and records what the check left open', async () => {
    // One advisory finding, and one file no line rule can read.
    const mixed: StandardsCheckInput = {
      baseRef: 'head-ref', existingDirs: [], topLevel: ['src'], goModulePath: null,
      files: [
        { path: 'src/a.ts', status: 'added', addedLines: [1, 2], content: 'export const a = 1;\n// oldCall(a);' },
        { path: 'src/engine.rs', status: 'added', addedLines: [1], content: 'fn main() {}' },
      ],
    };
    const loop = loadLoop({ standardsInputs: [mixed] });
    const plan = makePlan({
      prdVersions: [{ version: '1.0.0', text: '## Requirements\n- [R-1] login', createdAt: '2026-10-01T00:00:00.000Z' }],
    });
    plan.playlists[0].tasks[0].requirementIds = ['R-1'];
    const h = makeDeps(plan, { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards(defaults())), h.deps).run();

    assert.equal(report.passed, true);
    // Written where the static check ran, ahead of the commands — but only after they all ran.
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 0], ['npm test', 0], ['npm run lint', 0]]);
    const counts = { advisoryFindings: 1, notCheckedRules: 2, notCheckedFiles: 1 };
    assert.deepEqual(report.gates[0].standardsCounts, counts, 'a command ran: no "no blocking rules" marker');
    assert.match(report.gates[0].output, /^Project standards: nothing blocking \(1 advisory finding, 2 rules not checked, 1 file not checked\)\./);
    assert.match(report.gates[0].output, /Files not checked \(1\) — nothing in them counts towards "no findings":\n- src\/engine\.rs — not checked \(No checker for \.rs files\)/);
    assert.ok(report.gates.slice(1).every((g) => g.standardsCounts === undefined), 'only the standards row carries them');
    // The row describes the finished check: the command it waited for is in the report it was written from.
    assert.deepEqual(report.standards!.rules.filter((r) => r.rule === 'command').map((r) => r.result), ['passed']);
    assert.deepEqual(report.standards!.notCheckedFiles, [{ file: 'src/engine.rs', reason: 'No checker for .rs files' }]);

    // The trace keeps the counts beside the row, and a release stamps them beside the version.
    const rec = plan.requirementTrace!.find((r) => r.id === 'R-1')!;
    assert.deepEqual(rec.gates[0], { command: 'moag:standards v3', exitCode: 0, timedOut: false, at: rec.gates[0].at, standardsCounts: counts });
    assert.deepEqual(stampRelease(plan, 'v1.0.0', '2026-10-04T00:00:00.000Z', { standardsVersion: 3, standardsFromGates: true }).shipped, ['R-1']);
    assert.deepEqual([rec.releases[0].standardsVersion, rec.releases[0].standardsCounts], [3, counts]);
    assert.deepEqual(requirementStatuses(plan).find((r) => r.id === 'R-1')?.standardsCounts, counts);
  });

  it('S26. what an advisory scan could not read does not hold the row back: the blocking set is what the stamp vouches for', async () => {
    // Every line rule is not-checked — no lexer reads the one changed file — yet the command,
    // which is what blocks, was evaluated.
    const rust = diffOf(['fn main() {}'], 'src/engine.rs');
    const loop = loadLoop({ standardsInputs: [rust] });
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards(defaults())), h.deps).run();

    assert.equal(report.passed, true);
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 0], ['npm test', 0], ['npm run lint', 0]]);
    assert.deepEqual(report.gates[0].standardsCounts, { advisoryFindings: 0, notCheckedRules: 3, notCheckedFiles: 1 },
      'and it says, beside the result, how much was not read');
    assert.equal(report.standards!.totals.noFindings > 0, true);
  });

  it('S27. unevaluated blocking evidence is never a pass: a promoted rule that read nothing stops the run, and nothing is stamped', async () => {
    const plan = (): Plan => {
      const p = makePlan({ prdVersions: [{ version: '1.0.0', text: '## Requirements\n- [R-1] login', createdAt: '2026-10-01T00:00:00.000Z' }] });
      p.playlists[0].tasks[0].requirementIds = ['R-1'];
      return p;
    };
    const release = (p: Plan) => {
      const shipped = stampRelease(p, 'v1.0.0', '2026-10-04T00:00:00.000Z', { standardsVersion: 3, standardsFromGates: true }).shipped;
      return { shipped, version: p.requirementTrace?.find((r) => r.id === 'R-1')?.releases.at(-1)?.standardsVersion };
    };

    // A promoted scan that could not read a changed file: the gate fails, and the trace's gates are not all green.
    const unread: StandardsCheckInput = {
      baseRef: 'head-ref', existingDirs: [], topLevel: ['src'], goModulePath: null,
      files: [{ path: 'src/big.ts', status: 'added', addedLines: [], content: null, skipped: 'File is larger than 512 KB' }],
    };
    const a = plan();
    const ra = await loadLoop({ standardsInputs: [unread] }).createPrdLoop(baseConfig(withStandards(profile())),
      makeDeps(a, { runEngine: async () => engineResult(PASS_VERDICT) }).deps).run();
    assert.equal(ra.passed, false);
    assert.equal(ra.failedGate, 'standards');
    assert.equal(ra.modelCallsMade, 0);
    // The commands did run and passed; it is the unread rule that stops the release.
    assert.deepEqual(ra.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 1], ['npm test', 0], ['npm run lint', 0]]);
    assert.deepEqual(release(a), { shipped: [], version: undefined }, 'nothing ships on a check that left a blocking rule open');

    // The same diff under the defaults: the command is the whole blocking set, it ran, so the stamp is given.
    const b = plan();
    const rb = await loadLoop({ standardsInputs: [unread] }).createPrdLoop(baseConfig(withStandards(defaults())),
      makeDeps(b, { runEngine: async () => engineResult(PASS_VERDICT) }).deps).run();
    assert.equal(rb.passed, true);
    assert.deepEqual(rb.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 0], ['npm test', 0], ['npm run lint', 0]]);
    assert.deepEqual(release(b), { shipped: ['R-1'], version: 3 });
    assert.deepEqual(b.requirementTrace!.find((r) => r.id === 'R-1')!.releases.at(-1)!.standardsCounts,
      { advisoryFindings: 0, notCheckedRules: 3, notCheckedFiles: 1 });
  });

  it('S28. a profile with no command and no promoted rule may ship, stamped "no blocking rules configured" and never as passed', async () => {
    const plan = makePlan({ prdVersions: [{ version: '1.0.0', text: '## Requirements\n- [R-1] login', createdAt: '2026-10-01T00:00:00.000Z' }] });
    plan.playlists[0].tasks[0].requirementIds = ['R-1'];
    const loop = loadLoop({ standardsInputs: [ADVISORY_ONLY] });
    const h = makeDeps(plan, { runEngine: async () => engineResult(PASS_VERDICT) });

    const report = await loop.createPrdLoop(baseConfig(withStandards(defaults([]))), h.deps).run();

    assert.equal(report.passed, true);
    assert.equal(report.failedGate, null);
    assert.deepEqual(loop.gateCalls(), ['npm test'], 'only the repository gate: the profile has no command');
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['moag:standards v3', 0], ['npm test', 0]]);
    const counts = { advisoryFindings: 1, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true };
    assert.deepEqual(report.gates[0].standardsCounts, counts);
    assert.match(report.gates[0].output, /^Project standards: no blocking rules configured \(1 advisory finding, 0 rules not checked, 0 files not checked\)\./);
    assert.doesNotMatch(report.gates[0].output, /\bpassed\b|nothing blocking/i);
    assert.equal(report.standards!.totals.passed, 0, 'no command ran, so nothing passed');
    assert.deepEqual(report.standards!.rules.filter((r) => r.severity === 'blocking'), []);

    // The release ships, and its stamp carries the marker beside the version — through a save and a reload.
    assert.deepEqual(stampRelease(plan, 'v1.0.0', '2026-10-04T00:00:00.000Z', { standardsVersion: 3, standardsFromGates: true }).shipped, ['R-1']);
    const rec = plan.requirementTrace!.find((r) => r.id === 'R-1')!;
    assert.deepEqual([rec.releases[0].standardsVersion, rec.releases[0].standardsCounts], [3, counts]);
    assert.deepEqual(requirementStatuses(plan).find((r) => r.id === 'R-1')?.standardsCounts, counts);
  });

  it('S29. a profile command the repository gate left unrun is not checked: the standards gate stops the run', async () => {
    // The repository gate fails, so the profile's command never runs. That is a failed
    // command gate first and foremost — and the report must not call the standards checked.
    const loop = loadLoop({
      standardsInputs: [CLEAN],
      gateResult: (c) => (c === 'npm test' ? FAILING_GATE(c) : { command: c, exitCode: 0, passed: true, output: 'ok', durationMs: 1, timedOut: false }),
    });
    const report = await loop.createPrdLoop(baseConfig(withStandards(defaults())), makeDeps(makePlan()).deps).run();
    assert.equal(report.failedGate, 'command');
    assert.deepEqual(report.gates.map((g) => [g.command, g.exitCode]), [['npm test', 1]], 'no standards row at all: neither a pass nor a second failure');
    assert.equal(report.standards!.totals.blockingNotChecked, 1);
    assert.deepEqual(report.standards!.rules.filter((r) => r.rule === 'command').map((r) => [r.result, r.reason]),
      [['not-checked', 'The command gate failed first']]);
  });

  it('S23. a nested repository is reported by name and is advisory; promoted, it fails the standards gate', async () => {
    const nested: StandardsCheckInput = { ...CLEAN, nestedRepos: ['cloned'] };
    const h = makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) });

    const byDefault = await loadLoop({ standardsInputs: [nested] }).createPrdLoop(baseConfig(withStandards(defaults())), h.deps).run();
    assert.equal(byDefault.failedGate, null);
    assert.equal(byDefault.passed, true);
    assert.deepEqual(byDefault.standards!.findings.map((f) => [f.file, f.rule, f.severity]), [['cloned', 'structure/nested-repository', 'advisory']]);
    assert.deepEqual(byDefault.standards!.notCheckedFiles, [{ file: 'cloned', reason: 'nested repository — files inside were not read' }]);
    assert.match(byDefault.gates[0].output, /- cloned:1 structure\/nested-repository — cloned is a git repository of its own/);
    assert.match(byDefault.gates[0].output, /- cloned — not checked \(nested repository — files inside were not read\)/);

    const promoted = defaults();
    promoted.severity = { 'structure/nested-repository': 'blocking' };
    const report = await loadLoop({ standardsInputs: [nested] }).createPrdLoop(baseConfig(withStandards(promoted)),
      makeDeps(makePlan(), { runEngine: async () => engineResult(PASS_VERDICT) }).deps).run();
    assert.equal(report.failedGate, 'standards');
    assert.equal(report.modelCallsMade, 0);
    assert.deepEqual(report.standards!.findings.map((f) => [f.file, f.rule, f.severity]), [['cloned', 'structure/nested-repository', 'blocking']]);
    assert.match(report.suggestion, /- cloned:1 structure\/nested-repository — cloned is a git repository of its own/);
  });
});

// ─── Per-loop cost cap (F3.6) ───

describe('createPrdLoop — per-run PRD budget', () => {
  /** A fake costLedger.onRecord: listeners plus emit(usd). */
  function spendBus() {
    const listeners: Array<(usd: number) => void> = [];
    return {
      listeners,
      subscribe: (cb: (usd: number) => void): (() => void) => {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i >= 0) { listeners.splice(i, 1); }
        };
      },
      emit: (usd: number): void => { [...listeners].forEach((l) => l(usd)); },
    };
  }

  const FIX_TASKS = '[{"name":"fix it","prompt":"make the gate pass"}]';

  it('halts as budget-exceeded once a run spends past the cap, stops the runner once, and calls no further engine', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const bus = spendBus();
    let stops = 0;
    const engineCalls: string[] = [];
    const h = makeDeps(makePlan(), {
      runEngine: async (prompt: string) => { engineCalls.push(prompt); return engineResult(FIX_TASKS); },
      runPlan: async (p: Plan) => { bus.emit(2); completeAll(p); },
      subscribeSpend: bus.subscribe,
      stopRun: () => { stops++; },
    });

    const report = await createPrdLoop(baseConfig({ fix: true, versionBudgetUsd: 1 }), h.deps).run();

    assert.equal(report.haltReason, 'budget-exceeded');
    assert.match(report.suggestion, /Per-run PRD budget reached: spent \$2\.00 of agentTaskPlayer\.prdLoop\.versionBudgetUsd = \$1\.00\./);
    assert.equal(stops, 1);
    assert.equal(engineCalls.length, 1, 'only the fix-generation call before the breach');
    assert.equal(bus.listeners.length, 0, 'unsubscribed');
  });

  it('a breach before the verify call means the model is never asked', async () => {
    const { createPrdLoop } = loadLoop();
    const bus = spendBus();
    const h = makeDeps(makePlan(), {
      resolvePrdText: async () => { bus.emit(5); return 'PRD TEXT'; },
      subscribeSpend: bus.subscribe,
    });

    const report = await createPrdLoop(baseConfig({ versionBudgetUsd: 1 }), h.deps).run();

    assert.equal(report.haltReason, 'budget-exceeded');
    assert.equal(report.modelCallsMade, 0);
    assert.equal(h.engineCalls.length, 0);
  });

  it('ignores non-finite and negative costs', async () => {
    const { createPrdLoop } = loadLoop();
    const bus = spendBus();
    const h = makeDeps(makePlan(), {
      resolvePrdText: async () => { bus.emit(NaN); bus.emit(-50); bus.emit(Infinity); return 'PRD TEXT'; },
      subscribeSpend: bus.subscribe,
    });

    const report = await createPrdLoop(baseConfig({ versionBudgetUsd: 1 }), h.deps).run();

    assert.notEqual(report.haltReason, 'budget-exceeded');
  });

  it('budget 0 never subscribes', async () => {
    const { createPrdLoop } = loadLoop();
    let subscribed = 0;
    const h = makeDeps(makePlan(), {
      subscribeSpend: () => { subscribed++; return () => undefined; },
    });

    await createPrdLoop(baseConfig({ versionBudgetUsd: 0 }), h.deps).run();

    assert.equal(subscribed, 0);
  });

  it('a cap without a spend source warns that it cannot be metered', async () => {
    const { createPrdLoop } = loadLoop();
    const h = makeDeps(makePlan());

    await createPrdLoop(baseConfig({ versionBudgetUsd: 1 }), h.deps).run();

    assert.ok(h.progress.some((p) => p.phase === 'warning' && /cannot be metered/.test(p.detail)));
  });

  it('two loops at once on one bus keep separate baselines', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const bus = spendBus();
    const stops = { a: 0, b: 0 };
    let releaseA!: () => void;
    let releaseB!: () => void;
    const holdA = new Promise<void>((r) => { releaseA = r; });
    const holdB = new Promise<void>((r) => { releaseB = r; });

    const mk = (hold: Promise<void>, key: 'a' | 'b') => makeDeps(makePlan(), {
      runEngine: async () => engineResult(FIX_TASKS),
      runPlan: async (p: Plan) => { await hold; completeAll(p); },
      subscribeSpend: bus.subscribe,
      stopRun: () => { stops[key]++; },
    });
    const a = mk(holdA, 'a');
    const b = mk(holdB, 'b');

    // A starts, 0.9 is spent, then B starts — B must not inherit A's 0.9.
    const runA = createPrdLoop(baseConfig({ fix: true, versionBudgetUsd: 1 }), a.deps).run();
    bus.emit(0.9);
    // Budget 1 (not 100) so a shared baseline would be observable: 0.9 + 0.5 = 1.4 > 1.
    const runB = createPrdLoop(baseConfig({ fix: true, versionBudgetUsd: 1 }), b.deps).run();
    assert.equal(bus.listeners.length, 2);
    bus.emit(0.5);

    assert.equal(stops.a, 1, 'A spent 1.4 of 1 and halts');
    assert.equal(stops.b, 0, 'B spent only 0.5 of 1 — no shared baseline');

    releaseA();
    releaseB();
    const [reportA, reportB] = await Promise.all([runA, runB]);
    assert.equal(reportA.haltReason, 'budget-exceeded');
    assert.notEqual(reportB.haltReason, 'budget-exceeded');
    assert.equal(bus.listeners.length, 0);
  });

  it('the spend listener is removed when runPlan throws', async () => {
    const { createPrdLoop } = loadLoop({ gateResult: (c) => FAILING_GATE(c) });
    const bus = spendBus();
    const h = makeDeps(makePlan(), {
      runEngine: async () => engineResult(FIX_TASKS),
      runPlan: async () => { throw new Error('runner exploded'); },
      subscribeSpend: bus.subscribe,
    });

    const report = await createPrdLoop(baseConfig({ fix: true, versionBudgetUsd: 1 }), h.deps).run();

    assert.equal(report.haltReason, 'engine-error');
    assert.equal(bus.listeners.length, 0);
  });

  it('the spend listener is removed when the loop itself throws', async () => {
    const { createPrdLoop } = loadLoop();
    const bus = spendBus();
    const h = makeDeps(makePlan(), {
      resolvePrdText: async () => { throw new Error('prd read failed'); },
      subscribeSpend: bus.subscribe,
    });

    await assert.rejects(createPrdLoop(baseConfig({ versionBudgetUsd: 1 }), h.deps).run(), /prd read failed/);
    assert.equal(bus.listeners.length, 0);
    assert.equal(h.reports.length, 1, 'still exactly one report');
  });

  it('a stopRun that throws does not break the loop', async () => {
    const { createPrdLoop } = loadLoop();
    const bus = spendBus();
    const h = makeDeps(makePlan(), {
      resolvePrdText: async () => { bus.emit(5); return 'PRD TEXT'; },
      subscribeSpend: bus.subscribe,
      stopRun: () => { throw new Error('stop failed'); },
    });

    const report = await createPrdLoop(baseConfig({ versionBudgetUsd: 1 }), h.deps).run();

    assert.equal(report.haltReason, 'budget-exceeded');
  });
});
