// ─── Setup guide ─────────────────────────────────────────────────────────────
//
// A one-screen walkthrough for a new workspace. It sat inside the "Plan from
// PRD" section of extension.ts purely by accident of ordering; it is its own
// concern and touches no extension state.
//
// Every engine MOAG can run is listed: the four CLIs, GitHub Copilot (through
// the Copilot Chat extension) and the Anthropic API (a key, no CLI). Colours
// come from the design-system tokens, so the guide follows the VS Code theme.

import * as vscode from 'vscode';
import { EngineId } from '../models/types';
import { designSystemCssTokens } from './design-system';
import { webviewCsp, webviewNonce, webviewScriptUri } from './webview-assets';

/** The end-to-end ONOSOO Builds guide. docs/ is not packaged, so it links to GitHub. */
export const ONOSOO_GUIDE_URL = 'https://github.com/sujan-poudel-03/moag/blob/master/docs/onosoo-builds.md';

/** SecretStorage key of the Anthropic API key (see ui/anthropic-key.ts). */
const ANTHROPIC_SECRET = 'agentTaskPlayer.anthropicApiKey';

/** The slice of ExtensionContext the guide reads. */
type GuideContext = Pick<vscode.ExtensionContext, 'globalState'> & { secrets?: Pick<vscode.SecretStorage, 'get'> };

interface EngineRow {
  id: string;
  name: string;
  tag: string;
  /** Shown while the engine is missing; null for engines with nothing to install. */
  install: string | null;
  auth: string;
  url: string;
  /** Ready to run. */
  ready: boolean;
  /** The pill shown when ready. */
  readyLabel: string;
  /** A button that posts a message instead of an install line. */
  action?: { id: string; label: string };
}

/** Escape text for HTML. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Open the Setup Guide webview: every engine with install hints, the Anthropic key, and optional ONOSOO Builds onboarding. */
export async function cmdShowSetupGuide(ctx: GuideContext): Promise<void> {
  const detected = ctx.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []);
  const has = (id: string) => detected.includes(id as EngineId);

  const panel = vscode.window.createWebviewPanel(
    'moagSetupGuide', 'MOAG — Setup Guide', vscode.ViewColumn.One,
    { enableScripts: true },
  );
  let disposed = false;
  panel.onDidDispose(() => { disposed = true; });

  panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
    if (msg?.type === 'recheck') {
      panel.dispose();
      await vscode.commands.executeCommand('agentTaskPlayer.detectEngines');
      await cmdShowSetupGuide(ctx);
    } else if (msg?.type === 'done') {
      panel.dispose();
    } else if (msg?.type === 'setAnthropicKey') {
      await vscode.commands.executeCommand('agentTaskPlayer.setAnthropicApiKey');
      // The panel may have been closed while the input box was open.
      if (!disposed) { panel.webview.html = await render(); }
    } else if (msg?.type === 'connectOnosoo') {
      await vscode.commands.executeCommand('agentTaskPlayer.connectOnosoo');
    }
  });

  const render = async (): Promise<string> => {
    let anthropicKey = false;
    try { anthropicKey = !!(await ctx.secrets?.get(ANTHROPIC_SECRET)); } catch { /* no store */ }
    anthropicKey = anthropicKey || !!process.env.ANTHROPIC_API_KEY;

    const engineRows: EngineRow[] = [
      {
        id: 'claude', name: 'Claude Code', tag: 'Recommended',
        install: 'npm install -g @anthropic-ai/claude-code',
        auth: 'Requires Anthropic account — run <code>claude</code> to sign in',
        url: 'https://docs.anthropic.com/claude-code', ready: has('claude'), readyLabel: 'Found',
      },
      {
        id: 'codex', name: 'Codex CLI', tag: 'OpenAI',
        install: 'npm install -g @openai/codex',
        auth: 'Set <code>OPENAI_API_KEY</code> environment variable',
        url: 'https://github.com/openai/codex', ready: has('codex'), readyLabel: 'Found',
      },
      {
        id: 'gemini', name: 'Gemini CLI', tag: 'Google',
        install: 'npm install -g @google/gemini-cli',
        auth: 'Requires Google account — run <code>gemini</code> to sign in',
        url: 'https://github.com/google-gemini/gemini-cli', ready: has('gemini'), readyLabel: 'Found',
      },
      {
        id: 'ollama', name: 'Ollama', tag: 'Local · No API key',
        install: 'Download from ollama.com, then: ollama pull codellama',
        auth: 'Runs fully local — no API key required',
        url: 'https://ollama.com', ready: has('ollama'), readyLabel: 'Found',
      },
      {
        id: 'copilot', name: 'GitHub Copilot', tag: 'VS Code extension',
        install: null,
        auth: 'Uses the GitHub Copilot Chat extension; install it and sign in',
        url: 'https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat', ready: has('copilot'), readyLabel: 'Found',
      },
      {
        id: 'anthropic', name: 'Anthropic API', tag: 'API key · No CLI',
        install: null,
        auth: 'Calls the Anthropic API directly. The key is kept in VS Code\'s secret storage, not in settings.',
        url: 'https://console.anthropic.com', ready: anthropicKey, readyLabel: 'Configured',
        action: { id: 'setAnthropicKeyBtn', label: anthropicKey ? 'Change API Key' : 'Set API Key' },
      },
    ];

    const rowsHtml = engineRows.map((e) => `
    <div class="engine-row ${e.ready ? 'ok' : 'missing'}" data-engine="${esc(e.id)}">
      <div class="engine-status">${e.ready ? '&#10003;' : '&#10007;'}</div>
      <div class="engine-info">
        <div class="engine-name">${esc(e.name)} <span class="engine-tag">${esc(e.tag)}</span>${e.ready ? ` <span class="engine-found">${esc(e.readyLabel)}</span>` : ''}</div>
        ${!e.ready && e.install ? `<div class="engine-install"><code>${esc(e.install)}</code></div>` : ''}
        <div class="engine-auth">${e.auth}</div>
      </div>
      ${e.action ? `<button class="btn-secondary" id="${e.action.id}">${esc(e.action.label)}</button>` : ''}
      ${!e.ready && !e.action ? `<a class="engine-link" href="${esc(e.url)}" target="_blank">Docs &#8599;</a>` : ''}
    </div>`).join('');

    const readyCount = detected.length + (anthropicKey && !has('anthropic') ? 1 : 0);
    const allGood = readyCount > 0;

    // The script is a compiled file; the CSP admits only the nonce it carries.
    const scriptUri = webviewScriptUri(panel.webview, 'setup-guide');
    const nonce = webviewNonce();
    const csp = webviewCsp(panel.webview, nonce);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
  ${csp}
<title>MOAG Setup Guide</title>
<style>
${designSystemCssTokens()}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--ds-font-family); font-size: var(--ds-font-size); background: var(--ds-bg); color: var(--ds-fg); min-height: 100vh; display: flex; flex-direction: column; }
.hero { padding: 32px 40px 20px; border-bottom: 1px solid var(--ds-border); }
.hero h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
.hero p { color: var(--ds-muted); line-height: 1.5; max-width: 560px; }
.status-banner { margin: 20px 40px 0; padding: 10px 16px; border-radius: var(--ds-radius-md); font-size: 12px; font-weight: 600; border: 1px solid var(--ds-border); background: var(--ds-surface); }
.status-banner.good { color: var(--ds-success); border-color: var(--ds-success); }
.status-banner.warn { color: var(--ds-warning); border-color: var(--ds-warning); }
.section { padding: 24px 40px; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--ds-muted); margin-bottom: 14px; }
.engine-row { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 1px solid var(--ds-border); border-radius: var(--ds-radius-md); margin-bottom: 10px; background: var(--ds-surface); }
.engine-row.ok { border-color: var(--ds-success); }
.engine-status { font-size: 18px; line-height: 1; margin-top: 2px; flex-shrink: 0; }
.engine-row.ok .engine-status { color: var(--ds-success); }
.engine-row.missing .engine-status { color: var(--ds-muted); }
.engine-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.engine-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.engine-tag { font-size: 10px; font-weight: 500; color: var(--ds-muted); border: 1px solid var(--ds-border); padding: 1px 6px; border-radius: var(--ds-radius-pill); }
.engine-found { font-size: 10px; font-weight: 700; color: var(--ds-success); border: 1px solid var(--ds-success); padding: 1px 7px; border-radius: var(--ds-radius-pill); }
.engine-install { font-size: 11px; background: var(--ds-input-bg); color: var(--ds-input-fg); border: 1px solid var(--ds-input-border); border-radius: var(--ds-radius-sm); padding: 5px 10px; margin-top: 4px; }
.engine-install code { font-family: var(--ds-editor-font); }
.engine-auth { font-size: 11px; color: var(--ds-muted); line-height: 1.4; }
.engine-auth code { color: var(--ds-info); font-family: var(--ds-editor-font); }
.engine-link { font-size: 11px; color: var(--ds-info); text-decoration: none; white-space: nowrap; margin-top: 2px; flex-shrink: 0; }
.engine-link:hover { text-decoration: underline; }
.tip-box { background: var(--ds-surface); border-left: 3px solid var(--ds-info); border-radius: 0 var(--ds-radius-sm) var(--ds-radius-sm) 0; padding: 10px 14px; font-size: 12px; color: var(--ds-muted); line-height: 1.5; margin-bottom: 12px; }
.tip-box code { color: var(--ds-info); font-family: var(--ds-editor-font); }
.footer { padding: 20px 40px 32px; display: flex; gap: 12px; align-items: center; }
.btn-primary { padding: 9px 22px; background: var(--ds-btn-bg); color: var(--ds-btn-fg); border: none; border-radius: var(--ds-radius-sm); font-size: 13px; font-weight: 600; cursor: pointer; }
.btn-primary:hover { background: var(--ds-btn-hover); }
.btn-secondary { padding: 6px 14px; background: var(--ds-btn-secondary-bg); color: var(--ds-btn-secondary-fg); border: 1px solid var(--ds-border); border-radius: var(--ds-radius-sm); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.btn-secondary:hover { background: var(--ds-hover); }
button:focus-visible, a:focus-visible { outline: 1px solid var(--ds-focus); outline-offset: 2px; }
</style></head>
<body>
<div class="hero">
  <h1>&#128640; MOAG Setup Guide</h1>
  <p>MOAG needs at least one AI engine to run tasks, draft PRDs, and verify results: a coding CLI on this machine, GitHub Copilot, or an Anthropic API key.</p>
</div>
${allGood
    ? `<div class="status-banner good">&#10003;&nbsp; ${readyCount} engine${readyCount > 1 ? 's' : ''} ready — you're ready to go!</div>`
    : `<div class="status-banner warn">&#9888;&nbsp; No AI engine found. Install one from the list below, or set an Anthropic API key.</div>`}
<div class="section">
  <div class="section-title">AI Engines</div>
  ${rowsHtml}
</div>
<div class="section" style="padding-top:0">
  <div class="section-title">After installing</div>
  <div class="tip-box">Open a terminal and run <code>claude</code> (or the relevant CLI) once to complete authentication, then click <strong>Re-check engines</strong> below.</div>
  <div class="tip-box">MOAG uses the CLI that matches your <strong>agentTaskPlayer.defaultEngine</strong> setting. You can change it in VS Code Settings.</div>
</div>
<div class="section" style="padding-top:0">
  <div class="section-title">Connect to ONOSOO Builds (optional)</div>
  <div class="tip-box">Watch runs live in ONOSOO Builds, from this panel or <code>moag run</code>, and on Linux or WSL control them and open live previews. <a class="engine-link" href="${ONOSOO_GUIDE_URL}" target="_blank">Setup guide &#8599;</a></div>
  <button class="btn-secondary" id="connectOnosooBtn">Connect</button>
</div>
<div class="footer">
  <button class="btn-primary" id="recheckBtn">Re-check engines</button>
  <button class="btn-secondary" id="doneBtn">Start using MOAG</button>
</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  };

  const html = await render();
  if (!disposed) { panel.webview.html = html; }
}
