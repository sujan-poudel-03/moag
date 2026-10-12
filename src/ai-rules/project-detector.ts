import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { commentOnlyLineNumbers, languageFamily, lexFile } from '../standards/lexer';
import { MAX_DESIGN_DOC_CHARS, MAX_DESIGN_TOKENS_CHARS, allFallbackDesignPaths } from '../standards/design';

export interface DetectionResult {
  /** Human-readable signals shown in the notification, e.g. ["React", "TypeScript", "FastAPI"] */
  signals: string[];
  /** Built-in rule IDs that match the detected project */
  suggestedRuleIds: string[];
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function readFile(cwd: string, ...parts: string[]): string | null {
  try {
    return fs.readFileSync(path.join(cwd, ...parts), 'utf8');
  } catch {
    return null;
  }
}

function fileExists(cwd: string, ...parts: string[]): boolean {
  try { fs.accessSync(path.join(cwd, ...parts)); return true; } catch { return false; }
}

// ─── JavaScript / TypeScript ──────────────────────────────────────────────────

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function parsePackageJson(cwd: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as PackageJson;
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

// ─── Python ───────────────────────────────────────────────────────────────────

function parsePythonDeps(cwd: string): Set<string> {
  const deps = new Set<string>();

  // requirements.txt — strip version specifiers and extras
  const req = readFile(cwd, 'requirements.txt');
  if (req) {
    for (const line of req.split('\n')) {
      const clean = line.trim().replace(/^-[re]\s+\S+/, '').trim(); // skip -r / -e flags
      if (!clean || clean.startsWith('#')) { continue; }
      const name = clean.split(/[=<>!~\s\[;]/)[0].toLowerCase().replace(/-/g, '_');
      if (name) { deps.add(name); }
    }
  }

  // pyproject.toml — handles Poetry, PEP 621, PDM
  const pyproject = readFile(cwd, 'pyproject.toml');
  if (pyproject) {
    let inDepsSection = false;
    for (const line of pyproject.split('\n')) {
      const trimmed = line.trim();
      if (/^\[.*dependencies.*\]/i.test(trimmed)) { inDepsSection = true; continue; }
      if (trimmed.startsWith('[')) { inDepsSection = false; continue; }
      if (!inDepsSection) { continue; }
      // key = "value" style (Poetry)
      const kvMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*=/);
      if (kvMatch && kvMatch[1].toLowerCase() !== 'python') {
        deps.add(kvMatch[1].toLowerCase().replace(/-/g, '_'));
      }
      // "package>=version" list style (PEP 621)
      const listMatch = trimmed.match(/^["']([a-zA-Z][a-zA-Z0-9_-]+)/);
      if (listMatch) { deps.add(listMatch[1].toLowerCase().replace(/-/g, '_')); }
    }
  }

  // setup.py / setup.cfg — best-effort: look for known package names in the text
  const setupPy = readFile(cwd, 'setup.py') ?? readFile(cwd, 'setup.cfg') ?? '';
  const knownPyPkgs = ['flask', 'django', 'fastapi', 'sqlalchemy', 'pytest',
    'pydantic', 'celery', 'redis', 'uvicorn', 'starlette', 'aiohttp',
    'numpy', 'pandas', 'torch', 'tensorflow', 'sklearn', 'scikit_learn'];
  for (const pkg of knownPyPkgs) {
    if (setupPy.includes(pkg)) { deps.add(pkg); }
  }

  return deps;
}

// ─── Go ───────────────────────────────────────────────────────────────────────

const GO_PKG_SIGNALS: [RegExp, string][] = [
  [/gin-gonic\/gin/, 'Gin'],
  [/go-chi\/chi/, 'Chi'],
  [/gofiber\/fiber/, 'Fiber'],
  [/labstack\/echo/, 'Echo'],
  [/gorilla\/mux/, 'Gorilla Mux'],
  [/beego\/beego/, 'Beego'],
  [/gorm\.io\/gorm/, 'GORM'],
  [/go-gorm\/gorm/, 'GORM'],
  [/jackc\/pgx/, 'PostgreSQL (pgx)'],
  [/go-sql-driver\/mysql/, 'MySQL'],
  [/mongo-driver/, 'MongoDB'],
  [/redis\/go-redis/, 'Redis'],
  [/google\.golang\.org\/grpc|grpc-go/, 'gRPC'],
  [/stretchr\/testify/, 'Testify'],
  [/aws\/aws-sdk-go/, 'AWS SDK'],
  [/golang\.org\/x\/crypto/, 'Go Crypto'],
];

function parseGoMod(cwd: string): string[] {
  const content = readFile(cwd, 'go.mod');
  if (!content) { return []; }
  const detected: string[] = [];
  for (const [pattern, label] of GO_PKG_SIGNALS) {
    if (pattern.test(content)) { detected.push(label); }
  }
  return detected;
}

// ─── Rust ─────────────────────────────────────────────────────────────────────

const RUST_PKG_SIGNALS: [string, string][] = [
  ['tokio', 'Tokio (async)'],
  ['axum', 'Axum'],
  ['actix-web', 'Actix Web'],
  ['warp', 'Warp'],
  ['rocket', 'Rocket'],
  ['serde', 'Serde'],
  ['diesel', 'Diesel'],
  ['sqlx', 'SQLx'],
  ['sea-orm', 'SeaORM'],
  ['reqwest', 'Reqwest'],
  ['tonic', 'gRPC (Tonic)'],
  ['redis', 'Redis'],
];

function parseCargoToml(cwd: string): string[] {
  const content = readFile(cwd, 'Cargo.toml');
  if (!content) { return []; }
  const detected: string[] = [];
  for (const [pkg, label] of RUST_PKG_SIGNALS) {
    // Match `pkg = ...` at start of line in any [*dependencies*] section
    if (new RegExp(`^${pkg.replace(/-/g, '[_-]')}\\s*=`, 'm').test(content)) {
      detected.push(label);
    }
  }
  return detected;
}

// ─── Java ─────────────────────────────────────────────────────────────────────

const JAVA_ARTIFACT_SIGNALS: [RegExp, string][] = [
  [/spring-boot-starter-web/, 'Spring Boot'],
  [/spring-boot-starter-security/, 'Spring Security'],
  [/spring-boot-starter-data-jpa|hibernate/, 'Spring Data JPA'],
  [/spring-boot-starter-data-redis/, 'Redis'],
  [/micronaut/, 'Micronaut'],
  [/quarkus/, 'Quarkus'],
  [/junit-jupiter|junit:junit/, 'JUnit'],
  [/mockito/, 'Mockito'],
  [/kafka/, 'Kafka'],
  [/postgresql|mysql-connector/, 'Database'],
];

function parseJavaDeps(cwd: string): string[] {
  const pom = readFile(cwd, 'pom.xml') ?? '';
  const gradle = readFile(cwd, 'build.gradle') ?? readFile(cwd, 'build.gradle.kts') ?? '';
  const combined = pom + '\n' + gradle;
  if (!combined.trim()) { return []; }
  const detected: string[] = [];
  for (const [pattern, label] of JAVA_ARTIFACT_SIGNALS) {
    if (pattern.test(combined) && !detected.includes(label)) { detected.push(label); }
  }
  return detected;
}

// ─── Python signal mapping ────────────────────────────────────────────────────

const PYTHON_PKG_SIGNALS: [string, string][] = [
  ['fastapi', 'FastAPI'],
  ['django', 'Django'],
  ['flask', 'Flask'],
  ['starlette', 'Starlette'],
  ['aiohttp', 'aiohttp'],
  ['tornado', 'Tornado'],
  ['sqlalchemy', 'SQLAlchemy'],
  ['alembic', 'Alembic'],
  ['pymongo', 'MongoDB'],
  ['redis', 'Redis'],
  ['celery', 'Celery'],
  ['pydantic', 'Pydantic'],
  ['pytest', 'pytest'],
  ['numpy', 'NumPy'],
  ['pandas', 'Pandas'],
  ['torch', 'PyTorch'],
  ['tensorflow', 'TensorFlow'],
  ['sklearn', 'scikit-learn'],
  ['scikit_learn', 'scikit-learn'],
  ['boto3', 'AWS SDK'],
  ['grpcio', 'gRPC'],
  ['uvicorn', 'Uvicorn'],
];

// ─── Main detector ────────────────────────────────────────────────────────────

/**
 * Analyzes the workspace root and returns detected project signals
 * alongside the built-in rule IDs best suited to the project.
 *
 * Detection is lightweight — file reads only, no spawning (this function; convention
 * detection below makes one bounded git query).
 * Covers JS/TS, Python, Go, Rust, and Java ecosystems.
 */
export function detectProjectRules(cwd: string): DetectionResult {
  const signals: string[] = [];
  const ruleIds = new Set<string>();

  // ── JavaScript / TypeScript ─────────────────────────────────────────────
  const jsDeps = parsePackageJson(cwd);
  const scripts = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as PackageJson;
      return Object.values(pkg.scripts ?? {}).join(' ').toLowerCase();
    } catch { return ''; }
  })();

  const isTypeScript = jsDeps.has('typescript') || jsDeps.has('ts-node') || fileExists(cwd, 'tsconfig.json');
  const isReact   = jsDeps.has('react') || jsDeps.has('react-dom');
  const isVue     = jsDeps.has('vue');
  const isAngular = jsDeps.has('@angular/core');
  const isNext    = jsDeps.has('next');
  const isSvelte  = jsDeps.has('svelte');
  const isNodeBackend = jsDeps.has('express') || jsDeps.has('fastify')
    || jsDeps.has('koa') || jsDeps.has('hono') || jsDeps.has('@nestjs/core');
  const hasJsDb = jsDeps.has('prisma') || jsDeps.has('@prisma/client')
    || jsDeps.has('mongoose') || jsDeps.has('typeorm')
    || jsDeps.has('sequelize') || jsDeps.has('drizzle-orm')
    || jsDeps.has('pg') || jsDeps.has('mysql2') || jsDeps.has('sqlite3');
  const hasJsTesting = jsDeps.has('vitest') || jsDeps.has('jest') || jsDeps.has('mocha')
    || fileExists(cwd, 'vitest.config.ts') || fileExists(cwd, 'jest.config.ts')
    || fileExists(cwd, 'jest.config.js') || scripts.includes('test');

  if (isTypeScript) { signals.push('TypeScript'); }
  if (isNext)       { signals.push('Next.js'); }
  else if (isReact) { signals.push('React'); }
  if (isVue)        { signals.push('Vue'); }
  if (isAngular)    { signals.push('Angular'); }
  if (isSvelte)     { signals.push('Svelte'); }
  if (isNodeBackend) {
    const name = jsDeps.has('@nestjs/core') ? 'NestJS'
      : jsDeps.has('fastify') ? 'Fastify'
      : jsDeps.has('hono') ? 'Hono'
      : jsDeps.has('koa') ? 'Koa'
      : 'Express';
    signals.push(name);
  }
  if (hasJsDb) { signals.push('Database'); }
  if (hasJsTesting) {
    signals.push(jsDeps.has('vitest') ? 'Vitest' : jsDeps.has('jest') ? 'Jest' : 'Mocha');
  }

  // ── Python ──────────────────────────────────────────────────────────────
  const isPython = fileExists(cwd, 'pyproject.toml') || fileExists(cwd, 'requirements.txt')
    || fileExists(cwd, 'setup.py');
  const pyDeps = isPython ? parsePythonDeps(cwd) : new Set<string>();

  if (isPython) { signals.push('Python'); }

  const pySignals: string[] = [];
  for (const [pkg, label] of PYTHON_PKG_SIGNALS) {
    if (pyDeps.has(pkg) && !pySignals.includes(label)) { pySignals.push(label); }
  }
  signals.push(...pySignals.slice(0, 4)); // cap at 4 python signals

  const isPyWeb = pyDeps.has('fastapi') || pyDeps.has('django') || pyDeps.has('flask')
    || pyDeps.has('starlette') || pyDeps.has('aiohttp');
  const isPyDb  = pyDeps.has('sqlalchemy') || pyDeps.has('pymongo') || pyDeps.has('redis');
  const isPyDs  = pyDeps.has('numpy') || pyDeps.has('pandas') || pyDeps.has('torch')
    || pyDeps.has('tensorflow') || pyDeps.has('sklearn') || pyDeps.has('scikit_learn');
  const hasPyTest = pyDeps.has('pytest');

  // ── Go ──────────────────────────────────────────────────────────────────
  const isGo = fileExists(cwd, 'go.mod');
  const goSignals = isGo ? parseGoMod(cwd) : [];
  if (isGo) { signals.push('Go'); }
  signals.push(...goSignals.slice(0, 3));

  const isGoWeb = goSignals.some(s => ['Gin', 'Chi', 'Fiber', 'Echo', 'Gorilla Mux', 'Beego'].includes(s));
  const isGoDb  = goSignals.some(s => ['GORM', 'PostgreSQL (pgx)', 'MySQL', 'MongoDB'].includes(s));

  // ── Rust ────────────────────────────────────────────────────────────────
  const isRust = fileExists(cwd, 'Cargo.toml');
  const rustSignals = isRust ? parseCargoToml(cwd) : [];
  if (isRust) { signals.push('Rust'); }
  signals.push(...rustSignals.slice(0, 3));

  const isRustWeb   = rustSignals.some(s => ['Axum', 'Actix Web', 'Warp', 'Rocket'].includes(s));
  const isRustAsync = rustSignals.includes('Tokio (async)');

  // ── Java ─────────────────────────────────────────────────────────────────
  const isJava = fileExists(cwd, 'pom.xml') || fileExists(cwd, 'build.gradle')
    || fileExists(cwd, 'build.gradle.kts');
  const javaSignals = isJava ? parseJavaDeps(cwd) : [];
  if (isJava) { signals.push('Java'); }
  signals.push(...javaSignals.slice(0, 3));

  const hasJavaTest = javaSignals.includes('JUnit');
  const isJavaWeb   = javaSignals.some(s => ['Spring Boot', 'Micronaut', 'Quarkus'].includes(s));

  // ── Rule assignment ──────────────────────────────────────────────────────

  const isAnyBackend = isNodeBackend || isPyWeb || isGoWeb || isRustWeb || isJavaWeb || isNext;
  const isAnyDb      = hasJsDb || isPyDb || isGoDb;
  const isAnyOOP     = isReact || isVue || isAngular || isNext || isSvelte || isTypeScript || isJava;
  const isAnyTesting = hasJsTesting || hasPyTest || hasJavaTest
    || goSignals.includes('Testify');

  // SOLID — OOP / component-based projects
  if (isAnyOOP || isJava) { ruleIds.add('builtin-solid'); }

  // Clean Code — universal
  ruleIds.add('builtin-clean-code');

  // Self-Documenting — statically typed languages benefit most
  if (isTypeScript || isJava || isGo || isRust) { ruleIds.add('builtin-self-documenting'); }

  // TDD — only when a test framework is present
  if (isAnyTesting) { ruleIds.add('builtin-tdd'); }

  // OWASP — any web backend or database access
  if (isAnyBackend || isAnyDb) { ruleIds.add('builtin-owasp'); }

  // Error Handling — explicit error cultures (Go, Rust) and backends
  if (isAnyBackend || isGo || isRust || isRustAsync) { ruleIds.add('builtin-error-handling'); }

  // Performance — backends, databases, data science, async Rust
  if (isAnyBackend || isAnyDb || isPyDs || isRustAsync) { ruleIds.add('builtin-perf'); }

  // DRY — any non-trivial project
  if (isPython || isGo || isRust || isJava || jsDeps.size > 3) { ruleIds.add('builtin-dry'); }

  return {
    signals: [...new Set(signals)], // deduplicate
    suggestedRuleIds: [...ruleIds],
  };
}

// ─── Convention detection (project standards) ────────────────────────────────
//
// Everything below reads files as DATA and reports what it found together with
// the file that proved it. It follows no symlink and bounds every read, so
// pointing it at a hostile repository costs a bounded amount of I/O and yields
// only tagged, reviewable observations. The one process it starts is a bounded,
// read-only `git ls-files` (see `readTrackedFiles`): what is on disk is not what
// the repository holds, and only git can say which files it tracks.

/** A detected value and the repository-relative file that proved it. */
export interface Detected<T> {
  value: T;
  evidence: string;
}

/** A lint or format configuration file, and the tool it configures. */
export interface DetectedConfig {
  tool: string;
  file: string;
}

/** What the repository looks like it is built with. `rust` has no hosted stack profile. */
export type StackGuess = 'node-ts' | 'python' | 'go' | 'java' | 'dotnet' | 'static-web' | 'rust';

export interface ConventionDetection {
  stack: Detected<StackGuess> | null;
  framework: Detected<string> | null;
  /** Top-level entries, without build output and tool caches. */
  topLevel: string[];
  /** Top-level directories that hold non-test source files. */
  sourceDirs: Detected<string[]> | null;
  /** Outermost directories named like a test folder that hold source files. */
  testDirs: Detected<string[]> | null;
  /**
   * The top-level directories that hold a file git tracks, or null (or absent) when git's
   * listing could not be had: not a repository root, git missing or refusing.
   *
   * A directory on disk is not a directory of the repository — build output, reports and
   * anything `.gitignore` names are on disk too. Only a directory listed here is known to
   * exist in a clean clone, so only such a directory is ever proposed.
   */
  trackedTopLevelDirs?: string[] | null;
  /**
   * Why `trackedTopLevelDirs` is null, in words a reviewer can act on ("git refuses this
   * workspace …"). Absent when the listing was had. A proposal quotes it in its provenance.
   */
  trackedUnavailable?: string;
  lintConfigs: DetectedConfig[];
  formatConfigs: DetectedConfig[];
  testRunner: Detected<string> | null;
  componentLibrary: Detected<string> | null;
  /**
   * package.json script NAMES only — never their bodies. A script whose body runs nothing
   * (empty, or the `npm init` test placeholder) is left out.
   */
  scripts: Detected<string[]> | null;
  /** Source files found, counted up to the walk limit. Zero means greenfield. */
  sourceFileCount: number;
  /** One source file, as proof that the repository is not empty. */
  sampleSourceFile: string | null;
  /**
   * The first source files the walk found (shallowest first), bounded. A proposal
   * measures the repository's file-naming style over these names.
   */
  sourceFileSample: string[];
  /** Share of lines that are commentary, over a bounded sample of lexable files. */
  commentDensity: { pct: number; filesSampled: number; evidence: string } | null;
  /** Built-in rule IDs from {@link detectProjectRules}. */
  suggestedRuleIds: string[];
  /**
   * An existing design system the repository already has: a tokens or theme file, a design
   * document, and whether it serves pages (index.html). Absent when none of them was found.
   */
  designSources?: DesignSources;
  /** A changelog git tracks at the root (CHANGELOG.md, CHANGELOG, HISTORY.md). Tracked files only. */
  changelog?: Detected<string>;
  /** The first migrations directory git tracks a file under (prisma/migrations, alembic/versions, …). */
  migrationsDir?: Detected<string>;
  /** A tracked `.env.example`: the project documents its environment without committing it. */
  envExample?: Detected<string>;
  /** A tracked commit-message convention config (commitlint, commitizen). */
  commitConvention?: Detected<string>;
  /**
   * Type checkers and audit tools a file in the repository itself declares — a config file,
   * a dependency, a pre-commit hook, a go.mod `tool` directive, a build plugin — each with
   * the file that declares it (see {@link detectDeclaredTools}). Never inferred from the stack
   * alone. Absent when none is declared.
   */
  declaredTools?: DetectedConfig[];
}

/**
 * The tool ids {@link ConventionDetection.declaredTools} can hold. `govulncheck-tool` is a
 * go.mod `tool` directive (`go tool govulncheck`), `govulncheck-run` a tools.go import pinned
 * by go.mod (`go run`); `mvnw` and `gradlew` are tracked wrappers a Java command goes through.
 */
export const DECLARED_TOOL_IDS = [
  'mypy', 'pyright', 'pip-audit', 'govulncheck-tool', 'govulncheck-run', 'dependency-check-maven', 'dependency-check-gradle',
  'mvnw', 'gradlew',
] as const;

const GOVULNCHECK = 'golang.org/x/vuln/cmd/govulncheck';

/**
 * The type checkers and audit tools the repository declares, from the files `present` admits
 * (tracked ones, when git's listing is known) and `read` reads (capped):
 * - mypy: `mypy.ini`, `.mypy.ini`, `[tool.mypy]` in pyproject.toml, `[mypy]` in setup.cfg;
 * - pyright: `pyrightconfig.json`, `[tool.pyright]` in pyproject.toml;
 * - pip-audit: a `pip-audit` dependency (a requirements file line, a quoted entry or a Poetry
 *   key in pyproject.toml, a Pipfile key) or a `pip-audit` pre-commit hook;
 * - govulncheck: a go.mod `tool` directive for it, or a tracked tools.go that imports it;
 * - OWASP dependency-check: its Maven plugin in pom.xml, or its Gradle plugin id.
 * A mention anywhere else — a comment, a README — declares nothing.
 */
export function detectDeclaredTools(present: (name: string) => boolean, read: (name: string) => string | null): DetectedConfig[] {
  const out: DetectedConfig[] = [];
  const text = (name: string): string => (present(name) ? read(name) ?? '' : '');
  const add = (tool: typeof DECLARED_TOOL_IDS[number], file: string): void => {
    if (!out.some((d) => d.tool === tool)) { out.push({ tool, file }); }
  };
  const pyproject = text('pyproject.toml');
  const setupCfg = text('setup.cfg');
  for (const file of ['mypy.ini', '.mypy.ini']) { if (present(file)) { add('mypy', file); } }
  if (/^\[tool\.mypy\]/m.test(pyproject)) { add('mypy', 'pyproject.toml'); }
  if (/^\[mypy\]/m.test(setupCfg)) { add('mypy', 'setup.cfg'); }
  if (present('pyrightconfig.json')) { add('pyright', 'pyrightconfig.json'); }
  if (/^\[tool\.pyright\]/m.test(pyproject)) { add('pyright', 'pyproject.toml'); }
  for (const file of ['requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt', 'requirements_dev.txt']) {
    if (/^\s*pip[-_]audit\b/im.test(text(file))) { add('pip-audit', file); }
  }
  if (/["']pip[-_]audit\b/i.test(pyproject) || /^\s*pip[-_]audit\s*=/im.test(pyproject)) { add('pip-audit', 'pyproject.toml'); }
  if (/^\s*pip[-_]audit\s*=/im.test(text('Pipfile'))) { add('pip-audit', 'Pipfile'); }
  if (/^\s*-?\s*id:\s*pip-audit\s*$/m.test(text('.pre-commit-config.yaml'))) { add('pip-audit', '.pre-commit-config.yaml'); }

  const goMod = text('go.mod');
  const toolBlock = /^tool\s*\(([^)]*)\)/m.exec(goMod);
  const toolLines = [
    ...[...goMod.matchAll(/^tool\s+(\S+)\s*$/gm)].map((m) => m[1]),
    ...(toolBlock ? toolBlock[1].split('\n').map((l) => l.trim()) : []),
  ];
  if (toolLines.includes(GOVULNCHECK)) { add('govulncheck-tool', 'go.mod'); }
  if (goMod !== '' && new RegExp(`^\\s*_\\s+"${GOVULNCHECK.replace(/[./]/g, '\\$&')}"`, 'm').test(text('tools.go'))) {
    add('govulncheck-run', 'tools.go');
  }

  if (/<artifactId>\s*dependency-check-maven\s*<\/artifactId>/.test(text('pom.xml'))) { add('dependency-check-maven', 'pom.xml'); }
  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const gradle = text(file);
    if (/\bid\s*\(?\s*["']org\.owasp\.dependencycheck["']/.test(gradle) || /apply\s+plugin:\s*["']org\.owasp\.dependencycheck["']/.test(gradle)) {
      add('dependency-check-gradle', file);
    }
  }
  if (present('mvnw')) { add('mvnw', 'mvnw'); }
  if (present('gradlew')) { add('gradlew', 'gradlew'); }
  return out;
}

/** Root-level changelogs, in preference order. */
const CHANGELOG_FILES = ['CHANGELOG.md', 'CHANGELOG', 'HISTORY.md'];
/** Where each common migration tool keeps its migrations, in preference order. */
const MIGRATION_DIRS = ['prisma/migrations', 'alembic/versions', 'db/migrate', 'src/main/resources/db/migration', 'Migrations'];
/** Commit-message convention configs at the root. */
const COMMIT_CONVENTION_FILE = /^(?:commitlint\.config\.[cm]?[jt]s|\.commitlintrc(?:\.(?:json|ya?ml|[cm]?js|ts))?|\.czrc)$/;

const MAX_WALK_DEPTH = 8;
const MAX_WALK_ENTRIES = 20_000;
const MAX_SOURCE_FILES = 5_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DENSITY_SAMPLE_FILES = 200;
const MAX_DENSITY_FILE_BYTES = 256 * 1024;
const MAX_NAME_SAMPLE_FILES = 1_000;
/** Hard ceiling on each git query detection makes, and on what it may print. */
const GIT_TRACKED_TIMEOUT_MS = 10_000;
const MAX_GIT_TRACKED_BYTES = 32 * 1024 * 1024;

/** Build output, dependency trees and tool caches: never walked, never part of the layout. */
const NOISE_ENTRIES = new Set([
  'node_modules', '.git', '.moag', 'dist', 'out', 'build', 'target', 'coverage', 'vendor', 'obj',
  '.venv', 'venv', '__pycache__', '.next', '.idea', '.DS_Store', 'Thumbs.db',
]);

const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'java', 'cs', 'rs', 'rb', 'php', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'html', 'css', 'scss', 'vue', 'svelte',
]);

const STACK_EXTENSIONS: Record<Exclude<StackGuess, 'static-web'>, string[]> = {
  'node-ts': ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  'python': ['py'],
  'go': ['go'],
  'java': ['java'],
  'dotnet': ['cs'],
  'rust': ['rs'],
};

const LINT_CONFIG_FILES: Array<[string, string]> = [
  ['.eslintrc', 'eslint'], ['.eslintrc.json', 'eslint'], ['.eslintrc.js', 'eslint'], ['.eslintrc.cjs', 'eslint'],
  ['.eslintrc.yml', 'eslint'], ['.eslintrc.yaml', 'eslint'], ['eslint.config.js', 'eslint'],
  ['eslint.config.mjs', 'eslint'], ['eslint.config.cjs', 'eslint'], ['eslint.config.ts', 'eslint'],
  ['biome.json', 'biome'], ['biome.jsonc', 'biome'],
  ['ruff.toml', 'ruff'], ['.ruff.toml', 'ruff'], ['.flake8', 'flake8'], ['.pylintrc', 'pylint'],
  ['.golangci.yml', 'golangci-lint'], ['.golangci.yaml', 'golangci-lint'], ['.golangci.toml', 'golangci-lint'],
  ['checkstyle.xml', 'checkstyle'], ['.stylelintrc', 'stylelint'], ['.stylelintrc.json', 'stylelint'],
];

const FORMAT_CONFIG_FILES: Array<[string, string]> = [
  ['.prettierrc', 'prettier'], ['.prettierrc.json', 'prettier'], ['.prettierrc.js', 'prettier'],
  ['.prettierrc.cjs', 'prettier'], ['.prettierrc.yml', 'prettier'], ['.prettierrc.yaml', 'prettier'],
  ['prettier.config.js', 'prettier'], ['prettier.config.cjs', 'prettier'], ['prettier.config.mjs', 'prettier'],
  ['biome.json', 'biome'], ['biome.jsonc', 'biome'],
  ['.editorconfig', 'editorconfig'], ['rustfmt.toml', 'rustfmt'], ['.clang-format', 'clang-format'],
];

const NODE_FRAMEWORKS: Array<[string, string]> = [
  ['next', 'Next.js'], ['@nestjs/core', 'NestJS'], ['@angular/core', 'Angular'], ['vue', 'Vue'],
  ['svelte', 'Svelte'], ['react', 'React'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['koa', 'Koa'],
  ['express', 'Express'],
];

const COMPONENT_LIBRARIES: Array<[string, string]> = [
  ['@mui/material', 'MUI'], ['antd', 'Ant Design'], ['@chakra-ui/react', 'Chakra UI'],
  ['@mantine/core', 'Mantine'], ['@radix-ui/themes', 'Radix UI'], ['@headlessui/react', 'Headless UI'],
  ['vuetify', 'Vuetify'], ['react-bootstrap', 'React Bootstrap'], ['bootstrap', 'Bootstrap'],
  ['tailwindcss', 'Tailwind CSS'],
];

const PYTHON_FRAMEWORKS: Array<[string, string]> = [
  ['fastapi', 'FastAPI'], ['django', 'Django'], ['flask', 'Flask'], ['starlette', 'Starlette'], ['aiohttp', 'aiohttp'],
];

const MANIFEST_FILES = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
];

/** A script name plain enough to report. */
const SAFE_SCRIPT_NAME = /^[\w:.-]{1,40}$/;

/** The `test` body `npm init` writes: a script that proves there is no test. */
const NPM_INIT_TEST_PLACEHOLDER = /^echo\s+["']?Error: no test specified["']?\s*&&\s*exit\s+1$/i;

/**
 * True when a package.json script body runs something: a non-empty string that is not the
 * `npm init` test placeholder. The body is only tested here, never reported or copied.
 */
function isRealScriptBody(body: unknown): boolean {
  if (typeof body !== 'string') { return false; }
  const trimmed = body.trim();
  return trimmed.length > 0 && !NPM_INIT_TEST_PLACEHOLDER.test(trimmed);
}

function emptyDetection(): ConventionDetection {
  return {
    stack: null, framework: null, topLevel: [], sourceDirs: null, testDirs: null,
    lintConfigs: [], formatConfigs: [], testRunner: null, componentLibrary: null, scripts: null,
    sourceFileCount: 0, sampleSourceFile: null, sourceFileSample: [], commentDensity: null, suggestedRuleIds: [],
    trackedTopLevelDirs: null, trackedUnavailable: NOT_CONSULTED,
  };
}

/** Read a file only when it is a regular file of at most `maxBytes`. */
function readCapped(cwd: string, rel: string, maxBytes: number): string | null {
  try {
    const full = path.join(cwd, ...rel.split('/'));
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > maxBytes) { return null; }
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

// ─── Design sources ───

/** What {@link detectDesignSources} found. */
export interface DesignSources {
  tokens: { path: string; content: string } | null;
  doc: { path: string; content: string } | null;
  ui: { value: string; evidence: string } | null;
  /**
   * Candidate and fallback design paths that exist on disk but were not adopted, each with
   * why. A proposal never targets one of them, so nothing there is ever overwritten. Absent
   * when there is none.
   */
  notAdopted?: Array<{ path: string; reason: string; content?: string }>;
}

/** Where a repository keeps its design tokens or theme, most specific first. */
const DESIGN_TOKEN_CANDIDATES = [
  'src/styles/tokens.css', 'src/styles/theme.css', 'src/styles/variables.css', 'src/theme.css', 'src/tokens.css',
  'styles/tokens.css', 'css/tokens.css', 'css/variables.css', 'css/theme.css',
  'tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs',
  'src/theme/tokens.ts', 'src/theme/index.ts', 'src/theme.ts', 'src/tokens.ts',
];
/** Where a repository keeps its design document. */
const DESIGN_DOC_CANDIDATES = ['docs/design/DESIGN.md', 'DESIGN.md', 'docs/DESIGN.md', 'docs/design-system.md', 'design/DESIGN.md'];
/**
 * A stylesheet that declares custom properties on `:root` — alone or in a selector list such
 * as `:root, [data-theme="light"] {` — a tokens file, not just any CSS.
 */
const ROOT_CUSTOM_PROPERTIES = /:root\b[^{};]*\{[^}]*--[\w-]+\s*:/;

/** True when something (file, directory or link) is at `rel`, whether or not git tracks it. */
function anythingAt(cwd: string, rel: string): boolean {
  try { fs.lstatSync(path.join(cwd, ...rel.split('/'))); return true; } catch { return false; }
}

/** The candidate at `rel` as text within `cap`, or why it could not be read. */
function readDesignCandidate(cwd: string, rel: string, cap: number): { content: string } | { problem: string } {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(path.join(cwd, ...rel.split('/'))); } catch { return { problem: 'could not be read' }; }
  if (!stat.isFile()) { return { problem: 'not a regular file' }; }
  if (stat.size > cap) { return { problem: `larger than ${cap} characters` }; }
  const content = readCapped(cwd, rel, cap);
  if (content === null) { return { problem: 'could not be read' }; }
  if (content.length > cap) { return { problem: `larger than ${cap} characters` }; }
  return { content };
}

/**
 * Adopt the candidate at `rel` into `found`, or list it in `notAdopted` with why — and with its
 * content when it was readable, so a proposal can tell MOAG's own earlier write from a user's file.
 */
function considerDesignCandidate(
  cwd: string, rel: string, cap: number, tracked: boolean, isTokens: boolean,
  notAdopted: NonNullable<DesignSources['notAdopted']>,
): { path: string; content: string } | null {
  const read = readDesignCandidate(cwd, rel, cap);
  const content = 'content' in read ? read.content : null;
  const problem = 'problem' in read ? read.problem
    : !tracked ? 'not tracked by git'
      : isTokens && rel.endsWith('.css') && !ROOT_CUSTOM_PROPERTIES.test(read.content) ? 'declares no :root custom properties'
        : null;
  if (problem === null) { return { path: rel, content: content as string }; }
  notAdopted.push({ path: rel, reason: problem, ...(content !== null ? { content } : {}) });
  return null;
}

/**
 * The design system a repository already has, from a fixed list of places: the first tokens
 * or theme file (a CSS one only when it declares `:root` custom properties), the first design
 * document, and whether it serves an `index.html`. Each file is read only when it is a regular
 * file within the design caps. `present` decides what counts (a caller limits it to tracked
 * files). Every candidate or fallback path that exists on disk but is not adopted is listed in
 * `notAdopted` with why, so a proposal never targets it. Never throws.
 */
export function detectDesignSources(cwd: string, present: (rel: string) => boolean = (rel) => fileExists(cwd, rel)): DesignSources {
  const out: DesignSources = { tokens: null, doc: null, ui: null };
  const notAdopted: Array<{ path: string; reason: string }> = [];
  try {
    for (const rel of DESIGN_TOKEN_CANDIDATES) {
      if (!anythingAt(cwd, rel)) { continue; }
      if (out.tokens) { notAdopted.push({ path: rel, reason: `${out.tokens.path} was adopted instead` }); continue; }
      out.tokens = considerDesignCandidate(cwd, rel, MAX_DESIGN_TOKENS_CHARS, present(rel), true, notAdopted);
    }
    for (const rel of DESIGN_DOC_CANDIDATES) {
      if (!anythingAt(cwd, rel)) { continue; }
      if (out.doc) { notAdopted.push({ path: rel, reason: `${out.doc.path} was adopted instead` }); continue; }
      out.doc = considerDesignCandidate(cwd, rel, MAX_DESIGN_DOC_CHARS, present(rel), false, notAdopted);
    }
    for (const rel of allFallbackDesignPaths()) {
      if (!anythingAt(cwd, rel) || notAdopted.some((n) => n.path === rel)) { continue; }
      const read = readDesignCandidate(cwd, rel, rel.endsWith('.md') ? MAX_DESIGN_DOC_CHARS : MAX_DESIGN_TOKENS_CHARS);
      notAdopted.push({ path: rel, reason: 'already exists', ...('content' in read ? { content: read.content } : {}) });
    }
    if (present('index.html')) { out.ui = { value: 'index.html', evidence: 'index.html' }; }
  } catch {
    return { tokens: null, doc: null, ui: null };
  }
  return notAdopted.length > 0 ? { ...out, notAdopted } : out;
}

/**
 * The UI framework and component library a workspace's package.json names, from a bounded
 * read of that one file. For a cheap "does this project have a user interface?" probe;
 * nothing is walked and git is not asked. Never throws.
 */
export function detectUiPackages(cwd: string): { framework: Detected<string> | null; componentLibrary: Detected<string> | null; packages: string[] } {
  const none = { framework: null, componentLibrary: null, packages: [] as string[] };
  try {
    const text = readCapped(cwd, 'package.json', MAX_MANIFEST_BYTES);
    if (text === null) { return none; }
    const pkg: unknown = JSON.parse(text);
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) { return none; }
    const rec = pkg as Record<string, unknown>;
    const keys = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : []);
    const deps = new Set([...keys(rec.dependencies), ...keys(rec.devDependencies)]);
    const framework = NODE_FRAMEWORKS.find(([dep]) => deps.has(dep));
    const library = COMPONENT_LIBRARIES.find(([dep]) => deps.has(dep));
    return {
      framework: framework ? { value: framework[1], evidence: 'package.json' } : null,
      componentLibrary: library ? { value: library[1], evidence: 'package.json' } : null,
      packages: [framework?.[0], library?.[0]].filter((x): x is string => !!x),
    };
  } catch {
    return none;
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

interface WalkResult {
  /** Repository-relative, `/`-separated source files in a stable order. */
  sourceFiles: string[];
  /** `.sln` and `.csproj` files, shallowest first. */
  dotnetMarkers: string[];
}

/** Bounded, symlink-free, breadth-first listing of the repository's source files. */
function walkRepo(cwd: string): WalkResult {
  const sourceFiles: string[] = [];
  const dotnetMarkers: string[] = [];
  let visited = 0;
  let level: string[] = [''];
  for (let depth = 0; depth <= MAX_WALK_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(cwd, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (++visited > MAX_WALK_ENTRIES) { return { sourceFiles, dotnetMarkers }; }
        if (entry.isSymbolicLink() || NOISE_ENTRIES.has(entry.name)) { continue; }
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) { next.push(child); }
        } else if (entry.isFile()) {
          const ext = extensionOf(entry.name);
          if (ext === 'sln' || ext === 'csproj') { dotnetMarkers.push(child); }
          // Tool configuration (vite.config.ts, jest.config.js) is not the project's own source.
          if (SOURCE_EXTENSIONS.has(ext) && !/\.config\.[cm]?[jt]s$/.test(entry.name) && sourceFiles.length < MAX_SOURCE_FILES) {
            sourceFiles.push(child);
          }
        }
      }
    }
    level = next;
  }
  return { sourceFiles, dotnetMarkers };
}

/** The outermost test-named directory on a file's path, or null. */
function testDirOf(file: string): string | null {
  const segments = file.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (TEST_DIR_NAMES.has(segments[i])) { return segments.slice(0, i + 1).join('/'); }
  }
  return null;
}

// ─── What git tracks ───

/** Git's listing of the files it tracks in a workspace, or why there is none. */
export type TrackedFiles =
  | { ok: true; /** Repository-relative, `/`-separated. */ files: string[] }
  | { ok: false; /** In words a reviewer can act on; quoted in a proposal's provenance. */ reason: string };

/** Why a detection made without asking git has no listing. */
const NOT_CONSULTED = 'git was not asked which files it tracks';

/** The variables git needs to find itself and the user's own configuration, and nothing else. */
const GIT_ENV_KEEP = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'XDG_CONFIG_HOME',
]);

/**
 * A minimal environment for a read-only git query. Nothing the server process inherited can
 * point git somewhere else: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and every other
 * `GIT_*` variable are left out, so git answers for the directory it is run in.
 */
export function minimalGitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && GIT_ENV_KEEP.has(name.toUpperCase())) { env[name] = value; }
  }
  // Never wait for a person, never take a lock, and answer in one language.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

/** One finished git query: its output on exit 0, else what it wrote to stderr and how it failed. */
type GitAnswer = { ok: true; stdout: string } | { ok: false; code: string; stderr: string };

/** Run one read-only git query asynchronously, bounded in time and output. Never rejects. */
function gitQuery(cwd: string, args: string[]): Promise<GitAnswer> {
  return new Promise((resolve) => {
    try {
      execFile('git', ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], {
        cwd, encoding: 'utf8', timeout: GIT_TRACKED_TIMEOUT_MS, maxBuffer: MAX_GIT_TRACKED_BYTES,
        windowsHide: true, env: minimalGitEnv(),
      }, (err, stdout, stderr) => {
        if (!err) { resolve({ ok: true, stdout: String(stdout) }); return; }
        const failure = err as NodeJS.ErrnoException & { killed?: boolean };
        const code = failure.killed ? 'TIMEOUT' : typeof failure.code === 'string' ? failure.code : 'EXIT';
        resolve({ ok: false, code, stderr: String(stderr ?? '') });
      });
    } catch {
      resolve({ ok: false, code: 'SPAWN', stderr: '' });
    }
  });
}

/** Why git gave no listing, from how the query failed. */
function refusalReason(answer: { code: string; stderr: string }): string {
  if (answer.code === 'ENOENT' || answer.code === 'SPAWN') { return 'git is not installed or could not be started'; }
  if (answer.code === 'TIMEOUT') { return 'git did not answer in time'; }
  if (answer.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { return 'git tracks more files than can be listed'; }
  if (/dubious ownership|safe\.directory/i.test(answer.stderr)) {
    return 'git refuses this workspace: it is owned by another user (see git safe.directory)';
  }
  if (/not a git repository/i.test(answer.stderr)) { return 'the workspace is not a git repository'; }
  return 'git could not list the tracked files';
}

/**
 * The files git tracks in the repository rooted at `cwd` (`git ls-files`: the index, so a
 * file that is untracked or ignored can never appear), or why they could not be listed:
 * git is missing, times out or refuses the directory, or `cwd` is not the root of a
 * repository.
 *
 * Asynchronous — git is never waited for on the caller's thread — and run with
 * {@link minimalGitEnv}, so no inherited `GIT_DIR` or `GIT_WORK_TREE` decides which
 * repository answers. Never throws, never rejects.
 */
export async function readTrackedFiles(cwd: string): Promise<TrackedFiles> {
  try {
    const prefix = await gitQuery(cwd, ['rev-parse', '--show-prefix']);
    if (!prefix.ok) { return { ok: false, reason: refusalReason(prefix) }; }
    // A workspace nested inside some other repository is not that repository's root.
    if (prefix.stdout.trim() !== '') { return { ok: false, reason: 'the workspace is not the root of its git repository' }; }
    const listed = await gitQuery(cwd, ['ls-files', '-z']);
    if (!listed.ok) { return { ok: false, reason: refusalReason(listed) }; }
    return { ok: true, files: listed.stdout.split('\0').filter((name) => name.length > 0) };
  } catch {
    return { ok: false, reason: 'git could not list the tracked files' };
  }
}

/**
 * The source files among `files` (git's listing), under the same bounds and exclusions as
 * {@link walkRepo}: shallowest first, nothing below a noise or dot directory, regular files
 * only. A tracked file that is not on disk any more is left out.
 */
function listTracked(cwd: string, files: string[]): WalkResult {
  const sourceFiles: string[] = [];
  const dotnetMarkers: string[] = [];
  const candidates = files
    .map((file) => file.split('/'))
    .filter((segments) => segments.length <= MAX_WALK_DEPTH + 1
      && !segments.some((seg) => NOISE_ENTRIES.has(seg))
      && !segments.slice(0, -1).some((seg) => seg.startsWith('.')))
    .sort((a, b) => {
      if (a.length !== b.length) { return a.length - b.length; }
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { return a[i] < b[i] ? -1 : 1; }
      }
      return 0;
    });
  let visited = 0;
  for (const segments of candidates) {
    if (++visited > MAX_WALK_ENTRIES) { break; }
    const name = segments[segments.length - 1];
    const ext = extensionOf(name);
    const marker = ext === 'sln' || ext === 'csproj';
    const source = SOURCE_EXTENSIONS.has(ext) && !/\.config\.[cm]?[jt]s$/.test(name) && sourceFiles.length < MAX_SOURCE_FILES;
    if (!marker && !source) { continue; }
    try {
      if (!fs.lstatSync(path.join(cwd, ...segments)).isFile()) { continue; }
    } catch {
      continue;
    }
    const child = segments.join('/');
    if (marker) { dotnetMarkers.push(child); }
    if (source) { sourceFiles.push(child); }
  }
  return { sourceFiles, dotnetMarkers };
}

/** Options for {@link detectProjectConventions}. */
export interface ConventionDetectionOptions {
  /**
   * Git's listing of the tracked files, read beforehand ({@link readTrackedFiles}). Without
   * it the detection knows no tracked file, and a proposal built on it names no directory.
   */
  tracked?: TrackedFiles;
}

/**
 * {@link detectProjectConventions} over the files git tracks: asks git first
 * ({@link readTrackedFiles}, asynchronous), then detects from that listing. This is what a
 * proposal is built from. Never throws, never rejects.
 */
export async function detectConventions(cwd: string): Promise<ConventionDetection> {
  return detectProjectConventions(cwd, { tracked: await readTrackedFiles(cwd) });
}

/**
 * Describe the conventions a repository already follows, each with the file
 * that proved it: stack, framework, layout, lint/format configuration, test
 * runner, component library, and a measured comment-density baseline.
 *
 * Synchronous file reads only: nothing is spawned here and no network is touched. With
 * `opts.tracked` (git's own listing) only tracked files are looked at, so nothing
 * `.gitignore` names — build output, reports, a dependency tree — can be detected as part
 * of the project. Without a listing the disk is walked for facts about the code, and
 * `trackedTopLevelDirs` stays null with the reason in `trackedUnavailable`.
 *
 * Never throws: an unreadable or malformed repository yields an empty detection, which a
 * proposal treats as "nothing proven".
 */
export function detectProjectConventions(cwd: string, opts: ConventionDetectionOptions = {}): ConventionDetection {
  const out = emptyDetection();
  try {
    const tracked: TrackedFiles = opts.tracked ?? { ok: false, reason: NOT_CONSULTED };
    const trackedSet = tracked.ok ? new Set(tracked.files) : null;
    if (tracked.ok) {
      out.trackedTopLevelDirs = [...new Set(tracked.files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
      delete out.trackedUnavailable;
    } else {
      out.trackedTopLevelDirs = null;
      out.trackedUnavailable = tracked.reason;
    }
    /** A root-level file that exists and — where git's listing is known — is tracked. */
    const present = (name: string): boolean => fileExists(cwd, name) && (trackedSet === null || trackedSet.has(name));
    const firstPresent = (names: string[]): string | null => names.find(present) ?? null;
    // ── Layout ──
    // With git's listing, the layout IS that listing: nothing untracked or ignored is seen.
    // Without it the disk is walked for facts about the code only — a proposal then names
    // no directory at all (see `trackedUnavailable`).
    if (tracked.ok) {
      out.topLevel = [...new Set(tracked.files.map((f) => f.split('/')[0]))].filter((name) => !NOISE_ENTRIES.has(name)).sort();
    } else {
      try {
        out.topLevel = fs.readdirSync(cwd).filter((name) => !NOISE_ENTRIES.has(name)).sort();
      } catch {
        return out;
      }
    }
    const { sourceFiles, dotnetMarkers } = tracked.ok ? listTracked(cwd, tracked.files) : walkRepo(cwd);
    out.sourceFileCount = sourceFiles.length;
    out.sampleSourceFile = sourceFiles[0] ?? null;
    out.sourceFileSample = sourceFiles.slice(0, MAX_NAME_SAMPLE_FILES);

    const sourceDirs: string[] = [];
    const testDirs: string[] = [];
    let sourceProof: string | null = null;
    let testProof: string | null = null;
    for (const file of sourceFiles) {
      const testDir = testDirOf(file);
      if (testDir) {
        if (!testDirs.includes(testDir)) { testDirs.push(testDir); }
        testProof = testProof ?? file;
      } else if (file.includes('/')) {
        const top = file.split('/')[0];
        if (!sourceDirs.includes(top)) { sourceDirs.push(top); }
        sourceProof = sourceProof ?? file;
      }
    }
    if (sourceDirs.length > 0 && sourceProof) { out.sourceDirs = { value: sourceDirs.sort(), evidence: sourceProof }; }
    if (testDirs.length > 0 && testProof) { out.testDirs = { value: testDirs.sort(), evidence: testProof }; }

    // ── Manifests (bounded reads; a manifest that will not parse proves nothing) ──
    const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    let pkg: Record<string, unknown> | null = null;
    const pkgText = present('package.json') ? readCapped(cwd, 'package.json', MAX_MANIFEST_BYTES) : null;
    if (pkgText !== null) {
      try {
        const parsed: unknown = JSON.parse(pkgText);
        if (isRecord(parsed)) { pkg = parsed; }
      } catch {
        pkg = null;
      }
    }
    const jsDeps = new Set<string>(pkg
      ? [...Object.keys(isRecord(pkg.dependencies) ? pkg.dependencies : {}), ...Object.keys(isRecord(pkg.devDependencies) ? pkg.devDependencies : {})]
      : []);
    const manifestsReadable = MANIFEST_FILES.every((name) => {
      try {
        const stat = fs.lstatSync(path.join(cwd, name));
        return stat.isFile() && stat.size <= MAX_MANIFEST_BYTES;
      } catch {
        return true;
      }
    });

    // ── Stack ──
    const candidates: Array<{ stack: Exclude<StackGuess, 'static-web'>; evidence: string }> = [];
    if (pkg) { candidates.push({ stack: 'node-ts', evidence: 'package.json' }); }
    const pyMarker = firstPresent(['pyproject.toml', 'requirements.txt', 'setup.py']);
    if (pyMarker) { candidates.push({ stack: 'python', evidence: pyMarker }); }
    if (present('go.mod')) { candidates.push({ stack: 'go', evidence: 'go.mod' }); }
    const javaMarker = firstPresent(['pom.xml', 'build.gradle', 'build.gradle.kts']);
    if (javaMarker) { candidates.push({ stack: 'java', evidence: javaMarker }); }
    if (dotnetMarkers.length > 0) {
      candidates.push({ stack: 'dotnet', evidence: dotnetMarkers.find((m) => m.endsWith('.sln')) ?? dotnetMarkers[0] });
    }
    if (present('Cargo.toml')) { candidates.push({ stack: 'rust', evidence: 'Cargo.toml' }); }

    const countFor = (stack: Exclude<StackGuess, 'static-web'>): number => {
      const exts = STACK_EXTENSIONS[stack];
      return sourceFiles.filter((f) => exts.includes(extensionOf(f))).length;
    };
    let best: { stack: StackGuess; evidence: string } | null = null;
    let bestCount = -1;
    for (const candidate of candidates) {
      const count = countFor(candidate.stack);
      if (count > bestCount) { best = candidate; bestCount = count; }
    }
    if (!best && present('index.html')) { best = { stack: 'static-web', evidence: 'index.html' }; }
    if (best) { out.stack = { value: best.stack, evidence: best.evidence }; }
    const stack = best?.stack ?? null;

    // ── Lint and format configuration ──
    for (const [file, tool] of LINT_CONFIG_FILES) {
      if (present(file)) { out.lintConfigs.push({ tool, file }); }
    }
    for (const [file, tool] of FORMAT_CONFIG_FILES) {
      if (present(file)) { out.formatConfigs.push({ tool, file }); }
    }
    const pyproject = (present('pyproject.toml') ? readCapped(cwd, 'pyproject.toml', MAX_MANIFEST_BYTES) : null) ?? '';
    if (/^\[tool\.ruff\b/m.test(pyproject)) { out.lintConfigs.push({ tool: 'ruff', file: 'pyproject.toml' }); }
    if (/^\[tool\.black\b/m.test(pyproject)) { out.formatConfigs.push({ tool: 'black', file: 'pyproject.toml' }); }
    // Type checkers and audit tools: only those a file in the repository declares.
    const declared = detectDeclaredTools(present, (name) => readCapped(cwd, name, MAX_MANIFEST_BYTES));
    if (declared.length > 0) { out.declaredTools = declared; }

    // ── Scripts (names only) ──
    // A script that runs nothing (empty, or npm init's "no test specified") is not listed:
    // it proves no tool, and a proposal would otherwise turn it into a command that fails.
    if (pkg && isRecord(pkg.scripts)) {
      const scripts = pkg.scripts;
      const names = Object.keys(scripts).filter((name) => SAFE_SCRIPT_NAME.test(name) && isRealScriptBody(scripts[name])).slice(0, 100);
      if (names.length > 0) { out.scripts = { value: names, evidence: 'package.json' }; }
    }

    // ── Docs, data and git conventions (Project Rulebook): tracked files only ──
    // Adopted into a proposal as what the repository already does, so an untracked file —
    // a local note, build output — never is.
    if (tracked.ok && trackedSet) {
      const changelog = CHANGELOG_FILES.find((name) => trackedSet.has(name));
      if (changelog) { out.changelog = { value: changelog, evidence: changelog }; }
      for (const dir of MIGRATION_DIRS) {
        const proof = tracked.files.find((f) => f.startsWith(`${dir}/`));
        if (proof) { out.migrationsDir = { value: dir, evidence: proof }; break; }
      }
      if (trackedSet.has('.env.example')) { out.envExample = { value: '.env.example', evidence: '.env.example' }; }
      const convention = tracked.files.find((f) => !f.includes('/') && COMMIT_CONVENTION_FILE.test(f));
      if (convention) { out.commitConvention = { value: convention, evidence: convention }; }
    }

    // ── Framework, test runner, component library ──
    if (stack === 'node-ts') {
      const framework = NODE_FRAMEWORKS.find(([dep]) => jsDeps.has(dep));
      if (framework) { out.framework = { value: framework[1], evidence: 'package.json' }; }
      const library = COMPONENT_LIBRARIES.find(([dep]) => jsDeps.has(dep));
      if (library) { out.componentLibrary = { value: library[1], evidence: 'package.json' }; }
      const runners: Array<[string, string, string[]]> = [
        ['vitest', 'Vitest', ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts']],
        ['jest', 'Jest', ['jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.json']],
        ['mocha', 'Mocha', ['.mocharc.json', '.mocharc.js', '.mocharc.cjs', '.mocharc.yml', '.mocharc.yaml']],
      ];
      for (const [dep, label, configs] of runners) {
        const config = firstPresent(configs);
        if (config || jsDeps.has(dep)) {
          out.testRunner = { value: label, evidence: config ?? 'package.json' };
          break;
        }
      }
    } else if (stack === 'python' && manifestsReadable && best) {
      const pyDeps = parsePythonDeps(cwd);
      const framework = PYTHON_FRAMEWORKS.find(([dep]) => pyDeps.has(dep));
      if (framework) { out.framework = { value: framework[1], evidence: best.evidence }; }
      const pytestProof = firstPresent(['pytest.ini', 'conftest.py']) ?? (pyDeps.has('pytest') ? best.evidence : null);
      if (pytestProof) { out.testRunner = { value: 'pytest', evidence: pytestProof }; }
    } else if (stack === 'go' && manifestsReadable) {
      const framework = parseGoMod(cwd).find((s) => ['Gin', 'Chi', 'Fiber', 'Echo', 'Gorilla Mux', 'Beego'].includes(s));
      if (framework) { out.framework = { value: framework, evidence: 'go.mod' }; }
      out.testRunner = { value: 'go test', evidence: 'go.mod' };
    } else if (stack === 'java' && manifestsReadable && best) {
      const signals = parseJavaDeps(cwd);
      const framework = signals.find((s) => ['Spring Boot', 'Micronaut', 'Quarkus'].includes(s));
      if (framework) { out.framework = { value: framework, evidence: best.evidence }; }
      if (signals.includes('JUnit')) { out.testRunner = { value: 'JUnit', evidence: best.evidence }; }
    } else if (stack === 'dotnet') {
      for (const marker of dotnetMarkers.filter((m) => m.endsWith('.csproj')).slice(0, 10)) {
        const text = readCapped(cwd, marker, MAX_MANIFEST_BYTES) ?? '';
        if (!out.framework && text.includes('Microsoft.NET.Sdk.Web')) { out.framework = { value: 'ASP.NET Core', evidence: marker }; }
        if (!out.testRunner) {
          const runner = /xunit/i.test(text) ? 'xUnit' : /nunit/i.test(text) ? 'NUnit' : /mstest/i.test(text) ? 'MSTest' : null;
          if (runner) { out.testRunner = { value: runner, evidence: marker }; }
        }
      }
    }

    // ── Built-in rule suggestions (the existing detector, unchanged) ──
    if (manifestsReadable) { out.suggestedRuleIds = detectProjectRules(cwd).suggestedRuleIds; }

    // ── Comment-density baseline over a bounded sample ──
    let totalLines = 0;
    let commentLines = 0;
    let sampled = 0;
    let densityProof: string | null = null;
    for (const file of sourceFiles) {
      if (sampled >= MAX_DENSITY_SAMPLE_FILES) { break; }
      if (languageFamily(file) === null) { continue; }
      const text = readCapped(cwd, file, MAX_DENSITY_FILE_BYTES);
      if (text === null) { continue; }
      const lexed = lexFile(file, text);
      if (!lexed.ok) { continue; }
      sampled++;
      densityProof = densityProof ?? file;
      totalLines += lexed.lines.length;
      commentLines += commentOnlyLineNumbers(lexed.lines, text.startsWith('#!')).length;
    }
    if (sampled > 0 && totalLines > 0 && densityProof) {
      out.commentDensity = { pct: (commentLines * 100) / totalLines, filesSampled: sampled, evidence: densityProof };
    }

    // ── Design sources (only when something was found, so other detections are unchanged) ──
    const design = detectDesignSources(cwd, present);
    if (design.tokens || design.doc || design.ui || design.notAdopted) { out.designSources = design; }
    return out;
  } catch {
    return emptyDetection();
  }
}
