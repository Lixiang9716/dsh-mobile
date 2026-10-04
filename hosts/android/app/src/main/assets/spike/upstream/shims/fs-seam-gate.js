// dsh:logging-exempt (shim layer; state plumbing, no logging surface)
/**
 * upstream/shims/fs-seam-gate.js — the REAL-DISK SEAM's containment gate
 * (loop-r): one predicate + one refusal shape shared by every real-disk
 * read fallback (fs.js readRealBytes, fs-promises.js readFile, fs-readdir.js
 * readdirRealFallback). Split from fs-workspace.js at the code-size gate;
 * the module body only defines call-time functions (no eval-time reads of
 * the workspace bindings), so the one-way import edge adds no cycle risk —
 * the constraint the wsRootHint move documents (fs-workspace.js).
 */
import { workspace, wsAt, wsRootHint } from 'upstream/shims/fs-workspace.js';

/** Whether the real-disk seam may answer this canonical path (loop-r): only
 * paths INSIDE the pinned workspace root — the same containment wsAt draws,
 * systemTmp translation included. The C host's __dshProc{Stat,Read,Readdir}Real
 * seam exists for the mirrored/persisted trees UNDER the root (loop-p); an
 * outside-root absolute path has no served twin, and letting the seam answer
 * it from the host disk left the model seat's fs scope with no observable
 * boundary (the 2026-10-04 battery read the app-private profile tree and
 * /system/app through the unbounded fallbacks). Callers pass the lexical
 * canonical spelling; wsAt applies the systemTmp map itself. */
export const realSeamInsideRoot = (canonical) => wsAt(canonical) !== null;

/** The #358-shaped outside-root refusal for the read faces (loop-r): the
 * outsideEveryView message family (fs-paths.js cannot be imported there from
 * here — same cycle constraint as wsRootHint) plus the wsRootHint anchor.
 * Code EACCES like the write refusals; the hint degrades to '' when no
 * workspace is mounted so the refusal never masks itself with a mount
 * error. */
export const wsOutsideRootError = (call, path) => {
  const state = workspace();
  const hint = state !== null ? wsRootHint(path) : '';
  const error = new Error(
    `node:fs.${call}: path '${path}' is outside the writable workspace root and every staged read-only view `
    + `— the fs backends on this host serve exactly one pinned workspace (mountWorkspace) `
    + `plus the seeded views (see runtime/spike/upstream/README.md, FILE-TOOLS row)${hint}`);
  error.code = 'EACCES';
  error.errno = -13;
  error.syscall = call;
  error.path = path;
  return error;
};
