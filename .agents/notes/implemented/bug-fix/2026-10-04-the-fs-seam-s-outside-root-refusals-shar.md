# Agent Note: the fs seam's outside-root refusals share one hint, absence and error shape

Status: implemented
Related: D5 (contract-first capability honesty); the #363 aoci-lens review
(2026-10-04); builds on loop-r's seam containment and loop-h's anchor hint

## Problem

Three edge-state defects, all found by the 2026-10-04 aoci review of #363,
all in the same family — the real-disk seam's refusal machinery disagreeing
with itself at the edges:

1. `readdirMiss` (fs-readdir.js) built its absent answer by interpolating
   `wsRootHint(canonical)`, whose `ws()` call THROWS the mount error when
   no workspace is mounted. A probe of an outside path on an unmounted
   runtime answered "workspace is not mounted" where loop-r's contract (and
   the discovery walks' `isAbsentSkillPathError`) demand the absence ENOENT.
   The seam gate's own `wsOutsideRootError` guarded exactly this case
   locally (`state !== null ? wsRootHint(path) : ''`) — the miss path
   contradicted the gate's own principle.
2. The promise `readFile` (fs-promises.js) refused EVERY outside-root miss
   with the EACCES anchor — including genuinely absent paths — while
   `readdirMiss` carefully preserved absence-ENOENT for the same shape
   (the discovery-walk contract). Asymmetric absence answers across two
   faces of the same boundary.
3. Two spelling/shape nits with real teaching cost: `readFileSync` passed
   the RAW path to the refusal, so a `/x/../secret` probe anchored the
   maybe-you-meant hint at a spelling that does not mean what it says;
   and the two outside-root refusal factories carried different error
   fields (`wsOutsideRootError`: code+errno+syscall; fs-paths's
   `outsideEveryView`: code only).

The review round also surfaced a latent crash the tests had never reached:
`outsideEveryView` called `wsRootHint` WITHOUT importing it — every
`realpathSync` of an outside-root absent path died with
`ReferenceError: wsRootHint is not defined` instead of refusing (pinned
red by the new panel case before the fix).

## Decision

- The unmounted-hint degrade is sunk INTO `wsRootHint` (fs-workspace.js):
  `workspace() === null` returns `''`. Every call site — readdirMiss, the
  seam gate, outsideEveryView, the write refusals — now shares the rule
  "a refusal never masks itself with a mount error", and
  `wsOutsideRootError`'s local guard became redundant and was removed.
  fs-paths.js gained the missing `wsRootHint` import (an edge that already
  existed — no new cycle surface).
- The promise `readFile`'s outside-root arm probes existence through the
  READ seam itself (`__dshProcReadReal`): bytes answered → the host holds
  the path → the #358 anchor; null → genuine absence → node ENOENT. The
  read intrinsic is the only truthful existence probe on this seam (W6-V:
  `__dshProcStatReal` declines intermediate-symlink paths; the W5-R
  seam-only markers stat null — a stat-first probe would have broken the
  pinned seam-only anchor case). The probe's bytes are discarded: the
  anchor message names the path, never content (pinned).
- `readFileSync` now refuses with the lexical canonical spelling (readdir's
  rule); the promise face passes `lexical(path)`. `readAnyBytes` already
  refused lexically (`resolveWorkspaceSymlink` canonicalizes) — pinned
  with a test rather than changed.
- `outsideEveryView` carries the node-complete fields
  (`errno: -13`, `syscall: 'realpath'` — its sole caller is vfsRealpath),
  matching `wsOutsideRootError`: one refusal shape across the boundary.
- Panel cases in `fs-readdir-real-fallback.test.js` pin all of it: the
  unmounted-hint degrade (readdir + the gate refusal), the absence ENOENT
  on the promise face, the lexical spellings, and the unified error shape.

## Alternatives considered

- **Guard at the readdirMiss call site** (`state !== null ? hint : ''`
  inline, like the gate used to): fixes one caller and leaves the next
  call site to rediscover the rule — the write refusals and
  outsideEveryView would still interpolate unguarded (and
  outsideEveryView's missing import proved the family is fragile exactly
  there). Sinking the degrade into the hint makes the invariant
  un-bypassable.
- **Stat-first existence probe for the readFile arm** (readdirMiss's
  `__dshProcStatReal` shape): cheaper, but it breaks the two measured
  cases the seam serves through the READ channel — intermediate-symlink
  paths (W6-V) and the W5-R seam-only markers — and would have flipped
  the pinned loop-r anchor case to a false ENOENT.
- **Align the error shape DOWN** (strip errno/syscall from
  `wsOutsideRootError` to match `outsideEveryView`): makes every read
  refusal less node-shaped; every other factory in these shims (enoent,
  EACCES, EISDIR, cpEexist) carries the node-complete fields, and vendored
  consumers classify node errors by exactly this shape. `outsideEveryView`
  was the outlier; it moved up.
- **One shared factory** (delete `outsideEveryView`, route vfsRealpath
  through `wsOutsideRootError('realpath', …)`): the truest "one form", but
  it adds a NEW import edge fs-paths.js → fs-seam-gate.js in a shim cycle
  the repo has twice measured TDZ boots on (the wsRootHint move documents
  the constraint), and it would reword the `node:fs:` message prefix a
  message-family consumer may match. Field alignment gets the observable
  uniformity without touching the cycle.
