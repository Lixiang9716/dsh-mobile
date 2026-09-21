# Release packages

The release pipeline is PREPARE, then PACKAGE one host at a time, and each
workflow's name says which. The package stages are `release/ios`,
`release/android` and `release/harmony` — mirroring `dev/ios`, `dev/android`
and `dev/harmonyos`, so a run in the Actions list tells you its host without
opening it.

| Stage | What it is | Trigger |
| --- | --- | --- |
| Prepare | an ordinary pull request running `tools/release/bump-version.py` | whenever you decide to release |
| Package | `release/ios` | **a `v*` tag push**, or a manual dispatch |
| Package | `release/android` | the same |
| Package | `release/harmony` | the same |

**The tag push is the release trigger** — `git push origin vX.Y.Z`. Not the
`release: published` event, and not a bot finishing: a release that depends on
something else completing has exactly the failure mode this pipeline spent days
in, where a credential, a repository setting or a suppressed event stops the
release at a step that reports nothing. Cutting a release needs nothing but
`contents: write`, and a failed attempt is retried by pushing again.

Two ways in, one build path:

- **A release** — the normal path: bump, merge, tag.
  `tools/release/bump-version.py X.Y.Z` writes all four version files and the
  `CHANGELOG.md` section in one command; you open an **ordinary** pull request
  with it — which is the point, because a PR from a person or an agent gets the
  required `gates` check the way any other PR does (D13/D14). Merge it, then
  push the tag: that fires the three `release/<host>` workflows, which build
  each host and **attach the package to that tag's Release**, creating the
  Release first if the tag has none. A tag is a downloadable build set.
- **A manual run** — Actions tab (**release/ios**, **release/android** or
  **release/harmony** → Run workflow) or `gh workflow run release-ios.yml`. The
  packages land on the workflow run instead of on a release;
  `include_harness: true` adds the verification vehicle for that host.

## Cutting a release

1. Land work on `main` with conventional commit messages (enforced by the
   `commit-format` gate). A `feat:` or a breaking change bumps the minor while
   below 1.0; a `fix:` the patch.
2. **Bump, and write the changelog:**

       tools/release/bump-version.py X.Y.Z            # or --dry-run first

   It prints the version the commits since the last tag imply as a hint — a
   person makes the call — writes `version.txt`, the iOS `Info.plist`, the
   Android `versionName` and the HarmonyOS `versionName`, and prepends the
   release's `CHANGELOG.md` section from those commits. **Read the changelog**;
   that is the part a human owns.
3. **Open an ordinary pull request with it and merge it.** A PR authored by a
   person or an agent receives the required `gates` check normally; that is why
   the bump is a normal PR at all (D13/D14). Nothing is tagged yet.
4. **Push the tag on that merge commit:**

       git pull --ff-only && git tag vX.Y.Z && git push origin vX.Y.Z

   That fires the three `release/<host>` workflows, which build their host and
   attach the package to the tag's Release. They run concurrently; measured on
   the v0.0.1 release event they took 15 min (iOS), 11 min (Android) and 2 min
   (HarmonyOS), and every full run since finished in 9–15 min — the per-job
   timeout is 60 min.

   Each one first runs `tools/release/check-tag-version.sh`, which refuses a
   tag that disagrees with any of the four version files. Pushing `v0.0.3`
   while `version.txt` says `0.0.2` fails before anything builds, naming every
   mismatch — the drift that a human-triggered release would otherwise
   reintroduce, since nothing downstream would notice a package installed
   under the wrong number.
5. **Recovery — a release shipped a bad package.** Do not delete the release.
   Dispatch that host's workflow (e.g. `release/harmony`) with **`release_tag:
   vX.Y.Z`**: the package builds from the current `main` and replaces that
   tag's asset in place (`gh release upload --clobber`). Use it when you have
   merged a fix that changes what a platform must build — for example the
   HarmonyOS HAP that was shipping debuggable until the product-level
   `debuggable` override was moved into the module's per-mode
   `buildOptionSet`. One host at a time is the point: a bad HAP does not
   require rebuilding iOS.
6. **Recovery — the tag is wrong.** Delete it and re-push:
   `git push --delete origin vX.Y.Z`, fix the version files (a
   new bump PR), then tag again. If a Release was already created, delete that
   too — the package workflows create it, so they will re-create it on the
   next push.

### The version stream

One version for the whole repository: the three hosts ship together in a single
build, so they share one number. `version.txt` is the source of truth, and
**`tools/release/bump-version.py` writes all four files in one command**, so
they cannot drift:

    tools/release/bump-version.py 0.1.0            # bump every version file
    tools/release/bump-version.py 0.1.0 --dry-run  # show what would change

| Host | File | Field |
| --- | --- | --- |
| — | `version.txt` | the source of truth |
| iOS | `hosts/ios/App/Info.plist` | `CFBundleShortVersionString` |
| Android | `hosts/android/app/build.gradle.kts` | `versionName` |
| HarmonyOS | `hosts/harmony/AppScope/app.json5` | `versionName` |

The script derives the version the conventional commits imply (a `feat` or a
breaking change bumps the minor pre-1.0, a `fix` the patch) and prints it as a
hint; a person makes the call. It also writes the `CHANGELOG.md` section for
the release from those commits, and re-reads every file it writes — a
partially-applied bump is refused before anything is written, not after.
`tools/release/check-tag-version.sh` then refuses a tag that disagrees with any
of the four, so the two ends cannot come apart silently.

Build numbers are **not** versioned here: `CFBundleVersion`, the Android
`versionCode` and the HarmonyOS `versionCode` are monotonic integers that
semver cannot express, so they stay hand-set.

### Setup: none

There is no token to configure, no repository setting to remember and no bot to
configure, because **no step of the release depends on one**. The version bump
is a normal pull request authored by a person or an agent, so it gets the
ordinary `gates` check like any other change; the release is the tag push, and
the package workflows need only `contents: write`.

That is deliberate, and it is what the pipeline's history converged on: a
release PR opened by `GITHUB_TOKEN` cannot receive the required check — its
`pull_request` workflows arrive as `action_required`, and a check produced by a
`workflow_dispatch` run does not satisfy branch protection either (measured on
PR #111: green `gates` on the exact head SHA, correct app and context, suite
linked to the PR, still `BLOCKED` with an empty rollup). Branch protection
honours only checks from the pull request's own event flow. Authoring the bump
as a normal PR sidesteps all of it. See D13/D14.

`RELEASE_PLEASE_TOKEN`, if still set as a secret, is read by nothing.
`release-please` itself is retired (D14); `git log` has its configuration if it
is ever wanted back.

Each job also uploads its own downloadable artifact under the workflow run.

**Default dispatch produces the USER-FACING builds** — what you hand to a
user. A distribution build runs no verification machinery and emits only the
critical log set (`warn` + `error`); debug/info are stripped at the source
(AGENTS.md constraint 5, rules.md rule L4):

| Artifact | Configuration | Release assets | Installs as-is? |
| --- | --- | --- | --- |
| `dsh-ios` | Release | `dsh-ios.ipa`; the official Web Client is EMBEDDED | No — sign first (below) |
| `dsh-android` | Release | `dsh-android.apk` (official web app packed in assets) | No — sign first |
| `dsh-harmony` | Release | `dsh-harmony.hap` | No — sign via DevEco/hdc (below) |

Release assets are named `dsh-<host>.<ext>` and never after the build system's
internal output path (`entry-default-unsigned.hap`, `app-release-unsigned.apk`).
The workflow renames each build output before uploading: `gh release upload`'s
`file#text` form sets only the display *label*, which a download ignores, so the
filename itself is what has to change.

A release offers **one package per host** — three assets, matching the three
platforms. Anything a release page should not carry ships on the run instead:
the iOS **simulator** build (`dsh-ios-simulator.zip`) is a development
convenience, so it is an artifact of the `dsh-ios` job rather than a release
asset. Same for the `-harness` packages.

**`dsh-ios.ipa`** is a real (unsigned) `.ipa` — a zip whose root holds
`Payload/DSHSpike.app`, the layout AltStore, Sideloadly and
`xcrun devicectl` expect. It is not a renamed `Release-iphoneos/…` archive.

**All three are unsigned.** CI holds no Apple certificates and no HarmonyOS
signing material, so every package needs local signing before it will install.
For a no-signing way to run the app, take the simulator build off the run's
`dsh-ios` artifact.

**`include_harness: true` additionally uploads the HARNESS packages** — the
E2E verification vehicles: debug configuration, full structured logging, the
verification drives run. They exist for hand-testing on physical devices; the
`dev/*` pipelines already build and run the debug harness on every push, so
the opt-in default is off:

| Artifact | Configuration | Contents |
| --- | --- | --- |
| `dsh-ios-harness` | Debug | `DSHSpike-harness-device-unsigned.zip` + `DSHSpike-harness-simulator.zip` |
| `dsh-android-harness` | Debug | `app-debug.apk` (debug-keystore signed — installs directly) |
| `dsh-harmony-harness` | Debug | `entry-default-debug-unsigned.hap` |

Which one do you want? **Release when you want to use the app**; harness when
you want to verify it (run the E2E legs, read the `dsh.spike.log:` stream).

The three builds mirror the proven `dev/ios` / `dev/android` /
`dev/harmonyos` recipes (same vendors, same pinned toolchains). Release-mode
signing (distribution certs, App Store / AppGallery) is out of scope: these
packages still need local signing to install.

## iOS — signing and installing on a phone

The device `.app` is built unsigned on purpose (CI holds no Apple
certificates). To put it on your iPhone:

1. Take `dsh-ios.ipa` — an unsigned `.ipa` (`Payload/DSHSpike.app`). Nothing
   needs unzipping first: the signing tools take the `.ipa` itself.
2. Sign with a free Apple ID (7-day validity) or a paid team:
   - **Xcode**: open `hosts/ios/DSHSpike.xcodeproj`, set your team on the
     target's Signing & Capabilities, connect the phone, and build to the
     device — or drop the unzipped `.app` onto the device in
     **Window → Devices and Simulators**.
   - **Sideloadly / AltStore**: point either at the unzipped `.app` with
     your Apple ID.
3. On the phone: Settings → General → VPN & Device Management → trust your
   developer profile, then launch **DSHSpike**.

**`dsh-ios` (release): a plain launch reaches the official DSH Web UI.** The
official dist (89 files) and the client bundles (129 files) are EMBEDDED in
the app as resources (`Tools/stage_official_web.py`, run by the
`StageOfficialWeb` build phase in the Release configuration only), so nothing
is staged from outside. Evidence: `hosts/ios/artifacts/release-logging/`
(plain launch, empty container, no arguments → the official UI, zero
`dsh.spike.log:` records, zero verdict text, zero debug/info records).

**`dsh-ios-harness` (debug): the verification vehicle.** It embeds nothing
and reads the `Documents/` trees its runners stage — exactly as before. It
also carries the full E2E stream. Passing it an E2E launch mode works; the
release build REFUSES one loudly instead (rule 5), because a user-facing
binary has no drives.

### Seeing the official Web UI from the HARNESS (verified 2026-09-21)

Only needed for `dsh-ios-harness`: it embeds nothing, so the carrier needs
the vendored official dist in the app container before the official-web
drive (`b1.official-web.mount`) can serve it.

```sh
# 1. materialize the three untracked trees locally (manifest-verified)
tools/e2e/ensure-official-dist.sh
tools/e2e/ensure-client-bundles.sh
runtime/spike/vendor/ensure-dsh.sh

# 2. stage them into the app container
#    simulator:
APP_DATA=$(xcrun simctl get_app_container "$UDID" org.dsh.DSHSpike data)
#    device (iOS 17+; UDID or name from `xcrun devicectl list devices`):
#      xcrun devicectl device copy to --device "$DEVICE" \
#        --domain-type appDataContainer --domain-identifier org.dsh.DSHSpike \
#        --source <tree> --destination Documents/...
#    both: dist → Documents/official-web/dist
#          client bundles → Documents/web-plugins/npm/@deepseek-ai/
#          the vendored bootstrap package overrides its built twin
#          (see tools/e2e/run-ios-b1.sh steps 4/4b for the exact tree ops)

# 3. launch in official-web mode
#    simulator:
xcrun simctl launch org.dsh.DSHSpike -dsh-mode official-web
#    device:
#      xcrun devicectl device process launch --device "$DEVICE" \
#        org.dsh.DSHSpike -dsh-mode official-web
```

A real chat turn additionally needs credentials in
`Documents/profiles/default/m2-llm/config.json` (`{baseUrl, apiKey, model}`)
and the `-dsh-scenario m2-llm` launch argument; the key stays in the app
container, never in the repository.

## Android

`app-release-unsigned.apk` (release) carries the official web app in its
assets and needs signing before install; `app-debug.apk` (harness) is signed
with the debug keystore — copy it to the phone, enable "install unknown
apps", tap to install, or `adb install app-debug.apk`. On release, a plain
launch reaches the official DSH Web UI; the harness drives run the E2E legs
via the `hosts/android/ci/` runner scripts (see
hosts/android/artifacts/m2-llm/ for the evidence flow).

## HarmonyOS

The HAP is unsigned (signing material is device-specific). `dsh-harmony`
is the release configuration (the `DSH_RELEASE` define reaches both ArkTS and
the native spike library, so debug/info fold away); `dsh-harmony-harness` is
the debug/E2E vehicle.

**`dsh-harmony` (release): a plain launch reaches the official DSH Web UI.**
The serving stack is ONE seat —
`hosts/harmony/entry/src/main/ets/model/OfficialServe.ets`: the loopback
carrier serving the vendored dist and the client bundles straight from
rawfile, the web-boot runtime composing the official boot wire, ArkWeb
mounting the origin — and it runs in BOTH configurations. The E2E drives
(`model/OfficialPhase.ets`: the per-event records, the same-origin probes,
the httpFetch / session-live / write legs, the verdicts) attach to that seat
only through hooks, so a release launch has no drive and no probe and emits
no record at all; asking a release build for an E2E leg
(`--ps dsh.e2e.leg <leg>`) refuses LOUD by name (rule 5). The gaps that
remain are the mount leg's own honest ones, the same on every host: `/api`
and the mux answer unclaimed endpoints structurally — the session surface is
served only on the harness's spine legs — and a real chat turn needs
credentials the user supplies, since the mobile hosts ship no model endpoint.
Evidence: `hosts/harmony/artifacts/release-logging/` (plain launch, no launch
parameter, nothing staged → the official UI, zero `dsh.spike.log:` records,
zero verdict text, zero debug/info records; the refusal; the harness suite
re-run green).

Signing:

1. Import `hosts/harmony` into DevEco Studio, add the HAP to a run
   configuration — DevEco auto-signs with a local debug certificate and
   installs to a connected device/emulator; or
2. `hdc install entry-default-unsigned.hap` after configuring debug signing
   in `build-profile.json5`.

## See also

- Bilingual counterpart: [release.zh.md](release.zh.md)
- Evidence conventions: [e2e-matrix.md](e2e-matrix.md)
