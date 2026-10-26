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

/**
 * Engines that report a cost the ledger can count: the Anthropic API (from its own
 * usage) and Ollama (a real zero). Claude counts only with outputFormat "json".
 */
export const COST_REPORTING_ENGINES: readonly string[] = ['anthropic', 'ollama'];

/** The engines among `engines` that report no cost, in order, without repeats. */
export function enginesWithoutCost(engines: readonly string[], claudeOutputFormat: string): string[] {
  const out: string[] = [];
  for (const e of engines) {
    if (out.includes(e) || COST_REPORTING_ENGINES.includes(e)) { continue; }
    if (e === 'claude' && claudeOutputFormat === 'json') { continue; }
    out.push(e);
  }
  return out;
}

/** What to tell the user at the start of a run the ceiling cannot fully see. */
export interface RunBudgetNotice {
  engines: string[];
  /** Claude in text mode is among them: switching it to JSON output makes it count. */
  offerJson: boolean;
  text: string;
}

/**
 * The notice for a run, or null: no ceiling set, or every engine of the run reports
 * its cost. Pure.
 */
export function budgetNoticeForRun(o: { budget: number; engines: readonly string[]; claudeOutputFormat: string }): RunBudgetNotice | null {
  if (!(Number.isFinite(o.budget) && o.budget > 0)) { return null; }
  const engines = enginesWithoutCost(o.engines, o.claudeOutputFormat);
  if (engines.length === 0) { return null; }
  const offerJson = engines.includes('claude');
  const names = engines.length === 1 ? engines[0] : `${engines.slice(0, -1).join(', ')} and ${engines[engines.length - 1]}`;
  const text = `The cost ceiling ($${o.budget}) cannot stop this run: ${names} ${engines.length === 1 ? 'reports' : 'report'} no cost, and calls that report no cost are not counted.`
    + (offerJson ? ' Claude reports its cost only in JSON output.' : '');
  return { engines, offerJson, text };
}

/** The one-line text both hosts use. */
export const BUDGET_UNENFORCEABLE_TEXT =
  'The cost ceiling (costBudgetUsd) cannot stop this run: an engine call reported no cost, and calls that report no cost are not counted. Claude reports cost only with outputFormat "json".';
