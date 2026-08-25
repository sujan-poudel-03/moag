import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateId, loadPlan, savePlan, createEmptyPlan, createPlaylist, createTask,
  hydratePlan, dehydratePlan, appendPrdVersion, MAX_PRD_VERSIONS, MAX_PRD_VERSIONS_CHARS,
} from '../../../models/plan';
import { TaskStatus, PlanFile, PrdVersion } from '../../../models/types';

describe('generateId', () => {
  it('should return a non-empty string', () => {
    const id = generateId();
    assert.ok(id.length > 0);
  });

  it('should return unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    assert.equal(ids.size, 100);
  });

  it('should return alphanumeric strings', () => {
    const id = generateId();
    assert.match(id, /^[a-z0-9]+$/);
  });
});

describe('createEmptyPlan', () => {
  it('should create a plan with the given name', () => {
    const plan = createEmptyPlan('Test Plan');
    assert.equal(plan.name, 'Test Plan');
    assert.equal(plan.version, '1.0');
    assert.equal(plan.defaultEngine, 'claude');
    assert.equal(plan.playlists.length, 1);
    assert.equal(plan.playlists[0].name, 'Tasks');
    assert.deepEqual(plan.playlists[0].tasks, []);
    assert.deepEqual(plan.validation.targets, ['all']);
    assert.equal(plan.validation.profile, 'quick');
    assert.deepEqual(plan.validation.contextBudget, {
      discoveryTokens: 12000,
      analysisTokens: 24000,
      fixTokens: 16000,
    });
  });
});

describe('createPlaylist', () => {
  it('should create a playlist with the given name', () => {
    const pl = createPlaylist('Setup');
    assert.equal(pl.name, 'Setup');
    assert.equal(pl.autoplay, true);
    assert.deepEqual(pl.tasks, []);
    assert.ok(pl.id.length > 0);
  });

  it('should accept an optional engine', () => {
    const pl = createPlaylist('Build', 'codex');
    assert.equal(pl.engine, 'codex');
  });

  it('should leave engine undefined when not provided', () => {
    const pl = createPlaylist('Build');
    assert.equal(pl.engine, undefined);
  });
});

describe('createTask', () => {
  it('should create a task with Pending status', () => {
    const task = createTask('Init', 'Set up the project');
    assert.equal(task.name, 'Init');
    assert.equal(task.prompt, 'Set up the project');
    assert.equal(task.type, 'agent');
    assert.equal(task.status, TaskStatus.Pending);
    assert.ok(task.id.length > 0);
  });

  it('should accept an optional engine', () => {
    const task = createTask('Init', 'Set up', 'gemini');
    assert.equal(task.engine, 'gemini');
  });
});

describe('loadPlan / savePlan round-trip', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-test-'));
    tmpFile = path.join(tmpDir, 'test.agent-plan.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and reload a plan preserving all fields', () => {
    const plan = createEmptyPlan('Round Trip');
    plan.description = 'A test plan';
    plan.validation = {
      targets: ['web', 'mobile'],
      profile: 'pr',
      contextBudget: {
        discoveryTokens: 9000,
        analysisTokens: 18000,
        fixTokens: 12000,
      },
    };
    // Use the default playlist that createEmptyPlan provides
    const pl = plan.playlists[0];
    pl.name = 'Phase 1';
    pl.engine = 'codex';
    pl.autoplayDelay = 500;
    pl.parallel = true;
    const task = createTask('Task 1', 'Do something', 'claude');
    task.cwd = './src';
    task.type = 'service';
    task.command = 'npm run dev';
    task.env = { PORT: '3000' };
    task.files = ['a.ts', 'b.ts'];
    task.acceptanceCriteria = ['Server starts', 'Health check responds'];
    task.verifyCommand = 'npm test';
    task.expectedArtifacts = ['dist/index.js'];
    task.ownerNote = 'Needs PM review';
    task.failurePolicy = 'mark-blocked';
    task.port = 3000;
    task.readyPattern = 'listening';
    task.healthCheckUrl = 'http://localhost:3000/health';
    task.startupTimeoutMs = 45000;
    task.retryCount = 2;
    task.dependsOn = ['other-task'];
    task.validation = {
      targets: ['desktop'],
      profile: 'full',
      contextBudget: { fixTokens: 22000 },
    };
    pl.tasks.push(task);

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);

    assert.equal(loaded.name, 'Round Trip');
    assert.equal(loaded.description, 'A test plan');
    assert.equal(loaded.defaultEngine, 'claude');
    assert.equal(loaded.playlists.length, 1);
    assert.equal(loaded.playlists[0].name, 'Phase 1');
    assert.equal(loaded.playlists[0].engine, 'codex');
    assert.equal(loaded.playlists[0].autoplayDelay, 500);
    assert.equal(loaded.playlists[0].parallel, true);
    assert.equal(loaded.playlists[0].tasks.length, 1);
    assert.deepEqual(loaded.validation.targets, ['web', 'mobile']);
    assert.equal(loaded.validation.profile, 'pr');
    assert.deepEqual(loaded.validation.contextBudget, {
      discoveryTokens: 9000,
      analysisTokens: 18000,
      fixTokens: 12000,
    });

    const t = loaded.playlists[0].tasks[0];
    assert.equal(t.name, 'Task 1');
    assert.equal(t.prompt, 'Do something');
    assert.equal(t.type, 'service');
    assert.equal(t.engine, 'claude');
    assert.equal(t.command, 'npm run dev');
    assert.equal(t.cwd, './src');
    assert.deepEqual(t.env, { PORT: '3000' });
    assert.deepEqual(t.files, ['a.ts', 'b.ts']);
    assert.deepEqual(t.acceptanceCriteria, ['Server starts', 'Health check responds']);
    assert.equal(t.verifyCommand, 'npm test');
    assert.deepEqual(t.expectedArtifacts, ['dist/index.js']);
    assert.equal(t.ownerNote, 'Needs PM review');
    assert.equal(t.failurePolicy, 'mark-blocked');
    assert.equal(t.port, 3000);
    assert.equal(t.readyPattern, 'listening');
    assert.equal(t.healthCheckUrl, 'http://localhost:3000/health');
    assert.equal(t.startupTimeoutMs, 45000);
    assert.equal(t.retryCount, 2);
    assert.deepEqual(t.dependsOn, ['other-task']);
    assert.deepEqual(t.validation, {
      targets: ['desktop'],
      profile: 'full',
      contextBudget: { fixTokens: 22000 },
    });
    // Status should be hydrated back to Pending
    assert.equal(t.status, TaskStatus.Pending);
  });

  it('should persist non-pending status and strip pending status', () => {
    const plan = createEmptyPlan('Status Test');
    const completedTask = createTask('Done', 'prompt');
    completedTask.status = TaskStatus.Completed;
    const pendingTask = createTask('Todo', 'prompt');
    pendingTask.status = TaskStatus.Pending;
    plan.playlists[0].tasks.push(completedTask, pendingTask);

    savePlan(plan, tmpFile);
    const raw: PlanFile = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    // Completed status should be persisted
    assert.equal(raw.playlists[0].tasks[0].status, 'completed');
    // Pending status should be omitted (keeps file clean)
    assert.equal(raw.playlists[0].tasks[1].status, undefined);
  });

  it('should restore persisted status on load', () => {
    const plan = createEmptyPlan('Restore Test');
    const task = createTask('T', 'prompt');
    task.status = TaskStatus.Completed;
    plan.playlists[0].tasks.push(task);

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);
    assert.equal(loaded.playlists[0].tasks[0].status, TaskStatus.Completed);
  });

  it('should create parent directories when saving', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'plan.json');
    const plan = createEmptyPlan('Nested');
    savePlan(plan, nested);
    assert.ok(fs.existsSync(nested));
  });

  it('should throw on invalid JSON', () => {
    fs.writeFileSync(tmpFile, 'not json', 'utf-8');
    assert.throws(() => loadPlan(tmpFile));
  });

  it('should throw on non-existent file', () => {
    assert.throws(() => loadPlan(path.join(tmpDir, 'nope.json')));
  });

  it('should round-trip plan variables through save/load', () => {
    const plan = createEmptyPlan('Vars Test');
    plan.variables = { projectName: 'moag', env: 'staging' };
    plan.playlists[0].tasks.push(createTask('T', 'Deploy {{projectName}} to {{env}}'));

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);

    assert.deepEqual(loaded.variables, { projectName: 'moag', env: 'staging' });
    assert.equal(loaded.playlists[0].tasks[0].prompt, 'Deploy {{projectName}} to {{env}}');
  });

  it('should omit variables from file when empty', () => {
    const plan = createEmptyPlan('No Vars');
    plan.variables = {};

    savePlan(plan, tmpFile);
    const raw: PlanFile = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.equal(raw.variables, undefined);
  });

  it('should preserve variables when non-empty', () => {
    const plan = createEmptyPlan('Has Vars');
    plan.variables = { key: 'value' };

    savePlan(plan, tmpFile);
    const raw: PlanFile = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.deepEqual(raw.variables, { key: 'value' });
  });

  it('should load plan without variables field as undefined', () => {
    const plan = createEmptyPlan('No Vars Field');
    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);
    assert.equal(loaded.variables, undefined);
  });

  it('should round-trip skipIf through save/load', () => {
    const plan = createEmptyPlan('SkipIf Test');
    const task = createTask('Conditional', 'Do something');
    task.skipIf = { taskId: 'dep-1', status: TaskStatus.Completed };
    plan.playlists[0].tasks.push(task);

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);
    const t = loaded.playlists[0].tasks[0];
    assert.deepEqual(t.skipIf, { taskId: 'dep-1', status: TaskStatus.Completed });
  });

  it('should round-trip task timeoutMs through save/load', () => {
    const plan = createEmptyPlan('Timeout Test');
    const task = createTask('Long', 'Do something slow');
    task.timeoutMs = 900000;
    plan.playlists[0].tasks.push(task);

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);
    assert.equal(loaded.playlists[0].tasks[0].timeoutMs, 900000);
  });

  it('should omit task timeoutMs from the file when absent', () => {
    const plan = createEmptyPlan('No Timeout');
    plan.playlists[0].tasks.push(createTask('Plain', 'prompt'));

    savePlan(plan, tmpFile);
    const raw: PlanFile = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.ok(!('timeoutMs' in (raw.playlists[0].tasks[0] as object)));
    const loaded = loadPlan(tmpFile);
    assert.equal(loaded.playlists[0].tasks[0].timeoutMs, undefined);
  });

  it('should throw when task timeoutMs is below the 1000ms floor', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Tiny Timeout',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Task',
          prompt: 'Prompt',
          timeoutMs: 500,
        }],
      }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /tasks\[\]\.timeoutMs/);
  });

  it('should throw when task timeoutMs is a string', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'String Timeout',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Task',
          prompt: 'Prompt',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feeding a deliberately invalid value to exercise the runtime guard; the type system forbids it by design
          timeoutMs: '900000' as any,
        }],
      }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /tasks\[\]\.timeoutMs/);
  });

  it('should preserve variables through hydrate/dehydrate', () => {
    const plan = createEmptyPlan('Variables Hydrate Test');
    plan.variables = { env: 'staging', version: '2.0' };
    plan.playlists[0].tasks.push(createTask('Deploy', 'Deploy to {{env}} v{{version}}'));

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);

    assert.deepEqual(loaded.variables, { env: 'staging', version: '2.0' });
    assert.equal(loaded.playlists[0].tasks[0].prompt, 'Deploy to {{env}} v{{version}}');
  });

  it('should round-trip ship/maintain task fields (deploy/release/monitor) through save/load', () => {
    const plan = createEmptyPlan('Ship Fields Round-trip');
    const deploy = createTask('Deploy', 'deploy');
    deploy.type = 'deploy';
    deploy.command = 'npm run deploy:staging';
    deploy.inheritEnvFiles = ['.env.staging'];
    deploy.healthCheckUrl = 'http://localhost:3000/health';
    const release = createTask('Release', 'release');
    release.type = 'release';
    release.releaseTag = 'v1.2.3';
    release.releaseNotes = 'notes';
    release.githubRelease = true;
    const monitor = createTask('Monitor', 'monitor');
    monitor.type = 'monitor';
    monitor.healthCheckUrl = 'https://app/health';
    monitor.monitorSamples = 5;
    monitor.monitorIntervalMs = 1000;
    monitor.failureThreshold = 2;
    monitor.incidentRepo = 'owner/repo';
    monitor.incidentLabel = 'moag:incident';
    plan.playlists[0].tasks.push(deploy, release, monitor);

    savePlan(plan, tmpFile);
    const [d, r, m] = loadPlan(tmpFile).playlists[0].tasks;

    assert.equal(d.inheritEnvFiles?.[0], '.env.staging');
    assert.equal(r.releaseTag, 'v1.2.3');
    assert.equal(r.githubRelease, true);
    assert.equal(m.monitorSamples, 5);
    assert.equal(m.failureThreshold, 2);
    assert.equal(m.incidentRepo, 'owner/repo');
    assert.equal(m.incidentLabel, 'moag:incident');
  });

  it('should preserve skipIf through hydrate/dehydrate', () => {
    const plan = createEmptyPlan('SkipIf Hydrate Test');
    const task = createTask('Guarded', 'Run only if abc not done');
    task.skipIf = { taskId: 'abc', status: TaskStatus.Completed };
    plan.playlists[0].tasks.push(task);

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);
    const t = loaded.playlists[0].tasks[0];

    assert.deepEqual(t.skipIf, { taskId: 'abc', status: TaskStatus.Completed });
    assert.equal(t.skipIf!.taskId, 'abc');
    assert.equal(t.skipIf!.status, TaskStatus.Completed);
  });

  it('should default validation settings when omitted in file', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Legacy Plan',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Legacy Task',
          prompt: 'Do something',
        }],
      }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    const loaded = loadPlan(tmpFile);

    assert.deepEqual(loaded.validation.targets, ['all']);
    assert.equal(loaded.validation.profile, 'quick');
    assert.deepEqual(loaded.validation.contextBudget, {
      discoveryTokens: 12000,
      analysisTokens: 24000,
      fixTokens: 16000,
    });
  });

  it('should throw when plan validation profile is invalid', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Bad Profile',
      defaultEngine: 'claude',
      validation: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feeding a deliberately invalid value to exercise the runtime guard; the type system forbids it by design
        profile: 'bad-profile' as any,
      },
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Task',
          prompt: 'Prompt',
        }],
      }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /validation\.profile/i);
  });

  it('should throw when validation targets contain unsupported values', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Bad Targets',
      defaultEngine: 'claude',
      validation: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feeding a deliberately invalid value to exercise the runtime guard; the type system forbids it by design
        targets: ['web', 'tv' as any],
      },
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Task',
          prompt: 'Prompt',
        }],
      }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /validation\.targets/i);
  });

  it('should throw when context budget values are not positive integers', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Bad Budget',
      defaultEngine: 'claude',
      validation: {
        contextBudget: {
          discoveryTokens: -1,
        },
      },
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Task',
          prompt: 'Prompt',
        }],
      }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /discoveryTokens/i);
  });

  it('should throw when task-level validation override is invalid', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Bad Task Validation',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Task',
          prompt: 'Prompt',
          validation: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feeding a deliberately invalid value to exercise the runtime guard; the type system forbids it by design
            profile: 'invalid' as any,
          },
        }],
      }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /tasks\[\]\.validation\.profile/i);
  });

  it('should round-trip plan aiRules byte-exact through save/load', () => {
    const plan = createEmptyPlan('Rules Test');
    plan.aiRules = 'never touch src/legacy/**';

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);

    assert.equal(loaded.aiRules, 'never touch src/legacy/**');
    // The glob must survive verbatim — no escaping, no normalisation
    assert.ok(loaded.aiRules!.includes('src/legacy/**'));
  });

  it('should round-trip fixIterations through save/load', () => {
    const plan = createEmptyPlan('Fix Iterations');
    plan.fixIterations = 2;

    savePlan(plan, tmpFile);
    assert.equal(loadPlan(tmpFile).fixIterations, 2);
  });

  it('should persist fixIterations of 0 as 0, not drop it', () => {
    const plan = createEmptyPlan('Zero Iterations');
    plan.fixIterations = 0;

    savePlan(plan, tmpFile);
    const raw: PlanFile = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.equal(raw.fixIterations, 0);
    assert.equal(loadPlan(tmpFile).fixIterations, 0);
  });

  it('should round-trip prdVersions preserving order', () => {
    const plan = createEmptyPlan('PRD Versions');
    plan.prdVersions = [
      { version: 'v1', text: 'first draft', createdAt: '2026-01-01T00:00:00.000Z' },
      { version: 'v2', text: 'second draft', createdAt: '2026-01-02T00:00:00.000Z' },
    ];

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);

    assert.deepEqual(loaded.prdVersions, plan.prdVersions);
    assert.equal(loaded.prdVersions![0].version, 'v1');
    assert.equal(loaded.prdVersions![1].version, 'v2');
  });

  it('should omit aiRules, prdVersions and fixIterations when absent', () => {
    const plan = createEmptyPlan('Nothing Set');

    savePlan(plan, tmpFile);
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    assert.ok(!('aiRules' in raw));
    assert.ok(!('prdVersions' in raw));
    assert.ok(!('fixIterations' in raw));
  });

  it('should throw when fixIterations is not an integer', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Bad Iterations',
      defaultEngine: 'claude',
      fixIterations: 1.5,
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /fixIterations/);
  });

  it('should throw when prdVersions is not an array', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Bad Versions',
      defaultEngine: 'claude',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feeding a deliberately invalid value to exercise the runtime guard; the type system forbids it by design
      prdVersions: 'v1' as any,
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /prdVersions/);
  });

  it('should throw when a prdVersions entry is malformed', () => {
    const raw: PlanFile = {
      version: '1.0',
      name: 'Bad Version Entry',
      defaultEngine: 'claude',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feeding a deliberately invalid value to exercise the runtime guard; the type system forbids it by design
      prdVersions: [{ version: 1 } as any],
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /prdVersions\[0\]/);
  });

  it('should not apply the PRD retention cap in the loader or the serializer', () => {
    const many: PrdVersion[] = Array.from({ length: 50 }, (_, i) => ({
      version: `v${i + 1}`,
      text: `draft ${i + 1}`,
      createdAt: `2026-01-01T00:00:0${i % 10}.000Z`,
    }));
    const file: PlanFile = {
      version: '1.0',
      name: 'Hand Authored',
      defaultEngine: 'claude',
      prdVersions: many,
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    const hydrated = hydratePlan(file, 'hand.json');
    assert.equal(hydrated.prdVersions!.length, 50);
    assert.equal(dehydratePlan(hydrated).prdVersions!.length, 50);
  });

  it('should round-trip the documented two-target monorepo sandbox block', () => {
    const sandbox = {
      targets: [
        { name: 'Frontend', cwd: 'apps/web', command: 'npm run dev', port: 3000 },
        { name: 'Backend', cwd: 'apps/api', command: 'npm run dev', port: 4000 },
      ],
    };
    const raw = {
      version: '1.0',
      name: 'Monorepo',
      defaultEngine: 'claude',
      sandbox,
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    const loaded = loadPlan(tmpFile);

    assert.equal(loaded.sandbox!.targets!.length, 2);
    assert.equal(loaded.sandbox!.targets![1].port, 4000);

    savePlan(loaded, tmpFile);
    const firstText = fs.readFileSync(tmpFile, 'utf-8');
    const resaved = JSON.parse(firstText) as Record<string, unknown>;
    assert.deepEqual(resaved.sandbox, sandbox);

    // Idempotence: a second load/save cycle must produce byte-identical text
    savePlan(loadPlan(tmpFile), tmpFile);
    assert.equal(fs.readFileSync(tmpFile, 'utf-8'), firstText);
  });

  it('should round-trip the shorthand sandbox command/port form', () => {
    const raw = {
      version: '1.0',
      name: 'Shorthand',
      defaultEngine: 'claude',
      sandbox: { command: 'npm run dev', port: 5173 },
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    const loaded = loadPlan(tmpFile);
    assert.equal(loaded.sandbox!.command, 'npm run dev');
    assert.equal(loaded.sandbox!.port, 5173);
    assert.equal(loaded.sandbox!.targets, undefined);

    savePlan(loaded, tmpFile);
    const resaved = JSON.parse(fs.readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    assert.deepEqual(resaved.sandbox, { command: 'npm run dev', port: 5173 });
  });

  it('should omit sandbox from the file when the plan has none', () => {
    const plan = createEmptyPlan('No Sandbox');
    savePlan(plan, tmpFile);
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
    assert.ok(!('sandbox' in raw));
  });

  it('should throw when a sandbox target is missing its command', () => {
    const raw = {
      version: '1.0',
      name: 'No Command',
      defaultEngine: 'claude',
      sandbox: { targets: [{ name: 'Frontend', cwd: 'apps/web' }] },
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /sandbox\.targets\[0\]\.command/);
  });

  it('should throw when sandbox targets is an empty array', () => {
    const raw = {
      version: '1.0',
      name: 'Empty Targets',
      defaultEngine: 'claude',
      sandbox: { targets: [] },
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /sandbox\.targets/);
  });

  it('should throw on the singular "target" typo instead of silently ignoring it', () => {
    const raw = {
      version: '1.0',
      name: 'Typo',
      defaultEngine: 'claude',
      sandbox: { target: [] },
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /sandbox/);
  });

  it('should throw when a sandbox port is a string', () => {
    const raw = {
      version: '1.0',
      name: 'String Port',
      defaultEngine: 'claude',
      sandbox: { targets: [{ name: 'Web', command: 'npm run dev', port: '3000' }] },
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), 'utf-8');
    assert.throws(() => loadPlan(tmpFile), /port/);
  });
});

describe('appendPrdVersion', () => {
  const makeEntry = (n: number, text = `draft ${n}`): PrdVersion => ({
    version: `v${n}`,
    text,
    createdAt: `2026-01-01T00:00:00.00${n % 10}Z`,
  });

  it('should append to an empty history without dropping anything', () => {
    const { versions, dropped } = appendPrdVersion(undefined, makeEntry(1));
    assert.equal(versions.length, 1);
    assert.equal(dropped, 0);
    assert.equal(versions[0].version, 'v1');
  });

  it('should drop the oldest entry when exceeding MAX_PRD_VERSIONS', () => {
    const existing = Array.from({ length: MAX_PRD_VERSIONS }, (_, i) => makeEntry(i + 1));
    const { versions, dropped } = appendPrdVersion(existing, makeEntry(MAX_PRD_VERSIONS + 1));

    assert.equal(versions.length, MAX_PRD_VERSIONS);
    assert.equal(dropped, 1);
    // Newest stays last, and the oldest survivor is the former second entry
    assert.equal(versions[versions.length - 1].version, `v${MAX_PRD_VERSIONS + 1}`);
    assert.equal(versions[0].version, 'v2');
  });

  it('should never drop the entry just added, even when it alone exceeds the char ceiling', () => {
    const existing = Array.from({ length: 19 }, (_, i) => makeEntry(i + 1, 'x'.repeat(10)));
    const huge = makeEntry(99, 'y'.repeat(MAX_PRD_VERSIONS_CHARS + 1));
    const { versions, dropped } = appendPrdVersion(existing, huge);

    assert.equal(versions.length, 1);
    assert.equal(dropped, 19);
    assert.equal(versions[0].version, 'v99');
    assert.equal(versions[0].text.length, MAX_PRD_VERSIONS_CHARS + 1);
  });

  it('should not mutate the array it was given', () => {
    const existing = [makeEntry(1)];
    appendPrdVersion(existing, makeEntry(2));
    assert.equal(existing.length, 1);
  });
});
