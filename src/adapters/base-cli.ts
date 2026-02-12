// ─── Base CLI adapter — shared spawn logic for all CLI-based engines ───

import { spawn } from 'child_process';
import { EngineResult } from '../models/types';
import { EngineRunOptions } from './engine';

export interface CliConfig {
  /** Command to execute (e.g. "claude", "codex") */
  command: string;
  /** Build the full argument list for this engine */
  buildArgs(options: EngineRunOptions): string[];
  /** Optional environment variable overrides */
  env?: Record<string, string>;
}

/**
 * Spawns a CLI process and captures its output.
 * Resolves when the process exits; rejects only on spawn errors.
 */
export function runCli(config: CliConfig, options: EngineRunOptions): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const args = config.buildArgs(options);

    const proc = spawn(config.command, args, {
      cwd: options.cwd,
      shell: true,
      env: { ...process.env, ...config.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Handle abort signal — kill the child process
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      }, { once: true });
    }

    proc.on('error', (err) => {
      reject(new Error(`Failed to start "${config.command}": ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        durationMs: Date.now() - startTime,
      });
    });
  });
}
