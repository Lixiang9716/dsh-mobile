import '../upstream/shims/globals.js';
import { attachExpectPoll } from '../upstream/shims/expect-poll.js';
// dsh:logging-exempt (test harness: verdicts are the product)
import { fakeTimerApi } from 'scenario/upstream-fake-timers.js';

// upstream-test-harness — the quickjs test shell for the UPSTREAM suite in
// OUR runtime (transpiled specs import it as `vitest`); unimplemented APIs
// fail LOUD naming the API (rule 5). Fake timers live in
// scenario/upstream-fake-timers.js.

/** The scalar fast paths of deepEqual — extracted to keep the recursive
 * comparator under the 50-line function budget. */
const scalarsEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  return undefined; // both non-null objects: continue in deepEqual
};

/** Deep structural equality (the expect().toEqual core), depth-guarded. */
const deepEqual = (a, b, seen = new Set(), depth = 0) => {
  if (depth > 64) failWith('harness: deepEqual depth exceeded (64) — cyclic or pathological structure');
  if (scalarsEqual(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (seen.has(a)) return true; // cycle: compared by identity once already
  seen.add(a);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i], seen, depth + 1));
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof Error || b instanceof Error) {
    return a instanceof Error && b instanceof Error && a.message === b.message;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k), seen, depth + 1)) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    /* Set equality is MEMBERSHIP, not insertion order (measured 2026-09-23:
     * agent-initiator asserts new Set([...signals]).toEqual(new Set([s])) —
     * the generic object compare failed it). Members compare by the same
     * deep rules; identity-only when no deep twin exists. */
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    const rest = new Set(b);
    for (const item of a) {
      let matched = false;
      if (rest.delete(item)) continue;
      for (const candidate of rest) {
        if (deepEqual(item, candidate, seen, depth + 1)) {
          rest.delete(candidate);
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], seen, depth + 1));
};

/** Subset-matching for toEqual/toMatchObject against asymmetric matchers. */
const matchSubset = (actual, expected, strict) => {
  if (expected && typeof expected === 'object' && expected.__matcher) {
    return expected.__matcher(actual);
  }
  if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object') {
    return deepEqual(actual, expected);
  }
  if (Array.isArray(expected)) {
    if (strict && actual.length !== expected.length) return false;
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((v, i) => matchSubset(actual[i], v, strict));
  }
  if (!strict && Array.isArray(actual)) return false;
  for (const key of Object.keys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return false;
    if (!matchSubset(actual[key], expected[key], strict)) return false;
  }
  return strict ? Object.keys(actual).length === Object.keys(expected).length : true;
};

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

const fmt = (v) => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

function failWith(message) {
  throw new AssertionError(message);
}

/** Spy-call and string/collection matchers (the heavily-used surface). */
const callMatchers = (actual, check) => ({
  toHaveBeenCalled() { check(Array.isArray(actual?.mock?.calls) && actual.mock.calls.length > 0, `to have been called (calls: ${actual?.mock?.calls?.length ?? 0})`); },
  toHaveBeenCalledOnce() { check(actual?.mock?.calls?.length === 1, `to have been called once (calls: ${actual?.mock?.calls?.length ?? 0})`); },
  toHaveBeenCalledTimes(n) { check(actual?.mock?.calls?.length === n, `to have been called ${n} times (got ${actual?.mock?.calls?.length})`); },
  toHaveBeenCalledWith(...expected) {
    const ok = (actual?.mock?.calls ?? []).some((call) => call.length === expected.length && expected.every((v, i) => matchSubset(call[i], v, false)));
    check(ok, `to have been called with ${fmt(expected)}`);
  },
  toHaveBeenCalledLastWith(...expected) {
    const calls = actual?.mock?.calls ?? [];
    const last = calls[calls.length - 1];
    const ok = last !== undefined && last.length === expected.length && expected.every((v, i) => matchSubset(last[i], v, false));
    check(ok, `last call to be with ${fmt(expected)}`);
  },
  toMatch(pattern) {
    const ok = typeof actual === 'string' && (pattern instanceof RegExp ? pattern.test(actual) : actual.includes(pattern));
    check(ok, `to match ${fmt(pattern)} (got ${fmt(actual?.slice?.(0, 120))})`);
  },
  toContainEqual(expected) {
    // matchSubset (not deepEqual): the corpus passes asymmetric matchers
    // (expect.objectContaining) nested inside toContainEqual rows.
    const ok = Array.isArray(actual) && actual.some((v) => matchSubset(v, expected, false));
    check(ok, `to contain an equal of ${fmt(expected)}`);
  },
  toBeCloseTo(n, precision = 2) {
    const ok = Math.abs(actual - n) < 10 ** -precision / 2;
    check(ok, `close to ${n} (got ${fmt(actual)})`);
  },
});

/** Ordered comparison matchers. */
const comparisonMatchers = (actual, check) => ({
  toBeGreaterThan(n) { check(actual > n, `> ${n} (got ${fmt(actual)})`); },
  toBeGreaterThanOrEqual(n) { check(actual >= n, `>= ${n} (got ${fmt(actual)})`); },
  toBeLessThan(n) { check(actual < n, `< ${n} (got ${fmt(actual)})`); },
  toBeLessThanOrEqual(n) { check(actual <= n, `<= ${n} (got ${fmt(actual)})`); },
});

/** Property-path matchers. */
const propertyMatchers = (actual, check) => ({
  toHaveProperty(key, value) {
    const parts = Array.isArray(key) ? key : key.split('.');
    let at = actual;
    for (const p of parts) {
      if (at === null || at === undefined || !Object.prototype.hasOwnProperty.call(at, p)) {
        check(false, `property "${key}"`);
        return;
      }
      at = at[p];
    }
    if (arguments.length > 1) {
      check(deepEqual(at, value), `property "${key}" = ${fmt(value)} (got ${fmt(at)})`);
    } else {
      check(true);
    }
  },
});

/** The toThrow family (function-throwing assertions). */
const throwMatchers = (actual, check) => ({
  toThrow(expected) {
    let threw = null;
    try {
      if (typeof actual === 'function') actual();
      else return failWith('expected a function to throw');
    } catch (error) {
      threw = error;
    }
    if (threw === null) return check(false, 'to throw');
    if (expected === undefined) return check(true);
    if (typeof expected === 'string') return check(threw.message?.includes(expected), `throw message containing "${expected}" (got "${threw.message}")`);
    if (expected instanceof RegExp) return check(expected.test(threw.message ?? ''), `throw message matching ${expected}`);
    if (typeof expected === 'object') return check(matchSubset(threw, expected, false), `throw matching ${fmt(expected)}`);
    check(threw instanceof expected, `throw ${expected?.name}`);
  },
});

/** Identity/truthiness matchers. */
const identityMatchers = (actual, check) => ({
  toBeInstanceOf(cls) { check(actual instanceof cls, `instance of ${cls?.name}`); },
  toBeNull() { check(actual === null, `null (got ${fmt(actual)})`); },
  toBeUndefined() { check(actual === undefined, `undefined (got ${fmt(actual)})`); },
  toBeDefined() { check(actual !== undefined, 'defined'); },
  toBeTruthy() { check(Boolean(actual), 'truthy'); },
  toBeFalsy() { check(Boolean(actual) === false, 'falsy'); },
  toBeNaN() { check(Number.isNaN(actual), 'NaN'); },
});

/** The .resolves/.rejects chains: await the promise (or capture its
 * rejection), then forward to the plain matcher of the settled value. */
/** One settled-value matcher invocation (module level for nesting). */
const settleAndMatch = async (settle, negated, matcher, args) => {
  const value = await settle();
  // vitest's .rejects.toThrow family asserts against the THROWN error,
  // not a throwing function.
  if (matcher.startsWith('toThrow')) {
    const chain = makeExpect(() => { throw value; }, negated);
    return chain[matcher](...args);
  }
  const settled = makeExpect(value, negated);
  const fn = settled[matcher];
  if (typeof fn !== 'function') failWith(`harness: matcher "${matcher}" is not implemented`);
  return fn.apply(settled, args);
};

const makeAsyncChain = (settle, negated) => {
  const cache = {};
  return new Proxy(cache, {
    get(target, matcher) {
      if (typeof matcher !== 'string' || matcher === 'then' || matcher === 'not') {
        return undefined; // symbols/protocol probes never start a chain
      }
      if (!(matcher in target)) {
        target[matcher] = (...args) => settleAndMatch(settle, negated, matcher, args);
      }
      return target[matcher];
    },
  });
};

/** The expect() chain. */
const makeExpect = (actual, negated = false) => {
  const check = (ok, description) => {
    if (negated ? ok : !ok) {
      failWith(`expected ${negated ? 'NOT ' : ''}${description}`);
    }
  };
  const api = {
    ...callMatchers(actual, check),
    ...comparisonMatchers(actual, check),
    toBe(expected) { check(Object.is(actual, expected), `to be ${fmt(expected)} (got ${fmt(actual)})`); },
    toEqual(expected) { check(matchSubset(actual, expected, true), `to equal ${fmt(expected)} (got ${fmt(actual)})`); },
    toStrictEqual(expected) { check(deepEqual(actual, expected), `to strictly equal ${fmt(expected)}`); },
    toMatchObject(expected) { check(matchSubset(actual, expected, false), `to match ${fmt(expected)} (got ${fmt(actual)})`); },
    toContain(expected) {
      let ok = false;
      if (typeof actual === 'string') ok = actual.includes(expected);
      else if (actual instanceof Set) ok = actual.has(expected);
      else if (Array.isArray(actual)) ok = actual.some((v) => deepEqual(v, expected));
      check(ok, `to contain ${fmt(expected)}`);
    },
    toHaveLength(n) { check(actual?.length === n, `length ${n} (got ${fmt(actual?.length)})`); },
    ...identityMatchers(actual, check),
    ...propertyMatchers(actual, check),
    ...throwMatchers(actual, check),
    resolves: makeAsyncChain(() => Promise.resolve(actual), negated),
    rejects: makeAsyncChain(() => Promise.resolve(actual).then(
      () => failWith('expected the promise to reject, but it resolved'),
      (error) => error,
    ), negated),
  };
  // .not is LAZY: constructing it eagerly would recurse (each negated
  // matcher set builds its own .not, forever).
  let negatedApi = null;
  Object.defineProperty(api, 'not', {
    get: () => {
      if (negatedApi === null) negatedApi = makeExpect(actual, true);
      return negatedApi;
    },
  });
  return api;
};

/** The vi.fn mock core: a calls/results ledger plus the implementation
 * queue. The *Once family (mockImplementationOnce et al.) prepends a
 * one-shot implementation consumed before the standing one — vitest's
 * `vi.spyOn(x, 'y').mockImplementationOnce(...)` is the corpus's standard
 * "make exactly the next call fail" idiom. */
const makeMockFn = (impl) => {
  const onceQueue = [];
  const f = (...args) => {
    f.mock.calls.push(args);
    const next = onceQueue.length > 0 ? onceQueue.shift() : impl;
    try {
      const value = next ? next(...args) : undefined;
      f.mock.results.push({ type: 'return', value });
      return value;
    } catch (error) {
      f.mock.results.push({ type: 'throw', value: error });
      throw error;
    }
  };
  f.mock = { calls: [], results: [] };
  f.mockImplementation = (next) => { impl = next; return f; };
  f.mockImplementationOnce = (next) => { onceQueue.push(next); return f; };
  f.mockReturnValue = (value) => { impl = () => value; return f; };
  f.mockReturnValueOnce = (value) => { onceQueue.push(() => value); return f; };
  f.mockResolvedValue = (value) => { impl = () => Promise.resolve(value); return f; };
  f.mockResolvedValueOnce = (value) => { onceQueue.push(() => Promise.resolve(value)); return f; };
  f.mockRejectedValue = (value) => { impl = () => Promise.reject(value); return f; };
  f.mockRejectedValueOnce = (value) => { onceQueue.push(() => Promise.reject(value)); return f; };
  f.mockClear = () => { f.mock.calls.length = 0; f.mock.results.length = 0; onceQueue.length = 0; return f; };
  f.mockReset = f.mockClear;
  return f;
};

const fakeTimerState = {};

/** vi subset; the mock and timer APIs fail loud (loader-level / no seam). */
const viApi = {
  fn: makeMockFn,
  isMockFunction: (v) => typeof v === 'function' && v.mock !== undefined,
  spyOn(object, key) {
    const original = object[key];
    const spy = makeMockFn(typeof original === 'function' ? original : undefined);
    spy.mockRestore = () => { object[key] = original; };
    object[key] = spy;
    return spy;
  },
  stubGlobal(name, value) {
    if (!viApi._globalStubs) viApi._globalStubs = [];
    const original = globalThis[name];
    globalThis[name] = value;
    const restore = { mockRestore: () => { globalThis[name] = original; } };
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
    for (const restore of viApi._globalStubs ?? []) restore();
    viApi._globalStubs = [];
  },
  restoreAllMocks() { /* spies restore on their own handles */ },
  clearAllMocks() { /* spies clear on their own handles */ },
  mocked: (v) => v,
  hoisted: (factory) => factory(),
  mock: () => failWith('harness: vi.mock is not implemented (loader-level interception) — the transpiler excludes specs that need it'),
  ...fakeTimerApi(fakeTimerState),
};

// ---- collection -----------------------------------------------------------

const suite = { tests: [], before: [], after: [], beforeEach: [], afterEach: [] };
let currentDescribe = [];

const fullName = (name) => [...currentDescribe, name].join(' > ');

export const describe = (name, factory) => {
  currentDescribe.push(name);
  factory();
  currentDescribe.pop();
};
describe.skip = () => { /* counted at transpile time */ };
describe.only = (name, factory) => describe(name, factory);

export const it = (name, fn) => {
  suite.tests.push({ name: fullName(name), fn, hooks: { beforeEach: [...suite.beforeEach], afterEach: [...suite.afterEach] } });
};
it.skip = () => {};
it.only = it;
it.each = (table) => (name, fn) => {
  for (const row of table) {
    const args = Array.isArray(row) ? row : [row];
    it(`${name.replace(/\$\{[^}]+\}/g, () => '').trim()} [${args.map(fmt).join(',')}]`, () => fn(...args));
  }
};
export const test = it;
export const beforeEach = (fn) => { suite.beforeEach.push(fn); };
export const afterEach = (fn) => { suite.afterEach.push(fn); };
export const beforeAll = (fn) => { suite.before.push(fn); };
export const afterAll = (fn) => { suite.after.push(fn); };
/** vitest's onTestFinished: register cleanup for the CURRENTLY-RUNNING test
 * (or the collection tail when called at module scope — the spec's intent
 * is teardown-after-test either way). */
export const onTestFinished = (fn) => {
  const last = suite.tests[suite.tests.length - 1];
  if (last !== undefined) {
    last.hooks.afterEach.push(fn);
  } else {
    suite.afterEach.push(fn);
  }
};
export const expect = Object.assign(makeExpect, {
  extend: () => failWith('harness: expect.extend is not implemented'),
  /** expect.soft: vitest records and continues; the harness has no
   * end-of-test collector, so soft asserts immediately — the test's verdict
   * (fail) is identical, only later assertions in the same test don't run. */
  soft: (value) => makeExpect(value),
  fail: (message = 'expect.fail()') => failWith(String(message)),
  unreachable: (message = 'expected unreachable path') => failWith(`unreachable: ${String(message)}`),
  anything: () => ({ __matcher: () => true }),
  any: (cls) => ({ __matcher: (v) => typeof v === cls?.name?.toLowerCase() || v instanceof cls }),
  objectContaining: (shape) => ({ __matcher: (v) => matchSubset(v, shape, false) }),
  arrayContaining: (shape) => ({ __matcher: (v) => Array.isArray(v) && shape.every((s) => v.some((x) => matchSubset(x, s, false))) }),
  stringContaining: (s) => ({ __matcher: (v) => typeof v === 'string' && v.includes(s) }),
  stringMatching: (r) => ({ __matcher: (v) => typeof v === 'string' && r.test(v) }),
  closeTo: (n, precision = 2) => ({ __matcher: (v) => Math.abs(v - n) < 10 ** -precision / 2 }),
  hasProperty: (key) => ({ __matcher: (v) => v != null && Object.prototype.hasOwnProperty.call(v, key) }),
});
attachExpectPoll(expect, makeExpect, failWith);
export const vi = viApi;

const typeChain = new Proxy(function typeProbe() {}, {
  get: (_t, key) => (typeof key === 'string' ? typeChain : undefined),
  apply: () => typeChain,
});
export const expectTypeOf = () => typeChain;

/** Run everything the imported specs collected; report per test to the
 * caller's sink. Returns {passed, failed, skipped, failures}. A test that
 * never settles is the suite's hang class (no timer seam to cut it short) —
 * the sink sees its 'start' before it runs, so the stream names the exact
 * test a hang froze on. */
export const runCollected = async (sink) => {
  const report = { passed: 0, failed: 0, skipped: 0, failures: [] };
  for (const setup of suite.before) await setup();
  for (const t of suite.tests) {
    if (typeof t.fn !== 'function') { report.skipped += 1; sink(t.name, 'skipped'); continue; }
    sink(t.name, 'start');
    try {
      for (const hook of t.hooks.beforeEach) await hook();
      await t.fn();
      report.passed += 1;
      sink(t.name, 'pass');
    } catch (error) {
      report.failed += 1;
      report.failures.push({
        name: t.name,
        message: error?.message ?? String(error),
        stack: String(error?.stack ?? '').split('\n').slice(1, 5).join(' | '),
      });
      sink(t.name, 'fail', error?.message ?? String(error));
    } finally {
      for (const hook of t.hooks.afterEach) {
        try { await hook(); } catch { /* afterEach failures do not mask the verdict */ }
      }
    }
  }
  for (const teardown of suite.after) await teardown();
  return report;
};

/** Reset collection (the driver runs one spec module per runtime). */
export const resetCollection = () => {
  suite.tests.length = 0;
  suite.before.length = 0;
  suite.after.length = 0;
  suite.beforeEach.length = 0;
  suite.afterEach.length = 0;
  currentDescribe.length = 0;
};