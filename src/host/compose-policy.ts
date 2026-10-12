// ─── Compose policy: what an environment may ask Docker for ───
//
// The compose file comes from the branch, which an AI may have written, so the container is the
// sandbox and this is its wall. It is an ALLOW-list: every key of the resolved configuration
// (`docker compose config --format json`, after interpolation, extends and include) must be one this
// file knows to be harmless, and the risky ones are checked in detail. Anything unknown is refused,
// so a Compose feature added next year fails closed instead of opening a hole.
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
  platform?: NodeJS.Platform;
  /** Resolve symlinks; defaults to fs.realpathSync on the nearest existing ancestor. */
  realpath?: (p: string) => string;
}

const TOP_LEVEL_KEYS = new Set(['name', 'services', 'networks', 'volumes', 'secrets', 'configs']);

const SERVICE_KEYS = new Set([
  'image', 'build', 'command', 'entrypoint', 'environment', 'env_file', 'ports', 'expose', 'volumes',
  'depends_on', 'healthcheck', 'restart', 'working_dir', 'user', 'labels', 'deploy', 'networks',
  'network_mode', 'hostname', 'domainname', 'stdin_open', 'tty', 'init', 'stop_signal', 'stop_grace_period',
  'tmpfs', 'ulimits', 'logging', 'extra_hosts', 'dns', 'dns_search', 'shm_size', 'platform', 'pull_policy',
  'profiles', 'scale', 'secrets', 'configs', 'develop', 'attach', 'read_only', 'cap_drop', 'security_opt',
  'links', 'volumes_from', 'mem_limit', 'mem_reservation', 'cpus', 'cpu_shares', 'pids_limit', 'annotations',
  'mac_address', 'group_add', 'post_start', 'pre_stop', 'oom_score_adj',
]);

const BUILD_KEYS = new Set(['context', 'dockerfile', 'dockerfile_inline', 'args', 'target', 'labels', 'cache_from', 'shm_size', 'extra_hosts', 'pull', 'platforms', 'tags', 'no_cache']);
const DEPLOY_KEYS = new Set(['resources', 'restart_policy', 'replicas', 'labels', 'update_config', 'rollback_config', 'mode']);
const NETWORK_KEYS = new Set(['name', 'driver', 'internal', 'labels', 'enable_ipv6', 'ipam', 'attachable']);
const VOLUME_KEYS = new Set(['name', 'labels', 'driver']);
const FILE_OBJECT_KEYS = new Set(['name', 'file', 'labels', 'content']);
const SAFE_SECURITY_OPTS = new Set(['no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true']);
const LOGGING_DRIVERS = new Set(['json-file', 'local']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
  const inside = (p: string): boolean => {
    const target = normalize(real(p), win);
    return roots.some((root) => target === root || target.startsWith(`${root}/`));
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
  }
  for (const [name, v] of Object.entries(isRecord(config.volumes) ? config.volumes : {})) {
    if (v === null) { continue; }
    if (!isRecord(v)) { out.push(`volume ${name}: invalid`); continue; }
    if (v.external) { out.push(`volume ${name}: external volumes are not allowed`); continue; }
    for (const k of Object.keys(v)) { if (!VOLUME_KEYS.has(k)) { out.push(`volume ${name}: "${k}" is not allowed`); } }
    if (v.driver !== undefined && v.driver !== 'local') { out.push(`volume ${name}: driver ${String(v.driver)} is not allowed`); }
  }
  for (const kind of ['secrets', 'configs'] as const) {
    for (const [name, s] of Object.entries(isRecord(config[kind]) ? config[kind] as Record<string, unknown> : {})) {
      if (!isRecord(s)) { out.push(`${kind} ${name}: invalid`); continue; }
      if (s.external) { out.push(`${kind} ${name}: external ${kind} are not allowed`); continue; }
      for (const k of Object.keys(s)) { if (!FILE_OBJECT_KEYS.has(k)) { out.push(`${kind} ${name}: "${k}" is not allowed`); } }
      if (typeof s.file === 'string' && !inside(s.file)) { out.push(`${kind} ${name}: file ${s.file} is outside the project`); }
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
    if (isRecord(svc.logging) && svc.logging.driver !== undefined && !LOGGING_DRIVERS.has(String(svc.logging.driver))) {
      say(`logging driver ${String(svc.logging.driver)} is not allowed`);
    }

    // build
    if (svc.build !== undefined) {
      if (!isRecord(svc.build)) { say('build must be an object'); } else {
        for (const k of Object.keys(svc.build)) { if (!BUILD_KEYS.has(k)) { say(`build "${k}" is not allowed`); } }
        const context = typeof svc.build.context === 'string' ? svc.build.context : '';
        if (!context || /^[a-z][a-z0-9+.-]*:\/\//i.test(context) || !inside(context)) { say(`build context ${context || '(none)'} is outside the project`); }
        if (typeof svc.build.dockerfile === 'string' && context) {
          const df = path.isAbsolute(svc.build.dockerfile) ? svc.build.dockerfile : path.join(context, svc.build.dockerfile);
          if (!inside(df)) { say(`dockerfile ${svc.build.dockerfile} is outside the project`); }
        }
      }
    }

    // env_file: strings or { path, required }
    for (const e of Array.isArray(svc.env_file) ? svc.env_file : svc.env_file !== undefined ? [svc.env_file] : []) {
      const p = typeof e === 'string' ? e : isRecord(e) && typeof e.path === 'string' ? e.path : '';
      if (!p || !inside(p)) { say(`env_file ${p || '(invalid)'} is outside the project`); }
    }

    // volumes
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      if (!isRecord(v)) { say('volume entry is invalid'); continue; }
      const type = v.type;
      const source = typeof v.source === 'string' ? v.source : '';
      if (type === 'bind') {
        if (/(docker|containerd|podman|crio)\.sock/.test(source)) { say(`mounting ${source} is not allowed`); continue; }
        if (!source || !inside(source)) { say(`mounting ${source || 'a host path'} from outside the project is not allowed`); }
      } else if (type !== 'volume' && type !== 'tmpfs') {
        say(`volume type ${String(type)} is not allowed`);
      }
    }

    // deploy: limits only, no device reservations
    if (svc.deploy !== undefined) {
      if (!isRecord(svc.deploy)) { say('deploy must be an object'); } else {
        for (const k of Object.keys(svc.deploy)) { if (!DEPLOY_KEYS.has(k)) { say(`deploy "${k}" is not allowed`); } }
        const reservations = isRecord(svc.deploy.resources) ? svc.deploy.resources.reservations : undefined;
        if (isRecord(reservations) && reservations.devices !== undefined) { say('device reservations are not allowed'); }
      }
    }

    // ports: exactly what the override publishes, and nothing else
    const ports = Array.isArray(svc.ports) ? svc.ports : [];
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
