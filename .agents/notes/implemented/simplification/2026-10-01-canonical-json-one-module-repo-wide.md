# Agent Note: Canonical JSON is one module repo-wide — the four copies collapse into runtime/spike/canonical-json.js

Status: implemented

Related: the #287 note's already-recorded decision ("One canonical form, one
module … the SAME module the node-side generator signs with"),
data-protocols.md §7.1, the #288 note (supersedes its
`marketplace-canonical.mjs` copy rationale, linked below), the #284 standby
note (its embedded copy is the fail-loud form that won). Task card
T-0087 (B17).

## Problem

The §7.1 signature covers "the canonical JSON of everything except
`signatures`", and the contract's value is exactly that signer and verifier
agree byte-for-byte. But after #284/#287/#288 the tree carried the serializer
in FOUR places, drifted in behavior, each with its own drift story:

1. `runtime/spike/canonical-json.js` (#288) — the runtime authoritative
   module (resolver, marketplace, panel alias);
2. `runtime/spike/ci/marketplace-canonical.mjs` (#288) — a byte-copy for the
   e2e's mock market server, kept because (per its header and the #288 note)
   "node cannot resolve the runtime's bare `logger.js` import" — a reason
   that never applied to THIS module, which imports nothing;
3. `deploy/marketplace/generate-index.mjs` (#284) — an embedded copy, the
   only one that rejected `undefined` member values (fail loud);
4. `tools/gen-marketplace-index.mjs` (#287) — an embedded copy with no
   `undefined` guard, where a stray `undefined` would have silently produced
   invalid signed bytes (`"k":undefined`), corrupting a publish.

The signature check was still the drift DETECTOR (every copy fed a
node-signs ↔ pure-JS-verifies cross leg), but the copies' differing
failure behavior on non-JSON input was not detected by anything — and the
#287 note's decision was only half-realized in the tree.

## Decision

`runtime/spike/canonical-json.js` is THE canonical form, one module
repo-wide; its body now carries the strictest semantics of the four (the
#284 copy's fail-loud `undefined` rejection, throwing instead of `die`-ing
so the module stays host-agnostic):

- `runtime/spike/ci/marketplace-canonical.mjs` is DELETED —
  `ci/mock-market-server.mjs` imports `../canonical-json.js` directly (plain
  node resolves the pure module fine; `ci/market-test-indexes.mjs` had
  already been doing exactly that, green in CI).
- `tools/gen-marketplace-index.mjs` imports it and re-exports the binding,
  so `tools/marketplace-rotate-key.mjs`'s import surface is unchanged.
- `deploy/marketplace/generate-index.mjs` imports it; its "defined here and
  nowhere else" header claim is now true with the module named.
- The runtime embeds (`marketplace-resolver.js`, `marketplace.js`, host
  copies via `build/build.sh sync`, the panel vitest alias) keep their
  existing consumption of the same file — unchanged.

Cross-validation (the existing cases, re-run green — not new ones): the
panel suite signs with node:crypto and verifies through the resolver's
pure-JS ed25519 over the aliased module (test/panel, 67/67), and both
marketplace e2e legs prove the same crossing end-to-end
(`marketplace.install` 71/71 — the tools generator now signs through the
shared module; `marketplace.ui.flow` 12/12 — the mock server likewise),
each with its tamper ladder. The signature check remains the drift
detector; what changed is that drift now requires editing the one module.

## Alternatives considered

- **Keep the deploy tool's copy for standalone copyability** (one file you
  can scp to a hosting server): rejected — nothing promises that property
  (the README's publish flow runs the tool from the repo, against
  `../../system-plugins`), and a second copy is precisely the drift this
  change removes. If an offline single-file tool is ever wanted, it should
  be a build-time inlined artifact with its own drift check, not a hand-kept
  copy.
- **Make the shared serializer keep the silent-`undefined` behavior** for
  minimal diff: rejected — rule 5 (fail loud); the silent form turns a
  programmer error into corrupt signed bytes, the worst failure mode a
  signer can have. Valid JSON documents are unaffected (JSON.parse cannot
  produce `undefined`), proven by the re-run cross legs.
- **A build-time codegen (one source templated into node and runtime
  bundles)**: rejected for now — the runtime module is already directly
  importable by node (module-syntax detection; and the two node-side
  vehicles had both been importing it by relative path), so a generator
  adds machinery to solve a problem the tree no longer has.

## Consequences

- A stray `undefined` in any signing path now throws where it used to be
  silently encoded (deploy/tools/e2e signers) or produced invalid JSON
  (tools copy).
- The #288 note's copy rationale ("node cannot resolve the runtime's bare
  `logger.js` import") is superseded for this module: `canonical-json.js`
  imports nothing; only the resolver-grade modules need a loader shim
  (the panel vitest alias stays for those).
- The standby sample `deploy/marketplace/site/index.json` still carried the
  dead pre-contract singular `signature` shape (#284 predates the §7 fold),
  so the deploy tool's own `--verify` failed on the committed sample even
  before this change — regenerated in the frozen `signatures[]` shape as a
  separate corrective commit (deterministic tarballs reproduce
  byte-identically; only index.json moves; the throwaway TEST key stays in
  /tmp, never committed).
