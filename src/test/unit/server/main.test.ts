import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootPreconditionError, recoverAfterRestart } from '../../../server/main';
import { JobManager } from '../../../server/jobs';
import { ProjectStateStore, RunRecord } from '../../../server/project-state';
import { createEmptyPlan, createTask, dehydratePlan } from '../../../models/plan';
import { ProjectStore } from '../../../server/projects';
import { AuditLog } from '../../../server/audit';
import { StandardsStore, migrateStandards } from '../../../server/standards-store';
import { checkStandards } from '../../../standards/checker';
import { ruleSeverity, severityChangesBetween } from '../../../standards/profile';

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

  describe('migrateStandards (projects that predate project standards)', function () {
    // Detection asks git which files it tracks; on Windows each spawn is slow.
    this.timeout(30_000);

    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-migrate-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    /** Data files exactly as a build without standards wrote them. */
    function legacyDataDir(workspacePath: string): void {
      fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({
        schemaVersion: 1,
        projects: [{
          id: 'legacy-1', name: 'Legacy', workspacePath, source: { kind: 'path' }, stack: 'python', defaultEngine: 'claude',
          versionBudgetUsd: 10, createdAt: '2026-09-01T00:00:00.000Z', createdBy: 'u-po',
        }],
      }));
      fs.mkdirSync(path.join(dir, 'projects', 'legacy-1'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'projects', 'legacy-1', 'state.json'), JSON.stringify({
        schemaVersion: 1,
        plans: [{ id: 'pl-1', status: 'approved', mode: 'initial', engine: 'claude', forVersionCreatedAt: 'c1', forVersionLabel: '1.0.0', requestedBy: 'u-po', requestedAt: 'c1' }],
        runs: [{ id: 'run-1', planId: 'pl-1', status: 'completed', startedBy: 'u-rev', startedAt: 'c1', versionCreatedAt: 'c1', stack: 'python', segments: 1 }],
        versionSpend: {}, overrideLocked: {},
      }));
    }

    it('pre-change projects.json and state.json load, and the project gets a pending automatic v1 audited as system', async () => {
      const ws = path.join(dir, 'ws');
      fs.mkdirSync(path.join(ws, 'app'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'pyproject.toml'), '[project]\nname = "legacy"\n');
      fs.writeFileSync(path.join(ws, 'app', 'main.py'), 'print("hi")\n');
      legacyDataDir(ws);

      const projects = new ProjectStore(dir);
      const state = new ProjectStateStore(dir);
      assert.equal(projects.list().length, 1);
      assert.equal(state.load('legacy-1').runs[0].status, 'completed');

      const store = new StandardsStore(dir);
      const audit = new AuditLog(dir);
      const logs: string[] = [];
      assert.deepEqual(await migrateStandards(projects, store, audit, (m) => logs.push(m)), ['legacy-1']);
      assert.deepEqual(logs, []);

      const loaded = store.load('legacy-1');
      assert.equal(loaded.migrated, true);
      assert.equal(loaded.versions.length, 1);
      const v1 = loaded.versions[0];
      assert.equal(v1.status, 'pending');
      assert.equal(v1.origin, 'auto');
      assert.equal(v1.proposedBy, 'system');
      assert.equal(v1.profile.stackTemplateId, 'python');
      assert.equal(v1.profile.repoState, 'brownfield', 'detection ran over the workspace');
      assert.equal(store.effective('legacy-1'), null, 'nothing is in effect until someone decides');

      const entries = audit.query({ action: 'standards.propose' });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].actorUsername, 'system');
      assert.equal(entries[0].projectId, 'legacy-1');
      // The workspace is not a git repository, so nothing says which of the directories on
      // disk a clean clone holds: NONE is proposed, and the provenance says why. A proposal
      // promotes no rule and — with no tool configured here — brings no command either, so it
      // changes nothing about enforcement and carries no enforcement flag.
      assert.deepEqual(v1.profile.structure.requiredDirs, []);
      assert.match(v1.provenance['structure.requiredDirs'].evidence, /^no directory is proposed: /);
      assert.deepEqual(severityChangesBetween(null, v1.profile), []);
      assert.equal(v1.profile.severity, undefined);
      assert.deepEqual(v1.profile.commands, []);
      assert.deepEqual(entries[0].flags, ['auto-proposed', 'migration']);
      assert.deepEqual(entries[0].after, { version: 1, contentHash: v1.contentHash, origin: 'auto' });

      // The old state file is untouched and still loads.
      assert.equal(new ProjectStateStore(dir).load('legacy-1').plans[0].status, 'approved');
    });

    it('a migrated workspace holding build and test output: only directories git tracks are proposed, and they advise', async function () {
      // What an earlier run left behind: gitignored build output and a test report, both with
      // source-shaped files in them, beside the one directory the repository really has.
      const ws = path.join(dir, 'ws');
      const files: Record<string, string> = {
        '.gitignore': 'lib/\nplaywright-report/\n',
        'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
        'src/a.ts': 'export const a = 1;\n',
        'src/cart/__tests__/cart.test.ts': 'export {};\n',
        'lib/a.js': 'module.exports = 1;\n',
        'playwright-report/index.html': '<html></html>\n',
      };
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
        fs.writeFileSync(path.join(ws, rel), content);
      }
      try {
        for (const args of [['init', '-q', '.'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-qm', 'init']]) {
          execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
        }
      } catch (err) {
        if (/spawn EPERM/i.test((err as Error).message) || (err as NodeJS.ErrnoException).code === 'ENOENT') { this.skip(); return; }
        throw err;
      }
      legacyDataDir(ws);
      const store = new StandardsStore(dir);
      const audit = new AuditLog(dir);
      assert.deepEqual(await migrateStandards(new ProjectStore(dir), store, audit, () => undefined), ['legacy-1']);
      const v1 = store.pending('legacy-1')!;
      assert.deepEqual(v1.profile.structure.requiredDirs, ['src'], 'neither lib nor playwright-report, nor the nested test folder');
      assert.equal(ruleSeverity(v1.profile, 'structure/required-dirs'), 'advisory', 'detected, and still advisory: only the command blocks');
      assert.match(v1.provenance['structure.requiredDirs'].evidence, /^src\/.* — tracked by git$/);
      assert.doesNotMatch(JSON.stringify(v1.profile), /playwright-report/);
      assert.deepEqual(v1.profile.commands, [{ label: 'Lint', run: 'npm run lint' }]);

      // The first version changes enforcement — a command and a required directory against an
      // empty baseline — so an admin cannot accept the defaults without acknowledging that.
      assert.throws(() => store.acceptDefaults('legacy-1', { contentHash: v1.contentHash, by: 'u-admin' }), /changes what can stop a release/);
      store.acceptDefaults('legacy-1', { contentHash: v1.contentHash, by: 'u-admin', acknowledgedEnforcementHash: v1.contentHash });
      // An ordinary clean then removes the output directories: the standards still hold.
      fs.rmSync(path.join(ws, 'lib'), { recursive: true, force: true });
      fs.rmSync(path.join(ws, 'playwright-report'), { recursive: true, force: true });
      const report = checkStandards(store.effective('legacy-1')!.profile, {
        baseRef: 'HEAD', files: [], topLevel: [], goModulePath: null,
        existingDirs: v1.profile.structure.requiredDirs.filter((d) => fs.existsSync(path.join(ws, d))),
      });
      assert.equal(report.rules.find((r) => r.rule === 'structure/required-dirs')?.result, 'passed');
      assert.deepEqual(report.findings, []);

      // What the first version brings is on record, with before and after.
      const entry = audit.query({ action: 'standards.propose' })[0];
      assert.deepEqual(entry.flags, ['auto-proposed', 'migration', 'enforcement-changed', 'commands-changed']);
      assert.deepEqual(entry.after, {
        version: 1, contentHash: v1.contentHash, origin: 'auto',
        enforcementChanged: {
          comparedTo: null,
          commands: { before: [], after: [{ label: 'Lint', run: 'npm run lint' }] },
          requiredDirs: { before: [], after: ['src'] },
        },
      });
    });

    it('a migration proposal over no workspace is the built-in profile: its template directories are flagged against the empty baseline', async () => {
      // No workspace to read: the built-in profile, whose assumed directories are advisory like every scan.
      legacyDataDir(path.join(dir, 'no-such-workspace'));
      const store = new StandardsStore(dir);
      const audit = new AuditLog(dir);
      assert.deepEqual(await migrateStandards(new ProjectStore(dir), store, audit, () => undefined), ['legacy-1']);
      const v1 = store.pending('legacy-1')!;
      assert.deepEqual(severityChangesBetween(null, v1.profile), [], 'nothing is promoted and nothing needs demoting');
      assert.ok(v1.profile.structure.requiredDirs.length > 0);
      const entry = audit.query({ action: 'standards.propose' })[0];
      assert.deepEqual(entry.flags, ['auto-proposed', 'migration', 'enforcement-changed']);
      assert.deepEqual(entry.after, {
        version: 1, contentHash: v1.contentHash, origin: 'auto',
        enforcementChanged: { comparedTo: null, requiredDirs: { before: [], after: v1.profile.structure.requiredDirs } },
      });
    });

    it('a second boot proposes nothing new and writes no audit line', async () => {
      legacyDataDir(path.join(dir, 'ws'));
      const store = new StandardsStore(dir);
      const audit = new AuditLog(dir);
      assert.deepEqual(await migrateStandards(new ProjectStore(dir), store, audit, () => undefined), ['legacy-1']);
      const before = fs.readFileSync(store.filePath('legacy-1'), 'utf-8');
      assert.deepEqual(await migrateStandards(new ProjectStore(dir), new StandardsStore(dir), new AuditLog(dir), () => undefined), []);
      assert.equal(fs.readFileSync(store.filePath('legacy-1'), 'utf-8'), before);
      assert.equal(new AuditLog(dir).query({ action: 'standards.propose' }).length, 1);
    });

    it('an unreadable workspace, or a detector that throws or rejects, still yields an all-assumed proposal and never a throw', async () => {
      legacyDataDir(path.join(dir, 'no-such-workspace'));
      const store = new StandardsStore(dir);
      assert.deepEqual(await migrateStandards(new ProjectStore(dir), store, new AuditLog(dir), () => undefined), ['legacy-1']);
      const v1 = store.pending('legacy-1')!;
      assert.equal(v1.profile.repoState, 'greenfield');
      for (const tag of Object.values(v1.provenance)) { assert.equal(tag.tag, 'assumed'); }

      for (const detect of [
        () => { throw new Error('EACCES: detector exploded'); },
        () => Promise.reject(new Error('git exploded, asynchronously')),
      ]) {
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-migrate2-'));
        try {
          const store2 = new StandardsStore(dir2);
          const ids = await migrateStandards(
            { list: () => [{ id: 'p9', workspacePath: dir2, stack: 'go' }] }, store2, new AuditLog(dir2), () => undefined, { detect },
          );
          assert.deepEqual(ids, ['p9']);
          const auto = store2.pending('p9')!;
          assert.equal(auto.profile.stackTemplateId, 'go');
          for (const tag of Object.values(auto.provenance)) { assert.deepEqual(tag, { tag: 'assumed', evidence: 'go default' }); }
        } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
      }
    });

    it('a store that cannot be written is logged and skipped; boot continues with the next project', async () => {
      const store = new StandardsStore(dir);
      // p-bad: its project directory path is occupied by a FILE, so the standards file cannot be created.
      fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'projects', 'p-bad'), 'not a directory');
      const logs: string[] = [];
      const audit = { append: sinon.stub() };
      const ids = await migrateStandards(
        { list: () => [{ id: 'p-bad', workspacePath: dir, stack: 'go' }, { id: 'p-ok', workspacePath: dir, stack: 'go' }] },
        store, audit, (m) => logs.push(m),
      );
      assert.deepEqual(ids, ['p-ok']);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /standards migration p-bad/);
      assert.equal(audit.append.callCount, 1, 'only the project that was proposed for is audited');

      // A listing failure is logged too, never thrown.
      const none = await migrateStandards({ list: () => { throw new Error('projects.json unreadable'); } }, store, audit, (m) => logs.push(m));
      assert.deepEqual(none, []);
      assert.match(logs[1], /projects could not be listed/);
    });
  });
});
