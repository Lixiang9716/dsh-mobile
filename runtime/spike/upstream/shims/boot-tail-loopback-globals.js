// dsh:logging-exempt (shim layer; no logging surface in the hot path)
/**
 * shims/boot-tail-loopback-globals.js — the free-variable fallbacks the
 * SPLIT loopback shims reach for across file boundaries (W8, 2026-09-29).
 *
 * node-http-loopback.js grew two split-off siblings (client/dispatch) when
 * it crossed the code-size budget, and the split left five cross-file
 * references without their import lines:
 *
 *   - client.js uses encodeUtf8 (:48 marker scan, :275 upgrade request
 *     head) and decodeUtf8 (:70 response head) as free variables — the
 *     loopback.js originals import them from shims/buffer.js; the client
 *     sibling's import never made the split. First call site is the
 *     timer-drained http.request face — the gateway stream-server and
 *     inspector endpoint suites die at boot on it (gateway.js:253 →
 *     timers → client:275: `ReferenceError: encodeUtf8 is not defined`).
 *   - client.js uses serverUpgradeIngress (:281) and clientUpgradeAwait
 *     (:282) — dispatch.js defines and EXPORTS both; the import line is
 *     missing on the client side.
 *   - dispatch.js uses findHeaderEnd (:291,:328), concatChunks
 *     (:293,:330), HEADER_END (:295,:332) and parseHttpHead — inside those
 *     same exported upgrade helpers — all four live in client.js as
 *     UNEXPORTED consts, so no import could even express them.
 *
 * The split files are outside this worker's file lease, so the repair
 * rides the import chain instead: this module pins the names on
 * globalThis so every free reference RESOLVES, and is imported by
 * shims/buffer.js — the module the loopback family already imports the
 * utf8 helpers' canonical definitions from (loopback.js:31), which places
 * the pin's evaluation ahead of every call site on every path that
 * reaches them (the references are call-time lookups, not link-time).
 * Free-variable fallback ONLY: no pin ever shadows an existing binding.
 * The utf8 delegation goes THROUGH THE NAMESPACE at call time — this
 * module sits inside buffer.js's own import cycle, so module-scope reads
 * of those bindings would be TDZ; by the time any call site runs,
 * buffer.js's evaluation is long complete. findHeaderEnd/concatChunks/
 * HEADER_END are byte-exact replicas of client.js's private helpers (pure
 * functions over (chunks, totalLength) + the CRLF terminator constant) —
 * the one duplication the unexported-const shape forces; dispatch.js's
 * serverUpgradeIngress/clientUpgradeAwait bind to the REAL exports.
 */
import * as buffer from 'upstream/shims/buffer.js';
import {
  serverUpgradeIngress,
  clientUpgradeAwait,
} from 'upstream/shims/node-http-loopback-dispatch.js';

if (typeof globalThis.encodeUtf8 === 'undefined') {
  globalThis.encodeUtf8 = (...args) => buffer.encodeUtf8(...args);
}
if (typeof globalThis.decodeUtf8 === 'undefined') {
  globalThis.decodeUtf8 = (...args) => buffer.decodeUtf8(...args);
}
if (typeof globalThis.serverUpgradeIngress === 'undefined') {
  globalThis.serverUpgradeIngress = serverUpgradeIngress;
}
if (typeof globalThis.clientUpgradeAwait === 'undefined') {
  globalThis.clientUpgradeAwait = clientUpgradeAwait;
}

// The four client.js-private helpers dispatch.js's upgrade path calls —
// verbatim replicas of client.js:37-86 (read side by side at review time).
const HEADER_END = '\r\n\r\n';
if (typeof globalThis.HEADER_END === 'undefined') {
  globalThis.HEADER_END = HEADER_END;
}
if (typeof globalThis.findHeaderEnd === 'undefined') {
  globalThis.findHeaderEnd = (chunks, totalLength) => {
    if (chunks.length === 0) return -1;
    const whole = chunks.length === 1 ? chunks[0] : (() => {
      const all = new Uint8Array(totalLength);
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.byteLength; }
      return all;
    })();
    const marker = globalThis.encodeUtf8(HEADER_END);
    outer: for (let i = 0; i + marker.length <= whole.length; i++) {
      for (let j = 0; j < marker.length; j++) {
        if (whole[i + j] !== marker[j]) continue outer;
      }
      return i;
    }
    return -1;
  };
}
if (typeof globalThis.concatChunks === 'undefined') {
  globalThis.concatChunks = (chunks, totalLength) => {
    if (chunks.length === 1) return chunks[0];
    const all = new Uint8Array(totalLength);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.byteLength; }
    return all;
  };
}
if (typeof globalThis.parseHttpHead === 'undefined') {
  globalThis.parseHttpHead = (headBytes) => {
    const text = globalThis.decodeUtf8(headBytes);
    const lines = text.split('\r\n');
    const firstLine = lines[0];
    const headers = Object.create(null);
    const rawHeaders = [];
    for (const line of lines.slice(1)) {
      if (line.length === 0) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      rawHeaders.push(name, value);
      headers[name.toLowerCase()] = value;
    }
    return { firstLine, headers, rawHeaders };
  };
}
