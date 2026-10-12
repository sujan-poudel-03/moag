// ─── Host agent: compose policy ───
//
// One test per way out of the sandbox that QA round 1 listed, plus the allow-list's own promise:
// a key the policy does not know is refused. `realpath` is injected so symlinks can be simulated.

import { strict as assert } from 'assert';

import { composePolicyViolations, type PolicyInput } from '../../../host/compose-policy';

const ROOT = '/srv/moag/host/worktrees/shop-main-1';
const WEB = { image: 'node', ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 5173, published: '41000', protocol: 'tcp' }] };

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return { roots: [ROOT], web: { service: 'web', port: 5173 }, hostPort: 41000, platform: 'linux', realpath: (p) => p, ...over };
}

function check(services: Record<string, unknown>, top: Record<string, unknown> = {}, over: Partial<PolicyInput> = {}): string[] {
  return composePolicyViolations({ name: 'moag-shop-main-1', services: { web: WEB, ...services }, ...top }, input(over));
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

  it('fails closed on a configuration without services', () => {
    assert.deepEqual(composePolicyViolations({}, input()), ['The compose configuration has no services.']);
    assert.deepEqual(composePolicyViolations('x', input()), ['The compose configuration has no services.']);
  });
});
