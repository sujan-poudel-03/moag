// ─── Claude Code CLI adapter ───
// Invokes the Claude Code CLI in print mode (-p) for non-interactive execution.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId, TokenUsage } from '../models/types';
import { runCli } from './base-cli';

export class ClaudeAdapter implements EngineAdapter {
  readonly id: EngineId = 'claude';
  readonly displayName = 'Claude Code';

  getCommand(): string {
    return vscode.workspace.getConfiguration('agentTaskPlayer.engines.claude')
      .get<string>('command', 'claude');
  }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.claude');
    const command = this.getCommand();
    const extraArgs = config.get<string[]>('args', ['-p']);

    const autoApprove = config.get<boolean>('autoApprove', true);

    const result = await runCli(
      {
        command,
        buildArgs: (opts) => {
          const args = [...extraArgs];
          if (autoApprove && !args.includes('--dangerously-skip-permissions')) {
            args.push('--dangerously-skip-permissions');
          }
          // Claude Code uses -p for non-interactive print mode
          // The prompt is passed as the final positional argument
          args.push(opts.prompt);
          return args;
        },
      },
      options,
      options.onOutput,
    );

    // Parse token usage from Claude Code stderr output
    result.tokenUsage = parseClaudeTokenUsage(result.stderr);
    return result;
  }
}

/**
 * Parse token usage from Claude Code CLI output.
 * Claude Code may output usage stats in stderr like:
 *   "Total input tokens: 1234"
 *   "Total output tokens: 567"
 *   "Total tokens: 1801"
 *   or JSON-formatted usage blocks.
 */
function parseClaudeTokenUsage(stderr: string): TokenUsage | undefined {
  if (!stderr) { return undefined; }

  const usage: TokenUsage = {};
  let found = false;

  // Match patterns like "input tokens: 1234" or "input_tokens: 1234"
  const inputMatch = stderr.match(/input[_ ]tokens[:\s]+(\d+)/i);
  if (inputMatch) {
    usage.inputTokens = parseInt(inputMatch[1], 10);
    found = true;
  }

  const outputMatch = stderr.match(/output[_ ]tokens[:\s]+(\d+)/i);
  if (outputMatch) {
    usage.outputTokens = parseInt(outputMatch[1], 10);
    found = true;
  }

  const totalMatch = stderr.match(/total[_ ]tokens[:\s]+(\d+)/i);
  if (totalMatch) {
    usage.totalTokens = parseInt(totalMatch[1], 10);
    found = true;
  }

  // Compute total if we have input+output but no explicit total
  if (usage.inputTokens && usage.outputTokens && !usage.totalTokens) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  // Match cost like "$0.0123" or "cost: $0.0123"
  const costMatch = stderr.match(/\$(\d+\.?\d*)/);
  if (costMatch) {
    usage.estimatedCost = parseFloat(costMatch[1]);
    found = true;
  }

  return found ? usage : undefined;
}
