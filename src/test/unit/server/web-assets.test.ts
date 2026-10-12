// ─── Static scan of the PO front-end (web/**) ───
//
// The front-end renders agent- and user-authored text (task names, error
// tails, PRD text). The CSP forbids inline script, and this scan keeps the
// source from ever needing it: no HTML-string sinks, no eval, no inline
// handlers, no raw colours. ESM can't be required from this suite on Node 20,
// so these are source-level checks.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { FakeEl, fakeDomStubs, loadWebModule, root, webStrings } from './web-vm';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const WEB = path.join(REPO, 'web');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(p)); } else { out.push(p); }
  }
  return out;
}

const rel = (p: string): string => path.relative(REPO, p).split(path.sep).join('/');
const files = walk(WEB);
const read = (p: string): string => fs.readFileSync(p, 'utf-8');
const ofExt = (ext: string): string[] => files.filter((f) => f.endsWith(ext));

/** Every match of `re` in `files`, as "file:line: text". */
function offences(list: string[], re: RegExp): string[] {
  const hits: string[] = [];
  for (const f of list) {
    read(f).split('\n').forEach((line, i) => { if (re.test(line)) { hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`); } });
  }
  return hits;
}

describe('web assets (static scan)', () => {
  it('has the shell, the app module and the screens', () => {
    for (const f of ['index.html', 'app.css', 'js/app.js', 'js/dom.js', 'js/strings.js',
      'js/screens/login.js', 'js/screens/bootstrap.js', 'js/screens/projects.js', 'js/screens/project-form.js',
      'js/screens/prd.js', 'js/screens/standards.js', 'js/screens/design-view.js', 'js/screens/version-panel.js', 'js/screens/plan.js', 'js/screens/run.js',
      'js/screens/trace.js', 'js/screens/admin-users.js', 'js/screens/admin-audit.js']) {
      assert.ok(fs.existsSync(path.join(WEB, f)), `missing web/${f}`);
    }
  });

  it('serves only allowlisted file types', () => {
    const bad = files.filter((f) => !['.html', '.js', '.css', '.svg', '.png'].includes(path.extname(f)));
    assert.deepEqual(bad.map(rel), []);
  });

  it('never uses an HTML-string sink, document.write, eval or new Function', () => {
    const src = [...ofExt('.js'), ...ofExt('.html')];
    assert.deepEqual(offences(src, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write|\beval\s*\(|\bnew\s+Function\b|\bsrcdoc\b|createContextualFragment|DOMParser/), []);
  });

  it('has no inline <script> (every script tag has src) and no inline handlers or style attributes in HTML', () => {
    for (const f of ofExt('.html')) {
      const html = read(f);
      const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
      assert.ok(scripts.length > 0, `${rel(f)} has no script tag`);
      for (const tag of scripts) { assert.match(tag, /\ssrc=/i, `${rel(f)}: inline script ${tag}`); }
      assert.ok(!/<script\b[^>]*>[^<\s]/i.test(html), `${rel(f)}: script with a body`);
      assert.deepEqual(offences([f], /<[^>]*\son[a-z]+\s*=/i), [], 'inline on*= handler');
      assert.deepEqual(offences([f], /<[^>]*\sstyle\s*=/i), [], 'inline style attribute');
      assert.deepEqual(offences([f], /<style\b/i), [], 'inline <style> block');
    }
  });

  it('JS never assigns on* handler properties, sets on*/style attributes, or uses javascript: URLs', () => {
    const js = ofExt('.js');
    assert.deepEqual(offences(js, /\.on[a-z]+\s*=(?!=)/), []);
    assert.deepEqual(offences(js, /setAttribute\(\s*['"`](on[a-z]|style)/i), []);
    assert.deepEqual(offences(js, /javascript:/i), []);
    assert.deepEqual(offences(js, /\.style\s*=(?!=)|\.cssText\b/), []);
  });

  it('CSS uses design tokens only: no hex or rgb/hsl literals', () => {
    assert.deepEqual(offences(ofExt('.css'), /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/), []);
  });

  it('every strings.js key referenced from the app exists, and C1–C28 are all defined', () => {
    const stringsSrc = read(path.join(WEB, 'js', 'strings.js'));
    const defined = new Set([...stringsSrc.matchAll(/^\s{2}(C\d+[a-z]?):/gm)].map((m) => m[1]));
    for (let i = 1; i <= 28; i++) { assert.ok(defined.has(`C${i}`), `C${i} is not defined`); }
    const missing: string[] = [];
    for (const f of ofExt('.js')) {
      for (const m of read(f).matchAll(/\bSTR\.(C\d+[a-z]?)\b/g)) {
        if (!defined.has(m[1])) { missing.push(`${rel(f)}: STR.${m[1]}`); }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('every relative import in web/js resolves to an existing file', () => {
    const missing: string[] = [];
    for (const f of ofExt('.js')) {
      for (const m of read(f).matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
        const target = path.resolve(path.dirname(f), m[1]);
        if (!fs.existsSync(target)) { missing.push(`${rel(f)} -> ${m[1]}`); }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('every named import is exported by its target module', () => {
    const exportsOf = (file: string): Set<string> => {
      const src = read(file);
      const names = new Set<string>();
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) { names.add(m[1]); }
      for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) { names.add(n); } }
      }
      return names;
    };
    const missing: string[] = [];
    for (const f of ofExt('.js')) {
      for (const m of read(f).matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gm)) {
        const target = path.resolve(path.dirname(f), m[2]);
        if (!fs.existsSync(target)) { continue; } // reported by the resolve test
        const exported = exportsOf(target);
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0];
          if (name && !exported.has(name)) { missing.push(`${rel(f)}: ${name} from ${m[2]}`); }
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('every web/js module parses: a syntax error in one file would blank the whole app', () => {
    // The other checks here read the source as text, and a module with a syntax error still
    // matches every pattern (an unescaped apostrophe in strings.js once did). The files are
    // browser ES modules that this suite cannot import, so they are parsed, not run.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ts = require('typescript') as typeof import('typescript');
    const broken: string[] = [];
    for (const f of ofExt('.js')) {
      const out = ts.transpileModule(read(f), {
        fileName: rel(f), reportDiagnostics: true,
        compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      for (const d of out.diagnostics ?? []) {
        const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
        broken.push(`${rel(f)}:${at}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
    assert.deepEqual(broken, []);
    // The check itself catches what it is for.
    const bad = ts.transpileModule("export const x = m('it can't start');", { fileName: 'x.js', reportDiagnostics: true, compilerOptions: { allowJs: true } });
    assert.ok((bad.diagnostics ?? []).length > 0, 'an unescaped apostrophe is a diagnostic');
  });

  it('the extension package excludes the web app and the server build', () => {
    const ignore = read(path.join(REPO, '.vscodeignore')).split(/\r?\n/).map((l) => l.trim());
    assert.ok(ignore.includes('web/**'));
    assert.ok(ignore.includes('out/server/**'));
  });
});

// ─── The ship gate: changed files and the design revert notice (run.js) ───

describe('web run screen — the gate card lists the changed files and the design revert', () => {
  type Render = (x: unknown) => unknown;
  const loadRun = (): { changedFilesBlock: Render; designRevertNotice: Render } => {
    const stubs = fakeDomStubs();
    const { cappedList } = loadWebModule('screens/version-panel.js', stubs, ['cappedList']);
    return loadWebModule('screens/run.js', { ...stubs, cappedList }, ['changedFilesBlock', 'designRevertNotice']) as {
      changedFilesBlock: Render; designRevertNotice: Render;
    };
  };
  const { changedFilesBlock, designRevertNotice } = loadRun();
  const BASE = '3f2a9c1e04b7aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, added: 2, removed: 1, binary: false, untracked: false }));
  const doc = (n: number, total = n) => ({ collected: true, baseRef: BASE, emptyTreeBase: false, total, files: rows(n) });
  const items = (el: FakeEl): FakeEl[] => el.all().filter((e) => e.tag === 'li');

  it('a list that was not collected says so, with the reason — never "0 files"', () => {
    const el = root(changedFilesBlock({ collected: false, reason: 'this run recorded no diff base' }));
    assert.match(el.textContent, /Changed files: not collected for this run\. \(this run recorded no diff base\)/);
    assert.doesNotMatch(el.textContent, /0 files/);
    assert.match(root(changedFilesBlock(undefined)).textContent, /not collected/);
  });

  it('an empty list is a warning that nothing changed', () => {
    const el = root(changedFilesBlock(doc(0)));
    assert.match(el.textContent, /No files changed since the diff base/);
    assert.equal(el.byClass('text-warning').length, 1);
  });

  it('20 files: all shown, no "Show all"; 21: 20 shown and a "Show all 21" that reveals the rest and focuses row 21', () => {
    const twenty = root(changedFilesBlock(doc(20)));
    assert.equal(items(twenty).length, 20);
    assert.doesNotMatch(twenty.textContent, /Show all/);
    assert.match(twenty.textContent, /\+40 −20 across 20 files\./);
    assert.match(twenty.textContent, /Since 3f2a9c1e04b7\. MOAG's own \.moag\/ folder is not listed\./);

    const more = root(changedFilesBlock(doc(21)));
    assert.equal(items(more).length, 21, '20 rows and the "Show all" row');
    const button = more.all().find((e) => e.tag === 'button' && /Show all 21/.test(e.textContent))!;
    button.click();
    const after = items(more);
    assert.equal(after.length, 21);
    assert.equal(after[20].focused, true, 'focus moves to the first newly revealed row');
    assert.equal(after[20].getAttribute('tabindex'), '-1');
  });

  it('600 changed files with 500 listed: says the rest are not listed', () => {
    const el = root(changedFilesBlock(doc(500, 600)));
    assert.match(el.textContent, /Changed files since 3f2a9c1e04b7 {2}600/);
    assert.match(el.textContent, /Listing 500 of 600 files\. The rest are not listed here\./);
    // An old list carries no server totals: only the listed rows are summed, and it says so.
    assert.match(el.textContent, /\+1,000 −500 across the 500 listed files\./);
  });

  it('the +/− totals cover every changed file: the server\'s totals, not the sum of the listed rows', () => {
    const totals = { added: 1234, removed: 567, binary: 3, hiddenFromGit: 1, uncounted: 2 };
    const el = root(changedFilesBlock({ ...doc(500, 600), totals }));
    const text = el.textContent;
    assert.match(text, /\+1,234 −567 across 600 files\./);
    assert.match(text, /3 binary files not counted\./);
    assert.match(text, /1 file git was told to ignore: changed, lines not counted\./);
    assert.match(text, /2 files not read: lines not counted\./);
    assert.doesNotMatch(text, /listed files/);
  });

  it('the heading says what the files changed since: the last shipped version, or the first run before any ship', () => {
    const shipped = root(changedFilesBlock({ ...doc(2), baseKind: 'last-shipped' })).textContent;
    assert.match(shipped, /Changed files since the last shipped version \(3f2a9c1e04b7\) {2}2/);
    assert.match(shipped, /Everything changed since commit 3f2a9c1e04b7/);
    assert.match(shipped, /also holds shipped work that was never committed, and the work of any earlier run that was not shipped/);
    assert.doesNotMatch(shipped, /holds the work of any earlier run that was not shipped\. MOAG/, 'never implies shipped work is left out');
    const first = root(changedFilesBlock({ ...doc(2), baseKind: 'before-first-ship' })).textContent;
    assert.match(first, /Changed files since the first run \(3f2a9c1e04b7\) {2}2/);
    assert.match(first, /Nothing has shipped yet, so the list holds the work of every earlier run/);
    const empty = root(changedFilesBlock({ collected: true, baseRef: null, emptyTreeBase: true, total: 1, files: rows(1) })).textContent;
    assert.match(empty, /Changed files since the empty tree {2}1/);
  });

  it('a path holding markup is text, never an element; binary, untracked, deleted and renamed are words', () => {
    const el = root(changedFilesBlock({
      collected: true, baseRef: null, emptyTreeBase: true, total: 4, files: [
        { path: '<script>alert(1)</script>.ts', added: 1, removed: 0, binary: false, untracked: true },
        { path: 'logo.png', added: null, removed: null, binary: true, untracked: false },
        { path: 'old.md', added: 0, removed: 40, binary: false, untracked: false, deleted: true },
        { path: 'b.ts', added: 3, removed: 3, binary: false, untracked: false, renamedFrom: 'a.ts' },
      ],
    }));
    assert.equal(el.all().some((e) => e.tag === 'script'), false);
    assert.ok(el.all().some((e) => e.childNodes.includes('<script>alert(1)</script>.ts')), 'the path is one text node');
    const text = el.textContent;
    for (const word of ['new (untracked)', 'binary', 'deleted', 'a.ts → b.ts', 'renamed', '1 binary file not counted', 'Since the empty tree']) {
      assert.ok(text.includes(word), word);
    }
    assert.ok(text.includes(' 3 lines added, 3 removed'), 'a sentence for screen readers follows the signs');
  });

  it('a file git was told to ignore is a row with words, never silent, and is named in the totals', () => {
    const el = root(changedFilesBlock({
      collected: true, baseRef: BASE, emptyTreeBase: false, total: 1, files: [
        { path: 'config.ts', added: null, removed: null, binary: false, untracked: false, hiddenFromGit: true },
      ],
    }));
    const text = el.textContent;
    assert.ok(text.includes('hidden from git (skip-worktree or assume-unchanged), lines not counted'), text);
    assert.ok(text.includes('1 file git was told to ignore: changed, lines not counted.'), text);
    assert.doesNotMatch(text, /No files changed/);
  });

  it('the design revert notice: nothing when absent or empty; the files and the backup, or "Backup: not recorded."', () => {
    assert.equal(designRevertNotice({}), null);
    assert.equal(designRevertNotice({ designFilesReplaced: [] }), null);
    const withDir = root(designRevertNotice({ designFilesReplaced: ['DESIGN.md', 'src/styles/tokens.css'], designBackupDir: 'runs/r1/design-replaced' }));
    assert.match(withDir.textContent, /Reverted to the approved design: DESIGN\.md, src\/styles\/tokens\.css\. Backup: runs\/r1\/design-replaced\. These files had changed/);
    assert.equal(withDir.children[0].getAttribute('role'), 'note');
    const noDir = root(designRevertNotice({ designFilesReplaced: ['DESIGN.md'] }));
    assert.match(noDir.textContent, /DESIGN\.md\. Backup: not recorded\. These files/);
  });
});

// ─── Stack suggestion card: every source the server sends (project-form.js) ───

describe('web project form — the stack recommendation card renders every source', () => {
  const STR = webStrings() as { C86: (n: number) => { text: string } };
  const { recommendationCard } = loadWebModule('screens/project-form.js', fakeDomStubs(), ['recommendationCard']) as {
    recommendationCard: (rec: unknown, onUse: (s: string) => void, opts?: Record<string, unknown>) => FakeEl;
  };
  const group = { engine: 'claude', stack: 'go', n: 12, completed: 11, rate: 0.9, wilsonLower: 0.6, wilsonUpper: 0.98, eligible: true, gateRuns: 0 };
  const measured = (state: string) => ({
    source: 'measured', state, stack: 'go', stackSource: 'measured', detectedStack: state === 'detected-differs' ? 'python' : null,
    confidence: state === 'recommended' ? 'low' : null, label: 'x', basis: group, runnerUp: null, groups: [group],
    recordedTasks: 12, excludedNoStack: 0, minPerGroup: 10,
  });
  const STATIC = {
    source: 'static-default', stack: 'node-ts', label: 'Insufficient data — static default', defaultKind: 'static',
    defaultLabel: 'static default, not measured', recordedTasks: 0, excludedNoStack: 0, minPerGroup: 10,
  };
  const PRIOR = {
    source: 'prior', stack: 'node-ts', label: 'based on general model strengths — not yet measured on this server', confidence: 'low',
    enginesConsidered: [{ engine: 'claude', strength: 'strong' }, { engine: 'gemini', strength: 'adequate' }], minPerGroup: 10,
  };
  const noop = (): void => undefined;
  const hasSelect = (el: FakeEl): boolean => el.all().some((e) => e.tag === 'select');

  it('renders every source and every measured state without throwing', () => {
    const recs = [...['recommended', 'single-stack', 'poor-completion', 'detected-differs'].map(measured), STATIC, PRIOR];
    for (const rec of recs) {
      for (const opts of [{}, { detectionSkipped: true, onBuilding: noop }]) {
        assert.ok(recommendationCard(rec, noop, opts) instanceof FakeEl, JSON.stringify(rec).slice(0, 60));
      }
    }
  });

  it('the prior card: "Suggested stack", LOW CONFIDENCE, the label verbatim, and no number beyond the threshold sentence', () => {
    const card = recommendationCard(PRIOR, noop, { onBuilding: noop });
    const text = card.textContent;
    assert.match(text, /^Suggested stack/);
    assert.match(text, /LOW CONFIDENCE/);
    assert.ok(text.includes(PRIOR.label));
    assert.match(text, /Engines considered: claude, gemini/);
    assert.match(text, /claude · node-ts: strong/);
    assert.doesNotMatch(text, /Recommended/);
    assert.doesNotMatch(text, /%/);
    // The only figure is how many tasks it takes for measured results to replace it.
    assert.doesNotMatch(text.replace(STR.C86(10).text, ''), /\d/);
  });

  it('the "What are you building?" select appears only on the prior card', () => {
    assert.equal(hasSelect(recommendationCard(PRIOR, noop, { onBuilding: noop })), true);
    for (const rec of [STATIC, measured('recommended'), measured('single-stack')]) {
      assert.equal(hasSelect(recommendationCard(rec, noop, { onBuilding: noop })), false);
    }
  });

  it('a folder that is not valid yet says the repository was not checked, on any card', () => {
    for (const rec of [PRIOR, STATIC, measured('recommended')]) {
      assert.match(recommendationCard(rec, noop, { detectionSkipped: true }).textContent, /Repository not checked: the folder isn't valid yet\./);
      assert.doesNotMatch(recommendationCard(rec, noop, {}).textContent, /Repository not checked/);
    }
  });

  it('a detected stack the prior would not pick: said beside it, the detected stack still offered', () => {
    const text = recommendationCard({ ...STATIC, stack: 'java', defaultKind: 'detected', defaultLabel: 'detected from repository files', priorSuggests: 'node-ts' }, noop).textContent;
    assert.match(text, /General model strengths would suggest node-ts\. Your repository looks like java, so java is offered\./);
    assert.match(text, /Use java/);
  });
});

// ─── New-project form: the Folder field's pure helpers (project-form.js) ───

describe('web project form — folder name helpers', () => {
  const form = loadWebModule('screens/project-form.js', fakeDomStubs(), ['slugify', 'classifyFolder', 'composeFullPath']) as {
    slugify: (name: string) => string;
    classifyFolder: (value: string, root: string | null) => { kind: string; rel?: string };
    composeFullPath: (root: string, rel: string) => string;
  };
  const plainOf = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  it('slugify: lowercase, runs of other characters become one dash, ends trimmed, at most 64 characters', () => {
    const cases: Array<[string, string]> = [
      ['Acme Checkout', 'acme-checkout'],
      ['  Acme   Checkout!! ', 'acme-checkout'],
      ['Café Ünïcode', 'caf-n-code'],
      ['.hidden.', 'hidden'],
      ['--x--', 'x'],
      ['v1.2_beta', 'v1.2_beta'],
      ['', ''],
      ['!!!', ''],
      ['a'.repeat(70), 'a'.repeat(64)],
      [`${'a'.repeat(63)} b`, 'a'.repeat(63)],
    ];
    for (const [input, out] of cases) { assert.equal(form.slugify(input), out, input); }
  });

  it('classifyFolder against a POSIX root', () => {
    const root = '/srv/x';
    const cases: Array<[string, { kind: string; rel?: string }]> = [
      ['acme', { kind: 'relative', rel: 'acme' }],
      ['acme/web/', { kind: 'relative', rel: 'acme/web' }],
      ['/srv/x/acme', { kind: 'inside-root', rel: 'acme' }],
      ['/srv/x', { kind: 'is-root' }],
      ['/srv/x/', { kind: 'is-root' }],
      ['/projects', { kind: 'outside-root' }],
      ['/srv/xy/acme', { kind: 'outside-root' }],
      ['../etc', { kind: 'dotdot' }],
      ['/srv/x/a/../../etc', { kind: 'dotdot' }],
      ['foo/Q:x', { kind: 'colon' }],
      ['foo/C:bar', { kind: 'colon' }],
      ['foo:bar', { kind: 'colon' }],
      ['/srv/x/a/Q:x', { kind: 'colon' }],
      ['.', { kind: 'is-root' }],
      ['   ', { kind: 'empty' }],
    ];
    for (const [value, out] of cases) { assert.deepEqual(plainOf(form.classifyFolder(value, root)), out, value); }
  });

  it('classifyFolder: a root of /projects, and a Windows root compared without case', () => {
    assert.deepEqual(plainOf(form.classifyFolder('/projects/acme', '/projects')), { kind: 'inside-root', rel: 'acme' });
    assert.deepEqual(plainOf(form.classifyFolder('/projects', '/projects')), { kind: 'is-root' });
    const win = 'C:\\data\\p';
    assert.deepEqual(plainOf(form.classifyFolder('c:/DATA/p/a', win)), { kind: 'inside-root', rel: 'a' });
    assert.deepEqual(plainOf(form.classifyFolder(win, win)), { kind: 'is-root' });
    assert.deepEqual(plainOf(form.classifyFolder('D:\\other', win)), { kind: 'outside-root' });
    assert.deepEqual(plainOf(form.classifyFolder('\\\\server\\share', win)), { kind: 'outside-root' });
    assert.deepEqual(plainOf(form.classifyFolder('/srv/x/Acme', '/srv/x')), { kind: 'inside-root', rel: 'Acme' });
    assert.deepEqual(plainOf(form.classifyFolder('/SRV/x/acme', '/srv/x')), { kind: 'outside-root' }, 'a POSIX root keeps case');
  });

  it('classifyFolder refuses the names the server refuses because Windows would open another folder', () => {
    const root = '/srv/x';
    for (const bad of ['...', 'team/...', 'a./b', 'a /b', 'x/ a', 'team/b.', 'CON', 'x/nul.txt', 'com1', 'LPT9.log', 'a?b', 'a*b', 'a<b', 'a|b', 'a"b', 'a\tb/c', '/srv/x/.../y']) {
      const c = plainOf(form.classifyFolder(bad, root)) as { kind: string; reason?: string };
      assert.equal(c.kind, 'bad-name', JSON.stringify(bad));
      assert.ok(c.reason && c.reason.length > 0, JSON.stringify(bad));
    }
    // The whole value is trimmed first, so the name sent never carries the outer spaces.
    assert.deepEqual(plainOf(form.classifyFolder(' .. ', root)), { kind: 'dotdot' });
    assert.deepEqual(plainOf(form.classifyFolder('a ', root)), { kind: 'relative', rel: 'a' });
    for (const good of ['my app', 'v1.2', '.hidden', 'console', 'com10', 'nul-check']) {
      assert.equal(plainOf(form.classifyFolder(good, root)).kind, 'relative', good);
    }
  });

  it('composeFullPath uses the root\'s own separator', () => {
    assert.equal(form.composeFullPath('/srv/x', 'acme/web'), '/srv/x/acme/web');
    assert.equal(form.composeFullPath('/srv/x/', 'acme'), '/srv/x/acme');
    assert.equal(form.composeFullPath('C:\\data\\p', 'acme/web'), 'C:\\data\\p\\acme\\web');
  });
});

// ─── New-project form wiring: renderCreate with the Folder assist, in a fake DOM ───

describe('web project form — renderCreate wires Name, Folder and the checks', () => {
  const ROOT = '/srv/moag/projects';
  interface Api { method: string; url: string; body: unknown }
  /** renderCreate mounted into a fake view, with a fake clock for the folder check's debounce. */
  function mountCreate(folderStatus: (url: string) => Record<string, unknown> = () => ({ status: 'ok', fullPath: null })) {
    const calls: Api[] = [];
    const timers: Array<() => void> = [];
    let uid = 0;
    const stubs = fakeDomStubs();
    const fakeH = stubs.h as (tag: string, attrs: Record<string, unknown> | null, ...c: unknown[]) => FakeEl;
    const field = (opts: { label: string; input: FakeEl; hint?: string }) => {
      const id = `f${++uid}`;
      (opts.input as unknown as { id: string }).id = id;
      const err = fakeH('p', { class: 'field-error' });
      const wrap = fakeH('div', { class: 'field' }, fakeH('label', { for: id }, opts.label), opts.input,
        opts.hint ? fakeH('p', { class: 'hint' }, opts.hint) : null, err);
      return { wrap, input: opts.input, setError: (msg: string) => { err.textContent = msg || ''; } };
    };
    const mount = (host: FakeEl, ...children: unknown[]): void => {
      host.childNodes.splice(0, host.childNodes.length);
      for (const c of children.flat()) { if (c instanceof FakeEl || typeof c === 'string') { host.appendChild(c); } }
    };
    const app = {
      setTitle: () => undefined,
      can: () => true,
      navigate: () => undefined,
      session: { meta: { engines: ['claude'], stacks: ['node-ts'], projectsRoot: ROOT } },
      api: async (method: string, url: string, body?: unknown) => {
        calls.push({ method, url, body });
        if (url.startsWith('/api/projects/folder-check')) { return { ok: true, status: 200, body: folderStatus(url) }; }
        if (method === 'POST') { return { ok: true, status: 201, body: { project: { id: 'p1', name: 'x' } } }; }
        return { ok: false, status: 500, body: {} };
      },
    };
    const mod = loadWebModule('screens/project-form.js', {
      ...stubs, field, mount, toast: () => undefined, skeleton: () => fakeH('div', null), confirmDialog: () => undefined,
      fmtUsd: (n: number) => `$${n}`, serverMessage: () => 'error',
      document: { createTextNode: (t: string) => t, activeElement: null, getElementById: () => null },
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
      clearTimeout: () => undefined,
    }, ['renderCreate']) as { renderCreate: (app: unknown, params: unknown, view: FakeEl) => void };
    const view = fakeH('div', null);
    mod.renderCreate(app, {}, view);
    const inputs = view.all().filter((e) => e.tag === 'input');
    const name = inputs.find((e) => e.getAttribute('maxlength') === '80')!;
    const folder = inputs.find((e) => e.getAttribute('maxlength') === '1024')!;
    const radio = (value: string) => inputs.find((e) => e.getAttribute('type') === 'radio' && e.value === value)!;
    const dds = view.all().filter((e) => e.tag === 'dd');
    const folderWrap = view.all().find((e) => e.tag === 'div' && e.className === 'field' && e.children.includes(folder))!;
    const fire = (el: FakeEl, ev: string, arg?: unknown) =>
      Promise.all((el.listeners[ev] ?? []).map((fn) => (fn as (a?: unknown) => unknown)(arg)));
    const type = async (el: FakeEl, value: string) => { el.value = value; await fire(el, 'input'); };
    const flush = async () => {
      while (timers.length > 0) { timers.shift()!(); }
      await new Promise((r) => setImmediate(r));
    };
    const form = view.all().find((e) => e.tag === 'form')!;
    const submit = () => fire(form, 'submit', { preventDefault: () => undefined });
    const choose = async (value: string) => {
      for (const v of ['path', 'clone', 'new']) { radio(v).checked = v === value; }
      await fire(radio(value), 'change');
    };
    return {
      calls, name, folder, choose, type, flush, submit,
      rootText: () => dds[0].textContent,
      fullText: () => dds[1].textContent,
      folderError: () => folderWrap.byClass('field-error')[0].textContent,
      posts: () => JSON.parse(JSON.stringify(calls.filter((c) => c.method === 'POST'))) as Api[],
      checks: () => calls.filter((c) => c.url.startsWith('/api/projects/folder-check')).map((c) => c.url),
      statusText: () => view.all().filter((e) => e.getAttribute('role') === 'status').map((e) => e.textContent).join(' '),
    };
  }

  it('Name fills Folder until the Folder is edited by hand; after that the Name no longer touches it', async () => {
    const f = mountCreate();
    await f.type(f.name, 'Acme Checkout');
    assert.equal(f.folder.value, 'acme-checkout');
    assert.equal(f.fullText(), `${ROOT}/acme-checkout`);
    await f.type(f.name, 'Acme Checkout v2');
    assert.equal(f.folder.value, 'acme-checkout-v2', 'still following the name');
    await f.type(f.folder, 'my-own');
    await f.type(f.name, 'Something else');
    assert.equal(f.folder.value, 'my-own', 'a manual edit stops the prefill for good');
  });

  it('the projects root is shown, and the full path follows every keystroke', async () => {
    const f = mountCreate();
    assert.equal(f.rootText(), ROOT);
    for (const value of ['a', 'ac', 'acm', 'acme/web']) {
      await f.type(f.folder, value);
      assert.equal(f.fullText(), `${ROOT}/${value}`, value);
    }
    await f.type(f.folder, '');
    assert.equal(f.fullText(), `${ROOT}/…`);
  });

  it('an absolute path outside the root, and the root itself, are refused inline and nothing is sent', async () => {
    for (const mode of ['path', 'new']) {
      const f = mountCreate();
      await f.choose(mode);
      await f.type(f.name, 'Acme');
      await f.type(f.folder, '/etc/elsewhere');
      assert.match(f.folderError(), /is not inside the projects root/, mode);
      await f.submit();
      assert.deepEqual(f.posts(), [], `${mode}: an absolute path outside the root blocks the submit`);
      await f.type(f.folder, ROOT);
      assert.match(f.folderError(), /That is the projects root itself/, mode);
      await f.submit();
      await f.type(f.folder, `${ROOT}/`);
      await f.submit();
      assert.deepEqual(f.posts(), [], `${mode}: the root itself blocks the submit`);
      // The prefill from the name was checked; neither refused value ever was.
      await f.flush();
      assert.ok(f.checks().every((u) => /path=acme(&|$)/.test(u)), f.checks().join(', '));
    }
  });

  it('a folder name with a colon in a later segment is refused inline, never checked and never sent', async () => {
    for (const mode of ['path', 'new']) {
      const f = mountCreate();
      await f.choose(mode);
      await f.type(f.name, 'Acme');
      await f.flush();
      const before = f.checks().length;
      for (const bad of ['foo/Q:x', 'foo/C:bar', 'foo:bar']) {
        await f.type(f.folder, bad);
        assert.match(f.folderError(), /must not contain ":"/, `${mode} ${bad}`);
        await f.flush();
        await f.submit();
      }
      assert.equal(f.checks().length, before, `${mode}: no folder check was sent for a colon`);
      assert.deepEqual(f.posts(), [], `${mode}: a colon blocks the submit`);
    }
  });

  it('a name Windows would normalise ("...", "team/...", "a.", "CON") is refused inline, never checked and never sent', async () => {
    for (const mode of ['path', 'new']) {
      const f = mountCreate();
      await f.choose(mode);
      await f.type(f.name, 'Acme');
      await f.flush();
      const before = f.checks().length;
      for (const [bad, why] of [['...', /only dots/], ['team/...', /only dots/], ['a.', /end with a space or a dot/], ['CON', /reserved device name/]] as const) {
        await f.type(f.folder, bad);
        assert.match(f.folderError(), why, `${mode} ${bad}`);
        await f.flush();
        await f.submit();
      }
      assert.equal(f.checks().length, before, `${mode}: no folder check was sent`);
      assert.deepEqual(f.posts(), [], `${mode}: the name blocks the submit`);
    }
  });

  it('a valid folder is checked after the debounce (mode=new for a new project), and submits the chosen source', async () => {
    const f = mountCreate((url) => (url.includes('mode=new')
      ? { status: 'will-create', fullPath: `${ROOT}/fresh` } : { status: 'ok', fullPath: `${ROOT}/fresh` }));
    await f.type(f.name, 'Fresh');
    await f.flush();
    assert.deepEqual(f.checks(), ['/api/projects/folder-check?path=fresh']);
    await f.choose('new');
    await f.flush();
    assert.equal(f.checks().at(-1), '/api/projects/folder-check?path=fresh&mode=new');
    assert.match(f.statusText(), /New folder\. The server creates it/);
    await f.submit();
    assert.deepEqual(f.posts().map((c) => (c.body as { source: unknown }).source), [{ kind: 'new', path: 'fresh' }]);
  });

  it('a not-empty folder in new mode is said on the status line', async () => {
    const f = mountCreate(() => ({ status: 'not-empty', fullPath: `${ROOT}/acme` }));
    await f.choose('new');
    await f.type(f.folder, 'acme');
    await f.flush();
    assert.match(f.statusText(), /already exists and is not empty/);
  });

  it('an absolute path INSIDE the root is turned into its relative name on submit, never sent as typed', async () => {
    const f = mountCreate();
    await f.type(f.name, 'Acme');
    await f.type(f.folder, `${ROOT}/acme/web`);
    assert.equal(f.folderError(), '');
    await f.submit();
    assert.deepEqual(f.posts().map((c) => (c.body as { source: unknown }).source), [{ kind: 'path', path: 'acme/web' }]);
  });
});
