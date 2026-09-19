/**
 * dsh-subprocess-quickjs — system implementation plugin for the `subprocess`
 * service (M2 v0): the in-process coroutine executor. Upstream `ctx.subprocess`
 * is an abstract Service whose `spawn` this implements — NO real OS processes,
 * NO subprocesses, NO threads (ARCHITECTURE.md §6): a task is a list of JS
 * work-unit steps executed serially on the runtime queue (one microtask chain
 * on the single JS thread).
 *
 * Event-driven only (D8): spawn returns a handle immediately; progress and
 * completion arrive as events on the handle. There is NO blocking
 * whole-result API — `handle.done` is a promise DERIVED from the 'complete'
 * event, never a synchronous wait.
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.subprocess');

/** The static manifest this plugin installs under (schemaVersion 1). */
export const manifest = {
  schemaVersion: 1,
  id: 'dsh-subprocess-quickjs',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: [], optional: [] },
  hooks: { activate: 'activate' },
};

/** One task handle: event subscription plus the event-derived settle promise. */
const makeHandle = (id) => {
  log.debug('handle created', { id });
  const listeners = new Map();
  const on = (event, fn) => {
    log.debug('subscribe', { id, event });
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  };
  const emit = (event, fields) => {
    log.debug('handle event', { id, event, ...fields });
    (listeners.get(event) ?? new Set()).forEach((fn) => fn({ id, event, ...fields }));
  };
  return { id, on, emit };
};

/** Serial step runner — the whole task lives on the runtime queue. */
const run = async (handle, spec) => {
  await null; // spawn returns first; every step runs on a later tick
  log.debug('task started', { id: handle.id, steps: spec.steps.length });
  handle.emit('started', { steps: spec.steps.length });
  const ctx = { ...(spec.context ?? {}), report: (label) => handle.emit('progress', { label }) };
  let result;
  try {
    for (let step = 0; step < spec.steps.length; step++) {
      log.debug('step begin', { id: handle.id, step: step + 1 });
      result = await spec.steps[step](ctx);
      handle.emit('progress', { step: step + 1, of: spec.steps.length });
    }
    handle.emit('complete', { ok: true, result });
  } catch (err) {
    log.warn('task failed', { id: handle.id, message: err?.message });
    handle.emit('complete', { ok: false, error: String(err?.message ?? err) });
  }
};

/** Activation hook (manifest.hooks.activate): registers the `subprocess` service. */
export function activate({ register }) {
  log.debug('activating dsh-subprocess-quickjs');
  let nextId = 1;

  /** spawn({id?, steps, context?}) → handle. Steps are async (ctx) → value;
   * context is the caller-provided service bag handed to every step. */
  const spawn = (spec) => {
    const id = spec.id ?? `task-${nextId}`;
    nextId += 1;
    log.debug('spawn', { id, steps: spec.steps.length });
    if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
      throw new Error('subprocess.spawn needs a non-empty steps array');
    }
    const handle = makeHandle(id);
    let settle;
    const done = new Promise((resolve) => (settle = resolve));
    handle.on('complete', (ev) => {
      log.debug('complete observed', { id, ok: ev.ok });
      settle(ev);
    });
    run(handle, spec); // serial microtask chain on the runtime queue
    return { id, on: handle.on, done };
  };

  register('subprocess', { spawn });
}
