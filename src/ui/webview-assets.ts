// ─── Webview assets — loading compiled scripts into a panel ──────────────────
//
// Every webview in this extension used to carry its JavaScript inside a template
// literal, where the compiler never parsed it. Those scripts now compile to
// out/webview/*.js and are loaded with <script src>, which needs three things at
// every call site: a URI the webview will accept, a nonce, and a CSP that admits
// exactly that nonce. Getting any one of them wrong means a page that silently
// does nothing, so they live here once rather than in six panels.

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Absolute URI of a compiled webview script.
 *
 * Derived from `__dirname` rather than an `extensionUri` passed down through
 * every panel: this module compiles to `out/ui/`, so the sibling `out/webview/`
 * is one hop away. That keeps panels that never needed the extension URI from
 * having to accept one just to load their own script.
 *
 * The extension's own directory is inside the default `localResourceRoots`, so
 * no panel has to opt in for this to resolve.
 */
export function webviewScriptUri(webview: vscode.Webview, name: string): vscode.Uri {
  return webview.asWebviewUri(
    vscode.Uri.file(path.join(__dirname, '..', 'webview', `${name}.js`)),
  );
}

/**
 * A fresh nonce per render.
 *
 * The CSP admits only the script carrying this value, so a tag injected into the
 * page — through a task name, a rule body, anything rendered — cannot execute.
 */
export function webviewNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * The Content-Security-Policy meta tag for a panel.
 *
 * `default-src 'none'` then opens only what a webview actually needs. Styles keep
 * `unsafe-inline` because the design tokens are injected as a <style> block; the
 * scripts, which are the part that matters, are nonce-gated.
 */
export function webviewCsp(webview: vscode.Webview, nonce: string): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none';`,
    `  img-src ${webview.cspSource} data: https:;`,
    `  style-src ${webview.cspSource} 'unsafe-inline';`,
    `  font-src ${webview.cspSource};`,
    `  script-src 'nonce-${nonce}';">`,
  ].join('\n');
}
