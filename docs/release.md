# Release packages

Manual packaging for all three host apps, one dispatch each run. Trigger it
from the GitHub Actions tab (**release/packages → Run workflow**) or:

```sh
gh workflow run release.yml
```

Each job uploads its own downloadable artifact under the workflow run:

| Artifact | Contents | Installs as-is? |
| --- | --- | --- |
| `dsh-ios` | `DSHSpike-device-unsigned.zip` (device .app, unsigned) + `DSHSpike-simulator.zip` | No — sign first (below) |
| `dsh-android` | `app-debug.apk` (debug-keystore signed) | Yes — "install unknown apps", or `adb install` |
| `dsh-harmony` | `entry-default-unsigned.hap` | No — sign via DevEco/hdc (below) |

The three builds mirror the proven `dev/ios` / `dev/android` /
`dev/harmonyos` recipes (same vendors, same pinned toolchains). Release-mode
signing (distribution certs, App Store / AppGallery) is out of scope: these
packages exist for on-device verification.

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

Honest limitation: the packaged app is the verification harness. A plain
launch boots the runtime, the loopback carrier, and the mounted official Web
Client; the real-LLM streaming drive (`m2.llm`) is launched with
`-dsh-scenario m2-llm` and credentials staged into the `app` fs scope by the
E2E runner (tools/e2e/run-ios-m2-llm.sh) — interactive real-LLM chat from a
sideloaded phone is not wired yet.

## Android

`app-debug.apk` is signed with the debug keystore: copy it to the phone,
enable "install unknown apps", tap to install — or `adb install app-debug.apk`.
The real-LLM drive runs via `bash hosts/android/ci/...` runner scripts on a
connected device (see hosts/android/artifacts/m2-llm/ for the evidence flow).

## HarmonyOS

The HAP is debug-mode but unsigned (signing material is device-specific):

1. Import `hosts/harmony` into DevEco Studio, add the HAP to a run
   configuration — DevEco auto-signs with a local debug certificate and
   installs to a connected device/emulator; or
2. `hdc install entry-default-unsigned.hap` after configuring debug signing
   in `build-profile.json5`.

## See also

- Bilingual counterpart: [release.zh.md](release.zh.md)
- Evidence conventions: [e2e-matrix.md](e2e-matrix.md)
