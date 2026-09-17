import * as fs from 'fs';
import * as path from 'path';
import { EngineId } from '../models/types';

/**
 * Per-workspace overrides for automatic engine routing. All fields are
 * optional — this is a partial override on top of the VS Code settings
 * defaults, not a full config.
 */
export interface RoutingRuleConfig {
  enabled?: boolean;
  simpleEngine?: EngineId;
  complexEngine?: EngineId;
  complexityThreshold?: number;
}

function routingPath(root: string): string {
  return path.join(root, '.moag', 'routing.json');
}

/**
 * Load `.moag/routing.json` for a workspace. Fails open — a missing file or
 * malformed JSON both return `{}` rather than throwing, mirroring
 * `AiRulesStore.getWorkspaceRules` (`src/ai-rules/rules-store.ts:36-42`).
 */
export function loadWorkspaceRoutingConfig(root: string): RoutingRuleConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(routingPath(root), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as RoutingRuleConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Save `.moag/routing.json` for a workspace, creating the `.moag` directory
 * if it does not yet exist. Swallows write errors, mirroring
 * `AiRulesStore._saveWorkspace`.
 */
export function saveWorkspaceRoutingConfig(root: string, config: RoutingRuleConfig): void {
  try {
    fs.mkdirSync(path.join(root, '.moag'), { recursive: true });
    fs.writeFileSync(routingPath(root), JSON.stringify(config, null, 2), 'utf8');
  } catch { /* no-op */ }
}
