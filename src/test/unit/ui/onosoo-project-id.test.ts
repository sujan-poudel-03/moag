// ─── onosoo-project-id: MOAG: Copy ONOSOO Project ID ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { PROJECT_ID_DEADLINE_MS, PROJECT_ID_REASON_PHRASES } from '../../../headless/project-id';
import { REVOKED_MESSAGE } from '../../../headless/onosoo-relay';
import type { IdentityAbsenceReason } from '../../../headless/project-id';
import type { ProjectIdentity, ProjectIdentityResolution } from '../../../headless/project-identity';
import type { OnosooProjectView } from '../../../ui/onosoo-relay-host';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

type Mod = typeof import('../../../ui/onosoo-project-id');

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function load(): Mod {
  const userMessages = proxyquire('../../../utils/user-messages', { vscode: vscodeMock });
  return proxyquire('../../../ui/onosoo-project-id', { vscode: vscodeMock, '../utils/user-messages': userMessages }) as Mod;
}

const GIT: ProjectIdentity = { project_key: 'git:github.com/o/r', repo_url: 'https://github.com/o/r' };
const ROOT: ProjectIdentity = { project_key: 'root:' + 'a'.repeat(40) };

interface FakeViewOpts {
  peek?: ProjectIdentity | null;
  reason?: IdentityAbsenceReason;
  warm?: (dir: string) => Promise<ProjectIdentity | null>;
  env?: NodeJS.ProcessEnv;
}

/** A relay-host project view over a fake cache; warm() fills peek()/reasonOf() like the real one. */
function fakeView(cfg: string, o: FakeViewOpts = {}) {
  let held: ProjectIdentity | null | undefined = o.peek;
  let reason: IdentityAbsenceReason | undefined = o.reason;
  const warm = sinon.spy(async (dir: string) => {
    const v = o.warm ? await o.warm(dir) : null;
    held = v;
    return v;
  });
  const view: OnosooProjectView = {
    status: () => 'on',
    folder: () => vscodeMock.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    firstFolderName: () => vscodeMock.workspace.workspaceFolders?.[0]?.name ?? null,
    isMultiRoot: () => (vscodeMock.workspace.workspaceFolders?.length ?? 0) > 1,
    env: () => o.env ?? { APPDATA: cfg, XDG_CONFIG_HOME: cfg },
    identities: {
      peek: () => held,
      reasonOf: () => reason,
      warm: (dir: string) => warm(dir),
    },
    onDidChange: () => ({ dispose: () => undefined }),
  };
  return { view, warm, setReason: (r: IdentityAbsenceReason | undefined) => { reason = r; } };
}

describe('onosoo-project-id — Copy ONOSOO Project ID', () => {
  let mod: Mod;
  let folders: unknown;
  let ws: string;
  let ws2: string;
  let cfg: string;
  let writeText: sinon.SinonStub;
  let info: sinon.SinonStub;
  let warn: sinon.SinonStub;
  let quickPick: sinon.SinonStub;
  let withProgress: sinon.SinonSpy;
  const noKey = async (): Promise<string | undefined> => undefined;

  beforeEach(() => {
    mod = load();
    folders = vscodeMock.workspace.workspaceFolders;
    ws = tmp('moag-copy-ws-');
    ws2 = tmp('moag-copy-ws2-');
    cfg = tmp('moag-copy-cfg-');
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: ws }, name: 'first', index: 0 }];
    writeText = sinon.stub(vscodeMock.env.clipboard, 'writeText').resolves();
    info = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
    warn = sinon.stub(vscodeMock.window, 'showWarningMessage').resolves(undefined);
    quickPick = sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);
    withProgress = sinon.spy(vscodeMock.window, 'withProgress');
  });

  afterEach(() => {
    sinon.restore();
    vscodeMock.workspace.workspaceFolders = folders;
  });

  const twoFolders = (): void => {
    vscodeMock.workspace.workspaceFolders = [
      { uri: { fsPath: ws }, name: 'first', index: 0 },
      { uri: { fsPath: ws2 }, name: 'second', index: 1 },
    ];
  };

  it('no folder: one info line, nothing written, no lookup', async () => {
    vscodeMock.workspace.workspaceFolders = undefined;
    const resolveDirect = sinon.stub().resolves({ identity: GIT, reason: null });
    const f = fakeView(cfg, { warm: async () => GIT });
    await mod.cmdCopyOnosooProjectId(f.view, { resolveDirect, storedAnthropicKey: noKey });
    assert.equal(info.callCount, 1);
    assert.equal(info.firstCall.args[0], 'Open a folder to get its ONOSOO project ID.');
    assert.equal(writeText.called, false);
    assert.equal(f.warm.called, false);
    assert.equal(resolveDirect.called, false);
    vscodeMock.workspace.workspaceFolders = [];
    await mod.cmdCopyOnosooProjectId(undefined, { resolveDirect, storedAnthropicKey: noKey });
    assert.equal(info.callCount, 2);
    assert.equal(resolveDirect.called, false);
  });

  it('one folder: no picker; success copies the key once and names key and URL', async () => {
    const f = fakeView(cfg, { warm: async () => GIT });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(quickPick.called, false);
    assert.equal(writeText.callCount, 1);
    assert.equal(writeText.firstCall.args[0], GIT.project_key);
    assert.equal(info.callCount, 1);
    const text = info.firstCall.args[0] as string;
    assert.ok(text.includes(GIT.project_key) && text.includes(GIT.repo_url!), text);
    assert.ok(!text.includes('first folder'), 'the first folder needs no note');
    assert.equal(warn.called, false);
  });

  it('a root: key is copied without a repository URL', async () => {
    const f = fakeView(cfg, { warm: async () => ({ ...ROOT, repo_url: 'https://github.com/o/r' }) });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(writeText.firstCall.args[0], ROOT.project_key);
    assert.ok(!(info.firstCall.args[0] as string).includes('repository:'));
  });

  it('two folders: the picker comes first; Escape writes nothing and says nothing', async () => {
    twoFolders();
    const f = fakeView(cfg, { warm: async () => GIT });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(quickPick.callCount, 1);
    const [items, options] = quickPick.firstCall.args as [Array<{ label: string; detail: string; description?: string }>, { title: string; placeHolder: string }];
    assert.deepEqual(items.map((i) => [i.label, i.detail, i.description]), [['first', ws, 'Runs started in VS Code report this folder'], ['second', ws2, undefined]]);
    assert.equal(options.title, 'Copy ONOSOO Project ID');
    assert.equal(options.placeHolder, 'Choose the folder whose ONOSOO project ID to copy');
    assert.equal(writeText.called, false);
    assert.equal(info.called, false);
    assert.equal(warn.called, false);
    assert.equal(f.warm.called, false);
    assert.equal(withProgress.called, false);
  });

  it('picking the second folder copies its key and notes that runs report the first', async () => {
    twoFolders();
    quickPick.callsFake(async (items: Array<{ folder: unknown }>) => items[1]);
    const f = fakeView(cfg, { warm: async () => ROOT });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(f.warm.firstCall.args[0], ws2);
    assert.equal(writeText.firstCall.args[0], ROOT.project_key);
    assert.ok((info.firstCall.args[0] as string).endsWith(' Runs started in VS Code report the first folder, first, not this one.'));
  });

  it('a key that contains the folder is not copied, and the warning never shows it', async () => {
    const bad: ProjectIdentity = { project_key: 'git:' + path.join(ws, 'x') };
    const f = fakeView(cfg, { warm: async () => bad });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(writeText.called, false);
    assert.equal(warn.callCount, 1);
    const text = warn.firstCall.args[0] as string;
    assert.ok(text.startsWith('Nothing copied: this folder\'s ONOSOO project ID would not be sent to ONOSOO'));
    assert.ok(!text.includes(bad.project_key) && !text.includes(ws));
    assert.equal(info.called, false);
  });

  it('a key containing the stored Anthropic key is not sent (criterion 6)', async () => {
    const stored = 'StoredAnthropicValue' + 'x'.repeat(12);
    const id: ProjectIdentity = { project_key: 'git:github.com/o/' + stored };
    const f = fakeView(cfg, { warm: async () => id });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(writeText.callCount, 1, 'without the stored key the same ID is copied');
    writeText.resetHistory();
    const g = fakeView(cfg, { warm: async () => id });
    await mod.cmdCopyOnosooProjectId(g.view, { storedAnthropicKey: async () => stored });
    assert.equal(writeText.called, false);
    assert.ok(!(warn.lastCall.args[0] as string).includes(stored));
  });

  it('a key containing the paired device key is not sent', async () => {
    const device = 'onosoo_live_' + 'D'.repeat(43);
    const id: ProjectIdentity = { project_key: 'git:github.com/o/' + device };
    const f = fakeView(cfg, { warm: async () => id, env: { APPDATA: cfg, XDG_CONFIG_HOME: cfg, MOAG_ONOSOO_KEY: device, MOAG_ONOSOO_URL: 'https://xyz.supabase.co' } });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(writeText.called, false);
    assert.equal(warn.callCount, 1);
  });

  for (const reason of ['not_a_repo', 'git_unreadable', 'no_commits', 'shallow_no_origin'] as IdentityAbsenceReason[]) {
    it(`absent (${reason}): nothing copied, the reason phrase in one warning`, async () => {
      const f = fakeView(cfg, { warm: async () => null });
      f.setReason(reason);
      await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
      assert.equal(writeText.called, false);
      assert.equal(warn.callCount, 1);
      assert.equal(warn.firstCall.args[0], `Nothing copied: this folder has no ONOSOO project ID — ${PROJECT_ID_REASON_PHRASES[reason]}.`);
    });
  }

  it('an identity the cache already holds is used at once: no progress, no lookup (criterion 16)', async () => {
    const f = fakeView(cfg, { peek: GIT, warm: async () => GIT });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(withProgress.called, false);
    assert.equal(f.warm.called, false);
    assert.equal(writeText.firstCall.args[0], GIT.project_key);
    const absent = fakeView(cfg, { peek: null, reason: 'no_commits' });
    await mod.cmdCopyOnosooProjectId(absent.view, { storedAnthropicKey: noKey });
    assert.equal(withProgress.called, false);
    assert.equal(absent.warm.called, false);
    assert.ok((warn.lastCall.args[0] as string).includes(PROJECT_ID_REASON_PHRASES.no_commits));
  });

  it('a cached null without a reason is resolved again, with progress', async () => {
    const resolveDirect = sinon.stub().resolves({ identity: null, reason: 'shallow_no_origin' } as ProjectIdentityResolution);
    const f = fakeView(cfg, { peek: null, warm: async () => null });
    await mod.cmdCopyOnosooProjectId(f.view, { resolveDirect, storedAnthropicKey: noKey });
    assert.equal(withProgress.callCount, 1);
    assert.equal(withProgress.firstCall.args[0].title, 'Resolving ONOSOO project ID…');
    assert.equal(withProgress.firstCall.args[0].cancellable, true);
    assert.equal(withProgress.firstCall.args[0].location, vscodeMock.ProgressLocation.Notification);
    assert.equal(f.warm.callCount, 1);
    assert.equal(resolveDirect.callCount, 1, 'warm gave null with no reason, so it resolves directly');
    assert.ok((warn.firstCall.args[0] as string).includes(PROJECT_ID_REASON_PHRASES.shallow_no_origin));
  });

  it('without a relay host the folder is resolved directly', async () => {
    const resolveDirect = sinon.stub().resolves({ identity: GIT, reason: null } as ProjectIdentityResolution);
    await mod.cmdCopyOnosooProjectId(undefined, { resolveDirect, storedAnthropicKey: noKey });
    assert.equal(resolveDirect.firstCall.args[0], ws);
    assert.equal(writeText.firstCall.args[0], GIT.project_key);
  });

  it('a lookup that rejects is git_unreadable, nothing copied', async () => {
    const resolveDirect = sinon.stub().rejects(new Error('boom'));
    await mod.cmdCopyOnosooProjectId(undefined, { resolveDirect, storedAnthropicKey: noKey });
    assert.equal(writeText.called, false);
    assert.ok((warn.firstCall.args[0] as string).includes(PROJECT_ID_REASON_PHRASES.git_unreadable));
  });

  it('cancelling the progress writes nothing and says nothing', async () => {
    withProgress.restore();
    let cancel: () => void = () => undefined;
    const sub = { dispose: sinon.spy() };
    sinon.stub(vscodeMock.window, 'withProgress').callsFake(async (...args: unknown[]) => {
      const task = args[1] as (p: unknown, t: unknown) => Promise<unknown>;
      const p = task({ report: () => undefined }, {
        isCancellationRequested: false,
        onCancellationRequested: (cb: () => void) => { cancel = cb; return sub; },
      });
      cancel();
      return p;
    });
    const f = fakeView(cfg, { warm: () => new Promise<ProjectIdentity | null>(() => undefined) });
    await mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey });
    assert.equal(writeText.called, false);
    assert.equal(info.called, false);
    assert.equal(warn.called, false);
    assert.equal(sub.dispose.callCount, 1, 'the cancellation subscription is disposed');
  });

  describe('deadline (fake timers)', () => {
    let clock: sinon.SinonFakeTimers;
    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => { clock.restore(); });

    it('a lookup that never settles ends at PROJECT_ID_DEADLINE_MS: timeout warning with Try Again, nothing written', async () => {
      const f = fakeView(cfg, { warm: () => new Promise<ProjectIdentity | null>(() => undefined) });
      let done = false;
      void mod.cmdCopyOnosooProjectId(f.view, { storedAnthropicKey: noKey }).then(() => { done = true; });
      await clock.tickAsync(PROJECT_ID_DEADLINE_MS - 1);
      assert.equal(done, false);
      assert.equal(warn.called, false);
      await clock.tickAsync(1);
      assert.equal(done, true);
      assert.equal(writeText.called, false);
      assert.equal(warn.callCount, 1);
      assert.equal(warn.firstCall.args[0], 'Nothing copied: the ONOSOO project ID could not be resolved in time.');
      assert.equal(warn.firstCall.args[1], 'Try Again');
    });
  });

  it('never reads or imports the runner (identical in every RunnerState)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'onosoo-project-id.ts'), 'utf-8');
    assert.ok(!/from '\.\.\/runner\//.test(source), 'no runner import');
    assert.ok(!/runnerBusy|\.state\b/.test(source), 'no runner state read');
  });
});

// ─── Dashboard segment ───

describe('onosoo-project-id — dashboard segment', () => {
  let mod: Mod;
  let cfg: string;
  let wsA: string;
  let wsB: string;

  /** A controllable relay-host view: status, first folder, a cache and change listeners. */
  function controlView() {
    const st = {
      status: 'on' as 'none' | 'on' | 'off' | 'revoked',
      folder: wsA as string | null,
      multi: false,
      held: new Map<string, ProjectIdentity | null>(),
      reasons: new Map<string, IdentityAbsenceReason>(),
      pending: new Map<string, (v: ProjectIdentity | null, reason?: IdentityAbsenceReason) => void>(),
    };
    const listeners = new Set<() => void>();
    const warm = sinon.spy((dir: string) => new Promise<ProjectIdentity | null>((resolve) => {
      st.pending.set(dir, (v, reason) => {
        st.held.set(dir, v);
        if (reason) { st.reasons.set(dir, reason); } else { st.reasons.delete(dir); }
        resolve(v);
      });
    }));
    const view: OnosooProjectView = {
      status: () => st.status,
      folder: () => st.folder,
      firstFolderName: () => (st.folder ? path.basename(st.folder) : null),
      isMultiRoot: () => st.multi,
      env: () => ({ APPDATA: cfg, XDG_CONFIG_HOME: cfg }),
      identities: {
        peek: (d) => (st.held.has(d) ? st.held.get(d) : undefined),
        reasonOf: (d) => st.reasons.get(d),
        warm: (d) => warm(d),
      },
      onDidChange: (l) => { listeners.add(l); return { dispose: () => { listeners.delete(l); } }; },
    };
    const fire = (): void => { for (const l of [...listeners]) { l(); } };
    return { st, view, warm, fire, listeners };
  }

  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) { await Promise.resolve(); } };

  beforeEach(() => {
    mod = load();
    cfg = tmp('moag-seg-cfg-');
    wsA = tmp('moag-seg-a-');
    wsB = tmp('moag-seg-b-');
  });

  afterEach(() => { sinon.restore(); });

  it('is hidden while unpaired (none), and starts no lookup', async () => {
    const c = controlView();
    c.st.status = 'none';
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    seg.refresh();
    await flush();
    assert.deepEqual(seg.current(), { kind: 'hidden' });
    assert.equal(c.warm.called, false);
  });

  it('resolving, then the key with its URL once the lookup lands', async () => {
    const c = controlView();
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    const seen: string[] = [];
    seg.onDidChange((m) => seen.push(m.kind));
    seg.refresh();
    assert.equal(seg.current().kind, 'resolving');
    assert.equal(c.warm.callCount, 1);
    c.st.pending.get(wsA)!(GIT);
    await flush();
    assert.deepEqual(seg.current(), {
      kind: 'key', status: 'on', revokedTitle: REVOKED_MESSAGE,
      projectKey: GIT.project_key, repoUrl: GIT.repo_url, firstFolderName: null,
    });
    assert.deepEqual(seen, ['resolving', 'key']);
  });

  it('an absent folder shows none with its reason', async () => {
    const c = controlView();
    c.st.held.set(wsA, null);
    c.st.reasons.set(wsA, 'no_commits');
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    seg.refresh();
    await flush();
    const m = seg.current();
    assert.equal(m.kind, 'none');
    assert.equal(m.kind === 'none' && m.reason, 'no_commits');
    assert.equal(m.kind === 'none' && m.phrase, PROJECT_ID_REASON_PHRASES.no_commits);
  });

  it('a cached null without a reason is resolved directly once', async () => {
    const c = controlView();
    c.st.held.set(wsA, null);
    const resolveDirect = sinon.stub().resolves({ identity: null, reason: 'shallow_no_origin' } as ProjectIdentityResolution);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined, resolveDirect });
    seg.refresh();
    c.st.pending.get(wsA)!(null);
    await flush();
    assert.equal(resolveDirect.callCount, 1);
    const m = seg.current();
    assert.equal(m.kind === 'none' && m.reason, 'shallow_no_origin');
  });

  it('not_sent: the key is nowhere in the model', async () => {
    const c = controlView();
    const bad: ProjectIdentity = { project_key: 'git:' + path.join(wsA, 'hidden-key-part') };
    c.st.held.set(wsA, bad);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    seg.refresh();
    await flush();
    const m = seg.current();
    assert.equal(m.kind === 'none' && m.reason, 'not_sent');
    assert.ok(!JSON.stringify(m).includes('hidden-key-part'));
  });

  it('a status change from the view (mid-run revoked) re-emits with the new status', async () => {
    const c = controlView();
    c.st.held.set(wsA, ROOT);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    const seen: string[] = [];
    seg.onDidChange((m) => seen.push(m.kind === 'hidden' ? 'hidden' : m.status));
    seg.refresh();
    await flush();
    c.st.status = 'revoked';
    c.fire();
    await flush();
    assert.deepEqual(seen, ['on', 'revoked']);
    c.st.status = 'none';
    c.fire();
    await flush();
    assert.deepEqual(seg.current(), { kind: 'hidden' });
  });

  it('a folder change goes straight to resolving and never shows the previous key', async () => {
    const c = controlView();
    c.st.held.set(wsA, GIT);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    seg.refresh();
    await flush();
    assert.equal(seg.current().kind, 'key');
    const models: string[] = [];
    seg.onDidChange((m) => models.push(JSON.stringify(m)));
    c.st.folder = wsB;
    c.fire();
    assert.equal(seg.current().kind, 'resolving');
    assert.ok(models.every((m) => !m.includes(GIT.project_key)), 'the old key is never re-emitted');
    c.st.pending.get(wsB)!(ROOT);
    await flush();
    const m = seg.current();
    assert.equal(m.kind === 'key' && m.projectKey, ROOT.project_key);
  });

  it('a folder change to a folder already cached shows resolving first, then its key (never the old one)', async () => {
    const c = controlView();
    c.st.held.set(wsA, GIT);
    c.st.held.set(wsB, ROOT);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    seg.refresh();
    await flush();
    const models: ProjectSegmentModelLike[] = [];
    seg.onDidChange((m) => models.push(m));
    c.st.folder = wsB;
    c.fire();
    await flush();
    assert.deepEqual(models.map((m) => m.kind), ['resolving', 'key']);
  });

  it('the same folder with no answer yet keeps the last model (no flicker)', async () => {
    const c = controlView();
    c.st.held.set(wsA, GIT);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    seg.refresh();
    await flush();
    const before = seg.current();
    c.st.held.delete(wsA);
    const changes = sinon.spy();
    seg.onDidChange(changes);
    c.fire();
    await flush();
    assert.deepEqual(seg.current(), before);
    assert.equal(changes.called, false);
  });

  it('a late result of an older refresh is discarded', async () => {
    const c = controlView();
    c.st.held.set(wsA, ROOT);
    let releaseFirst: (v: string | undefined) => void = () => undefined;
    const storedKey = sinon.stub();
    storedKey.onFirstCall().returns(new Promise<string | undefined>((r) => { releaseFirst = r; }));
    storedKey.resolves(undefined);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: storedKey });
    seg.refresh();
    c.st.status = 'off';
    seg.refresh();
    await flush();
    assert.equal(seg.current().kind === 'key' && (seg.current() as { status: string }).status, 'off');
    releaseFirst(undefined);
    await flush();
    assert.equal((seg.current() as { status: string }).status, 'off', 'the older "on" result never lands');
  });

  it('copy() checks again with fresh inputs: a stored key that now matches refuses, nothing written', async () => {
    const c = controlView();
    const stored = 'StoredAnthropicValue' + 'x'.repeat(12);
    const id: ProjectIdentity = { project_key: 'git:github.com/o/' + stored };
    c.st.held.set(wsA, id);
    let current: string | undefined;
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => current });
    seg.refresh();
    await flush();
    assert.equal(seg.current().kind, 'key');
    const writeText = sinon.stub(vscodeMock.env.clipboard, 'writeText').resolves();
    current = stored;
    assert.deepEqual(await seg.copy(), { ok: false, reason: 'not_sent' });
    assert.equal(writeText.called, false);
    current = undefined;
    assert.deepEqual(await seg.copy(), { ok: true });
    assert.equal(writeText.callCount, 1);
    assert.equal(writeText.firstCall.args[0], id.project_key);
  });

  it('copy(): an absent folder gives its reason; a clipboard failure is not ok and shows an error', async () => {
    const c = controlView();
    c.st.held.set(wsA, null);
    c.st.reasons.set(wsA, 'not_a_repo');
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    assert.deepEqual(await seg.copy(), { ok: false, reason: 'not_a_repo' });
    c.st.held.set(wsA, ROOT);
    c.st.reasons.delete(wsA);
    sinon.stub(vscodeMock.env.clipboard, 'writeText').rejects(new Error('denied'));
    const err = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
    assert.deepEqual(await seg.copy(), { ok: false });
    assert.equal(err.firstCall.args[0], 'Could not copy the ONOSOO project ID: denied');
  });

  it('openRepository() opens exactly the held URL; nothing for root:, an http URL, or while unpaired', async () => {
    const c = controlView();
    const open = sinon.stub(vscodeMock.env, 'openExternal').resolves(true);
    c.st.held.set(wsA, GIT);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    await seg.openRepository();
    assert.equal(open.callCount, 1);
    assert.equal(String(open.firstCall.args[0]), GIT.repo_url);
    c.st.held.set(wsA, { ...ROOT, repo_url: 'https://github.com/o/r' });
    await seg.openRepository();
    c.st.held.set(wsA, { project_key: 'git:github.com/o/r', repo_url: 'http://github.com/o/r' });
    await seg.openRepository();
    c.st.held.set(wsA, GIT);
    c.st.status = 'none';
    await seg.openRepository();
    assert.equal(open.callCount, 1);
  });

  it('after dispose a view change emits nothing and the view listener is removed', async () => {
    const c = controlView();
    c.st.held.set(wsA, ROOT);
    const seg = mod.createOnosooProjectSegment(c.view, { storedAnthropicKey: async () => undefined });
    const changes = sinon.spy();
    seg.onDidChange(changes);
    seg.dispose();
    assert.equal(c.listeners.size, 0);
    seg.refresh();
    await flush();
    assert.equal(changes.called, false);
  });
});

type ProjectSegmentModelLike = { kind: string };
