#!/usr/bin/env bash
# tools/e2e/run-ios-b1.sh — Phase-B "official web mounts" E2E driver
# (b1.official-web.mount, docs/webserver-contract.md §4).
#
# Builds DSHSpike, stages the vendored official upstream dist into the app
# container (Documents/official-web/dist), launches in OFFICIAL-WEB mode
# (-dsh-mode official-web), and waits for the carrier drive to complete: the
# contract carrier serves the dist with injected boot rows, the page mounts,
# and the same-origin probe exercises POST /api + the /api/remote.mux
# multiplexed socket. The captured log is verified against the one-to-one
# manifest b1-official-web-mount.json (10 carrier-side wire events, including
# the honest `runtime.pending` leg marker for the sibling runtime PR).
# Screenshots are saved artifacts (screens/) — the verdict is logs only.
#
# usage: run-ios-b1.sh [--udid U] [--art-dir D] [--skip-build]
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
    *) echo "usage: run-ios-b1.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
[ -n "$ART" ] || ART="hosts/ios/artifacts/b1-official-web"
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-b1: $*"; }
die() { echo "run-ios-b1: FAIL: $*" >&2; exit 1; }

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
  echo "run-ios-b1: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 1-3. dist, vendor, build, install, stage -------------------------------
log "1/5 official dist present + manifest-verified"
tools/e2e/ensure-official-dist.sh

log "2/5 vendor quickjs-ng sources"
runtime/spike/vendor/ensure.sh

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "3/5 xcodebuild (simulator, udid $UDID)"
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath hosts/ios/DerivedData 2>&1 | tail -5
else
  log "3/5 skipped (--skip-build)"
fi
[ -d "$APP" ] || die "app bundle missing: $APP (build first or drop --skip-build)"

log "4/5 boot + install + stage dist into the app container"
xcrun simctl bootstatus "$UDID" -b   # already booted is fine
xcrun simctl install "$UDID" "$APP"
APP_DATA="$(xcrun simctl get_app_container "$UDID" "$APP_BUNDLE_ID" data)"
rm -rf "$APP_DATA/Documents/official-web"
mkdir -p "$APP_DATA/Documents/official-web"
cp -R presentation/official-web/dist "$APP_DATA/Documents/official-web/dist"

# ---- launch + watch the log markers ------------------------------------------
log "5/5 launch (official-web mode; log capture truncated — checker sees only this run)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$APP_BUNDLE_ID" -dsh-mode official-web >/dev/null

# Markers: index.served → boot-screen shot; terminal sequence marker →
# final shot, then the checker.
log "waiting for the official page mount (index.served, deadline 300s)"
wait_line "index.served" 300 || fail_deadline "index.served never appeared"
sleep 2   # let the boot screen settle before the shot
shot 01-official-boot-screen

log "waiting for the carrier drive to complete (terminal marker)"
wait_line "spike: sequence official-web=" 120 || fail_deadline "terminal marker never appeared"
sleep 1
shot 02-final-state

# ---- checkers -----------------------------------------------------------------
log "6/6 running checkers"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
if node tools/e2e/check.mjs --manifest tools/e2e/scenarios/b1-official-web-mount.json \
    --log "$LOG" --out "$ART/verdict-b1-official-web-mount.json"; then
  echo "==================== E2E summary ($ART) ===================="
  echo "  b1-official-web-mount     PASS"
  echo "  logs: $LOG  screens: $ART/screens/"
else
  echo "==================== E2E summary ($ART) ====================" >&2
  echo "  b1-official-web-mount     FAIL" >&2
  echo "  logs: $LOG  screens: $ART/screens/" >&2
  die "b1-official-web-mount checker failed — see $ART/verdict-b1-official-web-mount.json"
fi
