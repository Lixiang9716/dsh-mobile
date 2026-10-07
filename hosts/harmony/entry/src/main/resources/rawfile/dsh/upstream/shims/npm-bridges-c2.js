// dsh:logging-exempt (shim layer; specifier registration, no logging surface)
/**
 * shims/npm-bridges-c2.js — the second half of the third bridge-row fragment
 * (the gfm/http2/stream/crypto rows and the W4-P vendor rows: compression, ws,
 * @xterm, readable-stream, the mime-types CJS chain), split from npm-bridges-c.js
 * when that file crossed the code-size budget (W9). PURE DATA — it imports
 * nothing from npm-bridges-c.js (a static import cycle between shims files
 * kills QuickJS at link); npm-bridges-c.js imports BRIDGES_C2 and re-exports
 * the [...BRIDGES_C1, ...BRIDGES_C2] concat AS BRIDGES_C, so npm-bridges.js
 * keeps spreading the same-named fragment into the registration array.
 */

const BRIDGES_C2 = [
  // @joplin/turndown-plugin-gfm 1.0.67 (the tool-web HTML→markdown GFM
  // rules; the lockfile pin, same upstream lockfile as the turndown 7.2.4
  // + @mixmark-io/domino faces already vendored). esbuild-CJS shape
  // (`exports.X = …` over a free `exports`) — the per-face adapter again;
  // the vendored tool-web lib imports the named `gfm` bundle.
  ['dsh-bridge-setup/gfm-cjs-scope', [
    "globalThis.module = { exports: {} };",
    "globalThis.exports = globalThis.module.exports;",
  ].join('\n')],
  ['@joplin/turndown-plugin-gfm', [
    "import 'dsh-bridge-setup/gfm-cjs-scope';",
    "import '/vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js';",
    "const gfmFace = globalThis.exports;",
    "delete globalThis.exports;",
    "delete globalThis.module;",
    "if (typeof gfmFace?.gfm !== 'function') {",
    "  throw new Error('npm-bridges: turndown-plugin-gfm CJS face evaluated to an unexpected shape');",
    "}",
    "export const gfm = gfmFace.gfm;",
    "export const highlightedCodeBlock = gfmFace.highlightedCodeBlock;",
    "export const strikethrough = gfmFace.strikethrough;",
    "export const tables = gfmFace.tables;",
    "export const taskListItems = gfmFace.taskListItems;",
    "export default gfmFace;",
  ].join('\n')],
  ['http2', [
    "const refuse = (name) => () => {",
    "  throw new Error('http2: ' + name + ' is not served in this runtime — no socket seam');",
    "};",
    "export const Http2ServerRequest = class {",
    "  constructor() { throw new Error('http2: Http2ServerRequest is not served in this runtime — no socket seam'); }",
    "};",
    "export const constants = Object.freeze({ HTTP2_HEADER_STATUS: ':status', NGHTTP2_NO_ERROR: 0 });",
    "export const connect = refuse('connect');",
    "export const createServer = refuse('createServer');",
  ].join(' ')],
  ['stream', "export * from 'upstream/shims/node-stream.js';\nexport { default } from 'upstream/shims/node-stream.js';"],
  ['crypto', [
    "import * as nodeCrypto from 'upstream/shims/crypto.js';",
    "export * from 'upstream/shims/crypto.js';",
    "export default nodeCrypto;",
  ].join('\n')],

  // ---- W4-P (2026-09-28) vendor rows ----
  // node:net (W8, 2026-09-29): shadows the runtime-modules stub with the
  // RAW loopback dial face — net.connect/createConnection pair a
  // LoopbackNetSocket against the registry record's server half through
  // serverUpgradeIngress (the same head-parser the http.request UPGRADE
  // branch rides), so the webserver spec's raw-socket upgrade dials reach
  // its registered upgrade routes with node's event shapes ('connect'/
  // 'ready'/'data'/'close', ECONNREFUSED error on an unregistered target).
  // isIP/isIPv4/isIPv6 stay the real string classifiers; Socket/
  // StreamDuplex/createServer keep failing loud (no general socket seam).
  // A second __dshModuleDefine(name, source) REPLACES the earlier row (the
  // host seam's replay semantics), and this fragment evaluates after
  // runtime-modules (web-shims → globals → runtime-modules, THEN
  // npm-bridges → this table).



  // compression 1.8.1: the vendored dsh-host-webserver imports it for the
  // optional gzip middleware (config `compression: 'gzip'`; the DEFAULT is
  // 'none', under which the middleware object is only CREATED, never run).
  ['compression', [
    "import { gzipSync } from 'upstream/shims/node-zlib.js';",
    "import { encodeUtf8 } from 'upstream/shims/buffer.js';",
    "const mimeDb = JSON.parse(globalThis.__dshBundleRequire(",
    "  '/vendor/npm/mime-db@1.54.0/index.js', './db.json'));",
    // The compressible package's decision order over mime-db: the db entry
    // first, then the text/* and structured-suffix fallbacks.
    "const compressible = (type) => {",
    "  if (typeof type !== 'string' || type.length === 0) return false;",
    "  const mime = type.split(';')[0].trim().toLowerCase();",
    "  const entry = mimeDb[mime];",
    "  if (entry && entry.compressible !== undefined) return entry.compressible === true;",
    "  if (mime.startsWith('text/')) return true;",
    "  return /\\+(json|xml|text|yaml|proto)$/i.test(mime);",
    "};",
    "const shouldCompress = (req, res) => compressible(String(res.getHeader('content-type') ?? ''));",
    "const concatBytes = (chunks, total) => {",
    "  if (chunks.length === 1) return chunks[0];",
    "  const all = new Uint8Array(total);",
    "  let at = 0;",
    "  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }",
    "  return all;",
    "};",
    "const toBytes = (value) => {",
    "  if (typeof value === 'string') return encodeUtf8(value);",
    "  if (value instanceof Uint8Array) return value;",
    "  if (value instanceof ArrayBuffer) return new Uint8Array(value);",
    "  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);",
    "  return encodeUtf8(String(value));",
    "};",
    "const compression = (options = {}) => {",
    "  const opts = { threshold: 1024, level: 6, filter: shouldCompress, ...options };",
    "  return (req, res, next) => {",
    "    let nonted = false;",
    "    let encoding = null;",
    "    const chunks = [];",
    "    let total = 0;",
    "    res.on('headers', () => {",
    "      if (!opts.filter(req, res)) { nonted = true; return; }",
    "      const existingVary = res.getHeader('vary');",
    "      res.setHeader('Vary', existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding');",
    "      if (res.getHeader('content-encoding') !== undefined) { nonted = true; return; }",
    "      const length = res.getHeader('content-length');",
    "      if (length !== undefined && length !== null && Number(length) < opts.threshold) return;",
    "      const accept = String(req.headers?.['accept-encoding'] ?? 'identity');",
    "      encoding = accept.includes('gzip') ? 'gzip' : accept.includes('deflate') ? 'deflate' : null;",
    "      if (encoding === null) return;",
    "      res.setHeader('Content-Encoding', encoding);",
    "      res.removeHeader('Content-Length');",
    "    });",
    "    const originalWrite = res.write.bind(res);",
    "    const originalEnd = res.end.bind(res);",
    "    res.write = (chunk, ...rest) => {",
    "      if (!nonted && encoding !== null && chunk !== undefined && chunk !== null) {",
    "        const bytes = toBytes(chunk);",
    "        chunks.push(bytes);",
    "        total += bytes.byteLength;",
    "        return true;",
    "      }",
    "      return originalWrite(chunk, ...rest);",
    "    };",
    "    res.end = (chunk, ...rest) => {",
    "      if (nonted || encoding === null) return originalEnd(chunk, ...rest);",
    "      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {",
    "        const bytes = toBytes(chunk);",
    "        chunks.push(bytes);",
    "        total += bytes.byteLength;",
    "      }",
    "      if (total === 0) return originalEnd();",
    "      const compressed = gzipSync(concatBytes(chunks, total), { level: opts.level });",
    "      return originalEnd(compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength));",
    "    };",
    "    next();",
    "  };",
    "};",
    "compression.filter = shouldCompress;",
    "compression.compress = () => { throw new Error('compression.compress: the cache-push face has no store in this runtime'); };",
    "export default compression;",
  ].join('\n')],

  // ws 8.21.0 (W5-Q 2026-09-28): the REAL vendored lib, loaded through the
  // userland CJS loader (the published face is CommonJS with relative lib/
  // requires). Its bare requires (events/http/https/net/tls/crypto/stream/
  // url/util/buffer/zlib) are satisfied by the builtin faces registered
  // below BEFORE the entry evaluates — CJS evaluation is synchronous, so
  // static ESM imports of the shims land in the cjs-loader's face table
  // first. The HTTP transport rides the loopback: an UPGRADE-shaped
  // http.request pairs in-memory LoopbackSockets with the registry server
  // (node-http-loopback.js), so the real ws framing runs on both ends with
  // no OS socket and no second process/thread (D2 holds). `tls`/`https` are
  // linkage faces (wss:// is a desktop transport — never dialable here);
  // `net.connect` is only ws's DEFAULT createConnection, which the loopback
  // dispatch deliberately bypasses.
  ['ws', [
    "import * as __ws_crypto from 'upstream/shims/crypto.js';",
    "import * as __ws_events from 'upstream/shims/events.js';",
    "import * as __ws_stream from 'upstream/shims/node-stream.js';",
    "import * as __ws_buffer from 'upstream/shims/buffer.js';",
    "import * as __ws_url from 'upstream/shims/url.js';",
    "import * as __ws_zlib from 'upstream/shims/node-zlib.js';",
    "import * as __ws_http from 'node:http';",
    "import * as __ws_net from 'node:net';",
    "import * as __ws_tls from 'node:tls';",
    "import { registerBuiltinFace, requireCjsPackage } from 'upstream/shims/cjs-loader.js';",
    "const __ws_EventEmitter = __ws_events.EventEmitter;",
    "__ws_EventEmitter.EventEmitter = __ws_EventEmitter;",
    "registerBuiltinFace('crypto', __ws_crypto);",
    "registerBuiltinFace('events', __ws_EventEmitter);",
    "registerBuiltinFace('stream', __ws_stream);",
    "registerBuiltinFace('buffer', { ...__ws_buffer, isUtf8: __ws_buffer.isUtf8 });",
    "registerBuiltinFace('url', { URL: __ws_url.DshURL, pathToFileURL: __ws_url.pathToFileURL, fileURLToPath: __ws_url.fileURLToPath, default: __ws_url.default });",
    "registerBuiltinFace('util', { types: { isUint8Array: (v) => v instanceof Uint8Array } });",
    "registerBuiltinFace('zlib', __ws_zlib);",
    "registerBuiltinFace('http', __ws_http);",
    "registerBuiltinFace('net', __ws_net);",
    "registerBuiltinFace('tls', __ws_tls);",
    "registerBuiltinFace('https', { request: () => { throw new Error('node:https: request is not served in this runtime — no TLS transport (wss:// is a desktop capability)'); }, get: () => { throw new Error('node:https: get is not served in this runtime — no TLS transport'); } });",
    "const ws = requireCjsPackage('/vendor/npm/ws@8.21.0');",
    "export const WebSocketServer = ws.WebSocketServer;",
    "export const WebSocket = ws.WebSocket;",
    "export const Receiver = ws.Receiver;",
    "export const Sender = ws.Sender;",
    "export default ws;",
  ].join('\n')],

  // @xterm/headless 6.0.0 + @xterm/addon-serialize 0.14.0 (W7-X1): the REAL
  // vendored CJS bundles through requireCjsPackage (the ws pattern). The
  // operative mapping for the staged specs is the cjs-loader BARE_PACKAGES
  // table — their only face is createLazyRequire(name, import.meta.url)'s
  // require() (node:module routes bare requests through bareCjsPackages) —
  // these rows mirror the table for any ESM spelling of the bare names.
  // Both bundles are self-contained webpack CJS with zero require() calls
  // (measured 2026-09-28): no builtin faces to register. Named exports are
  // the bundles' own assignment lists (Terminal; SerializeAddon) — the only
  // members the staged specs bind.
  ['@xterm/headless', [
    "import { requireCjsPackage } from 'upstream/shims/cjs-loader.js';",
    "const headless = requireCjsPackage('/vendor/npm/@xterm/headless@6.0.0');",
    "export const Terminal = headless.Terminal;",
    "export default headless;",
  ].join('\n')],
  ['@xterm/addon-serialize', [
    "import { requireCjsPackage } from 'upstream/shims/cjs-loader.js';",
    "const serialize = requireCjsPackage('/vendor/npm/@xterm/addon-serialize@0.14.0');",
    "export const SerializeAddon = serialize.SerializeAddon;",
    "export default serialize;",
  ].join('\n')],

  // sharp — the D-c face (2026-09-29): NOT the upstream binary package (the
  // libvips native module cannot ride a QuickJS closure), but our pure-JS
  // adaptation package over the vendored pngjs 5.0.0 / jpeg-js 0.4.4 /
  // fflate 0.8.2 pins plus the hand-written GIF/WebP/SVG codecs in
  // upstream/shims/sharp/. The operative mapping for the staged specs is the
  // cjs-loader BARE_PACKAGES row — attachment-local's createLazyRequire
  // ('sharp', import.meta.url) reaches it through node:module's bare routing
  // — this row mirrors the table for the ESM spelling the four attachment
  // specs import directly (the @xterm pattern). Only a default export: the
  // specs bind sharp's callable and everything else is type-only.
  ['sharp', [
    "import { requireCjsPackage } from 'upstream/shims/cjs-loader.js';",
    "const sharp = requireCjsPackage('/upstream/shims/sharp');",
    "export default sharp;",
  ].join('\n')],

  // readable-stream (the webworker-runtime node-builtin limbs: fs streams
  // build on the default export's classes AND its statics — the module-
  // scope destructure + getDefaultHighWaterMark() call runs at LOAD, so
  // the face must be complete). Mapped onto THIS runtime's stream face:
  // the same node-stream shim every other spec rides, plus the node:stream
  // utility surface the limbs destructured (behaviorally honest: the
  // statics read the shim's own destroyed/errored flags). Transform is a
  // through-mode Duplex alias (the corpus drives it only as a pass-through;
  // documented delta).
  ['readable-stream', [
    // DEFAULT-ONLY face: the limbs destructure every face off the default
    // (`var { Readable, ..., Transform, ... } = Stream`), so named exports
    // are unnecessary — and a top-level `export const Transform` collides
    // with a host global (quickjs: invalid redefinition, measured). The
    // statics are the node:stream utility surface the limbs call at load;
    // Transform is a through-mode Duplex alias (documented delta).
    "import nodeStream, { Readable, Writable, Duplex, PassThrough, pipeline } from 'upstream/shims/node-stream.js';",
    "const state = { defaultHwm: 64 * 1024 };",
    "const streamStatics = {",
    "  getDefaultHighWaterMark: (objectMode) => (objectMode ? 16 : state.defaultHwm),",
    "  setDefaultHighWaterMark: (objectMode, value) => { if (!objectMode) state.defaultHwm = value; },",
    "  isDestroyed: (stream) => Boolean(stream && stream.destroyed),",
    "  isWritable: (stream) => Boolean(stream && !stream.destroyed),",
    "  isErrored: (stream) => Boolean(stream && stream.errored),",
    "  isReadable: (stream) => Boolean(stream && stream.readable !== false),",
    "  destroy: (stream, error) => stream.destroy(error),",
    "  finished: (stream, cb) => {",
    "    stream.once?.('end', () => cb());",
    "    stream.once?.('error', (error) => cb(error));",
    "    stream.once?.('close', () => cb());",
    "  },",
    "  addAbortSignal: (signal, stream) => {",
    "    signal?.addEventListener('abort', () => stream.destroy(new Error('The operation was aborted')));",
    "    return stream;",
    "  },",
    "  compose: () => { throw new Error('readable-stream: compose is not served in this runtime'); },",
    "  promises: null,",
    "};",
    "streamStatics.promises = { pipeline, finished: streamStatics.finished };",
    "const Transform = function (options) { return new Duplex(options); };",
    "const readableStream = Object.assign({ Readable, Writable, Duplex, PassThrough, Transform, pipeline }, streamStatics);",
    "readableStream.Stream = readableStream; // node: the Stream base carries the statics (the limbs destructure them off it)",
    "export default readableStream;",
  ].join('\n')],

  // mime-types 3.0.2 (+ mime-db 1.54.0, W5-T): the vendored
  // dsh-api-session-controller imports mime-types bare for every media arm
  // (the media-references spec's family). CJS: index.js requires mime-db +
  // 'path' + './mimeScore'; mimeScore REBINDS module.exports — exactly the
  // shape __dshCjsKeep exists for (the r3-P scope-rebind blocker, closed by
  // the generalized chain infra).
  ['dsh-bridge-setup/mime-cjs-0', [
    "import 'dsh-bridge-setup/cjs-chain-scope';",
    "import * as pathShim from 'upstream/shims/path.js';",
    "globalThis.__dshCjsFaces.set('path', pathShim);",
    // mime-db/index.js requires ./db.json (the vendored tree ships the JSON
    // beside it); pre-register the parsed face so the require lands.
    "globalThis.__dshCjsFaces.set('./db.json', JSON.parse(globalThis.__dshBundleRequire(",
    "  '/vendor/npm/mime-db@1.54.0/index.js', './db.json')));",
    "globalThis.__dshCjsSetup('mime-db');",
  ].join('\n')],
  ['dsh-bridge-setup/mime-cjs-1', [
    "import 'dsh-bridge-setup/mime-cjs-0';",
    "import '/vendor/npm/mime-db@1.54.0/index.js';",
    "globalThis.__dshCjsKeep('mime-db');",
    "globalThis.__dshCjsSetup('./mimeScore');",
  ].join('\n')],
  ['dsh-bridge-setup/mime-cjs-2', [
    "import 'dsh-bridge-setup/mime-cjs-1';",
    "import '/vendor/npm/mime-types@3.0.2/mimeScore.js';",
    "globalThis.__dshCjsKeep('./mimeScore');",
    "globalThis.__dshCjsSetup('index');",
  ].join('\n')],
  ['dsh-bridge-setup/mime-cjs-3', [
    "import 'dsh-bridge-setup/mime-cjs-2';",
    "import '/vendor/npm/mime-types@3.0.2/index.js';",
    "globalThis.__dshCjsKeep('index');",
    "globalThis.__dshMimeTypesFace = globalThis.module.exports;",
    "if (typeof globalThis.__dshMimeTypesFace?.lookup !== 'function') {",
    "  throw new Error('npm-bridges: mime-types CJS face evaluated to an unexpected shape');",
    "}",
  ].join('\n')],
];

export { BRIDGES_C2 };
