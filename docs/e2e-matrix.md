# Cross-host E2E evidence matrix

English | [简体中文](e2e-matrix.zh.md)

Consolidated acceptance evidence for every E2E claim across the four hosts
(iOS, Android, HarmonyOS, macOS CLI), built from the committed artifacts
dirs. Machine-checked by [tools/e2e/matrix.mjs](../tools/e2e/matrix.mjs).

> **Currency**: this matrix reflects `origin/main` as of commit `49fce4f`
> (the release recipe #80 and the packaging pipeline #77 land no evidence
> dirs; on top of the harmony `m2.llm` real-LLM leg #79, whose dir
> `hosts/harmony/artifacts/m5-m2-llm/` is deliberately committed with
> **FAIL** verdicts — the coding-plan quota was exhausted mid-session, so
> the transport round trip is proven and the served turn is explicitly NOT
> claimed (gaps 8/9); on top of the M5 v2 primitives #76 (`m5-primitives`,
> descriptor 9/0, `m5.host-binding` 27/27), the real-LLM streaming legs #74
> (`macos-cli-m2-llm`, and `m2-llm` on iOS and Android), the android write
> surface #72 (`android-write-live`), the harmony composer write path #70
> (the sixth D9 dir `d9-write-live`, adding the `b-harmony.write.live`
> scenario; the `m2-gateway` row refreshed and its receipt gap closed
> 2026-09-21 by the W-GR bounded attempt, on top of the W-RECEIPT b3
> closure); and the five earlier D9 dirs `android-upstream` /
> `d9-official-web` / `b4-write-live` / `android-session-live` /
> `d9-session-live`, which entered the inventory with #63/#64/#65/#66/#67;
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
| Evidence dirs | 32 |
| Verdicts committed (73 green, 2 quota-blocked red) | 75 |
| Scenarios with at least one committed evidence dir | 28 of 28 distinct scenario ids (29 manifests) |
| Screenshots verified PNG | 81 |
| Acceptance-bar findings | 10 (below) |

## Coverage matrix — scenario × platform

Cell = green verdicts (`expected/logged` at capture time); dirs in
[the inventory](#evidence-dir-inventory). A dash means no committed
evidence on that platform.

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `b-android.official-web.mount` | — | 14/14 | — | — |
| `b-android.session.live` | — | 46/46 | — | — |
| `b-android.write.live` | — | 45/45 | — | — |
| `b-harmony.httpfetch-v2` | — | — | 6/6, 6/6, 6/6, 6/6 | — |
| `b-harmony.official-web-mount` | — | — | 17/17, 17/17, 17/17, 17/17 | — |
| `b-harmony.session.live` | — | — | 43/43, 43/43, 43/43 | — |
| `b-harmony.write.live` | — | — | 33/33, 33/33 | — |
| `b1.official-web.mount` | 14/14 | — | — | — |
| `b3.session.live` | 46/46 | — | — | — |
| `b4.write.live` | 43/43 | — | — | — |
| `m1.spike.boot` | 9/9 (drift), 7/7 | 9/9 (drift), 7/7, 7/7 | 7/7, 7/7, 7/7, 9/9 (drift), 7/7, 7/7 | 9/9 (drift) |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6, 6/6, 6/6, 6/6, 6/6 | 6/6 |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.llm` | 14/148 | 14/171 | 14/8 **FAIL** (quota) | 19/19 |
| `m2.llm.carrier` | 7/7 | 7/7 | 7/4 **FAIL** (quota) | — |
| `m2.session` | 23/23, 23/23 | 23/23, 22/22 (drift) | 23/23, 23/23, 23/23, 23/23, 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m2.upstream-session` | — | — | — | 31/31 |
| `m2.upstream-boot` | — | — | — | 12/12 |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | — | — | 22/22 |
| `m3.complete` | — | — | — | 41/41 |
| `m3.fetch-install` | 46/46 | — | — | — |
| `m3.fetch-carrier` | 11/11 | — | — | — |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20 (drift), 20/20 (drift), 20/20 (drift), 20/20 (drift), 27/27 | — |

`(drift)` = the verdict was captured against an older manifest revision
(see [Manifest-revision drift](#informational-not-failures)).

All 28 distinct scenario ids (29 manifests — `m2.llm` has two: the
19-event scripted-SSE CLI leg and the 14-event device leg) have at least
one green committed evidence dir; `m2.session` runs green on all four
hosts. Every verdict on main is green except the two quota-blocked
`hosts/harmony/artifacts/m5-m2-llm/` verdicts (gaps 8/9, deliberate).

The `m2.llm` device legs are **repeat-aware**: their manifests match the
delta stream greedily with one `repeat: true` expectation, so the
verdict's `logged` is the whole capture's record count and not the matched
count — `14/171` (Android) and `14/148` (iOS) are both `pass: true` with
`drift: false`, and the checker prints `14/14 events, in order` on PASS.

## Evidence-dir inventory

`logs` / `scen` / `rcpt` = `logs.txt` / `scenario.jsonl` / `receipt.json`
present. `shots` = PNG count (all magic-verified except where noted).

| Dir | Platform | Verdicts (`expected/logged`) | logs | scen | rcpt | shots |
| --- | --- | --- | --- | --- | --- | --- |
| `hosts/android/artifacts/android-upstream` | Android | b-android.official-web.mount 14/14 | ✓ | ✓ | ✗ (gap 3) | 4 |
| `hosts/android/artifacts/android-session-live` | Android | b-android.session.live 46/46 | ✓ | ✓ | ✗ (gap 4) | 4 |
| `hosts/android/artifacts/android-write-live` | Android | b-android.write.live 45/45 | ✓ | ✓ | ✗ (gap 7) | 4 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m2-llm` | Android | m2.llm.carrier 7/7, m2.llm 14/171 | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22 (drift) | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/d9-official-web` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17 | ✓ | ✓ | ✗ (gap 2) | 4 |
| `hosts/harmony/artifacts/d9-session-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43 | ✓ | ✓ | ✗ (gap 5) | 6 |
| `hosts/harmony/artifacts/d9-write-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43, b-harmony.write.live 33/33 | ✓ | ✓ | ✗ (gap 6) | 9 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✓ | ✓ | 2 |
| `hosts/harmony/artifacts/m5-m2-llm` | HarmonyOS | m2.llm.carrier 7/4 **FAIL**, m2.llm 14/8 **FAIL** (quota-blocked, deliberate — gaps 8/9) | ✓ | ✓ | ✓ (`blocked-on-quota`) | 1 |
| `hosts/harmony/artifacts/m5-primitives` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 27/27, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43, b-harmony.write.live 33/33 | ✓ | ✓ | ✓ | 9 |
| `hosts/ios/artifacts/b1-official-web` | iOS | b1.official-web.mount 14/14 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b3-session-live` | iOS | b3.session.live 46/46 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b4-write-live` | iOS | b4.write.live 43/43 | ✓ | ✓ | ✗ (gap 1) | 3 |
| `hosts/ios/artifacts/m1-carrier` | iOS | m1.carrier.loopback 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m1-spike` | iOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m2-gateway` | iOS | m1.spike.boot 7/7, m1.carrier.loopback 7/7, m2.gateway.audit 16/16, m2.gateway.binding 19/19 | ✓ | ✓ | ✓ | 9 |
| `hosts/ios/artifacts/m2-llm` | iOS | m2.llm.carrier 7/7, m2.llm 14/148 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m2-session` | iOS | m2.session 23/23, m2.webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-complete` | iOS | m3.fetch-carrier 11/11, m3.fetch-install 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-pluginization` | iOS | m2.session 23/23, m3.ui-swap 7/7 | ✓ | ✓ | ✓ | 3 |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-bridge-smoke` | macOS CLI | m2.bridge.smoke 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-llm` | macOS CLI | m2.llm 19/19 (scripted-SSE leg) | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-boot` | macOS CLI | m2.upstream-boot 12/12 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | m2.upstream-session 31/31 | ✓ | ✓ | ✓ | 0 |

Zero screenshots is compliant everywhere (bar clause 2 makes screenshots
optional debugging aids, never deliverables or inputs): the CLI host dirs
are headless, and `hosts/android/artifacts/m2-llm/` carries its capture as
`dsh-m2-llm-stream.txt` instead of images.

## Known gaps (honest list)

The checker (`tools/e2e/matrix.mjs`) currently exits non-zero on exactly
ten findings: seven receipts pending their dirs' first post-landing host
re-run, each owned by the host work stream that landed the dir with
#63/#64/#65/#66/#67/#70/#72, plus three on the one quota-blocked dir
`hosts/harmony/artifacts/m5-m2-llm/`. (The rcpt column above cites these
list numbers.)

1. **`hosts/ios/artifacts/b4-write-live/` has no `receipt.json`** — the
   dir landed with #65 (the session-write surface); the receipt is
   owned by the b4 work stream's next `run-ios-b4.sh` run on a tree
   carrying #65.
2. **`hosts/harmony/artifacts/d9-official-web/` has no `receipt.json`**
   — the dir landed with #64 (the harmony webServer carrier); the
   receipt is owned by the harmony work stream's next host re-run.
3. **`hosts/android/artifacts/android-upstream/` has no `receipt.json`**
   — the dir landed with #63 (the android official-web boot); the
   receipt is owned by the android work stream's next host re-run.
4. **`hosts/android/artifacts/android-session-live/` has no
   `receipt.json`** — the dir landed with #66 (the android session.live
   spine, b-android.session.live 46/46 green); the receipt is owned by
   the android work stream's next host re-run.
5. **`hosts/harmony/artifacts/d9-session-live/` has no `receipt.json`**
   — the dir landed with #67 (the harmony session.live spine,
   b-harmony.session.live 43/43 green); the receipt is owned by the
   harmony work stream's next host re-run.
6. **`hosts/harmony/artifacts/d9-write-live/` has no `receipt.json`** —
   the dir landed with #70 (the harmony composer write path,
   b-harmony.write.live 33/33 green); the receipt is owned by the
   harmony work stream's next host re-run.
7. **`hosts/android/artifacts/android-write-live/` has no `receipt.json`**
   — the dir landed with #72 (the android session write surface,
   b-android.write.live 45/45 green); the receipt is owned by the
   android work stream's next host re-run.
8. **`hosts/harmony/artifacts/m5-m2-llm/` — the `m2.llm` device verdict is
   RED (14/8) and intentionally committed.** The dir landed with #79 (the
   harmony real-LLM leg). The leg ran exactly as designed and the request
   left the emulator through this host's real `httpFetch`, but the z.ai
   backend REFUSED it — `HTTP 429`, code `1310`, "Weekly/Monthly Limit
   Exhausted. Your limit will reset at 2026-09-22 14:43:53" (reproduced
   off-device with the same key by `curl`, so the blocker is the account,
   not the host). The served-turn records therefore never happened and the
   checker FAILs by design: **the committed verdict JSONs are the precise
   diagnosis, not a green claim.** What this run DOES prove, one-to-one and
   in order: the manifest's first seven device records
   (`gateway.negotiated` → `host.ready` → `llm.leg` real over
   `gateway.httpFetch` — capability negotiation, never a `hostType` branch
   → `llm.config.loaded` app-scope → `session.created` →
   `agent.started` → `llm.stream.started`), the real transport round trip
   (the request crossed the device's network stack and a real server
   answered it — a 429 from the real backend is itself evidence), and the
   full credential handshake this platform forces (runtime-written 0666
   placeholder → runner overwrite → app import + validation → honest seal
   report → removal after the run), with a key-leak audit clean over both
   raw streams. The served turn is explicitly NOT claimed — README.md's M5
   row says so in both languages. `receipt.json` records
   `status: blocked-on-quota` and `exitCode: 1`. **Closure (owned by the
   harmony work stream):** `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-m2-llm.sh`
   once the quota returns — no code change; it must exit 0 with both
   verdict JSONs green, the evidence refreshed here, and the README clause
   flipped.
9. **`hosts/harmony/artifacts/m5-m2-llm/` — the `m2.llm.carrier` verdict is
   RED (7/4), same run, same cause.** The carrier mount chain
   (`client.selected` → `webclient.mounted` → `ws.connected` →
   `slot.registered`) is logged and matched; `ws.token-delta`
   first/last and `ws.session-complete` await the served deltas the
   refused turn never produced. Same closure as gap 8.
10. **`hosts/harmony/artifacts/m5-m2-llm/` — the checker's derived
    `VERDICT_MALFORMED` notice on that same carrier verdict.** The checker
    adds its count-inconsistency notice whenever `expected != logged` and
    the manifest is not repeat-aware, which a FAIL verdict can never
    satisfy; its detail line reads "but pass=true" even though the verdict
    is `pass: false`. It is the mirror of gap 9, not a second defect, and
    it clears with it.

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

### Closed by the 2026-09-21 m2-gateway receipt closure (fix/m2-gateway-receipt)

- **m2-gateway receipt** — closed by a real `run-ios.sh` re-run on this
  branch (fresh worktree at `e3bd333`): the four checkers re-matched the
  manifests one-to-one (m1.spike.boot 7/7, m1.carrier.loopback 7/7,
  m2.gateway.binding 19/19, m2.gateway.audit 16/16, expected == logged,
  exit 0), the evidence was refreshed from the run, and `receipt.json`
  is machine-authored IN-RUN by the runner's new green-path step
  (reachable only after all four checkers pass — a receipt can never
  exist without a real green run). The attempt also retired the picker
  blocker the previous entry described, whose "index timing" was only
  half the story: the drive never SUBMITTED its search — on the iOS 26.5
  sheet, typing "notes" through WDA renders only the 名称包含 suggestion
  row, and the results appear only after the keyboard return, now sent
  through the same locale-independent element `/value` endpoint
  (`wda_submit_search`). The result-tile calibration moved accordingly
  (px (204,894) → (163,712) / 2). Around it the runner now (a) stages
  the picker target ONCE — rewriting it, and even re-installing the app
  (the data container migrated UUID across a same-version reinstall),
  knocks the doc out of the volatile provider search index, which
  repopulates after a few minutes of settle; (b) fails loud when node is
  missing and removes stale verdict files before checking, after a run
  PASSed by grepping the previous run's verdicts (`|| true` had masked
  "command not found"); (c) records everything on the surprises ledger
  (index volatility beyond rewrites, archive-a-green-dir-before-rerun,
  driver deadline wedge).

## Informational, not failures

- **Manifest-revision drift** (9 verdicts): `m1.spike.boot` was captured
  at 9 events in `hosts/{ios,android,harmony}/artifacts/m1-spike/` and
  `runtime/spike/artifacts/macos-cli/`, but the current manifest declares
  7; `hosts/android/artifacts/m4-host/` captured `m2.session` at 22
  events vs the current 23; `m5.host-binding` was captured at 20 events in
  `hosts/harmony/artifacts/{d9-official-web,d9-session-live,d9-write-live,m5-host}/`
  before #76 grew the manifest to 27 (`m5-primitives` is the 27/27
  re-capture). Verdicts are capture-time records; older logs are not
  guaranteed to re-verify against a grown manifest. The checker reports
  `drift: true` and does not fail on it.
- **The three dirs previously listed here as "in flight" have resolved.**
  `runtime/spike/artifacts/macos-cli-m2-llm/` landed with #74 and is a
  green table row (the scripted-SSE CLI leg, `m2.llm` 19/19); the M5
  close-out evidence landed instead as
  `hosts/harmony/artifacts/m5-primitives/` (#76, descriptor 9/0) and
  `hosts/harmony/artifacts/m5-m2-llm/` (#79, quota-blocked — gaps 8/9).
  `hosts/android/artifacts/m3-android-install/` and
  `hosts/harmony/artifacts/m5-complete/` were never committed by any
  branch (`git log --all` is empty for both paths) — no such evidence
  exists to report.
- **Checker wording on a FAIL verdict**: for a non-repeat-aware manifest
  the checker also reports `VERDICT_MALFORMED` with the detail
  `expected=N logged=M but pass=true` whenever the counts differ — even
  when the verdict is `pass: false`, where differing counts are the
  failure itself. It is a derived notice — gap 10 against the one red dir
  — and never fires on its own.

## The checker and its rejection proof

`tools/e2e/matrix.mjs` (stdlib-only) regenerates the inventory from the
working tree and exits non-zero on any regression: failed verdict,
missing/empty deliverable, broken PNG, malformed verdict/receipt, or a
scenario id without a manifest in `tools/e2e/scenarios/`. Its
`--self-test` mode proves every rejection class actually rejects
(8 assertions, rule 6) — the assertion set is documented in the
[e2e README](../tools/e2e/README.md#inventory-matrix-matrixmjs).

The checker is deliberately **not wired into `gates.json`**: ten owned
findings above remain open — the seven D9-era receipts blocked on their
hosts' next re-runs, and the three verdict findings on the quota-blocked
`m5-m2-llm` dir, which clear together on one quota-restored re-run. The
decision to gate on the matrix belongs to the plane seal.
