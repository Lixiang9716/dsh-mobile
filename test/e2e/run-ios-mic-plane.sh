#!/usr/bin/env bash
# test/e2e/run-ios-mic-plane.sh — the capability plane's microphone E2E
# driver (`mic.plane`): launches DSHHost in -dsh-mode mic-plane and
# verifies the captured log against the scenario + audit manifests. Sibling
# of run-ios-device-plane.sh's machinery; the verdict is logs only.
#
# The OS consent layer (the mic permission alert) is automated honestly:
# the runner PRE-GRANTS via `xcrun simctl privacy ... grant microphone`
# before launch — the grant is printed into this log, the scenario's
# mic.armed record is the observable of the OS layer having answered, and
# a revoked-then-denied ladder (reset + drive "Don't Allow") is a real-device
# leg, not asserted here. The simulator's mic routes to the host Mac's
# input device, so real PCM frames flow (honest frames, no fixtures).
#
# usage: run-ios-mic-plane.sh [--udid U] [--art-dir D] [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/mic-plane"
SKIP_BUILD=0
SKIP_INSTALL=0
APP_BUNDLE_ID=org.dsh.DSHHost
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHHost.app
DEADLINE=$((SECONDS + 600))
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "usage: run-ios-mic-plane.sh [--udid U] [--art-dir D] [--skip-build] [--skip-install]" >&2; exit 1 ;;
  esac
done
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
mkdir -p "$ART"

LOCK="$HOME/dsh-e2e/run-ios-mic-plane-$UDID.lock"
mkdir -p "$HOME/dsh-e2e"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "run-ios-mic-plane: FAIL: another runner drives $UDID (pid $(cat "$LOCK"))" >&2
  exit 1
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

log() { echo "run-ios-mic-plane: $*"; }

# ---- 1. build ---------------------------------------------------------------
if [ "$SKIP_BUILD" = "0" ]; then
  log "1/5 building DSHHost"
  xcodebuild build -project hosts/ios/DSHHost.xcodeproj -scheme DSHHost \
    -destination 'platform=iOS Simulator,id='"$UDID" \
    -derivedDataPath hosts/ios/DerivedData -quiet >/dev/null
else
  log "1/5 build skipped"
fi

# ---- 2. boot + install + the honest OS-grant automation ---------------------
log "2/5 boot + install + pre-grant microphone (simctl privacy)"
sh hosts/ios/Tools/sim-preflight.sh "$UDID"   # runtime < 26 = dead launch (18.5 dyld lacks libswiftWebKit)
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" 2>/dev/null || true
if [ "$SKIP_INSTALL" = "0" ]; then
  # UNINSTALL first: a fresh container resets TCC, so the pre-grant below is
  # the run's true consent state (no stale approval from earlier runs).
  xcrun simctl uninstall "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
  xcrun simctl install "$UDID" "$APP"
fi
xcrun simctl privacy "$UDID" grant microphone "$APP_BUNDLE_ID"
log "microphone pre-granted to $APP_BUNDLE_ID on $UDID (automation, recorded)"

# ---- 3. launch --------------------------------------------------------------
log "3/5 launch (-dsh-mode mic-plane, bounded retries)"
rm -f "$LOG"
LOG_ABS="$PWD/$LOG"
# Right after bootstatus SpringBoard can refuse the open — retry until the
# app is up (the log file grows) or the deadline passes (rule 8: poll the
# condition, never sleep blindly).
launch_deadline=$((SECONDS + 120))
launched=0
while [ "$SECONDS" -lt "$launch_deadline" ]; do
  : > "$LOG"   # each attempt owns its log (simctl --stdout APPENDS)
  rc=0
  perl -e 'alarm shift; exec @ARGV' "${DSH_LAUNCH_DEADLINE:-180}" \
    xcrun simctl launch --terminate-running-process \
      --stdout="$LOG_ABS" --stderr="$PWD/$ART/nslog-stderr.txt" \
      "$UDID" "$APP_BUNDLE_ID" -dsh-mode mic-plane >/dev/null 2>&1 || rc=$?
  if [ "$rc" = "0" ]; then
    # the runtime's first stdout lines can take >10s on a cold dyld — poll
    log_deadline=$((SECONDS + 15))
    while [ "$SECONDS" -lt "$log_deadline" ]; do
      [ -s "$LOG" ] && { launched=1; break; }
      sleep 1
    done
    [ "$launched" = "1" ] && break
  fi
  sleep 3
done
[ "$launched" = "1" ] || { echo "run-ios-mic-plane: launch failed" >&2; exit 1; }

# ---- 4. wait for the terminal marker ---------------------------------------
log "4/5 waiting for the scenario verdict (deadline $((DEADLINE - SECONDS))s)"
tail_deadline=$DEADLINE
while [ "$SECONDS" -lt "$tail_deadline" ]; do
  if grep -q 'dsh: mic-plane drive finished' "$LOG" 2>/dev/null; then
    grep 'dsh: mic-plane drive finished' "$LOG"
    break
  fi
  sleep 2
done
if ! grep -q 'dsh: mic-plane drive finished' "$LOG" 2>/dev/null; then
  echo "run-ios-mic-plane: DEADLINE EXPIRED — terminal marker never appeared" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
fi

# ---- 5. checkers ------------------------------------------------------------
log "5/5 running checkers"
mkdir -p "$ART/screens"
xcrun simctl io "$UDID" screenshot "$ART/screens/01-final.png" >/dev/null 2>&1 || true
grep '^dsh.runtime.log:' "$LOG" > "$ART/scenario.jsonl" || true
grep '^dsh.gateway.audit:' "$LOG" > "$ART/gateway-audit.jsonl" || true
PASS=0; FAIL=0
run_check() { # MANIFEST OUT
  rm -f "$2"
  if node test/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$2"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1)); echo "run-ios-mic-plane: checker FAILED: $1" >&2
  fi
}
run_check test/e2e/scenarios/mic-plane.json       "$ART/verdict-mic-plane.json"
run_check test/e2e/scenarios/mic-plane-audit.json "$ART/verdict-mic-plane-audit.json"

echo "==================== mic-plane E2E summary ($ART) ===================="
echo "scenario rows: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] || exit 1
sh test/e2e/write-receipt.sh "$ART" "$UDID" test/e2e/run-ios-mic-plane.sh \
  "mic.plane" "ios mic-plane drive (Debug, -dsh-mode mic-plane)" \
  mic-plane mic-plane-audit
log "receipt written — mic.plane green"
