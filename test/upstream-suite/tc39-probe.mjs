// dsh:logging-exempt (probe: its verdict output IS the product)
/**
 * tc39-probe.mjs — the AsyncContext (TC39 proposal-async-context) engine
 * intrinsic's conformance probe. Run against the quickjs CLI:
 *
 *   cp test/upstream-suite/tc39-probe.mjs runtime/spike/upstream-tests/__tc39.spec.mjs
 *   cd runtime/spike && ./build/dsh-spike-cli . scenario/upstream-suite-leg.js \
 *     --env DSH_UPSTREAM_SPEC=upstream-tests/__tc39.spec.mjs
 *
 * Asserts the proposal's load-bearing semantics on OUR engine: the surface
 * exists; get/set + defaultValue; values propagate across await AND
 * host-event hops (the engine's job/reaction snapshots); wrap/snapshot
 * restore the captured whole context (an outside snapshot sees its own
 * world); an async wrapped fn carries the zone across awaits.
 */
import { describe, it, expect } from 'scenario/upstream-test-harness.js';
const { AsyncContext } = globalThis;
const v = new AsyncContext.Variable('probe', 'unset');
describe('TC39 AsyncContext', () => {
  it('exposes the proposal surface', () => {
    expect(typeof AsyncContext.Variable).toBe('function');
    expect(typeof AsyncContext.snapshot).toBe('function');
    expect(typeof AsyncContext.wrap).toBe('function');
    expect(v.name).toBe('probe');
    expect(v.defaultValue).toBe('unset');
  });
  it('get/set sync semantics + defaultValue', () => {
    expect(v.get()).toBe('unset');
    expect(v.set('x', () => v.get())).toBe('x');
    expect(v.get()).toBe('unset');
  });
  it('propagates across await (the engine seam)', async () => {
    const out = await v.set('carried', async () => {
      await Promise.resolve();
      await new Promise((r) => { globalThis.setTimeout(r, 3); });
      return v.get();
    });
    expect(out).toBe('carried');
  });
  it('an async wrapped fn carries the zone', async () => {
    const out = await v.set('zone', async () => {
      const wrapped = AsyncContext.wrap(async () => {
        await Promise.resolve();
        return v.get();
      });
      return await wrapped();
    });
    expect(out).toBe('zone');
  });
  it('an outside snapshot restores its own world', () => {
    const snap = AsyncContext.snapshot();
    const w = v.set('masked', () => AsyncContext.wrap(() => v.get(), snap)());
    expect(w).toBe('unset');
  });
  it('Variable.wrap restores the wrap-time value', () => {
    const inner = v.set('now', () => {
      const wrapped = v.wrap(() => v.get());
      return v.set('later', () => wrapped());
    });
    expect(inner).toBe('now');
  });
});
