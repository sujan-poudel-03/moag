// ─── Session cost ledger ─────────────────────────────────────────────────────
//
// A process-wide, in-memory accumulator for AI spend. Every engine call routed
// through the adapter registry records its usage here, so authoring calls made
// outside TaskRunner.play() (PRD chat, plan generation, task splitting, …)
// count toward the same ceiling as plan execution.
//
// Deliberately dependency-free: no `vscode`, no `fs`, no project imports. That
// keeps it usable from adapters, the runner, the headless CLI, and tests alike.
// Deliberately NOT persisted — the ledger is session-scoped and resets with the
// process.

/** One recorded spend event, delivered to every listener. */
export interface CostEvent {
  /** Estimated USD cost of this single call. */
  estimatedCostUsd: number;
  /** Input tokens reported by the engine (0 when unknown). */
  inputTokens: number;
  /** Output tokens reported by the engine (0 when unknown). */
  outputTokens: number;
  /** Engine that produced the cost (`EngineId` as a plain string). */
  engineId: string;
  /**
   * Attribution label — a documented free string, NOT a closed union.
   * Known values today: 'task', 'ai-rules', 'plan-generation', 'prd-chat',
   * 'prd-improve', 'prd-loop', 'task-split', 'conversation', 'unattributed'.
   */
  label: string;
  /** Running lifetime total *including* this event. */
  lifetimeUsd: number;
}

/** Notified synchronously on every recorded cost event. */
export type CostListener = (event: CostEvent) => void;

/** Shape of the usage block adapters attach to an `EngineResult`. */
interface CostUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

/** Attribution metadata supplied by the recording call site. */
interface CostMeta {
  engineId: string;
  label?: string;
}

class CostLedger {
  private _lifetimeUsd = 0;
  private _listeners = new Set<CostListener>();

  /**
   * Add a call's cost to the lifetime total and notify listeners.
   * No-ops on missing, non-finite, or negative costs — a malformed usage block
   * must never corrupt the running total.
   */
  record(usage: CostUsage | undefined, meta: CostMeta): void {
    const estimatedCost = usage?.estimatedCost;
    if (estimatedCost === undefined || !Number.isFinite(estimatedCost) || estimatedCost < 0) {
      return;
    }

    this._lifetimeUsd += estimatedCost;

    const event: CostEvent = {
      estimatedCostUsd: estimatedCost,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      engineId: meta.engineId,
      label: meta.label ?? 'unattributed',
      lifetimeUsd: this._lifetimeUsd,
    };

    // Each listener is isolated: one that throws must break neither the
    // accounting nor the engine call that triggered the record.
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(event);
      } catch {
        // Swallowed on purpose — see above.
      }
    }
  }

  /** Subscribe to cost events. Returns an idempotent unsubscribe function. */
  onRecord(listener: CostListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** Total estimated spend since process start (or since the last reset()). */
  getLifetimeUsd(): number {
    return this._lifetimeUsd;
  }

  /** Zero the total. Listeners are intentionally kept subscribed. */
  reset(): void {
    this._lifetimeUsd = 0;
  }

  /** Number of active listeners — test introspection only. */
  listenerCount(): number {
    return this._listeners.size;
  }
}

/** Process-wide singleton ledger. */
export const costLedger = new CostLedger();
