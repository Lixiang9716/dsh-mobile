# hosts/harmony/

The HarmonyOS NEXT host (M5): ArkTS shell + NAPI bridge to quickjs-ng + ArkWeb.
Subprocesses are designed as unavailable; store-review posture to be verified in practice.

## M5 host (isomorphic: carrier + binding + regression trio, all green)

ONE launch on the emulator now proves the host end to end in two phases:

1. **Regression trio (synchronous)** — `startSpike` runs `boot.verification`
   (7/7), `gateway.bridge-smoke` (6/6) over the REAL gateway dispatch bridge, and
   `session.mock-llm` (23/23, the notes.installed manifest) on the ONE serial JS
   thread inside the NAPI call.
2. **Binding phase (event-driven)** — `CarrierServer.ets` serves the
   materialized `presentation/web-client` over loopback HTTP and pumps a
   minimal RFC 6455 WS text-frame channel; ArkWeb mounts the page
   (`webclient.mounted` -> `ws.connected`), `HostPhase.ets` evals
   `scenario/harmony-capability-binding.js` and delivers `host.info`, and the
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

## D9 official phases (mount + httpFetch v2 + session-live + write-live)

The SERVING half of this stack is one seat — `model/OfficialServe.ets` — and
it is what a RELEASE launch runs: routes -> listen -> the web-boot runtime
composes the boot wire -> `web.boot` rows into the index render pipeline ->
ArkWeb mounts the origin. No drive, no probe, no record. The EVIDENCE half
is `model/OfficialPhase.ets`, which attaches to that seat through its hook
properties and adds the canonical `dsh.spike.log:` records, the same-origin
probes, the proof legs below and the verdicts. A release build therefore
serves the official UI on a plain launch (`--ps dsh.e2e.leg <leg>` refuses
loud by name — rule 5), and the harness behaviour below is unchanged.
Evidence: [artifacts/release-logging/](artifacts/release-logging/).

ONE launch chains four D9 phases after the m5 verdict (each on a FRESH
runtime; every phase's capture file holds exactly its own manifest's
records):

1. **harmony.officialweb.mount** — the ArkTS carrier implements the
   `ctx.webServer` contract subset: `WebDist` (fallback), `WebPlugins`
   (/plugins combos), `ApiBridge` (/api envelope + /api/remote.mux mux
   seat). A fresh runtime runs the canonical `officialweb-web-live` scenario, posts
   `web.boot` over the bus seam, the carrier swaps the rows into the index
   render pipeline, and ArkWeb mounts the official app; the same-origin
   probe reads module.system.live / app.shell.rendered / page.rendered.
2. **harmony.httpfetch-streaming** — `HttpFetch.ets` serves the httpFetch
   primitive over `@ohos.net.http requestInStream` (streaming body, abort,
   refused); the proof scenario runs against the live carrier.
3. **harmony.session.live-read** (W-HARMONY3) — the FULL upstream agent spine
   boots in a fresh runtime (`harmony-session-live-read.js` → `upstream/boot.js`:
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
   (`dsh.spike.verdict: harmony.session.live-read`).
4. **harmony.composer.live-write** (W-HARMONY4) — the SESSION WRITE surface: a
   fresh runtime boots the spine and the web-boot producer composes WITH
   the write surface (`harmony-composer-live-write.js` → `upstream/web-write.js`):
   `session/create` + `session/prompt` (upstream commands.prompt
   admission: `{accepted:true}` without awaiting the turn),
   `settings/describe|update|mutate` (the real vendored provider, the
   mobile `ui-onboarding` namespace volatile), and the mux
   `session/follow` / `workspace/follow` / `session/control` / `$events`
   streams. The write probe (`SessionWriteProbe.ets`) drives the OFFICIAL
   UI like a user — settle at the workspace picker, pick the seeded
   workspace, type into the real Lexical composer, click send — and the
   page's own message admits a REAL upstream agent-loop turn
   (user/message → agent-loop events → assistant deltas → turn/end,
   11 events) streamed live over the mux and rendered in the official DOM
   (the reply screenshot). Everything the spine does not implement stays
   structured-unavailable. Verdict: `dsh.spike.verdict:
   harmony.composer.live-write`.

The spine closure travels in `rawfile/spike/` byte-identical to the
runtime/spike canonicals: `ci/vendor-official.sh` copies + cmp-verifies the
authored spine files, the 14 vendored spine packages (lib/ trees +
package.json) and the pinned zod classic closure (gitignored verbatim
bytes — the content gates never judge vendored upstream JS), and
`ci/check-bundle-files.mjs` pins `Index.ets` BUNDLE_FILES == the rawfile
tree in both directions (the #56-class drift guard; dsh-mobile#57 proposes
the gate). Evidence: [artifacts/d9-official-web/](artifacts/d9-official-web/)
and [artifacts/d9-write-live/](artifacts/d9-write-live/) (eight verdicts,
captures, screenshots — the write dir carries the composer-typed +
reply-rendered pair).

Threading (ARCHITECTURE.md §6): the regression trio runs synchronously inside
the NAPI call on the caller thread; the binding phase is driven per event —
but every mutator (WS frame in, UI settle, lifecycle edge) still executes on
the ArkTS main thread, the ONE serial JS runtime thread. The bus-seam
callbacks that fire while JS runs only queue or send (never re-enter the
runtime); settlement rides later UI-callback ticks.

## M1 spike (landed)

The original carrier spike that embedded the merged M1 core spike
([runtime/spike/README.md](../../runtime/spike/README.md)) and verified scenario
`boot.verification` on the local HarmonyOS emulator. Evidence:
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
  to the `runtime/spike/` and `system-plugins/` originals; the boot-verification.js copy
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
# capture pull -> 8 checker verdicts (boot.verification, gateway.bridge-smoke,
# session.mock-llm, harmony.capability-binding, harmony.officialweb.mount,
# harmony.httpfetch-streaming, harmony.session.live-read,
# harmony.composer.live-write) + screenshots;
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

node ../../test/e2e/check.mjs --manifest ../../test/e2e/scenarios/boot-verification.json --log sink-capture.txt
node ../../test/e2e/check.mjs --manifest ../../test/e2e/scenarios/gateway-bridge-smoke.json --log sink-capture.txt
node ../../test/e2e/check.mjs --manifest ../../test/e2e/scenarios/session-mock-llm.json --log sink-capture.txt
node ../../test/e2e/check.mjs --manifest ../../test/e2e/scenarios/harmony-capability-binding.json --log binding-capture.txt
```

No signing config is needed: the emulator accepts the unsigned debug HAP via
`hdc install` as-is.
