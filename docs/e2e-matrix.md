# Cross-host E2E evidence matrix

English | [简体中文](e2e-matrix.zh.md)

Consolidated acceptance evidence for every E2E claim across the four hosts
(iOS, Android, HarmonyOS, macOS CLI), built from the committed artifacts
dirs. Machine-checked by [tools/e2e/matrix.mjs](../tools/e2e/matrix.mjs).

> **Currency**: this matrix reflects `origin/main` as of commit `0e9e10f`
> (rows for `b1.official-web.mount` and `m2.upstream-boot` refreshed
> 2026-09-20 by the W-SHELL application-tier change; totals re-run against
> this tree). It is REGENERATED, not maintained by hand:
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
| Evidence dirs | 19 |
| Verdicts (all `pass: true`, `expected == logged`) | 34 |
| Scenarios with at least one committed evidence dir | 17 of 17 manifests |
| Screenshots verified PNG | 30 |
| Acceptance-bar findings | 1 (below) |

## Coverage matrix — scenario × platform

Cell = green verdicts (`expected/logged` at capture time); dirs in
[the inventory](#evidence-dir-inventory). A dash means no committed
evidence on that platform.

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `m1.spike.boot` | 9/9, 7/7 | 9/9, 7/7, 7/7 | 9/9, 7/7 | 9/9 |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6 | 6/6 |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.session` | 23/23, 23/23 | 22/22 (drift), 23/23 | 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | — (in flight) | — | 22/22 |
| `m3.complete` | — | — | — (in flight) | 41/41 |
| `m3.fetch-install` | 46/46 | — | — | — |
| `m3.fetch-carrier` | 11/11 | — | — | — |
| `m2.upstream-session` | — | — | — | 31/31 |
| `m2.upstream-boot` | — | — | — | 12/12 |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20 | — |
| `b1.official-web.mount` | 14/14 | — | — | — |

All 17 scenario manifests have at least one green committed evidence dir;
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
| `hosts/ios/artifacts/m3-complete` | iOS | m3.fetch-carrier 11/11, m3.fetch-install 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/b1-official-web` | iOS | b1.official-web.mount 14/14 | ✓ | ✓ | ✓ | 2 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22 (drift) | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✓ | ✓ | 2 |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-bridge-smoke` | macOS CLI | m2.bridge.smoke 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | m2.upstream-session 31/31 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-boot` | macOS CLI | m2.upstream-boot 12/12 | ✓ | ✓ | ✓ | 0 |

CLI hosts are headless: zero screenshots is compliant (bar clause 2 makes
screenshots optional debugging aids, never deliverables or inputs).

## Known gaps (honest list)

The checker (`tools/e2e/matrix.mjs`) currently exits non-zero on exactly
one finding; the four gaps the 2026-09-20 audit recorded are otherwise
closed.

1. **`hosts/ios/artifacts/m2-gateway/` has no `receipt.json`** — the dir
   predates the #26 receipt convention. A clean re-run to regenerate it
   is WDA-blocked: the WebDriverAgent runtime on the dsh-iphone iOS 26.5
   simulator is in its third recorded degradation (surprise signatures
   `run-iossh-regression-rerun-green` / `run-iossh-ui-drive-rerun-green`,
   process note `2026-09-20-run-ios-sh-rerun-protocol-under-a-degrad` —
   WDA's HTTP bridge refused connections again at the 2026-09-20 closure
   attempt). Per that protocol the re-run is skipped, not forced: the
   receipt belongs to the next healthy-WDA `tools/e2e/run-ios.sh` run.
   The dir's four committed verdicts are green and its evidence is
   otherwise complete.

### Closed by the 2026-09-20 evidence-gap closure (fix/evidence-gaps)

- **Gap 2 (harmony `scenario.jsonl`)** — closed by a full
  `hosts/harmony/ci/run-host-e2e.sh` re-run on this tree: all four
  verdicts re-matched the committed manifests (m1.spike.boot 7/7,
  m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20), and the
  runner now extracts `scenario.jsonl` from the run's own capture files
  (`grep -h '^dsh.spike.log:'` over sink + binding captures — the same
  extraction convention as the Android runner). The re-run required a
  one-line host fix: #53 bumped `dsh:util-crypto` to 0.1.6-alpha.2 in
  the loader path, manifest, and rawfile copy but not
  `Index.ets`'s `BUNDLE_FILES`, so a fresh launch died at
  `GetRawfileContent` before any scenario line was logged.
- **Gap 3 (JPEG bytes under `.png` names)** — the emulator's
  `snapshot_display` emits JPEG; the runner now converts the two
  screenshots in place with a documented `sips -s format png` step, and
  both re-captured files carry the real PNG magic.
- **Gap 4 (no macOS CLI evidence for `m2.bridge.smoke`)** — closed by a
  real headless run of the scenario's canonical host:
  `runtime/spike/artifacts/macos-cli-bridge-smoke/` carries logs.txt +
  scenario.jsonl + `verdict.json` (6/6, one-to-one) + receipt.json from
  `./build/dsh-spike-cli . scenario/m2-bridge-smoke.js`.

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

The checker is deliberately **not wired into `gates.json`**: one owned
finding above remains open (the m2-gateway receipt, blocked on a healthy
WDA runtime), and the decision to gate on the matrix belongs to the plane
seal.
