# Agent Note: The top-level CMake layer — phase 1 (add-the-layer, move-no-paths)

Status: implemented
Related: T-0069; the 2026-09-27 vendor-closure drift audit; D6 (upstream discipline)

Date: 2026-09-27 · Class: architecture · Task: T-0069

## Problem

The build graph had no single machine-readable face: `build/build.sh` is the
documented facade, three platform IDE builds own their compiles, and govrail
owns verification — but nothing expresses "what depends on what" as edges, so
propagation between the layers is manual and drift is caught post-hoc (the
2026-09-27 vendor-closure audit: one pin table consumed by six hand-edited
per-host embed lists). The owner directed a cross-platform build system —
CMake + Ninja — as top-level project management, with the constraint that the
repo must not lose its shape (path renames touch nine workflows, gates.json,
every skill, and the notes corpus).

## Decision

Phase 1 ships the layer WITHOUT moving any path:

- Root `CMakeLists.txt` (`project(dsh-mobile)`, C11) + `CMakePresets.json`
  (hidden `dev-base` → `macos-dev`; schema v3; generator name is
  case-sensitive — `"Ninja"`, not `"ninja"`).
- `cmake/Vendor.cmake`: configure-time materialization — `ensure.sh`
  (engines) + `ensure-dsh.sh` (the pinned JS closure) run BEFORE the core's
  sources resolve; fail loud with the captured stderr tail;
  `DSH_SKIP_VENDOR=ON` is the escape hatch.
- `runtime/spike/host/CMakeLists.txt`: `dsh-core` static lib — the ONLY code
  CMake compiles. 43 TUs mirrored from the proven android/harmony lists
  (spike host, wasm.c, the quickjs fork's four TUs, all 11 wasm3, the 25-TU
  zstd subset). `dsh_ish.c` compiles in guarded: it needs the vendored ish
  tree (`vendor/ish/…`) and, at link time, `-lishcore -lsqlite3 -lz
  -lresolv`; absent tree → loud configure-time STATUS, not a silent drop.
  `ZSTD_DISABLE_ASM=1` and the harmony accommodations carry over; Android's
  bionic-only `-include android_compat.h` and hvigor's
  `-Wno-unused-command-line-argument` deliberately do not.
- `cmake/Apps.cmake`: `dsh-ios/dsh-android/dsh-harmony` wrapper targets
  delegating to `build/build.sh build <platform>` with `dsh-sync-<platform>`
  DAG edges. The hosts stay owned by xcodebuild/Gradle/hvigor — the targets
  are a unified entry, not a replacement. `test`/`check` verbs deliberately
  not wrapped (gates ride CTest; the comment names the seam).
- `cmake/Gates.cmake`: exactly two CTest tests — `dsh-gate-closures` (the
  closures gate script) and `dsh-gate-gov` (`gov run`, registered only when
  gov resolves). govrail keeps the DAG, task cards, and pre-push hooks; ctest
  is a second face, not a successor.
- Build trees live under `build/cmake-<preset>/` — the tracked `build/` dir
  holds `build.sh` itself (`/build/cmake-*/` is gitignored).

Known accepted duplication: `build.sh build <platform>` syncs internally, so
via CMake a platform target syncs twice (explicit DAG edge + inside the
script). Idempotent restaging; documented in the Apps.cmake header.

## Alternatives considered

- **CMake as the full top-level project manager** (canonical `src/`,
  `external/`, `test/`, `example/` layout, CMake owning app builds):
  rejected for phase 1 — the three app builds are physically owned by
  xcodebuild/Gradle/hvigor (signing, HAP/AAB, entitlements), so a full CMake
  takeover is impossible at the app layer and a path rename churns every
  workflow, gate, skill, and note at once. The canonical layout remains the
  vocabulary: the root CMakeLists documents the alias mapping (src/ →
  runtime/spike/host, external/ → runtime/spike/vendor).
- **Ninja/Make/just standalone**: rejected — executors without a generator;
  they would add a hand-written dependency file beside build.sh, the exact
  hand-edited-list disease the vendor audit documented.
- **Bazel/Meson**: rejected — no existing footprint in the repo, higher
  adoption cost, and the native layer already speaks CMake (android/harmony
  `cpp/CMakeLists.txt`), so the core converges along the existing grain.
- **The vendor manifest + generators + bidirectional embed-parity gate**
  (the audit's actual fix for the six hand-edited lists): NOT rejected — it
  is the agreed phase 2+. This layer is the execution vehicle that DAG will
  ride; the manifest decision is orthogonal to and unblocked by this change.

## Consequences

- `cmake --preset macos-dev` now requires the vendored pins to be
  materializable at configure time (cold checkout without network fails
  loud — the same terms as every build today, just earlier).
- The ctest bounds (closures 1800 s, gov 3600 s) are locally chosen generous
  caps: gates.json carries no `timeoutMs` for closures and no mode-level
  default to mirror (govrail field feedback).
- `dsh-core` on macOS is a NEW compile surface: it compiles clean today, but
  only the android/harmony/iOS surfaces are CI-proven; a core-only CI leg is
  a phase-2 candidate.
