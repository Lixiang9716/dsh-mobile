# Agent Note: the release log strip is real end to end (flag plumbing, emitter gating, gate L4)

Status: implemented
Related: D5, D6

## Problem

AGENTS.md constraint 5 says release builds compile logs away
(`__DSH_RELEASE__`) and that the branch must stay wired (rule L4). The
2026-09-21 audit found the mechanism COSMETIC:

1. `runtime/logger/index.ts` declares the flag and returns a no-op logger
   when it is true — but **nothing in the repository ever defined it**. No
   Xcode compilation condition, no Gradle `buildConfigField`, no hvigor
   define, no C `#define`. A repo-wide grep for `DSH_RELEASE` hit only
   AGENTS.md, the gate, and that one file.
2. `runtime/spike/logger.js` — the logger the SHIPPED app actually runs,
   embedded byte-identically into all three hosts — had **no release branch
   at all**. Its header said "debug-only by construction", but it is a port
   of the TS logger, so that was a contract divergence, not a design.
3. `tools/check-logging.py` L4 only checked that the STRING `__DSH_RELEASE__`
   appeared somewhere under `runtime/logger/`. It passed green while the
   operative logger was unconditional — a gate that could not see the
   violation it claimed to catch (rule 6).
4. Every native E2E emitter printed unconditionally, and `release.yml`
   built **Debug on all three platforms**, so the "release packages" carried
   the full per-event E2E stream by construction.

A user handing `dsh-ios` to someone would have handed over a verification
harness with a debug log firehose attached — the owner's point: full logging
exists FOR TESTING, and the release build is for users, not for testing.

## Decision

**One define, four platforms, Release configurations only.** The flag is
`DSH_RELEASE`, and each platform's Release configuration defines it:

- **iOS** — `hosts/ios/DSHSpike.xcodeproj/project.pbxproj`, project-level
  Release config: `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DSH_RELEASE` for
  Swift and `GCC_PREPROCESSOR_DEFINITIONS = ("$(inherited)", "DSH_RELEASE=1")`
  for the C host.
- **Android** — `hosts/android/app/build.gradle.kts` `buildTypes.release`:
  `buildConfigField("boolean", "DSH_RELEASE", "true")` for Kotlin and
  `externalNativeBuild.cmake.cFlags += "-DDSH_RELEASE=1"` for the `.so`.
  `cFlags`, not `cppFlags`: the spike target is C-only
  (`project(dsh_spike_android C)`), and `cppFlags` maps to `CMAKE_CXX_FLAGS`
  — it silently reached nothing on the first attempt.
- **HarmonyOS** — `hosts/harmony/entry/build-profile.json5`, the release
  `buildOptionSet` entry: `externalNativeOptions.arguments =
  "-DDSH_RELEASE=1"` (a CMake cache variable, because `cppFlags` would miss
  the C host) turned into `target_compile_definitions` by the module's
  CMakeLists, plus `arkOptions.buildProfileFields.DSH_RELEASE` for ArkTS. The
  debug entry publishes `false` — an export that exists in only one mode
  makes the other mode fail to compile.
- **CLI** — `runtime/spike/host/build.sh --release` → `build/dsh-spike-cli-release`.

**How the flag reaches JS: a HOST-INJECTED global, not a staged prelude.**
The shared C host (`runtime/spike/host/dsh_spike_host.c`) sets
`globalThis.__DSH_RELEASE__ = true` in `dsh_bind_globals()` under
`#ifdef DSH_RELEASE`, before the bundle evaluates. All four hosts link that
one file. A staging-time prelude that rewrote the embedded `logger.js` was
the obvious alternative and was rejected: it would put a SECOND copy of the
logger into the release artifacts, and the repo has a byte-identity
invariant across hosts (iOS C arrays, Android assets, HarmonyOS rawfile —
`cmp` in `stage-spine-closure.sh` / `vendor-official.sh`, Harmony's
`check-bundle-files.mjs`). With host injection the embedded `logger.js` stays
byte-identical to the canonical checkout in BOTH configurations, and there is
no second source to drift.

**The strip.** `runtime/spike/logger.js` returns, when the global is true, a
logger whose `debug`/`info` are no-ops and whose `warn`/`error` still reach
the sink. The native hosts gate their own emitters on the same define:
`SpikeLogSink.consume` and `CarrierEventLog.emit/emitOnce` (iOS),
`CarrierEventLog.emit/emitOnce`, `GatewayCore.audit`/`uiMarker` and
`SpikeHostM4.carrierLog` (Android), `HostPhase`/`OfficialPhase` canonical
envelopes (HarmonyOS). Release keeps warn/error and nothing else.

**Release means user-facing, so the E2E drives do not run.** A plain launch
on a release build boots the runtime + loopback carrier and serves the
official DSH Web Client — the surface `-dsh-mode official-web` produces, with
the probe, the watchdog and every canonical record switched off
(`OfficialWebRuntime(evidence:)` on iOS, `OfficialWebSession.start(...,
evidence = false)` on Android). Asking a release build for a drive REFUSES
LOUD with the reason and a pointer at the harness (rule 5): a user-facing
binary has no drives to run, and silently producing nothing would be the
worst answer. On HarmonyOS the serving stack still lives inside the E2E
drives, so the release HAP refuses loudly and the user-facing serving path is
recorded as follow-up work rather than faked.

**The user-facing build must be self-contained.** `dsh-ios` embeds the
vendored official dist (89 files) and client bundles (129 files) as app
bundle resources via `hosts/ios/Tools/stage_official_web.py` (the
`StageOfficialWeb` build phase, Release only; Debug is a no-op so the harness
keeps reading exactly the `Documents/` tree its runners stage). Android
already packs them in `assets/`, HarmonyOS in `rawfile/`.

**Gate L4 now sees the real violation** (`tools/check-logging.py`): L4a the
canonical logger keeps its branch, L4b the OPERATIVE logger honors
`globalThis.__DSH_RELEASE__` with a no-op for both debug and info, L4c every
host's Release configuration actually DEFINES the flag. The 2026-09-21
cosmetic tree fails L4b+L4c;
`.gov/rejections/case-logging-l4.sh` proves it, and carries a positive
control (the same tree wired correctly must pass — a check that is always red
proves nothing either).

**`release.yml`** keeps one job per platform but produces both
configurations from it (shared vendoring, and the macOS runner is not paid
for twice): `dsh-ios` / `dsh-android` / `dsh-harmony` are now the RELEASE
builds, and `dsh-ios-harness` / `dsh-android-harness` / `dsh-harmony-harness`
(the debug E2E vehicles, full logs) are behind the `include_harness` boolean
input, default false — the `dev/*` pipelines already build the debug harness
on every push.

## Alternatives considered

- **A staging-time prelude prepended to the embedded `logger.js`** (the
  obvious reading of "staging-time flag"). Rejected: it creates a second
  copy of the logger for release artifacts, so the byte-identity invariant
  becomes "identical in debug, transformed in release" — two things to keep
  in step instead of one, and the transform itself becomes a silent failure
  point if a host forgets it. The host-injected global has exactly one
  injection point shared by all four hosts.
- **Doing the strip only in the canonical TS logger.** That is the state the
  audit found: the canonical file is bundled by nothing, so stripping it
  strips nothing the user runs. It is what L4a alone rewarded.
- **Making the gate check only that the operative logger has a branch.**
  Adds L4b but still passes a repository where no build config defines the
  flag — exactly the audit's core finding. L4c is the part that sees it.
- **`cppFlags` for the native defines on Android and HarmonyOS.** The
  documented-looking property, and the first attempt. It maps to
  `CMAKE_CXX_FLAGS` while the spike host is C, so the define reached nothing
  and the strip silently did not happen; the `.so` was verified to be missing
  the branch and the mechanism was switched to `cFlags` / CMake `arguments`.
- **Naming the release packages something new (`*-release`) and leaving
  `dsh-*` as the harness.** Rejected on the owner's call: the artifact a
  human downloads by default should be the one a user can use.
- **Extracting a lean serving runtime on HarmonyOS instead of refusing.**
  The serving stack is interleaved with evidence plumbing across a 1377-line
  drive; a half-extracted copy would risk the working harness to gain a
  release path nobody can verify on a device in this change. Refuse loudly,
  name the gap, ship the harness.

## Consequences

- Release and debug are now genuinely different builds on all three
  platforms, and the difference is checkable: the release `.so` carries the
  `__DSH_RELEASE__` branch, the debug `.so` does not; the release
  `BuildProfile.ets` publishes `DSH_RELEASE = true`, the debug one `false`.
- The `logging` gate can now fail for a reason that used to be invisible,
  and the DAG's `self-test` runs the new rejection case.
- Adding a fourth host means adding a row to `PLUMBING` in
  `tools/check-logging.py` — the gate is the contract, and a new platform
  without a define now fails loud instead of shipping unstripped.
- HarmonyOS release is honestly NOT yet a usable user build (no serving
  path); its artifact is documented as such rather than presented as
  equivalent to iOS/Android.
