// ─── PRD requirements — parsing, stable IDs, tag write-back and diff ───
//
// Pure functions over PRD markdown. No `vscode`, no `fs`, no `path`: the same code runs in
// the extension, the headless CLI and the unit tests.
//
// A requirement is one bulleted (`-`, `*`, `+`), numbered (`1.`, `1)`) or acceptance-criteria
// (`AC1:`) line that sits under a heading whose text mentions "requirement(s)" or
// "acceptance criteria". Its stable ID is an inline `[R-n]` tag. Untagged lines are given
// an ID on save and the tag is written back into the text, so the ID survives later edits.
//
// The heading rule below is pinned by tests. Changing it re-identifies requirements in
// users' existing PRDs, so treat it as a data contract.

import { Plan, PrdVersion, SemverBump } from './types';

// ─── Types ───

/** One requirement line, with its stable ID. */
export interface Requirement {
  id: string;
  /** Human text with ID tags and checkbox removed (continuation lines joined with a space) */
  text: string;
  /** Comparison key: text lowercased with whitespace collapsed */
  normalized: string;
  /** 1-based line number of the requirement's first line */
  line: number;
  /** True when the ID came from an inline `[R-n]` tag rather than being assigned */
  tagged: boolean;
}

/** A problem that makes requirement IDs ambiguous — e.g. one ID on two lines. */
export interface RequirementParseError {
  id: string;
  line: number;
  message: string;
}

/** Requirement-level difference between two PRD versions, every bucket sorted by ID number. */
export interface RequirementDiff {
  added: Array<{ id: string; text: string }>;
  changed: Array<{ id: string; before: string; after: string }>;
  removed: Array<{ id: string; text: string }>;
  unchanged: Array<{ id: string; text: string }>;
}

/** A parsed requirement line; `id` is null when the line carries no inline tag. */
export type ParsedRequirement = Omit<Requirement, 'id' | 'tagged'> & { id: string | null };

// ─── Patterns ───

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const REQUIREMENT_HEADING_RE = /\b(requirements?|acceptance\s+criteria)\b/i;
const ITEM_RE = /^(\s*)([-*+]|\d+[.)]|AC\d+[:.)])(\s+)(\[[ xX]\]\s+)?(.*)$/i;
const FENCE_RE = /^\s*(```|~~~)/;
const TAG_RE = /\[R-(\d+)\]/g;
/** A tag plus at most one following space/tab — exactly what write-back inserts. */
const TAG_WITH_SPACE_RE = /\[R-\d+\][ \t]?/g;
const LEADING_CHECKBOX_RE = /^\[[ xX]\]\s+/;

// ─── Internal parse ───

interface RawItem {
  id: string | null;
  firstLine: string;
  continuation: string[];
  line: number;
  /** Character offset in the first line where a tag would be inserted */
  insertAt: number;
}

interface RawParse {
  lines: string[];
  items: RawItem[];
  errors: RequirementParseError[];
}

/** Display width of leading whitespace — a tab counts as 4 columns. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) {
    width += ch === '\t' ? 4 : 1;
  }
  return width;
}

/** Numeric part of an `R-n` ID (NaN-safe: unknown shapes sort last). */
function idNumber(id: string): number {
  const m = /^R-(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Remove inline `[R-n]` tags (and the single space write-back adds after each) and trim.
 */
export function stripRequirementTags(text: string): string {
  return text.replace(TAG_WITH_SPACE_RE, '').trim();
}

/** Build the human text and the comparison key for an item. */
function describeItem(item: RawItem): { text: string; normalized: string } {
  const pieces = [item.firstLine, ...item.continuation]
    .map(p => stripRequirementTags(p))
    .filter(p => p.length > 0);
  const text = pieces.join(' ');
  const normalized = text
    .replace(LEADING_CHECKBOX_RE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return { text, normalized };
}

function parseRaw(markdown: string): RawParse {
  const lines = markdown.split(/\r?\n/);
  const items: RawItem[] = [];
  const errors: RequirementParseError[] = [];

  let sectionLevel: number | null = null;
  let current: RawItem | null = null;
  let fence: string | null = null;

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    // Fenced blocks are opaque: nothing inside them is a heading or an item.
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1] === fence) { fence = null; }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      current = null;
      return;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      current = null;
      const level = heading[1].length;
      const matches = REQUIREMENT_HEADING_RE.test(heading[2]);
      if (matches) {
        if (sectionLevel === null || level <= sectionLevel) { sectionLevel = level; }
      } else if (sectionLevel !== null && level <= sectionLevel) {
        sectionLevel = null;
      }
      return;
    }

    if (sectionLevel === null) {
      current = null;
      return;
    }

    if (line.trim().length === 0) {
      return; // a blank line does not end an item
    }

    const leading = /^\s*/.exec(line)?.[0] ?? '';
    if (indentWidth(leading) >= 2) {
      if (current) { current.continuation.push(line.trim()); }
      return;
    }

    const item = ITEM_RE.exec(line);
    if (!item || item[5].trim().length === 0) {
      current = null;
      return;
    }

    const content = item[5];
    const tags = [...content.matchAll(TAG_RE)].map(m => `R-${Number(m[1])}`);
    const insertAt = item[1].length + item[2].length + item[3].length + (item[4]?.length ?? 0);
    const raw: RawItem = { id: tags[0] ?? null, firstLine: content, continuation: [], line: lineNo, insertAt };
    if (tags.length > 1) {
      errors.push({
        id: tags[0],
        line: lineNo,
        message: `Line ${lineNo} has more than one requirement tag (${tags.join(', ')}) — keep exactly one.`,
      });
    }
    items.push(raw);
    current = raw;
  });

  // Duplicate IDs: keep both items, report the second (and any later) occurrence.
  const firstSeen = new Map<string, number>();
  for (const item of items) {
    if (item.id === null) { continue; }
    const first = firstSeen.get(item.id);
    if (first === undefined) {
      firstSeen.set(item.id, item.line);
    } else {
      errors.push({ id: item.id, line: item.line, message: `${item.id} appears on lines ${first} and ${item.line}` });
    }
  }

  return { lines, items, errors };
}

// ─── Public API ───

/**
 * Parse the requirement lines of a PRD. Untagged lines come back with `id: null`.
 * Duplicate inline IDs keep both items and add an error naming the ID and both lines.
 */
export function parseRequirements(markdown: string): { items: ParsedRequirement[]; errors: RequirementParseError[] } {
  const raw = parseRaw(markdown);
  const items = raw.items.map(item => ({ id: item.id, line: item.line, ...describeItem(item) }));
  return { items, errors: raw.errors };
}

/** Every `[R-n]` tag anywhere in a text, as `R-n`. */
function inlineTagIds(text: string): string[] {
  return [...text.matchAll(TAG_RE)].map(m => `R-${Number(m[1])}`);
}

/** The dominant line ending of a text (CRLF wins only when it is the majority). */
function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Give every requirement line a stable ID and write the new tags back into the text.
 *
 * - A tagged line keeps its ID.
 * - An untagged line, in document order, takes the ID of a `previous` requirement with
 *   identical normalized text whose ID is not already used in this document (no fuzzy match).
 * - Otherwise it gets `R-(max+1)`, where max spans previous, reserved and inline IDs, so a
 *   removed ID is never reused while it is still reserved.
 *
 * Already-tagged input is returned byte-identical; otherwise the dominant line ending is kept.
 */
export function assignRequirementIds(
  markdown: string,
  opts: { previous?: readonly Requirement[]; reservedIds?: Iterable<string> } = {},
): { text: string; requirements: Requirement[]; errors: RequirementParseError[] } {
  const raw = parseRaw(markdown);
  const previous = opts.previous ?? [];

  let max = 0;
  const consider = (id: string) => {
    const n = idNumber(id);
    if (n !== Number.MAX_SAFE_INTEGER && n > max) { max = n; }
  };
  previous.forEach(r => consider(r.id));
  for (const id of opts.reservedIds ?? []) { consider(id); }
  inlineTagIds(markdown).forEach(consider);

  const used = new Set<string>();
  raw.items.forEach(item => { if (item.id) { used.add(item.id); } });

  const insertions = new Map<number, { at: number; id: string }>();
  const requirements: Requirement[] = raw.items.map(item => {
    const { text, normalized } = describeItem(item);
    if (item.id !== null) {
      return { id: item.id, text, normalized, line: item.line, tagged: true };
    }
    const match = previous.find(p => p.normalized === normalized && !used.has(p.id));
    const id = match ? match.id : `R-${++max}`;
    used.add(id);
    insertions.set(item.line - 1, { at: item.insertAt, id });
    return { id, text, normalized, line: item.line, tagged: false };
  });

  if (insertions.size === 0) {
    return { text: markdown, requirements, errors: raw.errors };
  }

  const lines = raw.lines.map((line, index) => {
    const ins = insertions.get(index);
    return ins ? `${line.slice(0, ins.at)}[${ins.id}] ${line.slice(ins.at)}` : line;
  });
  return { text: lines.join(dominantEol(markdown)), requirements, errors: raw.errors };
}

/**
 * Resolve the requirements of a PRD text, assigning virtual IDs to untagged lines.
 * Used for legacy untagged versions — the assigned tags are never written anywhere.
 */
export function resolveRequirements(
  markdown: string,
  previous?: readonly Requirement[],
  reserved?: Iterable<string>,
): Requirement[] {
  return assignRequirementIds(markdown, { previous, reservedIds: reserved }).requirements;
}

/**
 * Every requirement ID the plan has ever used: inline tags in every saved PRD version,
 * every trace record and every task's `requirementIds`. New IDs are numbered above these.
 */
export function collectReservedRequirementIds(plan: Plan): Set<string> {
  const ids = new Set<string>();
  for (const v of plan.prdVersions ?? []) {
    inlineTagIds(v.text).forEach(id => ids.add(id));
  }
  for (const r of plan.requirementTrace ?? []) {
    ids.add(r.id);
  }
  for (const pl of plan.playlists) {
    for (const t of pl.tasks) {
      (t.requirementIds ?? []).forEach(id => ids.add(id));
    }
  }
  return ids;
}

/**
 * Diff two requirement lists by ID. Same ID with a different normalized text is `changed`;
 * whitespace-, case- and checkbox-only edits are `unchanged`. Pure: inputs are not mutated
 * and every output array is fresh. When an ID occurs twice in one list the first wins.
 */
export function diffRequirements(older: readonly Requirement[], newer: readonly Requirement[]): RequirementDiff {
  const byId = (list: readonly Requirement[]) => {
    const map = new Map<string, Requirement>();
    for (const r of list) {
      if (!map.has(r.id)) { map.set(r.id, r); }
    }
    return map;
  };
  const before = byId(older);
  const after = byId(newer);
  const diff: RequirementDiff = { added: [], changed: [], removed: [], unchanged: [] };

  for (const [id, req] of after) {
    const prev = before.get(id);
    if (!prev) {
      diff.added.push({ id, text: req.text });
    } else if (prev.normalized !== req.normalized) {
      diff.changed.push({ id, before: prev.text, after: req.text });
    } else {
      diff.unchanged.push({ id, text: req.text });
    }
  }
  for (const [id, req] of before) {
    if (!after.has(id)) { diff.removed.push({ id, text: req.text }); }
  }

  const byNumber = (a: { id: string }, b: { id: string }) => idNumber(a.id) - idNumber(b.id);
  diff.added.sort(byNumber);
  diff.changed.sort(byNumber);
  diff.removed.sort(byNumber);
  diff.unchanged.sort(byNumber);
  return diff;
}

// ─── Semver recommendation and labels ───

/** A recommended bump and the human reason for it; `bump` is null when nothing changed. */
export interface BumpRecommendation {
  bump: SemverBump | null;
  rationale: string;
}

/** Parsed `major.minor.patch` triple. */
export interface ParsedVersionLabel {
  major: number;
  minor: number;
  patch: number;
}

/** Most IDs a rationale lists before summarising the rest. */
const RATIONALE_ID_CAP = 10;

/** `R-3, R-5` — capped at 10, then `…and N more`. */
function listIds(entries: ReadonlyArray<{ id: string }>): string {
  const list = entries.map(e => e.id);
  if (list.length <= RATIONALE_ID_CAP) { return list.join(', '); }
  return `${list.slice(0, RATIONALE_ID_CAP).join(', ')} …and ${list.length - RATIONALE_ID_CAP} more`;
}

/**
 * Deterministic semver recommendation from a requirement diff:
 * any removed → major; otherwise any added or changed → minor; otherwise a text change
 * outside the requirement list → patch; otherwise null (nothing to save).
 */
export function recommendBump(diff: RequirementDiff, textChanged: boolean): BumpRecommendation {
  if (diff.removed.length > 0) {
    return { bump: 'major', rationale: `Major: removed ${listIds(diff.removed)}.` };
  }
  if (diff.added.length > 0 || diff.changed.length > 0) {
    const parts: string[] = [];
    if (diff.added.length > 0) { parts.push(`added ${listIds(diff.added)}`); }
    if (diff.changed.length > 0) { parts.push(`changed ${listIds(diff.changed)}`); }
    return { bump: 'minor', rationale: `Minor: ${parts.join('; ')}.` };
  }
  if (textChanged) {
    return {
      bump: 'patch',
      rationale: 'Patch: text outside the requirement list changed; no requirement was added, changed or removed.',
    };
  }
  return { bump: null, rationale: 'No change.' };
}

/**
 * Parse a version label such as `2.3.0`, `v1.0` or `V2`. Missing parts are 0.
 * @returns null when the label is not a version number.
 */
export function parseVersionLabel(label: string): ParsedVersionLabel | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i.exec(label.trim());
  if (!m) { return null; }
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

function applyBump(base: ParsedVersionLabel, bump: SemverBump): ParsedVersionLabel {
  switch (bump) {
    case 'major': return { major: base.major + 1, minor: 0, patch: 0 };
    case 'minor': return { major: base.major, minor: base.minor + 1, patch: 0 };
    case 'patch': return { major: base.major, minor: base.minor, patch: base.patch + 1 };
  }
}

const tripleText = (v: ParsedVersionLabel) => `${v.major}.${v.minor}.${v.patch}`;

/**
 * The next version label after `versions`, computed from the **last** entry's label —
 * never from the array length, which is capped by retention. Unparsable labels fall back
 * to the nearest earlier parsable one (or 0.0.0). The result has no `v` prefix and never
 * collides with an existing label (patch is bumped until it is unique).
 */
export function nextVersionLabel(versions: ReadonlyArray<Pick<PrdVersion, 'version'>>, bump: SemverBump): string {
  if (versions.length === 0) { return '1.0.0'; }
  let base: ParsedVersionLabel = { major: 0, minor: 0, patch: 0 };
  for (let i = versions.length - 1; i >= 0; i--) {
    const parsed = parseVersionLabel(versions[i].version);
    if (parsed) { base = parsed; break; }
  }
  const taken = new Set<string>();
  for (const v of versions) {
    const parsed = parseVersionLabel(v.version);
    if (parsed) { taken.add(tripleText(parsed)); }
  }
  let next = applyBump(base, bump);
  while (taken.has(tripleText(next))) {
    next = { ...next, patch: next.patch + 1 };
  }
  return tripleText(next);
}

/** Display form of a label: prefix `v` unless it already starts with `v`/`V`. */
export function formatVersionLabel(label: string): string {
  return /^v/i.test(label) ? label : `v${label}`;
}

// ─── Save preparation ───

/** Outcome of preparing a PRD save — either refused with a reason, or a ready entry. */
export type PrdVersionPreparation =
  | { ok: false; reason: 'duplicate-ids'; errors: RequirementParseError[]; message: string }
  | { ok: false; reason: 'no-change'; message: string }
  | {
    ok: true;
    entry: PrdVersion;
    taggedText: string;
    diff: RequirementDiff | null;
    recommendation: BumpRecommendation;
  };

/**
 * Prepare a new PRD version: assign requirement IDs (writing tags into the text), diff
 * against the last saved version, recommend a bump and compute the label. Pure — the
 * caller appends `entry` and persists. Refuses ambiguous IDs and unchanged text.
 */
export function preparePrdVersion(input: {
  text: string;
  versions: readonly PrdVersion[];
  reservedIds?: Iterable<string>;
  override?: SemverBump;
  createdAt?: string;
}): PrdVersionPreparation {
  const reserved = input.reservedIds ? [...input.reservedIds] : [];
  const last = input.versions.length > 0 ? input.versions[input.versions.length - 1] : undefined;
  // Same resolution order as computeLatestDiff, so the IDs this save reports are the IDs
  // every later diff of these two versions reports.
  const pair = last ? resolveVersionPair(last.text, input.text, reserved) : undefined;
  const previous = pair?.older;
  const assigned = pair ? pair.newer : assignRequirementIds(input.text, { reservedIds: reserved });

  if (assigned.errors.length > 0) {
    return {
      ok: false,
      reason: 'duplicate-ids',
      errors: assigned.errors,
      message: `PRD not saved — requirement IDs are ambiguous: ${assigned.errors.map(e => e.message).join('; ')}`,
    };
  }

  const createdAt = input.createdAt ?? new Date().toISOString();

  if (!last || !previous) {
    return {
      ok: true,
      entry: { version: nextVersionLabel([], 'major'), text: assigned.text, createdAt },
      taggedText: assigned.text,
      diff: null,
      recommendation: { bump: null, rationale: 'First version.' },
    };
  }

  if (stripRequirementTags(input.text) === stripRequirementTags(last.text)) {
    return {
      ok: false,
      reason: 'no-change',
      message: `No changes since ${formatVersionLabel(last.version)} — nothing saved.`,
    };
  }

  const diff = diffRequirements(previous, assigned.requirements);
  const recommendation = recommendBump(diff, true);
  const recommended: SemverBump = recommendation.bump ?? 'patch';
  const chosen = input.override ?? recommended;
  return {
    ok: true,
    entry: {
      version: nextVersionLabel(input.versions, chosen),
      text: assigned.text,
      createdAt,
      recommendedBump: recommended,
      chosenBump: chosen,
    },
    taggedText: assigned.text,
    diff,
    recommendation,
  };
}

/**
 * Relabel the last saved version with a different bump (the owner's override).
 * The label is recomputed from the entry before it. Returns a new array, or null when
 * there is no previous entry or the last entry carries no recommendation.
 */
export function relabelLastPrdVersion(versions: readonly PrdVersion[], bump: SemverBump): PrdVersion[] | null {
  if (versions.length < 2) { return null; }
  const last = versions[versions.length - 1];
  if (!last.recommendedBump) { return null; }
  const earlier = versions.slice(0, -1);
  const relabelled: PrdVersion = { ...last, version: nextVersionLabel(earlier, bump), chosenBump: bump };
  return [...earlier, relabelled];
}

/**
 * Resolve an older and a newer PRD text as a pair — the one order both preparePrdVersion
 * and computeLatestDiff use, so a save and every later diff of the same two versions agree
 * on IDs (legacy untagged versions included):
 *   1. the older version's inline tags (never dependent on `reserved`),
 *   2. the newer text, untagged lines matched to those tags by text, the rest numbered
 *      above previous ∪ reserved ∪ inline,
 *   3. the older version's untagged lines, matched to the newer requirements by text — so
 *      a legacy version's virtual IDs are never numbered above the newer tags.
 */
function resolveVersionPair(
  olderText: string,
  newerText: string,
  reserved: readonly string[],
): { older: Requirement[]; newer: ReturnType<typeof assignRequirementIds> } {
  const olderTagged = resolveRequirements(olderText).filter(r => r.tagged);
  const newer = assignRequirementIds(newerText, { previous: olderTagged, reservedIds: reserved });
  const older = resolveRequirements(olderText, newer.requirements, reserved);
  return { older, newer };
}

/**
 * Requirement diff between the last two saved versions, or null with fewer than two.
 * Resolved with resolveVersionPair — the same order preparePrdVersion used for the save.
 */
export function computeLatestDiff(versions: readonly PrdVersion[], reserved?: Iterable<string>): RequirementDiff | null {
  if (versions.length < 2) { return null; }
  const reservedList = reserved ? [...reserved] : [];
  const pair = resolveVersionPair(versions[versions.length - 2].text, versions[versions.length - 1].text, reservedList);
  return diffRequirements(pair.older, pair.newer.requirements);
}
