// ─── Standards lexer — comments vs code, and refusing to guess ───

import { strict as assert } from 'assert';
import { LexedLine, MAX_LEX_BYTES, fileExtension, languageFamily, lexFile } from '../../../standards/lexer';

function lex(file: string, lines: string[]): LexedLine[] {
  const result = lexFile(file, lines.join('\n'));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.lines;
}

function reasonOf(file: string, content: string): string {
  const result = lexFile(file, content);
  assert.equal(result.ok, false, 'expected the lexer to refuse');
  return result.ok ? '' : result.reason;
}

/** Lines (1-based) that carry any comment. */
function commentLines(lines: LexedLine[]): number[] {
  return lines.map((l, i) => (l.comment !== '' ? i + 1 : 0)).filter((n) => n > 0);
}

describe('standards lexer — language selection', () => {
  it('maps the supported extensions onto four families', () => {
    for (const ext of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'java', 'cs', 'go']) {
      assert.equal(languageFamily(`a/b.${ext}`), 'c-like', ext);
    }
    assert.equal(languageFamily('x.py'), 'python');
    assert.equal(languageFamily('x.HTML'), 'html');
    assert.equal(languageFamily('x.css'), 'css');
    assert.equal(languageFamily('x.rs'), null);
    assert.equal(languageFamily('Makefile'), null);
    assert.equal(fileExtension('.gitignore'), '', 'a dotfile has no extension');
    assert.equal(fileExtension('a\\b\\c.Test.TS'), 'ts');
  });

  it('refuses an unsupported extension, an oversize file and binary content', () => {
    assert.match(reasonOf('main.rs', '// hi'), /No checker for \.rs files/);
    assert.match(reasonOf('Makefile', 'all:'), /without an extension/);
    assert.match(reasonOf('big.ts', 'a'.repeat(MAX_LEX_BYTES + 1)), /larger than 512 KB/);
    assert.match(reasonOf('bin.ts', `const a = 1;${String.fromCharCode(0)}`), /Binary content/);
  });
});

describe('standards lexer — c-like', () => {
  it('does not treat // inside single-quoted, double-quoted or template strings as a comment', () => {
    const lines = lex('a.ts', [
      'const a = \'//not\';',
      'const b = "// not";',
      'const c = `// not ${a + "//x"} still // not`;',
      'const d = `multi',
      '// still inside the template',
      '`;',
    ]);
    assert.deepEqual(commentLines(lines), []);
    assert.equal(lines[4].code, '// still inside the template');
  });

  it('keeps URLs in strings as code and separates a trailing comment', () => {
    const lines = lex('a.ts', ['const url = "http://example.com/a"; // fetch target']);
    assert.equal(lines[0].code, 'const url = "http://example.com/a"; ');
    assert.equal(lines[0].comment, ' fetch target');
    assert.equal(lines[0].isDoc, false);
  });

  it('classifies a shebang, a licence block and a /** */ doc block', () => {
    const lines = lex('cli.js', [
      '#!/usr/bin/env node',
      '/*',
      ' * Copyright (c) Acme.',
      ' */',
      '/**',
      ' * Adds two numbers.',
      ' */',
      'function add(a, b) { return a + b; }',
      '/// triple-slash doc',
      '//// a divider, not documentation',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 4, 5, 6, 7, 9, 10]);
    assert.deepEqual(lines.map((l) => l.isDoc), [false, false, false, false, true, true, true, false, true, false]);
    assert.equal(lines[7].comment, '');
    assert.equal(lines[5].comment, ' * Adds two numbers.');
  });

  it('treats /**/ as an empty ordinary comment and an empty // as a comment line', () => {
    const lines = lex('a.ts', ['/**/ const a = 1;', '//']);
    assert.equal(lines[0].isDoc, false);
    assert.equal(lines[0].code, ' const a = 1;');
    assert.notEqual(lines[1].comment, '', 'an empty comment still marks the line');
  });

  it('follows ${} nesting, including a template inside an interpolation', () => {
    const lines = lex('a.ts', [
      'const s = `a ${ fn({ k: `in ${1 /* c */} ner` }) } b`; // tail',
    ]);
    assert.equal(lines[0].comment, ' c  tail');
  });

  it('reads regex literals so quotes and // inside them do not derail the line', () => {
    const lines = lex('a.ts', [
      'const re = /["\'`]\\/\\//g; // real comment',
      'const ok = x.filter((l) => /^https?:\\/\\//.test(l));',
      'const half = total / 2; // division',
      'const y = (a + b) / c / d;',
      'return /[/"]/.test(s);',
    ]);
    assert.deepEqual(commentLines(lines), [1, 3]);
  });

  it('does not mistake JSX closing tags for regex literals', () => {
    const lines = lex('a.tsx', [
      'const el = <div className="x"><br /><Foo bar={1} /></div>; // jsx',
      'const el2 = cond ? <a href="http://x.dev">link</a> : null;',
    ]);
    assert.deepEqual(commentLines(lines), [1]);
  });

  it('refuses an unterminated template string', () => {
    assert.match(reasonOf('a.ts', 'const a = `never closed\nconst b = 1;\n'), /unterminated template string/);
    assert.match(reasonOf('a.ts', 'const a = `x ${ y '), /unterminated template string/);
  });

  it('refuses an unterminated quote, block comment and regex, naming the line', () => {
    assert.match(reasonOf('a.ts', 'const a = 1;\nconst b = "open\nconst c = 2;'), /unterminated string on line 2/);
    assert.match(reasonOf('a.java', 'int a;\n/* never closed'), /unterminated comment on line 2/);
    assert.match(reasonOf('a.js', 'const re = /abc\nfoo();'), /regular expression that does not close on line 1/);
    assert.match(reasonOf('a.ts', 'const a = "ends in backslash\\'), /unterminated string/);
  });

  it('handles Go raw strings and runes', () => {
    const lines = lex('a.go', [
      'var q = `SELECT 1 -- // not a comment',
      'still raw "quote`',
      'var r = \'"\' // rune holding a quote',
      'var s = \'\\\'\'',
    ]);
    assert.deepEqual(commentLines(lines), [3]);
    assert.match(reasonOf('b.go', 'var q = `open'), /unterminated raw string/);
  });

  it('handles C# verbatim strings and Java text blocks', () => {
    const cs = lex('a.cs', [
      'var p = @"C:\\dir\\ // not a comment',
      'second ""quoted"" line";',
      'var q = 1; // comment',
    ]);
    assert.deepEqual(commentLines(cs), [3]);
    const java = lex('A.java', [
      'String s = """',
      '    // inside a text block "quoted"',
      '    """;',
      'int x; // comment',
    ]);
    assert.deepEqual(commentLines(java), [4]);
  });

  it('does not treat a backtick as a string in Java', () => {
    const lines = lex('A.java', ['char c = \'`\'; // tick', 'int a = 1;']);
    assert.deepEqual(commentLines(lines), [1]);
  });

  it('strips CRLF so line numbers match the file', () => {
    const result = lexFile('a.ts', 'const a = 1; // one\r\nconst b = 2;\r\n// three\r\n');
    assert.ok(result.ok);
    assert.equal(result.lines.length, 4);
    assert.equal(result.lines[0].comment, ' one');
    assert.equal(result.lines[2].comment, ' three');
    assert.ok(result.lines.every((l) => !l.code.includes('\r') && !l.comment.includes('\r')));
  });

  it('refuses a template nested past the depth cap instead of overflowing the stack', () => {
    const deep = 'const s = ' + '`${'.repeat(40) + '1' + '}`'.repeat(40) + ';';
    assert.match(reasonOf('a.ts', deep), /nested too deeply/);
  });
});

describe('standards lexer — python', () => {
  it('separates # comments from strings, docstrings and a shebang', () => {
    const lines = lex('a.py', [
      '#!/usr/bin/env python3',
      '"""Module docstring with a # hash and http://url."""',
      'x = "# not a comment"  # real',
      'y = \'it\\\'s # fine\'',
      'z = """',
      '# inside triple quotes',
      '"""',
    ]);
    assert.deepEqual(commentLines(lines), [1, 3]);
    assert.equal(lines[2].comment, ' real');
  });

  it('refuses an unterminated string but follows a backslash continuation', () => {
    assert.match(reasonOf('a.py', 'x = "open\ny = 1'), /unterminated string on line 1/);
    assert.match(reasonOf('a.py', 'x = """open\ny = 1'), /unterminated string/);
    const lines = lex('a.py', ['x = "one \\', 'two"  # c']);
    assert.deepEqual(commentLines(lines), [2]);
  });
});

describe('standards lexer — html and css', () => {
  it('reads <!-- -->, and lexes inline script and style bodies as the languages they are', () => {
    const lines = lex('index.html', [
      '<!-- banner -->',
      '<script>',
      '  // js comment',
      '  const s = "<!-- not html -->"; /* tail */',
      '</script>',
      '<style>/* css comment */ .a { content: "/* not */"; }</style>',
      '<p>text</p> <!-- trailing',
      'second line -->',
      '<SCRIPT type="module" data-x="a>b">',
      'import "./a.js"; // module comment',
      '</SCRIPT>',
    ]);
    assert.deepEqual(commentLines(lines), [1, 3, 4, 6, 7, 8, 10]);
    assert.equal(lines[2].comment, ' js comment');
    assert.equal(lines[3].code, '  const s = "<!-- not html -->"; ');
    assert.equal(lines[5].comment, ' css comment ');
    assert.equal(lines[9].comment, ' module comment');
    assert.match(reasonOf('x.html', '<p>a</p>\n<!-- never closed'), /unterminated comment on line 2/);
  });

  it('keeps line numbers through a script body and reads to end of file when the body never closes', () => {
    const lines = lex('index.html', ['<html>', '<script>', 'const a = `', '// inside a template', '`;', '', '// real', 'function a() {}']);
    assert.deepEqual(commentLines(lines), [7]);
    assert.equal(lines.length, 8);
  });

  it('carries JSON data blocks and src-only scripts as code: they hold no comment', () => {
    const lines = lex('index.html', [
      '<script type="application/ld+json">{ "url": "https://x.dev//a" }</script>',
      '<script type="importmap">{ "imports": { "a": "/a.js" } }</script>',
      '<script src="js/app.js" type="text/plain"></script>',
      '<scripted>// not a script element</scripted>',
    ]);
    assert.deepEqual(commentLines(lines), []);
  });

  it('refuses the file when an inline script or style cannot be read, instead of calling it code', () => {
    assert.match(
      reasonOf('x.html', '<p>a</p>\n<script type="text/x-handlebars">\n{{! note }}\n</script>'),
      /inline <script> of type "text\/x-handlebars" cannot be read/,
    );
    assert.match(reasonOf('x.html', '<script>\nconst s = "open\n</script>'), /unterminated string on line 2/);
    assert.match(reasonOf('x.html', '<style>\n.a { color: red; }\n/* open\n</style>'), /unterminated comment on line 3/);
    assert.match(reasonOf('x.html', '<p>a</p>\n<script src="a.js'), /unterminated <script> tag on line 2/);
  });

  // The scanner used to look for tags in a lower-cased COPY of the file and cut the original
  // at the indexes it found there. `İ` (U+0130) lower-cases to two code units, so every index
  // after one was off by one: an opening tag was missed, or a body was cut in the wrong place.
  it('cuts the file at indexes taken from the file itself: a character that changes length when lower-cased shifts nothing', () => {
    const page = [
      '<p>İstanbul, İzmir, İİİ</p>',
      '<script>',
      '// rest of the code',
      'const a = 1;',
      '</script>',
      '<p>İ after</p> <!-- tail -->',
      '<STYLE>/* css İ */ .a { color: red; }</STYLE>',
      '<Script>const b = 2; // İ in a script</Script><!-- end -->',
    ];
    const lines = lex('index.html', page);
    assert.deepEqual(commentLines(lines), [3, 6, 7, 8]);
    assert.equal(lines[2].comment, ' rest of the code');
    assert.equal(lines[2].code, '', 'the comment line of the script body holds no code');
    assert.equal(lines[4].code, '</script>', 'the body ends exactly where its closing tag starts');
    assert.equal(lines[5].comment, ' tail ');
    assert.equal(lines[6].comment, ' css İ ');
    assert.deepEqual(lines[7].parts.map((p) => p.text), [' İ in a script', ' end ']);
    // Every character of the file is accounted for once, as code or as comment text.
    assert.deepEqual(lines.map((l) => l.code.length + l.parts.reduce((n, p) => n + p.text.length, 0) > 0), page.map(() => true));
    // The same page without the dotted capitals is read identically, line for line.
    const plain = lex('index.html', page.map((l) => l.replace(/İ/g, 'I')));
    assert.deepEqual(commentLines(plain), commentLines(lines));
  });

  it('a tag name is ASCII case-insensitive and nothing more: a look-alike letter opens and closes nothing', () => {
    // U+017F (long s) upper-cases to S; it is not the letter s, and `<ſcript>` is not a script element.
    const lines = lex('index.html', ['<\u017fcript>// not a script</\u017fcript>', '<script>', 'const s = "</\u017fcript>"; // still inside', '</SCRIPT>', '<!-- after -->']);
    assert.deepEqual(commentLines(lines), [3, 5]);
    assert.equal(lines[2].comment, ' still inside');
    assert.match(lines[0].code, /not a script/, 'text of an unknown element is carried as code, as before');
  });

  it('reads /* */ in css and ignores comment markers inside strings and urls', () => {
    const lines = lex('a.css', [
      '/* header */',
      '.a { content: "/* not */"; background: url(http://x.dev/a.png); }',
      '.b { color: red; } /* tail */',
    ]);
    assert.deepEqual(commentLines(lines), [1, 3]);
    assert.match(reasonOf('b.css', '.a { color: red; }\n/* open'), /unterminated comment/);
    assert.match(reasonOf('c.css', '.a { content: "open\n}'), /unterminated string/);
  });
});

// Each of these used to be mis-read silently: the comment after the slash (or after the
// apostrophe) was taken for code, so a comment rule passed on text it never saw.
describe('standards lexer — a slash that divides is not a regular expression', () => {
  it('reads the comment after a division that follows a non-null assertion or a postfix increment', () => {
    const lines = lex('a.ts', [
      'const half = total! / 2; // halved',
      'const next = i++ / 2; // stepped',
      'const prev = count-- / step; // back',
      'const mean = items[0]! / n!; // mean',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 4]);
    assert.deepEqual(lines.map((l) => l.comment), [' halved', ' stepped', ' back', ' mean']);
    assert.equal(lines[0].code, 'const half = total! / 2; ');
  });

  it('reads the comment after a division by a property that is named like a keyword', () => {
    const lines = lex('a.ts', [
      'const x = obj.in / 2; // rest of the code',
      'this.of / 2; // rest of the code',
      'const y = a?.typeof / b.new / 3; // chained',
      'const z = "in" in obj ? 1 : 2; // operator',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 4]);
    assert.deepEqual(lines.map((l) => l.comment), [' rest of the code', ' rest of the code', ' chained', ' operator']);
    assert.equal(lines[0].code, 'const x = obj.in / 2; ');
  });

  it('reads the comment after a division by a keyword-named property that carries a non-null assertion', () => {
    const lines = lex('a.ts', [
      'const x = obj.in! / 2; // rest of the code',
      'this.of! / 2; // rest of the code',
      'const y = a?.typeof! / b.new! / 3; // chained',
      'const z = cfg.delete! / (n + 1); // paren',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 4]);
    assert.deepEqual(lines.map((l) => l.comment), [' rest of the code', ' rest of the code', ' chained', ' paren']);
    assert.equal(lines[0].code, 'const x = obj.in! / 2; ');
    // The keyword itself, negated, still introduces a regular expression.
    const negated = lex('a.ts', ['if (k in !/x\/\/y/.test(s)) { run(); } // keys', 'return typeof !/"/.test(s); // kind']);
    assert.deepEqual(negated.map((l) => l.comment), [' keys', ' kind']);
  });

  it('still reads a regular expression after the keyword itself', () => {
    const lines = lex('a.ts', ['for (const k in /a\\/\\/b/.exec(s) ?? {}) { use(k); } // keys', 'return typeof /"/.source; // kind']);
    assert.deepEqual(commentLines(lines), [1, 2]);
    assert.deepEqual(lines.map((l) => l.comment), [' keys', ' kind']);
  });

  it('still reads a negated regular expression as one', () => {
    const lines = lex('a.ts', [
      'if (!/^https?:\\/\\//.test(url)) { fail(); } // not a link',
      'return !/["\']/.test(s); // no quotes',
      'const ok = a && !/\\/\\//.test(b); // no slashes',
      'const n = 1 + +/\\d+/.exec(s)![0]; // unary plus',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 4]);
    assert.deepEqual(lines.map((l) => l.comment), [' not a link', ' no quotes', ' no slashes', ' unary plus']);
  });

  it('refuses the file where a slash may be either, instead of guessing', () => {
    assert.match(reasonOf('a.ts', 'function f() {}\n/re/.test(x); // c\n'), /"\/" after "}" may divide or open a regular expression on line 2/);
    assert.match(reasonOf('a.js', 'const x = {} / 2; // c\n'), /"\/" after "}"/);
    assert.match(reasonOf('a.ts', 'x = ++/re/.lastIndex; // c\n'), /"\/" after "\+\+" could not be read on line 1/);
  });

  it('a comment straight after a closing brace is still a comment', () => {
    const lines = lex('a.ts', ['function f() {} // done', 'const o = {}; /* empty */', 'if (a) { b(); } /* c */ else { d(); }']);
    assert.deepEqual(commentLines(lines), [1, 2, 3]);
  });
});

describe('standards lexer — JSX', () => {
  it('an apostrophe in JSX text opens no string', () => {
    for (const file of ['a.tsx', 'a.jsx', 'a.js']) {
      const lines = lex(file, [
        'const el = <p>Don\'t stop</p>; // note',
        'export function App() {',
        '  return (',
        '    <main className="app">',
        '      <h1>It\'s "quoted" text</h1>',
        '      {/* a real comment */}',
        '      <p title="it\'s fine">{count > 0 ? <b>{count}</b> : \'none\'} items</p>',
        '    </main>',
        '  ); // end',
        '}',
      ]);
      assert.deepEqual(commentLines(lines), [1, 6, 9], file);
      assert.equal(lines[0].comment, ' note', file);
      assert.equal(lines[5].code.trim(), '{}', file);
    }
  });

  it('follows fragments, self-closing tags, spread props and arrow-function attributes', () => {
    const lines = lex('a.tsx', [
      'const a = <><Row {...props} onClick={() => go(a > b)} /><input disabled /></>; // one',
      'const b = cond && <Icon name="x" />; // two',
      'const c = items.map((it) => <li key={it.id}>{it.label}\'s</li>); // three',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3]);
  });

  it('a URL in JSX text is text; a comment marker in it is refused', () => {
    const lines = lex('a.tsx', ['const a = <a href="https://x.dev">see https://x.dev/docs</a>; // link']);
    assert.deepEqual(commentLines(lines), [1]);
    assert.match(reasonOf('a.tsx', 'const a = <p>\n  // const x = 1;\n</p>;\n'), /comment marker inside JSX text on line 2/);
    assert.match(reasonOf('a.tsx', 'const a = <p>a /* b */ c</p>;\n'), /comment marker inside JSX text/);
  });

  it('refuses JSX it cannot follow: a closing tag that does not match, an attribute that never closes', () => {
    assert.match(reasonOf('a.tsx', 'const a = <div>\n  <span>x</div>\n</div>;\n'), /JSX closing tag does not match its opening tag on line 2/);
    assert.match(reasonOf('a.tsx', 'const a = (<div className="a>x</div>);\n'), /unterminated/);
  });

  it('TypeScript generics are not JSX', () => {
    const lines = lex('a.tsx', [
      'const id = <T,>(x: T) => x; // generic arrow',
      'const fn: <T>(x: T) => T = id; // generic type',
      'const m = new Map<string, number>(); // type arguments',
      'if (a < b && c > d) { run(); } // comparison',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 4]);
  });

  it('in a .tsx file a constrained type parameter list is read as TypeScript reads it, not refused', () => {
    const lines = lex('a.tsx', [
      'const f = <T extends object>(x: T) => x; // generic arrow',
      'type Pick2 = <T extends object, K extends keyof T>(o: T, k: K) => T[K]; // generic function type',
      'const g: <T extends string = string>(x: T) => T = f; // annotated',
      'export function useIt(cb: <T extends unknown>(v: T) => void) { cb(1); } // parameter',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 4]);
    assert.deepEqual(lines.map((l) => l.comment), [' generic arrow', ' generic function type', ' annotated', ' parameter']);
    // An attribute that happens to be called `extends` is still JSX: only an attribute is followed by `=`, `>` or `/`.
    const jsx = lex('a.tsx', [
      'const a = <Rule extends="base" />; // attribute with a value',
      'const b = <Rule extends>text</Rule>; // bare attribute',
      'const c = <Rule extends />; // bare, self-closed',
    ]);
    assert.deepEqual(jsx.map((l) => l.comment), [' attribute with a value', ' bare attribute', ' bare, self-closed']);
    assert.equal(jsx[1].code, 'const b = <Rule extends>text</Rule>; ');
  });

  it('a generic function type in a type alias is a type, even when the file has an element of the same name', () => {
    const lines = lex('a.tsx', [
      'type Render = <Item>(value: Item) => string; // alias',
      'type Boxed<A> = <Item>(a: A, value: Item) => Item; // generic alias',
      'export const view = <Item>don\'t</Item>; // element',
      'export type Fold =',
      '  <Item>(xs: Item[]) => Item; // on the next line',
    ]);
    assert.deepEqual(commentLines(lines), [1, 2, 3, 5]);
    assert.deepEqual([lines[0].comment, lines[1].comment, lines[2].comment, lines[4].comment], [' alias', ' generic alias', ' element', ' on the next line']);
    assert.equal(lines[2].code, 'export const view = <Item>don\'t</Item>; ', 'the real element is still followed as JSX: its apostrophe opens no string');
  });

  it('where nothing can settle it the file is still refused: a .jsx file has no type parameters to tell an element from', () => {
    assert.match(reasonOf('a.jsx', 'const f = <T extends object>(x) => x; // c\n'), /may open a JSX element or a type parameter list/);
    assert.match(reasonOf('a.js', 'const f = <T extends object>(x) => x; // c\n'), /may open a JSX element or a type parameter list/);
  });

  it('.mts and .cts are TypeScript: no JSX, type assertions and constrained generics are code', () => {
    for (const file of ['a.mts', 'a.cts']) {
      const lines = lex(file, [
        'const el = <HTMLElement>node; // cast',
        'const f = <T extends object>(x: T) => x; // generic arrow',
        'const half = obj.in! / 2; // divided',
        'export default f; /* tail */',
      ]);
      assert.deepEqual(lines.map((l) => l.comment), [' cast', ' generic arrow', ' divided', ' tail '], file);
    }
  });

  it('a plain .ts file has no JSX: a type assertion is code and its line keeps its comment', () => {
    const lines = lex('a.ts', ['const el = <HTMLElement>node; // cast', 'const s = (<Foo>bar).name; // cast too']);
    assert.deepEqual(commentLines(lines), [1, 2]);
  });

  it('refuses JSX nested past the depth cap instead of overflowing the stack', () => {
    const deep = 'const a = ' + '<i>'.repeat(150) + 'x' + '</i>'.repeat(150) + ';';
    assert.match(reasonOf('a.tsx', deep), /nested too deeply/);
  });
});

describe('standards lexer — Go documentation comments', () => {
  const docLines = (lines: LexedLine[]): number[] => lines.map((l, i) => (l.isDoc ? i + 1 : 0)).filter((n) => n > 0);

  it('marks the // run directly above a top-level declaration, and above members of a struct or a group', () => {
    const lines = lex('store.go', [
      '// Package store keeps values.',
      'package store',
      '',
      '// MaxSize is the limit.',
      'const MaxSize = 10',
      '',
      '// Store keeps values on disk.',
      '// It is safe for concurrent use.',
      'type Store struct {',
      '\t// Path is where the data lives.',
      '\tPath string',
      '}',
      '',
      'var (',
      '\t// ErrClosed is returned after Close.',
      '\tErrClosed = errors.New("closed")',
      ')',
      '',
      '// Open returns a store.',
      'func Open(path string) (*Store, error) {',
      '\t// not documentation',
      '\ts := &Store{Path: path}',
      '\treturn s, nil',
      '}',
    ]);
    assert.deepEqual(docLines(lines), [1, 4, 7, 8, 10, 15, 19]);
  });

  it('a blank line, a statement or the end of the file ends the claim', () => {
    const lines = lex('a.go', [
      'package a',
      '',
      '// a free-floating note',
      '',
      'func f() {',
      '\t// above a statement',
      '\tx := "{ not a brace"',
      '\t_ = x',
      '}',
      '// trailing note',
    ]);
    assert.deepEqual(docLines(lines), []);
  });

  it('leaves every other language alone', () => {
    const lines = lex('a.ts', ['// above a function', 'function f() {}']);
    assert.deepEqual(docLines(lines), []);
  });
});
