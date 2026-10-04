# Agent Note: the tool face's outside-root answers take the seam order — the stat face anchors what the host holds, absence stays ENOENT

Status: implemented
Related: D5 (contract-first capability honesty); the 2026-10-05 battery
round-14 w2 evidence (session-e6f656cb, release 318fb22e); builds on #373's
seam answer-shape symmetry and loop-r's seam containment

## Problem

The r14 battery measured the read tool on the emulator and found #373's
symmetry inverted on the MODEL's tool face while holding on the shim faces:

- (a) read of the EXISTING outside-root directory `/system/app` answered a
  bare `{FsError, FS_NOT_REGULAR_FILE}` `cannot read "/system/app": not a
  regular file` — no workspace root, no maybe-you-mean, no errno/syscall;
- (b) read of an ABSENT outside-root path answered the FULL #358 anchor
  (`outside the writable workspace root … maybe you meant …`) — where the
  promise-face contract (#373) says absence ENOENT.

Same `/system` prefix, opposite answers — exactly backwards.

The composition: the file tools (tool-fs `read`, str_replace_editor `view`)
call `ctx.fs.resolve` then `ctx.fs.stat` and only THEN their own
is-regular-file pre-check (vendored tool-fs lib/index.js:266-278, the
`info.type !== "file"` throw at :273; str_replace_editor's statExisting,
vendored tool-str-replace-editor lib/index.js:72-80). `ctx.fs` is the
vendored fs-local backend (boot.js mountFileTools: `service('fs',
'@deepseek-ai/dsh-fs-local', 'fs')`), whose `resolve` runs
`realpath.native` through the shim's `vfsRealpath` and whose `stat` runs
`node:fs/promises stat` through the shim's `statSync`. The pre-fix faces
answered those two calls inverted: `vfsRealpath`'s outside arm threw the
anchor for an ABSENT outside path (fs-local's `resolveLocalTarget` rethrows
non-ENOENT raw), while `statSync`'s real-disk fallback (`statRealFallback`)
ANSWERED an existing outside directory — the loop-r containment bounded the
READ fallbacks but never the stat face — so the tool's own pre-check turned
the directory answer into (a)'s bare shape, and (b) took the anchor at
realpath.

## Decision

The two shim faces now hold the seam order the read faces took in loop-r;
the vendored packages are untouched (D6):

- `fs-stat.js statSync`: when the real-disk seam ANSWERS an OUTSIDE-root
  path (`!realSeamInsideRoot(canonical)`), the face refuses with the #358
  anchor (`wsOutsideRootError('stat', …)`: EACCES, errno −13, syscall
  `stat`, root + maybe-you-mean) — BEFORE any caller's type check. A miss
  keeps the node-ENOENT arms. Inside the root the real answer stands
  unchanged (the W6-V real-only children: sqlite `-wal` sidecars et al.),
  and the protected-ancestor arm that answers the root's own ancestors is
  untouched.
- `fs-paths.js vfsRealpath`: the outside arm's seam-MISS now throws node
  ENOENT (`enoent('realpath', …)`) instead of the anchor. The seam-ANSWERS
  arm keeps answering the canonical spelling — that arm is what carries
  fs-local's ENOENT ancestor walk (its walk realpaths the nearest existing
  ancestor, an outside-root real directory, and lands the caller on the
  stat face's order) and the vendored realPath-canonicalization walks
  (typert analyzer). The now-dead `outsideEveryView` factory is removed.

Tool-face results: (a) refuses inside `ctx.fs.stat` with the full anchor —
the is-regular-file pre-check never runs; (b) resolves through the ancestor
walk and stats absent, which both tools map to their FS_NOT_FOUND absence
answers; (c) inside-root answers and lists unchanged.

Pins: `test/panel/tool-fs-outside-root-order.test.js` drives the REAL
vendored fs-local in a child node process whose loader hooks
(toolface-loader-hooks.mjs) apply the device loader's fs map — the vendored
fs faces land on the shim family with the C seam faked over real node — and
asserts (a) anchor with root + maybe-you-mean + node fields, (b) resolve ok
+ stat absent (the FS_NOT_FOUND handoff), (c) inside-root answer + list;
plus in-process shim-face controls for statSync. The loop-w realpath pin
(flipped honestly) and the stat-face order now live in
fs-readdir-real-fallback.test.js; the full panel suite is 236/236 (twice).
Closures synced android + harmony.

## Alternatives considered

- **Fix in the vendored packages** (reorder tool-fs's pre-check, or add the
  outside-root determination inside fs-local): rejected — D6 pins upstream;
  adaptations live in our shims/system-plugins. The vendored composition is
  also what the field measured; changing it would fork the pin record.
- **Anchor in `vfsRealpath` for EXISTING outside paths too** (refuse at
  resolve): rejected — it breaks (b): fs-local's ENOENT ancestor walk
  realpaths `/system` (existing, outside) and would die on the anchor,
  turning the absent path's absence into a refusal. The canonicalization
  face must answer; the content faces (stat now, reads since loop-r) refuse.
- **Gate only the tool face** (e.g. a tool-only wrapper): rejected — the
  faces are shared; the seam gate is exactly the one boundary every consumer
  already shares, and the R3-G1/W5-R in-world consumers (containment walks,
  subprocess executability checks) are inside-root or try/catch-classified,
  so the outside-root anchor reaches only the tool face — same argument
  loop-r documented for the read faces.
- **Anchor message without the node fields** (loop-r's codeless readdir
  variant): rejected — that trick exists for fs-local's `listingIoError`,
  which rewrites EACCES; the STAT face rides `probeStats`, which rethrows
  non-ENOENT raw, so the full #373 shape (EACCES/−13/`stat`) survives to the
  tool result and matches the read-face pins.
