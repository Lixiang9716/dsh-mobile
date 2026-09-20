# Cross-host E2E evidence matrix

English | [简体中文](e2e-matrix.zh.md)

Consolidated acceptance evidence for every E2E claim across the four hosts
(iOS, Android, HarmonyOS, macOS CLI), built from the committed artifacts
dirs. Machine-checked by [tools/e2e/matrix.mjs](../tools/e2e/matrix.mjs).

> **Currency**: this matrix reflects `origin/main` as of commit `ca644a0`
> (rows for `b3.session.live` refreshed and its receipt gap closed
> 2026-09-21 by the W-RECEIPT evidence closure; the five D9 dirs
> `android-upstream` / `d9-official-web` / `b4-write-live` /
> `android-session-live` / `d9-session-live` entered the inventory with
> #63/#64/#65/#66/#67;
> totals re-run against this tree). It is
> REGENERATED, not maintained by hand:
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
| Evidence dirs | 25 |
| Verdicts (all `pass: true`, `expected == logged`) | 51 |
| Scenarios with at least one committed evidence dir | 24 of 24 manifests |
| Screenshots verified PNG | 53 |
| Acceptance-bar findings | 6 (below) |

## Coverage matrix — scenario × platform

Cell = green verdicts (`expected/logged` at capture time); dirs in
[the inventory](#evidence-dir-inventory). A dash means no committed
evidence on that platform.

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `b-android.official-web.mount` | — | 14/14 | — | — |
| `b-android.session.live` | — | 46/46 | — | — |
| `b-harmony.httpfetch-v2` | — | — | 6/6, 6/6 | — |
| `b-harmony.official-web-mount` | — | — | 17/17, 17/17 | — |
| `b-harmony.session.live` | — | — | 43/43 | — |
| `b1.official-web.mount` | 14/14 | — | — | — |
| `b3.session.live` | 46/46 | — | — | — |
| `b4.write.live` | 43/43 | — | — | — |
| `m1.spike.boot` | 9/9, 7/7 | 9/9, 7/7, 7/7 | 9/9, 7/7, 7/7 | 9/9 |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6, 6/6 | 6/6 |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.session` | 23/23, 23/23 | 22/22 (drift), 23/23 | 23/23, 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m2.upstream-session` | — | — | — | 31/31 |
| `m2.upstream-boot` | — | — | — | 12/12 |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | — | — | 22/22 |
| `m3.complete` | — | — | — | 41/41 |
| `m3.fetch-install` | 46/46 | — | — | — |
| `m3.fetch-carrier` | 11/11 | — | — | — |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20, 20/20 | — |

All 24 scenario manifests have at least one green committed evidence dir;
`m2.session` runs green on all four hosts. Every verdict on main is green.

## Evidence-dir inventory

`logs` / `scen` / `rcpt` = `logs.txt` / `scenario.jsonl` / `receipt.json`
present. `shots` = PNG count (all magic-verified except where noted).

| Dir | Platform | Verdicts (`expected/logged`) | logs | scen | rcpt | shots |
| --- | --- | --- | --- | --- | --- | --- |
| `hosts/android/artifacts/android-upstream` | Android | b-android.official-web.mount 14/14 | ✓ | ✓ | ✗ (gap 4) | 4 |
| `hosts/android/artifacts/android-session-live` | Android | b-android.session.live 46/46 | ✓ | ✓ | ✗ (gap 5) | 4 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22 (drift) | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/d9-official-web` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17 | ✓ | ✓ | ✗ (gap 3) | 4 |
| `hosts/harmony/artifacts/d9-session-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43 | ✓ | ✓ | ✗ (gap 6) | 6 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b1-official-web` | iOS | b1.official-web.mount 14/14 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b3-session-live` | iOS | b3.session.live 46/46 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b4-write-live` | iOS | b4.write.live 43/43 | ✓ | ✓ | ✗ (gap 2) | 3 |
| `hosts/ios/artifacts/m1-carrier` | iOS | m1.carrier.loopback 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m1-spike` | iOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m2-gateway` | iOS | m1.spike.boot 7/7, m1.carrier.loopback 7/7, m2.gateway.audit 16/16, m2.gateway.binding 19/19 | ✓ | ✓ | ✗ (gap 1) | 7 |
| `hosts/ios/artifacts/m2-session` | iOS | m2.session 23/23, m2.webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-complete` | iOS | m3.fetch-carrier 11/11, m3.fetch-install 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-pluginization` | iOS | m2.session 23/23, m3.ui-swap 7/7 | ✓ | ✓ | ✓ | 3 |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-bridge-smoke` | macOS CLI | m2.bridge.smoke 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-boot` | macOS CLI | m2.upstream-boot 12/12 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | m2.upstream-session 31/31 | ✓ | ✓ | ✓ | 0 |

CLI hosts are headless: zero screenshots is compliant (bar clause 2 makes
screenshots optional debugging aids, never deliverables or inputs).

## Known gaps (honest list)

The checker (`tools/e2e/matrix.mjs`) currently exits non-zero on exactly
six findings: one carried re-run-blocked receipt (gap 1) and five
receipts pending their dirs' first post-landing host re-run (gaps 2–6,
each owned by the host work stream that landed the dir with
#63/#64/#65/#66/#67).

1. **`hosts/ios/artifacts/m2-gateway/` has no `receipt.json`** — the dir
   predates the #26 receipt convention. Its four committed verdicts are
   green and its evidence is otherwise complete, produced by a fully
   green WDA run; only the receipt is missing, and the receipt must come
   from a real run (never synthesized). The 2026-09-21 closure attempt
   made the diagnosis precise and retired half the blocker: the
   WebDriverAgent runtime is HEALTHY again (the runner's `wda_up` probe
   was silently broken by the WDA rebuild's pretty-printed `/status`
   JSON — fixed in run-ios.sh along with the picker search-field
   calibration, both surprise-recorded), and with WDA up the run
   reproduces every in-app leg green (boot, carrier, all gateway/fs/http
   primitives — events 0–7 one-to-one) up to `presentPicker`. The
   remaining blocker is the Files-provider search index: the pre-staged
   `notes.txt` surfaces as a search result seconds after one staging
   (04:55 probe) but returns 未找到相关结果 when the file is rewritten
   immediately before the drive (04:58 run) — rewriting the pre-stage
   target knocks it out of the index until re-index completes. The
   receipt belongs to the next run whose pre-stage lets the index settle
   (stage once, don't rewrite, or allow settling time); per the rerun
   protocol the stall was recorded, not retried
   (surprise signatures `drivepickers-ptsearch-calibration-201126`,
   `drivepicker-can-focus-the`, and the 04:58 record; process note
   `2026-09-20-run-ios-sh-rerun-protocol-under-a-degrad`).
2. **`hosts/ios/artifacts/b4-write-live/` has no `receipt.json`** — the
   dir landed with #65 (the session-write surface); the receipt is
   owned by the b4 work stream's next `run-ios-b4.sh` run on a tree
   carrying #65.
3. **`hosts/harmony/artifacts/d9-official-web/` has no `receipt.json`**
   — the dir landed with #64 (the harmony webServer carrier); the
   receipt is owned by the harmony work stream's next host re-run.
4. **`hosts/android/artifacts/android-upstream/` has no `receipt.json`**
   — the dir landed with #63 (the android official-web boot); the
   receipt is owned by the android work stream's next host re-run.
5. **`hosts/android/artifacts/android-session-live/` has no
   `receipt.json`** — the dir landed with #66 (the android session.live
   spine, b-android.session.live 46/46 green); the receipt is owned by
   the android work stream's next host re-run.
6. **`hosts/harmony/artifacts/d9-session-live/` has no `receipt.json`**
   — the dir landed with #67 (the harmony session.live spine,
   b-harmony.session.live 43/43 green); the receipt is owned by the
   harmony work stream's next host re-run.

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

### Closed by the 2026-09-21 receipt closure (fix/receipt-gaps)

- **b3-session-live receipt** — closed by a real `run-ios-b3.sh` re-run
  on final main (fresh worktree at `618f2f8`): b3.session.live 46/46
  green (expected == logged, exit 0), evidence refreshed from the run,
  and `receipt.json` authored from it in the established evidence
  format. (The first cold-worktree run exposed a runner ordering gap —
  the bundle build needs the vendored DSH closure that the runner only
  stages at step 4b, after the build; materializing
  `runtime/spike/vendor/ensure-dsh.sh` before the runner is the
  workaround, surprise-recorded.)

## Informational, not failures

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

The checker is deliberately **not wired into `gates.json`**: six owned
findings above remain open (the m2-gateway receipt, blocked on a
file-provider-index-healthy picker leg per the rerun protocol, and the
five D9-era receipts blocked on their hosts' next re-runs), and the
decision to gate on the matrix belongs to the plane seal.
