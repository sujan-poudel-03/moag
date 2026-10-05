import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  latestRequirements, taggedTasks, recordGateResults, recordCommit, stampRelease, requirementStatuses,
  MAX_TRACE_COMMITS, MAX_TRACE_RELEASES, MAX_TRACE_GATES,
} from '../../../models/requirement-trace';
import { Plan, Task, TaskStatus, TaskType } from '../../../models/types';
import { createEmptyPlan } from '../../../models/plan';

// ─── Fixtures ───

const PRD = '## Requirements\n- [R-1] login\n- [R-2] logout\n';
const AT = '2026-10-04T00:00:00.000Z';

function task(id: string, requirementIds: string[] | undefined, status: TaskStatus, type: TaskType = 'agent'): Task {
  return { id, name: id, prompt: 'p', type, status, requirementIds };
}

function planWith(tasks: Task[], prdText = PRD): Plan {
  const plan = createEmptyPlan('trace');
  plan.prdVersions = [{ version: '2.0.0', text: prdText, createdAt: AT }];
  plan.playlists = [{ id: 'pl-1', name: 'Build', autoplay: true, tasks }];
  return plan;
}

const pass = [{ command: 'npm test', exitCode: 0, timedOut: false }];
const fail = [{ command: 'npm test', exitCode: 1, timedOut: false }];

const row = (plan: Plan, id: string) => {
  const r = requirementStatuses(plan).find(x => x.id === id);
  assert.ok(r, `no row for ${id}`);
  return r;
};

// ─── Queries ───

describe('requirement-trace — queries', () => {
  it('latestRequirements reads the last PRD version and is empty without versions', () => {
    const plan = planWith([]);
    plan.prdVersions!.unshift({ version: '1.0.0', text: '## Requirements\n- [R-9] old\n', createdAt: AT });
    assert.deepEqual(latestRequirements(plan).map(r => r.id), ['R-1', 'R-2']);
    plan.prdVersions = undefined;
    assert.deepEqual(latestRequirements(plan), []);
  });

  it('taggedTasks ignores a release task that cites the ID', () => {
    const plan = planWith([
      task('t-1', ['R-1'], TaskStatus.Completed),
      task('rel', ['R-1'], TaskStatus.Completed, 'release'),
    ]);
    assert.deepEqual(taggedTasks(plan, 'R-1').map(t => t.id), ['t-1']);
  });
});

// ─── Shipped rule (F3.4) ───

describe('requirement-trace — shipped rule', () => {
  it('completed tasks + passing gates + stampRelease → shipped with version and tag', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    assert.deepEqual(recordGateResults(plan, pass, AT), ['R-1']);
    const stamp = stampRelease(plan, 'v1.2.3', AT);
    assert.deepEqual(stamp, { shipped: ['R-1'], prdVersion: '2.0.0' });
    const r = row(plan, 'R-1');
    assert.equal(r.status, 'shipped');
    assert.equal(r.version, '2.0.0');
    assert.equal(r.releaseTag, 'v1.2.3');
    assert.deepEqual(r.tasks, [{ id: 't-1', status: TaskStatus.Completed }]);
    assert.deepEqual(r.gates, [{ command: 'npm test', exitCode: 0 }]);
    assert.deepEqual(plan.requirementTrace![0].releases, [
      { releaseTag: 'v1.2.3', prdVersion: '2.0.0', at: AT, taskIds: ['t-1'] },
    ]);
  });

  it('a failing gate (exit 1) is skipped by stampRelease → in-progress', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, fail, AT);
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT).shipped, []);
    assert.equal(plan.requirementTrace![0].releases.length, 0);
    assert.equal(row(plan, 'R-1').status, 'in-progress');
  });

  it('a timed-out gate with exit 0 is not shipped', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, [{ command: 'npm test', exitCode: 0, timedOut: true }], AT);
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT).shipped, []);
  });

  it('no recorded gates → not stamped', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT).shipped, []);
    assert.equal(row(plan, 'R-1').status, 'in-progress');
  });

  it('an empty gate list is a no-op and touches nothing', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    assert.deepEqual(recordGateResults(plan, [], AT), []);
    assert.equal(plan.requirementTrace, undefined);
  });

  it('no tagged tasks → recordGateResults is a no-op', () => {
    const plan = planWith([task('t-1', undefined, TaskStatus.Completed)]);
    assert.deepEqual(recordGateResults(plan, pass, AT), []);
    assert.equal(plan.requirementTrace, undefined);
  });

  it('a pending tagged task is not stamped', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed), task('t-2', ['R-1'], TaskStatus.Pending)]);
    recordGateResults(plan, pass, AT);
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT).shipped, []);
  });

  it('gates are not recorded for a requirement whose tagged tasks are still Pending, so a release cannot ship it', () => {
    const plan = planWith([
      task('t-1', ['R-1'], TaskStatus.Pending),
      task('t-2', ['R-2'], TaskStatus.Completed),
    ]);
    assert.deepEqual(recordGateResults(plan, pass, AT), ['R-2']);
    assert.equal(plan.requirementTrace!.find(r => r.id === 'R-1'), undefined, 'no gate evidence for R-1');
    // The pending task later completes without any gate run exercising it.
    plan.playlists[0].tasks[0].status = TaskStatus.Completed;
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT).shipped, ['R-2']);
    assert.equal(row(plan, 'R-1').status, 'in-progress');
  });

  it('a mixed Completed/Pending requirement has its older gate evidence cleared by a newer run', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    plan.playlists[0].tasks.push(task('t-2', ['R-1'], TaskStatus.Pending));
    assert.deepEqual(recordGateResults(plan, fail, AT), ['R-1'], 'reported as changed so the caller saves');
    assert.deepEqual(plan.requirementTrace![0].gates, [], 'the old green run is not kept');
    // Nothing left to clear: a second run reports no change.
    assert.deepEqual(recordGateResults(plan, fail, AT), []);
  });

  it('green gates, Pending task added, failing run, task completes → nothing ships', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    assert.deepEqual(recordGateResults(plan, pass, AT), ['R-1']);
    plan.playlists[0].tasks.push(task('t-2', ['R-1'], TaskStatus.Pending));
    recordGateResults(plan, fail, AT);
    plan.playlists[0].tasks[1].status = TaskStatus.Completed;
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT).shipped, []);
    assert.equal(plan.requirementTrace![0].releases.length, 0);
    assert.notEqual(row(plan, 'R-1').status, 'shipped');
    assert.equal(row(plan, 'R-1').status, 'in-progress');
    // A real gate run after the task completed is what makes it shippable again.
    recordGateResults(plan, pass, AT);
    assert.deepEqual(stampRelease(plan, 'v1.0.1', AT).shipped, ['R-1']);
    assert.equal(row(plan, 'R-1').status, 'shipped');
  });

  it('a released requirement that gains a Pending task loses its green gates on the next run', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    plan.playlists[0].tasks.push(task('t-2', ['R-1'], TaskStatus.Pending));
    recordGateResults(plan, pass, AT);
    plan.playlists[0].tasks[1].status = TaskStatus.Completed;
    assert.deepEqual(stampRelease(plan, 'v1.1.0', AT).shipped, []);
    assert.equal(row(plan, 'R-1').status, 'in-progress');
    assert.equal(row(plan, 'R-1').releaseTag, 'v1.0.0');
  });

  it('stampRelease without PRD versions returns {[], null}', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    plan.prdVersions = undefined;
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT), { shipped: [], prdVersion: null });
  });
});

// ─── Status derivation ───

describe('requirement-trace — requirementStatuses', () => {
  it('a Failed task → not-shipped, naming the task', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed), task('t-2', ['R-1'], TaskStatus.Failed)]);
    const r = row(plan, 'R-1');
    assert.equal(r.status, 'not-shipped');
    assert.equal(r.blockedBy, 't-2');
  });

  it('a Blocked task → not-shipped, naming the task, even after an earlier release', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    plan.playlists[0].tasks.push(task('t-9', ['R-1'], TaskStatus.Blocked));
    const r = row(plan, 'R-1');
    assert.equal(r.status, 'not-shipped');
    assert.equal(r.blockedBy, 't-9');
  });

  it('no tagged tasks → untracked', () => {
    const plan = planWith([]);
    assert.equal(row(plan, 'R-2').status, 'untracked');
    assert.equal(row(plan, 'R-2').version, null);
  });

  it('a new pending task tagged after the release → in-progress, keeping the earlier version', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    plan.playlists[0].tasks.push(task('t-2', ['R-1'], TaskStatus.Pending));
    const r = row(plan, 'R-1');
    assert.equal(r.status, 'in-progress');
    assert.equal(r.version, '2.0.0');
    assert.equal(r.releaseTag, 'v1.0.0');
  });

  it('a completed task added after the release but not in it → in-progress', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    plan.playlists[0].tasks.push(task('t-2', ['R-1'], TaskStatus.Completed));
    assert.equal(row(plan, 'R-1').status, 'in-progress');
  });

  it('a released requirement whose latest gates failed is in-progress, not shipped', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    assert.equal(row(plan, 'R-1').status, 'shipped');
    recordGateResults(plan, fail, AT);
    const r = row(plan, 'R-1');
    assert.equal(r.status, 'in-progress');
    assert.deepEqual(r.gates, [{ command: 'npm test', exitCode: 1 }]);
    assert.equal(r.releaseTag, 'v1.0.0', 'the earlier release is still reported');
  });

  it('a released requirement whose latest gate timed out is in-progress', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    recordGateResults(plan, [{ command: 'npm test', exitCode: 0, timedOut: true }], AT);
    assert.equal(row(plan, 'R-1').status, 'in-progress');
  });

  it('a released requirement with no tagged tasks and failing gates is in-progress', () => {
    const plan = planWith([]);
    plan.requirementTrace = [{
      id: 'R-1', taskIds: [], commits: [],
      gates: [{ command: 'npm test', exitCode: 1, timedOut: false, at: AT }],
      releases: [{ releaseTag: 'v1.0.0', prdVersion: '2.0.0', at: AT, taskIds: [] }],
    }];
    assert.equal(row(plan, 'R-1').status, 'in-progress');
    plan.requirementTrace[0].gates[0].exitCode = 0;
    assert.equal(row(plan, 'R-1').status, 'shipped');
  });

  it('a released requirement whose tasks were removed is refreshed by the next gate run, so stale green gates cannot keep it shipped', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed), task('t-2', ['R-2'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    assert.equal(row(plan, 'R-1').status, 'shipped');
    // The tasks that implemented R-1 are removed from the plan (e.g. a playlist was deleted).
    plan.playlists[0].tasks = plan.playlists[0].tasks.filter(t => t.id !== 't-1');
    assert.equal(row(plan, 'R-1').status, 'shipped', 'still shipped on its last gates');
    const LATER = '2026-10-05T00:00:00.000Z';
    const touched = recordGateResults(plan, fail, LATER);
    assert.deepEqual(touched, ['R-1', 'R-2'], 'the untagged released record is refreshed too');
    const r1 = plan.requirementTrace!.find(r => r.id === 'R-1')!;
    assert.deepEqual(r1.gates.map(g => [g.exitCode, g.at]), [[1, LATER]]);
    assert.equal(row(plan, 'R-1').status, 'in-progress', 'a newer failing run demotes it');
    assert.equal(row(plan, 'R-1').releaseTag, 'v1.0.0', 'the release history is kept');
    // A green run afterwards restores it.
    recordGateResults(plan, pass, LATER);
    assert.equal(row(plan, 'R-1').status, 'shipped');
  });

  it('an unreleased, untagged trace record is left alone by recordGateResults', () => {
    const plan = planWith([task('t-2', ['R-2'], TaskStatus.Completed)]);
    plan.requirementTrace = [{ id: 'R-1', taskIds: [], commits: ['abc'], gates: [], releases: [] }];
    assert.deepEqual(recordGateResults(plan, fail, AT), ['R-2']);
    assert.deepEqual(plan.requirementTrace.find(r => r.id === 'R-1')!.gates, []);
    assert.equal(row(plan, 'R-1').status, 'untracked');
  });

  it('a release-type task tagged with the ID is ignored', () => {
    const plan = planWith([task('rel', ['R-2'], TaskStatus.Failed, 'release')]);
    const r = row(plan, 'R-2');
    assert.equal(r.status, 'untracked');
    assert.deepEqual(r.tasks, []);
  });

  it('an ID only in the trace or task tags (not in the latest PRD) → removed', () => {
    const plan = planWith([task('t-3', ['R-3'], TaskStatus.Completed)]);
    plan.requirementTrace = [{ id: 'R-7', taskIds: [], commits: [], gates: [], releases: [] }];
    assert.equal(row(plan, 'R-3').status, 'removed');
    assert.equal(row(plan, 'R-7').status, 'removed');
    assert.deepEqual(requirementStatuses(plan).map(r => r.id), ['R-1', 'R-2', 'R-3', 'R-7']);
  });

  it('is pure — the plan is unchanged', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed), task('t-2', ['R-2'], TaskStatus.Failed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    const before = structuredClone(plan);
    requirementStatuses(plan);
    requirementStatuses(plan);
    assert.deepEqual(plan, before);
  });
});

// ─── Commits, upsert and caps ───

describe('requirement-trace — commits and caps', () => {
  it('recordCommit appends deduped SHAs, newest kept last, and unions taskIds', () => {
    const plan = planWith([task('t-1', ['R-2', 'R-1'], TaskStatus.Completed)]);
    recordCommit(plan, plan.playlists[0].tasks[0], 'aaa');
    recordCommit(plan, plan.playlists[0].tasks[0], 'bbb');
    recordCommit(plan, plan.playlists[0].tasks[0], 'aaa');
    assert.deepEqual(plan.requirementTrace!.map(r => r.id), ['R-1', 'R-2'], 'sorted by ID number');
    assert.deepEqual(plan.requirementTrace![0].commits, ['bbb', 'aaa']);
    assert.deepEqual(plan.requirementTrace![0].taskIds, ['t-1']);
  });

  it('recordCommit is a no-op without requirementIds or SHA', () => {
    const plan = planWith([task('t-1', undefined, TaskStatus.Completed), task('t-2', ['R-1'], TaskStatus.Completed)]);
    recordCommit(plan, plan.playlists[0].tasks[0], 'aaa');
    recordCommit(plan, plan.playlists[0].tasks[1], '');
    recordCommit(plan, plan.playlists[0].tasks[1], undefined);
    assert.equal(plan.requirementTrace, undefined);
  });

  it('keeps the trace sorted numerically (R-10 after R-2)', () => {
    const plan = planWith([task('t-1', ['R-10'], TaskStatus.Completed), task('t-2', ['R-2'], TaskStatus.Completed)]);
    recordCommit(plan, plan.playlists[0].tasks[0], 'a');
    recordCommit(plan, plan.playlists[0].tasks[1], 'b');
    assert.deepEqual(plan.requirementTrace!.map(r => r.id), ['R-2', 'R-10']);
  });

  it('caps commits, releases and gates', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    for (let i = 0; i < MAX_TRACE_COMMITS + 5; i++) { recordCommit(plan, plan.playlists[0].tasks[0], `sha${i}`); }
    const manyGates = Array.from({ length: MAX_TRACE_GATES + 5 }, (_, i) => ({ command: `g${i}`, exitCode: 0, timedOut: false }));
    recordGateResults(plan, manyGates, AT);
    for (let i = 0; i < MAX_TRACE_RELEASES + 5; i++) { stampRelease(plan, `v0.0.${i}`, AT); }
    const rec = plan.requirementTrace![0];
    assert.equal(rec.commits.length, MAX_TRACE_COMMITS);
    assert.equal(rec.commits[rec.commits.length - 1], `sha${MAX_TRACE_COMMITS + 4}`, 'newest kept');
    assert.equal(rec.gates.length, MAX_TRACE_GATES);
    assert.equal(rec.releases.length, MAX_TRACE_RELEASES);
    assert.equal(rec.releases[rec.releases.length - 1].releaseTag, `v0.0.${MAX_TRACE_RELEASES + 4}`, 'newest kept');
  });

  it('recordGateResults replaces the previous run rather than appending', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    recordGateResults(plan, fail, AT);
    assert.deepEqual(plan.requirementTrace![0].gates.map(g => g.exitCode), [1]);
  });
});

describe('requirement-trace — module boundary', () => {
  it('imports no vscode', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../models/requirement-trace.ts'), 'utf-8');
    assert.ok(!/from 'vscode'/.test(source));
    assert.ok(!/require\('vscode'\)/.test(source));
  });
});
