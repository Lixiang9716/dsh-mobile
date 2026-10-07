#!/usr/bin/env bash
# test/e2e/run-ios-camera-plane.sh — the capability plane's camera E2E leg on
# the SIMULATOR (`camera.plane`): launches DSHHost in -dsh-mode camera-plane
# and verifies the captured log against the scenario + audit manifests. No UI
# driving: the simulator has no camera, so the scenario's honest posture is
# exactly what this leg pins — cameraCapture rejects `unavailable` (the
# descriptor declared it, the host refuses it, nobody pretends), the phased
# recording rows answer `unavailable`, and the burst ladder walks the denial
# legs without content assertions. The REAL burst (OS prompt, JPEG frames,
# read-through scope) is the device leg:
# test/e2e/run-ios-camera-plane-device.sh — a simulator cannot certify it.
#
# usage: run-ios-camera-plane.sh [--udid U] [--art-dir D] [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/camera-plane"
SKIP_BUILD=0
SKIP_INSTALL=0
APP_BUNDLE_ID=org.dsh.DSHHost
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHHost.app
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "usage: run-ios-camera-plane.sh [--udid U] [--art-dir D] [--skip-build] [--skip-install]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
command -v node >/dev/null 2>&1 || { echo "run-ios-camera-plane: FAIL: node not on PATH" >&2; exit 1; }
mkdir -p "$ART/screens"   # the headless leg takes no screenshots; the receipt helper lists the dir

log() { echo "run-ios-camera-plane: $*"; }

# ---- 1. build ---------------------------------------------------------------
if [ "$SKIP_BUILD" = "0" ]; then
  log "1/4 building DSHHost"
  xcodebuild build -project hosts/ios/DSHHost.xcodeproj -scheme DSHHost \
    -destination 'platform=iOS Simulator,id='"$UDID" \
    -derivedDataPath hosts/ios/DerivedData -quiet >/dev/null
else
  log "1/4 build skipped"
fi

# ---- 2. boot + install ------------------------------------------------------
log "2/4 boot + install"
sh hosts/ios/Tools/sim-preflight.sh "$UDID"   # runtime < 26 = dead launch (18.5 dyld lacks libswiftWebKit)
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" 2>/dev/null || true
if [ "$SKIP_INSTALL" = "0" ]; then
  xcrun simctl uninstall "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
  xcrun simctl install "$UDID" "$APP"
fi

# ---- 3. launch --------------------------------------------------------------
log "3/4 launch (-dsh-mode camera-plane, bounded retries)"
rm -f "$LOG"
LOG_ABS="$PWD/$LOG"
launch_deadline=$((SECONDS + 120))
launched=0
while [ "$SECONDS" -lt "$launch_deadline" ]; do
  : > "$LOG"   # each attempt owns its log (simctl --stdout APPENDS)
  rc=0
  perl -e 'alarm shift; exec @ARGV' "${DSH_LAUNCH_DEADLINE:-180}" \
    xcrun simctl launch --terminate-running-process \
      --stdout="$LOG_ABS" --stderr="$PWD/$ART/nslog-stderr.txt" \
      "$UDID" "$APP_BUNDLE_ID" -dsh-mode camera-plane >/dev/null 2>&1 || rc=$?
  if [ "$rc" = "0" ]; then
    log_deadline=$((SECONDS + 15))
    while [ "$SECONDS" -lt "$log_deadline" ]; do
      [ -s "$LOG" ] && { launched=1; break; }
      sleep 1
    done
    [ "$launched" = "1" ] && break
  fi
  sleep 3
done
[ "$launched" = "1" ] || { echo "run-ios-camera-plane: launch failed" >&2; exit 1; }

# No UI driving — the leg's whole surface is headless on a simulator. Poll
# for the terminal marker (rule 8: poll the condition, never a timed pause).
log "4/4 waiting for the scenario's terminal marker"
marker_deadline=$((SECONDS + 180))
until grep -q "dsh: camera-plane drive finished" "$LOG" 2>/dev/null; do
  [ "$SECONDS" -ge "$marker_deadline" ] && {
    echo "run-ios-camera-plane: terminal marker never appeared" >&2
    tail -50 "$LOG" >&2 2>/dev/null || true
    exit 1
  }
  sleep 2
done

# ---- checkers ---------------------------------------------------------------
grep '^dsh.runtime.log:' "$LOG" >"$ART/scenario.jsonl" || true
grep '^dsh.gateway.audit:' "$LOG" >"$ART/gateway-audit.jsonl" || true
PASS=0; FAIL=0
run_check() { # MANIFEST OUT
  rm -f "$2"
  if node test/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$2"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1)); echo "run-ios-camera-plane: checker FAILED: $1" >&2
  fi
}
run_check test/e2e/scenarios/camera-plane.json       "$ART/verdict-camera-plane.json"
run_check test/e2e/scenarios/camera-plane-audit.json "$ART/verdict-camera-plane-audit.json"

echo "==================== camera-plane E2E summary ($ART) ===================="
echo "scenario rows: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] || exit 1
sh test/e2e/write-receipt.sh "$ART" "$UDID" test/e2e/run-ios-camera-plane.sh \
  "camera.plane" "ios camera-plane drive (Debug, -dsh-mode camera-plane; simulator: capture honestly unavailable)" \
  camera-plane camera-plane-audit
log "receipt written — camera.plane green (simulator posture)"
