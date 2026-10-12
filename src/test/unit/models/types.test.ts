import { strict as assert } from 'assert';
import {
  TaskStatus, RunnerState, DEPENDENCY_ECOSYSTEMS, DEPENDENCY_EVENT_NAMES, DEPENDENCY_STAGES, DEPENDENCY_TRIGGERS,
} from '../../../models/types';

describe('dependency-install enumerations are closed', () => {
  it('pins the ecosystems', () => {
    assert.deepEqual([...DEPENDENCY_ECOSYSTEMS], ['npm', 'pnpm', 'yarn', 'python', 'go', 'dotnet', 'maven', 'gradle', 'cargo']);
  });
  it('pins the event names', () => {
    assert.deepEqual([...DEPENDENCY_EVENT_NAMES], ['dependencies-installed', 'dependencies-install-failed', 'dependencies-not-installed']);
  });
  it('pins the stages', () => {
    assert.deepEqual([...DEPENDENCY_STAGES], ['task', 'verify', 'standards', 'bench']);
  });
  it('pins the triggers', () => {
    assert.deepEqual([...DEPENDENCY_TRIGGERS], ['manifest-changed', 'install-dir-missing', 'first-seen']);
  });
});

describe('TaskStatus', () => {
  it('should have 7 members', () => {
    const values = Object.values(TaskStatus);
    assert.equal(values.length, 7);
  });

  it('should have the correct string values', () => {
    assert.equal(TaskStatus.Pending, 'pending');
    assert.equal(TaskStatus.Running, 'running');
    assert.equal(TaskStatus.Paused, 'paused');
    assert.equal(TaskStatus.Completed, 'completed');
    assert.equal(TaskStatus.Failed, 'failed');
    assert.equal(TaskStatus.Skipped, 'skipped');
    assert.equal(TaskStatus.Blocked, 'blocked');
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
