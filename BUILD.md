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
| `build/build.sh android` | stage the android closure from the canonical runtime → `gradlew assembleDebug` → `run-spike-e2e.sh` (log-verified) |
| `build/build.sh android harmony` | the same, for both platforms — any mix of platforms |
| `build/build.sh test ios` | the e2e leg only (build must already be fresh) |
| `build/build.sh check` | the `closures` gate only — no toolchains needed |
| `build/build.sh sync harmony` | re-stage the committed harmony closure from `runtime/spike` |

- The default command is `build`; the default platform set is `all` (the CI
  matrix — one machine rarely has every toolchain; iOS compiles only on macOS).
- A missing toolchain **fails loud**, naming the tool and how to get it — never
  a silent skip. `--list` shows the platforms and their toolchain needs.
- `core` is the canonical runtime's own vehicle: the C host CLI
  (`runtime/spike/host/build.sh`) plus the CLI proof legs — the same closure
  the platforms embed, proven on the cheapest host.

## Why this shape (the DSH method)

The core is **one copy** — `contract/`, `runtime/`, `system-plugins/`,
`presentation/` are platform-independent; each host adds only its privileged
layer, primitive bindings, and native shell ([D9]/[D6], ARCHITECTURE.md §8).
The build system expresses exactly that:

1. **sync** re-stages each host's *committed copy* of the canonical closure
   (byte-identical; the vendored upstream is pinned and sha256-verified by
   `runtime/spike/vendor/ensure-dsh.sh`);
2. **compile** runs the platform's own toolchain (Xcode / Gradle-NDK / hvigor
   NAPI — each host compiles the same C host through its own build system);
3. **test** runs the platform's log-verified e2e legs (assertions on
   structured logs, never screenshots — ARCHITECTURE.md §3).

## The closures gate

Android `assets/spike/`, HarmonyOS `rawfile/spike/`, and the iOS generated
bundle are **committed copies** of the canonical `runtime/spike` closure —
deliberately (self-contained APK/HAP, platform IDEs see the files). Because CI
re-stages before every build, drift in the committed copies is invisible to a
green pipeline. The `closures` gate (`gov run`, wired in `gates.json`) closes
that hole: it byte-verifies every committed copy against the canonical source
(android and harmony stagers in `--check` mode; iOS by deterministic regen +
`git diff --quiet`). If it goes red: `build/build.sh sync <platform>`.

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

## CI mapping

The facade's per-platform steps are the verbatim commands of the matching
workflow — the mapping, and where each leg runs:

| Platform | compile (workflow) | test (workflow) |
| --- | --- | --- |
| ios | `xcodebuild … -scheme DSHSpike` (`dev/ios`, macos-15) | `test/e2e/run-ios.sh` (same job) |
| android | `./gradlew assembleDebug` (`dev/android`) | `hosts/android/ci/run-spike-e2e.sh` (same job) |
| harmony | `hvigorw assembleHap` (`dev/harmonyos`) | `hosts/harmony/ci/run-host-e2e.sh` (same job) |
| core | `runtime/spike/host/build.sh` (macOS local; the CLI legs' own runners) | `runtime/spike/ci/run-*-e2e.sh` |

[D9]: docs/decisions.md
[D6]: docs/decisions.md
[D17]: docs/decisions.md
