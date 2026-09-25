// dsh:logging-exempt (shim layer)
/**
 * node:events shim — the EventEmitter face the vendored packages link
 * against (ssh/subprocess/session/client/sdk families; the upstream-suite
 * growth round made the demand loud: ~26 specs failed to load without it).
 *
 * Covers (upstream usage → this module):
 *   - EventEmitter: on/addListener, once, off/removeListener, removeAll-
 *     Listeners, emit (returns whether any listener ran), listenerCount,
 *     listeners, rawListeners, eventNames, set/getMaxListeners,
 *     prependListener/prependOnce, and node's `error` special case (an
 *     emitted error with no error listener throws — never swallowed).
 *   - once(emitter, name[, {signal}]) → promise; resolves with the single
 *     arg, or the args array when the listener fired with several; rejects
 *     on 'error' and on abort.
 *   - getEventListeners(emitter, name) / listenerCount(emitter, name) —
 *     EventEmitter instances only (an EventTarget's listener list has no
 *     inspectable surface here; that fails loud).
 *
 * NOT supported: the async iterator `events.on(...)`, captureRejections,
 * EventEmitterAsyncResource — no upstream import in this closure reaches
 * them; adding seams nobody imports would be untestable surface.
 */

const defaultMaxListeners = 10;

const wrapOnce = (emitter, name, listener) => {
  const state = { fired: false, wrapped: undefined };
  function wrapped(...args) {
    if (state.fired) return;
    state.fired = true;
    emitter.removeListener(name, wrapped);
    listener.apply(emitter, args);
  }
  wrapped.listener = listener;
  state.wrapped = wrapped;
  return wrapped;
};

export class EventEmitter {
  constructor() {
    this._events = new Map();
    this._maxListeners = undefined;
  }

  setMaxListeners(n) {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
      throw new RangeError(`node:events.setMaxListeners: n must be a non-negative number, got ${String(n)}`);
    }
    this._maxListeners = n;
    return this;
  }

  getMaxListeners() {
    return this._maxListeners ?? defaultMaxListeners;
  }

  _listenersOf(name, copy) {
    let list = this._events.get(name);
    if (list === undefined) {
      list = [];
      this._events.set(name, list);
    } else if (copy) {
      list = list.slice();
    }
    return list;
  }

  _add(name, listener, prepend, wrapped) {
    if (typeof listener !== 'function') {
      throw new TypeError(`node:events: listener for '${String(name)}' must be a function, got ${typeof listener}`);
    }
    const added = wrapped ?? listener;
    // node emits the newListener meta event before the add, but only when
    // someone actually listens for it (recursion-safe by construction).
    if (this._events.get('newListener')?.length) {
      this.emit('newListener', name, added.listener ?? added);
    }
    const existing = this._listenersOf(name, false);
    if (prepend) existing.unshift(added);
    else existing.push(added);
    const cap = this.getMaxListeners();
    if (cap > 0 && existing.length > cap) {
      // node prints a process warning here; the runtime has no warning
      // channel — the over-limit addition itself stays legal.
    }
    return this;
  }

  on(name, listener) { return this._add(name, listener, false); }
  addListener(name, listener) { return this._add(name, listener, false); }
  prependListener(name, listener) { return this._add(name, listener, true); }

  once(name, listener) {
    return this._add(name, listener, false, wrapOnce(this, name, listener));
  }

  prependOnce(name, listener) {
    return this._add(name, listener, true, wrapOnce(this, name, listener));
  }

  off(name, listener) { return this.removeListener(name, listener); }

  removeListener(name, listener) {
    const list = this._events.get(name);
    if (list === undefined) return this;
    const at = list.findIndex((entry) => entry === listener
      || (entry !== undefined && entry.listener === listener));
    if (at >= 0) {
      list.splice(at, 1);
      if (list.length === 0) this._events.delete(name);
      this.emit('removeListener', name, listener);
    }
    return this;
  }

  removeAllListeners(name) {
    if (name === undefined) {
      this._events = new Map();
      return this;
    }
    this._events.delete(name);
    return this;
  }

  emit(name, ...args) {
    if (name === 'error' && !this._events.get('error')?.length) {
      const error = args[0];
      throw error instanceof Error ? error
        : new TypeError(`node:events: unhandled 'error' event (${String(error)})`);
    }
    const list = this._events.get(name);
    if (list === undefined || list.length === 0) return false;
    for (const entry of list.slice()) {
      if (typeof entry === 'function') entry.apply(this, args);
      else if (entry && typeof entry.apply === 'function') entry.apply(this, args);
    }
    return true;
  }

  listenerCount(name) {
    return this._events.get(name)?.length ?? 0;
  }

  listeners(name) {
    return this._listenersOf(name, true).map((entry) => entry?.listener ?? entry);
  }

  rawListeners(name) {
    return this._listenersOf(name, true);
  }

  eventNames() {
    return [...this._events.keys()].filter((name) => this._events.get(name).length > 0);
  }
}

/** events.once: the promise form of one-shot observation. */
export const once = (emitter, name, options = {}) => new Promise((resolve, reject) => {
  if (options?.signal?.aborted) {
    reject(options.signal.reason ?? new Error('node:events.once: aborted'));
    return;
  }
  const onAbort = () => {
    cleanup();
    reject(options.signal.reason ?? new Error('node:events.once: aborted'));
  };
  const cleanup = () => {
    emitter.removeListener(name, onEvent);
    emitter.removeListener('error', onError);
    options?.signal?.removeEventListener?.('abort', onAbort);
  };
  const onEvent = (...args) => {
    cleanup();
    resolve(args.length <= 1 ? args[0] : args);
  };
  const onError = (error) => {
    cleanup();
    reject(error);
  };
  emitter.on(name, onEvent);
  emitter.once('error', onError);
  options?.signal?.addEventListener?.('abort', onAbort, { once: true });
});

/** events.getEventListeners / events.listenerCount — EventEmitter only. */
export const getEventListeners = (emitter, name) => {
  if (typeof emitter?.listenerCount !== 'function') {
    throw new TypeError('node:events.getEventListeners: only EventEmitter instances are supported (an EventTarget listener list has no inspectable surface in this runtime)');
  }
  return emitter.listeners(name);
};

export const listenerCount = getEventListeners;
export { EventEmitter as default, defaultMaxListeners };
