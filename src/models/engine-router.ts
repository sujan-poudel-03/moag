import { Task, EngineId, ENGINE_IDS } from './types';
import { computeComplexity } from './model-selector';

/** Per-workspace configuration for automatic engine routing by task complexity. */
export interface AutoRoutingConfig {
  enabled: boolean;
  simpleEngine: EngineId;
  complexEngine: EngineId;
  complexityThreshold: number;
}

/**
 * Resolve which engine a task should run on, based on a computed complexity
 * score against the configured threshold.
 *
 * Returns `null` when auto-routing is disabled, or when the configured
 * `simpleEngine`/`complexEngine` is not a member of `ENGINE_IDS` — a
 * malformed hand-edited config must never reach `getEngine()`
 * (`src/adapters/engine.ts:134-137`), which throws on an unregistered id.
 */
export function resolveAutoRoutedEngine(
  task: Task,
  config: AutoRoutingConfig,
): { engineId: EngineId; reason: string } | null {
  if (!config.enabled) {
    return null;
  }

  if (!ENGINE_IDS.includes(config.simpleEngine) || !ENGINE_IDS.includes(config.complexEngine)) {
    return null;
  }

  const { score, factors } = computeComplexity(task);
  const threshold = config.complexityThreshold;
  const engineId = score <= threshold ? config.simpleEngine : config.complexEngine;
  const reason = `Auto-routed to ${engineId}: score ${score}/100 (threshold ${threshold}) — ${factors.join('; ')}`;

  return { engineId, reason };
}
