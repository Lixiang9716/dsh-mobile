# Agent Note: dev/harmonyos build pipeline (scaffold)

Status: implemented

## Problem

The HarmonyOS host arrives at M5 with no CI surface, and the official build path
(command-line building per the Huawei guide) had never been exercised in this repo. As with
dev/ios, deferring the pipeline to the day the code lands defers the gating decision too.

## Decision

A `dev/harmonyos` workflow on **ubuntu-latest** — HarmonyOS CLT 26.0.0+ ships a Linux build,
so the pipeline avoids macOS-priced runners entirely (unlike dev/ios, which needs macOS for
Xcode). The CLT arrives via the repository variable `HOS_CLT_LINUX_URL` (a signed Huawei CDN
link); the build follows the official sequence: `DEVECO_SDK_HOME=<clt>/sdk`, `ohpm install
--all`, `hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon`.
Locally verified on macOS with the mac-arm64 CLT 26.0.0.821: hvigorw 6.26.4 and ohpm
26.0.0.630 both run under Node v24.

## Alternatives considered

- **macOS runner (mirror dev/ios)**: rejected — CLT has a Linux build since 26.0.0, so paying
  the 10x macOS rate buys nothing for a pure hvigor build.
- **DevEco Studio in CI**: rejected — headless CLT covers the build; the IDE adds licensing
  and GUI complexity CI does not need.
- **Wait for M5 to create the pipeline**: rejected for the same reason as dev/ios — the first
  ArkTS commit should meet an already-wired build gate.

## Consequences

Before M5, the owner sets the `HOS_CLT_LINUX_URL` repository variable (signed links expire in
10 years per the CDN header, so rotation is rare). The signed-link distribution is fragile by
nature — if Huawei changes the link scheme, the variable needs a refresh; a future improvement
could mirror the CLT zip to a GitHub release. M5's definition of done includes the signing
configuration decision and hdc-driven emulator E2E (CLT Emulator supports Linux since 26.0.0).
