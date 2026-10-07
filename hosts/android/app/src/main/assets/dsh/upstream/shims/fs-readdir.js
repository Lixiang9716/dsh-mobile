// dsh:logging-exempt (shim layer)
/**
 * shims/fs-readdir.js — node:fs's readdirSync and the directory-name
 * machinery under it, split out of fs.js when that file crossed the
 * code-size budget. fs-stat.js imports vfsReaddir for the seeded-directory
 * stat arm; references back into fs.js are call-time only (ESM-cycle safe).
 */
import {
  lexical,
  wsAt,
  wsEnotdir,
  wsFileAt,
  wsReaddirAt,
  wsRootHint,
} from 'upstream/shims/fs-workspace.js';
// loop-r: the real-disk seam's containment gate + the #358 read refusal
// (split from fs-workspace.js at the code-size gate; call-time functions
// only — no new cycle risk).
import { realSeamInsideRoot, wsOutsideRootError } from 'upstream/shims/fs-seam-gate.js';
import { underVFS, vfs, enoent, statSync } from 'upstream/shims/fs.js';
import { resolveWorkspaceSymlink } from 'upstream/shims/fs-paths.js';

export const vfsReaddir = (path) => {
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

/** The Dirent face for `readdirSync(…, { withFileTypes: true })` — lstat
 * classes each child (the fs-promises readdir face's identical direntFor);
 * an unstatable child reads file-like, like the async face. */
const direntFor = (name, path) => {
  let info;
  try {
    info = statSync(path);
  } catch {
    info = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  }
  return {
    name,
    isDirectory: info.isDirectory,
    isFile: info.isFile,
    isSymbolicLink: info.isSymbolicLink,
  };
};

/** Real-disk readdir (W6-V): the staged fixtures trees (upstream-suite-leg
 * materializes them for cwd-joined joins) and real children's directories
 * are REAL directories the served views cannot list. Sync face over the
 * subprocess seam's find; the namespace loads async at module eval and is
 * cached by the time any spec walk runs (desktop hosts; elsewhere null). */
let realFsChildProcess = null;
import('node:child_process').then((ns) => { realFsChildProcess = ns; }).catch(() => { /* inert */ });
const realReaddirNames = (realDir) => {
  // The suite leg pins the namespace early (preloadRealFs) because spec
  // module bodies walk fixtures before any job drain; the lazy import here
  // covers non-leg consumers.
  const spawnSync = realFsChildProcess?.spawnSync ?? globalThis.__dshChildProcessNs?.spawnSync;
  if (typeof spawnSync !== 'function') return null;
  const res = spawnSync('find', [realDir, '-maxdepth', '1', '-mindepth', '1']);
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  const prefix = realDir.endsWith('/') ? realDir : `${realDir}/`;
  return [...new Set(res.stdout.split('\n').filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length)))].sort();
};

/** The name-list shaping shared by every readdir arm (module level for
 * size): plain names, or Dirent faces over `base/name` paths. */
const listNames = (names, basePath, withFileTypes) => {
  if (withFileTypes === true) {
    const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
    return names.map((name) => direntFor(name, `${prefix}${name}`));
  }
  return names;
};

/** The real directory names at `canonical` when the real-disk seam sees a
 * directory there, else null. The C host's seam (names only, "."/".."
 * skipped) is the device face; the subprocess seam's find covers the suite
 * leg. Sorted; the callers union/shape. */
const realDirNames = (canonical) => {
  const real = globalThis.__dshProcStatReal?.(canonical);
  if (real?.isDirectory !== true) return null;
  const names = globalThis.__dshProcReaddirReal?.(canonical)
    ?? realReaddirNames(canonical);
  if (names === null || !Array.isArray(names)) return null;
  return [...new Set(names)].sort();
};

/** The real-disk readdir fallback (module level for size; W6-V): a REAL
 * directory (the leg's staged fixtures tree, a child's scratch dir, a
 * write-through-mirrored plugin tree) lists through the C host's readdir
 * seam when mounted (every device seat, loop-p: the model's view of a real
 * workspace directory answered not-found because this fallback needed the
 * desktop-only subprocess namespace), else through the subprocess seam's
 * find (the suite leg pins the namespace early).
 * loop-r: the seam answers the mirrored WORKSPACE only — outside-root
 * absolute paths decline here (the caller refuses with the anchor when the
 * host disk actually holds the directory, keeps node-absence otherwise). */
const readdirRealFallback = (canonical, options) => {
  if (typeof canonical !== 'string' || !canonical.startsWith('/')) return null;
  if (!realSeamInsideRoot(canonical)) return null;
  const names = realDirNames(canonical);
  if (names === null) return null;
  return listNames(names, canonical, options?.withFileTypes === true);
};

/** The readdir MISS answer for a path both served views declined (module
 * level for size). Inside the workspace root a miss is node-ENOENT; outside
 * it the answer depends on the HOST disk (loop-r): a directory the host
 * actually holds refuses with the #358 anchor — the code deliberately
 * dropped, because fs-local's listingIoError rewrites EACCES to a bare
 * 'permission denied' and ENOENT to 'not found', and only a codeless error
 * rides the generic IO_ERROR arm that carries the message to the model
 * (the discovery walks never scan outside their own pinned inside-root
 * lists, so the pass-through reaches only the tool face); where even the
 * host declines, absence stays the node ENOENT the vendored discovery walks
 * branch on (isAbsentSkillPathError accepts ENOENT/ENOTDIR and treats
 * anything else as a hard failure that poisons the whole observation —
 * `complete: false`, silently disabling the tool-skill durable catalog) —
 * the message keeps the runtime explanation plus the root hint. */
const readdirMiss = (canonical, insideWorkspace) => {
  if (insideWorkspace) return enoent('readdir', canonical);
  const realDir = globalThis.__dshProcStatReal?.(canonical);
  if (realDir?.isDirectory === true) {
    const refusal = wsOutsideRootError('readdir', canonical);
    delete refusal.code;
    delete refusal.errno;
    return refusal;
  }
  const absent = enoent('readdir', canonical);
  absent.message = `node:fs.readdirSync: no such directory in the dsh runtime's served views — ${absent.message}${wsRootHint(canonical)}`;
  return absent;
};

export const readdirSync = (path, options) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  // A symlinked directory entry reads through the link (node follows the hop
  // for readdir; measured 2026-09-27: the skill-filesystem suite publishes
  // skills linked as whole directories).
  const wsNames = wsReaddirAt(resolveWorkspaceSymlink(canonical));
  if (wsNames !== null) {
    // The served view is the world of record for its REGISTERED entries,
    // but the workspace root is a REAL directory: trees the write-through
    // mirror materialized — or a previous run persisted — exist on the disk
    // without registration, and the model's inventory must see them
    // (loop-p: `plugins/<name>` listed not-found while its files read
    // fine). Union, don't replace: registered entries the mirror has not
    // flushed (state-only rows) must survive the merge.
    const real = realDirNames(canonical);
    if (real === null) return listNames(wsNames, canonical, options?.withFileTypes === true);
    const merged = [...new Set([...wsNames, ...real])].sort();
    return listNames(merged, canonical, options?.withFileTypes === true);
  }
  const names = vfsReaddir(path);
  if (names !== null) {
    return listNames(names, typeof path === 'string' ? path : `${path}`, options?.withFileTypes === true);
  }
  // Inside the workspace root a miss is ENOENT/ENOTDIR — but only AFTER the
  // real-disk twin declines: the leg stages real fixture trees UNDER the
  // pinned profile root (the workspace root since W6-U's root pin), so the
  // old pre-real throw hid every staged real directory from sync listings
  // (W6-V: typert analyzer's fixture walks — stat saw the dir, readdir
  // ENOENT'd).
  const insideWorkspace = wsAt(canonical) !== null;
  if (insideWorkspace && wsFileAt(canonical) !== undefined) throw wsEnotdir('readdir', canonical);
  const real = readdirRealFallback(canonical, options);
  if (real !== null) return real;
  throw readdirMiss(canonical, insideWorkspace);
};
