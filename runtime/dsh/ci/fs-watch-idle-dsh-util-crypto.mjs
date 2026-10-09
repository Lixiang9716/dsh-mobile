// dsh:logging-exempt (node-side test vehicle: its stdout IS the product)
/**
 * fs-watch-idle-dsh-util-crypto — the `dsh:util-crypto` virtual module the
 * quickjs host injects (gateway.js imports bytesToBase64 from it at link
 * time), stubbed for the node-side probe over Node's own Buffer. The probe
 * never crosses this seam (no base64 body traffic — only the timer face is
 * exercised); the stub exists purely so the REAL gateway module links.
 */
export const bytesToBase64 = (bytes) => Buffer.from(bytes).toString('base64');
