# Node-surface line coverage — vitest, the aggregate runner, the coverage-floor gate

English | [简体中文](test-coverage.zh.md)

This repo's real behavior-coverage net does not run through a coverage
tool: 681 upstream official specs pressed against the QuickJS runtime and
the self-built shims, plus the e2e evidence matrix and the gov gates.
Line coverage complements that net on exactly one axis — **the Node-testable
surface of code we own** — and this page is its contract: what is measured,
what is honestly NOT measured, and the warn-tier floor gate that watches it.

## Run it

```sh
sh tools/test/run-coverage.sh          # per-surface vitest run + one aggregate table
sh tools/test/run-coverage.sh --check  # the same, then enforce the floors (exit 1 below floor)
```

The runner walks the surface registry (top of `tools/test/run-coverage.sh`),
installs the surface's dev deps when missing, runs each suite with the v8
provider (reporters: text + lcov + json-summary), and prints the aggregate
table from the json-summary reports. Single surface, by hand:

```sh
npm --prefix presentation/lynx-client run test:coverage
```

## Measured baseline (2026-09-30, vitest 4.1.11 + @vitest/coverage-v8 4.1.11)

| surface                 | lines | branches | tests |
|-------------------------|------:|---------:|------:|
| presentation/lynx-client | 84.2% |    66.5% | 36/36 |

## The floors and the warn gate

`tools/test/coverage-floors.json` pins each surface's floor at
**measured − 5 points** (lynx-client today: lines 79.2, branches 61.5) —
an honest floor that flags real regressions while tolerating normal drift.
The `coverage-floor` gate in `gates.json` runs
`sh tools/test/run-coverage.sh --check`, scoped to the surface tree, with
`allowFailure: true` — **warn-tier: a red floor is recorded, never
blocking**. Its rule-6 rejection case
(`.gov/rejections/case-coverage-floor.sh`) proves the teeth fully
sandboxed — the floors registry is copied to a temp dir and the forged
summaries live under a temp measurements root (`--floors` /
`--measurements-root`), so no mutation window ever opens on the real tree
(a killed case leaves no residue by construction): floors bumped to 100%
go red with the surface named, the same state stays advisory without
`--enforce`, the real floors bite a low measurement, and an above-floor
state passes. The runner itself is POSIX sh on purpose — the gate argv
invokes it through `sh`, and govrail execs that argv without a shell, so
CI's dash must be able to run it (arrays and `pipefail` would be syntax
errors there).

To lower a floor legitimately: re-measure, move the floor to
new-measured − 5, and say why in the PR (a floor moved without a measured
basis is drift, not maintenance).

## Honest boundaries — what is NOT counted, by name

Inside `presentation/lynx-client` the vitest coverage includes only
`driver/**` + `shared/**` (the seam libraries the suite exercises):

- `bundle/` — the ReactLynx render face runs on the Lynx engine, not Node.
  Pretending node-side line coverage there would lie the way node-side
  coverage of QuickJS-bound shims lies.
- `driver/driver.js`, `driver/skin-*.js`, `driver/run-*.mjs`,
  `driver/mock/mock-serve.mjs` — the CLI/e2e face, imported only by the
  entrypoints; the full driver loop through both skins is exercised by
  `test/e2e/run-cli-lynx-mount.sh` (stub and lynx receipts on file).
- `theme/gen.mjs` — owned by the `theme:check` script gate.

Whole surfaces deliberately not registered:

- `test/upstream-suite` — its vitest config runs the UPSTREAM harness's own
  specs against the vendored closure (the same spec families the CLI suite
  runs through the QuickJS-shaped harness). Coverage there would measure
  pinned upstream code under Node semantics — not our line coverage, and
  not the CLI suite's behavior proof either.
- `presentation/web-client*` — plain browser JS with no runner and no
  tests; `import` of `main.js` fails on Node (`document is not defined`).
- `runtime/spike` (QuickJS runtime + shims) — the shipped semantics are
  QuickJS's; the behavior net owns them.

## Adding a surface

1. Give the surface a vitest config whose `coverage.include` names its
   Node-testable product code (exclude `node_modules/`, `artifacts/`,
   `dist/`, and every boundary you can name).
2. Add the directory to `SURFACES` in `tools/test/run-coverage.sh`.
3. Run the runner once, read the real numbers, set the floor in
   `tools/test/coverage-floors.json` to measured − 5.
4. The gate already watches every registered surface — no gates.json edit
   needed.
