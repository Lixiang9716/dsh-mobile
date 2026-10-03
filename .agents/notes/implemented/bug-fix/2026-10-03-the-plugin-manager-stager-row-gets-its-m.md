# Agent Note: the plugin-manager stager row gets its missing npm pin

Status: implemented

## Problem

#340 added `stage_npm_face_at_dsh_path plugin-manager` to the Android
stager, but the face's npm pin never existed in `ensure-dsh.sh`
(`git log -S dsh-plugin-manager` over the file: zero hits, ever). The
stager demands the materialized tree
`runtime/spike/vendor/npm/@deepseek-ai/dsh-plugin-manager@0.1.6-alpha.2/`
and dies without it ("the dsh-plugin-manager npm pin is absent"). #340's
own android-e2e stayed green only because the CI vendor cache — keyed on
`hashFiles(ensure.sh, ensure-dsh.sh)`, neither of which #340 touched —
restored an orphan materialized tree from an earlier era. The first
cold-cache run (this PR, which rotated the key by legitimately pinning
dsh-client-ui-cordis) failed at Gradle's `stageSpineClosure` — main has
been one cache eviction away from a red android-e2e since #340 landed.

## Decision

`@deepseek-ai/dsh-plugin-manager@0.1.6-alpha.2` joins the npm pin table
(registry tarball in `dsh-tarballs/`, sha256 `b7ba2861…307cd`, identity
verified against the face the plugin-manager round materialized: name and
version match package.json). Local proof: `ensure-dsh.sh` materializes
both new faces from the tracked mirror and exits 0, so a cold CI cache
now produces the tree the stager requires before Gradle runs.

## Alternatives considered

- Dropping the stager row instead — rejected: the plugin-manager write
  legs the e2e asserts (#340's whole point) consume the staged face.
- Committing the staged assets copy instead of the pin — rejected: the
  assets vendor tree is Gradle-materialized at build time and the pin
  table is the tracked provenance record (D6/D9); a committed copy would
  bypass sha256 verification.
- Leaving the fix to the plugin-manager round — rejected: every
  cold-cache CI run of every open PR stays red until the row exists, and
  the repair is mechanical with local proof.

## Consequences

Cold-cache CI materializes the plugin-manager face like any other pinned
face; the stale-cache illusion that masked the gap since #340 is closed.
The first face the stager stages after this lands is byte-verified from
the tracked mirror, not restored from cache.
