/**
 * MOAG daemon core — the always-on autonomous operator.
 *
 * Each tick it (1) intakes new GitHub issues per configured repo, runs them, and
 * reports outcomes back, then (2) runs monitor sweeps over configured health
 * endpoints (which file incident issues on breach — picked up on a later tick).
 *
 * This module is dependency-injected (no direct `vscode`/`gh`/runner imports) so
 * it is fully unit-testable with fakes. The CLI wires the real dependencies.
 */

export interface DaemonRepo { repo: string; label?: string; engine?: string; }
export interface DaemonMonitor {
  name: string;
  healthCheckUrl: string;
  incidentRepo?: string;
  incidentLabel?: string;
  samples?: number;
  intervalMs?: number;
  failureThreshold?: number;
}
export interface DaemonConfig {
  intervalSec?: number;
  fullAuto?: boolean;
  repos?: DaemonRepo[];
  monitors?: DaemonMonitor[];
  /** Stop after this many ticks (for tests / one-shot runs). Unset = run forever. */
  maxTicks?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DaemonDeps {
  runner: { play(plan: any): Promise<void> };
  TaskStatus: { Completed: string };
  fetchOpenIssues: (o: { repo: string; label?: string }) => any[];
  newIssuesToTasks: (issues: any[], repo: string, known: Set<string>) => any[];
  reportIssueResult: (repo: string, num: number, outcome: { success: boolean }) => void;
  createEmptyPlan: (name: string) => any;
  createPlaylist: (name: string) => any;
  createTask: (name: string, prompt: string) => any;
  emit: (o: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
}

/** Run the daemon loop until shouldStop() or maxTicks is reached. */
export async function runDaemon(cfg: DaemonConfig, deps: DaemonDeps): Promise<number> {
  const repos = cfg.repos ?? [];
  const monitors = cfg.monitors ?? [];
  const intervalSec = cfg.intervalSec ?? 300;
  const known = new Map<string, Set<string>>(); // per-repo seen issue keys
  let tick = 0;

  deps.emit({ event: 'daemon-started', repos: repos.map((r) => r.repo), monitors: monitors.length, intervalSec });

  while (!deps.shouldStop()) {
    tick++;

    // ── 1. Intake: poll each repo, run new issues, report outcomes ──
    for (const r of repos) {
      if (deps.shouldStop()) { break; }
      let seen = known.get(r.repo);
      if (!seen) { seen = new Set<string>(); known.set(r.repo, seen); }

      const issues = deps.fetchOpenIssues({ repo: r.repo, label: r.label });
      const tasks = deps.newIssuesToTasks(issues, r.repo, seen);
      deps.emit({ event: 'daemon-intake', tick, repo: r.repo, openIssues: issues.length, newTasks: tasks.length });
      if (tasks.length === 0) { continue; }

      const plan = deps.createEmptyPlan(`daemon — ${r.repo}`);
      plan.playlists = [Object.assign(deps.createPlaylist('GitHub Issues'), { tasks })];
      if (r.engine) { plan.defaultEngine = r.engine; }
      try { await deps.runner.play(plan); }
      catch (err) { deps.emit({ event: 'error', message: err instanceof Error ? err.message : String(err) }); }

      for (const t of tasks) {
        if (!t.sourceIssueNumber || !t.sourceIssueRepo) { continue; }
        const success = t.status === deps.TaskStatus.Completed;
        deps.reportIssueResult(t.sourceIssueRepo, t.sourceIssueNumber, { success });
        deps.emit({ event: 'issue-reported', repo: t.sourceIssueRepo, issue: t.sourceIssueNumber, success });
      }
    }

    // ── 2. Monitor sweeps: each runs a monitor task (files incident on breach) ──
    for (const m of monitors) {
      if (deps.shouldStop()) { break; }
      const plan = deps.createEmptyPlan(`monitor — ${m.name}`);
      const task = Object.assign(deps.createTask(`Monitor ${m.name}`, ''), {
        type: 'monitor',
        healthCheckUrl: m.healthCheckUrl,
        monitorSamples: m.samples,
        monitorIntervalMs: m.intervalMs,
        failureThreshold: m.failureThreshold,
        incidentRepo: m.incidentRepo,
        incidentLabel: m.incidentLabel,
      });
      plan.playlists = [Object.assign(deps.createPlaylist('Monitor'), { tasks: [task] })];
      try { await deps.runner.play(plan); }
      catch (err) { deps.emit({ event: 'error', message: err instanceof Error ? err.message : String(err) }); }
      deps.emit({ event: 'daemon-monitor', tick, name: m.name, healthy: task.status === deps.TaskStatus.Completed });
    }

    deps.emit({ event: 'daemon-tick-complete', tick });
    if (cfg.maxTicks && tick >= cfg.maxTicks) { break; }
    if (deps.shouldStop()) { break; }
    await deps.sleep(intervalSec * 1000);
  }

  deps.emit({ event: 'daemon-stopped', ticks: tick });
  return 0;
}
