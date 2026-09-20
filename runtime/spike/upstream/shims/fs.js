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
 *     so the vendored module links; any CALL outside the staged view fails
 *     loud naming the seam (PR-B: subprocess/fs service over the gateway).
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
 * outside the VFS root; inside it, a missing file throws ENOENT (upstream
 * classifies failures by `error.code`).
 *
 * Intentionally NOT supported: every synchronous write (fail loud), the
 * promise APIs object (link error on import), streams (link error).
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
    if (typeof path !== 'string' || !path.startsWith(`${WEB_PLUGINS_ROOT}/`)) {
      throw new Error(`node:fs: staged web-plugin path escapes ${WEB_PLUGINS_ROOT}: ${path}`);
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
    if (typeof path !== 'string' || !path.startsWith(`${WEB_PLUGINS_ROOT}/`)) {
      throw new Error(`node:fs: staged web-plugin path escapes ${WEB_PLUGINS_ROOT}: ${path}`);
    }
    if (!(file.bytes instanceof Uint8Array) || typeof file.mtimeMs !== 'number') {
      throw new Error(`node:fs: staged web-plugin file ${path} needs {bytes, mtimeMs}`);
    }
    mounted.set(path, file);
  }
  globalThis.__DSH_WEB_PLUGINS_VFS__ = mounted;
};

const underVFS = (path) => typeof path === 'string' && path.startsWith(`${WEB_PLUGINS_ROOT}/`);

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

export const existsSync = (path) => {
  const files = vfs();
  if (files === null || !underVFS(path)) return false;
  return files.has(path);
};

export const readFileSync = (path, encoding) => {
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const file = files.get(path);
    if (file === undefined) throw enoent('open', path);
    if (typeof encoding === 'string' && encoding !== 'utf8' && encoding !== 'utf-8') {
      throw new Error(`node:fs: readFileSync encoding '${encoding}' — supported: utf8, buffer`);
    }
    if (encoding === undefined || encoding === null || encoding === 'buffer') {
      return DshBuffer.fromBytes(file.bytes);
    }
    return decodeUtf8(file.bytes);
  }
  return refuse('readFileSync')();
};

export const statSync = (path) => {
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const file = files.get(path);
    if (file === undefined) throw enoent('stat', path);
    return {
      isFile: () => true,
      isDirectory: () => false,
      size: file.bytes.length,
      mtimeMs: file.mtimeMs,
    };
  }
  return refuse('statSync')();
};

export const accessSync = refuse('accessSync');
export const realpathSync = Object.assign(refuse('realpathSync'), {
  native: refuse('realpathSync.native'),
});
export const lstatSync = refuse('lstatSync');
export const writeFileSync = refuse('writeFileSync');
export const mkdirSync = refuse('mkdirSync');
export const rmSync = refuse('rmSync');
export const readdirSync = refuse('readdirSync');

export default {
  constants,
  WEB_PLUGINS_ROOT,
  seedWebPlugins,
  mergeWebPlugins,
  existsSync,
  readFileSync,
  statSync,
  accessSync,
  realpathSync,
  lstatSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
};
