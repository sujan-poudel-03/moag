// ─── GitHub Copilot adapter ───
// Uses VS Code's vscode.lm API to send prompts to GitHub Copilot.

import * as vscode from 'vscode';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId } from '../models/types';

export class CopilotAdapter implements EngineAdapter {
  readonly id: EngineId = 'copilot';
  readonly displayName = 'GitHub Copilot';

  getCommand(): string { return 'copilot'; }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const startTime = Date.now();
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
      const msg = 'GitHub Copilot is not available. Install the GitHub Copilot extension and sign in.';
      options.onOutput?.(msg, 'stderr');
      return { stdout: '', stderr: msg, exitCode: 1, durationMs: Date.now() - startTime, command: 'copilot' };
    }

    const modelId = options.modelId;
    const model = modelId ? (models.find(m => m.id === modelId) ?? models[0]) : models[0];

    options.onOutput?.(`── Command ──\nGitHub Copilot (${model.id})\n\n── Response ──\n`, 'stdout');

    const cts = new vscode.CancellationTokenSource();
    if (options.signal) {
      options.signal.addEventListener('abort', () => cts.cancel(), { once: true });
    }

    try {
      const messages = [vscode.LanguageModelChatMessage.User(options.prompt)];
      const response = await model.sendRequest(messages, {}, cts.token);
      let output = '';
      for await (const chunk of response.text) {
        output += chunk;
        options.onOutput?.(chunk, 'stdout');
        if (options.signal?.aborted) { break; }
      }
      return { stdout: output, stderr: '', exitCode: 0, durationMs: Date.now() - startTime, command: `copilot:${model.id}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      options.onOutput?.(msg, 'stderr');
      return { stdout: '', stderr: msg, exitCode: 1, durationMs: Date.now() - startTime, command: 'copilot' };
    } finally {
      cts.dispose();
    }
  }
}
