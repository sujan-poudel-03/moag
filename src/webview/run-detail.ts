// ─── run-detail webview script ──────────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.run-detail.json and loaded
// with <script src>. It used to be returned as a string from a function in
// ui/execution-detail-panel.ts, which is a template literal by another name —
// the compiler never parsed it either way.

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
(function() {
      const vscode = acquireVsCodeApi();

      document.getElementById('btnBack').addEventListener('click', () => {
        vscode.postMessage({ type: 'navigate-back' });
      });

      const btnDeleteRun = document.getElementById('btnDeleteRun');
      if (btnDeleteRun) {
        btnDeleteRun.addEventListener('click', () => {
          const runId = btnDeleteRun.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'delete-run', runId });
          }
        });
      }
    })();
