# Agent Note: upstream re-cut and promoted packages force re-pins

Status: implemented
Related: none

## Problem

A fresh `ensure-dsh.sh` fetch of the committed pins started failing:
upstream re-cut `agent-presets` 0.1.6-alpha.2 IN PLACE (same version tag,
different bytes — sha `6361a84a…` became `e69c1052…`), and PROMOTED
`atomic-write` / `home-paths` out of their 0.0.1-rc stream into
0.1.6-alpha.2, DELETING the rc tarballs. The old pins now mismatch or 404,
so any cold fetch (fresh clone, evicted CI cache) breaks while existing
checkouts survive on their cached trees. The drift was invisible locally
because ensure-dsh.sh skips present trees.

## Decision

All 29 DSH pins + 9 npm pins were re-verified against fresh upstream
fetches (sha256 over each tarball). The three affected rows were re-pinned
to what upstream serves today: agent-presets `e69c1052…`, atomic-write and
home-paths at 0.1.6-alpha.2 (`491c5b10…`, `1f08b24e…`). The C-host bare
map's rc-version special cases were deleted (both packages now ride the
shared version constant), the vendored trees were re-fetched, and every
probe / e2e scenario was re-run green against the new bytes. The seed
generator (ci/gen-presets-seed.py) now derives markers from the live
vendored closure so CLI and device stay in lockstep.

## Alternatives considered

- Keep the old pins and rely on the cache — rejected: a fresh clone or a
  cold CI cache would fail loud with no recovery path; the rc tarballs no
  longer exist upstream at all.
- Mirror the old tarballs in this repo — rejected: it forks upstream
  artifacts and hides the drift this note exists to surface; the upstream
  issue is the fix.

## Consequences

The re-cut means "pinned 0.1.6-alpha.2" is only as stable as upstream's
master branch; re-pinning is now a known ritual (verify all pins, not just
the suspect). An upstream issue asks for immutable release artifacts.
