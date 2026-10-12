// ─── Remote runs: isolation helpers ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkRunnerUid, checkStateSecurity, childCommand, childSpawnEnv, engineEnvFrom, forceKillCommand, isolationRefusal, NO_PROBE_ANSWER, parseProbe,
  protectedStatePaths, resolveRunnerUid, SUDOERS_EXAMPLE, tightenStatePermissions,
} from '../../../headless/remote-isolation';

const PROTECTED = ['/home/me/.config/moag/onosoo.json', '/home/me/.config/moag/projects.json', '/home/me/.config/moag/remote/spend.json', '/home/me/.config/moag/remote/audit.jsonl'];
const allUnreadable = Object.fromEntries(PROTECTED.map((p) => [p, true]));
const probeLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ event: 'remote-probe', uid: 1001, unreadable: allUnreadable, engines: ['claude', 'copilot', 'custom', 'ollama'], mirrors: { web: ['a'.repeat(40), 'not-a-sha'] }, ...over });

describe('remote isolation — refusal', () => {
  it('refuses Windows and macOS, a missing runner_user, and root', () => {
    assert.match(isolationRefusal('win32', 'moag-runner')!, /Linux .*Windows/);
    assert.match(isolationRefusal('darwin', 'moag-runner')!, /macOS/);
    assert.match(isolationRefusal('linux', null)!, /runner_user/);
    assert.match(isolationRefusal('linux', 'root')!, /root/);
    assert.equal(isolationRefusal('linux', 'moag-runner'), null);
  });
});

describe('remote isolation — commands and environments', () => {
  it('builds exactly the commands the sudoers rule allows', () => {
    assert.deepEqual(childCommand('moag-runner', '/usr/bin/node', '/opt/moag/out/headless/cli.js'), {
      command: 'sudo', args: ['-n', '-u', 'moag-runner', '--', '/usr/bin/node', '/opt/moag/out/headless/cli.js', 'remote-child'],
    });
    assert.deepEqual(forceKillCommand('moag-runner'), { command: 'sudo', args: ['-n', '-u', 'moag-runner', '--', '/usr/bin/kill', '-KILL', '-1'] });
    assert.ok(SUDOERS_EXAMPLE.includes('/usr/bin/kill -KILL -1'));
    assert.ok(SUDOERS_EXAMPLE.includes('remote-child'));
  });

  it('the child env keeps PATH, LANG, LC_*, TZ only: never MOAG_ONOSOO_KEY, never CI, never a key', () => {
    const env = childSpawnEnv({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', TZ: 'UTC', HOME: '/home/me',
      MOAG_ONOSOO_KEY: 'k', MOAG_ONOSOO_URL: 'u', MOAG_CONFIG_PATH: 'c', CI: 'true', ANTHROPIC_API_KEY: 'sk', SSH_AUTH_SOCK: '/tmp/s',
    });
    assert.deepEqual(env, { PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', TZ: 'UTC' });
  });

  it('engineEnvFrom copies only the engine credentials', () => {
    assert.deepEqual(engineEnvFrom({ ANTHROPIC_API_KEY: 'a', OLLAMA_HOST: 'h', MOAG_ONOSOO_KEY: 'k', OPENAI_API_KEY: '', PATH: '/x' }), { ANTHROPIC_API_KEY: 'a', OLLAMA_HOST: 'h' });
  });
});

describe('remote isolation — probe', () => {
  it('passes the runner home through when it is absolute', () => {
    const out = parseProbe(probeLine({ home: '/home/moag-runner' }), 1000, PROTECTED);
    assert.ok(out.ok && out.home === '/home/moag-runner');
    const rel = parseProbe(probeLine({ home: 'relative' }), 1000, PROTECTED);
    assert.ok(rel.ok && rel.home === undefined);
  });

  it('accepts a different non-root uid that could read none of the protected files; drops copilot/custom and bad shas', () => {
    const out = parseProbe(`noise\n${probeLine()}\n`, 1000, PROTECTED);
    assert.deepEqual(out, { ok: true, uid: 1001, engines: ['claude', 'ollama'], mirrors: { web: ['a'.repeat(40)] } });
  });

  const refused: Array<[string, string]> = [
    ['uid 0', probeLine({ uid: 0 })],
    ['the same uid', probeLine({ uid: 1000 })],
    ['a readable onosoo.json', probeLine({ unreadable: { ...allUnreadable, [PROTECTED[0]]: false } })],
    ['an unreported path', probeLine({ unreadable: { [PROTECTED[0]]: true } })],
    ['no uid', probeLine({ uid: 'x' })],
    ['no probe line', '{"event":"other"}'],
    ['garbage', 'not json'],
  ];
  for (const [label, stdout] of refused) {
    it(`refuses ${label}`, () => {
      const out = parseProbe(stdout, 1000, PROTECTED);
      assert.equal(out.ok, false);
      assert.ok(!out.ok && out.reason.length > 0);
    });
  }
});

describe('remote isolation — the daemon\'s own checks', () => {
  it('only the FIRST probe line counts', () => {
    const second = probeLine({ uid: 0 });
    const out = parseProbe(`${probeLine()}\n${second}\n`, 1000, PROTECTED);
    assert.ok(out.ok && out.uid === 1001);
    const flipped = parseProbe(`${second}\n${probeLine()}\n`, 1000, PROTECTED);
    assert.equal(flipped.ok, false);
  });

  it('no answer points at a sudoers mismatch', () => {
    const out = parseProbe('', 1000, PROTECTED);
    assert.ok(!out.ok && /sudoers rule/.test(out.reason) && out.reason === NO_PROBE_ANSWER);
  });

  it('checkRunnerUid: resolved, not root, not MOAG, and the uid the probe ran as', () => {
    assert.equal(checkRunnerUid(1001, 1001, 1000), null);
    assert.match(checkRunnerUid(null, 1001, 1000)!, /could not look up/);
    assert.match(checkRunnerUid(0, 0, 1000)!, /root/);
    assert.match(checkRunnerUid(1000, 1000, 1000)!, /same account/);
    assert.match(checkRunnerUid(1002, 1001, 1000)!, /different account/);
  });

  it('resolveRunnerUid uses id -u and refuses unsafe names', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]): Promise<string> => { calls.push([cmd, ...args]); return '1001\n'; };
    assert.equal(await resolveRunnerUid('moag-runner', exec), 1001);
    assert.deepEqual(calls, [['id', '-u', 'moag-runner']]);
    assert.equal(await resolveRunnerUid('bad;name', exec), null);
    assert.equal(await resolveRunnerUid('ghost', async () => { throw new Error('no such user'); }), null);
  });

  it('the protected list covers every private file and the run records', () => {
    const list = protectedStatePaths('/s').map((p) => p.replace(/\\/g, '/'));
    for (const want of ['/s/onosoo.json', '/s/projects.json', '/s/remote/spend.json', '/s/remote/audit.jsonl', '/s/remote/audit.1.jsonl', '/s/remote/outbox.json', '/s/remote/runs']) {
      assert.ok(list.includes(want), want);
    }
  });

  it('checkStateSecurity: private dirs and files pass; a group-readable file or a 0755 dir is refused (POSIX)', function () {
    assert.equal(checkStateSecurity('/anything', 1, 'win32'), null);
    if (process.platform === 'win32' || typeof process.getuid !== 'function') { this.skip(); }
    const uid = (process.getuid as () => number)();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-sec-'));
    fs.mkdirSync(path.join(dir, 'remote'), { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, 'onosoo.json'), '{}', { mode: 0o600 });
    assert.equal(checkStateSecurity(dir, uid, 'linux'), null);
    fs.chmodSync(path.join(dir, 'onosoo.json'), 0o640);
    assert.match(checkStateSecurity(dir, uid, 'linux')!, /onosoo\.json is readable/);
    fs.chmodSync(path.join(dir, 'onosoo.json'), 0o600);
    fs.chmodSync(dir, 0o755);
    assert.match(checkStateSecurity(dir, uid, 'linux')!, /mode 755/);
    assert.match(checkStateSecurity(dir, uid + 1, 'linux')!, /another account/);
  });
});

describe('remote isolation — tightenStatePermissions', () => {
  it('sets 0700 on directories and 0600 on files (POSIX); a no-op on win32', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-iso-'));
    fs.mkdirSync(path.join(dir, 'remote'));
    fs.writeFileSync(path.join(dir, 'onosoo.json'), '{}', { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'remote', 'audit.jsonl'), '', { mode: 0o644 });
    assert.deepEqual(tightenStatePermissions(dir, 'win32'), []);
    if (process.platform === 'win32') { this.skip(); }
    assert.deepEqual(tightenStatePermissions(dir, 'linux'), []);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'remote')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'onosoo.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'remote', 'audit.jsonl')).mode & 0o777, 0o600);
  });
});
