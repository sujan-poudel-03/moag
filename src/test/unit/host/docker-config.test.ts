// ─── Host agent: the host-owned Docker configuration ───
//
// Every docker child of `moag host` runs with DOCKER_CONFIG = <configDir>/moag/host/docker-config,
// whose config.json never carries registry credentials. These tests build a user configuration that
// has every kind of credential and check that none of it, and no TLS key, crosses over.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  dockerChildEnv,
  hostDockerConfigDir,
  hostDockerConfigJson,
  PLACEHOLDER_REGISTRY,
  prepareHostDockerConfig,
  userDockerConfigDir,
} from '../../../host/docker-config';

const HASH = 'a'.repeat(64);
/** Every host config.json carries exactly this, and no other auth data. */
const AUTHS = { auths: { 'moag.invalid': {} } };

/**
 * docker/cli's own decision, mirrored from the file's content: LoadDefaultConfigFile
 * (cli/config/config.go) runs credentials.DetectDefaultStore — which picks up
 * docker-credential-pass / -secretservice from the PATH — only when ContainsAuth() is false, and
 * ContainsAuth (cli/config/configfile/file.go) is credsStore != "" || credHelpers non-empty ||
 * auths non-empty.
 */
function dockerWouldDetectHelper(cfg: Record<string, unknown>): boolean {
  const count = (v: unknown): number => (v && typeof v === 'object' ? Object.keys(v).length : 0);
  const containsAuth = (typeof cfg.credsStore === 'string' && cfg.credsStore !== '') || count(cfg.credHelpers) > 0 || count(cfg.auths) > 0;
  return !containsAuth;
}

/** The registry credentials a config.json would hand Docker, for any registry. */
function credentialsIn(cfg: Record<string, unknown>): unknown[] {
  const auths = (cfg.auths ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(auths).flatMap((a) => Object.entries(a).filter(([k]) => ['auth', 'username', 'password', 'identitytoken', 'registrytoken'].includes(k.toLowerCase())));
}

describe('host/docker-config', () => {
  let root: string;
  let stateDir: string;
  let userDir: string;

  const writeUserConfig = (config: unknown): void => {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  };
  const hostConfig = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(hostDockerConfigDir(stateDir), 'config.json'), 'utf-8'));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-dockercfg-'));
    stateDir = path.join(root, 'moag');
    userDir = path.join(root, 'home', '.docker');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('lives at <configDir>/moag/host/docker-config', () => {
    assert.equal(hostDockerConfigDir('/home/me/.config/moag'), path.join('/home/me/.config/moag', 'host', 'docker-config'));
  });

  it('finds the user configuration from DOCKER_CONFIG, else HOME/.docker', () => {
    assert.equal(userDockerConfigDir({ DOCKER_CONFIG: '/etc/dk', HOME: '/home/me' }), path.resolve('/etc/dk'));
    assert.equal(userDockerConfigDir({ HOME: '/home/me' }), path.join('/home/me', '.docker'));
    assert.equal(userDockerConfigDir({}, () => '/home/other'), path.join('/home/other', '.docker'));
  });

  it('keeps only currentContext from the user configuration: never auths, credsStore or credHelpers', () => {
    const json = hostDockerConfigJson(JSON.stringify({
      auths: { 'ghcr.io': { auth: 'dXNlcjpwYXNz' } },
      credsStore: 'desktop',
      credHelpers: { '123.dkr.ecr.us-east-1.amazonaws.com': 'ecr-login' },
      currentContext: 'build-box',
      proxies: { default: { httpProxy: 'http://u:p@proxy' } },
      HttpHeaders: { Authorization: 'secret' },
    }), null);
    assert.deepEqual(json, { ...AUTHS, currentContext: 'build-box' });
  });

  it('carries nothing over from an unreadable configuration, an odd or default context name', () => {
    assert.deepEqual(hostDockerConfigJson('{not json', null), AUTHS);
    assert.deepEqual(hostDockerConfigJson(JSON.stringify({ currentContext: '../../etc' }), null), AUTHS);
    assert.deepEqual(hostDockerConfigJson(JSON.stringify({ currentContext: 'default' }), null), AUTHS);
    assert.deepEqual(hostDockerConfigJson(JSON.stringify([1]), null), AUTHS);
    assert.deepEqual(hostDockerConfigJson(null, '/home/me/.docker/cli-plugins'), { ...AUTHS, cliPluginsExtraDirs: ['/home/me/.docker/cli-plugins'] });
  });

  it('writes a credential-free config.json, copies context metadata only, and never TLS keys', () => {
    writeUserConfig({ auths: { 'ghcr.io': { auth: 'x' } }, credsStore: 'pass', credHelpers: { 'gcr.io': 'gcloud' }, currentContext: 'build-box' });
    fs.mkdirSync(path.join(userDir, 'contexts', 'meta', HASH), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'contexts', 'meta', HASH, 'meta.json'), JSON.stringify({ Name: 'build-box', Endpoints: { docker: { Host: 'tcp://10.0.0.5:2376' } } }));
    fs.mkdirSync(path.join(userDir, 'contexts', 'meta', 'not-a-hash'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'contexts', 'meta', 'not-a-hash', 'meta.json'), '{}');
    fs.mkdirSync(path.join(userDir, 'contexts', 'meta', 'b'.repeat(64)), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'contexts', 'meta', 'b'.repeat(64), 'meta.json'), 'not json');
    fs.mkdirSync(path.join(userDir, 'contexts', 'tls', HASH, 'docker'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'contexts', 'tls', HASH, 'docker', 'key.pem'), 'PRIVATE KEY');
    fs.mkdirSync(path.join(userDir, 'cli-plugins'), { recursive: true });

    const dir = prepareHostDockerConfig(stateDir, { DOCKER_CONFIG: userDir, HOME: path.join(root, 'home') });
    assert.equal(dir, hostDockerConfigDir(stateDir));

    const cfg = hostConfig();
    assert.deepEqual(cfg.auths, { [PLACEHOLDER_REGISTRY]: {} }, 'exactly the one empty placeholder entry');
    for (const k of ['credsStore', 'credHelpers']) { assert.equal(k in cfg, false, `${k} reached the host configuration`); }
    assert.deepEqual(credentialsIn(cfg), []);
    assert.equal(cfg.currentContext, 'build-box');
    assert.deepEqual(cfg.cliPluginsExtraDirs, [path.join(userDir, 'cli-plugins')]);

    assert.ok(fs.existsSync(path.join(dir, 'contexts', 'meta', HASH, 'meta.json')), 'context metadata copied');
    assert.equal(fs.existsSync(path.join(dir, 'contexts', 'meta', 'not-a-hash')), false);
    assert.equal(fs.existsSync(path.join(dir, 'contexts', 'meta', 'b'.repeat(64))), false, 'non-JSON metadata skipped');
    assert.equal(fs.existsSync(path.join(dir, 'contexts', 'tls')), false, 'TLS material never copied');
    const all = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(d, e.name)) : [path.join(d, e.name)]));
    assert.equal(all(dir).some((f) => fs.readFileSync(f, 'utf-8').includes('PRIVATE KEY')), false);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
    }
  });

  it('writes a config.json even when the user has none, so Docker never falls back to defaults from HOME', () => {
    const dir = prepareHostDockerConfig(stateDir, { HOME: path.join(root, 'nobody') });
    assert.deepEqual(hostConfig(), AUTHS);
    assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  });

  it('drops credentials that an earlier run left behind, and contexts that are gone', () => {
    const dir = hostDockerConfigDir(stateDir);
    fs.mkdirSync(path.join(dir, 'contexts', 'meta', HASH), { recursive: true });
    fs.writeFileSync(path.join(dir, 'contexts', 'meta', HASH, 'meta.json'), '{}');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths: { 'ghcr.io': { auth: 'x' } } }));
    prepareHostDockerConfig(stateDir, { HOME: path.join(root, 'nobody') });
    assert.deepEqual(hostConfig(), AUTHS);
    assert.equal(fs.existsSync(path.join(dir, 'contexts')), false);
  });

  it('skips a symlinked context folder', function () {
    fs.mkdirSync(path.join(userDir, 'contexts', 'meta'), { recursive: true });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'meta.json'), '{"Name":"x"}');
    try {
      fs.symlinkSync(outside, path.join(userDir, 'contexts', 'meta', HASH), 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') { this.skip(); }
      throw err;
    }
    const dir = prepareHostDockerConfig(stateDir, { DOCKER_CONFIG: userDir });
    assert.equal(fs.existsSync(path.join(dir, 'contexts', 'meta', HASH)), false);
  });

  it('throws when the folder cannot be written, rather than handing back nothing', () => {
    fs.mkdirSync(path.join(stateDir, 'host'), { recursive: true });
    fs.writeFileSync(hostDockerConfigDir(stateDir), 'a file where the folder should be');
    assert.throws(() => prepareHostDockerConfig(stateDir, { HOME: path.join(root, 'nobody') }));
  });

  it('makes Docker skip credential-helper detection: the written file has auth (one empty entry), so no helper is looked up', () => {
    // The trap the placeholder closes: a config with no auth at all makes Docker go looking.
    assert.equal(dockerWouldDetectHelper({}), true);
    assert.equal(dockerWouldDetectHelper({ auths: {} }), true, 'an empty auths map is not enough');
    for (const userConfig of [null, '{}', JSON.stringify({ auths: {}, credsStore: '' }), JSON.stringify({ credsStore: 'pass', credHelpers: { 'gcr.io': 'gcloud' } })]) {
      if (userConfig === null) { fs.rmSync(userDir, { recursive: true, force: true }); } else { writeUserConfig(userConfig); }
      prepareHostDockerConfig(stateDir, { DOCKER_CONFIG: userDir });
      const cfg = hostConfig();
      assert.equal(dockerWouldDetectHelper(cfg), false, `helper detection would run for user config ${String(userConfig)}`);
      assert.equal('credsStore' in cfg, false);
      assert.equal('credHelpers' in cfg, false);
      assert.deepEqual(Object.keys(cfg.auths as object), [PLACEHOLDER_REGISTRY]);
      assert.deepEqual(credentialsIn(cfg), [], 'and the file store has nothing for any registry');
    }
  });

  it('dockerChildEnv sets DOCKER_CONFIG over whatever the base had', () => {
    assert.deepEqual(dockerChildEnv({ PATH: '/bin', DOCKER_CONFIG: '/home/me/.docker' }, '/cfg'), { PATH: '/bin', DOCKER_CONFIG: '/cfg' });
  });
});
