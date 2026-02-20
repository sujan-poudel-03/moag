import { strict as assert } from 'assert';
import { TaskStatus, RunnerState } from '../../../models/types';

describe('TaskStatus', () => {
  it('should have 6 members', () => {
    const values = Object.values(TaskStatus);
    assert.equal(values.length, 6);
  });

  it('should have the correct string values', () => {
    assert.equal(TaskStatus.Pending, 'pending');
    assert.equal(TaskStatus.Running, 'running');
    assert.equal(TaskStatus.Paused, 'paused');
    assert.equal(TaskStatus.Completed, 'completed');
    assert.equal(TaskStatus.Failed, 'failed');
    assert.equal(TaskStatus.Skipped, 'skipped');
  });
});

describe('RunnerState', () => {
  it('should have 4 members', () => {
    const values = Object.values(RunnerState);
    assert.equal(values.length, 4);
  });

  it('should have the correct string values', () => {
    assert.equal(RunnerState.Idle, 'idle');
    assert.equal(RunnerState.Playing, 'playing');
    assert.equal(RunnerState.Paused, 'paused');
    assert.equal(RunnerState.Stopping, 'stopping');
  });
});
