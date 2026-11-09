// ─── moag run + ONOSOO: Claude JSON output for real cost ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { parseArgs } from '../../../headless/cli';
import * as shim from '../../../headless/vscode-shim';
import { buildExecConfig } from '../../../headless/remote-child';
import { loadPlan } from '../../../models/plan';
import { Plan, TaskStatus } from '../../../models/types';

const FORMAT_KEY = 'agentTaskPlayer.engines.claude.outputFormat';
const NOTICE = 'ONOSOO: using Claude JSON output so ONOSOO shows real cost (set agentTaskPlayer.engines.claude.outputFormat to override).\n';

describe('headless CLI: moag run uses Claude JSON output when connected to ONOSOO', function () {
  this.timeout(20_000);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxyquire = require('proxyquire').noCallThru();
  const KEY = 'onosoo_live_' + 'J'.repeat(43);
  const BASE = 'http://127.0.0.1:54321';
  let stdout: sinon.SinonStub;
  let savedConfigPath: string | undefined;

  beforeEach(() => {
    // Swallow the run's JSONL lines; let mocha's own output through.
    const write = process.stdout.write.bind(process.stdout);
    stdout = sinon.stub(process.stdout, 'write').callsFake((chunk: unknown) => String(chunk).startsWith('{') ? true : write(String(chunk)));
    savedConfigPath = process.env.MOAG_CONFIG_PATH;
    delete process.env.MOAG_CONFIG_PATH;
  });
  afterEach(() => {
    stdout.restore();
    if (savedConfigPath !== undefined) { process.env.MOAG_CONFIG_PATH = savedConfigPath; }
    shim.__setWorkspaceRoot(process.cwd());
  });

  function loadCli() {
    return proxyquire('../../../headless/cli', {
      '../runner/evidence': { detectPrdFile: () => null, captureBaseRef: async () => null, captureHeadRef: async () => null },
      '../adapters/index': { getEngine: () => ({ runTask: async () => { throw new Error('no engine in tests'); } }) },
      '../sandbox/sandbox-manager': { SandboxManager: class {}, isPortOpen: async () => false },
      '../sandbox/project-detector': { detectProject: () => null },
    });
  }

  /** A plan dir (optionally with a .moag/config.json) and a separate user config dir. */
  function workspace(config?: Record<string, unknown>): { dir: string; planFile: string; configDir: string } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-fmt-')));
    const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-fmt-cfg-')));
    const planFile = path.join(dir, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
      version: '1.0', name: 'Fmt plan',
      playlists: [{ id: 'pl', name: 'Build', tasks: [{ id: 't-1', name: 'First', prompt: 'do it' }] }],
    }));
    if (config) {
      fs.mkdirSync(path.join(dir, '.moag'));
      fs.writeFileSync(path.join(dir, '.moag', 'config.json'), JSON.stringify(config));
    }
    shim.__setWorkspaceRoot(dir);
    return { dir, planFile, configDir };
  }

  /** A runner that records the Claude output format the engine would read during the run. */
  function formatRecordingRunner(seen: string[]) {
    const runner = new EventEmitter() as EventEmitter & { stop: () => void; play: (p: Plan) => Promise<void> };
    runner.stop = () => undefined;
    runner.play = async (plan: Plan) => {
      seen.push(String(shim.workspace.getConfiguration('agentTaskPlayer.engines.claude').get('outputFormat', 'text')));
      const t = plan.playlists[0].tasks[0];
      t.status = TaskStatus.Completed;
      runner.emit('task-started', t);
      runner.emit('task-completed', t, { stdout: 'ok', stderr: '' });
    };
    return runner;
  }

  const http = async (req: { body: string }) => {
    const acked: Record<string, number> = {};
    for (const e of (JSON.parse(req.body) as { events: Array<{ run_id: string; seq: number }> }).events) {
      acked[e.run_id] = Math.max(acked[e.run_id] ?? 0, e.seq);
    }
    return { status: 200, body: JSON.stringify({ acked }) };
  };

  async function run(config: Record<string, unknown> | undefined, withKey: boolean): Promise<{ seen: string[]; stderr: string[] }> {
    const { dir, planFile, configDir } = workspace(config);
    const seen: string[] = [];
    const stderr: string[] = [];
    const env: NodeJS.ProcessEnv = withKey
      ? { APPDATA: configDir, XDG_CONFIG_HOME: configDir, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: BASE }
      : { APPDATA: configDir, XDG_CONFIG_HOME: configDir };
    const code = await loadCli().cmdRun(parseArgs(['run', planFile, '--cwd', dir]), {
      runner: formatRecordingRunner(seen), vscode: shim, TaskStatus, loadPlan,
      relayDeps: { env, http, closeDeadlineMs: 2000, stderr: (s: string) => stderr.push(s) },
    });
    assert.equal(code, 0);
    return { seen, stderr };
  }

  it('relay on and the format unset: Claude runs in JSON mode, with one stderr notice, and the override ends with the run', async () => {
    const { seen, stderr } = await run(undefined, true);
    assert.deepEqual(seen, ['json']);
    assert.equal(stderr.filter((s) => s === NOTICE).length, 1, stderr.join(''));
    assert.equal(shim.workspace.getConfiguration('agentTaskPlayer.engines.claude').get('outputFormat', 'text'), 'text', 'no override survives the run');
  });

  it('the override is removed when the run fails: a rejecting play() (code 2) and a throw out of cmdRun', async () => {
    const readFormat = (): unknown => shim.workspace.getConfiguration('agentTaskPlayer.engines.claude').get('outputFormat', 'text');
    const ctxFor = (runner: unknown, configDir: string) => ({
      runner, vscode: shim, TaskStatus, loadPlan,
      relayDeps: {
        env: { APPDATA: configDir, XDG_CONFIG_HOME: configDir, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: BASE },
        http, closeDeadlineMs: 2000, stderr: () => undefined,
      },
    });

    // 1. play() rejects: runAfterWiring reports code 2.
    const a = workspace();
    const seen: string[] = [];
    const rejecting = new EventEmitter() as EventEmitter & { stop: () => void; play: (p: Plan) => Promise<void> };
    rejecting.stop = () => undefined;
    rejecting.play = async () => { seen.push(String(readFormat())); throw new Error('engine crashed'); };
    const code = await loadCli().cmdRun(parseArgs(['run', a.planFile, '--cwd', a.dir]), ctxFor(rejecting, a.configDir));
    assert.equal(code, 2);
    assert.deepEqual(seen, ['json'], 'the override was in force during the run');
    assert.equal(readFormat(), 'text', 'no override survives a rejected play()');

    // 2. Something throws out of cmdRun itself (here: writing the run-started line).
    const b = workspace();
    stdout.callsFake((chunk: unknown) => {
      if (String(chunk).includes('"run-started"')) { throw new Error('stdout closed'); }
      return true;
    });
    await assert.rejects(
      loadCli().cmdRun(parseArgs(['run', b.planFile, '--cwd', b.dir]), ctxFor(formatRecordingRunner([]), b.configDir)),
      /stdout closed/,
    );
    assert.equal(readFormat(), 'text', 'no override survives a thrown run');
  });

  it('relay on and the format unset: the project config file is not written', async () => {
    const { dir, planFile, configDir } = workspace({ agentTaskPlayer: { defaultEngine: 'claude' } });
    const before = fs.readFileSync(path.join(dir, '.moag', 'config.json'), 'utf-8');
    await loadCli().cmdRun(parseArgs(['run', planFile, '--cwd', dir]), {
      runner: formatRecordingRunner([]), vscode: shim, TaskStatus, loadPlan,
      relayDeps: { env: { APPDATA: configDir, XDG_CONFIG_HOME: configDir, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: BASE }, http, closeDeadlineMs: 2000, stderr: () => undefined },
    });
    assert.equal(fs.readFileSync(path.join(dir, '.moag', 'config.json'), 'utf-8'), before);
  });

  const explicitShapes: Array<[string, Record<string, unknown>]> = [
    ['flat', { [FORMAT_KEY]: 'text' }],
    ['sectioned', { agentTaskPlayer: { 'engines.claude.outputFormat': 'text' } }],
    ['nested', { agentTaskPlayer: { engines: { claude: { outputFormat: 'text' } } } }],
  ];
  for (const [shape, config] of explicitShapes) {
    it(`relay on and "text" set explicitly (${shape}): stays text, no notice`, async () => {
      const { seen, stderr } = await run(config, true);
      assert.deepEqual(seen, ['text']);
      assert.ok(!stderr.includes(NOTICE));
    });
  }

  it('relay off: unchanged (text by default, no notice)', async () => {
    const { seen, stderr } = await run(undefined, false);
    assert.deepEqual(seen, ['text']);
    assert.ok(!stderr.includes(NOTICE));
  });

  it('relay off with "json" set: unchanged (json)', async () => {
    const { seen } = await run({ [FORMAT_KEY]: 'json' }, false);
    assert.deepEqual(seen, ['json']);
  });

  it('the remote-child exec config sets the format explicitly, so it reads json with or without a prior relay run', async () => {
    await run(undefined, true); // a relay run that overrode the format has come and gone
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-fmt-rc-')));
    const execConfigPath = path.join(dir, 'config.json');
    fs.writeFileSync(execConfigPath, JSON.stringify(buildExecConfig('claude', 1, 'moag/')));
    process.env.MOAG_CONFIG_PATH = execConfigPath;
    try {
      shim.__setWorkspaceRoot(dir);
      assert.equal(shim.__configFileSets(FORMAT_KEY), true, 'the exec config sets it, so cmdRun would never override it');
      assert.equal(shim.workspace.getConfiguration('agentTaskPlayer.engines.claude').get('outputFormat', 'text'), 'json');
    } finally {
      delete process.env.MOAG_CONFIG_PATH;
    }
  });

  it('shim: an override wins over the file, reads back under any section split, and undefined removes it', () => {
    workspace({ [FORMAT_KEY]: 'text' });
    shim.__setConfigOverride(FORMAT_KEY, 'json');
    try {
      assert.equal(shim.workspace.getConfiguration('agentTaskPlayer.engines.claude').get('outputFormat', 'text'), 'json');
      assert.equal(shim.workspace.getConfiguration('agentTaskPlayer').get('engines.claude.outputFormat', 'text'), 'json');
      assert.equal(shim.__configFileSets(FORMAT_KEY), true, 'the file check ignores overrides');
    } finally {
      shim.__setConfigOverride(FORMAT_KEY, undefined);
    }
    assert.equal(shim.workspace.getConfiguration('agentTaskPlayer.engines.claude').get('outputFormat', 'json'), 'text');
  });
});
