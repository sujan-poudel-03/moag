import { strict as assert } from 'assert';
import { prepareGateResume, GateResumeError, stampApprovedShip } from '../../../server/gate';
import { recordGateResults } from '../../../models/requirement-trace';
import { createEmptyPlan, createPlaylist, createTask } from '../../../models/plan';
import { Plan, Task, TaskStatus } from '../../../models/types';

function task(id: string, status: TaskStatus, over: Partial<Task> = {}): Task {
  return { ...createTask(id, id), id, status, ...over };
}

function fixture(): Plan {
  const plan = createEmptyPlan('Gate');
  plan.playlists[0].tasks.push(
    task('build', TaskStatus.Completed),
    task('unrelated-failed', TaskStatus.Failed),
    task('gate', TaskStatus.Failed, { type: 'manual' }),
    task('release', TaskStatus.Blocked, { type: 'release', dependsOn: ['gate'] }),
    task('announce', TaskStatus.Skipped, { dependsOn: ['release'] }),
    task('after-gate-pending', TaskStatus.Pending, { dependsOn: ['gate'] }),
  );
  const pl2 = createPlaylist('Ops');
  pl2.tasks.push(
    task('monitor', TaskStatus.Failed, { type: 'monitor', dependsOn: ['announce'] }),
    task('already-done', TaskStatus.Completed, { dependsOn: ['gate'] }),
  );
  plan.playlists.push(pl2);
  return plan;
}

const status = (plan: Plan, id: string) => plan.playlists.flatMap((p) => p.tasks).find((t) => t.id === id)?.status;

describe('prepareGateResume', () => {
  it('completes the gate and resets transitive dependents across playlists', () => {
    const plan = fixture();
    const { reset, skipped } = prepareGateResume(plan, 'gate', 'approve');
    assert.deepEqual(skipped, []);
    assert.equal(status(plan, 'gate'), TaskStatus.Completed);
    assert.deepEqual(reset.sort(), ['announce', 'monitor', 'release']);
    for (const id of reset) { assert.equal(status(plan, id), TaskStatus.Pending); }
  });

  it('leaves an unrelated failed task, completed dependents and non-dependents untouched', () => {
    const plan = fixture();
    prepareGateResume(plan, 'gate', 'approve');
    assert.equal(status(plan, 'unrelated-failed'), TaskStatus.Failed);
    assert.equal(status(plan, 'already-done'), TaskStatus.Completed);
    assert.equal(status(plan, 'build'), TaskStatus.Completed);
    assert.equal(status(plan, 'after-gate-pending'), TaskStatus.Pending);
  });

  it('throws for a non-manual task without mutating anything', () => {
    const plan = fixture();
    const before = JSON.stringify(plan);
    assert.throws(() => prepareGateResume(plan, 'release', 'approve'), GateResumeError);
    assert.throws(() => prepareGateResume(plan, 'build', 'skip'), /not a manual ship gate/);
    assert.equal(JSON.stringify(plan), before);
  });

  it('throws for a missing task', () => {
    assert.throws(() => prepareGateResume(fixture(), 'nope', 'approve'), /not found/);
  });

  it('handles dependency cycles without looping forever', () => {
    const plan = createEmptyPlan('Cycle');
    plan.playlists[0].tasks.push(
      task('gate', TaskStatus.Failed, { type: 'manual' }),
      task('x', TaskStatus.Blocked, { dependsOn: ['gate', 'y'] }),
      task('y', TaskStatus.Blocked, { dependsOn: ['x'] }),
    );
    assert.deepEqual(prepareGateResume(plan, 'gate', 'approve').reset.sort(), ['x', 'y']);
  });

  it('a skip never ships: release/deploy work downstream of the gate becomes Skipped, not Pending', () => {
    const plan = fixture();
    plan.playlists[0].tasks.push(task('deploy', TaskStatus.Blocked, { type: 'deploy', dependsOn: ['gate'] }));
    const { reset, skipped } = prepareGateResume(plan, 'gate', 'skip');
    assert.equal(status(plan, 'gate'), TaskStatus.Completed);
    // release, deploy and everything downstream of either (across playlists) never run.
    assert.deepEqual(skipped.sort(), ['announce', 'deploy', 'monitor', 'release']);
    for (const id of skipped) { assert.equal(status(plan, id), TaskStatus.Skipped); }
    assert.deepEqual(reset, [], 'no shipping task is reset to Pending');
    // Non-shipping dependents and completed work are untouched.
    assert.equal(status(plan, 'after-gate-pending'), TaskStatus.Pending);
    assert.equal(status(plan, 'already-done'), TaskStatus.Completed);
    assert.equal(status(plan, 'unrelated-failed'), TaskStatus.Failed);
  });

  it('a skip still resets halted non-shipping dependents, and leaves a release outside the gate closure alone', () => {
    const plan = createEmptyPlan('Skip');
    plan.playlists[0].tasks.push(
      task('gate', TaskStatus.Failed, { type: 'manual' }),
      task('verify-notes', TaskStatus.Blocked, { dependsOn: ['gate'] }),
      task('rel', TaskStatus.Blocked, { type: 'release', dependsOn: ['gate'] }),
      task('other-rel', TaskStatus.Failed, { type: 'release' }),
    );
    const { reset, skipped } = prepareGateResume(plan, 'gate', 'skip');
    assert.deepEqual(reset, ['verify-notes']);
    assert.deepEqual(skipped, ['rel']);
    assert.equal(status(plan, 'other-rel'), TaskStatus.Failed, 'not downstream of the gate: untouched');
  });
});

describe('stampApprovedShip', () => {
  const AT = '2026-10-04T00:00:00.000Z';
  function shipPlan(releaseStatus: TaskStatus | null, deployStatus: TaskStatus | null = null): Plan {
    const plan = createEmptyPlan('Ship');
    plan.prdVersions = [{ version: '1.0.0', text: '## Requirements\n- [R-1] login\n', createdAt: AT }];
    plan.playlists[0].tasks.push(
      task('impl', TaskStatus.Completed, { requirementIds: ['R-1'] }),
      task('ship', TaskStatus.Completed, { type: 'manual', dependsOn: ['impl'], requirementIds: ['R-1'] }),
    );
    if (releaseStatus !== null) {
      plan.playlists[0].tasks.push(task('rel', releaseStatus, { type: 'release', dependsOn: ['ship'], command: 'npm run release' }));
    }
    if (deployStatus !== null) {
      const deps = releaseStatus !== null ? ['rel'] : ['ship'];
      plan.playlists[0].tasks.push(task('dep', deployStatus, { type: 'deploy', dependsOn: deps, command: 'npm run deploy' }));
    }
    recordGateResults(plan, [{ command: 'npm test', exitCode: 0, timedOut: false }], AT);
    return plan;
  }

  it('stamps an approved run whose release completed, and one with no release task', () => {
    assert.deepEqual(stampApprovedShip(shipPlan(TaskStatus.Completed), 'r1', AT, 0), ['R-1']);
    assert.deepEqual(stampApprovedShip(shipPlan(null), 'r1', AT, 0), ['R-1']);
  });

  for (const s of [TaskStatus.Failed, TaskStatus.Skipped, TaskStatus.Blocked, TaskStatus.Pending]) {
    it(`never stamps while the run's release is ${s}, even with green gates and a completed gate`, () => {
      const plan = shipPlan(s);
      assert.deepEqual(stampApprovedShip(plan, 'r1', AT, 0), []);
      assert.equal((plan.requirementTrace ?? []).every((r) => r.releases.length === 0), true);
    });
  }

  for (const s of [TaskStatus.Failed, TaskStatus.Skipped, TaskStatus.Blocked, TaskStatus.Pending]) {
    it(`never stamps while the run's deploy is ${s}, even with the release Completed`, () => {
      const plan = shipPlan(TaskStatus.Completed, s);
      assert.deepEqual(stampApprovedShip(plan, 'r1', AT, 0), []);
      assert.equal((plan.requirementTrace ?? []).every((r) => r.releases.length === 0), true, 'no release stamped');
    });
  }

  it('stamps when the only shipping task is a Completed deploy', () => {
    assert.deepEqual(stampApprovedShip(shipPlan(null, TaskStatus.Completed), 'r1', AT, 0), ['R-1']);
  });

  it('a failed deploy in a different playlist does not block when an index is given', () => {
    const plan = shipPlan(TaskStatus.Completed, TaskStatus.Completed);
    const other = createPlaylist('Other');
    other.tasks.push(task('other-dep', TaskStatus.Failed, { type: 'deploy', command: 'x' }));
    plan.playlists.push(other);
    assert.deepEqual(stampApprovedShip(plan, 'r1', AT, 0), ['R-1']);
    assert.deepEqual(stampApprovedShip(plan, 'r1', AT), [], 'whole plan: the other playlist\'s failed deploy blocks');
  });

  it('checks only the run\'s playlist when an index is given, every playlist otherwise', () => {
    const plan = shipPlan(TaskStatus.Completed);
    const old = createPlaylist('Old');
    old.tasks.push(task('old-rel', TaskStatus.Failed, { type: 'release', command: 'x' }));
    plan.playlists.unshift(old);
    assert.deepEqual(stampApprovedShip(plan, 'r1', AT), [], 'whole plan: the old failed release blocks');
    assert.deepEqual(stampApprovedShip(plan, 'r1', AT, 1), ['R-1']);
  });
});
