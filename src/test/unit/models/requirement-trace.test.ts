import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  latestRequirements, taggedTasks, verifiedRequirementIds, recordGateResults, recordCommit, stampRelease, requirementStatuses, standardsGateCommand,
  isStandardsGateCommand, standardsGateWord, standardsOpenText, STANDARDS_GATE_COMMAND,
  MAX_TRACE_COMMITS, MAX_TRACE_RELEASES, MAX_TRACE_GATES,
} from '../../../models/requirement-trace';
import { Plan, Task, TaskStatus, TaskType } from '../../../models/types';
import { createEmptyPlan } from '../../../models/plan';
import { NO_BLOCKING_RULES } from '../../../standards/checker';

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

  it('verifiedRequirementIds leaves out a requirement whose tasks all went out in its last release', () => {
    const plan = planWith([
      task('t-1', ['R-1'], TaskStatus.Completed),
      task('t-2', ['R-2'], TaskStatus.Completed),
    ]);
    assert.deepEqual(verifiedRequirementIds(plan), ['R-1', 'R-2'], 'nothing released: every tagged id');
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    assert.deepEqual(verifiedRequirementIds(plan), [], 'all shipped in v1: no id is this check\'s subject');
    // v2: a new task for R-3, and a new task that reworks shipped R-1.
    plan.playlists[0].tasks.push(task('t-3', ['R-3'], TaskStatus.Pending), task('t-4', ['R-1'], TaskStatus.Pending));
    assert.deepEqual(verifiedRequirementIds(plan), ['R-1', 'R-3'], 'R-2 shipped untouched; R-1 is back in with t-4');
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

// ─── Standards version on the release stamp ───

describe('requirement-trace — standards version on the release', () => {
  it('stampRelease records the standards version on the release, and the status row reports it', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    assert.deepEqual(stampRelease(plan, 'v1.2.3', AT, { standardsVersion: 3 }).shipped, ['R-1']);
    assert.deepEqual(plan.requirementTrace![0].releases, [
      { releaseTag: 'v1.2.3', prdVersion: '2.0.0', at: AT, taskIds: ['t-1'], standardsVersion: 3 },
    ]);
    const r = row(plan, 'R-1');
    assert.equal(r.status, 'shipped');
    assert.equal(r.standardsVersion, 3);
  });

  it('a release with no standards stamps no version: the key is absent and the row says null', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT);
    assert.equal('standardsVersion' in plan.requirementTrace![0].releases[0], false);
    assert.equal(row(plan, 'R-1').standardsVersion, null);
    // An unreleased requirement reports null too, never undefined.
    assert.equal(row(plan, 'R-2').standardsVersion, null);
  });

  it('a value that is not an integer >= 1 is never recorded', () => {
    for (const bad of [0, -2, 1.5, Number.NaN, '3' as unknown as number]) {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, pass, AT);
      stampRelease(plan, 'v1.0.0', AT, { standardsVersion: bad });
      assert.equal('standardsVersion' in plan.requirementTrace![0].releases[0], false, String(bad));
    }
  });

  it('the row reports the version of the LAST release, and a later release without one reports null', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, pass, AT);
    stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 2 });
    stampRelease(plan, 'v1.1.0', AT, { standardsVersion: 5 });
    assert.equal(row(plan, 'R-1').standardsVersion, 5);
    stampRelease(plan, 'v1.2.0', AT);
    assert.equal(row(plan, 'R-1').standardsVersion, null);
  });

  // What a check left open is recorded beside the version it was made against: a release
  // that was checked is not always a clean one, and the trace says by how much.
  describe('what the check left open is recorded beside the version', () => {
    const COUNTS = { advisoryFindings: 4, notCheckedRules: 2, notCheckedFiles: 7 };
    const withCounts = (version: number, exitCode = 0) =>
      [{ command: standardsGateCommand(version), exitCode, timedOut: false, standardsCounts: COUNTS }, ...pass];

    it('recordGateResults keeps the counts on the standards row, as a copy, and on no other row', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, withCounts(3), AT);
      const gates = plan.requirementTrace![0].gates;
      assert.deepEqual(gates[0], { command: 'moag:standards v3', exitCode: 0, timedOut: false, at: AT, standardsCounts: COUNTS });
      assert.notEqual(gates[0].standardsCounts, COUNTS, 'a copy: the caller\'s object is not kept');
      assert.ok(gates.slice(1).every((g) => !('standardsCounts' in g)));
    });

    it('a local stamp takes the counts from the passing standards row, and the status row reports them', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, withCounts(3), AT);
      stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true });
      assert.deepEqual(plan.requirementTrace![0].releases[0],
        { releaseTag: 'v1.0.0', prdVersion: '2.0.0', at: AT, taskIds: ['t-1'], standardsVersion: 3, standardsCounts: COUNTS });
      assert.deepEqual(row(plan, 'R-1').standardsCounts, COUNTS);
    });

    it('a release checked against standards with no blocking rules is stamped as exactly that, from the row or from the caller', () => {
      const none = { advisoryFindings: 1, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true as const };
      // From the row the PRD loop wrote (local runs).
      const local = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(local, [{ command: standardsGateCommand(3), exitCode: 0, timedOut: false, standardsCounts: none }, ...pass], AT);
      assert.deepEqual(stampRelease(local, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true }).shipped, ['R-1'], 'it ships');
      assert.deepEqual(local.requirementTrace![0].releases[0].standardsCounts, none);
      assert.notEqual(local.requirementTrace![0].releases[0].standardsCounts, none, 'a copy');
      assert.deepEqual(row(local, 'R-1').standardsCounts, none);
      assert.equal(row(local, 'R-1').standardsVersion, 3);
      // From the caller (the hosted server).
      const hosted = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(hosted, pass, AT);
      stampRelease(hosted, 'v1.0.0', AT, { standardsVersion: 3, standardsCounts: none });
      assert.deepEqual(row(hosted, 'R-1').standardsCounts, none);
      // A check that had a blocking set carries no such key, and nothing else rides along.
      const leaky = { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: false, file: 'src/x.ts' } as unknown as typeof none;
      const other = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(other, pass, AT);
      stampRelease(other, 'v1.0.0', AT, { standardsVersion: 3, standardsCounts: leaky });
      assert.deepEqual(other.requirementTrace![0].releases[0].standardsCounts, { advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0 });
    });

    it('counts the caller knows (the hosted server) take the place of the row\'s', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, pass, AT);
      const given = { advisoryFindings: 1, notCheckedRules: 0, notCheckedFiles: 3 };
      stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsCounts: given });
      assert.deepEqual(plan.requirementTrace![0].releases[0].standardsCounts, given);
      assert.deepEqual(row(plan, 'R-1').standardsCounts, given);
    });

    it('never without a version: no stamp, no counts — whatever the row or the caller says', () => {
      // The standards row is for another version than the one offered.
      const other = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(other, withCounts(2), AT);
      stampRelease(other, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true, standardsCounts: COUNTS });
      assert.equal('standardsVersion' in other.requirementTrace![0].releases[0], false);
      assert.equal('standardsCounts' in other.requirementTrace![0].releases[0], false);
      assert.equal(row(other, 'R-1').standardsCounts, null);
      // No version offered at all.
      const none = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(none, withCounts(3), AT);
      stampRelease(none, 'v1.0.0', AT, { standardsCounts: COUNTS });
      assert.equal('standardsCounts' in none.requirementTrace![0].releases[0], false);
    });

    it('a row recorded before the counts existed stamps the version with no counts, and the row says null', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, [{ command: standardsGateCommand(3), exitCode: 0, timedOut: false }, ...pass], AT);
      stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true });
      assert.equal(plan.requirementTrace![0].releases[0].standardsVersion, 3);
      assert.equal('standardsCounts' in plan.requirementTrace![0].releases[0], false);
      assert.equal(row(plan, 'R-1').standardsCounts, null);
    });
  });

  // The status row is what the hosted trace and `moag trace` send: a standards row that only
  // said "exit 0" there read as a pass, and could not say "no blocking rules configured".
  describe('the status row carries what the standards row means, not just its exit code', () => {
    const NONE = { advisoryFindings: 1, notCheckedRules: 0, notCheckedFiles: 2, noBlockingRules: true as const };
    const SOME = { advisoryFindings: 4, notCheckedRules: 2, notCheckedFiles: 7 };
    const gatesOf = (gates: Parameters<typeof recordGateResults>[1]) => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, gates, AT);
      return { plan, gates: row(plan, 'R-1').gates };
    };

    it('a profile with no blocking set: the row says "no blocking rules configured" and carries its counts', () => {
      const { plan, gates } = gatesOf([{ command: standardsGateCommand(3), exitCode: 0, timedOut: false, standardsCounts: NONE }, ...pass]);
      assert.deepEqual(gates, [
        { command: 'moag:standards v3', exitCode: 0, standards: 'no blocking rules configured', standardsCounts: NONE },
        { command: 'npm test', exitCode: 0 },
      ]);
      assert.notEqual(gates[0].standardsCounts, plan.requirementTrace![0].gates[0].standardsCounts, 'a copy: the plan is not handed out');
    });

    it('a blocking set that was evaluated says "nothing blocking"; a row recorded without counts says so too, and has no counts key', () => {
      assert.deepEqual(gatesOf([{ command: standardsGateCommand(3), exitCode: 0, timedOut: false, standardsCounts: SOME }]).gates,
        [{ command: 'moag:standards v3', exitCode: 0, standards: 'nothing blocking', standardsCounts: SOME }]);
      assert.deepEqual(gatesOf([{ command: standardsGateCommand(null), exitCode: 0, timedOut: false }]).gates,
        [{ command: 'moag:standards', exitCode: 0, standards: 'nothing blocking' }]);
    });

    it('a standards row that stopped the release says "stopped" — whatever counts it carries, and when it timed out', () => {
      assert.deepEqual(gatesOf([{ command: standardsGateCommand(3), exitCode: 1, timedOut: false }, ...pass]).gates[0],
        { command: 'moag:standards v3', exitCode: 1, standards: 'stopped' });
      assert.equal(gatesOf([{ command: standardsGateCommand(3), exitCode: 1, timedOut: false, standardsCounts: NONE }]).gates[0].standards, 'stopped');
      assert.equal(gatesOf([{ command: standardsGateCommand(3), exitCode: 0, timedOut: true, standardsCounts: NONE }]).gates[0].standards, 'stopped');
    });

    it('a real command never gets either key — not even one that mentions the name or was recorded with counts', () => {
      const { gates } = gatesOf([
        { command: 'npm test', exitCode: 0, timedOut: false, standardsCounts: NONE },
        { command: 'echo moag:standards v3', exitCode: 0, timedOut: false, standardsCounts: NONE },
      ]);
      assert.deepEqual(gates, [{ command: 'npm test', exitCode: 0 }, { command: 'echo moag:standards v3', exitCode: 0 }]);
    });

    it('nothing but numbers leaves through the row: a file name smuggled into the stored counts is dropped', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, [{ command: standardsGateCommand(3), exitCode: 0, timedOut: false, standardsCounts: SOME }], AT);
      (plan.requirementTrace![0].gates[0].standardsCounts as unknown as Record<string, unknown>).file = 'src/secret.ts';
      assert.deepEqual(row(plan, 'R-1').gates[0].standardsCounts, SOME);
    });

    it('standardsGateWord: the three words, and the one for no blocking set is the one the checker exports', () => {
      assert.equal(standardsGateWord(false), 'stopped');
      assert.equal(standardsGateWord(false, NONE), 'stopped');
      assert.equal(standardsGateWord(true, NONE), NO_BLOCKING_RULES);
      assert.equal(standardsGateWord(true, SOME), 'nothing blocking');
      assert.equal(standardsGateWord(true), 'nothing blocking');
      assert.equal(standardsGateWord(true, null), 'nothing blocking');
      assert.equal(standardsGateWord(true, { ...SOME, noBlockingRules: 'yes' } as unknown as typeof NONE), 'nothing blocking', 'only the literal true');
    });

    it('standardsOpenText: counts in words, zeros left out, nothing for nothing', () => {
      assert.equal(standardsOpenText(SOME), '4 advisory findings · 2 rules not checked · 7 files not checked');
      assert.equal(standardsOpenText({ advisoryFindings: 1, notCheckedRules: 1, notCheckedFiles: 1 }), '1 advisory finding · 1 rule not checked · 1 file not checked');
      assert.equal(standardsOpenText({ advisoryFindings: 0, notCheckedRules: 0, notCheckedFiles: 0 }), '');
      assert.equal(standardsOpenText(undefined), '');
      assert.equal(standardsOpenText(null), '');
      assert.equal(standardsOpenText({ advisoryFindings: -1, notCheckedRules: 1.5, notCheckedFiles: Number.NaN }), '', 'a malformed count says nothing rather than something wrong');
    });

    it('isStandardsGateCommand is the exported pattern, and matches the exact synthetic name only', () => {
      for (const name of ['moag:standards', 'moag:standards v1', 'moag:standards v12']) {
        assert.equal(isStandardsGateCommand(name), true, name);
        assert.equal(STANDARDS_GATE_COMMAND.test(name), true, name);
      }
      for (const name of ['moag:standardsx', 'moag:standards v', 'moag:standards v1 ', ' moag:standards', 'moag:standards v1.2', 'echo moag:standards', 'moag:standards v3 && npm test', '']) {
        assert.equal(isStandardsGateCommand(name), false, JSON.stringify(name));
      }
      assert.equal(STANDARDS_GATE_COMMAND.global || STANDARDS_GATE_COMMAND.sticky, false, 'no lastIndex state between calls');
    });
  });

  // A local release happens inside a run; whether the standards were checked is read from
  // the gates the last verification recorded — the passing standards row is there only when
  // the blocking set was really evaluated.
  describe('with standardsFromGates: the version is stamped only when the last verification evaluated the blocking set', () => {
    const judged = (version: number | null) => [{ command: standardsGateCommand(version), exitCode: 0, timedOut: false }, ...pass];

    it('names the gate row the PRD loop records', () => {
      assert.equal(standardsGateCommand(3), 'moag:standards v3');
      assert.equal(standardsGateCommand(null), 'moag:standards');
    });

    it('stamps the version when the latest gates hold a passing standards row for it', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, judged(3), AT);
      assert.deepEqual(stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true }).shipped, ['R-1']);
      assert.equal(row(plan, 'R-1').standardsVersion, 3);
    });

    it('ships without a version when no standards row was recorded: every rule was not-checked, or the gate was off', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, pass, AT);
      assert.deepEqual(stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true }).shipped, ['R-1']);
      assert.equal('standardsVersion' in plan.requirementTrace![0].releases[0], false);
      assert.equal(row(plan, 'R-1').status, 'shipped');
      assert.equal(row(plan, 'R-1').standardsVersion, null);
    });

    it('a row for another version, or an unversioned one, is not this version\'s check', () => {
      for (const recorded of [2, null]) {
        const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
        recordGateResults(plan, judged(recorded), AT);
        stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true });
        assert.equal('standardsVersion' in plan.requirementTrace![0].releases[0], false, String(recorded));
      }
    });

    it('decides per requirement: one judged, one not', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed), task('t-2', ['R-2'], TaskStatus.Completed)]);
      recordGateResults(plan, judged(3), AT);
      plan.requirementTrace!.find(r => r.id === 'R-2')!.gates = pass.map(g => ({ ...g, at: AT }));
      assert.deepEqual(stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true }).shipped, ['R-1', 'R-2']);
      assert.equal(row(plan, 'R-1').standardsVersion, 3);
      assert.equal(row(plan, 'R-2').standardsVersion, null);
    });

    it('a failed standards row blocks the release altogether, like any failed gate', () => {
      const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
      recordGateResults(plan, [{ command: standardsGateCommand(3), exitCode: 1, timedOut: false }, ...pass], AT);
      assert.deepEqual(stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3, standardsFromGates: true }).shipped, []);
    });
  });

  it('a gate that failed still blocks the stamp, whatever standards version is offered', () => {
    const plan = planWith([task('t-1', ['R-1'], TaskStatus.Completed)]);
    recordGateResults(plan, fail, AT);
    assert.deepEqual(stampRelease(plan, 'v1.0.0', AT, { standardsVersion: 3 }).shipped, []);
    assert.equal(row(plan, 'R-1').standardsVersion, null);
  });
});
