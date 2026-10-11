// ─── /p/:id/standards — project standards: versions, review, edit (UX §2.2–2.7) ───
//
// Standards are versioned project state with their own approver. A proposal is
// always a NEW version (N+1, pending); the approved version stays in effect
// until a reviewer approves the next one. Every field shows whether MOAG
// detected it (and the file that proved it) or assumed it from the stack
// default, and commands are shown exactly as a run would execute them.
//
// Approve and accept-defaults echo the `contentHash` the user saw, so a version
// that changed underneath them is refused (409) rather than approved. Each
// control renders only when its action is in the DTO's `allowedActions`.

import { h, mount, badge, glyph, toast, announce, confirmDialog, field, skeleton, errorCard, fmtAgo, fmtTime } from '../dom.js';
import { STR, serverMessage } from '../strings.js';
import { designSummary, tokenTable, designDoc, tokenDiffTable, previewTokens } from './design-view.js';

const LIST_CAP = 50;

/** projectId → { from, baseVersion, vals } — an edit in progress survives re-renders within the page. */
const drafts = new Map();

const STATUS_BADGE = {
  pending: ['PENDING REVIEW', 'warning'],
  approved: ['APPROVED', 'muted'],
  rejected: ['REJECTED', 'muted'],
  superseded: ['SUPERSEDED', 'muted'],
};

const STATUS_WORDS = { pending: 'pending review', approved: 'approved', rejected: 'rejected', superseded: 'superseded' };

/** Profile section keys in display order, with their headings. */
const SECTIONS = [
  ['structure', 'Folder structure'],
  ['frontend', 'Frontend'],
  ['design', 'Design system'],
  ['backend', 'Backend layering'],
  ['naming', 'Naming'],
  ['comments', 'Comment policy'],
  ['testing', 'Testing'],
  ['severity', 'What blocks a release'],
  ['commands', 'Commands'],
  ['builtInRuleIds', 'Built-in rules'],
  ['freeText', 'Free-text rules'],
];

/** What each rule checks, in the words the review screen uses. The ids are the server's closed set. */
const RULE_LABELS = {
  'structure/required-dirs': 'Required directories exist',
  'structure/top-level': 'New top-level entries are in the allowed layout',
  'structure/placement': 'Files sit where the placement rules say',
  'structure/nested-repository': 'No git repository nested inside the workspace',
  'frontend/raw-pattern': 'Raw frontend patterns',
  'frontend/design-tokens': 'UI files use the design tokens and component kit',
  'layering/imports': 'Layers import only what they may',
  'naming/files': 'File names follow the naming style',
  'comment-policy/commented-out-code': 'No commented-out code',
  'comment-policy/banned-phrase': 'No banned placeholder phrases',
  'comment-policy/density': 'Comment density stays under the limit',
  'exemption/newly-generated': 'No file newly marked as generated',
};
const SEVERITY_WORDS = { blocking: 'Blocking', advisory: 'Advisory' };

/**
 * Every rule's default severity, as the server last sent it (`severityDefaults`). The rule
 * ids and their order come from here, so a rule the server adds shows up without a change
 * to this file.
 */
let severityDefaults = {};

/**
 * The rules MOAG decides by scanning text itself, as the server last sent them
 * (`scannerRules`). Making one blocking is allowed and is warned about: a heuristic can stop
 * correct code and can miss a violation.
 */
let scannerRules = [];
const isScannerRule = (rule) => scannerRules.includes(rule);

const count = (n) => Number(n || 0).toLocaleString('en-US');
const list = (v) => (Array.isArray(v) ? v : []);
const joined = (v) => list(v).join(', ');

/** The severity of every rule under `profile`: its override where it has one, else the default. */
function resolvedSeverity(profile) {
  const overrides = (profile && profile.severity) || {};
  const out = {};
  for (const rule of Object.keys(severityDefaults)) {
    out[rule] = overrides[rule] === 'blocking' || overrides[rule] === 'advisory' ? overrides[rule] : severityDefaults[rule];
  }
  return out;
}

const ruleLabel = (rule) => (RULE_LABELS[rule] ? `${RULE_LABELS[rule]} (${rule})` : rule);

/** The scanner rules `profile` holds as blocking: what a reviewer is warned about. */
function promotedScannerRules(profile) {
  const severity = resolvedSeverity(profile);
  return Object.keys(severity).filter((rule) => severity[rule] === 'blocking' && isScannerRule(rule));
}

/**
 * One line per rule a version promotes or demotes, as the server computed it against the
 * standards in effect (or the defaults when nothing is): "<rule>: blocking → advisory".
 * Entries with an unknown severity word are dropped rather than shown as something else.
 */
function severityChangeLines(version) {
  return list(version && version.severityChanged)
    .filter((c) => c && SEVERITY_WORDS[c.from] && SEVERITY_WORDS[c.to])
    .map((c) => `${ruleLabel(c.rule)}: ${c.from} → ${c.to}`);
}

/**
 * What a version changes about enforcement, as the server computed it against the standards
 * in effect (`enforcementChanged`): for the commands and the required directories, what the
 * field held before and after, as lines of text; for severities, one line per rule. There is
 * no "removed" or "added" here on purpose — any difference is shown, and the reviewer reads it.
 *
 * `changed` is true when the server says so OR when any field differs: a malformed DTO can
 * make this screen ask for an acknowledgement too often, never too rarely. Entries that are
 * not the expected shape are dropped; a version from an older server yields no change.
 */
function enforcementChanges(version) {
  const raw = (version && version.enforcementChanged) || {};
  const text = (v) => typeof v === 'string' && v !== '';
  const commandLines = (side) => list(side).filter((c) => c && text(c.label) && text(c.run)).map((c) => `${c.label}: ${c.run}`);
  const dirLines = (side) => list(side).filter(text);
  const pair = (field, lines) => (field && typeof field === 'object' ? { before: lines(field.before), after: lines(field.after) } : null);
  const commands = pair(raw.commands, commandLines);
  const requiredDirs = pair(raw.requiredDirs, dirLines);
  const severity = list(raw.severity)
    .filter((c) => c && SEVERITY_WORDS[c.from] && SEVERITY_WORDS[c.to])
    .map((c) => `${ruleLabel(c.rule)}: ${c.from} → ${c.to}`);
  // The settings of a rule this project made blocking, shown as the JSON they are stored as.
  const shown = (value) => JSON.stringify(value === undefined ? null : value, null, 2).split('\n');
  const ruleConfig = list(raw.ruleConfig).filter((c) => c && typeof c.rule === 'string')
    .map((c) => ({ rule: c.rule, before: shown(c.before), after: shown(c.after) }));
  return {
    comparedTo: typeof raw.comparedTo === 'number' ? raw.comparedTo : null,
    commands, severity, requiredDirs, ruleConfig,
    changed: raw.changed === true || commands !== null || requiredDirs !== null || severity.length > 0 || ruleConfig.length > 0,
  };
}

/** JSON with sorted keys, so two profiles compare equal whatever order their keys came in. */
function stable(value) {
  if (Array.isArray(value)) { return `[${value.map(stable).join(',')}]`; }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function statusBadge(v) {
  const [label, kind] = v.inEffect ? ['✓ IN EFFECT', 'success'] : STATUS_BADGE[v.status] || [String(v.status).toUpperCase(), 'muted'];
  return badge(label, kind);
}

function proposer(v) {
  return v.proposedByName ? `Proposed by ${v.proposedByName}` : 'Proposed automatically';
}

// ─── Read-only rows ───

/**
 * The labelled values of one profile section: `{ label, value, prov }` where
 * `prov` names the provenance field that covers the row.
 */
function sectionRows(profile, key) {
  const p = profile || {};
  switch (key) {
    case 'structure': {
      const s = p.structure || {};
      return [
        { label: 'Required dirs', value: joined(s.requiredDirs), prov: 'structure.requiredDirs' },
        { label: 'Allowed top level', value: joined(s.allowedTopLevel), prov: 'structure.allowedTopLevel' },
        { label: 'Placement', value: list(s.placement).map((r) => `${r.files} -> ${joined(r.under)}`).join('\n'), prov: 'structure.placement' },
      ];
    }
    case 'frontend': {
      const f = p.frontend || {};
      return [
        { label: 'Component kit', value: f.componentKit || '', prov: 'frontend.componentKit' },
        { label: 'Style source', value: f.styleSource || '', prov: 'frontend.styleSource' },
        { label: 'Raw patterns', value: list(f.rawPatterns).map((r) => `${r.message} (${r.kind} ${r.value} in ${joined(r.globs) || 'all files'})`).join('\n'), prov: 'frontend.rawPatterns' },
      ];
    }
    case 'design': {
      const d = p.design || null;
      if (!d) { return []; }
      return [
        { label: 'DESIGN.md', value: d.docPath || '', prov: 'design' },
        { label: 'Tokens file', value: d.tokensPath || '', prov: 'design' },
        { label: 'Tokens', value: String(d.tokens || ''), prov: null },
      ];
    }
    case 'backend': {
      const b = p.backend || {};
      return [
        { label: 'Layers', value: list(b.layers).map((l) => `${l.name}: ${joined(l.globs)}`).join('\n'), prov: 'backend.layers' },
        { label: 'Forbidden imports', value: list(b.forbiddenImports).map((f) => `${f.from} -> ${f.to}`).join('\n'), prov: 'backend.layers' },
        { label: 'Import aliases', value: list(b.importAliases).map((a) => `${a.prefix} = ${a.path || '(repository root)'}`).join('\n'), prov: 'backend.layers' },
      ];
    }
    case 'naming': {
      const n = p.naming || {};
      return [
        { label: 'Files', value: list(n.files).map((f) => `${joined(f.globs)} -> ${f.style}`).join('\n'), prov: 'naming.files' },
        { label: 'Notes', value: n.notes || '', prov: 'naming.files' },
      ];
    }
    case 'comments': {
      const c = p.comments || {};
      return [
        { label: 'Density limit', value: `${c.maxDensityPct}% of added lines (${c.minAddedLines}+ lines)`, prov: 'comments' },
        { label: 'Commented-out code', value: c.forbidCommentedOutCode ? 'Not allowed' : 'Allowed', prov: 'comments' },
        { label: 'Banned phrases', value: list(c.bannedPhrases).map((s) => `"${s}"`).join(', '), prov: 'comments' },
      ];
    }
    case 'testing': {
      const t = p.testing || {};
      return [
        { label: 'Runner', value: t.runner || '', prov: 'testing' },
        { label: 'Test files', value: joined(t.fileGlobs), prov: 'testing' },
        { label: 'Notes', value: t.notes || '', prov: 'testing' },
      ];
    }
    case 'severity': {
      const severity = resolvedSeverity(p);
      const of = (kind) => Object.keys(severity).filter((rule) => severity[rule] === kind).map(ruleLabel).join('\n');
      return [
        { label: 'Blocking', value: ['Commands (always)', of('blocking')].filter(Boolean).join('\n'), prov: null },
        { label: 'Advisory', value: of('advisory'), prov: null },
      ];
    }
    case 'commands':
      return list(p.commands).map((c) => ({ label: c.label, value: c.run, prov: 'commands' }));
    case 'builtInRuleIds':
      return [{ label: 'Rules', value: list(p.builtInRuleIds).join(' · '), prov: 'builtInRuleIds' }];
    case 'freeText':
      return [{ label: 'Text', value: p.freeText || '', prov: null }];
    default:
      return [];
  }
}

/** A section as plain text, for the before/after pair. */
function sectionText(profile, key) {
  const rows = sectionRows(profile, key).filter((r) => r.value !== '');
  if (rows.length === 0) { return '(empty)'; }
  return key === 'freeText' ? rows[0].value : rows.map((r) => `${r.label}: ${r.value}`).join('\n');
}

/** The provenance tag beside a value: the label is text, colour is secondary. */
function provenanceTag(version, provField, opts = {}) {
  const entry = provField && version.provenance ? version.provenance[provField] : null;
  if (!entry) { return null; }
  if (entry.tag === 'detected') {
    return [' ', badge(opts.command ? 'DETECTED, NOT EXECUTED' : 'DETECTED', 'info'), ' ', h('span', { class: 'mono' }, entry.evidence || '')];
  }
  return [' ', badge('ASSUMED', 'warning'), ' ', h('span', { class: 'muted' }, entry.evidence || 'no evidence in the repository')];
}

/** "~ changed from vN" beside a section heading, with the screen-reader wording of the PRD diff. */
function changeMarker(baseVersion) {
  return h('span', { class: 'muted' }, ' ',
    h('span', { class: 'text-info', 'aria-hidden': 'true' }, '~ '), h('span', { class: 'sr-only' }, 'Changed: '),
    `changed from v${baseVersion}`);
}

function beforeAfter(beforeText, afterText) {
  return h('details', null, h('summary', null, 'show before/after'),
    h('div', { class: 'before-after' },
      h('pre', { class: 'before', 'aria-label': 'Before' }, beforeText),
      h('pre', { class: 'after', 'aria-label': 'After' }, afterText)));
}

/**
 * What a version changes about which rules can stop a release, shown in its severity
 * section whatever it was proposed on top of: a demotion carried over from an earlier,
 * never-approved proposal is still a demotion of what is in effect.
 */
function severityChangeNote(version) {
  const lines = severityChangeLines(version);
  if (lines.length === 0) { return null; }
  return h('div', { class: 'text-warning' },
    h('p', null, glyph('⚠'), ' ', STR.C51(lines.length, version.severityComparedTo || null).text),
    h('ul', null, lines.map((line) => h('li', null, line))));
}

/**
 * The warning a version carries when it makes a scanner rule blocking. Shown to whoever
 * reads the version — the reviewer above all — not only to the person who chose it.
 */
function promotionNote(profile) {
  const promoted = promotedScannerRules(profile);
  if (promoted.length === 0) { return null; }
  return h('div', { class: 'text-warning', role: 'note' },
    h('p', null, glyph('⚠'), ' ', STR.C52(promoted.map(ruleLabel).join('; ')).text));
}

/**
 * Everything a version changes about enforcement, relative to what is in effect — shown in
 * full at the top of the card and never inside a collapsed before/after: a removed linter, a
 * test rewritten to `… || true`, a demoted rule or a swapped required directory is the change
 * a reviewer most needs to see, and the one they must tick before they can approve.
 */
function enforcementNote(version) {
  const set = enforcementChanges(version);
  if (!set.changed) { return null; }
  const side = (lines, label) => h('pre', { class: label === 'before' ? 'before' : 'after', tabindex: '0', 'aria-label': label === 'before' ? 'Before' : 'After' },
    lines.length > 0 ? lines.join('\n') : '(none)');
  const fieldBlock = (title, pair) => (pair === null ? null : h('div', null,
    h('p', null, h('strong', null, title)),
    h('div', { class: 'before-after' }, side(pair.before, 'before'), side(pair.after, 'after'))));
  return h('div', { class: 'text-warning', role: 'note', 'aria-label': 'Enforcement changes' },
    h('p', null, glyph('⚠'), ' ', STR.C55(set.comparedTo).text),
    fieldBlock('Commands', set.commands),
    set.severity.length > 0 ? h('div', null, h('p', null, h('strong', null, 'Rule severity')), h('ul', null, set.severity.map((line) => h('li', null, line)))) : null,
    fieldBlock('Required directories', set.requiredDirs),
    set.ruleConfig.map((c) => fieldBlock(`Settings of the blocking rule ${ruleLabel(c.rule)}`, c)));
}

/**
 * What a version changes about the design system, as the server computed it against the
 * standards in effect (`designChanged`). `changed` errs on the side of asking: any token,
 * section or path difference counts. An older server's DTO yields no change.
 */
function designChanges(version) {
  const raw = (version && version.designChanged) || {};
  const tokens = list(raw.tokens).filter((t) => t && typeof t.name === 'string');
  const sections = list(raw.sections).filter((x) => x && typeof x.heading === 'string');
  return {
    ...raw,
    tokens, sections,
    comparedTo: typeof raw.comparedTo === 'number' ? raw.comparedTo : null,
    changed: raw.changed === true || tokens.length > 0 || sections.length > 0 || !!raw.paths || !!raw.raw,
  };
}

/** The design-system change block: un-collapsed, under the enforcement changes. */
function designNote(version) {
  const set = designChanges(version);
  if (!set.changed) { return null; }
  return h('div', { class: 'text-info', role: 'note', 'aria-label': 'Design system changes' },
    h('p', null, glyph('~'), ' ', STR.C66(set.comparedTo).text),
    tokenDiffTable(set));
}

/** The parts named in the acknowledgement label (C65): what this version changes. */
function acknowledgementParts(version) {
  const set = enforcementChanges(version);
  return [
    set.commands !== null ? 'commands' : null,
    set.severity.length > 0 ? 'rule severity' : null,
    set.requiredDirs !== null ? 'required directories' : null,
    set.ruleConfig.length > 0 ? 'settings of a blocking rule' : null,
    designChanges(version).changed ? 'design system' : null,
  ].filter(Boolean).join(', ');
}

/** The design system of a version as the server describes it (`design`), or one built from the profile for an older server. */
function designOf(version) {
  if (version && version.design && typeof version.design === 'object') { return version.design; }
  const d = version && version.profile && version.profile.design;
  return d ? { docPath: d.docPath, tokensPath: d.tokensPath, doc: d.doc, tokensContent: d.tokens, tokens: [], tokensListable: false, tokensReason: 'not described by this server' } : null;
}

/** The read-only design-system section of a version. */
function designSectionView(version, marker) {
  const d = designOf(version);
  const n = version.version;
  if (!d) {
    return h('div', null, h('h3', { class: 'section-header' }, 'Design system', marker), h('p', { class: 'muted' }, '—'));
  }
  const tokens = list(d.tokens);
  return h('div', null,
    h('h3', { class: 'section-header' }, 'Design system', marker),
    h('p', { class: 'muted' }, STR.C68.text),
    designSummary(d, { provenance: (f) => provenanceTag(version, f), inRun: STR.C71(d.docPath, d.tokensPath).text }),
    d.tokensListable === false
      ? [h('p', { class: 'muted' }, STR.C72(d.tokensPath, d.tokensReason || 'not a CSS file').text),
        h('pre', { class: 'tail', tabindex: '0', 'aria-label': `Tokens file ${d.tokensPath}` }, String(d.tokensContent || ''))]
      : [h('h4', { class: 'section-header' }, `Tokens  ${tokens.length}`), tokenTable(tokens, { caption: `Standards v${n} design tokens` })],
    designDoc(d.doc, `DESIGN.md, standards v${n}`, { open: version.status === 'pending' && designChanges(version).changed }));
}

/** One read-only section of a version: heading, values with provenance, change marker. */
function sectionView(version, key, title, baseRecord, limits) {
  const profile = version.profile || {};
  const changed = !!baseRecord && !!version.changedFrom && list(version.changedFrom.sections).includes(key);
  const marker = changed ? changeMarker(baseRecord.version) : null;
  // The design system's own change block shows its differences in full; no second before/after.
  if (key === 'design') { return designSectionView(version, marker); }
  const diff = changed ? beforeAfter(sectionText(baseRecord.profile, key), sectionText(profile, key)) : null;

  if (key === 'commands') {
    const commands = list(version.commands);
    const before = new Set(baseRecord ? list(baseRecord.profile && baseRecord.profile.commands).map((c) => `${c.label}\n${c.run}`) : []);
    return h('div', null,
      h('h3', { class: 'section-header' }, `Commands (${commands.length})`, marker),
      commands.length === 0 ? h('p', { class: 'muted' }, 'This version runs no commands.') : [
        h('p', { class: 'muted' }, STR.C45.text),
        commands.map((c) => h('div', null,
          h('p', null,
            changed && !before.has(`${c.label}\n${c.run}`)
              ? [h('span', { class: 'text-success', 'aria-hidden': 'true' }, '+ '), h('span', { class: 'sr-only' }, 'Added: ')] : null,
            h('strong', null, c.label), provenanceTag(version, 'commands', { command: true })),
          h('pre', { class: 'tail', tabindex: '0', 'aria-label': `${c.label} command, exactly as it will run` }, c.run)))],
      diff);
  }

  if (key === 'freeText') {
    const text = profile.freeText || '';
    const cap = limits && limits.freeTextChars ? ` / ${count(limits.freeTextChars)}` : '';
    return h('div', null,
      h('details', { class: 'diff-group' },
        h('summary', null, `Free-text rules  ${count(text.length)}${cap} characters`),
        text ? h('pre', { class: 'tail' }, text) : h('p', { class: 'muted' }, 'No free-text rules.')),
      marker ? h('p', null, marker) : null,
      diff);
  }

  const rows = sectionRows(profile, key);
  const heading = key === 'builtInRuleIds' ? `${title}  ${list(profile.builtInRuleIds).length}` : title;
  return h('div', null,
    h('h3', { class: 'section-header' }, heading, marker),
    key === 'severity' ? h('p', { class: 'muted' }, STR.C47.text) : null,
    key === 'severity' ? severityChangeNote(version) : null,
    key === 'severity' ? promotionNote(profile) : null,
    h('dl', { class: 'summary' }, rows.map((r) => [
      h('dt', null, r.label),
      h('dd', null,
        r.value === '' ? h('span', { class: 'muted' }, '—') : r.value.split('\n').map((line) => h('div', null, line)),
        provenanceTag(version, r.prov))])),
    diff);
}

/** Every section of a version, changed ones first. */
function sectionsView(version, baseRecord, limits) {
  const changedKeys = baseRecord && version.changedFrom ? list(version.changedFrom.sections) : [];
  // The design section is left out — not shown empty — when neither this version nor its base has one.
  const hasDesign = !!(version.profile && version.profile.design) || !!(baseRecord && baseRecord.profile && baseRecord.profile.design);
  const shown = SECTIONS.filter(([k]) => k !== 'design' || hasDesign);
  const ordered = [...shown.filter(([k]) => changedKeys.includes(k)), ...shown.filter(([k]) => !changedKeys.includes(k))];
  return ordered.map(([key, title]) => sectionView(version, key, title, baseRecord, limits));
}

// ─── Edit form: profile ⇄ field values ───

/** An empty profile for a project that has no version to start from. Numbers are left for the proposer to enter. */
function blankProfile(stack) {
  return {
    stackTemplateId: stack, repoState: 'brownfield',
    structure: { requiredDirs: [], allowedTopLevel: [], placement: [] },
    frontend: { componentKit: '', styleSource: '', rawPatterns: [] },
    backend: { layers: [], forbiddenImports: [], importAliases: [] },
    naming: { files: [], notes: '' },
    comments: { bannedPhrases: [] },
    testing: { runner: '', fileGlobs: [], notes: '' },
    commands: [], builtInRuleIds: [], freeText: '',
  };
}

function toForm(profile) {
  const p = profile || {};
  const s = p.structure || {};
  const f = p.frontend || {};
  const b = p.backend || {};
  const n = p.naming || {};
  const c = p.comments || {};
  const t = p.testing || {};
  const lines = (v) => list(v).join('\n');
  return {
    repoState: p.repoState === 'greenfield' ? 'greenfield' : 'brownfield',
    requiredDirs: lines(s.requiredDirs),
    allowedTopLevel: lines(s.allowedTopLevel),
    placement: list(s.placement).map((r) => `${r.files} -> ${joined(r.under)}`).join('\n'),
    componentKit: f.componentKit || '',
    styleSource: f.styleSource || '',
    rawPatterns: list(f.rawPatterns).map((r) => [r.id, r.kind, r.value, joined(r.globs), r.message].join(' | ')).join('\n'),
    layers: list(b.layers).map((l) => `${l.name}: ${joined(l.globs)}`).join('\n'),
    forbiddenImports: list(b.forbiddenImports).map((x) => `${x.from} -> ${x.to}`).join('\n'),
    importAliases: list(b.importAliases).map((a) => `${a.prefix} = ${a.path}`).join('\n'),
    namingFiles: list(n.files).map((x) => `${joined(x.globs)} -> ${x.style}`).join('\n'),
    namingNotes: n.notes || '',
    maxDensityPct: String(c.maxDensityPct === undefined ? '' : c.maxDensityPct),
    minAddedLines: String(c.minAddedLines === undefined ? '' : c.minAddedLines),
    forbidCommentedOutCode: c.forbidCommentedOutCode === true,
    bannedPhrases: lines(c.bannedPhrases),
    runner: t.runner || '',
    fileGlobs: lines(t.fileGlobs),
    testingNotes: t.notes || '',
    commands: list(p.commands).map((x) => ({ label: x.label, run: x.run })),
    builtInRuleIds: lines(p.builtInRuleIds),
    freeText: p.freeText || '',
    severity: resolvedSeverity(p),
    designEnabled: !!p.design,
    designDocPath: (p.design && p.design.docPath) || '',
    designTokensPath: (p.design && p.design.tokensPath) || '',
    designTokens: (p.design && p.design.tokens) || '',
    designDoc: (p.design && p.design.doc) || '',
  };
}

const linesOf = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
const csv = (text) => String(text || '').split(',').map((x) => x.trim()).filter(Boolean);

/** Split `line` once at `sep`; null when the separator is missing or a side is empty. */
function pair(line, sep) {
  const i = line.indexOf(sep);
  if (i < 0) { return null; }
  const left = line.slice(0, i).trim();
  const right = line.slice(i + sep.length).trim();
  return left ? [left, right] : null;
}

/**
 * Build a profile from the form values. Returns `{ profile, errors }` where
 * `errors` maps a field key to the first line of that field that could not be
 * read. The server validates the result again; this only shapes it.
 */
function fromForm(vals, source) {
  const errors = {};
  const each = (key, text, parse, shape) => linesOf(text).flatMap((line) => {
    const out = parse(line);
    if (out === null) { if (!errors[key]) { errors[key] = `"${line}" is not in the form ${shape}`; } return []; }
    return [out];
  });
  const sourcePlacement = list(source && source.structure && source.structure.placement);
  const number = (key, text) => {
    const n = Number(String(text).trim());
    if (String(text).trim() === '' || !Number.isFinite(n)) { errors[key] = 'Enter a number.'; return 0; }
    return n;
  };
  const commands = list(vals.commands).flatMap((c, i) => {
    const label = String(c.label || '').trim();
    const run = String(c.run || '').trim();
    if (!label && !run) { return []; }
    if (!label || !run) { if (!errors.commands) { errors.commands = `Command ${i + 1} needs both a label and a command.`; } return []; }
    return [{ label, run }];
  });
  const profile = {
    stackTemplateId: source.stackTemplateId,
    repoState: vals.repoState === 'greenfield' ? 'greenfield' : 'brownfield',
    structure: {
      requiredDirs: linesOf(vals.requiredDirs),
      allowedTopLevel: linesOf(vals.allowedTopLevel),
      placement: each('placement', vals.placement, (line) => {
        const p = pair(line, '->');
        if (!p || csv(p[1]).length === 0) { return null; }
        const known = sourcePlacement.find((r) => r.files === p[0]);
        return { id: known ? known.id : `rule-${p[0].replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'files'}`, files: p[0], under: csv(p[1]) };
      }, 'files -> directory, directory'),
    },
    frontend: {
      componentKit: vals.componentKit.trim(),
      styleSource: vals.styleSource.trim(),
      rawPatterns: each('rawPatterns', vals.rawPatterns, (line) => {
        const parts = line.split('|').map((x) => x.trim());
        if (parts.length < 5 || !parts[0] || !parts[1] || !parts[2]) { return null; }
        return { id: parts[0], kind: parts[1], value: parts[2], globs: csv(parts[3]), message: parts.slice(4).join(' | ') };
      }, 'id | literal or builtin | value | globs | message'),
    },
    backend: {
      layers: each('layers', vals.layers, (line) => {
        const p = pair(line, ':');
        return p ? { name: p[0], globs: csv(p[1]) } : null;
      }, 'name: glob, glob'),
      forbiddenImports: each('forbiddenImports', vals.forbiddenImports, (line) => {
        const p = pair(line, '->');
        return p && p[1] ? { from: p[0], to: p[1] } : null;
      }, 'layer -> layer'),
      importAliases: each('importAliases', vals.importAliases, (line) => {
        const p = pair(line, '=');
        return p ? { prefix: p[0], path: p[1] } : null;
      }, 'prefix = path'),
    },
    naming: {
      files: each('namingFiles', vals.namingFiles, (line) => {
        const p = pair(line, '->');
        return p && p[1] ? { globs: csv(p[0]), style: p[1] } : null;
      }, 'glob, glob -> style'),
      notes: vals.namingNotes.trim(),
    },
    comments: {
      maxDensityPct: number('maxDensityPct', vals.maxDensityPct),
      minAddedLines: number('minAddedLines', vals.minAddedLines),
      forbidCommentedOutCode: vals.forbidCommentedOutCode === true,
      bannedPhrases: linesOf(vals.bannedPhrases),
    },
    testing: { runner: vals.runner.trim(), fileGlobs: linesOf(vals.fileGlobs), notes: vals.testingNotes.trim() },
    commands,
    builtInRuleIds: linesOf(vals.builtInRuleIds),
    freeText: vals.freeText,
  };
  // Severity is sent as overrides only. An override the source already spelled out is kept as
  // written, so an edit that touches no severity leaves this part of the profile byte-identical;
  // a choice that equals the default needs no override at all.
  const sourceOverrides = (source && source.severity) || {};
  const overrides = {};
  for (const rule of Object.keys(severityDefaults)) {
    const chosen = (vals.severity || {})[rule] === 'advisory' ? 'advisory' : (vals.severity || {})[rule] === 'blocking' ? 'blocking' : severityDefaults[rule];
    if (sourceOverrides[rule] === chosen || chosen !== severityDefaults[rule]) { overrides[rule] = chosen; }
  }
  // The design system goes along only while its box is ticked; unticked, the key is left out.
  if (vals.designEnabled === true) {
    profile.design = {
      docPath: String(vals.designDocPath || '').trim(),
      tokensPath: String(vals.designTokensPath || '').trim(),
      doc: String(vals.designDoc || ''),
      tokens: String(vals.designTokens || ''),
    };
  }
  if (Object.keys(severityDefaults).length === 0) {
    // The server sent no severity table (an older build): what the source says is passed through untouched.
    if (Object.keys(sourceOverrides).length > 0) { profile.severity = { ...sourceOverrides }; }
  } else if (Object.keys(overrides).length > 0) {
    profile.severity = overrides;
  }
  return { profile, errors };
}

/** Server validation paths (`profile.structure.requiredDirs[0]: …`) → the form field that owns them. */
const ERROR_FIELDS = [
  ['profile.structure.requiredDirs', 'requiredDirs'], ['profile.structure.allowedTopLevel', 'allowedTopLevel'],
  ['profile.structure.placement', 'placement'], ['profile.frontend.componentKit', 'componentKit'],
  ['profile.frontend.styleSource', 'styleSource'], ['profile.frontend.rawPatterns', 'rawPatterns'],
  ['profile.backend.layers', 'layers'], ['profile.backend.forbiddenImports', 'forbiddenImports'],
  ['profile.backend.importAliases', 'importAliases'], ['profile.naming.files', 'namingFiles'],
  ['profile.naming.notes', 'namingNotes'], ['profile.comments.maxDensityPct', 'maxDensityPct'],
  ['profile.comments.minAddedLines', 'minAddedLines'], ['profile.comments.bannedPhrases', 'bannedPhrases'],
  ['profile.testing.runner', 'runner'], ['profile.testing.fileGlobs', 'fileGlobs'], ['profile.testing.notes', 'testingNotes'],
  ['profile.commands', 'commands'], ['profile.builtInRuleIds', 'builtInRuleIds'], ['profile.freeText', 'freeText'],
  ['profile.severity', 'severity'],
  // Most specific first: `profile.design` alone (a planner-cap error) lands on DESIGN.md.
  ['profile.design.docPath', 'designDocPath'], ['profile.design.tokensPath', 'designTokensPath'],
  ['profile.design.tokens', 'designTokens'], ['profile.design.doc', 'designDoc'],
  ['profile.design', 'designDoc'],
];

// ─── Screen ───

export async function render(app, params, view) {
  const projectId = params.id;
  const project = app.project.project;
  const api = `/api/projects/${encodeURIComponent(projectId)}/standards`;
  app.setTitle(`Standards · ${project.name}`);
  const title = h('h1', null, `Standards · ${project.name}`);
  mount(view, title, skeleton(4));
  const first = await app.api('GET', api);
  if (!first.ok || !first.body.standards) {
    mount(view, title, errorCard(`Couldn't load standards. ${serverMessage(first)}`, () => render(app, params, view)));
    return undefined;
  }

  const state = { dto: first.body.standards, selected: null, showAll: false };
  severityDefaults = first.body.standards.severityDefaults || {};
  scannerRules = list(first.body.standards.scannerRules);
  const versions = () => list(state.dto.versions);
  const byNumber = (n) => versions().find((v) => v.version === n) || null;
  const latestNumber = () => (versions().length > 0 ? versions()[versions().length - 1].version : null);
  const defaultSelection = () => state.dto.pendingVersion || state.dto.effectiveVersion || latestNumber();
  const canPropose = () => list(state.dto.allowedActions).includes('standards.propose');
  state.selected = defaultSelection();

  /** Reload the DTO (and the project, for the rail badge), then show `select` (default: the pending or effective version). */
  const reload = async (select, focus) => {
    const again = await app.api('GET', api);
    if (!again.ok || !again.body.standards) { toast(`Couldn't reload standards. ${serverMessage(again)}`, 'error'); return false; }
    state.dto = again.body.standards;
    severityDefaults = state.dto.severityDefaults || {};
    scannerRules = list(state.dto.scannerRules);
    state.selected = select && byNumber(select) ? select : defaultSelection();
    await app.refreshProject(projectId);
    renderAll(focus);
    return true;
  };

  /** Start an edit from version `v`, or from a blank profile when the project has no version at all. */
  const startEdit = (v, extra) => {
    const profile = v ? v.profile : blankProfile(state.dto.stack);
    // `extra.design`: a suggested design system merged into the draft, so it starts dirty.
    const start = extra && extra.design ? { ...profile, design: extra.design } : profile;
    drafts.set(projectId, { from: v ? v.version : null, baseVersion: latestNumber(), profile, vals: toForm(start) });
    renderAll(true);
  };

  /** "…; every agent task builds against it." when the version has a design system (C73). */
  const designConfirmText = (v) => {
    const d = designOf(v);
    return d ? ` ${STR.C73(v.version, list(d.tokens).length).text}` : '';
  };

  // ─── Decisions ───

  const decisionRefused = async (r) => {
    if (r.status === 409 && r.body.error === 'hash-mismatch') {
      toast(STR.C37.text, 'error');
    } else if (r.status === 409 && r.body.error === 'acknowledgement-required') {
      const fields = list(r.body.fields);
      toast(fields.length === 1 && fields[0] === 'design' ? STR.C67.text : STR.C56.text, 'error');
    } else if (r.status === 409 && r.body.error === 'already-decided') {
      toast(STR.C22(r.body.status || 'decided', '', r.body.decidedAt ? fmtTime(r.body.decidedAt) : '').text, 'warning');
    } else if (r.status !== 403 && r.status !== 401) {
      toast(serverMessage(r), 'error');
    }
    await reload(null, true);
  };

  /**
   * The body of an approve or accept-defaults: the hash of what was shown and, once the
   * viewer ticked the enforcement changes, the same hash again as their acknowledgement.
   * The server refuses a version that changes enforcement without it.
   */
  const decisionBody = (v, acknowledged) => (acknowledged
    ? { contentHash: v.contentHash, acknowledgedEnforcementHash: v.contentHash } : { contentHash: v.contentHash });

  const approve = async (v, acknowledged) => {
    const ok = await confirmDialog({ title: 'Approve these standards?', text: STR.C32(v.version, list(v.commands).length).text + designConfirmText(v), confirmLabel: 'Approve standards' });
    if (!ok) { return; }
    const r = await app.api('POST', `${api}/versions/${encodeURIComponent(v.version)}/approve`, decisionBody(v, acknowledged));
    if (!r.ok) { await decisionRefused(r); return; }
    const msg = `Standards v${v.version} approved. It is now in effect.`;
    toast(msg, 'success');
    announce(msg);
    await reload(v.version, true);
  };

  const reject = async (v, reason) => {
    reason.setError('');
    const text = reason.input.value.trim();
    if (!text) { reason.setError('A reason is required to reject.'); reason.input.focus(); return; }
    const r = await app.api('POST', `${api}/versions/${encodeURIComponent(v.version)}/reject`, { reason: text });
    if (!r.ok) { await decisionRefused(r); return; }
    const msg = STR.C33(v.version, state.dto.effectiveVersion).text;
    toast(msg, 'success');
    announce(msg);
    await reload(v.version, true);
  };

  const acceptDefaults = async (v, acknowledged) => {
    const ok = await confirmDialog({ title: 'Accept the defaults without review?', text: STR.C34(v.version, state.dto.stack).text + designConfirmText(v), confirmLabel: 'Accept defaults' });
    if (!ok) { return; }
    const r = await app.api('POST', `${api}/accept-defaults`, decisionBody(v, acknowledged));
    if (!r.ok) { await decisionRefused(r); return; }
    const msg = `Defaults accepted. Standards v${v.version} is now in effect.`;
    toast(msg, 'warning');
    announce(msg);
    await reload(v.version, true);
  };

  // ─── Version card ───

  const versionCard = (v) => {
    const allowed = new Set(v.allowedActions || []);
    const baseRecord = v.changedFrom ? byNumber(v.changedFrom.version) : null;
    const changedKeys = baseRecord ? list(v.changedFrom.sections) : [];
    const heading = h('h2', { tabindex: '-1' }, `Standards v${v.version}`);
    const profile = v.profile || {};
    const tags = Object.values(v.provenance || {});
    const detected = tags.filter((t) => t && t.tag === 'detected').length;
    const meta = [];

    if (v.status === 'pending') {
      meta.push(h('p', { class: 'muted' }, `${proposer(v)} · ${fmtAgo(v.proposedAt)}`));
      if (state.dto.effectiveVersion) { meta.push(h('p', null, `v${state.dto.effectiveVersion} stays in effect until this is approved.`)); }
    } else if (v.status === 'approved') {
      const who = v.decidedByName || '—';
      meta.push(h('p', { class: 'muted' }, v.decision === 'accepted-defaults'
        ? `Defaults accepted by ${who} (admin) · ${fmtTime(v.decidedAt)}. Not reviewed.`
        : `Approved by ${who} · ${fmtAgo(v.decidedAt)}`));
      if (!v.inEffect) {
        const next = versions().find((x) => x.status === 'approved' && x.version > v.version);
        if (next) { meta.push(h('p', { class: 'muted' }, `Replaced by v${next.version} · ${fmtTime(next.decidedAt)}`)); }
      }
    } else if (v.status === 'rejected') {
      meta.push(h('p', null, `Rejected by ${v.decidedByName || '—'} · ${fmtTime(v.decidedAt)}`));
      if (v.reason) { meta.push(h('p', null, `Reason: ${v.reason}`)); }
    } else if (v.status === 'superseded') {
      const next = versions().find((x) => x.version > v.version);
      meta.push(h('p', { class: 'muted' }, next ? `Replaced by proposal v${next.version} before review.` : 'Replaced by a newer proposal before review.'));
    }
    if (baseRecord) {
      meta.push(h('p', null, changedKeys.length > 0
        ? `Changes from v${baseRecord.version}: ${changedKeys.length} section${changedKeys.length === 1 ? '' : 's'}`
        : `No changes from v${baseRecord.version}.`));
    }
    meta.push(h('p', { class: 'muted' },
      `Stack template: ${profile.stackTemplateId || '—'} · ${profile.repoState === 'greenfield' ? 'Greenfield: no source files found' : 'Brownfield'}`,
      changedKeys.includes('stackTemplateId') || changedKeys.includes('repoState') ? changeMarker(baseRecord.version) : null));
    if (tags.length > 0) { meta.push(h('p', { class: 'muted' }, `${detected} detected · ${tags.length - detected} assumed`)); }

    // ─── Footer: what this viewer may do with this version ───
    const footer = [];
    const editLabel = v.status === 'pending' ? 'Edit proposal' : v.status === 'rejected' ? 'Edit and resubmit' : v.inEffect ? 'Propose changes' : null;
    const editBtn = editLabel && canPropose()
      ? h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => startEdit(v) } }, editLabel) : null;
    if (v.status === 'pending') {
      const canDecide = allowed.has('standards.approve') || allowed.has('standards.reject');
      // A version that changes enforcement is put into effect only by someone who ticked
      // that they saw the changes. Until then the buttons that do so stay disabled — and
      // the server refuses the request without the acknowledgement, whatever this screen does.
      const designChanged = designChanges(v).changed;
      const mustAcknowledge = enforcementChanges(v).changed || designChanged;
      const canEnact = allowed.has('standards.approve') || allowed.has('standards.accept-defaults');
      const ackId = `standards-ack-${v.version}`;
      const ackBox = mustAcknowledge && canEnact ? h('input', { type: 'checkbox', id: ackId }) : null;
      const acknowledged = () => !mustAcknowledge || (!!ackBox && ackBox.checked);
      const approveBtn = allowed.has('standards.approve')
        ? h('button', { type: 'button', class: 'btn btn-primary', disabled: mustAcknowledge, on: { click: () => { if (acknowledged()) { void approve(v, mustAcknowledge); } } } }, 'Approve standards') : null;
      const acceptBtn = allowed.has('standards.accept-defaults')
        ? h('button', { type: 'button', class: 'btn-link', disabled: mustAcknowledge, on: { click: () => { if (acknowledged()) { void acceptDefaults(v, mustAcknowledge); } } } }, 'Accept defaults without review…') : null;
      if (ackBox) {
        ackBox.addEventListener('change', () => {
          if (approveBtn) { approveBtn.disabled = !ackBox.checked; }
          if (acceptBtn) { acceptBtn.disabled = !ackBox.checked; }
        });
        footer.push(h('hr', { class: 'panel-divider' }),
          h('p', null, ackBox, ' ', h('label', { for: ackId },
            designChanged ? STR.C65(v.version, acknowledgementParts(v)).text : STR.C57(v.version).text)));
      }
      if (canDecide) {
        const reason = field({ label: 'Rejection reason', input: h('input', { type: 'text', maxlength: 2000 }) });
        footer.push(h('hr', { class: 'panel-divider' }),
          allowed.has('standards.reject') ? reason.wrap : null,
          h('div', { class: 'form-actions' },
            editBtn,
            allowed.has('standards.reject') ? h('button', { type: 'button', class: 'btn btn-danger', on: { click: () => { void reject(v, reason); } } }, 'Reject standards') : null,
            approveBtn));
      } else {
        footer.push(h('hr', { class: 'panel-divider' }),
          h('div', { class: 'inline-row' }, h('span', { class: 'muted' }, 'Waiting for a reviewer to approve.'), h('span', { class: 'header-spacer' }), editBtn));
      }
      if (acceptBtn) { footer.push(h('hr', { class: 'panel-divider' }), acceptBtn); }
    } else if (editLabel) {
      footer.push(h('hr', { class: 'panel-divider' }),
        editBtn ? h('div', { class: 'form-actions' }, editBtn) : h('p', { class: 'muted' }, 'Only a product owner can propose changes.'));
    }

    // A project with a user interface whose standards have no design system: offer one.
    const suggestion = state.dto.designSuggestion;
    const suggest = v.inEffect && suggestion && suggestion.design && !profile.design && canPropose()
      ? h('div', { class: ['card', 'card-info'], role: 'note' },
        h('p', null, STR.C70(String(suggestion.evidence || 'detected')).text),
        h('div', { class: 'form-actions' }, h('button', {
          type: 'button', class: 'btn btn-secondary', on: { click: () => startEdit(v, { design: suggestion.design }) },
        }, 'Propose a design system')))
      : null;
    const kind = v.status === 'pending' ? 'card-warning' : v.inEffect ? 'card-success' : '';
    const el = h('section', { class: ['card', kind], 'aria-label': `Standards version ${v.version}` },
      h('div', { class: 'card-head' }, heading, h('span', { class: 'header-spacer' }), statusBadge(v)),
      meta,
      suggest,
      // Un-collapsed and above every section: what approving this version changes about enforcement.
      v.status === 'pending' || v.inEffect ? enforcementNote(v) : null,
      v.status === 'pending' || v.inEffect ? designNote(v) : null,
      sectionsView(v, baseRecord, state.dto.limits),
      footer);
    return { el, heading };
  };

  // ─── Version list ───

  const versionList = () => {
    const all = [...versions()].reverse();
    const shown = state.showAll ? all : all.slice(0, LIST_CAP);
    return h('div', null,
      h('h2', { class: 'section-header' }, `Versions  ${all.length}`),
      h('ul', { class: 'version-list' },
        shown.map((v) => {
          const who = v.proposedByName || 'auto';
          const words = v.inEffect ? 'in effect' : STATUS_WORDS[v.status] || v.status;
          return h('li', null, h('button', {
            type: 'button', class: 'version-item', 'aria-current': v.version === state.selected ? 'true' : 'false',
            'aria-label': `v${v.version}, ${words}, ${v.proposedByName ? `proposed by ${v.proposedByName}` : 'proposed automatically'} ${fmtAgo(v.proposedAt)}`,
            on: { click: () => { state.selected = v.version; renderAll(true); } },
          },
          h('span', { class: 'diff-id' }, `v${v.version}`),
          statusBadge(v),
          h('span', { class: 'muted' }, `${who} · ${fmtAgo(v.proposedAt)}${v.status === 'rejected' && v.reason ? ` · "${v.reason.slice(0, 80)}"` : ''}`)));
        }),
        all.length > shown.length ? h('li', null, h('button', {
          type: 'button', class: 'btn-link', on: { click: () => { state.showAll = true; renderAll(false); } },
        }, `Show all ${all.length}`)) : null));
  };

  // ─── View mode ───

  const renderView = (focus) => {
    title.textContent = `Standards · ${project.name}`;
    if (versions().length === 0) {
      mount(view, title, h('div', { class: 'card empty' },
        h('p', null, 'No standards have been proposed yet.'),
        canPropose() ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => startEdit(null) } }, 'Propose standards') : null));
      return;
    }
    const selected = byNumber(state.selected) || versions()[versions().length - 1];
    const card = versionCard(selected);
    const pending = state.dto.pendingVersion ? byNumber(state.dto.pendingVersion) : null;
    mount(view, title,
      h('div', { class: 'prd-layout' },
        h('div', null,
          // The migration card: a project that predates standards, while nothing is approved yet.
          state.dto.migrated && !state.dto.effectiveVersion ? h('div', { class: ['card', 'card-warning'], role: 'note' },
            h('p', null, glyph('⚠'), ' ', h('strong', null, 'This project was created before project standards')),
            pending ? h('p', null, `MOAG proposed v${pending.version} from the repository and the ${state.dto.stack} defaults.`) : null,
            h('p', null, STR.C43.text)) : null,
          state.dto.stackMismatch ? h('div', { class: ['card', 'card-warning'], role: 'note' },
            glyph('⚠'), ` The project's stack is now ${state.dto.stack}, but these standards were proposed for another stack. Changing the stack proposes nothing; a product owner can propose new standards.`) : null,
          card.el),
        versionList()));
    if (focus) { card.heading.focus(); }
  };

  // ─── Edit mode ───

  const renderEdit = (focus) => {
    const draft = drafts.get(projectId);
    // The version the edit started from (for its tags); a blank start has none.
    const source = { version: draft.from, profile: draft.profile, provenance: draft.from === null ? null : (byNumber(draft.from) || {}).provenance };
    const vals = draft.vals;
    const limits = state.dto.limits || {};
    const cap = Number(limits.freeTextChars) || 0;
    const maxCommands = Number(limits.commands) || 6;
    const inputs = {};
    const status = h('span', { class: 'muted' });
    const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Submit for review');
    const formErr = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const noticeHost = h('div');
    const nextNumber = (draft.baseVersion || 0) + 1;

    const isDirty = () => {
      const built = fromForm(vals, source.profile);
      return Object.keys(built.errors).length > 0 || stable(built.profile) !== stable(source.profile);
    };
    const sync = () => {
      const dirty = isDirty();
      status.textContent = dirty ? '● unsaved' : '';
      submitBtn.disabled = !dirty;
      submitBtn.title = dirty ? '' : source.version === null ? 'Nothing entered yet' : `No changes from v${source.version}`;
    };

    /** A labelled input bound to `vals[key]`, with the provenance tag (display-only) beside its label. */
    const bind = (key, label, input, opts = {}) => {
      const f = field({ label, input, hint: opts.hint });
      if (typeof vals[key] === 'boolean') { input.checked = vals[key]; } else { input.value = vals[key]; }
      input.addEventListener('input', () => { vals[key] = typeof vals[key] === 'boolean' ? input.checked : input.value; if (opts.after) { opts.after(); } sync(); });
      const tag = provenanceTag(source, opts.prov);
      const labelEl = f.wrap.querySelector('label');
      if (tag && labelEl) { tag.forEach((node) => labelEl.append(node)); }
      inputs[key] = f;
      return f.wrap;
    };
    const area = (rows = 3) => h('textarea', { rows, spellcheck: 'false' });
    const text = () => h('input', { type: 'text', maxlength: 200 });
    const group = (legend, ...children) => h('fieldset', { class: 'field card' }, h('legend', null, legend), children);

    // Repository state (radio pair).
    const radio = (value, label) => {
      const id = `repo-state-${value}`;
      const input = h('input', { type: 'radio', name: 'repo-state', value, id, checked: vals.repoState === value });
      input.addEventListener('change', () => { if (input.checked) { vals.repoState = value; sync(); } });
      return h('label', { for: id }, input, ` ${label}`);
    };

    // Commands: one label + command pair per row, up to the server's limit.
    while (vals.commands.length < maxCommands) { vals.commands.push({ label: '', run: '' }); }
    const commandErr = h('p', { class: 'field-error', hidden: true });
    inputs.commands = {
      input: null,
      setError: (msg) => { commandErr.textContent = msg || ''; commandErr.hidden = !msg; },
    };
    const commandRows = vals.commands.slice(0, maxCommands).map((c, i) => {
      const label = h('input', { type: 'text', maxlength: 200, 'aria-label': `Command ${i + 1} label`, placeholder: 'Label, e.g. Lint' });
      const run = h('input', { type: 'text', maxlength: Number(limits.commandChars) || 500, class: 'mono', 'aria-label': `Command ${i + 1}, exactly as it will run`, placeholder: 'Command' });
      label.value = c.label;
      run.value = c.run;
      label.addEventListener('input', () => { c.label = label.value; sync(); });
      run.addEventListener('input', () => { c.run = run.value; sync(); });
      if (i === 0) { inputs.commands.input = label; }
      return h('div', { class: 'field' }, label, run);
    });

    // Severity: one choice per rule. Commands are not listed — a command always blocks.
    const severityErr = h('p', { class: 'field-error', hidden: true });
    const sourceSeverity = resolvedSeverity(source.profile);
    const severityRows = Object.keys(severityDefaults).map((rule, i) => {
      const id = `severity-${i}`;
      const select = h('select', { id },
        ['blocking', 'advisory'].map((kind) => h('option', { value: kind },
          `${SEVERITY_WORDS[kind]}${severityDefaults[rule] === kind ? ' (default)' : ''}`)));
      select.value = vals.severity[rule];
      const changed = h('span', { class: 'muted' });
      // Shown the moment a scanner rule is set to blocking, and while it stays so.
      const warning = h('p', { class: 'text-warning', role: 'alert', hidden: true });
      const mark = () => {
        // Text, not colour alone, says the choice differs from the version being edited.
        changed.textContent = vals.severity[rule] !== sourceSeverity[rule]
          ? ` Changed from ${SEVERITY_WORDS[sourceSeverity[rule]].toLowerCase()}.` : '';
        const promoted = vals.severity[rule] === 'blocking' && isScannerRule(rule);
        warning.textContent = promoted ? `⚠ ${STR.C54(rule).text}` : '';
        warning.hidden = !promoted;
      };
      select.addEventListener('change', () => { vals.severity[rule] = select.value; mark(); sync(); });
      mark();
      if (i === 0) { inputs.severity = { input: select, setError: (msg) => { severityErr.textContent = msg || ''; severityErr.hidden = !msg; } }; }
      return h('div', { class: 'field' },
        h('label', { for: id }, ruleLabel(rule), isScannerRule(rule) ? h('span', { class: 'muted' }, ' · heuristic scan') : null),
        select, changed, warning);
    });
    if (!inputs.severity) { inputs.severity = { input: null, setError: () => {} }; }

    // Free text with a live counter; over the cap is shown, never silently cut.
    const counter = h('p', { class: 'hint' });
    const freeText = h('textarea', { class: 'prd-editor', spellcheck: 'true', 'aria-label': 'Free-text rules' });
    const syncCounter = () => {
      const n = vals.freeText.length;
      const over = cap > 0 && n > cap;
      counter.textContent = `${over ? '✗ ' : ''}${count(n)}${cap ? ` / ${count(cap)}` : ''} characters${over ? `. ${STR.C42(n, cap).text}` : ''}`;
      counter.className = over ? 'field-error' : 'hint';
      if (over) { freeText.setAttribute('aria-invalid', 'true'); } else { freeText.removeAttribute('aria-invalid'); }
    };
    freeText.value = vals.freeText;
    freeText.addEventListener('input', () => { vals.freeText = freeText.value; syncCounter(); sync(); });
    inputs.freeText = { input: freeText, setError: (msg) => { if (msg) { counter.textContent = `✗ ${msg}`; counter.className = 'field-error'; freeText.setAttribute('aria-invalid', 'true'); } else { syncCounter(); } } };

    // Design system: a box that includes it, two paths, the tokens file and DESIGN.md.
    const designLimits = { doc: Number(limits.designDocChars) || 12000, tokens: Number(limits.designTokensChars) || 8000 };
    const designBox = h('input', { type: 'checkbox', id: 'design-enabled' });
    designBox.checked = vals.designEnabled === true;
    const designDocPath = bind('designDocPath', 'DESIGN.md path', h('input', { type: 'text', maxlength: 200, class: 'mono' }), { hint: 'Relative to the repository. Written at the start of every run.' });
    const designTokensPath = bind('designTokensPath', 'Tokens file path', h('input', { type: 'text', maxlength: 200, class: 'mono' }));
    const previewHost = h('div');
    const renderPreview = () => {
      const tokens = previewTokens(vals.designTokens);
      mount(previewHost, h('details', { class: 'diff-group' },
        h('summary', null, `Preview  ${tokens.length} tokens`),
        tokenTable(tokens, { caption: 'Tokens in this draft', contrast: false })));
    };
    const designTokens = bind('designTokens', 'Tokens', h('textarea', { rows: 10, spellcheck: 'false', class: 'mono' }),
      { hint: 'The file\'s full content. CSS custom properties (--name: value;) are listed as tokens. Name the background token --color-bg, or contrast can\'t be shown.', after: renderPreview });
    const docCounter = h('p', { class: 'hint' });
    const syncDocCounter = () => {
      const n = String(vals.designDoc || '').length;
      const over = n > designLimits.doc;
      docCounter.textContent = `${over ? '✗ ' : ''}${count(n)} / ${count(designLimits.doc)} characters`;
      docCounter.className = over ? 'field-error' : 'hint';
    };
    const designDocArea = bind('designDoc', 'DESIGN.md', h('textarea', { class: 'prd-editor', spellcheck: 'true' }), { after: syncDocCounter });
    const designFields = h('div', null, designDocPath, designTokensPath, designTokens, previewHost, designDocArea, docCounter);
    const showDesign = () => { designFields.hidden = !designBox.checked; };
    designBox.addEventListener('change', async () => {
      if (designBox.checked) {
        // Ticking fills an empty draft from the suggestion, else from the stack's template.
        const fill = (state.dto.designSuggestion && state.dto.designSuggestion.design) || state.dto.designTemplate || null;
        if (fill && !vals.designDocPath && !vals.designTokensPath && !vals.designTokens && !vals.designDoc) {
          vals.designDocPath = fill.docPath || '';
          vals.designTokensPath = fill.tokensPath || '';
          vals.designTokens = fill.tokens || '';
          vals.designDoc = fill.doc || '';
          for (const key of ['designDocPath', 'designTokensPath', 'designTokens', 'designDoc']) { inputs[key].input.value = vals[key]; }
        }
        vals.designEnabled = true;
      } else if (vals.designEnabled) {
        const n = previewTokens(vals.designTokens).length;
        const ok = await confirmDialog({
          title: 'Remove the design system from this proposal?',
          text: `The DESIGN.md text and ${n} token${n === 1 ? '' : 's'} are left out of v${nextNumber}.${state.dto.effectiveVersion ? ` v${state.dto.effectiveVersion} keeps its design system until a reviewer approves this version.` : ''} Discard changes brings them back.`,
          confirmLabel: 'Remove design system', cancelLabel: 'Keep it', destructive: true,
        });
        if (!ok) { designBox.checked = true; return; }
        vals.designEnabled = false;
      }
      showDesign();
      renderPreview();
      syncDocCounter();
      sync();
    });

    const clearErrors = () => {
      formErr.hidden = true;
      mount(formErr);
      for (const f of Object.values(inputs)) { f.setError(''); }
    };

    /** Put each message on its field; whatever names no field goes to the form error. Focuses the first field in error. */
    const showErrors = (byField, rest) => {
      let focused = false;
      for (const [key, msg] of Object.entries(byField)) {
        const f = inputs[key];
        if (!f) { rest.push(msg); continue; }
        f.setError(msg);
        if (!focused && f.input) { f.input.focus(); focused = true; }
      }
      if (rest.length > 0) {
        mount(formErr, h('ul', { class: 'diff-list' }, rest.map((e) => h('li', null, e))));
        formErr.hidden = false;
      }
    };

    const leave = (select) => {
      drafts.delete(projectId);
      state.selected = select || state.selected;
    };

    const submit = async (e) => {
      e.preventDefault();
      clearErrors();
      mount(noticeHost);
      const built = fromForm(vals, source.profile);
      if (Object.keys(built.errors).length > 0) { showErrors(built.errors, []); return; }
      submitBtn.disabled = true;
      const r = await app.api('POST', `${api}/versions`, { profile: built.profile, baseVersion: draft.baseVersion });
      sync();
      if (r.ok) {
        const msg = STR.C35(r.body.version, state.dto.effectiveVersion).text;
        toast(msg, 'success');
        announce(msg);
        leave(r.body.version);
        await reload(r.body.version, true);
        return;
      }
      if (r.status === 409 && r.body.error === 'stale') {
        mount(noticeHost, h('div', { class: ['card', 'card-warning'], role: 'alert' },
          h('p', null, STR.C36.text),
          h('button', { type: 'button', class: 'btn btn-secondary', on: { click: async () => {
            const again = await app.api('GET', api);
            if (!again.ok || !again.body.standards) { toast(`Couldn't reload standards. ${serverMessage(again)}`, 'error'); return; }
            state.dto = again.body.standards;
            // Rebase onto the version that won; the user's edits are untouched.
            draft.baseVersion = latestNumber();
            const latest = byNumber(draft.baseVersion);
            mount(noticeHost, h('div', { class: 'card', role: 'status' },
              h('p', null, `Now editing against v${draft.baseVersion}. Review it, then submit again.`),
              latest ? h('details', null, h('summary', null, `Show v${latest.version}`), sectionsView(latest, null, state.dto.limits)) : null));
          } } }, 'Show latest version')));
        return;
      }
      if (r.status === 400 && Array.isArray(r.body.errors)) {
        const byField = {};
        const rest = [];
        for (const err of r.body.errors.map(String)) {
          const hit = ERROR_FIELDS.find(([prefix]) => err.startsWith(prefix));
          if (hit && !byField[hit[1]]) { byField[hit[1]] = err.replace(/^profile\./, ''); } else { rest.push(err); }
        }
        showErrors(byField, rest);
        return;
      }
      // Offline (status 0) and everything else: say so and keep the form as it is.
      if (r.status !== 401 && r.status !== 403) { showErrors({}, [serverMessage(r)]); }
    };

    const discard = async () => {
      if (isDirty()) {
        const ok = await confirmDialog({
          title: 'Discard your changes?', text: 'Your edits to these standards will be lost.',
          confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true,
        });
        if (!ok) { return; }
      }
      leave(null);
      renderAll(true);
    };

    title.textContent = source.version === null ? 'Propose standards' : `Edit standards · from v${source.version}`;
    const form = h('form', { on: { submit }, novalidate: true },
      h('p', null, `Submitting creates v${nextNumber} for review.${state.dto.effectiveVersion ? ` v${state.dto.effectiveVersion} stays in effect until then.` : ''}`),
      noticeHost,
      h('fieldset', { class: 'field' },
        h('legend', null, 'Repository state', provenanceTag(source, 'repoState')),
        h('div', { class: 'radio-row' }, radio('greenfield', 'Greenfield (no source files yet)'), radio('brownfield', 'Brownfield (existing code)'))),
      group('Folder structure',
        bind('requiredDirs', 'Required directories', area(), { hint: 'One per line.', prov: 'structure.requiredDirs' }),
        bind('allowedTopLevel', 'Allowed top-level entries', area(4), { hint: 'One name or glob per line. Leave empty to allow anything.', prov: 'structure.allowedTopLevel' }),
        bind('placement', 'Placement rules', area(), { hint: 'One per line: files -> directory, directory', prov: 'structure.placement' })),
      group('Frontend',
        bind('componentKit', 'Component kit', text(), { prov: 'frontend.componentKit' }),
        bind('styleSource', 'Style source', text(), { prov: 'frontend.styleSource' }),
        bind('rawPatterns', 'Raw patterns', area(), { hint: 'One per line: id | literal or builtin | value | globs | message', prov: 'frontend.rawPatterns' })),
      h('fieldset', { class: 'field card' },
        h('legend', null, 'Design system', provenanceTag(source, 'design')),
        h('p', null, designBox, ' ', h('label', { for: 'design-enabled' }, 'This project has a user interface (include a design system)')),
        designFields),
      group('Backend layering',
        bind('layers', 'Layers', area(), { hint: 'One per line: name: glob, glob', prov: 'backend.layers' }),
        bind('forbiddenImports', 'Forbidden imports', area(2), { hint: 'One per line: layer -> layer it must not import from' }),
        bind('importAliases', 'Import aliases', area(2), { hint: 'One per line: prefix = path' })),
      group('Naming',
        bind('namingFiles', 'File names', area(), { hint: 'One per line: glob, glob -> style', prov: 'naming.files' }),
        bind('namingNotes', 'Notes', text())),
      group('Comment policy',
        bind('maxDensityPct', 'Density limit (% of added lines)', h('input', { type: 'number', min: 0, max: 100, step: 'any' }), { prov: 'comments' }),
        bind('minAddedLines', 'Applies to files with at least this many added lines', h('input', { type: 'number', min: 1, step: 1 })),
        bind('forbidCommentedOutCode', 'Forbid commented-out code', h('input', { type: 'checkbox' })),
        bind('bannedPhrases', 'Banned phrases', area(), { hint: 'One per line.' })),
      group('Testing',
        bind('runner', 'Runner', text(), { prov: 'testing' }),
        bind('fileGlobs', 'Test files', area(2), { hint: 'One glob per line.' }),
        bind('testingNotes', 'Notes', text())),
      severityRows.length > 0 ? h('fieldset', { class: 'field card' },
        h('legend', null, 'What blocks a release'),
        h('p', { class: 'hint' }, STR.C47.text),
        severityRows,
        h('p', { class: 'hint' }, STR.C50.text),
        severityErr) : null,
      h('fieldset', { class: 'field card' },
        h('legend', null, 'Commands', provenanceTag(source, 'commands', { command: true })),
        commandRows,
        h('p', { class: 'hint' }, 'Runs in the project workspace on every run, exactly as written. The reviewer sees it verbatim.'),
        commandErr),
      group('Built-in rules',
        bind('builtInRuleIds', 'Rule ids', area(), { hint: 'One per line.', prov: 'builtInRuleIds' })),
      h('fieldset', { class: 'field card' }, h('legend', null, 'Free-text rules'), freeText, counter),
      formErr,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => { void discard(); } } }, 'Discard changes'),
        submitBtn));

    mount(view, h('div', { class: 'form-page' }, h('div', { class: 'screen-header' }, title, status), form));
    showDesign();
    renderPreview();
    syncDocCounter();
    syncCounter();
    sync();
    if (focus) { title.setAttribute('tabindex', '-1'); title.focus(); }
  };

  function renderAll(focus) {
    if (drafts.has(projectId) && canPropose()) { renderEdit(focus); } else { drafts.delete(projectId); renderView(focus); }
  }

  renderAll(false);
  return undefined;
}
