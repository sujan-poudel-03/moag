// ─── Regression: legacy plan compatibility, adapter capability, semantic fallback ───
//
// Three focused areas:
//   1. Legacy plan hydration — partial / missing fields produce correct defaults
//   2. Validator isAvailable() — filesystem-based detection; run() returns skipped result
//   3. runRetrievalCascade — falls back to rg spans when semantic is absent or low-confidence

import { strict as assert } from 'assert';
import { SemanticSpan } from '../../context/semantic-provider';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TaskStatus } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('./mocks/vscode');

// ─── 1. Legacy plan compatibility ─────────────────────────────────────────────

describe('Regression: legacy plan hydration', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hydratePlan, dehydratePlan } = require('../../models/plan');

  it('hydrates plan with no validation field — all defaults', () => {
    const raw = {
      version: '1.0',
      name: 'Old Plan',
      defaultEngine: 'claude',
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };
    const plan = hydratePlan(raw, 'old.agent-plan.json');
    assert.deepEqual(plan.validation.targets, ['all']);
    assert.equal(plan.validation.profile, 'quick');
    assert.equal(plan.validation.contextBudget.discoveryTokens, 12000);
    assert.equal(plan.validation.contextBudget.analysisTokens, 24000);
    assert.equal(plan.validation.contextBudget.fixTokens, 16000);
  });

  it('hydrates partial contextBudget — missing tokens keep their defaults', () => {
    const raw = {
      version: '1.0',
      name: 'Partial Budget Plan',
      defaultEngine: 'claude',
      validation: {
        targets: ['web'],
        profile: 'pr',
        contextBudget: { discoveryTokens: 5000 },
      },
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };
    const plan = hydratePlan(raw, 'partial.agent-plan.json');
    assert.equal(plan.validation.contextBudget.discoveryTokens, 5000);
    assert.equal(plan.validation.contextBudget.analysisTokens, 24000);
    assert.equal(plan.validation.contextBudget.fixTokens, 16000);
  });

  it('auto-generates task id when missing from file', () => {
    const raw = {
      version: '1.0',
      name: 'No-ID Plan',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{ name: 'Do something', prompt: 'Execute task' }],
      }],
    };
    const plan = hydratePlan(raw, 'no-id.agent-plan.json');
    const task = plan.playlists[0].tasks[0];
    assert.ok(typeof task.id === 'string' && task.id.length > 0);
  });

  it('defaults task status to Pending when missing', () => {
    const raw = {
      version: '1.0',
      name: 'No-Status Plan',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{ id: 't-1', name: 'Do something', prompt: 'Execute task' }],
      }],
    };
    const plan = hydratePlan(raw, 'no-status.agent-plan.json');
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Pending);
  });

  it('restores persisted non-pending task statuses (completed, failed, skipped)', () => {
    const raw = {
      version: '1.0',
      name: 'Persisted Status Plan',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [
          { id: 't-1', name: 'Done task',   prompt: 'p', status: 'completed' },
          { id: 't-2', name: 'Failed task', prompt: 'p', status: 'failed'    },
          { id: 't-3', name: 'Skipped',     prompt: 'p', status: 'skipped'   },
          { id: 't-4', name: 'Pending',     prompt: 'p'                       },
        ],
      }],
    };
    const plan = hydratePlan(raw, 'status.agent-plan.json');
    const tasks = plan.playlists[0].tasks;
    assert.equal(tasks[0].status, TaskStatus.Completed);
    assert.equal(tasks[1].status, TaskStatus.Failed);
    assert.equal(tasks[2].status, TaskStatus.Skipped);
    assert.equal(tasks[3].status, TaskStatus.Pending);
  });

  // ─── Expert roles: old files must load unchanged, bad values must not brick loading ───

  it('round-trips a role-free plan without emitting a single role key', () => {
    const raw = {
      version: '1.0',
      name: 'Pre-Roles Plan',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{ id: 't-1', name: 'Do something', prompt: 'p' }],
      }],
    };
    const plan = hydratePlan(raw, 'pre-roles.agent-plan.json');
    assert.equal(plan.defaultRole, undefined);
    assert.equal(plan.customRoles, undefined);

    const file = dehydratePlan(plan);
    assert.ok(!('defaultRole' in file), 'emitted defaultRole for a plan that never had one');
    assert.ok(!('customRoles' in file), 'emitted customRoles for a plan that never had one');
    assert.ok(!('role' in file.playlists[0]), 'emitted a playlist role that never existed');
    assert.ok(!('role' in file.playlists[0].tasks[0]), 'emitted a task role that never existed');
  });

  it('drops an unrecognised role without throwing and leaves the playlist intact', () => {
    const raw = {
      version: '1.0',
      name: 'Hallucinated Role Plan',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Development',
        autoplay: true,
        role: 'senior-backend-engineer',
        tasks: [{ id: 't-1', name: 'Build', prompt: 'p', role: 'Engineer' }],
      }],
    };
    const load = () => hydratePlan(raw, 'hallucinated.agent-plan.json');
    assert.doesNotThrow(load);
    const plan = load();

    const playlist = plan.playlists[0];
    assert.equal(playlist.role, undefined);
    assert.equal(playlist.tasks[0].role, undefined, 'casing is not coerced — Engineer is not engineer');
    // Everything else about the playlist survives the bad role.
    assert.equal(playlist.name, 'Development');
    assert.equal(playlist.id, 'pl-1');
    assert.equal(playlist.tasks.length, 1);
    assert.equal(playlist.tasks[0].prompt, 'p');
  });

  it('filters customRoles entry by entry and rejects a non-array outright', () => {
    const base = {
      version: '1.0',
      name: 'Custom Roles Plan',
      defaultEngine: 'claude',
      playlists: [{ id: 'pl-1', name: 'Tasks', autoplay: true, tasks: [] }],
    };

    const mixed = hydratePlan({
      ...base,
      customRoles: [
        { id: 'not-a-role', name: 'Bad', charter: 'should be dropped' },
        { id: 'custom', name: 'Good', charter: 'should survive' },
        { id: 'engineer', name: 'No Charter', charter: '   ' },
        'not-even-an-object',
      ],
    }, 'mixed.agent-plan.json');
    assert.equal(mixed.customRoles.length, 1);
    assert.equal(mixed.customRoles[0].id, 'custom');
    assert.equal(mixed.customRoles[0].charter, 'should survive');

    const notArray = hydratePlan({ ...base, customRoles: 'not-an-array' }, 'bad.agent-plan.json');
    assert.equal(notArray.customRoles, undefined);

    const allBad = hydratePlan({
      ...base,
      customRoles: [{ id: 'nope', name: 'X', charter: 'y' }],
    }, 'allbad.agent-plan.json');
    assert.equal(allBad.customRoles, undefined, 'an array with no survivors must vanish, not become []');
  });

  it('deduplicates clashing task ids by regenerating the duplicate', () => {
    const raw = {
      version: '1.0',
      name: 'Dupe IDs',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [
          { id: 'same-id', name: 'First',  prompt: 'p' },
          { id: 'same-id', name: 'Second', prompt: 'p' },
        ],
      }],
    };
    const plan = hydratePlan(raw, 'dupe.agent-plan.json');
    const tasks = plan.playlists[0].tasks;
    assert.notEqual(tasks[0].id, tasks[1].id);
  });
});

// ─── 2. Adapter capability: isAvailable() + skipped run() ─────────────────────

describe('Regression: WebValidator.isAvailable', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-val-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const getAdapter = () => new (require('../../adapters/validation/web-validator').WebValidator)();

  it('returns false when directory is empty (no config, no package.json)', async () => {
    assert.equal(await getAdapter().isAvailable(tmpDir), false);
  });

  it('returns true when playwright.config.ts is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), 'export default {};');
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when playwright.config.js is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.js'), 'module.exports = {};');
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when cypress.config.ts is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'cypress.config.ts'), 'export default {};');
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when cypress.json is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'cypress.json'), '{}');
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when @playwright/test is in devDependencies', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when cypress is in dependencies', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { cypress: '^12.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('run() returns available=false / exitCode=0 / summary=skipped when unavailable', async () => {
    const adapter = getAdapter();
    const result = await adapter.run({
      cwd: tmpDir,
      profile: 'quick',
      signal: new AbortController().signal,
      onOutput: () => {},
    });
    assert.equal(result.available, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary, 'skipped');
    assert.equal(result.stages.length, 0);
  });
});

describe('Regression: MobileValidator.isAvailable', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-val-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when directory has no mobile tooling config', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MobileValidator } = require('../../adapters/validation/mobile-validator');
    assert.equal(await new MobileValidator().isAvailable(tmpDir), false);
  });

  it('returns false when .detoxrc.json is present but no device reachable', async () => {
    // Provide detox config but mock execSync to simulate no adb/xcrun on this machine
    const MobileValidatorModule = proxyquire('../../adapters/validation/mobile-validator', {
      'child_process': {
        spawn: () => ({ stdout: null, stderr: null, on: () => {}, kill: () => {} }),
        execSync: (_cmd: string) => { throw new Error('command not found'); },
      },
      'fs': fs,
      'path': path,
    });
    fs.writeFileSync(path.join(tmpDir, '.detoxrc.json'), '{}');
    const adapter = new MobileValidatorModule.MobileValidator();
    assert.equal(await adapter.isAvailable(tmpDir), false);
  });

  it('run() returns skipped result when no config present', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MobileValidator } = require('../../adapters/validation/mobile-validator');
    const result = await new MobileValidator().run({
      cwd: tmpDir,
      profile: 'quick',
      signal: new AbortController().signal,
      onOutput: () => {},
    });
    assert.equal(result.available, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary, 'skipped');
  });

  it('unavailableReason distinguishes missing tooling from missing device', async () => {
    const MobileValidatorModule = proxyquire('../../adapters/validation/mobile-validator', {
      'child_process': {
        spawn: () => ({ stdout: null, stderr: null, on: () => {}, kill: () => {} }),
        execSync: (_cmd: string) => { throw new Error('command not found'); },
      },
      'fs': fs,
      'path': path,
    });
    fs.writeFileSync(path.join(tmpDir, '.detoxrc.json'), '{}');
    const adapter = new MobileValidatorModule.MobileValidator();
    const reason = await adapter.unavailableReason(tmpDir);
    // Tool was found (detoxrc present), so reason should mention device/emulator
    assert.ok(reason.toLowerCase().includes('device') || reason.toLowerCase().includes('emulator') || reason.toLowerCase().includes('simulator'));
  });
});

describe('Regression: DesktopValidator.isAvailable', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-val-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const getAdapter = () => new (require('../../adapters/validation/desktop-validator').DesktopValidator)();

  it('returns false with no package.json', async () => {
    assert.equal(await getAdapter().isAvailable(tmpDir), false);
  });

  it('returns false with package.json that has no electron/winappdriver', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), false);
  });

  it('returns true when electron + @playwright/test in devDependencies', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { electron: '^28.0.0', '@playwright/test': '^1.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when spectron in devDependencies', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { spectron: '^14.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when electron alone (generic fallback)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { electron: '^28.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when winappdriver.json marker file exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(path.join(tmpDir, 'winappdriver.json'), '{}');
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('run() returns skipped result when unavailable', async () => {
    const result = await getAdapter().run({
      cwd: tmpDir,
      profile: 'quick',
      signal: new AbortController().signal,
      onOutput: () => {},
    });
    assert.equal(result.available, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary, 'skipped');
    assert.equal(result.stages.length, 0);
  });
});

// ─── 3. runRetrievalCascade: semantic fallback to rg ──────────────────────────

describe('Regression: runRetrievalCascade semantic fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadCascade(semanticReturnValue: unknown[]) {
    const { runRetrievalCascade } = proxyquire('../../context/context-builder', {
      vscode: vscodeMock,
      './semantic-provider': {
        semanticSearch: async () => semanticReturnValue,
        formatSpans: require('../../context/semantic-provider').formatSpans,
      },
    });
    return runRetrievalCascade;
  }

  function makeTask(prompt: string) {
    return { id: 't-1', name: 'Task', prompt, status: 'pending', type: 'agent' };
  }

  it('returns usedSemantic=false when semantic returns empty — rg spans present', async () => {
    const runRetrievalCascade = loadCascade([]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'runner.ts'), [
      'export class TaskRunner {',
      '  async runTask() {}',
      '}',
    ].join('\n'));

    const result = await runRetrievalCascade(makeTask('Fix TaskRunner execution'), tmpDir, 50000);
    assert.equal(result.usedSemantic, false);
    assert.ok(result.spans.some((s: SemanticSpan) => s.content.includes('TaskRunner')));
    assert.ok(result.spans.every((s: SemanticSpan) => s.confidence <= 0.65));
  });

  it('returns usedSemantic=false when all semantic spans are below confidence threshold', async () => {
    // CONFIDENCE_THRESHOLD is 0.45; these are all below it so semanticSearch filters them
    // but we test at the cascade level: semantic returns [] after the provider filter
    const runRetrievalCascade = loadCascade([]);

    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'),
      'function authenticate_user() { return true; }');

    const result = await runRetrievalCascade(
      makeTask('Fix authenticate_user to validate tokens'),
      tmpDir,
      50000,
    );
    assert.equal(result.usedSemantic, false);
    assert.ok(result.spans.some((s: SemanticSpan) => s.content.includes('authenticate_user')));
  });

  it('returns usedSemantic=true and high-confidence spans when semantic has results', async () => {
    const semanticSpans = [
      { filePath: 'src/runner.ts', startLine: 1, endLine: 3, content: 'class TaskRunner {}', confidence: 0.9 },
    ];
    const runRetrievalCascade = loadCascade(semanticSpans);

    fs.writeFileSync(path.join(tmpDir, 'src', 'runner.ts'), 'class TaskRunner {}');

    const result = await runRetrievalCascade(makeTask('Fix TaskRunner'), tmpDir, 50000);
    assert.equal(result.usedSemantic, true);
    assert.ok(result.spans.some((s: SemanticSpan) => s.confidence === 0.9));
  });

  it('keeps rg extras for files not covered by semantic spans', async () => {
    const semanticSpans = [
      { filePath: 'src/runner.ts', startLine: 1, endLine: 3, content: 'class TaskRunner {}', confidence: 0.85 },
    ];
    const runRetrievalCascade = loadCascade(semanticSpans);

    // runner.ts is covered by semantic; config.ts is not
    fs.writeFileSync(path.join(tmpDir, 'src', 'runner.ts'), 'class TaskRunner { runTask() {} }');
    fs.writeFileSync(path.join(tmpDir, 'src', 'config.ts'), 'const MAX_TASK_RETRIES = 3;');

    const result = await runRetrievalCascade(
      makeTask('Fix TaskRunner and MAX_TASK_RETRIES config'),
      tmpDir,
      50000,
    );
    assert.equal(result.usedSemantic, true);
    // Semantic span for runner.ts
    assert.ok(result.spans.some((s: SemanticSpan) => s.filePath === 'src/runner.ts' && s.confidence === 0.85));
    // rg/hint span for config.ts (uncovered file)
    assert.ok(result.spans.some((s: SemanticSpan) => s.filePath === 'src/config.ts'));
  });

  it('returns empty spans when semantic is empty and prompt has only stop words', async () => {
    const runRetrievalCascade = loadCascade([]);

    fs.writeFileSync(path.join(tmpDir, 'src', 'dummy.ts'), 'export const x = 1;');

    // All stop words → no keywords extracted → no rg spans
    const result = await runRetrievalCascade(
      makeTask('that this with from have will your what when then'),
      tmpDir,
      50000,
    );
    assert.equal(result.usedSemantic, false);
    assert.equal(result.spans.length, 0);
  });
});

// ─── 4. semantic-provider: no-provider / not-ready / low-confidence / throws ───

describe('Regression: semanticSearch fallback contract', () => {
  const {
    semanticSearch,
    registerProvider,
    unregisterProvider,
    getProvider,
    formatSpans,
    CONFIDENCE_THRESHOLD,
  } = require('../../context/semantic-provider');

  afterEach(() => {
    unregisterProvider();
  });

  it('CONFIDENCE_THRESHOLD is 0.45', () => {
    assert.equal(CONFIDENCE_THRESHOLD, 0.45);
  });

  it('returns [] when no provider is registered', async () => {
    const spans = await semanticSearch({ query: 'TaskRunner', cwd: '/tmp', maxSpans: 5 });
    assert.deepEqual(spans, []);
  });

  it('returns [] when registered provider is not ready', async () => {
    registerProvider({ name: 'test', isReady: () => false, search: async () => [{ filePath: 'a.ts', startLine: 1, endLine: 2, content: 'x', confidence: 0.9 }] });
    const spans = await semanticSearch({ query: 'TaskRunner', cwd: '/tmp', maxSpans: 5 });
    assert.deepEqual(spans, []);
  });

  it('filters out spans below CONFIDENCE_THRESHOLD', async () => {
    registerProvider({
      name: 'test',
      isReady: () => true,
      search: async () => [
        { filePath: 'a.ts', startLine: 1, endLine: 2, content: 'high', confidence: 0.8 },
        { filePath: 'b.ts', startLine: 1, endLine: 2, content: 'low',  confidence: 0.3 },
        { filePath: 'c.ts', startLine: 1, endLine: 2, content: 'edge', confidence: 0.45 },
      ],
    });
    const spans = await semanticSearch({ query: 'x', cwd: '/tmp', maxSpans: 10 });
    assert.ok(spans.some((s: { content: string }) => s.content === 'high'));
    assert.ok(spans.some((s: { content: string }) => s.content === 'edge'));
    assert.ok(!spans.some((s: { content: string }) => s.content === 'low'));
  });

  it('returns [] when provider.search throws', async () => {
    registerProvider({ name: 'test', isReady: () => true, search: async () => { throw new Error('index unavailable'); } });
    const spans = await semanticSearch({ query: 'x', cwd: '/tmp', maxSpans: 5 });
    assert.deepEqual(spans, []);
  });

  it('getProvider returns registered provider and null after unregister', () => {
    const p = { name: 'test', isReady: () => true, search: async () => [] };
    registerProvider(p);
    assert.strictEqual(getProvider(), p);
    unregisterProvider();
    assert.strictEqual(getProvider(), null);
  });

  it('formatSpans respects budget and stops before exceeding it', () => {
    const spans = [
      { filePath: 'a.ts', startLine: 1, endLine: 5, content: 'A'.repeat(200), confidence: 0.9 },
      { filePath: 'b.ts', startLine: 1, endLine: 5, content: 'B'.repeat(200), confidence: 0.8 },
      { filePath: 'c.ts', startLine: 1, endLine: 5, content: 'C'.repeat(200), confidence: 0.7 },
    ];
    // Budget of 250 chars — only first span fits
    const output = formatSpans(spans, 250);
    assert.ok(output.includes('a.ts'));
    assert.ok(!output.includes('b.ts'));
  });

  it('formatSpans returns empty string for empty span array', () => {
    assert.equal(formatSpans([], 10000), '');
  });
});

// ─── 5. Legacy plan: additional dehydration and field-default regressions ──────

describe('Regression: hydratePlan / dehydratePlan field defaults', () => {
  const { hydratePlan, dehydratePlan } = require('../../models/plan');

  it('task.type defaults to agent when missing from file', () => {
    const raw = {
      version: '1.0', name: 'X', defaultEngine: 'claude',
      playlists: [{ id: 'pl-1', name: 'P', autoplay: true,
        tasks: [{ id: 't-1', name: 'T', prompt: 'do it' }] }],
    };
    const plan = hydratePlan(raw, 'x.json');
    assert.equal(plan.playlists[0].tasks[0].type, 'agent');
  });

  it('playlist.autoplay defaults to true when missing', () => {
    const raw = {
      version: '1.0', name: 'X', defaultEngine: 'claude',
      playlists: [{ id: 'pl-1', name: 'P', tasks: [] }],
    };
    const plan = hydratePlan(raw, 'x.json');
    assert.equal(plan.playlists[0].autoplay, true);
  });

  it('dehydratePlan omits status field for pending tasks (keeps file clean)', () => {
    const raw = {
      version: '1.0', name: 'X', defaultEngine: 'claude',
      playlists: [{ id: 'pl-1', name: 'P', autoplay: true,
        tasks: [{ id: 't-1', name: 'T', prompt: 'p', status: 'pending' }] }],
    };
    const plan = hydratePlan(raw, 'x.json');
    const file = dehydratePlan(plan);
    assert.equal(file.playlists[0].tasks[0].status, undefined);
  });

  it('dehydratePlan preserves completed status so progress survives reload', () => {
    const raw = {
      version: '1.0', name: 'X', defaultEngine: 'claude',
      playlists: [{ id: 'pl-1', name: 'P', autoplay: true,
        tasks: [{ id: 't-1', name: 'T', prompt: 'p', status: 'completed' }] }],
    };
    const plan = hydratePlan(raw, 'x.json');
    const file = dehydratePlan(plan);
    assert.equal(file.playlists[0].tasks[0].status, 'completed');
  });

  it('dehydratePlan omits validation block when settings are all defaults', () => {
    const raw = {
      version: '1.0', name: 'X', defaultEngine: 'claude',
      playlists: [{ id: 'pl-1', name: 'P', autoplay: true, tasks: [] }],
    };
    const plan = hydratePlan(raw, 'x.json');
    const file = dehydratePlan(plan);
    assert.equal(file.validation, undefined);
  });

  it('dehydratePlan preserves non-default validation settings', () => {
    const raw = {
      version: '1.0', name: 'X', defaultEngine: 'claude',
      validation: { targets: ['web'], profile: 'pr', contextBudget: { discoveryTokens: 8000, analysisTokens: 24000, fixTokens: 16000 } },
      playlists: [{ id: 'pl-1', name: 'P', autoplay: true, tasks: [] }],
    };
    const plan = hydratePlan(raw, 'x.json');
    const file = dehydratePlan(plan);
    assert.ok(file.validation !== undefined);
    assert.deepEqual(file.validation!.targets, ['web']);
    assert.equal(file.validation!.profile, 'pr');
  });
});

// ─── 6. Adapter unavailableReason messages and additional detection ────────────

describe('Regression: WebValidator.unavailableReason and extra detection', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-reason-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const getAdapter = () => new (require('../../adapters/validation/web-validator').WebValidator)();

  it('unavailableReason mentions playwright and cypress', async () => {
    const reason = await getAdapter().unavailableReason(tmpDir);
    assert.ok(reason.toLowerCase().includes('playwright') || reason.toLowerCase().includes('cypress'));
  });

  it('returns true when playwright (not @playwright/test) is in dependencies', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { playwright: '^1.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });

  it('returns true when cypress.config.js is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'cypress.config.js'), 'module.exports = {};');
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });
});

describe('Regression: MobileValidator — extra tooling detection', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-extra-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('unavailableReason when no config mentions detox/appium/expo', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MobileValidator } = require('../../adapters/validation/mobile-validator');
    const reason = await new MobileValidator().unavailableReason(tmpDir);
    assert.ok(
      reason.toLowerCase().includes('detox') ||
      reason.toLowerCase().includes('appium') ||
      reason.toLowerCase().includes('expo'),
    );
  });

  it('detects appium in devDependencies (returns false when no device)', async () => {
    const MobileValidatorModule = proxyquire('../../adapters/validation/mobile-validator', {
      'child_process': {
        spawn: () => ({ stdout: null, stderr: null, on: () => {}, kill: () => {} }),
        execSync: (_cmd: string) => { throw new Error('command not found'); },
      },
      'fs': fs,
      'path': path,
    });
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { appium: '^2.0.0' } }));
    const adapter = new MobileValidatorModule.MobileValidator();
    assert.equal(await adapter.isAvailable(tmpDir), false);
    const reason = await adapter.unavailableReason(tmpDir);
    assert.ok(reason.toLowerCase().includes('device') || reason.toLowerCase().includes('emulator') || reason.toLowerCase().includes('simulator'));
  });

  it('detects expo in devDependencies (returns false when no device)', async () => {
    const MobileValidatorModule = proxyquire('../../adapters/validation/mobile-validator', {
      'child_process': {
        spawn: () => ({ stdout: null, stderr: null, on: () => {}, kill: () => {} }),
        execSync: (_cmd: string) => { throw new Error('command not found'); },
      },
      'fs': fs,
      'path': path,
    });
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { expo: '^50.0.0' } }));
    const adapter = new MobileValidatorModule.MobileValidator();
    assert.equal(await adapter.isAvailable(tmpDir), false);
  });
});

describe('Regression: DesktopValidator.unavailableReason', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-reason-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const getAdapter = () => new (require('../../adapters/validation/desktop-validator').DesktopValidator)();

  it('unavailableReason mentions electron and winappdriver', async () => {
    const reason = await getAdapter().unavailableReason(tmpDir);
    assert.ok(reason.toLowerCase().includes('electron') || reason.toLowerCase().includes('winappdriver'));
  });

  it('returns true when winappdriver is in devDependencies (no marker file needed)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { winappdriver: '^1.0.0' } }));
    assert.equal(await getAdapter().isAvailable(tmpDir), true);
  });
});

// ─── 4. Manifest contract: browser UAT command + settings ─────────────────────

describe('Regression: browser UAT manifest contributions', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
  ) as {
    contributes: {
      commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
      configuration: { properties: Record<string, unknown> };
    };
  };

  it('declares agentTaskPlayer.provisionBrowsers in contributes.commands', () => {
    const cmd = pkg.contributes.commands.find((c) => c.command === 'agentTaskPlayer.provisionBrowsers');
    assert.ok(cmd, 'the command must be declared or the palette entry is dead');
    assert.equal(cmd!.title, 'Provision Browsers (Playwright)');
    assert.equal(cmd!.category, 'MOAG');
  });

  // The ceiling latch blocks every engine call once raised, and blocked calls
  // record nothing — so no further budget-exceeded fires to re-offer the inline
  // 'Reset Spend Counter' action. This command is the only always-reachable
  // escape; if it stops being contributed, a user who chose Stop on a breach is
  // stuck until they edit settings or reload the window.
  it('declares agentTaskPlayer.resetSpendCounter as the escape from the ceiling latch', () => {
    const cmd = pkg.contributes.commands.find((c) => c.command === 'agentTaskPlayer.resetSpendCounter');
    assert.ok(cmd, 'without this command a raised ceiling latch has no discoverable escape');
    assert.equal(cmd!.title, 'Reset Spend Counter');
    assert.equal(cmd!.category, 'MOAG');
  });

  it('leaves resetSpendCounter visible in the command palette', () => {
    const palette = pkg.contributes.menus['commandPalette'] ?? [];
    const hidden = palette.find(
      (m) => m.command === 'agentTaskPlayer.resetSpendCounter' && m.when === 'false',
    );
    assert.equal(hidden, undefined, 'the ceiling escape must never be hidden from the palette');
  });

  it('leaves provisionBrowsers visible in the command palette', () => {
    const palette = pkg.contributes.menus['commandPalette'] ?? [];
    const hidden = palette.find(
      (m) => m.command === 'agentTaskPlayer.provisionBrowsers' && m.when === 'false',
    );
    assert.equal(hidden, undefined, 'provisionBrowsers is user-facing — it must not be hidden');
  });

  it('places provisionBrowsers in the sandbox menu group', () => {
    const entries = Object.values(pkg.contributes.menus).flat();
    const placed = entries.find((m) => m.command === 'agentTaskPlayer.provisionBrowsers');
    assert.ok(placed, 'an undeclared menu placement makes the command unreachable from the UI');
    assert.match(placed!.group ?? '', /^4_sandbox@/);
  });

  it('declares every prdLoop.uat.* setting getPrdLoopConfig reads', () => {
    // These four keys are read verbatim by getPrdLoopConfig / buildVerifyConfig.
    // A missing declaration means the default silently wins and the setting is
    // invisible in the Settings UI.
    const required = [
      'agentTaskPlayer.prdLoop.uat.mode',
      'agentTaskPlayer.prdLoop.uat.command',
      'agentTaskPlayer.prdLoop.uat.specPath',
      'agentTaskPlayer.prdLoop.uat.timeoutMs',
      'agentTaskPlayer.browser.playwrightVersion',
    ];
    for (const key of required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(pkg.contributes.configuration.properties, key),
        `${key} is read at runtime but missing from contributes.configuration`,
      );
    }
  });

  it('locks the uat.mode enum to off/auto/required with an auto default', () => {
    const prop = pkg.contributes.configuration.properties['agentTaskPlayer.prdLoop.uat.mode'] as {
      enum: string[];
      default: string;
      enumDescriptions?: string[];
    };
    assert.deepEqual(prop.enum, ['off', 'auto', 'required']);
    assert.equal(prop.default, 'auto');
    assert.equal(prop.enumDescriptions?.length, 3, 'every enum member needs a description');
    assert.match(prop.enumDescriptions![2], /fix-generation|FAILS/i, 'required must state its cost');
  });

  it('pins a concrete playwright version — never "latest"', () => {
    const prop = pkg.contributes.configuration.properties['agentTaskPlayer.browser.playwrightVersion'] as {
      default: string;
    };
    assert.equal(prop.default, '1.62.1');
    assert.notEqual(prop.default, 'latest');
  });
});

// ─── 5. Engine call-site census ───────────────────────────────────────────────
//
// Every engine call must be reachable by cost accounting and by cancellation.
// These are mechanical guards against the two holes regrowing:
//   * a new `.runTask(` site that forgets `costLabel` (spend nobody attributes)
//   * `new AbortController().signal` inline (a Cancel button that cannot fire)
//   * `new SomeAdapter()` in production (bypasses the accounting wrapper)

describe('Regression: engine call-site census', () => {
  const SRC_ROOT = path.join(__dirname, '..', '..');

  /** Repo-relative, forward-slashed path — stable across platforms. */
  function relative(file: string): string {
    return path.relative(SRC_ROOT, file).split(path.sep).join('/');
  }

  /** Every .ts file under src/, excluding the test tree itself. */
  function productionFiles(dir: string = SRC_ROOT): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === 'node_modules') { continue; }
        out.push(...productionFiles(full));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  /** Count non-overlapping matches of a global regex in a string. */
  function countMatches(text: string, pattern: RegExp): number {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    return (text.match(re) ?? []).length;
  }

  /** Map from repo-relative file to its match count, for files with at least one. */
  function census(pattern: RegExp, files: string[]): Map<string, number> {
    const found = new Map<string, number>();
    for (const file of files) {
      const n = countMatches(fs.readFileSync(file, 'utf-8'), pattern);
      if (n > 0) { found.set(relative(file), n); }
    }
    return found;
  }

  const RUN_TASK = /\.runTask\(/g;
  const INLINE_ABORT_SIGNAL = /new AbortController\(\)\s*\.signal/g;
  const DIRECT_ADAPTER = /new \w*Adapter\(/g;

  // Sanity: a census helper whose regex silently matched nothing would make
  // every assertion below pass vacuously. Prove it detects known content.
  it('the census helper detects violations in a synthetic input', () => {
    const synthetic = [
      'await engine.runTask({ prompt });',
      'const s = new AbortController().signal;',
      'const a = new ClaudeAdapter();',
      'x.runTask(y);',
    ].join('\n');

    assert.equal(countMatches(synthetic, RUN_TASK), 2, 'runTask regex must find both call sites');
    assert.equal(countMatches(synthetic, INLINE_ABORT_SIGNAL), 1);
    assert.equal(countMatches(synthetic, DIRECT_ADAPTER), 1);
    assert.equal(countMatches('nothing to see here', RUN_TASK), 0);
  });

  it('scans a non-empty production file set outside src/test', () => {
    const files = productionFiles();
    assert.ok(files.length > 50, `expected the whole src tree, got ${files.length} files`);
    assert.ok(
      files.every((f) => !relative(f).startsWith('test/')),
      'src/test must be excluded from the census',
    );
    assert.ok(files.some((f) => relative(f) === 'adapters/engine.ts'), 'scan must reach src/adapters');
  });

  it('holds the engine call-site allowlist at exactly 17 sites, each labelled', () => {
    // Every entry is a call site that must carry a costLabel and a reachable
    // AbortSignal. src/adapters/engine.ts is excluded and asserted separately:
    // its single `.runTask(` is the accounting wrapper delegating inward.
    const ALLOWLIST = new Map<string, number>([
      // 4 of these moved to ui/prd-authoring.ts when extension.ts was split;
      // the total is unchanged at 17, which is what this census exists to prove.
      ['extension.ts', 8],
      ['ui/prd-authoring.ts', 4],
      ['runner/runner.ts', 2],
      ['ui/execution-detail-panel.ts', 2],
      ['headless/cli.ts', 1],
    ]);
    const ACCOUNTING_LAYER = 'adapters/engine.ts';

    const expectedTotal = Array.from(ALLOWLIST.values()).reduce((a, b) => a + b, 0);
    assert.equal(expectedTotal, 17, 'the allowlist itself must total 17');

    const found = census(RUN_TASK, productionFiles());

    assert.equal(
      found.get(ACCOUNTING_LAYER),
      1,
      'withCostAccounting() must delegate to the inner adapter exactly once',
    );
    found.delete(ACCOUNTING_LAYER);

    for (const [file, count] of found) {
      const allowed = ALLOWLIST.get(file);
      assert.ok(
        allowed !== undefined,
        `New engine call site in src/${file}. Before adding it to the census ` +
        'allowlist in this test, give it a costLabel and a reachable AbortSignal — ' +
        'an unlabelled call spends money nothing attributes, and an unreachable ' +
        'signal is a Cancel button that does nothing.',
      );
      assert.equal(
        count,
        allowed,
        `src/${file} has ${count} .runTask( sites, allowlist says ${allowed}. ` +
        'Give the new call a costLabel and a reachable AbortSignal, then update the allowlist.',
      );
    }

    for (const file of ALLOWLIST.keys()) {
      assert.ok(
        found.has(file),
        `src/${file} no longer calls runTask — shrink the allowlist rather than leaving it stale.`,
      );
    }

    const total = Array.from(found.values()).reduce((a, b) => a + b, 0);
    assert.equal(total, 17, `expected 17 engine call sites outside the accounting layer, found ${total}`);
  });

  it('has no inline `new AbortController().signal` in production code', () => {
    const found = census(INLINE_ABORT_SIGNAL, productionFiles());
    assert.deepEqual(
      Array.from(found.keys()),
      [],
      'An inline `new AbortController().signal` is a controller nobody can abort. ' +
      'Create the controller, wire it to a cancellation token, and pass its signal.',
    );
  });

  it('constructs no adapter directly outside src/adapters', () => {
    const files = productionFiles().filter((f) => !relative(f).startsWith('adapters/'));
    const found = census(DIRECT_ADAPTER, files);
    assert.deepEqual(
      Array.from(found.keys()),
      [],
      'Direct adapter construction bypasses withCostAccounting(). ' +
      'Use getEngine()/getAllEngines() instead.',
    );
  });
});

// ─── Webview scripts must actually parse ──────────────────────────────────────
//
// The sidebar's JavaScript lives inside a TypeScript template literal, so `tsc`
// never parses it — it is a string as far as the compiler is concerned. Two
// different defects shipped that way and were invisible until a real VSIX was
// installed, at which point the whole view went dead because a SyntaxError
// aborts the entire script before a single handler attaches:
//
//   1. `(e.target as HTMLElement)` — a TypeScript cast, meaningless in a browser.
//   2. `onclick="...({type:\'createPR\'})"` — inside a template literal the \'
//      collapses to ' before the webview sees it, closing the JS string early.
//
// Pattern-matching for "suspicious syntax" caught the first and missed the
// second. So this parses the real rendered script instead: new Function(body)
// throws on any syntax error without executing anything.

describe('Regression: the sidebar webview script', () => {
  // The script used to be 2,869 lines inside a template literal in
  // prompt-input-view.ts, where tsc never parsed it. Two SyntaxErrors reached
  // users that way and a ReferenceError came within one command of doing so.
  //
  // It is now src/webview/sidebar.ts, compiled by tsconfig.webview.json — so the
  // compiler is the primary guard and these are the backstop. They check the
  // shipped artifact and the wiring that loads it, neither of which tsc covers.
  const COMPILED = 'out/webview/sidebar.js';

  function renderSidebarHtml(): string {
    const mod = proxyquire('../../ui/prompt-input-view', { vscode: vscodeMock });
    const Provider = mod.PromptInputViewProvider;
    const provider = new Provider(
      { fsPath: '/tmp/ext', scheme: 'file', path: '/tmp/ext' },
      async () => true,
      () => undefined,
      async () => undefined,
      () => undefined,
    );
    // _getHtml now needs a webview to build the script URI and a CSP source.
    return provider['_getHtml']({
      asWebviewUri: (u: { fsPath?: string }) => 'vscode-resource://' + (u.fsPath ?? 'x'),
      cspSource: 'vscode-resource:',
    });
  }

  function compiled(): string {
    return fsMod.readFileSync(COMPILED, 'utf-8');
  }

  it('is emitted as a real file by the build', () => {
    assert.ok(fsMod.existsSync(COMPILED),
      `${COMPILED} is missing — run npm run compile, which must build the webview too`);
    assert.ok(compiled().length > 50_000, 'the compiled script is implausibly small');
  });

  it('emits a plain browser script, not a CommonJS module', () => {
    // module: "none" matters — a webview cannot execute exports/require.
    const js = compiled();
    assert.ok(!js.includes('Object.defineProperty(exports'), 'CommonJS wrapper would not run in a webview');
    assert.ok(!/^\s*require\(/m.test(js), 'require() would not resolve in a webview');
  });

  it('parses as JavaScript', () => {
    // Redundant with tsc today, and deliberately so: it asserts the ARTIFACT is
    // valid, which survives someone changing how it is produced.
    try {
      new Function(compiled());
    } catch (err) {
      assert.fail(`compiled sidebar script does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  it('uses no ICON_ constant it does not declare', () => {
    const js = compiled();
    const declared = new Set([...js.matchAll(/\bconst (ICON_[A-Z_]+)\s*=/g)].map((m) => m[1]));
    const used = new Set([...js.matchAll(/\b(ICON_[A-Z_]+)\b/g)].map((m) => m[1]));
    const undeclared = [...used].filter((n) => !declared.has(n));
    assert.deepEqual(undeclared, [],
      'used in the webview but never declared — a ReferenceError at runtime');
  });

  it('is loaded by the rendered page with a nonce the CSP admits', () => {
    const html = renderSidebarHtml();
    const tag = /<script\b([^>]*)>/.exec(html);
    assert.ok(tag, 'the rendered page loads no script at all');

    const nonce = /nonce="([^"]+)"/.exec(tag![1]);
    assert.ok(nonce, 'the script tag carries no nonce');
    assert.ok(/src="[^"]*sidebar\.js"/.test(tag![1]), 'the script tag does not point at sidebar.js');

    const csp = /Content-Security-Policy[^>]*content="([^"]*)"/.exec(html);
    assert.ok(csp, 'the page declares no Content-Security-Policy');
    assert.ok(csp![1].includes(`nonce-${nonce![1]}`),
      'the CSP does not admit the nonce on the script tag, so it would not execute');
  });

  it('inlines no script body, which is what the compiler could not see', () => {
    const html = renderSidebarHtml();
    const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1].trim())
      .filter((b) => b.length > 0);
    assert.deepEqual(inline, [],
      'an inline script body is unchecked JavaScript — put it in src/webview/ instead');
  });
});


// ─── Closed-enumeration guards must be derived, not re-enumerated ─────────────
//
// `isEngineId` in extension.ts was hand-written and listed five of the seven
// EngineId members, so selecting Copilot or Anthropic silently fell through to
// the default engine at both call sites. EngineId is now derived from
// ENGINE_IDS so the two cannot drift, and any guard must read that array.
//
// The same class of defect motivated deriving isRoleId from ROLE_IDS.

describe('Regression: closed-enumeration guards stay complete', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ENGINE_IDS } = require('../../models/types');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ROLE_IDS, isRoleId } = require('../../models/roles');

  it('ENGINE_IDS carries every engine an adapter is registered for', () => {
    // These are the seven the product ships. A new engine must be added here
    // deliberately, which is the point — silent omission is what broke before.
    const expected = ['codex', 'claude', 'gemini', 'ollama', 'custom', 'copilot', 'anthropic'];
    assert.deepEqual([...ENGINE_IDS].sort(), expected.sort());
  });

  it('no source file re-enumerates engine ids in a boolean chain', () => {
    const extSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'extension.ts'), 'utf-8');
    // The exact shape of the old bug: `value === 'claude' || value === 'codex' || ...`
    const chain = /===\s*'(?:codex|claude|gemini|ollama|copilot|anthropic)'\s*\n?\s*\|\|/;
    assert.equal(
      chain.test(extSrc),
      false,
      'an engine-id guard is re-enumerating members by hand — read ENGINE_IDS instead, '
      + 'or the next engine added will be silently rejected',
    );
  });

  it('isRoleId accepts every member of ROLE_IDS and nothing else', () => {
    for (const id of ROLE_IDS) {
      assert.equal(isRoleId(id), true, `isRoleId rejected a real member: ${id}`);
    }
    for (const bogus of ['Engineer', 'senior-backend-engineer', '', 'role', undefined, null, 42]) {
      assert.equal(isRoleId(bogus), false, `isRoleId accepted a non-member: ${String(bogus)}`);
    }
  });

  it('the history storage cap agrees between the manifest and the code fallback', () => {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const declared = pkg.contributes.configuration.properties['agentTaskPlayer.maxHistoryStorageBytes'].default;
    const storeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'history', 'store.ts'), 'utf-8');
    const match = storeSrc.match(/get<number>\('maxHistoryStorageBytes',\s*([\d_]+)\)/);
    assert.ok(match, 'could not find the maxHistoryStorageBytes fallback in store.ts');
    const fallback = Number(match![1].replace(/_/g, ''));
    assert.equal(
      fallback,
      declared,
      'headless reads .moag/config.json, which usually has no such key, so it hits this '
      + 'fallback while VS Code gets the manifest default — they must be the same number',
    );
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsMod = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pathMod = require('path');

// `agentTaskPlayer.createPlan` was referenced from two buttons and registered
// nowhere, so clicking "New Plan" silently did nothing. Nothing in the type
// system connects a command id string to its registration, so check it here.
describe('Regression: every command id referenced in code is registered', () => {
  const SRC_DIR = "src";

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
      const full = pathMod.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "test") { continue; }
        out.push(...walk(full));
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it('references no command that is neither registered nor declared', () => {
    const files = walk(SRC_DIR);
    const all = files.map((f) => fsMod.readFileSync(f, "utf-8")).join(String.fromCharCode(10));

    const registered = new Set(
      [...all.matchAll(/registerCommand\(\s*['\"`]([a-zA-Z.]+)/g)].map((m) => m[1]),
    );
    // Commands contributed by VS Code itself or other extensions are fine.
    // Narrow to strings actually used as commands. `agentTaskPlayer.*` is also
    // the prefix for settings keys and view ids, which are not commands at all.
    const referenced = [
      ...all.matchAll(/executeCommand\(\s*['\"`](agentTaskPlayer\.[a-zA-Z]+)/g),
      ...all.matchAll(/command:\s*['\"`](agentTaskPlayer\.[a-zA-Z]+)/g),
    ].map((m) => m[1]);

    const manifest = new Set(
      (JSON.parse(fsMod.readFileSync("package.json", "utf-8")).contributes.commands as Array<{ command: string }>)
        .map((c) => c.command),
    );

    const dangling = [...new Set(referenced)]
      .filter((id) => !registered.has(id) && !manifest.has(id))
      .sort();

    assert.deepEqual(dangling, [],
      "these command ids are referenced but never registered — the button does nothing");
  });
});
