// dsh:logging-exempt (test-harness surface)
/**
 * expect(...).resolves / .rejects — the settled-value matcher chains,
 * extracted from the harness when its size crossed the file budget (the
 * expect.poll and vi.waitFor extractions came before). The .rejects family
 * asserts against the THROWN error, not a throwing function — the settle
 * wrapper re-enters makeExpect with a thrower for toThrow matchers.
 */
/** The no-throw verdict for a RESOLVED promise (negation-aware). */
const checkResolution = (failWith) => (negated) => {
  if (negated) return undefined;
  return failWith('expected the promise to reject with a thrown error, but it resolved');
};

/** One settled-value matcher invocation. The custom failure MESSAGE threads
 * through (W4-N 2026-09-28): vitest's `expect(fn, msg).rejects.toThrow(sub)`
 * throws with msg as the text, and the spec asserts on that message. */
const settleAndMatch = (makeExpect, failWith) => async (
  settle, negated, matcher, args, isResolution = false, message = '',
) => {
  const value = await settle();
  if (matcher.startsWith('toThrow')) {
    // A RESOLVED promise threw nothing: toThrow fails and not.toThrow
    // passes, regardless of the resolved value (a void dispose resolves
    // undefined — telemetry's resolves.not.toThrow on dispose). A REJECTED
    // promise feeds the rejection to the thrower machinery below.
    if (isResolution && value === undefined) {
      return checkResolution(failWith)(negated);
    }
    const chain = makeExpect(() => { throw value; }, negated, message);
    return chain[matcher](...args);
  }
  const settled = makeExpect(value, negated, message);
  const fn = settled[matcher];
  if (typeof fn !== 'function') failWith(`harness: matcher "${matcher}" is not implemented`);
  return fn.apply(settled, args);
};

const makeAsyncChain = (makeExpect, failWith) => {
  const match = settleAndMatch(makeExpect, failWith);
  const chain = (settle, negated, isResolution = false, message = '') => {
    const cache = {};
    const get = (target, matcher) => {
      if (typeof matcher !== 'string' || matcher === 'then') {
        return undefined; // symbols/protocol probes never start a chain
      }
      // `.resolves.not.toThrow()` / `.rejects.not.toThrow()` — vitest
      // negates the SETTLED matcher (measured 2026-09-27: telemetry's
      // "warns instead of throwing" disposes with resolves.not.toThrow);
      // the old probe returned undefined and the follow-up read threw.
      if (matcher === 'not') {
        if (!('not' in cache)) {
          cache.not = chain(settle, !negated, isResolution, message);
        }
        return cache.not;
      }
      if (!(matcher in target)) {
        target[matcher] = (...args) => match(settle, negated, matcher, args, isResolution, message);
      }
      return target[matcher];
    };
    return new Proxy(cache, { get });
  };
  return chain;
};

export function attachAsyncChain(makeExpect, failWith) {
  return makeAsyncChain(makeExpect, failWith);
}
