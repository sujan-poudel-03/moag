// ─── Compose policy: what an environment may ask Docker for ───
//
// The compose file comes from the branch, which an AI may have written, so the container is the
// sandbox and this is its wall. It is an ALLOW-list: every key of the resolved configuration
// (`docker compose config --format json`, after interpolation, extends and include) must be one this
// file knows to be harmless, and the risky ones are checked in detail. Anything unknown is refused,
// so a Compose feature added next year fails closed instead of opening a hole. That holds at every
// depth: each nested object the policy lets through (build, deploy, healthcheck, logging, a mount,
// a network attachment, ...) has its own field allow-list, and an unknown field inside it is refused
// just like an unknown service key.
//
// Paths are compared after resolving symlinks (`realpath`), so a link inside the checkout that points
// at /etc or at the MOAG config folder counts as what it points to.
//
// The check runs before EVERY `up` (start, restart from stopped, database reset), on a freshly
// resolved configuration, and Docker is then run from the host-owned copy that was checked — never
// from the compose file in the checkout, which a container can rewrite (environments.ts).
//
// Pure apart from the injected `realpath`. Never vscode.

import * as fs from 'fs';
import * as path from 'path';

export interface PolicyInput {
  /** Folders bind mounts, build contexts and files may come from: the branch checkout. */
  roots: string[];
  /** The one service that may publish a port, and the container port it publishes. */
  web: { service: string; port: number } | null;
  /** The loopback port the web service must be published on. */
  hostPort: number;
  /**
   * The Compose project name (`moag-<env key>`). Every top-level volume and network `name` must
   * start with it and "_" — so a branch cannot attach another environment's, or the user's, volume
   * or network. Env keys have no "_", so the prefix of one environment is never another's.
   */
  projectName: string;
  platform?: NodeJS.Platform;
  /** Resolve symlinks; defaults to fs.realpathSync on the nearest existing ancestor. */
  realpath?: (p: string) => string;
}

const TOP_LEVEL_KEYS = new Set(['name', 'services', 'networks', 'volumes', 'secrets', 'configs']);

// Lifecycle hooks (`post_start`, `pre_stop`) are deliberately absent: each hook entry is a command
// with its own `privileged` and `user`, and previews do not need them. So is `ulimits`: raising
// nofile/nproc is a way round the process and file limits, and previews do not need that either.
// Also absent: `develop` (watch actions that sync and rebuild on host file changes), `annotations`,
// and `group_add` (extra groups — the docker group's gid among them). `build.cache_from` likewise.
// And every service-level CPU and memory key (`mem_limit`, `memswap_limit`, `mem_reservation`,
// `cpus`, `cpu_shares`, `cpu_quota`, `cpu_period`, `cpuset`, `cpu_count`, `cpu_percent`): the
// override's `deploy.resources.limits` are the only limits an environment gets.
const SERVICE_KEYS = new Set([
  'image', 'build', 'command', 'entrypoint', 'environment', 'env_file', 'ports', 'expose', 'volumes',
  'depends_on', 'healthcheck', 'restart', 'working_dir', 'user', 'labels', 'deploy', 'networks',
  'network_mode', 'hostname', 'domainname', 'stdin_open', 'tty', 'init', 'stop_signal', 'stop_grace_period',
  'tmpfs', 'logging', 'extra_hosts', 'dns', 'dns_search', 'shm_size', 'platform', 'pull_policy',
  'profiles', 'scale', 'secrets', 'configs', 'attach', 'read_only', 'cap_drop', 'security_opt',
  'links', 'volumes_from', 'pids_limit',
  'mac_address', 'oom_score_adj',
]);

// ─── Field allow-lists for every nested object ───

const BUILD_KEYS = new Set(['context', 'dockerfile', 'dockerfile_inline', 'args', 'target', 'labels', 'shm_size', 'extra_hosts', 'pull', 'platforms', 'tags', 'no_cache']);
const DEPLOY_KEYS = new Set(['resources', 'restart_policy', 'replicas', 'labels', 'update_config', 'rollback_config', 'mode']);
const RESOURCES_KEYS = new Set(['limits', 'reservations']);
const LIMITS_KEYS = new Set(['cpus', 'memory', 'pids']);
/** No `devices` (GPUs and other host devices) and no `generic_resources`. */
const RESERVATIONS_KEYS = new Set(['cpus', 'memory']);
const RESTART_POLICY_KEYS = new Set(['condition', 'delay', 'max_attempts', 'window']);
const UPDATE_CONFIG_KEYS = new Set(['parallelism', 'delay', 'failure_action', 'monitor', 'max_failure_ratio', 'order']);
const HEALTHCHECK_KEYS = new Set(['test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval', 'disable']);
const LOGGING_KEYS = new Set(['driver', 'options']);
/** A service's attachment to one of the project's networks. No `driver_opts`, no `interface_name`. */
const SERVICE_NETWORK_KEYS = new Set(['aliases', 'ipv4_address', 'ipv6_address', 'link_local_ips', 'mac_address', 'priority', 'gw_priority']);
const MOUNT_KEYS = new Set(['type', 'source', 'target', 'read_only', 'consistency', 'bind', 'volume', 'tmpfs']);
const MOUNT_BIND_KEYS = new Set(['create_host_path', 'selinux', 'propagation']);
const MOUNT_VOLUME_KEYS = new Set(['nocopy', 'subpath']);
const MOUNT_TMPFS_KEYS = new Set(['size', 'mode']);
/** Mount events must not flow between the container and the host. */
const SAFE_PROPAGATION = new Set(['private', 'rprivate']);
const ENV_FILE_KEYS = new Set(['path', 'required', 'format']);
const PORT_KEYS = new Set(['name', 'mode', 'host_ip', 'target', 'published', 'protocol', 'app_protocol']);
const DEPENDS_ON_KEYS = new Set(['condition', 'restart', 'required']);
const SERVICE_FILE_REF_KEYS = new Set(['source', 'target', 'uid', 'gid', 'mode']);
/** Top-level networks. No `ipam`: a chosen subnet can shadow the machine's own routes. No `driver_opts`. */
const NETWORK_KEYS = new Set(['name', 'driver', 'internal', 'labels', 'enable_ipv6', 'attachable']);
/** Top-level volumes. No `driver_opts`: with the local driver they bind any host path. */
const VOLUME_KEYS = new Set(['name', 'labels', 'driver']);
const FILE_OBJECT_KEYS = new Set(['name', 'file', 'labels', 'content']);
const SAFE_SECURITY_OPTS = new Set(['no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true']);
const LOGGING_DRIVERS = new Set(['json-file', 'local']);

/** The highest process count a container may have; `moag host` itself sets 512 (compose.ts). */
const MAX_PIDS = 1024;

/** A pids limit that bounds something: unset, -1 and 0 all mean "unlimited" to Docker. */
function pidsOk(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_PIDS;
}

/** A replica count of 0 or 1. */
function atMostOne(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** realpath of the nearest existing ancestor, with the rest appended: works for paths not created yet. */
export function defaultRealpath(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) { return path.resolve(p); }
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function normalize(p: string, win: boolean): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return win ? n.toLowerCase() : n;
}

/** The resolved compose config's violations. Empty means it may run. */
export function composePolicyViolations(config: unknown, input: PolicyInput): string[] {
  const out: string[] = [];
  const win = (input.platform ?? process.platform) === 'win32';
  const real = input.realpath ?? defaultRealpath;
  const roots = input.roots.map((r) => normalize(real(r), win));
  const ownName = (n: unknown): boolean => typeof n === 'string' && n.startsWith(`${input.projectName}_`) && n.length > input.projectName.length + 1;
  const inside = (p: string): boolean => {
    const target = normalize(real(p), win);
    return roots.some((root) => target === root || target.startsWith(`${root}/`));
  };

  /**
   * `value` must be an object whose fields are all in `allowed` (null/absent is fine when
   * `optional`). Reports each unknown field under `where`. Returns the object, or null.
   */
  const fields = (
    value: unknown, allowed: Set<string>, where: string, say: (what: string) => void, optional = true,
  ): Record<string, unknown> | null => {
    if (value === undefined || value === null) {
      if (!optional) { say(`${where} is missing`); }
      return null;
    }
    if (!isRecord(value)) { say(`${where} must be an object`); return null; }
    for (const k of Object.keys(value)) { if (!allowed.has(k)) { say(`${where} "${k}" is not allowed`); } }
    return value;
  };
  /** A map of plain values (labels, args, environment, logging options): nothing nested. */
  const scalarMap = (value: unknown, where: string, say: (what: string) => void): void => {
    if (value === undefined || value === null) { return; }
    if (Array.isArray(value)) {
      if (value.some((x) => !isScalar(x))) { say(`${where} must hold plain values`); }
      return;
    }
    if (!isRecord(value) || Object.values(value).some((x) => !isScalar(x))) { say(`${where} must hold plain values`); }
  };

  if (!isRecord(config) || !isRecord(config.services) || Object.keys(config.services).length === 0) {
    return ['The compose configuration has no services.'];
  }

  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key) && !key.startsWith('x-')) { out.push(`top-level "${key}" is not allowed`); }
  }

  // ─── Top-level networks / volumes / secrets / configs ───
  for (const [name, n] of Object.entries(isRecord(config.networks) ? config.networks : {})) {
    if (n === null) { continue; }
    if (!isRecord(n)) { out.push(`network ${name}: invalid`); continue; }
    if (n.external) { out.push(`network ${name}: external networks are not allowed`); continue; }
    for (const k of Object.keys(n)) { if (!NETWORK_KEYS.has(k)) { out.push(`network ${name}: "${k}" is not allowed`); } }
    if (n.driver !== undefined && n.driver !== 'bridge') { out.push(`network ${name}: driver ${String(n.driver)} is not allowed`); }
    if (n.name !== undefined && !ownName(n.name)) { out.push(`network ${name}: name ${String(n.name)} is not this environment's`); }
    scalarMap(n.labels, 'labels', (w) => out.push(`network ${name}: ${w}`));
  }
  for (const [name, v] of Object.entries(isRecord(config.volumes) ? config.volumes : {})) {
    if (v === null) { continue; }
    if (!isRecord(v)) { out.push(`volume ${name}: invalid`); continue; }
    if (v.external) { out.push(`volume ${name}: external volumes are not allowed`); continue; }
    for (const k of Object.keys(v)) { if (!VOLUME_KEYS.has(k)) { out.push(`volume ${name}: "${k}" is not allowed`); } }
    if (v.driver !== undefined && v.driver !== 'local') { out.push(`volume ${name}: driver ${String(v.driver)} is not allowed`); }
    if (v.name !== undefined && !ownName(v.name)) { out.push(`volume ${name}: name ${String(v.name)} is not this environment's`); }
    scalarMap(v.labels, 'labels', (w) => out.push(`volume ${name}: ${w}`));
  }
  for (const kind of ['secrets', 'configs'] as const) {
    for (const [name, s] of Object.entries(isRecord(config[kind]) ? config[kind] as Record<string, unknown> : {})) {
      if (!isRecord(s)) { out.push(`${kind} ${name}: invalid`); continue; }
      if (s.external) { out.push(`${kind} ${name}: external ${kind} are not allowed`); continue; }
      for (const k of Object.keys(s)) { if (!FILE_OBJECT_KEYS.has(k)) { out.push(`${kind} ${name}: "${k}" is not allowed`); } }
      if (typeof s.file === 'string' && !inside(s.file)) { out.push(`${kind} ${name}: file ${s.file} is outside the project`); }
      scalarMap(s.labels, 'labels', (w) => out.push(`${kind} ${name}: ${w}`));
    }
  }

  // ─── Services ───
  for (const [name, raw] of Object.entries(config.services)) {
    const say = (what: string): void => { out.push(`${name}: ${what}`); };
    if (!isRecord(raw)) { say('invalid'); continue; }
    const svc = raw;
    for (const k of Object.keys(svc)) { if (!SERVICE_KEYS.has(k) && !k.startsWith('x-')) { say(`"${k}" is not allowed`); } }

    if (typeof svc.network_mode === 'string' && svc.network_mode !== 'none' && !svc.network_mode.startsWith('service:')) {
      say(`network_mode ${svc.network_mode} is not allowed`);
    }
    if (Array.isArray(svc.security_opt) && svc.security_opt.some((o) => typeof o !== 'string' || !SAFE_SECURITY_OPTS.has(o.trim()))) {
      say('security_opt other than no-new-privileges is not allowed');
    }
    if (Array.isArray(svc.volumes_from) && svc.volumes_from.some((v) => typeof v !== 'string' || v.startsWith('container:'))) {
      say('volumes_from another container is not allowed');
    }
    scalarMap(svc.labels, 'labels', say);
    scalarMap(svc.environment, 'environment', say);

    // logging
    const logging = fields(svc.logging, LOGGING_KEYS, 'logging', say);
    if (logging) {
      if (logging.driver !== undefined && !LOGGING_DRIVERS.has(String(logging.driver))) {
        say(`logging driver ${String(logging.driver)} is not allowed`);
      }
      scalarMap(logging.options, 'logging options', say);
    }

    // healthcheck
    fields(svc.healthcheck, HEALTHCHECK_KEYS, 'healthcheck', say);

    // build
    if (svc.build !== undefined) {
      const build = fields(svc.build, BUILD_KEYS, 'build', say, false);
      if (build) {
        const context = typeof build.context === 'string' ? build.context : '';
        if (!context || /^[a-z][a-z0-9+.-]*:\/\//i.test(context) || !inside(context)) { say(`build context ${context || '(none)'} is outside the project`); }
        if (typeof build.dockerfile === 'string' && context) {
          const df = path.isAbsolute(build.dockerfile) ? build.dockerfile : path.join(context, build.dockerfile);
          if (!inside(df)) { say(`dockerfile ${build.dockerfile} is outside the project`); }
        }
        scalarMap(build.args, 'build args', say);
        scalarMap(build.labels, 'build labels', say);
      }
    }

    // env_file: strings or { path, required, format }
    for (const e of Array.isArray(svc.env_file) ? svc.env_file : svc.env_file !== undefined ? [svc.env_file] : []) {
      const entry = typeof e === 'string' ? null : fields(e, ENV_FILE_KEYS, 'env_file entry', say);
      const p = typeof e === 'string' ? e : entry && typeof entry.path === 'string' ? entry.path : '';
      if (!p || !inside(p)) { say(`env_file ${p || '(invalid)'} is outside the project`); }
    }

    // volumes (mounts)
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      if (!isRecord(v)) { say('volume entry is invalid'); continue; }
      fields(v, MOUNT_KEYS, 'volume entry', say);
      const type = v.type;
      const source = typeof v.source === 'string' ? v.source : '';
      const bind = fields(v.bind, MOUNT_BIND_KEYS, 'volume entry bind', say);
      fields(v.volume, MOUNT_VOLUME_KEYS, 'volume entry volume', say);
      fields(v.tmpfs, MOUNT_TMPFS_KEYS, 'volume entry tmpfs', say);
      if (bind && bind.propagation !== undefined && !SAFE_PROPAGATION.has(String(bind.propagation))) {
        say(`bind propagation ${String(bind.propagation)} is not allowed`);
      }
      if (type === 'bind') {
        if (/(docker|containerd|podman|crio)\.sock/.test(source)) { say(`mounting ${source} is not allowed`); continue; }
        if (!source || !inside(source)) { say(`mounting ${source || 'a host path'} from outside the project is not allowed`); }
      } else if (type !== 'volume' && type !== 'tmpfs') {
        say(`volume type ${String(type)} is not allowed`);
      }
    }

    // depends_on: a list of names, or { service: { condition, restart, required } }
    if (isRecord(svc.depends_on)) {
      for (const [dep, cond] of Object.entries(svc.depends_on)) { fields(cond, DEPENDS_ON_KEYS, `depends_on ${dep}`, say); }
    }

    // networks: a list of names, or { network: null | { aliases, ... } }
    if (isRecord(svc.networks)) {
      for (const [net, attach] of Object.entries(svc.networks)) { fields(attach, SERVICE_NETWORK_KEYS, `network ${net}`, say); }
    }

    // secrets / configs references: names, or { source, target, uid, gid, mode }
    for (const kind of ['secrets', 'configs'] as const) {
      for (const ref of Array.isArray(svc[kind]) ? svc[kind] as unknown[] : []) {
        if (typeof ref !== 'string') { fields(ref, SERVICE_FILE_REF_KEYS, `${kind} entry`, say, false); }
      }
    }

    // Resource keys: a bounded process count (the override sets one on every service, so its absence
    // means the override did not apply), no protection from the OOM killer, one container per service.
    if (!pidsOk(svc.pids_limit)) { say(`pids_limit must be between 1 and ${MAX_PIDS} (it is ${svc.pids_limit === undefined ? 'unset, i.e. unlimited' : String(svc.pids_limit)})`); }
    if (svc.oom_score_adj !== undefined && !(Number.isInteger(svc.oom_score_adj) && (svc.oom_score_adj as number) >= 0)) {
      say(`oom_score_adj ${String(svc.oom_score_adj)} is not allowed (only 0 or more)`);
    }
    if (svc.scale !== undefined && !atMostOne(svc.scale)) { say(`scale ${String(svc.scale)} is not allowed (at most 1)`); }

    // deploy: limits only, no device reservations
    if (svc.deploy !== undefined) {
      const deploy = fields(svc.deploy, DEPLOY_KEYS, 'deploy', say, false);
      if (deploy) {
        const resources = fields(deploy.resources, RESOURCES_KEYS, 'deploy resources', say);
        if (resources) {
          const reservations = isRecord(resources.reservations) ? resources.reservations : undefined;
          if (reservations && reservations.devices !== undefined) { say('device reservations are not allowed'); }
          const limits = fields(resources.limits, LIMITS_KEYS, 'deploy resources limits', say);
          if (limits && limits.pids !== undefined && !pidsOk(limits.pids)) { say(`deploy resources limits pids must be between 1 and ${MAX_PIDS}`); }
          fields(resources.reservations, RESERVATIONS_KEYS, 'deploy resources reservations', say);
        }
        if (deploy.replicas !== undefined && !atMostOne(deploy.replicas)) { say(`deploy replicas ${String(deploy.replicas)} is not allowed (at most 1)`); }
        fields(deploy.restart_policy, RESTART_POLICY_KEYS, 'deploy restart_policy', say);
        fields(deploy.update_config, UPDATE_CONFIG_KEYS, 'deploy update_config', say);
        fields(deploy.rollback_config, UPDATE_CONFIG_KEYS, 'deploy rollback_config', say);
        scalarMap(deploy.labels, 'deploy labels', say);
      }
    }

    // ports: exactly what the override publishes, and nothing else
    const ports = Array.isArray(svc.ports) ? svc.ports : [];
    for (const p of ports) { if (isRecord(p)) { fields(p, PORT_KEYS, 'port', say); } }
    const isWeb = input.web?.service === name;
    if (!isWeb && ports.length > 0) { say('only the web service may publish a port'); }
    if (isWeb) {
      const ok = ports.length === 1 && isRecord(ports[0])
        && ports[0].host_ip === '127.0.0.1'
        && String(ports[0].published) === String(input.hostPort)
        && Number(ports[0].target) === input.web!.port;
      if (!ok) { say(`must publish exactly 127.0.0.1:${input.hostPort}->${input.web!.port}`); }
    }
  }
  return out;
}
