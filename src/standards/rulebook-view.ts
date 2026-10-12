// ─── Project Rulebook: the CHECKED / GUIDANCE view a reviewer reads ───
//
// What the standards screen shows for one version, computed here so the browser holds no
// policy: per rulebook section, which items MOAG checks (a rule it decides, with its
// severity, or one of the profile's commands, which always blocks), which are guidance only
// (shown to agents and the reviewer, never checked — and whether each still fits the prompt),
// and which would be checked once a setting is filled in.
//
// Free of VS Code API imports and of the runner.

import {
  StandardsProfile,
  StandardsRuleId,
  RuleSeverity,
  renderStandardsTextDetailed,
  ruleConfigured,
  ruleSeverity,
} from './profile';
import { RULEBOOK_KEYS, RULEBOOK_TITLES, RulebookKey } from './rulebook';

/** The section each Project Rulebook rule belongs to. Every rulebook rule id is listed. */
export const RULEBOOK_RULE_SECTION: Readonly<Record<string, RulebookKey>> = Object.freeze({
  'practice/todo-without-issue': 'practice',
  'practice/debug-statement': 'practice',
  'testing/requirement-reference': 'testPolicy',
  'security/env-file': 'security',
  'security/secret-literal': 'security',
  'a11y/img-alt': 'accessibility',
  'a11y/html-lang': 'accessibility',
  'data/migration-edited': 'apiData',
  'docs/changelog-updated': 'docsGit',
});

/** Rules checked on every run, whatever the profile holds. */
const ALWAYS_ON: ReadonlySet<string> = new Set(['security/env-file', 'security/secret-literal']);

/** Rules a setting switches on, and what to fill in to switch them on. */
const NOT_YET_CHECKED_HINTS: Readonly<Record<string, string>> = Object.freeze({
  'data/migration-edited': 'Checked once a migrations folder is set.',
  'docs/changelog-updated': 'Checked once a changelog path is set.',
  'testing/requirement-reference': 'Checked once "each requirement is named in a test" is switched on.',
});

/** What each not-yet-checked rule would check, in the reviewer's words. */
const NOT_YET_CHECKED_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'data/migration-edited': 'Committed migrations are never edited or deleted',
  'docs/changelog-updated': 'The changelog is updated in a run that ships a version',
  'testing/requirement-reference': 'Each requirement (R-n) is named in a test file',
});

/** Which section a profile command belongs to, by its label; null for one that belongs to none. */
export function commandSection(label: string): RulebookKey | null {
  // `go vet` is the Go toolchain's own static check of correctness: Coding practice, like a linter.
  if (/^type ?check/i.test(label) || /^lint/i.test(label) || /^vet\b/i.test(label)) { return 'practice'; }
  if (/^test/i.test(label)) { return 'testPolicy'; }
  if (/audit/i.test(label)) { return 'security'; }
  if (/bundle|lighthouse|bench|perf/i.test(label)) { return 'performance'; }
  return null;
}

export type RulebookCheckedItem =
  | { kind: 'rule'; rule: StandardsRuleId; severity: RuleSeverity; alwaysOn?: true }
  | { kind: 'command'; label: string; run: string };

export interface RulebookSectionView {
  key: RulebookKey;
  title: string;
  /** The version has this section. */
  present: boolean;
  /** False for a section that does not apply (accessibility without a user interface): omitted. */
  applicable: boolean;
  checked: RulebookCheckedItem[];
  /** `sent` is false for an item cut to fit the prompt: agents do not receive it. */
  guidance: Array<{ text: string; sent: boolean }>;
  notYetChecked: Array<{ text: string; hint: string }>;
}

export interface RulebookView {
  sections: RulebookSectionView[];
  counts: { checked: number; guidance: number };
}

/**
 * The rulebook of one version, as the standards screen lists it. `version` sizes the prompt
 * the guidance must fit (the same rendering a job file carries).
 */
export function rulebookView(profile: StandardsProfile, version: number | null): RulebookView {
  const cut = new Set(renderStandardsTextDetailed(profile, version).guidanceCut);
  const ui = !!profile.design || !!profile.frontend.componentKit;
  const sections = RULEBOOK_KEYS.map((key): RulebookSectionView => {
    const present = profile[key] !== undefined;
    const rules = Object.keys(RULEBOOK_RULE_SECTION).filter((rule) => RULEBOOK_RULE_SECTION[rule] === key) as StandardsRuleId[];
    const checked: RulebookCheckedItem[] = [
      ...rules
        .filter((rule) => ALWAYS_ON.has(rule) || (present && ruleConfigured(profile, rule)))
        .map((rule): RulebookCheckedItem => ({
          kind: 'rule', rule, severity: ruleSeverity(profile, rule), ...(ALWAYS_ON.has(rule) ? { alwaysOn: true as const } : {}),
        })),
      ...profile.commands
        .filter((c) => commandSection(c.label) === key)
        .map((c): RulebookCheckedItem => ({ kind: 'command', label: c.label, run: c.run })),
    ];
    const notYetChecked = present
      ? rules.filter((rule) => NOT_YET_CHECKED_HINTS[rule] !== undefined && !ruleConfigured(profile, rule))
        .map((rule) => ({ text: NOT_YET_CHECKED_TEXT[rule], hint: NOT_YET_CHECKED_HINTS[rule] }))
      : [];
    return {
      key,
      title: RULEBOOK_TITLES[key],
      present,
      applicable: key !== 'accessibility' || present || ui,
      checked,
      guidance: (profile[key]?.guidance ?? []).map((text) => ({ text, sent: !cut.has(text) })),
      notYetChecked,
    };
  });
  return {
    sections,
    counts: {
      checked: sections.reduce((n, s) => n + s.checked.length, 0),
      guidance: sections.reduce((n, s) => n + s.guidance.length, 0),
    },
  };
}
