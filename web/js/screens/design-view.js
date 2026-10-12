// ─── Design system: the shared read-only renderer (UX A.5 §1–§4.6) ───
//
// One module for every place a project's design system is shown: the standards screen,
// plan review and the run screen's ship gate. Everything is built with h() and
// textContent — DESIGN.md is shown as plain text in blocks (§4.6), never parsed as HTML,
// and no link in it becomes clickable.
//
// The one product value painted on screen is a swatch fill. The server sends it resolved;
// it is checked again here against a strict hex pattern and only then set through the
// CSSOM (`style.setProperty`), which the CSP allows. MOAG's own chrome stays on --ds-* tokens.

import { h, glyph } from '../dom.js';

/** Tokens shown before "Show all N tokens". */
const TOKENS_SHOWN = 50;
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

const count = (n) => Number(n || 0).toLocaleString('en-US');
const list = (v) => (Array.isArray(v) ? v : []);

/** The validated swatch colour for a server-resolved value, or null for anything else. */
export function swatchColour(resolved) {
  return typeof resolved === 'string' && HEX.test(resolved) ? resolved : null;
}

/** A finite px number within [0, max], or null. */
function px(resolved, max) {
  return typeof resolved === 'number' && Number.isFinite(resolved) && resolved >= 0 ? Math.min(resolved, max) : null;
}

/** The swatch cell of one token: a colour fill, a length bar, a radius box, "Aa", or "—". */
function swatch(token) {
  const kind = token && token.kind;
  if (kind === 'colour') {
    const hex = swatchColour(token.resolved);
    if (hex) {
      const el = h('span', { class: 'swatch', 'aria-hidden': 'true' });
      el.style.setProperty('background-color', hex);
      return el;
    }
  } else if (kind === 'length') {
    const w = px(token.resolved, 96);
    if (w !== null) {
      const el = h('span', { class: 'swatch-bar', 'aria-hidden': 'true' });
      el.style.setProperty('width', `${w}px`);
      return el;
    }
  } else if (kind === 'radius') {
    const r = px(token.resolved, 8);
    if (r !== null) {
      const el = h('span', { class: 'swatch swatch-radius', 'aria-hidden': 'true' });
      el.style.setProperty('border-radius', `${r}px`);
      return el;
    }
  } else if (kind === 'font-size') {
    const size = px(token.resolved, 28);
    if (size !== null) {
      const el = h('span', { class: 'swatch-type', 'aria-hidden': 'true' }, 'Aa');
      el.style.setProperty('font-size', `${size}px`);
      return el;
    }
  }
  return h('span', { class: 'muted' }, '—');
}

/** The contrast cell: words carry the meaning, the glyph only repeats it. */
function contrastCell(token) {
  if (token.role === 'background') { return h('span', { class: 'muted' }, 'background'); }
  const ratio = token.contrast;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) { return h('span', { class: 'muted' }, '—'); }
  const shown = `${ratio.toFixed(1)}:1`;
  if (ratio >= 4.5) { return h('span', null, `${shown} body text`); }
  if (ratio >= 3) { return h('span', { class: 'text-warning' }, glyph('⚠'), ` ${shown} large text only`); }
  return h('span', { class: 'text-warning' }, glyph('⚠'), ` ${shown} below 3:1`);
}

/** The counts line: "12 colours · 7 spacing · 3 radii · 6 type". */
function countsText(tokens) {
  const by = (kind) => tokens.filter((t) => t && t.kind === kind).length;
  const parts = [
    [by('colour'), 'colour', 'colours'], [by('length'), 'spacing', 'spacing'], [by('radius'), 'radius', 'radii'],
    [by('font-size') + by('font-family'), 'type', 'type'], [by('other'), 'other', 'other'],
  ].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length > 0 ? parts.join(' · ') : 'No tokens declared';
}

/**
 * The summary list of a design system: where its two files are and what the tokens hold.
 * `opts.provenance(field)` adds the provenance tag beside a path; `opts.inRun` the C71 line.
 */
export function designSummary(design, opts = {}) {
  const d = design || {};
  const tokens = list(d.tokens);
  const tag = typeof opts.provenance === 'function' ? opts.provenance('design') : null;
  return h('dl', { class: 'summary' },
    h('dt', null, 'DESIGN.md'), h('dd', null, h('span', { class: 'mono' }, d.docPath || '—'), tag),
    h('dt', null, 'Tokens file'), h('dd', null, h('span', { class: 'mono' }, d.tokensPath || '—')),
    h('dt', null, 'Tokens'), h('dd', null, d.tokensListable === false ? 'Not listable' : countsText(tokens)),
    opts.inRun ? [h('dt', null, 'In the run'), h('dd', null, opts.inRun)] : null);
}

/**
 * The token table: swatch, token, value and (unless `opts.contrast === false`) the contrast on
 * the background. The first 50 rows, then a "Show all N tokens" button.
 */
export function tokenTable(tokens, opts = {}) {
  const all = list(tokens).filter((t) => t && typeof t.name === 'string');
  if (all.length === 0) { return h('p', { class: 'muted' }, 'No tokens declared.'); }
  const withContrast = opts.contrast !== false;
  const hasBackground = all.some((t) => t.role === 'background');
  const caption = `${opts.caption || 'Design tokens'}${withContrast && !hasBackground ? ', no background token declared' : ''}`;
  const body = h('tbody');
  const row = (t) => h('tr', null,
    h('td', null, swatch(t)),
    h('th', { scope: 'row', class: 'diff-id' }, t.name),
    h('td', { class: 'mono' }, String(t.value === undefined ? '' : t.value)),
    withContrast ? h('td', null, contrastCell(t)) : null);
  const fill = (n) => { while (body.firstChild) { body.removeChild(body.firstChild); } all.slice(0, n).forEach((t) => body.appendChild(row(t))); };
  fill(TOKENS_SHOWN);
  const more = all.length > TOKENS_SHOWN ? h('button', {
    type: 'button', class: 'btn-link',
    on: { click: (e) => { fill(all.length); e.currentTarget.hidden = true; } },
  }, `Show all ${all.length} tokens`) : null;
  return h('div', null,
    h('div', { class: 'table-wrap' },
      h('table', { class: 'data' },
        h('caption', null, caption),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Swatch'), h('th', { scope: 'col' }, 'Token'), h('th', { scope: 'col' }, 'Value'),
          withContrast ? h('th', { scope: 'col' }, 'Contrast on background') : null)),
        body)),
    more);
}

/**
 * DESIGN.md as plain-text blocks (§4.6): `#`/`##` → h4, `###`+ → h5, `- `/`* ` → ul,
 * `1. ` → ol, a ``` fence → pre, a run of `|` lines → table (shown as one scrolling pre),
 * `> ` → quote, anything else joined into a paragraph that a blank line ends.
 * Pure: returns `[{ kind, lines }]`; no inline formatting is interpreted.
 */
export function docBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let cur = null;
  const push = (kind, line) => {
    if (!cur || cur.kind !== kind) { cur = { kind, lines: [] }; blocks.push(cur); }
    cur.lines.push(line);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const body = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]); i++) { body.push(lines[i]); }
      blocks.push({ kind: 'pre', lines: body });
      cur = null;
      continue;
    }
    const heading = /^(#{1,6})\s*(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: heading[1].length <= 2 ? 'h4' : 'h5', lines: [heading[2].trim()] }); cur = null; continue; }
    if (line.trim() === '') { cur = null; continue; }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { push('ul', bullet[1]); continue; }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) { push('ol', numbered[1]); continue; }
    if (/^\s*\|/.test(line)) { push('table', line); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { push('quote', quote[1]); continue; }
    push('p', line.trim());
  }
  return blocks;
}

/** One block of {@link docBlocks} as elements. */
function blockEl(b) {
  switch (b.kind) {
    case 'h4': return h('h4', null, b.lines[0]);
    case 'h5': return h('h5', null, b.lines[0]);
    case 'ul': return h('ul', null, b.lines.map((l) => h('li', null, l)));
    case 'ol': return h('ol', null, b.lines.map((l) => h('li', null, l)));
    case 'pre': return h('pre', { class: 'tail', tabindex: '0' }, b.lines.join('\n'));
    case 'table': return h('pre', { class: 'mono', tabindex: '0' }, b.lines.join('\n'));
    case 'quote': return h('p', { class: 'muted' }, b.lines.join(' '));
    default: return h('p', null, b.lines.join(' '));
  }
}

/**
 * DESIGN.md in a disclosure: "DESIGN.md  N characters", opened with `opts.open`. The text
 * scrolls inside a 480px container; `label` names it for screen readers.
 */
export function designDoc(text, label, opts = {}) {
  const doc = String(text || '');
  return h('details', { class: 'diff-group', open: !!opts.open },
    h('summary', null, `DESIGN.md  ${count(doc.length)} characters`),
    h('section', { class: 'design-doc', tabindex: '0', 'aria-label': label || 'DESIGN.md' },
      doc.trim() === '' ? h('p', { class: 'muted' }, 'DESIGN.md is empty.') : docBlocks(doc).map(blockEl)));
}

const CHANGE_WORDS = { changed: ['~', 'Changed'], added: ['+', 'Added'], removed: ['−', 'Removed'] };

/**
 * What a version changes about the design system (the server's `designChanged`): a token
 * table of Changed / Added / Removed rows, the paths when they moved, and each DESIGN.md
 * section that differs, before and after.
 */
export function tokenDiffTable(changes) {
  const c = changes || {};
  const tokens = list(c.tokens).filter((t) => t && typeof t.name === 'string');
  const sections = list(c.sections).filter((s) => s && typeof s.heading === 'string');
  const from = typeof c.comparedTo === 'number' ? `v${c.comparedTo}` : 'nothing approved';
  const side = (value, resolved) => (value === null || value === undefined ? h('span', { class: 'muted' }, '—')
    : [swatch({ kind: swatchColour(resolved) ? 'colour' : null, resolved }), ' ', h('span', { class: 'mono' }, String(value))]);
  const rows = tokens.map((t) => {
    const kind = t.before === null ? 'added' : t.after === null ? 'removed' : 'changed';
    const [mark, word] = CHANGE_WORDS[kind];
    return h('tr', null,
      h('td', null, h('span', { 'aria-hidden': 'true' }, `${mark} `), word),
      h('th', { scope: 'row', class: 'diff-id' }, t.name),
      h('td', null, side(t.before, t.beforeResolved)),
      h('td', null, side(t.after, t.afterResolved)));
  });
  const pathText = (p) => (p ? `${p.docPath} · ${p.tokensPath}` : '(none)');
  return h('div', null,
    tokens.length > 0 ? [
      h('h4', { class: 'section-header' }, `Tokens  ${tokens.length} changed`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('caption', null, `Token changes from ${from}`),
        h('thead', null, h('tr', null, ['Change', 'Token', 'Before', 'After'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, rows)))] : null,
    c.raw ? h('div', { class: 'before-after' },
      h('pre', { class: 'before tail', tabindex: '0', 'aria-label': 'Tokens file before' }, c.raw.before === null ? '(none)' : String(c.raw.before)),
      h('pre', { class: 'after tail', tabindex: '0', 'aria-label': 'Tokens file after' }, c.raw.after === null ? '(none)' : String(c.raw.after))) : null,
    c.paths ? h('p', null, h('strong', null, 'Paths '), h('span', { class: 'mono' }, `${pathText(c.paths.before)} → ${pathText(c.paths.after)}`)) : null,
    sections.length > 0 ? [
      h('h4', { class: 'section-header' }, `DESIGN.md  ${sections.length} section${sections.length === 1 ? '' : 's'} changed`),
      sections.map((s) => h('div', null,
        h('p', null, h('strong', null, s.heading || '(before the first heading)')),
        h('div', { class: 'before-after' },
          h('pre', { class: 'before tail', tabindex: '0', 'aria-label': `${s.heading || 'Preamble'}, before` }, s.before === null ? '(removed)' : String(s.before)),
          h('pre', { class: 'after tail', tabindex: '0', 'aria-label': `${s.heading || 'Preamble'}, after` }, s.after === null ? '(removed)' : String(s.after)))))] : null);
}

/**
 * The tokens a tokens file's text declares, parsed in the browser for the editor's preview
 * (name and value only; the server is the judge on submit).
 */
export function previewTokens(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(--[A-Za-z0-9_-]{1,100})\s*:\s*([^;]{1,200});/.exec(line);
    if (m && m[2].trim() !== '') { out.push({ name: m[1], value: m[2].trim(), kind: 'other' }); }
    if (out.length >= 300) { break; }
  }
  return out;
}
