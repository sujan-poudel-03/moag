// ─── Register all built-in engine adapters ───

import { registerEngine } from './engine';
import { CodexAdapter } from './codex-adapter';
import { ClaudeAdapter } from './claude-adapter';
import { GeminiAdapter } from './gemini-adapter';
import { OllamaAdapter } from './ollama-adapter';
import { CustomAdapter } from './custom-adapter';
import { CopilotAdapter } from './copilot-adapter';
import { AnthropicAdapter } from './anthropic-adapter';

export function registerAllEngines(): void {
  registerEngine(new CodexAdapter());
  registerEngine(new ClaudeAdapter());
  registerEngine(new GeminiAdapter());
  registerEngine(new OllamaAdapter());
  registerEngine(new CustomAdapter());
  registerEngine(new CopilotAdapter());
  registerEngine(new AnthropicAdapter());
}

export { AnthropicAdapter } from './anthropic-adapter';

export { getEngine, getAllEngines, checkEngineAvailability } from './engine';
export type { EngineAdapter, EngineRunOptions, EngineAvailability } from './engine';
