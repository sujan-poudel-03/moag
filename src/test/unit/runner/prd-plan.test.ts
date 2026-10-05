import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildFullPlanPrompt, parseGeneratedPlan, describeDeltaScope, buildDeltaPlanPrompt, generateDeltaPlan,
} from '../../../runner/prd-plan';
import { createEmptyPlan, createTask } from '../../../models/plan';
import { EngineResult, Plan, TaskStatus } from '../../../models/types';

const planJson = (playlists: unknown[]) => JSON.stringify({ version: '1.0', name: 'Login', description: 'd', playlists });
const playlist = (over: Record<string, unknown> = {}) => ({
  id: 'pl-1', name: 'Development', testPhase: false,
  tasks: [{ id: 'task-1', name: 'Build it', prompt: 'do it', status: 'pending' }],
  ...over,
});

// ─── F2-3: full-plan prompt and parsing ───

describe('prd-plan — buildFullPlanPrompt', () => {
  it('carries the Design / Development / Testing rules and ends with the PRD', () => {
    const prompt = buildFullPlanPrompt('## Requirements\n- login');
    assert.match(prompt, /"Design" — UI\/UX specs/);
    assert.match(prompt, /"Development" — implementation tasks/);
    assert.match(prompt, /"Testing" — test writing/);
    assert.match(prompt, /Never invent a value outside that list\./);
    assert.ok(prompt.endsWith('PRD:\n## Requirements\n- login'));
  });
});

describe('prd-plan — parseGeneratedPlan', () => {
  it('accepts fenced JSON', () => {
    const r = parseGeneratedPlan('```json\n' + planJson([playlist()]) + '\n```');
    assert.ok(r.ok);
    assert.equal(r.plan.name, 'Login');
    assert.equal(r.plan.playlists[0].tasks[0].id, 'task-1');
    assert.equal(r.invalidRoleCount, 0);
  });

  it('reports invalid JSON', () => {
    assert.deepEqual(parseGeneratedPlan('{ not json'), { ok: false, error: 'AI returned invalid JSON. Try again.' });
  });

  it('reports missing playlists (and a non-object response) as missing required fields', () => {
    const msg = 'Generated plan is missing required fields (version, name, playlists).';
    assert.deepEqual(parseGeneratedPlan(JSON.stringify({ version: '1.0', name: 'x' })), { ok: false, error: msg });
    assert.deepEqual(parseGeneratedPlan(planJson([])), { ok: false, error: msg });
    assert.deepEqual(parseGeneratedPlan('null'), { ok: false, error: msg });
  });

  it('counts an invented role and coerces it away', () => {
    const r = parseGeneratedPlan(planJson([playlist({ role: 'wizard' })]));
    assert.ok(r.ok);
    assert.equal(r.invalidRoleCount, 1);
    assert.notEqual(r.plan.playlists[0].role, 'wizard');
  });

  it('returns a hydrate failure as a visible error instead of swallowing it', () => {
    const bad = playlist({ tasks: [{ id: 'task-1', name: 'x', prompt: 'p', timeoutMs: -1 }] });
    const r = parseGeneratedPlan(planJson([bad]));
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.startsWith('Generated plan could not be loaded'), !r.ok ? r.error : '');
    assert.match(!r.ok ? r.error : '', /timeoutMs/);
  });

  it('keeps only R-<n> requirement IDs, so a junk ID never reaches the plan', () => {
    const r = parseGeneratedPlan(planJson([playlist({ tasks: [
      { id: 'a', name: 'Mixed', prompt: 'p', requirementIds: ['R-1', 'login', 'R-', 'r-2', ' R-3', 'R-3x', 'R-12'] },
      { id: 'b', name: 'All junk', prompt: 'p', requirementIds: ['REQ-1', 'login'] },
    ] })]));
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.deepEqual(r.plan.playlists[0].tasks.map(t => t.requirementIds), [['R-1', 'R-12'], undefined]);
  });
});

// ─── F2-4: delta plan core ───

const at = '2026-10-04T00:00:00.000Z';
const v1Text = ['# Auth', '## Requirements', '- [R-1] login', '- [R-2] logout', '- [R-3] reset password'].join('\n');
const v2Text = ['# Auth', '## Requirements', '- [R-1] login', '- [R-2] logout from every device', '- [R-4] sign up'].join('\n');

function basePlan(): Plan {
  const plan = createEmptyPlan('Auth');
  const existing = createTask('Existing', 'already here');
  existing.id = 'task-1';
  existing.status = TaskStatus.Completed;
  existing.requirementIds = ['R-1'];
  plan.playlists[0].tasks.push(existing);
  plan.prdVersions = [
    { version: '1.0.0', text: v1Text, createdAt: at },
    { version: '1.1.0', text: v2Text, createdAt: at, recommendedBump: 'major', chosenBump: 'major' },
  ];
  plan.prdSource = v2Text;
  plan.requirementTrace = [{
    id: 'R-1', taskIds: ['task-1'], commits: ['abc123'],
    gates: [{ command: 'npm test', exitCode: 0, timedOut: false, at }],
    releases: [{ releaseTag: 'v1.0.0', prdVersion: '1.0.0', at, taskIds: ['task-1'] }],
  }];
  return plan;
}

const ok = (stdout: string): EngineResult => ({ stdout, stderr: '', exitCode: 0, durationMs: 1 });
const signal = new AbortController().signal;

/** A stubbed engine that records every prompt and answers with `reply`. */
function engine(reply: EngineResult | (() => EngineResult)) {
  const prompts: string[] = [];
  return {
    prompts,
    runEngine: async (prompt: string) => {
      prompts.push(prompt);
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

describe('prd-plan — describeDeltaScope / buildDeltaPlanPrompt', () => {
  it('scopes to added and changed requirements; removed ones never appear', () => {
    const scope = describeDeltaScope(basePlan());
    assert.ok(scope);
    assert.equal(scope.versionLabel, '1.1.0');
    assert.deepEqual(scope.added.map(r => r.id), ['R-4']);
    assert.deepEqual(scope.changed.map(c => c.id), ['R-2']);
    const prompt = buildDeltaPlanPrompt({ fullPrdText: v2Text, scope });
    assert.match(prompt, /- \[R-4\] \(added\) sign up/);
    assert.match(prompt, /- \[R-2\] \(changed\) before: logout → after: logout from every device/);
    assert.ok(!prompt.includes('R-3'), 'a removed requirement is not in the prompt');
    assert.ok(prompt.endsWith(v2Text));
  });

  it('is null with no previous version or nothing added or changed', () => {
    const one = basePlan();
    one.prdVersions = [one.prdVersions![0]];
    assert.equal(describeDeltaScope(one), null);
    const removedOnly = basePlan();
    removedOnly.prdVersions![1].text = ['# Auth', '## Requirements', '- [R-1] login', '- [R-2] logout'].join('\n');
    assert.equal(describeDeltaScope(removedOnly), null);
  });
});

describe('prd-plan — generateDeltaPlan', () => {
  const generated = (playlists: unknown[]) => JSON.stringify({ version: '1.0', name: 'Delta', playlists });

  it('appends one playlist from a two-playlist response, leaving everything else untouched', async () => {
    const plan = basePlan();
    const before = structuredClone(plan);
    const eng = engine(ok(generated([
      { id: 'a', name: 'Dev', tasks: [
        { id: 'task-1', name: 'Sign up form', prompt: 'p', requirementIds: ['R-4'] },
        { id: 'task-2', name: 'Logout all', prompt: 'p', requirementIds: ['R-2', 'R-99', 'R-2'], dependsOn: ['task-1', 'ghost'] },
      ] },
      { id: 'b', name: 'Test', testPhase: true, tasks: [
        { id: 't', name: 'Run tests', prompt: 'p', type: 'command', command: 'npm test', requirementIds: ['R-4', 'R-2'] },
        { id: 'x', name: 'Hallucinated', prompt: 'p', requirementIds: ['R-99'] },
      ] },
    ])));
    const outcome = await generateDeltaPlan(plan, { runEngine: eng.runEngine, signal, now: () => 36 });
    assert.equal(eng.prompts.length, 1);
    assert.equal(outcome.kind, 'appended');
    assert.ok(outcome.kind === 'appended');

    assert.equal(plan.playlists.length, 2);
    assert.deepEqual(plan.playlists[0], before.playlists[0], 'existing playlist untouched');
    const pl = plan.playlists[1];
    assert.equal(pl, outcome.playlist);
    assert.equal(pl.name, 'PRD v1.1.0 delta');
    assert.equal(pl.role, 'engineer');
    assert.equal(pl.autoplay, true);
    assert.equal(pl.testPhase, false);
    assert.match(pl.prdContext ?? '', /\[R-4\] \(added\) sign up/);

    // F2.6: the plan's history and trace are exactly what they were.
    assert.deepEqual(plan.prdVersions, before.prdVersions);
    assert.equal(plan.prdSource, before.prdSource);
    assert.deepEqual(plan.requirementTrace, before.requirementTrace);

    // F2.7: every kept task is tagged with known delta IDs only; the stray one is reported.
    assert.deepEqual(pl.tasks.map(t => t.name), ['Sign up form', 'Logout all', 'Run tests']);
    assert.deepEqual(pl.tasks.map(t => t.requirementIds), [['R-4'], ['R-2'], ['R-2', 'R-4']]);
    assert.ok(pl.tasks.every(t => t.status === TaskStatus.Pending));
    assert.deepEqual(outcome.rejected, [{ taskName: 'Hallucinated', reason: 'cites none of R-4, R-2' }]);

    // A colliding generated id ("task-1") is replaced and dependsOn follows it.
    const ids = pl.tasks.map(t => t.id);
    assert.ok(!ids.includes('task-1'));
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(pl.tasks[1].dependsOn, [pl.tasks[0].id], 'remapped; unknown "ghost" dropped');
  });

  it('all rejected → nothing appended', async () => {
    const plan = basePlan();
    const eng = engine(ok(generated([{ id: 'a', name: 'Dev', tasks: [
      { id: 'q', name: 'Off-scope', prompt: 'p', requirementIds: ['R-3'] },
      { id: 'r', name: 'Untagged', prompt: 'p' },
    ] }])));
    const outcome = await generateDeltaPlan(plan, { runEngine: eng.runEngine, signal });
    assert.equal(outcome.kind, 'all-rejected');
    assert.ok(outcome.kind === 'all-rejected');
    assert.equal(outcome.rejected.length, 2);
    assert.equal(plan.playlists.length, 1);
  });

  it('a malformed requirementIds on one task drops that task, not the whole delta', async () => {
    const plan = basePlan();
    const eng = engine(ok(generated([{ id: 'a', name: 'Dev', tasks: [
      { id: 'good', name: 'Sign up form', prompt: 'p', requirementIds: ['R-4'] },
      { id: 'str', name: 'String IDs', prompt: 'p', requirementIds: 'R-4' },
      { id: 'mixed', name: 'Mixed IDs', prompt: 'p', requirementIds: [42, '', null, 'R-2'] },
      { id: 'obj', name: 'Object IDs', prompt: 'p', requirementIds: { id: 'R-4' } },
    ] }])));
    const outcome = await generateDeltaPlan(plan, { runEngine: eng.runEngine, signal });
    assert.equal(outcome.kind, 'appended');
    assert.ok(outcome.kind === 'appended');
    assert.deepEqual(outcome.playlist.tasks.map(t => [t.name, t.requirementIds]), [
      ['Sign up form', ['R-4']],
      ['Mixed IDs', ['R-2']],
    ]);
    assert.deepEqual(outcome.rejected.map(r => r.taskName), ['String IDs', 'Object IDs']);
  });

  it('a non-zero exit is engine-failed and changes nothing', async () => {
    const plan = basePlan();
    const before = structuredClone(plan);
    const outcome = await generateDeltaPlan(plan, {
      runEngine: engine({ stdout: 'oops', stderr: '', exitCode: 1, durationMs: 1 }).runEngine, signal,
    });
    assert.equal(outcome.kind, 'engine-failed');
    assert.deepEqual(plan, before);
  });

  it('an engine that throws is engine-failed, not a rejection', async () => {
    const plan = basePlan();
    const outcome = await generateDeltaPlan(plan, {
      runEngine: async () => { throw new Error('aborted'); }, signal,
    });
    assert.deepEqual(outcome, { kind: 'engine-failed', error: 'Delta plan generation failed: aborted' });
  });

  it('unparsable output is parse-failed', async () => {
    const plan = basePlan();
    const outcome = await generateDeltaPlan(plan, { runEngine: engine(ok('not json')).runEngine, signal });
    assert.deepEqual(outcome, { kind: 'parse-failed', error: 'AI returned invalid JSON. Try again.' });
    assert.equal(plan.playlists.length, 1);
  });

  it('no previous version → no-delta without calling the engine', async () => {
    const plan = basePlan();
    plan.prdVersions = [plan.prdVersions![0]];
    const eng = engine(ok('{}'));
    assert.deepEqual(await generateDeltaPlan(plan, { runEngine: eng.runEngine, signal }), { kind: 'no-delta' });
    assert.equal(eng.prompts.length, 0);
  });
});

describe('prd-plan module boundary', () => {
  it('imports no vscode', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../runner/prd-plan.ts'), 'utf-8');
    assert.ok(!/from 'vscode'/.test(source));
    assert.ok(!/require\('vscode'\)/.test(source));
  });
});
