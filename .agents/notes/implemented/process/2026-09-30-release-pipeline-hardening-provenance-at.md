# Agent Note: Release pipeline hardening: provenance attestation, the release environment gate, and the notes question settled by what already shipped

Status: implemented
Related: D12

## Problem

The release pipeline (D12/D13/D14, verified on the v0.0.1 release) cuts a
release from a `v*` tag push, but what it ships is only as trustworthy as the
run that produced it, and the tag push itself is not a recorded human "go":
anyone who can push a tag publishes packages to the release page with no
second pair of eyes, and a user who downloads `dsh-<host>.<ext>` has no
cryptographic way to tie those bytes to the run that built them. A hardening
pass was scoped: automated release notes, build provenance, and a go gate on
the release path — without overturning any part of the pipeline the v0.0.1
event already exercised.

## Decision

The three package workflows (`release/ios`, `release/android`,
`release/harmony`) each gain, additively: (1) `id-token: write` +
`attestations: write` on top of the existing `contents: write`, and a step
after the run-artifact upload that signs SLSA build provenance over the
release-bound bytes (`actions/attest-build-provenance@v4`): the subject
digest is computed from the actual built file and the subject name is the
release asset name it ships as (`dsh-android.apk`, `dsh-ios.ipa`,
`dsh-harmony.hap`), so `gh attestation verify dsh-android.apk --owner
Lixiang9716` ties a download to its build run; the step is guarded by the
same `RELEASE_TAG != ''` condition as the attach step, because attestation
follows the release attachment — a plain dispatch publishes nothing and
attests nothing. (2) `environment: release` on the package job: the go gate.
The reference is deliberately static and the environment deliberately
unconfigured in this change — arming it (required reviewer) is owner web-UI
work documented separately; until then the reference creates an empty
environment and no run waits (GitHub creates the environment with no
protection rules). Release notes needed no change: `gh release create
--verify-tag --title <tag> --generate-notes` has been the create step since
PR #112, which is exactly the conventional-commits-fed form the hardening
pass asked for, and the `gh release upload` traps it avoids (the `file#text`
form sets only the display label; `--clobber` is the repair path, kept) were
already designed around. docs/release.md + .zh.md updated to match
(pairing re-confirmed).

## Alternatives considered

- `--notes-from-tag` for the release notes: requires an annotated tag whose
  message carries the notes; this pipeline cuts tags as lightweight pointers
  on a merge commit and the changelog already lives in `CHANGELOG.md`
  (bump-version.py). `--generate-notes` builds the log from PR titles, which
  the commit-format gate already curates — it lost nothing and was already
  shipped, so re-doing it would have been the overturn the pass forbade.
- `actions/attest` (the action attest-build-provenance v4 wraps; its README
  steers new implementations there): functionally the same path, but the
  wrapper is the established name for build provenance specifically, keeps
  the input surface (`subject-path`/`subject-name`) this repo's workflows
  document, and matched the hardening brief verbatim.
- A conditional environment
  (`environment: ${{ github.event_name == 'push' && 'release' || '' }}`) to
  spare plain dispatches the future approval wait: rejected — the empty-arm
  of that expression is community-observed behavior, not documented
  semantics, and the dispatch-with-`release_tag` path mutates a release just
  like a tag push, so gating the whole job is the honest gate. The cost is a
  possible approval on a purely-manual packaging run once the reviewer is
  armed; visible, explained in the workflow comment, and reversible by the
  owner's configuration choice.
- Attesting every build (unguarded step): rejected — it would attest bytes
  that never reach a release and blur the promise "everything on a release
  page is attested".
