// ─── Headless task reporting: task-changes and task-error-tail lines ───

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reportingSecretValues, wireTaskReporting } from '../../../headless/task-reporting';
import type { TaskChangesPayload, TaskSettledInfo } from '../../../runner/task-changes';
import { TaskStatus } from '../../../models/types';
import { createRedactor, Redactor } from '../../../utils/redact';

type Hook = (info: TaskSettledInfo, signal: AbortSignal) => Promise<void>;

/** An EventEmitter runner that keeps the settled hook it is given. */
class FakeRunner extends EventEmitter {
  hook: Hook | null = null;
  setTaskSettledHook(fn: Hook | null): void { this.hook = fn; }
}

const SECRET = 'sk-ant-api03-' + 'Z'.repeat(40);

function payload(taskId: string): TaskChangesPayload {
  return {
    task_id: taskId, status: 'completed', source: 'worktree', base_sha: 'a'.repeat(40), commit_sha: null, branch: 'main',
    files: [{ path: 'a.ts', status: 'modified', binary: false, added: 1, removed: 0 }],
    diff: { text: '+x', truncated: false, bytes: 2, redactions: 0 },
  };
}

function info(taskId: string, status: TaskStatus): TaskSettledInfo {
  return { taskId, status, cwd: '/w', snapshotRef: null, headRef: null, untrackedAtStart: [], commit: null };
}

function setup(opts: { makeRedactor?: () => Redactor; collect?: (i: TaskSettledInfo, r: Redactor) => Promise<TaskChangesPayload | null> } = {}) {
  const runner = new FakeRunner();
  const lines: Array<Record<string, unknown>> = [];
  const redactorsSeen: Redactor[] = [];
  // The CLI's own listener comes first, like wireEvents().
  runner.on('task-completed', (t: { id: string }) => lines.push({ event: 'task-completed', id: t.id }));
  runner.on('task-failed', (t: { id: string }) => lines.push({ event: 'task-failed', id: t.id }));
  const unwire = wireTaskReporting(runner, {
    cwd: '/w',
    emit: (l) => lines.push(l),
    makeRedactor: opts.makeRedactor ?? (() => createRedactor([])),
    collect: async (i, r) => { redactorsSeen.push(r); return opts.collect ? opts.collect(i, r) : payload(i.taskId); },
  });
  return { runner, lines, unwire, redactorsSeen };
}

describe('headless task reporting', () => {
  it('emits task-changes right after task-completed', async () => {
    const { runner, lines } = setup();
    assert.ok(runner.hook);
    await runner.hook(info('t1', TaskStatus.Completed), new AbortController().signal);
    runner.emit('task-completed', { id: 't1' }, { stdout: '', stderr: '' });
    assert.deepEqual(lines.map((l) => l.event), ['task-completed', 'task-changes']);
    assert.deepEqual(lines[1], { event: 'task-changes', ...payload('t1') });
  });

  it('emits task-changes then a redacted task-error-tail after task-failed', async () => {
    const { runner, lines } = setup();
    await runner!.hook!(info('t1', TaskStatus.Failed), new AbortController().signal);
    runner.emit('task-failed', { id: 't1' }, { stdout: '', stderr: `boom ${SECRET} end` });
    assert.deepEqual(lines.map((l) => l.event), ['task-failed', 'task-changes', 'task-error-tail']);
    const tail = lines[2].tail as string;
    assert.ok(!tail.includes(SECRET));
    assert.ok(tail.includes('[REDACTED]'));
    assert.equal(lines[2].id, 't1');
  });

  it('redacts before slicing to 2000 characters', async () => {
    const { runner, lines } = setup();
    // A secret straddling the 2000-char cut must not survive as a fragment the patterns miss.
    const raw = SECRET + 'y'.repeat(2000 - 10);
    runner.emit('task-failed', { id: 't1' }, { stderr: raw });
    const tail = lines.find((l) => l.event === 'task-error-tail')?.tail as string;
    assert.ok(tail.length <= 2000);
    assert.ok(!tail.includes('Z'.repeat(10)));
  });

  it('falls back to stdout for the tail when stderr is empty', () => {
    const { runner, lines } = setup();
    runner.emit('task-failed', { id: 't1' }, { stderr: '', stdout: 'out text' });
    assert.equal(lines.find((l) => l.event === 'task-error-tail')?.tail, 'out text');
  });

  it('never runs collect for a Blocked or Skipped task, and emits no task-changes for it', async () => {
    let calls = 0;
    const { runner, lines } = setup({ collect: async (i) => { calls++; return payload(i.taskId); } });
    await runner.hook!(info('b', TaskStatus.Blocked), new AbortController().signal);
    await runner.hook!(info('s', TaskStatus.Skipped), new AbortController().signal);
    runner.emit('task-failed', { id: 'b' }, { stderr: '' });
    runner.emit('task-completed', { id: 's' }, { stderr: '' });
    assert.equal(calls, 0);
    assert.ok(!lines.some((l) => l.event === 'task-changes'));
  });

  it('a task-completed without a collected payload adds nothing', () => {
    const { runner, lines } = setup();
    runner.emit('task-completed', { id: 'never-started' }, {});
    assert.deepEqual(lines.map((l) => l.event), ['task-completed']);
  });

  it('a throwing redactor: task-changes still goes out (via a failing redactor), no task-error-tail', async () => {
    const { runner, lines, redactorsSeen } = setup({
      makeRedactor: () => { throw new Error('env unreadable'); },
      collect: async (i, r) => {
        try { r.redact('x'); } catch { return { ...payload(i.taskId), diff: null, diff_error: 'redaction failed' }; }
        return payload(i.taskId);
      },
    });
    await runner.hook!(info('t1', TaskStatus.Failed), new AbortController().signal);
    runner.emit('task-failed', { id: 't1' }, { stderr: `boom ${SECRET}` });
    assert.equal(redactorsSeen.length, 1);
    assert.throws(() => redactorsSeen[0].redact('x'));
    assert.deepEqual(lines.map((l) => l.event), ['task-failed', 'task-changes']);
    assert.equal(lines[1].diff, null);
    assert.equal(lines[1].diff_error, 'redaction failed');
    assert.ok(!JSON.stringify(lines).includes(SECRET));
  });

  it('an empty tail emits nothing', () => {
    const { runner, lines } = setup();
    runner.emit('task-failed', { id: 't1' }, { stderr: '', stdout: '' });
    runner.emit('task-failed', { id: 't2' });
    assert.ok(!lines.some((l) => l.event === 'task-error-tail'));
  });

  it('a payload collected after the hook was aborted is dropped', async () => {
    const ac = new AbortController();
    const { runner, lines } = setup({ collect: async (i) => { ac.abort(); return payload(i.taskId); } });
    await runner.hook!(info('t1', TaskStatus.Completed), ac.signal);
    runner.emit('task-completed', { id: 't1' }, {});
    assert.ok(!lines.some((l) => l.event === 'task-changes'));
  });

  it('unwire clears the hook and removes both listeners', () => {
    const { runner, lines, unwire } = setup();
    unwire();
    assert.equal(runner.hook, null);
    runner.emit('task-failed', { id: 't1' }, { stderr: 'boom' });
    assert.deepEqual(lines.map((l) => l.event), ['task-failed']);
  });

  it('works with a runner that has no hook setter and no off()', () => {
    const lines: Array<Record<string, unknown>> = [];
    const listeners: Array<[string, unknown]> = [];
    const unwire = wireTaskReporting({ on: (e, fn) => listeners.push([e, fn]) }, {
      cwd: '/w', emit: (l) => lines.push(l), makeRedactor: () => createRedactor([]),
    });
    assert.equal(listeners.length, 2);
    unwire();
  });
});

describe('headless task reporting — secret values', () => {
  it('combines .env secrets, keyed engine env values and extras', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-tr-'));
    fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=supersecret99\nPORT=3000\n');
    const values = reportingSecretValues(dir, { ANTHROPIC_API_KEY: 'anthropic-key-value', OTHER: 'not-included-value' }, ['device-key-1234']);
    assert.deepEqual(values, ['supersecret99', 'anthropic-key-value', 'device-key-1234']);
  });
});
