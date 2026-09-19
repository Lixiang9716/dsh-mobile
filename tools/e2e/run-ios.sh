#!/usr/bin/env bash
# tools/e2e/run-ios.sh — local M2 "real gateway binding" E2E driver.
#
# Builds DSHSpike, installs and launches it on a booted iOS simulator, drives
# the NATIVE UI the scenario blocks on (permission alert, Files picker,
# approval dialog, notification banner) via idb, then verifies the captured
# log against all four scenario manifests. Screenshots are saved artifacts
# (art/screens/) — the verdict is logs only (docs/ARCHITECTURE.md, "E2E
# verification"). CI runners cannot drive UI; they run the m1 checkers only,
# so the full m2 E2E happens HERE, locally.
#
# usage: run-ios.sh [--udid U] [--art-dir D] [--skip-build]
#
# Rule 8 discipline: every wait polls a condition with a deadline (log
# markers, accessibility tree, notify.response progress); sleeps only pace
# retry loops. Overall deadline 300s — on expiry it fails loud with the last
# 50 log lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# ---- live-calibration constants -------------------------------------------
# Fallback TAP POINTS in points (idb taps take points; dsh-iphone is a
# 402x874pt iPhone-16-class device). Every UI step first tries the
# accessibility tree (idb ui describe-all); these are used when describe-all
# errors (known iOS 26.5 issue) or the expected label is missing.
# THE INTEGRATOR CALIBRATES THESE against art/screens/*.png after the first
# live run — names say which surface each is for.
PT_ALLOW=(201 470)             # notification permission alert: "Allow" button
PT_APPROVE=(201 480)           # in-app approval dialog: "Approve" button
PT_BANNER=(201 120)            # notification banner body (top of screen)
SWIPE_PULL=(201 10 201 500)    # pull-down gesture when banner is collapsed
PT_FILES_ONMYIPHONE=(201 350)  # Files: "On My iPhone" row
PT_FILES_DSH=(201 350)         # Files: "DSHSpike" row
PT_FILES_E2E=(201 350)         # Files: "gateway-e2e" folder row
PT_FILES_NOTES=(201 350)       # Files: "notes.txt" row
BANNER_LABEL=""                # set to the banner title once known; empty = coordinates

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/m2-gateway"
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
DEADLINE=$((SECONDS + 300))
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
export IDB_UDID="$UDID"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios: $*"; }
die() { echo "run-ios: FAIL: $*" >&2; exit 1; }

shot() { xcrun simctl io "$UDID" screenshot "$ART/screens/$1.png" >/dev/null 2>&1 && log "screenshot screens/$1.png" || true; }

# ---- accessibility helpers -------------------------------------------------
# ax_point LABEL: one describe-all probe; echoes "x y" (element center) when
# LABEL is present, nothing otherwise. describe-all errors on some iOS 26.5
# runtimes — any failure means "not found" and the caller falls back to the
# calibration constants above.
ax_point() {
  idb ui describe-all --json >"$ART/.ax.json" 2>/dev/null || return 1
  python3 - "$1" "$ART/.ax.json" <<'PY'
import json, sys
label, path = sys.argv[1], sys.argv[2]
if not label:
    sys.exit(0)
try:
    els = json.load(open(path))
except Exception:
    sys.exit(0)
for e in els:
    if e.get("AXLabel") == label:
        f = e.get("frame") or {}
        print(int(f.get("x", 0) + f.get("width", 0) / 2),
              int(f.get("y", 0) + f.get("height", 0) / 2))
        sys.exit(0)
PY
}

# ui_find LABEL FALLBACK_X FALLBACK_Y [TIMEOUT]: poll the AX tree for LABEL
# (deadline-bounded); echoes a tap point — the element center, or the
# calibration fallback when the label never shows up. Diagnostics go to
# STDERR: callers capture stdout via command substitution.
ui_find() {
  local label="$1" fx="$2" fy="$3" timeout="${4:-3}" pt="" deadline=$((SECONDS + ${4:-3}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    pt=$(ax_point "$label") && [ -n "$pt" ] && { echo "$pt"; return 0; }
    sleep 1   # paces the AX-tree retry; presence asserted by ax_point
  done
  echo "run-ios:   ax: '$label' not found — calibration fallback ($fx,$fy)" >&2
  echo "$fx $fy"
}

tap_label() { # LABEL FX FY [TIMEOUT]
  local x y; read -r x y <<<"$(ui_find "$1" "$2" "$3" "${4:-3}")"
  log "tap '$1' at ($x,$y)"; idb ui tap "$x" "$y" >/dev/null
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
  echo "run-ios: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- UI legs ---------------------------------------------------------------
drive_banner() {
  shot 02-notification-banner
  local deadline=$((SECONDS + 20)) x y
  log "driving notification banner (<=20s)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    read -r x y <<<"$(ui_find "$BANNER_LABEL" "${PT_BANNER[@]}" 1)"
    idb ui tap "$x" "$y" >/dev/null 2>&1 || true
    if wait_line "notify.response" 3; then log "banner tap accepted"; return 0; fi
    log "banner not hit — pull-down gesture, retry"
    idb ui swipe "${SWIPE_PULL[@]}" >/dev/null 2>&1 || true
    if wait_line "notify.response" 3; then return 0; fi
  done
  fail_deadline "notification banner never produced notify.response"
}

drive_picker() { # Files: On My iPhone -> DSHSpike -> gateway-e2e -> notes.txt
  log "driving Files picker (4 hops)"
  shot 04-picker-onmyiphone
  tap_label "On My iPhone" "${PT_FILES_ONMYIPHONE[@]}" 5
  shot 05-picker-dshspike
  tap_label "DSHSpike" "${PT_FILES_DSH[@]}" 5
  shot 06-picker-e2e-folder
  tap_label "gateway-e2e" "${PT_FILES_E2E[@]}" 5
  shot 07-picker-notes
  tap_label "notes.txt" "${PT_FILES_NOTES[@]}" 5
  shot 08-picker-done
}

# ---- 1-4. vendor, build, boot, install, launch -----------------------------
log "1/6 vendor quickjs-ng sources"
runtime/spike/vendor/ensure.sh

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "2/6 xcodebuild (simulator, udid $UDID)"
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath hosts/ios/DerivedData 2>&1 | tail -5
else
  log "2/6 skipped (--skip-build)"
fi
[ -d "$APP" ] || die "app bundle missing: $APP (build first or drop --skip-build)"

log "3/6 boot + install"
xcrun simctl boot "$UDID" 2>/dev/null || true   # already booted is fine
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"

log "4/6 launch (log capture truncated — checker must see only this run)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$APP_BUNDLE_ID" >/dev/null

# ---- 5. driver: react to spike: markers on the live log --------------------
log "5/6 driving scenario markers (deadline 300s)"
FIFO="$ART/.driver.fifo"
rm -f "$FIFO"; mkfifo "$FIFO"
tail -n +1 -F "$LOG" 2>/dev/null >"$FIFO" &
TAIL_PID=$!
trap 'kill $TAIL_PID 2>/dev/null || true; exec 3<&- 2>/dev/null || true; rm -f "$FIFO" "$ART/.ax.json"' EXIT
exec 3<"$FIFO"
DONE=0
while true; do
  if IFS= read -r -t 5 line <&3; then
    case "$line" in
      *"spike: ui-wait notification-permission"*)
        shot 01-notification-permission; tap_label "Allow" "${PT_ALLOW[@]}" ;;
      *"dsh.spike.log:"*"notify.scheduled"*)
        log "notify.scheduled seen -> HOME (background)"; idb ui button HOME >/dev/null ;;
      *"spike: ui-wait notification-banner"*) drive_banner ;;
      *"spike: ui-wait approval"*)
        shot 03-approval; tap_label "Approve" "${PT_APPROVE[@]}" ;;
      *"spike: ui-wait picker"*) drive_picker ;;
      *"spike: sequence"*)
        log "terminal marker: $line"; DONE=1; break ;;
    esac
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    fail_deadline "300s deadline — 'spike: sequence' never appeared"
  fi
done
exec 3<&-; { kill "$TAIL_PID" && wait "$TAIL_PID"; } 2>/dev/null || true

# ---- 6. checkers ------------------------------------------------------------
log "6/6 running checkers"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
grep '^dsh.gateway.audit:' "$LOG" >"$ART/gateway-audit.jsonl" || true
PASS=0; FAIL=0; FAILED=""
run_check() { # MANIFEST OUT
  node tools/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$2" || true
}
run_check tools/e2e/scenarios/m1-spike-boot.json       "$ART/verdict-m1-spike-boot.json"
run_check tools/e2e/scenarios/m1-carrier-loopback.json "$ART/verdict-m1-carrier-loopback.json"
run_check tools/e2e/scenarios/m2-gateway-binding.json  "$ART/verdict-m2-gateway-binding.json"
run_check tools/e2e/scenarios/m2-gateway-audit.json    "$ART/verdict-m2-gateway-audit.json"

echo "==================== E2E summary ($ART) ===================="
for s in m1-spike-boot m1-carrier-loopback m2-gateway-binding m2-gateway-audit; do
  v="$ART/verdict-$s.json"
  if [ ! -f "$v" ]; then
    st="FAIL (no verdict file)"; FAIL=$((FAIL + 1)); FAILED="$FAILED $s"
  elif grep -Eq '"pass": *true' "$v"; then
    st=PASS; PASS=$((PASS + 1))
  else
    st=FAIL; FAIL=$((FAIL + 1)); FAILED="$FAILED $s"
  fi
  printf '  %-28s %s\n' "$s" "$st"
done
echo "  logs: $LOG  screens: $ART/screens/"
if [ "$FAIL" -gt 0 ]; then
  die "failing checker(s):$FAILED — see verdict JSONs under $ART"
fi
log "ALL CHECKERS PASS"
