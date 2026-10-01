# Blocked legs — CoreSimulator XPC deadlock (2026-10-01)

Four legs of this battery were scripted, staged and ready but could not run:
at ~15:00 the simulator-side testmanagerd wedged after repeated WDA
re-attaches, and every `xcrun simctl` / `xcrun` call began hanging
indefinitely — including `simctl help` and `xcrun --find`, i.e. the XPC layer
itself, not a device state. Recovery attempts, all failed: `simctl shutdown`
+ `boot` (one cycle worked, then wedged again), killing the FULL process
stack (CoreSimulatorService, SimDevice launchd_sim, SimLaunchHost,
SimulatorTrampoline, idb_companion), `launchctl kickstart -k` (the service
label is not kickstart-able from the gui domain), lock inspection (none
found). Machine-level; the resume is an owner-side restart of CoreSimulator
(most directly: rebooting the Mac).

## What is ready (one command per leg after recovery)

The app is installed on `dsh-iphone` (A4AE41BF-026A-441E-85DF-F53522996073,
iOS 26.5) with the marketplace catalog config and web-plugins already staged
in its container; the Debug build (with every fix in this branch) is at
`hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app`.

1. **Marketplace real install** (D):
   `sh hosts/ios/artifacts/ios-live-test/run-marketplace-install.sh [--skip-install]`
   — boots the mock market server, stages the catalog config, drives the
   panel (browse → install → progress → installed) by label through WDA,
   audits the signing seed out of the capture, writes the receipt.
2. **BYOK onboarding flow** (B):
   `sh hosts/ios/artifacts/ios-live-test/run-onboarding-sim.sh`
   — fresh install, wrong-key 401 leg, success probe, save + first turn,
   relaunch; PNG at every step, key audited out.
3. **Real LLM turn** (B):
   `sh test/e2e/run-ios-live-llm.sh` (Debug streaming leg, credentials from
   repo `.env`), then the release path: build Release
   (`xcodebuild -configuration Release`), stage
   `profiles/default/llm/config.json` from `DSH_LLM_*` (the
   `tmp/ish-probe/scripts/51-run-ios-release.sh` mechanism, MODEL default
   `deepseek-flash`), drive one real turn through WDA.
4. **Control sweeps** (A):
   `python3 test/e2e/ios-ui.py sweep <dir>` on the serve boot — Debug, then
   the Release build; first-run 内测声明 dialog shot before dismissing.

WebDriverAgent bootstrap after a sim restart is the runner's own
`wda_bootstrap` (test/e2e/run-ios.sh) or one
`xcodebuild test-without-building -scheme WebDriverAgentRunner` against the
existing `~/dsh-e2e/wda-dd`.
