// ─── Run the web app's browser modules in a VM, with a minimal fake DOM ───
//
// The web modules are plain browser ES modules with no build step. Their functions are lifted
// out of the source (imports removed, exports made plain) and run in a VM with stubs in scope.
// `fakeH` stands in for `h()` from web/js/dom.js: it builds a small element tree whose text
// children are plain strings, so a test can tell text from markup — a path that holds
// `<script>` must arrive as a string, never as an element.

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

export const WEB_JS = path.resolve(__dirname, '..', '..', '..', '..', 'web', 'js');

/** A web module with its imports removed and its exports made plain, run with `stubs` in scope. */
export function loadWebModule(file: string, stubs: Record<string, unknown>, expose: string[]): Record<string, unknown> {
  const source = fs.readFileSync(path.join(WEB_JS, file), 'utf-8')
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+(async\s+)?function\s/gm, '$1function ')
    .replace(/^export\s+const\s/gm, 'const ');
  const context: Record<string, unknown> = { ...stubs };
  vm.runInNewContext(`${source}\n${expose.map((name) => `this[${JSON.stringify(name)}] = ${name};`).join('\n')}`, context);
  return context;
}

/** A fake element: a tag, its attributes, and children that are fake elements or plain text. */
export class FakeEl {
  readonly attrs: Record<string, string> = {};
  readonly childNodes: Array<FakeEl | string> = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  readonly dataset: Record<string, string> = {};
  className = '';
  value = '';
  disabled = false;
  open = false;
  checked = false;
  focused = false;
  constructor(readonly tag: string) {}
  get children(): FakeEl[] { return this.childNodes.filter((c): c is FakeEl => c instanceof FakeEl); }
  get firstChild(): FakeEl | string | null { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v: string) { this.childNodes.splice(0, this.childNodes.length, v); }
  appendChild<T extends FakeEl | string>(c: T): T { this.childNodes.push(c); return c; }
  removeChild<T extends FakeEl | string>(c: T): T {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) { this.childNodes.splice(i, 1); }
    return c;
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(ev: string, fn: () => void): void { (this.listeners[ev] ??= []).push(fn); }
  focus(): void { this.focused = true; }
  /** Every element in this tree (this one included), depth first. */
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  /** Every element with `cls` among its classes. */
  byClass(cls: string): FakeEl[] { return this.all().filter((e) => e.className.split(' ').includes(cls)); }
  click(): void { for (const fn of this.listeners.click ?? []) { fn(); } }
}

/** `h()` over {@link FakeEl}: the same attribute rules as web/js/dom.js, minus the DOM. */
export function fakeH(tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): FakeEl {
  const el = new FakeEl(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) { continue; }
    if (k === 'style' || /^on[a-z]/i.test(k)) { throw new Error(`h(): attribute "${k}" is not allowed`); }
    if (k === 'class') { el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v); }
    else if (k === 'on') { for (const [ev, fn] of Object.entries(v as Record<string, () => void>)) { el.addEventListener(ev, fn); } }
    else if (k === 'dataset') { Object.assign(el.dataset, v); }
    else if (k === 'disabled' || k === 'open' || k === 'checked') { el[k] = !!v; }
    else if (k === 'value') { el.value = String(v); }
    else { el.setAttribute(k, v === true ? '' : String(v)); }
  }
  const add = (list: unknown[]): void => {
    for (const c of list) {
      if (c === null || c === undefined || c === false) { continue; }
      if (Array.isArray(c)) { add(c); } else if (c instanceof FakeEl) { el.appendChild(c); } else { el.appendChild(String(c)); }
    }
  };
  add(children);
  return el;
}

/** Wrap whatever a render function returned (an element, an array, null) in one root element. */
export function root(rendered: unknown): FakeEl {
  return fakeH('div', null, rendered);
}

/** The real STR table from web/js/strings.js. */
export function webStrings(): Record<string, unknown> {
  return loadWebModule('strings.js', {}, ['STR']).STR as Record<string, unknown>;
}

/** The DOM helpers a screen module imports from dom.js, over {@link fakeH}. */
export function fakeDomStubs(): Record<string, unknown> {
  return {
    h: fakeH,
    glyph: (ch: string) => fakeH('span', { class: 'glyph', 'aria-hidden': 'true' }, ch),
    badge: (text: string, kind = 'muted') => fakeH('span', { class: ['badge', `badge-${kind}`] }, text),
    STR: webStrings(),
    Set, Map, Number, String, Array, Object, JSON, Math,
  };
}
