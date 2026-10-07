// dsh:logging-exempt (test-harness globals: installed for side effects)
import proc from './process.js';
import { defineRuntimeModules } from './runtime-modules.js';
import {
  ReadableStream, WritableStream, TransformStream, DecompressionStream,
  Response, TextDecoderStream, TextEncoderStream,
} from './web-streams.js';
import {
  Event,
  EventTarget,
  CustomEvent,
  MessageEvent,
  ErrorEvent,
  CloseEvent,
} from './web-event.js';
import { DshURL } from './url.js';
/**
 * upstream/shims/globals — the WHATWG/engine globals the upstream suite's
 * code paths need and quickjs does not define (AbortController for the
 * agent-loop cancellation path, structuredClone for its state clones).
 * Installed by scenario/upstream-test-harness.js BEFORE any spec imports
 * run, so every host (CLI, iOS, Android, HarmonyOS) gets them from this one
 * file. Extracted from the harness at the 2026-09-23 code-size gate.
 */
// The runtime-module registrations (node:string_decoder, node:stream/
// promises, the package shim faces) must land before the FIRST spec import:
// ESM links statically, so a specifier registered late still fails its link.
// This file is the harness's first import — the same property the globals
// themselves rely on.
defineRuntimeModules();

// WHATWG streams/response — the web-adjacent faces use them as bare globals
// (ReadableStream for the SSE decoders; TransformStream/DecompressionStream/
// Response for the image loader's pipe chain) sit behind any host binding
// (the web-shims.js rule).
if (typeof globalThis.ReadableStream === 'undefined') globalThis.ReadableStream = ReadableStream;
if (typeof globalThis.WritableStream === 'undefined') globalThis.WritableStream = WritableStream;
if (typeof globalThis.TransformStream === 'undefined') globalThis.TransformStream = TransformStream;
if (typeof globalThis.DecompressionStream === 'undefined') globalThis.DecompressionStream = DecompressionStream;
if (typeof globalThis.Response === 'undefined') globalThis.Response = Response;
if (typeof globalThis.TextDecoderStream === 'undefined') globalThis.TextDecoderStream = TextDecoderStream;
if (typeof globalThis.TextEncoderStream === 'undefined') globalThis.TextEncoderStream = TextEncoderStream;
// The DOM event primitives — eventsource@3.0.7's EventSource, the inspector
// hosts, and the MCP client faces `extends EventTarget` / `new Event(...)`
// at module-definition time, so they must exist before the first spec import
// (the same link-time property the streams above serve).
if (typeof globalThis.Event === 'undefined') globalThis.Event = Event;
if (typeof globalThis.EventTarget === 'undefined') globalThis.EventTarget = EventTarget;
if (typeof globalThis.CustomEvent === 'undefined') globalThis.CustomEvent = CustomEvent;
if (typeof globalThis.MessageEvent === 'undefined') globalThis.MessageEvent = MessageEvent;
if (typeof globalThis.ErrorEvent === 'undefined') globalThis.ErrorEvent = ErrorEvent;
if (typeof globalThis.CloseEvent === 'undefined') globalThis.CloseEvent = CloseEvent;
// The URL face — the http-proxy policy reader calls the WHATWG static
// `URL.parse` and the eventsource faces construct `new URL(...)` as a bare
// global (quickjs defines none). The node:url shim's class IS the URL here.
if (typeof globalThis.URL === 'undefined') globalThis.URL = DshURL;
// The minimal DOM + location/history/FormData faces (shims/web-dom.js) — the
// webworker-runtime client specs drive a real DOM through the product's
// chooser/script-injection paths, and nothing upstream of the suite defines
// these on a headless host (R3-G1, 2026-09-28). Installed at the top of this
// file's import chain so the faces precede the first spec import (the
// source-chooser spec touches document in beforeEach). The fetch-values
// install must run AFTER it (W3-K, 2026-09-28): web-dom's FormData is a
// marked fallback and the full W3C face supersedes it — in the suite leg's
// import order (web-shims first, globals second) the fallback otherwise
// outlives the full install and file-store's form.set regressed to "not a
// function".
import { installWebDom } from './web-dom.js';
import { installWebFetchValues } from './web-fetch-values.js';
installWebDom();
installWebFetchValues();
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
  // AbortSignal.any — the composite face the vendored adapters build their
  // caller+internal cancellation on (measured 2026-09-28: llm-deepseek's
  // generate() combines the caller signal with its consumer-stop controller
  // through AbortSignal.any; its absence hung the adapter's abort test).
  // The first source to abort wins with ITS reason (node's contract); a
  // source already aborted at composition time aborts the composite
  // immediately.
  AbortSignalShim.any = function (signals) {
    const compositeController = new AbortControllerShim();
    for (const signal of signals ?? []) {
      if (signal.aborted) {
        compositeController.abort(signal.reason);
        break;
      }
      signal.addEventListener('abort', () => compositeController.abort(signal.reason));
    }
    return compositeController.signal;
  };
  // AbortSignal.abort — an already-aborted signal (node 17.2+).
  AbortSignalShim.abort = function (reason) {
    const controller = new AbortControllerShim();
    controller.abort(reason);
    return controller.signal;
  };
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

// String.prototype.localeCompare — quickjs compares code units and ignores
// the locale/options arguments. Node (ICU) honors `{ numeric: true }`, whose
// one measured consumer is open-in-app's versioned-install scan: '2024.1.10'
// must outrank '2024.1.9' (plain lexicographic puts '9' after '1'). The face
// implements the NUMERIC chunk compare (digit runs compare by value) and
// falls back to the code-unit comparison otherwise — no ICU data is consulted
// for any other option, matching what the engine already did (W4-M,
// 2026-09-28).
if (typeof String.prototype.localeCompare === 'undefined'
  || '2024.1.10'.localeCompare('2024.1.9', 'en', { numeric: true }) < 0) {
  const chunkRe = /(\d+|\D+)/g;
  const chunksOf = (text) => String(text).match(chunkRe) ?? [];
  const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const numericCompare = (a, b) => {
    const left = chunksOf(a);
    const right = chunksOf(b);
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i++) {
      const l = left[i];
      const r = right[i];
      const bothDigits = /^\d/.test(l) && /^\d/.test(r);
      const order = bothDigits
        ? (Number(l) - Number(r)) || codeUnitCompare(l, r)
        : codeUnitCompare(l, r);
      if (order !== 0) return order;
    }
    return left.length - right.length;
  };
  Object.defineProperty(String.prototype, 'localeCompare', {
    value(that, _locales, options) {
      const numeric = options?.numeric === true || options?.numeric === 'true';
      return numeric ? numericCompare(this, that) : codeUnitCompare(this, String(that));
    },
    writable: true,
    configurable: true,
  });
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
      if (bytes !== null && typeof bytes === 'object' && ArrayBuffer.isView(bytes)) {
        bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
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

// Timer globals (2026-09-27 suite round, the webworker-runtime polyfill
// handoff): the vendored closure's src/node/globals/timers.ts BINDS
// globalThis.setTimeout/setInterval at module init, and the als-shim spec
// wraps the ambient faces to exercise async-context propagation — so the
// faces must exist before the first spec import. The suite's vendored
// closures need SCHEDULING, not wall-clock (the runtime has no clock seam;
// a gateway timer primitive is a product-boot decision, not a harness one),
// so setTimeout schedules on the MICROTASK queue: every await delay()
// resolves promptly, which is the only timing the corpus asserts.
// setInterval exists so vendored installers can BIND it, but arming one
// fails loud — contract v1.4.0 is one-shot (a microtask interval would
// starve the loop it schedules on). ??= keeps any future real binding in
// charge.
if (typeof globalThis.setTimeout === 'undefined') {
  const pendingTimers = new Map();
  let nextTimerId = 1;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = nextTimerId += 1;
    pendingTimers.set(id, () => {
      pendingTimers.delete(id);
      if (typeof fn === 'function') fn(...args);
    });
    queueMicrotask(() => pendingTimers.get(id)?.());
    return id;
  };
  globalThis.clearTimeout = (id) => { pendingTimers.delete(Number(id)); };
  globalThis.setInterval = () => {
    throw new Error('setInterval: not served in this runtime — the gateway timer contract is one-shot (v1.4.0); use a setTimeout re-arm loop');
  };
  globalThis.clearInterval = () => {};
}

// V8-shaped Error stacks — measured 2026-09-27 (ptc-runtime-node bootstrap):
// quickjs's native `stack` accessor (a) returns FRAMES ONLY, without the
// `Name: message` header line V8 puts first, and (b) ignores assignments
// (`e.stack = undefined` keeps the accessor), so vendored code following the
// Node idiom `error.stack ?? error.message` rendered frames without the
// message. Wrap the native accessor: an own data property (assigned stack)
// wins; otherwise the native frames get the header prepended. The traceback
// capture itself stays the engine's.
(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
  if (!descriptor || typeof descriptor.get !== 'function' || !descriptor.configurable) return;
  const nativeGet = descriptor.get;
  Object.defineProperty(Error.prototype, 'stack', {
    configurable: true,
    enumerable: false,
    get() {
      const own = Object.getOwnPropertyDescriptor(this, 'stack');
      if (own !== undefined && 'value' in own) return own.value;
      const frames = nativeGet.call(this);
      let name; let message;
      try { name = this.name; } catch { name = 'Error'; }
      try { message = this.message; } catch { message = undefined; }
      const header = message === undefined || message === ''
        ? String(name ?? 'Error')
        : `${String(name ?? 'Error')}: ${String(message)}`;
      return typeof frames === 'string' && frames.length > 0 ? `${header}\n${frames}` : header;
    },
    set(value) {
      Object.defineProperty(this, 'stack', {
        value, writable: true, configurable: true, enumerable: false,
      });
    },
  });
})();

// Bounded Intl.DateTimeFormat — quickjs builds without ICU expose NO Intl
// global, and the vendored schedule domain canonicalizes IANA zones and
// resolves local-at instants through Intl.formatToParts + resolvedOptions
// (measured 2026-09-27). This shim serves exactly that contract over a small
// embedded zone table: UTC, the US DST rule (2nd Sunday March 07:00Z → 1st
// Sunday November 06:00Z), the EU rule (last Sunday March 01:00Z → last
// Sunday October 01:00Z), and fixed-offset zones. Unknown zones throw
// RangeError — Intl's own invalid-timezone behavior, which the vendored code
// classifies. Honest bound: a deployment zone outside the table fails loud
// naming the shim, not silently wrong.
if (globalThis.Intl === undefined) {
  const US_DST = { rule: 'us', std: -5 * 3600000, dst: -4 * 3600000 };
  const EU_DST = { rule: 'eu', std: 0 * 3600000, dst: 3600000 };
  const zoneTable = {
    UTC: { fixed: 0 },
    Etc: null, // placeholder replaced below (table is path→entry, flat keys with '/')
    'America/New_York': US_DST,
    'US/Eastern': US_DST,
    'America/Chicago': { rule: 'us', std: -6 * 3600000, dst: -5 * 3600000 },
    'America/Denver': { rule: 'us', std: -7 * 3600000, dst: -6 * 3600000 },
    'America/Los_Angeles': { rule: 'us', std: -8 * 3600000, dst: -7 * 3600000 },
    'Europe/London': EU_DST,
    'Europe/Paris': { rule: 'eu', std: 3600000, dst: 2 * 3600000 },
    'Europe/Berlin': { rule: 'eu', std: 3600000, dst: 2 * 3600000 },
    'Asia/Shanghai': { fixed: 8 * 3600000 },
    'Asia/Tokyo': { fixed: 9 * 3600000 },
    'Asia/Kolkata': { fixed: 5.5 * 3600000 },
    // Aliases resolve to their canonical IANA spelling through resolvedOptions
    // (Intl behavior; the schedule suite asserts US/Eastern → America/New_York).
    'Asia/Calcutta': { fixed: 5.5 * 3600000, canonical: 'Asia/Kolkata' },
    'US/Eastern': { ...US_DST, canonical: 'America/New_York' },
    // ICU accepts Etc/UTC and canonicalizes to UTC (node: resolvedOptions on
    // Etc/UTC reads 'UTC') — request-zone asserts the canonicalization
    // refusal, not an unsupported-zone rejection (R3-D, 2026-09-27).
    'Etc/UTC': { fixed: 0, canonical: 'UTC' },
  };
  delete zoneTable.Etc;
  const ZONE_ALIAS = { 'US/Eastern': 'America/New_York', 'Asia/Calcutta': 'Asia/Kolkata', 'Etc/UTC': 'UTC' };

  const nthSundayUtcMs = (year, monthIndex, nth) => {
    // UTC midnight of the nth Sunday of a month (nth from 1; -1 = last).
    const first = Date.UTC(year, monthIndex, 1);
    const offsetToSunday = (7 - new Date(first).getUTCDay()) % 7;
    const day = nth === -1
      ? new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate() - ((new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDay()) % 7)
      : 1 + offsetToSunday + (nth - 1) * 7;
    return Date.UTC(year, monthIndex, day);
  };

  const offsetFor = (entry, epochMs) => {
    if (entry.fixed !== undefined) return entry.fixed;
    const probe = new Date(epochMs);
    const year = probe.getUTCFullYear();
    if (entry.rule === 'us') {
      // Local-standard 2:00 maps to 2:00 - std in UTC (std negative in the US
      // ⇒ 07:00Z for Eastern); the end transition is 2:00 local DST = 06:00Z.
      const usStart = nthSundayUtcMs(year, 2, 2) - entry.std + 2 * 3600000;
      const usEnd = nthSundayUtcMs(year, 10, 1) - entry.dst + 2 * 3600000;
      return epochMs >= usStart && epochMs < usEnd ? entry.dst : entry.std;
    }
    // EU rule: transitions at 01:00 UTC by definition.
    const euStart = nthSundayUtcMs(year, 2, -1) + 3600000;
    const euEnd = nthSundayUtcMs(year, 9, -1) + 3600000;
    return epochMs >= euStart && epochMs < euEnd ? entry.dst : entry.std;
  };

  const pad = (n, width) => String(Math.abs(n)).padStart(width, '0');
  const civilFromMs = (ms) => {
    // Hinnant's civil_from_days over the shifted local time.
    const days = Math.floor(ms / 86400000);
    const rem = ms - days * 86400000;
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return {
      year: month <= 2 ? y + 1 : y, month, day,
      hour: Math.floor(rem / 3600000),
      minute: Math.floor((rem % 3600000) / 60000),
      second: Math.floor((rem % 60000) / 1000),
      millisecond: rem % 1000,
    };
  };

  globalThis.Intl = {
    DateTimeFormat: class DateTimeFormat {
      constructor(localeIgnored, options = {}) {
        const zone = options.timeZone === undefined ? 'UTC' : options.timeZone;
        const key = Object.prototype.hasOwnProperty.call(zoneTable, zone) ? zone : undefined;
        if (key === undefined) {
          throw new RangeError(`Intl.DateTimeFormat: time zone '${zone}' is outside the dsh zone table`);
        }
        this.zone = ZONE_ALIAS[key] ?? key;
        this.options = { ...options, timeZone: this.zone };
      }
      resolvedOptions() {
        return { locale: 'en-US', ...this.options, timeZone: this.zone };
      }
      formatToParts(epochMs) {
        const entry = zoneTable[this.zone];
        const offset = offsetFor(entry, Number(epochMs));
        const c = civilFromMs(Number(epochMs) + offset);
        const sign = offset < 0 ? '-' : offset > 0 ? '+' : undefined;
        const zoneName = sign === undefined
          ? 'GMT'
          : `GMT${sign}${pad(Math.floor(Math.abs(offset) / 3600000), 2)}:${pad(Math.floor(Math.abs(offset) % 3600000 / 60000), 2)}`;
        return [
          { type: 'year', value: pad(c.year, 4) },
          { type: 'month', value: pad(c.month, 2) },
          { type: 'day', value: pad(c.day, 2) },
          { type: 'hour', value: pad(c.hour, 2) },
          { type: 'minute', value: pad(c.minute, 2) },
          { type: 'second', value: pad(c.second, 2) },
          { type: 'fractionalSecond', value: pad(c.millisecond, 3) },
          { type: 'timeZoneName', value: zoneName },
          { type: 'literal', value: '' },
        ];
      }
      format(epochMs) {
        return this.formatToParts(epochMs).map((p) => p.value).join('');
      }
    },
  };
}

// Promise.withResolvers — ES2025; quickjs does not ship it and the vendored
// session-query tests (and increasingly the closure) use it as the promise
// handle idiom (measured 2026-09-27: tool-session-query deadline test).
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve; let reject;
    const promise = new this((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

// DOMException — the web error class the closure's abort/error classifiers
// test against (`error instanceof DOMException`); quickjs does not define it
// (measured 2026-09-27: web-search providers classify fetch aborts).
if (globalThis.DOMException === undefined) {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message = '', name = 'Error') {
      super(message);
      this.name = name;
    }
    static get INDEX_SIZE_ERR() { return 1; }
    static get ABORT_ERR() { return 20; }
  };
}

// HTMLAnchorElement + document.createElement('a') — the browser download
// gesture face: the session-log-export controller hands a Host URL to
// `document.createElement('a')` and clicks it (measured 2026-09-27,
// controller.client.spec spies HTMLAnchorElement.prototype.click). The
// minimal honest surface: a real class (prototype spyable), href/download
// properties, a no-op click (this runtime has no navigation seam); every
// OTHER tag fails loud — the dsh serves no general DOM.
if (globalThis.HTMLAnchorElement === undefined) {
  globalThis.HTMLAnchorElement = class HTMLAnchorElement {
    constructor() {
      this.href = '';
      this.download = '';
    }
    click() { /* no navigation seam in the dsh runtime */ }
  };
}
if (globalThis.document === undefined) {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'a') return new globalThis.HTMLAnchorElement();
      throw new Error(`document.createElement('${String(tag)}'): not served in this runtime — the dsh serves only the anchor download gesture`);
    },
  };
}
