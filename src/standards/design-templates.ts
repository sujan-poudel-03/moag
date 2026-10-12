// ─── Design system templates ───
//
// The fixed drafts MOAG proposes for a project with a user interface: one tokens file and
// one DESIGN.md per stack. Deterministic on purpose — the same stack and component kit
// always draft the same bytes, no model is asked, and a reviewer approves the result
// before any agent builds against it.
//
// Pure text: no `fs`, no `vscode`.

/**
 * The tokens file every template proposes: one `:root` block of CSS custom properties, no
 * comments. Text colours reach at least 4.5:1 on `--color-bg`; `--color-primary-fg` is the
 * text colour on `--color-primary` and reaches it there.
 */
export const TOKENS_CSS = [
  ':root {',
  '  --color-bg: #ffffff;',
  '  --color-surface: #f6f8fa;',
  '  --color-border: #d0d7de;',
  '  --color-fg: #1f2328;',
  '  --color-muted: #59636e;',
  '  --color-primary: #0969da;',
  '  --color-primary-fg: #ffffff;',
  '  --color-success: #1a7f37;',
  '  --color-warning: #9a6700;',
  '  --color-error: #cf222e;',
  '  --color-focus: #0969da;',
  '  --font-family-base: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
  '  --font-family-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
  '  --font-size-sm: 0.875rem;',
  '  --font-size-base: 1rem;',
  '  --font-size-lg: 1.125rem;',
  '  --font-size-xl: 1.25rem;',
  '  --font-size-2xl: 1.5rem;',
  '  --font-weight-regular: 400;',
  '  --font-weight-semibold: 600;',
  '  --line-height-base: 1.5;',
  '  --space-1: 0.25rem;',
  '  --space-2: 0.5rem;',
  '  --space-3: 0.75rem;',
  '  --space-4: 1rem;',
  '  --space-5: 1.5rem;',
  '  --space-6: 2rem;',
  '  --space-7: 3rem;',
  '  --space-8: 4rem;',
  '  --radius-sm: 0.25rem;',
  '  --radius-md: 0.375rem;',
  '  --radius-lg: 0.5rem;',
  '  --radius-full: 9999px;',
  '  --shadow-sm: 0 1px 2px rgba(31, 35, 40, 0.12);',
  '  --focus-ring: 0 0 0 3px rgba(9, 105, 218, 0.4);',
  '}',
  '',
].join('\n');

/** The text colours of {@link TOKENS_CSS}: each must reach 4.5:1 on `--color-bg`. */
export const TEMPLATE_TEXT_COLOUR_TOKENS = [
  '--color-fg', '--color-muted', '--color-primary', '--color-success', '--color-warning', '--color-error',
] as const;

/** How the tokens reach the code, by stack. */
function tokensUsage(stack: string, tokensPath: string): string {
  if (stack === 'static-web') {
    return `Every page links ${tokensPath} before any other stylesheet: \`<link rel="stylesheet" href="${tokensPath}">\`.`;
  }
  return `The app entry imports ${tokensPath} once, before any other stylesheet. Components read tokens through \`var(--name)\` in CSS, never by copying a value.`;
}

/** The component paragraph: the approved kit when there is one, plain elements otherwise. */
function componentsSection(kit: string): string[] {
  if (kit) {
    return [
      `The approved component kit is ${kit}. Build screens from its components; do not add another UI kit or hand-roll a control the kit already has.`,
      `- Theme ${kit} from the tokens: its palette, type scale, spacing and radii map onto the tokens file, so a component never carries a value of its own.`,
      '- Wrap a kit component in a project component only to fix a project-wide default; name the wrapper after what it is for.',
      '- One primary button per screen, for the one main action. Every other action is secondary or a link.',
    ];
  }
  return [
    'There is no component kit. Build screens from semantic HTML elements styled with the tokens.',
    '- Use the native element for the job: `button` for actions, `a` for navigation, `label` + `input` for fields, `table` for tabular data.',
    '- Keep one shared style per control (button, input, card, table) and reuse it; never restyle a control for one screen.',
    '- One primary button per screen, for the one main action. Every other action is secondary or a link.',
  ];
}

/**
 * The DESIGN.md a template proposes for `stack`, naming `kit` when there is one and pointing
 * at `tokensPath`. Under 6 000 characters; plain text only.
 */
export function designDoc(stack: string, kit: string, tokensPath: string): string {
  return [
    '# Design system',
    '',
    `This document and the tokens file (${tokensPath}) are the approved design system. Every screen is built against them. They change only through a new standards version that a reviewer approves.`,
    '',
    '## Colour palette',
    '',
    'Use colour tokens only; never write a hex, rgb() or hsl() value in a component.',
    '',
    '- `--color-bg` is the page background; `--color-surface` is for cards, panels and table headers.',
    '- `--color-fg` is body text; `--color-muted` is secondary text such as hints and timestamps.',
    '- `--color-primary` is for the one main action and for links; text on it uses `--color-primary-fg`.',
    '- `--color-success`, `--color-warning` and `--color-error` carry status. Pair each with a word or an icon: colour alone never carries meaning.',
    '- `--color-border` separates regions; `--color-focus` and `--focus-ring` mark keyboard focus.',
    '',
    '## Typography',
    '',
    '- Body text uses `--font-family-base` at `--font-size-base` with `--line-height-base`; code and identifiers use `--font-family-mono`.',
    '- Headings step through `--font-size-lg`, `--font-size-xl` and `--font-size-2xl` with `--font-weight-semibold`. One page title per screen.',
    '- `--font-size-sm` is the smallest size; never go below it.',
    '',
    '## Spacing',
    '',
    'Space comes from the scale `--space-1` (0.25rem) to `--space-8` (4rem). Use `--space-2` inside controls, `--space-4` between related items and `--space-6` between sections. No raw pixel or rem values in components.',
    '',
    '## Radii and elevation',
    '',
    '- `--radius-sm` for inputs and tags, `--radius-md` for buttons and cards, `--radius-lg` for dialogs, `--radius-full` for pills and avatars.',
    '- `--shadow-sm` is the only elevation, for menus and dialogs. Cards use a border, not a shadow.',
    '',
    '## Components',
    '',
    ...componentsSection(kit),
    '',
    tokensUsage(stack, tokensPath),
    '',
    '## Page layout',
    '',
    '- Every screen has one page title, then its primary content, then secondary content. Navigation sits in the same place on every screen.',
    '- Content is at most 72rem wide and centred; text columns stay near 70 characters.',
    '- Layouts work from 360px wide upwards with no horizontal page scroll; wide tables scroll inside their own container.',
    '',
    '## States: empty, loading, error',
    '',
    'Every screen and every list handles all three states, and each is designed, not left blank:',
    '',
    '- Empty: say what will appear here and offer the action that creates the first item.',
    '- Loading: keep the layout in place (a skeleton or a short status line); never a blank screen.',
    '- Error: say what failed in plain words, keep what the user typed, and offer a way to retry.',
    '',
    '## Forms',
    '',
    '- Every input has a visible label above it; a placeholder is never the label.',
    '- Mark optional fields, not required ones. Validate on submit and next to the field, and say how to fix the value.',
    '- The submit button names the action ("Save changes", not "Submit") and is disabled only while the request runs.',
    '',
    '## Accessibility',
    '',
    '- Text reaches a contrast of at least 4.5:1 on its background (3:1 for large text and for control borders).',
    '- Every control is reachable and usable by keyboard, in reading order, and focus stays visible (`--focus-ring`).',
    '- Images carry alt text; icon-only buttons carry an accessible name.',
    '- Respect reduced motion: no animation is needed to understand a screen.',
    '',
    '## Writing tone',
    '',
    '- Plain, short and specific. Address the user as "you"; name things the way the user does.',
    '- Buttons start with a verb. Messages say what happened and what to do next; no blame, no jargon, no exclamation marks.',
    '- Use sentence case for titles, labels and buttons.',
    '',
    '## Changing the design system',
    '',
    `Do not edit this file or ${tokensPath} in a task. Propose the change as a new standards version; a reviewer approves it, and every later task builds against the new version.`,
    '',
  ].join('\n');
}
