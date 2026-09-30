# Agent Note: The marketplace UI face lands — browse, install, installed over the signed catalog

Status: implemented

Related: D5 (the contract proposal, untouched), D8 (event-driven), D9 (the coverage plane)

## Problem

The plugin marketplace's D5 draft (data-protocols v1.1.0 candidate, #282) names
the phone as the marketplace's client — but after it, the phone has no
marketplace surface at all: no way to browse a catalog, install a package from
it, or see and remove what is installed. The gap: 打开插件市场 → 浏览目录 →
一键安装 → 看到进度 → 管理已装. The frozen data plane already carried the
other half: the DSH package format, the §4 install transaction, the receipts
journal.

## Decision

The marketplace panel lands in web-client-next exactly on the BYOK onboarding
pattern (#280): a pure-frontend face over runtime-provided wire legs, no new
gateway primitive, `contract/` untouched. One new seam — the resolver the
proposal names — plus the coverage-plane legs that serve it:

1. **`runtime/spike/ed25519.js` — verify-only Ed25519 (RFC 8032), pure JS.**
   The sha256.js precedent: the runtime's crypto seams are
   getRandomValues+btoa and no vendored package carries ed25519, so the
   signature layer needs it NOW. Nothing here can sign (no secret path);
   the curve is a pure data operation — the TRUST POLICY (which key to
   trust) lives in the resolver/host, not here. Correctness is pinned IN THE
   TREE by test/panel/ed25519.test.js: the RFC §7.1 test-1/test-2 vectors as
   fixed data, 128 fresh keypairs signed by node:crypto/OpenSSL (an
   independent implementation) that must agree, and the tamper refusals —
   flipped message/signature/public-key bits, the s ≥ L malleability class,
   non-canonical base64 pad bits, non-canonical y. BigInt field arithmetic,
   derived addition formula (documented in-file), canonical base64,
   cofactorless [s]B = R + [k]A with the s < L check.
2. **`runtime/spike/marketplace-resolver.js` — the one new seam.** Index
   fetch over an injected fetch impl (the gateway httpFetch in every real
   embed), canonical-JSON re-serialization (sorted keys, `signature`
   excluded, via runtime/spike/canonical-json.js), shape validation that
   fails loud, entry lookup passing the trust record through UNTOUCHED, and
   a verified-documents-only cache (TTL + force bypass). TRUST ANCHOR
   (proposal rule 2): `fetchIndex` takes a HOST-SIDE PIN (`pinnedKey`) and,
   when set, requires the index to sign with exactly that key — keys-map
   entry equal to the pin AND the signature verifying against it. DECLARED
   GAP, stated where the code is: with no pin, verification runs against
   the index's own keys map — transport-plus-format trust, the alternative
   the proposal REJECTS — and every unpinned fetch logs the disclosure. No
   production key exists yet to pin; wiring the out-of-band pin into every
   real embed and the rotation drill is the named resolver follow-up. The
   ladder is pinned in the tree by test/panel/marketplace-resolver.test.js
   (node-signed honest catalog; flipped-content → `signature`; unknown
   signing key → `unknown-key`; the wholesale keys+index+signature swap
   passing WITHOUT a pin — asserted as the honest fact it is — and refusing
   as `unknown-key` WITH the pin; network/format/missing-entry; the cache's
   verified-only policy). Rejections speak the proposal's audit vocabulary:
   network | format | unknown-key | signature.
3. **`upstream/web-write-marketplace.js` — the coverage-plane legs** (the
   onboarding legs' pattern; claimed only when the boot opts in with
   `marketplace: {indexUrl, publicKey}` — the publicKey IS the host-side
   pin, rule 2): `marketplace/index` (the browse view, entries verbatim +
   the journal-derived installed annotation, never the tgzUrl),
   `marketplace/install` (a mux STREAM of one real transaction — the
   pipeline's own steps folded: index.verified → resolved → fetch.start → …
   → committed → receipt), `marketplace/installed` (the receipts journal is
   the record of truth), `marketplace/remove` (fsRemove THEN the §4 append-
   only remove receipt, carrying the removed install's blobSha256).
4. **The panel is web-client-next:** `marketplace-core.js` (pure: entry rows,
   the install fold, installed rows, bilingual error mapping — vitest-covered
   at test/panel) + `marketplace.js` (DOM wiring: 浏览/已装 tabs, the install
   button's stream fold, the remove confirm) + bilingual copy throughout. A
   boot without the marketplace opt-in answers `gateway/unimplemented` — a
   capability gap, not an error.
5. **The CLI smoke backend implements `fsRemove`** (main_cli.c) — the
   remove leg's primitive, under the same scope discipline as its fs
   siblings. The BYOK leg set this precedent: the CLI dev host implements the
   frozen primitives the flow needs rather than standing the flow down.
6. **The e2e leg `marketplace.ui.flow`** (run-marketplace-ui-e2e.sh, artifacts
   `macos-cli-marketplace-ui/`, 12/12 one-to-one): a node-side loopback
   catalog (mock-market-server.mjs — plain file hosting with a FIXED test-only
   key) signs the index with node:crypto/OpenSSL, and the runtime's pure-JS
   verifier must agree — two independent implementations meeting at the one
   new seam. The runner derives the HOST-SIDE PIN out-of-band from the
   fixture key and passes it through the boot options, so the browse runs
   pinned (rule 2), and the leg carries the tamper ladder's signature
   family: a flipped-summary index under the real key's signature refuses as
   `marketplace/signature`, and a wholesale keys+index+signature swap by a
   foreign key — self-consistent, exactly what a hosting attacker ships —
   refuses against the pin as `marketplace/unknown-key` (the digest-mismatch
   half of the ladder is the pipeline's own trust-record enforcement,
   already proven by install.full-cycle). The install streams the REAL
   transaction over real loopback HTTP; remove exercises the §4 symmetric
   receipt.

Evidence: `marketplace.ui.flow` 12/12 (with the tamper legs); vitest 67/67
(test/panel — 20 onboarding + 20 marketplace page + 16 ed25519 + 11
resolver); closures green (android assets, harmony rawfile, ios generator);
staging-check 0 findings. The api-coverage-probe's coverage-streams
assertion, stale at `length === 1` since the onboarding stream landed, is
restored to enumerate reality (three streams).

REVIEW ROUND (2026-10-01, pre-merge): two catches, both fixed in the same
PR. (1) The trust anchor contradicted proposal rule 2 — the resolver
verified against the index's own keys map while three comment sites
misattributed the deviation to "the proposal's rule"; the pin (`pinnedKey`
through `fetchIndex` and the face's `publicKey`) is now the seam, the gap is
a loud declared one, and the comments state the rule as the rule. (2) The
verification evidence the note and module headers claimed did not exist in
the tree — the vectors and cross-check cases had run only in a scratch
harness. Both claims are now backed by committed suites (test/panel), and
the e2e carries the tamper legs; nothing in this note cites evidence that is
not a command CI runs.

## Alternatives considered

- **Vendoring an ed25519 library (@noble/curves, tweetnacl)**: rejected for
  this leg — the vendor-package discipline (pin tables, per-host embed lists,
  reproducibility) outweighs a verify-only primitive; the in-repo module is
  pinned by RFC vectors plus an independent-implementation oracle, and a
  resolver leg that prefers a vendored curve can supersede the file wholesale
  (the seam is one module).
- **A stubbed signature check for the CLI leg** (the fetch.stub precedent):
  rejected — unlike a transport, the trust decision IS the seam's product; a
  stubbed verify would prove nothing about the thing the proposal exists for.
  The e2e instead signs node-side so the verify is real.
- **Claiming the marketplace legs on the base surface**: rejected — the
  coverage plane is where opt-in page legs live (the onboarding precedent);
  the historical claim set stays byte-identical for the delivered manifests.
- **A ratings/search backend or a registry service**: out of scope by the
  proposal's named non-goals — the catalog is data, the index is fetched
  whole.

## Consequences

- The marketplace phase is NOT complete with this leg: the proposal stays a
  DRAFT, no README milestone row flips (the resolver/hosting/publish legs own
  their halves), and the index the CLI dev host serves is a test catalog
  whose key is a committed test fixture — no production key exists to pin
  yet. Key pinning + rotation drill remain the resolver leg's named work.
- The remove receipt's txId (`rm-<millis>-<id>`) is replay-naive: startup
  replay only examines `pending` receipts, and a remove receipt is born
  committed — crash-between-unlink-and-receipt leaves a committed install
  whose tree is gone (the installed view would ghost it). Named follow-up:
  a pending-marker remove, like the install path's.
- The CLI smoke backend now also grew `fsRemove` (its honest-unavailable
  posture for it is gone) — device hosts already implemented it.
- The node-side `marketplace-canonical.mjs` duplicates the resolver's
  canonicalJson (6 lines) because node cannot resolve the runtime's bare
  `logger.js` import; drift between the two is DETECTED (the signature check
  fails loudly), not assumed away — the header says so.
