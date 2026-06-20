// ─── Daemon core: multi-repo intake + monitor sweeps (dependency-injected) ───

import { strict as assert } from 'assert';
import { runDaemon, DaemonConfig, DaemonDeps } from '../../../headless/daemon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(over: Partial<DaemonDeps> & { issuesByRepo?: Record<string, any[]> } = {}): { deps: DaemonDeps; events: any[]; played: any[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const played: any[] = [];
  const issuesByRepo = over.issuesByRepo ?? {};
  const deps: DaemonDeps = {
    runner: {
      play: async (plan) => {
        played.push(plan);
        // simulate every task completing
        for (const pl of plan.playlists) { for (const t of pl.tasks) { t.status = 'completed'; } }
      },
    },
    TaskStatus: { Completed: 'completed' },
    fetchOpenIssues: ({ repo }) => issuesByRepo[repo] ?? [],
    newIssuesToTasks: (issues, repo, known) => {
      const out = [];
      for (const i of issues) {
        const key = `${repo}#${i.number}`;
        if (known.has(key)) { continue; }
        known.add(key);
        out.push({ id: `t-${i.number}`, name: i.title, status: 'pending', sourceIssueNumber: i.number, sourceIssueRepo: repo });
      }
      return out;
    },
    reportIssueResult: (repo, num, outcome) => events.push({ event: 'report', repo, num, success: outcome.success }),
    createEmptyPlan: (name) => ({ name, defaultEngine: 'claude', playlists: [] }),
    createPlaylist: (name) => ({ id: name, name, tasks: [] }),
    createTask: (name) => ({ id: name, name, status: 'pending' }),
    emit: (o) => events.push(o),
    sleep: async () => { /* no real waiting in tests */ },
    shouldStop: () => false,
    ...over,
  };
  return { deps, events, played };
}

describe('runDaemon', () => {
  it('intakes new issues across multiple repos and reports outcomes', async () => {
    const { deps, events, played } = makeDeps({
      issuesByRepo: { 'o/a': [{ number: 1, title: 'A1' }], 'o/b': [{ number: 7, title: 'B7' }] },
    });
    const cfg: DaemonConfig = { maxTicks: 1, repos: [{ repo: 'o/a' }, { repo: 'o/b' }] };
    await runDaemon(cfg, deps);

    assert.equal(played.length, 2, 'one plan run per repo with new issues');
    const reports = events.filter((e) => e.event === 'report');
    assert.deepEqual(reports.map((r) => `${r.repo}#${r.num}:${r.success}`).sort(), ['o/a#1:true', 'o/b#7:true']);
  });

  it('does not re-intake the same issue on a later tick', async () => {
    const { deps, played } = makeDeps({ issuesByRepo: { 'o/a': [{ number: 1, title: 'A1' }] } });
    const cfg: DaemonConfig = { maxTicks: 3, repos: [{ repo: 'o/a' }] };
    await runDaemon(cfg, deps);
    assert.equal(played.length, 1, 'issue #1 should be processed once across 3 ticks');
  });

  it('runs monitor sweeps as monitor-typed tasks', async () => {
    const { deps, events, played } = makeDeps();
    const cfg: DaemonConfig = { maxTicks: 1, monitors: [{ name: 'prod', healthCheckUrl: 'http://h/health' }] };
    await runDaemon(cfg, deps);

    assert.equal(played.length, 1);
    assert.equal(played[0].playlists[0].tasks[0].type, 'monitor');
    assert.equal(played[0].playlists[0].tasks[0].healthCheckUrl, 'http://h/health');
    assert.ok(events.some((e) => e.event === 'daemon-monitor' && e.name === 'prod'));
  });

  it('stops promptly when shouldStop flips', async () => {
    let stop = false;
    const { deps, events } = makeDeps({ shouldStop: () => stop });
    // flip stop after the first tick via the emit hook
    const cfg: DaemonConfig = { repos: [{ repo: 'o/a' }] };
    const baseEmit = deps.emit;
    deps.emit = (o) => { baseEmit(o); if (o.event === 'daemon-tick-complete') { stop = true; } };
    await runDaemon(cfg, deps);
    assert.ok(events.some((e) => e.event === 'daemon-stopped'));
  });

  it('emits daemon-started and daemon-stopped lifecycle events', async () => {
    const { deps, events } = makeDeps();
    await runDaemon({ maxTicks: 1 }, deps);
    assert.ok(events.some((e) => e.event === 'daemon-started'));
    assert.ok(events.some((e) => e.event === 'daemon-stopped'));
  });
});
