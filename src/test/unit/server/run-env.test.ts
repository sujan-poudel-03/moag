import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildWorkerEnv, buildWorkerConfig, buildPlanWorkerConfig, referencedEngines, isForbiddenWorkerEnvName, CODEX_PLAN_ARGS,
  CLAUDE_PLAN_ARGS, PLANNER_LOCKED_ENGINES, plannerFileAccessRefusal, perCallBudgetUsd,
} from '../../../server/run-env';
import { ENGINE_IDS } from '../../../models/types';
import { workspace as shimWorkspace, __setWorkspaceRoot } from '../../../headless/vscode-shim';
import { KEYED_ENGINE_ENV } from '../../../server/secrets';
import { Plan } from '../../../models/types';

const SERVER_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/moag',
  LANG: 'C.UTF-8',
  HTTPS_PROXY: 'http://proxy:3128',
  no_proxy: 'localhost',
  GIT_AUTHOR_NAME: 'MOAG',
  GIT_COMMITTER_EMAIL: 'moag@example.com',
  OLLAMA_HOST: 'http://ollama:11434',
  CI: 'true',
  MOAG_MASTER_KEY: 'master-secret-value',
  MOAG_BOOTSTRAP_TOKEN: 'bootstrap-secret-value-xyz',
  MOAG_DATA_DIR: '/data',
  MOAG_CONFIG_PATH: '/repo/.moag/config.json',
  ANTHROPIC_API_KEY: 'sk-ant-server-env',
  GH_TOKEN: 'ghp_server',
  AWS_SECRET_ACCESS_KEY: 'aws',
  SESSION_SECRET: 'sess',
};

describe('run-env', () => {
  describe('buildWorkerEnv', () => {
    it('drops CI, every MOAG_* secret, and un-listed credentials', () => {
      const env = buildWorkerEnv(SERVER_ENV, { passthrough: [], engineCredentials: {}, configPath: '/data/runs/r1/config.json' });
      for (const k of ['CI', 'MOAG_MASTER_KEY', 'MOAG_BOOTSTRAP_TOKEN', 'MOAG_DATA_DIR', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SESSION_SECRET']) {
        assert.equal(k in env, false, `${k} must not reach the worker`);
      }
      const serialized = JSON.stringify(env);
      for (const secret of ['master-secret-value', 'bootstrap-secret-value-xyz', 'sk-ant-server-env', 'ghp_server']) {
        assert.equal(serialized.includes(secret), false, secret);
      }
    });

    it('keeps the allowlist and git identity', () => {
      const env = buildWorkerEnv(SERVER_ENV, { passthrough: [], engineCredentials: {}, configPath: '/c.json' });
      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.HOME, '/home/moag');
      assert.equal(env.LANG, 'C.UTF-8');
      assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
      assert.equal(env.no_proxy, 'localhost');
      assert.equal(env.GIT_AUTHOR_NAME, 'MOAG');
      assert.equal(env.GIT_COMMITTER_EMAIL, 'moag@example.com');
      assert.equal(env.OLLAMA_HOST, 'http://ollama:11434');
    });

    it('sets MOAG_CONFIG_PATH to the server-generated config, overriding any inherited value', () => {
      const env = buildWorkerEnv(SERVER_ENV, { passthrough: [], engineCredentials: {}, configPath: '/data/runs/r1/config.json' });
      assert.equal(env.MOAG_CONFIG_PATH, '/data/runs/r1/config.json');
    });

    it('passes through operator-listed names but never CI or MOAG_*', () => {
      const env = buildWorkerEnv(SERVER_ENV, { passthrough: ['GH_TOKEN', 'CI', 'MOAG_MASTER_KEY', 'NOT_SET'], engineCredentials: {}, configPath: '/c' });
      assert.equal(env.GH_TOKEN, 'ghp_server');
      assert.equal('CI' in env, false);
      assert.equal('MOAG_MASTER_KEY' in env, false);
      assert.equal('NOT_SET' in env, false);
    });

    it('injects a keyed-engine credential', () => {
      const env = buildWorkerEnv(SERVER_ENV, { passthrough: [], engineCredentials: { ANTHROPIC_API_KEY: 'sk-ant-from-store' }, configPath: '/c' });
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-from-store');
    });

    it('refuses a credential name outside KEYED_ENGINE_ENV', () => {
      assert.throws(() => buildWorkerEnv(SERVER_ENV, { passthrough: [], engineCredentials: { PATH: '/evil' }, configPath: '/c' }), /not a keyed-engine/);
      assert.throws(() => buildWorkerEnv(SERVER_ENV, { passthrough: [], engineCredentials: { CI: 'true' }, configPath: '/c' }), /not a keyed-engine/);
    });

    it('KEYED_ENGINE_ENV is closed and frozen', () => {
      assert.deepEqual({ ...KEYED_ENGINE_ENV }, { anthropic: 'ANTHROPIC_API_KEY' });
      assert.equal(Object.isFrozen(KEYED_ENGINE_ENV), true);
      assert.equal(isForbiddenWorkerEnvName('moag_x'), true);
    });
  });

  describe('referencedEngines', () => {
    it('collects default, fallback, playlist, task and consensus engines', () => {
      const plan = {
        version: '1', name: 'p', defaultEngine: 'claude', fallbackEngine: 'codex',
        validation: {},
        playlists: [
          { id: 'a', name: 'a', engine: 'gemini', tasks: [{ id: 't1', name: 't', prompt: '', engine: 'anthropic' }] },
          { id: 'b', name: 'b', tasks: [{ id: 't2', name: 't', prompt: '', consensus: { engines: ['ollama'], strategy: 'first-pass' } }] },
        ],
      } as unknown as Plan;
      assert.deepEqual([...referencedEngines(plan)].sort(), ['anthropic', 'claude', 'codex', 'gemini', 'ollama']);
    });

    it('a claude-only plan references no keyed engine', () => {
      const plan = { version: '1', name: 'p', defaultEngine: 'claude', validation: {}, playlists: [{ id: 'a', name: 'a', tasks: [] }] } as unknown as Plan;
      const engines = referencedEngines(plan);
      assert.equal([...engines].some((e) => e in KEYED_ENGINE_ENV), false);
    });
  });

  describe('buildWorkerConfig', () => {
    it('always halts on the manual gate and keeps fullAuto off, UAT off', () => {
      for (const [cap, remaining] of [[10, 6.5], [0, 0], [0, 123]] as const) {
        const c = buildWorkerConfig({ defaultEngine: 'codex', versionBudgetUsd: cap }, remaining);
        assert.equal(c.agentTaskPlayer['prdLoop.onManualGate'], 'halt');
        assert.equal(c.agentTaskPlayer.fullAuto, false);
        assert.equal(c.agentTaskPlayer['prdLoop.uat.mode'], 'off');
        assert.equal(c.agentTaskPlayer.defaultEngine, 'codex');
      }
    });

    it('always carries the operator dependency-install keys (default on, scripts run)', () => {
      const d = buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0).agentTaskPlayer;
      assert.equal(d.autoInstallDependencies, true);
      assert.equal(d['dependencyInstall.ignoreScripts'], false);
      assert.equal('dependencyInstall.pythonVenv' in d, false, 'pythonVenv is never sent to the worker');
      const s = buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0, null, null, { enabled: false, ignoreScripts: true }).agentTaskPlayer;
      assert.equal(s.autoInstallDependencies, false);
      assert.equal(s['dependencyInstall.ignoreScripts'], true);
    });

    it('sets both ceilings to the remaining amount when a cap exists', () => {
      const c = buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, 6.58);
      assert.equal(c.agentTaskPlayer.costBudgetUsd, 6.58);
      assert.equal(c.agentTaskPlayer['prdLoop.versionBudgetUsd'], 6.58);
    });

    it('uses 0 ("no cap") only when the project cap is 0', () => {
      const c = buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 99);
      assert.equal(c.agentTaskPlayer.costBudgetUsd, 0);
      assert.equal(c.agentTaskPlayer['prdLoop.versionBudgetUsd'], 0);
    });

    it('refuses an exhausted cap instead of silently passing 0 (= unlimited)', () => {
      assert.throws(() => buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, 0), /exhausted/);
      assert.throws(() => buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, -0.02), /exhausted/);
      assert.throws(() => buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, NaN), /exhausted/);
    });

    it('runs Claude in JSON mode with a per-call cap of min(remaining cap, server per-call max)', () => {
      const per = (cap: number, remaining: number, max: number | null) =>
        buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: cap }, remaining, max).agentTaskPlayer['engines.claude.maxBudgetUsdPerCall'];
      assert.equal(per(10, 5, null), 5, 'cap 5 remaining, no server max');
      assert.equal(per(10, 5, 1.5), 1.5, 'the server max is smaller');
      assert.equal(per(10, 0.75, 1.5), 0.75, 'the remaining cap is smaller');
      assert.equal(per(0, 99, null), 0, 'no cap and no max: no per-call flag');
      assert.equal(per(0, 99, 2), 2, 'no project cap: the server max alone');
      assert.equal(buildWorkerConfig({ defaultEngine: 'codex', versionBudgetUsd: 0 }, 0).agentTaskPlayer['engines.claude.outputFormat'], 'json');
      assert.equal(perCallBudgetUsd(5, null), 5);
      assert.equal(perCallBudgetUsd(0, null), 0);
    });

    it('carries the operator gate timeout as prdLoop.gateTimeoutMs, and leaves it out when none is set', () => {
      const set = buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0, null, 1_800_000).agentTaskPlayer;
      assert.equal(set['prdLoop.gateTimeoutMs'], 1_800_000);
      const unset = buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0, null).agentTaskPlayer;
      assert.equal('prdLoop.gateTimeoutMs' in unset, false, 'null: verify keeps its own default');
      assert.equal('prdLoop.gateTimeoutMs' in buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0, null, null).agentTaskPlayer, false);
    });

    it('a run config leaves engine auto-approve at its defaults', () => {
      const c = buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0).agentTaskPlayer as Record<string, unknown>;
      assert.equal('engines.claude.autoApprove' in c, false);
    });
  });

  describe('buildPlanWorkerConfig', () => {
    it('disables auto-approve for claude and codex and gives gemini no extra args, keeping the run guards', () => {
      const c = buildPlanWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, 4).agentTaskPlayer;
      assert.equal(c['engines.claude.autoApprove'], false);
      assert.equal(c['engines.codex.autoApprove'], false);
      assert.deepEqual(c['engines.gemini.args'], []);
      assert.deepEqual(c['engines.codex.args'], [...CODEX_PLAN_ARGS]);
      assert.ok(c['engines.codex.args'].includes('--skip-git-repo-check'));
      assert.deepEqual(c['engines.claude.args'], [...CLAUDE_PLAN_ARGS]);
      assert.deepEqual(c['engines.claude.args'], ['-p', '--strict-mcp-config', '--tools', '']);
      assert.equal('engines.claude.args' in buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0).agentTaskPlayer, false, 'run jobs keep the configured claude args (agents need tools)');
      assert.equal('engines.codex.args' in buildWorkerConfig({ defaultEngine: 'codex', versionBudgetUsd: 0 }, 0).agentTaskPlayer, false, 'run jobs keep the configured codex args');
      assert.equal(c['prdLoop.onManualGate'], 'halt');
      assert.equal(c.fullAuto, false);
      assert.equal(c.costBudgetUsd, 4);
      assert.equal(c.defaultEngine, 'claude');
      assert.throws(() => buildPlanWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, 0), /exhausted/);
    });

    it('inherits JSON mode and the per-call cap', () => {
      const c = buildPlanWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, 4, 1).agentTaskPlayer;
      assert.equal(c['engines.claude.outputFormat'], 'json');
      assert.equal(c['engines.claude.maxBudgetUsdPerCall'], 1);
    });

    it('the headless shim reads the plan config the way the adapters ask for it', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-plancfg-'));
      const prev = process.env.MOAG_CONFIG_PATH;
      try {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify(buildPlanWorkerConfig({ defaultEngine: 'codex', versionBudgetUsd: 0 }, 0)));
        process.env.MOAG_CONFIG_PATH = file;
        __setWorkspaceRoot(dir); // drop the cached config
        // Exactly the lookups in claude-adapter.ts / codex-adapter.ts / gemini-adapter.ts (default true / ['-p'] / []).
        assert.equal(shimWorkspace.getConfiguration('agentTaskPlayer.engines.claude').get<boolean>('autoApprove', true), false);
        assert.equal(shimWorkspace.getConfiguration('agentTaskPlayer.engines.codex').get<boolean>('autoApprove', true), false);
        assert.deepEqual(shimWorkspace.getConfiguration('agentTaskPlayer.engines.gemini').get<string[]>('args', ['--yolo']), []);
        // Codex: the exact lookup in codex-adapter.ts (default []) yields the plan-only args.
        assert.deepEqual(shimWorkspace.getConfiguration('agentTaskPlayer.engines.codex').get<string[]>('args', []), [...CODEX_PLAN_ARGS]);
        // Claude: the exact lookup in claude-adapter.ts (default ['-p']) yields the no-tools args.
        assert.deepEqual(shimWorkspace.getConfiguration('agentTaskPlayer.engines.claude').get<string[]>('args', ['-p']), [...CLAUDE_PLAN_ARGS]);
        // JSON mode and the per-call cap: the exact lookups in claude-adapter.ts (defaults 'text' / 0).
        assert.equal(shimWorkspace.getConfiguration('agentTaskPlayer.engines.claude').get<string>('outputFormat', 'text'), 'json');
        assert.equal(shimWorkspace.getConfiguration('agentTaskPlayer.engines.claude').get<number>('maxBudgetUsdPerCall', 0), 0);
      } finally {
        if (prev === undefined) { delete process.env.MOAG_CONFIG_PATH; } else { process.env.MOAG_CONFIG_PATH = prev; }
        __setWorkspaceRoot(process.cwd());
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('the headless shim hands verify the run config gate timeout the way cli.ts asks for it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-runcfg-'));
    const prev = process.env.MOAG_CONFIG_PATH;
    try {
      const file = path.join(dir, 'config.json');
      process.env.MOAG_CONFIG_PATH = file;
      // The exact lookup in headless/cli.ts (default 600000).
      const lookup = (): number | undefined => shimWorkspace.getConfiguration('agentTaskPlayer').get<number>('prdLoop.gateTimeoutMs', 600_000);
      fs.writeFileSync(file, JSON.stringify(buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0, null, 1_800_000)));
      __setWorkspaceRoot(dir);
      assert.equal(lookup(), 1_800_000);
      fs.writeFileSync(file, JSON.stringify(buildWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 0 }, 0, null, null)));
      __setWorkspaceRoot(dir);
      assert.equal(lookup(), 600_000, 'no operator value: the verify default');
    } finally {
      if (prev === undefined) { delete process.env.MOAG_CONFIG_PATH; } else { process.env.MOAG_CONFIG_PATH = prev; }
      __setWorkspaceRoot(process.cwd());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('planner lockdown', () => {
    it('only engines that can be denied every file/tool may plan by default', () => {
      assert.deepEqual([...PLANNER_LOCKED_ENGINES].sort(), ['claude', 'codex', 'ollama']);
      for (const e of ['claude', 'codex', 'ollama'] as const) { assert.equal(plannerFileAccessRefusal(e, false), null, e); }
      for (const e of ['gemini', 'anthropic'] as const) {
        assert.match(plannerFileAccessRefusal(e, false) ?? '', /can't plan without its file/, e);
        assert.equal(plannerFileAccessRefusal(e, true), null, `${e} with the admin override`);
      }
    });

    it('the anthropic refusal says the override grants shell execution and file writes', () => {
      const msg = plannerFileAccessRefusal('anthropic', false) ?? '';
      assert.match(msg, /shell/);
      assert.match(msg, /write/);
      assert.match(msg, /^anthropic /);
    });

    it('the gemini refusal names its file tools and does not mention shell', () => {
      const msg = plannerFileAccessRefusal('gemini', false) ?? '';
      assert.match(msg, /^gemini can't plan without its file tools/);
      assert.doesNotMatch(msg, /shell/i);
    });

    it('custom and copilot are still refused with the generic message', () => {
      for (const e of ['custom', 'copilot'] as const) { assert.match(plannerFileAccessRefusal(e, false) ?? '', /reading files/, e); }
    });

    it('every server engine is classified: locked down, or refused unless overridden', () => {
      for (const e of ENGINE_IDS) {
        const refused = plannerFileAccessRefusal(e, false) !== null;
        assert.equal(refused, !PLANNER_LOCKED_ENGINES.includes(e), e);
      }
    });
  });
});
