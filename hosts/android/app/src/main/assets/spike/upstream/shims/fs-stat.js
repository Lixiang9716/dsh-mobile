// dsh:logging-exempt (shim layer)
/**
 * shims/fs-stat.js — node:fs's statSync/lstatSync/accessSync (plus the
 * seeded-VFS and real-disk stat arms), split out of fs.js when that file
 * crossed the code-size budget. Symlink resolution comes from fs-paths.js;
 * references back into fs.js are call-time only (ESM-cycle safe).
 */
import {
  lexical,
  DIR_MODE,
  statFace,
  wsAt,
  wsStatAt,
  wsFileAt,
  wsIsDirAt,
} from 'upstream/shims/fs-workspace.js';
import { underVFS, vfs, enoent, constants, readAnyBytes, asFsPath } from 'upstream/shims/fs.js';
import { resolveWorkspaceSymlink, workspaceSymlinkTarget, vfsRealpath } from 'upstream/shims/fs-paths.js';
import { vfsReaddir } from 'upstream/shims/fs-readdir.js';

const statSeededVfs = (path, files, bigint) => {
  const seeded = files.get(path);
  if (seeded !== undefined) {
    return statFace('file', {
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
    });
  }
  const names = vfsReaddir(path);
  if (names !== null) {
    return statFace('dir', {
      size: bigint ? 0n : 0,
      mode: DIR_MODE,
      mtimeMs: 0,
      ...(bigint ? { dev: 1n, ino: 0n, mode: BigInt(DIR_MODE), mtimeNs: 0n, ctimeNs: 0n } : {}),
    });
  }
  throw enoent('stat', path);
};

/** The real-disk stat fallback (module level for size; W5-R, 2026-09-28):
 * the subprocess seam's consumers stat REAL binaries (the vendored
 * pre-spawn executability check stats the node that runs the fixture
 * servers — a path no VFS face knows). VFS-first precedence is preserved:
 * callers run this only after every workspace/seeded face missed, and only
 * for absolute paths. It must answer BEFORE the workspace ENOENT
 * short-circuit (W6-V, 2026-09-28): real children (the sqlite seam) create
 * sidecar files (-wal/-journal) inside VFS-known workspace directories, and
 * a stat through the workspace view would ENOENT them before the fallback
 * was consulted. */
const statRealFallback = (path, options) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const map = globalThis.__dshFlatPathMap;
  const mapped = typeof map === 'function' ? map(path) : undefined;
  const real = globalThis.__dshProcStatReal?.(typeof mapped === 'string' ? mapped : path);
  if (!real) return null;
  const bigint = options.bigint === true;
  const isDir = real.isDirectory === true;
  return statFace(isDir ? 'dir' : 'file', {
    size: bigint ? BigInt(real.size) : real.size,
    dev: 1,
    ino: 0,
    mode: real.mode & 0o777,
    uid: 0,
    gid: 0,
    mtimeMs: real.mtimeMs,
    ...(bigint ? { dev: 1n, ino: 0n, mode: BigInt(real.mode & 0o777), mtimeNs: BigInt(real.mtimeMs) * 1000000n, ctimeNs: BigInt(real.mtimeMs) * 1000000n } : {}),
  });
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
    const mk = (m) => statFace('dir', {
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
  if (files !== null && underVFS(path)) return statSeededVfs(path, files, bigint);
  // A missing file INSIDE the pinned workspace is an ordinary ENOENT (the
  // vendored fs-local classifies absence by `error.code`), not a seam
  // refusal. The same in-world answer covers paths OUTSIDE every staged
  // view: this runtime's world is the workspace plus the seeded views, and
  // anything else does not exist IN it (R3-G1, 2026-09-28 — fs-sandbox's
  // containment walk stats candidate roots that were never staged and
  // classifies the ENOENT itself; the loud refusal broke that classification).
  const real = statRealFallback(path, options);
  if (real !== null) return real;
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
    return statFace('symlink', {
      size: bigint ? 0n : 0,
      mode: 0o777,
      mtimeMs: 0,
      ...(bigint ? { dev: 1n, ino: 0n, mode: 0o120777n & 0o777n, mtimeNs: 0n, ctimeNs: 0n } : {}),
    });
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
export const realpathSyncImpl = (path) => vfsRealpath(path);
export const realpathSync = Object.assign(realpathSyncImpl, {
  native: realpathSyncImpl,
});
// The file-watch surface, linked by @deepseek-ai/dsh-skill-filesystem
// (`import { unwatchFile, watchFile } from "node:fs"`). Binding-only stubs:
// they are reached only from its watcher manager, and the mobile profile
// mounts that package with watch:false — the runtime has no fs-event seam
// (the same staged gap as the timers). A call here means a watch:true mount
// slipped through, so it fails loud naming the package's own remedy.

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
  // Paths THROUGH a workspace symlink (readFileSync canonicalizes them;
  // existsSync must agree or fs-promises readFile's existsSync gate hides
  // real target files — W6-V measured: '<skills>/linked-dir/SKILL.md'
  // through a real dir symlink read fine via readFileSync but fs-promises
  // readFile short-circuited ENOENT on this gate).
  if (typeof path === 'string' && path.startsWith('/')) {
    const resolvedPath = resolveWorkspaceSymlink(lexical(path));
    if (resolvedPath !== path) {
      if (wsFileAt(resolvedPath) !== undefined || wsIsDirAt(resolvedPath)) return true;
    }
  }
  if (nodeModulesProbe(path)) return true;
  // Real-disk fallback (W6-V, 2026-09-28): files created behind the VFS by
  // real children (the sqlite seam's -wal/-journal sidecars) exist and the
  // vendored existence checks must agree with stat's fallback. VFS-first
  // precedence: every staged/workspace face is consulted above. The flat-path
  // map re-roots bundle-relative paths at the real checkout first.
  if (typeof path === 'string' && path.startsWith('/')) {
    const map = globalThis.__dshFlatPathMap;
    const mapped = typeof map === 'function' ? map(path) : undefined;
    try {
      const real = globalThis.__dshProcStatReal?.(typeof mapped === 'string' ? mapped : path);
      return real?.isFile === true || real?.isDirectory === true;
    } catch {
      return false;
    }
  }
  return false;
};
