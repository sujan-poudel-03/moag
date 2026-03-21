// ─── Execution Profiles ───
// Predefined configurations for trading off speed, quality, and cost.

import { EngineId } from './types';

export type ProfileName = 'auto' | 'fast' | 'balanced' | 'quality' | 'budget';
export type ModelPreset = 'fast' | 'balanced' | 'deep';

export interface ProfileConfig {
  preferredEngine: EngineId;
  modelPreset: ModelPreset;
  taskTimeoutMs: number;
  autoFix: boolean;
  promptRulesEnabled: boolean;
}

export interface ProfileMeta {
  name: ProfileName;
  label: string;
  description: string;
  icon: string;
}

const PROFILE_DEFINITIONS: Record<Exclude<ProfileName, 'auto'>, ProfileConfig> = {
  fast: {
    preferredEngine: 'claude',
    modelPreset: 'fast',
    taskTimeoutMs: 3 * 60 * 1000,
    autoFix: false,
    promptRulesEnabled: true,
  },
  balanced: {
    preferredEngine: 'claude',
    modelPreset: 'balanced',
    taskTimeoutMs: 10 * 60 * 1000,
    autoFix: true,
    promptRulesEnabled: true,
  },
  quality: {
    preferredEngine: 'claude',
    modelPreset: 'deep',
    taskTimeoutMs: 20 * 60 * 1000,
    autoFix: true,
    promptRulesEnabled: true,
  },
  budget: {
    preferredEngine: 'ollama',
    modelPreset: 'fast',
    taskTimeoutMs: 5 * 60 * 1000,
    autoFix: false,
    promptRulesEnabled: true,
  },
};

export const PROFILE_META: ProfileMeta[] = [
  { name: 'auto', label: 'Auto', description: 'Use default settings (balanced)', icon: '$(sparkle)' },
  { name: 'fast', label: 'Fast', description: 'Claude, fast model, 3min timeout, no auto-fix', icon: '$(zap)' },
  { name: 'balanced', label: 'Balanced', description: 'Claude, balanced model, 10min timeout, auto-fix on', icon: '$(symbol-event)' },
  { name: 'quality', label: 'Quality', description: 'Claude, deep model, 20min timeout, auto-fix on', icon: '$(star-full)' },
  { name: 'budget', label: 'Budget', description: 'Ollama (local), fast model, 5min timeout, no auto-fix', icon: '$(database)' },
];

/**
 * Resolve a profile name to its configuration.
 * 'auto' resolves to 'balanced'.
 */
export function resolveProfile(profileName: ProfileName | string, _taskComplexity?: number): ProfileConfig {
  const name = profileName === 'auto' ? 'balanced' : profileName;
  const config = PROFILE_DEFINITIONS[name as Exclude<ProfileName, 'auto'>];
  if (!config) {
    return PROFILE_DEFINITIONS.balanced;
  }
  return config;
}
