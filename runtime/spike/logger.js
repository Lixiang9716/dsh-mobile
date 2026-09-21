// dsh:logging-exempt (this IS the logger — nothing to log through)
/**
 * Spike port of runtime/logger/index.ts: the same createLogger contract,
 * plain ESM so the quickjs-ng shim loads it without a bundler. The sink
 * receives ONE JSON line so every platform emits byte-identical E2E lines.
 *
 * Release builds are STRIPPED AT THE SOURCE: the platform hosts compile
 * runtime/spike/host/dsh_spike_host.c with -DDSH_RELEASE, and
 * dsh_bind_globals() then injects `globalThis.__DSH_RELEASE__ = true` before
 * the bundle evaluates (see the host's comment — the flag arrives at
 * context-bind time, never as a rewritten copy of this file, so every
 * embedded logger.js stays byte-identical to this canonical one). When the
 * flag is set, createLogger returns a logger whose debug/info are no-ops and
 * whose warn/error still reach the sink: a distribution build keeps the
 * critical set and emits no per-event E2E stream.
 */
export function createLogger(module) {
  const bind = (level) => (message, ...data) =>
    globalThis.__DSH_LOG_SINK__?.(JSON.stringify({ level, module, message, data }));
  if (globalThis.__DSH_RELEASE__ === true) {
    return {
      debug() {},
      info() {},
      warn: bind('warn'),
      error: bind('error'),
    };
  }
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
  };
}
