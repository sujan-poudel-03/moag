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
          // Model override from auto-model selection
          if (opts.modelId && !args.some(a => a.startsWith('--model'))) {
            // Strip engine prefix (e.g., "claude-sonnet-4" → "sonnet-4")
            const model = opts.modelId.replace(/^claude-/, '');
            args.push('--model', model);
          }
          return args;
        },
        useStdin: true,
      },
      options,
      options.onOutput,
    );

    // Parse token usage from Claude Code output (may appear in stdout or stderr)
    result.tokenUsage = parseClaudeTokenUsage(result.stdout, result.stderr);
    return result;
  }
}

/**
 * Parse token usage from Claude Code CLI output.
 * Searches both stdout and stderr for token/cost stats.
 *
 * Known formats:
 *   - "input_tokens: 1234" / "output_tokens: 567" (JSON-ish)
 *   - "Input: 5,234 tokens | Output: 1,234 tokens" (summary line)
 *   - "Total input tokens: 1234"
 *   - "$0.0432" or "cost: $0.04" or "Cost: $0.04"
 *   - JSON block: {"input_tokens":1234,"output_tokens":567}
 */
function parseClaudeTokenUsage(stdout: string, stderr: string): TokenUsage | undefined {
  const combined = (stderr || '') + '\n' + (stdout || '');
  if (!combined.trim()) { return undefined; }

  const usage: TokenUsage = {};
  let found = false;

  // Try JSON block first: {"input_tokens":N,"output_tokens":N,...}
  const jsonMatch = combined.match(/\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)[^}]*/);
  if (jsonMatch) {
    usage.inputTokens = parseInt(jsonMatch[1], 10);
    usage.outputTokens = parseInt(jsonMatch[2], 10);
    found = true;
  }

  // Match patterns like "input tokens: 1234" or "input_tokens: 1234" or "Input: 1,234 tokens"
  if (!usage.inputTokens) {
    const inputMatch = combined.match(/input[_ ]?tokens[:\s]+([0-9,]+)/i)
      || combined.match(/Input:\s*([0-9,]+)\s*tokens/i);
    if (inputMatch) {
      usage.inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);
      found = true;
    }
  }

  if (!usage.outputTokens) {
    const outputMatch = combined.match(/output[_ ]?tokens[:\s]+([0-9,]+)/i)
      || combined.match(/Output:\s*([0-9,]+)\s*tokens/i);
    if (outputMatch) {
      usage.outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);
      found = true;
    }
  }

  const totalMatch = combined.match(/total[_ ]?tokens[:\s]+([0-9,]+)/i);
  if (totalMatch) {
    usage.totalTokens = parseInt(totalMatch[1].replace(/,/g, ''), 10);
    found = true;
  }

  // Compute total if we have input+output but no explicit total
  if (usage.inputTokens && usage.outputTokens && !usage.totalTokens) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  // Match cost like "$0.0123" or "cost: $0.04" or "Cost: $0.04"
  const costMatch = combined.match(/(?:cost[:\s]*)\$([0-9]+\.?[0-9]*)/i)
    || combined.match(/\$([0-9]+\.[0-9]{2,})/);
  if (costMatch) {
    usage.estimatedCost = parseFloat(costMatch[1]);
    found = true;
  }

  // Fallback: estimate cost from token counts using Claude Sonnet pricing
  // ($3/M input, $15/M output for Sonnet 4)
  if (!usage.estimatedCost && (usage.inputTokens || usage.outputTokens)) {
    const inputCost = (usage.inputTokens || 0) * 3.0 / 1_000_000;
    const outputCost = (usage.outputTokens || 0) * 15.0 / 1_000_000;
    usage.estimatedCost = Math.round((inputCost + outputCost) * 10000) / 10000;
    found = true;
  }

  return found ? usage : undefined;
}
