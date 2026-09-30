#!/usr/bin/env bash
# test/e2e/run-mic-plane-device.sh — the mic face's REAL-DEVICE leg (the D-g
# posture: the script is ready and waits for the device; it never fakes
# evidence). One command per attached platform:
#
#   run-mic-plane-device.sh android   — an attached device over USB/adb
#                                       (debug build; `pm grant RECORD_AUDIO`
#                                       is grantable on userdebug images,
#                                       else the on-device prompt drives)
#   run-mic-plane-device.sh ios       — an attached iPhone (REQUIRES a signing
#                                       identity: none on this machine today —
#                                       the script fails loud naming it)
#   run-mic-plane-device.sh harmony   — an attached HarmonyOS device over hdc
#                                       (the emulator flow's sibling; the OS
#                                       mic prompt is driven by
#                                       hosts/harmony/ci/drive-mic-plane.mjs)
#
# usage: run-mic-plane-device.sh <android|ios|harmony> [extra runner args...]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PLATFORM="${1:-}"
[ -n "$PLATFORM" ] || { echo "usage: run-mic-plane-device.sh <android|ios|harmony> [runner args...]" >&2; exit 2; }
shift

case "$PLATFORM" in
  android)
    ADB=/opt/homebrew/share/android-commandlinetools/platform-tools/adb
    [ -x "$ADB" ] || ADB=adb
    SERIAL="$($ADB devices | awk 'NR>1 && $2=="device" && $1 !~ /^emulator-/ {print $1; exit}')"
    [ -n "$SERIAL" ] || { echo "run-mic-plane-device: no physical android device attached (adb devices)" >&2; exit 1; }
    echo "run-mic-plane-device: android device $SERIAL — running the mic ladder (real mic, real OS prompt flow)"
    exec env DSH_ANDROID_SERIAL="$SERIAL" DSH_ANDROID_ART="hosts/android/artifacts/mic-plane-device" \
      sh hosts/android/ci/run-mic-plane.sh "$@"
    ;;
  ios)
    command -v xcrun >/dev/null 2>&1 || { echo "run-mic-plane-device: xcrun missing" >&2; exit 1; }
    DEVICE="$*"
    [ -n "$DEVICE" ] || DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk 'NR>3 && $1 != "" {print $1; exit}')
    [ -n "$DEVICE" ] || { echo "run-mic-plane-device: no iPhone attached (devicectl list devices)" >&2; exit 1; }
    # The hard prerequisite this machine lacks TODAY: a signing identity.
    if ! security find-identity -v -p codesigning 2>/dev/null | grep -q '"Apple Development'; then
      echo "run-mic-plane-device: FAIL: no iOS signing identity on this machine —" \
           "build & install DSHSpike onto $DEVICE with one, then re-run (the mic ladder itself is" \
           "platform-identical: -dsh-mode mic-plane, logs are the verdict)" >&2
      exit 1
    fi
    echo "run-mic-plane-device: iOS device $DEVICE — build for device (signing present) and drive"
    xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
      -destination "platform=iOS,id=$DEVICE" -allowProvisioningUpdates
    echo "run-mic-plane-device: build ok — install (devicectl) + launch with -dsh-mode mic-plane," \
         "capture stdout, then: node test/e2e/check.mjs --manifest test/e2e/scenarios/mic-plane.json --log <capture>"
    ;;
  harmony)
    CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
    HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
    [ -x "$HDC" ] || HDC=$(find "$CLT" -name hdc -type f | head -1)
    TARGET="$("$HDC" list targets | grep -v '^\[Empty\]' | grep -v '^127.0.0.1' | head -1 || true)"
    [ -n "$TARGET" ] || { echo "run-mic-plane-device: no physical harmony device attached (hdc list targets)" >&2; exit 1; }
    echo "run-mic-plane-device: harmony device $TARGET — running the mic ladder (the OS mic prompt is drive-tapped)"
    exec sh hosts/harmony/ci/run-mic-plane.sh "$@"
    ;;
  *) echo "usage: run-mic-plane-device.sh <android|ios|harmony>" >&2; exit 2 ;;
esac
