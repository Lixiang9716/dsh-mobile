// dsh:logging-exempt (test shim: the runtime's bare 'logger.js' import,
// resolved by vitest.config.js's alias — silent here, the runtime's real
// logger logs)
export const createLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});
