// ─── Benchmark scenario (pure: fs/path only) ───
//
// A scenario file describes one benchmark: where the repository comes from
// (a template folder turned into a fresh git repo, or a fresh clone of a local
// repository — never the live working tree), which engine plans and runs it,
// the total budget, the bench's own acceptance gates, and the ordered PRD
// versions with the bump the scenario author intends for each.
//
// Every relative path resolves against the scenario file's directory, and
// every file the scenario ships (template, PRDs, dry-run fixtures) must stay
// inside that directory. Parsing never runs anything.

import * as fs from 'fs';
import * as path from 'path';
import { ENGINE_IDS, EngineId, SEMVER_BUMPS, SemverBump } from '../models/types';
import { SERVER_FORBIDDEN_ENGINES } from '../server/prd-ops';
import { STACK_IDS, StackId } from '../server/stacks';

/** The intended bump of a PRD version: the first is always `initial`. */
export type IntendedBump = 'initial' | SemverBump;

export interface ScenarioVersion {
  /** Short label used in the summary (e.g. `v2`). */
  id: string;
  /** Absolute path of the PRD markdown for this version. */
  prdFile: string;
  intendedBump: IntendedBump;
  /** Absolute path of the folder the fake engine copies into the workspace (dry-run only). */
  dryRunFixture?: string;
}

export type ScenarioRepo =
  | { kind: 'template'; templateDir: string }
  | { kind: 'clone'; path: string; ref: string };

export interface Scenario {
  /** Absolute path of the scenario file. */
  file: string;
  /** Absolute path of its directory (every relative path resolves against it). */
  dir: string;
  name: string;
  description: string;
  repo: ScenarioRepo;
  setupCommands: string[];
  stack: StackId;
  engine: EngineId;
  budgetUsd: number;
  perCallCapUsd: number;
  minVersionUsd: number;
  reserveFactor: number;
  versionTimeoutMin: number;
  /** Extra variable names the server passes to agents (`MOAG_RUN_ENV_PASSTHROUGH`). */
  passEnv: string[];
  /** The bench's own acceptance gates, run in the workspace at each ship-gate halt. */
  gateCommands: string[];
  gateTimeoutMs: number;
  /**
   * Extra shell commands a generated plan may carry and still be approved
   * unread, each one reviewed by the scenario author. Exact strings (compared
   * after trimming), never patterns; `gateCommands` are always allowed too.
   */
  allowedCommands: string[];
  /**
   * Commands MOAG's own verify is expected to run (it auto-detects them). The
   * bench runs each once in the untouched workspace, before any plan, so a
   * command the environment cannot run is told apart from a product failure.
   */
  environmentProbes: string[];
  versions: ScenarioVersion[];
  dryRun?: { planCommand: string };
}

/** A scenario field failed validation. `fieldPath` is the JSON path (e.g. `versions[1].intendedBump`). */
export class BenchScenarioError extends Error {
  constructor(public readonly fieldPath: string, message: string) {
    super(`${fieldPath}: ${message}`);
    this.name = 'BenchScenarioError';
  }
}

/** Upper bound for `budgetUsd` (a typo guard: the bench is a measurement, not a project). */
export const MAX_SCENARIO_BUDGET_USD = 100;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Longest command an `allowedCommands` or `environmentProbes` entry may be. */
export const MAX_SCENARIO_COMMAND_CHARS = 500;

// ─── Field readers ───

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function reqString(o: Obj, key: string, at: string, max = 2000): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') { throw new BenchScenarioError(at, 'must be a non-empty string'); }
  if (v.length > max) { throw new BenchScenarioError(at, `must be at most ${max} characters`); }
  return v;
}

function optNumber(o: Obj, key: string, at: string, def: number): number {
  const v = o[key];
  if (v === undefined) { return def; }
  if (typeof v !== 'number' || !Number.isFinite(v)) { throw new BenchScenarioError(at, 'must be a finite number'); }
  return v;
}

function reqNumber(o: Obj, key: string, at: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) { throw new BenchScenarioError(at, 'must be a finite number'); }
  return v;
}

function stringArray(o: Obj, key: string, at: string, opts: { min?: number } = {}): string[] {
  const v = o[key] ?? [];
  if (!Array.isArray(v)) { throw new BenchScenarioError(at, 'must be an array of strings'); }
  const out = v.map((x, i) => {
    if (typeof x !== 'string' || x.trim() === '') { throw new BenchScenarioError(`${at}[${i}]`, 'must be a non-empty string'); }
    return x;
  });
  if (out.length < (opts.min ?? 0)) { throw new BenchScenarioError(at, `needs at least ${opts.min} entr${opts.min === 1 ? 'y' : 'ies'}`); }
  return out;
}

/**
 * A list of exact shell commands (`allowedCommands`, `environmentProbes`):
 * each a single line of at most {@link MAX_SCENARIO_COMMAND_CHARS} characters,
 * with no entry listed twice. Entries are literal strings, never patterns.
 */
function commandList(o: Obj, key: string, at: string): string[] {
  const out = stringArray(o, key, at);
  const seen = new Set<string>();
  out.forEach((c, i) => {
    if (/[\r\n]/.test(c)) { throw new BenchScenarioError(`${at}[${i}]`, 'must be a single-line command'); }
    if (c.length > MAX_SCENARIO_COMMAND_CHARS) { throw new BenchScenarioError(`${at}[${i}]`, `must be at most ${MAX_SCENARIO_COMMAND_CHARS} characters`); }
    if (seen.has(c.trim())) { throw new BenchScenarioError(`${at}[${i}]`, `duplicate command "${c.trim()}"`); }
    seen.add(c.trim());
  });
  return out;
}

/** True when `child` is `parent` or lies inside it (case-insensitive on Windows). */
export function isInsideOrSame(parent: string, child: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve `rel` against the scenario dir; it must stay inside it. */
function insideScenario(dir: string, rel: string, at: string): string {
  const abs = path.resolve(dir, rel);
  if (!isInsideOrSame(dir, abs) || path.resolve(abs) === path.resolve(dir)) {
    throw new BenchScenarioError(at, 'must be a path inside the scenario directory');
  }
  return abs;
}

// ─── Parse ───

/**
 * Read and validate a scenario file. Throws {@link BenchScenarioError} naming
 * the first invalid field, or a plain Error when the file is unreadable.
 */
export function parseScenario(file: string): Scenario {
  const abs = path.resolve(file);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch (err) {
    throw new BenchScenarioError('(file)', `cannot read scenario JSON: ${(err as Error).message}`);
  }
  return validateScenario(raw, abs);
}

/** Validate an already-parsed scenario document that lives at `file`. */
export function validateScenario(raw: unknown, file: string): Scenario {
  if (!isObj(raw)) { throw new BenchScenarioError('(root)', 'must be a JSON object'); }
  const dir = path.dirname(path.resolve(file));

  const name = reqString(raw, 'name', 'name', 80);
  const description = typeof raw.description === 'string' ? raw.description : '';

  // repo
  const repoRaw = raw.repo;
  if (!isObj(repoRaw)) { throw new BenchScenarioError('repo', 'must be an object'); }
  let repo: ScenarioRepo;
  if (repoRaw.kind === 'template') {
    const templateDir = insideScenario(dir, reqString(repoRaw, 'templateDir', 'repo.templateDir'), 'repo.templateDir');
    if (!isDir(templateDir)) { throw new BenchScenarioError('repo.templateDir', 'must be an existing directory'); }
    repo = { kind: 'template', templateDir };
  } else if (repoRaw.kind === 'clone') {
    const src = path.resolve(dir, reqString(repoRaw, 'path', 'repo.path'));
    if (!isDir(src)) { throw new BenchScenarioError('repo.path', 'must be an existing directory'); }
    const ref = reqString(repoRaw, 'ref', 'repo.ref', 200);
    if (ref.startsWith('-') || /\s/.test(ref)) { throw new BenchScenarioError('repo.ref', 'must be a branch or tag name'); }
    repo = { kind: 'clone', path: src, ref };
  } else {
    throw new BenchScenarioError('repo.kind', "must be 'template' or 'clone'");
  }

  const setupCommands = stringArray(raw, 'setupCommands', 'setupCommands');

  const stack = raw.stack;
  if (typeof stack !== 'string' || !(STACK_IDS as readonly string[]).includes(stack)) {
    throw new BenchScenarioError('stack', `must be one of ${STACK_IDS.join(', ')}`);
  }
  const engine = raw.engine;
  if (typeof engine !== 'string' || !(ENGINE_IDS as readonly string[]).includes(engine)) {
    throw new BenchScenarioError('engine', `must be one of ${ENGINE_IDS.join(', ')}`);
  }
  if (SERVER_FORBIDDEN_ENGINES.includes(engine as EngineId)) {
    throw new BenchScenarioError('engine', `${engine} is not supported by the hosted server`);
  }

  const budgetUsd = reqNumber(raw, 'budgetUsd', 'budgetUsd');
  if (!(budgetUsd > 0 && budgetUsd <= MAX_SCENARIO_BUDGET_USD)) {
    throw new BenchScenarioError('budgetUsd', `must be greater than 0 and at most ${MAX_SCENARIO_BUDGET_USD}`);
  }
  const perCallCapUsd = reqNumber(raw, 'perCallCapUsd', 'perCallCapUsd');
  if (!(perCallCapUsd > 0 && perCallCapUsd <= budgetUsd)) {
    throw new BenchScenarioError('perCallCapUsd', 'must be greater than 0 and at most budgetUsd');
  }
  const minVersionUsd = optNumber(raw, 'minVersionUsd', 'minVersionUsd', 1);
  if (!(minVersionUsd > 0 && minVersionUsd <= budgetUsd)) {
    throw new BenchScenarioError('minVersionUsd', 'must be greater than 0 and at most budgetUsd');
  }
  const reserveFactor = optNumber(raw, 'reserveFactor', 'reserveFactor', 1.5);
  if (!(reserveFactor >= 1 && reserveFactor <= 10)) { throw new BenchScenarioError('reserveFactor', 'must be between 1 and 10'); }
  const versionTimeoutMin = optNumber(raw, 'versionTimeoutMin', 'versionTimeoutMin', 60);
  if (!(versionTimeoutMin > 0 && versionTimeoutMin <= 24 * 60)) {
    throw new BenchScenarioError('versionTimeoutMin', 'must be greater than 0 and at most 1440');
  }

  const passEnv = stringArray(raw, 'passEnv', 'passEnv');
  passEnv.forEach((n, i) => {
    const at = `passEnv[${i}]`;
    if (!ENV_NAME_RE.test(n)) { throw new BenchScenarioError(at, 'is not a valid variable name'); }
    if (n.toUpperCase() === 'CI') { throw new BenchScenarioError(at, 'CI can never be passed to runs (it auto-approves ship gates)'); }
    if (n.toUpperCase().startsWith('MOAG_')) { throw new BenchScenarioError(at, 'MOAG_* variables can never be passed to runs'); }
  });

  const gateCommands = stringArray(raw, 'gateCommands', 'gateCommands', { min: 1 });
  const gateTimeoutMs = optNumber(raw, 'gateTimeoutMs', 'gateTimeoutMs', 600_000);
  if (!(gateTimeoutMs >= 1_000 && gateTimeoutMs <= 3_600_000)) {
    throw new BenchScenarioError('gateTimeoutMs', 'must be between 1000 and 3600000');
  }

  const allowedCommands = commandList(raw, 'allowedCommands', 'allowedCommands');
  const environmentProbes = commandList(raw, 'environmentProbes', 'environmentProbes');

  // versions
  if (!Array.isArray(raw.versions) || raw.versions.length === 0) {
    throw new BenchScenarioError('versions', 'must be a non-empty array');
  }
  const seenIds = new Set<string>();
  const versions: ScenarioVersion[] = raw.versions.map((v, i) => {
    const at = `versions[${i}]`;
    if (!isObj(v)) { throw new BenchScenarioError(at, 'must be an object'); }
    const id = reqString(v, 'id', `${at}.id`, 32);
    if (!VERSION_ID_RE.test(id)) { throw new BenchScenarioError(`${at}.id`, 'must be 1-32 letters, digits, dots, dashes or underscores'); }
    if (seenIds.has(id)) { throw new BenchScenarioError(`${at}.id`, `duplicate id "${id}"`); }
    seenIds.add(id);
    const prdFile = insideScenario(dir, reqString(v, 'prdFile', `${at}.prdFile`), `${at}.prdFile`);
    if (!isFile(prdFile)) { throw new BenchScenarioError(`${at}.prdFile`, 'must be an existing file'); }
    const bump = v.intendedBump;
    let intendedBump: IntendedBump;
    if (i === 0) {
      if (bump !== 'initial') { throw new BenchScenarioError(`${at}.intendedBump`, "the first version's bump must be 'initial'"); }
      intendedBump = 'initial';
    } else {
      if (typeof bump !== 'string' || !(SEMVER_BUMPS as readonly string[]).includes(bump)) {
        throw new BenchScenarioError(`${at}.intendedBump`, `must be one of ${SEMVER_BUMPS.join(', ')} (only the first version is 'initial')`);
      }
      intendedBump = bump as SemverBump;
    }
    let dryRunFixture: string | undefined;
    if (v.dryRunFixture !== undefined) {
      dryRunFixture = insideScenario(dir, reqString(v, 'dryRunFixture', `${at}.dryRunFixture`), `${at}.dryRunFixture`);
      if (!isDir(dryRunFixture)) { throw new BenchScenarioError(`${at}.dryRunFixture`, 'must be an existing directory'); }
    }
    return { id, prdFile, intendedBump, ...(dryRunFixture ? { dryRunFixture } : {}) };
  });

  let dryRun: Scenario['dryRun'];
  if (raw.dryRun !== undefined) {
    if (!isObj(raw.dryRun)) { throw new BenchScenarioError('dryRun', 'must be an object'); }
    dryRun = { planCommand: reqString(raw.dryRun, 'planCommand', 'dryRun.planCommand', 500) };
  }

  return {
    file: path.resolve(file), dir, name, description, repo, setupCommands,
    stack: stack as StackId, engine: engine as EngineId,
    budgetUsd, perCallCapUsd, minVersionUsd, reserveFactor, versionTimeoutMin,
    passEnv, gateCommands, gateTimeoutMs, allowedCommands, environmentProbes, versions,
    ...(dryRun ? { dryRun } : {}),
  };
}

/**
 * Why `scenario` cannot run in dry-run mode, or null when it can: every
 * version needs a fixture and the fake planner needs a test command.
 */
export function dryRunProblem(scenario: Scenario): string | null {
  if (!scenario.dryRun) { return 'the scenario has no "dryRun" section (dryRun.planCommand)'; }
  const missing = scenario.versions.filter((v) => !v.dryRunFixture).map((v) => v.id);
  if (missing.length > 0) { return `versions without a dryRunFixture: ${missing.join(', ')}`; }
  if (scenario.engine !== 'claude') { return 'dry-run fakes only the claude engine'; }
  return null;
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
