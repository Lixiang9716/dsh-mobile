# Agent Note: the mobile fs views' outside-root refusals teach the workspace anchor — one error carries the root and the corrected spelling (loop-h)

Status: implemented
Related: D9

## Problem

Creation rounds burned steps on path guessing: the model's file-tool calls
were refused twice before any work happened — first by the vendored
editor's relative-path throw ("The path plugins is not an absolute path…
Maybe you meant /plugins?"), then by the mobile fs views' outside-root
refusal for the DEVICE-root spelling the suggestion produces
("/plugins is outside the writable workspace root"). The second refusal
was true and useless: it named the violated boundary but not the boundary
itself, so the model could not construct the one spelling that works.
Recovered only by trial (tester r1 trajectory; same listing/path confusion
in the battery rounds — loop-h, the wasted-steps family of loop-p).

## Decision

The nine outside-root refusal sites of the fs shim family (mkdir/writeFile/
rm/symlink in fs-workspace-write.js; rename/link/chmod/utimes in
fs-workspace-rename.js; the every-staged-view read refusal in fs-paths.js)
now append a hint through one shared helper, `wsRootHint(path)` in
fs-workspace.js: `— the writable workspace root is '<root>'; file paths
must be absolute under it (maybe you meant '<root>/<path>'?)`. The remedy
mirrors the vendored tool's own suggestion tone, but anchors the model's
INTENDED path under the root instead of at the device root — the next call
is copy-paste correct. Unmounted-worktree calls degrade to the generic
refusal (empty hint). The asserted substring `outside the writable
workspace root` (tool-fs-probe's boundary check) is unchanged; error CODES
are unchanged — this is message enrichment, not semantics.

## Verification

`test/panel/fs-readdir-real-fallback.test.js` gains two cases: the
outside-root write refusal contains the mounted root AND the anchored
remedy spelling `'<root>/plugins/thing.js'`; the mkdir refusal carries the
same anchor. Panel suite: 190 passed (14 files).

## Alternatives considered

- Remapping absolute paths into the workspace inside the fs views (treat
  `/x` as `<root>/x` silently): rejected — it changes the boundary
  semantics the views exist to enforce, and silently redirecting a path
  the model spelled as a device absolute can mask real intent (a path that
  WAS meant as a device location would land inside the workspace without a
  word).
- Editing the vendored tool's suggestion to suggest the workspace root:
  rejected — D6, the tarball bytes are pinned; the views' refusals are
  this repo's own surface and are the LAST error the model sees before
  retrying, which is the one that has to teach.
- A system-prompt line declaring the workspace root: deferred — the root
  is runtime-per-device while the persona is static; the per-error hint
  carries the live root exactly where the model is already looking.
