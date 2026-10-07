# Building dsh-mobile

English | [简体中文](BUILD.zh.md)

One facade drives every platform: **`build/build.sh`**. A "build" here always
means **sync → compile → test** — the same three things the CI workflow for
that platform does, with the same commands — so a green local build and a green
`dev/<platform>` check mean the same thing.

```
build/build.sh [build|test|check|sync] [ios|android|harmony|core|all ...] [--release] [--list]
```

| Examples | What happens |
| --- | --- |
| `build/build.sh android` | stage the android closure from the canonical runtime → `gradlew assembleDebug` → `run-dsh-e2e.sh` (log-verified) |
| `build/build.sh android harmony` | the same, for both platforms — any mix of platforms |
| `build/build.sh test ios` | the e2e leg only (build must already be fresh) |
| `build/build.sh check` | the `closures` gate only — no toolchains needed |
| `build/build.sh sync harmony` | re-stage the committed harmony closure from `runtime/dsh` |
| `build/build.sh sync all` | re-stage every committed closure (ios → android → harmony → core, in order; an unknown platform aborts loud, never a silent skip) |

- The default command is `build`; the default platform set is `all` (the CI
  matrix — one machine rarely has every toolchain; iOS compiles only on macOS).
- A missing toolchain **fails loud**, naming the tool and how to get it — never
  a silent skip. `--list` shows the platforms and their toolchain needs.
- `core` is the canonical runtime's own vehicle: the C host CLI
  (`runtime/dsh/host/build.sh`) plus the CLI proof legs — the same closure
  the platforms embed, proven on the cheapest host.

## Why this shape (the DSH method)

The core is **one copy** — `contract/`, `runtime/`, `system-plugins/`,
`presentation/` are platform-independent; each host adds only its privileged
layer, primitive bindings, and native shell ([D9]/[D6], ARCHITECTURE.md §8).
The build system expresses exactly that:

1. **sync** re-stages each host's *committed copy* of the canonical closure
   (byte-identical; the vendored upstream is pinned and sha256-verified by
   `runtime/dsh/vendor/ensure-dsh.sh`);
2. **compile** runs the platform's own toolchain (Xcode / Gradle-NDK / hvigor
   NAPI — each host compiles the same C host through its own build system);
3. **test** runs the platform's log-verified e2e legs (assertions on
   structured logs, never screenshots — ARCHITECTURE.md §3).

## The closures gate

Android `assets/dsh/`, HarmonyOS `rawfile/dsh/`, and the iOS generated
bundle are **committed copies** of the canonical `runtime/dsh` closure —
deliberately (self-contained APK/HAP, platform IDEs see the files). Because CI
re-stages before every build, drift in the committed copies is invisible to a
green pipeline. The `closures` gate (`gov run`, wired in `gates.json`) closes
that hole: it byte-verifies every committed copy against the canonical source
(android and harmony stagers in `--check` mode; iOS by deterministic regen +
`git diff --quiet`). If it goes red: `build/build.sh sync <platform>`.

## The asset-mirror family (the web clients)

The self-hosted web clients are a second mirror family: the product trees
`presentation/web-client-{next,compact}` ship bytes through three host faces —
android `assets/dsh/webclient-*/`, harmony
`rawfile/dsh/webclient/dsh-web-client-*/`, and the iOS embedder's
`WEBCLIENT_TREES` declaration (its bundle regenerates from the product tree
at build time, so the declaration is the committed claim). A product edit
that skips the mirrors is the #286 class (timeline.js rode a vacuous
android `--check` loop for two PRs). Two surfaces own it now:

- the per-host byte-verify inside the `closures` gate (the stagers'
  `--check` loops — the android webclient loop's `./`-prefix SKIP hole is
  fixed, so this direction bites again);
- `node tools/check-asset-mirrors.mjs [--json]` — the cross-host comparator
  (warn-grade `asset-mirrors` gate): every family mirror compared in BOTH
  directions (stale, missing, extra) plus the iOS embedder declaration vs
  the family; its rejection case lives at
  `.gov/rejections/case-asset-mirrors.sh`.

## The CMake layer (the same graph, one more face)

A top-level `CMakeLists.txt` + `CMakePresets.json` express the build as a
dependency graph with a unified entry (cmake ≥ 3.21, Ninja):

```
cmake --preset macos-dev                                # configure (Ninja)
cmake --build --preset macos-dev --target dsh-core      # compile the C core
cmake --build --preset macos-dev --target dsh-android   # sync + build a host (wraps build.sh)
ctest --preset macos-dev                                # the gates (dsh-gate-closures, dsh-gate-gov)
```

Scope by construction (phase 1 — add-the-layer, move-no-paths):

- **CMake compiles only the C core**: the `dsh-core` static library, built
  from `runtime/dsh/host` plus the pinned engines — the same file set the
  android and harmony `cpp/CMakeLists.txt` compile. Configure materializes
  the vendored pins first (`include(Vendor)` runs the ensure scripts, fail
  loud; `DSH_SKIP_VENDOR=ON` skips with a named warning).
- **The three hosts stay owned by their platform toolchains.** `dsh-ios` /
  `dsh-android` / `dsh-harmony` are wrapper targets delegating to
  `build/build.sh build <platform>`, with `dsh-sync-<platform>` DAG edges —
  xcodebuild / Gradle / hvigor still own signing, HAP/AAB packaging, and the
  e2e legs. `build.sh` remains the documented facade; the targets are an
  entry, not a replacement.
- **The gates ride CTest** as `dsh-gate-closures` and `dsh-gate-gov` — a
  second face of the same checks; the gate DAG, task cards, and pre-push
  hooks stay owned by govrail.

Build trees live under `build/cmake-<preset>/` (the tracked `build/`
directory holds `build.sh` itself). Deeper integration — the sync/stage
steps as first-class custom commands, one vendor manifest driving every
host's embed lists — is the next phase, not this one.

## Layout: the periphery ring around the project

```
dsh-mobile/
├── build/        ┐
├── test/         │ the periphery ring — build, test, docs, packages:
├── docs/         │ project-adjacent surfaces, not the product
├── packages/     ┘
├── tools/          govrail checker scripts (governance tooling)
├── contract/     ┐
├── runtime/      │ the project — shared core, ONE copy (the DSH method),
├── system-plugins/│ plus the three platform hosts below
├── presentation/ ┘
└── hosts/{ios,android,harmony}
```

Path history: `tools/e2e → test/e2e` and `tools/release → packages/release`
(2026-09-23, [D17]). Historical notes and e2e receipts keep the paths they
were written with — they are records, not drift.

## The simulator matrix (release-grade evidence)

`tools/test/run-simulator-matrix.sh` is the one command that proves, per
platform, both halves of the flavor split on a real simulator/emulator:

| Leg | What it proves | Evidence |
| --- | --- | --- |
| release (iOS / Android) | the user-facing build boots to the official UI with ZERO drive machinery — no drive markers (`dsh: sequence` / `ui-wait` / verdict text), no debug/info logger records — and refuses an E2E drive BY NAME. The Release configuration cannot run the drives (they are compiled out of it by design), and that absence plus the loud refusal is exactly its evidence. The audit stream and warn/error records are the product's own planes (the serving boot brings up the full spine); they are RECORDED in `release-proof.json`, never asserted zero | `hosts/<plat>/artifacts/simulator-matrix/release/` |
| harness (iOS / Android) | the debug harness — the verification vehicle — runs the existing e2e runners unchanged: scenario-id logs 1:1 against the manifests, receipts machine-authored on the green path only | `…/simulator-matrix/{gateway-drive,device-plane,regression}/` |
| harmony | honestly skipped when no DevEco toolchain / hdc target exists on the machine — a skip receipt, never a fake pass (the leg stays script-ready for a real device) | `hosts/harmony/artifacts/simulator-matrix/matrix-skip-receipt.json` |

```
tools/test/run-simulator-matrix.sh                    # every platform
tools/test/run-simulator-matrix.sh --platform ios     # one platform
tools/test/run-simulator-matrix.sh --platform android --skip-release
```

Fail fast: the first failing leg stops the run and fails it
(`DSH_MATRIX_KEEP_GOING=1` runs every requested leg anyway — the summary
still exits non-zero). Every wait polls a condition with a deadline, never a
blind sleep; a failed leg's evidence dir moves to /tmp so the e2e-matrix
checker never inventories a verdict-bearing dir without its receipt. Legs
that need a driver the machine lacks (idb/WDA on iOS) skip with a trace in
`capability-skips.json`, alongside the standing hardware rows (camera /
Bluetooth / NFC: a simulator has no radio — future system-capability
scenarios negotiate `unavailable` through the capability plane, never assume
the hardware). The matrix is deliberately NOT wired into the gate DAG —
running it is a release ritual; gating it is a later decision.

## Node-surface line coverage

`tools/test/run-coverage.sh` measures real line coverage over the
Node-testable surface we own (vitest + v8 provider, per-surface
include/exclude with the boundaries named) and prints one aggregate table;
`--check` enforces the warn-tier floors the `coverage-floor` gate watches.
Full contract — measured baseline, the honest not-counted list, how to add
a surface: [docs/test-coverage.md](docs/test-coverage.md).

## CI mapping

The facade's per-platform steps are the verbatim commands of the matching
workflow — the mapping, and where each leg runs:

| Platform | compile (workflow) | test (workflow) |
| --- | --- | --- |
| ios | `xcodebuild … -scheme DSHHost` (`dev/ios`, macos-15) | `test/e2e/run-ios.sh` (same job) |
| android | `./gradlew assembleDebug` (`dev/android`) | `hosts/android/ci/run-dsh-e2e.sh` (same job) |
| harmony | `hvigorw assembleHap` (`dev/harmonyos`) | `hosts/harmony/ci/run-host-e2e.sh` (same job) |
| core | `runtime/dsh/host/build.sh` (macOS local; the CLI legs' own runners) | `runtime/dsh/ci/run-*-e2e.sh` |

[D9]: docs/decisions.md
[D6]: docs/decisions.md
[D17]: docs/decisions.md
