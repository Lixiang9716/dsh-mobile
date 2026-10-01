# Agent Note: the android webclient byte-verify was vacuous — the #286 mirror drift rode a `./`-prefix SKIP hole, and the cross-host comparator now owns the family

Status: implemented
Related: D6, D9, the staging-manifests notes (2026-09-29), BUILD.md "The asset-mirror family"

## Problem

The #286-discovered drift — `presentation/web-client-next/web/js/timeline.js`
updated in #279 while the host mirrors stayed old — should have been
impossible: the `closures` gate runs `stage-spine-closure.sh --check`, whose
webclient loop byte-compares every product file against the android mirror.
Measured on 2026-10-01 (origin/main 11ba2f05): it was NOT impossible. An
injected mirror drift (`timeline.js` + one line) exited 0. The loop's
`find . -type f` emits `./`-prefixed paths; `is_tracked` got the needle
`webclient-next/./web/js/timeline.js`, `grep -cxF` matched nothing, and EVERY
webclient row took `note_skip` — the whole tree verified as part of the
"331 untracked-but-staged" count. Vacuous since #220 (the loop's birth);
the harmony twin was fine (`webclient_files` strips `./`), which is why only
the android copy went stale in the #279→#288 window. Separately, the android
scenario stage/verify twin lists had diverged: #254/#255 added
`ble-plane.js`/`mic-plane.js` to the stage roster but not the verify roster,
so `tools/gen-staging-manifests.mjs` (which parses both rosters and FATALs on
twin drift) exited 1 on main — the generator was red on the very tree its
note calls "round-trip holds".

## Decision

Three moves, one change.

1. Twin repair: the verify roster in `stage-spine-closure.sh` gains
   `ble-plane.js mic-plane.js` — `gen-staging-manifests.mjs` now exits 0 on
   the tree (`round-trip holds · 0 freeze-fatal row(s)`, measured before/after).
2. The `./` hole: the android stager's webclient check loop strips the
   `./` prefix (`rel=${rel#./}`) so `is_tracked` matches and the byte-compare
   actually runs. Re-measured: the same injected drift now fails `--check`
   loud (`::error::stage drift: webclient-next/web/js/timeline.js`), and the
   restored tree passes.
3. The comparison face the brief asked for: `tools/check-asset-mirrors.mjs`,
   the product-tree ↔ host-mirror comparator over the web-client family —
   every family mirror byte-compared in BOTH directions (stale, missing,
   extra) plus the iOS embedder's `WEBCLIENT_TREES` declaration vs the family
   (the D9 flip made generated freshness the iOS claim; the declaration is
   the committed part that can drift). Falsified on all four finding classes
   (stale/missing/extra mirror rows, declaration-missing — each exits 1 and
   names the row; restored tree exits 0). Wired as the warn-grade
   `asset-mirrors` gate (`allowFailure`, `needs: [self-test]`, paths scoped
   to the family + the tool), with its rule-6 rejection case at
   `.gov/rejections/case-asset-mirrors.sh` (mutation window under the shared
   live-tree lock; self-test green, 0.6s). The blocking teeth stay in
   `closures` (move 2 made them real again); the comparator is the named
   cross-host surface. BUILD.md gains the discovery section; the gates.json
   re-baseline is the recorded `verify-plane --write` ritual of this change.

## Alternatives considered

- Fixing only the `./` hole and skipping the comparator: lost — the brief
  asks for a discoverable comparison face, and the per-host `--check` loops
  remain three separate scripts with no surface that answers "does EVERY host
  face of this product tree carry the same bytes?" in one run.
- A blocking (non-`allowFailure`) gate: lost for now — the gate is new and
  the family policy (which presentation trees must mirror) is declared, not
  derived; day-one warn grade with a proven rejection case follows the
  staging-check adoption path (flip blocking once the baseline has cooled).
  The residual risk is bounded: the android/harmony byte-drift direction is
  ALREADY blocking via `closures`.
- Globbing every `presentation/web-client-*` tree into the family: lost —
  `web-client` (v0), `web-client-mini`, `lynx-client`, `official-web` are
  deliberate single-surface deploys; globbing would make the tool cry wolf on
  day one. The family is a declared policy row (matching the stagers' own
  `next whale` lists); other trees surface as informational
  `outside-family` rows, and whether a new tree must mirror stays a human call.
- Making the comparator regenerate the iOS C arrays and byte-compare them:
  lost — that duplicates the `closures` gate's gen.sh claim (deterministic
  regen from the product tree), drags the vendor-pin materialization into a
  warn gate, and adds nothing the declaration check plus closures miss.

## Consequences

The `untracked-but-staged` skip count drops by the webclient tree (~70
files), so the count finally means what it says. The known-residual class:
a product tree OUTSIDE the declared family still mirrors nothing — named
informationally, not gated.
