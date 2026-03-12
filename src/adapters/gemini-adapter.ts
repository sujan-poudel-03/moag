// ─── Gemini CLI adapter ───
// Invokes Google's Gemini CLI tool for task execution.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId, TokenUsage } from '../models/types';
import { runCli } from './base-cli';

export class GeminiAdapter implements EngineAdapter {
  readonly id: EngineId = 'gemini';
  readonly displayName = 'Gemini CLI';

  getCommand(): string {
    return vscode.workspace.getConfiguration('agentTaskPlayer.engines.gemini')
      .get<string>('command', 'gemini');
  }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.gemini');
    const command = this.getCommand();
    const extraArgs = config.get<string[]>('args', []);

    const result = await runCli(
      {
        command,
        buildArgs: (opts) => {
          const args = [...extraArgs];
          if (opts.modelId && !args.some(a => a.startsWith('--model'))) {
            const model = opts.modelId.replace(/^gemini-/, '');
            args.push('--model', model);
          }
          return args;
        },
        useStdin: true,
      },
      options,
      options.onOutput,
    );

    result.tokenUsage = parseGeminiTokenUsage(result.stdout, result.stderr);
    return result;
  }
}

/** Parse token usage from Gemini CLI output */
function parseGeminiTokenUsage(stdout: string, stderr: string): TokenUsage | undefined {
  const combined = (stderr || '') + '\n' + (stdout || '');
  if (!combined.trim()) { return undefined; }

  const usage: TokenUsage = {};
  let found = false;

  const inputMatch = combined.match(/input[_ ]?tokens[:\s]+([0-9,]+)/i)
    || combined.match(/prompt[_ ]?tokens[:\s]+([0-9,]+)/i);
  if (inputMatch) { usage.inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10); found = true; }

  const outputMatch = combined.match(/output[_ ]?tokens[:\s]+([0-9,]+)/i)
    || combined.match(/candidates?[_ ]?tokens[:\s]+([0-9,]+)/i);
  if (outputMatch) { usage.outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10); found = true; }

  const totalMatch = combined.match(/total[_ ]?tokens[:\s]+([0-9,]+)/i);
  if (totalMatch) { usage.totalTokens = parseInt(totalMatch[1].replace(/,/g, ''), 10); found = true; }

  if (usage.inputTokens && usage.outputTokens && !usage.totalTokens) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  return found ? usage : undefined;
}
