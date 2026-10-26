import * as assert from 'assert';
import * as sinon from 'sinon';
// setup-guide imports vscode, so load it through the shared mock.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');
// webview-assets imports vscode too; load the real module against the mock so the CSP and nonce are genuine.
const webviewAssets = proxyquire('../../../ui/webview-assets', { vscode: vscodeMock });
const { cmdShowSetupGuide, ONOSOO_GUIDE_URL } = proxyquire('../../../ui/setup-guide', {
  vscode: vscodeMock,
  './webview-assets': webviewAssets,
  '../utils/user-messages': proxyquire('../../../utils/user-messages', { vscode: vscodeMock }),
}) as
  typeof import('../../../ui/setup-guide');

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CapturedPanel {
  webview: { html: string };
  dispose: sinon.SinonSpy;
}

/** Open the guide with `detected` engines (and optionally a stored Anthropic key); return the panel and its message handler. */
async function openGuide(detected: string[], opts: { anthropicKey?: string } = {}): Promise<{ panel: CapturedPanel; send: (msg: { type: string }) => unknown }> {
  let handler: ((msg: { type: string }) => unknown) | undefined;
  let onDispose: () => void = () => undefined;
  const panel = {
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (h: (msg: { type: string }) => unknown) => { handler = h; return { dispose: () => {} }; },
    },
    onDidDispose: (cb: () => void) => { onDispose = cb; return { dispose: () => {} }; },
    dispose: sinon.spy(() => onDispose()),
  };
  const created = sinon.stub(vscodeMock.window, 'createWebviewPanel').returns(panel);
  try {
    const ctx = {
      globalState: { get: () => detected },
      secrets: { get: async () => opts.anthropicKey },
    };
    await cmdShowSetupGuide(ctx as unknown as Parameters<typeof cmdShowSetupGuide>[0]);
  } finally {
    created.restore();
  }
  assert.ok(handler, 'the guide registers a message handler');
  return { panel, send: (msg) => handler!(msg) };
}

// ─── ONOSOO Builds section ───────────────────────────────────────────────────

describe('setup-guide — ONOSOO Builds onboarding', () => {
  afterEach(() => sinon.restore());

  it('links to the GitHub guide, since docs/ is not packaged', () => {
    assert.equal(ONOSOO_GUIDE_URL, 'https://github.com/sujan-poudel-03/moag/blob/master/docs/onosoo-builds.md');
  });

  for (const detected of [[], ['claude', 'codex', 'gemini', 'ollama']]) {
    it(`shows the section with ${detected.length} engines detected`, async () => {
      const { panel } = await openGuide(detected);
      const html = panel.webview.html;
      assert.ok(html.includes('Connect to ONOSOO Builds'), 'section title present');
      // Same mechanism as the engine Docs link: a plain anchor the webview host opens externally.
      assert.ok(
        html.includes(`<a class="engine-link" href="${ONOSOO_GUIDE_URL}" target="_blank">`),
        'guide link uses the engine-link anchor pattern',
      );
    });
  }

  it('keeps the nonce-gated CSP and adds no inline script', async () => {
    const { panel } = await openGuide([]);
    const html = panel.webview.html;
    assert.match(html, /Content-Security-Policy/);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    assert.equal(scripts.length, 1, 'only the compiled setup-guide script');
    assert.match(scripts[0] ?? '', /nonce="[A-Za-z0-9]{32}"/);
  });

  it('ignores an unknown message instead of closing the panel', async () => {
    const { panel, send } = await openGuide([]);
    await send({ type: 'openExternal' });
    assert.equal(panel.dispose.callCount, 0);
    await send({ type: 'done' });
    assert.equal(panel.dispose.callCount, 1);
  });

  it('the Connect button runs MOAG: Connect to ONOSOO Builds', async () => {
    const exec = sinon.stub(vscodeMock.commands, 'executeCommand').resolves(undefined);
    const { panel, send } = await openGuide([]);
    assert.match(panel.webview.html, /id="connectOnosooBtn"/);
    await send({ type: 'connectOnosoo' });
    assert.ok(exec.calledWith('agentTaskPlayer.connectOnosoo'));
  });
});

// ─── Engines, theme, the Anthropic key ───────────────────────────────────────

describe('setup-guide — every engine, theme colours, the Anthropic key', () => {
  afterEach(() => sinon.restore());

  it('uses theme tokens: none of the old hard-coded dark colours', async () => {
    const { panel } = await openGuide([]);
    const html = panel.webview.html.toLowerCase();
    for (const hex of ['#1e1e1e', '#252525', '#cccccc']) {
      assert.ok(!html.includes(hex), `${hex} is hard-coded`);
    }
    assert.match(html, /--ds-bg/);
  });

  it('lists six engines, including GitHub Copilot and the Anthropic API', async () => {
    const { panel } = await openGuide([]);
    const rows = panel.webview.html.match(/data-engine="([a-z]+)"/g) ?? [];
    assert.deepEqual(rows.map((r) => r.replace(/data-engine="|"/g, '')), ['claude', 'codex', 'gemini', 'ollama', 'copilot', 'anthropic']);
    assert.match(panel.webview.html, /Uses the GitHub Copilot Chat extension; install it and sign in/);
  });

  it('the Ollama hint pulls codellama (the default model)', async () => {
    const { panel } = await openGuide([]);
    assert.match(panel.webview.html, /ollama pull codellama/);
  });

  it('a stored Anthropic key shows the row as Configured', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const without = await openGuide([]);
      assert.doesNotMatch(without.panel.webview.html, /data-engine="anthropic"[^]*?Configured/);
      const withKey = await openGuide([], { anthropicKey: 'sk-ant-stored' });
      assert.match(withKey.panel.webview.html, /data-engine="anthropic"[^]*?<span class="engine-found">Configured<\/span>/);
      assert.ok(!withKey.panel.webview.html.includes('sk-ant-stored'), 'the key is never rendered');
    } finally {
      if (saved !== undefined) { process.env.ANTHROPIC_API_KEY = saved; }
    }
  });

  it('the Set API Key button runs MOAG: Set Anthropic API Key', async () => {
    const exec = sinon.stub(vscodeMock.commands, 'executeCommand').resolves(undefined);
    const { panel, send } = await openGuide([]);
    assert.match(panel.webview.html, /id="setAnthropicKeyBtn"/);
    await send({ type: 'setAnthropicKey' });
    assert.ok(exec.calledWith('agentTaskPlayer.setAnthropicApiKey'));
  });

  it('a command that rejects behind a button shows an error instead of an unhandled rejection', async () => {
    sinon.stub(vscodeMock.commands, 'executeCommand').rejects(new Error('command not found'));
    const err = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
    const { send } = await openGuide([]);
    await send({ type: 'connectOnosoo' }); // resolves: the handler caught it
    assert.equal(err.callCount, 1);
    assert.match(String(err.firstCall.args[0]), /MOAG could not finish that from the Setup Guide: command not found/);
  });

  it('a panel closed while the key prompt was open is not written to', async () => {
    const { panel, send } = await openGuide([]);
    const exec = sinon.stub(vscodeMock.commands, 'executeCommand').callsFake(async () => { panel.dispose(); });
    const before = panel.webview.html;
    await send({ type: 'setAnthropicKey' });
    assert.ok(exec.called);
    assert.equal(panel.webview.html, before);
  });
});
