/**
 * Relays runs played inside a long-lived host (the VS Code extension) to ONOSOO Builds:
 * one OnosooRelay per run, driven only by the runner's own events. A new run is a
 * state-changed from idle to playing; paused → playing is a resume; idle ends the run.
 *
 * Free of any `vscode` import (asserted by src/test/unit/server/no-vscode.test.ts); the
 * VS Code glue — setting, status bar, notices — lives in src/ui/onosoo-relay-host.ts.
 * Nothing here awaits on the event path: a relay's close is fire-and-forget.
 */

import {
  RunLine, startRunRelay, subscribeRunCostLines, tallyPlan, wireRunEventLines,
} from './run-reporter';
import { reportingSecretValues, ReportingRunner, wireTaskReporting } from './task-reporting';
import { resolveOnosooConfig } from './onosoo-config';
import { OnosooRelay, RelayHttpClient, REVOKED_MESSAGE } from './onosoo-relay';
import { createRedactor, Redactor } from '../utils/redact';
import { Plan, RunnerState } from '../models/types';
import type { TaskRunner } from '../runner/runner';
import type { collectTaskChanges } from '../runner/task-changes';

// ─── Types and constants ───

/** The slice of a TaskRunner the controller uses. */
export type HostRelayRunner = Pick<TaskRunner, 'on' | 'off' | 'state' | 'currentPlan' | 'currentRunTaskIds' | 'setTaskSettledHook'>;

/** What the status bar shows: no key, relaying switched off, relaying, or the key was refused. */
export type RelayStatus = 'none' | 'off' | 'on' | 'revoked';

/** The manual-gate note of a host run, which waits at the gate for a click. */
export const HOST_MANUAL_GATE_NOTE = 'Waiting for human approval in VS Code.';

/** Cost-ledger labels that belong to a run (runner.ts records task calls as 'task'). */
export const HOST_COST_LABELS: ReadonlySet<string> = new Set(['task']);

/**
 * The run-finished code of a host run: 4 when a budget breach stopped it, 1 when a task
 * failed or the run was stopped, else 0. A host never reports 3 (it waits at a gate).
 */
export function hostRunFinishedCode(f: { budgetStopped: boolean; failed: number; stopped: boolean }): number {
  if (f.budgetStopped) { return 4; }
  return f.failed > 0 || f.stopped ? 1 : 0;
}

/** The status before any run: 'none' without a workspace or a resolvable key, else on/off by the setting. */
export function probeRelayStatus(env: NodeJS.ProcessEnv, cwd: string | null, enabled: boolean, log: (line: string) => void): RelayStatus {
  if (!cwd) { return 'none'; }
  const cfg = resolveOnosooConfig({ env, cwd, stderr: (s: string) => log(s.replace(/\n$/, '')) });
  if (!cfg) { return 'none'; }
  return enabled ? 'on' : 'off';
}

/** What the controller reads, each at the start of a run. */
export interface HostRunRelayDeps {
  runner: HostRelayRunner;
  cwd(): string | null;
  env(): NodeJS.ProcessEnv;
  enabled(): boolean;
  planPath(): string | null;
  fullAuto(): boolean;
  log(line: string): void;
  onStatus?(s: RelayStatus): void;
  onRunRelayed?(plan: Plan): void;
  http?: RelayHttpClient;
  isPidAlive?: (pid: number) => boolean;
  closeDeadlineMs?: number;
  collect?: typeof collectTaskChanges;
}

/** A live controller. */
export interface HostRunRelay {
  dispose(): void;
  readonly status: RelayStatus;
  /** True while a run is being relayed. */
  readonly live: boolean;
}

// ─── Controller ───

/** The plan restricted to the run's tasks (playTask / playTasks), in plan order; the plan itself when unscoped. */
function scopePlan(plan: Plan, ids: readonly string[] | null): Plan {
  if (!ids) { return plan; }
  const keep = new Set(ids);
  return { ...plan, playlists: plan.playlists.map((pl) => ({ ...pl, tasks: pl.tasks.filter((t) => keep.has(t.id)) })) };
}

/**
 * Relay every run `d.runner` plays. The line listeners are permanent; with no relayed run
 * live every line is dropped, so nothing is read, spooled or sent between runs.
 */
export function createHostRunRelay(d: HostRunRelayDeps): HostRunRelay {
  let status: RelayStatus = 'none';
  let lastState = String(d.runner.state ?? RunnerState.Idle);
  let inRun = false;
  let relay: OnosooRelay | null = null;
  let scoped: Plan | null = null;
  let stopped = false;
  let budgetSeen = false;
  let budgetStopped = false;
  let offCost: (() => void) | null = null;
  let unwireReporting: (() => void) | null = null;

  const setStatus = (s: RelayStatus): void => {
    status = s;
    try { d.onStatus?.(s); } catch { /* the status bar never disturbs a run */ }
  };

  /** Record one line on the live relay, stamped as the CLI's emit stamps it. */
  const rec = (obj: RunLine): void => {
    if (!relay) { return; }
    try { relay.record({ ts: new Date().toISOString(), ...obj }); } catch { /* the relay never disturbs the run */ }
  };

  const beginRun = (): void => {
    stopped = false;
    budgetSeen = false;
    budgetStopped = false;
    inRun = true;
    relay = null;
    scoped = null;
    if (!d.enabled()) { setStatus('off'); return; }
    const cwd = d.cwd();
    if (!cwd) { setStatus('none'); return; }
    const plan = d.runner.currentPlan;
    if (!plan) { return; }
    const runPlan = scopePlan(plan, d.runner.currentRunTaskIds);
    const env = d.env();
    const buildRedactor = (extra: string[]): Redactor => createRedactor(reportingSecretValues(cwd, env, extra));
    const redactorExtra: string[] = [];
    const started = startRunRelay({
      cwd,
      plan: runPlan,
      env,
      buildRedactor,
      stderr: (s: string): void => {
        d.log(s.replace(/\n$/, ''));
        if (s.startsWith(REVOKED_MESSAGE)) { setStatus('revoked'); }
      },
      http: d.http,
      isPidAlive: d.isPidAlive,
      closeDeadlineMs: d.closeDeadlineMs,
    });
    if (!started) { setStatus('none'); return; }

    relay = started.relay;
    scoped = runPlan;
    // The device key is a secret of its own: it never appears in a reported diff or tail.
    redactorExtra.push(started.key);
    // Registered after the line mapper, so task-changes / task-error-tail follow the task's own line.
    unwireReporting = wireTaskReporting(d.runner as unknown as ReportingRunner, {
      cwd,
      emit: rec,
      makeRedactor: () => buildRedactor(redactorExtra),
      collect: d.collect,
    });
    offCost = subscribeRunCostLines(rec, (l) => HOST_COST_LABELS.has(l));
    rec({
      event: 'run-started', plan: runPlan.name, planPath: d.planPath() ?? '<inline prompt>', fullAuto: d.fullAuto(),
      engine: runPlan.defaultEngine, branch: null,
    });
    setStatus('on');
    try { d.onRunRelayed?.(runPlan); } catch { /* a notice never disturbs a run */ }
  };

  const finishRun = (): void => {
    if (relay && scoped) {
      try { offCost?.(); } catch { /* ignore */ }
      const t = tallyPlan(scoped);
      rec({ event: 'run-finished', ...t, manualGateHit: false, code: hostRunFinishedCode({ budgetStopped, failed: t.failed, stopped }) });
      try { unwireReporting?.(); } catch { /* ignore */ }
      const r = relay;
      relay = null;
      void r.close().catch(() => undefined);
    }
    relay = null;
    scoped = null;
    offCost = null;
    unwireReporting = null;
    inRun = false;
  };

  const onLine = (obj: RunLine): void => {
    try {
      if (obj.event === 'state') {
        const s = String(obj.state);
        const prev = lastState;
        lastState = s;
        if (s === RunnerState.Playing && prev === RunnerState.Idle) {
          beginRun();
          rec(obj);
          return;
        }
        if (s === RunnerState.Idle) {
          // A second idle (the stop watchdog forcing one) is a no-op.
          if (inRun) {
            rec(obj);
            finishRun();
          }
          return;
        }
        if (s === RunnerState.Stopping && inRun) {
          stopped = true;
          if (budgetSeen) { budgetStopped = true; }
        }
        rec(obj);
        return;
      }
      if (obj.event === 'budget-exceeded') { budgetSeen = true; }
      rec(obj);
    } catch { /* the relay never disturbs the run */ }
  };

  const unwireLines = wireRunEventLines(d.runner, onLine, { manualGateNote: HOST_MANUAL_GATE_NOTE });

  return {
    dispose(): void {
      try {
        if (inRun) {
          stopped = true;
          finishRun();
        }
      } finally {
        unwireLines();
      }
    },
    get status(): RelayStatus { return status; },
    get live(): boolean { return relay !== null; },
  };
}
