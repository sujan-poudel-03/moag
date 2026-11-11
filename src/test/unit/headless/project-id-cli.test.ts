// ─── moag project-id: print the ONOSOO project ID runs from a folder report ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { cmdProjectId, PROJECT_ID_DEADLINE_MS, PROJECT_ID_REASON_PHRASES, PROJECT_ID_USAGE, ProjectIdCliDeps } from '../../../headless/project-id';
import type { IdentityAbsenceReason } from '../../../headless/project-id';
import type { ProjectIdentityResolution } from '../../../headless/project-identity';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const DEVICE_KEY = 'onosoo_live_' + 'D'.repeat(43);
const ROOT = 'root:' + 'a'.repeat(40);

describe('moag project-id', () => {
  let ws: string;
  let cfg: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    ws = tmp('moag-pid-cli-ws-');
    cfg = tmp('moag-pid-cli-cfg-');
    out = [];
    err = [];
  });

  /** Run with an isolated user config dir and a stubbed resolver. */
  function run(argv: string[], resolution: ProjectIdentityResolution | (() => Promise<ProjectIdentityResolution>), extra: Partial<ProjectIdCliDeps> & { envExtra?: NodeJS.ProcessEnv } = {}) {
    const resolve = sinon.spy(typeof resolution === 'function'
      ? (_dir: string) => resolution()
      : async (_dir: string) => resolution);
    const env: NodeJS.ProcessEnv = { APPDATA: cfg, XDG_CONFIG_HOME: cfg, ...(extra.envExtra ?? {}) };
    const p = cmdProjectId(argv, {
      env, cwd: ws, out: (s) => out.push(s), err: (s) => err.push(s), resolve, ...extra,
    });
    return { p, resolve };
  }

  it('git: with a URL prints two lines, exit 0, nothing on stderr', async () => {
    const { p, resolve } = run([], { identity: { project_key: 'git:github.com/o/r', repo_url: 'https://github.com/O/R' }, reason: null });
    assert.equal(await p, 0);
    assert.equal(out.join(''), 'git:github.com/o/r\nhttps://github.com/O/R\n');
    assert.equal(err.join(''), '');
    assert.equal(resolve.firstCall.args[0], ws, 'defaults to the working directory');
  });

  it('root: prints one line', async () => {
    const { p } = run([], { identity: { project_key: ROOT, repo_url: 'https://github.com/o/r' }, reason: null });
    assert.equal(await p, 0);
    assert.equal(out.join(''), ROOT + '\n');
  });

  it('--cwd resolves against the working directory', async () => {
    fs.mkdirSync(path.join(ws, 'sub'));
    const { p, resolve } = run(['--cwd', 'sub'], { identity: { project_key: ROOT }, reason: null });
    assert.equal(await p, 0);
    assert.equal(resolve.firstCall.args[0], path.join(ws, 'sub'));
  });

  it('--json success: exactly project_key, repo_url, reason — no repos, no path, no device key', async () => {
    const identity = { project_key: 'multi:' + 'f'.repeat(64), repos: [{ dir: 'a', key: ROOT, repo_url: 'https://github.com/o/a' }] };
    const { p } = run(['--json'], { identity, reason: null }, { envExtra: { MOAG_ONOSOO_KEY: DEVICE_KEY, MOAG_ONOSOO_URL: 'https://xyz.supabase.co' } });
    assert.equal(await p, 0);
    const text = out.join('');
    assert.equal(text.split('\n').filter(Boolean).length, 1);
    const obj = JSON.parse(text);
    assert.deepEqual(Object.keys(obj), ['project_key', 'repo_url', 'reason']);
    assert.deepEqual(obj, { project_key: identity.project_key, repo_url: null, reason: null });
    for (const bad of ['repos', ws, cfg, DEVICE_KEY, 'github.com/o/a']) { assert.ok(!text.includes(bad), bad); }
    assert.equal(err.join(''), '');
  });

  const ABSENT: IdentityAbsenceReason[] = ['not_a_repo', 'git_unreadable', 'no_commits', 'shallow_no_origin'];
  for (const reason of ABSENT) {
    it(`${reason}: exit 1, nothing on stdout, the phrase on stderr; --json carries the id`, async () => {
      const { p } = run([], { identity: null, reason });
      assert.equal(await p, 1);
      assert.equal(out.join(''), '');
      assert.equal(err.join(''), `moag project-id: no ONOSOO project ID — ${PROJECT_ID_REASON_PHRASES[reason]}\n`);
      out = []; err = [];
      const j = run(['--json'], { identity: null, reason });
      assert.equal(await j.p, 1);
      assert.deepEqual(JSON.parse(out.join('')), { project_key: null, repo_url: null, reason });
      assert.equal(err.join(''), `moag project-id: no ONOSOO project ID — ${PROJECT_ID_REASON_PHRASES[reason]}\n`);
    });
  }

  it('not_sent (a key containing the folder): exit 1, the key is never printed', async () => {
    const key = 'git:' + path.join(ws, 'repo');
    const { p } = run([], { identity: { project_key: key }, reason: null });
    assert.equal(await p, 1);
    assert.equal(out.join(''), '');
    assert.equal(err.join(''), "moag project-id: no ONOSOO project ID — its ID would not be sent to ONOSOO (MOAG's privacy filter would change it)\n");
    out = []; err = [];
    const j = run(['--json'], { identity: { project_key: key }, reason: null });
    assert.equal(await j.p, 1);
    assert.deepEqual(JSON.parse(out.join('')), { project_key: null, repo_url: null, reason: 'not_sent' });
    assert.ok(!out.join('').includes(ws) && !err.join('').includes(key));
  });

  it('paired: a key containing the device key is not sent; unpaired, the same key is (criterion 20)', async () => {
    const key = 'git:github.com/o/' + DEVICE_KEY;
    const paired = run([], { identity: { project_key: key }, reason: null }, { envExtra: { MOAG_ONOSOO_KEY: DEVICE_KEY, MOAG_ONOSOO_URL: 'https://xyz.supabase.co' } });
    assert.equal(await paired.p, 1);
    assert.ok(!err.join('').includes(DEVICE_KEY));
    assert.ok(err.join('').includes('would not be sent'));
    out = []; err = [];
    const unpaired = run([], { identity: { project_key: key }, reason: null });
    assert.equal(await unpaired.p, 0);
    assert.equal(out.join(''), key + '\n');
  });

  it('an engine key in env is redacted like moag run does', async () => {
    const engineKey = 'EnvAnthropicValue' + 'E'.repeat(16);
    const { p } = run([], { identity: { project_key: 'git:github.com/o/' + engineKey }, reason: null }, { envExtra: { ANTHROPIC_API_KEY: engineKey } });
    assert.equal(await p, 1);
  });

  it('a folder that does not exist is no_folder, and git is never asked', async () => {
    const missing = path.join(ws, 'missing');
    const { p, resolve } = run(['--cwd', missing], { identity: { project_key: ROOT }, reason: null });
    assert.equal(await p, 1);
    assert.equal(resolve.called, false);
    assert.equal(out.join(''), '');
    assert.equal(err.join(''), `moag project-id: no ONOSOO project ID — folder not found: ${missing}\n`);
    out = []; err = [];
    const file = path.join(ws, 'a-file');
    fs.writeFileSync(file, '');
    const j = run(['--cwd', file, '--json'], { identity: { project_key: ROOT }, reason: null });
    assert.equal(await j.p, 1);
    assert.deepEqual(JSON.parse(out.join('')), { project_key: null, repo_url: null, reason: 'no_folder' });
  });

  for (const argv of [['--bogus'], ['extra'], ['--cwd'], ['--cwd', ''], ['--json', 'x']]) {
    it(`usage error for ${JSON.stringify(argv)}: exit 2, usage on stderr, git never asked`, async () => {
      const { p, resolve } = run(argv, { identity: { project_key: ROOT }, reason: null });
      assert.equal(await p, 2);
      assert.equal(err.join(''), PROJECT_ID_USAGE);
      assert.equal(out.join(''), '');
      assert.equal(resolve.called, false);
    });
  }

  it('a rejecting resolver is git_unreadable, never a throw', async () => {
    const { p } = run([], () => Promise.reject(new Error('boom')));
    assert.equal(await p, 1);
    assert.ok(err.join('').includes(PROJECT_ID_REASON_PHRASES.git_unreadable));
  });

  describe('deadline (fake timers)', () => {
    let clock: sinon.SinonFakeTimers;
    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => { clock.restore(); });

    it('a resolver that never settles ends at PROJECT_ID_DEADLINE_MS with timeout, exit 1', async () => {
      const { p } = run(['--json'], () => new Promise<ProjectIdentityResolution>(() => undefined));
      let code: number | undefined;
      void p.then((c) => { code = c; });
      await clock.tickAsync(PROJECT_ID_DEADLINE_MS - 1);
      assert.equal(code, undefined);
      await clock.tickAsync(1);
      assert.equal(code, 1);
      assert.deepEqual(JSON.parse(out.join('')), { project_key: null, repo_url: null, reason: 'timeout' });
      assert.equal(err.join(''), `moag project-id: no ONOSOO project ID — ${PROJECT_ID_REASON_PHRASES.timeout}\n`);
    });
  });
});
