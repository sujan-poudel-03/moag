// ─── report-panel webview script ────────────────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.report-panel.json and
// loaded with <script src>. Lifted from ui/self-reporting.ts, where it lived
// inside a template literal the compiler never parsed.
//
// Two steps: compose (description) → preview (the exact, redacted title and
// body, set through textContent) → Post publicly / Copy / Cancel.

/** Provided by the VS Code webview runtime. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- declaration merging
interface Document {
  getElementById(elementId: string): any;
}
const vscode = acquireVsCodeApi();
const desc = document.getElementById('desc');
const fileBtn = document.getElementById('fileBtn');
const postBtn = document.getElementById('postBtn');

/** Show the preview step with this title and body (text only, never HTML). */
function showPreview(title: string, body: string): void {
  document.getElementById('previewTitle').textContent = title;
  document.getElementById('preview').textContent = body;
  document.getElementById('composeStep').hidden = true;
  document.getElementById('composeButtons').hidden = true;
  document.getElementById('previewStep').hidden = false;
  document.getElementById('previewButtons').hidden = false;
  postBtn.disabled = false;
  postBtn.focus();
}

fileBtn.addEventListener('click', function() {
  fileBtn.disabled = true;
  fileBtn.textContent = 'Preparing…';
  vscode.postMessage({ type: 'submitReport', description: desc.value.trim() });
});
postBtn.addEventListener('click', function() {
  postBtn.disabled = true;
  postBtn.textContent = 'Posting…';
  vscode.postMessage({ type: 'confirmPost' });
});
document.getElementById('copyBtn').addEventListener('click', function() {
  vscode.postMessage({ type: 'copy' });
});
document.getElementById('cancelBtn').addEventListener('click', function() {
  vscode.postMessage({ type: 'cancel' });
});

window.addEventListener('message', function(event: MessageEvent) {
  const msg = event.data as { type?: string; title?: unknown; body?: unknown } | null;
  if (!msg || msg.type !== 'preview') { return; }
  showPreview(String(msg.title ?? ''), String(msg.body ?? ''));
});

// A panel opened on a ready draft (self-issues) carries it as inert JSON.
const draftText = (document.getElementById('draft')?.textContent ?? '').trim();
if (draftText) {
  try {
    const draft = JSON.parse(draftText) as { title?: unknown; body?: unknown };
    showPreview(String(draft.title ?? ''), String(draft.body ?? ''));
  } catch { /* malformed draft: stay on compose */ }
} else {
  desc.focus();
}
