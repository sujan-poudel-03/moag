// ─── VSIX closure: everything the shipped entry points require is in the package ───
//
// Unit and integration tests run against the repository's own out/, which holds
// every compiled file. The VSIX does not: .vscodeignore drops out/server/**,
// out/test/**, out/bench/** and more. 0.9.13 and 0.9.14 shipped an extension
// whose activation chain required ../server/secrets, which was not in the
// package, so VS Code failed with "Cannot find module" on activation while every
// test passed. This walks the compiled require graph from the two shipped entry
// points (the extension and the headless CLI) and fails when any reachable file
// is one .vscodeignore excludes. It needs a fresh `npm run compile`.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const ENTRY_POINTS = ['out/extension.js', 'out/headless/cli.js'];

/**
 * Require edges into excluded files that are deliberate: the target is a
 * development tool, and the requiring code catches MODULE_NOT_FOUND and says
 * so. The walk does not follow them. Each must still exist (asserted below).
 */
const GUARDED_DEV_EDGES: ReadonlyArray<{ from: string; to: string }> = [
  // `moag bench` drives the hosted server; it runs from a source checkout only.
  { from: 'out/headless/cli.js', to: 'out/bench/harness.js' },
];

// ─── .vscodeignore, read the way vsce reads it ───

/** Translate a vsce/minimatch glob (`dot: true`) into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length;
      if (atStart && glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue; }
      if (atStart && atEnd) { re += '.*'; i += 1; continue; }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A predicate that says whether vsce would leave a repo-relative POSIX path out of the VSIX. */
export function vscodeIgnoreMatcher(text: string): (relPath: string) => boolean {
  const lines = text.split(/[\n\r]/).map((s) => s.trim()).filter((s) => s !== '' && !s.startsWith('#'));
  // vsce also treats a pattern whose last segment has no `*` as a possible folder.
  const expanded = [...lines, ...lines.filter((l) => !/(^|\/)[^/]*\*[^/]*$/.test(l)).map((l) => (l.endsWith('/') ? `${l}**` : `${l}/**`))];
  const ignore = expanded.filter((l) => !l.startsWith('!')).map(globToRegExp);
  const negate = expanded.filter((l) => l.startsWith('!')).map((l) => globToRegExp(l.slice(1)));
  return (relPath) => ignore.some((r) => r.test(relPath)) && !negate.some((r) => r.test(relPath));
}

// ─── The compiled require graph ───

const REQUIRE_RE = /\brequire\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;

/** Resolve a relative require the way Node does for the shapes tsc emits. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { /* next */ }
  }
  return null;
}

export interface ClosureProblem { file: string; requiredBy: string; problem: 'excluded' | 'missing' }

/** Walk every relative `require` from `entries` and report excluded or unresolvable targets. */
export function closureProblems(
  repo: string, entries: string[], isExcluded: (rel: string) => boolean,
  skipEdges: ReadonlyArray<{ from: string; to: string }> = [],
): { reached: number; problems: ClosureProblem[]; skipped: string[] } {
  const rel = (abs: string): string => path.relative(repo, abs).split(path.sep).join('/');
  const seen = new Set<string>();
  const problems: ClosureProblem[] = [];
  const skipped: string[] = [];
  const queue = entries.map((e) => path.join(repo, e));
  for (const e of queue) { seen.add(e); }
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (!file.endsWith('.js')) { continue; }
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(REQUIRE_RE)) {
      const target = resolveRelative(file, m[2]);
      if (!target) {
        problems.push({ file: `${rel(path.resolve(path.dirname(file), m[2]))} (unresolved)`, requiredBy: rel(file), problem: 'missing' });
        continue;
      }
      if (skipEdges.some((e) => e.from === rel(file) && e.to === rel(target))) { skipped.push(`${rel(file)} -> ${rel(target)}`); continue; }
      if (seen.has(target)) { continue; }
      seen.add(target);
      if (isExcluded(rel(target))) { problems.push({ file: rel(target), requiredBy: rel(file), problem: 'excluded' }); }
      queue.push(target);
    }
  }
  return { reached: seen.size, problems, skipped };
}

describe('VSIX closure (.vscodeignore vs the compiled require graph)', () => {
  const ignoreText = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf-8');
  const isExcluded = vscodeIgnoreMatcher(ignoreText);

  it('the glob translation reads .vscodeignore the way vsce does', () => {
    assert.ok(isExcluded('out/server/secrets.js'));
    assert.ok(isExcluded('out/test/unit/x.test.js'));
    assert.ok(isExcluded('out/bench/harness.js'));
    assert.ok(isExcluded('out/extension.js.map'), 'source maps are excluded');
    assert.ok(isExcluded('src/extension.ts'));
    assert.ok(isExcluded('docs/startup.md'));
    assert.ok(!isExcluded('docs/MANUAL.md'), 'a negated pattern keeps the file');
    assert.ok(!isExcluded('out/extension.js'));
    assert.ok(!isExcluded('out/headless/cli.js'));
    assert.ok(!isExcluded('out/shared/stacks.js'));
    assert.ok(!isExcluded('node_modules/@anthropic-ai/sdk/index.js'));
    assert.ok(!isExcluded('package.json'));
  });

  it('every file reachable from the extension and the CLI is shipped', function () {
    for (const entry of ENTRY_POINTS) {
      if (!fs.existsSync(path.join(REPO, entry))) {
        assert.fail(`${entry} is missing; run \`npm run compile\` before the unit suite.`);
      }
    }
    const { reached, problems, skipped } = closureProblems(REPO, ENTRY_POINTS, isExcluded, GUARDED_DEV_EDGES);
    assert.ok(reached > 50, `walked only ${reached} files; the require scan is broken`);
    assert.deepEqual(skipped.sort(), GUARDED_DEV_EDGES.map((e) => `${e.from} -> ${e.to}`).sort(), 'every allowed edge still exists');
    assert.deepEqual(problems.map((p) => `${p.file} (${p.problem}, required by ${p.requiredBy})`), []);
  });

  it('catches an excluded file on the require path (the 0.9.13 failure)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-closure-'));
    try {
      fs.mkdirSync(path.join(tmp, 'out', 'headless'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'out', 'server'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'out', 'extension.js'), 'require("./headless/onosoo-config");');
      fs.writeFileSync(path.join(tmp, 'out', 'headless', 'onosoo-config.js'), 'const s = require("../server/secrets"); require("./gone");');
      fs.writeFileSync(path.join(tmp, 'out', 'server', 'secrets.js'), 'module.exports = {};');
      const { problems } = closureProblems(tmp, ['out/extension.js'], vscodeIgnoreMatcher('out/server/**\n'));
      assert.deepEqual(problems.map((p) => `${p.problem}:${p.file}`).sort(), [
        'excluded:out/server/secrets.js',
        'missing:out/headless/gone (unresolved)',
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
