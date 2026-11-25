// ─── `moag init`: set a machine up for ONOSOO in one command ───
//
// Run it inside a git repository:
//
//   cd D:\Projects\shop && moag init
//
// It does what the manual guide did in five steps: pairs the machine (asks for the device key unless it is
// already paired), adds this repository to <config>/moag/projects.json (creating the file in local mode with
// remote start on and a daily budget if there is none), and says what to run next. Nothing is guessed that
// could widen what ONOSOO may do: an existing file's mode, budget and other projects are never changed, delivery
// is "draft-pr" only when `gh` is signed in (else "branch" for a repository with an origin, else off), and the
// folder must be the top level of a git repository. Pairing and writing the file are the only side effects;
// nothing is started and nothing is sent except the pairing check `moag pair` already makes.
// Imports nothing that loads `vscode`.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { userConfigDir } from './onosoo-config';
import { loadApprovedProjects, PROJECT_ID_RE, PROJECTS_FILE } from './onosoo-projects';

export const INIT_USAGE =
  'Usage: moag init [<folder>] [--url <ONOSOO base URL>] [--name <name>] [--id <id>] [--budget <usd>] [--delivery off|branch|draft-pr] [--pr-base <branch>]\n'
  + '  Run it inside a git repository (or pass its folder). Pairs this machine if it is not paired, lists the repository\n'
  + '  as a project ONOSOO may start runs in, and says what to run next.\n';

export interface InitOptions {
  folder?: string;
  url?: string;
  name?: string;
  id?: string;
  budget?: number;
  delivery?: 'off' | 'branch' | 'draft-pr';
  prBase?: string;
}

/** Parse `moag init`'s own arguments; an error string when they are wrong. */
export function parseInitArgs(argv: string[]): { opts: InitOptions } | { error: string } {
  const opts: InitOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string | undefined => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { return undefined; } i++; return v; };
    if (arg === '--url') { const v = value(); if (!v) { return { error: '--url needs the ONOSOO base URL.' }; } opts.url = v; }
    else if (arg === '--name') { const v = value(); if (!v?.trim()) { return { error: '--name needs a name.' }; } opts.name = v.trim(); }
    else if (arg === '--id') { const v = value(); if (!v || !PROJECT_ID_RE.test(v)) { return { error: `--id must match ${PROJECT_ID_RE}.` }; } opts.id = v; }
    else if (arg === '--pr-base') {
      const v = value();
      if (!v || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(v) || v.includes('..')) { return { error: '--pr-base must be a plain branch name.' }; }
      opts.prBase = v;
    }
    else if (arg === '--budget') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0 || n > 1000) { return { error: '--budget must be a number above 0 and up to 1000 (US dollars per day).' }; }
      opts.budget = n;
    }
    else if (arg === '--delivery') {
      const v = value();
      if (v !== 'off' && v !== 'branch' && v !== 'draft-pr') { return { error: '--delivery must be off, branch or draft-pr.' }; }
      opts.delivery = v;
    }
    else if (arg.startsWith('--')) { return { error: `Unknown option ${arg}.` }; }
    else if (opts.folder === undefined) { opts.folder = arg; }
    else { return { error: 'Only one folder can be given.' }; }
  }
  return { opts };
}

export interface InitDeps {
  /** The environment the config folder comes from (the captured one, so MOAG_ONOSOO_KEY still counts). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Run git in `dir`; the trimmed stdout, or null when it fails. */
  git?: (args: string[], dir: string) => string | null;
  /** True when `gh` is installed and signed in. */
  ghReady?: () => boolean;
  /** Pair this machine (prompting for the key); the exit code. */
  pair?: (url?: string) => Promise<number>;
}

function defaultGit(args: string[], dir: string): string | null {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function defaultGhReady(): boolean {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

const KEY_RE = /^[\x21-\x7e]{8,512}$/;

/** True when a device key is saved in onosoo.json or given in the environment. */
export function isPaired(stateDir: string, env: NodeJS.ProcessEnv): boolean {
  if (typeof env.MOAG_ONOSOO_KEY === 'string' && KEY_RE.test(env.MOAG_ONOSOO_KEY)) { return true; }
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(stateDir, 'onosoo.json'), 'utf-8')) as { key?: unknown };
    return typeof doc.key === 'string' && KEY_RE.test(doc.key);
  } catch {
    return false;
  }
}

/** A project id from a folder name: lower case, letters, digits, dots, dashes; never empty. */
export function slugId(folderName: string): string {
  const slug = folderName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/g, '').slice(0, 60);
  return PROJECT_ID_RE.test(slug) ? slug : 'project';
}

const same = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** `moag init`. Returns the exit code: 0 done, 1 could not finish, 2 wrong arguments or not in a repository. */
export async function cmdInit(argv: string[], deps: InitDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string): void => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string): void => { process.stderr.write(s); });
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const homedir = deps.homedir ?? os.homedir;
  const git = deps.git ?? defaultGit;
  const parsed = parseInitArgs(argv);
  if ('error' in parsed) { err(`${parsed.error}\n${INIT_USAGE}`); return 2; }
  const o = parsed.opts;

  // 1. The repository.
  const start = path.resolve(deps.cwd ?? process.cwd(), o.folder ?? '.');
  if (!fs.existsSync(start)) { err(`${start} does not exist.\n${INIT_USAGE}`); return 2; }
  const top = git(['rev-parse', '--show-toplevel'], start);
  if (!top) { err(`${start} is not inside a git repository. Run \`moag init\` in your project's folder.\n`); return 2; }
  let repo: string;
  try { repo = fs.realpathSync(path.resolve(top)); } catch { err(`Could not resolve ${top}.\n`); return 1; }
  if (!fs.existsSync(path.join(repo, '.git'))) { err(`${repo} is not the top level of a git repository (no .git there). Run it in the main checkout.\n`); return 1; }
  const stateDir = path.join(userConfigDir(env, platform, homedir), 'moag');
  const stateReal = fs.existsSync(stateDir) ? fs.realpathSync(stateDir) : path.resolve(stateDir);
  const rel = path.relative(platform === 'win32' ? repo.toLowerCase() : repo, platform === 'win32' ? stateReal.toLowerCase() : stateReal);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    err(`MOAG's config folder (${stateReal}) is inside ${repo}, and a project may not contain it. Run \`moag init\` in a project folder, not your home folder.\n`);
    return 1;
  }

  // 2. Pairing.
  if (isPaired(stateDir, env)) {
    out('Already paired with ONOSOO.\n');
  } else {
    out('This machine is not paired yet. Make a device key in ONOSOO (Builds, Machines, Add machine) and paste it when asked.\n');
    const code = await (deps.pair ?? ((): Promise<number> => Promise.resolve(2)))(o.url);
    if (code !== 0 && !isPaired(stateDir, env)) { err('Not paired, so nothing else was changed. Run `moag init` again when you have a key.\n'); return 1; }
  }

  // 3. The project file.
  const file = path.join(stateDir, PROJECTS_FILE);
  let previous: string | null = null;
  let doc: Record<string, unknown>;
  try {
    previous = fs.readFileSync(file, 'utf-8');
    const parsedDoc: unknown = JSON.parse(previous);
    if (!parsedDoc || typeof parsedDoc !== 'object' || Array.isArray(parsedDoc)) { throw new Error('not an object'); }
    doc = parsedDoc as Record<string, unknown>;
  } catch (e) {
    if (previous !== null) { err(`${file} exists but could not be read (${e instanceof Error ? e.message : String(e)}). Fix or remove it, then run \`moag init\` again; it was not changed.\n`); return 1; }
    doc = { version: 1, mode: 'local', remote_start: true, daily_budget_usd: o.budget ?? 10, projects: [] };
  }
  const projects = Array.isArray(doc.projects) ? [...doc.projects as unknown[]] : [];
  const listed = projects.find((p) => p && typeof p === 'object' && typeof (p as { path?: unknown }).path === 'string'
    && same(path.resolve((p as { path: string }).path), repo, platform)) as { id?: string } | undefined;
  const mode = doc.mode === 'local' ? 'local' : 'isolated';

  if (listed) {
    out(`${repo} is already listed as "${listed.id ?? 'a project'}"; its entry was left as it is.\n`);
  } else {
    const baseId = o.id ?? slugId(path.basename(repo));
    const taken = new Set(projects.map((p) => (p as { id?: unknown })?.id));
    let id = baseId;
    for (let n = 2; taken.has(id); n++) { id = `${baseId.slice(0, 56)}-${n}`; }
    if (o.id && id !== o.id) { err(`The id "${o.id}" is already used by another project in ${PROJECTS_FILE}.\n`); return 1; }

    const hasOrigin = git(['remote', 'get-url', 'origin'], repo) !== null;
    const gh = (deps.ghReady ?? defaultGhReady)();
    let delivery = o.delivery;
    let deliveryWhy = 'as you asked';
    if (!delivery) {
      if (hasOrigin && gh) { delivery = 'draft-pr'; deliveryWhy = 'finished branches are pushed and opened as draft pull requests (gh is signed in)'; }
      else if (hasOrigin) { delivery = 'branch'; deliveryWhy = 'finished branches are pushed; no draft pull request, because `gh` is not signed in (run `gh auth login`, then set "delivery": "draft-pr")'; }
      else { delivery = 'off'; deliveryWhy = 'this repository has no origin remote, so nothing is pushed'; }
    }
    const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo);
    const prBase = o.prBase ?? (head ? head.replace(/^origin\//, '') : undefined);
    const entry: Record<string, unknown> = { id, name: o.name ?? path.basename(repo), path: repo, kinds: [], delivery, ...(prBase ? { pr_base: prBase } : {}) };
    projects.push(entry);
    doc.projects = projects;
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
    } catch (e) {
      err(`Could not write ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    // The file must load cleanly, with this project accepted; otherwise put the old one back.
    const check = loadApprovedProjects(stateDir);
    if (!check.projects.some((p) => p.id === id)) {
      try { if (previous === null) { fs.rmSync(file, { force: true }); } else { writeAtomic(file, previous); } } catch { /* best effort */ }
      err(`MOAG would not accept the project (${check.errors.join(' ') || 'unknown reason'}); ${PROJECTS_FILE} was put back as it was.\n`);
      return 1;
    }
    out(`Added "${entry.name as string}" (${id}) to ${file}.\n  Folder:   ${repo}\n  Delivery: ${delivery}: ${deliveryWhy}\n`);
    if (prBase) { out(`  PR base:  ${prBase}\n`); }
    if (previous === null) {
      out(`  Created ${PROJECTS_FILE} in local mode with remote start on and a $${o.budget ?? 10} daily budget. Runs use your own account's access to your files and tools.\n`);
    }
  }
  if (mode !== 'local') {
    out('Note: this machine uses the isolated mode (a separate runner account), which `moag init` does not set up; its mode was left unchanged. See docs/onosoo-remote.md.\n');
  }

  // 4. What next.
  out('\nNext:\n');
  out(platform === 'win32'
    ? '  1. moag service install     (starts the daemon whenever you sign in; or run `moag daemon` in a terminal)\n'
    : '  1. moag daemon              (leave it running, or run it under systemd or launchd)\n');
  out('  2. In ONOSOO, open Builds, then Machines: this computer should show Online.\n  3. Open the project and press Start run.\n');
  return 0;
}
