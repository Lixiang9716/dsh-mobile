// dsh:logging-exempt (shim layer; specifier registration, no logging surface)
/**
 * shims/runtime-modules.js — runtime module registrations for specifiers the
 * HOST LOADER cannot serve: the `__dshModuleDefine(name, source)` seam is
 * checked before the bare map (dsh_module_loader's documented order), so a
 * registration here both adds NEW node: builtins the SHIMS table lacks and
 * SHADOWS a broken vendored-probe resolution. The npm-bridges.js precedent
 * (npm packages), kept separate because those rows belong to the vendor
 * discipline while these belong to the node-face/package-shim discipline.
 *
 * Registered here (2026-09-27 suite round):
 *   - `node:string_decoder` → shims/string-decoder.js (the sdk protocol
 *     faces' chunk-boundary-safe UTF-8 decoder; the SHIMS table has no row
 *     and a `node:` miss fails loud in dsh_map_bare before any shim could).
 *   - `node:stream/promises` → pipeline (the node:stream shim's own) +
 *     finished(stream) over 'end'/'finish'/'close' with 'error' rejection.
 *   - `@deepseek-ai/dsh-session/types.js` + `@deepseek-ai/dsh-workflow/types`
 *     → the vendored lib/types/types.js re-export. The probe's shape list
 *     probes `lib/types` (the directory) FIRST for these stems and the
 *     directory read compiles as an export-less module, so the link fails
 *     with "Could not find export 'SessionLogOffset'/'WorkflowRunId'"; the
 *     registration pins the real file.
 *   - `@deepseek-ai/cordis` → the vendored lib PLUS `FiberState` (the
 *     pinned 4.0.2 predates the enum's export; its fiber.state numbers are
 *     the enum's — PENDING 0 / LOADING 1 / ACTIVE 2 / FAILED 3 / DISPOSED 4
 *     / UNLOADING 5, read off the same package's src/fiber.ts).
 *   - `@deepseek-ai/dsh-client-ui-renderer/client` → shims/dsh-client-ui-
 *     renderer-client.js (SlotRegistry; the vendored ./client face is a
 *     browser bundle with no ESM exports — see that file's header).
 *
 * Self-registering on import (the npm-bridges.js pattern); the suite
 * harness imports this via shims/globals.js BEFORE any spec loads. A second
 * define() replaces the source (the host seam's replay semantics), so a
 * later npm-bridges-style row for the same name wins rather than throws.
 */

const FIBER_STATE = 'export const FiberState = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 };';

// cordis 4.0.2 declares LoggerLevel as a `const enum` in src/logger.ts, so
// the published lib erases it — but the vendored consumer specs import it
// from @deepseek-ai/cordis and index it symbolically
// (`exporter.levels.default === LoggerLevel.WARN`). The numbers are the
// erased enum's own (src/logger.ts, same pinned package).
const LOGGER_LEVEL = 'export const LoggerLevel = { ERROR: 0, INFO: 1, WARN: 2, DEBUG: 3 };';

const STREAM_PROMISES = [
  "import { pipeline } from '/upstream/shims/node-stream.js';",
  'const finished = (stream, options = {}) => new Promise((resolve, reject) => {',
  '  let settled = false;',
  '  const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };',
  "  const done = () => settle(resolve);",
  "  if (typeof stream?.on !== 'function') { settle(reject, new TypeError('node:stream/promises.finished: an EventEmitter stream is required')); return; }",
  "  stream.once('end', done);",
  "  stream.once('finish', done);",
  "  stream.once('close', done);",
  "  stream.once('error', (error) => settle(reject, error));",
  '  if (options.cleanup === true) { /* no extra handles to drop in-memory */ }',
  '});',
  'export { pipeline, finished };',
  'export default { pipeline, finished };',
].join(' ');

// --- the __ModuleLoader__ client-bundle faces (2026-09-27 wave 2). The
// dsh client packages publish their /client faces as BROWSER bundles: one
// `window.__ModuleLoader__.load({ id, factory })` call whose factory takes
// a CommonJS `require` and RETURNS `module.exports`. The loader compiles
// such a file as ESM (its `var module = ...` is a plain script) and the
// link then fails with "Could not find export 'RemoteStream'" — the module
// executes into a local, unreachable `module.exports`. The runtime seam
// fixes this without touching vendored bytes (D6): web-shims.js (loaded
// FIRST by the suite leg) already provides the queue-mode
// `window.__ModuleLoader__` facade, so a registered row statically imports
// the bundle (its registration lands in the queue), drains OUR id, invokes
// `factory(require)` with a user-land require over statically imported
// namespaces, and re-exports the returned namespace object. The classes are
// the VENDORED implementations driven against spec-owned fakes — real
// semantics, zero porting drift. require map misses fail loud (rule 5).
const moduleLoaderFace = (id, bundlePath, deps, exportNames) => [
  ...deps.map(([spec, local]) => `import * as ${local} from '${spec}';`),
  `import '${bundlePath}';`,
  `const queue = globalThis.window.__ModuleLoader__.pendingQueue;`,
  `const at = queue.findIndex((registration) => registration.id === ${JSON.stringify(id)});`,
  `if (at < 0) throw new Error('runtime-modules: no queued __ModuleLoader__ registration for ${id}');`,
  `const [registration] = queue.splice(at, 1);`,
  `const DEPS = { ${deps.map(([spec, local]) => `${JSON.stringify(spec)}: ${local}`).join(', ')} };`,
  `const require_ = (name) => {`,
  `  if (name in DEPS) return DEPS[name];`,
  `  throw new Error('runtime-modules: ${id} bundle require is not served: ' + name);`,
  `};`,
  `const ns = registration.factory(require_);`,
  ...exportNames.map((name) => `export const ${name} = ns.${name};`),
  `export default ns;`,
].join('\n');

const REGISTRATIONS = [
['@deepseek-ai/dsh-api-gateway/client',
  moduleLoaderFace('@deepseek-ai/dsh-api-gateway',
    '/vendor/npm/@deepseek-ai/dsh-api-gateway@0.1.6-alpha.2/lib/client.js',
    [['@deepseek-ai/cordis', 'cordis']],
    ['RemoteJournalStream', 'RemoteSnapshotStream', 'RemoteStream',
      'RemoteStreamCarrierError', 'apply', 'cancelledFailure',
      'carrierFailure', 'inject', 'isRemoteFailure'])],

['@deepseek-ai/dsh-client-connection/client',
  moduleLoaderFace('@deepseek-ai/dsh-client-connection',
    '/vendor/npm/@deepseek-ai/dsh-client-connection@0.1.6-alpha.2/lib/client.js',
    [],
    ['RpcId', 'apply', 'inject', 'installConnection', 'transportError'])],
  ['node:string_decoder', "export { default as StringDecoder, default } from '/upstream/shims/string-decoder.js';"],
  ['node:stream/promises', STREAM_PROMISES],
  ['@deepseek-ai/dsh-session/types.js', "export * from '/vendor/dsh/session@0.1.6-alpha.2/lib/types/types.js';"],
  // The no-extension spelling: the probe's shape list resolves `lib/types`
  // to the DIRECTORY (an export-less module) before trying the file, so the
  // extensionless import surfaces the same "Could not find export" link
  // failure — this row pins the real file under that spelling too.
  ['@deepseek-ai/dsh-session/types', "export * from '/vendor/dsh/session@0.1.6-alpha.2/lib/types/types.js';"],
  ['@deepseek-ai/dsh-workflow/types', "export * from '/vendor/dsh/workflow@0.1.6-alpha.2/lib/types/types.js';"],
  // dsh-command-goal (the /goal row, mounted after the goal plane) imports
  // the commands brand outlet — lib/types/brand.js — under the package's
  // exports subpath; both spellings pin the real file (the dsh-session/types
  // precedent).
  ['@deepseek-ai/dsh-commands/brand.js', "export * from '/vendor/dsh/commands@0.1.6-alpha.2/lib/types/brand.js';"],
  ['@deepseek-ai/dsh-commands/brand', "export * from '/vendor/dsh/commands@0.1.6-alpha.2/lib/types/brand.js';"],
  // The client-web exports map spells the apply-injections face under a
  // DIFFERENT subpath than the file name ('./injections' →
  // ./lib/apply-injections.js): the vendored-package probe's lib/ + lib/types/
  // shapes can never hit an aliased name, so the row pins the real file (the
  // dsh-session/types precedent).
  ['@deepseek-ai/dsh-client-web/injections', "export * from '/vendor/npm/@deepseek-ai/dsh-client-web@0.1.6-alpha.2/lib/apply-injections.js';"],
  // The row is ALSO the trigger for the cordis-plugin-loader failure face:
  // whatever imports cordis first (a dsh lib, a spec, or the vendored loader
  // lib itself) evaluates the row, and the face file patches the vendored
  // loader's prototype methods on a microtask (deferred because when the
  // first cordis import arrives THROUGH the loader lib, its classes are
  // still mid-evaluation — see the face file's header). No npm-bridges row
  // needed, so the effect survives the npm-bridges split churn untouched.
  ['@deepseek-ai/cordis', [
    "import '/upstream/shims/cordis-loader-failure-face.js';",
    "export * from '/vendor/npm/cordis@4.0.2/lib/index.js';",
    FIBER_STATE,
    LOGGER_LEVEL,
  ].join(' ')],
  ['@deepseek-ai/dsh-client-ui-renderer/client', "export * from '/upstream/shims/dsh-client-ui-renderer-client.js';"],

  // @deepseek-ai/node-addon-system/landlock-run — the Landlock launcher's
  // JS API face (the flock precedent: a linkage shim with the source's own
  // absence semantics; see the shim's header). The 12-spec sandbox/ssh/
  // spill/workflow family loads it at module scope through the vendored
  // sandbox-local and spill-policy libs.
  ['@deepseek-ai/node-addon-system/landlock-run', "export * from '/upstream/shims/node-addon-system-landlock-run.js';"],

  // --- node: builtin faces the SHIMS table lacks (2026-09-27 suite round).
  // These live HERE, not in npm-bridges.js: they are node-face shims, and a
  // runtime-defined module wins the loader's first-check order, so this is
  // also where the old npm-bridges linkage stubs were FOLDED (C's handoff:
  // rows node:child_process / node:http / node:net moved in with real faces
  // where the runtime can express them).

  // node:tls — linkage only (the chokidar pattern): the ssh family's vendored
  // lib imports connect/createServer at module scope; no TLS socket seam
  // exists (no sockets at all), so every member fails loud when CALLED.
  ['node:tls', [
    "const refuse = (name) => () => {",
    "  throw new Error('node:tls: ' + name + ' is not served in this runtime — no socket seam (TLS transport is a desktop host capability)');",
    "};",
    "export const TLSSocket = class { constructor() { refuse('TLSSocket')(); } };",
    "export const Server = class { constructor() { refuse('Server')(); } };",
    "export const connect = refuse('connect');",
    "export const createServer = refuse('createServer');",
    "export default { TLSSocket: undefined, Server: undefined, connect, createServer };",
  ].join('\n')],

  // node:inspector — the experimental inspector's Host realm opens one
  // native V8 session per DevTools connection (worker/realms/host/bridge.ts:
  // `new Session()` inside openSession). One serial JS realm here (D2):
  // there is no second V8 to attach an inspection session to, so the class
  // fails loud at CONSTRUCTION — but the realm only builds sessions lazily
  // (openSession, per connection), so the inspector worker boots, answers
  // bridge queries and reads cordis snapshots (the no-CDP limbs the suite
  // drives) without ever constructing one. Row added with the W5-Q round
  // that staged the worker entry (transpile.mjs worker.js emission).
  ['node:inspector', [
    "const refuse = (name) => () => {",
    "  throw new Error('node:inspector: ' + name + ' is not served in this runtime — one serial JS realm (D2) has no native V8 inspection session to attach');",
    "};",
    "export class Session {",
    "  constructor() { refuse('Session')(); }",
    "  connect() { refuse('Session.connect')(); }",
    "  post(method, params, callback) { refuse('Session.post')(); }",
    "}",
    "export const URL = class { constructor() { refuse('URL')(); } };",
    "export default { Session };",
  ].join('\n')],
  // node:dns/promises — lookup exists on the vendored web-fetch-http face's
  // import line; DNS resolution is a host network capability this runtime
  // routes through the gateway, so the promise fails loud naming the seam.
  ['node:dns/promises', [
    "export const lookup = async () => {",
    "  throw new Error('node:dns/promises: lookup is not served in this runtime — name resolution rides the gateway network plane, not a resolver seam');",
    "};",
    "export const Resolver = class { resolve() { return Promise.reject(new Error('node:dns/promises: Resolver is not served in this runtime — no resolver seam')); } };",
    "export default { lookup, Resolver };",
  ].join('\n')],

  // node:readline — createInterface over an async-iterable/EventEmitter
  // input: line-splitting is pure JS, so this is an honest implementation
  // ('line' events + async iteration; close ends it). Only the utf-8 line
  // face the ssh inspector spec drives.
  ['node:readline', [
    "import { EventEmitter } from 'upstream/shims/events.js';",
    "class Interface extends EventEmitter {",
    "  #line = '';",
    "  constructor(options) {",
    "    super();",
    "    this.closed = false;",
    "    this.#pump(options?.input);",
    "  }",
    "  async #pump(input) {",
    "    try {",
    "      for await (const chunk of input) {",
    "        const text = (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));",
    "        let carry = this.#line + text;",
    "        let at;",
    "        while ((at = carry.indexOf('\\n')) >= 0) {",
    "          this.emit('line', carry.slice(0, at).replace(/\\r$/, ''));",
    "          carry = carry.slice(at + 1);",
    "        }",
    "        this.#line = carry;",
    "      }",
    "    } catch { /* a destroyed input ends the pump */ }",
    "    this.closed = true;",
    "    this.emit('close');",
    "  }",
    "  close() { /* the pump ends when its input ends */ }",
    "  [Symbol.asyncIterator]() {",
    "    const queue = [];",
    "    const waiters = [];",
    "    this.on('line', (line) => {",
    "      const waiter = waiters.shift();",
    "      if (waiter) waiter({ value: line, done: false });",
    "      else queue.push(line);",
    "    });",
    "    return {",
    "      next: () => new Promise((resolve) => {",
    "        if (queue.length > 0) resolve({ value: queue.shift(), done: false });",
    "        else if (this.closed) resolve({ value: undefined, done: true });",
    "        else waiters.push(resolve);",
    "      }),",
    "      return: () => Promise.resolve({ value: undefined, done: true }),",
    "      throw: (error) => Promise.reject(error),",
    "    };",
    "  }",
    "}",
    "export const createInterface = (options) => new Interface(options);",
    "export default { createInterface };",
  ].join('\n')],

  // node:sqlite — node 22's builtin SQL engine; there is no SQL engine to
  // serve and no file backing, so the class links and construction fails
  // loud (the sqlite specs are a desktop-storage family).


  // node:vm — the confined guest realm IS the PTC execution model (see the
  // upstream/README.md row: the subprocess-class seam). Linkage only: the
  // workflow-ptc specs' imports resolve, every member fails loud.
  ['node:vm', [
    "const refuse = (name) => () => {",
    "  throw new Error('node:vm: ' + name + ' is not served in this runtime — the confined realm is the PTC execution model (subprocess-class seam, deliberately unprovided)');",
    "};",
    "export const Script = class { constructor() { refuse('Script')(); } };",
    "export const createContext = refuse('createContext');",
    "export const runInContext = refuse('runInContext');",
    "export const runInNewContext = refuse('runInNewContext');",
    "export default { Script, createContext, runInContext, runInNewContext };",
  ].join('\n')],

  // node:http — folded from npm-bridges.js (C's linkage stub) with the real
  // faces kept: validateHeaderName/validateHeaderValue are pure validation
  // and match node's contract exactly. The SERVER face grew an in-process
  // implementation (round 6, 2026-09-28): createServer/Server register an
  // http-loopback handler (upstream/shims/node-http-loopback.js — no socket
  // is ever bound; a matching fetch dispatches through the handler), which
  // is the only face the upstream suite's in-test servers use. The CLIENT
  // faces (request/get/Agent) still fail loud: nothing dials a real
  // interface.
  ['node:http', [
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
    "export const MAX_HEADER_COUNT = http.MAX_HEADER_COUNT;",
    "export const maxHeaderSize = http.maxHeaderSize;",
    "export const setMaxIdleHTTP1Connections = http.setMaxIdleHTTP1Connections;",
    "export const globalAgent = http.globalAgent;",
  ].join('\n')],

  // node:net — folded from npm-bridges.js: isIP/isIPv4/isIPv6 are real
  // (pure string classification); the socket faces fail loud.
  ['node:net', [
    "const refuse = (name) => () => {",
    "  throw new Error('node:net: ' + name + ' is not served in this runtime — no socket seam');",
    "};",
    "const isIPv4 = (value) => {",
    "  if (typeof value !== 'string') return false;",
    "  const parts = value.split('.');",
    "  return parts.length === 4 && parts.every((p) => /^\\d{1,3}$/.test(p) && Number(p) <= 255 && (p.length === 1 || p[0] !== '0' || p === '0'));",
    "};",
    "const isIPv6 = (value) => typeof value === 'string' && value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value);",
    "const isIP = (value) => (isIPv4(value) ? 4 : isIPv6(value) ? 6 : 0);",
    "const net = {",
    "  isIP, isIPv4, isIPv6,",
    "  Socket: class { constructor() { refuse('Socket')(); } },",
    "  StreamDuplex: class { constructor() { refuse('StreamDuplex')(); } },",
    "  connect: refuse('connect'),",
    "  createConnection: refuse('createConnection'),",
    "  createServer: refuse('createServer'),",
    "};",
    "export default net;",
    "export const Socket = net.Socket;",
    "export const connect = net.connect;",
    "export const createConnection = net.createConnection;",
    "export const createServer = net.createServer;",
    "export { isIP, isIPv4, isIPv6 };",
  ].join('\n')],

  // node:child_process — the REAL subprocess face (W5-R, 2026-09-28): the
  // host grew the __dshProc* intrinsics (portable fork/exec/poll in
  // dsh_spike_host.c) and upstream/shims/node-child-process.js serves node's
  // spawn/spawnSync/execFile surface over them (children never run JS in
  // this runtime — D2's serial-thread constitution is untouched; the
  // desktop/Android parity leg spawns REAL fixture servers exactly like
  // upstream CI). The old loud-refusal stub was the honest answer while the
  // seam was absent; it made the lsp-stdio/bash/hooks families fail every
  // test downstream of a spawn.
  ['node:child_process', [
    "import childProcess from 'upstream/shims/node-child-process.js';",
    "import { wrapChildProcessFace } from 'upstream/shims/source-bootstrap-ipc.js';",
    "const face = wrapChildProcessFace(childProcess);",
    "export default face;",
    "export const { spawn, spawnSync, execFile, execFileSync, exec, ChildProcess } = face;",
  ].join('\n')],

  // @deepseek-ai/dsh-loader-smoke — the W8 source-entry-bootstrap overlay
  // (shims/source-bootstrap-loader-smoke.js): the vendored lib's
  // resolveExampleLaunch calls import.meta.resolve('tsx'), which the C
  // resolve cannot answer for the slash-less bare name — every src-mode
  // launch in the corpus died there before any child existed. The overlay
  // re-exports the vendored lib and re-points the two tsx-naming faces at
  // the source-bootstrap tsx face. Registered here because the
  // __dshModuleDefine seam is checked BEFORE the bare map — the same
  // shadow channel as the cordis failure-face overlay (W7-X3).
  ['@deepseek-ai/dsh-loader-smoke', [
    "export * from 'upstream/shims/source-bootstrap-loader-smoke.js';",
  ].join('\n')],

  // tsx / tsx/esm / tsx/esm/api — the IN-REALM tsx face the source-closure
  // Worker data: bootstraps import ({ register }) before their TypeScript
  // entry (W8 source-entry-bootstrap). The CHILD-side face is the real tsx
  // resolved by shims/source-bootstrap-tsx.js; in THIS realm there is no
  // TS eraser, so register() is the honest no-op — a .ts entry that needs
  // real erasure fails loudly at its own import instead of mis-parsing.
  // Three names because the C resolve passes 'tsx/esm[/api]' through as
  // the literal spelling the vendored bootstraps embed in their data: URLs.
  ['tsx', sourceBootstrapRegisterFace()],
  ['tsx/esm', sourceBootstrapRegisterFace()],
  ['tsx/esm/api', sourceBootstrapRegisterFace()],

  // node:url — the staged-asset re-root face (W8 loader-face-staged-world,
  // 2026-09-29): the vendored dsh-skill-office lib resolves its bundled
  // skill assets from ITS OWN module URL — the C loader pins import.meta.url
  // of a mapped module to the staged vendor path, so the lib's
  // `new URL("../assets/", import.meta.url)` spells
  // /vendor/npm/@deepseek-ai/dsh-skill-office@0.1.6-alpha.2/assets/ while
  // the transpiler's package-assets staging (upstream-suite-leg.js
  // emitPackageAssets) serves the same verbatim bytes at /assets/ — the
  // spelling the vendored skill-office spec itself computes and asserts
  // (`new URL("../assets/", import.meta.url)` from /upstream-tests/).
  // Re-export the url shim with fileURLToPath (and pathToFileURL, its
  // inverse) re-rooting EXACTLY that one subtree between the two spellings;
  // every other path passes through byte-identical, and shim-internal
  // consumers keep the unwrapped faces (they never name that subtree).
  ['node:url', [
    "import * as urlShim from 'upstream/shims/url.js';",
    "const OFFICE_ASSETS = '/vendor/npm/@deepseek-ai/dsh-skill-office@0.1.6-alpha.2/assets/';",
    "const STAGED_ASSETS = '/assets/';",
    "const reRoot = (path) => (typeof path === 'string' && path.startsWith(OFFICE_ASSETS)",
    "  ? `${STAGED_ASSETS}${path.slice(OFFICE_ASSETS.length)}`",
    "  : path);",
    "const unRoot = (path) => (typeof path === 'string' && path.startsWith(STAGED_ASSETS)",
    "  ? `${OFFICE_ASSETS}${path.slice(STAGED_ASSETS.length)}`",
    "  : path);",
    "export const fileURLToPath = (input, options) => reRoot(urlShim.fileURLToPath(input, options));",
    "export const pathToFileURL = (path) => urlShim.pathToFileURL(unRoot(path));",
    "export const percentDecode = urlShim.percentDecode;",
    "export const parseAbsolute = urlShim.parseAbsolute;",
    "export const resolvePath = urlShim.resolvePath;",
    "export const DshURL = urlShim.DshURL;",
    "export default urlShim.default;",
  ].join('\n')],
];

/** The in-realm tsx register face (module level for size — one body shared
 * by the three tsx spellings above). */
function sourceBootstrapRegisterFace() {
  return [
    "// source-bootstrap tsx face (in-realm): the Worker data: bootstraps",
    "// import { register } from the resolved tsx face before importing their",
    "// TypeScript entry. This realm serves the vendored closure as plain JS",
    "// modules — register() arms nothing here; a .ts entry that needed real",
    "// erasure fails loudly at its own import, naming itself.",
    'const register = () => {};',
    'export { register };',
    'export const registerHooks = register;',
    'export const transform = (code) => ({ code });',
    'export default { register, registerHooks, transform };',
    '',
  ].join('\n');
}


/** Register the runtime-module rows; idempotent (define() replaces). */
export const defineRuntimeModules = () => {
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') {
    throw new Error('runtime-modules: __dshModuleDefine is not available — this host does not expose the runtime module seam the registrations go through');
  }
  for (const [name, source] of REGISTRATIONS) {
    define(name, source);
  }
  return REGISTRATIONS.map(([name]) => name);
};

defineRuntimeModules();

// W8 source-entry-bootstrap: stage spawned SOURCE entries before the
// child_process shim captures the seam (its module eval happens after
// boot, so it serves the wrapped intrinsics — see
// shims/source-bootstrap-tsx.js installSpawnArgvStager). The static
// import keeps the wrap synchronous with boot: no node:child_process
// consumer can evaluate between the registrations and the wrap. The
// stager also carries the W8 subprocess-family platform pin (see
// maybePinSubprocessPlatform there — it needs the child-process
// namespace, which the suite leg preloads only just before the spec
// import, so the pin rides the first staging call instead of boot).
import { installSpawnArgvStager } from 'upstream/shims/source-bootstrap-tsx.js';
installSpawnArgvStager();

// The IPC face's poll siphon must ALSO precede the child_process shim's
// capture (its pump is the poller the siphon rides — see
// shims/source-bootstrap-ipc.js installPollSiphon).
import { installPollSiphon } from 'upstream/shims/source-bootstrap-ipc.js';
installPollSiphon();
