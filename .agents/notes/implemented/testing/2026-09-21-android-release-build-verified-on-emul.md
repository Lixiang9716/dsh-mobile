# Agent Note: the Android release build verified on a real emulator

Status: implemented
Related: D5, D6

## Problem

PR #83 made the release/harness split real on all three hosts, and iOS was
verified end to end — a plain launch of `dsh-ios` on the simulator reaches the
official DSH Web UI with 0 `dsh.spike.log:` records, 0 verdict text, and 0
debug/info records, against the harness's 83. Its own card closed it as an
honest gap, not a green:

> "Android is marked 'real; release path + embedded assets built and verified,
> but static verification only (no emulator available)'."

That left the platform most likely to diverge verified by reading code. The
Android mechanism is NOT the iOS mechanism: iOS compiles a Swift
`BuildFlavor` branch, while Android's release behaviour spreads across
`BuildConfig.DSH_RELEASE` (from `buildTypes.release`), a `cflags`
`-DDSH_RELEASE=1` reaching the C host, the shared
`globalThis.__DSH_RELEASE__` injection, the JS logger branch, `BuildFlavor.keeps`
filtering three Kotlin emitters, `bootRelease()`'s serving-only path, and a
Gradle asset staging step that has to embed 89 + 129 files into the APK. Any
one of those links could be silently absent and the static reading would not
have shown it. A user-facing build that ships the verification firehose, or
one that boots to nothing, is exactly the class of defect a build-time check
cannot rule out.

## Decision

**Verify the shipped Android release artifact on a real emulator, and make the
verification re-runnable.** `hosts/android/artifacts/release-logging/run.sh`
builds both variants, signs the release copy, installs, launches, and asserts
every count — exit non-zero on the first violation. It commits raw logcat
captures for both variants, the screenshots, and a `MANIFEST.md` mapping each
assertion to its file. Measured 2026-09-21, `emulator-5554`:

- `assembleRelease` produces `app-release-unsigned.apk` (6.5 MB), `apksigner
  verify` says DOES NOT VERIFY — as `release.yml` ships it — and the APK
  carries 89 `assets/official-web/` + 129 `assets/web-plugins/` + 254
  `assets/spike/` entries.
- Plain launch, nothing staged: the official DSH Web UI renders, and the
  device-wide logcat holds **0** `dsh.spike.log:` records, **0**
  `"level":"debug"`, **0** `"level":"info"`, **0** verdict text, **0**
  gateway-audit lines. The contrast run of `dsh-android-harness` on the same
  plain launch still emits **204** records (168 debug, 36 info, ALL PASS).
- `--ez dsh.llm true` on the release build is refused BY NAME and stops
  `onCreate` — loud, not a silent no-op.

Three decisions inside that are worth keeping:

**The positive assertions need no app cooperation.** The release build is not
(and must not be) debuggable, so `run-as` is unavailable and the app logs
nothing of its own. The run therefore proves the boot from outside it: the
carrier's LISTEN socket in `/proc/net/tcp{,6}` located by the app's uid, a
non-LISTEN row whose REMOTE address is that port (the WebView fetched the
origin), and a `curl` through `adb forward` answering 401 — the auth-lite gate
of the official dist seat. The 401 is the point: it can only be produced by
the mounted dist handler.

**Signing for the emulator is a local step, named as one.** The shipped APK is
unsigned by design and will not install. The run signs a COPY with
`~/.android/debug.keystore` into `/tmp` — never into the repository (no `.apk`
is tracked here) — and `MANIFEST.md` and `signing.txt` say plainly that this
is not the shipped artifact's state.

**The observation window is bounded, the waits are not.** Every wait polls a
real condition with a deadline (rules.md rule 8); the single fixed hold only
bounds the window in which absence is asserted, and the harness's whole
204-record stream lands within ~1 s of device time, so a 25 s window strictly
contains a full reference stream.

## Alternatives considered

- **Wire it into CI (`dev-android.yml`) and let the pipeline be the evidence.**
  Rejected for this PR: the harness regression already runs there, and the
  release path's absence assertions would need a signed release APK in CI —
  which means a signing key in the workflow, i.e. exactly the local-signing
  boundary the sequencing decision keeps out of CI. The evidence dir + the
  re-runnable script is the same shape iOS took.
- **Assert on `filesDir` instead of `/proc`.** Rejected: it needs the app to be
  debuggable. The release build must not be, and the run asserts that
  `run-as` FAILS — a security property worth pinning rather than weakening.
- **Trust the static reading and close the gap in prose.** Rejected — that is
  the gap being closed. Two things the emulator caught that reading had not:
  the official UI needs the carrier's ephemeral port to be discovered from the
  kernel (nothing in the release logs names it), and the `unzip -l | grep -q`
  idiom fails a SUCCEEDING check under `set -o pipefail` (grep exits, unzip
  takes SIGPIPE) — the script's first version died on it.
- **Patch the latent sink hole found while auditing.** Not in this change: see
  Consequences.

## Consequences

The Android release path is verified as SERVING the official UI, and the
user-facing/serving split holds on the platform whose mechanism differs most
from iOS. `run.sh` is re-runnable, so the claim has a maintenance path rather
than being a one-off transcript.

The audit surfaced a real, currently-dormant hole that is NOT fixed here:
`runtime/spike/logger.js` — the operative logger — honours
`__DSH_RELEASE__`, but two raw-sink emitters beside it do not.
`runtime/spike/upstream/web-shims.js` installs a forwarding `console` whose
`log`/`info`/`debug` write straight to `__DSH_LOG_SINK__` as `"level":"info"`,
and `runtime/spike/upstream/boot.js`'s `wireLogger` does the same for cordis
records. `web-shims.js` IS on the release path's import graph — the Android
release boot evaluates `scenario/b-android-web-live.js`, which imports
`upstream/web-boot.js`, which imports `./web-shims.js` — so the forwarding
`console` is installed and reachable in a user-facing build. Measured today: 0
records, and the vendored closure the release path loads (dsh-client-modules,
cordis, cosmokit, schemastery) has zero `console.log/info/debug/trace` calls —
so the absence is real, but it rests on the vendored closure staying quiet
rather than on the flag. One `console.log` added upstream would put an
`"level":"info"` record into a user-facing build. (`boot.js`'s `wireLogger` is
on the session-live path instead, which no release build reaches today.)

It is reported rather than patched in this PR because it is shared runtime
code: a fix has to reach the CLI, iOS and Android (and HarmonyOS, held by
another worker this session) and needs its own iOS re-verification, which
would have made this verification PR also a behaviour change to the artifact
it verifies. Recorded as `gov surprise record` sig
`the-release-strip-covers`.

Also unfixed and recorded: on a successful boot the release build never calls
`carrier.stop()` (only `finish()` does, and the release has no verdict to
settle on, so `pageDidFinish()` returns before the probe). Correct for a
user-facing app — the carrier must keep serving — but a reader comparing it
with the harness path should know it is deliberate.
