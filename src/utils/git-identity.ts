// ─── Developer identity (git config user.email) ──────────────────────────────
//
// Resolves the local developer's email via `git config user.email` so usage
// events can be attributed to a contributor. Resolved once per process and
// memoized — this must never be re-shelled-out-to per event.

import { execFileSync } from 'child_process';

let memoized: string | null | undefined; // undefined = not yet resolved

/**
 * Resolve the developer's email from `git config user.email`, memoized for
 * the lifetime of the process (first resolution wins — subsequent calls,
 * even with a different `cwd`, return the cached value).
 * Never throws — any failure (no git, no repo, no email configured)
 * resolves to `null`.
 * @param cwd Working directory to resolve git config from
 */
export function resolveDeveloperEmail(cwd: string): string | null {
  if (memoized !== undefined) { return memoized; }
  try {
    const raw = execFileSync('git', ['config', 'user.email'], {
      cwd,
      timeout: 5000,
      encoding: 'utf-8',
    });
    const trimmed = raw.trim();
    memoized = trimmed.length > 0 ? trimmed : null;
  } catch {
    memoized = null;
  }
  return memoized;
}
