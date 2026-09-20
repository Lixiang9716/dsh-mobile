# Cross-host E2E evidence matrix

English | [简体中文](e2e-matrix.zh.md)

Consolidated acceptance evidence for every E2E claim across the four hosts
(iOS, Android, HarmonyOS, macOS CLI), built from the committed artifacts
dirs. Machine-checked by [tools/e2e/matrix.mjs](../tools/e2e/matrix.mjs).

> **Currency**: this matrix reflects `origin/main` as of commit `1914412`
> (audited 2026-09-20). It is REGENERATED, not maintained by hand:
>
> ```sh
> node tools/e2e/matrix.mjs              # exit 0 = inventory clean
> node tools/e2e/matrix.mjs --out /tmp/inv.json   # machine inventory
> ```

## The acceptance bar

Every E2E claim in this repository is accepted only when ALL of the
following hold:

1. **Green one-to-one log comparison** — a `verdict*.json` produced by
   `tools/e2e/check.mjs` with `pass: true`, `expected == logged`
   (exact, ordered, nothing missing, nothing extra).
2. **Screenshots are debugging artifacts** — never checker inputs; under
   an evidence dir they must be real PNGs (magic bytes).
3. **Complete deliverables** — `logs.txt` + `scenario.jsonl` +
   `verdict*.json` + `receipt.json` committed under the right artifacts
   dir.

## Totals (this tree)

| Metric | Value |
| --- | --- |
| Evidence dirs | 15 |
| Verdicts (all `pass: true`, `expected == logged`) | 29 |
| Scenarios with at least one committed evidence dir | 13 of 13 manifests |
| Screenshots verified PNG | 25 |
| Acceptance-bar findings | 4 (below) |

## Coverage matrix — scenario × platform

Cell = green verdicts (`expected/logged` at capture time); dirs in
[the inventory](#evidence-dir-inventory). A dash means no committed
evidence on that platform.

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `m1.spike.boot` | 9/9, 7/7 | 9/9, 7/7, 7/7 | 9/9, 7/7 | 9/9 |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6 | — (gap 4) |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.session` | 23/23, 23/23 | 22/22 (drift), 23/23 | 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | — (in flight) | — | 22/22 |
| `m3.complete` | — | — | — (in flight) | 41/41 |
| `m2.upstream-session` | — | — | — | 23/23 |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20 | — |

All 13 scenario manifests have at least one green committed evidence dir;
`m2.session` runs green on all four hosts. Every verdict on main is green.

## Evidence-dir inventory

`logs` / `scen` / `rcpt` = `logs.txt` / `scenario.jsonl` / `receipt.json`
present. `shots` = PNG count (all magic-verified except where noted).

| Dir | Platform | Verdicts (`expected/logged`) | logs | scen | rcpt | shots |
| --- | --- | --- | --- | --- | --- | --- |
| `hosts/ios/artifacts/m1-spike` | iOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m1-carrier` | iOS | m1.carrier.loopback 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m2-gateway` | iOS | m1.spike.boot 7/7, m1.carrier.loopback 7/7, m2.gateway.audit 16/16, m2.gateway.binding 19/19 | ✓ | ✓ | ✗ (gap 1) | 7 |
| `hosts/ios/artifacts/m2-session` | iOS | m2.session 23/23, m2.webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-pluginization` | iOS | m2.session 23/23, m3.ui-swap 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22 (drift) | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✗ (gap 2) | ✓ | 2 (gap 3) |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | m2.upstream-session 23/23 | ✓ | ✓ | ✓ | 0 |

CLI hosts are headless: zero screenshots is compliant (bar clause 2 makes
screenshots optional debugging aids, never deliverables or inputs).

## Known gaps (honest list)

The checker (`tools/e2e/matrix.mjs`) currently exits non-zero on exactly
these; they are listed here instead of fixed because each sits in an
owned/in-flight area or is not trivially fixable:

1. **`hosts/ios/artifacts/m2-gateway/` has no `receipt.json`** — the dir
   predates the #26 receipt convention. iOS-owned area (worker mid-flight
   at audit time); not fixed here.
2. **`hosts/harmony/artifacts/m5-host/` has no `scenario.jsonl`** — the
   extractor step was not committed for this run. Regenerating it needs
   the Harmony runner on a device (synthesizing one from `logs.txt` would
   be evidence fabrication); left to the Harmony owner.
3. **Two harmony screenshots are JPEG data under `.png` names** —
   `hosts/harmony/artifacts/m5-host/m5-binding-complete.png` and
   `m5-live-deltas.png` start `ffd8ffe0`, not the PNG magic. The images
   render fine; renaming would break doc links, so the Harmony owner
   should re-emit (or rename + fix references) in their stream.
4. **`m2.bridge.smoke` has no committed macOS CLI evidence** although the
   CLI is the scenario's canonical host per the e2e README; current
   committed verdicts are Android (`m4-host`, `m4-complete`) and Harmony
   (`m5-host`). Open for whoever next runs the CLI spike.

### Informational, not failures

- **Manifest-revision drift** (5 verdicts): `m1.spike.boot` was captured
  at 9 events in `hosts/{ios,android,harmony}/artifacts/m1-spike/` and
  `runtime/spike/artifacts/macos-cli/`, but the current manifest declares
  7; `hosts/android/artifacts/m4-host/` captured `m2.session` at 22
  events vs the current 23. Verdicts are capture-time records; older logs
  are not guaranteed to re-verify against a grown manifest. The checker
  reports `drift: true` and does not fail on it.
- **In flight at audit time (excluded)**: `hosts/android/artifacts/m3-android-install/`,
  `hosts/harmony/artifacts/m5-complete/`,
  `runtime/spike/artifacts/macos-cli-m2-llm/`. When they land, regenerate
  this matrix (`node tools/e2e/matrix.mjs`) — their gaps become this
  doc's findings automatically.

## The checker and its rejection proof

`tools/e2e/matrix.mjs` (stdlib-only) regenerates the inventory from the
working tree and exits non-zero on any regression: failed verdict,
missing/empty deliverable, broken PNG, malformed verdict/receipt, or a
scenario id without a manifest in `tools/e2e/scenarios/`. Its
`--self-test` mode proves every rejection class actually rejects
(8 assertions, rule 6) — the assertion set is documented in the
[e2e README](../tools/e2e/README.md#inventory-matrix-matrixmjs).

The checker is deliberately **not wired into `gates.json`**: the current
findings above are real regressions against the acceptance bar, and the
decision to gate on the matrix belongs to the plane seal, after the
owned gaps are closed.
