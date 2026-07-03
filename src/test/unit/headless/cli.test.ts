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
} from '../../../headless/cli';

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
