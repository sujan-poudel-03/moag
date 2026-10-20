// ─── Docker Compose: names, the override file, and reading `ps` ───
//
// Pure helpers. The environment manager runs the commands; this decides what they say.
//
// Every environment is one Compose project (`moag-<env key>`), started from the branch's compose
// file plus an override this module writes. The override is what keeps environments from stepping
// on each other and on the machine:
//
//   - every service's published ports are reset, so two branches of the same project never fight
//     over a host port and nothing is reachable from outside except through the gateway;
//   - the web service alone is published again, on a loopback port the gateway proxies to;
//   - every service gets CPU, memory and process-count (`pids_limit`) limits;
//   - every container is labelled with the environment it belongs to.
//
// `!reset` / `!override` need Docker Compose 2.24.4 or newer; `moag host` checks the version.
//
// Imports only crypto; never vscode.

import { createHash } from 'crypto';

import type { EnvStatus, ServiceHealth, ServiceRole, ServiceSnapshot, ServiceState } from './types';

export const ENV_KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MIN_COMPOSE_VERSION: [number, number, number] = [2, 24, 4];
/** Processes per container: enough for any dev server, too few for a fork bomb to hurt the machine. */
export const PIDS_LIMIT = 512;

function slug(s: string, max: number): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}

/**
 * The environment key for a project branch: readable, DNS-safe (it is the preview subdomain), and
 * unique per (project, branch) through a short hash, so two branches whose slugs collide differ.
 */
export function envKeyFor(projectId: string, branch: string): string {
  const hash = createHash('sha256').update(`${projectId}\0${branch}`).digest('hex').slice(0, 6);
  const head = [slug(projectId, 20), slug(branch, 34)].filter(Boolean).join('-');
  const key = `${head}-${hash}`.replace(/^-+/, '');
  return ENV_KEY_RE.test(key) ? key : `env-${hash}`;
}

export function composeProjectName(envKey: string): string {
  return `moag-${envKey}`;
}

/**
 * A git branch name safe to pass to git as an argument: what ONOSOO accepts, minus anything git
 * itself would refuse. `git check-ref-format --branch` is also run before use.
 */
export function isSafeBranch(branch: string): boolean {
  // The allowed-character class already excludes spaces, control characters and ~^:?*[\ — the
  // lookaheads add git's structural rules: no leading dash, no "..", "@{", "//", trailing "/" or ".lock".
  return /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/.test(branch);
}

function yamlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
}

export interface OverrideInput {
  envKey: string;
  services: string[];
  web: { service: string; port: number } | null;
  hostPort: number;
  cpus: number;
  memoryMb: number;
}

/** The override compose file for one environment. */
export function buildOverride(input: OverrideInput): string {
  const lines = ['# Written by `moag host`. Regenerated on every start; do not edit.', 'services:'];
  for (const name of input.services) {
    lines.push(`  ${yamlString(name)}:`);
    if (input.web && input.web.service === name) {
      lines.push('    ports: !override');
      lines.push(`      - ${yamlString(`127.0.0.1:${input.hostPort}:${input.web.port}`)}`);
    } else {
      lines.push('    ports: !reset []');
    }
    lines.push('    labels:');
    lines.push(`      moag.environment: ${yamlString(input.envKey)}`);
    lines.push(`    pids_limit: ${PIDS_LIMIT}`);
    lines.push('    deploy:');
    lines.push('      resources:');
    lines.push('        limits:');
    lines.push(`          cpus: ${yamlString(String(input.cpus))}`);
    lines.push(`          memory: ${yamlString(`${input.memoryMb}M`)}`);
  }
  return lines.join('\n') + '\n';
}

/** `docker compose version --short` → whether it supports the override tags. */
export function composeVersionOk(output: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!m) { return false; }
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i] !== MIN_COMPOSE_VERSION[i]) { return v[i] > MIN_COMPOSE_VERSION[i]; }
  }
  return true;
}

// ─── ps ───

interface PsRow {
  Service?: unknown;
  State?: unknown;
  Health?: unknown;
}

/** `docker compose ps -a --format json` prints a JSON array (older) or one object per line (newer). */
export function parsePsOutput(output: string): PsRow[] {
  const text = output.trim();
  if (!text) { return []; }
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v)) { return v as PsRow[]; }
    if (v && typeof v === 'object') { return [v as PsRow]; }
  } catch {
    /* fall through to NDJSON */
  }
  const rows: PsRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) { rows.push(v as PsRow); }
    } catch {
      /* skip */
    }
  }
  return rows;
}

function mapState(s: unknown): ServiceState {
  switch (typeof s === 'string' ? s.toLowerCase() : '') {
    case 'running': return 'running';
    case 'restarting': return 'restarting';
    case 'created': return 'starting';
    case 'dead': return 'dead';
    default: return 'exited'; // exited, paused, removing, unknown
  }
}

function mapHealth(h: unknown): ServiceHealth {
  switch (typeof h === 'string' ? h.toLowerCase() : '') {
    case 'healthy': return 'healthy';
    case 'unhealthy': return 'unhealthy';
    case 'starting': return 'starting';
    default: return 'unknown';
  }
}

/** One snapshot per service the environment should have; a service with no container is "exited". */
export function servicesFromPs(rows: PsRow[], roles: Record<string, ServiceRole>): ServiceSnapshot[] {
  const byService = new Map<string, PsRow>();
  for (const r of rows) {
    if (typeof r.Service === 'string') { byService.set(r.Service, r); }
  }
  const names = [...new Set([...Object.keys(roles), ...byService.keys()])].sort();
  return names.map((name) => {
    const row = byService.get(name);
    return {
      name,
      role: roles[name] ?? 'other',
      state: row ? mapState(row.State) : 'exited',
      health: row ? mapHealth(row.Health) : 'unknown',
    };
  });
}

/** The environment's status from its services, given what a person last asked for. */
export function deriveStatus(services: ServiceSnapshot[], desired: 'running' | 'stopped', webService: string | null): EnvStatus {
  if (desired === 'stopped') { return 'stopped'; }
  if (services.length === 0) { return 'starting'; }
  if (services.every((s) => s.state === 'exited' || s.state === 'dead')) { return 'failed'; }
  if (services.some((s) => s.state === 'starting' || s.state === 'restarting' || s.health === 'starting')) { return 'starting'; }
  const web = webService ? services.find((s) => s.name === webService) : undefined;
  if (web && (web.state !== 'running' || web.health === 'unhealthy')) { return 'unhealthy'; }
  if (services.some((s) => s.state !== 'running' || s.health === 'unhealthy')) { return 'unhealthy'; }
  return 'running';
}

/**
 * The ONLY variables a docker or git child process gets. An allow-list, not a deny-list: a branch's
 * compose file can interpolate `${ANYTHING}` into a container, so whatever the main user has in its
 * environment (API keys, GITHUB_TOKEN, AWS credentials, SSH_AUTH_SOCK, the machine key) would
 * otherwise be one line away from an AI-written container. DOCKER_HOST/DOCKER_CONTEXT and the TLS
 * settings are kept so a non-default Docker setup still works; they identify the daemon, not a
 * secret. DOCKER_CONFIG is NOT kept: the user's Docker configuration holds registry credentials, and
 * every docker child gets the host-owned one instead (docker-config.ts).
 */
const CHILD_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'PATHEXT',
]);

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && CHILD_ENV_ALLOW.has(k.toUpperCase())) { out[k] = v; }
  }
  return out;
}
