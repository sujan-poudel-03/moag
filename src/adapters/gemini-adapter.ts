// ─── Gemini CLI adapter ───
// Invokes Google's Gemini CLI tool for task execution.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
import { runCli } from './base-cli';

export class GeminiAdapter implements EngineAdapter {
  readonly id: EngineId = 'gemini';
  readonly displayName = 'Gemini CLI';

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.gemini');
    const command = config.get<string>('command', 'gemini');
    const extraArgs = config.get<string[]>('args', []);

    return runCli(
      {
        command,
        buildArgs: (opts) => {
          const args = [...extraArgs];
          args.push(opts.prompt);
          return args;
        },
      },
      options,
    );
  }
}
