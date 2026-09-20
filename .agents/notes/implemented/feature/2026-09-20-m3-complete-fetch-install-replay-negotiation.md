# Agent Note: M3 completion on the shared JS: fetch-based installer, pending-receipt startup replay, install-time negotiation, config layer

Status: implemented
Related: D5, D8

## Problem

M3's row listed four open items, all still prose: (1) plugins could only be
installed from in-memory bytes — nothing proved the FETCH transport layer
("install a package fetched over httpFetch"); (2) an install interrupted
mid-transaction left no recoverable state — the pipeline wrote only the
committed receipt, and §4's pending-receipt STARTUP REPLAY was explicitly
deferred; (3) `capabilities.required` was validated nowhere at install time —
an under-privileged package unpacked fine and only failed when a primitive
call was denied; (4) of the three UI-plugin levels only component slots and
whole-client swap were proven — the CONFIG channel (`cordis.patch` layered
overrides) had no implementation. The spike also cannot use a real network on
the CLI (its descriptor honestly declares `httpFetch` unavailable), so the
fetch proof needed a shape that works on both the CLI and a real carrier
host without `hostType` branching.

## Decision

- `install-fetch.js`: `installFromFetch({fetchImpl, url, …})` drains a
  STREAMING body (AsyncIterable of chunks — event-driven deltas, never a
  blocking whole-result) into bytes and runs the existing §4 pipeline. The
  fetch impl is a PARAMETER: the CLI scenario passes a logged scope-read
  stub with the exact gateway-httpFetch response shape
  (`install.fetch.stub`); the iOS carrier host passes the REAL `httpFetch`
  (scenario `m3.fetch-install`, separate PR). Same scenario code, no
  hostType branching.
- Receipt JOURNAL + STARTUP REPLAY (`receipt-journal.js`, §4): the pipeline
  (opt-in `journal: true`) appends each receipt to the append-only
  `receipts/journal.jsonl` — pending BEFORE the unpack begins, committed at
  the commit point, rolled-back on a failure after the pending receipt.
  Journal lines wrap one schema-valid receipt in a `{txId, receipt}`
  envelope (the frozen receipt schema is additionalProperties:false, so the
  transaction id cannot live inside the receipt). `replayPendingReceipts`
  reads the journal at startup and resolves every still-pending
  transaction: a staged tree that verifies (anchored by the pending
  receipt's treeSha256) is promoted and completes to committed; anything
  else rolls back with the installed tree untouched. `simulateCrash`
  reproduces §4's interrupted state for the E2E. Journaling is opt-in so
  platforms that have not adopted it keep byte-identical behavior.
- INSTALL-TIME NEGOTIATION (in `install-pipeline.js`, always on): after the
  manifest validates, every `capabilities.required` entry must be satisfied
  by the host RuntimeDescriptor (read via the frozen
  `__dshGatewayDescriptor` seam) — a requirement the descriptor declares
  `unavailable`, or simply does not offer, rejects the install BEFORE
  unpack; `gateway@1` is the host's own surface and always satisfied; a
  host that never set a descriptor skips negotiation (nothing was declared —
  the honest-absence reading of primitives.md §7).
- CONFIG LAYER (`config-layer.js`): `resolveConfig` merges layered patches
  base → hostFace → profile → overlay (objects merge recursively; arrays —
  the slot allow-set — replace). JSON, not YAML, documented in the module:
  the frozen gateway has no parser primitive and the spike vendors no YAML
  library; the file keeps the cordis.patch name so the real profile host's
  YAML swap is a parse change, not a semantics change. The `m3.complete`
  scenario consumes the resolved config the way the session stack does:
  the profile layer selects `dsh-web-client-mini` and trims the slot set,
  and the slot gate refuses the trimmed slot.

Proven by `m3.complete` (41/41 one-to-one events on the macOS CLI,
deterministic across runs, evidence
`runtime/spike/artifacts/macos-cli-m3-complete/`); `m3.install` updated for
the new `install.negotiated` step (22/22) and `m2.session` unchanged
(23/23).

## Alternatives considered

- CLI fetch stub vs adding httpFetch to the smoke backend — beat by the
  stub: declaring httpFetch available on the CLI backend would lie in the
  descriptor and break the declared-unavailable smoke case; the stub keeps
  the descriptor honest and still exercises the streaming-drain path. The
  real-network leg is the separate iOS scenario.
- txId inside the receipt record — beat by the `{txId, receipt}` envelope:
  the frozen receipt schema forbids additional properties (fail-loud
  contract, D5); amending it for an implementation detail would be a major
  version bump for nothing.
- Enumerating receipts by filename convention (receipts/<txId>.json parsed
  from a listing) — impossible: the gateway fs v1 has no readdir primitive;
  the append-only journal IS the enumeration mechanism.
- Replay re-fetching the blob from cache/blobs — beat by verifying the
  STAGED tree: the cache is regenerable and carries no authority
  (data-protocols.md §1); the staged tree is what an interrupted unpack
  leaves behind.
- Always-on journal writes in the pipeline — beat by the opt-in flag:
  sibling hosts (Android/Harmony) embed this pipeline and their fs backends
  have not proven append semantics; m2.session must stay byte-identical
  there. Negotiation, by contrast, is always-on and safe: any host that can
  run m2.session offers fsRead/fsWrite, and a missing descriptor skips
  honestly.
- YAML parser for the patch — beat by JSON: no parser primitive on the
  frozen gateway, no vendored third-party YAML (D6); semantics are
  format-independent and documented.
