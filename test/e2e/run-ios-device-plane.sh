#!/usr/bin/env bash
# test/e2e/run-ios-device-plane.sh — the v1.5.0 device-plane E2E driver
# (`device.plane`): launches DSHHost in -dsh-mode device-plane, drives the
# native surfaces the scenario blocks on (clipboard approval alert, the two
# share sheets, the PHPicker media grid) via WDA/idb, then verifies the
# captured log against the scenario + audit manifests. Sibling of
# run-ios.sh's drive machinery; the verdict is logs only.
#
# The clipboard approval drives the STANDING-GRANT ladder: read #1 taps
# "Approve", read #2 taps "Approve & Remember", read #3 expects NO dialog
# (the persisted grant answers it) — the marker counter is the ladder.
#
# usage: run-ios-device-plane.sh [--udid U] [--art-dir D] [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/device-plane"
SKIP_BUILD=0
SKIP_INSTALL=0
APP_BUNDLE_ID=org.dsh.DSHHost
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHHost.app
DEADLINE=$((SECONDS + 900))
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "usage: run-ios-device-plane.sh [--udid U] [--art-dir D] [--skip-build] [--skip-install]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
command -v node >/dev/null 2>&1 || { echo "run-ios-device-plane: FAIL: node not on PATH" >&2; exit 1; }
export IDB_UDID="$UDID"
mkdir -p "$ART" "$ART/screens"

WDA_PORT=$((8100 + 16#${UDID: -4} % 500))
LOCK="$HOME/dsh-e2e/run-ios-device-plane-$UDID.lock"
mkdir -p "$HOME/dsh-e2e"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "run-ios-device-plane: FAIL: another runner drives $UDID (pid $(cat "$LOCK"))" >&2
  exit 1
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"; [ -n "${WDA_PID:-}" ] && kill "$WDA_PID" 2>/dev/null || true' EXIT

log() { echo "run-ios-device-plane: $*"; }

# ---- WDA helpers (the same discipline as run-ios.sh: derived port,
# ---- bounded probes, calibration fallbacks) --------------------------------
wda_up() { curl -s --max-time 3 localhost:$WDA_PORT/status 2>/dev/null | grep -Eq '"state"[[:space:]]*:[[:space:]]*"success"'; }
wda_bootstrap() {
  if wda_up; then return 0; fi
  log "bootstrapping WebDriverAgent"
  [ -d "$HOME/dsh-e2e/wda" ] || git clone --depth 1 https://github.com/appium/WebDriverAgent.git "$HOME/dsh-e2e/wda" >/dev/null 2>&1
  [ -d "$HOME/dsh-e2e/wda-dd/Build/Products" ] || xcodebuild build-for-testing -scheme WebDriverAgentRunner -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$HOME/dsh-e2e/wda-dd" >/dev/null 2>&1
  ( cd "$HOME/dsh-e2e/wda" && TEST_RUNNER_USE_PORT="$WDA_PORT" xcodebuild test-without-building -scheme WebDriverAgentRunner -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$HOME/dsh-e2e/wda-dd" >/dev/null 2>&1 ) &
  WDA_PID=$!
  local wda_deadline=$((SECONDS + 600))
  until wda_up; do
    [ "$SECONDS" -ge "$wda_deadline" ] && return 9
    sleep 2
  done
}
wda_session() { curl -s -X POST localhost:$WDA_PORT/session -H 'Content-Type: application/json' -d '{"capabilities":{}}' | python3 -c "import json,sys; print(json.load(sys.stdin)['sessionId'])"; }
wda_tap() { local x=$1 y=$2 d=${3:-0.1} sid; sid=$(wda_session); curl -s -X POST "localhost:$WDA_PORT/session/$sid/wda/dragfromtoforduration" -H 'Content-Type: application/json' -d "{\"fromX\":$x,\"fromY\":$y,\"toX\":$x,\"toY\":$y,\"duration\":$d}" >/dev/null; }
wda_click() { local sid label=$1 eid; sid=$(wda_session); eid=$(curl -s -X POST "localhost:$WDA_PORT/session/$sid/element" -H 'Content-Type: application/json' -d "{\"using\":\"xpath\",\"value\":\"//*[@label=\\\"$label\\\"]\"}" | python3 -c "import json,sys; v=json.load(sys.stdin).get('value',{}); print(v.get('ELEMENT','') if isinstance(v,dict) else (v[0]['ELEMENT'] if v else ''))" 2>/dev/null); [ -n "$eid" ] && curl -s -X POST "localhost:$WDA_PORT/session/$sid/element/$eid/click" >/dev/null; }

# alert tap: label first, calibration fallback second (the coordinate law:
# idb taps land at px/2 on this 3x device — the approval alert's buttons sit
# mid-dialog, PT_APPROVE is run-ios.sh's live-calibrated point)
tap_alert() { # LABEL PX PY
  wda_click "$1" && return 0
  idb ui tap --udid "$UDID" "$2" "$3" --duration 0.15 >/dev/null 2>&1 || true
}

# ---- 1. build ---------------------------------------------------------------
if [ "$SKIP_BUILD" = "0" ]; then
  log "1/5 building DSHHost"
  xcodebuild build -project hosts/ios/DSHHost.xcodeproj -scheme DSHHost \
    -destination 'platform=iOS Simulator,id='"$UDID" \
    -derivedDataPath hosts/ios/DerivedData -quiet >/dev/null
else
  log "1/5 build skipped"
fi

# ---- 2. install + boot ------------------------------------------------------
log "2/5 boot + install"
sh hosts/ios/Tools/sim-preflight.sh "$UDID"   # runtime < 26 = dead launch (18.5 dyld lacks libswiftWebKit)
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" 2>/dev/null || true
if [ "$SKIP_INSTALL" = "0" ]; then
  # UNINSTALL first: a fresh container resets the clipboard standing grant,
  # so the approval ladder (Approve → Approve & Remember → no dialog) runs
  # deterministically on every run.
  xcrun simctl uninstall "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
  xcrun simctl install "$UDID" "$APP"
fi

# The media leg seeds ONE photo into the library (simctl addmedia) so the
# PHPicker grid has a deterministic first cell to tap.
SEED_JPG="$ART/screens/.media-seed.jpg"
# A real photo of the current screen (deterministic ENOUGH: the file exists,
# is a JPEG, and lands in the library — the grid then has a first cell).
xcrun simctl io "$UDID" screenshot /tmp/.dsh-media-seed.png >/dev/null 2>&1 \
  && sips -s format jpeg -Z 128 /tmp/.dsh-media-seed.png --out "$SEED_JPG" >/dev/null 2>&1 || true
if [ -s "$SEED_JPG" ]; then
  if xcrun simctl addmedia "$UDID" "$SEED_JPG" 2>/dev/null; then
    log "media seed added to the library"
  else
    log "WARNING: addmedia failed — media leg will drive cancellation"
  fi
fi

# ---- 3. launch --------------------------------------------------------------
log "3/5 launch (-dsh-mode device-plane, bounded retries)"
rm -f "$LOG"
LOG_ABS="$PWD/$LOG"
# Right after bootstatus SpringBoard can refuse the open (FBSOpenApplication
# SBMainWorkspace denial, observed live 2026-09-26) — retry until the app is
# up (the log file grows) or the deadline passes (rule 8: poll the condition).
launch_deadline=$((SECONDS + 120))
launched=0
while [ "$SECONDS" -lt "$launch_deadline" ]; do
  : > "$LOG"   # each attempt owns its log (simctl --stdout APPENDS — a retry
               # after a slow first flush once doubled the run into one file)
  rc=0
  perl -e 'alarm shift; exec @ARGV' "${DSH_LAUNCH_DEADLINE:-180}" \
    xcrun simctl launch --terminate-running-process \
      --stdout="$LOG_ABS" --stderr="$PWD/$ART/nslog-stderr.txt" \
      "$UDID" "$APP_BUNDLE_ID" -dsh-mode device-plane >/dev/null 2>&1 || rc=$?
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
[ "$launched" = "1" ] || { echo "run-ios-device-plane: launch failed" >&2; exit 1; }

# ---- 4. drive ---------------------------------------------------------------
log "4/5 driving scenario markers (deadline 900s)"
wda_bootstrap || echo "run-ios-device-plane: WARNING: WDA unavailable — UI legs degraded"
FIFO="$ART/.driver.fifo"
rm -f "$FIFO"; mkfifo "$FIFO"
tail -n +1 -F "$LOG" 2>/dev/null >"$FIFO" &
TAIL_PID=$!
trap 'kill $TAIL_PID 2>/dev/null || true; [ -n "${WDA_PID:-}" ] && kill "$WDA_PID" 2>/dev/null || true; exec 3<&- 2>/dev/null || true; rm -f "$FIFO" "$LOCK"' EXIT
exec 3<"$FIFO"
READS=0
SHARES=0
while true; do
  if IFS= read -r -t 5 line <&3; then
    case "$line" in
      *"dsh: ui-wait clipboard-read"*)
        READS=$((READS + 1))
        shot() { xcrun simctl io "$UDID" screenshot "$ART/screens/clipboard-$READS.png" >/dev/null 2>&1 || true; }
        shot
        sleep 1.5   # alert presentation completes before the press lands
        if [ "$READS" = "1" ]; then
          log "clipboard read #$READS -> Approve"
          wda_click "Approve" || idb ui tap --udid "$UDID" 300 720 --duration 0.15 || true
        else
          log "clipboard read #$READS -> Approve & Remember"
          wda_click "Approve & Remember" || wda_click "Approve" || true
        fi ;;
      *"dsh: ui-wait share"*)
        SHARES=$((SHARES + 1))
        xcrun simctl io "$UDID" screenshot "$ART/screens/share-$SHARES.png" >/dev/null 2>&1 || true
        sleep 1.5
        # Copy is offered for BOTH payloads (file + text, live-probed
        # 2026-09-26); the sheet renders LATE on a cold UI process — poll the
        # AX tree for the button (bounded) instead of one fixed sleep.
        log "share #$SHARES -> Copy (polling)"
        copy_deadline=$((SECONDS + 25))
        copied=0
        while [ "$SECONDS" -lt "$copy_deadline" ]; do
            if wda_click "Copy"; then copied=1; break; fi
            sleep 1.5
        done
        [ "$copied" = "1" ] || idb ui tap --udid "$UDID" 152 700 --duration 0.15 >/dev/null 2>&1 || true ;;

      *"dsh: ui-wait picker"*)
        xcrun simctl io "$UDID" screenshot "$ART/screens/picker-media.png" >/dev/null 2>&1 || true
        sleep 1.5
        # single-select PHPicker: the grid loads for seconds on a cold photo
        # daemon (live-probed: "Loading..." spinner) — poll the AX tree for
        # any cell, then tap the FIRST cell (px/2 coordinate law, top-left
        # grid position). The privacy banner on screen is the primitive's
        # own contract: the app sees only what the user picks.
        cell_deadline=$((SECONDS + 30))
        tapped=0
        while [ "$SECONDS" -lt "$cell_deadline" ]; do
          if wda_click "Photo, " || wda_click "Photo"; then tapped=1; break; fi
          sleep 2
        done
        if [ "$tapped" = "0" ]; then
          idb ui tap --udid "$UDID" 77 372 --duration 0.15 >/dev/null 2>&1 || true
          log "media picker -> coordinate tap (first cell)"
        else
          log "media picker -> cell tapped by label"
        fi ;;
      *"dsh: device-plane drive finished"*)
        log "terminal marker: $line"; break ;;
    esac
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "run-ios-device-plane: DEADLINE EXPIRED — terminal marker never appeared" >&2
    tail -n 50 "$LOG" >&2 2>/dev/null || true
    exit 1
  fi
done
exec 3<&-; { kill "$TAIL_PID" && wait "$TAIL_PID"; } 2>/dev/null || true

# ---- 5. checkers ------------------------------------------------------------
log "5/5 running checkers"
grep '^dsh.runtime.log:' "$LOG" >"$ART/scenario.jsonl" || true
grep '^dsh.gateway.audit:' "$LOG" >"$ART/gateway-audit.jsonl" || true
PASS=0; FAIL=0
run_check() { # MANIFEST OUT
  rm -f "$2"
  if node test/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$2"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1)); echo "run-ios-device-plane: checker FAILED: $1" >&2
  fi
}
run_check test/e2e/scenarios/device-plane.json       "$ART/verdict-device-plane.json"
run_check test/e2e/scenarios/device-plane-audit.json "$ART/verdict-device-plane-audit.json"

echo "==================== device-plane E2E summary ($ART) ===================="
echo "scenario rows: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] || exit 1
sh test/e2e/write-receipt.sh "$ART" "$UDID" test/e2e/run-ios-device-plane.sh \
  "device.plane" "ios device-plane drive (Debug, -dsh-mode device-plane)" \
  device-plane device-plane-audit
log "receipt written — device.plane green"
