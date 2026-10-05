// ─── Hosted server configuration ───
//
// All server configuration comes from environment variables, validated once at
// boot. `loadServerConfig` never throws: a bad value is a startup error the
// operator must fix, reported as `{ ok: false, error }`.

import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8080;
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
export const MAX_CONCURRENT_JOBS_LIMIT = 8;
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 24;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Why runs are refused server-wide, or null when runs are allowed. */
export type RunsDisabledReason = 'ci' | null;

export interface ServerConfig {
  dataDir: string;
  projectsRoot: string;
  publicUrl: string;
  /** Origin of `publicUrl` — mutating requests with an `Origin` header must match it. */
  publicOrigin: string;
  /** True when `publicUrl` is https: cookies get `Secure` + `__Host-`, HSTS is sent. */
  secureCookies: boolean;
  host: string;
  port: number;
  trustProxy: boolean;
  bootstrapToken: string | null;
  /** Raw master secret for the key store, or null when none is configured. */
  masterKey: Buffer | null;
  maxConcurrentJobs: number;
  runEnvPassthrough: string[];
  allowSshClone: boolean;
  runsDisabledReason: RunsDisabledReason;
}

export type ServerConfigResult = { ok: true; config: ServerConfig } | { ok: false; error: string };

function flag(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

function realpathOrResolve(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

/** True when `child` is `parent` or inside it (case-insensitive on win32). */
export function isPathInside(parent: string, child: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const a = norm(path.resolve(parent));
  const b = norm(path.resolve(child));
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/** Validate the server environment. Never throws. */
export function loadServerConfig(env: NodeJS.ProcessEnv): ServerConfigResult {
  const fail = (error: string): ServerConfigResult => ({ ok: false, error });

  const dataDirRaw = env.MOAG_DATA_DIR?.trim();
  if (!dataDirRaw) { return fail('MOAG_DATA_DIR is required.'); }
  const dataDir = path.resolve(dataDirRaw);

  const projectsRoot = path.resolve(env.MOAG_PROJECTS_ROOT?.trim() || path.join(dataDir, 'workspaces'));

  const publicUrlRaw = env.MOAG_PUBLIC_URL?.trim();
  if (!publicUrlRaw) { return fail('MOAG_PUBLIC_URL is required (e.g. https://moag.example.com).'); }
  let publicUrl: URL;
  try { publicUrl = new URL(publicUrlRaw); } catch { return fail('MOAG_PUBLIC_URL is not a valid URL.'); }
  if (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') {
    return fail('MOAG_PUBLIC_URL must be http or https.');
  }

  const host = env.MOAG_HOST?.trim() || DEFAULT_HOST;

  let port = DEFAULT_PORT;
  if (env.MOAG_PORT !== undefined && env.MOAG_PORT.trim() !== '') {
    const n = Number(env.MOAG_PORT);
    if (!Number.isInteger(n) || n < 0 || n > 65535) { return fail('MOAG_PORT must be an integer 0-65535.'); }
    port = n;
  }

  let bootstrapToken: string | null = null;
  if (env.MOAG_BOOTSTRAP_TOKEN !== undefined && env.MOAG_BOOTSTRAP_TOKEN !== '') {
    if (env.MOAG_BOOTSTRAP_TOKEN.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
      return fail(`MOAG_BOOTSTRAP_TOKEN must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters.`);
    }
    bootstrapToken = env.MOAG_BOOTSTRAP_TOKEN;
  }

  let masterKey: Buffer | null = null;
  if (env.MOAG_MASTER_KEY && env.MOAG_MASTER_KEY_FILE) {
    return fail('Set only one of MOAG_MASTER_KEY and MOAG_MASTER_KEY_FILE.');
  }
  if (env.MOAG_MASTER_KEY) {
    masterKey = Buffer.from(env.MOAG_MASTER_KEY, 'utf-8');
  } else if (env.MOAG_MASTER_KEY_FILE) {
    const keyFile = realpathOrResolve(env.MOAG_MASTER_KEY_FILE);
    if (isPathInside(realpathOrResolve(dataDir), keyFile)) {
      return fail('MOAG_MASTER_KEY_FILE must be outside MOAG_DATA_DIR (a data-volume backup would carry the key with the ciphertext).');
    }
    try {
      masterKey = Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'utf-8');
    } catch {
      return fail('MOAG_MASTER_KEY_FILE could not be read.');
    }
  }
  if (masterKey && masterKey.length < 16) {
    return fail('The master key must be at least 16 characters.');
  }

  let maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS;
  if (env.MOAG_MAX_CONCURRENT_JOBS !== undefined && env.MOAG_MAX_CONCURRENT_JOBS.trim() !== '') {
    const n = Number(env.MOAG_MAX_CONCURRENT_JOBS);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENT_JOBS_LIMIT) {
      return fail(`MOAG_MAX_CONCURRENT_JOBS must be an integer 1-${MAX_CONCURRENT_JOBS_LIMIT}.`);
    }
    maxConcurrentJobs = n;
  }

  const runEnvPassthrough: string[] = [];
  for (const name of (env.MOAG_RUN_ENV_PASSTHROUGH ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!ENV_NAME_RE.test(name)) { return fail(`MOAG_RUN_ENV_PASSTHROUGH: "${name}" is not a valid variable name.`); }
    if (name.startsWith('MOAG_')) { return fail(`MOAG_RUN_ENV_PASSTHROUGH: "${name}" — MOAG_* variables can never be passed to runs.`); }
    if (name === 'CI') { return fail('MOAG_RUN_ENV_PASSTHROUGH: CI can never be passed to runs (it auto-approves ship gates).'); }
    if (!runEnvPassthrough.includes(name)) { runEnvPassthrough.push(name); }
  }

  return {
    ok: true,
    config: {
      dataDir,
      projectsRoot,
      publicUrl: publicUrl.toString(),
      publicOrigin: publicUrl.origin,
      secureCookies: publicUrl.protocol === 'https:',
      host,
      port,
      trustProxy: flag(env.MOAG_TRUST_PROXY),
      bootstrapToken,
      masterKey,
      maxConcurrentJobs,
      runEnvPassthrough,
      allowSshClone: flag(env.MOAG_ALLOW_SSH_CLONE),
      runsDisabledReason: env.CI === 'true' ? 'ci' : null,
    },
  };
}

/**
 * Remove secrets from the live environment once they have been read, so that
 * no child spawned later inherits them from `process.env`. This does NOT clear
 * the kernel's copy (`/proc/<pid>/environ` keeps the startup environment) —
 * prefer `MOAG_MASTER_KEY_FILE` over `MOAG_MASTER_KEY` for that reason.
 */
export function scrubServerSecrets(env: NodeJS.ProcessEnv): void {
  delete env.MOAG_MASTER_KEY;
  delete env.MOAG_BOOTSTRAP_TOKEN;
}
