// ─── DOM helpers: element builder, dialogs, live regions, toasts ───
//
// Every node is built with createElement + textContent. Nothing in this app
// ever parses a string as HTML: task names, error tails and PRD text are
// agent- or user-authored and must never become markup. Event handlers are
// attached with addEventListener only (the CSP forbids inline handlers).

/**
 * Build an element.
 *   h('button', { class: 'btn', type: 'button', on: { click: fn } }, 'Save')
 * attrs: `class`, `text`, `on` (event map), `dataset`, boolean props
 * (`disabled`, `hidden`, `checked`, `selected`, `required`, `readOnly`, `open`),
 * `value`, anything else via setAttribute. `style` is refused (CSP).
 * Children: strings/numbers become text nodes; null/undefined/false are skipped;
 * arrays are flattened.
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const a = attrs || {};
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null || v === false) { continue; }
    if (k === 'style' || /^on[a-z]/i.test(k)) { throw new Error(`h(): attribute "${k}" is not allowed`); }
    if (k === 'class') { el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v); }
    else if (k === 'text') { el.textContent = String(v); }
    else if (k === 'on') { for (const [ev, fn] of Object.entries(v)) { el.addEventListener(ev, fn); } }
    else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v)) { el.dataset[dk] = String(dv); } }
    else if (['disabled', 'hidden', 'checked', 'selected', 'required', 'readOnly', 'open', 'multiple'].includes(k)) { el[k] = !!v; }
    else if (k === 'value') { el.value = String(v); }
    else { el.setAttribute(k, v === true ? '' : String(v)); }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) { continue; }
    if (Array.isArray(c)) { append(el, c); }
    else if (c instanceof Node) { el.appendChild(c); }
    else { el.appendChild(document.createTextNode(String(c))); }
  }
}

/** Remove every child of `el`. */
export function clear(el) {
  while (el.firstChild) { el.removeChild(el.firstChild); }
  return el;
}

/** Replace the children of `el`. */
export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** A status glyph that screen readers skip (the text label carries the meaning). */
export function glyph(ch) {
  return h('span', { class: 'glyph', 'aria-hidden': 'true' }, ch);
}

/** A pill badge. kind: success | warning | error | info | muted. */
export function badge(text, kind = 'muted') {
  return h('span', { class: ['badge', `badge-${kind}`] }, text);
}

let idSeq = 0;
/** A unique element id for label/aria wiring. */
export function uid(prefix = 'id') {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

// ─── Formatting ───

/** "$3.42" */
export function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

/** Local date-time, or "—". */
export function fmtTime(iso) {
  if (!iso) { return '—'; }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** "2 min ago" style relative time. */
export function fmtAgo(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) { return ''; }
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) { return 'just now'; }
  const m = Math.round(s / 60);
  if (m < 60) { return `${m} min ago`; }
  const hr = Math.round(m / 60);
  if (hr < 48) { return `${hr} h ago`; }
  return `${Math.round(hr / 24)} days ago`;
}

// ─── Live regions (throttled, coalescing) ───

const ANNOUNCE_GAP_MS = 2000;
const queues = { polite: [], assertive: [] };
const timers = { polite: null, assertive: null };
const lastAt = { polite: 0, assertive: 0 };

/**
 * Announce to screen readers. At most one announcement per 2 s per politeness;
 * queued messages sharing a `key` coalesce through `plural(n)`.
 * @param {string} text
 * @param {{ assertive?: boolean, key?: string, plural?: (n: number) => string }} [opts]
 */
export function announce(text, opts = {}) {
  const level = opts.assertive ? 'assertive' : 'polite';
  queues[level].push({ text, key: opts.key, plural: opts.plural });
  schedule(level);
}

function schedule(level) {
  if (timers[level]) { return; }
  const wait = Math.max(0, lastAt[level] + ANNOUNCE_GAP_MS - Date.now());
  timers[level] = setTimeout(() => flush(level), wait);
}

function flush(level) {
  timers[level] = null;
  const q = queues[level];
  if (q.length === 0) { return; }
  const first = q[0];
  let text = first.text;
  if (first.key) {
    const same = q.filter((m) => m.key === first.key);
    queues[level] = q.filter((m) => m.key !== first.key);
    if (same.length > 1 && first.plural) { text = first.plural(same.length); }
  } else {
    queues[level] = q.slice(1);
  }
  const region = document.getElementById(level === 'assertive' ? 'live-assertive' : 'live-polite');
  if (region) { region.textContent = ''; region.textContent = text; }
  lastAt[level] = Date.now();
  if (queues[level].length > 0) { schedule(level); }
}

// ─── Toasts ───

/**
 * Show a transient message. kind 'error' uses role="alert", others role="status".
 * @param {string} text
 * @param {'info'|'success'|'warning'|'error'} [kind]
 */
export function toast(text, kind = 'info') {
  const host = document.getElementById('toasts');
  if (!host) { return; }
  const el = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : 'status' },
    h('span', null, text),
    h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Dismiss', on: { click: () => el.remove() } }, '×'));
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 10000 : 5000);
}

// ─── Dialogs ───

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open a modal dialog with a focus trap. Esc closes with `null`. Focus returns
 * to the invoking element. `build(close)` returns the dialog body.
 * @param {{ title: string, alert?: boolean, build: (close: (v: unknown) => void) => Node, initialFocus?: string }} opts
 * @returns {Promise<unknown>}
 */
export function openModal(opts) {
  return new Promise((resolve) => {
    const returnTo = document.activeElement;
    const app = document.getElementById('app');
    const titleId = uid('dlg-title');
    let done = false;
    const close = (value) => {
      if (done) { return; }
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (app && !document.querySelector('.overlay')) { app.inert = false; }
      if (returnTo && typeof returnTo.focus === 'function' && document.contains(returnTo)) { returnTo.focus(); }
      resolve(value);
    };
    const panel = h('div', {
      class: 'dialog', role: opts.alert ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    }, h('h2', { id: titleId, class: 'dialog-title' }, opts.title), opts.build(close));
    const overlay = h('div', { class: 'overlay' }, panel);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key !== 'Tab') { return; }
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((x) => !x.hidden);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    if (app) { app.inert = true; }
    const target = (opts.initialFocus && panel.querySelector(opts.initialFocus)) || panel.querySelector(FOCUSABLE);
    if (target) { target.focus(); }
  });
}

/**
 * A confirm dialog. Cancel has default focus; the confirm button is never the
 * default for destructive actions. With `field`, the user must enter text
 * (when `required`) and the promise resolves `{ value }`.
 * @param {{ title: string, text: string, confirmLabel: string, cancelLabel?: string, destructive?: boolean,
 *           field?: { label: string, required?: boolean, multiline?: boolean, type?: string } }} opts
 * @returns {Promise<null | { value: string }>}
 */
export function confirmDialog(opts) {
  return openModal({
    title: opts.title,
    alert: !!opts.destructive,
    initialFocus: '[data-role="cancel"]',
    build: (close) => {
      const fieldId = uid('dlg-field');
      const errId = uid('dlg-err');
      let input = null;
      const err = h('p', { id: errId, class: 'field-error', hidden: true });
      const fieldBlock = opts.field ? (() => {
        input = opts.field.multiline
          ? h('textarea', { id: fieldId, rows: 3, 'aria-describedby': errId, required: !!opts.field.required })
          : h('input', { id: fieldId, type: opts.field.type || 'text', 'aria-describedby': errId, required: !!opts.field.required, autocomplete: 'off' });
        return h('div', { class: 'field' }, h('label', { for: fieldId }, opts.field.label), input, err);
      })() : null;
      const submit = (e) => {
        e.preventDefault();
        const value = input ? input.value.trim() : '';
        if (opts.field && opts.field.required && value === '') {
          err.textContent = `${opts.field.label} is required.`;
          err.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return;
        }
        close({ value });
      };
      return h('form', { class: 'dialog-body', on: { submit } },
        h('p', null, opts.text),
        fieldBlock,
        h('div', { class: 'dialog-actions' },
          h('button', { type: 'button', class: 'btn btn-secondary', dataset: { role: 'cancel' }, on: { click: () => close(null) } }, opts.cancelLabel || 'Cancel'),
          h('button', { type: 'submit', class: ['btn', opts.destructive ? 'btn-danger' : 'btn-primary'] }, opts.confirmLabel)));
    },
  });
}

/**
 * Build a labelled form field. Returns `{ wrap, input, setError }`.
 * @param {{ label: string, input: HTMLElement, hint?: string }} opts
 */
export function field(opts) {
  const id = opts.input.id || uid('f');
  opts.input.id = id;
  const errId = uid('err');
  const hintId = opts.hint ? uid('hint') : null;
  const err = h('p', { id: errId, class: 'field-error', hidden: true });
  opts.input.setAttribute('aria-describedby', [hintId, errId].filter(Boolean).join(' '));
  const wrap = h('div', { class: 'field' },
    h('label', { for: id }, opts.label),
    opts.input,
    opts.hint ? h('p', { id: hintId, class: 'hint' }, opts.hint) : null,
    err);
  const setError = (msg) => {
    err.textContent = msg || '';
    err.hidden = !msg;
    if (msg) { opts.input.setAttribute('aria-invalid', 'true'); } else { opts.input.removeAttribute('aria-invalid'); }
  };
  return { wrap, input: opts.input, setError };
}

/** An inline error card with a Retry button. */
export function errorCard(text, onRetry) {
  return h('div', { class: ['card', 'card-error'], role: 'alert' },
    h('p', null, glyph('✗'), ' ', text),
    onRetry ? h('button', { type: 'button', class: 'btn btn-secondary', on: { click: onRetry } }, 'Retry') : null);
}

/** Skeleton rows shown during the first fetch; switches to "Still loading…" after 10 s. */
export function skeleton(rows = 3) {
  const note = h('p', { class: 'muted', hidden: true }, 'Still loading…');
  const el = h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: rows }, () => h('div', { class: 'skeleton-row' })), note);
  setTimeout(() => { if (document.contains(el)) { note.hidden = false; } }, 10000);
  return el;
}
