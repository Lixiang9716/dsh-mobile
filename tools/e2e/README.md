# tools/e2e/

Log-based E2E verdict tooling (no screenshots — those are a local
interactive-debugging aid only; see docs/ARCHITECTURE.md, "E2E
verification").

- `scenarios/<id>.json` — one manifest per scenario: the scenario id, the
  log extraction prefix, and the ordered expected events (each with exact
  field matchers applied to `data[0]`).
- `check.mjs` — the one-to-one expected<->logged matcher: the captured log
  must contain exactly one structured entry per expected event, in
  declaration order, nothing missing, nothing extra. Failure output names
  the first mismatched index with both sides and any unparsable entries.

```sh
node tools/e2e/check.mjs \
  --manifest tools/e2e/scenarios/m1-spike-boot.json \
  --log <captured-platform-log> \
  --out <verdict.json>   # exit 0 = pass, 1 = fail
```

Platforms capture their native log stream (stdout / os_log / logcat /
hilog); the canonical `dsh.spike.log: {...}` lines are byte-identical
everywhere, so one checker serves all hosts.

## Scenario manifests (M2)

| Manifest | Scenario | Runs on | Contract |
| --- | --- | --- | --- |
| `m1-spike-boot.json` | `m1.spike.boot` | iOS (and any spike host) | 7 events — runtime boot, gateway negotiation, crypto/base64 shims |
| `m1-carrier-loopback.json` | `m1.carrier.loopback` | iOS | 7 events — loopback HTTP+WS carrier |
| `m2-bridge-smoke.json` | `m2.bridge.smoke` | macOS CLI | 6 events — C bridge dispatch: fs read/write/invalid, keychain unavailable |
| `m2-gateway-binding.json` | `m2.gateway.binding` | iOS, UI-driven | 19 events — the frozen real-gateway-binding sequence (fs, http, picker, scope, approval, keychain, notify, app state) |
| `m2-gateway-audit.json` | `m2.gateway.audit` | iOS, UI-driven | 15 flat audit records mirroring the binding call sequence, incl. the denied fsRead |
| `m2-session.json` | `m2.session` | macOS CLI + iOS (auto-run) | 23 events — mini agent session over the system plugins: registry install, `dsh-notes` arriving through the install pipeline (`notes.installed`, receipt committed), host readiness, mock-LLM token deltas, subprocess tool persisting via fs under scope `app`, session complete |
| `m2-webclient-mount.json` | `m2.webclient.mount` | iOS, carrier-side | 7 events — client.selected, Web Client mount, WS connect, the plugin toolbar slot rendered + acked (`slot.registered`), first/last streamed token delta, session complete |
| `m3-install.json` | `m3.install` | macOS CLI (and any spike host) | 22 events — the install transaction end to end: deterministic fixture package, sha256 blob store, trust-record verify, strict manifest validation, install-time capability negotiation (`install.negotiated`), staged integrity read-back, promote, receipt commit, installed-plugin load + notes service roundtrip, and the tamper case (`install.integrity-rejected` before unpack, tree intact, no receipt) |
| `m3-ui-swap.json` | `m3.ui-swap` | iOS, carrier-side (`run-ios-session.sh --client mini`) | 7 events — the config-selected client flip: `client.selected` = `dsh-web-client-mini`, mini-client mount, WS connect, `slot.registered`, first/last streamed delta, session complete |
| `m3-complete.json` | `m3.complete` | macOS CLI (and any spike host) | 41 events — the four M3 scope items in one stream: the config layer (`config.resolved` + the slot gate admitting/refusing slots), the fetch-based installer over a logged scope-read stub (`install.fetch.stub` — the CLI descriptor honestly declares `httpFetch` unavailable), two crash-simulated pending receipts startup-replayed (`replay.committed` / `replay.rolled-back`, tree untouched), and a capability-rejected package (`install.capability-rejected`, `missing: ["notify"]`, before unpack) |
| `m3-fetch-install.json` | `m3.fetch-install` | iOS, profile mode (`run-ios-m3.sh`) | 46 events — the same fetch path ON DEVICE with the real `httpFetch` against the loopback carrier (the carrier self-hosts the package via the bus seam), the journal `pending→committed` order asserted, the two crash-simulated receipts replayed, then the m2.session-shaped agent session |
| `m3-fetch-carrier.json` | `m3.fetch-carrier` | iOS, carrier-side (`run-ios-m3.sh`) | 11 events — causal carrier evidence for the profile drive: `config.resolved` (the patch), `client.selected` `source=config`, mini-client mount, `http.route-registered` + `http.served` (3584 bytes over TCP), `slot.denied` (the configured allow-set enforced host-side), `slot.registered`, deltas, complete |
| `b1-official-web-mount.json` | `b1.official-web.mount` | iOS, carrier-side + runtime (`run-ios-b1.sh`) | 13 events — the contract carrier mounting the OFFICIAL upstream web app with the RUNTIME LIVE (W-INTEG; `docs/webserver-contract.md` §4): `client.selected` `dsh-web-official`, `web.boot.applied` (the runtime's composed rows replace the carrier defaults) + `runtime.booted` (the vendored client-modules composer), `index.rendered` (4 injection rows) + `index.served` (token→cookie→303 auth-lite), `asset.served` (dist entry chunk), `plugins.served` (the runtime graph's combo URL — the REAL vendored browser bundle, 36040 bytes), `upgrade.accepted` (`/api/remote.mux`), `rpc.observed` (POST envelope answered structured `gateway/unimplemented`), `session.attached` (mux journal open) + `session.services.pending` (no agent spine embedded — session services are the next named gap), `module.system.live` (the official facade materialized the vendored bundle; mode flipped queue→live) + `page.rendered` (probe: HARNESS loader state, no failure text; no upstream code edited) |

Field matchers are SUBSET matchers: a record may carry extra
non-deterministic fields (uuid, paths); only the manifest's fields must
match, exactly and in declaration order.

## The audit stream (flat envelope)

The gateway audit log is NOT the unified logger: each record is flat JSON
on a `dsh.gateway.audit: ` line — `{"ts":…,"primitive":…,"caller":…,
"verdict":…,"outcome":…}` — with no scenario field to filter on. Manifests
opt in with `"extract": { "prefix": "dsh.gateway.audit:", "envelope":
"flat" }`; expect entries then name `primitive` (instead of `event`) with
`match` fields applied at the top level. Behavior for existing (logger
envelope) manifests is unchanged.

## Simulator runner (local M2 E2E)

`run-ios.sh` is the full local driver for `m2.gateway.binding` — CI cannot
run it (hosted runners have no idb/UI driver), so the real M2 E2E happens
here:

```sh
tools/e2e/run-ios.sh [--udid U] [--art-dir D] [--skip-build]
```

It vendors the engine, builds DSHSpike, installs and launches it with
stdout/stderr capture (log truncated first — the checker must see only this
run), then follows the live log and drives every `spike: ui-wait` marker
via idb: notification-permission alert ("Allow"), HOME press on
`notify.scheduled`, notification banner (retry loop ≤20s, pull-down
fallback), approval dialog ("Approve"), and the Files picker navigation
(On My iPhone → DSHSpike → gateway-e2e → notes.txt). On the terminal
`spike: sequence` marker it runs all four scenario checkers, prints a
summary table, and exits non-zero if any fails. Screenshots land in
`<art-dir>/screens/` as debugging artifacts — never checker inputs. Every
wait polls a condition with a deadline; overall deadline 300s fails loud
with the last 50 log lines.

Tap points are screenshot-derived CALIBRATION CONSTANTS at the top of the
script (`PT_ALLOW`, `PT_APPROVE`, `PT_BANNER`, `PT_FILES_*`, `SWIPE_PULL`):
every UI step first tries the accessibility tree (`idb ui describe-all`,
known to error on some iOS 26.5 runtimes) and only falls back to the
constants. Recalibrate them against the saved screenshots for your
simulator after the first live run.

### Session runner (local M2/M3 on-device session E2E)

`run-ios-session.sh` is the auto-run session driver — NO UI interaction:
the scenario starts once the mounted Web Client connects AND acks the
plugin's toolbar slot (host.info readiness signal) and uses only scope
`app` fs (no alerts, pickers, or banners), so no idb/WDA driving is needed:

```sh
tools/e2e/run-ios-session.sh [--udid U] [--art-dir D] [--skip-build] [--client mini|default]
```

`--client mini` proves UI pluggability (M3): the app launches with
`-dsh-web-client dsh-web-client-mini`, the carrier serves the SECOND Web
Client variant (the visually distinct "DSH mini client"), and the
carrier-side checker becomes `m3-ui-swap.json` with evidence under
`hosts/ios/artifacts/m3-pluginization/`. The default client keeps the
`m2-webclient-mount.json` contract. The JS session stream
(`m2-session.json`) is client-independent and always verified.

### M3 fetch-install runner (on-device, loopback-carrier self-hosted)

`run-ios-m3.sh` drives the on-device M3 completion E2E — NO UI interaction:

```sh
tools/e2e/run-ios-m3.sh [--udid U] [--art-dir D] [--skip-build]
```

It launches the app in session mode with the m3-complete PROFILE
(`-dsh-profile m3-complete`): the staged `cordis.patch.json` (the M3 config
layer) selects the ACTIVE Web Client and the toolbar slot allow-set; the
scenario hands the deterministic dsh-notes package to the carrier over the
bus seam, and the carrier serves it over real loopback TCP — the install
runs through the REAL gateway `httpFetch`. Two crash-simulated pending
receipts are startup-replayed before the session phase. The runner
uninstalls the app first (the app scope persists across launches and the
receipt journal is append-only — the replay assertions need an empty
container), then verifies BOTH `m3-fetch-install.json` and
`m3-fetch-carrier.json`; evidence lands under
`hosts/ios/artifacts/m3-complete/`.

It builds DSHSpike, launches it in session mode (`-dsh-mode session`),
waits for the `webclient.mounted` / `ws.token-delta` / terminal
`spike: sequence session=` markers (screenshots at page-loaded,
mid-stream, final transcript), then verifies the captured log against
BOTH `m2-session.json` and the active client's carrier manifest. Same
rule-8 polling discipline and 300s overall deadline as `run-ios.sh`.

### Phase-B official-web mount runner (on-device, contract carrier)

`run-ios-b1.sh` drives the Phase-B mount E2E — NO UI interaction:

```sh
tools/e2e/run-ios-b1.sh [--udid U] [--art-dir D] [--skip-build]
```

It first materializes the vendored official dist (`ensure-official-dist.sh`:
verify against the committed sha256 MANIFEST, rebuild reproducibly from the
pinned upstream if absent), builds DSHSpike, stages the dist into the app
container (`Documents/official-web/dist`), and launches
`-dsh-mode official-web`. The carrier serves the dist through the
`ctx.webServer` contract surface (route table, fallback seat, `/plugins`
combos, `/api` envelope, `/api/remote.mux` mux, injected index); the
platform-side probe runs inside the page (same-origin fetch + WebSocket),
and the rendered state is read from the REAL DOM. Verdict per the
one-to-one manifest `b1-official-web-mount.json`. Screenshots are debugging
artifacts only.

The m2-bridge-smoke scenario runs on the macOS CLI (not iOS) and is checked
directly:

```sh
node tools/e2e/check.mjs --manifest tools/e2e/scenarios/m2-bridge-smoke.json \
  --log <cli-run-log> --out <verdict.json>
```

## Selftest

`selftest.sh` proves the checker logic against hand-written fixtures in
`testdata/`: the positive fixture must pass BOTH m2 checkers (and the slim
m1 fixture its manifest), and each negative fixture must fail at a named
index — proving one-to-one matching, order, prefix isolation, and the flat
envelope.

```sh
tools/e2e/selftest.sh   # exit 0 = all checker assertions hold
```

## Inventory matrix (`matrix.mjs`)

`matrix.mjs` regenerates the cross-host evidence inventory
([docs/e2e-matrix.md](../../docs/e2e-matrix.md)) from the working tree:
every directory carrying `verdict*.json` is an evidence unit, checked for
the deliverables (`logs.txt` + `scenario.jsonl` + `receipt.json`), PNG
magic-byte integrity of its screenshots, and a manifest in `scenarios/`
for every verdict scenario id. A failed or internally inconsistent
verdict, a missing/empty deliverable, a broken PNG, or a scenario without
a manifest exits non-zero. Manifest-revision drift (an older dir checked
against a since-grown manifest) is reported (`drift`), not failed — the
verdict is the record of what ran. PNGs outside evidence dirs (app icons)
are not evidence and are not checked. Not wired into `gates.json` — the
plane seal owns that decision.

```sh
node tools/e2e/matrix.mjs [--out inventory.json]   # exit 0 = clean, 1 = findings
node tools/e2e/matrix.mjs --self-test              # 8 rejection assertions
```

Rejection assertions, each proved by `--self-test` (rule 6): positive
control (a well-formed tree rejects nothing), `VERDICT_FAIL`
(`pass: false`), `MISSING_DELIVERABLE` (receipt removed),
`EMPTY_DELIVERABLE` (zero-byte scenario.jsonl), `PNG_BROKEN` (JPEG bytes
under a `.png` name), `SCENARIO_WITHOUT_MANIFEST`, `VERDICT_MALFORMED`
(unparsable verdict), `RECEIPT_MALFORMED` (unparsable receipt).
