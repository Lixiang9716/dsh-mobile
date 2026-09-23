# hosts/android/

The Android host. v1 is isomorphic with iOS (quickjs-ng + Kotlin gateway); v2 may add a
nodejs-mobile high-fidelity mode (V8 JIT + Termux-pattern subprocesses), with the difference
expressed via RuntimeDescriptor capabilities.

## Host status: completion — carrier + WebView mount + the real nine-primitive binding

On top of the three-scenario regression (below), the host completion session
(`android.capability-binding`, launch with `--ez dsh.m4 true`) proves the host behaves like the iOS host:

- **Local carrier** (`CarrierServer.kt`) — a raw `ServerSocket` on 127.0.0.1 (the Kotlin sibling
  of hosts/ios `CarrierServer.swift`): loopback HTTP static serving of the embedded Web Client
  and a minimal RFC6455 WS text-frame pump (SHA-1 accept via `MessageDigest`), shuttling JSON
  lines between the WebView and the runtime thread over the platform-neutral bus seam
  (`dsh_spike_set_bus_sink` / `dsh_spike_bus_deliver`).
- **Web Client mount** — a real `WebView` loads `http://127.0.0.1:<port>/` and renders the
  session live (slot button, token deltas, session-complete line); the presentation/web-client
  files ride in assets byte-identical to the canonicals.
- **The nine gateway primitives are real** (`GatewayCore.kt` + one file per surface, ports of
  hosts/ios `Gateway/`): fsRead/fsWrite over a scope registry (reserved `app` scope =
  `filesDir/profiles/default`, user scopes = SAF tree URIs); fsScope persist/resolve over a
  file-backed scope registry (`bkm:` refs — the SAF analogue of iOS security-scoped bookmarks);
  httpFetch over `HttpURLConnection` with the body streamed as ≤16 KB `http.body` events +
  abort → `cancelled`; notify via NotificationManager (tap → `notify.response`, frozen order
  before `app.state foreground`); presentApproval (AlertDialog) and presentPicker (SAF
  ACTION_OPEN_DOCUMENT_TREE) on the UI thread with results settled onto the runtime queue;
  keychainGet/keychainSet sealed with a hardware-backed AndroidKeyStore AES-256-GCM key
  (AndroidKeyStore stores keys, not blobs — the ciphertext persists app-privately). Event
  channels: `app.state` from activity lifecycle edges (deduped), `notify.response` from the
  notification's PendingIntent. Descriptor: nine available, zero unavailable (conformance §7).
- **Audit**: one structured record per call on the `dsh.spike.audit` tag
  (`dsh.gateway.audit: ` prefix, never payload contents) — the frozen `gateway.audit`
  manifest re-verified against the m4 session's call sequence.

Threading law unchanged: JS executes only on `HandlerThread("dsh-spike-js")`; the carrier
threads, fetch threads, and the UI thread never touch the runtime — every settle/event/bus
delivery hops through `SpikeRuntime.post`.

Evidence (one run, final code state): `artifacts/m4-complete/` — `logs.txt` + `scenario.jsonl`
+ `audit.jsonl`, `verdict-android-capability-binding.json` + `verdict-gateway-audit.json` (checker
PASS), the regression verdicts, `screens/` (mount, picker, approval, notification shade,
final — human evidence only), `receipt.json`.

## Regression status: gateway bridge + first session green on emulator

The app embeds the shared spike host (`runtime/spike/host/dsh_spike_host.c`) with its REAL
gateway dispatch bridge (no canned responses — the canned single-call slot is gone) and runs ALL
THREE scenarios in one launch, judged by the shared checker:

- `boot.verification` — boot regression, 7/7 canonical events.
- `gateway.bridge-smoke` — the gateway bridge end to end, 6/6 canonical events: fsWrite/fsRead of 17
  base64-carried bytes, the scope-escape `invalid` rejection, and `keychainGet` rejected with the
  honest `unavailable` code.
- `session.mock-llm` — the first MINI agent session on Android, 23/23 canonical events: the three
  system plugins (dsh-fs / dsh-subprocess-quickjs / dsh-ui) install through `registry.js`, the
  `host.info` readiness event starts the session, the mock LLM streams token deltas, one tool
  call runs through the subprocess plugin and persists via dsh-fs under scope `app`
  (`smoke-fs/session-mock-llm/result.txt`, roundtripped).

Evidence (one run, final code state): `artifacts/m4-host/` — `logs.txt` (logcat `-s dsh.spike`),
`scenario.jsonl` (canonical `dsh.spike.log:` lines), `verdict-boot-verification.json` +
`verdict-gateway-bridge-smoke.json` + `verdict-session-mock-llm.json` (checker PASS), `screenshot.png`
(human evidence only — never a checker input), `receipt.json`.

## How it works

- `app/src/main/cpp/dsh_spike_smoke.c` — the Android smoke backend, sibling of
  `runtime/spike/host/main_cli.c`'s: calls are only QUEUED inside the dispatch callback (which
  fires synchronously on the runtime thread) and settled in the post-pump drain pass — the
  deferred later-tick settlement the scenario proves. `fsRead`/`fsWrite` run base64 payloads
  against `filesDir/smoke-fs` (scope `app`, escape-checked, parent dirs created on write); the
  six primitives the descriptor declares unavailable (`keychainGet`, `keychainSet`, `httpFetch`,
  `notify`, `presentApproval`, `presentPicker`) reject with `unavailable`; anything else rejects
  `invalid` with the offending name. The descriptor is identical to the CLI's, and the
  `host.info` readiness event (`{"event":"host.info","port":0}`) is delivered after eval exactly
  like the CLI. NO new primitives, NO contract changes.
- `app/src/main/cpp/dsh_spike_jni.c` — one fresh `dsh_spike_t` runtime per scenario, whole
  lifecycle on the CALLING thread; Kotlin (`SpikeRuntime`) keeps that caller a single
  `HandlerThread("dsh-spike-js")` (logcat pid/tid columns prove the split from the UI thread).
- `app/src/main/assets/spike/` — the spike bundle as byte-identical copies of `runtime/spike/`
  (`gateway.js`, `registry.js`, `scenario/boot-verification.js`, `scenario/gateway-bridge-smoke.js`,
  `scenario/session-mock-llm.js`, `logger.js`, `vendor/dsh/util-crypto@0.1.6-alpha.1`) plus the three
  system plugins (`system-plugins/dsh-fs`, `dsh-subprocess-quickjs`, `dsh-ui` from the repo
  root), cmp-verified at authoring time; unpacked to `filesDir/spike` at first run because the C
  host fopen()s real paths. The repo has no drift-check tool for these copies yet — provenance
  is this paragraph (and the receipt).
- Capture: every canonical line goes UNMODIFIED to logcat (tag `dsh.spike`) AND to
  `filesDir/spike-capture-<scenario>.log` (pulled via `adb exec-out run-as com.dshmobile.spike
  cat ...` — the truncation-proof cross-check); per-scenario verdicts land on tag
  `dsh.spike.result`, terminated by the `ALL PASS` / `ALL FAIL` line.

## How to run

```sh
# SDK root /opt/homebrew/share/android-commandlinetools, JDK17, AVD `pixel` (API 35 arm64)
export JAVA_HOME=/Library/Java/JavaVirtualMachines/microsoft-17.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
echo "sdk.dir=$ANDROID_HOME" > hosts/android/local.properties
$ANDROID_HOME/emulator/emulator -avd pixel -no-window -no-audio -no-boot-anim -no-snapshot -port 5554 &
(cd hosts/android && ./gradlew assembleDebug --no-daemon)
bash hosts/android/ci/run-spike-e2e.sh      # the three-scenario regression (what CI runs)
bash hosts/android/ci/run-android-full.sh   # regression + the android.capability-binding completion session
```

`run-android-full.sh` stages the SAF picker target (`/sdcard/dsh-e2e/notes.txt`), pre-grants
POST_NOTIFICATIONS, drives the UI-driven primitives (SAF picker, approval dialog, notification
banner) via `uiautomator dump` + `input tap` under polled deadlines, and captures screenshots
at each stage.

CI (`.github/workflows/dev-android.yml`) runs the three-scenario regression script against an
API 35 x86_64 emulator.


## Real-LLM session (scenario `llm.live-stream`, real leg)

Launch with `--ez dsh.llm true` (`hosts/android/ci/run-live-llm.sh`): the Android host
completion flow (loopback carrier + WebView + real nine-primitive gateway)
drives `scenario/llm-live-stream.js` — ONE streamed chat completion against an
OpenAI-compatible backend through the REAL gateway `httpFetch`. Credentials
ride fs scope "app": the runner stages
`files/profiles/default/llm-live-stream/config.json` (`{baseUrl, apiKey, model}` from
`ZAI_BASE_URL`/`ZAI_API_KEY`/`ZAI_MODEL` in the env or repo-root `.env`) via
`run-as` before launch — the key is never echoed and is grepped OUT of the
captured log afterwards (fail loud on a leak). The served model name is
logged verbatim (`llm.served-model`); the deltas stream live into the
WebView-mounted Web Client. Evidence: `artifacts/m2-llm/` (logs.txt +
scenario.jsonl + verdict-llm-live-stream-device.json 14/14 +
verdict-llm-live-stream-carrier.json 7/7 + receipt.json + MANIFEST.md).