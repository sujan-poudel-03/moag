// ─── Cost formatting — one honest formatter for every host-side display ───
//
// An engine that reports no cost (Claude in text mode, Codex, Gemini, Copilot,
// custom) has `costSource: 'unknown'` and no `estimatedCost`. That is shown as
// "cost unknown", never as $0.00 or "Free": a zero means the engine said zero
// (Ollama), not that nobody knows. The two webview scripts cannot import this
// and carry a one-line 'unknown' branch of their own.

/** The usage fields a cost display reads. */
export interface CostLike {
  estimatedCost?: number;
  costSource?: 'reported' | 'estimated' | 'unknown';
}

/** A dollar amount: `$0.00` for zero, four decimals under a cent, else two. */
export function formatUsd(usd: number): string {
  const c = Number.isFinite(usd) && usd > 0 ? usd : 0;
  if (c === 0) { return '$0.00'; }
  if (c < 0.01) { return `$${c.toFixed(4)}`; }
  return `$${c.toFixed(2)}`;
}

/** One call's cost: 'cost unknown' when the engine reported none. */
export function formatUsageCost(u?: CostLike | null): string {
  if (!u || u.costSource === 'unknown' || typeof u.estimatedCost !== 'number' || !Number.isFinite(u.estimatedCost)) {
    return 'cost unknown';
  }
  return formatUsd(u.estimatedCost);
}

/**
 * A total over many calls: `$1.23`, `$1.23 + 3 calls of unknown cost`, or
 * `cost unknown` when nothing known was spent and some calls are unknown.
 */
export function formatTotal(usd: number, unknownCalls: number): string {
  const n = Number.isFinite(unknownCalls) && unknownCalls > 0 ? Math.floor(unknownCalls) : 0;
  const known = Number.isFinite(usd) && usd > 0 ? usd : 0;
  if (n === 0) { return formatUsd(known); }
  if (known === 0) { return 'cost unknown'; }
  return `${formatUsd(known)} + ${n} call${n === 1 ? '' : 's'} of unknown cost`;
}

/** True when a usage block carries a cost MOAG can count. */
export function isCostKnown(u?: CostLike | null): boolean {
  return !!u && u.costSource !== 'unknown' && typeof u.estimatedCost === 'number' && Number.isFinite(u.estimatedCost);
}
