// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * upstream-suite-flatmap — the W6-V flat-path map of the upstream suite
 * leg, extracted from upstream-suite-leg.js at the code-size gate (the
 * tables + installer crossed the 50-line function cap inline there).
 * ONE-WAY dependency: this module imports nothing at all — the leg
 * imports installFlatPathMap from here, never the reverse (a static
 * import cycle between closure files kills QuickJS at link).
 */

/** Install the flat-path map (W6-V): the transpiled specs' bundle-relative
 * joins (/vendor/..., /upstream-tests/...) are REAL directories of the
 * desktop checkout — the fs faces' real-disk fallbacks re-root through this
 * map so reads/stats of vendored assets answer from the pinned tree (D6: the
 * same read-only bytes the loader serves). Relative re-rootings resolve
 * against the CLI's real working directory, exactly like the sibling
 * staging's /bin/cp. Undefined for paths with no real-world twin. */
// The webworker-runtime node/chokidar spec's per-consumer package trees
// (W7-X1): the spec resolves REAL chokidar/readdirp bytes through
// createRequire(<consumer manifest>).resolve() — the node:module shim's
// node_modules ancestor walk over the staged view — then mounts the files
// into its own Worker-loader VFS. Upstream's lockfile pins DIFFERENT
// majors per consumer (settings-file/credentials → chokidar 4.0.3 +
// readdirp 4.1.2; skill-filesystem → chokidar 5.0.0 + readdirp 5.0.0), so
// the per-consumer node_modules nesting is what makes both fixtures
// resolve their own version; one shared <cwd>/node_modules cannot. The
// vendored registry trees answer through this map (read-only re-rooting —
// D6: the same pinned bytes, staged not copied). Module level for size
// (static data; extracted from installFlatPathMap with the function).
const watchTrees = [
  ['/packages/settings/settings-file/node_modules/chokidar/', 'vendor/npm/chokidar@4.0.3/'],
  ['/packages/settings/settings-file/node_modules/readdirp/', 'vendor/npm/readdirp@4.1.2/'],
  ['/packages/skill/skill-filesystem/node_modules/chokidar/', 'vendor/npm/chokidar@5.0.0/'],
  ['/packages/skill/skill-filesystem/node_modules/readdirp/', 'vendor/npm/readdirp@5.0.0/'],
];
// W8 (2026-09-29), the sdk-launch / subagent-dsh-sdk launch-resolution
// family: `import.meta.resolve("@deepseek-ai/dsh/package.json")` answers
// with the SPECIFIER VERBATIM (the product package is outside both
// vendored staging families, so the bare map declines it and the loader's
// legacy bundle-relative arm passes it through), and the spec reads the
// manifest + launch files through THAT spelling — `@deepseek-ai/dsh/...`
// raw (the resolve answer) and `/tmp/<run>/@deepseek-ai/dsh/...`
// (path.resolve joins it against the run cwd). The pinned submodule
// carries the VERBATIM product tree (apps/cli: manifest, built lib/bin.js,
// src/bin.ts + sdk-source.cordis.patch.yml + tsconfig.json — the complete
// source-launch set the spec requires), so the map re-roots both
// spellings at it (D6: read-only re-rooting, bytes untouched). The re-root
// target is relative to the CLI's REAL working directory — the spike root
// (runtime/dsh, where vendor/ lives; every real-disk staging arm
// resolves there) — hence the ../../ prefix into the checkout.
const reRoots = [
  ['@deepseek-ai/dsh/', '../../third-party/deepseek-harness/apps/cli/'],
  ['/@deepseek-ai/dsh/', '../../third-party/deepseek-harness/apps/cli/'],
  ['/package.json', 'vendor/npm/@deepseek-ai/dsh-sdk-client@0.1.6-alpha.2/package.json'],
];

export const installFlatPathMap = () => {
  // W8 (2026-09-29): the spec joins its consumer manifest against
  // process.cwd() — the RUN's workspace root (/tmp/dsh-spike-smoke.*) — so
  // the ancestor walk produces WORKSPACE-ABSOLUTE spellings
  // (<root>/packages/.../node_modules/...) the bare watchTrees rows above
  // never match ("cannot resolve 'chokidar' from /tmp/.../settings-file/
  // package.json"). The workspace root is pinned by pinProfileContainer
  // BEFORE the spec loads, so the map strips it (and the tmpdir root)
  // before the prefix match; unprefixed spellings still hit directly.
  // Computed at CALL time on purpose: the leg installs the map after
  // pinProfileContainer has pinned the globals — module-eval time is
  // too early.
  const roots = [globalThis.__dshProfileCwd, globalThis.__dshProfileTmpdir]
    .filter((root) => typeof root === 'string' && root.length > 0)
    .map((root) => `${root.replace(/\/$/, '')}/`);
  const mapAll = (candidate) => {
    for (const [staged, real] of reRoots) {
      if (staged.endsWith('/') ? candidate.startsWith(staged) : candidate === staged) {
        return `${real}${candidate.slice(staged.length)}`;
      }
    }
    for (const [staged, real] of watchTrees) {
      if (candidate.startsWith(staged)) return `${real}${candidate.slice(staged.length)}`;
    }
    return undefined;
  };
  globalThis.__dshFlatPathMap = (path) => {
    if (typeof path !== 'string') return undefined;
    if (path.startsWith('/vendor/') || path.startsWith('/upstream-tests/')) {
      return path.slice(1);
    }
    const direct = mapAll(path);
    if (direct !== undefined) return direct;
    for (const root of roots) {
      if (root !== '/' && path.startsWith(root)) {
        const inner = path.slice(root.length - 1); // keep the leading '/'
        const mapped = mapAll(inner);
        if (mapped !== undefined) return mapped;
      }
    }
    return undefined;
  };
};
