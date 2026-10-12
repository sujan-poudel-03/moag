// ─── ONOSOO relay configuration ───
//
// Decides whether `moag run` relays its events to ONOSOO, and where. Sources,
// and ONLY these:
//
//   key       env MOAG_ONOSOO_KEY, else `key` in <configDir>/moag/onosoo.json
//   base URL  env MOAG_ONOSOO_URL, else `url` in that file
//   device id `device_id` in that file, generated and persisted on first use
//
// <configDir> is %APPDATA% on Windows, else $XDG_CONFIG_HOME, else ~/.config.
// The file is user-level on purpose: nothing relay-related is ever read from or
// written under the workspace, so a delivery commit can never carry the key.
//
// No key → null, silently: the relay is off and `moag run` behaves as before.
// Imports nothing that loads `vscode`.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { API_KEY_RE } from '../server/secrets';
import { writeFileAtomicSync } from '../utils/file-io';

/** Path of the ingest function under the configured base URL. */
export const EVENTS_PATH = '/functions/v1/builds/events';

export interface OnosooConfig {
  key: string;
  baseUrl: string;
  /** Full URL every relay request is POSTed to. */
  endpoint: string;
  deviceId: string;
  /** <configDir>/moag — where the config file and the spool live. */
  stateDir: string;
}

export interface ResolveOnosooOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  stderr?: (s: string) => void;
}

interface OnosooFile {
  key?: unknown;
  url?: unknown;
  device_id?: unknown;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The per-user config directory for `platform`, from the injected env. */
export function userConfigDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: () => string): string {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (appData) { return appData; }
    return path.join(homedir(), 'AppData', 'Roaming');
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) { return xdg; }
  return path.join(homedir(), '.config');
}

function readConfigFile(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * The endpoint for `raw`, or null when it is not an acceptable base URL: https,
 * or http only to a loopback host; no query, fragment or credentials.
 */
export function endpointFor(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) { return null; }
  if (url.search || url.hash || url.username || url.password) { return null; }
  return url.origin + url.pathname.replace(/\/+$/, '') + EVENTS_PATH;
}

/** True when `child` is `parent` or inside it. */
function isInside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve the relay configuration, or null when the relay is off. Never throws.
 * A key with no usable URL, or a config dir inside the workspace, is reported
 * on `stderr` once and turns the relay off.
 */
export function resolveOnosooConfig(opts: ResolveOnosooOptions): OnosooConfig | null {
  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? os.homedir;
  const stderr = opts.stderr ?? ((s: string): void => { process.stderr.write(s); });
  try {
    const configDir = userConfigDir(opts.env, platform, homedir);
    const stateDir = path.join(configDir, 'moag');
    const file = path.join(stateDir, 'onosoo.json');
    const existing = readConfigFile(file);
    const fromFile = existing as OnosooFile;

    const envKey = opts.env.MOAG_ONOSOO_KEY;
    const key = typeof envKey === 'string' && envKey.length > 0 ? envKey
      : typeof fromFile.key === 'string' ? fromFile.key : '';
    if (!key) { return null; }
    if (!API_KEY_RE.test(key)) {
      stderr('ONOSOO relay is off: the device key is not 8-512 printable characters.\n');
      return null;
    }

    const envUrl = opts.env.MOAG_ONOSOO_URL;
    const rawUrl = typeof envUrl === 'string' && envUrl.length > 0 ? envUrl
      : typeof fromFile.url === 'string' ? fromFile.url : '';
    const endpoint = rawUrl ? endpointFor(rawUrl) : null;
    if (!endpoint) {
      stderr(rawUrl
        ? 'ONOSOO relay is off: MOAG_ONOSOO_URL must be an https URL (http only for localhost) with no query, fragment or credentials.\n'
        : 'ONOSOO relay is off: a device key is set but no URL (set MOAG_ONOSOO_URL or "url" in onosoo.json).\n');
      return null;
    }

    if (isInside(opts.cwd, stateDir, platform)) {
      stderr('ONOSOO relay is off: the user config directory is inside the workspace, and relay state must never be written there.\n');
      return null;
    }

    let deviceId = typeof fromFile.device_id === 'string' && fromFile.device_id.length > 0 ? fromFile.device_id : '';
    if (!deviceId) {
      deviceId = randomUUID();
      try {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeFileAtomicSync(file, JSON.stringify({ ...existing, device_id: deviceId }, null, 2), 0o600);
      } catch {
        stderr('ONOSOO relay: could not save the device id; a new one is used for this run only.\n');
      }
    }

    return { key, baseUrl: rawUrl, endpoint, deviceId, stateDir };
  } catch {
    return null;
  }
}
