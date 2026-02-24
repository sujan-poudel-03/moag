// ─── Codex CLI adapter ───
// Invokes the OpenAI Codex CLI in non-interactive mode via `codex exec`.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
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

    return runCli(
      {
        command,
        buildArgs: (opts) => {
          // Use `codex exec` for non-interactive execution
          const args = ['exec', ...extraArgs, opts.prompt];
          return args;
        },
      },
      options,
      options.onOutput,
    );
  }
}
