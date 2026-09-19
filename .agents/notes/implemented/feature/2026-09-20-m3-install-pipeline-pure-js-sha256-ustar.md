# Agent Note: M3 install pipeline: pure-JS sha256 + ustar packages + receipt transaction over the frozen fs primitives

Status: implemented
Related: D5

## Problem

M2 proved that plugins RUN (registry + activation), but nothing proved how
plugins ARRIVE. ARCHITECTURE.md §5 requires "Install = data operation:
tgz → cache/blobs/<sha256> → verify → atomic unpack → receipt" on the frozen
nine-primitive gateway, and the spike had to prove it without (a) new gateway
primitives — the contract is frozen (D5), (b) any host-native digest — the
spike runtime exposes only `crypto.getRandomValues` + `btoa`, and (c) shell
tools — the single-threaded QuickJS runtime cannot invoke `tar`. The
contract's atomic-unpack story also assumes a rename primitive the gateway
fs v1 does not have.

## Decision

`runtime/spike/install-pipeline.js` implements the full §4 transaction over
`fsRead`/`fsWrite` only: digest → content-addressed blob → verify against a
caller-supplied trust record → untar → strict manifest validation (unknown
fields rejected, per the schema's additionalProperties:false) → integrity
ledger → stage under `plugins/.staging-<txId>/` → read-back re-verify →
promote to `plugins/<pkg>@<semver>/` → receipt append as the commit point.
Supporting pieces: `sha256.js` (pure-JS SHA-256, cross-checked against
node:crypto incl. block boundaries; a mod-32 JS shift bug in the length
encoding was caught by differential testing against a FIPS reference),
`tar-mini.js` (deterministic uncompressed ustar writer+reader; system `tar`
reads its output), `fixtures/dsh-notes*` (a real plugin packaged at scenario
time, with a `tampered` variant for the rejection path), and the
`__dshModuleDefine` seam in the shared spike host so the INSTALLED entry can
be loaded through the ESM loader + registry (the gateway fs scopes are not
the loader's filesystem). Rejected installs abort before promotion, write no
receipt, and leave the installed tree byte-identical — proven by the
`m3.install` scenario (21/21 one-to-one events on the macOS CLI, evidence
under `runtime/spike/artifacts/macos-cli-m3-install/`).

## Alternatives considered

- Gateway digest primitive (`crypto.digest`) — beat by pure-JS sha256: it
  would have required amending the frozen contract (D5) for a pure-compute
  need, and sha256 is ~100 dependency-free lines.
- Vendoring a third-party JS sha256/untar — beat by hand-rolled minimal
  implementations: D6 upstream discipline pins upstream DSH packages, and a
  random npm copy is a supply-chain liability for code we must audit anyway.
- gzip-correct `.tgz` packages — beat by uncompressed ustar for the spike:
  no inflate primitive exists on the gateway; the digest/verify/unpack
  semantics under test are tar-layer concerns, and the transport coding
  lands with the fetch-based installer (M4+).
- Host-side unpack (native installer in the embedder) — beat by JS-over-fs:
  it would have made install a per-platform implementation instead of a
  platform-neutral data operation, exactly the RFC 0002 anti-pattern.
- Atomic unpack via `fsWrite` to a temp name + rename — impossible on the
  frozen fs (no rename primitive); approximated by stage → read-back
  verify → promote, with the receipt as the authority point and pending-
  receipt replay deferred to the real profile host (documented in
  runtime/spike/README.md).
- Loading the installed plugin via dynamic `import()` of a bundle-root path —
  beat by `__dshModuleDefine`: the ESM loader reads the bundle root from
  disk while installed files live in a storage scope, on both the CLI and
  iOS hosts; a module-from-source seam keeps the scenario platform-neutral.
