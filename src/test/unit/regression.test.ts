// ─── Regression: legacy plan compatibility, adapter capability, semantic fallback ───
//
// Three focused areas:
//   1. Legacy plan hydration — partial / missing fields produce correct defaults
//   2. Validator isAvailable() — filesystem-based detection; run() returns skipped result
//   3. runRetrievalCascade — falls back to rg spans when semantic is absent or low-confidence

import { strict as assert } from 'assert';
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
  const { hydratePlan } = require('../../models/plan');

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
    assert.ok(result.spans.some((s: any) => s.content.includes('TaskRunner')));
    assert.ok(result.spans.every((s: any) => s.confidence <= 0.65));
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
    assert.ok(result.spans.some((s: any) => s.content.includes('authenticate_user')));
  });

  it('returns usedSemantic=true and high-confidence spans when semantic has results', async () => {
    const semanticSpans = [
      { filePath: 'src/runner.ts', startLine: 1, endLine: 3, content: 'class TaskRunner {}', confidence: 0.9 },
    ];
    const runRetrievalCascade = loadCascade(semanticSpans);

    fs.writeFileSync(path.join(tmpDir, 'src', 'runner.ts'), 'class TaskRunner {}');

    const result = await runRetrievalCascade(makeTask('Fix TaskRunner'), tmpDir, 50000);
    assert.equal(result.usedSemantic, true);
    assert.ok(result.spans.some((s: any) => s.confidence === 0.9));
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
    assert.ok(result.spans.some((s: any) => s.filePath === 'src/runner.ts' && s.confidence === 0.85));
    // rg/hint span for config.ts (uncovered file)
    assert.ok(result.spans.some((s: any) => s.filePath === 'src/config.ts'));
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
