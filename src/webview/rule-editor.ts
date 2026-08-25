// ─── rule-editor webview script ───────────────────────────────────────
//
// Runs in the webview, not the extension host. Compiled by
// tsconfig.webview.rule-editor.json and loaded with <script src>. It used to live
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
const nameEl = document.getElementById('name');
const categoryEl = document.getElementById('category');
const textEl = document.getElementById('text');
const charCountEl = document.getElementById('charCount');
const previewEl = document.getElementById('preview');
const saveEl = document.getElementById('saveBtn');
const cancelEl = document.getElementById('cancelBtn');


function updatePreview() {
  const n = nameEl.value.trim() || '(name)';
  const t = textEl.value.trim() || '(rule text)';
  previewEl.textContent = '### ' + n + '\\n' + t;
  charCountEl.textContent = textEl.value.length + ' characters';
}

function validate() {
  const ok = !!nameEl.value.trim() && !!textEl.value.trim();
  saveEl.disabled = !ok;
}

nameEl.addEventListener('input', () => { updatePreview(); validate(); });
textEl.addEventListener('input', () => { updatePreview(); validate(); });
validate();

cancelEl.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
saveEl.addEventListener('click', () => {
  const scope = document.querySelector('input[name="scope"]:checked')?.value || 'global';
  vscode.postMessage({
    type: 'save',
    payload: {
      name: nameEl.value.trim(),
      category: categoryEl.value,
      scope,
      text: textEl.value.trim(),
    },
  });
});
