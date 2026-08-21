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
import * as fs from 'fs';
import * as path from 'path';
import { analyzeProject } from '../context/project-analyzer';
import { killProcess } from '../utils/process-kill';

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
}

/** Options for {@link runGate}. */
export interface GateOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  env?: Record<string, string>;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/** Options for {@link collectDiffEvidence}. */
export interface DiffOptions {
  maxDiffChars: number;
}

// ─── Process helpers ───


/** Run a git subcommand, resolving trimmed stdout on exit 0 and null on any failure. */
function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    proc.on('close', (code) => finish(code === 0 ? stdout.trim() : null));
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
      });
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
      sections.push(
        '- `' + g.command + '` — exit ' + g.exitCode +
        ` (${g.passed ? 'PASS' : 'FAIL'}${g.timedOut ? ', TIMED OUT' : ''}, ${g.durationMs}ms)`,
      );
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
