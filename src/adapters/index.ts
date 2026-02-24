// ─── Register all built-in engine adapters ───

import { registerEngine } from './engine';
import { CodexAdapter } from './codex-adapter';
import { ClaudeAdapter } from './claude-adapter';
import { GeminiAdapter } from './gemini-adapter';
import { OllamaAdapter } from './ollama-adapter';
import { CustomAdapter } from './custom-adapter';

export function registerAllEngines(): void {
  registerEngine(new CodexAdapter());
  registerEngine(new ClaudeAdapter());
  registerEngine(new GeminiAdapter());
  registerEngine(new OllamaAdapter());
  registerEngine(new CustomAdapter());
}

export { getEngine, getAllEngines, checkEngineAvailability } from './engine';
export type { EngineAdapter, EngineRunOptions, EngineAvailability } from './engine';
