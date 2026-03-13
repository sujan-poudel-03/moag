// ─── Codex CLI adapter ───
// Invokes the OpenAI Codex CLI in non-interactive mode via `codex exec`.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId, TokenUsage } from '../models/types';
import { runCli } from './base-cli';

export class CodexAdapter implements EngineAdapter {
  readonly id: EngineId = 'codex';
  readonly displayName = 'Codex CLI';

  getCommand(): string {
    return vscode.workspace.getConfiguration('agentTaskPlayer.engines.codex')
      .get<string>('command', 'codex');
  }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.codex');
    const command = this.getCommand();
    const extraArgs = config.get<string[]>('args', []);

    const autoApprove = config.get<boolean>('autoApprove', true);

    const result = await runCli(
      {
        command,
        buildArgs: (opts) => {
          const args = buildCodexArgs(extraArgs, opts.modelId);
          if (autoApprove && !args.includes('--full-auto')) {
            args.push('--full-auto');
          }
          // Let Codex CLI pick its own default model unless the user
          // explicitly configured a model override in settings.
          return args;
        },
        useStdin: true,
      },
      options,
      options.onOutput,
    );

    result.tokenUsage = parseCodexTokenUsage(result.stdout, result.stderr);
    return result;
  }
}

function buildCodexArgs(extraArgs: string[], modelId?: string): string[] {
  const args = ['exec'];
  let hasExplicitModel = false;

  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];

    if (arg === '-m' || arg === '--model') {
      hasExplicitModel = true;
      const configuredModel = extraArgs[i + 1];
      args.push(arg);
      if (configuredModel !== undefined) {
        args.push(shouldReplaceLegacyModel(configuredModel, modelId) ? modelId! : configuredModel);
        i++;
      }
      continue;
    }

    if (arg.startsWith('--model=')) {
      hasExplicitModel = true;
      const configuredModel = arg.slice('--model='.length);
      args.push(shouldReplaceLegacyModel(configuredModel, modelId) ? `--model=${modelId}` : arg);
      continue;
    }

    args.push(arg);
  }

  return args;
}

function shouldReplaceLegacyModel(configuredModel: string, modelId?: string): boolean {
  if (!modelId) {
    return false;
  }
  return /^gpt-4([.-]|$)/i.test(configuredModel) || /^gpt-4o([.-]|$)/i.test(configuredModel);
}

/** Parse token usage from Codex CLI output (stdout + stderr) */
function parseCodexTokenUsage(stdout: string, stderr: string): TokenUsage | undefined {
  const combined = (stderr || '') + '\n' + (stdout || '');
  if (!combined.trim()) { return undefined; }

  const usage: TokenUsage = {};
  let found = false;

  // Match common patterns: "tokens: 1234", "input_tokens: N", "usage: {..."
  const inputMatch = combined.match(/input[_ ]?tokens[:\s]+([0-9,]+)/i);
  if (inputMatch) { usage.inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10); found = true; }

  const outputMatch = combined.match(/output[_ ]?tokens[:\s]+([0-9,]+)/i);
  if (outputMatch) { usage.outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10); found = true; }

  const totalMatch = combined.match(/total[_ ]?tokens[:\s]+([0-9,]+)/i);
  if (totalMatch) { usage.totalTokens = parseInt(totalMatch[1].replace(/,/g, ''), 10); found = true; }

  if (usage.inputTokens && usage.outputTokens && !usage.totalTokens) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  const costMatch = combined.match(/(?:cost[:\s]*)\$([0-9]+\.?[0-9]*)/i)
    || combined.match(/\$([0-9]+\.[0-9]{2,})/);
  if (costMatch) { usage.estimatedCost = parseFloat(costMatch[1]); found = true; }

  return found ? usage : undefined;
}
