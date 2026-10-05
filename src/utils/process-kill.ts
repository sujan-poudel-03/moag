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

/**
 * Kill every process this one started (children, grandchildren, and their
 * process groups) — the last-resort cleanup for a worker that must exit while
 * a task it supervises is still running.
 *
 * Windows: `taskkill /T` on our own pid walks the whole tree and takes THIS
 * process with it; the caller should still call `process.exit` in case it
 * survives. POSIX: descendants are found from `ps` by parent pid; each gets
 * SIGKILL to its group (engine CLIs and commands lead their own, see
 * {@link SPAWN_DETACHED}) and to itself. Never throws.
 */
export function killOwnProcessTree(
  rootPid: number = process.pid,
  run: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }),
  platform: NodeJS.Platform = process.platform,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal); },
): void {
  if (platform === 'win32') {
    try { run(`taskkill /pid ${rootPid} /T /F`); } catch { /* already gone, or nothing to kill */ }
    return;
  }
  let table: string;
  try { table = run('ps -A -o pid= -o ppid='); } catch { return; }
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) { continue; }
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const descendants: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (pid === rootPid || descendants.includes(pid)) { continue; }
    descendants.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  for (const pid of descendants) {
    try { kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
