/**
 * Relays runs played inside a long-lived host (the VS Code extension) to ONOSOO Builds:
 * one OnosooRelay per run, driven only by the runner's own events. A new run is a
 * state-changed from idle to playing; paused → playing is a resume; idle ends the run.
 *
 * Free of any `vscode` import (asserted by src/test/unit/server/no-vscode.test.ts); the
 * VS Code glue — setting, status bar, notices — lives in src/ui/onosoo-relay-host.ts.
 * Nothing here awaits on the event path: a relay's close is fire-and-forget.
 *
 * Project identity (protocol v1.2): run-meta (seq 1) carries the folder's project key. A key
 * the identity cache already holds is used at once; otherwise the relay is built but not
 * started, the run's lines are buffered, and the relay starts when the key resolves or after
 * `identityWaitMs` (no key) — run-meta first, then the buffered lines in order. A run that
 * ends (or a dispose) while waiting starts the relay at once with whatever the cache holds.
 */

import {
  prepareRunRelay, RunLine, subscribeRunCostLines, tallyPlan, wireRunEventLines,
} from './run-reporter';
import { IDENTITY_WAIT_MS } from './project-identity';
import type { ProjectIdentity, ProjectIdentityCache } from './project-identity';
import { reportingSecretValues, ReportingRunner, wireTaskReporting } from './task-reporting';
import { resolveOnosooConfig } from './onosoo-config';
import { OnosooRelay, RelayHttpClient, REVOKED_MESSAGE } from './onosoo-relay';
import { OnosooSpool } from './onosoo-spool';
import { hostSecret } from '../core/host';
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

/** How long after a run ends its PR may still be reported on the same run. */
export const PR_FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Most lines buffered while a run waits for its project identity; later ones are dropped. */
export const PENDING_LINES_MAX = 1000;

/**
 * The run-finished code of a host run: 4 when a budget breach stopped it, 1 when a task
 * failed or the run was stopped, else 0. A host never reports 3: ONOSOO reads 3 as
 * "awaiting approval" and offers Approve / Skip, which a run waiting at a gate in VS Code
 * cannot act on. The manual-gate event carries the gate and HOST_MANUAL_GATE_NOTE instead.
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
  /** The project identity cache (protocol v1.2). Absent: run-meta carries no key. */
  identity?: Pick<ProjectIdentityCache, 'peek' | 'warm' | 'within'>;
  /** How long a run waits for an uncached identity (default IDENTITY_WAIT_MS). */
  identityWaitMs?: number;
}

/** A live controller. */
export interface HostRunRelay {
  dispose(): void;
  readonly status: RelayStatus;
  /** True while a run is being relayed. */
  readonly live: boolean;
  /**
   * Report a pull request opened after a relayed run, on that run (same ONOSOO run id, the
   * next seq). Sent only when the most recent run this host played was relayed, has ended,
   * and ended less than 24 h ago: any later run (relayed or not, playTask included) means
   * the PR may be that run's work, so nothing is sent. Calls are serialised. Never rejects.
   */
  notePrCreated(url: string): Promise<void>;
}

/** The last relayed run, kept so a follow-up event can continue it. */
interface LastRun {
  relayRunId: string;
  /** Which run start (counted over every run this host played) it was. */
  runNumber: number;
  lastSeq: number;
  cwd: string;
  endedAt: number;
  /** The run's own relay closing; a follow-up starts only after it settles. */
  closing: Promise<void>;
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
  let runCwd: string | null = null;
  /** Every run start, relayed or not. The PR follow-up keys off it, never off runner ids. */
  let runsStarted = 0;
  let last: LastRun | null = null;
  let prChain: Promise<void> = Promise.resolve();
  /** A run whose relay waits for its project identity: its lines are buffered until then. */
  let pending: { token: number; begin: (identity?: ProjectIdentity | null) => boolean; lines: RunLine[] } | null = null;
  /** The Anthropic key from the host's secret store, an exact-value secret for the redactor. */
  let storedAnthropicKey: string | undefined;
  const refreshStoredSecret = (): void => {
    void hostSecret('anthropicApiKey').then((v) => { storedAnthropicKey = v; }, () => undefined);
  };
  refreshStoredSecret();

  const setStatus = (s: RelayStatus): void => {
    status = s;
    try { d.onStatus?.(s); } catch { /* the status bar never disturbs a run */ }
  };

  /** Record one line on the live relay, stamped as the CLI's emit stamps it. */
  const rec = (obj: RunLine): void => {
    if (!relay) { return; }
    if (pending) {
      if (pending.lines.length < PENDING_LINES_MAX) { pending.lines.push({ ts: new Date().toISOString(), ...obj }); }
      return;
    }
    try { relay.record({ ts: new Date().toISOString(), ...obj }); } catch { /* the relay never disturbs the run */ }
  };

  /** The cached identity of `cwd`: undefined when never resolved (or no cache). Never throws. */
  const peekIdentity = (cwd: string | null): ProjectIdentity | null | undefined => {
    if (!cwd || !d.identity) { return undefined; }
    try { return d.identity.peek(cwd); } catch { return undefined; }
  };

  /** Stop relaying the current run without a run-finished (its relay never started). */
  const detachRun = (): void => {
    try { offCost?.(); } catch { /* ignore */ }
    try { unwireReporting?.(); } catch { /* ignore */ }
    offCost = null;
    unwireReporting = null;
    relay = null;
    scoped = null;
  };

  /**
   * Start a waiting run's relay with `identity` (run-meta, seq 1), then record its buffered
   * lines in order. Ignored unless `token` is the waiting run's: a late lookup never touches a
   * later run.
   */
  const settle = (token: number, identity: ProjectIdentity | null): void => {
    const p = pending;
    if (!p || p.token !== token) { return; }
    pending = null;
    let begun = false;
    try { begun = p.begin(identity); } catch { /* begin never throws; belt and braces */ }
    if (!begun) {
      detachRun();
      setStatus('none');
      return;
    }
    const r = relay;
    if (!r) { return; }
    for (const line of p.lines) {
      try { r.record(line); } catch { /* the relay never disturbs the run */ }
    }
  };

  const beginRun = (): void => {
    stopped = false;
    budgetSeen = false;
    budgetStopped = false;
    inRun = true;
    relay = null;
    scoped = null;
    runsStarted++;
    pending = null;
    refreshStoredSecret();
    const cwd = d.cwd();
    runCwd = cwd;
    if (!cwd) { setStatus('none'); return; }
    // The key first: with no key the status is 'none' whatever the setting says. Switched off,
    // the relay's own config messages are not repeated on every run.
    if (!d.enabled()) { setStatus(probeRelayStatus(d.env(), cwd, false, () => undefined)); return; }
    const plan = d.runner.currentPlan;
    if (!plan) { return; }
    const runPlan = scopePlan(plan, d.runner.currentRunTaskIds);
    const env = d.env();
    const buildRedactor = (extra: string[]): Redactor =>
      createRedactor(reportingSecretValues(cwd, env, storedAnthropicKey ? [...extra, storedAnthropicKey] : extra));
    const redactorExtra: string[] = [];
    const started = prepareRunRelay({
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

    // The identity decides when run-meta goes out; decided before any line of this run is recorded.
    const token = runsStarted;
    let waitFor = false;
    if (!d.identity) {
      if (!started.begin(null)) { setStatus('none'); return; }
    } else {
      const known = peekIdentity(cwd);
      if (known !== undefined) {
        if (!started.begin(known)) { setStatus('none'); return; }
        try { void d.identity.warm(cwd).catch(() => undefined); } catch { /* a refresh never disturbs a run */ }
      } else {
        waitFor = true;
        pending = { token, begin: started.begin, lines: [] };
      }
    }

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
    if (waitFor && d.identity) {
      try {
        d.identity.within(cwd, d.identityWaitMs ?? IDENTITY_WAIT_MS)
          .then((id) => settle(token, id ?? null), () => settle(token, null));
      } catch {
        settle(token, null);
      }
    }
  };

  const finishRun = (): void => {
    // Still waiting for the identity: start the relay now with whatever the cache holds.
    if (pending) { settle(pending.token, peekIdentity(runCwd) ?? null); }
    if (relay && scoped) {
      try { offCost?.(); } catch { /* ignore */ }
      const t = tallyPlan(scoped);
      rec({ event: 'run-finished', ...t, manualGateHit: false, code: hostRunFinishedCode({ budgetStopped, failed: t.failed, stopped }) });
      try { unwireReporting?.(); } catch { /* ignore */ }
      const r = relay;
      relay = null;
      const closing = r.close().catch(() => undefined);
      last = { relayRunId: r.runId, runNumber: runsStarted, lastSeq: r.lastSeq, cwd: runCwd ?? '', endedAt: Date.now(), closing };
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
        // A resume (Continue after a budget pause, say): a later Stop is the user's, not the budget's.
        if (s === RunnerState.Playing && prev === RunnerState.Paused) { budgetSeen = false; }
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

  /** One follow-up: a short-lived relay on the last run's id that sends `pr-created`. */
  const sendPrCreated = async (url: string): Promise<void> => {
    const prev = last;
    // Only the most recent run, and only once it has ended: a later run may own this PR.
    if (!prev || !d.enabled() || inRun || prev.runNumber !== runsStarted) { return; }
    if (Date.now() - prev.endedAt > PR_FOLLOW_UP_WINDOW_MS) { return; }
    // The run's own close drops its spool file once acked; a relay opened before that
    // settles would see its new events deleted (and two relays would share one run id).
    await prev.closing;
    const env = d.env();
    const cfg = resolveOnosooConfig({ env, cwd: prev.cwd, stderr: (s: string) => d.log(s.replace(/\n$/, '')) });
    if (!cfg) { return; }
    const follow = new OnosooRelay({
      config: cfg,
      spool: new OnosooSpool(cfg.stateDir, prev.cwd, { isPidAlive: d.isPidAlive }),
      http: d.http,
      redactor: createRedactor(reportingSecretValues(prev.cwd, env, storedAnthropicKey ? [cfg.key, storedAnthropicKey] : [cfg.key])),
      stderr: (s: string): void => { d.log(s.replace(/\n$/, '')); },
      runId: prev.relayRunId,
      seqStart: prev.lastSeq,
      heartbeat: false,
      cwd: prev.cwd,
      closeDeadlineMs: d.closeDeadlineMs,
    });
    const closing = (async (): Promise<void> => {
      follow.start();
      follow.record({ event: 'pr-created', ts: new Date().toISOString(), url });
      await follow.close();
    })().catch(() => undefined);
    prev.closing = closing;
    await closing;
    prev.lastSeq = follow.lastSeq;
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
    notePrCreated(url: string): Promise<void> {
      const next = prChain.then(() => sendPrCreated(url)).catch(() => undefined);
      prChain = next;
      return next;
    },
  };
}
