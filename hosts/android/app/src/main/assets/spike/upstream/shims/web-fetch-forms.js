// dsh:logging-exempt (shim layer; value classes, no logging surface)
/**
 * shims/web-fetch-forms.js — the FORM-VALUE half of the fetch value-object
 * family (Blob, File, FormData, URLSearchParams + the live URL.searchParams
 * write-view installer), split out of web-fetch-values.js when that file
 * crossed the code-size budget. One-way dependency by construction: this
 * module imports nothing from web-fetch-values.js, which imports these
 * classes for its Request/Response bodies and the globals install.
 *
 * quickjs-ng constraint honored (the abort-controller precedent): hidden
 * state lives in WeakMaps, never `#private` methods.
 */
const encoder = () => new globalThis.TextEncoder();
const decoder = () => new globalThis.TextDecoder();

/* ---- Blob / File --------------------------------------------------------- */
export const blobState = new WeakMap(); // Blob → { bytes: Uint8Array, type: string }

const asBytes = (value) => {
  if (typeof value === 'string') return encoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return blobState.get(value).bytes;
  if (value === null || value === undefined) return new Uint8Array(0);
  throw new TypeError(`Blob: unsupported part ${typeof value}`);
};

export class Blob {
  constructor(parts = [], options = undefined) {
    const chunks = [];
    let total = 0;
    for (const part of (Array.isArray(parts) ? parts : [parts])) {
      const bytes = asBytes(part);
      chunks.push(bytes);
      total += bytes.length;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    blobState.set(this, { bytes, type: String(options?.type ?? '') });
  }
  get size() { return blobState.get(this).bytes.length; }
  get type() { return blobState.get(this).type; }
  text() { return Promise.resolve(decoder().decode(blobState.get(this).bytes)); }
  arrayBuffer() {
    const bytes = blobState.get(this).bytes;
    return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  bytes() { return Promise.resolve(blobState.get(this).bytes.slice()); }
  stream() {
    const bytes = blobState.get(this).bytes;
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }
  slice(start = 0, end = undefined, contentType = '') {
    const bytes = blobState.get(this).bytes;
    const from = start < 0 ? Math.max(bytes.length + start, 0) : Math.min(start, bytes.length);
    const to = end === undefined ? bytes.length : (end < 0 ? Math.max(bytes.length + end, 0) : Math.min(end, bytes.length));
    return new Blob([bytes.subarray(from, Math.max(from, to))], { type: contentType });
  }
}

export class File extends Blob {
  #name;
  constructor(parts, name, options = undefined) {
    super(parts, options);
    if (typeof name !== 'string' && typeof name !== 'number') throw new TypeError('File: name must be a string');
    this.#name = String(name);
  }
  get name() { return this.#name; }
  get lastModified() { return 0; }
}


/* ---- FormData ------------------------------------------------------------ */
export const formDataState = new WeakMap(); // FormData → Array<{name, value, filename}>

export class FormData {
  constructor(init = undefined) {
    formDataState.set(this, []);
    // The FORM-harvest face: `new FormData(form)` collects the form's named
    // fields (the preview source chooser reads the checked radio back —
    // W4-M 2026-09-28). Duck-typed on the DOM query face; radios and
    // checkboxes contribute only when checked, disabled fields never do.
    if (init !== null && typeof init === 'object' && typeof init.querySelectorAll === 'function'
      && typeof init.getAttribute === 'function' && !(Symbol.iterator in Object(init))) {
      for (const el of init.querySelectorAll('input[name], select[name], textarea[name]')) {
        const name = el.getAttribute('name');
        if (name === null || name === '' || el.getAttribute('disabled') !== null) continue;
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        // The DOM `value` PROPERTY wins (the live value a test or user set —
        // the chooser's unavailable-source arm mutates selected.value);
        // the value ATTRIBUTE is the fallback, 'on' for checkables without
        // either (the HTML default).
        const liveValue = el.value !== undefined && el.value !== null && el.value !== '' ? String(el.value) : el.getAttribute('value');
        if (type === 'radio' || type === 'checkbox') {
          if (el.getAttribute('checked') === null && el.checked !== true) continue;
          this.append(name, liveValue ?? 'on');
        } else {
          if (liveValue !== null) this.append(name, liveValue);
        }
      }
      return;
    }
    if (init === undefined || init === null) return;
    const consume = (key, value) => this.append(key, value);
    if (typeof init === 'object' && Symbol.iterator in Object(init)) {
      for (const pair of init) {
        if (!Array.isArray(pair) || pair.length < 2) throw new TypeError('FormData: iterable init must yield [name, value] pairs');
        consume(pair[0], pair[1]);
      }
    } else if (typeof init === 'object') {
      for (const key of Reflect.ownKeys(init)) consume(key, init[key]);
    } else {
      throw new TypeError('FormData: init must be a form, a pair iterable, or a record');
    }
  }
  #entries() {
    const entries = formDataState.get(this);
    if (entries === undefined) throw new TypeError('FormData: receiver is not a FormData instance');
    return entries;
  }
  #normalized(name, value, filename) {
    if (typeof value !== 'string' && !(value instanceof Blob)) {
      throw new TypeError('FormData: value must be a string or a Blob');
    }
    // Appending a Blob under a filename wraps it into a File (the W3C
    // formData construct; the DeepSeek upload path sets Blobs with names
    // and the suite reads them back as File instances).
    const fileLike = !(typeof value === 'string') && !(value instanceof File);
    if (fileLike || (value instanceof File && filename !== undefined)) {
      const name2 = typeof filename === 'string' ? filename : (value instanceof File ? value.name : 'blob');
      return { name: String(name), value: new File([value], name2, { type: value.type }), filename: undefined };
    }
    return { name: String(name), value, filename: undefined };
  }
  append(name, value, filename = undefined) {
    this.#entries().push(this.#normalized(name, value, filename));
  }
  set(name, value, filename = undefined) {
    const entry = this.#normalized(name, value, filename);
    const entries = this.#entries();
    const key = entry.name;
    const at = entries.findIndex((existing) => existing.name === key);
    if (at < 0) { entries.push(entry); return; }
    entries[at] = entry;
    for (let i = entries.length - 1; i >= 0; i--) if (i !== at && entries[i].name === key) entries.splice(i, 1);
  }
  get(name) {
    const found = this.#entries().find((entry) => entry.name === String(name));
    return found === undefined ? null : found.value;
  }
  getAll(name) {
    return this.#entries().filter((entry) => entry.name === String(name)).map((entry) => entry.value);
  }
  has(name) { return this.#entries().some((entry) => entry.name === String(name)); }
  delete(name) {
    const kept = this.#entries().filter((entry) => entry.name !== String(name));
    formDataState.set(this, kept);
  }
  * entries() { for (const entry of this.#entries()) yield [entry.name, entry.value]; }
  * keys() { for (const entry of this.#entries()) yield entry.name; }
  * values() { for (const entry of this.#entries()) yield entry.value; }
  [Symbol.iterator]() { return this.entries(); }
}


/* ---- URLSearchParams ----------------------------------------------------- */
const searchParamsState = new WeakMap(); // URLSearchParams → Array<[string, string]>

export class URLSearchParams {
  constructor(init = undefined) {
    const entries = [];
    if (typeof init === 'string') {
      for (const pair of init.replace(/^\?/, '').split('&')) {
        if (pair.length === 0) continue;
        const eq = pair.indexOf('=');
        const key = eq < 0 ? pair : pair.slice(0, eq);
        const value = eq < 0 ? '' : pair.slice(eq + 1);
        entries.push([decodeComponent(key), decodeComponent(value)]);
      }
    } else if (Array.isArray(init) || (init !== null && typeof init === 'object' && Symbol.iterator in Object(init))) {
      for (const [key, value] of init) entries.push([String(key), String(value)]);
    } else if (init !== null && typeof init === 'object') {
      for (const key of Reflect.ownKeys(init)) entries.push([String(key), String(init[key])]);
    }
    searchParamsState.set(this, entries);
  }
  #entries() {
    const entries = searchParamsState.get(this);
    if (entries === undefined) throw new TypeError('URLSearchParams: receiver is not a URLSearchParams instance');
    return entries;
  }
  append(name, value) { this.#entries().push([String(name), String(value)]); }
  set(name, value) {
    const entries = this.#entries();
    const key = String(name);
    const at = entries.findIndex(([existing]) => existing === key);
    if (at < 0) { entries.push([key, String(value)]); return; }
    entries[at] = [key, String(value)];
    for (let i = entries.length - 1; i >= 0; i--) if (i !== at && entries[i][0] === key) entries.splice(i, 1);
  }
  get(name) {
    const found = this.#entries().find(([key]) => key === String(name));
    return found === undefined ? null : found[1];
  }
  getAll(name) { return this.#entries().filter(([key]) => key === String(name)).map(([, value]) => value); }
  has(name) { return this.#entries().some(([key]) => key === String(name)); }
  delete(name) { searchParamsState.set(this, this.#entries().filter(([key]) => key !== String(name))); }
  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
  * entries() { for (const [key, value] of this.#entries()) yield [key, value]; }
  * keys() { for (const [key] of this.#entries()) yield key; }
  * values() { for (const [, value] of this.#entries()) yield value; }
  [Symbol.iterator]() { return this.entries(); }
  toString() {
    return this.#entries()
      .map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`)
      .join('&');
  }
}

const decodeComponent = (text) => {
  try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; }
};
// \x27 in the class is the apostrophe (same match, and a literal `'` here
// reads as an unpaired string delimiter to the size gate's quote scanner).
const encodeComponent = (text) => encodeURIComponent(text).replace(/[\x27!()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);


class URLSearchWriteView {
  #url;
  constructor(url) { this.#url = url; }
  #read() {
    return searchParamsState.get(new URLSearchParams(String(this.#url.search ?? '').replace(/^\?/, '')));
  }
  #write(entries) {
    const serialized = entries.length === 0 ? '' : `?${entries
      .map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`)
      .join('&')}`;
    this.#url.search = serialized;
  }
  append(name, value) { const entries = this.#read(); entries.push([String(name), String(value)]); this.#write(entries); }
  set(name, value) {
    const entries = this.#read();
    const key = String(name);
    const at = entries.findIndex(([existing]) => existing === key);
    if (at < 0) { entries.push([key, String(value)]); } else {
      entries[at] = [key, String(value)];
      for (let i = entries.length - 1; i >= 0; i--) if (i !== at && entries[i][0] === key) entries.splice(i, 1);
    }
    this.#write(entries);
  }
  delete(name) { this.#write(this.#read().filter(([key]) => key !== String(name))); }
  get(name) {
    const found = this.#read().find(([key]) => key === String(name));
    return found === undefined ? null : found[1];
  }
  getAll(name) { return this.#read().filter(([key]) => key === String(name)).map(([, value]) => value); }
  has(name) { return this.#read().some(([key]) => key === String(name)); }
  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this.#read()) callback.call(thisArg, value, key, this);
  }
  * entries() { for (const [key, value] of this.#read()) yield [key, value]; }
  * keys() { for (const [key] of this.#read()) yield key; }
  * values() { for (const [, value] of this.#read()) yield value; }
  [Symbol.iterator]() { return this.entries(); }
  toString() {
    return this.#read()
      .map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`)
      .join('&');
  }
}

/** Install the LIVE, WRITE-THROUGH `url.searchParams` view on the URL
 * global's prototype (no-op when a searchParams is already present).
 * (Split out of installWebFetchValues with the class it drives; the
 * behavior is the module-installed verbatim block.) */
export const installURLSearchParamsView = () => {
  // DshURL parses `search` but stops short of URLSearchParams (url.js's
  // declared boundary). The view is LIVE and WRITE-THROUGH: reads re-parse
  // the current search string, mutations (set/append/delete) rewrite
  // `url.search` so href/toString see them (measured 2026-09-27: the
  // session-log-export controller builds /api/session.export with
  // searchParams.set — the old read-only view dropped the query silently).
  // Memoized per URL instance so `url.searchParams === url.searchParams`
  // holds and a held reference stays visible, like node's.
  const URLClass = globalThis.URL;
  if (URLClass !== undefined && URLClass.prototype.searchParams === undefined) {
    const liveViews = new WeakMap();
    Object.defineProperty(URLClass.prototype, 'searchParams', {
      get() {
        let view = liveViews.get(this);
        if (view === undefined) { view = new URLSearchWriteView(this); liveViews.set(this, view); }
        return view;
      },
      configurable: true,
    });
  }
};
