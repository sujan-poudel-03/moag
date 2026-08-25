import * as vscode from 'vscode';
import { AiRule, RuleCategory, RuleScope } from '../ai-rules/rules-store';
import { generateId } from '../models/plan';
import { designSystemCssTokens } from './design-system';
import { webviewCsp, webviewNonce, webviewScriptUri } from './webview-assets';

export interface RuleEditorOptions {
  rule: AiRule | null;
  hasWorkspace: boolean;
  onSave: (rule: AiRule) => void;
}

const openPanels = new Map<string, RuleEditorPanel>();

export class RuleEditorPanel {
  private readonly _panel: vscode.WebviewPanel;
  private _disposed = false;
  private readonly _onSave: (rule: AiRule) => void;

  private constructor(panel: vscode.WebviewPanel, options: RuleEditorOptions) {
    this._panel = panel;
    this._onSave = options.onSave;
    panel.onDidDispose(() => {
      this._disposed = true;
      openPanels.delete(panel.title);
    });
    panel.webview.onDidReceiveMessage((msg) => this._handleMessage(msg, options));
    this._render(options);
  }

  static open(options: RuleEditorOptions): void {
    const panelKey = options.rule?.id ?? '__new_rule__';
    const existing = openPanels.get(panelKey);
    if (existing && !existing._disposed) {
      existing._panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const title = options.rule ? `Edit Rule: ${options.rule.name}` : 'New AI Rule';
    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerRuleEditor',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    const instance = new RuleEditorPanel(panel, options);
    openPanels.set(panelKey, instance);
  }

  private _handleMessage(msg: { type: string; payload?: unknown }, options: RuleEditorOptions): void {
    if (msg.type === 'cancel') {
      this._panel.dispose();
      return;
    }
    if (msg.type === 'save') {
      const data = msg.payload as Record<string, unknown>;
      const name = String(data.name ?? '').trim();
      const text = String(data.text ?? '').trim();
      if (!name || !text) { return; }
      const rule: AiRule = {
        id: options.rule?.id ?? generateId(),
        name,
        category: (data.category as RuleCategory) || 'custom',
        scope: (data.scope as RuleScope) || 'global',
        text,
        enabled: options.rule?.enabled ?? true,
      };
      this._onSave(rule);
      this._panel.dispose();
    }
  }

  private _render(options: RuleEditorOptions): void {
    const rule = options.rule;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const val = (s: string | undefined) => esc(s ?? '');
    const sel = (a: string, b: string) => a === b ? ' selected' : '';
    const chk = (a: string, b: string) => a === b ? ' checked' : '';

    const categories: [RuleCategory, string][] = [
      ['code-quality', 'Code Quality'],
      ['security', 'Security'],
      ['architecture', 'Architecture'],
      ['testing', 'Testing'],
      ['performance', 'Performance'],
      ['custom', 'Custom'],
    ];

    const curCat = rule?.category ?? 'custom';
    const curScope = rule?.scope ?? 'global';
    const curText = rule?.text ?? '';
    const curName = rule?.name ?? '';

    // The script is a compiled file, not an inline block; the CSP admits only it.
    const scriptUri = webviewScriptUri(this._panel.webview, 'rule-editor');
    const nonce = webviewNonce();
    const csp = webviewCsp(this._panel.webview, nonce);
    this._panel.webview.html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${csp}
  <style>
    ${designSystemCssTokens()}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--ds-font-family);
      font-size: var(--ds-font-size);
      color: var(--ds-fg);
      background: transparent;
      padding: 24px 28px;
      max-width: 680px;
    }
    h1 { font-size: 15px; font-weight: 600; margin-bottom: 20px; }
    .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 16px; }
    .field label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--vscode-descriptionForeground);
    }
    .field input, .field select, .field textarea {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    .field input:focus, .field select:focus, .field textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .field textarea { resize: vertical; min-height: 140px; line-height: 1.5; }
    .scope-row { display: flex; gap: 12px; }
    .scope-option {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 12px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      flex: 1;
    }
    .scope-option input[type=radio] { accent-color: var(--vscode-focusBorder); }
    .scope-option:has(input:checked) {
      border-color: var(--vscode-focusBorder);
      background: rgba(79,163,255,0.07);
    }
    .scope-label { font-weight: 600; font-size: 12px; }
    .scope-desc { font-size: 10px; color: var(--vscode-descriptionForeground); display: block; margin-top: 1px; }
    .char-count { font-size: 10px; color: var(--vscode-descriptionForeground); text-align: right; margin-top: 2px; }
    .actions { display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end; }
    .btn {
      padding: 6px 16px; border-radius: 4px; border: none;
      font-size: 12px; font-family: inherit; cursor: pointer; font-weight: 500;
    }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: transparent; color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    }
    .btn-secondary:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .preview {
      margin-top: 20px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      border-radius: 6px;
      overflow: hidden;
    }
    .preview-hd {
      padding: 5px 10px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--vscode-descriptionForeground);
      background: rgba(128,128,128,0.06);
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .preview-body {
      padding: 10px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-descriptionForeground);
      max-height: 120px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <h1>${rule ? 'Edit Rule' : 'New AI Rule'}</h1>

  <div class="field">
    <label for="name">Rule Name</label>
    <input id="name" type="text" value="${val(curName)}" placeholder="e.g. SOLID Principles" autocomplete="off" />
  </div>

  <div class="field">
    <label for="category">Category</label>
    <select id="category">
      ${categories.map(([id, label]) => `<option value="${id}"${sel(curCat, id)}>${label}</option>`).join('\n      ')}
    </select>
  </div>

  <div class="field">
    <label>Scope</label>
    <div class="scope-row">
      <label class="scope-option">
        <input type="radio" name="scope" value="global"${chk(curScope, 'global')} />
        <span>
          <span class="scope-label">Global</span>
          <span class="scope-desc">All projects — saved to your user profile</span>
        </span>
      </label>
      <label class="scope-option" id="workspaceOption"${!options.hasWorkspace ? ' style="opacity:0.4;pointer-events:none;"' : ''}>
        <input type="radio" name="scope" value="workspace"${chk(curScope, 'workspace')}${!options.hasWorkspace ? ' disabled' : ''} />
        <span>
          <span class="scope-label">Workspace</span>
          <span class="scope-desc">This project — saved to .moag/rules.json</span>
        </span>
      </label>
    </div>
  </div>

  <div class="field">
    <label for="text">Rule Text</label>
    <textarea id="text" placeholder="Describe the rule the AI should follow...">${val(curText)}</textarea>
    <div class="char-count" id="charCount">${curText.length} characters</div>
  </div>

  <div class="preview">
    <div class="preview-hd">Prompt injection preview</div>
    <div class="preview-body" id="preview">### ${val(curName) || '(name)'}&#10;${val(curText) || '(rule text)'}</div>
  </div>

  <div class="actions">
    <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
    <button class="btn btn-primary" id="saveBtn">Save Rule</button>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
