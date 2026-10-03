// dsh:logging-exempt (test shim: base64 IS the fixture plumbing)
/**
 * util-crypto-shim.js — the `dsh:util-crypto` face the real spike gateway
 * (runtime/spike/gateway.js, reached through web-write-marketplace.js's
 * relative import) needs under node: the vendored package's base64 helper,
 * spelled over the platform Buffer. Only bytesToBase64 runs in tests — the
 * decode side is the gateway's own hand-rolled table.
 */
export const bytesToBase64 = (bytes) => Buffer.from(bytes).toString('base64');
