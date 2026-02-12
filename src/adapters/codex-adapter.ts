// ─── Codex CLI adapter ───
// Invokes the OpenAI Codex CLI tool to run a task.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
import { runCli } from './base-cli';

export class CodexAdapter implements EngineAdapter {
  readonly id: EngineId = 'codex';
  readonly displayName = 'Codex CLI';

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.codex');
    const command = config.get<string>('command', 'codex');
    const extraArgs = config.get<string[]>('args', []);

    return runCli(
      {
        command,
        buildArgs: (opts) => {
          const args = [...extraArgs];
          // Pass the prompt as a positional argument
          args.push(opts.prompt);
          return args;
        },
      },
      options,
    );
  }
}
