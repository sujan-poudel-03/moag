// ─── Conservative comment/code lexer for the standards checker ───
//
// Whether `//` starts a comment depends on everything above it, so the checker
// never classifies a diff hunk on its own: it lexes the whole new file once and
// then looks only at the added line numbers.
//
// This is not a parser. One single-pass scanner per language family assigns
// every character to code (string literals and JSX text included) or comment.
// Whenever the scanner cannot be sure — an unsupported extension, a string or
// comment still open at end of file, a regex literal it cannot close on its
// line, a `/` that may divide or open a regex, a `<` that may open an element or
// a type parameter list, an inline `<script>` in a language it does not know, an
// oversize or binary file — it returns `ok: false`,
// and the checker reports the affected rules as not checked. It never guesses
// its way to a pass.

/** Largest file lexed. Matches the evidence collector's read cap. */
export const MAX_LEX_BYTES = 512 * 1024;

/** Deepest `${ … }` nesting followed inside template strings. */
const MAX_TEMPLATE_DEPTH = 32;

export interface LexedLine {
  /** The line with comments removed. String literals are kept verbatim. */
  code: string;
  /** Comment text on this line, without its delimiters. Empty when there is none. */
  comment: string;
  /** True when the comment is documentation (a doc block or doc line comment). */
  isDoc: boolean;
  /** True when the comment on this line belongs to one comment that spans several lines. */
  multiline: boolean;
  /**
   * The individual comments that touch this line, in order. `comment` runs them together;
   * here each keeps its own text and the number of the comment it is part of, so a reader
   * can tell `/* a *\/ x /* b *\/` (two comments) from one, and put the lines of one block
   * comment back together.
   */
  parts: CommentPart[];
}

/** The text one comment contributes to one line. */
export interface CommentPart {
  /** Numbers the comments of a file from 1, in source order. Every line of one comment carries the same id. */
  id: number;
  text: string;
}

export type LexResult =
  | { ok: true; lines: LexedLine[] }
  | { ok: false; reason: string };

export type LanguageFamily = 'c-like' | 'python' | 'html' | 'css';

/** The c-like dialects, which differ in string and regex syntax. */
type Dialect = 'js' | 'java' | 'cs' | 'go';

const EXTENSIONS: Record<string, { family: LanguageFamily; dialect?: Dialect }> = {
  ts: { family: 'c-like', dialect: 'js' },
  tsx: { family: 'c-like', dialect: 'js' },
  // TypeScript's ES-module and CommonJS file kinds: the same language as `.ts`, and never JSX.
  mts: { family: 'c-like', dialect: 'js' },
  cts: { family: 'c-like', dialect: 'js' },
  js: { family: 'c-like', dialect: 'js' },
  jsx: { family: 'c-like', dialect: 'js' },
  mjs: { family: 'c-like', dialect: 'js' },
  cjs: { family: 'c-like', dialect: 'js' },
  java: { family: 'c-like', dialect: 'java' },
  cs: { family: 'c-like', dialect: 'cs' },
  go: { family: 'c-like', dialect: 'go' },
  py: { family: 'python' },
  html: { family: 'html' },
  htm: { family: 'html' },
  css: { family: 'css' },
};

/**
 * Extensions whose files may hold JSX. Plain `.ts` is left out on purpose: there a `<` in
 * expression position is a type assertion (`<Foo>value`), never an element.
 */
const JSX_EXTENSIONS = new Set(['tsx', 'jsx', 'js']);

/** Extensions whose files are TypeScript: a `<T extends …>` there is a type parameter list. */
const TYPESCRIPT_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts']);

/**
 * `type Name =` or `type Name<A, B> =` running up to the position it is tested at: what
 * follows is a type, whatever it looks like.
 */
const TYPE_ALIAS_HEAD = /(?:^|[\s;{}])type\s+[A-Za-z_$][\w$]*\s*(?:<[^=;{}()]*>)?\s*=\s*$/;
/** How far back a type alias head is looked for. */
const MAX_TYPE_ALIAS_HEAD_CHARS = 300;

/** Lower-cased extension without the dot, or '' when the file name has none. */
export function fileExtension(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The family that lexes `filePath`, or null when no lexer exists for it. */
export function languageFamily(filePath: string): LanguageFamily | null {
  return EXTENSIONS[fileExtension(filePath)]?.family ?? null;
}

/** Thrown inside a scanner to abandon the file; never escapes {@link lexFile}. */
class Ambiguous extends Error {}

/** Accumulates per-line code and comment text as a scanner walks the file. */
class Sink {
  private readonly code: string[] = [''];
  private readonly comment: string[] = [''];
  private readonly hasComment: boolean[] = [false];
  private readonly doc: boolean[] = [false];
  private readonly multi: boolean[] = [false];
  private readonly parts: CommentPart[][] = [[]];
  private line = 0;
  private comments = 0;

  /** 1-based number of the line currently being written. */
  get lineNumber(): number { return this.line + 1; }

  private newline(): void {
    this.line++;
    this.code.push('');
    this.comment.push('');
    this.hasComment.push(false);
    this.doc.push(false);
    this.multi.push(false);
    this.parts.push([]);
  }

  putCode(text: string): void {
    for (const ch of text) {
      if (ch === '\n') { this.newline(); } else { this.code[this.line] += ch; }
    }
  }

  /** One whole comment, delimiters removed. Every call is a comment of its own. */
  putComment(text: string, isDoc: boolean): void {
    const id = ++this.comments;
    this.markComment(isDoc);
    if (text.includes('\n')) { this.multi[this.line] = true; }
    let part: CommentPart = { id, text: '' };
    this.parts[this.line].push(part);
    for (const ch of text) {
      if (ch === '\n') {
        this.newline();
        this.markComment(isDoc);
        this.multi[this.line] = true;
        part = { id, text: '' };
        this.parts[this.line].push(part);
      } else {
        this.comment[this.line] += ch;
        part.text += ch;
      }
    }
  }

  /** Record that a comment touches the current line, even if it contributes no text. */
  markComment(isDoc: boolean): void {
    this.hasComment[this.line] = true;
    if (isDoc) { this.doc[this.line] = true; }
  }

  finish(): LexedLine[] {
    return this.code.map((code, i) => ({
      code,
      // An empty `//` still makes the line a comment line; a single space keeps that visible.
      comment: this.hasComment[i] && this.comment[i] === '' ? ' ' : this.comment[i],
      isDoc: this.doc[i],
      multiline: this.multi[i],
      parts: this.parts[i],
    }));
  }
}

// ─── c-like ───

/**
 * Punctuation after which a `/` opens a regex literal. `!`, `+`, `-` and `}` are in the
 * set but each can also END an operand (`total! / 2`, `i++ / 2`, `{} / 2`); those cases
 * are settled — or refused — by `slashOpensRegex` before a regex is ever scanned.
 */
const REGEX_PRECEDING_PUNCTUATION = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '~', '^', '%', '*', '+', '-', '=>']);
const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'do', 'else', 'yield', 'await', 'instanceof',
]);

/** Tokens after which a `<` can only open a JSX element, never compare two values. */
const JSX_PRECEDING_PUNCTUATION = new Set(['(', ',', '=', ':', '[', '&', '|', '?', '{', '=>']);
const JSX_PRECEDING_WORDS = new Set(['return', 'yield', 'default']);
/** Deepest element nesting followed inside JSX. */
const MAX_JSX_DEPTH = 100;
/** How far ahead the end of one opening tag is looked for. */
const MAX_JSX_TAG_CHARS = 4_000;

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** True when `token` ends an operand: a name, a literal, or a closing `)` / `]`. */
function endsOperand(token: string): boolean {
  return token === ')' || token === ']' || token === '"' || (token !== '' && isWordChar(token[token.length - 1]));
}

function scanCLike(src: string, dialect: Dialect, sink: Sink, jsx: boolean, typescript: boolean): void {
  let i = 0;
  /** The last significant token: a word, or one punctuation mark (`=>` is kept whole). */
  let lastToken = '';
  /** The significant token before `lastToken`. */
  let prevToken = '';
  /** The significant token before `prevToken`. */
  let prev2Token = '';
  let lastWasWordChar = false;
  let jsxDepth = 0;

  const fail = (what: string): never => {
    throw new Ambiguous(`${what} on line ${sink.lineNumber}`);
  };

  /** A quoted string that must close on its own line. Starts at the opening quote. */
  const scanString = (quote: string): void => {
    sink.putCode(quote);
    i++;
    for (;;) {
      if (i >= src.length || src[i] === '\n') { fail('unterminated string'); }
      const ch = src[i];
      if (ch === '\\') {
        if (i + 1 >= src.length || src[i + 1] === '\n') { fail('unterminated string'); }
        sink.putCode(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      sink.putCode(ch);
      i++;
      if (ch === quote) { return; }
    }
  };

  /** A string that runs, across lines, to `terminator`. `doubled` is an escape that does not end it. */
  const scanUntil = (open: string, terminator: string, what: string, doubled?: string): void => {
    sink.putCode(open);
    i += open.length;
    for (;;) {
      if (i >= src.length) { fail(`unterminated ${what}`); }
      if (doubled && src.startsWith(doubled, i)) {
        sink.putCode(doubled);
        i += doubled.length;
        continue;
      }
      if (src.startsWith(terminator, i)) {
        sink.putCode(terminator);
        i += terminator.length;
        return;
      }
      sink.putCode(src[i]);
      i++;
    }
  };

  /** A JS template string, following `${ … }` back into code. Starts at the backtick. */
  const scanTemplate = (depth: number): void => {
    if (depth > MAX_TEMPLATE_DEPTH) { fail('template string nested too deeply'); }
    sink.putCode('`');
    i++;
    for (;;) {
      if (i >= src.length) { fail('unterminated template string'); }
      const ch = src[i];
      if (ch === '\\') {
        sink.putCode(src.slice(i, i + 2));
        i += 2;
      } else if (ch === '`') {
        sink.putCode(ch);
        i++;
        return;
      } else if (ch === '$' && src[i + 1] === '{') {
        sink.putCode('${');
        i += 2;
        token('{');
        scanCode(depth + 1);
        if (i >= src.length) { fail('unterminated template string'); }
        sink.putCode('}');
        i++;
      } else {
        sink.putCode(ch);
        i++;
      }
    }
  };

  /** A JS regex literal, which must close on its line. Starts at the opening slash. */
  const scanRegex = (): void => {
    sink.putCode('/');
    i++;
    let inClass = false;
    for (;;) {
      if (i >= src.length || src[i] === '\n') { fail('regular expression that does not close'); }
      const ch = src[i];
      if (ch === '\\') {
        if (i + 1 >= src.length || src[i + 1] === '\n') { fail('regular expression that does not close'); }
        sink.putCode(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      sink.putCode(ch);
      i++;
      if (ch === '[') { inClass = true; } else if (ch === ']') { inClass = false; } else if (ch === '/' && !inClass) { return; }
    }
  };

  /** Record a punctuation token (or a value) as the last significant one. */
  const token = (t: string): void => {
    prev2Token = prevToken;
    prevToken = lastToken;
    lastToken = t;
    lastWasWordChar = false;
  };
  const value = (): void => token('"');

  /**
   * Whether the `/` at `i` opens a regex literal (true) or divides (false). Throws when
   * neither can be told: a guess here would silently turn the rest of the line — and any
   * comment on it — into the wrong kind of text.
   */
  const slashOpensRegex = (): boolean => {
    if (src[i + 1] === '>' || lastToken === '<') { return false; }
    // A keyword opens a regex — but `obj.in / 2` and `this?.of / 2` name a property, which
    // is an operand: there the slash divides, and a comment after it is still a comment.
    if (REGEX_PRECEDING_WORDS.has(lastToken)) { return prevToken !== '.'; }
    if (!REGEX_PRECEDING_PUNCTUATION.has(lastToken)) { return false; }
    if (lastToken === '!') {
      // `obj.in! / 2`: a property that happens to be named like a keyword, with a non-null
      // assertion on it. It is an operand all the same, so the slash divides.
      if (REGEX_PRECEDING_WORDS.has(prevToken) && prev2Token === '.') { return false; }
      // `total! / 2` is TypeScript's non-null assertion on an operand; `!/re/.test(x)` and
      // `return !/re/.test(x)` negate a regex.
      return !(endsOperand(prevToken) && !REGEX_PRECEDING_WORDS.has(prevToken));
    }
    if ((lastToken === '+' || lastToken === '-') && prevToken === lastToken) {
      // `++` / `--`: find what they are attached to. After an operand they are postfix and
      // the slash divides; anywhere else nothing sensible follows.
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) { j--; }
      if (j >= 1 && src[j] === lastToken && src[j - 1] === lastToken) {
        let k = j - 2;
        while (k >= 0 && /\s/.test(src[k])) { k--; }
        if (k >= 0 && (isWordChar(src[k]) || src[k] === ')' || src[k] === ']')) { return false; }
        return fail(`"/" after "${lastToken}${lastToken}" could not be read`);
      }
      return true;
    }
    if (lastToken === '}') {
      // A block's closing brace starts a new statement (regex); an object literal's ends an
      // operand (division). Telling them apart takes a parser.
      return fail('"/" after "}" may divide or open a regular expression');
    }
    return true;
  };

  // ── JSX ──
  // JSX text is not code: an apostrophe in `<p>Don't</p>` opens no string, and `//` in it
  // opens no comment. Elements are followed structurally — tag, attributes, children — and
  // `{ … }` goes back into code. Anything that does not have that structure is refused.

  /**
   * Whether the `<` at `at` opens a JSX element: `<>` or `<Name` followed by attribute
   * syntax, with its closing tag somewhere later in the file (or self-closed). A TypeScript
   * generic — `<T,>(x: T) => x`, `<T>(x: T) => T` — fails one of those tests.
   */
  const looksLikeJsxOpen = (at: number): boolean => {
    // In a type alias (`type Fn = <T>(x: T) => T`) what follows the `=` is a type. A
    // `<T>` there opens a type parameter list even when the file has a `</T>` further down.
    if (typescript && TYPE_ALIAS_HEAD.test(src.slice(Math.max(0, at - MAX_TYPE_ALIAS_HEAD_CHARS), at))) { return false; }
    if (src[at + 1] === '>') { return src.indexOf('</>', at + 2) >= 0; }
    const name = /^[A-Za-z_$][\w$.:-]*/.exec(src.slice(at + 1, at + 201));
    if (!name) { return false; }
    let j = at + 1 + name[0].length;
    const after = src[j];
    if (after !== '>' && after !== '/' && !(after !== undefined && /\s/.test(after))) { return false; }
    while (j < src.length && /\s/.test(src[j])) { j++; }
    const first = src[j];
    if (first === undefined || !(first === '>' || first === '/' || first === '{' || /[A-Za-z_$]/.test(first))) { return false; }
    // `<T extends Base>(…)` is a generic arrow function, and also well-formed JSX: an element
    // `T` with an attribute called `extends`. TypeScript settles it the way its own parser
    // does in a .tsx file — it is a type parameter list unless what follows `extends` is
    // `=`, `>` or `/`, which only an attribute can be followed by. In a file that is not
    // TypeScript there is nothing to settle it with, and the file is refused.
    const constraint = /^extends(\s+)(\S?)/.exec(src.slice(j, j + 64));
    if (constraint) {
      if (!typescript) { return fail('"<" may open a JSX element or a type parameter list'); }
      if (constraint[2] !== '=' && constraint[2] !== '>' && constraint[2] !== '/') { return false; }
    }
    // Self-closing needs no partner; anything else must be closed somewhere below.
    if (src.indexOf(`</${name[0]}`, j) >= 0) { return true; }
    // Find the `>` that ends this tag, stepping over attribute strings and `{ … }` values.
    let braces = 0;
    for (let k = j; k < src.length && k < j + MAX_JSX_TAG_CHARS; k++) {
      const ch = src[k];
      if (braces === 0 && (ch === '"' || ch === '\'')) {
        const end = src.indexOf(ch, k + 1);
        if (end < 0) { return false; }
        k = end;
      } else if (ch === '{') {
        braces++;
      } else if (ch === '}') {
        braces--;
      } else if (ch === '>' && braces === 0) {
        return src[k - 1] === '/';
      }
    }
    return false;
  };

  /** A `{ … }` expression container inside JSX. Starts at the `{`. */
  const scanJsxContainer = (depth: number): void => {
    sink.putCode('{');
    i++;
    token('{');
    scanCode(depth + 1);
    if (i >= src.length) { fail('unterminated JSX expression'); }
    sink.putCode('}');
    i++;
  };

  /** One JSX element, children included. Starts at its `<`. */
  const scanJsxElement = (depth: number): void => {
    if (++jsxDepth > MAX_JSX_DEPTH) { fail('JSX nested too deeply'); }
    sink.putCode('<');
    i++;
    const nameMatch = /^[A-Za-z_$][\w$.:-]*/.exec(src.slice(i, i + 200));
    const name = nameMatch ? nameMatch[0] : '';
    sink.putCode(name);
    i += name.length;
    let selfClosed = false;
    for (;;) {
      if (i >= src.length) { fail('unterminated JSX tag'); }
      const ch = src[i];
      if (ch === '>') { sink.putCode(ch); i++; break; }
      if (ch === '/' && src[i + 1] === '>') { sink.putCode('/>'); i += 2; selfClosed = true; break; }
      if (ch === '"' || ch === '\'') {
        // An attribute string has no escapes and may span lines.
        const end = src.indexOf(ch, i + 1);
        if (end < 0) { fail('unterminated JSX attribute'); }
        sink.putCode(src.slice(i, end + 1));
        i = end + 1;
        continue;
      }
      if (ch === '{') { scanJsxContainer(depth); continue; }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) { fail('unterminated comment'); }
        sink.putComment(src.slice(i + 2, end), false);
        i = end + 2;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        const stop = end < 0 ? src.length : end;
        sink.putComment(src.slice(i + 2, stop), false);
        i = stop;
        continue;
      }
      if (!/[\w$:.=\s-]/.test(ch)) { fail('unexpected character in a JSX tag'); }
      sink.putCode(ch);
      i++;
    }
    if (!selfClosed) {
      for (;;) {
        if (i >= src.length) { fail('unterminated JSX element'); }
        const ch = src[i];
        if (ch === '{') { scanJsxContainer(depth); continue; }
        if (ch === '<' && src[i + 1] === '/') {
          const end = src.indexOf('>', i);
          if (end < 0) { fail('unterminated JSX tag'); }
          if (src.slice(i + 2, end).trim() !== name) { fail('JSX closing tag does not match its opening tag'); }
          sink.putCode(src.slice(i, end + 1));
          i = end + 1;
          break;
        }
        if (ch === '<') { scanJsxElement(depth); continue; }
        // Text that holds a comment marker is either a comment this scanner would miss or
        // not JSX text at all. A URL's `://` is neither.
        if (ch === '/' && (src[i + 1] === '*' || (src[i + 1] === '/' && src[i - 1] !== ':'))) {
          fail('comment marker inside JSX text');
        }
        sink.putCode(ch);
        i++;
      }
    }
    jsxDepth--;
  };

  /**
   * Scan code. At depth 0 this runs to end of file; inside a template
   * interpolation or a JSX expression it returns at the `}` that closes it (left unconsumed).
   */
  const scanCode = (depth: number): void => {
    if (depth > MAX_TEMPLATE_DEPTH + MAX_JSX_DEPTH) { fail('expression nested too deeply'); }
    let braces = 0;
    while (i < src.length) {
      const ch = src[i];
      const next = src[i + 1];

      if (ch === '/' && next === '/') {
        const end = src.indexOf('\n', i);
        const stop = end < 0 ? src.length : end;
        const isDoc = src[i + 2] === '/' && src[i + 3] !== '/';
        sink.putComment(src.slice(i + (isDoc ? 3 : 2), stop), isDoc);
        i = stop;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) { fail('unterminated comment'); }
        const isDoc = src[i + 2] === '*' && src[i + 3] !== '/';
        sink.putComment(src.slice(i + (isDoc ? 3 : 2), end), isDoc);
        i = end + 2;
        continue;
      }
      if (ch === '#' && next === '!' && i === 0) {
        const end = src.indexOf('\n');
        const stop = end < 0 ? src.length : end;
        sink.putComment(src.slice(2, stop), false);
        i = stop;
        continue;
      }
      if (ch === '"') {
        if (dialect === 'cs' && (src[i - 1] === '@' || (src[i - 1] === '$' && src[i - 2] === '@'))) {
          scanUntil('"', '"', 'verbatim string', '""');
        } else if ((dialect === 'cs' || dialect === 'java') && src.startsWith('"""', i)) {
          let run = 3;
          while (src[i + run] === '"') { run++; }
          const fence = '"'.repeat(run);
          scanUntil(fence, fence, 'text block');
        } else {
          scanString('"');
        }
        value();
        continue;
      }
      if (ch === '\'') {
        scanString('\'');
        value();
        continue;
      }
      if (ch === '`' && dialect === 'js') {
        scanTemplate(depth);
        value();
        continue;
      }
      if (ch === '`' && dialect === 'go') {
        scanUntil('`', '`', 'raw string');
        value();
        continue;
      }
      if (ch === '<' && jsx && next !== undefined && (next === '>' || /[A-Za-z_$]/.test(next))
        && (JSX_PRECEDING_PUNCTUATION.has(lastToken) || JSX_PRECEDING_WORDS.has(lastToken))
        && looksLikeJsxOpen(i)) {
        scanJsxElement(depth);
        value();
        continue;
      }
      if (ch === '/' && dialect === 'js' && slashOpensRegex()) {
        scanRegex();
        value();
        continue;
      }
      if (depth > 0 && ch === '}') {
        if (braces === 0) { return; }
        braces--;
      } else if (depth > 0 && ch === '{') {
        braces++;
      }

      sink.putCode(ch);
      i++;
      if (isWordChar(ch)) {
        if (lastWasWordChar) {
          lastToken += ch;
        } else {
          prev2Token = prevToken;
          prevToken = lastToken;
          lastToken = ch;
        }
        lastWasWordChar = true;
      } else if (!/\s/.test(ch)) {
        if (ch === '>' && lastToken === '=' && !lastWasWordChar) {
          lastToken = '=>';
        } else {
          token(ch);
        }
        lastWasWordChar = false;
      } else {
        lastWasWordChar = false;
      }
    }
  };

  scanCode(0);
}

// ─── Go documentation comments ───

/** What a Go doc comment sits directly above. */
const GO_DECLARATION = /^(?:func|type|var|const|package)\b/;
/** A member of a grouped declaration or a struct: `Name string`, `MaxRetries = 3`, `Read(p []byte) (int, error)`. */
const GO_MEMBER = /^[A-Za-z_]\w*(?:\s|\(|$)/;
/** Lines that open a block whose members are declarations, not statements. */
const GO_GROUP_OPEN = /^(?:(?:const|var|type)\s*\(|type\s+\w+(?:\[[^\]]*\])?\s+(?:struct|interface)\s*\{|\w+\s+(?:struct|interface)\s*\{)\s*$/;

/**
 * Mark Go documentation comments.
 *
 * Go has no doc-comment syntax of its own: a run of plain `//` lines directly above a
 * declaration — no blank line between — IS its documentation, and gofmt keeps it there.
 * Members of a `const (`/`var (`/`type (` group and of a struct or interface are declared
 * the same way. A comment above a statement inside a function body is not documentation.
 */
function markGoDocComments(lines: LexedLine[]): void {
  /** One entry per open bracket: true when it belongs to a grouped declaration. */
  const stack: boolean[] = [];
  let runStart = -1;
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    const code = l.code.trim();
    if (code === '') {
      if (l.comment === '') { runStart = -1; } else if (runStart < 0) { runStart = n; }
      continue;
    }
    const inGroup = stack.length > 0 && stack[stack.length - 1];
    const documents = stack.length === 0 ? GO_DECLARATION.test(code) : inGroup && (GO_MEMBER.test(code) || GO_DECLARATION.test(code));
    if (runStart >= 0 && documents) {
      for (let k = runStart; k < n; k++) { lines[k].isDoc = true; }
    }
    runStart = -1;

    // Brackets inside string and rune literals are not structure.
    const bare = code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, '""');
    const opensGroup = GO_GROUP_OPEN.test(bare);
    for (const ch of bare) {
      if (ch === '{' || ch === '(') { stack.push(opensGroup); }
      else if ((ch === '}' || ch === ')') && stack.length > 0) { stack.pop(); }
    }
  }
}

// ─── python ───

function scanPython(src: string, sink: Sink): void {
  let i = 0;
  const fail = (what: string): never => {
    throw new Ambiguous(`${what} on line ${sink.lineNumber}`);
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '#') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      sink.putComment(src.slice(i + (src[i + 1] === '!' && i === 0 ? 2 : 1), stop), false);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      const triple = src.startsWith(ch.repeat(3), i);
      const fence = triple ? ch.repeat(3) : ch;
      sink.putCode(fence);
      i += fence.length;
      for (;;) {
        if (i >= src.length) { fail('unterminated string'); }
        if (src[i] === '\\') {
          // A backslash also continues a one-line string onto the next line.
          if (i + 1 >= src.length) { fail('unterminated string'); }
          sink.putCode(src.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (!triple && src[i] === '\n') { fail('unterminated string'); }
        if (src.startsWith(fence, i)) {
          sink.putCode(fence);
          i += fence.length;
          break;
        }
        sink.putCode(src[i]);
        i++;
      }
      continue;
    }
    sink.putCode(ch);
    i++;
  }
}

// ─── html ───

/** `type` values of a `<script>` whose body is JavaScript. An absent or empty type is one too. */
const HTML_SCRIPT_JS_TYPES = new Set([
  '', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript',
  'application/x-javascript', 'text/x-javascript',
]);
/** `type` values of a `<script>` whose body is JSON data, which can hold no comment at all. */
const HTML_SCRIPT_DATA_TYPE = /^(?:importmap|speculationrules|[\w.+-]+\/(?:[\w.+-]+\+)?json)$/;

/** The index just past the `>` that ends the tag opening at `start`, stepping over quoted attribute values. */
function htmlTagEnd(src: string, start: number): number {
  let quote = '';
  for (let k = start; k < src.length; k++) {
    const ch = src[k];
    if (quote) {
      if (ch === quote) { quote = ''; }
    } else if (ch === '"' || ch === '\'') {
      quote = ch;
    } else if (ch === '>') {
      return k + 1;
    }
  }
  return -1;
}

/** `<script` or `<style` opening a tag, at the position the expression is anchored to. */
const HTML_RAW_TEXT_OPEN = /<(script|style)(?=[\s/>]|$)/iy;

/**
 * HTML: `<!-- -->` comments, plus the bodies of inline `<script>` and `<style>` elements,
 * which are lexed as the languages they are. A placeholder comment inside an inline script
 * is a comment like any other, and inline script is the ordinary shape of a static page —
 * carrying those bodies as unread "code" would let every comment rule report "no findings"
 * on text nobody looked at. A script in a language this lexer does not know (a template,
 * say), or one the JavaScript lexer cannot read, makes the whole file undecided instead:
 * the line rules then report it as not checked.
 *
 * Every index used to cut the source comes from a search of the SAME string. Tag names are
 * matched case-insensitively by regular expression, never by lower-casing a copy: a copy
 * can be a different length (`İ`, U+0130, lower-cases to two code units), after which an
 * index found in the copy points at the wrong place in the original — and a `</script>`
 * found that way ends the body somewhere it does not end.
 */
function scanHtml(src: string, sink: Sink): void {
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) { throw new Ambiguous(`unterminated comment on line ${sink.lineNumber}`); }
      sink.putComment(src.slice(i + 4, end), false);
      i = end + 3;
      continue;
    }
    HTML_RAW_TEXT_OPEN.lastIndex = i;
    const open = src[i] === '<' ? HTML_RAW_TEXT_OPEN.exec(src) : null;
    if (open) {
      const element = open[1].toLowerCase();
      const bodyStart = htmlTagEnd(src, i);
      if (bodyStart < 0) { throw new Ambiguous(`unterminated <${element}> tag on line ${sink.lineNumber}`); }
      const tag = src.slice(i, bodyStart);
      sink.putCode(tag);
      // The body ends at the first closing tag, whatever the language inside makes of it.
      const closer = element === 'script' ? /<\/script/gi : /<\/style/gi;
      closer.lastIndex = bodyStart;
      const close = closer.exec(src);
      const bodyEnd = close ? close.index : src.length;
      const body = src.slice(bodyStart, bodyEnd);
      if (element === 'style') {
        scanCss(body, sink);
      } else {
        const typed = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const type = (typed ? typed[1] ?? typed[2] ?? typed[3] : '').trim().toLowerCase();
        if (HTML_SCRIPT_JS_TYPES.has(type)) {
          scanCLike(body, 'js', sink, false, false);
        } else if (HTML_SCRIPT_DATA_TYPE.test(type) || body.trim() === '') {
          sink.putCode(body);
        } else {
          throw new Ambiguous(`inline <script> of type "${type.slice(0, 60)}" cannot be read (line ${sink.lineNumber})`);
        }
      }
      i = bodyEnd;
      continue;
    }
    sink.putCode(src[i]);
    i++;
  }
}

// ─── css ───

function scanCss(src: string, sink: Sink): void {
  let i = 0;
  const fail = (what: string): never => {
    throw new Ambiguous(`${what} on line ${sink.lineNumber}`);
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) { fail('unterminated comment'); }
      sink.putComment(src.slice(i + 2, end), false);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      sink.putCode(ch);
      i++;
      for (;;) {
        if (i >= src.length) { fail('unterminated string'); }
        if (src[i] === '\\') {
          if (i + 1 >= src.length) { fail('unterminated string'); }
          sink.putCode(src.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (src[i] === '\n') { fail('unterminated string'); }
        sink.putCode(src[i]);
        i++;
        if (src[i - 1] === ch) { break; }
      }
      continue;
    }
    sink.putCode(ch);
    i++;
  }
}

// ─── Public API ───

/**
 * How many leading lines make up the file header: an optional shebang, then the
 * first unbroken run of comment-only lines. The run ends at the first blank line
 * or the first line of code, whichever comes first.
 *
 * Deliberately narrow. "Everything above the first line of code" would turn any
 * comment near the top of a file — and the whole of a file with no code — into a
 * header nobody checks. `hasShebang` says line 1 is a `#!` line, which may be
 * separated from the licence block by blank lines.
 */
export function headerLineCount(lines: LexedLine[], hasShebang = false): number {
  const isBlank = (l: LexedLine): boolean => l.comment === '' && l.code.trim() === '';
  const isCommentOnly = (l: LexedLine): boolean => l.comment !== '' && l.code.trim() === '';
  let i = 0;
  if (hasShebang && lines.length > 0) {
    i = 1;
    let next = i;
    while (next < lines.length && isBlank(lines[next])) { next++; }
    if (next < lines.length && isCommentOnly(lines[next])) { i = next; } else { return 1; }
  } else {
    while (i < lines.length && isBlank(lines[i])) { i++; }
  }
  while (i < lines.length && isCommentOnly(lines[i])) { i++; }
  return i;
}

/**
 * 1-based numbers of the lines that are commentary and nothing else.
 *
 * Documentation comments and the file header ({@link headerLineCount}: shebang
 * and licence block) are left out — they are not counted against an author when
 * comment density is measured.
 */
export function commentOnlyLineNumbers(lines: LexedLine[], hasShebang = false): number[] {
  const headerEnd = headerLineCount(lines, hasShebang);
  const out: number[] = [];
  for (let i = headerEnd; i < lines.length; i++) {
    const l = lines[i];
    if (l.comment !== '' && !l.isDoc && l.code.trim() === '') { out.push(i + 1); }
  }
  return out;
}

/**
 * Classify every line of `content` as code and/or comment.
 *
 * `filePath` only selects the language by extension. Line endings are
 * normalised first, so `lines[n - 1]` is line `n` of the file. Any ambiguity
 * returns `ok: false` with a reason a reviewer can read.
 */
export function lexFile(filePath: string, content: string): LexResult {
  const ext = fileExtension(filePath);
  const lang = EXTENSIONS[ext];
  if (!lang) {
    return { ok: false, reason: ext ? `No checker for .${ext} files` : 'No checker for files without an extension' };
  }
  if (content.length > MAX_LEX_BYTES) {
    return { ok: false, reason: 'File is larger than 512 KB' };
  }
  if (content.includes('\0')) {
    return { ok: false, reason: 'Binary content' };
  }

  const src = content.replace(/\r\n?/g, '\n');
  const sink = new Sink();
  try {
    if (lang.family === 'c-like') {
      scanCLike(src, lang.dialect ?? 'js', sink, JSX_EXTENSIONS.has(ext), TYPESCRIPT_EXTENSIONS.has(ext));
    } else if (lang.family === 'python') {
      scanPython(src, sink);
    } else if (lang.family === 'html') {
      scanHtml(src, sink);
    } else {
      scanCss(src, sink);
    }
  } catch (err) {
    if (err instanceof Ambiguous) {
      return { ok: false, reason: `Could not lex the file: ${err.message}` };
    }
    throw err;
  }
  const lines = sink.finish();
  if (lang.dialect === 'go') { markGoDocComments(lines); }
  return { ok: true, lines };
}
