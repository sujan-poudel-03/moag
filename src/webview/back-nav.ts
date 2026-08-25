// ─── back-nav webview script ──────────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.back-nav.json and loaded
// with <script src>. Lifted from src/ui/execution-detail-panel.ts, where it lived inside a
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
(function() {
  const vscode = acquireVsCodeApi();
  document.getElementById('btnBack').addEventListener('click', () => {
    vscode.postMessage({ type: 'navigate-back' });
  });
})();
