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
 * Intentionally NOT supported: the remaining synchronous writes
 * (`writeFileSync`/`mkdirSync`/`rmSync`/`accessSync` — the promise face owns
 * writes, and pretending the sync ones work would fork the stores), streams
 * beyond the async-iterable `createReadStream` face (fs-local iterates; it
 * never pipes).
 */
import { DshBuffer, decodeUtf8 } from 'upstream/shims/buffer.js';

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

/** The staged read-only roots the VFS serves. Besides the web-plugins scan
 * view, vendored packages delivered as seed data (the agent-presets presets
 * tree, under the package's own bundle-relative directory) are readable —
 * that is what the fs/promises shim walks for the presets service. */
const VFS_ROOTS = [`${WEB_PLUGINS_ROOT}/`, '/vendor/dsh/agent-presets@0.1.6-alpha.2/'];
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
} from 'upstream/shims/fs-workspace.js';
import { mountWorkspace } from 'upstream/shims/fs-workspace.js';
export { mountWorkspace };

/** Read bytes: workspace file, or the seeded read-only view. Throws ENOENT
 * outside both. */
const readAnyBytes = (path) => {
  const file = wsFileAt(path);
  if (file !== undefined) return DshBuffer.fromBytes(file.bytes);
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const seeded = files.get(path);
    if (seeded !== undefined) return DshBuffer.fromBytes(seeded.bytes);
    throw enoent('open', path);
  }
  if (wsAt(path) !== null || underVFS(path)) throw enoent('open', path);
  return refuse('readFile')();
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
 * otherwise. Neither view has symlinks, so identity IS the realpath — which
 * is what the vendored fs-local uses as its stable target key. */
const vfsRealpath = (path) => {
  if (typeof path !== 'string') throw new TypeError(`node:fs.realpath: path must be a string, got ${typeof path}`);
  const canonical = path.startsWith('/') ? lexical(path) : path;
  const file = wsFileAt(canonical);
  if (file !== undefined) return canonical;
  if (wsIsDirAt(canonical)) return canonical;
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
  };
};

export const existsSync = (path) => {
  const files = vfs();
  if (files !== null && underVFS(path)) return files.has(path);
  if (wsFileAt(path) !== undefined) return true;
  if (wsIsDirAt(path)) return true;
  return false;
};

export const readFileSync = (path, encoding) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  const file = wsFileAt(canonical);
  if (file !== undefined || (wsIsDirAt(canonical) && wsAt(canonical) !== null)) {
    if (file === undefined) {
      const error = new Error(`EISDIR: illegal operation on a directory, read '${canonical}'`);
      error.code = 'EISDIR';
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
  if (wsAt(canonical) !== null) throw enoent('open', canonical);
  return refuse('readFileSync')();
};

export const statSync = (path, options = {}) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  const bigint = options.bigint === true;
  const shape = wsStatAt(canonical, bigint);
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
        mtimeMs: 0,
        ...(bigint ? { dev: 1n, ino: 0n, mode: BigInt(DIR_MODE), mtimeNs: 0n, ctimeNs: 0n } : {}),
      };
    }
    throw enoent('stat', path);
  }
  // A missing file INSIDE the pinned workspace is an ordinary ENOENT (the
  // vendored fs-local classifies absence by `error.code`), not a seam
  // refusal — the loud refusal stays for paths outside every staged view.
  if (wsAt(canonical) !== null) throw enoent('stat', canonical);
  return refuse('statSync')();
};

export const lstatSync = (path, options = {}) => {
  // No symlinks exist in either view: lstat == stat.
  return statSync(path, options);
};

export const accessSync = refuse('accessSync');
export const realpathSync = Object.assign(refuse('realpathSync'), {
  native: refuse('realpathSync.native'),
});
export const writeFileSync = refuse('writeFileSync');
export const mkdirSync = refuse('mkdirSync');
export const rmSync = refuse('rmSync');
export const realpath = realpathCallback;
export {
  // The writable-workspace internals the node:fs/promises shim is built on.
  mountWorkspace as _mountWorkspace,
  wsMkdir as _wsMkdir,
  wsWriteFile as _wsWriteFile,
  wsRm as _wsRm,
  wsRename as _wsRename,
  wsLink as _wsLink,
  wsChmod as _wsChmod,
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
  const wsNames = wsReaddirAt(canonical);
  if (wsNames !== null) return wsNames;
  const names = vfsReaddir(path);
  if (names !== null) return names;
  if (wsAt(canonical) !== null) throw enoent('readdir', canonical);
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
};
