// ─── Prompt quality heuristics (pure, zero imports) ───────────────────────────
//
// Cheap, deterministic signals used by the Contribution Ledger's coaching
// cards. Intentionally simple and explainable — no model call, no I/O.

export interface PromptHeuristicResult {
  score: number;
  flags: string[];
}

const VAGUE_PHRASES = [
  'fix it',
  'improve this',
  'clean up',
  'make it better',
  'do the needful',
  'handle it',
];

/** A backtick-quoted token, e.g. `` `foo.ts` `` or `` `myFunction()` ``. */
const BACKTICK_TOKEN_RE = /`[^`]+`/;

/** A filename-like token, e.g. `foo.ts`, `bar/baz.js`. */
const FILENAME_TOKEN_RE = /\b[\w-]+\.[a-zA-Z]{1,10}\b/;

/** An identifier-like token, e.g. `camelCase`, `snake_case`, `PascalCase`. */
const IDENTIFIER_TOKEN_RE = /\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-z0-9]*)+\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Rate a task prompt against three independent, cheap heuristics:
 *  - `too-short`      fewer than 6 words
 *  - `vague-phrasing`  matches a bare-verb deny-list ("fix it", "clean up", ...)
 *  - `no-specifics`   fewer than 15 words AND no backtick/filename/identifier token
 * @param promptText Raw prompt text to rate
 */
export function rateHeuristically(promptText: string): PromptHeuristicResult {
  const text = promptText ?? '';
  const words = wordCount(text);
  const flags: string[] = [];

  if (words < 6) { flags.push('too-short'); }

  const lower = text.trim().toLowerCase();
  if (VAGUE_PHRASES.some(phrase => lower.includes(phrase))) { flags.push('vague-phrasing'); }

  const hasSpecificToken = BACKTICK_TOKEN_RE.test(text)
    || FILENAME_TOKEN_RE.test(text)
    || IDENTIFIER_TOKEN_RE.test(text);
  if (words < 15 && !hasSpecificToken) { flags.push('no-specifics'); }

  const score = clamp(100 - 30 * flags.length, 0, 100);
  return { score, flags };
}
