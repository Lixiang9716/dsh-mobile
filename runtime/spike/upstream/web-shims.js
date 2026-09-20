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
 *                                 AbortSignal.timeout needs wall-clock timers —
 *                                 NOT supported by the spike runtime, fails loud).
 *   - console                   — backstop only; boot.js routes cordis logger
 *                                 output into the unified sink. Forwards into
 *                                 __DSH_LOG_SINK__ (rule 5: no bare console output).
 *   - queueMicrotask            — re-wrapped so async-hooks-shim context
 *                                 propagation applies to raw microtask callbacks.
 *
 * Intentionally NOT supported (absent on purpose — an accidental call is a
 * loud ReferenceError, never a silent no-op):
 *   - setTimeout/clearTimeout/setInterval — wall-clock timers; the spike
 *     runtime has no timer seam (a turn-based scenario never needs one).
 *   - fetch/TextEncoder/TextDecoder/Buffer — only cordis-host-runner (the Node
 *     host's runner, replaced here by boot.js) and unreached zod paths use them.
 */
const sink = (level, args) => {
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
