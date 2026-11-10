/**
 * Run reporting shared by the headless CLI (`moag run`) and the VS Code extension host:
 * the runner-event → JSONL line mapping, the relay-only `run-meta` facts, per-call cost
 * lines, the ONOSOO relay start, and the stateless relay-env helpers.
 *
 * Free of any `vscode` import (asserted by src/test/unit/server/no-vscode.test.ts), so it
 * loads before the headless shim and inside the extension host alike. Policy — stopping a
 * run on a budget breach or at a ship gate — stays with each caller.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveOnosooConfig } from './onosoo-config';
import { OnosooSpool } from './onosoo-spool';
import { OnosooRelay, RelayHttpClient, RunMeta } from './onosoo-relay';
import type { Redactor } from '../utils/redact';
import type { ProjectIdentity } from './project-identity';
import { TaskStatus } from '../models/types';

// ─── Lines ───

/** One JSONL protocol line before its timestamp is stamped. */
export type RunLine = Record<string, unknown>;

/** Writes one protocol line. */
export type EmitLine = (obj: RunLine) => void;

/** The manual-gate note of a headless run, which halts at the gate. */
export const HEADLESS_MANUAL_GATE_NOTE = 'Halting for human approval (ship gate).';

/** A task as the event lines read it. */
interface LineTask {
  id: string;
  name: string;
  status?: string;
}

/**
 * Map runner events to protocol lines: exactly one listener per event, and no policy (no
 * stop(), no flags). Returns the unwire, which removes every listener it added.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wireRunEventLines(runner: any, emit: EmitLine, opts: { manualGateNote?: string } = {}): () => void {
  const note = opts.manualGateNote ?? HEADLESS_MANUAL_GATE_NOTE;
  const listeners: Array<[string, (...args: never[]) => void]> = [
    ['state-changed', (state: string) => emit({ event: 'state', state })],
    ['task-started', (t: LineTask) => emit({ event: 'task-started', id: t.id, name: t.name })],
    // The final status says which: task-completed also fires for a Skipped task, task-failed
    // for a Blocked one (a failed dependency, or failurePolicy "mark-blocked").
    ['task-completed', (t: LineTask) => emit({ event: 'task-completed', id: t.id, name: t.name, status: t.status })],
    ['task-failed', (t: LineTask) => emit({ event: 'task-failed', id: t.id, name: t.name, status: t.status })],
    ['task-escalate', (t: LineTask, category: string) => emit({ event: 'task-escalate', id: t.id, name: t.name, category })],
    ['incident', (t: LineTask, summary: string, issueUrl: string | null) =>
      emit({ event: 'incident', id: t.id, name: t.name, summary, issueUrl })],
    ['error', (err: Error) => emit({ event: 'error', message: err.message })],
    // Automatic dependency installs: the event already carries every field of the protocol line.
    ['dependencies-installed', (_t: LineTask, ev: RunLine) => emit(ev)],
    ['dependencies-install-failed', (_t: LineTask, ev: RunLine) => emit(ev)],
    ['dependencies-not-installed', (_t: LineTask, ev: RunLine) => emit(ev)],
    ['budget-exceeded', (d: { totalCost: number; budget: number }) =>
      emit({ event: 'budget-exceeded', totalCost: d.totalCost, budget: d.budget })],
    ['manual-gate', (t: LineTask) => emit({ event: 'manual-gate', id: t.id, name: t.name, note })],
  ];
  for (const [event, fn] of listeners) { runner.on(event, fn); }
  return (): void => {
    for (const [event, fn] of listeners) { runner.off?.(event, fn); }
  };
}

// ─── run-meta ───

/**
 * The protocol v1.2 identity fields of a run-meta, picked explicitly (nothing else of the
 * identity object travels). Empty for a null or missing identity.
 */
export function pickIdentity(identity: ProjectIdentity | null | undefined): Pick<RunMeta, 'project_key' | 'repo_url' | 'repos'> {
  if (!identity || typeof identity.project_key !== 'string' || identity.project_key.length === 0) { return {}; }
  return {
    project_key: identity.project_key,
    ...(typeof identity.repo_url === 'string' ? { repo_url: identity.repo_url } : {}),
    ...(Array.isArray(identity.repos)
      ? { repos: identity.repos.map((r) => (typeof r.repo_url === 'string' ? { dir: r.dir, key: r.key, repo_url: r.repo_url } : { dir: r.dir, key: r.key })) }
      : {}),
  };
}

/**
 * The relay-only `run-meta` facts for a plan: its name, the project's package.json
 * name (else the folder's base name — never a path), and each task's id and name in
 * plan order, plus the project identity when one is given. Synchronous and pure: it
 * never runs git. Caps and redaction are the relay's.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildRunMeta(plan: any, cwd: string, identity?: ProjectIdentity | null): RunMeta {
  let project = '';
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    const name = (pkg as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim().length > 0) { project = name; }
  } catch { /* no package.json */ }
  if (!project) { project = path.basename(path.resolve(cwd)); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tasks = (plan?.playlists ?? []).flatMap((pl: any) => pl?.tasks ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: any) => ({ id: String(t?.id), name: String(t?.name ?? '') }));
  return { plan_name: String(plan?.name ?? ''), project, tasks, ...pickIdentity(identity) };
}

// ─── Cost ───

/**
 * Emit a `cost` line per engine call whose label `accept` takes; returns the unsubscribe.
 * Never throws.
 */
export function subscribeRunCostLines(emit: EmitLine, accept: (label: string) => boolean = () => true): () => void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { costLedger } = require('../utils/cost-ledger');
    const offRecord = costLedger.onRecord((e: { estimatedCostUsd: number; costSource?: string; label: string }) => {
      if (accept(e.label)) { emit({ event: 'cost', usd: e.estimatedCostUsd, source: e.costSource ?? 'estimated' }); }
    });
    const offUnreported = costLedger.onUnreported((e: { label: string }) => {
      if (accept(e.label)) { emit({ event: 'cost', usd: 0, source: 'none' }); }
    });
    return (): void => { offRecord(); offUnreported(); };
  } catch {
    return (): void => undefined;
  }
}

// ─── Tally ───

/** Task totals of a plan as run-finished reports them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tallyPlan(plan: any, statuses: { Completed: string; Failed: string } = TaskStatus): { total: number; completed: number; failed: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tasks = plan.playlists.flatMap((pl: any) => pl.tasks);
  return {
    total: tasks.length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    completed: tasks.filter((t: any) => t.status === statuses.Completed).length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    failed: tasks.filter((t: any) => t.status === statuses.Failed).length,
  };
}

// ─── Relay ───

/** What {@link startRunRelay} needs. */
export interface StartRunRelayOptions {
  cwd: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan: any;
  /** The env the relay configuration reads (the device key may be in it). */
  env: NodeJS.ProcessEnv;
  buildRedactor: (extra: string[]) => Redactor;
  stderr: (s: string) => void;
  http?: RelayHttpClient;
  isPidAlive?: (pid: number) => boolean;
  closeDeadlineMs?: number;
  /** The project identity the run-meta carries (protocol v1.2); absent or null for none. */
  identity?: ProjectIdentity | null;
}

/** A relay built but not started: {@link PreparedRunRelay.begin} sends run-meta (seq 1) and starts it. */
export interface PreparedRunRelay {
  relay: OnosooRelay;
  key: string;
  /** Start the relay with the run-meta for `identity`. Runs once; later calls do nothing. Never throws; false when the start failed or already ran. */
  begin(identity?: ProjectIdentity | null): boolean;
}

/**
 * Start the ONOSOO relay when a device key is configured (env MOAG_ONOSOO_KEY or the
 * user-level onosoo.json); null otherwise — then nothing is spooled, sent or timed.
 * Never throws: a relay that cannot start leaves the run exactly as it was.
 */
export function startRunRelay(o: StartRunRelayOptions): { relay: OnosooRelay; key: string } | null {
  const prepared = prepareRunRelay(o);
  if (!prepared?.begin(o.identity)) { return null; }
  return { relay: prepared.relay, key: prepared.key };
}

/**
 * Build the ONOSOO relay without starting it, so a caller can send run-meta (seq 1) once the
 * project identity is known. Null when no device key is configured. Never throws.
 */
export function prepareRunRelay(o: StartRunRelayOptions): PreparedRunRelay | null {
  const stderr = o.stderr;
  try {
    const cfg = resolveOnosooConfig({ env: o.env, cwd: o.cwd, stderr });
    if (!cfg) { return null; }
    let redactor: Redactor;
    try {
      redactor = o.buildRedactor([cfg.key]);
    } catch {
      // Every relayed event then carries { redaction_failed: true } instead of its data.
      redactor = { redact: (): never => { throw new Error('redactor unavailable'); } };
    }
    const spool = new OnosooSpool(cfg.stateDir, o.cwd, { isPidAlive: o.isPidAlive });
    const relay = new OnosooRelay({
      config: cfg, spool, http: o.http, redactor, stderr, closeDeadlineMs: o.closeDeadlineMs, cwd: o.cwd,
    });
    let begun = false;
    const begin = (identity?: ProjectIdentity | null): boolean => {
      if (begun) { return false; }
      begun = true;
      try {
        relay.start(buildRunMeta(o.plan, o.cwd, identity));
        return true;
      } catch (err) {
        stderr(`ONOSOO relay could not start: ${err instanceof Error ? err.message : String(err)}\n`);
        return false;
      }
    };
    return { relay, key: cfg.key, begin };
  } catch (err) {
    stderr(`ONOSOO relay could not start: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

/** True when a device key is configured for `cwd`, so a run there will relay. Silent; never throws. */
export function relayConfigured(env: NodeJS.ProcessEnv, cwd: string): boolean {
  try {
    return !!resolveOnosooConfig({ env, cwd, stderr: () => undefined });
  } catch {
    return false;
  }
}

// ─── Relay env ───

/** Remove the ONOSOO relay variables from `env` (the device key must not reach child processes). */
export function forgetRelayEnv(env: NodeJS.ProcessEnv): void {
  delete env.MOAG_ONOSOO_KEY;
  delete env.MOAG_ONOSOO_URL;
}

/** The relay variables as found in an env before they were removed from it. */
export type RelayEnvSnapshot = { MOAG_ONOSOO_KEY?: string; MOAG_ONOSOO_URL?: string };

/** Take the ONOSOO relay variables out of `env` and return them. Stateless. */
export function takeRelayEnv(env: NodeJS.ProcessEnv): RelayEnvSnapshot {
  const snapshot: RelayEnvSnapshot = {
    ...(env.MOAG_ONOSOO_KEY !== undefined ? { MOAG_ONOSOO_KEY: env.MOAG_ONOSOO_KEY } : {}),
    ...(env.MOAG_ONOSOO_URL !== undefined ? { MOAG_ONOSOO_URL: env.MOAG_ONOSOO_URL } : {}),
  };
  forgetRelayEnv(env);
  return snapshot;
}
