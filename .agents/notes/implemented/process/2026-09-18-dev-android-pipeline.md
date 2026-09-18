# Agent Note: dev/android end-to-end pipeline (scaffold)

Status: implemented

## Problem

The three-platform CI matrix had iOS and HarmonyOS pipelines but no Android one — the platform
with the *most* CI-friendly story (ubuntu runners ship the SDK and KVM-accelerated emulators)
was the only one missing its surface.

## Decision

A `dev/android` workflow mirroring dev/ios and dev/harmonyos: manual dispatch plus
path-filtered triggers (`hosts/android/**`), ubuntu runner (SDK preinstalled, KVM available),
Gradle project detection gating the build steps until M4, and the same log-based E2E
assertion contract (scenario-id, one-to-one expected ↔ logged, no screenshots) recorded in
ARCHITECTURE.md §3.

## Alternatives considered

- **Fold into `gates`**: rejected — `gates` stays fast and Linux-cheap with the 11 governance/
  code doors; platform E2E has different runners, triggers, and cost.
- **Skip until M4**: rejected — same rationale as dev/ios and dev/harmonyos: the first Android
  commit should meet an already-wired pipeline, not negotiate one.

## Consequences

M4's definition of done includes the Gradle wrapper (no global gradle dependency), the
emulator-matrix choice (API level mirroring the local `pixel` AVD), and replacing the
project-detection step with `./gradlew assembleDebug` + log-assertion E2E.
