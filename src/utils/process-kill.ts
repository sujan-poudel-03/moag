// ─── Cross-platform child-process tree kill ───

import { execSync, ChildProcess } from 'child_process';

/**
 * True on every platform where a process group can be signalled — i.e. not Windows.
 *
 * Callers that spawn something expected to start children of its own (a dev
 * server, anything under `shell: true`) should pass this as `detached`, which
 * makes the child a process-group leader and gives {@link killProcess} a group
 * to signal. On Windows `detached` means a new console instead, which is why it
 * must stay false there — `taskkill /T` walks the tree without it.
 */
export const SPAWN_DETACHED = process.platform !== 'win32';

/**
 * Kill a child process and its whole tree.
 *
 * When a process is spawned with `shell: true` the pid belongs to the shell, not
 * to the command it launched — so a plain SIGTERM kills the shell and ORPHANS the
 * real process, which keeps holding its port. That is how a stopped dev server can
 * survive, and how a browser UAT gate can pass green against yesterday's code.
 *
 * Both halves of that have to be handled, and for a long time only one was:
 * `/T` on Windows walks the tree, while POSIX got a bare SIGTERM that reached the
 * shell alone. On POSIX the equivalent is signalling the process GROUP, which is
 * what `process.kill(-pid)` does — and which only works if the child was spawned
 * detached, so that it leads a group of its own.
 *
 * Signalling `-pid` is safe even when the child is not a group leader: no group
 * carries that id, so the call throws ESRCH and falls through to the direct kill
 * below. It cannot reach this process's own group, whose id is our pid, not the
 * child's.
 *
 * Lives in `utils/` rather than beside either caller: both `runner/` and
 * `sandbox/` need it, and routing one through the other would create a
 * cross-layer import for what is really an OS helper.
 */
export function killProcess(proc: ChildProcess): void {
  if (proc.killed) {
    return;
  }

  if (process.platform === 'win32') {
    if (proc.pid) {
      try {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // ignore — the process may already be gone
      }
    }
    return;
  }

  // POSIX: the group first, so anything the child started goes with it.
  if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
      return;
    } catch {
      // No such group — the child was not spawned detached. Fall through.
    }
  }

  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }
}
