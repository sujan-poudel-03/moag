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

/** Task types whose run makes an engine call (the others run a command, a check, a gate…). */
export const ENGINE_TASK_TYPES: readonly string[] = ['agent', 'review', 'visual-test'];

/**
 * True when this task made an engine call whose cost is not known: no usage at all
 * (Copilot, custom), usage with no cost (Codex and Gemini token counts), or a cost
 * tagged unknown. A task that calls no engine never counts. An absent type is an agent task.
 */
export function isUnknownCostCall(u: CostLike | null | undefined, taskType?: string): boolean {
  if (taskType !== undefined && !ENGINE_TASK_TYPES.includes(taskType)) { return false; }
  return !isCostKnown(u);
}

/** The usage fields a run session adds up. */
export interface SessionCostTotals {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  costUnknownCalls?: number;
}

/** A run session's totals after one more settled task. Pure. */
export function sessionUsageDelta(
  s: SessionCostTotals,
  u: (CostLike & { inputTokens?: number; outputTokens?: number }) | null | undefined,
  taskType?: string,
): Required<SessionCostTotals> {
  return {
    totalTokensIn: s.totalTokensIn + (u?.inputTokens || 0),
    totalTokensOut: s.totalTokensOut + (u?.outputTokens || 0),
    totalCost: s.totalCost + (isCostKnown(u) ? (u!.estimatedCost as number) : 0),
    costUnknownCalls: (s.costUnknownCalls ?? 0) + (isUnknownCostCall(u, taskType) ? 1 : 0),
  };
}
