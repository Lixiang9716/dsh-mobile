# Agent Note: The freshness anchor lands: the catalog-replay hole (#295 HIGH) closes — a monotonic generatedAt floor refuses the stale-but-valid catalog

Status: implemented

Related: the HIGH finding's own record —
[the security adversarial net lands](../feature/2026-10-01-the-security-adversarial-net-lands-four.md)
(its `forge.rollback.catalog outcome=installed` rung pinned today's truth);
threat model docs/security-threat-model.md §3 ("marketplace supply chain —
catalog freshness", HIGH → defended); D5 (contract first — zero new
gateway primitives), rule 5 (fail loud), rule 6 (the falsify-first proof).

## Problem

The marketplace pin anchors the signing KEY, not an epoch, and
`generatedAt` was validated for presence only. A compromised mirror could
therefore replay an old, honestly signed catalog — internally consistent,
correctly signed trust record included — and the resolver installed it:
`security.manifest-forgery`'s freshness rung recorded
`forge.rollback.catalog outcome=installed` (`dsh-echo@0.9.0` landed, #295's
HIGH finding, recorded not absorbed). Within the architecture's own
adversary model (a hostile mirror is why the catalog is signed at all) a
replayed catalog is a working version-rollback channel.

## Decision

A client-side freshness anchor — the monotonic `generatedAt` floor — in
the contract resolver ([runtime/spike/marketplace.js](../../../../runtime/spike/marketplace.js)):

- `createResolver` now REQUIRES `anchor: {load, save}` (fail loud, rule 5 —
  a resolver without one is the hole this closes). The store is the
  caller's data plane: [runtime/spike/freshness-store.js](../../../../runtime/spike/freshness-store.js)
  wires it to one app-scope file via the existing `fsRead`/`fsWrite` —
  not the keychain (the floor is a publication watermark, not a secret)
  and zero new gateway/contract primitives. The resolver stays
  carrier-neutral: the anchor is a parameter exactly like `fetchImpl`.
- `fetchAndVerify` verifies the signature FIRST, then compares: older than
  the floor → `InstallRejected('catalog')` (the existing rejection
  vocabulary, message names the replay) BEFORE the state commit and BEFORE
  rotation learning — a rejected document teaches nothing and moves
  nothing. Equal passes (a republished identical catalog must not brick);
  newer advances the floor; first contact (no floor) accepts and anchors —
  a fresh client is never bricked. Only a catalog that verified under the
  trusted set can advance the floor, so an attacker cannot poison it
  forward. The floor is keyed to the marketplace, not a key: rotation
  neither resets nor bypasses it.
- The flip is regression-observable: the freshness rung now anchors the
  floor on a CURRENT catalog the runner hosts beside the replay one
  (`forge.freshness.anchor`, first contact), records the replay refusing
  at refresh (`forge.rollback.catalog outcome=rejected code=catalog` —
  the checker's flip, the maintenance contract's "a defense landing flips
  the pinned expectation deliberately"), proves zero staging, and
  re-refreshes the current catalog (equal floor — `forge.freshness.
  honest-refresh`, the guard holds no grudge). Falsify-first holds the
  flip honest: with the floor comparison neutered the replay LANDS again
  (`outcome=installed`, finding `severity=high`) and the checker reddens —
  run and recorded before the guarded green was trusted.
- Regressions re-ran green on the CLI: marketplace.install (its checker
  grew one row to 72 — the anchor's `market.freshness.anchored` audit step
  is now part of the one-to-one stream), onboarding.flow, the
  marketplace.ui leg, and perf-baseline (the resolver there carries the
  same anchor).

## Alternatives considered

- **Publish epoch in the pin** (the #295 named alternative): rejected —
  an epoch is a second out-of-band trust artifact to distribute and rotate
  with the key, and it freezes "freshness" at pin time instead of
  observing what the client actually accepted. The monotonic floor needs
  no new out-of-band channel and cannot disagree with the catalogs the
  client has really seen.
- **Comparing against the wall clock** (reject catalogs older than N):
  rejected — clock skew and offline windows would brick honest clients,
  and a future-dated forged catalog would pass; the floor trusts only
  what the signature already vouched for.
- **Guarding the panel's UI install stream too**
  ([runtime/spike/upstream/web-write-marketplace.js](../../../../runtime/spike/upstream/web-write-marketplace.js)
  resolves through marketplace-resolver.js): NOT landed — that face's
  rejection vocabulary (network/format/unknown-key/signature) has no stale
  code, so guarding it is a wire-vocabulary decision (a new
  `marketplace/<code>` surface the proposal owns). Declared as the named
  follow-up in the threat model, not silently absorbed.
- **Optional anchor with a loud disclosure** (the unpinned-key precedent in
  marketplace-resolver.js): rejected for THIS seam — the unpinned-key gap
  predates a pin to install against; here a silent no-anchor default would
  ship the exact HIGH hole as the easy path. Required-and-loud (rule 5).
- **Persisting the floor inside the resolver module** (module state or a
  gateway import): rejected — it would break the resolver's
  fetchImpl-as-parameter carrier neutrality (D5/D8) and silently pick a
  data plane for every embed; the store is the host's choice, wired as a
  parameter.

## Consequences

- On the CLI the app scope is a fresh temp dir per run, so every CLI leg
  exercises first contact; the cross-restart replay defense shows on real
  hosts, whose app scope persists (the anchor file lives beside the
  installer's receipts).
- A publisher clock error that publishes a FUTURE `generatedAt` advances
  clients' floors past the correct present — catalogs then fail loud until
  the publisher republishes with the corrected time. Fail-loud beats
  silent rollback (the threat model carries this consequence).
- Corrupt anchor files abort loud (a silently dropped floor would reopen
  the replay window); a missing file is the null (first contact) case.
