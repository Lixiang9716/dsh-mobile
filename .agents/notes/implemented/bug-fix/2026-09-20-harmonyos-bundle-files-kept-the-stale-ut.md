# Agent Note: HarmonyOS BUNDLE_FILES kept the stale util-crypto@0.1.6-alpha.1 path after #53's alpha.2 bump

Status: implemented
Related: D6

## Problem

#53 (the upstream port, PR-A) bumped `dsh:util-crypto` from
0.1.6-alpha.1 to 0.1.6-alpha.2 everywhere it needed to go: the native
loader's module map (`dsh_spike_host.c` resolves `dsh:util-crypto` to
`vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js`), the
`m1-spike-boot.json` manifest's `package.loaded` matcher, the vendored
canonical, and the HarmonyOS rawfile copy. It did NOT update
`hosts/harmony/entry/src/main/ets/pages/Index.ets`, whose
`BUNDLE_FILES` list still named the alpha.1 path. Consequence: every
fresh HarmonyOS launch on post-#53 main died before logging a single
scenario line — `materializeBundle` calls
`getRawFileContent('spike/vendor/dsh/util-crypto@0.1.6-alpha.1/…')`
against a HAP that no longer ships that rawfile, `runSpike` catches the
failure into one hilog error line ("spike failed: GetRawfileContent
failed"), and an E2E drive starves its whole deadline with no verdict.
The byte-identity discipline held for every embedded copy (verified by
cmp against `runtime/spike/`, `system-plugins/`, and
`presentation/web-client` canonicals) — the drift was in the FILE LIST
that names the copies, the one artifact the cmp loop cannot see.

## Decision

`BUNDLE_FILES` names `vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js`
(one-line fix, same path string as the loader map). The full
on-emulator E2E is re-run green on exactly this tree — m1.spike.boot
7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 — and
the regenerated evidence lands with the fix
(hosts/harmony/artifacts/m5-host/, refreshed receipt documents the
re-run). `ci/run-host-e2e.sh` also now verifies the pre-launch
`aa force-stop` actually killed the app (pidof must be empty): a
silently-failed stop left the app resident, the streamed `aa start`
only foregrounded the old scene without onCreate (isNewInstance:false),
and the drive starved silently — the failure mode that first surfaced
this bug as a 300s deadline instead of a loud error.

## Alternatives considered

- A CI gate that mechanically cross-checks `BUNDLE_FILES` against the
  rawfile tree (and each entry's loader-map path): the right long-term
  fix — the earlier rawfile-drift bug-fix note already filed the
  canonical↔copy diff wish, and this failure shows the mapping list
  itself needs to be part of that check; still a design pass, not a
  drive-by gate.
- Pinning the version in one shared constant referenced by both the
  loader map and BUNDLE_FILES: rejected for this change — the loader
  map lives in C and BUNDLE_FILES in ArkTS with no shared header seam
  in the current layout; inventing one here would grow the fix's blast
  radius during an evidence-closure PR.
- Leaving the fix to the Harmony owner: rejected — the evidence-gap
  closure PR cannot produce a single green harmony verdict on a host
  that never boots its scenario, and rules.md rule 12 makes drift found
  later its own immediate corrective change.
