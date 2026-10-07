// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:perf_hooks — the timing surface the vendored session-persistence
 * family reads (performance.now() for elapsed-time accounting). The spike
 * has no monotonic clock exposed to JS, so Date.now()'s millisecond
 * resolution is the honest ceiling; consumers needing sub-ms deltas get
 * quantized ones rather than fabricated precision.
 */
export const performance = {
  now() { return Date.now(); },
  timeOrigin: Date.now(),
};
export default { performance };
