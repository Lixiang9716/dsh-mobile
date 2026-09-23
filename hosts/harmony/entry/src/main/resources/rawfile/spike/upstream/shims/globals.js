// dsh:logging-exempt (test-harness globals: installed for side effects)
/**
 * upstream/shims/globals — the WHATWG/engine globals the upstream suite's
 * code paths need and quickjs does not define (AbortController for the
 * agent-loop cancellation path, structuredClone for its state clones).
 * Installed by scenario/upstream-test-harness.js BEFORE any spec imports
 * run, so every host (CLI, iOS, Android, HarmonyOS) gets them from this
 * one file. Extracted from the harness when its size crossed the 500-line
 * file budget (measured 2026-09-23, CI code-size).
 */
// cancellation path needs (signal.aborted, addEventListener('abort'),
// abort(reason), throwIfAborted). The suite's largest single gap before
// this shim: every agent-loop cancel test failed on the missing global,
// identically on the CLI host and the iOS simulator (the harness is the
// shared injection point, so every host gets it from this one file).
// Listeners fire synchronously; reason defaults to the standard abort
// error; a second abort() is a no-op.
if (typeof globalThis.AbortController === 'undefined') {
  const fire = (signal) => {
    if (signal.aborted) return;
    signal._aborted = true;
    signal._reason = signal._reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    for (const fn of [...signal._listeners]) {
      try { fn({ type: 'abort', target: signal }); } catch { /* one listener's throw must not break the rest */ }
    }
  };
  class AbortSignalShim {
    constructor() {
      this._aborted = false;
      this._reason = undefined;
      this._listeners = [];
      this.onabort = null;
    }
    get aborted() { return this._aborted; }
    get reason() { return this._reason; }
    addEventListener(type, fn) {
      if (type === 'abort' && typeof fn === 'function' && !this._listeners.includes(fn)) {
        this._listeners.push(fn);
      }
    }
    removeEventListener(type, fn) {
      if (type === 'abort') this._listeners = this._listeners.filter((f) => f !== fn);
    }
    throwIfAborted() {
      if (this._aborted) throw this._reason;
    }
  }
  class AbortControllerShim {
    constructor() { this.signal = new AbortSignalShim(); }
    abort(reason) {
      this.signal._reason = reason;
      fire(this.signal);
      if (typeof this.signal.onabort === 'function') this.signal.onabort({ type: 'abort', target: this.signal });
    }
  }
  globalThis.AbortController = AbortControllerShim;
  globalThis.AbortSignal = AbortSignalShim;
}

// structuredClone — the spine clones JSON-safe session state (config-derived
// agent records, headers). The honest subset: primitives pass through, JSON
// data deep-clones through a stringify round trip (which itself throws on
// cycles — never a silent shallow copy); functions and symbols fail loud.
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = (value) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (typeof value === 'function') throw new Error('structuredClone: functions cannot be cloned');
    return JSON.parse(JSON.stringify(value));
  };
}

