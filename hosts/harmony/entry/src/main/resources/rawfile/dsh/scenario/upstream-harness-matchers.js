// dsh:logging-exempt (test harness surface)
/**
 * upstream-harness-matchers.js — the pure matcher core of the upstream
 * harness (deep equality, subset matching, formatting, the AssertionError
 * the matchers fail with), split out of scenario/upstream-test-harness.js
 * when that file crossed the code-size budget. One-way dependency: nothing
 * here imports the harness; the stateful matcher families (which read the
 * suite/test context) stay in the harness.
 */

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

/** Render one assertion value. JSON.stringify is NOT used for objects and
 * String() is NOT used as a fallback: they consult toJSON/toString — property
 * PROBES that dispatch through lazy test proxies (remote-mock's namespace
 * proxy registers an endpoint and throws MissingUnaryRule on any
 * toJSON/toString read — W4-N 2026-09-28) and quickjs stringify throws on
 * BigInt. The walk reads OWN KEYS ONLY (an ownKeys proxy never sees a get
 * trap, so formatting never registers endpoints), cycles render as
 * [Circular], and functions get node's inspect spellings. */
const fmt = (value, depth = 0, seen = new Set()) => {
  try {
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === null) return 'null';
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return value.name ? `[Function: ${value.name}]` : '[Function (anonymous)]';
    if (value instanceof Error) return `${value.name ?? 'Error'}: ${value.message}`;
    if (typeof value !== 'object') return String(value); // number/boolean/undefined/symbol
    if (seen.has(value)) return '[Circular]';
    if (depth > 4) return '[Object]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = value.slice(0, 50).map((v) => fmt(v, depth + 1, seen));
        if (value.length > 50) items.push(`… ${value.length - 50} more`);
        return `[${items.join(', ')}]`;
      }
      const keys = Object.keys(value);
      const parts = keys.slice(0, 50).map((k) => `${JSON.stringify(k)}:${fmt(value[k], depth + 1, seen)}`);
      if (keys.length > 50) parts.push('…');
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(value);
    }
  } catch {
    return '[unformattable value]';
  }
};

function failWith(message) {
  throw new AssertionError(message);
}

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
  if (depth > 64) failWith('harness: deepEqual depth exceeded (64) — cyclic or pathological structure');
  if (scalarsEqual(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (seen.has(a)) return true; // cycle: compared by identity once already
  seen.add(a);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  return containersEqual(a, b, seen, depth);
};
const containersEqual = (a, b, seen, depth) => {
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
  return keyedEqual(a, b, seen, depth);
};
const keyedEqual = (a, b, seen, depth) => {
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
  return true;
};

/** BOTH-sides-Errors compare by name + message (vitest's error equality):
 * quickjs owns `stack` as an ENUMERABLE own property where V8 hides it, so
 * the generic own-key walk failed `toEqual(new Error(m))` on key count
 * alone. A plain-shape expected (expect.objectContaining) against an Error
 * actual still walks the subset below, exactly like vitest. */
const matchSubsetErrorPair = (actual, expected, strict, seen, depth) => {
  if (actual.message !== expected.message) return false;
  if ((actual.name ?? 'Error') !== (expected.name ?? 'Error')) return false;
  const extraA = Object.keys(actual).filter((k) => k !== 'stack');
  const extraB = Object.keys(expected).filter((k) => k !== 'stack');
  return extraA.length === extraB.length
    && extraA.every((k) => matchSubset(actual[k], expected[k], strict, seen, depth + 1));
};

/** An Error ACTUAL against a plain-shape expected (toMatchObject): quickjs
 * keeps `name` on the prototype (an own-key walk reads "{}"), so the subset
 * compare judges the error by its name/message face plus its own extra
 * properties. Strict toEqual keeps the generic walk (vitest fails
 * Error-vs-plain-object there too). Measured 2026-09-27:
 * ptc-runtime-node bootstrap matches {name, message} on a rejected error. */
const matchSubsetErrorShaped = (actual, expected, strict, seen, depth) => {
  const shaped = { name: actual.name ?? 'Error', message: actual.message };
  for (const key of Object.keys(expected)) {
    if (key === 'stack') continue; // engine-specific; never asserted
    const source = Object.prototype.hasOwnProperty.call(shaped, key) ? shaped : actual;
    if (!Object.prototype.hasOwnProperty.call(source, key)) return false;
    if (!matchSubset(source[key], expected[key], strict, seen, depth + 1)) return false;
  }
  return true;
};

/** toEqual's strict tail (module level for size): keys whose value is
 * undefined are ignored on BOTH sides (vitest's equals treats {a:1} equal
 * to {a:1, nested:undefined}; toStrictEqual keeps the distinction via
 * deepEqual). Measured 2026-09-27: settings redact asserts
 * toEqual {extra, nested: undefined}. */
const matchSubsetStrictTail = (actual, expected, strict, seen, depth) => {
  const actualDefined = Object.keys(actual).filter((k) => actual[k] !== undefined);
  const expectedDefined = Object.keys(expected).filter((k) => expected[k] !== undefined);
  if (actualDefined.length !== expectedDefined.length) return false;
  return actualDefined.every((k) => Object.prototype.hasOwnProperty.call(expected, k)
    && matchSubset(actual[k], expected[k], strict, seen, depth + 1));
};

/** Subset-matching for toEqual/toMatchObject against asymmetric matchers. */
const matchSubset = (actual, expected, strict, seen = new Set(), depth = 0) => {
  if (expected && typeof expected === 'object' && expected.__matcher) {
    return expected.__matcher(actual);
  }
  // Identity fast path + cycle guard (measured 2026-09-23: agent-initiator
  // and scope-lifecycle compare LIVE cordis objects against themselves —
  // expected === actual at the cycle point; and cordis getters return a NEW
  // traceable proxy on every access, so a seen-SET never re-sees the same
  // instance. Identity equality terminates those cycles exactly; a depth
  // cap (deepEqual's own bound) is the backstop for distinct-but-cyclic
  // structures, where the harness deems the walked prefix equal.)
  if (actual === expected) return true;
  if (depth > 64) return true;
  if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object') {
    return deepEqual(actual, expected);
  }
  // BOTH-sides-Errors compare by name + message (vitest's error equality):
  // quickjs owns `stack` as an ENUMERABLE own property where V8 hides it, so
  // the generic own-key walk failed `toEqual(new Error(m))` on key count
  // alone. A plain-shape expected (expect.objectContaining) against an Error
  // actual still walks the subset below, exactly like vitest.
  if (actual instanceof Error && expected instanceof Error) {
    return matchSubsetErrorPair(actual, expected, strict, seen, depth);
  }
  // An Error ACTUAL against a plain-shape expected (toMatchObject): quickjs
  // keeps `name` on the prototype (an own-key walk reads "{}"), so the subset
  // compare judges the error by its name/message face plus its own extra
  // properties. Strict toEqual keeps the generic walk (vitest fails
  // Error-vs-plain-object there too). Measured 2026-09-27:
  // ptc-runtime-node bootstrap matches {name, message} on a rejected error.
  if (actual instanceof Error && !strict) {
    return matchSubsetErrorShaped(actual, expected, strict, seen, depth);
  }
  if (Array.isArray(expected)) {
    if (strict && actual.length !== expected.length) return false;
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((v, i) => matchSubset(actual[i], v, strict, seen, depth + 1));
  }
  if (!strict && Array.isArray(actual)) return false;
  if (!matchSubsetOwnKeys(actual, expected, strict, seen, depth)) return false;
  if (strict) return matchSubsetStrictTail(actual, expected, strict, seen, depth);
  return true;
};

/** The plain-object walk of matchSubset (module level for size). toEqual's
 * undefined-key rule: an expected key whose value is undefined is NOT
 * required to exist on the actual side. Non-strict (toMatchObject) reads
 * through property ACCESS — vitest matches class instances whose fields are
 * prototype getters (the fetch-values Response/Request faces); an own-key
 * walk read "{}". A property that is absent (undefined + no own key) still
 * fails. */
const matchSubsetOwnKeys = (actual, expected, strict, seen, depth) => {
  for (const key of Object.keys(expected)) {
    if (strict && expected[key] === undefined) continue;
    if (strict) {
      if (!Object.prototype.hasOwnProperty.call(actual, key)) return false;
    } else if (actual[key] === undefined && !Object.prototype.hasOwnProperty.call(actual, key)) {
      return false;
    }
    if (!matchSubset(actual[key], expected[key], strict, seen, depth + 1)) return false;
  }
  return true;
};

/** The value matchers of expect() (module level for size): the structural
 * comparisons that only need (actual, check) — the identity family, the
 * property/throw families and the call matchers stay with the harness (the
 * inline snapshot's dedent logic rides here too, verbatim). */
const valueMatchers = (actual, check) => ({
    toBe(expected) { check(Object.is(actual, expected), `to be ${fmt(expected)} (got ${fmt(actual)})`); },
    toEqual(expected) { check(matchSubset(actual, expected, true), `to equal ${fmt(expected)} (got ${fmt(actual)})`); },
    toStrictEqual(expected) { check(deepEqual(actual, expected), `to strictly equal ${fmt(expected)}`); },
    toMatchObject(expected) { check(matchSubset(actual, expected, false), `to match ${fmt(expected)} (got ${fmt(actual)})`); },
    toContain(expected) {
      // Arrays use SAME-VALUE membership (vitest's toContain is identity —
      // deep equality would find ANY structurally-equal member, which broke
      // the deque release test where two distinct {} members are
      // indistinguishable). Strings substring, Sets has(), asymmetric
      // matchers still apply.
      let ok = false;
      if (typeof actual === 'string') ok = actual.includes(expected);
      else if (actual instanceof Set) ok = actual.has(expected);
      else if (Array.isArray(actual)) {
        ok = actual.some((v) => (expected && typeof expected === 'object' && expected.__matcher)
          ? expected.__matcher(v)
          : Object.is(v, expected));
      }
      check(ok, `to contain ${fmt(expected)}`);
    },
    toHaveLength(n) { check(actual?.length === n, `length ${n} (got ${fmt(actual?.length)})`); },
    // vitest's inline snapshot: the stored template is dedented (leading
    // newline dropped, common indentation stripped, trailing blank lines
    // trimmed) and a string actual serializes quoted with its real newlines
    // kept (the terminal tools PTC output-map projection is the only corpus
    // user — W4-N 2026-09-28).
    toMatchInlineSnapshot(expected) {
      if (typeof expected !== 'string') {
        check(false, 'inline snapshot: no stored snapshot (vitest write mode is unsupported here)');
        return;
      }
      let body = expected.startsWith('\n') ? expected.slice(1) : expected;
      const lines = body.split('\n');
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      const indents = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^ */)[0].length);
      const indent = indents.length > 0 ? Math.min(...indents) : 0;
      const dedented = lines.map((l) => l.slice(indent)).join('\n');
      const serialized = typeof actual === 'string' ? `"${actual}"` : fmt(actual);
      check(dedented === serialized, `to match the inline snapshot (got ${serialized.slice(0, 600)})`);
    },
});

/** The mock-invocation matchers (module level for size). */
const callInvocationMatchers = (actual, check) => ({
  toHaveBeenCalled() { check(Array.isArray(actual?.mock?.calls) && actual.mock.calls.length > 0, `to have been called (calls: ${actual?.mock?.calls?.length ?? 0})`); },
  toHaveBeenCalledOnce() { check(actual?.mock?.calls?.length === 1, `to have been called once (calls: ${actual?.mock?.calls?.length ?? 0})`); },
  toHaveBeenCalledTimes(n) { check(actual?.mock?.calls?.length === n, `to have been called ${n} times (got ${actual?.mock?.calls?.length})`); },
  toHaveBeenCalledExactlyOnceWith(...expected) {
    // vitest's exactly-once + args compound (measured 2026-09-27: the
    // tool-subagent-control interrupt suite asserts the child's cancel call).
    const calls = actual?.mock?.calls ?? [];
    const ok = calls.length === 1 && calls[0].length === expected.length
      && expected.every((v, i) => matchSubset(calls[0][i], v, false));
    check(ok, `to have been called exactly once with ${fmt(expected)} (calls: ${calls.length})`);
  },
  toHaveBeenCalledWith(...expected) {
    const ok = (actual?.mock?.calls ?? []).some((call) => call.length === expected.length && expected.every((v, i) => matchSubset(call[i], v, false)));
    check(ok, `to have been called with ${fmt(expected)}`);
  },
  toHaveBeenNthCalledWith(n, ...expected) {
    const call = (actual?.mock?.calls ?? [])[n - 1];
    const ok = call !== undefined && call.length === expected.length && expected.every((v, i) => matchSubset(call[i], v, false));
    check(ok, `call #${n} to be with ${fmt(expected)} (calls: ${(actual?.mock?.calls ?? []).length})`);
  },
  toHaveBeenCalledLastWith(...expected) {
    const calls = actual?.mock?.calls ?? [];
    const last = calls[calls.length - 1];
    const ok = last !== undefined && last.length === expected.length && expected.every((v, i) => matchSubset(last[i], v, false));
    check(ok, `last call to be with ${fmt(expected)}`);
  },
  toHaveBeenLastCalledWith(...expected) {
    // the standard vitest spelling of the matcher above
    return callMatchers(actual, check).toHaveBeenCalledLastWith(...expected);
  },
  toMatch(pattern) {
    const ok = typeof actual === 'string' && (pattern instanceof RegExp ? pattern.test(actual) : actual.includes(pattern));
    check(ok, `to match ${fmt(pattern)} (got ${fmt(actual?.slice?.(0, 120))})`);
  },
});

/** The call-subject content matchers (module level for size). */
const callContentMatchers = (actual, check) => ({  /** vitest's file-snapshot matcher without a disk: the store lives on the
   * global (one spec per runtime), writes on FIRST sight and compares on
   * repeats (R3-G1, 2026-09-28 — messages__serialize awaits it). The
   * transpiler seeds no `expected/` files and the runtime keeps no
   * persistent disk, so CI-strict compare-every-run is not reproducible
   * here; per-run stability is still asserted on repeats. */
  async toMatchFileSnapshot(path, _options) {
    const store = globalThis.__dshFileSnapshots ??= new Map();
    const current = testContextAccessor();
    const key = `${current?.name ?? '?'}::${path}`;
    const text = typeof actual === 'string' ? actual : fmt(actual);
    const existing = store.get(key);
    if (existing === undefined) {
      store.set(key, text);
      return check(true);
    }
    check(existing === text, `to match file snapshot ${path} (snapshot drift within the run)`);
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

export const callMatchers = (actual, check) => ({
  ...callInvocationMatchers(actual, check),
  ...callContentMatchers(actual, check),
});

const checkThrownMessage = (threw, expected, check) => {
  const thrownMessage = threw !== null && typeof threw === 'object' && typeof threw.message === 'string'
    ? threw.message
    : String(threw);
  const dataNote = threw !== null && typeof threw === 'object' && threw.data !== undefined
    ? ` data=${JSON.stringify(threw.data).slice(0, 300)}`
    : '';
  if (typeof expected === 'string') return check(thrownMessage.includes(expected), `throw message containing "${expected}" (got "${thrownMessage}")${dataNote}`);
  // The got-message echo stays in the regex arm too: a bare "matching /…/"
  // verdict hides which arm of an it.each table drifted (acp bridge's
  // mcpServers validation table, W3-J 2026-09-27).
  if (expected instanceof RegExp) return check(expected.test(thrownMessage), `throw message matching ${expected} (got "${thrownMessage}")${dataNote}`);
  // A thrown-in ERROR INSTANCE (jest/vitest contract): compared by MESSAGE
  // (and identity), not by instanceof — the product may re-wrap an equal
  // message across a catch boundary, and jest explicitly specifies message
  // equality for this form (measured 2026-09-28: llm-pi-ai config's
  // "propagates unexpected catalog failures").
  if (expected instanceof Error) {
    return check(threw === expected || thrownMessage === expected.message,
      `throw with message "${expected.message}" (got "${thrownMessage}")`);
  }
  // vitest arm order (measured against packages/expect/src/jest-expect.ts
  // toThrow, v4.1.8 — the upstream suite pins vitest ^4.1.8): an ASYMMETRIC
  // MATCHER expected (our __matcher face of expect.objectContaining & co —
  // vitest's `asymmetricMatch` fn) is invoked over the WHOLE thrown error
  // before any equality; a plain-shape expected walks the subset below. The
  // verdict echoes the thrown error (name+message+code) exactly like the
  // string/regex arms: without it a shape failure is undiagnosable from the
  // structured log alone (W7-Y1 2026-09-29: web-fetch-http 'maps a connection
  // failure to WEB_PROVIDER_ERROR' verdict showed only the matcher and never
  // what was actually thrown).
  if (typeof expected === 'object') {
    const thrownNote = threw !== null && typeof threw === 'object'
      ? `${threw.name ?? 'Error'}: ${thrownMessage}${threw.code !== undefined ? ` code=${String(threw.code)}` : ''}`
      : fmt(threw);
    const matched = expected.__matcher ? expected.__matcher(threw) : matchSubset(threw, expected, false);
    return check(matched, `throw matching ${fmt(expected)} (got ${thrownNote})${dataNote}`);
  }
  check(threw instanceof expected, `throw ${expected?.name}`);
};
export const throwMatchers = (actual, check) => ({
  toThrow(expected) {
    // A DID-THROW flag, not a null sentinel: `throw undefined` (what the
    // resolves/rejects settle wrapper throws for a settled-undefined value —
    // telemetry's resolves.not.toThrow on a void dispose) must still count
    // as a throw.
    let threw;
    let didThrow = false;
    try {
      if (typeof actual === 'function') actual();
      else return failWith('expected a function to throw');
    } catch (error) {
      didThrow = true;
      threw = error;
    }
    if (!didThrow) return check(false, 'to throw');
    if (expected === undefined) return check(true);
    checkThrownMessage(threw, expected, check);
  },
  toThrowError(expected) {
    // vitest alias: toThrowError([message]) — same contract as toThrow
    return throwMatchers(actual, check).toThrow(expected);
  },
  toSatisfy(predicate) {
    check(Boolean(predicate(actual)), `to satisfy ${fmt(predicate)}`);
  },
});

/** Identity/truthiness matchers. */
export const identityMatchers = (actual, check) => ({
  toBeInstanceOf(cls) {
    // Vendoring parity (W6-V, session-persistence-jsonl zstd contract): the
    // staged spec bundle INLINES the vendored package's src/ (esbuild bundle
    // mode) while the runtime serves the published lib build for the same
    // bare specifier — the same nominal class exists as two distinct
    // constructor objects across that boundary, so a strict instanceof can
    // never hold for an error thrown by the lib and asserted against the
    // bundle's copy (10 lifecycle-refusal tests failed on identity alone).
    // Upstream's observable contract is the error TYPE: accept a same-named
    // Error pair across the copy boundary. Narrow on purpose: fires only
    // when instanceof already failed, and requires BOTH sides to be Error
    // instances whose constructor names agree, modulo esbuild's `_` dedupe
    // prefix on the bundle side (esbuild renames colliding bundle-local
    // bindings and prefixes re-used top-level names; strip both staging
    // artifacts before comparing).
    let ok = actual instanceof cls;
    if (!ok && typeof cls === 'function' && actual !== null && typeof actual === 'object') {
      const nominal = (s) => String(s ?? '').replace(/^_+/, '').replace(/\d+$/, '');
      const expectedName = typeof cls.name === 'string' ? nominal(cls.name) : '';
      const actualName = actual.constructor?.name;
      if (expectedName.length > 0
        && (nominal(actualName) === expectedName || nominal(actual.name) === expectedName)
        && cls.prototype instanceof Error && actual instanceof Error) ok = true;
    }
    check(ok, `instance of ${cls?.name}`);
  },
  toBeNull() { check(actual === null, `null (got ${fmt(actual)})`); },
  toBeUndefined() { check(actual === undefined, `undefined (got ${fmt(actual)})`); },
  toBeDefined() { check(actual !== undefined, 'defined'); },
  toBeTruthy() { check(Boolean(actual), 'truthy'); },
  toBeFalsy() { check(Boolean(actual) === false, 'falsy'); },
  toBeNaN() { check(Number.isNaN(actual), 'NaN'); },
  toBeTypeOf(expected) {
    const got = actual === null ? 'null' : typeof actual;
    check(got === expected || (expected === 'function' && typeof actual === 'function'), `type of ${fmt(expected)} (got ${fmt(got)})`);
  },
});

let testContextAccessor = () => undefined;
/** The harness registers its current-test accessor (the file-snapshot
 * matcher reads `runningTest ?? last test` through it — the suite state
 * stays module-private in the harness). */
export const setTestContextAccessor = (fn) => { testContextAccessor = fn; };

export { AssertionError, failWith, fmt, deepEqual, matchSubset, valueMatchers };
