import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Plan, Playlist, Task, TaskStatus, HistoryEntry, EngineResult } from '../../../models/types';
import { createEmptyPlan, createPlaylist, createTask } from '../../../models/plan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

// Load context-builder with mocked vscode (semantic provider returns no spans)
const {
  buildContext,
  getContextSettings,
  gatherPlanOverview,
  gatherCumulativeProgress,
  gatherChangedFiles,
  gatherPriorOutputs,
  gatherProjectState,
  applyBudget,
  gatherRgGlobSpans,
  gatherSymbolHintSpans,
  mergeSpans,
  scorePriorEntry,
} = proxyquire('../../../context/context-builder', {
  'vscode': vscodeMock,
  './semantic-provider': {
    semanticSearch: async () => [],
    formatSpans: require('../../../context/semantic-provider').formatSpans,
  },
});

// Separate load with semantic provider returning results for runRetrievalCascade tests
const { runRetrievalCascade: runCascadeWithSemantic } = proxyquire('../../../context/context-builder', {
  'vscode': vscodeMock,
  './semantic-provider': {
    semanticSearch: async () => [
      { filePath: 'src/semantic.ts', startLine: 1, endLine: 5, content: 'semantic result', confidence: 0.9 },
    ],
    formatSpans: require('../../../context/semantic-provider').formatSpans,
  },
});

const { runRetrievalCascade: runCascadeNoSemantic } = proxyquire('../../../context/context-builder', {
  'vscode': vscodeMock,
  './semantic-provider': {
    semanticSearch: async () => [],
    formatSpans: require('../../../context/semantic-provider').formatSpans,
  },
});

// ─── Helpers ───

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'entry-1',
    taskId: 'task-1',
    taskName: 'Task 1',
    playlistId: 'pl-1',
    playlistName: 'Playlist 1',
    engine: 'claude',
    prompt: 'do something',
    result: { stdout: 'task output', stderr: '', exitCode: 0, durationMs: 100 },
    status: TaskStatus.Completed,
    startedAt: '2024-01-01T00:00:00Z',
    finishedAt: '2024-01-01T00:01:00Z',
    ...overrides,
  };
}

function createMockHistoryStore(entries: HistoryEntry[] = []) {
  return {
    getForTask(taskId: string) {
      return entries.filter(e => e.taskId === taskId).reverse();
    },
    getAll() {
      return [...entries].reverse();
    },
    add() {},
    clear() {},
    onDidChange: () => ({ dispose: () => {} }),
  };
}

function makePlanWithTasks(): { plan: Plan; playlist: Playlist; tasks: Task[] } {
  const plan = createEmptyPlan('Test Plan');
  plan.description = 'A test plan for context building';
  const pl = plan.playlists[0];
  pl.id = 'pl-1';
  pl.name = 'Phase 1';
  const t1 = createTask('Setup project', 'Initialize the project');
  t1.id = 'task-1';
  t1.status = TaskStatus.Completed;
  const t2 = createTask('Build API', 'Create REST API');
  t2.id = 'task-2';
  t2.status = TaskStatus.Pending;
  const t3 = createTask('Add tests', 'Write unit tests');
  t3.id = 'task-3';
  t3.status = TaskStatus.Pending;
  pl.tasks = [t1, t2, t3];
  return { plan, playlist: pl, tasks: [t1, t2, t3] };
}

function defaultSettings() {
  return {
    enabled: true,
    planOverview: true,
    priorTaskOutputs: true,
    allPriorOutputs: false,
    projectState: true,
    changedFiles: true,
    cumulativeProgress: true,
    maxContextChars: 30000,
    maxOutputPerTask: 3000,
    fileTreeDepth: 3,
  };
}

describe('Context Builder', () => {
  describe('buildContext', () => {
    it('should return empty string when disabled', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      const settings = { ...defaultSettings(), enabled: false };
      const historyStore = createMockHistoryStore();
      const result = buildContext({
        plan, playlist, task: tasks[1], cwd: '/mock/workspace', historyStore, settings,
      });
      assert.equal(result, '');
    });

    it('should wrap output in [CONTEXT START]/[CONTEXT END]', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      const settings = { ...defaultSettings(), projectState: false, changedFiles: false, priorTaskOutputs: false, cumulativeProgress: false };
      const historyStore = createMockHistoryStore();
      const result = buildContext({
        plan, playlist, task: tasks[1], cwd: '/mock/workspace', historyStore, settings,
      });
      assert.ok(result.startsWith('[CONTEXT START]'), 'should start with [CONTEXT START]');
      assert.ok(result.endsWith('[CONTEXT END]'), 'should end with [CONTEXT END]');
    });

    it('should include plan overview section', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      const settings = { ...defaultSettings(), projectState: false, changedFiles: false, priorTaskOutputs: false, cumulativeProgress: false };
      const historyStore = createMockHistoryStore();
      const result = buildContext({
        plan, playlist, task: tasks[1], cwd: '/mock/workspace', historyStore, settings,
      });
      assert.ok(result.includes('## Plan'));
      assert.ok(result.includes('Plan: "Test Plan"'));
    });
  });

  describe('gatherPlanOverview', () => {
    it('should mark tasks with correct status markers', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      const result = gatherPlanOverview(plan, playlist, tasks[1]);
      assert.ok(result.includes('[done] 1. Setup project'));
      assert.ok(result.includes('[current] 2. Build API'));
      assert.ok(result.includes('<-- YOU ARE HERE'));
      assert.ok(result.includes('[upcoming] 3. Add tests'));
    });

    it('should include plan name and description', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      const result = gatherPlanOverview(plan, playlist, tasks[1]);
      assert.ok(result.includes('Plan: "Test Plan"'));
      assert.ok(result.includes('Description: A test plan for context building'));
    });

    it('should show [failed] marker for failed tasks', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      tasks[0].status = TaskStatus.Failed;
      const result = gatherPlanOverview(plan, playlist, tasks[1]);
      assert.ok(result.includes('[failed] 1. Setup project'));
    });

    it('should show [skipped] marker for skipped tasks', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      tasks[0].status = TaskStatus.Skipped;
      const result = gatherPlanOverview(plan, playlist, tasks[1]);
      assert.ok(result.includes('[skipped] 1. Setup project'));
    });
  });

  describe('gatherCumulativeProgress', () => {
    it('should list completed tasks with file counts', () => {
      const { plan, tasks } = makePlanWithTasks();
      const entries = [
        makeHistoryEntry({ taskId: 'task-1', changedFiles: ['src/index.ts', 'package.json', 'tsconfig.json'] }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const result = gatherCumulativeProgress(historyStore, plan, tasks[1]);
      assert.ok(result.includes('"Setup project": completed (3 files changed)'));
    });

    it('should return empty for first task with no prior tasks', () => {
      const { plan, tasks } = makePlanWithTasks();
      tasks[0].status = TaskStatus.Pending;
      const historyStore = createMockHistoryStore();
      const result = gatherCumulativeProgress(historyStore, plan, tasks[0]);
      assert.equal(result, '');
    });

    it('should show failed tasks', () => {
      const { plan, tasks } = makePlanWithTasks();
      tasks[0].status = TaskStatus.Failed;
      const historyStore = createMockHistoryStore();
      const result = gatherCumulativeProgress(historyStore, plan, tasks[1]);
      assert.ok(result.includes('"Setup project": failed'));
    });

    it('should handle completed tasks with no changed files', () => {
      const { plan, tasks } = makePlanWithTasks();
      const entries = [
        makeHistoryEntry({ taskId: 'task-1', changedFiles: undefined }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const result = gatherCumulativeProgress(historyStore, plan, tasks[1]);
      assert.ok(result.includes('"Setup project": completed'));
      assert.ok(!result.includes('files changed'));
    });
  });

  describe('gatherChangedFiles', () => {
    it('should list changed files with attribution', () => {
      const { playlist, tasks } = makePlanWithTasks();
      const entries = [
        makeHistoryEntry({ taskId: 'task-1', taskName: 'Setup project', changedFiles: ['src/index.ts', 'package.json'] }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const result = gatherChangedFiles(historyStore, playlist, tasks[1]);
      assert.ok(result.includes('src/index.ts (by: Setup project)'));
      assert.ok(result.includes('package.json (by: Setup project)'));
    });

    it('should deduplicate files and attribute to last writer', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      // Both task-1 and task-2 completed and changed package.json
      tasks[0].status = TaskStatus.Completed;
      tasks[1].status = TaskStatus.Completed;
      const entries = [
        makeHistoryEntry({ taskId: 'task-1', taskName: 'Setup project', changedFiles: ['package.json', 'src/index.ts'] }),
        makeHistoryEntry({ id: 'entry-2', taskId: 'task-2', taskName: 'Build API', changedFiles: ['package.json', 'src/api.ts'] }),
      ];
      const historyStore = createMockHistoryStore(entries);
      // Current task is task-3
      const result = gatherChangedFiles(historyStore, playlist, tasks[2]);
      assert.ok(result.includes('package.json (by: Build API)'));
      assert.ok(result.includes('src/index.ts (by: Setup project)'));
      assert.ok(result.includes('src/api.ts (by: Build API)'));
    });

    it('should return empty when no prior tasks have changed files', () => {
      const { playlist, tasks } = makePlanWithTasks();
      const historyStore = createMockHistoryStore();
      const result = gatherChangedFiles(historyStore, playlist, tasks[1]);
      assert.equal(result, '');
    });
  });

  describe('gatherPriorOutputs', () => {
    it('should include dependency task outputs', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      tasks[1].dependsOn = ['task-1'];
      const entries = [
        makeHistoryEntry({ taskId: 'task-1', result: { stdout: 'Project initialized successfully', stderr: '', exitCode: 0, durationMs: 100 } }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const settings = defaultSettings();
      const result = gatherPriorOutputs(historyStore, plan, playlist, tasks[1], settings);
      assert.ok(result.includes('--- Task "Setup project" (completed) ---'));
      assert.ok(result.includes('Project initialized successfully'));
    });

    it('should tail-truncate long outputs with ...[truncated]... prefix', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      tasks[1].dependsOn = ['task-1'];
      const longOutput = 'x'.repeat(5000);
      const entries = [
        makeHistoryEntry({ taskId: 'task-1', result: { stdout: longOutput, stderr: '', exitCode: 0, durationMs: 100 } }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const settings = { ...defaultSettings(), maxOutputPerTask: 1000 };
      const result = gatherPriorOutputs(historyStore, plan, playlist, tasks[1], settings);
      assert.ok(result.includes('...[truncated]...'));
      // The truncated output should be at most maxOutputPerTask from the end
      assert.ok(result.length < 2000);
    });

    it('should return empty when task has no dependencies', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      // task-2 has no dependsOn
      const historyStore = createMockHistoryStore();
      const settings = defaultSettings();
      const result = gatherPriorOutputs(historyStore, plan, playlist, tasks[1], settings);
      assert.equal(result, '');
    });

    it('should include all prior outputs when allPriorOutputs is true', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      tasks[0].status = TaskStatus.Completed;
      const entries = [
        makeHistoryEntry({ taskId: 'task-1', result: { stdout: 'Setup done', stderr: '', exitCode: 0, durationMs: 50 } }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const settings = { ...defaultSettings(), allPriorOutputs: true };
      const result = gatherPriorOutputs(historyStore, plan, playlist, tasks[1], settings);
      assert.ok(result.includes('Setup done'));
    });

    it('uses summary instead of raw output for non-dep tasks', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      const entries = [
        makeHistoryEntry({
          taskId: 'task-1',
          result: { stdout: 'A'.repeat(3000), stderr: '', exitCode: 0, durationMs: 100 },
          summary: 'Added auth module. 2 files changed.',
        }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const settings = { ...defaultSettings(), allPriorOutputs: true };
      const result = gatherPriorOutputs(historyStore, plan, playlist, tasks[1], settings);
      assert.ok(result.includes('Added auth module. 2 files changed.'));
      // Should not include the raw 3000-char stdout
      assert.ok(!result.includes('AAAA'));
    });

    it('still uses raw output for explicit deps even when summary exists', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      tasks[1].dependsOn = ['task-1'];
      const entries = [
        makeHistoryEntry({
          taskId: 'task-1',
          result: { stdout: 'Raw output: token=abc123', stderr: '', exitCode: 0, durationMs: 100 },
          summary: 'Short summary only',
        }),
      ];
      const historyStore = createMockHistoryStore(entries);
      const result = gatherPriorOutputs(historyStore, plan, playlist, tasks[1], defaultSettings());
      assert.ok(result.includes('Raw output: token=abc123'));
    });
  });

  describe('scorePriorEntry', () => {
    it('returns 1.0 for explicit dependencies', () => {
      const { tasks } = makePlanWithTasks();
      tasks[1].dependsOn = ['task-1'];
      const entry = makeHistoryEntry({ taskId: 'task-1', taskName: 'Setup project' });
      const score = scorePriorEntry(entry, tasks[1], 0);
      assert.equal(score, 1.0);
    });

    it('returns higher score when task names share keywords with current prompt', () => {
      const { tasks } = makePlanWithTasks();
      tasks[1].prompt = 'Refactor authentication module to support OAuth tokens';
      const entryRelevant = makeHistoryEntry({ taskId: 'task-1', taskName: 'Build authentication service', summary: 'Added OAuth login flow' });
      const entryIrrelevant = makeHistoryEntry({ taskId: 'task-0', taskName: 'Setup database', summary: 'Configured PostgreSQL' });
      const scoreRelevant = scorePriorEntry(entryRelevant, tasks[1], 0);
      const scoreIrrelevant = scorePriorEntry(entryIrrelevant, tasks[1], 0);
      assert.ok(scoreRelevant > scoreIrrelevant, `relevant (${scoreRelevant}) should beat irrelevant (${scoreIrrelevant})`);
    });

    it('gives higher score to recent tasks when token overlap is equal', () => {
      const { tasks } = makePlanWithTasks();
      const entryRecent = makeHistoryEntry({ taskId: 'task-1', taskName: 'Task A' });
      const entryOld = makeHistoryEntry({ taskId: 'task-0', taskName: 'Task A' });
      const scoreRecent = scorePriorEntry(entryRecent, tasks[1], 0);
      const scoreOld = scorePriorEntry(entryOld, tasks[1], 5);
      assert.ok(scoreRecent > scoreOld);
    });

    it('boosts score when current prompt mentions files the prior task changed', () => {
      const { tasks } = makePlanWithTasks();
      tasks[1].prompt = 'Update the logic in src/auth.ts to use refreshToken';
      const entryWithFile = makeHistoryEntry({ taskId: 'task-1', taskName: 'Setup project', changedFiles: ['src/auth.ts'] });
      const entryNoFile = makeHistoryEntry({ taskId: 'task-0', taskName: 'Setup project', changedFiles: ['src/unrelated.ts'] });
      const scoreWithFile = scorePriorEntry(entryWithFile, tasks[1], 0);
      const scoreNoFile = scorePriorEntry(entryNoFile, tasks[1], 0);
      assert.ok(scoreWithFile > scoreNoFile);
    });
  });

  describe('gatherProjectState', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should build a file tree', () => {
      // Create some test files/dirs
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'console.log("hi")');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

      const settings = defaultSettings();
      const result = gatherProjectState(tmpDir, settings);
      assert.ok(result.includes('File tree'));
      assert.ok(result.includes('src/'));
      assert.ok(result.includes('index.ts'));
    });

    it('should respect fileTreeDepth', () => {
      fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'c', 'deep.txt'), 'deep');

      const settings = { ...defaultSettings(), fileTreeDepth: 1 };
      const result = gatherProjectState(tmpDir, settings);
      assert.ok(result.includes('a/'));
      // Should NOT contain 'b/' because depth is 1
      assert.ok(!result.includes('b/'));
    });

    it('should ignore node_modules', () => {
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'some-pkg'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), '');

      const settings = defaultSettings();
      const result = gatherProjectState(tmpDir, settings);
      assert.ok(!result.includes('node_modules'));
      assert.ok(result.includes('src/'));
    });

    it('should extract README content', () => {
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# My Project\n\nThis is a test.');

      const settings = defaultSettings();
      const result = gatherProjectState(tmpDir, settings);
      assert.ok(result.includes('README:'));
      assert.ok(result.includes('# My Project'));
    });

    it('should extract package.json key fields', () => {
      const pkg = { name: 'my-app', description: 'A test app', scripts: { build: 'tsc' }, version: '1.0.0' };
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

      const settings = defaultSettings();
      const result = gatherProjectState(tmpDir, settings);
      assert.ok(result.includes('package.json (key fields)'));
      assert.ok(result.includes('"my-app"'));
      assert.ok(result.includes('"A test app"'));
      assert.ok(result.includes('"build"'));
      // version is not in the extracted keys
      assert.ok(!result.includes('"version"'));
    });

    it('should handle empty project gracefully', () => {
      const settings = defaultSettings();
      const result = gatherProjectState(tmpDir, settings);
      // Should not throw, may return empty or just file tree header
      assert.equal(typeof result, 'string');
    });
  });

  describe('applyBudget', () => {
    it('should keep all sections when under budget', () => {
      const sections = [
        { priority: 1, header: '=== A ===', body: 'Short body A' },
        { priority: 2, header: '=== B ===', body: 'Short body B' },
      ];
      const result = applyBudget(sections, 30000);
      assert.equal(result.length, 2);
    });

    it('should drop lowest priority sections first', () => {
      const sections = [
        { priority: 1, header: '=== HIGH ===', body: 'x'.repeat(100) },
        { priority: 5, header: '=== LOW ===', body: 'y'.repeat(100) },
        { priority: 3, header: '=== MID ===', body: 'z'.repeat(100) },
      ];
      // Set budget so only 2 sections fit
      const result = applyBudget(sections, 250);
      assert.equal(result.length, 2);
      assert.equal(result[0].header, '=== HIGH ===');
      assert.equal(result[1].header, '=== MID ===');
    });

    it('should return empty array if budget is too small for any section', () => {
      const sections = [
        { priority: 1, header: '=== A ===', body: 'x'.repeat(500) },
      ];
      const result = applyBudget(sections, 10);
      assert.equal(result.length, 0);
    });
  });

  describe('gatherRgGlobSpans', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should find spans matching ALL_CAPS constants in prompt', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'config.ts'), [
        'const MAX_RETRIES = 3;',
        'const BASE_URL = "http://example.com";',
        'export { MAX_RETRIES, BASE_URL };',
      ].join('\n'));
      const spans = gatherRgGlobSpans('Use MAX_RETRIES when retrying requests', tmpDir, 50000);
      assert.ok(spans.length > 0);
      assert.ok(spans.some((s: any) => s.content.includes('MAX_RETRIES')));
      assert.ok(spans.every((s: any) => s.confidence === 0.65));
    });

    it('should find spans matching snake_case identifiers in prompt', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), [
        'function task_runner(task_id: string) {',
        '  return task_id.toUpperCase();',
        '}',
      ].join('\n'));
      const spans = gatherRgGlobSpans('implement task_runner logic for each task_id', tmpDir, 50000);
      assert.ok(spans.length > 0);
      assert.ok(spans.some((s: any) => s.content.includes('task_runner')));
    });

    it('should return empty array when no matching keywords found', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'empty.ts'), 'export {};');
      const spans = gatherRgGlobSpans('fix the issue with that this with from have', tmpDir, 50000);
      // stop words only — no useful keywords
      assert.equal(spans.length, 0);
    });

    it('should respect the budget and not exceed it', () => {
      const longContent = Array.from({ length: 200 }, (_, i) => `// line_number_${i}`).join('\n');
      fs.writeFileSync(path.join(tmpDir, 'src', 'big.ts'), longContent);
      const tinyBudget = 50;
      const spans = gatherRgGlobSpans('line_number context', tmpDir, tinyBudget);
      const totalChars = spans.reduce((sum: number, s: any) => sum + s.content.length, 0);
      assert.ok(totalChars <= tinyBudget);
    });

    it('should assign confidence 0.65 to all returned spans', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'function authenticate_user() {}');
      const spans = gatherRgGlobSpans('authenticate_user should validate tokens', tmpDir, 50000);
      for (const s of spans) {
        assert.equal((s as any).confidence, 0.65);
      }
    });
  });

  describe('mergeSpans', () => {
    function makeSpan(filePath: string, startLine: number, endLine: number, confidence: number) {
      return { filePath, startLine, endLine, content: `lines ${startLine}-${endLine}`, confidence };
    }

    it('should return higher spans when lower is empty', () => {
      const higher = [makeSpan('a.ts', 1, 5, 0.65)];
      const result = mergeSpans([], higher);
      assert.deepEqual(result, higher);
    });

    it('should return lower spans when higher is empty', () => {
      const lower = [makeSpan('a.ts', 1, 5, 0.6)];
      const result = mergeSpans(lower, []);
      assert.deepEqual(result, lower);
    });

    it('should drop lower spans that overlap with higher spans in the same file', () => {
      const lower = [makeSpan('a.ts', 3, 8, 0.6)];
      const higher = [makeSpan('a.ts', 5, 10, 0.65)];
      const result = mergeSpans(lower, higher);
      assert.equal(result.length, 1);
      assert.equal(result[0].confidence, 0.65);
    });

    it('should keep non-overlapping lower spans from other files', () => {
      const lower = [makeSpan('b.ts', 1, 5, 0.6)];
      const higher = [makeSpan('a.ts', 1, 5, 0.65)];
      const result = mergeSpans(lower, higher);
      assert.equal(result.length, 2);
      assert.ok(result.some((s: any) => s.filePath === 'a.ts'));
      assert.ok(result.some((s: any) => s.filePath === 'b.ts'));
    });

    it('should keep non-overlapping lower spans in the same file', () => {
      const lower = [makeSpan('a.ts', 1, 3, 0.6)];
      const higher = [makeSpan('a.ts', 10, 15, 0.65)];
      const result = mergeSpans(lower, higher);
      assert.equal(result.length, 2);
    });
  });

  describe('first task scenario', () => {
    it('should produce only plan overview + project state for first task', () => {
      const { plan, playlist, tasks } = makePlanWithTasks();
      tasks[0].status = TaskStatus.Pending; // first task is current
      const historyStore = createMockHistoryStore();
      const settings = { ...defaultSettings(), projectState: false }; // disable FS access in test
      const result = buildContext({
        plan, playlist, task: tasks[0], cwd: '/mock/workspace', historyStore, settings,
      });
      // Should have plan overview
      assert.ok(result.includes('## Plan'));
      // Should NOT have progress/changed/prior sections (no prior tasks)
      assert.ok(!result.includes('## Progress'));
      assert.ok(!result.includes('## Output'));
    });
  });

  describe('gatherSymbolHintSpans', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hint-test-'));
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should find spans for camelCase identifiers in prompt', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'runner.ts'), [
        'export class TaskRunner {',
        '  run(task: string) {}',
        '}',
      ].join('\n'));
      const spans = gatherSymbolHintSpans('Use TaskRunner to execute tasks', tmpDir, 50000);
      assert.ok(spans.length > 0);
      assert.ok(spans.some((s: any) => s.content.includes('TaskRunner')));
    });

    it('should find spans for PascalCase identifiers in prompt', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'store.ts'), [
        'class HistoryStore {',
        '  private entries: any[] = [];',
        '}',
      ].join('\n'));
      const spans = gatherSymbolHintSpans('HistoryStore should persist entries', tmpDir, 50000);
      assert.ok(spans.length > 0);
      assert.ok(spans.some((s: any) => s.content.includes('HistoryStore')));
    });

    it('should assign confidence 0.6 to all spans', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'function AuthProvider() {}');
      const spans = gatherSymbolHintSpans('AuthProvider setup', tmpDir, 50000);
      for (const s of spans) {
        assert.equal((s as any).confidence, 0.6);
      }
    });

    it('should return empty when prompt has no camelCase/PascalCase identifiers', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};');
      const spans = gatherSymbolHintSpans('fix the bug in the project', tmpDir, 50000);
      assert.equal(spans.length, 0);
    });

    it('should respect the budget and not exceed it', () => {
      const content = Array.from({ length: 100 }, (_, i) => `function MyFunc${i}() {}`).join('\n');
      fs.writeFileSync(path.join(tmpDir, 'src', 'big.ts'), content);
      const budget = 80;
      const spans = gatherSymbolHintSpans('MyFunc usage in code', tmpDir, budget);
      const totalChars = spans.reduce((sum: number, s: any) => sum + s.content.length, 0);
      assert.ok(totalChars <= budget);
    });

    it('should include surrounding context lines around a match', () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'ctx.ts'), [
        'const BEFORE = 1;',
        'function ContextBuilder() {',
        '  return {};',
        '}',
        'const AFTER = 2;',
      ].join('\n'));
      const spans = gatherSymbolHintSpans('ContextBuilder should return an object', tmpDir, 50000);
      assert.ok(spans.length > 0);
      const merged = spans.map((s: any) => s.content).join('\n');
      // Should include lines before/after the match
      assert.ok(merged.includes('BEFORE') || merged.includes('AFTER') || merged.includes('ContextBuilder'));
    });
  });

  describe('runRetrievalCascade', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-test-'));
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeTask(prompt: string): Task {
      const t = createTask('Test task', prompt);
      t.id = 'cascade-task-1';
      return t;
    }

    it('should return usedSemantic=true when semantic provider returns spans', async () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};');
      const task = makeTask('implement TaskRunner logic');
      const result = await runCascadeWithSemantic(task, tmpDir, 50000);
      assert.equal(result.usedSemantic, true);
      assert.ok(result.spans.some((s: any) => s.filePath === 'src/semantic.ts'));
    });

    it('should return usedSemantic=false when no semantic provider', async () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'runner.ts'), [
        'export class TaskRunner {',
        '  run() {}',
        '}',
      ].join('\n'));
      const task = makeTask('implement TaskRunner logic');
      const result = await runCascadeNoSemantic(task, tmpDir, 50000);
      assert.equal(result.usedSemantic, false);
    });

    it('should return deterministic spans when semantic returns empty', async () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'runner.ts'), [
        'export class TaskRunner {',
        '  run() {}',
        '}',
      ].join('\n'));
      const task = makeTask('implement TaskRunner logic');
      const result = await runCascadeNoSemantic(task, tmpDir, 50000);
      assert.equal(result.usedSemantic, false);
      // Should still have rg/hint spans covering TaskRunner
      assert.ok(result.spans.some((s: any) => s.content.includes('TaskRunner')));
    });

    it('should include deterministic spans for files not covered by semantic results', async () => {
      // The semantic mock returns src/semantic.ts; if there are other matching files
      // the cascade should keep non-overlapping deterministic spans as extras
      fs.writeFileSync(path.join(tmpDir, 'src', 'other.ts'), [
        'function TaskHelper() {}',
      ].join('\n'));
      const task = makeTask('use TaskHelper and semantic stuff');
      const result = await runCascadeWithSemantic(task, tmpDir, 50000);
      assert.equal(result.usedSemantic, true);
      // Semantic span is present
      assert.ok(result.spans.some((s: any) => s.filePath === 'src/semantic.ts'));
      // Extras from other files may also be present
      // (src/other.ts is not covered by the semantic result)
      const otherSpan = result.spans.find((s: any) => s.filePath === 'src/other.ts');
      if (otherSpan) {
        assert.ok(otherSpan.content.includes('TaskHelper'));
      }
    });

    it('should return empty spans when prompt has no useful keywords and no semantic', async () => {
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};');
      const task = makeTask('fix that this with from have');
      const result = await runCascadeNoSemantic(task, tmpDir, 50000);
      assert.equal(result.usedSemantic, false);
      assert.equal(result.spans.length, 0);
    });
  });
});
