// ─── USD formatting ───
//
// One pure helper for showing a dollar amount: `$` and two decimals, or
// `unknown` when the amount was never reported. No imports, no I/O.

/**
 * Format a dollar amount for display.
 *
 * A finite, non-negative number renders as `$` plus two decimals
 * (`7.129` → `$7.13`); `'unknown'` renders as `unknown`. Throws a RangeError
 * for a negative number, NaN or an infinity — those are bugs upstream, never
 * something to show a user.
 */
export function formatUsd(amount: number | 'unknown'): string {
  if (amount === 'unknown') { return 'unknown'; }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`formatUsd: expected a finite, non-negative amount, got ${String(amount)}`);
  }
  return `$${amount.toFixed(2)}`;
}
