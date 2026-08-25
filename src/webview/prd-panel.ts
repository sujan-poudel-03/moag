// ─── PRD panel webview script ───────────────────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.prd-panel.json and loaded
// with <script src>. It used to live inside a template literal in
// ui/prd-authoring.ts, where the compiler never parsed it.
//
// The two values the host used to interpolate now arrive as a JSON block the
// page carries as DATA — no executable text is inlined.

/** Provided by the VS Code webview runtime. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- declaration merging
interface Document {
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}

/** Values the host hands the page as data, read once at startup. */
const MOAG_PRD: { versions: any[]; prefill: string } = JSON.parse(
  document.getElementById('moag-prd-bootstrap')?.textContent || '{}',
);
let vscode = acquireVsCodeApi();
let ta = document.getElementById('prd');
let charCount = document.getElementById('charCount');
let generateBtn = document.getElementById('generateBtn');
let aiBtn = document.getElementById('aiBtn');
let versionBar = document.getElementById('versionBar');
let versionSelect = document.getElementById('versionSelect');
let versionSaveBtn = document.getElementById('versionSaveBtn');
let versions = MOAG_PRD.versions;
let sourceIssue = null;

function updateCount() {
  let len = ta.value.length;
  charCount.textContent = len + ' chars';
  generateBtn.disabled = len < 20;
}
function updateAiBtn() {
  aiBtn.textContent = ta.value.trim().length > 20 ? '\\u2728 Improve with AI' : '\\u2728 Draft with AI';
}
function renderVersionBar() {
  if (versions.length > 0) {
    versionBar.classList.add('visible');
    versionSelect.innerHTML = versions.map(function(v) {
      let d = new Date(v.createdAt).toLocaleDateString();
      return '<option value="' + v.version + '">' + v.version + ' (' + d + ')</option>';
    }).join('');
    versionSaveBtn.textContent = 'Save as v' + (versions.length + 1) + '.0';
  } else {
    versionBar.classList.remove('visible');
  }
}
renderVersionBar();

ta.value = MOAG_PRD.prefill;
updateCount();
updateAiBtn();

ta.addEventListener('input', function() { updateCount(); updateAiBtn(); });

versionSelect.addEventListener('change', function() {
  let ver = versions.find(function(v) { return v.version === versionSelect.value; });
  if (ver) { ta.value = ver.text; updateCount(); updateAiBtn(); }
});

versionSaveBtn.addEventListener('click', function() {
  let text = ta.value.trim();
  if (!text) { return; }
  let nextVersion = 'v' + (versions.length + 1) + '.0';
  vscode.postMessage({ type: 'savePrdVersion', text: text, version: nextVersion });
});

aiBtn.addEventListener('click', function() {
  let text = ta.value.trim();
  if (text.length > 20) {
    aiBtn.disabled = true;
    aiBtn.textContent = 'Improving\\u2026';
    vscode.postMessage({ type: 'prdAiImprove', text: text });
  } else {
    vscode.postMessage({ type: 'prdAiDraft' });
  }
});

document.getElementById('browseBtn').addEventListener('click', function() {
  vscode.postMessage({ type: 'openPrdFile' });
});

document.getElementById('issueBtn').addEventListener('click', function() {
  vscode.postMessage({ type: 'loadFromGitHubIssue' });
});

document.getElementById('saveBtn').addEventListener('click', function() {
  let text = ta.value.trim();
  if (!text) { return; }
  vscode.postMessage({ type: 'savePrdFile', text: text });
});

document.getElementById('browserBtn').addEventListener('click', function() {
  let text = ta.value.trim();
  if (!text) { return; }
  vscode.postMessage({ type: 'openPrdInBrowser', text: text });
});

generateBtn.addEventListener('click', function() {
  let text = ta.value.trim();
  if (!text) { return; }
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating\\u2026';
  vscode.postMessage({ type: 'generatePlanFromPrd', prdText: text, sourceIssue: sourceIssue });
});

window.addEventListener('message', function(e) {
  if (e.data.type === 'prdFileContent') {
    ta.value = e.data.text || ''; updateCount(); updateAiBtn(); ta.focus();
    sourceIssue = null;
  } else if (e.data.type === 'prdFromIssueLoaded') {
    ta.value = e.data.text || ''; updateCount(); updateAiBtn(); ta.focus();
    sourceIssue = e.data.sourceIssue || null;
  } else if (e.data.type === 'prdAiImproveResult') {
    ta.value = e.data.text || ta.value; updateCount(); updateAiBtn();
    aiBtn.disabled = false; updateAiBtn();
  } else if (e.data.type === 'prdVersionSaved') {
    versions = e.data.versions || versions;
    renderVersionBar();
    if (e.data.version) { versionSelect.value = e.data.version; }
  }
});

ta.focus();
