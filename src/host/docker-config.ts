// ─── Docker client configuration: no registry credentials for environments ───
//
// A branch's compose file names the images it pulls. With the main user's Docker configuration,
// `docker compose up` would log in to private registries with the user's saved credentials (`auths`,
// a `credsStore` such as the desktop keychain, or per-registry `credHelpers`) — so a branch could
// pull, and bake into a preview, anything the user can read. Every docker and compose child of
// `moag host` therefore runs with DOCKER_CONFIG pointing at a host-owned folder,
//
//   <configDir>/moag/host/docker-config/      (0700)
//     config.json                              (0600) no auths, no credsStore, no credHelpers
//     contexts/meta/<sha256>/meta.json         copied context metadata (endpoints, no keys)
//
// so only public images can be pulled. With DOCKER_CONFIG set the Docker CLI never reads
// ~/.docker (cli/config: Dir() uses HOME only when DOCKER_CONFIG is empty, and a missing
// config.json falls back to defaults, not to HOME) — and config.json is always written here.
//
// What is carried over from the user's real configuration, and nothing else:
//   - `currentContext`, so a non-default Docker context keeps working;
//   - `contexts/meta`: context metadata (name, endpoint host, skip-TLS flag; no credentials). Never
//     `contexts/tls` (client keys). A context that needs TLS material must be configured through
//     DOCKER_HOST + DOCKER_CERT_PATH + DOCKER_TLS_VERIFY instead;
//   - the user's `cli-plugins` folder, listed in `cliPluginsExtraDirs`, so a Compose or buildx
//     plugin installed under ~/.docker/cli-plugins is still found. The folder is referenced, not
//     copied.
//
// Imports only fs, os and path; never vscode.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type DockerConfigFs = Pick<
  typeof fs,
  'mkdirSync' | 'writeFileSync' | 'readFileSync' | 'chmodSync' | 'rmSync' | 'renameSync' | 'lstatSync' | 'readdirSync' | 'existsSync'
>;

/** A Docker context name as the CLI accepts it. */
const CONTEXT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/;
/** Context metadata folders are named by the sha256 of the context name. */
const META_DIR_RE = /^[0-9a-f]{64}$/;
const MAX_META_BYTES = 64 * 1024;

/** <stateDir>/host/docker-config, where stateDir is <configDir>/moag. */
export function hostDockerConfigDir(stateDir: string): string {
  return path.join(stateDir, 'host', 'docker-config');
}

/** The user's own Docker configuration folder: DOCKER_CONFIG, else ~/.docker. */
export function userDockerConfigDir(env: NodeJS.ProcessEnv, homedir: () => string = os.homedir): string {
  const fromEnv = env.DOCKER_CONFIG?.trim();
  if (fromEnv) { return path.resolve(fromEnv); }
  return path.join(env.HOME?.trim() || homedir(), '.docker');
}

/**
 * The host-owned config.json for the user's config.json text (null when there is none). Pure.
 * Only `currentContext` is kept from the user's file; `pluginsDir` becomes `cliPluginsExtraDirs`.
 */
export function hostDockerConfigJson(userConfigText: string | null, pluginsDir: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (userConfigText) {
    try {
      const raw: unknown = JSON.parse(userConfigText);
      const ctx = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).currentContext : undefined;
      if (typeof ctx === 'string' && CONTEXT_NAME_RE.test(ctx) && ctx !== 'default') { out.currentContext = ctx; }
    } catch {
      /* an unreadable user config carries nothing over */
    }
  }
  if (pluginsDir) { out.cliPluginsExtraDirs = [pluginsDir]; }
  return out;
}

/** Copy only contexts/meta/<sha256>/meta.json, as regular files; links and anything else are skipped. */
function copyContextMeta(fsx: DockerConfigFs, fromConfigDir: string, toConfigDir: string): void {
  const dest = path.join(toConfigDir, 'contexts');
  fsx.rmSync(dest, { recursive: true, force: true });
  const src = path.join(fromConfigDir, 'contexts', 'meta');
  let entries: string[];
  try {
    if (!fsx.lstatSync(src).isDirectory()) { return; }
    entries = fsx.readdirSync(src);
  } catch {
    return; // no contexts
  }
  for (const name of entries) {
    if (!META_DIR_RE.test(name)) { continue; }
    const file = path.join(src, name, 'meta.json');
    try {
      if (!fsx.lstatSync(path.join(src, name)).isDirectory()) { continue; }
      const st = fsx.lstatSync(file);
      if (!st.isFile() || st.size > MAX_META_BYTES) { continue; }
      const text = String(fsx.readFileSync(file, 'utf-8'));
      JSON.parse(text); // metadata only; anything that is not JSON is not copied
      const outDir = path.join(dest, 'meta', name);
      fsx.mkdirSync(outDir, { recursive: true, mode: 0o700 });
      fsx.writeFileSync(path.join(outDir, 'meta.json'), text, { mode: 0o600 });
    } catch {
      /* skip this context */
    }
  }
}

/**
 * Write the host-owned Docker configuration and return its folder, for DOCKER_CONFIG. Called before
 * the first docker child of a process; throws when it cannot be written, and nothing may then fall
 * back to the user's configuration.
 */
export function prepareHostDockerConfig(
  stateDir: string,
  env: NodeJS.ProcessEnv,
  opts: { fs?: DockerConfigFs; homedir?: () => string } = {},
): string {
  const fsx = opts.fs ?? fs;
  const dir = hostDockerConfigDir(stateDir);
  fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsx.chmodSync(dir, 0o700);

  const userDir = userDockerConfigDir(env, opts.homedir);
  const same = path.resolve(userDir) === path.resolve(dir);
  let userText: string | null = null;
  try { userText = String(fsx.readFileSync(path.join(userDir, 'config.json'), 'utf-8')); } catch { /* none */ }
  const plugins = path.join(userDir, 'cli-plugins');
  let pluginsDir: string | null = null;
  try { if (!same && fsx.lstatSync(plugins).isDirectory()) { pluginsDir = plugins; } } catch { /* none */ }

  const file = path.join(dir, 'config.json');
  const tmp = `${file}.tmp`;
  fsx.writeFileSync(tmp, JSON.stringify(hostDockerConfigJson(userText, pluginsDir), null, 2) + '\n', { mode: 0o600 });
  fsx.chmodSync(tmp, 0o600);
  fsx.renameSync(tmp, file);

  if (!same) { copyContextMeta(fsx, userDir, dir); }
  return dir;
}

/** The environment for a docker/compose child: the allow-listed `base`, with DOCKER_CONFIG = `dir`. */
export function dockerChildEnv(base: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  return { ...base, DOCKER_CONFIG: dir };
}
