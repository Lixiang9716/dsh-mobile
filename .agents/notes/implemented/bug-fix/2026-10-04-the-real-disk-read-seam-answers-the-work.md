# Agent Note: the real-disk read seam answers the workspace root only — the model seat's fs scope has an outside again

Status: implemented

## Problem

#358 (loop-h) taught every mobile fs view's outside-root refusal the workspace
anchor, and #356 (loop-p) gave the model's `str_replace_editor` view of REAL
workspace directories a working readdir seam. The 2026-10-04 battery round
then proved on device that the model's file tools never reach either: asked
for `/data/data/com.dshmobile.spike/files/profiles`, the seat listed the whole
profile tree in 4 tool calls — the staged llm config (the user's API key)
included in the walk; a boundary probe of `/system/app` returned a real
listing of 24 system app directories in one call. No refusal, no anchor,
nothing was outside-root in practice.

The chains (all through the vendored fs-local backend → node:fs shims):
listing = `str_replace_editor view` → `ctx.fs.listDir` → `readdir` →
`readdirSync` → `readdirRealFallback` (fs-readdir.js), which consulted the C
host's `__dshProcStatReal`/`__dshProcReaddirReal` seam for EVERY absolute
path; reading = tool-fs `read` → fs-local `readText` → `readFile`/`readFileSync`,
whose real-disk arms (`__dshProcReadReal` in fs-promises.js readFile,
`readRealBytes` in fs.js) likewise answered any absolute path the host disk
held — both BEFORE the refusal arms #358 had taught. The seams exist for the
mirrored/persisted trees UNDER the pinned workspace root (loop-p, W5-R
marker files); nothing bounded them to that root.

## Decision

The real-disk READ seam now answers the pinned workspace root only, one
containment predicate shared by all three fallbacks (`realSeamInsideRoot`,
fs-workspace.js — the wsAt containment, systemTmp translation included):

- fs-readdir.js: `readdirRealFallback` declines outside-root paths. When the
  host disk actually holds the directory (what used to be listed verbatim),
  readdirSync throws the #358 anchor refusal — the root and a
  `maybe you meant '<root>/…'` spelling — with the error CODE dropped:
  fs-local's listingIoError rewrites ENOENT to "not found" and EACCES to
  "permission denied", so only a codeless error rides the generic IO_ERROR
  arm that carries the message to the model. Where even the host declines,
  absence stays node-ENOENT (message gains the hint) — the discovery-walk
  code contract (isAbsentSkillPathError) is untouched.
- fs-promises.js readFile: the W5-R `__dshProcReadReal` arm refuses
  outside-root paths with the anchor before touching the seam; inside-root
  marker reads are unchanged. The raw rejection rides fs-local's
  readFileAbortable verbatim, so the anchor reaches the model seat.
- fs.js: `readRealBytes`'s raw absolute arm declines outside-root paths (the
  leg's flat-map re-roots keep flowing — a mapped path is the suite's own
  declared staging surface, not a model-reachable spelling), and both read
  tails (`readFileSync`, `readAnyBytes`) answer the #358 anchor refusal
  (`wsOutsideRootError`) instead of the old desktop-host "no synchronous
  filesystem" text the seam had made unreachable anyway.

Deliberately NOT bounded: `statRealFallback`/`existsSync`/`vfsRealpath`'s
real arms — they carry metadata only, and the vendored subprocess-local
`resolveExecutable` stats `process.execPath` (outside any root) through
statRealFallback when it resolves the pre-spawn executable; bounding stat
would break the upstream subprocess contract for no content-level gain.

Panel: 7 new cases in fs-readdir-real-fallback.test.js — inside-root real
listings still served (the S3/loop-p baseline), the /system-app shape and
the sibling-branch llm-config shape refuse with the anchor (bytes never in
any message), the promise readFile arm refuses a seam-served outside path
while still serving the W5-R marker inside the root, and outside-root
absence stays ENOENT. Suite 202/202. Closures synced (android + harmony).

## Alternatives considered

- Bound at the C host (`__dshProc*Real` refuse outside the granted scope
  root): fixes the device but not the desktop CLI seats, and the seams'
  legitimate consumers (the leg's own staging code reads vendored trees
  through the globals directly) would need C-side root plumbing the host
  does not have. The JS shim is where the served views' boundary belongs
  and where #356/#358 already live.
- One blanket bound on every real arm (stat/exists/realpath included):
  strongest reading of "nothing outside the root answers", but it breaks
  the vendored subprocess PATH resolution (stat of execPath) and buys only
  metadata hiding — the tool face's observable answers (listings, contents)
  are already fully refused without it. Recorded here so the owner can flip
  it deliberately if the metadata leak ever matters.
- Refuse in the vendored tool packages or fs-local instead of the shims:
  upstream is pinned (D6) — no vendored edits — and fs-local is one caller;
  the bypass lived in the shared shim faces every seat bundles.
