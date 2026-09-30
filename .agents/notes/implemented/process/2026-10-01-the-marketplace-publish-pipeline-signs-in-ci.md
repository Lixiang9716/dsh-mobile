# Agent Note: the marketplace publish pipeline — the catalog is signed in CI, and the real deploy waits on an environment

Status: implemented
Related: contract/proposals/2026-10-01-plugin-marketplace.md, D12, #271 (the `release` environment), #282

## Problem

The plugin marketplace proposal (#282) made the catalog a signed static
`index.json` over the frozen package format — but nothing turned that from a
document into an artifact. The catalog has to be reproducible from the
repository ("authored by CI from the repo, exactly like the vendor pin
table"), which means the packaging, the hashing, the ed25519 signature, and
the deployment all need an owner-free path from `system-plugins/` to the
hosting, with the private key in CI secrets and no trust placed in the file
server. And the first real-publish path needs a gate that keeps a publish a
human's decision without blocking dry runs.

Three decisions in that path were genuinely open (the proposal fixes the
format, not the pipeline): what byte format the packages really are, how a
dual-sign window is expressed in the index, and where trigger/gate
boundaries sit.

## Decision

**One workflow, two jobs, three new tools.**

- `.github/workflows/marketplace-publish.yml` — `workflow_dispatch` defaults
  to `dry_run: true` (package + sign + artifact, deploy nothing); a
  `marketplace-v*` tag push (or a dispatch with the box unchecked) reaches
  the `publish` job, which targets the `marketplace` environment — the #271
  mechanics: inert until the owner arms it with a required reviewer,
  "Prevent self-review" stays OFF for a solo maintainer.
- `tools/gen-marketplace-index.mjs` — packs every `system-plugins/*` into
  the frozen DSH package layout (manifest.json verbatim at the root,
  everything else under `bundle/`), computes the installer's trust record
  (`blobSha256` = digest of the package bytes, `manifestSha256` = digest of
  the packaged manifest), builds the index, and signs the canonical JSON
  (sorted keys, RFC 8785-style) with ed25519. Deterministic: fixed
  `--generated-at` reproduces byte-identical output (verified).
- `tools/marketplace-rotate-key.mjs` — `gen` (fresh pair, seed shown once)
  and `window-index` (the dual-signed rotation window: `keys` carries both
  keys, `signatures` — an array of the proposal's `{key, value}` objects —
  carries both signatures). The four-step rotation runbook lives in the
  tool header and docs/github-owner-actions.md §7.
- `deploy/marketplace/deploy.sh` — rsync `--checksum` over ssh, then a
  post-upload digest check of the remote index (a silently corrupted host
  fails the run). Fails loud naming every missing secret, and reports an
  unreachable server with ssh's diagnostics plus the "run dry-run instead"
  pointer.

The decisions the proposal left open, made and load-bearing:

1. **The package bytes are the deterministic UNCOMPRESSED ustar of
   tar-mini.js's profile.** The M3 pipeline is what must install these
   packages, and it consumes raw ustar: tar-mini.js "ships an uncompressed
   archive" and install-fetch.js passes fetched bytes to `installPackage`
   WITHOUT gunzipping. Shipping gzip would produce packages no installer in
   this repo can open. The generator ports the writer (mtime 0, uid/gid 0,
   100-byte name field) so `blobSha256` is reproducible; when the gzip
   transport leg lands upstream, generator and pipeline must switch in
   lockstep.
2. **The dual-sign window is `signatures: [{key, value}, …]`** — a normal
   index carries `signature: {key, value}` exactly as the proposal's
   example shows; the array form is the one additive extension the rotation
   rule ("signed by both keys for one window") needs. The resolver
   implementer handles both, never both at once.
3. **Key material format**: `MARKETPLACE_SIGNING_KEY` is the base64 of the
   32-byte ed25519 SEED (the tail of openssl's PKCS8 DER); `keys` values are
   the raw 32-byte public keys, base64. Everything derives deterministically
   from the seed.
4. **Display summaries live in `deploy/marketplace/summaries.json`**, not in
   the manifests: the manifest schema is frozen with
   `additionalProperties: false`, and the generator validates manifests with
   the same strict rules as install-pipeline.js — a `summary` field in a
   manifest would be rejected at install time.
5. **A signed index never carries a placeholder URL**: base-url resolution
   is `--base-url`, then the `MARKETPLACE_BASE_URL` env variable, then a
   loud failure naming both — and EMPTY or whitespace-only counts as
   missing in both places. (Review fix on this PR: the workflow passed
   `--base-url "$VAR"` unconditionally, so an unset variable arrived as ""
   and slipped past an `undefined`-only guard, letting a signed index ship
   with relative placeholder URLs; the workflow now omits the flag when
   empty AND the generator treats empty/whitespace as missing, so each
   layer holds on its own.) Dry-run still requires the signing secret —
   the artifact IS the signed catalog, and rehearsing the signature is the
   point of a dry run.

## Alternatives considered

- **Gzip'd tarballs** (what ".tgz" usually means): rejected — the pipeline's
  tarRead cannot open them; byte-format fidelity to the one installer that
  exists beats filename convention.
- **One job targeting `marketplace` on every run** (the #271 single-job
  shape): rejected here — a release build costs minutes and both paths
  produce the same build, but marketplace packaging is seconds and the
  dry-run path exists precisely to NOT require an approval; two jobs keep
  rehearsal approval-free without weakening the real gate.
- **`v*` tags or `release: published` as the real trigger**: rejected —
  `v*` is the release pipeline's trigger (D12) and a catalog publish is a
  catalog event (any content change, independent of app versions); the
  Release event double-fires against the tag-push model release/ios
  documents.
- **Summaries inside manifest.json**: rejected above — fails the frozen
  schema at install time.
- **PKCS8/PEM as the secret format**: rejected — the raw seed is the
  smallest thing with no encoding ambiguity, derives the public key
  deterministically, and matches `openssl genpkey -algorithm ed25519`'s
  stored bytes.

## Consequences

- A dry run proves the entire pipeline up to the network boundary: packages,
  digests, signature, artifact. The deploy leg's failure modes (missing
  secrets, unreachable host, post-upload drift) are fail-loud and were
  exercised locally; the happy path needs the real host, so its first
  genuine proof is the owner's first armed publish.
- The `marketplace-v*` tag namespace now belongs to the catalog; the
  resolver work (the one new seam) can consume `signatures`-aware indexes
  from day one, and stale pins reject post-window indexes as the proposal's
  rotation drill requires.
