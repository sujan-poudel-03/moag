import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const MOAG_ISSUES_NEW = 'https://github.com/sujan-poudel-03/moag/issues/new';

type Handler = (msg: Record<string, unknown>) => Promise<void>;

interface FakePanel {
  posted: unknown[];
  disposed: boolean;
  html: string;
  send: Handler;
  fireDispose(): void;
}

interface Harness {
  mod: {
    cmdReportIssue(prefill?: string): Promise<void>;
    cmdShareRunFeedback(): Promise<void>;
    buildNewIssueUrl(title: string, body: string, platform: NodeJS.Platform): { url: string; truncated: boolean };
    initSelfReporting(d: unknown): void;
  };
  ghCalls: string[][];
  execCalls: string[];
  opened: string[];
  clipboard: string[];
  executed: string[];
  panels: FakePanel[];
  restore(): void;
}

/**
 * Load self-reporting with gh and child_process stubbed and every vscode call
 * recorded. `ghSignedIn` decides whether `gh auth status` succeeds.
 */
function load(opts: { ghSignedIn: boolean; moagDir?: string | null; extraSecrets?: string[] }): Harness {
  const ghCalls: string[][] = [];
  const execCalls: string[] = [];
  const opened: string[] = [];
  const clipboard: string[] = [];
  const executed: string[] = [];
  const panels: FakePanel[] = [];

  const saved = {
    createWebviewPanel: vscodeMock.window.createWebviewPanel,
    openExternal: vscodeMock.env.openExternal,
    writeText: vscodeMock.env.clipboard.writeText,
    executeCommand: vscodeMock.commands.executeCommand,
    showInformationMessage: vscodeMock.window.showInformationMessage,
  };
  vscodeMock.window.createWebviewPanel = () => {
    let handler: Handler = async () => { /* replaced */ };
    let onDispose: () => void = () => { /* replaced */ };
    const fake: FakePanel = {
      posted: [], disposed: false, html: '',
      send: (m) => handler(m),
      fireDispose: () => { fake.disposed = true; onDispose(); },
    };
    panels.push(fake);
    return {
      webview: {
        set html(v: string) { fake.html = v; },
        get html() { return fake.html; },
        cspSource: '',
        asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: (h: Handler) => { handler = h; return { dispose() { /* */ } }; },
        postMessage: async (m: unknown) => { fake.posted.push(m); return true; },
      },
      onDidDispose: (cb: () => void) => { onDispose = cb; return { dispose() { /* */ } }; },
      dispose: () => fake.fireDispose(),
    };
  };
  vscodeMock.env.openExternal = async (u: { toString(): string; fsPath?: string }) => { opened.push(String(u.fsPath ?? u)); return true; };
  vscodeMock.env.clipboard.writeText = async (t: string) => { clipboard.push(t); };
  vscodeMock.commands.executeCommand = async (id: string) => { executed.push(id); return undefined; };
  vscodeMock.window.showInformationMessage = () => Promise.resolve(undefined);

  // Uri.parse is not in the base mock; the URL string is all these tests need.
  if (!vscodeMock.Uri.parse) { vscodeMock.Uri.parse = (s: string) => new vscodeMock.Uri(s); }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') { return vscodeMock; }
    return originalLoad.call(Module, request, parent, isMain);
  };
  let mod: Harness['mod'];
  try {
    mod = proxyquire('../../../ui/self-reporting', {
      vscode: vscodeMock,
      '../utils/gh': {
        ghSync: (args: string[]) => { ghCalls.push(args); return 'https://github.com/sujan-poudel-03/moag/issues/99\n'; },
        ghAsync: async () => '',
      },
      child_process: {
        execSync: (cmd: string) => {
          execCalls.push(cmd);
          if (cmd.startsWith('gh ') && !opts.ghSignedIn) { throw new Error('gh: not logged in'); }
          if (cmd.startsWith('git remote')) { return Buffer.from('git@github.com:acme/app.git\n'); }
          return Buffer.from('');
        },
        spawn: () => { throw new Error('spawn not expected'); },
      },
      '../workspace/moag-paths': { getMoagDir: () => opts.moagDir ?? null },
      '../context/project-analyzer': { analyzeProject: () => ({ language: 'ts', framework: '' }) },
    });
  } finally {
    Module._load = originalLoad;
  }
  mod.initSelfReporting({
    historyStore: { getAll: () => [], getForRun: () => [] },
    runSessionStore: { get: () => undefined },
    escalatedTaskIds: new Set<string>(),
    executionTaskCount: () => 0,
    executionTasksFailed: () => 0,
    appendOutput: () => { /* */ },
    extraSecrets: async () => opts.extraSecrets ?? [],
  });

  return {
    mod, ghCalls, execCalls, opened, clipboard, executed, panels,
    restore: () => {
      vscodeMock.window.createWebviewPanel = saved.createWebviewPanel;
      vscodeMock.env.openExternal = saved.openExternal;
      vscodeMock.env.clipboard.writeText = saved.writeText;
      vscodeMock.commands.executeCommand = saved.executeCommand;
      vscodeMock.window.showInformationMessage = saved.showInformationMessage;
      vscodeMock.clearMockConfig();
    },
  };
}

describe('self-reporting: bug reports go to the MOAG repository', () => {
  let h: Harness | null = null;
  afterEach(() => { h?.restore(); h = null; });

  it('with gh signed in, files to sujan-poudel-03/moag with no labels, even when issueRepo is set', async () => {
    vscodeMock.setMockConfig('agentTaskPlayer', { issueRepo: 'acme/app', 'issueSync.label': 'mine' });
    h = load({ ghSignedIn: true });
    await h.mod.cmdReportIssue('boom');
    const panel = h.panels[0];
    await panel.send({ type: 'submitReport', description: 'it broke' });
    assert.equal(h.ghCalls.length, 0, 'nothing is posted before the user confirms');
    await panel.send({ type: 'confirmPost' });

    assert.equal(h.ghCalls.length, 1);
    const args = h.ghCalls[0];
    const i = args.indexOf('--repo');
    assert.deepEqual(args.slice(i, i + 2), ['--repo', 'sujan-poudel-03/moag']);
    assert.ok(!args.includes('--label'), `no labels: ${args.join(' ')}`);
    assert.ok(!args.includes('label'), 'no gh label create');
    assert.ok(!h.executed.includes('agentTaskPlayer.ghSyncPollNow'));
    assert.ok(panel.disposed, 'the panel closes after posting');
  });

  it('without gh, opens a prefilled MOAG issues/new page and never calls gh', async () => {
    h = load({ ghSignedIn: false });
    await h.mod.cmdReportIssue();
    const panel = h.panels[0];
    await panel.send({ type: 'submitReport', description: 'short' });
    await panel.send({ type: 'confirmPost' });

    assert.equal(h.ghCalls.length, 0);
    assert.equal(h.opened.length, 1);
    assert.ok(h.opened[0].startsWith(MOAG_ISSUES_NEW + '?title='), h.opened[0]);
    assert.equal(h.clipboard.length, 0, 'a short report needs no clipboard copy');
  });

  it('without gh, a report too long for a link is shortened and the full body goes to the clipboard', async () => {
    h = load({ ghSignedIn: false });
    await h.mod.cmdReportIssue();
    const panel = h.panels[0];
    await panel.send({ type: 'submitReport', description: 'y'.repeat(20000) });
    await panel.send({ type: 'confirmPost' });

    assert.equal(h.opened.length, 1);
    assert.ok(h.opened[0].length <= (process.platform === 'win32' ? 2000 : 8000));
    assert.equal(h.clipboard.length, 1);
    assert.ok(h.clipboard[0].includes('y'.repeat(20000)), 'the clipboard holds the whole body');
  });

  it('the preview carries the redacted body, never a secret', async () => {
    h = load({ ghSignedIn: true, extraSecrets: ['onosoo-device-key-abcdef'] });
    const ant = 'sk-ant-api03-' + 'Z'.repeat(40);
    await h.mod.cmdReportIssue(`failed with ${ant}`);
    const panel = h.panels[0];
    await panel.send({ type: 'submitReport', description: 'key onosoo-device-key-abcdef leaked' });

    const preview = panel.posted.find((m) => (m as { type?: string }).type === 'preview') as { title: string; body: string } | undefined;
    assert.ok(preview, 'a preview message was posted');
    assert.ok(!preview.body.includes(ant), 'the Anthropic key reached the preview');
    assert.ok(!preview.body.includes('onosoo-device-key-abcdef'), 'an extra secret reached the preview');
    assert.ok(!panel.html.includes(ant), 'the Anthropic key reached the panel HTML');
  });

  it('a browser fallback that fails shows an error and keeps the panel (Copy still works)', async () => {
    h = load({ ghSignedIn: false });
    const errors: string[] = [];
    const savedErr = vscodeMock.window.showErrorMessage;
    const savedOpen = vscodeMock.env.openExternal;
    vscodeMock.window.showErrorMessage = (m: string) => { errors.push(m); return Promise.resolve(undefined); };
    vscodeMock.env.openExternal = async () => { throw new Error('no browser'); };
    try {
      await h.mod.cmdReportIssue();
      const panel = h.panels[0];
      await panel.send({ type: 'submitReport', description: 'x' });
      await panel.send({ type: 'confirmPost' }); // resolves: no unhandled rejection
      assert.deepEqual(errors, ['MOAG could not post the report: no browser.']);
      assert.equal(panel.disposed, false);
    } finally {
      vscodeMock.window.showErrorMessage = savedErr;
      vscodeMock.env.openExternal = savedOpen;
    }
  });

  it('posts nothing to a panel the user already closed', async () => {
    h = load({ ghSignedIn: true });
    await h.mod.cmdReportIssue();
    const panel = h.panels[0];
    panel.fireDispose();
    await panel.send({ type: 'submitReport', description: 'late' });
    assert.deepEqual(panel.posted, []);
  });

  it('Cancel closes the panel without posting', async () => {
    h = load({ ghSignedIn: true });
    await h.mod.cmdReportIssue();
    const panel = h.panels[0];
    await panel.send({ type: 'submitReport', description: 'x' });
    await panel.send({ type: 'cancel' });
    assert.ok(panel.disposed);
    assert.equal(h.ghCalls.length, 0);
  });

  it('Copy puts the redacted title and body on the clipboard', async () => {
    h = load({ ghSignedIn: true });
    await h.mod.cmdReportIssue();
    const panel = h.panels[0];
    await panel.send({ type: 'submitReport', description: 'copy me' });
    await panel.send({ type: 'copy' });
    assert.equal(h.clipboard.length, 1);
    assert.match(h.clipboard[0], /MOAG bug report/);
    assert.match(h.clipboard[0], /copy me/);
  });

  it('feedback ignores the workspace origin remote and files to MOAG', async () => {
    const moagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-reporting-'));
    try {
      const report = {
        runId: 'r1', date: new Date().toISOString(), moagVersion: '0.0.0', engine: 'claude', projectType: 'ts',
        summary: { total: 1, passed: 0, failed: 1, escalated: 0, durationMs: 0, estimatedCostUsd: 0 },
        friction: [], errorCategories: {},
      };
      fs.writeFileSync(path.join(moagDir, 'feedback.jsonl'), JSON.stringify(report) + '\n');
      h = load({ ghSignedIn: true, moagDir });
      await h.mod.cmdShareRunFeedback();
      const panel = h.panels[0];
      await panel.send({ type: 'submitReport', description: '' });
      await panel.send({ type: 'confirmPost' });

      assert.ok(!h.execCalls.some((c) => c.startsWith('git remote')), 'the origin remote was read');
      const args = h.ghCalls[0];
      assert.equal(args[args.indexOf('--repo') + 1], 'sujan-poudel-03/moag');
    } finally {
      fs.rmSync(moagDir, { recursive: true, force: true });
    }
  });
});

describe('buildNewIssueUrl', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  let build: Harness['mod']['buildNewIssueUrl'];
  before(() => {
    const originalLoad = Module._load;
    Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') { return vscodeMock; }
      return originalLoad.call(Module, request, parent, isMain);
    };
    try {
      build = proxyquire('../../../ui/self-reporting', { vscode: vscodeMock }).buildNewIssueUrl;
    } finally {
      Module._load = originalLoad;
    }
  });

  for (const [platform, cap] of [['win32', 2000], ['linux', 8000]] as const) {
    it(`${platform}: a URL at exactly ${cap} characters is not cut, one over is`, () => {
      const base = `${MOAG_ISSUES_NEW}?title=t&body=`;
      const fits = 'a'.repeat(cap - base.length);
      const exact = build('t', fits, platform);
      assert.equal(exact.url.length, cap);
      assert.equal(exact.truncated, false);

      const over = build('t', fits + 'a', platform);
      assert.equal(over.truncated, true);
      assert.ok(over.url.length <= cap, `${over.url.length} > ${cap}`);
      assert.ok(decodeURIComponent(over.url).includes('Truncated: the full report is on your clipboard'));
    });
  }

  it('measures after encoding, and never splits a surrogate pair', () => {
    const r = build('t', '😀'.repeat(3000), 'win32');
    assert.equal(r.truncated, true);
    assert.ok(r.url.length <= 2000);
    assert.doesNotThrow(() => decodeURIComponent(r.url));
  });

  it('cuts an over-long title too', () => {
    const r = build('T'.repeat(5000), 'body', 'win32');
    assert.ok(r.url.length <= 2000);
    assert.equal(r.truncated, true);
  });
});
