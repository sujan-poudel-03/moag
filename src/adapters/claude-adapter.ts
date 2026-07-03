// ─── Claude Code CLI adapter ───
// Invokes the Claude Code CLI in print mode (-p) for non-interactive execution.

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../core/host';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId, TokenUsage } from '../models/types';
import { runCli } from './base-cli';

// Tools Claude Code CLI needs permission to use. Written to settings.local.json
// before spawn so the CLI flag is not the only gate.
const CLAUDE_ALLOW_ALL = [
  'Bash(*)', 'Write(*)', 'Edit(*)', 'Read(*)',
  'WebFetch(*)', 'TodoWrite', 'TodoRead',
  'NotebookRead(*)', 'NotebookEdit(*)',
];

// Patterns that indicate Claude Code is waiting for a permission prompt.
// Detected in output stream → surfaces a clear error instead of a silent hang.
const PERMISSION_PROMPT_RE = /do you want to (allow|proceed|run|continue)|press .* to (allow|continue)|\[y\/n\]|awaiting your (permission|approval)/i;

export class ClaudeAdapter implements EngineAdapter {
  readonly id: EngineId = 'claude';
  readonly displayName = 'Claude Code';

  getCommand(): string {
    return getConfig('agentTaskPlayer.engines.claude')
      .get<string>('command', 'claude');
  }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = getConfig('agentTaskPlayer.engines.claude');
    const command = this.getCommand();
    const extraArgs = config.get<string[]>('args', ['-p']);
    const autoApprove = config.get<boolean>('autoApprove', true);
    const extendedThinking = config.get<boolean>('extendedThinking', false);
    // Configurable so users can fix a renamed flag instantly via VS Code settings
    // without waiting for a MOAG release.
    const autoApproveFlag = config.get<string>('autoApproveFlag', '--dangerously-skip-permissions');

    if (extendedThinking) {
      options = {
        ...options,
        prompt: `[EXTENDED THINKING ENABLED: Work through this problem systematically with deep analysis before producing your solution. Consider edge cases, alternative approaches, and potential issues.]\n\n${options.prompt}`,
      };
    }

    // ── Layer 1: write settings.local.json with broad permissions ──
    // This pre-authorises the known tool set via Claude's own settings
    // mechanism, so execution doesn't depend solely on the CLI flag.
    const permState = autoApprove ? this._preparePermissions(options.cwd) : null;

    // ── Layer 2: permission-prompt detector ──
    // Wrap onOutput to catch the case where neither layer worked and Claude
    // is sitting at an interactive prompt — surfaces a clear error.
    let permissionHangDetected = false;
    const wrappedOnOutput = options.onOutput
      ? (text: string, stream: 'stdout' | 'stderr') => {
          if (!permissionHangDetected && PERMISSION_PROMPT_RE.test(text)) {
            permissionHangDetected = true;
            options.onOutput!(
              '\n[MOAG] Claude Code is waiting for a permission approval.\n' +
              'The CLI interface may have changed. Update the flag via:\n' +
              '  VS Code Settings → agentTaskPlayer.engines.claude.autoApproveFlag\n',
              'stderr',
            );
          }
          options.onOutput!(text, stream);
        }
      : undefined;

    let result: EngineResult;
    try {
      result = await runCli(
        {
          command,
          buildArgs: () => {
            const args = [...extraArgs];
            // ── Layer 2: CLI flag (secondary, configurable) ──
            if (autoApprove && autoApproveFlag && !args.includes(autoApproveFlag)) {
              args.push(autoApproveFlag);
            }
            return args;
          },
          useStdin: true,
        },
        { ...options, onOutput: wrappedOnOutput },
        wrappedOnOutput,
      );
    } finally {
      if (permState) { this._restorePermissions(permState); }
    }

    result.tokenUsage = parseClaudeTokenUsage(result.stdout, result.stderr);
    return result;
  }

  // ── Settings.local.json helpers ──────────────────────────────────────────

  private _preparePermissions(cwd: string): { settingsPath: string; backup: string | null } | null {
    try {
      const dir = path.join(cwd, '.claude');
      const settingsPath = path.join(dir, 'settings.local.json');
      fs.mkdirSync(dir, { recursive: true });
      const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : null;
      const existing = backup ? JSON.parse(backup) : {};
      fs.writeFileSync(settingsPath, JSON.stringify({
        ...existing,
        permissions: { ...(existing.permissions ?? {}), allow: CLAUDE_ALLOW_ALL },
      }, null, 2));
      return { settingsPath, backup };
    } catch {
      return null;
    }
  }

  private _restorePermissions(info: { settingsPath: string; backup: string | null }): void {
    try {
      if (info.backup !== null) {
        fs.writeFileSync(info.settingsPath, info.backup);
      } else if (fs.existsSync(info.settingsPath)) {
        fs.unlinkSync(info.settingsPath);
      }
    } catch {
      // best-effort
    }
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
