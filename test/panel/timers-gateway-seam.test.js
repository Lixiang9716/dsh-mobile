import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loop-z2: the DEVICE timer seam the read-idle watchdog rides. The read-idle
// suite (llm-transport-read-idle.test.js) drives the guard over NODE's
// setTimeout; the serving seat's setTimeout is upstream/shims/timers.js's
// mapping onto the gateway timerSchedule/timerCancel pair whose fire arrives
// as a `timer.fire` bridge event (contract v1.4.0). That indirection is where
// the battery-r16 black hole lived: the Android serving seat REGISTERED the
// timer primitive but never wired its fire channel (SessionServe.kt —
// SpikeHostM4.kt:352 did), so every fire died inside TimerPrimitive's
// `emitFn?.invoke` — the loop-u2 watchdog armed at the first streamed chunk
// and NEVER fired (zero telemetry 120-330s), the retry's own 1s backoff never
// advanced (banner frozen at "1/5 · 1s" for 8.5+ min), and only a manual
// cancel unwound the turn.
//
// These tests pin the JS half of that seam over a mocked gateway.js: the arm
// rides timerSchedule with the caller's delay intact, the callback runs ONLY
// when the fire event lands, cancel wins both races, node's delay coercion
// holds — and, the part that made r16 diagnosable only by a 6-hour battery
// probe, an arm the host refuses now reports loud through the sink instead
// of starving silently (iOS/harmony deny timerSchedule today).

const state = vi.hoisted(() => ({
  /** Every timerSchedule arm: { delayMs, tag } in arm order. */
  scheduled: [],
  /** The settled arm promises (await one to run armTimer's continuation). */
  armPromises: [],
  /** The onEvent listeners timers.js registered (the §5 fire channel). */
  fireListeners: [],
  /** The timerCancel calls: timerIds. */
  cancels: [],
  /** When non-null, timerSchedule rejects with this shape. */
  armFailure: null,
}));

vi.mock('gateway.js', () => ({
  timerSchedule: vi.fn((delayMs, opts = {}) => {
    if (state.armFailure !== null) return Promise.reject(state.armFailure);
    state.scheduled.push({ delayMs, tag: opts.tag });
    const arm = Promise.resolve({ timerId: state.scheduled.length });
    state.armPromises.push(arm);
    return arm;
  }),
  timerCancel: vi.fn((timerId) => {
    state.cancels.push(timerId);
    return Promise.resolve({ cancelled: true });
  }),
  onEvent: vi.fn((fn) => {
    state.fireListeners.push(fn);
    return () => {};
  }),
}));

// The engine's async-context slot (the quickjs-ng fork's dsh-async-context)
// has no Node face; a plain variable is the honest stand-in — the shim only
// reads frames through the getter and copy-on-writes through the setter.
let asyncSlot;
globalThis.__asyncContextGet = () => asyncSlot;
globalThis.__asyncContextSet = (value) => { asyncSlot = value; };

await import('upstream/shims/timers.js');

const { DEFAULT_READ_IDLE_TIMEOUT_MS } = await import(
  '../../runtime/dsh/upstream/llm-read-idle.js');

/** The bridge fire: what TimerPrimitive's emitFn hands the runtime on the
 * serving seat — the exact event the unwired seat never delivered. */
const fire = (timerId) => {
  for (const listener of state.fireListeners) listener({ event: 'timer.fire', timerId });
};

/** Settle the last arm's continuation (armTimer registered its await before
 * the test's, so one await on the arm promise orders after it). */
const settleArm = async () => {
  await state.armPromises.at(-1);
  await Promise.resolve();
};

const sink = [];
const realSink = globalThis.__DSH_LOG_SINK__;

beforeEach(() => {
  state.scheduled.length = 0;
  state.armPromises.length = 0;
  // fireListeners stays: timers.js registers its §5 handler ONCE at module
  // load — clearing it here would sever the very channel under test.
  state.cancels.length = 0;
  state.armFailure = null;
  sink.length = 0;
  globalThis.__DSH_LOG_SINK__ = (line) => sink.push(JSON.parse(line));
});

afterEach(() => {
  globalThis.__DSH_LOG_SINK__ = realSink;
});

describe('loop-z2: the serving runtime\u0027s setTimeout is the gateway-backed seam', () => {
  it('an arm rides timerSchedule and the callback runs ONLY when the fire event lands', async () => {
    const fn = vi.fn();
    globalThis.setTimeout(fn, 50);
    // the arm is on the wire synchronously, with the caller's delay intact
    expect(state.scheduled).toEqual([{ delayMs: 50, tag: 'shim:setTimeout' }]);
    await settleArm();

    // armed, fire not delivered: the r16 posture (silent) — asserted observable
    expect(fn).not.toHaveBeenCalled();

    fire(1); // the event the unwired seat dropped (the mock's first timerId)
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the read-idle budget arms at full fidelity: 120000ms reaches the host unclamped', async () => {
    const fn = vi.fn();
    globalThis.setTimeout(fn, DEFAULT_READ_IDLE_TIMEOUT_MS);
    expect(state.scheduled.at(-1)?.delayMs).toBe(120_000);
    await settleArm();
    fire(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('loop-z2: the cancel races stay one-way', () => {
  it('clearTimeout after the arm: timerCancel runs and a racing fire is suppressed', async () => {
    const fn = vi.fn();
    const handle = globalThis.setTimeout(fn, 10);
    const timerId = state.scheduled.length; // the host's id space (the mock's)
    await settleArm();
    globalThis.clearTimeout(handle);
    expect(state.cancels).toEqual([timerId]);

    fire(timerId); // the fire lost the race — the idempotent one-way
    expect(fn).not.toHaveBeenCalled();
  });

  it('clearTimeout beating the arm: the late arm resolves into an immediate cancel', async () => {
    const fn = vi.fn();
    const handle = globalThis.setTimeout(fn, 10);
    globalThis.clearTimeout(handle); // before timerSchedule settles
    await settleArm();
    expect(state.cancels).toEqual([1]);
    expect(fn).not.toHaveBeenCalled();

    fire(1); // a stale fire for the cancelled entry is a no-op
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('loop-z2: the delay contract the budgets are stated in', () => {
  it.each([
    [1.9, 1], // fractions truncate toward zero (node semantics)
    [-5, 0], // negatives coerce to 0
    [2 ** 32, 2_147_483_647], // overflow clamps to the int32 ceiling
  ])('setTimeout(fn, %p) arms delayMs %p', (input, expected) => {
    globalThis.setTimeout(() => {}, input);
    expect(state.scheduled.at(-1)?.delayMs).toBe(expected);
  });

  it('a non-function callback fails loud (TypeError), arming nothing', () => {
    expect(() => globalThis.setTimeout('not a function', 5)).toThrow(TypeError);
    expect(state.scheduled).toEqual([]);
  });
});

describe('loop-z2: a host that refuses the arm is a LOUD defect, not a silent starvation', () => {
  it('the FIRST refused arm reports through the sink; repeats stay silent (one report per runtime)', async () => {
    // measured on android-e2e (loop-z2): a warn PER denied arm doubled the
    // runtime thread's log writes inside the live-read probe window (21 in
    // the burst second) and flipped the scenario's order-sensitive manifest.
    // The first report names the defect; repeats must not log.
    state.armFailure = new Error('denied: primitive not granted');
    const fn = vi.fn();
    globalThis.setTimeout(fn, 5);
    await settleArm();
    globalThis.setTimeout(() => {}, 6);
    await settleArm();
    globalThis.setTimeout(() => {}, 7);
    await settleArm();
    const reports = sink.filter((line) => line.event === 'arm/failed');
    expect(reports).toHaveLength(1); // the module's once-per-runtime flag
    expect(reports[0].level).toBe('warn');
    expect(reports[0].scenario).toBe('timers');
    expect(reports[0].message).toContain('denied');
    expect(fn).not.toHaveBeenCalled();
  });
});
