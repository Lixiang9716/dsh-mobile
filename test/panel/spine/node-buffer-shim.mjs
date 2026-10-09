// node-buffer-shim.mjs — the spine suite's node:buffer face. On the device
// the HOST's node:buffer shim carries the UTF-8 helpers the runtime sources
// import alongside the real buffer API (llm-route.js, preset-mobile-rows.js,
// web-write-llm.js: `import { encodeUtf8, decodeUtf8 } from 'node:buffer'`);
// plain Node's node:buffer lacks both. Same bytes semantics, one face.
//
// Namespace re-export (`export * from`) — the runtime only imports
// encodeUtf8/decodeUtf8 by name plus the default-ish surface; a fixed named
// list would fight Node's own export drift across versions.
export * from 'node:buffer';

const encodeUtf8 = (text) => {
  const bytes = [];
  for (const point of String(text)) {
    const value = point.codePointAt(0);
    if (value < 0x80) bytes.push(value);
    else if (value < 0x800) bytes.push(0xc0 | (value >> 6), 0x80 | (value & 63));
    else if (value < 0x10000) bytes.push(0xe0 | (value >> 12), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
    else bytes.push(0xf0 | (value >> 18), 0x80 | ((value >> 12) & 63), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
  }
  return Uint8Array.from(bytes);
};

const decodeUtf8 = (bytes) => new TextDecoder().decode(bytes);

export { encodeUtf8, decodeUtf8 };
