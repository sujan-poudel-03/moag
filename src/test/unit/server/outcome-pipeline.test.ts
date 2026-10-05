// ─── Stack evidence, end to end through the real producer path ───
//
// runJob (worker side, fake runner replaying the runner's ACTUAL event
// sequence) → JSONL on a fake worker's stdout → JobManager → onTaskOutcome →
// OutcomeStore → outcomes.jsonl. Proves skipped, blocked and stop-aborted tasks
// never become "completed"/"failed" evidence for an engine × stack.

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runJob, WorkerDeps, RunnerLike } from '../../../server/run-worker';
import { JobManager, WorkerProcess } from '../../../server/jobs';
import { OutcomeStore, OUTCOMES_FILE } from '../../../server/outcomes';
import { RunJob } from '../../../server/worker-protocol';

interface T { id: string; name: string; status: string; dependsOn?: string[] }

/** A fake worker process whose IPC `send` reaches the worker's stop handler. */
class PipeProc extends EventEmitter implements WorkerProcess {
  pid = 31337;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  onIpc: ((m: unknown) => void) | null = null;
  send(m: unknown): boolean { this.onIpc?.(m); return true; }
}

class ScriptedRunner implements RunnerLike {
  ee = new EventEmitter();
  constructor(private readonly script: (r: ScriptedRunner) => Promise<void>) {}
  on(ev: string, fn: (...a: never[]) => void): void { this.ee.on(ev, fn as (...a: unknown[]) => void); }
  off(ev: string, fn: (...a: never[]) => void): void { this.ee.off(ev, fn as (...a: unknown[]) => void); }
  emit(ev: string, ...a: unknown[]): void { this.ee.emit(ev, ...a); }
  async play(): Promise<void> { await this.script(this); }
  stop(): void { /* the in-flight task's abort is scripted below */ }
}

describe('stack evidence pipeline (worker → JobManager → outcomes.jsonl)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-outcomes-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a dependency-skip chain plus a user stop records 1 failed and 0 completed', async () => {
    // Sequential playlist: t1 fails; t2..t5 depend on it and are SKIPPED (the runner
    // reports those with task-completed); t6 is independent and is in flight when
    // the user presses Stop, so it fails as aborted.
    const tasks: T[] = [
      { id: 't1', name: 'one', status: 'pending' },
      ...['t2', 't3', 't4', 't5'].map((id, i) => ({ id, name: id, status: 'pending', dependsOn: [i === 0 ? 't1' : `t${i + 1}`] })),
      { id: 't6', name: 'six', status: 'pending' },
    ];
    const playlist = { tasks };
    const plan = { defaultEngine: 'ollama', playlists: [playlist] };

    const store = new OutcomeStore(dir);
    let proc!: PipeProc;
    const jobs = new JobManager({
      dataDir: dir,
      spawnWorker: () => { proc = new PipeProc(); return proc; },
      maxConcurrent: 1,
      runsDisabledReason: null,
      killProcess: () => { /* not reached */ },
      onTaskOutcome: (o) => store.append({
        kind: 'task', ts: new Date().toISOString(), projectId: o.projectId, runId: 'r1', stack: 'node-ts',
        engine: 'ollama', taskType: 'agent', status: o.status,
      }),
    });
    const job: RunJob = { kind: 'run', runId: 'r1', workspace: dir, planPath: path.join(dir, 'plan.json'), startPlaylistIndex: 0, verify: true, allowedEngines: ['ollama'] };
    const started = jobs.start({ projectId: 'p1', job, jobPath: path.join(dir, 'job.json'), workspace: dir, env: {} });
    assert.equal(started.ok, true);

    const runner = new ScriptedRunner(async (r) => {
      const [t1, t2, t3, t4, t5, t6] = tasks;
      r.emit('task-started', t1, playlist, 'prompt');
      t1.status = 'failed';
      r.emit('task-failed', t1, { stdout: '', stderr: 'tests failed', exitCode: 1, durationMs: 10 });
      for (const t of [t2, t3, t4, t5]) {
        t.status = 'skipped';
        r.emit('task-output', t, `[Skipped] "${t.name}" - dependency not met\n`, 'stderr');
        r.emit('task-completed', t, { stdout: '', stderr: 'Skipped: dependency not met', exitCode: 0, durationMs: 0 });
      }
      r.emit('task-started', t6, playlist, 'prompt');
      jobs.stop('p1'); // the user presses Stop: IPC reaches the worker's stop handler
      t6.status = 'failed';
      r.emit('task-failed', t6, { stdout: '', stderr: 'aborted', exitCode: 1, durationMs: 5 });
    });

    const deps: WorkerDeps = {
      runner,
      loadPlan: () => plan,
      savePlanAtomic: () => { /* snapshot persistence is not under test */ },
      getEngine: () => ({ runTask: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }) }),
      generateDeltaPlan: async () => ({ kind: 'no-delta' }),
      checkAvailability: async () => [],
      costLedger: { onRecord: () => () => { /* none */ } },
      runVerifyCore: async () => 0,
      emit: (o) => proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n')),
      onStop: (cb) => {
        proc.onIpc = (m) => { if ((m as { type?: string }).type === 'stop') { cb(); } };
        return () => { proc.onIpc = null; };
      },
      env: {},
      validateRoutingConfig: () => ({ dropped: [] }),
      withSyntheticBaseline: (p) => p,
      dehydratePlaylist: (_p, pl) => pl,
    };
    const code = await runJob(job, deps);
    proc.emit('close', code);

    const lines = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.status === 'failed').length, 1);
    assert.equal(lines.filter((l) => l.status === 'completed').length, 0);
    assert.equal(lines.length, 1);
  });
});
