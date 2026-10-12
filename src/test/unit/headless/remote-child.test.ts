// ─── Remote child: the runner-account side of an ONOSOO-started run ───

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { buildPromptPlan } from '../../../headless/cli';
import {
  ChildInput, mirrorBranchGoneMessage, parseSpec, REMOTE_HOME_DIR, REMOTE_TASK_TIMEOUT_MS, RemoteChildDeps, RemoteRunSpec, reviewRemotePlan, runRemoteChild, transformGeneratedPlan,
} from '../../../headless/remote-child';
import { dehydratePlan } from '../../../models/plan';
import { Plan, PlanFile, TaskStatus } from '../../../models/types';
import { buildFullPlanPrompt, parseGeneratedPlan } from '../../../runner/prd-plan';

const SHA = 'a'.repeat(40);

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-child-')));
}

function spec(over: Partial<RemoteRunSpec> = {}): RemoteRunSpec {
  return {
    op: 'run', runId: 'run-1', projectId: 'web', branch: 'moag/remote-1', branchPrefix: 'moag/', baseSha: SHA, startSha: SHA,
    engine: 'claude', allotment: 7, goal: 'Add a login page', bundleBytes: 0, engineEnv: { ANTHROPIC_API_KEY: 'sk-test-key-value' }, ...over,
  };
}

/** A runner fake: play() runs every pending task unless told to fail delivery or to wait for stop. */
class FakeRunner extends EventEmitter {
  stops = 0;
  deliveryBranch: string | null = null;
  requested: string | null = null;
  started: string[] = [];
  private release: (() => void) | null = null;
  constructor(private readonly mode: 'ok' | 'delivery-fails' | 'wait-for-stop') { super(); }
  setRunStartHook(): void { /* recorded by absence of effects */ }
  setDeliveryBranch(b: string | null): void { this.requested = b; }
  stop(): void { this.stops++; this.release?.(); }
  async play(plan: Plan): Promise<void> {
    if (this.mode === 'delivery-fails') { this.emit('error', new Error('not a repo')); return; }
    this.deliveryBranch = this.requested;
    this.emit('state-changed', 'playing');
    if (this.mode === 'wait-for-stop') { await new Promise<void>((r) => { this.release = r; }); }
    for (const t of plan.playlists.flatMap((pl) => pl.tasks)) {
      if (this.stops > 0) { break; }
      this.started.push(t.id);
      this.emit('task-started', t);
      t.status = TaskStatus.Completed;
      this.emit('task-completed', t, { stdout: '', stderr: '' });
    }
    this.emit('state-changed', 'idle');
  }
}

interface Harness {
  deps: RemoteChildDeps;
  lines: Array<Record<string, unknown>>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
  runner: FakeRunner;
  stdin: PassThrough;
  home: string;
  plannerSeen: Array<{ cwd: string; config: Record<string, Record<string, unknown>> | null; prompt: string }>;
  roots: string[];
  watchdogs: number;
}

const GENERATED = {
  version: '1.0', name: 'Login', description: 'd', defaultEngine: 'claude',
  playlists: [
    { id: 'dev', name: 'Development', parallel: true, tasks: [
      { id: 't1', name: 'Build', prompt: 'build it', env: { SECRET: 'x' }, timeoutMs: 99_999_999 },
      { id: 't2', name: 'Rel', prompt: 'release', type: 'release', releaseTag: 'v1', dependsOn: ['t1'] },
    ] },
    { id: 'test', name: 'Testing', testPhase: true, tasks: [{ id: 't3', name: 'Test', prompt: 'test it', type: 'command', command: 'npm test' }] },
  ],
};

function harness(mode: 'ok' | 'delivery-fails' | 'wait-for-stop' = 'ok', opts: { commits?: number; projectConfigZero?: boolean; plannerExit?: number; plannerCost?: number | 'unreported'; mirrorTip?: string } = {}): Harness {
  const costListeners: Array<(e: { estimatedCostUsd: number; engineId: string }) => void> = [];
  const unreportedListeners: Array<(e: { engineId: string }) => void> = [];
  const home = tmp();
  const lines: Array<Record<string, unknown>> = [];
  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  const runner = new FakeRunner(mode);
  const stdin = new PassThrough();
  const plannerSeen: Harness['plannerSeen'] = [];
  const roots: string[] = [];
  const h: Partial<Harness> = { lines, gitCalls, runner, stdin, home, plannerSeen, roots, watchdogs: 0 };
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', CI: 'true', MOAG_ONOSOO_KEY: 'device-key-never', MOAG_OTHER: 'x' };
  const deps: RemoteChildDeps = {
    git: async (args, cwd) => {
      gitCalls.push({ args, cwd });
      const [a, b] = args;
      if (a === 'init') { fs.mkdirSync(args[3], { recursive: true }); fs.writeFileSync(path.join(args[3], 'HEAD'), 'ref: refs/heads/main\n'); return ''; }
      if (a === 'bundle' && b === 'list-heads') { return `${SHA} HEAD\n${SHA} refs/heads/moag/remote-1\n`; }
      if (a === 'worktree' && b === 'add') {
        fs.mkdirSync(args[4], { recursive: true });
        if (opts.projectConfigZero) {
          fs.mkdirSync(path.join(args[4], '.moag'), { recursive: true });
          fs.writeFileSync(path.join(args[4], '.moag', 'config.json'), JSON.stringify({ agentTaskPlayer: { costBudgetUsd: 0 } }));
        }
        return '';
      }
      if (a === 'symbolic-ref') { return 'moag/remote-1\n'; }
      if (a === 'rev-parse' && args.some((x) => x.startsWith('refs/heads/'))) { return opts.mirrorTip ? `${opts.mirrorTip}\n` : null; }
      if (a === 'rev-list') { return `${opts.commits ?? 1}\n`; }
      if (a === 'bundle' && b === 'create') { fs.writeFileSync(args[2], Buffer.alloc(500_000, 7)); return ''; }
      if (a === 'for-each-ref') { return `${SHA}\nnot-a-sha\n${'b'.repeat(40)}\n`; }
      return '';
    },
    input: new ChildInput(stdin),
    emit: (l) => lines.push(l),
    home,
    uid: 1001,
    env,
    now: () => Date.now(),
    setup: async () => ({ runner, vscode: {}, TaskStatus, loadPlan: () => { throw new Error('unused'); } }),
    parseArgs: (argv) => ({ argv }),
    wireEvents: (r) => {
      r.on('task-started', (t: { id: string }) => lines.push({ event: 'task-started', id: t.id }));
      r.on('task-completed', (t: { id: string }) => lines.push({ event: 'task-completed', id: t.id }));
      r.on('error', (e: Error) => lines.push({ event: 'error', message: e.message }));
      return {};
    },
    wireTaskReporting: () => () => undefined,
    runAfterWiring: async (_args, ctx, plan, _pp, _ev, extra) => {
      lines.push({ event: 'run-started', branch: extra.branch });
      await ctx.runner.play(plan);
      lines.push({ event: 'run-finished' });
      return 0;
    },
    buildPromptPlan: (goal, engine) => buildPromptPlan(goal, engine),
    runPlanner: async (_engine, prompt, cwd) => {
      const cfgPath = env.MOAG_CONFIG_PATH;
      plannerSeen.push({ cwd, prompt, config: cfgPath ? JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) : null });
      if (opts.plannerCost === 'unreported') { for (const l of unreportedListeners) { l({ engineId: 'claude' }); } }
      else if (typeof opts.plannerCost === 'number') { for (const l of costListeners) { l({ estimatedCostUsd: opts.plannerCost, engineId: 'claude' }); } }
      return { stdout: JSON.stringify(GENERATED), exitCode: opts.plannerExit ?? 0 };
    },
    buildFullPlanPrompt: (prd) => buildFullPlanPrompt(prd),
    parseGeneratedPlan: (stdout) => parseGeneratedPlan(stdout),
    detectEngines: async () => ['claude', 'gemini'],
    costLedger: {
      onRecord: (fn) => { costListeners.push(fn); return () => { costListeners.splice(costListeners.indexOf(fn), 1); }; },
      onUnreported: (fn) => { unreportedListeners.push(fn); return () => { unreportedListeners.splice(unreportedListeners.indexOf(fn), 1); }; },
    },
    setWorkspaceRoot: (r) => roots.push(r),
    armWatchdog: () => { (h as Harness).watchdogs++; },
  };
  h.deps = deps;
  return h as Harness;
}

const events = (h: Harness): string[] => h.lines.map((l) => String(l.event));
const shape = (p: PlanFile): unknown => p.playlists.map((pl) => pl.tasks.map((t) => ({ name: t.name, prompt: t.prompt, type: t.type ?? 'agent' })));

describe('remote child — run', () => {
  it('a goal-only run executes exactly buildPromptPlan(goal), on the branch, and reports in order', async () => {
    const h = harness();
    // stdin stays open, as the daemon keeps it (EOF would mean stop).
    const code = await runRemoteChild(spec(), h.deps);
    assert.equal(code, 0);
    const plan = h.lines.find((l) => l.event === 'remote-plan')!.plan as PlanFile;
    assert.deepEqual(shape(plan), shape(dehydratePlan(buildPromptPlan('Add a login page', 'claude'))));
    assert.equal(h.runner.requested, 'moag/remote-1');
    const ev = events(h);
    assert.ok(ev.indexOf('remote-plan') < ev.indexOf('run-started'), ev.join(','));
    assert.equal(ev[ev.indexOf('task-completed') + 1], 'remote-statuses', 'statuses follow each task event');
    assert.ok(ev.indexOf('run-finished') < ev.indexOf('remote-bundle-chunk'));
    assert.equal(ev[ev.length - 1], 'remote-bundle-end');
    const end = h.lines[h.lines.length - 1];
    assert.equal(end.bytes, 500_000);
    assert.match(String(end.sha256), /^[0-9a-f]{64}$/);
    const chunks = h.lines.filter((l) => l.event === 'remote-bundle-chunk');
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((c) => String(c.data).length <= 512 * 1024));
    // The worktree came from the mirror, on the branch, at the start sha; then removed and pruned.
    assert.ok(h.gitCalls.some((c) => c.args.join(' ') === `worktree add -B moag/remote-1 ${path.join(h.home, REMOTE_HOME_DIR, 'worktrees', 'run-1')} ${SHA}`));
    assert.ok(h.gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove' && !c.args.includes('--force')));
  });

  it('the exec config carries the allotment as every cap even when the project file says 0; env loses MOAG_*/CI and gains the engine key', async () => {
    const h = harness('ok', { projectConfigZero: true });
    // stdin stays open, as the daemon keeps it (EOF would mean stop).
    await runRemoteChild(spec({ allotment: 7 }), h.deps);
    const cfgPath = h.deps.env.MOAG_CONFIG_PATH!;
    assert.equal(cfgPath, path.join(h.home, REMOTE_HOME_DIR, 'runs', 'run-1', 'config.json'));
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).agentTaskPlayer;
    assert.equal(cfg.costBudgetUsd, 7);
    assert.equal(cfg['engines.claude.maxBudgetUsdPerCall'], 7);
    assert.equal(cfg['git.autoCommit'], true);
    assert.equal(cfg['git.branchPrefix'], 'moag/');
    assert.equal(cfg.parallelPlaylists, 1);
    assert.equal(cfg.taskTimeoutMs, REMOTE_TASK_TIMEOUT_MS);
    assert.equal(cfg['engines.claude.autoApprove'], true);
    assert.equal(cfg.fullAuto, false);
    assert.equal(cfg['prdLoop.onManualGate'], 'halt');
    assert.equal(h.deps.env.MOAG_ONOSOO_KEY, undefined);
    assert.equal(h.deps.env.MOAG_OTHER, undefined);
    assert.equal(h.deps.env.CI, undefined);
    assert.equal(h.deps.env.ANTHROPIC_API_KEY, 'sk-test-key-value');
    assert.ok(h.roots.includes(path.join(h.home, REMOTE_HOME_DIR, 'worktrees', 'run-1')), 'the shim is rooted at the worktree');
  });

  it('a PRD run plans with auto-approve off in an empty dir, then strips fields, gates, serialises and caps timeouts', async () => {
    const h = harness();
    // stdin stays open, as the daemon keeps it (EOF would mean stop).
    const code = await runRemoteChild(spec({ goal: 'Make login work', prd: '# PRD\n- R-1 login' }), h.deps);
    assert.equal(code, 0);
    assert.equal(h.plannerSeen.length, 1);
    const seen = h.plannerSeen[0];
    assert.equal(seen.cwd, path.join(h.home, REMOTE_HOME_DIR, 'runs', 'run-1', 'plan-cwd'));
    assert.deepEqual(fs.readdirSync(seen.cwd), [], 'the planner runs in an empty directory');
    assert.equal(seen.config!.agentTaskPlayer['engines.claude.autoApprove'], false);
    assert.equal(seen.config!.agentTaskPlayer['engines.codex.autoApprove'], false);
    assert.ok((seen.config!.agentTaskPlayer['engines.claude.args'] as string[]).includes('--strict-mcp-config'));
    assert.ok(seen.prompt.includes('Goal: Make login work'), 'the goal is prepended to the PRD');
    assert.ok(h.roots.includes(seen.cwd));
    assert.equal(h.deps.env.MOAG_CONFIG_PATH, path.join(h.home, REMOTE_HOME_DIR, 'runs', 'run-1', 'config.json'), 'back on the exec config');
    assert.equal(h.roots[h.roots.length - 1], path.join(h.home, REMOTE_HOME_DIR, 'worktrees', 'run-1'));

    const plan = h.lines.find((l) => l.event === 'remote-plan')!.plan as PlanFile;
    const tasks = plan.playlists.flatMap((pl) => pl.tasks);
    assert.ok(tasks.every((t) => t.env === undefined && t.releaseTag === undefined));
    assert.ok(!JSON.stringify(plan).includes('SECRET'));
    assert.ok(plan.playlists.every((pl) => !pl.parallel));
    assert.ok(tasks.every((t) => (t.timeoutMs ?? 0) <= REMOTE_TASK_TIMEOUT_MS));
    assert.ok(plan.playlists[0].tasks.some((t) => t.type === 'manual'), 'the shipping playlist gets a gate');
    assert.equal(plan.playlists[1].tasks[plan.playlists[1].tasks.length - 1].type, 'manual', 'the last playlist ends at a gate');
  });

  it('planning spend is reported as remote-cost before the plan, so the ledger sees it', async () => {
    const h = harness('ok', { plannerCost: 0.42 });
    const code = await runRemoteChild(spec({ prd: '# PRD' }), h.deps);
    assert.equal(code, 0);
    const ev = events(h);
    assert.ok(ev.indexOf('remote-cost') >= 0 && ev.indexOf('remote-cost') < ev.indexOf('remote-plan'), ev.join(','));
    assert.deepEqual(h.lines.find((l) => l.event === 'remote-cost'), { event: 'remote-cost', usd: 0.42, engine: 'claude' });
  });

  it('a failed plan still reports what planning spent (and an unreported call), then exits 2', async () => {
    const h = harness('ok', { plannerCost: 1.5, plannerExit: 1 });
    assert.equal(await runRemoteChild(spec({ prd: '# PRD' }), h.deps), 2);
    assert.deepEqual(h.lines.find((l) => l.event === 'remote-cost'), { event: 'remote-cost', usd: 1.5, engine: 'claude' });
    assert.ok(!h.lines.some((l) => l.event === 'remote-plan'));
    const u = harness('ok', { plannerCost: 'unreported', plannerExit: 1 });
    await runRemoteChild(spec({ prd: '# PRD' }), u.deps);
    assert.deepEqual(u.lines.find((l) => l.event === 'remote-cost'), { event: 'remote-cost', unreported: true, engine: 'claude' });
  });

  it('a resume snapshot is re-checked in the child: a cwd outside the worktree or a disallowed engine is refused', async () => {
    const bad = JSON.parse(JSON.stringify(GENERATED)) as PlanFile;
    bad.playlists[0].tasks[0].cwd = '../../etc';
    const h = harness();
    assert.equal(await runRemoteChild(spec({ goal: undefined, snapshot: bad }), h.deps), 2);
    assert.ok(h.lines.some((l) => l.event === 'error' && /outside the project/.test(String(l.message))));
    assert.deepEqual(h.runner.started, []);

    const other = JSON.parse(JSON.stringify(GENERATED)) as PlanFile;
    other.playlists[1].tasks[0].engine = 'gemini' as never;
    const g = harness();
    assert.equal(await runRemoteChild(spec({ goal: undefined, snapshot: other, engines: ['claude'] }), g.deps), 2);
    assert.ok(g.lines.some((l) => l.event === 'error' && /"gemini"/.test(String(l.message))));
  });

  it('a resumed plan keeps one gate per playlist (the transform is idempotent)', async () => {
    const once = transformGeneratedPlan(JSON.parse(JSON.stringify(GENERATED)) as PlanFile);
    const twice = transformGeneratedPlan(JSON.parse(JSON.stringify(once)) as PlanFile);
    assert.deepEqual(twice, once);
    const h = harness();
    await runRemoteChild(spec({ goal: undefined, snapshot: once }), h.deps);
    const plan = h.lines.find((l) => l.event === 'remote-plan')!.plan as PlanFile;
    assert.equal(plan.playlists.flatMap((pl) => pl.tasks).filter((t) => t.type === 'manual').length, 2);
  });

  it('reviewRemotePlan accepts a plan that stays inside the worktree on allowed engines', () => {
    assert.equal(reviewRemotePlan(transformGeneratedPlan(JSON.parse(JSON.stringify(GENERATED)) as PlanFile), ['claude']), null);
  });

  it('resumes from the mirror\'s copy of the parent branch at its tip, and reports the tip at the end', async () => {
    const tip = 'd'.repeat(40);
    const h = harness('ok', { mirrorTip: tip });
    const code = await runRemoteChild(spec({ resumeFromMirrorBranch: 'moag/remote-1', expectedTip: tip }), h.deps);
    assert.equal(code, 0);
    const add = h.gitCalls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add')!;
    assert.equal(add.args[add.args.length - 1], tip, 'the worktree starts at the mirror branch tip');
    const bundle = h.gitCalls.find((c) => c.args[0] === 'bundle' && c.args[1] === 'create')!;
    assert.deepEqual(bundle.args.slice(-2), ['--not', SHA], 'cut from the project-known base, so the parent\'s commits travel too');
    assert.equal(h.lines[h.lines.length - 1].tip, tip);
  });

  it('a missing or moved mirror branch is a readable failure before anything is spent', async () => {
    for (const [label, mirrorTip, expectedTip] of [['missing', undefined, undefined], ['moved', 'e'.repeat(40), 'd'.repeat(40)]] as Array<[string, string | undefined, string | undefined]>) {
      const h = harness('ok', { mirrorTip });
      const code = await runRemoteChild(spec({ resumeFromMirrorBranch: 'moag/remote-1', ...(expectedTip ? { expectedTip } : {}) }), h.deps);
      assert.equal(code, 2, label);
      assert.deepEqual(h.lines.slice(0, 2), [
        { event: 'error', message: mirrorBranchGoneMessage('moag/remote-1') },
        { event: 'remote-no-spend' },
      ], label);
      assert.ok(!h.gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add'));
    }
  });

  it('a goal-only resume snapshot gets no ship gate; a PRD one keeps exactly its gates', async () => {
    const plain = { ...JSON.parse(JSON.stringify(GENERATED)), playlists: [JSON.parse(JSON.stringify(GENERATED.playlists[1]))] } as PlanFile;
    const h = harness();
    await runRemoteChild(spec({ goal: undefined, snapshot: plain, planKind: 'goal' }), h.deps);
    const plan = h.lines.find((l) => l.event === 'remote-plan')!.plan as PlanFile;
    assert.ok(!plan.playlists.some((pl) => pl.tasks.some((t) => t.type === 'manual')));
    const g = harness();
    await runRemoteChild(spec({ goal: undefined, snapshot: plain, planKind: 'prd' }), g.deps);
    const gated = g.lines.find((l) => l.event === 'remote-plan')!.plan as PlanFile;
    assert.equal(gated.playlists[0].tasks.filter((t) => t.type === 'manual').length, 1);
  });

  it('a delivery failure is exit 2 with an error, and no task runs', async () => {
    const h = harness('delivery-fails');
    // stdin stays open, as the daemon keeps it (EOF would mean stop).
    const code = await runRemoteChild(spec(), h.deps);
    assert.equal(code, 2);
    assert.deepEqual(h.runner.started, []);
    assert.ok(h.lines.some((l) => l.event === 'error' && /could not deliver/.test(String(l.message))));
  });

  it('EOF before the run starts stops it before anything runs', async () => {
    const h = harness();
    h.stdin.end();
    const code = await runRemoteChild(spec(), h.deps);
    assert.equal(code, 2);
    assert.deepEqual(h.runner.started, []);
    assert.equal(h.watchdogs, 1);
  });

  it('a {"op":"stop"} control line stops the runner and arms the watchdog', async () => {
    const h = harness('wait-for-stop');
    const p = runRemoteChild(spec(), h.deps);
    await new Promise((r) => setTimeout(r, 30));
    h.stdin.write('{"op":"noise"}\n{"op":"stop"}\n');
    const code = await p;
    assert.equal(h.runner.stops, 1);
    assert.equal(h.watchdogs, 1);
    assert.equal(code, 0);
    assert.deepEqual(h.runner.started, []);
    assert.equal(events(h)[events(h).length - 1], 'remote-bundle-end', 'the bundle still goes out after a stop');
  });

  it('EOF on stdin is a stop too', async () => {
    const h = harness('wait-for-stop');
    const p = runRemoteChild(spec(), h.deps);
    await new Promise((r) => setTimeout(r, 30));
    h.stdin.end();
    await p;
    assert.equal(h.runner.stops, 1);
    assert.equal(h.watchdogs, 1);
  });

  it('reads the inbound bundle bytes and fetches HEAD and the branch into the mirror', async () => {
    const h = harness();
    const bytes = Buffer.from('BUNDLE-BYTES');
    h.stdin.write(bytes);
    // stdin stays open, as the daemon keeps it (EOF would mean stop).
    await runRemoteChild(spec({ bundleBytes: bytes.length }), h.deps);
    const fetch = h.gitCalls.find((c) => c.args[0] === 'fetch')!;
    assert.ok(fetch.args.includes('+HEAD:refs/moag/base'));
    assert.ok(fetch.args.includes('+refs/heads/moag/remote-1:refs/remotes/origin/moag/remote-1'));
    assert.equal(fs.readFileSync(path.join(h.home, REMOTE_HOME_DIR, 'repos', 'web', 'info', 'exclude'), 'utf-8'), '.moag/\n');
  });

  it('no new commits → remote-bundle-end with 0 bytes and no chunks', async () => {
    const h = harness('ok', { commits: 0 });
    // stdin stays open, as the daemon keeps it (EOF would mean stop).
    await runRemoteChild(spec(), h.deps);
    assert.ok(!h.lines.some((l) => l.event === 'remote-bundle-chunk'));
    assert.deepEqual(h.lines[h.lines.length - 1], { event: 'remote-bundle-end', bytes: 0, sha256: null });
  });
});

describe('remote child — probe', () => {
  it('reports its uid, which protected files it cannot read, engines (+anthropic, no copilot/custom) and mirror shas', async () => {
    const h = harness();
    const readable = path.join(h.home, 'readable.json');
    fs.writeFileSync(readable, '{}');
    fs.mkdirSync(path.join(h.home, REMOTE_HOME_DIR, 'repos', 'web'), { recursive: true });
    const missing = path.join(h.home, 'nope.json');
    const code = await runRemoteChild({ op: 'probe', protectedPaths: [readable, missing], projects: ['web', 'gone'], engineEnv: { ANTHROPIC_API_KEY: 'k' } }, { ...h.deps, home: h.home });
    assert.equal(code, 0);
    const probe = h.lines[0];
    assert.equal(probe.event, 'remote-probe');
    assert.equal(probe.uid, 1001);
    assert.deepEqual(probe.unreadable, { [readable]: false, [missing]: true });
    assert.deepEqual(probe.engines, ['claude', 'gemini', 'anthropic']);
    assert.deepEqual(probe.mirrors, { web: [SHA, 'b'.repeat(40)] }, 'only real shas, only existing mirrors');
  });
});

describe('remote child — spec and transforms', () => {
  it('parseSpec accepts a run and a probe, rejects anything malformed', () => {
    assert.ok(parseSpec(JSON.stringify(spec())));
    assert.ok(parseSpec(JSON.stringify({ op: 'probe', protectedPaths: ['/a'], projects: ['web'] })));
    const bad: Array<Record<string, unknown>> = [
      { ...spec(), runId: '../x' }, { ...spec(), branch: 'main' }, { ...spec(), baseSha: 'abc' }, { ...spec(), allotment: 0 },
      { ...spec(), goal: undefined }, { ...spec(), engineEnv: { MOAG_ONOSOO_KEY: 'k' } }, { ...spec(), bundleBytes: -1 }, { op: 'other' },
    ];
    for (const b of bad) { assert.equal(parseSpec(JSON.stringify(b)), null, JSON.stringify(b).slice(0, 80)); }
    assert.equal(parseSpec('not json'), null);
  });

  it('transformGeneratedPlan strips side effects, serialises, caps timeouts and adds gates', () => {
    const file = JSON.parse(JSON.stringify(GENERATED)) as PlanFile;
    transformGeneratedPlan(file);
    const [dev, test] = file.playlists;
    assert.equal(dev.parallel, false);
    assert.ok(!('env' in dev.tasks[0]));
    assert.equal(dev.tasks[0].timeoutMs, REMOTE_TASK_TIMEOUT_MS);
    const gate = dev.tasks.find((t) => t.type === 'manual')!;
    assert.ok(dev.tasks.find((t) => t.id === 't2')!.dependsOn!.includes(gate.id), 'the release waits for the gate');
    assert.equal(test.tasks[test.tasks.length - 1].type, 'manual');
  });

  it('ChildInput reads a line, then exact bytes, then control lines', async () => {
    const s = new PassThrough();
    const input = new ChildInput(s);
    s.write('{"op":"run"}\nABCDE{"op":"stop"}\n');
    assert.equal(await input.readLine(), '{"op":"run"}');
    assert.equal((await input.readBytes(5))!.toString(), 'ABCDE');
    const seen: string[] = [];
    let ended = false;
    input.listen((l) => seen.push(l), () => { ended = true; });
    s.end();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['{"op":"stop"}']);
    assert.equal(ended, true);
  });
});
