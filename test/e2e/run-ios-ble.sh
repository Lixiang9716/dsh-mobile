#!/usr/bin/env bash
# test/e2e/run-ios-ble.sh — the capability plane's BLE-face E2E driver
# (scenario `ble.plane`): launches DSHSpike in -dsh-mode ble-plane[-mock],
# waits for the terminal marker, and verifies the captured log against the
# scenario + audit manifests. No UI driving: the mock radio needs no taps
# and the real-radio skip path answers `unavailable` honestly — CI-runnable.
#
# --mode skip   the real CoreBluetooth radio (a simulator answers
#               `unavailable` honestly — the CI skip leg)
# --mode mock   the deterministic mock radio (the full GATT ladder through
#               the REAL gateway enforcement and audit — the CI leg)
# --mode device D-g: a REAL iPhone with a peer advertising the test GATT db
#               (180f/2a19 read+notify, fe00/fe01 write; e.g. a second phone
#               running a BLE-peripheral simulator configured with those
#               UUIDs). Refuses loudly without a paired signing identity —
#               never fakes evidence.
#
# usage: run-ios-ble.sh [--mode skip|mock|device] [--udid U] [--art-dir D]
#                       [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

MODE="skip"
UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART=""
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
DEADLINE=$((SECONDS + 420))
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios-ble.sh [--mode skip|mock|device] [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  skip)  LAUNCH_MODE="ble-plane";       SCEN="ios-ble";  AUDIT="ios-ble-audit" ;;
  mock)  LAUNCH_MODE="ble-plane-mock";  SCEN="ios-ble-mock"; AUDIT="ios-ble-mock-audit" ;;
  device)
    # D-g honesty gate: a real-device leg needs code signing this machine
    # does not have. The script is READY for a signing-configured runner
    # (xcodebuild -destination platform=iOS device); it refuses here rather
    # than pretending a simulator run is device evidence.
    if xcrun security find-identity -v -p codesigning 2>/dev/null | grep -q '"Apple Development'; then
      echo "run-ios-ble: device leg needs a DESTINATION switch to a real iPhone — wire the" >&2
      echo "  signed build + -dsh-mode ble-plane launch on the device, then rerun with" >&2
      echo "  --mode device and the ios-ble-device.json manifest. See the file header." >&2
      exit 3
    fi
    echo "run-ios-ble: FAIL: no iOS signing identity on this machine — the device leg" >&2
    echo "  is prepared-but-blocked (D-g): provision signing, then rerun. No fake evidence." >&2
    exit 3 ;;
  *) echo "run-ios-ble: unknown mode $MODE (want skip|mock|device)" >&2; exit 2 ;;
esac
ART="${ART:-hosts/ios/artifacts/ble-$MODE}"
LOG="$ART/logs.txt"
mkdir -p "$ART/screens"   # the receipt writer lists screens/ (empty is fine)

log() { echo "run-ios-ble: $*"; }

if [ "$SKIP_BUILD" = "0" ]; then
  log "1/4 building DSHSpike"
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination 'platform=iOS Simulator,id='"$UDID" \
    -derivedDataPath hosts/ios/DerivedData -quiet >/dev/null
else
  log "1/4 build skipped"
fi

log "2/4 boot + install"
sh hosts/ios/Tools/sim-preflight.sh "$UDID"   # runtime < 26 = dead launch
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

log "3/4 launch (-dsh-mode $LAUNCH_MODE, bounded retries)"
LOG_ABS="$PWD/$LOG"
rm -f "$LOG"
launch_deadline=$((SECONDS + 120))
launched=0
while [ "$SECONDS" -lt "$launch_deadline" ]; do
  : > "$LOG"   # each attempt owns its log (simctl --stdout APPENDS)
  rc=0
  perl -e 'alarm shift; exec @ARGV' 180 \
    xcrun simctl launch --terminate-running-process \
      --stdout="$LOG_ABS" --stderr="$PWD/$ART/nslog-stderr.txt" \
      "$UDID" "$APP_BUNDLE_ID" -dsh-mode "$LAUNCH_MODE" >/dev/null 2>&1 || rc=$?
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
[ "$launched" = "1" ] || { echo "run-ios-ble: launch failed" >&2; exit 1; }

log "4/4 waiting for the terminal marker"
while true; do
  if grep -q "spike: ble-plane drive finished" "$LOG" 2>/dev/null; then
    break
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "run-ios-ble: DEADLINE EXPIRED — terminal marker never appeared" >&2
    tail -n 50 "$LOG" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
grep '^dsh.gateway.audit:' "$LOG" >"$ART/gateway-audit.jsonl" || true
FAIL=0
run_check() { # MANIFEST OUT
  rm -f "$2"
  if node test/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$2"; then
    :
  else
    FAIL=1; echo "run-ios-ble: checker FAILED: $1" >&2
  fi
}
if [ "$MODE" = "device" ]; then
  run_check test/e2e/scenarios/ios-ble-device.json "$ART/verdict-ios-ble-device.json"
elif [ "$MODE" = "skip" ]; then
  # the posture is OBSERVED, not assumed: the same simulator can answer
  # `unavailable` (no radio) or `denied` (radio up, TCC authorization
  # refused) on different days — each posture has its own manifest.
  if grep -q '"mode":"denied"' "$LOG"; then
    SCEN="ios-ble-denied"; AUDIT="ios-ble-denied-audit"
  fi
  run_check test/e2e/scenarios/$SCEN.json       "$ART/verdict-$SCEN.json"
  run_check test/e2e/scenarios/$AUDIT.json      "$ART/verdict-$AUDIT.json"
else
  run_check test/e2e/scenarios/$SCEN.json       "$ART/verdict-$SCEN.json"
  run_check test/e2e/scenarios/$AUDIT.json      "$ART/verdict-$AUDIT.json"
fi
[ "$FAIL" = "0" ] || { echo "run-ios-ble: checkers red — no receipt (rule: receipts only from green runs)" >&2; exit 1; }

sh test/e2e/write-receipt.sh "$ART" "$UDID" test/e2e/run-ios-ble.sh \
  "ble.plane" "ios ble-plane drive (Debug, -dsh-mode $LAUNCH_MODE, mode=$MODE)" \
  "$SCEN" "$AUDIT"
log "receipt written — ble.plane green ($MODE, $ART)"
