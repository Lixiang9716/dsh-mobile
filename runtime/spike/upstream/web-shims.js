// dsh:logging-exempt (shim layer: it IS the log plumbing's host side)
/**
 * web-shims — the Web-API seams the vendored upstream closure expects from a
 * Node/Chromium host, installed as globals BEFORE any vendored module executes.
 *
 * MUST be the first import of runtime/spike/upstream/boot.js (ESM evaluates
 * dependencies depth-first in import order, so this body runs before every
 * vendored package module).
 *
 * Covers (upstream usage → this module):
 *   - structuredClone           — dsh-session, dsh-system-prompt, dsh-agent-loop,
 *                                 dsh-settings, dsh-session-projection (deep-copy
 *                                 of headers, configs, documents: JSON-safe data,
 *                                 Date, RegExp, Map, Set; cycles preserved;
 *                                 anything else fails loud).
 *   - AbortController/Signal    — dsh-agent-loop phase/factory cancellation,
 *                                 dsh-agent lifecycle (addEventListener/remove-
 *                                 Listener/'abort', throwIfAborted, AbortSignal.any;
 *                                 AbortSignal.timeout needs WALL-CLOCK time —
 *                                 still unsupported (the v1.4.0 timer seam is
 *                                 monotonic scheduling only), fails loud).
 *   - console                   — backstop only; boot.js routes cordis logger
 *                                 output into the unified sink. Forwards into
 *                                 __DSH_LOG_SINK__ (rule 5: no bare console
 *                                 output) under the SAME release policy as the
 *                                 logger: runtime/spike/logger.js owns which
 *                                 levels a release build keeps, and this route
 *                                 honors it instead of writing unconditionally.
 *                                 The level mapping is unchanged (log/info →
 *                                 info, debug/trace → debug, warn → warn,
 *                                 error → error): a release build drops the
 *                                 stripped levels, never warn/error.
 *   - queueMicrotask            — re-wrapped so async-hooks-shim context
 *                                 propagation applies to raw microtask callbacks.
 *   - Buffer                    — the web-boot closure (@deepseek-ai/dsh-
 *                                 client-modules) hashes staged bundle bytes
 *                                 and assembles combo bodies (W-INTEG leg);
 *                                 Uint8Array-backed subset over
 *                                 shims/buffer.js (from/concat/byteLength/
 *                                 isBuffer; utf8/hex/base64 toString).
 *   - URL                       — combo request routing in client-modules'
 *                                 compose loop (pathname/search resolution);
 *                                 special-schemes subset over shims/url.js.
 *
 * Intentionally NOT supported (absent on purpose — an accidental call is a
 * loud ReferenceError, never a silent no-op):
 *   - setTimeout/clearTimeout/setInterval — wall-clock timers; the spike
 *     runtime has no timer seam (a turn-based scenario never needs one).
 *     (v1.4.0: the ambient timer faces now ride upstream/shims/timers.js
 *     over the gateway timer seam — the row below is historical.)
 *   - fetch — only cordis-host-runner (the Node host's runner, replaced here
 *     by boot.js) and unreached zod paths use it.
 *   TextEncoder/TextDecoder left this list with the INTERACTIVE CIRCLE row
 * (the row below): the closure verification behind it named cordis-host-runner
 * and unreached zod paths, and @deepseek-ai/dsh-output-retention (link-time
 * import of dsh-tool-jobs) now builds both at module top.
 */
import { DshBuffer } from 'upstream/shims/buffer.js';
// The timer globals (v1.4.0 seam): the ambient setTimeout/clearTimeout the
// vendored closure calls, mapped onto gateway timerSchedule/timerCancel.
import 'upstream/shims/timers.js';
import { DshURL } from 'upstream/shims/url.js';
// The global TextDecoder IS the class node:util serves — one UTF-8
// implementation (fs-local decodes file text with the same face), never a
// second hand-rolled walk (the sha256.js rule).
import { TextDecoder as DshTextDecoder } from 'upstream/shims/util.js';
import { releaseKeeps } from 'logger.js';

/** The forwarder every console method rides. The release strip is applied
 * HERE, through the logger's shared policy — not by a copy of the flag — so a
 * release build cannot keep this route live while createLogger folds away.
 * The gate is on the level, not on the method: warn/error always reach the
 * sink (a distribution build keeps the critical set), debug/info are dropped. */
const sink = (level, args) => {
  if (!releaseKeeps(level)) return;
  globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
    level,
    module: 'upstream.console',
    message: args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
    }).join(' '),
    data: [],
  }));
};

if (typeof globalThis.console === 'undefined' || globalThis.console === undefined) {
  globalThis.console = {
    log: (...a) => sink('info', a),
    info: (...a) => sink('info', a),
    warn: (...a) => sink('warn', a),
    error: (...a) => sink('error', a),
    debug: (...a) => sink('debug', a),
    trace: (...a) => sink('debug', a),
  };
}

/* ---- Function.prototype.toString (native formatting) ---------------------
 * Upstream validates "intrinsic" constructors by string-comparing their
 * toString against Node's single-line native form (`hasIntrinsicConstructor`
 * in dsh-util-values); quickjs-ng renders the same functions MULTI-line, so
 * every plain-object JSON walk upstream would reject itself. Normalize ONLY
 * native-code renderings to the Node format; JS-authored functions keep
 * returning their source. */
const nativeToString = Function.prototype.toString;
if (Function.prototype.toString !== Function.prototype.__dshNormalizedToString) {
  const nativeRender = /\[\s*native\s*code\]\s*\}\s*$/;
  const normalizedToString = function toString() {
    const rendered = nativeToString.call(this);
    if (typeof this !== 'function' || !nativeRender.test(rendered)) return rendered;
    return `function ${this.name}() { [native code] }`;
  };
  normalizedToString.__dshNormalizedToString = true;
  Function.prototype.toString = normalizedToString;
}

/* ---- structuredClone (JSON-safe superset; fail loud beyond) -------------- */
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (value) => {
    const seen = new Map();
    const clone = (item) => {
      if (item === null || typeof item !== 'object') {
        if (typeof item === 'function' || typeof item === 'symbol') {
          throw new TypeError(`structuredClone: cannot clone ${typeof item}`);
        }
        return item;
      }
      if (seen.has(item)) return seen.get(item);
      if (item instanceof Date) return new Date(item.getTime());
      if (item instanceof RegExp) return new RegExp(item.source, item.flags);
      let out;
      if (item instanceof Map) {
        out = new Map(); seen.set(item, out);
        for (const [k, v] of item) out.set(clone(k), clone(v));
        return out;
      }
      if (item instanceof Set) {
        out = new Set(); seen.set(item, out);
        for (const v of item) out.add(clone(v));
        return out;
      }
      if (Array.isArray(item)) {
        out = []; seen.set(item, out);
        for (let i = 0; i < item.length; i++) out[i] = clone(item[i]);
        return out;
      }
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(
          `structuredClone: unsupported object kind ${item.constructor?.name ?? 'unknown'} (JSON-safe data only)`);
      }
      out = Object.create(proto); seen.set(item, out);
      for (const key of Reflect.ownKeys(item)) out[key] = clone(item[key]);
      return out;
    };
    return clone(value);
  };
}

/* ---- EventTarget / AbortController / AbortSignal -------------------------
 * Hidden state lives in WeakMaps, not `#private` members: quickjs-ng rejects
 * private METHOD declarations, and the shim must stay parseable. */
if (typeof globalThis.AbortController !== 'function') {
  const listenersOf = new WeakMap();

  class DshEventTarget {
    addEventListener(type, listener, options = {}) {
      if (typeof listener !== 'function') return;
      const map = listenersOf.get(this) ?? new Map();
      const list = map.get(type) ?? [];
      map.set(type, [...list, { listener, once: options.once === true }]);
      listenersOf.set(this, map);
    }
    removeEventListener(type, listener) {
      const map = listenersOf.get(this);
      if (!map) return;
      const list = map.get(type);
      if (!list) return;
      map.set(type, list.filter((e) => e.listener !== listener));
    }
    dispatchEvent(type, event) {
      const map = listenersOf.get(this);
      if (!map) return;
      const list = [...(map.get(type) ?? [])];
      map.set(type, list.filter((e) => !e.once));
      for (const { listener } of list) listener(event);
    }
  }

  const asAbortReason = (reason) => {
    if (reason !== undefined) return reason;
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
  };

  const signalState = new WeakMap(); // → { aborted, reason }

  const fireAbort = (signal, reason) => {
    const state = signalState.get(signal);
    if (state.aborted) return;
    state.aborted = true;
    state.reason = asAbortReason(reason);
    signal.dispatchEvent('abort', { type: 'abort', target: signal });
  };

  class DshAbortSignal extends DshEventTarget {
    constructor() {
      super();
      signalState.set(this, { aborted: false, reason: undefined });
    }
    get aborted() { return signalState.get(this)?.aborted === true; }
    get reason() { return signalState.get(this)?.reason; }
    throwIfAborted() {
      if (this.aborted) throw asAbortReason(this.reason);
    }
    static abort(reason) {
      const signal = new DshAbortSignal();
      fireAbort(signal, reason);
      return signal;
    }
    static any(signals) {
      const composite = new DshAbortController();
      for (const signal of signals) {
        if (signal.aborted) {
          composite.abort(signal.reason);
          break;
        }
        signal.addEventListener('abort', () => composite.abort(signal.reason), { once: true });
      }
      return composite.signal;
    }
    static timeout() {
      throw new Error('AbortSignal.timeout: wall-clock timers are not supported by the spike runtime');
    }
  }

  class DshAbortController {
    constructor() {
      this.signalValue = new DshAbortSignal();
    }
    get signal() { return this.signalValue; }
    abort(reason) { fireAbort(this.signalValue, reason); }
  }

  globalThis.AbortController = DshAbortController;
  globalThis.AbortSignal = DshAbortSignal;
}

/* ---- Buffer (byte bridge for the web-boot closure) ----------------------- */
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = DshBuffer;
}

/* ---- URL (combo route resolution for client-modules) --------------------- */
if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = DshURL;
}

/* ---- TextEncoder / TextDecoder (the interactive circle's byte seams) -----
 * The INTERACTIVE CIRCLE row (2026-09-23, the vendored-plugin closure for the
 * "/" surface): @deepseek-ai/dsh-output-retention builds module-level
 * `new TextEncoder()` / `new TextDecoder()` (UTF-8 byte-boundary truncation
 * for tool output) and @deepseek-ai/dsh-tool-jobs imports it at link time, so
 * the globals the old closure verification declared absent are now load-time
 * requirements. The decoder is the node:util shim's class verbatim (utf-8
 * only; any other label stays loud); the encoder is its encode-only twin —
 * surrogate-pair aware, lone surrogates encode as U+FFFD (the Web face's
 * substitution), `encodeInto` never splits a code point and reports the
 * {read, written} split both faces promise. Installed only when absent, so a
 * host that binds them natively keeps its own. */
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = DshTextDecoder;
}
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    static #bytesOf(code, out) {
      if (code <= 0x7f) out.push(code);
      else if (code <= 0x7ff) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code <= 0xffff) {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    static #codePointAt(text, i) {
      // Returns [codePoint, nextIndex]; a lone surrogate yields U+FFFD (the
      // Web face's substitution) and steps past one unit.
      const hi = text.charCodeAt(i);
      if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
        const lo = text.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          return [0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00), i + 2];
        }
      }
      if (hi >= 0xd800 && hi <= 0xdfff) return [0xfffd, i + 1];
      return [hi, i + 1];
    }
    encode(source = '') {
      const text = String(source);
      const out = [];
      for (let i = 0; i < text.length;) {
        const [code, next] = TextEncoder.#codePointAt(text, i);
        TextEncoder.#bytesOf(code, out);
        i = next;
      }
      return Uint8Array.from(out);
    }
    encodeInto(source, destination) {
      if (!(destination instanceof Uint8Array)) {
        throw new TypeError('TextEncoder.encodeInto: destination must be a Uint8Array');
      }
      const text = String(source ?? '');
      let read = 0;
      let written = 0;
      for (let i = 0; i < text.length;) {
        const [code, next] = TextEncoder.#codePointAt(text, i);
        const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        if (written + size > destination.length) break; // never split a code point
        const bytes = [];
        TextEncoder.#bytesOf(code, bytes);
        for (const b of bytes) destination[written++] = b;
        read = next;
        i = next;
      }
      return { read, written };
    }
  };
}

/* ---- window + the registration queue facade ------------------------------
 * The web-boot leg materializes the VENDORED client-modules BROWSER bundle
 * (`lib/client.js`) on the runtime side to validate the composed boot wire
 * with its own `parseBootManifest`. That bundle is a closure factory
 * registering through `window.__ModuleLoader__.load`, so the runtime provides
 * the same queue-mode facade the carrier injects into the page (upstream
 * bootInjections row 1): `load` queues registrations, `create` is the browser
 * bootstrap and stays loud — the spike runtime never boots the module system,
 * it composes the wire that boots it. */
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.window.__ModuleLoader__ === 'undefined') {
  const pendingQueue = [];
  globalThis.window.__ModuleLoader__ = {
    mode: 'queue',
    pendingQueue,
    load(registration) { pendingQueue.push(registration); },
    create() {
      throw new Error('web-shims: __ModuleLoader__.create is the browser bootstrap; '
        + 'the spike runtime composes the boot wire but never boots the client module system');
    },
  };
}

/* ---- queueMicrotask with context capture (pairs with async-hooks shim) ---
 * The wrapper is installed here (before any vendored import) and consults the
 * async-hooks shim's capture helpers at CALL time, so it behaves identically
 * whether or not that module has loaded yet. */
const nativeQueueMicrotask = globalThis.queueMicrotask?.bind(globalThis);
if (typeof nativeQueueMicrotask === 'function') {
  globalThis.queueMicrotask = (fn) => {
    const captured = globalThis.__dshCaptureContext?.();
    nativeQueueMicrotask(() => {
      const run = globalThis.__dshRunWithCapturedContext;
      if (run) run(captured, fn);
      else fn();
    });
  };
}
