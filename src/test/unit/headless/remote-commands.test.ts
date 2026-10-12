// ─── Remote commands: decisions and resume transforms ───

import { strict as assert } from 'assert';
import { createEmptyPlan, createTask, dehydratePlan } from '../../../models/plan';
import { Plan, TaskStatus } from '../../../models/types';
import type { ApprovedProjects } from '../../../headless/onosoo-projects';
import type { RemoteRunRecord } from '../../../headless/remote-runs';
import {
  BUSY, checkGateDecision, checkRetry, checkStartRun, checkStop, HAND_STARTED, NO_DAILY_BUDGET, prepareGateDecision, prepareRetry,
  REMOTE_START_OFF, StartRunContext, UNKNOWN_RUN, validatePayload,
} from '../../../headless/remote-commands';

const PROJECTS: ApprovedProjects = {
  remoteStart: true, dailyBudgetUsd: 20, runnerUser: 'moag-runner', errors: [],
  projects: [{ id: 'web', name: 'Web', kinds: ['node'], path: '/srv/web' }],
};

function ctx(over: Partial<StartRunContext> = {}): StartRunContext {
  return { projects: PROJECTS, ledgerRemaining: 20, engines: ['claude', 'gemini'], projectDefaultEngine: null, active: false, isolation: null, branchPrefix: 'moag/', ...over };
}

/** a → b → c (b, c depend on the previous); a fails, b and c blocked. */
function chain(): Plan {
  const plan = createEmptyPlan('P');
  const a = createTask('A', 'a'); a.id = 'a'; a.status = TaskStatus.Failed;
  const b = createTask('B', 'b'); b.id = 'b'; b.dependsOn = ['a']; b.status = TaskStatus.Blocked;
  const c = createTask('C', 'c'); c.id = 'c'; c.dependsOn = ['b']; c.status = TaskStatus.Blocked;
  const d = createTask('D', 'd'); d.id = 'd'; d.status = TaskStatus.Completed;
  const e = createTask('E', 'e'); e.id = 'e'; e.status = TaskStatus.Failed;
  plan.playlists[0].tasks.push(a, b, c, d, e);
  return plan;
}

function record(over: Partial<RemoteRunRecord> = {}, plan: Plan = chain()): RemoteRunRecord {
  return {
    runId: 'r1', projectId: 'web', commandId: 'c1', kind: 'start-run', branch: 'moag/x', startSha: 'a'.repeat(40), engine: 'claude',
    allotment: 5, startedAt: '2026-10-11T00:00:00Z', exitCode: 1, outcome: 'finished', gateTaskId: null, snapshot: dehydratePlan(plan), ...over,
  };
}

describe('remote commands — validatePayload', () => {
  it('accepts each kind\'s shape', () => {
    assert.ok(validatePayload('stop', { run_id: 'r1' }).ok);
    assert.ok(validatePayload('retry', { run_id: 'r1' }).ok);
    assert.ok(validatePayload('retry', { run_id: 'r1', task_id: 't1' }).ok);
    assert.ok(validatePayload('approve', { run_id: 'r1', task_id: 'gate' }).ok);
    const sr = validatePayload('start-run', { project_id: 'web', goal: 'Do it', budget_usd: 3, extra: 'ignored' });
    assert.ok(sr.ok);
    assert.deepEqual(sr.ok && sr.value.payload, { project_id: 'web', goal: 'Do it', budget_usd: 3 });
  });

  const bad: Array<[string, unknown]> = [
    ['stop', {}], ['stop', { run_id: '../x' }], ['skip', { run_id: 'r1' }], ['approve', { run_id: 'r1', task_id: 5 }],
    ['start-run', {}], ['start-run', { project_id: 'web', goal: 5 }], ['start-run', { project_id: 'web', budget_usd: '5' }],
    ['start-run', null], ['env-start', { project_id: 'web' }], ['nonsense', {}],
  ];
  for (const [kind, payload] of bad) {
    it(`rejects ${kind} ${JSON.stringify(payload)}`, () => {
      const v = validatePayload(kind, payload);
      assert.equal(v.ok, false);
      assert.ok(!v.ok && v.message.length > 0);
    });
  }
});

describe('remote commands — checkStartRun', () => {
  const goal = { project_id: 'web', goal: 'Add a login page' };

  it('accepts with the default allotment ($10, or what remains) and the first detected engine', () => {
    assert.deepEqual(checkStartRun(goal, ctx()), { engine: 'claude', allotment: 10, project: PROJECTS.projects[0] });
    assert.equal((checkStartRun(goal, ctx({ ledgerRemaining: 4 })) as { allotment: number }).allotment, 4);
  });

  it('engine: the payload\'s, else the project default if detected, else the first detected', () => {
    assert.equal((checkStartRun({ ...goal, engine: 'gemini' }, ctx()) as { engine: string }).engine, 'gemini');
    assert.equal((checkStartRun(goal, ctx({ projectDefaultEngine: 'gemini' })) as { engine: string }).engine, 'gemini');
    assert.equal((checkStartRun(goal, ctx({ projectDefaultEngine: 'codex' })) as { engine: string }).engine, 'claude');
  });

  const rejections: Array<[string, Record<string, unknown>, Partial<StartRunContext>, string | RegExp]> = [
    ['isolation unavailable', {}, { isolation: 'Remote runs need Linux.' }, 'Remote runs need Linux.'],
    ['remote start off', {}, { projects: { ...PROJECTS, remoteStart: false } }, REMOTE_START_OFF],
    ['no daily budget', {}, { projects: { ...PROJECTS, dailyBudgetUsd: null } }, NO_DAILY_BUDGET],
    ['busy', {}, { active: true }, BUSY],
    ['project not allowlisted', { project_id: 'other' }, {}, /not on this PC's approved list/],
    ['neither goal nor prd', { goal: undefined }, {}, /needs a goal or a PRD/],
    ['prd over 100 KB', { prd: 'é'.repeat(51_201) }, {}, /larger than 100 KB/],
    ['budget 0', { budget_usd: 0 }, {}, /more than \$0/],
    ['budget NaN', { budget_usd: NaN }, {}, /more than \$0/],
    ['budget above what remains', { budget_usd: 15 }, { ledgerRemaining: 12.5 }, 'This run asks for $15.00 but only $12.50 of today\'s $20.00 remote budget is left.'],
    ['nothing left today', {}, { ledgerRemaining: 0 }, 'This run asks for $10.00 but only $0.00 of today\'s $20.00 remote budget is left.'],
    ['engine not detected', { engine: 'codex' }, {}, /"codex" is not available/],
    ['no engines', {}, { engines: [] }, /No AI engine/],
    ['PRD with an unlocked engine', { prd: '# PRD', engine: 'gemini' }, {}, /needs claude, codex or ollama/],
    ['continue_branch outside the prefix', { continue_branch: 'main' }, {}, /MOAG's own branches/],
    ['continue_branch with ..', { continue_branch: 'moag/../main' }, {}, /MOAG's own branches/],
  ];
  for (const [label, over, c, expected] of rejections) {
    it(`rejects: ${label}`, () => {
      const d = checkStartRun({ ...goal, ...over } as never, ctx(c));
      assert.ok('reject' in d, JSON.stringify(d));
      if (typeof expected === 'string') { assert.equal(d.reject, expected); } else { assert.match(d.reject, expected); }
    });
  }

  it('a PRD with a locked engine is accepted; a continue branch under the prefix is accepted', () => {
    assert.ok(!('reject' in checkStartRun({ project_id: 'web', prd: '# PRD' }, ctx())));
    assert.ok(!('reject' in checkStartRun({ ...goal, continue_branch: 'moag/plan-x/run_1' }, ctx())));
  });
});

describe('remote commands — stop, approve/skip, retry', () => {
  const none = { record: null, handStarted: false };
  const hand = { record: null, handStarted: true };

  it('unknown and hand-started runs get distinct messages, for every kind', () => {
    assert.equal(checkStop(none), UNKNOWN_RUN);
    assert.equal(checkStop(hand), HAND_STARTED);
    assert.equal(checkGateDecision('approve', hand, 'g', false), HAND_STARTED);
    assert.equal(checkRetry(none, undefined, false), UNKNOWN_RUN);
    assert.notEqual(UNKNOWN_RUN, HAND_STARTED);
  });

  it('stop: only a live run', () => {
    assert.equal(checkStop({ record: record({ outcome: 'live' }), handStarted: false }), null);
    assert.match(checkStop({ record: record(), handStarted: false })!, /already ended/);
  });

  it('approve/skip: only the halted gate, once, and not while busy', () => {
    const halted = record({ gateTaskId: 'gate', exitCode: 3 });
    assert.equal(checkGateDecision('approve', { record: halted, handStarted: false }, 'gate', false), null);
    assert.match(checkGateDecision('skip', { record: { ...halted, outcome: 'live' }, handStarted: false }, 'gate', false)!, /still in progress/);
    assert.match(checkGateDecision('approve', { record: { ...halted, decided: { kind: 'skip', commandId: 'c9', at: 'x' } }, handStarted: false }, 'gate', false)!, /already been decided \(skip\)/);
    assert.match(checkGateDecision('approve', { record: record(), handStarted: false }, 'gate', false)!, /not waiting at a ship gate/);
    assert.match(checkGateDecision('approve', { record: halted, handStarted: false }, 'other', false)!, /not the ship gate/);
    assert.equal(checkGateDecision('approve', { record: halted, handStarted: false }, 'gate', true), BUSY);
  });

  it('retry: a finished run with something to retry; a gate halt says use approve or skip', () => {
    const l = { record: record(), handStarted: false };
    assert.equal(checkRetry(l, undefined, false), null);
    assert.equal(checkRetry(l, 'b', false), null);
    assert.match(checkRetry(l, 'd', false)!, /nothing to retry/);
    assert.match(checkRetry(l, 'zzz', false)!, /not in this run/);
    assert.match(checkRetry({ record: record({ gateTaskId: 'gate' }), handStarted: false }, undefined, false)!, /use approve or skip/);
    assert.match(checkRetry({ record: record({ outcome: 'live' }), handStarted: false }, undefined, false)!, /still in progress/);
    assert.match(checkRetry({ record: record({ decided: { kind: 'retry', commandId: 'c', at: 'x' } }), handStarted: false }, undefined, false)!, /already been decided/);
    const clean = createEmptyPlan('ok');
    const t = createTask('T', 't'); t.status = TaskStatus.Completed; clean.playlists[0].tasks.push(t);
    assert.match(checkRetry({ record: record({}, clean), handStarted: false }, undefined, false)!, /no failed task/);
    assert.equal(checkRetry(l, undefined, true), BUSY);
  });
});

describe('remote commands — resume transforms', () => {
  it('retry without task_id resets every Failed task and their transitive dependents', () => {
    const plan = chain();
    assert.deepEqual(prepareRetry(plan).sort(), ['a', 'b', 'c', 'e']);
    assert.deepEqual(plan.playlists[0].tasks.map((t) => t.status), [TaskStatus.Pending, TaskStatus.Pending, TaskStatus.Pending, TaskStatus.Completed, TaskStatus.Pending]);
  });

  it('retry with task_id resets only that task and its dependents', () => {
    const plan = chain();
    assert.deepEqual(prepareRetry(plan, 'b').sort(), ['b', 'c']);
    assert.equal(plan.playlists[0].tasks[0].status, TaskStatus.Failed, 'a is not touched');
    assert.equal(plan.playlists[0].tasks[4].status, TaskStatus.Failed, 'e is not touched');
  });

  it('skip keeps release/deploy and their downstream Skipped; approve resets them', () => {
    const build = (): Plan => {
      const plan = createEmptyPlan('Ship');
      const gate = createTask('Gate', ''); gate.id = 'gate'; gate.type = 'manual'; gate.status = TaskStatus.Failed;
      const rel = createTask('Release', ''); rel.id = 'rel'; rel.type = 'release'; rel.dependsOn = ['gate']; rel.status = TaskStatus.Blocked;
      const after = createTask('After', ''); after.id = 'after'; after.dependsOn = ['rel']; after.status = TaskStatus.Blocked;
      const docs = createTask('Docs', ''); docs.id = 'docs'; docs.dependsOn = ['gate']; docs.status = TaskStatus.Blocked;
      plan.playlists[0].tasks.push(gate, rel, after, docs);
      return plan;
    };
    const skipped = build();
    const r = prepareGateDecision(skipped, 'gate', 'skip');
    assert.deepEqual(r.skipped.sort(), ['after', 'rel']);
    assert.deepEqual(r.reset, ['docs']);
    assert.deepEqual(skipped.playlists[0].tasks.map((t) => t.status), [TaskStatus.Completed, TaskStatus.Skipped, TaskStatus.Skipped, TaskStatus.Pending]);
    const approved = build();
    prepareGateDecision(approved, 'gate', 'approve');
    assert.deepEqual(approved.playlists[0].tasks.map((t) => t.status), [TaskStatus.Completed, TaskStatus.Pending, TaskStatus.Pending, TaskStatus.Pending]);
  });
});
