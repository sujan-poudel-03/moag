// ─── Base CLI adapter — shared spawn logic for all CLI-based engines ───

import { spawn } from 'child_process';
import { killProcess, SPAWN_DETACHED } from '../utils/process-kill';
import { EngineResult } from '../models/types';
import { EngineRunOptions } from './engine';

export interface CliConfig {
  /** Command to execute (e.g. "claude", "codex") */
  command: string;
  /** Build the full argument list for this engine */
  buildArgs(options: EngineRunOptions): string[];
  /** Optional environment variable overrides */
  env?: Record<string, string>;
  /**
   * If true, the prompt is piped via stdin instead of as a CLI argument.
   * The adapter's buildArgs should NOT include the prompt when this is set.
   * This avoids the Windows ~8K command-line length limit.
   */
  useStdin?: boolean;
}

/** Callback for streaming output chunks as they arrive */
export type OutputCallback = (chunk: string, stream: 'stdout' | 'stderr') => void;

/**
 * Escape an argument for safe use in a Windows cmd.exe shell.
 * Wraps in double quotes and escapes internal double quotes.
 */
function escapeWinArg(arg: string): string {
  // If it contains spaces, quotes, or special chars, wrap in double quotes
  if (/[\s"&|<>^%!]/.test(arg) || arg.length === 0) {
    // Escape internal double quotes
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

/** Maximum buffer size for stdout/stderr (10 MB) to prevent OOM on runaway output */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Spawns a CLI process and captures its output.
 * Resolves when the process exits; rejects only on spawn errors.
 *
 * On Windows, npm-installed CLIs (.cmd wrappers) require shell execution.
 * Arguments are properly escaped to prevent word-splitting.
 * Output buffers are capped at MAX_BUFFER_SIZE to prevent OOM.
 */
export function runCli(config: CliConfig, options: EngineRunOptions, onOutput?: OutputCallback): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const args = config.buildArgs(options);

    // Build a display-friendly command string. When the prompt is sent via stdin,
    // every CLI arg is real and should be shown.
    const displayArgs = config.useStdin
      ? args
      : args.length > 1 ? args.slice(0, -1) : args;
    const commandStr = [config.command, ...displayArgs].join(' ');

    // Emit command and response headers before spawning
    if (onOutput) {
      onOutput(`\u2500\u2500 Command \u2500\u2500\n${commandStr}\n\n\u2500\u2500 Response \u2500\u2500\n`, 'stdout');
    }

    // On Windows, npm-installed CLIs are .cmd wrappers that need shell execution.
    // We escape args to prevent shell word-splitting of prompt text.
    const isWin = process.platform === 'win32';
    const spawnArgs = isWin ? args.map(escapeWinArg) : args;

    const proc = spawn(config.command, spawnArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...config.env },
      stdio: [config.useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: isWin,
      // Lead a process group on POSIX. An engine CLI forks children, and a bare
      // SIGTERM reaches only the parent — the children keep the inherited pipes
      // open, so `close` never fires and an aborted run hangs until its timeout.
      // Windows needs no group: taskkill /T already walks the tree.
      detached: SPAWN_DETACHED,
    });

    // Pipe prompt via stdin if configured (avoids Windows command-line length limit)
    if (config.useStdin) {
      if (!proc.stdin) {
        // stdin pipe allocation failed — this is a crash path on Windows when shell:true
        // and the child process is not spawned correctly. Fail fast with a clear message.
        reject(new Error(
          `Failed to open stdin pipe for "${config.command}". ` +
          `Ensure the CLI is installed and accessible. On Windows, try reinstalling via npm.`
        ));
        return;
      }
      try {
        proc.stdin.write(options.prompt, 'utf-8');
        proc.stdin.end();
      } catch (stdinErr) {
        reject(new Error(`Failed to write prompt to "${config.command}" stdin: ${stdinErr instanceof Error ? stdinErr.message : String(stdinErr)}`));
        return;
      }
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (!stdoutTruncated) {
        if (stdout.length + text.length > MAX_BUFFER_SIZE) {
          stdout += text.slice(0, MAX_BUFFER_SIZE - stdout.length);
          stdoutTruncated = true;
        } else {
          stdout += text;
        }
      }
      onOutput?.(text, 'stdout');
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (!stderrTruncated) {
        if (stderr.length + text.length > MAX_BUFFER_SIZE) {
          stderr += text.slice(0, MAX_BUFFER_SIZE - stderr.length);
          stderrTruncated = true;
        } else {
          stderr += text;
        }
      }
      onOutput?.(text, 'stderr');
    });

    // Handle abort signal — kill the child process tree
    let abortHandler: (() => void) | null = null;
    if (options.signal) {
      abortHandler = () => {
        // The third copy of tree-kill in this codebase, and the last: a bare
        // SIGTERM here reached only the shell, so an aborted engine CLI left its
        // children holding the pipes and the run hung until its own timeout.
        killProcess(proc);
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    proc.on('error', (err) => {
      // Clean up abort listener to prevent leaks
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      reject(new Error(`Failed to start "${config.command}": ${err.message}`));
    });

    proc.on('close', (code) => {
      // Clean up abort listener to prevent leaks
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (stdoutTruncated) {
        stdout += '\n...[output truncated at 10MB]';
      }
      if (stderrTruncated) {
        stderr += '\n...[stderr truncated at 10MB]';
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        durationMs: Date.now() - startTime,
        command: commandStr,
      });
    });
  });
}
