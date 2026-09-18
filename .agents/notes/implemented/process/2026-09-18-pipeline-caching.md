# Agent Note: unified pipeline caching across the three platform E2E lines

Status: implemented

## Problem

Each `dev/*` pipeline paid a cold-start tax on every run: dev/harmonyos re-downloaded a 2GB CLT
zip and re-unpacked it; dev/android (from M4) would re-download a ~1.5GB system image and all
Gradle dependencies; dev/ios (from M1) would rebuild every Swift module from zero.

## Decision

One caching pattern, applied three times (dev/harmonyos already shipped it for the CLT):
cache the **unpacked, ready-to-use state**, keyed by tool/version, with a verify step that
fails loud if a restored tree is broken:

- dev/harmonyos: unpacked CLT tree (`hos-clt-linux-unpacked-26.0.0.821`) — verified live:
  second run logged "Cache hit" + "Cache restored successfully"
- dev/android: Gradle caches via setup-java (activates with the M4 project) + emulator
  system-image/AVD (`dev-android-emulator-api35-x86_64-v1`)
- dev/ios: DerivedData (`dev-ios-deriveddata-ios265-v1`) — requires M1 builds to use
  `-derivedDataPath hosts/ios/DerivedData` or the cache stays cold by design

## Alternatives considered

- **Caching the zips instead of unpacked trees**: rejected for the CLT (every run still pays
  the unzip), retained implicitly where the platform toolchain does it better (Gradle caches
  dependencies, not distributions).
- **Self-hosted runners with persistent disks**: rejected — hosted runners + actions/cache keep
  the security surface and maintenance off this repo.

## Consequences

Cache keys carry a version suffix (`v1`, `...821`); bumping a key is the documented way to
invalidate stale state. A corrupt restored tree must fail loud (each consumer verifies its
tool, e.g. hvigorw --version) — trusting a cache without checking is the failure mode the
"fail loud" rule exists to prevent.
