# Agent Note: the android and ios staging manifests join the generated, gate-enforced store

Status: implemented
Related: D9, T-0050 (item 4, second increment — completes the card), the 2026-10-08
harmony consolidation note (first increment)

## Problem

The staging manifests were hand-maintained in four places. The first increment
consolidated harmony's BUNDLE_FILES only, and its scope-honesty section named
the rest: the android stager's scenario/web-live for-in lists and the iOS
embedder's RESOURCES/TREES blocks stay hand-edited, so their failure class
stayed live — a roster row forgotten (or typo'd) on one host passes every local
run (the file is on the dev disk) and dies as a fresh-install freeze, and
nothing compares the committed list to anything except the import-graph
walk's own output. The iOS TREES block additionally buried its pin choices in
comprehensions that only a bespoke JS re-parser (expandPyTrees in
check-staging-hosts.mjs) can read — and that parser provably misread one row
shape (see Consequences).

## Decision

- `tools/gen-staging-emit-hosts.mjs` (new; the code-size gate splits it from
  the CLI) carries the android + ios halves of the consolidation.
  `gen-staging-emit.mjs --emit|--check` now runs all three hosts.
- android: `android-scenario.rows` / `android-web-live.rows` are the generated
  rosters = policy ∪ (transitively-reached − excluded). The staged ENTRIES are
  host policy no derivation can mint — `android-*.policy.rows` carries them
  (first emit harvested the committed lists; a new entry is a hand row) —
  while a scenario file a staged entry IMPORTS joins automatically (the
  embed-list trap class). The exclude files are legitimately absent while
  empty. The stager's four for-in headers are machine-spliced on membership
  change (order-preserving, twins spliced from the one list); `--check` fails
  on any drift between the derivation, the rows files, and the script.
- ios: the accessor suffixes (Swift links against `dsh_runtime_res_<suffix>`)
  and pin choices are policy no derivation can mint, so `ios-RESOURCES.rows`
  (`<suffix>=<rel>`, `repo:` prefix for repo-root files) and `ios-TREES.rows`
  (`<bundle-rel>=<source-rel>`) are the DECLARED source — block order kept,
  because the emitted C arrays and the tree walk consume it and a reorder
  would churn the committed Generated sources — and the py blocks are
  machine-materialized from them (RESOURCES flattened to one row per line;
  TREES' comprehensions expanded to concrete pairs, continuations gone).
  `--check` enforces blocks ≡ rows files, unique suffixes, and every named
  path on disk. Graph coverage (a reached row no RESOURCES row names and no
  TREES mirror covers) stays with check-staging's ios surface, blocking
  earlier in the DAG.
- gates.json: staging-generated's paths gain the android stager, the ios
  embedder, the new satellite, and the rows store; staging-check gains
  gen_bundle_resources.py + the rows store as triggers. Plane re-sealed
  (verify-plane --write, recorded); the two standing cards re-pinned.
- First emit measured byte-honest: the android script needed NO change
  (membership already matched — the splice rewrites only on drift), and the
  ios generator re-run produced the committed SpikeBundle.c/.h unchanged
  (1276 tree files, 11373954 bytes — identical to the pre-flattening run).

Scope honesty: the harmony vendor-official.sh CLOSURE rawfile staging remains
CLOSURE-driven (its rows are find-generated at stage time; the pin CHOICE is
the script's own declaration) — unchanged from the first increment's verdict.
The vendor-pin promotion (deriving the vendored file rows instead of carrying
them as policy) is still the second named follow-up, now spanning the android
pkg/npm rosters too.

## Alternatives considered

- Splicing the android lists in committed order AND reformatting them
  (4-per-line): shipped as the drift-path only — the first emit proved a
  no-op, so the PR carries zero .sh churn and the hand wrapping survives
  until a membership change actually rewrites the header.
- Harvesting ios-TREES.rows mechanically from the comprehensions (the
  harmony first-emit-capture pattern): lost — the expansion needs the same
  comprehension parser the consolidation is retiring; a transcription done
  once by hand and verified three ways (set equality against buildHosts,
  check-staging parse parity, generator byte-identity) is the honest
  one-time cost. The tool now fails loud when a declared rows file is
  missing instead of pretending to harvest one.
- Teaching expandPyTrees the `%`-format shape instead of flattening: lost —
  the shape is gone from the tree, the gate rejects its return (a
  comprehension row no longer parses as a flat row), and a parser fix for a
  dead form is dead code. The misread is recorded in the surprises ledger.

## Consequences

A new scenario import or web-live product file now needs ZERO android hand
edits beyond the entry decision it genuinely is; a new ios embed needs one
declared row (the accessor suffix or pin choice — irreducibly hand) and the
gate forces it loudly instead of trusting the block. A maintainer editing a
py block or a for-in list by hand gets a red staging-generated gate naming
the remedy. Found on the way: check-staging's expandPyTrees misread the
sharp-engines comprehension as three `vendor/npm` mirror roots (the loop var
belongs on the source side too); benign while it lived — vendor/ rows sit
outside the gap-check scope — and now dead with the shape it misread.
