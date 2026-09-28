// dsh:logging-exempt (shim layer)
/**
 * node:fs shim — LOUD by default: the spike runtime has no synchronous
 * filesystem; the gateway fs primitives are async and scope-confined per
 * contract/.
 *
 * Covers (upstream usage → this module):
 *   - dsh-sandbox (`accessSync`, `constants`, `realpathSync`, `statSync`) —
 *     the desktop sandbox's disk gate; mobile boundary = gateway fs scope
 *     (see runtime/spike/upstream/README.md, mapping table). The names exist
 *     so the vendored module links; any CALL outside the staged views fails
 *     loud naming the seam.
 *
 * W-INTEG exception — the STAGED WEB-PLUGIN VFS. Composing the official web
 * boot requires @deepseek-ai/dsh-client-modules' node half, whose incremental
 * `dsh.client` scan reads package manifests and client bundles synchronously
 * (`existsSync` / `readFileSync` / `statSync`). The host stages that
 * scan-scoped file set and delivers it over the bus seam (`web.plugins`);
 * `seedWebPlugins` mounts it read-only under /web-plugins. Outside the seeded
 * view the shim stays loud exactly as before, with one boundary decision:
 * `existsSync` ANSWERS a question (never moves bytes), so it returns false
 * outside the VFS instead of throwing — upstream's nearest-package walk relies
 * on false to keep scanning. `readFileSync` / `statSync` still refuse loudly
 * outside the VFS roots; inside it, a missing file throws ENOENT (upstream
 * classifies failures by `error.code`).
 *
 * FILE-TOOLS exception — the WRITABLE WORKSPACE VFS. The vendored
 * @deepseek-ai/dsh-fs-local backend (the `ctx.fs` service the fs tool family
 * mounts over) is built on the node:fs promise APIs; its world here is a
 * fully in-memory tree rooted at ONE pinned workspace root (`mountWorkspace`,
 * called by the composition that mounts fs-local — the probe, then boot.js).
 * Every write op (mkdir/rename/link/rm/chmod/write) serves THAT root only and
 * refuses the seeded read-only views; reads serve seeded view + workspace.
 * The store lives on the GLOBAL, not module state: quickjs compiles the
 * node:fs-mapped shim and any bundle-relative import of this file as TWO
 * module instances, and a module-local store would silently fork (the same
 * reasoning as the seeded VFS above).
 *
 * Intentionally NOT supported: `accessSync`/`realpathSync` (the sandbox's
 * disk-gate calls — still loud: the workspace answers existence questions
 * through `existsSync` and `realpath`), the seeded views as write targets
 * (they stay read-only; the workspace is the one writable root), and file
 * watching (`watchFile`/`unwatchFile` stay binding-only loud stubs — no
 * fs-event seam). The sync writes (writeFileSync/mkdirSync/rmSync/
 * mkdtempSync/symlinkSync/chmodSync/utimesSync) and the descriptor face
 * (openSync/writeSync/closeSync/unlinkSync/rmdirSync) are REAL workspace
 * operations since the 2026-09-27 suite round — same store as the promise
 * face, see the block comment at their definitions.
 */
import { DshBuffer, decodeUtf8, encodeUtf8 } from 'upstream/shims/buffer.js';

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  S_IFDIR: 0x4000,
  S_IFREG: 0x8000,
};

/** The VFS root (a POSIX path prefix; nothing below it hits a real disk). */
export const WEB_PLUGINS_ROOT = '/web-plugins';

/** Normalize a path argument that node's fs accepts but our string-keyed
 * views cannot: a URL object (what `new URL('fixtures/x', import.meta.url)`
 * produces in the transpiled specs — measured 2026-09-28, the cordis.yml
 * fixture reads) stringifies to its plain in-world path. Strings pass
 * through untouched. */
export const asFsPath = (path) => {
  if (path !== null && typeof path === 'object' && typeof path.href === 'string') return String(path);
  return path;
};

/**
 * The seeded view lives on the global, NOT in module state: the vendored
 * closure imports `node:fs` while our adapters may import the shim by its
 * bundle-relative path — quickjs would compile TWO module instances, and
 * module-local state would silently fork (the seed would land in the
 * instance the vendored scan never reads). The global is the single store.
 */
const vfs = () => {
  if (typeof globalThis.__DSH_WEB_PLUGINS_VFS__ === 'undefined') {
    globalThis.__DSH_WEB_PLUGINS_VFS__ = null;
  }
  return globalThis.__DSH_WEB_PLUGINS_VFS__;
};

/**
 * Mount the staged web-plugin view (bus seam `web.plugins`).
 * @param files - absolute POSIX path → { bytes: Uint8Array, mtimeMs: number }.
 */
export const seedWebPlugins = (files) => {
  const mounted = new Map();
  for (const [path, file] of Object.entries(files)) {
    if (typeof path !== 'string' || !VFS_ROOTS.some((root) => path.startsWith(root))) {
      throw new Error(`node:fs: staged seed path outside the VFS roots: ${path}`);
    }
    if (!(file.bytes instanceof Uint8Array) || typeof file.mtimeMs !== 'number') {
      throw new Error(`node:fs: staged web-plugin file ${path} needs {bytes, mtimeMs}`);
    }
    mounted.set(path, file);
  }
  globalThis.__DSH_WEB_PLUGINS_VFS__ = mounted;
};

/**
 * MERGE one staged chunk into the seeded view (bus seam `web.plugins`
 * chunked delivery — the harmony drive splits the multi-megabyte delivery so
 * the carrier's main thread yields between packages; the same validation as
 * `seedWebPlugins`, additive semantics).
 * @param files - absolute POSIX path → { bytes: Uint8Array, mtimeMs: number }.
 */
export const mergeWebPlugins = (files) => {
  const mounted = vfs() ?? new Map();
  for (const [path, file] of Object.entries(files)) {
    if (typeof path !== 'string' || !VFS_ROOTS.some((root) => path.startsWith(root))) {
      throw new Error(`node:fs: staged seed path outside the VFS roots: ${path}`);
    }
    if (!(file.bytes instanceof Uint8Array) || typeof file.mtimeMs !== 'number') {
      throw new Error(`node:fs: staged web-plugin file ${path} needs {bytes, mtimeMs}`);
    }
    mounted.set(path, file);
  }
  globalThis.__DSH_WEB_PLUGINS_VFS__ = mounted;
};

/** Register one seeded JS file as a runtime-defined module under its `file:`
 * URL (the __dshModuleDefine seam the host loader consults FIRST). The
 * vendored cordis plugin loader imports composition rows by dynamic import
 * of `new URL(row, baseUrl).href` — a file: URL the host cannot read off
 * disk because the seeded view lives in JS memory. Defining the source under
 * exactly the specifier the loader computes closes that seam without
 * touching the host. No-op for non-JS files and on hosts without the seam. */
const defineSeededModule = (path, bytes) => {
  if (!/\.(js|mjs)$/.test(path)) return;
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') return;
  define.call(globalThis, `file://${path}`, decodeUtf8(bytes));
};

/**
 * MERGE spec-fixture files into the seeded view (the upstream-suite driver's
 * seeding of one spec's fixtures under /upstream-tests/ — same validation and
 * store as the web-plugins view, additive so several seed deliveries compose).
 * @param files - absolute POSIX path → { bytes: Uint8Array, mtimeMs: number }.
 */
export const seedStagedFiles = (files) => {
  const mounted = vfs() ?? new Map();
  for (const [path, file] of Object.entries(files)) {
    if (typeof path !== 'string' || !VFS_ROOTS.some((root) => path.startsWith(root))) {
      throw new Error(`node:fs: staged seed path outside the VFS roots: ${path}`);
    }
    if (!(file.bytes instanceof Uint8Array) || typeof file.mtimeMs !== 'number') {
      throw new Error(`node:fs: staged file ${path} needs {bytes, mtimeMs}`);
    }
    mounted.set(path, file);
    defineSeededModule(path, file.bytes);
  }
  globalThis.__DSH_WEB_PLUGINS_VFS__ = mounted;
};

/** The staged read-only roots the VFS serves. Besides the web-plugins scan
 * view, vendored packages delivered as seed data (the agent-presets presets
 * tree, under the package's own bundle-relative directory) are readable —
 * that is what the fs/promises shim walks for the presets service. */
const VFS_ROOTS = [`${WEB_PLUGINS_ROOT}/`, '/vendor/dsh/agent-presets@0.1.6-alpha.2/',
  // The upstream-suite spec fixtures (growth round 3): transpiled specs sit
  // flat at /upstream-tests/<stem>.spec.mjs, so their `../fixtures` joins
  // resolve to /upstream-tests/fixtures — the suite driver seeds the bytes
  // there before running the spec's tests (one spec per runtime, so last-
  // write-wins across specs is not a hazard).
  '/upstream-tests/'];
const underVFS = (path) => typeof path === 'string' && VFS_ROOTS.some((root) => path.startsWith(root));

const refuse = (name) => () => {
  throw new Error(
    `node:fs.${name}: no synchronous filesystem in the spike runtime — `
    + 'this path is a desktop host capability; on mobile the same boundary is the '
    + 'gateway fs scope (see runtime/spike/upstream/README.md)');
};

const enoent = (name, path) => {
  const error = new Error(`ENOENT: no such file or directory, ${name} '${path}'`);
  error.code = 'ENOENT';
  error.errno = -2;
  error.syscall = name;
  error.path = path;
  return error;
};

/* The writable workspace VFS lives in fs-workspace.js (split 2026-09-22):
 * the world mountWorkspace pins, its entries/clock, and the operations
 * over them. */
import {
  workspace,
  wsAt,
  ws,
  lexical,
  DIR_MODE,
  bumpClock,
  wsCreateFile,
  wsFileAt,
  wsIsDirAt,
  wsStatAt,
  wsReaddirAt,
  wsEnoent,
  wsEexist,
  wsEnotdir,
  wsMkdir,
  wsWriteFile,
  wsRm,
  wsRename,
  wsLink,
  wsChmod,
  wsUtimes,
  wsWatch,
  wsSymlink,
  wsReadlinkAt,
  resolveSymlinkAt,
} from 'upstream/shims/fs-workspace.js';
import { mountWorkspace } from 'upstream/shims/fs-workspace.js';
export { mountWorkspace };

/** Read bytes: workspace file, or the seeded read-only view. A workspace
 * symlink resolves ONE hop before the lookup (a dangling link ENOENTs).
 * Throws ENOENT outside both views. */
const readAnyBytes = (path) => {
  const resolved = resolveWorkspaceSymlink(path);
  const file = wsFileAt(resolved);
  if (file !== undefined) {
    // File-level read permission: the workspace tracks a mode per file, and
    // a 0-bit mode is unreadable — EACCES like node (settings-file's
    // fails-loud-at-boot test chmods the document to 0o000). Directory modes
    // stay tracked-but-unenforced (the §3 note above): only FILE reads gate.
    if (((file.mode ?? 0o644) & 0o444) === 0) {
      const error = new Error(`EACCES: permission denied, open '${resolved}'`);
      error.code = 'EACCES';
      error.errno = -13;
      error.syscall = 'open';
      error.path = resolved;
      throw error;
    }
    return DshBuffer.fromBytes(file.bytes);
  }
  // Reading a DIRECTORY is EISDIR, like node's open(2) gate (measured
  // 2026-09-28: credentials-local mkdirs the document path and expects the
  // boot read to reject /EISDIR/, not to treat it as an absent document).
  if (wsIsDirAt(resolved)) {
    const error = new Error(`EISDIR: illegal operation on a directory, read '${resolved}'`);
    error.code = 'EISDIR';
    error.errno = -21;
    error.syscall = 'read';
    error.path = resolved;
    throw error;
  }
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const seeded = files.get(path);
    if (seeded !== undefined) return DshBuffer.fromBytes(seeded.bytes);
    throw enoent('open', path);
  }
  if (wsAt(resolved) !== null || underVFS(path)) throw enoent('open', resolved);
  return refuse('readFile')();
};

/** One-hop symlink resolution for workspace paths (identity elsewhere);
 * resolveSymlinkAt joins relative targets against the link's directory and
 * returns undefined for non-symlinks. The seeded views have no symlinks. */
const resolveWorkspaceSymlink = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return path;
  const canonical = lexical(path);
  // Resolve the DEEPEST symlinked ancestor chain: '/a/link/b' with a link at
  // '/a/link' reads through the target (node resolves every symlinked path
  // prefix, one hop per link here — the store's model). A full-path link is
  // the special case where the walk resolves the last segment. Measured
  // 2026-09-27: skill-filesystem publishes whole-directory symlinked skills
  // (SKILL.md read through the linked directory).
  const state = workspace();
  if (state !== null && state.symlinks.size > 0) {
    let resolved = '';
    let hit = false;
    for (const seg of canonical.split('/')) {
      if (seg === '') continue;
      const candidate = `${resolved}/${seg}`;
      const target = state.symlinks.get(candidate);
      if (target !== undefined) {
        hit = true;
        resolved = target.startsWith('/')
          ? lexical(target)
          : lexical(`${resolved}/${target}`);
      } else {
        resolved = candidate;
      }
    }
    if (hit && resolved !== canonical) return resolved;
  }
  return resolveSymlinkAt(canonical) ?? canonical;
};
const workspaceSymlinkTarget = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  return wsReadlinkAt(lexical(path));
};

const outsideEveryView = (path) => {
  const error = new Error(
    `node:fs: path '${path}' is outside the writable workspace root and every staged read-only view `
    + `— the fs backends on this host serve exactly one pinned workspace (mountWorkspace) `
    + `plus the seeded views (see runtime/spike/upstream/README.md, FILE-TOOLS row)`);
  error.code = 'EACCES';
  error.path = path;
  return error;
};

/** The canonical spelling of an existing staged/workspace path; ENOENT
 * otherwise. Workspace paths resolve ONE symlink hop first (the realpath
 * contract; the seeded views carry no symlinks) — which is what the vendored
 * fs-local uses as its stable target key. */
const vfsRealpath = (path) => {
  if (typeof path !== 'string') throw new TypeError(`node:fs.realpath: path must be a string, got ${typeof path}`);
  const canonical = path.startsWith('/') ? lexical(path) : path;
  // One hop of symlink resolution (undefined for non-symlinks = identity).
  const resolved = resolveWorkspaceSymlink(canonical);
  const target = resolved === canonical ? canonical : (wsFileAt(resolved) !== undefined || wsIsDirAt(resolved)) ? resolved : canonical;
  const file = wsFileAt(target);
  if (file !== undefined) return target;
  if (wsIsDirAt(target)) return target;
  const files = vfs();
  if (files !== null) {
    if (files.has(canonical)) return canonical;
    const prefix = canonical.endsWith('/') ? canonical : `${canonical}/`;
    if (underVFS(prefix)) {
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) return canonical;
      }
    }
  }
  if (!underVFS(canonical) && wsAt(canonical) === null) {
    throw outsideEveryView(canonical);
  }
  throw enoent('realpath', canonical);
};

const realpathCallback = (path, callback) => {
  if (typeof callback !== 'function') {
    throw new TypeError('node:fs.realpath: a callback is required (the spike serves the callback face; promise users go through fs/promises)');
  }
  try {
    callback(null, vfsRealpath(path));
  } catch (error) {
    callback(error);
  }
};
realpathCallback.native = realpathCallback;

/** createReadStream — the async-iterable face fs-local iterates (`for await
 * (const chunk of stream)`). Bytes are yielded as DshBuffer chunks in file
 * order; `start`/`end` are the node INCLUSIVE byte window; aborting the
 * signal stops the iteration with an AbortError-shaped throw. */
export const createReadStream = (path, options = {}) => {
  const start = typeof options.start === 'number' ? options.start : 0;
  const end = typeof options.end === 'number' ? options.end : Number.MAX_SAFE_INTEGER;
  const CHUNK = 64 * 1024;
  const iterate = async function* () {
    const bytes = readAnyBytes(path);
    const last = Math.min(end, bytes.length - 1);
    for (let at = start; at <= last; at += CHUNK) {
      if (options.signal?.aborted) {
        const error = new Error('read aborted');
        error.name = 'AbortError';
        throw error;
      }
      yield DshBuffer.fromBytes(bytes.subarray(at, Math.min(at + CHUNK, last + 1)));
    }
  };
  const iterator = iterate();
  return {
    [Symbol.asyncIterator]: () => iterator,
    // The Readable cleanup face the closure's finally blocks call
    // (attachment-local's readFileStreamVerbatim destroys the stream after
    // the drain; a missing member surfaced as 'not a function', R3-G1
    // 2026-09-28). The generator holds no OS resource — cleanup is a no-op.
    destroy: () => {},
    close: async () => {},
  };
};

/** Answer one `node_modules/<pkg>/package.json` existence question through
 * the loader's OWN bare-specifier map (__dshBundleRequire — the node:module
 * seam). Consumer: the vendored agent-presets packageInstalled walk, which
 * probes `<dir>/node_modules/<pkg>/package.json` up the directory chain to
 * decide whether a composition row's package name is installed. There is no
 * node_modules in the staged closure — the packages live in the vendored
 * probe families — so the honest answer is the loader's: the name resolves
 * iff the vendored closure serves it. Unmapped names fail the probe and read
 * as absent (a composition row naming a package the deployment does not
 * carry stays `broken`, which is the contract). */
const nodeModulesProbe = (path) => {
  const match = typeof path === 'string'
    ? path.match(/\/node_modules\/(@[^/]+\/[^/]+|[^@/][^/]*)\/package\.json$/) : null;
  if (match === null) return false;
  const probe = globalThis.__dshBundleRequire;
  if (typeof probe !== 'function') return false;
  try {
    probe.call(globalThis, match[1], '../package.json');
    return true;
  } catch {
    return false;
  }
};

export const existsSync = (rawPath) => {
  const path = asFsPath(rawPath);
  const files = vfs();
  if (files !== null && underVFS(path)) return files.has(path);
  if (workspaceSymlinkTarget(path) !== undefined) return true;
  if (wsFileAt(path) !== undefined) return true;
  if (wsIsDirAt(path)) return true;
  if (nodeModulesProbe(path)) return true;
  return false;
};

export const readFileSync = (rawPath, encoding) => {
  const path = asFsPath(rawPath);
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  // Reads follow one symlink hop (stat/read resolve links, node's shape).
  const workspacePath = resolveWorkspaceSymlink(canonical);
  const file = wsFileAt(workspacePath);
  if (file !== undefined || (wsIsDirAt(workspacePath) && wsAt(workspacePath) !== null)) {
    if (file === undefined) {
      const error = new Error(`EISDIR: illegal operation on a directory, read '${canonical}'`);
      error.code = 'EISDIR';
      throw error;
    }
    // File-level read permission (see readAnyBytes): a 0-read-bit mode is
    // EACCES, like node's open gate (settings-file fails-loud-at-boot).
    if (((file.mode ?? 0o644) & 0o444) === 0) {
      const error = new Error(`EACCES: permission denied, open '${canonical}'`);
      error.code = 'EACCES';
      error.errno = -13;
      error.syscall = 'open';
      error.path = canonical;
      throw error;
    }
    if (typeof encoding === 'string'
        && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
      throw new Error(`node:fs: readFileSync encoding '${encoding}' — supported: utf8, buffer`);
    }
    if (encoding === undefined || encoding === null || encoding === 'buffer') {
      return DshBuffer.fromBytes(file.bytes);
    }
    return decodeUtf8(file.bytes);
  }
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const seeded = files.get(path);
    if (seeded === undefined) throw enoent('open', path);
    if (typeof encoding === 'string'
        && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
      throw new Error(`node:fs: readFileSync encoding '${encoding}' — supported: utf8, buffer`);
    }
    if (encoding === undefined || encoding === null || encoding === 'buffer') {
      return DshBuffer.fromBytes(seeded.bytes);
    }
    return decodeUtf8(seeded.bytes);
  }
  if (wsAt(canonical) !== null) throw enoent('open', workspacePath);
  return refuse('readFileSync')();
};

export const statSync = (path, options = {}) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  const bigint = options.bigint === true;
  // The workspace ROOT'S ANCESTORS ('/', '/tmp', ...) sit above the pinned
  // profile container: a real host answers their stat as owned directories,
  // so the protected-ancestor walks (spill sweep, atomic-write staging)
  // climb out of the root without ENOENT. Owned single-user dir: uid/gid 0,
  // 0755 (group/other write-free — trusted to the POSIX safety checks).
  const root = globalThis.__DSH_WORKSPACE_FS__?.root;
  if (typeof root === 'string' && canonical !== root && root.startsWith(`${canonical === '/' ? '' : canonical}/`)) {
    const mk = (m) => ({
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      size: bigint ? 0n : 0,
      dev: 1,
      ino: 0,
      mode: m,
      uid: 0,
      gid: 0,
      mtimeMs: 0,
      ...(bigint ? { dev: 1n, ino: 0n, mode: BigInt(m), mtimeNs: 0n, ctimeNs: 0n } : {}),
    });
    return mk(0o100755 & 0o777);
  }
  // stat FOLLOWS symlinks (one hop here); lstat does not.
  const followed = resolveWorkspaceSymlink(canonical);
  const shape = wsStatAt(followed, bigint);
  if (shape !== null) return shape;
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const seeded = files.get(path);
    if (seeded !== undefined) {
      return {
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: bigint ? BigInt(seeded.bytes.length) : seeded.bytes.length,
        mode: 0o644,
        uid: 0,
        gid: 0,
        mtimeMs: seeded.mtimeMs,
        ...(bigint ? {
          dev: 1n,
          ino: 0n,
          mode: 0o100644n & 0o777n,
          mtimeNs: BigInt(Math.round(seeded.mtimeMs)) * 1000000n,
          ctimeNs: BigInt(Math.round(seeded.mtimeMs)) * 1000000n,
        } : {}),
      };
    }
    const names = vfsReaddir(path);
    if (names !== null) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        size: bigint ? 0n : 0,
        mode: DIR_MODE,
        mtimeMs: 0,
        ...(bigint ? { dev: 1n, ino: 0n, mode: BigInt(DIR_MODE), mtimeNs: 0n, ctimeNs: 0n } : {}),
      };
    }
    throw enoent('stat', path);
  }
  // A missing file INSIDE the pinned workspace is an ordinary ENOENT (the
  // vendored fs-local classifies absence by `error.code`), not a seam
  // refusal. The same in-world answer covers paths OUTSIDE every staged
  // view: this runtime's world is the workspace plus the seeded views, and
  // anything else does not exist IN it (R3-G1, 2026-09-28 — fs-sandbox's
  // containment walk stats candidate roots that were never staged and
  // classifies the ENOENT itself; the loud refusal broke that classification).
  if (wsAt(canonical) !== null) throw enoent('stat', canonical);
  throw enoent('stat', typeof path === 'string' ? path : String(path));
};

export const lstatSync = (path, options = {}) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  // The one lstat-vs-stat delta: a symlink entry reports itself (node: the
  // stat fields of the link itself are a stub beyond isSymbolicLink, which
  // is the only member the closure's walks consult).
  if (workspaceSymlinkTarget(canonical) !== undefined) {
    const bigint = options.bigint === true;
    return {
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => true,
      size: bigint ? 0n : 0,
      mode: 0o777,
      mtimeMs: 0,
      ...(bigint ? { dev: 1n, ino: 0n, mode: 0o120777n & 0o777n, mtimeNs: 0n, ctimeNs: 0n } : {}),
    };
  }
  return statSync(path, options);
};

/** accessSync(path, mode) — REAL over the staged views (upgraded 2026-09-28
 * from the loud refusal): existence plus the requested permission bits over
 * the workspace file/directory modes (the same tracked modes chmodSync
 * writes and statSync reads). Consumers: dsh-sandbox root checks and the
 * directory-picker auto-probe's canExecute (chmod 0o755 → X_OK true, absent
 * → ENOENT false). Directory W_OK/X_OK answer true — the workspace is the
 * one writable, traversable root. Outside every staged view: ENOENT (the
 * in-world does-not-exist answer, matching the statSync note below). */
export const accessSync = (path, mode = constants.F_OK) => {
  const requested = Number(mode) || 0;
  let shape;
  try {
    shape = statSync(path);
  } catch (error) {
    throw error; // ENOENT (or the NUL TypeError) propagates, like node
  }
  if ((requested & constants.R_OK) !== 0 && typeof shape.mode === 'number' && (shape.mode & 0o444) === 0 && shape.isFile()) {
    const error = new Error(`EACCES: permission denied, access '${path}'`);
    error.code = 'EACCES';
    error.errno = -13;
    error.syscall = 'access';
    error.path = path;
    throw error;
  }
  if ((requested & constants.W_OK) !== 0 && typeof shape.mode === 'number' && (shape.mode & 0o222) === 0 && shape.isFile()) {
    const error = new Error(`EACCES: permission denied, access '${path}'`);
    error.code = 'EACCES';
    error.errno = -13;
    error.syscall = 'access';
    error.path = path;
    throw error;
  }
  if ((requested & constants.X_OK) !== 0 && shape.isFile() && typeof shape.mode === 'number' && (shape.mode & 0o111) === 0) {
    const error = new Error(`EACCES: permission denied, access '${path}'`);
    error.code = 'EACCES';
    error.errno = -13;
    error.syscall = 'access';
    error.path = path;
    throw error;
  }
  return undefined;
};
/** realpathSync(.native) — REAL over the staged views (upgraded 2026-09-27
 * from the loud refusal): the vendored dsh-sandbox canonicalizes root paths
 * with realpathSync.native, and the staged workspace CAN canonicalize — the
 * seeded keys are already canonical (identity), workspace paths resolve one
 * symlink hop lexically, and a missing in-view path is an ENOENT the caller
 * classifies (canonicalPath falls back to the input spelling). Outside every
 * staged view stays the loud refusal naming the seam. */
const realpathSyncImpl = (path) => vfsRealpath(path);
export const realpathSync = Object.assign(realpathSyncImpl, {
  native: realpathSyncImpl,
});
// The file-watch surface, linked by @deepseek-ai/dsh-skill-filesystem
// (`import { unwatchFile, watchFile } from "node:fs"`). Binding-only stubs:
// they are reached only from its watcher manager, and the mobile profile
// mounts that package with watch:false — the runtime has no fs-event seam
// (the same staged gap as the timers). A call here means a watch:true mount
// slipped through, so it fails loud naming the package's own remedy.
export const watchFile = refuse('watchFile');
export const unwatchFile = refuse('unwatchFile');
export const realpath = realpathCallback;

/* ---- the synchronous workspace writes + fd face (2026-09-27) ------------
 * The old wall ("sync writes refuse; the promise face owns writes") came
 * down when the suite's sync-write consumers (spill-local staging, the
 * subprocess-local spill collector, the settings/spill chmod+utimes aging)
 * linked against these names and then CALLED them: the store is the same
 * workspace VFS the promise face serves, so the sync twins are real
 * operations over it — one store, two spellings. Anything outside the
 * writable workspace root still refuses exactly as before. */

export const writeFileSync = (path, data, options) => {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`node:fs.writeFileSync: data must be a string or Uint8Array, got ${typeof data}`);
  }
  if (typeof options === 'object' && options !== null && options.flag !== undefined
      && typeof options.flag === 'string' && options.flag.includes('x')
      && existsSync(path)) {
    throw wsEexist('open', path);
  }
  const mode = typeof options === 'object' && options !== null ? options.mode : undefined;
  return wsWriteFile(path, bytes, mode);
};

export const mkdirSync = (path, options) => {
  if (options === true || options?.recursive === true) {
    return wsMkdir(path, { recursive: true });
  }
  return wsMkdir(path, {});
};

export const rmSync = (path, options = {}) => {
  return wsRm(path, options);
};

/** mkdtemp — node's unique-suffix temp dir over the workspace (the same
 * monotonic-counter uniqueness the promise face uses; the spill/staging
 * callers derive paths from os.tmpdir(), which the suite leg pins to the
 * workspace root). */
let mkdtempSyncCounter = 0;
export const mkdtempSync = (prefix) => {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('node:fs.mkdtempSync: prefix must be a non-empty string');
  }
  const path = `${prefix}${Date.now().toString(36)}-${(mkdtempSyncCounter += 1).toString(36)}`;
  wsMkdir(path, {});
  return path;
};

export const chmodSync = (path, mode) => wsChmod(path, mode);

/** utimes(path, atime, mtime) — seconds (floats) like node; the mtime is
 * what the sweep/spill aging reads back through stat. */
export const utimesSync = (path, atime, mtime) => wsUtimes(path, atime, mtime);

/** symlink(target, path) — a stored raw target, resolved one hop by the
 * readers (stat/read); readlink returns it verbatim. Replaces the old loud
 * stub: the workspace CAN express a path alias (fs-workspace symlinks map),
 * so the honest operation is the real one. */
export const symlinkSync = (target, path) => wsSymlink(target, path);

export const readlinkSync = (path) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  const target = workspaceSymlinkTarget(canonical);
  if (target === undefined) {
    if (existsSync(canonical)) {
      const error = new Error(`EINVAL: invalid argument, readlink '${canonical}'`);
      error.code = 'EINVAL';
      error.syscall = 'readlink';
      error.path = canonical;
      throw error;
    }
    throw enoent('readlink', canonical);
  }
  return target;
};

/* The descriptor face: subprocess-local's output collector opens its spill
 * file, writes chunks, closes (openSync/writeSync/closeSync). The VFS has
 * no real fds — a monotonic descriptor over a {path, append, cursor} record
 * on the GLOBAL (the multi-instance rule: module state would fork). */
const fdTable = () => {
  if (typeof globalThis.__DSH_FS_FDS__ === 'undefined') globalThis.__DSH_FS_FDS__ = new Map();
  return globalThis.__DSH_FS_FDS__;
};
let nextFdSync = 16;

const ebadf = (call, fd) => {
  const error = new Error(`EBADF: bad file descriptor, ${call} ${fd}`);
  error.code = 'EBADF';
  error.errno = -9;
  error.syscall = call;
  return error;
};

export const openSync = (path, flags = 'r', mode) => {
  const flag = typeof flags === 'string' ? flags : 'r';
  const exists = existsSync(path);
  if (flag === 'r' || flag === 'r+') {
    if (!exists) throw enoent('open', path);
  } else if (flag === 'w' || flag === 'wx' || flag === 'ax' || flag === 'a' || flag.includes('x')) {
    if (flag.includes('x') && exists) throw wsEexist('open', path);
    if (!exists || flag === 'w' || flag === 'wx') wsWriteFile(path, new Uint8Array(0), mode);
  } else {
    throw new Error(`node:fs.openSync: flag '${flag}' — supported: r, r+, w, wx, a, ax (the closure's sync faces)`);
  }
  const fd = nextFdSync++;
  fdTable().set(fd, {
    path,
    append: flag === 'a' || flag === 'ax',
    cursor: 0,
  });
  return fd;
};

export const writeSync = (fd, data, ...rest) => {
  const record = fdTable().get(fd);
  if (record === undefined) throw ebadf('write', fd);
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`node:fs.writeSync: data must be a string or Uint8Array, got ${typeof data}`);
  }
  const current = (() => {
    try {
      return readAnyBytes(record.path);
    } catch {
      return DshBuffer.fromBytes(new Uint8Array(0));
    }
  })();
  // An append descriptor always lands at EOF; the rest honor the cursor
  // (or the explicit position argument, node's 4th form — unused here).
  const at = record.append ? current.length : Math.min(record.cursor, current.length);
  const merged = new Uint8Array(Math.max(current.length, at + bytes.length));
  merged.set(current, 0);
  merged.set(bytes, at);
  wsWriteFile(record.path, merged, undefined);
  if (!record.append) record.cursor = at + bytes.length;
  return bytes.length;
};

export const readSync = (fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) => {
  const record = fdTable().get(fd);
  if (record === undefined) throw ebadf('read', fd);
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError(`node:fs.readSync: buffer must be a Uint8Array, got ${typeof buffer}`);
  }
  const whole = readAnyBytes(record.path);
  // position null = the descriptor cursor (node semantics); an explicit
  // position reads there and leaves the cursor alone.
  const at = position === null || position === undefined
    ? Math.min(record.cursor, whole.length)
    : position;
  const count = Math.max(0, Math.min(length, whole.length - at));
  if (count > 0) buffer.set(whole.subarray(at, at + count), offset);
  if (position === null || position === undefined) record.cursor = at + count;
  return count;
};

export const closeSync = (fd) => {
  if (!fdTable().delete(fd)) throw ebadf('close', fd);
};

/** copyFile(src, dest) — bytes of src written to dest (COPYFILE_EXCL in
 * flags makes an existing dest an EEXIST, node's one flag). The workspace
 * store is the same one the promise face serves. */
export const copyFileSync = (src, dest, flags = 0) => {
  const bytes = readAnyBytes(typeof src === 'string' ? lexical(src) : src);
  if ((flags & constants.COPYFILE_EXCL) !== 0 && existsSync(dest)) {
    throw wsEexist('copyfile', dest);
  }
  wsWriteFile(dest, bytes, undefined);
  return undefined;
};

/** renameSync — the workspace rename (files and directory subtrees; the
 * same store the promise face's rename serves). */
export const renameSync = (from, to) => wsRename(from, to);

/** cpSync(src, dest[, options]) — the SYNC face of the promise shim's cp
 * (node:fs/promises.cp, wave 1): a real recursive copy between the seeded
 * read-only views and the writable workspace. Options follow node:
 * `recursive` walks directories (without it a directory source throws
 * EISDIR); `force:false` refuses an occupied destination with EEXIST
 * (node's spelling); `dereference` rides statSync/readFileSync's one-hop
 * symlink resolution exactly as the promise face's does. The walk is
 * naturally synchronous — the promise face wraps the same semantics in
 * async — so the two faces stay one contract. Demanded at link time by the
 * subagent-codex real-product spec. */
const cpSyncEntry = (from, to, options) => {
  const info = statSync(from);
  if (info.isDirectory()) {
    if (options?.recursive !== true) {
      const error = new Error(`EISDIR: illegal operation on a directory, cp '${from}' -> '${to}'`);
      error.code = 'EISDIR';
      error.syscall = 'cp';
      error.path = from;
      throw error;
    }
    const destInfo = existsSync(to) ? statSync(to) : null;
    if (destInfo !== null && !destInfo.isDirectory()) throw wsEexist('cp', to);
    if (destInfo === null) wsMkdir(to, { recursive: true });
    const prefix = from.endsWith('/') ? from : `${from}/`;
    for (const name of readdirSync(from)) {
      cpSyncEntry(`${prefix}${name}`, `${to}/${name}`, options);
    }
    return;
  }
  if (existsSync(to) && options?.force !== true) throw wsEexist('cp', to);
  wsWriteFile(to, readFileSync(from), info.mode & 0o777);
};
export const cpSync = (source, destination, options) => {
  cpSyncEntry(source, destination, options ?? {});
};

/** unlink: files and symlink entries only (node unlinks a directory with
 * EPERM); rmdir: the ENOTEMPTY-enforcing removal (wsRm non-recursive). */
export const unlinkSync = (path) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  if (workspaceSymlinkTarget(canonical) !== undefined) {
    workspace().symlinks.delete(canonical);
    return;
  }
  if (wsIsDirAt(canonical) && !wsFileAt(canonical)) {
    const error = new Error(`EPERM: operation not permitted, unlink '${canonical}'`);
    error.code = 'EPERM';
    error.syscall = 'unlink';
    error.path = canonical;
    throw error;
  }
  wsRm(canonical, { force: false });
};

export const rmdirSync = (path) => wsRm(path, {});
export {
  // The writable-workspace internals the node:fs/promises shim is built on.
  mountWorkspace as _mountWorkspace,
  wsMkdir as _wsMkdir,
  wsWriteFile as _wsWriteFile,
  wsRm as _wsRm,
  wsRename as _wsRename,
  wsLink as _wsLink,
  wsChmod as _wsChmod,
  wsWatch as _wsWatch,
  wsAt as _wsAt,
  wsStatAt as _wsStatAt,
  wsReaddirAt as _wsReaddirAt,
  wsFileAt as _wsFileAt,
};

/** Directory names derivable from the seeded file keys: one level, sorted —
 * the same contract readdir(3) has and the presets walk expects. */
const vfsReaddir = (path) => {
  const files = vfs();
  if (files === null) return null;
  const prefix = path.endsWith('/') ? path : `${path}/`;
  if (!underVFS(prefix)) return null;
  const names = new Set();
  for (const key of files.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    names.add(slash === -1 ? rest : rest.slice(0, slash));
  }
  return names.size > 0 ? [...names].sort() : null;
};

export const readdirSync = (path) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  // A symlinked directory entry reads through the link (node follows the hop
  // for readdir; measured 2026-09-27: the skill-filesystem suite publishes
  // skills linked as whole directories).
  const wsNames = wsReaddirAt(resolveWorkspaceSymlink(canonical));
  if (wsNames !== null) return wsNames;
  const names = vfsReaddir(path);
  if (names !== null) return names;
  if (wsAt(canonical) !== null) {
    // node's readdir spells a FILE target ENOTDIR (the storage-json lazy
    // loadAll propagates non-ENOENT failures; ENOENT means "no unit yet").
    if (wsFileAt(canonical) !== undefined) throw wsEnotdir('readdir', canonical);
    throw enoent('readdir', canonical);
  }
  return refuse('readdirSync')();
};

export default {
  constants,
  WEB_PLUGINS_ROOT,
  seedWebPlugins,
  mergeWebPlugins,
  mountWorkspace,
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  lstatSync,
  readdirSync,
  realpath,
  accessSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  chmodSync,
  utimesSync,
  symlinkSync,
  readlinkSync,
  renameSync,
  openSync,
  writeSync,
  readSync,
  closeSync,
  copyFileSync,
  cpSync,
  unlinkSync,
  rmdirSync,
};
