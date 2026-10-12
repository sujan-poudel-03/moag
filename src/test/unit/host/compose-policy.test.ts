// ─── Host agent: compose policy ───
//
// One test per way out of the sandbox that QA round 1 listed, plus the allow-list's own promise:
// a key the policy does not know is refused. `realpath` is injected so symlinks can be simulated.

import { strict as assert } from 'assert';

import { composePolicyViolations, type PolicyInput } from '../../../host/compose-policy';

const ROOT = '/srv/moag/host/worktrees/shop-main-1';
const WEB = { image: 'node', ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 5173, published: '41000', protocol: 'tcp' }] };

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return { roots: [ROOT], web: { service: 'web', port: 5173 }, hostPort: 41000, projectName: 'moag-shop-main-1', platform: 'linux', realpath: (p) => p, ...over };
}

/**
 * Check a configuration as `docker compose config` resolves it with the host override: every
 * service gets the override's `pids_limit` unless the test sets the key itself (even to undefined).
 */
function check(services: Record<string, unknown>, top: Record<string, unknown> = {}, over: Partial<PolicyInput> = {}): string[] {
  const withLimits = Object.fromEntries(Object.entries({ web: WEB, ...services }).map(([k, s]) => [
    k, s && typeof s === 'object' && !('pids_limit' in s) ? { ...s, pids_limit: 512 } : s,
  ]));
  return composePolicyViolations({ name: 'moag-shop-main-1', services: withLimits, ...top }, input(over));
}

function refuses(v: string[], fragment: RegExp): void {
  assert.ok(v.some((x) => fragment.test(x)), `expected a violation matching ${fragment}, got ${JSON.stringify(v)}`);
}

describe('host/compose-policy', () => {
  it('allows an ordinary stack: build in the checkout, named volumes, env_file in the checkout', () => {
    const v = check({
      api: {
        build: { context: `${ROOT}/api`, dockerfile: 'Dockerfile', args: { NODE_ENV: 'development' } },
        env_file: [{ path: `${ROOT}/api/.env`, required: false }],
        volumes: [{ type: 'bind', source: `${ROOT}/api/src`, target: '/app/src' }, { type: 'volume', source: 'data', target: '/data' }],
        depends_on: { db: { condition: 'service_started' } },
        security_opt: ['no-new-privileges:true'],
        deploy: { resources: { limits: { cpus: '2', memory: '2048M' } } },
      },
      db: { image: 'postgres:16', network_mode: 'service:api' },
    }, { volumes: { data: {} }, networks: { default: { name: 'moag-shop-main-1_default' } } });
    assert.deepEqual(v, []);
  });

  it('refuses keys it does not know (fail closed)', () => {
    refuses(check({ api: { image: 'x', privileged: true } }), /api: "privileged" is not allowed/);
    refuses(check({ api: { image: 'x', cap_add: ['SYS_ADMIN'] } }), /"cap_add" is not allowed/);
    refuses(check({ api: { image: 'x', devices: ['/dev/kmsg'] } }), /"devices" is not allowed/);
    refuses(check({ api: { image: 'x', pid: 'host' } }), /"pid" is not allowed/);
    refuses(check({ api: { image: 'x', ipc: 'host' } }), /"ipc" is not allowed/);
    refuses(check({ api: { image: 'x', userns_mode: 'host' } }), /"userns_mode" is not allowed/);
    refuses(check({ api: { image: 'x', cgroup_parent: '/' } }), /"cgroup_parent" is not allowed/);
    refuses(check({ api: { image: 'x', runtime: 'nvidia' } }), /"runtime" is not allowed/);
    refuses(check({ api: { image: 'x', sysctls: { 'net.ipv4.ip_forward': 1 } } }), /"sysctls" is not allowed/);
    refuses(check({ api: { image: 'x', container_name: 'fixed' } }), /"container_name" is not allowed/);
    refuses(check({ api: { image: 'x', external_links: ['other'] } }), /"external_links" is not allowed/);
    refuses(check({}, { include: [] }), /top-level "include" is not allowed/);
  });

  it('refuses develop, annotations, group_add and build cache_from', () => {
    refuses(check({ api: { image: 'x', develop: { watch: [{ action: 'sync', path: '/', target: '/host' }] } } }), /api: "develop" is not allowed/);
    refuses(check({ api: { image: 'x', annotations: { a: 'b' } } }), /api: "annotations" is not allowed/);
    refuses(check({ api: { image: 'x', group_add: ['999'] } }), /api: "group_add" is not allowed/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, cache_from: ['type=local,src=/home/me'] } } }), /api: build "cache_from" is not allowed/);
  });

  it('refuses host networking and attaching to another container', () => {
    refuses(check({ api: { image: 'x', network_mode: 'host' } }), /network_mode host/);
    refuses(check({ api: { image: 'x', network_mode: 'container:other' } }), /network_mode container:other/);
    refuses(check({ api: { image: 'x', network_mode: 'bridge' } }), /network_mode bridge/);
    refuses(check({ api: { image: 'x', volumes_from: ['container:other'] } }), /volumes_from/);
  });

  it('refuses security_opt other than no-new-privileges, including label:disable', () => {
    refuses(check({ api: { image: 'x', security_opt: ['label:disable'] } }), /security_opt/);
    refuses(check({ api: { image: 'x', security_opt: ['seccomp:unconfined'] } }), /security_opt/);
    refuses(check({ api: { image: 'x', security_opt: ['apparmor=unconfined'] } }), /security_opt/);
  });

  it('refuses bind mounts outside the checkout, the Docker socket, and other mount types', () => {
    refuses(check({ api: { image: 'x', volumes: [{ type: 'bind', source: '/', target: '/host' }] } }), /from outside the project/);
    refuses(check({ api: { image: 'x', volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }] } }), /docker\.sock/);
    refuses(check({ api: { image: 'x', volumes: [{ type: 'bind', source: `${ROOT}-evil`, target: '/x' }] } }), /from outside the project/);
    refuses(check({ api: { image: 'x', volumes: [{ type: 'npipe', source: '//./pipe/docker_engine', target: '/x' }] } }), /type npipe/);
  });

  it('follows symlinks: a link inside the checkout that points outside counts as outside', () => {
    const realpath = (p: string): string => (p.startsWith(`${ROOT}/link`) ? p.replace(`${ROOT}/link`, '/home/me/.config/moag') : p);
    refuses(check({ api: { image: 'x', volumes: [{ type: 'bind', source: `${ROOT}/link`, target: '/x' }] } }, {}, { realpath }), /from outside the project/);
    refuses(check({ api: { image: 'x', env_file: [`${ROOT}/link/onosoo.json`] } }, {}, { realpath }), /env_file/);
  });

  it('refuses top-level volumes that bind host paths, and external volumes', () => {
    refuses(check({}, { volumes: { v: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/etc' } } } }), /volume v: "driver_opts" is not allowed/);
    refuses(check({}, { volumes: { v: { external: true } } }), /external volumes/);
    refuses(check({}, { volumes: { v: { driver: 'rexray' } } }), /driver rexray/);
  });

  it('refuses every unsafe build option', () => {
    refuses(check({ api: { build: { context: '/' } } }), /build context \/ is outside/);
    refuses(check({ api: { build: { context: 'https://github.com/x/y.git' } } }), /build context/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, dockerfile: '../../../../etc/Dockerfile' } } }), /dockerfile/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, additional_contexts: { x: '/' } } } }), /build "additional_contexts"/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, secrets: [{ source: 's' }] } } }), /build "secrets"/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, ssh: ['default'] } } }), /build "ssh"/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, network: 'host' } } }), /build "network"/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, privileged: true } } }), /build "privileged"/);
    refuses(check({ api: { build: { context: `${ROOT}/api`, entitlements: ['network.host'] } } }), /build "entitlements"/);
  });

  it('refuses env files, secrets and configs from outside the checkout, and secrets from the environment', () => {
    refuses(check({ api: { image: 'x', env_file: ['/home/me/.aws/credentials'] } }), /env_file/);
    refuses(check({}, { secrets: { s: { file: '/home/me/.ssh/id_rsa' } } }), /secrets s: file/);
    refuses(check({}, { secrets: { s: { environment: 'GITHUB_TOKEN' } } }), /secrets s: "environment" is not allowed/);
    refuses(check({}, { configs: { c: { file: '/etc/shadow' } } }), /configs c: file/);
    refuses(check({}, { secrets: { s: { external: true } } }), /external secrets/);
  });

  it('refuses external networks and non-bridge drivers', () => {
    refuses(check({}, { networks: { n: { external: true, name: 'host' } } }), /external networks/);
    refuses(check({}, { networks: { n: { driver: 'macvlan' } } }), /driver macvlan/);
  });

  it('refuses volume and network names that are not the environment\'s own', () => {
    // The resolved default network and compose-named volumes pass.
    assert.deepEqual(check({}, { networks: { default: { name: 'moag-shop-main-1_default' } }, volumes: { data: { name: 'moag-shop-main-1_data' } } }), []);
    // Another environment's, the user's, and lookalikes are refused.
    refuses(check({}, { volumes: { data: { name: 'moag-shop-feat-a-9f9f9f_data' } } }), /volume data: name moag-shop-feat-a-9f9f9f_data is not this environment's/);
    refuses(check({}, { volumes: { data: { name: 'postgres_data' } } }), /volume data: name postgres_data/);
    refuses(check({}, { volumes: { data: { name: 'moag-shop-main-1' } } }), /volume data: name moag-shop-main-1 is not/);
    refuses(check({}, { volumes: { data: { name: 'moag-shop-main-10_data' } } }), /volume data: name moag-shop-main-10_data/);
    refuses(check({}, { volumes: { data: { name: 'moag-shop-main-1_' } } }), /volume data: name/);
    refuses(check({}, { volumes: { data: { name: 7 } } }), /volume data: name 7/);
    refuses(check({}, { networks: { n: { name: 'bridge' } } }), /network n: name bridge is not this environment's/);
    refuses(check({}, { networks: { n: { name: 'moag-other-1_default' } } }), /network n: name moag-other-1_default/);
    // external stays refused, whatever the name.
    refuses(check({}, { volumes: { v: { external: true, name: 'moag-shop-main-1_v' } } }), /external volumes/);
    refuses(check({}, { networks: { n: { external: true, name: 'moag-shop-main-1_n' } } }), /external networks/);
  });

  it('requires a bounded process count on every service', () => {
    assert.deepEqual(check({ api: { image: 'x', pids_limit: 1024 } }), []);
    assert.deepEqual(check({ api: { image: 'x', pids_limit: 1 } }), []);
    refuses(check({ api: { image: 'x', pids_limit: undefined } }), /api: pids_limit must be between 1 and 1024 \(it is unset, i\.e\. unlimited\)/);
    refuses(check({ api: { image: 'x', pids_limit: -1 } }), /api: pids_limit must be between 1 and 1024 \(it is -1\)/);
    refuses(check({ api: { image: 'x', pids_limit: 0 } }), /api: pids_limit .*it is 0/);
    refuses(check({ api: { image: 'x', pids_limit: 1025 } }), /api: pids_limit .*it is 1025/);
    refuses(check({ api: { image: 'x', pids_limit: '512' } }), /api: pids_limit/);
    refuses(check({ api: { image: 'x', deploy: { resources: { limits: { pids: -1 } } } } }), /api: deploy resources limits pids must be between 1 and 1024/);
    assert.deepEqual(check({ api: { image: 'x', deploy: { resources: { limits: { pids: 512 } } } } }), []);
  });

  it('refuses OOM-killer protection, more than one replica, and ulimits', () => {
    assert.deepEqual(check({ api: { image: 'x', oom_score_adj: 0, scale: 1, deploy: { replicas: 1 } } }), []);
    assert.deepEqual(check({ api: { image: 'x', oom_score_adj: 500 } }), []);
    refuses(check({ api: { image: 'x', oom_score_adj: -1 } }), /api: oom_score_adj -1 is not allowed/);
    refuses(check({ api: { image: 'x', oom_score_adj: -1000 } }), /api: oom_score_adj -1000/);
    refuses(check({ api: { image: 'x', scale: 2 } }), /api: scale 2 is not allowed/);
    refuses(check({ api: { image: 'x', deploy: { replicas: 50 } } }), /api: deploy replicas 50 is not allowed/);
    refuses(check({ api: { image: 'x', ulimits: { nofile: { soft: 1048576, hard: 1048576 } } } }), /api: "ulimits" is not allowed/);
    refuses(check({ api: { image: 'x', ulimits: { nproc: 65535 } } }), /api: "ulimits" is not allowed/);
  });

  it('refuses device reservations', () => {
    refuses(check({ api: { image: 'x', deploy: { resources: { reservations: { devices: [{ capabilities: ['gpu'] }] } } } } }), /device reservations/);
  });

  it('accepts only the exact published port: web on 127.0.0.1 at the allocated port, nothing else', () => {
    refuses(check({ api: { image: 'x', ports: [{ host_ip: '127.0.0.1', target: 80, published: '41001' }] } }), /only the web service/);
    const wild = composePolicyViolations({ services: { web: { image: 'x', ports: [{ host_ip: '0.0.0.0', target: 5173, published: '41000' }] } } }, input());
    refuses(wild, /must publish exactly 127\.0\.0\.1:41000->5173/);
    const two = composePolicyViolations({ services: { web: { image: 'x', ports: [WEB.ports[0], { host_ip: '127.0.0.1', target: 22, published: '2222' }] } } }, input());
    refuses(two, /must publish exactly/);
    const wrongPort = composePolicyViolations({ services: { web: { image: 'x', ports: [{ ...WEB.ports[0], published: '41009' }] } } }, input());
    refuses(wrongPort, /must publish exactly/);
  });

  it('refuses lifecycle hooks outright: a privileged or root hook never runs', () => {
    refuses(check({ api: { image: 'x', post_start: [{ command: ['sh', '-c', 'id'], privileged: true }] } }), /api: "post_start" is not allowed/);
    refuses(check({ api: { image: 'x', pre_stop: [{ command: ['sh'], user: 'root' }] } }), /api: "pre_stop" is not allowed/);
    // Even a harmless-looking hook: the key itself is refused.
    refuses(check({ api: { image: 'x', post_start: [{ command: ['true'] }] } }), /"post_start" is not allowed/);
  });

  it('allows what `docker compose config` itself writes into nested objects', () => {
    const v = check({
      api: {
        image: 'x',
        volumes: [
          { type: 'bind', source: `${ROOT}/src`, target: '/src', bind: { create_host_path: true } },
          { type: 'volume', source: 'data', target: '/data', volume: {} },
          { type: 'tmpfs', target: '/tmp', tmpfs: { size: 1048576 } },
        ],
        networks: { default: null, back: { aliases: ['api'] } },
        env_file: [{ path: `${ROOT}/.env`, required: false }],
        healthcheck: { test: ['CMD', 'true'], interval: '5s', retries: 3 },
        logging: { driver: 'json-file', options: { 'max-size': '10m' } },
        depends_on: { db: { condition: 'service_healthy', required: true, restart: true } },
        secrets: [{ source: 's', target: '/run/s' }],
        deploy: { resources: { limits: { cpus: '2', memory: '1024M' }, reservations: { memory: '128M' } }, restart_policy: { condition: 'on-failure' } },
      },
      db: { image: 'postgres:16' },
    }, { volumes: { data: { name: 'moag-shop-main-1_data' } }, networks: { back: { name: 'moag-shop-main-1_back' } }, secrets: { s: { file: `${ROOT}/s.txt` } } });
    assert.deepEqual(v, []);
  });

  it('refuses an unknown field inside every nested object it lets through', () => {
    const svc = (extra: Record<string, unknown>): Record<string, unknown> => ({ api: { image: 'x', ...extra } });
    const cases: Array<[string[], RegExp]> = [
      [check(svc({ build: { context: `${ROOT}/api`, privileged: true } })), /api: build "privileged" is not allowed/],
      [check(svc({ deploy: { placement: { constraints: [] } } })), /api: deploy "placement" is not allowed/],
      [check(svc({ deploy: { resources: { devices: [] } } })), /api: deploy resources "devices" is not allowed/],
      [check(svc({ deploy: { resources: { limits: { devices: [] } } } })), /api: deploy resources limits "devices" is not allowed/],
      [check(svc({ deploy: { resources: { reservations: { generic_resources: [] } } } })), /api: deploy resources reservations "generic_resources" is not allowed/],
      [check(svc({ deploy: { restart_policy: { condition: 'any', x: 1 } } })), /api: deploy restart_policy "x" is not allowed/],
      [check(svc({ deploy: { update_config: { order: 'start-first', x: 1 } } })), /api: deploy update_config "x" is not allowed/],
      [check(svc({ deploy: { rollback_config: { x: 1 } } })), /api: deploy rollback_config "x" is not allowed/],
      [check(svc({ healthcheck: { test: ['CMD', 'true'], privileged: true } })), /api: healthcheck "privileged" is not allowed/],
      [check(svc({ logging: { driver: 'json-file', mode: 'non-blocking' } })), /api: logging "mode" is not allowed/],
      [check(svc({ logging: { driver: 'json-file', options: { nested: { a: 1 } } } })), /api: logging options must hold plain values/],
      [check(svc({ networks: { default: { driver_opts: { 'com.docker.network.bridge.name': 'docker0' } } } })), /api: network default "driver_opts" is not allowed/],
      [check(svc({ volumes: [{ type: 'volume', source: 'data', target: '/d', cluster: {} }] })), /api: volume entry "cluster" is not allowed/],
      [check(svc({ volumes: [{ type: 'bind', source: `${ROOT}/a`, target: '/a', bind: { recursive: 'writable' } }] })), /api: volume entry bind "recursive" is not allowed/],
      [check(svc({ volumes: [{ type: 'bind', source: `${ROOT}/a`, target: '/a', bind: { propagation: 'rshared' } }] })), /api: bind propagation rshared is not allowed/],
      [check(svc({ volumes: [{ type: 'volume', source: 'data', target: '/d', volume: { labels: {} } }] })), /api: volume entry volume "labels" is not allowed/],
      [check(svc({ volumes: [{ type: 'tmpfs', target: '/t', tmpfs: { exec: true } }] })), /api: volume entry tmpfs "exec" is not allowed/],
      [check(svc({ env_file: [{ path: `${ROOT}/.env`, extra: 1 }] })), /api: env_file entry "extra" is not allowed/],
      [check(svc({ depends_on: { db: { condition: 'service_started', x: 1 } } })), /api: depends_on db "x" is not allowed/],
      [check(svc({ secrets: [{ source: 's', target: '/s', x: 1 }] })), /api: secrets entry "x" is not allowed/],
      [check(svc({ configs: [{ source: 'c', target: '/c', x: 1 }] })), /api: configs entry "x" is not allowed/],
      [check(svc({ labels: { a: { nested: true } } })), /api: labels must hold plain values/],
      [check({ web: { ...WEB, ports: [{ ...WEB.ports[0], x: 1 }] } }), /web: port "x" is not allowed/],
      [check({}, { networks: { n: { ipam: { config: [{ subnet: '192.168.1.0/24' }] } } } }), /network n: "ipam" is not allowed/],
      [check({}, { networks: { n: { driver_opts: {} } } }), /network n: "driver_opts" is not allowed/],
      [check({}, { volumes: { v: { driver_opts: {} } } }), /volume v: "driver_opts" is not allowed/],
      [check({}, { secrets: { s: { file: `${ROOT}/s`, x: 1 } } }), /secrets s: "x" is not allowed/],
      [check({}, { configs: { c: { file: `${ROOT}/c`, template_driver: 'golang' } } }), /configs c: "template_driver" is not allowed/],
    ];
    for (const [v, re] of cases) { refuses(v, re); }
  });

  it('fails closed on a configuration without services', () => {
    assert.deepEqual(composePolicyViolations({}, input()), ['The compose configuration has no services.']);
    assert.deepEqual(composePolicyViolations('x', input()), ['The compose configuration has no services.']);
  });
});
