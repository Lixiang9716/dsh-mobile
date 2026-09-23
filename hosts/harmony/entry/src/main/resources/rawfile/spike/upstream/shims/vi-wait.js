// dsh:logging-exempt (test-harness surface)
/**
 * vi.waitFor / vi.waitUntil — vitest's condition pollers, extracted from the
 * harness when its size crossed the file budget (the expect.poll extraction
 * was the first). Both ride the 0-delay timer arm on the v1.4.0 seam:
 * waitFor retries while the callback throws and resolves with its value;
 * waitUntil polls until the value is truthy (measured 2026-09-23:
 * resume.spec's close-swallow races synchronize on vi.waitFor).
 */
export function attachViWaits(viApi, failWith) {
  viApi.waitFor = async (callback, options = {}) => {
    const interval = options.interval ?? 50;
    const deadline = Date.now() + (options.timeout ?? 5000);
    let lastError;
    for (;;) {
      try {
        return await callback();
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        failWith(`vi.waitFor: timed out after ${options.timeout ?? 5000}ms (last error: ${lastError?.message ?? String(lastError)})`);
      }
      await new Promise((resolve) => { globalThis.setTimeout(resolve, interval); });
    }
  };
  viApi.waitUntil = async (callback, options = {}) => {
    const interval = options.interval ?? 50;
    const deadline = Date.now() + (options.timeout ?? 5000);
    for (;;) {
      const value = await callback();
      if (value) return value;
      if (Date.now() >= deadline) {
        failWith(`vi.waitUntil: timed out after ${options.timeout ?? 5000}ms`);
      }
      await new Promise((resolve) => { globalThis.setTimeout(resolve, interval); });
    }
  };
}
