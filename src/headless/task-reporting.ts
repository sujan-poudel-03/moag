// ─── Headless task reporting: task-changes and task-error-tail ───
//
// Wires a runner so `moag run` reports, after each task's existing
// task-completed / task-failed line:
//
//   - `task-changes`    — what the task changed (runner/task-changes.ts), for
//                         tasks that reached task-started and settled
//                         Completed or Failed;
//   - `task-error-tail` — the redacted last 2000 characters of a failed task's
//                         output, mirroring the hosted run worker's line.
//
// The runner's task-settled hook only COLLECTS (it runs before the runner's
// own emit); the lines are written from the task-completed / task-failed
// listeners registered after wireEvents(), so they follow the existing line.
//
// Imports nothing that loads `vscode`.

import { collectTaskChanges, TaskChangesPayload, TaskSettledInfo } from '../runner/task-changes';
import { KEYED_ENGINE_ENV } from '../server/secrets';
import { readEnvFileSecrets, Redactor } from '../utils/redact';

/** Characters of output a `task-error-tail` line carries, as in the run worker. */
export const ERROR_TAIL_CHARS = 2000;

/** A task-completed / task-failed listener as this module registers it. */
export type ReportingListener = (task: { id: string }, result?: { stderr?: string; stdout?: string }) => void;

/** The slice of a TaskRunner this module uses; fakes in tests may lack the optional parts. */
export interface ReportingRunner {
  on(event: 'task-completed' | 'task-failed', fn: ReportingListener): unknown;
  off?(event: 'task-completed' | 'task-failed', fn: ReportingListener): unknown;
  setTaskSettledHook?(fn: ((info: TaskSettledInfo, signal: AbortSignal) => Promise<void>) | null): void;
}

export interface TaskReportingOptions {
  cwd: string;
  /** Writes one JSONL line (the CLI's emit). */
  emit: (line: Record<string, unknown>) => void;
  /** Builds a fresh redactor; called per task so .env edits during a run are picked up. */
  makeRedactor: () => Redactor;
  /** Injected in tests. */
  collect?: typeof collectTaskChanges;
}

/**
 * Exact secret values every reporting redactor knows: the workspace's .env /
 * .env.local secrets, the engine API keys present in `env`, and `extra` (the
 * relay's device key when one is configured).
 */
export function reportingSecretValues(cwd: string, env: NodeJS.ProcessEnv, extra: readonly string[] = []): string[] {
  const out = [...readEnvFileSecrets(cwd)];
  for (const name of Object.values(KEYED_ENGINE_ENV)) {
    const v = name ? env[name] : undefined;
    if (typeof v === 'string' && v.length > 0) { out.push(v); }
  }
  out.push(...extra);
  return out;
}

/** A redactor that always fails — collect then reports diff null + diff_error. */
const FAILING_REDACTOR: Redactor = {
  redact(): never { throw new Error('redactor unavailable'); },
};

/**
 * Wire task-changes / task-error-tail reporting onto `runner`. Call AFTER
 * wireEvents() so each line follows the existing task line. Returns an unwire
 * function that clears the hook and removes both listeners.
 */
export function wireTaskReporting(runner: ReportingRunner, opts: TaskReportingOptions): () => void {
  const collect = opts.collect ?? collectTaskChanges;
  const pending = new Map<string, TaskChangesPayload>();

  const hook = async (info: TaskSettledInfo, signal: AbortSignal): Promise<void> => {
    const status = String(info.status);
    if (status !== 'completed' && status !== 'failed') { return; }
    let redactor: Redactor;
    try {
      redactor = opts.makeRedactor();
    } catch {
      redactor = FAILING_REDACTOR;
    }
    const payload = await collect(info, redactor, signal);
    if (payload && !signal.aborted) { pending.set(info.taskId, payload); }
  };

  const emitPending = (taskId: string): void => {
    const payload = pending.get(taskId);
    if (!payload) { return; }
    pending.delete(taskId);
    opts.emit({ event: 'task-changes', ...payload });
  };

  const onCompleted = (t: { id: string }): void => {
    emitPending(t.id);
  };

  const onFailed = (t: { id: string }, result?: { stderr?: string; stdout?: string }): void => {
    emitPending(t.id);
    const raw = String(result?.stderr || result?.stdout || '');
    if (!raw) { return; }
    let tail: string;
    try {
      // Redact the whole text first: a slice could cut a secret in half and hide it from the patterns.
      tail = opts.makeRedactor().redact(raw).text.slice(-ERROR_TAIL_CHARS);
    } catch {
      return;
    }
    if (tail) { opts.emit({ event: 'task-error-tail', id: t.id, tail }); }
  };

  runner.setTaskSettledHook?.(hook);
  runner.on('task-completed', onCompleted);
  runner.on('task-failed', onFailed);

  return (): void => {
    runner.setTaskSettledHook?.(null);
    runner.off?.('task-completed', onCompleted);
    runner.off?.('task-failed', onFailed);
    pending.clear();
  };
}
