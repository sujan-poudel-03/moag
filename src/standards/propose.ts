// ─── Standards proposal from a detection ───
//
// Turns "what the repository looks like" into a first draft of its standards
// profile, with every area tagged `detected` (and the file that proved it) or
// `assumed` (the stack default). Pure: detection is passed in, nothing is read
// or spawned here, and no model is asked.
//
// Detected values are attacker-influenced until a reviewer reads them, so they
// are filtered to plain path segments and fixed labels before they reach the
// profile, and the finished proposal must pass the same validator as user input.

import type { ConventionDetection, DesignSources } from '../ai-rules/project-detector';
import { BUILT_IN_RULES } from '../ai-rules/built-in-rules';
import { StackId, isStackId } from '../server/stacks';
import { builtInProfile } from './built-in-profiles';
import {
  DEFAULT_DESIGN_PATHS,
  DesignSystem,
  DesignUiSignals,
  FALLBACK_DESIGN_PATHS,
  hasDesignUi,
  templateDesign,
  withAdoptedTokensNote,
} from './design';
import { NAMING_PATTERNS } from './checker';
import { matchesAny } from './glob';
import {
  MAX_STANDARDS_COMMANDS,
  MAX_STANDARDS_ENTRY_CHARS,
  MAX_STANDARDS_LIST_ENTRIES,
  NAMING_STYLES,
  NamingStyle,
  PROVENANCE_FIELDS,
  checkDesign,
  ProvenanceField,
  StandardsProfile,
  StandardsProvenance,
  validateProfile,
} from './profile';

export interface StandardsProposal {
  profile: StandardsProfile;
  provenance: StandardsProvenance;
}

/** Separates the proving file from the note that follows it in an evidence string. */
export const EVIDENCE_NOTE_SEPARATOR = ' — ';

/** A path segment plain enough to be copied from a repository into a prompt. */
const SAFE_SEGMENT = /^[\w.@+-][\w.@+ -]{0,59}$/;
/** Most characters of detected top-level names carried into the allowed layout. */
const MAX_DETECTED_TOP_LEVEL_CHARS = 1_200;

function isSafePath(p: string): boolean {
  return p.length > 0 && p.length <= MAX_STANDARDS_ENTRY_CHARS && p.split('/').every((seg) => SAFE_SEGMENT.test(seg));
}

function clip(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? '?' : ch;
  }
  return out.length <= MAX_STANDARDS_ENTRY_CHARS ? out : out.slice(0, MAX_STANDARDS_ENTRY_CHARS);
}

function assumedTag(evidence: string): { tag: 'assumed'; evidence: string } {
  return { tag: 'assumed', evidence: clip(evidence) };
}

function detectedTag(file: string, note?: string): { tag: 'detected'; evidence: string } {
  return { tag: 'detected', evidence: clip(note ? `${file}${EVIDENCE_NOTE_SEPARATOR}${note}` : file) };
}

function allAssumed(evidence: string): StandardsProvenance {
  const out = {} as StandardsProvenance;
  for (const field of PROVENANCE_FIELDS) { out[field] = assumedTag(evidence); }
  return out;
}

/**
 * The stack a detection points at, as a {@link StackId}, or null when nothing
 * was detected. A stack the server has no profile for (Rust) maps to `other`.
 */
export function detectedStackId(detection: ConventionDetection): StackId | null {
  if (!detection.stack) { return null; }
  return isStackId(detection.stack.value) ? detection.stack.value : 'other';
}

/**
 * What a reviewer is told when no linter or formatter could be proposed for a stack: the
 * tool the stack usually enforces style with. A suggestion in a provenance note — never a
 * command in the profile, because nothing in the repository proves the tool is set up.
 */
const USUAL_STYLE_TOOLS: Record<StackId, string> = {
  'node-ts': 'ESLint and Prettier (npx eslint . / npx prettier --check .)',
  'python': 'Ruff (ruff check . / ruff format --check .)',
  'go': 'go vet and gofmt (go vet ./...)',
  'java': 'Checkstyle or Spotless (mvn checkstyle:check / gradlew spotlessCheck)',
  'dotnet': 'dotnet format (dotnet format --verify-no-changes)',
  'static-web': 'Prettier and Stylelint (npx prettier --check .)',
  'other': 'the linter and formatter this stack uses',
};

/** The provenance note for a stack with no proposed command. */
function noCommandsNote(stack: StackId): string {
  return `no lint or format configuration found, so no tool enforces style yet; usual for this stack: ${USUAL_STYLE_TOOLS[stack]}`;
}

/**
 * Fixed command templates. Style is enforced by the stack's own linter and formatter, and
 * correctness by the project's own tests, not by this checker's heuristics — so wherever a
 * file proves a tool is set up, its standard command is proposed: lint, format and typecheck
 * from configs or scripts, `npm test` from a real `test` script, `pytest` where a pytest file
 * or dependency proves it, `go test ./...` from go.mod. A script NAME selects a template; a
 * script body is never copied, and no command is proposed for a tool nothing in the
 * repository configures. Every command is shown verbatim and needs a reviewer's approval.
 */
function proposeCommands(detection: ConventionDetection): { commands: StandardsProfile['commands']; evidence: string | null } {
  const commands: StandardsProfile['commands'] = [];
  let evidence: string | null = null;
  const add = (label: string, run: string, file: string): void => {
    if (commands.length >= MAX_STANDARDS_COMMANDS || commands.some((c) => c.run === run)) { return; }
    commands.push({ label, run });
    evidence = evidence ?? file;
  };
  const lintConfig = (tool: string) => detection.lintConfigs.find((f) => f.tool === tool);
  const formatConfig = (tool: string) => detection.formatConfigs.find((f) => f.tool === tool);

  const scripts = detection.scripts?.value ?? [];
  const scriptFile = detection.scripts?.evidence ?? 'package.json';
  const stack = detection.stack?.value;

  // A project's own script wraps the tool with the project's own options: it wins.
  if (scripts.includes('lint')) { add('Lint', 'npm run lint', scriptFile); }
  if (scripts.includes('format:check')) { add('Format', 'npm run format:check', scriptFile); }
  if (scripts.includes('typecheck')) { add('Typecheck', 'npm run typecheck', scriptFile); }

  if (stack === 'node-ts' || stack === 'static-web') {
    const eslint = lintConfig('eslint');
    const biome = lintConfig('biome') ?? formatConfig('biome');
    const prettier = formatConfig('prettier');
    const stylelint = lintConfig('stylelint');
    if (!scripts.includes('lint')) {
      if (eslint) { add('Lint', 'npx eslint .', eslint.file); }
      else if (biome) { add('Lint', 'npx biome check .', biome.file); }
    }
    if (!scripts.includes('format:check') && prettier) { add('Format', 'npx prettier --check .', prettier.file); }
    if (stack === 'static-web' && stylelint) { add('Stylelint', 'npx stylelint "**/*.css"', stylelint.file); }
  }
  // Tests after the style checks. The detector lists a `test` script only when it runs
  // something, never npm init's "no test specified" placeholder.
  if (scripts.includes('test')) { add('Test', 'npm test', scriptFile); }
  if (stack === 'python') {
    const ruff = lintConfig('ruff');
    const flake8 = lintConfig('flake8');
    const black = formatConfig('black');
    if (ruff) { add('Lint', 'ruff check .', ruff.file); }
    else if (flake8) { add('Lint', 'flake8', flake8.file); }
    if (black) { add('Format', 'black --check .', black.file); }
    // pytest is proposed only where a file proves it: pytest.ini, conftest.py, or a
    // manifest that depends on it (the detector's own evidence).
    if (detection.testRunner?.value === 'pytest') { add('Test', 'pytest', detection.testRunner.evidence); }
  }
  if (stack === 'go') {
    const goMod = detection.stack?.evidence ?? 'go.mod';
    add('Vet', 'go vet ./...', goMod);
    const golangci = lintConfig('golangci-lint');
    if (golangci) { add('Lint', 'golangci-lint run', golangci.file); }
    // go.mod makes `go test ./...` the module's test command, with no further guess.
    add('Test', 'go test ./...', goMod);
  }
  // Java and .NET get no test command: the wrapper (mvnw, gradlew) or the project file a
  // test run needs is not something the detection proves, so nothing is guessed.
  if (stack === 'dotnet') {
    const editorconfig = formatConfig('editorconfig');
    if (editorconfig) { add('Format', 'dotnet format --verify-no-changes', editorconfig.file); }
  }
  return { commands, evidence };
}

/** Share of the sampled names a style must fit before it is taken as the repository's own. */
const NAMING_DOMINANCE = 0.7;

/** What the existing file names say about one assumed naming rule. */
type NamingVerdict =
  /** The names fit the assumed style, or none is in scope: nothing contradicts it. */
  | { kind: 'kept'; proof: string | null; fits: number; total: number }
  /** Another style clearly dominates, and `proof` is a name only that style explains. */
  | { kind: 'replaced'; style: NamingStyle; proof: string; fits: number; total: number }
  /** The names contradict the assumed style and agree on no other. */
  | { kind: 'dropped' };

/**
 * Measure the file-name style of the sampled files a naming rule covers.
 *
 * A style "fits" a name when the part before its first dot matches the style. One-word
 * lowercase names (`index`, `main`) fit three styles at once, so they can confirm an
 * assumption but never prove one: a style is only reported as detected on the strength
 * of a name no other style explains (`useAuth`, `user-service`, `UserService`).
 */
function measureNaming(rule: { globs: string[]; style: NamingStyle }, sample: string[]): NamingVerdict {
  const stems: Array<{ file: string; stem: string }> = [];
  for (const file of sample) {
    if (matchesAny(file, rule.globs) !== true) { continue; }
    const stem = (file.split('/').pop() ?? '').split('.')[0];
    if (stem.length > 0) { stems.push({ file, stem }); }
  }
  const fitsOf = (style: NamingStyle): number => stems.filter((s) => NAMING_PATTERNS[style].test(s.stem)).length;
  const proofOf = (style: NamingStyle): string | null => stems.find((s) =>
    NAMING_STYLES.every((other) => NAMING_PATTERNS[other].test(s.stem) === (other === style)))?.file ?? null;

  const total = stems.length;
  if (total === 0) { return { kind: 'kept', proof: null, fits: 0, total }; }
  // The assumed style wins a tie: equal support is not a contradiction.
  let best: NamingStyle = rule.style;
  for (const style of NAMING_STYLES) {
    if (fitsOf(style) > fitsOf(best)) { best = style; }
  }
  const fits = fitsOf(best);
  if (fits < NAMING_DOMINANCE * total) { return { kind: 'dropped' }; }
  const proof = proofOf(best);
  if (best === rule.style) { return { kind: 'kept', proof, fits, total }; }
  return proof === null ? { kind: 'dropped' } : { kind: 'replaced', style: best, proof, fits, total };
}

/**
 * Propose a profile for `stack` from a detection.
 *
 * A repository with no source files is greenfield: the stack's built-in profile,
 * every area `assumed`. Otherwise detected values are laid over the built-in
 * profile and tagged with the file that proved them; everything detection could
 * not prove stays the stack default and stays `assumed`. The comment-density
 * limit is never tightened below what the repository already does.
 *
 * Never throws. If the overlay somehow fails validation the result falls back
 * to the built-in profile with every area `assumed`.
 */
export function proposeProfile(stack: StackId, detection: ConventionDetection): StandardsProposal {
  const defaults = `${stack} default`;
  const profile = builtInProfile(stack);

  if (detection.sourceFileCount === 0) {
    const assumed = allAssumed(defaults);
    assumed.commands = assumedTag(noCommandsNote(stack));
    return withDesign({ profile, provenance: assumed }, stack, detection);
  }

  profile.repoState = 'brownfield';
  const provenance = allAssumed(defaults);
  const set = (field: ProvenanceField, file: string, note?: string): void => {
    provenance[field] = detectedTag(file, note);
  };

  if (detection.sampleSourceFile) { set('repoState', detection.sampleSourceFile, `${detection.sourceFileCount} source files`); }
  if (detection.stack && detectedStackId(detection) === stack) { set('stackTemplateId', detection.stack.evidence); }

  // ── Structure ──
  // What is on disk is not what the repository holds: build output and anything `.gitignore`
  // names sit there too, and are gone after a clean or in a fresh clone. So a directory is
  // proposed — required, allowed, or named by a placement or layer rule — only when git
  // lists a tracked file in it. Where git gave no listing, no directory is proposed at all,
  // and the provenance says why.
  const tracked = detection.trackedTopLevelDirs ? new Set(detection.trackedTopLevelDirs) : null;
  const untracked = `no directory is proposed: ${clip(detection.trackedUnavailable ?? 'git gave no listing of the tracked files')}`;
  const topLevel = new Set(tracked ? detection.topLevel.filter(isSafePath) : []);
  // Top-level directories only. A nested test or fixture directory (`src/cart/__tests__`)
  // moves with the code beside it; requiring it would turn an ordinary refactor into a failure.
  const found = [...(detection.sourceDirs?.value ?? []), ...(detection.testDirs?.value ?? [])]
    .filter((d) => isSafePath(d) && !d.includes('/'))
    .filter((d, i, all) => all.indexOf(d) === i);
  const dirs = (tracked ? found.filter((d) => tracked.has(d)) : []).slice(0, MAX_STANDARDS_LIST_ENTRIES);
  if (dirs.length > 0) {
    profile.structure.requiredDirs = dirs;
    const proof = (detection.sourceFileSample ?? []).find((f) => isSafePath(f) && dirs.includes(f.split('/')[0])) ?? dirs[0];
    // Detected or not, the rule stays advisory like every other rule MOAG decides itself.
    set('structure.requiredDirs', proof, 'tracked by git');
  } else {
    // A template directory the repository does not track is not a requirement it ever agreed to.
    profile.structure.requiredDirs = profile.structure.requiredDirs.filter((d) => tracked !== null && tracked.has(d.split('/')[0]));
    if (!tracked) { provenance['structure.requiredDirs'] = assumedTag(untracked); }
  }

  if (topLevel.size > 0) {
    const allowed: string[] = [];
    let chars = 0;
    for (const entry of topLevel) {
      if (allowed.length >= MAX_STANDARDS_LIST_ENTRIES || chars + entry.length > MAX_DETECTED_TOP_LEVEL_CHARS) { break; }
      allowed.push(entry);
      chars += entry.length;
    }
    for (const entry of profile.structure.allowedTopLevel) {
      if (allowed.length >= MAX_STANDARDS_LIST_ENTRIES) { break; }
      if (!allowed.includes(entry)) { allowed.push(entry); }
    }
    profile.structure.allowedTopLevel = allowed;
    set('structure.allowedTopLevel', [...topLevel][0], `${topLevel.size} top-level entries tracked by git`);
  } else if (!tracked) {
    provenance['structure.allowedTopLevel'] = assumedTag(`${defaults}; ${untracked}`);
  }

  const exists = (dir: string): boolean => topLevel.has(dir.split('/')[0]);
  profile.structure.placement = profile.structure.placement.filter((rule) => rule.under.some(exists));
  if (!profile.backend.layers.every((layer) => layer.globs.every((g) => exists(g)))) {
    profile.backend = { layers: [], forbiddenImports: [], importAliases: [] };
  }

  // ── Naming: the one assumption a repository's own file names can contradict ──
  // A rule the existing names break would fail every later run on its first new file, so
  // it follows the names: kept when they fit, replaced by the style that clearly dominates,
  // and dropped (the rule then reports "not configured") when they agree on nothing.
  const sample = (detection.sourceFileSample ?? []).filter(isSafePath);
  const namingRules: StandardsProfile['naming']['files'] = [];
  let namingProof: { file: string; note: string } | null = null;
  let namingDropped = false;
  for (const rule of profile.naming.files) {
    const verdict = measureNaming(rule, sample);
    if (verdict.kind === 'dropped') { namingDropped = true; continue; }
    const style = verdict.kind === 'replaced' ? verdict.style : rule.style;
    namingRules.push({ globs: rule.globs, style });
    if (verdict.proof && !namingProof) {
      namingProof = { file: verdict.proof, note: `${verdict.fits} of ${verdict.total} sampled names are ${style}` };
    }
  }
  profile.naming.files = namingRules;
  if (namingProof) {
    set('naming.files', namingProof.file, namingProof.note);
  } else if (namingDropped) {
    provenance['naming.files'] = assumedTag('existing file names follow no single style, so none is proposed');
  }

  // ── Frontend ──
  if (detection.componentLibrary) {
    profile.frontend.componentKit = clip(detection.componentLibrary.value);
    set('frontend.componentKit', detection.componentLibrary.evidence);
  }

  // ── Comments: never stricter than the repository already is ──
  if (detection.commentDensity) {
    const measured = Math.min(100, Math.ceil(detection.commentDensity.pct));
    const kept = measured <= profile.comments.maxDensityPct;
    profile.comments.maxDensityPct = Math.max(profile.comments.maxDensityPct, measured);
    set('comments', detection.commentDensity.evidence,
      `measured baseline ${measured}% over ${detection.commentDensity.filesSampled} files, ${kept ? 'default kept' : 'limit raised to match'}`);
  }

  // ── Testing ──
  if (detection.testRunner) {
    profile.testing.runner = clip(detection.testRunner.value);
    set('testing', detection.testRunner.evidence);
  } else if (detection.scripts?.value.includes('test')) {
    // No framework was recognised, but the project's own test script is real: `npm test`
    // (the runner the profile names) is what the project runs.
    profile.testing.runner = 'npm test';
    set('testing', detection.scripts.evidence, 'test script');
  }

  // ── Commands ──
  const proposed = proposeCommands(detection);
  profile.commands = proposed.commands;
  if (proposed.evidence) {
    set('commands', proposed.evidence, 'not executed');
  } else {
    provenance.commands = assumedTag(noCommandsNote(stack));
  }

  // ── Built-in rules ──
  const known = new Set(BUILT_IN_RULES.map((r) => r.id));
  const suggested = detection.suggestedRuleIds.filter((id, i, all) => known.has(id) && all.indexOf(id) === i);
  if (detection.stack && suggested.length > 0) {
    profile.builtInRuleIds = suggested;
    set('builtInRuleIds', detection.stack.evidence);
  }

  const checked = validateProfile(profile);
  if (!checked.ok) {
    // The design is dropped here too: the fallback is the plain built-in profile.
    const fallback = builtInProfile(stack);
    fallback.repoState = 'brownfield';
    return { profile: fallback, provenance: allAssumed(defaults) };
  }
  return withDesign({ profile: checked.profile, provenance }, stack, detection);
}

// ─── Design system ───

/**
 * A design system for `stack`, or null when the stack has no template or the project shows
 * no user interface. Starts from the stack's template; a tokens file or a design document the
 * repository already has is ADOPTED (proposed as it is, never overwritten) when it passes the
 * same checks as user input — otherwise the template part stays and the provenance says why.
 * A template part never targets a path where a file MOAG did not adopt already exists (too
 * large, unreadable, untracked, failed checks): it moves to the stack's first free fallback
 * path and the provenance names the file kept — or, with no free path, there is no proposal.
 */
export function proposeDesign(
  stack: StackId,
  detection: DesignUiSignals & { designSources?: DesignSources | null },
  componentKit: string,
): { design: DesignSystem; provenance: { tag: 'detected' | 'assumed'; evidence: string } } | null {
  if (stack !== 'static-web' && !hasDesignUi(detection)) { return null; }
  const defaults = DEFAULT_DESIGN_PATHS[stack];
  const fallbacks = FALLBACK_DESIGN_PATHS[stack];
  if (!defaults || !fallbacks || !templateDesign(stack, componentKit)) { return null; }
  const found = detection.designSources;
  const notes: string[] = [];
  /** Why a path moved off its default: first in the evidence, so the length clip never drops it. */
  const pathNotes: string[] = [];
  const adopted: string[] = [];
  // Paths holding a file MOAG did not adopt. A proposal never targets one: approving it
  // would replace the user's file with the template at run start.
  // A file there that already holds exactly what MOAG would write (its own earlier, still
  // untracked write) is no collision: writing it again changes nothing.
  const taken = new Map<string, { reason: string; content?: string }>(
    (found?.notAdopted ?? []).map((n) => [n.path, { reason: n.reason, ...(n.content !== undefined ? { content: n.content } : {}) }]));
  const sameText = (a: string, b: string): boolean => a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
  const isFree = (rel: string, content: string): boolean => {
    const t = taken.get(rel);
    return t === undefined || (t.content !== undefined && sameText(t.content, content));
  };
  const freePath = (preferred: string, alternatives: readonly string[], content: string): string | null => {
    if (isFree(preferred, content)) { return preferred; }
    const alt = alternatives.find((a) => isFree(a, content)) ?? null;
    const why = taken.get(preferred)!.reason;
    pathNotes.push(alt
      ? `${preferred} exists, not adopted (${why}): proposed ${alt} instead`
      : `${preferred} exists, not adopted (${why}) and no free path remains`);
    return alt;
  };

  // ── Tokens: adopt the detected file, or the template at a free path ──
  const templateTokens = templateDesign(stack, componentKit)!.tokens;
  let tokensPath: string | null = null;
  let tokens: string | null = null;
  if (found?.tokens) {
    const errors = checkDesign({ ...templateDesign(stack, componentKit, found.tokens.path)!, tokens: found.tokens.content });
    if (errors.length === 0) { tokensPath = found.tokens.path; tokens = found.tokens.content; adopted.push(found.tokens.path); }
    else { notes.push(`${found.tokens.path} not adopted: ${errors[0]}`); taken.set(found.tokens.path, { reason: 'failed checks' }); }
  }
  if (tokensPath === null) { tokensPath = freePath(defaults.tokensPath, fallbacks.tokensPath, templateTokens); }
  if (tokensPath === null) { return null; }

  // ── DESIGN.md: adopt the detected document, or the template at a free path ──
  let design: DesignSystem = { ...templateDesign(stack, componentKit, tokensPath)!, ...(tokens !== null ? { tokens } : {}) };
  let docAdopted = false;
  if (found?.doc) {
    const candidate: DesignSystem = { ...design, docPath: found.doc.path, doc: found.doc.content };
    const errors = checkDesign(candidate);
    if (errors.length === 0) { design = candidate; adopted.push(found.doc.path); docAdopted = true; }
    else { notes.push(`${found.doc.path} not adopted: ${errors[0]}`); taken.set(found.doc.path, { reason: 'failed checks' }); }
  }
  if (!docAdopted) {
    // The template doc over an adopted tokens file names the template's tokens: say which of
    // them the adopted file lacks and what it defines instead.
    if (adopted.length > 0) {
      const noted = withAdoptedTokensNote(design);
      if (noted !== design && checkDesign(noted).length === 0) { design = noted; }
    }
    const docPath = freePath(defaults.docPath, fallbacks.docPath, design.doc);
    if (docPath === null) { return null; }
    design = { ...design, docPath };
  }
  const provenance = adopted.length > 0
    ? detectedTag(adopted.join(', '), ['adopted, not overwritten', ...pathNotes, ...notes].join('; '))
    : assumedTag([`${stack} default`, ...pathNotes, ...notes].join(EVIDENCE_NOTE_SEPARATOR));
  return { design, provenance };
}

/** `proposal` with the proposed design system, when there is one and the whole still validates. */
function withDesign(proposal: StandardsProposal, stack: StackId, detection: ConventionDetection): StandardsProposal {
  const proposed = proposeDesign(stack, detection, proposal.profile.frontend.componentKit);
  if (!proposed) { return proposal; }
  const checked = validateProfile({ ...proposal.profile, design: proposed.design });
  if (!checked.ok) { return proposal; }
  return { profile: checked.profile, provenance: { ...proposal.provenance, design: proposed.provenance } };
}
