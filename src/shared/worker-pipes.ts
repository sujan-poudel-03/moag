// ─── Worker process survival (shared) ───
//
// A process that supervises an agent for a parent (the hosted server's run
// worker, the ONOSOO remote child) must outlive the parent's pipes long enough
// to stop its task tree, and must not outlive it forever. Both halves live here
// because the remote child ships in the extension and the server does not;
// `server/run-worker.ts` re-exports them.

/**
 * Swallow write errors on the worker's pipes. When the parent dies, the next
 * write gets EPIPE; unhandled, that error event crashes the worker and orphans
 * the agent it was supervising (still running, with no timeout and uncounted
 * spend). With this the worker survives, its disconnect handler stops the
 * runner, and it exits only once play() has settled and killed the task tree.
 */
export function guardParentPipes(...streams: Array<{ on(event: 'error', fn: (err: Error) => void): unknown } | null | undefined>): void {
  for (const s of streams) { s?.on('error', () => { /* EPIPE after the parent died */ }); }
}

// ─── Post-disconnect watchdog ───

/** How long a worker whose parent died may take to settle before it kills its own tree and exits. */
export const DISCONNECT_WATCHDOG_MS = 30_000;

export interface DisconnectWatchdogOptions {
  /** Kill every descendant of this process (`killOwnProcessTree`). */
  killTree(): void;
  exit(code: number): void;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/**
 * Arm the last-resort exit for a worker whose parent is gone. The disconnect
 * handler already stopped the runner; normally `play()` settles and the worker
 * exits well inside the grace period. If it has not — a task that escaped its
 * abort, a hung promise — nobody is left to stop it, and while the worker lives
 * the project's job lock stays held. So after `graceMs` the worker kills its own
 * process tree and exits 2, unconditionally. Never throws.
 */
export function armDisconnectWatchdog(opts: DisconnectWatchdogOptions): void {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  setTimer(() => {
    try { opts.killTree(); } catch { /* exit regardless */ }
    opts.exit(2);
  }, opts.graceMs ?? DISCONNECT_WATCHDOG_MS);
}
