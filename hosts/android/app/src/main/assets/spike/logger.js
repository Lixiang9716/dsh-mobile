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
 *
 * This module owns the release policy for EVERY writer on the unified sink,
 * not just createLogger. upstream/web-shims.js (the forwarding console) and
 * upstream/boot.js (the cordis logger exporter) call releaseKeeps() instead
 * of re-reading the flag, because a policy that lives in one file while its
 * siblings write unconditionally is the defect class this header exists to
 * prevent: the strip then holds only while those siblings happen to stay
 * quiet, not because the flag says so.
 */

/** The levels a release build KEEPS — the critical set. Every other level is
 * stripped there: debug/info are the per-event E2E stream (a harness
 * artifact), warn/error are the operator signal a distribution build owes
 * its user. One list, read by every sink writer. */
export const RELEASE_CRITICAL_LEVELS = ['warn', 'error'];

/** The ONE release policy: does `level` reach the sink in THIS build?
 * Debug keeps everything; a release build keeps RELEASE_CRITICAL_LEVELS and
 * drops the rest — never the reverse, so warn/error are never swallowed. */
export function releaseKeeps(level) {
  return globalThis.__DSH_RELEASE__ !== true || RELEASE_CRITICAL_LEVELS.includes(level);
}

export function createLogger(module) {
  const bind = (level) => (message, ...data) =>
    globalThis.__DSH_LOG_SINK__?.(JSON.stringify({ level, module, message, data }));
  // The predicate is authoritative; the no-op table is the "strip at the
  // source" shape the shipped hosts embed (and the logging gate's L4b pins),
  // so the release branch stays literal rather than derived. The sink probe
  // (artifacts/release-logging/probe/sink-probe.js) asserts that this table
  // and RELEASE_CRITICAL_LEVELS cannot drift apart.
  if (!releaseKeeps('debug')) {
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
