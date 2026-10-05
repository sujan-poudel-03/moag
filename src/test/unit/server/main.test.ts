import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootPreconditionError, recoverAfterRestart } from '../../../server/main';
import { JobManager } from '../../../server/jobs';
import { ProjectStateStore, RunRecord } from '../../../server/project-state';
import { createEmptyPlan, createTask, dehydratePlan } from '../../../models/plan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

describe('server main', () => {
  describe('bootPreconditionError (AC3)', () => {
    const users = (roles: string[][]) => ({ list: () => roles.map((r) => ({ roles: r })) }) as never;

    it('refuses to start with zero admins and no bootstrap token', () => {
      assert.match(bootPreconditionError(users([]), { bootstrapToken: null }) ?? '', /MOAG_BOOTSTRAP_TOKEN/);
      assert.match(bootPreconditionError(users([['reviewer']]), { bootstrapToken: null }) ?? '', /No admin/);
    });

    it('starts with a bootstrap token, or once an admin exists', () => {
      assert.equal(bootPreconditionError(users([]), { bootstrapToken: 'x'.repeat(24) }), null);
      assert.equal(bootPreconditionError(users([['admin']]), { bootstrapToken: null }), null);
    });
  });

  describe('spawnRunWorker', () => {
    it('spawns node with array args, no shell, cwd = workspace, the built env and an IPC channel', () => {
      const spawn = sinon.stub().returns({});
      const execSync = sinon.stub();
      const mod = proxyquire('../../../server/main', { child_process: { spawn, execSync } });
      const env = { PATH: '/bin', MOAG_CONFIG_PATH: '/data/c.json' };
      mod.spawnRunWorker({ jobPath: '/data/projects/p/runs/r/job.json', workspace: '/ws/acme', env });
      assert.equal(spawn.calledOnce, true);
      const [cmd, args, opts] = spawn.firstCall.args;
      assert.equal(cmd, process.execPath);
      assert.equal(args.length, 2);
      assert.match(args[0], /run-worker\.js$/);
      assert.equal(args[1], '/data/projects/p/runs/r/job.json');
      assert.equal(opts.shell, false);
      assert.equal(opts.cwd, '/ws/acme');
      assert.equal(opts.env, env);
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.detached, true, 'detached on every platform, Windows included, so a server crash cannot kill the worker under its agent');
      assert.equal(execSync.called, false);
    });
  });

  describe('recoverAfterRestart (boot recovery vs. a live predecessor worker)', () => {
    let dataDir: string;
    beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-boot-')); });
    afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

    const running = (id: string): RunRecord => ({ id, planId: 'pl', status: 'running', startedBy: 'u', startedAt: 'x', versionCreatedAt: 'v', stack: 'go', segments: 1 });

    it('defers recovery of a project whose job.lock names a live worker, and runs it once that worker exits', async () => {
      const alive = new Set<number>([7777]);
      let tick: (() => void) | null = null;
      const jobs = new JobManager({
        dataDir, spawnWorker: () => { throw new Error('unused'); }, maxConcurrent: 1, runsDisabledReason: null,
        killProcess: () => undefined, isPidAlive: (pid) => alive.has(pid),
      });
      const realWatch = jobs.watchHeldLocks.bind(jobs);
      jobs.watchHeldLocks = (ids, cb) => realWatch(ids, cb, { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => undefined });
      const state = new ProjectStateStore(dataDir);

      // p-held: the crashed server's worker (7777) is still running and still writing its snapshot.
      const canonical = createEmptyPlan('X');
      const t = createTask('a', 'p'); t.id = 'a'; canonical.playlists[0].tasks.push(t);
      state.saveCanonicalPlan('p-held', canonical);
      state.update('p-held', (st) => { st.runs.push(running('r1')); });
      fs.mkdirSync(path.dirname(jobs.lockPath('p-held')), { recursive: true });
      fs.writeFileSync(jobs.lockPath('p-held'), JSON.stringify({ serverPid: 5555, workerPid: 7777 }));
      // p-free: same crash, but its worker is gone.
      state.update('p-free', (st) => { st.runs.push(running('r2')); });
      fs.mkdirSync(path.dirname(jobs.lockPath('p-free')), { recursive: true });
      fs.writeFileSync(jobs.lockPath('p-free'), JSON.stringify({ serverPid: 5555, workerPid: 6666 }));

      const logs: string[] = [];
      const r = recoverAfterRestart(['p-held', 'p-free'], jobs, state, (m) => logs.push(m));
      assert.deepEqual(r.reclaimed, ['p-free']);
      assert.deepEqual(r.held, ['p-held']);
      assert.equal(r.recovered, 1);
      assert.equal(state.load('p-free').runs[0].status, 'interrupted');
      assert.equal(state.load('p-held').runs[0].status, 'running', 'not marked interrupted while its worker lives');
      assert.ok(fs.existsSync(jobs.lockPath('p-held')));

      // The live worker finishes its task and writes the final snapshot before exiting.
      const snap = createEmptyPlan('X');
      const done = createTask('a', 'p'); done.id = 'a'; done.status = 'completed' as typeof done.status; snap.playlists[0].tasks.push(done);
      fs.mkdirSync(state.runDir('p-held', 'r1'), { recursive: true });
      fs.writeFileSync(path.join(state.runDir('p-held', 'r1'), 'plan.json'), JSON.stringify(dehydratePlan(snap)));

      tick!();
      await state.withProjectLock('p-held', () => undefined);
      assert.equal(state.load('p-held').runs[0].status, 'running', 'still alive at this poll');

      alive.delete(7777);
      tick!();
      await state.withProjectLock('p-held', () => undefined);
      assert.equal(state.load('p-held').runs[0].status, 'interrupted', 'recovered after the worker exited');
      assert.equal(state.loadCanonicalPlan('p-held', 'X').playlists[0].tasks[0].status, 'completed', 'the FINAL snapshot was merged');
      assert.equal(fs.existsSync(jobs.lockPath('p-held')), false, 'its stale lock was reclaimed');
      assert.ok(logs.some((m) => m.includes('recovery deferred')));
      r.stopWatching();
    });

    it('with no held lock recovers everything at once and watches nothing', () => {
      const jobs = { reclaimStaleLocks: () => [] as string[], isLockHeld: () => false, watchHeldLocks: () => { throw new Error('must not watch'); } };
      const state = new ProjectStateStore(dataDir);
      state.update('p1', (st) => { st.runs.push(running('r1')); });
      const r = recoverAfterRestart(['p1'], jobs, state, () => undefined);
      assert.deepEqual([r.recovered, r.held], [1, []]);
      assert.equal(state.load('p1').runs[0].status, 'interrupted');
    });
  });
});
