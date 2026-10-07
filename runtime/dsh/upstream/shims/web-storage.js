// dsh:logging-exempt (shim layer; value class, no logging surface)
/**
 * shims/web-storage.js — the W3C Storage face (localStorage / sessionStorage)
 * the closure's CLIENT modules persist through (terminal bindings, client
 * settings mirrors). In-memory Map backing: the dsh runtime has no origin
 * partition to persist into; what the corpus needs is the API shape — one
 * shared instance per storage face so writes land for later readers (a
 * "reload" is a fresh client instance reading the same storage), key-order
 * `key(index)`, and `Storage.prototype` methods the harness can spy on.
 * Methods throw nothing by themselves; a BLOCKED-storage scenario mocks the
 * prototype face and the client's own try/catch does the absorbing (the
 * session-controller bindings spec's absence test does exactly that).
 */
const storageState = new WeakMap(); // Storage → Map<string, string>

export class Storage {
  constructor() {
    storageState.set(this, new Map());
  }
  #map() {
    const map = storageState.get(this);
    if (map === undefined) throw new TypeError('Storage: receiver is not a Storage instance');
    return map;
  }
  get length() { return this.#map().size; }
  key(index) {
    const keys = [...this.#map().keys()];
    return index >= 0 && index < keys.length ? keys[index] : null;
  }
  getItem(key) {
    const value = this.#map().get(String(key));
    return value === undefined ? null : value;
  }
  setItem(key, value) { this.#map().set(String(key), String(value)); }
  removeItem(key) { this.#map().delete(String(key)); }
  clear() { this.#map().clear(); }
}

/** Install Storage + the two window storage faces, only when absent. */
export const installWebStorage = () => {
  const installed = [];
  if (globalThis.Storage === undefined) {
    globalThis.Storage = Storage;
    installed.push('Storage');
  }
  if (globalThis.localStorage === undefined) {
    globalThis.localStorage = new Storage();
    installed.push('localStorage');
  }
  if (globalThis.sessionStorage === undefined) {
    globalThis.sessionStorage = new Storage();
    installed.push('sessionStorage');
  }
  return installed;
};
