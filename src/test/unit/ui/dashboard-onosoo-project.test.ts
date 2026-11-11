// ─── Dashboard: the ONOSOO project segment's host side ───

import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import type { OnosooProjectSegment } from '../../../ui/onosoo-project-id';
import type { ProjectSegmentModel } from '../../../headless/project-id';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

type PanelModule = typeof import('../../../ui/dashboard-panel');

const KEY_MODEL: ProjectSegmentModel = {
  kind: 'key', status: 'on', revokedTitle: 'revoked', projectKey: 'git:github.com/o/r', repoUrl: 'https://github.com/o/r', firstFolderName: null,
};

/** A fake segment whose model and copy/open results the test controls. */
function fakeSegment(model: ProjectSegmentModel = KEY_MODEL) {
  let current = model;
  const listeners = new Set<(m: ProjectSegmentModel) => void>();
  const seg = {
    current: () => current,
    onDidChange: (l: (m: ProjectSegmentModel) => void) => { listeners.add(l); return { dispose: () => { listeners.delete(l); } }; },
    refresh: sinon.spy(),
    copy: sinon.stub().resolves({ ok: true }),
    openRepository: sinon.stub().resolves(),
    dispose: sinon.spy(),
  };
  const change = (m: ProjectSegmentModel): void => { current = m; for (const l of [...listeners]) { l(m); } };
  return { seg: seg as unknown as OnosooProjectSegment & typeof seg, change, listeners };
}

describe('dashboard — ONOSOO project segment', () => {
  let mod: PanelModule;
  let onMessage: ((msg: Record<string, unknown>) => void) | null;
  let onDispose: (() => void) | null;
  let posted: Array<Record<string, unknown>>;
  let panel: { webview: { html: string } };

  beforeEach(() => {
    onMessage = null;
    onDispose = null;
    posted = [];
    panel = {
      webview: {
        html: '',
        options: {},
        cspSource: 'vscode-resource:',
        asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => void) => { onMessage = cb; return { dispose: () => undefined }; },
        postMessage: (m: Record<string, unknown>) => { posted.push(m); return Promise.resolve(true); },
      },
      onDidDispose: (cb: () => void) => { onDispose = cb; return { dispose: () => undefined }; },
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      reveal: () => undefined,
      dispose: () => undefined,
      visible: true,
    } as unknown as { webview: { html: string } };
    sinon.stub(vscodeMock.window, 'createWebviewPanel').returns(panel);
    mod = proxyquire('../../../ui/dashboard-panel', { vscode: vscodeMock }) as PanelModule;
  });

  afterEach(() => {
    try { onDispose?.(); } catch { /* already disposed */ }
    mod.DashboardPanel.setOnosooProject(null);
    sinon.restore();
  });

  function open(): void {
    const runner = { state: 'idle', getRunningServices: () => [] };
    const history = { getAll: () => [], getForTask: () => [] };
    mod.DashboardPanel.createOrShow(
      vscodeMock.Uri.file('/ext'), runner as never, history as never, () => null, () => undefined,
      () => [], () => undefined, async () => true, async () => true, () => null,
    );
  }

  /** The page's own build id, read back from the bootstrap block of the rendered HTML. */
  function htmlVersion(): string {
    const m = /<script id="moag-bootstrap" type="application\/json">([^<]*)<\/script>/.exec(panel.webview.html);
    assert.ok(m, 'the page carries its bootstrap block');
    return JSON.parse(m![1]).htmlVersion;
  }

  const sent = (type: string) => posted.filter((m) => m.type === type);
  const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) { await Promise.resolve(); } };

  it('the status bar carries the hidden segment and its polite live region', () => {
    open();
    assert.match(panel.webview.html, /<span id="onosoo-project" class="onosoo-project" role="group" aria-label="ONOSOO project" hidden><\/span>/);
    assert.match(panel.webview.html, /<span id="onosoo-project-live" class="visually-hidden" aria-live="polite"><\/span>/);
    assert.match(panel.webview.html, /Content-Security-Policy/);
  });

  it('webview-ready refreshes the segment and posts its model', () => {
    const f = fakeSegment();
    mod.DashboardPanel.setOnosooProject(f.seg);
    open();
    onMessage!({ type: 'webview-ready', htmlVersion: htmlVersion() });
    assert.equal(f.seg.refresh.callCount, 1);
    assert.deepEqual(sent('onosoo-project').pop(), { type: 'onosoo-project', segment: KEY_MODEL });
  });

  it('without a segment the model posted is hidden', () => {
    open();
    onMessage!({ type: 'webview-ready', htmlVersion: htmlVersion() });
    assert.deepEqual(sent('onosoo-project').pop(), { type: 'onosoo-project', segment: { kind: 'hidden' } });
  });

  it('a segment change is posted; a segment set after the panel opened is followed too', () => {
    open();
    const f = fakeSegment();
    mod.DashboardPanel.setOnosooProject(f.seg);
    assert.deepEqual(sent('onosoo-project').pop(), { type: 'onosoo-project', segment: KEY_MODEL });
    const revoked: ProjectSegmentModel = { ...KEY_MODEL, status: 'revoked' } as ProjectSegmentModel;
    f.change(revoked);
    assert.deepEqual(sent('onosoo-project').pop(), { type: 'onosoo-project', segment: revoked });
  });

  it('open-onosoo-repository ignores any URL in the message: only the host-held one is opened', async () => {
    const f = fakeSegment();
    mod.DashboardPanel.setOnosooProject(f.seg);
    const openExternal = sinon.stub(vscodeMock.env, 'openExternal').resolves(true);
    open();
    onMessage!({ type: 'open-onosoo-repository', url: 'https://evil.example' });
    await flush();
    assert.equal(f.seg.openRepository.callCount, 1);
    assert.deepEqual(f.seg.openRepository.firstCall.args, []);
    assert.equal(openExternal.called, false, 'the panel itself never opens a URL');
  });

  it('a rejecting openRepository is swallowed', async () => {
    const f = fakeSegment();
    f.seg.openRepository.rejects(new Error('boom'));
    mod.DashboardPanel.setOnosooProject(f.seg);
    open();
    onMessage!({ type: 'open-onosoo-repository' });
    await flush();
    assert.equal(f.seg.openRepository.callCount, 1);
  });

  it('copy-onosoo-project-id posts the result: ok, a refusal with its reason and phrase, and a rejection', async () => {
    const f = fakeSegment();
    mod.DashboardPanel.setOnosooProject(f.seg);
    open();
    onMessage!({ type: 'copy-onosoo-project-id', key: 'git:evil/injected' });
    await flush();
    assert.deepEqual(f.seg.copy.firstCall.args, []);
    assert.deepEqual(sent('onosoo-project-copied').pop(), { type: 'onosoo-project-copied', ok: true });
    f.seg.copy.resolves({ ok: false, reason: 'not_sent' });
    onMessage!({ type: 'copy-onosoo-project-id' });
    await flush();
    assert.deepEqual(sent('onosoo-project-copied').pop(),
      { type: 'onosoo-project-copied', ok: false, reason: 'not_sent', phrase: 'its ID would not be sent to ONOSOO' });
    f.seg.copy.rejects(new Error('boom'));
    onMessage!({ type: 'copy-onosoo-project-id' });
    await flush();
    assert.deepEqual(sent('onosoo-project-copied').pop(), { type: 'onosoo-project-copied', ok: false });
  });

  it('copy without a segment answers not ok', () => {
    open();
    onMessage!({ type: 'copy-onosoo-project-id' });
    assert.deepEqual(sent('onosoo-project-copied').pop(), { type: 'onosoo-project-copied', ok: false });
  });

  it('after the panel is disposed a segment change posts nothing and the subscription is gone', () => {
    const f = fakeSegment();
    mod.DashboardPanel.setOnosooProject(f.seg);
    open();
    assert.equal(f.listeners.size, 1);
    onDispose!();
    onDispose = null;
    const before = posted.length;
    f.change({ kind: 'hidden' });
    assert.equal(posted.length, before);
    assert.equal(f.listeners.size, 0);
  });

  it('setOnosooProject(null) posts hidden and drops the old subscription', () => {
    const f = fakeSegment();
    mod.DashboardPanel.setOnosooProject(f.seg);
    open();
    mod.DashboardPanel.setOnosooProject(null);
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(sent('onosoo-project').pop(), { type: 'onosoo-project', segment: { kind: 'hidden' } });
  });
});
