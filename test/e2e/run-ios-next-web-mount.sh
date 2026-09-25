#!/usr/bin/env bash
# test/e2e/run-ios-next-web-mount.sh — the SELF-HOSTED web client mounts E2E
# (nextweb.mount): presentation/web-client-next on the SAME SessionServe seat
# the user-facing launch runs, selected by the launch configuration
# (-dsh-web-client dsh-web-client-next), served with zero injection rows.
#
# Builds DSHSpike (the client rides the embedded webclient tree — no dist
# staging, nothing vendored), launches in NEXT-WEB mode, and waits for the
# drive to complete: the page boots from its own modules, opens the mux,
# the probe drives OUR UI like a user (new session → type → send), a REAL
# agent-loop turn streams over the journal with the carrier's scripted
# model boundary, and the page's timeline fold renders it. The captured log
# is verified against the one-to-one manifest nextweb-mount.json.
# Screenshots are saved artifacts (screens/) — the verdict is logs only.
#
# usage: run-ios-next-web-mount.sh [--udid U] [--art-dir D] [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART=""
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
DEADLINE=$((SECONDS + 300))
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios-next-web-mount.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
[ -n "$ART" ] || ART="hosts/ios/artifacts/nextweb-mount"
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-next-web-mount: $*"; }
die() { echo "run-ios-next-web-mount: FAIL: $*" >&2; exit 1; }

shot() { xcrun simctl io "$UDID" screenshot "$ART/screens/$1.png" >/dev/null 2>&1 && log "screenshot screens/$1.png" || true; }

wait_line() { # PATTERN TIMEOUT_SECONDS — poll the log for a marker
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -q "$1" "$LOG" 2>/dev/null && return 0
    sleep 1   # paces the log poll; grep asserts after each wait
  done
  grep -q "$1" "$LOG" 2>/dev/null
}

fail_deadline() {
  echo "run-ios-next-web-mount: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 1-3. build + install (no dist staging: the client is embedded) ---------
log "1/4 vendor quickjs-ng sources"
runtime/spike/vendor/ensure.sh

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "2/4 regenerate the embedded bundle + xcodebuild (simulator, udid $UDID)"
  python3 hosts/ios/Tools/gen_bundle_header.py
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath hosts/ios/DerivedData 2>&1 | tail -5
else
  log "2/4 skipped (--skip-build)"
fi
[ -d "$APP" ] || die "app bundle missing: $APP (build first or drop --skip-build)"

log "3/4 boot + install"
xcrun simctl bootstatus "$UDID" -b   # already booted is fine
xcrun simctl install "$UDID" "$APP"

# ---- launch + watch the log markers ------------------------------------------
log "4/4 launch (next-web mode; log capture truncated — checker sees only this run)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$APP_BUNDLE_ID" -dsh-mode next-web -dsh-web-client dsh-web-client-next >/dev/null

log "waiting for the next client page (index.served, deadline 300s)"
wait_line "index.served" 300 || fail_deadline "index.served never appeared"
shot 01-next-boot-screen

log "waiting for the carrier drive to complete (terminal marker)"
wait_line "spike: sequence next-web=" 180 || fail_deadline "terminal marker never appeared"
sleep 1
shot 02-final-state

# ---- checkers -----------------------------------------------------------------
log "5/5 running checkers"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
if node test/e2e/check.mjs --manifest test/e2e/scenarios/nextweb-mount.json \
    --log "$LOG" --out "$ART/verdict-nextweb-mount.json"; then
  echo "==================== E2E summary ($ART) ===================="
  echo "  nextweb-mount         PASS"
  echo "  logs: $LOG  screens: $ART/screens/"
else
  echo "==================== E2E summary ($ART) ====================" >&2
  echo "  nextweb-mount         FAIL" >&2
  echo "  logs: $LOG  screens: $ART/screens/" >&2
  die "nextweb-mount checker failed — see $ART/verdict-nextweb-mount.json"
fi
