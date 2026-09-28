// dsh:logging-exempt (shim layer; specifier registration, no logging surface)
/**
 * Runtime module bridges for pinned npm packages the HOST LOADER's bare map
 * cannot name. `dsh_map_bare` (the platform file hosts/**) owns the bare
 * specifiers it maps, and bare npm names without a dot or slash fail loud as
 * "unmapped module specifier" — but the loader resolves RUNTIME-DEFINED
 * modules first, through the `__dshModuleDefine(name, source)` seam the M3
 * install pipeline already ships. A one-line re-export bridge registered
 * here puts the VERBATIM, sha256-pinned vendored npm tree behind the bare
 * specifier the vendored tool packages import — zero upstream bytes copied,
 * edited, or re-pinned (D6), and no host-file edit.
 *
 * Rows (npm package → vendored tree → bare specifier a vendored package
 * imports):
 *   - diff@9.0.0 → vendor/npm/diff@9.0.0 (libesm — the ESM face its exports
 *     map gives an importer) → `diff`, imported by @deepseek-ai/dsh-tool-fs
 *     (`structuredPatch` — the hunk diffs in write/edit results).
 *   - yaml@2.9.0 → vendor/npm/yaml@2.9.0 (browser/ — the package's own ESM
 *     face; the "node" face is CJS, which this loader cannot serve) →
 *     `yaml`, imported by @deepseek-ai/dsh-skill-filesystem (`parse` — the
 *     SKILL.md frontmatter).
 *   - chokidar@5.0.0 → NO vendored tree (the @vscode/ripgrep precedent: the
 *     package's engine is real OS fs events plus awaitWriteFinish wall-clock
 *     timers, and the runtime has neither seam) → `chokidar`, imported at
 *     link time by @deepseek-ai/dsh-skill-filesystem. The linkage shim
 *     satisfies the import and its `watch()` throws loud naming the gap
 *     (rule 5); the mobile profile mounts skill-filesystem with `watch:false`
 *     and never reaches it.
 *
 * Self-registering on import (the web-shims.js pattern): import this module
 * BEFORE the first import of a bridged package. Everything fails loud
 * (rule 5): no seam, no bridge; a missing vendored tree surfaces as the
 * loader's own resolution error naming the path.
 */

// The pi-ai built-in model CATALOG, composed through the sanctioned JSON
// seam (round 4, 2026-09-27). Neither dist/providers/all.js nor the model
// catalog can be served verbatim: the barrel and every
// dist/providers/*.models.js carry JSON import ATTRIBUTES
// (`import values from "./data/x.json" with { type: "json" }`), and
// quickjs-ng 0.17 cannot parse attribute syntax ('SyntaxError: expecting
// ;'). But every byte of the catalog DATA is a plain JSON file, and the
// flatten is a plain module (dist/model-catalog.js) — so this face reads
// the pinned JSON files through the loader's sanctioned JSON seam
// (__dshBundleRequire) and flattens with the vendored function: the MODELS
// map is byte-equivalent to the generated one. What is NOT derivable is
// provider CONSTRUCTION (api/auth wiring lives in the unparseable
// provider files), so builtinProviders()/builtinModels() & co fail loud
// naming the gap (the chokidar pattern). Revisit when the pin moves or the
// runtime grows import attributes; this row must not outlive that gap
// silently.
const PI_AI_PROVIDERS_ALL = [
  "import { flattenModelCatalog } from '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/model-catalog.js';",
  "const manifest = JSON.parse(globalThis.__dshBundleRequire(",
  "  '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/all.js', './data/.manifest.json'));",
  "const MODELS = {};",
  "for (const file of Object.keys(manifest.files)) {",
  "  const id = file.replace(/\\.json$/, '');",
  "  const values = JSON.parse(globalThis.__dshBundleRequire(",
  "    '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/models.js', './data/' + file));",
  "  MODELS[id] = flattenModelCatalog(id, values);",
  "}",
  "const refuseProviders = () => {",
  "  throw new Error('pi-ai: provider construction is not served — dist/providers/*.models.js use JSON import attributes (with type json) which quickjs-ng 0.17 cannot parse; the model catalog (getBuiltinModels et al) is served');",
  "};",
  "/** Typed read of the generated built-in catalog. */",
  "export function getBuiltinModel(provider, modelId) {",
  "    const models = MODELS[provider];",
  "    return models?.[modelId];",
  "}",
  "export function getBuiltinProviders() {",
  "    return Object.keys(MODELS);",
  "}",
  "/** Generation timestamp shared by all built-in provider catalogs. */",
  "export function getBuiltinModelDataGeneratedAt() {",
  "    const generatedAt = Date.parse(manifest.generatedAt);",
  "    return Number.isNaN(generatedAt) ? undefined : generatedAt;",
  "}",
  "export function getBuiltinModels(provider) {",
  "    const models = MODELS[provider];",
  "    return models",
  "        ? Object.values(models)",
  "        : [];",
  "}",
  "/** All built-in providers — NOT served (see refuseProviders). */",
  "export function builtinProviders() { refuseProviders(); }",
  "/** A `Models` collection with every built-in provider registered — NOT served. */",
  "export function builtinModels(options) { refuseProviders(); }",
  "/** All built-in image-generation providers — NOT served. */",
  "export function builtinImagesProviders() { refuseProviders(); }",
  "/** An `ImagesModels` collection — NOT served. */",
  "export function builtinImagesModels(options) { refuseProviders(); }",
].join('\n');

const BRIDGES = [
  ['diff', "export * from '/vendor/npm/diff@9.0.0/libesm/index.js';"],
  ['yaml', "export * from '/vendor/npm/yaml@2.9.0/browser/index.js';"],
  // The upstream-suite growth round 3 (2026-09-25): test faces the suite's
  // own source packages import, pinned at the dsh-v0.1.6-alpha.2 lockfile's
  // exact resolutions and NEVER mounted by the product boot. Subpath rows
  // point at each package's own ESM face (the loader resolves concrete
  // files, not exports maps).
  ['zustand/vanilla', "export * from '/vendor/npm/zustand@4.4.7/esm/vanilla.js';"],
  ['zustand/shallow', "export * from '/vendor/npm/zustand@4.4.7/esm/shallow.js';"],
  ['zustand/middleware', "export * from '/vendor/npm/zustand@4.4.7/esm/middleware.js';"],
  ['eventsource-parser/stream', "export * from '/vendor/npm/eventsource-parser@3.1.0/dist/stream.js';"],
  ['eventsource-parser', "export * from '/vendor/npm/eventsource-parser@3.1.0/dist/index.js';"],
  // The office plane's zip engine (2026-09-27): fflate 0.8.2 — the pure-JS
  // zip read/write face (89KB ESM, zero imports) the dsh-office system
  // plugin mounts the OOXML container on (docx/xlsx/pptx are zip+xml, and
  // the frozen gateway has no inflate primitive — the tar-mini.js note).
  // A bare npm name without a dot, so the host bare map cannot serve it;
  // this bridge seam does. Mounted by the product boot through the
  // dsh-office plugin (imported after this module registers).
  ['fflate', "export * from '/vendor/npm/fflate@0.8.2/esm/browser.js';"],
  // The chokidar linkage shim (no vendored tree — see the row note above).
  // The importing vendored package binds only the default export and calls
  // `chokidar.watch(...)`, so the shim is exactly that face; it fails loud
  // naming the seam that is missing, so an accidental watch:true mount can
  // never silently no-op.
  ['chokidar', [
    "const refuse = () => {",
    "  throw new Error('chokidar: watch() is not served in this runtime — ",
    "no fs-event or wall-clock timer seam (mount skill-filesystem with watch:false)');",
    "};",
    "export const watch = refuse;",
    "export default { watch: refuse };",
  ].join(' ')],

  // ---------------------------------------------------------------------
  // Upstream-suite growth round 4 (2026-09-27, the test-face npm gaps):
  // every row below serves ONE load failure measured by the 671-spec sweep
  // (tmp/red-triage.json, the load-other family). Pins ride the TEST pin
  // table (vendor/ensure-dsh-tests.sh ensure_npm_registry rows) at the
  // upstream dsh-v0.1.6-alpha.2 lockfile's exact resolutions; nothing here
  // is mounted by the product boot. Each vendor row is the REAL-PATH
  // pattern: the bridge resolves under the specifier the spec imports, then
  // re-exports from the vendored file's true path so THAT file's own
  // relative imports resolve against its real directory (runtime-defined
  // modules are checked before the bare map — the one mapping surface).
  // ---------------------------------------------------------------------

  // The dsh-subprocess-local rollup chunk (27 specs, the largest single
  // bucket): the bundled lib/ files import './runner-launch-DGV26RBf.js'
  // RELATIVELY, but the entry was served under the bare specifier
  // '@deepseek-ai/dsh-subprocess-local', so dsh_normalize rewrites the join
  // against '@deepseek-ai' and the probe's lib/ shapes never match
  // ('cannot load module @deepseek-ai/runner-launch-DGV26RBf.js'). The
  // chunk itself is pinned verbatim in both vendored trees — this row is
  // purely the name the normalized join produces.
  ['@deepseek-ai/runner-launch-DGV26RBf.js',
    "export * from '/vendor/dsh/subprocess-local@0.1.6-alpha.2/lib/runner-launch-DGV26RBf.js';"],

  // The bare npm `buffer` name (webworker-runtime family): the EXISTING
  // shim behind the node:buffer face — no new vendored bytes (the same
  // module instance node:crypto's shim composes with, so DshBuffer identity
  // holds across both spellings).
  ['buffer', "export { Buffer } from 'upstream/shims/buffer.js';"],

  // @vitest/spy (remote-mock + gateway client specs import { fn }): the
  // harness's vi face re-exported under vitest's own spy package name. The
  // import uses the EXACT specifier the suite driver loads the harness
  // under, so this is the same module instance (same `suite` state) — a
  // second spelling would fork the test collection.
  ['@vitest/spy', [
    "import { vi } from 'scenario/upstream-test-harness.js';",
    "export const fn = vi.fn;",
    "export const spyOn = vi.spyOn;",
    "export const isMockFunction = vi.isMockFunction;",
  ].join('\n')],

  // immer 10.2.0 (session/terminal/workspace-controller client specs): the
  // dist/immer.mjs ESM face (the export map's "import" row). The file reads
  // process.env.NODE_ENV at module scope and the suite driver installs no
  // process global, so the node:process shim's face is installed first
  // (??= — a future web-shims global stays in charge).
  // ESM evaluates DEPENDENCIES BEFORE their importer's body, so a global
  // that a vendored file reads at module scope must be installed in a
  // SEPARATE module listed as the bridge's FIRST import — inline statements
  // in the bridge would run too late. One shared setup module serves all
  // the faces that need it; ??= keeps any future real global in charge.
  ['dsh-bridge-setup/globals', [
    "import proc from 'node:process';",
    "globalThis.process ??= proc;",
    "globalThis.global ??= globalThis;",
    "globalThis.require ??= (name) => () => {",
    "  throw new Error('require: ' + name + ' is not served in this runtime — the CJS face has no ESM build (linkage stub)');",
    "};",
  ].join('\n')],
  ['immer', [
    "import 'dsh-bridge-setup/globals';",
    "export * from '/vendor/npm/immer@10.2.0/dist/immer.mjs';",
  ].join('\n')],

  // commander 15.0.0 (cmdline + the bundle startup specs): type-module
  // entry, relative ./lib/* imports resolve against the real path.
  ['commander', "export * from '/vendor/npm/commander@15.0.0/index.js';"],

  // acorn 8.17.0 (webworker-runtime compile/chokidar specs): dist/acorn.mjs.
  // acorn 8.17.0 (webworker-runtime compile/chokidar specs): dist/acorn.mjs.
  // Named exports only — the file ships no default, so no default re-export.
  ['acorn', "export * from '/vendor/npm/acorn@8.17.0/dist/acorn.mjs';"],

  // turndown 7.2.4 (tool-web specs): the package's own ESM face
  // (lib/turndown.es.js). The file's TOP LEVEL calls createHTMLParser()
  // whenever no DOMParser global exists, and that path require()s the CJS
  // domino package — so the bridge arms a linkage `require` FIRST (the
  // chokidar pattern): loading succeeds, and the face fails loud only when
  // HTML is actually parsed without a caller-supplied parser (domino is
  // CJS; no ESM face exists to serve).
  ['turndown', [
    "import 'dsh-bridge-setup/globals';",
    "export { default } from '/vendor/npm/turndown@7.2.4/lib/turndown.es.js';",
  ].join('\n')],

  // @noble/hashes 2.3.0 (webworker-runtime crypto-globals/builtins-table/
  // chokidar specs): ESM-native root files; only the subpaths the specs
  // import are named (their own relative ./_md.js & co. resolve beside).
  ['@noble/hashes/sha2.js', "export * from '/vendor/npm/@noble/hashes@2.3.0/sha2.js';"],
  ['@noble/hashes/legacy.js', "export * from '/vendor/npm/@noble/hashes@2.3.0/legacy.js';"],

  // @jridgewell/gen-mapping 0.3.13 (+ its two deps, the lockfile's exact
  // resolutions — typert generator specs): the "import" faces.
  ['@jridgewell/gen-mapping', "export * from '/vendor/npm/@jridgewell/gen-mapping@0.3.13/dist/gen-mapping.mjs';"],
  ['@jridgewell/trace-mapping', "export * from '/vendor/npm/@jridgewell/trace-mapping@0.3.31/dist/trace-mapping.mjs';"],
  ['@jridgewell/sourcemap-codec', "export * from '/vendor/npm/@jridgewell/sourcemap-codec@1.5.5/dist/sourcemap-codec.mjs';"],
  ['@jridgewell/resolve-uri', "export { default } from '/vendor/npm/@jridgewell/resolve-uri@3.1.2/dist/resolve-uri.mjs';\nexport * from '/vendor/npm/@jridgewell/resolve-uri@3.1.2/dist/resolve-uri.mjs';"],

  // @octokit/webhooks 14.2.0 (webhook-github config spec): the dist-bundle
  // ESM face — self-contained, named exports only.
  ['@octokit/webhooks', "export * from '/vendor/npm/@octokit/webhooks@14.2.0/dist-bundle/index.js';"],
  ['@octokit/webhooks-methods', "export * from '/vendor/npm/@octokit/webhooks-methods@6.0.0/dist-node/index.js';"],

  // @agentclientprotocol/sdk 1.4.0 (acp family + session-snapshot; peer zod
  // rides the bare map's vendored zod@4.4.3).
  ['@agentclientprotocol/sdk', "export * from '/vendor/npm/@agentclientprotocol/sdk@1.4.0/dist/acp.js';"],

  // @deepseek-ai/cordis-plugin-group 1.0.4 (plugin-manager patch,
  // agent-presets mount, typert loader): the published face of the
  // workspace vendor/group package, same 1.x stream as the vendored
  // cordis-plugin-loader/include pins; its default is the Group class.
  ['@deepseek-ai/cordis-plugin-group',
    "export { default } from '/vendor/npm/@deepseek-ai/cordis-plugin-group@1.0.4/lib/index.js';"],

  // @modelcontextprotocol/client 2.0.0 (+ core/internal, the client's own
  // _shims face, and the dependency faces the ESM graph names bare: zod/v4,
  // pkce-challenge, eventsource, jose) — mcp-client + browser-use-runtime
  // specs. zod/v4 exists in the vendored zod tree but the bare map's `zod/`
  // rule maps subpaths as raw paths (no extension/index resolution), so the
  // barrel specifier gets its own row.
  ['@modelcontextprotocol/client',
    "export * from '/vendor/npm/@modelcontextprotocol/client@2.0.0/dist/index.mjs';"],
  ['@modelcontextprotocol/client/_shims',
    "export * from '/vendor/npm/@modelcontextprotocol/client@2.0.0/dist/shimsNode.mjs';"],
  ['@modelcontextprotocol/client/stdio',
    "export * from '/vendor/npm/@modelcontextprotocol/client@2.0.0/dist/stdio.mjs';"],
  ['@modelcontextprotocol/core/internal',
    "export * from '/vendor/npm/@modelcontextprotocol/core@2.0.0/dist/internal.mjs';"],
  ['zod/v4', "export * from '/vendor/npm/zod@4.4.3/v4/index.js';"],
  ['pkce-challenge', "export { default } from '/vendor/npm/pkce-challenge@5.0.1/dist/index.node.js';"],
  ['eventsource', "export * from '/vendor/npm/eventsource@3.0.7/dist/index.js';"],
  ['jose', "export * from '/vendor/npm/jose@6.2.3/dist/webapi/index.js';"],

  // node:http / node:net / node:child_process were REMOVED from here (the
  // 2026-09-27 fold): they are node-face rows, so they live in
  // runtime-modules.js now — with the real faces (isIP, validateHeader*)
  // kept and the SHADOW RISK gone: a runtime-defined node: row could shadow
  // a future real C-map shim entry silently; the split keeps npm faces here
  // and node faces there, and the handoff note in tmp/r3-ledger-C.json is
  // satisfied.

  // cross-spawn: NO vendored tree (the chokidar precedent). The mcp stdio
  // transport's CJS-only spawn wrapper — D2 forbids the subprocess seam it
  // wraps, so the linkage shim satisfies the import and the default export
  // fails loud naming the gap.
  ['cross-spawn', [
    "const refuse = () => {",
    "  throw new Error('cross-spawn: child process spawn is not served in this runtime — ",
    "no subprocess seam (rule D2)');",
    "};",
    "export default refuse;",
  ].join(' ')],

  // @earendil-works/pi-ai 0.85.1 (llm-pi-ai family): the subpaths the specs
  // import, at their dist faces. The .lazy api modules dynamic-import their
  // heavy SDK impls (openai/@anthropic-ai/sdk/@google/genai/@aws-sdk) only
  // when a live transport is built — never reached by the suite — so the
  // tarball's declared heavy deps stay unfetched. The providers/all barrel
  // is the composed face above (import-attribute parse gap).
  ['@earendil-works/pi-ai/providers/all', PI_AI_PROVIDERS_ALL],
  ['@earendil-works/pi-ai/api/transform-messages',
    "export * from '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/transform-messages.js';"],
  ['@earendil-works/pi-ai/api/anthropic-messages.lazy',
    "export * from '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/anthropic-messages.lazy.js';"],
  ['@earendil-works/pi-ai/api/openai-completions.lazy',
    "export * from '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-completions.lazy.js';"],
  ['@earendil-works/pi-ai/api/openai-responses.lazy',
    "export * from '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-responses.lazy.js';"],
  ['@earendil-works/pi-ai/utils/event-stream',
    "export * from '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/event-stream.js';"],
  ['@earendil-works/pi-ai/utils/overflow',
    "export * from '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/overflow.js';"],

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
  ['http', [
    "const refuse = (name) => () => {",
    "  throw new Error('http: ' + name + ' is not served in this runtime — no socket seam');",
    "};",
    "export const createServer = refuse('createServer');",
    "export const request = refuse('request');",
    "export const get = refuse('get');",
  ].join(' ')],
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
];

export const defineNpmBridges = () => {
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') {
    throw new Error('npm-bridges: __dshModuleDefine is not available — this host does not expose the runtime module seam the bridges register through');
  }
  for (const [name, source] of BRIDGES) {
    define(name, source);
  }
  return BRIDGES.map(([name]) => name);
};

defineNpmBridges();
