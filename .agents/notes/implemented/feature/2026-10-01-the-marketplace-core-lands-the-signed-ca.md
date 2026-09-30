# Agent Note: The marketplace core lands: the signed catalog becomes code — resolver seam over the frozen installer

Status: implemented
Related: D5, D6, D8

## Problem

The registry was the one named gap with nothing behind it: the package format
was frozen (data-protocols v1.0.0) and the M3 installer live, but its trust
record stood in for "the signed catalog a real installer consults" — the
pipeline's own header said so. The marketplace proposal
(2026-10-01-plugin-marketplace.md, now ADOPTED) named the shape (signed
static index, ed25519, one new seam — the resolver) but also a hard question
it did not settle: HOW does a quickjs runtime verify ed25519 at all, when the
frozen gateway has no signature primitive and the spike's crypto seams are
`crypto.getRandomValues` + `btoa` only? A new gateway primitive would have
meant another D5 round-trip the proposal explicitly forswore ("zero new
gateway primitives").

## Decision

The catalog is code now, exactly per the frozen §7 (v1.1.0):

- **Pure-JS ed25519, verify-only** (`runtime/spike/ed25519.js`, RFC 8032,
  BigInt over quickjs-ng — proven available by probe): strict verification
  (non-canonical scalar/point refused) with `ed25519SelfTest()` pinning the
  RFC vectors + negatives, so the verifier proves itself BEFORE any catalog
  is trusted; cross-checked 30/30 against `node:crypto`-signed vectors plus
  tamper negatives. `sha512.js` (FIPS 180-4, known-answer checked) carries
  the digest face; `utf8.js` is a real UTF-8 codec because the catalog
  carries zh summaries and the house `charCodeAt` idiom is latin-1 — it
  would have silently broken every signed index containing zh text.
- **One canonical form, one module** (`canonical-json.js`): the §7.1
  signature covers the recursively key-sorted JSON of the document minus
  `signatures` — the SAME module the node-side generator signs with, so
  signer and verifier cannot drift; the spec text is the arbiter.
- **The resolver** (`marketplace.js`): `createResolver({fetchImpl,
  indexUrl, pinnedKeys, on})` — index fetch over `httpFetch`, §7.1
  verification (the trust set = out-of-band pins ∪ keys learned from a
  VERIFIED dual-signed index; a signature from an untrusted key never
  promotes a document), §7.2 rotation learning, `id@range` lookup
  (`^`/`~`/exact/`*`), and the entry's `{blobSha256, manifestSha256}`
  passed THROUGH untouched to the UNCHANGED `installFromFetch` — the
  committed receipt's `blobSha256` must equal the signed entry's
  (install-fetch.js and install-pipeline.js: zero modifications).
  `fetchImpl` stays a parameter (no hostType branching); rejections are the
  installer's `InstallRejected` vocabulary (`signature`/`unknown-key`/
  `catalog`/`network`), each auditable. Learning is session state — a
  restart falls back to the pin, so a stale pin can never shortcut the
  rotation window.
- **The authoring tool is the LANDED publisher tooling, reconciled to the
  frozen shape** (PR #287 review round 1): main's #283
  `tools/gen-marketplace-index.mjs` (the one marketplace-publish.yml
  drives) had attached a singular `signature` object for single-signed
  publishes — the frozen contract's required 1..2 `signatures` ARRAY and
  the resolver's hand validator both refuse that shape, so the two
  generators' add/add conflict was the visible symptom of a real shape
  war. The reconciliation keeps MAIN's generator (this PR's thinner
  duplicate is deleted), makes `attachSignatures` always emit the array,
  aligns `marketplace-rotate-key.mjs`'s header and
  `deploy/marketplace/generate-index.mjs` (--build writes the array,
  --verify refuses the dead object loudly), and the e2e leg now authors
  its catalog with those landed tools — honest index from the generator,
  §7.2 window document from `marketplace-rotate-key.mjs window-index` —
  so the leg proves the CI-facing pipeline end to end.
- **The proof** (`marketplace.install`, 71/71 one-to-one ×3 consecutive
  runs, evidence `runtime/spike/artifacts/macos-cli-marketplace-install/`):
  loopback file hosting (the proposal's "plain file hosting") serves a
  catalog authored from `system-plugins/`; the happy path installs `dsh-fs`
  through the resolver and round-trips its fs service; the §7.2 rotation
  drill (dual-signed window → key learned → post-window accepted by the
  window-observer, `unknown-key` for the stale pin); the §7.1 tamper ladder
  — bad signature, a SELF-CONSISTENT attacker catalog (trust is the pin,
  not the document), a hostile mirror (honest catalog, served bytes flipped
  behind a control endpoint — the signed trust record catches what the
  transport cannot), and an honestly re-signed publisher metadata error
  (the §4 cross-check refuses what the signature alone cannot) — every rung
  `InstallRejected` + audited + ZERO staging (journal untouched, installed
  tree intact). Ephemeral-port URLs are normalized to paths in the log so
  the stream stays deterministic.

## Alternatives considered

- **A host C helper / new gateway primitive for ed25519**: rejected — the
  adopted proposal's own rule is zero new primitives; a C helper would need
  its own D5 round, and pure-JS verification measured cheap (the whole
  71-event leg runs in seconds) for catalog-sized messages.
- **Vendoring tweetnacl (D6 pin ceremony)**: rejected — verify-only ed25519
  is the small, self-checking half of the curve (~200 lines + SHA-512), and
  the sha256.js precedent already established hand-rolled dependency-free
  crypto for exactly this seam; a vendored signing library would also drag
  signing (nonce-misuse class) we do not need.
- **Signing the file bytes of index.json instead of canonical JSON**:
  rejected — it would freeze the document's whitespace/key order forever;
  canonical-JSON signing lets the index stay pretty-printed (the served
  bytes are NOT canonical — the e2e proves verification re-canonicalizes).
- **Hosting-side tamper modeled as a re-signed wrong-digest index for the
  blob rung**: rejected as dishonest — an attacker who can re-sign under
  the pinned key is a different (out-of-scope) threat; the faithful model
  is the hostile MIRROR (honest catalog, corrupted bytes), which is what
  the server's `/_tamper` control endpoint stages. The re-signed variant
  IS used where it is the honest model: the publisher-metadata-error rung.
- **Publishing the catalog files as committed artifacts**: rejected — the
  catalog is reproducible from the repository (the proposal's v0 model);
  committing port-dependent bytes would churn on every run, so the runner
  keeps the catalog in a temp dir and the receipt records the pinned
  digests.
- **Keeping this PR's own generator alongside main's** (the pre-review
  state): rejected — two tools producing one contract's document is the
  drift the contract exists to prevent; the landed tool is the one the
  publish workflow drives, so the resolver leg must consume ITS output
  (and now does).
