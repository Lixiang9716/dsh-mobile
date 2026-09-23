# Cross-host E2E evidence matrix

English | [简体中文](e2e-matrix.zh.md)

Consolidated acceptance evidence for every E2E claim across the four hosts
(iOS, Android, HarmonyOS, macOS CLI), built from the committed artifacts
dirs. Machine-checked by [test/e2e/matrix.mjs](../test/e2e/matrix.mjs).

> **Currency**: this matrix reflects the T-0035 settings-surfaces + file-tools
> change (2026-09-22): the official client's 预设/插件 panels load real data on
> device (b4 46/46 asserting the preset roster, the plugin inventory, the
> read-only manager legs, and the settings shell's model-catalog/credential
> loads; android-write 45/45 the same), the FILE-TOOLS row mounts in the
> product boot (`tool.fs`), and the settings dialog is phone-adaptive
> (human evidence: `hosts/ios/artifacts/settings-screens/`). On top of
> `origin/main` as of commit `940ae02`
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
> node test/e2e/matrix.mjs              # exit 0 = inventory clean
> node test/e2e/matrix.mjs --out /tmp/inv.json   # machine inventory
> ```
>
> The 2026-09-21 *gateability* change (branch `docs/e2e-matrix-gateable`)
> leaves every number below untouched — it made the same inventory wireable
> as a gate (finding count 10 → 9, the register in
> [Known gaps](#known-gaps-honest-list) and the checker's second invocation).
> The regeneration is the tool's own output on this tree.

## The acceptance bar

Every E2E claim in this repository is accepted only when ALL of the
following hold:

1. **Green one-to-one log comparison** — a `verdict*.json` produced by
   `test/e2e/check.mjs` with `pass: true`, `expected == logged`
   (exact, ordered, nothing missing, nothing extra).
2. **Screenshots are debugging artifacts** — never checker inputs; under
   an evidence dir they must be real PNGs (magic bytes).
3. **Complete deliverables** — `logs.txt` + `scenario.jsonl` +
   `verdict*.json` + `receipt.json` committed under the right artifacts
   dir.

## Totals (this tree)

| Metric | Value |
| --- | --- |
| Evidence dirs | 37 |
| Verdicts committed (80 green, 2 quota-blocked red) | 82 |
| Scenarios with at least one committed evidence dir | 31 of 31 distinct scenario ids (32 manifests) |
| Screenshots verified PNG | 86 |
| Acceptance-bar findings | 9 — every one owned in the [known-gaps register](#known-gaps-honest-list); 0 block the gate |

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
| `upstream.parity` | 12/37 + 25/25 diff | 13/13 + 25/25 | — | 12/37 + 25/25 |

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
| `hosts/android/artifacts/upstream-parity` | Android | upstream.parity 13/13 + parity differential 25/25 records identical to the Node golden (the emulator leg, on-device MockLlmRoute) | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/android-session-live` | Android | b-android.session.live 46/46 | ✓ | ✓ | ✗ (gap 4) | 4 |
| `hosts/android/artifacts/android-write-live` | Android | b-android.write.live 45/45 | ✓ | ✓ | ✗ (gap 7) | 4 |
| `hosts/ios/artifacts/settings-screens` | iOS | — (human evidence only; the machine assertions live in `b4-write-live`) | ✓ (app-stdout) | ✗ (by design) | ✗ (by design) | 2 |
| `hosts/ios/artifacts/upstream-parity` | iOS | upstream.parity 12/37 + parity differential 25/25 records identical to the committed golden (the simulator leg; gateway httpFetch → the host-side mock) | ✓ | ✓ | ✓ | 2 |
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
| `runtime/spike/artifacts/macos-cli-upstream-parity` | macOS CLI | upstream.parity 12/37 + parity differential 25/25 records identical to the committed golden (per-leg mock instances) | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-settings-surfaces` | macOS CLI | settings.surfaces.cli 12/12 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-tool-fs` | macOS CLI | tool.fs (probe, 15 records) | ✓ | ✓ | ✓ | 0 |

Zero screenshots is compliant everywhere (bar clause 2 makes screenshots
optional debugging aids, never deliverables or inputs): the CLI host dirs
are headless, and `hosts/android/artifacts/m2-llm/` carries its capture as
`dsh-m2-llm-stream.txt` instead of images.

## Known gaps (honest list)

Nine findings are open on this tree, and **every one of them is owned**. The
checker reports all nine and exits non-zero by default; the table below is
the **known-gaps register** that makes the very same run wireable as a gate.

- `node test/e2e/matrix.mjs` — prints every finding, registered or not, and
  exits 1: the unvarnished list.
- `node test/e2e/matrix.mjs --accept-known-gaps` — exits 0 while every
  finding is a row of the register below, and 1 on (a) a finding no row
  names, i.e. a NEW regression; (b) a row whose finding is gone — a gap that
  closes is struck from the register in the same change; (c) a register
  grown past the checker's budget of 9 rows — accepting a new gap is a
  deliberate edit, never a drift. **This is the invocation a gate wires, and
  it is green on this tree: 0 blocking findings.**

The register is machine-read out of the table below, so this honest list is
the only copy and cannot drift from the checker. Its cells are read
literally (no backtick formatting inside that table); a table that is
missing or malformed is a finding of its own, never a silent pass.

| code | file | owner | closes with |
| --- | --- | --- | --- |
| MISSING_DELIVERABLE | hosts/ios/artifacts/b4-write-live/receipt.json | iOS b4 work stream (#65) | run-ios-live-write.sh --art-dir hosts/ios/artifacts/b4-write-live green run + that runner's receipt step |
| MISSING_DELIVERABLE | hosts/harmony/artifacts/d9-official-web/receipt.json | harmony work stream (#64) | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-official-web + receipt step |
| MISSING_DELIVERABLE | hosts/android/artifacts/android-upstream/receipt.json | android work stream (#63) | DSH_WEB_ART=hosts/android/artifacts/android-upstream hosts/android/ci/run-android-full.sh + receipt step |
| MISSING_DELIVERABLE | hosts/android/artifacts/android-session-live/receipt.json | android work stream (#66) | DSH_SESSION_ART=hosts/android/artifacts/android-session-live hosts/android/ci/run-android-full.sh + receipt step |
| MISSING_DELIVERABLE | hosts/harmony/artifacts/d9-session-live/receipt.json | harmony work stream (#67) | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-session-live + receipt step |
| MISSING_DELIVERABLE | hosts/harmony/artifacts/d9-write-live/receipt.json | harmony work stream (#70) | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-write-live + receipt step |
| MISSING_DELIVERABLE | hosts/android/artifacts/android-write-live/receipt.json | android work stream (#72) | DSH_WRITE_ART=hosts/android/artifacts/android-write-live hosts/android/ci/run-android-full.sh + receipt step |
| VERDICT_FAIL | hosts/harmony/artifacts/m5-m2-llm/verdict-m2-llm-device.json | harmony work stream (#79) | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-live-llm.sh once the z.ai quota returns (reset 2026-09-22 14:43:53) |
| VERDICT_FAIL | hosts/harmony/artifacts/m5-m2-llm/verdict-m2-llm-carrier.json | harmony work stream (#79) | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-live-llm.sh once the z.ai quota returns (reset 2026-09-22 14:43:53) |

### Why none of these nine is closed here (the honest reason)

Seven of them need a `receipt.json` only the owning host work stream's next
device/emulator run can produce; the other two are a deliberate record of a
real backend refusal. Writing those receipts from this branch would mean
inventing them:

- **The receipt certifies a run, and the run's device is not in the
  committed artifacts.** `host` names the machine a run happened on — the
  iOS simulator UDID and runtime, the android emulator instance with its AVD
  and API level, the harmony hdc target — and `test/e2e/run-ios.sh` reads
  it from `xcrun simctl` at run time. Verified on this tree:
  `grep -rliE 'emulator-5554|AVD|Pixel|sdk_gphone' hosts/android/artifacts/{android-upstream,android-session-live,android-write-live}/`,
  `grep -rliE 'dsh_phone|127.0.0.1:5557|HarmonyOS 7|hdc' hosts/harmony/artifacts/{d9-official-web,d9-session-live,d9-write-live}/`
  and `grep -rliE 'simctl|UDID|iOS 26|A4AE41BF' hosts/ios/artifacts/b4-write-live/`
  all return **nothing**: the green verdicts, the captures and the engine
  line (`quickjs-ng 0.17.0`, in the android `results.txt`) are committed;
  the device is not. Acceptance-bar clause 3 and the receipt convention
  forbid synthesizing the rest.
- **A receipt can never exist without a real green run.** `run-ios.sh`
  machine-authors its receipt on the green path only (step 7, reachable
  after every checker passed). The android, harmony and `run-ios-b4.sh`
  runners have no such step yet, so those rows close as a runner change
  (adopt the same green-path emission) *plus* the re-run named in the row —
  both owned by the work stream that landed the dir.
- **The two harmony verdicts are the diagnosis, not a green claim.** The
  request left the emulator over the host's real `httpFetch` and the backend
  refused it (`HTTP 429`, code `1310`, weekly/monthly limit exhausted). No
  change in this repository can serve that turn; the harmony re-run can,
  once the quota returns.

The gaps in detail (the numbering the `rcpt` column of the inventory above
cites, and the register's rows in order):

1. **`hosts/ios/artifacts/b4-write-live/` has no `receipt.json`** — the
   dir landed with #65 (the session-write surface, `b4.write.live` 43/43
   green). Owned by the iOS b4 work stream: a green
   `test/e2e/run-ios-b4.sh --art-dir hosts/ios/artifacts/b4-write-live`
   on a tree carrying #65, with the receipt emitted on that runner's green
   path (the `run-ios.sh` step-7 pattern).
2. **`hosts/harmony/artifacts/d9-official-web/` has no `receipt.json`**
   — the dir landed with #64 (the harmony webServer carrier). Owned by the
   harmony work stream: a green
   `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-official-web`
   plus the same runner emission.
3. **`hosts/android/artifacts/android-upstream/` has no `receipt.json`**
   — the dir landed with #63 (the android official-web boot). Owned by the
   android work stream: a green
   `DSH_WEB_ART=hosts/android/artifacts/android-upstream hosts/android/ci/run-android-full.sh`
   plus the same runner emission.
4. **`hosts/android/artifacts/android-session-live/` has no
   `receipt.json`** — the dir landed with #66 (the android session.live
   spine, b-android.session.live 46/46 green). Owned by the android work
   stream: a green
   `DSH_SESSION_ART=hosts/android/artifacts/android-session-live hosts/android/ci/run-android-full.sh`
   plus the same runner emission.
5. **`hosts/harmony/artifacts/d9-session-live/` has no `receipt.json`**
   — the dir landed with #67 (the harmony session.live spine,
   b-harmony.session.live 43/43 green). Owned by the harmony work stream: a
   green
   `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-session-live`
   plus the same runner emission.
6. **`hosts/harmony/artifacts/d9-write-live/` has no `receipt.json`** —
   the dir landed with #70 (the harmony composer write path,
   b-harmony.write.live 33/33 green). Owned by the harmony work stream: a
   green
   `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-write-live`
   plus the same runner emission.
7. **`hosts/android/artifacts/android-write-live/` has no `receipt.json`**
   — the dir landed with #72 (the android session write surface,
   b-android.write.live 45/45 green). Owned by the android work stream: a
   green
   `DSH_WRITE_ART=hosts/android/artifacts/android-write-live hosts/android/ci/run-android-full.sh`
   plus the same runner emission.
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
   harmony work stream):** `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-live-llm.sh`
   once the quota returns — no code change; it must exit 0 with both
   verdict JSONs green, the evidence refreshed here, and the README clause
   flipped.
9. **`hosts/harmony/artifacts/m5-m2-llm/` — the `m2.llm.carrier` verdict is
   RED (7/4), same run, same cause.** The carrier mount chain
   (`client.selected` → `webclient.mounted` → `ws.connected` →
   `slot.registered`) is logged and matched; `ws.token-delta`
   first/last and `ws.session-complete` await the served deltas the
   refused turn never produced. Same closure as gap 8.

### Closed by the 2026-09-21 gateability change (docs/e2e-matrix-gateable)

- **Gap 10 (the derived `VERDICT_MALFORMED` notice on a FAIL verdict)** —
  closed in the checker, not by touching the evidence. The count-consistency
  notice exists to catch a *passing* record whose counts disagree
  (`pass: true` with `expected != logged` is the contradiction); on a
  `pass: false` verdict the differing counts ARE the failure, already
  reported by `VERDICT_FAIL`, and the notice's detail line claimed
  `but pass=true` about a verdict saying otherwise. The condition is now
  `v.pass === true && v.expected !== v.logged`, and `--self-test` proves
  both directions: a FAIL verdict draws one finding and no notice, while a
  passing verdict with differing counts is still rejected.
- **Finding paths became root-relative** (`relative(root, …)`, they used
  `relative(process.cwd(), …)`); the printed path only *looked* right
  because the tool is always run from the repo root. A register cannot be
  keyed on a path that moves with the cwd, and the register keys are now the
  same strings the doc's table carries.
- No evidence was deleted, no receipt was authored, and no verdict was
  edited to make a finding disappear: the count went 10 → 9 because one
  finding was a checker false-positive, not because anything was hidden.

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
- **The FAIL verdicts' derived notice is gone.** The checker adds its
  count-consistency notice only to a `pass: true` record now; the same
  count disagreement on a `pass: false` verdict is the `VERDICT_FAIL`
  itself, reported once. (That was gap 10 — see the closure note above.)

## The checker and its rejection proof

`test/e2e/matrix.mjs` (stdlib-only) regenerates the inventory from the
working tree and exits non-zero on any regression: failed verdict,
missing/empty deliverable, broken PNG, malformed verdict/receipt, a
scenario id without a manifest in `test/e2e/scenarios/`, or a defect in
the known-gaps register itself. Its `--self-test` mode proves every
rejection class actually rejects (18 assertions, rule 6) — the assertion
set is documented in the
[e2e README](../test/e2e/README.md#inventory-matrix-matrixmjs).

One truth, two invocations (the file header carries the same contract):

```sh
node test/e2e/matrix.mjs                       # every finding printed, exit 1
node test/e2e/matrix.mjs --accept-known-gaps   # exit 0 while the register owns them all
node test/e2e/matrix.mjs --out /tmp/inv.json   # machine inventory (+ the evaluation)
```

The checker is **still not wired into `gates.json`**: that file is inside
the plane seal, and re-sealing is a recorded governance ritual, not a side
effect of a docs change. What this change makes true is that the wiring is
now *possible and small* — the gate invocation is green on this tree with
**0 blocking findings**, the nine gaps it accepts are named, owned and
closable in the register above, and the first new finding turns the very
same command red. The wiring is one gate plus the seal:

```sh
gov gate add e2e-matrix --description "cross-host E2E evidence inventory (known-gaps register)" \
  --timeout 120000 -- node test/e2e/matrix.mjs --accept-known-gaps
gov verify-plane --write     # the ritual that accepts the gates.json diff
```

One more piece rides the same ritual: rule 6 wants a project rejection case
per gate (`gov self-test` counts it, and a new gate is reported as
`NONE — rule 6` until it ships one). `.gov/rejections/case-e2e-matrix.sh`
is also inside the seal, so it is the owner's file to add — the checker's
`--self-test` (18 assertions) is the assertion set such a case wraps: build
a fixture tree with a violation, assert the run goes red, list the gap in a
register, assert the same run goes green.

(The command resolves `node` through the PATH of whoever runs the gates: the
macOS runner (`dev-ios.yml`) runs the checkers with a bare `node` and no
setup step, and on the ubuntu runner `gov.yml` uses, the ambient node is the
one `dev-android.yml` records — "the runner's default node carries an older
corepack", present but old enough that the platform builds pin their own.
A gate whose command cannot be resolved fails loud as `MISSING` rather than
passing silently, so the wiring is safe either way per rule 5.)
