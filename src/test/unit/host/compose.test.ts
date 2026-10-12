// ─── Host agent: compose helpers ───
//
// The override file is what keeps one environment's ports, CPU and memory from touching another's,
// and childEnv is the one gate every docker/git call passes through — so most of these tests are
// about what must NOT get through.

import { strict as assert } from 'assert';

import {
  buildOverride,
  childEnv,
  composeProjectName,
  composeVersionOk,
  deriveStatus,
  envKeyFor,
  ENV_KEY_RE,
  isSafeBranch,
  parsePsOutput,
  servicesFromPs,
} from '../../../host/compose';

describe('host/compose', () => {
  describe('envKeyFor', () => {
    it('is DNS-safe, deterministic and readable', () => {
      const key = envKeyFor('shop', 'moag/plan-x/run_123');
      assert.match(key, ENV_KEY_RE);
      assert.equal(key, envKeyFor('shop', 'moag/plan-x/run_123'));
      assert.ok(key.startsWith('shop-moag-plan-x-run-123-'), key);
      assert.equal(composeProjectName(key), `moag-${key}`);
    });

    it('differs for branches whose slugs collide', () => {
      assert.notEqual(envKeyFor('shop', 'feat/a_b'), envKeyFor('shop', 'feat/a-b'));
    });

    it('stays within a DNS label for very long names', () => {
      const key = envKeyFor('x'.repeat(64), 'y'.repeat(200));
      assert.ok(key.length <= 63, String(key.length));
      assert.match(key, ENV_KEY_RE);
    });
  });

  describe('isSafeBranch', () => {
    it('accepts ordinary branch names', () => {
      for (const b of ['main', 'feat/login', 'moag/plan-x/run_1', 'release-1.2']) { assert.ok(isSafeBranch(b), b); }
    });
    it('refuses anything git or a shell could misread', () => {
      for (const b of ['-x', '--force', 'a..b', 'a b', 'a;rm', 'a/', 'x.lock', 'a//b', '$(id)', 'a\nb', '']) {
        assert.equal(isSafeBranch(b), false, JSON.stringify(b));
      }
    });
  });

  describe('buildOverride', () => {
    const text = buildOverride({
      envKey: 'shop-main-abc123',
      services: ['web', 'api', 'db'],
      web: { service: 'web', port: 5173 },
      hostPort: 41007,
      cpus: 2,
      memoryMb: 2048,
    });

    it('publishes only the web service, and only on loopback', () => {
      assert.match(text, /"web":\n {4}ports: !override\n {6}- "127\.0\.0\.1:41007:5173"/);
      assert.equal((text.match(/ports: !reset \[\]/g) ?? []).length, 2);
      assert.doesNotMatch(text, /0\.0\.0\.0/);
    });

    it('limits every service and labels it with its environment', () => {
      assert.equal((text.match(/memory: "2048M"/g) ?? []).length, 3);
      assert.equal((text.match(/cpus: "2"/g) ?? []).length, 3);
      assert.equal((text.match(/moag\.environment: "shop-main-abc123"/g) ?? []).length, 3);
      assert.equal((text.match(/\n {4}pids_limit: 512\n/g) ?? []).length, 3, 'a process limit on every service');
    });

    it('resets every port when there is no web service', () => {
      const t = buildOverride({ envKey: 'k', services: ['worker'], web: null, hostPort: 41000, cpus: 1, memoryMb: 512 });
      assert.match(t, /ports: !reset \[\]/);
      assert.doesNotMatch(t, /!override/);
    });

    it('quotes service names, so a name cannot inject YAML', () => {
      const t = buildOverride({ envKey: 'k', services: ['a: b'], web: null, hostPort: 41000, cpus: 1, memoryMb: 512 });
      assert.match(t, /"a: b":/);
    });
  });

  it('composeVersionOk requires 2.24.4 or newer', () => {
    assert.equal(composeVersionOk('2.24.4'), true);
    assert.equal(composeVersionOk('v2.29.1-desktop.1'), true);
    assert.equal(composeVersionOk('2.24.3'), false);
    assert.equal(composeVersionOk('1.29.2'), false);
    assert.equal(composeVersionOk('garbage'), false);
  });

  describe('ps', () => {
    it('reads both the JSON-array and the one-object-per-line formats', () => {
      const arr = parsePsOutput('[{"Service":"web","State":"running","Health":""}]');
      const nd = parsePsOutput('{"Service":"web","State":"running"}\n{"Service":"db","State":"exited"}\n');
      assert.equal(arr.length, 1);
      assert.equal(nd.length, 2);
      assert.deepEqual(parsePsOutput(''), []);
    });

    it('lists every expected service, missing ones as exited', () => {
      const s = servicesFromPs(parsePsOutput('{"Service":"web","State":"running","Health":"healthy"}'), { web: 'web', db: 'db' });
      assert.deepEqual(s, [
        { name: 'db', role: 'db', state: 'exited', health: 'unknown' },
        { name: 'web', role: 'web', state: 'running', health: 'healthy' },
      ]);
    });

    it('derives the environment status', () => {
      const up = { name: 'web', role: 'web' as const, state: 'running' as const, health: 'healthy' as const };
      const down = { ...up, name: 'db', role: 'db' as const, state: 'exited' as const };
      assert.equal(deriveStatus([up], 'running', 'web'), 'running');
      assert.equal(deriveStatus([up, down], 'running', 'web'), 'unhealthy');
      assert.equal(deriveStatus([{ ...up, state: 'exited' }], 'running', 'web'), 'failed');
      assert.equal(deriveStatus([{ ...up, health: 'starting' }], 'running', 'web'), 'starting');
      assert.equal(deriveStatus([up], 'stopped', 'web'), 'stopped');
    });
  });

  it('childEnv passes only an allow-list: no keys, tokens or agent sockets reach docker or git', () => {
    const env = childEnv({
      PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', DOCKER_HOST: 'unix:///run/docker.sock',
      MOAG_ONOSOO_KEY: 'onosoo_live_x', MOAG_ONOSOO_URL: 'u', TUNNEL_TOKEN: 't', CLOUDFLARED_TOKEN: 'c',
      ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'aws',
      SSH_AUTH_SOCK: '/tmp/agent', DATABASE_URL: 'postgres://u:p@h/db', NPM_TOKEN: 'npm',
      // The user's Docker configuration holds registry credentials: docker children get the host's.
      DOCKER_CONFIG: '/h/.docker',
    });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', DOCKER_HOST: 'unix:///run/docker.sock' });
  });
});

describe('host/git-safe', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { gitVersionOk, safeGitArgs, safeGitEnv } = require('../../../host/git-safe');

  it('hardens every git call and only allows local transport when asked', () => {
    const a = safeGitArgs(['fetch', 'x'], { emptyHooksDir: '/e' });
    assert.ok(a.includes('core.hooksPath=/e') && a.includes('core.fsmonitor=false') && a.includes('protocol.file.allow=never'));
    assert.deepEqual(a.slice(-2), ['fetch', 'x']);
    assert.ok(safeGitArgs([], { emptyHooksDir: '/e', allowLocal: true }).includes('protocol.file.allow=always'));
    assert.equal(safeGitEnv({ PATH: '/b' }).GIT_CONFIG_NOSYSTEM, '1');
  });

  it('requires git 2.45.1 or newer', () => {
    assert.equal(gitVersionOk('git version 2.45.1'), true);
    assert.equal(gitVersionOk('git version 2.47.0.windows.1'), true);
    assert.equal(gitVersionOk('git version 2.45.0'), false);
    assert.equal(gitVersionOk('git version 2.39.5'), false);
    assert.equal(gitVersionOk('nonsense'), false);
  });
});

describe('host/tunnel', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tokenFileTooOpen } = require('../../../host/tunnel');
  it('refuses a token file anyone but its owner can read or write', () => {
    assert.equal(tokenFileTooOpen(0o100600), false);
    assert.equal(tokenFileTooOpen(0o100400), false);
    assert.equal(tokenFileTooOpen(0o100640), true);
    assert.equal(tokenFileTooOpen(0o100644), true);
    assert.equal(tokenFileTooOpen(0o100602), true);
  });
});
