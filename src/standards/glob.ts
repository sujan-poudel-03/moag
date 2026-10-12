// ─── Restricted glob matching for standards profiles ───
//
// Profiles are reviewer-authored data, so they never carry a regular expression.
// A pattern is a literal path with three wildcards and nothing else:
//
//   *    any run of characters within one path segment
//   **   any run of characters across segments (`**/` also matches no segment)
//   ?    exactly one character within a segment
//
// The translation is bounded — pattern length and wildcard count are capped —
// so a hostile pattern cannot produce a slow expression. Paths are matched
// whole, `/`-separated and case-sensitively.

/** Longest pattern compiled. Matches the profile's per-entry cap. */
export const MAX_GLOB_CHARS = 200;
/** Most wildcards one pattern may hold. */
export const MAX_GLOB_WILDCARDS = 12;

const cache = new Map<string, RegExp | null>();
const MAX_CACHE_ENTRIES = 500;

/** `/`-separated, without a leading `./` or a trailing `/`. */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) { out = out.slice(2); }
  while (out.length > 1 && out.endsWith('/')) { out = out.slice(0, -1); }
  return out;
}

/**
 * Compile a restricted glob, or return null when it is empty, too long or has
 * too many wildcards. A null is "this pattern cannot be decided" — callers
 * report the rule as not checked, never as passed.
 */
export function globToRegExp(glob: string): RegExp | null {
  const cached = cache.get(glob);
  if (cached !== undefined) { return cached; }

  let compiled: RegExp | null = null;
  const pattern = normalizePath(glob.trim());
  if (pattern.length > 0 && pattern.length <= MAX_GLOB_CHARS) {
    let source = '';
    let wildcards = 0;
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*') {
        let run = 1;
        while (pattern[i + 1] === '*') { run++; i++; }
        wildcards++;
        if (run === 1) {
          source += '[^/]*';
        } else if (pattern[i + 1] === '/' && (source === '' || source.endsWith('/'))) {
          // `**/` between separators also matches zero segments.
          source += '(?:[^/]+/)*';
          i++;
        } else {
          source += '.*';
        }
      } else if (ch === '?') {
        wildcards++;
        source += '[^/]';
      } else {
        source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    if (wildcards <= MAX_GLOB_WILDCARDS) {
      compiled = new RegExp(`^${source}$`);
    }
  }

  if (cache.size >= MAX_CACHE_ENTRIES) { cache.clear(); }
  cache.set(glob, compiled);
  return compiled;
}

/**
 * Whether `path` matches any of `globs`. Returns null when the answer depends on
 * a pattern that could not be compiled: a match by a valid pattern is still
 * true, but "no match" is unknowable.
 */
export function matchesAny(path: string, globs: string[]): boolean | null {
  const target = normalizePath(path);
  let undecidable = false;
  for (const glob of globs) {
    const re = globToRegExp(glob);
    if (!re) { undecidable = true; continue; }
    if (re.test(target)) { return true; }
  }
  return undecidable ? null : false;
}

/** True when `path` is `dir` itself or sits anywhere beneath it. An empty or `.` dir is the root. */
export function isUnder(path: string, dir: string): boolean {
  const d = normalizePath(dir.trim());
  if (d === '' || d === '.') { return true; }
  const target = normalizePath(path);
  return target === d || target.startsWith(`${d}/`);
}
