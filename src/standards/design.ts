// ─── Design system: model, token parsing, rendering and diff ───
//
// A project with a user interface carries an approved design system inside its standards
// profile: a DESIGN.md (colour, type, spacing, components, layout, states, forms,
// accessibility, tone) and the tokens file the code must use. This module holds the pure
// parts — the shape and its caps, token parsing, WCAG contrast, the prompt and planner
// texts, the diff a reviewer acknowledges, and the per-stack templates.
//
// Pure: no `fs`, no `vscode`. `profile.ts` imports from here, never the other way.

import { createHash } from 'crypto';
import type { StackId } from '../shared/stacks';
import { TOKENS_CSS, designDoc } from './design-templates';

// ─── Types and caps ───

/** The approved design system, as the profile stores it. `tokens` is the tokens file's full content. */
export interface DesignSystem {
  /** Repository-relative path of DESIGN.md. */
  docPath: string;
  /** Repository-relative path of the tokens file. */
  tokensPath: string;
  /** DESIGN.md, verbatim. */
  doc: string;
  /** The tokens file, verbatim. */
  tokens: string;
}

export const MAX_DESIGN_DOC_CHARS = 12_000;
export const MAX_DESIGN_TOKENS_CHARS = 8_000;
/** Longest design block a task prompt carries. */
export const MAX_DESIGN_PROMPT_CHARS = 2_000;
/** Longest design summary a planning prompt carries. */
export const MAX_DESIGN_PLANNER_CHARS = 800;
/** Heading of the design section in a task prompt. */
export const DESIGN_SYSTEM_HEADER = '## Design System';

/** Most tokens one file is parsed into. */
export const MAX_DESIGN_TOKENS = 300;
/** How deep `var(--x)` references are followed. */
const MAX_VAR_DEPTH = 5;
/** Longest before/after text kept per changed DESIGN.md section. */
const MAX_SECTION_DIFF_CHARS = 2_000;

/** Where a template puts the two files, by stack. Only stacks with a template are listed. */
export const DEFAULT_DESIGN_PATHS: Partial<Record<StackId, { docPath: string; tokensPath: string }>> = {
  'node-ts': { docPath: 'docs/design/DESIGN.md', tokensPath: 'src/styles/tokens.css' },
  'static-web': { docPath: 'docs/design/DESIGN.md', tokensPath: 'css/tokens.css' },
};

/**
 * Where a proposal puts a design file instead when the default path is already taken by a
 * file MOAG did not adopt — tried in order, so a proposal never targets a user's file.
 */
export const FALLBACK_DESIGN_PATHS: Partial<Record<StackId, { docPath: readonly string[]; tokensPath: readonly string[] }>> = {
  'node-ts': {
    docPath: ['docs/design/DESIGN-SYSTEM.md', 'docs/design-system/DESIGN.md'],
    tokensPath: ['src/styles/design-tokens.css', 'src/design-tokens.css'],
  },
  'static-web': {
    docPath: ['docs/design/DESIGN-SYSTEM.md', 'docs/design-system/DESIGN.md'],
    tokensPath: ['css/design-tokens.css', 'styles/design-tokens.css'],
  },
};

/** Every fallback path of every stack, for a detector to probe. */
export function allFallbackDesignPaths(): string[] {
  const out: string[] = [];
  for (const p of Object.values(FALLBACK_DESIGN_PATHS)) {
    if (!p) { continue; }
    for (const rel of [...p.docPath, ...p.tokensPath]) { if (!out.includes(rel)) { out.push(rel); } }
  }
  return out;
}

/** What a token is for, as far as its name and value tell. Display only. */
export type DesignTokenKind = 'colour' | 'length' | 'radius' | 'font-size' | 'font-family' | 'other';

export interface DesignToken {
  name: string;
  value: string;
  kind: DesignTokenKind;
  /** A colour as lower-case `#rrggbb` or `#rrggbbaa`; a length in px. Absent when it could not be resolved. */
  resolved?: string | number;
}

export interface ParsedDesignTokens {
  /** False when the file is not one whose tokens MOAG can list (anything but CSS). */
  listable: boolean;
  reason?: string;
  tokens: DesignToken[];
}

// ─── Token parsing ───

const TOKEN_LINE = /^\s*(--[A-Za-z0-9_-]{1,100})\s*:\s*([^;]{1,200});/;
const HEX_VALUE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_VALUE = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*(\d*\.?\d+%?)\s*)?\)$/i;
const LENGTH_VALUE = /^(-?\d*\.?\d+)(px|rem|em)$/i;
const VAR_VALUE = /^var\(\s*(--[A-Za-z0-9_-]{1,100})\s*(?:,[^)]*)?\)$/;

/** The extension of `p`, lower-case, without the dot. */
function extensionOf(p: string): string {
  const name = p.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function two(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** A colour value as lower-case `#rrggbb[aa]`, or null when it is not a plain colour. */
export function colourHex(value: string): string | null {
  const v = value.trim();
  if (HEX_VALUE.test(v)) {
    const h = v.slice(1).toLowerCase();
    if (h.length === 3 || h.length === 4) { return '#' + [...h].map((c) => c + c).join(''); }
    return '#' + h;
  }
  const m = RGB_VALUE.exec(v);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].some((n) => n > 255)) { return null; }
    let alpha = '';
    if (m[4] !== undefined) {
      const a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      if (!Number.isFinite(a) || a < 0 || a > 1) { return null; }
      if (a < 1) { alpha = two(a * 255); }
    }
    return `#${two(r)}${two(g)}${two(b)}${alpha}`;
  }
  return null;
}

/** A length value in px (`rem`/`em` at 16px), or null. */
function lengthPx(value: string): number | null {
  const m = LENGTH_VALUE.exec(value.trim());
  if (!m) { return null; }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) { return null; }
  const px = m[2].toLowerCase() === 'px' ? n : n * 16;
  return Math.round(px * 100) / 100;
}

function kindOf(name: string, value: string): DesignTokenKind {
  const n = name.toLowerCase();
  if (n.startsWith('--radius') || n.includes('-radius')) { return 'radius'; }
  if (n.startsWith('--font-size') || n.startsWith('--text-size')) { return 'font-size'; }
  if (n.startsWith('--font-family') || n.startsWith('--font-stack')) { return 'font-family'; }
  if (colourHex(value) !== null || n.startsWith('--color') || n.startsWith('--colour')) { return 'colour'; }
  if (lengthPx(value) !== null || n.startsWith('--space') || n.startsWith('--spacing')) { return 'length'; }
  return 'other';
}

/**
 * The tokens in a tokens file. Only a `.css` file is listable: each line that declares a
 * custom property (`--name: value;`) is one token, up to {@link MAX_DESIGN_TOKENS}; any other
 * line is skipped. `var(--x)` is followed up to five levels deep to resolve a value.
 */
export function parseDesignTokens(tokensPath: string, content: string): ParsedDesignTokens {
  if (extensionOf(tokensPath) !== 'css') { return { listable: false, reason: 'not a CSS file', tokens: [] }; }
  const raw: Array<{ name: string; value: string }> = [];
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.length >= MAX_DESIGN_TOKENS) { break; }
    const m = TOKEN_LINE.exec(line);
    if (m && m[2].trim() !== '') { raw.push({ name: m[1], value: m[2].trim() }); }
  }
  const byName = new Map<string, string>();
  for (const t of raw) { if (!byName.has(t.name)) { byName.set(t.name, t.value); } }
  const deref = (value: string): string | null => {
    let v = value;
    for (let depth = 0; depth <= MAX_VAR_DEPTH; depth++) {
      const m = VAR_VALUE.exec(v.trim());
      if (!m) { return v; }
      const next = byName.get(m[1]);
      if (next === undefined) { return null; }
      v = next;
    }
    return null;
  };
  const tokens = raw.map(({ name, value }): DesignToken => {
    const target = deref(value);
    const kind = kindOf(name, target ?? value);
    const token: DesignToken = { name, value, kind };
    if (target !== null) {
      const hex = colourHex(target);
      const px = hex === null ? lengthPx(target) : null;
      if (hex !== null) { token.resolved = hex; }
      else if (px !== null && kind !== 'colour') { token.resolved = px; }
    }
    return token;
  });
  return { listable: true, tokens };
}

// ─── Contrast ───

function luminance(hex: string): number | null {
  const full = colourHex(hex);
  if (full === null) { return null; }
  const channel = (i: number): number => {
    const c = parseInt(full.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * The WCAG 2 contrast ratio of two colours (1 to 21), or null when either is not a colour.
 * Alpha is ignored: a translucent colour is judged as if it were opaque.
 */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const a = luminance(hexA);
  const b = luminance(hexB);
  if (a === null || b === null) { return null; }
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ─── Views ───

/** One token as a reader is shown it: its role and its contrast on the background. */
export interface DesignTokenView extends DesignToken {
  role?: 'background';
  /** Contrast ratio on the background token, one decimal. */
  contrast?: number;
}

export interface DesignView {
  tokens: DesignTokenView[];
  tokensListable: boolean;
  tokensReason?: string;
  /** The resolved background colour, or null when no `--color-bg`/`--color-background` token resolves. */
  background: string | null;
}

/**
 * The parsed tokens of `design` with the background marked and each other colour's contrast
 * on it — what the web app shows. Computed on the server so the browser only renders.
 */
export function designView(design: DesignSystem): DesignView {
  const parsed = parseDesignTokens(design.tokensPath, design.tokens);
  const bgIndex = parsed.tokens.findIndex((t) =>
    (t.name === '--color-bg' || t.name === '--color-background') && typeof t.resolved === 'string');
  const background = bgIndex >= 0 ? parsed.tokens[bgIndex].resolved as string : null;
  const tokens = parsed.tokens.map((t, i): DesignTokenView => {
    if (i === bgIndex) { return { ...t, role: 'background' }; }
    if (background !== null && t.kind === 'colour' && typeof t.resolved === 'string') {
      const ratio = contrastRatio(t.resolved, background);
      if (ratio !== null) { return { ...t, contrast: Math.round(ratio * 10) / 10 }; }
    }
    return { ...t };
  });
  return {
    tokens,
    tokensListable: parsed.listable,
    ...(parsed.reason ? { tokensReason: parsed.reason } : {}),
    background,
  };
}

// ─── Prompt and planner texts ───

/**
 * The design block every agent task carries, at most {@link MAX_DESIGN_PROMPT_CHARS}: where
 * the two files are, the rules, and as many `name: value` tokens as fit.
 */
export function renderDesignPromptText(design: DesignSystem, componentKit: string, version: number | null): string {
  const head = [
    `Design system${version === null ? '' : ` v${version}`} · DESIGN.md at ${design.docPath} · tokens in ${design.tokensPath}`,
    '- Read DESIGN.md first.',
    '- Use only these tokens; no raw colour or length outside the tokens file.',
    ...(componentKit ? [`- Build UI with the approved component kit, ${componentKit}; do not import another UI kit.`] : []),
    '- Every screen handles empty, loading and error states. Every input has a visible label. Text contrast is at least 4.5:1. Focus stays visible.',
    '- Never edit DESIGN.md or the tokens file.',
  ].join('\n');
  const parsed = parseDesignTokens(design.tokensPath, design.tokens);
  if (!parsed.listable) {
    return clip(`${head}\nTokens: defined in ${design.tokensPath} (not listable)`, MAX_DESIGN_PROMPT_CHARS);
  }
  const lines = [`${head}\nTokens:`];
  let used = lines[0].length;
  const tokens = parsed.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const line = `${tokens[i].name}: ${tokens[i].value}`;
    const rest = tokens.length - i - 1;
    // Keep room for the "…and N more" line unless this is the last token.
    const tail = rest > 0 ? `…and ${rest} more in ${design.tokensPath}`.length + 1 : 0;
    if (used + 1 + line.length + tail > MAX_DESIGN_PROMPT_CHARS) {
      const more = `…and ${tokens.length - i} more in ${design.tokensPath}`;
      if (used + 1 + more.length <= MAX_DESIGN_PROMPT_CHARS) { lines.push(more); }
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return clip(lines.join('\n'), MAX_DESIGN_PROMPT_CHARS);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Token counts by kind, in a fixed order: "11 colour · 8 length · 4 radius". */
function countsLine(tokens: DesignToken[]): string {
  const order: DesignTokenKind[] = ['colour', 'length', 'radius', 'font-size', 'font-family', 'other'];
  return order
    .map((k) => [k, tokens.filter((t) => t.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(' · ');
}

const PLANNER_INSTRUCTION = 'Plan every UI task against this design system and name the screen states (empty, loading, error) it must handle.';

/** The design summary a planning prompt carries, at most {@link MAX_DESIGN_PLANNER_CHARS}. */
export function renderDesignPlannerSummary(design: DesignSystem, componentKit: string): string {
  const parsed = parseDesignTokens(design.tokensPath, design.tokens);
  const tokens = parsed.listable
    ? `${parsed.tokens.length} token${parsed.tokens.length === 1 ? '' : 's'}${parsed.tokens.length > 0 ? ` (${countsLine(parsed.tokens)})` : ''}`
    : 'tokens not listable';
  const first = `Design system: DESIGN.md at ${design.docPath}; tokens in ${design.tokensPath}, ${tokens}` +
    (componentKit ? `; component kit ${componentKit}` : '') + '.';
  return `${clip(first, MAX_DESIGN_PLANNER_CHARS - PLANNER_INSTRUCTION.length - 1)}\n${PLANNER_INSTRUCTION}`;
}

// ─── Diff ───

export interface DesignTokenChange {
  name: string;
  before: string | null;
  after: string | null;
  beforeResolved?: string | number;
  afterResolved?: string | number;
}

export interface DesignSectionChange {
  heading: string;
  before: string | null;
  after: string | null;
}

export interface DesignChanges {
  changed: boolean;
  /** Set when either path differs, or the design was added or removed. */
  paths: { before: { docPath: string; tokensPath: string } | null; after: { docPath: string; tokensPath: string } | null } | null;
  tokens: DesignTokenChange[];
  sections: DesignSectionChange[];
  docChanged: boolean;
  /** Both tokens files verbatim, set only when either is not listable and they differ. */
  raw?: { before: string | null; after: string | null };
}

const norm = (s: string): string => s.replace(/\r\n?/g, '\n');

/** DESIGN.md split at lines starting with `#`; the text before the first heading is keyed ''. */
function docSections(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading = '';
  let body: string[] = [];
  const flush = (): void => {
    const text = body.join('\n').trim();
    if (text !== '' || heading !== '') {
      const key = out.has(heading) ? `${heading} (${out.size + 1})` : heading;
      out.set(key, text);
    }
  };
  for (const line of norm(doc).split('\n')) {
    if (line.startsWith('#')) {
      flush();
      heading = line.replace(/^#+\s*/, '').trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

/**
 * What `after` changes about the design system relative to `before`. Either side may be null
 * (no design system). Every difference counts: a reviewer decides what it means.
 */
export function designChangesBetween(before: DesignSystem | null, after: DesignSystem | null): DesignChanges {
  const none: DesignChanges = { changed: false, paths: null, tokens: [], sections: [], docChanged: false };
  if (!before && !after) { return none; }
  const pathsOf = (d: DesignSystem | null): { docPath: string; tokensPath: string } | null =>
    (d ? { docPath: d.docPath, tokensPath: d.tokensPath } : null);
  const pathsChanged = JSON.stringify(pathsOf(before)) !== JSON.stringify(pathsOf(after));

  const pb = before ? parseDesignTokens(before.tokensPath, before.tokens) : { listable: true, tokens: [] as DesignToken[] };
  const pa = after ? parseDesignTokens(after.tokensPath, after.tokens) : { listable: true, tokens: [] as DesignToken[] };
  const tokensTextChanged = norm(before?.tokens ?? '') !== norm(after?.tokens ?? '') || !before !== !after;
  const tokens: DesignTokenChange[] = [];
  const beforeMap = new Map(pb.tokens.map((t) => [t.name, t] as const));
  const afterMap = new Map(pa.tokens.map((t) => [t.name, t] as const));
  for (const t of pa.tokens) {
    if (tokens.some((c) => c.name === t.name)) { continue; }
    const b = beforeMap.get(t.name);
    if (b && b.value === t.value) { continue; }
    tokens.push({
      name: t.name, before: b?.value ?? null, after: t.value,
      ...(b?.resolved !== undefined ? { beforeResolved: b.resolved } : {}),
      ...(t.resolved !== undefined ? { afterResolved: t.resolved } : {}),
    });
  }
  for (const t of pb.tokens) {
    if (afterMap.has(t.name) || tokens.some((c) => c.name === t.name)) { continue; }
    tokens.push({ name: t.name, before: t.value, after: null, ...(t.resolved !== undefined ? { beforeResolved: t.resolved } : {}) });
  }

  const docChanged = norm(before?.doc ?? '') !== norm(after?.doc ?? '') || !before !== !after;
  const sections: DesignSectionChange[] = [];
  if (docChanged) {
    const sb = docSections(before?.doc ?? '');
    const sa = docSections(after?.doc ?? '');
    const cap = (s: string | undefined): string | null => (s === undefined ? null : s.length > MAX_SECTION_DIFF_CHARS ? s.slice(0, MAX_SECTION_DIFF_CHARS) + '…' : s);
    for (const [heading, text] of sa) {
      if (sb.get(heading) !== text) { sections.push({ heading, before: cap(sb.get(heading)), after: cap(text) }); }
    }
    for (const [heading, text] of sb) {
      if (!sa.has(heading)) { sections.push({ heading, before: cap(text), after: null }); }
    }
  }

  const unlistable = (before !== null && !pb.listable) || (after !== null && !pa.listable);
  const changed = pathsChanged || tokensTextChanged || docChanged;
  return {
    changed,
    paths: pathsChanged ? { before: pathsOf(before), after: pathsOf(after) } : null,
    tokens,
    sections,
    docChanged,
    ...(unlistable && tokensTextChanged ? { raw: { before: before?.tokens ?? null, after: after?.tokens ?? null } } : {}),
  };
}

// ─── Fingerprint (audit and enforcement comparisons) ───

function sha256(text: string): string {
  return createHash('sha256').update(norm(text), 'utf8').digest('hex');
}

/**
 * What the design rule is configured with, as hashes: enough to tell two configurations
 * apart without any DESIGN.md prose reaching an audit log. The keys avoid the words the
 * audit log refuses as secret-shaped (`token`, `key`): this lands in audit entries.
 */
export function designConfigFingerprint(design: DesignSystem, componentKit: string): {
  docPath: string; valuesPath: string; docSha256: string; valuesSha256: string; componentKit: string;
} {
  return {
    docPath: design.docPath,
    valuesPath: design.tokensPath,
    docSha256: sha256(design.doc),
    valuesSha256: sha256(design.tokens),
    componentKit,
  };
}

// ─── Component kits ───

/**
 * The UI kits MOAG recognises in an import, mirroring the component libraries the project
 * detector knows. `allows` names packages a kit legitimately pulls in beside its own.
 */
export const KNOWN_COMPONENT_KITS: ReadonlyArray<{ label: string; packages: readonly string[]; allows?: readonly string[] }> = [
  { label: 'MUI', packages: ['@mui/material', '@mui/joy', '@material-ui/core'] },
  { label: 'Ant Design', packages: ['antd'] },
  { label: 'Chakra UI', packages: ['@chakra-ui/react'] },
  { label: 'Mantine', packages: ['@mantine/core'] },
  { label: 'Radix UI', packages: ['@radix-ui/themes'] },
  { label: 'Headless UI', packages: ['@headlessui/react'] },
  { label: 'Vuetify', packages: ['vuetify'] },
  { label: 'React Bootstrap', packages: ['react-bootstrap'], allows: ['bootstrap'] },
  { label: 'Bootstrap', packages: ['bootstrap'] },
  { label: 'Tailwind CSS', packages: ['tailwindcss'] },
];

/** The known kit `componentKit` names (by label or package, any case), or null. */
export function knownComponentKit(componentKit: string): (typeof KNOWN_COMPONENT_KITS)[number] | null {
  const k = componentKit.trim().toLowerCase();
  if (!k) { return null; }
  return KNOWN_COMPONENT_KITS.find((kit) => kit.label.toLowerCase() === k || kit.packages.some((p) => p === k)) ?? null;
}

/** The package of another known kit that `spec` imports while `kit` is the approved one, or null. */
export function foreignKitImport(spec: string, kit: (typeof KNOWN_COMPONENT_KITS)[number]): { pkg: string; label: string } | null {
  const mine = new Set([...kit.packages, ...(kit.allows ?? [])]);
  for (const other of KNOWN_COMPONENT_KITS) {
    if (other === kit) { continue; }
    for (const pkg of other.packages) {
      if (mine.has(pkg)) { continue; }
      if (spec === pkg || spec.startsWith(pkg + '/')) { return { pkg, label: other.label }; }
    }
  }
  return null;
}

// ─── Proposal helpers ───

/** UI frameworks whose presence means the project has screens. */
const UI_FRAMEWORKS = new Set(['React', 'Vue', 'Svelte', 'Angular', 'Next.js']);

/** The parts of a convention detection that tell whether a project has a user interface. */
export interface DesignUiSignals {
  stack: { value: string } | null;
  framework: { value: string } | null;
  componentLibrary: { value: string } | null;
  designSources?: { ui: { value: string; evidence: string } | null } | null;
}

/** True when the detection shows a user interface: a static site, a UI framework, a component kit or an index.html. */
export function hasDesignUi(detection: DesignUiSignals): boolean {
  return detection.stack?.value === 'static-web'
    || (detection.framework !== null && UI_FRAMEWORKS.has(detection.framework.value))
    || detection.componentLibrary !== null
    || !!detection.designSources?.ui;
}

/**
 * The template design system for `stack`, naming `componentKit` when set, or null for a
 * stack with no template. Deterministic: the same arguments give the same bytes.
 */
export function templateDesign(stack: StackId, componentKit: string, tokensPath?: string, docPath?: string): DesignSystem | null {
  const paths = DEFAULT_DESIGN_PATHS[stack];
  if (!paths) { return null; }
  const tp = tokensPath ?? paths.tokensPath;
  return { docPath: docPath ?? paths.docPath, tokensPath: tp, doc: designDoc(stack, componentKit, tp), tokens: TOKENS_CSS };
}

// ─── Template doc over an adopted tokens file ───

/** Heading of the note {@link withAdoptedTokensNote} inserts. */
export const ADOPTED_TOKENS_NOTE_HEADING = '## Token names in the adopted tokens file';

/** `names` as `a`, `b`, … in backticks, stopping before `budget` characters with "and N more". */
function nameList(names: string[], budget: number): string {
  const shown: string[] = [];
  let used = 0;
  for (const n of names) {
    const item = `\`${n}\``;
    if (shown.length > 0 && used + item.length + 2 > budget) { break; }
    shown.push(item);
    used += item.length + 2;
  }
  const rest = names.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

/**
 * The token names `doc` references (in backticks) in first-seen order, which is how the
 * template names every token it tells agents to use.
 */
function referencedTokenNames(doc: string): string[] {
  const out: string[] = [];
  for (const m of doc.matchAll(/`(--[A-Za-z0-9_-]{1,100})`/g)) {
    if (!out.includes(m[1])) { out.push(m[1]); }
  }
  return out;
}

/**
 * The template DESIGN.md paired with a tokens file adopted from the repository: the doc's
 * token names are the template's, which the adopted file may not define. Inserts, before the
 * first section, a note naming the referenced tokens the adopted file lacks and the names it
 * does define, so an agent never writes `var(--x)` for an undefined `--x`. Returns `design`
 * unchanged when the adopted file is listable and defines every referenced name.
 * Deterministic, and bounded to about 3 000 added characters.
 */
export function withAdoptedTokensNote(design: DesignSystem): DesignSystem {
  const referenced = referencedTokenNames(design.doc);
  const parsed = parseDesignTokens(design.tokensPath, design.tokens);
  const tp = design.tokensPath;
  let body: string;
  if (parsed.listable) {
    const defined = new Set(parsed.tokens.map((t) => t.name));
    const missing = referenced.filter((n) => !defined.has(n));
    if (missing.length === 0) { return design; }
    const definedText = parsed.tokens.length > 0
      ? `Use only the names ${tp} defines — ${nameList(parsed.tokens.map((t) => t.name), 1400)} — choosing, for each role this document describes, the token that plays it.`
      : `${tp} defines no CSS custom property MOAG could list, so take every value from the file's own definitions.`;
    body = [
      `${tp} was adopted from the repository as it is; the token names in this document come from MOAG's template. ${missing.length} of them ${missing.length === 1 ? 'is' : 'are'} not defined in ${tp}: ${nameList(missing, 900)}.`,
      definedText,
      'Never reference a token the tokens file does not define. A reviewer can rewrite this document to the adopted names before approving it.',
    ].join(' ');
  } else {
    body = [
      `${tp} was adopted from the repository as it is (${parsed.reason ?? 'not a CSS file'}), so MOAG could not check this document's token names against it; they come from MOAG's template.`,
      `Use the names ${tp} defines, choosing for each role this document describes the one that plays it, and never reference a token it does not define.`,
      'A reviewer can rewrite this document to the adopted names before approving it.',
    ].join(' ');
  }
  const note = `${ADOPTED_TOKENS_NOTE_HEADING}\n\n${body}\n\n`;
  const at = design.doc.indexOf('\n## ');
  const doc = at < 0 ? `${design.doc.replace(/\n*$/, '\n\n')}${note}` : `${design.doc.slice(0, at + 1)}${note}${design.doc.slice(at + 1)}`;
  return { ...design, doc };
}
