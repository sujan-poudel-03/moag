// ─── Ollama CLI adapter ───
// Invokes a local Ollama model via `ollama run <model> "<prompt>"`.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
import { runCli } from './base-cli';

export class OllamaAdapter implements EngineAdapter {
  readonly id: EngineId = 'ollama';
  readonly displayName = 'Ollama (Local)';

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.ollama');
    const command = config.get<string>('command', 'ollama');
    const model = config.get<string>('model', 'codellama');

    return runCli(
      {
        command,
        buildArgs: (opts) => {
          // ollama run <model> "<prompt>"
          return ['run', model, opts.prompt];
        },
      },
      options,
    );
  }
}
