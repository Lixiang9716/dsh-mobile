# The install manifests re-pin the fixture digests and byte count #145's rename moved

## Problem

PR #145 (`033c7e7`) retired the milestone-code prefixes and renamed paths that
live inside the E2E fixtures themselves — `m3-install/` became
`install-verified-tarball/` inside `fixtures/dsh-notes-source.js`, and the
`install-from-http` result text (`m3-fetch-install result: 5 deltas` →
`install-from-http result: 5 deltas`) changed length. The fixture tarball is
BUILT AT RUN TIME from that source (`buildNotesTgz`), so every digest derived
from it moved with the rename. #145's follow-up fix updated one dependent pin
(`session-mock-llm`'s persisted byte count, 27→33) but missed three manifests:

- `test/e2e/scenarios/install-from-http.json` (the iOS leg) — blob sha256,
  treeSha256, receipt blobSha256 (4 pins) plus the `fs.write.ok` byte count
  (33; the renamed text is 34 bytes);
- `test/e2e/scenarios/install-full-cycle.json` (macOS CLI) — same 4 digest pins;
- `test/e2e/scenarios/install-verified-tarball.json` (macOS CLI) — 7 pins
  including the tampered-package `actual` digest.

Nothing could catch this on main: the committed evidence dirs are capture-time
records, so `test/e2e/matrix.mjs` re-verifies nothing about a fresh run, and no
CI job re-runs these scenarios against current code. The breakage surfaced only
when the iOS E2E sweep (T-0039) ran `run-ios-install-ui.sh` on a clean main
checkout: `install.from-http` failed 46/46 at index 7 (blob `eb478c29…`
expected, `531c86ff…` logged — same 3584 bytes, different digest).

## Decision

The three manifests re-pin to the values the current fixture source
deterministically produces, derived from real runs and cross-checked across
hosts (the iOS device log and the macOS CLI log produce byte-identical blob
digests — the fixture build is host-independent, as designed):

- blob sha256 `531c86ff…` (was `eb478c29…`), treeSha256 `d2aad885…` (was
  `a7c1a54b…`), tampered actual `488714df…` (was `996203ce…`), and the
  `install-from-http` `fs.write.ok` byte count 34 (was 33).

Verified green after the re-pin: `install.verified-tarball` 22/22 and
`install.full-cycle` 41/41 on the macOS CLI host, and `install.from-http`
46/46 + `install.carrier-evidence` 11/11 on the iOS simulator
(`run-ios-install-ui.sh`, T-0039 usecase 4).

## Alternatives considered

- **Revert the fixture rename instead** (`install-verified-tarball/` back to
  `m3-install/`): rejected — the rename is the point of #145 (human-readable
  surfaces); the manifests' pins are the derived artifacts that should follow.
- **Make the manifests compute digests instead of pinning them**: rejected for
  this fix — a checker that derives its own expectations cannot detect a
  fixture-bytes regression at all; pinning IS the tamper-evidence the install
  scenarios assert (`install.digest.verified` must name exact bytes). A
  generated-pin helper (derive at authoring time from a real run) would be a
  separate, larger change.
- **Leave it broken and file an issue**: rejected — the fix is mechanical,
  verifiable on both hosts, and every future fresh run of the three install
  scenarios hits it.
