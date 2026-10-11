// ─── Project standards: profile model, validator, hash, renderer ───
//
// One agreed, versioned description of how a project is built: where files go,
// which layers may import which, how files are named, how much commentary is
// tolerated, and which commands prove conformance. Every agent prompt carries
// the rendered text and every verification checks the diff against the profile.
//
// Deliberately free of VS Code API imports and of the runner: the extension,
// the headless CLI and the hosted server all load this module.

import { createHash } from 'crypto';
import { BUILT_IN_RULES } from '../ai-rules/built-in-rules';
import { STACK_IDS, StackId } from '../server/stacks';
import {
  DesignSystem,
  MAX_DESIGN_DOC_CHARS,
  MAX_DESIGN_TOKENS_CHARS,
  designConfigFingerprint,
  parseDesignTokens,
  renderDesignPlannerSummary,
} from './design';

// ─── Closed sets ───

/** Lifecycle of one stored profile version. "In effect" is derived (latest approved), never stored. */
export const STANDARDS_VERSION_STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;
export type StandardsVersionStatus = typeof STANDARDS_VERSION_STATUSES[number];

/**
 * Outcome of one rule, as stored. `not-checked` is never a pass.
 *
 * The stored words are not the words a reader is shown. `passed` / `failed` are shown only
 * for a profile command, whose exit code is the evidence. Every rule MOAG decides itself
 * ({@link isScannerRule}) is shown as "no findings" / "findings": that it found nothing is
 * not proof that nothing is there. See `ruleOutcomeLabel` in checker.ts — every surface
 * renders through it.
 */
export const RULE_RESULTS = ['passed', 'failed', 'not-checked'] as const;
export type RuleResult = typeof RULE_RESULTS[number];

/** How a proposed field was arrived at. Binary on purpose; "changed from vN" is computed by diff. */
export const PROVENANCE_TAGS = ['detected', 'assumed'] as const;
export type ProvenanceTag = typeof PROVENANCE_TAGS[number];

/** File-name styles a naming rule can demand. */
export const NAMING_STYLES = ['kebab-case', 'camelCase', 'PascalCase', 'snake_case'] as const;
export type NamingStyle = typeof NAMING_STYLES[number];

/** Named frontend patterns the checker implements itself — a profile never carries a regex. */
export const RAW_PATTERN_BUILTINS = ['hex-color', 'css-color-function', 'inline-style'] as const;
export type RawPatternBuiltin = typeof RAW_PATTERN_BUILTINS[number];

/** Every static rule the checker can report on. */
export const STANDARDS_RULE_IDS = [
  'structure/required-dirs',
  'structure/top-level',
  'structure/placement',
  'structure/nested-repository',
  'frontend/raw-pattern',
  'frontend/design-tokens',
  'layering/imports',
  'naming/files',
  'comment-policy/commented-out-code',
  'comment-policy/banned-phrase',
  'comment-policy/density',
  'exemption/newly-generated',
] as const;
export type StandardsRuleId = typeof STANDARDS_RULE_IDS[number];

/**
 * True for a rule MOAG decides itself — every static rule, which is everything but a
 * profile command. Whatever it reads (paths, source text, git's listing of the tree), its
 * outcomes are "no findings", "findings" and "not checked" — never "passed". Only a
 * command, judged by the exit code of a real tool, is ever shown as "passed" or "failed".
 */
export function isScannerRule(rule: string): boolean {
  return rule !== 'command';
}

/**
 * Whether a failed rule stops a release. `blocking` fails the standards gate; `advisory`
 * is reported with file, line and rule, shown to the reviewer and the approver and counted,
 * but never stops anything.
 */
export const RULE_SEVERITIES = ['blocking', 'advisory'] as const;
export type RuleSeverity = typeof RULE_SEVERITIES[number];

/**
 * What each rule is unless the profile says otherwise.
 *
 * Blocking by default is reserved for profile commands: real linters, formatters,
 * type-checkers and tests, where the exit code of the project's own tool is the evidence.
 * They are not in this table because a command is always blocking.
 *
 * Every rule MOAG decides itself is advisory — required directories and nested
 * repositories included. A project may promote one (see `severity`); the editor says
 * what that risks.
 */
export const DEFAULT_RULE_SEVERITY: Record<StandardsRuleId, RuleSeverity> = {
  'structure/required-dirs': 'advisory',
  'structure/top-level': 'advisory',
  'structure/placement': 'advisory',
  'structure/nested-repository': 'advisory',
  'frontend/raw-pattern': 'advisory',
  'frontend/design-tokens': 'advisory',
  'layering/imports': 'advisory',
  'naming/files': 'advisory',
  'comment-policy/commented-out-code': 'advisory',
  'comment-policy/banned-phrase': 'advisory',
  'comment-policy/density': 'advisory',
  'exemption/newly-generated': 'advisory',
};

/** A profile's per-rule overrides of {@link DEFAULT_RULE_SEVERITY}. */
export type SeverityOverrides = Partial<Record<StandardsRuleId, RuleSeverity>>;

/** The severity `rule` has under `profile`: its override when it names one, else the default. */
export function ruleSeverity(profile: Pick<StandardsProfile, 'severity'>, rule: StandardsRuleId): RuleSeverity {
  return profile.severity?.[rule] ?? DEFAULT_RULE_SEVERITY[rule];
}

/** One rule whose severity differs between two profiles: what was promoted or demoted. */
export interface SeverityChange {
  rule: StandardsRuleId;
  from: RuleSeverity;
  to: RuleSeverity;
}

/**
 * Every rule `after` holds at another severity than `before` does, in rule order. A null
 * `before` stands for a project with no standards in effect: the comparison is then with
 * {@link DEFAULT_RULE_SEVERITY}, so a first version's own demotions are changes too.
 */
export function severityChangesBetween(
  before: Pick<StandardsProfile, 'severity'> | null,
  after: Pick<StandardsProfile, 'severity'>,
): SeverityChange[] {
  const reference = before ?? {};
  return STANDARDS_RULE_IDS
    .filter((rule) => ruleSeverity(reference, rule) !== ruleSeverity(after, rule))
    .map((rule) => ({ rule, from: ruleSeverity(reference, rule), to: ruleSeverity(after, rule) }));
}

/**
 * True when `profile` gives `rule` something to decide on. A rule with nothing configured
 * reports "not configured" whatever its severity, so it can stop nothing. Mirrors what each
 * check in checker.ts treats as not configured; the rules with no configuration of their own
 * (nested repositories, comment density, generated markers) always are.
 */
export function ruleConfigured(profile: StandardsProfile, rule: StandardsRuleId): boolean {
  switch (rule) {
    case 'structure/required-dirs': return profile.structure.requiredDirs.length > 0;
    case 'structure/top-level': return profile.structure.allowedTopLevel.length > 0;
    case 'structure/placement': return profile.structure.placement.length > 0;
    case 'frontend/raw-pattern': return profile.frontend.rawPatterns.length > 0;
    case 'frontend/design-tokens': return profile.design !== undefined;
    case 'layering/imports': return profile.backend.layers.length > 0 && profile.backend.forbiddenImports.length > 0;
    case 'naming/files': return profile.naming.files.length > 0;
    case 'comment-policy/commented-out-code': return profile.comments.forbidCommentedOutCode;
    case 'comment-policy/banned-phrase': return profile.comments.bannedPhrases.length > 0;
    case 'structure/nested-repository':
    case 'comment-policy/density':
    case 'exemption/newly-generated':
      return true;
  }
}

/** One command a profile runs. Always blocking: its exit code is the evidence. */
export type StandardsCommand = StandardsProfile['commands'][number];

/**
 * What one profile changes, relative to another, in the fields that decide what can stop a
 * release: the commands, the severity of each rule, and the required directories.
 *
 * Nothing here says whether a change tightens or loosens. `npm test` rewritten to
 * `npm test || true` is neither a removal nor an addition and switches a check off all the
 * same; so ANY difference is reported, with what the field held before and after, and a
 * reviewer decides what it means.
 */
export interface EnforcementChanges {
  /** Set when the command list differs in any way: a label, a command line, the order, the count. */
  commands: { before: StandardsCommand[]; after: StandardsCommand[] } | null;
  /** Every rule held at another severity, in rule order. Empty when none is. */
  severity: SeverityChange[];
  /** Set when the required directories differ in any way, order included. */
  requiredDirs: { before: string[]; after: string[] } | null;
  /**
   * Every rule that is blocking in either profile and whose own configuration differs: a
   * promoted naming rule whose patterns were emptied can stop nothing any more, though its
   * severity never moved. Empty while no rule is promoted, which is the default.
   */
  ruleConfig: Array<{ rule: StandardsRuleId; before: unknown; after: unknown }>;
}

/** The fields of {@link EnforcementChanges}, as they are named to a reader. */
export const ENFORCEMENT_FIELDS = ['commands', 'severity', 'requiredDirs', 'ruleConfig'] as const;
export type EnforcementField = typeof ENFORCEMENT_FIELDS[number];

/**
 * What `after` changes about enforcement relative to `before`. A null `before` stands for a
 * project with nothing in force — no command, default severities, no required directory —
 * so everything a first version brings is a change too.
 *
 * Commands and required directories are compared exactly, entry by entry and in order.
 * Severities are compared as each rule resolves ({@link ruleSeverity}), so writing a
 * default out explicitly is not a change. The configuration of a rule is compared only
 * while that rule is blocking on either side: an advisory rule's settings stop nothing.
 */
export function enforcementChangesBetween(before: StandardsProfile | null, after: StandardsProfile): EnforcementChanges {
  const commandsOf = (p: StandardsProfile | null): StandardsCommand[] => (p ? p.commands.map((c) => ({ label: c.label, run: c.run })) : []);
  const dirsOf = (p: StandardsProfile | null): string[] => (p ? [...p.structure.requiredDirs] : []);
  const beforeCommands = commandsOf(before);
  const afterCommands = commandsOf(after);
  const beforeDirs = dirsOf(before);
  const afterDirs = dirsOf(after);
  return {
    commands: JSON.stringify(beforeCommands) === JSON.stringify(afterCommands) ? null : { before: beforeCommands, after: afterCommands },
    severity: severityChangesBetween(before, after),
    requiredDirs: JSON.stringify(beforeDirs) === JSON.stringify(afterDirs) ? null : { before: beforeDirs, after: afterDirs },
    ruleConfig: STANDARDS_RULE_IDS
      .filter((rule) => ruleSeverity(before ?? {}, rule) === 'blocking' || ruleSeverity(after, rule) === 'blocking')
      .map((rule) => ({ rule, before: clonedConfig(before, rule), after: clonedConfig(after, rule) }))
      .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after)),
  };
}

/**
 * What `rule` is configured with in `profile`: the part of the profile that decides what the
 * rule judges. Null for a rule with no configuration of its own, for required directories
 * (reported as their own field) and for an absent profile.
 */
function ruleConfigOf(profile: StandardsProfile | null, rule: StandardsRuleId): unknown {
  if (!profile) { return null; }
  switch (rule) {
    case 'structure/top-level': return profile.structure.allowedTopLevel;
    case 'structure/placement': return profile.structure.placement;
    case 'frontend/raw-pattern': return profile.frontend.rawPatterns;
    // Hashes only: no DESIGN.md prose reaches an audit log through an enforcement change.
    case 'frontend/design-tokens': return profile.design ? designConfigFingerprint(profile.design, profile.frontend.componentKit) : null;
    case 'layering/imports': return profile.backend;
    case 'naming/files': return profile.naming.files;
    case 'comment-policy/commented-out-code': return profile.comments.forbidCommentedOutCode;
    case 'comment-policy/banned-phrase': return profile.comments.bannedPhrases;
    case 'comment-policy/density': return { maxDensityPct: profile.comments.maxDensityPct, minAddedLines: profile.comments.minAddedLines };
    case 'structure/required-dirs':
    case 'structure/nested-repository':
    case 'exemption/newly-generated':
      return null;
  }
}

/** A copy of {@link ruleConfigOf}, so a caller cannot reach into the profile through it. */
function clonedConfig(profile: StandardsProfile | null, rule: StandardsRuleId): unknown {
  return JSON.parse(JSON.stringify(ruleConfigOf(profile, rule))) as unknown;
}

/** The fields `changes` reports a difference in; empty when enforcement is unchanged. */
export function enforcementFieldsChanged(changes: EnforcementChanges): EnforcementField[] {
  const out: EnforcementField[] = [];
  if (changes.commands !== null) { out.push('commands'); }
  if (changes.severity.length > 0) { out.push('severity'); }
  if (changes.requiredDirs !== null) { out.push('requiredDirs'); }
  if (changes.ruleConfig.length > 0) { out.push('ruleConfig'); }
  return out;
}

/** The profile areas a proposal tags as detected or assumed. */
export const PROVENANCE_FIELDS = [
  'stackTemplateId',
  'repoState',
  'structure.requiredDirs',
  'structure.allowedTopLevel',
  'structure.placement',
  'frontend.componentKit',
  'frontend.styleSource',
  'frontend.rawPatterns',
  'backend.layers',
  'naming.files',
  'comments',
  'testing',
  'commands',
  'builtInRuleIds',
] as const;
export type ProvenanceField = typeof PROVENANCE_FIELDS[number];

/**
 * Provenance areas present only when the profile has the matching part: `design` goes with
 * `profile.design`. Optional, so every provenance written before them still validates.
 */
export const OPTIONAL_PROVENANCE_FIELDS = ['design'] as const;
export type OptionalProvenanceField = typeof OPTIONAL_PROVENANCE_FIELDS[number];

export const REPO_STATES = ['greenfield', 'brownfield'] as const;
export type RepoState = typeof REPO_STATES[number];

export const RAW_PATTERN_KINDS = ['literal', 'builtin'] as const;
export type RawPatternKind = typeof RAW_PATTERN_KINDS[number];

// ─── Caps ───

/** Heading of the standards section in a task prompt. The runner looks for it to know the block arrived. */
export const PROJECT_STANDARDS_HEADER = '## Project Standards';

export const MAX_STANDARDS_FREE_TEXT_CHARS = 20_000;
export const MAX_STANDARDS_PROMPT_CHARS = 4_000;
/**
 * Longest planner text a standards job file may carry: the prompt text plus the preamble and
 * the greenfield scaffold instruction. One constant for both ends — {@link validateProfile}
 * refuses a profile that renders past it, and `readStandardsJobFile` refuses a file that
 * holds more — so a profile that can be approved can never make a job fail to load.
 */
export const MAX_STANDARDS_PLANNER_CHARS = MAX_STANDARDS_PROMPT_CHARS + 2_000;
export const MAX_STANDARDS_COMMANDS = 6;
export const MAX_STANDARDS_COMMAND_CHARS = 500;
export const MAX_STANDARDS_LIST_ENTRIES = 50;
export const MAX_STANDARDS_ENTRY_CHARS = 200;

/** Most validation errors reported for one document — a hostile input cannot flood the response. */
const MAX_VALIDATION_ERRORS = 50;

// ─── Types ───

export interface StandardsProfile {
  stackTemplateId: StackId;
  repoState: RepoState;
  structure: {
    requiredDirs: string[];
    allowedTopLevel: string[];
    placement: Array<{ id: string; files: string; under: string[] }>;
  };
  frontend: {
    componentKit: string;
    styleSource: string;
    rawPatterns: Array<{ id: string; kind: RawPatternKind; value: string; globs: string[]; message: string }>;
  };
  backend: {
    layers: Array<{ name: string; globs: string[] }>;
    forbiddenImports: Array<{ from: string; to: string }>;
    importAliases: Array<{ prefix: string; path: string }>;
  };
  naming: { files: Array<{ globs: string[]; style: NamingStyle }>; notes: string };
  comments: {
    maxDensityPct: number;
    minAddedLines: number;
    forbidCommentedOutCode: boolean;
    bannedPhrases: string[];
  };
  testing: { runner: string; fileGlobs: string[]; notes: string };
  commands: Array<{ label: string; run: string }>;
  builtInRuleIds: string[];
  freeText: string;
  /**
   * Per-rule severity overrides. Absent — never an empty object — when the profile changes
   * none, so a profile written before severities existed keeps its content hash.
   */
  severity?: SeverityOverrides;
  /**
   * The approved design system of a project with a user interface: DESIGN.md and the tokens
   * file, verbatim. Absent — never null or empty — when the project has none, so a profile
   * written before design systems existed keeps its content hash.
   */
  design?: DesignSystem;
}

/** Per-field origin of a proposal: the tag, and the file (or default) that justified it. */
export type StandardsProvenance = Record<ProvenanceField, { tag: ProvenanceTag; evidence: string }>
  & Partial<Record<OptionalProvenanceField, { tag: ProvenanceTag; evidence: string }>>;

/** The stored envelope. The version lives here; the hash covers `profile` only. */
export interface StandardsDocument {
  schemaVersion: 1;
  version: number;
  profile: StandardsProfile;
  provenance: StandardsProvenance;
}

export type ProfileValidation =
  | { ok: true; profile: StandardsProfile }
  | { ok: false; errors: string[] };

// ─── Validation helpers ───

type Obj = Record<string, unknown>;

/** Credential shapes that must never be stored in, or injected from, a profile. */
const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'an API key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/ },
  { name: 'an AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a PEM block', re: /-----BEGIN [A-Z0-9 ]+-----/ },
];

/** True when `value` holds a line break or any control character other than tab. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f || code === 0x2028 || code === 0x2029) { return true; }
  }
  return false;
}

/**
 * True when `value` holds a character a reviewer cannot see or that reorders what they do
 * see: any C0 or C1 control (tab included); a soft hyphen (U+00AD); an Arabic letter mark
 * (U+061C); a Mongolian vowel separator (U+180E); a zero-width or directional mark
 * (U+200B–U+200F); a bidirectional embedding, override or isolate (U+202A–U+202E,
 * U+2066–U+2069); a line or paragraph separator (U+2028, U+2029); a word joiner or an
 * invisible operator (U+2060–U+2064); a deprecated format control (U+206A–U+206F); a
 * byte-order mark (U+FEFF); an interlinear annotation control (U+FFF9–U+FFFB); a variation
 * selector (U+180B–U+180D, U+180F, U+FE00–U+FE0F, U+E0100–U+E01EF), which changes nothing a
 * reader can tell apart yet makes two strings differ; or a tag character (U+E0000–U+E007F),
 * which renders as nothing and can carry a whole hidden string.
 * A command is approved by reading it, so what is read must be what runs.
 */
export function hasInvisibleChars(value: string): boolean {
  // By code point, not by code unit: the tag characters lie outside the basic plane.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)
      || code === 0x00ad || code === 0x061c || (code >= 0x180b && code <= 0x180f)
      || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x206f)
      || code === 0x2028 || code === 0x2029 || code === 0xfeff
      || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xfff9 && code <= 0xfffb)
      || (code >= 0xe0000 && code <= 0xe007f) || (code >= 0xe0100 && code <= 0xe01ef)) {
      return true;
    }
  }
  return false;
}

class Collector {
  readonly errors: string[] = [];
  add(message: string): void {
    if (this.errors.length < MAX_VALIDATION_ERRORS) { this.errors.push(message); }
  }
}

/** An object with exactly `keys` (plus any of `optional`): unknown keys and missing keys are both errors. */
function shape(raw: unknown, at: string, keys: readonly string[], c: Collector, optional: readonly string[] = []): Obj | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    c.add(`${at}: expected an object`);
    return null;
  }
  const obj = raw as Obj;
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key) && !optional.includes(key)) { c.add(`${at}: unknown key "${key.slice(0, 60)}"`); }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) { c.add(`${at}.${key}: missing`); }
  }
  return obj;
}

/** A single-line string of at most `max` chars. */
function line(raw: unknown, at: string, c: Collector, opts: { max?: number; allowEmpty?: boolean; visibleOnly?: boolean } = {}): string {
  const max = opts.max ?? MAX_STANDARDS_ENTRY_CHARS;
  if (typeof raw !== 'string') { c.add(`${at}: expected a string`); return ''; }
  if (raw.length > max) { c.add(`${at}: ${raw.length} characters; the limit is ${max}`); return ''; }
  if (hasControlChars(raw)) { c.add(`${at}: must be a single line with no control characters`); return ''; }
  if (opts.visibleOnly && hasInvisibleChars(raw)) {
    c.add(`${at}: must not contain control, zero-width or bidirectional-override characters`);
    return '';
  }
  if (!opts.allowEmpty && raw.trim().length === 0) { c.add(`${at}: must not be empty`); return ''; }
  return raw;
}

function list<T>(raw: unknown, at: string, c: Collector, each: (entry: unknown, at: string) => T, max = MAX_STANDARDS_LIST_ENTRIES): T[] {
  if (!Array.isArray(raw)) { c.add(`${at}: expected a list`); return []; }
  if (raw.length > max) { c.add(`${at}: ${raw.length} entries; the limit is ${max}`); return []; }
  return raw.map((entry, i) => each(entry, `${at}[${i}]`));
}

function lines(raw: unknown, at: string, c: Collector): string[] {
  return list(raw, at, c, (entry, where) => line(entry, where, c));
}

/**
 * One required directory: a repository-relative path, normalised to `/` separators with no
 * leading `./` and no trailing or doubled separator. Refused when it holds a character a
 * reviewer cannot see, is absolute (`/x`, `C:/x`, `//host/x`), or has a `..` segment — a
 * required directory names a place inside the repository and nowhere else.
 */
function requiredDir(raw: unknown, at: string, c: Collector): string {
  const text = line(raw, at, c, { visibleOnly: true });
  if (text === '') { return ''; }
  const slashed = text.trim().replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    c.add(`${at}: must be a path inside the repository, not an absolute path`);
    return '';
  }
  const segments = slashed.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.includes('..')) {
    c.add(`${at}: must not contain a ".." segment`);
    return '';
  }
  if (segments.length === 0) {
    c.add(`${at}: must name a directory`);
    return '';
  }
  return segments.join('/');
}

function member<T extends string>(raw: unknown, at: string, set: readonly T[], c: Collector, fallback: T): T {
  if (typeof raw === 'string' && (set as readonly string[]).includes(raw)) { return raw as T; }
  c.add(`${at}: expected one of ${set.join(', ')}`);
  return fallback;
}

/** Report every string in `value` that looks like a credential. */
function scanCredentials(value: unknown, at: string, c: Collector): void {
  if (typeof value === 'string') {
    for (const p of CREDENTIAL_PATTERNS) {
      if (p.re.test(value)) { c.add(`${at}: looks like ${p.name}; standards must not contain credentials`); }
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, i) => scanCredentials(entry, `${at}[${i}]`, c));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Obj)) { scanCredentials(entry, `${at}.${key}`, c); }
  }
}

// ─── Validation ───

/**
 * Validate an untrusted profile and return a fresh, normalised copy.
 *
 * Strict by design: unknown keys, missing keys, over-cap values, multi-line
 * commands, unknown closed-set members, credential-shaped strings and a
 * structured rendering that cannot fit the prompt cap are all errors. The
 * returned errors are safe to show to a user.
 */
export function validateProfile(raw: unknown): ProfileValidation {
  const c = new Collector();
  const root = shape(raw, 'profile', [
    'stackTemplateId', 'repoState', 'structure', 'frontend', 'backend', 'naming',
    'comments', 'testing', 'commands', 'builtInRuleIds', 'freeText',
  ], c, ['severity', 'design']);
  if (!root) { return { ok: false, errors: c.errors }; }

  const structure = shape(root.structure, 'profile.structure', ['requiredDirs', 'allowedTopLevel', 'placement'], c) ?? {};
  const frontend = shape(root.frontend, 'profile.frontend', ['componentKit', 'styleSource', 'rawPatterns'], c) ?? {};
  const backend = shape(root.backend, 'profile.backend', ['layers', 'forbiddenImports', 'importAliases'], c) ?? {};
  const naming = shape(root.naming, 'profile.naming', ['files', 'notes'], c) ?? {};
  const comments = shape(root.comments, 'profile.comments',
    ['maxDensityPct', 'minAddedLines', 'forbidCommentedOutCode', 'bannedPhrases'], c) ?? {};
  const testing = shape(root.testing, 'profile.testing', ['runner', 'fileGlobs', 'notes'], c) ?? {};

  const layers = list(backend.layers, 'profile.backend.layers', c, (entry, at) => {
    const o = shape(entry, at, ['name', 'globs'], c) ?? {};
    return { name: line(o.name, `${at}.name`, c), globs: lines(o.globs, `${at}.globs`, c) };
  });
  const layerNames = new Set(layers.map((l) => l.name));
  const layerRef = (value: unknown, at: string): string => {
    const name = line(value, at, c);
    if (name && !layerNames.has(name)) { c.add(`${at}: "${name}" is not a declared layer`); }
    return name;
  };

  let maxDensityPct = 0;
  if (typeof comments.maxDensityPct !== 'number' || !Number.isFinite(comments.maxDensityPct)
    || comments.maxDensityPct < 0 || comments.maxDensityPct > 100) {
    c.add('profile.comments.maxDensityPct: expected a number from 0 to 100');
  } else {
    maxDensityPct = comments.maxDensityPct;
  }
  let minAddedLines = 1;
  if (typeof comments.minAddedLines !== 'number' || !Number.isInteger(comments.minAddedLines)
    || comments.minAddedLines < 1 || comments.minAddedLines > 100_000) {
    c.add('profile.comments.minAddedLines: expected a whole number of at least 1');
  } else {
    minAddedLines = comments.minAddedLines;
  }
  if (typeof comments.forbidCommentedOutCode !== 'boolean') {
    c.add('profile.comments.forbidCommentedOutCode: expected true or false');
  }

  const knownRuleIds = new Set(BUILT_IN_RULES.map((r) => r.id));
  const builtInRuleIds = lines(root.builtInRuleIds, 'profile.builtInRuleIds', c);
  builtInRuleIds.forEach((id, i) => {
    if (id && !knownRuleIds.has(id)) { c.add(`profile.builtInRuleIds[${i}]: unknown built-in rule "${id}"`); }
    if (id && builtInRuleIds.indexOf(id) !== i) { c.add(`profile.builtInRuleIds[${i}]: "${id}" is listed twice`); }
  });

  let freeText = '';
  if (typeof root.freeText !== 'string') {
    c.add('profile.freeText: expected a string');
  } else if (root.freeText.length > MAX_STANDARDS_FREE_TEXT_CHARS) {
    c.add(`profile.freeText: ${root.freeText.length} characters; the limit is ${MAX_STANDARDS_FREE_TEXT_CHARS}`);
  } else {
    freeText = root.freeText;
  }

  const profile: StandardsProfile = {
    stackTemplateId: member(root.stackTemplateId, 'profile.stackTemplateId', STACK_IDS, c, 'other'),
    repoState: member(root.repoState, 'profile.repoState', REPO_STATES, c, 'brownfield'),
    structure: {
      requiredDirs: list(structure.requiredDirs, 'profile.structure.requiredDirs', c, (entry, at) => requiredDir(entry, at, c)),
      allowedTopLevel: lines(structure.allowedTopLevel, 'profile.structure.allowedTopLevel', c),
      placement: list(structure.placement, 'profile.structure.placement', c, (entry, at) => {
        const o = shape(entry, at, ['id', 'files', 'under'], c) ?? {};
        const under = lines(o.under, `${at}.under`, c);
        if (Array.isArray(o.under) && o.under.length === 0) { c.add(`${at}.under: must list at least one directory`); }
        return { id: line(o.id, `${at}.id`, c), files: line(o.files, `${at}.files`, c), under };
      }),
    },
    frontend: {
      componentKit: line(frontend.componentKit, 'profile.frontend.componentKit', c, { allowEmpty: true }),
      styleSource: line(frontend.styleSource, 'profile.frontend.styleSource', c, { allowEmpty: true }),
      rawPatterns: list(frontend.rawPatterns, 'profile.frontend.rawPatterns', c, (entry, at) => {
        const o = shape(entry, at, ['id', 'kind', 'value', 'globs', 'message'], c) ?? {};
        const kind = member(o.kind, `${at}.kind`, RAW_PATTERN_KINDS, c, 'literal');
        const value = line(o.value, `${at}.value`, c);
        if (kind === 'builtin' && value && !(RAW_PATTERN_BUILTINS as readonly string[]).includes(value)) {
          c.add(`${at}.value: unknown built-in pattern "${value}"; expected one of ${RAW_PATTERN_BUILTINS.join(', ')}`);
        }
        return {
          id: line(o.id, `${at}.id`, c),
          kind,
          value,
          globs: lines(o.globs, `${at}.globs`, c),
          message: line(o.message, `${at}.message`, c),
        };
      }),
    },
    backend: {
      layers,
      forbiddenImports: list(backend.forbiddenImports, 'profile.backend.forbiddenImports', c, (entry, at) => {
        const o = shape(entry, at, ['from', 'to'], c) ?? {};
        return { from: layerRef(o.from, `${at}.from`), to: layerRef(o.to, `${at}.to`) };
      }),
      importAliases: list(backend.importAliases, 'profile.backend.importAliases', c, (entry, at) => {
        const o = shape(entry, at, ['prefix', 'path'], c) ?? {};
        return { prefix: line(o.prefix, `${at}.prefix`, c), path: line(o.path, `${at}.path`, c, { allowEmpty: true }) };
      }),
    },
    naming: {
      files: list(naming.files, 'profile.naming.files', c, (entry, at) => {
        const o = shape(entry, at, ['globs', 'style'], c) ?? {};
        return { globs: lines(o.globs, `${at}.globs`, c), style: member(o.style, `${at}.style`, NAMING_STYLES, c, 'kebab-case') };
      }),
      notes: line(naming.notes, 'profile.naming.notes', c, { allowEmpty: true }),
    },
    comments: {
      maxDensityPct,
      minAddedLines,
      forbidCommentedOutCode: comments.forbidCommentedOutCode === true,
      bannedPhrases: lines(comments.bannedPhrases, 'profile.comments.bannedPhrases', c),
    },
    testing: {
      runner: line(testing.runner, 'profile.testing.runner', c, { allowEmpty: true }),
      fileGlobs: lines(testing.fileGlobs, 'profile.testing.fileGlobs', c),
      notes: line(testing.notes, 'profile.testing.notes', c, { allowEmpty: true }),
    },
    commands: list(root.commands, 'profile.commands', c, (entry, at) => {
      const o = shape(entry, at, ['label', 'run'], c) ?? {};
      return {
        label: line(o.label, `${at}.label`, c, { visibleOnly: true }),
        run: line(o.run, `${at}.run`, c, { max: MAX_STANDARDS_COMMAND_CHARS, visibleOnly: true }),
      };
    }, MAX_STANDARDS_COMMANDS),
    builtInRuleIds,
    freeText,
  };

  // The same command twice is one command run twice: it proves nothing more and reads, on
  // the approval screen, as two different checks.
  const commandKey = (run: string): string => run.trim().replace(/\s+/g, ' ');
  profile.commands.forEach((cmd, i) => {
    if (cmd.run === '') { return; }
    const first = profile.commands.findIndex((other) => other.run !== '' && commandKey(other.run) === commandKey(cmd.run));
    if (first !== i) { c.add(`profile.commands[${i}].run: the same command as profile.commands[${first}]`); }
  });

  if (root.severity !== undefined) {
    const overrides = validateSeverity(root.severity, c);
    if (Object.keys(overrides).length > 0) { profile.severity = overrides; }
  }

  if (root.design !== undefined) {
    const design = validateDesign(root.design, c);
    if (design) { profile.design = design; }
  }

  scanCredentials(profile, 'profile', c);

  if (c.errors.length === 0) {
    const structured = structuredText(profile, null).length + ruleNamesLine(profile.builtInRuleIds).length;
    if (structured > MAX_STANDARDS_PROMPT_CHARS) {
      c.add(`profile: the structured rules render to ${structured} characters; ` +
        `the limit for the text every prompt carries is ${MAX_STANDARDS_PROMPT_CHARS}. Shorten or remove list entries.`);
    } else {
      // Rendered with the longest version number a store can hold, so no later version of
      // the same content can cross the limit.
      const planner = renderPlannerStandards(profile, LONGEST_VERSION).length;
      if (planner > MAX_STANDARDS_PLANNER_CHARS) {
        c.add(`profile: the planning text renders to ${planner} characters; the limit is ${MAX_STANDARDS_PLANNER_CHARS}. ` +
          'Shorten the required directories or other list entries.');
      }
    }
  }

  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, profile };
}

// ─── Design system ───

/** Extensions a tokens file may have: a stylesheet, or a theme module the build reads. */
const TOKENS_EXTENSIONS = ['.css', '.scss', '.ts', '.js', '.mjs', '.cjs', '.json'];

/**
 * A repository file a design system writes: {@link requiredDir}'s rules, and no segment that
 * is `.moag` or starts with `.git` — MOAG writes these files into the repository.
 */
function repoFile(raw: unknown, at: string, c: Collector): string {
  const p = requiredDir(raw, at, c);
  if (p === '') { return ''; }
  if (p.split('/').some((seg) => seg.toLowerCase() === '.moag' || seg.toLowerCase().startsWith('.git'))) {
    c.add(`${at}: must not be inside .git or .moag`);
    return '';
  }
  return p;
}

/** A multi-line text of at most `max` characters whose lines carry no invisible character. */
function designText(raw: unknown, at: string, max: number, c: Collector): string {
  if (typeof raw !== 'string') { c.add(`${at}: expected a string`); return ''; }
  if (raw.length > max) { c.add(`${at}: ${raw.length} characters; the limit is ${max}`); return ''; }
  const rows = raw.split('\n');
  for (let i = 0; i < rows.length; i++) {
    if (hasInvisibleChars(rows[i].replace(/[\r\t]/g, ''))) {
      c.add(`${at}: line ${i + 1} must not contain control, zero-width or bidirectional-override characters`);
      return '';
    }
  }
  return raw;
}

/**
 * Validate a design system: exactly `docPath`, `tokensPath`, `doc` and `tokens`. Paths are
 * repository-relative, outside `.git` and `.moag`, distinct, with DESIGN.md a `.md` file and
 * the tokens file a stylesheet or a theme module. Each text has its cap, and no line or listed
 * token holds a character a reviewer cannot see. Null when anything is wrong.
 */
function validateDesign(raw: unknown, c: Collector): DesignSystem | null {
  const before = c.errors.length;
  const o = shape(raw, 'profile.design', ['docPath', 'tokensPath', 'doc', 'tokens'], c);
  if (!o) { return null; }
  const docPath = repoFile(o.docPath, 'profile.design.docPath', c);
  const tokensPath = repoFile(o.tokensPath, 'profile.design.tokensPath', c);
  if (docPath && !docPath.toLowerCase().endsWith('.md')) { c.add('profile.design.docPath: must be a Markdown (.md) file'); }
  if (tokensPath && !TOKENS_EXTENSIONS.some((ext) => tokensPath.toLowerCase().endsWith(ext))) {
    c.add(`profile.design.tokensPath: must end in one of ${TOKENS_EXTENSIONS.join(' ')}`);
  }
  if (docPath && tokensPath && docPath.toLowerCase() === tokensPath.toLowerCase()) {
    c.add('profile.design.tokensPath: must not be the same file as profile.design.docPath');
  }
  const doc = designText(o.doc, 'profile.design.doc', MAX_DESIGN_DOC_CHARS, c);
  const tokens = designText(o.tokens, 'profile.design.tokens', MAX_DESIGN_TOKENS_CHARS, c);
  if (tokensPath && tokens) {
    for (const t of parseDesignTokens(tokensPath, tokens).tokens) {
      if (hasInvisibleChars(t.name) || hasInvisibleChars(t.value)) {
        c.add(`profile.design.tokens: token ${t.name.slice(0, 60)} must not contain control, zero-width or bidirectional-override characters`);
        break;
      }
    }
  }
  return c.errors.length > before ? null : { docPath, tokensPath, doc, tokens };
}

/** The errors a design system on its own would be refused with (credentials included); empty when valid. */
export function checkDesign(raw: unknown): string[] {
  const c = new Collector();
  const design = validateDesign(raw, c);
  if (design) { scanCredentials(design, 'profile.design', c); }
  return c.errors;
}

/** A version number with as many digits as any store accepts; used to size rendered text. */
const LONGEST_VERSION = 999_999;

/** Validate a severity override map: known rule ids onto known severities, nothing else. */
function validateSeverity(raw: unknown, c: Collector): SeverityOverrides {
  const out: SeverityOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    c.add('profile.severity: expected an object');
    return out;
  }
  for (const [key, value] of Object.entries(raw as Obj)) {
    if (!(STANDARDS_RULE_IDS as readonly string[]).includes(key)) {
      c.add(`profile.severity: unknown rule "${key.slice(0, 60)}"`);
      continue;
    }
    if (typeof value !== 'string' || !(RULE_SEVERITIES as readonly string[]).includes(value)) {
      c.add(`profile.severity.${key}: expected one of ${RULE_SEVERITIES.join(', ')}`);
      continue;
    }
    out[key as StandardsRuleId] = value as RuleSeverity;
  }
  return out;
}

/**
 * Validate a provenance record: exactly the {@link PROVENANCE_FIELDS}, each a
 * known tag plus a single-line evidence string. Returns the errors (empty when valid).
 */
export function validateProvenance(raw: unknown): { ok: true; provenance: StandardsProvenance } | { ok: false; errors: string[] } {
  const c = new Collector();
  const root = shape(raw, 'provenance', PROVENANCE_FIELDS, c, OPTIONAL_PROVENANCE_FIELDS);
  const out = {} as StandardsProvenance;
  const entryOf = (field: ProvenanceField | OptionalProvenanceField): { tag: ProvenanceTag; evidence: string } => {
    const entry = root ? shape(root[field], `provenance.${field}`, ['tag', 'evidence'], c) ?? {} : {};
    return {
      tag: root ? member(entry.tag, `provenance.${field}.tag`, PROVENANCE_TAGS, c, 'assumed') : 'assumed',
      evidence: root ? line(entry.evidence, `provenance.${field}.evidence`, c, { allowEmpty: true }) : '',
    };
  };
  for (const field of PROVENANCE_FIELDS) { out[field] = entryOf(field); }
  // Copied only when present: a provenance without them stays exactly as it was.
  for (const field of OPTIONAL_PROVENANCE_FIELDS) {
    if (root && root[field] !== undefined) { out[field] = entryOf(field); }
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, provenance: out };
}

// ─── Hash ───

/** JSON with object keys sorted at every level, so key order never changes the result. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) { return `[${value.map(stableStringify).join(',')}]`; }
  if (value && typeof value === 'object') {
    const obj = value as Obj;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 (hex) of the profile content. Independent of key order; the version is not part of it. */
export function profileHash(profile: StandardsProfile): string {
  return createHash('sha256').update(stableStringify(profile), 'utf8').digest('hex');
}

// ─── Rendering ───

const TRUNCATED_QUOTE = '> …[truncated]';

function bullet(label: string, values: string[]): string | null {
  return values.length > 0 ? `- ${label}: ${values.join(', ')}` : null;
}

function section(title: string, body: Array<string | null>): string {
  const kept = body.filter((l): l is string => l !== null && l.length > 0);
  return kept.length > 0 ? `### ${title}\n${kept.join('\n')}\n` : '';
}

/** Everything except free text and built-in rules. Every emitted line carries a prefix. */
function structuredText(profile: StandardsProfile, version: number | null): string {
  const p = profile;
  const head = `Project standards${version === null ? '' : ` v${version}`} · stack ${p.stackTemplateId} · ${p.repoState} repository\n` +
    'These conventions are binding. Blocking rules and commands stop a release; a reviewer sees every other finding.\n';
  const pct = Math.round(p.comments.maxDensityPct * 100) / 100;
  return head + [
    section('Folder structure', [
      bullet('Required directories', p.structure.requiredDirs),
      bullet('Allowed top-level entries', p.structure.allowedTopLevel),
      ...p.structure.placement.map((r) => `- Files matching ${r.files} belong under: ${r.under.join(', ')}`),
    ]),
    section('Frontend', [
      p.frontend.componentKit ? `- Component kit: ${p.frontend.componentKit}` : null,
      p.frontend.styleSource ? `- Style source: ${p.frontend.styleSource}` : null,
      ...p.frontend.rawPatterns.map((r) => `- In ${r.globs.join(', ') || 'all files'}: ${r.message}`),
    ]),
    section('Backend layering', [
      ...p.backend.layers.map((l) => `- Layer ${l.name}: ${l.globs.join(', ')}`),
      ...p.backend.forbiddenImports.map((f) => `- ${f.from} must not import from ${f.to}`),
      ...p.backend.importAliases.map((a) => `- Import alias ${a.prefix} maps to ${a.path || '(repository root)'}`),
    ]),
    section('Naming', [
      ...p.naming.files.map((f) => `- ${f.globs.join(', ')}: ${f.style} file names`),
      p.naming.notes ? `- ${p.naming.notes}` : null,
    ]),
    section('Comments', [
      `- Comment lines: at most ${pct}% of added lines in any file with ${p.comments.minAddedLines}+ added lines`,
      p.comments.forbidCommentedOutCode ? '- Never leave commented-out code' : null,
      p.comments.bannedPhrases.length > 0
        ? `- Never write these phrases in comments: ${p.comments.bannedPhrases.map((s) => `"${s}"`).join(', ')}`
        : null,
    ]),
    section('Testing', [
      p.testing.runner ? `- Runner: ${p.testing.runner}` : null,
      bullet('Test files', p.testing.fileGlobs),
      p.testing.notes ? `- ${p.testing.notes}` : null,
    ]),
    section('Commands that must pass', p.commands.map((cmd) => `- ${cmd.label}: ${cmd.run}`)),
  ].join('');
}

function ruleName(id: string): string {
  return BUILT_IN_RULES.find((r) => r.id === id)?.name ?? id;
}

/** The one-line fallback that names rules whose bodies are not inlined. */
function ruleNamesLine(ids: string[]): string {
  return ids.length > 0 ? `### Built-in rules\n- Also follow: ${ids.map(ruleName).join(', ')}\n` : '';
}

/** `text` as `> ` blockquote lines that fit `budget`, cut at a line boundary with a marker. */
function quoteWithin(text: string, budget: number): string {
  const all = text.replace(/\r\n?/g, '\n').trim().split('\n').map((l) => (l.trim().length > 0 ? `> ${l}` : '>'));
  const out: string[] = [];
  let used = 0;
  for (const l of all) {
    if (used + l.length + 1 > budget) { break; }
    out.push(l);
    used += l.length + 1;
  }
  if (out.length === all.length) { return out.join('\n') + '\n'; }
  // Make room for the marker, dropping whole lines until it fits.
  while (out.length > 0 && used + TRUNCATED_QUOTE.length + 1 > budget) {
    used -= out.pop()!.length + 1;
  }
  return used + TRUNCATED_QUOTE.length + 1 <= budget ? [...out, TRUNCATED_QUOTE].join('\n') + '\n' : '';
}

/**
 * Render the text every agent prompt carries.
 *
 * Structured rules always appear in full (the validator guarantees they fit).
 * Free text follows as a `> ` blockquote — so no author-written line can pose as
 * a prompt marker — cut to the remaining room. Built-in rule bodies are inlined
 * while the result stays under {@link MAX_STANDARDS_PROMPT_CHARS}; the rest are
 * listed by name. Rules named in `skipRuleNames` (already present elsewhere in
 * the prompt) are only ever listed by name. Never longer than the cap.
 */
export function renderStandardsText(
  profile: StandardsProfile,
  version: number | null,
  opts: { skipRuleNames?: string[] } = {},
): string {
  const cap = MAX_STANDARDS_PROMPT_CHARS;
  const skip = new Set(opts.skipRuleNames ?? []);
  const rules = profile.builtInRuleIds
    .map((id) => BUILT_IN_RULES.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  const base = structuredText(profile, version);
  const reserved = ruleNamesLine(rules.map((r) => r.id)).length;

  let freeBlock = '';
  if (profile.freeText.trim().length > 0) {
    const header = '### Project rules\n';
    const quoted = quoteWithin(profile.freeText, cap - base.length - reserved - header.length);
    freeBlock = quoted ? header + quoted : '';
  }

  // Upgrade rules from "named" to "inlined" in declared order while the whole text still fits.
  const inlined: typeof rules = [];
  const build = (): string => {
    const named = rules.filter((r) => !inlined.includes(r));
    const bodies = inlined.map((r) => `### ${r.name}\n${r.text.trim()}\n`).join('');
    return (base + freeBlock + bodies + ruleNamesLine(named.map((r) => r.id))).trimEnd();
  };
  for (const rule of rules) {
    if (skip.has(rule.name)) { continue; }
    inlined.push(rule);
    if (build().length > cap) { inlined.pop(); }
  }

  const text = build();
  // Unreachable for a validated profile; an unvalidated one is still never over the cap.
  return text.length <= cap ? text : text.slice(0, cap);
}

/**
 * The block a planning prompt carries: the standards text and, for a greenfield
 * repository, the instruction that the first task scaffolds the required structure.
 */
export function renderPlannerStandards(profile: StandardsProfile, version: number | null): string {
  const parts = [
    'Project standards (every task you plan must conform; cite the relevant convention in task prompts):',
    renderStandardsText(profile, version),
  ];
  if (profile.design) { parts.push(renderDesignPlannerSummary(profile.design, profile.frontend.componentKit)); }
  if (profile.repoState === 'greenfield') {
    const dirs = profile.structure.requiredDirs;
    parts.push(
      'This is a greenfield repository. The FIRST task of the plan must scaffold the required structure' +
      (dirs.length > 0 ? ` (create: ${dirs.join(', ')})` : '') +
      ' before any feature work, as an ordinary "agent" task.',
    );
  }
  return parts.join('\n\n');
}
