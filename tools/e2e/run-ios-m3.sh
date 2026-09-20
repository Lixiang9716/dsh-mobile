#!/usr/bin/env bash
# tools/e2e/run-ios-m3.sh — local M3 "on-device fetch-install" E2E driver.
#
# Builds DSHSpike, launches it on a booted simulator IN SESSION MODE with
# the m3-complete PROFILE (-dsh-mode session -dsh-profile m3-complete). The
# profile's cordis.patch.json (the M3 config layer) selects the ACTIVE Web
# Client (mini) and the toolbar slot allow-set; the carrier SELF-HOSTS the
# dsh-notes package (registered over the bus seam, served over real loopback
# TCP) and the scenario installs it through the REAL gateway httpFetch,
# startup-replays two crash-simulated pending receipts, then runs the
# m2.session-shaped agent session. NO UI interaction: the scenario auto-runs
# once the config-selected page connects (carrier.info) and the admitted
# slot is acked (host.info). The captured log is verified against BOTH
# manifests:
#   - m3-fetch-install.json (the JS scenario's 45 events)
#   - m3-fetch-carrier.json (carrier-side config/route/slot/mount evidence)
# Screenshots are saved artifacts (screens/) — the verdict is logs only
# (docs/ARCHITECTURE.md, "E2E verification").
#
# usage: run-ios-m3.sh [--udid U] [--art-dir D] [--skip-build]
#
# Rule 8 discipline: every wait polls a condition with a deadline (log
# markers); sleeps only pace the polls. Overall deadline 300s — on expiry
# it fails loud with the last 50 log lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/m3-complete"
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios-m3.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-m3: $*"; }
die() { echo "run-ios-m3: FAIL: $*" >&2; exit 1; }

shot() { # capture a stage screenshot, FAIL LOUD on any capture problem —
    # a silent failure leaves the previous run's file in place and three
    # identical "stage" screenshots get committed (observed live)
    local out="$ART/screens/$1.png"
    rm -f "$out"
    xcrun simctl io "$UDID" screenshot "$out" >/dev/null 2>&1 || die "screenshot $1: capture failed"
    [ -s "$out" ] || die "screenshot $1: empty file"
    [ "$(head -c 3 "$out" | xxd -p)" = "89504e" ] || die "screenshot $1: not a PNG"
    log "screenshot screens/$1.png"
}

wait_line() { # PATTERN TIMEOUT_SECONDS — poll the log for a marker
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -q "$1" "$LOG" 2>/dev/null && return 0
    sleep 1   # paces the log poll; grep asserts after each wait
  done
  grep -q "$1" "$LOG" 2>/dev/null
}

fail_deadline() {
  echo "run-ios-m3: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 1-3. vendor, build, install -------------------------------------------
log "1/5 vendor quickjs-ng sources"
runtime/spike/vendor/ensure.sh

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "2/5 regenerate embedded bundle + xcodebuild (simulator, udid $UDID)"
  (cd hosts/ios && python3 Tools/gen_bundle_header.py)
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath hosts/ios/DerivedData 2>&1 | tail -5
else
  log "2/5 skipped (--skip-build)"
fi
[ -d "$APP" ] || die "app bundle missing: $APP (build first or drop --skip-build)"

log "3/5 boot + install"
xcrun simctl bootstatus "$UDID" -b   # already booted is fine
# Uninstall first: the app scope (profiles/) PERSISTS across launches, and
# the receipt journal is append-only — the startup-replay assertions need a
# container that starts empty, exactly like a fresh device's first boot.
xcrun simctl uninstall "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

# ---- 4. launch in profile mode + watch the log markers ----------------------
log "4/5 launch (session mode, m3-complete profile; log capture truncated)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$APP_BUNDLE_ID" -dsh-mode session -dsh-profile m3-complete >/dev/null

# Markers: config.resolved (patch applied) → page-loaded shot; http.served
# (the carrier served the package over loopback) → mid-install shot;
# "spike: sequence session=" → final shot, then checkers.
log "waiting for the config-resolved carrier event (deadline 300s)"
wait_line "config.resolved" 300 || fail_deadline "config.resolved never appeared"
log "waiting for the Web Client mount"
wait_line "webclient.mounted" 120 || fail_deadline "webclient.mounted never appeared"
sleep 1   # let the first frames render before the shot
shot 01-config-selected-client
log "waiting for the carrier to serve the self-hosted package"
wait_line "http.served" 120 || fail_deadline "carrier never served the package"
shot 02-fetch-install
log "waiting for session completion (terminal marker)"
wait_line "spike: sequence session=" 120 || fail_deadline "terminal marker never appeared"
sleep 1
shot 03-final-transcript

# ---- 5. checkers ------------------------------------------------------------
log "5/5 running checkers"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
PASS=0; FAILED=""
run_check() { # MANIFEST STEM
  if node tools/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$ART/verdict-$2.json"; then
    PASS=$((PASS + 1))
  else
    FAILED="$FAILED $2"
  fi
}
run_check tools/e2e/scenarios/m3-fetch-install.json m3-fetch-install
run_check tools/e2e/scenarios/m3-fetch-carrier.json m3-fetch-carrier

echo "==================== E2E summary ($ART) ===================="
for s in m3-fetch-install m3-fetch-carrier; do
  v="$ART/verdict-$s.json"
  if [ ! -f "$v" ]; then
    st="FAIL (no verdict file)"; FAILED="$FAILED $s"
  elif grep -Eq '"pass": *true' "$v"; then
    st=PASS
  else
    st=FAIL
  fi
  printf '  %-24s %s\n' "$s" "$st"
done
echo "  logs: $LOG  screens: $ART/screens/"
if [ "$PASS" -ne 2 ]; then
  die "failing checker(s):$FAILED — see verdict JSONs under $ART"
fi
log "ALL CHECKERS PASS"
