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

// The pi-ai faces, composed through the sanctioned JSON seam + the loader
// shadow seam (round 5, 2026-09-28; catalog-only face was round 4,
// 2026-09-27). The blocker round 4 named — dist/providers/*.models.js and
// providers/all.js carry JSON import ATTRIBUTES (`import values from
// "./data/x.json" with { type: "json" }`) that quickjs-ng 0.17 cannot parse
// ('SyntaxError: expecting ;') — is now routed AROUND without touching a
// vendored byte (D6): the host loader checks RUNTIME-DEFINED modules before
// disk loads for absolute /vendor names, and dsh_normalize resolves a
// relative import of an on-disk-loaded module against its directory in
// SPECIFIER space. So a runtime module registered under the ABSOLUTE vendor
// path of a generated `providers/<id>.models.js` replaces that file for
// every importer (its sibling provider constructor files and
// models.generated.js) while all other files keep loading VERBATIM. Each
// shadow source is the generated file's own 3-line shape with the attribute
// rewritten to the __dshBundleRequire JSON seam; the composed
// providers/all barrel keeps the real all.js body (39 provider constructors,
// createModels/createImagesModels wiring) with only its two attribute
// imports rewritten the same way. Provider ids ride the generated catalog
// manifest (39 ids, each a 1:1 data/<id>.json ↔ providers/<id>.models.js
// pair — measured 2026-09-28); id → export-name shapes measured against the
// vendored dist (`google-vertex` → GOOGLE_VERTEX_MODELS /
// googleVertexProvider).
const PI_AI_DIST = '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist';
// id → provider-file export name, MEASURED verbatim against the vendored
// all.js import block (2026-09-28) — the generated names are NOT a uniform
// camelCase of the id (azure-openai-responses → azureOpenAIResponsesProvider
// but openai-codex → openaiCodexProvider; cloudflare-ai-gateway →
// cloudflareAIGatewayProvider), so no derivation rule survives the pin; a
// pin move fails LOUD here (a missing export names itself).
const PI_AI_PROVIDER_EXPORTS = {
  'amazon-bedrock': 'amazonBedrockProvider',
  'ant-ling': 'antLingProvider',
  'anthropic': 'anthropicProvider',
  'azure-openai-responses': 'azureOpenAIResponsesProvider',
  'baseten': 'basetenProvider',
  'cerebras': 'cerebrasProvider',
  'cloudflare-ai-gateway': 'cloudflareAIGatewayProvider',
  'cloudflare-workers-ai': 'cloudflareWorkersAIProvider',
  'deepseek': 'deepseekProvider',
  'fireworks': 'fireworksProvider',
  'github-copilot': 'githubCopilotProvider',
  'google': 'googleProvider',
  'google-vertex': 'googleVertexProvider',
  'groq': 'groqProvider',
  'huggingface': 'huggingfaceProvider',
  'kimi-coding': 'kimiCodingProvider',
  'minimax': 'minimaxProvider',
  'minimax-cn': 'minimaxCnProvider',
  'mistral': 'mistralProvider',
  'moonshotai': 'moonshotaiProvider',
  'moonshotai-cn': 'moonshotaiCnProvider',
  'nvidia': 'nvidiaProvider',
  'openai': 'openaiProvider',
  'openai-codex': 'openaiCodexProvider',
  'opencode': 'opencodeProvider',
  'opencode-go': 'opencodeGoProvider',
  'openrouter': 'openrouterProvider',
  'openrouter-images': 'openrouterImagesProvider',
  'qwen-token-plan': 'qwenTokenPlanProvider',
  'qwen-token-plan-cn': 'qwenTokenPlanCnProvider',
  'qwen-token-plan-individual': 'qwenTokenPlanIndividualProvider',
  'radius': 'radiusProvider',
  'together': 'togetherProvider',
  'vercel-ai-gateway': 'vercelAIGatewayProvider',
  'xai': 'xaiProvider',
  'xiaomi': 'xiaomiProvider',
  'xiaomi-token-plan-ams': 'xiaomiTokenPlanAmsProvider',
  'xiaomi-token-plan-cn': 'xiaomiTokenPlanCnProvider',
  'xiaomi-token-plan-sgp': 'xiaomiTokenPlanSgpProvider',
  'zai': 'zaiProvider',
  'zai-coding-cn': 'zaiCodingCnProvider',
};
const piAiUpperSnake = (id) => `${id.toUpperCase().replace(/-/g, '_')}_MODELS`;
const PI_AI_PROVIDER_IDS = Object.keys(JSON.parse(globalThis.__dshBundleRequire(
  `${PI_AI_DIST}/providers/all.js`, './data/.manifest.json',
)).files).map((file) => file.replace(/\.json$/, ''));

/** Loader-shadow modules for the 39 unparseable generated .models.js files.
 * TWO names per file: the absolute vendor path (direct imports) AND the
 * bundle-relative path — dsh_resolve_relative tokenizes a slash-prefixed
 * importer directory into a leading EMPTY segment, so its join produces the
 * NO-slash spelling ('vendor/npm/…') and relative re-entry (from the sibling
 * provider files and models.generated.js) never carries the slash. */
const PI_AI_MODEL_SHADOWS = PI_AI_PROVIDER_IDS.flatMap((id) => {
  const source = [
    `import { flattenModelCatalog } from '${PI_AI_DIST}/model-catalog.js';`,
    `const values = JSON.parse(globalThis.__dshBundleRequire(`,
    `    '${PI_AI_DIST}/providers/models.js', './data/${id}.json'));`,
    `export const ${piAiUpperSnake(id)} = flattenModelCatalog('${id}', values);`,
  ].join('\n');
  return [
    [`${PI_AI_DIST}/providers/${id}.models.js`, source],
    [`${PI_AI_DIST.slice(1)}/providers/${id}.models.js`, source],
  ];
});

/** The composed providers/all barrel: the real all.js body with its two
 * attribute imports rewritten to the JSON seam. The catalog face
 * (getBuiltinModel(s) et al) is byte-equivalent to round 4's; the round-4
 * refuseProviders stubs grow the REAL construction bodies. */
const PI_AI_PROVIDERS_ALL = [
  `import { createModels } from '${PI_AI_DIST}/models.js';`,
  `import { createImagesModels } from '${PI_AI_DIST}/images-models.js';`,
  `import { MODELS } from '${PI_AI_DIST}/models.generated.js';`,
  `const manifest = JSON.parse(globalThis.__dshBundleRequire(`,
  `  '${PI_AI_DIST}/providers/all.js', './data/.manifest.json'));`,
  ...PI_AI_PROVIDER_IDS.map((id) => `import { ${PI_AI_PROVIDER_EXPORTS[id]} } from '${PI_AI_DIST}/providers/${id}.js';`),
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
  "/** All built-in providers, freshly constructed (the real all.js body). */",
  "export function builtinProviders() {",
  `    return [${PI_AI_PROVIDER_IDS.map((id) => `${PI_AI_PROVIDER_EXPORTS[id]}()`).join(', ')}];`,
  "}",
  "/** A `Models` collection with every built-in provider registered. */",
  "export function builtinModels(options) {",
  "    const models = createModels(options);",
  "    for (const provider of builtinProviders()) {",
  "        models.setProvider(provider);",
  "    }",
  "    return models;",
  "}",
  "/** All built-in image-generation providers, freshly constructed. */",
  "export function builtinImagesProviders() {",
  `    return [${PI_AI_PROVIDER_EXPORTS['openrouter-images']}()];`,
  "}",
  "/** An `ImagesModels` collection with every built-in image provider. */",
  "export function builtinImagesModels(options) {",
  "    const models = createImagesModels(options);",
  "    for (const provider of builtinImagesProviders()) {",
  "        models.setProvider(provider);",
  "    }",
  "    return models;",
  "}",
].join('\n');

const BRIDGES = [
  // The pi-ai loader shadows FIRST (definition order is irrelevant to
  // resolution — every row lands in the same registry before any spec
  // loads — but keeping the family together reads top-down).
  ...PI_AI_MODEL_SHADOWS,
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
  // The importing vendored package binds the default export and
  // `chokidar.watch(path, options)`, so the shim is exactly that face —
  // served over the workspace VFS's mutation registry (fs-workspace's
  // wsWatch; a write IS the event, no polling — D8). 'ready' fires on the
  // next timer tick (after the initial scan that has nothing to scan);
  // 'all' fires on mutations of the watched path; close() unhooks. A path
  // outside the workspace still fails loud through watchPath (rule 5), so
  // an accidental watch:true mount over an unwatchable surface never
  // silently no-ops.
  ['chokidar', [
    "import { _wsAt as wsAt, _wsWatch as wsWatchRegister } from 'node:fs';",
    "// Real chokidar's watch() returns the FSWatcher SYNCHRONOUSLY (the path",
    "// argument may be async internally) — the vendored settings-file init",
    "// binds `watcher.on(...)` on the returned value with no await, so this",
    "// face must not be a promise (measured 2026-09-27).",
    "export const watch = (path, _options = {}) => {",
    "  const handlers = { all: [], ready: [], error: [] };",
    "  let closed = false;",
    "  let unwatch = null;",
    "  try {",
    "    const at = wsAt(String(path));",
    "    if (at === null) {",
    "      throw new Error(`chokidar.watch: path outside the writable workspace root: ${path}`);",
    "    }",
    "    unwatch = wsWatchRegister(at.path, () => {",
    "      if (closed) return;",
    "      for (const handler of [...handlers.all]) handler();",
    "    });",
    "  } catch (error) {",
    "    for (const handler of [...handlers.error]) handler(error);",
    "    throw error;",
    "  }",
    "  const watcher = {",
    "    on(event, handler) {",
    "      if (handlers[event] === undefined) return watcher;",
    "      handlers[event].push(handler);",
    "      return watcher;",
    "    },",
    "    close: async () => { closed = true; unwatch(); },",
    "  };",
    "  setTimeout(() => { if (!closed) for (const handler of [...handlers.ready]) handler(); }, 0);",
    "  return watcher;",
    "};",
    "export default { watch };",
  ].join('\n')],

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

  // @deepseek-ai/dsh-sandbox-windows-acl — vendored tarball whose lib/index.js
  // carries RELATIVE chunk imports ('./types-CutH1Lgc.js', the dsh-subprocess-
  // local code-split precedent): loaded under the BARE specifier the host
  // normalizes those relatives against '@deepseek-ai' (no subpath to carry
  // the package directory) and the chunk can never resolve. The dsh-sandbox-
  // local lib imports the bare name at MODULE scope (AclWriteGrant et al. —
  // linkage every sandbox spec loads, even on darwin), so the re-export via
  // the ABSOLUTE path lets the chunk re-enter beside its importer. One
  // instance: the vendored package imports nothing else by the bare name.
  ['@deepseek-ai/dsh-sandbox-windows-acl',
    "export * from '/vendor/dsh/sandbox-windows-acl@0.1.6-alpha.2/lib/index.js';"],

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

  // execa: NO vendored tree (the cross-spawn precedent, same D2 wall). The
  // vendored dsh-plugin-manager and dsh-loader-smoke libs import { execa } at
  // MODULE scope for their pnpm/loader-subprocess faces; the linkage row
  // resolves the bare name and the member fails loud when CALLED. The specs
  // that load these libs only exercise pure config/render logic (or
  // self-skip on spawnSync's no-process result), never reach the call.
  ['execa', [
    "const refuse = (name) => () => {",
    "  throw new Error('execa: ' + name + ' is not served in this runtime — no subprocess seam (rule D2)');",
    "};",
    "export const execa = refuse('execa');",
    "export const $ = refuse('$');",
    "export default { execa, $ };",
  ].join('\n')],

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
