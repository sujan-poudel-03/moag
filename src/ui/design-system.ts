export function designSystemCssTokens(): string {
  return /* css */ `
    :root {
      --ds-font-family: var(--vscode-font-family);
      --ds-font-size: var(--vscode-font-size);
      --ds-editor-font: var(--vscode-editor-font-family, monospace);

      --ds-bg: var(--vscode-editor-background);
      --ds-surface: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      --ds-fg: var(--vscode-editor-foreground);
      --ds-muted: var(--vscode-descriptionForeground);
      --ds-border: var(--vscode-panel-border, rgba(128,128,128,0.25));
      --ds-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
      --ds-focus: var(--vscode-focusBorder, #007acc);

      --ds-input-bg: var(--vscode-input-background);
      --ds-input-fg: var(--vscode-input-foreground);
      --ds-input-border: var(--vscode-input-border, var(--ds-border));

      --ds-btn-bg: var(--vscode-button-background);
      --ds-btn-fg: var(--vscode-button-foreground);
      --ds-btn-hover: var(--vscode-button-hoverBackground);
      --ds-btn-secondary-bg: var(--vscode-button-secondaryBackground, transparent);
      --ds-btn-secondary-fg: var(--vscode-button-secondaryForeground, var(--ds-fg));

      --ds-success: var(--vscode-testing-iconPassed, #4caf50);
      --ds-warning: var(--vscode-editorWarning-foreground, #cca700);
      --ds-error: var(--vscode-testing-iconFailed, #f44747);
      --ds-info: var(--vscode-textLink-foreground, #4fa3ff);

      --ds-radius-sm: 4px;
      --ds-radius-md: 8px;
      --ds-radius-pill: 999px;

      --ds-space-1: 4px;
      --ds-space-2: 8px;
      --ds-space-3: 12px;
      --ds-space-4: 16px;

      --ds-motion-fast: 120ms;
      --ds-motion-med: 180ms;
    }
  `;
}

