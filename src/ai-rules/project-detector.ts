import * as fs from 'fs';
import * as path from 'path';

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
 * Detection is lightweight — file reads only, no spawning.
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