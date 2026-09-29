// dsh:logging-exempt (shim layer: no transport, no I/O of its own)
/**
 * source-bootstrap-tsx.js — the tsx (TypeScript registration) face for
 * SOURCE-ENTRY bootstraps, W8 source-entry-bootstrap class.
 *
 * Upstream's source-mode launches hand `node --import <tsx> <srcBin.ts>` to
 * a REAL child (runLoaderSmoke, the subprocess-local host scripts, the
 * corpus runners) and the source-closure Workers build a data: bootstrap
 * around `import.meta.resolve('tsx/esm/api')`. Under the spike, three
 * seams had to meet for those launches to exist at all:
 *
 *   1. RESOLUTION — the C import.meta.resolve throws for the bare name
 *      'tsx' (no dot/slash → unmapped). This module resolves the REAL tsx
 *      install instead (test/upstream-suite/node_modules — the node
 *      differential's own devDependency tree, pinned 4.23.15 whose layout
 *      matches upstream's '/tsx/dist/esm/index.mjs' shape), falling back to
 *      a minimal registration stub under the profile tmpdir for hosts
 *      without the install. The returned path is a REAL absolute file so
 *      the child loads it directly (the C argv remap only rewrites paths
 *      that do not exist yet).
 *   2. SOURCE BYTES — the staged fixtures/entries (/upstream-tests/**)
 *      live in the seeded VFS view; a REAL child reads the REAL disk. The
 *      argv remap re-roots '/x' to '<bundle>/x' WHEN THOSE BYTES EXIST
 *      there, so materializeChildArgv stages the seeded bytes (or a
 *      vendored-tree origin) to the remap target before the spawn — the
 *      same verbatim staging the suite leg's sibling/fixtures staging does
 *      (D6: staged, never edited).
 *   3. IN-REalm REGISTER — the Worker data: bootstraps import
 *      `{ register }` from the resolved tsx face and call it before
 *      importing their TypeScript entry. The runtime-modules rows serve
 *      this module as 'tsx' / 'tsx/esm' / 'tsx/esm/api'; register() here is
 *      the honest no-op (this realm has no TS eraser — source entries that
 *      need one say so loudly at import, they do not silently mis-parse).
 */

import { readFileSync } from 'upstream/shims/fs.js';
import { encodeUtf8 } from 'upstream/shims/buffer.js';

/** bytes → base64 over the host's latin-1 intrinsic, chunked like the
 * child_process shim's encoder (big fixtures stay off the call stack). */
const bytesToB64 = (bytes) => {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};
const toB64 = (data) => (typeof data === 'string' ? bytesToB64(encodeUtf8(data)) : bytesToB64(data));

/** The real tsx install this spike pairs with: the node differential's
 * dependency tree one level above the runtime bundle (<repo>/test/…).
 * Discovered lazily (a /bin/pwd child) and memoized — the overlay's first
 * src-mode launch pays one child spawn, every later call reuses it. */
let installCache;
const discoverInstall = () => {
  if (installCache !== undefined) return installCache;
  installCache = null;
  try {
    const { spawnSync } = globalThis.__dshChildProcessNs ?? {};
    if (typeof spawnSync !== 'function') return installCache;
    const pwd = spawnSync('/bin/pwd', [], { encoding: 'utf8' });
    if (pwd.status !== 0 || typeof pwd.stdout !== 'string') return installCache;
    const spikeDir = pwd.stdout.replace(/\n+$/, '');
    const tail = '/runtime/spike';
    if (!spikeDir.endsWith(tail)) return installCache;
    const repo = spikeDir.slice(0, -tail.length);
    const root = `${repo}/test/upstream-suite/node_modules/tsx`;
    // The package.json read is the existence check (readRealBytes serves
    // real absolute paths; a missing install answers null).
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
    } catch {
      return installCache;
    }
    const entryOf = (key) => {
      let face = manifest.exports?.[key];
      if (face === undefined) return undefined;
      // Conditional-map shapes: take the import/default chain's tail.
      while (face !== null && typeof face === 'object') {
        face = face.import?.default ?? face.default ?? face.node?.import?.default ?? face.node?.default;
      }
      if (typeof face !== 'string') return undefined;
      return `${root}/${face.replace(/^\.\//, '')}`;
    };
    const faces = {
      tsx: entryOf('.'),
      'tsx/esm': entryOf('./esm'),
      'tsx/esm/api': entryOf('./esm/api'),
    };
    if (typeof faces.tsx !== 'string' || typeof faces['tsx/esm'] !== 'string') return installCache;
    installCache = { root, faces };
  } catch {
    installCache = null;
  }
  return installCache;
};

/** The no-install fallback: a minimal registration stub written under the
 * profile tmpdir (a real directory), spelled with the upstream layout so
 * the '/tsx/dist/esm/index.mjs' containment pin still holds. Node ≥ 23.6
 * strips erasable TypeScript natively, so plain fixtures run unregistered —
 * this stub exists so the launch SHAPE is servable on hosts without the
 * real install, not to reimplement tsx. */
let fallbackWritten = false;
const FALLBACK_STUB = [
  '// source-bootstrap tsx face (no real tsx install on this host):',
  '// this child runs Node >= 23.6 which strips erasable TypeScript',
  '// natively; the bootstrap registers nothing.',
  'export const register = () => {};',
  'export const registerHooks = () => {};',
  'export const transform = (code) => ({ code });',
  'export default { register, registerHooks, transform };',
  '',
].join('\n');

const spawnSyncNs = () => globalThis.__dshChildProcessNs ?? {};

const writeFallback = () => {
  if (fallbackWritten) return true;
  try {
    const { spawnSync } = spawnSyncNs();
    if (typeof spawnSync !== 'function') return false;
    const tmp = globalThis.__dshProfileTmpdir;
    if (typeof tmp !== 'string' || tmp === '') return false;
    const dir = `${tmp.replace(/\/$/, '')}/tsx/dist/esm`;
    spawnSync('/bin/mkdir', ['-p', dir]);
    const writer = spawnSync('/usr/bin/python3', [
      '-c',
      `import pathlib; pathlib.Path('${dir}/index.mjs').write_text(${JSON.stringify(FALLBACK_STUB)})`,
    ]);
    fallbackWritten = writer.status === 0;
    return fallbackWritten;
  } catch {
    return false;
  }
};

/** Real-file existence probe (module level for size): /bin/test -f over the
 * real disk, relative to the CLI's own working directory for bundle paths.
 * Returns true only when the REAL file exists — the question the child's
 * node would answer at open time. */
export const realFileExists = (path) => {
  try {
    const { spawnSync } = spawnSyncNs();
    if (typeof spawnSync !== 'function') return false;
    const rel = path.startsWith('/') ? path.slice(1) : path;
    return spawnSync('/bin/test', ['-f', rel]).status === 0;
  } catch {
    return false;
  }
};

/** Stage a REAL tsconfig for the child's TSX_TSCONFIG_PATH. The flat-staged
 * specs derive their tsconfigPath from import.meta.url joins that no real
 * file answers ('/tsconfig.json' et al), and real tsx throws at register
 * time when the path is missing (measured: the loader-smoke children died
 * inside tsx's own register.cjs). The staged config is compilerOptions-
 * minimal PLUS one paths row per vendored package (bare → its lib entry,
 * subpaths → their exports-map targets) so a child that imports the
 * workspace packages (the process-exit host script, the snapshot agent
 * bins) resolves them onto the pinned vendored builds (D6: the same
 * read-only bytes; the config is OUR layer's staging, like @types/node's
 * test-support stub). Memoized per run; undefined when the profile tmpdir
 * is unavailable (device hosts keep the spec's own spelling). */
let realRoot;
let stagedTsConfig;
export const stageChildTsConfig = () => {
  if (stagedTsConfig !== undefined) return stagedTsConfig;
  stagedTsConfig = null;
  try {
    const { spawnSync } = spawnSyncNs();
    if (typeof spawnSync !== 'function') return stagedTsConfig;
    const tmp = globalThis.__dshProfileTmpdir;
    if (typeof tmp !== 'string' || tmp === '') return stagedTsConfig;
    realRoot ??= stagedRealRoot();
    if (realRoot === undefined) return stagedTsConfig;
    const paths = vendoredPathsMap();
    const dir = `${tmp.replace(/\/$/, '')}/source-bootstrap`;
    spawnSync('/bin/mkdir', ['-p', dir]);
    const config = JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        erasableSyntaxOnly: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        verbatimModuleSyntax: false,
        paths,
      },
    });
    const writer = spawnSync('/usr/bin/python3', [
      '-c',
      `import pathlib; pathlib.Path('${dir}/tsconfig.json').write_text(${JSON.stringify(config)})`,
    ]);
    if (writer.status !== 0) return stagedTsConfig;
    stagedTsConfig = `${dir}/tsconfig.json`;
  } catch {
    stagedTsConfig = null;
  }
  return stagedTsConfig;
};

let pathsMapCache;
/** One paths row per vendored package surface: bare name → lib entry,
 * exports-map subpaths → their lib targets. Absolute targets (the
 * child's resolver uses them as-is). Scans the staging families once;
 * the dsh-scoped aliases (cordis/cosmokit live unscoped in the vendor
 * tree, the closure imports them scoped) get both spellings. */
const vendoredPathsMap = () => {
  if (pathsMapCache !== undefined) return pathsMapCache;
  const paths = {};
  realRoot ??= stagedRealRoot();
  try {
    const { spawnSync } = spawnSyncNs();
    if (typeof spawnSync === 'function' && realRoot !== undefined) {
      const found = spawnSync('/usr/bin/find', [
        'vendor/npm/@deepseek-ai', 'vendor/npm/cordis@4.0.2', 'vendor/npm/cosmokit@1.8.3',
        'vendor/npm/zod@4.4.3',
        '-maxdepth', '1', '-mindepth', '1', '-type', 'd',
      ], { encoding: 'utf8', timeout: 20000 });
      if (found.status === 0 && typeof found.stdout === 'string') {
        for (const relLine of found.stdout.split('\n')) {
          if (relLine.length === 0) continue;
          const line = `${realRoot}/${relLine}`;
          const dirName = relLine.slice(relLine.lastIndexOf('/') + 1);
          const at = dirName.lastIndexOf('@');
          if (at <= 0) continue;
          const stem = dirName.slice(0, at);
          const names = relLine.startsWith('vendor/npm/@deepseek-ai/')
            ? [`@deepseek-ai/${stem}`]
            : [stem, `@deepseek-ai/${stem}`];
          const manifest = readManifestSafe(`${line}/package.json`);
          if (manifest === null) continue;
          const libDir = typeof manifest.main === 'string' && manifest.main !== ''
            ? manifest.main.replace(/\/[^/]*$/, '')
            : 'lib';
          const bareTarget = `${line}/${libDir}/index.js`;
          if (!realFileExists(bareTarget)) continue;
          for (const name of names) paths[name] = [bareTarget];
          const exportsMap = manifest.exports ?? {};
          for (const [sub, target] of Object.entries(exportsMap)) {
            if (sub === '.') continue;
            let face = target;
            while (face !== null && typeof face === 'object') {
              face = face.import?.default ?? face.default ?? face.require?.default;
            }
            if (typeof face !== 'string' || !face.startsWith('./')) continue;
            const abs = `${line}/${face.replace(/^\.\//, '')}`;
            if (!realFileExists(abs)) continue;
            for (const name of names) paths[`${name}${sub}`] = [abs];
          }
        }
      }
    }
  } catch {
    // An empty map still gives the child a parsable config.
  }
  pathsMapCache = paths;
  return paths;
};

const readManifestSafe = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const fallbackFace = (kind) => {
  if (!writeFallback()) return undefined;
  const base = `${globalThis.__dshProfileTmpdir.replace(/\/$/, '')}/tsx/dist/esm/index.mjs`;
  return base; // one stub serves every kind: registration is a no-op here
};

/** The child-launch face path for 'tsx' | 'tsx/esm' | 'tsx/esm/api' — the
 * overlay's resolveExampleLaunch answer (see the header: resolution, not
 * the C resolve). Undefined means "no face could be staged" and the caller
 * fails loud naming the kind, like the unmapped-specifier error it
 * replaces. */
export const resolveTsxChildFace = (kind) => {
  const install = discoverInstall();
  if (install !== null) {
    const face = install.faces[kind];
    if (typeof face === 'string') return face;
  }
  return fallbackFace(kind);
};

/** Stage the seeded/staged bytes of one bundle-absolute path onto the REAL
 * disk at the argv remap's target ('/x' → '<bundle>/x'), so a REAL child
 * spawning that path finds bytes. Reads go through the staged view FIRST
 * (the fixtures seeding), then the vendored tests tree by relative suffix.
 * Returns the real path on success, undefined when no bytes exist — the
 * caller keeps the launch shape either way (the child's ENOENT then names
 * the true gap). */
const stagedRealRoot = () => {
  try {
    const { spawnSync } = globalThis.__dshChildProcessNs ?? {};
    if (typeof spawnSync !== 'function') return undefined;
    const pwd = spawnSync('/bin/pwd', [], { encoding: 'utf8' });
    if (pwd.status !== 0 || typeof pwd.stdout !== 'string') return undefined;
    const dir = pwd.stdout.replace(/\n+$/, '');
    return dir.endsWith('/') ? dir.slice(0, -1) : dir;
  } catch {
    return undefined;
  }
};

/** Mark a staged dir ESM for the child's module-type decision: real tsx
 * picks the output format from the nearest package.json `type`, and the
 * staged /upstream-tests tree has none — so .ts entries transpile to CJS
 * and their top-level await explodes (measured: the process-exit host
 * script died in esbuild with 'Top-level await is currently not supported
 * with the "cjs" output format'). The vendored sources are ESM by
 * construction; the staged manifest is OUR layer's staging. */
const typeModuleDirs = new Set();
const stageTypeModule = (relDir) => {
  if (typeModuleDirs.has(relDir) || relDir.length === 0) return;
  try {
    const { spawnSync } = spawnSyncNs();
    if (typeof spawnSync !== 'function') return;
    spawnSync('/bin/mkdir', ['-p', relDir]);
    const writer = spawnSync('/usr/bin/python3', [
      '-c',
      `import json, pathlib; pathlib.Path('${relDir}/package.json').write_text(json.dumps({'type': 'module'}))`,
    ]);
    if (writer?.status === 0) typeModuleDirs.add(relDir);
  } catch { /* best-effort */ }
};

/** Stage the VENDORED ORIGIN DIR of one staged entry (the fixtures/ tree a
 * spawned script's siblings live in — a child script derives its sibling
 * paths from ITS OWN import.meta.url, so staging only the launch arg is
 * not enough: the process-exit host script spawns './managed-tree.ts').
 * cp -R names the copy after the source basename, so the tree MERGES into
 * the existing staged dir (the same move the suite leg's
 * stageRealFixturesTree makes onto the run container — here onto the
 * bundle root, which is the argv remap's target). */
const stageOriginDir = (relArg, origin) => {
  const { spawnSync } = spawnSyncNs();
  if (typeof spawnSync !== 'function') return;
  const cut = origin.lastIndexOf('/');
  if (cut <= 0) return;
  const originDir = origin.slice(0, cut);
  const leaf = originDir.slice(originDir.lastIndexOf('/') + 1);
  const dstDir = relArg.slice(0, relArg.lastIndexOf('/'));
  // cp -R names the copy after the source basename: when the arg's own
  // dir already carries the origin dir's name ('…/fixtures/…' from
  // '…/tests/fixtures'), target the PARENT so the copied tree lands
  // exactly where the arg stands and MERGES into the staged dir —
  // targeting the dir itself would nest fixtures/fixtures beside the
  // entry the child derives (measured: the process-exit host script then
  // never finds its './managed-tree.ts' sibling and blocks its caller).
  const dst = leaf === dstDir.slice(dstDir.lastIndexOf('/') + 1)
    ? dstDir.slice(0, dstDir.lastIndexOf('/'))
    : dstDir;
  if (!(dst === 'upstream-tests' || dst.startsWith('upstream-tests/'))) return;
  const res = spawnSync('/bin/cp', ['-R', originDir, dst]);
  if (res?.status === 0) stageTypeModule(dst);
};

/** Vendored origin search for files no fixtures module seeded (the spawned
 * runner/worker shapes): one find over the two staging families, suffix-
 * matched so 'transform-corpus-check.ts' finds
 * '…/webworker-runtime/tests/compile/transform-corpus-check.ts'. Cached
 * per basename — the vendored tree is read-only for the whole run (D6). */
const originCache = new Map();
/** The running spec's package stem (host__directory-picker-native__… →
 * dsh-host-directory-picker-native@) — the provenance hint that separates
 * same-named build artifacts across vendored packages (three lib/worker.cjs
 * trees serve three different consumers). */
const specPackageHint = () => {
  try {
    const spec = JSON.parse(globalThis.__dshLaunchEnv?.() ?? '{}').DSH_UPSTREAM_SPEC ?? '';
    const stem = spec.replace(/^upstream-tests\//, '').replace(/\.spec\.mjs$/, '');
    const parts = stem.split('__');
    if (parts.length >= 3) return `dsh-${parts[0]}-${parts[1]}@`;
  } catch { /* no launch env (device hosts): no hint */ }
  return null;
};
const findVendoredOrigin = (basename) => {
  const cached = originCache.get(basename);
  if (cached !== undefined) return cached;
  let answer = null;
  try {
    const { spawnSync } = globalThis.__dshChildProcessNs ?? {};
    if (typeof spawnSync === 'function') {
      const found = spawnSync('/usr/bin/find', [
        'vendor/dsh-tests@dsh-v0.1.6-alpha.2/packages', 'vendor/npm',
        '-type', 'f', '-name', basename,
      ], { encoding: 'utf8', timeout: 20000 });
      if (found.status === 0 && typeof found.stdout === 'string') {
        const lines = found.stdout.split('\n').filter((line) => line.length > 0);
        // Provenance first (the running spec's own package), then the
        // tests/ tree (the flat /upstream-tests staging mirrors it), then
        // lib/ builds, then whatever matched.
        const hint = specPackageHint();
        answer = (hint !== null ? lines.find((line) => line.includes(hint)) : undefined)
          ?? lines.find((line) => line.includes('/tests/'))
          ?? lines.find((line) => line.includes('/lib/'))
          ?? lines[0]
          ?? null;
      }
    }
  } catch {
    answer = null;
  }
  originCache.set(basename, answer);
  return answer;
};

let realRootCache;
/** The W8 subprocess-family platform pin: the family's subject matter IS
 * the real OS process surface — its vendored process-inspector gates on
 * process.platform and the runtime's 'mobile' default refuses the POSIX
 * inspector the desktop legitimately has ('terminal inspection is
 * unsupported on platform mobile'). The suite leg's
 * stageShellSuitePlatform precedent pins the REAL host platform for this
 * shape of gate; the pin is SPEC-scoped (the launch env names the one
 * spec this process runs) and rides the first staging call, where the
 * child-process namespace exists — the leg preloads it only just before
 * the spec import, after this module's boot-time eval. */
let platformPinned = false;
let platformPinning = false;
const maybePinSubprocessPlatform = () => {
  if (platformPinned || platformPinning) return;
  try {
    if (globalThis.__dshProfilePlatform !== undefined) {
      platformPinned = true; // the leg owns this spec's platform already
      return;
    }
    const spec = JSON.parse(globalThis.__dshLaunchEnv?.() ?? '{}').DSH_UPSTREAM_SPEC ?? '';
    if (spec.length > 0 && !spec.includes('subprocess__subprocess-local')) {
      platformPinned = true; // not this family — the default stands
      return;
    }
    const { spawnSync } = spawnSyncNs();
    if (typeof spawnSync !== 'function') return; // namespace not preloaded YET — retry next spawn
    platformPinning = true; // the uname spawn re-enters this seam — do not recurse
    let platform;
    try {
      const res = spawnSync('/usr/bin/uname', ['-s']);
      platform = res.status === 0 && typeof res.stdout === 'string'
        ? { Darwin: 'darwin', Linux: 'linux' }[res.stdout.trim()]
        : undefined;
    } finally {
      platformPinning = false;
    }
    if (platform !== undefined) {
      globalThis.__dshProfilePlatform = platform;
      platformPinned = true;
    }
  } catch { /* the 'mobile' default stands when the real platform is unknown */ }
};
/** Sibling-tree staging memo (per staged dir): the vendored tests/fixtures
 * tree is copied ONCE per dir per run — including when the launch arg
 * itself is already materialized (the sibling pass is the point, and it
 * must not depend on the file's own freshness). */
const siblingStagedDirs = new Set();
/** Re-entrancy gate: the staging children themselves spawn through the
 * wrapped seam — nested calls are pass-throughs by definition. */
let stagingDepth = 0;
export const materializeChildArgv = (args) => {
  if (stagingDepth > 0) return [];
  stagingDepth += 1;
  try {
    return materializeChildArgvInner(args);
  } finally {
    stagingDepth -= 1;
  }
};
const materializeChildArgvInner = (args) => {
  const materialized = [];
  normalizeKillFace(); // lazy: globalThis.process exists only after globals.js finishes
  maybePinSubprocessPlatform();
  for (const arg of args) {
    if (typeof arg !== 'string' || !(arg.startsWith('/upstream-tests/') || arg.startsWith('/src/'))) continue;
    if (realRootCache === undefined) realRootCache = stagedRealRoot();
    const root = realRootCache;
    if (root === undefined) continue;
    const rel = arg.slice(1); // bundle-relative spelling under the CLI cwd
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    try {
      const probe = spawnSyncNs().spawnSync?.('/bin/test', ['-f', rel]);
      if (probe?.status !== 0) {
        let bytes;
        try {
          bytes = readFileSync(arg); // the staged/seeded view first
        } catch {
          bytes = undefined;
        }
        let writer;
        const { spawnSync } = spawnSyncNs();
        if (typeof spawnSync !== 'function') continue;
        spawnSync('/bin/mkdir', ['-p', dir]);
        if (bytes !== undefined && bytes !== null) {
          const b64 = toB64(bytes);
          writer = spawnSync('/usr/bin/python3', [
            '-c',
            `import base64, pathlib; pathlib.Path('${rel}').write_bytes(base64.b64decode('${b64}'))`,
          ]);
        } else {
          // No seeded bytes: copy the vendored origin verbatim (D6 staging).
          const origin = findVendoredOrigin(rel.slice(rel.lastIndexOf('/') + 1));
          if (origin === null) continue;
          writer = spawnSync('/bin/cp', [origin, rel]);
        }
        if (writer?.status === 0) materialized.push(`${root}/${rel}`);
      }
      // The sibling tree (spawned scripts derive sibling paths from their
      // OWN import.meta.url — the host scripts spawn './managed-tree.ts'),
      // staged once per dir regardless of the arg's own freshness.
      if (rel.startsWith('upstream-tests/') && rel.includes('/fixtures/') && !siblingStagedDirs.has(dir)) {
        siblingStagedDirs.add(dir);
        const origin = findVendoredOrigin(rel.slice(rel.lastIndexOf('/') + 1));
        if (origin !== null) {
          stageOriginDir(rel, origin);
          stageTypeModule(dir);
        }
      } else if (rel.startsWith('upstream-tests/')) {
        stageTypeModule(dir);
      }
    } catch {
      // Staging is best-effort: the launch shape is the contract, the
      // child's own ENOENT names a gap this host could not stage.
    }
  }
  return materialized;
};

/** Normalize the process.kill error face: node's kill(2) failures throw
 * with the errno NAME in `code` ('ESRCH' et al — the documented shape the
 * vendored liveness probes dispatch on, e.g. process-exit's
 * processExists), while the raw __dshProcKill throw only names it in the
 * message. The wrap installs once at boot and only reshapes the error —
 * the signal operation itself stays the seam's. */
let killFaceNormalized = false;
const normalizeKillFace = () => {
  if (killFaceNormalized) return;
  const proc = globalThis.process;
  if (typeof proc?.kill !== 'function') return;
  const raw = proc.kill.bind(proc);
  proc.kill = (pid, signal) => {
    try {
      return raw(pid, signal);
    } catch (error) {
      const match = /(E[A-Z]+)\b/.exec(String(error?.message ?? ''));
      if (match !== null && error?.code === undefined) {
        error.code = match[1];
        error.syscall = 'kill';
      }
      throw error;
    }
  };
  killFaceNormalized = true;
};

/** Wrap the host spawn intrinsics so EVERY child launch gets the staging
 * pass (W8). The suite drivers reach node:child_process directly (the
 * process-exit runScenario execa's the resolved launch; the corpus runner
 * spawnSync's its check script) — faces this class does not own — so the
 * hook lives on the seam itself, installed at BOOT (runtime-modules eval)
 * while globalThis still carries the raw intrinsics: node-child-process.js
 * captures them at ITS module eval, which only happens after boot, so the
 * shim serves the wrapped seam. Re-entrancy is safe: the staging children
 * (/bin/test, /bin/cp, python3) carry no bundle-absolute entries, so the
 * wrapped call they re-enter is a pass-through. */
/** The TSX_TSCONFIG_PATH correction at the spawn seam: real tsx throws at
 * register time when the env names a missing file, and the flat-staged
 * specs' import.meta.url joins always name one ('/tsconfig.json' et al).
 * resolveExampleLaunch keeps the vendored VERBATIM passthrough (the shape
 * tests pin the echo); the actual CHILDREN get the staged config here,
 * where only processes that read it can see the rewrite. */
const correctedTsConfigEnv = (env) => {
  const path = env?.TSX_TSCONFIG_PATH;
  if (typeof path !== 'string' || path.length === 0 || realFileExists(path)) return env;
  const staged = stageChildTsConfig();
  if (staged === null || staged === undefined) return env;
  return { ...env, TSX_TSCONFIG_PATH: staged };
};

let stagerInstalled = false;
export const installSpawnArgvStager = () => {
  if (stagerInstalled) return true;
  const spawn = globalThis.__dshProcSpawn;
  const spawnSync = globalThis.__dshProcSpawnSync;
  if (typeof spawn !== 'function') return false;
  globalThis.__dshProcSpawn = (options) => {
    try {
      if (Array.isArray(options?.args)) materializeChildArgv(options.args);
      if (options?.env?.TSX_TSCONFIG_PATH !== undefined) options = { ...options, env: correctedTsConfigEnv(options.env) };
    } catch { /* staging stays best-effort */ }
    return spawn(options);
  };
  if (typeof spawnSync === 'function') {
    globalThis.__dshProcSpawnSync = (options) => {
      try {
        if (Array.isArray(options?.args)) materializeChildArgv(options.args);
        if (options?.env?.TSX_TSCONFIG_PATH !== undefined) options = { ...options, env: correctedTsConfigEnv(options.env) };
      } catch { /* staging stays best-effort */ }
      return spawnSync(options);
    };
  }
  stagerInstalled = true;
  return true;
};
