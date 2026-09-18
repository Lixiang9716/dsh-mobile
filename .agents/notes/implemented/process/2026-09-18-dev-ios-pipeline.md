# Agent Note: dev/ios end-to-end pipeline (scaffold)

Status: implemented

## Problem

The iOS host arrives at M1, but there was no CI surface to run its end-to-end tests against —
the first Xcode project would land ungated. Waiting for the project before creating the
pipeline would defer the gating decision to the same day as the code.

## Decision

A `dev/ios` workflow (`.github/workflows/dev-ios.yml`): manual dispatch plus path-filtered
push/PR triggers (`hosts/ios/**`, the workflow itself) on `macos-15`, running toolchain sanity
and project detection now, with the build/test/E2E steps documented in place. It stays out of
the default PR matrix (the `gates` check owns that) so macOS minutes are only spent when iOS
paths change or a developer dispatches it.

## Alternatives considered

- **Run on every push now**: rejected — macOS minutes bill at 10x and hosts/ios is empty until
  M1; the path filter plus workflow_dispatch covers both automation and intent.
- **Device-farm E2E (Appium on real hardware)**: deferred — simulator XCUITest covers the M1/M2
  surface (session start, approval UI, streaming visibility, checkpoint/resume) with no device
  inventory; real-device E2E is a post-M3 decision tied to release gating.
- **Fold into the gov workflow**: rejected — `gates` is the required merge check and must stay
  fast and Linux-cheap; iOS E2E has different runners, triggers, and cost profile.

## Consequences

M1's definition of done includes replacing the project-detection step with
`xcodebuild build-for-testing` + XCUITest, and wiring the required-check decision (whether
`dev/ios` becomes required for hosts/ios paths) at that point.
