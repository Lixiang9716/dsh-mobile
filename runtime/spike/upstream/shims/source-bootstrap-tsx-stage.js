// dsh:logging-exempt (shim layer: no transport, no I/O of its own)
/**
 * source-bootstrap-tsx-stage.js — the STAGING half of the tsx
 * source-entry bootstrap (split from source-bootstrap-tsx.js, W9): the
 * real-disk staging pass every child launch rides. One-way dependency by
 * construction — this module imports NOTHING from the tsx face (a static
 * cycle between two shims files kills QuickJS at link); the face imports
 * and re-exports this module's exported names so existing specifiers
 * keep working:
 *
 *   - realFileExists / stageChildTsConfig — the real-file probe and the
 *     staged TSX_TSCONFIG_PATH config (moved here because the spawn-seam
 *     env correction below is their in-realm caller);
 *   - materializeChildArgv / installSpawnArgvStager — the argv remap's
 *     byte stager and the boot-time spawn/spawnSync wrapper that calls
 *     it (see the tsx face's header for the three-seam story: this file
 *     is seam 2, SOURCE BYTES).
 */

import { readFileSync } from 'upstream/shims/fs.js';
import { encodeUtf8 } from 'upstream/shims/buffer.js';

const spawnSyncNs = () => globalThis.__dshChildProcessNs ?? {};

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

/** Real-file existence probe: /bin/test -f over the real disk, relative
 * to the CLI's own working directory for bundle paths. Returns true only
 * when the REAL file exists — the question the child's node would answer
 * at open time. */
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

let realRoot;
let stagedTsConfig;
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

const readManifestSafe = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

let pathsMapCache;
/** Path rows for ONE vendored package dir: bare name → lib entry,
 * exports-map subpaths → their lib targets (absolute — the child's
 * resolver uses them as-is). Returns [key, target] pairs; empty when the
 * dir has no servable build. `names` carries the import spellings (the
 * dsh-scoped aliases: cordis/cosmokit live unscoped in the vendor tree,
 * the closure imports them scoped — both get rows). */
const vendoredDirPathRows = (line, names) => {
  const manifest = readManifestSafe(`${line}/package.json`);
  if (manifest === null) return [];
  const libDir = typeof manifest.main === 'string' && manifest.main !== ''
    ? manifest.main.replace(/\/[^/]*$/, '')
    : 'lib';
  const bareTarget = `${line}/${libDir}/index.js`;
  if (!realFileExists(bareTarget)) return [];
  const rows = names.map((name) => [name, [bareTarget]]);
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
    for (const name of names) rows.push([`${name}${sub}`, [abs]]);
  }
  return rows;
};
/** One paths row per vendored package surface: scans the staging
 * families once and memoizes (the dsh-scoped aliases get both
 * spellings). */
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
          let names = [stem, `@deepseek-ai/${stem}`];
          if (relLine.startsWith('vendor/npm/@deepseek-ai/')) names = [`@deepseek-ai/${stem}`];
          for (const [key, target] of vendoredDirPathRows(line, names)) paths[key] = target;
        }
      }
    }
  } catch {
    // An empty map still gives the child a parsable config.
  }
  pathsMapCache = paths;
  return paths;
};

/** The real root this CLI process runs under (a /bin/pwd child): the
 * prefix every staged rel path resolves against. */
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
/** Write the real file for one staged arg the disk lacks: the
 * staged/seeded view's bytes first (base64 through python3), else the
 * vendored origin verbatim (D6 staging). Returns the bundle-relative
 * path on success, undefined when nothing could be staged. */
const writeStagedArg = (arg, rel, dir) => {
  let bytes;
  try {
    bytes = readFileSync(arg); // the staged/seeded view first
  } catch {
    bytes = undefined;
  }
  const { spawnSync } = spawnSyncNs();
  if (typeof spawnSync !== 'function') return undefined;
  spawnSync('/bin/mkdir', ['-p', dir]);
  let writer;
  if (bytes !== undefined && bytes !== null) {
    const b64 = toB64(bytes);
    writer = spawnSync('/usr/bin/python3', [
      '-c',
      `import base64, pathlib; pathlib.Path('${rel}').write_bytes(base64.b64decode('${b64}'))`,
    ]);
  } else {
    // No seeded bytes: copy the vendored origin verbatim (D6 staging).
    const origin = findVendoredOrigin(rel.slice(rel.lastIndexOf('/') + 1));
    if (origin === null) return undefined;
    writer = spawnSync('/bin/cp', [origin, rel]);
  }
  return writer?.status === 0 ? rel : undefined;
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
      if (probe?.status !== 0 && writeStagedArg(arg, rel, dir) !== undefined) {
        materialized.push(`${root}/${rel}`);
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
