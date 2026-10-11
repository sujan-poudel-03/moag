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

  it('childEnv removes the machine key and tunnel tokens, and keeps everything else', () => {
    const env = childEnv({ PATH: '/bin', MOAG_ONOSOO_KEY: 'onosoo_live_x', MOAG_ONOSOO_URL: 'u', TUNNEL_TOKEN: 't', CLOUDFLARED_TOKEN: 'c', HOME: '/h' });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
  });
});

describe('host/compose policy and git-safe', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { composePolicyViolations } = require('../../../host/compose');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safeGitArgs, safeGitEnv } = require('../../../host/git-safe');
  const root = '/srv/moag/host/worktrees/shop-main-1';

  it('allows an ordinary stack with mounts inside the checkout', () => {
    assert.deepEqual(composePolicyViolations({
      services: {
        web: { image: 'node', volumes: [{ type: 'bind', source: `${root}/src`, target: '/app' }, { type: 'volume', source: 'data', target: '/d' }], network_mode: 'service:api' },
        api: { image: 'node', security_opt: ['no-new-privileges:true'] },
      },
    }, [root], 'linux'), []);
  });

  it('refuses every way out of the sandbox', () => {
    const v = composePolicyViolations({
      services: {
        a: { privileged: true },
        b: { cap_add: ['SYS_ADMIN'] },
        c: { devices: ['/dev/kmsg'] },
        d: { network_mode: 'host' },
        e: { pid: 'host' },
        f: { ipc: 'host' },
        g: { userns_mode: 'host' },
        h: { security_opt: ['seccomp:unconfined'] },
        i: { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }] },
        j: { volumes: [{ type: 'bind', source: '/srv/moag/host/worktrees/shop-main-1-evil', target: '/x' }] },
        k: { volumes: [{ type: 'bind', source: '/home/me/.config/moag', target: '/x' }] },
        l: { network_mode: 'container:other-env' },
      },
    }, [root], 'linux');
    for (const s of 'abcdefghijkl') { assert.ok(v.some((x: string) => x.startsWith(`${s}:`)), s); }
  });

  it('compares Windows paths case-insensitively', () => {
    assert.deepEqual(composePolicyViolations({ services: { w: { volumes: [{ type: 'bind', source: 'C:\\Users\\Me\\WT\\x', target: '/x' }] } } }, ['c:/users/me/wt'], 'win32'), []);
  });

  it('hardens every git call and only allows local transport when asked', () => {
    const a = safeGitArgs(['fetch', 'x'], { emptyHooksDir: '/e' });
    assert.ok(a.includes('core.hooksPath=/e') && a.includes('core.fsmonitor=false') && a.includes('protocol.file.allow=never'));
    assert.deepEqual(a.slice(-2), ['fetch', 'x']);
    assert.ok(safeGitArgs([], { emptyHooksDir: '/e', allowLocal: true }).includes('protocol.file.allow=always'));
    assert.equal(safeGitEnv({ PATH: '/b' }).GIT_CONFIG_NOSYSTEM, '1');
  });
});
