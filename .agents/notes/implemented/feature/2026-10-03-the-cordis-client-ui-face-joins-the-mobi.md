# Agent Note: the cordis client-ui face joins the mobile closure

Status: implemented

## Problem

The cordis dynamic-plugin definition card has a client UI face upstream —
`@deepseek-ai/dsh-client-ui-cordis` (the keyed `cordis_define` tool row with
its run/stop switch) — but the mobile closure never pinned it: the runtime
side (cordis-host-runner, dsh-tool-cordis, dsh-cordis-client-runner) and the
preset roster were in place, yet 18 `dsh-client-ui-*` faces shipped and this
one was missing, so no mobile web client can render a cordis definition card.
A four-skill HIG bake-off follow-up wants to restyle that card; the restyle
leg (upstream) needs the face present in the closure first.

## Decision

The face joins the npm pin table the same way every other client-ui face
did: one `ensure-dsh.sh` pin row (`@deepseek-ai/dsh-client-ui-cordis@
0.1.6-alpha.2`, sha256 `3992ce03…3817`) plus the tarball under
`runtime/spike/vendor/dsh-tarballs/`. The peer dependency it declares on
`@deepseek-ai/cordis` (`workspace:~` at the 0.1.6 line) is already satisfied
by the pinned `cordis@4.0.2` row, so the delta is exactly one package. The
android stager is wholesale over the npm faces (no rows), harmony's
vendor-official staging picks the faces up the same way; the byte proof ran
both locally (stage-spine-closure --check, gov run) and against
registry.npmjs.org directly (sha1/sha512 SRI match the checked-in tarball).
No preset roster rows — the face is not a model-facing tool. The vendoring
was executed by a five-stage workflow (survey → independent plan review →
wiring → gate loop → cold review) in a linked worktree
(`~/wt/cordis-ui-face`), isolated from a concurrent in-flight round that
shares the primary worktree.

## Alternatives considered

- Pinning `0.1.7-alpha.2` (the current upstream checkout) — rejected: the
  other 18 client-ui faces sit on the 0.1.6-alpha.2 line, and a lone
  0.1.7 face mixes version lines inside one closure; the face arrives at
  0.1.7 whenever the whole closure re-pins.
- Vendoring unpacked lib trees instead of the tarball pin — rejected: the
  npm faces' house discipline is tarball + pin row with ensure-dsh.sh as
  the single source; hand-staged trees would bypass the byte verification.
- Preset roster rows for the face — rejected per the vendor-package rule:
  roster rows are for model-facing tools/plugins only, and preset health
  hard-fails a row it cannot resolve.
- Deferring the whole embed to the restyle PR — rejected: the restyle leg
  lives upstream and its review needs the face rendering in a mobile
  client; embedding is a self-contained, zero-upstream-bytes change that
  unblocks it.

## Consequences

Mobile web clients can now resolve and stage the cordis definition card
face; the closures gate's vendoring-repro covers the 27th pin row only
after this lands (CI's fresh clone reads the committed table — the local
receipts predate the fast-forward and say 26, a known receipt-coverage
gap, not a byte error). Known dual-byte-set caveat recorded by the cold
review: the same 0.1.6-alpha.2 face also exists as an officialweb payload
materialized by the plugin-manager round, with css-modules hash salts
differing by build path — same upstream source, and the repo has no
mechanism reconciling the two; relevant only if both mounts are ever
consumed side by side.
