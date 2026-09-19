// dsh:logging-exempt (this IS the logger — nothing to log through)
/**
 * Spike port of runtime/logger/index.ts: the same createLogger contract,
 * plain ESM so the quickjs-ng shim loads it without a bundler. Debug-only
 * by construction (spike builds never define the release flag); the sink
 * receives ONE JSON line so every platform emits byte-identical E2E lines.
 */
export function createLogger(module) {
  const bind = (level) => (message, ...data) =>
    globalThis.__DSH_LOG_SINK__?.(JSON.stringify({ level, module, message, data }));
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
  };
}
