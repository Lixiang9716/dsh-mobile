# The staging-manifest round-trip: the four hand lists vs the derived reality (2026-09-29)

English | [简体中文](staging-manifest-roundtrip.zh.md)

The per-host staging manifests are hand lists (harmony's `Index.ets`
BUNDLE_FILES, harmony's `ci/vendor-official.sh` CLOSURE/SPINE_OURS, android's
`ci/stage-spine-closure.sh` lists, iOS `Tools/gen_bundle_header.py`
RESOURCES/TREES). The ledger's step one shipped `tools/check-staging.mjs`,
which proves graph→list in one direction. Step two — this file's subject — is
`tools/gen-staging-manifests.mjs`: it derives what each manifest must name
from reality and reports the round-trip delta. **Phase 2 ships the generator
as evidence only; the committed manifests are not replaced.** Flipping the
flow (the hosts' blocks emitted from the generator, wired into the stagers)
is the post-hardening step.

All numbers below are from one run on the tree at the commit that carries
this file:

```
node tools/gen-staging-manifests.mjs --out /tmp/gen-out
```

## 1. The verdict: the round-trip holds

`staging-generate: round-trip holds · 0 freeze-fatal row(s)` (exit 0). Every
row the derivation legs demand is present in the committed manifests — the
fresh-install freeze class has zero instances today. The tool's rejection
case is real, not vacuous: adding one shim to the boot graph outside the
manifests (a scratch file imported from `upstream/boot.js`) trips
`FATAL harmony BUNDLE_FILES missing graph row: …` and exit 1; reverting the
mutation restores exit 0. It fired during development and caught exactly that
class.

## 2. What the derivation covers

Derivation legs (mechanics in `tools/gen-staging-legs.mjs`):

- **graph** — check-staging's own `walkGraph` over each host's roots
  (121 files reached for harmony);
- **dshpins** — the dsh pin-name roster the three stagers jointly declare
  (SPINE_PKG_DSH ∪ android's stage loop ∪ iOS TREES comprehension + the dsh
  pins iOS RESOURCES names), expanded over the materialized trees by the
  `stage_pkg` rule (package.json + lib/** − .d.ts + presets/**), with the
  npm-face aliases (tool-present family) expanded at their vendor/dsh
  spelling;
- **pinfiles** — noble *.js, pi-ai js+json, the goal trio js+json, and zod's
  runtime closure **recomputed by walking the pin's own import graph**;
- **closure-faces** — the npm single-file faces, taken verbatim from
  vendor-official.sh's CLOSURE rows (policy, not re-derived);
- **webclient** — presentation/web-client{,-next,-whale} at their staged
  names.

Result per manifest:

| surface | committed | derived | missing (would freeze) | extra (not derived) |
|---|---|---|---|---|
| harmony BUNDLE_FILES | 930 unique | 897 | **0** | 33, all classified |
| android stage-spine-closure | 15 scenario rows + mirrors | — | 0 (graph fully under mirrors ∪ roster) | — |
| iOS RESOURCES | 69 | 46 graph-derived | 0 | 23 policy rows, classified |
| iOS TREES | 73 mirror roots | — | 0 absent on disk | — |

Cross-manifest agreement the tool now proves on every run: the zod closure
exists as THREE hand copies (BUNDLE_FILES, the harmony CLOSURE, iOS
ZOD_FILES) and all three equal the recomputed 79-row closure, byte-for-byte
in set terms. Android's stage/verify twins (scenario, dsh, npm lists) agree;
no declared pin is absent on disk.

## 3. The delta, itemized — each entry: generator limit or manifest typo

Honesty first: the generator does NOT reproduce the committed bytes. The
round-trip that holds is set-level and attribution-level. The residue:

1. **312 duplicate rows in BUNDLE_FILES** (1242 raw → 930 unique). Manifest
   artifact, not a generator defect: entire spine groupings are pasted twice
   (every `upstream-suite-leg.js`-era row appears in two generations of the
   list). Harmless today — every consumer dedupes (`check-bundle-files`
   counts 930) — but it is the visible sediment of hand maintenance, and it
   is exactly what generation removes by construction.
2. **Ordering.** The committed list is arrival-ordered; the generator emits
   canonical sorted rows. The graph cannot dictate order, so this is
   generator policy, not a defect on either side. Phase 3 makes the sorted
   order THE order.
3. **33 committed rows no leg derives** — each classified by the tool:
   - 17 `upstream/shims/*` rows (crypto, os, path, node-module, util-types,
     the child-process/stream/zlib family…): **host-loader namespace** —
     reached through the C bare map and the `__dshModuleDefine`
     registrations, which are DATA the JS walk deliberately cannot see.
     Not a typo; the generator would need the per-host C tables (or a
     declared shim namespace policy) to derive them.
   - 8 plugin `manifest.json` rows + `dsh-device-plane/index.js`:
     **runtime-data** — the plugin loader reads manifests; no import edge
     exists.
   - `e2e-stage.js`: **e2e-harness** — staged for the runner's own load,
     not reached from the boot graph.
   - 4 util-crypto doc rows (LICENSE + three READMEs) and 2 npm-face rows
     (cordis-plugin-loader/include `lib/index.js`): util-crypto is staged
     under a pin shape NO sibling pin uses (docs/LICENSE rows) — the one
     entry this audit calls a probable manifest inconsistency, harmless
     (rawfile holds the bytes) but worth a look at the next vendor touch.
     The two npm-face rows are the loader bridge's resolution, mis-filed
     under the vendor-shape bucket by the classifier's current regex; the
     fix is mechanical.
4. **31 counted coverage misses on the harmony CLOSURE/SPINE_OURS advisory
   surface** — known and deliberate: that list stages the narrower
   officialweb+spine closure, so graph rows outside it are context, never a
   verdict (the gate runs the surface advisory for exactly this reason).

## 4. What this does NOT claim

- The manifests are not replaced and the vendor flow is untouched — Phase 2
  is evidence.
- The 31 unstaged android scenarios are host policy (the roster is the
  policy), not gaps; the tool restates rosters, it does not invent them.
- The 10 on-disk shims BUNDLE_FILES does not name (string-decoder,
  slot-registry, node-sqlite, …) are justified only by the host-loader
  namespace today. If a future C bare-map row points at one, nothing in the
  JS tree catches it — that blind spot is the strongest argument for the
  Phase 3 flip plus a declared shim-namespace policy.

## 5. Reproducing

```
runtime/spike/vendor/ensure-dsh.sh          # materialize the vendored pins
sh hosts/harmony/ci/vendor-official.sh --closure-only   # rawfile closure
node tools/gen-staging-manifests.mjs --out /tmp/gen-out  # this report's numbers
node tools/check-staging.mjs --block harmony,android,ios # the verifier, green
```
