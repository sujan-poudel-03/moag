// ─── Anti-recurrence harness for the plan schema round trip ───
//
// Three fields (plan.aiRules, plan.prdVersions, plan.fixIterations) were once set and read
// at runtime while being absent from PlanFile/dehydratePlan, so they were silently dropped
// on every save. This file exists so that never happens again.
//
// The guard has two interlocked halves:
//   1. `TASK_FIELDS` / `PLAYLIST_FIELDS` / `PLAN_FIELDS` are `Record<keyof …, true>` maps.
//      When an interface gains a field, `tsc` fails here until the field is classified —
//      tsconfig includes `src/**/*`, so this is a compile gate, not an opt-in.
//   2. A runtime test asserts every key of each record is also present in the maximal
//      fixture, so the records and the fixture cannot quietly drift apart.
//
// RULE FOR THE NEXT READER: a mismatch here is a bug in the schema plumbing, not a missing
// exemption. Do NOT add an entry to the exemption block to make this test go green — fix
// hydrate/dehydrate so the field survives the round trip.

import { strict as assert } from 'assert';
import { hydratePlan, dehydratePlan, createEmptyPlan, createTask } from '../../../models/plan';
import { Plan, Playlist, Task, TaskStatus } from '../../../models/types';

// ─── Exemptions (verbatim reasoning — do not extend) ───
//
// Task.status === TaskStatus.Pending
//   dehydrateTask deliberately omits a Pending status (plan.ts:369) to keep plan files
//   clean, and hydrateTask restores it (plan.ts:277 → `|| TaskStatus.Pending`). It
//   round-trips to the same value, so it is not a dropped field. The fixture below uses
//   Completed so the persisted branch is exercised too.
//
// Plan.validation when every value is the default
//   dehydratePlan elides an all-default validation block (plan.ts:290) and
//   normalizePlanValidation re-defaults it on load (plan.ts:198). Same value out as in.
//   The fixture uses non-default values so the persisted branch is exercised.
//
// Runtime-only properties attached by cast, invisible to `keyof`
//   These are never part of Task/Playlist/Plan and must never be persisted:
//     _threadId, _turnIndex          (runner.ts:2536)
//     _profileModelPreset            (runner.ts:1117)
//     _modelId, _modelReason
//     _budgetUsage
//     _retrievedFiles
//     _validationTargetResults
//   They exist only for the duration of a run and are re-derived on the next one.

// ─── Maximal fixture — every optional field set to a distinguishable value ───

/**
 * Build a plan in which every field of Task, Playlist and Plan carries a value that is
 * unique enough to spot in a diff. IDs are unique across the whole plan on purpose:
 * `ensureUniqueIds` (plan.ts:209) rewrites duplicate or missing ids, which would show up
 * as a round-trip failure that has nothing to do with the schema.
 */
function buildMaximalFixture(): Plan {
  const task: Task = {
    id: 'fixture-task-1',
    name: 'fixture-task-name',
    prompt: 'fixture-task-prompt',
    type: 'service',
    engine: 'claude',
    role: 'reviewer',
    command: 'npm run fixture:dev',
    cwd: 'apps/fixture',
    env: { FIXTURE_ENV: 'fixture-env-value' },
    inheritEnvFiles: ['.env.fixture'],
    scopedVerify: true,
    files: ['src/fixture-a.ts', 'src/fixture-b.ts'],
    acceptanceCriteria: ['fixture-criterion-1', 'fixture-criterion-2'],
    verifyCommand: 'npm run fixture:verify',
    expectedArtifacts: ['dist/fixture.js'],
    ownerNote: 'fixture-ownerNote',
    failurePolicy: 'mark-blocked',
    port: 4101,
    readyPattern: 'fixture-ready-pattern',
    healthCheckUrl: 'http://localhost:4101/fixture-health',
    startupTimeoutMs: 4102,
    timeoutMs: 1_800_000,
    retryCount: 7,
    dependsOn: ['fixture-dep-task'],
    skipIf: { taskId: 'fixture-dep-task', status: TaskStatus.Skipped },
    consensus: { engines: ['claude', 'codex'], strategy: 'best-diff' },
    validation: {
      targets: ['desktop'],
      profile: 'full',
      contextBudget: {
        discoveryTokens: 4103,
        analysisTokens: 4104,
        fixTokens: 4105,
      },
    },
    sourceIssueNumber: 4106,
    sourceIssueRepo: 'fixture-owner/fixture-repo',
    releaseTag: 'v4.1.0-fixture',
    releaseNotes: 'fixture-releaseNotes',
    githubRelease: true,
    monitorSamples: 4107,
    monitorIntervalMs: 4108,
    failureThreshold: 4109,
    incidentRepo: 'fixture-owner/fixture-incidents',
    incidentLabel: 'fixture:incident',
    status: TaskStatus.Completed,
  };

  const playlist: Playlist = {
    id: 'fixture-playlist-1',
    name: 'fixture-playlist-name',
    engine: 'gemini',
    role: 'designer',
    autoplay: false,
    autoplayDelay: 4110,
    parallel: true,
    aiRules: 'fixture-playlist-aiRules',
    testPhase: true,
    prdContext: 'fixture-playlist-prdContext',
    tasks: [task],
  };

  const plan: Plan = {
    version: '1.0',
    name: 'fixture-plan-name',
    description: 'fixture-plan-description',
    defaultEngine: 'claude',
    fallbackEngine: 'codex',
    variables: { fixtureVar: 'fixture-variable-value' },
    defaultRole: 'engineer',
    customRoles: [
      { id: 'custom', name: 'fixture-role-name', charter: 'fixture-role-charter' },
    ],
    validation: {
      targets: ['web', 'mobile'],
      profile: 'pr',
      contextBudget: {
        discoveryTokens: 4111,
        analysisTokens: 4112,
        fixTokens: 4113,
      },
    },
    sandbox: {
      targets: [
        { name: 'fixture-Frontend', cwd: 'apps/web', command: 'npm run dev', port: 4114 },
      ],
      command: 'npm run dev:root',
      port: 4115,
    },
    aiRules: 'fixture-plan-aiRules',
    prdSource: 'fixture-plan-prdSource',
    prdVersions: [
      { version: 'v1', text: 'fixture-prd-v1', createdAt: '2026-01-01T00:00:00.000Z' },
      { version: 'v2', text: 'fixture-prd-v2', createdAt: '2026-01-02T00:00:00.000Z' },
    ],
    fixIterations: 3,
    sourceIssues: [{ repo: 'fixture-owner/fixture-repo', number: 4116, title: 'fixture-issue-title' }],
    playlists: [playlist],
  };

  return plan;
}

// ─── Compile-time exhaustiveness guard ───
// Adding a field to Task/Playlist/Plan breaks compilation here until it is listed, and the
// runtime test below then forces it into the fixture as well.

const TASK_FIELDS: Record<keyof Task, true> = {
  id: true,
  name: true,
  prompt: true,
  type: true,
  engine: true,
  role: true,
  command: true,
  cwd: true,
  env: true,
  inheritEnvFiles: true,
  scopedVerify: true,
  files: true,
  acceptanceCriteria: true,
  verifyCommand: true,
  expectedArtifacts: true,
  ownerNote: true,
  failurePolicy: true,
  port: true,
  readyPattern: true,
  healthCheckUrl: true,
  startupTimeoutMs: true,
  timeoutMs: true,
  retryCount: true,
  dependsOn: true,
  skipIf: true,
  consensus: true,
  validation: true,
  sourceIssueNumber: true,
  sourceIssueRepo: true,
  releaseTag: true,
  releaseNotes: true,
  githubRelease: true,
  monitorSamples: true,
  monitorIntervalMs: true,
  failureThreshold: true,
  incidentRepo: true,
  incidentLabel: true,
  status: true,
};

const PLAYLIST_FIELDS: Record<keyof Playlist, true> = {
  id: true,
  name: true,
  engine: true,
  role: true,
  autoplay: true,
  autoplayDelay: true,
  parallel: true,
  aiRules: true,
  testPhase: true,
  prdContext: true,
  tasks: true,
};

const PLAN_FIELDS: Record<keyof Plan, true> = {
  version: true,
  name: true,
  description: true,
  defaultEngine: true,
  fallbackEngine: true,
  variables: true,
  defaultRole: true,
  customRoles: true,
  validation: true,
  sandbox: true,
  aiRules: true,
  prdSource: true,
  prdVersions: true,
  fixIterations: true,
  sourceIssues: true,
  playlists: true,
};

describe('plan schema round trip (anti-recurrence harness)', () => {
  it('preserves every field of the maximal fixture through dehydrate → hydrate', () => {
    const fixture = buildMaximalFixture();
    const restored = hydratePlan(dehydratePlan(fixture));
    assert.deepEqual(restored, fixture);
  });

  it('keeps the field records and the fixture in sync', () => {
    const fixture = buildMaximalFixture();
    const playlist = fixture.playlists[0];
    const task = playlist.tasks[0];

    for (const key of Object.keys(PLAN_FIELDS)) {
      assert.ok(key in fixture, `Plan field "${key}" is missing from the maximal fixture`);
    }
    for (const key of Object.keys(PLAYLIST_FIELDS)) {
      assert.ok(key in playlist, `Playlist field "${key}" is missing from the maximal fixture`);
    }
    for (const key of Object.keys(TASK_FIELDS)) {
      assert.ok(key in task, `Task field "${key}" is missing from the maximal fixture`);
    }
  });

  it('emits no optional keys at all for a minimal plan', () => {
    const plan = createEmptyPlan('Minimal');
    plan.playlists[0].tasks.push(createTask('Only Task', 'Only prompt'));

    const file = dehydratePlan(plan) as unknown as Record<string, unknown>;
    for (const key of ['sandbox', 'aiRules', 'prdVersions', 'fixIterations', 'validation', 'defaultRole', 'customRoles']) {
      assert.ok(!(key in file), `minimal plan should not emit "${key}"`);
    }

    const rawTask = dehydratePlan(plan).playlists[0].tasks[0] as unknown as Record<string, unknown>;
    assert.ok(!('timeoutMs' in rawTask), 'minimal task should not emit "timeoutMs"');
    assert.ok(!('status' in rawTask), 'minimal task should not emit a Pending "status"');
    assert.ok(!('role' in rawTask), 'minimal task should not emit "role"');

    const rawPlaylist = dehydratePlan(plan).playlists[0] as unknown as Record<string, unknown>;
    assert.ok(!('role' in rawPlaylist), 'minimal playlist should not emit "role"');
  });

  it('is stable across two full round trips', () => {
    const fixture = buildMaximalFixture();
    const once = dehydratePlan(fixture);
    const twice = dehydratePlan(hydratePlan(dehydratePlan(fixture)));
    // Catches a field that survives one hop but is dropped on the second.
    assert.deepEqual(twice, once);
  });
});

// ─── Roles as the PRD generator emits them ───
//
// `cmdGeneratePlanFromPrd` asks the model for a per-playlist "role" and then routes the
// raw object through hydratePlan → dehydratePlan before writing it to disk. extension.ts
// has no unit harness, so the guarantee is pinned here, at that boundary.

/** The shape the PRD generator produces, minus the roles. */
function generatorOutput(roles: {
  design?: unknown; development?: unknown; testing?: unknown; taskRole?: unknown;
}): Record<string, unknown> {
  const withRole = (role: unknown) => (role === undefined ? {} : { role });
  return {
    version: '1.0',
    name: 'Generated Plan',
    description: 'From a PRD',
    defaultEngine: 'claude',
    playlists: [
      {
        id: 'pl-1', name: 'Design', testPhase: false, ...withRole(roles.design),
        tasks: [{ id: 't-1', name: 'Sketch', prompt: 'p', status: 'pending' }],
      },
      {
        id: 'pl-2', name: 'Development', testPhase: false, ...withRole(roles.development),
        tasks: [{ id: 't-2', name: 'Build', prompt: 'p', status: 'pending', ...withRole(roles.taskRole) }],
      },
      {
        id: 'pl-3', name: 'Testing', testPhase: true, ...withRole(roles.testing),
        tasks: [{ id: 't-3', name: 'Test', prompt: 'p', status: 'pending' }],
      },
    ],
  };
}

describe('PRD-generated roles survive the write path', () => {
  it('carries designer / engineer / tester through a full round trip', () => {
    const raw = generatorOutput({
      design: 'designer', development: 'engineer', testing: 'tester',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = hydratePlan(raw as any);
    assert.equal(plan.playlists[0].role, 'designer');
    assert.equal(plan.playlists[1].role, 'engineer');
    assert.equal(plan.playlists[2].role, 'tester');

    const file = dehydratePlan(plan);
    assert.equal(file.playlists[0].role, 'designer');
    assert.equal(file.playlists[1].role, 'engineer');
    assert.equal(file.playlists[2].role, 'tester');

    // And once more, the way a reload would.
    const reloaded = hydratePlan(file);
    assert.deepEqual(reloaded.playlists.map(pl => pl.role), ['designer', 'engineer', 'tester']);
  });

  it('drops only the invented role and keeps the other two', () => {
    const raw = generatorOutput({
      design: 'designer', development: 'senior-backend-engineer', testing: 'tester',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const load = () => hydratePlan(raw as any);
    assert.doesNotThrow(load);
    const plan = load();

    assert.equal(plan.playlists[1].role, undefined, 'the invented role must be dropped');
    assert.equal(plan.playlists[0].role, 'designer', 'roles are per-playlist independent');
    assert.equal(plan.playlists[2].role, 'tester', 'one bad value must not poison the plan');

    // The dropped role leaves no trace in the written file.
    const file = dehydratePlan(plan);
    assert.ok(!('role' in file.playlists[1]));
    assert.equal(file.playlists[0].role, 'designer');
    // Everything else about the poisoned playlist is intact.
    assert.equal(file.playlists[1].name, 'Development');
    assert.equal(file.playlists[1].tasks.length, 1);
  });

  it('coerces a task-level role the same way as a playlist-level one', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const good = hydratePlan(generatorOutput({ taskRole: 'reviewer' }) as any);
    assert.equal(good.playlists[1].tasks[0].role, 'reviewer');
    assert.equal(dehydratePlan(good).playlists[1].tasks[0].role, 'reviewer');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = hydratePlan(generatorOutput({ taskRole: 'qa-lead' }) as any);
    assert.equal(bad.playlists[1].tasks[0].role, undefined);
    assert.ok(!('role' in dehydratePlan(bad).playlists[1].tasks[0]));
  });

  it('leaves a generator that omitted role entirely with no role keys', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = hydratePlan(generatorOutput({}) as any);
    const file = dehydratePlan(plan);
    for (const pl of file.playlists) {
      assert.ok(!('role' in pl), `unexpected role on ${pl.name}`);
    }
    assert.ok(!('defaultRole' in file));
  });
});
