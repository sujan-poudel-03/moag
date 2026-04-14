// ─── Task Editor Panel ───
// Form-based webview for editing/creating tasks — replaces the 17-dialog chain.

import * as vscode from 'vscode';
import { Task, TaskType, EngineId, FailurePolicy, TaskStatus } from '../models/types';
import { generateId } from '../models/plan';
import { designSystemCssTokens } from './design-system';

/** Options passed to TaskEditorPanel.open() */
export interface TaskEditorOptions {
  task: Task;
  playlistIndex: number;
  taskIndex: number | null; // null = new task
  engines: EngineId[];
  onSave: (task: Task) => void;
}

/** Tracks open panels by task ID to prevent duplicates */
const openPanels = new Map<string, TaskEditorPanel>();

export class TaskEditorPanel {
  private readonly _panel: vscode.WebviewPanel;
  private _task: Task;
  private _disposed = false;
  private readonly _onSave: (task: Task) => void;

  private constructor(panel: vscode.WebviewPanel, options: TaskEditorOptions) {
    this._panel = panel;
    this._task = JSON.parse(JSON.stringify(options.task)); // working copy
    this._onSave = options.onSave;

    panel.onDidDispose(() => {
      this._disposed = true;
      openPanels.delete(this._task.id);
    });

    panel.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    this._render();
  }

  static open(options: TaskEditorOptions): void {
    const taskId = options.task.id || '__new__';

    // Reuse existing panel for this task
    const existing = openPanels.get(taskId);
    if (existing && !existing._disposed) {
      existing._panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const title = options.taskIndex === null
      ? 'New Task'
      : `Edit: ${options.task.name || 'Task'}`;

    const panel = vscode.window.createWebviewPanel(
      'agentTaskPlayerEditor',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );

    const instance = new TaskEditorPanel(panel, options);
    openPanels.set(taskId, instance);
  }

  private _handleMessage(msg: { type: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'save': {
        const data = msg.payload as Record<string, unknown>;
        this._applyFormData(data);
        this._onSave(this._task);
        this._panel.dispose();
        break;
      }
      case 'cancel':
        this._panel.dispose();
        break;
      case 'type-changed': {
        const data = msg.payload as Record<string, unknown>;
        this._task.type = (data.type as TaskType) || 'agent';
        // Re-render is handled client-side via JS show/hide
        break;
      }
    }
  }

  private _applyFormData(data: Record<string, unknown>): void {
    this._task.name = String(data.name || '').trim();
    this._task.prompt = String(data.prompt || '').trim();
    this._task.type = (data.type as TaskType) || 'agent';

    const engine = String(data.engine || '');
    this._task.engine = engine && engine !== 'default' ? engine as EngineId : undefined;

    this._task.command = strOrUndef(data.command);
    this._task.cwd = strOrUndef(data.cwd);
    this._task.verifyCommand = strOrUndef(data.verifyCommand);
    this._task.acceptanceCriteria = parseLines(data.acceptanceCriteria);
    this._task.expectedArtifacts = parseLines(data.expectedArtifacts);
    this._task.ownerNote = strOrUndef(data.ownerNote);

    const fp = String(data.failurePolicy || 'continue');
    this._task.failurePolicy = fp !== 'continue' ? fp as FailurePolicy : undefined;

    this._task.env = parseEnv(data.env);

    const port = Number(data.port);
    this._task.port = Number.isFinite(port) && port > 0 ? port : undefined;

    this._task.readyPattern = strOrUndef(data.readyPattern);
    this._task.healthCheckUrl = strOrUndef(data.healthCheckUrl);

    const startupTimeout = Number(data.startupTimeoutMs);
    this._task.startupTimeoutMs = Number.isFinite(startupTimeout) && startupTimeout > 0 ? startupTimeout : undefined;

    const retryCount = Number(data.retryCount);
    this._task.retryCount = Number.isFinite(retryCount) && retryCount > 0 ? retryCount : undefined;

    this._task.dependsOn = parseLines(data.dependsOn);

    // skipIf support
    const skipIfTaskId = strOrUndef(data.skipIfTaskId);
    const skipIfStatus = strOrUndef(data.skipIfStatus);
    if (skipIfTaskId && skipIfStatus) {
      this._task.skipIf = {
        taskId: skipIfTaskId,
        status: skipIfStatus as TaskStatus,
      };
    } else {
      this._task.skipIf = undefined;
    }

    // Consensus support
    const consensusEngines = parseLines(data.consensusEngines);
    const consensusStrategy = strOrUndef(data.consensusStrategy);
    if (consensusEngines && consensusEngines.length > 0 && consensusStrategy) {
      this._task.consensus = {
        engines: consensusEngines as EngineId[],
        strategy: consensusStrategy as 'first-pass' | 'best-diff',
      };
    } else {
      this._task.consensus = undefined;
    }
  }

  private _render(): void {
    this._panel.webview.html = this._getHtml();
  }

  private _getHtml(): string {
    const t = this._task;
    const taskType = t.type || 'agent';
    const engine = t.engine || 'default';
    const failurePolicy = t.failurePolicy || 'continue';
    const acceptanceCriteria = (t.acceptanceCriteria || []).join('\n');
    const expectedArtifacts = (t.expectedArtifacts || []).join('\n');
    const env = t.env ? Object.entries(t.env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
    const dependsOn = (t.dependsOn || []).join('\n');
    const skipIf = (t as Task & { skipIf?: { taskId: string; status: string } }).skipIf;
    const skipIfTaskId = skipIf?.taskId || '';
    const skipIfStatus = skipIf?.status || '';
    const consensusEngines = (t.consensus?.engines || []).join('\n');
    const consensusStrategy = t.consensus?.strategy || '';

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  ${designSystemCssTokens()}
  :root {
    --bg: var(--ds-bg);
    --fg: var(--ds-fg);
    --input-bg: var(--ds-input-bg);
    --input-fg: var(--ds-input-fg);
    --input-border: var(--ds-input-border);
    --btn-bg: var(--ds-btn-bg);
    --btn-fg: var(--ds-btn-fg);
    --btn-hover: var(--ds-btn-hover);
    --btn-secondary-bg: var(--ds-btn-secondary-bg);
    --btn-secondary-fg: var(--ds-btn-secondary-fg);
    --section-border: var(--ds-border);
    --focus-border: var(--ds-focus);
    --error: var(--ds-error);
    --description: var(--ds-muted);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--ds-font-family);
    font-size: var(--ds-font-size);
    color: var(--fg);
    background: var(--bg);
    padding: 0;
  }

  .toolbar {
    position: sticky;
    top: 0;
    z-index: 100;
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    background: var(--bg);
    border-bottom: 1px solid var(--section-border);
  }

  .toolbar button {
    padding: 6px 16px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
  }

  .btn-primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
  }
  .btn-primary:hover { background: var(--btn-hover); }

  .btn-secondary {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
  }

  .toolbar .spacer { flex: 1; }

  .form-body {
    padding: 16px 20px 40px;
    max-width: 720px;
  }

  .section {
    margin-bottom: 20px;
    border: 1px solid var(--section-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: var(--vscode-sideBar-background, var(--bg));
    cursor: pointer;
    user-select: none;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .section-header:hover { opacity: 0.85; }
  .section-header .chevron { transition: transform 0.15s; }
  .section-header.collapsed .chevron { transform: rotate(-90deg); }

  .section-body {
    padding: 12px;
  }
  .section-body.hidden { display: none; }

  .field {
    margin-bottom: 12px;
  }
  .field:last-child { margin-bottom: 0; }

  label {
    display: block;
    margin-bottom: 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--fg);
  }

  label .hint {
    font-weight: 400;
    color: var(--description);
    margin-left: 4px;
  }

  input[type="text"],
  input[type="number"],
  select,
  textarea {
    width: 100%;
    padding: 5px 8px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 2px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }

  input:focus, select:focus, textarea:focus {
    border-color: var(--focus-border);
  }

  textarea {
    resize: vertical;
    min-height: 60px;
  }

  textarea.large { min-height: 120px; }

  .row {
    display: flex;
    gap: 12px;
  }
  .row > .field { flex: 1; }

  .validation-error {
    color: var(--error);
    font-size: 12px;
    margin-top: 2px;
    display: none;
  }

  .validation-error.visible { display: block; }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-primary" id="btnSave">$(check) Save</button>
    <button class="btn-secondary" id="btnCancel">Cancel</button>
    <span class="spacer"></span>
    <span style="color:var(--description);font-size:12px;align-self:center;">${escHtml(t.id)}</span>
  </div>

  <div class="form-body">
    <!-- Core Section -->
    <div class="section" data-section="core">
      <div class="section-header" onclick="toggleSection(this)">
        <span class="chevron">▼</span> Core
      </div>
      <div class="section-body">
        <div class="field">
          <label>Name <span class="hint">(required)</span></label>
          <input type="text" id="name" value="${escAttr(t.name)}" placeholder="Task name" />
          <div class="validation-error" id="nameError">Name is required</div>
        </div>
        <div class="row">
          <div class="field">
            <label>Type</label>
            <select id="type" onchange="onTypeChange()">
              <option value="agent" ${taskType === 'agent' ? 'selected' : ''}>Agent</option>
              <option value="command" ${taskType === 'command' ? 'selected' : ''}>Command</option>
              <option value="service" ${taskType === 'service' ? 'selected' : ''}>Service</option>
              <option value="check" ${taskType === 'check' ? 'selected' : ''}>Check</option>
            </select>
          </div>
          <div class="field">
            <label>Engine</label>
            <select id="engine">
              <option value="default" ${engine === 'default' ? 'selected' : ''}>Use default</option>
              <option value="claude" ${engine === 'claude' ? 'selected' : ''}>Claude</option>
              <option value="codex" ${engine === 'codex' ? 'selected' : ''}>Codex</option>
              <option value="gemini" ${engine === 'gemini' ? 'selected' : ''}>Gemini</option>
              <option value="ollama" ${engine === 'ollama' ? 'selected' : ''}>Ollama</option>
              <option value="custom" ${engine === 'custom' ? 'selected' : ''}>Custom</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Prompt <span class="hint" id="promptHint">(required for agent tasks)</span></label>
          <textarea id="prompt" class="large" placeholder="Detailed instruction for the agent...">${escHtml(t.prompt)}</textarea>
          <div class="validation-error" id="promptError">Prompt is required for agent tasks</div>
        </div>
      </div>
    </div>

    <!-- Command Section -->
    <div class="section" id="sectionCommand" style="display:${taskType !== 'agent' ? 'block' : 'none'}">
      <div class="section-header" onclick="toggleSection(this)">
        <span class="chevron">▼</span> Command
      </div>
      <div class="section-body">
        <div class="field">
          <label>Shell command <span class="hint">(required for command/service/check)</span></label>
          <input type="text" id="command" value="${escAttr(t.command || '')}" placeholder="e.g., npm test" />
          <div class="validation-error" id="commandError">Command is required for this task type</div>
        </div>
        <div class="field">
          <label>Working directory <span class="hint">(relative to workspace root)</span></label>
          <input type="text" id="cwd" value="${escAttr(t.cwd || '')}" placeholder="e.g., packages/api" />
        </div>
      </div>
    </div>

    <!-- Verification Section -->
    <div class="section" data-section="verification">
      <div class="section-header" onclick="toggleSection(this)">
        <span class="chevron">▼</span> Verification
      </div>
      <div class="section-body">
        <div class="field">
          <label>Verify command <span class="hint">(optional)</span></label>
          <input type="text" id="verifyCommand" value="${escAttr(t.verifyCommand || '')}" placeholder="e.g., npm test" />
        </div>
        <div class="field">
          <label>Acceptance criteria <span class="hint">(one per line)</span></label>
          <textarea id="acceptanceCriteria" placeholder="Criteria shown in the dashboard...">${escHtml(acceptanceCriteria)}</textarea>
        </div>
        <div class="field">
          <label>Expected artifacts <span class="hint">(one path per line)</span></label>
          <textarea id="expectedArtifacts" placeholder="e.g., dist/index.js">${escHtml(expectedArtifacts)}</textarea>
        </div>
      </div>
    </div>

    <!-- Service Section -->
    <div class="section" id="sectionService" style="display:${taskType === 'service' ? 'block' : 'none'}">
      <div class="section-header" onclick="toggleSection(this)">
        <span class="chevron">▼</span> Service
      </div>
      <div class="section-body">
        <div class="row">
          <div class="field">
            <label>Port</label>
            <input type="number" id="port" value="${t.port || ''}" placeholder="e.g., 3000" />
          </div>
          <div class="field">
            <label>Startup timeout (ms)</label>
            <input type="number" id="startupTimeoutMs" value="${t.startupTimeoutMs || ''}" placeholder="e.g., 60000" />
          </div>
        </div>
        <div class="field">
          <label>Ready pattern <span class="hint">(regex matched against stdout)</span></label>
          <input type="text" id="readyPattern" value="${escAttr(t.readyPattern || '')}" placeholder="e.g., listening on" />
        </div>
        <div class="field">
          <label>Health check URL</label>
          <input type="text" id="healthCheckUrl" value="${escAttr(t.healthCheckUrl || '')}" placeholder="e.g., http://localhost:3000/health" />
        </div>
      </div>
    </div>

    <!-- Advanced Section -->
    <div class="section" data-section="advanced">
      <div class="section-header collapsed" onclick="toggleSection(this)">
        <span class="chevron">▼</span> Advanced
      </div>
      <div class="section-body hidden">
        <div class="row">
          <div class="field">
            <label>Failure policy</label>
            <select id="failurePolicy">
              <option value="continue" ${failurePolicy === 'continue' ? 'selected' : ''}>Continue</option>
              <option value="stop" ${failurePolicy === 'stop' ? 'selected' : ''}>Stop</option>
              <option value="mark-blocked" ${failurePolicy === 'mark-blocked' ? 'selected' : ''}>Mark blocked</option>
            </select>
          </div>
          <div class="field">
            <label>Retry count</label>
            <input type="number" id="retryCount" value="${t.retryCount || ''}" min="0" placeholder="0" />
          </div>
        </div>
        <div class="field">
          <label>Environment variables <span class="hint">(KEY=value, one per line)</span></label>
          <textarea id="env" placeholder="PORT=3000">${escHtml(env)}</textarea>
        </div>
        <div class="field">
          <label>Owner note</label>
          <textarea id="ownerNote" placeholder="Review notes, constraints...">${escHtml(t.ownerNote || '')}</textarea>
        </div>
        <div class="field">
          <label>Dependencies <span class="hint">(task IDs, one per line)</span></label>
          <textarea id="dependsOn" placeholder="Task IDs that must complete first">${escHtml(dependsOn)}</textarea>
        </div>
        <div class="field">
          <label>Skip if — Task ID</label>
          <input type="text" id="skipIfTaskId" value="${escAttr(skipIfTaskId)}" placeholder="Task ID to check" />
        </div>
        <div class="field">
          <label>Skip if — Status</label>
          <select id="skipIfStatus">
            <option value="" ${!skipIfStatus ? 'selected' : ''}>(none)</option>
            <option value="completed" ${skipIfStatus === 'completed' ? 'selected' : ''}>Completed</option>
            <option value="failed" ${skipIfStatus === 'failed' ? 'selected' : ''}>Failed</option>
            <option value="skipped" ${skipIfStatus === 'skipped' ? 'selected' : ''}>Skipped</option>
          </select>
        </div>
        <div class="field">
          <label>Consensus engines <span class="hint">(one per line: claude, codex, gemini, ollama, custom)</span></label>
          <textarea id="consensusEngines" placeholder="claude\ncodex\ngemini">${escHtml(consensusEngines)}</textarea>
        </div>
        <div class="field">
          <label>Consensus strategy</label>
          <select id="consensusStrategy">
            <option value="" ${!consensusStrategy ? 'selected' : ''}>(none — disabled)</option>
            <option value="first-pass" ${consensusStrategy === 'first-pass' ? 'selected' : ''}>First pass (first engine that succeeds wins)</option>
            <option value="best-diff" ${consensusStrategy === 'best-diff' ? 'selected' : ''}>Best diff (engine with most file changes wins)</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function toggleSection(header) {
      header.classList.toggle('collapsed');
      const body = header.nextElementSibling;
      body.classList.toggle('hidden');
    }

    function onTypeChange() {
      const type = document.getElementById('type').value;
      document.getElementById('sectionCommand').style.display = type !== 'agent' ? 'block' : 'none';
      document.getElementById('sectionService').style.display = type === 'service' ? 'block' : 'none';

      // Update prompt hint
      const hint = document.getElementById('promptHint');
      hint.textContent = type === 'agent' ? '(required for agent tasks)' : '(optional description)';
    }

    function validate() {
      let valid = true;
      const name = document.getElementById('name').value.trim();
      const type = document.getElementById('type').value;
      const prompt = document.getElementById('prompt').value.trim();
      const command = document.getElementById('command').value.trim();

      // Name required
      const nameErr = document.getElementById('nameError');
      if (!name) { nameErr.classList.add('visible'); valid = false; }
      else { nameErr.classList.remove('visible'); }

      // Prompt required for agent
      const promptErr = document.getElementById('promptError');
      if (type === 'agent' && !prompt) { promptErr.classList.add('visible'); valid = false; }
      else { promptErr.classList.remove('visible'); }

      // Command required for command/service/check
      const cmdErr = document.getElementById('commandError');
      if (type !== 'agent' && !command) { cmdErr.classList.add('visible'); valid = false; }
      else { cmdErr.classList.remove('visible'); }

      return valid;
    }

    function collectFormData() {
      return {
        name: document.getElementById('name').value,
        type: document.getElementById('type').value,
        engine: document.getElementById('engine').value,
        prompt: document.getElementById('prompt').value,
        command: document.getElementById('command').value,
        cwd: document.getElementById('cwd').value,
        verifyCommand: document.getElementById('verifyCommand').value,
        acceptanceCriteria: document.getElementById('acceptanceCriteria').value,
        expectedArtifacts: document.getElementById('expectedArtifacts').value,
        ownerNote: document.getElementById('ownerNote').value,
        failurePolicy: document.getElementById('failurePolicy').value,
        env: document.getElementById('env').value,
        port: document.getElementById('port').value,
        readyPattern: document.getElementById('readyPattern').value,
        healthCheckUrl: document.getElementById('healthCheckUrl').value,
        startupTimeoutMs: document.getElementById('startupTimeoutMs').value,
        retryCount: document.getElementById('retryCount').value,
        dependsOn: document.getElementById('dependsOn').value,
        skipIfTaskId: document.getElementById('skipIfTaskId').value,
        skipIfStatus: document.getElementById('skipIfStatus').value,
        consensusEngines: document.getElementById('consensusEngines').value,
        consensusStrategy: document.getElementById('consensusStrategy').value,
      };
    }

    document.getElementById('btnSave').addEventListener('click', () => {
      if (!validate()) return;
      vscode.postMessage({ type: 'save', payload: collectFormData() });
    });

    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    // Ctrl+Enter to save
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (validate()) {
          vscode.postMessage({ type: 'save', payload: collectFormData() });
        }
      }
      if (e.key === 'Escape') {
        vscode.postMessage({ type: 'cancel' });
      }
    });
  </script>
</body>
</html>`;
  }
}

// ─── Utility helpers ───

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str: string): string {
  return escHtml(str).replace(/'/g, '&#39;');
}

function strOrUndef(val: unknown): string | undefined {
  const s = String(val || '').trim();
  return s || undefined;
}

function parseLines(val: unknown): string[] | undefined {
  const raw = String(val || '').trim();
  if (!raw) { return undefined; }
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

function parseEnv(val: unknown): Record<string, string> | undefined {
  const raw = String(val || '').trim();
  if (!raw) { return undefined; }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) { continue; }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) { env[key] = value; }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
