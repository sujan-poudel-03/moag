// ─── Theme shim for the browser ───
//
// The `--ds-*` design tokens (`src/ui/design-system.ts`) resolve to `--vscode-*`
// theme variables, which VS Code injects into webviews but a plain browser
// never defines — so most tokens would compute to empty. This block supplies
// the base `--vscode-*` values (VS Code Dark+ by default, Light+ under
// `prefers-color-scheme: light`). It defines NO `--ds-*` token: the token set
// stays closed and owned by the design system.

/** Base `--vscode-*` values for one colour scheme. */
interface ThemeValues {
  'editor-background': string;
  'editor-foreground': string;
  descriptionForeground: string;
  'editorWidget-background': string;
  'panel-border': string;
  'list-hoverBackground': string;
  focusBorder: string;
  'input-background': string;
  'input-foreground': string;
  'input-border': string;
  'button-background': string;
  'button-foreground': string;
  'button-hoverBackground': string;
  'button-secondaryBackground': string;
  'button-secondaryForeground': string;
  'testing-iconPassed': string;
  'testing-iconFailed': string;
  'editorWarning-foreground': string;
  'textLink-foreground': string;
}

const DARK: ThemeValues = {
  'editor-background': '#1e1e1e',
  'editor-foreground': '#d4d4d4',
  descriptionForeground: '#a0a0a0',
  'editorWidget-background': '#252526',
  'panel-border': '#3c3c3c',
  'list-hoverBackground': '#2a2d2e',
  focusBorder: '#007fd4',
  'input-background': '#3c3c3c',
  'input-foreground': '#cccccc',
  'input-border': '#3c3c3c',
  'button-background': '#0e639c',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#1177bb',
  'button-secondaryBackground': '#3a3d41',
  'button-secondaryForeground': '#ffffff',
  'testing-iconPassed': '#73c991',
  'testing-iconFailed': '#f14c4c',
  'editorWarning-foreground': '#cca700',
  'textLink-foreground': '#3794ff',
};

const LIGHT: ThemeValues = {
  'editor-background': '#ffffff',
  'editor-foreground': '#1f1f1f',
  descriptionForeground: '#6a6a6a',
  'editorWidget-background': '#f3f3f3',
  'panel-border': '#d4d4d4',
  'list-hoverBackground': '#e8e8e8',
  focusBorder: '#0090f1',
  'input-background': '#ffffff',
  'input-foreground': '#1f1f1f',
  'input-border': '#cecece',
  'button-background': '#007acc',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#0062a3',
  'button-secondaryBackground': '#e5e5e5',
  'button-secondaryForeground': '#1f1f1f',
  'testing-iconPassed': '#388a34',
  'testing-iconFailed': '#e51400',
  'editorWarning-foreground': '#bf8803',
  'textLink-foreground': '#006ab1',
};

function block(values: ThemeValues): string {
  return Object.entries(values).map(([k, v]) => `      --vscode-${k}: ${v};`).join('\n');
}

/**
 * CSS defining every `--vscode-*` variable the design tokens read, so no
 * `--ds-*` token computes to empty in a browser. Prepend it to
 * `designSystemCssTokens()`.
 */
export function themeShimCss(): string {
  return /* css */ `
    :root {
      color-scheme: dark light;
      --vscode-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      --vscode-font-size: 13px;
      --vscode-editor-font-family: Consolas, Menlo, monospace;
${block(DARK)}
    }
    @media (prefers-color-scheme: light) {
      :root {
${block(LIGHT)}
      }
    }
  `;
}
