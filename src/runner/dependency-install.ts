// ─── Automatic dependency installs ───
//
// Decides, deterministically, whether a project's dependencies must be installed
// before a step that needs them (a command task, a verify gate, a standards
// command, a benchmark acceptance gate) — and runs the install from a FIXED table.
//
// Nothing here is model-authored and nothing comes from the repository: the
// command strings live in INSTALL_TABLE below. The only repository input is
// WHICH manifests and lockfiles exist, and their content hashes.
//
// No `vscode` import and no configuration reads: every surface (VS Code runner,
// headless CLI, server worker, PRD loop, standards check, bench harness) passes
// its settings in, in the same dependency-injected style as `prd-loop.ts`.
//
// Lives in `runner/` beside `evidence.ts` (not `utils/`) because it spawns
// processes through `evidence.runGate`.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ConfigSection } from '../core/host';
import type {
  DependencyEcosystem, DependencyEvent, DependencyEventName, DependencyStage, DependencyTrigger,
} from '../models/types';
import { commandExists as defaultCommandExists } from '../utils/command-exists';
import { writeFileAtomicSync } from '../utils/file-io';
import { readWorkspacePackages, runGate } from './evidence';
import type { GateOptions, GateResult } from './evidence';

// ─── Table ───

/** One row of the fixed install table. */
export interface InstallTableEntry {
  ecosystem: DependencyEcosystem;
  /** Executable that must be on PATH; null when the command names its own interpreter. */
  tool: string | null;
  /** Command used when a lockfile pins the tree (or the only command, for non-JS rows). */
  frozen: string | null;
  /** Command used with no lockfile, or to refresh a lockfile left behind by a manifest edit. */
  refresh: string | null;
  /** What `ignoreScripts` appends; null when the row runs no lifecycle scripts. */
  ignoreScriptsFlag: string | null;
  /** Why the row installs nothing (build-tool ecosystems). */
  note: string | null;
}

/** Install-table row ids — `yarn` splits into classic (v1) and berry (v2+). */
export type InstallRow =
  | 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry' | 'python' | 'go' | 'dotnet' | 'maven' | 'gradle' | 'cargo';

const BUILD_RESOLVES_NOTE = 'dependencies are resolved by the build command';

/**
 * The only commands MOAG ever runs to install dependencies. Frozen; never extended
 * from the repository, a plan, or a model. Python's command is prefixed with the
 * virtualenv interpreter found at plan time.
 */
export const INSTALL_TABLE: Readonly<Record<InstallRow, Readonly<InstallTableEntry>>> = Object.freeze({
  npm: Object.freeze({
    ecosystem: 'npm', tool: 'npm', frozen: 'npm ci --no-audit --no-fund', refresh: 'npm install --no-audit --no-fund',
    ignoreScriptsFlag: '--ignore-scripts', note: null,
  }),
  pnpm: Object.freeze({
    ecosystem: 'pnpm', tool: 'pnpm', frozen: 'pnpm install --frozen-lockfile', refresh: 'pnpm install --no-frozen-lockfile',
    ignoreScriptsFlag: '--ignore-scripts', note: null,
  }),
  'yarn-classic': Object.freeze({
    ecosystem: 'yarn', tool: 'yarn', frozen: 'yarn install --frozen-lockfile', refresh: 'yarn install',
    ignoreScriptsFlag: '--ignore-scripts', note: null,
  }),
  'yarn-berry': Object.freeze({
    ecosystem: 'yarn', tool: 'yarn', frozen: 'yarn install --immutable', refresh: 'yarn install',
    ignoreScriptsFlag: '--mode=skip-build', note: null,
  }),
  python: Object.freeze({
    ecosystem: 'python', tool: null, frozen: '-m pip install -r requirements.txt', refresh: null,
    ignoreScriptsFlag: null, note: null,
  }),
  go: Object.freeze({
    ecosystem: 'go', tool: 'go', frozen: 'go mod download', refresh: null, ignoreScriptsFlag: null, note: null,
  }),
  dotnet: Object.freeze({
    ecosystem: 'dotnet', tool: 'dotnet', frozen: 'dotnet restore', refresh: null, ignoreScriptsFlag: null, note: null,
  }),
  maven: Object.freeze({
    ecosystem: 'maven', tool: null, frozen: null, refresh: null, ignoreScriptsFlag: null, note: BUILD_RESOLVES_NOTE,
  }),
  gradle: Object.freeze({
    ecosystem: 'gradle', tool: null, frozen: null, refresh: null, ignoreScriptsFlag: null, note: BUILD_RESOLVES_NOTE,
  }),
  cargo: Object.freeze({
    ecosystem: 'cargo', tool: null, frozen: null, refresh: null, ignoreScriptsFlag: null, note: BUILD_RESOLVES_NOTE,
  }),
});

/** Prefix of the stderr line a step gets when the install it needed failed. */
export const DEPENDENCY_INSTALL_FAILED_MARKER = '[Dependencies] Install failed';

/** The record file, relative to the working directory. */
export const DEPENDENCY_STAMP_FILE = path.join('.moag', 'dependencies.json');

const TAIL_CHARS = 2000;
const NO_VENV_NOTE = 'not installed: no virtualenv';
const PYPROJECT_NOTE = 'pyproject.toml has no supported install command (requirements.txt only)';
const VENV_PATTERN = /^[A-Za-z0-9._/\\-]+$/;

/** package.json fields whose change means the dependency tree changed (A5). */
const PACKAGE_DEP_FIELDS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'overrides', 'resolutions', 'workspaces', 'packageManager', 'pnpm',
] as const;

/** Fields that make `node_modules` necessary. */
const INSTALLING_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

const NODE_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'] as const;

// ─── Settings ───

/** What a surface passes in; read from its own configuration. */
export interface DependencyInstallSettings {
  enabled: boolean;
  ignoreScripts: boolean;
  /** Configured virtualenv directory, relative to the workspace; null = auto-detect `.venv`, `venv`. */
  pythonVenv: string | null;
}

/**
 * Read the dependency-install settings from an `agentTaskPlayer` configuration section:
 * `autoInstallDependencies` (default true), `dependencyInstall.ignoreScripts` (default
 * false), `dependencyInstall.pythonVenv` (default '').
 */
export function readDependencyInstallSettings(cfg: ConfigSection): DependencyInstallSettings {
  const venv = cfg.get<unknown>('dependencyInstall.pythonVenv', '');
  return {
    enabled: cfg.get<unknown>('autoInstallDependencies', true) !== false,
    ignoreScripts: cfg.get<unknown>('dependencyInstall.ignoreScripts', false) === true,
    pythonVenv: typeof venv === 'string' && venv.trim().length > 0 ? venv.trim() : null,
  };
}

// ─── Record file ───

/** Install families — one record entry per family and directory. */
export type DependencyFamily = 'node' | 'python' | 'go' | 'dotnet' | 'jvm' | 'cargo';

/** One record entry in `.moag/dependencies.json`. */
export interface DependencyStampEntry {
  ecosystem: DependencyEcosystem;
  dir: string;
  status: 'installed' | 'adopted' | 'not-installed';
  hash: string;
  files: Record<string, string>;
  command: string | null;
  note: string | null;
  at: string;
}

/** The whole record file. */
export interface DependencyStamp {
  version: 1;
  entries: Record<string, DependencyStampEntry>;
}

const ECOSYSTEM_SET = new Set<string>(['npm', 'pnpm', 'yarn', 'python', 'go', 'dotnet', 'maven', 'gradle', 'cargo']);
const STATUS_SET = new Set<string>(['installed', 'adopted', 'not-installed']);

function emptyStamp(): DependencyStamp {
  return { version: 1, entries: {} };
}

function isStampEntry(value: unknown): value is DependencyStampEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const e = value as Record<string, unknown>;
  if (typeof e.ecosystem !== 'string' || !ECOSYSTEM_SET.has(e.ecosystem)) { return false; }
  if (typeof e.dir !== 'string' || typeof e.hash !== 'string') { return false; }
  if (typeof e.status !== 'string' || !STATUS_SET.has(e.status)) { return false; }
  if (!e.files || typeof e.files !== 'object' || Array.isArray(e.files)) { return false; }
  if (!Object.values(e.files as Record<string, unknown>).every((v) => typeof v === 'string')) { return false; }
  return true;
}

/**
 * Read `.moag/dependencies.json`. A missing, unreadable or malformed file reads as
 * empty, and so does any entry that does not have the expected shape. Never throws.
 */
export function readDependencyStamp(cwd: string): DependencyStamp {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(cwd, DEPENDENCY_STAMP_FILE), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
      return emptyStamp();
    }
    const raw = (parsed as { entries?: unknown }).entries;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return emptyStamp(); }
    const stamp = emptyStamp();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isStampEntry(value)) {
        stamp.entries[key] = {
          ...value,
          command: typeof value.command === 'string' ? value.command : null,
          note: typeof value.note === 'string' ? value.note : null,
          at: typeof value.at === 'string' ? value.at : '',
        };
      }
    }
    return stamp;
  } catch {
    return emptyStamp();
  }
}

/** Write `.moag/dependencies.json` atomically. Returns false (never throws) when it cannot. */
export function writeDependencyStamp(cwd: string, stamp: DependencyStamp): boolean {
  try {
    writeFileAtomicSync(path.join(cwd, DEPENDENCY_STAMP_FILE), JSON.stringify(stamp, null, 2) + '\n', 0o644);
    return true;
  } catch {
    return false;
  }
}

// ─── Hashing ───

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function readBytes(file: string): Buffer | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

function exists(file: string): boolean {
  try { fs.statSync(file); return true; } catch { return false; }
}

function isDir(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/** JSON with object keys sorted, so a reordered manifest hashes the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) { return '[' + value.map(stableStringify).join(',') + ']'; }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** Content hash with CRLF normalised, so a checkout's line endings never trigger an install. */
function textHash(bytes: Buffer): string {
  return sha256(bytes.toString('utf-8').replace(/\r\n/g, '\n'));
}

interface ParsedPackage {
  hash: string;
  manifest: Record<string, unknown> | null;
}

/** Hash only the dependency fields of a package.json; the raw bytes when it does not parse (A5). */
function hashPackageJson(bytes: Buffer): ParsedPackage {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const manifest = parsed as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const field of PACKAGE_DEP_FIELDS) {
        if (manifest[field] !== undefined) { picked[field] = manifest[field]; }
      }
      return { hash: sha256(stableStringify(picked)), manifest };
    }
  } catch {
    // fall through to raw bytes
  }
  return { hash: sha256(bytes), manifest: null };
}

/** The combined hash: sha256 over sorted `path\0filehash\n` lines. */
function combinedHash(files: Record<string, string>): string {
  return sha256(Object.keys(files).sort().map((f) => `${f}\0${files[f]}\n`).join(''));
}

// ─── Planning ───

/** What to do for one family. */
export type PlannedAction =
  /** `fallback`: the refresh command to retry with once if `command` fails (pnpm/yarn, first sight). */
  | { kind: 'run'; command: string; fallback?: string }
  | { kind: 'adopt' }
  | { kind: 'note'; note: string }
  | { kind: 'none' };

/** One family's decision, as computed by {@link planDependencyInstalls}. */
export interface PlannedInstall {
  key: string;
  ecosystem: DependencyEcosystem;
  dir: string;
  files: Record<string, string>;
  hash: string;
  trigger: DependencyTrigger;
  action: PlannedAction;
}

/** The host facts planning depends on; injected so planning stays pure and synchronous. */
export interface PlanEnvironment {
  platform: NodeJS.Platform;
  commandExists: (cmd: string) => boolean;
}

/** What a detector found, before the record is consulted. */
interface Detected {
  family: DependencyFamily;
  ecosystem: DependencyEcosystem;
  files: Record<string, string>;
  /** Directory whose absence means "not installed"; null when the ecosystem has none. */
  installDir: string | null;
  /**
   * Files, any one of which means "installed", used instead of `installDir` when the
   * install writes no directory — Yarn Plug'n'Play writes `.pnp.cjs`, never `node_modules`.
   */
  installMarkers?: readonly string[];
  /**
   * Node only: every declared package has `node_modules/<name>/package.json`. A present
   * but incomplete `node_modules` (a partial install, a tool's `.cache`) is never adopted.
   * Undefined for ecosystems where the install directory's existence is the whole check.
   */
  complete?: boolean;
  /** The command to run, or the note to record. */
  desired: {
    kind: 'run'; frozen: string; refresh: string | null; lockfile: string | null;
    /**
     * Whether the lockfile pins exactly what the manifests declare: true / false when it
     * could be checked (npm), null when it could not (pnpm, yarn — those retry once with
     * the refresh command when the frozen one fails on first sight).
     */
    lockInSync: boolean | null;
  } | { kind: 'note'; note: string };
}

function withFlag(command: string, flag: string | null, ignoreScripts: boolean): string {
  return ignoreScripts && flag ? `${command} ${flag}` : command;
}

function declaresInstalls(manifest: Record<string, unknown> | null): boolean {
  if (!manifest) { return false; }
  return INSTALLING_FIELDS.some((field) => {
    const value = manifest[field];
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  });
}

/** A manifest that was hashed, with the directory it lives in ('.' or a relative path). */
interface NodeManifest {
  dir: string;
  manifest: Record<string, unknown> | null;
}

/** The `name → spec` map of one installing field, or {} when absent or malformed. */
function depMap(manifest: Record<string, unknown> | null | undefined, field: string): Record<string, string> {
  const value = manifest?.[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    out[name] = typeof spec === 'string' ? spec : JSON.stringify(spec);
  }
  return out;
}

/**
 * True when every package declared in `dependencies`, `devDependencies` or
 * `optionalDependencies` of every hashed manifest has `node_modules/<name>/package.json`
 * — in the workspace root, or in the workspace package's own `node_modules`.
 */
function declaredPackagesPresent(cwd: string, manifests: NodeManifest[]): boolean {
  for (const { dir, manifest } of manifests) {
    for (const field of INSTALLING_FIELDS) {
      for (const name of Object.keys(depMap(manifest, field))) {
        const segments = name.split('/');
        const roots = dir === '.' ? [cwd] : [cwd, path.join(cwd, dir)];
        if (!roots.some((r) => exists(path.join(r, 'node_modules', ...segments, 'package.json')))) { return false; }
      }
    }
  }
  return true;
}

/**
 * Yarn Plug'n'Play: is there a `.pnp.cjs`/`.pnp.js`, and does it name every package the
 * manifests declare? The PnP map lists each package as a quoted name, so a dependency a
 * task just added — and that no install has resolved — is missing from it. Without this,
 * an old `.pnp.cjs` would count as installed and a command needing the new package fails.
 */
function declaredPackagesInPnp(cwd: string, manifests: NodeManifest[]): boolean {
  let map = '';
  for (const m of PNP_MARKERS) {
    try { map = fs.readFileSync(path.join(cwd, m), 'utf-8'); break; } catch { /* try the next marker */ }
  }
  if (!map) { return false; }
  for (const { manifest } of manifests) {
    for (const field of INSTALLING_FIELDS) {
      for (const name of Object.keys(depMap(manifest, field))) {
        if (!map.includes(JSON.stringify(name))) { return false; }
      }
    }
  }
  return true;
}

/**
 * npm only: does `package-lock.json` / `npm-shrinkwrap.json` (lockfileVersion 2 or 3)
 * record, for the root and each listed workspace package, exactly the `name → spec`
 * maps the manifests declare? False on any mismatch, or when the lockfile does not parse
 * or has no `packages` section — `npm ci` would refuse it ("not in sync").
 */
function npmLockInSync(lockBytes: Buffer, manifests: NodeManifest[]): boolean {
  let lock: unknown;
  try { lock = JSON.parse(lockBytes.toString('utf-8')); } catch { return false; }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) { return false; }
  const { lockfileVersion, packages } = lock as { lockfileVersion?: unknown; packages?: unknown };
  if ((lockfileVersion !== 2 && lockfileVersion !== 3) || !packages || typeof packages !== 'object' || Array.isArray(packages)) {
    return false;
  }
  for (const { dir, manifest } of manifests) {
    if (!manifest) { return false; }
    const entry = (packages as Record<string, unknown>)[dir === '.' ? '' : dir];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return false; }
    for (const field of INSTALLING_FIELDS) {
      const want = depMap(manifest, field);
      const have = depMap(entry as Record<string, unknown>, field);
      const names = Object.keys(want);
      if (names.length !== Object.keys(have).length) { return false; }
      if (names.some((n) => have[n] !== want[n])) { return false; }
    }
  }
  return true;
}

/** What a Yarn Plug'n'Play install writes in place of `node_modules` (`.pnp.js` is Yarn 2.0). */
const PNP_MARKERS = Object.freeze(['.pnp.cjs', '.pnp.js']);

/**
 * Yarn Berry: true unless `.yarnrc.yml` sets a top-level `nodeLinker` other than `pnp`
 * (`node-modules`, `pnpm`). An absent file or key means Plug'n'Play, Yarn 2+'s default.
 */
function yarnUsesPnp(cwd: string): boolean {
  const rc = readBytes(path.join(cwd, '.yarnrc.yml'));
  if (!rc) { return true; }
  const match = /^nodeLinker:[ \t]*["']?([A-Za-z-]+)["']?[ \t]*(?:#.*)?$/m.exec(rc.toString('utf-8').replace(/\r\n/g, '\n'));
  return !match || match[1] === 'pnp';
}

function detectNode(cwd: string, settings: DependencyInstallSettings, env: PlanEnvironment): Detected | null {
  const rootBytes = readBytes(path.join(cwd, 'package.json'));
  if (!rootBytes) { return null; }
  const files: Record<string, string> = {};
  const root = hashPackageJson(rootBytes);
  files['package.json'] = root.hash;
  const manifests: NodeManifest[] = [{ dir: '.', manifest: root.manifest }];
  let installs = declaresInstalls(root.manifest);

  // A3: the workspace packages the repository itself lists — never a blind scan.
  let workspaces: { dir: string }[] | null = null;
  try { workspaces = readWorkspacePackages(cwd); } catch { workspaces = null; }
  for (const pkg of workspaces ?? []) {
    const rel = `${pkg.dir.replace(/\\/g, '/')}/package.json`;
    const bytes = readBytes(path.join(cwd, rel));
    if (!bytes) { continue; }
    const parsed = hashPackageJson(bytes);
    files[rel] = parsed.hash;
    manifests.push({ dir: pkg.dir.replace(/\\/g, '/'), manifest: parsed.manifest });
    installs = installs || declaresInstalls(parsed.manifest);
  }
  if (!installs) { return null; }

  const lockBytes: Record<string, Buffer> = {};
  for (const extra of ['pnpm-workspace.yaml', ...NODE_LOCKFILES]) {
    const bytes = readBytes(path.join(cwd, extra));
    if (bytes) { files[extra] = textHash(bytes); lockBytes[extra] = bytes; }
  }
  const lockfile = NODE_LOCKFILES.find((f) => files[f] !== undefined) ?? null;
  const packageManager = typeof root.manifest?.packageManager === 'string' ? root.manifest.packageManager : '';
  let row: InstallRow;
  if (lockfile === 'pnpm-lock.yaml') {
    row = 'pnpm';
  } else if (lockfile === 'yarn.lock') {
    row = 'yarn-classic';
  } else if (lockfile) {
    row = 'npm';
  } else if (/^pnpm@/.test(packageManager)) {
    row = 'pnpm';
  } else if (/^yarn@/.test(packageManager)) {
    row = 'yarn-classic';
  } else {
    row = 'npm';
  }
  if (row === 'yarn-classic') {
    const major = /^yarn@(\d+)/.exec(packageManager);
    if (exists(path.join(cwd, '.yarnrc.yml')) || (major && Number(major[1]) >= 2)) { row = 'yarn-berry'; }
  }
  // Yarn Berry's default linker is Plug'n'Play: the install writes `.pnp.cjs` and never a
  // `node_modules`, so that file — not the directory — is what "installed" looks like.
  const pnp = row === 'yarn-berry' && yarnUsesPnp(cwd);
  const output = pnp
    ? { installDir: null, installMarkers: PNP_MARKERS, complete: declaredPackagesInPnp(cwd, manifests) }
    : {
      installDir: 'node_modules',
      complete: isDir(path.join(cwd, 'node_modules')) && declaredPackagesPresent(cwd, manifests),
    };
  const entry = INSTALL_TABLE[row];
  if (entry.tool && !env.commandExists(entry.tool)) {
    return {
      family: 'node', ecosystem: entry.ecosystem, files, ...output,
      desired: { kind: 'note', note: `not installed: ${entry.tool} is not on PATH` },
    };
  }
  const lockInSync = row === 'npm' && lockfile ? npmLockInSync(lockBytes[lockfile], manifests) : null;
  return {
    family: 'node', ecosystem: entry.ecosystem, files, ...output,
    desired: {
      kind: 'run',
      frozen: withFlag(entry.frozen as string, entry.ignoreScriptsFlag, settings.ignoreScripts),
      refresh: withFlag(entry.refresh as string, entry.ignoreScriptsFlag, settings.ignoreScripts),
      lockfile,
      lockInSync,
    },
  };
}

/** The virtualenv interpreter relative to `cwd`, or null. Never the system interpreter. */
function findVenvPython(cwd: string, settings: DependencyInstallSettings, platform: NodeJS.Platform): string | null {
  const candidates: string[] = [];
  const configured = settings.pythonVenv;
  if (configured
    && VENV_PATTERN.test(configured)
    && !path.isAbsolute(configured)
    && !/^[A-Za-z]:/.test(configured)
    && !configured.split(/[/\\]/).includes('..')) {
    candidates.push(configured.replace(/[/\\]+$/, ''));
  }
  candidates.push('.venv', 'venv');
  for (const venv of candidates) {
    const parts = venv.split(/[/\\]+/).filter((p) => p.length > 0);
    const interpreter = platform === 'win32'
      ? [...parts, 'Scripts', 'python.exe']
      : [...parts, 'bin', 'python'];
    if (exists(path.join(cwd, ...interpreter))) {
      return interpreter.join(platform === 'win32' ? '\\' : '/');
    }
  }
  return null;
}

function detectPython(cwd: string, settings: DependencyInstallSettings, env: PlanEnvironment): Detected | null {
  const requirements = readBytes(path.join(cwd, 'requirements.txt'));
  if (!requirements) {
    const pyproject = readBytes(path.join(cwd, 'pyproject.toml'));
    if (!pyproject) { return null; }
    return {
      family: 'python', ecosystem: 'python', files: { 'pyproject.toml': textHash(pyproject) }, installDir: null,
      desired: { kind: 'note', note: PYPROJECT_NOTE },
    };
  }
  const files = { 'requirements.txt': textHash(requirements) };
  const python = findVenvPython(cwd, settings, env.platform);
  if (!python) {
    return { family: 'python', ecosystem: 'python', files, installDir: null, desired: { kind: 'note', note: NO_VENV_NOTE } };
  }
  return {
    family: 'python', ecosystem: 'python', files, installDir: null,
    desired: { kind: 'run', frozen: `${python} ${INSTALL_TABLE.python.frozen}`, refresh: null, lockfile: null, lockInSync: null },
  };
}

function hashFiles(cwd: string, names: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of names) {
    const bytes = readBytes(path.join(cwd, name));
    if (bytes) { files[name] = textHash(bytes); }
  }
  return files;
}

function toolRow(row: InstallRow, family: DependencyFamily, files: Record<string, string>, installDir: string | null,
  env: PlanEnvironment): Detected {
  const entry = INSTALL_TABLE[row];
  if (entry.tool && !env.commandExists(entry.tool)) {
    return { family, ecosystem: entry.ecosystem, files, installDir,
      desired: { kind: 'note', note: `not installed: ${entry.tool} is not on PATH` } };
  }
  return { family, ecosystem: entry.ecosystem, files, installDir,
    desired: { kind: 'run', frozen: entry.frozen as string, refresh: null, lockfile: null, lockInSync: null } };
}

function detectGo(cwd: string, env: PlanEnvironment): Detected | null {
  const files = hashFiles(cwd, ['go.mod', 'go.sum']);
  return files['go.mod'] ? toolRow('go', 'go', files, null, env) : null;
}

function detectDotnet(cwd: string, env: PlanEnvironment): Detected | null {
  let names: string[];
  try { names = fs.readdirSync(cwd); } catch { return null; }
  const projects = names.filter((n) => /\.(sln|csproj|fsproj|vbproj)$/i.test(n)).sort();
  if (projects.length === 0) { return null; }
  const files = hashFiles(cwd, [...projects, 'packages.lock.json', 'Directory.Packages.props']);
  return toolRow('dotnet', 'dotnet', files, 'obj', env);
}

function detectJvm(cwd: string): Detected | null {
  const maven = hashFiles(cwd, ['pom.xml']);
  if (maven['pom.xml']) {
    return { family: 'jvm', ecosystem: 'maven', files: maven, installDir: null, desired: { kind: 'note', note: BUILD_RESOLVES_NOTE } };
  }
  const gradle = hashFiles(cwd, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']);
  if (Object.keys(gradle).length > 0) {
    return { family: 'jvm', ecosystem: 'gradle', files: gradle, installDir: null, desired: { kind: 'note', note: BUILD_RESOLVES_NOTE } };
  }
  return null;
}

function detectCargo(cwd: string): Detected | null {
  const files = hashFiles(cwd, ['Cargo.toml']);
  return files['Cargo.toml']
    ? { family: 'cargo', ecosystem: 'cargo', files, installDir: null, desired: { kind: 'note', note: BUILD_RESOLVES_NOTE } }
    : null;
}

/** True when a package.json hash moved but the lockfile it pins did not (A1). */
function manifestMovedLockfileDidNot(found: Detected, recorded: DependencyStampEntry): boolean {
  if (found.desired.kind !== 'run' || !found.desired.lockfile) { return false; }
  const lock = found.desired.lockfile;
  if (recorded.files[lock] === undefined || recorded.files[lock] !== found.files[lock]) { return false; }
  return Object.keys(found.files)
    .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
    .some((f) => recorded.files[f] !== found.files[f]);
}

function decide(cwd: string, found: Detected, recorded: DependencyStampEntry | undefined, hash: string): {
  trigger: DependencyTrigger; action: PlannedAction;
} {
  const succeeded = !!recorded && recorded.status !== 'not-installed';
  if (found.desired.kind === 'note') {
    if (recorded && recorded.status === 'not-installed' && recorded.hash === hash) {
      return { trigger: 'manifest-changed', action: { kind: 'none' } };
    }
    return { trigger: recorded ? 'manifest-changed' : 'first-seen', action: { kind: 'note', note: found.desired.note } };
  }

  const hasOutput = found.installDir !== null || !!found.installMarkers;
  const dirMissing = found.installMarkers
    ? !found.installMarkers.some((m) => exists(path.join(cwd, m)))
    : found.installDir !== null && !isDir(path.join(cwd, found.installDir));
  const desired = found.desired;
  const run = (trigger: DependencyTrigger, refresh: boolean, fallback?: string): {
    trigger: DependencyTrigger; action: PlannedAction;
  } => ({
    trigger,
    action: {
      kind: 'run',
      command: refresh && desired.refresh ? desired.refresh : desired.frozen,
      ...(fallback ? { fallback } : {}),
    },
  });
  // With no lockfile the "frozen" command is the refresh one — there is nothing to freeze to.
  const noLock = desired.refresh !== null && desired.lockfile === null;

  if (!succeeded) {
    // A2: adopt only when there is no record at all AND the install directory holds every
    // declared package. An empty or partial node_modules (an earlier `npm install express`
    // before `typescript` was added, a tool's `.cache`) is installed over, never adopted.
    const incomplete = found.complete === false;
    if (!recorded && hasOutput && !dirMissing && !incomplete) {
      return { trigger: 'first-seen', action: { kind: 'adopt' } };
    }
    // First sight: nothing recorded says whether the lockfile still matches the manifest
    // (an agent may have added a dependency before this check). npm is checked directly;
    // pnpm and yarn try the frozen command and retry once with the refresh command.
    const stale = desired.lockInSync === false;
    const fallback = !noLock && !stale && desired.lockfile !== null && desired.lockInSync === null
      && desired.refresh !== null && desired.refresh !== desired.frozen ? desired.refresh : undefined;
    return run(dirMissing || incomplete ? 'install-dir-missing' : 'first-seen', noLock || stale, fallback);
  }
  if (recorded.hash !== hash) {
    return run('manifest-changed', noLock || manifestMovedLockfileDidNot(found, recorded));
  }
  if (dirMissing) {
    return run('install-dir-missing', noLock);
  }
  return { trigger: 'manifest-changed', action: { kind: 'none' } };
}

/**
 * Decide, per family, what to do in `cwd`: run an install, adopt what is there, record a
 * note, or nothing. Order: node, python, go, dotnet, jvm, cargo. Pure apart from reading
 * the manifests; `env.commandExists` is answered by the caller in advance.
 */
export function planDependencyInstalls(
  cwd: string,
  stamp: DependencyStamp,
  settings: DependencyInstallSettings,
  env: PlanEnvironment,
): PlannedInstall[] {
  const detected = [
    detectNode(cwd, settings, env),
    detectPython(cwd, settings, env),
    detectGo(cwd, env),
    detectDotnet(cwd, env),
    detectJvm(cwd),
    detectCargo(cwd),
  ].filter((d): d is Detected => d !== null);

  return detected.map((found) => {
    const key = `${found.family}:.`;
    const hash = combinedHash(found.files);
    const { trigger, action } = decide(cwd, found, stamp.entries[key], hash);
    return { key, ecosystem: found.ecosystem, dir: '.', files: found.files, hash, trigger, action };
  });
}

// ─── Rule text ───

/**
 * The rule a reviewer sees before approving a plan, and the commands it names — the
 * same table the worker uses.
 */
export function describeInstallRule(opts: { enabled: boolean; ignoreScripts: boolean }): {
  enabled: boolean; text: string; commands: string[];
} {
  if (!opts.enabled) {
    return {
      enabled: false,
      text: 'Dependencies are not installed automatically on this server; a command that needs them fails unless the plan installs them.',
      commands: [],
    };
  }
  const commands: string[] = [];
  const add = (c: string): void => { if (!commands.includes(c)) { commands.push(c); } };
  for (const row of ['npm', 'pnpm', 'yarn-classic', 'yarn-berry'] as const) {
    const entry = INSTALL_TABLE[row];
    add(withFlag(entry.frozen as string, entry.ignoreScriptsFlag, opts.ignoreScripts));
    add(withFlag(entry.refresh as string, entry.ignoreScriptsFlag, opts.ignoreScripts));
  }
  add(`python ${INSTALL_TABLE.python.frozen}`);
  add(INSTALL_TABLE.go.frozen as string);
  add(INSTALL_TABLE.dotnet.frozen as string);
  const scripts = opts.ignoreScripts ? 'are skipped (--ignore-scripts)' : 'run';
  return {
    enabled: true,
    text: `Dependencies are installed automatically with ${commands.join(', ')} when a dependency manifest or lockfile changes, `
      + 'or when the install output (node_modules, or .pnp.cjs for Yarn Plug\'n\'Play) is missing or lacks a declared package.Python installs only into an existing virtualenv; Maven, Gradle and Cargo resolve '
      + `dependencies in their own build. Lifecycle scripts ${scripts}.`,
    commands,
  };
}

/**
 * One plain-text line for an output channel or a log: what was installed, with which
 * command, how long it took, and which step needed it.
 */
export function formatDependencyEventLine(ev: DependencyEvent, neededBy?: string): string {
  const before = neededBy ? ` before "${neededBy}"` : ` before the ${ev.stage} step`;
  const seconds = `${(ev.durationMs / 1000).toFixed(1)}s`;
  switch (ev.event) {
    case 'dependencies-installed':
      return `[Dependencies] installed (${ev.ecosystem}) with "${ev.command}" in ${seconds}${before}`;
    case 'dependencies-install-failed':
      return `[Dependencies] could not be installed (${ev.ecosystem}) with "${ev.command}"${before}: `
        + (ev.timedOut ? `timed out after ${seconds}` : `exit ${ev.exitCode ?? 1} after ${seconds}`);
    default:
      return `[Dependencies] not installed (${ev.ecosystem}): ${ev.note ?? ''}`;
  }
}

// ─── Running ───

/** Options for {@link ensureDependencies}. */
export interface EnsureDependenciesOptions {
  settings: DependencyInstallSettings;
  signal: AbortSignal;
  timeoutMs: number;
  stage: DependencyStage;
  taskId?: string;
  env?: Record<string, string>;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  onEvent: (ev: DependencyEvent) => void;
  /** Runs one install command; defaults to `evidence.runGate`. */
  exec?: (command: string, options: GateOptions) => Promise<GateResult>;
  /** PATH probe; defaults to `utils/command-exists`. */
  commandExists?: (cmd: string) => Promise<boolean>;
  now?: () => Date;
  /** Platform override for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Outcome of {@link ensureDependencies}. */
export interface EnsureDependenciesResult {
  ok: boolean;
  aborted: boolean;
  /** The failed install; null when nothing failed (or the failure was not an install command). */
  failed: DependencyEvent | null;
  events: DependencyEvent[];
}

/** One in-process install per working directory at a time. */
const inFlight = new Map<string, Promise<EnsureDependenciesResult>>();

function lockKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function tail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text;
}

/** Wait for `promise`, or for `signal` to abort first — the listener is removed either way. */
async function waitOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<'done' | 'aborted'> {
  if (signal.aborted) { return 'aborted'; }
  let onAbort: (() => void) | null = null;
  try {
    return await Promise.race([
      promise.then(() => 'done' as const, () => 'done' as const),
      new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) { signal.removeEventListener('abort', onAbort); }
  }
}

/**
 * Install dependencies in `cwd` when a manifest or lockfile changed since the last
 * recorded install, or when the install directory is missing. A no-op when nothing
 * changed, when disabled, or when the signal is already aborted.
 *
 * Never throws: an install command that throws or exits non-zero is a failure
 * (`ok: false`, a `dependencies-install-failed` event); an abort is `aborted: true`
 * with no event and no record written.
 */
export async function ensureDependencies(cwd: string, opts: EnsureDependenciesOptions): Promise<EnsureDependenciesResult> {
  if (!opts.settings.enabled) {
    return { ok: true, aborted: false, failed: null, events: [] };
  }
  if (opts.signal.aborted) {
    return { ok: false, aborted: true, failed: null, events: [] };
  }
  const key = lockKey(cwd);
  for (;;) {
    const running = inFlight.get(key);
    if (!running) { break; }
    // Another caller is installing here: wait for it, then plan again — usually a no-op.
    if (await waitOrAbort(running, opts.signal) === 'aborted') {
      return { ok: false, aborted: true, failed: null, events: [] };
    }
  }
  const mine = runInstalls(cwd, opts);
  inFlight.set(key, mine);
  try {
    return await mine;
  } finally {
    if (inFlight.get(key) === mine) { inFlight.delete(key); }
  }
}

async function runInstalls(cwd: string, opts: EnsureDependenciesOptions): Promise<EnsureDependenciesResult> {
  const exec = opts.exec ?? runGate;
  const probe = opts.commandExists ?? defaultCommandExists;
  const now = opts.now ?? ((): Date => new Date());
  const platform = opts.platform ?? process.platform;
  const events: DependencyEvent[] = [];

  const emit = (ev: DependencyEvent): void => {
    events.push(ev);
    try { opts.onEvent(ev); } catch { /* a listener must not break the install */ }
  };

  let plan: PlannedInstall[];
  let env: PlanEnvironment;
  try {
    // First pass learns which tools matter; the second plans with the real PATH answers.
    const asked = new Set<string>();
    planDependencyInstalls(cwd, readDependencyStamp(cwd), opts.settings,
      { platform, commandExists: (c) => { asked.add(c); return true; } });
    const present = new Map<string, boolean>();
    for (const tool of asked) {
      let found = false;
      try { found = await probe(tool); } catch { found = false; }
      present.set(tool, found);
    }
    env = { platform, commandExists: (c) => present.get(c) ?? false };
    plan = planDependencyInstalls(cwd, readDependencyStamp(cwd), opts.settings, env);
  } catch {
    return { ok: true, aborted: false, failed: null, events };
  }

  const base = (item: PlannedInstall, event: DependencyEventName): DependencyEvent => ({
    event,
    stage: opts.stage,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ecosystem: item.ecosystem,
    dir: item.dir,
    trigger: item.trigger,
    command: null,
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    tail: '',
    note: null,
  });

  const record = (item: PlannedInstall, status: DependencyStampEntry['status'], command: string | null, note: string | null): void => {
    const stamp = readDependencyStamp(cwd);
    stamp.entries[item.key] = {
      ecosystem: item.ecosystem, dir: item.dir, status, hash: item.hash, files: item.files,
      command, note, at: now().toISOString(),
    };
    writeDependencyStamp(cwd, stamp);
  };

  for (const item of plan) {
    const action = item.action;
    if (action.kind === 'none') { continue; }
    if (action.kind === 'adopt') { record(item, 'adopted', null, null); continue; }
    if (action.kind === 'note') {
      record(item, 'not-installed', null, action.note);
      emit({ ...base(item, 'dependencies-not-installed'), note: action.note });
      continue;
    }

    if (opts.signal.aborted) {
      return { ok: false, aborted: true, failed: null, events };
    }
    const runOne = async (command: string): Promise<GateResult> => {
      opts.onOutput?.(`[Dependencies] Installing (${item.ecosystem}): ${command}\n`, 'stdout');
      try {
        return await exec(command, {
          cwd, signal: opts.signal, timeoutMs: opts.timeoutMs, env: opts.env, onOutput: opts.onOutput, processGroup: true,
        });
      } catch (err) {
        return {
          command, exitCode: 1, passed: false,
          output: err instanceof Error ? err.message : String(err), durationMs: 0, timedOut: false,
        };
      }
    };
    const wasAborted = (r: GateResult): boolean => opts.signal.aborted && !r.timedOut && r.exitCode !== 0;

    let command = action.command;
    let result = await runOne(command);
    let durationMs = result.durationMs;
    if (wasAborted(result)) {
      return { ok: false, aborted: true, failed: null, events };
    }
    // First sight on pnpm/yarn: the frozen command refuses a lockfile that no longer
    // matches package.json — retry once with the fixed refresh command. Never on timeout.
    if (result.exitCode !== 0 && !result.timedOut && action.fallback) {
      opts.onOutput?.(`[Dependencies] ${command} exited ${result.exitCode ?? 1}; the lockfile may not match `
        + `package.json — retrying with ${action.fallback}\n`, 'stdout');
      command = action.fallback;
      result = await runOne(command);
      durationMs += result.durationMs;
      if (wasAborted(result)) {
        return { ok: false, aborted: true, failed: null, events };
      }
    }
    const ev: DependencyEvent = {
      ...base(item, result.exitCode === 0 ? 'dependencies-installed' : 'dependencies-install-failed'),
      command,
      durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      tail: tail(result.output ?? ''),
    };
    if (result.exitCode !== 0) {
      emit(ev);
      return { ok: false, aborted: false, failed: ev, events };
    }
    // The install itself may write the lockfile (npm install, a refresh) — record what is
    // on disk now, or the next step would see a "change" and install again.
    let after = item;
    try {
      after = planDependencyInstalls(cwd, readDependencyStamp(cwd), opts.settings, env)
        .find((p) => p.key === item.key) ?? item;
    } catch {
      after = item;
    }
    record({ ...item, files: after.files, hash: after.hash, ecosystem: after.ecosystem }, 'installed', command, null);
    emit(ev);
  }
  return { ok: true, aborted: false, failed: null, events };
}

/** Test seam: forget every in-flight install. */
export function _resetDependencyInstallsForTest(): void {
  inFlight.clear();
}
