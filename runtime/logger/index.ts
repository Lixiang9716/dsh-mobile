/**
 * Unified logging for dsh-mobile JS runtimes — the only permitted logging
 * surface. Bare `console.*` calls fail the `logging` gate.
 *
 * Debug builds emit everything through the host-provided sink
 * (`globalThis.__DSH_LOG_SINK__`, bound by the capability gateway).
 * Release builds compile to no-ops: `__DSH_RELEASE__` is a bundler define,
 * the branch folds away, and dead-code elimination removes every call site.
 *
 * File-level exemption marker: `// dsh:logging-exempt` (in the first lines)
 * — used here: the logging library itself has nothing to log to.
 */
// dsh:logging-exempt

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

/** Injected as a bundler define: true in release builds, absent in debug. */
declare const __DSH_RELEASE__: boolean;

interface LogSink {
  (level: LogLevel, module: string, message: string, data: unknown[]): void;
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function sink(): LogSink | undefined {
  return (globalThis as { __DSH_LOG_SINK__?: LogSink }).__DSH_LOG_SINK__;
}

function makeLogger(module: string): Logger {
  const bind = (level: LogLevel) => {
    return (message: string, ...data: unknown[]): void => {
      sink()?.(level, module, message, data);
    };
  };
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
}

export function createLogger(module: string): Logger {
  if (typeof __DSH_RELEASE__ !== 'undefined' && __DSH_RELEASE__) {
    return noopLogger;
  }
  return makeLogger(module);
}
