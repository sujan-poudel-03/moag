// ─── Secret redaction ───
//
// Scrubs secrets out of text that is about to leave the machine (task diffs and
// error tails relayed to ONOSOO, the `task-changes` stdout line). Two layers:
//
//   1. Exact values the caller knows are secret — values from the workspace's
//      .env / .env.local, engine API keys in the environment, the relay's own
//      device key. Replaced verbatim, longest first.
//   2. Well-known secret shapes — PEM private keys, provider API keys, GitHub
//      tokens, AWS access key ids, JWTs, `password=…` assignments and the
//      password half of URL credentials.
//
// Imports only `fs` and `path`; never `vscode`. Every regex uses bounded or
// linear quantifiers with no nesting, so a megabyte of hostile text stays fast.

import * as fs from 'fs';
import * as path from 'path';

/** What a redacted secret is replaced with. */
export const REDACTED = '[REDACTED]';

/** Shortest exact value worth redacting; shorter values would shred ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** A redactor built once and applied to many texts. */
export interface Redactor {
  /** Replace every secret in `text`; `count` is the number of occurrences replaced. */
  redact(text: string): { text: string; count: number };
}

// ─── Candidate filtering ───

const NON_SECRET_WORDS = new Set(['true', 'false', 'yes', 'no', 'null']);

/**
 * True when an env-file value is plausibly a secret: at least 8 characters,
 * not all digits (ports, ids), and not a boolean/null word.
 */
export function isSecretCandidate(value: string): boolean {
  if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) { return false; }
  if (/^\d+$/.test(value)) { return false; }
  return !NON_SECRET_WORDS.has(value.toLowerCase());
}

// ─── .env parsing ───

/** Values from `KEY=VALUE` lines in one env file's text that pass {@link isSecretCandidate}. */
function parseEnvText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) { continue; }
    if (line.startsWith('export ')) { line = line.slice('export '.length).trim(); }
    const eq = line.indexOf('=');
    if (eq <= 0) { continue; }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === '\'') && value[value.length - 1] === q) {
        value = value.slice(1, -1);
      }
    }
    if (isSecretCandidate(value)) { out.push(value); }
  }
  return out;
}

/**
 * Secret-looking values from `<cwd>/.env` and `<cwd>/.env.local`. Missing or
 * unreadable files are skipped; never throws.
 */
export function readEnvFileSecrets(cwd: string): string[] {
  const out: string[] = [];
  for (const name of ['.env', '.env.local']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, name), 'utf-8');
    } catch {
      continue;
    }
    out.push(...parseEnvText(text));
  }
  return out;
}

// ─── Patterns ───

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;

/** Whole-match patterns, applied in order after PEM blocks. */
const WHOLE_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * `KEY=value`, `KEY: value`, `key => value`, `"key": "value"` and `'key': 'value'`
 * assignments (keys may contain `-`: `x-api-key`). A quoted value runs to its closing quote
 * (group 4 or 5, so `;`, `&`, `,` and spaces inside it count); an unquoted one is group 6.
 * Only the value is replaced, and only when the key (group 2)
 * contains {@link SECRET_KEY_WORD}. The key is matched whole and atomically — it may not
 * start after a word character, and the lookahead capture cannot backtrack — so a long
 * identifier costs one attempt, not one per character: linear time.
 */
const ASSIGNMENT = /(["']?)(?<![A-Za-z0-9_-])(?=([A-Za-z0-9_-]{1,200}))\2\1(\s{0,20}(?:=>|[=:])\s{0,20})(?:"([^"\n]{4,200})"|'([^'\n]{4,200})'|([^\s"'&;,]{4,}))/g;

/** An unquoted value that is a number, not a secret (`maxTokens: 4096`). */
const NUMERIC_VALUE = /^\d+(?:\.\d+)?$/;
/** An unquoted value that is a TypeScript type, not a secret (`password: string;`). */
const TYPE_ANNOTATION = /^(?:string|number|boolean|any|unknown|null|undefined)\)*$/;

/** A key that names a secret, with any prefix or suffix (`DB_PASSWORD`, `apiKey`, `client_secret`). */
const SECRET_KEY_WORD = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret/i;

/** `scheme://user:pass@host`: only the password (group 2) is replaced. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi;

/** Replace every PEM private-key block (BEGIN without END runs to the end of the text). */
function redactPem(text: string): { text: string; count: number } {
  PEM_BEGIN.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let count = 0;
  for (;;) {
    PEM_BEGIN.lastIndex = cursor;
    const begin = PEM_BEGIN.exec(text);
    if (!begin) { break; }
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    const stop = end ? end.index + end[0].length : text.length;
    out += text.slice(cursor, begin.index) + REDACTED;
    cursor = stop;
    count++;
  }
  return { text: count === 0 ? text : out + text.slice(cursor), count };
}

/**
 * Build a redactor over `exactValues` (de-duplicated, values shorter than 8
 * characters ignored) plus the built-in secret patterns.
 */
export function createRedactor(exactValues: readonly string[]): Redactor {
  const exact = [...new Set(exactValues.filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length);

  return {
    redact(input: string): { text: string; count: number } {
      let text = String(input);
      let count = 0;

      for (const value of exact) {
        const parts = text.split(value);
        if (parts.length > 1) {
          count += parts.length - 1;
          text = parts.join(REDACTED);
        }
      }

      const pem = redactPem(text);
      text = pem.text;
      count += pem.count;

      for (const re of WHOLE_PATTERNS) {
        re.lastIndex = 0;
        text = text.replace(re, () => { count++; return REDACTED; });
      }

      ASSIGNMENT.lastIndex = 0;
      text = text.replace(ASSIGNMENT, (
        whole: string, keyQuote: string, key: string, sep: string,
        dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number, all: string,
      ) => {
        const value = dq ?? sq ?? bare ?? '';
        // Not a secret-named key, or already redacted by an earlier layer (never count twice).
        if (!SECRET_KEY_WORD.test(key) || value === REDACTED) { return whole; }
        if (bare !== undefined) {
          if (NUMERIC_VALUE.test(bare)) { return whole; }
          const next = all.charAt(offset + whole.length);
          // `token: unknown)` captures the `)` itself, which is already the closing character.
          if (TYPE_ANNOTATION.test(bare) && (bare.endsWith(')') || next === '' || /[;,)\r\n]/.test(next))) { return whole; }
        }
        count++;
        const quote = dq !== undefined ? '"' : sq !== undefined ? '\'' : '';
        return `${keyQuote}${key}${keyQuote}${sep}${quote}${REDACTED}${quote}`;
      });

      URL_CREDENTIALS.lastIndex = 0;
      text = text.replace(URL_CREDENTIALS, (whole: string, prefix: string, password: string) => {
        if (password === REDACTED) { return whole; }
        count++;
        return `${prefix}${REDACTED}@`;
      });

      return { text, count };
    },
  };
}
