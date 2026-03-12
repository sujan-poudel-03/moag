import { EngineId } from './types';

export interface ModelSpec {
  id: string;
  displayName: string;
  engine: EngineId;
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
  reasoning: 'low' | 'medium' | 'high' | 'extra-high';
}

const specs: ModelSpec[] = [
  // Claude
  { id: 'opus-4',       displayName: 'Claude Opus 4',       engine: 'claude', contextWindow: 200_000,   inputPrice: 15,    outputPrice: 75,    reasoning: 'extra-high' },
  { id: 'sonnet-4',     displayName: 'Claude Sonnet 4',     engine: 'claude', contextWindow: 200_000,   inputPrice: 3,     outputPrice: 15,    reasoning: 'high' },
  { id: 'haiku-4.5',    displayName: 'Claude Haiku 4.5',    engine: 'claude', contextWindow: 200_000,   inputPrice: 0.80,  outputPrice: 4,     reasoning: 'medium' },

  // Codex / OpenAI
  { id: 'gpt-4.1',      displayName: 'GPT-4.1',             engine: 'codex',  contextWindow: 1_000_000, inputPrice: 2,     outputPrice: 8,     reasoning: 'high' },
  { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini',        engine: 'codex',  contextWindow: 1_000_000, inputPrice: 0.40,  outputPrice: 1.60,  reasoning: 'medium' },
  { id: 'o3',           displayName: 'o3',                   engine: 'codex',  contextWindow: 200_000,   inputPrice: 10,    outputPrice: 40,    reasoning: 'extra-high' },
  { id: 'o4-mini',      displayName: 'o4-mini',              engine: 'codex',  contextWindow: 200_000,   inputPrice: 1.10,  outputPrice: 4.40,  reasoning: 'high' },

  // Gemini
  { id: 'gemini-2.5-pro',   displayName: 'Gemini 2.5 Pro',   engine: 'gemini', contextWindow: 1_000_000, inputPrice: 1.25,  outputPrice: 10,    reasoning: 'high' },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', engine: 'gemini', contextWindow: 1_000_000, inputPrice: 0.15,  outputPrice: 0.60,  reasoning: 'medium' },

  // Ollama (generic local)
  { id: 'local',        displayName: 'Local Model (Ollama)', engine: 'ollama', contextWindow: 128_000,   inputPrice: 0,     outputPrice: 0,     reasoning: 'medium' },
];

const modelMap = new Map<string, ModelSpec>(specs.map(s => [s.id, s]));

const defaultModels: Record<string, string> = {
  claude: 'sonnet-4',
  codex:  'gpt-4.1',
  gemini: 'gemini-2.5-pro',
  ollama: 'local',
};

export function getModelSpec(modelId: string): ModelSpec | undefined {
  return modelMap.get(modelId);
}

export function getModelsForEngine(engineId: EngineId): ModelSpec[] {
  return specs.filter(s => s.engine === engineId);
}

export function getDefaultModelForEngine(engineId: EngineId): ModelSpec | undefined {
  const id = defaultModels[engineId];
  return id ? modelMap.get(id) : undefined;
}

export function getAllModelSpecs(): ModelSpec[] {
  return [...specs];
}
