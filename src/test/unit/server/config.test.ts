import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadServerConfig, scrubServerSecrets, isPathInside, ServerConfig } from '../../../server/config';

describe('server config', () => {
  let tmp: string;
  let dataDir: string;
  const TOKEN = 'b'.repeat(24);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-cfg-'));
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function ok(env: NodeJS.ProcessEnv): ServerConfig {
    const r = loadServerConfig(env);
    if (!r.ok) { assert.fail(r.error); }
    return r.config;
  }
  function err(env: NodeJS.ProcessEnv): string {
    const r = loadServerConfig(env);
    assert.equal(r.ok, false);
    return (r as { error: string }).error;
  }
  const base = (): NodeJS.ProcessEnv => ({ MOAG_DATA_DIR: dataDir, MOAG_PUBLIC_URL: 'http://localhost:8080' });

  it('requires MOAG_DATA_DIR', () => {
    assert.match(err({ MOAG_PUBLIC_URL: 'http://x' }), /MOAG_DATA_DIR/);
  });

  it('requires an http(s) MOAG_PUBLIC_URL', () => {
    assert.match(err({ MOAG_DATA_DIR: dataDir }), /MOAG_PUBLIC_URL/);
    assert.match(err({ MOAG_DATA_DIR: dataDir, MOAG_PUBLIC_URL: 'ftp://x' }), /http or https/);
    assert.match(err({ MOAG_DATA_DIR: dataDir, MOAG_PUBLIC_URL: 'not a url' }), /valid URL/);
  });

  it('applies defaults', () => {
    const c = ok(base());
    assert.equal(c.projectsRoot, path.join(dataDir, 'workspaces'));
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 8080);
    assert.equal(c.maxConcurrentJobs, 2);
    assert.equal(c.trustProxy, false);
    assert.equal(c.secureCookies, false);
    assert.equal(c.runsDisabledReason, null);
    assert.equal(c.bootstrapToken, null);
    assert.equal(c.masterKey, null);
    assert.equal(c.publicOrigin, 'http://localhost:8080');
  });

  it('marks https public URLs as secure', () => {
    assert.equal(ok({ ...base(), MOAG_PUBLIC_URL: 'https://moag.example.com/' }).secureCookies, true);
  });

  it('rejects a short bootstrap token and accepts a long one', () => {
    assert.match(err({ ...base(), MOAG_BOOTSTRAP_TOKEN: 'short' }), /24/);
    assert.equal(ok({ ...base(), MOAG_BOOTSTRAP_TOKEN: TOKEN }).bootstrapToken, TOKEN);
  });

  it('rejects a master key file inside the data dir', () => {
    const inside = path.join(dataDir, 'master.key');
    fs.writeFileSync(inside, 'x'.repeat(32));
    assert.match(err({ ...base(), MOAG_MASTER_KEY_FILE: inside }), /outside MOAG_DATA_DIR/);
  });

  it('rejects a master key file reached through a symlink into the data dir', function () {
    const inside = path.join(dataDir, 'master.key');
    fs.writeFileSync(inside, 'x'.repeat(32));
    const link = path.join(tmp, 'link.key');
    try { fs.symlinkSync(inside, link); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') { this.skip(); }
      throw e;
    }
    assert.match(err({ ...base(), MOAG_MASTER_KEY_FILE: link }), /outside MOAG_DATA_DIR/);
  });

  it('reads a master key file outside the data dir', () => {
    const outside = path.join(tmp, 'master.key');
    fs.writeFileSync(outside, 'k'.repeat(32) + '\n');
    assert.equal(ok({ ...base(), MOAG_MASTER_KEY_FILE: outside }).masterKey?.toString(), 'k'.repeat(32));
  });

  it('rejects both key sources at once and too-short keys', () => {
    const outside = path.join(tmp, 'master.key');
    fs.writeFileSync(outside, 'k'.repeat(32));
    assert.match(err({ ...base(), MOAG_MASTER_KEY: 'k'.repeat(32), MOAG_MASTER_KEY_FILE: outside }), /only one/);
    assert.match(err({ ...base(), MOAG_MASTER_KEY: 'short' }), /16/);
  });

  it('sets runsDisabledReason=ci when CI=true', () => {
    assert.equal(ok({ ...base(), CI: 'true' }).runsDisabledReason, 'ci');
  });

  it('validates MOAG_MAX_CONCURRENT_JOBS to 1-8', () => {
    assert.equal(ok({ ...base(), MOAG_MAX_CONCURRENT_JOBS: '8' }).maxConcurrentJobs, 8);
    for (const bad of ['0', '9', '2.5', 'two']) {
      assert.match(err({ ...base(), MOAG_MAX_CONCURRENT_JOBS: bad }), /MOAG_MAX_CONCURRENT_JOBS/);
    }
  });

  it('validates MOAG_MAX_USD_PER_ENGINE_CALL to a number in (0, 1000]', () => {
    assert.equal(ok(base()).maxUsdPerEngineCall, null, 'unset: no per-call cap');
    assert.equal(ok({ ...base(), MOAG_MAX_USD_PER_ENGINE_CALL: '' }).maxUsdPerEngineCall, null);
    assert.equal(ok({ ...base(), MOAG_MAX_USD_PER_ENGINE_CALL: '1.5' }).maxUsdPerEngineCall, 1.5);
    assert.equal(ok({ ...base(), MOAG_MAX_USD_PER_ENGINE_CALL: '1000' }).maxUsdPerEngineCall, 1000);
    for (const bad of ['0', '-1', 'abc', '1001', 'Infinity', 'NaN']) {
      assert.match(err({ ...base(), MOAG_MAX_USD_PER_ENGINE_CALL: bad }), /MOAG_MAX_USD_PER_ENGINE_CALL/, bad);
    }
  });

  it('MOAG_AUTO_INSTALL_DEPENDENCIES defaults on, accepts the boolean words, refuses anything else', () => {
    assert.equal(ok(base()).autoInstallDependencies, true);
    assert.equal(ok({ ...base(), MOAG_AUTO_INSTALL_DEPENDENCIES: '' }).autoInstallDependencies, true);
    for (const on of ['1', 'true', 'yes', 'TRUE', ' yes ']) {
      assert.equal(ok({ ...base(), MOAG_AUTO_INSTALL_DEPENDENCIES: on }).autoInstallDependencies, true, on);
    }
    for (const off of ['0', 'false', 'no', 'No']) {
      assert.equal(ok({ ...base(), MOAG_AUTO_INSTALL_DEPENDENCIES: off }).autoInstallDependencies, false, off);
    }
    assert.match(err({ ...base(), MOAG_AUTO_INSTALL_DEPENDENCIES: 'maybe' }), /MOAG_AUTO_INSTALL_DEPENDENCIES/);
  });

  it('MOAG_INSTALL_IGNORE_SCRIPTS is an off-by-default flag', () => {
    assert.equal(ok(base()).installIgnoreScripts, false);
    assert.equal(ok({ ...base(), MOAG_INSTALL_IGNORE_SCRIPTS: '1' }).installIgnoreScripts, true);
    assert.equal(ok({ ...base(), MOAG_INSTALL_IGNORE_SCRIPTS: '0' }).installIgnoreScripts, false);
  });

  it('validates MOAG_GATE_TIMEOUT_MS to a whole number of ms in [1000, 3600000]', () => {
    assert.equal(ok(base()).gateTimeoutMs, null, 'unset: verify keeps its default');
    assert.equal(ok({ ...base(), MOAG_GATE_TIMEOUT_MS: ' ' }).gateTimeoutMs, null);
    assert.equal(ok({ ...base(), MOAG_GATE_TIMEOUT_MS: '1800000' }).gateTimeoutMs, 1_800_000);
    assert.equal(ok({ ...base(), MOAG_GATE_TIMEOUT_MS: '1000' }).gateTimeoutMs, 1000);
    assert.equal(ok({ ...base(), MOAG_GATE_TIMEOUT_MS: '3600000' }).gateTimeoutMs, 3_600_000);
    for (const bad of ['999', '3600001', '0', '-5', '1.5', 'abc', 'Infinity', 'NaN']) {
      assert.match(err({ ...base(), MOAG_GATE_TIMEOUT_MS: bad }), /MOAG_GATE_TIMEOUT_MS/, bad);
    }
  });

  it('validates MOAG_PORT', () => {
    assert.equal(ok({ ...base(), MOAG_PORT: '0' }).port, 0);
    assert.match(err({ ...base(), MOAG_PORT: '70000' }), /MOAG_PORT/);
  });

  it('validates passthrough names and rejects MOAG_* and CI', () => {
    assert.deepEqual(ok({ ...base(), MOAG_RUN_ENV_PASSTHROUGH: 'GH_TOKEN, NPM_TOKEN' }).runEnvPassthrough, ['GH_TOKEN', 'NPM_TOKEN']);
    assert.match(err({ ...base(), MOAG_RUN_ENV_PASSTHROUGH: 'MOAG_X' }), /MOAG_\*/);
    assert.match(err({ ...base(), MOAG_RUN_ENV_PASSTHROUGH: 'MOAG_MASTER_KEY' }), /MOAG_\*/);
    assert.match(err({ ...base(), MOAG_RUN_ENV_PASSTHROUGH: 'CI' }), /CI/);
    assert.match(err({ ...base(), MOAG_RUN_ENV_PASSTHROUGH: 'lower_case' }), /valid variable/);
    assert.match(err({ ...base(), MOAG_RUN_ENV_PASSTHROUGH: 'A;rm -rf' }), /valid variable/);
  });

  it('parses MOAG_TRUST_PROXY and MOAG_ALLOW_SSH_CLONE flags', () => {
    const c = ok({ ...base(), MOAG_TRUST_PROXY: '1', MOAG_ALLOW_SSH_CLONE: 'true' });
    assert.equal(c.trustProxy, true);
    assert.equal(c.allowSshClone, true);
  });

  it('scrubServerSecrets removes the master key and bootstrap token only', () => {
    const env: NodeJS.ProcessEnv = { MOAG_MASTER_KEY: 'k', MOAG_BOOTSTRAP_TOKEN: 't', MOAG_DATA_DIR: '/d', PATH: '/bin' };
    scrubServerSecrets(env);
    assert.equal('MOAG_MASTER_KEY' in env, false);
    assert.equal('MOAG_BOOTSTRAP_TOKEN' in env, false);
    assert.equal(env.MOAG_DATA_DIR, '/d');
    assert.equal(env.PATH, '/bin');
  });

  it('isPathInside handles prefixes correctly', () => {
    const root = path.resolve('/srv/data');
    assert.equal(isPathInside(root, path.join(root, 'a')), true);
    assert.equal(isPathInside(root, root), true);
    assert.equal(isPathInside(root, path.resolve('/srv/data2/a')), false);
  });
});
