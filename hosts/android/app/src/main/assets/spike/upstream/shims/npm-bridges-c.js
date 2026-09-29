// dsh:logging-exempt (shim layer; specifier registration, no logging surface)
/**
 * shims/npm-bridges-c.js — the third bridge-row fragment (the composed
 * partial-json/undici faces and the CJS graph chain setup), split from
 * npm-bridges-b.js when that file crossed the code-size budget. Rows carry
 * their own module names; npm-bridges.js spreads this fragment into the
 * registration array.
 */

const BRIDGES_C = [
// partial-json — pi-ai's streaming tool-call parser (dist/utils/json-parse.js
  // imports { parse } — reached by EVERY lazy api load since json-parse.js is
  // in the openai-completions/openai-responses closure). NO vendored tarball
  // (never fetched); the composed completion-walk face is partial-json.js.
  ['partial-json', "export * from 'upstream/shims/partial-json.js';"],

  // undici — the Node HTTP engine dsh-http-proxy and dsh-web-fetch-http
  // dynamic-import. NO vendored tarball (heavy runtime package); the face is
  // composed over the loopback (undici.js): ProxyAgent routes re-dial the
  // in-test proxy server with the absolute-form request line, so the egress
  // specs' proxy records are real in-process observations, no sockets.
  ['undici', "export * from 'upstream/shims/undici.js';"],

  // @deepseek-ai/cordis-plugin-loader — the vendored lib subclassed so a
  // Loader built WITHOUT node's ESM internals still carries a working
  // `internal.import`. Upstream, `ModuleLoader.fromInternal()` reaches Node's
  // internal `internal/modules/esm/loader` (host C territory — unreachable
  // here), leaving `loader.internal` undefined; the plugin-package-inventory
  // specs wrap that face (`const internal = ctx.loader.internal`) and every
  // workspace-plugin composition needs it. The subclass installs the same
  // contract over OUR loader: parent-key-relative resolution for './'/'../'
  // (URL join against the passed baseUrl), package subpaths under the base's
  // node_modules (the workspace writes define `file://<canonical>` modules at
  // write time), absolute paths as file URLs, and the bare map last.
  ['@deepseek-ai/cordis-plugin-loader', [
    "import * as loaderLib from '/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js';",
    "const runtimeImport = async (specifier, baseUrl) => {",
    "  const candidates = [];",
    "  if (/^(file:|https?:)/.test(specifier)) candidates.push(specifier);",
    "  else if (specifier.startsWith('/')) candidates.push('file://' + specifier);",
    "  const base = typeof baseUrl === 'string' ? baseUrl : String(baseUrl?.href ?? '');",
    "  const baseDir = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/') + 1);",
    "  if (specifier.startsWith('./') || specifier.startsWith('../')) {",
    "    try { candidates.push(new URL(specifier, baseDir || 'file:///').href); } catch { /* bad base: bare fallback */ }",
    "  } else if (baseDir.startsWith('file:') && !/^(file:|https?:)/.test(specifier)) {",
    "    try { candidates.push(new URL('node_modules/' + specifier, baseDir).href); } catch { /* skip */ }",
    "  }",
    "  candidates.push(specifier);",
    "  let last;",
    "  for (const candidate of candidates) {",
    "    try { return await import(candidate); } catch (error) { last = error; }",
    "  }",
    "  throw last;",
    "};",
    "class Loader extends loaderLib.Loader {",
    "  constructor(...args) {",
    "    super(...args);",
    "    if (this.internal === undefined) {",
    "      this.internal = { version: 'v2', import: (specifier, baseUrl, _options) => runtimeImport(specifier, baseUrl) };",
    "    }",
    "  }",
    "}",
    "export * from '/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js';",
    "export { Loader };",
    "export default Loader;",
  ].join('\n')],

  // @modelcontextprotocol/server 2.0.0 (+ node adapter and the hono node
  // server face) — the acp bridge spec's MCP-over-HTTP limb. Nothing ever
  // listens on a socket in the suite, but the NODE-BUILTIN faces it links
  // against must exist: @hono/node-server imports bare 'http'/'http2'/
  // 'stream'/'crypto' (no node: prefix — the C shim map cannot name them).
  // http/http2 are linkage-only (the chokidar pattern: the members fail
  // loud when CALLED — there is no socket seam); stream/crypto re-export
  // the existing node:* shims so real work keeps working.
  ['@modelcontextprotocol/server',
    "export * from '/vendor/npm/@modelcontextprotocol/server@2.0.0/dist/index.mjs';"],
  ['@modelcontextprotocol/server/_shims',
    "export * from '/vendor/npm/@modelcontextprotocol/server@2.0.0/dist/shimsNode.mjs';"],
  // @modelcontextprotocol/node reads the node-ism `global` at module scope;
  // aliased to globalThis (??= — a future real global stays in charge).
  ['@modelcontextprotocol/node', [
    "import 'dsh-bridge-setup/globals';",
    "export * from '/vendor/npm/@modelcontextprotocol/node@2.0.0/dist/index.mjs';",
  ].join('\n')],
  ['@hono/node-server',
    "export * from '/vendor/npm/@hono/node-server@1.19.14/dist/index.mjs';"],
  ['os', [
    "import * as osShim from 'upstream/shims/os.js';",
    "export default new Proxy(osShim, {",
    "  get(t, k) {",
    "    if (k === 'networkInterfaces') return () => ({}); // no LAN surface in the sandbox: pickers fall back to loopback",
    "    const v = t[k];",
    "    return typeof v === 'function' ? v.bind(t) : v;",
    "  },",
    "});",
  ].join('\n')],
  // bare 'http' moved to the W5-T block below: it now re-exports the same
  // in-process loopback face runtime-modules serves as node:http.

  // ipaddr.js 2.5.0 (the web family's IP classifier: web-fetch-http's
  // loopback/unicast range checks + the tool-web specs' proxies). The
  // closure pins the lockfile's ^2.5.0 exact. The published face is
  // UMD/CommonJS ONLY (lib/ipaddr.js — `(function (root) { ... if (typeof
  // module !== 'undefined' && module.exports) module.exports = ipaddr; ...
  // }(this))`), which this loader cannot serve as ESM: with no global
  // `module` the free variable falls to the root branch and `this` is
  // undefined at ESM top level. The userland CJS adapter rides the same
  // evaluate-dependencies-first order as dsh-bridge-setup/globals: the
  // prelude row installs global `module`/`exports`, the vendored CJS file
  // then binds its exports against the globals, and the face row captures
  // them and hands the globals back (a later CJS evaluation must never see
  // a STALE exports object and silently bind to it). No vendored byte is
  // touched (D6); the classes are the pinned implementation.
  //
  // The scope is ONE PRELUDE MODULE PER CJS FACE: a module evaluates once
  // per runtime, so a shared scope row cannot hand the globals back after
  // the first face (the second face's file then evaluates against the
  // deletion and dies on "exports is not defined" — measured 2026-09-28
  // with the spill spec importing ipaddr before gfm). Dedicated scopes
  // keep every face's setup + handback self-contained.
  ['dsh-bridge-setup/ipaddr-cjs-scope', [
    "globalThis.module = { exports: {} };",
  ].join('\n')],
  ['ipaddr.js', [
    "import 'dsh-bridge-setup/ipaddr-cjs-scope';",
    "import '/vendor/npm/ipaddr.js@2.5.0/lib/ipaddr.js';",
    "const ipaddr = globalThis.module.exports;",
    "delete globalThis.module;",
    "if (typeof ipaddr?.parse !== 'function') {",
    "  throw new Error('npm-bridges: ipaddr.js CJS face evaluated to an unexpected shape');",
    "}",
    "export default ipaddr;",
    "export const IPv4 = ipaddr.IPv4;",
    "export const IPv6 = ipaddr.IPv6;",
  ].join('\n')],

  // ---- W5-T (2026-09-28) vendor rows ----
  // The @opentelemetry stack the session-telemetry-otel specs import (the
  // dsh-v0.1.6-alpha.2 lockfile's exact resolutions; every package ships a
  // build/esm ESM face, so each row is the real-path re-export pattern and
  // the faces' own relative imports resolve beside them). The egress spec
  // drives OTLPLogExporter against an in-test node:http server — the loopback
  // faces serve it (no socket).
  ['@opentelemetry/api', "export * from '/vendor/npm/@opentelemetry/api@1.9.1/build/esm/index.js';"],
  ['@opentelemetry/api-logs', "export * from '/vendor/npm/@opentelemetry/api-logs@0.220.0/build/esm/index.js';"],
  ['@opentelemetry/sdk-logs', "export * from '/vendor/npm/@opentelemetry/sdk-logs@0.220.0/build/esm/index.js';"],
  ['@opentelemetry/core', "export * from '/vendor/npm/@opentelemetry/core@2.10.0/build/esm/index.js';"],
  ['@opentelemetry/resources', "export * from '/vendor/npm/@opentelemetry/resources@2.10.0/build/esm/index.js';"],
  ['@opentelemetry/exporter-logs-otlp-http', "export * from '/vendor/npm/@opentelemetry/exporter-logs-otlp-http@0.220.0/build/esm/index.js';"],
  ['@opentelemetry/otlp-exporter-base', "export * from '/vendor/npm/@opentelemetry/otlp-exporter-base@0.220.0/build/esm/index.js';"],
  ['@opentelemetry/otlp-transformer', "export * from '/vendor/npm/@opentelemetry/otlp-transformer@0.220.0/build/esm/index.js';"],
  ['@opentelemetry/semantic-conventions', "export * from '/vendor/npm/@opentelemetry/semantic-conventions@1.43.0/build/esm/index.js';"],
  ['@opentelemetry/sdk-metrics', "export * from '/vendor/npm/@opentelemetry/sdk-metrics@2.9.0/build/esm/index.js';"],

  // The UNPREFIXED node-builtin specifiers the otel ESM faces import (the
  // C shim map keys on the node: spelling only). Each re-exports the same
  // shim module the node: face serves — one implementation instance.
  ['util', "import * as utilShim from 'upstream/shims/util.js';\nexport * from 'upstream/shims/util.js';\nexport default utilShim;"],
  ['fs', "export * from 'upstream/shims/fs.js';\nexport { default } from 'upstream/shims/fs.js';"],
  ['path', "export * from 'upstream/shims/path.js';\nexport { default } from 'upstream/shims/path.js';"],
  ['process', "export * from 'node:process';\nexport { default } from 'node:process';"],
  ['zlib', "export * from 'upstream/shims/node-zlib.js';\nexport { default } from 'upstream/shims/node-zlib.js';"],
  // Bare 'http' now rides the SAME in-process loopback face as node:http
  // (runtime-modules round 6) — the otel exporter's dynamic import('http')
  // dispatches through it like every other suite client. The old refuse-stub
  // predates the loopback round.
  ['http', [
    "import { createHttpFace } from 'upstream/shims/node-http-loopback.js';",
    "const http = createHttpFace();",
    "export default http;",
    "export const createServer = http.createServer;",
    "export const request = http.request;",
    "export const get = http.get;",
    "export const Server = http.Server;",
    "export const ServerResponse = http.ServerResponse;",
    "export const IncomingMessage = http.IncomingMessage;",
    "export const Agent = http.Agent;",
    "export const validateHeaderName = http.validateHeaderName;",
    "export const validateHeaderValue = http.validateHeaderValue;",
  ].join('\n')],
  // https: the real-wire TLS client — no socket seam (D2); the otel exporter
  // only reaches it for https:// endpoints, and the egress spec's in-test
  // server is http://127.0.0.1.
  ['https', [
    "const refuse = (name) => () => {",
    "  throw new Error('https: ' + name + ' is not served in this runtime — no socket seam');",
    "};",
    "export const request = refuse('request');",
    "export const get = refuse('get');",
    "export const createServer = refuse('createServer');",
    "export const Agent = class { constructor() { refuse('Agent'); } };",
    "export default { request, get, createServer, Agent };",
  ].join('\n')],
  // child_process: the subprocess seam is deliberately unprovided (rule D2);
  // the resources env-detectors link against it but only execute inside
  // container/VM detection paths the specs never drive.
  ['child_process', [
    "const refuse = (name) => () => {",
    "  throw new Error('child_process: ' + name + ' is not served in this runtime — no subprocess seam (rule D2)');",
    "};",
    "export const exec = refuse('exec');",
    "export const execFile = refuse('execFile');",
    "export const execSync = refuse('execSync');",
    "export const spawn = refuse('spawn');",
    "export const spawnSync = refuse('spawnSync');",
    "export const fork = refuse('fork');",
    "export default { exec, execFile, execSync, spawn, spawnSync, fork };",
  ].join('\n')],

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

// W8 (2026-09-29): the negotiator chain's content-type LOUD stub is the one
// thing the vendored webserver's gzip middleware cannot run without —
// negotiator 1.1.0's parseAccept drives content-type.parse(header,
// { comma: true, start }) once per accept member
// (vendor/npm/negotiator@1.1.0/lib/accept.js:29). The stub row lives in
// npm-bridges.js's BRIDGES array AFTER this fragment is spread in (its
// define() call lands later in the same synchronous loop, replacing any
// earlier same-name row), so this replacement is deferred one microtask: it
// lands after that loop finishes and long before any spec imports the chain
// (row sources are evaluated lazily per import). The link body is otherwise
// the original cjs-0 row's shape.
const negotiatorCjs0Replacement = [
  "import 'dsh-bridge-setup/cjs-chain-scope';",
  // content-type: the accept-member parse face — ONE member per call (the
  // caller loops via the returned index), type lowercased (the caller
  // re-slices original casing off the header), parameter keys lowercased /
  // values verbatim, index = the terminating comma position.
  "const parse = (header, options = {}) => {",
  "  const headerText = String(header ?? '');",
  "  let i = options.start ?? 0;",
  "  while (i < headerText.length && (headerText[i] === ' ' || headerText[i] === '\\t')) i += 1;",
  "  const typeStart = i;",
  "  while (i < headerText.length && headerText[i] !== ',' && headerText[i] !== ';' && headerText[i] !== ' ' && headerText[i] !== '\\t') i += 1;",
  "  const type = headerText.slice(typeStart, i).toLowerCase();",
  "  const parameters = {};",
  "  while (i < headerText.length && headerText[i] !== ',') {",
  "    while (i < headerText.length && (headerText[i] === ' ' || headerText[i] === '\\t' || headerText[i] === ';')) i += 1;",
  "    if (i >= headerText.length || headerText[i] === ',') break;",
  "    const keyStart = i;",
  "    while (i < headerText.length && headerText[i] !== '=' && headerText[i] !== ',' && headerText[i] !== ';') i += 1;",
  "    const key = headerText.slice(keyStart, i).trim().toLowerCase();",
  "    let value = '';",
  "    if (headerText[i] === '=') {",
  "      i += 1;",
  "      if (headerText[i] === '\"') {",
  "        i += 1;",
  "        const valueStart = i;",
  "        while (i < headerText.length && headerText[i] !== '\"') i += 1;",
  "        value = headerText.slice(valueStart, i);",
  "        i += 1;",
  "      } else {",
  "        const valueStart = i;",
  "        while (i < headerText.length && headerText[i] !== ',' && headerText[i] !== ';') i += 1;",
  "        value = headerText.slice(valueStart, i).trim();",
  "      }",
  "    }",
  "    if (key.length > 0) parameters[key] = value;",
  "  }",
  "  return { type, parameters, index: i };",
  "};",
  "const format = () => { throw new Error('content-type: format is not served in this runtime'); };",
  "globalThis.__dshCjsFaces.set('content-type', { parse, format });",
  "globalThis.__dshCjsSetup('./lib/accept');",
  "globalThis.__dshCjsFaces.set('./accept', globalThis.__dshCjsFaces.get('./lib/accept'));",
].join('\n');

queueMicrotask(() => {
  globalThis.__dshModuleDefine?.('dsh-bridge-setup/negotiator-cjs-0', negotiatorCjs0Replacement);
});

// W8 (2026-09-29): the node:net face define rides the same microtask as the
// negotiator-cjs-0 replacement — the suite harness re-imports globals.js under a
// second RELATIVE spelling ('../upstream/shims/globals.js' from scenario/), the
// loader does not canonicalize specifier spellings into one module record, and
// that second evaluation re-runs defineRuntimeModules() AFTER this fragment's
// synchronous define() would land, re-registering the OLD loud stub over it. A
// microtask deferral puts this define after every synchronous evaluation
// (including both globals.js evaluations) and before any spec imports 'node:net'
// (nothing imports it statically; instantiation is lazy).
const nodeNetFaceRow = [
    "import { connectLoopbackNet } from 'upstream/shims/node-http-loopback.js';",
    "const isIPv4 = (value) => {",
    "  if (typeof value !== 'string') return false;",
    "  const parts = value.split('.');",
    "  return parts.length === 4 && parts.every((p) => /^\\d{1,3}$/.test(p) && Number(p) <= 255 && (p.length === 1 || p[0] !== '0' || p === '0'));",
    "};",
    "const isIPv6 = (value) => typeof value === 'string' && value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value);",
    "const isIP = (value) => (isIPv4(value) ? 4 : isIPv6(value) ? 6 : 0);",
    "const net = {",
    "  isIP, isIPv4, isIPv6,",
    "  Socket: class { constructor() { throw new Error('node:net: Socket is not served in this runtime — the loopback connect face is the only raw transport'); } },",
    "  StreamDuplex: class { constructor() { throw new Error('node:net: StreamDuplex is not served in this runtime — no socket seam'); } },",
    "  connect: connectLoopbackNet,",
    "  createConnection: connectLoopbackNet,",
    "  createServer: () => { throw new Error('node:net: createServer is not served in this runtime — no socket seam'); },",
    "};",
    "export default net;",
    "export const Socket = net.Socket;",
    "export const StreamDuplex = net.StreamDuplex;",
    "export const connect = net.connect;",
    "export const createConnection = net.createConnection;",
    "export const createServer = net.createServer;",
    "export { isIP, isIPv4, isIPv6 };"
].join('\n');
queueMicrotask(() => {
  globalThis.__dshModuleDefine?.('node:net', nodeNetFaceRow);
});

// W8 (2026-09-29): the tool-web markdown class — under the suite leg's boot
// steps the domino face turndown captured at module load comes back missing
// createDocument ('not a function' at turndown.es.js:468; the vendored
// tool-web swallows the throw into '[HTML content omitted …]' — 6 tool-web +
// 1 integration failures). The documented shared-scope CJS hazard again
// (the ipaddr-before-gfm lesson in the compression comment): another
// chain's globals-capture dance runs between the domino graph's evaluation
// and its capture, and the captured exports lose members. The repair pins
// the CAPTURE TIMING, not the bytes: this async block runs right after the
// synchronous bridges pass (before the leg's boot steps and before any
// other CJS chain), evaluates the domino graph through the canonical
// cjs-loader machinery, and stashes the healthy face. globalThis.require is
// then armed to serve it for the one bare request turndown makes —
// dsh-bridge-setup/globals arms its own require with `??=`, so an
// already-armed require stays in charge and this IS the require
// turndown.es.js:466 later calls. Every other bare request delegates to the
// canonical makeRequire('/'). Same vendored bytes, same graph — capture
// order only.
(async () => {
  try {
    const { makeRequire } = await import('upstream/shims/cjs-loader.js');
    const canonicalRequire = makeRequire('/');
    const dominoFace = canonicalRequire('@mixmark-io/domino');
    if (dominoFace && typeof dominoFace.createDocument === 'function') {
      globalThis.__dshW8DominoFace = dominoFace;
      globalThis.require = (name) => (
        name === '@mixmark-io/domino' && globalThis.__dshW8DominoFace
          ? globalThis.__dshW8DominoFace
          : canonicalRequire(name)
      );
    }
  } catch {
    /* the canonical require stays armed; the failure stays visible at the
       call site instead of being masked here */
  }
})();

export { BRIDGES_C };
