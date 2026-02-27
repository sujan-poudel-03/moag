// ─── Prompt Input View — sidebar webview with textarea + Run button ───

import * as vscode from 'vscode';

export class PromptInputViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentTaskPlayer.promptView';

  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _onSubmit: (prompt: string) => Promise<void>,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'submit' && message.text?.trim()) {
        this.setBusy(true);
        try {
          await this._onSubmit(message.text.trim());
        } finally {
          this.setBusy(false);
          this.clear();
        }
      }
    });
  }

  /** Disable input while a task is running */
  setBusy(busy: boolean): void {
    this._view?.webview.postMessage({ type: 'setBusy', busy });
  }

  /** Clear the textarea */
  clear(): void {
    this._view?.webview.postMessage({ type: 'clear' });
  }

  private _getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
    }
    .container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    textarea {
      width: 100%;
      min-height: 60px;
      max-height: 200px;
      resize: vertical;
      padding: 6px 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 2px;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    textarea:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button {
      width: 100%;
      padding: 4px 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: right;
    }
  </style>
</head>
<body>
  <div class="container">
    <textarea id="prompt" placeholder="Describe a task for the AI agent..." rows="3"></textarea>
    <button id="run" type="button">Run</button>
    <div class="hint">Ctrl+Enter to submit</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('prompt');
    const btn = document.getElementById('run');

    function submit() {
      const text = textarea.value.trim();
      if (!text || btn.disabled) return;
      vscode.postMessage({ type: 'submit', text });
    }

    btn.addEventListener('click', submit);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'setBusy') {
        textarea.disabled = msg.busy;
        btn.disabled = msg.busy;
        btn.textContent = msg.busy ? 'Running...' : 'Run';
      } else if (msg.type === 'clear') {
        textarea.value = '';
      }
    });
  </script>
</body>
</html>`;
  }
}
