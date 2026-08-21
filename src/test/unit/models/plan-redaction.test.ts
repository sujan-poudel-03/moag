import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createEmptyPlan, createTask, dehydratePlan, loadPlan, savePlan, serializePlanForSharing,
} from '../../../models/plan';
import { redactPlanFile } from '../../../models/plan-redaction';
import { Plan, PlanFile, TaskStatus } from '../../../models/types';

// Sentinels — none of these strings may appear in shared output.
const SECRET_VARIABLE = 'secret-variable-value';
const SECRET_PLAN_RULES = 'secret-plan-rules';
const SECRET_PRD = 'secret-prd-source';
const SECRET_PRD_VERSION = 'secret-prd-version-text';
const SECRET_PLAYLIST_RULES = 'secret-playlist-rules';
const SECRET_PRD_CONTEXT = 'secret-playlist-prd-context';
const SECRET_ENV = 'secret-env-value';
const SECRET_OWNER_NOTE = 'secret-owner-note';

function buildSensitivePlan(): Plan {
  const plan = createEmptyPlan('Sensitive Plan');
  plan.variables = { API_TOKEN: SECRET_VARIABLE };
  plan.aiRules = SECRET_PLAN_RULES;
  plan.prdSource = SECRET_PRD;
  plan.prdVersions = [{ version: 'v1', text: SECRET_PRD_VERSION, createdAt: '2026-01-01T00:00:00.000Z' }];
  plan.fixIterations = 2;

  const playlist = plan.playlists[0];
  playlist.aiRules = SECRET_PLAYLIST_RULES;
  playlist.prdContext = SECRET_PRD_CONTEXT;

  const task = createTask('Build', 'Build the thing');
  task.env = { DEPLOY_KEY: SECRET_ENV };
  task.ownerNote = SECRET_OWNER_NOTE;
  task.status = TaskStatus.Completed;
  playlist.tasks.push(task);

  return plan;
}

describe('redactPlanFile / serializePlanForSharing', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-redact-'));
    tmpFile = path.join(tmpDir, 'test.agent-plan.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes every sensitive field from the shared JSON', () => {
    const { json } = serializePlanForSharing(buildSensitivePlan());

    for (const sentinel of [
      SECRET_VARIABLE, SECRET_PLAN_RULES, SECRET_PRD, SECRET_PRD_VERSION,
      SECRET_PLAYLIST_RULES, SECRET_PRD_CONTEXT, SECRET_ENV, SECRET_OWNER_NOTE,
    ]) {
      assert.ok(!json.includes(sentinel), `shared JSON still contains "${sentinel}"`);
    }

    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.ok(!('variables' in parsed));
    assert.ok(!('aiRules' in parsed));
    assert.ok(!('prdSource' in parsed));
    assert.ok(!('prdVersions' in parsed));
    // Non-sensitive fields survive
    assert.equal(parsed.name, 'Sensitive Plan');
    assert.equal(parsed.fixIterations, 2);
  });

  it('reports one de-duplicated human label per removed category', () => {
    const { redacted } = serializePlanForSharing(buildSensitivePlan());

    assert.deepEqual([...redacted].sort(), [
      'PRD text',
      'PRD version history',
      'owner notes',
      'plan rules',
      'playlist PRD context',
      'task environment variables',
      'variables',
    ].sort());
    // De-duplicated: plan rules and playlist rules share one label
    assert.equal(new Set(redacted).size, redacted.length);
  });

  it('does not emit one label per task for a plan with many tasks', () => {
    const plan = buildSensitivePlan();
    for (let i = 0; i < 50; i++) {
      const t = createTask(`T${i}`, 'prompt');
      t.env = { KEY: SECRET_ENV };
      t.ownerNote = SECRET_OWNER_NOTE;
      plan.playlists[0].tasks.push(t);
    }

    const { redacted } = serializePlanForSharing(plan);
    assert.equal(redacted.filter(r => r === 'task environment variables').length, 1);
    assert.equal(redacted.filter(r => r === 'owner notes').length, 1);
  });

  it('strips task status only when asked', () => {
    const plan = buildSensitivePlan();

    const kept = JSON.parse(serializePlanForSharing(plan).json) as PlanFile;
    assert.equal(kept.playlists[0].tasks[0].status, 'completed');

    const stripped = JSON.parse(serializePlanForSharing(plan, { stripStatus: true }).json) as PlanFile;
    assert.ok(!('status' in (stripped.playlists[0].tasks[0] as object)));
  });

  it('leaves the save path at full fidelity — redaction is not reachable from savePlan', () => {
    const plan = buildSensitivePlan();
    serializePlanForSharing(plan);

    savePlan(plan, tmpFile);
    const loaded = loadPlan(tmpFile);

    assert.deepEqual(loaded.variables, { API_TOKEN: SECRET_VARIABLE });
    assert.equal(loaded.aiRules, SECRET_PLAN_RULES);
    assert.equal(loaded.prdSource, SECRET_PRD);
    assert.equal(loaded.prdVersions![0].text, SECRET_PRD_VERSION);
    assert.equal(loaded.playlists[0].aiRules, SECRET_PLAYLIST_RULES);
    assert.equal(loaded.playlists[0].prdContext, SECRET_PRD_CONTEXT);
    assert.deepEqual(loaded.playlists[0].tasks[0].env, { DEPLOY_KEY: SECRET_ENV });
    assert.equal(loaded.playlists[0].tasks[0].ownerNote, SECRET_OWNER_NOTE);
  });

  it('does not mutate the in-memory plan it was given', () => {
    const plan = buildSensitivePlan();
    const task = plan.playlists[0].tasks[0];

    serializePlanForSharing(plan, { stripStatus: true });

    assert.deepEqual(plan.variables, { API_TOKEN: SECRET_VARIABLE });
    assert.equal(plan.aiRules, SECRET_PLAN_RULES);
    assert.equal(plan.prdSource, SECRET_PRD);
    assert.equal(plan.prdVersions!.length, 1);
    assert.equal(plan.playlists[0].aiRules, SECRET_PLAYLIST_RULES);
    assert.equal(plan.playlists[0].prdContext, SECRET_PRD_CONTEXT);
    // A shallow copy would have deleted env off the live Task the runner is about to run
    assert.deepEqual(task.env, { DEPLOY_KEY: SECRET_ENV });
    assert.equal(task.ownerNote, SECRET_OWNER_NOTE);
    assert.equal(task.status, TaskStatus.Completed);
  });

  it('reports nothing and changes nothing for a plan with no sensitive fields', () => {
    const plan = createEmptyPlan('Clean Plan');
    plan.playlists[0].tasks.push(createTask('T', 'prompt'));

    const { json, redacted } = serializePlanForSharing(plan);
    assert.deepEqual(redacted, []);
    // Identical to the unredacted file once undefined-valued keys are dropped by JSON
    assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(dehydratePlan(plan))));
  });

  it('does not claim a phantom removal for empty variables and empty env', () => {
    const plan = createEmptyPlan('Empty Containers');
    plan.variables = {};
    const task = createTask('T', 'prompt');
    task.env = {};
    plan.playlists[0].tasks.push(task);

    const { json, redacted } = serializePlanForSharing(plan);
    assert.deepEqual(redacted, []);

    const parsed = JSON.parse(json) as PlanFile;
    assert.ok(!('variables' in (parsed as object)));
    assert.ok(!('env' in (parsed.playlists[0].tasks[0] as object)));
  });

  it('redactPlanFile works directly on a PlanFile and returns a fresh object', () => {
    const file = dehydratePlan(buildSensitivePlan());
    const { file: shared, redacted } = redactPlanFile(file);

    assert.notEqual(shared, file);
    assert.ok(redacted.length > 0);
    // The source PlanFile is untouched
    assert.deepEqual(file.variables, { API_TOKEN: SECRET_VARIABLE });
    assert.equal(file.playlists[0].tasks[0].env!.DEPLOY_KEY, SECRET_ENV);
    assert.ok(!('variables' in (shared as object)));
  });
});
