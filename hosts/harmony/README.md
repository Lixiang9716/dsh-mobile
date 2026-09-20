# hosts/harmony/

The HarmonyOS NEXT host (M5): ArkTS shell + NAPI bridge to quickjs-ng + ArkWeb.
Subprocesses are designed as unavailable; store-review posture to be verified in practice.

## M5 host (isomorphic: carrier + binding + regression trio, all green)

ONE launch on the emulator now proves the host end to end in two phases:

1. **Regression trio (synchronous)** — `startSpike` runs `m1.spike.boot`
   (7/7), `m2.bridge.smoke` (6/6) over the REAL gateway dispatch bridge, and
   `m2.session` (23/23, the notes.installed manifest) on the ONE serial JS
   thread inside the NAPI call.
2. **Binding phase (event-driven)** — `CarrierServer.ets` serves the
   materialized `presentation/web-client` over loopback HTTP and pumps a
   minimal RFC 6455 WS text-frame channel; ArkWeb mounts the page
   (`webclient.mounted` -> `ws.connected`), `HostPhase.ets` evals
   `scenario/m5-host-binding.js` and delivers `host.info`, and the
   scenario drives the REAL binding primitives: approval dialog (custom
   ArkUI, driver taps Approve), notification lifecycle (publish with a
   wantAgent -> Home -> notification-center tap -> `notify.response` +
   `app.state` edges), fsScope app-scope persist/resolve, honest
   `unavailable` rejections for presentPicker/keychainGet/keychainSet/
   httpFetch (descriptor: 5 available / 4 unavailable), and a five-delta
   live session rendered by the mounted page (`ws.token-delta` first/last,
   `ws.session-complete`). Evidence:
   [artifacts/m5-host/](artifacts/m5-host/) (captures, verdicts 7/6/23/20,
   screenshots, receipt).

- `entry/src/main/cpp/gateway_smoke.cpp|h` — the platform twin of the desktop CLI
  smoke backend (`runtime/spike/host/main_cli.c`): it answers the dispatched calls of
  the gateway scenarios — fsRead/fsWrite/fsScope over the app files dir exposed as
  scope `"app"` (`filesDir/spike-fs`, passed by ArkTS as the `fsRoot` argument,
  mkdir -p parity on write), keychain honestly `unavailable` (declared so in the
  RuntimeDescriptor served to `__dshGatewayDescriptor()`), unknown primitives
  `invalid`. Calls are only QUEUED in the dispatch callback; settlement is deferred
  to the post-pump drain pass (the later-tick pattern the scenario exists to prove),
  inside a 10 s condition-driven backstop loop. Binding mode adds a descriptor
  override plus a forward hook: `notify`/`presentApproval` hop to the ArkTS
  capability layer (settled from later UI callbacks), and the honest-unavailable
  set widens per the binding descriptor.
- `entry/src/main/cpp/napi_init.cpp` — `startSpike(bundleRoot, capturePath, fsRoot)`
  runs the regression trio synchronously (each on its own `dsh_spike_t`, one
  `dsh.spike.verdict:` line per scenario). The binding phase exposes the same
  runtime FINE-GRAINED (`hostStart`/`hostEval`/`hostEvent`/`hostBusDeliver`/
  `hostSettle`/`hostCarrierLine`/`hostStatus`/`hostFree`): ArkTS drives it per
  event, and every mutator still runs on the ArkTS main thread, which stays the
  ONE serial JS runtime thread — no extra threads (ARCHITECTURE.md §6). The
  phase drive loop alternates pump and smoke-drain until the scenario completes
  or parks waiting on the embedder.
- `entry/src/main/ets/model/CarrierServer.ets` — loopback HTTP/1.1 static
  serving (Connection: close, path-escape reject) plus the WS upgrade at `/ws`
  (accept via the hand-rolled SHA-1 in `Sha1.ets`, documented there), both on
  ONE port (first free from 17877, fail loud after ten). The transport never
  logs canonical lines (single-logger discipline); `HostPhase` emits the
  carrier's own evidence (`carrier.listening`, `webclient.mounted`,
  `ws.connected`, token deltas, session complete) in the canonical envelope as
  module `dsh.carrier`.
- `entry/src/main/ets/model/HostPhase.ets` — the binding controller: bus-seam
  shuttle (`__dshBusPost` <-> page WS), projection observation, notify/
  presentApproval capability layer, `app.state` wiring (UIAbility lifecycle
  edges + `onNewWant` notification tap), `ui-wait`/`ui-done` hilog markers
  that drive the E2E UI automation.
- `ci/run-host-e2e.sh` + `ci/drive-binding.mjs` — one command drives the
  whole on-emulator E2E: build -> install -> launch -> hilog-tailed UI
  automation (uitest clicks with polled deadlines: Approve, notification
  consent Allow, Home, notification-center tap) -> capture pull -> four
  checker verdicts + screenshots.

## D9 official phases (mount + httpFetch v2 + session-live)

ONE launch chains three D9 phases after the m5 verdict (each on a FRESH
runtime; every phase's capture file holds exactly its own manifest's
records):

1. **b-harmony.official-web-mount** — the ArkTS carrier implements the
   `ctx.webServer` contract subset: `WebDist` (fallback), `WebPlugins`
   (/plugins combos), `ApiBridge` (/api envelope + /api/remote.mux mux
   seat). A fresh runtime runs the canonical `b1-web-live` scenario, posts
   `web.boot` over the bus seam, the carrier swaps the rows into the index
   render pipeline, and ArkWeb mounts the official app; the same-origin
   probe reads module.system.live / app.shell.rendered / page.rendered.
2. **b-harmony.httpfetch-v2** — `HttpFetch.ets` serves the httpFetch
   primitive over `@ohos.net.http requestInStream` (streaming body, abort,
   refused); the proof scenario runs against the live carrier.
3. **b-harmony.session.live** (W-HARMONY3) — the FULL upstream agent spine
   boots in a fresh runtime (`harmony-session-live.js` → `upstream/boot.js`:
   ctx.sessions / agents / agentLoop / tools / systemPrompt /
   sessionProjections / settings + the vendored dsh-llm `LlmRuntime` whose
   transport is the REAL gateway httpFetch against the carrier's SCRIPTED
   `/mock-llm/chat/completions` SSE endpoint — real transport, scripted
   model, logged as such). One scripted-llm turn is the journal baseline;
   then `web.boot` + the claims go live on the SAME ctx
   (`session.list` + `session/journal` answered from ctx.sessions —
   everything else stays structured-unavailable), the official page mounts,
   and the b3 probe (`SessionLiveProbe.ets`) posts the REAL session.list,
   attaches the mux journal stream, collects the 19 frames (11-event
   baseline + the 8-event live turn 2), and reads the rendered state.
   The runtime half stays resident; the verdict is the drive's
   (`dsh.spike.verdict: b-harmony.session.live`).

The spine closure travels in `rawfile/spike/` byte-identical to the
runtime/spike canonicals: `ci/vendor-official.sh` copies + cmp-verifies the
authored spine files, the 14 vendored spine packages (lib/ trees +
package.json) and the pinned zod classic closure (gitignored verbatim
bytes — the content gates never judge vendored upstream JS), and
`ci/check-bundle-files.mjs` pins `Index.ets` BUNDLE_FILES == the rawfile
tree in both directions (the #56-class drift guard; dsh-mobile#57 proposes
the gate). Evidence: [artifacts/d9-official-web/](artifacts/d9-official-web/)
(six verdicts + the session-live verdict, captures, screenshots).

Threading (ARCHITECTURE.md §6): the regression trio runs synchronously inside
the NAPI call on the caller thread; the binding phase is driven per event —
but every mutator (WS frame in, UI settle, lifecycle edge) still executes on
the ArkTS main thread, the ONE serial JS runtime thread. The bus-seam
callbacks that fire while JS runs only queue or send (never re-enter the
runtime); settlement rides later UI-callback ticks.

## M1 spike (landed)

The original carrier spike that embedded the merged M1 core spike
([runtime/spike/README.md](../../runtime/spike/README.md)) and verified scenario
`m1.spike.boot` on the local HarmonyOS emulator. Evidence:
[artifacts/m1-spike/](artifacts/m1-spike/) (logs, sink capture, verdict, screenshot,
receipt).

Layout:

- `build-profile.json5` / `hvigorfile.ts` / `oh-package.json5` / `hvigor/` — project level
  (hvigor 6.x, modelVersion 5.0.0, `compatibleSdkVersion: "26.0.0"`).
- `AppScope/` — app identity (`com.dshmobile.spike`).
- `entry/src/main/cpp/` — the NAPI library (`libspike.so`): CMake compiles
  `runtime/spike/host/dsh_spike_host.c`, `gateway_smoke.cpp`, plus the pinned
  quickjs-ng 0.17.0 sources (`dtoa.c libregexp.c libunicode.c quickjs.c`) through
  hvigor's externalNativeOptions. CMake runs `runtime/spike/vendor/ensure.sh`
  first, so the vendor tree is always materialized before compiling.
- `entry/src/main/ets/pages/Index.ets` — materializes the bundled spike (byte-identical
  rawfile copies of `logger.js`, `gateway.js`, `registry.js`, the three scenarios, the
  three system plugins, and the vendored util-crypto package) into the app cache dir
  preserving layout, then calls `startSpike` ONCE and shows the returned verdict.
- `entry/src/main/resources/rawfile/spike/` — the bundled spike JS (kept byte-identical
  to the `runtime/spike/` and `system-plugins/` originals; the m1-spike-boot.js copy
  was found stale after the M2 slimming landed upstream and is refreshed here — drift
  in these copies is silent otherwise, see the surprise ledger).

Log capture: the C sink forwards each canonical `dsh.spike.log:` line unmodified to
hilog (domain `0xD5E0`, tag `dsh.spike`, `%{public}s`) AND appends it to a capture file
under the app cache dir (`haps/entry/cache/dsh-spike-capture.log`), pulled via
`hdc file recv` as the truncation-proof second capture.

## Build and run (CLT 26.0.0.821)

One command drives the whole on-emulator E2E (start the emulator first —
`"$CLT/emulator/Emulator" -start dsh_phone`, wait for `hdc list targets`):

```sh
hosts/harmony/ci/run-host-e2e.sh [artifacts-dir]
# build -> install -> launch -> hilog-tailed UI automation (uitest) ->
# capture pull -> 7 checker verdicts (m1.spike.boot, m2.bridge.smoke,
# m2.session, m5.host-binding, b-harmony.official-web-mount,
# b-harmony.httpfetch-v2, b-harmony.session.live) + screenshots;
# DSH_SKIP_BUILD=1 skips hvigor
```

Manual flow, step by step:

```sh
CLT=/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools
cd hosts/harmony
"$CLT/bin/ohpm" install --all
"$CLT/bin/hvigorw" assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# → entry/build/default/outputs/default/entry-default-unsigned.hap

HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
"$HDC" install entry/build/default/outputs/default/entry-default-unsigned.hap
"$HDC" shell power-shell wakeup            # unlock the emulator screen first
"$HDC" shell uinput -T -m 400 1600 400 400 300
"$HDC" shell hilog -r                      # clear, then launch
"$HDC" shell aa start -b com.dshmobile.spike -a EntryAbility
"$HDC" shell hilog -x | grep dsh.spike     # four `dsh.spike.verdict:` lines expected
"$HDC" file recv /data/app/el2/100/base/com.dshmobile.spike/haps/entry/cache/dsh-spike-capture.log .
"$HDC" file recv /data/app/el2/100/base/com.dshmobile.spike/haps/entry/cache/dsh-host-capture.log .
"$HDC" shell snapshot_display -f /data/local/tmp/m5-screenshot.jpeg
"$HDC" file recv /data/local/tmp/m5-screenshot.jpeg .

node ../../tools/e2e/check.mjs --manifest ../../tools/e2e/scenarios/m1-spike-boot.json --log sink-capture.txt
node ../../tools/e2e/check.mjs --manifest ../../tools/e2e/scenarios/m2-bridge-smoke.json --log sink-capture.txt
node ../../tools/e2e/check.mjs --manifest ../../tools/e2e/scenarios/m2-session.json --log sink-capture.txt
node ../../tools/e2e/check.mjs --manifest ../../tools/e2e/scenarios/m5-host-binding.json --log binding-capture.txt
```

No signing config is needed: the emulator accepts the unsigned debug HAP via
`hdc install` as-is.
