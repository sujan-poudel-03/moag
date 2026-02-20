// ─── Codex CLI adapter ───
// Invokes the OpenAI Codex CLI in non-interactive mode via `codex exec`.

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
