// ─── TypeScript / JavaScript path aliases, read for the standards checker ───
//
// `import { db } from '@infra/db'` looks like a published package. In an Nx, Angular or
// NestJS repository it is the project's own code, mapped by `compilerOptions.paths` in a
// tsconfig — quite possibly into another layer. The layering rule can only judge such an
// import when it knows the mapping, and must say "not checked" when a mapping exists that
// it could not read.
//
// Manifests only: nothing is executed, every file is size-capped, symlinks are not
// followed, and no path leaves the workspace. Zero `vscode` imports. Never throws.

import * as fs from 'fs';
import * as path from 'path';
import type { ImportPathScope, PathAlias } from '../standards/checker';

/** Largest config file parsed. */
const MAX_CONFIG_BYTES = 256 * 1024;
/** How many `extends` hops are followed before the chain is given up on. */
const MAX_EXTENDS_DEPTH = 8;
/** Most `paths` entries read from one config. */
const MAX_ALIASES = 500;
/** Most directories probed for a config of their own. */
const MAX_PROBED_DIRS = 2_000;
/** Most project references read from one config. */
const MAX_REFERENCES = 50;

/** The configs read at the repository root. `tsconfig.base.json` is where Nx keeps its `paths`. */
const ROOT_CONFIGS = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'];
/** The configs read in a directory above a changed file. */
const NESTED_CONFIGS = ['tsconfig.json', 'jsconfig.json'];
const JS_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// ─── JSON with comments ───

/**
 * `text` with `//` and block comments removed and trailing commas dropped, so that
 * `JSON.parse` reads what `tsc --init` writes. Strings are stepped over, never edited.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') { j += text[j] === '\\' ? 2 : 1; }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Trailing commas, now that no comment can sit between a comma and its bracket.
  let clean = '';
  for (let k = 0; k < out.length; k++) {
    const ch = out[k];
    if (ch === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') { j += out[j] === '\\' ? 2 : 1; }
      clean += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (ch === ',') {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) { j++; }
      if (out[j] === '}' || out[j] === ']') { continue; }
    }
    clean += ch;
  }
  return clean;
}

/** One config file: undefined when it does not exist, null when it exists and cannot be read. */
function readConfig(file: string): Record<string, unknown> | null | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { return undefined; }
  try {
    // A symlink may point anywhere; it is not followed.
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) { return null; }
    const raw = fs.readFileSync(file, 'utf-8');
    // A byte-order mark is not JSON.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed: unknown = JSON.parse(stripJsonComments(text));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ─── Paths ───

/** Join `spec` onto the repository-relative directory `dir`. Null when it leaves the repository or is absolute. */
function joinInRepo(dir: string, spec: string): string | null {
  const posix = spec.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) { return null; }
  const parts = dir ? dir.split('/') : [];
  for (const seg of posix.split('/')) {
    if (seg === '' || seg === '.') { continue; }
    if (seg === '..') {
      if (parts.length === 0) { return null; }
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function dirOf(rel: string): string {
  const cut = rel.lastIndexOf('/');
  return cut < 0 ? '' : rel.slice(0, cut);
}

/** What one config, with everything it extends, says about module resolution. */
interface ConfigFacts {
  /** `baseUrl` as a repository-relative directory, or null when none is set. */
  baseUrl: string | null;
  /** `paths` as written, or null when none is set. */
  paths: Array<{ pattern: string; targets: string[] }> | null;
  /** The directory of the config that set `paths`: its targets resolve from there when there is no `baseUrl`. */
  pathsDir: string;
  /**
   * The config's OWN project references (`"references": [{ "path": … }]`), as written;
   * null when it declares some this reader cannot make out. Never inherited through
   * `extends` — the compiler does not inherit them either.
   */
  references: string[] | null;
}

/** Where an `extends` entry may live, most likely first. */
function extendsCandidates(dir: string, spec: string): string[] | null {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    const base = joinInRepo(dir, spec);
    if (base === null) { return null; }
    return base.endsWith('.json') ? [base] : [`${base}.json`, base, `${base}/tsconfig.json`];
  }
  if (spec.startsWith('/') || /^[A-Za-z]:/.test(spec) || spec.includes('\\')) { return null; }
  // A package: looked for in each `node_modules` from the config's directory up to the root.
  const out: string[] = [];
  for (let at: string | null = dir; at !== null; at = at === '' ? null : dirOf(at)) {
    const base = `${at ? `${at}/` : ''}node_modules/${spec}`;
    out.push(...(base.endsWith('.json') ? [base] : [base, `${base}.json`, `${base}/tsconfig.json`]));
  }
  return out;
}

/**
 * Read `rel` and everything it extends. Undefined when the file does not exist; null when
 * it — or a config it extends — exists and could not be read, or names a base that was not
 * found. An unread base may declare `paths` of its own, so "not found" is never "none".
 */
function resolveConfig(cwd: string, rel: string, chain: string[]): ConfigFacts | null | undefined {
  const json = readConfig(path.join(cwd, ...rel.split('/')));
  if (json === undefined || json === null) { return json; }
  // Too deep, or a config that extends itself: given up on, not guessed at.
  if (chain.length > MAX_EXTENDS_DEPTH || chain.includes(rel)) { return null; }
  const dir = dirOf(rel);
  const facts: ConfigFacts = { baseUrl: null, paths: null, pathsDir: dir, references: [] };
  const refs = json.references;
  if (refs !== undefined) {
    const read = Array.isArray(refs) && refs.length <= MAX_REFERENCES
      ? refs.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>).path : undefined))
      : null;
    facts.references = read !== null && read.every((p): p is string => typeof p === 'string' && p.length > 0) ? read : null;
  }

  const ext = json.extends;
  const bases = ext === undefined ? [] : typeof ext === 'string' ? [ext] : Array.isArray(ext) && ext.every((e) => typeof e === 'string') ? ext as string[] : null;
  if (bases === null) { return null; }
  for (const spec of bases) {
    const candidates = extendsCandidates(dir, spec);
    if (candidates === null) { return null; }
    let base: ConfigFacts | null | undefined;
    for (const candidate of candidates) {
      // A directory is not a config; keep looking.
      let isFile = false;
      try { isFile = !fs.lstatSync(path.join(cwd, ...candidate.split('/'))).isDirectory(); } catch { isFile = false; }
      if (!isFile) { continue; }
      base = resolveConfig(cwd, candidate, [...chain, rel]);
      break;
    }
    if (base === undefined || base === null) { return null; }
    // A later base overrides an earlier one, as the config itself overrides them all.
    if (base.baseUrl !== null) { facts.baseUrl = base.baseUrl; }
    if (base.paths !== null) { facts.paths = base.paths; facts.pathsDir = base.pathsDir; }
  }

  const options = json.compilerOptions;
  if (options === undefined) { return facts; }
  if (!options || typeof options !== 'object' || Array.isArray(options)) { return null; }
  const { baseUrl, paths } = options as Record<string, unknown>;
  if (baseUrl !== undefined) {
    const resolved = typeof baseUrl === 'string' && !baseUrl.includes('${') ? joinInRepo(dir, baseUrl) : null;
    if (resolved === null) { return null; }
    facts.baseUrl = resolved;
  }
  if (paths !== undefined) {
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) { return null; }
    const entries = Object.entries(paths as Record<string, unknown>);
    if (entries.length > MAX_ALIASES) { return null; }
    const read: Array<{ pattern: string; targets: string[] }> = [];
    for (const [pattern, targets] of entries) {
      if (!Array.isArray(targets) || !targets.every((t) => typeof t === 'string')) { return null; }
      read.push({ pattern, targets: targets as string[] });
    }
    facts.paths = read;
    facts.pathsDir = dir;
  }
  return facts;
}

/** The aliases one resolved config declares, as repository paths. Null when a mapping cannot be expressed. */
function aliasesOf(facts: ConfigFacts): PathAlias[] | null {
  const stars = (text: string): number => text.split('*').length - 1;
  const out: PathAlias[] = [];
  const from = facts.baseUrl ?? facts.pathsDir;
  for (const entry of facts.paths ?? []) {
    if (entry.pattern === '' || stars(entry.pattern) > 1) { return null; }
    const targets: string[] = [];
    for (const target of entry.targets) {
      // `${configDir}` and its kin are resolved by the compiler, not here.
      if (target.includes('${') || stars(target) > 1) { return null; }
      const posix = target.replace(/\\/g, '/');
      if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) { return null; }
      // A target outside the repository is not in any of its layers: nothing to map.
      const resolved = joinInRepo(from, posix);
      if (resolved !== null) { targets.push(resolved); }
    }
    out.push({ pattern: entry.pattern, targets });
  }
  // With a `baseUrl`, any non-relative specifier is looked for under it first.
  if (facts.baseUrl !== null) { out.push({ pattern: '*', targets: [facts.baseUrl === '' ? '*' : `${facts.baseUrl}/*`] }); }
  return out;
}

/**
 * Where a project reference points: the config file itself when the path names one, else
 * `tsconfig.json` in the directory it names. Null when it leaves the repository — a project
 * out there holds none of the changed files, so its aliases apply to nothing here.
 */
function referenceTarget(dir: string, spec: string): string | null {
  const base = joinInRepo(dir, spec);
  if (base === null) { return null; }
  return base.endsWith('.json') ? base : `${base ? `${base}/` : ''}tsconfig.json`;
}

// ─── Public API ───

/**
 * The path aliases that apply to the changed files, one entry per directory that holds a
 * config declaring any: the repository root (`tsconfig.json`, `tsconfig.base.json`,
 * `jsconfig.json`) and every directory above a changed JS/TS file (`tsconfig.json`,
 * `jsconfig.json`). `extends` chains are followed inside the repository and into
 * `node_modules`.
 *
 * Project references are followed ONE level: a "solution" config that only lists
 * `"references": [{ "path": "./tsconfig.app.json" }]` — the shape Vite, Angular and Nx
 * scaffold — keeps its `paths` in the configs it refers to. Each referenced config is read
 * (with everything it extends) and its aliases apply below the directory it sits in. The
 * references of a referenced config are not followed.
 *
 * A scope's `aliases` is null when a config there could not be read, declares `paths` or
 * `references` this reader cannot express, extends a file that was not found, or is a
 * referenced config that does not exist — the checker then reports non-relative imports
 * below it as not checked rather than assume they are packages.
 * A directory with no config, or with configs that declare no alias, yields no entry.
 */
export function readImportPathScopes(cwd: string, changedPaths: string[]): ImportPathScope[] {
  const dirs = new Set<string>(['']);
  for (const file of changedPaths) {
    const posix = file.replace(/\\/g, '/');
    if (!JS_FILE.test(posix)) { continue; }
    for (let dir = dirOf(posix); dir !== '' && dirs.size < MAX_PROBED_DIRS; dir = dirOf(dir)) {
      if (dirs.has(dir)) { break; }
      if (!dir.split('/').includes('node_modules')) { dirs.add(dir); }
    }
  }

  /** What is known per directory so far: the aliases read there, or that some could not be. */
  const byDir = new Map<string, { unknown: boolean; aliases: PathAlias[]; seen: Set<string> }>();
  const note = (dir: string, read: PathAlias[] | null): void => {
    const entry = byDir.get(dir) ?? { unknown: false, aliases: [], seen: new Set<string>() };
    byDir.set(dir, entry);
    if (read === null) { entry.unknown = true; return; }
    for (const alias of read) {
      // The same alias read twice (a config that is both probed and referenced) is one alias.
      const key = JSON.stringify(alias);
      if (!entry.seen.has(key)) { entry.seen.add(key); entry.aliases.push(alias); }
    }
  };
  const resolve = (rel: string, chain: string[]): ConfigFacts | null | undefined => {
    try { return resolveConfig(cwd, rel, chain); } catch { return null; }
  };

  for (const dir of [...dirs].sort()) {
    for (const name of dir === '' ? ROOT_CONFIGS : NESTED_CONFIGS) {
      const rel = dir ? `${dir}/${name}` : name;
      const facts = resolve(rel, []);
      if (facts === undefined) { continue; }
      note(dir, facts === null ? null : aliasesOf(facts));
      if (facts === null) { continue; }
      // References this reader cannot make out may name a config with aliases of its own.
      if (facts.references === null) { note(dir, null); continue; }
      for (const spec of facts.references) {
        const target = referenceTarget(dir, spec);
        if (target === null || target === rel) { continue; }
        const referenced = resolve(target, [rel]);
        // A referenced config that is missing or unreadable may be the one that maps the imports.
        note(dirOf(target), referenced === undefined || referenced === null ? null : aliasesOf(referenced));
      }
    }
  }

  const scopes: ImportPathScope[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const entry = byDir.get(dir)!;
    if (entry.unknown) {
      scopes.push({ dir, aliases: null });
    } else if (entry.aliases.length > 0) {
      scopes.push({ dir, aliases: entry.aliases });
    }
  }
  return scopes;
}
