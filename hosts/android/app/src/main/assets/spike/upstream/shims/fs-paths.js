// dsh:logging-exempt (shim layer)
/**
 * shims/fs-paths.js — the node:fs symlink/realpath machinery, split out of
 * fs.js when that file crossed the code-size budget. The core read faces
 * (fs.js) and the stat faces (fs-stat.js) import the symlink resolution from
 * here; the world model stays in fs-workspace.js — call-time-only references
 * back into fs.js keep the ESM cycle safe (no eval-time touches).
 */
import {
  lexical,
  workspace,
  wsAt,
  wsFileAt,
  wsIsDirAt,
  wsReadlinkAt,
  resolveSymlinkAt,
} from 'upstream/shims/fs-workspace.js';
import { DshBuffer } from 'upstream/shims/buffer.js';

/** The refusal suffix that teaches the anchor (loop-h): an outside-root
 * path is recoverable in one step when the refusal names the root and the
 * correct spelling — the model otherwise guesses device-root spellings
 * ('/plugins') and burns steps on refusals. Empty when no workspace is
 * mounted (the generic refusal stands). Split here from fs-workspace.js at
 * the file-size gate; the write/rename refusal sites are its consumers. */
export const wsRootHint = (path) => {
  const state = workspace();
  if (state === null) return '';
  const root = state.root;
  const anchored = typeof path === 'string' && path.startsWith('/')
    ? `${root}${path.replace(/\/+$/, '')}`
    : `${root}/file.txt`;
  return ` — the writable workspace root is '${root}'; file paths must be absolute under it (maybe you meant '${anchored}'?)`;
};
import { underVFS, vfs, enoent, readAnyBytes } from 'upstream/shims/fs.js';

export const resolveWorkspaceSymlink = (path) => {
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
export const workspaceSymlinkTarget = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  return wsReadlinkAt(lexical(path));
};

const outsideEveryView = (path) => {
  const error = new Error(
    `node:fs: path '${path}' is outside the writable workspace root and every staged read-only view `
    + `— the fs backends on this host serve exactly one pinned workspace (mountWorkspace) `
    + `plus the seeded views (see runtime/spike/upstream/README.md, FILE-TOOLS row)${wsRootHint(path)}`);
  error.code = 'EACCES';
  error.path = path;
  return error;
};

/** The canonical spelling of an existing staged/workspace path; ENOENT
 * otherwise. Workspace paths resolve ONE symlink hop first (the realpath
 * contract; the seeded views carry no symlinks) — which is what the vendored
 * fs-local uses as its stable target key. */
export const vfsRealpath = (path) => {
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
    // Real-disk fallback (W6-V, 2026-09-28): REAL directories/files the leg
    // staged or children created have no canonical form beyond their own
    // lexical path (the C seam's stat already passed for statSync) — answer
    // the canonical spelling instead of ENOENT/OUTSIDE-EVERY-VIEW so the
    // vendored realPath-canonicalization walks (typert analyzer) proceed.
    const map = globalThis.__dshFlatPathMap;
    const mapped = typeof map === 'function' ? map(canonical) : undefined;
    const real = globalThis.__dshProcStatReal?.(typeof mapped === 'string' ? mapped : canonical);
    if (real?.isFile === true || real?.isDirectory === true) return canonical;
    throw outsideEveryView(canonical);
  }
  // The workspace view knows an ANCESTOR but not this entry (the real-only
  // children case above) — same real-disk answer before the ENOENT.
  {
    const real = globalThis.__dshProcStatReal?.(canonical);
    if (real?.isFile === true || real?.isDirectory === true) return canonical;
  }
  throw enoent('realpath', canonical);
};

export const realpathCallback = (path, callback) => {
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
export const realpath = realpathCallback;
