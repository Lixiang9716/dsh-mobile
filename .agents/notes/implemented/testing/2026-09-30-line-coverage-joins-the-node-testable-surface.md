# Agent Note: real line coverage joins the Node-testable surface, watched by a warn-tier floor gate

Status: implemented

## Problem

The repo had **zero line-coverage configuration** — `grep` for coverage in
vitest configs came back empty. The real behavior-coverage net (681 upstream
official specs against the QuickJS runtime + shims, ~107 e2e evidence rows,
19 gov gates) never measures line coverage, so the Node-testable surface we
own — the lynx-client driver seam, presentation logic — had no number at
all, and nothing would notice a test silently losing contact with a branch
of that code. The commissioning ask: wire real line coverage over the
Node-testable faces and give the numbers an honest, non-blocking floor.

## Decision

- **`presentation/lynx-client` is the first registered surface.**
  `vitest.config.ts` (new) adds coverage-v8 with text + lcov + json-summary
  reporters; test discovery stays at vitest's defaults, so not one existing
  assertion or test semantic moved (36/36 green before and after).
  `coverage.include` = `driver/**` + `shared/**` — the seam libraries the
  suite actually exercises. Measured 2026-09-30: **lines 84.2%, branches
  66.5%**.
- **`tools/test/run-coverage.sh`** is the aggregate runner: walks the
  surface registry, installs dev deps when missing, runs each suite with
  coverage, prints one table (surface / lines% / branches%) from the
  json-summary reports; `--check` enforces floors.
- **`tools/check-coverage-floor.mjs` + `tools/test/coverage-floors.json`**:
  floors sit at measured − 5 points (lynx-client: 79.2 / 61.5); a surface
  with a floor but no report fails loud (rule 5), never silently passes.
- **The `coverage-floor` gate** (gates.json, wired via `gov gate add`,
  `needs: [self-test]` hand-added — `gate add` exposes no `--needs`) is
  **warn-tier**: `allowFailure: true`, red is recorded, never blocking.
  Rule-6 case `.gov/rejections/case-coverage-floor.sh` proves the teeth
  (floors at 100% → red naming the surface; identical state advisory
  without `--enforce`; above-floor green; restore byte-identical). Before
  sealing, the falsification was run for real: `run-coverage.sh --check`
  with floors at 100 exited 1; floors restored (cmp byte-identical), exit 0.
  Plane re-sealed with the reviewed-change reason in the ritual ledger.
- **The honest boundary is part of the deliverable** (docs/test-coverage.md,
  bilingual): `bundle/` (Lynx-engine face), the CLI/e2e face
  (`driver.js`, `skin-*.js`, `run-*.mjs`, `mock-serve.mjs` — e2e-covered by
  `run-cli-lynx-mount.sh`), `theme/gen.mjs` (script gate); whole surfaces
  not registered — `test/upstream-suite` (its vitest runs the UPSTREAM
  harness's own specs against the vendored closure: pinned code under Node
  semantics, and NOT the 681-spec CLI suite), `presentation/web-client*`
  (browser JS; `import main.js` → `document is not defined`, no runner, no
  tests), `runtime/spike` (QuickJS semantics; the behavior net owns them).

## Alternatives considered

- **Also wire coverage on `test/upstream-suite`.** Rejected — its vitest
  targets vendored upstream specs; the numbers would measure pinned upstream
  code under Node semantics we don't ship, and materializing the vendor tree
  + running ~1135 spec files for numbers nobody can act on is cost without
  a decision attached. The upstream suite's proofs stay behavioral.
- **Make the floor gate blocking (`all` mode, no allowFailure).** Deferred —
  the ask named warn-tier explicitly, and the pairing/first-gate convention
  in this plane is advisory-until-baselined (rule 7's wording; the pairing
  gate ships the same shape). Flipping it hard later is a one-line edit and
  a re-seal once the numbers have settled.
- **A flat repo-wide percentage floor across all surfaces.** Rejected —
  it would let a hot surface's regression hide under a cold surface's
  surplus. Per-surface floors keep every face individually honest.
- **Count the untested 0% files (`driver.js`, skins) in the lynx-client
  number.** Rejected — those files' real behavior coverage lives in the e2e
  evidence net; counting them 0% here would understate true coverage and
  invite no-op unit tests written only to move the number (the testing iron
  law forbids exactly that).

## Consequences

The Node-testable surface now has a real, reproducible number and a floor
that flags real regressions without blocking anyone. Adding a surface is
three edits (vitest config, `SURFACES`, floors) — the gate already watches
the registry. Environment note: `gov self-test`'s two tree-mutating project
cases (`case-bundle-files.sh`, `case-staging-check.sh`) went red in this
fresh worktree until the vendored closure + harmony staged rawfile were
materialized (`runtime/spike/vendor/ensure.sh` +
`ensure-dsh.sh`, `vendor-official.sh --closure-only`) — recorded in the
surprise ledger; their green legs need the staged tree, which plain
checkouts lack until the ensure scripts run.
