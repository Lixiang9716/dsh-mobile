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
// The rows live in fragment modules (the file crossed the size budget):
// pi-ai seam tables + rows in npm-bridges-pi-ai.js (+ the composed barrel in
// npm-bridges-pi-ai-all.js), the openai/CJS/otel/mime rows in
// npm-bridges-b.js, the partial-json/undici/typescript rows in
// npm-bridges-c.js.
import { PI_AI_BRIDGES, PI_AI_MODEL_SHADOWS } from 'upstream/shims/npm-bridges-pi-ai.js';
import { BRIDGES_B } from 'upstream/shims/npm-bridges-b.js';
import { BRIDGES_C } from 'upstream/shims/npm-bridges-c.js';
const BRIDGES = [
  ...PI_AI_BRIDGES,
  ...PI_AI_MODEL_SHADOWS,
  ...BRIDGES_B,
  ...BRIDGES_C,
  // typescript 6.0.3 (W5-T): the typert generator + remote-mock proxy-types
  // specs' default import. One self-contained CJS file (no internal
  // requires); the chain is a single link. LOAD EXPERIMENT: 9.1 MB of JS in
  // quickjs — the specs exercise ts.createSourceFile/transform on small
  // inputs, so the question is parse time + memory, which this round
  // measures (90s class budget, documented in tmp/r3-ledger-T.json).
  ['dsh-bridge-setup/typescript-cjs-0', [
    "import 'dsh-bridge-setup/cjs-chain-scope';",
    "import * as pathShim from 'upstream/shims/path.js';",
    "import * as osShim from 'upstream/shims/os.js';",
    "import * as utilShim from 'upstream/shims/util.js';",
    "import fsDefault from 'upstream/shims/fs.js';",
    // lib/typescript.js's getNodeSystem require()s the node builtins it
    // might use at module init; the shims carry those faces.
    "globalThis.__dshCjsFaces.set('fs', fsDefault);",
    "globalThis.__dshCjsFaces.set('path', pathShim);",
    "globalThis.__dshCjsFaces.set('os', osShim);",
    "globalThis.__dshCjsFaces.set('util', utilShim);",
    // The bundle probes ambient __filename/__dirname in getNodeSystem
    // (isFileSystemCaseSensitive). Ambient for exactly this file's
    // evaluation; the capture link hands them back.
    "globalThis.__filename = '/vendor/npm/typescript@6.0.3/lib/typescript.js';",
    "globalThis.__dirname = '/vendor/npm/typescript@6.0.3/lib';",
    "globalThis.process ??= { platform: 'linux', env: {}, argv: [], cwd: () => '/', nextTick: (fn) => fn() };",
    "globalThis.__dshCjsSetup('typescript');",
  ].join('\n')],
  ['dsh-bridge-setup/typescript-cjs-1', [
    "import 'dsh-bridge-setup/typescript-cjs-0';",
    "import '/vendor/npm/typescript@6.0.3/lib/typescript.js';",
    "delete globalThis.__filename;",
    "delete globalThis.__dirname;",
    "globalThis.__dshCjsKeep('typescript');",
    "globalThis.__dshTypescriptFace = globalThis.module.exports;",
    "if (typeof globalThis.__dshTypescriptFace?.createSourceFile !== 'function') {",
    "  throw new Error('npm-bridges: typescript CJS face evaluated to an unexpected shape');",
    "}",
  ].join('\n')],
  ['typescript', [
    "import 'dsh-bridge-setup/typescript-cjs-1';",
    "const ts = globalThis.__dshTypescriptFace;",
    "export default ts;",
  ].join('\n')],

  ['mime-types', [
    "import 'dsh-bridge-setup/mime-cjs-3';",
    "const mimeTypes = globalThis.__dshMimeTypesFace;",
    "export default mimeTypes;",
    "export const charset = mimeTypes.charset;",
    "export const charsets = mimeTypes.charsets;",
    "export const contentType = mimeTypes.contentType;",
    "export const extension = mimeTypes.extension;",
    "export const extensions = mimeTypes.extensions;",
    "export const lookup = mimeTypes.lookup;",
    "export const types = mimeTypes.types;",
  ].join('\n')],

  // ---- per-face CJS adapter chains (the ipaddr/gfm pattern generalized).
  // ONE scope module owns globals module/exports/require + a faces map.
  // ESM import order is depth-first over the import list with bodies
  // interleaved only BETWEEN modules — so each vendored CJS file gets its
  // own chain module: import the previous link, import the file (it sees
  // the previous link's captured faces through the require stub), capture
  // its exports in the body. Captures inside one module's body would run
  // only after ALL its imports (measured: shell.js saw no './grammars/
  // shell' face and the chain threw). ----
  ['dsh-bridge-setup/cjs-chain-scope', [
    // Registry model: every file of a chain gets its exports object
    // PRE-REGISTERED before evaluation — CJS cycles (picomatch's
    // constants <-> utils) then see each other's live, partially-filled
    // exports, exactly like a real CJS loader. __dshCjsSetup(key) binds
    // the ambient module/exports to that object for the file evaluated
    // next; each chain link imports the previous link, then its file.
    "globalThis.__dshCjsFaces = new Map();",
    "globalThis.require = (request) => {",
    "  if (!globalThis.__dshCjsFaces.has(request)) {",
    "    throw new Error('npm-bridges: CJS adapter chain has no face for require(' + JSON.stringify(request) + ')');",
    "  }",
    "  return globalThis.__dshCjsFaces.get(request);",
    "};",
    "globalThis.__dshCjsSetup = (key) => {",
    "  if (!globalThis.__dshCjsFaces.has(key)) globalThis.__dshCjsFaces.set(key, {});",
    "  globalThis.module = { exports: globalThis.__dshCjsFaces.get(key) };",
    "  globalThis.exports = globalThis.module.exports;",
    "};",
    // Files that REBIND module.exports (pegjs grammars, the react min
    // build, mimeScore) leave the registered object behind; the evaluating
    // link re-points the key at the final exports.
    "globalThis.__dshCjsKeep = (key) => globalThis.__dshCjsFaces.set(key, globalThis.module.exports);",
    // Files that REBIND module.exports (pegjs grammars, the react min
    // build, the picomatch/index shims) leave the registered object behind;
    // the evaluating link re-points the key at the final exports.
    "globalThis.__dshCjsKeep = (key) => globalThis.__dshCjsFaces.set(key, globalThis.module.exports);",
  ].join('\n')],

  // react 18.3.1 (the cordis-client-runner + api-workspace-files client
  // specs): index.js is a one-require CJS shim over cjs/react.production.
  // min.js.
  ['dsh-bridge-setup/react-cjs-0', [
    "import 'dsh-bridge-setup/cjs-chain-scope';",
    "globalThis.__dshCjsSetup('./cjs/react.production.min.js');",
  ].join('\n')],
  ['dsh-bridge-setup/react-cjs-1', [
    "import 'dsh-bridge-setup/react-cjs-0';",
    "import '/vendor/npm/react@18.3.1/cjs/react.production.min.js';",
    "globalThis.__dshCjsKeep('./cjs/react.production.min.js');",
    // index.js picks production vs development from process.env.NODE_ENV —
    // the runtime runs development — so BOTH builds are served.
    "globalThis.__dshCjsSetup('./cjs/react.development.js');",
  ].join('\n')],
  ['dsh-bridge-setup/react-cjs-1b', [
    "import 'dsh-bridge-setup/react-cjs-1';",
    "import '/vendor/npm/react@18.3.1/cjs/react.development.js';",
    "globalThis.__dshCjsKeep('./cjs/react.development.js');",
    "globalThis.__dshCjsSetup('index');",
  ].join('\n')],
  ['dsh-bridge-setup/react-cjs-2', [
    "import 'dsh-bridge-setup/react-cjs-1b';",
    "import '/vendor/npm/react@18.3.1/index.js';",
    "globalThis.__dshCjsKeep('index');",
    "globalThis.__dshReactFace = globalThis.module.exports;",
    "if (typeof globalThis.__dshReactFace?.createElement !== 'function') {",
    "  throw new Error('npm-bridges: react CJS face evaluated to an unexpected shape');",
    "}",
  ].join('\n')],

  // @yarnpkg/parsers 3.1.0 (the webworker-runtime shell limbs: parseShell).
  // CJS over three pegjs grammars + wrapper files; syml.js requires js-yaml
  // at top level, served from the vendored UMD dist (single file).
  ['dsh-bridge-setup/parsers-cjs-0', [
    "import 'dsh-bridge-setup/cjs-chain-scope';",
    "globalThis.__dshCjsSetup('js-yaml');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-1', [
    "import 'dsh-bridge-setup/parsers-cjs-0';",
    "import '/vendor/npm/js-yaml@4.1.0/dist/js-yaml.js';",
    "globalThis.__dshCjsKeep('js-yaml');",
    "globalThis.__dshCjsSetup('./grammars/shell');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-2', [
    "import 'dsh-bridge-setup/parsers-cjs-1';",
    "import '/vendor/npm/@yarnpkg/parsers@3.1.0/lib/grammars/shell.js';",
    "globalThis.__dshCjsKeep('./grammars/shell');",
    "globalThis.__dshCjsSetup('./shell');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-3', [
    "import 'dsh-bridge-setup/parsers-cjs-2';",
    "import '/vendor/npm/@yarnpkg/parsers@3.1.0/lib/shell.js';",
    "globalThis.__dshCjsKeep('./shell');",
    "globalThis.__dshCjsSetup('./grammars/resolution');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-4', [
    "import 'dsh-bridge-setup/parsers-cjs-3';",
    "import '/vendor/npm/@yarnpkg/parsers@3.1.0/lib/grammars/resolution.js';",
    "globalThis.__dshCjsKeep('./grammars/resolution');",
    "globalThis.__dshCjsSetup('./resolution');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-5', [
    "import 'dsh-bridge-setup/parsers-cjs-4';",
    "import '/vendor/npm/@yarnpkg/parsers@3.1.0/lib/resolution.js';",
    "globalThis.__dshCjsKeep('./resolution');",
    "globalThis.__dshCjsSetup('./grammars/syml');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-6', [
    "import 'dsh-bridge-setup/parsers-cjs-5';",
    "import '/vendor/npm/@yarnpkg/parsers@3.1.0/lib/grammars/syml.js';",
    "globalThis.__dshCjsKeep('./grammars/syml');",
    "globalThis.__dshCjsSetup('./syml');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-7', [
    "import 'dsh-bridge-setup/parsers-cjs-6';",
    "import '/vendor/npm/@yarnpkg/parsers@3.1.0/lib/syml.js';",
    "globalThis.__dshCjsKeep('./syml');",
    "globalThis.__dshCjsSetup('index');",
  ].join('\n')],
  ['dsh-bridge-setup/parsers-cjs-8', [
    "import 'dsh-bridge-setup/parsers-cjs-7';",
    "import '/vendor/npm/@yarnpkg/parsers@3.1.0/lib/index.js';",
    "globalThis.__dshCjsKeep('index');",
    "globalThis.__dshParsersFace = globalThis.module.exports;",
    "if (typeof globalThis.__dshParsersFace?.parseShell !== 'function') {",
    "  throw new Error('npm-bridges: @yarnpkg/parsers CJS face evaluated to an unexpected shape');",
    "}",
  ].join('\n')],

  // picomatch 2.3.1 (the webworker-runtime shell expand/programs limbs).
  // CJS: index → lib/picomatch → {scan,parse,utils,constants}; constants
  // and utils are mutually circular (the pre-registered exports objects
  // give the real CJS partial-exports semantics); utils requires node:path,
  // served by the shim through the faces map.
  // negotiator 1.1.0 (the vendored dsh-host-webserver's gzip middleware:
  // `new Negotiator(req).encoding(['gzip','identity'])`). CJS over
  // lib/{accept,charset,encoding,language,mediaType}; accept/charset/
  // language/mediaType require 'content-type' — served as a LOUD stub:
  // only the encoding-negotiation face runs without it.

  ['dsh-bridge-setup/negotiator-cjs-0', [
    "import 'dsh-bridge-setup/cjs-chain-scope';",
    "globalThis.__dshCjsFaces.set('content-type', { parse: () => { throw new Error('negotiator: content-type parse is not served in this runtime'); }, format: () => { throw new Error('negotiator: content-type format is not served in this runtime'); } });",
    "globalThis.__dshCjsSetup('./lib/accept');",
    "globalThis.__dshCjsFaces.set('./accept', globalThis.__dshCjsFaces.get('./lib/accept'));",
  ].join('\n')],
  ['dsh-bridge-setup/negotiator-cjs-1', [
    "import 'dsh-bridge-setup/negotiator-cjs-0';",
    "import '/vendor/npm/negotiator@1.1.0/lib/accept.js';",
    "globalThis.__dshCjsKeep('./lib/accept');",
    "globalThis.__dshCjsFaces.set('./accept', globalThis.__dshCjsFaces.get('./lib/accept'));",
    "globalThis.__dshCjsSetup('./lib/charset');",
    "globalThis.__dshCjsFaces.set('./charset', globalThis.__dshCjsFaces.get('./lib/charset'));",
  ].join('\n')],
  ['dsh-bridge-setup/negotiator-cjs-2', [
    "import 'dsh-bridge-setup/negotiator-cjs-1';",
    "import '/vendor/npm/negotiator@1.1.0/lib/charset.js';",
    "globalThis.__dshCjsKeep('./lib/charset');",
    "globalThis.__dshCjsFaces.set('./charset', globalThis.__dshCjsFaces.get('./lib/charset'));",
    "globalThis.__dshCjsSetup('./lib/encoding');",
    "globalThis.__dshCjsFaces.set('./encoding', globalThis.__dshCjsFaces.get('./lib/encoding'));",
  ].join('\n')],
  ['dsh-bridge-setup/negotiator-cjs-3', [
    "import 'dsh-bridge-setup/negotiator-cjs-2';",
    "import '/vendor/npm/negotiator@1.1.0/lib/encoding.js';",
    "globalThis.__dshCjsKeep('./lib/encoding');",
    "globalThis.__dshCjsFaces.set('./encoding', globalThis.__dshCjsFaces.get('./lib/encoding'));",
    "globalThis.__dshCjsSetup('./lib/language');",
    "globalThis.__dshCjsFaces.set('./language', globalThis.__dshCjsFaces.get('./lib/language'));",
  ].join('\n')],
  ['dsh-bridge-setup/negotiator-cjs-4', [
    "import 'dsh-bridge-setup/negotiator-cjs-3';",
    "import '/vendor/npm/negotiator@1.1.0/lib/language.js';",
    "globalThis.__dshCjsKeep('./lib/language');",
    "globalThis.__dshCjsFaces.set('./language', globalThis.__dshCjsFaces.get('./lib/language'));",
    "globalThis.__dshCjsSetup('./lib/mediaType');",
    "globalThis.__dshCjsFaces.set('./mediaType', globalThis.__dshCjsFaces.get('./lib/mediaType'));",
  ].join('\n')],
  ['dsh-bridge-setup/negotiator-cjs-5', [
    "import 'dsh-bridge-setup/negotiator-cjs-4';",
    "import '/vendor/npm/negotiator@1.1.0/lib/mediaType.js';",
    "globalThis.__dshCjsKeep('./lib/mediaType');",
    "globalThis.__dshCjsFaces.set('./mediaType', globalThis.__dshCjsFaces.get('./lib/mediaType'));",
    "globalThis.__dshCjsSetup('index');",
  ].join('\n')],
  ['dsh-bridge-setup/negotiator-cjs-6', [
    "import 'dsh-bridge-setup/negotiator-cjs-5';",
    "import '/vendor/npm/negotiator@1.1.0/index.js';",
    "globalThis.__dshNegotiatorFace = globalThis.module.exports;",
    "if (typeof globalThis.__dshNegotiatorFace !== 'function') {",
    "  throw new Error('npm-bridges: negotiator CJS face evaluated to an unexpected shape');",
    "}",
  ].join('\n')],
  ['negotiator', [
    "import 'dsh-bridge-setup/negotiator-cjs-6';",
    "export default globalThis.__dshNegotiatorFace;",
  ].join('\n')],
  ['dsh-bridge-setup/picomatch-cjs-0', [
    "import 'dsh-bridge-setup/cjs-chain-scope';",
    "import * as pathShim from 'upstream/shims/path.js';",
    "globalThis.__dshCjsFaces.set('path', pathShim);",
    "globalThis.__dshCjsSetup('./constants');",
  ].join('\n')],
  ['dsh-bridge-setup/picomatch-cjs-1', [
    "import 'dsh-bridge-setup/picomatch-cjs-0';",
    "import '/vendor/npm/picomatch@2.3.1/lib/constants.js';",
    "globalThis.__dshCjsKeep('./constants');",
    "globalThis.__dshCjsSetup('./utils');",
  ].join('\n')],
  ['dsh-bridge-setup/picomatch-cjs-2', [
    "import 'dsh-bridge-setup/picomatch-cjs-1';",
    "import '/vendor/npm/picomatch@2.3.1/lib/utils.js';",
    "globalThis.__dshCjsKeep('./utils');",
    "globalThis.__dshCjsSetup('./parse');",
  ].join('\n')],
  ['dsh-bridge-setup/picomatch-cjs-3', [
    "import 'dsh-bridge-setup/picomatch-cjs-2';",
    "import '/vendor/npm/picomatch@2.3.1/lib/parse.js';",
    "globalThis.__dshCjsKeep('./parse');",
    "globalThis.__dshCjsSetup('./scan');",
  ].join('\n')],
  ['dsh-bridge-setup/picomatch-cjs-4', [
    "import 'dsh-bridge-setup/picomatch-cjs-3';",
    "import '/vendor/npm/picomatch@2.3.1/lib/scan.js';",
    "globalThis.__dshCjsKeep('./scan');",
    "globalThis.__dshCjsSetup('./lib/picomatch');",
  ].join('\n')],
  ['dsh-bridge-setup/picomatch-cjs-5', [
    "import 'dsh-bridge-setup/picomatch-cjs-4';",
    "import '/vendor/npm/picomatch@2.3.1/lib/picomatch.js';",
    "globalThis.__dshCjsKeep('./lib/picomatch');",
    "globalThis.__dshCjsSetup('index');",
  ].join('\n')],
  ['dsh-bridge-setup/picomatch-cjs-6', [
    "import 'dsh-bridge-setup/picomatch-cjs-5';",
    "import '/vendor/npm/picomatch@2.3.1/index.js';",
    "globalThis.__dshCjsKeep('index');",
    "globalThis.__dshPicomatchFace = globalThis.module.exports;",
    "if (typeof globalThis.__dshPicomatchFace !== 'function') {",
    "  throw new Error('npm-bridges: picomatch CJS face evaluated to an unexpected shape');",
    "}",
  ].join('\n')],
  // react 18.3.1 face: named exports enumerated from the production
  // build's export keys (the client-runner closure does `import * as
  // React`).
  ['react', [
    "import 'dsh-bridge-setup/react-cjs-2';",
    "const React = globalThis.__dshReactFace;",
    "export default React;",
    "export const Children = React.Children;",
    "export const Component = React.Component;",
    "export const Fragment = React.Fragment;",
    "export const Profiler = React.Profiler;",
    "export const PureComponent = React.PureComponent;",
    "export const StrictMode = React.StrictMode;",
    "export const Suspense = React.Suspense;",
    "export const cloneElement = React.cloneElement;",
    "export const createContext = React.createContext;",
    "export const createElement = React.createElement;",
    "export const createFactory = React.createFactory;",
    "export const createRef = React.createRef;",
    "export const forwardRef = React.forwardRef;",
    "export const isValidElement = React.isValidElement;",
    "export const lazy = React.lazy;",
    "export const memo = React.memo;",
    "export const startTransition = React.startTransition;",
    "export const act = React.act;",
    "export const useCallback = React.useCallback;",
    "export const useContext = React.useContext;",
    "export const useDebugValue = React.useDebugValue;",
    "export const useDeferredValue = React.useDeferredValue;",
    "export const useEffect = React.useEffect;",
    "export const useId = React.useId;",
    "export const useImperativeHandle = React.useImperativeHandle;",
    "export const useInsertionEffect = React.useInsertionEffect;",
    "export const useLayoutEffect = React.useLayoutEffect;",
    "export const useMemo = React.useMemo;",
    "export const useReducer = React.useReducer;",
    "export const useRef = React.useRef;",
    "export const useState = React.useState;",
    "export const useSyncExternalStore = React.useSyncExternalStore;",
    "export const useTransition = React.useTransition;",
    "export const version = React.version;",
  ].join('\n')],
  // @yarnpkg/parsers face: the wrapper index re-exports the three
  // grammars; the shell limbs use parseShell (+ type-only names).
  ['@yarnpkg/parsers', [
    "import 'dsh-bridge-setup/parsers-cjs-8';",
    "const parsers = globalThis.__dshParsersFace;",
    "export default parsers;",
    "export const parseShell = parsers.parseShell;",
    "export const stringifyShell = parsers.stringifyShell;",
    "export const stringifyShellLine = parsers.stringifyShellLine;",
    "export const stringifyCommandLine = parsers.stringifyCommandLine;",
    "export const stringifyCommandLineThen = parsers.stringifyCommandLineThen;",
    "export const stringifyCommandChain = parsers.stringifyCommandChain;",
    "export const stringifyCommandChainThen = parsers.stringifyCommandChainThen;",
    "export const stringifyCommand = parsers.stringifyCommand;",
    "export const stringifyArgument = parsers.stringifyArgument;",
    "export const stringifyArgumentSegment = parsers.stringifyArgumentSegment;",
    "export const stringifyRedirectArgument = parsers.stringifyRedirectArgument;",
    "export const stringifyEnvSegment = parsers.stringifyEnvSegment;",
    "export const stringifyValueArgument = parsers.stringifyValueArgument;",
    "export const stringifyArithmeticExpression = parsers.stringifyArithmeticExpression;",
    "export const parseResolution = parsers.parseResolution;",
    "export const stringifyResolution = parsers.stringifyResolution;",
    "export const parseSyml = parsers.parseSyml;",
    "export const stringifySyml = parsers.stringifySyml;",
  ].join('\n')],
  ['picomatch', [
    "import 'dsh-bridge-setup/picomatch-cjs-6';",
    "const picomatch = globalThis.__dshPicomatchFace;",
    "export default picomatch;",
  ].join('\n')]
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

// node-pty — the FIRST-PARTY PTY face over the host forkpty seam (decision
// D-b, 2026-09-29; contract/proposals/2026-09-29-forkpty-face.md). The
// vendored `dsh-subprocess-local` terminal path loads its backend through
// `createLazyRequire('node-pty')`, whose require face routes bare names
// through the cjs-loader's builtin-face table (the 'ws' row precedent).
// Registered here — a module the product boot AND the suite driver both
// import — so the lazy require resolves wherever vendored code runs; a
// host whose toolchain lacks forkpty fails the spawn loud at its own
// intrinsic (the honest unavailable, never a fake).
import { registerBuiltinFace } from 'upstream/shims/cjs-loader.js';
import nodePtyFace from 'upstream/shims/node-pty.js';
registerBuiltinFace('node-pty', nodePtyFace);
