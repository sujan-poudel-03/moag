// ─── Claude Code CLI adapter ───
// Invokes the Claude Code CLI in print mode (-p) for non-interactive execution.

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../core/host';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
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
    // JSON mode: the CLI reports its own total_cost_usd (the hosted server
    // forces it on). Text mode streams live output but has no reliable cost.
    const jsonMode = config.get<string>('outputFormat', 'text') === 'json';
    const maxBudgetUsdPerCall = config.get<number>('maxBudgetUsdPerCall', 0);

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
            if (jsonMode && !hasFlag(args, '--output-format')) {
              args.push('--output-format', 'json');
            }
            if (typeof maxBudgetUsdPerCall === 'number' && Number.isFinite(maxBudgetUsdPerCall) && maxBudgetUsdPerCall > 0
              && !hasFlag(args, '--max-budget-usd')) {
              args.push('--max-budget-usd', maxBudgetUsdPerCall.toFixed(2));
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

    if (jsonMode) {
      // Never fall back to text scraping or a price table here: a JSON-mode
      // call either reports its own cost or reports none.
      applyClaudeJsonResult(result);
      return result;
    }
    // Text mode carries no cost figure. Numbers in the agent's prose are the
    // agent's words, not billing: the cost is unknown, never guessed.
    result.tokenUsage = { costSource: 'unknown' };
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

/** True when `flag` (or `flag=value`) is already in `args`. */
function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/** The `--output-format json` result object (only the fields MOAG reads). */
interface ClaudeJsonResult {
  type: 'result';
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** The last stdout line (or the whole stdout) that parses as a `type: "result"` object. */
export function findClaudeJsonResult(stdout: string): ClaudeJsonResult | null {
  const candidates = [...(stdout || '').split(/\r?\n/).reverse(), stdout || ''];
  for (const raw of candidates) {
    const line = raw.trim();
    if (!line.startsWith('{')) { continue; }
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o) && (o as { type?: unknown }).type === 'result') {
        return o as ClaudeJsonResult;
      }
    } catch { /* not this line */ }
  }
  return null;
}

/**
 * Rewrite a JSON-mode result in place: stdout becomes the model's text (so
 * plan and verify parsing downstream are unchanged), `tokenUsage` carries the
 * CLI's own `total_cost_usd` as a reported cost, and `is_error` fails the call.
 * Unparsable output leaves stdout raw and `tokenUsage` undefined.
 */
export function applyClaudeJsonResult(result: EngineResult): void {
  result.tokenUsage = undefined;
  const obj = findClaudeJsonResult(result.stdout);
  if (!obj) { return; }
  if (typeof obj.result === 'string') { result.stdout = obj.result; }
  const cost = obj.total_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const inputTokens = num(obj.usage?.input_tokens);
    const outputTokens = num(obj.usage?.output_tokens);
    result.tokenUsage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      estimatedCost: cost,
      costSource: 'reported',
    };
  }
  if (obj.is_error === true) {
    result.exitCode = result.exitCode || 1;
    const subtype = typeof obj.subtype === 'string' ? obj.subtype : 'error';
    const text = typeof obj.result === 'string' ? obj.result : '';
    result.stderr = `${result.stderr ?? ''}\n[claude] ${subtype}: ${text}`;
  }
}

