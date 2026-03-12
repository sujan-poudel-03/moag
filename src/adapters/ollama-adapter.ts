// ─── Ollama CLI adapter ───
// Invokes a local Ollama model via `ollama run <model> "<prompt>"`.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId, TokenUsage } from '../models/types';
import { runCli } from './base-cli';

export class OllamaAdapter implements EngineAdapter {
  readonly id: EngineId = 'ollama';
  readonly displayName = 'Ollama (Local)';

  getCommand(): string {
    return vscode.workspace.getConfiguration('agentTaskPlayer.engines.ollama')
      .get<string>('command', 'ollama');
  }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.ollama');
    const command = this.getCommand();
    const model = config.get<string>('model', 'codellama');

    const result = await runCli(
      {
        command,
        buildArgs: (opts) => {
          // Model override: strip engine prefix (e.g., "ollama-codellama" → "codellama")
          const effectiveModel = opts.modelId ? opts.modelId.replace(/^ollama-/, '') : model;
          return ['run', effectiveModel];
        },
        useStdin: true,
      },
      options,
      options.onOutput,
    );

    result.tokenUsage = parseOllamaTokenUsage(result.stdout, result.stderr, options.prompt);
    return result;
  }
}

/** Parse token usage from Ollama output, or estimate from word count */
function parseOllamaTokenUsage(stdout: string, stderr: string, prompt: string): TokenUsage | undefined {
  const combined = (stderr || '') + '\n' + (stdout || '');

  const usage: TokenUsage = {};
  let found = false;

  // Ollama may report eval stats in stderr: "eval count: 234 token(s)"
  const evalMatch = combined.match(/eval count[:\s]+(\d+)/i);
  if (evalMatch) { usage.outputTokens = parseInt(evalMatch[1], 10); found = true; }

  const promptMatch = combined.match(/prompt eval count[:\s]+(\d+)/i);
  if (promptMatch) { usage.inputTokens = parseInt(promptMatch[1], 10); found = true; }

  // Fallback: estimate from word counts (~1.3 tokens per word)
  if (!usage.inputTokens && prompt) {
    usage.inputTokens = Math.ceil(prompt.split(/\s+/).length * 1.3);
    found = true;
  }
  if (!usage.outputTokens && stdout) {
    usage.outputTokens = Math.ceil(stdout.split(/\s+/).length * 1.3);
    found = true;
  }

  if (usage.inputTokens || usage.outputTokens) {
    usage.totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  }

  // Ollama is local — no cost
  usage.estimatedCost = 0;

  return found ? usage : undefined;
}
