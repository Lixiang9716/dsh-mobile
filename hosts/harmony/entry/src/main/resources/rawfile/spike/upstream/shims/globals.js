// dsh:logging-exempt (test-harness globals: installed for side effects)
import proc from './process.js';
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


// The ambient `process` global — the vendored jsonl backend reads bare
// `process.platform` at module top level WITHOUT importing node:process,
// so the facade must exist before that module evaluates; the harness's own
// import chain (this file) runs first. posix platform: the win32 limbs
// stay dead code.
if (globalThis.process === undefined) {
  // The FULL process face (the node:process shim's default), not a
  // hand-rolled subset: cordis-plugin-loader probes process.versions.node
  // and process.execArgv on import, and a partial global crashed those
  // specs (growth round 3).
  globalThis.process = proc;
}

// TextEncoder/TextDecoder — the jsonl backend's UTF-8 faces. quickjs ships
// no Web encoders; btoa/atob handle binary strings, and the UTF-8 bridge
// below rides them (code-point by code-point for encode; decode walks the
// byte string). Covers the corpus's ASCII-and-UTF8 log payloads honestly.
if (globalThis.TextEncoder === undefined) {
  globalThis.TextEncoder = class TextEncoder {
    encode(input = '') {
      const text = String(input);
      const out = [];
      for (let i = 0; i < text.length; i++) {
        let code = text.codePointAt(i);
        if (code > 0xffff) i++;
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
      return new Uint8Array(out);
    }
  };
}
if (globalThis.TextDecoder === undefined) {
  globalThis.TextDecoder = class TextDecoder {
    decode(bytes = new Uint8Array(0)) {
      let out = '';
      let i = 0;
      const push = (cp) => { out += String.fromCodePoint(cp); };
      while (i < bytes.length) {
        const b = bytes[i];
        if (b < 0x80) { push(b); i += 1; }
        else if (b < 0xe0) { push(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
        else if (b < 0xf0) { push(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
        else { push(((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)); i += 4; }
      }
      return out;
    }
  };
}
