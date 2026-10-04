# Agent Note: the carrier's served asset trees reconcile against a stamped manifest on boot — stale install -r residue prunes itself instead of shadowing the shipped closure (loop-g)

Status: implemented
Related: D9

## Problem

The Android carrier serves three trees materialized from the APK's assets
into `filesDir` (`spike`, `official-web`, `web-plugins`) — and the copier
was overwrite-only. `adb install -r` preserves app data, so every entry an
OLDER APK once shipped survived forever: the tester's device held 274
pre-lean `files/spike/vendor/dsh` dirs (mtimes 10-02/10-03) the current
lean closure never materializes (loop-g), and no clean-install proof could
distinguish "the lean closure boots standalone" from "the stale mirror is
still feeding the runtime". require-resolution against stale mirrored
bytes is exactly the failure class the vendoring gates exist to prevent.

## Decision

`copyAssetDir` becomes `syncAssetDir`: each synced tree carries an
`.dsh-asset-stamp` — the exact sorted relative-path manifest the current
APK ships, written after the copy completes (crash-safe: an interrupted
boot leaves no stamp, so the next boot reconciles fully). On boot the
collected asset manifest is compared to the stamp: match → no-op (the
second boot re-copies nothing, verified by mtime); missing or differing
stamp — first boot after this fix, a lean change, a new or removed file —
wipes the tree and re-materializes exactly the shipped set. All ten call
sites (spike via `materializeBundle`, official-web ×4, web-plugins ×5)
switched. The trees are app-owned scratch: the user's workspace lives
under `files/profiles/`, and the presets seed re-delivers its rows every
boot, so the wipe never takes user data with it.

## Verification

On emulator-5554 (debug build from this branch): planted loop-g-shaped
residue (`files/spike/vendor/dsh/stale-junk-dir`, `stale-junk.txt`,
`files/official-web/stale.html`, `files/web-plugins/stale-junk.json`) via
run-as, relaunched with `--ez dsh.web true` — every stale entry pruned,
all three stamps written, and the real closure intact (274 vendor/dsh
dirs, the current lean set). Second boot: `boot.js` mtime unchanged
(stamp short-circuit, no re-copy). CI's android-e2e battery exercises the
sync at every drive boot.

## Alternatives considered

- A clean-install procedure (adb uninstall first) as the fix: rejected —
  it is a TEST prescription, not a fix; every future lean change would
  re-require it, and real users never uninstall between updates.
- Content hashing instead of a name manifest: rejected — asset contents
  are rewritten on every boot by the copy anyway (overwrite handles
  content drift); the loop-g class is ENTRY-SET drift, which names catch
  exactly, and hashing megabytes per boot buys nothing.
- Pruning inside copyAssetDir's recursion: rejected — deleting while
  walking interleaves IO decisions with the copy and cannot express
  "remove subtrees the APK no longer ships" cleanly; reconcile-then-copy
  keeps one pass that ends in a verifiable state.
