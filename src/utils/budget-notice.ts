// ─── Budget notice — the ceiling cannot stop calls that report no cost ───
//
// costBudgetUsd counts recorded cost only. An engine that reports none (Claude
// in text mode, Codex, Gemini, Copilot, custom) is invisible to it, so a set
// ceiling cannot stop that spend. This says so once, the first time such a
// call happens while a ceiling is set. The extension shows a warning; the CLI
// prints one stderr line. Concurrent calls (parallelPlaylists) hit the latch,
// not a second notice.

import { costLedger, UnreportedCostEvent } from './cost-ledger';

/** The slice of the cost ledger this uses. */
export interface UnreportedSource {
  onUnreported(listener: (e: UnreportedCostEvent) => void): () => void;
}

/**
 * Call `onFirst` once, on the first unreported-cost call while `budget()` > 0.
 * Returns the unsubscribe function. A throwing `budget` or `onFirst` never
 * reaches the engine call.
 */
export function watchUnenforceableBudget(
  o: { budget(): number; onFirst(e: UnreportedCostEvent): void },
  ledger: UnreportedSource = costLedger,
): () => void {
  let fired = false;
  return ledger.onUnreported((e) => {
    if (fired) { return; }
    let budget = 0;
    try { budget = o.budget(); } catch { return; }
    if (!(typeof budget === 'number' && Number.isFinite(budget) && budget > 0)) { return; }
    fired = true;
    try { o.onFirst(e); } catch { /* a notice never breaks accounting */ }
  });
}

/** The one-line text both hosts use. */
export const BUDGET_UNENFORCEABLE_TEXT =
  'The cost ceiling (costBudgetUsd) cannot stop this run: an engine call reported no cost, and calls that report no cost are not counted. Claude reports cost only with outputFormat "json".';
