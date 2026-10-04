# Agent Note: the fs shim's readdir lists real workspace directories through the C host's readdir seam — the model's directory inventory sees write-through-mirrored and persisted trees (loop-p)

Status: implemented
Related: D9

## Problem

In creation/modification turns the model's `str_replace_editor` `view` of a
REAL workspace directory answered `cannot list "<abs>": not found`
(fs-local's listDirectory) while reads of files in the same tree worked —
twice on device (tester r6/r7: `plugins/countdown-timer`, `ls` via adb
fine). The agents compensated by reading known paths and writing blind:
no directory inventory was available inside creation turns (loop-p; same
family as loop-h's wasted-steps friction).

The chain: the file tools run on the vendored fs-local over the spike's
node:fs shims. The workspace view lists only REGISTERED entries
(`wsReaddirAt` walks `state.files/symlinks/dirs`), and the real-disk
fallback that should catch everything else required the subprocess
namespace (`spawnSync('find', …)`) — wired ONLY by the upstream-suite leg
(`upstream-suite-leg.js` pins `__dshChildProcessNs`). On every other seat
the fallback was inert, so any directory the served view had not
registered — a tree the write-through mirror materialized
(`__dshProcWriteFileReal`/`MkdirReal`), or a previous run's persisted
workspace — listed as not-found. Reads worked because the read and stat
faces have their own real-disk arms (`__dshProcReadReal`/`StatReal`).

## Decision

- **C host** (`runtime/spike/host/dsh_spike_host.c`): `__dshProcReaddirReal(path)`
  joins the real-proc seam family (ReadReal/MkdirReal/WriteFileReal/
  RmReal/StatReal/AccessReal/ChmodReal) — opendir/readdir, "."/".."
  skipped, names only (8192-entry defensive cap), null when absent. The
  caller sorts and shapes.
- **Shim** (`upstream/shims/fs-readdir.js`): `readdirRealFallback` prefers
  the new seam over the desktop-only `find` path (kept for the suite
  leg's early-pinned namespace). The SERVED arm now unions too: a
  workspace directory lists its registered entries MERGED with the real
  disk's children — the workspace root is a real directory and the VFS is
  its registration cache, so unregistered real children (mirrors,
  persisted trees) must appear beside state-only rows. The promises face
  rides the sync face unchanged.

## Verification

`test/panel/fs-readdir-real-fallback.test.js` (new) mounts a workspace,
creates a real unregistered tree with node:fs, fakes the seam over
node:fs (the C face's plain-boolean shape), and pins: the unregistered
directory lists (bare + withFileTypes), it appears in its real parent,
served-registry entries survive the union, and a nowhere-existing
directory still answers ENOENT. Panel suite: 188 passed (14 files).
`:app:externalNativeBuildDebug` green with the new seam; closure copies
synced (android assets + harmony rawfile) and the closures gate green.

## Alternatives considered

- Wiring the subprocess namespace (`__dshChildProcessNs`) on the release
  seat instead: rejected — `find` is a REAL subprocess, and the runtime's
  thread rules forbid subprocess work on the JS runtime's thread; the
  C-host seam is the same mechanism the write-through mirror already
  uses, in-process and synchronous.
- Registering mirrored trees in the served state instead (have the
  writers double-book every mirrored path): rejected — the registry would
  need a boot-time scan of the real workspace to catch persisted trees
  anyway (the mirror is write-time only), and a scan needs the same
  readdir capability this seam adds; the listing-side union fixes both
  classes at once.
- Merging real children into EVERY served view (also the seeded VFS): not
  now — the VFS serves the staged read-only world (bundled trees), whose
  real-disk twin is the staged assets copy; no loop-p evidence points
  there, and widening the merge multiplies the behavioral surface the
  suite legs assert against.
