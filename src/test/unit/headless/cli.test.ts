// ─── Headless CLI: arg parsing, one-shot prompt plan, config engine helpers ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs,
  buildPromptPlan,
  setDefaultEngine,
  readDefaultEngine,
  readConfigFile,
  configFilePath,
  traceArgsError,
  resolveTracePlanPath,
  persistRequirementTrace,
  cmdTrace,
} from '../../../headless/cli';
import * as sinon from 'sinon';
import { loadPlan } from '../../../models/plan';
import { Plan, TaskStatus } from '../../../models/types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moag-cli-'));
}

describe('headless CLI: parseArgs', () => {
  it('parses `run --prompt` with engine + flags', () => {
    const a = parseArgs(['run', '--prompt', 'do x', '--engine', 'claude', '--full-auto']);
    assert.equal(a.command, 'run');
    assert.equal(a.prompt, 'do x');
    assert.equal(a.engine, 'claude');
    assert.equal(a.fullAuto, true);
  });

  it('collects a config subcommand + value as ordered positionals', () => {
    const a = parseArgs(['config', 'set-engine', 'codex']);
    assert.equal(a.command, 'config');
    assert.deepEqual(a.positionals, ['set-engine', 'codex']);
  });

  it('treats the first positional as the plan path for `run`', () => {
    const a = parseArgs(['run', 'my.plan.json']);
    assert.ok(a.planPath && a.planPath.endsWith('my.plan.json'));
    assert.deepEqual(a.positionals, ['my.plan.json']);
  });

  it('clamps --interval to a 10s floor', () => {
    assert.equal(parseArgs(['loop', '--interval', '2']).intervalSec, 10);
  });
});

describe('headless CLI: moag bench flags', () => {
  it('parses the scenario, --dry-run, --out (against the final --cwd) and --max-usd', () => {
    const base = path.resolve(os.tmpdir(), 'bench-cwd');
    const a = parseArgs(['bench', 'scn/scenario.json', '--dry-run', '--out', 'res', '--max-usd', '4.95', '--cwd', base]);
    assert.equal(a.command, 'bench');
    assert.equal(a.dryRun, true);
    assert.equal(a.maxUsd, 4.95);
    assert.equal(a.out, path.join(base, 'res'));
    assert.equal(a.planPath, path.resolve(process.cwd(), 'scn/scenario.json'), 'the positional resolves against the cwd at the time it was read');
  });

  it('a bad --max-usd becomes NaN (a usage error), never a silent cap', () => {
    for (const bad of ['0', '-1', 'abc', 'Infinity', '']) {
      assert.ok(Number.isNaN(parseArgs(['bench', 's.json', '--max-usd', bad]).maxUsd), bad);
    }
    assert.ok(Number.isNaN(parseArgs(['bench', 's.json', '--max-usd']).maxUsd), 'missing value');
  });

  it('a bare --out is recorded as empty (a usage error), and no flags leave the bench fields unset', () => {
    assert.equal(parseArgs(['bench', 's.json', '--out']).out, '');
    assert.equal(parseArgs(['bench', 's.json', '--out', '--dry-run']).out, '');
    const plain = parseArgs(['bench', 's.json']);
    assert.equal(plain.dryRun, undefined);
    assert.equal(plain.out, undefined);
    assert.equal(plain.maxUsd, undefined);
    assert.equal(plain.allowFailedProbes, undefined, 'a failed probe stops a paid run unless the flag is given');
  });

  it('--allow-failed-probes is an explicit opt-in flag that takes no value', () => {
    const a = parseArgs(['bench', 's.json', '--allow-failed-probes', '--max-usd', '5']);
    assert.equal(a.allowFailedProbes, true);
    assert.equal(a.maxUsd, 5, 'the next flag is still read');
    assert.deepEqual(a.positionals, ['s.json']);
  });
});

describe('headless CLI: buildPromptPlan', () => {
  it('creates a single agent task carrying the full prompt', () => {
    const plan = buildPromptPlan('summarize the readme', 'claude');
    assert.equal(plan.defaultEngine, 'claude');
    assert.equal(plan.playlists[0].tasks.length, 1);
    const task = plan.playlists[0].tasks[0];
    assert.equal(task.prompt, 'summarize the readme');
    assert.equal(task.type, 'agent');
  });

  it('truncates a long task name but preserves the full prompt + engine', () => {
    const long = 'x'.repeat(120);
    const plan = buildPromptPlan(long, 'codex');
    const task = plan.playlists[0].tasks[0];
    assert.ok(task.name.length <= 61, `name too long: ${task.name.length}`);
    assert.equal(task.prompt, long);
    assert.equal(plan.defaultEngine, 'codex');
  });
});

describe('headless CLI: config engine helpers', () => {
  beforeEach(() => { delete process.env.MOAG_CONFIG_PATH; });

  it('defaults to claude when no config exists', () => {
    assert.equal(readDefaultEngine(tmpDir()), 'claude');
  });

  it('set-engine persists and round-trips through the file', () => {
    const dir = tmpDir();
    const res = setDefaultEngine(dir, 'codex');
    assert.equal(res.ok, true);
    assert.equal(readDefaultEngine(dir), 'codex');
    const onDisk = JSON.parse(fs.readFileSync(configFilePath(dir), 'utf-8'));
    assert.equal(onDisk.agentTaskPlayer.defaultEngine, 'codex');
  });

  it('rejects an unknown engine without writing a file', () => {
    const dir = tmpDir();
    const res = setDefaultEngine(dir, 'notreal');
    assert.equal(res.ok, false);
    assert.ok(res.error && res.error.includes('set-engine'));
    assert.ok(!fs.existsSync(configFilePath(dir)));
    assert.equal(readDefaultEngine(dir), 'claude');
  });

  it('preserves other config keys when updating the engine', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
    fs.writeFileSync(
      configFilePath(dir),
      JSON.stringify({ agentTaskPlayer: { fullAuto: true }, other: 1 }),
    );
    assert.equal(setDefaultEngine(dir, 'gemini').ok, true);
    const onDisk = readConfigFile(dir);
    assert.equal(onDisk.agentTaskPlayer.defaultEngine, 'gemini');
    assert.equal(onDisk.agentTaskPlayer.fullAuto, true);
    assert.equal(onDisk.other, 1);
  });

  it('honours MOAG_CONFIG_PATH for the config location', () => {
    const dir = tmpDir();
    const custom = path.join(dir, 'custom-config.json');
    process.env.MOAG_CONFIG_PATH = custom;
    try {
      assert.equal(configFilePath('/ignored'), custom);
      assert.equal(setDefaultEngine('/ignored', 'ollama').ok, true);
      assert.ok(fs.existsSync(custom));
      assert.equal(readDefaultEngine('/ignored'), 'ollama');
    } finally {
      delete process.env.MOAG_CONFIG_PATH;
    }
  });
});

describe('headless CLI: moag trace', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('parses --plan and --req', () => {
    const a = parseArgs(['trace', '--plan', 'p.json', '--req', 'R-7']);
    assert.equal(a.command, 'trace');
    assert.ok(a.planPath && a.planPath.endsWith('p.json'));
    assert.ok(path.isAbsolute(a.planPath!));
    assert.equal(a.req, 'R-7');
  });

  it('accepts the plan as a positional too', () => {
    const a = parseArgs(['trace', 'other.json']);
    assert.ok(a.planPath && a.planPath.endsWith('other.json'));
    assert.equal(a.req, undefined);
  });

  it('traceArgsError rejects malformed requirement IDs and accepts R-<n>', () => {
    assert.match(traceArgsError(parseArgs(['trace', '--req', 'R7']))!, /R-7/);
    assert.ok(traceArgsError(parseArgs(['trace', '--req', 'r-7'])));
    assert.ok(traceArgsError(parseArgs(['trace', '--req', ''])));
    assert.ok(traceArgsError(parseArgs(['trace', '--req', 'R-7x'])));
    assert.equal(traceArgsError(parseArgs(['trace', '--req', 'R-7'])), null);
    assert.equal(traceArgsError(parseArgs(['trace'])), null);
  });

  it('resolveTracePlanPath returns null when the cwd has no plan', () => {
    const dir = tmpDir();
    dirs.push(dir);
    assert.equal(resolveTracePlanPath(parseArgs(['trace', '--cwd', dir])), null);
  });

  it('resolveTracePlanPath falls back to <cwd>/.moag/plan.json when it exists', () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.moag'));
    const planFile = path.join(dir, '.moag', 'plan.json');
    fs.writeFileSync(planFile, '{}');
    assert.equal(resolveTracePlanPath(parseArgs(['trace', '--cwd', dir])), planFile);
  });

  it('an explicit --plan wins over the .moag/plan.json fallback', () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.moag'));
    fs.writeFileSync(path.join(dir, '.moag', 'plan.json'), '{}');
    const resolved = resolveTracePlanPath(parseArgs(['trace', '--cwd', dir, '--plan', 'elsewhere.json']));
    assert.equal(resolved, path.join(dir, 'elsewhere.json'));
  });

  it('--plan resolves against the final --cwd even when --cwd comes after it', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const a = parseArgs(['trace', '--plan', 'elsewhere.json', '--cwd', dir]);
    assert.equal(a.planPath, path.join(dir, 'elsewhere.json'));
  });

  it('a positional plan path resolves against the final --cwd, whatever the flag order', () => {
    const dir = tmpDir();
    dirs.push(dir);
    assert.equal(parseArgs(['trace', 'elsewhere.json', '--cwd', dir]).planPath, path.join(dir, 'elsewhere.json'));
    assert.equal(parseArgs(['trace', '--cwd', dir, 'elsewhere.json']).planPath, path.join(dir, 'elsewhere.json'));
    // --plan still wins over a positional.
    assert.equal(parseArgs(['trace', 'pos.json', '--plan', 'flag.json', '--cwd', dir]).planPath, path.join(dir, 'flag.json'));
    // And cmdTrace really reads the plan under the final --cwd.
    fs.writeFileSync(path.join(dir, 'elsewhere.json'), JSON.stringify({ version: '1.0', name: 'p', playlists: [] }));
    const out = sinon.stub(process.stdout, 'write').returns(true);
    const err = sinon.stub(process.stderr, 'write').returns(true);
    try {
      assert.equal(cmdTrace(parseArgs(['trace', 'elsewhere.json', '--cwd', dir])), 0);
    } finally { out.restore(); err.restore(); }
  });

  it('a bare --plan (trailing, or followed by another flag) is a usage error, exit 2 — never the fallback plan', () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.moag'));
    fs.writeFileSync(path.join(dir, '.moag', 'plan.json'), JSON.stringify({ version: '1.0', name: 'p', playlists: [] }));
    for (const argv of [['trace', '--cwd', dir, '--plan'], ['trace', '--plan', '--req', 'R-1', '--cwd', dir], ['trace', '--plan', '', '--cwd', dir]]) {
      const a = parseArgs(argv);
      assert.equal(a.planFlagMissing, true, argv.join(' '));
      assert.match(traceArgsError(a) ?? '', /--plan needs a path/);
      const stderr = sinon.stub(process.stderr, 'write').returns(true);
      const stdout = sinon.stub(process.stdout, 'write').returns(true);
      try {
        assert.equal(cmdTrace(a), 2, argv.join(' '));
        assert.equal(stdout.called, false, 'no trace rows from the fallback plan');
      } finally { stderr.restore(); stdout.restore(); }
    }
    assert.equal(parseArgs(['trace', '--plan', '--req', 'R-1']).req, 'R-1', 'the following flag is not swallowed as the path');
  });

  it('a bare trailing --req is a usage error, not "report everything"', () => {
    const a = parseArgs(['trace', '--req']);
    assert.equal(a.req, '');
    assert.ok(traceArgsError(a));
    const stderr = sinon.stub(process.stderr, 'write').returns(true);
    try {
      assert.equal(cmdTrace(a), 2);
    } finally {
      stderr.restore();
    }
  });

  it('emits blockedBy on a not-shipped row', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planFile = path.join(dir, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
      version: '1.0', name: 'p',
      prdVersions: [{ version: '1.0.0', text: '## Requirements\n- [R-1] login\n', createdAt: '2026-10-04T00:00:00.000Z' }],
      playlists: [{ id: 'pl', name: 'Build', tasks: [
        { id: 't-1', name: 't', prompt: 'p', status: 'failed', requirementIds: ['R-1'] },
      ] }],
    }));
    const lines: string[] = [];
    const stdout = sinon.stub(process.stdout, 'write').callsFake((chunk: unknown) => { lines.push(String(chunk)); return true; });
    let code: number;
    try {
      code = cmdTrace(parseArgs(['trace', '--plan', planFile]));
    } finally {
      stdout.restore();
    }
    assert.equal(code, 0);
    const rows = lines.map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'not-shipped');
    assert.equal(rows[0].blockedBy, 't-1');
  });
});

describe('headless CLI: persistRequirementTrace', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
  });

  function writePlanFile(): string {
    const dir = tmpDir();
    dirs.push(dir);
    const planFile = path.join(dir, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
      version: '1.0', name: 'p', customKey: 'kept',
      playlists: [{ id: 'pl', name: 'Build', tasks: [
        { id: 't-1', name: 't', prompt: 'p', requirementIds: ['R-1'] },
        { id: 'rel', name: 'release', prompt: 'ship', type: 'release' },
      ] }],
    }, null, 2));
    return planFile;
  }

  it('writes only requirementTrace — run statuses never reach the plan file', () => {
    const planFile = writePlanFile();
    const plan = loadPlan(planFile);
    // What a headless run does in memory: statuses advance, trace evidence is recorded.
    for (const t of plan.playlists[0].tasks) { t.status = TaskStatus.Completed; }
    plan.requirementTrace = [{
      id: 'R-1', taskIds: ['t-1'], commits: ['abc'], gates: [],
      releases: [{ releaseTag: 'v1.0.0', prdVersion: '1.0.0', at: '2026-10-04T00:00:00.000Z', taskIds: ['t-1'] }],
    }];

    persistRequirementTrace(plan, planFile);

    const raw = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
    assert.equal(raw.customKey, 'kept', 'unrelated keys are preserved');
    assert.equal(raw.requirementTrace[0].commits[0], 'abc');
    const reloaded = loadPlan(planFile);
    assert.deepEqual(reloaded.playlists[0].tasks.map((t) => t.status), [TaskStatus.Pending, TaskStatus.Pending],
      'the next run must not skip the completed tasks (release included)');
    assert.deepEqual(reloaded.requirementTrace, plan.requirementTrace);
    assert.deepEqual(fs.readdirSync(path.dirname(planFile)), ['plan.json'], 'no temp file left behind');
  });

  it('also writes fixIterations (0 included) and removes it when the plan has none', () => {
    const planFile = writePlanFile();
    const plan = loadPlan(planFile);
    plan.fixIterations = 2;
    persistRequirementTrace(plan, planFile);
    assert.equal(loadPlan(planFile).fixIterations, 2);
    plan.fixIterations = 0;
    persistRequirementTrace(plan, planFile);
    assert.equal(JSON.parse(fs.readFileSync(planFile, 'utf-8')).fixIterations, 0, '0 is a real value');
    delete plan.fixIterations;
    persistRequirementTrace(plan, planFile);
    assert.equal('fixIterations' in JSON.parse(fs.readFileSync(planFile, 'utf-8')), false);
    assert.deepEqual(loadPlan(planFile).playlists[0].tasks.map((t) => t.status), [TaskStatus.Pending, TaskStatus.Pending]);
  });

  it('throws on a malformed plan file and leaves it untouched', () => {
    const planFile = writePlanFile();
    fs.writeFileSync(planFile, '{ not json');
    const plan = loadPlan(writePlanFile());
    assert.throws(() => persistRequirementTrace(plan, planFile));
    assert.equal(fs.readFileSync(planFile, 'utf-8'), '{ not json');
    assert.deepEqual(fs.readdirSync(path.dirname(planFile)), ['plan.json']);
  });
});

// ─── cmdRun — the wiring that decides what a headless run writes ───

describe('headless CLI: cmdRun persists only requirement trace', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxyquire = require('proxyquire').noCallThru();
  const AT = '2026-10-04T00:00:00.000Z';
  const dirs: string[] = [];
  let stdout: sinon.SinonStub;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    const write = process.stdout.write.bind(process.stdout);
    // Capture the CLI's JSONL events; let the mocha reporter through.
    stdout = sinon.stub(process.stdout, 'write').callsFake((chunk: unknown) => {
      const text = String(chunk);
      if (text.startsWith('{')) { lines.push(text); return true; }
      return write(text);
    });
  });
  afterEach(() => { stdout.restore(); });
  after(() => {
    for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
  });

  /** cli with the heavy lazy dependencies of `run --verify` replaced; `loop` drives the PRD loop. */
  function loadCli(loop?: (plan: Plan, deps: { savePlan: () => void }) => Promise<void>) {
    return proxyquire('../../../headless/cli', {
      '../runner/prd-loop': {
        createPrdLoop: (_cfg: unknown, deps: { plan: Plan; savePlan: () => void }) => ({
          run: async () => {
            if (loop) { await loop(deps.plan, deps); }
            return {
              passed: true, score: 100, haltReason: null, failedGate: null, iterations: 1, modelCallsMade: 1,
              gateCommandsEmpty: false, uatRan: false, uatSkipReason: null, changedFiles: [],
            };
          },
          noteManualGate: () => undefined,
          noteBudgetExceeded: () => undefined,
        }),
      },
      '../runner/evidence': { detectPrdFile: () => null, captureBaseRef: async () => null },
      '../adapters/index': { getEngine: () => ({ runTask: async () => { throw new Error('no engine in tests'); } }) },
      '../sandbox/sandbox-manager': { SandboxManager: class {}, isPortOpen: async () => false },
      '../sandbox/project-detector': { detectProject: () => null },
    });
  }

  function writePlanFile(): { dir: string; planFile: string } {
    const dir = tmpDir();
    dirs.push(dir);
    const planFile = path.join(dir, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
      version: '1.0', name: 'p', customKey: 'kept',
      playlists: [{ id: 'pl', name: 'Build', tasks: [
        { id: 't-1', name: 't', prompt: 'p', requirementIds: ['R-1'] },
        { id: 'rel', name: 'release', prompt: 'ship', type: 'release' },
      ] }],
    }, null, 2));
    return { dir, planFile };
  }

  /** A fake runner whose play() completes every task and records a commit, then optionally throws. */
  function fakeCtx(opts: { throwAfter?: boolean; recordTrace?: boolean } = {}) {
    return {
      runner: {
        on: () => undefined,
        stop: () => undefined,
        play: async (plan: Plan) => {
          for (const t of plan.playlists[0].tasks) { t.status = TaskStatus.Completed; }
          if (opts.recordTrace !== false) {
            plan.requirementTrace = [{ id: 'R-1', taskIds: ['t-1'], commits: ['abc'], gates: [], releases: [] }];
          }
          if (opts.throwAfter) { throw new Error('runner blew up'); }
        },
      },
      vscode: { workspace: { getConfiguration: () => ({ get: <T>(_k: string, d: T) => d }) } },
      TaskStatus,
      loadPlan,
    };
  }

  function statusesOnDisk(planFile: string): TaskStatus[] {
    return loadPlan(planFile).playlists[0].tasks.map((t) => t.status);
  }

  it('a completed run writes the trace but leaves every task Pending on disk', async () => {
    const { dir, planFile } = writePlanFile();
    const code = await loadCli().cmdRun(parseArgs(['run', planFile, '--cwd', dir]), fakeCtx());
    assert.equal(code, 0);
    assert.deepEqual(statusesOnDisk(planFile), [TaskStatus.Pending, TaskStatus.Pending],
      'a full savePlan here would make the next run skip every task, release included');
    const raw = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
    assert.deepEqual(raw.requirementTrace[0].commits, ['abc']);
    assert.equal(raw.customKey, 'kept');
  });

  it('a run that throws still persists the trace it recorded, and nothing else', async () => {
    const { dir, planFile } = writePlanFile();
    const code = await loadCli().cmdRun(parseArgs(['run', planFile, '--cwd', dir]), fakeCtx({ throwAfter: true }));
    assert.equal(code, 2);
    assert.deepEqual(statusesOnDisk(planFile), [TaskStatus.Pending, TaskStatus.Pending]);
    assert.deepEqual(JSON.parse(fs.readFileSync(planFile, 'utf-8')).requirementTrace[0].commits, ['abc']);
    assert.ok(lines.some((l) => l.includes('runner blew up')));
  });

  it('run --verify --fix: the fix-iteration count reaches disk, so the next run starts from it, not from 0', async () => {
    const { dir, planFile } = writePlanFile();
    // The PRD lives in the plan (plan.prdSource), so the loop's "new PRD" reset does not fire.
    const raw0 = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
    raw0.prdSource = '## Requirements\n- [R-1] login\n';
    fs.writeFileSync(planFile, JSON.stringify(raw0, null, 2));
    const seenAtStart: Array<number | undefined> = [];
    const cli = loadCli(async (plan, deps) => {
      seenAtStart.push(plan.fixIterations);
      plan.fixIterations = (plan.fixIterations ?? 0) + 2; // two fix playlists this run
      deps.savePlan();
    });
    const run = () => cli.cmdRun(parseArgs(['run', planFile, '--cwd', dir, '--verify', '--fix']), fakeCtx({ recordTrace: false }));
    await run();
    assert.equal(JSON.parse(fs.readFileSync(planFile, 'utf-8')).fixIterations, 2);
    await run();
    assert.deepEqual(seenAtStart, [undefined, 2], 'the second run sees the first run\'s count');
    const raw = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
    assert.equal(raw.fixIterations, 4, 'the ceiling keeps counting across runs');
    assert.deepEqual(statusesOnDisk(planFile), [TaskStatus.Pending, TaskStatus.Pending], 'still no run statuses on disk');
    assert.equal(raw.prdSource, '## Requirements\n- [R-1] login\n', 'the plan\'s own PRD is untouched');
  });

  it('a ship gate halts with exit 3: stop() is deferred past the manual-gate emit so play() settles', async () => {
    const { dir, planFile } = writePlanFile();
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    let stopsDuringEmit = 0;
    let inEmit = false;
    let abortListener: (() => void) | null = null;
    let aborted = false;
    // Mirrors runManualTask: the gate emits, THEN attaches its abort listener; an
    // abort fired before that (stop() inside the emit) is lost and the gate never settles.
    const runner = {
      on: (ev: string, fn: (...a: unknown[]) => void) => { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); },
      stop: () => {
        if (inEmit) { stopsDuringEmit++; }
        aborted = true;
        abortListener?.();
      },
      play: async (plan: Plan) => {
        const gate = plan.playlists[0].tasks[1];
        inEmit = true;
        try { for (const fn of listeners.get('manual-gate') ?? []) { fn(gate); } } finally { inEmit = false; }
        const lostAbort = aborted;
        await new Promise<void>((resolve) => { abortListener = resolve; });
        if (lostAbort) { throw new Error('unreachable: an abort before the listener is never delivered'); }
        gate.status = TaskStatus.Failed;
      },
    };
    const ctx = { ...fakeCtx(), runner };
    const result = await Promise.race([
      loadCli().cmdRun(parseArgs(['run', planFile, '--cwd', dir]), ctx),
      new Promise<string>((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    assert.equal(result, 3, 'play() settled and the run exits 3 (ship gate)');
    assert.equal(stopsDuringEmit, 0, 'stop() is never called inside the manual-gate emit');
    assert.ok(lines.some((l) => l.includes('"manual-gate"')));
  });

  it('a run that recorded no trace does not touch the plan file', async () => {
    const { dir, planFile } = writePlanFile();
    const before = fs.readFileSync(planFile, 'utf-8');
    await loadCli().cmdRun(parseArgs(['run', planFile, '--cwd', dir]), fakeCtx({ recordTrace: false }));
    assert.equal(fs.readFileSync(planFile, 'utf-8'), before);
  });

  it('run --verify: the loop\'s saves write only the trace, never run statuses', async () => {
    const { dir, planFile } = writePlanFile();
    let saves = 0;
    const cli = loadCli(async (plan, deps) => {
      // What the real loop does: step 2 resets the fix budget and saves, the gate step records evidence and saves.
      plan.fixIterations = 0;
      plan.prdSource = '## Requirements\n- [R-1] login\n';
      deps.savePlan();
      plan.requirementTrace![0].gates = [{ command: 'npm test', exitCode: 0, timedOut: false, at: AT }];
      deps.savePlan();
      saves += 2;
    });
    const code = await cli.cmdRun(parseArgs(['run', planFile, '--cwd', dir, '--verify']), fakeCtx());
    assert.equal(code, 0);
    assert.equal(saves, 2);
    assert.deepEqual(statusesOnDisk(planFile), [TaskStatus.Pending, TaskStatus.Pending]);
    const raw = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
    assert.deepEqual(raw.requirementTrace[0].gates.map((g: { exitCode: number }) => g.exitCode), [0]);
    assert.equal(raw.prdSource, undefined, 'run --verify persists the trace only');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  });
});

describe('headless CLI: exports for the hosted-server worker', () => {
  it('exports runVerifyCore as a function (reused by src/server/run-worker.ts)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cli = require('../../../headless/cli');
    assert.equal(typeof cli.runVerifyCore, 'function');
    assert.equal(cli.runVerifyCore.length, 5, '(args, ctx, plan, events, persist)');
  });
});
