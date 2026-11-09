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

/** Post `type` when the button with `id` is clicked (a button the host left out is skipped). */
function onClick(id: string, type: string): void {
  const btn = document.getElementById(id);
  if (btn) { btn.addEventListener('click', function() { vscode.postMessage({ type }); }); }
}

onClick('recheckBtn', 'recheck');
onClick('doneBtn', 'done');
onClick('setAnthropicKeyBtn', 'setAnthropicKey');
onClick('connectOnosooBtn', 'connectOnosoo');
