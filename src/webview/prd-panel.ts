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
const MOAG_PRD: { versions: any[]; prefill: string; hasPlan?: boolean } = JSON.parse(
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
let prdDiff = document.getElementById('prdDiff');
let prdDiffSummary = document.getElementById('prdDiffSummary');
let prdDiffList = document.getElementById('prdDiffList');
let bumpOverrideLabel = document.getElementById('bumpOverrideLabel');
let bumpOverride = document.getElementById('bumpOverride');
let deltaBtn = document.getElementById('deltaBtn');
let versions = MOAG_PRD.versions || [];
let sourceIssue = null;

/** Display form of a version label — the host computes labels, the page only shows them. */
function fmt(l: string): string { return l.startsWith('v') || l.startsWith('V') ? l : 'v' + l; }
/** Requirement tags removed, trimmed — mirrors stripRequirementTags on the host. */
function stripTags(s: string): string { return s.replace(/\[R-\d+\][ \t]?/g, '').trim(); }
function updateSaveBtn() {
  let last = versions.length > 0 ? versions[versions.length - 1] : null;
  let current = stripTags(ta.value);
  versionSaveBtn.disabled = current.length === 0 || (last !== null && current === stripTags(last.text || ''));
}

function updateCount() {
  let len = ta.value.length;
  charCount.textContent = len + ' chars';
  generateBtn.disabled = len < 20;
}
function updateAiBtn() {
  aiBtn.textContent = ta.value.trim().length > 20 ? '\\u2728 Improve with AI' : '\\u2728 Draft with AI';
}
function renderVersionBar() {
  if (versions.length > 0 || MOAG_PRD.hasPlan) {
    versionBar.classList.add('visible');
    while (versionSelect.firstChild) { versionSelect.removeChild(versionSelect.firstChild); }
    versions.forEach(function(v) {
      let opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = fmt(String(v.version)) + ' (' + new Date(v.createdAt).toLocaleDateString() + ')';
      versionSelect.appendChild(opt);
    });
    versionSelect.style.display = versions.length > 0 ? '' : 'none';
    versionSaveBtn.textContent = 'Save new version';
  } else {
    versionBar.classList.remove('visible');
  }
  updateSaveBtn();
}

/** One line of the requirement diff, as text only — PRD text never reaches innerHTML. */
function diffItem(kind: string, text: string) {
  let li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  prdDiffList.appendChild(li);
}

function renderSaveResult(data: any) {
  while (prdDiffList.firstChild) { prdDiffList.removeChild(prdDiffList.firstChild); }
  let summary = data.notice || data.rationale || '';
  prdDiffSummary.textContent = summary;
  let diff = data.diff;
  if (diff) {
    (diff.added || []).forEach(function(a: any) { diffItem('added', '+ ' + a.id + ' (added) ' + a.text); });
    (diff.changed || []).forEach(function(c: any) {
      diffItem('changed', '~ ' + c.id + ' (changed) ' + c.before + ' → ' + c.after);
    });
    (diff.removed || []).forEach(function(r: any) { diffItem('removed', '− ' + r.id + ' (removed) ' + r.text); });
  }
  bumpOverrideLabel.hidden = !data.canOverride;
  if (data.canOverride && data.chosenBump) { bumpOverride.value = data.chosenBump; }
  deltaBtn.hidden = !data.canGenerateDelta;
  deltaBtn.disabled = false;
  prdDiff.hidden = !(summary || (diff && prdDiffList.firstChild));
}

renderVersionBar();

ta.value = MOAG_PRD.prefill;
updateCount();
updateAiBtn();
updateSaveBtn();

ta.addEventListener('input', function() { updateCount(); updateAiBtn(); updateSaveBtn(); });

versionSelect.addEventListener('change', function() {
  let ver = versions.find(function(v) { return v.version === versionSelect.value; });
  if (ver) { ta.value = ver.text; updateCount(); updateAiBtn(); updateSaveBtn(); }
});

versionSaveBtn.addEventListener('click', function() {
  let text = ta.value.trim();
  if (!text) { return; }
  vscode.postMessage({ type: 'savePrdVersion', text: text });
});

bumpOverride.addEventListener('change', function() {
  vscode.postMessage({ type: 'overridePrdVersionBump', bump: bumpOverride.value });
});

deltaBtn.addEventListener('click', function() {
  // One request per saved version: re-enabled by the next prdVersionSaved.
  deltaBtn.disabled = true;
  vscode.postMessage({ type: 'generateDeltaPlan', text: ta.value.trim() });
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
    if (typeof e.data.text === 'string' && e.data.text) {
      ta.value = e.data.text; updateCount(); updateAiBtn();
    }
    versions = e.data.versions || versions;
    renderVersionBar();
    if (e.data.version) { versionSelect.value = e.data.version; }
    renderSaveResult(e.data);
  }
});

ta.focus();
