// ─── Cross-platform child-process tree kill ───

import { execSync, ChildProcess } from 'child_process';

/**
 * Kill a child process and its whole tree.
 *
 * When a process is spawned with `shell: true` the pid belongs to the shell, not
 * to the command it launched — so a plain SIGTERM kills the shell and ORPHANS the
 * real process, which keeps holding its port. That is how a stopped dev server can
 * survive, and how a browser UAT gate can pass green against yesterday's code.
 * `/T` on Windows is what makes the kill reach the whole tree.
 *
 * Lives in `utils/` rather than beside either caller: both `runner/` and
 * `sandbox/` need it, and routing one through the other would create a
 * cross-layer import for what is really an OS helper.
 */
export function killProcess(proc: ChildProcess): void {
  if (proc.killed) {
    return;
  }
  if (process.platform === 'win32' && proc.pid) {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // ignore — the process may already be gone
    }
    return;
  }
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }
}
