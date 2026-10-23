// ─── G4: no hosted-server module reaches `vscode` at load time ───
//
// Parses each src/server/*.ts with the TypeScript compiler, follows its
// TOP-LEVEL relative imports/requires recursively, and asserts no file reached
// that way imports `vscode` (anywhere in that file). Lazy `require()`s inside functions are not
// followed: that is exactly the post-shim region of the run worker, which must
// only ever execute in a child process after `installVscodeShim()`.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.resolve(__dirname, '..', '..', '..');
const SERVER = path.join(SRC, 'server');

/**
 * True when `text` really imports vscode — an import/export declaration or a
 * `require('vscode')` / `import('vscode')` call ANYWHERE in the file (inside
 * functions too). Parsed, not grepped: install-shim.ts mentions
 * `require('vscode')` in a comment while only comparing the request string,
 * which a regex would misreport.
 */
function importsVscode(text: string): boolean {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.ES2022, true);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) { return; }
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier
      && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'vscode') { found = true; return; }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)
      && ts.isStringLiteral(n.moduleReference.expression) && n.moduleReference.expression.text === 'vscode') { found = true; return; }
    if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'vscode'
      && ((ts.isIdentifier(n.expression) && n.expression.text === 'require') || n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Module specifiers loaded when `file` is first required (type-only imports excluded). */
function topLevelSpecifiers(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const requireArg = (e: ts.Expression | undefined): string | null => {
    if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require'
      && e.arguments.length === 1 && ts.isStringLiteral(e.arguments[0])) {
      return e.arguments[0].text;
    }
    return null;
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.importClause?.isTypeOnly) { continue; }
      out.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      out.push(st.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference)
      && ts.isStringLiteral(st.moduleReference.expression)) {
      out.push(st.moduleReference.expression.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        let init = d.initializer;
        while (init && ts.isPropertyAccessExpression(init)) { init = init.expression; }
        while (init && ts.isCallExpression(init) && !requireArg(init) && ts.isPropertyAccessExpression(init.expression)) {
          init = init.expression.expression;
        }
        const spec = requireArg(init);
        if (spec) { out.push(spec); }
      }
    } else if (ts.isExpressionStatement(st)) {
      const spec = requireArg(st.expression);
      if (spec) { out.push(spec); }
    }
  }
  return out;
}

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) { return null; }
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

/** Every file reachable from `entry` through top-level relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) { continue; }
    seen.add(f);
    for (const spec of topLevelSpecifiers(f)) {
      if (spec === 'vscode') { continue; } // reported by the content check below
      const r = resolveRelative(f, spec);
      if (r) { stack.push(r); }
    }
  }
  return seen;
}

const serverFiles = fs.readdirSync(SERVER).filter((n) => n.endsWith('.ts')).map((n) => path.join(SERVER, n));

describe('G4: server modules never load vscode', () => {
  it('finds the server modules (non-vacuous)', () => {
    assert.ok(serverFiles.length >= 15, `found ${serverFiles.length}`);
    assert.ok(serverFiles.some((f) => f.endsWith('app.ts')));
    assert.ok(serverFiles.some((f) => f.endsWith('run-worker.ts')));
  });

  it('the walker detects a vscode import in a synthetic file', () => {
    assert.ok(importsVscode("import * as vscode from 'vscode';"));
    assert.ok(importsVscode("function f() { const vscode = require('vscode'); }"));
    assert.ok(importsVscode("const v = import('vscode');"));
    assert.equal(importsVscode("// require('vscode') in a comment\nif (request === 'vscode') {}"), false);
    // And it really follows imports: app.ts reaches the models layer.
    const r = [...reachable(path.join(SERVER, 'app.ts'))].map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
    assert.ok(r.includes('models/plan.ts'), 'walker follows relative imports');
  });

  for (const file of serverFiles) {
    it(`${path.basename(file)} reaches no vscode import at load time`, () => {
      const offenders = [...reachable(file)].filter((f) => importsVscode(fs.readFileSync(f, 'utf-8')));
      assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
    });
  }

  it('run-worker.ts has exactly the five allowed top-level imports', () => {
    const specs = topLevelSpecifiers(path.join(SERVER, 'run-worker.ts')).sort();
    assert.deepEqual(specs, ['../headless/install-shim', '../shared/worker-pipes', './worker-protocol', 'fs', 'path']);
    // The shared pipe guard (moved out of run-worker so the shipped remote child can use it) imports nothing.
    assert.deepEqual(topLevelSpecifiers(path.join(SERVER, '..', 'shared', 'worker-pipes.ts')), []);
  });

  it("the string 'vscode' never appears as a module specifier in run-worker.ts", () => {
    assert.equal(importsVscode(fs.readFileSync(path.join(SERVER, 'run-worker.ts'), 'utf-8')), false);
    assert.equal(/['"]vscode['"]/.test(fs.readFileSync(path.join(SERVER, 'run-worker.ts'), 'utf-8')), false);
  });
});

// ─── The benchmark harness (`moag bench`) drives the server over HTTP: never vscode ───

const BENCH = path.join(SRC, 'bench');
const benchFiles = fs.existsSync(BENCH) ? fs.readdirSync(BENCH).filter((n) => n.endsWith('.ts')).map((n) => path.join(BENCH, n)) : [];

describe('bench modules never load vscode', () => {
  it('finds the bench modules (non-vacuous)', () => {
    assert.ok(benchFiles.length >= 6, `found ${benchFiles.length}`);
    for (const name of ['harness.ts', 'client.ts', 'scenario.ts', 'fake-claude.ts']) {
      assert.ok(benchFiles.some((f) => f.endsWith(name)), name);
    }
  });

  for (const file of benchFiles) {
    it(`bench/${path.basename(file)} reaches no vscode import at load time`, () => {
      const offenders = [...reachable(file)].filter((f) => importsVscode(fs.readFileSync(f, 'utf-8')));
      assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
    });
  }

  it('the server the bench loads lazily (server/main.ts) reaches no vscode either', () => {
    const offenders = [...reachable(path.join(SERVER, 'main.ts'))].filter((f) => importsVscode(fs.readFileSync(f, 'utf-8')));
    assert.deepEqual(offenders, []);
  });
});

// ─── The ONOSOO relay and task reporting run in `moag run` before/without any shim: never vscode ───

const RELAY_MODULES = [
  'utils/redact.ts',
  'runner/task-changes.ts',
  'headless/task-reporting.ts',
  'headless/onosoo-config.ts',
  'headless/onosoo-spool.ts',
  'headless/onosoo-relay.ts',
  'headless/run-reporter.ts',
  'headless/host-run-relay.ts',
];

describe('ONOSOO relay modules never load vscode', function () {
  this.timeout(20000);

  it('finds every relay module (non-vacuous)', () => {
    for (const rel of RELAY_MODULES) {
      assert.ok(fs.existsSync(path.join(SRC, rel)), rel);
    }
  });

  for (const rel of RELAY_MODULES) {
    it(`${rel} reaches no vscode import at load time`, () => {
      const offenders = [...reachable(path.join(SRC, rel))].filter((f) => importsVscode(fs.readFileSync(f, 'utf-8')));
      assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
    });
  }

  it("'run-meta' is relay-only: in neither HEADLESS_EVENTS nor WORKER_ONLY_EVENTS", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HEADLESS_EVENTS, WORKER_ONLY_EVENTS } = require('../../../server/worker-protocol');
    assert.equal((HEADLESS_EVENTS as readonly string[]).includes('run-meta'), false);
    assert.equal((WORKER_ONLY_EVENTS as readonly string[]).includes('run-meta'), false);
  });
});

// ─── ONOSOO stage 2: the command poller and remote runs (daemon and child) never load vscode ───

const HEADLESS = path.join(SRC, 'headless');
const REMOTE_MODULES = ['onosoo-control.ts', 'onosoo-commands.ts', 'onosoo-projects.ts'];
const remoteFiles = fs.readdirSync(HEADLESS)
  .filter((n) => REMOTE_MODULES.includes(n) || (n.startsWith('remote-') && n.endsWith('.ts')))
  .map((n) => path.join(HEADLESS, n));

describe('ONOSOO remote-work modules never load vscode', function () {
  this.timeout(20000);

  it('finds the stage-2 modules (non-vacuous)', () => {
    for (const name of [...REMOTE_MODULES, 'remote-audit.ts', 'remote-branch.ts', 'remote-child.ts', 'remote-commands.ts',
      'remote-isolation.ts', 'remote-ledger.ts', 'remote-runs.ts', 'remote-supervisor.ts']) {
      assert.ok(remoteFiles.some((f) => path.basename(f) === name), name);
    }
  });

  for (const file of remoteFiles) {
    it(`headless/${path.basename(file)} reaches no vscode import at load time`, () => {
      const offenders = [...reachable(file)].filter((f) => importsVscode(fs.readFileSync(f, 'utf-8')));
      assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
    });
  }
});

// ─── The host agent (`moag host`) runs environments and a gateway, never the runner: never vscode ───

const HOST = path.join(SRC, 'host');
const hostFiles = fs.existsSync(HOST) ? fs.readdirSync(HOST).filter((n) => n.endsWith('.ts')).map((n) => path.join(HOST, n)) : [];

describe('host agent modules never load vscode', function () {
  this.timeout(20000);

  it('finds the host modules (non-vacuous)', () => {
    for (const name of ['cli.ts', 'agent.ts', 'gateway.ts', 'environments.ts', 'compose.ts', 'recipe.ts', 'host-config.ts', 'tunnel.ts', 'onosoo-client.ts']) {
      assert.ok(hostFiles.some((f) => f.endsWith(name)), name);
    }
  });

  for (const file of hostFiles) {
    it(`host/${path.basename(file)} reaches no vscode import at load time`, () => {
      const offenders = [...reachable(file)].filter((f) => importsVscode(fs.readFileSync(f, 'utf-8')));
      assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
    });

    // Stricter than load time: not even a lazy require, since `moag host` never installs the shim.
    it(`host/${path.basename(file)} never imports vscode anywhere in the file`, () => {
      assert.equal(importsVscode(fs.readFileSync(file, 'utf-8')), false);
    });
  }
});
