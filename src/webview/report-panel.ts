// ─── report-panel webview script ────────────────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.report-panel.json and
// loaded with <script src>. Lifted from ui/self-reporting.ts, where it lived
// inside a template literal the compiler never parsed.

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
fileBtn.addEventListener('click', function() {
  fileBtn.disabled = true;
  fileBtn.textContent = 'Filing\u2026';
  vscode.postMessage({ type: 'submitReport', description: desc.value.trim() });
});
desc.focus();
