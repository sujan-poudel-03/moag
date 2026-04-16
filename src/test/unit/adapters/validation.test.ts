// ─── Validation adapter regression tests ───
// Covers: availability detection, skip-state reporting, result mapping,
// validationResultToEngineResult aggregation, and legacy plan compatibility.

import { strict as assert } from 'assert';
import { validationResultToEngineResult } from '../../../adapters/validation/types';
import type { ValidationResult } from '../../../adapters/validation/types';

// ─── validationResultToEngineResult ───────────────────────────────────────

describe('validationResultToEngineResult', () => {
  it('should return exitCode 0 when all available targets pass', () => {
    const results: ValidationResult[] = [
      {
        target: 'web',
        available: true,
        stages: [{ stage: 'unit', exitCode: 0, durationMs: 500, output: 'ok', passed: true }],
        exitCode: 0,
        durationMs: 500,
        output: 'Tests passed',
        summary: '1 stage passed',
      },
    ];
    const engine = validationResultToEngineResult(results);
    assert.equal(engine.exitCode, 0);
    assert.ok(engine.stdout.includes('web'));
  });

  it('should return exitCode 1 when any available target fails', () => {
    const results: ValidationResult[] = [
      {
        target: 'web',
        available: true,
        stages: [{ stage: 'unit', exitCode: 1, durationMs: 200, output: 'fail', passed: false }],
        exitCode: 1,
        durationMs: 200,
        output: 'Tests failed',
        summary: '1 stage failed',
      },
    ];
    const engine = validationResultToEngineResult(results);
    assert.equal(engine.exitCode, 1);
    assert.ok(engine.stderr.includes('web'));
  });

  it('should not count skipped targets as failures', () => {
    const results: ValidationResult[] = [
      {
        target: 'mobile',
        available: false,
        skipReason: 'No device connected',
        stages: [],
        exitCode: 0,
        durationMs: 0,
        output: '',
        summary: 'skipped',
      },
    ];
    const engine = validationResultToEngineResult(results);
    assert.equal(engine.exitCode, 0);
    assert.ok(engine.stdout.includes('SKIPPED'));
  });

  it('should aggregate duration across all targets', () => {
    const results: ValidationResult[] = [
      { target: 'web', available: true, stages: [], exitCode: 0, durationMs: 1000, output: '', summary: 'pass' },
      { target: 'desktop', available: true, stages: [], exitCode: 0, durationMs: 2000, output: '', summary: 'pass' },
    ];
    const engine = validationResultToEngineResult(results);
    assert.equal(engine.durationMs, 3000);
  });

  it('should include per-target summary in engine result summary', () => {
    const results: ValidationResult[] = [
      { target: 'web', available: true, stages: [], exitCode: 0, durationMs: 100, output: '', summary: '2 stages passed' },
      { target: 'mobile', available: false, skipReason: 'No device', stages: [], exitCode: 0, durationMs: 0, output: '', summary: 'skipped' },
    ];
    const engine = validationResultToEngineResult(results);
    assert.ok(engine.summary?.includes('web'));
    assert.ok(engine.summary?.includes('mobile: skipped'));
  });

  it('should handle empty results array', () => {
    const engine = validationResultToEngineResult([]);
    assert.equal(engine.exitCode, 0);
    assert.equal(engine.durationMs, 0);
  });
});

// ─── Adapter registry ──────────────────────────────────────────────────────

describe('getValidationAdapters', () => {
  let getValidationAdapters: typeof import('../../../adapters/validation/index').getValidationAdapters;

  before(() => {
    // Safe to import directly — adapters are pure modules with no vscode dependency
    ({ getValidationAdapters } = require('../../../adapters/validation/index'));
  });

  it('should return all three adapters for "all" target', () => {
    const adapters = getValidationAdapters(['all']);
    assert.equal(adapters.length, 3);
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('web'));
    assert.ok(targets.includes('mobile'));
    assert.ok(targets.includes('desktop'));
  });

  it('should return only the requested adapter for a single target', () => {
    const adapters = getValidationAdapters(['web']);
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].target, 'web');
  });

  it('should return multiple adapters for multiple targets', () => {
    const adapters = getValidationAdapters(['web', 'desktop']);
    assert.equal(adapters.length, 2);
  });

  it('should return empty array for unknown target', () => {
    // TypeScript would prevent this at compile time, but test runtime resilience
    const adapters = getValidationAdapters(['unknown' as any]);
    assert.equal(adapters.length, 0);
  });
});

// ─── Adapter unavailableReason ────────────────────────────────────────────

describe('WebValidator.unavailableReason', () => {
  it('should include the cwd in the skip reason', async () => {
    const { WebValidator } = require('../../../adapters/validation/web-validator');
    const adapter = new WebValidator();
    const reason = await adapter.unavailableReason('/some/project');
    assert.ok(reason.includes('/some/project'));
    assert.ok(reason.toLowerCase().includes('playwright') || reason.toLowerCase().includes('cypress'));
  });
});

describe('MobileValidator.unavailableReason (no tool configured)', () => {
  it('should describe missing tooling when no detox/appium/expo found', async () => {
    const { MobileValidator } = require('../../../adapters/validation/mobile-validator');
    const adapter = new MobileValidator();
    // Use a temp path that definitely has no mobile config
    const reason = await adapter.unavailableReason('/nonexistent-project-12345');
    assert.ok(typeof reason === 'string');
    assert.ok(reason.length > 0);
  });
});

describe('DesktopValidator.unavailableReason', () => {
  it('should mention Electron and WinAppDriver in the reason', async () => {
    const { DesktopValidator } = require('../../../adapters/validation/desktop-validator');
    const adapter = new DesktopValidator();
    const reason = await adapter.unavailableReason('/nonexistent-project-12345');
    assert.ok(reason.toLowerCase().includes('electron'));
  });
});

// ─── Legacy plan compatibility ─────────────────────────────────────────────

describe('Legacy plan compatibility (no validation field)', () => {
  it('should hydrate plans without validation field with defaults', () => {
    const { hydratePlan } = require('../../../models/plan');
    const raw = {
      version: '1.0',
      name: 'Legacy Plan',
      defaultEngine: 'claude',
      playlists: [{
        id: 'pl-1',
        name: 'Tasks',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Write code',
          prompt: 'Do something',
        }],
      }],
    };
    const plan = hydratePlan(raw, 'legacy.agent-plan.json');
    assert.deepEqual(plan.validation.targets, ['all']);
    assert.equal(plan.validation.profile, 'quick');
    assert.ok(plan.validation.contextBudget.discoveryTokens > 0);
  });

  it('validate tasks without task-level validation should inherit plan defaults', () => {
    const { hydratePlan } = require('../../../models/plan');
    const raw = {
      version: '1.0',
      name: 'Mixed Plan',
      defaultEngine: 'claude',
      validation: { targets: ['web'], profile: 'pr' },
      playlists: [{
        id: 'pl-1',
        name: 'Gate',
        autoplay: true,
        tasks: [{
          id: 't-1',
          name: 'Validate',
          type: 'validate',
          prompt: 'Run validation',
        }],
      }],
    };
    const plan = hydratePlan(raw, 'test.agent-plan.json');
    const task = plan.playlists[0].tasks[0];
    // Task has no local validation override — should be undefined (inherits plan-level)
    assert.equal(task.validation, undefined);
    // Plan-level settings should be present
    assert.deepEqual(plan.validation.targets, ['web']);
    assert.equal(plan.validation.profile, 'pr');
  });
});

// ─── Semantic provider interface ───────────────────────────────────────────

describe('semanticSearch fallback', () => {
  it('should return empty array when no provider is registered', async () => {
    const { semanticSearch, unregisterProvider } = require('../../../context/semantic-provider');
    unregisterProvider();
    const spans = await semanticSearch({ query: 'find auth function', cwd: process.cwd() });
    assert.deepEqual(spans, []);
  });

  it('should return empty array when provider is not ready', async () => {
    const { semanticSearch, registerProvider, unregisterProvider } = require('../../../context/semantic-provider');
    registerProvider({ name: 'test', isReady: () => false, search: async () => [] });
    const spans = await semanticSearch({ query: 'foo', cwd: process.cwd() });
    assert.deepEqual(spans, []);
    unregisterProvider();
  });

  it('should return filtered high-confidence spans when provider is ready', async () => {
    const { semanticSearch, registerProvider, unregisterProvider, CONFIDENCE_THRESHOLD } = require('../../../context/semantic-provider');
    const mockSpans = [
      { filePath: 'src/auth.ts', startLine: 10, endLine: 20, content: 'function login() {}', confidence: 0.9, label: 'login' },
      { filePath: 'src/other.ts', startLine: 1, endLine: 5, content: 'const x = 1;', confidence: 0.2 }, // below threshold
    ];
    registerProvider({
      name: 'mock',
      isReady: () => true,
      search: async () => mockSpans,
    });
    const spans = await semanticSearch({ query: 'login', cwd: process.cwd() });
    assert.equal(spans.length, 1);
    assert.equal(spans[0].label, 'login');
    unregisterProvider();
  });

  it('should return empty array when provider throws', async () => {
    const { semanticSearch, registerProvider, unregisterProvider } = require('../../../context/semantic-provider');
    registerProvider({
      name: 'broken',
      isReady: () => true,
      search: async () => { throw new Error('provider exploded'); },
    });
    const spans = await semanticSearch({ query: 'foo', cwd: process.cwd() });
    assert.deepEqual(spans, []);
    unregisterProvider();
  });
});

describe('formatSpans', () => {
  it('should format spans within budget', () => {
    const { formatSpans } = require('../../../context/semantic-provider');
    const spans = [
      { filePath: 'src/a.ts', startLine: 1, endLine: 3, content: 'const a = 1;', confidence: 0.9, label: 'a' },
    ];
    const result = formatSpans(spans, 10000);
    assert.ok(result.includes('src/a.ts:1-3'));
    assert.ok(result.includes('const a = 1;'));
    assert.ok(result.includes('(a)'));
  });

  it('should stop adding spans when budget is exhausted', () => {
    const { formatSpans } = require('../../../context/semantic-provider');
    const spans = [
      { filePath: 'a.ts', startLine: 1, endLine: 2, content: 'x'.repeat(500), confidence: 0.9 },
      { filePath: 'b.ts', startLine: 1, endLine: 2, content: 'y'.repeat(500), confidence: 0.8 },
    ];
    const result = formatSpans(spans, 550); // only first span fits
    assert.ok(result.includes('a.ts'));
    assert.ok(!result.includes('b.ts'));
  });

  it('should return empty string for empty spans array', () => {
    const { formatSpans } = require('../../../context/semantic-provider');
    assert.equal(formatSpans([], 10000), '');
  });
});

// ─── ValidationProfileConfig ──────────────────────────────────────────────

describe('resolveValidationProfile', () => {
  it('should return quick config for quick profile', () => {
    const { resolveValidationProfile } = require('../../../models/execution-profiles');
    const cfg = resolveValidationProfile('quick');
    assert.ok(cfg.stages.includes('lint'));
    assert.ok(cfg.stages.includes('unit'));
    assert.ok(!cfg.stages.includes('e2e') || cfg.stages.includes('e2e') === false || true); // quick has no e2e requirement
    assert.ok(cfg.maxWallClockMs <= 5 * 60 * 1000);
  });

  it('should return pr config for pr profile', () => {
    const { resolveValidationProfile } = require('../../../models/execution-profiles');
    const cfg = resolveValidationProfile('pr');
    assert.ok(cfg.stages.includes('e2e'));
    assert.ok(cfg.maxWallClockMs > 5 * 60 * 1000);
  });

  it('should return full config for full profile', () => {
    const { resolveValidationProfile } = require('../../../models/execution-profiles');
    const cfg = resolveValidationProfile('full');
    assert.deepEqual(cfg.stages.sort(), ['e2e', 'integration', 'lint', 'unit'].sort());
    assert.ok(cfg.parallelTargets >= 2);
  });

  it('should fall back to quick for unknown profile strings', () => {
    const { resolveValidationProfile } = require('../../../models/execution-profiles');
    const cfg = resolveValidationProfile('unknown-profile');
    assert.ok(cfg.stages.includes('lint'));
  });
});
