import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWorkerEnv, buildWorkerConfig, buildPlanWorkerConfig, referencedEngines, isForbiddenWorkerEnvName, CODEX_PLAN_ARGS } from '../../../server/run-env';
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
      assert.equal('engines.codex.args' in buildWorkerConfig({ defaultEngine: 'codex', versionBudgetUsd: 0 }, 0).agentTaskPlayer, false, 'run jobs keep the configured codex args');
      assert.equal(c['prdLoop.onManualGate'], 'halt');
      assert.equal(c.fullAuto, false);
      assert.equal(c.costBudgetUsd, 4);
      assert.equal(c.defaultEngine, 'claude');
      assert.throws(() => buildPlanWorkerConfig({ defaultEngine: 'claude', versionBudgetUsd: 10 }, 0), /exhausted/);
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
      } finally {
        if (prev === undefined) { delete process.env.MOAG_CONFIG_PATH; } else { process.env.MOAG_CONFIG_PATH = prev; }
        __setWorkspaceRoot(process.cwd());
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
