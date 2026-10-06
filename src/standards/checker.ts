// ─── Deterministic standards checker ───
//
// Pure: no `fs`, no spawn, no model. Given a profile and the facts the evidence
// collector gathered about a diff, it decides each static rule as exactly one of
// `passed`, `failed` or `not-checked`, and lists a `{file, line, rule}` finding
// for every violation.
//
// Those three are the STORED words. Only a profile command — the project's own tool, whose
// exit code is the evidence — is ever SHOWN as "passed" or "failed", and the caller appends
// those rows. Every rule decided here is shown as "no findings", "findings" or "not
// checked" (see `ruleOutcomeLabel`), and it is advisory unless a project promotes it.
//
// Scope follows the diff. Comment, layering and raw-pattern rules look only at
// ADDED lines of changed files; naming and placement look only at ADDED and
// RENAMED files (the path is new, the content is not) — legacy code a change did
// not touch is never judged.
//
// Severity is separate from the result. Every rule is `blocking` or `advisory`
// (the profile decides; see DEFAULT_RULE_SEVERITY). A failed advisory rule is
// reported exactly like a failed blocking one — file, line, rule — but only a
// blocking failure stops a release. Heuristics inform; they never block on a guess.
//
// "Not checked" is never a pass. A rule that is not configured, that met a file
// it could not decide, or that found nothing in the diff to judge says so with a
// reason and is left out of the passed total. An empty diff therefore passes
// nothing: work committed before the base ref is outside the check, not cleared by it.
//
// Exemptions are visible. Every changed file the line rules did not read — vendored,
// generated, in a language no lexer covers, unreadable — is LISTED in the report with its
// reason and counted. Such a file is never evidence for "no findings", and a file the
// change itself marked as generated is a finding of its own.

import { commentOnlyLineNumbers, fileExtension, headerLineCount, lexFile, LexedLine, LexResult } from './lexer';
import { globToRegExp, isUnder, matchesAny, normalizePath } from './glob';
import type { StandardsCheckCounts } from '../models/types';
import {
  NamingStyle,
  RULE_RESULTS,
  RULE_SEVERITIES,
  RuleResult,
  RuleSeverity,
  STANDARDS_RULE_IDS,
  StandardsProfile,
  StandardsRuleId,
  isScannerRule,
  ruleSeverity,
} from './profile';

// ─── Types ───

/** One changed file, as the evidence collector saw it. */
export interface StandardsCheckFile {
  /** Repository-relative, `/`-separated. */
  path: string;
  /**
   * `renamed`: git matched the file to one that existed at the base under another path.
   * Its path is new — placement and naming judge it — but only the lines the change really
   * added or altered are in `addedLines`; a pure rename has none.
   */
  status: 'added' | 'modified' | 'renamed';
  /** 1-based numbers of the lines this change added, ascending. */
  addedLines: number[];
  /** The full new file, or null when it was not read. */
  content: string | null;
  /** Why `content` is null (oversize, binary, unreadable). */
  skipped?: string;
  /**
   * `committed`: this entry is the version of the file in the last commit, listed because
   * the working tree no longer matches it (the file was deleted or rewritten after being
   * committed). What is committed is what ships, so it is judged too.
   *
   * `staged`: this entry is the version of the file in the index, listed because the working
   * tree no longer holds it (staged, then deleted or rewritten). What is staged is what the
   * next commit ships, and no working-tree diff shows it.
   */
  origin?: 'committed' | 'staged';
}

/** One package of a monorepo workspace: the name it is imported by and the directory it lives in. */
export interface WorkspacePackage {
  name: string;
  dir: string;
}

/** One `compilerOptions.paths` entry: a specifier pattern with at most one `*`, and where it maps to. */
export interface PathAlias {
  pattern: string;
  /** Repository-relative, `/`-separated; a `*` stands for what the pattern's `*` matched. */
  targets: string[];
}

/** The path aliases a tsconfig or jsconfig declares for the files below its directory. */
export interface ImportPathScope {
  /** The directory the config sits in; '' for the repository root. */
  dir: string;
  /**
   * Null when a config there declares aliases that could not be read (unparsable, or it
   * extends a file that was not found): a non-relative import below it cannot be placed.
   */
  aliases: PathAlias[] | null;
}

export interface StandardsCheckInput {
  /** The ref the diff was taken against; null when no diff could be taken at all. */
  baseRef: string | null;
  files: StandardsCheckFile[];
  /**
   * The probed directories that hold at least one path git lists for the tree — tracked, or
   * untracked and not ignored — compared case-sensitively, whatever the file system does.
   */
  existingDirs: string[];
  /** Top-level entries that already existed at the base ref. */
  topLevel: string[];
  /** The `module` path from go.mod, or null. Go imports cannot be mapped without it. */
  goModulePath: string | null;
  /**
   * Directories in the tree, as it stands now, that are git repositories of their own and
   * that no tracked `.gitmodules` declares: a gitlink in the index, or an untracked directory
   * holding a `.git`. Git lists such a directory as ONE entry and shows none of its files,
   * so nothing inside was read. No base ref enters into it: it is a fact about the tree.
   */
  nestedRepos?: string[];
  /**
   * Gitlinks a tracked `.gitmodules` declares: ordinary submodules. Their files were not
   * read either, and they are listed as such — but a declared submodule is no finding.
   */
  submodules?: string[];
  /**
   * Directories the repository itself marks as third-party code below its root: a
   * `node_modules` beside a `package.json`, a `vendor` beside a `go.mod` or `composer.json`.
   * A top-level `vendor/`, `node_modules/` or `third_party/` needs no entry here.
   */
  vendorRoots?: string[];
  /**
   * The packages of the repository's workspace (`package.json` "workspaces",
   * `pnpm-workspace.yaml`). Null when a workspace is declared but its packages could not
   * be read — imports of them can then not be placed. Absent or empty: no workspace.
   */
  workspacePackages?: WorkspacePackage[] | null;
  /**
   * The TypeScript/JavaScript path aliases (`compilerOptions.paths`, `baseUrl`) declared at
   * the root and above the changed files. `@infra/db` looks like a published package; where
   * a tsconfig maps it into the repository it is the project's own code. Absent or empty:
   * no config declares any.
   */
  importPathScopes?: ImportPathScope[];
}

export interface StandardsRuleOutcome {
  rule: StandardsRuleId | 'command';
  result: RuleResult;
  /**
   * Whether a failure of this rule stops a release. Every row the checker writes carries
   * it; a row without one (a report stored before severities existed) is `blocking`.
   * Profile commands are always blocking.
   */
  severity?: RuleSeverity;
  /**
   * Set on a `not-checked` row when the rule met changed files it could not read or
   * decide — as opposed to not being configured or finding nothing in scope. On a
   * blocking rule this is the case a reader must not miss.
   */
  undecided?: boolean;
  /**
   * Set on a `not-checked` row when the profile simply does not configure the rule. Such a
   * row is no gap in a check: {@link standardsBlockingEvaluated} leaves it out.
   */
  unconfigured?: boolean;
  /** Why the rule was not checked — or, on a decided rule, which changed files it left out. */
  reason?: string;
  /** `command` rows only: the command exactly as it ran. */
  command?: string;
  exitCode?: number;
  /** `command` rows only: the end of its output. */
  tail?: string;
}

export interface StandardsFinding {
  file: string;
  line: number;
  rule: StandardsRuleId;
  message: string;
  /** The severity of the rule that produced it; absent means `blocking`. */
  severity?: RuleSeverity;
}

/** One changed file the line rules did not read, and why. Never evidence for "no findings". */
export interface StandardsNotCheckedFile {
  file: string;
  reason: string;
}

export interface StandardsTotals {
  /** Commands that passed. A rule MOAG decides itself is never counted here. */
  passed: number;
  /** Static rules that read something and found nothing. Not a pass: a scan can miss. */
  noFindings: number;
  /** BLOCKING rules (and commands) that failed or have findings. Anything above zero stops a release. */
  failed: number;
  /** Advisory rules with findings. Reported, counted, never blocking. */
  advisory: number;
  notChecked: number;
  /** Blocking rules and commands the profile configures that ended not checked. Anything above zero stops a release. */
  blockingNotChecked: number;
  /** The true number of findings, blocking and advisory, even when the list itself was capped. */
  findings: number;
  /** The true number of advisory findings among them. */
  advisoryFindings: number;
  /** The true number of changed files listed as not checked, even when that list was capped. */
  notCheckedFiles: number;
}

export interface StandardsReport {
  /** The profile version checked against; set by the caller, which is the one that knows it. */
  version: number | null;
  /** The ref the diff was taken against, so a reader can tell when legacy code was in scope. */
  baseRef: string | null;
  rules: StandardsRuleOutcome[];
  findings: StandardsFinding[];
  /**
   * The changed files the line rules did not read — vendored, generated, no lexer for the
   * language, unreadable — each with its reason. Absent on a report written before the list
   * existed; `totals.notCheckedFiles` is the true count when the list was capped.
   */
  notCheckedFiles?: StandardsNotCheckedFile[];
  totals: StandardsTotals;
}

/** Caps applied to a report that crosses a process boundary. */
export const MAX_REPORT_FINDINGS = 200;
export const MAX_REPORT_NOT_CHECKED_FILES = 200;
export const MAX_REPORT_TAIL_CHARS = 2_000;
const MAX_REPORT_RULES = 40;
const MAX_REPORT_TEXT_CHARS = 500;
const MAX_REPORT_PATH_CHARS = 1_000;

const NOT_CONFIGURED = 'Not configured in this profile';
const NO_DIFF = 'No diff could be taken (not a git repository, or the base ref is unknown)';
const NOTHING_TO_CHECK = 'The diff holds nothing for this rule to check';
/**
 * Every rule needs git's view of the tree: the diff for most, git's listing of the paths
 * for required directories and nested repositories. Without it none is decided.
 */
const DIFF_RULES: readonly StandardsRuleId[] = STANDARDS_RULE_IDS;
/** Why a nested repository or a submodule is listed among the files not checked. */
export const NESTED_REPO_NOT_READ = 'nested repository — files inside were not read';
export const SUBMODULE_NOT_READ = 'submodule — files inside were not read';

/**
 * Where the BLOCKING SET of a report stands — the commands, and any scanner rule a project
 * promoted and configured:
 *
 *   - `not-checked`: a blocking row ended NOT CHECKED — a command never ran, or a promoted
 *     rule could not read what it had to, had no diff, or found nothing in the change to
 *     judge. Whatever the reason, a blocking row with no result is not a pass: a release
 *     must stop.
 *   - `none-configured`: the profile has no command and no promoted rule. Nothing can stop a
 *     release, so one may ship — and must be said to have had NO BLOCKING RULES CONFIGURED,
 *     never to have passed.
 *   - `evaluated`: there is a blocking set and none of it was left unevaluated.
 *
 * What an advisory rule managed to read does not enter into it. A blocking rule the profile
 * does not configure is no gap: with nothing configured it can stop nothing. Every other
 * not-checked blocking row is one — no reason is weighed, so there is nothing to argue about.
 * (A promoted scan therefore stops a change that gives it nothing to judge; a command, which
 * always runs, does not have that problem. It is one more reason to block on commands.)
 */
export type BlockingSetState = 'evaluated' | 'none-configured' | 'not-checked';

/** A blocking row the profile configures that ended not checked, for whatever reason. */
export function isBlockingNotChecked(row: StandardsRuleOutcome): boolean {
  return row.result === 'not-checked' && severityOf(row) === 'blocking' && row.unconfigured !== true;
}

/** See {@link BlockingSetState}. */
export function standardsBlockingState(report: StandardsReport): BlockingSetState {
  if (report.rules.some(isBlockingNotChecked)) { return 'not-checked'; }
  const blocking = report.rules.filter((r) => severityOf(r) === 'blocking' && r.unconfigured !== true);
  return blocking.length === 0 ? 'none-configured' : 'evaluated';
}

/** What every surface says in place of a result when a profile has no blocking set. */
export const NO_BLOCKING_RULES = 'no blocking rules configured';

/**
 * True when the report has a blocking set and all of it was evaluated. A caller must not
 * say a release was checked against a standards version without it; with no blocking set
 * ({@link standardsBlockingState} `none-configured`) the words are {@link NO_BLOCKING_RULES}.
 */
export function standardsBlockingEvaluated(report: StandardsReport): boolean {
  return standardsBlockingState(report) === 'evaluated';
}

/**
 * What a check left open beside its result, as the requirement trace records it next to
 * the standards row and on the release stamp: the advisory findings, the rules the profile
 * configures that were not checked, and the changed files no line rule read. Numbers only.
 */
export function standardsCheckCounts(report: StandardsReport): StandardsCheckCounts {
  return {
    advisoryFindings: report.totals.advisoryFindings,
    notCheckedRules: report.rules.filter((r) => r.result === 'not-checked' && r.unconfigured !== true).length,
    notCheckedFiles: report.totals.notCheckedFiles,
    // Said only when it is so: the check had nothing that could stop a release.
    ...(standardsBlockingState(report) === 'none-configured' ? { noBlockingRules: true as const } : {}),
  };
}

/** How a rule's outcome is worded for a reader. The stored result is never shown as-is. */
export type RuleOutcomeLabel = 'passed' | 'failed' | 'no findings' | 'findings' | 'not checked';

/**
 * The words for one row. "passed" / "failed" only for a profile command; every rule MOAG
 * decides itself says "no findings" / "findings" — finding nothing is not proof that
 * nothing is there.
 */
export function ruleOutcomeLabel(row: Pick<StandardsRuleOutcome, 'rule' | 'result'>): RuleOutcomeLabel {
  if (row.result === 'not-checked') { return 'not checked'; }
  if (isScannerRule(row.rule)) { return row.result === 'failed' ? 'findings' : 'no findings'; }
  return row.result;
}

/**
 * The static rules this report holds as BLOCKING — a project promoted them, since none is
 * blocking by default. Every surface that shows a report names them, because a heuristic
 * that can stop a release can stop a correct one.
 */
export function promotedScannerRules(report: StandardsReport): StandardsRuleId[] {
  return report.rules
    .filter((r) => r.rule !== 'command' && isScannerRule(r.rule) && severityOf(r) === 'blocking' && r.unconfigured !== true)
    .map((r) => r.rule as StandardsRuleId);
}

/** What every surface says beside a promoted scanner rule. */
export const SCANNER_PROMOTION_WARNING =
  'Scanner rules are heuristic: as blocking rules they can stop correct code and they can miss real violations.';

/** The severity a row or finding carries; one written before severities existed is blocking. */
export function severityOf(row: { severity?: RuleSeverity }): RuleSeverity {
  return row.severity === 'advisory' ? 'advisory' : 'blocking';
}

/** True when a BLOCKING rule or command failed: the one condition that stops a release. */
export function standardsBlocked(report: StandardsReport): boolean {
  return report.rules.some((r) => r.result === 'failed' && severityOf(r) === 'blocking');
}

/** The report's rows in the three groups every surface shows: Blocking, Advisory, Not checked. */
export function groupStandardsRules(report: StandardsReport): {
  blocking: StandardsRuleOutcome[]; advisory: StandardsRuleOutcome[]; notChecked: StandardsRuleOutcome[];
} {
  const decided = report.rules.filter((r) => r.result !== 'not-checked');
  return {
    blocking: decided.filter((r) => severityOf(r) === 'blocking'),
    advisory: decided.filter((r) => severityOf(r) === 'advisory'),
    // Blocking rules and commands that were not checked come first: they are the ones a reader must see.
    notChecked: report.rules.filter((r) => r.result === 'not-checked')
      .sort((a, b) => Number(isBlockingNotChecked(b)) - Number(isBlockingNotChecked(a))),
  };
}

/** A blocking static rule that is not-checked because it could not read or decide changed files. */
export function isUnreadBlocking(row: StandardsRuleOutcome): boolean {
  return row.rule !== 'command' && row.undecided === true && isBlockingNotChecked(row);
}

// ─── Per-file preparation ───

/**
 * Extensions that hold data, prose or assets rather than source code. The
 * comment, layering and raw-pattern rules do not apply to them at all. Any
 * OTHER extension without a lexer is source the checker cannot read, and is
 * reported as not checked.
 */
const NON_SOURCE_EXTENSIONS = new Set([
  'json', 'jsonc', 'md', 'mdx', 'txt', 'rst', 'lock', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'csv', 'tsv', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'woff', 'woff2', 'ttf', 'eot',
  'map', 'snap', 'log', 'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'sum', 'mod', 'sln',
  'csproj', 'props', 'targets', 'gradle', 'kts', 'properties', 'webmanifest', 'zip', 'gz', 'typed',
]);

/**
 * Files with no extension that are prose or build configuration by NAME. An
 * extensionless file is not out of scope merely for having no extension: one
 * that opens with a shebang is a script the checker cannot read.
 */
const NON_SOURCE_NAMES = /^(?:LICEN[SC]E|COPYING|NOTICE|AUTHORS|CONTRIBUTORS|CODEOWNERS|CHANGELOG|README|VERSION|CNAME|Dockerfile|Containerfile|Makefile|GNUmakefile|Procfile|Pipfile)$/;
const NO_EXTENSION = 'No checker for files without an extension';

/**
 * Top-level directories whose content is someone else's code, copied in by a package tool.
 * Only the repository ROOT is trusted by name: `src/vendor/` or `app/node_modules/` may be
 * the project's own code under an unlucky name, and is judged unless the repository itself
 * marks the directory as third-party (see `StandardsCheckInput.vendorRoots`).
 */
const VENDORED_ROOTS = new Set(['vendor', 'node_modules', 'third_party']);
/** Source file names a tool writes: protobuf for Go, source generators and designers for C#. */
const GENERATED_NAMES = /(?:\.pb\.go|\.g\.cs|\.Designer\.cs)$/;
/**
 * The Maven and Gradle wrapper scripts every generated Java project carries. The exact
 * names only, and none has an extension a lexer reads — so, unlike a generated marker or
 * a `.pb.go` suffix, the name cannot be put on source code to keep a rule away from it.
 */
const WRAPPER_SCRIPT_NAMES = /^(?:mvnw|mvnw\.cmd|gradlew|gradlew\.bat)$/;
/** The markers generators put at the top of their output. */
const GENERATED_MARKERS = [/\bCode generated\b.*\bDO NOT EDIT\b/, /@generated\b/, /<auto-generated\b/i];
/** How far into a file a generated marker is looked for. */
const GENERATED_MARKER_LINES = 5;
/** What a comment line starts with, for files no lexer reads. */
const COMMENT_LEADER = /^\s*(?:\/\/+|\/\*+|\*+|#+|<!--|--|;+)(.*)$/;

/**
 * The manifests that mark a sibling directory as third-party code: a `node_modules` beside
 * a `package.json`, a `vendor` beside a `go.mod`, `composer.json` or `Gemfile`. The evidence
 * collector recognises vendor roots by them; the checker uses the same list to tell a root
 * the repository already had from one the change under review created.
 */
export const VENDOR_MANIFESTS: Readonly<Record<string, readonly string[]>> = {
  node_modules: ['package.json'],
  vendor: ['go.mod', 'composer.json', 'Gemfile'],
};

/** Why a changed file is left out of the name-based and line-based rules. */
interface LeftOut {
  kind: 'vendored' | 'generated';
  /**
   * True when the change under review is what makes the file exempt: it added (or moved in)
   * the file, wrote the generated marker, or added the manifest that turns its directory
   * into a vendor root. The party being checked authored that exemption, so a BLOCKING rule
   * that honours it has not checked the file and must say so — never report a pass.
   * False when the file was already vendored or generated at the base ref.
   */
  byChange: boolean;
  /** The line of the generated marker, when a marker (not a name or a directory) is what exempts the file. */
  markerLine?: number;
}

/** What `leftOutReason` needs to know about the diff as a whole. */
interface VendorContext {
  /** Vendor roots below the repository root that the repository marks with a manifest. */
  roots: string[];
  /** The subset of `roots` whose manifest this change added or moved in. */
  newRoots: ReadonlySet<string>;
}

/**
 * Why a changed file is nobody's hand-written code — vendored or generated — or
 * null when it is. Such a file is left out of the name-based and line-based rules:
 * its names and comments were chosen by a tool or by another project.
 *
 * A generated marker counts only inside a COMMENT in the first lines. The same words in
 * a string literal (`const banner = "@generated"`) exempt nothing.
 */
function leftOutReason(file: StandardsCheckFile, path: string, raw: string[], lex: LexResult, vendor: VendorContext): LeftOut | null {
  const segments = path.split('/');
  // A `modified` file existed at the base under this very path; anything else is new here.
  const isNew = file.status !== 'modified';
  if (segments.length > 1 && VENDORED_ROOTS.has(segments[0])) { return { kind: 'vendored', byChange: isNew }; }
  const root = vendor.roots.find((r) => path !== r && isUnder(path, r));
  if (root !== undefined) { return { kind: 'vendored', byChange: isNew || vendor.newRoots.has(root) }; }
  if (WRAPPER_SCRIPT_NAMES.test(segments[segments.length - 1])) { return { kind: 'generated', byChange: false }; }
  if (GENERATED_NAMES.test(segments[segments.length - 1])) { return { kind: 'generated', byChange: isNew }; }
  for (let n = 0; n < Math.min(GENERATED_MARKER_LINES, raw.length); n++) {
    const comment = lex.ok ? (lex.lines[n]?.comment ?? '') : (COMMENT_LEADER.exec(raw[n])?.[1] ?? '');
    if (comment !== '' && GENERATED_MARKERS.some((re) => re.test(comment))) {
      return { kind: 'generated', byChange: isNew || file.addedLines.includes(n + 1), markerLine: n + 1 };
    }
  }
  return null;
}

/** The recognised vendor roots whose marking manifest is itself new in this change. */
function newVendorRoots(roots: string[], files: StandardsCheckFile[]): Set<string> {
  const brought = new Set(files.filter((f) => f.status !== 'modified').map((f) => normalizePath(f.path)));
  const out = new Set<string>();
  for (const root of roots) {
    const cut = root.lastIndexOf('/');
    const parent = cut < 0 ? '' : root.slice(0, cut + 1);
    const manifests = VENDOR_MANIFESTS[root.slice(cut + 1)] ?? [];
    if (manifests.some((m) => brought.has(parent + m))) { out.add(root); }
  }
  return out;
}

interface Prepared {
  file: StandardsCheckFile;
  path: string;
  ext: string;
  isSource: boolean;
  lex: LexResult;
  /** Raw lines of the new file (empty when it was not read). */
  raw: string[];
  /** Set when the file is vendored or generated: the name-based and line-based rules leave it out. */
  leftOut: LeftOut | null;
}

function prepare(file: StandardsCheckFile, vendor: VendorContext): Prepared {
  const path = normalizePath(file.path);
  const ext = fileExtension(path);
  const name = path.split('/').pop() ?? '';
  const raw = file.content === null ? [] : file.content.replace(/\r\n?/g, '\n').split('\n');
  // No extension: prose and build files by name are out of scope; a script (shebang) is
  // source this checker cannot read; anything else is not known to be code.
  const script = ext === '' && !NON_SOURCE_NAMES.test(name) && (raw[0] ?? '').startsWith('#!');
  const isSource = ext === '' ? script : !NON_SOURCE_EXTENSIONS.has(ext);
  if (file.content === null) {
    // Unread and extensionless: it may be a script, so it is undecided rather than out of scope.
    const maybeSource = isSource || (ext === '' && !NON_SOURCE_NAMES.test(name));
    const lex: LexResult = { ok: false, reason: file.skipped ?? 'File could not be read' };
    return { file, path, ext, isSource: maybeSource, lex, raw, leftOut: leftOutReason(file, path, raw, lex, vendor) };
  }
  const lex: LexResult = script ? { ok: false, reason: NO_EXTENSION }
    : isSource ? lexFile(path, file.content) : { ok: false, reason: 'Not a source file' };
  return { file, path, ext, isSource, lex, raw, leftOut: leftOutReason(file, path, raw, lex, vendor) };
}

/** Appended to a finding in a version of a file that is not the one in the working tree. */
const ORIGIN_NOTE: Record<NonNullable<StandardsCheckFile['origin']>, string> = {
  committed: ' (in the committed version; the working tree no longer matches it)',
  staged: ' (in the staged version; the working tree no longer matches it)',
};

/** Collects, per rule, the findings and the reasons some files could not be decided. */
class RuleLog {
  readonly findings: StandardsFinding[] = [];
  private readonly reasons = new Map<StandardsRuleId, string[]>();
  private readonly unconfigured = new Set<StandardsRuleId>();
  private readonly evaluated = new Set<StandardsRuleId>();
  private readonly omitted = new Map<StandardsRuleId, string[]>();

  constructor(private readonly profile: StandardsProfile) {}

  /**
   * Record that a rule really judged something: an added file for the name-based
   * rules, added lines it could read for the line-based ones. A rule that never
   * gets here has no evidence either way and is reported as not checked.
   */
  saw(...rules: StandardsRuleId[]): void {
    for (const rule of rules) { this.evaluated.add(rule); }
  }

  find(rule: StandardsRuleId, file: string, line: number, message: string): void {
    this.findings.push({ file, line, rule, message, severity: ruleSeverity(this.profile, rule) });
  }

  /** A finding in a changed file. One in a committed-only version says so. */
  findIn(rule: StandardsRuleId, file: Prepared, line: number, message: string): void {
    this.find(rule, file.path, line, file.file.origin === undefined ? message : message + ORIGIN_NOTE[file.file.origin]);
  }

  undecided(rule: StandardsRuleId, reason: string): void {
    const list = this.reasons.get(rule) ?? [];
    if (!list.includes(reason)) { list.push(reason); }
    this.reasons.set(rule, list);
  }

  notConfigured(rule: StandardsRuleId): void {
    this.unconfigured.add(rule);
  }

  /**
   * Record that a rule left a vendored or generated file out. The file is neither
   * judged nor counted as evidence: the outcome names it instead, whatever the result.
   *
   * When the change itself made the file exempt (it added the file, the marker or the
   * manifest), a BLOCKING rule has not checked something the change wrote. That is
   * undecided — `not-checked`, named, counted in `blockingNotChecked` — never a pass with
   * a footnote: one comment line must not switch a blocking rule off quietly. An advisory
   * rule, and any rule on a file that was already exempt at the base, only notes it.
   */
  leftOut(file: Prepared, ...rules: StandardsRuleId[]): void {
    for (const rule of rules) {
      if (file.leftOut?.byChange && ruleSeverity(this.profile, rule) === 'blocking') {
        const why = file.leftOut.kind === 'vendored' ? 'this change added it as vendored code' : 'this change added it, or marked it, as generated';
        this.undecided(rule, `Not checked: ${why} (${file.path})`);
        continue;
      }
      const list = this.omitted.get(rule) ?? [];
      if (!list.includes(file.path)) { list.push(file.path); }
      this.omitted.set(rule, list);
    }
  }

  /** "3 vendored or generated files not checked (a, b and 1 more)", or '' when the rule left none out. */
  private omittedNote(rule: StandardsRuleId): string {
    const list = this.omitted.get(rule) ?? [];
    if (list.length === 0) { return ''; }
    const shown = list.slice(0, 2).join(', ') + (list.length > 2 ? ` and ${list.length - 2} more` : '');
    return `${list.length} vendored or generated file${list.length === 1 ? '' : 's'} not checked (${shown})`.slice(0, MAX_REPORT_TEXT_CHARS);
  }

  outcome(rule: StandardsRuleId): StandardsRuleOutcome {
    const severity = ruleSeverity(this.profile, rule);
    if (this.unconfigured.has(rule)) { return { rule, severity, result: 'not-checked', unconfigured: true, reason: NOT_CONFIGURED }; }
    const note = this.omittedNote(rule);
    const noted = note ? { reason: note } : {};
    const undecided = this.reasons.get(rule) ?? [];
    if (this.findings.some((f) => f.rule === rule)) {
      // Failed is failed; what the rule could not read beside it is still worth naming.
      const beside = [...undecided.slice(0, 2), ...(note ? [note] : [])].join('; ').slice(0, MAX_REPORT_TEXT_CHARS);
      return { rule, severity, result: 'failed', ...(beside ? { reason: beside } : {}) };
    }
    if (undecided.length > 0) {
      // The rule met input it could not read or decide. Never a pass, whatever its severity.
      const reasons = note ? [...undecided, note] : undecided;
      const shown = reasons.slice(0, 3).join('; ');
      const more = reasons.length > 3 ? `; and ${reasons.length - 3} more` : '';
      return { rule, severity, result: 'not-checked', undecided: true, reason: (shown + more).slice(0, MAX_REPORT_TEXT_CHARS) };
    }
    // Nothing but left-out files is not evidence: the rule judged no hand-written code.
    if (!this.evaluated.has(rule)) { return { rule, severity, result: 'not-checked', reason: note || NOTHING_TO_CHECK }; }
    return { rule, severity, result: 'passed', ...noted };
  }
}

// ─── Structure ───

function checkRequiredDirs(profile: StandardsProfile, input: StandardsCheckInput, log: RuleLog): void {
  const rule = 'structure/required-dirs';
  if (profile.structure.requiredDirs.length === 0) { log.notConfigured(rule); return; }
  // Without git's listing of the tree there is nothing to compare with: not checked.
  if (input.baseRef === null) { return; }
  log.saw(rule);
  const existing = new Set(input.existingDirs.map(normalizePath));
  for (const dir of profile.structure.requiredDirs) {
    if (!existing.has(normalizePath(dir))) {
      log.find(rule, normalizePath(dir), 1, `Required directory ${normalizePath(dir)} does not exist`);
    }
  }
}

/**
 * A directory that is a repository of its own hides everything inside it: git lists it as
 * one entry, so no file in it reached any rule. Each one the tree holds NOW that no tracked
 * `.gitmodules` declares is a finding naming the directory, whenever it got there — the rule
 * reads the state of the tree, not the diff — and is listed among the files not checked.
 * A declared submodule is only listed there: it is not a finding.
 */
function checkNestedRepos(input: StandardsCheckInput, log: RuleLog): void {
  const rule = 'structure/nested-repository';
  // Without git's listing of the tree nothing is known about it: not checked.
  if (input.baseRef === null) { return; }
  log.saw(rule);
  for (const dir of nestedRepoDirs(input)) {
    log.find(rule, dir, 1,
      `${dir} is a git repository of its own that no tracked .gitmodules declares, so none of its files were read; ` +
      'remove its .git so its files are part of this repository, declare it as a submodule, or delete it');
  }
}

/** The undeclared nested repositories of the tree, normalised, deduplicated and sorted. */
function nestedRepoDirs(input: StandardsCheckInput): string[] {
  return [...new Set((input.nestedRepos ?? []).map(normalizePath))].sort();
}

/** The declared submodules of the tree that are not also listed as undeclared, sorted. */
function submoduleDirs(input: StandardsCheckInput): string[] {
  const nested = new Set(nestedRepoDirs(input));
  return [...new Set((input.submodules ?? []).map(normalizePath))].filter((dir) => !nested.has(dir)).sort();
}

// ─── Exemptions ───

/** Why the line rules did not read a changed file, in the words the report lists it under. */
function notCheckedReason(f: Prepared): string | null {
  // A file nothing would have been read from anyway — an existing path with no added
  // line — is not an exemption: there was nothing in it for a rule to look at.
  const inScope = f.file.content === null || f.file.status !== 'modified' || f.file.addedLines.length > 0;
  if (!inScope) { return null; }
  if (f.leftOut) {
    if (f.leftOut.kind === 'vendored') { return f.leftOut.byChange ? 'vendored code, added by this change' : 'vendored code'; }
    return f.leftOut.byChange ? 'generated file, added or newly marked by this change' : 'generated file';
  }
  const unsupported = unsupportedType(f);
  if (unsupported !== null) { return unsupported; }
  if (f.isSource && !f.lex.ok) { return f.lex.reason; }
  return null;
}

/**
 * File types that hold code or configuration a project is built from, and that no scanner
 * here reads: build scripts, shell scripts, component and stylesheet dialects, pipeline and
 * tool configuration. A changed file of such a type is LISTED as not checked — never left
 * out in silence, as plain data and prose (`.json`, `.md`, an image) are.
 */
const UNSUPPORTED_EXTENSIONS = new Set([
  'gradle', 'kts', 'mdx', 'svg', 'vue', 'svelte', 'scss', 'sass', 'less', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml',
]);
/** The same, for files named by convention rather than by extension. */
const UNSUPPORTED_NAMES = /^(?:(?:Dockerfile|Containerfile)(?:\..+)?|(?:GNU)?[Mm]akefile)$/;

/** "unsupported type (.vue)" for a changed file of a type no scanner reads, else null. */
function unsupportedType(f: Prepared): string | null {
  const name = f.path.split('/').pop() ?? '';
  if (UNSUPPORTED_NAMES.test(name)) { return `unsupported type (${name.split('.')[0]})`; }
  if (UNSUPPORTED_EXTENSIONS.has(f.ext)) { return `unsupported type (.${f.ext})`; }
  // A script with no extension is told by its shebang.
  if (f.ext === '' && !f.lex.ok && f.lex.reason === NO_EXTENSION && f.isSource && f.file.content !== null) { return 'unsupported type (script without an extension)'; }
  return null;
}

/**
 * Every changed file the line rules did not read, and every directory of the tree that is a
 * repository of its own (nothing inside one is ever read), sorted, one entry per path and reason.
 */
function collectNotCheckedFiles(files: Prepared[], input: StandardsCheckInput): StandardsNotCheckedFile[] {
  const seen = new Set<string>();
  const out: StandardsNotCheckedFile[] = [];
  for (const dir of nestedRepoDirs(input)) { out.push({ file: dir, reason: NESTED_REPO_NOT_READ }); }
  for (const dir of submoduleDirs(input)) { out.push({ file: dir, reason: SUBMODULE_NOT_READ }); }
  for (const f of files) {
    const reason = notCheckedReason(f);
    if (reason === null) { continue; }
    const file = f.file.origin === undefined ? f.path : `${f.path}${ORIGIN_NOTE[f.file.origin]}`;
    const key = `${file}\n${reason}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push({ file, reason: reason.slice(0, MAX_REPORT_TEXT_CHARS) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.reason.localeCompare(b.reason));
}

/**
 * A file this change MARKED as generated — it wrote the marker comment, on a new file or
 * onto an existing one — is reported as a finding of its own, on the marker's line.
 * Whatever the other rules would have said about the file, they did not read it; the one
 * thing certain is that the party being checked wrote the line that exempts it.
 *
 * A file exempt by its NAME (`*.pb.go`, `*.Designer.cs`) or by its directory (`vendor/`)
 * carries no marker anybody wrote: it is listed as not checked, with the reason, and is no
 * finding — a protobuf regeneration that adds a file is not something to report each time.
 */
function checkNewlyGenerated(files: Prepared[], log: RuleLog): void {
  const rule = 'exemption/newly-generated';
  for (const f of files) {
    log.saw(rule);
    if (f.leftOut?.kind !== 'generated' || !f.leftOut.byChange || f.leftOut.markerLine === undefined) { continue; }
    log.findIn(rule, f, f.leftOut.markerLine,
      'Newly marked generated in this change, so no other rule read this file; confirm a tool really writes it');
  }
}

function checkTopLevel(profile: StandardsProfile, input: StandardsCheckInput, files: Prepared[], log: RuleLog): void {
  const rule = 'structure/top-level';
  const allowed = profile.structure.allowedTopLevel;
  if (allowed.length === 0) { log.notConfigured(rule); return; }
  const preexisting = new Set(input.topLevel.map(normalizePath));
  const seen = new Set<string>();
  for (const f of files) {
    if (f.file.status === 'modified') { continue; }
    log.saw(rule);
    const entry = f.path.split('/')[0];
    if (preexisting.has(entry) || seen.has(entry)) { continue; }
    seen.add(entry);
    const match = matchesAny(entry, allowed);
    if (match === null) {
      log.undecided(rule, `An allowed top-level pattern could not be read (${entry})`);
    } else if (!match) {
      log.findIn(rule, f, 1, `New top-level entry ${entry} is not in the allowed layout`);
    }
  }
}

function checkPlacement(profile: StandardsProfile, files: Prepared[], log: RuleLog): void {
  const rule = 'structure/placement';
  const rules = profile.structure.placement;
  if (rules.length === 0) { log.notConfigured(rule); return; }
  for (const f of files) {
    // A file the change added or moved has a path the change chose. A modified one does not.
    if (f.file.status === 'modified') { continue; }
    if (f.leftOut) { log.leftOut(f, rule); continue; }
    log.saw(rule);
    for (const r of rules) {
      const re = globToRegExp(r.files);
      if (!re) { log.undecided(rule, `Placement pattern ${r.id} could not be read`); continue; }
      if (!re.test(f.path)) { continue; }
      if (!r.under.some((dir) => isUnder(f.path, dir))) {
        log.findIn(rule, f, 1, `Files matching ${r.files} belong under ${r.under.join(', ')}`);
      }
    }
  }
}

// ─── Naming ───

/** What a file name's stem (the part before its first dot) looks like in each style. */
export const NAMING_PATTERNS: Record<NamingStyle, RegExp> = {
  'kebab-case': /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'camelCase': /^[a-z][A-Za-z0-9]*$/,
  'PascalCase': /^[A-Z][A-Za-z0-9]*$/,
  'snake_case': /^_*[a-z0-9]+(?:_[a-z0-9]+)*_*$/,
};

/**
 * File names a tool dictates. The author did not choose them, so no naming style
 * applies: Java's `package-info.java` and `module-info.java`, EF Core migrations
 * (`20240101120000_InitialCreate.cs`), minified bundles (`*.min.js`) and
 * framework route files (`[id].ts`, `[...slug].tsx`).
 */
const TOOL_DICTATED_NAMES: RegExp[] = [
  /^(?:package|module)-info\.java$/,
  /^\d{8,14}_\w+(?:\.Designer)?\.cs$/,
  /\.min\.(?:js|css)$/,
  /^\[.+\]\.[A-Za-z]+$/,
];

function checkNaming(profile: StandardsProfile, files: Prepared[], log: RuleLog): void {
  const rule = 'naming/files';
  const rules = profile.naming.files;
  if (rules.length === 0) { log.notConfigured(rule); return; }
  for (const f of files) {
    // Renaming legacy files is not this change's job: only names it chose (added or moved to) are judged.
    if (f.file.status === 'modified') { continue; }
    if (f.leftOut) { log.leftOut(f, rule); continue; }
    log.saw(rule);
    const name = f.path.split('/').pop() ?? '';
    const stem = name.split('.')[0];
    if (stem.length === 0 || TOOL_DICTATED_NAMES.some((re) => re.test(name))) { continue; }
    for (const r of rules) {
      const match = matchesAny(f.path, r.globs);
      if (match === null) { log.undecided(rule, `A naming pattern could not be read (${f.path})`); continue; }
      if (!match) { continue; }
      if (!NAMING_PATTERNS[r.style].test(stem)) {
        log.findIn(rule, f, 1, `File name ${name} is not ${r.style}`);
      }
      break;
    }
  }
}

// ─── Frontend raw patterns ───

const BUILTIN_PATTERNS: Record<string, RegExp> = {
  'hex-color': /(?:^|[^&.\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_])/,
  'css-color-function': /\b(?:rgba?|hsla?)\s*\(/i,
  'inline-style': /\bstyle\s*=\s*["'{]/i,
};

function checkRawPatterns(profile: StandardsProfile, files: Prepared[], log: RuleLog): void {
  const rule = 'frontend/raw-pattern';
  const patterns = profile.frontend.rawPatterns;
  if (patterns.length === 0) { log.notConfigured(rule); return; }
  for (const f of files) {
    if (f.leftOut) { log.leftOut(f, rule); continue; }
    if (f.file.content !== null && f.file.addedLines.length > 0) { log.saw(rule); }
    for (const p of patterns) {
      const inScope = p.globs.length === 0 ? true : matchesAny(f.path, p.globs);
      if (inScope === null) { log.undecided(rule, `Pattern ${p.id} has a file pattern that could not be read`); continue; }
      if (!inScope) { continue; }
      // A file that was not read may hold anything: undecided, whatever the diff said about it.
      if (f.file.content === null) { log.undecided(rule, `${f.lex.ok ? '' : f.lex.reason} (${f.path})`); continue; }
      if (f.file.addedLines.length === 0) { continue; }
      const builtin = p.kind === 'builtin' ? BUILTIN_PATTERNS[p.value] : undefined;
      if (p.kind === 'builtin' && !builtin) { log.undecided(rule, `Unknown built-in pattern ${p.value}`); continue; }
      for (const n of f.file.addedLines) {
        // Comments are excluded where a lexer exists; otherwise the literal text of the line is all there is.
        const text = f.lex.ok ? f.lex.lines[n - 1]?.code : f.raw[n - 1];
        if (text === undefined) { continue; }
        if (builtin ? builtin.test(text) : text.includes(p.value)) {
          log.findIn(rule, f, n, p.message);
        }
      }
    }
  }
}

// ─── Layering ───

const JS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);
const JS_RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

/** Join `spec` onto `fromDir`, collapsing `.` and `..`. Null when it climbs out of the repository. */
function resolveRelative(fromDir: string, spec: string): string | null {
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') { continue; }
    if (seg === '..') {
      if (parts.length === 0) { return null; }
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** What one line of code imports. */
interface ImportRead {
  specs: string[];
  /**
   * Python only: the module of a `from <module> import …` whose imported names could
   * not be read on this line (`*`, or a list that continues on later lines). Any of
   * those names may be a submodule, so what the line reaches is not fully known.
   */
  openModule?: string;
  /** Python only: `specs[0]` is the module of a `from … import` and the rest are its names, all read. */
  namedFrom?: boolean;
}

/**
 * Python's `from <module> import a, b as c`: the module, then each name as a
 * submodule of it — `from .. import db` reaches the package `db`, not just its parent.
 */
function pythonFromImport(module: string, list: string): ImportRead {
  const specs = [module];
  const body = list.trim();
  const inner = /^\((.*)\)$/.exec(body);
  const names = (inner ? inner[1] : body).split(',').map((part) => part.trim()).filter((part) => part !== '');
  const readable = names.length > 0 && names.every((part) => /^[A-Za-z_]\w*(?:\s+as\s+[A-Za-z_]\w*)?$/.test(part));
  if (!readable) { return { specs, openModule: module }; }
  for (const part of names) {
    specs.push(`${module}${module.endsWith('.') ? '' : '.'}${part.split(/\s+/)[0]}`);
  }
  return { specs, namedFrom: true };
}

/** Import specifiers written on one line of code, by language. Null when the language has no reader. */
function importSpecifiers(ext: string, code: string): ImportRead | null {
  if (JS_EXTENSIONS.has(ext)) {
    const out: string[] = [];
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
    for (let m = re.exec(code); m; m = re.exec(code)) { out.push(m[2]); }
    return { specs: out };
  }
  if (ext === 'py') {
    const from = /^\s*from\s+([.\w]+)\s+import\b(.*)$/.exec(code);
    if (from) { return pythonFromImport(from[1], from[2]); }
    const plain = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(code);
    return { specs: plain ? plain[1].split(',').map((s) => s.trim()) : [] };
  }
  if (ext === 'go') {
    const m = /^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"\s*$/.exec(code);
    return { specs: m ? [m[1]] : [] };
  }
  if (ext === 'java') {
    const m = /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;/.exec(code);
    return { specs: m ? [m[1]] : [] };
  }
  return null;
}

/** What the importing file is, for telling the project's own code apart from a package. */
interface ImportContext {
  ext: string;
  filePath: string;
  layers: StandardsProfile['backend']['layers'];
  aliases: StandardsProfile['backend']['importAliases'];
  goModulePath: string | null;
  /** The file's own `package` (Java), or null when it declares none. */
  ownPackage: string | null;
  /** The workspace's packages; null when a workspace is declared but could not be read. */
  workspacePackages: WorkspacePackage[] | null;
  /** The path-alias scopes whose directory holds the importing file. */
  pathScopes: ImportPathScope[];
}

/** A specifier that names something Node itself provides, never a package in the repository. */
const NODE_BUILTIN = /^node:/;

/**
 * The repository paths `spec` maps to through a tsconfig `paths` entry, or null when no
 * entry matches. As the compiler does, the pattern with the longest prefix wins. The bare
 * `*` pattern — which is also how a `baseUrl` is carried — is matched only when `catchAll`
 * is set: it matches every specifier, published packages included, so it is a fallback.
 */
function viaPathScopes(spec: string, scopes: ImportPathScope[], catchAll: boolean): string[] | null {
  let best: { prefix: number; targets: string[] } | null = null;
  for (const scope of scopes) {
    for (const alias of scope.aliases ?? []) {
      if ((alias.pattern === '*') !== catchAll) { continue; }
      const star = alias.pattern.indexOf('*');
      let matched: string;
      if (star < 0) {
        if (spec !== alias.pattern) { continue; }
        matched = '';
      } else {
        const prefix = alias.pattern.slice(0, star);
        const suffix = alias.pattern.slice(star + 1);
        if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) { continue; }
        matched = spec.slice(prefix.length, spec.length - suffix.length);
      }
      const prefix = star < 0 ? alias.pattern.length : star;
      const targets = alias.targets.map((t) => normalizePath(t.replace('*', matched)));
      if (best === null || prefix > best.prefix) {
        best = { prefix, targets };
      } else if (prefix === best.prefix) {
        // The same pattern in two configs (root and a package's own): either may apply.
        best.targets.push(...targets);
      }
    }
  }
  return best === null ? null : best.targets;
}

/**
 * True when `name` is a directory on the importing file's own path or a literal
 * segment of a layer pattern — so an import that starts with it is more likely
 * the project's own code than a published package.
 */
function namesRepoDirectory(name: string, ctx: ImportContext): boolean {
  if (name === '') { return false; }
  if (ctx.filePath.split('/').slice(0, -1).includes(name)) { return true; }
  return ctx.layers.some((layer) => layer.globs.some((glob) => normalizePath(glob).split('/').includes(name)));
}

/** The leading segments two Java packages must share to be the same code base. */
function javaRoot(pkg: string): string {
  const parts = pkg.split('.');
  return parts.slice(0, Math.max(1, Math.min(2, parts.length - 1))).join('.');
}

/**
 * The repository paths an import specifier may refer to.
 *
 * Empty when it is a bare package import — those are never violations. Null when
 * the specifier looks like the project's own code but no relative path or declared
 * alias maps it to a path: the import may well cross a layer, so the caller must
 * report the file as not checked rather than let it pass.
 */
function resolveImport(spec: string, ctx: ImportContext): string[] | null {
  const { ext, filePath, aliases, goModulePath } = ctx;
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const viaAlias = (value: string): string | null => {
    for (const a of aliases) {
      if (value.startsWith(a.prefix)) { return normalizePath(`${a.path}/${value.slice(a.prefix.length)}`.replace(/\/+/g, '/')); }
    }
    return null;
  };

  if (JS_EXTENSIONS.has(ext)) {
    const relative = spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
    const base = relative ? resolveRelative(dir, spec) : viaAlias(spec);
    if (base !== null) { return JS_RESOLVE_SUFFIXES.map((s) => base + s); }
    if (relative) { return []; }
    const withSuffixes = (targets: string[]): string[] => targets.flatMap((t) => JS_RESOLVE_SUFFIXES.map((s) => t + s));
    // A tsconfig `paths` entry: `@infra/db` and `$lib/x` are the project's own code there,
    // however much the first looks like a published package.
    const mapped = viaPathScopes(spec, ctx.pathScopes, false);
    if (mapped !== null) { return withSuffixes(mapped); }
    // `@/x`, `~/x`, `#x`, `$lib/x` and `/x` are never package names; `src/x` is a baseUrl-style path.
    if (spec.startsWith('@/') || /^[~#$/]/.test(spec)) { return null; }
    // A config above this file declares aliases nobody could read: any specifier that is
    // not Node's own may be one of them.
    if (ctx.pathScopes.some((s) => s.aliases === null)) { return NODE_BUILTIN.test(spec) ? [] : null; }
    // A workspace package is the project's own code in another directory — quite possibly
    // another layer — however much its name (`@acme/db`) looks like a published package.
    if (ctx.workspacePackages === null) { return NODE_BUILTIN.test(spec) ? [] : null; }
    const pkg = ctx.workspacePackages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (pkg) {
      const sub = spec.slice(pkg.name.length);
      const root = normalizePath(pkg.dir);
      return [
        ...JS_RESOLVE_SUFFIXES.map((s) => `${root}${sub}${s}`),
        ...JS_RESOLVE_SUFFIXES.map((s) => `${root}/src${sub}${s}`),
      ];
    }
    // With a `baseUrl`, `infra/db` is `<baseUrl>/infra/db` when that exists, a package otherwise.
    const underBaseUrl = viaPathScopes(spec, ctx.pathScopes, true);
    if (underBaseUrl !== null) { return withSuffixes(underBaseUrl); }
    return namesRepoDirectory(spec.split('/')[0], ctx) ? null : [];
  }
  if (ext === 'py') {
    let base: string | null;
    if (spec.startsWith('.')) {
      const dots = /^\.+/.exec(spec)![0].length;
      const rest = spec.slice(dots).replace(/\./g, '/');
      base = resolveRelative(dir, `${'../'.repeat(dots - 1)}${rest}`);
    } else {
      const aliased = viaAlias(spec);
      // An absolute import of the project's own package resolves from a source root this
      // checker does not know; without an alias naming it, the import cannot be placed.
      if (aliased === null) { return namesRepoDirectory(spec.split('.')[0], ctx) ? null : []; }
      base = aliased.replace(/\./g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
    }
    return base === null ? [] : [base, `${base}.py`, `${base}/__init__.py`];
  }
  if (ext === 'go') {
    if (goModulePath && (spec === goModulePath || spec.startsWith(`${goModulePath}/`))) {
      const base = spec.slice(goModulePath.length).replace(/^\//, '');
      return [base, `${base}/x.go`];
    }
    const aliased = viaAlias(spec);
    return aliased === null ? [] : [aliased, `${aliased}/x.go`];
  }
  if (ext === 'java') {
    const aliased = viaAlias(spec);
    if (aliased === null) {
      // The same code base as the importing file, yet outside every declared alias.
      const root = ctx.ownPackage === null ? null : javaRoot(ctx.ownPackage);
      return root !== null && (spec === root || spec.startsWith(`${root}.`)) ? null : [];
    }
    const base = aliased.replace(/\./g, '/');
    return [base, `${base}.java`];
  }
  return [];
}

function checkLayering(profile: StandardsProfile, input: StandardsCheckInput, files: Prepared[], log: RuleLog): void {
  const rule = 'layering/imports';
  const { layers, forbiddenImports, importAliases } = profile.backend;
  if (layers.length === 0 || forbiddenImports.length === 0) { log.notConfigured(rule); return; }

  const layerOf = (paths: string[]): string | null | undefined => {
    let undecidable = false;
    for (const layer of layers) {
      for (const p of paths) {
        const match = matchesAny(p, layer.globs);
        if (match) { return layer.name; }
        if (match === null) { undecidable = true; }
      }
    }
    return undecidable ? undefined : null;
  };

  for (const f of files) {
    if (!f.isSource || (f.file.addedLines.length === 0 && f.file.content !== null)) { continue; }
    if (f.leftOut) { log.leftOut(f, rule); continue; }
    const own = layerOf([f.path]);
    if (own === undefined) { log.undecided(rule, `A layer pattern could not be read (${f.path})`); continue; }
    if (f.file.content !== null) { log.saw(rule); }
    const forbidden = forbiddenImports.filter((r) => r.from === own).map((r) => r.to);
    if (own === null || forbidden.length === 0) { continue; }

    if (f.ext === 'cs') { log.undecided(rule, `C# using directives cannot be mapped to paths (${f.path})`); continue; }
    if (f.ext === 'java' && importAliases.length === 0) {
      log.undecided(rule, `Java imports cannot be mapped to paths without an import alias (${f.path})`);
      continue;
    }
    if (!f.lex.ok) { log.undecided(rule, `${f.lex.reason} (${f.path})`); continue; }
    if (importSpecifiers(f.ext, '') === null) { log.undecided(rule, `No import reader for .${f.ext} files (${f.path})`); continue; }
    if (f.ext === 'go' && !input.goModulePath && importAliases.length === 0) {
      log.undecided(rule, `The Go module path is unknown, so imports cannot be mapped (${f.path})`);
      continue;
    }

    let ownPackage: string | null = null;
    if (f.ext === 'java') {
      for (const l of f.lex.lines) {
        const declared = /^\s*package\s+([\w.]+)\s*;/.exec(l.code);
        if (declared) { ownPackage = declared[1]; break; }
      }
    }
    const ctx: ImportContext = {
      ext: f.ext, filePath: f.path, layers, aliases: importAliases, goModulePath: input.goModulePath, ownPackage,
      workspacePackages: input.workspacePackages === undefined ? [] : input.workspacePackages,
      pathScopes: (input.importPathScopes ?? []).filter((s) => s.dir === '' || isUnder(f.path, normalizePath(s.dir))),
    };

    for (const n of f.file.addedLines) {
      const code = (f.lex.lines[n - 1] as LexedLine | undefined)?.code;
      if (!code) { continue; }
      const read = importSpecifiers(f.ext, code);
      // One finding per line and layer: `from ..db import client` names the layer twice.
      const reported = new Set<string>();
      let moduleForbidden = false;
      let moduleInRepo = false;
      const specs = read?.specs ?? [];
      const resolved = specs.map((spec) => resolveImport(spec, ctx));
      // `from app import db` with only `app.db` aliased: every name it imports is placed, so the
      // unplaced parent package hides nothing.
      const namesPlaced = read?.namedFrom === true && resolved.slice(1).every((paths) => paths !== null);
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const paths = resolved[i];
        if (spec === read?.openModule) { moduleInRepo = paths === null || paths.length > 0; }
        if (paths === null && i === 0 && namesPlaced) { continue; }
        if (paths === null) {
          // Not a pass: the import may cross a layer, and nothing here can tell.
          log.undecided(rule, `Import ${spec.slice(0, 80)} cannot be mapped to a path; declare an import alias for it (${f.path})`);
          continue;
        }
        const target = layerOf(paths);
        if (typeof target === 'string' && forbidden.includes(target)) {
          if (spec === read?.openModule) { moduleForbidden = true; }
          if (reported.has(target)) { continue; }
          reported.add(target);
          log.findIn(rule, f, n, `${own} must not import from ${target} (${spec})`);
        }
      }
      // The names after `import` could not be read, and each may be a package of its own.
      // A bare third-party module (`from typing import (`) is no concern; one of the
      // project's own that is not already a violation leaves the line undecided.
      if (read?.openModule !== undefined && moduleInRepo && !moduleForbidden) {
        log.undecided(rule, `The names imported from ${read.openModule.slice(0, 80)} could not be read on one line (${f.path}:${n})`);
      }
    }
  }
}

// ─── Comment policy ───

/**
 * Tool directives are instructions to a tool, not commentary. One is recognised only where
 * the comment STARTS with it: `// eslint-disable-next-line` is a directive, but
 * `// run(); // noqa` is disabled code with a directive tacked on, and a comment that merely
 * mentions "pragma" or "go:" somewhere is ordinary text.
 */
const DIRECTIVE_START = new RegExp('^(?:' + [
  'eslint(?:-(?:disable|enable|env))?\\b', '@ts-(?:ignore|expect-error|nocheck|check)\\b', 'prettier-ignore\\b',
  'biome-ignore\\b', 'deno-lint-ignore\\b', '(?:istanbul|c8|v8)\\s+ignore\\b', 'noqa\\b', 'nosec\\b', 'nolint\\b',
  'type:\\s*ignore\\b', '(?:pylint|mypy|pyright|isort|cspell)\\s*:', 'fmt:\\s*(?:off|on|skip)\\b', '#?pragma\\b',
  'go:[a-z]', '#?(?:end)?region\\b', '[#@]\\s*sourceMappingURL=',
].join('|') + ')', 'i');

/** A URL inside a comment. It is replaced by one neutral word before the comment is read as code or prose. */
const URL_IN_COMMENT = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]*/g;
/** Text of a Go doc comment that gofmt treats as a code example: indented past the usual single space. */
const GO_DOC_EXAMPLE = /^(?:\t|\s{2,})/;

const CODE_KEYWORDS = '(?:if|else|for|while|switch|case|return|const|let|var|function|class|import|export|default|def|elif|try|catch|finally|throw|raise|await|async|public|private|protected|static|final|func|package|using|namespace|new|delete|yield|del|with|from|print)';
/** Every keyword a statement opens with, e.g. `export default` or `public static final`. */
const LEADING_KEYWORDS = new RegExp(`^(?:${CODE_KEYWORDS}\\b\\s*)+`);
const KEYWORD_PAREN = /^(?:if|for|while|switch|catch|elif)\s*\(.*\)\s*$/;
/** `name(` or `a.b.name(` opening a statement. Annotation tags such as `TODO(sam)` are not calls. */
const CALL_START = /^(?!(?:TODO|FIXME|NOTE|XXX|HACK)\b)(?:await\s+|new\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/;
const ASSIGN_START = /^(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$.\[\]'"]*\s*(?:[-+*/|&%:]?=)(?!=)\s*\S/;
/** A declaration with an initialiser, typed or not: `const x: number = 5`. */
const DECLARATION = /^(?:(?:export|declare|public|private|protected|static|final|readonly)\s+)*(?:const|let|var)\s+[A-Za-z_$[{][^=]*=(?!=)\s*\S/;
/** Go's short declaration. `:=` is not something prose contains. */
const GO_SHORT_ASSIGN = /^[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*:=\s*\S/;
const BLOCK_CLOSER = /^[}\])]+[;,]?$/;
const WEAK_STATEMENT = /^(?:(?:def|class)\s+\w+.*:|from\s+[\w.]+\s+import\s+.+|import\s+[\w.]+|(?:else|try|finally)\s*:?)$/;
const HTML_TAG_START = /^<\/?[A-Za-z][^>]*>/;
const CSS_DECLARATION = /^[\w-]+\s*:\s*[^;{}]+;$/;
// Where a commented-out element is written as markup inside braces.
const JSX_EXTENSIONS = new Set(['jsx', 'tsx', 'js']);

/** Words that join operands rather than being one: two of them never make prose. */
const OPERATOR_WORDS = new Set([
  'not', 'in', 'is', 'and', 'or', 'new', 'await', 'typeof', 'instanceof', 'as', 'of', 'from', 'yield', 'delete', 'void', 'range',
  'None', 'True', 'False', 'null', 'true', 'false', 'nil', 'undefined', 'this', 'self',
]);

/** A comment line stripped of block decoration (`*`, leading whitespace). */
function commentText(comment: string): string {
  return comment.replace(/^\s*\*+\s?/, '').trim();
}

/** `source` with every quoted literal collapsed to one operand, so words inside strings are not read as prose. */
function withoutLiterals(source: string): string {
  return source.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '0');
}

/**
 * Whether `source` reads as an expression rather than as words.
 *
 * Prose puts plain words side by side ("early when the list is empty"); code
 * separates its operands with operators, calls and punctuation ("x > 0",
 * "compute(a, b)", "item in items"). Two plain words in a row decide it.
 */
function looksLikeExpression(source: string): boolean {
  const text = withoutLiterals(source).trim();
  if (text === '') { return false; }
  let previousPlain = false;
  for (const token of text.split(/\s+/)) {
    const word = /^([A-Za-z]+)([,.:]?)$/.exec(token);
    const plain = word !== null && !OPERATOR_WORDS.has(word[1]);
    if (plain && previousPlain) { return false; }
    // A comma closes an operand: `x, y` is a list, not a phrase.
    previousPlain = plain && word[2] !== ',';
  }
  return true;
}

/**
 * True when `statement` is one call and nothing else: `a.b(args)`, optionally
 * chained (`a(x).b(y)`). `Note(alice): revisit …` is not — text follows the
 * closing parenthesis — and neither is `Fallback(legacy clients)`, whose
 * "arguments" are words.
 */
function isWholeCall(statement: string): boolean {
  let rest = withoutLiterals(statement).trim();
  if (!CALL_START.test(rest)) { return false; }
  for (;;) {
    const open = rest.indexOf('(');
    if (open < 0) { return false; }
    let depth = 0;
    let close = -1;
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '(') { depth++; } else if (rest[i] === ')' && --depth === 0) { close = i; break; }
    }
    if (close < 0) { return false; }
    const args = rest.slice(open + 1, close).trim();
    if (args !== '' && !looksLikeExpression(args)) { return false; }
    rest = rest.slice(close + 1);
    if (rest === '') { return true; }
    // Only a chained call may follow: `.then(...)`.
    if (!/^\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/.test(rest)) { return false; }
  }
}

/**
 * True when a whole call carries a second sign of being code beyond `name(args)`:
 * it is awaited or constructed (`await load()`, `new Map()`), called on something
 * (`cache.get(id)`) or chained (`load(x).then(use)`).
 */
function isDistinctCall(statement: string): boolean {
  const bare = withoutLiterals(statement).trim();
  if (/^(?:await|new)\s/.test(bare)) { return true; }
  const open = bare.indexOf('(');
  return (open > 0 && bare.slice(0, open).includes('.')) || /\)\s*\.[A-Za-z_$]/.test(bare);
}

/** A Python condition that is unmistakably one: it has an operator, a call or a subscript, not just words. */
function isCodeCondition(condition: string): boolean {
  if (!looksLikeExpression(condition)) { return false; }
  const bare = withoutLiterals(condition);
  return /[^A-Za-z\s]/.test(bare) || bare.trim().split(/\s+/).some((t) => OPERATOR_WORDS.has(t));
}

/** Python statements that need no terminator to be recognised. */
function isStrongPython(text: string): boolean {
  const branch = /^(?:if|elif|while)\s+(.+):$/.exec(text);
  if (branch) { return isCodeCondition(branch[1]); }
  const loop = /^(?:async\s+)?for\s+[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s+in\s+(.+):$/.exec(text);
  if (loop) { return looksLikeExpression(loop[1]); }
  const context = /^(?:async\s+)?with\s+(.+):$/.exec(text);
  if (context) { return /[(.]/.test(context[1]) && looksLikeExpression(context[1].replace(/\s+as\s+\w+$/, '')); }
  if (/^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(.*\)\s*(?:->\s*[^:]+)?:$/.test(text)) { return true; }
  if (/^class\s+(?:[A-Z]\w*|[A-Za-z_]\w*\s*\(.*\))\s*(?:\(.*\))?:$/.test(text)) { return true; }
  // An assignment whose value is a call: `result = compute(a, b)`.
  const assigned = /^[A-Za-z_][\w.[\]'"]*\s*[-+*/|&%]?=(?!=)\s*(.+)$/.exec(text);
  return assigned !== null && isWholeCall(assigned[1]);
}

/** A comment that, on its own, is unmistakably code. */
function isStrongCode(text: string, ext: string): boolean {
  if (ext === 'html' || ext === 'htm') { return HTML_TAG_START.test(text); }
  if (ext === 'css') { return CSS_DECLARATION.test(text); }
  if (ext === 'py' && isStrongPython(text)) { return true; }
  if (ext === 'go' && GO_SHORT_ASSIGN.test(text)) { return true; }

  const terminated = text.endsWith(';');
  const statement = terminated ? text.slice(0, -1).trimEnd() : text;
  // The call has to be the whole statement, not a word followed by a parenthesis and prose —
  // and a bare `name(args)` needs a second signal: `O(1)`, `rgb(0, 0, 0)` and `ts(2378)` are
  // annotations written in call shape.
  if (isWholeCall(statement) && (terminated || isDistinctCall(statement))) { return true; }
  // A keyword-led declaration is code with or without a terminator, as long as what it is
  // given reads as an expression: `const a = load()`, not `let x = the number of items`.
  if (DECLARATION.test(statement) && (terminated || looksLikeExpression(statement.slice(statement.indexOf('=') + 1)))) {
    return true;
  }
  const keywords = LEADING_KEYWORDS.exec(statement);
  // What follows the keywords must read as code: `return x` does, `return early when the list is empty` does not.
  const afterKeywords = (rest: string): boolean => rest === '' || looksLikeExpression(rest);

  if (terminated) {
    if (ASSIGN_START.test(text) || DECLARATION.test(text)) { return true; }
    if (keywords === null) { return false; }
    const rest = statement.slice(keywords[0].length);
    // `private static final int MAX = 5;`: modifiers in front of a typed declaration.
    return afterKeywords(rest) || TYPED_DECLARATION.test(`${rest};`);
  }
  if (text.endsWith('{')) {
    const head = text.slice(0, -1).trimEnd();
    if (/^\}?\s*else$/.test(head) || /(?:\)|=|=>)$/.test(head)) { return true; }
    return keywords !== null && afterKeywords(head.slice(keywords[0].length));
  }
  return text.endsWith(')') && KEYWORD_PAREN.test(text);
}

/** How a comment reads: unmistakable code, a line that is code only in company, or neither. */
type CodeShape = 'strong' | 'weak' | 'assign' | 'call' | null;

/** `Type name = expr;` as Java and C# declare a variable: `String name = user.getName();`. */
const TYPED_DECLARATION = /^(?:final\s+)?[A-Za-z_][\w.]*(?:<[^=;]*>)?(?:\[\])*\s+[A-Za-z_]\w*\s*=(?!=)\s*(\S.*);$/;
/** Go's `var x int`. */
const GO_VAR = /^var\s+[A-Za-z_]\w*\s+[\w.*[\]]+$/;
/** A Python block opened on nothing but a name: `if enabled:`. Code only when an indented line follows. */
const PYTHON_NAME_BLOCK = /^(?:if|elif|while)\s+(?:not\s+)?[A-Za-z_][\w.]*:$/;

/**
 * Classify one comment's text.
 *
 * `weak`, `assign` and `call` look like code only beside a neighbour that does too.
 * The last two are kept apart because a pair of the same kind does not corroborate
 * itself: `width = columns * cell` above `height = rows * cell` is how a comment
 * explains a formula, and `O(n)` above `O(1)` is how one states a cost. Either counts
 * once it sits beside some other kind of code.
 */
function codeShape(text: string, ext: string): CodeShape {
  if (isStrongCode(text, ext)) { return 'strong'; }
  if (ext === 'html' || ext === 'htm' || ext === 'css') { return null; }
  if (BLOCK_CLOSER.test(text) || WEAK_STATEMENT.test(text)) { return 'weak'; }
  const statement = text.endsWith(';') ? text.slice(0, -1).trimEnd() : text;
  const returned = /^return\s+(.+)$/.exec(statement);
  if (returned && looksLikeExpression(returned[1])) { return 'weak'; }
  // `throw new Error("bad")`, `raise ValueError("bad")`, `defer f.Close()`, `go worker(jobs)`:
  // as sure as the call they lead.
  const led = (ext === 'go' ? /^(?:defer|go)\s+(.+)$/ : /^(?:throw|raise)\s+(.+)$/).exec(statement);
  if (led && isWholeCall(led[1])) { return isDistinctCall(led[1]) ? 'strong' : 'weak'; }
  const asserted = /^assert\s+(.+)$/.exec(statement);
  if (asserted && isCodeCondition(asserted[1])) { return 'weak'; }
  if (ext === 'go' && GO_VAR.test(statement)) { return 'weak'; }
  if (ext === 'java' || ext === 'cs') {
    const typed = TYPED_DECLARATION.exec(text);
    if (typed && looksLikeExpression(typed[1])) { return 'weak'; }
  }
  if (isWholeCall(statement)) { return 'call'; }
  return ASSIGN_START.test(text) ? 'assign' : null;
}

/** An ellipsis as people type it: two or more dots, or the single character. */
const ELLIPSIS = /^(?:\.{2,}|…)$/;
/** A phrase written as a whole comment: `// rest of the code`, `# existing code here`. */
const WHOLE_COMMENT_PHRASE = /^(?:\/\/+|#+)\s*(.*)$/;

/**
 * Lower-cased words of a comment or phrase, without the dots, dashes, brackets and
 * decoration around them, and without a leading "the": `... (The rest of the code) ...`
 * and `rest of the code` are the same words.
 */
function bareWords(text: string): string {
  return text.toLowerCase()
    .replace(/^[\s.…*#/([{<-]+/, '')
    .replace(/[\s.…*#/!:)\]}>-]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^the /, '');
}

/** An annotation tag in front of a placeholder: `TODO: your code here`. */
const LEADING_TAG = /^(?:todo|fixme|xxx|note)\b[\s:.-]*/;

/** How one banned phrase is looked for. */
interface PhraseMatcher {
  /**
   * `whole`: the phrase must be the WHOLE of one comment. `anywhere`: it may sit anywhere
   * inside one comment.
   */
  scope: 'whole' | 'anywhere';
  matches(text: string): boolean;
}

/**
 * How a banned phrase is looked for in ONE comment: a single `//` or `#` comment, or one
 * block comment with its lines put back together. Never in a line that happens to hold
 * several comments, and never across two comments that merely sit on neighbouring lines.
 *
 * A phrase written as a comment (`// rest of the code`) must be the WHOLE comment, give or
 * take surrounding dots and brackets, a leading "the" and a leading `TODO:`: that is the
 * placeholder itself, while "the rest of the code in this package is generated" is
 * documentation and is left alone — and so is one line of a longer block comment that
 * happens to read "rest of the code", because the comment as a whole says more.
 *
 * A plain phrase is a whole-word, case-insensitive match anywhere in the comment. Runs of
 * whitespace match any whitespace, and an ellipsis in the phrase (`... existing code ...`)
 * matches `...`, `..`, `…`, spaced or not.
 *
 * The phrase is escaped literal text with fixed separators, so the expression cannot
 * backtrack badly.
 */
function phraseMatcher(phrase: string): PhraseMatcher {
  const trimmed = phrase.trim();
  const whole = WHOLE_COMMENT_PHRASE.exec(trimmed);
  if (whole) {
    const wanted = bareWords(whole[1]);
    return {
      scope: 'whole',
      matches: (text) => {
        const words = bareWords(text);
        return wanted !== '' && (words === wanted || bareWords(words.replace(LEADING_TAG, '')) === wanted);
      },
    };
  }
  const tokens = trimmed.replace(/(\.{2,}|…)/g, ' $1 ').trim().split(/\s+/);
  let source = '';
  tokens.forEach((token, i) => {
    const dots = ELLIPSIS.test(token);
    if (i > 0) { source += dots || ELLIPSIS.test(tokens[i - 1]) ? '\\s*' : '\\s+'; }
    source += dots ? '(?:\\.{2,}|…)' : token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  // A boundary is only asked for where the phrase itself ends in a word character.
  const before = /^\w/.test(trimmed) ? '(?<![A-Za-z0-9_])' : '';
  const after = /\w$/.test(trimmed) ? '(?![A-Za-z0-9_])' : '';
  const pattern = new RegExp(`${before}${source}${after}`, 'i');
  return { scope: 'anywhere', matches: (text) => pattern.test(text) };
}

function checkComments(profile: StandardsProfile, files: Prepared[], log: RuleLog): void {
  const policy = profile.comments;
  const codeRule = 'comment-policy/commented-out-code';
  const phraseRule = 'comment-policy/banned-phrase';
  const densityRule = 'comment-policy/density';
  const all: StandardsRuleId[] = [codeRule, phraseRule, densityRule];

  if (!policy.forbidCommentedOutCode) { log.notConfigured(codeRule); }
  if (policy.bannedPhrases.length === 0) { log.notConfigured(phraseRule); }
  const phrases = policy.bannedPhrases.map((p) => ({ shown: p, matcher: phraseMatcher(p) }));

  for (const f of files) {
    if (!f.isSource || (f.file.addedLines.length === 0 && f.file.content !== null)) { continue; }
    if (f.leftOut) { log.leftOut(f, ...all); continue; }
    if (!f.lex.ok) {
      for (const rule of all) { log.undecided(rule, `${f.lex.reason} (${f.path})`); }
      continue;
    }
    log.saw(...all);
    const lines = f.lex.lines;
    const hasShebang = (f.raw[0] ?? '').startsWith('#!');
    const added = new Set(f.file.addedLines);
    const commentOnlyLines = new Set(commentOnlyLineNumbers(lines, hasShebang));
    const jsx = JSX_EXTENSIONS.has(f.ext);

    /** How line `n`'s comment reads, whoever added it and wherever it sits. Null for anything exempt. */
    const shapeOf = (n: number): CodeShape => {
      const l = lines[n - 1];
      if (!l || l.comment === '') { return null; }
      const written = commentText(l.comment);
      if (written.length === 0 || DIRECTIVE_START.test(written)) { return null; }
      // `legacy.run(a); // eslint-disable-line`: the directive trailing a disabled statement
      // came along with it. It is dropped, and what it was attached to is read on its own.
      const trailing = /^(.*?\S)\s*(?:\/\/|#)\s*(\S.*)$/.exec(written);
      const core = trailing && DIRECTIVE_START.test(trailing[2]) ? trailing[1] : written;
      // A URL is neither code nor prose; what surrounds it still is one or the other.
      const text = core.replace(URL_IN_COMMENT, 'URL');

      const raw = (f.raw[n - 1] ?? '').trim();
      const code = l.code.trim();
      // `{/* <Old /> */}` is a comment on a line of its own: the braces only carry it.
      const wrapped = jsx && /^\{\s*\}$/.test(code);
      const standsAlone = code === '' || wrapped;
      const markup = jsx && !l.isDoc && HTML_TAG_START.test(text) && text.endsWith('>');
      const shape: CodeShape = markup ? 'strong' : codeShape(text, f.ext);

      // Go documentation is a run of plain `//` lines above a declaration. Its examples are
      // indented past the usual single space and are code on purpose. Its other lines are
      // read like any comment: Go has no syntax that sets a doc comment apart, so disabled
      // statements parked above a declaration are still disabled statements.
      if (l.isDoc && f.ext === 'go' && GO_DOC_EXAMPLE.test(l.comment)) { return null; }
      if (l.isDoc && f.ext !== 'go') {
        // A doc block documents, and its examples are code on purpose. But a single
        // `///` line or a one-line `/** … */` that IS a statement documents nothing.
        const oneLine = raw.startsWith('///') || /^\/\*\*.*\*\/$/.test(raw);
        // `/// <reference …/>` and `/// <summary>` are tags, never disabled code.
        return oneLine && shape === 'strong' && !text.startsWith('<') ? 'strong' : null;
      }
      // A comment trailing live code usually annotates it, so only unmistakable code counts
      // there — and a call only with its terminator: `return m.get(k); // cache.get(k)` explains.
      if (!standsAlone) {
        return shape === 'strong' && (text.endsWith(';') || !isWholeCall(text)) ? 'strong' : null;
      }
      return shape;
    };

    /** How far the text of line `n`'s comment is indented after its marker. */
    const commentIndent = (n: number): number => {
      const body = (lines[n - 1]?.comment ?? '').replace(/^\s*\*+/, '');
      return body.length - body.trimStart().length;
    };
    /** Python's `# if enabled:` directly above a deeper-indented comment that reads as code. */
    const opensCommentedBlock = (n: number): boolean => {
      const l = lines[n - 1];
      if (f.ext !== 'py' || !l || l.code.trim() !== '' || !PYTHON_NAME_BLOCK.test(commentText(l.comment))) { return false; }
      return added.has(n + 1) && shapeOf(n + 1) !== null && commentIndent(n + 1) > commentIndent(n);
    };

    // The header (shebang, licence block) is exempt — unless most of it is code. Commented-out
    // statements stacked above the first import are not a licence, however high they sit.
    let headerEnd = headerLineCount(lines, hasShebang);
    let headerText = 0;
    let headerCode = 0;
    for (let n = 1; n <= headerEnd; n++) {
      const l = lines[n - 1];
      if (commentText(l.comment).length === 0 || (n === 1 && hasShebang)) { continue; }
      headerText++;
      if (shapeOf(n) !== null) { headerCode++; }
    }
    if (headerCode * 2 > headerText) { headerEnd = 0; }

    /** The shape of an added comment line outside the header; null for every other line. */
    const classify = (n: number): CodeShape => {
      if (!added.has(n) || n <= headerEnd) { return null; }
      return shapeOf(n) ?? (opensCommentedBlock(n) ? 'weak' : null);
    };
    /** Whether line `n` flags as commented-out code, given its neighbours. */
    const isCommentedOut = (n: number): boolean => {
      const kind = classify(n);
      if (kind === null) { return false; }
      if (kind === 'strong') { return true; }
      const neighbours = [classify(n - 1), classify(n + 1)];
      // A bare assignment or a bare call needs a neighbour of another kind; anything else needs any neighbour.
      return neighbours.some((other) => other !== null && (kind === 'weak' || other !== kind));
    };

    /**
     * The individual comments that touch an added line. Each is one `//` or `#` comment or
     * one whole block comment: `whole` is its text with the lines put back together, `added`
     * the text of the lines this change wrote, and `line` the first of those.
     */
    const addedComments = (): Array<{ line: number; whole: string; added: string }> => {
      const byId = new Map<number, { first: number; line: number; whole: string[]; added: string[] }>();
      lines.forEach((l, i) => {
        for (const part of l.parts) {
          const text = commentText(part.text);
          const entry = byId.get(part.id) ?? { first: 0, line: 0, whole: [], added: [] };
          if (text !== '') { entry.whole.push(text); }
          if (added.has(i + 1)) {
            // Reported where its words are: the first added line that says something,
            // not the bare opening line of a block comment.
            if (entry.first === 0) { entry.first = i + 1; }
            if (text !== '') {
              if (entry.line === 0) { entry.line = i + 1; }
              entry.added.push(text);
            }
          }
          byId.set(part.id, entry);
        }
      });
      return [...byId.values()].filter((c) => c.first > 0)
        .map((c) => ({ line: c.line || c.first, whole: c.whole.join(' '), added: c.added.join(' ') }));
    };

    if (phrases.length > 0) {
      for (const comment of addedComments()) {
        // One finding per comment: overlapping phrases ("... rest of the code ...", "rest of
        // the code goes here") describe the same placeholder. A whole-comment phrase is held
        // against the whole comment; a plain one only against what this change wrote of it.
        const hit = phrases.find((p) => p.matcher.matches(p.matcher.scope === 'whole' ? comment.whole : comment.added));
        if (hit) { log.findIn(phraseRule, f, comment.line, `Banned phrase in a comment: "${hit.shown}"`); }
      }
    }

    let commentOnly = 0;
    let firstCommentLine = 0;
    for (const n of f.file.addedLines) {
      const l = lines[n - 1];
      if (!l) { continue; }

      if (policy.forbidCommentedOutCode && isCommentedOut(n)) {
        log.findIn(codeRule, f, n, 'Commented-out code; delete it instead of leaving it behind');
      }

      // Documentation and the file header are not counted against the author.
      if (commentOnlyLines.has(n)) {
        commentOnly++;
        if (firstCommentLine === 0) { firstCommentLine = n; }
      }
    }

    const total = f.file.addedLines.length;
    if (total >= policy.minAddedLines && commentOnly * 100 > policy.maxDensityPct * total) {
      const pct = Math.round((commentOnly * 100) / total);
      log.findIn(densityRule, f, firstCommentLine || f.file.addedLines[0],
        `${commentOnly} of ${total} added lines (${pct}%) are comments; the limit is ${policy.maxDensityPct}%`);
    }
  }
}

// ─── Public API ───

/**
 * Count rule results. `failed` counts BLOCKING failures only — it is the number a caller
 * may gate on — and `advisory` the rest. `passed` counts commands only; a static rule
 * that found nothing is counted under `noFindings`, never as a pass. The finding and
 * file counts are passed in because a capped list no longer knows its true size.
 */
export function computeTotals(
  rules: StandardsRuleOutcome[], findings: number, advisoryFindings = 0, notCheckedFiles = 0,
): StandardsTotals {
  const failed = rules.filter((r) => r.result === 'failed');
  const clean = rules.filter((r) => r.result === 'passed');
  return {
    passed: clean.filter((r) => !isScannerRule(r.rule)).length,
    noFindings: clean.filter((r) => isScannerRule(r.rule)).length,
    failed: failed.filter((r) => severityOf(r) === 'blocking').length,
    advisory: failed.filter((r) => severityOf(r) === 'advisory').length,
    notChecked: rules.filter((r) => r.result === 'not-checked').length,
    blockingNotChecked: rules.filter(isBlockingNotChecked).length,
    findings,
    advisoryFindings: Math.min(advisoryFindings, findings),
    notCheckedFiles,
  };
}

/**
 * The totals of `report` counted again from its rows — after a command row was filled in,
 * say. The finding and file counts are kept: they are the true ones even when a list is capped.
 */
export function recountTotals(report: StandardsReport): StandardsTotals {
  return computeTotals(report.rules, report.totals.findings, report.totals.advisoryFindings, report.totals.notCheckedFiles);
}

/**
 * Check a diff against a profile.
 *
 * Returns one outcome per static rule, in {@link STANDARDS_RULE_IDS} order, the findings
 * sorted by file, line and rule, and the changed files the line rules did not read.
 * `version` is left null for the caller to stamp; profile commands are not run here — they
 * are appended by the caller as `command` rows.
 */
export function checkStandards(profile: StandardsProfile, input: StandardsCheckInput): StandardsReport {
  const vendorRoots = (input.vendorRoots ?? []).map(normalizePath);
  const vendor: VendorContext = { roots: vendorRoots, newRoots: newVendorRoots(vendorRoots, input.files) };
  const files = input.files.map((file) => prepare(file, vendor));
  const log = new RuleLog(profile);

  checkRequiredDirs(profile, input, log);
  if (input.baseRef === null) {
    // With no diff there is nothing to judge, and "no findings" would be a fabricated pass.
    for (const rule of DIFF_RULES) { log.undecided(rule, NO_DIFF); }
  }
  checkTopLevel(profile, input, files, log);
  checkPlacement(profile, files, log);
  checkNestedRepos(input, log);
  checkRawPatterns(profile, files, log);
  checkLayering(profile, input, files, log);
  checkNaming(profile, files, log);
  checkComments(profile, files, log);
  checkNewlyGenerated(files, log);

  const rules = STANDARDS_RULE_IDS.map((rule) => log.outcome(rule));
  const findings = [...log.findings].sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message));
  const notCheckedFiles = collectNotCheckedFiles(files, input);
  const advisory = findings.filter((f) => severityOf(f) === 'advisory').length;
  return {
    version: null, baseRef: input.baseRef, rules, findings, notCheckedFiles,
    totals: computeTotals(rules, findings.length, advisory, notCheckedFiles.length),
  };
}

/**
 * A report in which nothing was evaluated — every static rule and every profile
 * command is `not-checked` for `reason`. Used when an earlier gate already
 * failed, so the standards gate never ran.
 */
export function skippedStandardsReport(
  profile: StandardsProfile, version: number | null, baseRef: string | null, reason: string,
): StandardsReport {
  const rules: StandardsRuleOutcome[] = [
    ...STANDARDS_RULE_IDS.map((rule) => ({ rule, severity: ruleSeverity(profile, rule), result: 'not-checked' as const, reason })),
    ...profile.commands.map((c) => commandRow({ result: 'not-checked', reason, command: c.run })),
  ];
  return { version, baseRef, rules, findings: [], notCheckedFiles: [], totals: computeTotals(rules, 0) };
}

/**
 * A copy of `report` whose severities come from `profile` — or, with no profile, with
 * every rule blocking. For a report that crossed a process boundary: the reader, not the
 * sender, decides what can stop a release. Totals are recomputed to match.
 */
export function applyProfileSeverity(report: StandardsReport, profile: Pick<StandardsProfile, 'severity'> | null): StandardsReport {
  const of = (rule: StandardsRuleOutcome['rule']): RuleSeverity =>
    (rule === 'command' || profile === null ? 'blocking' : ruleSeverity(profile, rule));
  const rules = report.rules.map((r) => ({ ...r, severity: of(r.rule) }));
  const findings = report.findings.map((f) => ({ ...f, severity: of(f.rule) }));
  // The advisory count follows the new severities. Only the listed findings can be sorted
  // again; when the list was capped, the unlisted remainder is counted as advisory only
  // while some rule still is — and never as more than there are findings.
  const listed = findings.filter((f) => severityOf(f) === 'advisory').length;
  const unlisted = Math.max(0, report.totals.findings - report.findings.length);
  const advisory = rules.some((r) => severityOf(r) === 'advisory') ? listed + unlisted : 0;
  return { ...report, rules, findings, totals: computeTotals(rules, report.totals.findings, advisory, report.totals.notCheckedFiles) };
}

/** A profile-command row. Commands are real tools with real exit codes: always blocking. */
export function commandRow(row: Omit<StandardsRuleOutcome, 'rule' | 'severity'>): StandardsRuleOutcome {
  return { rule: 'command', severity: 'blocking', ...row };
}

/** Keep the end of `text`, where failures print. */
function tailOf(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/**
 * Bound a report before it crosses a process boundary: at most
 * {@link MAX_REPORT_FINDINGS} findings, {@link MAX_REPORT_NOT_CHECKED_FILES} not-checked
 * files and {@link MAX_REPORT_TAIL_CHARS} of output per command. `totals` keeps the true counts.
 */
export function capStandardsReport(report: StandardsReport): StandardsReport {
  return {
    ...report,
    rules: report.rules.map((r) => (r.tail === undefined ? r : { ...r, tail: tailOf(r.tail, MAX_REPORT_TAIL_CHARS) })),
    findings: report.findings.slice(0, MAX_REPORT_FINDINGS),
    ...(report.notCheckedFiles ? { notCheckedFiles: report.notCheckedFiles.slice(0, MAX_REPORT_NOT_CHECKED_FILES) } : {}),
  };
}

/**
 * Validate an untrusted report (a worker's `verify-standards` payload) and
 * return a bounded copy, or null when its shape is wrong. Unknown rule ids and
 * results are rejected rather than passed through.
 */
export function parseStandardsReport(raw: unknown): StandardsReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
  const obj = raw as Record<string, unknown>;
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

  const version = obj.version === null || obj.version === undefined ? null : obj.version;
  if (version !== null && !(isCount(version) && version >= 1)) { return null; }
  const baseRef = obj.baseRef === null || obj.baseRef === undefined ? null : obj.baseRef;
  if (baseRef !== null && (typeof baseRef !== 'string' || baseRef.length > 200)) { return null; }
  if (!Array.isArray(obj.rules) || obj.rules.length > MAX_REPORT_RULES || !Array.isArray(obj.findings)) { return null; }
  if (obj.notCheckedFiles !== undefined && !Array.isArray(obj.notCheckedFiles)) { return null; }

  const ruleIds: readonly string[] = STANDARDS_RULE_IDS;
  const rules: StandardsRuleOutcome[] = [];
  for (const entry of obj.rules) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return null; }
    const r = entry as Record<string, unknown>;
    if (typeof r.rule !== 'string' || (r.rule !== 'command' && !ruleIds.includes(r.rule))) { return null; }
    if (typeof r.result !== 'string' || !(RULE_RESULTS as readonly string[]).includes(r.result)) { return null; }
    // A severity that is present must be a known one. An absent one (a report written
    // before severities existed) is blocking; a command is never anything else.
    if (r.severity !== undefined && !(typeof r.severity === 'string' && (RULE_SEVERITIES as readonly string[]).includes(r.severity))) { return null; }
    const severity: RuleSeverity = r.rule === 'command' ? 'blocking' : r.severity === 'advisory' ? 'advisory' : 'blocking';
    const out: StandardsRuleOutcome = { rule: r.rule as StandardsRuleOutcome['rule'], severity, result: r.result as RuleResult };
    if (r.undecided === true && out.result === 'not-checked') { out.undecided = true; }
    // Only a static rule can be "not configured"; a command the profile lists always is.
    if (r.unconfigured === true && out.result === 'not-checked' && out.rule !== 'command' && out.undecided !== true) { out.unconfigured = true; }
    const reason = text(r.reason, MAX_REPORT_TEXT_CHARS);
    const command = text(r.command, MAX_REPORT_TEXT_CHARS);
    if (reason !== undefined) { out.reason = reason; }
    if (command !== undefined) { out.command = command; }
    if (typeof r.exitCode === 'number' && Number.isInteger(r.exitCode)) { out.exitCode = r.exitCode; }
    if (typeof r.tail === 'string') { out.tail = tailOf(r.tail, MAX_REPORT_TAIL_CHARS); }
    rules.push(out);
  }

  const findings: StandardsFinding[] = [];
  for (const entry of obj.findings.slice(0, MAX_REPORT_FINDINGS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return null; }
    const f = entry as Record<string, unknown>;
    if (typeof f.file !== 'string' || !isCount(f.line) || typeof f.rule !== 'string' || !ruleIds.includes(f.rule)
      || typeof f.message !== 'string') { return null; }
    // A finding is as severe as its rule's row says, never as it claims for itself.
    const row = rules.find((x) => x.rule === f.rule);
    findings.push({
      file: f.file.slice(0, MAX_REPORT_PATH_CHARS),
      line: f.line,
      rule: f.rule as StandardsRuleId,
      message: f.message.slice(0, MAX_REPORT_TEXT_CHARS),
      severity: row ? severityOf(row) : 'blocking',
    });
  }

  let notCheckedFiles: StandardsNotCheckedFile[] | undefined;
  if (Array.isArray(obj.notCheckedFiles)) {
    notCheckedFiles = [];
    for (const entry of obj.notCheckedFiles.slice(0, MAX_REPORT_NOT_CHECKED_FILES)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return null; }
      const n = entry as Record<string, unknown>;
      if (typeof n.file !== 'string' || typeof n.reason !== 'string') { return null; }
      notCheckedFiles.push({ file: n.file.slice(0, MAX_REPORT_PATH_CHARS), reason: n.reason.slice(0, MAX_REPORT_TEXT_CHARS) });
    }
  }

  // The rule counts are recomputed from the rows. The finding and file totals are taken on
  // trust only upwards: never as less than what is actually listed.
  const totals = obj.totals && typeof obj.totals === 'object' ? obj.totals as Record<string, unknown> : {};
  const totalFindings = isCount(totals.findings) ? Math.max(totals.findings, findings.length) : obj.findings.length;
  const listedAdvisory = findings.filter((f) => severityOf(f) === 'advisory').length;
  const totalAdvisory = isCount(totals.advisoryFindings) ? Math.max(totals.advisoryFindings, listedAdvisory) : listedAdvisory;
  const listedFiles = notCheckedFiles?.length ?? 0;
  const totalFiles = isCount(totals.notCheckedFiles) ? Math.max(totals.notCheckedFiles, listedFiles)
    : Array.isArray(obj.notCheckedFiles) ? obj.notCheckedFiles.length : 0;
  return {
    version, baseRef, rules, findings, ...(notCheckedFiles ? { notCheckedFiles } : {}),
    totals: computeTotals(rules, totalFindings, totalAdvisory, totalFiles),
  };
}
