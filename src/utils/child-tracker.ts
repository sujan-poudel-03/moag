// ─── Child-process tracker ───
//
// A process-wide hook that reports when a task's child process (an engine CLI,
// a shell command, a gate command) starts and ends. The hosted server's run
// worker subscribes and forwards each change to the server, which records the
// live pids in the project's `job.lock` as `taskPids`. If the worker dies while
// an agent it started is still running, a restarted server sees that pid alive
// and keeps the workspace locked instead of admitting a second run into it.
//
// With no subscriber (the VS Code extension, the headless CLI) tracking is a
// no-op: no listener is attached to the child. Never throws.

/** One change in a tracked child's life. */
export interface ChildProcessChange {
  pid: number;
  alive: boolean;
}

export type ChildProcessListener = (change: ChildProcessChange) => void;

/** The slice of a ChildProcess the tracker needs. */
export interface TrackableChild {
  pid?: number;
  once(event: 'exit', fn: () => void): unknown;
  once(event: 'error', fn: () => void): unknown;
  removeListener(event: 'exit' | 'error', fn: () => void): unknown;
}

const listeners = new Set<ChildProcessListener>();

function notify(change: ChildProcessChange): void {
  for (const l of [...listeners]) {
    try { l(change); } catch { /* a listener's failure must never break a spawn site */ }
  }
}

/**
 * Subscribe to child-process starts and ends. Returns a disposer that removes
 * the listener.
 */
export function onChildProcess(listener: ChildProcessListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Report a freshly spawned child: `alive: true` now, `alive: false` once it
 * exits or fails. Both lifecycle listeners are removed when either fires.
 * A child without a pid (spawn failed synchronously) is not reported.
 */
export function trackChildProcess(child: TrackableChild): void {
  if (listeners.size === 0) { return; }
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) { return; }
  let ended = false;
  const end = (): void => {
    if (ended) { return; }
    ended = true;
    try {
      child.removeListener('exit', end);
      child.removeListener('error', end);
    } catch { /* best effort */ }
    notify({ pid, alive: false });
  };
  try {
    child.once('exit', end);
    child.once('error', end);
  } catch { return; }
  notify({ pid, alive: true });
}
