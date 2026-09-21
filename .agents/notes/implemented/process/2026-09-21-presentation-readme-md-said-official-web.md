# Agent Note: presentation/README.md said official-web was not mounted — it is, on all three hosts

Status: implemented
Related: D9

## Problem

`presentation/README.md` is the one prose surface that tells a reader what the
UI layer is made of, and its `official-web/` bullet still ended with: "NOT yet
mounted: the carrier-side `ctx.webServer` implementation it requires is
specified in `docs/webserver-contract.md` and lands in the Phase-B carrier PR.
After that, the mobile-ui plugin (slot-registered mobile surfaces) follows."

Every clause of that was accurate when written (before Phase B) and false by
the time it was read. The carrier-side `ctx.webServer` implementation landed on
iOS first — the voided T-0013 card's own reason records the route table,
upgrade seats, fallback seat, index injection, `/plugins` serving and the
`/api` envelope bridge in `hosts/ios/App/Source` — then on Android and
HarmonyOS, and the official UI mounts on all three hosts today:
`b1.official-web.mount` 14/14 (iOS), `b-android.official-web.mount` 14/14
(Android), `b-harmony.official-web-mount` 17/17 (HarmonyOS) in
[docs/e2e-matrix.md](../../../../docs/e2e-matrix.md). The release builds embed
the dist and the client-bundle tier, so a plain launch reaches the official UI
with nothing staged from outside.

The `web-client/` bullet carried the same staleness at a smaller scale:
"Mounted by the iOS carrier in session mode" was written at M2; Android and
HarmonyOS have mounted the same `web/` bytes in their binding phases since
their M4/M5 (verified byte-identical at the time of this fix).

Nothing was wrong with the code — the document was never updated by the PRs
that completed the work. That is a rule-12 failure (status surfaces must agree
with the state) that nothing caught: the file is not a bilingual pair, no gate
inspects its content (the pairing and cross-link gates only check that pairs
link each other), and `README.md` does not link it.

## Decision

Both bullets now state the as-built position with the evidence attached: which
hosts mount which client, the three mount verdict rows, the carrier surfaces
that serve the dist (route table + upgrade seats + the fallback seat's
injection-rendered index, `/plugins` bundles, the `POST /api` envelope bridge,
the `WS /api/remote.mux` journal), and the 58-package application tier under
`client-bundles/` — which the README had never described at all, although it is
what renders the official app shell.

The forward-looking `mobile-ui` sentence is dropped rather than replaced by a
new promise: the mechanism it pointed at is already exercised on device (the
config-selected client swap `m3.ui-swap` 7/7 and the `dsh-notes` plugin's
`notes.toolbar` slot, logged `slot.register` → `slot.registered`), and
ARCHITECTURE.md §6 keeps `mobile-ui` as the whole-client example.

The correction is in place, not a rewrite: the swappable-UI contract, the
`-dsh-web-client <id>` selection and the mini client's description still match
the code.

## Alternatives considered

- **Leave it to whatever PR next touches the file.** Rejected by rule 12, and
  disproven by this case: Phase B, the application-tier shell work and both
  host ports all touched the carrier, and none of them touched the README.
- **Rewrite `docs/webserver-contract.md` in the same change** (its title still
  calls the alignment plan a plan, and "the carrier must reproduce" now reads
  as done). Rejected: it is a spec extracted from upstream source and phrased
  as requirements — every requirement it states is still what the carrier must
  do, so the plan register is not an error. It is also a paired doc, so the
  edit means both sides plus a `gov verify pairing --write` re-stamp; as-built
  framing there is a separate change if the owner wants it.
- **Delete the stale paragraph and say nothing.** Rejected: the paragraph's
  value is the topology (which host serves what from where), so a deletion
  removes the only prose statement of it.
- **Add a mount-status table to `presentation/README.md`.** Rejected: the
  verdicts already have a home in `docs/e2e-matrix.md`, and a second copy is
  the next drift.

## Consequences

The remaining asymmetry is now visible instead of implied away: the config and
component UI-plugin levels have on-device evidence only on iOS
(`hosts/ios/artifacts/m3-pluginization`), so the README names that evidence
rather than suggesting three-host coverage.
