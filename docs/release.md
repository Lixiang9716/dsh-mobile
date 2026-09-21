# Release packages

Manual packaging for all three host apps, one dispatch each run. Trigger it
from the GitHub Actions tab (**release/packages → Run workflow**) or:

```sh
gh workflow run release.yml
```

Each job uploads its own downloadable artifact under the workflow run.

**Default dispatch produces the USER-FACING builds** — what you hand to a
user. A distribution build runs no verification machinery and emits only the
critical log set (`warn` + `error`); debug/info are stripped at the source
(AGENTS.md constraint 5, rules.md rule L4):

| Artifact | Configuration | Contents | Installs as-is? |
| --- | --- | --- | --- |
| `dsh-ios` | Release | `DSHSpike-release-device-unsigned.zip` + `DSHSpike-release-simulator.zip`; the official Web Client is EMBEDDED | No — sign first (below) |
| `dsh-android` | Release | `app-release-unsigned.apk` (official web app packed in assets) | No — sign first |
| `dsh-harmony` | Release | `entry-default-unsigned.hap` | No — sign via DevEco/hdc (below) |

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

1. Unzip `DSHSpike-device-unsigned.zip`.
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
the debug/E2E vehicle. **Honest gap:** the HarmonyOS host's serving stack
still lives inside its E2E drives, so a plain launch on the release HAP
refuses loudly instead of showing the official UI — the user-facing serving
path is follow-up work. Use `dsh-harmony-harness` to run the host today.

Signing:

1. Import `hosts/harmony` into DevEco Studio, add the HAP to a run
   configuration — DevEco auto-signs with a local debug certificate and
   installs to a connected device/emulator; or
2. `hdc install entry-default-unsigned.hap` after configuring debug signing
   in `build-profile.json5`.

## See also

- Bilingual counterpart: [release.zh.md](release.zh.md)
- Evidence conventions: [e2e-matrix.md](e2e-matrix.md)
