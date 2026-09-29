# Agent Note: the simulator matrix proves both halves — release absence + harness drive, one command

Status: implemented

## Problem

The evidence net had no single driver for "the shipping configuration boots
clean AND the harness drives the whole app, on a simulator, today": CI
`dev/ios` runs only the two m1 scenarios (hosted runners cannot drive UI),
`dev/android` the log-driven regression, HarmonyOS has no simulator leg at
all, and the per-milestone runners (`run-ios.sh`, `run-ios-device-plane.sh`,
`run-spike-e2e.sh`, `run-device-plane.sh`, the two `release-logging`
`run.sh`s) each proved one slice under its own invocation. Release-grade
verification meant remembering five entry points plus the flavor-split rules
that govern them. The commissioning ask assumed the e2e legs could simply run
"under the Release configuration" — expired on current main: the Release
build compiles the drives OUT and refuses them by name
(`MainActivity.bootRelease`, `AppDelegate.bootRelease`; AGENTS.md constraint
5 / rules.md rule L4), so a Release e2e run is a category error, not a gap.

## Decision

`tools/test/run-simulator-matrix.sh` runs both halves the flavor split
defines, per platform, and stops at the first failure:

- **release leg** — the Release build, plain-launched on dsh-iphone (iOS
  26.5) / the API 35 emulator: asserts zero drive choreography
  (`spike: sequence` / `ui-wait` / announced modes / verdict text /
  `dsh.spike.result`) and zero debug/info logger records, proves the official
  surface (iOS: liveness hold + screenshot; Android: carrier LISTEN + page
  fetch + `GET / -> 401` through adb forward), and requires the drive
  refusal BY NAME (`-dsh-mode session` / `--ez dsh.llm true`). Audit lines
  and warn records are RECORDED in `release-proof.json`, never asserted
  zero.
- **harness legs** — the existing runners unchanged against the Debug
  harness: iOS `run-ios.sh` (gateway drive) + `run-ios-device-plane.sh`,
  Android `run-spike-e2e.sh` + `run-device-plane.sh`; evidence dirs in the
  committed-leg shape, receipts machine-authored on the green path only.
- **harmony** — an honest skip receipt when no DevEco/hdc target exists
  (D-g standby); dies loud if a target IS present, pointing at the real leg.
- **capability skips** — probed idb presence gates the iOS UI legs; standing
  hardware rows (camera/BT/NFC) record the simulator's missing radios and
  the capability-negotiation baseline (the device-plane precedent: the
  harmony emulator's pasteboard answers honestly `unavailable`).
- A failed leg's evidence dir moves to /tmp so the e2e-matrix gate never
  inventories a verdict-bearing dir without its receipt.

The matrix is deliberately not wired into the gate DAG — running it is a
release ritual; gating it is a later decision.

## Alternatives considered

- **Run the e2e legs under Release (the ask's literal step).** Rejected —
  impossible by design and dishonest to fake; the release leg proves
  absence + refusal instead and scenario coverage rides the harness.
  (Surprise ledger: `the-matrix-asks-step-2`.)
- **One monolithic runner reimplementing the drives.** Rejected — it would
  fork five proven runners and their calibrated machinery (WDA port
  derivation, the coordinate law, canary-pinned logcat capture); the matrix
  orchestrates them unchanged instead.
- **Assert the release launch emits nothing at all** (the committed
  release-logging shape). Rejected — measured stale the hard way: the
  committed runner's own 0-records/0-audit assertions FAIL on today's main
  (repro: build Release+Debug into one DD, `DSH_IOS_DD=<dd>
  hosts/ios/artifacts/release-logging/run.sh --skip-build` → "release
  emitted an E2E record"), because the release serving boot brings up the
  full agent spine — audit lines ride NSLog regardless of flavor and L4
  keeps warn/error. (Surprise ledger; the committed release-logging dir is
  the release work stream's and was restored untouched.)
- **Also run run-android-full.sh's three web phases.** Deferred — they
  duplicate scenarios already green-covered in committed evidence and write
  into the register's owned gap dirs; the matrix covers the log-driven
  regression + device-plane, and the web phases remain available through
  the runner itself.

## Consequences

"Simulators prove the release and drive the harness" is now one command
whose summary reads in five minutes; the cost is that it stays a manual
ritual until someone decides to gate it. Two rake-stepping fixes are baked
into the leg code with their measurements: the Files-provider index-settle
order (the release leg re-stages the picker target BEFORE the harness
builds — a fresh staging minutes before the drive lost the race and starved
the binding watchdog) and the Android carrier discovery (a second listener
starved the `head -1` shape; the carrier is now "a uid self-connection",
which also names the port for the 401 probe).
