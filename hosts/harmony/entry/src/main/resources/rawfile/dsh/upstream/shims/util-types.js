// dsh:logging-exempt (shim layer)
/**
 * node:util/types shim — the members the vendored closure imports plus the
 * common predicates, so future slices link without widening this file.
 *
 * Covers (upstream usage → this module):
 *   - dsh-agent (`isPromise`) — agent-loop dispatch guards.
 *
 * Intentionally NOT supported: isTypedArray-style checks that would need
 * platform buffers beyond JSON-safe data (fail via `false`, which is the
 * honest answer for a runtime without typed buffers in those paths).
 */
export const isPromise = (value) =>
  value instanceof Promise ||
  (value !== null && typeof value === 'object' &&
    typeof value.then === 'function' && typeof value.catch === 'function');

export const isDate = (value) => value instanceof Date;
export const isRegExp = (value) => value instanceof RegExp;
export const isMap = (value) => value instanceof Map;
export const isSet = (value) => value instanceof Set;
export const isError = (value) => value instanceof Error;
export const isArrayObject = (value) => Array.isArray(value);
export const isAnyArrayBuffer = (value) =>
  value instanceof ArrayBuffer ||
  (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer);
export const isArrayBufferView = (value) =>
  isAnyArrayBuffer(value?.buffer) && typeof value.byteLength === 'number';
export const isUint8Array = (value) => value instanceof Uint8Array;
export const isStringObject = () => false;
export const isNumberObject = () => false;
export const isBooleanObject = () => false;
export const isSymbolObject = () => false;
export const isBoxedPrimitive = (value) =>
  isStringObject(value) || isNumberObject(value) || isBooleanObject(value) || isSymbolObject(value);
