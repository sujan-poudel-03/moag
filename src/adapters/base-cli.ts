// ─── Base CLI adapter — shared spawn logic for all CLI-based engines ───

import { spawn } from 'child_process';
import { killProcess, SPAWN_DETACHED } from '../utils/process-kill';
import { EngineResult } from '../models/types';
import { EngineRunOptions } from './engine';
import { trackChildProcess } from '../utils/child-tracker';

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
 * How long an aborted {@link runCli} waits for `close` after the tree kill. An orphan
 * that survives the kill and still holds the stdout pipe keeps `close` from ever
 * firing; past this grace the run gives up on it so the stop path can finish.
 */
export const ABORT_CLOSE_GRACE_MS = 5_000;

// ─── Spawn shape shared by runs and the --version probe ───

/** How an engine CLI is spawned: the arguments as passed to `spawn`, and whether a shell resolves the command. */
export interface EngineSpawnShape {
  args: string[];
  shell: boolean;
}

/**
 * The one place that decides how an engine CLI is spawned on `platform`.
 *
 * On Windows the command goes through cmd.exe, which resolves it by PATH order and PATHEXT
 * (so an npm `claude.cmd` shim earlier on PATH wins over a `claude.exe` later on it); a
 * shell-less spawn only ever finds `.exe`/`.com` files and can start a different binary.
 * Elsewhere the command is spawned directly. {@link runCli} and {@link probeVersion} both
 * use this, so the version an availability check reports is the version a run starts.
 */
export function engineSpawnShape(args: string[], platform: NodeJS.Platform = process.platform): EngineSpawnShape {
  const isWin = platform === 'win32';
  return { args: isWin ? args.map(escapeWinArg) : args, shell: isWin };
}

/**
 * True when `command` can be placed on a shell line verbatim: letters, digits and the path
 * characters `_ . - \ / :` only. No whitespace, quotes, `%`, `^`, `&`, `|`, `<`, `>`, `(`, `)`
 * or `!`, so cmd.exe can neither split it nor expand or chain anything from it.
 */
export function isShellSafeCommand(command: string): boolean {
  return /^[A-Za-z0-9_.\-\\/:]{1,260}$/.test(command);
}

/** Bound on a `--version` probe. */
export const PROBE_TIMEOUT_MS = 5000;
/** Most output a probe keeps; only its first line is used. */
const MAX_PROBE_OUTPUT = 64 * 1024;

/**
 * Run `<command> --version` exactly as a run would spawn the command ({@link engineSpawnShape}),
 * and return the first line of its output, or null when it cannot be started, exits non-zero
 * or does not finish within `timeoutMs` (its process tree is then killed).
 *
 * Where the spawn goes through a shell (Windows), a command that is not
 * {@link isShellSafeCommand} is never put on a shell line: the probe returns null. The only
 * argument is the fixed `--version`. Never rejects.
 */
export function probeVersion(command: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const shape = engineSpawnShape(['--version']);
    if (!command || (shape.shell && !isShellSafeCommand(command))) {
      resolve(null);
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: string | null): void => {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); }
      resolve(value);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, shape.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: shape.shell,
        detached: SPAWN_DETACHED,
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    trackChildProcess(proc);
    timer = setTimeout(() => {
      killProcess(proc);
      finish(null);
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < MAX_PROBE_OUTPUT) { stdout += chunk.toString(); } });
    proc.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < MAX_PROBE_OUTPUT) { stderr += chunk.toString(); } });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => {
      if (code !== 0) {
        // Some CLIs only respond to --help; a failed --version reports no version.
        finish(null);
        return;
      }
      const output = (stdout.trim() || stderr.trim());
      finish(output.split(/\r?\n/)[0]?.trim() || null);
    });
  });
}

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

    // Already aborted (a stop that landed before this call): never spawn. An
    // 'abort' listener added to an aborted signal never fires, so a process
    // spawned now would run unsupervised until it ended on its own.
    if (options.signal?.aborted) {
      resolve({ stdout: '', stderr: '[Command aborted]', exitCode: 130, durationMs: 0, command: commandStr });
      return;
    }

    // Emit command and response headers before spawning
    if (onOutput) {
      onOutput(`\u2500\u2500 Command \u2500\u2500\n${commandStr}\n\n\u2500\u2500 Response \u2500\u2500\n`, 'stdout');
    }

    // On Windows, npm-installed CLIs are .cmd wrappers that need shell execution.
    // We escape args to prevent shell word-splitting of prompt text. The probe
    // (probeVersion) uses the same shape, so it checks the binary this starts.
    const shape = engineSpawnShape(args);

    const proc = spawn(config.command, shape.args, {
      cwd: options.cwd,
      env: { ...process.env, ...config.env },
      stdio: [config.useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: shape.shell,
      // Lead a process group on POSIX. An engine CLI forks children, and a bare
      // SIGTERM reaches only the parent — the children keep the inherited pipes
      // open, so `close` never fires and an aborted run hangs until its timeout.
      // Windows needs no group: taskkill /T already walks the tree.
      detached: SPAWN_DETACHED,
      // A detached server worker has no console; without this every engine
      // spawn on Windows flashes a console window.
      windowsHide: true,
    });
    trackChildProcess(proc);

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

    // `close`, `error` and the abort grace timer each end the run; only the first counts.
    let abortHandler: (() => void) | null = null;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    const settle = (): boolean => {
      if (settled) { return false; }
      settled = true;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      // Clean up abort listener to prevent leaks
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      return true;
    };
    const appendTruncationNotes = (): void => {
      if (stdoutTruncated) {
        stdout += '\n...[output truncated at 10MB]';
      }
      if (stderrTruncated) {
        stderr += '\n...[stderr truncated at 10MB]';
      }
    };

    // Handle abort signal — kill the child process tree
    if (options.signal) {
      abortHandler = () => {
        // The third copy of tree-kill in this codebase, and the last: a bare
        // SIGTERM here reached only the shell, so an aborted engine CLI left its
        // children holding the pipes and the run hung until its own timeout.
        killProcess(proc);
        // An orphan that survived the kill can still hold the stdout pipe, so
        // `close` may never fire. Give up on it after a grace period so the stop
        // path still reaches its snapshot save.
        if (settled || graceTimer) { return; }
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (!settle()) { return; }
          try { proc.stdout?.destroy(); } catch { /* already gone */ }
          try { proc.stderr?.destroy(); } catch { /* already gone */ }
          try { proc.stdin?.destroy(); } catch { /* already gone */ }
          appendTruncationNotes();
          resolve({
            stdout,
            stderr: stderr + (stderr ? '\n' : '') + '[Command aborted]',
            exitCode: 130,
            durationMs: Date.now() - startTime,
            command: commandStr,
          });
        }, ABORT_CLOSE_GRACE_MS);
        graceTimer.unref?.();
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    proc.on('error', (err) => {
      if (!settle()) { return; }
      reject(new Error(`Failed to start "${config.command}": ${err.message}`));
    });

    proc.on('close', (code) => {
      if (!settle()) { return; }
      appendTruncationNotes();
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
