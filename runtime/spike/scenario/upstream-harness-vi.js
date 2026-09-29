// dsh:logging-exempt (test harness surface)
/**
 * upstream-harness-vi.js — the vi API (mocks + spies + global/env stubbing),
 * split out of scenario/upstream-test-harness.js when that file crossed the
 * code-size budget. The AssertionError comes from the matchers module; the
 * fake-timer methods ride the fake-timer module's state holder.
 */
import { AssertionError, failWith } from './upstream-harness-matchers.js';
import { fakeTimerApi } from 'scenario/upstream-fake-timers.js';
import { attachViWaits } from '../upstream/shims/vi-wait.js';

let mockCallSeq = 0; // vitest's mock.invocationCallOrder: process-wide call sequence

const fakeTimerState = {};

/** vi subset; the mock and timer APIs fail loud (loader-level / no seam). */
const makeMockFn = (impl) => {
  const onceQueue = [];
  const originalImpl = impl; // mockReset restores the creation implementation
  const f = function (...args) {
    f.mock.calls.push(args);
    // vitest's mock.instances ledger: push the receiver of each call — the
    // controller.client download spec reads click.mock.instances[0].
    f.mock.instances.push(this);
    f.mock.invocationCallOrder.push(++mockCallSeq);
    const next = onceQueue.length > 0 ? onceQueue.shift() : impl;
    try {
      const value = next ? next.apply(this, args) : undefined;
      f.mock.results.push({ type: 'return', value });
      return value;
    } catch (error) {
      f.mock.results.push({ type: 'throw', value: error });
      throw error;
    }
  };
  f.mock = { calls: [], instances: [], results: [], invocationCallOrder: [] };
  f.mockImplementation = (next) => { impl = next; return f; };
  f.getMockImplementation = () => impl;
  f.mockImplementationOnce = (next) => { onceQueue.push(next); return f; };
  f.mockReturnValue = (value) => { impl = () => value; return f; };
  f.mockReturnValueOnce = (value) => { onceQueue.push(() => value); return f; };
  f.mockResolvedValue = (value) => { impl = () => Promise.resolve(value); return f; };
  f.mockResolvedValueOnce = (value) => { onceQueue.push(() => Promise.resolve(value)); return f; };
  f.mockRejectedValue = (value) => { impl = () => Promise.reject(value); return f; };
  f.mockRejectedValueOnce = (value) => { onceQueue.push(() => Promise.reject(value)); return f; };
  // vitest's reset family (W4-N 2026-09-28, remote-mock's proxy spec):
  // mockClear clears the CALL LEDGERS only — queued one-shot overrides
  // survive it ("keeps queued overrides on mockClear"); mockReset clears
  // the ledgers AND the queued overrides AND restores the ORIGINAL
  // implementation the mock was created with ("restores the live default
  // rule on mockReset" — the vendored remote-mock's fn was created around
  // its default-rule dispatcher, so a reset re-arms that dispatcher).
  f.mockClear = () => {
    f.mock.calls.length = 0;
    f.mock.instances.length = 0;
    f.mock.results.length = 0;
    f.mock.invocationCallOrder.length = 0;
    return f;
  };
  f.mockReset = () => {
    f.mockClear(); onceQueue.length = 0; impl = originalImpl; return f;
  };
  return f;
};

const viApi = {
  fn: makeMockFn,
  isMockFunction: (v) => typeof v === 'function' && v.mock !== undefined,
  spyOn(object, key) {
    const original = object[key];
    const spy = makeMockFn(typeof original === 'function' ? original : undefined);
    spy.mockRestore = () => { object[key] = original; };
    object[key] = spy;
    // Registry for vi.restoreAllMocks (W6-V: session-persistence zstd — the
    // "falls back to the public decoder" test mocks the PRIVATE create
    // static to undefined and relies on afterEach's restoreAllMocks to undo
    // it; the old no-op left the static mocked, so every later create() in
    // the file returned undefined). Vitest restores spies created with
    // spyOn; plain vi.fn mocks have no original property to put back.
    if (!viApi._spies) viApi._spies = [];
    if (!viApi._spies.includes(spy)) viApi._spies.push(spy);
    return spy;
  },
  stubGlobal(name, value) {
    if (!viApi._globalStubs) viApi._globalStubs = [];
    // vitest installs stubs through defineProperty and restores the original
    // PROPERTY DESCRIPTOR — not by read-then-assign. The distinction is
    // load-bearing: a stubbed global may be (or become) a getter-only
    // accessor (recovery.client's "storage denied" fixture defines a
    // throwing localStorage getter), where a value read throws at stub time
    // and a value write cannot undo the accessor. Descriptor capture + a
    // defineProperty install keeps every shape stubbable and restorable.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      value, writable: true, enumerable: true, configurable: true,
    });
    const restore = { mockRestore: () => {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    } };
    viApi._globalStubs.push(restore);
    return restore;
  },
  stubEnv(name, value) {
    if (!viApi._envStubs) viApi._envStubs = {};
    if (!(name in viApi._envStubs)) viApi._envStubs[name] = process.env[name];
    process.env[name] = value;
  },
  unstubAllEnvs() {
    for (const [name, value] of Object.entries(viApi._envStubs ?? {})) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    viApi._envStubs = {};
  },
  unstubAllGlobals() {
    // Each entry is a {mockRestore} record (vitest shape) — call the METHOD,
    // not the record (measured 2026-09-27: "not a function" on every spec
    // using vi.stubGlobal + unstubAllGlobals).
    for (const restore of viApi._globalStubs ?? []) restore.mockRestore?.();
    viApi._globalStubs = [];
  },
  // Vitest: restore original implementations of every vi.spyOn spy (the
  // registry above). Plain vi.fn mocks stay as created — they have no
  // original property to restore (matches vitest's restore semantics for
  // bare mocks, whose mockReset goes to the CREATION implementation, not
  // the pre-spy property).
  restoreAllMocks() {
    for (const spy of viApi._spies ?? []) spy.mockRestore?.();
    viApi._spies = [];
  },
  clearAllMocks() { /* spies clear on their own handles */ },
  mocked: (v) => v,
  hoisted: (factory) => factory(),
  mock: () => failWith('harness: vi.mock is not implemented (loader-level interception) — the transpiler excludes specs that need it'),
  ...fakeTimerApi(fakeTimerState),
};
attachViWaits(viApi, failWith);

export { viApi, makeMockFn };
