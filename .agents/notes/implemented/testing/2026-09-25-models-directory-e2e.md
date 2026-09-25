# The models 设置页 gets its own one-to-one e2e (scenario `models.directory`)

Status: implemented

Date: 2026-09-25 · Class: testing · Follows: the models-page fix
(`e230ce1`, branch `fix/models-page-api-surface`) and the coverage-plane
note (2026-09-24, the llm directory rows).

## Problem

The models-page contract — the provider directory row
(`llm/listConfigurableProviders`), the settings mirror it renders from,
the page's write path, and the credential round-trip — was asserted only
inside `runtime/spike/scenario/api-coverage-probe.js`: in-script `demand()`
calls, run by hand through `dsh-spike-cli`. It had no scenario manifest, no
committed evidence dir, no runner, and no gate: nothing failed a PR that
broke the directory row again. The delivered `composer-live-write`
manifests could not absorb the claim either — they are frozen to the
historical claim row set (the 2026-09-24 note records that constraint), and
their `rpc.observed` rows pin only the `credentials/describe` +
`session/modelCatalog` forwarding facts, not the directory row.

## Decision

A dedicated CLI proof, the `settings-surfaces` pattern for an
official-client surface:

- `runtime/spike/scenario/models-directory.js` — scenario
  `models.directory`; boots the mobile profile with the route provider
  staged, creates the write surface with `fullCoverage: true` (so the llm
  directory and the credential write half are claimed exactly as the
  coverage plane claims them), and walks the page's five data legs:
  directory row, settings mirror (describe: staged base layer + free user
  layer), page write (mutate into the user layer over the intact base,
  revision +1), credential round-trip (set → describe → unset → describe,
  values never answered back), model catalog. One `completed` event names
  the upstream pin.
- `test/e2e/scenarios/models-directory.json` — the one-to-one manifest
  (6 events, ordered, subset field matchers).
- `runtime/spike/ci/run-models-directory-e2e.sh` — the runner: vendored
  closure ensure → spike CLI run → `check.mjs` verdict → evidence dir
  `runtime/spike/artifacts/macos-cli-models-directory/` (logs.txt +
  scenario.jsonl + verdict.json + receipt.json) → the key audit (the
  staged credential and the round-trip secret must appear nowhere in the
  raw log).
- `docs/e2e-matrix.md` + `.zh.md` — the coverage row, the inventory row,
  and the totals re-run against this tree (44 dirs / 92 verdicts / 43 of
  43 scenario ids green-covered / 35 manifests).

## Alternatives considered

- **A manifest over the existing api-coverage-probe run** (its ~10 phase
  events, models legs enriched): rejected — the manifest would pin the
  WHOLE coverage surface, a superset of the models claim, and the probe's
  phase payloads are summary-shaped; every probe evolution would churn the
  manifest. The focused scenario gives the matrix a named
  `models.directory` row and leaves the probe free to evolve.
- **A device leg via `-dsh-scenario models-directory`**: rejected for this
  change — the iOS launch config resolves scenario names through a closed
  `switch` (`fatalError` on unknown), so a device scenario costs a Swift
  change plus a three-host closure regen. The page's on-device data plane
  is already pinned by `composer-live-write` on three hosts; this gap was
  the unmanifested assertion, and the CLI leg closes it. A device leg
  stays open as follow-up.
- **Editing the frozen b4 manifests** to add the directory row: rejected —
  the manifest freeze is the documented constraint; new claims ride their
  own scenario.

## Consequences

The models-page data plane is machine-checked on every PR through the
`e2e-matrix` gate (the evidence dir ships in this change), not on manual
honor. The manifest pins `upstream: 0.1.6-alpha.2` in the completed event,
so the 0.1.7 re-pin will fail this leg loudly until its verdict is
re-captured — that is the point. The pre-existing staleness of the
coverage table's display-name rows (e.g. `b3.session.live` vs the verdict
id `session.live-read`) is noted in the currency block as residue, not
silently rewritten.
