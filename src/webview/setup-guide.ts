// ─── setup-guide webview script ───────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.setup-guide.json and loaded
// with <script src>. Lifted from src/ui/setup-guide.ts, where it lived inside a
// template literal the compiler never parsed.

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
document.getElementById('recheckBtn').addEventListener('click', function() {
  vscode.postMessage({ type: 'recheck' });
});
document.getElementById('doneBtn').addEventListener('click', function() {
  vscode.postMessage({ type: 'done' });
});
