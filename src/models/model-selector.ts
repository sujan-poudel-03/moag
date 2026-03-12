import { Task, EngineId } from './types';
import { ModelSpec, getModelsForEngine, getDefaultModelForEngine } from './model-specs';

export type ReasoningPreset = 'auto' | 'fast' | 'balanced' | 'deep';

export interface ModelSelection {
  modelId: string;
  spec: ModelSpec;
  reason: string;
  preset: ReasoningPreset;
}

// Keywords that suggest architectural / high-complexity work
const COMPLEX_KEYWORDS = [
  'refactor', 'redesign', 'migrate', 'architect',
  'system', 'security', 'auth', 'complex',
  'optimize', 'performance', 'database schema', 'api design',
];

// Keywords that suggest simple / boilerplate work
const SIMPLE_KEYWORDS = [
  'create file', 'rename', 'format', 'typo',
  'boilerplate', 'scaffold', 'template', 'stub', 'placeholder',
];

/** Map a reasoning preset to the ModelSpec reasoning tiers it should pick from. */
const PRESET_TO_REASONING: Record<Exclude<ReasoningPreset, 'auto'>, ModelSpec['reasoning'][]> = {
  fast:     ['low', 'medium'],
  balanced: ['medium', 'high'],
  deep:     ['high', 'extra-high'],
};

/**
 * Compute a complexity score (0–100) from task signals.
 * Returns the score and a list of human-readable factors.
 */
function computeComplexity(task: Task): { score: number; factors: string[] } {
  let score = 0;
  const factors: string[] = [];
  const promptLen = task.prompt?.length ?? 0;
  const promptLower = (task.prompt ?? '').toLowerCase();

  // --- Prompt length ---
  if (promptLen > 1000) {
    score += 60;
    factors.push(`long prompt (${promptLen.toLocaleString()} chars)`);
  } else if (promptLen > 500) {
    score += 40;
    factors.push(`medium-long prompt (${promptLen} chars)`);
  } else if (promptLen > 200) {
    score += 25;
    factors.push(`medium prompt (${promptLen} chars)`);
  } else {
    score += 10;
    factors.push(`short prompt (${promptLen} chars)`);
  }

  // --- Architectural keywords ---
  const matchedComplex: string[] = [];
  for (const kw of COMPLEX_KEYWORDS) {
    if (promptLower.includes(kw)) {
      score += 8;
      matchedComplex.push(kw);
    }
  }
  if (matchedComplex.length > 0) {
    factors.push(`architecture keywords: ${matchedComplex.join(', ')}`);
  }

  // --- Simple keywords ---
  const matchedSimple: string[] = [];
  for (const kw of SIMPLE_KEYWORDS) {
    if (promptLower.includes(kw)) {
      score -= 10;
      matchedSimple.push(kw);
    }
  }
  if (matchedSimple.length > 0) {
    factors.push(`simple keywords: ${matchedSimple.join(', ')}`);
  }

  // --- File count ---
  const fileCount = task.files?.length ?? 0;
  if (fileCount > 0) {
    score += fileCount * 3;
    factors.push(`${fileCount} file(s) referenced`);
  }

  // --- Dependencies ---
  if (task.dependsOn && task.dependsOn.length > 0) {
    score += 15;
    factors.push(`has ${task.dependsOn.length} dependency(ies)`);
  }

  // --- Verify command ---
  if (task.verifyCommand) {
    score += 10;
    factors.push('has verify command');
  }

  // Clamp to 0–100
  score = Math.max(0, Math.min(100, score));

  return { score, factors };
}

/** Map a complexity score to a reasoning preset. */
function scoreToPreset(score: number): Exclude<ReasoningPreset, 'auto'> {
  if (score <= 25) { return 'fast'; }
  if (score <= 50) { return 'balanced'; }
  return 'deep';
}

/**
 * Pick the best model from the available engine models for a given reasoning tier.
 *
 * Strategy: find the cheapest model whose reasoning level is in the tier's
 * allowed set. If nothing matches, fall back to the engine default.
 */
function pickModel(
  models: ModelSpec[],
  tiers: ModelSpec['reasoning'][],
): ModelSpec | undefined {
  const candidates = models.filter(m => tiers.includes(m.reasoning));
  if (candidates.length === 0) { return undefined; }

  // For "deep", prefer the highest reasoning; for "fast", prefer the lowest cost.
  // Sort by reasoning rank descending, then by input price ascending.
  const reasoningRank: Record<string, number> = {
    low: 0,
    medium: 1,
    high: 2,
    'extra-high': 3,
  };

  // For deep presets we want the strongest model; for fast we want the cheapest.
  const preferStrong = tiers.includes('extra-high');

  candidates.sort((a, b) => {
    if (preferStrong) {
      const rDiff = reasoningRank[b.reasoning] - reasoningRank[a.reasoning];
      if (rDiff !== 0) { return rDiff; }
      return a.inputPrice - b.inputPrice; // tie-break on price
    }
    // Fast / balanced: cheapest first
    return a.inputPrice - b.inputPrice;
  });

  return candidates[0];
}

/**
 * Auto-select the best model for a task based on complexity signals.
 *
 * - `auto` mode analyses the task and picks fast / balanced / deep.
 * - Explicit presets skip analysis and go directly to the matching tier.
 */
export function selectModel(
  task: Task,
  engineId: EngineId,
  preset: ReasoningPreset = 'auto',
): ModelSelection {
  const models = getModelsForEngine(engineId);

  // Determine effective preset
  let effectivePreset: Exclude<ReasoningPreset, 'auto'>;
  let reason: string;

  if (preset === 'auto') {
    const { score, factors } = computeComplexity(task);
    effectivePreset = scoreToPreset(score);
    reason = `Score ${score}/100 (${effectivePreset}): ${factors.join('; ')}`;
  } else {
    effectivePreset = preset;
    reason = `Preset override: ${preset}`;
  }

  const tiers = PRESET_TO_REASONING[effectivePreset];
  let spec = pickModel(models, tiers);

  // Fallback: try the engine default
  if (!spec) {
    spec = getDefaultModelForEngine(engineId);
  }

  // Ultimate fallback: synthesise a placeholder spec
  if (!spec) {
    spec = {
      id: 'unknown',
      displayName: `Default (${engineId})`,
      engine: engineId,
      contextWindow: 128_000,
      inputPrice: 0,
      outputPrice: 0,
      reasoning: 'medium',
    };
    reason += ' [fallback: no models registered for engine]';
  }

  return {
    modelId: spec.id,
    spec,
    reason,
    preset: effectivePreset,
  };
}
