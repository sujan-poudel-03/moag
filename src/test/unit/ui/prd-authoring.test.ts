import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { createEmptyPlan } from '../../../models/plan';
import { Plan } from '../../../models/types';

// prd-authoring imports vscode (directly and through user-messages), so load both through
// the shared mock. Everything with side effects beyond the plan object is stubbed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const userMessages = proxyquire('../../../utils/user-messages', { vscode: vscodeMock });

const engineStub = { runTask: sinon.stub() };

const prdAuthoring = proxyquire('../../../ui/prd-authoring', {
  vscode: vscodeMock,
  '../utils/user-messages': userMessages,
  '../adapters/index': { getEngine: () => engineStub },
  '../context/project-analyzer': { analyzeProject: () => ({}), formatAnalysis: () => '' },
  '../utils/gh': { ghSync: () => '' },
  './prompt-input-view': { PromptInputViewProvider: class {} },
  '../workspace/moag-paths': { ensureMoagDir: () => null },
  './webview-assets': { webviewCsp: () => '', webviewNonce: () => 'n', webviewScriptUri: () => '' },
}) as typeof import('../../../ui/prd-authoring');

const md = (...lines: string[]) => lines.join('\n');

/** Wire the module to a plan held in memory — currentPlanPath null, so nothing is written. */
function init(plan: Plan | null, over: {
  isRunnerBusy?: () => boolean;
  saveAndRefresh?: () => void;
  getActivePlan?: () => Plan | null;
} = {}): void {
  prdAuthoring.initPrdAuthoring({
    isRunnerBusy: over.isRunnerBusy ?? (() => false),
    currentPlan: plan,
    currentPlanPath: null,
    extensionContext: null,
    promptViewProvider: null,
    runner: null,
    detectPrdFileInWorkspace: () => null,
    getActivePlan: over.getActivePlan ?? (() => plan),
    injectTestTaskIfMissing: () => { /* not exercised */ },
    saveAndRefresh: over.saveAndRefresh ?? (() => { /* not exercised */ }),
    syncPromptProviderSidebar: () => { /* not exercised */ },
  });
}

describe('prd-authoring — savePrdVersionToActivePlan', () => {
  let info: sinon.SinonStub;
  let error: sinon.SinonStub;

  beforeEach(() => {
    info = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
    error = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
    engineStub.runTask.reset();
  });
  afterEach(() => sinon.restore());

  it('first save is 1.0.0 with requirement tags written into the text', () => {
    const plan = createEmptyPlan('p');
    init(plan);
    const r = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login', '- logout'));
    assert.equal(r.saved, true);
    assert.equal(r.version, '1.0.0');
    assert.equal(r.text, md('## Requirements', '- [R-1] login', '- [R-2] logout'));
    assert.equal(plan.prdVersions?.length, 1);
    assert.equal(plan.prdSource, r.text);
    assert.equal(r.canOverride, false);
    assert.equal(r.canGenerateDelta, false);
    assert.match(String(info.firstCall.args[0]), /^PRD saved as v1\.0\.0 — /);
  });

  it('a second save that adds a line recommends minor and enables the delta plan', () => {
    const plan = createEmptyPlan('p');
    init(plan);
    const first = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    const r = prdAuthoring.savePrdVersionToActivePlan(md(first.text ?? '', '- sign up'));
    assert.equal(r.saved, true);
    assert.equal(r.version, '1.1.0');
    assert.equal(r.recommendedBump, 'minor');
    assert.equal(r.chosenBump, 'minor');
    assert.deepEqual(r.diff?.added, [{ id: 'R-2', text: 'sign up' }]);
    assert.match(r.rationale ?? '', /R-2/);
    assert.equal(r.canOverride, true);
    assert.equal(r.canGenerateDelta, true);
    assert.equal(plan.prdVersions?.length, 2);
    assert.equal(engineStub.runTask.callCount, 0, 'saving never calls a model');
  });

  it('a legacy v2.0 last label continues as 2.1.0', () => {
    const plan = createEmptyPlan('p');
    plan.prdVersions = [{ version: 'v2.0', text: md('## Requirements', '- login'), createdAt: '2025-01-01T00:00:00.000Z' }];
    init(plan);
    const r = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login', '- reset'));
    assert.equal(r.version, '2.1.0');
  });

  it('identical text saves nothing', () => {
    const plan = createEmptyPlan('p');
    init(plan);
    const first = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    const r = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    assert.equal(r.saved, false);
    assert.equal(plan.prdVersions?.length, 1);
    assert.equal(plan.prdSource, first.text);
    assert.match(r.notice ?? '', /No changes since v1\.0\.0 — nothing saved\./);
  });

  it('a duplicate inline tag is refused and leaves the plan unchanged', () => {
    const plan = createEmptyPlan('p');
    init(plan);
    prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    const before = structuredClone(plan);
    const r = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- [R-1] login', '- [R-1] logout'));
    assert.equal(r.saved, false);
    assert.deepEqual(plan, before);
    assert.equal(error.callCount, 1);
    assert.match(String(error.firstCall.args[0]), /R-1 appears on lines 2 and 3/);
  });

  it('with no active plan returns the version unpersisted', () => {
    init(null);
    const r = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    assert.equal(r.saved, false);
    assert.equal(r.version, '1.0.0');
    assert.equal(r.versions.length, 1);
  });
});

describe('prd-authoring — relabelLatestPrdVersion', () => {
  beforeEach(() => {
    sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
    sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
  });
  afterEach(() => sinon.restore());

  it('overrides the bump on the version this panel saved, recording both bumps', () => {
    const plan = createEmptyPlan('p');
    init(plan);
    const first = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    const second = prdAuthoring.savePrdVersionToActivePlan(md(first.text ?? '', '- sign up'));
    const createdAt = second.versions[second.versions.length - 1].createdAt;
    const r = prdAuthoring.relabelLatestPrdVersion('major', createdAt);
    assert.equal(r.saved, true);
    assert.equal(r.version, '2.0.0');
    const last = plan.prdVersions?.[1];
    assert.equal(last?.version, '2.0.0');
    assert.equal(last?.recommendedBump, 'minor');
    assert.equal(last?.chosenBump, 'major');
  });

  it('refuses when the last version is not the one this panel saved', () => {
    const plan = createEmptyPlan('p');
    init(plan);
    const first = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    prdAuthoring.savePrdVersionToActivePlan(md(first.text ?? '', '- sign up'));
    const before = structuredClone(plan.prdVersions);
    const r = prdAuthoring.relabelLatestPrdVersion('major', '1999-01-01T00:00:00.000Z');
    assert.equal(r.saved, false);
    assert.deepEqual(plan.prdVersions, before);
  });

  it('refuses to relabel a first version', () => {
    const plan = createEmptyPlan('p');
    init(plan);
    const first = prdAuthoring.savePrdVersionToActivePlan(md('## Requirements', '- login'));
    const r = prdAuthoring.relabelLatestPrdVersion('major', first.versions[0].createdAt);
    assert.equal(r.saved, false);
    assert.equal(plan.prdVersions?.[0].version, '1.0.0');
  });
});

// ─── F2-5: cmdGenerateDeltaPlan ───

describe('prd-authoring — cmdGenerateDeltaPlan', () => {
  const at = '2026-10-04T00:00:00.000Z';
  const deltaPlanJson = JSON.stringify({ version: '1.0', name: 'Delta', playlists: [{ id: 'a', name: 'Dev', tasks: [
    { id: 'n1', name: 'Sign up', prompt: 'p', requirementIds: ['R-2'] },
  ] }] });

  /** A plan whose latest version adds R-2 — one delta requirement. */
  function deltaPlan(): Plan {
    const plan = createEmptyPlan('p');
    plan.prdVersions = [
      { version: '1.0.0', text: md('## Requirements', '- [R-1] login'), createdAt: at },
      { version: '1.1.0', text: md('## Requirements', '- [R-1] login', '- [R-2] sign up'), createdAt: at,
        recommendedBump: 'minor', chosenBump: 'minor' },
    ];
    return plan;
  }

  let info: sinon.SinonStub;
  let warn: sinon.SinonStub;
  let error: sinon.SinonStub;

  beforeEach(() => {
    engineStub.runTask.reset();
    engineStub.runTask.resolves({ stdout: deltaPlanJson, stderr: '', exitCode: 0, durationMs: 1 });
    info = sinon.stub(vscodeMock.window, 'showInformationMessage').callsFake(async (...args: unknown[]) =>
      (args.includes('Generate') ? 'Generate' : undefined));
    warn = sinon.stub(vscodeMock.window, 'showWarningMessage').resolves(undefined);
    error = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
  });
  afterEach(() => sinon.restore());

  it('appends the delta playlist and saves when idle', async () => {
    const plan = deltaPlan();
    const save = sinon.spy();
    init(plan, { saveAndRefresh: save });
    await prdAuthoring.cmdGenerateDeltaPlan();
    assert.equal(engineStub.runTask.callCount, 1);
    assert.equal(engineStub.runTask.firstCall.args[0].costLabel, 'plan-generation');
    assert.equal(plan.playlists.length, 2);
    assert.equal(plan.playlists[1].name, 'PRD v1.1.0 delta');
    assert.equal(save.callCount, 1);
    assert.match(String(info.lastCall.args[0]), /^Delta plan added — 1 task\(s\) in "PRD v1\.1\.0 delta"$/);
    assert.equal(error.callCount, 0);
  });

  it('F2.8: a busy runner shows the busy message and never calls the engine', async () => {
    const plan = deltaPlan();
    init(plan, { isRunnerBusy: () => true });
    await prdAuthoring.cmdGenerateDeltaPlan({ prdText: 'x' });
    assert.equal(engineStub.runTask.callCount, 0);
    assert.equal(warn.callCount, 1);
    assert.equal(warn.firstCall.args[0], userMessages.runnerBusy().text);
    assert.equal(plan.playlists.length, 1);
  });

  it('no delta (single version) makes no engine call', async () => {
    const plan = deltaPlan();
    plan.prdVersions = [plan.prdVersions![0]];
    init(plan);
    await prdAuthoring.cmdGenerateDeltaPlan();
    assert.equal(engineStub.runTask.callCount, 0);
    assert.match(String(info.firstCall.args[0]), /^Nothing to generate/);
  });

  it('declining the confirmation makes no engine call', async () => {
    info.callsFake(async () => undefined);
    const plan = deltaPlan();
    init(plan);
    await prdAuthoring.cmdGenerateDeltaPlan();
    assert.equal(engineStub.runTask.callCount, 0);
    assert.equal(plan.playlists.length, 1);
  });

  it('a run that starts mid-generation discards the playlist instead of appending under it', async () => {
    const plan = deltaPlan();
    let busy = false;
    const save = sinon.spy();
    init(plan, { isRunnerBusy: () => busy, saveAndRefresh: save });
    engineStub.runTask.callsFake(async () => {
      busy = true;
      return { stdout: deltaPlanJson, stderr: '', exitCode: 0, durationMs: 1 };
    });
    await prdAuthoring.cmdGenerateDeltaPlan();
    assert.equal(engineStub.runTask.callCount, 1);
    assert.equal(plan.playlists.length, 1, 'the delta playlist was taken back out');
    assert.equal(save.callCount, 0);
    assert.match(String(warn.lastCall.args[0]), /A run started while generating/);
  });

  it('an active plan swapped mid-generation discards the playlist and warns instead of reporting it added', async () => {
    const plan = deltaPlan();
    const other = createEmptyPlan('other');
    let active: Plan = plan;
    const save = sinon.spy();
    init(plan, { getActivePlan: () => active, saveAndRefresh: save });
    engineStub.runTask.callsFake(async () => {
      active = other;
      return { stdout: deltaPlanJson, stderr: '', exitCode: 0, durationMs: 1 };
    });
    await prdAuthoring.cmdGenerateDeltaPlan();
    assert.equal(engineStub.runTask.callCount, 1);
    assert.equal(plan.playlists.length, 1, 'the delta playlist was taken back out of the orphaned plan');
    assert.equal(other.playlists.length, 1, 'the new active plan was not touched');
    assert.equal(save.callCount, 0);
    assert.match(String(warn.lastCall.args[0]), /The active plan changed while generating/);
    assert.ok(!info.getCalls().some(c => /^Delta plan added/.test(String(c.args[0]))), 'never reports "Delta plan added"');
  });

  it('an engine failure is reported and leaves the plan unchanged', async () => {
    engineStub.runTask.resolves({ stdout: '', stderr: 'boom', exitCode: 1, durationMs: 1 });
    const plan = deltaPlan();
    const before = structuredClone(plan);
    init(plan);
    await prdAuthoring.cmdGenerateDeltaPlan();
    assert.deepEqual(plan, before);
    assert.equal(error.callCount, 1);
  });

  it('a second request while one is in flight is refused', async () => {
    const plan = deltaPlan();
    init(plan);
    let release: () => void = () => { /* set below */ };
    engineStub.runTask.callsFake(() => new Promise((resolve) => {
      release = () => resolve({ stdout: deltaPlanJson, stderr: '', exitCode: 0, durationMs: 1 });
    }));
    const first = prdAuthoring.cmdGenerateDeltaPlan();
    await new Promise(r => setImmediate(r));
    await prdAuthoring.cmdGenerateDeltaPlan();
    assert.ok(info.getCalls().some(c => c.args[0] === 'A delta plan is already being generated.'));
    release();
    await first;
    assert.equal(engineStub.runTask.callCount, 1);
  });

  it('with no active plan falls back to full generation from the panel text', async () => {
    init(null);
    engineStub.runTask.resolves({ stdout: 'not json', stderr: '', exitCode: 0, durationMs: 1 });
    await prdAuthoring.cmdGenerateDeltaPlan({ prdText: md('## Requirements', '- login') });
    assert.equal(engineStub.runTask.callCount, 1);
    assert.match(engineStub.runTask.firstCall.args[0].prompt, /"Design" — UI\/UX specs/);
    assert.equal(error.firstCall.args[0], 'AI returned invalid JSON. Try again.');
  });
});
