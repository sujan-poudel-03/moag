// ─── AC17: GET /api/projects/:id/trace rows === `moag trace` output for the same plan ───

import { strict as assert } from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { startHarness, Harness } from './app-harness';
import { cmdTrace, parseArgs } from '../../../headless/cli';
import { createEmptyPlan, createPlaylist, createTask } from '../../../models/plan';
import { Plan, TaskStatus } from '../../../models/types';
import { savePrdVersion } from '../../../server/prd-ops';

/** A plan exercising every RequirementStatus: shipped, in-progress, not-shipped, untracked, removed. */
function fixture(): Plan {
  const plan = createEmptyPlan('Trace fixture');
  const r1 = savePrdVersion(plan, { text: '## Requirements\n- Guest checkout\n- Card payments\n- Wish lists\n- Saved addresses\n- CSV export\n', baseCreatedAt: null });
  if (!r1.ok) { throw new Error(r1.message); }
  // v2 drops "Wish lists" (R-3) → removed.
  const v2Text = (plan.prdSource ?? '').split('\n').filter((l) => !l.includes('Wish lists')).join('\n');
  const createdAt = '2026-10-04T10:00:00.000Z';
  plan.prdVersions!.push({ version: '2.0.0', text: v2Text, createdAt, recommendedBump: 'major', chosenBump: 'major' });

  const pl = createPlaylist('Delivery');
  const t = (id: string, status: TaskStatus, reqs: string[], over: Record<string, unknown> = {}) =>
    Object.assign(createTask(id, id), { id, status, requirementIds: reqs }, over);
  pl.tasks.push(
    t('t-1', TaskStatus.Completed, ['R-1']),
    t('t-2', TaskStatus.Running, ['R-2']),
    t('t-4', TaskStatus.Failed, ['R-4']),
    t('t-3', TaskStatus.Completed, ['R-3']),
  );
  plan.playlists = [pl];
  plan.requirementTrace = [
    { id: 'R-1', taskIds: ['t-1'], commits: ['abc123'], gates: [
      { command: 'moag:standards v3', exitCode: 0, timedOut: false, at: createdAt, standardsCounts: { advisoryFindings: 2, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true } },
      { command: 'npm test', exitCode: 0, timedOut: false, at: createdAt },
    ], releases: [{ releaseTag: 'v2.0.0', prdVersion: '2.0.0', at: createdAt, taskIds: ['t-1'], standardsVersion: 3 }] },
    { id: 'R-2', taskIds: ['t-2'], commits: [], gates: [{ command: 'npm test', exitCode: 1, timedOut: false, at: createdAt }], releases: [] },
    { id: 'R-3', taskIds: ['t-3'], commits: [], gates: [], releases: [{ releaseTag: 'v1.0.0', prdVersion: '1.0.0', at: createdAt, taskIds: ['t-3'] }] },
  ];
  return plan;
}

describe('trace parity: web API vs moag trace', function () {
  this.timeout(20000);
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { sinon.restore(); await h.close(); });

  it('GET trace rows deep-equal `moag trace` lines (minus event/ts) for the same fixture plan', async () => {
    const created = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'go', defaultEngine: 'claude' },
    });
    const projectId = (created.body.project as { id: string }).id;
    h.state.saveCanonicalPlan(projectId, fixture());

    const api = await h.request('GET', `/api/projects/${projectId}/trace`, { as: 'approver' });
    assert.equal(api.status, 200);
    const rows = api.body.rows as Array<Record<string, unknown>>;

    const lines: string[] = [];
    const write = sinon.stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
    let code: number;
    try {
      const planPath = path.join(h.dataDir, 'projects', projectId, 'plan.json');
      code = cmdTrace(parseArgs(['trace', planPath]));
    } finally {
      write.restore();
    }
    assert.equal(code, 0);
    const cli = lines.join('').trim().split('\n').map((l) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { event: _e, ts: _t, ...rest } = JSON.parse(l);
      return rest;
    });

    assert.deepEqual(rows, cli);
    // The standards row means the same thing on both sides: its word and its counts, not just an exit code.
    assert.deepEqual(rows[0].gates, [
      { command: 'moag:standards v3', exitCode: 0, standards: 'no blocking rules configured', standardsCounts: { advisoryFindings: 2, notCheckedRules: 0, notCheckedFiles: 0, noBlockingRules: true } },
      { command: 'npm test', exitCode: 0 },
    ]);
    assert.deepEqual((cli[0] as { gates: unknown }).gates, rows[0].gates);
    // The standards version is on both sides: a number where a release recorded one, null elsewhere.
    assert.deepEqual(rows.map((r) => [r.id, r.standardsVersion]), [['R-1', 3], ['R-2', null], ['R-3', null], ['R-4', null], ['R-5', null]]);
    assert.ok(cli.every((line: Record<string, unknown>) => 'standardsVersion' in line), 'moag trace prints the key on every line');
    const statuses = new Set(rows.map((r) => r.status));
    for (const s of ['shipped', 'in-progress', 'not-shipped', 'untracked', 'removed']) {
      assert.ok(statuses.has(s), `fixture covers ${s} (got ${[...statuses].join(', ')})`);
    }
    assert.deepEqual((api.body.requirements as Array<{ id: string }>).map((r) => r.id), ['R-1', 'R-2', 'R-4', 'R-5']);
  });
});
