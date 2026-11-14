// ─── Remote runs: local mode (this PC's own user, no runner account) ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadApprovedProjects, PROJECTS_FILE } from '../../../headless/onosoo-projects';
import {
  childCommand, childSpawnEnv, isolationRefusal, LOCAL_MODE_WARNING, localChildCommand, localChildEnv, localKillAction, parseProbe,
  tightenStatePermissions, LOCAL_RUNNER_DIR,
} from '../../../headless/remote-isolation';
import { parseSpec, REMOTE_HOME_DIR, runRemoteChild } from '../../../headless/remote-child';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function stateWith(doc: Record<string, unknown>): string {
  const stateDir = tmp('moag-local-state-');
  fs.writeFileSync(path.join(stateDir, PROJECTS_FILE), JSON.stringify({ version: 1, projects: [], ...doc }));
  return stateDir;
}

describe('local mode — projects.json "mode"', () => {
  it('is isolated unless the file says exactly "local"', () => {
    assert.equal(loadApprovedProjects(stateWith({})).mode, 'isolated');
    assert.equal(loadApprovedProjects(stateWith({ mode: 'isolated' })).mode, 'isolated');
    assert.equal(loadApprovedProjects(stateWith({ mode: 'local' })).mode, 'local');
    assert.equal(loadApprovedProjects(tmp('moag-local-none-')).mode, 'isolated', 'a missing file is isolated');
  });

  it('reports an invalid value and stays isolated; never infers local from the platform', () => {
    for (const bad of ['LOCAL', 'yes', true, 1, null, {}]) {
      const out = loadApprovedProjects(stateWith({ mode: bad }), { platform: 'win32' });
      assert.equal(out.mode, 'isolated', JSON.stringify(bad));
      assert.ok(out.errors.some((e) => /^mode must be "local" or "isolated"/.test(e)), JSON.stringify(bad));
    }
    assert.equal(loadApprovedProjects(stateWith({}), { platform: 'win32' }).mode, 'isolated');
  });

  it('does not touch the other settings: remote_start and the budget still gate', () => {
    const out = loadApprovedProjects(stateWith({ mode: 'local' }));
    assert.equal(out.remoteStart, false);
    assert.equal(out.dailyBudgetUsd, null);
  });
});

describe('local mode — refusal', () => {
  it('local mode needs no Linux and no runner_user, on any platform', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      assert.equal(isolationRefusal(p, null, 'local'), null, p);
    }
  });

  it('isolated mode is unchanged: Windows and macOS are still refused, and so is a missing runner', () => {
    assert.match(isolationRefusal('win32', 'moag-runner')!, /Linux .*Windows/);
    assert.match(isolationRefusal('win32', 'moag-runner', 'isolated')!, /Linux .*Windows/);
    assert.match(isolationRefusal('darwin', null, 'isolated')!, /macOS/);
    assert.match(isolationRefusal('linux', null, 'isolated')!, /runner_user/);
    assert.match(isolationRefusal('linux', 'root', 'isolated')!, /root/);
  });
});

describe('local mode — spawn and kill commands', () => {
  it('runs node + cli.js + remote-child directly: no sudo', () => {
    const c = localChildCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\moag\\out\\headless\\cli.js');
    assert.deepEqual(c, { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\moag\\out\\headless\\cli.js', 'remote-child'] });
    assert.ok(!JSON.stringify(c).includes('sudo'));
    assert.equal(childCommand('r', '/n', '/c').command, 'sudo', 'the isolated command is unchanged');
  });

  it('force-stop on Windows is taskkill of the whole tree', () => {
    assert.deepEqual(localKillAction(4242, 'win32'), { type: 'command', command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
  });

  it('force-stop on POSIX is SIGKILL to the process group', () => {
    for (const p of ['linux', 'darwin'] as const) {
      assert.deepEqual(localKillAction(4242, p), { type: 'group', pgid: 4242, signal: 'SIGKILL' });
    }
  });

  it('never kills for an unusable pid (0, 1, negative, fractional, missing)', () => {
    for (const pid of [undefined, 0, 1, -5, 1.5, Number.NaN]) {
      assert.equal(localKillAction(pid as number | undefined, 'linux'), null);
      assert.equal(localKillAction(pid as number | undefined, 'win32'), null);
    }
  });
});

describe('local mode — child environment', () => {
  const env: NodeJS.ProcessEnv = {
    PATH: 'C:\\bin', Path: 'C:\\bin2', LANG: 'en_US.UTF-8', TZ: 'UTC', LC_ALL: 'C',
    USERPROFILE: 'C:\\Users\\me', HOME: '/home/me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', TMP: 'C:\\t', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.EXE;.CMD',
    XDG_CONFIG_HOME: '/home/me/.config',
    MOAG_ONOSOO_KEY: 'device-key-secret', MOAG_CONFIG_PATH: '/x/onosoo.json', moag_anything: 'x', ONOSOO_KEY: 'k2', ONOSOO_DEVICE_KEY: 'k3',
    CI: 'true', ANTHROPIC_API_KEY: 'sk-engine', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'aws', NPM_TOKEN: 'npm',
  };

  it('passes what an engine CLI needs to find its login (home, profile, temp, shell)', () => {
    const out = localChildEnv(env);
    for (const k of ['PATH', 'Path', 'LANG', 'TZ', 'LC_ALL', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'XDG_CONFIG_HOME']) {
      assert.equal(out[k], env[k], k);
    }
  });

  it('never passes the device key, any MOAG_* or ONOSOO* variable, or CI', () => {
    const out = localChildEnv(env);
    for (const k of Object.keys(out)) {
      assert.ok(!/^moag_/i.test(k) && !/^onosoo/i.test(k) && k !== 'CI', k);
    }
    assert.ok(!Object.values(out).some((v) => v === 'device-key-secret' || v === 'k2' || v === 'k3'));
    assert.ok(!('MOAG_ONOSOO_KEY' in out) && !('MOAG_CONFIG_PATH' in out) && !('CI' in out));
  });

  it('is an allowlist: unlisted secrets (engine keys, tokens) are not inherited; they travel in the job spec', () => {
    const out = localChildEnv(env);
    assert.ok(!('ANTHROPIC_API_KEY' in out) && !('GITHUB_TOKEN' in out) && !('AWS_SECRET_ACCESS_KEY' in out) && !('NPM_TOKEN' in out));
  });

  it('the isolated allowlist is unchanged and smaller', () => {
    assert.deepEqual(Object.keys(childSpawnEnv(env)).sort(), ['LANG', 'LC_ALL', 'PATH', 'TZ']);
    assert.ok(!('HOME' in childSpawnEnv(env)) && !('USERPROFILE' in childSpawnEnv(env)));
  });
});

describe('local mode — probe and job spec', () => {
  const probeLine = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ event: 'remote-probe', uid: -1, unreadable: {}, engines: ['claude', 'copilot', 'custom', 'codex'], mirrors: {}, home: 'C:\\x', ...over });

  it('accepts a probe from the same user (uid -1 on Windows, or the daemon\'s own uid) and drops the excluded engines', () => {
    const out = parseProbe(probeLine(), -1, ['/state/onosoo.json'], { local: true });
    assert.ok(out.ok);
    if (out.ok) { assert.deepEqual(out.engines, ['claude', 'codex']); }
    const same = parseProbe(probeLine({ uid: 1000 }), 1000, ['/state/onosoo.json'], { local: true });
    assert.ok(same.ok, 'same uid is the point of local mode');
  });

  it('isolated parsing is unchanged: the same probe fails the isolation checks', () => {
    const out = parseProbe(probeLine({ uid: 1000 }), 1000, ['/state/onosoo.json']);
    assert.equal(out.ok, false);
  });

  it('parseSpec carries localRoot on a run and a probe, and rejects a relative one', () => {
    const root = path.join(os.tmpdir(), LOCAL_RUNNER_DIR);
    const probe = parseSpec(JSON.stringify({ op: 'probe', protectedPaths: [], projects: [], localRoot: root }));
    assert.ok(probe && probe.localRoot === root);
    assert.ok(parseSpec(JSON.stringify({ op: 'probe', protectedPaths: [], localRoot: 'C:\\Users\\me\\AppData\\Roaming\\moag\\local-runner' })));
    assert.equal(parseSpec(JSON.stringify({ op: 'probe', protectedPaths: [], localRoot: 'relative/dir' })), null);
    assert.equal(parseSpec(JSON.stringify({ op: 'probe', protectedPaths: [], localRoot: 5 })), null);
    assert.equal(parseSpec(JSON.stringify({ op: 'probe', protectedPaths: [] }))!.op, 'probe');
  });

  it('the child keeps mirrors under localRoot, not under the OS home', async () => {
    const root = tmp('moag-local-root-');
    const osHome = tmp('moag-local-oshome-');
    fs.mkdirSync(path.join(root, REMOTE_HOME_DIR, 'repos', 'web'), { recursive: true });
    const lines: Array<Record<string, unknown>> = [];
    const sha = 'a'.repeat(40);
    const code = await runRemoteChild(
      { op: 'probe', protectedPaths: [], projects: ['web'], engineEnv: {}, localRoot: root },
      {
        git: async () => `${sha}\n`,
        input: {} as never,
        emit: (l: Record<string, unknown>) => { lines.push(l); },
        home: osHome,
        uid: -1,
        env: {},
        detectEngines: async () => ['claude'],
      } as never,
    );
    assert.equal(code, 0);
    assert.deepEqual(lines[0].mirrors, { web: [sha] });
    assert.equal(lines[0].home, root);
  });
});

describe('local mode — state directory', () => {
  it('has a warning that says the user\'s own privileges', () => {
    assert.match(LOCAL_MODE_WARNING, /LOCAL MODE/);
    assert.match(LOCAL_MODE_WARNING, /own privileges/);
    assert.ok(!LOCAL_MODE_WARNING.includes('\n'), 'one line');
  });

  it('tightening permissions leaves the local runner directory alone', function () {
    if (process.platform === 'win32') { this.skip(); }
    const state = tmp('moag-local-tighten-');
    const script = path.join(state, LOCAL_RUNNER_DIR, 'worktrees', 'r1', 'run.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(state, 'onosoo.json'), '{}', { mode: 0o644 });
    assert.deepEqual(tightenStatePermissions(state), []);
    assert.equal(fs.statSync(script).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(state, 'onosoo.json')).mode & 0o777, 0o600);
  });
});
