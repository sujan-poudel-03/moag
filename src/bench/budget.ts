// ─── Benchmark budget ledger (pure) ───
//
// Tracks what a benchmark has spent from the `cost` events the server streams,
// and turns that into an UPPER BOUND: reported and estimated dollars count at
// face value, and every call that reported nothing (`source: 'none'`) counts
// as the full per-call cap, because that is the most it could have cost. The
// bench sizes each version's cap and its stop watchdog from that bound, never
// from the (possibly incomplete) reported total.

/** The `source` of a `cost` worker event; absent on lines from older workers. */
export type CostEventSource = 'reported' | 'estimated' | 'none';

/** One `cost` event as the bench sees it. */
export interface BenchCostEvent {
  usd: number;
  source?: CostEventSource;
}

/** Serializable state of a {@link BudgetLedger}. */
export interface BudgetSnapshot {
  capUsd: number;
  perCallCapUsd: number;
  reserveFactor: number;
  reportedUsd: number;
  estimatedUsd: number;
  reportedCalls: number;
  estimatedCalls: number;
  unreportedCalls: number;
  upperBoundUsd: number;
}

/** Round to whole cents, downward (never hand out money that is not there). */
function floorCents(n: number): number {
  return Math.floor(n * 100 + 1e-9) / 100;
}

export class BudgetLedger {
  private reportedUsd = 0;
  private estimatedUsd = 0;
  private reportedCalls = 0;
  private estimatedCalls = 0;
  private unreportedCalls = 0;

  constructor(
    readonly capUsd: number,
    readonly perCallCapUsd: number,
    readonly reserveFactor: number,
  ) {
    if (!(capUsd > 0) || !(perCallCapUsd > 0) || !(reserveFactor >= 1)) {
      throw new Error('BudgetLedger needs capUsd > 0, perCallCapUsd > 0 and reserveFactor >= 1');
    }
  }

  /**
   * Account one `cost` event. A missing source is an older worker's recorded
   * cost: counted as estimated. A malformed amount is counted as unreported.
   */
  onCost(e: BenchCostEvent): void {
    const usd = typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd >= 0 ? e.usd : null;
    if (e.source === 'none' || usd === null) { this.unreportedCalls++; return; }
    if (e.source === 'reported') { this.reportedUsd += usd; this.reportedCalls++; return; }
    this.estimatedUsd += usd;
    this.estimatedCalls++;
  }

  /** Most the benchmark can have spent so far. */
  upperBoundUsd(): number {
    return this.reportedUsd + this.estimatedUsd + this.unreportedCalls * this.perCallCapUsd;
  }

  /**
   * The cap to give the next version: what remains of the total after the
   * upper bound, minus a reserve of `reserveFactor` per-call caps (a call can
   * overshoot its cap by about a turn). Null — "not run (budget)" — when that
   * is below `minVersionUsd`.
   */
  versionCap(minVersionUsd: number): number | null {
    const cap = floorCents(this.capUsd - this.upperBoundUsd() - this.reserveFactor * this.perCallCapUsd);
    return cap >= minVersionUsd ? cap : null;
  }

  /** True once one more call could take the upper bound past the total cap. */
  mustStopNow(): boolean {
    return this.upperBoundUsd() + this.perCallCapUsd > this.capUsd;
  }

  snapshot(): BudgetSnapshot {
    return {
      capUsd: this.capUsd,
      perCallCapUsd: this.perCallCapUsd,
      reserveFactor: this.reserveFactor,
      reportedUsd: this.reportedUsd,
      estimatedUsd: this.estimatedUsd,
      reportedCalls: this.reportedCalls,
      estimatedCalls: this.estimatedCalls,
      unreportedCalls: this.unreportedCalls,
      upperBoundUsd: this.upperBoundUsd(),
    };
  }
}
