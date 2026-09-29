#!/usr/bin/env bash
# test/e2e/run-ios-camera-plane-device.sh — the capability plane's camera E2E
# leg on a PHYSICAL iPhone (D-g mode: a one-click script staged for the
# device, honest about what it cannot do). A simulator has no camera, so the
# real burst — the OS permission prompt, JPEG frames, the read-through-scope
# readback, the maxBytes drop — can only be certified here. Until a device is
# attached this script does nothing but say so; it never synthesizes
# evidence, and hosts/ios/artifacts/camera-plane-device/ is created only by a
# real green run.
#
# Prerequisites (a simulator leg never needs these):
#   - a physical iPhone in Developer Mode, attached;
#   - a signing identity (Xcode managed or manual) for org.dsh.DSHSpike —
#     this machine has none today, so the build step names the fix when it
#     fails;
#   - FIRST RUN ONLY: someone taps "Allow" on the OS camera prompt (the
#     camera-permission ui-wait marker is the hook; WebDriverAgent on device
#     would automate it but needs its own signing).
#
# usage: run-ios-camera-plane-device.sh --udid <device-udid>
#        [--art-dir D] [--skip-build] [--skip-install]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-}"
ART="hosts/ios/artifacts/camera-plane-device"
SKIP_BUILD=0
SKIP_INSTALL=0
APP_BUNDLE_ID=org.dsh.DSHSpike
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "usage: run-ios-camera-plane-device.sh --udid U [--art-dir D] [--skip-build] [--skip-install]" >&2; exit 2 ;;
  esac
done

log() { echo "run-ios-camera-plane-device: $*"; }

# D-g discipline: no device, no run, no invented evidence.
if [ -z "$UDID" ]; then
  log "SKIP: no device UDID given (--udid). The real burst awaits a physical"
  log "iPhone; the simulator leg (run-ios-camera-plane.sh) pins the honest"
  log "unavailable posture in the meantime. Nothing was built, run, or"
  log "written — no evidence is synthesized for an absent device."
  exit 0
fi
if ! xcrun xctrace list devices 2>/dev/null | grep -F "$UDID" | grep -qv 'Simulator'; then
  log "FAIL: UDID $UDID is not an attached physical device" >&2
  exit 1
fi

APP=hosts/ios/DerivedData/Build/Products/Debug-iphoneos/DSHSpike.app
LOG="$ART/logs.txt"
command -v node >/dev/null 2>&1 || { echo "run-ios-camera-plane-device: FAIL: node not on PATH" >&2; exit 1; }
mkdir -p "$ART"

# ---- 1. build (device slice; needs a signing identity) ----------------------
if [ "$SKIP_BUILD" = "0" ]; then
  log "1/4 building DSHSpike for device (requires a signing identity)"
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination 'platform=iOS,id='"$UDID" \
    -derivedDataPath hosts/ios/DerivedData -allowProvisioningUpdates -quiet
else
  log "1/4 build skipped"
fi

# ---- 2. install -------------------------------------------------------------
log "2/4 install"
if [ "$SKIP_INSTALL" = "0" ]; then
  xcrun devicectl device install app --device "$UDID" "$APP"
fi

# ---- 3. launch --------------------------------------------------------------
log "3/4 launch (-dsh-mode camera-plane)"
rm -f "$LOG"
LOG_ABS="$PWD/$LOG"
xcrun devicectl device process launch --device "$UDID" \
  --console-pty 2>/dev/null || true
# devicectl's console does not tee to a file reliably across OS versions; the
# launch above starts the app, and the log capture rides the device's stdout
# streaming via the launch --console when supported. If your devicectl
# supports --console-to, prefer it; otherwise run with --console visible.
log "NOTE: if $LOG stays empty, re-run with the console visible:"
log "  xcrun devicectl device process launch --device $UDID \\"
log "    $APP_BUNDLE_ID -dsh-mode camera-plane > $PWD/$LOG"

# ---- 4. the OS prompt (first run only) + terminal marker --------------------
log "4/4 first run: tap Allow on the OS camera prompt when it appears"
log "(the camera-permission ui-wait marker is the hook); then the scenario"
log "finishes alone. Waiting for the terminal marker (deadline 600s)..."
marker_deadline=$((SECONDS + 600))
until grep -q "spike: camera-plane drive finished" "$LOG" 2>/dev/null; do
  [ "$SECONDS" -ge "$marker_deadline" ] && {
    echo "run-ios-camera-plane-device: terminal marker never appeared" >&2
    exit 1
  }
  sleep 3
done

# ---- checkers ---------------------------------------------------------------
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
grep '^dsh.gateway.audit:' "$LOG" >"$ART/gateway-audit.jsonl" || true
PASS=0; FAIL=0
run_check() { # MANIFEST OUT
  rm -f "$2"
  if node test/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$2"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1)); echo "run-ios-camera-plane-device: checker FAILED: $1" >&2
  fi
}
# The device walks the FULL ladder (burst → readback → maxbytes) — the
# same platform-neutral capture manifest the Android emulator and the
# harmony device leg pin, because the scenario emits the same sequence on
# any camera-capable host; the receipt (host/udid/runner) says who ran it.
run_check test/e2e/scenarios/camera-plane-capture.json       "$ART/verdict-camera-plane.json"
run_check test/e2e/scenarios/camera-plane-capture-audit.json "$ART/verdict-camera-plane-audit.json"

echo "==================== camera-plane device E2E summary ($ART) ===================="
echo "scenario rows: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] || exit 1
sh test/e2e/write-receipt.sh "$ART" "$UDID" test/e2e/run-ios-camera-plane-device.sh \
  "camera.plane" "ios camera-plane device drive (Debug, real camera burst)" \
  camera-plane camera-plane-audit
log "receipt written — camera.plane green on device"
