// ─── Custom CLI adapter ───
// Lets users configure an arbitrary command with {prompt} placeholder.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
import { runCli } from './base-cli';

export class CustomAdapter implements EngineAdapter {
  readonly id: EngineId = 'custom';
  readonly displayName = 'Custom Engine';

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.custom');
    const command = config.get<string>('command', '');
    const argTemplates = config.get<string[]>('args', []);

    if (!command) {
      return {
        stdout: '',
        stderr: 'Custom engine command is not configured. Set agentTaskPlayer.engines.custom.command in settings.',
        exitCode: 1,
        durationMs: 0,
      };
    }

    return runCli(
      {
        command,
        buildArgs: (opts) => {
          // Replace {prompt} placeholder in each argument
          return argTemplates.map(arg => arg.replace(/\{prompt\}/g, opts.prompt));
        },
      },
      options,
    );
  }
}
