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
}) as
  typeof import('../../../ui/setup-guide');

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CapturedPanel {
  webview: { html: string };
  dispose: sinon.SinonSpy;
}

/** Open the guide with `detected` engines and return the panel it created plus its message handler. */
function openGuide(detected: string[]): { panel: CapturedPanel; send: (msg: { type: string }) => unknown } {
  let handler: ((msg: { type: string }) => unknown) | undefined;
  const panel = {
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (h: (msg: { type: string }) => unknown) => { handler = h; return { dispose: () => {} }; },
    },
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: sinon.spy(),
  };
  const created = sinon.stub(vscodeMock.window, 'createWebviewPanel').returns(panel);
  try {
    const ctx = { globalState: { get: () => detected } };
    cmdShowSetupGuide(ctx as unknown as Parameters<typeof cmdShowSetupGuide>[0]);
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
    it(`shows the section with ${detected.length} engines detected`, () => {
      const { panel } = openGuide(detected);
      const html = panel.webview.html;
      assert.ok(html.includes('Connect to ONOSOO Builds'), 'section title present');
      // Same mechanism as the engine Docs link: a plain anchor the webview host opens externally.
      assert.ok(
        html.includes(`<a class="engine-link" href="${ONOSOO_GUIDE_URL}" target="_blank">`),
        'guide link uses the engine-link anchor pattern',
      );
    });
  }

  it('keeps the nonce-gated CSP and adds no inline script', () => {
    const { panel } = openGuide([]);
    const html = panel.webview.html;
    assert.match(html, /Content-Security-Policy/);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    assert.equal(scripts.length, 1, 'only the compiled setup-guide script');
    assert.match(scripts[0] ?? '', /nonce="[A-Za-z0-9]{32}"/);
  });

  it('ignores an unknown message instead of closing the panel', async () => {
    const { panel, send } = openGuide([]);
    await send({ type: 'openExternal' });
    assert.equal(panel.dispose.callCount, 0);
    await send({ type: 'done' });
    assert.equal(panel.dispose.callCount, 1);
  });
});
