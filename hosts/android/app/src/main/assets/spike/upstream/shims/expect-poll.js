// dsh:logging-exempt (test-harness surface)
/**
 * expect.poll — vitest's condition poller, extracted from the harness when
 * its size crossed the file budget twice (the shims extraction was the
 * first). Awaits the getter until its value satisfies the chained matcher;
 * interval/timeout ride the 0-delay timer arm so a poll paces the real
 * event loop instead of spinning.
 */
export function attachExpectPoll(expect, makeExpect, failWith) {
  expect.poll = (getter, options = {}) => {
    if (typeof getter !== 'function') {
      failWith('expect.poll: getter must be a function');
    }
    const interval = options.interval ?? 50;
    const timeout = options.timeout ?? 1000;
    const sleep = (ms) => new Promise((resolve) => { globalThis.setTimeout(resolve, ms); });
    const run = async (matcherName, args) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        let value;
        try { value = getter(); } catch (error) { value = error; }
        const assertion = makeExpect(value);
        try {
          const maybe = assertion[matcherName](...args);
          if (maybe && typeof maybe.then === 'function') await maybe;
          return; // satisfied
        } catch { /* not yet */ }
        if (Date.now() >= deadline) {
          failWith(`expect.poll: timed out after ${timeout}ms waiting for ${matcherName} (last value: ${String(value)})`);
        }
        await sleep(interval);
      }
    };
    return new Proxy({}, {
      get: (_target, matcherName) => {
        if (typeof matcherName !== 'string') return undefined;
        return (...args) => run(matcherName, ...args);
      },
    });
  };
}
