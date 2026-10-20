// ─── Run recipe: how a project becomes a running environment ───
//
// <project>/.moag/environment.json, in the APPROVED project folder (the main checkout listed in
// projects.json) — never read from the branch being run. A branch is code an AI may have written;
// letting it change its own recipe would let it change what is published and how it is limited.
// The compose file itself does come from the branch: running the branch's code is the point.
//
//   {
//     "version": 1,
//     "compose_file": "docker-compose.yml",
//     "services": {
//       "web": { "role": "web", "port": 5173 },
//       "api": { "role": "api" },
//       "db":  { "role": "db" }
//     },
//     "reset_db": { "service": "api", "command": ["npm", "run", "db:reset"] }
//   }
//
// compose_file: relative to the branch's worktree, or "@project/<path>" for a file kept in the
//               approved folder (a generated compose for a project that has none of its own).
// services:     roles for the compose services; exactly one "web" with its container port gives
//               the environment a preview. Services the recipe does not name run as "other".
// reset_db:     optional command run with `docker compose exec` to reset data; without it, a reset
//               recreates the stack's volumes.
//
// `moag host draft <project>` writes .moag/environment.draft.json for a person to check and rename.
// Nothing is ever started from a draft.
//
// Imports only path; never vscode.

import * as path from 'path';

import type { ServiceRole } from './types';

export const RECIPE_FILE = path.join('.moag', 'environment.json');
export const DRAFT_FILE = path.join('.moag', 'environment.draft.json');
export const GENERATED_COMPOSE = path.join('.moag', 'compose.generated.yml');
export const PROJECT_PREFIX = '@project/';

const SERVICE_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const ROLES: ReadonlySet<string> = new Set(['web', 'api', 'db', 'worker', 'other']);

export interface Recipe {
  /** Relative to the worktree, or (fromProject) to the approved project folder. */
  composeFile: string;
  composeFromProject: boolean;
  roles: Record<string, ServiceRole>;
  web: { service: string; port: number } | null;
  resetDb: { service: string; command: string[] } | null;
}

export type RecipeResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** A relative path that stays inside its base: no absolute paths, no `..` segments. */
function safeRelative(p: string): boolean {
  if (!p || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) { return false; }
  return !p.split(/[\\/]+/).some((seg) => seg === '..');
}

/** Parse environment.json's text. Pure. */
export function parseRecipe(text: string): RecipeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'environment.json is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { ok: false, error: 'environment.json must be a JSON object.' }; }
  const o = raw as Record<string, unknown>;

  const composeRaw = typeof o.compose_file === 'string' ? o.compose_file.trim() : 'docker-compose.yml';
  const fromProject = composeRaw.startsWith(PROJECT_PREFIX);
  const composeFile = fromProject ? composeRaw.slice(PROJECT_PREFIX.length) : composeRaw;
  if (!safeRelative(composeFile)) { return { ok: false, error: 'compose_file must be a relative path inside the project.' }; }

  const roles: Record<string, ServiceRole> = {};
  let web: Recipe['web'] = null;
  const services = o.services && typeof o.services === 'object' && !Array.isArray(o.services) ? o.services as Record<string, unknown> : {};
  for (const [name, value] of Object.entries(services)) {
    if (!SERVICE_RE.test(name)) { return { ok: false, error: `Service name "${name}" is not valid.` }; }
    const s = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const role = typeof s.role === 'string' && ROLES.has(s.role) ? s.role as ServiceRole : 'other';
    roles[name] = role;
    if (role === 'web') {
      if (web) { return { ok: false, error: 'Only one service can have the "web" role.' }; }
      const port = s.port;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: `The web service "${name}" needs its container "port".` };
      }
      web = { service: name, port };
    }
  }

  let resetDb: Recipe['resetDb'] = null;
  if (o.reset_db !== undefined && o.reset_db !== null) {
    const r = o.reset_db as Record<string, unknown>;
    const command = Array.isArray(r?.command) ? r.command : null;
    if (typeof r?.service !== 'string' || !SERVICE_RE.test(r.service) || !command || command.length === 0
      || command.length > 50 || !command.every((c) => typeof c === 'string' && c.length > 0 && c.length <= 1000)) {
      return { ok: false, error: 'reset_db needs a "service" and a non-empty "command" array of strings.' };
    }
    resetDb = { service: r.service, command: command as string[] };
  }

  return { ok: true, recipe: { composeFile, composeFromProject: fromProject, roles, web, resetDb } };
}

// ─── Drafting ───

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** The project's own compose file name, if it has one. */
export function findComposeFile(exists: (name: string) => boolean): string | null {
  return COMPOSE_NAMES.find((n) => exists(n)) ?? null;
}

/** A first guess at a service's role from its name. A person confirms it in the draft. */
export function guessRole(service: string): ServiceRole {
  const n = service.toLowerCase();
  if (/^(web|frontend|front|app|client|ui|site|www)([-_].*)?$/.test(n)) { return 'web'; }
  if (/^(api|server|backend|back|svc|service)([-_].*)?$/.test(n)) { return 'api'; }
  if (/(postgres|postgresql|mysql|mariadb|mongo|mongodb|^db$|database|sqlserver|mssql)/.test(n)) { return 'db'; }
  if (/(worker|queue|jobs|celery|sidekiq)/.test(n)) { return 'worker'; }
  return 'other';
}

/** Common dev-server ports by service role guess, for the draft only. */
const WEB_PORT_GUESS = 3000;

export interface Draft {
  recipe: Record<string, unknown>;
  /** A compose file to write to the approved folder, when the project has none. */
  generatedCompose: string | null;
  notes: string[];
}

/**
 * Draft a recipe for a project with its own compose file. `services` comes from
 * `docker compose config --services`.
 */
export function draftFromCompose(composeFile: string, services: string[]): Draft {
  const out: Record<string, { role: ServiceRole; port?: number }> = {};
  let webSeen = false;
  for (const s of services) {
    let role = guessRole(s);
    if (role === 'web' && webSeen) { role = 'other'; }
    if (role === 'web') { webSeen = true; }
    out[s] = role === 'web' ? { role, port: WEB_PORT_GUESS } : { role };
  }
  const notes = [`Roles were guessed from service names in ${composeFile}; check each one.`];
  if (webSeen) { notes.push(`Set the web service's "port" to the port it listens on INSIDE its container (guessed ${WEB_PORT_GUESS}).`); }
  else { notes.push('No service looked like the website. Give the one serving pages "role": "web" and its container "port", or the environment will have no preview.'); }
  return { recipe: { version: 1, compose_file: composeFile, services: out }, generatedCompose: null, notes };
}

/**
 * Draft a recipe and a compose file for a Node project without one, from its package.json. Covers
 * the common dev servers; anything else gets a note asking for a compose file.
 */
export function draftFromPackageJson(pkgText: string): Draft | null {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return null;
  }
  const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, unknown>;
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  if (typeof scripts.dev !== 'string') { return null; }

  let port: number;
  let devArgs: string;
  if ('next' in deps) { port = 3000; devArgs = '-- -H 0.0.0.0 -p 3000'; }
  else if ('vite' in deps) { port = 5173; devArgs = '-- --host 0.0.0.0 --port 5173 --strictPort'; }
  else if ('nuxt' in deps) { port = 3000; devArgs = '-- --host 0.0.0.0 --port 3000'; }
  else if ('@angular/cli' in deps) { port = 4200; devArgs = '-- --host 0.0.0.0 --port 4200'; }
  else { return null; }

  const lock = 'package-lock.json';
  const compose = [
    '# Generated by `moag host draft`. Kept in the approved project folder, not in any branch.',
    'services:',
    '  web:',
    '    image: node:20-bookworm',
    '    working_dir: /app',
    '    volumes:',
    '      - ./:/app',
    '      - node_modules:/app/node_modules',
    `    command: ["sh", "-c", "(test -f ${lock} && npm ci || npm install) && npm run dev ${devArgs}"]`,
    '    environment:',
    '      - CHOKIDAR_USEPOLLING=true',
    'volumes:',
    '  node_modules: {}',
    '',
  ].join('\n');

  return {
    recipe: { version: 1, compose_file: `${PROJECT_PREFIX}${GENERATED_COMPOSE.replace(/\\/g, '/')}`, services: { web: { role: 'web', port } } },
    generatedCompose: compose,
    notes: [
      `No compose file was found, so one was generated for the dev server on port ${port}.`,
      'Backends and databases are not included: add them to the generated compose file if the app needs them.',
    ],
  };
}
