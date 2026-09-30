// dsh:logging-exempt (shim layer; specifier registration, no logging surface)
/**
 * shims/npm-bridges-pi-ai-all.js — the composed providers/all barrel and the
 * pi-ai bridge rows, split from npm-bridges-pi-ai.js when the fallback seam
 * pushed it past the size budget (that file was AT the 500-line ceiling —
 * npm-bridges.js's header already named this fragment).
 *
 * One-directional dependency: this file imports the seam TABLES from
 * npm-bridges-pi-ai.js; nothing imports back (an ESM cycle here would be
 * top-level and TDZ-fatal under QuickJS).
 */
import {
  PI_AI_DIST,
  PI_AI_PROVIDER_EXPORTS,
  PI_AI_PROVIDER_IDS,
} from 'upstream/shims/npm-bridges-pi-ai.js';

/** The composed providers/all barrel: the real all.js body with its two
 * attribute imports rewritten to the JSON seam; the refuseProviders stubs
 * grow the REAL construction bodies. */
const PI_AI_PROVIDERS_ALL = [
  `import { createModels } from '${PI_AI_DIST}/models.js';`,
  `import { createImagesModels } from '${PI_AI_DIST}/images-models.js';`,
  `import { MODELS } from '${PI_AI_DIST}/models.generated.js';`,
  // The manifest's literal dot name cannot ride the mobile HAP/APK packers
  // (both drop hidden files — the harmony device legs died at
  // materializeBundle on exactly this, 2026-09-30): the staged closure
  // carries the SAME bytes under the non-hidden alias, and the seam reads
  // the literal name where it exists (the desktop/iOS embeds), else the
  // alias.
  `let manifestText;`,
  `try { manifestText = globalThis.__dshBundleRequire(`,
  `  '${PI_AI_DIST}/providers/all.js', './data/.manifest.json'); }`,
  `catch { manifestText = globalThis.__dshBundleRequire(`,
  `  '${PI_AI_DIST}/providers/all.js', './data/manifest.json'); }`,
  `const manifest = JSON.parse(manifestText);`,
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

// The pi-ai loader shadows first (order is irrelevant to resolution —
// every row lands in the same registry before any spec loads).
export const PI_AI_BRIDGES = [
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
  ['buffer', [
    "export { Buffer } from 'upstream/shims/buffer.js';",
    // npm buffer@6 also exports the size ceiling the webworker-runtime
    // buffer/streams limbs read (kMaxLength, kStringMaxLength): node's
    // 64-bit values.
    "export const kMaxLength = 4294967296;",
    "export const kStringMaxLength = 536870888;",
  ].join('\n')],

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

  // @testing-library/react (W5-T): linkage-only. The vendored
  // dsh-client-test-runtime lib imports { act, render, within } at module
  // scope, so every spec importing a member of it (provider.client →
  // RemoteError) needs the specifier to RESOLVE. No staged spec calls the
  // renderers (the client/* suites are out of this phase's scope), so the
  // face is the chokidar precedent: linkage satisfied, every renderer fails
  // loud when CALLED (rule 5). The full package needs react-dom + @babel/
  // runtime — a vendoring round that only a staged UI-rendering spec can
  // justify.
  ['@testing-library/react', [
    "const refuse = (name) => () => {",
    "  throw new Error('@testing-library/react: ' + name + ' is not served in this runtime — no DOM renderer surface (linkage stub)');",
    "};",
    "export const act = (callback) => typeof callback === 'function' ? callback() : Promise.resolve();",
    "export const render = refuse('render');",
    "export const within = refuse('within');",
    "export const cleanup = () => {};",
    "export const fireEvent = refuse('fireEvent');",
    "export const screen = new Proxy({}, { get() { return refuse('screen.*'); } });",
    "export default { act, render, within, cleanup, fireEvent, screen };",
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
    "import { makeRequire } from 'upstream/shims/cjs-loader.js';",
    "globalThis.process ??= proc;",
    "globalThis.global ??= globalThis;",
    // The CJS face's global require (ESM vendored files calling bare
    // require() — turndown's createHTMLParser is the operative caller).
    // Bare requests need a cjs-loader table row and fail loud naming the
    // specifier otherwise (the linkage-stub contract, now backed by real
    // resolution for the tabled CJS-vendor packages).
    "globalThis.require ??= (name) => makeRequire('/')(name);",
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
  ['@noble/hashes/hmac.js', "export * from '/vendor/npm/@noble/hashes@2.3.0/hmac.js';"],
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
  // resolve.exports 2.0.3 (the r3-P boot plugin-manager row, restored W5-T):
  // the vendored dsh-plugin-manager lib imports it bare at runtime — the
  // transpiler's BARE_RESOLVES inline row only covers spec-graph imports,
  // so the runtime face needs its own row over the vendored tree.
  ['resolve.exports', "export * from '/vendor/npm/resolve.exports@2.0.3/dist/index.mjs';"],

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

  // execa: the promise-child face over the W5-R child_process seam (the old
  // "no subprocess seam" refusal is obsolete — __dshProcSpawn exists, children
  // never run JS in THIS runtime, D2 holds). Serves the faces the vendored
  // dsh-plugin-manager / dsh-loader-smoke libs and the upstream process-exit
  // spec drive: promise + {exitCode, signal, stdout, stderr, timedOut,
  // failed}, .kill(signal), input, stdin:'ignore', timeout + killSignal,
  // reject:false, stripFinalNewline. Env merges over the runtime's
  // process.env like real execa (callers pass ADDITIONS — DSH_HOME et al. —
  // and the child still needs PATH).
  ['execa', [
    "import { spawn } from 'node:child_process';",
    "const fail = (name) => () => { throw new Error('execa: ' + name + ' is not implemented in this runtime'); };",
    "const stripFinalNewline = (value) => (typeof value === 'string' ? value.replace(/\\r?\\n$/, '') : value);",
    "export const execa = (command, args = [], options = {}) => {",
    "  const argv = Array.isArray(args) ? args : [args];",
    "  const stdinMode = (options.stdin ?? options.stdio) === 'ignore' ? 'ignore' : 'pipe';",
    "  const child = spawn(command, argv, {",
    "    cwd: options.cwd,",
    "    env: options.env ? { ...(globalThis.process?.env ?? {}), ...options.env } : undefined,",
    "    stdio: [stdinMode, 'pipe', 'pipe'],",
    "  });",
    "  const state = { timedOut: false, killed: false };",
    "  let timer = null;",
    "  if (typeof options.timeout === 'number' && options.timeout > 0) {",
    "    timer = setTimeout(() => { state.timedOut = true; child.kill(options.killSignal ?? 'SIGTERM'); }, options.timeout);",
    "  }",
    "  const promise = new Promise((resolve, reject) => {",
    "    const out = []; const err = [];",
    "    child.stdout?.on('data', (c) => out.push(c));",
    "    child.stderr?.on('data', (c) => err.push(c));",
    "    child.once('error', (error) => { if (timer) clearTimeout(timer); reject(Object.assign(error, { command, escapedCommand: command, stdout: '', stderr: '', failed: true, timedOut: state.timedOut, killed: state.killed })); });",
    "    child.once('close', (code, signal) => {",
    "      if (timer) clearTimeout(timer);",
    "      const decode = (chunks) => { const joined = chunks.map((c) => (typeof c === 'string' ? c : Buffer.from(c).toString('utf8'))).join(''); return options.stripFinalNewline === false ? joined : stripFinalNewline(joined); };",
    "      const result = {",
    "        command: [command, ...argv].join(' '),",
    "        escapedCommand: [command, ...argv].join(' '),",
    "        exitCode: signal == null ? code : undefined,",
    "        signal: signal == null ? undefined : signal,",
    "        stdout: decode(out),",
    "        stderr: decode(err),",
    "        failed: code !== 0 || signal != null,",
    "        timedOut: state.timedOut,",
    "        killed: state.killed || child.killed === true,",
    "      };",
    "      if (result.failed && options.reject !== false) {",
    "        reject(Object.assign(new Error('Command failed with exit code ' + String(result.exitCode) + ': ' + result.command), result));",
    "      } else { resolve(result); }",
    "    });",
    "  });",
    "  promise.kill = (signal) => { state.killed = true; return child.kill(signal ?? 'SIGTERM'); };",
    "  promise.pid = child.pid;",
    "  if (stdinMode === 'pipe') {",
    "    if (options.input !== undefined && options.input !== null) child.stdin?.write(options.input);",
    "    child.stdin?.end();",
    "  }",
    "  return promise;",
    "};",
    "export const $ = fail('$');",
    "export const execaSync = fail('execaSync');",
    "export const execaCommand = fail('execaCommand');",
    "export default { execa, $, execaSync, execaCommand };",
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
];
