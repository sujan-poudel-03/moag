// ─── Project Rulebook: the sections of a standards profile beyond structure and style ───
//
// Seven optional parts of the same approved, versioned profile: coding practice, testing,
// security, accessibility, API and data, docs and git, performance. Each holds the few
// settings MOAG can check reliably (a TODO cites an issue, no `.env` is committed, a
// committed migration is never edited, …) and GUIDANCE: one-line rules that every agent
// prompt carries and a reviewer approves, but that nothing checks — labelled so everywhere.
//
// Each section is ABSENT — never empty — on a profile that does not have it, so every
// profile written before the rulebook keeps its content hash and renders the same prompt.
//
// Free of VS Code API imports and of the runner. Type-only import of the profile module, so
// there is no runtime cycle: profile.ts imports this module, not the other way round.

import type { StackId } from '../shared/stacks';
import type { StandardsProfile } from './profile';

// ─── Shape ───

/** The rulebook sections, in the order they are rendered, edited and compared. */
export const RULEBOOK_KEYS = ['practice', 'testPolicy', 'security', 'accessibility', 'apiData', 'docsGit', 'performance'] as const;
export type RulebookKey = typeof RULEBOOK_KEYS[number];

/** The rulebook parts of a standards profile. Every section is optional; every field in one is required. */
export interface RulebookSections {
  /** Senior coding practice. */
  practice?: { todoNeedsIssue: boolean; noDebugStatements: boolean; guidance: string[] };
  /** Testing strategy beyond the runner and test-file globs of `testing`. */
  testPolicy?: { requirementReference: boolean; guidance: string[] };
  /** Security. No `.env` file and no credential-shaped value are checked on every run, whatever this holds. */
  security?: { guidance: string[] };
  /** Accessibility minimums; goes with a design system or a component kit. */
  accessibility?: { imgAlt: boolean; htmlLang: boolean; guidance: string[] };
  /** API and data conventions. `migrationsGlob` '' = migrations not checked. */
  apiData?: { migrationsGlob: string; guidance: string[] };
  /** Docs and git. `changelogPath` '' = the changelog not checked. */
  docsGit?: { changelogPath: string; guidance: string[] };
  /** Performance budgets: checked only by a command; here, guidance. */
  performance?: { guidance: string[] };
}

/** Most guidance entries one section holds. Each is one line of at most 200 characters. */
export const MAX_RULEBOOK_GUIDANCE_ENTRIES = 12;

/** Appended to every guidance heading, in the prompt and on screen: nothing checks it. */
export const GUIDANCE_SUFFIX = '(guidance — not checked)';

/** How each section is titled to a reader and in the prompt. */
export const RULEBOOK_TITLES: Readonly<Record<RulebookKey, string>> = Object.freeze({
  practice: 'Coding practice',
  testPolicy: 'Testing',
  security: 'Security',
  accessibility: 'Accessibility',
  apiData: 'API and data',
  docsGit: 'Docs and git',
  performance: 'Performance',
});

/** Longest line the planner summary gives one section. */
export const PLANNER_SUMMARY_LINE_CHARS = 160;

// ─── Rendering ───

/**
 * The checked items each present section configures, one fixed sentence each, in section
 * order; sections with none are left out. The security lines (no `.env` file, no credential)
 * appear whenever the profile has a security section — those checks run on every profile,
 * but a profile without the section says nothing new in its prompt.
 */
export function checkedLines(profile: StandardsProfile): Array<{ key: RulebookKey; lines: string[] }> {
  const out: Array<{ key: RulebookKey; lines: string[] }> = [];
  const push = (key: RulebookKey, lines: Array<string | null>): void => {
    const kept = lines.filter((l): l is string => l !== null);
    if (kept.length > 0) { out.push({ key, lines: kept }); }
  };
  const p = profile;
  if (p.practice) {
    push('practice', [
      p.practice.todoNeedsIssue ? '- Every TODO or FIXME comment cites an issue (#123, ABC-123 or a link)' : null,
      p.practice.noDebugStatements ? '- Leave no debugger statement or breakpoint() call in the code' : null,
    ]);
  }
  if (p.testPolicy) {
    push('testPolicy', [p.testPolicy.requirementReference ? '- Name every requirement id (R-1, R-2, …) in at least one test file that covers it' : null]);
  }
  if (p.security) {
    push('security', [
      '- Never add a .env file to the repository; a .env.example with placeholder values is fine',
      '- Never put a credential-shaped value (API key, token, private key) on any line of code or config',
    ]);
  }
  if (p.accessibility) {
    push('accessibility', [
      p.accessibility.imgAlt ? '- Every <img> in an HTML page has an alt attribute' : null,
      p.accessibility.htmlLang ? '- Every HTML page declares its language: <html lang="…">' : null,
    ]);
  }
  if (p.apiData) {
    push('apiData', [p.apiData.migrationsGlob ? `- Never edit or delete a committed migration (${p.apiData.migrationsGlob}); add a new one` : null]);
  }
  if (p.docsGit) {
    push('docsGit', [p.docsGit.changelogPath ? `- Record every change in ${p.docsGit.changelogPath}` : null]);
  }
  return out;
}

/** Every guidance entry of every present section, in section order. */
export function guidanceItems(profile: StandardsProfile): Array<{ key: RulebookKey; text: string }> {
  const out: Array<{ key: RulebookKey; text: string }> = [];
  for (const key of RULEBOOK_KEYS) {
    for (const text of profile[key]?.guidance ?? []) { out.push({ key, text }); }
  }
  return out;
}

/** `text` cut to `max` characters with an ellipsis when longer. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One line per present section for the planning prompt: its title and its guidance, joined,
 * cut to {@link PLANNER_SUMMARY_LINE_CHARS}. The planner plans; the full guidance reaches
 * every task prompt.
 */
export function plannerSummaryLines(profile: StandardsProfile): string[] {
  return RULEBOOK_KEYS.filter((key) => profile[key] !== undefined).map((key) => {
    const guidance = profile[key]?.guidance ?? [];
    return clip(`- ${RULEBOOK_TITLES[key]}: ${guidance.length > 0 ? guidance.join('; ') : 'no guidance'}`, PLANNER_SUMMARY_LINE_CHARS);
  });
}

/** True when `profile` has at least one rulebook section. */
export function hasRulebook(profile: StandardsProfile): boolean {
  return RULEBOOK_KEYS.some((key) => profile[key] !== undefined);
}

// ─── Per-stack defaults ───
//
// Deterministic starting points, proposed with the stack's built-in profile and approved by a
// reviewer like the rest. What MOAG can check is switched on where it applies to the stack:
// TODO/FIXME cite an issue (every stack), no debugger statement (stacks the check reads), each
// requirement named in a test (every stack with a test layout), HTML language and image alt
// text (static-web, whose pages are HTML). The migrations folder and the changelog path start
// empty — a brownfield proposal fills them from what the repository tracks. Everything else
// is guidance: one line each, shown to agents and the reviewer, labelled "not checked".
// The dependency audit a stack has is named as guidance, never added as a command: a command
// blocks, needs the network, and is the project's own decision to add.

/** The stack-specific line of each guidance list, where a stack has one. */
interface StackNotes {
  typing: string;
  testCommand: string;
  audit: string;
  performance: string[];
  /** False for a stack without an API or a schema (a static site): no API and data section. */
  apiData: boolean;
}

const STACK_NOTES: Readonly<Record<StackId, StackNotes>> = {
  'node-ts': {
    typing: 'Strict types: no any; no unexplained non-null assertion',
    testCommand: 'npm test',
    audit: 'Run npm audit --audit-level=high when dependencies change, and fix what it reports',
    performance: ['No N+1 queries; paginate lists', 'Lean bundles; lazy-load large routes'],
    apiData: true,
  },
  python: {
    typing: 'Give every public function type hints; keep mypy or pyright clean where configured',
    testCommand: 'pytest',
    audit: 'Run pip-audit when dependencies change, and fix what it reports',
    performance: ['No N+1 queries; paginate lists', 'Stream large files instead of loading them whole'],
    apiData: true,
  },
  go: {
    typing: 'Return errors with context (fmt.Errorf("…: %w", err)); never panic in library code',
    testCommand: 'go test ./...',
    audit: 'Run govulncheck ./... when dependencies change, and fix what it reports',
    performance: ['No N+1 queries; paginate lists', 'Bound goroutine pools; close every response body'],
    apiData: true,
  },
  java: {
    typing: 'Prefer immutable types; return Optional, never null, for a value that may be absent',
    testCommand: 'the build\'s test task',
    audit: 'Check a new dependency for known vulnerabilities (OWASP dependency-check) before adding it',
    performance: ['No N+1 queries; paginate lists', 'Close resources with try-with-resources'],
    apiData: true,
  },
  dotnet: {
    typing: 'Keep nullable reference types enabled and the build free of warnings',
    testCommand: 'dotnet test',
    audit: 'Run dotnet list package --vulnerable when packages change, and fix what it reports',
    performance: ['No N+1 queries; paginate lists', 'Async I/O end to end; dispose resources with using'],
    apiData: true,
  },
  'static-web': {
    typing: 'Use const and let, never var; keep scripts as ES modules',
    testCommand: 'the page tests',
    audit: 'Load third-party scripts only at pinned versions, with Subresource Integrity',
    performance: ['Compress images; defer non-critical scripts', 'Load only the CSS a page uses'],
    apiData: false,
  },
  other: {
    typing: 'Follow the language\'s strictest common type and lint settings',
    testCommand: 'the project\'s test command',
    audit: 'Check a new dependency for known vulnerabilities before adding it',
    performance: [],
    apiData: false,
  },
};

/** Stacks whose added lines the debugger check reads (JS family and Python). */
const DEBUG_CHECKED_STACKS: readonly StackId[] = ['node-ts', 'python', 'static-web'];

function practiceDefaults(stack: StackId): NonNullable<RulebookSections['practice']> {
  return {
    todoNeedsIssue: true,
    noDebugStatements: DEBUG_CHECKED_STACKS.includes(stack),
    guidance: [
      'Never swallow an error; rethrow with context; log via the project logger',
      'No placeholder, stub, dead code or stray print/console output',
      STACK_NOTES[stack].typing,
    ],
  };
}

function securityDefaults(stack: StackId): NonNullable<RulebookSections['security']> {
  return {
    guidance: [
      'Validate input at the boundary; no SQL, shell or HTML from raw input; never log secrets',
      STACK_NOTES[stack].audit,
    ],
  };
}

/** The accessibility section: checked in HTML pages for a static site, guidance elsewhere. */
export function accessibilityDefaults(stack: StackId): NonNullable<RulebookSections['accessibility']> {
  const html = stack === 'static-web';
  return {
    imgAlt: html,
    htmlLang: html,
    guidance: [
      'Keyboard access with visible focus; a label on every field',
      'WCAG AA contrast; never colour alone; use the design system',
    ],
  };
}

/** The rulebook sections each stack's built-in profile starts with. */
export function rulebookDefaults(stack: StackId): RulebookSections {
  const notes = STACK_NOTES[stack];
  if (stack === 'other') { return { practice: practiceDefaults(stack), security: securityDefaults(stack) }; }
  return {
    practice: practiceDefaults(stack),
    testPolicy: {
      // Off by default: the check before the ship gate is not given requirement ids yet
      // (deferred D1), so switched on it would read "not checked" on every hosted gate.
      requirementReference: false,
      guidance: [
        'Test every requirement and its failure path; never skip a failing test',
        `Run ${notes.testCommand} before finishing; no real network or clock in tests`,
      ],
    },
    security: securityDefaults(stack),
    ...(stack === 'static-web' ? { accessibility: accessibilityDefaults(stack) } : {}),
    ...(notes.apiData ? {
      apiData: {
        migrationsGlob: '',
        guidance: [
          'Config from the environment; document each setting in .env.example',
          'One API error shape, right HTTP status; schema changes only by migration',
        ],
      },
    } : {}),
    docsGit: {
      changelogPath: '',
      guidance: [
        'Keep the README current: install, configure, run and test',
        'Changelog entry per version; commits: imperative summary, then why',
      ],
    },
    ...(notes.performance.length > 0 ? { performance: { guidance: [...notes.performance] } } : {}),
  };
}

/**
 * The rulebook sections `profile` lacks that its stack's defaults would give it, plus the
 * accessibility section when the profile has a user interface (a design system or a
 * component kit). Empty when it lacks none. A proposal adds these; a person approves them.
 */
export function rulebookAdditions(stack: StackId, profile: StandardsProfile): RulebookSections {
  const defaults: RulebookSections = rulebookDefaults(stack);
  if (profile.design || profile.frontend.componentKit) { defaults.accessibility = defaults.accessibility ?? accessibilityDefaults(stack); }
  const out: RulebookSections = {};
  for (const key of RULEBOOK_KEYS) {
    if (profile[key] === undefined && defaults[key] !== undefined) { Object.assign(out, { [key]: defaults[key] }); }
  }
  return out;
}
