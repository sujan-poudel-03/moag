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
// The one exception is the home folder as the working folder: it contains the
// config dir by design, and is allowed when no git repository could commit it.
//
// No key → null, silently: the relay is off and `moag run` behaves as before.
// Imports nothing that loads `vscode`.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { API_KEY_RE } from '../shared/engine-keys';
import { writeFileAtomicSync } from '../utils/file-io';

/** Path of the ingest function under the configured base URL. */
export const EVENTS_PATH = '/functions/v1/builds/events';

/**
 * The hosted ONOSOO backend. Only pairing (`moag pair`, MOAG: Connect to ONOSOO
 * Builds) fills it in, and it always writes `url` to onosoo.json: a key with no
 * URL still leaves the relay off here, so a key-only environment never quietly
 * targets production.
 */
export const DEFAULT_ONOSOO_URL = 'https://jcudchpeetqutfplksre.supabase.co';

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

/** True when a `.git` (directory or file) sits in `from` or any folder above it, up to and including `stop`. */
function gitBetween(from: string, stop: string, platform: NodeJS.Platform): boolean {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) { return true; }
    if (!isInside(stop, dir, platform) || isInside(dir, stop, platform)) { return false; }
    const up = path.dirname(dir);
    if (up === dir) { return false; }
    dir = up;
  }
}

/**
 * True when the config dir under `cwd` must turn the relay off. A project folder that contains
 * it always does. The home folder (or a folder above it, such as C:\Users) is not a project: it
 * holds the config dir by design, and `moag daemon` is often started there. It is allowed unless
 * a git repository lies between the config dir and `cwd`, since only a repository can commit the key.
 */
function configDirExposed(cwd: string, stateDir: string, home: string, platform: NodeJS.Platform): boolean {
  if (!isInside(cwd, stateDir, platform)) { return false; }
  if (!isInside(cwd, home, platform)) { return true; }
  return gitBetween(stateDir, cwd, platform);
}

/**
 * Resolve the relay configuration, or null when the relay is off. Never throws.
 * A key with no usable URL, or a config dir inside the workspace (other than the
 * home folder; see configDirExposed), is reported on `stderr` once and turns the relay off.
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
        : 'ONOSOO relay is off: a device key is set but no URL (set MOAG_ONOSOO_URL or "url" in onosoo.json). Run `moag pair`.\n');
      return null;
    }

    if (configDirExposed(opts.cwd, stateDir, homedir(), platform)) {
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
