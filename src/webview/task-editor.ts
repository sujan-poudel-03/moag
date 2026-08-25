// ─── task-editor webview script ───────────────────────────────────────
//
// Runs in the webview, not the extension host. Compiled by
// tsconfig.webview.task-editor.json and loaded with <script src>. It used to live
// inside a template literal, where the compiler never parsed it.

/** Provided by the VS Code webview runtime. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// Declaration merging rather than a cast at every call site — see webview/sidebar.ts.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the compiler uses this; eslint cannot see declaration merging
interface Document {
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}
const vscode = acquireVsCodeApi();

// Called from an inline onclick=/onchange= attribute in the host HTML. eslint
// cannot see that, and it must stay global for the handler to resolve it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toggleSection(header) {
  header.classList.toggle('collapsed');
  const body = header.nextElementSibling;
  body.classList.toggle('hidden');
}

// Called from an inline onclick=/onchange= attribute in the host HTML. eslint
// cannot see that, and it must stay global for the handler to resolve it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onTypeChange() {
  const type = document.getElementById('type').value;
  // manual tasks have no command field — hide it to avoid confusion
  document.getElementById('sectionCommand').style.display = (type !== 'agent' && type !== 'manual') ? 'block' : 'none';
  document.getElementById('sectionService').style.display = type === 'service' ? 'block' : 'none';

  // Update prompt hint
  const hint = document.getElementById('promptHint');
  if (type === 'agent') { hint.textContent = '(required for agent tasks)'; }
  else if (type === 'manual') { hint.textContent = '(instructions shown to the user in the "Mark Complete" notification)'; }
  else { hint.textContent = '(optional description)'; }
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

  // Command required for command/service/check — not for agent or manual
  const cmdErr = document.getElementById('commandError');
  if (type !== 'agent' && type !== 'manual' && !command) { cmdErr.classList.add('visible'); valid = false; }
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
