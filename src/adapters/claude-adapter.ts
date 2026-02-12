// ─── Claude Code CLI adapter ───
// Invokes the Claude Code CLI in print mode (-p) for non-interactive execution.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
import { runCli } from './base-cli';

export class ClaudeAdapter implements EngineAdapter {
  readonly id: EngineId = 'claude';
  readonly displayName = 'Claude Code';

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.claude');
    const command = config.get<string>('command', 'claude');
    const extraArgs = config.get<string[]>('args', ['-p']);

    return runCli(
      {
        command,
        buildArgs: (opts) => {
          const args = [...extraArgs];
          // Claude Code uses -p for non-interactive print mode
          // The prompt is passed as the final positional argument
          args.push(opts.prompt);
          return args;
        },
      },
      options,
    );
  }
}
