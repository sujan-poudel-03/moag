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
      'js/screens/prd.js', 'js/screens/standards.js', 'js/screens/version-panel.js', 'js/screens/plan.js', 'js/screens/run.js',
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
