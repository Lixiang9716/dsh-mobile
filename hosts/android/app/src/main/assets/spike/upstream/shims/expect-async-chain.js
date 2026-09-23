// dsh:logging-exempt (test-harness surface)
/**
 * expect(...).resolves / .rejects — the settled-value matcher chains,
 * extracted from the harness when its size crossed the file budget (the
 * expect.poll and vi.waitFor extractions came before). The .rejects family
 * asserts against the THROWN error, not a throwing function — the settle
 * wrapper re-enters makeExpect with a thrower for toThrow matchers.
 */
export function attachAsyncChain(makeExpect, failWith) {
  /** One settled-value matcher invocation (module level for nesting). */
  const settleAndMatch = async (settle, negated, matcher, args) => {
    const value = await settle();
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
  return makeAsyncChain;
}
