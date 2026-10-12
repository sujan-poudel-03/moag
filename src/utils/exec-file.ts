// ─── Safe execFile wrapper ───
//
// Generalises the `gh.ts` pattern: every argument is a discrete array element and
// `shell` is forced to `false` AFTER the caller's options are spread, so no caller
// (and no request-derived value) can opt back into a shell. Used by the hosted
// server for git/clone operations whose inputs come from HTTP requests.

import { execFile, ChildProcess } from 'child_process';
import { killProcess } from './process-kill';

/** Default ceiling for a child process when the caller gives none (5 min). */
export const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
/** Default stdout/stderr buffer cap (10 MB, matching the adapters). */
export const DEFAULT_EXEC_MAX_BUFFER = 10 * 1024 * 1024;

export interface ExecFileAsyncOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

export interface ExecFileAsyncResult {
  /** Process exit code; `null` when it was killed (timeout/abort) rather than exiting. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run `command` with array `args` and no shell. Resolves for every exit —
 * including non-zero, timeout and abort — so callers branch on `exitCode`.
 * Rejects only when the process could not be run at all (e.g. ENOENT) or its
 * output overflowed `maxBuffer`. On timeout or abort the whole process tree is
 * killed via `killProcess`. The abort listener and timer are always removed.
 */
export function execFileAsync(
  command: string,
  args: string[],
  opts: ExecFileAsyncOptions = {},
): Promise<ExecFileAsyncResult> {
  const { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, signal, ...rest } = opts;
  if (signal?.aborted) {
    return Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false });
  }

  return new Promise<ExecFileAsyncResult>((resolve, reject) => {
    let timedOut = false;
    let killedByUs = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

    const onAbort = (): void => {
      killedByUs = true;
      if (child) { killProcess(child); }
    };

    const cleanup = (): void => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      signal?.removeEventListener('abort', onAbort);
    };

    // Arm the abort listener and timer BEFORE spawning so that a callback which
    // fires synchronously still finds something to clean up.
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killedByUs = true;
        if (child) { killProcess(child); }
      }, timeoutMs);
    }

    try {
      child = execFile(
        command,
        args,
        {
          maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
          ...rest,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          try {
            const out = String(stdout ?? '');
            const errOut = String(stderr ?? '');
            if (!err) {
              resolve({ exitCode: 0, stdout: out, stderr: errOut, timedOut });
              return;
            }
            const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
            if (typeof code === 'number') {
              resolve({ exitCode: code, stdout: out, stderr: errOut, timedOut });
              return;
            }
            if (killedByUs) {
              resolve({ exitCode: null, stdout: out, stderr: errOut, timedOut });
              return;
            }
            reject(err);
          } finally {
            cleanup();
          }
        },
      );
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
