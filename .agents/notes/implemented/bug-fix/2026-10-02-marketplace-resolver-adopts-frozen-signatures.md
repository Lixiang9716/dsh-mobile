# Agent Note: the marketplace resolver adopts the frozen §7 signatures array — the device rejected every real catalog

Status: implemented
Related: T-0167, contract/data-protocols.md §7 (v1.1.0, FROZEN), T-0150

## Problem

The batched device round (T-0166, 2026-10-02) caught the release build
refusing the real published catalog at the spine:
`claimed endpoint marketplace/index failed: marketplace/format: index
rejected: unknown index field: signatures` (logcat 18:21:05.014, within the
same second as the hosting server's `GET /index.json 200`). The repository
carried two verifiers that disagree on the same bytes:
`deploy/marketplace/generate-index.mjs` signs per the FROZEN
`contract/data-protocols.md` §7 — `signatures` is a required 1..2 array of
`{key, value}` covering the canonical JSON of everything except the array —
while `runtime/spike/marketplace-resolver.js` (the ONE new seam the device
web surface actually executes, embedded byte-identical in the Android assets
and the harmony rawfile) still validated a pre-frozen SINGULAR
`signature` field. Measured consequences: the CLI's `--verify` judged the
published index 9/9 good while the device resolver rejected it;
`runtime/spike/marketplace.js` (the contract face) accepted the same bytes
with a real ed25519 verification; the device marketplace leg only passed by
the mock server degrading to the old singular shape
(`mock-market-server.mjs`), which retired the real pipeline from test
coverage.

## Decision

`marketplace-resolver.js` validates the frozen shape: `signatures` replaces
`signature` in the KNOWN field set; the array must carry one or two
`{key, value}` string entries (shape only — the audit vocabulary stays
honest). `verifySignature` becomes array-aware: WITH a host-side pin, ONE
entry must name the pinned key (its `keys` entry equal to the pin) and
verify under it; WITHOUT one (the declared gap, unchanged and still logged
on every unpinned fetch), an entry whose key the index's own keys map
carries must verify — a catalog signed only by keys outside its own map
refuses as `unknown-key`, keeping the format/unknown-key/signature ladder
distinct. `web-write-marketplace.js` reports the signing key id through a
`signingKeyId` helper (the pin-anchored entry, else the first) — the wire
shape the page and the install journal render is unchanged. The tamper
ladder's fixtures (panel tests, `mock-market-server.mjs`) sign the array
form; two new panel cases pin the rule from both sides: a PRE-FROZEN
singular-signature index refuses as `format`, and a rotation-window
dual-signature index verifies when the pin matches one entry (§7.2).
Both platform embeds re-staged byte-identical via `build/build.sh sync`.

Proof (rule 6): the resolver now accepts the real served catalog bytes
(the exact bytes it rejected on device — probe replay), verifies them under
the published key with a host-side pin, refuses a foreign pin as
`unknown-key`, and the panel suite is 73/73.

## Alternatives considered

- Making the resolver accept BOTH shapes (singular legacy + §7 array):
  lost — the frozen contract defines exactly one catalog format, a dual
  shape re-introduces the guess-the-field behavior rule 5 forbids, and the
  singular form exists only inside this repository's own stale seam; no
  external producer ever shipped it.
- Fixing the publisher to emit the singular shape instead: lost — it would
  amend a FROZEN contract to match the bug, the exact direction the freeze
  exists to prevent, and `marketplace.js` plus `market-test-indexes.mjs`
  already implement the array correctly.
- Teaching `verifySignature` to prefer `signatures[0]` unconditionally:
  lost — during a rotation window the first entry can be the OUTGOING key
  the pin no longer trusts; the pin-anchored candidate filter is what makes
  the §7.2 window drill work.
