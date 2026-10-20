// ─── Host agent configuration ───
//
// <configDir>/moag/host.json, next to onosoo.json and projects.json. User-level for the same reason
// they are: nothing in a workspace, and so nothing an agent writes into a branch, can change where
// previews are served or how much of the machine an environment may take.
//
//   {
//     "version": 1,
//     "preview_domain": "preview.onosoo.com",
//     "app_url": "https://app.onosoo.com",
//     "app_origins": ["https://app.onosoo.com"],
//     "gateway": { "port": 8787 },
//     "limits": { "max_environments": 4, "cpus": 2, "memory_mb": 2048, "idle_stop_minutes": 120 },
//     "tunnel": { "token_file": "/home/me/.config/moag/cloudflared.token" }
//   }
//
// Only preview_domain is required. `tunnel` is optional: without it the agent expects cloudflared
// (or any tunnel) to be run separately, pointing `*.<preview_domain>` at the gateway port.
//
// Imports only fs and path; never vscode.

import * as fs from 'fs';
import * as path from 'path';

export const HOST_CONFIG_FILE = 'host.json';

/** A DNS name of two or more lower-case labels. No scheme, port or path. */
const DOMAIN_RE = /^(?=.{3,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface HostConfig {
  previewDomain: string;
  appUrl: string;
  /** Origins allowed to call the gateway's logs/status endpoints from the browser. */
  appOrigins: string[];
  gatewayPort: number;
  maxEnvironments: number;
  /** Per service, applied as compose resource limits. */
  cpus: number;
  memoryMb: number;
  /** Stop a running environment nobody has opened for this long. 0 = never. */
  idleStopMinutes: number;
  tunnelTokenFile: string | null;
  /** Where branch worktrees live: <stateDir>/host/worktrees. */
  worktreesDir: string;
  /** Agent state: <stateDir>/host/state.json. */
  stateFile: string;
}

export type HostConfigResult = { ok: true; config: HostConfig } | { ok: false; error: string };

function httpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  try {
    const u = new URL(value);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) { return null; }
    return u.origin;
  } catch {
    return null;
  }
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** Parse host.json's text. Pure. */
export function parseHostConfig(text: string, stateDir: string): HostConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'host.json is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { ok: false, error: 'host.json must be a JSON object.' }; }
  const o = raw as Record<string, unknown>;

  const domain = typeof o.preview_domain === 'string' ? o.preview_domain.trim().toLowerCase() : '';
  if (!DOMAIN_RE.test(domain)) {
    return { ok: false, error: 'host.json: "preview_domain" must be a domain name like preview.onosoo.com.' };
  }

  const appUrl = httpsOrigin(o.app_url) ?? 'https://app.onosoo.com';
  const origins = Array.isArray(o.app_origins) ? o.app_origins.map(httpsOrigin).filter((x): x is string => !!x) : [];
  const gateway = (o.gateway && typeof o.gateway === 'object' ? o.gateway : {}) as Record<string, unknown>;
  const limits = (o.limits && typeof o.limits === 'object' ? o.limits : {}) as Record<string, unknown>;
  const tunnel = (o.tunnel && typeof o.tunnel === 'object' ? o.tunnel : null) as Record<string, unknown> | null;
  const tokenFile = tunnel && typeof tunnel.token_file === 'string' && path.isAbsolute(tunnel.token_file) ? tunnel.token_file : null;
  if (tunnel && !tokenFile) { return { ok: false, error: 'host.json: "tunnel.token_file" must be an absolute path.' }; }

  const cpus = typeof limits.cpus === 'number' && limits.cpus > 0 && limits.cpus <= 64 ? limits.cpus : 2;
  return {
    ok: true,
    config: {
      previewDomain: domain,
      appUrl,
      appOrigins: origins.length > 0 ? [...new Set(origins)] : [appUrl],
      gatewayPort: intIn(gateway.port, 1024, 65535, 8787),
      maxEnvironments: intIn(limits.max_environments, 1, 50, 4),
      cpus,
      memoryMb: intIn(limits.memory_mb, 256, 262144, 2048),
      idleStopMinutes: intIn(limits.idle_stop_minutes, 0, 7 * 24 * 60, 120),
      tunnelTokenFile: tokenFile,
      worktreesDir: path.join(stateDir, 'host', 'worktrees'),
      stateFile: path.join(stateDir, 'host', 'state.json'),
    },
  };
}

export function loadHostConfig(stateDir: string, readFile: (f: string) => string = (f) => fs.readFileSync(f, 'utf-8')): HostConfigResult {
  const file = path.join(stateDir, HOST_CONFIG_FILE);
  let text: string;
  try {
    text = readFile(file);
  } catch {
    return { ok: false, error: `No ${file}. Run "moag host init" to create one, then set "preview_domain".` };
  }
  return parseHostConfig(text, stateDir);
}

export const HOST_CONFIG_TEMPLATE = JSON.stringify({
  version: 1,
  preview_domain: 'preview.onosoo.com',
  app_url: 'https://app.onosoo.com',
  app_origins: ['https://app.onosoo.com'],
  gateway: { port: 8787 },
  limits: { max_environments: 4, cpus: 2, memory_mb: 2048, idle_stop_minutes: 120 },
}, null, 2) + '\n';
