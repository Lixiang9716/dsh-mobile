// transpile-rewrites.mjs — the source->source path-rewrite machinery of the
// upstream-suite transpiler (submodule bare-specifier resolution, the
// createRequire JSON hoist, the monorepo src/ subpath hoists, the bundle
// manifest and seed-tree root rewrites), split out of transpile.mjs when
// that file crossed the code-size budget. Pure functions over source text:
// no side effects, no imports beyond node builtins.
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname;
const TESTS = join(ROOT, 'runtime/spike/vendor/dsh-tests@dsh-v0.1.6-alpha.2/packages');

/** The unvendored-limb stub load (module level for size). The .cjs suffix
 * makes esbuild treat the stub as CommonJS, which is what lets named
 * imports of arbitrary symbols link through property access instead of
 * failing "No matching export" at build time. */
const unvendoredStubLoad = () => ({
  contents: 'module.exports = new Proxy({}, { get(_t, key) {'
    + ' return () => { throw new Error("unvendored limb executed at runtime: " + String(key)); };'
    + ' } });',
  loader: 'js',
});

/** The inlined-limb JSON-manifest rewrite load (module level for size):
 * rewrites createRequire(import.meta.url)('<x>.json') reads under the tests
 * tree to bundled JSON imports (the limb's resolveDir keeps the relative
 * path pointed at the now-staged package.json). */
const limbJsonLoad = (args) => {
  if (!args.path.startsWith(TESTS)) return undefined;
  const source = readFileSync(args.path, 'utf8');
  const re = /createRequire\(import\.meta\.url\)\(([\x27\x22])([^\x27\x22]+\.json)\1\)/g;
  if (!re.test(source)) return undefined;
  re.lastIndex = 0;
  const imports = [];
  const rewritten = source.replace(re, (_m, _q, rawPath) => {
    const name = `__dsh_limb_json_${imports.length}`;
    imports.push(`import ${name} from ${JSON.stringify(rawPath)};`);
    return name;
  });
  return {
    contents: `${imports.join('\n')}\n${rewritten}`,
    loader: args.path.endsWith('.js') || args.path.endsWith('.mjs') ? 'js' : 'ts',
    resolveDir: dirname(args.path),
  };
};

/** The submodule bare-resolution rows (module level for size): the
 * @deepseek-ai packages resolve inline (src/ hoists) or external-subpath;
 * the @opentelemetry family inlines the vendored build/esm faces (their
 * extensionless self-imports need esbuild's resolver - see the factory
 * comment). */
let SUBMODULE_ROOT = join(ROOT, 'third-party/deepseek-harness');
try {
  SUBMODULE_ROOT = realpathSync(SUBMODULE_ROOT);
} catch {
  /* absent submodule: SUBMODULE_SRC_HOISTS targets fail existsSync and the
   * generic monorepo-src exclusion names the specifier instead */
}

const abs = (rel) => join(SUBMODULE_ROOT, rel);
const otel = (name, ver) => ({
  inline: join(ROOT, `runtime/spike/vendor/npm/@opentelemetry/${name}@${ver}/build/esm/index.js`),
});

const SUBMODULE_BARE_ROWS = new Map([
    ['@deepseek-ai/dsh-subprocess-local', { externalSubpath: 'index' }],
    ['@deepseek-ai/cordis-plugin-group', { inline: abs('vendor/group/lib/index.js') }],
    ['@deepseek-ai/dsh-app-boot', { inline: abs('packages/boot/app-boot/src/index.ts') }],
    ['resolve.exports', {
      inline: abs('node_modules/.pnpm/resolve.exports@2.0.3'
        + '/node_modules/resolve.exports/dist/index.mjs'),
    }],
    ['@opentelemetry/api', otel('api', '1.9.1')],
    ['@opentelemetry/api-logs', otel('api-logs', '0.220.0')],
    ['@opentelemetry/sdk-logs', otel('sdk-logs', '0.220.0')],
    ['@opentelemetry/core', otel('core', '2.10.0')],
    ['@opentelemetry/resources', otel('resources', '2.10.0')],
    ['@opentelemetry/exporter-logs-otlp-http', otel('exporter-logs-otlp-http', '0.220.0')],
    ['@opentelemetry/otlp-exporter-base', otel('otlp-exporter-base', '0.220.0')],
    ['@opentelemetry/otlp-transformer', otel('otlp-transformer', '0.220.0')],
    // The exporter's platform subpath (same extensionless-import reasoning).
    ['@opentelemetry/otlp-exporter-base/node-http', {
      inline: join(ROOT, 'runtime/spike/vendor/npm/@opentelemetry'
        + '/otlp-exporter-base@0.220.0/build/esm/index-node-http.js'),
    }],
    ['@opentelemetry/semantic-conventions', otel('semantic-conventions', '1.43.0')],
    ['@opentelemetry/sdk-metrics', otel('sdk-metrics', '2.9.0')],
    // skill-badge's single-file lib computes its resource base off its OWN
    // import.meta.url (new URL('../assets/', import.meta.url)); inlined, it
    // shares the spec's URL (/upstream-tests/<stem>.spec.mjs) and therefore
    // resolves /assets/ — exactly the path the spec asserts and the package-
    // asset seed delivers.
    ['@deepseek-ai/dsh-skill-badge', {
      inline: join(ROOT, 'runtime/spike/vendor/npm/@deepseek-ai/dsh-skill-badge@0.1.6-alpha.2/lib/index.js'),
    }],
    // W5-S (2026-09-28): the package face the three web spec families drive
    // (fetch-http, proxy, tool-web integration/spill). The specs spy
    // publicHttpNetwork on the copy their RELATIVE import inlines
    // ('../src/network.ts' — resolved inside the tests tree), while the
    // provider class loaded from the npm tarball face — two module instances,
    // so every vi.spyOn mock landed on a network object the provider never
    // reads (baseline: the address-policy check threw from the tarball face;
    // 43 failures across the four specs). Inlining the package SOURCE from
    // the tests tree collapses the pair: esbuild dedupes by resolved path,
    // so index.ts's './network.ts' import and the spec's '../src/network.ts'
    // become ONE module and the spy guards the provider's actual calls. The
    // submodule copy is byte-identical but resolves './network.ts' to a
    // DIFFERENT path — pointing the row there would keep two instances and
    // the fix dead. D6: verbatim bytes from the vendored tests closure, read
    // only. The limb's remaining bare imports stay loader-served: schemastery
    // via the C bare row, dsh-timeout/dsh-http-proxy via the vendored probe
    // (faces the adapter canary and the egress specs already prove).
    ['@deepseek-ai/dsh-web-fetch-http', {
      inline: join(TESTS, 'web/web-fetch-http/src/index.ts'),
    }],
  ]);

const SUBMODULE_BARE_RESOLVES = () => {
  const abs = (rel) => join(SUBMODULE_ROOT, rel);
  // W5-T (2026-09-28): the @opentelemetry faces the session-telemetry-otel
  // specs import — inlined from the vendored npm trees (D6-verbatim) instead
  // of loader-served, because OTel's build/esm output imports its own files
  // EXTENSIONLESS ('./LoggerProvider'), which the loader's relative
  // resolution cannot serve; esbuild's resolver handles that shape natively.
  // Their bare BUILTIN imports (http/fs/util/...) stay external — the
  // npm-bridges bare rows serve those.
  return SUBMODULE_BARE_ROWS;
  // A missing submodule target must keep its bare external (the loader then
  // fails loud naming the specifier) — never a silently half-mapped graph.
  for (const [spec, row] of rows) {
    if (row.inline && !existsSync(row.inline)) rows.delete(spec);
  }
  return rows;
};
const BARE_RESOLVES = SUBMODULE_BARE_RESOLVES();

const UNVENDORED_INLINED = [
  /^@earendil-works\/pi-ai(?:\/|$)/,
  /^@deepseek-ai\/dsh-credentials$/,
];

export const BARE_EXTERNAL_PLUGIN = {
  name: 'bare-external',
  setup(build) {
    build.onResolve({ filter: /^[.@a-zA-Z]/ }, (args) => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      if (args.importer.startsWith(SUBMODULE_ROOT)
          && UNVENDORED_INLINED.some((re) => re.test(args.path))) {
        return { path: `${args.path}.cjs`, namespace: 'unvendored-stub' };
      }
      const resolveRow = BARE_RESOLVES.get(args.path);
      if (resolveRow) {
        if (resolveRow.externalSubpath !== undefined) {
          return { path: `${args.path}/${resolveRow.externalSubpath}`, external: true };
        }
        return { path: resolveRow.inline }; // absolute: esbuild loads + inlines
      }
      // src/ hoist rows also resolve NESTED importers (a vendored package's
      // inlined src limb imports the same monorepo specifier its spec does):
      // returning the submodule file inlines it, so the bare specifier never
      // survives to the bundled-output scan. The spec-source rewrite (above)
      // hits the same absolute path, so esbuild keeps ONE instance.
      const srcRow = SUBMODULE_SRC_HOISTS.get(args.path);
      if (srcRow !== undefined && existsSync(join(SUBMODULE_ROOT, srcRow))) {
        return { path: join(SUBMODULE_ROOT, srcRow) };
      }
      return { path: args.path, external: true };
    });
    build.onLoad({ filter: /.*/, namespace: 'unvendored-stub' }, unvendoredStubLoad);
    // INLINED LIMBS carry their own createRequire(import.meta.url)('<x>.json')
    // package-manifest reads (session-telemetry-otel's src/index.ts reads its
    // version) — the spec-source rewrite above never sees them. For limb
    // files under the tests tree, rewrite the reads to real JSON imports:
    // esbuild bundles JSON natively, and the limb's resolveDir keeps the
    // relative path pointed at the now-staged package.json (W5-T).
    build.onLoad({ filter: /\.(ts|mts|js|mjs)$/ }, limbJsonLoad);
    // The decorator lowering for BUNDLED HELPER files (W8): local test
    // helpers the spec imports carry the same @Remote shapes as the specs,
    // and esbuild bundles them from disk after the spec-source rewrite —
    // without this hook the built output re-trips the decorators exclusion
    // scan (the 'bundled helper: decorators' family, 35 specs). Registered
    // AFTER limbJsonLoad so esbuild consults it first; returning undefined
    // for decorator-free sources falls the file through to the JSON hoist
    // untouched.
    build.onLoad({ filter: /\.(ts|mts|tsx)$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      const lowered = lowerDecorators(source);
      if (lowered === source) return undefined;
      return { contents: lowered, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
    });
  },
};

export const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
};


/** `createRequire(import.meta.url)('../package.json')` reads the SPEC'S OWN
 * PACKAGE manifest — a monorepo-layout fact our corpus does not have (the
 * staged spec's parent directory is upstream-tests/, and the tests codeload
 * tarball ships no package.json at all). The manifest DOES exist in the
 * vendored npm tree for the same version, so each such read is rewritten to
 * a bundled JSON import resolved against: (a) the tests tree, then (b) the
 * vendored package (both directory families). esbuild inlines it verbatim,
 * preserving the attribution checks exactly. */
const hoistCreateRequireJson = (source, rel) => {
  // Both quote spellings occur across the corpus (egress.spec.ts uses double
  // quotes, other packages single) — the backreference keeps them honest.
  const re = /createRequire\(import\.meta\.url\)\(([\x27\x22])([^\x27\x22]+\.json)\1\)/g;
  const specDir = dirname(join(TESTS, rel));
  const pkgName = rel.split('/')[1];
  const vendorCandidates = [
    join(ROOT, `runtime/spike/vendor/dsh/${pkgName}@0.1.6-alpha.2`),
    join(ROOT, `runtime/spike/vendor/dsh/dsh-${pkgName}@0.1.6-alpha.2`),
  ];
  const imports = [];
  const rewritten = source.replace(re, (_m, _q, rawPath) => {
    const direct = join(specDir, rawPath);
    let resolved = existsSync(direct) ? direct : null;
    if (resolved === null) {
      // '../package.json' (or deeper) resolves inside the package root the
      // vendored tarball carries.
      const inPkg = relative(specDir, join(specDir, rawPath)).replace(/^\.\.\//, '');
      resolved = vendorCandidates
        .map((dir) => join(dir, inPkg))
        .find((full) => existsSync(full)) ?? null;
    }
    if (resolved === null) return _m; // unresolved: esbuild will fail loud
    const name = `__dsh_pkg_json_${imports.length}`;
    imports.push(`import ${name} from ${JSON.stringify(resolved)};`);
    return name;
  });
  if (imports.length === 0) return source;
  return `${imports.join('\n')}\n${rewritten}`;
};

/** Monorepo src/ subpaths a spec needs at RUNTIME for symbols no vendored
 * tarball carries. '@deepseek-ai/dsh-llm-pi-ai/src/context.ts' (toPiContext —
 * the system-prompt-admission spec's admission oracle) is a deliberate
 * TS-source export of the upstream package, but the npm tarball this closure
 * vendors ships a SINGLE-FILE lib/index.js bundle whose export list (Config,
 * PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols) omits
 * it — no bare rewrite can reach the symbol, and the loader's probe families
 * cannot serve the tarball's shapes for a src/ subpath. The rewrite points
 * the import at the PINNED SUBMODULE's source (D6: verbatim upstream, never
 * a modified copy) so esbuild inlines the limb exactly like a local fixture;
 * the two packages that limb's dead schemas reach but the closure does not
 * vendor become throwing stubs (see UNVENDORED_INLINED). A missing hoist
 * target leaves the specifier untouched, so the generic monorepo-src
 * exclusion still names it — fail loud, never a silent drop (rule 5). */
export const SUBMODULE_SRC_HOISTS = new Map([
  ['@deepseek-ai/dsh-llm-pi-ai/src/context.ts', 'packages/llm/llm-pi-ai/src/context.ts'],
  // subprocess-local src/ faces the lsp-stdio and process-inspector specs
  // drive directly (spawnSubprocess / the inspector classes). The tarball
  // ships only the bundled lib/ face; these files exist verbatim in the
  // pinned submodule, whose relative imports esbuild inlines while the bare
  // deps (dsh-subprocess, dsh-timeout, dsh-lazy-require) stay loader-served.
  ['@deepseek-ai/dsh-subprocess-local/src/spawn.ts', 'packages/subprocess/subprocess-local/src/spawn.ts'],
  ['@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts', 'packages/subprocess/subprocess-local/src/process-inspector.ts'],
  ['@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts', 'packages/subprocess/subprocess-local/src/windows-inspector.ts'],
  // lsp-stdio's specs import connection.ts / instance.ts TYPE-ONLY (esbuild
  // erases them), but the monorepo-src exclusion regex reads the SOURCE —
  // hoisting the specifier past the scan lets the erased-at-build reality
  // hold, instead of a named exclusion for an import that never loads.
  ['@deepseek-ai/dsh-lsp-stdio/src/connection.ts', 'packages/lsp/lsp-stdio/src/connection.ts'],
  ['@deepseek-ai/dsh-lsp-stdio/src/instance.ts', 'packages/lsp/lsp-stdio/src/instance.ts'],
  // webworker-runtime src/ faces whose transitive closure stays inside the
  // loader's surface (its externals are shimmed node: builtins or vendored
  // dsh packages). Deliberately NARROW: the other src/-importing specs pull
  // unvendored npm packages through their limbs (buffer / readable-stream /
  // @noble/hashes / @yarnpkg/parsers / picomatch) and keep their named
  // monorepo-src exclusion instead of trading it for an on-device load
  // failure. Each row below was checked to close over served externals only:
  // path-diff → node:path; als-shim → node:async_hooks; tunnel-client →
  // dsh-host-webserver (vendored).
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/client/client.ts', 'packages/experimental/webworker-runtime/src/client/client.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/path.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/path.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/globals/timers.ts', 'packages/experimental/webworker-runtime/src/node/globals/timers.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/polyfill/async-context/async-context-hooks.ts', 'packages/experimental/webworker-runtime/src/polyfill/async-context/async-context-hooks.ts'],
  // Wave-3 batch (2026-09-27, worker L): the monorepo-src specs whose src
  // limbs close over SERVED externals only — every bare import below is a
  // vendored vendor/dsh/ tarball, a shimmed node: builtin, a bare-map npm pin
  // (zod@4.4.3), or a registered runtime-module/npm-bridge face
  // (@modelcontextprotocol/client + /stdio — npm-bridges rows). Each row was
  // checked limb-by-limb (the files' import lines): pure config/sanitize/
  // render/projection units, no unvendored npm package reachable.
  ['@deepseek-ai/dsh-tools/src/py-types.ts', 'packages/core/tools/src/py-types.ts'],
  ['@deepseek-ai/dsh-tools/src/ts-types.ts', 'packages/core/tools/src/ts-types.ts'],
  ['@deepseek-ai/dsh-tools/src/json-schema.ts', 'packages/core/tools/src/json-schema.ts'],
  ['@deepseek-ai/dsh-hooks-claude-code/src/config.ts', 'packages/hooks/hooks-claude-code/src/config.ts'],
  ['@deepseek-ai/dsh-hooks-codex/src/config.ts', 'packages/hooks/hooks-codex/src/config.ts'],
  ['@deepseek-ai/dsh-mcp-client/src/transport.ts', 'packages/mcp/mcp-client/src/transport.ts'],
  ['@deepseek-ai/dsh-mcp-client/src/tools.ts', 'packages/mcp/mcp-client/src/tools.ts'],
  ['@deepseek-ai/dsh-session-stats/src/projection.ts', 'packages/session/session-stats/src/projection.ts'],
  ['@deepseek-ai/dsh-session-turn-outline/src/projection.ts', 'packages/session/session-turn-outline/src/projection.ts'],
  ['@deepseek-ai/dsh-terminal-bash/src/config.ts', 'packages/terminal/terminal-bash/src/config.ts'],
  ['@deepseek-ai/dsh-terminal-bash/src/sanitize.ts', 'packages/terminal/terminal-bash/src/sanitize.ts'],
  ['@deepseek-ai/dsh-tool-terminal/src/render.ts', 'packages/terminal/tool-terminal/src/render.ts'],
  ['@deepseek-ai/dsh-compaction-basic/src/config.ts', 'packages/compaction/compaction-basic/src/config.ts'],
  ['@deepseek-ai/dsh-compaction-basic/src/summarizer.ts', 'packages/compaction/compaction-basic/src/summarizer.ts'],
  ['@deepseek-ai/dsh-compaction-basic/src/region.ts', 'packages/compaction/compaction-basic/src/region.ts'],
  ['@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts', 'packages/session/session-persistence-jsonl/src/format.ts'],

  // Wave-4 batch (2026-09-28, worker P): the webworker-runtime specs that
  // name src/ files BARELY (or transitively inline limbs that do). Every
  // bare import in this package's src tree is served: node:* shims, buffer
  // (bridge row), acorn + @noble/hashes + @deepseek-ai/dsh-util-crypto
  // (vendored/bridged), and the new readable-stream / picomatch /
  // @yarnpkg/parsers bridge rows — checked by census over src/{node,shell,
  // storage,module-system,compile,polyfill}. Relative imports inline.
    ['@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts', 'packages/experimental/webworker-runtime/src/storage/memory.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/active.ts', 'packages/experimental/webworker-runtime/src/storage/active.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/types.ts', 'packages/experimental/webworker-runtime/src/storage/types.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/paths.ts', 'packages/experimental/webworker-runtime/src/storage/paths.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/tar.ts', 'packages/experimental/webworker-runtime/src/storage/tar.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/image-layout.ts', 'packages/experimental/webworker-runtime/src/image-layout.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/posix-path.ts', 'packages/experimental/webworker-runtime/src/module-system/posix-path.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts', 'packages/experimental/webworker-runtime/src/module-system/module-loader.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/compile/transform.ts', 'packages/experimental/webworker-runtime/src/compile/transform.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtins.ts', 'packages/experimental/webworker-runtime/src/node/builtins.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/notImplementedFail.ts', 'packages/experimental/webworker-runtime/src/node/notImplementedFail.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/process-table.ts', 'packages/experimental/webworker-runtime/src/node/process-table.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/globals/process.ts', 'packages/experimental/webworker-runtime/src/node/globals/process.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/interpret.ts', 'packages/experimental/webworker-runtime/src/shell/interpret.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/types.ts', 'packages/experimental/webworker-runtime/src/shell/types.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/ast.ts', 'packages/experimental/webworker-runtime/src/shell/ast.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/expand.ts', 'packages/experimental/webworker-runtime/src/shell/expand.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/fs-access.ts', 'packages/experimental/webworker-runtime/src/shell/fs-access.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/programs/index.ts', 'packages/experimental/webworker-runtime/src/shell/programs/index.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/programs/builtins.ts', 'packages/experimental/webworker-runtime/src/shell/programs/builtins.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/programs/files.ts', 'packages/experimental/webworker-runtime/src/shell/programs/files.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/programs/text.ts', 'packages/experimental/webworker-runtime/src/shell/programs/text.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/programs/options.ts', 'packages/experimental/webworker-runtime/src/shell/programs/options.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/child.ts', 'packages/experimental/webworker-runtime/src/shell/process/child.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/host.ts', 'packages/experimental/webworker-runtime/src/shell/process/host.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/protocol.ts', 'packages/experimental/webworker-runtime/src/shell/process/protocol.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/landlock.ts', 'packages/experimental/webworker-runtime/src/shell/process/landlock.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/virtual-executables.ts', 'packages/experimental/webworker-runtime/src/shell/process/virtual-executables.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/child_process.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/child_process.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/fs.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/fs/promises.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs/promises.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/util.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/util.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/crypto.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/crypto.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/stream.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/stream.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/events.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/events.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/abort-error.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/abort-error.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/buffer.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/buffer.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/fs-watch.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs-watch.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/http.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/http.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/module.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/module.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/os.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/os.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/perf_hooks.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/perf_hooks.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/tty.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/tty.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/url.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/url.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/zlib.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/zlib.ts'],
]);

export const hoistSubmoduleSrcSubpaths = (source) => {
  let out = lowerDecorators(source);
  for (const [specifier, rel] of SUBMODULE_SRC_HOISTS) {
    const target = join(SUBMODULE_ROOT, rel);
    if (!existsSync(target)) continue;
    out = out.replaceAll(`'${specifier}'`, JSON.stringify(target))
      .replaceAll(`"${specifier}"`, JSON.stringify(target));
  }
  return out;
};


/** Collect the layout-tree family's files for one spec (module level for
 * size): the WHOLE vendored source tree at /upstream-tests/src (verbatim
 * submodule bytes — the spec re-audits the real upstream sources), the
 * named compiler manifests, and (mirrorTests) the vendored tests/*.ts so
 * the spec's own-directory walk sees the same tree shape upstream's tests/
 * layout gives it. */
const collectSeedTreeFiles = (rel, files, mirrorTests) => {
  const seedTree = SEED_TREE_SPECS.get(rel);
  if (seedTree === undefined) return;
  const pkgRoot = join(SUBMODULE_ROOT, 'packages', seedTree.package);
  const pushFile = (full, path) => {
    files.push({ path, b64: readFileSync(full).toString('base64') });
  };
  const treeDir = join(pkgRoot, seedTree.tree);
  if (existsSync(treeDir)) {
    const walkTree = (dir, base) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkTree(full, `${base}/${name}`);
        else pushFile(full, `/upstream-tests/${seedTree.tree}${base}/${name}`);
      }
    };
    walkTree(treeDir, '');
  }
  for (const name of seedTree.files) {
    const full = join(pkgRoot, name);
    if (existsSync(full)) pushFile(full, `/upstream-tests/${name}`);
  }
  if (mirrorTests) {
    const testsDir = join(TESTS, dirname(rel));
    for (const name of readdirSync(testsDir)) {
      if (!name.endsWith('.ts')) continue;
      pushFile(join(testsDir, name), `/upstream-tests/${name}`);
    }
  }
};

// The TC39 method-decorator lowering (W8) and the bundle-manifest /
// seed-tree families live in transpile-decorators.mjs (this file crossed
// the code-size gate). THIS module still calls lowerDecorators (the
// bundled-helper onLoad in BARE_EXTERNAL_PLUGIN, hoistSubmoduleSrcSubpaths)
// and SEED_TREE_SPECS (collectSeedTreeFiles), so those two are imported
// plainly; every moved name is re-exported for the existing importers —
// transpile.mjs keeps importing them all from here.

import { lowerDecorators, SEED_TREE_SPECS } from './transpile-decorators.mjs';
export { DECORATOR_LINE, DECORATED_MEMBER, CLASS_OPEN, CLASS_ONE_LINER, DSH_DECORATE_HELPER, lineBraceDelta, lowerDecorators, BUNDLE_MANIFEST_PACKAGES, BUNDLE_MANIFEST_FILES, rewriteBundleManifestRoot, SEED_TREE_SPECS, rewriteSeedTreeRoots } from './transpile-decorators.mjs';

export { SUBMODULE_BARE_RESOLVES, hoistCreateRequireJson, collectSeedTreeFiles };
