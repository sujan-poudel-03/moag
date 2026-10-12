// ─── ONOSOO approved projects ───
//
// The machine owner's allow-list of repositories ONOSOO may start runs in:
// <stateDir>/projects.json (stateDir = <configDir>/moag, beside onosoo.json).
//
//   { "version": 1, "remote_start": false, "daily_budget_usd": null, "runner_user": null,
//     "projects": [ { "id": "web-app", "name": "Web app", "path": "/home/me/web-app", "kinds": ["node"] } ] }
//
// The host agent (src/host/, branch feat/host-agent) imports this file to decide
// what it may offer and run. ONOSOO only ever sees {id, name, kinds} — never
// `path`, which stays on this machine.
//
// Every rule fails closed: a bad top-level field turns into its safe default
// (remote start off, no budget, no runner user) plus an error, and a bad entry is
// rejected on its own while the others still load. Synchronous; never throws.
// Imports `fs` and `path` only — no `vscode`, no child processes (a git top level
// is recognised by its `.git`, not by running git).

import * as fs from 'fs';
import * as path from 'path';

/** One approved repository. `path` is its real path; it never leaves the machine. */
export interface ApprovedProject {
  id: string;
  name: string;
  kinds: string[];
  path: string;
}

export interface ApprovedProjects {
  /** True only when the file says `"remote_start": true`. */
  remoteStart: boolean;
  dailyBudgetUsd: number | null;
  /** OS account runs should use; never `root`. */
  runnerUser: string | null;
  projects: ApprovedProject[];
  /** One readable line per problem found; empty when the file is clean (or absent). */
  errors: string[];
}

export interface LoadApprovedProjectsOptions {
  platform?: NodeJS.Platform;
  realpath?: (p: string) => string;
}

export const PROJECTS_FILE = 'projects.json';
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_PROJECTS = 200;

const RUNNER_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const MAX_NAME = 200;

function empty(errors: string[] = []): ApprovedProjects {
  return { remoteStart: false, dailyBudgetUsd: null, runnerUser: null, projects: [], errors };
}

/** A path in comparable form: forward slashes and case-folded on win32, no trailing separator. */
function comparable(p: string, platform: NodeJS.Platform): string {
  let s = platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p;
  while (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/i.test(s)) { s = s.slice(0, -1); }
  return s;
}

/** True when `inner` is `outer` or below it, on path boundaries (`/a/b` is not inside `/a/bc`). */
function within(outer: string, inner: string): boolean {
  if (outer === inner) { return true; }
  const prefix = outer.endsWith('/') ? outer : `${outer}/`;
  return inner.startsWith(prefix);
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

/**
 * Read and validate `<stateDir>/projects.json`. A missing file is not an error:
 * it means "nothing approved". Never throws.
 */
export function loadApprovedProjects(stateDir: string, opts: LoadApprovedProjectsOptions = {}): ApprovedProjects {
  try {
    const platform = opts.platform ?? process.platform;
    const realpath = opts.realpath ?? ((p: string): string => fs.realpathSync(p));
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const file = path.join(stateDir, PROJECTS_FILE);

    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return empty(); }
      return empty([`${PROJECTS_FILE} could not be read: ${(err as Error).message}`]);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return empty([`${PROJECTS_FILE} is not valid JSON.`]);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return empty([`${PROJECTS_FILE} must contain a JSON object.`]);
    }
    const doc = raw as Record<string, unknown>;
    if (doc.version !== 1) {
      return empty([`${PROJECTS_FILE} has version ${JSON.stringify(doc.version)}; only version 1 is understood.`]);
    }

    const out = empty();
    const errors = out.errors;

    // ─── Top-level settings ───

    if (doc.remote_start === true) {
      out.remoteStart = true;
    } else if (doc.remote_start !== undefined && doc.remote_start !== false) {
      errors.push(`remote_start must be true or false (got ${JSON.stringify(doc.remote_start)}); remote start stays off.`);
    }

    const budget = doc.daily_budget_usd;
    if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
      out.dailyBudgetUsd = budget;
    } else if (budget !== undefined && budget !== null) {
      errors.push(`daily_budget_usd must be a positive number or null (got ${JSON.stringify(budget)}); no budget is set.`);
    }

    const user = doc.runner_user;
    if (typeof user === 'string' && RUNNER_USER_RE.test(user) && user !== 'root') {
      out.runnerUser = user;
    } else if (user !== undefined && user !== null) {
      errors.push(user === 'root'
        ? 'runner_user must not be root; no runner user is set.'
        : `runner_user must be a plain account name (got ${JSON.stringify(user)}); no runner user is set.`);
    }

    // ─── Projects ───

    if (doc.projects === undefined) { return out; }
    if (!Array.isArray(doc.projects)) {
      errors.push('projects must be an array; no project is approved.');
      return out;
    }
    let entries = doc.projects as unknown[];
    if (entries.length > MAX_PROJECTS) {
      errors.push(`projects lists ${entries.length} entries; only the first ${MAX_PROJECTS} are read.`);
      entries = entries.slice(0, MAX_PROJECTS);
    }

    const idOf = (e: unknown): string | null => {
      const id = e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>).id : undefined;
      return typeof id === 'string' && PROJECT_ID_RE.test(id) ? id : null;
    };
    const idCounts = new Map<string, number>();
    for (const e of entries) {
      const id = idOf(e);
      if (id) { idCounts.set(id, (idCounts.get(id) ?? 0) + 1); }
    }

    let stateReal: string;
    try { stateReal = realpath(stateDir); } catch { stateReal = pathApi.resolve(stateDir); }
    const stateCmp = comparable(stateReal, platform);

    const accepted: Array<{ project: ApprovedProject; cmp: string; label: string }> = [];
    entries.forEach((e, i) => {
      const id = idOf(e);
      const label = id ?? `projects[${i}]`;
      const reject = (reason: string): void => { errors.push(`${label}: ${reason}`); };

      if (!e || typeof e !== 'object' || Array.isArray(e)) { reject('entry must be an object.'); return; }
      const entry = e as Record<string, unknown>;
      if (!id) { reject(`id must match ${PROJECT_ID_RE} (got ${JSON.stringify(entry.id)}).`); return; }
      if ((idCounts.get(id) ?? 0) > 1) { reject('id is used by more than one project; every entry with it is rejected.'); return; }

      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name) { reject('name must be a non-empty string.'); return; }

      let kinds: string[] = [];
      if (entry.kinds !== undefined) {
        if (!Array.isArray(entry.kinds) || !entry.kinds.every((k) => typeof k === 'string')) {
          reject('kinds must be an array of strings.');
          return;
        }
        kinds = [...entry.kinds as string[]];
      }

      const p = entry.path;
      if (typeof p !== 'string' || !pathApi.isAbsolute(p)) { reject('path must be an absolute path.'); return; }
      let stat: fs.Stats;
      try { stat = fs.statSync(p); } catch { reject(`path does not exist: ${p}`); return; }
      if (!stat.isDirectory()) { reject(`path is not a directory: ${p}`); return; }
      if (!fs.existsSync(path.join(p, '.git'))) { reject(`path is not the top level of a git repository (no .git): ${p}`); return; }

      let real: string;
      try { real = realpath(p); } catch { reject(`path could not be resolved: ${p}`); return; }
      const cmp = comparable(real, platform);
      if (overlaps(cmp, stateCmp)) {
        reject('path must not be, contain, or sit inside the MOAG state directory.');
        return;
      }

      accepted.push({ project: { id, name: name.slice(0, MAX_NAME), kinds, path: real }, cmp, label });
    });

    // Overlapping repositories reject both: a run in one would touch the other.
    const bad = new Set<number>();
    for (let a = 0; a < accepted.length; a++) {
      for (let b = a + 1; b < accepted.length; b++) {
        if (overlaps(accepted[a].cmp, accepted[b].cmp)) { bad.add(a); bad.add(b); }
      }
    }
    accepted.forEach((x, i) => {
      if (bad.has(i)) {
        errors.push(`${x.label}: path overlaps another approved project's path; both are rejected.`);
      } else {
        out.projects.push(x.project);
      }
    });
    return out;
  } catch (err) {
    return empty([`${PROJECTS_FILE} could not be loaded: ${err instanceof Error ? err.message : String(err)}`]);
  }
}
