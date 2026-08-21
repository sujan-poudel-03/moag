import * as assert from 'assert';
import {
  VALIDATION_PROFILE_CONFIGS,
  resolveValidationProfile,
  resolveProfile,
  resolveTaskTimeoutMs,
} from '../../../models/execution-profiles';

describe('VALIDATION_PROFILE_CONFIGS', () => {
  it('quick: only lint and unit stages', () => {
    const cfg = VALIDATION_PROFILE_CONFIGS.quick;
    assert.deepEqual(cfg.stages.sort(), ['lint', 'unit'].sort());
    assert.strictEqual(cfg.parallelTargets, 1);
    assert.ok(cfg.maxWallClockMs <= 5 * 60 * 1000);
  });

  it('pr: all four stages including e2e', () => {
    const cfg = VALIDATION_PROFILE_CONFIGS.pr;
    assert.ok(cfg.stages.includes('lint'));
    assert.ok(cfg.stages.includes('unit'));
    assert.ok(cfg.stages.includes('integration'));
    assert.ok(cfg.stages.includes('e2e'));
    assert.strictEqual(cfg.parallelTargets, 2);
    assert.ok(cfg.maxWallClockMs > 5 * 60 * 1000);
  });

  it('full: all stages with highest parallelism', () => {
    const cfg = VALIDATION_PROFILE_CONFIGS.full;
    assert.deepEqual(cfg.stages.sort(), ['e2e', 'integration', 'lint', 'unit'].sort());
    assert.ok(cfg.parallelTargets >= 3);
    assert.ok(cfg.maxWallClockMs >= 30 * 60 * 1000);
  });

  it('quick has fewer stages than pr', () => {
    assert.ok(VALIDATION_PROFILE_CONFIGS.quick.stages.length < VALIDATION_PROFILE_CONFIGS.pr.stages.length);
  });

  it('full wall-clock budget is larger than pr', () => {
    assert.ok(VALIDATION_PROFILE_CONFIGS.full.maxWallClockMs > VALIDATION_PROFILE_CONFIGS.pr.maxWallClockMs);
  });

  it('pr wall-clock budget is larger than quick', () => {
    assert.ok(VALIDATION_PROFILE_CONFIGS.pr.maxWallClockMs > VALIDATION_PROFILE_CONFIGS.quick.maxWallClockMs);
  });
});

describe('resolveValidationProfile', () => {
  it('resolves quick', () => {
    const cfg = resolveValidationProfile('quick');
    assert.ok(!cfg.stages.includes('e2e'));
    assert.ok(!cfg.stages.includes('integration'));
  });

  it('resolves pr', () => {
    const cfg = resolveValidationProfile('pr');
    assert.ok(cfg.stages.includes('e2e'));
    assert.strictEqual(cfg.parallelTargets, 2);
  });

  it('resolves full', () => {
    const cfg = resolveValidationProfile('full');
    assert.strictEqual(cfg.parallelTargets, 3);
    assert.deepEqual(cfg.stages.sort(), ['e2e', 'integration', 'lint', 'unit'].sort());
  });

  it('falls back to quick for unknown profile', () => {
    const cfg = resolveValidationProfile('unknown');
    assert.deepEqual(cfg.stages.sort(), VALIDATION_PROFILE_CONFIGS.quick.stages.sort());
  });

  it('returned config is the same object as the map entry for known profiles', () => {
    assert.strictEqual(resolveValidationProfile('pr'), VALIDATION_PROFILE_CONFIGS.pr);
    assert.strictEqual(resolveValidationProfile('full'), VALIDATION_PROFILE_CONFIGS.full);
  });
});

describe('resolveProfile (engine profiles)', () => {
  it('auto resolves to balanced', () => {
    const cfg = resolveProfile('auto');
    assert.strictEqual(cfg.modelPreset, 'balanced');
    assert.ok(cfg.autoFix);
  });

  it('fast has no auto-fix and short timeout', () => {
    const cfg = resolveProfile('fast');
    assert.strictEqual(cfg.autoFix, false);
    assert.ok(cfg.taskTimeoutMs <= 15 * 60 * 1000);
  });

  it('quality has deep model and auto-fix', () => {
    const cfg = resolveProfile('quality');
    assert.strictEqual(cfg.modelPreset, 'deep');
    assert.ok(cfg.autoFix);
  });

  it('budget uses ollama', () => {
    const cfg = resolveProfile('budget');
    assert.strictEqual(cfg.preferredEngine, 'ollama');
  });

  it('unknown profile falls back to balanced', () => {
    const cfg = resolveProfile('nonexistent');
    assert.strictEqual(cfg.modelPreset, 'balanced');
  });
});

describe('resolveTaskTimeoutMs', () => {
  const SERVICE_DEFAULT = 60_000;
  const PROFILE_DEFAULT = 30 * 60 * 1000;

  it('task timeoutMs beats both the setting and the profile', () => {
    const ms = resolveTaskTimeoutMs({
      isService: false,
      taskTimeoutMs: 900_000,
      serviceDefaultMs: SERVICE_DEFAULT,
      settingOverrideMs: 120_000,
      profileTimeoutMs: PROFILE_DEFAULT,
    });
    assert.strictEqual(ms, 900_000);
  });

  it('setting override is used when the task has no timeoutMs', () => {
    const ms = resolveTaskTimeoutMs({
      isService: false,
      serviceDefaultMs: SERVICE_DEFAULT,
      settingOverrideMs: 120_000,
      profileTimeoutMs: PROFILE_DEFAULT,
    });
    assert.strictEqual(ms, 120_000);
  });

  it('profile timeout is used when neither task nor setting provides one', () => {
    const ms = resolveTaskTimeoutMs({
      isService: false,
      serviceDefaultMs: SERVICE_DEFAULT,
      profileTimeoutMs: PROFILE_DEFAULT,
    });
    assert.strictEqual(ms, PROFILE_DEFAULT);
  });

  it('service tasks use startupTimeoutMs and ignore taskTimeoutMs', () => {
    const ms = resolveTaskTimeoutMs({
      isService: true,
      taskTimeoutMs: 900_000,
      startupTimeoutMs: 45_000,
      serviceDefaultMs: SERVICE_DEFAULT,
      settingOverrideMs: 120_000,
      profileTimeoutMs: PROFILE_DEFAULT,
    });
    assert.strictEqual(ms, 45_000);
  });

  it('service tasks fall back to the service default, never to taskTimeoutMs', () => {
    const ms = resolveTaskTimeoutMs({
      isService: true,
      taskTimeoutMs: 900_000,
      serviceDefaultMs: SERVICE_DEFAULT,
      settingOverrideMs: 120_000,
      profileTimeoutMs: PROFILE_DEFAULT,
    });
    assert.strictEqual(ms, SERVICE_DEFAULT);
  });

  it('treats an explicit 0 setting override as a real value, not a fallback trigger', () => {
    const ms = resolveTaskTimeoutMs({
      isService: false,
      serviceDefaultMs: SERVICE_DEFAULT,
      settingOverrideMs: 0,
      profileTimeoutMs: PROFILE_DEFAULT,
    });
    assert.strictEqual(ms, 0);
  });
});
