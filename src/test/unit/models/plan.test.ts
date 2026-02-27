import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateId, loadPlan, savePlan, createEmptyPlan, createPlaylist, createTask } from '../../../models/plan';
import { TaskStatus, PlanFile } from '../../../models/types';

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
    // Use the default playlist that createEmptyPlan provides
    const pl = plan.playlists[0];
    pl.name = 'Phase 1';
    pl.engine = 'codex';
    pl.autoplayDelay = 500;
    pl.parallel = true;
    const task = createTask('Task 1', 'Do something', 'claude');
    task.cwd = './src';
    task.files = ['a.ts', 'b.ts'];
    task.verifyCommand = 'npm test';
    task.retryCount = 2;
    task.dependsOn = ['other-task'];
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

    const t = loaded.playlists[0].tasks[0];
    assert.equal(t.name, 'Task 1');
    assert.equal(t.prompt, 'Do something');
    assert.equal(t.engine, 'claude');
    assert.equal(t.cwd, './src');
    assert.deepEqual(t.files, ['a.ts', 'b.ts']);
    assert.equal(t.verifyCommand, 'npm test');
    assert.equal(t.retryCount, 2);
    assert.deepEqual(t.dependsOn, ['other-task']);
    // Status should be hydrated back to Pending
    assert.equal(t.status, TaskStatus.Pending);
  });

  it('should strip status fields from the saved file', () => {
    const plan = createEmptyPlan('Strip Test');
    const task = createTask('T', 'prompt');
    task.status = TaskStatus.Completed; // should not persist
    plan.playlists[0].tasks.push(task);

    savePlan(plan, tmpFile);
    const raw: PlanFile = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((raw.playlists[0].tasks[0] as any).status, undefined);
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
});
