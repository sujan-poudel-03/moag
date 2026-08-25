// ─── Setup guide ─────────────────────────────────────────────────────────────
//
// A one-screen walkthrough for a new workspace. It sat inside the "Plan from
// PRD" section of extension.ts purely by accident of ordering; it is its own
// concern and touches no extension state.

import * as vscode from 'vscode';
import { EngineId } from '../models/types';
import { webviewCsp, webviewNonce, webviewScriptUri } from './webview-assets';

export function cmdShowSetupGuide(ctx: vscode.ExtensionContext): void {
  const detected = ctx.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []);
  const has = (id: string) => detected.includes(id as EngineId);

  const engineRows = [
    {
      id: 'claude',
      name: 'Claude Code',
      tag: 'Recommended',
      install: 'npm install -g @anthropic-ai/claude-code',
      auth: 'Requires Anthropic account — run <code>claude</code> to sign in',
      url: 'https://docs.anthropic.com/claude-code',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      tag: 'OpenAI',
      install: 'npm install -g @openai/codex',
      auth: 'Set <code>OPENAI_API_KEY</code> environment variable',
      url: 'https://github.com/openai/codex',
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      tag: 'Google',
      install: 'npm install -g @google/gemini-cli',
      auth: 'Requires Google account — run <code>gemini</code> to sign in',
      url: 'https://github.com/google-gemini/gemini-cli',
    },
    {
      id: 'ollama',
      name: 'Ollama',
      tag: 'Local · No API key',
      install: 'Download from ollama.com, then: ollama pull llama3',
      auth: 'Runs fully local — no API key required',
      url: 'https://ollama.com',
    },
  ];

  const rowsHtml = engineRows.map(e => `
    <div class="engine-row ${has(e.id) ? 'ok' : 'missing'}">
      <div class="engine-status">${has(e.id) ? '&#10003;' : '&#10007;'}</div>
      <div class="engine-info">
        <div class="engine-name">${e.name} <span class="engine-tag">${e.tag}</span>${has(e.id) ? ' <span class="engine-found">Found</span>' : ''}</div>
        ${!has(e.id) ? `<div class="engine-install"><code>${e.install}</code></div>` : ''}
        <div class="engine-auth">${e.auth}</div>
      </div>
      ${!has(e.id) ? `<a class="engine-link" href="${e.url}" target="_blank">Docs &#8599;</a>` : ''}
    </div>`).join('');

  const allGood = detected.length > 0;
  const panel = vscode.window.createWebviewPanel(
    'moagSetupGuide', 'MOAG — Setup Guide', vscode.ViewColumn.One,
    { enableScripts: true },
  );

  // The script is a compiled file; the CSP admits only the nonce it carries.
  const scriptUri = webviewScriptUri(panel.webview, 'setup-guide');
  const nonce = webviewNonce();
  const csp = webviewCsp(panel.webview, nonce);
  panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
  ${csp}
<title>MOAG Setup Guide</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; background: #1e1e1e; color: #cccccc; min-height: 100vh; display: flex; flex-direction: column; }
.hero { padding: 32px 40px 20px; border-bottom: 1px solid #333; }
.hero h1 { font-size: 22px; font-weight: 700; color: #e8e8e8; margin-bottom: 6px; }
.hero p { color: #888; line-height: 1.5; max-width: 560px; }
.status-banner { margin: 0 40px; margin-top: 20px; padding: 10px 16px; border-radius: 6px; font-size: 12px; font-weight: 600; }
.status-banner.good { background: rgba(78,201,176,0.12); border: 1px solid rgba(78,201,176,0.3); color: #4ec9b0; }
.status-banner.warn { background: rgba(255,180,0,0.1); border: 1px solid rgba(255,180,0,0.25); color: #ffb400; }
.section { padding: 24px 40px; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #666; margin-bottom: 14px; }
.engine-row { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 1px solid #2d2d2d; border-radius: 8px; margin-bottom: 10px; background: #252525; }
.engine-row.ok { border-color: rgba(78,201,176,0.25); background: rgba(78,201,176,0.04); }
.engine-row.missing { border-color: #333; }
.engine-status { font-size: 18px; line-height: 1; margin-top: 2px; flex-shrink: 0; }
.engine-row.ok .engine-status { color: #4ec9b0; }
.engine-row.missing .engine-status { color: #555; }
.engine-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.engine-name { font-size: 13px; font-weight: 600; color: #e0e0e0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.engine-tag { font-size: 10px; font-weight: 500; color: #888; background: #333; padding: 1px 6px; border-radius: 10px; }
.engine-found { font-size: 10px; font-weight: 700; color: #4ec9b0; background: rgba(78,201,176,0.12); padding: 1px 7px; border-radius: 10px; }
.engine-install { font-size: 11px; background: #1a1a1a; border: 1px solid #3a3a3a; border-radius: 4px; padding: 5px 10px; margin-top: 4px; color: #ce9178; }
.engine-install code { font-family: 'Cascadia Code', 'Consolas', monospace; }
.engine-auth { font-size: 11px; color: #777; line-height: 1.4; }
.engine-auth code { color: #9cdcfe; font-family: monospace; }
.engine-link { font-size: 11px; color: #4fc3f7; text-decoration: none; white-space: nowrap; margin-top: 2px; flex-shrink: 0; }
.engine-link:hover { text-decoration: underline; }
.tip-box { background: #252525; border-left: 3px solid #0078d4; border-radius: 0 6px 6px 0; padding: 10px 14px; font-size: 12px; color: #999; line-height: 1.5; margin-bottom: 12px; }
.tip-box code { color: #9cdcfe; font-family: monospace; }
.footer { padding: 20px 40px 32px; display: flex; gap: 12px; align-items: center; }
.btn-primary { padding: 9px 22px; background: #0078d4; color: #fff; border: none; border-radius: 5px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn-primary:hover { background: #026ec1; }
.btn-secondary { padding: 9px 18px; background: transparent; color: #aaa; border: 1px solid #444; border-radius: 5px; font-size: 12px; cursor: pointer; }
.btn-secondary:hover { border-color: #666; color: #ccc; }
</style></head>
<body>
<div class="hero">
  <h1>&#128640; MOAG Setup Guide</h1>
  <p>MOAG needs at least one AI coding CLI installed on your machine to run tasks, draft PRDs, and verify results.</p>
</div>
${allGood
    ? `<div class="status-banner good">&#10003;&nbsp; ${detected.length} engine${detected.length > 1 ? 's' : ''} detected — you're ready to go!</div>`
    : `<div class="status-banner warn">&#9888;&nbsp; No AI engine found. Install at least one from the list below.</div>`}
<div class="section">
  <div class="section-title">AI Engines</div>
  ${rowsHtml}
</div>
<div class="section" style="padding-top:0">
  <div class="section-title">After installing</div>
  <div class="tip-box">Open a terminal and run <code>claude</code> (or the relevant CLI) once to complete authentication, then click <strong>Re-check engines</strong> below.</div>
  <div class="tip-box">MOAG uses the CLI that matches your <strong>agentTaskPlayer.defaultEngine</strong> setting. You can change it in VS Code Settings.</div>
</div>
<div class="footer">
  <button class="btn-primary" id="recheckBtn">Re-check engines</button>
  <button class="btn-secondary" id="doneBtn">Start using MOAG</button>
</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'recheck') {
      panel.dispose();
      await vscode.commands.executeCommand('agentTaskPlayer.detectEngines');
      cmdShowSetupGuide(ctx);
    } else if (msg.type === 'done') {
      panel.dispose();
    }
  });
}
