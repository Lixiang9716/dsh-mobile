// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/web-dom.js — the minimal DOM the upstream suite's browser-shaped
 * client faces need in a headless runtime (R3-G1, 2026-09-28). Scope is the
 * measured demand, not a browser:
 *   - experimental webworker-runtime client (source-chooser spec renders a
 *     chooser through innerHTML + dataset + FormData and asserts it back
 *     through attribute/pseudo-class selectors; load-bundle spec injects a
 *     <script> element and dispatches its load event through a mocked
 *     head.append).
 *   - document/head/body element faces: createElement, getElementById,
 *     querySelector(All), append/prepend/remove/replaceChildren,
 *     textContent, innerHTML (small-tag HTML parser), dataset,
 *     attributes, value/checked/disabled property coupling, contains,
 *     childElementCount, addEventListener/dispatchEvent with bubble walk.
 *   - location + history.replaceState — the source-chooser product reads the
 *     launch query through `new URL(location.href).searchParams` and the
 *     spec repoints it through history.replaceState (installed only when the
 *     host defines neither).
 *   - FormData — the form-successful-controls subset (named, checked inputs).
 * Deliberately NOT implemented: layout, styling, real resource loading
 * (injected scripts only fire their events when a test dispatches them),
 * MutationObservers, ranges, iframe/worker realms — the inspector client
 * spec needs WebSocket + a client realm and stays excluded (B, wave 1).
 * Events reuse shims/web-event.js; bubbling is a parent-walk on top of its
 * single-phase dispatch.
 */
import { Event, EventTarget } from './web-event.js';
// The HTML parser lives in its own module (the file crossed the size
// budget); the element primitives it needs are exported below — an ESM
// cycle by construction, call-time access only.
import { parseHTML } from 'upstream/shims/web-dom-parser.js';

export const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export const decodeEntities = (text) => String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, body) => {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : raw;
});

const escapeMarkup = (text) => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.nodeName = '#text';
    this._text = String(text);
    this.parentNode = null;
  }
  get data() { return this._text; }
  get textContent() { return this._text; }
}

/** dataset ↔ data-* attribute mapping (hyphenated attribute ↔ camelCase key). */
const datasetFor = (element) => new Proxy({}, {
  get: (_t, key) => {
    if (typeof key !== 'string') return undefined;
    return element.getAttribute(`data-${key.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  },
  set: (_t, key, value) => {
    if (typeof key !== 'string') return false;
    const attr = `data-${key.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (value === undefined || value === null) element.removeAttribute(attr);
    else element.setAttribute(attr, String(value));
    return true;
  },
  deleteProperty: (_t, key) => {
    if (typeof key === 'string') element.removeAttribute(`data-${key.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    return true;
  },
  ownKeys: () => {
    const keys = [];
    for (const name of element.getAttributeNames()) {
      if (!name.startsWith('data-')) continue;
      keys.push(name.slice(5).replaceAll(/-(\w)/g, (_m, c) => c.toUpperCase()));
    }
    return keys;
  },
  getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
});

export class DOMElement extends EventTarget {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this._attrs = new Map(); // lowercased name → value string ('' for bare)
    this._children = [];
    this.parentNode = null;
    this._dirtyValue = undefined; // input .value property write (FormData reads it)
  }

  /* ---- attributes ---- */
  getAttributeNames() { return [...this._attrs.keys()]; }
  getAttribute(name) {
    const value = this._attrs.get(String(name).toLowerCase());
    return value === undefined ? null : value;
  }
  setAttribute(name, value) { this._attrs.set(String(name).toLowerCase(), String(value)); }
  removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); }
  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }
  get id() { return this.getAttribute('id') ?? ''; }
  get className() { return this.getAttribute('class') ?? ''; }
  get classList() {
    const self = this;
    return {
      contains: (token) => self.getAttribute('class')?.split(/\s+/).includes(token) === true,
      add: (...tokens) => {
        const have = new Set((self.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
        for (const t of tokens) have.add(t);
        self.setAttribute('class', [...have].join(' '));
      },
    };
  }
  get dataset() { return datasetFor(this); }

  /* ---- form-control property coupling (input) ---- */
  get value() {
    if (this._dirtyValue !== undefined) return this._dirtyValue;
    return this.getAttribute('value') ?? '';
  }
  set value(next) { this._dirtyValue = String(next); }
  get name() { return this.getAttribute('name') ?? ''; }
  get type() { return this.getAttribute('type') ?? ''; }
  /** checked/disabled read the ATTRIBUTE (the presence spelling the corpus
   * renders); a property write tracks a separate checked state so selector
   * `:checked` answers the live state. */
  get checked() { return this._dirtyChecked ?? this.hasAttribute('checked'); }
  set checked(next) { this._dirtyChecked = next === true; }
  get disabled() { return this.hasAttribute('disabled'); }

  /* ---- tree ---- */
  get children() { return this._children.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }

  _attach(node) { node.parentNode = this; this._children.push(node); }
  append(...nodes) {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new TextNode(node) : node;
      el.parentNode?._detach(el);
      this._attach(el);
    }
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      const el = typeof node === 'string' ? new TextNode(node) : node;
      el.parentNode?._detach(el);
      this._children.unshift(el);
      el.parentNode = this;
    }
  }
  _detach(node) {
    const at = this._children.indexOf(node);
    if (at >= 0) this._children.splice(at, 1);
  }
  remove() { this.parentNode?._detach(this); this.parentNode = null; }
  replaceChildren(...nodes) {
    for (const child of [...this._children]) child.parentNode = null;
    this._children = [];
    this.append(...nodes);
  }
  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }

  /* ---- text / html ---- */
  get textContent() {
    return this._children.map((c) => c.textContent ?? '').join('');
  }
  set textContent(text) {
    this.replaceChildren();
    if (text !== '') this.append(new TextNode(text));
  }
  get innerHTML() {
    return this._children.map((c) => (c.nodeType === 1 ? c.outerHTML : escapeMarkup(c._text))).join('');
  }
  set innerHTML(markup) {
    this.replaceChildren();
    for (const node of parseHTML(markup)) this.append(node);
  }
  get outerHTML() {
    const attrs = [...this._attrs].map(([k, v]) => v === '' ? ` ${k}` : ` ${k}="${escapeMarkup(v)}"`).join('');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  /* ---- traversal / selectors ---- */
  *_descendants() {
    for (const child of this._children) {
      yield child;
      if (child.nodeType === 1) yield* child._descendants();
    }
  }
  matches(selector) { return matchesCompound(this, selector); }
  closest(selector) {
    for (let at = this; at; at = at.parentElement) {
      if (matchesCompound(at, selector)) return at;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const out = [];
    for (const node of this._descendants()) {
      if (node.nodeType !== 1) continue;
      for (const part of selector.split(',')) {
        if (matchesComplex(node, part.trim())) { out.push(node); break; }
      }
    }
    return out;
  }

  /* ---- events: bubbles walk on top of web-event's single-phase dispatch ---- */
  dispatchEvent(event) {
    if (!(event instanceof Event)) {
      throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'");
    }
    if (event.bubbles !== true) return super.dispatchEvent(event);
    event.target = event.target ?? this;
    for (let node = this; node !== null && !event._stopImmediate; node = node.parentNode) {
      if (node instanceof EventTarget) EventTarget.prototype.dispatchEvent.call(node, event);
    }
    return !event.defaultPrevented;
  }
}

/* ---- selector engine ----------------------------------------------------- */

const parseCompound = (compound) => {
  const parts = [];
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === '*') { parts.push({ kind: 'any' }); i += 1; }
    else if (/[\w-]/.test(ch)) {
      const m = /^[\w-]+/.exec(compound.slice(i));
      parts.push({ kind: 'tag', value: m[0].toUpperCase() });
      i += m[0].length;
    } else if (ch === '#') {
      const m = /^[\w-]+/.exec(compound.slice(i + 1));
      parts.push({ kind: 'id', value: m[0] });
      i += 1 + m[0].length;
    } else if (ch === '.') {
      const m = /^[\w-]+/.exec(compound.slice(i + 1));
      parts.push({ kind: 'class', value: m[0] });
      i += 1 + m[0].length;
    } else if (ch === '[') {
      const end = compound.indexOf(']', i);
      const body = compound.slice(i + 1, end);
      const eq = body.indexOf('=');
      if (eq === -1) parts.push({ kind: 'attr', name: body.toLowerCase(), value: undefined });
      else {
        const name = body.slice(0, eq).replace(/[~^|$*]\s*$/, '').trim().toLowerCase();
        let value = body.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        parts.push({ kind: 'attr', name, value });
      }
      i = end + 1;
    } else if (ch === ':') {
      const m = /^:([\w-]+)/.exec(compound.slice(i));
      parts.push({ kind: 'pseudo', value: m[1].toLowerCase() });
      i += m[0].length;
    } else i += 1;
  }
  return parts;
};

const matchCompound = (el, parts) => parts.every((part) => {
  switch (part.kind) {
    case 'any': return true;
    case 'tag': return el.tagName === part.value;
    case 'id': return el.id === part.value;
    case 'class': return el.classList.contains(part.value);
    case 'attr': return part.value === undefined ? el.hasAttribute(part.name) : el.getAttribute(part.name) === part.value;
    case 'pseudo':
      if (part.value === 'checked') return el.checked === true;
      if (part.value === 'disabled') return el.disabled === true;
      if (part.value === 'first-child') return el.parentElement === null || el.parentElement.children[0] === el;
      return false;
    default: return false;
  }
});

const matchesCompound = (el, compound) => matchCompound(el, parseCompound(compound.trim()));

/** Descendant-combinator chain (`a b c`): the element matches the last
 * compound and each earlier compound matches SOME distinct ancestor,
 * nearest-first (greedy, like the DOM's left-to-right evaluation). */
const matchesComplex = (el, complex) => {
  const compounds = complex.split(/\s+/).filter(Boolean);
  if (compounds.length === 0) return false;
  const parts = compounds.map(parseCompound);
  const matchAncestry = (node, index) => {
    if (!matchCompound(node, parts[index])) return false;
    if (index === 0) return true;
    for (let at = node.parentElement; at; at = at.parentElement) {
      if (matchAncestry(at, index - 1)) return true;
    }
    return false;
  };
  return matchAncestry(el, parts.length - 1);
};

/* ---- the small HTML parser ------------------------------------------------ */

export class DOMDocument extends DOMElement {
  constructor() {
    super('#document');
    this.nodeType = 9;
    this.documentElement = new DOMElement('html');
    this.head = new DOMElement('head');
    this.body = new DOMElement('body');
    this.title = '';
    this.documentElement.append(this.head, this.body);
    // The documentElement (and through it head/body) must be a REAL child —
    // getElementById/querySelector walk _descendants() from the document
    // (R3-G1, 2026-09-28: 'root missing' when head/body hung off nothing).
    this.append(this.documentElement);
  }
  createElement(tagName) {
    // The anchor download gesture: session-log-export's controller creates
    // an <a>, sets href/download, and clicks it (the suite spies
    // HTMLAnchorElement.prototype.click). Route anchors to the dedicated
    // class when the globals layer provided one; other tags keep the
    // generic element face (R3-G2, 2026-09-28).
    if (String(tagName).toLowerCase() === 'a' && globalThis.HTMLAnchorElement !== undefined) {
      return new globalThis.HTMLAnchorElement();
    }
    return new DOMElement(tagName);
  }
  createTextNode(text) { return new TextNode(text); }
  getElementById(id) {
    for (const node of this._descendants()) {
      if (node.nodeType === 1 && node.id === id) return node;
    }
    return null;
  }
}

/** The fallback FormData face (W3-K, 2026-09-28): the fetch-values FormData
 * is the full W3C surface (Blob/File values, set/delete) and replaces this
 * one when it installs — a bare-string face here regressed the llm-deepseek
 * upload path to "not a function" on form.set. */
const DshWebDomFormData = class FormData {
  constructor(form) {
    this._entries = [];
    if (form !== undefined) {
      for (const node of form._descendants()) {
        if (node.nodeType !== 1) continue;
        const name = node.getAttribute('name');
        if (name === null || name === '') continue;
        const type = (node.getAttribute('type') ?? '').toLowerCase();
        if ((type === 'radio' || type === 'checkbox') && node.checked !== true) continue;
        this._entries.push([name, node.value]);
      }
    }
  }
  append(name, value) { this._entries.push([String(name), String(value)]); }
  get(name) { return this._entries.find(([n]) => n === name)?.[1] ?? null; }
  getAll(name) { return this._entries.filter(([n]) => n === name).map(([, v]) => v); }
  has(name) { return this._entries.some(([n]) => n === name); }
};

const installDocumentFaces = () => {
  if (typeof globalThis.document !== 'undefined') return;
  globalThis.document = new DOMDocument();
  globalThis.HTMLElement = DOMElement;
  globalThis.Node = DOMElement;
  DshWebDomFormData.__dshWebDomFallback = true;
  globalThis.FormData = DshWebDomFormData;
};

// navigator — the identity face browser code reads (the inspector client's
// realm labels itself through navigator; node 21+ also defines userAgent).
// Generic honest values: this runtime is none of the commercial browsers.
const installNavigatorFace = () => {
  if (typeof globalThis.navigator !== 'undefined') return;
  globalThis.navigator = {
    userAgent: 'dsh-spike/1.0 (headless; quickjs)',
    platform: 'linux',
    language: 'en-US',
    languages: ['en-US'],
    hardwareConcurrency: 1,
  };
};

// location + history: the query-reading face only (href/search/pathname/
// hash over a mutable href string; replaceState repoints it). An in-memory
// origin — the suite's URLs are relative paths over localhost.
const installLocationFace = () => {
  if (typeof globalThis.location !== 'undefined') return;
  let href = 'http://localhost:3000/preview.html';
  const local = (url) => {
    href = String(url);
  };
  const split = () => {
    const withoutOrigin = href.replace(/^[\w-]+:\/\/[^/]+/, '');
    const [pathAndQuery, hash = ''] = withoutOrigin.split('#');
    const q = pathAndQuery.indexOf('?');
    return {
      pathname: q === -1 ? pathAndQuery : pathAndQuery.slice(0, q),
      search: q === -1 ? '' : pathAndQuery.slice(q),
      hash: hash === '' ? '' : `#${hash}`,
    };
  };
  globalThis.location = {
    get href() { return href; },
    get origin() { return href.match(/^[\w-]+:\/\/[^/]+/)?.[0] ?? 'http://localhost:3000'; },
    get pathname() { return split().pathname; },
    get search() { return split().search; },
    get hash() { return split().hash; },
    toString() { return href; },
    __dshSetHref: local,
  };
};

const installHistoryFace = () => {
  if (typeof globalThis.history !== 'undefined') return;
  globalThis.history = {
    replaceState(_state, _title, url) {
      if (typeof url === 'string') globalThis.location.__dshSetHref(`${globalThis.location.origin}${url}`);
    },
    pushState(_state, _title, url) {
      if (typeof url === 'string') globalThis.location.__dshSetHref(`${globalThis.location.origin}${url}`);
    },
  };
};

/** Install the document/global faces the headless runtime lacks. Idempotent
 * (??= losers keep any host-provided faces). */
export const installWebDom = () => {
  installDocumentFaces();
  installNavigatorFace();
  installLocationFace();
  installHistoryFace();
};
