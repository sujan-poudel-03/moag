// ─── Deterministic evidence collection for PRD verification ───
//
// Everything in this module is a *fact about the working tree*: what changed,
// what a real command exited with, whether a file exists. Nothing here asks a
// model anything. The PRD loop runs these gates BEFORE any model call so that an
// agent which wrote a stub and exited 0 fails on evidence rather than on judgment.
//
// Deliberately free of VS Code API imports so both the extension and the
// headless CLI can share it.

import { spawn, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeProject } from '../context/project-analyzer';
import { killProcess, SPAWN_DETACHED } from '../utils/process-kill';
import { readImportPathScopes } from './import-paths';
import { trackChildProcess } from '../utils/child-tracker';
import { VENDOR_MANIFESTS } from '../standards/checker';
import type { StandardsCheckFile, StandardsCheckInput, WorkspacePackage } from '../standards/checker';
import type { StandardsCheckCounts } from '../models/types';
import { StandardsGateWord, isStandardsGateCommand, standardsGateWord, standardsOpenText } from '../models/requirement-trace';

/** Hard ceiling on any single git invocation, mirroring the runner's GIT_TIMEOUT_MS. */
const GIT_TIMEOUT_MS = 30_000;

/** Appended (or prepended, for tails) whenever text is cut to fit a budget. */
const TRUNCATION_MARKER = '\n…[diff truncated]';
const OUTPUT_TRUNCATION_MARKER = '…[output truncated]\n';

/** PRD file names probed, in priority order. Mirrors the workspace detector in extension.ts. */
const PRD_CANDIDATES = [
  'PRD.md',
  'prd.md',
  'docs/PRD.md',
  'docs/prd.md',
  'REQUIREMENTS.md',
  'requirements.md',
];

/** Test-framework to gate-command map. Kept identical to `TaskRunner.detectTestCommand`. */
const TEST_FRAMEWORK_COMMANDS: Record<string, string> = {
  'jest': 'npx jest --passWithNoTests',
  'vitest': 'npx vitest run',
  'mocha': 'npm test',
  'ava': 'npx ava',
  'pytest': 'pytest',
  'go test': 'go test ./...',
  'cargo test': 'cargo test',
};

// ─── Types ───

/** What actually changed on disk since the verification base ref. */
export interface DiffEvidence {
  /** The git ref the diff is taken against, or null when git is unavailable. */
  baseRef: string | null;
  changedFiles: string[];
  diffStat: string;
  unifiedDiff: string;
  /** True when `unifiedDiff` was cut to fit `maxDiffChars`. */
  truncated: boolean;
}

/** Outcome of one deterministic gate command. */
export interface GateResult {
  command: string;
  exitCode: number;
  passed: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * Only on the synthetic `moag:standards` row: what that check left open — advisory
   * findings, rules and files not checked. The requirement trace records it beside the row.
   */
  standardsCounts?: StandardsCheckCounts;
}

/** Options for {@link runGate}. */
export interface GateOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  env?: Record<string, string>;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Spawn the command as a process-group leader (POSIX only) so an abort or timeout
   * kills everything it started — a package manager runs a whole tree. Default false.
   */
  processGroup?: boolean;
}

/** Options for {@link collectDiffEvidence}. */
export interface DiffOptions {
  maxDiffChars: number;
}

// ─── Process helpers ───


/**
 * Run a git subcommand, resolving trimmed stdout on exit 0 and null on any failure.
 * `raw` keeps the output exactly as git wrote it — needed for file content, where leading
 * blank lines decide every line number after them.
 */
function runGit(args: string[], cwd: string, opts: { raw?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        resolve(value);
      } finally {
        clearTimeout(timer);
      }
    };

    const timer = setTimeout(() => {
      killProcess(proc);
      finish(null);
    }, GIT_TIMEOUT_MS);

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => finish(code === 0 ? (opts.raw ? stdout : stdout.trim()) : null));
  });
}

// ─── Public API ───

/**
 * Capture the ref that "before the work" means.
 *
 * Prefers `git stash create` so uncommitted work in a dirty tree is still part of
 * the diff; falls back to HEAD. Returns null when git is unavailable or the
 * directory is not a repository — callers must treat that as "no evidence", never
 * as an error.
 */
export async function captureBaseRef(cwd: string): Promise<string | null> {
  const stashRef = await runGit(['stash', 'create'], cwd);
  if (stashRef) {
    return stashRef;
  }
  return runGit(['rev-parse', 'HEAD'], cwd);
}

/**
 * Collect the changed-file list, diffstat and unified diff since `baseRef`.
 *
 * Never throws: a null ref, a missing git binary, or a non-zero git exit all
 * produce empty evidence, which the caller's change gate reads as "nothing was done".
 */
export async function collectDiffEvidence(
  cwd: string,
  baseRef: string | null,
  opts: DiffOptions,
): Promise<DiffEvidence> {
  const empty: DiffEvidence = {
    baseRef,
    changedFiles: [],
    diffStat: '',
    unifiedDiff: '',
    truncated: false,
  };
  if (!baseRef) {
    return empty;
  }

  let nameOnly: string | null = null;
  let stat: string | null = null;
  let diff: string | null = null;
  let untracked: string | null = null;
  try {
    nameOnly = await runGit(['diff', '--name-only', baseRef], cwd);
    stat = await runGit(['diff', '--stat', baseRef], cwd);
    diff = await runGit(['diff', '--no-color', baseRef], cwd);
    // `git diff` cannot see untracked files, but an agent implementing a feature
    // usually CREATES files. Without this the change gate reports "the work was
    // not performed" for the most common success case. --exclude-standard
    // honours .gitignore, so build output and node_modules stay out.
    untracked = await runGit(['ls-files', '--others', '--exclude-standard'], cwd);
  } catch {
    return empty;
  }

  const splitLines = (value: string | null): string[] =>
    value ? value.split('\n').map((f) => f.trim()).filter((f) => f.length > 0) : [];
  // MOAG writes its own state and verification reports under .moag/. Counting
  // those as evidence would let the change gate pass on MOAG's own output when
  // the agent did nothing at all.
  const isOwnOutput = (f: string): boolean =>
    f === '.moag' || f.startsWith('.moag/') || f.startsWith('.moag\\');
  const changedFiles = [...new Set([...splitLines(nameOnly), ...splitLines(untracked)])]
    .filter((f) => !isOwnOutput(f))
    .sort();
  const full = diff ?? '';
  const max = Math.max(0, Math.floor(opts.maxDiffChars));
  const truncated = full.length > max;

  return {
    baseRef,
    changedFiles,
    diffStat: stat ?? '',
    unifiedDiff: truncated ? clampHead(full, max) : full,
    truncated,
  };
}

/**
 * Run one gate command to completion and report the hard facts.
 *
 * Abort discipline mirrors `TaskRunner.runLocalCommand`: a single `settled` flag,
 * one `finish()` reached from both `close` and `error`, the abort listener removed
 * inside it, and the timeout cleared in a `finally`. Removing the listener only on
 * `close` would leak on every ENOENT.
 */
export function runGate(command: string, options: GateOptions): Promise<GateResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    // A signal that is already aborted never fires 'abort' — bail before spawning.
    if (options.signal.aborted) {
      resolve({
        command,
        exitCode: 130,
        passed: false,
        output: '[Gate aborted]',
        durationMs: 0,
        timedOut: false,
      });
      return;
    }

    let proc: ChildProcess;
    try {
      proc = spawn(command, [], {
        cwd: options.cwd,
        shell: true,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: options.processGroup ? SPAWN_DETACHED : false,
      });
      trackChildProcess(proc);
    } catch (err) {
      resolve({
        command,
        exitCode: 1,
        passed: false,
        output: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
      return;
    }

    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: GateResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        options.signal.removeEventListener('abort', onAbort);
        resolve(result);
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    };

    const onAbort = (): void => {
      killProcess(proc);
      finish({
        command,
        exitCode: 130,
        passed: false,
        output: (output ? output + '\n' : '') + '[Gate aborted]',
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    };

    options.signal.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      killProcess(proc);
      finish({
        command,
        exitCode: 124,
        passed: false,
        output: (output ? output + '\n' : '') + `[Gate timed out after ${options.timeoutMs}ms]`,
        durationMs: Date.now() - startedAt,
        timedOut: true,
      });
    }, options.timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      options.onOutput?.(text, 'stdout');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      options.onOutput?.(text, 'stderr');
    });

    proc.on('error', (err: Error) => {
      finish({
        command,
        exitCode: 1,
        passed: false,
        output: (output ? output + '\n' : '') + err.message,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });

    proc.on('close', (code) => {
      const exitCode = code ?? 1;
      finish({
        command,
        exitCode,
        passed: exitCode === 0,
        output,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
  });
}

/**
 * Decide which commands constitute proof that the repo still works.
 *
 * Priority: caller-supplied list (verbatim) → package.json `build`/`lint`/`test`
 * scripts → detected test framework. An empty result means the repo is not
 * self-checking; the caller decides whether that is fatal.
 */
export function resolveGateCommands(cwd: string, explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) {
    return [...explicit];
  }

  const fromScripts: string[] = [];
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      for (const name of ['build', 'lint', 'test']) {
        const script = scripts[name];
        if (typeof script === 'string' && script.trim().length > 0) {
          fromScripts.push(name === 'test' ? 'npm test' : `npm run ${name}`);
        }
      }
    }
  } catch {
    // Unreadable/invalid package.json — fall through to project analysis.
  }
  if (fromScripts.length > 0) {
    return fromScripts;
  }

  const analysis = analyzeProject(cwd);
  if (analysis.testFramework) {
    const mapped = TEST_FRAMEWORK_COMMANDS[analysis.testFramework];
    if (mapped) {
      return [mapped];
    }
  }
  return [];
}

// ─── Browser UAT capability ───

/**
 * Config-file markers copied verbatim from `adapters/validation/web-validator.ts`.
 * Deliberately duplicated rather than imported: `detectTool` is private there, and
 * this module must stay free of adapter imports so it remains fs/path-only.
 */
const PLAYWRIGHT_MARKERS = ['playwright.config.ts', 'playwright.config.js'];
const CYPRESS_MARKERS = ['cypress.config.ts', 'cypress.config.js', 'cypress.json'];

/** What browser UAT tooling, if any, this workspace can actually run. */
export interface UatCapability {
  tool: 'playwright' | 'cypress' | null;
  /** The command to run, or null when nothing is available. */
  command: string | null;
  /** The spec/path filter that was folded into `command`, if any. */
  specPath: string | null;
  /** Always populated — the marker that matched, or why nothing did. */
  reason: string;
}

/** Quote a path for a shell command when it contains whitespace. */
function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Resolve the browser UAT gate for `cwd`.
 *
 * Order: caller-supplied command (verbatim, no detection) → Playwright/Cypress
 * config markers → package.json dependency check → nothing. `reason` is populated
 * on every path, including success, so the caller can always explain itself.
 * Never throws: an unreadable or malformed package.json is "no capability".
 */
export function resolveUatGate(
  cwd: string,
  opts: { explicitCommand?: string; specPath?: string },
): UatCapability {
  const specPath = opts.specPath && opts.specPath.trim().length > 0 ? opts.specPath.trim() : null;

  const explicit = opts.explicitCommand?.trim();
  if (explicit && explicit.length > 0) {
    return {
      tool: null,
      command: explicit,
      specPath,
      reason: 'Explicit uat.command from configuration.',
    };
  }

  const build = (tool: 'playwright' | 'cypress', reason: string): UatCapability => {
    const spec = specPath ? quoteArg(specPath) : null;
    const command = tool === 'playwright'
      ? `npx playwright test${spec ? ` ${spec}` : ''} --reporter=line`
      : `npx cypress run${spec ? ` --spec ${spec}` : ''}`;
    return { tool, command, specPath, reason };
  };

  for (const marker of PLAYWRIGHT_MARKERS) {
    if (existsQuiet(path.join(cwd, marker))) {
      return build('playwright', marker);
    }
  }
  for (const marker of CYPRESS_MARKERS) {
    if (existsQuiet(path.join(cwd, marker))) {
      return build('cypress', marker);
    }
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps['@playwright/test'] || allDeps['playwright']) {
      return build('playwright', 'package.json dependency: playwright');
    }
    if (allDeps['cypress']) {
      return build('cypress', 'package.json dependency: cypress');
    }
  } catch {
    // Missing or malformed package.json — treated as "no capability", never fatal.
  }

  return {
    tool: null,
    command: null,
    specPath,
    reason: 'No playwright.config.* or cypress.config.* and no playwright/cypress dependency in package.json.',
  };
}

/** `fs.existsSync` that swallows permission errors on unreadable paths. */
function existsQuiet(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Check that every declared artifact actually exists.
 * Relative targets resolve against `cwd` via `path.join`, matching the runner.
 */
export function checkArtifacts(cwd: string, artifacts: string[]): Array<{ target: string; exists: boolean }> {
  return artifacts.map((target) => {
    const resolved = path.isAbsolute(target) ? target : path.join(cwd, target);
    let exists = false;
    try {
      exists = fs.existsSync(resolved);
    } catch {
      exists = false;
    }
    return { target, exists };
  });
}

// ─── Wording a gate off-screen ───

/**
 * One line for a gate in the evidence handed to a model. A command is a process with an exit
 * code: "exit 0 (PASS, 12ms)". The synthetic `moag:standards` row is not a command — most of
 * what it covers is a scan, and a scan that found nothing has not proved that nothing is
 * there — so it is never labelled PASS or FAIL. It says what `standardsGateWord` says on
 * every other surface, with what the check left open beside it:
 * "nothing blocking (2 advisory findings · 1 file not checked, 12ms)".
 */
export function describeGateLine(g: GateResult): string {
  if (isStandardsGateCommand(g.command)) {
    const open = standardsOpenText(g.standardsCounts);
    return '- `' + g.command + '` — ' + standardsGateWord(g.passed, g.standardsCounts) +
      ` (${open ? `${open}, ` : ''}${g.durationMs}ms)`;
  }
  return '- `' + g.command + '` — exit ' + g.exitCode +
    ` (${g.passed ? 'PASS' : 'FAIL'}${g.timedOut ? ', TIMED OUT' : ''}, ${g.durationMs}ms)`;
}

/** A gate as a stored report holds it: a command as it ran, the standards row in words. */
export type StoredGateResult = GateResult | (Omit<GateResult, 'passed'> & {
  /** What the standards row says; it has no `passed` — see {@link gatesForStoredReport}. */
  standards: StandardsGateWord;
  /** What the check left open, in words; '' when nothing was, or nothing was recorded. */
  standardsOpen: string;
});

/**
 * The gates of a verification as a report file stores them (`.moag/verification-<ts>.json`).
 * A command keeps every field. The synthetic `moag:standards` row loses `passed` — a reader
 * of the file must not take "passed: true" for a scan that found nothing — and says instead,
 * in `standards`, one of: stopped / no blocking rules configured / nothing blocking, with
 * what the check left open in `standardsOpen` (and as numbers in `standardsCounts`).
 */
export function gatesForStoredReport(gates: readonly GateResult[]): StoredGateResult[] {
  return gates.map((g) => {
    if (!isStandardsGateCommand(g.command)) { return g; }
    const { passed, ...rest } = g;
    return { ...rest, standards: standardsGateWord(passed, g.standardsCounts), standardsOpen: standardsOpenText(g.standardsCounts) };
  });
}

/**
 * Render the evidence as deterministic markdown that fits inside `budgetChars`.
 *
 * Gate output tails share a fixed slice of the budget; the unified diff is written
 * last so that it is the first thing squeezed when space runs out.
 */
export function summarizeEvidence(ev: DiffEvidence, gates: GateResult[], budgetChars: number): string {
  const budget = Math.max(0, Math.floor(budgetChars));
  if (budget === 0) {
    return '';
  }

  const sections: string[] = [];
  sections.push('## Deterministic evidence');
  sections.push('');
  sections.push(`Base ref: ${ev.baseRef ?? '(none — git unavailable)'}`);
  sections.push('');

  sections.push(`### Changed files (${ev.changedFiles.length})`);
  if (ev.changedFiles.length === 0) {
    sections.push('(none)');
  } else {
    for (const f of ev.changedFiles) {
      sections.push(`- ${f}`);
    }
  }
  sections.push('');

  sections.push('### Diff stat');
  sections.push(ev.diffStat.trim().length > 0 ? ev.diffStat : '(empty)');
  sections.push('');

  sections.push(`### Gate results (${gates.length})`);
  if (gates.length === 0) {
    sections.push('(no gate commands were resolved for this repository)');
  } else {
    // 40% of the budget is reserved for gate output, split evenly per gate.
    const perGate = Math.floor((budget * 0.4) / gates.length);
    for (const g of gates) {
      sections.push(describeGateLine(g));
      const tail = clampTail(g.output.trim(), perGate);
      if (tail.length > 0) {
        sections.push('```');
        sections.push(tail);
        sections.push('```');
      }
    }
  }
  sections.push('');

  const head = sections.join('\n');
  const diffHeader = '### Unified diff\n';
  const remaining = budget - head.length - diffHeader.length;
  let out = head;
  if (ev.unifiedDiff.trim().length > 0 && remaining > 0) {
    out = head + diffHeader + clampHead(ev.unifiedDiff, remaining);
  }
  return clampHead(out, budget);
}

/** Locate a PRD-shaped file in `cwd`, returning the relative path or null. */
export function detectPrdFile(cwd: string): string | null {
  for (const rel of PRD_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(cwd, rel))) {
        return rel;
      }
    } catch {
      // ignore unreadable candidates
    }
  }
  return null;
}

// ─── Standards evidence ───

/**
 * Git's well-known empty tree. Diffing against it makes every file count as
 * added, which is exactly right for a repository with no commits yet.
 */
export const EMPTY_TREE_REF = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Largest changed file handed to the standards checker; larger ones are reported as skipped. */
const MAX_STANDARDS_FILE_BYTES = 512 * 1024;
/** Most changed files read for one check; the rest are reported as skipped. */
const MAX_STANDARDS_FILES = 2_000;
const MAX_GO_MOD_BYTES = 64 * 1024;
/** Most committed-but-since-altered files read back from the last commit for one check. */
const MAX_COMMITTED_FILES = 100;
/** Largest workspace manifest read, and the most workspace packages listed. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_WORKSPACE_PACKAGES = 300;
/** How deep a `**` workspace pattern is followed. */
const MAX_WORKSPACE_DEPTH = 4;
/** Git's mode for a gitlink: a directory entry that is another repository's commit. */
const GITLINK_MODE = '160000';
/**
 * How many files git may pair up when it looks for renames. Git's own limit (`diff.renameLimit`,
 * 1,000 by default and lower in older versions, or whatever the repository's config says)
 * silently switches inexact rename detection OFF for a larger change — and every moved legacy
 * file then comes back as "added", with each of its old lines judged as if this change wrote
 * it. The limit is therefore given on every command line, generously, where no config can
 * lower it.
 */
const RENAME_LIMIT = 20_000;
/** Rename detection for every diff the standards checker reads: on, with {@link RENAME_LIMIT}. */
const RENAME_FLAGS = ['-M', `-l${RENAME_LIMIT}`];

/** Options for {@link collectStandardsInput}. */
export interface StandardsInputOptions {
  /**
   * Directories whose existence the checker needs to know (the profile's required dirs).
   * One exists when git lists a path in it — tracked, or untracked and not ignored —
   * compared case-sensitively: the file system's own answer is not asked, because on a
   * case-insensitive one `SRC` "exists" where only `src` does.
   */
  probeDirs?: string[];
}

/**
 * The commit the working tree is based on, or null when there is none — git is
 * unavailable, this is not a repository, or it has no commits yet.
 *
 * This is the base the standards gate diffs against. Unlike
 * {@link captureBaseRef} it never returns a stash commit: a diff against a
 * stash of the working tree shows no tracked change at all.
 */
export function captureHeadRef(cwd: string): Promise<string | null> {
  return runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
}

/** A ref that can be passed to git as a positional argument without being read as an option. */
function isSafeRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 200 && !ref.startsWith('-') && /^[A-Za-z0-9_./~^@{}-]+$/.test(ref);
}

/** True when git would C-quote this path in patch headers, so hunks cannot be matched to it. */
function needsQuoting(filePath: string): boolean {
  for (let i = 0; i < filePath.length; i++) {
    const code = filePath.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c) { return true; }
  }
  return false;
}

function isMoagOutput(f: string): boolean {
  return f === '.moag' || f.startsWith('.moag/') || f.startsWith('.moag\\');
}

/** What a `--unified=0` patch says about one file. */
interface RenderedDiff {
  /** 1-based numbers of the lines the patch adds, ascending. */
  added: number[];
  /** How many hunks git rendered. Zero with changed content means git did not show the change. */
  hunks: number;
  /** The entry changes the file mode and nothing else, so there is no content to render. */
  modeOnly: boolean;
}

/**
 * Per-file facts from a `--unified=0` patch: the added line numbers and how
 * many hunks were rendered.
 *
 * Hunk bodies are skipped by their declared line counts rather than by prefix,
 * so an added line whose text happens to look like a `+++ b/…` or `diff --git`
 * header can never be mistaken for one.
 */
function parseRenderedDiff(patch: string): Map<string, RenderedDiff> {
  const out = new Map<string, RenderedDiff>();
  const entry = (file: string): RenderedDiff => {
    let found = out.get(file);
    if (!found) {
      found = { added: [], hunks: 0, modeOnly: false };
      out.set(file, found);
    }
    return found;
  };
  let current: RenderedDiff | null = null;
  /** The entry opened by the last `diff --git` line. */
  let header: RenderedDiff | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-') && oldLeft > 0) { oldLeft--; continue; }
      if (line.startsWith('+') && newLeft > 0) { newLeft--; continue; }
      if (line.startsWith('\\')) { continue; }
      // The body ended early (binary or malformed patch) — fall through and re-read the line.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith('diff --git a/')) {
      // Both sides name the same path — `a/<path> b/<path>` — except for a rename, whose
      // header matches nothing here and whose hunks are attached by its `+++ b/<new>` line.
      const rest = line.slice('diff --git a/'.length);
      const half = (rest.length - 3) / 2;
      const file = rest.slice(0, half);
      header = Number.isInteger(half) && half > 0 && rest === `${file} b/${file}` ? entry(file) : null;
      current = null;
      continue;
    }
    if (header && (line.startsWith('old mode ') || line.startsWith('new mode '))) {
      header.modeOnly = true;
      continue;
    }
    if (header && line.startsWith('index ')) {
      // An index line means the content changed too.
      header.modeOnly = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t$/, '');
      current = target.startsWith('b/') ? entry(target.slice(2)) : null;
      if (current) { current.modeOnly = false; }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (current) {
        current.hunks++;
        const start = Number(hunk[2]);
        for (let n = 0; n < newLeft; n++) { current.added.push(start + n); }
      }
    }
  }
  return out;
}

/** Why a changed file whose diff git did not render is left undecided. */
export const UNRENDERED_DIFF = 'Git rendered no diff for this changed file, so its added lines are unknown';

/** Why a file git was told to treat as unchanged is left undecided. */
export const HIDDEN_FROM_GIT = 'Git was told to ignore changes to this file (assume-unchanged or skip-worktree), so what changed in it is unknown';

/** Read one changed file for the checker, or say why it was not read. */
function readForStandards(cwd: string, rel: string): { content: string | null; skipped?: string } {
  const full = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { content: null, skipped: 'Path is outside the workspace' };
  }
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) { return { content: null, skipped: 'Not a regular file' }; }
    if (stat.size > MAX_STANDARDS_FILE_BYTES) { return { content: null, skipped: 'File is larger than 512 KB' }; }
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) { return { content: null, skipped: 'Binary content' }; }
    return { content: buffer.toString('utf-8') };
  } catch {
    return { content: null, skipped: 'File could not be read' };
  }
}

/** Every line number of `content`, 1-based. A trailing newline does not add a line. */
function allLineNumbers(content: string): number[] {
  if (content.length === 0) { return []; }
  const count = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** Why the committed version of a file is listed next to (or instead of) its working-tree copy. */
export const COMMITTED_NOT_READ = 'The committed version of this file differs from the working tree and could not be read';

/** The id git gives a blob with this content, in the hash the repository uses (told by `like`). */
function gitBlobId(content: Buffer, like: string): string {
  const hash = createHash(like.length === 64 ? 'sha256' : 'sha1');
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest('hex');
}

/**
 * The path of the deleted file whose content `content` is, or undefined when it is none of
 * them. Compared as git stores it: with `core.autocrlf` (the Git for Windows default) a
 * checkout has CRLF line endings while the blob has LF, so the bytes on disk never hash to
 * the blob id — the LF form is tried too. Only line endings differ between the two forms,
 * so a match there is still the same file under a new name.
 */
function movedFromDeleted(content: string, deletedBlobs: Map<string, string>): string | undefined {
  const sample = deletedBlobs.keys().next().value as string | undefined;
  if (sample === undefined || content.length === 0) { return undefined; }
  const exact = deletedBlobs.get(gitBlobId(Buffer.from(content, 'utf-8'), sample));
  if (exact !== undefined || !content.includes('\r\n')) { return exact; }
  return deletedBlobs.get(gitBlobId(Buffer.from(content.replace(/\r\n/g, '\n'), 'utf-8'), sample));
}

/** What `git diff --raw -z` says beyond names: the blobs the change deleted. */
interface RawDiff {
  /** Blob id at the base → path, for every file the change deleted. */
  deletedBlobs: Map<string, string>;
}

function parseRawDiff(raw: string): RawDiff {
  const out: RawDiff = { deletedBlobs: new Map() };
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const header = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i].trim());
    if (!header) { continue; }
    const [, oldMode, , oldId, , status] = header;
    const first = parts[i + 1];
    const renamed = status === 'R' || status === 'C';
    const file = renamed ? parts[i + 2] : first;
    i += renamed ? 2 : 1;
    if (!file) { continue; }
    if (status === 'D' && oldMode !== GITLINK_MODE) { out.deletedBlobs.set(oldId, file); }
  }
  return out;
}

/** What `git diff --name-status -z` (renames on) says. */
interface NameStatus {
  /** Path in the new tree → status. */
  changed: Map<string, StandardsCheckFile['status']>;
  /** The renames that changed no content. */
  pureRenames: Set<string>;
  /** New path → the path the file had at the base, for every rename. */
  renamedFrom: Map<string, string>;
}

/** Parse `git diff --name-status -z` (renames on). */
function parseNameStatus(status: string): NameStatus {
  const changed = new Map<string, StandardsCheckFile['status']>();
  const pureRenames = new Set<string>();
  const renamedFrom = new Map<string, string>();
  const parts = status.split('\0');
  for (let i = 0; i < parts.length;) {
    const code = parts[i].trim();
    if (/^[RC]\d*$/.test(code)) {
      // `R<score>\0<old>\0<new>`: the new path is the one in the tree now.
      const to = parts[i + 2];
      if (to) {
        changed.set(to, code.startsWith('R') ? 'renamed' : 'added');
        if (code.startsWith('R') && parts[i + 1]) { renamedFrom.set(to, parts[i + 1]); }
        if (code === 'R100') { pureRenames.add(to); }
      }
      i += 3;
      continue;
    }
    const file = parts[i + 1];
    i += 2;
    if (!file || code.startsWith('D')) { continue; }
    changed.set(file, code.startsWith('A') ? 'added' : 'modified');
  }
  return { changed, pureRenames, renamedFrom };
}

/** Parse a JSON file of at most {@link MAX_MANIFEST_BYTES}; undefined when absent, null when unreadable. */
function readJsonManifest(file: string): Record<string, unknown> | null | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return undefined; }
  try {
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) { return null; }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The workspace patterns a repository declares: `workspaces` in the root `package.json`
 * (a list, or `{ packages: [...] }`) and `packages:` in `pnpm-workspace.yaml`. Undefined
 * when it declares none; null when it declares some that cannot be read.
 */
function workspacePatterns(cwd: string): string[] | null | undefined {
  const patterns: string[] = [];
  let declared = false;
  const root = readJsonManifest(path.join(cwd, 'package.json'));
  if (root === null) { return null; }
  if (root && root.workspaces !== undefined) {
    declared = true;
    const ws = root.workspaces;
    const list = Array.isArray(ws) ? ws : ws && typeof ws === 'object' ? (ws as Record<string, unknown>).packages : null;
    if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) { return null; }
    patterns.push(...list as string[]);
  }
  let pnpm: string | null = null;
  try {
    const file = path.join(cwd, 'pnpm-workspace.yaml');
    if (fs.statSync(file).size > MAX_MANIFEST_BYTES) { return null; }
    pnpm = fs.readFileSync(file, 'utf-8');
  } catch {
    pnpm = null;
  }
  if (pnpm !== null) {
    declared = true;
    // Only the plain block list under `packages:` is read; anything fancier is "cannot be read".
    const lines = pnpm.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex((l) => /^packages\s*:\s*(?:#.*)?$/.test(l));
    if (start < 0) { return /^packages\s*:/m.test(pnpm) ? null : patterns; }
    for (let n = start + 1; n < lines.length; n++) {
      const line = lines[n];
      if (/^\s*(?:#.*)?$/.test(line)) { continue; }
      const item = /^\s+-\s+(?:'([^']*)'|"([^"]*)"|([^'"#\s][^#]*?))\s*(?:#.*)?$/.exec(line);
      if (!item) {
        if (/^\S/.test(line)) { break; }
        return null;
      }
      patterns.push((item[1] ?? item[2] ?? item[3]).trim());
    }
  }
  return declared ? patterns : undefined;
}

/**
 * The packages of the repository's own workspace, by the name they are imported under.
 * `[]` when the repository declares no workspace; null when it declares one whose packages
 * could not all be listed — the checker then cannot place an import of them and says so.
 * Reads manifests only; nothing is executed.
 */
export function readWorkspacePackages(cwd: string): WorkspacePackage[] | null {
  const patterns = workspacePatterns(cwd);
  if (patterns === undefined) { return []; }
  if (patterns === null) { return null; }
  const dirs = new Set<string>();
  const subdirs = (rel: string): string[] => {
    try {
      return fs.readdirSync(path.join(cwd, rel), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
        .map((e) => (rel ? `${rel}/${e.name}` : e.name));
    } catch {
      return [];
    }
  };
  for (const raw of patterns) {
    const pattern = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    // A negation only narrows the set; leaving it out lists a package too many, never too few.
    if (pattern === '' || pattern.startsWith('!')) { continue; }
    const star = pattern.indexOf('*');
    if (star < 0) { dirs.add(pattern); continue; }
    const prefix = pattern.slice(0, star).replace(/\/+$/, '');
    const rest = pattern.slice(star);
    // `packages/*` and `packages/**` are the shapes every tool documents. Anything else
    // (`packages/*-lib`, `*/packages/*`) is not expanded here, so the list would be incomplete.
    if (rest !== '*' && rest !== '**' && rest !== '**/*') { return null; }
    let level = subdirs(prefix);
    for (let depth = 0; depth < (rest === '*' ? 1 : MAX_WORKSPACE_DEPTH) && level.length > 0; depth++) {
      for (const dir of level) { dirs.add(dir); }
      if (dirs.size > MAX_WORKSPACE_PACKAGES * 4) { return null; }
      level = rest === '*' ? [] : level.flatMap(subdirs);
    }
  }
  const packages: WorkspacePackage[] = [];
  for (const dir of [...dirs].sort()) {
    const manifest = readJsonManifest(path.join(cwd, dir, 'package.json'));
    if (manifest === undefined) { continue; }
    if (manifest === null) { return null; }
    if (typeof manifest.name === 'string' && manifest.name.length > 0 && manifest.name.length <= 214) {
      packages.push({ name: manifest.name, dir });
      if (packages.length > MAX_WORKSPACE_PACKAGES) { return null; }
    }
  }
  return packages;
}

/**
 * The directories below the root that the repository itself marks as third-party code,
 * among the ones `paths` pass through: a `node_modules` whose parent holds a `package.json`,
 * a `vendor` whose parent holds a `go.mod`, `composer.json` or `Gemfile`. A directory that
 * merely has the name is not listed — `src/vendor/` may be the project's own code.
 */
function recognisedVendorRoots(cwd: string, paths: string[]): string[] {
  const roots = new Set<string>();
  const rejected = new Set<string>();
  for (const file of paths) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length - 1; i++) {
      const markers = VENDOR_MANIFESTS[segments[i]];
      if (!markers) { continue; }
      const root = segments.slice(0, i + 1).join('/');
      if (roots.has(root) || rejected.has(root)) { break; }
      const parent = path.join(cwd, ...segments.slice(0, i));
      const marked = markers.some((m) => {
        try { return fs.statSync(path.join(parent, m)).isFile(); } catch { return false; }
      });
      (marked ? roots : rejected).add(root);
      break;
    }
  }
  return [...roots].sort();
}

/**
 * Gather what the standards checker needs to know about the working tree:
 * which files changed since `baseRef`, which line numbers each one gained, the
 * new content of each, and a few facts about the layout.
 *
 * A null `baseRef` means "no commits yet" and diffs against the empty tree, so
 * every file counts as added. A base that was recorded but that this repository
 * cannot resolve any more (its history was rewritten and pruned, or the workspace
 * was re-cloned) falls back to the empty tree too: every file is then judged,
 * rather than none. The returned `baseRef` is the ref actually used — compare it
 * with the one passed in to tell the fallback happened — or null when no diff
 * could be taken at all (not a repository, git missing, a ref that is not safe to
 * pass); the checker then reports its diff-based rules as not checked. MOAG's own
 * `.moag/` output is never part of the input.
 *
 * The party being checked can write to the repository, so nothing in it may
 * decide what the patch shows. The patch is taken with `--text --no-textconv`
 * (a `-diff` or `binary` attribute, or a textconv driver, would otherwise hide
 * the hunks), and — independently — a changed file that has content but for which
 * git still rendered no hunk is reported as `skipped`, never as "no lines added":
 * its line-based rules come out not checked instead of passed. Untracked FILES are
 * listed honouring `.gitignore` files only, never `.git/info/exclude` or a global
 * excludes file; and a file flagged assume-unchanged or skip-worktree in the index
 * is reported as `skipped` ({@link HIDDEN_FROM_GIT}). What remains is an edit to a
 * `.gitignore`, which is itself part of the diff.
 *
 * The layout facts include the repository's own import mappings — workspace packages and
 * tsconfig/jsconfig `paths` — read from manifests only, so the layering rule can tell the
 * project's own code from a published package of the same shape.
 *
 * Three more things a plain diff gets wrong are put right here:
 *
 *   - Renames are detected (`-M`, with an explicit generous limit so that neither a large
 *     change nor the repository's `diff.renameLimit` can switch detection off). A file git
 *     matched to one that existed at the base is `renamed`, with only the lines the change
 *     really altered as added — `git mv` of a legacy file adds no line. An untracked file
 *     whose content is byte-for-byte a file the change deleted (a plain `mv`, not yet staged)
 *     is a rename too.
 *   - A directory that is a repository of its own — an untracked directory with a `.git`,
 *     or a gitlink in the index — is ONE entry to git, which shows none of its files. It is
 *     never listed as a file. By the state of the tree as it stands (no base ref enters into
 *     it): one a tracked `.gitmodules` declares goes to `submodules`, any other to
 *     `nestedRepos`, so the checker reports it instead of passing on content nobody read.
 *     Untracked directories are taken from git's own listing with its standard excludes, so
 *     `.git/info/exclude` and a global excludes file hide one exactly as `git status` would.
 *   - What is committed is what ships. A file committed since the base and then deleted
 *     or rewritten in the working tree without a commit is listed a second time with its
 *     COMMITTED content (`origin: 'committed'`), so the working tree cannot hide it.
 *   - What is staged is what the next commit ships. Content that was `git add`ed and then
 *     removed from — or rewritten in — the working tree is not in a working-tree diff at
 *     all. It is listed with its STAGED content (`origin: 'staged'`) and judged like any
 *     other file.
 *
 * Never throws.
 */
export async function collectStandardsInput(
  cwd: string,
  baseRef: string | null,
  opts: StandardsInputOptions = {},
): Promise<StandardsCheckInput> {
  let goModulePath: string | null = null;
  try {
    const goMod = path.join(cwd, 'go.mod');
    if (fs.statSync(goMod).size <= MAX_GO_MOD_BYTES) {
      goModulePath = /^module\s+(\S+)/m.exec(fs.readFileSync(goMod, 'utf-8'))?.[1] ?? null;
    }
  } catch {
    goModulePath = null;
  }
  // Without git's listing no directory is known to exist: the checker reports the rule as not checked.
  const unavailable: StandardsCheckInput = { baseRef: null, files: [], existingDirs: [], topLevel: [], goModulePath };

  let base = baseRef ?? EMPTY_TREE_REF;
  if (!isSafeRef(base)) {
    return unavailable;
  }

  // Nothing the repository or the user's git configuration says may narrow what is listed:
  // no fsmonitor hook answers "unchanged" for git, and no excludes file outside the tree applies.
  const quiet = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile='];
  let status: string | null = null;
  let patch: string | null = null;
  let rawDiff: string | null = null;
  let untracked: string | null = null;
  let tree: string | null = null;
  let indexFlags: string | null = null;
  let indexEntries: string | null = null;
  let untrackedAsStatus: string | null = null;
  let declaredSubmodules: string | null = null;
  /** The patch flags that keep the repository from deciding what the diff shows. */
  const patchFlags = [
    'diff', '--no-color', '--unified=0', '--no-ext-diff', '--text', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
  ];
  try {
    if (baseRef !== null && await runGit([...quiet, 'rev-parse', '--verify', '--quiet', `${base}^{tree}`], cwd) === null) {
      // A base was recorded, and this repository no longer has it (history rewritten and
      // pruned, or the workspace re-cloned). "No diff" would wave everything through, so
      // fail closed: diff against the empty tree and judge every file as added.
      if (await runGit(['rev-parse', '--git-dir'], cwd) === null) {
        return unavailable;
      }
      base = EMPTY_TREE_REF;
    }
    status = await runGit([...quiet, 'diff', '--name-status', ...RENAME_FLAGS, '-z', base, '--'], cwd);
    if (status === null) {
      return unavailable;
    }
    patch = await runGit([...quiet, ...patchFlags, ...RENAME_FLAGS, base, '--'], cwd);
    // Modes and blob ids: which entries are gitlinks, and what the deleted files held.
    rawDiff = await runGit([...quiet, 'diff', '--raw', '--no-abbrev', ...RENAME_FLAGS, '-z', base, '--'], cwd);
    // Only `.gitignore` files — which are in the tree, so an edit to one shows in the diff —
    // decide what is ignored. `--exclude-standard` would also honour `.git/info/exclude` and
    // the user's global excludes, which leave no trace in the repository.
    untracked = await runGit([...quiet, 'ls-files', '--others', '--exclude-per-directory=.gitignore', '-z'], cwd);
    tree = await runGit([...quiet, 'ls-tree', '--name-only', '-z', base], cwd);
    indexFlags = await runGit([...quiet, 'ls-files', '-v', '-z'], cwd);
    // The tree as it stands, for the two rules that read it rather than the diff: every
    // index entry with its mode (a gitlink is mode 160000), the untracked entries exactly as
    // `git status` would list them — standard excludes on, so this one query does NOT blank
    // the user's excludes file — and the submodule paths the TRACKED `.gitmodules` declares
    // (read from the index, not from a working-tree file the change could have just written).
    indexEntries = await runGit(['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', 'ls-files', '-s', '-z'], cwd);
    untrackedAsStatus = await runGit(
      ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'], cwd,
    );
    declaredSubmodules = await runGit(['config', '--blob', ':.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.path$'], cwd);
  } catch {
    return unavailable;
  }
  if (patch === null || untracked === null || indexFlags === null || indexEntries === null || untrackedAsStatus === null) {
    return unavailable;
  }

  const { changed, pureRenames } = parseNameStatus(status);
  const raw = parseRawDiff(rawDiff ?? '');
  // Repositories inside this one, by the state of the tree as it stands. No base ref enters
  // into it: whether a gitlink was added by this change or years ago, its files were not read.
  const nestedRepos = new Set<string>();
  const submodules = new Set<string>();
  const declared = new Set<string>();
  for (const entry of (declaredSubmodules ?? '').split('\0')) {
    // `submodule.<name>.path\n<value>`
    const cut = entry.indexOf('\n');
    if (cut > 0) { declared.add(entry.slice(cut + 1).replace(/\\/g, '/').replace(/\/+$/, '')); }
  }
  /** Every path git lists for the tree: tracked, or untracked and not ignored. */
  const listedPaths: string[] = [];
  for (const entry of indexEntries.split('\0')) {
    // `<mode> <id> <stage>\t<path>`
    const tab = entry.indexOf('\t');
    if (tab <= 0) { continue; }
    const file = entry.slice(tab + 1);
    listedPaths.push(file);
    if (!entry.startsWith(`${GITLINK_MODE} `)) { continue; }
    (declared.has(file) ? submodules : nestedRepos).add(file);
    // A gitlink is a directory to everything else here, never a changed file.
    changed.delete(file);
  }
  for (const entry of untrackedAsStatus.split('\0')) {
    // Git lists an untracked directory that is its own repository as one entry ending in `/`.
    if (entry.length > 1 && entry.endsWith('/')) { nestedRepos.add(entry.replace(/\/+$/, '')); }
  }
  const untrackedFiles = new Set<string>();
  for (const entry of untracked.split('\0')) {
    // A directory entry is a nested repository: taken from the status-like listing above.
    if (entry.length === 0 || entry.endsWith('/')) { continue; }
    untrackedFiles.add(entry);
    listedPaths.push(entry);
    changed.set(entry, 'added');
  }
  for (const dir of [...nestedRepos, ...submodules]) { changed.delete(dir); listedPaths.push(`${dir}/`); }
  // A required directory exists when git lists a path in it. Compared as strings, so
  // case-sensitively, whatever the file system would answer.
  const existingDirs = (opts.probeDirs ?? []).filter((dir) => {
    const prefix = `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
    return prefix !== '/' && listedPaths.some((file) => file.startsWith(prefix));
  });

  // `git update-index --assume-unchanged` / `--skip-worktree` make git report a file as
  // unchanged whatever is on disk. Such a file may hold anything: it is listed as changed
  // and unread, so its rules come out not checked and the report names it.
  const hiddenFiles = new Set<string>();
  for (const entry of indexFlags.split('\0')) {
    const tag = entry.charAt(0);
    const file = entry.slice(2);
    if (file.length === 0 || entry.charAt(1) !== ' ' || !(tag === 'S' || (tag >= 'a' && tag <= 'z'))) { continue; }
    try {
      // A file that is not on disk (a sparse checkout) hides nothing.
      if (!fs.lstatSync(path.join(cwd, file)).isFile()) { continue; }
    } catch {
      continue;
    }
    hiddenFiles.add(file);
    if (!changed.has(file)) { changed.set(file, 'modified'); }
  }

  const renderedByFile = parseRenderedDiff(patch);
  const files: StandardsCheckFile[] = [];
  const paths = [...changed.keys()].filter((f) => !isMoagOutput(f)).sort();
  for (const file of paths) {
    const fileStatus = changed.get(file) ?? 'modified';
    if (files.length >= MAX_STANDARDS_FILES) {
      files.push({ path: file, status: fileStatus, addedLines: [], content: null, skipped: 'Too many changed files to read' });
      continue;
    }
    if (hiddenFiles.has(file)) {
      files.push({ path: file, status: fileStatus, addedLines: [], content: null, skipped: HIDDEN_FROM_GIT });
      continue;
    }
    const read = readForStandards(cwd, file);
    if (read.content === null) {
      files.push({ path: file, status: fileStatus, addedLines: [], content: null, skipped: read.skipped });
      continue;
    }
    if (untrackedFiles.has(file)) {
      // Moved with a plain `mv`: the old path shows as deleted, the new one as untracked.
      // The same bytes under a new name are a rename, and no line of them is new.
      if (movedFromDeleted(read.content, raw.deletedBlobs) !== undefined) {
        files.push({ path: file, status: 'renamed', addedLines: [], content: read.content });
      } else {
        files.push({ path: file, status: 'added', addedLines: allLineNumbers(read.content), content: read.content });
      }
      continue;
    }
    if (needsQuoting(file)) {
      files.push({ path: file, status: fileStatus, addedLines: [], content: null, skipped: 'File name cannot be matched to the diff' });
      continue;
    }
    const rendered = renderedByFile.get(file);
    if (pureRenames.has(file) && (!rendered || rendered.hunks === 0)) {
      // Git matched every byte to a file that existed at the base: nothing in it is new.
      files.push({ path: file, status: fileStatus, addedLines: [], content: read.content });
      continue;
    }
    if ((!rendered || rendered.hunks === 0) && read.content.length > 0 && !rendered?.modeOnly) {
      // Git lists the file as changed and it has content, yet the patch shows nothing for it.
      // "No added lines" would let every line-based rule pass on a file nobody looked at.
      files.push({ path: file, status: fileStatus, addedLines: [], content: null, skipped: UNRENDERED_DIFF });
      continue;
    }
    // The patch describes the file as git sees it; clamp to the lines the file on disk really has.
    const lineCount = allLineNumbers(read.content).length;
    const addedLines = (rendered?.added ?? []).filter((n) => n <= lineCount);
    files.push({ path: file, status: fileStatus, addedLines, content: read.content });
  }

  // What is committed is what ships: a file committed since the base whose working-tree
  // copy was then deleted or rewritten (and not committed again) is judged as committed, too.
  try {
    files.push(...await collectOtherVersions(cwd, base, quiet, patchFlags, 'committed'));
  } catch {
    // Never throws: the working-tree entries above stand on their own.
  }
  // And what is staged is what the next commit ships: content in the index that the working
  // tree no longer holds is judged from the index.
  try {
    const onDisk = new Set(files.filter((f) => f.origin === undefined).map((f) => f.path));
    for (const staged of await collectOtherVersions(cwd, base, quiet, patchFlags, 'staged')) {
      // A staged version that adds no line to a path the working tree still holds — a
      // `git mv` followed by an unstaged edit — has nothing in it the working-tree entry
      // does not already put before the rules.
      if (staged.content !== null && staged.addedLines.length === 0 && onDisk.has(staged.path)) { continue; }
      files.push(staged);
    }
  } catch {
    // Never throws.
  }

  const topLevel = (tree ?? '').split('\0').filter((f) => f.length > 0);
  const vendorRoots = recognisedVendorRoots(cwd, files.map((f) => f.path));
  return {
    baseRef: base, files, existingDirs, topLevel, goModulePath,
    nestedRepos: [...nestedRepos].filter((dir) => !isMoagOutput(dir)).sort(),
    submodules: [...submodules].filter((dir) => !isMoagOutput(dir)).sort(),
    vendorRoots,
    workspacePackages: readWorkspacePackages(cwd),
    importPathScopes: readImportPathScopes(cwd, files.map((f) => f.path)),
  };
}

/** Why a staged version is listed without its content. */
export const STAGED_NOT_READ = 'The staged version of this file differs from the working tree and could not be read';

/**
 * A version of the changed files that is NOT the one in the working tree, for every file
 * whose working-tree copy no longer matches it:
 *
 *   - `committed`: the version in HEAD. A file committed since `base` and then deleted, or
 *     changed again without a commit. Lines are those `base..HEAD` added.
 *   - `staged`: the version in the index. Content that was `git add`ed and then removed from
 *     — or rewritten in — the working tree. A working-tree diff never shows it, yet the next
 *     `git commit` ships it. Lines are those `base..index` added. A file whose index entry
 *     equals HEAD is left to the `committed` pass, so nothing is listed twice.
 *
 * Each comes back as its own entry carrying its `origin`. Renames are detected exactly as
 * for the working tree ({@link RENAME_FLAGS}): a legacy file that was `git mv`ed is
 * `renamed`, and a pure rename has no added line. Without that the moved file would come
 * back as `added`, with every legacy line in it judged as if this change had written it.
 *
 * Empty when there is nothing of the kind: no commit since the base, an index that matches
 * the working tree, and so on.
 */
async function collectOtherVersions(
  cwd: string, base: string, quiet: string[], patchFlags: string[], origin: 'committed' | 'staged',
): Promise<StandardsCheckFile[]> {
  const head = await runGit([...quiet, 'rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
  /** The tree the version lives in, as `git diff` and `git show` name it. */
  let against: string[];
  let show: (file: string) => string;
  let divergentArgs: string[];
  if (origin === 'committed') {
    if (!head || head === base) { return []; }
    against = [base, 'HEAD'];
    show = (file) => `HEAD:${file}`;
    // Working tree against HEAD.
    divergentArgs = ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'];
  } else {
    against = ['--cached', base];
    show = (file) => `:${file}`;
    // Working tree against the index.
    divergentArgs = ['diff', '--name-only', '--no-renames', '-z', '--'];
  }
  const dirty = await runGit([...quiet, ...divergentArgs], cwd);
  if (!dirty) { return []; }
  const divergent = new Set(dirty.split('\0').filter((f) => f.length > 0 && !isMoagOutput(f)));
  if (origin === 'staged' && head) {
    // An index entry that is simply what HEAD holds is the committed version: not staged work.
    const stagedOverHead = await runGit([...quiet, 'diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD', '--'], cwd);
    const staged = new Set((stagedOverHead ?? '').split('\0').filter((f) => f.length > 0));
    for (const file of [...divergent]) { if (!staged.has(file)) { divergent.delete(file); } }
  }
  if (divergent.size === 0) { return []; }
  const listed = await runGit([...quiet, 'diff', '--name-status', ...RENAME_FLAGS, '-z', ...against, '--'], cwd);
  if (!listed) { return []; }
  const notRead = origin === 'committed' ? COMMITTED_NOT_READ : STAGED_NOT_READ;

  const out: StandardsCheckFile[] = [];
  const names = parseNameStatus(listed);
  const wanted: Array<{ file: string; status: StandardsCheckFile['status'] }> = [];
  for (const [file, status] of names.changed) {
    if (divergent.has(file)) { wanted.push({ file, status }); }
  }
  wanted.sort((a, b) => a.file.localeCompare(b.file));
  const readable = wanted
    .filter((w) => !needsQuoting(w.file) && !needsQuoting(names.renamedFrom.get(w.file) ?? ''))
    .slice(0, MAX_COMMITTED_FILES);
  // A path filter is applied before renames are matched, so the old path of each rename has
  // to be named as well, or git would show the new path as a wholly new file.
  const pathspec = new Set<string>();
  for (const w of readable) {
    pathspec.add(w.file);
    const from = names.renamedFrom.get(w.file);
    if (from !== undefined) { pathspec.add(from); }
  }
  const patch = readable.length === 0 ? '' : await runGit(
    [...quiet, ...patchFlags, ...RENAME_FLAGS, ...against, '--', ...pathspec], cwd,
  );
  const rendered = parseRenderedDiff(patch ?? '');
  for (const w of wanted) {
    const unread = (skipped: string): StandardsCheckFile =>
      ({ path: w.file, status: w.status, addedLines: [], content: null, skipped, origin });
    if (!readable.includes(w)) { out.push(unread(notRead)); continue; }
    const content = await runGit([...quiet, 'show', show(w.file)], cwd, { raw: true });
    if (content === null || patch === null) { out.push(unread(notRead)); continue; }
    if (content.length > MAX_STANDARDS_FILE_BYTES) { out.push(unread('File is larger than 512 KB')); continue; }
    if (content.includes('\0')) { out.push(unread('Binary content')); continue; }
    const entry = rendered.get(w.file);
    if (names.pureRenames.has(w.file) && (!entry || entry.hunks === 0)) {
      // Every byte was matched to a file that existed at the base: nothing in it is new.
      out.push({ path: w.file, status: w.status, addedLines: [], content, origin });
      continue;
    }
    if ((!entry || entry.hunks === 0) && content.length > 0 && !entry?.modeOnly) { out.push(unread(UNRENDERED_DIFF)); continue; }
    const lineCount = allLineNumbers(content).length;
    out.push({
      path: w.file, status: w.status, addedLines: (entry?.added ?? []).filter((n) => n <= lineCount), content, origin,
    });
  }
  return out;
}

// ─── Internal text helpers ───

/** Keep the head of `text`, marking the cut. Result length never exceeds `maxChars`. */
function clampHead(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= TRUNCATION_MARKER.length) {
    return text.slice(0, maxChars);
  }
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Keep the tail of `text` (where failures print), marking the cut. */
function clampTail(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= OUTPUT_TRUNCATION_MARKER.length) {
    return text.slice(text.length - maxChars);
  }
  return OUTPUT_TRUNCATION_MARKER + text.slice(text.length - (maxChars - OUTPUT_TRUNCATION_MARKER.length));
}
