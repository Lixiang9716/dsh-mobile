# Release packages

Two triggers, one build path:

- **A release** — the normal path. `release/please` reads the conventional
  commits landing on `main` and keeps ONE open release PR that bumps
  `version.txt`, writes `CHANGELOG.md` and syncs the three host version
  manifests. Merging that PR tags `vX.Y.Z` and publishes a GitHub Release; the
  `release/packages` workflow then builds the three host apps and **attaches
  them to that release**, so a tag is a downloadable build set.
- **A manual run** — Actions tab (**release/packages → Run workflow**) or
  `gh workflow run release.yml`. The packages land on the workflow run instead
  of on a release; `include_harness: true` adds the verification vehicles.

## Cutting a release

1. Land work on `main` with conventional commit messages (enforced by the
   `commit-format` gate). `feat:` bumps the minor, `fix:` the patch; below
   1.0 a breaking change bumps the minor rather than jumping to 1.0.0.
2. `release/please` keeps a PR titled `chore(main): release X.Y.Z` up to date.
   It is generated and mechanical — `version.txt`, `CHANGELOG.md` and the
   three host manifests. **Review the changelog**; that is the part a human
   owns, the version bumps follow from the commits.
3. Merge it. release-please tags `vX.Y.Z` and publishes the Release, and
   `release/packages` builds all three hosts and attaches them (30–60 min per
   host, all on the release event).
4. **Recovery — a release shipped a bad package.** Do not delete the release.
   Dispatch `release/packages` with **`release_tag: vX.Y.Z`**: the packages
   build from the current `main` and replace that tag's assets in place
   (`gh release upload --clobber`). Use it when you have merged a fix that
   changes what a platform must build — for example the HarmonyOS HAP that was
   shipping debuggable until the product-level `debuggable` override was moved
   into the module's per-mode `buildOptionSet`.

### The version stream

One version for the whole repository: the three hosts ship together in a
single build, so they share one number. `version.txt` plus
`.release-please-manifest.json` are the source of truth, and the host
manifests are kept in step by the `extra-files` wiring in
`release-please-config.json`:

| Host | File | Field | Updater |
| --- | --- | --- | --- |
| iOS | `hosts/ios/App/Info.plist` | `CFBundleShortVersionString` | `xml` + xpath — no in-file annotation needed |
| Android | `hosts/android/app/build.gradle.kts` | `versionName` | `generic` + `// x-release-please-version` |
| HarmonyOS | `hosts/harmony/AppScope/app.json5` | `versionName` | `json` + jsonpath — the `.json5` extension is not auto-detected, so the type is explicit |

Build numbers are **not** versioned here: `CFBundleVersion`, the Android
`versionCode` and the HarmonyOS `versionCode` are monotonic integers that
semver cannot express, so they stay hand-set.

### Setup (once): the release token

`release/please` requires a secret named `RELEASE_PLEASE_TOKEN` — a
fine-grained PAT (or a GitHub App installation token) with
**contents: write** and **pull requests: write** on this repository.
`secrets.GITHUB_TOKEN` is not a substitute: events it creates do not trigger
workflows, so the release PR would never receive the required `gates` check
and could never be merged. The workflow fails loud when the secret is absent
rather than degrading into that broken path.

Each job also uploads its own downloadable artifact under the workflow run.

**Default dispatch produces the USER-FACING builds** — what you hand to a
user. A distribution build runs no verification machinery and emits only the
critical log set (`warn` + `error`); debug/info are stripped at the source
(AGENTS.md constraint 5, rules.md rule L4):

| Artifact | Configuration | Release assets | Installs as-is? |
| --- | --- | --- | --- |
| `dsh-ios` | Release | `dsh-ios.ipa` + `dsh-ios-simulator.zip`; the official Web Client is EMBEDDED | No — sign first (below) |
| `dsh-android` | Release | `dsh-android.apk` (official web app packed in assets) | No — sign first |
| `dsh-harmony` | Release | `dsh-harmony.hap` | No — sign via DevEco/hdc (below) |

Release assets are named `dsh-<host>.<ext>` and never after the build system's
internal output path (`entry-default-unsigned.hap`, `app-release-unsigned.apk`).
The workflow renames each build output before uploading: `gh release upload`'s
`file#text` form sets only the display *label*, which a download ignores, so the
filename itself is what has to change.

Two of those names need to stay honest about what they contain:

- **`dsh-ios.ipa`** is a real (unsigned) `.ipa` — a zip whose root holds
  `Payload/DSHSpike.app`, the layout AltStore, Sideloadly and
  `xcrun devicectl` expect. It is not a renamed `Release-iphoneos/…` archive.
- **All three are unsigned.** CI holds no Apple certificates and no HarmonyOS
  signing material, so every package needs local signing before it will
  install. `dsh-ios-simulator.zip` is the exception: it runs as-is on a
  simulator, which is the only way to try the app without a signing setup.

**`include_harness: true` additionally uploads the HARNESS packages** — the
E2E verification vehicles: debug configuration, full structured logging, the
verification drives run. They exist for hand-testing on physical devices; the
`dev/*` pipelines already build and run the debug harness on every push, so
the opt-in default is off:

| Artifact | Configuration | Contents |
| --- | --- | --- |
| `dsh-ios-harness` | Debug | `DSHSpike-harness-*-unsigned.zip` (device + simulator) |
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
