# Evidence — the user-facing build (`dsh-android`), plain launch

Proves the ABSENCE of test machinery in the release build on a REAL emulator,
and that the harness is unchanged. Both from the same command:

- Run: `hosts/android/artifacts/release-logging/run.sh` (builds both variants,
  signs the release copy, installs, launches, asserts every count — exit
  non-zero on any violation). `--skip-build` re-asserts against the APKs
  already on disk.
- Device: AVD `pixel` — Pixel 7, API 35, `arm64-v8a`, `emulator-5554`.

The release boot has NO completion tag (a user-facing build has no verdict to
wait for), so its outcome is proved by conditions read from the kernel and the
network rather than from the app's cooperation — see "how the positive
assertions work" below. Every absence claim is a log assertion; the
screenshots are supplementary.

## Release (`dsh-android`) — plain launch, nothing staged

| assertion | result |
| --- | --- |
| `dsh.spike.log:` records anywhere on the device | **0** (`plain-launch-release.logcat.txt` — 0 bytes; the tag-filtered capture of the whole buffer) |
| `"level":"debug"` records | **0** (`plain-launch-release.app.logcat.txt`, 0/118 lines) |
| `"level":"info"` records | **0** (same file) |
| `dsh.gateway.audit:` lines | **0** (same file) |
| verdict text: `dsh.spike.result` lines / `ALL PASS` / `ALL FAIL` / `official FAIL` | **0 / 0 / 0 / 0** (same file) |
| the app's own log stream is NOT empty | 127 lines on the app pid — 34 `dshmobile.spike`, 26 `TrafficStats`, 13 `chromium`, `EGL_emulation`/`nativeloader`/`HWUI` (the WebView engine is live). The zero counts above are a real absence, not a dead capture |
| official Web UI rendered | `plain-launch-release.png` (the DSH sidebar, the "Into the Unknown / Preview" mark, the whale, the workspace picker and the composer with its attach and send controls, full screen — no verdict panel) |
| the loopback carrier is up, owned by the app | `origin-release.txt`: LISTEN row for the app uid at `127.0.0.1:45285` (from `/proc/net/tcp6`) |
| the WebView really fetched that origin | `origin-release.txt`: `page connections to the carrier: 2` (non-LISTEN rows whose REMOTE address is the carrier port) |
| the official dist seat answers the origin | `origin-release.txt`: `GET / -> status=401 bytes=0` through `adb forward` — the auth-lite token gate of the dist seat; a dead origin would have refused the connection |
| the launcher focus is the app | `origin-release.txt`: `mCurrentFocus=Window{… com.dshmobile.spike/com.dshmobile.spike.MainActivity}` |
| the release build is not debuggable | `run.sh` asserts `run-as com.dshmobile.spike ls files` FAILS (the harness-only capture vehicle is unavailable by construction) |
| embedded assets in the shipped APK | `apk-release-contents.txt`: 89 `assets/official-web/` entries + 129 `assets/web-plugins/` entries + 254 `assets/spike/` entries, including `official-web/dist/index.html`, `spike/logger.js`, `spike/scenario/b-android-web-live.js` (`apk-release-listing.txt` is the raw listing) |

The counts in this MANIFEST are the RECORDED run's (2026-09-21, `emulator-5554`);
the carrier port and the app uid change every install, and the incidental line
counts drift by a few. The assertions — not the numbers — are what re-runs:
`run.sh` fails loud on the first violation.

The app's `filesDir` was empty before the launch (the run uninstalls first):
the client is served from the APK's EMBEDDED assets, so a plain launch needs
nothing staged from outside — the same shape as the iOS sibling.

## The shipped artifact and the local verification signing

`release.yml` uploads `app-release-unsigned.apk`, and `apk-release-contents.txt`
records `apksigner verify` saying **DOES NOT VERIFY / Missing META-INF/MANIFEST.MF**
— the shipped artifact is genuinely unsigned. The emulator will not install an
unsigned APK, so `run.sh` signs a **COPY** with `~/.android/debug.keystore`
into `/tmp/dsh-release-verify/` (never into the repository — no `.apk` is
tracked in this repo).

**That signing is a LOCAL VERIFICATION STEP ONLY.** It says nothing about the
shipped artifact's state, which stays unsigned until the user signs it with
their own key (`docs/release.md`). `signing.txt` records the exact command and
the signer (`CN=Android Debug`).

## Harness (`dsh-android-harness`) — the same plain launch

| assertion | result |
| --- | --- |
| `dsh.spike.log:` records | **204** (`plain-launch-harness.logcat.txt`, 209 lines) |
| `"level":"debug"` / `"level":"info"` | **168** / **36** |
| completion | `ALL PASS` — `m1.spike.boot`, `m2.bridge.smoke`, `m2.session` all PASS |
| verdict panel on screen | `plain-launch-harness.png` (the three verdict lines; no official Web UI — the harness stages its own trees and this plain launch runs the regression suite) |

The harness stream is complete within ~1 s of device time
(`14:57:37.266` → `14:57:38.141`), and the release window below is 25 s long:
the observation window strictly contains a full reference stream. The contrast
is what makes the release's zeros meaningful — the capture channel is proven
live by the harness in the same session, not assumed.

## The refusal (rules.md rule 5)

The release build refuses an E2E drive BY NAME instead of silently doing
nothing. `--ez dsh.llm true` on `dsh-android` stops `onCreate` with:

```
java.lang.IllegalStateException: DSHSpike release build: refusing 'dsh.llm'.
This is the user-facing distribution build — the verification drives, the
verdict panel and the per-event E2E log stream are compiled out (AGENTS.md
constraint 5, rules.md rule L4). Install the harness variant
(dsh-android-harness) to drive E2E legs.
```

(`refusal.logcat.txt` lines 155 and 170 — the wrapper and the cause; one
`FATAL EXCEPTION` for the run, 0 `dsh.spike.log:` records in the window.)

This mirrors the iOS release, which stops with
`DSHSpike release build: refusing '-dsh-mode session'`; both name the
offending request and both are loud stops, not no-ops.

## How the positive assertions work (no app cooperation needed)

The release build is not debuggable and logs nothing of its own, so the run
proves the boot from the outside:

1. **The carrier listener** — `/proc/net/tcp{,6}` is world-readable; the row
   with state `0A` (LISTEN) whose `uid` column is the app's uid (read from
   `stat -c %u /proc/<pid>`) is the carrier socket. Polled with a 90 s
   deadline.
2. **The page fetch** — a non-LISTEN row whose REMOTE address is that port
   means the WebView connected to the origin. The check reads the REMOTE
   column on purpose: the listener's own row carries the port in its LOCAL
   column, so a naive grep for the port would match the listener and prove
   nothing (this script was written that way first and fixed).
3. **The seat answers** — `adb forward` + `curl` on that port returns 401: the
   auth-lite token gate of the official dist seat, which is only reached if
   the route table and the dist handler are mounted.

Every wait is a polled condition with a deadline (rules.md rule 8); the single
fixed hold bounds the observation window and awaits no state.

## Files

`plain-launch-release.logcat.txt` (0 bytes, tag-filtered whole buffer),
`plain-launch-release.app.logcat.txt`, `plain-launch-release.png`,
`refusal.logcat.txt`, `plain-launch-harness.logcat.txt`,
`plain-launch-harness.png`, `origin-release.txt`, `apk-release-contents.txt`,
`apk-release-listing.txt`, `signing.txt`, `run.sh`.

## Known gap (not a regression — nothing fails today)

The release strip is enforced by `runtime/spike/logger.js`, the OPERATIVE
logger. Two raw-sink emitters beside it do NOT consult `__DSH_RELEASE__`:
`runtime/spike/upstream/web-shims.js` installs a forwarding `console` whose
`log`/`info`/`debug` write straight to `__DSH_LOG_SINK__` as `"level":"info"`,
and `runtime/spike/upstream/boot.js`'s `wireLogger` does the same for cordis
records. Both are on the release path's import graph (`web-boot.js` imports
`./web-shims.js`). Measured today: 0 records, and the vendored closure the
release path loads (dsh-client-modules, cordis, cosmokit, schemastery) has
**zero** `console.log/info/debug/trace` calls — so the absence is real, but it
rests on the vendored closure staying quiet rather than on the flag. A single
`console.log` added upstream would put an `"level":"info"` record into a
user-facing build. Reported rather than patched here: it is shared runtime
code across all four hosts and needs its own iOS/Android re-verification.

The emulator is local evidence; CI (`dev-android.yml`, API 35 x86_64) is the
arbiter for the harness regression.
