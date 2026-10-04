// dsh:logging-exempt (shim layer; state plumbing, no logging surface)
/**
 * shims/fs-workspace-write.js — the MUTATION faces of the writable workspace
 * VFS (mkdir/write/rm/rename/link/chmod/utimes/symlink and their real-disk
 * mirrors), split out of fs-workspace.js when that file crossed the
 * code-size budget. The world model (workspace state, clock, watch registry)
 * stays in fs-workspace.js — the imports back are call-time-only (ESM-cycle
 * safe), and every consumer keeps importing through the fs-workspace.js
 * specifier, which re-exports these faces.
 */
import {
  workspace,
  wsAt,
  lexical,
  DIR_MODE,
  bumpClock,
  wsCreateFile,
  wsIsDirAt,
  wsEnoent,
  wsEexist,
  wsEnotdir,
  notifyWatches,
  systemTmp,
  resolveSymlinkAt,
} from 'upstream/shims/fs-workspace.js';
// The write-permission gate lives with the rename/link faces (it shipped
// in the same W4-N round); single definition, both modules import it.
import { wsRequireDirWrite } from 'upstream/shims/fs-workspace-rename.js';
import { wsRootHint } from 'upstream/shims/fs-paths.js';

/** Create the missing chain for recursive mkdir (module level for size):
 * the segments under the root, real-disk mirrored (W6-U r3) —
 * __dshProcMkdirReal is mkdir -p, so nested walks resolve in one call;
 * best-effort like its siblings. */
const mkdirSegments = (state, canonical, options) => {
  const segs = options.recursive === true
    ? (canonical === state.root
      ? [canonical]
      : canonical.slice(state.root.length).split('/').filter(Boolean)
          .map((seg, index, all) => `${state.root}${'/' + all.slice(0, index + 1).join('/')}`))
    : [canonical];
  let first;
  for (const dir of segs) {
    if (state.files.has(dir)) {
      if (options.recursive === true) continue;
      throw wsEexist('mkdir', dir);
    }
    if (!state.dirs.has(dir)) {
      state.dirIno.set(dir, state.nextIno++);
      state.dirs.add(dir);
      if (typeof options.mode === 'number' && dir === canonical) state.dirModes.set(dir, options.mode);
      first = first ?? dir;
      try {
        if (typeof dir === 'string' && dir.startsWith('/')) {
          globalThis.__dshProcMkdirReal?.(dir);
        }
      } catch { /* structural mirror is best-effort */ }
    }
  }
  return first;
};

export const wsMkdir = (path, options = {}) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.mkdir: path outside the writable workspace root: ${path}${wsRootHint(path)}`);
  }
  const { state } = at;
  const canonical = wsResolveSymlinkChain(state, at.path);
  // A read-only ancestor refuses directory creation (EACCES).
  wsRequireDirWrite(state, canonical, 'mkdir');
  if (state.files.has(canonical)) {
    if (options.recursive === true) return undefined;
    throw wsEexist('mkdir', canonical);
  }
  if (options.recursive !== true && (state.dirs.has(canonical) || wsIsDirAt(canonical))) {
    throw wsEexist('mkdir', canonical);
  }
  // node: WITHOUT recursive, mkdir creates exactly ONE segment and the
  // PARENT must already exist (missing parent = ENOENT — the browse picker's
  // createDirectory maps that to directory-create-failed; the VFS's implied
  // parents made it silently succeed, R3-G1 2026-09-28). Recursive walks the
  // missing chain like node's mkdirp.
  const parent = canonical.slice(0, canonical.lastIndexOf('/'));
  const parentOk = parent === state.root || state.dirs.has(parent) || wsIsDirAt(parent);
  if (options.recursive !== true && !parentOk) throw wsEnoent('mkdir', canonical);
  return mkdirSegments(state, canonical, options);
};

/** A written `.js`/`.mjs` registers as a runtime-defined module under its
 * `file:` URL — the __dshModuleDefine seam the host loader consults FIRST
 * (R3-G1, 2026-09-28). The vendored cordis loader chain imports composition
 * rows by dynamic `import('file:///…')` (boot__cmdline's spec, the bundle
 * startup specs, and cordis-plugin-include all write a plugin file into the
 * workspace at test time and hand its pathToFileURL to the loader); without
 * this registration the host has no such module and every entry fails
 * "cannot load module 'file:///…'". Mirrors fs.js defineSeededModule for the
 * WRITABLE half (that one serves the seeded read-only view). Both spellings
 * register: the caller's lexical spelling (a hardcoded `/tmp/...` maps onto
 * the container tmp via systemTmp, so the importer's URL keeps the `/tmp`
 * prefix) and the workspace-canonical one. Idempotent: define() replaces. */
const defineWrittenModule = (callerPath, canonical, bytes) => {
  if (!/\.(js|mjs)$/.test(canonical)) return;
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') return;
  let text;
  try {
    text = new TextDecoder().decode(bytes);
  } catch {
    return; // non-UTF-8 bytes are never a servable module
  }
  const lexicalCaller = lexical(callerPath);
  define.call(globalThis, `file://${canonical}`, text);
  if (lexicalCaller !== canonical) define.call(globalThis, `file://${lexicalCaller}`, text);
};

/** Resolve the DEEPEST symlinked-ancestor chain of a canonical workspace
 * path into the target spelling (the same walk fs.js's resolveWorkspaceSymlink
 * does — kept here because fs.js imports this module and a reverse import
 * would cycle). MUTATIONS canonicalize through it: node resolves every
 * symlinked path prefix, so a write through a configured symlink root must
 * land in the TARGET's directory — the spill symlink-alias test saves
 * through the alias and reads back at the realpath (W4-N, 2026-09-28). */
export const wsResolveSymlinkChain = (state, canonical) => {
  if (state.symlinks === undefined || state.symlinks.size === 0) return canonical;
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
  return hit && resolved !== canonical ? resolved : canonical;
};

/** Write file bytes (create or replace). Parents must already exist — the
 * fs-local write path always mkdirs them first, and node's writeFile would
 * ENOENT too. */
export const wsWriteFile = (path, bytes, mode) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.writeFile: path outside the writable workspace root: ${path}${wsRootHint(path)}`);
  }
  const { state } = at;
  const canonical = wsResolveSymlinkChain(state, at.path);
  // A read-only ancestor directory refuses the create/replace (EACCES — the
  // settings-file concurrency spec's non-contention lock test, W4-N).
  wsRequireDirWrite(state, canonical, 'open');
  // A FILE occupying an ancestor segment is ENOTDIR, like node's open(2)
  // (measured 2026-09-28: identity's anonymous-user-id writes INTO a
  // file-path home and expects the write refused so nothing persists). Every
  // PROPER ancestor prefix checks — including the parent (the final slash's
  // slice) — while the full path itself never does, so overwriting an
  // existing file stays the replace flow.
  let ancestorEnd = canonical.indexOf('/', state.root.length + 1);
  while (ancestorEnd > 0) {
    if (state.files.has(canonical.slice(0, ancestorEnd))) throw wsEnotdir('open', canonical);
    const next = canonical.indexOf('/', ancestorEnd + 1);
    if (next <= 0) break;
    ancestorEnd = next;
  }
  // A directory occupying the path is EISDIR, like node's writeFile
  // (measured 2026-09-27: storage-json makes the publish target a directory
  // to force the atomic-replacement failure its rollback test needs).
  if (state.dirs.has(canonical) || (state.files.has(canonical) === false && wsIsDirAt(canonical))) {
    const error = new Error(`EISDIR: illegal operation on a directory, open '${canonical}'`);
    error.code = 'EISDIR';
    error.errno = -21;
    error.syscall = 'open';
    error.path = canonical;
    throw error;
  }
  const existing = state.files.get(canonical);
  if (existing !== undefined) {
    existing.bytes = bytes;
    existing.mtimeNs = bumpClock(state);
    if (typeof mode === 'number') existing.mode = mode;
    defineWrittenModule(path, canonical, bytes);
    notifyWatches(canonical);
    wsMirrorWriteReal(canonical, bytes);
    return canonical;
  }
  wsCreateFile(state, canonical, bytes, mode);
  defineWrittenModule(path, canonical, bytes);
  notifyWatches(canonical);
  wsMirrorWriteReal(canonical, bytes);
  return canonical;
};

/** Real-disk write-through (W6-U, 2026-09-28) — every write face funnels
 * through wsWriteFile, so the mirror lives here: the mounted workspace root
 * IS a real directory on the desktop spike (the profile container's tmp),
 * and the subprocess seam's children read THAT disk. A successful VFS write
 * mirrors byte-identically onto it (parents mkdir -p'd, idempotent).
 * Best-effort by design — the VFS stays the world of record; the mirror
 * only feeds the seam's children. 8 MB cap: suite payloads are tiny and a
 * runaway mirror should fail loudly on the C side, not here. */
const wsMirrorWriteReal = (canonical, bytes) => {
  try {
    if (typeof canonical === 'string' && canonical.startsWith('/')
        && bytes.length <= 8 * 1024 * 1024) {
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      globalThis.__dshProcWriteFileReal?.(canonical, btoa(bin));
    }
  } catch { /* structural mirror is best-effort */ }
};

/** Real-disk mode mirror (W6-U r3, 2026-09-27) — the chmod sibling of the
 * write/rm mirrors: a VFS chmod(+x) on a mirrored path must land on the disk
 * the subprocess seam's children read (hook scripts run through real bash;
 * a virtual-only mode is "Permission denied" there). Best-effort like its
 * siblings; the VFS mode stays the world of record. */
export const wsMirrorChmodReal = (canonical, mode) => {
  try {
    if (typeof canonical === 'string' && canonical.startsWith('/') && typeof mode === 'number') {
      globalThis.__dshProcChmodReal?.(canonical, mode & 0o7777);
    }
  } catch { /* structural mirror is best-effort */ }
};

/** Plain rmdir (module level for size): succeeds ONLY on an empty directory
 * — any tracked file or subdir below it is ENOTEMPTY (W3-K, 2026-09-28: the
 * spill-local sweep rmdirs emptied session dirs; demanding recursive here
 * made every plain rmdir throw and left the dir entry alive, so the prune
 * assertions saw existsSync true). */
const rmDirPlain = (state, canonical) => {
  const prefix = `${canonical}/`;
  const hasChildren = [...state.files.keys()].some((k) => k.startsWith(prefix))
    || [...state.dirs].some((k) => k.startsWith(prefix));
  if (hasChildren) {
    const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${canonical}'`);
    error.code = 'ENOTEMPTY';
    error.syscall = 'rmdir';
    error.path = canonical;
    throw error;
  }
  if (canonical !== state.root) {
    state.dirs.delete(canonical);
    state.dirIno.delete(canonical);
    state.dirModes?.delete(canonical);
    notifyWatches(canonical);
    wsMirrorRmReal(canonical, false);
  }
};

/** Recursive rm (module level for size): sweep files, subdirs, and symlink
 * registrations below the target (node: rm -rf removes links, not their
 * targets — W6-V, same stale-link EEXIST as the plain unlink case). */
const rmDirRecursive = (state, canonical) => {
  const prefix = `${canonical}/`;
  for (const key of [...state.files.keys()]) {
    if (key.startsWith(prefix)) state.files.delete(key);
  }
  for (const dir of [...state.dirs]) {
    if (dir.startsWith(prefix)) {
      state.dirs.delete(dir);
      state.dirIno.delete(dir);
      state.dirModes?.delete(dir);
    }
  }
  for (const link of [...state.symlinks.keys()]) {
    if (link.startsWith(prefix)) state.symlinks.delete(link);
  }
  if (canonical !== state.root) {
    state.dirs.delete(canonical);
    state.dirIno.delete(canonical);
    state.dirModes?.delete(canonical);
  }
  notifyWatches(canonical);
  wsMirrorRmReal(canonical, true);
};

/** Remove a file or a directory subtree. `force` swallows ENOENT (node). */
export const wsRm = (path, options = {}) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.rm: path outside the writable workspace root: ${path}${wsRootHint(path)}`);
  }
  const { state } = at;
  // Symlink removal (W6-V): unlink NEVER follows the link — check the
  // literal path BEFORE the canonical chain resolution (which rewrites the
  // path to the link's TARGET and would delete the target file while
  // leaving the registration, so a removed-and-recreated link — the
  // skill-filesystem replacement flow — hit EEXIST forever).
  if (state.symlinks.has(at.path)) {
    wsRequireDirWrite(state, at.path, 'unlink');
    state.symlinks.delete(at.path);
    notifyWatches(at.path);
    wsMirrorRmReal(at.path, false);
    return;
  }
  const canonical = wsResolveSymlinkChain(state, at.path);
  // Removal needs write on the containing directory (POSIX unlink/rmdir).
  wsRequireDirWrite(state, canonical, state.files.has(canonical) ? 'unlink' : 'rmdir');
  if (state.files.has(canonical)) {
    state.files.delete(canonical);
    notifyWatches(canonical);
    wsMirrorRmReal(canonical, false);
    return;
  }
  if (state.dirs.has(canonical)) {
    if (options.recursive !== true) return rmDirPlain(state, canonical);
    return rmDirRecursive(state, canonical);
  }
  if (wsIsDirAt(canonical) && options.force === true) {
    // An implicit directory (children-only existence) can only vanish by
    // removing its children; force swallows that impossibility (node rm -f).
    return;
  }
  if (options.force !== true) throw wsEnoent('rm', canonical);
};

/** Real-disk removal mirror (W6-U, 2026-09-28): the write-through's twin.
 * A file or subtree the seam's children could have read must not survive
 * as a zombie once the VFS removed it. Best-effort, like the write side. */
const wsMirrorRmReal = (canonical, recursive) => {
  try {
    if (typeof canonical === 'string' && canonical.startsWith('/')) {
      globalThis.__dshProcRmReal?.(canonical, recursive === true);
    }
  } catch { /* structural mirror is best-effort */ }
};

/** Rename within the workspace (files; a directory rename moves its subtree). */
export const wsSymlink = (target, path) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.symlink: path outside the writable workspace root: ${path}${wsRootHint(path)}`);
  }
  const { state, path: canonical } = at;
  if (state.files.has(canonical) || state.dirs.has(canonical)
      || state.symlinks.has(canonical) || wsIsDirAt(canonical)) {
    throw wsEexist('symlink', canonical);
  }
  wsRequireDirWrite(state, canonical, 'symlink');
  if (typeof target !== 'string') {
    throw new TypeError(`node:fs.symlink: target must be a string, got ${typeof target}`);
  }
  state.symlinks.set(canonical, target);
  return undefined;
};

/** The stored target for a symlink path, or undefined when the path is not a
 * symlink (readlink turns that into EINVAL, node's spelling). */
