// ─── PRD authoring — writing the brief, before any task exists ──────────────
//
// The PRD panel, its guided chat, AI improvement, browser preview and version
// history, plus turning a finished PRD into a plan. One domain: everything that
// happens to a PRD before the runner ever sees it.
//
// Extracted from extension.ts. Everything it needs from the extension is
// injected, and all of it is read-only — this module never writes extension
// state, which is why plain getters are enough.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EngineId, Plan } from '../models/types';
import { appendPrdVersion, dehydratePlan, hydratePlan, savePlan } from '../models/plan';
import { isRoleId } from '../models/roles';
import { getEngine } from '../adapters/index';
import { analyzeProject, formatAnalysis } from '../context/project-analyzer';
import { ghSync } from '../utils/gh';
import * as UserMsg from '../utils/user-messages';
import { MAX_PRD_VERSIONS } from '../models/plan';
import { PromptInputViewProvider } from './prompt-input-view';
import { ensureMoagDir } from '../workspace/moag-paths';
import { webviewCsp, webviewNonce, webviewScriptUri } from './webview-assets';

/** Everything this module needs from extension.ts, passed in explicitly. */
export interface PrdAuthoringDeps {
  readonly currentPlan: Plan | null;
  readonly currentPlanPath: string | null;
  readonly extensionContext: vscode.ExtensionContext | null;
  readonly promptViewProvider: PromptInputViewProvider | null;
  readonly runner: unknown;
  detectPrdFileInWorkspace(): string | null;
  getActivePlan(): Plan | null;
  injectTestTaskIfMissing(plan: Plan, cwd: string): void;
  saveAndRefresh(): void;
  syncPromptProviderSidebar(provider: PromptInputViewProvider): void;
}

let deps: PrdAuthoringDeps;

/** Call once during activate(), before any PRD command can run. */
export function initPrdAuthoring(d: PrdAuthoringDeps): void { deps = d; }
export async function handlePrdChatAnswer(payload: { answer: string; step: number; answers: string[] }): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { return; }
  const cwd = workspaceFolder.uri.fsPath;
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  const defaultEngine = cfg.get<EngineId>('defaultEngine', 'claude' as EngineId);

  // Guard: check if any engine is available before attempting AI call
  const detectedEngines = deps.extensionContext?.globalState.get<EngineId[]>('agentTaskPlayer.detectedEngines', []) ?? [];
  if (detectedEngines.length === 0) {
    deps.promptViewProvider?.postMessage({
      type: 'prdError',
      error: 'No AI engine is set up yet. Open the MOAG Setup Guide to install one (Claude Code, Codex, Gemini, or Ollama).',
      action: { label: 'Open Setup Guide', command: 'agentTaskPlayer.setupGuide' },
    });
    return;
  }

  const engine = getEngine(defaultEngine);

  const analysis = analyzeProject(cwd);
  const stackContext = formatAnalysis(analysis);

  const postToSidebar = (msg: Record<string, unknown>) => deps.promptViewProvider?.postMessage(msg);

  if (payload.step === 1) {
    // Step 1: user described the feature — ask one follow-up question
    const prompt = `A developer wants to build a new feature. They described it as:
"${payload.answer}"

The codebase uses: ${stackContext}

Ask ONE focused follow-up question (under 30 words) to get the most important missing info needed to write acceptance criteria. Focus on: UI presence, key user actions, edge cases, or integrations. Do NOT number the question or add preamble — just the question itself.`;

    try {
      // The await stays INSIDE this try: handlePrdChatAnswer is invoked as a
      // floating `void handlePrdChatAnswer(...)`, so an abort rejection escaping
      // here would become an unhandled rejection and kill the extension host.
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'MOAG is drafting a follow-up question…',
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          const sub = token.onCancellationRequested(() => abort.abort());
          try {
            return await engine.runTask({ prompt, cwd, signal: abort.signal, costLabel: 'prd-chat' });
          } finally {
            sub.dispose();
          }
        },
      );
      const question = (result.stdout || '').trim() || 'Any specific acceptance criteria or edge cases to include?';
      postToSidebar({ type: 'prdMoagQuestion', question });
    } catch {
      postToSidebar({ type: 'prdError', error: 'Could not reach AI engine' });
    }

  } else {
    // Step 2: enough context — generate full PRD then open panel
    const [desc, followUp] = payload.answers;
    const prompt = `You are a senior product manager. Generate a structured PRD in Markdown based on this conversation:

Feature description: "${desc}"
Follow-up answer: "${followUp || 'N/A'}"
Codebase: ${stackContext}

Write the PRD with these sections:
## Feature: <name>
## Overview
<1-2 sentences>
## Goals
- bullet points
## Acceptance Criteria
AC1: ...
AC2: ...
AC3: ...
## Technical Notes
<relevant notes based on the codebase context>

Return ONLY the PRD markdown. No preamble, no explanation.`;

    try {
      // As above: the await must not escape this try/catch.
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'MOAG is writing your PRD…',
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          const sub = token.onCancellationRequested(() => abort.abort());
          try {
            return await engine.runTask({ prompt, cwd, signal: abort.signal, costLabel: 'prd-chat' });
          } finally {
            sub.dispose();
          }
        },
      );
      const prdText = (result.stdout || '').trim();
      if (!prdText) {
        postToSidebar({ type: 'prdError', error: 'AI returned empty PRD' });
        return;
      }
      // Tell the sidebar the chat phase is done
      postToSidebar({ type: 'prdConvertReady' });
      // Open the PRD panel pre-filled with the generated PRD
      await openPrdPanel(prdText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      postToSidebar({ type: 'prdError', error: msg.substring(0, 120) });
    }
  }
}

export async function cmdSavePrdToPlan(prdText: string): Promise<void> {
  const plan = deps.getActivePlan();
  if (!plan) {
    vscode.window.showWarningMessage('No active plan — open or create a plan first.');
    return;
  }
  plan.prdSource = prdText;
  if (deps.currentPlanPath) { savePlan(plan, deps.currentPlanPath); }
  if (deps.promptViewProvider) { deps.syncPromptProviderSidebar(deps.promptViewProvider); }
  vscode.window.showInformationMessage('PRD saved to plan — use "Verify Against PRD" after your test playlist runs.');
}

export async function cmdOpenPrdFromPlan(args?: { prdOverride?: string }): Promise<void> {
  if (args?.prdOverride) {
    await openPrdPanel(args.prdOverride);
    return;
  }
  const plan = deps.getActivePlan();
  if (plan?.prdSource) {
    await openPrdPanel(plan.prdSource);
    return;
  }
  const detectedRel = deps.detectPrdFileInWorkspace();
  if (detectedRel) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const fsLib = require('fs') as typeof import('fs');
    const pathLib = require('path') as typeof import('path');
    const text = fsLib.readFileSync(pathLib.join(cwd, detectedRel), 'utf-8');
    await openPrdPanel(text);
    return;
  }
  // Nothing found — fall through to the file picker
  await cmdPlanFromPRD();
}

export async function openPrdPanel(prefill = '', versions?: { version: string; text: string; createdAt: string }[]): Promise<void> {
  const plan = deps.getActivePlan();
  const resolvedVersions = versions ?? plan?.prdVersions ?? [];
  const panel = vscode.window.createWebviewPanel(
    'moagPrdInput',
    'MOAG — Generate Plan from PRD',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  panel.webview.html = buildPrdPanelHtml(panel.webview, prefill, resolvedVersions);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === 'openPrdFile') {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false, filters: { 'PRD files': ['md', 'txt'] }, title: 'Open PRD file',
      });
      if (uris?.[0]) {
        const fsLib = require('fs') as typeof import('fs');
        panel.webview.postMessage({ type: 'prdFileContent', text: fsLib.readFileSync(uris[0].fsPath, 'utf-8') });
      }
    } else if (message.type === 'savePrdFile') {
      const saveUri = await vscode.window.showSaveDialog({
        filters: { 'Markdown': ['md'], 'Text': ['txt'] },
        defaultUri: vscode.Uri.file(
          (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') + '/prd.md',
        ),
        title: 'Save PRD as file',
      });
      if (saveUri) {
        const fsLib = require('fs') as typeof import('fs');
        fsLib.writeFileSync(saveUri.fsPath, message.text as string, 'utf-8');
        vscode.window.showInformationMessage(`PRD saved: ${saveUri.fsPath}`);
      }
    } else if (message.type === 'loadFromGitHubIssue') {
      const input = await vscode.window.showInputBox({
        prompt: 'GitHub issue URL or #number',
        placeHolder: 'https://github.com/owner/repo/issues/123  or  #123',
      });
      if (!input) { return; }
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      let owner = '', issueRepo = '', issueNumber = '';
      const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
      if (urlMatch) { [, owner, issueRepo, issueNumber] = urlMatch; }
      else {
        const numMatch = input.match(/#?(\d+)/);
        if (numMatch) {
          issueNumber = numMatch[1];
          try {
            const { execSync } = require('child_process') as typeof import('child_process');
            const remote = execSync('git remote get-url origin', { cwd, timeout: 5000 }).toString().trim();
            const rm = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
            if (rm) { [, owner, issueRepo] = rm; }
          } catch { /* ignore */ }
        }
      }
      if (!owner || !issueRepo || !issueNumber) {
        vscode.window.showWarningMessage('Could not parse GitHub issue. Use format: https://github.com/owner/repo/issues/123');
        return;
      }
      let issueTitle = '', issueBody = '';
      try {
        const json = ghSync(['issue', 'view', String(issueNumber), '--repo', `${owner}/${issueRepo}`, '--json', 'title,body'], { cwd, timeout: 15000 });
        const parsed = JSON.parse(json);
        issueTitle = parsed.title || ''; issueBody = parsed.body || '';
      } catch {
        try {
          const https = require('https') as typeof import('https');
          const data = await new Promise<string>((resolve, reject) => {
            const req = https.get(`https://api.github.com/repos/${owner}/${issueRepo}/issues/${issueNumber}`, {
              headers: { 'User-Agent': 'MOAG-VSCode', Accept: 'application/vnd.github+json' },
            }, (res: import('http').IncomingMessage) => {
              let body = ''; res.on('data', (c: Buffer) => { body += c.toString(); }); res.on('end', () => resolve(body));
            }); req.on('error', reject); req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
          });
          const parsed = JSON.parse(data); issueTitle = parsed.title || ''; issueBody = parsed.body || '';
        } catch { vscode.window.showErrorMessage('Failed to fetch GitHub issue.'); return; }
      }
      if (!issueTitle) { vscode.window.showWarningMessage('Issue not found or empty.'); return; }
      const formatted = `# ${issueTitle}\n\n${issueBody}`;
      panel.webview.postMessage({
        type: 'prdFromIssueLoaded',
        text: formatted,
        sourceIssue: { repo: `${owner}/${issueRepo}`, number: parseInt(issueNumber, 10), title: issueTitle },
      });
    } else if (message.type === 'generatePlanFromPrd') {
      const si = message.sourceIssue as { repo: string; number: number; title: string } | null;
      panel.dispose();
      await generatePlanFromPrdText(message.prdText as string);
      if (si && deps.currentPlan) { deps.currentPlan.sourceIssues = [si]; deps.saveAndRefresh(); }
    } else if (message.type === 'prdAiImprove') {
      await handlePrdAiImprove(message.text as string, (result) => panel.webview.postMessage({ type: 'prdAiImproveResult', text: result }));
    } else if (message.type === 'prdAiDraft') {
      panel.dispose();
      await cmdPlanFromPRD();
    } else if (message.type === 'openPrdInBrowser') {
      await openPrdInBrowser(message.text as string);
    } else if (message.type === 'savePrdVersion') {
      const saved = savePrdVersionToActivePlan(message.text as string, message.version as string);
      panel.webview.postMessage({ type: 'prdVersionSaved', versions: saved.versions, version: saved.version });
    }
  });
  // Pre-fill after panel loads
  if (prefill) {
    setTimeout(() => panel.webview.postMessage({ type: 'prdFileContent', text: prefill }), 400);
  }
}

export function gatherProjectContext(cwd: string): string {
  const parts: string[] = [];
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const deps = Object.keys({ ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) }).slice(0, 25);
      if (pkg.name) { parts.push(`Project name: ${pkg.name}`); }
      if (pkg.description) { parts.push(`Description: ${pkg.description}`); }
      if (deps.length) { parts.push(`Key dependencies: ${deps.join(', ')}`); }
    }
  } catch { /* ignore */ }
  try {
    const readmePath = path.join(cwd, 'README.md');
    if (fs.existsSync(readmePath)) {
      parts.push(`README (first 800 chars):\n${fs.readFileSync(readmePath, 'utf-8').slice(0, 800)}`);
    }
  } catch { /* ignore */ }
  try {
    const entries = fs.readdirSync(cwd).filter(e => !e.startsWith('.') && e !== 'node_modules' && e !== 'dist' && e !== 'out');
    parts.push(`Workspace top-level: ${entries.join(', ')}`);
  } catch { /* ignore */ }
  try {
    const srcPath = path.join(cwd, 'src');
    if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
      parts.push(`src/ contains: ${fs.readdirSync(srcPath).slice(0, 30).join(', ')}`);
    }
  } catch { /* ignore */ }
  return parts.join('\n') || '(workspace context unavailable)';
}

export function getProjectMeta(): { name: string; stack: string } {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const wsName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as Record<string, unknown>;
    const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, unknown>;
    const tags: string[] = [];
    if (deps['typescript'] || deps['ts-node']) { tags.push('TypeScript'); }
    if (deps['next']) { tags.push('Next.js'); }
    else if (deps['react']) { tags.push('React'); }
    if (deps['vue']) { tags.push('Vue'); }
    if (deps['express']) { tags.push('Express'); }
    if (deps['@types/vscode'] || (pkg.engines as Record<string, unknown>)?.['vscode']) { tags.push('VS Code Ext'); }
    if (deps['tailwindcss']) { tags.push('Tailwind'); }
    return { name: (pkg.name as string) || wsName, stack: tags.slice(0, 3).join(' · ') };
  } catch {
    return { name: wsName, stack: '' };
  }
}

export async function handlePrdAiImprove(text: string, onResult: (improved: string) => void): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  const defaultEngine = cfg.get<EngineId>('defaultEngine', 'claude' as EngineId);
  const engine = getEngine(defaultEngine);

  // If text is short or looks like an instruction rather than a PRD, generate from project context
  const looksLikePrd = text.trim().length > 400 || /^#{1,3}\s|acceptance criteria|AC[0-9]*[:.]/im.test(text);
  let prompt: string;

  if (!looksLikePrd) {
    const projectCtx = gatherProjectContext(cwd);
    const instruction = text.trim() || 'Generate a PRD for this project';
    prompt = `You are a senior product manager. The developer asks: "${instruction}"

Using the project context below, write a complete Product Requirements Document (PRD) in Markdown.

Use this structure:
# [Feature / Product Name]

## Overview
[1-2 sentence summary]

## Goals
- ...

## User Stories
- As a ..., I want ..., so that ...

## Acceptance Criteria
- AC1: ...
- AC2: ...
- [ ] (use checkbox format for testable criteria)

## Technical Notes
[Constraints, APIs, key implementation details]

## Out of Scope
[What this PRD explicitly does NOT cover]

Project context:
${projectCtx}

Return ONLY the PRD markdown. No preamble, no explanation.`;
  } else {
    prompt = `You are a senior product manager. Improve the following PRD: sharpen ambiguous acceptance criteria, add missing edge cases, fill gaps in technical notes, and clarify the overview. Return ONLY the improved PRD markdown — keep the same structure, no preamble.\n\nPRD:\n${text}`;
  }

  try {
    // Await inside the try: this is also called as a floating promise
    // (`void handlePrdAiImprove(...)`), so an abort must not escape.
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'MOAG is improving your PRD…',
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        try {
          return await engine.runTask({ prompt, cwd, signal: abort.signal, costLabel: 'prd-improve' });
        } finally {
          sub.dispose();
        }
      },
    );
    const improved = result.stdout.trim();
    onResult(improved || text);
  } catch (err) {
    vscode.window.showErrorMessage(`AI improve failed: ${err instanceof Error ? err.message : String(err)}`);
    onResult(text);
  }
}

export async function openPrdInBrowser(text: string): Promise<void> {
  const plan = deps.getActivePlan();
  const moagDir = ensureMoagDir();
  if (!moagDir) { vscode.window.showErrorMessage('Could not create .moag directory.'); return; }
  const html = buildPrdBrowserHtml(text, plan?.name ?? 'PRD', plan?.prdVersions ?? []);
  const outPath = path.join(moagDir, 'prd-preview.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  await vscode.env.openExternal(vscode.Uri.file(outPath));
}

export function savePrdVersionToActivePlan(text: string, version: string): { versions: { version: string; text: string; createdAt: string }[]; version: string } {
  const plan = deps.getActivePlan();
  const newEntry = { version, text, createdAt: new Date().toISOString() };
  if (plan) {
    const { versions, dropped } = appendPrdVersion(plan.prdVersions, newEntry);
    plan.prdVersions = versions;
    plan.prdSource = text;
    if (deps.currentPlanPath) { savePlan(plan, deps.currentPlanPath); }
    if (deps.promptViewProvider) { deps.syncPromptProviderSidebar(deps.promptViewProvider); }
    vscode.window.showInformationMessage(
      dropped > 0
        ? `PRD saved as ${version} — ${dropped} oldest snapshot${dropped !== 1 ? 's' : ''} removed (keeping the last ${MAX_PRD_VERSIONS}).`
        : `PRD saved as ${version}`,
    );
    return { versions: plan.prdVersions, version };
  }
  return { versions: [newEntry], version };
}

export function buildPrdBrowserHtml(prdText: string, planName: string, versions: { version: string; createdAt: string }[]): string {
  const safe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rendered = safe(prdText)
    .replace(/^## (.+)$/gm, '</p><h2>$1</h2><p>')
    .replace(/^### (.+)$/gm, '</p><h3>$1</h3><p>')
    .replace(/^# (.+)$/gm, '</p><h1>$1</h1><p>')
    .replace(/^- \[ \] (.+)$/gm, '</p><li class="ac">&#9744; $1</li><p>')
    .replace(/^- \[x\] (.+)$/gm, '</p><li class="ac done">&#9745; $1</li><p>')
    .replace(/^- (.+)$/gm, '</p><li>$1</li><p>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  const versionsHtml = versions.length > 0
    ? `<div class="versions">${versions.map(v => `<span class="vpill">${safe(v.version)}</span>`).join('')}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRD — ${safe(planName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 820px; margin: 0 auto; padding: 40px 32px; background: #1e1e1e; color: #d4d4d4; line-height: 1.7; }
  h1 { font-size: 24px; color: #e8e8e8; border-bottom: 2px solid #0078d4; padding-bottom: 12px; margin: 0 0 20px; }
  h2 { font-size: 18px; color: #e0e0e0; margin: 28px 0 10px; }
  h3 { font-size: 15px; color: #ccc; margin: 18px 0 6px; }
  p { margin: 6px 0; } li { margin: 3px 0 3px 20px; }
  li.ac { list-style: none; margin-left: 0; font-family: 'Cascadia Code', monospace; font-size: 13px; }
  li.done { opacity: 0.55; text-decoration: line-through; }
  code { background: #2d2d2d; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  strong { color: #e0e0e0; }
  .meta { font-size: 12px; color: #555; margin-bottom: 20px; }
  .versions { margin-bottom: 16px; }
  .vpill { background: rgba(0,120,212,0.2); border: 1px solid rgba(0,120,212,0.4); color: #4fc3f7; border-radius: 12px; padding: 2px 10px; font-size: 11px; margin-right: 6px; }
</style>
</head>
<body>
<div class="meta">Generated by MOAG &mdash; ${new Date().toLocaleString()}</div>
${versionsHtml}
<p>${rendered}</p>
</body>
</html>`;
}


export async function cmdPlanFromPRD(): Promise<void> {
  await openPrdPanel();
}

// kept for direct invocation from old entry points
export function buildPrdPanelHtml(webview: vscode.Webview, prefill = '', versions: { version: string; text: string; createdAt: string }[] = []): string {
  // Handed to the page as data. JSON.stringify escapes the content; the lone <
  // is neutralised so a value can never close the block carrying it.
  const prdBootstrap = JSON.stringify({ versions, prefill })
    .replace(/</g, '\u003c');
  const scriptUri = webviewScriptUri(webview, 'prd-panel');
  const nonce = webviewNonce();
  const csp = webviewCsp(webview, nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${csp}
<title>Generate Plan from PRD</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; background: #1e1e1e; color: #cccccc;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }
  .header { padding: 20px 32px 12px; border-bottom: 1px solid #333; flex-shrink: 0; }
  .header h1 { font-size: 18px; font-weight: 600; color: #e0e0e0; margin-bottom: 6px; }
  .header p { font-size: 12px; color: #888; line-height: 1.5; }
  .version-bar {
    display: none; align-items: center; gap: 8px;
    padding: 10px 32px 0; flex-shrink: 0; font-size: 12px; color: #888;
  }
  .version-bar.visible { display: flex; }
  .version-select {
    background: #2d2d2d; border: 1px solid #444; color: #ccc;
    border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer;
  }
  .version-save-btn {
    padding: 4px 12px; background: transparent; border: 1px solid #444;
    color: #888; border-radius: 4px; cursor: pointer; font-size: 11px;
  }
  .version-save-btn:hover { border-color: #5a9e5a; color: #9dcc9d; }
  .body {
    flex: 1; display: flex; flex-direction: column;
    padding: 14px 32px 0; gap: 10px; min-height: 0;
  }
  .tip {
    font-size: 11px; color: #666; background: #252525;
    border-left: 3px solid #0078d4; padding: 8px 12px;
    border-radius: 0 4px 4px 0; line-height: 1.5; flex-shrink: 0;
  }
  .tip strong { color: #999; }
  .textarea-wrap { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; }
  textarea {
    flex: 1; resize: none; background: #2d2d2d; color: #d4d4d4;
    border: 1px solid #444; border-radius: 6px; padding: 14px 16px;
    font-size: 13px; font-family: 'Cascadia Code','Fira Code','Consolas',monospace;
    line-height: 1.6; outline: none; min-height: 0;
  }
  textarea:focus { border-color: #0078d4; }
  .ai-btn {
    position: absolute; bottom: 10px; right: 12px;
    font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer;
    background: rgba(0,120,212,0.15); border: 1px solid rgba(0,120,212,0.4); color: #4fc3f7;
  }
  .ai-btn:hover { background: rgba(0,120,212,0.28); }
  .ai-btn:disabled { opacity: 0.5; cursor: default; }
  .footer {
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0; padding: 10px 32px 24px; gap: 12px;
  }
  .footer-left { display: flex; align-items: center; gap: 10px; }
  .browse-btn, .save-btn, .browser-btn {
    padding: 8px 14px; background: transparent; border: 1px solid #555;
    color: #aaa; border-radius: 5px; cursor: pointer; font-size: 12px;
  }
  .browse-btn:hover, .browser-btn:hover { border-color: #0078d4; color: #d4d4d4; }
  .save-btn:hover { border-color: #5a9e5a; color: #9dcc9d; }
  .char-count { font-size: 11px; color: #666; }
  .generate-btn {
    padding: 9px 24px; background: #0078d4; color: #fff; border: none;
    border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 600; min-width: 160px;
  }
  .generate-btn:disabled { opacity: 0.4; cursor: default; }
  .generate-btn:not(:disabled):hover { background: #026ec1; }
</style>
</head>
<body>
<div class="header">
  <h1>&#128196; Generate Plan from PRD</h1>
  <p>Paste your PRD below. MOAG will generate a Design &rarr; Development &rarr; Testing plan automatically.</p>
</div>
<div class="version-bar" id="versionBar">
  <span>Version:</span>
  <select id="versionSelect" class="version-select"></select>
  <button id="versionSaveBtn" class="version-save-btn" type="button">Save as v1.0</button>
</div>
<div class="body">
  <div class="tip">
    <strong>Tip:</strong> Include acceptance criteria (<code>AC1: ...</code> or <code>- [ ] ...</code>) so MOAG builds a TEST CRITERIA checklist during the testing phase.
  </div>
  <div class="textarea-wrap">
    <textarea id="prd" placeholder="Paste your PRD here...

## Feature: User login

### Acceptance Criteria
AC1: User can log in with email and password
AC2: Invalid credentials show a clear error message
AC3: Successful login redirects to dashboard"></textarea>
    <button class="ai-btn" id="aiBtn" type="button">&#10024; Draft with AI</button>
  </div>
</div>
<div class="footer">
  <div class="footer-left">
    <button class="browse-btn" id="browseBtn">Browse .md / .txt&hellip;</button>
    <button class="browse-btn" id="issueBtn" title="Load content from a GitHub issue">&#128279; From Issue</button>
    <button class="save-btn" id="saveBtn">Save as .md</button>
    <button class="browser-btn" id="browserBtn" title="Open PRD in browser">&#127758; Open in Browser</button>
    <span class="char-count" id="charCount">0 chars</span>
  </div>
  <button class="generate-btn" id="generateBtn" disabled>Generate Plan &rarr;</button>
</div>
  <script id="moag-prd-bootstrap" type="application/json">${prdBootstrap}</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;}


export async function generatePlanFromPrdText(prdText: string): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { UserMsg.showError(UserMsg.noWorkspace()); return; }
  const cwd = workspaceFolder.uri.fsPath;

  if (!prdText) {
    vscode.window.showWarningMessage('PRD text is empty — plan generation cancelled.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer');
  const defaultEngine = cfg.get<EngineId>('defaultEngine', 'claude' as EngineId);

  const prdPrompt = `You are a senior engineering lead. Given the Product Requirements Document (PRD) below, generate a structured JSON execution plan for an AI coding agent.

The plan MUST have up to three playlists in this order:
1. "Design" — UI/UX specs, component sketches, API contract decisions. OMIT this playlist if the PRD mentions no user interface or front-end work.
2. "Development" — implementation tasks (backend, frontend, infrastructure, migrations, etc.)
3. "Testing" — test writing, QA, edge-case coverage, accessibility checks (set "testPhase": true)

Rules:
- Each task must have: "id" (unique string e.g. "task-1"), "name" (short title), "prompt" (detailed enough for Claude Code to execute autonomously — include file paths, acceptance criteria, patterns to follow), "status": "pending"
- Task type rules — include optional "type" field (defaults to "agent"):
  - "agent"       AI coding tasks (most tasks)
  - "command"     Shell commands (test deps.runners, builds). Set "command" field to the exact shell command (e.g., "npm test", "pytest", "go test ./..."). The Testing playlist MUST include at least one "command" task running the test suite.
  - "visual-test" Browser UI verification via screenshot + vision. For web/frontend projects only.
- Each playlist must have: "id" (unique string), "name" (string), "testPhase" (boolean — true only for Testing), "tasks" (array)
- Each playlist SHOULD have a "role" — the expert persona the agent adopts. Exactly one of:
  "architect" | "designer" | "engineer" | "reviewer" | "tester" | "devops".
  Typical mapping: Design → "designer", Development → "engineer", Testing → "tester".
  Omit the field entirely if unsure. Never invent a value outside that list.
- The root plan object must have: "version": "1.0", "name" (brief feature name derived from the PRD), "description" (one sentence), "playlists" (array)
- Return ONLY valid JSON. No markdown code fences, no explanation, no preamble.
- Keep tasks focused and atomic — one concern per task.

PRD:
${prdText}`;

  const planHolder: { json: string } = { json: '' };

  try {
    const engine = getEngine(defaultEngine);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Generating plan from PRD...' },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());
        const result = await engine.runTask({
          prompt: prdPrompt,
          cwd,
          signal: abortController.signal,
          costLabel: 'plan-generation',
        });
        if (result.exitCode === 0 && result.stdout.trim()) {
          planHolder.json = result.stdout.trim();
        }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`PRD plan generation failed: ${msg.substring(0, 200)}`);
    return;
  }

  if (!planHolder.json) {
    vscode.window.showErrorMessage('AI did not return a plan. Try again or check your API key / engine settings.');
    return;
  }

  // Strip markdown fences if the AI ignored the instruction
  const planJson = planHolder.json.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  let parsed: { version?: string; name?: string; playlists?: unknown[] };
  try {
    parsed = JSON.parse(planJson);
  } catch {
    vscode.window.showErrorMessage('AI returned invalid JSON. Try again.');
    return;
  }

  if (!parsed.version || !parsed.name || !Array.isArray(parsed.playlists) || parsed.playlists.length === 0) {
    vscode.window.showErrorMessage('Generated plan is missing required fields (version, name, playlists).');
    return;
  }

  (parsed as Record<string, unknown>).prdSource = prdText;

  // Count roles the generator invented before hydration silently coerces them away, so the
  // completion notification can say why a playlist came back without the role it asked for.
  const invalidRoleCount = (parsed.playlists as Array<{ role?: unknown }>)
    .filter(pl => pl?.role !== undefined && !isRoleId(pl.role)).length;

  // Hydrate → inject missing test deps.runner → dehydrate back so the JSON file has the task
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hydratedPrd = hydratePlan(parsed as any);
    deps.injectTestTaskIfMissing(hydratedPrd, cwd);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dehydrated = dehydratePlan(hydratedPrd) as any;
    dehydrated.prdSource = prdText;
    parsed = dehydrated;
  } catch { /* best-effort — proceed with unmodified parsed if hydration fails */ }

  const moagDir = ensureMoagDir();
  if (!moagDir) {
    vscode.window.showErrorMessage('Could not create .moag directory.');
    return;
  }

  const taskCount = (parsed.playlists as Array<{ tasks?: unknown[] }>).reduce((s, pl) => s + (pl.tasks?.length ?? 0), 0);
  const playlistCount = (parsed.playlists as unknown[]).length;

  // Guard against duplicates — use a deterministic path based on plan name
  const safeName = (parsed.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 40);
  const canonicalPath = path.join(moagDir, `${safeName}.agent-plan.json`);
  let planPath = canonicalPath;

  if (fs.existsSync(canonicalPath)) {
    const existing = (() => { try { return JSON.parse(fs.readFileSync(canonicalPath, 'utf-8')) as { name?: string; playlists?: unknown[] }; } catch { return null; } })();
    const existingTasks = existing?.playlists
      ? (existing.playlists as Array<{ tasks?: unknown[] }>).reduce((s, pl) => s + (pl.tasks?.length ?? 0), 0)
      : 0;
    const choice = await vscode.window.showWarningMessage(
      `A plan "${existing?.name ?? safeName}" already exists (${existingTasks} tasks). Replace it with the new plan (${taskCount} tasks)?`,
      { modal: false },
      'Replace',
      'Keep Both',
    );
    if (!choice) { return; }
    if (choice === 'Keep Both') {
      planPath = path.join(moagDir, `${safeName}-${Date.now()}.agent-plan.json`);
    }
  }

  fs.writeFileSync(planPath, JSON.stringify(parsed, null, 2), 'utf-8');

  const roleNote = invalidRoleCount > 0
    ? ` — ${invalidRoleCount} playlist${invalidRoleCount !== 1 ? 's' : ''} had an unrecognised role and will use the plan default`
    : '';
  const action = await vscode.window.showInformationMessage(
    `Plan generated — ${taskCount} task${taskCount !== 1 ? 's' : ''} across ${playlistCount} playlist${playlistCount !== 1 ? 's' : ''}${roleNote}`,
    'Open Plan',
  );
  if (action === 'Open Plan') {
    void vscode.commands.executeCommand('agentTaskPlayer.runPlanFile', planPath);
  }
}
