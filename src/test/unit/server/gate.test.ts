import { strict as assert } from 'assert';
import { prepareGateResume, GateResumeError } from '../../../server/gate';
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
    const reset = prepareGateResume(plan, 'gate');
    assert.equal(status(plan, 'gate'), TaskStatus.Completed);
    assert.deepEqual(reset.sort(), ['announce', 'monitor', 'release']);
    for (const id of reset) { assert.equal(status(plan, id), TaskStatus.Pending); }
  });

  it('leaves an unrelated failed task, completed dependents and non-dependents untouched', () => {
    const plan = fixture();
    prepareGateResume(plan, 'gate');
    assert.equal(status(plan, 'unrelated-failed'), TaskStatus.Failed);
    assert.equal(status(plan, 'already-done'), TaskStatus.Completed);
    assert.equal(status(plan, 'build'), TaskStatus.Completed);
    assert.equal(status(plan, 'after-gate-pending'), TaskStatus.Pending);
  });

  it('throws for a non-manual task without mutating anything', () => {
    const plan = fixture();
    const before = JSON.stringify(plan);
    assert.throws(() => prepareGateResume(plan, 'release'), GateResumeError);
    assert.throws(() => prepareGateResume(plan, 'build'), /not a manual ship gate/);
    assert.equal(JSON.stringify(plan), before);
  });

  it('throws for a missing task', () => {
    assert.throws(() => prepareGateResume(fixture(), 'nope'), /not found/);
  });

  it('handles dependency cycles without looping forever', () => {
    const plan = createEmptyPlan('Cycle');
    plan.playlists[0].tasks.push(
      task('gate', TaskStatus.Failed, { type: 'manual' }),
      task('x', TaskStatus.Blocked, { dependsOn: ['gate', 'y'] }),
      task('y', TaskStatus.Blocked, { dependsOn: ['x'] }),
    );
    assert.deepEqual(prepareGateResume(plan, 'gate').sort(), ['x', 'y']);
  });
});
