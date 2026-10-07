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

/** The canonical spelling of an existing staged/workspace path; ENOENT
 * otherwise. Workspace paths resolve ONE symlink hop first (the realpath
 * contract; the seeded views carry no symlinks) — which is what the vendored
 * fs-local uses as its stable target key.
 *
 * loop-v2 (2026-10-05): the outside arm's seam-MISS throws node ENOENT, not
 * the anchor — an outside-root path the host does NOT hold is ABSENT, the
 * #373 absence symmetry the read faces already hold. The pre-fix anchor here
 * produced the field inversion the battery measured: the absent outside path
 * answered the full anchor (this face) while the EXISTING outside directory
 * answered a bare not-a-regular-file (the stat face's answer fell through to
 * tool-fs's own pre-check) — exactly backwards. fs-local's resolve
 * classifies this ENOENT and walks the ancestors, landing the caller on the
 * stat face, which now refuses what the host holds (fs-stat.js) and keeps
 * absence node-shaped. */
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
    // The answering arm is also what keeps fs-local's ENOENT ancestor walk
    // working when the walk's parent is an outside-root real directory.
    const map = globalThis.__dshFlatPathMap;
    const mapped = typeof map === 'function' ? map(canonical) : undefined;
    const real = globalThis.__dshProcStatReal?.(typeof mapped === 'string' ? mapped : canonical);
    if (real?.isFile === true || real?.isDirectory === true) return canonical;
    // loop-v2: the seam miss is ABSENCE — node ENOENT, not the anchor (see
    // the vfsRealpath docblock; the stat face anchors what the host holds).
    throw enoent('realpath', canonical);
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
