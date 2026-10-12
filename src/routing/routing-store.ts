import * as fs from 'fs';
import * as path from 'path';
import { EngineId, ENGINE_IDS } from '../models/types';

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

/** Result of {@link validateRoutingConfig}: the kept fields plus a note per dropped one. */
export interface RoutingValidationResult {
  config: RoutingRuleConfig;
  dropped: string[];
}

function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * Validate an untrusted `.moag/routing.json` payload field by field. The file
 * lives in the repo, so it is attacker-controllable on a hosted server: an
 * engine value outside `ENGINE_IDS` (e.g. `"rm"`) must never reach the
 * router. Invalid fields are dropped and described in `dropped`; unknown keys
 * are ignored. A non-object payload (array, null, scalar) yields `{}`.
 */
export function validateRoutingConfig(raw: unknown): RoutingValidationResult {
  const config: RoutingRuleConfig = {};
  const dropped: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config, dropped };
  }
  const src = raw as Record<string, unknown>;
  const describe = (v: unknown): string => {
    try { return JSON.stringify(v).slice(0, 80); } catch { return String(v); }
  };

  if (src.enabled !== undefined) {
    if (typeof src.enabled === 'boolean') { config.enabled = src.enabled; }
    else { dropped.push(`enabled: expected boolean, got ${describe(src.enabled)}`); }
  }
  for (const key of ['simpleEngine', 'complexEngine'] as const) {
    const v = src[key];
    if (v === undefined) { continue; }
    if (isEngineId(v)) { config[key] = v; }
    else { dropped.push(`${key}: ${describe(v)} is not a known engine id`); }
  }
  if (src.complexityThreshold !== undefined) {
    const v = src.complexityThreshold;
    if (typeof v === 'number' && Number.isFinite(v)) { config.complexityThreshold = v; }
    else { dropped.push(`complexityThreshold: expected a finite number, got ${describe(v)}`); }
  }
  return { config, dropped };
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
    return validateRoutingConfig(parsed).config;
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
