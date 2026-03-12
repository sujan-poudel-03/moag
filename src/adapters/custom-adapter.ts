// ─── Custom CLI adapter ───
// Lets users configure an arbitrary command with {prompt} placeholder.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';
import { runCli } from './base-cli';

export class CustomAdapter implements EngineAdapter {
  readonly id: EngineId = 'custom';
  readonly displayName = 'Custom Engine';

  getCommand(): string {
    return vscode.workspace.getConfiguration('agentTaskPlayer.engines.custom')
      .get<string>('command', '');
  }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const config = vscode.workspace.getConfiguration('agentTaskPlayer.engines.custom');
    const command = this.getCommand();
    const argTemplates = config.get<string[]>('args', []);

    if (!command) {
      return {
        stdout: '',
        stderr: 'Custom engine command is not configured. Set agentTaskPlayer.engines.custom.command in settings.',
        exitCode: 1,
        durationMs: 0,
      };
    }

    // If no {prompt} placeholder in args, pipe prompt via stdin (safer on Windows)
    const hasPlaceholder = argTemplates.some(arg => arg.includes('{prompt}'));

    return runCli(
      {
        command,
        buildArgs: (opts) => {
          if (hasPlaceholder) {
            return argTemplates.map(arg => arg.split('{prompt}').join(opts.prompt));
          }
          return [...argTemplates];
        },
        useStdin: !hasPlaceholder,
      },
      options,
      options.onOutput,
    );
  }
}
